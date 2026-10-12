// 控制器状态机（计划 4.7）：
//   Idle ─[接管]→ Waiting；Idle ─[武装]→ Armed ─[战斗开始]→ Waiting
//   Waiting ─[行动菜单/强制换人]→ Deciding（调模型）→ Executing → Waiting
//   模型出错 / 未知阶段超时 / 连续执行失败 → NeedsHuman（如实报错，没有兜底）
//   战斗结束 → Finished（写入 run 结果）→ Idle；任意 ─[释放/急停]→ Idle

import { EventEmitter } from "node:events";
import type { EmulatorLink } from "../emulator/rpc.js";
import type { InputExecutor } from "../emulator/input-executor.js";
import type { PhaseDetector } from "../emulator/phase.js";
import type { TextLog } from "../gen3/battle-text.js";
import type { Gen3Data } from "../gen3/data.js";
import type { SymbolTable } from "../gen3/symbols.js";
import { RunLog, newRunId } from "../eval/run-log.js";
import { NeedsHuman, RELEASED, runBattleLoop } from "./battle-loop.js";
import type { ControllerState, EventSink, AgentEvent, BattleSummary } from "./events.js";
import type { Policy } from "./policy.js";
import type { BattleTracker } from "./tracker.js";
import type { ActionId } from "../gen3/battle-state.js";
import type { LoopOptions } from "./battle-loop.js";

export interface ControllerDeps {
	client: EmulatorLink;
	syms: SymbolTable;
	data: Gen3Data;
	detector: PhaseDetector;
	exec: InputExecutor;
	textLog: TextLog;
	tracker: BattleTracker;
	/** 每次接管开始时调用：快照当前模型与参数，构造策略（策略的事件要发到传入的 sink） */
	makePolicy: (sink: EventSink) => { policy: Policy; meta: Record<string, unknown> };
	loopOptions?: Partial<LoopOptions>;
}

export interface ControllerStatus {
	state: ControllerState;
	detail?: string;
	confirmMode: boolean;
	runId: string | null;
	pendingConfirm: { turn: number; choice: string; label: string } | null;
}

export class Controller extends EventEmitter {
	private state: ControllerState = "idle";
	private detail: string | undefined;
	private stopRequested = false;
	private confirmMode = false;
	private runId: string | null = null;
	private current: Promise<void> | null = null;
	private policy: Policy | null = null;
	private pendingConfirm: { turn: number; choice: string; label: string; resolve: (ok: boolean) => void } | null = null;

	constructor(private readonly deps: ControllerDeps) {
		super();
	}

	status(): ControllerStatus {
		const p = this.pendingConfirm;
		return { state: this.state, detail: this.detail, confirmMode: this.confirmMode, runId: this.runId, pendingConfirm: p ? { turn: p.turn, choice: p.choice, label: p.label } : null };
	}

	onEvent(fn: EventSink): () => void {
		this.on("event", fn);
		return () => this.off("event", fn);
	}

	private emitEvent(e: AgentEvent): void {
		this.emit("event", e);
	}

	private setState(state: ControllerState, detail?: string): void {
		this.state = state;
		this.detail = detail;
		this.emitEvent({ type: "controller.state", state, detail });
	}

	setConfirmMode(on: boolean): void {
		this.confirmMode = on;
		if (!on) this.resolveConfirm(true);
		this.emitEvent({ type: "controller.state", state: this.state, detail: this.detail });
	}

	/** 确认模式：用户点"执行"(true) 或"否决"(false)。 */
	confirm(ok: boolean): boolean {
		if (!this.pendingConfirm) return false;
		this.resolveConfirm(ok);
		return true;
	}

	private resolveConfirm(ok: boolean): void {
		const p = this.pendingConfirm;
		this.pendingConfirm = null;
		p?.resolve(ok);
	}

	private busy(): boolean {
		return this.state !== "idle" && this.state !== "finished" && this.state !== "needs_human";
	}

	/** 接管当前战斗：动画进行中则等到行动菜单再开始。 */
	takeover(): void {
		if (this.busy()) throw new Error(`控制器忙（${this.state}）`);
		this.start(false);
	}

	/** 武装：下一场战斗开始后自动接管。 */
	arm(): void {
		if (this.busy()) throw new Error(`控制器忙（${this.state}）`);
		this.start(true);
	}

	private start(armed: boolean): void {
		this.stopRequested = false;
		this.setState(armed ? "armed" : "waiting");
		this.current = this.run(armed).catch((e) => {
			this.emitEvent({ type: "error", message: (e as Error).message });
			this.setState("needs_human", `内部错误：${(e as Error).message}`);
		});
	}

	/** 释放：下一个安全点交还控制（当前动作做完）。 */
	release(): void {
		this.stopRequested = true;
		this.resolveConfirm(false);
	}

	/** 急停：取消模型请求、释放按键、立即交还。 */
	async emergencyStop(): Promise<void> {
		this.stopRequested = true;
		this.resolveConfirm(false);
		(this.policy as { cancel?: () => void } | null)?.cancel?.();
		try {
			await this.deps.client.request("reset_keys");
		} catch {
			/* 模拟器没连上也无所谓 */
		}
	}

	async whenIdle(): Promise<void> {
		await this.current;
	}

	private async run(armed: boolean): Promise<void> {
		const { client, syms, data, detector, exec, textLog, tracker } = this.deps;
		let log: RunLog | null = null;
		// 唯一的事件出口：落盘 + 广播 + 驱动控制器状态
		const sink: EventSink = (e) => {
			if (e.type === "battle.state") this.setState("deciding");
			else if (e.type === "action.executing") this.setState("executing");
			else if (e.type === "action.done") this.setState("waiting");
			log?.event(e);
			this.emitEvent(e);
		};
		const { policy, meta } = this.deps.makePolicy(sink);
		this.policy = policy;
		const runId = newRunId();
		this.runId = runId;
		log = new RunLog({ runId, startedAt: new Date().toISOString(), policy: policy.name, ...meta });

		try {
			if (armed) {
				for (;;) {
					if (this.stopRequested) throw new Released();
					if ((await exec.look()).hb.inBattle) break;
					await exec.tick(10);
				}
				this.setState("waiting", "战斗开始，接管");
			}
			const summary = await runBattleLoop(1, null, {
				client,
				syms,
				data,
				detector,
				exec,
				textLog,
				tracker,
				policy,
				sink,
				log: (rec) => log?.extra(rec),
				// 网页模拟器支持暂停：模型思考期间游戏暂停（Lua 桥不支持，请求失败就忽略）
				pauseForThinking: () => client.request("pause").then(() => undefined, () => undefined),
				resumeAfterThinking: () => client.request("resume").then(() => undefined, () => undefined),
				shouldStop: () => this.stopRequested,
				confirm: this.confirmMode ? (obs, choice, label) => this.askConfirm(obs.turn, choice, label) : undefined,
				options: this.deps.loopOptions,
			});
			log.end(summary);
			this.emitEvent({ type: "battle.end", result: summary });
			if (summary.outcome === RELEASED) this.setState("idle", "已释放");
			else this.setState("finished", summary.outcomeName);
		} catch (e) {
			if (e instanceof Released) {
				log.end(null);
				this.setState("idle", "已释放");
				return;
			}
			const msg = e instanceof NeedsHuman ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
			log.end(null, msg);
			this.emitEvent({ type: "error", message: msg });
			this.setState("needs_human", msg);
		} finally {
			this.policy = null;
			this.runId = null;
			await client.request("resume").then(() => undefined, () => undefined); // 不管怎么退出都别让游戏停在暂停状态
		}
	}

	private askConfirm(turn: number, choice: string, label: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.pendingConfirm = { turn, choice, label, resolve };
			this.setState("paused", `等待确认：${label}`);
		}).then((ok) => {
			if (this.state === "paused") this.setState("executing");
			return ok;
		});
	}
}

class Released extends Error {}

export type { ActionId, BattleSummary };
