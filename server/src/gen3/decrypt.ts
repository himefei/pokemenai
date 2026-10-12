// 宝可梦 100 字节结构的子结构解密（Gen 3）。纯函数，可用 fixtures 离线测试。

/** G=成长 A=技能 E=努力值/状态 M=杂项；顺序由 personality % 24 决定。 */
export const SUBSTRUCT_ORDERS: readonly string[] = [
	"GAEM", "GAME", "GEAM", "GEMA", "GMAE", "GMEA",
	"AGEM", "AGME", "AEGM", "AEMG", "AMGE", "AMEG",
	"EGAM", "EGMA", "EAGM", "EAMG", "EMGA", "EMAG",
	"MGAE", "MGEA", "MAGE", "MAEG", "MEGA", "MEAG",
];

export const ENCRYPTED_OFFSET = 0x20;
export const ENCRYPTED_SIZE = 48;
export const SUBSTRUCT_SIZE = 12;

export type SubstructKey = "G" | "A" | "E" | "M";

export interface DecryptedSubstructs {
	G: Uint8Array;
	A: Uint8Array;
	E: Uint8Array;
	M: Uint8Array;
	/** 解密后 24 个 u16 之和（mod 0x10000），应与盒子结构里的 checksum 字段相等 */
	checksum: number;
}

export function decryptSubstructs(mon: Uint8Array): DecryptedSubstructs {
	if (mon.length < ENCRYPTED_OFFSET + ENCRYPTED_SIZE) throw new Error(`pokemon data too short: ${mon.length}`);
	const view = new DataView(mon.buffer, mon.byteOffset, mon.byteLength);
	const personality = view.getUint32(0x00, true);
	const otId = view.getUint32(0x04, true);
	const key = (personality ^ otId) >>> 0;

	const plain = new Uint8Array(ENCRYPTED_SIZE);
	const pv = new DataView(plain.buffer);
	let sum = 0;
	for (let i = 0; i < ENCRYPTED_SIZE; i += 4) {
		const w = (view.getUint32(ENCRYPTED_OFFSET + i, true) ^ key) >>> 0;
		pv.setUint32(i, w, true);
		sum += (w & 0xffff) + (w >>> 16);
	}

	const order = SUBSTRUCT_ORDERS[personality % 24]!;
	const out = { checksum: sum & 0xffff } as DecryptedSubstructs;
	for (let slot = 0; slot < 4; slot++) {
		const key2 = order[slot] as SubstructKey;
		out[key2] = plain.slice(slot * SUBSTRUCT_SIZE, (slot + 1) * SUBSTRUCT_SIZE);
	}
	return out;
}
