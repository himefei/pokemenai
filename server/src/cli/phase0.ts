// Phase 0 环境验证。mGBA 里加载 lua/bridge.lua 后运行：
//   npm run phase0                     # 检查 1/2/3/5：ROM 身份、读队伍、战斗内存、往返延迟
//   npm run phase0 -- --keys           # 检查 4：在行动菜单里注入方向键并回读光标
//   npm run phase0 -- --rng            # 检查 6：存档点 + 写 gRngValue，验证复跑会分叉
//   npm run phase0 -- --watch          # 手动打一场战斗，记录各界面的函数指针（用于阶段判定）
//   npm run phase0 -- --dump <name>    # 把当前内存录成 test/fixtures/<name>.json
//   加 --mark-verified 把本次通过的符号在 emerald_usa.json 里标记 verified:true

import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EmulatorClient } from "../emulator/client.js";
import { readHeartbeat } from "../emulator/heartbeat.js";
import type { Heartbeat } from "../emulator/heartbeat.js";
import { bytesToHex } from "../emulator/protocol.js";
import type { GbaKey } from "../emulator/protocol.js";
import { BATTLE_MON_SIZE, MAIN, parseBattleMon, parseParty, majorStatus, volatileFlags } from "../gen3/structs.js";
import { DEFAULT_SYMBOLS_PATH, SymbolTable } from "../gen3/symbols.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUNS = resolve(ROOT, "runs");

const { values: args } = parseArgs({
	options: {
		port: { type: "string", default: "8765" },
		keys: { type: "boolean", default: false },
		rng: { type: "boolean", default: false },
		watch: { type: "boolean", default: false },
		dump: { type: "string" },
		"mark-verified": { type: "boolean", default: false },
	},
});

const syms = SymbolTable.load();
const client = new EmulatorClient({ port: Number(args.port), autoReconnect: false, requestTimeoutMs: 8000 });

// 计划附录 B 的队伍（内部 species 编号 / 招式 ID，已与存档文件交叉核对）
const EXPECTED_TEAM = [
	{ species: 135, level: 44, moves: [85, 24, 164, 86] },
	{ species: 397, level: 50, moves: [29, 89, 19, 337] },
	{ species: 151, level: 45, moves: [94, 144, 5, 118] },
	{ species: 285, level: 44, moves: [127, 291, 91, 57] },
];

const hex = (n: number, w = 8) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(w, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const verified = new Set<string>();
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];

function report(check: string, ok: boolean, detail = ""): void {
	results.push({ check, ok, detail });
	console.log(`${ok ? "✓" : "✗"} ${check}${detail ? ` — ${detail}` : ""}`);
}

async function connect(): Promise<void> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await client.connect();
			return;
		} catch (e) {
			if (attempt === 3) {
				console.error(`\n无法连接 127.0.0.1:${args.port}。请确认：\n  1. mGBA 里已加载 ROM；\n  2. Tools → Scripting → File → Load script… 选了 lua/bridge.lua；\n  3. Scripting 窗口里看到 "[bridge] listening on 127.0.0.1:${args.port}"。`);
				process.exit(2);
			}
			await sleep(500);
		}
	}
}

async function checkHello(): Promise<void> {
	const h = await client.hello();
	console.log(`  game_code=${h.game_code} title=${h.game_title ?? "?"} crc32=${h.rom_crc32} (raw ${h.rom_crc32_raw_hex}) frame=${h.frame}`);
	// 以原始字节（大端）为准：旧版脚本的 rom_crc32 字段按小端拼接是错的，重新加载 bridge.lua 后两者一致
	const crc = h.rom_crc32_raw_hex?.toUpperCase() ?? null;
	report("1. 脚本可用，ROM 身份", h.game_code.includes(syms.gameCode) && crc === syms.romCrc32, `期望 ${syms.gameCode} / ${syms.romCrc32}，实际 ${crc}`);
}

async function checkParty(): Promise<void> {
	const [countB] = await client.read([{ addr: syms.addr("gPlayerPartyCount"), len: 1 }]);
	const count = countB![0]!;
	const [raw] = await client.read([{ addr: syms.addr("gPlayerParty"), len: syms.size("gPlayerParty") }]);
	const party = parseParty(raw!, count);
	console.log(`  gPlayerPartyCount=${count}`);
	for (const [i, m] of party.entries()) {
		console.log(`  [${i}] species=${m.species} lv${m.level} hp ${m.hp}/${m.maxHp} moves=${m.moves.join(",")} pp=${m.pp.join(",")} checksum=${m.checksumValid ? "ok" : "BAD"}`);
	}
	const matches = party.length === EXPECTED_TEAM.length && EXPECTED_TEAM.every((e, i) => party[i]!.species === e.species && party[i]!.level === e.level && e.moves.every((mv, j) => party[i]!.moves[j] === mv));
	report("2. gPlayerParty 解析与计划附录 B 一致", matches && party.every((p) => p.checksumValid), matches ? "" : "队伍与附录 B 不同（可能升级/换技能了；请核对上面输出与游戏内队伍）");
	if (matches) {
		verified.add("gPlayerParty");
		verified.add("gPlayerPartyCount");
	}
}

async function checkBattle(): Promise<void> {
	const hb = await readHeartbeat(client, syms);
	console.log(`  inBattle=${hb.inBattle} callback2=${hb.callback2Name} controller[0]=${hb.controllerFuncNames[0]} battleMainFunc=${hb.battleMainFuncName}`);
	if (hb.callback2Name && hb.callback2Name !== "NULL") verified.add("gMain");
	if (!hb.inBattle) {
		console.log("  （当前不在战斗中，跳过检查 3；进入战斗后再运行一次 npm run phase0）");
		return;
	}
	const [mons] = await client.read([{ addr: syms.addr("gBattleMons"), len: BATTLE_MON_SIZE * 2 }]);
	const labels = ["我方", "对方"];
	let sane = true;
	for (let i = 0; i < 2; i++) {
		const m = parseBattleMon(mons!.subarray(i * BATTLE_MON_SIZE, (i + 1) * BATTLE_MON_SIZE));
		console.log(`  ${labels[i]}: species=${m.species} lv${m.level} hp ${m.hp}/${m.maxHp} moves=${m.moves.join(",")} pp=${m.pp.join(",")} types=${m.types.join("/")} ability=${m.ability} status=${majorStatus(m.status1) ?? "-"} volatile=[${volatileFlags(m.status2).join(",")}] stages=${JSON.stringify(m.stages)}`);
		sane &&= m.species > 0 && m.species < 500 && m.level >= 1 && m.level <= 100 && m.hp <= m.maxHp && m.maxHp > 0;
	}
	report("3. 战斗中 gBattleMons[0/1] 合理", sane, "请肉眼与游戏画面对一下（种类/HP/招式）");
	if (sane) ["gBattleMons", "gBattlerControllerFuncs", "gBattleTypeFlags", "gBattlersCount"].forEach((s) => verified.add(s));
}

async function checkLatency(): Promise<void> {
	const times: number[] = [];
	const ranges = [
		{ addr: syms.addr("gMain"), len: 0x10 },
		{ addr: syms.addr("gBattlerControllerFuncs"), len: 16 },
		{ addr: syms.addr("gPlayerParty"), len: syms.size("gPlayerParty") },
	];
	for (let i = 0; i < 30; i++) {
		const t0 = performance.now();
		await client.request("read", { ranges });
		times.push(performance.now() - t0);
		await sleep(10);
	}
	times.sort((a, b) => a - b);
	const p50 = times[Math.floor(times.length * 0.5)]!;
	const p95 = times[Math.floor(times.length * 0.95)]!;
	report("5. TCP 往返（read 批量 ~700B）", p95 < 500, `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms（mGBA 每帧才处理一次 socket，1x 速度约 16ms）`);
	const w = await client.request("wait", { frames: 10 });
	report("5b. wait 帧精确", w.frames >= 10 && w.frames <= 11, `期望 10 帧，实际 ${w.frames}`);
}

async function checkKeys(): Promise<void> {
	let hb = await readHeartbeat(client, syms);
	const name = hb.controllerFuncNames[0];
	console.log(`  controller[0]=${name} actionCursor=${hb.actionCursor[0]}`);
	if (!name?.startsWith("HandleInputChooseAction")) {
		console.log("✗ 4. 不在战斗行动菜单（战斗/背包/宝可梦/逃跑）。请先进入战斗并停在这个菜单，再运行 --keys。");
		return;
	}
	const press = async (key: GbaKey) => {
		await client.request("press", { seq: [{ keys: [key], hold: 4, wait: 8 }] }, 10000);
		hb = await readHeartbeat(client, syms);
		return hb.actionCursor[0]!;
	};
	// 2x2 布局：0 战斗 1 背包 / 2 宝可梦 3 逃跑
	const afterRight = await press("RIGHT");
	const afterLeft = await press("LEFT");
	const afterDown = await press("DOWN");
	const afterUp = await press("UP");
	console.log(`  RIGHT→${afterRight}  LEFT→${afterLeft}  DOWN→${afterDown}  UP→${afterUp}`);
	const ok = (afterRight & 1) === 1 && (afterLeft & 1) === 0 && (afterDown & 2) === 2 && (afterUp & 2) === 0;
	report("4. 按键注入 + 光标回读", ok, "光标应按 2x2 布局变化");
	if (ok) {
		verified.add("gActionSelectionCursor");
		verified.add("HandleInputChooseAction");
	}
}

async function checkRng(): Promise<void> {
	const rngAddr = syms.addr("gRngValue");
	const readRng = async () => new DataView((await client.readOne(rngAddr, 4)).buffer).getUint32(0, true);
	const statePath = resolve(RUNS, "phase0.state");
	mkdirSync(RUNS, { recursive: true });
	await client.request("save_state", { path: statePath });
	const w = (v: number) => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setUint32(0, v >>> 0, true);
		return client.write(rngAddr, b);
	};
	const trial = async (seed: number) => {
		await client.request("load_state", { path: statePath });
		await w(seed);
		const written = await readRng();
		await client.request("wait", { frames: 30 }, 10000);
		return { written, after: await readRng() };
	};
	const a1 = await trial(0x11111111);
	const a2 = await trial(0x11111111);
	const b = await trial(0x22222222);
	console.log(`  seed A: written=${hex(a1.written)} after30f=${hex(a1.after)} | again: ${hex(a2.after)} | seed B: written=${hex(b.written)} after30f=${hex(b.after)}`);
	// 游戏每帧都会推进 gRngValue，所以写入后立刻读回不会等于写入值；判据是"同种子复现、不同种子分叉"。
	const reproducible = a1.after === a2.after;
	const diverges = a1.after !== b.after;
	report("6a. 写 gRngValue 会改变后续结果（不同种子 → 分叉）", diverges);
	report("6b. 相同种子 + 相同状态 → 结果复现", reproducible, reproducible ? "" : "相同种子结果不同：RNG 之外还有不确定因素（如键盘输入）；实验期间不要碰键盘");
	if (diverges && reproducible) verified.add("gRngValue");
	console.log("  注：真正的『同一场战斗两次结果不同』要等 Phase 3 的批量复跑验证；存档点复跑用 load_state → 写 RNG。");
}

function describeChange(hb: Heartbeat): string {
	const pm = hb.partyMenu;
	return [
		`inBattle=${hb.inBattle}`,
		`cb2=${hb.callback2Name ?? hex(hb.callback2)}`,
		`ctrl0=${hb.controllerFuncNames[0] ?? hex(hb.controllerFuncs[0]!)}`,
		`main=${hb.battleMainFuncName ?? hex(hb.battleMainFunc)}`,
		`act=${hb.actionCursor[0]} mv=${hb.moveCursor[0]}`,
		`pm(type=${pm.menuType} slot=${pm.slotId} act=${pm.action})`,
		`exec=${hex(hb.execFlags)}`,
		`outcome=${hb.battleOutcome}`,
	].join(" ");
}

async function watch(): Promise<void> {
	mkdirSync(RUNS, { recursive: true });
	const file = resolve(RUNS, "phase0-watch.jsonl");
	console.log(`记录到 ${file}。现在请在 mGBA 里手动打一场战斗：行动菜单 → 招式菜单 → 返回 → 宝可梦菜单(主动换人) → 等对手出招 → 有宝可梦倒下时的强制换人 → 战斗结束。Ctrl+C 结束。`);
	let last = "";
	for (;;) {
		const hb = await readHeartbeat(client, syms);
		const line = describeChange(hb);
		if (line !== last) {
			last = line;
			console.log(`[f${hb.frame}] ${line}`);
			appendFileSync(file, JSON.stringify(hb) + "\n");
		}
		await sleep(100);
	}
}

async function dump(name: string): Promise<void> {
	const hb = await readHeartbeat(client, syms);
	const names = ["gMain", "gBattleMons", "gPlayerParty", "gPlayerPartyCount", "gEnemyParty", "gEnemyPartyCount", "gBattlerControllerFuncs", "gBattlerPartyIndexes", "gBattlersCount", "gBattleTypeFlags", "gBattleOutcome", "gActionSelectionCursor", "gMoveSelectionCursor", "gPartyMenu", "gLastMoves", "gLastLandedMoves", "gBattleWeather", "gSideStatuses", "gBattleControllerExecFlags", "gBattleMainFunc"] as const;
	const ranges = names.map((n) => ({ addr: syms.addr(n), len: n === "gMain" ? MAIN.readLen : syms.size(n) }));
	const data = await client.read(ranges);
	const out: Record<string, unknown> = { _meta: { name, frame: hb.frame, note: describeChange(hb), at: new Date().toISOString() }, memory: {} };
	names.forEach((n, i) => ((out.memory as Record<string, string>)[n] = bytesToHex(data[i]!)));
	const path = resolve(ROOT, "server/test/fixtures", `${name}.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
	console.log(`已写入 ${path}\n  ${describeChange(hb)}`);
}

function markVerified(): void {
	if (verified.size === 0) return console.log("没有可标记的符号。");
	const file = JSON.parse(readFileSync(DEFAULT_SYMBOLS_PATH, "utf8")) as { symbols: Record<string, { verified: boolean }> };
	for (const n of verified) if (file.symbols[n]) file.symbols[n]!.verified = true;
	writeFileSync(DEFAULT_SYMBOLS_PATH, JSON.stringify(file, null, 2) + "\n");
	console.log(`已标记 verified:true → ${[...verified].join(", ")}`);
}

async function main(): Promise<void> {
	await connect();
	console.log(`已连接 mGBA 桥 127.0.0.1:${args.port}`);
	if (args.watch) return watch();
	if (args.dump) {
		await dump(args.dump);
		client.close();
		process.exit(0);
	}
	if (args.keys) await checkKeys();
	else if (args.rng) await checkRng();
	else {
		await checkHello();
		await checkParty();
		await checkBattle();
		await checkLatency();
	}
	mkdirSync(RUNS, { recursive: true });
	writeFileSync(resolve(RUNS, "phase0-report.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
	if (args["mark-verified"]) markVerified();
	client.close();
	process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
