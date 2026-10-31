import { contextUsage } from "../store";
import type { AgentState, ContextUsage } from "../store";
import type { ContextMode } from "../types";
import { Card } from "./bits";

export const CONTEXT_MODE_LABEL: Record<ContextMode, string> = {
	window: "窗口 + 摘要",
	continuous: "连续会话",
	"continuous-server": "连续会话 · 后端保存",
};

export const fmt = (n: number) => n.toLocaleString("en-US");

/** 上下文占用：最近一次请求的 prompt 大小（模型当时看到的全部上下文）/ 这个模型的窗口。 */
export function ContextMeter({ state, selectedId }: { state: AgentState; selectedId: number | null }) {
	const u = contextUsage(state);
	const mode = u.mode ? CONTEXT_MODE_LABEL[u.mode] : null;
	return (
		<Card title="上下文" right={mode ? <span className="pill">{mode}</span> : undefined} className="ctx">
			{u.used === null ? (
				<p className="empty">
					{state.context ? (u.max ? `窗口 ${fmt(u.max)} tokens（${u.source}）。` : `窗口未知：${u.source}。`) : "接管后这里显示：上下文已用多少 / 最大多少 tokens。"}
					{state.context && " 还没有模型调用。"}
				</p>
			) : (
				<Used u={u} selectedId={selectedId} />
			)}
			{u.warning && (
				<p className="warn-text">
					⚠ T{u.warning.turn}：{u.warning.text}
				</p>
			)}
		</Card>
	);
}

function Used({ u, selectedId }: { u: ContextUsage; selectedId: number | null }) {
	const used = u.used!;
	return (
		<>
			<div className="ctx-line">
				<b>{fmt(used)}</b>
				<span className="muted"> / {u.max ? fmt(u.max) : "窗口未识别"} tokens</span>
				{u.pct !== null && <span className={`ctx-pct ${u.level}`}>{u.pct < 10 ? u.pct.toFixed(1) : Math.round(u.pct)}%</span>}
			</div>
			{u.max ? (
				<div className="ctx-track" title={`${fmt(used)} / ${fmt(u.max)}`}>
					<div className={`ctx-fill ${u.level}`} style={{ width: `${Math.min(100, Math.max(0.6, u.pct ?? 0))}%` }} />
					<div className="ctx-stop" title="到这里（95%）程序会先停下报错，不让后端悄悄截断" />
				</div>
			) : (
				<p className="hint">这次运行没有记录窗口大小（旧日志），无法判断是否快满。</p>
			)}
			{u.level !== "ok" && <p className="warn-text">{u.level === "full" ? "已经接近窗口上限，下一次请求前程序会停下。" : "上下文已用超过 80%。"}</p>}
			<p className="hint">
				最近一次请求：输入 {fmt(used)}
				{u.cached !== null && ` · 缓存命中 ${fmt(u.cached)}`}
				{u.output !== null && ` · 输出 ${fmt(u.output)}`}
				{u.max ? ` · 剩余约 ${fmt(Math.max(0, u.max - used))}` : ""}
			</p>
			{u.perTurn !== null && u.perTurn > 0 && (
				<p className="hint opt">
					平均每个决策 +{fmt(Math.round(u.perTurn))} tokens
					{u.turnsLeft !== null && `，照这个速度还能再撑约 ${u.turnsLeft} 个决策`}
				</p>
			)}
			{u.series.length > 1 && <Spark series={u.series} selectedId={selectedId} />}
			{u.max && u.source && <p className="hint opt">窗口来自：{u.source}</p>}
		</>
	);
}

/** 每个决策的 prompt 大小（按它们自己的最大值缩放，看增长的形状）。 */
function Spark({ series, selectedId }: { series: ContextUsage["series"]; selectedId: number | null }) {
	const top = Math.max(...series.map((s) => s.tokens));
	const w = 100 / series.length;
	return (
		<svg className="ctx-spark opt" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="每个决策的上下文大小">
			{series.map((s, i) => (
				<rect key={s.id} className={s.id === selectedId ? "on" : ""} x={i * w + w * 0.1} width={w * 0.8} y={24 - Math.max(1, (s.tokens / top) * 23)} height={Math.max(1, (s.tokens / top) * 23)}>
					<title>{`T${s.turn}：${fmt(s.tokens)} tokens`}</title>
				</rect>
			))}
		</svg>
	);
}
