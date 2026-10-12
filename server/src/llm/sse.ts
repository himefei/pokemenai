// 极简 SSE 解析 + <think> 标签路由。

/** 把 fetch 的 body 逐个 `data:` 事件吐出来（支持 event: 行，Anthropic 用）。 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
				const block = buf.slice(0, idx);
				buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
				const ev = parseBlock(block);
				if (ev) yield ev;
			}
		}
		const tail = parseBlock(buf);
		if (tail) yield tail;
	} finally {
		reader.releaseLock();
	}
}

function parseBlock(block: string): { event?: string; data: string } | null {
	let event: string | undefined;
	const data: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	return data.length ? { event, data: data.join("\n") } : null;
}

/**
 * 流式文本里可能出现 <think>…</think>（本地推理模型常见）。
 * feed() 返回这次新增文字该归到 content 还是 reasoning；标签可能被切在两个 chunk 之间。
 */
export class ThinkRouter {
	private inThink = false;
	private pending = "";

	feed(chunk: string): Array<{ kind: "content" | "reasoning"; text: string }> {
		const out: Array<{ kind: "content" | "reasoning"; text: string }> = [];
		let s = this.pending + chunk;
		this.pending = "";
		for (;;) {
			const tag = this.inThink ? "</think>" : "<think>";
			const i = s.indexOf(tag);
			if (i >= 0) {
				if (i > 0) out.push({ kind: this.inThink ? "reasoning" : "content", text: s.slice(0, i) });
				this.inThink = !this.inThink;
				s = s.slice(i + tag.length);
				continue;
			}
			// 末尾可能是标签的前缀，先留着
			const keep = longestSuffixPrefix(s, tag);
			if (keep > 0) {
				this.pending = s.slice(s.length - keep);
				s = s.slice(0, s.length - keep);
			}
			if (s) out.push({ kind: this.inThink ? "reasoning" : "content", text: s });
			return out;
		}
	}

	flush(): Array<{ kind: "content" | "reasoning"; text: string }> {
		const p = this.pending;
		this.pending = "";
		return p ? [{ kind: this.inThink ? "reasoning" : "content", text: p }] : [];
	}
}

function longestSuffixPrefix(s: string, tag: string): number {
	for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n;
	return 0;
}
