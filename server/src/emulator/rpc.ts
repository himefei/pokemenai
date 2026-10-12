// 模拟器连接的抽象。服务端的其余部分（执行器、心跳、控制器……）只依赖 EmulatorLink，
// 不关心对面是 mGBA 的 Lua 桥（TCP）还是网页里的 WebAssembly 模拟器（WebSocket）——它们说同一套 NDJSON 协议。

import { EventEmitter } from "node:events";
import { bytesToHex, hexToBytes } from "./protocol.js";
import type { Cmd, HelloResult, ReadRange, RequestMap, WireRequest, WireResponse } from "./protocol.js";

export class EmulatorError extends Error {}

export interface EmulatorLink extends EventEmitter {
	readonly connected: boolean;
	connect(): Promise<void>;
	close(): void;
	request<C extends Cmd>(cmd: C, params?: RequestMap[C]["params"], timeoutMs?: number): Promise<RequestMap[C]["result"]>;
	hello(): Promise<HelloResult>;
	read(ranges: ReadRange[]): Promise<Uint8Array[]>;
	readOne(addr: number, len: number): Promise<Uint8Array>;
	write(addr: number, bytes: Uint8Array): Promise<RequestMap["write"]["result"]>;
}

interface Pending {
	resolve: (r: WireResponse) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
	cmd: Cmd;
}

/** 请求/响应按 id 配对、超时、便捷封装；传输由子类提供。 */
export abstract class RpcLink extends EventEmitter implements EmulatorLink {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();

	protected constructor(protected readonly requestTimeoutMs: number) {
		super();
	}

	abstract get connected(): boolean;
	abstract connect(): Promise<void>;
	abstract close(): void;
	/** 发送一行（不含换行符）；没连上返回 false */
	protected abstract sendLine(line: string): boolean;

	/** 子类把收到的每一行交给这里 */
	protected handleLine(raw: string): void {
		const line = raw.trim();
		if (!line) return;
		let msg: WireResponse;
		try {
			msg = JSON.parse(line) as WireResponse;
		} catch {
			this.emit("error", new EmulatorError(`bad json from emulator: ${line.slice(0, 200)}`));
			return;
		}
		if (msg.id == null) {
			this.emit("error", new EmulatorError(msg.error ?? "emulator error without id"));
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		p.resolve(msg);
	}

	protected failAllPending(err: Error): void {
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
			this.pending.delete(id);
		}
	}

	/** 发送一个命令并等待响应；ok=false 抛 EmulatorError。 */
	request<C extends Cmd>(cmd: C, params: RequestMap[C]["params"] = {} as RequestMap[C]["params"], timeoutMs?: number): Promise<RequestMap[C]["result"]> {
		if (!this.connected) return Promise.reject(new EmulatorError("not connected"));
		const id = this.nextId++;
		const req: WireRequest = { id, cmd, ...params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new EmulatorError(`request '${cmd}' timed out after ${timeoutMs ?? this.requestTimeoutMs}ms`));
			}, timeoutMs ?? this.requestTimeoutMs);
			this.pending.set(id, {
				cmd,
				timer,
				reject,
				resolve: (r) => (r.ok ? resolve(r as unknown as RequestMap[C]["result"]) : reject(new EmulatorError(`${cmd}: ${r.error ?? "failed"}`))),
			});
			if (!this.sendLine(JSON.stringify(req))) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new EmulatorError("not connected"));
			}
		});
	}

	hello() {
		return this.request("hello");
	}

	/** 批量读取，返回与 ranges 同序的字节数组。 */
	async read(ranges: ReadRange[]): Promise<Uint8Array[]> {
		const r = await this.request("read", { ranges });
		return r.data.map(hexToBytes);
	}

	async readOne(addr: number, len: number): Promise<Uint8Array> {
		return (await this.read([{ addr, len }]))[0]!;
	}

	write(addr: number, bytes: Uint8Array) {
		return this.request("write", { addr, hex: bytesToHex(bytes) });
	}
}
