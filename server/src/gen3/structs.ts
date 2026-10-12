// Gen 3 内存结构的字段偏移与解析。地址只在 data/symbols/，偏移只在这个文件。
// 布局以 pret/pokeemerald include/{battle,pokemon,main,party_menu}.h 为准。

import { decodeGen3String } from "./charmap.js";
import { decryptSubstructs } from "./decrypt.js";

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function dv(b: Uint8Array): DataView {
	return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
const u8 = (b: Uint8Array, o: number) => b[o]!;
const s8 = (b: Uint8Array, o: number) => dv(b).getInt8(o);
const u16 = (b: Uint8Array, o: number) => dv(b).getUint16(o, true);
const u32 = (b: Uint8Array, o: number) => dv(b).getUint32(o, true);

export interface Stats5 {
	atk: number;
	def: number;
	spe: number;
	spa: number;
	spd: number;
}

export interface Ivs {
	hp: number;
	atk: number;
	def: number;
	spe: number;
	spa: number;
	spd: number;
	isEgg: boolean;
	abilityNum: number;
}

function parseIvWord(w: number): Ivs {
	return {
		hp: w & 31,
		atk: (w >>> 5) & 31,
		def: (w >>> 10) & 31,
		spe: (w >>> 15) & 31,
		spa: (w >>> 20) & 31,
		spd: (w >>> 25) & 31,
		isEgg: ((w >>> 30) & 1) === 1,
		abilityNum: (w >>> 31) & 1,
	};
}

// ---------------------------------------------------------------------------
// gMain
// ---------------------------------------------------------------------------

export const MAIN = {
	callback1: 0x000,
	callback2: 0x004,
	savedCallback: 0x008,
	heldKeys: 0x02c,
	newKeys: 0x02e,
	/** u8 位域：bit0 oamLoadDisabled, bit1 inBattle */
	flags: 0x439,
	/** 只需要读到 flags，不必读完整个 0x43C 的 oamBuffer */
	readLen: 0x43a,
} as const;

export const MAIN_IN_BATTLE_MASK = 0x02;

export interface MainState {
	callback1: number;
	callback2: number;
	savedCallback: number;
	heldKeys: number;
	newKeys: number;
	inBattle: boolean;
}

export function parseMain(b: Uint8Array): MainState {
	return {
		callback1: u32(b, MAIN.callback1),
		callback2: u32(b, MAIN.callback2),
		savedCallback: u32(b, MAIN.savedCallback),
		heldKeys: u16(b, MAIN.heldKeys),
		newKeys: u16(b, MAIN.newKeys),
		inBattle: (u8(b, MAIN.flags) & MAIN_IN_BATTLE_MASK) !== 0,
	};
}

// ---------------------------------------------------------------------------
// BattlePokemon（gBattleMons[i]，已解密，每个 0x58 字节）
// ---------------------------------------------------------------------------

export const BATTLE_MON_SIZE = 0x58;

export const BM = {
	species: 0x00,
	attack: 0x02,
	defense: 0x04,
	speed: 0x06,
	spAttack: 0x08,
	spDefense: 0x0a,
	moves: 0x0c,
	ivs: 0x14,
	statStages: 0x18,
	ability: 0x20,
	types: 0x21,
	pp: 0x24,
	hp: 0x28,
	level: 0x2a,
	friendship: 0x2b,
	maxHp: 0x2c,
	item: 0x2e,
	nickname: 0x30,
	nicknameLen: 11,
	ppBonuses: 0x3b,
	experience: 0x44,
	personality: 0x48,
	status1: 0x4c,
	status2: 0x50,
	otId: 0x54,
} as const;

/** statStages 的下标；6 为 0 级 */
export const STAGE_INDEX = { hp: 0, atk: 1, def: 2, spe: 3, spa: 4, spd: 5, acc: 6, eva: 7 } as const;
export const NEUTRAL_STAGE = 6;

export interface StatStages {
	atk: number;
	def: number;
	spa: number;
	spd: number;
	spe: number;
	acc: number;
	eva: number;
}

export interface BattleMon {
	species: number;
	stats: Stats5;
	moves: [number, number, number, number];
	pp: [number, number, number, number];
	ivs: Ivs;
	/** 已减去 6 的能力等级（-6..+6） */
	stages: StatStages;
	ability: number;
	types: [number, number];
	hp: number;
	maxHp: number;
	level: number;
	friendship: number;
	item: number;
	nickname: string;
	experience: number;
	personality: number;
	otId: number;
	status1: number;
	status2: number;
}

function quad16(b: Uint8Array, o: number): [number, number, number, number] {
	return [u16(b, o), u16(b, o + 2), u16(b, o + 4), u16(b, o + 6)];
}
function quad8(b: Uint8Array, o: number): [number, number, number, number] {
	return [u8(b, o), u8(b, o + 1), u8(b, o + 2), u8(b, o + 3)];
}

export function parseBattleMon(b: Uint8Array): BattleMon {
	if (b.length < BATTLE_MON_SIZE) throw new Error(`BattlePokemon needs ${BATTLE_MON_SIZE} bytes, got ${b.length}`);
	const st = (i: number) => s8(b, BM.statStages + i) - NEUTRAL_STAGE;
	return {
		species: u16(b, BM.species),
		stats: { atk: u16(b, BM.attack), def: u16(b, BM.defense), spe: u16(b, BM.speed), spa: u16(b, BM.spAttack), spd: u16(b, BM.spDefense) },
		moves: quad16(b, BM.moves),
		pp: quad8(b, BM.pp),
		ivs: parseIvWord(u32(b, BM.ivs)),
		stages: { atk: st(STAGE_INDEX.atk), def: st(STAGE_INDEX.def), spa: st(STAGE_INDEX.spa), spd: st(STAGE_INDEX.spd), spe: st(STAGE_INDEX.spe), acc: st(STAGE_INDEX.acc), eva: st(STAGE_INDEX.eva) },
		ability: u8(b, BM.ability),
		types: [u8(b, BM.types), u8(b, BM.types + 1)],
		hp: u16(b, BM.hp),
		maxHp: u16(b, BM.maxHp),
		level: u8(b, BM.level),
		friendship: u8(b, BM.friendship),
		item: u16(b, BM.item),
		nickname: decodeGen3String(b.subarray(BM.nickname, BM.nickname + BM.nicknameLen)),
		experience: u32(b, BM.experience),
		personality: u32(b, BM.personality),
		otId: u32(b, BM.otId),
		status1: u32(b, BM.status1),
		status2: u32(b, BM.status2),
	};
}

// ---------------------------------------------------------------------------
// 状态位（constants/battle.h）
// ---------------------------------------------------------------------------

export const STATUS1 = {
	SLEEP_MASK: 0b111,
	POISON: 1 << 3,
	BURN: 1 << 4,
	FREEZE: 1 << 5,
	PARALYSIS: 1 << 6,
	TOXIC: 1 << 7,
	TOXIC_COUNTER_MASK: 0xf << 8,
} as const;

export type MajorStatus = "sleep" | "poison" | "toxic" | "burn" | "freeze" | "paralysis";

export function majorStatus(status1: number): MajorStatus | null {
	if (status1 & STATUS1.SLEEP_MASK) return "sleep";
	if (status1 & STATUS1.TOXIC) return "toxic";
	if (status1 & STATUS1.POISON) return "poison";
	if (status1 & STATUS1.BURN) return "burn";
	if (status1 & STATUS1.FREEZE) return "freeze";
	if (status1 & STATUS1.PARALYSIS) return "paralysis";
	return null;
}

export const STATUS2_FLAGS: ReadonlyArray<{ name: string; mask: number }> = [
	{ name: "confusion", mask: 0b111 },
	{ name: "flinched", mask: 1 << 3 },
	{ name: "uproar", mask: 0b111 << 4 },
	{ name: "bide", mask: 0b11 << 8 },
	{ name: "lock_confuse", mask: 0b11 << 10 },
	{ name: "multiple_turns", mask: 1 << 12 },
	{ name: "wrapped", mask: 0b111 << 13 },
	{ name: "infatuation", mask: 0xf << 16 },
	{ name: "focus_energy", mask: 1 << 20 },
	{ name: "transformed", mask: 1 << 21 },
	{ name: "recharge", mask: 1 << 22 },
	{ name: "rage", mask: 1 << 23 },
	{ name: "substitute", mask: 1 << 24 },
	{ name: "destiny_bond", mask: 1 << 25 },
	{ name: "escape_prevention", mask: 1 << 26 },
	{ name: "nightmare", mask: 1 << 27 },
	{ name: "cursed", mask: 1 << 28 },
	{ name: "foresight", mask: 1 << 29 },
	{ name: "defense_curl", mask: 1 << 30 },
	{ name: "torment", mask: 2 ** 31 },
];

export function volatileFlags(status2: number): string[] {
	return STATUS2_FLAGS.filter((f) => (status2 & f.mask) !== 0 || (f.mask === 2 ** 31 && status2 >>> 31 === 1)).map((f) => f.name);
}

// ---------------------------------------------------------------------------
// 队伍宝可梦（struct Pokemon，100 字节）
// ---------------------------------------------------------------------------

export const PARTY_MON_SIZE = 100;
export const PARTY_SIZE = 6;

export const PM = {
	personality: 0x00,
	otId: 0x04,
	nickname: 0x08,
	nicknameLen: 10,
	language: 0x12,
	flags: 0x13,
	otName: 0x14,
	markings: 0x1b,
	checksum: 0x1c,
	status: 0x50,
	level: 0x54,
	mail: 0x55,
	hp: 0x56,
	maxHp: 0x58,
	attack: 0x5a,
	defense: 0x5c,
	speed: 0x5e,
	spAttack: 0x60,
	spDefense: 0x62,
} as const;

/** 子结构内偏移（解密后，每块 12 字节） */
const SUB = {
	G: { species: 0, heldItem: 2, experience: 4, ppBonuses: 8, friendship: 9 },
	A: { moves: 0, pp: 8 },
	E: { hpEv: 0 },
	M: { pokerus: 0, metLocation: 1, ivs: 4 },
} as const;

export interface PartyMon {
	personality: number;
	otId: number;
	nickname: string;
	/** 空槽（species=0）或坏蛋 */
	empty: boolean;
	isEgg: boolean;
	species: number;
	heldItem: number;
	experience: number;
	friendship: number;
	moves: [number, number, number, number];
	pp: [number, number, number, number];
	ppBonuses: number;
	evs: { hp: number; atk: number; def: number; spe: number; spa: number; spd: number };
	ivs: Ivs;
	status: number;
	level: number;
	hp: number;
	maxHp: number;
	stats: Stats5;
	/** 解密后的 checksum 与盒子结构里存的是否一致；不一致说明读到了写到一半的数据或垃圾 */
	checksumValid: boolean;
}

export function parsePartyMon(b: Uint8Array): PartyMon {
	if (b.length < PARTY_MON_SIZE) throw new Error(`Pokemon needs ${PARTY_MON_SIZE} bytes, got ${b.length}`);
	const s = decryptSubstructs(b);
	const G = s.G;
	const A = s.A;
	const E = s.E;
	const M = s.M;
	const species = u16(G, SUB.G.species);
	const ivs = parseIvWord(u32(M, SUB.M.ivs));
	return {
		personality: u32(b, PM.personality),
		otId: u32(b, PM.otId),
		nickname: decodeGen3String(b.subarray(PM.nickname, PM.nickname + PM.nicknameLen)),
		empty: species === 0,
		isEgg: ivs.isEgg,
		species,
		heldItem: u16(G, SUB.G.heldItem),
		experience: u32(G, SUB.G.experience),
		friendship: u8(G, SUB.G.friendship),
		moves: quad16(A, SUB.A.moves),
		pp: quad8(A, SUB.A.pp),
		ppBonuses: u8(G, SUB.G.ppBonuses),
		evs: { hp: u8(E, 0), atk: u8(E, 1), def: u8(E, 2), spe: u8(E, 3), spa: u8(E, 4), spd: u8(E, 5) },
		ivs,
		status: u32(b, PM.status),
		level: u8(b, PM.level),
		hp: u16(b, PM.hp),
		maxHp: u16(b, PM.maxHp),
		stats: { atk: u16(b, PM.attack), def: u16(b, PM.defense), spe: u16(b, PM.speed), spa: u16(b, PM.spAttack), spd: u16(b, PM.spDefense) },
		checksumValid: s.checksum === u16(b, PM.checksum),
	};
}

export function parseParty(bytes: Uint8Array, count: number): PartyMon[] {
	const n = Math.min(count, PARTY_SIZE);
	const out: PartyMon[] = [];
	for (let i = 0; i < n; i++) out.push(parsePartyMon(bytes.subarray(i * PARTY_MON_SIZE, (i + 1) * PARTY_MON_SIZE)));
	return out;
}

// ---------------------------------------------------------------------------
// gPartyMenu（20 字节）
// ---------------------------------------------------------------------------

export const PARTY_MENU = {
	exitCallback: 0x00,
	task: 0x04,
	/** 低 4 位 menuType，随后 2 位 layout */
	typeAndLayout: 0x08,
	slotId: 0x09,
	slotId2: 0x0a,
	action: 0x0b,
	bagItem: 0x0c,
	data0: 0x0e,
	data1: 0x10,
} as const;

export interface PartyMenuState {
	exitCallback: number;
	task: number;
	menuType: number;
	layout: number;
	slotId: number;
	slotId2: number;
	action: number;
	bagItem: number;
	data: [number, number];
}

export function parsePartyMenu(b: Uint8Array): PartyMenuState {
	const tl = u8(b, PARTY_MENU.typeAndLayout);
	return {
		exitCallback: u32(b, PARTY_MENU.exitCallback),
		task: u32(b, PARTY_MENU.task),
		menuType: tl & 0xf,
		layout: (tl >>> 4) & 0x3,
		slotId: s8(b, PARTY_MENU.slotId),
		slotId2: s8(b, PARTY_MENU.slotId2),
		action: u8(b, PARTY_MENU.action),
		bagItem: u16(b, PARTY_MENU.bagItem),
		data: [dv(b).getInt16(PARTY_MENU.data0, true), dv(b).getInt16(PARTY_MENU.data1, true)],
	};
}

// constants/party_menu.h
export const PARTY_ACTION = { CHOOSE_MON: 0, SEND_OUT: 1, CANT_SWITCH: 2, ABILITY_PREVENTS: 4 } as const;
export const PARTY_MENU_TYPE_IN_BATTLE = 1;
/** 取消（Cancel）按钮对应的 slotId */
export const PARTY_SLOT_CANCEL = 7;

// ---------------------------------------------------------------------------
// Task（gTasks，每个 40 字节）
// ---------------------------------------------------------------------------

export const TASK_SIZE = 40;
export const TASK_COUNT = 16;
export const TASK = { func: 0x00, isActive: 0x04, prev: 0x05, next: 0x06, priority: 0x07, data: 0x08 } as const;

export interface TaskInfo {
	index: number;
	func: number;
	priority: number;
	data: number[];
}

export function parseActiveTasks(b: Uint8Array): TaskInfo[] {
	const out: TaskInfo[] = [];
	for (let i = 0; i < TASK_COUNT && (i + 1) * TASK_SIZE <= b.length; i++) {
		const t = b.subarray(i * TASK_SIZE, (i + 1) * TASK_SIZE);
		if (u8(t, TASK.isActive) === 0) continue;
		const data: number[] = [];
		for (let k = 0; k < 16; k++) data.push(dv(t).getInt16(TASK.data + k * 2, true));
		out.push({ index: i, func: u32(t, TASK.func), priority: u8(t, TASK.priority), data });
	}
	return out;
}

// ---------------------------------------------------------------------------
// 常量（constants/battle.h）
// ---------------------------------------------------------------------------

export const BATTLE_TYPE = {
	DOUBLE: 1 << 0,
	LINK: 1 << 1,
	TRAINER: 1 << 3,
	SAFARI: 1 << 7,
	TWO_OPPONENTS: 1 << 15,
} as const;

/** 战斗脚本指令（battle_script_commands.c 的 gBattleScriptingCommandsTable 下标） */
export const BATTLE_SCRIPT_OP = {
	/** "要不要换宝可梦？"之类的是/否框：光标在 gBattleCommunication[1]，0=是 1=否，B=否 */
	YESNOBOX: 0x67,
	/** "要不要学习新招式 / 忘掉哪个招式？" */
	YESNOBOX_LEARN_MOVE: 0x5a,
	YESNOBOX_STOP_LEARNING_MOVE: 0x5b,
} as const;

export const BATTLE_COMM = { state: 0, cursor: 1 } as const;

export const WEATHER = {
	RAIN: (1 << 0) | (1 << 1) | (1 << 2),
	SANDSTORM: (1 << 3) | (1 << 4),
	SUN: (1 << 5) | (1 << 6),
	HAIL: 1 << 7,
} as const;

export const SIDE_STATUS = {
	REFLECT: 1 << 0,
	LIGHT_SCREEN: 1 << 1,
	SPIKES: 1 << 4,
	SAFEGUARD: 1 << 5,
	FUTURE_ATTACK: 1 << 6,
	MIST: 1 << 8,
} as const;

export const BATTLE_OUTCOME = {
	NONE: 0,
	WON: 1,
	LOST: 2,
	DREW: 3,
	RAN: 4,
	PLAYER_TELEPORTED: 5,
	MON_FLED: 6,
	CAUGHT: 7,
	NO_SAFARI_BALLS: 8,
	FORFEITED: 9,
	MON_TELEPORTED: 10,
} as const;
