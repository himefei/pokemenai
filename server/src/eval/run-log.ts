// 每次接管 / 每个 run 一份完整的 JSONL 日志，保证"每一回合都能回放"：
// 模型看到了什么（完整 prompt）、想了什么（思考）、选了什么、实际按了什么键。
// Phase 3 会在这上面叠 SQLite 做统计；原始日志始终保留。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import type { AgentEvent, BattleSummary } from "../agent/events.js";

export const RUNS_DIR = process.env.PBA_RUNS ?? resolve(ROOT, "runs");

export interface RunMeta {
	runId: string;
	/** 对比模式下属于哪一边 */
	slot?: string;
	startedAt: string;
	policy: string;
	/** 模型与参数快照（不含 API key） */
	model?: Record<string, unknown>;
	prompt?: Record<string, unknown>;
	flags?: Record<string, unknown>;
	savestate?: string | null;
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

export class RunLog {
	readonly file: string;

	constructor(readonly meta: RunMeta, dir = RUNS_DIR) {
		mkdirSync(dir, { recursive: true });
		this.file = resolve(dir, `run-${meta.runId}.jsonl`);
		this.write({ type: "run_start", ...meta });
	}

	private write(rec: Record<string, unknown>): void {
		appendFileSync(this.file, JSON.stringify(rec) + "\n");
	}

	/** 流式 delta 不落盘（最终的 llm.response 带完整思考与回答）；其余事件全部落盘。 */
	event(e: AgentEvent): void {
		if (e.type === "llm.delta") return;
		this.write(e);
	}

	extra(rec: Record<string, unknown>): void {
		this.write(rec);
	}

	end(summary: BattleSummary | null, needsHuman?: string): void {
		this.write({ type: "run_end", at: new Date().toISOString(), summary, needsHuman });
	}
}

export function newRunId(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-") + "-" + Math.random().toString(36).slice(2, 6);
}

export function readRun(runId: string, dir = RUNS_DIR): Array<Record<string, unknown>> | null {
	if (!/^[\w-]+$/.test(runId)) return null;
	const f = resolve(dir, `run-${runId}.jsonl`);
	if (!existsSync(f)) return null;
	return readFileSync(f, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 原始 JSONL 文本（下载用） */
export function readRunRaw(runId: string, dir = RUNS_DIR): string | null {
	if (!/^[\w-]+$/.test(runId)) return null;
	const f = resolve(dir, `run-${runId}.jsonl`);
	return existsSync(f) ? readFileSync(f, "utf8") : null;
}

export function listRuns(dir = RUNS_DIR): RunListItem[] {
	if (!existsSync(dir)) return [];
	const items: RunListItem[] = [];
	for (const name of readdirSync(dir)) {
		const m = name.match(/^run-([\w-]+)\.jsonl$/);
		if (!m) continue;
		const recs = readRun(m[1]!, dir) ?? [];
		const start = recs.find((r) => r.type === "run_start") as (RunMeta & Record<string, unknown>) | undefined;
		if (!start) continue;
		const end = recs.find((r) => r.type === "run_end") as { summary?: BattleSummary | null; needsHuman?: string } | undefined;
		items.push({
			runId: m[1]!,
			slot: typeof start.slot === "string" ? start.slot : undefined,
			startedAt: start.startedAt,
			policy: start.policy,
			model: typeof start.model?.model === "string" ? start.model.model : undefined,
			outcome: end?.summary?.outcomeName,
			turns: end?.summary?.turns,
			decisions: end?.summary?.decisions,
			partyAlive: end?.summary?.partyAlive,
			needsHuman: end?.needsHuman,
		});
	}
	return items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function writeJson(path: string, v: unknown): void {
	writeFileSync(path, JSON.stringify(v, null, 2));
}
