import { describe, expect, it } from "vitest";
import { buildObservation } from "../src/agent/observation.js";
import { BattleTracker } from "../src/agent/tracker.js";
import { buildRunReport } from "../src/eval/report.js";
import { legalActions } from "../src/gen3/battle-state.js";
import { Gen3Data } from "../src/gen3/data.js";
import { snapshot } from "./helpers/synthetic.js";

const data = Gen3Data.load();
const snap = snapshot({ lastMoves: [0, 242, 0, 0] });
const tracker = new BattleTracker(data);
tracker.update(snap, ["Foe MIGHTYENA used CRUNCH!"]);
const obs = (turn: number) => buildObservation({ snapshot: snap, tracker, data, legal: legalActions(snap), turn, messages: ["JOLTEON used THUNDERBOLT!", "It's super effective!"] });

const records = [
	{ type: "run_start", runId: "r1", startedAt: "2026-10-11T00:00:00Z", policy: "llm", model: { model: "m-x", kind: "openai-compat", params: { temperature: 0.6 } }, prompt: { preset: "默认", rulesHint: false, base_prompt: "BASE PROMPT TEXT", output_instructions: "OUTPUT RULES" }, flags: { keepFull: 30, maxRetries: 2 } },
	{ type: "battle.state", turn: 1, observation: obs(1), truth: {} },
	{ type: "llm.request", turn: 1, attempt: 1, model: "m-x", messages: [] },
	{ type: "llm.response", turn: 1, attempt: 1, content: "没有 JSON", reasoning: "SECRET-THINKING-1", usage: { inputTokens: 100, outputTokens: 4096 }, latencyMs: 90000, parseError: "没有找到 JSON" },
	{ type: "llm.request", turn: 1, attempt: 2, model: "m-x", messages: [] },
	{ type: "llm.response", turn: 1, attempt: 2, content: '{"choice":"move:0","reason":"STAB"}', reasoning: "SECRET-THINKING-2", usage: { inputTokens: 100, outputTokens: 50 }, latencyMs: 8000 },
	{ type: "action.parsed", turn: 1, choice: "move:0", label: "十万伏特", reason: "STAB", attempts: 2 },
	{ type: "action.done", turn: 1, choice: "move:0", result: { ok: true } },
	{ type: "battle.end", result: {} },
	{ type: "run_end", summary: { outcomeName: "WON", turns: 1, partyAlive: 4, frames: 1234 } },
];

describe("buildRunReport", () => {
	const md = buildRunReport(records);

	it("has the sections an external analyst needs", () => {
		for (const h of ["# 宝可梦战斗日志：r1", "## 1. 概要", "## 2. 信息设定", "## 3. 发给模型的 system 提示词", "## 4. 逐回合记录", "## 5. 统计", "## 6. 给分析者的提示"]) expect(md).toContain(h);
		expect(md).toContain("BASE PROMPT TEXT");
		expect(md).toContain("OUTPUT RULES");
	});

	it("summarises outcome, retries, format failures and tokens", () => {
		expect(md).toContain("结果：**WON**");
		expect(md).toContain("需要重试的 1 次");
		expect(md).toContain("格式/解析失败的尝试 1 次");
		expect(md).toContain("输出 4146");
	});

	it("shows what the model saw: perception-only opponent, game text, legal actions", () => {
		expect(md).toContain("已知招式：咬碎（另有 3 个未见）");
		expect(md).toContain("> JOLTEON used THUNDERBOLT!");
		expect(md).toContain("`move:0` 十万伏特");
		expect(md).not.toContain("吼叫"); // 对手没暴露的招式不会出现在日志里
	});

	it("shows both attempts, the parse error, the choice and the execution result", () => {
		expect(md).toContain("第 1 次尝试");
		expect(md).toContain("❌ 没有找到 JSON");
		expect(md).toContain("**选择**：十万伏特");
		expect(md).toContain("✓ 成功");
	});

	it("thinking and observation JSON can be left out to save tokens", () => {
		expect(md).toContain("SECRET-THINKING-2");
		const lean = buildRunReport(records, { thinking: false, observationJson: false });
		expect(lean).not.toContain("SECRET-THINKING");
		expect(lean).not.toContain("模型看到的完整观测 JSON");
		expect(lean.length).toBeLessThan(md.length);
	});

	it("never contains an API key field", () => {
		expect(md).not.toMatch(/api[_-]?key/i);
	});
});
