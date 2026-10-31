// 控制器 / 策略向外（WebSocket、日志）广播的事件。

import type { ExecResult } from "../emulator/input-executor.js";
import type { Observation } from "./observation.js";
import type { ChatMessage } from "../llm/types.js";
import type { ContextMode } from "./context.js";

export type ControllerState = "idle" | "armed" | "waiting" | "deciding" | "executing" | "paused" | "needs_human" | "finished";

export interface BattleSummary {
	battle: number;
	outcome: number;
	outcomeName: string;
	turns: number;
	decisions: number;
	rejections: number;
	nudges: number;
	frames: number;
	partyAlive: number;
	rngSeed: number | null;
}

export type AgentEvent =
	| { type: "emu.status"; connected: boolean; romOk: boolean; gameCode?: string; frame?: number; message?: string }
	| { type: "controller.state"; state: ControllerState; detail?: string }
	| { type: "phase"; phase: string; reason: string; forced: boolean; frame: number }
	| { type: "battle.state"; turn: number; observation: Observation; truth: unknown }
	| { type: "battle.text"; frame: number; text: string }
	| { type: "turn.start"; turn: number }
	/** 一次接管开始时发一次：上下文的管理方式和这个模型的窗口大小（max 为 null = 没识别到） */
	| { type: "context.info"; mode: ContextMode; max: number | null; source: string }
	| {
			type: "llm.request";
			turn: number;
			attempt: number;
			model: string;
			/** 完整对话（后端保存对话时也是完整的——日志里看到的永远是模型实际拥有的全部上下文） */
			messages: ChatMessage[];
			/** 发出请求的时间（毫秒时间戳），UI 用来显示"已等待 X 秒" */
			ts?: number;
			/** 这次请求实际发出去的消息条数（后端保存对话时只发新消息，比 messages.length 少） */
			sent?: number;
	  }
	| { type: "llm.delta"; turn: number; attempt: number; kind: "content" | "reasoning"; text: string }
	| {
			type: "llm.response";
			turn: number;
			attempt: number;
			content: string;
			reasoning: string;
			usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
			latencyMs: number;
			parseError?: string;
			/** 上下文方面的异常提示（例如连续会话里 prompt_tokens 没有增长——后端可能悄悄截断了） */
			warning?: string;
	  }
	| { type: "action.parsed"; turn: number; choice: string; label: string; reason: string; attempts: number }
	| { type: "action.confirm"; turn: number; choice: string; label: string }
	| { type: "action.executing"; turn: number; choice: string; label: string }
	| { type: "action.done"; turn: number; choice: string; result: ExecResult }
	| { type: "battle.end"; result: BattleSummary }
	| { type: "error"; message: string };

export type EventSink = (e: AgentEvent) => void;
