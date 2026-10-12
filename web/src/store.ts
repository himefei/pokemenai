// 事件 -> 界面状态。纯函数 reduce：实时 WebSocket 和历史回放（读 run 的 JSONL）共用同一套。

import type { AgentEvent, BattleSummary, ChatMessage, ControllerState, EmuStatus, ExecResult, Observation } from "./types";

export interface Attempt {
	n: number;
	model?: string;
	messages: ChatMessage[];
	reasoning: string;
	content: string;
	streaming: boolean;
	/** 请求发出的时间（毫秒时间戳）：界面据此显示“已等待 X 秒” */
	startedAt?: number;
	/** 这次调用失败了（超时 / HTTP 错误 / 空回复）：没有 llm.response，不会重试 */
	failed?: string;
	usage?: { inputTokens?: number; outputTokens?: number };
	latencyMs?: number;
	parseError?: string;
}

export interface TurnRecord {
	/** 全局递增序号（同一个回合号可能有"选招 + 强制换人"两次决策） */
	id: number;
	turn: number;
	observation: Observation;
	truth: unknown;
	attempts: Attempt[];
	parsed?: { choice: string; label: string; reason: string; attempts: number };
	confirm?: { choice: string; label: string };
	executing?: { choice: string; label: string };
	exec?: ExecResult;
}

export interface AgentState {
	emu: EmuStatus | null;
	controller: { state: ControllerState; detail?: string };
	phase: { phase: string; reason: string; forced: boolean } | null;
	records: TurnRecord[];
	texts: Array<{ frame: number; text: string }>;
	summary: BattleSummary | null;
	errors: string[];
}

export const initialState: AgentState = {
	emu: null,
	controller: { state: "idle" },
	phase: null,
	records: [],
	texts: [],
	summary: null,
	errors: [],
};

const MAX_TEXTS = 300;

function patchLast(state: AgentState, turn: number, fn: (r: TurnRecord) => TurnRecord): AgentState {
	for (let i = state.records.length - 1; i >= 0; i--) {
		if (state.records[i]!.turn === turn) {
			const records = state.records.slice();
			records[i] = fn(records[i]!);
			return { ...state, records };
		}
	}
	return state;
}

function patchAttempt(r: TurnRecord, n: number, fn: (a: Attempt) => Attempt): TurnRecord {
	const attempts = r.attempts.slice();
	const i = attempts.findIndex((a) => a.n === n);
	if (i < 0) return r;
	attempts[i] = fn(attempts[i]!);
	return { ...r, attempts };
}

/** 模型调用中断（报错 / 被急停）：把还在“生成中”的尝试收尾，别让“已等待 N 秒”一直走下去 */
function settleStreaming(state: AgentState, failed?: string): AgentState {
	const last = state.records.at(-1);
	if (!last || !last.attempts.some((a) => a.streaming)) return state;
	const records = state.records.slice();
	records[records.length - 1] = { ...last, attempts: last.attempts.map((a) => (a.streaming ? { ...a, streaming: false, failed } : a)) };
	return { ...state, records };
}

export function reduce(state: AgentState, e: AgentEvent): AgentState {
	switch (e.type) {
		case "emu.status":
			return { ...state, emu: { connected: e.connected, romOk: e.romOk, gameCode: e.gameCode, frame: e.frame, message: e.message } };
		case "controller.state":
			if (e.state !== "deciding" && state.controller.state === "deciding") state = settleStreaming(state, e.state === "needs_human" ? undefined : "已中断");
			return { ...state, controller: { state: e.state, detail: e.detail }, errors: e.state === "waiting" && state.controller.state !== "waiting" && state.controller.state !== "deciding" && state.controller.state !== "executing" ? [] : state.errors };
		case "phase":
			return { ...state, phase: { phase: e.phase, reason: e.reason, forced: e.forced } };
		case "battle.text":
			return { ...state, texts: [...state.texts, { frame: e.frame, text: e.text }].slice(-MAX_TEXTS) };
		case "battle.state": {
			// 新的一场（回合号回到 1 且已有记录）：清空上一场
			const fresh = e.turn <= 1 && state.records.length > 0 && state.records.at(-1)!.turn > 1;
			const base = fresh ? { ...state, records: [], texts: [], summary: null } : state;
			const rec: TurnRecord = { id: (base.records.at(-1)?.id ?? 0) + 1, turn: e.turn, observation: e.observation, truth: e.truth, attempts: [] };
			return { ...base, records: [...base.records, rec], summary: null };
		}
		case "llm.request":
			return patchLast(state, e.turn, (r) => ({ ...r, attempts: [...r.attempts.filter((a) => a.n !== e.attempt), { n: e.attempt, model: e.model, messages: e.messages, reasoning: "", content: "", streaming: true, startedAt: e.ts }] }));
		case "llm.delta":
			return patchLast(state, e.turn, (r) => patchAttempt(r, e.attempt, (a) => (e.kind === "reasoning" ? { ...a, reasoning: a.reasoning + e.text } : { ...a, content: a.content + e.text })));
		case "llm.response":
			return patchLast(state, e.turn, (r) => patchAttempt(r, e.attempt, (a) => ({ ...a, reasoning: e.reasoning || a.reasoning, content: e.content || a.content, streaming: false, usage: e.usage, latencyMs: e.latencyMs, parseError: e.parseError })));
		case "action.parsed":
			return patchLast(state, e.turn, (r) => ({ ...r, parsed: { choice: e.choice, label: e.label, reason: e.reason, attempts: e.attempts } }));
		case "action.confirm":
			return patchLast(state, e.turn, (r) => ({ ...r, confirm: { choice: e.choice, label: e.label } }));
		case "action.executing":
			return patchLast(state, e.turn, (r) => ({ ...r, confirm: undefined, executing: { choice: e.choice, label: e.label } }));
		case "action.done":
			return patchLast(state, e.turn, (r) => ({ ...r, executing: undefined, exec: e.result }));
		case "battle.end":
			return { ...state, summary: e.result };
		case "error":
			return { ...settleStreaming(state, e.message), errors: [...state.errors, e.message].slice(-20) };
		default:
			return state;
	}
}

export function foldEvents(events: AgentEvent[], from: AgentState = initialState): AgentState {
	return events.reduce(reduce, from);
}

// ---- 时间线 ----

export interface TimelineRow {
	id: number;
	turn: number;
	me: string;
	action: string;
	oppBefore: number;
	oppAfter: number | null;
	meHp: string;
	status: "ok" | "rejected" | "pending" | "failed";
}

/** 每个决策一行：我方动作 + 对手 HP 变化（用下一次观测补出结果）。 */
export function buildTimeline(records: TurnRecord[]): TimelineRow[] {
	return records.map((r, i) => {
		const next = records[i + 1]?.observation;
		const me = r.observation.you.active;
		const opp = r.observation.opponent;
		const sameOpp = next && next.opponent.species === opp.species;
		return {
			id: r.id,
			turn: r.turn,
			me: me.species,
			action: r.parsed?.label ?? "…",
			oppBefore: opp.hp_percent,
			oppAfter: next ? (sameOpp ? next.opponent.hp_percent : null) : null,
			meHp: next && next.you.active.species === me.species ? `${me.hp}→${next.you.active.hp}` : `${me.hp}`,
			status: r.exec ? (r.exec.ok ? "ok" : r.exec.reason === "rejected" ? "rejected" : "failed") : "pending",
		};
	});
}
