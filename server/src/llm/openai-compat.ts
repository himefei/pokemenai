// OpenAI 兼容 /v1/chat/completions：LM Studio / Ollama / llama.cpp / vLLM / 各类云端。

import { LlmError, deepMerge } from "./types.js";
import type { LlmClient, LlmCompletion, LlmRequest, ProviderConfig } from "./types.js";
import { ThinkRouter, readSse } from "./sse.js";

export class OpenAiCompatClient implements LlmClient {
	constructor(private readonly cfg: ProviderConfig) {}

	async complete(req: LlmRequest): Promise<LlmCompletion> {
		const { params } = req;
		const t0 = performance.now();
		let body: Record<string, unknown> = {
			model: this.cfg.model,
			messages: req.messages,
			stream: true,
			stream_options: { include_usage: true },
		};
		if (params.temperature !== undefined) body.temperature = params.temperature;
		if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
		if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
		body = deepMerge(body, params.extraBody);

		const headers: Record<string, string> = { "content-type": "application/json", ...(params.extraHeaders ?? {}) };
		if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(new LlmError(`请求超时（${params.timeoutMs ?? 120000}ms）`)), params.timeoutMs ?? 120000);
		const onAbort = () => ctrl.abort(req.signal?.reason);
		req.signal?.addEventListener("abort", onAbort);

		try {
			const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
			if (!res.ok) throw new LlmError(`HTTP ${res.status}`, res.status, (await res.text()).slice(0, 500));
			const ct = res.headers.get("content-type") ?? "";
			if (!res.body) throw new LlmError("响应没有 body");

			let content = "";
			let reasoning = "";
			const usage: LlmCompletion["usage"] = {};
			let finishReason: string | undefined;
			const router = new ThinkRouter();
			const rawTail: string[] = []; // 最后几条原始数据，空回复时用来排查
			const emit = (kind: "content" | "reasoning", text: string) => {
				if (!text) return;
				if (kind === "content") content += text;
				else reasoning += text;
				req.onDelta?.({ kind, text });
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
					if (j.usage) {
						usage.inputTokens = j.usage.prompt_tokens ?? usage.inputTokens;
						usage.outputTokens = j.usage.completion_tokens ?? usage.outputTokens;
					}
					const choice = j.choices?.[0];
					if (!choice) continue;
					const d = choice.delta ?? {};
					const r = d.reasoning_content ?? d.reasoning;
					if (typeof r === "string") emit("reasoning", r);
					if (typeof d.content === "string") for (const p of router.feed(d.content)) emit(p.kind, p.text);
					if (choice.finish_reason) finishReason = choice.finish_reason;
				}
				for (const p of router.flush()) emit(p.kind, p.text);
			} else {
				// 服务端忽略了 stream：按普通 JSON 解析
				const j: any = await res.json();
				const msg = j.choices?.[0]?.message ?? {};
				const r = msg.reasoning_content ?? msg.reasoning;
				if (typeof r === "string") emit("reasoning", r);
				if (typeof msg.content === "string") {
					const r2 = new ThinkRouter();
					for (const p of [...r2.feed(msg.content), ...r2.flush()]) emit(p.kind, p.text);
				}
				usage.inputTokens = j.usage?.prompt_tokens;
				usage.outputTokens = j.usage?.completion_tokens;
				finishReason = j.choices?.[0]?.finish_reason;
			}
			if (!content.trim() && !reasoning.trim()) {
				// 流正常结束但什么都没有：如实报出来（附上服务端最后几条原始数据），不要当成"格式错误"糊弄过去
				throw new LlmError(`endpoint 返回了空回复（finish_reason=${finishReason ?? "无"}，usage=${JSON.stringify(usage)}）${rawTail.length ? `；最后的原始数据：${rawTail.join(" | ")}` : "；流里没有任何数据"}`);
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
