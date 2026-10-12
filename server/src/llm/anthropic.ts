// Anthropic Messages API（流式）。支持 extended thinking 预算。

import { LlmError, deepMerge } from "./types.js";
import type { LlmClient, LlmCompletion, LlmRequest, ProviderConfig } from "./types.js";
import { readSse } from "./sse.js";

export const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicClient implements LlmClient {
	constructor(private readonly cfg: ProviderConfig) {}

	async complete(req: LlmRequest): Promise<LlmCompletion> {
		const { params } = req;
		const t0 = performance.now();
		const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
		const messages = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
		const thinking = params.thinkingBudget ? { type: "enabled", budget_tokens: params.thinkingBudget } : undefined;

		let body: Record<string, unknown> = {
			model: this.cfg.model,
			// Anthropic 接口要求必须带 max_tokens：没指定时给一个宽松的兜底，不去限制思考
			max_tokens: params.maxTokens ?? (thinking ? (params.thinkingBudget ?? 0) + 4096 : 8192),
			messages,
			stream: true,
		};
		if (system) body.system = system;
		if (thinking) body.thinking = thinking;
		// 开启 thinking 时 Anthropic 要求 temperature 为默认值，所以不发送
		else if (params.temperature !== undefined) body.temperature = params.temperature;
		body = deepMerge(body, params.extraBody);

		const headers: Record<string, string> = {
			"content-type": "application/json",
			"anthropic-version": ANTHROPIC_VERSION,
			...(params.extraHeaders ?? {}),
		};
		if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;

		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(new LlmError(`请求超时（${params.timeoutMs ?? 120000}ms）`)), params.timeoutMs ?? 120000);
		const onAbort = () => ctrl.abort(req.signal?.reason);
		req.signal?.addEventListener("abort", onAbort);

		try {
			const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
			if (!res.ok) throw new LlmError(`HTTP ${res.status}`, res.status, (await res.text()).slice(0, 500));
			if (!res.body) throw new LlmError("响应没有 body");

			let content = "";
			let reasoning = "";
			const usage: LlmCompletion["usage"] = {};
			let finishReason: string | undefined;

			for await (const ev of readSse(res.body)) {
				let j: any;
				try {
					j = JSON.parse(ev.data);
				} catch {
					continue;
				}
				switch (j.type) {
					case "message_start":
						usage.inputTokens = j.message?.usage?.input_tokens;
						break;
					case "content_block_delta": {
						const d = j.delta ?? {};
						if (d.type === "text_delta" && typeof d.text === "string") {
							content += d.text;
							req.onDelta?.({ kind: "content", text: d.text });
						} else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
							reasoning += d.thinking;
							req.onDelta?.({ kind: "reasoning", text: d.thinking });
						}
						break;
					}
					case "message_delta":
						usage.outputTokens = j.usage?.output_tokens ?? usage.outputTokens;
						finishReason = j.delta?.stop_reason ?? finishReason;
						break;
					case "error":
						throw new LlmError(`Anthropic 错误：${j.error?.message ?? ev.data}`);
				}
			}
			return { content: content.trim(), reasoning: reasoning.trim(), usage, latencyMs: performance.now() - t0, finishReason };
		} catch (e) {
			if (e instanceof LlmError) throw e;
			const reason = ctrl.signal.reason;
			if (reason instanceof LlmError) throw reason;
			if (req.signal?.aborted) throw new LlmError("已取消");
			throw new LlmError(`请求失败：${(e as Error).message}`);
		} finally {
			clearTimeout(timer);
			req.signal?.removeEventListener("abort", onAbort);
		}
	}
}
