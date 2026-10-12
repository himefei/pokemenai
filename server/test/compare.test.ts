import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildServer } from "../src/api/http.js";
import { SessionManager } from "../src/api/manager.js";
import { loadAppSettings, saveSlotSettings } from "../src/config.js";

/** 模拟浏览器里的模拟器宿主：按协议应答，并记下收到的命令顺序 */
function fakeHost(port: number, slot: string, log: string[], opts: { crc?: string } = {}): Promise<WebSocket> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/emu-link?slot=${slot}`);
		ws.on("message", (d) => {
			const req = JSON.parse(String(d)) as Record<string, any>;
			log.push(req.cmd === "write" ? `write:${req.hex}` : req.cmd === "load_state" ? `load_state:${req.slot}` : req.cmd);
			const base = { id: req.id, ok: true, frame: 1 };
			if (req.cmd === "hello") ws.send(JSON.stringify({ ...base, protocol: 1, game_code: "AGB-BPEE", rom_crc32_raw_hex: opts.crc ?? "1f1c08fb", rom_crc32: "1F1C08FB" }));
			else if (req.cmd === "read") ws.send(JSON.stringify({ ...base, data: req.ranges.map((r: { len: number }) => "00".repeat(r.len)) }));
			else ws.send(JSON.stringify(base));
		});
		ws.on("open", () => resolve(ws));
	});
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn();
	cleanup = [];
});

async function setup(opts: { crcB?: string } = {}) {
	const settingsPath = join(mkdtempSync(join(tmpdir(), "pba-cmp-")), "settings.local.json");
	const manager = new SessionManager({ settingsPath, pollPhase: false });
	const app = await buildServer(manager);
	await app.listen({ host: "127.0.0.1", port: 0 });
	const port = (app.server.address() as AddressInfo).port;
	const logs = { a: [] as string[], b: [] as string[] };
	const hostA = await fakeHost(port, "a", logs.a);
	const hostB = await fakeHost(port, "b", logs.b, { crc: opts.crcB });
	await new Promise((r) => setTimeout(r, 150)); // 等两边 hello 完成
	cleanup.push(async () => {
		hostA.close();
		hostB.close();
		await manager.stop();
		await app.close();
	});
	return { manager, app, port, logs, settingsPath };
}

describe("two slots", () => {
	it("each slot has its own emulator link and reports its own status", async () => {
		const { app } = await setup();
		for (const s of ["a", "b"]) {
			const st = (await app.inject(`/api/s/${s}/status`)).json();
			expect(st).toMatchObject({ slot: s, emu: { connected: true, romOk: true } });
		}
		expect((await app.inject("/api/s/c/status")).statusCode).toBe(404);
	});

	it("a slot whose ROM does not verify cannot be started", async () => {
		const { app } = await setup({ crcB: "deadbeef" });
		expect((await app.inject("/api/s/a/status")).json().emu.romOk).toBe(true);
		expect((await app.inject("/api/s/b/status")).json().emu.romOk).toBe(false);
		expect((await app.inject({ method: "POST", url: "/api/s/b/control/takeover" })).statusCode).toBe(409);
	});

	it("settings are independent per slot (different models for A and B)", async () => {
		const { app } = await setup();
		await app.inject({ method: "PUT", url: "/api/s/a/settings", payload: { llm: { model: "model-a", baseUrl: "http://a.example" } } });
		await app.inject({ method: "PUT", url: "/api/s/b/settings", payload: { llm: { model: "model-b", baseUrl: "http://b.example", apiKey: "key-b" } } });
		const a = (await app.inject("/api/s/a/settings")).json();
		const b = (await app.inject("/api/s/b/settings")).json();
		expect([a.llm.model, a.llm.baseUrl]).toEqual(["model-a", "http://a.example"]);
		expect([b.llm.model, b.llm.baseUrl]).toEqual(["model-b", "http://b.example"]);
		expect(b.llm.apiKey).toBe("********ey-b");
		expect(JSON.stringify(a)).not.toContain("key-b");
	});
});

describe("fair compare start", () => {
	it("pauses both, loads the same savestate, writes the same RNG seed, then resumes and takes over — on both slots", async () => {
		const { app, logs, manager } = await setup();
		const r = await app.inject({ method: "POST", url: "/api/compare/start", payload: { stateSlot: 2, seed: 0x01020304 } });
		expect(r.json()).toEqual({ ok: true, seed: 0x01020304 });
		for (const s of ["a", "b"] as const) {
			const cmds = logs[s];
			const i = cmds.indexOf("pause");
			expect(i).toBeGreaterThanOrEqual(0);
			expect(cmds.slice(i, i + 4)).toEqual(["pause", "load_state:2", "write:04030201", "resume"]); // gRngValue 写成小端 04 03 02 01
			expect(manager.get(s)!.controller.status().state).not.toBe("idle");
		}
		await app.inject({ method: "POST", url: "/api/compare/stop" });
	});

	it("does not start anything if one side is not ready", async () => {
		const { app, logs } = await setup({ crcB: "deadbeef" });
		const r = await app.inject({ method: "POST", url: "/api/compare/start", payload: { stateSlot: 2 } });
		expect(r.statusCode).toBe(409);
		expect(r.json().error).toContain("槽位 B");
		expect(logs.a).not.toContain("pause"); // A 也不会单独先跑
		expect(logs.a).not.toContain("load_state:2");
	});

	it("validates the savestate slot", async () => {
		const { app } = await setup();
		expect((await app.inject({ method: "POST", url: "/api/compare/start", payload: { stateSlot: 12 } })).statusCode).toBe(400);
	});
});

describe("settings file", () => {
	it("migrates the old single-slot format: old settings become slot A, slot B starts as a copy", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pba-mig-")), "s.json");
		writeFileSync(path, JSON.stringify({ llm: { kind: "openai-compat", baseUrl: "http://old", apiKey: "k", model: "m-old", params: { timeoutMs: 1000 } }, agent: { policy: "llm", preset: "default", rulesHint: true, keepFull: 9, maxRetries: 1, confirmMode: false } }));
		const s = loadAppSettings(path);
		expect(s.slots.a.llm.model).toBe("m-old");
		expect(s.slots.b.llm.model).toBe("m-old");
		expect(s.slots.a.agent.rulesHint).toBe(true);
		// 改 B 不影响 A
		const b = structuredClone(s.slots.b);
		b.llm.model = "m-b";
		saveSlotSettings("b", b, path);
		const again = loadAppSettings(path);
		expect([again.slots.a.llm.model, again.slots.b.llm.model]).toEqual(["m-old", "m-b"]);
		expect(JSON.parse(readFileSync(path, "utf8")).slots.a.llm.apiKey).toBe("k");
	});
});
