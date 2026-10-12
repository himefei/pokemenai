// 管理两个槽位（A / B）。每个槽位 = 一个独立的模拟器 + 控制器 + 模型设置 + 运行日志。
// "对比"模式下 A、B 各玩各的游戏、各用各的模型。

import { SLOT_IDS } from "../config.js";
import type { SlotId } from "../config.js";
import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";

export interface CompareStartOptions {
	/** 两边都读这个存档点（mGBA save state 槽位 1–9） */
	stateSlot: number;
	/** 两边写同一个随机数种子；不给就随机一个 */
	seed?: number;
}

export class SessionManager {
	readonly sessions: Partial<Record<SlotId, Session>> = {};

	constructor(opts: SessionOptions & { slots?: readonly SlotId[] } = {}) {
		for (const slot of opts.slots ?? SLOT_IDS) {
			// 只有槽位 A 可以接 mGBA 的 Lua 桥（emuPort）；其余槽位只用网页模拟器
			const { slots: _slots, ...rest } = opts;
			void _slots;
			this.sessions[slot] = new Session({ ...rest, slot, emuPort: slot === "a" ? opts.emuPort : undefined, link: slot === "a" ? opts.link : undefined });
		}
	}

	/** 把一个已有的 Session 包成单槽位管理器（测试 / 兼容旧用法）。 */
	static single(session: Session): SessionManager {
		const m = Object.create(SessionManager.prototype) as SessionManager;
		(m as { sessions: Partial<Record<SlotId, Session>> }).sessions = { [session.slot]: session };
		return m;
	}

	get(slot: string | undefined): Session | undefined {
		return this.sessions[(slot ?? "a") as SlotId];
	}

	all(): Session[] {
		return Object.values(this.sessions).filter((s): s is Session => !!s);
	}

	async start(): Promise<void> {
		await Promise.all(this.all().map((s) => s.start()));
	}

	async stop(): Promise<void> {
		await Promise.all(this.all().map((s) => s.stop()));
	}

	/**
	 * 公平对比的一键开始：两边都暂停 → 读同一个存档点 → 写同一个随机数种子 → 同时继续并接管。
	 * 任何一边没准备好就整体不开始（不会出现一边先跑的情况）。
	 */
	async startCompare(opts: CompareStartOptions): Promise<{ seed: number }> {
		const sessions = this.all();
		for (const s of sessions) {
			const st = s.status();
			if (!st.emu.connected || !st.emu.romOk) throw new Error(`槽位 ${s.slot.toUpperCase()} 的模拟器没准备好：${st.emu.message ?? "未连接"}`);
			if (!["idle", "finished", "needs_human"].includes(st.controller.state)) throw new Error(`槽位 ${s.slot.toUpperCase()} 还在运行（${st.controller.state}），先释放`);
		}
		const seed = (opts.seed ?? Math.floor(Math.random() * 0x100000000)) >>> 0;
		await Promise.all(sessions.map((s) => s.pauseEmu()));
		try {
			await Promise.all(sessions.map((s) => s.loadState(opts.stateSlot)));
			await Promise.all(sessions.map((s) => s.setRng(seed)));
		} finally {
			await Promise.all(sessions.map((s) => s.resumeEmu()));
		}
		for (const s of sessions) s.controller.takeover();
		return { seed };
	}
}
