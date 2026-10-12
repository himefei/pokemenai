// 网页里的 WebAssembly 模拟器通过 WebSocket 连进来，说和 Lua 桥相同的 NDJSON 协议。
// Hub 对外是一个稳定的 EmulatorLink：浏览器刷新、断开、重新连上，Session / 控制器都不用重建。
//
// 所有权：一个槽位同一时刻只有一个页面是"宿主"（真正跑模拟器的那个）。
//   - 已有宿主在线时，新连进来的页面默认被拒绝（关闭码 4409），它只能当观众——不会再出现两个页面互相顶来顶去；
//   - 明确要求接管（force）时才会顶掉旧宿主，旧宿主收到 {"type":"replaced"} 并以 4001 关闭，页面据此不再自动重连；
//   - 宿主页面被冻结 / 网络断了但 TCP 还挂着时，靠 ping/pong 心跳在十几秒内判定它已经死了，放行新的页面。

import type { WebSocket } from "ws";
import { EmulatorError, RpcLink } from "./rpc.js";

/** 另一个页面已经是宿主；这个连接被拒绝 */
export const CLOSE_BUSY = 4409;
/** 被另一个页面接管了；不要自动重连 */
export const CLOSE_REPLACED = 4001;

export type AttachResult = "attached" | "busy";

export class WsEmulatorHub extends RpcLink {
	private ws: WebSocket | null = null;
	private alive = true;
	private heartbeat: NodeJS.Timeout | null = null;

	constructor(
		requestTimeoutMs = 15000,
		private readonly heartbeatMs = 5000,
	) {
		super(requestTimeoutMs);
	}

	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === this.ws.OPEN;
	}

	/** 有页面正在做这个槽位的模拟器 */
	get hosted(): boolean {
		return this.connected;
	}

	attach(ws: WebSocket, opts: { force?: boolean } = {}): AttachResult {
		if (this.connected && !opts.force) {
			ws.send(JSON.stringify({ type: "busy" }));
			ws.close(CLOSE_BUSY, "slot already hosted by another page");
			return "busy";
		}
		const old = this.ws;
		this.ws = ws;
		this.alive = true;
		if (old && old !== ws) {
			this.failAllPending(new EmulatorError("replaced by a new emulator host"));
			try {
				old.send(JSON.stringify({ type: "replaced" }));
			} catch {
				/* 旧页面可能已经死了 */
			}
			old.close(CLOSE_REPLACED, "taken over by another page");
		}
		ws.on("message", (data) => {
			if (this.ws !== ws) return;
			this.alive = true;
			for (const line of String(data).split("\n")) this.handleLine(line);
		});
		ws.on("pong", () => {
			if (this.ws === ws) this.alive = true;
		});
		const gone = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.stopHeartbeat();
			this.failAllPending(new EmulatorError("emulator host disconnected"));
			this.emit("disconnected", "closed");
		};
		ws.on("close", gone);
		ws.on("error", gone);
		this.startHeartbeat();
		this.emit("connected");
		return "attached";
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		if (this.heartbeatMs <= 0) return;
		this.heartbeat = setInterval(() => {
			const ws = this.ws;
			if (!ws) return;
			if (!this.alive) {
				ws.terminate(); // 触发 close -> gone
				return;
			}
			this.alive = false;
			try {
				ws.ping();
			} catch {
				ws.terminate();
			}
		}, this.heartbeatMs);
		this.heartbeat.unref();
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
	}

	/** Hub 是被动的：等浏览器连上来。 */
	connect(): Promise<void> {
		return this.connected ? Promise.resolve() : Promise.reject(new EmulatorError("emulator host not attached"));
	}

	close(): void {
		this.stopHeartbeat();
		this.ws?.close();
		this.ws = null;
	}

	protected sendLine(line: string): boolean {
		if (!this.connected) return false;
		this.ws!.send(line);
		return true;
	}
}
