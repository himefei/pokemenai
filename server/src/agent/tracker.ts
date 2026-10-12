// 对手信息追踪：人类玩家一场战斗里会"记住"什么，这里就记什么。
//   - 对手用过的招式（gLastMoves 暴露；其余槽位未知）
//   - 被战斗文字揭示的特性 / 持有物（"Foe X's Intimidate …"）
//   - 已出场的对手宝可梦（按 personality 区分，换下再上场不丢记录）
// 追踪对象是"这场战斗里看到过的东西"，不读取对手没有暴露的内存。

import type { BattleSnapshot } from "../gen3/battle-state.js";
import type { Gen3Data } from "../gen3/data.js";

export interface OpponentMemory {
	personality: number;
	species: number;
	/** 按首次暴露顺序 */
	knownMoves: number[];
	/** 特性名（英文，来自战斗文字）；未揭示为 null */
	ability: string | null;
	/** 持有物名（英文，来自战斗文字）；未揭示为 null */
	item: string | null;
}

/** 训练家在战斗中使用的消耗型道具（"Foe X's FULL RESTORE restored health!"），不是宝可梦的持有物。 */
const TRAINER_BATTLE_ITEM = /potion|full restore|full heal|revive|antidote|burn heal|ice heal|awakening|parlyz heal|elixir|ether|^x |guard spec|dire hit|poké ?ball|poke ?ball/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class BattleTracker {
	private readonly mons = new Map<number, OpponentMemory>();
	private abilityRes: Array<{ name: string; re: RegExp }> | null = null;
	private itemRes: Array<{ name: string; re: RegExp }> | null = null;

	constructor(private readonly data: Gen3Data) {}

	reset(): void {
		this.mons.clear();
	}

	/** 当前对手的记忆（首次出场时创建）。 */
	current(s: BattleSnapshot): OpponentMemory | null {
		const mon = s.enemyParty[s.opponentPartyIndex];
		if (!mon) return null;
		let m = this.mons.get(mon.personality);
		if (!m) {
			m = { personality: mon.personality, species: mon.species, knownMoves: [], ability: null, item: null };
			this.mons.set(mon.personality, m);
		}
		return m;
	}

	/** 已经见过的对手宝可梦数量（含当前）。 */
	seenCount(): number {
		return this.mons.size;
	}

	/**
	 * 用一次快照和这段时间读到的战斗文字更新记忆。
	 * 应在每次决策前调用（文字要在 busy 阶段持续采样后一起传入）。
	 */
	update(s: BattleSnapshot, messages: string[]): void {
		const m = this.current(s);
		if (!m) return;

		const last = s.lastMoves[1];
		if (last !== 0 && !m.knownMoves.includes(last)) m.knownMoves.push(last);

		for (const msg of messages) this.scanMessage(m, msg);
	}

	private scanMessage(m: OpponentMemory, msg: string): void {
		if (!/^foe\b/i.test(msg)) return; // 对手方的消息都以 "Foe <名字>" 开头
		const isMoveLine = /\bused\b.*!/i.test(msg);

		if (!m.ability) {
			this.abilityRes ??= this.buildNameRes((d) => d.abilityNames());
			for (const { name, re } of this.abilityRes) {
				if (re.test(msg)) {
					m.ability = name;
					break;
				}
			}
		}
		if (!m.item && !isMoveLine) {
			this.itemRes ??= this.buildNameRes((d) => d.itemNames());
			for (const { name, re } of this.itemRes) {
				if (re.test(msg)) {
					m.item = name;
					break;
				}
			}
		}
	}

	/** 长名字优先，避免 "Water Absorb" 被 "Water" 之类截断。 */
	private buildNameRes(source: (d: Gen3Data) => string[]): Array<{ name: string; re: RegExp }> {
		return source(this.data)
			.filter((n) => n.length >= 4 && !TRAINER_BATTLE_ITEM.test(n))
			.sort((a, b) => b.length - a.length)
			.map((name) => ({ name, re: new RegExp(`(?:'s|its)\\s+${escapeRe(name)}\\b`, "i") }));
	}
}
