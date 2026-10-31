import { useEffect, useState } from "react";
import { useApi } from "../api";
import type { AgentState } from "../store";
import type { ContextWindowInfo, LlmSettings, ModelInfo, Preset, ServerStatus, Settings, StateProbeResult } from "../types";
import { Card, ExportButtons, Field } from "./bits";
import { CONTEXT_MODE_LABEL, fmt } from "./ContextMeter";

const kilo = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const STATE_LABEL: Record<string, string> = { idle: "空闲", armed: "已武装（等待战斗开始）", waiting: "等待可操作界面", deciding: "模型思考中", executing: "正在按键", paused: "等待你确认", needs_human: "需要人工处理", finished: "已结束" };
export const stateLabel = (s: string) => STATE_LABEL[s] ?? s;

export function LeftPanel({ state, server, refresh, pendingConfirm }: { state: AgentState; server: ServerStatus | null; refresh: () => void; pendingConfirm: { label: string } | null }) {
	return (
		<div className="col left">
			<ConnectionCard state={state} />
			<ControlCard state={state} server={server} refresh={refresh} pendingConfirm={pendingConfirm} />
			{server && <ModelCard settings={server.settings} refresh={refresh} />}
				{server && <ConversationCard settings={server.settings} refresh={refresh} />}
			{server && <PromptCard settings={server.settings} refresh={refresh} />}
		</div>
	);
}

function ConnectionCard({ state }: { state: AgentState }) {
	const emu = state.emu;
	return (
		<Card title="连接">
			<div className="kv">
				<span>mGBA 桥</span>
				<b className={emu?.connected ? "ok" : "bad"}>{emu?.connected ? "已连接" : "未连接"}</b>
				<span>ROM</span>
				<b className={emu?.romOk ? "ok" : "bad"}>{emu?.romOk ? `已验证 ${emu.gameCode ?? ""}` : "未验证"}</b>
				<span>当前阶段</span>
				<b>{state.phase ? `${state.phase.phase}${state.phase.forced ? "（强制换人）" : ""}` : "—"}</b>
			</div>
			{emu?.message && <p className="warn-text">{emu.message}</p>}
			{!emu?.connected && <p className="hint">在 mGBA 里 Tools → Scripting → File → Load script… 选 lua/bridge.lua，桥接服务会自动重连。</p>}
		</Card>
	);
}

function ControlCard({ state, server, refresh, pendingConfirm }: { state: AgentState; server: ServerStatus | null; refresh: () => void; pendingConfirm: { label: string } | null }) {
	const api = useApi();
	const [err, setErr] = useState("");
	const [slot, setSlot] = useState(1);
	const run = (fn: () => Promise<unknown>) => async () => {
		setErr("");
		try {
			await fn();
			refresh();
		} catch (e) {
			setErr((e as Error).message);
		}
	};
	const st = state.controller.state;
	const busy = !["idle", "finished", "needs_human"].includes(st);
	const ready = !!state.emu?.connected && !!state.emu?.romOk;
	const confirmMode = server?.settings.agent.confirmMode ?? false;
	return (
		<Card title="控制" right={<span className={`pill state-${st}`}>{stateLabel(st)}</span>}>
			<div className="btns">
				<button className="primary" disabled={!ready || busy} onClick={run(api.takeover)} title="动画进行中则等到行动菜单再开始">
					接管当前战斗
				</button>
				<button disabled={!ready || busy} onClick={run(api.arm)} title="走路时点一下，进入战斗后自动接管">
					武装
				</button>
				<button disabled={!busy} onClick={run(api.release)}>
					释放
				</button>
				<button className="danger" onClick={run(api.stop)}>
					急停
				</button>
			</div>
			<div className="row">
				<select value={slot} onChange={(e) => setSlot(Number(e.target.value))} style={{ width: "auto" }}>
					{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
						<option key={n} value={n}>
							存档点 {n}
						</option>
					))}
				</select>
				<button disabled={!ready || busy} onClick={run(() => api.loadState(slot))} title="读取 mGBA 的 save state（建议存在第一回合行动菜单处）">
					读取存档点
				</button>
			</div>
			<label className="check">
				<input type="checkbox" checked={confirmMode} onChange={run(() => api.saveSettings({ agent: { confirmMode: !confirmMode } }))} />
				确认模式（模型给出动作后先停住，点“执行”才按键）
			</label>
			{pendingConfirm && (
				<div className="confirm">
					<span>
						待执行：<b>{pendingConfirm.label}</b>
					</span>
					<button className="primary" onClick={run(() => api.confirm(true))}>
						执行
					</button>
					<button onClick={run(() => api.confirm(false))}>否决</button>
				</div>
			)}
			{busy && <p className="ai-banner">🤖 AI 控制中——请不要碰键盘，否则会和注入的按键叠加。</p>}
			{st === "needs_human" && (
				<p className="warn-text">
					⚠ {state.controller.detail}
					<br />
					现场已停住，处理好后点“释放”，再重新接管。
				</p>
			)}
			{err && <p className="warn-text">{err}</p>}
			{state.errors.length > 0 && st !== "needs_human" && <p className="warn-text">{state.errors.at(-1)}</p>}
			<LatestExport />
		</Card>
	);
}

/** 最近一次运行的日志下载（运行结束 / 出错退出后都能下）。 */
function LatestExport() {
	const api = useApi();
	const [latest, setLatest] = useState<string | null>(null);
	useEffect(() => {
		const load = () =>
			api
				.runs()
				.then((r) => setLatest(r.runs.find((x) => (x.slot ?? "a") === api.slot)?.runId ?? null))
				.catch(() => {});
		load();
		const t = setInterval(load, 5000);
		return () => clearInterval(t);
	}, []);
	if (!latest) return null;
	return (
		<details className="coll">
			<summary>下载最近一次运行的日志</summary>
			<div className="coll-b">
				<ExportButtons url={(o) => api.exportUrl(latest, { format: o.format, thinking: o.thinking })} />
			</div>
		</details>
	);
}

function ModelCard({ settings, refresh }: { settings: Settings; refresh: () => void }) {
	const api = useApi();
	const [llm, setLlm] = useState<LlmSettings>(settings.llm);
	const [policy, setPolicy] = useState(settings.agent.policy);
	const [keyInput, setKeyInput] = useState("");
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState("");

	useEffect(() => {
		setLlm(settings.llm);
		setPolicy(settings.agent.policy);
	}, [settings]);

	const set = (patch: Partial<LlmSettings>) => setLlm((x) => ({ ...x, ...patch }));

	const save = async (): Promise<boolean> => {
		try {
			await api.saveSettings({ llm: { kind: llm.kind, baseUrl: llm.baseUrl, model: llm.model, params: { timeoutMs: llm.params?.timeoutMs }, ...(keyInput ? { apiKey: keyInput } : {}) }, agent: { policy } });
			setKeyInput("");
			refresh();
			return true;
		} catch (e) {
			setMsg({ ok: false, text: (e as Error).message });
			return false;
		}
	};

	const loadModels = async () => {
		setBusy("models");
		setMsg(null);
		try {
			if (!(await save())) return;
			const r = await api.models({});
			if (!r.models) setMsg({ ok: false, text: "没有读到模型列表（地址不对、需要 key，或服务未启动）" });
			else {
				setModels(r.models);
				setMsg({ ok: true, text: `发现 ${r.models.length} 个模型` });
			}
		} finally {
			setBusy("");
		}
	};

	const discover = async () => {
		setBusy("discover");
		setMsg(null);
		try {
			const r = await api.discover();
			if (r.endpoints.length === 0) setMsg({ ok: false, text: "本机常见端口（1234 / 11434 / 8080 / 8000）都没有发现服务" });
			else {
				const e = r.endpoints[0]!;
				set({ baseUrl: e.baseUrl, kind: "openai-compat" });
				setModels(e.models);
				setMsg({ ok: true, text: `发现 ${r.endpoints.map((x) => `${x.product}@${x.baseUrl}`).join("、")}` });
			}
		} finally {
			setBusy("");
		}
	};

	const test = async () => {
		setBusy("test");
		setMsg(null);
		try {
			if (!(await save())) return;
			const r = await api.testLlm();
			setMsg(r.ok ? { ok: true, text: `连接正常，${r.latencyMs}ms，回复：${r.reply}` } : { ok: false, text: r.error ?? "失败" });
		} finally {
			setBusy("");
		}
	};

	const isLlm = policy === "llm";
	return (
		<Card title="模型">
			<Field label="决策者">
				<select value={policy} onChange={(e) => setPolicy(e.target.value as "llm" | "random")}>
					<option value="llm">大模型</option>
					<option value="random">random 基线（随机合法动作）</option>
				</select>
			</Field>
			{isLlm && (
				<>
					<Field label="接口类型">
						<select value={llm.kind} onChange={(e) => set({ kind: e.target.value as LlmSettings["kind"] })}>
							<option value="openai-compat">OpenAI 兼容（LM Studio / Ollama / llama.cpp / vLLM / 云端）</option>
							<option value="anthropic">Anthropic Messages</option>
						</select>
					</Field>
					<Field label="Base URL" hint="不含 /v1，例如 http://127.0.0.1:1234">
						<input value={llm.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} spellCheck={false} />
					</Field>
					<Field label="API Key" hint="只存本地 config/settings.local.json（0600），界面里遮罩显示；留空表示不修改">
						<input type="password" placeholder={llm.apiKey ? `已保存 ${llm.apiKey}` : "（无）"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} autoComplete="off" />
					</Field>
					<Field label="模型">
						<div className="row">
							<input list={`model-list-${api.slot}`} value={llm.model} onChange={(e) => set({ model: e.target.value })} spellCheck={false} />
							<datalist id={`model-list-${api.slot}`}>
								{models.map((m) => (
									<option key={m.id} value={m.id}>
										{[...m.tags, m.contextLength ? `${kilo(m.contextLength)} ctx` : "", m.loaded === false ? "未加载" : ""].filter(Boolean).join(" · ")}
									</option>
								))}
							</datalist>
							<button onClick={loadModels} disabled={!!busy} title="按当前地址和 key 刷新模型列表">
								{busy === "models" ? "…" : "刷新"}
							</button>
							<button onClick={discover} disabled={!!busy} title="探测本机 LM Studio / Ollama / llama.cpp / vLLM">
								{busy === "discover" ? "…" : "发现"}
							</button>
						</div>
					</Field>
					{models.length > 0 && (
						<div className="chips model-chips">
							{models.map((m) => (
								<button key={m.id} className={`chip pick ${m.id === llm.model ? "on" : ""}`} onClick={() => set({ model: m.id })}>
									{m.id}
									{m.tags.map((t) => ` ·${t}`).join("")}
										{m.contextLength ? ` ·${kilo(m.contextLength)}` : ""}
								</button>
							))}
						</div>
					)}
					<p className="hint">模型参数（temperature、top_k、min_p、max_tokens、思考开关……）全部由 endpoint 自己的配置决定——这里**不传、也不覆盖任何参数**（比如 omlx 里给这个模型调好的参数）。</p>
						<Field label="请求超时（秒）" hint="本地设置：等多久没回就当失败（不重试）">
							<input type="number" min="5" value={Math.round((llm.params?.timeoutMs ?? 600000) / 1000)} onChange={(e) => set({ params: { timeoutMs: Number(e.target.value) * 1000 } })} />
						</Field>
					</>
			)}
			<div className="btns">
				<button className="primary" onClick={async () => setMsg((await save()) ? { ok: true, text: "已保存" } : null)}>
					保存
				</button>
				{isLlm && (
					<button onClick={test} disabled={!!busy}>
						{busy === "test" ? "测试中…" : "测试连接"}
					</button>
				)}
			</div>
			{msg && <p className={msg.ok ? "ok-text" : "warn-text"}>{msg.text}</p>}
			<p className="hint">一次接管开始时会快照当前模型与参数，写进该次 run 的日志，保证结果可追溯。</p>
		</Card>
	);
}

function PromptCard({ settings, refresh }: { settings: Settings; refresh: () => void }) {
	const api = useApi();
	const [presets, setPresets] = useState<Preset[]>([]);
	const [id, setId] = useState(settings.agent.preset);
	const [draft, setDraft] = useState<Preset["preset"] | null>(null);
	const [note, setNote] = useState("");
	const a = settings.agent;

	useEffect(() => {
		api.presets().then((r) => setPresets(r.presets)).catch(() => {});
	}, []);
	useEffect(() => {
		const p = presets.find((x) => x.id === id);
		if (p) setDraft(p.preset);
	}, [id, presets]);

	const patchAgent = async (patch: Partial<Settings["agent"]>) => {
		await api.saveSettings({ agent: patch });
		refresh();
	};

	return (
		<Card title="提示词与实验开关">
			<Field label="Prompt 预设">
				<select
					value={id}
					onChange={async (e) => {
						setId(e.target.value);
						await patchAgent({ preset: e.target.value });
					}}
				>
					{presets.map((p) => (
						<option key={p.id} value={p.id}>
							{p.preset.name}
						</option>
					))}
				</select>
			</Field>
			{draft && (
				<>
					<Field label="base_prompt（你的原始提示词）">
						<textarea rows={6} value={draft.base_prompt} onChange={(e) => setDraft({ ...draft, base_prompt: e.target.value })} />
					</Field>
					<Field label="output_instructions（输出协议）">
						<textarea rows={6} value={draft.output_instructions} onChange={(e) => setDraft({ ...draft, output_instructions: e.target.value })} />
					</Field>
					<div className="btns">
						<button
							onClick={async () => {
								await api.savePreset(id, draft);
								setNote("预设已保存");
							}}
						>
							保存预设
						</button>
						<button
							onClick={async () => {
								const name = prompt("新预设 id（字母数字下划线）：", `${id}-copy`);
								if (!name) return;
								await api.savePreset(name, { ...draft, name });
								setPresets((await api.presets()).presets);
								setId(name);
								await patchAgent({ preset: name });
							}}
						>
							另存为…
						</button>
					</div>
					{note && <p className="ok-text">{note}</p>}
				</>
			)}
			<label className="check">
				<input type="checkbox" checked={a.rulesHint} onChange={() => patchAgent({ rulesHint: !a.rulesHint })} />
				规则提示（第 3 世代规则；评测变量，默认关——关掉才能测模型自己是否知道这代规则）
			</label>
			<div className="grid2">
				<Field label="保留完整对话的回合数">
					<input type="number" min="1" max="30" value={a.keepFull} onChange={(e) => patchAgent({ keepFull: Math.max(1, Number(e.target.value)) })} />
				</Field>
				<Field label="格式错误重试次数" hint="耗尽后如实报错，没有兜底">
					<input type="number" min="0" max="5" value={a.maxRetries} onChange={(e) => patchAgent({ maxRetries: Math.max(0, Number(e.target.value)) })} />
				</Field>
			</div>
			<p className="hint">信息原则：我方全知，对手只给感知（用过的招式、屏幕上读到的文字）；不给属性表、种族值、伤害计算。</p>
		</Card>
	);
}

const MODE_HINT: Record<Settings["agent"]["contextMode"], string> = {
	window: "每回合重发：system + 最近几回合的完整对话 + 更早回合的一行摘要（你选了什么、之后读到什么原文）。省 token，但模型看不到太早的细节。",
	continuous:
		"整场战斗是一个越来越长的对话：每次请求 = 上一次请求（逐字不变）+ 模型的原始回复 + 新的状态。不摘要、不丢弃，可以用来观察模型的上下文记忆、召回和被旧内容干扰的情况。后端有前缀缓存的话，重发的前面部分几乎不用重新计算。",
	"continuous-server":
		"内容和“连续会话”完全一样，区别是对话存在后端：第一次发完整内容，之后只发新消息 + previous_response_id。需要后端支持（用下面的按钮实测）；不支持就报错，不会悄悄改成整段重发。",
};

function ConversationCard({ settings, refresh }: { settings: Settings; refresh: () => void }) {
	const api = useApi();
	const a = settings.agent;
	const llm = settings.llm;
	const [info, setInfo] = useState<ContextWindowInfo | null>(null);
	const [detecting, setDetecting] = useState(false);
	const [manual, setManual] = useState(String(a.contextWindow));
	const [probe, setProbe] = useState<{ busy: boolean; result?: StateProbeResult }>({ busy: false });
	const [err, setErr] = useState("");

	const detect = async () => {
		setDetecting(true);
		try {
			setInfo(await api.contextWindow());
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setDetecting(false);
		}
	};
	// 模型 / 地址 / 手动值变了就重新识别——同一个 endpoint 上换一个模型，窗口大小也会跟着变
	useEffect(() => {
		void detect();
		setProbe({ busy: false });
	}, [llm.baseUrl, llm.model, llm.kind, a.contextWindow]);
	useEffect(() => setManual(String(a.contextWindow)), [a.contextWindow]);

	const patch = async (agent: Partial<Settings["agent"]>) => {
		setErr("");
		try {
			await api.saveSettings({ agent });
			refresh();
		} catch (e) {
			setErr((e as Error).message);
		}
	};
	// 清空 = 恢复默认 65535（服务端处理）
	const applyManual = () => patch({ contextWindow: manual.trim() === "" ? (null as unknown as number) : Number(manual) });

	const runProbe = async () => {
		setProbe({ busy: true });
		try {
			setProbe({ busy: false, result: await api.testServerState() });
		} catch (e) {
			setProbe({ busy: false, result: { supported: false, reason: (e as Error).message } });
		}
	};

	if (a.policy === "random") return null;
	const eff = info?.effective;
	return (
		<Card title="上下文与会话" right={<span className="pill">{CONTEXT_MODE_LABEL[a.contextMode]}</span>}>
			<Field label="上下文管理方式">
				<select value={a.contextMode} onChange={(e) => patch({ contextMode: e.target.value as Settings["agent"]["contextMode"] })}>
					<option value="window">窗口 + 摘要（默认）</option>
					<option value="continuous">连续会话（每次重发完整记录）</option>
					<option value="continuous-server">连续会话 · 后端保存（/v1/responses）</option>
				</select>
			</Field>
			<p className="hint">{MODE_HINT[a.contextMode]}</p>
			{a.contextMode === "window" && (
				<Field label="保留完整对话的回合数" hint="更早的回合压成一行摘要">
					<input type="number" min="1" max="30" value={a.keepFull} onChange={(e) => patch({ keepFull: Math.max(1, Number(e.target.value)) })} />
				</Field>
			)}
			<div className="ctx-box">
				<div className="kv">
					<span>模型</span>
					<b>{llm.model || "（未选）"}</b>
					<span>上下文长度</span>
					<b className={info?.usedFallback ? "warn" : ""}>{detecting && !info ? "读取中…" : eff ? `${fmt(eff.max)} tokens` : "—"}</b>
				</div>
				{eff && (
					<p className={info?.usedFallback ? "warn-text" : "hint"}>
						{info?.usedFallback ? "⚠ " : "来自 endpoint："}
						{eff.source}
					</p>
				)}
				<Field label="手动后备值（tokens）" hint="只在 endpoint 读不到这个模型的窗口时才用；endpoint 报告了就一律以它为准">
					<div className="row">
						<input type="number" min="512" step="1024" placeholder="65535" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void applyManual()} />
						<button onClick={() => void applyManual()} disabled={manual === String(a.contextWindow)}>
							应用
						</button>
						<button onClick={() => void detect()} disabled={detecting} title="重新从 endpoint 读取这个模型的窗口大小">
							{detecting ? "…" : "重新读取"}
						</button>
					</div>
				</Field>
				<p className="hint">快用满（预计下一次请求超过窗口的 95%）时程序会先停下报错，不会让后端悄悄截断前面的内容。</p>
			</div>
			{a.contextMode === "continuous-server" && (
				<div className="ctx-box">
					<div className="btns">
						<button onClick={() => void runProbe()} disabled={probe.busy}>
							{probe.busy ? "测试中…" : "测试这个后端是否保存对话"}
						</button>
					</div>
					{probe.result && <p className={probe.result.supported ? "ok-text" : "warn-text"}>{probe.result.supported ? "✓ 支持：" : "✗ 不支持："}{probe.result.reason}</p>}
					<p className="hint">测试会让模型记一个随机数，第二轮只发新问题 + previous_response_id，看它能不能答出来（花几百个 token）。</p>
				</div>
			)}
			{err && <p className="warn-text">{err}</p>}
		</Card>
	);
}
