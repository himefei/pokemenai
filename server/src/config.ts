// 本地配置：config/settings.local.json（gitignore，权限 0600）。API key 只存在这里，不进日志、不进 git，UI 里遮罩显示。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTEXT_WINDOW } from "./agent/context.js";
import type { ContextMode } from "./agent/context.js";
import type { LlmParams, ProviderConfig } from "./llm/types.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// 测试时可以用环境变量把设置文件 / 运行日志 / 前端目录指到别处，避免碰正在使用的那一份
export const SETTINGS_PATH = process.env.PBA_SETTINGS ?? resolve(ROOT, "config/settings.local.json");
export const WEB_DIST = process.env.PBA_WEB_DIST ?? resolve(ROOT, "web/dist");

export interface AgentSettings {
	/** 决策者：llm（模型）或 random（基线） */
	policy: "llm" | "random";
	/** data/prompts/<preset>.json */
	preset: string;
	/** 第 3 世代规则提示（评测变量，默认关） */
	rulesHint: boolean;
	/** 上下文管理方式：window = 窗口 + 摘要（每回合重发）；continuous = 一场战斗一个连续会话（只追加）；continuous-server = 连续会话且对话存在后端（/v1/responses） */
	contextMode: ContextMode;
	/** 手动后备的上下文长度（tokens）：先从 endpoint 读取这个模型的窗口，读不到才用它 */
	contextWindow: number;
	/** 保留完整对话的最近回合数（只用于 window 模式） */
	keepFull: number;
	/** 格式错误后带错误信息重试的次数；耗尽就如实报错，没有兜底 */
	maxRetries: number;
	/** 确认模式：模型给出动作后先停住，用户点"执行"才按键 */
	confirmMode: boolean;
}

export interface Settings {
	llm: ProviderConfig & { params?: LlmParams };
	agent: AgentSettings;
}

export const DEFAULT_SETTINGS: Settings = {
	llm: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1234", apiKey: "", model: "", params: { timeoutMs: 600000 } },
	agent: { policy: "llm", preset: "default", rulesHint: false, contextMode: "window", contextWindow: DEFAULT_CONTEXT_WINDOW, keepFull: 30, maxRetries: 2, confirmMode: false },
};

export type SlotId = "a" | "b";
export const SLOT_IDS: readonly SlotId[] = ["a", "b"];

/** 文件里存的是两个槽位各自的设置（"对比"模式下 A / B 各用各的模型）。 */
export interface AppSettings {
	slots: Record<SlotId, Settings>;
}

/** 模型参数全部由 endpoint 决定，本地只保留“请求超时”这一项（本地自己的行为）。其余一律丢弃，不会发给 endpoint。 */
export function cleanParams(p: LlmParams | undefined): LlmParams {
	const t = p?.timeoutMs;
	return typeof t === "number" && Number.isFinite(t) && t > 0 ? { timeoutMs: t } : {};
}

function mergeSettings(base: Settings, j: Partial<Settings> | undefined): Settings {
	const { extraBody, ...llm } = { ...base.llm, ...(j?.llm ?? {}) } as Settings["llm"] & { extraBody?: Record<string, unknown> };
	const legacy = Object.keys(j?.llm?.params ?? {}).filter((k) => k !== "timeoutMs");
	if (legacy.length || (extraBody && Object.keys(extraBody).length)) console.warn(`[settings] 本地不再传任何模型参数，已忽略设置文件里的：${[...legacy, ...(extraBody && Object.keys(extraBody).length ? ["extraBody"] : [])].join("、")}（由 endpoint 自己的配置决定）`);
	const agent = { ...base.agent, ...(j?.agent ?? {}) };
	// 手动后备值缺失 / 无效（含旧版本存的 null = “自动”）就用默认值
	if (!(Number.isInteger(agent.contextWindow) && agent.contextWindow >= 512)) agent.contextWindow = DEFAULT_CONTEXT_WINDOW;
	return { llm: { ...llm, params: cleanParams({ ...base.llm.params, ...(j?.llm?.params ?? {}) }) }, agent };
}

/**
 * 读取全部槽位设置。兼容旧格式（顶层直接是 { llm, agent }）：旧设置就是槽位 A，槽位 B 先复制 A，之后各自独立。
 */
function readAppSettingsRaw(path: string): AppSettings {
	const base = structuredClone(DEFAULT_SETTINGS);
	let a = base;
	let b: Settings | null = null;
	if (existsSync(path)) {
		const j = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings> & { slots?: Partial<Record<SlotId, Partial<Settings>>> };
		if (j.slots) {
			a = mergeSettings(base, j.slots.a);
			b = j.slots.b ? mergeSettings(base, j.slots.b) : null;
		} else {
			a = mergeSettings(base, j);
		}
	}
	return { slots: { a, b: b ?? structuredClone(a) } };
}

export function loadAppSettings(path = SETTINGS_PATH): AppSettings {
	const settings = readAppSettingsRaw(path);
	// 环境变量优先：不想把 key 写进文件时用 LLM_API_KEY
	if (process.env.LLM_API_KEY) for (const id of SLOT_IDS) settings.slots[id].llm.apiKey = process.env.LLM_API_KEY;
	return settings;
}

export function saveAppSettings(settings: AppSettings, path = SETTINGS_PATH): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	chmodSync(path, 0o600);
}

/** 命令行等只关心单个设置的地方：读槽位 A。 */
export function loadSettings(path = SETTINGS_PATH): Settings {
	return loadAppSettings(path).slots.a;
}

/** 只更新某个槽位，其余槽位原样保留。 */
export function saveSlotSettings(slot: SlotId, settings: Settings, path = SETTINGS_PATH): void {
	const all = readAppSettingsRaw(path); // 不带环境变量覆盖，避免把环境里的 key 写进文件
	all.slots[slot] = process.env.LLM_API_KEY && settings.llm.apiKey === process.env.LLM_API_KEY ? { ...settings, llm: { ...settings.llm, apiKey: all.slots[slot].llm.apiKey } } : settings;
	saveAppSettings(all, path);
}

export function saveSettings(settings: Settings, path = SETTINGS_PATH): void {
	saveSlotSettings("a", settings, path);
}

/** 给日志/UI 用：把 key 遮掉。 */
export function redact(settings: Settings): Settings {
	return { ...settings, llm: { ...settings.llm, apiKey: settings.llm.apiKey ? `${"*".repeat(8)}${settings.llm.apiKey.slice(-4)}` : "" } };
}
