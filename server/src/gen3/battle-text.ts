// 战斗文字日志：采样 gDisplayedStringBattle（当前显示的整句，占位符已展开），
// 去掉连续重复，得到玩家在屏幕上"读到"的消息序列。

import { decodeGen3Text } from "./charmap.js";

/** 把一条文字规整成单行（页内换行变空格）。 */
export function normalizeMessage(raw: string): string {
	return raw.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** 界面提示/名牌之类，不是"事件"：行动提示、只有名字+性别符号的行。 */
export function isNoiseMessage(text: string): boolean {
	return /^What will .+ do\?$/i.test(text) || /^[A-Za-z0-9' .-]+[♂♀]$/.test(text);
}

export class TextLog {
	private lastRaw = "";
	private readonly messages: Array<{ frame: number; text: string }> = [];

	/** 喂入一次采样；文字变化且非空时记录并返回新消息，否则返回 null。 */
	push(frame: number, bytes: Uint8Array): string | null {
		const raw = decodeGen3Text(bytes);
		if (raw === this.lastRaw) return null;
		this.lastRaw = raw;
		const text = normalizeMessage(raw);
		if (!text) return null;
		this.messages.push({ frame, text });
		return text;
	}

	/** 取出自上次调用以来的消息（决策时用来生成 last_turn）。 */
	drain(): string[] {
		return this.messages.splice(0).map((m) => m.text).filter((t) => !isNoiseMessage(t));
	}

	peekAll(): ReadonlyArray<{ frame: number; text: string }> {
		return this.messages;
	}

	reset(): void {
		this.lastRaw = "";
		this.messages.length = 0;
	}
}
