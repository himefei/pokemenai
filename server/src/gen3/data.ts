// data/gen3/*.json 的加载器：游戏内部 ID -> 名称与第 3 世代数值。
// 内部 species 编号 ≠ 全国图鉴编号（252–276 为空位），一律经过这张表。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type MoveCategory = "physical" | "special" | "status";

export interface SpeciesData {
	id: number;
	key: string;
	en: string;
	zh: string;
	national: number;
	types: [number, number];
	base: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
	abilities: string[];
}

export interface MoveData {
	id: number;
	key: string;
	en: string;
	zh: string;
	type: number;
	category: MoveCategory;
	power: number;
	/** 0 = 必中 */
	accuracy: number;
	pp: number;
	priority: number;
	target: string;
}

interface NamedData {
	id: number;
	key: string;
	en: string;
	zh: string;
}

export interface TypeData {
	id: number;
	en: string;
	zh: string;
}

const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/gen3");

const readJson = <T>(dir: string, f: string): T => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as T;

export class Gen3Data {
	private constructor(
		private readonly speciesById: Record<string, SpeciesData>,
		private readonly movesById: Record<string, MoveData>,
		private readonly abilitiesById: Record<string, NamedData>,
		private readonly itemsById: Record<string, NamedData>,
		readonly types: TypeData[],
	) {}

	static load(dir: string = DEFAULT_DIR): Gen3Data {
		return new Gen3Data(
			readJson(dir, "species.json"),
			readJson(dir, "moves.json"),
			readJson(dir, "abilities.json"),
			readJson(dir, "items.json"),
			readJson(dir, "types.json"),
		);
	}

	species(id: number): SpeciesData | undefined {
		return this.speciesById[String(id)];
	}

	move(id: number): MoveData | undefined {
		return this.movesById[String(id)];
	}

	ability(id: number): NamedData | undefined {
		return this.abilitiesById[String(id)];
	}

	item(id: number): NamedData | undefined {
		return this.itemsById[String(id)];
	}

	abilityNames(): string[] {
		return Object.values(this.abilitiesById).map((a) => a.en);
	}

	itemNames(): string[] {
		return Object.values(this.itemsById).map((i) => i.en);
	}

	typeName(id: number, lang: "en" | "zh" = "en"): string {
		return this.types[id]?.[lang] ?? `type#${id}`;
	}

	/** "中文名 (English)"，给 prompt 用；未知 ID 退化成 #id。 */
	label(kind: "species" | "move" | "ability" | "item", id: number): string {
		const e = kind === "species" ? this.species(id) : kind === "move" ? this.move(id) : kind === "ability" ? this.ability(id) : this.item(id);
		if (!e) return `#${id}`;
		return e.zh === e.en ? e.en : `${e.zh} (${e.en})`;
	}
}
