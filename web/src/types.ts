// 与桥接服务（server/src/agent/{events,observation}.ts 等）对应的前端类型。

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface StatStages {
	atk: number;
	def: number;
	spa: number;
	spd: number;
	spe: number;
	acc: number;
	eva: number;
}

export interface MoveView {
	id: string;
	name: string;
	name_en: string;
	type: string;
	pp: number;
	max_pp: number | null;
	power?: number;
	accuracy?: number | null;
}

export interface OwnMonView {
	party_index: number;
	species: string;
	species_en: string;
	level: number;
	hp: number;
	max_hp: number;
	status: string | null;
	types: string[];
	stats: { atk: number; def: number; spa: number; spd: number; spe: number };
	ability: string | null;
	item: string | null;
	moves: MoveView[];
	stat_stages?: StatStages;
	volatile?: string[];
	fainted: boolean;
	active: boolean;
}

export interface OpponentView {
	species: string;
	species_en: string;
	level: number;
	types: string[];
	hp_percent: number;
	status: string | null;
	known_moves: Array<{ name: string; name_en: string }>;
	unknown_move_slots: number;
	ability: string | null;
	item: string | null;
}

export interface Observation {
	turn: number;
	phase: string;
	you: { active: OwnMonView; party: OwnMonView[] };
	opponent: OpponentView;
	opponent_remaining: number | null;
	opponent_party_size: number | null;
	field: { weather: string | null; your_side: string[]; opponent_side: string[] };
	legal_actions: Array<{ id: string; label: string }>;
	last_turn: string[];
}

export type ExecResult = { ok: true; note?: string } | { ok: false; reason: string; detail: string };

export interface BattleSummary {
	battle: number;
	outcome: number;
	outcomeName: string;
	turns: number;
	decisions: number;
	rejections: number;
	nudges: number;
	frames: number;
	partyAlive: number;
	rngSeed: number | null;
}

export type ControllerState = "idle" | "armed" | "waiting" | "deciding" | "executing" | "paused" | "needs_human" | "finished";

export type AgentEvent =
	| { type: "emu.status"; connected: boolean; romOk: boolean; gameCode?: string; frame?: number; message?: string }
	| { type: "controller.state"; state: ControllerState; detail?: string }
	| { type: "phase"; phase: string; reason: string; forced: boolean; frame: number }
	| { type: "battle.state"; turn: number; observation: Observation; truth: unknown }
	| { type: "battle.text"; frame: number; text: string }
	| { type: "turn.start"; turn: number }
	| { type: "llm.request"; turn: number; attempt: number; model: string; messages: ChatMessage[]; ts?: number }
	| { type: "llm.delta"; turn: number; attempt: number; kind: "content" | "reasoning"; text: string }
	| { type: "llm.response"; turn: number; attempt: number; content: string; reasoning: string; usage: { inputTokens?: number; outputTokens?: number }; latencyMs: number; parseError?: string }
	| { type: "action.parsed"; turn: number; choice: string; label: string; reason: string; attempts: number }
	| { type: "action.confirm"; turn: number; choice: string; label: string }
	| { type: "action.executing"; turn: number; choice: string; label: string }
	| { type: "action.done"; turn: number; choice: string; result: ExecResult }
	| { type: "battle.end"; result: BattleSummary }
	| { type: "error"; message: string };

export interface EmuStatus {
	connected: boolean;
	romOk: boolean;
	gameCode?: string;
	frame?: number;
	message?: string;
}

export interface LlmSettings {
	kind: "openai-compat" | "anthropic";
	baseUrl: string;
	apiKey: string;
	model: string;
	params?: { temperature?: number; maxTokens?: number; timeoutMs?: number; reasoningEffort?: string | null; thinkingBudget?: number | null };
	extraBody?: Record<string, unknown>;
}

export interface AgentSettings {
	policy: "llm" | "random";
	preset: string;
	rulesHint: boolean;
	keepFull: number;
	maxRetries: number;
	confirmMode: boolean;
}

export interface Settings {
	llm: LlmSettings;
	agent: AgentSettings;
}

export interface ModelInfo {
	id: string;
	tags: string[];
	loaded?: boolean;
	contextLength?: number;
}

export interface Preset {
	id: string;
	preset: { name: string; base_prompt: string; output_instructions: string };
}

export interface RunListItem {
	runId: string;
	slot?: string;
	startedAt: string;
	policy: string;
	model?: string;
	outcome?: string;
	turns?: number;
	decisions?: number;
	partyAlive?: number;
	needsHuman?: string;
}

export interface ServerStatus {
	emu: EmuStatus;
	controller: { state: ControllerState; detail?: string; confirmMode: boolean; runId: string | null; pendingConfirm: { turn: number; choice: string; label: string } | null };
	phase: string;
	settings: Settings;
}
