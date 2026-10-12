// 把一次运行的事件日志整理成 Markdown 报告，给外部 AI（或人）分析"模型哪里做得好、哪里还能改进"。
// 纯函数：输入是 run-*.jsonl 解析出的记录，输出字符串；不读任何文件，方便测试。

import type { Observation } from "../agent/observation.js";

type Rec = Record<string, any>;

export interface ReportOptions {
	/** 是否包含模型的完整思考（默认 true；想省 token 给外部 AI 时关掉） */
	thinking?: boolean;
	/** 是否包含每回合的完整观测 JSON（默认 true） */
	observationJson?: boolean;
}

interface Attempt {
	n: number;
	model?: string;
	content: string;
	reasoning: string;
	usage: { inputTokens?: number; outputTokens?: number };
	latencyMs: number;
	parseError?: string;
}

interface Decision {
	turn: number;
	obs: Observation;
	attempts: Attempt[];
	parsed?: { choice: string; label: string; reason: string; attempts: number };
	exec?: { ok: boolean; reason?: string; detail?: string; note?: string };
}

const pct = (n: number) => `${n}%`;

function monLine(o: Observation): string[] {
	const me = o.you.active;
	const e = o.opponent;
	const flags = (m: { status: string | null }) => (m.status ? `，状态：${m.status}` : "");
	const stages = me.stat_stages ? Object.entries(me.stat_stages).filter(([, v]) => v !== 0).map(([k, v]) => `${k}${v > 0 ? "+" : ""}${v}`) : [];
	const vol = me.volatile?.length ? `，临时状态：${me.volatile.join("/")}` : "";
	const known = e.known_moves.map((m) => m.name).join("、") || "（无）";
	return [
		`- **我方在场**：${me.species} Lv${me.level} HP ${me.hp}/${me.max_hp}${flags(me)}${stages.length ? `，能力变化：${stages.join(" ")}` : ""}${vol}；特性 ${me.ability ?? "—"}，道具 ${me.item ?? "—"}`,
		`- **我方招式**：${me.moves.map((m) => `${m.name}(${m.type}${m.power ? `/威力${m.power}` : ""}/PP ${m.pp}/${m.max_pp ?? "?"})`).join("；")}`,
		`- **我方队伍**：${o.you.party.map((p) => `${p.species}${p.active ? "★" : ""} ${p.fainted ? "倒下" : `${p.hp}/${p.max_hp}${p.status ? `(${p.status})` : ""}`}`).join("；")}`,
		`- **对手在场**：${e.species} Lv${e.level} [${e.types.join("/")}] HP ${pct(e.hp_percent)}${flags(e)}；已知招式：${known}（另有 ${e.unknown_move_slots} 个未见）；特性 ${e.ability ?? "未知"}，道具 ${e.item ?? "未知"}`,
		`- **对手剩余**：${o.opponent_remaining ?? "?"}/${o.opponent_party_size ?? "?"}${o.field.weather ? `；天气：${o.field.weather}` : ""}`,
	];
}

function collect(records: Rec[]): { start?: Rec; end?: Rec; decisions: Decision[]; errors: string[] } {
	const decisions: Decision[] = [];
	const errors: string[] = [];
	let cur: Decision | undefined;
	let start: Rec | undefined;
	let end: Rec | undefined;
	for (const r of records) {
		switch (r.type) {
			case "run_start":
				start = r;
				break;
			case "run_end":
				end = r;
				break;
			case "battle.state":
				cur = { turn: r.turn, obs: r.observation as Observation, attempts: [] };
				decisions.push(cur);
				break;
			case "llm.request":
				cur?.attempts.push({ n: r.attempt, model: r.model, content: "", reasoning: "", usage: {}, latencyMs: 0 });
				break;
			case "llm.response": {
				const a = cur?.attempts.find((x) => x.n === r.attempt);
				if (a) Object.assign(a, { content: r.content, reasoning: r.reasoning, usage: r.usage ?? {}, latencyMs: r.latencyMs, parseError: r.parseError });
				break;
			}
			case "action.parsed":
				if (cur) cur.parsed = { choice: r.choice, label: r.label, reason: r.reason, attempts: r.attempts };
				break;
			case "action.done":
				if (cur) cur.exec = r.result;
				break;
			case "error":
				errors.push(String(r.message));
				break;
		}
	}
	return { start, end, decisions, errors };
}

export function buildRunReport(records: Rec[], opts: ReportOptions = {}): string {
	const withThinking = opts.thinking ?? true;
	const withObsJson = opts.observationJson ?? true;
	const { start, end, decisions, errors } = collect(records);
	const lines: string[] = [];
	const push = (...l: string[]) => lines.push(...l);

	const summary = end?.summary as Rec | null | undefined;
	const model = (start?.model ?? {}) as Rec;
	const flags = (start?.flags ?? {}) as Rec;
	const prompt = (start?.prompt ?? {}) as Rec;
	const attemptsAll = decisions.flatMap((d) => d.attempts);
	const formatFailures = attemptsAll.filter((a) => a.parseError).length;
	const retried = decisions.filter((d) => d.attempts.length > 1).length;
	const inTok = attemptsAll.reduce((s, a) => s + (a.usage.inputTokens ?? 0), 0);
	const outTok = attemptsAll.reduce((s, a) => s + (a.usage.outputTokens ?? 0), 0);
	const modelSeconds = attemptsAll.reduce((s, a) => s + a.latencyMs, 0) / 1000;
	const rejected = decisions.filter((d) => d.exec && !d.exec.ok).length;

	push(`# 宝可梦战斗日志：${start?.runId ?? "?"}`, "");
	push("> 这份日志由“宝可梦战斗接管器”导出，用于让外部 AI / 人分析：模型在这场战斗里哪里做得好、哪里做得不好、提示词或信息给法还能怎么改进。", "");

	push("## 1. 概要", "");
	push(`- 时间：${start?.startedAt ?? "?"}`);
	push(`- 决策者：${start?.policy === "llm" ? `大模型 \`${model.model ?? "?"}\`（${model.kind ?? "?"}）` : (start?.policy ?? "?")}`);
	if (model.params) push(`- 模型参数：\`${JSON.stringify(model.params)}\`${model.extraBody && Object.keys(model.extraBody).length ? `，额外请求体 \`${JSON.stringify(model.extraBody)}\`` : ""}`);
	if (prompt.preset) push(`- Prompt 预设：${prompt.preset}；规则提示（第 3 世代规则）：${prompt.rulesHint ? "开" : "关"}`);
	if (flags.keepFull !== undefined) push(`- 保留完整对话回合数：${flags.keepFull}；格式错误重试次数：${flags.maxRetries}`);
	push(`- 结果：**${summary?.outcomeName ?? (end?.needsHuman ? "出错退出" : "未结束")}**${summary ? `，${summary.turns} 回合，我方剩余 ${summary.partyAlive} 只，${summary.frames} 帧` : ""}`);
	if (end?.needsHuman) push(`- 退出原因：${end.needsHuman}`);
	push(`- 决策 ${decisions.length} 次；需要重试的 ${retried} 次；格式/解析失败的尝试 ${formatFailures} 次；动作被游戏拒绝或执行失败 ${rejected} 次`);
	push(`- 模型调用耗时合计 ${modelSeconds.toFixed(0)} 秒；token：输入 ${inTok}，输出 ${outTok}`);
	if (errors.length) push(`- 运行中的错误：${errors.map((e) => `\`${e}\``).join("；")}`);
	push("");

	push("## 2. 信息设定（分析时请注意）", "");
	push("- 模型只能看到**玩家在游戏界面上看得到、读得到的信息**：我方宝可梦的全部信息；对手的种类/等级/属性/HP 百分比/异常状态、**已经用过的招式**（其余槽位未知）、被战斗文字揭示过的特性/道具、战斗文字原文。");
	push("- 没有给：属性克制表、种族值、对手的数值与全部招式、伤害计算、第 3 世代规则提示（除非上面写了“规则提示：开”）。");
	push("- “是/否提示”（如对手要换上下一只时问“要不要换宝可梦？”）也由模型回答。");
	push("- 每回合下面的“场面”是模型当时看到的观测；“读到的战斗文字”是自上次决策后游戏显示的文字。", "");

	const sys = (prompt.base_prompt as string | undefined) ? `${prompt.base_prompt}\n\n${prompt.output_instructions ?? ""}` : undefined;
	if (sys) {
		push("## 3. 发给模型的 system 提示词", "", "```text", sys.trim(), "```", "");
	}

	push("## 4. 逐回合记录", "");
	for (const [i, d] of decisions.entries()) {
		const o = d.obs;
		push(`### 决策 ${i + 1} · 第 ${d.turn} 回合 · 界面 \`${o.phase}\``, "");
		push(...monLine(o), "");
		if (o.last_turn.length) {
			push("**读到的战斗文字**：", ...o.last_turn.map((t) => `> ${t}`), "");
		}
		push(`**可选动作**：${o.legal_actions.map((a) => `\`${a.id}\` ${a.label}`).join("；")}`, "");
		if (withObsJson) push("<details><summary>模型看到的完整观测 JSON</summary>", "", "```json", JSON.stringify(o, null, 1), "```", "", "</details>", "");
		for (const a of d.attempts) {
			const tag = d.attempts.length > 1 ? `（第 ${a.n} 次尝试）` : "";
			push(`**模型输出${tag}**　${(a.latencyMs / 1000).toFixed(1)}s · 输入 ${a.usage.inputTokens ?? "?"} / 输出 ${a.usage.outputTokens ?? "?"} tok${a.parseError ? ` · ❌ ${a.parseError}` : ""}`, "");
			if (withThinking && a.reasoning) push("<details><summary>思考过程</summary>", "", "```text", a.reasoning.trim(), "```", "", "</details>", "");
			push("```text", (a.content || "（空）").trim(), "```", "");
		}
		if (d.parsed) push(`**选择**：${d.parsed.label}（\`${d.parsed.choice}\`）　**理由**：${d.parsed.reason || "（无）"}`);
		if (d.exec) push(`**执行**：${d.exec.ok ? "✓ 成功" : `✗ ${d.exec.reason}：${d.exec.detail}`}${d.exec.note ? `（${d.exec.note}）` : ""}`);
		push("");
	}

	// 结尾：简单的统计，帮助外部分析者抓重点
	const moves = new Map<string, number>();
	for (const d of decisions) if (d.parsed) moves.set(d.parsed.label, (moves.get(d.parsed.label) ?? 0) + 1);
	push("## 5. 统计", "");
	push(`- 选择频次：${[...moves].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("，") || "（无）"}`);
	const switches = decisions.filter((d) => d.parsed?.choice.startsWith("switch:") || d.parsed?.choice === "prompt:yes").length;
	push(`- 换人/回答“是”的次数：${switches}`);
	const lastObs = decisions.at(-1)?.obs;
	if (lastObs) push(`- 最后一次决策时：我方 ${lastObs.you.active.species} HP ${lastObs.you.active.hp}/${lastObs.you.active.max_hp}；对手 ${lastObs.opponent.species} ${lastObs.opponent.hp_percent}%`);
	push("", "## 6. 给分析者的提示", "");
	push("- 重点看：模型对**对手未知招式/特性**的推测是否合理；换人时机（尤其“是/否提示”里的免费换人）；对**能力变化、天气、异常状态**这些文字信息的利用；是否有重复无效的选择；是否有格式错误及其原因。");
	push("- 模型思考里引用的“事实”（属性克制、种族值、招式威力）完全来自它自己的知识，没有任何资料提示——可以核对其中的错误。", "");

	return lines.join("\n");
}

/** 原始日志的下载文件名 */
export function exportFileName(runId: string, format: "md" | "jsonl"): string {
	return `pokemon-battle-${runId}.${format}`;
}
