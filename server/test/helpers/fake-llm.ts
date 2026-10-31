// 假的 LLM HTTP 服务：OpenAI 兼容（SSE）、Anthropic（SSE）、LM Studio / Ollama 的发现接口。
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeLlmOptions {
	/** OpenAI 流式的 delta 序列（每项一个 chunk 的 delta） */
	openaiDeltas?: Array<Record<string, unknown>>;
	/** 按调用次序给不同的回复（第 n 次调用用第 n 项，用完重复最后一项）；优先于 openaiDeltas */
	openaiSequence?: Array<Array<Record<string, unknown>>>;
	openaiStatus?: number;
	/** Anthropic 事件序列 */
	anthropicEvents?: Array<Record<string, unknown>>;
	/** 响应前人为延迟（测超时） */
	delayMs?: number;
	models?: string[];
	/** /v1/models 返回的完整条目（带 max_model_len / meta.n_ctx 等字段）；给了就不用 models */
	modelEntries?: Array<Record<string, unknown>>;
	/** 其他 GET/POST 路径直接返回的 JSON（如 "/props"、"/api/ps"）；优先于内置路由 */
	routes?: Record<string, unknown>;
	/** /v1/chat/completions 的用量（默认固定 11 / 7）；传函数可以按请求内容算（让 prompt_tokens 随对话增长） */
	openaiUsage?: (body: any, n: number) => { prompt_tokens: number; completion_tokens: number };
	/** /v1/responses：stateful = 真的存对话；stateless = 带 previous_response_id 就 400；ignore = 接受参数但悄悄忽略 */
	responses?: "stateful" | "stateless" | "ignore";
	/** /v1/responses 的回复：拿到这次能看到的全部对话，返回回复文字 */
	responsesReply?: (conversation: Array<{ role: string; content: string }>, body: any) => string | { content: string; reasoning?: string };
}

export class FakeLlm {
	readonly requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
	private server: http.Server;
	baseUrl = "";
	private stored = new Map<string, Array<{ role: string; content: string }>>();
	private respN = 0;
	private chatN = 0;

	constructor(private opts: FakeLlmOptions = {}) {
		this.server = http.createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const raw = Buffer.concat(chunks).toString();
			const body = raw ? JSON.parse(raw) : undefined;
			this.requests.push({ url: req.url ?? "", headers: req.headers, body });
			if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
			this.route(req, res, body);
		});
	}

	async start(): Promise<string> {
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
		this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
		return this.baseUrl;
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((r) => this.server.close(() => r()));
	}

	private route(req: http.IncomingMessage, res: http.ServerResponse, body: any): void {
		const json = (v: unknown, status = 200) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(v));
		};
		const sse = (events: Array<{ event?: string; data: unknown }>) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
			res.end();
		};

		const url = (req.url ?? "").split("?")[0]!;
		if (this.opts.routes && url in this.opts.routes) return json(this.opts.routes[url]);

		if (url === "/v1/chat/completions") {
			if (this.opts.openaiStatus && this.opts.openaiStatus !== 200) return json({ error: { message: "nope" } }, this.opts.openaiStatus);
			const n = ++this.chatN;
			const seq = this.opts.openaiSequence;
			const deltas = seq ? seq[Math.min(n - 1, seq.length - 1)]! : (this.opts.openaiDeltas ?? [{ content: "ok" }]);
			const usage = this.opts.openaiUsage?.(body, n) ?? { prompt_tokens: 11, completion_tokens: 7 };
			return sse([
				...deltas.map((d) => ({ data: { choices: [{ delta: d }] } })),
				{ data: { choices: [{ delta: {}, finish_reason: "stop" }], usage } },
				{ data: "[DONE]" },
			]);
		}
		if (url === "/v1/responses") return this.respond(res, body, json, sse);
		if (req.url === "/v1/messages") {
			return sse((this.opts.anthropicEvents ?? []).map((e) => ({ event: String(e.type), data: e })));
		}
		if (req.url === "/v1/models") {
			if (this.opts.modelEntries) return json({ data: this.opts.modelEntries });
			if (req.headers["x-api-key"] !== undefined) return json({ data: (this.opts.models ?? ["claude-x"]).map((id) => ({ id })) });
			return json({ data: (this.opts.models ?? ["m1", "m2"]).map((id) => ({ id })) });
		}
		if (req.url === "/api/v0/models") return json({ data: [{ id: "m1", type: "llm", state: "loaded", loaded_context_length: 8192 }, { id: "m2", type: "vlm", state: "not-loaded" }] });
		if (req.url === "/api/tags") return json({ models: [{ name: "llama3:8b" }] });
		if (req.url === "/api/show") return json({ capabilities: ["completion", "vision", "thinking"] });
		void body;
		json({ error: "not found" }, 404);
	}

	private respond(res: http.ServerResponse, body: any, json: (v: unknown, status?: number) => void, sse: (e: Array<{ event?: string; data: unknown }>) => void): void {
		const mode = this.opts.responses ?? "stateful";
		let conv: Array<{ role: string; content: string }> = (body.input ?? []).map((m: any) => ({ role: m.role, content: m.content }));
		if (body.previous_response_id) {
			if (mode === "stateless") return json({ error: { message: "this server keeps no responses (stateless): send the whole conversation in input instead of previous_response_id", code: "unsupported_parameter" } }, 400);
			if (mode === "stateful") {
				const prev = this.stored.get(body.previous_response_id);
				if (!prev) return json({ error: { message: `previous_response_id ${body.previous_response_id} not found` } }, 404);
				conv = [...prev, ...conv];
			}
		}
		const reply = this.opts.responsesReply?.(conv, body) ?? "ok";
		const out = typeof reply === "string" ? { content: reply } : reply;
		const id = `resp_${++this.respN}`;
		this.stored.set(id, [...conv, { role: "assistant", content: out.content }]);
		const inputTokens = Math.ceil(conv.reduce((n, m) => n + m.content.length, 0) / 2);
		const base = { id, object: "response", status: "in_progress", output: [] };
		void res;
		sse([
			{ event: "response.created", data: { type: "response.created", response: base } },
			...(out.reasoning ? [{ event: "response.reasoning_text.delta", data: { type: "response.reasoning_text.delta", delta: out.reasoning } }] : []),
			...[...out.content].reduce<string[]>((acc, ch, i) => (i % 8 === 0 ? [...acc, ch] : [...acc.slice(0, -1), acc.at(-1)! + ch]), []).map((d) => ({ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: d } })),
			{ event: "response.completed", data: { type: "response.completed", response: { ...base, status: "completed", usage: { input_tokens: inputTokens, output_tokens: Math.ceil(out.content.length / 2), input_tokens_details: { cached_tokens: 0 } } } } },
		]);
	}
}
