// Prompt 构造。组成（模板变量均可在 UI 编辑）：
//   系统消息 = base_prompt + rules_hint（可开关，默认关）+ output_instructions
//   每回合用户消息 = history 摘要 + 当前观测 JSON
// 观测里不含任何参考资料（属性表/种族值/伤害计算）；这些只作为显式对照开关。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { ChatMessage } from "../llm/types.js";
import type { Observation } from "./observation.js";

export interface PromptPreset {
	name: string;
	base_prompt: string;
	output_instructions: string;
}

export interface PromptConfig {
	preset: PromptPreset;
	/** 第 3 世代规则提示，评测变量，默认关 */
	rulesHint: boolean;
	rulesHintText?: string;
}

export function loadPreset(name = "default"): PromptPreset {
	return JSON.parse(readFileSync(resolve(ROOT, "data/prompts", `${name}.json`), "utf8")) as PromptPreset;
}

export function loadRulesHint(): string {
	return readFileSync(resolve(ROOT, "data/rules_hint.md"), "utf8").trim();
}

export function buildSystemMessage(cfg: PromptConfig): ChatMessage {
	const parts = [cfg.preset.base_prompt.trim()];
	if (cfg.rulesHint) parts.push(`【规则提示】${(cfg.rulesHintText ?? loadRulesHint()).trim()}`);
	parts.push(cfg.preset.output_instructions.trim());
	return { role: "system", content: parts.join("\n\n") };
}

export function formatStateMessage(obs: Observation): ChatMessage {
	return { role: "user", content: `当前状态（第 ${obs.turn} 回合）：\n${JSON.stringify(obs)}` };
}

/** 重试时给模型的纠错反馈 */
export function retryFeedback(error: string): ChatMessage {
	return { role: "user", content: `你的上一条回复无法使用：${error}\n请重新判断，并在最后一行只输出一个 JSON：{"choice":"<legal_actions 里的 id>","reason":"<一句话理由>"}` };
}
