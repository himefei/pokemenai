import { describe, expect, it } from "vitest";
import { crc32, crc32HexBE } from "./crc32";
import { KEY_MAP, toButtons } from "./keys";
import { EWRAM_SIZE, GMAIN, IWRAM_SIZE, iwramCandidates, locateBases, resolveAddress } from "./memory";

const GMAIN_ADDR = 0x030022c0;
const GM_OFF = GMAIN_ADDR - 0x03000000;
const CB2 = 0x08085e5d; // thumb 函数指针

function plant(heap: Uint8Array, base: number, vblank: number, cb2 = CB2) {
	const dv = new DataView(heap.buffer);
	dv.setUint32(base + GM_OFF + GMAIN.callback1, 0x08085dc1, true);
	dv.setUint32(base + GM_OFF + GMAIN.callback2, cb2, true);
	dv.setUint32(base + GM_OFF + GMAIN.vblankCounter1, vblank, true);
}

describe("crc32", () => {
	it("matches the standard check value and the big-endian hex the Lua bridge reports", () => {
		const data = new TextEncoder().encode("123456789");
		expect(crc32(data)).toBe(0xcbf43926);
		expect(crc32HexBE(data)).toBe("cbf43926");
	});
});

describe("resolveAddress", () => {
	it("maps EWRAM / IWRAM / ROM and rejects everything else", () => {
		expect(resolveAddress(0x02024084, 0x58, 1 << 24)).toEqual({ kind: "ewram", offset: 0x24084 });
		expect(resolveAddress(0x030022c0, 4, 1 << 24)).toEqual({ kind: "iwram", offset: 0x22c0 });
		expect(resolveAddress(0x08000000, 4, 1 << 24)).toEqual({ kind: "rom", offset: 0 });
		expect(resolveAddress(0x0831c898, 4, 1 << 24)).toEqual({ kind: "rom", offset: 0x31c898 });
		expect(resolveAddress(0x04000000, 4, 1 << 24)).toBeNull(); // IO
		expect(resolveAddress(0x0203ffff, 2, 1 << 24)).toBeNull(); // 越过 EWRAM 末尾
		expect(resolveAddress(0x03007fff, 2, 1 << 24)).toBeNull(); // 越过 IWRAM 末尾
		expect(resolveAddress(0x09000000, 4, 1 << 24)).toBeNull(); // 越过 16MB ROM 末尾
		expect(resolveAddress(0x0a000000, 4, 1 << 24)).toEqual({ kind: "rom", offset: 0 }); // 0x0A/0x0C 是 ROM 的镜像
	});
});

describe("locating the emulated GBA memory inside the wasm heap", () => {
	const HEAP = 0x400000;

	it("finds the live IWRAM (vblank counter ticking) among stale copies, EWRAM sits right before it", async () => {
		const heap = new Uint8Array(HEAP);
		const live = 0x180000;
		plant(heap, live, 1000);
		plant(heap, 0x300000, 777); // 存档/回退缓冲里的旧副本：计数不会动
		plant(heap, 0x100000, 5, 0x02000000); // callback2 不是 ROM 指针：不是候选
		const dv = new DataView(heap.buffer);
		const sleep = async () => dv.setUint32(live + GM_OFF + GMAIN.vblankCounter1, 1003, true); // 60ms 里游戏跑了 3 帧
		expect(iwramCandidates(heap, GMAIN_ADDR)).toEqual([live, 0x300000]);
		const bases = await locateBases(heap, { gMain: GMAIN_ADDR }, sleep);
		expect(bases).toEqual({ iw: live, ew: live - EWRAM_SIZE });
		expect(IWRAM_SIZE).toBe(0x8000);
	});

	it("returns null when nothing is running (all counters frozen) or nothing matches", async () => {
		const heap = new Uint8Array(HEAP);
		plant(heap, 0x180000, 1000);
		expect(await locateBases(heap, { gMain: GMAIN_ADDR }, async () => {})).toBeNull();
		expect(await locateBases(new Uint8Array(HEAP), { gMain: GMAIN_ADDR }, async () => {})).toBeNull();
	});

	it("ignores a candidate whose counter jumps absurdly (not a frame counter)", async () => {
		const heap = new Uint8Array(HEAP);
		plant(heap, 0x180000, 1000);
		const dv = new DataView(heap.buffer);
		expect(await locateBases(heap, { gMain: GMAIN_ADDR }, async () => dv.setUint32(0x180000 + GM_OFF + GMAIN.vblankCounter1, 900000, true))).toBeNull();
	});
});

describe("keys", () => {
	it("restores the desktop mGBA key layout (K=A J=B L=L ;=R M=Start N=Select WASD)", () => {
		expect(KEY_MAP).toEqual({ KeyK: "A", KeyJ: "B", KeyL: "L", Semicolon: "R", KeyM: "Start", KeyN: "Select", KeyW: "Up", KeyS: "Down", KeyA: "Left", KeyD: "Right" });
	});
	it("converts protocol key names and rejects unknown ones", () => {
		expect(toButtons(["A", "DOWN", "START", "SELECT"])).toEqual(["A", "Down", "Start", "Select"]);
		expect(() => toButtons(["TURBO"])).toThrow();
	});
});
