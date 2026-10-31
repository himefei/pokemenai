// LLM 策略：prompt 构造 -> 调模型 -> 宽松解析 -> 校验在 legal_actions 内 -> 格式/选择错误带错误信息重试（默认最多 2 次，计入格式失败率）。
// 超时 / 网络 / HTTP 错误 / 空回复不重试，直接报错（重发同样的内容只会再等一个超时）。
// 没有兜底：重试耗尽就抛 PolicyFailure，如实报错退出——模型出错本身就是测试的一部分。
//
// 上下文有三种管理方式（见 context.ts）：window（窗口 + 摘要，默认）、continuous（整场战斗一个连续会话，只追加）、
// continuous-server（同上，但对话存在后端，每次只发新消息）。连续会话里每次请求的消息列表都是上一次的“前缀 + 新内容”，
// 所以也能拿来观察模型的上下文记忆 / 召回 / 污染。

import type { ActionId } from "../gen3/battle-state.js";
import type { ContextWindow } from "../llm/context-window.js";
import type { LlmClient, LlmParams, ChatMessage } from "../llm/types.js";
import { approxTokens, contextFull, CONTEXT_STOP_RATIO } from "./context.js";
import type { ContextMode } from "./context.js";
import type { EventSink } from "./events.js";
import { BattleHistory } from "./history.js";
import { parseDecision } from "./parser.js";
import { PolicyFailure } from "./policy.js";
import type { Decision, DecisionContext, Policy } from "./policy.js";
import { buildSystemMessage, formatStateMessage, retryFeedback } from "./prompt.js";
import type { PromptConfig } from "./prompt.js";

export interface LlmPolicyOptions {
	client: LlmClient;
	model: string;
	params: LlmParams;
	prompt: PromptConfig;
	/** 保留完整对话的最近回合数（默认 6；只用于 window 模式） */
	keepFull?: number;
	/** 格式/选择错误后带错误信息重试的次数（默认 2；0 = 不重试） */
	maxRetries?: number;
	sink?: EventSink;
	/** 上下文管理方式（默认 window） */
	contextMode?: ContextMode;
	/** 读出（识别或手动指定的）上下文长度；一次接管只调用一次。不给 = 不知道窗口多大，不做“快满了”检查 */
	resolveContext?: () => Promise<ContextWindow>;
}

export interface LlmStats {
	calls: number;
	formatFailures: number;
	inputTokens: number;
	outputTokens: number;
}

export class LlmPolicy implements Policy {
	readonly name = "llm";
	readonly history: BattleHistory;
	readonly stats: LlmStats = { calls: 0, formatFailures: 0, inputTokens: 0, outputTokens: 0 };
	private abort: AbortController | null = null;
	/** system 只构造一次：整场战斗里保持逐字不变（前缀缓存、连续会话都依赖这一点） */
	private readonly system: ChatMessage;
	private readonly mode: ContextMode;
	/** 连续会话的完整记录（不含 system）：只追加，一场战斗结束才清空 */
	private transcript: ChatMessage[] = [];
	/** 后端保存对话时：最近一次回复的 id，以及后端已经知道的消息条数（含 system 和那次回复） */
	private chain: { id: string; sent: number } | null = null;
	/** 最近一次请求：后端报告的 prompt 大小，和回复内容的字数 */
	private last: { input?: number; replyChars: number } | null = null;
	private context: ContextWindow | null = null;

	constructor(private readonly opts: LlmPolicyOptions) {
		this.history = new BattleHistory(opts.keepFull ?? 6);
		this.system = buildSystemMessage(opts.prompt);
		this.mode = opts.contextMode ?? "window";
	}

	private get continuous(): boolean {
		return this.mode !== "window";
	}

	/** 新的一场战斗：独立对话。 */
	reset(): void {
		this.history.reset();
		this.transcript = [];
		this.chain = null;
		this.last = null;
	}

	/** 急停：取消正在进行的模型请求。 */
	cancel(): void {
		this.abort?.abort();
	}

	/** 第一次决策时读出窗口大小并广播（之后界面据此画“已用 / 最大”）。识别不到不是错误：max 为 null，界面会写明。 */
	private async announceContext(): Promise<ContextWindow> {
		if (this.context) return this.context;
		let cw: ContextWindow = { max: null, source: "没有识别上下文长度" };
		if (this.opts.resolveContext) {
			try {
				cw = await this.opts.resolveContext();
			} catch (e) {
				cw = { max: null, source: `识别失败：${(e as Error).message}` };
			}
		}
		this.context = cw;
		this.opts.sink?.({ type: "context.info", mode: this.mode, max: cw.max, source: cw.source });
		return cw;
	}

	/** 下一次请求预计放不下就停（不等后端悄悄截断）。预计 = 上次后端报告的 prompt + 上次回复 + 这次新增的消息。 */
	private assertRoom(messages: ChatMessage[], cw: ContextWindow): void {
		if (cw.max === null) return;
		const added = approxTokens(messages.at(-1)!.content);
		const projected = this.last?.input !== undefined ? this.last.input + approxTokens(this.last.replyChars) + added : messages.reduce((n, m) => n + approxTokens(m.content), 0);
		if (projected > cw.max * CONTEXT_STOP_RATIO) throw new PolicyFailure(contextFull(Math.round(projected), cw.max), { projected: Math.round(projected), max: cw.max });
	}

	/** 连续会话是只追加的，后端报告的 prompt_tokens 必须越来越大；没变大就是前面的内容没算进去。 */
	private truncationWarning(input: number | undefined): string | undefined {
		const prev = this.last?.input;
		if (!this.continuous || input === undefined || prev === undefined || input > prev) return undefined;
		return `连续会话是只追加的，这次的 prompt_tokens（${input}）却没有比上一次（${prev}）更大。可能是后端悄悄截断/丢弃了前面的内容，也可能是它报告的用量不含命中缓存的部分——需要的话看后端日志核实。`;
	}

	async decide(ctx: DecisionContext): Promise<Decision> {
		const { sink } = this.opts;
		const maxAttempts = (this.opts.maxRetries ?? 2) + 1;
		const legal: string[] = ctx.legal;
		const cw = await this.announceContext();
		const state = formatStateMessage(ctx.observation);
		const messages: ChatMessage[] = this.continuous ? [this.system, ...this.transcript, state] : [this.system, ...this.history.buildMessages(ctx.observation)];
		/** 这次决策新增内容在 messages 里的起点（连续会话：决策成功后从这里起的消息整体追加进会话记录） */
		const turnStart = messages.length - 1;
		const labelOf = (id: string) => ctx.observation.legal_actions.find((a) => a.id === id)?.label ?? id;
		let lastError = "";

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			this.assertRoom(messages, cw);
			const chain = this.mode === "continuous-server" && this.chain ? { previousResponseId: this.chain.id, sent: this.chain.sent } : undefined;
			sink?.({ type: "llm.request", turn: ctx.turn, attempt, model: this.opts.model, messages: messages.map((m) => ({ ...m })), ts: Date.now(), sent: chain ? messages.length - chain.sent : messages.length });
			this.abort = new AbortController();
			this.stats.calls++;
			let content = "";
			try {
				const r = await this.opts.client.complete({
					messages,
					chain,
					params: this.opts.params,
					signal: this.abort.signal,
					onDelta: (d) => sink?.({ type: "llm.delta", turn: ctx.turn, attempt, kind: d.kind, text: d.text }),
				});
				content = r.content;
				this.stats.inputTokens += r.usage.inputTokens ?? 0;
				this.stats.outputTokens += r.usage.outputTokens ?? 0;
				if (this.mode === "continuous-server" && !r.responseId) throw new Error("后端没有返回 response id，无法用 previous_response_id 继续对话");
				const warning = this.truncationWarning(r.usage.inputTokens);
				this.last = { input: r.usage.inputTokens, replyChars: r.content.length };
				const parsed = parseDecision(r.content, legal);
				sink?.({ type: "llm.response", turn: ctx.turn, attempt, content: r.content, reasoning: r.reasoning, usage: r.usage, latencyMs: r.latencyMs, parseError: parsed.ok ? undefined : parsed.error, warning });
				// 模型的回复原样进入对话（连续会话里是逐字保留；格式错误的回复也算——它确实说过）
				messages.push({ role: "assistant", content: r.content || "(空回复)" });
				if (this.mode === "continuous-server") this.chain = { id: r.responseId!, sent: messages.length };
				if (parsed.ok) {
					if (this.continuous) this.transcript.push(...messages.slice(turnStart));
					this.history.record(ctx.observation, parsed.choice, labelOf(parsed.choice), parsed.reason);
					sink?.({ type: "action.parsed", turn: ctx.turn, choice: parsed.choice, label: labelOf(parsed.choice), reason: parsed.reason, attempts: attempt });
					return { choice: parsed.choice as ActionId, reason: parsed.reason, meta: { attempts: attempt, latencyMs: r.latencyMs, usage: r.usage, reasoning: r.reasoning } };
				}
				lastError = parsed.error;
				this.stats.formatFailures++;
				messages.push(retryFeedback(parsed.error));
			} catch (e) {
				if (this.abort.signal.aborted) throw new PolicyFailure("已取消");
				// 超时 / 网络错误 / HTTP 错误 / 空回复：把同一个 prompt 再发一遍没有任何意义（只会再等一个超时），
				// 如实报错。只有"模型回答了但格式不对"才会带着错误信息重试。
				const err = e as Error & { body?: string };
				const msg = err.message + (err.body ? ` — ${err.body}` : "");
				sink?.({ type: "llm.response", turn: ctx.turn, attempt, content, reasoning: "", usage: {}, latencyMs: 0, parseError: msg });
				throw new PolicyFailure(`模型调用失败（不重试）：${msg}`, { attempt, error: msg });
			}
		}

		throw new PolicyFailure(`模型 ${maxAttempts} 次尝试都没有给出可用决策：${lastError}`, { attempts: maxAttempts, lastError });
	}
}
