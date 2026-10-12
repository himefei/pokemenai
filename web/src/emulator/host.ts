// 网页里的模拟器宿主：每个槽位一个。
//   - 启动 mGBA WebAssembly 核心，载入 ROM / 存档
//   - 通过 WebSocket 连到桥接服务（/emu-link?slot=a|b），说和 Lua 桥完全相同的协议：
//       hello / ping / read / write / press / wait / save_state / load_state / reset_keys / pause / resume
//   - 手动游玩：自己监听键盘（还原桌面 mGBA 的键位）；AI 接管时自动关闭
// 帧计时用游戏自己的 vblank 计数器（gMain.vblankCounter1）——核心的 JS 回调在这个环境里不可靠。

import { crc32, crc32HexBE } from "./crc32";
import { createCore, coreSupported } from "./core";
import type { Core } from "./core";
import { KEY_MAP, isTypingTarget, toButtons } from "./keys";
import type { GbaButton } from "./keys";
import { GMAIN, locateBases, resolveAddress } from "./memory";
import type { Bases, HostSymbols } from "./memory";

export type SlotId = "a" | "b";
export type HostPhase = "idle" | "loading" | "ready" | "error" | "viewer";
/** host＝这个页面是该槽位的模拟器宿主；viewer＝另一个页面是宿主，这个页面只看；yielded＝刚才被另一个页面接管了 */
export type HostRole = "host" | "viewer" | "yielded";

/** 服务端用这两个关闭码告诉页面为什么被断开（见 server/src/emulator/ws-hub.ts） */
const CLOSE_BUSY = 4409;
const CLOSE_REPLACED = 4001;

export interface HostStatus {
	phase: HostPhase;
	role: HostRole;
	message?: string;
	/** 与桥接服务的 WebSocket 是否连着 */
	linked: boolean;
	paused: boolean;
	speed: number;
	muted: boolean;
	fps: number;
	/** 手动游玩（键盘）是否开启 */
	manual: boolean;
	game?: string;
}

type Req = { id: number; cmd: string; [k: string]: any };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 比 setTimeout(0) 更快的"让出一下"（没有 4ms 钳制），用来按帧轮询。 */
const yieldNow = (() => {
	const ch = new MessageChannel();
	const waiters: Array<() => void> = [];
	ch.port1.onmessage = () => waiters.shift()?.();
	return () =>
		new Promise<void>((r) => {
			waiters.push(r);
			ch.port2.postMessage(0);
		});
})();

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** 页面回到前台时 resolve（已经在前台就立刻 resolve） */
export function whenVisible(): Promise<void> {
	if (document.visibilityState === "visible") return Promise.resolve();
	return new Promise((resolve) => {
		const on = () => {
			if (document.visibilityState !== "visible") return;
			document.removeEventListener("visibilitychange", on);
			resolve();
		};
		document.addEventListener("visibilitychange", on);
	});
}

export class EmulatorHost {
	readonly canvas: HTMLCanvasElement;
	private core: Core | null = null;
	private bases: Bases | null = null;
	private syms: HostSymbols | null = null;
	private rom: Uint8Array = new Uint8Array(0);
	private romBase = "emerald";
	private romCode = "";
	private romCrcHex = "";
	private link: WebSocket | null = null;
	private linkTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private listeners = new Set<(s: HostStatus) => void>();
	private fetchedStates = new Set<number>();
	private pressChain: Promise<unknown> = Promise.resolve();
	private held = new Set<GbaButton>();
	private focused = true;
	private fpsTimer: ReturnType<typeof setInterval> | undefined;
	private lastVb = 0;
	private lastVbAt = 0;
	private starting: Promise<void> | null = null;
	private corePromise: Promise<void> | null = null;

	status: HostStatus = { phase: "idle", role: "host", linked: false, paused: false, speed: 1, muted: true, fps: 0, manual: true };

	constructor(readonly slot: SlotId) {
		this.canvas = document.createElement("canvas");
		this.canvas.width = 240;
		this.canvas.height = 160;
		this.canvas.className = "gba-canvas";
		window.addEventListener("keydown", this.onKeyDown);
		window.addEventListener("keyup", this.onKeyUp);
		window.addEventListener("blur", this.releaseAll);
	}

	// ---- 状态订阅 ----

	subscribe(fn: (s: HostStatus) => void): () => void {
		this.listeners.add(fn);
		fn(this.status);
		return () => this.listeners.delete(fn);
	}

	private set(patch: Partial<HostStatus>): void {
		this.status = { ...this.status, ...patch };
		for (const fn of this.listeners) fn(this.status);
	}

	// ---- 启动 ----

	/**
	 * 幂等。先问服务端这个槽位有没有页面在做宿主：有就只当观众（不启动模拟器，不去抢），
	 * 没有才启动模拟器并成为宿主。想把模拟器挪到这个页面用 takeover()。
	 */
	start(): Promise<void> {
		this.starting ??= this.startInner().catch((e) => {
			this.set({ phase: "error", message: (e as Error).message });
			throw e;
		});
		return this.starting;
	}

	private async startInner(): Promise<void> {
		if (await this.hostedElsewhere()) {
			this.set({ phase: "viewer", role: "viewer", message: "这个槽位的模拟器正在另一个页面里运行（同一个槽位只能有一个页面做模拟器，否则会互相抢）。" });
			return;
		}
		await this.ensureCore();
		this.connectLink(false);
	}

	/** 把模拟器挪到这个页面：顶掉另一个页面（它会收到通知并停止重连）。 */
	async takeover(): Promise<void> {
		this.set({ role: "host", message: undefined });
		await this.ensureCore();
		this.connectLink(true);
	}

	private async hostedElsewhere(): Promise<boolean> {
		try {
			const r = await fetch(`/api/s/${this.slot}/emu/host`);
			if (!r.ok) return false; // 旧版服务端没有这个接口：照旧当宿主
			return ((await r.json()) as { hosted?: boolean }).hosted === true;
		} catch {
			return false;
		}
	}

	private ensureCore(): Promise<void> {
		this.corePromise ??= this.boot().catch((e) => {
			this.corePromise = null;
			this.set({ phase: "error", message: (e as Error).message });
			throw e;
		});
		return this.corePromise;
	}

	private async boot(): Promise<void> {
		const unsupported = coreSupported();
		if (unsupported) throw new Error(unsupported);
		this.set({ phase: "loading", message: "加载 ROM 与存档…" });

		const [romBuf, savRes, symRes] = await Promise.all([fetch("/api/assets/rom"), fetch("/api/assets/sav"), fetch("/api/symbols")]);
		if (!romBuf.ok) throw new Error("服务端没有找到 ROM（项目根目录需要有 .gba 文件）");
		this.rom = new Uint8Array(await romBuf.arrayBuffer());
		this.syms = ((await symRes.json()) as { symbols: HostSymbols }).symbols;
		const sav = savRes.ok ? new Uint8Array(await savRes.arrayBuffer()) : null;
		this.romCode = new TextDecoder().decode(this.rom.subarray(0xac, 0xb0));
		const title = new TextDecoder().decode(this.rom.subarray(0xa0, 0xac)).replace(/\0+$/, "");
		this.romCrcHex = crc32HexBE(this.rom);
		this.set({ game: `${title} (${this.romCode})`, message: "启动 mGBA 核心…" });

		this.core = await createCore(this.canvas);
		const { M } = this.core;
		await M.FSInit();
		// 评测要可复现：关掉自动存档/恢复和回退缓冲（回退缓冲会在内存里留一堆旧副本）
		M.setCoreSettings({ autoSaveStateEnable: false, restoreAutoSaveStateOnLoad: false, rewindEnable: false, allowOpposingDirections: true });
		const p = M.filePaths();
		M.FS.writeFile(`${p.gamePath}/${this.romBase}.gba`, this.rom);
		// 每次启动都用服务端的存档副本，保证起点一致（不碰原始 .sav）
		if (sav) M.FS.writeFile(`${p.savePath}/${this.romBase}.sav`, sav);
		if (!M.loadGame(`${p.gamePath}/${this.romBase}.gba`)) throw new Error("核心载入 ROM 失败");
		M.toggleInput(false); // 核心自带的键盘处理关掉，用我们自己的键位
		M.setVolume(0); // 默认静音：两个实例同时出声会很吵，需要时再开
		this.set({ message: "定位模拟器内存…" });

		// 页面在后台时浏览器会停掉动画帧，核心也就不跑：等页面回到前台再找，不要白白超时
		for (let tries = 0; tries < 80 && !this.bases; ) {
			if (document.visibilityState !== "visible") {
				this.set({ message: "页面在后台，模拟器暂停中——切回这个页面后继续" });
				await whenVisible();
				this.set({ message: "定位模拟器内存…" });
			}
			await sleep(250);
			this.bases = await locateBases(this.heap(), this.syms, sleep);
			tries++;
		}
		if (!this.bases) throw new Error("没能在核心内存里定位到 GBA 内存（游戏没有跑起来？页面是否在前台？）");

		this.set({ phase: "ready", message: undefined });
		this.fpsTimer = setInterval(() => this.sampleFps(), 1000);
	}

	// ---- 内存访问 ----

	private heap(): Uint8Array {
		return new Uint8Array(this.core!.mem.buffer);
	}

	private view(addr: number, len: number, forWrite = false): Uint8Array {
		const r = resolveAddress(addr, len, this.rom.length);
		if (!r) throw new Error(`unsupported address 0x${(addr >>> 0).toString(16)} (+${len})`);
		if (r.kind === "rom") {
			if (forWrite) throw new Error("ROM is read-only");
			return this.rom.subarray(r.offset, r.offset + len);
		}
		const base = r.kind === "ewram" ? this.bases!.ew : this.bases!.iw;
		return new Uint8Array(this.core!.mem.buffer, base + r.offset, len);
	}

	/** 游戏自己的帧计数（gMain.vblankCounter1）。 */
	private vb(): number {
		const dv = new DataView(this.core!.mem.buffer);
		return dv.getUint32(this.bases!.iw + (this.syms!.gMain - 0x03000000) + GMAIN.vblankCounter1, true);
	}

	private sampleFps(): void {
		if (!this.core || !this.bases) return;
		const now = performance.now();
		const vb = this.vb();
		if (this.lastVbAt) this.set({ fps: Math.round(((vb - this.lastVb) * 1000) / (now - this.lastVbAt)) });
		this.lastVb = vb;
		this.lastVbAt = now;
	}

	/** 等 n 帧（按游戏帧计）。暂停期间不推进；几秒完全不动就报错，免得请求永远挂着。 */
	private async frames(n: number): Promise<void> {
		const start = this.vb();
		let last = start;
		let lastMove = performance.now();
		while (((this.vb() - start) >>> 0) < n) {
			await yieldNow();
			const v = this.vb();
			if (v !== last) {
				last = v;
				lastMove = performance.now();
			} else if (performance.now() - lastMove > 10000) {
				throw new Error(this.status.paused ? "模拟器处于暂停状态，帧不推进" : "游戏 10 秒没有推进帧（页面在后台被挂起？）");
			}
		}
	}

	// ---- 与桥接服务的协议连接 ----

	private connectLink(force: boolean): void {
		if (this.disposed) return;
		this.link?.close();
		const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/emu-link?slot=${this.slot}${force ? "&force=1" : ""}`);
		this.link = ws;
		ws.onopen = () => this.set({ linked: true, role: "host" });
		ws.onmessage = (ev) => {
			for (const line of String(ev.data).split("\n")) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as Req & { type?: string };
				if (msg.type) continue; // "busy" / "replaced" 之类的通知，真正的处理看关闭码
				void this.handle(msg).then((resp) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(resp)));
			}
		};
		ws.onclose = (ev) => {
			if (this.link !== ws) return; // 已经换成新的连接了
			this.set({ linked: false });
			if (ev.code === CLOSE_BUSY) {
				// 另一个页面先到了：当观众，不要自动重连去抢
				this.setPaused(true);
				this.set({ role: "viewer", message: "这个槽位的模拟器正在另一个页面里运行。" });
				return;
			}
			if (ev.code === CLOSE_REPLACED) {
				// 被另一个页面接管了：停下来，别自动重连把它顶回去
				this.setPaused(true);
				this.set({ role: "yielded", message: "模拟器已被另一个页面接管。" });
				return;
			}
			if (!this.disposed) this.linkTimer = setTimeout(() => this.connectLink(false), 1000);
		};
		ws.onerror = () => ws.close();
	}

	private async handle(req: Req): Promise<Record<string, unknown>> {
		try {
			return { id: req.id, ok: true, ...(await this.dispatch(req)) };
		} catch (e) {
			return { id: req.id, ok: false, error: (e as Error).message };
		}
	}

	private async dispatch(req: Req): Promise<Record<string, unknown>> {
		const M = this.core?.M;
		if (!M || !this.bases) throw new Error("emulator not ready");
		switch (req.cmd) {
			case "hello":
				return { protocol: 1, game_code: `AGB-${this.romCode}`, game_title: this.status.game, rom_crc32: this.romCrcHex.toUpperCase(), rom_crc32_raw_hex: this.romCrcHex, frame: this.vb() };
			case "ping":
				return { frame: this.vb() };
			case "read": {
				const ranges = req.ranges as Array<{ addr: number; len: number }>;
				return { data: ranges.map((r) => hex(this.view(r.addr, r.len))), frame: this.vb() };
			}
			case "write": {
				const bytes = unhex(req.hex as string);
				this.view(req.addr as number, bytes.length, true).set(bytes);
				return { written: bytes.length };
			}
			case "press":
				return this.serial(async () => {
					const start = this.vb();
					for (const step of req.seq as Array<{ keys: string[]; hold?: number; wait?: number }>) {
						const buttons = toButtons(step.keys ?? []);
						for (const b of buttons) M.buttonPress(b);
						try {
							await this.frames(Math.max(1, Math.floor(step.hold ?? 4)));
						} finally {
							for (const b of buttons) M.buttonUnpress(b);
						}
						await this.frames(Math.max(0, Math.floor(step.wait ?? 6)));
					}
					return { frames: (this.vb() - start) >>> 0, frame: this.vb() };
				});
			case "wait":
				return this.serial(async () => {
					const start = this.vb();
					await this.frames(Math.max(0, Math.floor(req.frames ?? 0)));
					return { frames: (this.vb() - start) >>> 0, frame: this.vb() };
				});
			case "save_state": {
				const slot = Number(req.slot ?? 1);
				if (!M.saveState(slot)) throw new Error("save_state failed");
				return { frame: this.vb() };
			}
			case "load_state": {
				await this.loadSlot(Number(req.slot ?? 1));
				return { frame: this.vb() };
			}
			case "reset_keys":
				this.releaseAll();
				return {};
			case "pause":
				this.setPaused(true);
				return {};
			case "resume":
				this.setPaused(false);
				return {};
			case "screenshot":
				return {};
			default:
				throw new Error(`unknown cmd: ${req.cmd}`);
		}
	}

	/** press / wait 排队执行（和 Lua 桥一致），read / write 不排队。 */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.pressChain.then(fn, fn);
		this.pressChain = run.catch(() => {});
		return run;
	}

	// ---- 给 UI 用的控制 ----

	setPaused(paused: boolean): void {
		if (!this.core) return;
		if (paused) this.core.M.pauseGame();
		else this.core.M.resumeGame();
		this.set({ paused });
	}

	setSpeed(n: number): void {
		this.core?.M.setFastForwardMultiplier(n);
		this.set({ speed: n });
	}

	setMuted(muted: boolean): void {
		this.core?.M.setVolume(muted ? 0 : 1);
		this.set({ muted });
	}

	setManual(on: boolean): void {
		if (!on) this.releaseAll();
		this.set({ manual: on });
	}

	setFocused(on: boolean): void {
		this.focused = on;
		if (!on) this.releaseAll();
	}

	/** 读存档点：服务端有的（.ssN）优先从服务端取一次，没有就用核心里自己存过的。 */
	async loadSlot(slot: number): Promise<void> {
		const M = this.core?.M;
		if (!M) throw new Error("emulator not ready");
		const p = M.filePaths();
		const path = `${p.saveStatePath}/${this.romBase}.ss${slot}`;
		if (!this.fetchedStates.has(slot)) {
			this.fetchedStates.add(slot);
			const r = await fetch(`/api/assets/state/${slot}`);
			if (r.ok) M.FS.writeFile(path, new Uint8Array(await r.arrayBuffer()));
		}
		if (!M.FS.analyzePath(path).exists) throw new Error(`没有存档点 ${slot}`);
		this.releaseAll();
		if (!M.loadState(slot)) throw new Error(`读取存档点 ${slot} 失败`);
		// 状态刚读进来，等游戏跑一两帧（暂停着的话帧不会推进，不用等——对比开始时就是先暂停再读）
		if (!this.status.paused) await this.frames(2);
	}

	saveSlot(slot: number): boolean {
		return this.core?.M.saveState(slot) ?? false;
	}

	/** 当前游戏内存档（.sav）下载用。 */
	exportSave(): Uint8Array | null {
		return this.core?.M.getSave() ?? null;
	}

	reset(): void {
		this.releaseAll();
		this.core?.M.quickReload();
	}

	// ---- 键盘（手动游玩） ----

	private onKeyDown = (e: KeyboardEvent) => {
		const b = KEY_MAP[e.code];
		if (!b || e.repeat || !this.status.manual || !this.focused || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
		if (!this.core || !this.bases) return;
		e.preventDefault();
		this.held.add(b);
		this.core.M.buttonPress(b);
	};

	private onKeyUp = (e: KeyboardEvent) => {
		const b = KEY_MAP[e.code];
		if (!b || !this.held.has(b)) return;
		this.held.delete(b);
		this.core?.M.buttonUnpress(b);
	};

	private releaseAll = () => {
		for (const b of this.held) this.core?.M.buttonUnpress(b);
		this.held.clear();
	};

	// ---- 清理 ----

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.linkTimer);
		clearInterval(this.fpsTimer);
		this.link?.close();
		window.removeEventListener("keydown", this.onKeyDown);
		window.removeEventListener("keyup", this.onKeyUp);
		window.removeEventListener("blur", this.releaseAll);
	}
}

const registry = new Map<SlotId, EmulatorHost>();

/** 每个槽位一个常驻宿主：React 重新挂载 / 切换"对比"模式时游戏不会重启。 */
export function getHost(slot: SlotId): EmulatorHost {
	let h = registry.get(slot);
	if (!h) registry.set(slot, (h = new EmulatorHost(slot)));
	return h;
}

export { crc32 };
