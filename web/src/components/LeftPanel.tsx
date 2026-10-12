import { useEffect, useState } from "react";
import { useApi } from "../api";
import type { AgentState } from "../store";
import type { LlmSettings, ModelInfo, Preset, ServerStatus, Settings } from "../types";
import { Card, ExportButtons, Field } from "./bits";

const STATE_LABEL: Record<string, string> = { idle: "空闲", armed: "已武装（等待战斗开始）", waiting: "等待可操作界面", deciding: "模型思考中", executing: "正在按键", paused: "等待你确认", needs_human: "需要人工处理", finished: "已结束" };
export const stateLabel = (s: string) => STATE_LABEL[s] ?? s;

export function LeftPanel({ state, server, refresh, pendingConfirm }: { state: AgentState; server: ServerStatus | null; refresh: () => void; pendingConfirm: { label: string } | null }) {
	return (
		<div className="col left">
			<ConnectionCard state={state} />
			<ControlCard state={state} server={server} refresh={refresh} pendingConfirm={pendingConfirm} />
			{server && <ModelCard settings={server.settings} refresh={refresh} />}
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
	const [extra, setExtra] = useState(JSON.stringify(settings.llm.extraBody ?? {}, null, 1));
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState("");

	useEffect(() => {
		setLlm(settings.llm);
		setPolicy(settings.agent.policy);
	}, [settings]);

	const set = (patch: Partial<LlmSettings>) => setLlm((x) => ({ ...x, ...patch }));
	const setParam = (k: string, v: number | string | null) => setLlm((x) => ({ ...x, params: { ...x.params, [k]: v } }));

	const save = async (): Promise<boolean> => {
		let extraBody: Record<string, unknown> = {};
		try {
			extraBody = extra.trim() ? (JSON.parse(extra) as Record<string, unknown>) : {};
		} catch {
			setMsg({ ok: false, text: "额外请求体不是合法 JSON" });
			return false;
		}
		try {
			await api.saveSettings({ llm: { kind: llm.kind, baseUrl: llm.baseUrl, model: llm.model, params: llm.params, extraBody, ...(keyInput ? { apiKey: keyInput } : {}) }, agent: { policy } });
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
							<input list="model-list" value={llm.model} onChange={(e) => set({ model: e.target.value })} spellCheck={false} />
							<datalist id="model-list">
								{models.map((m) => (
									<option key={m.id} value={m.id}>
										{[...m.tags, m.loaded === false ? "未加载" : ""].filter(Boolean).join(" · ")}
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
								</button>
							))}
						</div>
					)}
					<p className="hint">采样参数默认**不发**，由 endpoint 自己的配置决定（比如 omlx 里调好的最优参数）。下面是可选覆盖，留空 = 不覆盖。</p>
					<div className="grid2">
						<Field label="temperature（可选）">
							<input type="number" step="0.1" min="0" max="2" placeholder="由 endpoint 决定" value={llm.params?.temperature ?? ""} onChange={(e) => setParam("temperature", e.target.value === "" ? null : Number(e.target.value))} />
						</Field>
						<Field label="max_tokens（可选）">
							<input type="number" step="256" min="64" placeholder="由 endpoint 决定" value={llm.params?.maxTokens ?? ""} onChange={(e) => setParam("maxTokens", e.target.value === "" ? null : Number(e.target.value))} />
						</Field>
						<Field label="请求超时（秒，本地设置）">
							<input type="number" min="5" value={Math.round((llm.params?.timeoutMs ?? 180000) / 1000)} onChange={(e) => setParam("timeoutMs", Number(e.target.value) * 1000)} />
						</Field>
						{llm.kind === "anthropic" ? (
							<Field label="思考预算（tokens，可选）" hint="留空 = 不开思考">
								<input type="number" min="1024" step="512" placeholder="不开思考" value={llm.params?.thinkingBudget ?? ""} onChange={(e) => setParam("thinkingBudget", e.target.value === "" ? null : Number(e.target.value))} />
							</Field>
						) : (
							<Field label="reasoning_effort（可选）" hint="留空 = 不发送">
								<input value={llm.params?.reasoningEffort ?? ""} onChange={(e) => setParam("reasoningEffort", e.target.value || null)} placeholder="由 endpoint 决定" />
							</Field>
						)}
					</div>
					<Field label="额外请求体 JSON" hint="本地模型常需要，例如 {&quot;chat_template_kwargs&quot;:{&quot;enable_thinking&quot;:false}}">
						<textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} spellCheck={false} />
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
