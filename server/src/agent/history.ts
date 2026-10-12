// 上下文管理：每场战斗一个独立对话。
// 最近 K 回合（默认 30，基本等于整场）保留完整的"状态 + 模型选择"；更早的只压缩成"你选了什么 + 你当时读到的原文"，
// 不加任何计算出来的分析（不算伤害、不标克制）——怎么理解过去的回合是模型自己的事。

import type { ChatMessage } from "../llm/types.js";
import type { Observation } from "./observation.js";
import { formatStateMessage } from "./prompt.js";

interface Entry {
	turn: number;
	obs: Observation;
	label: string;
	answer: string;
}

export class BattleHistory {
	private readonly entries: Entry[] = [];

	constructor(private readonly keepFull = 30) {}

	reset(): void {
		this.entries.length = 0;
	}

	/** 记录一次已确定的决策（obs 是做决策时的观测）。 */
	record(obs: Observation, choice: string, label: string, reason: string): void {
		this.entries.push({ turn: obs.turn, obs, label, answer: JSON.stringify({ choice, reason }) });
	}

	/** 一行摘要：你选了什么 + 这个选择之后游戏给出的原文（取自下一次观测的 last_turn），不加任何分析。 */
	private summarize(i: number, next: Observation | null): string {
		const e = this.entries[i]!;
		const me = e.obs.you.active;
		let line = `T${e.turn}：${me.species} → ${e.label}`;
		const texts = (next?.last_turn ?? []).slice(0, 8);
		if (texts.length > 0) line += `｜之后读到：${texts.join(" / ")}`;
		return line;
	}

	/** 构造发给模型的消息（不含 system）：[更早回合摘要] + 最近 K 回合完整对话 + 当前状态。 */
	buildMessages(current: Observation): ChatMessage[] {
		const out: ChatMessage[] = [];
		const n = this.entries.length;
		const fullFrom = Math.max(0, n - this.keepFull);
		if (fullFrom > 0) {
			const lines: string[] = [];
			for (let i = 0; i < fullFrom; i++) lines.push(this.summarize(i, this.entries[i + 1]?.obs ?? current));
			out.push({ role: "user", content: `【更早回合摘要】\n${lines.join("\n")}` });
		}
		for (let i = fullFrom; i < n; i++) {
			const e = this.entries[i]!;
			out.push(formatStateMessage(e.obs), { role: "assistant", content: e.answer });
		}
		out.push(formatStateMessage(current));
		return out;
	}

	get length(): number {
		return this.entries.length;
	}
}
