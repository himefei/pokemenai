import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decryptSubstructs, SUBSTRUCT_ORDERS } from "../src/gen3/decrypt.js";
import { majorStatus, parseBattleMon, parsePartyMon, volatileFlags } from "../src/gen3/structs.js";
import { hexToBytes } from "../src/emulator/protocol.js";
import { SymbolTable } from "../src/gen3/symbols.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/save_party.json", import.meta.url), "utf8")) as { mons: string[] };
const mons = fixture.mons.map((h) => parsePartyMon(hexToBytes(h)));

// 内部编号（非全国图鉴编号）：135 雷伊布 / 397 暴飞龙 / 151 梦幻 / 285 巨沼怪
describe("parsePartyMon (fixture decoded from the user's save)", () => {
	it("matches the team in the plan appendix B", () => {
		expect(mons.map((m) => [m.species, m.level])).toEqual([
			[135, 44],
			[397, 50],
			[151, 45],
			[285, 44],
		]);
		expect(mons[0]!.moves).toEqual([85, 24, 164, 86]); // 十万伏特 连环腿 替身 电磁波
		expect(mons[1]!.moves).toEqual([29, 89, 19, 337]); // 头锤 地震 飞天 龙爪
		expect(mons[2]!.moves).toEqual([94, 144, 5, 118]); // 精神强念 变身 百万吨拳击 摇手指
		expect(mons[3]!.moves).toEqual([127, 291, 91, 57]); // 攀瀑 潜水 挖洞 冲浪
	});

	it("passes the substructure checksum and has sane HP", () => {
		for (const m of mons) {
			expect(m.checksumValid).toBe(true);
			expect(m.hp).toBeGreaterThan(0);
			expect(m.hp).toBeLessThanOrEqual(m.maxHp);
			expect(m.empty).toBe(false);
		}
	});

	it("rejects short buffers", () => {
		expect(() => parsePartyMon(new Uint8Array(50))).toThrow();
	});
});

describe("substruct order table", () => {
	it("has 24 distinct permutations of GAEM", () => {
		expect(new Set(SUBSTRUCT_ORDERS).size).toBe(24);
		for (const o of SUBSTRUCT_ORDERS) expect([...o].sort().join("")).toBe("AEGM");
	});

	it("round-trips: re-encrypting with the same key reproduces the original bytes", () => {
		const raw = hexToBytes(fixture.mons[0]!);
		const d = decryptSubstructs(raw);
		const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		const key = (view.getUint32(0, true) ^ view.getUint32(4, true)) >>> 0;
		const order = SUBSTRUCT_ORDERS[view.getUint32(0, true) % 24]!;
		const plain = new Uint8Array(48);
		[...order].forEach((k, i) => plain.set(d[k as "G" | "A" | "E" | "M"], i * 12));
		const pv = new DataView(plain.buffer);
		for (let i = 0; i < 48; i += 4) {
			expect(((pv.getUint32(i, true) ^ key) >>> 0)).toBe(view.getUint32(0x20 + i, true));
		}
	});
});

describe("parseBattleMon", () => {
	function build(): Uint8Array {
		const b = new Uint8Array(0x58);
		const v = new DataView(b.buffer);
		v.setUint16(0x00, 135, true); // species
		v.setUint16(0x02, 100, true); // atk
		v.setUint16(0x04, 90, true);
		v.setUint16(0x06, 150, true); // spe
		v.setUint16(0x08, 140, true);
		v.setUint16(0x0a, 120, true);
		[85, 24, 164, 86].forEach((m, i) => v.setUint16(0x0c + i * 2, m, true));
		// IVs: hp=31 atk=0 def=15 spe=31 spa=1 spd=2, abilityNum=1
		v.setUint32(0x14, (31 | (0 << 5) | (15 << 10) | (31 << 15) | (1 << 20) | (2 << 25) | (1 << 31)) >>> 0, true);
		// stat stages (6 = neutral): atk +2, spe -1
		b.set([6, 8, 6, 5, 6, 6, 6, 6], 0x18);
		b[0x20] = 10; // ability
		b[0x21] = 13; // electric
		b[0x22] = 13;
		b.set([15, 30, 10, 0], 0x24);
		v.setUint16(0x28, 112, true);
		b[0x2a] = 44;
		v.setUint16(0x2c, 120, true);
		b.set([0xc4, 0xd9, 0xd5, 0xd5, 0xff], 0x30); // nickname
		v.setUint32(0x4c, 1 << 6, true); // paralysis
		v.setUint32(0x50, 1 << 24, true); // substitute
		return b;
	}

	it("decodes fields at their documented offsets", () => {
		const m = parseBattleMon(build());
		expect(m.species).toBe(135);
		expect(m.stats).toEqual({ atk: 100, def: 90, spe: 150, spa: 140, spd: 120 });
		expect(m.moves).toEqual([85, 24, 164, 86]);
		expect(m.pp).toEqual([15, 30, 10, 0]);
		expect(m.ivs).toMatchObject({ hp: 31, atk: 0, def: 15, spe: 31, spa: 1, spd: 2, abilityNum: 1 });
		expect(m.stages).toEqual({ atk: 2, def: 0, spa: 0, spd: 0, spe: -1, acc: 0, eva: 0 });
		expect(m.types).toEqual([13, 13]);
		expect([m.hp, m.maxHp, m.level]).toEqual([112, 120, 44]);
		expect(majorStatus(m.status1)).toBe("paralysis");
		expect(volatileFlags(m.status2)).toEqual(["substitute"]);
	});

	it("decodes the highest status2 bit without sign problems", () => {
		expect(volatileFlags(0x80000000)).toEqual(["torment"]);
	});
});

describe("SymbolTable", () => {
	const syms = SymbolTable.load();
	it("loads key symbols with no hard-coded addresses elsewhere", () => {
		expect(syms.addr("gPlayerParty")).toBe(0x020244ec);
		expect(syms.size("gBattleMons")).toBe(0x58 * 4);
		expect(syms.gameCode).toBe("BPEE");
	});
	it("reverse-looks-up thumb function pointers", () => {
		expect(syms.funcNameAt(syms.funcPtr("HandleInputChooseMove"))).toBe("HandleInputChooseMove");
		expect(syms.funcNameAt(syms.funcPtr("HandleInputChooseMove") + 8)).toBe("HandleInputChooseMove+0x8");
		expect(syms.funcNameAt(0)).toBe("NULL");
	});
});
