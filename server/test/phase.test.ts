import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Heartbeat } from "../src/emulator/heartbeat.js";
import { PhaseDetector } from "../src/emulator/phase.js";
import type { Phase } from "../src/emulator/phase.js";
import { SymbolTable } from "../src/gen3/symbols.js";

const syms = SymbolTable.load();
const detector = new PhaseDetector(syms);

// Phase 0 实录：在恶系四天王战里手动打完一整场（招式菜单、主动换人、倒下后强制换人、胜利）
const recording = readFileSync(new URL("./fixtures/battle_watch_sidney.jsonl", import.meta.url), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as Heartbeat);

describe("PhaseDetector replay of the recorded Sidney battle", () => {
	const classified = recording.map((hb) => ({ hb, p: detector.classify(hb) }));

	it("sees every phase kind a battle needs", () => {
		const seen = new Set<Phase>(classified.map((c) => c.p.phase));
		for (const phase of ["action_menu", "move_menu", "party_menu", "battle_busy"] as Phase[]) expect(seen).toContain(phase);
	});

	it("action_menu / move_menu only when the controller is waiting for input", () => {
		for (const { hb, p } of classified) {
			if (p.phase === "action_menu") expect(hb.controllerFuncNames[0]).toBe("HandleInputChooseAction");
			if (p.phase === "move_menu") expect(hb.controllerFuncNames[0]).toBe("HandleInputChooseMove");
		}
	});

	it("never classifies animation/text/transition states as an input phase", () => {
		const busyCtrl = ["CompleteOnInactiveTextPrinter2", "PlayerDoMoveAnimation", "HandleChooseActionAfterDma3", "HandleChooseMoveAfterDma3", "SwitchIn_TryShinyAnimShowHealthbox", "PlayerBufferRunCommand", "WaitForMonSelection"];
		for (const { hb, p } of classified) {
			if (hb.callback2Name === "BattleMainCB2" && busyCtrl.includes(hb.controllerFuncNames[0] ?? "")) expect(p.phase).toBe("battle_busy");
		}
	});

	it("distinguishes voluntary switch from forced switch via gPartyMenu.action", () => {
		const party = classified.filter((c) => c.p.phase === "party_menu");
		const voluntary = party.filter((c) => !c.p.forced);
		const forced = party.filter((c) => c.p.forced);
		expect(voluntary.length).toBeGreaterThan(0);
		expect(forced.length).toBeGreaterThan(0);
		// 强制换人发生在战斗脚本里（倒下之后），主动换人发生在回合选择阶段
		for (const c of voluntary) expect(c.hb.battleMainFuncName).toBe("HandleTurnActionSelectionState");
		for (const c of forced) expect(c.hb.battleMainFuncName).not.toBe("HandleTurnActionSelectionState");
	});

	it("ends with battle_over (outcome=1) and then not_in_battle", () => {
		const phases = classified.map((c) => c.p.phase);
		expect(phases).toContain("battle_over");
		expect(phases[phases.length - 1]).toBe("not_in_battle");
		expect(classified.find((c) => c.p.phase === "battle_over")!.hb.battleOutcome).toBe(1);
		// battle_over 之前不应出现非 0 的 outcome
		const firstOver = phases.indexOf("battle_over");
		for (const c of classified.slice(0, firstOver)) expect(c.hb.battleOutcome).toBe(0);
	});
});

describe("PhaseDetector: yes/no prompt (battle-script yesnobox)", () => {
	const base = recording.find((hb) => hb.inBattle && hb.battleOutcome === 0 && hb.callback2Name === "BattleMainCB2")!;
	// 是/否框是战斗脚本自己读按键，此时玩家控制器是空闲的（不在任何菜单输入函数上）
	const at = (over: Partial<Heartbeat>): Heartbeat => ({ ...base, controllerFuncs: [0, 0, 0, 0], controllerFuncNames: ["NULL", "NULL", "NULL", "NULL"], ...over });

	it("detects the plain yes/no box only while it waits for input", () => {
		expect(detector.classify(at({ scriptOpcode: 0x67, commState: 1 }))).toMatchObject({ phase: "prompt", promptKind: "yes_no" });
		expect(detector.classify(at({ scriptOpcode: 0x67, commState: 0 })).phase).toBe("battle_busy"); // 框还没画出来
		expect(detector.classify(at({ scriptOpcode: 0x10, commState: 1 })).phase).toBe("battle_busy"); // 别的脚本指令
		expect(detector.classify(at({ scriptOpcode: null })).phase).toBe("battle_busy");
	});

	it("flags learn-move prompts separately so they are never answered blindly", () => {
		for (const op of [0x5a, 0x5b]) expect(detector.classify(at({ scriptOpcode: op, commState: 0 }))).toMatchObject({ phase: "prompt", promptKind: "learn_move" });
	});
});
