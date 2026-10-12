import { describe, expect, it } from "vitest";
import { buildTimeline, foldEvents } from "./store";
import type { AgentEvent, Observation } from "./types";

const obs = (turn: number, oppHp: number, myHp: number, opp = "大狼犬"): Observation => ({
	turn,
	phase: "action_menu",
	you: { active: { party_index: 0, species: "雷伊布", species_en: "Jolteon", level: 44, hp: myHp, max_hp: 120, status: null, types: ["电"], stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, ability: null, item: null, moves: [], fainted: false, active: true }, party: [] },
	opponent: { species: opp, species_en: "x", level: 46, types: ["恶"], hp_percent: oppHp, status: null, known_moves: [], unknown_move_slots: 4, ability: null, item: null },
	opponent_remaining: 5,
	opponent_party_size: 5,
	field: { weather: null, your_side: [], opponent_side: [] },
	legal_actions: [],
	last_turn: [],
});

const turn1: AgentEvent[] = [
	{ type: "battle.state", turn: 1, observation: obs(1, 100, 120), truth: {} },
	{ type: "llm.request", turn: 1, attempt: 1, model: "m", messages: [{ role: "user", content: "hi" }] },
	{ type: "llm.delta", turn: 1, attempt: 1, kind: "reasoning", text: "想" },
	{ type: "llm.delta", turn: 1, attempt: 1, kind: "reasoning", text: "想看" },
	{ type: "llm.delta", turn: 1, attempt: 1, kind: "content", text: '{"choice"' },
	{ type: "llm.response", turn: 1, attempt: 1, content: '{"choice":"move:0"}', reasoning: "想想看", usage: { outputTokens: 5 }, latencyMs: 1200 },
	{ type: "action.parsed", turn: 1, choice: "move:0", label: "十万伏特", reason: "STAB", attempts: 1 },
	{ type: "action.executing", turn: 1, choice: "move:0", label: "十万伏特" },
	{ type: "action.done", turn: 1, choice: "move:0", result: { ok: true } },
];

describe("reduce", () => {
	it("builds a turn record: streaming deltas, final response, parsed action, exec result", () => {
		const s = foldEvents(turn1);
		const r = s.records[0]!;
		expect(r.attempts).toHaveLength(1);
		expect(r.attempts[0]).toMatchObject({ reasoning: "想想看", content: '{"choice":"move:0"}', streaming: false, latencyMs: 1200 });
		expect(r.parsed).toMatchObject({ choice: "move:0", label: "十万伏特", reason: "STAB" });
		expect(r.exec).toEqual({ ok: true });
		expect(r.executing).toBeUndefined();
	});

	it("shows streaming text before the response arrives", () => {
		const s = foldEvents(turn1.slice(0, 5));
		expect(s.records[0]!.attempts[0]).toMatchObject({ streaming: true, reasoning: "想想看", content: '{"choice"' });
	});

	it("records when the request was sent and settles a call that errored out (no endless 'generating')", () => {
		const s = foldEvents([
			turn1[0]!,
			{ type: "controller.state", state: "deciding" },
			{ type: "llm.request", turn: 1, attempt: 1, model: "m", messages: [], ts: 1000 },
			{ type: "error", message: "模型调用失败（不重试）：请求超时" },
		]);
		expect(s.records[0]!.attempts[0]).toMatchObject({ streaming: false, startedAt: 1000, failed: "模型调用失败（不重试）：请求超时" });
	});

	it("settles a still-streaming call when the controller leaves 'deciding' (emergency stop)", () => {
		const s = foldEvents([
			turn1[0]!,
			{ type: "controller.state", state: "deciding" },
			{ type: "llm.request", turn: 1, attempt: 1, model: "m", messages: [], ts: 1 },
			{ type: "controller.state", state: "idle" },
		]);
		expect(s.records[0]!.attempts[0]).toMatchObject({ streaming: false, failed: "已中断" });
	});

	it("keeps retries as separate attempts and records the parse error", () => {
		const s = foldEvents([
			turn1[0]!,
			{ type: "llm.request", turn: 1, attempt: 1, model: "m", messages: [] },
			{ type: "llm.response", turn: 1, attempt: 1, content: "没有 JSON", reasoning: "", usage: {}, latencyMs: 1, parseError: "没有找到 JSON" },
			{ type: "llm.request", turn: 1, attempt: 2, model: "m", messages: [] },
		]);
		expect(s.records[0]!.attempts.map((a) => [a.n, a.parseError ?? null])).toEqual([[1, "没有找到 JSON"], [2, null]]);
	});

	it("starts a fresh battle when the turn number resets", () => {
		const s = foldEvents([
			{ type: "battle.state", turn: 1, observation: obs(1, 100, 120), truth: {} },
			{ type: "battle.state", turn: 2, observation: obs(2, 80, 120), truth: {} },
			{ type: "battle.end", result: { battle: 1, outcome: 1, outcomeName: "WON", turns: 2, decisions: 2, rejections: 0, nudges: 0, frames: 1, partyAlive: 1, rngSeed: null } },
			{ type: "battle.state", turn: 1, observation: obs(1, 100, 120), truth: {} },
		]);
		expect(s.records).toHaveLength(1);
		expect(s.summary).toBeNull();
	});

	it("ignores unknown event types (history files contain extra records)", () => {
		const s = foldEvents([{ type: "nudge" } as never, { type: "run_start" } as never]);
		expect(s.records).toEqual([]);
	});

	it("keeps both decisions of the same turn (move, then forced switch)", () => {
		const s = foldEvents([
			{ type: "battle.state", turn: 14, observation: obs(14, 8, 6), truth: {} },
			{ type: "action.parsed", turn: 14, choice: "move:2", label: "飞翔", reason: "x", attempts: 1 },
			{ type: "battle.state", turn: 14, observation: obs(14, 8, 0), truth: {} },
			{ type: "action.parsed", turn: 14, choice: "switch:1", label: "换上 梦幻", reason: "y", attempts: 1 },
		]);
		expect(s.records.map((r) => r.parsed?.label)).toEqual(["飞翔", "换上 梦幻"]);
	});
});

describe("buildTimeline", () => {
	it("fills in the result of a turn from the next observation", () => {
		const s = foldEvents([...turn1, { type: "battle.state", turn: 2, observation: obs(2, 60, 100), truth: {} }]);
		const rows = buildTimeline(s.records);
		expect(rows[0]).toMatchObject({ turn: 1, action: "十万伏特", oppBefore: 100, oppAfter: 60, meHp: "120→100", status: "ok" });
		expect(rows[1]).toMatchObject({ turn: 2, status: "pending", oppAfter: null });
	});

	it("does not compare HP across different opponents", () => {
		const s = foldEvents([...turn1, { type: "battle.state", turn: 2, observation: obs(2, 100, 100, "狡猾天狗"), truth: {} }]);
		expect(buildTimeline(s.records)[0]!.oppAfter).toBeNull();
	});
});
