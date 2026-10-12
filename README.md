# Pokémon Emerald Battle Agent

让大语言模型像人类玩家一样打《宝可梦 绿宝石》（Pokémon Emerald）的单打战斗：游戏直接跑在浏览器里（mGBA 的 WebAssembly 版），模型**只能看到玩家在屏幕上看得到、读得到的信息**，自己决定出招、换人、回答游戏里的“是 / 否”提示；网页里实时显示模型的完整输入输出、历史、统计，还能让两个模型同场对比。

> English: an LLM plays Pokémon Emerald battles through an in-browser mGBA (WebAssembly) emulator. The model only gets what a human player can see; a web UI shows its prompts, thinking and decisions live, with a side-by-side compare mode for two models. Everything runs locally; you bring your own ROM and your own model endpoint.

## 特点

- **游戏就在网页里**：不需要另外安装 mGBA，键盘可以手动玩，AI 不在控制时随时能自己操作。
- **模型只“看”，不被喂答案**：自己的队伍全部可见；对手只有种类、等级、属性、HP 百分比、异常状态、**已经用过的招式**和战斗文字。不提供属性克制表、种族值、伤害计算。
- **没有兜底策略**：模型报错（超时、HTTP 错误、空回复）就如实报错并停下，不会替模型随便选一个动作。
- **看得见模型在想什么**：流式显示思考和回答、发给模型的完整 prompt、解析出的动作、实际按键结果。
- **对比模式**：上下分屏，两个独立的游戏实例、两个独立的模型，同一个存档点、同一个随机数种子同时开始。
- **日志可导出**：一键下载 Markdown 报告（适合贴给另一个 AI 做分析）或原始 JSONL。
- **模型接口**：OpenAI 兼容（LM Studio / Ollama / llama.cpp / vLLM / omlx / 云端）与 Anthropic Messages。

## 你需要准备

| 需要 | 说明 |
|---|---|
| Node.js ≥ 20 | 开发和测试用的是 Node 22 |
| 浏览器 | 最新的 Chrome / Edge 等 Chromium 内核浏览器（模拟器需要 SharedArrayBuffer，服务会自动加上跨源隔离头） |
| 游戏 ROM | **Pokémon Emerald (USA, Europe)**，CRC32 `1F1C08FB`。本仓库**不包含**任何游戏文件，请自行合法获取 |
| 一个模型 endpoint | 本地（LM Studio、Ollama 等）或云端均可，需要支持流式输出 |

## 安装与启动

```bash
# 1. 获取代码
git clone https://github.com/himefei/pokemenai.git
cd pokemenai

# 2. 安装依赖并构建前端（只需要做一次；web 的 npm install 会把模拟器核心复制到 web/public/core）
(cd server && npm install)
(cd web && npm install && npm run build)

# 3. 把 ROM 放到项目根目录（文件名随意，以 .gba 结尾）
cp "/path/to/Pokemon - Emerald Version (USA, Europe).gba" .

# 4. 启动
cd server && npm run serve
```

然后用浏览器打开 **http://127.0.0.1:8787**。页面左上角“模拟器”显示“已连接”、“ROM”显示“已验证”就可以用了。

更新代码后需要重新 `cd web && npm run build`，再重启服务。端口被占用时换一个：`PORT=8790 npm run serve`。

### 可选文件（都放在项目根目录，只读，永远不会被修改或上传）

- `<ROM 名>.sav`：游戏内存档。有的话每次启动都从它的副本开始，起点一致。
- `<ROM 名>.ss1` … `.ss9`：存档点（save state）。桌面版 mGBA 存的可以直接读。**对比模式和“读取存档点”需要它们**——建议存在某场战斗第一回合的行动菜单处。网页里的“保存存档点”存在浏览器本地，换浏览器不会带走。

## 怎么用

1. **设置模型**：左栏“模型”卡片里选接口类型，填 Base URL（不含 `/v1`，例如 `http://127.0.0.1:1234`）、API Key、选一个模型（“发现”按钮会自动探测本机的 LM Studio / Ollama / llama.cpp / vLLM，“刷新”按当前地址和 key 重新拉模型列表），点“保存”，再点“测试”确认能通。
2. **玩到战斗**：右侧游戏画面支持键盘手动玩——`WASD` 方向、`K`=A、`J`=B、`L`=L、`;`=R、`M`=开始、`N`=选择。
3. **让模型接管**：进入战斗后点“**接管当前战斗**”；或在走路时点“武装”，进入战斗后自动接管。随时可以点“释放”交还给自己，“急停”立刻停下。
4. **观察**：中间是回合时间线和战场信息，点任意一回合可以回看当时模型的输入 / 思考 / 回答 / 执行结果。“历史”“统计”“评测”标签页汇总多场结果。
5. **确认模式**（可选）：开启后，模型给出动作会先停住，你点“执行”才会按键，适合调试提示词。
6. **画面设置**：画面下方可以暂停 / 继续、调大小（2x–6x）、调速度（1x–8x）、静音、重置、读 / 存存档点。

### 对比模式：两个模型同场较量

点顶部的 **“对比”**：页面上下分屏，A、B 各是一个**完整、独立**的游戏实例、模型和信息界面（各自指定的接口、模型、提示词）。选一个存档点，可选填随机数种子，点 **“同时开始”**：两边先暂停 → 读同一个存档点 → 写同一个随机数种子 → 同时继续并接管。模型思考期间游戏会暂停，所以结果只取决于决策，不取决于谁想得更慢。

### 下载日志

每次运行都会写 `runs/run-<id>.jsonl`。在控制卡里点“下载最近一次运行的日志”，或在“历史”标签页选一次运行下载：

- **Markdown**：概要、信息设定、system 提示词、逐回合的场面 / 战斗文字 / 模型思考与回答 / 选择与执行结果、统计。可以直接贴给另一个 AI，问它模型哪里做得不好。
- **JSONL**：完整的原始事件流。

## 配置与隐私

- 所有设置在页面里改，保存到 **`config/settings.local.json`**（权限 0600，已在 `.gitignore` 里）。**API Key 只存在这个文件里**，界面里遮罩显示，不会写进运行日志。也可以用环境变量 `LLM_API_KEY` 代替，不落盘。
- 运行日志 `runs/`、ROM / 存档 / 存档点、`config/*.local.json`、`.env*` 都被 `.gitignore` 排除，不会被提交。
- 服务只监听 `127.0.0.1`，不对局域网或公网开放。
- 采样参数（temperature、max_tokens、reasoning_effort……）**默认不发送**，由 endpoint 自己的配置决定；界面里是可选覆盖。请求超时默认 600 秒。
- 模型调用本身出错（超时 / HTTP 错误 / 空回复）**不重试**，直接报错退出；只有“回答格式解析失败”才带着具体问题反馈重试。

## 常用命令

| 目录 | 命令 | 作用 |
|---|---|---|
| `server/` | `npm run serve` | 启动服务（UI 在 8787 端口） |
| `server/` | `npm test` | 运行服务端测试（不需要 ROM） |
| `server/` | `npm run typecheck` | 类型检查 |
| `server/` | `npm run gen:symbols` / `gen:data` | 重新生成符号表 / 第 3 世代数据 |
| `web/` | `npm run build` | 构建前端到 `web/dist`（服务直接托管） |
| `web/` | `npm run dev` | 前端热更新开发（http://127.0.0.1:5173，自动代理到 8787） |
| `web/` | `npm test` / `npm run typecheck` | 前端测试 / 类型检查 |

环境变量：`PORT`（默认 8787）、`LLM_API_KEY`、`ROM_PATH`（ROM 不在项目根目录时指定）、`PBA_SETTINGS`（设置文件路径）、`PBA_RUNS`（运行日志目录）、`PBA_WEB_DIST`（前端构建目录）。想在不影响正在用的服务和设置时做实验，就用另一个端口加一份临时设置文件：

```bash
PORT=8790 PBA_SETTINGS=/tmp/s.json PBA_RUNS=/tmp/runs npm run serve
```

## 常见问题

- **“ROM 未验证”**：ROM 必须是 Pokémon Emerald (USA, Europe)，CRC32 `1F1C08FB`；其他版本、汉化版、改版不受支持。
- **游戏不动 / 一直“定位模拟器内存”**：浏览器会挂起后台页面。把游戏页面放在前台（可以单独开一个窗口），切回来后会自动继续。
- **画面区提示“正在另一个页面里运行”**：每个槽位同一时间只能有一个页面当模拟器，再开的页面自动变成观众。想把模拟器挪过来，点“让这个页面成为模拟器”（旧页面会停下，不会抢回去）。
- **模型一直没有输出 / 超时**：看模型生成时右上角的“已等待 N 秒”；慢的模型在“请求超时（秒）”里调大；本地模型常需要在“额外请求体 JSON”里按各自文档设置，例如是否开启思考。
- **找不到存档点**：把 `.ssN` 文件放到项目根目录，文件名前缀要和 ROM 文件名一致。

## 进阶：沿用桌面版 mGBA（可选）

旧的 Lua 桥仍然可用：在桌面 mGBA 里 `Tools → Scripting…` 载入 `lua/bridge.lua`，然后 `EMU_PORT=8765 npm run serve`，槽位 A 就会改连桌面版（槽位 B 仍是网页模拟器）。命令行的 `npm run play` / `npm run phase0` 也走这条路。对比模式、暂停思考、网页手动玩只在网页模拟器里可用。

## 目录结构

```
server/   TypeScript 服务：模拟器协议、第 3 世代内存解析、阶段检测、输入执行器、模型接入、控制器、HTTP/WebSocket
web/      React + Vite 前端：UI 和浏览器里的 mGBA 宿主（web/src/emulator）
data/     第 3 世代数据、符号表、提示词预设（data/prompts）
lua/      桌面 mGBA 的脚本桥（可选）
config/   本地设置（settings.local.json 不进 git）
runs/     运行日志（不进 git）
```

## 致谢与声明

- 模拟器核心：[mGBA](https://mgba.io/)（MPL-2.0）及其 WebAssembly 构建 [`@thenick775/mgba-wasm`](https://www.npmjs.com/package/@thenick775/mgba-wasm)，通过 npm 安装，不随仓库分发。
- 内存地址来自 [pret/pokeemerald](https://github.com/pret/pokeemerald) 的符号表（经 [40Cakes/pokebot-gen3](https://github.com/40Cakes/pokebot-gen3) 整理）。
- 这是一个非官方的个人研究项目，与任天堂、Game Freak、The Pokémon Company 无关。仓库不包含、也不应上传任何游戏 ROM、存档或存档点。
