// 探测：这个后端的 /v1/responses 能不能真的把对话存在后端？
// 做法：第一轮让模型记住一个随机数，第二轮只发“那个数是多少”+ previous_response_id。能答对才算支持——
// 光是“接受了 previous_response_id 这个参数”不算（有的后端会悄悄忽略它）。

import { createClient } from "./factory.js";
import type { LlmParams, ProviderConfig } from "./types.js";

export interface StateProbeResult {
	supported: boolean;
	reason: string;
	latencyMs?: number;
}

export async function probeServerState(cfg: ProviderConfig, params: LlmParams = {}): Promise<StateProbeResult> {
	if (cfg.kind !== "openai-compat") return { supported: false, reason: "Anthropic Messages 没有“后端保存对话”的接口" };
	const client = createClient(cfg, "responses");
	const secret = String(1000 + Math.floor(Math.random() * 9000));
	// 和正式对局一样不带任何模型参数；超时用本地设置
	const p: LlmParams = { timeoutMs: params.timeoutMs };
	const t0 = performance.now();
	try {
		const first = [
			{ role: "system" as const, content: "你是一个简洁的助手。" },
			{ role: "user" as const, content: `请记住这个数字：${secret}。只回复“好”。` },
		];
		const r1 = await client.complete({ messages: first, params: p });
		if (!r1.responseId) return { supported: false, reason: "后端没有返回 response id，无法接着聊" };
		const second = [...first, { role: "assistant" as const, content: r1.content }, { role: "user" as const, content: "我让你记的数字是多少？只回答数字。" }];
		const r2 = await client.complete({ messages: second, chain: { previousResponseId: r1.responseId, sent: 3 }, params: p });
		const latencyMs = Math.round(performance.now() - t0);
		if (r2.content.includes(secret) || r2.reasoning.includes(secret)) return { supported: true, reason: `第二轮只发了新问题，模型答出了第一轮的数字 ${secret}`, latencyMs };
		return { supported: false, reason: `后端接受了 previous_response_id，但第二轮没能回忆起第一轮的内容（回答：${r2.content.slice(0, 40) || "空"}）——它没有真的保存对话`, latencyMs };
	} catch (e) {
		const err = e as Error & { body?: string };
		return { supported: false, reason: err.message + (err.body ? ` — ${err.body}` : "") };
	}
}
