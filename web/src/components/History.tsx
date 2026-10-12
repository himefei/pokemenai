import { useEffect, useState } from "react";
import { useApi } from "../api";
import { foldEvents } from "../store";
import type { AgentState } from "../store";
import type { RunListItem } from "../types";
import { BattlePanel } from "./BattlePanel";
import { Card, ExportButtons } from "./bits";
import { ModelIO } from "./ModelIO";

const fmtTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

/** 历史：run 列表 + 回放。回放就是把该 run 的 JSONL 事件喂给同一个 reducer。 */
export function HistoryTab() {
	const api = useApi();
	const [runs, setRuns] = useState<RunListItem[]>([]);
	const [sel, setSel] = useState<string | null>(null);
	const [replay, setReplay] = useState<AgentState | null>(null);
	const [recId, setRecId] = useState<number | null>(null);
	const [err, setErr] = useState("");

	const load = () => api.runs().then((r) => setRuns(r.runs)).catch((e) => setErr(String(e)));
	useEffect(() => void load(), []);

	const open = async (id: string) => {
		setSel(id);
		setErr("");
		try {
			const { events } = await api.run(id);
			const st = foldEvents(events as never);
			setReplay(st);
			setRecId(st.records[0]?.id ?? null);
		} catch (e) {
			setErr((e as Error).message);
		}
	};

	return (
		<div className="history">
			<Card title="运行记录" right={<button onClick={load}>刷新</button>} className="runs">
				{runs.length === 0 ? (
					<p className="empty">还没有记录。每次接管都会在 runs/ 下留一份完整的 JSONL。</p>
				) : (
					<table className="timeline">
						<thead>
							<tr>
								<th>时间</th>
								<th>决策者</th>
								<th>结果</th>
								<th>回合</th>
								<th>剩余</th>
							</tr>
						</thead>
						<tbody>
							{runs.map((r) => (
								<tr key={r.runId} className={r.runId === sel ? "sel" : ""} onClick={() => open(r.runId)}>
									<td>{fmtTime(r.startedAt)}</td>
									<td>{r.policy === "llm" ? (r.model ?? "llm") : r.policy}</td>
									<td>{r.needsHuman ? <span className="chip bad">出错退出</span> : (r.outcome ?? "…")}</td>
									<td>{r.turns ?? "—"}</td>
									<td>{r.partyAlive ?? "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{err && <p className="warn-text">{err}</p>}
			</Card>
			{replay && sel && (
				<div className="replay-wrap">
					<Card title="导出这次运行的日志">
						<ExportButtons url={(o) => api.exportUrl(sel, { format: o.format, thinking: o.thinking })} />
						<p className="hint">Markdown 里有概要、逐回合的场面 / 读到的文字 / 模型思考与回答 / 选择与执行结果和统计，可以直接贴给另一个 AI 让它分析模型哪里做得不好。</p>
					</Card>
				</div>
			)}
			{replay && (
				<div className="replay">
					<BattlePanel state={replay} selectedId={recId} onSelect={setRecId} live={false} />
					<ModelIO rec={replay.records.find((r) => r.id === recId)} live={false} confirmable={false} onConfirm={() => {}} />
				</div>
			)}
		</div>
	);
}

/** 统计：按 决策者/模型 分组的胜率与平均回合。（Phase 3 会补格式失败率、克制利用率等） */
export function StatsTab() {
	const api = useApi();
	const [runs, setRuns] = useState<RunListItem[]>([]);
	useEffect(() => void api.runs().then((r) => setRuns(r.runs)), []);

	const groups = new Map<string, RunListItem[]>();
	for (const r of runs) {
		const key = r.policy === "llm" ? `大模型 · ${r.model ?? "?"}` : r.policy;
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	return (
		<Card title="按模型 / 决策者统计">
			{groups.size === 0 ? (
				<p className="empty">还没有数据。</p>
			) : (
				<table className="timeline stats">
					<thead>
						<tr>
							<th>决策者</th>
							<th>场数</th>
							<th>胜</th>
							<th>负</th>
							<th>平/上限</th>
							<th>出错退出</th>
							<th>胜率</th>
							<th>平均回合</th>
						</tr>
					</thead>
					<tbody>
						{[...groups].map(([k, rs]) => {
							const done = rs.filter((r) => r.outcome);
							const won = done.filter((r) => r.outcome === "WON").length;
							const lost = done.filter((r) => r.outcome === "LOST").length;
							const turns = done.map((r) => r.turns ?? 0);
							return (
								<tr key={k}>
									<td>{k}</td>
									<td>{rs.length}</td>
									<td>{won}</td>
									<td>{lost}</td>
									<td>{done.length - won - lost}</td>
									<td>{rs.filter((r) => r.needsHuman).length}</td>
									<td>{done.length ? `${Math.round((won / done.length) * 100)}%` : "—"}</td>
									<td>{turns.length ? (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : "—"}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
			<p className="hint">RNG 让单场结果不稳定，不能凭一场下结论；批量复跑、基线对照与更多指标见“评测”（Phase 3）。</p>
		</Card>
	);
}

export function EvalTab() {
	return (
		<Card title="评测（Phase 3，尚未实现）">
			<p>
				计划：从同一个存档点（savestate）反复复跑——<code>load_state</code> → 写随机 <code>gRngValue</code> → 接管 → 战斗结束 → 重新加载——对 random / greedy / LLM 三种策略各跑 ≥10 场，
				统计胜率、回合数、格式失败率、克制利用率、致命失误数。
			</p>
			<p className="hint">命令行版已经可用：<code>cd server && npm run play -- --policy llm --slot 2 --battles 10</code>（每场的完整日志在 runs/）。</p>
		</Card>
	);
}
