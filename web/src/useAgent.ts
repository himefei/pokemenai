import { useEffect, useReducer, useRef, useState } from "react";
import { makeApi } from "./api";
import type { SlotId } from "./api";
import { foldEvents, initialState, reduce } from "./store";
import type { AgentState } from "./store";
import type { AgentEvent, ServerStatus } from "./types";

type Action = { kind: "event"; e: AgentEvent } | { kind: "reset"; events: AgentEvent[] };

function reducer(state: AgentState, a: Action): AgentState {
	return a.kind === "reset" ? foldEvents(a.events) : reduce(state, a.e);
}

export type WsState = "connecting" | "open" | "closed";

/** 连接桥接服务的 WebSocket：连上先收到 hello（状态 + 现场回放），之后增量事件；断线自动重连。 */
export function useAgent(slot: SlotId = "a") {
	const [state, dispatch] = useReducer(reducer, initialState);
	const [ws, setWs] = useState<WsState>("connecting");
	const [server, setServer] = useState<ServerStatus | null>(null);
	const retry = useRef(0);

	useEffect(() => {
		let sock: WebSocket | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;

		const connect = () => {
			setWs("connecting");
			sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?slot=${slot}`);
			sock.onopen = () => {
				retry.current = 0;
				setWs("open");
			};
			sock.onmessage = (m) => {
				const msg = JSON.parse(String(m.data)) as AgentEvent | { type: "hello"; status: ServerStatus; replay: AgentEvent[] };
				if (msg.type === "hello") {
					setServer(msg.status);
					dispatch({ kind: "reset", events: [{ type: "emu.status", ...msg.status.emu }, { type: "controller.state", state: msg.status.controller.state, detail: msg.status.controller.detail }, ...msg.replay] });
				} else {
					dispatch({ kind: "event", e: msg });
				}
			};
			sock.onclose = () => {
				setWs("closed");
				if (!closed) timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry.current++));
			};
		};
		connect();
		return () => {
			closed = true;
			clearTimeout(timer);
			sock?.close();
		};
	}, [slot]);

	// 设置之类的低频数据按需刷新
	const refreshServer = () => makeApi(slot).status().then(setServer).catch(() => {});
	return { state, ws, server, refreshServer };
}
