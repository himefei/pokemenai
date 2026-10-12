// 在 WebAssembly 核心的线性内存里定位"模拟出来的 GBA 内存"，并把 GBA 地址映射成线性内存偏移。
//
// 这个核心没有提供读内存的接口，但它的 EWRAM（256KB）/ IWRAM（32KB）是 4096 对齐的堆分配，
// 所以：IWRAM 里的 gMain（地址来自符号表）有"callback2 是 ROM 里的 thumb 函数指针、vblank 计数每帧 +1"的特征，
// 在堆里按页扫描就能找到活的那一份（存档/回退缓冲里的旧副本不会增长）；EWRAM 紧邻在 IWRAM 前面（实测）。

export const EWRAM_SIZE = 0x40000;
export const IWRAM_SIZE = 0x8000;
const PAGE = 4096;

/** gMain 结构里的偏移（pokeemerald include/main.h） */
export const GMAIN = { callback1: 0x00, callback2: 0x04, vblankCounter1: 0x20 } as const;

export interface HostSymbols {
	gMain: number;
	gRngValue: number;
	gSaveBlock1Ptr: number;
	[k: string]: number;
}

export interface Bases {
	/** IWRAM 在线性内存里的起点 */
	iw: number;
	/** EWRAM 在线性内存里的起点 */
	ew: number;
}

const isRomThumbPtr = (v: number) => v >>> 24 === 0x08 && (v & 1) === 1;

/** 可能是 IWRAM 起点的页对齐候选（只看静态特征，不看是否在增长）。 */
export function iwramCandidates(heap: Uint8Array, gMainAddr: number): number[] {
	const gMainOff = gMainAddr - 0x03000000;
	const dv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
	const out: number[] = [];
	for (let b = PAGE; b + IWRAM_SIZE <= heap.length; b += PAGE) {
		const cb2 = dv.getUint32(b + gMainOff + GMAIN.callback2, true);
		if (!isRomThumbPtr(cb2)) continue;
		const cb1 = dv.getUint32(b + gMainOff + GMAIN.callback1, true);
		if (cb1 !== 0 && !isRomThumbPtr(cb1)) continue;
		const vb = dv.getUint32(b + gMainOff + GMAIN.vblankCounter1, true);
		if (vb === 0 || vb > 0x7fffffff) continue;
		out.push(b);
	}
	return out;
}

/**
 * 定位 IWRAM / EWRAM。需要游戏已经在跑（vblank 计数在增长）。
 * @param sleep 采样间隔（毫秒）；测试里可以传自己的"推进一帧"函数
 */
export async function locateBases(heap: Uint8Array, syms: Pick<HostSymbols, "gMain">, sleep: (ms: number) => Promise<void>): Promise<Bases | null> {
	const cands = iwramCandidates(heap, syms.gMain);
	if (cands.length === 0) return null;
	const dv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
	const vbAt = (b: number) => dv.getUint32(b + (syms.gMain - 0x03000000) + GMAIN.vblankCounter1, true);
	const before = cands.map(vbAt);
	await sleep(60);
	const live = cands.filter((b, i) => {
		const d = (vbAt(b) - before[i]!) >>> 0;
		return d >= 1 && d < 400;
	});
	if (live.length === 0) return null;
	const iw = live[0]!;
	const ew = iw - EWRAM_SIZE;
	if (ew < 0) return null;
	return { iw, ew };
}

export type Region = { kind: "ewram" | "iwram"; offset: number } | { kind: "rom"; offset: number };

/** GBA 地址 -> 区域 + 偏移（越界返回 null）。ROM 读自己手里的那份，不走模拟器内存。 */
export function resolveAddress(addr: number, len: number, romSize: number): Region | null {
	const region = addr >>> 24;
	if (region === 0x02) {
		const off = (addr & 0x00ffffff) % 0x1000000;
		return off + len <= EWRAM_SIZE ? { kind: "ewram", offset: off } : null;
	}
	if (region === 0x03) {
		const off = addr & 0x00ffffff;
		return off + len <= IWRAM_SIZE ? { kind: "iwram", offset: off } : null;
	}
	if (region >= 0x08 && region <= 0x0d) {
		const off = addr & 0x01ffffff;
		return off + len <= romSize ? { kind: "rom", offset: off } : null;
	}
	return null;
}
