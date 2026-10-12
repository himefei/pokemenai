// 测试用的合成快照：我方雷伊布在场，对手大狼犬 Lv46（真实招式 咬碎/吼叫/泼沙/舍身冲撞——观测里不能泄露）。
import { readFileSync } from "node:fs";
import { hexToBytes } from "../../src/emulator/protocol.js";
import type { BattleSnapshot } from "../../src/gen3/battle-state.js";
import { parseBattleMon, parsePartyMon } from "../../src/gen3/structs.js";
import type { PartyMon } from "../../src/gen3/structs.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/save_party.json", import.meta.url), "utf8")) as { mons: string[] };
export const party: PartyMon[] = fixture.mons.map((h) => parsePartyMon(hexToBytes(h)));

export function battleMonBytes(o: { species: number; level: number; hp: number; maxHp: number; moves: number[]; pp: number[]; types: [number, number]; ability?: number; item?: number; status1?: number; status2?: number; stats?: number[] }): Uint8Array {
	const b = new Uint8Array(0x58);
	const v = new DataView(b.buffer);
	v.setUint16(0, o.species, true);
	(o.stats ?? [100, 100, 100, 100, 100]).forEach((x, i) => v.setUint16(2 + i * 2, x, true));
	o.moves.forEach((m, i) => v.setUint16(0x0c + i * 2, m, true));
	b.set([6, 6, 6, 6, 6, 6, 6, 6], 0x18);
	b[0x20] = o.ability ?? 0;
	b[0x21] = o.types[0];
	b[0x22] = o.types[1];
	b.set(o.pp, 0x24);
	v.setUint16(0x28, o.hp, true);
	b[0x2a] = o.level;
	v.setUint16(0x2c, o.maxHp, true);
	v.setUint16(0x2e, o.item ?? 0, true);
	v.setUint32(0x4c, o.status1 ?? 0, true);
	v.setUint32(0x50, o.status2 ?? 0, true);
	return b;
}

export function snapshot(over: Partial<BattleSnapshot> = {}): BattleSnapshot {
	const enemy: PartyMon = { ...party[0]!, personality: 0xaaaa, species: 287, level: 46, hp: 100, maxHp: 134, moves: [242, 46, 28, 38], status: 0 };
	return {
		hb: {} as BattleSnapshot["hb"],
		phase: { phase: "action_menu", forced: false, reason: "" },
		player: parseBattleMon(battleMonBytes({ species: 135, level: 44, hp: 112, maxHp: 120, moves: [85, 24, 164, 86], pp: [15, 30, 10, 0], types: [13, 13], ability: 10, stats: [90, 80, 140, 120, 150] })), // 内存顺序：攻 防 速 特攻 特防
		opponent: parseBattleMon(battleMonBytes({ species: 287, level: 46, hp: 100, maxHp: 134, moves: [242, 46, 28, 38], pp: [15, 20, 15, 15], types: [17, 17], ability: 22, stats: [999, 999, 999, 999, 999] })),
		playerPartyIndex: 0,
		opponentPartyIndex: 0,
		party,
		enemyParty: [enemy, { ...enemy, personality: 0xbbbb, species: 332, hp: 150, maxHp: 150 }],
		lastMoves: [0, 0, 0, 0],
		weather: 0,
		sideStatuses: [0, 0],
		textBytes: new Uint8Array(),
		...over,
	};
}

