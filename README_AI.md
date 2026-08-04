# Minecraft AI Player — AI 持续开发档案

> 本文件面向接手项目的 AI Agent。开始工作前必须完整阅读本文件与 `README.md`。禁止在本文档、日志、Git 或模型上下文中写入真实密码、API Key、Microsoft Token。

## 0. 接手者 5 分钟启动清单

本节是压缩入口，不能代替阅读全文。

1. 当前主本地仓是 `D:\临时工程\minecraft aibot`；`D:\开发\minecraft aibot` 是需要同步的旧目录。不要误在旧目录启动第二套 WebUI/控制器/客户端。
2. 进入主仓后先执行 `git status --short --branch`、`git log -5 --oneline`、`git fetch origin`，再确认 `HEAD` 与 `origin/main`。本文更新前的已推送基线是 `01c62ac fix: bound model output to prevent chat timeouts`；以后以 Git 实际结果为准。
3. 依次阅读本文件、`README.md`、`PARAMETERS.md`。真实配置在 Git 忽略的 `config/*.json`、`.env`、`data/`、`.runtime/`，不能根据 example 猜测用户当前值，也不能在输出中打印它们。
4. 判断进程归属必须同时核对 PID、可执行文件、命令行入口和 `projectRoot`。不要只凭进程名停止 `node.exe`/`java.exe`，用户可能同时运行人类 Minecraft。
5. 当前生产链路是原生 Fabric 26.2 客户端 + 本机 TCP 桥 + Node 控制器；Mineflayer 仅为诊断备选。任何新能力优先扩展结构化状态和白名单动作，不要加入屏幕识别依赖。
6. 修改代码后至少运行 `npm run check`、`npm test`、`npm run build`；改 Fabric 时再运行 Gradle build；改安装/启动脚本时做对应真实入口回归。
7. 每次提交前同步更新 `README.md` 与本文件；参数或存储位置变化还要更新 `PARAMETERS.md`。检查秘密、占位域名、生成文件、无效字符和 `git diff --check` 后才可推送。
8. 推送主仓后，在旧目录确认干净，再用 `git pull --ff-only origin main` 同步。实际配置是忽略文件，必须单独按字段迁移，不能通过 Git 覆盖。

权威性顺序：运行源码/脚本与测试 > 当前本地忽略配置 > 本文件 > `README.md` > example。文档与源码冲突时，以源码为事实并在同一提交修正文档。

## 1. 不可遗忘的用户规则

用户已明确要求：

1. 目标是持续开发一个可实际游玩的 Minecraft AI 玩家，不是只写方案或文档。
2. 每一步开发必须同步维护两份 README：`README.md` 是人类安装、部署、使用、开发教程；本文件保存足以让新账号/Agent 无损续作的全部细节，包括 Git 推送。
3. 项目必须能在中国大陆正常网络下安装和运行；代理不能成为唯一方案。
4. 目标服务器 `你的域名.com:25565`，`server.properties` 已确认 `online-mode:false`。
5. 目标游戏是 Minecraft Java Edition `26.2`，Fabric Loader `0.19.3` 模组服，使用 EasyAuth。
6. DeepSeek 不是多模态模型，AI 根基必须是结构化世界状态、API/指令和动作接口，不能依赖视觉、听觉或模拟人类桌面操作。
7. Bot 运行时必须静默在后台。
8. 用户授权开发完成后先自行测试目标服务器；测试必须低风险，不聊天、不移动、不尝试密码时无需额外确认。
9. 必须提供简洁直观的图形总控页面，集中修改 Bot 可设置参数、查看状态和解释复杂功能；本项目选择仅本机 WebUI。
10. 当前开发机的目标服模组包位于 `D:\开发\进服必须mod`；必须支持未来新 mod 的受管理添加/升级。
11. 最终面向没有任何运行环境的纯净 Windows，优先提供一键安装程序，失败时提供人工教程。
12. 人类 README 必须说明各文件作用/原理，以及每个参数具体存储位置。
13. 当前电脑开启全局美国 VPN，任何本机下载成功都不得标记为“中国大陆无代理实测通过”。
14. 增加局域网兼容模式：同机/同 LAN 的人类玩家开放单人世界后，离线 Bot 自动发现动态端口并加入。
15. 离线皮肤必须考虑“其他玩家可见”；导入图片必须严格遵循 Minecraft PNG 格式，优先万用皮肤加载器，并明确 LocalSkin 的客户端分发条件。
16. 根目录必须有日常打开 WebUI、启动和停止 Bot 的快捷入口；WebUI 使用白、橙等暖柔配色。
17. 最后必须正式测试 AI 游戏行为、检查 Bug/无效字符，删除 API Key 后再推送 GitHub。
18. 必须维护独立 `PARAMETERS.md`，精确列出每个参数、本地路径、允许值、人设/提示词/记忆示例和自动写入机制。

任何代码、配置、依赖、部署、架构或测试变化没有同时反映到两份 README，就不能视为完成。

## 2. 仓库与 Git

- 主工作区：`D:\临时工程\minecraft aibot`
- 旧目录/同步副本：`D:\开发\minecraft aibot`
- 远端：`https://github.com/wraaaaaa/Minecraftaiplayer.git`
- 远端名/默认分支：`origin` / `main`
- 本文扩写前的 HEAD：`01c62ac fix: bound model output to prevent chat timeouts`（已在 `origin/main`）。
- 关键历史：`0bfab72` 插件称号聊天、`bfd40f7` 自动复活/BOM 状态、`80de913` 目录/PID 归属、`2ff69ad` 隐私占位域名、`75b25f1` LAN/皮肤/暖色 WebUI、`a965401` 总控与模组部署、`9f44535` 原生 Fabric 基础。
- 仓库级作者：`wraaaaaa <310438732+wraaaaaa@users.noreply.github.com>`（仅在本仓库配置过；不要擅改全局 Git 身份）。
- 主/旧目录在 `01c62ac` 时均为 `main` 且干净；主目录承担实际运行，旧目录仅同步源码。接手时仍必须重新检查，不能把此快照当实时状态。

安全推送流程：

```powershell
git status --short --branch
git pull --ff-only origin main
git diff --check
git diff
git add <本轮文件>
git commit -m "<准确消息>"
git push origin main
git status --short --branch
```

不要在存在不明用户改动时 pull/覆盖，不要 `reset --hard`、强推或改写历史。提交前必须确认两份 README、测试、秘密扫描和生成文件排除项。

## 3. 当前实现快照（2026-08-04 Asia/Shanghai）

项目已从文档阶段进入可运行 MVP。生产路线不是 Mineflayer，而是：

```text
Minecraft 26.2 Fabric 客户端（HeadlessMc/LWJGL 虚拟后端）
  └─ minecraft_ai_bridge Fabric 模组
       ↕ TCP JSON Lines v1，只允许 127.0.0.1，单客户端，单行上限 1 MiB
Node.js TypeScript AI 控制器
  ├─ LLM Provider
  ├─ Agent / Persona / World State
  ├─ Policy
  ├─ Memory / Experience
  └─ Runtime / JSONL Logger
       ↕ data/runtime-status.json
本机 WebUI 127.0.0.1:3210（设置、状态、启停、LAN、皮肤、提示词、记忆、模组、日志）
```

Fabric 桥是游戏里的结构化“传感器+执行器”：直接读取客户端对象状态，向 Node 发玩家聊天、系统消息、世界状态、受击者信息；Node 只发送白名单动作。大模型不看画面、不听声音、不直接发任意网络包或系统命令。

### 已实现

- 原生 MC 26.2/Fabric Loader 0.19.3/Fabric API 0.156.0+26.2 客户端模组，Java 25，Loom 1.17.17，Gradle 9.5.1。
- Fabric 内部自动连接 `MCAI_SERVER_HOST/MCAI_SERVER_PORT`（默认项目目标地址），每 600 tick 可重试。
- Node 本机桥、断线/超时/动作结果处理、重连循环。
- DeepSeek、火山方舟 OpenAI-compatible Chat Completions、OpenAI Responses 三类模型适配器。
- OpenAI GPT-5.6 官方核对（2026-08-04）：`gpt-5.6` 别名路由到旗舰 `gpt-5.6-sol`，另有 `gpt-5.6-terra` / `gpt-5.6-luna`；项目保留自由模型 ID 输入，不把所有角色强制改成 Sol。Responses 请求显式传 `reasoning.effort`，与现有适配器相容。来源：`https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6`。
- 推理强度 `none/low/medium/high/xhigh/max`；DeepSeek 显式映射到当前 `disabled/high/max`，发生降档时记录警告。
- 人设、多人 UUID 隔离记忆、单一记忆文件、独立经验文件、原子替换和 `.bak`。
- 聊天提及、冷却、主动聊天调度、结构化 JSON 决策解析和长度清洗。
- 动作：none、stop、chat、follow_player、come_to_player、look_at_player、wander、attack_player。策略层还理解但 Fabric 暂不执行 break_block/open_container，用于先拒绝危险动作。
- EasyAuth：进入世界后环境变量直发 `login <password>`，不是把命令交给 LLM；日志和系统消息脱敏。
- EasyAuth 已改为提示优先：识别 `/login` 或 `/register`；`registerIfNeeded` 控制首次注册，5 秒无提示才回退登录；两种命令及实际密码都脱敏。
- 受击 Mixin：只有真实 `Player` 造成伤害才发 `attacked_by_player`；Node 策略在 15 秒窗口内只允许攻击该人一次/受控反击。
- Windows 后台 Node、后台 Headless Minecraft、组合启停，PID 与可执行路径核验。
- 国内资源预取、哈希校验、隔离游戏目录和受管理服务器模组同步。当前外部包 24 个 jar，跳过旧 Fabric API 后导入 23 个，并生成 SHA-256 清单。
- Mineflayer 26.2 诊断适配和目标服探针，但不会用于正式模组连接。
- 本机 WebUI：全部配置表单、解释、运行/世界状态、启停、模组同步、日志、秘密状态和最小模型测试；只绑定 loopback，Host/Origin 校验，CSP，无外部 CDN。
- `runtime-status.json` 原子状态通道，Fabric 每秒世界快照供独立 WebUI 读取。
- 纯净 Windows 一键入口：winget 安装 Node LTS/JDK25→创建本地配置→Node/Fabric 构建→校验资源→Headless→模组→WebUI；支持手动跳过环境安装。
- LAN 兼容：`src/network/lan-discovery.ts` 监听 UDP 组播 `224.0.2.60:4445`，解析 `[MOTD]...[/MOTD][AD]port[/AD]`；`start-headless-client.ps1` 在 `connectionMode=lan` 时强制 offline 并把发现地址注入 Fabric。
- 皮肤：`src/skin/png.ts` 校验 PNG/IHDR 和 64x64/64x32；WebUI 导入到 `data/skins` 并同步 Bot LocalSkin；官方未修改的 CustomSkinLoader Universal 15.0.1（SHA-256 记录在 vendor README）进入实例。
- 多人皮肤：`build-skin-pack.ps1` 生成包含 loader 和 Bot 同名纹理的 zip。官方文档明确 LocalSkin 不会自动被其他人看见，因此所有观看者必须安装此包，或共同使用 LittleSkin/CustomSkinAPI 站点。
- 外置提示词：`config/prompts*.json` 实际参与每次模型请求；WebUI 可编辑。记忆/经验在 WebUI 只读查看和导出，避免误删。
- 日常入口：`Open-WebUI.cmd`、`Start-Bot.cmd`、`Stop-Bot.cmd`；页面已改暖色白/橙，仍无 CDN。
- `start-headless-client.ps1` 必须自行读取 `.env`：直接双击 Start-Bot 不经过 WebUI 进程，若只依赖父进程环境，Java EasyAuth 会拿不到密码。解析时不输出值，现有进程变量优先，并将 `easyAuth.passwordEnv` 映射到 Java 侧固定读取的 `MINECRAFT_LOGIN_PASSWORD`。
- 模型 Provider 缺 Key 时不能让整个控制器在启动阶段退出；`MissingKeyProvider` 允许 Bot/桥正常运行，只有实际 AI 请求才抛出明确缺变量错误。这样清理 Key 后仍能启动做联机诊断，也不会伪造模型回复。
- `start-headless-client.ps1` 的已有 PID 检查必须发生在 mod 同步之前。否则重复双击 Start-Bot 会尝试删除被运行中 Java 锁定的 jar，失败后组合脚本还会回滚停止 Node。已调整为幂等早退；这是 2026-08-04 根目录入口真实测试发现的回归。
- 组合启动只在“本轮新启动了 Node”且客户端失败时回滚 Node；若 Node 原本已运行（例如 LAN 尚未开放），不能误停现有控制器。
- 项目目录被复制/移动后，旧 WebUI 可能仍占用 3210，而复制来的 PID JSON 只凭“同一个 node/java 可执行文件”会误认旧进程属于新目录。所有后台 PID 记录现加入 `projectRoot`/入口标记，启停脚本核对进程命令行；WebUI 启动还核对端口所有者，禁止静默打开另一份项目。秘密和实际配置不会自动跨目录迁移。
- Windows PowerShell 5 的 `Set-Content -Encoding UTF8` 会给 PID JSON 写 BOM。原 WebUI `JSON.parse(readFile(...))` 因首字符 U+FEFF 抛错，`processStatus` 捕获后错误显示“已停止”，即使 PID 仍活着。统一 `parseJsonDocument` 先剥离 BOM，配置读取也复用；`test/json.test.ts` 固定回归。
- EasyAuth 的用户名规则是 `^[a-zA-Z0-9_]{3,16}$`。2026-08-04 搬迁诊断中，只读探针确认带 `-` 的名称被 `text.easyauth.disallowedUsername` 拒绝；配置后端、浏览器和测试现统一提前拦截。
- 死亡自动复活由 Fabric 客户端负责，不能依赖 LLM 看到死亡画面。`MinecraftAiBridgeClient.handleDeath` 检测 `isDeadOrDying/health<=0`，清空移动，默认 3 秒后调用与 26.2 原版 `DeathScreen` 相同的 `LocalPlayer.respawn()` 和 `client.gui.setScreen(null)`；未成功时每 100 tick 重试。`death`/`respawn_requested`/`respawned` 经桥写日志与记忆。`server.autoRespawn`、`respawnDelayMs` 均可在 WebUI 配置，旧 JSON 缺字段时默认 true/3000。
- 服务器称号/聊天插件把玩家消息通过 `ClientReceiveMessageEvents.GAME` 发送为 `<[称号]玩家名> 内容`，而不是签名 `CHAT`；此前 Node 只 debug 记录 `game_message`，AI 永远收不到。`chat-parser.ts` 现在只接受尖括号格式，循环剥离方括号前缀，最终名称必须匹配 Minecraft 规则；再复用 `#handlePlayerChat`。同玩家同正文 1500 ms 去重，防止 GAME/CHAT 双通道重复回复。不要放宽成任意系统文本解析。
- DeepSeek V4 思考模式必须限制生成预算。真实玩家消息曾连续两次在 60000ms 触发 `TimeoutError`，而同模型最小请求约 3.1 秒成功；完整项目提示词加 `max_tokens:4096` 后约 5.7 秒以 `stop` 正常返回。`model.maxOutputTokens` 默认 4096：Chat Completions 映射到 `max_tokens`，OpenAI Responses 映射到 `max_output_tokens`；`timeoutMs` 默认 120000。Agent 对 `TimeoutError` 使用专用游戏内提示，其他错误继续使用通用兜底。
- 独立 `PARAMETERS.md` 已覆盖秘密、服务器、LAN、EasyAuth、模型、推理、人设、提示词、记忆、经验、皮肤、模组、日志、PID 和 Git 位置。

### 尚未完成

- 已真实进入目标服务器世界并完成 EasyAuth 登录、模型最小调用、真人消息识别和游戏内失败兜底；输出预算修复后的真人正常回复/动作/记忆完整闭环仍需再做一次现场确认。
- 可靠寻路、避障、采集、挖掘、制作、放置、战斗循环和自主生存闭环。
- “荒无人烟选址”的世界扫描/领地判断；当前策略保守拒绝破坏，安全但不自主发展。
- 经验自动总结目前只有存储与提示检索基础，未形成完整任务结果→失败归因→复验闭环。
- Microsoft 正版认证自动化与正版披风设置；离线 PNG 皮肤/客户端包已实现，公共皮肤站上传需用户自己的站点账号。
- Simple Voice Chat 已兼容加载、加入服务器并发起 secret 请求，但 headless OpenAL 不可用，当前日志为 Speaker unavailable，未实现语音收发。
- Linux systemd/无界面启动脚本；核心可移植，现有运维脚本是 PowerShell/Windows。
- 用户在聊天中提供了一个余额有限的 DeepSeek Key，现由用户通过 WebUI 保存到 Git 忽略的 `.env` 并已完成真实模型测试。**不得在任何提交、命令记录、工具输出或本文复述其值**；因 Key 已出现在聊天，最终仍需提醒用户轮换。

## 4. 文件地图

### 根配置与运维

| 路径 | 作用 |
| --- | --- |
| `package.json` / `package-lock.json` | Node 22+，TS 构建、测试、探针、后台和客户端脚本 |
| `.npmrc` | `registry=https://registry.npmmirror.com` |
| `.env.example` | 秘密变量模板；代码会加载被忽略的 `.env`，但不覆盖进程环境已有变量 |
| `.gitignore` | 排除 node_modules、dist、data、logs、本地配置、Fabric 构建缓存、`.runtime`、HeadlessMC 临时目录 |
| `Install-and-Open-Control-Center.cmd` | 纯净 Windows 双击入口 |
| `Open-WebUI.cmd` / `Start-Bot.cmd` / `Stop-Bot.cmd` | 日常打开总控台、静默启停 |
| `config/bot.example.json` | 服务器、桥、EasyAuth、模型、聊天、存储、日志完整示例 |
| `config/persona.example.json` | 默认人设；本地复制为被忽略的 `persona.json` |
| `config/mods.example.json` | 模组来源、启动同步和排除正则模板；实际 `mods.json` 被忽略 |
| `config/prompts.example.json` | 完整系统、能力、记忆、动作契约和空闲提示词；实际 `prompts.json` 被忽略 |
| `config/memory.example.json` / `experience.example.json` | 不参与运行的完整持久化格式示例 |
| `config/skin.example.json` | 皮肤模型、本地路径、多人可见模式和在线站点模板 |
| `config/behavior-rules.json` | 版本化行为准则，当前允许受控自卫、拒绝财产破坏 |
| `scripts/start-background.ps1` / `stop-background.ps1` | 隐藏 Node 控制器与精确 PID 停止 |
| `scripts/start-headless-client.ps1` / `stop-headless-client.ps1` | 隐藏 HeadlessMc 父进程及其项目子进程 |
| `scripts/start-all-background.ps1` / `stop-all-background.ps1` | 组合启停；客户端启动失败时回滚控制器 |
| `scripts/start-webui-background.ps1` / `stop-webui-background.ps1` / `open-control-center.ps1` | 本机总控台隐藏启停与打开浏览器 |
| `scripts/install-windows.ps1` | winget 环境安装与完整部署；`-SkipEnvironmentInstall` 手动环境回退，`-NoOpen` 自动测试用 |
| `scripts/sync-client-mods.mjs` | 受管理 mod 替换、SHA-256 清单；跳过 Fabric API/桥重复项 |
| `scripts/build-skin-pack.ps1` | 在验证过的 `.runtime/skin-pack` 下生成供其他玩家使用的 zip |
| `vendor/custom-skin-loader/*` | 官方未修改 Universal 15.0.1 二进制、上游/许可/哈希归属 |

### Node 控制器

| 路径 | 作用 |
| --- | --- |
| `src/config/*` | 类型与严格配置加载、相对路径解析、环境变量读取 |
| `src/core/atomic-json-file.ts` | 临时文件→备份→原子替换的 JSON 持久化 |
| `src/core/json.ts` | 统一剥离 U+FEFF BOM 后解析 JSON，供配置/WebUI/PID读取 |
| `src/core/logger.ts` | JSONL 文件日志，默认不输出控制台，递归秘密脱敏 |
| `src/llm/*` | 三供应商统一 `complete()` 边界、超时、响应解析 |
| `src/agent/prompt.ts` | 明确告知模型只能使用结构化状态、不能声称视听觉；注入人设/记忆/经验/规则 |
| `src/agent/decision.ts` | 从纯 JSON 或 fenced JSON 提取白名单决策 |
| `src/agent/agent-controller.ts` | 玩家消息→上下文→LLM→策略→回复/动作/记忆 |
| `src/agent/world-state.ts` | 统一位置、生命、饥饿、背包、附近玩家等状态 |
| `src/memory/memory-store.ts` | 单文件 schema、UUID 玩家档案、名称更新、事件上限 |
| `src/experience/experience-store.ts` | 独立经验文件、去重/检索基础 |
| `src/policy/policy-engine.ts` | 财产保护、自卫窗口、攻击者匹配、动作拒绝理由 |
| `src/minecraft/chat-parser.ts` | 严格解析插件 `<[称号]玩家名> 正文`，剥离多个方括号前缀并校验游戏名 |
| `src/minecraft/fabric-bridge-client.ts` | 本机 TCP server、JSONL 协议、事件与 action_result 关联 |
| `src/minecraft/minecraft-client.ts` | Mineflayer 备选诊断适配器，pathfinder 加载与基础动作 |
| `src/minecraft/easy-auth.ts` | Mineflayer 路线 EasyAuth 辅助；Fabric 路线在模组中执行 |
| `src/network/lan-discovery.ts` | UDP 组播监听、MOTD/动态端口解析和 CLI JSON 输出 |
| `src/skin/png.ts` | PNG签名/IHDR读取、64×64/64×32校验和 data URL 解码 |
| `src/runtime/bot-runtime.ts` | 选择适配器、生命周期、关闭后重连 |
| `src/runtime/status-store.ts` | 原子写 `data/runtime-status.json` 供独立 WebUI 显示世界状态 |
| `src/webui/server.ts` | loopback HTTP/API、设置校验、秘密写入、启停、同步、模型最小测试 |
| `src/index.ts` | 信号处理与主入口 |
| `src/probe.ts` | 不发聊天/动作的只读连接探针 |
| `public/webui/index.html` / `styles.css` / `app.js` | 无外部依赖的图形总控台、响应式布局与表单交互 |

### Fabric 桥

| 路径 | 作用 |
| --- | --- |
| `fabric-bridge/gradle.properties` | 固定 MC/Fabric/API/Java/模组版本 |
| `fabric-bridge/build.gradle` | Loom 客户端构建和 Maven 国内回退 |
| `MinecraftAiBridgeClient.java` | 自动连服、事件采集、EasyAuth、动作执行、状态快照 |
| `BridgeConnection.java` | 仅 `127.0.0.1:8765` 的 JSON Lines 客户端、重连、队列 |
| `LivingEntityDamageMixin.java` | 捕获本地玩家被真实玩家伤害事件 |
| `fabric.mod.json` / mixin JSON | 客户端模组元数据和注入声明 |

### 资源与测试

| 路径 | 作用 |
| --- | --- |
| `scripts/apply-minecraft-data-26.2.mjs` | postinstall 将 vendored 26.2 协议注册进已安装 Prismarine 依赖，幂等 |
| `vendor/minecraft-data/26.2/*` | 固定上游提交的协议和版本 JSON，不含可执行代码 |
| `scripts/prefetch-minecraft-libraries.mjs` | 读 BMCLAPI 26.2 元数据，按当前 OS 规则下载客户端及 88 个库/原生包，逐项官方 SHA-1 验证 |
| `scripts/install-headlessmc.ps1` | 下载固定 HeadlessMc 2.10.0 并校验 SHA-256 |
| `scripts/prepare-fabric-client.ps1` | 复制桥、下载固定 Fabric API、合并额外模组到隔离实例 |
| `.runtime/minecraft/managed-mods.json` | 忽略的运行清单：来源、同步时间、23 个文件的大小/SHA-256 |
| `test/*.test.ts` | 决策、记忆、经验、策略、日志脱敏、桥协议回环测试 |

运行时生成内容均被忽略：`data/`、`logs/`、`dist/`、`.runtime/`、`HeadlessMC/`、Fabric `build/.gradle/run`。

## 5. 配置与秘密契约

生产配置 `config/bot.json`、`persona.json`、`prompts.json`、`mods.json`、`skin.json` 被 Git 忽略。安装器/WebUI 可从 example 创建它们，但生产控制器缺 `bot.json` 会拒绝启动；persona/prompts 缺失才自动退回 example。`behavior-rules.json` 是跟踪文件并直接参与运行。完整用户向参数解释在 `PARAMETERS.md`，以下记录实现级默认值和边界。

| 分组 | 默认/允许值 | 实现注意 |
| --- | --- | --- |
| `server.adapter` | `fabric_bridge`; 另有 `mineflayer` | 目标模组服只能用 Fabric；启动原生客户端时会拒绝其他值 |
| `server.connectionMode` | `direct` / `lan` | LAN 只在启动脚本解析；强制 `auth:offline` 并以 UDP 发现结果覆盖目标 |
| `host/port/version` | 占位域名/25565/26.2 | host 非空、port 仅校验正整数；不要把真实域名提交，生产值在忽略文件 |
| `username` | `CialloAI` | 必须 `^[A-Za-z0-9_]{3,16}$`；影响离线 UUID、EasyAuth 与 LocalSkin 文件名 |
| `auth` | `offline` / `microsoft` | 原生 Headless 启动只实现 offline；配置 microsoft 会提前失败 |
| `connectTimeoutMs/reconnectDelayMs` | 30000 / 10000 | 前者等 Java hello，后者控制 Node 重建适配器间隔；当前 validator 未限制这两项 |
| `autoRespawn/respawnDelayMs` | true / 3000 | 旧配置缺字段仍使用 true/3000；delay 限 0–60000ms |
| `bridgeHost/bridgePort/actionTimeoutMs` | loopback/8765/10000 | WebUI额外强制 loopback；端口/动作超时需正整数；当前启动脚本未把非默认 bridgeHost/Port导出给 Java，实际应保持默认 |
| `easyAuth.enabled/registerIfNeeded` | true / true | 注册只响应明确 `/register` 提示；密码为空时不发命令 |
| `easyAuth.passwordEnv/loginDelayMs` | `MINECRAFT_LOGIN_PASSWORD` / 1500 | loginDelay 目前仅 Mineflayer 辅助使用；Fabric 回退固定 100 tick≈5秒 |
| `model.provider/model` | deepseek/v4-flash | provider 类型声明为 deepseek/volcengine/openai，但 validator 目前只检查非空，工厂未知值会落入 Chat Completions 路线 |
| `apiKeyEnv/baseUrl` | provider 对应变量/官方根地址 | 只做非空校验，不验证 URL scheme；端点路径由 Provider 追加 |
| `reasoningEffort` | none/low/medium/high/xhigh/max | DeepSeek 发生映射时日志记录 requested/effective |
| `timeoutMs/maxOutputTokens` | 120000 / 4096 | 分别限制 1000–600000 和 128–131072；旧配置缺输出预算时 Provider 使用 4096 |
| `chat.requireMention/replyPrefix/cooldownMs` | true/空/2500 | cooldown 当前未做数值校验；`!` 开头绕过 mention 要求 |
| `proactiveEnabled/Idle/MinInterval` | true/180000/300000 | 15秒轮询，两个时间阈值当前未做 schema 数值校验 |
| `storage.memoryFile/experienceFile/maxEvents` | `data/*.json` / 5000 | 两文件不能指向同一路径；WebUI限制在 data，CLI loader只按 path.resolve，不限制根目录 |
| `policyFile/personaFile/promptsFile` | `config/*.json` | WebUI限制在 config；CLI loader对 policy 不提供 example 回退 |
| `logging.file/level/console` | `logs/bot.log` / info / false | 静默后台必须保持 console false；WebUI限制日志路径在 logs |

其他 JSON：`persona` 提供 name/description/speakingStyle/goals/boundaries；`prompts` 提供 identity/capabilityRules/memoryRules/actionContract/proactiveInstruction；`mods` 提供 sourceDirectory/syncOnClientStart/excludeFilePatterns；`skin` 提供 enabled/model/visibilityMode/skinFile/capeFile/onlineProvider；行为规则 schema 当前必须 version 1。WebUI 会做数组、路径和枚举补充校验，直接手改文件则只有控制器实际读取到的部分会被校验。

秘密：

- `MINECRAFT_LOGIN_PASSWORD`
- `DEEPSEEK_API_KEY`
- `ARK_API_KEY`
- `OPENAI_API_KEY`

用户/运维覆盖：`BOT_CONFIG`（仅 Node 配置入口）、`MCAI_MINECRAFT_HOME`、`MCAI_MINECRAFT_VERSION`、`MCAI_MINECRAFT_LIBRARY_MIRROR`、`MCAI_BMCLAPI_BASE`、`MCAI_HEADLESSMC_DOWNLOAD_URL`、`MCAI_FABRIC_API_URL`、`MCAI_JAVA_HOME`、`MCAI_MODS_SOURCE`、`MCAI_WEBUI_PORT`。启动脚本内部再向 Java 设置 `MCAI_SERVER_HOST/PORT`、`MCAI_EASYAUTH_ENABLED`、`MCAI_EASYAUTH_REGISTER_IF_NEEDED`、`MCAI_AUTO_RESPAWN_ENABLED`、`MCAI_RESPAWN_DELAY_MS`；桥读取 `MCAI_BRIDGE_HOST/PORT`。危险调试变量 `MCAI_ALLOW_REMOTE_BRIDGE` 不应在生产使用。

绝对禁止把登录命令原文交给 LLM。Fabric `GAME` 消息会正则替换 `/login` 和 `/register` 参数，并再次替换实际密码。Logger 也递归脱敏典型 key/authorization/password/token 值。WebUI `GET` 只返回秘密是否存在；`PUT /api/secrets` 可写 `.env` 但响应不含值，运行中更新同时替换 WebUI 进程环境。

## 6. 运行时生命周期与端到端时序

### 控制器启动、断线与热加载边界

`src/index.ts` 只做三件事：`loadProjectConfig()`、创建 `BotRuntime`、在 `SIGINT/SIGTERM` 调用 `stop()`。生产启动要求 `config/bot.json` 存在；只有 `probe.ts` 显式允许退回 `bot.example.json`。人设和提示词文件缺失时会分别退回 example，行为规则文件不会退回。

`BotRuntime.run()` 的实际顺序：

1. 加载 `.env`，但已有进程环境变量优先；读取/校验 bot config、人设、提示词、规则和当前模型 Key。
2. 创建一个长期复用的 `MemoryStore`、`ExperienceStore`、`RuntimeStatusStore` 和 LLM Provider，并先加载其文件。
3. 写状态 `starting`，进入重连循环；每轮新建 `PolicyEngine`、Minecraft 适配器与 `AgentController`。
4. 写 `waiting_for_client`；Fabric 路线在 `bridgeHost:bridgePort` 监听，等 Java 桥发 `hello`。连接后等待断开；失败/断开时关闭 socket/server，等待 `reconnectDelayMs` 再创建下一轮。
5. 收到停止信号后关闭当前适配器，写 `stopped`，等待日志写链 flush。

配置、Provider、记忆路径和提示词都不是热加载。WebUI 保存只修改磁盘；已运行控制器仍持有启动时对象。WebUI 更新 Key 只更新 WebUI 自身环境与 `.env`，不会注入已运行的 Node 控制器或 Java 子进程。因此任何模型、服务器、人设、提示词、规则、存储或秘密变更后都应完整“重新启动 Bot”。

### 真人消息处理时序

```text
Fabric CHAT 或经过严格解析的 GAME 消息
  → 忽略 Bot 自己的名字
  → 同玩家+同正文 1500ms 双通道去重
  → requireMention / ! / Bot 名称判定
  → 未被点名：只写该玩家旁听事件，不调用模型
  → 被点名：移除 Bot 名称并进入 AgentController
      → 按 UUID（无 UUID 时按小写名）做 cooldown
      → 先持久化 player_message
      → 读取该玩家档案 + 最近 12 条相关/全局事件 + 全局摘要
      → ExperienceStore 词法检索最多 8 条经验
      → 组装 system/user JSON，调用一次模型
      → 解析/清洗 JSON 决策
      → 可选 remember 过滤敏感词后写玩家 facts
      → PolicyEngine 授权
      → Fabric 白名单动作，等待相同 id 的 action_result
      → 动作失败时追加一条 failure experience
      → 发送 reply 并写 bot_reply
      → 写不含正文的处理结果日志
```

冷却键优先 UUID，否则小写名字；时间戳在调用模型前写入。单个玩家在冷却内的新消息会直接忽略且不写事件。当前没有每玩家请求队列、取消旧请求或全局并发限制：不同玩家或冷却后的同一玩家可以产生并发模型请求。`AtomicJsonFile` 串行化实际写入，但多个异步 mutator 共享缓存对象；扩展高并发前应补消息队列和并发测试。

模型/API/JSON/回复动作任一步抛错都会进入 catch。`TimeoutError` 回复“我这次思考超时了，请再说一次。”，其他错误回复通用失败句；这两种兜底当前不写 `bot_reply` 记忆。动作返回 `ok:false` 不抛错，而是记录经验后仍发送模型回复。

### 主动空闲行为

Java 每秒发送世界状态；Node 每 15 秒调用一次 `proactiveTick()` 作为调度探针。只有 `chat.proactiveEnabled=true`、已进世界、距离最后一条被处理入站消息超过 `proactiveIdleMs`、距离上次主动尝试超过 `proactiveMinIntervalMs` 时才调用模型。主动模式即使模型返回其他动作，也只保留 `wander`/`none`；主动回复写成全局 `game_event`。`behavior-rules.json` 的 `proactiveChat.*` 当前尚未接入这段逻辑，真正开关是 `config/bot.json` 的 `chat.proactiveEnabled`。

## 7. Fabric 本机桥协议 v1

### 传输与边界

- Node 是 TCP server，Java 是 client；默认 `127.0.0.1:8765`，UTF-8、每行一个 JSON、换行分帧、`TCP_NODELAY`。
- Node 和 Java 都拒绝超过 1,000,000 字符/字节量级的单行；Node 累积 buffer 超过 1,000,000 字符会断开。只允许一个活动 Java socket。
- Java 连接失败后每 2 秒重试；socket read timeout 250ms，用于刷新发件队列和响应关闭。Java outgoing 队列最多 1000 条，超出时新事件会被静默丢弃；incoming 为无显式上限的并发队列，由每 tick 消费。
- `MCAI_ALLOW_REMOTE_BRIDGE=true` 可绕过 Java 回环检查，但 Node 端仍拒绝非 loopback；生产脚本从不设置它。不要为了远程控制而放宽两侧检查。
- Node 发动作时生成 UUID `id`，以 `actionTimeoutMs` 建 pending；断线/关闭会将全部 pending 解析为失败，不会永久悬挂。

Java → Node 消息：

| `type` | 关键字段 | 产生时机/Node 行为 |
| --- | --- | --- |
| `hello` | `protocolVersion:1`, `adapter:"fabric-26.2"` | TCP 建立后第一条；版本不等于 1 立即断开 |
| `joined_world` | `name`, `uuid`, `at` | 本地玩家 UUID 形成新会话；状态进入 `in_world` |
| `state` | `connected`, `position{x,y,z}`, `health`, `food`, `dimension`, `timeOfDay`, `inventory[]`, `nearbyPlayers[]` | 每 20 tick；背包只发非装备物品，附近玩家限 32 格 |
| `player_chat` | `name`, `uuid`, `message` | Fabric 签名聊天事件 |
| `game_message` | `message`, `overlay` | 系统/GAME 通道；EasyAuth先在 Java 内处理，正文脱敏后才发 Node；Node 仅把严格 `<称号+用户名> 正文` 解析为玩家聊天 |
| `attacked_by_player` | `name`, `uuid` | Mixin 确认本地玩家被真实玩家造成伤害；Node 只登记自卫窗口并写记忆，不会自动触发反击 |
| `death` | `health` | 首次检测死亡；停止移动并进入复活逻辑 |
| `respawn_requested` | `delayTicks` | 调用 `LocalPlayer.respawn()` 并清死亡界面后 |
| `respawned` | `health` | 后续 tick 检测恢复存活 |
| `action_result` | `id`, `ok`, `detail` | 执行动作后与 Node pending 关联 |

Node → Java 只有一种 envelope：

```json
{"type":"action","id":"UUID","action":{"type":"look_at_player","target":"玩家名"}}
```

Fabric 动作语义：

| 动作 | 当前实现 | 重要限制 |
| --- | --- | --- |
| `none` | 立即成功 | 无副作用 |
| `stop` | 清 movement 与前后左右/跳跃/冲刺按键 | 只停止本桥设置的移动 |
| `chat` | 普通内容 `sendChat`；以 `/` 开头则 `sendCommand` | Node 入口清除换行并限 240 字符；LLM action contract不直接开放 chat，回复走独立 `chat()` |
| `look_at_player` | 按名字查 32格/客户端已加载玩家并设置 yaw/pitch | 无目标则失败 |
| `follow_player` | 每 tick 刷新玩家坐标，前进、>6格冲刺、水平碰撞时跳跃，2格停止但保持跟随 | 不是寻路器，不识别悬崖、岩浆、复杂障碍或领地 |
| `come_to_player` | 移动期间每 tick 刷新目标玩家坐标，到 2格内后清除任务 | 同样只是直线按键移动；与 follow 的差别是首次到达后不继续保持跟随 |
| `wander` | 随机角度直线移动 | Decision 层允许 2–16，Fabric 再夹到 2–8；不做环境安全扫描 |
| `attack_player` | gameMode 单次攻击 + 主手挥动 | Policy 必须先授权；受击事件本身不会自动调用此动作 |
| `break_block` / `open_container` | Java default 返回不支持 | 仅保留在 Decision/Policy schema 用于安全拒绝，不能宣称已实现 |

Fabric 自动连服在客户端无 player/level、tick≥40 且距上次尝试至少 600 tick 时调用 `ConnectScreen.startConnecting`；约 2 秒后首次尝试，之后约 30 秒重试。状态上报约每秒一次。自动复活延迟从毫秒除以 50 转 tick，限制 0–1200 tick；未恢复时每 100 tick（5 秒）再次请求。

## 8. 模型、提示词、决策与策略契约

### Provider 请求映射

| provider | 路径 | 结构化输出 | 推理参数 | 输出预算 |
| --- | --- | --- | --- | --- |
| `deepseek` | `{baseUrl}/chat/completions` | `response_format:{type:"json_object"}`, `stream:false` | `none`→`thinking.disabled`；low/medium/high→`thinking.enabled + reasoning_effort:high`；xhigh/max→`max` | `max_tokens` |
| `volcengine` | `{baseUrl}/chat/completions` | 同上 | 原样 `reasoning_effort`；具体端点是否支持由用户账号决定 | `max_tokens` |
| `openai` | `{baseUrl}/responses` | 输入为 system/user，`text.verbosity:"low"` | `reasoning:{effort}` 原样传递 | `max_output_tokens` |

所有请求使用 Bearer、JSON、`AbortSignal.timeout(timeoutMs)`，先把完整响应读为文本；非 2xx 错误只保留前 500 字符进入异常。当前没有 HTTP 重试、指数退避、429 专用处理、流式输出、token 用量持久化或供应商健康熔断。缺 Key 时 `MissingKeyProvider` 允许 Bot 正常进服，但第一次 AI 请求明确失败。

System prompt 依次拼接：替换人设变量后的 `identity`、`capabilityRules[]`、`memoryRules[]`、`actionContract`。真人 user payload 是单行 JSON：`currentPlayer`、`playerMessage`、最多 12 条 `recentRelevantEvents`、`globalSummary`、最多 8 条 `relevantExperience`、`structuredGameState`。模型看不到其他玩家的专属 facts，但无 `playerKey` 的全局事件会进入所有人的最近上下文。

Decision parser 接受纯 JSON、Markdown JSON fence，或从第一 `{` 到最后 `}` 的对象。`reply`/`remember` 会去换行、trim、截到 240 字符。未知动作或缺少 target 降级 `none`；wander 默认 6 并夹到 2–16。`remember` 还会拒绝包含 password/密码/api key/token/令牌/地址的内容，但这只是补充过滤，不是通用 DLP。

默认 prompt 的允许动作目前只列 `none/stop/follow_player/come_to_player/look_at_player/wander`，没有 `attack_player`。因此“Policy 支持受控自卫”不等于“Bot 会自动反击”：当前 Mixin 只登记攻击者，且没有事件直接触发 Agent。要完成真正自动自卫，需要新增受击事件控制流程、威胁停止条件和测试，不能只把 `attack_player` 加进提示词。

Policy 当前实际读取的规则只有：`allowSelfDefense`、`allowPlayerOrderedPvp`、`selfDefenseWindowMs`、`denyBreakingPlayerProperty`、`denyOpeningPlayerContainers`、`allowDestructiveActionsWhenOwnershipUnknown`。`denyTakingPlayerItems`、`wildernessDevelopmentOnly`、`stopSelfDefenseWhenThreatEnds`、`proactiveChat.*` 目前尚未接入执行分支；它们是未来约束声明，不得标记为已执行。

## 9. 记忆、经验、状态与日志持久化

### 原子 JSON 规则

`AtomicJsonFile<T>` 首次缺文件时创建默认文档；同一实例缓存对象并用 Promise write chain 串行写入。每次保存先写 `<file>.<pid>.tmp`，尝试把旧文件复制为 `<file>.bak`，再 rename；Windows rename 失败时删除目标后重命名临时文件。`.bak` 是上一版本，不会多代轮转。读取到损坏 JSON 会抛错，不会自动用 `.bak` 覆盖；恢复必须先停止 Bot、备份损坏文件、人工校验 `.bak` 后再替换。

| 文件 | schema/写入者 | 核心语义 |
| --- | --- | --- |
| `data/memory.json` | schemaVersion 1 / `MemoryStore` | 唯一长期记忆；Bot 名、玩家表、事件、全局摘要 |
| `data/experience.json` | schemaVersion 1 / `ExperienceStore` | 行为失败经验；任务、上下文、结果、lesson、correction、tags |
| `data/runtime-status.json` | schemaVersion 1 / `RuntimeStatusStore` | `starting/waiting_for_client/connected/in_world/disconnected/stopped` 与最后世界快照 |
| `logs/bot.log` | JSON Lines / `Logger` | ISO 时间、level、message、递归脱敏 data；写失败被吞掉以避免拖垮 Bot |
| `logs/webui-model-test.log` | JSON Lines / WebUI 模型测试 | 只记录测试错误，默认 error 级别 |
| `data/*.pid.json` | PowerShell 启动脚本 | PID、executable、projectRoot、入口/运行目录、startedAt；不是业务状态 |

玩家 key：优先 `uuid:<lowercase uuid>`，缺 UUID 时 `name:<lowercase name>`。已知同 UUID 改名会更新 `currentName` 并追加 `knownNames`；先以 name 建档、后来获得 UUID时当前没有自动合并，可能形成两个档案。`facts` 去重是精确字符串匹配。`events` 只保留最后 `maxEvents` 条；删旧事件不删玩家 facts。

`conversationSummary` 与 `globalSummary` 当前不会自动生成或定时改写；example 中的内容只是格式说明。长期 facts 仅来自模型 `remember`。WebUI 对 memory/experience 只读展示和下载，没有编辑 API，避免运行时与缓存对象冲突。人工恢复/迁移必须停 Bot 后复制 `memory.json`、`experience.json` 及需要的 `.bak`，再启动验证 schema 与玩家数。

Experience 只在“模型给出非 none 动作且执行返回 `ok:false`”时自动追加 failure；API 超时、无效 JSON、通用异常不会写经验。检索按消息分词和 tags/task/lesson 子串打分，最多 8 条；`timesApplied` 当前不递增，`verified` 始终初始 false，成功/partial 自动总结尚未实现。

## 10. WebUI API、安全模型与文件写入

WebUI 是独立 Node 进程，只绑定 `127.0.0.1`，默认端口 3210。所有请求要求 Host 为 loopback；有 Origin 时必须精确匹配本机端口。响应包含 CSP、`nosniff`、`no-store`，静态文件做路径归一化并限制在 `public/webui`。它没有登录认证，安全前提就是“不暴露到 LAN/公网”。

| 方法与路径 | 作用/副作用 |
| --- | --- |
| `GET /api/snapshot` | 聚合设置、persona、prompts、skin、rules、mods、manifest、live status、memory、experience、bot/client PID 状态、秘密布尔状态和两份日志尾 30 行 |
| `PUT /api/settings` | 校验并原子临时重命名写入 bot/persona/prompts/skin/rules/mods 六个 JSON；路径限制在 config/data/logs 对应根 |
| `PUT /api/secrets` / `DELETE /api/secrets` | 更新或清空四项 `.env` 秘密；空字符串表示保持原值，null 表示删除；响应只返回布尔状态 |
| `POST /api/model/test` | 用当前 Provider 发最小 JSON 请求，真实消耗少量额度；不测试完整 Agent prompt |
| `POST /api/runtime/start|stop|restart` | 隐藏调用组合 PowerShell 脚本；每个脚本调用上限 5 分钟 |
| `POST /api/lan/discover` | 按配置超时监听原版 UDP 广播，不改配置 |
| `POST /api/mods/sync` | 运行受管理模组同步并返回新 snapshot |
| `POST /api/skin/import` | 接收 data URL、验证 PNG 后写 `data/skins` 并更新配置 |
| `GET /api/skin/image` | 返回当前导入皮肤；无外部 URL |
| `POST /api/skin/pack` | 运行 PowerShell 生成给其他玩家的 zip |
| `GET /api/memory/download` / `experience/download` | 只允许 config 指向 `data/` 内且内容是有效 JSON，下载时 no-store |

请求体常量实际是 2 MiB；当前错误文案仍写“1 MiB”，是已知文案不一致。`PUT /api/settings` 不会自动重启 Bot。Snapshot 的 `runtime.bot/client.running` 只根据 PID 文件 `projectRoot` 与 `process.kill(pid,0)` 判断；最终故障诊断还应对照命令行和运行日志。

## 11. Windows 进程、部署、迁移与恢复契约

### 三类后台进程

- AI 控制器：`data/bot.pid.json`，入口必须包含当前根目录的 `dist/src/index.js`。
- HeadlessMc 父进程/游戏子进程：`data/minecraft-client.pid.json`，记录固定 launcher jar 和 gameDirectory；停止脚本通过 CIM 追踪当前项目子进程后再结束父进程。
- WebUI：`data/webui.pid.json`，入口必须包含当前根目录的 `dist/src/webui/server.js`；启动前还核对监听端口所有者，避免打开旧目录服务。

停止脚本拒绝 executable、命令行入口或项目根不匹配的 PID。不要删除 PID 文件后按进程名强杀；先读 PID、CIM command line、端口所有者。`Start-Bot.cmd` 的组合启动先启动控制器再启动客户端；只有本轮新启动控制器且客户端失败时才回滚它。已运行实例重复启动应幂等返回。

纯净 Windows 安装器顺序：检查 Windows→可选 winget 安装 Node LTS/JDK25→确认 Node≥22/Java25→从 example 创建本地忽略配置→可选写 mod 来源→`npm install/check/build`→预取并哈希验证 MC 资源→Gradle build→固定哈希 HeadlessMc→准备隔离客户端和 mod→启动 WebUI。安装器不会填写真实 Key/密码，也不会自动启动 Bot。

项目迁移不能只复制 Git 跟踪文件。停掉源目录进程后，至少复制并核验：`config/bot.json`、`persona.json`、`prompts.json`、`mods.json`、`skin.json`、`.env`、`data/memory.json`、`data/experience.json`、皮肤/披风数据；`.runtime` 可重新构建，日志/PID 不应直接作为新目录运行依据。复制来的 PID 文件会因 `projectRoot` 不匹配而显示停止，应该删除陈旧 PID 后从新目录启动。

灾难恢复顺序：保留 memory/experience 与 `.bak`→从 GitHub 克隆→运行安装器或人工构建→恢复忽略配置与数据（先不恢复 PID/logs）→WebUI最小模型测试→同步 mod→启动 Bot→确认 `waiting_for_client`→`connected`→`in_world`→验证 EasyAuth→只读聊天。若 Bot 误删但记忆文件存在，玩家 key/facts/events 均可恢复；若只剩 `.bak`，会损失最后一次成功保存之后的数据。

## 12. 关键技术决策与研究结果

### ADR-001：双 README 和中国网络是完成条件

用户永久规则。任何后续 Agent 都必须在每次代码变更时同时更新人类教程与本文件；中国可用路线必须实际保留，不得换成只能直连 GitHub/Mojang/npmjs 的单一路线。

### ADR-002：正式客户端采用原生 Fabric，不采用 Mineflayer

Mineflayer npm 栈公开高层数据仍主要到 1.21.11。本项目 vendored 上游 PR 里的 26.2 协议数据后，探针能够握手目标服务器，但被要求 Fabric 注册表同步。即使协议层登录成功，也无法表达目标服务器的模组注册表，因此原生 Fabric 是正确路线。

vendored 数据：

- 来源 `PrismarineJS/minecraft-data` PR 1198，固定提交 `e4920932925f159c0c62b54b5cf07155669064e5`。
- `protocol.json` SHA-256 `E5D14CB4F9C8B027AA6792804680020BE1CB5A24DD42DC553711E28A84A1A986`。
- `version.json` SHA-256 `E4A731EFDC228A6DAFD61EB842E8EB76F9D6B766979254D743E161B86D7C1D0C`。
- 安全审查：采用的提交部分是声明式 JSON/YAML；明确没有采用同一实验工作中会打印完整 packet buffer、动态重写依赖源码的 ProtoDef 临时补丁。
- postinstall 暂将 26.2 高层方块/物品映射到 1.21.11，physics/chunk 映射到已有 26.1 实现，仅用于诊断，不可宣称完全支持。

### ADR-003：HeadlessMc 2.10.0 + Fabric bridge

HeadlessMc 2.10.0 的发行说明包含 Minecraft 26.2 headless 修复。固定 jar SHA-256：

`52BD5006F478377B3893011D458562977D38C65EAD6D2B31089BEB4D614F13CD`

GitHub 直链在当前中国网络过慢，`https://gh-proxy.com/<official URL>` 实测约 56 秒成功，脚本随后核对官方哈希；失败再尝试官方直链。不要放宽哈希校验。

MC 26.2 客户端实际日志写明旧 `--server/--port` 参数 `Completely ignored arguments`。因此不能依赖 HeadlessMc gameargs；已在 Fabric mod tick 中调用 `ConnectScreen.startConnecting(...)` 主动进服。这是 26.2 兼容的关键实现。

### ADR-004：结构化非多模态智能体

Prompt 明确模型没有视觉/听觉，只能根据 JSON 世界状态判断。Fabric 直接读取客户端内部状态，动作由枚举 schema 约束。未来加语音只能作为独立输入/输出模块，不能改变游戏控制根基。

### ADR-005：记忆与经验可移植

`memory.json` 是唯一长期记忆文件，包含 schemaVersion、Bot 信息、按 UUID 的玩家、事件、元数据；`experience.json` 独立保存经验。写入使用同目录临时文件和 `.bak`，从而支持重启/重装/迁移。未来 schema 变化必须写 migration，不能静默丢字段。

### ADR-006：安全策略优先于能力

模型决策必须过 PolicyEngine。无法确认物品归属时拒绝破坏；玩家命令也不能绕过禁止 PVP。受击事件来自客户端 Mixin 而不是 LLM 猜测，攻击者姓名必须匹配，窗口过期后拒绝。完整领地/建筑识别前不要实现随意挖掘。

### ADR-007：管理面采用仅本机、无外部前端依赖的 WebUI

绑定 `127.0.0.1:3210`，不用云端托管、不向 LAN 暴露。原因：页面含启停和秘密写入能力，远程发布会扩大攻击面；纯 HTML/CSS/JS 不需 CDN，符合中国网络和一键部署。API 验证 Host/Origin、CSP、路径范围、2 MiB body（容纳 1 MiB PNG 的 base64）；所有配置保存前走后端 schema，Fabric bridge 仍只允许 loopback。

### ADR-008：外部服务器模组采用清单式同步

直接重复复制会同时留下新旧 jar 或两个 Fabric API，Fabric Loader 会因重复 mod ID 失败。`sync-client-mods.mjs` 只删除上一份 manifest 声明的受管理文件，再复制当前来源并 SHA-256；排除固定 Fabric API/bridge。不要改成清空整个 `mods/`，那里可能有未知的用户文件。

### ADR-009：纯净 Windows 使用 winget 引导，手动安装为回退

双击 cmd 调 PowerShell；缺 Node/JDK 时安装 `OpenJS.NodeJS.LTS` 和 `EclipseAdoptium.Temurin.25.JDK`，之后走与人工部署完全相同的构建/校验脚本。没有 winget 或网络不可用时，README 引导手动 Node 22+/Temurin 25，再用 `-SkipEnvironmentInstall`，避免把 winget 当唯一渠道。

### ADR-010：LAN 兼容模式使用原版组播发现，不修改人类世界端口

Java 版开放 LAN 后端口是动态的；监听 `224.0.2.60:4445` 并解析原版 `[MOTD]/[AD]` 广播比要求用户每次抄端口可靠。自动发现只决定目标地址，不开放控制接口；LAN 模式强制 Bot 离线身份。VPN/多网卡/防火墙失败时 WebUI 显示明确排查信息。

### ADR-011：离线多人皮肤采用“共同来源”，不伪装成协议广播

CustomSkinLoader 官方 LocalSkin 不会自动被别人看见。项目导入 PNG 后只在 Bot/本机验证，并生成供每个观看客户端安装的同内容包；长期服务器推荐共同 CustomSkinAPI 站点。不能声称只给 Bot 装 mod 就能让所有人看见。官方 Universal jar 固定版本/哈希并随仓库提供，避免中国运行时再访问 GitHub；上游允许未修改二进制随 modpack 分发但必须列名，归属在 vendor README。

## 13. 中国大陆网络实现与实测

实测环境：Windows，中文且含空格项目路径，Asia/Shanghai。**用户于 2026-08-04 明确说明电脑全局挂美国 VPN**，此前“普通中国网络”表述作废。所有下载/构建结果只能证明功能路线和哈希正确，不能证明中国大陆无代理可达。PowerShell 5 对无 BOM UTF-8 中文脚本曾出现解析错误，因此所有运行脚本的输出/异常文本保持 ASCII；README 仍为 UTF-8。路径参数显式加引号，后台 Node 中文路径启动已测试。

### npm

`.npmrc` 使用 npmmirror。当前固定依赖：

- runtime：`mineflayer 4.37.1`、`minecraft-data 3.112.0`、`mineflayer-pathfinder 2.4.5`。
- dev：`typescript 7.0.2`、`tsx 4.23.5`、`@types/node 24.13.3`。

### Gradle/Fabric

- Wrapper 9.5.1，wrapper jar 来自 Fabric 官方 example 模板固定内容，distribution SHA-256 配置在 wrapper properties。
- Maven 仓库含腾讯云/国内回退与官方 Fabric/Mojang；Fabric API 下载最终使用官方 Fabric Maven，因为腾讯路径实测 404。
- Fabric API jar SHA-256：`8DE18D9F6A8A2A5B2120EF9E8BFFB79CC9B75989C0C022C39C9DFC1BC3A29A99`。

### Minecraft 资源

`prefetch-minecraft-libraries.mjs`：

1. 从 BMCLAPI `/version/26.2/json` 获取官方版本元数据。
2. 客户端 jar 从 BMCLAPI `/version/26.2/client` 获取，核对元数据 official SHA-1/size。
3. 按 Mojang rules、当前 OS/arch 计算所需 libraries/natives。
4. 默认从 CERNET `https://mirrors.cernet.edu.cn/bmclapi/<maven path>` 下载，支持镜像变量覆盖。
5. 已有文件同样校验 SHA-1；错误文件会重新下载并原子替换。

当前（VPN 环境）Windows 功能实测：共 88 个所需库；首次下载 60、缓存 28、失败 0；再次运行缓存 88、失败 0。客户端 jar也已从 BMCLAPI成功获取并通过 official SHA-1。必须另找无代理干净 Windows 做中国大陆验收。

注意：Gradle 初次构建曾卡在 Microsoft/Mojang 的 client/server jar（`.part` 为 0 字节）；实测通过 BMCLAPI 下载与官方 SHA-1 一致的 client/server 放入 Loom cache 后构建完成。新环境优先先运行 `npm run prefetch:minecraft`，但 Loom 自身 server merge 仍可能需要单独镜像改进，这是后续中国网络工作的一个待办。

## 14. 真实服务器测试证据

测试时间：2026-08-04 00:35–00:36（Asia/Shanghai）。测试 Bot：`CialloAI` 离线身份；未提供 EasyAuth 密码、未发送聊天、未移动或执行行为。

### Mineflayer 探针

`npm run probe` 能到达 `你的域名.com:25565`，服务端拒绝非完整 Fabric 客户端。提示要求 Fabric Loader/API，并暴露缺少的注册命名空间，包括 `beautify`、`farmersdelight`、`waystones`、`xaerominimap` 和 1 个额外命名空间。

### 原生无界面 Fabric 测试

1. Fabric 26.2 客户端成功启动，加载 49 个模组条目（Fabric API 子模块、Loader、bridge）。
2. Java 25、Fabric Loader 0.19.3、桥模组 0.1.0均加载成功。
3. Fabric 桥成功连接 Node（此前一轮日志：`Fabric 26.2 客户端已连接本机控制器`、`运行时已就绪`）。
4. 修复启动参数失效后，Fabric 模组主动连接目标服。
5. 服务器下发注册表；客户端明确收到 `611 registry entries that are unknown to this client`，随后 Fabric Registry Sync 断开。
6. 相关命名空间与 Mineflayer 探针一致，证明阻塞不是网络/版本握手/Headless/Fabric Loader，而是缺目标服客户端模组。
7. 大量 `Missing sound`、`OpenAL 1.1 not supported` 是 dummy assets/headless 无声音设备警告；客户端继续执行网络连接。
8. 离线身份访问 Realms/Profile certificates 的 401 是预期噪声，不阻断 `online-mode:false` 普通服务器。
9. 测试 Java/Node/HeadlessMc 进程均按精确命令行/PID核验后停止；没有遗留 Bot 会话。

### 服务器模组包成功进服测试

第二轮测试时间：2026-08-04 01:05–01:07（Asia/Shanghai）。用户提供 `D:\开发\进服必须mod`：24 个 jar，总约 37 MiB。同步器排除包内 `fabric-api-0.152.2+26.2.jar`，保留项目 `0.156.0+26.2`，导入其余 23 个。包含 beautify、Farmers Delight、Waystones、Xaero minimap/worldmap、REI、Inventory Profiles、Simple Voice Chat 及其依赖。

实测证据：

1. Fabric Loader 成功加载整套模组和 bridge，无重复 ID/缺依赖崩溃。
2. `01:06:58 Connecting to 你的域名.com, 25565`；此前 611 registry entries 错误消失。
3. Xaero 初始化、服务器 recipes/advancements 同步成功，Node 于 `17:07:02.629Z` 记录 `Fabric 客户端已进入世界`，离线 UUID `caee2f5b-1fe9-3d6c-a9ea-96588c1406b6`。
4. 服务器提示新账号 `Use /register <password> <password>`，还发放首次加入资源/成就；测试未提供密码，因此没有注册/登录命令，也未发聊天/动作。
5. Simple Voice Chat 发送 secret request，说明服务器通道/版本适配成功；Headless 无 OpenAL context，Speaker unavailable，当前语音不可用但不影响进服。
6. 测试后精确停止 HeadlessMC/游戏/Node，无遗留进程。

第三轮回归时间：2026-08-04 02:16–02:18（Asia/Shanghai）。Bot 再次进入 `你的域名.com:25565`，运行时状态为 `in_world`，坐标 `(1231.5, 132, 199.5)`、生命 20、饥饿 20。CustomSkinLoader Universal 15.0.1 在真实 MC 26.2 客户端加载，并完成皮肤/渲染相关类转换。服务器仍提示 `/register`；因未保存 EasyAuth 密码和模型 Key，没有发送注册、聊天或动作。重复双击 `Start-Bot.cmd` 时发现“同步被 Java 锁定的 mod 后误回滚 Node”问题，现已通过启动前 PID 早退和只回滚本轮新进程修复。

第四轮搬迁回归时间：2026-08-04 09:02–09:14（Asia/Shanghai）。项目主本地仓改为 `D:\临时工程\minecraft aibot`，旧目录 WebUI 仍占用 3210 且复制的 `webui.pid.json` 指向旧 PID。新版启动脚本实测拒绝该端口并报告另一项目目录占用；精确停止旧项目 Node/Headless Java 后，新 WebUI 以新根目录 PID 记录启动，HTTP snapshot 200，旧项目进程为 0，用户的人类 Java 客户端保留。

旧目录实际设置、`.env` 秘密和本地皮肤通过 WebUI API 迁移到新目录，未在终端输出值；带 `-` 的 Bot 名称按 EasyAuth 规则替换为 `_`。只读探针此前收到 `text.easyauth.disallowedUsername`，修正后真实 Fabric Bot 在新目录进入世界，EasyAuth 先返回认证成功再返回已经认证，状态 `in_world`、生命 20、饥饿 20。模型最小请求真实使用 `deepseek-v4-flash`、`high`，约 1254 ms 成功；运行中重复 start API 约 1488 ms 幂等成功。首次 start HTTP 调用等待较长但后台进程实际正常启动，终止调用端后没有遗留 WebUI 子 PowerShell，重复调用正常，因此未判定为服务端死锁。

第五轮死亡恢复回归时间：2026-08-04 09:20–09:29（Asia/Shanghai）。用户观察到 Bot 被 Phantom 击杀后 `runtime-status` 长期 `health=0`；源码确认此前没有死亡分支。使用本机精确 26.2 deobf JAR 的 `javap` 验证原版 `DeathScreen` 调用 `LocalPlayer.respawn()` 后 `client.gui.setScreen(null)`。部署新桥并重连仍处于死亡状态的服务器会话后，01:29:49Z 收到 `death`，01:29:52Z 发送 `respawn_requested` 并收到 `respawned health=20`；最终 `in_world`、生命 20、饥饿 20，证明不是仅靠断线重连恢复。

第六轮聊天诊断时间：2026-08-04 09:32–09:49（Asia/Shanghai）。游戏日志持续出现 `<[称号]玩家名> 内容`，最近 20 条聊天中 8 条为该格式，8 条包含当前 Bot 名；配置 `requireMention:false`，但 Node 日志没有 `已处理玩家消息/失败`。根因是这些内容走 Fabric `GAME` 而非签名 `CHAT`。新增 `parseDecoratedPlayerChat`、GAME 回退和 1500 ms 去重；Node/本机桥集成测试验证称号剥离、mention 清理和重复抑制。热重启控制器后 55 秒没有新服内发言，故真实 DeepSeek 回复尚待用户再发一条，不得标记为现场通过。

第七轮模型超时诊断时间：2026-08-04 09:58–10:14（Asia/Shanghai）。控制器正确识别真人玩家，连续两次发出通用失败兜底；对应日志均为 Node `TimeoutError: The operation was aborted due to timeout`，恰好命中配置 60000ms，因此聊天路由已修复，失败点在模型等待。相同 `deepseek-v4-flash/high` 最小请求约 3130ms 成功。随后以完整项目 system prompt、约 452 prompt tokens 和 4096 输出预算诊断：约 5748ms、`finish_reason=stop`、567 completion tokens，其中最终 JSON 仅 105 字符。按 DeepSeek 官方 JSON Output 文档加入明确输出预算，并把默认超时提高到 120000ms；不得记录诊断内容、玩家原话或密钥。

模组外部前置已经解决。当前实际/未来同步方式：

```powershell
.\scripts\prepare-fabric-client.ps1 -AdditionalModsDirectory '<模组包目录>'
npm run sync:mods
```

下一步端到端验证顺序：通过 WebUI安全保存 EasyAuth 密码/DeepSeek Key→最小模型 API→注册→重新连接登录→只读聊天→look/stop→follow→受击自卫。任何破坏/采集动作在领地策略完成前禁止测试。

## 15. 测试和构建手册

Node：

```powershell
npm install
npm run check
npm test
npm run build
```

Fabric：

```powershell
$env:JAVA_HOME="$env:APPDATA\.minecraft\runtime\java-runtime-epsilon"
$env:Path="$env:JAVA_HOME\bin;$env:Path"
Set-Location fabric-bridge
.\gradlew.bat build --no-daemon
```

当前 24 项 Node 回归由 13 个文件组成：

| 测试文件 | 项数 | 固定契约 |
| --- | ---: | --- |
| `agent-controller.test.ts` | 2 | 玩家专属记忆/动作/回复链；TimeoutError 专用兜底 |
| `chat-parser.test.ts` | 3 | 单/多称号解析、系统消息和非法用户名拒绝 |
| `config-validation.test.ts` | 3 | EasyAuth 名称、非法名称、自动复活兼容/范围 |
| `decision.test.ts` | 2 | JSON 决策、动作降级、wander 半径 |
| `experience-store.test.ts` | 1 | 创建、持久化、相关性检索 |
| `fabric-bridge-client.test.ts` | 1 | hello/state/GAME+CHAT去重/action_result 本机回环 |
| `json.test.ts` | 1 | PowerShell UTF-8 BOM JSON 读取 |
| `lan-discovery.test.ts` | 2 | 原版组播格式与非法包拒绝 |
| `llm-provider.test.ts` | 3 | DeepSeek映射/预算、OpenAI Responses预算、缺 Key |
| `logger.test.ts` | 1 | 登录命令、Key、嵌套秘密脱敏 |
| `memory-store.test.ts` | 1 | 单文件恢复、UUID隔离、事件上限 |
| `policy-engine.test.ts` | 2 | 财产/未知归属拒绝、自卫窗口与攻击者匹配 |
| `skin-png.test.ts` | 2 | 64×64/64×32 接受，其他尺寸拒绝 |

这套 Node 测试没有覆盖真实 Gradle/Fabric 运行、Java动作实现、PowerShell进程树、WebUI全部 API、模组兼容、网络镜像或真人游戏行为；对应改动必须追加专项/现场测试，不能把“24项通过”解释为完整功能验收。

已通过的测试类型：

- Agent JSON 决策解析/动作归一化。
- Memory 初建、UUID 玩家隔离、事件上限与持久化。
- Experience 写入/检索。
- Policy 财产拒绝、未知归属拒绝、未受击 PVP 拒绝、受击者/窗口自卫。
- Logger 递归秘密与 `/login` 脱敏。
- DeepSeek 思考/max 映射、Chat Completions `max_tokens` 与 OpenAI Responses `max_output_tokens` 使用本机 mock API 验证，不消耗用户额度。
- Fabric bridge 本机 JSONL hello/state/chat/action/action_result 回环。
- 后台 Node 启停：中文+空格路径，隐藏窗口，PID 写入/清理。
- 后台 HeadlessMc 父进程启停。
- Fabric Gradle build。
- 国内 Minecraft 依赖预取与真实服务器连接。
- 服务器 23 个受管理模组同步和完整原生进服。
- WebUI GET snapshot、静态页面/CSP、同值 PUT 保存；WebUI 隐藏启停。
- WebUI 页面返回 200/CSP，伪造非本机 Host 返回 403；24 项 Node 测试全部通过，包含 EasyAuth 用户名、自动复活、PowerShell BOM JSON、插件聊天解析与去重、模型输出预算与超时提示。
- `install-windows.ps1 -SkipEnvironmentInstall -NoOpen` 全流程：npm/check/build、88 库缓存校验、Fabric build、Headless hash、23 mod、WebUI，约 85 秒通过。
- LAN 发现通过真实本机 UDP 组播包和 WebUI 扫描接口验证；实际玩家开放 LAN 世界仍待现场验收。
- 皮肤 PNG 校验/导入/读取、CustomSkinLoader 安装及多人客户端包生成已验证；临时皮肤与 zip 均留在 Git 忽略的 `.runtime/test-artifacts`，正式配置恢复为禁用状态。

本文件当前更新后必须再次运行完整测试；接手者不要仅凭“已通过”跳过回归。

## 16. 已踩过的坑

1. Mineflayer ESM 下 `mineflayer-pathfinder` 不是可靠 named import，已改为 default package 解构；否则 Node 24 启动即崩。
2. `package.json` 入口必须是 `dist/src/index.js`，不是 `dist/index.js`。
3. Fabric bridge 等待超时后必须关闭监听 server；否则 runtime 下轮报 `EADDRINUSE 127.0.0.1:8765`。历史日志有旧错误，当前代码已修。
4. Windows PowerShell 5 读取无 BOM UTF-8 中文 `.ps1` 会乱码甚至语法错误，运维脚本保持 ASCII 文案。
5. Start-Process 的中文/空格入口必须显式引号；启动后短暂检查 `HasExited` 才能发现错误配置。
6. MC 26.2 忽略 `--server/--port`，必须由 Fabric mod 主动连接。
7. HeadlessMc 会在项目根创建 `HeadlessMC/<uuid>` 临时 native/lib 目录，已加入 `.gitignore`。
8. 仅装 Fabric API 并不能进入 Fabric 模组服；注册表同步要求客户端具备注册相同内容的模组。
9. 不要把“online-mode:false”误读成无 EasyAuth；离线 Mojang 认证后仍需服内 `/login`。
10. 用户模组包含 Fabric API 0.152.2，项目固定 0.156.0；必须排除前者，不能两个一起复制。
11. 首次离线名会收到 `/register` 而不是 `/login`；EasyAuth 必须提示优先，盲目先 login 会错过注册。
12. Java `-version` 写 stderr，PowerShell `$ErrorActionPreference=Stop` 会把正常版本输出当 NativeCommandError；环境探测时临时 Continue。
13. `node -p` 经 PowerShell/函数参数转义容易丢引号；安装器改用 `node --version` 解析主版本。
14. 用户电脑全局美国 VPN；不要再把当前下载结果写成中国大陆无代理测试。
15. 项目移动后，复制来的 PID 会指向旧目录；必须按 projectRoot/命令行/端口识别，不能只看 PID 存活。
16. PowerShell 5 写出的 UTF-8 PID JSON可能带 BOM；WebUI/配置读取必须用 `parseJsonDocument`，否则会把正在运行误报成停止。
17. EasyAuth 用户名不接受连字符、空格、中文或超过 16 位；Bot 离线名、皮肤文件名和服内账号必须统一。
18. 目标服称号聊天走 `GAME` 而非 `CHAT`；只解析严格尖括号格式并剥离方括号称号，不能把任意系统广播当玩家指令。
19. GAME/CHAT 可能同时出现相同正文，必须保留 1500ms 去重；删掉会造成重复模型计费和重复动作。
20. DeepSeek V4 高推理未设输出预算时可超过 60秒；游戏决策默认 4096 token、120秒。不要用盲目重试消耗用户有限余额。
21. 自动复活必须由 Fabric 客户端调用原版 respawn 接口；断线重连并不保证退出死亡界面。
22. WebUI保存设置/秘密不会热更新正在运行的控制器和 Java；测试新配置前完整重启。
23. `AtomicJsonFile` 的 `.bak` 只保留上一代且损坏 JSON 不自动回退；恢复时必须停进程并人工校验。
24. 当前 Fabric 移动是直线按键控制，不是寻路；“动作返回成功”表示开始移动，不表示已安全到达。
25. `start-headless-client.ps1` 当前没有把 bot config 的 `bridgeHost/bridgePort` 映射为 `MCAI_BRIDGE_HOST/PORT`；Java 仍用 127.0.0.1:8765。修复脚本前不要在 WebUI 修改桥端口，否则 Node 与 Java 会等待不同端口。

## 17. 需求追踪

| ID | 需求 | 状态 |
| --- | --- | --- |
| R1 | DeepSeek/豆包/GPT，可调推理 | 三适配器/WebUI已实现；DeepSeek V4/high真实最小及完整提示诊断通过，豆包/OpenAI仍待真实账号验证 |
| R2 | 人设、聊天命令与回复 | 人设/提示词和目标服真人消息识别已实现；输出预算修复后的正常回复/动作现场闭环待复验 |
| R3 | 单一可迁移记忆文件 | 已实现并测试 |
| R4 | 不同玩家独立记忆/回复 | UUID 隔离已实现并测试 |
| R5 | 队友动作、主动聊天、自主发展 | 基础队友动作/主动聊天已实现；完整发展未实现 |
| R6 | 独立经验文件、避免重复错误 | 存储/检索基础已实现；自动复盘闭环未实现 |
| R7 | 26.2/Fabric 0.19.3 模组服、本地/服务器 | 23 外部 mod + bridge 真实进入世界 |
| R8 | EasyAuth | login/register 提示优先、5秒回退和脱敏已实现；忽略文件密码注入及目标服认证成功已验证 |
| R9 | 名称、皮肤、披风 | 离线名称、标准 PNG 导入、CustomSkinLoader 和多人客户端包已实现；MS 登录/正版披风未实现 |
| R10 | 搜索/本地化开源方案 | 持续执行；所有固定来源/哈希已记录 |
| R11 | 语音接口/Simple Voice Chat | mod/服务器 secret 握手成功；Headless OpenAL不可用，收发未实现 |
| R12 | 行为规则、荒野、自卫 | 独立规则和 Policy自卫窗口已实现；自动反击、威胁停止、荒野选址与部分规则字段接线未实现 |
| R13 | 模块化 | 已按 adapter/provider/agent/policy/storage/runtime 分层 |
| R14 | 图形总控页 | 本机暖色 WebUI 已实现设置、状态、解释、启停、LAN、皮肤、提示词、记忆、模组和日志 |
| R15 | 后续服务器 mod 更新 | 清单式同步、启动自动同步、WebUI按钮已实现 |
| R16 | 纯净 Windows 一键部署 | cmd + winget/手动回退脚本已实现，现有环境全流程通过 |
| R17 | 人类 README 文件/参数原理 | 已增加逐文件和逐 JSON 路径说明 |
| R18 | 中国网络测试口径 | 已纠正 VPN 口径；无代理干净机验收仍待做 |
| R19 | 局域网同机/同网游玩 | UDP 组播自动发现、离线强制、WebUI 扫描和解析测试已实现；需用户实际开放 LAN 世界做现场验收 |
| R20 | 根目录便捷入口 | Open-WebUI/Start-Bot/Stop-Bot 三个 cmd 已实现 |
| R21 | 独立参数位置总表 | `PARAMETERS.md` 已实现并与三份示例关联 |
| R22 | Bug/无效字符/秘密终检 | 已完成：24 项测试、类型/构建/脚本/JSON、UTF-8/控制字符、Git 空白和秘密扫描均通过；实际秘密只在本机忽略文件，未进入 Git，运行产物被忽略 |

## 18. 推荐下一阶段（按顺序）

1. EasyAuth、DeepSeek 最小请求和真人消息接收已通过；模型超时修复部署后，由真人再发一次明确低风险指令，验证模型决策→基础动作→回复→记忆。Key 曾在聊天暴露，测试后提醒轮换。
2. 在一台无 VPN、无 Node/Java/Minecraft 的中国大陆 Windows 验证双击部署器；记录 winget/npm/BMCL/Gradle/Headless每段结果和回退。
3. 给 Fabric bridge 增加方块碰撞/危险感知和可靠路径规划；优先 follow/come 的可中断寻路，不先做挖掘。
4. 实现工具化任务状态机：采集→制作→补给→恢复，所有世界改动前经过 ownership/settlement policy。
5. 实现荒野选址：检测玩家建筑/容器/农田/红石/领地模组，未知时远离并拒绝破坏。
6. 完成经验闭环：动作结果与任务结果归因、失败摘要、相似经验检索、复验计数。
7. 验证豆包/OpenAI，记录精确 model ID/限流；不要猜方舟端点 ID。
8. 增加 Linux systemd；实现 Microsoft 登录/正版披风；最后研究虚拟音频或 Voice Chat API。

## 19. 每次 Agent 完成前检查

1. 两份 README 是否都准确，不夸大未验证功能。
2. `npm run check && npm test && npm run build` 与 Fabric build 是否通过。
3. 是否在中国网络/中文路径保持可运行；新增下载是否有镜像、固定版本、哈希和失败提示。
4. `git diff --check`，检查秘密、大文件、日志、data、runtime、构建产物。
5. 真实服务器测试是否低风险；未获授权不得破坏世界或冒用玩家账号。
6. 提交、`git push origin main`，确认与 origin/main 同步。
7. 在交接中记录：用户需求、完成内容、文件、架构决策、依赖、网络验证、测试、未解决项、提交 SHA、推送结果。不要为了把“当前提交 SHA”写回同一个提交形成无限提交；记录本轮父提交或下一轮回填即可。
