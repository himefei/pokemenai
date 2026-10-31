// 自动识别“这个模型在这个后端上的上下文长度”。
// 同一个 endpoint 上不同模型的窗口可以不同（omlx 的 /v1/models 每个模型一项 max_model_len），所以一定按模型 id 取，不是按 endpoint 取。
// 识别不到就返回 max:null（界面会明说“未识别”，可以手动指定），不会编一个数字。

import { ANTHROPIC_VERSION } from "./anthropic.js";
import { contextFromModelEntry, getJson, positiveInt, postJson } from "./discovery.js";
import type { ProviderConfig } from "./types.js";

export interface ContextWindow {
	max: number | null;
	/** 这个数字是从哪里读到的（给人看的） */
	source: string;
}

const PROBE_MS = 3000;
const UNKNOWN: ContextWindow = { max: null, source: "后端没有报告这个模型的上下文长度" };

export async function detectContextWindow(cfg: Pick<ProviderConfig, "kind" | "baseUrl" | "apiKey" | "model">): Promise<ContextWindow> {
	const base = cfg.baseUrl.replace(/\/+$/, "");
	const model = cfg.model;
	if (!model) return { max: null, source: "还没有选模型" };

	if (cfg.kind === "anthropic") {
		const j = await getJson(`${base}/v1/models/${encodeURIComponent(model)}`, { "x-api-key": cfg.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION }, 5000);
		const n = positiveInt(j?.max_input_tokens);
		return n ? { max: n, source: "Anthropic /v1/models 的 max_input_tokens" } : UNKNOWN;
	}

	const headers: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};

	// 1) /v1/models：llama.cpp / vLLM / omlx / LM Studio 都会在这一项里给出信息
	const v1 = await getJson(`${base}/v1/models`, headers, PROBE_MS);
	const list: any[] = Array.isArray(v1?.data) ? v1.data : [];
	const entry = list.find((m) => m?.id === model);
	const fromEntry = contextFromModelEntry(entry);
	if (fromEntry) return { max: fromEntry.max, source: `/v1/models → ${fromEntry.field}` };

	// 2) LM Studio：/api/v0/models 有 loaded_context_length（实际加载的）和 max_context_length
	const v0 = await getJson(`${base}/api/v0/models`, headers, PROBE_MS);
	const lm = Array.isArray(v0?.data) ? contextFromModelEntry(v0.data.find((m: any) => m?.id === model)) : null;
	if (lm) return { max: lm.max, source: `LM Studio /api/v0/models → ${lm.field}` };

	// 3) llama.cpp：/props 的 n_ctx。它一次只服务一个模型，所以只在“列表里就是这个模型 / 只有一个模型”时采信
	if (entry || list.length === 1) {
		const props = await getJson(`${base}/props`, headers, PROBE_MS);
		const n = positiveInt(props?.default_generation_settings?.n_ctx ?? props?.n_ctx);
		if (n) return { max: n, source: "llama.cpp /props → n_ctx" };
	}

	// 4) Ollama：已加载的模型在 /api/ps 里有实际的 context_length；没加载就看 /api/show（num_ctx 参数，最后才是模型最大值）
	const ps = await getJson(`${base}/api/ps`, headers, PROBE_MS);
	const loaded = Array.isArray(ps?.models) ? ps.models.find((m: any) => m?.model === model || m?.name === model) : undefined;
	const psN = positiveInt(loaded?.context_length);
	if (psN) return { max: psN, source: "Ollama /api/ps → context_length（已加载）" };
	const show = await postJson(`${base}/api/show`, { model }, PROBE_MS);
	if (show) {
		const m = typeof show.parameters === "string" ? /^\s*num_ctx\s+(\d+)/m.exec(show.parameters) : null;
		if (m) return { max: Number(m[1]), source: "Ollama /api/show → num_ctx 参数" };
		const info = show.model_info && typeof show.model_info === "object" ? (show.model_info as Record<string, unknown>) : {};
		const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
		const n = key ? positiveInt(info[key]) : null;
		if (n) return { max: n, source: `Ollama /api/show → ${key}（模型最大值，实际加载的窗口可能更小）` };
	}
	return UNKNOWN;
}

export interface ResolvedContext {
	/** 从 endpoint 读到的（max 为 null = 没读到） */
	detected: ContextWindow;
	/** 手动后备值：只在 endpoint 没报告时才用 */
	fallback: number;
	/** 实际使用的窗口 */
	effective: { max: number; source: string };
	usedFallback: boolean;
}

/** 先从 endpoint 获取；读不到（不成功 / 后端没有这项信息）才用手动后备值。 */
export async function resolveContextWindow(cfg: Pick<ProviderConfig, "kind" | "baseUrl" | "apiKey" | "model">, fallback: number): Promise<ResolvedContext> {
	const detected = await detectContextWindow(cfg);
	if (detected.max) return { detected, fallback, effective: { max: detected.max, source: detected.source }, usedFallback: false };
	return { detected, fallback, effective: { max: fallback, source: `${detected.source}，使用手动后备值` }, usedFallback: true };
}
