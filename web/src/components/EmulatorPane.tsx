import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getHost } from "../emulator/host";
import type { HostStatus, SlotId } from "../emulator/host";

const SPEEDS = [1, 2, 4, 8];

/**
 * 网页里的 GBA 模拟器：画面 + 控制条。
 * AI 接管期间自动关闭键盘（避免和注入的按键叠加）；没人接管时可以用键盘正常玩：
 *   K=A  J=B  L=L  ;=R  M=Start  N=Select  W/A/S/D=方向
 */
export const SCALES = [2, 3, 4, 5, 6];
export const GBA_W = 240;

export function EmulatorPane({ slot, aiBusy, focused, onFocus, scale, onScale }: { slot: SlotId; aiBusy: boolean; focused: boolean; onFocus: () => void; scale: number; onScale: (n: number) => void }) {
	const host = getHost(slot);
	const boxRef = useRef<HTMLDivElement>(null);
	const [st, setSt] = useState<HostStatus>(host.status);
	const [manualPref, setManualPref] = useState(true);
	const [stateSlot, setStateSlot] = useState(1);
	const [note, setNote] = useState("");

	useEffect(() => {
		const box = boxRef.current!;
		box.appendChild(host.canvas);
		void host.start().catch(() => {});
		const off = host.subscribe(setSt);
		return () => {
			off();
			host.canvas.remove(); // 宿主常驻：游戏不会因为界面切换而重启
		};
	}, [host]);

	useEffect(() => host.setManual(manualPref && !aiBusy), [host, manualPref, aiBusy]);
	useEffect(() => host.setFocused(focused), [host, focused]);

	const run = async (fn: () => unknown | Promise<unknown>, okMsg = "") => {
		setNote("");
		try {
			await fn();
			setNote(okMsg);
		} catch (e) {
			setNote((e as Error).message);
		}
	};
	const ready = st.phase === "ready" && st.role === "host";
	const notHost = st.phase === "viewer" || st.role !== "host";
	const download = () => {
		const bytes = host.exportSave();
		if (!bytes) return setNote("现在没有可导出的游戏内存档");
		const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `pokemon-emerald-${slot}.sav`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<section className={`card emu ${focused ? "focused" : ""}`} onMouseDown={onFocus}>
			<header className="card-h">
				<h3>游戏画面</h3>
				<span className="emu-stat">
					{st.phase === "viewer" || st.role !== "host" ? (
						<span className="bad">{st.role === "yielded" ? "已被接管" : "观众"}</span>
					) : st.phase === "ready" ? (
						<>
							<span className={`dot ${st.linked ? "ok" : "bad"}`} title={st.linked ? "已连上桥接服务（AI 可以操作）" : "没连上桥接服务"} />
							{st.paused ? "已暂停" : `${st.fps} 帧/秒`}
							{aiBusy ? " · AI 控制中" : manualPref ? " · 键盘可玩" : ""}
						</>
					) : st.phase === "error" ? (
						<span className="bad">出错</span>
					) : (
						"启动中…"
					)}
				</span>
			</header>
			<div className="card-b">
				<div className="screen" ref={boxRef} style={{ "--canvas-w": `${GBA_W * scale}px` } as CSSProperties}>
					{!ready && (
						<div className="screen-msg">
							<div>
								<p>{notHost ? st.message : st.phase === "error" ? st.message : (st.message ?? "启动中…")}</p>
								{notHost && (
									<button className="primary" onClick={() => run(() => host.takeover())}>
										让这个页面成为模拟器
									</button>
								)}
							</div>
						</div>
					)}
				</div>
				<div className="emu-bar">
					<button disabled={!ready} onClick={() => host.setPaused(!st.paused)} title={st.paused ? "继续" : "暂停"}>
						{st.paused ? "▶ 继续" : "⏸ 暂停"}
					</button>
					<select value={scale} onChange={(e) => onScale(Number(e.target.value))} title="画面大小（GBA 原生 240×160 的几倍）">
						{SCALES.map((n) => (
							<option key={n} value={n}>
								画面 {n}x（{GBA_W * n}×{(GBA_W * n * 2) / 3}）
							</option>
						))}
					</select>
					<select disabled={!ready} value={st.speed} onChange={(e) => host.setSpeed(Number(e.target.value))} title="快进倍速">
						{SPEEDS.map((s) => (
							<option key={s} value={s}>
								{s}x
							</option>
						))}
					</select>
					<button disabled={!ready} onClick={() => host.setMuted(!st.muted)} title="声音">
						{st.muted ? "🔇" : "🔊"}
					</button>
					<button disabled={!ready || aiBusy} onClick={() => host.reset()}>
						重置
					</button>
					<select value={stateSlot} onChange={(e) => setStateSlot(Number(e.target.value))} title="存档点（save state）">
						{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
							<option key={n} value={n}>
								存档点 {n}
							</option>
						))}
					</select>
					<button disabled={!ready || aiBusy} onClick={() => run(() => host.loadSlot(stateSlot), `已读取存档点 ${stateSlot}`)}>
						读取
					</button>
					<button disabled={!ready || aiBusy} onClick={() => run(() => host.saveSlot(stateSlot) || Promise.reject(new Error("保存失败")), `已保存到存档点 ${stateSlot}（在浏览器里）`)}>
						保存
					</button>
					<button disabled={!ready} onClick={download} title="下载游戏内存档（.sav）">
						导出存档
					</button>
				</div>
				<label className="check">
					<input type="checkbox" checked={manualPref} onChange={(e) => setManualPref(e.target.checked)} />
					用键盘手动玩（K=A J=B L=L ;=R M=开始 N=选择 WASD=方向；AI 接管时自动关闭）
				</label>
				{note && <p className="hint">{note}</p>}
				<p className="hint">请保持这个页面在前台：浏览器会暂停后台页面，游戏就不跑了。</p>
			</div>
		</section>
	);
}
