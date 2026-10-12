import { useState } from "react";
import type { ReactNode } from "react";
import type { StatStages } from "../types";

const TYPE_COLORS: Record<string, string> = {
	一般: "#a8a878", 格斗: "#c03028", 飞行: "#a890f0", 毒: "#a040a0", 地面: "#d2b058", 岩石: "#b8a038", 虫: "#a8b820", 幽灵: "#705898", 钢: "#a8a8c0",
	火: "#f08030", 水: "#6890f0", 草: "#5fb83f", 电: "#e6b800", 超能力: "#f85888", 冰: "#5fc4c4", 龙: "#7038f8", 恶: "#705848", "???": "#68a090",
};

export function TypeChip({ type }: { type: string }) {
	return (
		<span className="chip type" style={{ background: TYPE_COLORS[type] ?? "#888" }}>
			{type}
		</span>
	);
}

export function HpBar({ percent, label }: { percent: number; label: string }) {
	const p = Math.max(0, Math.min(100, percent));
	const tone = p > 50 ? "good" : p > 20 ? "warn" : "bad";
	return (
		<div className="hp">
			<div className="hp-track">
				<div className={`hp-fill ${tone}`} style={{ width: `${p}%` }} />
			</div>
			<span className="hp-label">{label}</span>
		</div>
	);
}

const STAGE_LABELS: Array<[keyof StatStages, string]> = [["atk", "攻击"], ["def", "防御"], ["spa", "特攻"], ["spd", "特防"], ["spe", "速度"], ["acc", "命中"], ["eva", "闪避"]];

export function Stages({ stages }: { stages: StatStages }) {
	const changed = STAGE_LABELS.filter(([k]) => stages[k] !== 0);
	if (changed.length === 0) return null;
	return (
		<div className="chips">
			{changed.map(([k, label]) => (
				<span key={k} className={`chip stage ${stages[k] > 0 ? "up" : "down"}`}>
					{label} {stages[k] > 0 ? "+" : ""}
					{stages[k]}
				</span>
			))}
		</div>
	);
}

const STATUS_LABEL: Record<string, string> = { sleep: "睡眠", poison: "中毒", toxic: "剧毒", burn: "灼伤", freeze: "冰冻", paralysis: "麻痹" };
const VOLATILE_LABEL: Record<string, string> = { confusion: "混乱", flinched: "畏缩", substitute: "替身", transformed: "变身", focus_energy: "聚气", infatuation: "着迷", cursed: "诅咒", nightmare: "恶梦", foresight: "识破", torment: "无理取闹", recharge: "反动", rage: "愤怒", bide: "忍耐", wrapped: "束缚", defense_curl: "变圆", destiny_bond: "同命", escape_prevention: "无法逃走", uproar: "吵闹", multiple_turns: "连续招式", lock_confuse: "乱打" };

export function StatusChips({ status, volatile }: { status: string | null; volatile?: string[] }) {
	return (
		<>
			{status && <span className="chip status">{STATUS_LABEL[status] ?? status}</span>}
			{(volatile ?? []).map((v) => (
				<span key={v} className="chip volatile">
					{VOLATILE_LABEL[v] ?? v}
				</span>
			))}
		</>
	);
}

export function Card({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={`card ${className ?? ""}`}>
			<header className="card-h">
				<h3>{title}</h3>
				{right}
			</header>
			<div className="card-b">{children}</div>
		</section>
	);
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
	return (
		<label className="field">
			<span className="field-l">{label}</span>
			{children}
			{hint && <span className="hint">{hint}</span>}
		</label>
	);
}

export function Collapsible({ title, children, open = false, badge }: { title: string; children: ReactNode; open?: boolean; badge?: string }) {
	return (
		<details className="coll" open={open}>
			<summary>
				{title}
				{badge && <span className="badge">{badge}</span>}
			</summary>
			<div className="coll-b">{children}</div>
		</details>
	);
}

/** 日志下载按钮组：Markdown（给外部 AI 分析）/ 原始 JSONL；可选是否带思考过程。 */
export function ExportButtons({ url }: { url: (opts: { format: "md" | "jsonl"; thinking: boolean }) => string }) {
	const [thinking, setThinking] = useState(true);
	return (
		<div className="export">
			<a className="btn primary" href={url({ format: "md", thinking })} download>
				下载 Markdown（给 AI 分析）
			</a>
			<a className="btn" href={url({ format: "jsonl", thinking })} download>
				下载原始 JSONL
			</a>
			<label className="check">
				<input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
				包含模型思考过程
			</label>
		</div>
	);
}
