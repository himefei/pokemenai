// OpenAI Responses API（/v1/responses，流式）。和 /v1/chat/completions 的区别：对话可以存在后端——
// 请求带 store:true，下一次只发新消息 + previous_response_id，后端自己接上前面的内容。
// 只有部分后端支持（omlx 支持；llama.cpp 的实现是无状态的，会明确拒绝 previous_response_id）。不支持就报错，不会悄悄换成整段重发。

import { LlmError } from "./types.js";
import type { LlmClient, LlmCompletion, LlmRequest, ProviderConfig } from "./types.js";
import { ThinkRouter, readSse } from "./sse.js";

export class OpenAiResponsesClient implements LlmClient {
	constructor(private readonly cfg: ProviderConfig) {}

	async complete(req: LlmRequest): Promise<LlmCompletion> {
		const { params, chain } = req;
		const t0 = performance.now();
		const fresh = chain ? req.messages.slice(chain.sent) : req.messages;
		if (fresh.length === 0) throw new LlmError("没有新消息可发送（接着上一次回复继续，却没有新的内容）");
		// 不带任何采样参数（由 endpoint 自己的配置决定）；store 是“后端保存对话”本身，不是模型参数
		const body: Record<string, unknown> = {
			model: this.cfg.model,
			input: fresh.map((m) => ({ role: m.role, content: m.content })),
			stream: true,
			store: true,
		};
		if (chain) body.previous_response_id = chain.previousResponseId;

		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(new LlmError(`请求超时（${params.timeoutMs ?? 120000}ms）`)), params.timeoutMs ?? 120000);
		const onAbort = () => ctrl.abort(req.signal?.reason);
		req.signal?.addEventListener("abort", onAbort);

		try {
			const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/responses`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
			if (!res.ok) throw new LlmError(`HTTP ${res.status}`, res.status, (await res.text()).slice(0, 500));
			const ct = res.headers.get("content-type") ?? "";
			if (!res.body) throw new LlmError("响应没有 body");

			let content = "";
			let reasoning = "";
			let responseId: string | undefined;
			const usage: LlmCompletion["usage"] = {};
			let finishReason: string | undefined;
			let streamed = false;
			const router = new ThinkRouter();
			const rawTail: string[] = [];
			const emit = (kind: "content" | "reasoning", text: string) => {
				if (!text) return;
				streamed = true;
				if (kind === "content") content += text;
				else reasoning += text;
				req.onDelta?.({ kind, text });
			};
			/** 完整的 response 对象（completed 事件里 / 非流式响应）：读 id、用量、结束原因；没流出任何文字时从 output 里取 */
			const absorb = (r: any) => {
				if (!r || typeof r !== "object") return;
				responseId = r.id ?? responseId;
				if (r.usage) {
					usage.inputTokens = r.usage.input_tokens ?? usage.inputTokens;
					usage.outputTokens = r.usage.output_tokens ?? usage.outputTokens;
					usage.cachedTokens = r.usage.input_tokens_details?.cached_tokens ?? usage.cachedTokens;
				}
				finishReason = r.incomplete_details?.reason ?? r.status ?? finishReason;
				if (!streamed && Array.isArray(r.output)) {
					for (const item of r.output) {
						if (item?.type === "reasoning") {
							for (const part of [...(item.content ?? []), ...(item.summary ?? [])]) if (typeof part?.text === "string") emit("reasoning", part.text);
						} else if (item?.type === "message") {
							for (const part of item.content ?? []) if (part?.type === "output_text" && typeof part.text === "string") for (const p of [...router.feed(part.text), ...router.flush()]) emit(p.kind, p.text);
						}
					}
				}
			};

			if (ct.includes("text/event-stream")) {
				for await (const ev of readSse(res.body)) {
					if (ev.data === "[DONE]") break;
					rawTail.push(ev.data.slice(0, 300));
					if (rawTail.length > 3) rawTail.shift();
					let j: any;
					try {
						j = JSON.parse(ev.data);
					} catch {
						continue;
					}
					switch (j.type ?? ev.event) {
						case "response.created":
						case "response.in_progress":
							responseId = j.response?.id ?? responseId;
							break;
						case "response.output_text.delta":
							if (typeof j.delta === "string") for (const p of router.feed(j.delta)) emit(p.kind, p.text);
							break;
						case "response.reasoning_text.delta":
						case "response.reasoning_summary_text.delta":
							if (typeof j.delta === "string") emit("reasoning", j.delta);
							break;
						case "response.completed":
						case "response.incomplete":
							absorb(j.response);
							break;
						case "response.failed":
							throw new LlmError(`后端报告这次回复失败：${j.response?.error?.message ?? ev.data.slice(0, 300)}`);
						case "error":
							throw new LlmError(`后端报错：${j.message ?? j.error?.message ?? ev.data.slice(0, 300)}`);
					}
				}
				for (const p of router.flush()) emit(p.kind, p.text);
			} else {
				// 服务端忽略了 stream：按普通 JSON 解析
				absorb(await res.json());
			}
			if (!content.trim() && !reasoning.trim()) {
				throw new LlmError(`endpoint 返回了空回复（status=${finishReason ?? "无"}，usage=${JSON.stringify(usage)}）${rawTail.length ? `；最后的原始数据：${rawTail.join(" | ")}` : "；流里没有任何数据"}`);
			}
			return { content: content.trim(), reasoning: reasoning.trim(), usage, latencyMs: performance.now() - t0, finishReason, responseId };
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
