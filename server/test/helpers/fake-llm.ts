// 假的 LLM HTTP 服务：OpenAI 兼容（SSE）、Anthropic（SSE）、LM Studio / Ollama 的发现接口。
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeLlmOptions {
	/** OpenAI 流式的 delta 序列（每项一个 chunk 的 delta） */
	openaiDeltas?: Array<Record<string, unknown>>;
	openaiStatus?: number;
	/** Anthropic 事件序列 */
	anthropicEvents?: Array<Record<string, unknown>>;
	/** 响应前人为延迟（测超时） */
	delayMs?: number;
	models?: string[];
}

export class FakeLlm {
	readonly requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
	private server: http.Server;
	baseUrl = "";

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

		if (req.url === "/v1/chat/completions") {
			if (this.opts.openaiStatus && this.opts.openaiStatus !== 200) return json({ error: { message: "nope" } }, this.opts.openaiStatus);
			const deltas = this.opts.openaiDeltas ?? [{ content: "ok" }];
			return sse([
				...deltas.map((d) => ({ data: { choices: [{ delta: d }] } })),
				{ data: { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } } },
				{ data: "[DONE]" },
			]);
		}
		if (req.url === "/v1/messages") {
			return sse((this.opts.anthropicEvents ?? []).map((e) => ({ event: String(e.type), data: e })));
		}
		if (req.url === "/v1/models") {
			if (req.headers["x-api-key"] !== undefined) return json({ data: (this.opts.models ?? ["claude-x"]).map((id) => ({ id })) });
			return json({ data: (this.opts.models ?? ["m1", "m2"]).map((id) => ({ id })) });
		}
		if (req.url === "/api/v0/models") return json({ data: [{ id: "m1", type: "llm", state: "loaded", loaded_context_length: 8192 }, { id: "m2", type: "vlm", state: "not-loaded" }] });
		if (req.url === "/api/tags") return json({ models: [{ name: "llama3:8b" }] });
		if (req.url === "/api/show") return json({ capabilities: ["completion", "vision", "thinking"] });
		void body;
		json({ error: "not found" }, 404);
	}
}
