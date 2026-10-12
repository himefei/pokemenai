// 把 mGBA 的 WebAssembly 核心（MPL-2.0，@thenick775/mgba-wasm）复制到 public/core/，由前端按需加载。
// 在 predev / prebuild 里自动运行；public/core 不进 git。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "node_modules/@thenick775/mgba-wasm/dist");
const dst = resolve(root, "public/core");
if (!existsSync(src)) {
	console.error("找不到 @thenick775/mgba-wasm，请先运行 npm install");
	process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const f of ["mgba.js", "mgba.wasm"]) copyFileSync(resolve(src, f), resolve(dst, f));
console.log("mGBA WebAssembly 核心已复制到 public/core/");
