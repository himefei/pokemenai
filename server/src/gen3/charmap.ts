// Gen 3 国际版（英文）字符编码 -> 字符串。
// 种类以 species ID 为准；这里用于昵称显示和战斗文字（gDisplayedStringBattle）解码。

const MAP: Record<number, string> = { 0x00: " " };

function range(start: number, chars: string): void {
	for (let i = 0; i < chars.length; i++) MAP[start + i] = chars[i]!;
}

range(0xa1, "0123456789");
MAP[0xab] = "!";
MAP[0xac] = "?";
MAP[0xad] = ".";
MAP[0xae] = "-";
MAP[0xaf] = "·";
MAP[0xb0] = "…";
MAP[0xb1] = "“";
MAP[0xb2] = "”";
MAP[0xb3] = "‘";
// 0xB4 在英文文本里就是撇号（"Foe X's Intimidate"），统一成 ASCII 以便匹配
MAP[0xb4] = "'";
MAP[0xb5] = "♂";
MAP[0xb6] = "♀";
MAP[0xb7] = "$";
MAP[0xb8] = ",";
MAP[0xb9] = "×";
MAP[0xba] = "/";
range(0xbb, "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
range(0xd5, "abcdefghijklmnopqrstuvwxyz");
MAP[0x1b] = "é"; // POKéMON
MAP[0xef] = "▶";
MAP[0xf0] = ":";

export const TERMINATOR = 0xff;
const NEWLINE = 0xfe;
const PAGE_BREAK_A = 0xfa; // \l 滚动换行
const PAGE_BREAK_B = 0xfb; // \p 翻页
const EXT_CTRL = 0xfc;
const PLACEHOLDER = 0xfd;

/** 0xFC 扩展控制码后面跟的参数字节数 */
const EXT_ARGS: Record<number, number> = {
	0x01: 1, 0x02: 1, 0x03: 1, 0x04: 3, 0x05: 1, 0x06: 1, 0x07: 0, 0x08: 1, 0x09: 0, 0x0a: 0, 0x0b: 2, 0x0c: 1,
	0x0d: 1, 0x0e: 1, 0x0f: 0, 0x10: 2, 0x11: 1, 0x12: 1, 0x13: 1, 0x14: 1, 0x15: 0, 0x16: 0, 0x17: 0, 0x18: 0,
};

/** 简单字符串（昵称等）：遇到终止符停止，未知字节记为 "?"。 */
export function decodeGen3String(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) {
		if (b === TERMINATOR) break;
		out += MAP[b] ?? "?";
	}
	return out;
}

/** 带控制码的文本（战斗文字）：换行/翻页变成 "\n"，颜色等扩展码被丢弃。 */
export function decodeGen3Text(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]!;
		if (b === TERMINATOR) break;
		if (b === NEWLINE || b === PAGE_BREAK_A || b === PAGE_BREAK_B) {
			out += "\n";
		} else if (b === EXT_CTRL) {
			i += 1 + (EXT_ARGS[bytes[i + 1] ?? 0] ?? 0);
		} else if (b === PLACEHOLDER) {
			out += "{?}";
			i += 1;
		} else {
			out += MAP[b] ?? "?";
		}
	}
	return out;
}
