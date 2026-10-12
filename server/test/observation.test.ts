import { describe, expect, it } from "vitest";
import { BattleTracker } from "../src/agent/tracker.js";
import { buildObservation } from "../src/agent/observation.js";
import { legalActions } from "../src/gen3/battle-state.js";
import type { BattleSnapshot } from "../src/gen3/battle-state.js";
import { decodeGen3Text } from "../src/gen3/charmap.js";
import { TextLog } from "../src/gen3/battle-text.js";
import { Gen3Data } from "../src/gen3/data.js";
import { battleMonBytes, snapshot } from "./helpers/synthetic.js";
import { parseBattleMon } from "../src/gen3/structs.js";

const data = Gen3Data.load();

const obs = (s: BattleSnapshot, tracker: BattleTracker, messages: string[] = []) =>
	buildObservation({ snapshot: s, tracker, data, legal: legalActions(s), turn: 3, messages });

describe("observation: own side is fully known", () => {
	it("gives the active mon's stats, ability, moves with type/power/PP", () => {
		const o = obs(snapshot(), new BattleTracker(data));
		const me = o.you.active;
		expect(me.species).toBe("雷伊布");
		expect(me.stats).toEqual({ atk: 90, def: 80, spe: 140, spa: 120, spd: 150 });
		expect(me.ability).toBe("Volt Absorb");
		expect(me.moves.map((m) => m.name)).toEqual(["十万伏特", "二连踢", "替身", "电磁波"]);
		expect(me.moves[0]).toMatchObject({ id: "move:0", type: "电", power: 95, accuracy: 100, pp: 15, max_pp: 15 });
		expect(o.you.party).toHaveLength(4);
		expect(o.you.party[1]!.moves.length).toBe(4); // 替补的招式也看得到
	});

	it("legal actions: 0-PP moves and the active mon are excluded", () => {
		const o = obs(snapshot(), new BattleTracker(data));
		expect(o.legal_actions.map((a) => a.id)).toEqual(["move:0", "move:1", "move:2", "switch:1", "switch:2", "switch:3"]);
		expect(o.legal_actions[0]!.label).toBe("十万伏特");
	});
});

describe("observation: the opponent is perception-only", () => {
	it("shows species/level/types/HP% but no stats and no moves before any are used", () => {
		const o = obs(snapshot(), new BattleTracker(data));
		const e = o.opponent;
		expect(e).toMatchObject({ species: "大狼犬", level: 46, types: ["恶"], hp_percent: 75, known_moves: [], unknown_move_slots: 4, ability: null, item: null });
		const json = JSON.stringify(o.opponent);
		expect(json).not.toContain("999"); // 对手数值
		expect(json).not.toMatch(/咬碎|Crunch|吼叫|泼沙|舍身/); // 对手招式
		expect(Object.keys(e)).not.toContain("stats");
	});

	it("reveals only the moves it has used (via gLastMoves), the rest stay unknown", () => {
		const t = new BattleTracker(data);
		const s = snapshot({ lastMoves: [0, 242, 0, 0] });
		t.update(s, []);
		const o = obs(s, t);
		expect(o.opponent.known_moves).toEqual([{ name: "咬碎", name_en: "Crunch" }]);
		expect(o.opponent.unknown_move_slots).toBe(3);
		expect(JSON.stringify(o.opponent)).not.toMatch(/吼叫|泼沙|舍身/);
	});

	it("remembers revealed moves per opponent across switches", () => {
		const t = new BattleTracker(data);
		t.update(snapshot({ lastMoves: [0, 242, 0, 0] }), []);
		t.update(snapshot({ opponentPartyIndex: 1, lastMoves: [0, 0, 0, 0] }), []); // 换成第二只
		t.update(snapshot({ opponentPartyIndex: 1, lastMoves: [0, 28, 0, 0] }), []);
		const back = snapshot({ opponentPartyIndex: 0, lastMoves: [0, 0, 0, 0] });
		t.update(back, []);
		expect(obs(back, t).opponent.known_moves.map((m) => m.name_en)).toEqual(["Crunch"]);
		expect(t.seenCount()).toBe(2);
	});

	it("reveals ability and held item only through 'Foe …' battle text", () => {
		const t = new BattleTracker(data);
		const s = snapshot();
		t.update(s, ["JOLTEON's Intimidate cuts something"]); // 我方消息：不算
		expect(obs(s, t).opponent.ability).toBeNull();
		t.update(s, ["Foe MIGHTYENA's Intimidate cuts JOLTEON's Attack!"]);
		expect(obs(s, t).opponent.ability).toBe("Intimidate");
		t.update(s, ["Foe MIGHTYENA used Thunder Wave!"]); // 招式行不会被当作道具
		expect(obs(s, t).opponent.item).toBeNull();
		t.update(s, ["ELITE FOUR SIDNEY used FULL RESTORE!", "Foe MIGHTYENA's FULL RESTORE restored health!"]); // 训练家道具 ≠ 持有物
		expect(obs(s, t).opponent.item).toBeNull();
		t.update(s, ["Foe MIGHTYENA restored a little HP using its Leftovers!"]);
		expect(obs(s, t).opponent.item).toBe("Leftovers");
	});

	it("rounds HP% but never shows 0% for a live mon", () => {
		const s = snapshot({ opponent: parseBattleMon(battleMonBytes({ species: 287, level: 46, hp: 1, maxHp: 400, moves: [0, 0, 0, 0], pp: [0, 0, 0, 0], types: [17, 17] })) });
		expect(obs(s, new BattleTracker(data)).opponent.hp_percent).toBe(1);
	});

	it("reports remaining opponent mons like the ball indicators", () => {
		const s = snapshot();
		s.enemyParty[1] = { ...s.enemyParty[1]!, hp: 0 };
		const o = obs(s, new BattleTracker(data));
		expect(o.opponent_remaining).toBe(1);
		expect(o.opponent_party_size).toBe(2);
	});
});

describe("battle text", () => {
	const enc = (s: string): Uint8Array => {
		const out: number[] = [];
		for (const ch of s) {
			if (ch === "\n") out.push(0xfe);
			else if (ch === " ") out.push(0x00);
			else if (/[0-9]/.test(ch)) out.push(0xa1 + Number(ch));
			else if (/[A-Z]/.test(ch)) out.push(0xbb + ch.charCodeAt(0) - 65);
			else if (/[a-z]/.test(ch)) out.push(0xd5 + ch.charCodeAt(0) - 97);
			else out.push({ "!": 0xab, "?": 0xac, ".": 0xad, "-": 0xae, ",": 0xb8, "'": 0xb4 }[ch]!);
		}
		out.push(0xff, 0xaa, 0xaa); // 终止符后的垃圾必须被忽略
		return Uint8Array.from(out);
	};

	it("decodes Gen 3 text with line breaks and ignores bytes after the terminator", () => {
		expect(decodeGen3Text(enc("Foe MIGHTYENA used\nCRUNCH!"))).toBe("Foe MIGHTYENA used\nCRUNCH!");
	});

	it("skips extended control codes with their arguments", () => {
		expect(decodeGen3Text(Uint8Array.from([0xbb, 0xfc, 0x01, 0x05, 0xbc, 0xff]))).toBe("AB");
	});

	it("drain() drops UI prompts like 'What will X do?' and name plates", () => {
		const log = new TextLog();
		log.push(1, enc("Foe X used Tackle!"));
		log.push(2, enc("What will JOLTEON do?"));
		log.push(3, Uint8Array.from([...enc("JOLTEON").slice(0, -3), 0xb6, 0xff])); // "JOLTEON♀"
		expect(log.drain()).toEqual(["Foe X used Tackle!"]);
	});

	it("decodes the é in POKéMON", () => {
		// P=0xCA O=0xC9 K=0xC5 é=0x1B M=0xC7 O=0xC9 N=0xC8
		expect(decodeGen3Text(Uint8Array.from([0xca, 0xc9, 0xc5, 0x1b, 0xc7, 0xc9, 0xc8, 0xff]))).toBe("POKéMON");
	});

	it("TextLog dedupes consecutive samples and drops empty strings", () => {
		const log = new TextLog();
		expect(log.push(1, enc("Foe X used Double Team!"))).toBe("Foe X used Double Team!");
		expect(log.push(2, enc("Foe X used Double Team!"))).toBeNull();
		expect(log.push(3, Uint8Array.from([0xff]))).toBeNull();
		expect(log.push(4, enc("Foe X's evasiveness rose!"))).toBe("Foe X's evasiveness rose!");
		expect(log.drain()).toEqual(["Foe X used Double Team!", "Foe X's evasiveness rose!"]);
		expect(log.drain()).toEqual([]);
	});
});
