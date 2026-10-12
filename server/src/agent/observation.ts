// 可见性过滤层：把完整内存快照变成"给模型看的观测"。
//   我方：全知（自己的宝可梦所有信息）。
//   对手：只给玩家在屏幕上看得到/读得到的东西——种类、等级、属性、HP 条（百分比）、异常状态，
//         用过的招式（其余槽位未知）、被战斗文字揭示的特性/持有物。
// 不给任何参考资料：属性克制表、种族值、对手招式数据、伤害计算、第 3 世代规则提示。

import type { ActionId, BattleSnapshot } from "../gen3/battle-state.js";
import { parseActionId } from "../gen3/battle-state.js";
import type { Gen3Data } from "../gen3/data.js";
import { SIDE_STATUS, WEATHER, majorStatus, volatileFlags } from "../gen3/structs.js";
import type { BattleMon, PartyMon, StatStages } from "../gen3/structs.js";
import type { BattleTracker } from "./tracker.js";

export interface ObservationOptions {
	/** 我方招式的威力/命中（游戏的招式详情页能看到）。默认 true。 */
	ownMoveDetails?: boolean;
}

export interface MoveView {
	id: string;
	name: string;
	name_en: string;
	type: string;
	pp: number;
	max_pp: number | null;
	power?: number;
	accuracy?: number | null;
}

export interface OwnMonView {
	party_index: number;
	species: string;
	species_en: string;
	level: number;
	hp: number;
	max_hp: number;
	status: string | null;
	types: string[];
	stats: { atk: number; def: number; spa: number; spd: number; spe: number };
	ability: string | null;
	item: string | null;
	moves: MoveView[];
	stat_stages?: StatStages;
	volatile?: string[];
	fainted: boolean;
	active: boolean;
}

export interface OpponentView {
	species: string;
	species_en: string;
	level: number;
	types: string[];
	/** HP 条：0–100 的整数百分比 */
	hp_percent: number;
	status: string | null;
	/** 对手用过的招式；其余槽位未知 */
	known_moves: Array<{ name: string; name_en: string }>;
	unknown_move_slots: number;
	/** 被战斗文字揭示前为 null */
	ability: string | null;
	item: string | null;
}

export interface Observation {
	turn: number;
	phase: string;
	you: { active: OwnMonView; party: OwnMonView[] };
	opponent: OpponentView;
	/** 对手方还没倒下的宝可梦数（含场上这只）与总数——对应屏幕上的精灵球指示 */
	opponent_remaining: number | null;
	opponent_party_size: number | null;
	field: { weather: string | null; your_side: string[]; opponent_side: string[] };
	legal_actions: Array<{ id: ActionId; label: string }>;
	/** 自上次决策以来玩家读到的战斗文字 */
	last_turn: string[];
}

const NAMES_OF = (data: Gen3Data, kind: "species" | "move", id: number) => ({
	zh: kind === "species" ? (data.species(id)?.zh ?? `#${id}`) : (data.move(id)?.zh ?? `#${id}`),
	en: kind === "species" ? (data.species(id)?.en ?? `#${id}`) : (data.move(id)?.en ?? `#${id}`),
});

const typesOf = (data: Gen3Data, t: [number, number]): string[] => (t[0] === t[1] ? [data.typeName(t[0], "zh")] : [data.typeName(t[0], "zh"), data.typeName(t[1], "zh")]);

function moveViews(data: Gen3Data, moves: readonly number[], pp: readonly number[], ppBonuses: number | null, ids: boolean, details: boolean): MoveView[] {
	const out: MoveView[] = [];
	moves.forEach((id, slot) => {
		if (id === 0) return;
		const d = data.move(id);
		const base = d?.pp ?? null;
		const bonus = ppBonuses === null ? 0 : (ppBonuses >> (slot * 2)) & 3;
		const mv: MoveView = {
			id: ids ? `move:${slot}` : "",
			name: d?.zh ?? `#${id}`,
			name_en: d?.en ?? `#${id}`,
			type: d ? data.typeName(d.type, "zh") : "?",
			pp: pp[slot] ?? 0,
			max_pp: base === null ? null : base + Math.floor((base * bonus) / 5),
		};
		if (details && d) {
			mv.power = d.power;
			mv.accuracy = d.accuracy === 0 ? null : d.accuracy;
		}
		out.push(mv);
	});
	return out;
}

function abilityOf(data: Gen3Data, mon: PartyMon): string | null {
	const sp = data.species(mon.species);
	if (!sp) return null;
	return sp.abilities[mon.ivs.abilityNum] ?? sp.abilities[0] ?? null;
}

function ownFromParty(data: Gen3Data, mon: PartyMon, index: number, active: boolean, opts: Required<ObservationOptions>): OwnMonView {
	const sp = data.species(mon.species);
	const n = NAMES_OF(data, "species", mon.species);
	return {
		party_index: index,
		species: n.zh,
		species_en: n.en,
		level: mon.level,
		hp: mon.hp,
		max_hp: mon.maxHp,
		status: statusName(mon.status),
		types: sp ? typesOf(data, sp.types) : [],
		stats: { ...mon.stats },
		ability: abilityOf(data, mon),
		item: mon.heldItem ? (data.item(mon.heldItem)?.en ?? `#${mon.heldItem}`) : null,
		moves: moveViews(data, mon.moves, mon.pp, mon.ppBonuses, false, opts.ownMoveDetails),
		fainted: mon.hp <= 0,
		active,
	};
}

function statusName(status1: number): string | null {
	return majorStatus(status1);
}

function ownFromBattle(data: Gen3Data, b: BattleMon, partyMon: PartyMon | undefined, index: number, opts: Required<ObservationOptions>): OwnMonView {
	const n = NAMES_OF(data, "species", b.species);
	const transformed = volatileFlags(b.status2).includes("transformed");
	return {
		party_index: index,
		species: n.zh,
		species_en: n.en,
		level: b.level,
		hp: b.hp,
		max_hp: b.maxHp,
		status: statusName(b.status1),
		types: typesOf(data, b.types),
		stats: { ...b.stats },
		ability: data.ability(b.ability)?.en ?? null,
		item: b.item ? (data.item(b.item)?.en ?? `#${b.item}`) : null,
		// 变身后招式的 PP 上限固定为 5；其余按队伍里记录的 PP 加成计算
		moves: moveViews(data, b.moves, b.pp, transformed ? null : (partyMon?.ppBonuses ?? null), true, opts.ownMoveDetails).map((m) => (transformed ? { ...m, max_pp: 5 } : m)),
		stat_stages: b.stages,
		volatile: volatileFlags(b.status2),
		fainted: b.hp <= 0,
		active: true,
	};
}

function weatherName(w: number): string | null {
	if (w & WEATHER.RAIN) return "下雨";
	if (w & WEATHER.SANDSTORM) return "沙暴";
	if (w & WEATHER.SUN) return "大晴天";
	if (w & WEATHER.HAIL) return "冰雹";
	return null;
}

function sideNames(s: number): string[] {
	const out: string[] = [];
	if (s & SIDE_STATUS.REFLECT) out.push("反射壁");
	if (s & SIDE_STATUS.LIGHT_SCREEN) out.push("光墙");
	if (s & SIDE_STATUS.SPIKES) out.push("撒菱");
	if (s & SIDE_STATUS.SAFEGUARD) out.push("神秘守护");
	if (s & SIDE_STATUS.MIST) out.push("白雾");
	if (s & SIDE_STATUS.FUTURE_ATTACK) out.push("未来攻击（待发）");
	return out;
}

export function buildObservation(args: {
	snapshot: BattleSnapshot;
	tracker: BattleTracker;
	data: Gen3Data;
	legal: ActionId[];
	turn: number;
	messages: string[];
	options?: ObservationOptions;
}): Observation {
	const { snapshot: s, tracker, data, legal, turn, messages } = args;
	const opts: Required<ObservationOptions> = { ownMoveDetails: args.options?.ownMoveDetails ?? true };

	const activeIdx = s.playerPartyIndex;
	const active = ownFromBattle(data, s.player, s.party[activeIdx], activeIdx, opts);
	const party = s.party.map((m, i) => (i === activeIdx ? active : ownFromParty(data, m, i, false, opts)));

	const mem = tracker.current(s);
	const o = s.opponent;
	const on = NAMES_OF(data, "species", o.species);
	const known = (mem?.knownMoves ?? []).map((id) => {
		const n = NAMES_OF(data, "move", id);
		return { name: n.zh, name_en: n.en };
	});
	const opponent: OpponentView = {
		species: on.zh,
		species_en: on.en,
		level: o.level,
		types: typesOf(data, o.types),
		hp_percent: o.maxHp > 0 ? Math.max(o.hp > 0 ? 1 : 0, Math.round((o.hp / o.maxHp) * 100)) : 0,
		status: statusName(o.status1),
		known_moves: known,
		unknown_move_slots: Math.max(0, 4 - known.length),
		ability: mem?.ability ?? null,
		item: mem?.item ?? null,
	};

	const alive = s.enemyParty.filter((m) => m.hp > 0).length;
	const labelOf = (id: ActionId): string => {
		const a = parseActionId(id);
		if (a.kind === "prompt") return a.yes ? "是" : "否";
		if (a.kind === "move") return active.moves.find((m) => m.id === id)?.name ?? id;
		const m = s.party[a.partyIndex];
		return m ? `换上 ${NAMES_OF(data, "species", m.species).zh}` : id;
	};

	return {
		turn,
		phase: s.phase.phase,
		you: { active, party },
		opponent,
		opponent_remaining: s.enemyParty.length > 0 ? alive : null,
		opponent_party_size: s.enemyParty.length > 0 ? s.enemyParty.length : null,
		field: { weather: weatherName(s.weather), your_side: sideNames(s.sideStatuses[0]), opponent_side: sideNames(s.sideStatuses[1]) },
		legal_actions: legal.map((id) => ({ id, label: labelOf(id) })),
		last_turn: messages,
	};
}
