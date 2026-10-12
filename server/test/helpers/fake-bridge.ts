// 在 Node 里模拟 lua/bridge.lua 的协议行为，用来离线测试 EmulatorClient 和 Phase 0 CLI。
import net from "node:net";
import type { AddressInfo } from "node:net";
import { bytesToHex, hexToBytes } from "../../src/emulator/protocol.js";

export class FakeBridge {
	readonly mem = new Map<number, number>();
	frame = 0;
	readonly log: Array<Record<string, unknown>> = [];
	/** press 之后按序列改变的回调；测试里用来模拟光标移动 */
	onPress: ((keys: string[]) => void) | null = null;
	crcHex = "1F1C08FB";
	paused = false;
	private server: net.Server;
	private sockets = new Set<net.Socket>();
	private timer: NodeJS.Timeout;
	port = 0;

	constructor() {
		this.timer = setInterval(() => this.frame++, 1000 / 60);
		this.server = net.createServer((sock) => {
			this.sockets.add(sock);
			sock.on("close", () => this.sockets.delete(sock));
			sock.setEncoding("utf8");
			let buf = "";
			sock.on("data", (chunk: string) => {
				buf += chunk;
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					this.handle(sock, line);
				}
			});
			sock.on("error", () => {});
		});
	}

	async start(port = 0): Promise<number> {
		await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
		this.port = (this.server.address() as AddressInfo).port;
		return this.port;
	}

	async stop(): Promise<void> {
		clearInterval(this.timer);
		for (const s of this.sockets) s.destroy();
		await new Promise<void>((r) => this.server.close(() => r()));
	}

	setBytes(addr: number, bytes: Uint8Array): void {
		bytes.forEach((b, i) => this.mem.set(addr + i, b));
	}

	getBytes(addr: number, len: number): Uint8Array {
		const out = new Uint8Array(len);
		for (let i = 0; i < len; i++) out[i] = this.mem.get(addr + i) ?? 0;
		return out;
	}

	setU32(addr: number, v: number): void {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setUint32(0, v >>> 0, true);
		this.setBytes(addr, b);
	}

	private handle(sock: net.Socket, line: string): void {
		const req = JSON.parse(line) as { id: number; cmd: string; [k: string]: unknown };
		this.log.push(req);
		const ok = (extra: Record<string, unknown> = {}): void => {
			sock.write(JSON.stringify({ id: req.id, ok: true, ...extra }) + "\n");
		};
		switch (req.cmd) {
			case "hello":
				return ok({ protocol: 1, game_code: "AGB-BPEE", game_title: "POKEMON EMER", rom_crc32: this.crcHex, rom_crc32_raw_hex: "1f1c08fb", frame: this.frame });
			case "ping":
				return ok({ frame: this.frame });
			case "read": {
				const ranges = req.ranges as Array<{ addr: number; len: number }>;
				return ok({ data: ranges.map((r) => bytesToHex(this.getBytes(r.addr, r.len))), frame: this.frame });
			}
			case "write":
				this.setBytes(req.addr as number, hexToBytes(req.hex as string));
				return ok({ written: (req.hex as string).length / 2 });
			case "press": {
				const seq = req.seq as Array<{ keys: string[]; hold?: number; wait?: number }>;
				let frames = 0;
				for (const s of seq) {
					frames += (s.hold ?? 4) + (s.wait ?? 6);
					this.onPress?.(s.keys);
				}
				const start = this.frame;
				return void setTimeout(() => ok({ frames, frame: start + frames }), (frames * 1000) / 60);
			}
			case "wait": {
				const frames = req.frames as number;
				return void setTimeout(() => ok({ frames, frame: this.frame }), (frames * 1000) / 60);
			}
			case "save_state":
			case "load_state":
			case "screenshot":
			case "reset_keys":
				return ok({ frame: this.frame });
			case "pause":
				this.paused = true;
				return ok({});
			case "resume":
				this.paused = false;
				return ok({});
			default:
				sock.write(JSON.stringify({ id: req.id, ok: false, error: `unknown cmd: ${req.cmd}` }) + "\n");
				return;
		}
	}
}
