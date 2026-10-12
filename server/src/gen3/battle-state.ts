// 从内存读出一次"决策快照"，并计算合法动作。读取与计算分开：snapshotFromMemory 是纯函数。

import type { EmulatorLink } from "../emulator/rpc.js";
import type { Heartbeat } from "../emulator/heartbeat.js";
import { readHeartbeat } from "../emulator/heartbeat.js";
import type { PhaseDetector, PhaseInfo } from "../emulator/phase.js";
import { BATTLE_MON_SIZE, PARTY_MON_SIZE, PARTY_SIZE, parseBattleMon, parseParty } from "./structs.js";
import type { BattleMon, PartyMon } from "./structs.js";
import type { SymbolTable } from "./symbols.js";

export interface BattleSnapshot {
	hb: Heartbeat;
	phase: PhaseInfo;
	/** gBattleMons[0]：我方场上宝可梦的真实当前状态（含变身/替身等） */
	player: BattleMon;
	/** gBattleMons[1] */
	opponent: BattleMon;
	/** gBattlerPartyIndexes[0]：我方场上宝可梦在 gPlayerParty 里的下标 */
	playerPartyIndex: number;
	opponentPartyIndex: number;
	party: PartyMon[];
	/** 敌方队伍里已有宝可梦的槽位（gEnemyPartyCount 战斗开始时不可靠，按 species 判断） */
	enemyParty: PartyMon[];
	/** gLastMoves[0..3]：各战斗位最近一次使用的招式（对手招式暴露的依据） */
	lastMoves: [number, number, number, number];
	/** gBattleWeather 位域 */
	weather: number;
	/** gSideStatuses[0]=我方 [1]=对方 */
	sideStatuses: [number, number];
	/** gDisplayedStringBattle 原始字节（战斗文字） */
	textBytes: Uint8Array;
}

export type ActionId = `move:${0 | 1 | 2 | 3}` | `switch:${number}` | "prompt:yes" | "prompt:no";

export type ParsedAction = { kind: "move"; slot: number } | { kind: "switch"; partyIndex: number } | { kind: "prompt"; yes: boolean };

export function parseActionId(id: string): ParsedAction {
	if (id === "prompt:yes") return { kind: "prompt", yes: true };
	if (id === "prompt:no") return { kind: "prompt", yes: false };
	const m = id.match(/^(move|switch):(\d+)$/);
	if (!m) throw new Error(`bad action id: ${id}`);
	return m[1] === "move" ? { kind: "move", slot: Number(m[2]) } : { kind: "switch", partyIndex: Number(m[2]) };
}

export async function readSnapshot(client: EmulatorLink, syms: SymbolTable, detector: PhaseDetector): Promise<BattleSnapshot> {
	const hb = await readHeartbeat(client, syms);
	const [mons, idx, party, enemy, lastMoves, weather, sides, text] = await client.read([
		{ addr: syms.addr("gBattleMons"), len: BATTLE_MON_SIZE * 2 },
		{ addr: syms.addr("gBattlerPartyIndexes"), len: 4 },
		{ addr: syms.addr("gPlayerParty"), len: PARTY_MON_SIZE * PARTY_SIZE },
		{ addr: syms.addr("gEnemyParty"), len: PARTY_MON_SIZE * PARTY_SIZE },
		{ addr: syms.addr("gLastMoves"), len: 8 },
		{ addr: syms.addr("gBattleWeather"), len: 2 },
		{ addr: syms.addr("gSideStatuses"), len: 4 },
		{ addr: syms.addr("gDisplayedStringBattle"), len: syms.size("gDisplayedStringBattle") },
	]);
	const u16at = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, true);
	const idxView = new DataView(idx!.buffer, idx!.byteOffset, idx!.byteLength);
	return {
		hb,
		phase: detector.classify(hb),
		player: parseBattleMon(mons!.subarray(0, BATTLE_MON_SIZE)),
		opponent: parseBattleMon(mons!.subarray(BATTLE_MON_SIZE, BATTLE_MON_SIZE * 2)),
		playerPartyIndex: idxView.getUint16(0, true),
		opponentPartyIndex: idxView.getUint16(2, true),
		party: parseParty(party!, hb.playerPartyCount),
		// gEnemyPartyCount 在战斗开始时并不可靠，按 6 个槽位的 species 判断
		enemyParty: parseParty(enemy!, PARTY_SIZE).filter((m) => !m.empty),
		lastMoves: [u16at(lastMoves!, 0), u16at(lastMoves!, 2), u16at(lastMoves!, 4), u16at(lastMoves!, 6)],
		weather: u16at(weather!, 0),
		sideStatuses: [u16at(sides!, 0), u16at(sides!, 2)],
		textBytes: text!,
	};
}

/**
 * 决策场景：
 *  - action        行动菜单：招式 + 主动换人
 *  - forced_switch 己方倒下后：只能换人
 *  - prompt        是/否框（典型：对手倒下、即将换上下一只时的"要不要换宝可梦？"）
 *  - prompt_switch 在是/否框里答"是"之后的换人菜单：只能换人
 */
export type ActionMode = "action" | "forced_switch" | "prompt" | "prompt_switch";

/**
 * 合法动作（只是"这个界面上你能做什么"，不带任何建议）：
 *  - 招式（仅 action）：槽位有招式且 PP>0（以场上真实状态 gBattleMons 为准）
 *  - 换人：队友未倒下、不是蛋、不是当前场上那只
 *  - 是/否（仅 prompt）：回答"是"之后还得有人可换，否则只有"否"
 * 被束缚/被禁用等运行期限制无法从内存直接判断，由执行器的 action_rejected 反馈再剔除。
 */
export function legalActions(s: Pick<BattleSnapshot, "player" | "party" | "playerPartyIndex">, mode: ActionMode = "action"): ActionId[] {
	const switches: ActionId[] = [];
	s.party.forEach((mon, i) => {
		if (mon.empty || mon.isEgg || mon.hp <= 0) return;
		if (i === s.playerPartyIndex && mon.hp > 0 && mode !== "forced_switch") return;
		switches.push(`switch:${i}`);
	});
	if (mode === "prompt") return switches.length > 0 ? ["prompt:yes", "prompt:no"] : ["prompt:no"];
	if (mode === "forced_switch" || mode === "prompt_switch") return switches;
	const out: ActionId[] = [];
	s.player.moves.forEach((mv, slot) => {
		if (mv !== 0 && s.player.pp[slot]! > 0) out.push(`move:${slot as 0 | 1 | 2 | 3}`);
	});
	return [...out, ...switches];
}
