import type { AgentState, TurnRecord } from "../store";
import { buildTimeline } from "../store";
import type { OpponentView, OwnMonView } from "../types";
import { Card, Collapsible, HpBar, Stages, StatusChips, TypeChip } from "./bits";

export function BattlePanel({ state, selectedId, onSelect, live }: { state: AgentState; selectedId: number | null; onSelect: (id: number) => void; live: boolean }) {
	const rec = state.records.find((r) => r.id === selectedId) ?? state.records.at(-1);
	const obs = rec?.observation;
	return (
		<div className="stack">
			{!obs ? (
				<Card title="战斗">
					<p className="empty">
						{live ? "还没有战斗数据。进入战斗后点“接管当前战斗”（或先“武装”），这里会实时显示模型看到的场面。" : "这个 run 没有战斗记录。"}
					</p>
				</Card>
			) : (
				<>
					<div className="battle-head">
						<b>第 {obs.turn} 回合</b>
						{obs.field.weather && <span className="chip">天气：{obs.field.weather}</span>}
						{obs.field.opponent_side.map((s) => (
							<span key={`o${s}`} className="chip">
								对手方：{s}
							</span>
						))}
						{obs.field.your_side.map((s) => (
							<span key={`y${s}`} className="chip">
								我方：{s}
							</span>
						))}
						{obs.opponent_remaining !== null && (
							<span className="chip">
								对手剩余 {obs.opponent_remaining}/{obs.opponent_party_size}
							</span>
						)}
					</div>
					<div className="duel">
						<OpponentCard o={obs.opponent} />
						<YouCard m={obs.you.active} />
					</div>
					<Party party={obs.you.party} />
					<Messages rec={rec!} texts={state.texts} live={live} />
					<Collapsible title="操作者视角：内存真值（不会发给模型）">
						<pre className="json">{JSON.stringify(rec!.truth, null, 1)}</pre>
					</Collapsible>
				</>
			)}
			<Timeline records={state.records} selectedId={rec?.id ?? null} onSelect={onSelect} summary={state.summary} />
		</div>
	);
}

function OpponentCard({ o }: { o: OpponentView }) {
	return (
		<Card title="对手（你看到的）" className="opp">
			<div className="mon-name">
				<b>{o.species}</b> <span className="muted">Lv{o.level}</span>
				{o.types.map((t) => (
					<TypeChip key={t} type={t} />
				))}
			</div>
			<HpBar percent={o.hp_percent} label={`${o.hp_percent}%`} />
			<div className="chips">
				<StatusChips status={o.status} />
			</div>
			<div className="kv small">
				<span>已知招式</span>
				<span className="moves-known">
					{o.known_moves.map((m) => (
						<span key={m.name} className="chip move">
							{m.name}
						</span>
					))}
					{Array.from({ length: o.unknown_move_slots }, (_, i) => (
						<span key={i} className="chip unknown">
							？
						</span>
					))}
				</span>
				<span>特性</span>
				<span>{o.ability ?? <i className="muted">未知</i>}</span>
				<span>持有物</span>
				<span>{o.item ?? <i className="muted">未知</i>}</span>
			</div>
		</Card>
	);
}

function YouCard({ m }: { m: OwnMonView }) {
	return (
		<Card title="我方" className="you">
			<div className="mon-name">
				<b>{m.species}</b> <span className="muted">Lv{m.level}</span>
				{m.types.map((t) => (
					<TypeChip key={t} type={t} />
				))}
			</div>
			<HpBar percent={(m.hp / Math.max(1, m.max_hp)) * 100} label={`${m.hp}/${m.max_hp}`} />
			<div className="chips">
				<StatusChips status={m.status} volatile={m.volatile} />
			</div>
			{m.stat_stages && <Stages stages={m.stat_stages} />}
			<div className="kv small">
				<span>特性</span>
				<span>{m.ability ?? "—"}</span>
				<span>持有物</span>
				<span>{m.item ?? "—"}</span>
				<span>数值</span>
				<span className="stats">
					攻{m.stats.atk} 防{m.stats.def} 特攻{m.stats.spa} 特防{m.stats.spd} 速{m.stats.spe}
				</span>
			</div>
			<ul className="moves">
				{m.moves.map((mv) => (
					<li key={mv.name} className={mv.pp === 0 ? "empty" : ""}>
						<TypeChip type={mv.type} />
						<b>{mv.name}</b>
						<span className="muted">{mv.power ? `威力${mv.power}` : "变化"}</span>
						<span className="pp">
							{mv.pp}/{mv.max_pp ?? "?"}
						</span>
					</li>
				))}
			</ul>
		</Card>
	);
}

function Party({ party }: { party: OwnMonView[] }) {
	return (
		<Card title="我方队伍">
			<div className="party">
				{party.map((p) => (
					<div key={p.party_index} className={`party-mon ${p.active ? "active" : ""} ${p.fainted ? "fainted" : ""}`}>
						<div>
							<b>{p.species}</b> <span className="muted">Lv{p.level}</span>
						</div>
						<HpBar percent={(p.hp / Math.max(1, p.max_hp)) * 100} label={p.fainted ? "倒下" : `${p.hp}/${p.max_hp}`} />
						<div className="chips">
							<StatusChips status={p.status} />
						</div>
					</div>
				))}
			</div>
		</Card>
	);
}

/** 玩家在屏幕上读到的战斗文字：本回合决策时附带的 last_turn + 实时滚动的最新文字。 */
function Messages({ rec, texts, live }: { rec: TurnRecord; texts: Array<{ text: string }>; live: boolean }) {
	const lines = rec.observation.last_turn;
	return (
		<Card title="战斗文字（模型读到的 last_turn）">
			{lines.length === 0 ? <p className="empty">（无）</p> : <ol className="msgs">{lines.map((t, i) => <li key={i}>{t}</li>)}</ol>}
			{live && texts.length > 0 && (
				<p className="hint live-line">
					最新：<b>{texts.at(-1)!.text}</b>
				</p>
			)}
		</Card>
	);
}

function Timeline({ records, selectedId, onSelect, summary }: { records: TurnRecord[]; selectedId: number | null; onSelect: (id: number) => void; summary: AgentState["summary"] }) {
	const rows = buildTimeline(records);
	return (
		<Card
			title="回合时间线"
			right={summary ? <span className={`pill outcome-${summary.outcomeName}`}>{summary.outcomeName} · {summary.turns} 回合 · 剩 {summary.partyAlive} 只</span> : undefined}
		>
			{rows.length === 0 ? (
				<p className="empty">（无）</p>
			) : (
				<table className="timeline">
					<thead>
						<tr>
							<th>回合</th>
							<th>我方</th>
							<th>动作</th>
							<th>对手 HP</th>
							<th>我方 HP</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.id} className={r.id === selectedId ? "sel" : ""} onClick={() => onSelect(r.id)}>
								<td>T{r.turn}</td>
								<td>{r.me}</td>
								<td>{r.action}</td>
								<td>{r.oppAfter === null ? `${r.oppBefore}%` : `${r.oppBefore}% → ${r.oppAfter}%`}</td>
								<td>{r.meHp}</td>
								<td>{r.status === "ok" ? "✓" : r.status === "rejected" ? "✗被拒" : r.status === "failed" ? "✗失败" : "…"}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Card>
	);
}
