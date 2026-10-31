// 上下文相关：/v1/responses 客户端、后端保存对话的连续会话、上下文长度识别、后端保存探测、设置与接口。

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import { LlmPolicy } from "../src/agent/llm-policy.js";
import type { Observation } from "../src/agent/observation.js";
import { loadPreset } from "../src/agent/prompt.js";
import { loadAppSettings } from "../src/config.js";
import { Session } from "../src/api/session.js";
import { buildServer } from "../src/api/http.js";
import { detectContextWindow } from "../src/llm/context-window.js";
import { listOpenAiCompatModels } from "../src/llm/discovery.js";
import { createClient } from "../src/llm/factory.js";
import { OpenAiResponsesClient } from "../src/llm/openai-responses.js";
import { probeServerState } from "../src/llm/state-probe.js";
import { buildRunReport } from "../src/eval/report.js";
import { FakeLlm } from "./helpers/fake-llm.js";

const fakes: FakeLlm[] = [];
const extra: http.Server[] = [];
async function fake(opts: ConstructorParameters<typeof FakeLlm>[0] = {}): Promise<{ f: FakeLlm; base: string }> {
	const f = new FakeLlm(opts);
	fakes.push(f);
	return { f, base: await f.start() };
}
afterEach(async () => {
	await Promise.all(fakes.splice(0).map((f) => f.stop()));
	await Promise.all(extra.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});

const cfg = (base: string, model = "m") => ({ kind: "openai-compat" as const, baseUrl: base, model });
const RAW = '先想一想。\n{"choice":"move:1","reason":"二连踢克制恶系"}';

function obs(turn: number): Observation {
	return {
		turn,
		phase: "action_menu",
		you: { active: { party_index: 0, species: "雷伊布", species_en: "Jolteon", level: 44, hp: 100, max_hp: 120, status: null, types: ["电"], stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, ability: "Volt Absorb", item: null, moves: [], fainted: false, active: true }, party: [] },
		opponent: { species: "大狼犬", species_en: "Mightyena", level: 46, types: ["恶"], hp_percent: 100, status: null, known_moves: [], unknown_move_slots: 4, ability: null, item: null },
		opponent_remaining: 5,
		opponent_party_size: 5,
		field: { weather: null, your_side: [], opponent_side: [] },
		legal_actions: [
			{ id: "move:0", label: "十万伏特" },
			{ id: "move:1", label: "二连踢" },
		],
		last_turn: [],
	};
}
const ctx = (turn: number) => ({ truth: {} as never, observation: obs(turn), legal: ["move:0", "move:1"] as never, turn, mode: "action" as const });
const prompt = { preset: loadPreset(), rulesHint: false };

describe("OpenAiResponsesClient", () => {
	it("streams content + reasoning, reads usage and the response id, sends store:true and no model parameters", async () => {
		const { f, base } = await fake({ responsesReply: () => ({ reasoning: "先想想", content: "答案是 42" }) });
		const deltas: string[] = [];
		const r = await new OpenAiResponsesClient({ ...cfg(base), apiKey: "sk-x" }).complete({ messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }], params: { timeoutMs: 5000 }, onDelta: (d) => deltas.push(`${d.kind}:${d.text}`) });
		expect(r).toMatchObject({ content: "答案是 42", reasoning: "先想想", responseId: "resp_1" });
		expect(r.usage.inputTokens).toBeGreaterThan(0);
		expect(deltas[0]).toBe("reasoning:先想想");
		const req = f.requests[0]!;
		expect(req.url).toBe("/v1/responses");
		expect(req.headers.authorization).toBe("Bearer sk-x");
		expect(Object.keys(req.body).sort()).toEqual(["input", "model", "store", "stream"]); // 没有任何模型参数
		expect(req.body).toMatchObject({ model: "m", store: true, stream: true });
		expect(req.body.previous_response_id).toBeUndefined();
		expect(req.body.input).toEqual([{ role: "system", content: "s" }, { role: "user", content: "q" }]);
	});

	it("with a chain it sends only the messages after `sent`, plus previous_response_id", async () => {
		const { f, base } = await fake();
		const client = new OpenAiResponsesClient(cfg(base));
		const m = [
			{ role: "system" as const, content: "s" },
			{ role: "user" as const, content: "q1" },
			{ role: "assistant" as const, content: "a1" },
			{ role: "user" as const, content: "q2" },
		];
		const r1 = await client.complete({ messages: m.slice(0, 2), params: {} });
		await client.complete({ messages: m, chain: { previousResponseId: r1.responseId!, sent: 3 }, params: {} });
		expect(f.requests[1]!.body.previous_response_id).toBe(r1.responseId);
		expect(f.requests[1]!.body.input).toEqual([{ role: "user", content: "q2" }]);
	});

	it("refuses to send an empty continuation", async () => {
		const { base } = await fake();
		await expect(new OpenAiResponsesClient(cfg(base)).complete({ messages: [{ role: "user", content: "q" }], chain: { previousResponseId: "resp_1", sent: 1 }, params: {} })).rejects.toThrow(/没有新消息/);
	});

	it("passes a backend's refusal through verbatim (a stateless server says so)", async () => {
		const { base } = await fake({ responses: "stateless" });
		const p = new OpenAiResponsesClient(cfg(base)).complete({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "q2" }], chain: { previousResponseId: "resp_9", sent: 2 }, params: {} });
		await expect(p).rejects.toMatchObject({ status: 400, body: expect.stringContaining("stateless") });
	});

	it("reads a non-streaming JSON response too", async () => {
		const server = http.createServer((req, res) => {
			req.resume();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ id: "resp_z", status: "completed", output: [{ type: "reasoning", summary: [{ text: "想" }] }, { type: "message", content: [{ type: "output_text", text: "好" }] }], usage: { input_tokens: 9, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } }));
		});
		extra.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const r = await new OpenAiResponsesClient(cfg(base)).complete({ messages: [{ role: "user", content: "q" }], params: {} });
		expect(r).toMatchObject({ content: "好", reasoning: "想", responseId: "resp_z", usage: { inputTokens: 9, outputTokens: 2, cachedTokens: 4 } });
	});

	it("is only available for OpenAI-compatible endpoints", () => {
		expect(() => createClient({ kind: "anthropic", baseUrl: "http://x", model: "m" }, "responses")).toThrow(/Anthropic/);
	});
});

describe("LlmPolicy · 连续会话 · 后端保存（continuous-server）", () => {
	const make = (base: string, events: AgentEvent[] = [], over: Partial<ConstructorParameters<typeof LlmPolicy>[0]> = {}) =>
		new LlmPolicy({ client: new OpenAiResponsesClient(cfg(base)), model: "m", params: { timeoutMs: 3000 }, prompt, contextMode: "continuous-server", sink: (e) => events.push(e), ...over });

	it("sends only the new messages after the first request, yet the log keeps the FULL conversation", async () => {
		const { f, base } = await fake({ responsesReply: () => RAW });
		const events: AgentEvent[] = [];
		const p = make(base, events);
		await p.decide(ctx(1));
		await p.decide(ctx(2));
		await p.decide(ctx(3));
		const [r1, r2, r3] = f.requests.map((r) => r.body);
		expect(r1.previous_response_id).toBeUndefined();
		expect(r1.input.map((m: any) => m.role)).toEqual(["system", "user"]);
		expect(r2.previous_response_id).toBe("resp_1");
		expect(r2.input).toHaveLength(1);
		expect(r2.input[0].content).toContain("第 2 回合");
		expect(r3.previous_response_id).toBe("resp_2");
		expect(r3.input).toHaveLength(1);
		const reqs = events.filter((e): e is Extract<AgentEvent, { type: "llm.request" }> => e.type === "llm.request");
		expect(reqs.map((e) => [e.messages.length, e.sent])).toEqual([[2, 2], [4, 1], [6, 1]]);
		expect(reqs[2]!.messages[2]).toEqual({ role: "assistant", content: RAW });
	});

	it("a format error is answered by sending only the feedback, chained to the failed reply", async () => {
		let n = 0;
		const { f, base } = await fake({ responsesReply: () => (++n === 1 ? "我选 move:9" : RAW) });
		const p = make(base);
		await p.decide(ctx(1));
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1]!.body.previous_response_id).toBe("resp_1");
		expect(f.requests[1]!.body.input).toHaveLength(1);
		expect(f.requests[1]!.body.input[0].content).toContain("无法使用");
		await p.decide(ctx(2)); // 下一回合接在“好回复”后面
		expect(f.requests[2]!.body.previous_response_id).toBe("resp_2");
		expect(f.requests[2]!.body.input).toHaveLength(1);
	});

	it("a new battle starts a fresh server-side conversation (no previous_response_id)", async () => {
		const { f, base } = await fake({ responsesReply: () => RAW });
		const p = make(base);
		await p.decide(ctx(1));
		await p.decide(ctx(2));
		p.reset();
		await p.decide(ctx(1));
		expect(f.requests[2]!.body.previous_response_id).toBeUndefined();
		expect(f.requests[2]!.body.input.map((m: any) => m.role)).toEqual(["system", "user"]);
	});

	it("a backend that cannot keep state fails loudly on the 2nd decision — it does NOT quietly resend the whole conversation", async () => {
		const { f, base } = await fake({ responses: "stateless", responsesReply: () => RAW });
		const p = make(base);
		await p.decide(ctx(1));
		await expect(p.decide(ctx(2))).rejects.toThrow(/模型调用失败（不重试）.*stateless/);
		expect(f.requests).toHaveLength(2);
	});

	it("a backend that silently ignores previous_response_id is caught: its prompt_tokens shrink instead of growing", async () => {
		const { base } = await fake({ responses: "ignore", responsesReply: () => RAW });
		const events: AgentEvent[] = [];
		const p = make(base, events);
		await p.decide(ctx(1));
		await p.decide(ctx(2));
		const rs = events.filter((e): e is Extract<AgentEvent, { type: "llm.response" }> => e.type === "llm.response");
		expect(rs[1]!.warning).toContain("没有比上一次");
	});

	it("needs a response id from the backend to continue", async () => {
		const server = http.createServer((req, res) => {
			req.resume();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: RAW }] }], usage: { input_tokens: 5, output_tokens: 5 } }));
		});
		extra.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const p = make(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		await expect(p.decide(ctx(1))).rejects.toThrow(/response id/);
	});
});

describe("detectContextWindow", () => {
	it("reads it per MODEL, not per endpoint (omlx lists a max_model_len for each model)", async () => {
		const { base } = await fake({ modelEntries: [{ id: "Ornith-35B", max_model_len: 240000 }, { id: "Qwen-27B", max_model_len: 200000 }, { id: "Sage", max_model_len: 262144 }, { id: "MarkItDown", max_model_len: null }] });
		expect(await detectContextWindow(cfg(base, "Ornith-35B"))).toEqual({ max: 240000, source: "/v1/models → max_model_len" });
		expect((await detectContextWindow(cfg(base, "Qwen-27B"))).max).toBe(200000);
		expect((await detectContextWindow(cfg(base, "Sage"))).max).toBe(262144);
		expect((await detectContextWindow(cfg(base, "MarkItDown"))).max).toBeNull(); // null 不是 0，也不是编一个数
		expect((await detectContextWindow(cfg(base, "not-there"))).max).toBeNull();
	});

	it("llama.cpp: prefers the running n_ctx over the training context", async () => {
		const { base } = await fake({ modelEntries: [{ id: "q", meta: { n_ctx: 131072, n_ctx_train: 262144 } }] });
		expect(await detectContextWindow(cfg(base, "q"))).toEqual({ max: 131072, source: "/v1/models → meta.n_ctx" });
	});

	it("llama.cpp without model metadata: falls back to /props n_ctx (single-model server)", async () => {
		const { base } = await fake({ modelEntries: [{ id: "q" }], routes: { "/props": { default_generation_settings: { n_ctx: 32768 } } } });
		expect(await detectContextWindow(cfg(base, "q"))).toEqual({ max: 32768, source: "llama.cpp /props → n_ctx" });
	});

	it("does not borrow /props for a model the server does not list (it could be a different model)", async () => {
		const { base } = await fake({ modelEntries: [{ id: "a" }, { id: "b" }], routes: { "/props": { default_generation_settings: { n_ctx: 32768 } } } });
		expect((await detectContextWindow(cfg(base, "c"))).max).toBeNull();
	});

	it("LM Studio: the loaded context length from /api/v0/models", async () => {
		const { base } = await fake({ models: ["m1", "m2"] });
		expect(await detectContextWindow(cfg(base, "m1"))).toEqual({ max: 8192, source: "LM Studio /api/v0/models → loaded_context_length" });
	});

	it("Ollama: the loaded model's real context first, then num_ctx, then the model maximum (labelled as such)", async () => {
		const loaded = await fake({ models: ["llama3:8b"], routes: { "/api/ps": { models: [{ name: "llama3:8b", model: "llama3:8b", context_length: 4096 }] }, "/api/show": { parameters: "num_ctx 8192", model_info: { "llama.context_length": 131072 } } } });
		expect(await detectContextWindow(cfg(loaded.base, "llama3:8b"))).toEqual({ max: 4096, source: "Ollama /api/ps → context_length（已加载）" });
		const numCtx = await fake({ models: ["llama3:8b"], routes: { "/api/show": { parameters: "num_ctx 8192\nstop foo", model_info: { "llama.context_length": 131072 } } } });
		expect(await detectContextWindow(cfg(numCtx.base, "llama3:8b"))).toMatchObject({ max: 8192 });
		const maxOnly = await fake({ models: ["llama3:8b"], routes: { "/api/show": { model_info: { "llama.context_length": 131072 } } } });
		const r = await detectContextWindow(cfg(maxOnly.base, "llama3:8b"));
		expect(r.max).toBe(131072);
		expect(r.source).toContain("实际加载的窗口可能更小");
	});

	it("Anthropic: max_input_tokens from /v1/models/<id>", async () => {
		const { base } = await fake({ routes: { "/v1/models/claude-x": { id: "claude-x", max_input_tokens: 200000 } } });
		expect(await detectContextWindow({ kind: "anthropic", baseUrl: base, apiKey: "k", model: "claude-x" })).toEqual({ max: 200000, source: "Anthropic /v1/models 的 max_input_tokens" });
	});

	it("says so when it cannot tell (never invents a number)", async () => {
		const { base } = await fake({ models: ["q"] });
		const r = await detectContextWindow(cfg(base, "q"));
		expect(r.max).toBeNull();
		expect(r.source).toContain("没有报告");
		expect((await detectContextWindow(cfg(base, ""))).max).toBeNull();
	});

	it("model listings carry each model's own context length", async () => {
		const { base } = await fake({ modelEntries: [{ id: "a", max_model_len: 240000 }, { id: "b", max_model_len: 131072 }] });
		const models = await listOpenAiCompatModels(base);
		expect(models!.map((m) => [m.id, m.contextLength])).toEqual([["a", 240000], ["b", 131072]]);
	});
});

describe("probeServerState", () => {
	// 一个会“记住数字”的假模型：第一句让它记住 N，之后问“数字是多少”就把对话里出现过的 N 说出来
	const recall = (conv: Array<{ role: string; content: string }>) => {
		const said = conv.map((m) => /记住这个数字：(\d+)/.exec(m.content)?.[1]).find(Boolean);
		return conv.at(-1)!.content.includes("数字是多少") ? (said ?? "不知道") : "好";
	};

	it("supported only when the 2nd turn really recalls the 1st", async () => {
		const { base } = await fake({ responses: "stateful", responsesReply: recall });
		const r = await probeServerState(cfg(base));
		expect(r.supported).toBe(true);
		expect(r.reason).toContain("答出了第一轮的数字");
	});

	it("a backend that accepts previous_response_id but ignores it is NOT supported", async () => {
		const { base } = await fake({ responses: "ignore", responsesReply: recall });
		const r = await probeServerState(cfg(base));
		expect(r.supported).toBe(false);
		expect(r.reason).toContain("没有真的保存对话");
	});

	it("a stateless backend's explanation is shown as the reason", async () => {
		const { base } = await fake({ responses: "stateless", responsesReply: recall });
		const r = await probeServerState(cfg(base));
		expect(r.supported).toBe(false);
		expect(r.reason).toContain("stateless");
	});

	it("an endpoint without /v1/responses reports the HTTP error", async () => {
		const server = http.createServer((req, res) => (req.resume(), res.writeHead(404, { "content-type": "application/json" }), res.end("{}")));
		extra.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const r = await probeServerState(cfg(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
		expect(r).toMatchObject({ supported: false });
		expect(r.reason).toContain("404");
	});

	it("Anthropic has no such API", async () => {
		expect((await probeServerState({ kind: "anthropic", baseUrl: "http://x", model: "m" })).supported).toBe(false);
	});
});

describe("settings + routes", () => {
	async function setup(opts: ConstructorParameters<typeof FakeLlm>[0] = {}) {
		const { base } = await fake(opts);
		const settingsPath = join(mkdtempSync(join(tmpdir(), "pba-ctx-")), "settings.local.json");
		const session = new Session({ settingsPath, pollPhase: false });
		session.updateSettings({ llm: { baseUrl: base, model: "A" } });
		const app = await buildServer(session);
		return { session, app, settingsPath };
	}

	it("defaults to the old behaviour: window mode; manual fallback window 65535", async () => {
		const { session, app } = await setup();
		expect(session.getSettings().agent).toMatchObject({ contextMode: "window", contextWindow: 65535 }); // 手动后备值默认 65535
		await app.close();
	});

	it("saves the mode / manual window and rejects nonsense (loudly, 400)", async () => {
		const { session, app } = await setup();
		const put = (agent: object) => app.inject({ method: "PUT", url: "/api/settings", payload: { agent } });
		expect((await put({ contextMode: "continuous", contextWindow: 65536 })).statusCode).toBe(200);
		expect(session.getSettings().agent).toMatchObject({ contextMode: "continuous", contextWindow: 65536 });
		expect((await put({ contextWindow: null })).statusCode).toBe(200); // 清空 = 恢复默认
		expect(session.getSettings().agent.contextWindow).toBe(65535);
		expect((await put({ contextMode: "forever" })).statusCode).toBe(400);
		expect((await put({ contextWindow: 12 })).statusCode).toBe(400);
		expect(session.getSettings().agent.contextMode).toBe("continuous"); // 失败的修改没有生效
		await app.close();
	});

	it("server-side conversation state is refused for Anthropic endpoints", async () => {
		const { session, app } = await setup();
		const r = await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { kind: "anthropic" }, agent: { contextMode: "continuous-server" } } });
		expect(r.statusCode).toBe(400);
		expect(r.json().error).toContain("Anthropic");
		expect(session.getSettings().llm.kind).toBe("openai-compat");
		await app.close();
	});

	it("/llm/context: the endpoint's own figure comes first; the manual value is only the fallback", async () => {
		const { app } = await setup({ modelEntries: [{ id: "A", max_model_len: 240000 }, { id: "B", max_model_len: 131072 }, { id: "C" }] });
		let j = (await app.inject("/api/llm/context")).json();
		expect(j).toMatchObject({ model: "A", detected: { max: 240000 }, fallback: 65535, effective: { max: 240000, source: "/v1/models → max_model_len" }, usedFallback: false });
		await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { model: "B" } } });
		j = (await app.inject("/api/llm/context")).json();
		expect(j).toMatchObject({ model: "B", detected: { max: 131072 }, effective: { max: 131072 } }); // 同一个 endpoint，换模型，窗口跟着换
		// 手动值调了也不覆盖 endpoint 报告的
		await app.inject({ method: "PUT", url: "/api/settings", payload: { agent: { contextWindow: 32768 } } });
		j = (await app.inject("/api/llm/context")).json();
		expect(j).toMatchObject({ fallback: 32768, detected: { max: 131072 }, effective: { max: 131072 }, usedFallback: false });
		// endpoint 没有这个模型的信息：才用手动值
		await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { model: "C" } } });
		j = (await app.inject("/api/llm/context")).json();
		expect(j).toMatchObject({ detected: { max: null }, effective: { max: 32768 }, usedFallback: true });
		expect(j.effective.source).toContain("手动后备值");
		await app.close();
	});

	it("when the endpoint cannot be reached at all, the (default 65535) fallback is used and says so", async () => {
		const { app } = await setup();
		await app.inject({ method: "PUT", url: "/api/settings", payload: { llm: { baseUrl: "http://127.0.0.1:1" } } });
		const j = (await app.inject("/api/llm/context")).json();
		expect(j).toMatchObject({ detected: { max: null }, effective: { max: 65535 }, usedFallback: true });
		await app.close();
	});

	it("model parameters are never accepted: no temperature / top_k / max_tokens / extra body — loudly refused", async () => {
		const { session, app } = await setup();
		const put = (llm: object) => app.inject({ method: "PUT", url: "/api/settings", payload: { llm } });
		for (const bad of [{ params: { temperature: 0.2 } }, { params: { maxTokens: 512 } }, { params: { top_k: 20 } }, { params: { temperature: null } }, { extraBody: { chat_template_kwargs: { enable_thinking: false } } }, { extraBody: {} }]) {
			const r = await put(bad);
			expect(r.statusCode).toBe(400);
			expect(r.json().error).toContain("由 endpoint 自己的配置决定");
		}
		expect((await put({ params: { timeoutMs: 90000 } })).statusCode).toBe(200); // 本地超时是本地自己的行为，可以改
		expect(session.getSettings().llm.params).toEqual({ timeoutMs: 90000 });
		await app.close();
	});

	it("old settings files: legacy sampling params / extraBody / contextWindow:null are dropped on load", () => {
		const path = join(mkdtempSync(join(tmpdir(), "pba-legacy-")), "settings.local.json");
		const llm = { kind: "openai-compat", baseUrl: "http://x", model: "m", params: { temperature: 0.7, maxTokens: 100, timeoutMs: 180000 }, extraBody: { chat_template_kwargs: { enable_thinking: false } } };
		writeFileSync(path, JSON.stringify({ slots: { a: { llm, agent: { contextWindow: null } }, b: { llm: { ...llm, extraBody: {}, params: { timeoutMs: 5000 } } } } }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const s = loadAppSettings(path);
		expect(s.slots.a.llm.params).toEqual({ timeoutMs: 180000 });
		expect(s.slots.a.llm).not.toHaveProperty("extraBody");
		expect(s.slots.a.agent.contextWindow).toBe(65535);
		expect(s.slots.b.llm.params).toEqual({ timeoutMs: 5000 });
		expect(warn).toHaveBeenCalledTimes(1); // 只有 A 带了被丢弃的东西
		expect(warn.mock.calls[0]![0]).toContain("temperature");
		warn.mockRestore();
	});

	it("two slots on the SAME endpoint with DIFFERENT models stay independent", async () => {
		const { base } = await fake({ modelEntries: [{ id: "A", max_model_len: 240000 }, { id: "B", max_model_len: 131072 }] });
		const settingsPath = join(mkdtempSync(join(tmpdir(), "pba-ctx-")), "settings.local.json");
		const a = new Session({ settingsPath, slot: "a", pollPhase: false });
		const b = new Session({ settingsPath, slot: "b", pollPhase: false });
		a.updateSettings({ llm: { baseUrl: base, model: "A" }, agent: { contextMode: "continuous" } });
		b.updateSettings({ llm: { baseUrl: base, model: "B" }, agent: { contextMode: "continuous-server" } });
		expect((await a.contextWindow()).effective.max).toBe(240000);
		expect((await b.contextWindow()).effective.max).toBe(131072);
		const saved = JSON.parse(await (await import("node:fs/promises")).readFile(settingsPath, "utf8")).slots;
		expect([saved.a.llm.model, saved.b.llm.model]).toEqual(["A", "B"]);
		expect([saved.a.agent.contextMode, saved.b.agent.contextMode]).toEqual(["continuous", "continuous-server"]);
	});

	it("/llm/state-test runs the recall probe against the saved endpoint", async () => {
		const { app } = await setup({ responses: "stateless" });
		const j = (await app.inject({ method: "POST", url: "/api/llm/state-test" })).json();
		expect(j.supported).toBe(false);
		expect(j.reason).toContain("stateless");
		await app.close();
	});
});

describe("report", () => {
	it("shows the context mode, window, peak usage and any truncation warning", () => {
		const records = [
			{ type: "run_start", runId: "r1", startedAt: "t", policy: "llm", model: { model: "m", kind: "openai-compat" }, flags: { keepFull: 30, maxRetries: 2 } },
			{ type: "context.info", mode: "continuous", max: 240000, source: "/v1/models → max_model_len" },
			{ type: "battle.state", turn: 1, observation: obs(1) },
			{ type: "llm.request", turn: 1, attempt: 1, model: "m", messages: [] },
			{ type: "llm.response", turn: 1, attempt: 1, content: RAW, reasoning: "", usage: { inputTokens: 2400, outputTokens: 80 }, latencyMs: 1000 },
			{ type: "battle.state", turn: 2, observation: obs(2) },
			{ type: "llm.request", turn: 2, attempt: 1, model: "m", messages: [] },
			{ type: "llm.response", turn: 2, attempt: 1, content: RAW, reasoning: "", usage: { inputTokens: 2300, outputTokens: 80 }, latencyMs: 1000, warning: "prompt_tokens 没有增长" },
		];
		const md = buildRunReport(records);
		expect(md).toContain("连续会话");
		expect(md).toContain("240000 tokens");
		expect(md).toContain("峰值 2400");
		expect(md).toContain("⚠ T2：prompt_tokens 没有增长");
	});
});
