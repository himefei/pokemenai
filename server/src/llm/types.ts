// 模型层的统一接口。状态 -> prompt 的构造与 provider 无关。

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * 模型参数全部由 endpoint 自己的配置决定：本地不传、也不覆盖任何采样参数（temperature / top_k / min_p / max_tokens / 思考开关……）。
 * 这里只剩本地自己的行为：请求超时。
 */
export interface LlmParams {
	timeoutMs?: number;
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
	usage: { inputTokens?: number; outputTokens?: number; /** 后端报告的前缀缓存命中 token 数（有的后端不报） */ cachedTokens?: number };
	latencyMs: number;
	finishReason?: string;
	/** /v1/responses：这次回复的 id，下一次用 previous_response_id 接着聊 */
	responseId?: string;
}

export interface LlmRequest {
	/** 完整对话（日志、无状态接口都用它） */
	messages: ChatMessage[];
	/** 后端保存对话时（/v1/responses）：接着 previousResponseId 那次回复继续，只发 messages 里第 `sent` 条之后的新消息 */
	chain?: { previousResponseId: string; sent: number };
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
