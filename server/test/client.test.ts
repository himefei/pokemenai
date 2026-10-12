import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmulatorClient } from "../src/emulator/client.js";
import { readHeartbeat } from "../src/emulator/heartbeat.js";
import { SymbolTable } from "../src/gen3/symbols.js";
import { FakeBridge } from "./helpers/fake-bridge.js";

let bridge: FakeBridge;
let client: EmulatorClient;
const syms = SymbolTable.load();

beforeEach(async () => {
	bridge = new FakeBridge();
	const port = await bridge.start();
	client = new EmulatorClient({ port, autoReconnect: false, requestTimeoutMs: 2000 });
	await client.connect();
});

afterEach(async () => {
	client.close();
	await bridge.stop();
});

describe("EmulatorClient", () => {
	it("hello / read / write round trip", async () => {
		const h = await client.hello();
		expect(h.game_code).toBe("AGB-BPEE");
		expect(h.rom_crc32).toBe("1F1C08FB");

		await client.write(0x02000000, new Uint8Array([1, 2, 3, 4]));
		const [a, b] = await client.read([
			{ addr: 0x02000000, len: 4 },
			{ addr: 0x02000010, len: 2 },
		]);
		expect([...a!]).toEqual([1, 2, 3, 4]);
		expect([...b!]).toEqual([0, 0]);
	});

	it("matches concurrent responses by id", async () => {
		bridge.setBytes(0x100, new Uint8Array([0xaa]));
		bridge.setBytes(0x200, new Uint8Array([0xbb]));
		const [x, y] = await Promise.all([client.readOne(0x100, 1), client.readOne(0x200, 1)]);
		expect(x[0]).toBe(0xaa);
		expect(y[0]).toBe(0xbb);
	});

	it("rejects with the bridge error message when ok=false", async () => {
		await expect(client.request("screenshot" as never, { path: "x" } as never).then(() => client.request("nope" as never))).rejects.toThrow(/unknown cmd/);
	});

	it("long-running press resolves after the sequence", async () => {
		const t0 = Date.now();
		const r = await client.request("press", { seq: [{ keys: ["A"], hold: 6, wait: 6 }] }, 5000);
		expect(r.frames).toBe(12);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
	});

	it("fails pending requests when the connection drops", async () => {
		const p = client.request("wait", { frames: 600 }, 5000);
		await new Promise((r) => setTimeout(r, 20));
		await bridge.stop();
		await expect(p).rejects.toThrow(/closed|timed out/);
	});
});

describe("readHeartbeat", () => {
	it("resolves controller function pointers to names", async () => {
		bridge.setU32(syms.addr("gBattlerControllerFuncs"), syms.funcPtr("HandleInputChooseAction"));
		bridge.setU32(syms.addr("gMain", 4), syms.funcPtr("CB2_Overworld"));
		bridge.setBytes(syms.addr("gMain", 0x439), new Uint8Array([0x02]));
		bridge.setBytes(syms.addr("gActionSelectionCursor"), new Uint8Array([3, 0, 0, 0]));
		const hb = await readHeartbeat(client, syms);
		expect(hb.inBattle).toBe(true);
		expect(hb.callback2Name).toBe("CB2_Overworld");
		expect(hb.controllerFuncNames[0]).toBe("HandleInputChooseAction");
		expect(hb.actionCursor[0]).toBe(3);
	});
});
