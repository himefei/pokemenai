// LLM 策略：prompt 构造 -> 调模型 -> 宽松解析 -> 校验在 legal_actions 内 -> 格式/选择错误带错误信息重试（默认最多 2 次，计入格式失败率）。
// 超时 / 网络 / HTTP 错误 / 空回复不重试，直接报错（重发同样的内容只会再等一个超时）。
// 没有兜底：重试耗尽就抛 PolicyFailure，如实报错退出——模型出错本身就是测试的一部分。

import type { ActionId } from "../gen3/battle-state.js";
import type { LlmClient, LlmParams, ChatMessage } from "../llm/types.js";
import type { EventSink } from "./events.js";
import { BattleHistory } from "./history.js";
import { parseDecision } from "./parser.js";
import { PolicyFailure } from "./policy.js";
import type { Decision, DecisionContext, Policy } from "./policy.js";
import { buildSystemMessage, retryFeedback } from "./prompt.js";
import type { PromptConfig } from "./prompt.js";

export interface LlmPolicyOptions {
	client: LlmClient;
	model: string;
	params: LlmParams;
	prompt: PromptConfig;
	/** 保留完整对话的最近回合数（默认 6） */
	keepFull?: number;
	/** 格式/选择错误后带错误信息重试的次数（默认 2；0 = 不重试） */
	maxRetries?: number;
	sink?: EventSink;
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

	constructor(private readonly opts: LlmPolicyOptions) {
		this.history = new BattleHistory(opts.keepFull ?? 6);
	}

	/** 新的一场战斗：独立对话。 */
	reset(): void {
		this.history.reset();
	}

	/** 急停：取消正在进行的模型请求。 */
	cancel(): void {
		this.abort?.abort();
	}

	async decide(ctx: DecisionContext): Promise<Decision> {
		const { sink } = this.opts;
		const maxAttempts = (this.opts.maxRetries ?? 2) + 1;
		const legal: string[] = ctx.legal;
		const messages: ChatMessage[] = [buildSystemMessage(this.opts.prompt), ...this.history.buildMessages(ctx.observation)];
		const labelOf = (id: string) => ctx.observation.legal_actions.find((a) => a.id === id)?.label ?? id;
		let lastError = "";

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			sink?.({ type: "llm.request", turn: ctx.turn, attempt, model: this.opts.model, messages: messages.map((m) => ({ ...m })), ts: Date.now() });
			this.abort = new AbortController();
			this.stats.calls++;
			let content = "";
			try {
				const r = await this.opts.client.complete({
					messages,
					params: this.opts.params,
					signal: this.abort.signal,
					onDelta: (d) => sink?.({ type: "llm.delta", turn: ctx.turn, attempt, kind: d.kind, text: d.text }),
				});
				content = r.content;
				this.stats.inputTokens += r.usage.inputTokens ?? 0;
				this.stats.outputTokens += r.usage.outputTokens ?? 0;
				const parsed = parseDecision(r.content, legal);
				sink?.({ type: "llm.response", turn: ctx.turn, attempt, content: r.content, reasoning: r.reasoning, usage: r.usage, latencyMs: r.latencyMs, parseError: parsed.ok ? undefined : parsed.error });
				if (parsed.ok) {
					this.history.record(ctx.observation, parsed.choice, labelOf(parsed.choice), parsed.reason);
					sink?.({ type: "action.parsed", turn: ctx.turn, choice: parsed.choice, label: labelOf(parsed.choice), reason: parsed.reason, attempts: attempt });
					return { choice: parsed.choice as ActionId, reason: parsed.reason, meta: { attempts: attempt, latencyMs: r.latencyMs, usage: r.usage, reasoning: r.reasoning } };
				}
				lastError = parsed.error;
				this.stats.formatFailures++;
				messages.push({ role: "assistant", content: r.content || "(空回复)" }, retryFeedback(parsed.error));
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
