// 战斗阶段检测。判定依据来自 Phase 0 的实录（server/test/fixtures/battle_watch_sidney.jsonl）：
//   - 行动菜单   : gBattlerControllerFuncs[0] == HandleInputChooseAction
//   - 招式菜单   : gBattlerControllerFuncs[0] == HandleInputChooseMove
//   - 队伍菜单   : gMain.callback2 == CB2_UpdatePartyMenu；gPartyMenu.action: 0=主动换人 1=倒下后强制换人
//   - 是/否提示  : 战斗脚本在执行 yesnobox（opcode 0x67）且 gBattleCommunication[0]==1（等输入）。
//                  它不走控制器，所以 gBattlerControllerFuncs 里看不出来——真机上"要不要换宝可梦？"就是这个。
//   - 战斗结束   : gBattleOutcome != 0（随后 inBattle 清零）
//   其余战斗中的状态（动画、文字、菜单过渡）一律 battle_busy，什么都不按。

import { BATTLE_SCRIPT_OP, PARTY_ACTION, PARTY_MENU_TYPE_IN_BATTLE } from "../gen3/structs.js";
import type { SymbolTable } from "../gen3/symbols.js";
import type { Heartbeat } from "./heartbeat.js";

export type Phase = "not_in_battle" | "battle_busy" | "action_menu" | "move_menu" | "party_menu" | "prompt" | "battle_over";

/** yes_no：普通是/否框（换不换宝可梦等），可由 AI 回答；learn_move：学习新招式相关，暂不支持，交给人 */
export type PromptKind = "yes_no" | "learn_move";

export interface PhaseInfo {
	phase: Phase;
	/** 仅 prompt */
	promptKind?: PromptKind;
	/** 仅 party_menu：true=倒下后的强制换人（不可取消） */
	forced: boolean;
	/** 便于日志/排错的判定理由 */
	reason: string;
}

const strip = (p: number) => (p & ~1) >>> 0;

export class PhaseDetector {
	private readonly ptr: Record<"action" | "move" | "battleMain" | "partyUpdate", number>;

	constructor(syms: SymbolTable) {
		this.ptr = {
			action: strip(syms.funcPtr("HandleInputChooseAction")),
			move: strip(syms.funcPtr("HandleInputChooseMove")),
			battleMain: strip(syms.funcPtr("BattleMainCB2")),
			partyUpdate: strip(syms.funcPtr("CB2_UpdatePartyMenu")),
		};
	}

	classify(hb: Heartbeat): PhaseInfo {
		const info = (phase: Phase, reason: string, forced = false): PhaseInfo => ({ phase, forced, reason });
		if (!hb.inBattle) return info("not_in_battle", "gMain.inBattle=0");
		if (hb.battleOutcome !== 0) return info("battle_over", `gBattleOutcome=${hb.battleOutcome}`);

		const cb2 = strip(hb.callback2);
		const ctrl0 = strip(hb.controllerFuncs[0] ?? 0);

		if (cb2 === this.ptr.partyUpdate && hb.partyMenu.menuType === PARTY_MENU_TYPE_IN_BATTLE) {
			const forced = hb.partyMenu.action === PARTY_ACTION.SEND_OUT;
			return info("party_menu", `CB2_UpdatePartyMenu action=${hb.partyMenu.action}`, forced);
		}
		if (cb2 === this.ptr.battleMain) {
			if (ctrl0 === this.ptr.action) return info("action_menu", "HandleInputChooseAction");
			if (ctrl0 === this.ptr.move) return info("move_menu", "HandleInputChooseMove");
			const op = hb.scriptOpcode;
			if (op === BATTLE_SCRIPT_OP.YESNOBOX && hb.commState === 1) return { phase: "prompt", forced: false, promptKind: "yes_no", reason: "yesnobox" };
			if (op === BATTLE_SCRIPT_OP.YESNOBOX_LEARN_MOVE || op === BATTLE_SCRIPT_OP.YESNOBOX_STOP_LEARNING_MOVE) return { phase: "prompt", forced: false, promptKind: "learn_move", reason: `yesnobox(learn-move 0x${op.toString(16)})` };
		}
		return info("battle_busy", `cb2=${hb.callback2Name ?? "?"} ctrl0=${hb.controllerFuncNames[0] ?? "?"}`);
	}
}
