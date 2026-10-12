// 控制器 / 策略向外（WebSocket、日志）广播的事件。

import type { ExecResult } from "../emulator/input-executor.js";
import type { Observation } from "./observation.js";
import type { ChatMessage } from "../llm/types.js";

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
	| { type: "llm.request"; turn: number; attempt: number; model: string; messages: ChatMessage[]; /** 发出请求的时间（毫秒时间戳），UI 用来显示"已等待 X 秒" */ ts?: number }
	| { type: "llm.delta"; turn: number; attempt: number; kind: "content" | "reasoning"; text: string }
	| { type: "llm.response"; turn: number; attempt: number; content: string; reasoning: string; usage: { inputTokens?: number; outputTokens?: number }; latencyMs: number; parseError?: string }
	| { type: "action.parsed"; turn: number; choice: string; label: string; reason: string; attempts: number }
	| { type: "action.confirm"; turn: number; choice: string; label: string }
	| { type: "action.executing"; turn: number; choice: string; label: string }
	| { type: "action.done"; turn: number; choice: string; result: ExecResult }
	| { type: "battle.end"; result: BattleSummary }
	| { type: "error"; message: string };

export type EventSink = (e: AgentEvent) => void;
