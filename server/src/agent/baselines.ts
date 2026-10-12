import type { Decision, DecisionContext, Policy } from "./policy.js";

/** 可复现的小型 PRNG（mulberry32）。 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** random 基线：在合法动作里均匀随机。 */
export class RandomPolicy implements Policy {
	readonly name = "random";
	private readonly rand: () => number;

	constructor(seed: number) {
		this.rand = mulberry32(seed);
	}

	async decide(ctx: DecisionContext): Promise<Decision> {
		if (ctx.legal.length === 0) throw new Error("no legal actions");
		const choice = ctx.legal[Math.floor(this.rand() * ctx.legal.length)]!;
		return { choice, reason: "random" };
	}
}
