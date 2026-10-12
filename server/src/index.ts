// 桥接服务入口：npm run serve
//   默认：网页里的 WebAssembly 模拟器（两个槽位 A / B）通过 WebSocket 连进来，UI 在 http://127.0.0.1:8787
//   旧模式：EMU_PORT=8765 npm run serve  → 槽位 A 改连桌面 mGBA 的 Lua 桥（lua/bridge.lua），自动重连

import { SessionManager } from "./api/manager.js";
import { buildServer } from "./api/http.js";

const port = Number(process.env.PORT ?? 8787);
const nativePort = process.env.EMU_PORT ? Number(process.env.EMU_PORT) : undefined;

const manager = new SessionManager({ emuPort: nativePort });
const app = await buildServer(manager);
await manager.start();
await app.listen({ host: "127.0.0.1", port });
console.log(`桥接服务：http://127.0.0.1:${port}`);
console.log(nativePort ? `槽位 A：桌面 mGBA 的 Lua 桥 127.0.0.1:${nativePort}（自动重连）；槽位 B：网页模拟器` : "模拟器：网页里的 WebAssembly 版（打开上面的地址即可，不需要 mGBA.app）");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, async () => {
		// 正常关闭可能被还没断开的 WebSocket / 模型请求拖住；3 秒后强退，免得残留进程一直占着 mGBA 桥
		setTimeout(() => process.exit(0), 3000).unref();
		await manager.stop();
		await app.close();
		process.exit(0);
	});
}
