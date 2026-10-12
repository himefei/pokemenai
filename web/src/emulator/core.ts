// 加载 mGBA 的 WebAssembly 核心（public/core/mgba.js + mgba.wasm）。
// 核心不暴露自己的线性内存，所以在创建它之前拦截 WebAssembly.Memory，把核心创建的共享内存抓出来——
// 之后读写模拟器内存就是读写这块内存。

export interface MgbaModule {
	version: { projectName: string; projectVersion: string };
	FSInit(): Promise<void>;
	FS: {
		writeFile(path: string, data: Uint8Array): void;
		readFile(path: string): Uint8Array;
		readdir(path: string): string[];
		analyzePath(path: string): { exists: boolean };
		unlink(path: string): void;
	};
	filePaths(): { gamePath: string; savePath: string; saveStatePath: string; root: string };
	setCoreSettings(s: Record<string, unknown>): void;
	loadGame(path: string, savePathOverride?: string): boolean;
	buttonPress(name: string): void;
	buttonUnpress(name: string): void;
	toggleInput(enabled: boolean): void;
	saveState(slot: number): boolean;
	loadState(slot: number): boolean;
	pauseGame(): void;
	resumeGame(): void;
	quickReload(): void;
	setFastForwardMultiplier(n: number): void;
	setVolume(v: number): void;
	getSave(): Uint8Array | null;
}

export interface Core {
	M: MgbaModule;
	/** 核心的共享线性内存 */
	mem: WebAssembly.Memory;
}

type Factory = (opts: { canvas: HTMLCanvasElement }) => Promise<MgbaModule>;

const captured: WebAssembly.Memory[] = [];
let patched = false;
let factoryPromise: Promise<Factory> | null = null;
/** 核心创建要一个接一个来，才能确定"刚创建的那块内存"属于哪个实例 */
let chain: Promise<unknown> = Promise.resolve();

function patchMemory(): void {
	if (patched) return;
	patched = true;
	const Orig = WebAssembly.Memory;
	const Patched = function (this: unknown, desc: WebAssembly.MemoryDescriptor) {
		const m = new Orig(desc);
		captured.push(m);
		return m;
	} as unknown as typeof WebAssembly.Memory;
	Patched.prototype = Orig.prototype;
	(WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = Patched;
}

export function coreSupported(): string | null {
	if (typeof SharedArrayBuffer === "undefined" || !globalThis.crossOriginIsolated) {
		return "页面没有跨源隔离（SharedArrayBuffer 不可用）：请通过桥接服务（npm run serve）或 Vite 开发服务器打开，不要直接打开本地文件。";
	}
	return null;
}

export function createCore(canvas: HTMLCanvasElement): Promise<Core> {
	const run = async (): Promise<Core> => {
		patchMemory();
		const url = "/core/mgba.js"; // 运行时按 URL 加载（public/core），不参与打包
		factoryPromise ??= import(/* @vite-ignore */ url).then((m: { default: Factory }) => m.default);
		const factory = await factoryPromise;
		const before = captured.length;
		const M = await factory({ canvas });
		const mem = captured.slice(before).find((m) => (m.buffer as ArrayBufferLike) instanceof SharedArrayBuffer) ?? captured[before];
		if (!mem) throw new Error("没能抓到核心的线性内存");
		return { M, mem };
	};
	const p = chain.then(run, run);
	chain = p.catch(() => {});
	return p;
}
