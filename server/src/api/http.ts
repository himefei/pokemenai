// HTTP + WebSocket。只绑 127.0.0.1。
//   REST：状态 / 设置 / 模型发现 / 提示词预设 / 控制 / 历史 / 资源（ROM、存档、存档点）
//     所有"单个游戏"的接口都按槽位提供：/api/s/a/...、/api/s/b/...；/api/... 是槽位 A 的别名（兼容旧用法）
//   WS /ws?slot=a|b       ：前端订阅该槽位的 AgentEvent（连上先发 hello：状态 + 现场回放）
//   WS /emu-link?slot=a|b ：网页里的 WebAssembly 模拟器宿主接入，说和 Lua 桥相同的协议
// WebAssembly 模拟器用多线程（SharedArrayBuffer），页面必须"跨源隔离"，所以所有响应都带 COOP/COEP 头。

import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import { SLOT_IDS, WEB_DIST, redact } from "../config.js";
import { buildRunReport, exportFileName } from "../eval/report.js";
import { Assets, symbolsForHost } from "./assets.js";
import { SessionManager } from "./manager.js";
import { Session } from "./session.js";

type Handler = (req: FastifyRequest, reply: FastifyReply, s: Session) => unknown | Promise<unknown>;

export async function buildServer(target: SessionManager | Session, assets = new Assets()): Promise<FastifyInstance> {
	const manager = target instanceof SessionManager ? target : SessionManager.single(target);
	const app = Fastify({ logger: false });

	// 跨源隔离：WebAssembly 多线程（SharedArrayBuffer）必需
	app.addHook("onRequest", async (_req, reply) => {
		reply.header("cross-origin-opener-policy", "same-origin");
		reply.header("cross-origin-embedder-policy", "require-corp");
		reply.header("cross-origin-resource-policy", "same-origin");
	});

	/** 同时注册 /api/<path>（槽位 A）和 /api/s/:slot/<path> */
	const slotRoute = (method: "get" | "post" | "put", path: string, handler: Handler) => {
		const wrap = (fixedSlot?: string) => async (req: FastifyRequest, reply: FastifyReply) => {
			const slot = fixedSlot ?? (req.params as { slot?: string }).slot;
			const s = manager.get(slot);
			if (!s) return reply.code(404).send({ error: `没有槽位 ${slot}` });
			return handler(req, reply, s);
		};
		app[method](`/api${path}`, wrap("a"));
		app[method](`/api/s/:slot${path}`, wrap());
	};

	const needEmu = (reply: FastifyReply, s: Session) => {
		const emu = s.status().emu;
		if (!emu.connected || !emu.romOk) return reply.code(409).send({ error: emu.message ?? "模拟器未连接或 ROM 未验证" });
		return null;
	};
	const guard = (reply: FastifyReply, s: Session, fn: () => void) => {
		try {
			fn();
			return { ok: true, controller: s.controller.status() };
		} catch (e) {
			return reply.code(409).send({ error: (e as Error).message });
		}
	};

	// ---- 状态 / 设置 ----
	slotRoute("get", "/status", async (_req, _reply, s) => s.status());
	slotRoute("get", "/settings", async (_req, _reply, s) => redact(s.getSettings()));
	slotRoute("put", "/settings", async (req, reply, s) => {
		try {
			s.updateSettings((req.body ?? {}) as never);
			return redact(s.getSettings());
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
	});

	// ---- 模型 ----
	app.get("/api/models/discover", async () => ({ endpoints: await manager.get("a")!.discover() }));
	slotRoute("post", "/models/list", async (req, _reply, s) => ({ models: await s.models((req.body ?? {}) as never) }));
	slotRoute("post", "/llm/test", async (_req, _reply, s) => s.testLlm());

	// ---- 提示词预设（全局，两个槽位共用） ----
	app.get("/api/presets", async () => ({ presets: manager.get("a")!.listPresets() }));
	app.put("/api/presets/:id", async (req, reply) => {
		const { id } = req.params as { id: string };
		const b = req.body as { name?: string; base_prompt?: string; output_instructions?: string };
		if (!b?.base_prompt || !b?.output_instructions) return reply.code(400).send({ error: "base_prompt 和 output_instructions 必填" });
		try {
			manager.get("a")!.savePreset(id, { name: b.name ?? id, base_prompt: b.base_prompt, output_instructions: b.output_instructions });
			return { ok: true };
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
	});

	// ---- 控制 ----
	slotRoute("post", "/control/takeover", async (_req, reply, s) => needEmu(reply, s) ?? guard(reply, s, () => s.controller.takeover()));
	slotRoute("post", "/control/arm", async (_req, reply, s) => needEmu(reply, s) ?? guard(reply, s, () => s.controller.arm()));
	slotRoute("post", "/control/release", async (_req, reply, s) => guard(reply, s, () => s.controller.release()));
	slotRoute("post", "/control/stop", async (_req, _reply, s) => {
		await s.controller.emergencyStop();
		return { ok: true, controller: s.controller.status() };
	});
	// 读取存档点；只在空闲时允许
	slotRoute("post", "/control/load-state", async (req, reply, s) => {
		const slot = Number((req.body as { slot?: number } | undefined)?.slot ?? 1);
		if (!Number.isInteger(slot) || slot < 1 || slot > 9) return reply.code(400).send({ error: "slot 必须是 1–9" });
		const st = s.controller.status().state;
		if (!["idle", "finished", "needs_human"].includes(st)) return reply.code(409).send({ error: `控制器忙（${st}），先释放` });
		const emu = needEmu(reply, s);
		if (emu) return emu;
		try {
			await s.loadState(slot);
			return { ok: true, slot };
		} catch (e) {
			return reply.code(500).send({ error: (e as Error).message });
		}
	});
	slotRoute("post", "/control/confirm", async (req, reply, s) => {
		const ok = (req.body as { ok?: boolean } | undefined)?.ok !== false;
		return s.controller.confirm(ok) ? { ok: true } : reply.code(409).send({ error: "没有等待确认的动作" });
	});
	slotRoute("post", "/control/confirm-mode", async (req, _reply, s) => {
		const on = (req.body as { on?: boolean } | undefined)?.on === true;
		s.updateSettings({ agent: { confirmMode: on } });
		return { ok: true, confirmMode: on };
	});

	// 这个槽位的模拟器现在有没有页面在做宿主（新打开的页面据此决定自己是当宿主还是当观众）
	slotRoute("get", "/emu/host", async (_req, _reply, s) => ({ hosted: s.hub?.hosted ?? false, native: !s.hub }));

	// ---- 对比：两边读同一个存档点、同一个随机数种子，同时开始 ----
	app.post("/api/compare/start", async (req, reply) => {
		const b = (req.body ?? {}) as { stateSlot?: number; seed?: number };
		const stateSlot = Number(b.stateSlot ?? 1);
		if (!Number.isInteger(stateSlot) || stateSlot < 1 || stateSlot > 9) return reply.code(400).send({ error: "stateSlot 必须是 1–9" });
		try {
			return { ok: true, ...(await manager.startCompare({ stateSlot, seed: b.seed })) };
		} catch (e) {
			return reply.code(409).send({ error: (e as Error).message });
		}
	});
	app.post("/api/compare/stop", async () => {
		await Promise.all(manager.all().map((s) => s.controller.emergencyStop()));
		return { ok: true };
	});

	// ---- 历史（运行日志是全局的，每条带 slot） ----
	app.get("/api/runs", async () => ({ runs: manager.get("a")!.runs() }));
	app.get("/api/runs/:id", async (req, reply) => {
		const events = manager.get("a")!.run((req.params as { id: string }).id);
		return events ? { events } : reply.code(404).send({ error: "没有这个 run" });
	});
	// 下载：format=md（给外部 AI 分析的报告，默认）| jsonl（原始事件日志）；thinking=0 / obs=0 可去掉思考 / 完整观测 JSON
	app.get("/api/runs/:id/export", async (req, reply) => {
		const { id } = req.params as { id: string };
		const q = req.query as { format?: string; thinking?: string; obs?: string };
		const format = q.format === "jsonl" ? "jsonl" : "md";
		const raw = manager.get("a")!.runRaw(id);
		if (raw === null) return reply.code(404).send({ error: "没有这个 run" });
		reply.header("content-disposition", `attachment; filename="${exportFileName(id, format)}"`);
		if (format === "jsonl") return reply.type("application/x-ndjson; charset=utf-8").send(raw);
		const records = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
		return reply.type("text/markdown; charset=utf-8").send(buildRunReport(records, { thinking: q.thinking !== "0", observationJson: q.obs !== "0" }));
	});

	// ---- 游戏资源（给网页里的模拟器；只读、固定几类文件） ----
	app.get("/api/assets", async () => assets.info());
	app.get("/api/assets/rom", async (_req, reply) => {
		const p = assets.romPath();
		return p ? reply.type("application/octet-stream").send(assets.read(p)) : reply.code(404).send({ error: "项目根目录下没有 .gba ROM" });
	});
	app.get("/api/assets/sav", async (_req, reply) => {
		const p = assets.savPath();
		return p ? reply.type("application/octet-stream").send(assets.read(p)) : reply.code(404).send({ error: "没有 .sav 存档" });
	});
	app.get("/api/assets/state/:n", async (req, reply) => {
		const p = assets.statePath(Number((req.params as { n: string }).n));
		return p ? reply.type("application/octet-stream").send(assets.read(p)) : reply.code(404).send({ error: "没有这个存档点" });
	});
	app.get("/api/symbols", async () => ({ symbols: symbolsForHost(manager.get("a")!.syms) }));

	// ---- 前端静态文件（web/dist，构建后同端口访问；含 /core/ 下的模拟器核心） ----
	if (existsSync(WEB_DIST)) await app.register(fastifyStatic, { root: WEB_DIST });

	// ---- WebSocket ----
	const wss = new WebSocketServer({ noServer: true });
	const emuWss = new WebSocketServer({ noServer: true });
	app.server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://x");
		const s = manager.get(url.searchParams.get("slot") ?? "a");
		if (!s || !["/ws", "/emu-link"].includes(url.pathname)) return socket.destroy();
		if (url.pathname === "/emu-link") {
			if (!s.hub) return socket.destroy(); // 这个槽位用的是 Lua 桥，不接网页模拟器
			// 默认：已有宿主在线就拒绝（新页面当观众）；?force=1 才顶掉旧宿主
			const force = url.searchParams.get("force") === "1";
			emuWss.handleUpgrade(req, socket, head, (ws) => void s.hub!.attach(ws, { force }));
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.send(JSON.stringify({ type: "hello", status: s.status(), replay: s.replay() }));
			const off = s.subscribe((e) => {
				if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
			});
			ws.on("close", off);
			ws.on("error", off);
		});
	});
	app.addHook("onClose", async () => {
		for (const c of [...wss.clients, ...emuWss.clients]) c.terminate();
		wss.close();
		emuWss.close();
	});

	return app;
}

export { SLOT_IDS };
