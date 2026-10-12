// 所有"决策者"（随机 / 贪心 / LLM）共用的接口。

import type { ActionId, BattleSnapshot } from "../gen3/battle-state.js";
import type { Observation } from "./observation.js";

export interface DecisionContext {
	/** 完整内存快照（真值）。基线策略可以直接用；LLM 策略只会看到经过可见性过滤的观测。 */
	truth: BattleSnapshot;
	/** 经过可见性过滤的观测——LLM 策略只能用这个 */
	observation: Observation;
	legal: ActionId[];
	turn: number;
	mode: "action" | "forced_switch" | "prompt" | "prompt_switch";
}

export interface Decision {
	choice: ActionId;
	reason?: string;
	meta?: Record<string, unknown>;
}

export interface Policy {
	readonly name: string;
	decide(ctx: DecisionContext): Promise<Decision>;
	/** 新的一场战斗开始（LLM 策略据此清空对话历史） */
	reset?(): void;
}

/** 策略无法给出可执行的决策（LLM 重试耗尽且设置为 pause）。控制器据此进入 Paused / NeedsHuman。 */
export class PolicyFailure extends Error {
	constructor(
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
	}
}
