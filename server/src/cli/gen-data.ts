// 生成 data/gen3/*.json：游戏内部 ID -> 名称（英/中）与第 3 世代数值。
//   - ID 表：pret/pokeemerald include/constants/{species,moves,abilities,items,pokemon}.h（内部编号 ≠ 全国图鉴编号）
//   - 数值：@pkmn/dex 的 gen3 数据（不用现代世代数据）
//   - 中文名：PokeAPI csv（language_id=12 简体中文）
//   npm run gen:data

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/gen3");
const PRET = "https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants";
const POKEAPI = "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv";
const ZH = "12";

const dex = Dex.forGen(3);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function text(url: string): Promise<string> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`${url}: ${r.status}`);
	return r.text();
}

function parseCsv(src: string): string[][] {
	return src
		.split("\n")
		.slice(1)
		.filter((l) => l.trim())
		.map((l) => {
			const out: string[] = [];
			let cur = "";
			let q = false;
			for (const ch of l) {
				if (ch === '"') q = !q;
				else if (ch === "," && !q) {
					out.push(cur);
					cur = "";
				} else cur += ch;
			}
			out.push(cur);
			return out;
		});
}

/** `#define PREFIX_NAME 123`，支持 (OTHER + n) 形式 */
function parseDefines(src: string, prefix: string): Map<string, number> {
	const raw = new Map<string, string>();
	for (const m of src.matchAll(new RegExp(`^#define\\s+(${prefix}_[A-Z0-9_]+)\\s+(.+?)\\s*(?://.*)?$`, "gm"))) raw.set(m[1]!, m[2]!.trim());
	const val = new Map<string, number>();
	const resolveExpr = (e: string): number | null => {
		const s = e.replace(/^\(|\)$/g, "").trim();
		if (/^(0x[0-9a-fA-F]+|\d+)$/.test(s)) return Number(s);
		const m = s.match(/^([A-Z0-9_]+)\s*\+\s*(\d+)$/);
		if (m) {
			const base = val.get(m[1]!) ?? (raw.has(m[1]!) ? resolveExpr(raw.get(m[1]!)!) : null);
			return base == null ? null : base + Number(m[2]);
		}
		if (val.has(s)) return val.get(s)!;
		return null;
	};
	for (let pass = 0; pass < 4; pass++) for (const [k, v] of raw) if (!val.has(k)) {
		const r = resolveExpr(v);
		if (r != null) val.set(k, r);
	}
	return val;
}

/** `enum { A, B = 5, C, ... }`（items.h 用的是枚举而不是 #define） */
function parseEnum(src: string, prefix: string): Map<string, number> {
	const body = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	const m = body.match(/enum\s*\{([\s\S]*?)\}\s*;/);
	const out = new Map<string, number>();
	if (!m) return out;
	let next = 0;
	for (const entry of m[1]!.split(",")) {
		const t = entry.trim();
		if (!t) continue;
		const [name, expr] = t.split("=").map((x) => x.trim());
		if (expr !== undefined) next = out.get(expr) ?? Number(expr);
		if (name!.startsWith(prefix + "_")) out.set(name!, next);
		next++;
	}
	return out;
}

/** pkmn 的 id 与 pret 常量名不一致的少数招式 */
const MOVE_ALIASES: Record<string, string> = { smellingsalt: "smellingsalts" };

const TYPE_NAMES = ["Normal", "Fighting", "Flying", "Poison", "Ground", "Rock", "Bug", "Ghost", "Steel", "???", "Fire", "Water", "Grass", "Electric", "Psychic", "Ice", "Dragon", "Dark"];
const TYPE_ZH = ["一般", "格斗", "飞行", "毒", "地面", "岩石", "虫", "幽灵", "钢", "???", "火", "水", "草", "电", "超能力", "冰", "龙", "恶"];
const typeId = (n: string) => {
	const i = TYPE_NAMES.indexOf(n);
	if (i < 0) throw new Error(`unknown type ${n}`);
	return i;
};

async function main() {
	const [speciesH, movesH, abilitiesH, itemsH, speciesNames, moveNames, abilityNames, itemNames, moveCsv, abilityCsv, itemCsv] = await Promise.all([
		text(`${PRET}/species.h`),
		text(`${PRET}/moves.h`),
		text(`${PRET}/abilities.h`),
		text(`${PRET}/items.h`),
		text(`${POKEAPI}/pokemon_species_names.csv`),
		text(`${POKEAPI}/move_names.csv`),
		text(`${POKEAPI}/ability_names.csv`),
		text(`${POKEAPI}/item_names.csv`),
		text(`${POKEAPI}/moves.csv`),
		text(`${POKEAPI}/abilities.csv`),
		text(`${POKEAPI}/items.csv`),
	]);

	const zhBy = (csv: string, idCol = 0) => new Map(parseCsv(csv).filter((r) => r[1] === ZH).map((r) => [Number(r[idCol]), r[2]!]));
	const idByIdent = (csv: string) => new Map(parseCsv(csv).map((r) => [norm(r[1]!), Number(r[0])]));
	const zhSpecies = zhBy(speciesNames);
	const zhMoves = zhBy(moveNames);
	const zhAbilities = zhBy(abilityNames);
	const zhItems = zhBy(itemNames);
	const moveIdent = idByIdent(moveCsv);
	const abilityIdent = idByIdent(abilityCsv);
	const itemIdent = idByIdent(itemCsv);

	// ---- species ----
	const speciesDefs = parseDefines(speciesH, "SPECIES");
	const species: Record<number, unknown> = {};
	const unmatchedSpecies: string[] = [];
	for (const [name, id] of [...speciesDefs].sort((a, b) => a[1] - b[1])) {
		const short = name.replace(/^SPECIES_/, "");
		if (short === "NONE" || short === "EGG" || short.startsWith("OLD_UNOWN") || short === "NUM") continue;
		const key = short.startsWith("UNOWN_") ? "unown" : norm(short);
		const sp = dex.species.get(key);
		if (!sp.exists) {
			unmatchedSpecies.push(`${id}:${short}`);
			continue;
		}
		const abilities = Object.values(sp.abilities).filter(Boolean) as string[];
		species[id] = {
			id,
			key: sp.id,
			en: short.startsWith("UNOWN_") ? `Unown (${short.slice(6)})` : sp.name,
			zh: zhSpecies.get(sp.num) ?? sp.name,
			national: sp.num,
			types: [typeId(sp.types[0]!), typeId(sp.types[1] ?? sp.types[0]!)],
			base: sp.baseStats,
			abilities,
		};
	}

	// ---- moves ----
	const moveDefs = parseDefines(movesH, "MOVE");
	const moves: Record<number, unknown> = {};
	const unmatchedMoves: string[] = [];
	for (const [name, id] of [...moveDefs].sort((a, b) => a[1] - b[1])) {
		if (id === 0 || id > 354) continue;
		const key = norm(name.replace(/^MOVE_/, ""));
		const mv = dex.moves.get(MOVE_ALIASES[key] ?? key);
		if (!mv.exists) {
			unmatchedMoves.push(`${id}:${name}`);
			continue;
		}
		const apiId = moveIdent.get(key);
		moves[id] = {
			id,
			key: mv.id,
			en: mv.name,
			zh: (apiId && zhMoves.get(apiId)) || mv.name,
			type: typeId(mv.type),
			category: mv.category.toLowerCase(),
			power: mv.basePower,
			accuracy: mv.accuracy === true ? 0 : mv.accuracy,
			pp: mv.pp,
			priority: mv.priority,
			target: mv.target,
		};
	}

	// ---- abilities ----
	const abilityDefs = parseDefines(abilitiesH, "ABILITY");
	const abilities: Record<number, unknown> = {};
	for (const [name, id] of [...abilityDefs].sort((a, b) => a[1] - b[1])) {
		const key = norm(name.replace(/^ABILITY_/, ""));
		const ab = dex.abilities.get(key);
		if (id === 0 || !ab.exists) continue;
		const apiId = abilityIdent.get(key);
		abilities[id] = { id, key: ab.id, en: ab.name, zh: (apiId && zhAbilities.get(apiId)) || ab.name };
	}

	// ---- items ----
	const itemDefs = parseEnum(itemsH, "ITEM");
	const items: Record<number, unknown> = {};
	for (const [name, id] of [...itemDefs].sort((a, b) => a[1] - b[1])) {
		const key = norm(name.replace(/^ITEM_/, ""));
		if (id === 0 || id >= 0xffff) continue;
		const it = dex.items.get(key);
		const apiId = itemIdent.get(key);
		items[id] = { id, key, en: it.exists ? it.name : name.replace(/^ITEM_/, "").replace(/_/g, " "), zh: (apiId && zhItems.get(apiId)) || (it.exists ? it.name : key) };
	}

	const types = TYPE_NAMES.map((en, id) => ({ id, en, zh: TYPE_ZH[id]! }));

	mkdirSync(OUT, { recursive: true });
	const write = (f: string, data: unknown) => writeFileSync(resolve(OUT, f), JSON.stringify(data, null, 1) + "\n");
	write("species.json", species);
	write("moves.json", moves);
	write("abilities.json", abilities);
	write("items.json", items);
	write("types.json", types);
	console.log(`species ${Object.keys(species).length}, moves ${Object.keys(moves).length}, abilities ${Object.keys(abilities).length}, items ${Object.keys(items).length}`);
	console.log("unmatched species:", unmatchedSpecies.join(", ") || "-");
	console.log("unmatched moves:", unmatchedMoves.join(", ") || "-");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
