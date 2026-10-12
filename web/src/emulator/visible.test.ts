import { afterEach, describe, expect, it } from "vitest";
import { whenVisible } from "./host";

// 没有 DOM 环境：用一个最小的假 document 验证“后台页面等到回前台再继续”
function fakeDocument(initial: "visible" | "hidden") {
	const handlers = new Set<() => void>();
	const doc = {
		visibilityState: initial,
		addEventListener: (_: string, fn: () => void) => handlers.add(fn),
		removeEventListener: (_: string, fn: () => void) => handlers.delete(fn),
		show() {
			doc.visibilityState = "visible";
			for (const h of [...handlers]) h();
		},
		listeners: () => handlers.size,
	};
	(globalThis as { document?: unknown }).document = doc;
	return doc;
}

afterEach(() => {
	delete (globalThis as { document?: unknown }).document;
});

describe("whenVisible", () => {
	it("resolves immediately when the page is already in the foreground", async () => {
		fakeDocument("visible");
		await expect(whenVisible()).resolves.toBeUndefined();
	});

	it("waits while hidden and resolves (and unsubscribes) once visible", async () => {
		const doc = fakeDocument("hidden");
		let done = false;
		const p = whenVisible().then(() => (done = true));
		await Promise.resolve();
		expect(done).toBe(false);
		expect(doc.listeners()).toBe(1);
		doc.show();
		await p;
		expect(done).toBe(true);
		expect(doc.listeners()).toBe(0);
	});
});
