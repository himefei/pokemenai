// 从 pret/pokeemerald 的符号表（经 40Cakes/pokebot-gen3 镜像）生成 data/symbols/emerald_usa.json。
// 只保留我们用得到的符号；已有的 verified 标记在地址不变时保留。
//
//   npm run gen:symbols                 # 从网络下载
//   npm run gen:symbols -- ./some.sym   # 或指定本地 .sym

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SYM_URL = "https://raw.githubusercontent.com/40Cakes/pokebot-gen3/main/modules/data/symbols/pokeemerald.sym";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/symbols/emerald_usa.json");

const DATA_SYMBOLS = [
	"gMain", "gBattleTypeFlags", "gBattleMons", "gBattlersCount", "gBattlerPartyIndexes",
	"gBattlerControllerFuncs", "gActionSelectionCursor", "gMoveSelectionCursor", "gBattleOutcome",
	"gBattleWeather", "gSideStatuses", "gPlayerParty", "gPlayerPartyCount", "gEnemyParty",
	"gEnemyPartyCount", "gPartyMenu", "gLastMoves", "gLastLandedMoves", "gRngValue",
	"gDisplayedStringBattle", "gBattleControllerExecFlags", "gBattlerAttacker", "gBattlerTarget",
	"gAbsentBattlerFlags", "gBattleMainFunc", "gBattleResults", "gBattleCommunication",
	"gBattleScripting", "gBattleStruct", "gCurrentMove", "gHitMarker", "gTasks",
	"gSaveBlock1Ptr", "gSaveBlock2Ptr", "gBattleBufferA", "gBattleBufferB", "gMultiUsePlayerCursor", "gBattlescriptCurrInstr",
	"gBattleMoves", "gSpeciesNames", "gMoveNames", "gTypeEffectiveness", "gAbilityNames", "gTypeNames",
];

// 函数符号：战斗控制器 / 队伍菜单 / 回调，用来把函数指针反查成名字
const FUNC_PATTERN = new RegExp(
	"^(PlayerHandle|OpponentHandle|HandleInput|PlayerBufferExec|OpponentBufferExec|CB2_|BattleMainCB|" +
		"HandleTurn|RunTurnActions|Task_HandleChooseMon|HandleChooseMon|Task_HandleSelectionMenu|" +
		"OpenPartyMenuInBattle|Task_PartyMenu|Task_ClosePartyMenu|Task_HandleStopLearningMove|" +
		"Task_HandleReplaceMove|Task_LearnNextMove|BtlController_|Controller_|PrintLinkStandbyMsg|" +
		"BattleControllerDummy|SetControllerTo|OpenPartyMenuToChooseMon|WaitForMonSelection|HandleAction_|TryDoEventsBeforeFirstTurn|DoBattleIntro|HandleEndTurn_|DoEndTurnEffects)",
);

// 战斗相关代码（battle_main / battle_controllers / battle_controller_player / opponent 等）整段收录，
// 这样任意控制器函数指针都能反查出名字。
const BATTLE_CODE_START = 0x08030000;
const BATTLE_CODE_END = 0x08065000;
// party_menu.c：队伍菜单的 Task_* 函数，用来判断是否弹出了子菜单
const PARTY_CODE_START = 0x081b0000;
const PARTY_CODE_END = 0x081ba000;

interface SymEntry { addr: number; scope: string; size: number; name: string }

function parseSym(text: string): SymEntry[] {
	const out: SymEntry[] = [];
	for (const line of text.split("\n")) {
		const p = line.trim().split(/\s+/);
		if (p.length < 4) continue;
		out.push({ addr: parseInt(p[0]!, 16), scope: p[1]!, size: parseInt(p[2]!, 16), name: p[3]! });
	}
	return out;
}

async function main() {
	const arg = process.argv[2];
	const text = arg ? readFileSync(arg, "utf8") : await (await fetch(SYM_URL)).text();
	const all = parseSym(text);

	const previous: { symbols?: Record<string, { addr: string; verified?: boolean }> } = existsSync(OUT)
		? JSON.parse(readFileSync(OUT, "utf8"))
		: {};

	const symbols: Record<string, unknown> = {};
	const seen = new Set<string>();
	const put = (e: SymEntry, kind: "data" | "func") => {
		const hex = "0x" + e.addr.toString(16).toUpperCase().padStart(8, "0");
		const key = seen.has(e.name) ? `${e.name}#${hex}` : e.name;
		seen.add(e.name);
		const prev = previous.symbols?.[key];
		symbols[key] = { addr: hex, size: e.size, kind, verified: prev?.addr === hex ? (prev.verified ?? false) : false };
	};

	for (const e of all.sort((a, b) => a.addr - b.addr)) {
		if (DATA_SYMBOLS.includes(e.name)) put(e, "data");
		else if (e.addr >= 0x08000000 && e.addr < 0x0a000000 && e.size > 0 && (FUNC_PATTERN.test(e.name) || (e.addr >= BATTLE_CODE_START && e.addr < BATTLE_CODE_END) || (e.addr >= PARTY_CODE_START && e.addr < PARTY_CODE_END))) put(e, "func");
	}

	const missing = DATA_SYMBOLS.filter((n) => !(n in symbols));
	const doc = {
		_meta: {
			rom: "Pokemon - Emerald Version (USA, Europe)",
			game_code: "BPEE",
			rom_crc32: "1F1C08FB",
			source: "pret/pokeemerald symbols via 40Cakes/pokebot-gen3 modules/data/symbols/pokeemerald.sym",
			note: "verified=false 直到在本机 Phase 0 实测通过。func 的地址不含 thumb 位，比较函数指针时用 addr|1。",
			not_found: missing,
		},
		symbols,
	};
	writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
	console.log(`wrote ${OUT}: ${Object.keys(symbols).length} symbols; not found: ${missing.join(", ") || "-"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
