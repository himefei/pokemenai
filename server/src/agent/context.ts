// 上下文的几种管理方式，以及“上下文快满了”的判断。

import type { ContextWindow } from "../llm/context-window.js";

/**
 * window            窗口 + 摘要：每回合重发 system + 最近 K 回合完整对话 + 更早回合的一行摘要（默认，行为和以前一致）
 * continuous        连续会话：一场战斗就是一个对话，只追加、不摘要、不丢弃；每次请求重发完整记录（前缀不变，后端的前缀缓存能命中）
 * continuous-server 连续会话 + 后端保存：用 /v1/responses 的 previous_response_id，后端记着前面的内容，每次只发新消息（仅部分后端支持）
 */
export type ContextMode = "window" | "continuous" | "continuous-server";
export const CONTEXT_MODES: readonly ContextMode[] = ["window", "continuous", "continuous-server"];

export type { ContextWindow };

/** 手动后备值的默认：后端没有报告（或读取失败）这个模型的上下文长度时才用它 */
export const DEFAULT_CONTEXT_WINDOW = 65535;

/** 预计下一次请求会超过窗口的这个比例就停下来报错（留出一点空间给模型输出），不等后端悄悄截断 */
export const CONTEXT_STOP_RATIO = 0.95;

/** 没有 tokenizer 时的粗估：中英文、JSON 混在一起，大约 2.5 个字符一个 token（偏保守） */
export const approxTokens = (s: string | number): number => Math.ceil((typeof s === "number" ? s : s.length) / 2.5);

export function contextFull(used: number, max: number): string {
	return `上下文快满了：预计下一次请求约 ${used} tokens，已经超过窗口 ${max} tokens 的 ${Math.round(CONTEXT_STOP_RATIO * 100)}%。继续发下去后端会悄悄截断前面的内容（或直接报错）。可以换更大窗口的模型、在设置里调大“手动后备值”（窗口是手动值时），或改用“窗口 + 摘要”模式。`;
}
