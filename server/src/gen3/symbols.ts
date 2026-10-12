import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SymbolEntry {
	addr: number;
	size: number;
	kind: "data" | "func";
	verified: boolean;
}

interface SymbolFile {
	_meta: { rom: string; game_code: string; rom_crc32: string; [k: string]: unknown };
	symbols: Record<string, { addr: string; size: number; kind: "data" | "func"; verified: boolean }>;
}

export const DEFAULT_SYMBOLS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/symbols/emerald_usa.json");

/** 地址零硬编码：所有地址都从 data/symbols/emerald_usa.json 来。 */
export class SymbolTable {
	readonly gameCode: string;
	readonly romCrc32: string;
	private readonly byName = new Map<string, SymbolEntry>();
	/** 按地址排序的函数符号，用来把函数指针反查成名字 */
	private readonly funcs: Array<{ addr: number; size: number; name: string }> = [];

	constructor(file: SymbolFile) {
		this.gameCode = file._meta.game_code;
		this.romCrc32 = file._meta.rom_crc32.toUpperCase();
		for (const [name, s] of Object.entries(file.symbols)) {
			const entry: SymbolEntry = { addr: parseInt(s.addr, 16), size: s.size, kind: s.kind, verified: s.verified };
			this.byName.set(name, entry);
			if (s.kind === "func") this.funcs.push({ addr: entry.addr, size: entry.size, name });
		}
		this.funcs.sort((a, b) => a.addr - b.addr);
	}

	static load(path: string = DEFAULT_SYMBOLS_PATH): SymbolTable {
		return new SymbolTable(JSON.parse(readFileSync(path, "utf8")) as SymbolFile);
	}

	has(name: string): boolean {
		return this.byName.has(name);
	}

	get(name: string): SymbolEntry {
		const e = this.byName.get(name);
		if (!e) throw new Error(`unknown symbol: ${name}`);
		return e;
	}

	addr(name: string, offset = 0): number {
		return this.get(name).addr + offset;
	}

	size(name: string): number {
		return this.get(name).size;
	}

	/** 函数符号在 ROM 里的 thumb 函数指针值（地址|1）。 */
	funcPtr(name: string): number {
		return (this.get(name).addr | 1) >>> 0;
	}

	/** 函数指针 -> 符号名；精确匹配起点返回 name，落在函数体内返回 name+0xN，找不到返回 undefined。 */
	funcNameAt(ptr: number): string | undefined {
		if (ptr === 0) return "NULL";
		const addr = (ptr & ~1) >>> 0;
		let lo = 0;
		let hi = this.funcs.length - 1;
		let best = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.funcs[mid]!.addr <= addr) {
				best = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (best < 0) return undefined;
		const f = this.funcs[best]!;
		if (addr === f.addr) return f.name;
		if (addr < f.addr + f.size) return `${f.name}+0x${(addr - f.addr).toString(16)}`;
		return undefined;
	}

	unverified(names: string[]): string[] {
		return names.filter((n) => !this.get(n).verified);
	}
}
