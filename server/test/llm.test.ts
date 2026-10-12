import { afterEach, describe, expect, it } from "vitest";
import { parseDecision } from "../src/agent/parser.js";
import { AnthropicClient } from "../src/llm/anthropic.js";
import { discoverLocalEndpoints, listModels, listOpenAiCompatModels } from "../src/llm/discovery.js";
import { createClient } from "../src/llm/factory.js";
import { OpenAiCompatClient } from "../src/llm/openai-compat.js";
import { ThinkRouter } from "../src/llm/sse.js";
import { LlmError, deepMerge } from "../src/llm/types.js";
import { FakeLlm } from "./helpers/fake-llm.js";

let fake: FakeLlm | undefined;
afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

const msgs = [
	{ role: "system" as const, content: "sys" },
	{ role: "user" as const, content: "hi" },
];

describe("OpenAiCompatClient", () => {
	it("streams content and reasoning_content separately, sends auth + extra body", async () => {
		fake = new FakeLlm({ openaiDeltas: [{ reasoning_content: "thinking " }, { reasoning_content: "hard" }, { content: "答案是 " }, { content: '{"choice":"move:0"}' }] });
		const base = await fake.start();
		const deltas: string[] = [];
		const r = await new OpenAiCompatClient({ kind: "openai-compat", baseUrl: base, apiKey: "sk-test", model: "m" }).complete({
			messages: msgs,
			params: { temperature: 0.2, maxTokens: 100, extraBody: { chat_template_kwargs: { enable_thinking: false } }, extraHeaders: { "x-foo": "1" } },
			onDelta: (d) => deltas.push(`${d.kind}:${d.text}`),
		});
		expect(r.content).toBe('答案是 {"choice":"move:0"}');
		expect(r.reasoning).toBe("thinking hard");
		expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
		expect(deltas[0]).toBe("reasoning:thinking ");
		const req = fake.requests[0]!;
		expect(req.headers.authorization).toBe("Bearer sk-test");
		expect(req.headers["x-foo"]).toBe("1");
		expect(req.body).toMatchObject({ model: "m", stream: true, temperature: 0.2, max_tokens: 100, chat_template_kwargs: { enable_thinking: false } });
	});

	it("routes <think>…</think> inside content to reasoning, even when tags are split across chunks", async () => {
		fake = new FakeLlm({ openaiDeltas: [{ content: "<thi" }, { content: "nk>先想一想</th" }, { content: "ink>最终" }, { content: "回答" }] });
		const r = await createClient({ kind: "openai-compat", baseUrl: await fake.start(), model: "m" }).complete({ messages: msgs, params: {} });
		expect(r.reasoning).toBe("先想一想");
		expect(r.content).toBe("最终回答");
	});

	it("surfaces HTTP errors with status and body", async () => {
		fake = new FakeLlm({ openaiStatus: 401 });
		const p = new OpenAiCompatClient({ kind: "openai-compat", baseUrl: await fake.start(), model: "m" }).complete({ messages: msgs, params: {} });
		await expect(p).rejects.toMatchObject({ status: 401 });
	});

	it("times out", async () => {
		fake = new FakeLlm({ delayMs: 400 });
		const p = new OpenAiCompatClient({ kind: "openai-compat", baseUrl: await fake.start(), model: "m" }).complete({ messages: msgs, params: { timeoutMs: 80 } });
		await expect(p).rejects.toThrow(/超时/);
	});

	it("can be cancelled with an AbortSignal", async () => {
		fake = new FakeLlm({ delayMs: 400 });
		const ac = new AbortController();
		const p = new OpenAiCompatClient({ kind: "openai-compat", baseUrl: await fake.start(), model: "m" }).complete({ messages: msgs, params: {}, signal: ac.signal });
		setTimeout(() => ac.abort(), 30);
		await expect(p).rejects.toBeInstanceOf(LlmError);
	});
});

describe("sampling parameters are not sent unless set (the endpoint's own config decides)", () => {
	it("openai-compat: no temperature / max_tokens / reasoning_effort in the body by default", async () => {
		fake = new FakeLlm({ openaiDeltas: [{ content: "ok" }] });
		await new OpenAiCompatClient({ kind: "openai-compat", baseUrl: await fake.start(), model: "m" }).complete({ messages: msgs, params: { timeoutMs: 5000 } });
		const body = fake.requests[0]!.body;
		for (const k of ["temperature", "max_tokens", "reasoning_effort", "top_p"]) expect(body).not.toHaveProperty(k);
		expect(body).toMatchObject({ model: "m", stream: true });
	});
});

describe("empty replies are reported honestly", () => {
	it("a stream that ends without any content or reasoning is an error that carries the raw tail", async () => {
		fake = new FakeLlm({ openaiDeltas: [] });
		const p = new OpenAiCompatClient({ kind: "openai-compat", baseUrl: await fake.start(), model: "m" }).complete({ messages: msgs, params: {} });
		await expect(p).rejects.toThrow(/空回复.*finish_reason=stop.*最后的原始数据/);
	});
});

describe("AnthropicClient", () => {
	it("streams text + thinking, sends system separately and omits temperature when thinking", async () => {
		fake = new FakeLlm({
			anthropicEvents: [
				{ type: "message_start", message: { usage: { input_tokens: 21 } } },
				{ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "嗯…" } },
				{ type: "content_block_delta", delta: { type: "text_delta", text: "选 " } },
				{ type: "content_block_delta", delta: { type: "text_delta", text: "move:1" } },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
			],
		});
		const base = await fake.start();
		const r = await new AnthropicClient({ kind: "anthropic", baseUrl: base, apiKey: "ak", model: "claude-x" }).complete({ messages: msgs, params: { temperature: 0.3, thinkingBudget: 2000 } });
		expect(r).toMatchObject({ content: "选 move:1", reasoning: "嗯…", usage: { inputTokens: 21, outputTokens: 9 }, finishReason: "end_turn" });
		const req = fake.requests[0]!;
		expect(req.headers["x-api-key"]).toBe("ak");
		expect(req.headers["anthropic-version"]).toBe("2023-06-01");
		expect(req.body.system).toBe("sys");
		expect(req.body.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(req.body.thinking).toEqual({ type: "enabled", budget_tokens: 2000 });
		expect(req.body).not.toHaveProperty("temperature");
	});

	it("sends temperature when thinking is off", async () => {
		fake = new FakeLlm({ anthropicEvents: [{ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }] });
		await new AnthropicClient({ kind: "anthropic", baseUrl: await fake.start(), apiKey: "ak", model: "m" }).complete({ messages: msgs, params: { temperature: 0.3 } });
		expect(fake.requests[0]!.body.temperature).toBe(0.3);
		expect(fake.requests[0]!.body).not.toHaveProperty("thinking");
	});
});

describe("ThinkRouter / deepMerge", () => {
	it("holds back a partial tag until it is resolved", () => {
		const r = new ThinkRouter();
		expect(r.feed("abc<th")).toEqual([{ kind: "content", text: "abc" }]);
		expect(r.feed("ink>x")).toEqual([{ kind: "reasoning", text: "x" }]);
		expect(r.flush()).toEqual([]);
	});
	it("deep merges nested objects but replaces arrays", () => {
		expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] })).toEqual({ a: { b: 1, c: 3 }, d: [2] });
	});
});

describe("discovery", () => {
	it("lists models, enriches LM Studio and Ollama metadata", async () => {
		fake = new FakeLlm();
		const base = await fake.start();
		const lm = await listOpenAiCompatModels(base, undefined, "lmstudio");
		expect(lm).toEqual([
			{ id: "m1", tags: [], loaded: true, contextLength: 8192 },
			{ id: "m2", tags: ["vision"], loaded: false, contextLength: undefined },
		]);
		const ol = await listOpenAiCompatModels(base, undefined, "ollama");
		expect(ol!.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(ol![0]!.tags).toEqual(["vision", "thinking"]);
	});

	it("returns null for a dead endpoint and finds custom endpoints in parallel", async () => {
		fake = new FakeLlm();
		const base = await fake.start();
		expect(await listOpenAiCompatModels("http://127.0.0.1:1", undefined, undefined, 200)).toBeNull();
		const found = await discoverLocalEndpoints([base]);
		expect(found.some((e) => e.baseUrl === base && e.models.length === 2)).toBe(true);
	});

	it("uses Anthropic headers for the Anthropic model list", async () => {
		fake = new FakeLlm({ models: ["claude-a", "claude-b"] });
		const models = await listModels({ kind: "anthropic", baseUrl: await fake.start(), apiKey: "ak" });
		expect(models!.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
		expect(fake.requests[0]!.headers["x-api-key"]).toBe("ak");
	});
});

describe("parseDecision", () => {
	const legal = ["move:0", "move:1", "switch:2"];
	it("takes the last JSON object that has a choice", () => {
		const r = parseDecision('分析……\n示例 {"foo":1}\n最终：\n{"choice":"move:1","reason":"克制"}', legal);
		expect(r).toEqual({ ok: true, choice: "move:1", reason: "克制" });
	});
	it("handles code fences, think blocks and braces inside strings", () => {
		const r = parseDecision('<think>{"choice":"move:0"}</think>\n```json\n{"choice":"switch:2","reason":"他说 {不要} 打"}\n```', legal);
		expect(r).toEqual({ ok: true, choice: "switch:2", reason: "他说 {不要} 打" });
	});
	it("rejects choices outside legal_actions and lists the legal ones", () => {
		const r = parseDecision('{"choice":"move:3","reason":"x"}', legal);
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toContain("move:0, move:1, switch:2");
	});
	it("reports missing JSON", () => {
		expect(parseDecision("我选十万伏特", legal).ok).toBe(false);
		expect(parseDecision("{broken", legal).ok).toBe(false);
	});
});
