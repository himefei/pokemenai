// 开发用：起一个假桥（端口 8765），填入存档里的队伍，用来离线试跑 `npm run phase0`。
//   npx tsx test/helpers/run-fake.ts
import { readFileSync } from "node:fs";
import { hexToBytes } from "../../src/emulator/protocol.js";
import { SymbolTable } from "../../src/gen3/symbols.js";
import { FakeBridge } from "./fake-bridge.js";

const syms = SymbolTable.load();
const fixture = JSON.parse(readFileSync(new URL("../fixtures/save_party.json", import.meta.url), "utf8")) as { mons: string[] };
const bridge = new FakeBridge();
const port = await bridge.start(Number(process.env.PORT ?? 8765));

fixture.mons.forEach((h, i) => bridge.setBytes(syms.addr("gPlayerParty", i * 100), hexToBytes(h)));
bridge.setBytes(syms.addr("gPlayerPartyCount"), new Uint8Array([4]));
bridge.setU32(syms.addr("gMain", 4), syms.funcPtr("CB2_Overworld"));

if (process.env.BATTLE) {
	bridge.setBytes(syms.addr("gMain", 0x439), new Uint8Array([0x02]));
	bridge.setU32(syms.addr("gBattlerControllerFuncs"), syms.funcPtr("HandleInputChooseAction"));
	const mon = new Uint8Array(0x58);
	const v = new DataView(mon.buffer);
	v.setUint16(0, 135, true);
	[85, 24, 164, 86].forEach((m, i) => v.setUint16(0x0c + i * 2, m, true));
	mon.set([15, 30, 10, 20], 0x24);
	v.setUint16(0x28, 100, true);
	mon[0x2a] = 44;
	v.setUint16(0x2c, 120, true);
	bridge.setBytes(syms.addr("gBattleMons"), mon);
	bridge.setBytes(syms.addr("gBattleMons", 0x58), mon);
	let cursor = 0;
	bridge.onPress = (keys) => {
		if (keys.includes("RIGHT")) cursor |= 1;
		if (keys.includes("LEFT")) cursor &= ~1;
		if (keys.includes("DOWN")) cursor |= 2;
		if (keys.includes("UP")) cursor &= ~2;
		bridge.setBytes(syms.addr("gActionSelectionCursor"), new Uint8Array([cursor, 0, 0, 0]));
	};
}
console.log(`fake bridge listening on ${port}${process.env.BATTLE ? " (in battle, action menu)" : ""}`);
