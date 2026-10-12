// 用某个策略把战斗打完。
//   npm run play -- --policy random --battles 5 --slot 2
//   npm run play -- --policy llm --battles 1 --slot 2       # 用 config/settings.local.json 里的模型
// 每场：load_state(slot) → 写随机 gRngValue → 等行动菜单 → 循环决策/执行 → 战斗结束。
// 遇到不认识的状态不乱按；模型出错就如实报错退出（needs_human，退出码 3），没有兜底。

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RandomPolicy, mulberry32 } from "../agent/baselines.js";
import { NeedsHuman, runBattleLoop } from "../agent/battle-loop.js";
import type { LoopOptions } from "../agent/battle-loop.js";
import type { BattleSummary, EventSink } from "../agent/events.js";
import { LlmPolicy } from "../agent/llm-policy.js";
import type { Policy } from "../agent/policy.js";
import { loadPreset } from "../agent/prompt.js";
import { BattleTracker } from "../agent/tracker.js";
import { ROOT, loadSettings } from "../config.js";
import { EmulatorClient } from "../emulator/client.js";
import { InputExecutor } from "../emulator/input-executor.js";
import { PhaseDetector } from "../emulator/phase.js";
import { TextLog } from "../gen3/battle-text.js";
import { Gen3Data } from "../gen3/data.js";
import { BATTLE_OUTCOME } from "../gen3/structs.js";
import { SymbolTable } from "../gen3/symbols.js";
import { createClient } from "../llm/factory.js";

const { values: args } = parseArgs({
	options: {
		battles: { type: "string", default: "5" },
		slot: { type: "string", default: "1" },
		policy: { type: "string", default: "random" },
		seed: { type: "string" },
		port: { type: "string", default: "8765" },
		"no-load": { type: "boolean", default: false },
		"max-frames": { type: "string", default: "216000" },
		"max-turns": { type: "string", default: "60" },
		quiet: { type: "boolean", default: false },
		"show-obs": { type: "boolean", default: false },
		preset: { type: "string", default: "default" },
		"rules-hint": { type: "boolean", default: false },
		retries: { type: "string", default: "2" },
		"extra-body": { type: "string" },
		keep: { type: "string", default: "30" },
	},
});

const syms = SymbolTable.load();
const data = Gen3Data.load();
const detector = new PhaseDetector(syms);
const client = new EmulatorClient({ port: Number(args.port), autoReconnect: false, requestTimeoutMs: 15000 });
const exec = new InputExecutor(client, syms, detector);
const textLog = new TextLog();
const tracker = new BattleTracker(data);

mkdirSync(resolve(ROOT, "runs"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = resolve(ROOT, "runs", `play-${stamp}.jsonl`);
const log = (rec: Record<string, unknown>) => appendFileSync(logFile, JSON.stringify(rec) + "\n");
const say = (msg: string) => {
	if (!args.quiet) console.log(msg);
};

// 事件 -> 控制台
const sink: EventSink = (e) => {
	switch (e.type) {
		case "battle.text":
			say(`    “${e.text}”`);
			break;
		case "battle.state":
			if (args["show-obs"]) console.log(JSON.stringify(e.observation, null, 1));
			break;
		case "llm.response":
			say(`    ⏱ ${(e.latencyMs / 1000).toFixed(1)}s ${e.usage.outputTokens ?? "?"}tok${e.parseError ? ` ✗ ${e.parseError.slice(0, 100)}` : ""}`);
			break;
		case "action.parsed":
			say(`    💭 ${e.reason}`);
			break;
		case "action.executing":
			say(`  [T${e.turn}] → ${e.label} (${e.choice})`);
			break;
		case "action.done":
			if (!e.result.ok) say(`    ✗ ${e.result.reason}：${e.result.detail}`);
			break;
	}
};

const seed = args.seed ? Number(args.seed) : (Date.now() & 0x7fffffff) >>> 0;
const policy: Policy = (() => {
	if (args.policy === "random") return new RandomPolicy(seed);
	if (args.policy === "llm") {
		const settings = loadSettings();
		const extraBody = { ...(settings.llm.extraBody ?? {}), ...(args["extra-body"] ? (JSON.parse(args["extra-body"]) as Record<string, unknown>) : {}) };
		return new LlmPolicy({
			client: createClient(settings.llm),
			model: settings.llm.model,
			params: { ...(settings.llm.params ?? {}), extraBody },
			prompt: { preset: loadPreset(args.preset), rulesHint: args["rules-hint"] ?? false },
			keepFull: Number(args.keep),
			maxRetries: Number(args.retries),
			sink,
		});
	}
	throw new Error(`unknown policy: ${args.policy}`);
})();
const rngSeeds = mulberry32(seed ^ 0x9e3779b9);

async function startBattle(): Promise<number | null> {
	if (args["no-load"]) return null;
	await client.request("load_state", { slot: Number(args.slot) }, 15000);
	const rng = (rngSeeds() * 0x100000000) >>> 0;
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, rng, true);
	await client.write(syms.addr("gRngValue"), b);
	return rng;
}

async function main() {
	await client.connect();
	const hello = await client.hello();
	if (hello.rom_crc32_raw_hex?.toUpperCase() !== syms.romCrc32) throw new Error(`ROM 不匹配：${hello.rom_crc32_raw_hex}`);
	const n = Number(args.battles);
	const loopOptions: Partial<LoopOptions> = { maxTurns: Number(args["max-turns"]), maxFrames: Number(args["max-frames"]) };
	console.log(`policy=${policy.name} seed=${seed} battles=${n} slot=${args["no-load"] ? "(当前状态)" : args.slot}\n日志：${logFile}`);

	const results: BattleSummary[] = [];
	try {
		for (let i = 1; i <= n; i++) {
			console.log(`\n=== 第 ${i}/${n} 场 ===`);
			const rngSeed = await startBattle();
			const r = await runBattleLoop(i, rngSeed, { client, syms, data, detector, exec, textLog, tracker, policy, sink, log, options: loopOptions });
			results.push(r);
			log({ type: "battle_end", ...r });
			console.log(`结果：${r.outcomeName}，${r.turns} 回合，${r.decisions} 次决策，${r.rejections} 次被拒，${r.nudges} 次推进，剩余 ${r.partyAlive} 只，${r.frames} 帧`);
		}
	} catch (e) {
		if (e instanceof NeedsHuman) {
			console.error(`\n⚠ needs_human：${e.message}`);
			if (e.snapshot) {
				const f = resolve(ROOT, "runs", `needs-human-${stamp}.json`);
				writeFileSync(f, JSON.stringify({ message: e.message, phase: e.snapshot.phase, hb: e.snapshot.hb }, null, 2));
				console.error(`现场已保存：${f}`);
			}
			log({ type: "needs_human", message: e.message });
			client.close();
			process.exit(3);
		}
		throw e;
	}

	const wins = results.filter((r) => r.outcome === BATTLE_OUTCOME.WON).length;
	console.log(`\n完成 ${results.length} 场：胜 ${wins} / 负 ${results.filter((r) => r.outcome === BATTLE_OUTCOME.LOST).length}，平均 ${(results.reduce((a, r) => a + r.turns, 0) / results.length).toFixed(1)} 回合`);
	if (policy instanceof LlmPolicy) console.log(`模型统计：${JSON.stringify(policy.stats)}`);
	client.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
