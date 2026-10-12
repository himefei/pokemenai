import { createContext, useContext } from "react";
import type { Preset, RunListItem, ModelInfo, ServerStatus, Settings, AgentEvent } from "./types";

export type SlotId = "a" | "b";

async function j<T>(res: Response): Promise<T> {
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
	return body as T;
}

const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => j<Record<string, unknown>>(r));
const put = (url: string, body?: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** 某个槽位（A / B）的接口；presets / runs / discover 是两个槽位共用的。 */
export function makeApi(slot: SlotId) {
	const s = `/api/s/${slot}`;
	return {
		slot,
		status: () => fetch(`${s}/status`).then((r) => j<ServerStatus>(r)),
		settings: () => fetch(`${s}/settings`).then((r) => j<Settings>(r)),
		saveSettings: (patch: { llm?: Partial<Settings["llm"]>; agent?: Partial<Settings["agent"]> }) => put(`${s}/settings`, patch).then((r) => j<Settings>(r)),
		models: (body: { kind?: string; baseUrl?: string; apiKey?: string }) => post(`${s}/models/list`, body) as Promise<{ models: ModelInfo[] | null }>,
		testLlm: () => post(`${s}/llm/test`) as Promise<{ ok: boolean; latencyMs?: number; reply?: string; error?: string }>,
		takeover: () => post(`${s}/control/takeover`),
		arm: () => post(`${s}/control/arm`),
		release: () => post(`${s}/control/release`),
		stop: () => post(`${s}/control/stop`),
		loadState: (slotNo: number) => post(`${s}/control/load-state`, { slot: slotNo }),
		confirm: (ok: boolean) => post(`${s}/control/confirm`, { ok }),

		// 共用
		discover: () => fetch("/api/models/discover").then((r) => j<{ endpoints: Array<{ baseUrl: string; product: string; models: ModelInfo[] }> }>(r)),
		presets: () => fetch("/api/presets").then((r) => j<{ presets: Preset[] }>(r)),
		savePreset: (id: string, preset: Preset["preset"]) => put(`/api/presets/${encodeURIComponent(id)}`, preset).then((r) => j<{ ok: boolean }>(r)),
		runs: () => fetch("/api/runs").then((r) => j<{ runs: RunListItem[] }>(r)),
		run: (id: string) => fetch(`/api/runs/${encodeURIComponent(id)}`).then((r) => j<{ events: AgentEvent[] }>(r)),
		exportUrl: (id: string, opts: { format?: "md" | "jsonl"; thinking?: boolean; obs?: boolean } = {}) =>
			`/api/runs/${encodeURIComponent(id)}/export?format=${opts.format ?? "md"}&thinking=${opts.thinking === false ? 0 : 1}&obs=${opts.obs === false ? 0 : 1}`,
	};
}

export type Api = ReturnType<typeof makeApi>;

/** 全局接口（不属于某个槽位）：对比模式一键开始 / 全部急停 */
export const compareApi = {
	start: (stateSlot: number, seed?: number) => post("/api/compare/start", { stateSlot, ...(seed !== undefined ? { seed } : {}) }) as Promise<{ ok: boolean; seed: number }>,
	stopAll: () => post("/api/compare/stop"),
};

export const SlotContext = createContext<Api>(makeApi("a"));
export const useApi = () => useContext(SlotContext);
