import { useEffect, useRef, useState } from "react";
import type { Attempt, TurnRecord } from "../store";
import { Card, Collapsible } from "./bits";

export function ModelIO({ rec, live, confirmable, onConfirm }: { rec: TurnRecord | undefined; live: boolean; confirmable: boolean; onConfirm: (ok: boolean) => void }) {
	const [attemptIdx, setAttemptIdx] = useState<number | null>(null);
	useEffect(() => setAttemptIdx(null), [rec?.id]);

	if (!rec) {
		return (
			<div className="col right">
				<Card title="模型输入 / 输出">
					<p className="empty">还没有模型调用。接管战斗后，这里会实时显示：发送给模型的完整 prompt、流式的思考、最终回答、解析出的动作和实际执行结果。</p>
				</Card>
			</div>
		);
	}
	const idx = attemptIdx ?? Math.max(0, rec.attempts.length - 1);
	const att = rec.attempts[idx];

	return (
		<div className="col right">
			<Card title={`T${rec.turn} 模型输入 / 输出`} right={att?.streaming ? <span className="pill state-deciding">生成中… <Waited since={att.startedAt} /></span> : undefined}>
				{rec.attempts.length > 1 && (
					<div className="tabs small">
						{rec.attempts.map((a, i) => (
							<button key={a.n} className={i === idx ? "on" : ""} onClick={() => setAttemptIdx(i)}>
								第 {a.n} 次{a.parseError ? " ✗" : ""}
							</button>
						))}
					</div>
				)}
				{att?.failed && <p className="warn-text">模型调用失败（不重试）：{att.failed}</p>}
				{!att ? (
					<p className="empty">{rec.parsed ? "（随机基线，没有调用模型）" : "等待模型…"}</p>
				) : (
					<>
						<PromptView att={att} />
						<Thinking att={att} />
						<Answer att={att} />
					</>
				)}
			</Card>

			<Card title="解析与执行">
				{rec.parsed ? (
					<div className="parsed">
						<div>
							选择：<b>{rec.parsed.label}</b> <code>{rec.parsed.choice}</code>
							{rec.parsed.attempts > 1 && <span className="chip warn">用了 {rec.parsed.attempts} 次尝试</span>}
						</div>
						<div className="reason">“{rec.parsed.reason || "（没有给理由）"}”</div>
					</div>
				) : (
					<p className="empty">{att?.parseError ? "解析失败" : "还没有解析出动作"}</p>
				)}
				{att?.parseError && <p className="warn-text">解析问题：{att.parseError}</p>}
				{confirmable && rec.confirm && (
					<div className="confirm">
						<span>
							等待确认：<b>{rec.confirm.label}</b>
						</span>
						<button className="primary" onClick={() => onConfirm(true)}>
							执行
						</button>
						<button onClick={() => onConfirm(false)}>否决</button>
					</div>
				)}
				<div className="exec">
					{rec.executing && (
						<span className="chip state-executing">
							正在按键：{rec.executing.label}
						</span>
					)}
					{rec.exec &&
						(rec.exec.ok ? (
							<span className="chip ok">✓ 已执行{rec.exec.note ? `（${rec.exec.note}）` : ""}</span>
						) : (
							<span className="chip bad">
								✗ {rec.exec.reason}：{rec.exec.detail}
							</span>
						))}
				</div>
				{att && (
					<p className="hint">
						{att.latencyMs !== undefined && `${(att.latencyMs / 1000).toFixed(1)}s`}
						{att.usage?.inputTokens !== undefined && ` · 输入 ${att.usage.inputTokens} tok`}
						{att.usage?.outputTokens !== undefined && ` · 输出 ${att.usage.outputTokens} tok`}
						{att.model && ` · ${att.model}`}
					</p>
				)}
			</Card>
			{live && <p className="hint pad">点击中间的时间线可以查看任意回合的模型输入输出。</p>}
		</div>
	);
}

/** 每秒刷新的“已等待 X 秒”（旧日志没有时间戳就不显示） */
function Waited({ since }: { since?: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (since === undefined) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [since]);
	if (since === undefined) return null;
	return <>已等待 {Math.max(0, Math.round((now - since) / 1000))} 秒</>;
}

function PromptView({ att }: { att: Attempt }) {
	const sys = att.messages.find((m) => m.role === "system");
	const rest = att.messages.filter((m) => m.role !== "system");
	const last = rest.at(-1);
	const earlier = rest.slice(0, -1);
	return (
		<Collapsible title="发送给模型的内容" badge={`${att.messages.length} 条消息`}>
			{sys && (
				<Collapsible title="system（base_prompt + 输出协议）">
					<pre className="prompt">{sys.content}</pre>
				</Collapsible>
			)}
			{earlier.length > 0 && (
				<Collapsible title={`历史对话（${earlier.length} 条）`}>
					{earlier.map((m, i) => (
						<div key={i} className={`msg ${m.role}`}>
							<span className="role">{m.role === "user" ? "用户" : "模型"}</span>
							<pre className="prompt">{pretty(m.content)}</pre>
						</div>
					))}
				</Collapsible>
			)}
			{last && (
				<div className={`msg ${last.role}`}>
					<span className="role">本回合（{last.role === "user" ? "用户" : "模型"}）</span>
					<pre className="prompt">{pretty(last.content)}</pre>
				</div>
			)}
		</Collapsible>
	);
}

/** 观测消息是 "当前状态…：\n{json}"，把 JSON 部分缩进显示。 */
function pretty(content: string): string {
	const i = content.indexOf("\n{");
	if (i < 0) return content;
	try {
		return `${content.slice(0, i)}\n${JSON.stringify(JSON.parse(content.slice(i + 1)), null, 1)}`;
	} catch {
		return content;
	}
}

function Thinking({ att }: { att: Attempt }) {
	const ref = useRef<HTMLPreElement>(null);
	useEffect(() => {
		if (att.streaming && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [att.reasoning, att.streaming]);
	return (
		<div className="block">
			<div className="block-h">
				思考 <span className="muted">{att.reasoning.length} 字</span>
			</div>
			{att.reasoning ? (
				<pre ref={ref} className="think">
					{att.reasoning}
				</pre>
			) : (
				<p className="empty">{att.streaming ? "…" : "（模型没有返回思考内容）"}</p>
			)}
		</div>
	);
}

function Answer({ att }: { att: Attempt }) {
	return (
		<div className="block">
			<div className="block-h">回答</div>
			{att.content ? <pre className="answer">{att.content}</pre> : <p className="empty">{att.streaming ? "…" : "（空）"}</p>}
		</div>
	);
}
