import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 开发：前端 5173，/api 与 /ws 代理到桥接服务 8787（都只绑 127.0.0.1）
export default defineConfig({
	plugins: [react()],
	server: {
		host: "127.0.0.1",
		port: 5173,
		// WebAssembly 多线程（SharedArrayBuffer）需要页面"跨源隔离"
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Resource-Policy": "same-origin",
		},
		proxy: {
			"/api": "http://127.0.0.1:8787",
			"/ws": { target: "ws://127.0.0.1:8787", ws: true },
			"/emu-link": { target: "ws://127.0.0.1:8787", ws: true },
		},
	},
	test: { environment: "node" },
});
