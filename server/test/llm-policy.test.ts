import { afterEach, describe, expect, it } from "vitest";
import { LlmPolicy } from "../src/agent/llm-policy.js";
import { PolicyFailure } from "../src/agent/policy.js";
import type { Observation } from "../src/agent/observation.js";
import { buildSystemMessage, loadPreset } from "../src/agent/prompt.js";
import { BattleHistory } from "../src/agent/history.js";
import type { AgentEvent } from "../src/agent/events.js";
import { OpenAiCompatClient } from "../src/llm/openai-compat.js";
import { FakeLlm } from "./helpers/fake-llm.js";

let fake: FakeLlm | undefined;
afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

function obs(turn: number, oppHp = 100, myHp = 120): Observation {
	return {
		turn,
		phase: "action_menu",
		you: { active: { party_index: 0, species: "雷伊布", species_en: "Jolteon", level: 44, hp: myHp, max_hp: 120, status: null, types: ["电"], stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, ability: "Volt Absorb", item: null, moves: [], fainted: false, active: true }, party: [] },
		opponent: { species: "大狼犬", species_en: "Mightyena", level: 46, types: ["恶"], hp_percent: oppHp, status: null, known_moves: [], unknown_move_slots: 4, ability: null, item: null },
		opponent_remaining: 5,
		opponent_party_size: 5,
		field: { weather: null, your_side: [], opponent_side: [] },
		legal_actions: [
			{ id: "move:0", label: "十万伏特" },
			{ id: "move:1", label: "二连踢" },
			{ id: "switch:1", label: "换上 暴飞龙" },
		],
		last_turn: [],
	};
}

const ctx = (turn: number, o = obs(turn)) => ({ truth: {} as never, observation: o, legal: ["move:0", "move:1", "switch:1"] as never, turn, mode: "action" as const });
const prompt = { preset: loadPreset(), rulesHint: false };

function policy(over: Partial<ConstructorParameters<typeof LlmPolicy>[0]> & { base: string }, events: AgentEvent[] = []) {
	return new LlmPolicy({
		client: new OpenAiCompatClient({ kind: "openai-compat", baseUrl: over.base, model: "m" }),
		model: "m",
		params: { timeoutMs: 3000 },
		prompt,
		sink: (e) => events.push(e),
		...over,
	});
}

describe("LlmPolicy", () => {
	it("parses the model's JSON, emits events, records history", async () => {
		fake = new FakeLlm({ openaiDeltas: [{ reasoning_content: "想" }, { content: '分析…\n{"choice":"move:1","reason":"二连踢克制恶系"}' }] });
		const events: AgentEvent[] = [];
		const p = policy({ base: await fake.start() }, events);
		const d = await p.decide(ctx(1));
		expect(d).toMatchObject({ choice: "move:1", reason: "二连踢克制恶系" });
		expect(events.map((e) => e.type)).toEqual(["llm.request", "llm.delta", "llm.delta", "llm.response", "action.parsed"]);
		expect(p.history.length).toBe(1);
		// 发出去的是：system + 当前状态 JSON
		const sent = fake.requests[0]!.body.messages;
		expect(sent[0].role).toBe("system");
		expect(sent[0].content).toContain("现在你需要玩宝可梦绿宝石");
		expect(sent[0].content).not.toContain("规则提示"); // rules_hint 默认关
		expect(sent.at(-1).content).toContain('"legal_actions"');
	});

	it("retries with error feedback after a bad answer, then succeeds", async () => {
		fake = new FakeLlm({ openaiDeltas: [{ content: "我选 move:9" }] });
		const base = await fake.start();
		const p = policy({ base, maxRetries: 2 });
		await expect(p.decide(ctx(1))).rejects.toBeInstanceOf(PolicyFailure);
		expect(fake.requests.length).toBe(3); // 1 次 + 2 次重试
		const last = fake.requests[2]!.body.messages;
		expect(last.at(-1).content).toContain("无法使用");
		expect(p.stats.formatFailures).toBe(3);
	});

	it("has no fallback: with retries disabled a bad answer fails immediately", async () => {
		fake = new FakeLlm({ openaiDeltas: [{ content: "没有 JSON" }] });
		const p = policy({ base: await fake.start(), maxRetries: 0 });
		await expect(p.decide(ctx(1))).rejects.toBeInstanceOf(PolicyFailure);
		expect(fake.requests.length).toBe(1);
	});

	it("does not re-send the same prompt after a transport error or timeout — it reports the error once", async () => {
		fake = new FakeLlm({ openaiStatus: 500 });
		const events: AgentEvent[] = [];
		const p = policy({ base: await fake.start(), maxRetries: 2 }, events);
		await expect(p.decide(ctx(1))).rejects.toThrow(/模型调用失败（不重试）.*500/);
		expect(fake.requests.length).toBe(1); // 没有第二次、第三次一模一样的请求
		expect(events.some((e) => e.type === "llm.response" && e.parseError?.includes("500"))).toBe(true);
	});

	it("a timeout is also a single failure, not three identical waits", async () => {
		fake = new FakeLlm({ delayMs: 400 });
		const p = new LlmPolicy({ client: new OpenAiCompatClient({ kind: "openai-compat", baseUrl: await fake.start(), model: "m" }), model: "m", params: { timeoutMs: 80 }, prompt, maxRetries: 2 });
		await expect(p.decide(ctx(1))).rejects.toThrow(/不重试.*超时/);
		expect(fake.requests.length).toBe(1);
	});

	it("can be cancelled mid-request", async () => {
		fake = new FakeLlm({ delayMs: 500 });
		const p = policy({ base: await fake.start() });
		const pending = p.decide(ctx(1));
		setTimeout(() => p.cancel(), 50);
		await expect(pending).rejects.toThrow(/取消/);
	});
});

describe("prompt + history", () => {
	it("rules_hint is opt-in", () => {
		expect(buildSystemMessage({ preset: loadPreset(), rulesHint: false }).content).not.toContain("第 3 世代规则");
		expect(buildSystemMessage({ preset: loadPreset(), rulesHint: true }).content).toContain("第 3 世代规则");
	});

	it("keeps the last K turns in full; older turns become 'what you chose + the text you read' with no analysis", () => {
		const h = new BattleHistory(2);
		const hp = [100, 85, 60, 40, 20];
		const texts: Record<number, string[]> = { 2: ["JOLTEON used THUNDERBOLT!", "It's super effective!"], 3: ["Foe MIGHTYENA used CRUNCH!"] };
		const o = (t: number) => ({ ...obs(t, hp[t - 1]), last_turn: texts[t] ?? [] });
		for (let t = 1; t <= 4; t++) h.record(o(t), "move:0", "十万伏特", "x");
		const msgs = h.buildMessages(o(5));
		// 摘要(1) + 最近 2 回合 (user+assistant)×2 + 当前(1)
		expect(msgs).toHaveLength(1 + 4 + 1);
		expect(msgs[0]!.content).toContain("【更早回合摘要】");
		expect(msgs[0]!.content).toContain("T1：雷伊布 → 十万伏特｜之后读到：JOLTEON used THUNDERBOLT! / It's super effective!");
		expect(msgs[0]!.content).toContain("T2：雷伊布 → 十万伏特｜之后读到：Foe MIGHTYENA used CRUNCH!");
		expect(msgs[0]!.content).not.toContain("%"); // 不再拼 HP 变化
		expect(msgs[0]!.content).not.toContain("T3");
		expect(msgs[1]!.content).toContain("第 3 回合");
		expect(msgs[2]).toEqual({ role: "assistant", content: '{"choice":"move:0","reason":"x"}' });
		expect(msgs.at(-1)!.content).toContain("第 5 回合");
	});

});
