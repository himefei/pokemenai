// 对战主循环：读快照 -> 判阶段 -> 决策 -> 闭环执行 -> 直到战斗结束。
// CLI（play）、控制器（Web UI 接管）和评测 runner 共用这一份。
// 原则：未知状态不乱按；卡住时只在"长时间纹丝不动"时推进一下文字；超时/连续失败 -> NeedsHuman。

import { InputExecutor } from "../emulator/input-executor.js";
import type { ExecResult } from "../emulator/input-executor.js";
import type { EmulatorLink } from "../emulator/rpc.js";
import type { PhaseDetector } from "../emulator/phase.js";
import { legalActions, parseActionId, readSnapshot } from "../gen3/battle-state.js";
import type { ActionId, ActionMode, BattleSnapshot } from "../gen3/battle-state.js";
import { TextLog } from "../gen3/battle-text.js";
import type { Gen3Data } from "../gen3/data.js";
import { BATTLE_OUTCOME } from "../gen3/structs.js";
import type { SymbolTable } from "../gen3/symbols.js";
import type { BattleSummary, EventSink } from "./events.js";
import { buildObservation } from "./observation.js";
import type { Observation } from "./observation.js";
import { PolicyFailure } from "./policy.js";
import type { Policy } from "./policy.js";
import { BattleTracker } from "./tracker.js";

/** 自定义结果码：回合数到上限仍未分出胜负，按平局计。 */
export const TURN_LIMIT = -1;
/** 用户点了"释放"：战斗没打完，交还控制。 */
export const RELEASED = -2;

export const outcomeName = (o: number): string =>
	o === TURN_LIMIT ? "TURN_LIMIT" : o === RELEASED ? "RELEASED" : (Object.entries(BATTLE_OUTCOME).find(([, v]) => v === o)?.[0] ?? `#${o}`);

export class NeedsHuman extends Error {
	constructor(
		message: string,
		readonly snapshot?: BattleSnapshot,
	) {
		super(message);
	}
}

export interface LoopOptions {
	maxTurns: number;
	/** 单场最多帧数（模拟器时间） */
	maxFrames: number;
	/** 同一状态不变超过这么多帧才推进一下文字 */
	stallNudgeFrames: number;
	nudgeEveryFrames: number;
	/** 每回合允许的推进次数上限 */
	maxNudgesPerTurn: number;
	maxExecFailures: number;
	/** 状态这么多帧完全不变 -> needs_human */
	deadFrames: number;
}

export const DEFAULT_LOOP_OPTIONS: LoopOptions = {
	maxTurns: 60,
	maxFrames: 216000,
	stallNudgeFrames: 90,
	nudgeEveryFrames: 45,
	maxNudgesPerTurn: 40,
	maxExecFailures: 4,
	deadFrames: 5400,
};

export interface LoopDeps {
	client: EmulatorLink;
	syms: SymbolTable;
	data: Gen3Data;
	detector: PhaseDetector;
	exec: InputExecutor;
	textLog: TextLog;
	tracker: BattleTracker;
	policy: Policy;
	sink?: EventSink;
	/** 额外的结构化日志（decision / nudge 等） */
	log?: (rec: Record<string, unknown>) => void;
	/** 模型开始思考之前 / 想完之后：让网页模拟器暂停、继续，这样随机数只取决于游戏帧数，不取决于模型想了多久 */
	pauseForThinking?: () => Promise<void>;
	resumeAfterThinking?: () => Promise<void>;
	/** 返回 true 则在下一个安全点退出（用户点了释放/急停） */
	shouldStop?: () => boolean;
	/** 确认模式：模型给出动作后调用，返回 false 表示用户拒绝执行 */
	confirm?: (obs: Observation, choice: ActionId, label: string) => Promise<boolean>;
	options?: Partial<LoopOptions>;
}

function sigOf(s: BattleSnapshot): string {
	const h = s.hb;
	return [h.callback2, h.controllerFuncs[0], h.battleMainFunc, h.execFlags, h.actionCursor[0], h.moveCursor[0], h.partyMenu.slotId, h.battleOutcome, s.player.hp, s.opponent.hp].join("|");
}

/** 跑一场战斗。调用时游戏应已在战斗中（或即将开始战斗）。 */
export async function runBattleLoop(index: number, rngSeed: number | null, deps: LoopDeps): Promise<BattleSummary> {
	const { client, syms, data, detector, exec, textLog, tracker, policy, sink, log } = deps;
	const opts: LoopOptions = { ...DEFAULT_LOOP_OPTIONS, ...(deps.options ?? {}) };
	const emit: EventSink = (e) => sink?.(e);

	textLog.reset();
	tracker.reset();
	policy.reset?.();
	const t0 = (await exec.look()).hb.frame;

	let turn = 0;
	let decisions = 0;
	let rejections = 0;
	let nudges = 0;
	let execFailures = 0;
	let lastPhase = "";
	let lastReportedPhase = "";
	let lastSig = "";
	let sigSince = t0;
	let lastNudge = t0;
	let lastOutcome = 0;
	let rejected = new Set<ActionId>();
	let sawBattle = false;
	/** 刚在是/否框里答了"是"：接下来出现的非强制队伍菜单是换人选择，不是误入 */
	let afterPromptYes = false;

	const summary = (outcome: number, s: BattleSnapshot, frame: number): BattleSummary => ({
		battle: index,
		outcome,
		outcomeName: outcomeName(outcome),
		turns: outcome === TURN_LIMIT ? turn - 1 : turn,
		decisions,
		rejections,
		nudges,
		frames: frame - t0,
		partyAlive: s.party.filter((m) => !m.empty && m.hp > 0).length,
		rngSeed,
	});

	for (;;) {
		const s = await readSnapshot(client, syms, detector);
		const ph = s.phase.phase;
		const frame = s.hb.frame;

		if (ph !== lastReportedPhase) {
			lastReportedPhase = ph;
			emit({ type: "phase", phase: ph, reason: s.phase.reason, forced: s.phase.forced, frame });
		}
		const newMsg = textLog.push(frame, s.textBytes);
		if (newMsg) emit({ type: "battle.text", frame, text: newMsg });
		// 每次轮询都更新对手记忆：对手招式/特性一出现就记下，不等到下一次决策（那时 gLastMoves 可能已被重置）
		tracker.update(s, newMsg ? [newMsg] : []);

		if (s.hb.battleOutcome !== 0) lastOutcome = s.hb.battleOutcome;
		if (frame - t0 > opts.maxFrames) throw new NeedsHuman(`单场超过 ${opts.maxFrames} 帧`, s);
		if (ph !== "not_in_battle") sawBattle = true;

		if ((ph === "not_in_battle" && sawBattle) || ph === "battle_over") return summary(lastOutcome, s, frame);
		if (deps.shouldStop?.()) return summary(RELEASED, s, frame);

		const sig = sigOf(s);
		if (sig !== lastSig) {
			lastSig = sig;
			sigSince = frame;
			lastNudge = frame;
		}

		if (ph === "not_in_battle" || ph === "battle_busy") {
			// 动画/文字/过渡：只在"长时间纹丝不动"时推进一下，否则什么都不按
			if (ph === "battle_busy" && frame - sigSince > opts.stallNudgeFrames && frame - lastNudge > opts.nudgeEveryFrames) {
				if (nudges >= opts.maxNudgesPerTurn * (turn + 1)) throw new NeedsHuman(`战斗卡在 ${s.phase.reason}，推进 ${nudges} 次无效`, s);
				log?.({ type: "nudge", battle: index, turn, frame, stalledFrames: frame - sigSince, reason: s.phase.reason, main: s.hb.battleMainFuncName, text: textLog.peekAll().at(-1)?.text ?? null });
				if (await exec.nudge()) nudges++;
				lastNudge = frame;
			} else {
				await exec.tick(6);
			}
			if (frame - sigSince > opts.deadFrames) throw new NeedsHuman(`状态 ${Math.round(opts.deadFrames / 60)} 秒（模拟器时间）没有变化：${s.phase.reason}`, s);
			lastPhase = ph;
			continue;
		}

		if (ph === "prompt" && s.phase.promptKind === "learn_move") {
			// 学习新招式要连着"忘掉哪个招式"的界面，目前不支持；不盲按，交给人
			throw new NeedsHuman("遇到学习新招式的是/否提示（尚不支持，请人工处理）", s);
		}

		// ---- 需要决策的阶段 ----
		// 是/否框（典型："对手要换上 X，要不要换宝可梦？"）由模型回答；答"是"之后的换人菜单也由模型选
		const forcedSwitch = ph === "party_menu" && s.phase.forced;
		const promptSwitch = ph === "party_menu" && !forcedSwitch && afterPromptYes;
		if (ph === "party_menu" && !forcedSwitch && !promptSwitch) {
			await exec.press("B"); // 不是我们主动打开的队伍菜单（主动换人在执行器里一次完成）：取消回到上一层
			lastPhase = ph;
			continue;
		}
		if (ph === "action_menu") afterPromptYes = false;
		if (ph === "move_menu") {
			await exec.press("B"); // 只会在招式被拒后停在这里：回到行动菜单重新决策
			lastPhase = ph;
			continue;
		}

		if (ph === "action_menu" && !["action_menu", "move_menu"].includes(lastPhase)) {
			turn++;
			rejected = new Set();
			if (turn > opts.maxTurns) return summary(TURN_LIMIT, s, frame);
			emit({ type: "turn.start", turn });
		}
		if ((forcedSwitch || promptSwitch || ph === "prompt") && lastPhase !== ph) {
			rejected = new Set();
			emit({ type: "turn.start", turn });
		}

		const mode: ActionMode = forcedSwitch ? "forced_switch" : promptSwitch ? "prompt_switch" : ph === "prompt" ? "prompt" : "action";
		const legal = legalActions(s, mode).filter((a) => !rejected.has(a));
		if (legal.length === 0) throw new NeedsHuman(`没有可用的合法动作（已被拒绝：${[...rejected].join(",") || "-"}）`, s);

		// 模型看到的观测：用这段时间读到的战斗文字，经过可见性过滤
		const messages = textLog.drain();
		const observation = buildObservation({ snapshot: s, tracker, data, legal, turn, messages });
		emit({ type: "battle.state", turn, observation, truth: truthView(s) });

		let decision;
		await deps.pauseForThinking?.();
		try {
			decision = await policy.decide({ truth: s, observation, legal, turn, mode });
		} catch (e) {
			await deps.resumeAfterThinking?.();
			if (deps.shouldStop?.()) return summary(RELEASED, s, frame);
			if (e instanceof PolicyFailure) throw new NeedsHuman(`策略无法决策：${e.message}`, s);
			throw e;
		}
		if (!legal.includes(decision.choice)) throw new Error(`policy 选了非法动作 ${decision.choice}`);
		decisions++;
		const label = observation.legal_actions.find((a) => a.id === decision.choice)?.label ?? decision.choice;

		if (deps.confirm) {
			emit({ type: "action.confirm", turn, choice: decision.choice, label });
			const go = await deps.confirm(observation, decision.choice, label);
			if (!go) {
				await deps.resumeAfterThinking?.();
				if (deps.shouldStop?.()) return summary(RELEASED, s, frame);
				rejected.add(decision.choice); // 用户否决：让策略在剩余动作里重选
				lastPhase = ph;
				continue;
			}
		}

		await deps.resumeAfterThinking?.();
		emit({ type: "action.executing", turn, choice: decision.choice, label });
		const res = await execute(exec, decision.choice, s);
		emit({ type: "action.done", turn, choice: decision.choice, result: res });
		log?.({ type: "decision", battle: index, turn, frame, phase: ph, mode, player: s.player.species, opponent: s.opponent.species, playerHp: [s.player.hp, s.player.maxHp], opponentHp: [s.opponent.hp, s.opponent.maxHp], legal, choice: decision.choice, reason: decision.reason, meta: decision.meta, exec: res, observation });

		if (res.ok) {
			execFailures = 0;
			if (decision.choice === "prompt:yes") afterPromptYes = true;
		} else if (res.reason === "rejected") {
			rejections++;
			rejected.add(decision.choice);
		} else {
			execFailures++;
			if (execFailures >= opts.maxExecFailures) throw new NeedsHuman(`连续 ${execFailures} 次执行失败：${res.detail}`, s);
		}
		lastPhase = ph;
	}
}

export function execute(exec: InputExecutor, id: ActionId, s: BattleSnapshot): Promise<ExecResult> {
	const a = parseActionId(id);
	if (a.kind === "prompt") return exec.answerPrompt(a.yes);
	if (a.kind === "move") return exec.chooseMove(a.slot);
	return exec.chooseSwitch(a.partyIndex, s.party[a.partyIndex]?.personality);
}

/** 给操作者（UI）看的真值摘要——不会发给模型。 */
export function truthView(s: BattleSnapshot): unknown {
	return {
		player: { species: s.player.species, level: s.player.level, hp: s.player.hp, maxHp: s.player.maxHp, moves: s.player.moves, pp: s.player.pp },
		opponent: { species: s.opponent.species, level: s.opponent.level, hp: s.opponent.hp, maxHp: s.opponent.maxHp, moves: s.opponent.moves, pp: s.opponent.pp, ability: s.opponent.ability, item: s.opponent.item },
		enemyParty: s.enemyParty.map((m) => ({ species: m.species, level: m.level, hp: m.hp, maxHp: m.maxHp })),
	};
}
