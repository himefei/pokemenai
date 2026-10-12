// Lua 桥 <-> 桥接服务 的 NDJSON 协议。每行一个 JSON；响应用同一个 id 对应请求。

export type GbaKey = "A" | "B" | "SELECT" | "START" | "RIGHT" | "LEFT" | "UP" | "DOWN" | "R" | "L";

export interface PressStep {
	keys: GbaKey[];
	/** 按住帧数（>=1） */
	hold?: number;
	/** 释放后等待帧数 */
	wait?: number;
}

export interface ReadRange {
	addr: number;
	len: number;
}

export interface HelloResult {
	protocol: number;
	game_code: string;
	game_title?: string;
	rom_crc32: string | null;
	rom_crc32_raw_hex: string | null;
	frame: number;
}

export interface RequestMap {
	hello: { params: Record<string, never>; result: HelloResult };
	ping: { params: Record<string, never>; result: { frame: number } };
	read: { params: { ranges: ReadRange[] }; result: { data: string[]; frame: number } };
	write: { params: { addr: number; hex: string }; result: { written: number } };
	press: { params: { seq: PressStep[] }; result: { frames: number; frame: number } };
	wait: { params: { frames: number }; result: { frames: number; frame: number } };
	save_state: { params: { slot?: number; path?: string }; result: Record<string, never> };
	load_state: { params: { slot?: number; path?: string }; result: { frame: number } };
	screenshot: { params: { path: string }; result: Record<string, never> };
	reset_keys: { params: Record<string, never>; result: Record<string, never> };
	/** 仅网页模拟器支持：暂停/继续模拟（模型思考期间暂停，让随机数只取决于游戏帧数） */
	pause: { params: Record<string, never>; result: Record<string, never> };
	resume: { params: Record<string, never>; result: Record<string, never> };
}

export type Cmd = keyof RequestMap;

export interface WireRequest {
	id: number;
	cmd: Cmd;
	[param: string]: unknown;
}

export interface WireResponse {
	id: number | null;
	ok: boolean;
	error?: string;
	[field: string]: unknown;
}

export function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("odd-length hex");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}
