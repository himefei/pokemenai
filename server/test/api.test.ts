import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildServer } from "../src/api/http.js";
import { Session } from "../src/api/session.js";
import { FakeBridge } from "./helpers/fake-bridge.js";
import { FakeLlm } from "./helpers/fake-llm.js";

let bridge: FakeBridge;
let llm: FakeLlm;
let session: Session;
let app: Awaited<ReturnType<typeof buildServer>>;
let settingsPath: string;

beforeEach(async () => {
	bridge = new FakeBridge();
	const emuPort = await bridge.start();
	llm = new FakeLlm({ openaiDeltas: [{ content: "ok" }], models: ["qwen-x", "qwen-y"] });
	const llmBase = await llm.start();
	settingsPath = join(mkdtempSync(join(tmpdir(), "pba-")), "settings.local.json");
	session = new Session({ emuPort, settingsPath, pollPhase: false });
	session.updateSettings({ llm: { baseUrl: llmBase, apiKey: "sk-secret-1234", model: "qwen-x" } });
	app = await buildServer(session);
	await session.start();
	await new Promise((r) => setTimeout(r, 150)); // 等 hello 完成
});

afterEach(async () => {
	await session.stop();
	await app.close();
	await bridge.stop();
	await llm.stop();
});

describe("REST API", () => {
	it("reports emulator + ROM status", async () => {
		const r = await app.inject("/api/status");
		const j = r.json();
		expect(j.emu).toMatchObject({ connected: true, romOk: true, gameCode: "AGB-BPEE" });
		expect(j.controller.state).toBe("idle");
	});

	it("never returns the API key; masked value on save keeps the old key; file is 0600", async () => {
		const get = await app.inject("/api/settings");
		expect(JSON.stringify(get.json())).not.toContain("sk-secret-1234");
		expect(get.json().llm.apiKey).toMatch(/^\*{8}1234$/);
		await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { apiKey: get.json().llm.apiKey, model: "qwen-y" } } });
		expect(session.getSettings().llm.apiKey).toBe("sk-secret-1234");
		expect(session.getSettings().llm.model).toBe("qwen-y");
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).slots.a.llm.apiKey).toBe("sk-secret-1234");
		expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
		await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { apiKey: "sk-new" } } });
		expect(session.getSettings().llm.apiKey).toBe("sk-new");
	});

	it("params are optional overrides: null/empty removes them so nothing is forced on the endpoint", async () => {
		expect(session.getSettings().llm.params).toEqual({ timeoutMs: 600000 }); // 默认只有本地超时，没有 temperature / max_tokens
		await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { params: { temperature: 0.2, maxTokens: 512 } } } });
		expect(session.getSettings().llm.params).toMatchObject({ temperature: 0.2, maxTokens: 512 });
		await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { params: { temperature: null, maxTokens: null } } } });
		expect(session.getSettings().llm.params).toEqual({ timeoutMs: 600000 });
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).slots.a.llm.params).toEqual({ timeoutMs: 600000 });
	});

	it("lists models and tests the connection with the stored key", async () => {
		const models = await app.inject({ method: "POST", url: "/api/models/list", payload: {} });
		expect(models.json().models.map((m: { id: string }) => m.id)).toEqual(["qwen-x", "qwen-y"]);
		const test = await app.inject({ method: "POST", url: "/api/llm/test" });
		expect(test.json()).toMatchObject({ ok: true, reply: "ok" });
		expect(llm.requests.at(-1)!.headers.authorization).toBe("Bearer sk-secret-1234");
	});

	it("reports connection-test errors instead of throwing", async () => {
		session.updateSettings({ llm: { baseUrl: "http://127.0.0.1:1" } });
		const test = await app.inject({ method: "POST", url: "/api/llm/test" });
		expect(test.json().ok).toBe(false);
		expect(test.json().error).toBeTruthy();
	});

	it("refuses to take over when the emulator is not ready, and has nothing to confirm", async () => {
		bridge.crcHex = "00000000";
		const r = await app.inject({ method: "POST", url: "/api/control/confirm", payload: { ok: true } });
		expect(r.statusCode).toBe(409);
	});

	it("lists prompt presets including the user's original prompt", async () => {
		const r = await app.inject("/api/presets");
		const def = r.json().presets.find((p: { id: string }) => p.id === "default");
		expect(def.preset.base_prompt).toContain("现在你需要玩宝可梦绿宝石");
	});

	it("rejects unsafe preset ids and run ids", async () => {
		const r = await app.inject({ method: "PUT", url: "/api/presets/..%2Fevil", payload: { base_prompt: "a", output_instructions: "b" } });
		expect(r.statusCode).toBeGreaterThanOrEqual(400);
		expect((await app.inject("/api/runs/..%2F..%2Fetc")).statusCode).toBe(404);
	});
});

describe("run export", () => {
	const file = new URL("../../runs/run-test-export.jsonl", import.meta.url);
	afterEach(() => rmSync(file, { force: true }));

	it("downloads a markdown report (default) or the raw jsonl, with attachment headers", async () => {
		writeFileSync(file, [JSON.stringify({ type: "run_start", runId: "test-export", startedAt: "2026-10-11T00:00:00Z", policy: "random" }), JSON.stringify({ type: "run_end", summary: null })].join("\n") + "\n");
		const md = await app.inject("/api/runs/test-export/export");
		expect(md.statusCode).toBe(200);
		expect(md.headers["content-disposition"]).toContain("pokemon-battle-test-export.md");
		expect(md.body).toContain("# 宝可梦战斗日志：test-export");
		const raw = await app.inject("/api/runs/test-export/export?format=jsonl");
		expect(raw.headers["content-disposition"]).toContain(".jsonl");
		expect(raw.body.split("\n")[0]).toContain("run_start");
		expect((await app.inject("/api/runs/nope/export")).statusCode).toBe(404);
		expect((await app.inject("/api/runs/..%2F..%2Fetc/export")).statusCode).toBe(404);
	});
});

describe("WebSocket", () => {
	it("sends hello with status + replay, then pushes events", async () => {
		await app.listen({ host: "127.0.0.1", port: 0 });
		const port = (app.server.address() as { port: number }).port;
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const msgs: Array<Record<string, any>> = [];
		await new Promise<void>((res) => {
			ws.on("message", (d) => {
				msgs.push(JSON.parse(String(d)));
				if (msgs.length === 1) session.publish({ type: "error", message: "boom" });
				if (msgs.length === 2) res();
			});
		});
		expect(msgs[0]!.type).toBe("hello");
		expect(msgs[0]!.status.emu.romOk).toBe(true);
		expect(Array.isArray(msgs[0]!.replay)).toBe(true);
		expect(msgs[1]).toEqual({ type: "error", message: "boom" });
		ws.close();
	});

	it("coalesces consecutive llm deltas in the replay buffer", () => {
		for (const t of ["a", "b", "c"]) session.publish({ type: "llm.delta", turn: 1, attempt: 1, kind: "reasoning", text: t });
		session.publish({ type: "llm.delta", turn: 1, attempt: 1, kind: "content", text: "x" });
		const deltas = session.replay().filter((e) => e.type === "llm.delta");
		expect(deltas).toEqual([
			{ type: "llm.delta", turn: 1, attempt: 1, kind: "reasoning", text: "abc" },
			{ type: "llm.delta", turn: 1, attempt: 1, kind: "content", text: "x" },
		]);
	});
});
