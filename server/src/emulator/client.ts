import net from "node:net";
import { EmulatorError, RpcLink } from "./rpc.js";

export { EmulatorError };

export interface EmulatorClientOptions {
	host?: string;
	port?: number;
	/** 单个请求的默认超时（press 之类耗时命令用 per-call 覆盖） */
	requestTimeoutMs?: number;
	/** 断线后自动重连；false 时只连一次 */
	autoReconnect?: boolean;
	reconnectDelayMs?: number;
}

/**
 * mGBA Lua 桥的 TCP 客户端（桥接服务是 client，Lua 是 server）。
 * 事件：'connected' | 'disconnected'(reason) | 'error'(err)
 */
export class EmulatorClient extends RpcLink {
	private readonly host: string;
	private readonly port: number;
	private readonly autoReconnect: boolean;
	private readonly reconnectDelayMs: number;

	private socket: net.Socket | null = null;
	private buf = "";
	private connectWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
	private closed = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private _connected = false;

	constructor(opts: EmulatorClientOptions = {}) {
		super(opts.requestTimeoutMs ?? 5000);
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? 8765;
		this.autoReconnect = opts.autoReconnect ?? true;
		this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
	}

	get connected(): boolean {
		return this._connected;
	}

	/** 开始连接；resolve 于首次连上，若 autoReconnect=false 且失败则 reject。 */
	connect(): Promise<void> {
		this.closed = false;
		if (this._connected) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.connectWaiters.push({ resolve, reject });
			if (!this.socket) this.open();
		});
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.socket?.destroy();
		this.socket = null;
	}

	protected sendLine(line: string): boolean {
		if (!this.socket || !this._connected) return false;
		this.socket.write(line + "\n");
		return true;
	}

	private open(): void {
		const sock = net.createConnection({ host: this.host, port: this.port });
		this.socket = sock;
		sock.setNoDelay(true);
		sock.setEncoding("utf8");

		sock.on("connect", () => {
			this._connected = true;
			this.buf = "";
			for (const w of this.connectWaiters.splice(0)) w.resolve();
			this.emit("connected");
		});
		sock.on("data", (chunk: string) => {
			this.buf += chunk;
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				this.handleLine(line);
			}
		});
		sock.on("error", (err) => {
			// 'close' 会随后触发，统一在那里处理
			if (!this.autoReconnect && !this._connected) {
				for (const w of this.connectWaiters.splice(0)) w.reject(new EmulatorError(`cannot connect to ${this.host}:${this.port}: ${err.message}`));
			}
			this.emit("error", err);
		});
		sock.on("close", () => {
			const wasConnected = this._connected;
			this._connected = false;
			this.socket = null;
			this.failAllPending(new EmulatorError("connection closed"));
			if (wasConnected) this.emit("disconnected", "closed");
			if (!this.closed && this.autoReconnect) {
				this.reconnectTimer = setTimeout(() => {
					this.reconnectTimer = null;
					if (!this.closed && !this.socket) this.open();
				}, this.reconnectDelayMs);
			}
		});
	}
}
