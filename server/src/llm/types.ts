// 模型层的统一接口。状态 -> prompt 的构造与 provider 无关。

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LlmParams {
	temperature?: number;
	maxTokens?: number;
	/** OpenAI 兼容：reasoning_effort（low/medium/high…）；null/undefined 不发送 */
	reasoningEffort?: string | null;
	/** Anthropic：extended thinking 的 token 预算；null/undefined 关闭思考 */
	thinkingBudget?: number | null;
	timeoutMs?: number;
	/** 额外请求体 JSON，会深度合并到请求体（本地模型常用：chat_template_kwargs、response_format…） */
	extraBody?: Record<string, unknown>;
	extraHeaders?: Record<string, string>;
}

export interface LlmDelta {
	kind: "content" | "reasoning";
	text: string;
}

export interface LlmCompletion {
	/** 最终回答（已去掉 <think>…</think>） */
	content: string;
	/** 思考内容：reasoning_content / thinking 块 / <think> 标签里的文字 */
	reasoning: string;
	usage: { inputTokens?: number; outputTokens?: number };
	latencyMs: number;
	finishReason?: string;
}

export interface LlmRequest {
	messages: ChatMessage[];
	params: LlmParams;
	signal?: AbortSignal;
	onDelta?: (d: LlmDelta) => void;
}

export interface LlmClient {
	complete(req: LlmRequest): Promise<LlmCompletion>;
}

export type ProviderKind = "openai-compat" | "anthropic";

export interface ProviderConfig {
	kind: ProviderKind;
	/** 例如 http://127.0.0.1:1234（不含 /v1） */
	baseUrl: string;
	apiKey?: string;
	model: string;
}

export class LlmError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: string,
	) {
		super(message);
	}
}

export function deepMerge<T extends Record<string, unknown>>(a: T, b: Record<string, unknown> | undefined): T {
	if (!b) return a;
	const out: Record<string, unknown> = { ...a };
	for (const [k, v] of Object.entries(b)) {
		const cur = out[k];
		out[k] =
			v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
				? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
				: v;
	}
	return out as T;
}
