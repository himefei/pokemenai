// "AI 输入审计"：模型能看到的一切都必须是——游戏界面上玩家看得到/读得到的信息、自己宝可梦的信息、
// 和"怎么操作"的接口说明。不允许出现替模型做分析、给建议、给参考资料的内容。
// 谁以后给观测加了派生字段，或者在提示词里写了"先看属性克制/预估伤害……"，这里就会失败。
import { describe, expect, it } from "vitest";
import { buildObservation } from "../src/agent/observation.js";
import { BattleTracker } from "../src/agent/tracker.js";
import { BattleHistory } from "../src/agent/history.js";
import { buildSystemMessage, formatStateMessage, loadPreset, retryFeedback } from "../src/agent/prompt.js";
import { legalActions } from "../src/gen3/battle-state.js";
import { Gen3Data } from "../src/gen3/data.js";
import { snapshot } from "./helpers/synthetic.js";

const data = Gen3Data.load();
const snap = snapshot({ lastMoves: [0, 242, 0, 0] });
const tracker = new BattleTracker(data);
tracker.update(snap, ["Foe MIGHTYENA used CRUNCH!"]);
const legal = legalActions(snap);
const obs = buildObservation({ snapshot: snap, tracker, data, legal, turn: 3, messages: ["JOLTEON used THUNDERBOLT!", "It's super effective!"] });

const keys = (o: object) => Object.keys(o).sort();

describe("observation shape is an allow-list (no derived / analytical fields)", () => {
	it("top level", () => {
		expect(keys(obs)).toEqual(["field", "last_turn", "legal_actions", "opponent", "opponent_party_size", "opponent_remaining", "phase", "turn", "you"]);
	});

	it("opponent: only what the screen shows or the text revealed — no stats, no stages, no full move list", () => {
		expect(keys(obs.opponent)).toEqual(["ability", "hp_percent", "item", "known_moves", "level", "species", "species_en", "status", "types", "unknown_move_slots"]);
	});

	it("own side: the player's own Pokémon info only", () => {
		expect(keys(obs.you)).toEqual(["active", "party"]);
		const allowed = ["ability", "active", "fainted", "hp", "item", "level", "max_hp", "moves", "party_index", "species", "species_en", "stat_stages", "stats", "status", "types", "volatile"];
		expect(keys(obs.you.active).every((k) => allowed.includes(k))).toBe(true);
		expect(keys(obs.you.active.moves[0]!)).toEqual(["accuracy", "id", "max_pp", "name", "name_en", "power", "pp", "type"]);
	});

	it("legal_actions are just id + label", () => {
		for (const a of obs.legal_actions) expect(keys(a)).toEqual(["id", "label"]);
	});

	it("no key anywhere hints at analysis, advice, effectiveness or damage", () => {
		const bad = /damage|effective|weak|resist|recommend|suggest|advice|best|score|rank|speed_order|outspeed|ko_|estimate|calc|matchup|counter/i;
		const walk = (v: unknown, path: string): string[] => {
			if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`));
			if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => (bad.test(k) ? [`${path}.${k}`] : []).concat(walk(x, `${path}.${k}`)));
			return [];
		};
		expect(walk(obs, "obs")).toEqual([]);
	});

	it("never leaks the opponent's real moves, stats or the speed/stat numbers it did not reveal", () => {
		const json = JSON.stringify(obs.opponent);
		expect(json).not.toMatch(/吼叫|泼沙|舍身|Roar|Sand|Double-Edge/); // 没用过的招式
		expect(json).not.toContain("999"); // 对手数值
		expect(json).toContain("咬碎"); // 用过的招式
	});

	it("the revealed-move list contains only moves actually used", () => {
		expect(obs.opponent.known_moves).toEqual([{ name: "咬碎", name_en: "Crunch" }]);
		expect(obs.opponent.unknown_move_slots).toBe(3);
	});
});

describe("prompts contain interface documentation only — no prescribed analysis, no reference data", () => {
	const preset = loadPreset();
	const system = buildSystemMessage({ preset, rulesHint: false }).content;

	it("the output instructions do not tell the model what to analyse or what to prefer", () => {
		const prescriptive = ["属性克制", "速度先后", "预估伤害", "风险", "是否值得换人", "建议", "优先", "应该选", "最好", "务必先", "先简要分析"];
		for (const w of prescriptive) expect(preset.output_instructions, `禁止的措辞：${w}`).not.toContain(w);
		expect(preset.output_instructions).toContain("怎么判断由你自己决定");
	});

	it("no type chart, base stats, move tables or Gen-3 rules are injected by default", () => {
		for (const w of ["第 3 世代规则", "种族值", "克制表", "无妖精系", "按属性划分"]) expect(system).not.toContain(w);
	});

	it("the base prompt is the user's own text (team background only)", () => {
		expect(system).toContain("现在你需要玩宝可梦绿宝石");
		expect(system).toContain("首先挑战的是四天王的恶系天王");
	});

	it("the retry feedback only reports the error and the legal ids", () => {
		const msg = retryFeedback('choice "move:9" 不在 legal_actions 里。合法选项：move:0, move:1').content;
		expect(msg).not.toMatch(/建议|应该|最好|优先/);
	});

	it("the per-turn user message is the observation JSON and nothing else", () => {
		const m = formatStateMessage(obs).content;
		expect(m.startsWith("当前状态（第 3 回合）：\n{")).toBe(true);
		expect(JSON.parse(m.slice(m.indexOf("\n") + 1))).toEqual(JSON.parse(JSON.stringify(obs)));
	});

	it("older-turn summaries are verbatim game text — no computed HP changes or effectiveness labels", () => {
		const h = new BattleHistory(1);
		h.record({ ...obs, turn: 1 }, "move:0", "十万伏特", "r");
		h.record({ ...obs, turn: 2, last_turn: ["Foe MIGHTYENA used CRUNCH!"] }, "move:1", "二连踢", "r");
		const summary = h.buildMessages({ ...obs, turn: 3 })[0]!.content;
		expect(summary).toContain("之后读到：");
		expect(summary).not.toMatch(/%|→HP|克制|效果绝佳|伤害/);
	});
});
