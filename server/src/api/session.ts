// 会话：把模拟器连接、控制器、模型配置、事件总线装在一起，供 HTTP / WebSocket 使用。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RandomPolicy } from "../agent/baselines.js";
import { Controller } from "../agent/controller.js";
import type { AgentEvent, EventSink } from "../agent/events.js";
import { LlmPolicy } from "../agent/llm-policy.js";
import type { Policy } from "../agent/policy.js";
import { loadPreset } from "../agent/prompt.js";
import type { PromptPreset } from "../agent/prompt.js";
import { BattleTracker } from "../agent/tracker.js";
import { ROOT, SETTINGS_PATH, cleanParams, loadAppSettings, redact, saveSlotSettings } from "../config.js";
import type { Settings, SlotId } from "../config.js";
import { EmulatorClient } from "../emulator/client.js";
import type { EmulatorLink } from "../emulator/rpc.js";
import { WsEmulatorHub } from "../emulator/ws-hub.js";
import { InputExecutor } from "../emulator/input-executor.js";
import { PhaseDetector } from "../emulator/phase.js";
import { readHeartbeat } from "../emulator/heartbeat.js";
import { listRuns, readRun, readRunRaw } from "../eval/run-log.js";
import { TextLog } from "../gen3/battle-text.js";
import { Gen3Data } from "../gen3/data.js";
import { SymbolTable } from "../gen3/symbols.js";
import { discoverLocalEndpoints, listModels } from "../llm/discovery.js";
import { createClient } from "../llm/factory.js";
import type { ProviderKind } from "../llm/types.js";

export interface SessionOptions {
	/** 槽位（"对比"模式下 A / B 各是一个独立的游戏 + 模型），默认 a */
	slot?: SlotId;
	/** 直接指定模拟器连接（测试用）。不指定：有 emuPort 就连 mGBA 的 Lua 桥（TCP），否则等网页里的模拟器通过 WebSocket 连进来 */
	link?: EmulatorLink;
	emuHost?: string;
	emuPort?: number;
	settingsPath?: string;
	/** false = 不轮询阶段（测试用） */
	pollPhase?: boolean;
}

const MASK = "********";

export class Session {
	readonly slot: SlotId;
	readonly client: EmulatorLink;
	/** 网页模拟器后端时存在：HTTP 层把 /emu-link 的 WebSocket 交给它 */
	readonly hub: WsEmulatorHub | null;
	readonly syms = SymbolTable.load();
	readonly data = Gen3Data.load();
	readonly detector = new PhaseDetector(this.syms);
	readonly exec: InputExecutor;
	readonly controller: Controller;
	private settings: Settings;
	private emu: AgentEvent & { type: "emu.status" } = { type: "emu.status", connected: false, romOk: false };
	private listeners = new Set<EventSink>();
	/** 最近事件（连上 WebSocket 时回放，刷新页面不丢现场）；连续的 llm.delta 合并 */
	private ring: AgentEvent[] = [];
	private pollTimer: NodeJS.Timeout | null = null;
	private lastPhase = "";

	constructor(private readonly opts: SessionOptions = {}) {
		this.slot = opts.slot ?? "a";
		this.settings = loadAppSettings(opts.settingsPath ?? SETTINGS_PATH).slots[this.slot];
		if (opts.link) {
			this.client = opts.link;
			this.hub = opts.link instanceof WsEmulatorHub ? opts.link : null;
		} else if (opts.emuPort !== undefined) {
			this.client = new EmulatorClient({ host: opts.emuHost, port: opts.emuPort, autoReconnect: true, requestTimeoutMs: 15000 });
			this.hub = null;
		} else {
			this.hub = new WsEmulatorHub(15000);
			this.client = this.hub;
		}
		this.exec = new InputExecutor(this.client, this.syms, this.detector);
		this.controller = new Controller({
			client: this.client,
			syms: this.syms,
			data: this.data,
			detector: this.detector,
			exec: this.exec,
			textLog: new TextLog(),
			tracker: new BattleTracker(this.data),
			makePolicy: (sink) => this.makePolicy(sink),
		});
		this.controller.onEvent((e) => this.publish(e));
		this.client.on("error", () => {});
		this.client.on("connected", () => void this.onEmuConnected());
		this.client.on("disconnected", () => this.setEmu({ connected: false, romOk: false, message: this.hub ? "网页里的模拟器已断开（页面被关掉或刷新？）" : "mGBA 桥已断开" }));
	}

	// ---- 事件总线 ----

	subscribe(fn: EventSink): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	replay(): AgentEvent[] {
		return this.ring.slice();
	}

	publish(e: AgentEvent): void {
		const last = this.ring.at(-1);
		if (e.type === "llm.delta" && last?.type === "llm.delta" && last.turn === e.turn && last.attempt === e.attempt && last.kind === e.kind) {
			this.ring[this.ring.length - 1] = { ...last, text: last.text + e.text };
		} else {
			this.ring.push(e);
			// 新一次接管开始：丢掉上一次的现场，避免回放无限增长
			if (e.type === "controller.state" && e.state === "waiting" && this.ring.length > 5000) this.ring.splice(0, this.ring.length - 2000);
		}
		if (this.ring.length > 6000) this.ring.splice(0, this.ring.length - 4000);
		for (const fn of this.listeners) fn(e);
	}

	// ---- 模拟器连接 ----

	async start(): Promise<void> {
		// Lua 桥（TCP）要主动连；网页模拟器（WebSocket）是它连进来
		if (!this.hub) void this.client.connect().catch(() => {});
		if (this.opts.pollPhase !== false) this.pollTimer = setInterval(() => void this.pollPhase(), 500);
	}

	async stop(): Promise<void> {
		if (this.pollTimer) clearInterval(this.pollTimer);
		await this.controller.emergencyStop();
		this.client.close();
	}

	private setEmu(p: Partial<Omit<typeof this.emu, "type">>): void {
		this.emu = { ...this.emu, ...p };
		this.publish(this.emu);
	}

	private async onEmuConnected(): Promise<void> {
		try {
			const h = await this.client.hello();
			const romOk = h.rom_crc32_raw_hex?.toUpperCase() === this.syms.romCrc32 && h.game_code.includes(this.syms.gameCode);
			this.setEmu({ connected: true, romOk, gameCode: h.game_code, frame: h.frame, message: romOk ? undefined : `ROM 不匹配（${h.rom_crc32_raw_hex}），不受支持` });
		} catch (e) {
			this.setEmu({ connected: true, romOk: false, message: (e as Error).message });
		}
	}

	/** 空闲时低频读阶段，让 UI 随时显示当前状态；控制器在跑的时候它自己会发 phase 事件。 */
	private async pollPhase(): Promise<void> {
		if (!this.client.connected || !this.emu.romOk) return;
		const st = this.controller.status().state;
		if (st !== "idle" && st !== "finished" && st !== "needs_human") return;
		try {
			const hb = await readHeartbeat(this.client, this.syms);
			const info = this.detector.classify(hb);
			if (info.phase !== this.lastPhase) {
				this.lastPhase = info.phase;
				this.publish({ type: "phase", phase: info.phase, reason: info.reason, forced: info.forced, frame: hb.frame });
			}
		} catch {
			/* 下一次再试 */
		}
	}

	status() {
		return { slot: this.slot, emu: this.emu, controller: this.controller.status(), phase: this.lastPhase, settings: redact(this.settings) };
	}

	// ---- 设置 ----

	getSettings(): Settings {
		return this.settings;
	}

	/** 合并更新；apiKey 为遮罩值或空串"保持不变"时沿用旧值。 */
	updateSettings(patch: { llm?: Partial<Settings["llm"]>; agent?: Partial<Settings["agent"]> }): void {
		const next: Settings = structuredClone(this.settings);
		if (patch.llm) {
			const { apiKey, ...rest } = patch.llm;
			Object.assign(next.llm, rest);
			if (typeof apiKey === "string" && apiKey !== "" && !apiKey.startsWith(MASK)) next.llm.apiKey = apiKey;
			// 参数是可选覆盖：传 null / 空 = 去掉，不发给 endpoint
			if (patch.llm.params) next.llm.params = cleanParams({ ...this.settings.llm.params, ...patch.llm.params });
		}
		if (patch.agent) Object.assign(next.agent, patch.agent);
		this.settings = next;
		saveSlotSettings(this.slot, next, this.opts.settingsPath ?? SETTINGS_PATH);
		this.controller.setConfirmMode(next.agent.confirmMode);
	}

	// ---- 模型 ----

	async discover() {
		return discoverLocalEndpoints();
	}

	async models(body: { kind?: ProviderKind; baseUrl?: string; apiKey?: string }) {
		const llm = this.settings.llm;
		const apiKey = body.apiKey && !body.apiKey.startsWith(MASK) ? body.apiKey : llm.apiKey;
		return listModels({ kind: body.kind ?? llm.kind, baseUrl: body.baseUrl ?? llm.baseUrl, apiKey });
	}

	async testLlm(): Promise<{ ok: boolean; latencyMs?: number; reply?: string; error?: string }> {
		const llm = this.settings.llm;
		try {
			const r = await createClient(llm).complete({
				messages: [{ role: "user", content: "回复 ok 两个字母即可。" }],
				params: { ...(llm.params ?? {}), maxTokens: 64, extraBody: llm.extraBody, timeoutMs: 30000 },
			});
			return { ok: true, latencyMs: Math.round(r.latencyMs), reply: (r.content || r.reasoning).slice(0, 80) };
		} catch (e) {
			return { ok: false, error: (e as Error).message + ((e as { body?: string }).body ? ` — ${(e as { body?: string }).body}` : "") };
		}
	}

	/** 一次接管开始时快照当前模型与参数，保证结果可追溯。 */
	private makePolicy(sink: EventSink): { policy: Policy; meta: Record<string, unknown> } {
		const s = structuredClone(this.settings);
		if (s.agent.policy === "random") {
			const seed = (Date.now() & 0x7fffffff) >>> 0;
			return { policy: new RandomPolicy(seed), meta: { slot: this.slot, flags: { seed } } };
		}
		const preset = loadPreset(s.agent.preset);
		const policy = new LlmPolicy({
			client: createClient(s.llm),
			model: s.llm.model,
			params: { ...(s.llm.params ?? {}), extraBody: s.llm.extraBody },
			prompt: { preset, rulesHint: s.agent.rulesHint },
			keepFull: s.agent.keepFull,
			maxRetries: s.agent.maxRetries,
			sink,
		});
		const { apiKey: _omit, ...llmNoKey } = s.llm;
		void _omit;
		return { policy, meta: { slot: this.slot, model: llmNoKey, prompt: { preset: preset.name, base_prompt: preset.base_prompt, output_instructions: preset.output_instructions, rulesHint: s.agent.rulesHint }, flags: { ...s.agent } } };
	}

	// ---- 存档点 / 随机数 ----

	/** 暂停 / 继续模拟（只有网页模拟器支持；Lua 桥不支持时静默忽略）。 */
	async pauseEmu(): Promise<void> {
		await this.client.request("pause").catch(() => {});
	}

	async resumeEmu(): Promise<void> {
		await this.client.request("resume").catch(() => {});
	}

	/** 读取存档点（模拟器的 save state 槽位）。 */
	async loadState(slot: number): Promise<void> {
		await this.client.request("load_state", { slot }, 30000);
	}

	/** 写 gRngValue：同一个存档点复跑时让每次的随机数不同（或让 A/B 两边用同一个种子，公平对比）。 */
	async setRng(seed: number): Promise<void> {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setUint32(0, seed >>> 0, true);
		await this.client.write(this.syms.addr("gRngValue"), b);
	}

	// ---- 提示词预设 ----

	listPresets(): Array<{ id: string; preset: PromptPreset }> {
		const dir = resolve(ROOT, "data/prompts");
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => ({ id: f.replace(/\.json$/, ""), preset: JSON.parse(readFileSync(resolve(dir, f), "utf8")) as PromptPreset }));
	}

	savePreset(id: string, preset: PromptPreset): void {
		if (!/^[\w-]{1,40}$/.test(id)) throw new Error("预设 id 只能包含字母数字下划线连字符");
		writeFileSync(resolve(ROOT, "data/prompts", `${id}.json`), JSON.stringify(preset, null, 2) + "\n");
	}

	// ---- 历史 ----

	runs() {
		return listRuns();
	}

	run(id: string) {
		return readRun(id);
	}

	runRaw(id: string) {
		return readRunRaw(id);
	}
}
