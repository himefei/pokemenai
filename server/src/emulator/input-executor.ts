// 输入执行器：把"选招 / 换人"翻成按键序列。全部闭环——按一下、回读光标/阶段、再按；不做盲按。

import type { SymbolTable } from "../gen3/symbols.js";
import type { EmulatorLink } from "./rpc.js";
import { readActiveTaskNames, readHeartbeat } from "./heartbeat.js";
import type { Heartbeat } from "./heartbeat.js";
import { PARTY_MON_SIZE, PARTY_SIZE, PM } from "../gen3/structs.js";
import type { Phase, PhaseDetector, PhaseInfo } from "./phase.js";
import type { GbaKey } from "./protocol.js";

export interface ExecutorOptions {
	holdFrames?: number;
	waitFrames?: number;
	/** 单次光标导航最多按键次数 */
	maxNavPresses?: number;
	/** 等待某个阶段出现的默认帧数上限 */
	phaseTimeoutFrames?: number;
	/** 每次轮询之间推进的帧数 */
	pollFrames?: number;
}

export interface Snap {
	hb: Heartbeat;
	info: PhaseInfo;
}

export type ExecFailure = {
	ok: false;
	/** rejected: 游戏拒绝了动作（0 PP/被束缚/被禁用…），阶段没推进；其余为执行故障 */
	reason: "rejected" | "timeout" | "unexpected_phase" | "nav_failed";
	detail: string;
};
export type ExecResult = { ok: true; note?: string } | ExecFailure;

const fail = (reason: ExecFailure["reason"], detail: string): ExecFailure => ({ ok: false, reason, detail });
const isFail = (x: unknown): x is ExecFailure => typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;

/** 行动菜单 2x2：0 战斗 1 背包 / 2 宝可梦 3 逃跑 */
export const ACTION_FIGHT = 0;
export const ACTION_POKEMON = 2;

type PartyKey = "DOWN" | "UP" | "RIGHT" | "LEFT";

export class InputExecutor {
	private readonly hold: number;
	private readonly wait: number;
	private readonly maxNav: number;
	private readonly phaseTimeout: number;
	private readonly poll: number;

	constructor(
		private readonly client: EmulatorLink,
		private readonly syms: SymbolTable,
		private readonly detector: PhaseDetector,
		opts: ExecutorOptions = {},
	) {
		this.hold = opts.holdFrames ?? 4;
		this.wait = opts.waitFrames ?? 8;
		this.maxNav = opts.maxNavPresses ?? 14;
		this.phaseTimeout = opts.phaseTimeoutFrames ?? 240;
		this.poll = opts.pollFrames ?? 3;
	}

	async look(): Promise<Snap> {
		const hb = await readHeartbeat(this.client, this.syms);
		return { hb, info: this.detector.classify(hb) };
	}

	tick(frames: number): Promise<unknown> {
		return this.client.request("wait", { frames }, 15000);
	}

	async press(key: GbaKey): Promise<void> {
		await this.client.request("press", { seq: [{ keys: [key], hold: this.hold, wait: this.wait }] }, 15000);
	}

	/** 轮询直到 pred 成立或超过 maxFrames（按模拟器帧计，不受快进影响）。 */
	async until(pred: (s: Snap) => boolean, maxFrames = this.phaseTimeout): Promise<Snap | null> {
		let s = await this.look();
		const start = s.hb.frame;
		while (!pred(s)) {
			if (s.hb.frame - start > maxFrames) return null;
			await this.tick(this.poll);
			s = await this.look();
		}
		return s;
	}

	// ---- 2x2 网格光标（行动菜单 / 招式菜单）----

	private async navGrid(read: (h: Heartbeat) => number, target: number, allowed: Phase[]): Promise<Snap | ExecFailure> {
		let s = await this.look();
		let noChange = 0;
		for (let i = 0; i <= this.maxNav; i++) {
			if (!allowed.includes(s.info.phase)) return fail("unexpected_phase", `导航中进入 ${s.info.phase} (${s.info.reason})`);
			const cur = read(s.hb);
			if (cur === target) return s;
			if (i === this.maxNav) break;
			const key: GbaKey =
				(cur & 1) !== (target & 1) ? ((target & 1) === 1 ? "RIGHT" : "LEFT") : (target >> 1) > (cur >> 1) ? "DOWN" : "UP";
			await this.press(key);
			s = await this.look();
			noChange = read(s.hb) === cur ? noChange + 1 : 0;
			if (noChange >= 3) return fail("nav_failed", `光标停在 ${cur}，按 ${key} 没有反应（目标 ${target}）`);
		}
		return fail("nav_failed", `导航超过 ${this.maxNav} 次按键仍未到达 ${target}`);
	}

	// ---- 队伍菜单光标：拓扑未知，边按边学（BFS）----

	private async navParty(target: number): Promise<Snap | ExecFailure> {
		const edges = new Map<number, Map<PartyKey, number>>();
		const edgesOf = (n: number) => {
			let m = edges.get(n);
			if (!m) edges.set(n, (m = new Map()));
			return m;
		};
		const order = (cur: number): PartyKey[] => (target > cur || cur === 0 ? ["DOWN", "RIGHT", "UP", "LEFT"] : ["UP", "LEFT", "DOWN", "RIGHT"]);

		const plan = (from: number): PartyKey | null => {
			// 在已学到的图上找：到目标的最短路径；找不到就去最近的"还有没试过的键"的节点
			const prev = new Map<number, { from: number; key: PartyKey } | null>([[from, null]]);
			const queue = [from];
			let goal: number | null = null;
			let explore: number | null = null;
			while (queue.length) {
				const n = queue.shift()!;
				if (n === target) {
					goal = n;
					break;
				}
				if (explore === null && order(n).some((k) => !edgesOf(n).has(k))) explore = n;
				for (const [k, m] of edgesOf(n)) {
					if (m !== n && !prev.has(m)) {
						prev.set(m, { from: n, key: k });
						queue.push(m);
					}
				}
			}
			const dest = goal ?? explore;
			if (dest === null) return null;
			if (dest === from) return order(from).find((k) => !edgesOf(from).has(k)) ?? null;
			let node = dest;
			let step: PartyKey | null = null;
			for (let p = prev.get(node); p; p = prev.get(node)) {
				step = p.key;
				node = p.from;
			}
			return step;
		};

		let s = await this.look();
		for (let i = 0; i < this.maxNav * 2; i++) {
			if (s.info.phase !== "party_menu") return fail("unexpected_phase", `队伍菜单导航中进入 ${s.info.phase}`);
			const cur = s.hb.partyMenu.slotId;
			if (cur === target) return s;
			const key = plan(cur);
			if (!key) return fail("nav_failed", `队伍菜单里找不到通往槽位 ${target} 的路径（当前 ${cur}）`);
			await this.press(key);
			s = await this.look();
			edgesOf(cur).set(key, s.hb.partyMenu.slotId);
		}
		return fail("nav_failed", `队伍菜单导航超过 ${this.maxNav * 2} 次按键仍未到达槽位 ${target}`);
	}

	// ---- 动作 ----

	/** 选招。可从 action_menu 或 move_menu 开始（招式被拒后可在招式菜单里改选）。 */
	async chooseMove(slot: number): Promise<ExecResult> {
		let s = await this.look();
		let note: string | undefined;

		if (s.info.phase === "action_menu") {
			const r = await this.navGrid((h) => h.actionCursor[0]!, ACTION_FIGHT, ["action_menu"]);
			if (isFail(r)) return r;
			await this.press("A");
			const moveMenu = await this.until((x) => x.info.phase === "move_menu", 150);
			if (!moveMenu) {
				// 没出招式菜单：可能是强制出招（挣扎/连续技），只要已经离开行动菜单就算成功
				s = await this.look();
				if (s.info.phase === "action_menu") return fail("rejected", "按 A 后仍停在行动菜单");
				return { ok: true, note: "no_move_menu(forced move)" };
			}
			s = moveMenu;
		}
		if (s.info.phase !== "move_menu") return fail("unexpected_phase", `选招需要在行动/招式菜单，当前 ${s.info.phase}`);

		const nav = await this.navGrid((h) => h.moveCursor[0]!, slot, ["move_menu"]);
		if (isFail(nav)) return nav;
		await this.press("A");
		const left = await this.until((x) => x.info.phase !== "move_menu", 90);
		if (!left) return fail("rejected", `招式 ${slot} 被拒绝（阶段仍是招式菜单：0 PP/被禁用/无法使用）`);
		return { ok: true, note };
	}

	/**
	 * 队伍菜单打开期间，游戏会把场上宝可梦临时换到槽位 0（取消/退出后恢复），
	 * 所以战斗时的下标 ≠ 菜单里的槽位。按宝可梦自身的 personality 在菜单打开后重新定位。
	 */
	private async menuSlotOf(personality: number): Promise<number | null> {
		const [raw] = await this.client.read([{ addr: this.syms.addr("gPlayerParty"), len: PARTY_MON_SIZE * PARTY_SIZE }]);
		const v = new DataView(raw!.buffer, raw!.byteOffset, raw!.byteLength);
		for (let i = 0; i < PARTY_SIZE; i++) if (v.getUint32(i * PARTY_MON_SIZE + PM.personality, true) === personality >>> 0) return i;
		return null;
	}

	/**
	 * 换人。从 action_menu（主动）或 party_menu（强制/已打开）开始。
	 * @param partyIndex 决策时 gPlayerParty 的下标（personality 缺省时直接当菜单槽位用）
	 * @param personality 目标宝可梦的 personality，用来在菜单里定位
	 */
	async chooseSwitch(partyIndex: number, personality?: number): Promise<ExecResult> {
		let s = await this.look();
		if (s.info.phase === "action_menu") {
			const r = await this.navGrid((h) => h.actionCursor[0]!, ACTION_POKEMON, ["action_menu"]);
			if (isFail(r)) return r;
			await this.press("A");
			const party = await this.until((x) => x.info.phase === "party_menu", 240);
			if (!party) return fail("rejected", "按 A 后没有进入队伍菜单");
			s = party;
		}
		if (s.info.phase !== "party_menu") return fail("unexpected_phase", `换人需要在行动菜单或队伍菜单，当前 ${s.info.phase}`);

		let slot = partyIndex;
		if (personality !== undefined) {
			const found = await this.menuSlotOf(personality);
			if (found === null) return fail("nav_failed", `队伍菜单里找不到 personality=${personality >>> 0} 的宝可梦`);
			slot = found;
		}

		const nav = await this.navParty(slot);
		if (isFail(nav)) return nav;
		await this.press("A");
		const popup = await this.untilTask("Task_HandleSelectionMenuInput", 90);
		if (!popup) {
			await this.press("B");
			return fail("rejected", `槽位 ${slot} 选不中（没有弹出子菜单）`);
		}
		await this.press("A"); // 子菜单第一项 = 换上 / 派出
		const left = await this.until((x) => x.info.phase !== "party_menu", 180);
		if (!left) {
			await this.press("B"); // 关掉可能的提示文字/子菜单
			return fail("rejected", `换到槽位 ${slot} 被拒绝（被束缚/已在场上/已倒下）`);
		}
		return { ok: true };
	}

	private async untilTask(name: string, maxFrames: number): Promise<boolean> {
		let start: number | null = null;
		for (;;) {
			const tasks = await readActiveTaskNames(this.client, this.syms);
			if (tasks.includes(name)) return true;
			const now = (await this.look()).hb.frame;
			start ??= now;
			if (now - start > maxFrames) return false;
			await this.tick(this.poll);
		}
	}

	/**
	 * 回答战斗里的是/否框（battle script 的 yesnobox）：光标在 gBattleCommunication[1]，0=是 1=否。
	 * 闭环：先把光标移到目标，回读确认，再按 A；之后等框消失。
	 */
	async answerPrompt(yes: boolean): Promise<ExecResult> {
		const want = yes ? 0 : 1;
		let s = await this.look();
		if (s.info.phase !== "prompt") return fail("unexpected_phase", `回答提示需要在是/否框里，当前 ${s.info.phase}`);
		for (let i = 0; i < 4 && s.hb.commCursor !== want; i++) {
			await this.press(want === 0 ? "UP" : "DOWN");
			s = await this.look();
			if (s.info.phase !== "prompt") return fail("unexpected_phase", `移动光标时离开了提示（${s.info.phase}）`);
		}
		if (s.hb.commCursor !== want) return fail("nav_failed", `是/否光标停在 ${s.hb.commCursor}，没能移到 ${want}`);
		await this.press("A");
		const left = await this.until((x) => x.info.phase !== "prompt", 180);
		return left ? { ok: true } : fail("rejected", "按 A 后仍停在是/否框");
	}

	/**
	 * 战斗文字/动画卡住时的"推进一下"：只按 A，调用方负责限频。
	 * 按之前再确认一次：只有确定是普通的"等文字"状态才按，绝不在任何菜单/是否框里盲按。
	 * @returns 是否真的按了
	 */
	async nudge(): Promise<boolean> {
		const s = await this.look();
		if (s.info.phase !== "battle_busy") return false;
		await this.press("A");
		return true;
	}
}
