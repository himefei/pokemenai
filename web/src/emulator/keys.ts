// 键位：还原桌面 mGBA 的配置（~/.config/mgba/config.ini 里的 [gba.input.QT_K]）：
//   A=K  B=J  L=L  R=;  Start=M  Select=N  上=W  下=S  左=A  右=D
// 核心自带的键盘处理关掉，改用我们自己的监听（核心的默认键位会把 A 键同时当成 L 键）。

export type GbaButton = "A" | "B" | "Select" | "Start" | "Right" | "Left" | "Up" | "Down" | "R" | "L";

export const KEY_MAP: Readonly<Record<string, GbaButton>> = {
	KeyK: "A",
	KeyJ: "B",
	KeyL: "L",
	Semicolon: "R",
	KeyM: "Start",
	KeyN: "Select",
	KeyW: "Up",
	KeyS: "Down",
	KeyA: "Left",
	KeyD: "Right",
};

/** 协议里的键名（大写）-> 核心的键名 */
export const PROTOCOL_TO_BUTTON: Readonly<Record<string, GbaButton>> = {
	A: "A",
	B: "B",
	SELECT: "Select",
	START: "Start",
	RIGHT: "Right",
	LEFT: "Left",
	UP: "Up",
	DOWN: "Down",
	R: "R",
	L: "L",
};

export function toButtons(keys: readonly string[]): GbaButton[] {
	return keys.map((k) => {
		const b = PROTOCOL_TO_BUTTON[k];
		if (!b) throw new Error(`unknown key: ${k}`);
		return b;
	});
}

/** 在输入框、文本域里打字时不要抢键盘。 */
export function isTypingTarget(t: EventTarget | null): boolean {
	const el = t as HTMLElement | null;
	if (!el || !el.tagName) return false;
	const tag = el.tagName.toLowerCase();
	return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}
