// 给网页里的模拟器提供游戏资源：ROM、存档（.sav）、存档点（.ssN）、需要的符号地址。
// 只提供这几类固定文件（不接受任意路径），而且只读；服务只绑 127.0.0.1。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ROOT } from "../config.js";
import type { SymbolTable } from "../gen3/symbols.js";

export interface StateFile {
	slot: number;
	file: string;
	size: number;
}

export class Assets {
	constructor(private readonly dir = ROOT) {}

	/** 项目根目录下的 .gba（环境变量 ROM_PATH 可覆盖） */
	romPath(): string | null {
		if (process.env.ROM_PATH && existsSync(process.env.ROM_PATH)) return process.env.ROM_PATH;
		const f = readdirSync(this.dir).find((n) => n.toLowerCase().endsWith(".gba"));
		return f ? resolve(this.dir, f) : null;
	}

	private base(): string | null {
		const rom = this.romPath();
		return rom ? rom.replace(/\.gba$/i, "") : null;
	}

	savPath(): string | null {
		const b = this.base();
		return b && existsSync(`${b}.sav`) ? `${b}.sav` : null;
	}

	/** <rom 名>.ss1 … .ss9（桌面 mGBA 存的存档点网页版能直接读） */
	states(): StateFile[] {
		const b = this.base();
		if (!b) return [];
		const out: StateFile[] = [];
		for (let n = 1; n <= 9; n++) {
			const f = `${b}.ss${n}`;
			if (existsSync(f)) out.push({ slot: n, file: basename(f), size: statSync(f).size });
		}
		return out;
	}

	statePath(slot: number): string | null {
		if (!Number.isInteger(slot) || slot < 1 || slot > 9) return null;
		const b = this.base();
		return b && existsSync(`${b}.ss${slot}`) ? `${b}.ss${slot}` : null;
	}

	read(path: string): Buffer {
		return readFileSync(path);
	}

	info() {
		const rom = this.romPath();
		return { rom: rom ? { name: basename(rom), size: statSync(rom).size } : null, sav: this.savPath() ? { name: basename(this.savPath()!) } : null, states: this.states() };
	}
}

/** 浏览器端模拟器宿主用来定位/读写模拟器内存的符号地址（全部来自 data/symbols，不在前端硬编码）。 */
export function symbolsForHost(syms: SymbolTable): Record<string, number> {
	const names = ["gMain", "gRngValue", "gSaveBlock1Ptr", "gSaveBlock2Ptr", "gPlayerParty", "gPlayerPartyCount", "gBattleMons"];
	return Object.fromEntries(names.map((n) => [n, syms.addr(n)]));
}
