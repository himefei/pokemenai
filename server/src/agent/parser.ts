// 模型输出解析：宽松提取最后一个含 choice 的 JSON 对象，校验必须在 legal_actions 内。
// 兼容 ``` 代码块、<think>…</think>、reasoning_content（由 LLM 层单独拆出，不参与解析）。

export type ParseResult = { ok: true; choice: string; reason: string } | { ok: false; error: string };

export function stripThink(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");
}

/** 找出文本里所有"括号配平"的顶层 JSON 对象字符串（考虑字符串里的括号与转义）。 */
function extractObjects(text: string): string[] {
	const out: string[] = [];
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < text.length; i++) {
			const c = text[i]!;
			if (inStr) {
				if (esc) esc = false;
				else if (c === "\\") esc = true;
				else if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') inStr = true;
			else if (c === "{") depth++;
			else if (c === "}" && --depth === 0) {
				out.push(text.slice(start, i + 1));
				break;
			}
		}
	}
	return out;
}

export function parseDecision(content: string, legal: readonly string[]): ParseResult {
	const text = stripThink(content).replace(/```(?:json)?/gi, "");
	const candidates = extractObjects(text);
	for (let i = candidates.length - 1; i >= 0; i--) {
		let obj: unknown;
		try {
			obj = JSON.parse(candidates[i]!);
		} catch {
			continue;
		}
		if (!obj || typeof obj !== "object" || !("choice" in obj)) continue;
		const rec = obj as { choice: unknown; reason?: unknown };
		const choice = typeof rec.choice === "string" ? rec.choice.trim() : String(rec.choice);
		if (!legal.includes(choice)) return { ok: false, error: `choice "${choice}" 不在 legal_actions 里。合法选项：${legal.join(", ")}` };
		return { ok: true, choice, reason: typeof rec.reason === "string" ? rec.reason : "" };
	}
	return { ok: false, error: "没有找到形如 {\"choice\":\"...\",\"reason\":\"...\"} 的 JSON。请在最后一行只输出一个这样的 JSON。" };
}
