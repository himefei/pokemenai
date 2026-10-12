import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { CLOSE_BUSY, CLOSE_REPLACED, WsEmulatorHub } from "../src/emulator/ws-hub.js";

let wss: WebSocketServer | undefined;
afterEach(() => {
	for (const c of wss?.clients ?? []) c.terminate();
	wss?.close();
	wss = undefined;
});

async function setup(heartbeatMs = 0) {
	const hub = new WsEmulatorHub(1000, heartbeatMs);
	wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	wss.on("connection", (ws, req) => void hub.attach(ws, { force: (req.url ?? "").includes("force=1") }));
	await new Promise<void>((r) => wss!.once("listening", () => r()));
	return { hub, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` };
}

/** 模拟浏览器里的模拟器宿主：收到请求就按协议回复；记下收到的控制消息和关闭码 */
function fakeHost(url: string, handler: (req: Record<string, any>) => Record<string, unknown> | null = () => ({}), opts: { autoPong?: boolean } = {}) {
	const info = { ws: null as unknown as WebSocket, closed: null as number | null, notices: [] as string[] };
	return new Promise<typeof info>((resolve) => {
		const ws = new WebSocket(url, opts as never);
		info.ws = ws;
		ws.on("message", (d) => {
			const req = JSON.parse(String(d));
			if (req.type) return void info.notices.push(req.type);
			const resp = handler(req);
			if (resp) ws.send(JSON.stringify({ id: req.id, ok: true, ...resp })); // null = 故意不回复
		});
		ws.on("close", (code) => (info.closed = code));
		ws.on("open", () => resolve(info));
	});
}

const until = async (cond: () => boolean, ms = 2000) => {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe("WsEmulatorHub", () => {
	it("speaks the same protocol as the Lua bridge over a WebSocket", async () => {
		const { hub, url } = await setup();
		expect(hub.connected).toBe(false);
		await expect(hub.request("ping")).rejects.toThrow(/not connected/);
		const connected = new Promise((r) => hub.once("connected", r));
		await fakeHost(url, (req) => (req.cmd === "read" ? { data: req.ranges.map((r: { len: number }) => "ab".repeat(r.len)), frame: 5 } : { frame: 5 }));
		await connected;
		const [a] = await hub.read([{ addr: 0x02000000, len: 3 }]);
		expect([...a!]).toEqual([0xab, 0xab, 0xab]);
	});

	it("fails pending requests and reports disconnect when the page goes away", async () => {
		const { hub, url } = await setup();
		const connected = new Promise((r) => hub.once("connected", r));
		const host = await fakeHost(url, () => null); // 不回复任何请求
		await connected;
		const gone = new Promise((r) => hub.once("disconnected", r));
		const p = hub.request("wait", { frames: 600 }, 5000);
		host.ws.close();
		await expect(p).rejects.toThrow(/disconnected|closed/);
		await gone;
		expect(hub.connected).toBe(false);
		expect(hub.hosted).toBe(false);
	});
});

describe("host ownership (one page per slot, no tug-of-war)", () => {
	it("a second page is rejected while the first host is alive — the running game is not disturbed", async () => {
		const { hub, url } = await setup();
		const h1 = await fakeHost(url, () => ({ who: 1 }));
		await until(() => hub.hosted);
		const h2 = await fakeHost(url, () => ({ who: 2 }));
		await until(() => h2.closed !== null);
		expect(h2.closed).toBe(CLOSE_BUSY);
		expect(h2.notices).toContain("busy");
		expect(h1.closed).toBeNull();
		expect(((await hub.request("ping")) as unknown as { who: number }).who).toBe(1);
	});

	it("an explicit takeover replaces the old host, which is told not to reconnect", async () => {
		const { hub, url } = await setup();
		const h1 = await fakeHost(url, (req) => (req.cmd === "wait" ? null : { who: 1 }));
		await until(() => hub.hosted);
		const pending = hub.request("wait", { frames: 1 }, 5000).catch((e: Error) => e.message);
		const h2 = await fakeHost(`${url}/?force=1`, () => ({ who: 2 }));
		await until(() => h1.closed !== null);
		expect(h1.closed).toBe(CLOSE_REPLACED);
		expect(h1.notices).toContain("replaced");
		expect(await pending).toMatch(/replaced/); // 旧宿主上没做完的请求如实失败，不会悬着
		expect(((await hub.request("ping")) as unknown as { who: number }).who).toBe(2);
		expect(h2.closed).toBeNull();
	});

	it("a dead host (frozen page, connection still open) stops blocking after the heartbeat times out", async () => {
		const { hub, url } = await setup(60);
		const dead = await fakeHost(url, () => ({}), { autoPong: false }); // 不回 pong
		await until(() => hub.hosted);
		await until(() => !hub.hosted, 3000);
		await until(() => dead.closed !== null);
		const fresh = await fakeHost(url, () => ({ who: 3 }));
		await until(() => hub.hosted);
		expect(((await hub.request("ping")) as unknown as { who: number }).who).toBe(3);
		expect(fresh.closed).toBeNull();
	});
});
