# Minecraft AI Player — AI 持续开发档案

> 本文件面向接手项目的 AI Agent。开始工作前必须完整阅读本文件与 `README.md`。禁止在本文档、日志、Git 或模型上下文中写入真实密码、API Key、Microsoft Token。

## 1. 不可遗忘的用户规则

用户已明确要求：

1. 目标是持续开发一个可实际游玩的 Minecraft AI 玩家，不是只写方案或文档。
2. 每一步开发必须同步维护两份 README：`README.md` 是人类安装、部署、使用、开发教程；本文件保存足以让新账号/Agent 无损续作的全部细节，包括 Git 推送。
3. 项目必须能在中国大陆正常网络下安装和运行；代理不能成为唯一方案。
4. 目标服务器 `ciallo.kim:25565`，`server.properties` 已确认 `online-mode:false`。
5. 目标游戏是 Minecraft Java Edition `26.2`，Fabric Loader `0.19.3` 模组服，使用 EasyAuth。
6. DeepSeek 不是多模态模型，AI 根基必须是结构化世界状态、API/指令和动作接口，不能依赖视觉、听觉或模拟人类桌面操作。
7. Bot 运行时必须静默在后台。
8. 用户授权开发完成后先自行测试目标服务器；测试必须低风险，不聊天、不移动、不尝试密码时无需额外确认。

任何代码、配置、依赖、部署、架构或测试变化没有同时反映到两份 README，就不能视为完成。

## 2. 仓库与 Git

- 工作区：`D:\开发\minecraft aibot`
- 远端：`https://github.com/wraaaaaa/Minecraftaiplayer.git`
- 远端名/默认分支：`origin` / `main`
- 本轮大规模开发前的 HEAD：`16a04c7 docs: capture AI player requirements baseline`
- 更早提交：`c638099 docs: establish human and AI project guides`、`93dd822 Initial commit`
- 仓库级作者：`wraaaaaa <310438732+wraaaaaa@users.noreply.github.com>`（仅在本仓库配置过；不要擅改全局 Git 身份）。
- 本文件记录时，本轮代码尚待最终测试、提交和推送；接手时以 `git status --short --branch` 和 `git log` 为准。

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
```

Fabric 桥是游戏里的结构化“传感器+执行器”：直接读取客户端对象状态，向 Node 发玩家聊天、系统消息、世界状态、受击者信息；Node 只发送白名单动作。大模型不看画面、不听声音、不直接发任意网络包或系统命令。

### 已实现

- 原生 MC 26.2/Fabric Loader 0.19.3/Fabric API 0.156.0+26.2 客户端模组，Java 25，Loom 1.17.17，Gradle 9.5.1。
- Fabric 内部自动连接 `MCAI_SERVER_HOST/MCAI_SERVER_PORT`（默认项目目标地址），每 600 tick 可重试。
- Node 本机桥、断线/超时/动作结果处理、重连循环。
- DeepSeek、火山方舟 OpenAI-compatible Chat Completions、OpenAI Responses 三类模型适配器。
- 推理强度 `none/low/medium/high/xhigh/max`；DeepSeek 显式映射到当前 `disabled/high/max`，发生降档时记录警告。
- 人设、多人 UUID 隔离记忆、单一记忆文件、独立经验文件、原子替换和 `.bak`。
- 聊天提及、冷却、主动聊天调度、结构化 JSON 决策解析和长度清洗。
- 动作：none、stop、chat、follow_player、come_to_player、look_at_player、wander、attack_player。策略层还理解但 Fabric 暂不执行 break_block/open_container，用于先拒绝危险动作。
- EasyAuth：进入世界后环境变量直发 `login <password>`，不是把命令交给 LLM；日志和系统消息脱敏。
- 受击 Mixin：只有真实 `Player` 造成伤害才发 `attacked_by_player`；Node 策略在 15 秒窗口内只允许攻击该人一次/受控反击。
- Windows 后台 Node、后台 Headless Minecraft、组合启停，PID 与可执行路径核验。
- 国内资源预取、哈希校验、隔离游戏目录和服务器客户端模组复制入口。
- Mineflayer 26.2 诊断适配和目标服探针，但不会用于正式模组连接。

### 尚未完成

- 缺目标服务器完整客户端模组包，因此尚未进入世界、执行 EasyAuth、聊天或动作的目标服端到端测试。
- 可靠寻路、避障、采集、挖掘、制作、放置、战斗循环和自主生存闭环。
- “荒无人烟选址”的世界扫描/领地判断；当前策略保守拒绝破坏，安全但不自主发展。
- 经验自动总结目前只有存储与提示检索基础，未形成完整任务结果→失败归因→复验闭环。
- Microsoft 正版认证自动化、皮肤/披风设置；Fabric 后台脚本当前面向 `offline`。
- Simple Voice Chat API/UDP 适配；当前只有未来模块边界，没有语音代码。
- Linux systemd/无界面启动脚本；核心可移植，现有运维脚本是 PowerShell/Windows。
- 三个真实模型端到端调用未测试，因为工作区没有用户 API Key；不要伪造已验证结论。

## 4. 文件地图

### 根配置与运维

| 路径 | 作用 |
| --- | --- |
| `package.json` / `package-lock.json` | Node 22+，TS 构建、测试、探针、后台和客户端脚本 |
| `.npmrc` | `registry=https://registry.npmmirror.com` |
| `.env.example` | 秘密变量模板；代码会加载被忽略的 `.env`，但不覆盖进程环境已有变量 |
| `.gitignore` | 排除 node_modules、dist、data、logs、本地配置、Fabric 构建缓存、`.runtime`、HeadlessMC 临时目录 |
| `config/bot.example.json` | 服务器、桥、EasyAuth、模型、聊天、存储、日志完整示例 |
| `config/persona.example.json` | 默认人设；本地复制为被忽略的 `persona.json` |
| `config/behavior-rules.json` | 版本化行为准则，当前允许受控自卫、拒绝财产破坏 |
| `scripts/start-background.ps1` / `stop-background.ps1` | 隐藏 Node 控制器与精确 PID 停止 |
| `scripts/start-headless-client.ps1` / `stop-headless-client.ps1` | 隐藏 HeadlessMc 父进程及其项目子进程 |
| `scripts/start-all-background.ps1` / `stop-all-background.ps1` | 组合启停；客户端启动失败时回滚控制器 |

### Node 控制器

| 路径 | 作用 |
| --- | --- |
| `src/config/*` | 类型与严格配置加载、相对路径解析、环境变量读取 |
| `src/core/atomic-json-file.ts` | 临时文件→备份→原子替换的 JSON 持久化 |
| `src/core/logger.ts` | JSONL 文件日志，默认不输出控制台，递归秘密脱敏 |
| `src/llm/*` | 三供应商统一 `complete()` 边界、超时、响应解析 |
| `src/agent/prompt.ts` | 明确告知模型只能使用结构化状态、不能声称视听觉；注入人设/记忆/经验/规则 |
| `src/agent/decision.ts` | 从纯 JSON 或 fenced JSON 提取白名单决策 |
| `src/agent/agent-controller.ts` | 玩家消息→上下文→LLM→策略→回复/动作/记忆 |
| `src/agent/world-state.ts` | 统一位置、生命、饥饿、背包、附近玩家等状态 |
| `src/memory/memory-store.ts` | 单文件 schema、UUID 玩家档案、名称更新、事件上限 |
| `src/experience/experience-store.ts` | 独立经验文件、去重/检索基础 |
| `src/policy/policy-engine.ts` | 财产保护、自卫窗口、攻击者匹配、动作拒绝理由 |
| `src/minecraft/fabric-bridge-client.ts` | 本机 TCP server、JSONL 协议、事件与 action_result 关联 |
| `src/minecraft/minecraft-client.ts` | Mineflayer 备选诊断适配器，pathfinder 加载与基础动作 |
| `src/minecraft/easy-auth.ts` | Mineflayer 路线 EasyAuth 辅助；Fabric 路线在模组中执行 |
| `src/runtime/bot-runtime.ts` | 选择适配器、生命周期、关闭后重连 |
| `src/index.ts` | 信号处理与主入口 |
| `src/probe.ts` | 不发聊天/动作的只读连接探针 |

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
| `test/*.test.ts` | 决策、记忆、经验、策略、日志脱敏、桥协议回环测试 |

运行时生成内容均被忽略：`data/`、`logs/`、`dist/`、`.runtime/`、`HeadlessMC/`、Fabric `build/.gradle/run`。

## 5. 配置与秘密契约

正式配置路径 `config/bot.json` 和 `config/persona.json` 被 Git 忽略；不存在时加载 example。服务器字段：

- `adapter`: 默认 `fabric_bridge`；`mineflayer` 只适合协议诊断/非模组环境。
- `bridgeHost` 必须保持 loopback；当前默认 `127.0.0.1:8765`。
- `auth`: 目标服是 `offline`。
- `connectTimeoutMs`: Node 等 Fabric 桥的单次等待；超时后必须确保 server close，再重试，避免 EADDRINUSE。

秘密：

- `MINECRAFT_LOGIN_PASSWORD`
- `DEEPSEEK_API_KEY`
- `ARK_API_KEY`
- `OPENAI_API_KEY`

运维覆盖：`MCAI_MINECRAFT_HOME`、`MCAI_MINECRAFT_VERSION`、`MCAI_MINECRAFT_LIBRARY_MIRROR`、`MCAI_BMCLAPI_BASE`、`MCAI_HEADLESSMC_DOWNLOAD_URL`、`MCAI_FABRIC_API_URL`、`MCAI_JAVA_HOME`、`MCAI_SERVER_HOST`、`MCAI_SERVER_PORT`。后两个由启动脚本从 bot config 传给 Fabric 子进程。

绝对禁止把登录命令原文交给 LLM。Fabric `GAME` 消息会正则替换 `/login <anything>`，并再次替换实际密码。Logger 也递归脱敏典型 key/authorization/password/token 值。

## 6. 关键技术决策与研究结果

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

## 7. 中国大陆网络实现与实测

实测环境：Windows，中文且含空格项目路径，Asia/Shanghai，普通中国网络。PowerShell 5 对无 BOM UTF-8 中文脚本曾出现解析错误，因此所有运行脚本的输出/异常文本改为 ASCII；README 仍为 UTF-8。路径参数显式加引号，后台 Node 中文路径启动已测试。

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

当前 Windows 实测：共 88 个所需库；首次下载 60、缓存 28、失败 0；再次运行缓存 88、失败 0。客户端 jar也已从 BMCLAPI成功获取并通过 official SHA-1。

注意：Gradle 初次构建曾卡在 Microsoft/Mojang 的 client/server jar（`.part` 为 0 字节）；实测通过 BMCLAPI 下载与官方 SHA-1 一致的 client/server 放入 Loom cache 后构建完成。新环境优先先运行 `npm run prefetch:minecraft`，但 Loom 自身 server merge 仍可能需要单独镜像改进，这是后续中国网络工作的一个待办。

## 8. 真实服务器测试证据

测试时间：2026-08-04 00:35–00:36（Asia/Shanghai）。测试 Bot：`CialloAI` 离线身份；未提供 EasyAuth 密码、未发送聊天、未移动或执行行为。

### Mineflayer 探针

`npm run probe` 能到达 `ciallo.kim:25565`，服务端拒绝非完整 Fabric 客户端。提示要求 Fabric Loader/API，并暴露缺少的注册命名空间，包括 `beautify`、`farmersdelight`、`waystones`、`xaerominimap` 和 1 个额外命名空间。

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

下一次完整目标服测试的唯一外部前置：用户/服主提供 **同一版本完整客户端模组包**。不要靠猜测逐个下载 611 项；模组版本、依赖和配置必须与服务器整合包一致。拿到后：

```powershell
.\scripts\prepare-fabric-client.ps1 -AdditionalModsDirectory '<模组包目录>'
npm run start:all
```

然后验证顺序：注册表同步→joined_world→EasyAuth 登录→只读聊天→look/stop→follow→受击自卫。任何破坏/采集动作在领地策略完成前禁止测试。

## 9. 测试和构建手册

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

已通过的测试类型：

- Agent JSON 决策解析/动作归一化。
- Memory 初建、UUID 玩家隔离、事件上限与持久化。
- Experience 写入/检索。
- Policy 财产拒绝、未知归属拒绝、未受击 PVP 拒绝、受击者/窗口自卫。
- Logger 递归秘密与 `/login` 脱敏。
- Fabric bridge 本机 JSONL hello/state/chat/action/action_result 回环。
- 后台 Node 启停：中文+空格路径，隐藏窗口，PID 写入/清理。
- 后台 HeadlessMc 父进程启停。
- Fabric Gradle build。
- 国内 Minecraft 依赖预取与真实服务器连接。

本文件当前更新后必须再次运行完整测试；接手者不要仅凭“已通过”跳过回归。

## 10. 已踩过的坑

1. Mineflayer ESM 下 `mineflayer-pathfinder` 不是可靠 named import，已改为 default package 解构；否则 Node 24 启动即崩。
2. `package.json` 入口必须是 `dist/src/index.js`，不是 `dist/index.js`。
3. Fabric bridge 等待超时后必须关闭监听 server；否则 runtime 下轮报 `EADDRINUSE 127.0.0.1:8765`。历史日志有旧错误，当前代码已修。
4. Windows PowerShell 5 读取无 BOM UTF-8 中文 `.ps1` 会乱码甚至语法错误，运维脚本保持 ASCII 文案。
5. Start-Process 的中文/空格入口必须显式引号；启动后短暂检查 `HasExited` 才能发现错误配置。
6. MC 26.2 忽略 `--server/--port`，必须由 Fabric mod 主动连接。
7. HeadlessMc 会在项目根创建 `HeadlessMC/<uuid>` 临时 native/lib 目录，已加入 `.gitignore`。
8. 仅装 Fabric API 并不能进入 Fabric 模组服；注册表同步要求客户端具备注册相同内容的模组。
9. 不要把“online-mode:false”误读成无 EasyAuth；离线 Mojang 认证后仍需服内 `/login`。

## 11. 需求追踪

| ID | 需求 | 状态 |
| --- | --- | --- |
| R1 | DeepSeek/豆包/GPT，可调推理 | 适配器已实现；真实 Key/API 回归待做 |
| R2 | 人设、聊天命令与回复 | MVP 已实现；目标服入服后验证 |
| R3 | 单一可迁移记忆文件 | 已实现并测试 |
| R4 | 不同玩家独立记忆/回复 | UUID 隔离已实现并测试 |
| R5 | 队友动作、主动聊天、自主发展 | 基础队友动作/主动聊天已实现；完整发展未实现 |
| R6 | 独立经验文件、避免重复错误 | 存储/检索基础已实现；自动复盘闭环未实现 |
| R7 | 26.2/Fabric 0.19.3 模组服、本地/服务器 | Windows Headless 链路已实测；等待完整客户端模组包入服 |
| R8 | EasyAuth | 安全发送/脱敏已实现；服内登录待验证 |
| R9 | 名称、皮肤、披风 | 离线名称已实现；皮肤/披风/MS 登录未实现 |
| R10 | 搜索/本地化开源方案 | 持续执行；所有固定来源/哈希已记录 |
| R11 | 语音接口/Simple Voice Chat | 未实现，可选后续 |
| R12 | 行为规则、荒野、自卫 | 独立规则和自卫已实现；荒野选址未实现 |
| R13 | 模块化 | 已按 adapter/provider/agent/policy/storage/runtime 分层 |

## 12. 推荐下一阶段（按顺序）

1. 获取目标服完整 26.2 客户端整合包，完成无破坏端到端入服/EasyAuth/聊天/基础动作测试。
2. 给 Fabric bridge 增加方块碰撞/危险感知和可靠路径规划；优先 follow/come 的可中断寻路，不先做挖掘。
3. 实现工具化任务状态机：采集→制作→补给→恢复，所有世界改动前经过 ownership/settlement policy。
4. 实现荒野选址：检测玩家建筑/容器/农田/红石/领地模组，未知时远离并拒绝破坏。
5. 完成经验闭环：动作结果与任务结果归因、失败摘要、相似经验检索、复验计数。
6. 用用户提供的测试 Key 分别验证 DeepSeek、豆包 Seed 2.1 Pro、OpenAI，记录精确 model ID、参数兼容与限流处理；不要凭网页名字猜豆包端点 ID。
7. 增加 Linux systemd 服务和国内干净环境安装回归。
8. 实现 Microsoft/皮肤/披风；正版披风只能使用账号已有披风。最后再评估 Simple Voice Chat。

## 13. 每次 Agent 完成前检查

1. 两份 README 是否都准确，不夸大未验证功能。
2. `npm run check && npm test && npm run build` 与 Fabric build 是否通过。
3. 是否在中国网络/中文路径保持可运行；新增下载是否有镜像、固定版本、哈希和失败提示。
4. `git diff --check`，检查秘密、大文件、日志、data、runtime、构建产物。
5. 真实服务器测试是否低风险；未获授权不得破坏世界或冒用玩家账号。
6. 提交、`git push origin main`，确认与 origin/main 同步。
7. 在交接中记录：用户需求、完成内容、文件、架构决策、依赖、网络验证、测试、未解决项、提交 SHA、推送结果。不要为了把“当前提交 SHA”写回同一个提交形成无限提交；记录本轮父提交或下一轮回填即可。
