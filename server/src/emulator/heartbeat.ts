import { MAIN, MAIN_IN_BATTLE_MASK, parseActiveTasks, parsePartyMenu } from "../gen3/structs.js";
import type { PartyMenuState } from "../gen3/structs.js";
import type { SymbolTable } from "../gen3/symbols.js";
import type { EmulatorLink } from "./rpc.js";
import { hexToBytes } from "./protocol.js";

/** 约 10Hz 批量读取的"心跳地址组"：阶段检测只依赖这些。 */
export interface Heartbeat {
	frame: number;
	callback1: number;
	callback2: number;
	callback2Name: string | undefined;
	inBattle: boolean;
	battleMainFunc: number;
	battleMainFuncName: string | undefined;
	/** gBattlerControllerFuncs[0..3] */
	controllerFuncs: number[];
	controllerFuncNames: Array<string | undefined>;
	battleTypeFlags: number;
	battleOutcome: number;
	battlersCount: number;
	execFlags: number;
	actionCursor: number[];
	moveCursor: number[];
	partyMenu: PartyMenuState;
	playerPartyCount: number;
	/** gBattleCommunication[0]：战斗脚本指令的内部状态（yesnobox：0=画框 1=等输入） */
	commState: number;
	/** gBattleCommunication[1]：光标位置（是/否框：0=是 1=否） */
	commCursor: number;
	/** 战斗脚本当前执行到的指令 opcode；只在脚本运行期间读取（否则为 null） */
	scriptOpcode: number | null;
}

const u32 = (b: Uint8Array, o = 0) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);

export async function readHeartbeat(client: EmulatorLink, syms: SymbolTable): Promise<Heartbeat> {
	const res = await client.request("read", {
		ranges: [
			{ addr: syms.addr("gMain"), len: 0x10 },
			{ addr: syms.addr("gMain", MAIN.flags), len: 1 },
			{ addr: syms.addr("gBattlerControllerFuncs"), len: 16 },
			{ addr: syms.addr("gBattleMainFunc"), len: 4 },
			{ addr: syms.addr("gBattleTypeFlags"), len: 4 },
			{ addr: syms.addr("gBattleOutcome"), len: 1 },
			{ addr: syms.addr("gBattlersCount"), len: 1 },
			{ addr: syms.addr("gBattleControllerExecFlags"), len: 4 },
			{ addr: syms.addr("gActionSelectionCursor"), len: 4 },
			{ addr: syms.addr("gMoveSelectionCursor"), len: 4 },
			{ addr: syms.addr("gPartyMenu"), len: syms.size("gPartyMenu") },
			{ addr: syms.addr("gPlayerPartyCount"), len: 1 },
			{ addr: syms.addr("gBattleCommunication"), len: 2 },
			{ addr: syms.addr("gBattlescriptCurrInstr"), len: 4 },
		],
	});
	const d = res.data.map(hexToBytes);
	const mainHead = d[0]!;
	const controllerFuncs = [0, 1, 2, 3].map((i) => u32(d[2]!, i * 4));
	const cb2 = u32(mainHead, MAIN.callback2);
	const bmf = u32(d[3]!);
	const bmfName = syms.funcNameAt(bmf);
	// 只有战斗脚本在跑的时候才有意义：再读一次 ROM 里的 opcode（多一次往返，所以按需读）
	let scriptOpcode: number | null = null;
	if (bmfName?.startsWith("RunBattleScriptCommands")) {
		const ptr = u32(d[13]!);
		if (ptr >= 0x08000000 && ptr < 0x0a000000) scriptOpcode = (await client.readOne(ptr, 1))[0]!;
	}
	return {
		frame: res.frame,
		callback1: u32(mainHead, MAIN.callback1),
		callback2: cb2,
		callback2Name: syms.funcNameAt(cb2),
		inBattle: (d[1]![0]! & MAIN_IN_BATTLE_MASK) !== 0,
		battleMainFunc: bmf,
		battleMainFuncName: bmfName,
		controllerFuncs,
		controllerFuncNames: controllerFuncs.map((p) => syms.funcNameAt(p)),
		battleTypeFlags: u32(d[4]!),
		battleOutcome: d[5]![0]!,
		battlersCount: d[6]![0]!,
		execFlags: u32(d[7]!),
		actionCursor: [...d[8]!],
		moveCursor: [...d[9]!],
		partyMenu: parsePartyMenu(d[10]!),
		playerPartyCount: d[11]![0]!,
		commState: d[12]![0]!,
		commCursor: d[12]![1]!,
		scriptOpcode,
	};
}

/** 读取当前活跃的 Task 函数名（用来判断队伍菜单里是否弹出了子菜单等）。 */
export async function readActiveTaskNames(client: EmulatorLink, syms: SymbolTable): Promise<string[]> {
	const [raw] = await client.read([{ addr: syms.addr("gTasks"), len: syms.size("gTasks") }]);
	return parseActiveTasks(raw!).map((t) => syms.funcNameAt(t.func) ?? `0x${t.func.toString(16)}`);
}
