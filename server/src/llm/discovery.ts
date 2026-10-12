// 模型自发现：端点探测、模型列表、能力探测（尽力而为）。

import { ANTHROPIC_VERSION } from "./anthropic.js";
import type { ProviderConfig, ProviderKind } from "./types.js";

export interface ModelInfo {
	id: string;
	/** 能力标签（尽力而为）：vision / thinking / tools */
	tags: string[];
	/** 本地服务是否已加载（LM Studio 的 state） */
	loaded?: boolean;
	contextLength?: number;
}

export interface Endpoint {
	kind: ProviderKind;
	baseUrl: string;
	product: "lmstudio" | "ollama" | "llamacpp" | "vllm" | "openai-compat" | "anthropic";
	models: ModelInfo[];
}

/** 默认探测的本地端口 */
export const DEFAULT_LOCAL_PROBES: Array<{ port: number; product: Endpoint["product"] }> = [
	{ port: 1234, product: "lmstudio" },
	{ port: 11434, product: "ollama" },
	{ port: 8080, product: "llamacpp" },
	{ port: 8000, product: "vllm" },
];

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 500): Promise<any | null> {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("json")) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function postJson(url: string, body: unknown, timeoutMs = 1500): Promise<any | null> {
	try {
		const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

/** 列出一个 OpenAI 兼容端点的模型（Ollama 回退 /api/tags），并尽量补充能力标签。 */
export async function listOpenAiCompatModels(baseUrl: string, apiKey?: string, product?: Endpoint["product"], timeoutMs = 500): Promise<ModelInfo[] | null> {
	const base = baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
	let models: ModelInfo[] | null = null;

	const v1 = await getJson(`${base}/v1/models`, headers, timeoutMs);
	if (v1 && Array.isArray(v1.data)) models = v1.data.map((m: any) => ({ id: String(m.id), tags: [] }));

	if (!models && product === "ollama") {
		const tags = await getJson(`${base}/api/tags`, headers, timeoutMs);
		if (tags && Array.isArray(tags.models)) models = tags.models.map((m: any) => ({ id: String(m.name ?? m.model), tags: [] }));
	}
	if (!models) return null;

	// LM Studio：/api/v0/models 给出类型（llm / vlm）、加载状态、上下文长度
	if (product === "lmstudio") {
		const v0 = await getJson(`${base}/api/v0/models`, headers, timeoutMs);
		if (v0 && Array.isArray(v0.data)) {
			const byId = new Map<string, any>(v0.data.map((m: any) => [String(m.id), m]));
			for (const m of models) {
				const x = byId.get(m.id);
				if (!x) continue;
				if (x.type === "vlm") m.tags.push("vision");
				if (x.type === "embeddings") m.tags.push("embeddings");
				m.loaded = x.state === "loaded";
				m.contextLength = x.loaded_context_length ?? x.max_context_length;
			}
		}
	}
	// Ollama：/api/show 的 capabilities（vision / tools / thinking …）
	if (product === "ollama") {
		await Promise.all(
			models.map(async (m) => {
				const info = await postJson(`${base}/api/show`, { model: m.id });
				const caps: unknown = info?.capabilities;
				if (Array.isArray(caps)) for (const c of caps) if (["vision", "tools", "thinking"].includes(String(c))) m.tags.push(String(c));
			}),
		);
	}
	return models;
}

export async function listAnthropicModels(baseUrl: string, apiKey: string, timeoutMs = 5000): Promise<ModelInfo[] | null> {
	const j = await getJson(`${baseUrl.replace(/\/+$/, "")}/v1/models`, { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }, timeoutMs);
	if (!j || !Array.isArray(j.data)) return null;
	return j.data.map((m: any) => ({ id: String(m.id), tags: ["vision", "thinking"] }));
}

/** 按用户配置列模型（UI 里下拉框每次展开都会调用，因为本地服务会加载/卸载模型）。 */
export async function listModels(cfg: Pick<ProviderConfig, "kind" | "baseUrl" | "apiKey">, product?: Endpoint["product"]): Promise<ModelInfo[] | null> {
	return cfg.kind === "anthropic" ? listAnthropicModels(cfg.baseUrl, cfg.apiKey ?? "") : listOpenAiCompatModels(cfg.baseUrl, cfg.apiKey, product, 3000);
}

/** 并行探测本地常见端口（每个 500ms 超时），加上用户自定义的 baseUrl 列表。 */
export async function discoverLocalEndpoints(extraBaseUrls: string[] = [], host = "127.0.0.1"): Promise<Endpoint[]> {
	const candidates: Array<{ baseUrl: string; product: Endpoint["product"] }> = [
		...DEFAULT_LOCAL_PROBES.map((p) => ({ baseUrl: `http://${host}:${p.port}`, product: p.product })),
		...extraBaseUrls.map((baseUrl) => ({ baseUrl, product: "openai-compat" as const })),
	];
	const found = await Promise.all(
		candidates.map(async (c) => {
			const models = await listOpenAiCompatModels(c.baseUrl, undefined, c.product);
			const ep: Endpoint | null = models ? { kind: "openai-compat", baseUrl: c.baseUrl, product: c.product, models } : null;
			return ep;
		}),
	);
	return found.filter((x): x is Endpoint => x !== null);
}
