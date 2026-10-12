import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { SlotContext, compareApi, makeApi } from "./api";
import type { SlotId } from "./api";
import { BattlePanel } from "./components/BattlePanel";
import { EmulatorPane, GBA_W } from "./components/EmulatorPane";
import { EvalTab, HistoryTab, StatsTab } from "./components/History";
import { LeftPanel, stateLabel } from "./components/LeftPanel";
import { ModelIO } from "./components/ModelIO";
import { useAgent } from "./useAgent";

type Tab = "battle" | "history" | "stats" | "eval";

const COMPARE_KEY = "pba.compare";
const readCompare = () => {
	try {
		return localStorage.getItem(COMPARE_KEY) === "1";
	} catch {
		return false;
	}
};

export function App() {
	const [compare, setCompare] = useState(readCompare);
	const [focused, setFocused] = useState<SlotId>("a");
	const [stateSlot, setStateSlot] = useState(2);
	const [seed, setSeed] = useState("");
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

	const toggle = () => {
		const next = !compare;
		setCompare(next);
		setMsg(null);
		try {
			localStorage.setItem(COMPARE_KEY, next ? "1" : "0");
		} catch {
			/* 记不住也无所谓 */
		}
	};

	const start = async () => {
		setMsg(null);
		try {
			const r = await compareApi.start(stateSlot, seed.trim() ? Number(seed) : undefined);
			setMsg({ ok: true, text: `已同时开始：两边都读存档点 ${stateSlot}，随机数种子 ${r.seed}` });
		} catch (e) {
			setMsg({ ok: false, text: (e as Error).message });
		}
	};

	return (
		<div className="app">
			<header className="top">
				<h1>宝可梦 · 战斗接管器</h1>
				<button className={compare ? "primary" : ""} onClick={toggle} title="上下分屏：两个游戏、两个模型同时玩，直接对比">
					{compare ? "退出对比" : "对比"}
				</button>
				{compare && (
					<div className="compare-bar">
						<select value={stateSlot} onChange={(e) => setStateSlot(Number(e.target.value))} title="两边都从这个存档点开始">
							{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
								<option key={n} value={n}>
									存档点 {n}
								</option>
							))}
						</select>
						<input className="seed" placeholder="随机数种子（可选）" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))} title="两边写同一个种子：同样的决策会得到同样的结果" />
						<button className="primary" onClick={start} title="两边暂停 → 读同一个存档点 → 写同一个随机数种子 → 同时继续并接管">
							同时开始
						</button>
						<button className="danger" onClick={() => void compareApi.stopAll()}>
							全部急停
						</button>
						{msg && <span className={msg.ok ? "ok-text" : "warn-text"}>{msg.text}</span>}
					</div>
				)}
			</header>
			<div className={compare ? "slots split" : "slots"}>
				<SlotView slot="a" label={compare ? "A" : undefined} compact={compare} focused={!compare || focused === "a"} onFocus={() => setFocused("a")} />
				{compare && <SlotView slot="b" label="B" compact focused={focused === "b"} onFocus={() => setFocused("b")} />}
			</div>
		</div>
	);
}

/** 画面倍率：单游戏默认 4x（960×640），对比分屏默认 2x（每半屏高度有限）；记住每个槽位 / 模式各自的选择。 */
function useScale(slot: SlotId, compact: boolean): [number, (n: number) => void] {
	const key = `pba.scale.${slot}.${compact ? "c" : "s"}`;
	const [scale, setScale] = useState<number>(() => {
		try {
			const v = Number(localStorage.getItem(key));
			if (v >= 1 && v <= 8) return v;
		} catch {
			/* 没有 localStorage 就用默认 */
		}
		return compact ? 2 : 4;
	});
	useEffect(() => {
		try {
			const v = Number(localStorage.getItem(key));
			setScale(v >= 1 && v <= 8 ? v : compact ? 2 : 4);
		} catch {
			setScale(compact ? 2 : 4);
		}
	}, [key, compact]);
	return [
		scale,
		(n) => {
			setScale(n);
			try {
				localStorage.setItem(key, String(n));
			} catch {
				/* 记不住也无所谓 */
			}
		},
	];
}

/** 一个槽位 = 一个游戏画面 + 一个模型 + 完整的信息界面（战斗 / 历史 / 统计 / 评测）。 */
function SlotView({ slot, label, compact, focused, onFocus }: { slot: SlotId; label?: string; compact: boolean; focused: boolean; onFocus: () => void }) {
	const api = useMemo(() => makeApi(slot), [slot]);
	const { state, ws, server, refreshServer } = useAgent(slot);
	const [tab, setTab] = useState<Tab>("battle");
	const [scale, setScale] = useScale(slot, compact);
	const [picked, setPicked] = useState<number | null>(null);
	const [follow, setFollow] = useState(true);

	const last = state.records.at(-1);
	// 默认跟随最新决策；点了时间线某一行就固定在那一回合，点"跟随最新"恢复
	useEffect(() => {
		if (follow) setPicked(last?.id ?? null);
	}, [follow, last?.id]);
	const rec = useMemo(() => state.records.find((r) => r.id === picked) ?? last, [state.records, picked, last]);

	const pendingConfirm = last?.confirm ?? null;
	const st = state.controller.state;
	const aiBusy = !["idle", "finished", "needs_human"].includes(st);

	return (
		<SlotContext.Provider value={api}>
			<section className={`slot ${compact ? "compact" : ""}`}>
				<div className="slot-top">
					{label && <span className="slot-label">{label}</span>}
					<nav className="tabs">
						{(
							[
								["battle", "战斗"],
								["history", "历史"],
								["stats", "统计"],
								["eval", "评测"],
							] as const
						).map(([k, name]) => (
							<button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
								{name}
							</button>
						))}
					</nav>
					<div className="pills">
						<span className={`pill ${ws === "open" ? "ok" : "bad"}`}>服务 {ws === "open" ? "在线" : ws === "connecting" ? "连接中" : "离线"}</span>
						<span className={`pill ${state.emu?.connected ? "ok" : "bad"}`}>模拟器 {state.emu?.connected ? "已连接" : "未连接"}</span>
						<span className={`pill ${state.emu?.romOk ? "ok" : "bad"}`}>ROM {state.emu?.romOk ? "已验证" : "未验证"}</span>
						<span className={`pill state-${st}`}>{stateLabel(st)}</span>
					</div>
				</div>

				{ws !== "open" && (
					<div className="banner">
						连不上桥接服务。请在终端运行 <code>cd server &amp;&amp; npm run serve</code>，页面会自动重连。
					</div>
				)}

				{tab === "battle" && (
					<main className="grid3" style={{ "--game-w": `${GBA_W * scale + 30}px` } as CSSProperties}>
						<LeftPanel state={state} server={server} refresh={refreshServer} pendingConfirm={pendingConfirm} />
						<div className="col mid">
							<BattlePanel
								state={state}
								selectedId={rec?.id ?? null}
								onSelect={(id) => {
									setPicked(id);
									setFollow(id === last?.id);
								}}
								live
							/>
						</div>
						<div className="right-wrap io">
							{state.records.length > 0 && (
								<label className="check follow">
									<input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
									跟随最新回合
								</label>
							)}
							<ModelIO rec={rec} live confirmable onConfirm={(ok) => void api.confirm(ok).then(refreshServer)} />
						</div>
						{/* 游戏画面放在最右侧：16:9 的屏幕上竖向内容已经很多，横向空间更宽裕 */}
						<div className="col game">
							<EmulatorPane slot={slot} aiBusy={aiBusy} focused={focused} onFocus={onFocus} scale={scale} onScale={setScale} />
						</div>
					</main>
				)}
				{tab === "history" && <HistoryTab />}
				{tab === "stats" && (
					<main className="single">
						<StatsTab />
					</main>
				)}
				{tab === "eval" && (
					<main className="single">
						<EvalTab />
					</main>
				)}
			</section>
		</SlotContext.Provider>
	);
}
