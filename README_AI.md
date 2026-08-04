# README_AI - Minecraft AI Player 完整交接手册

> 本文写给后续 AI Agent、维护者和审查者。面向普通用户的安装、部署和使用教程是 `README.md`，参数索引是 `PARAMETERS.md`。任何功能或参数变更都必须同时更新这三处中受影响的内容。
>
> 本文不得保存真实服务器地址、API Key、EasyAuth 密码、桥接令牌或玩家隐私。仓库中的服务器地址一律写成 `你的域名.com`。

## 0. 接手时先做什么

当前工作机有两个目录：

- 主开发仓：`D:\临时工程\minecraft aibot`
- 旧目录/同步副本：`D:\开发\minecraft aibot`

主开发仓才是本轮编辑、验证、提交和推送的来源。不要同时运行两个目录里的 Bot，否则可能发生端口、PID、日志和配置冲突。换电脑后这些绝对路径自然失效，应以 `git rev-parse --show-toplevel` 的结果为准。

远端仓库为 `https://github.com/wraaaaaa/Minecraftaiplayer.git`，默认分支为 `main`。本文不把提交 SHA 或测试数量当作长期不变量；第 2.2 节只保留带日期的本轮验证快照，接手时仍要动态查询：

```powershell
Set-Location 'D:\临时工程\minecraft aibot'
git status --short --branch
git remote -v
git fetch origin
git rev-list --left-right --count HEAD...origin/main
npm test
```

接手规则：

1. 先检查工作树，不覆盖、不重置、不丢弃用户或其他 Agent 的改动。
2. 不输出 `.env`、`config/bot.json` 或日志中的真实敏感值。
3. 不把“代码已编译”写成“已在真实服务器完成行为验收”。
4. 不把“动作开始”写成“动作目标已经完成”。
5. 不写死测试用例数量、当前提交 SHA、服务器域名或当前 PID。
6. 修改 Java 桥后必须重新构建并把新 jar 复制到隔离客户端；只运行 TypeScript 构建不会更新游戏内代码。
7. 正式推送前必须删除本地测试 API Key，并扫描当前工作树和 Git 历史。

## 1. 项目目标和不可变约束

项目目标是让大模型驱动的玩家以真实 Minecraft 客户端身份加入 Minecraft Java 26.2 Fabric 模组服，通过结构化状态和白名单动作接口像队友一样交流、执行任务、生存和发展。

不可变约束：

- 目标服务器是 `online-mode=false`，正式无界面启动当前只支持离线账号。
- 目标版本固定为 Minecraft 26.2、Fabric Loader 0.19.3、Fabric API 0.156.0+26.2、Java 25。
- Bot 没有人类视觉、听觉或鼠标键盘输入；DeepSeek 等模型只接收结构化游戏状态和文本。
- 正式适配器是 `fabric_bridge`。`mineflayer` 只保留为诊断回退，不能代表 26.2 模组服兼容性。
- Bot 进程、Minecraft 客户端和 WebUI 均应可静默后台运行。
- 不破坏玩家建筑、容器、农田、红石和物品；不确定归属时拒绝破坏。
- 自主采集和建造只能发生在管理员明确批准的开发区，并且要远离其他玩家。
- 多人指令优先级首先是 `wraaaaaa`，其后才按发令者与 Bot 的实时距离由近到远。
- API Key、密码、令牌、真实服务器地址、本地路径和系统提示词不得通过模型、聊天、记忆、经验、日志或 Git 泄露。
- 中国大陆可用性是持续约束，不能退化成只依赖 npmjs、Mojang、GitHub 或境外 CDN 的单一路线。
- “像人类朋友一样游玩”是最终目标，不是当前完成声明。每项能力必须以服务器确认的后置条件和真实联机测试为依据。

## 2. 当前真实状态

### 2.1 已有证据

- 用户已经实际确认 Bot 能加入目标服务器并执行跟随玩家。
- 启动链包含 Node AI 控制器、HeadlessMc/Fabric 客户端、EasyAuth 登录、自动复活、后台 PID 管理和 WebUI。
- 当前工作树已集成任务队列、多人仲裁、语境寻址、密钥防泄露、WorldState schema v2、生存控制器、基础任务控制器和住所控制器。
- 后续提交仍必须重新运行验证，不能把本轮结果永久外推到未来工作树。

### 2.2 本轮验证快照（2026-08-04，Asia/Shanghai）

- Node/TypeScript：最终 full `npm test` 为 56 tests、56 pass、0 fail；`tsc --noEmit` 与生产 build 均成功。
- Fabric：最终 `clean build` 成功，不只是单文件编译。
- WebUI：完成浏览器回归；发现并修复 checkbox 区域横向溢出。
- 真实目标服：确认客户端上报 WorldState schema v2；实测生命值约 9.3 且低饱食时触发 `eat_best_food`，进食后饱食恢复到 16。
- 用户先前已经确认进服和跟随功能正常。
- 真实服开发区保持关闭，因此 `gather_resource`、`craft_item`、`build_shelter`、`seek_shelter` 尚未完成现场验收。禁止把自动测试或 Gradle build 当成这些世界动作已经通过。

该快照不包含固定提交 SHA。56 是本轮最终工作树的历史验证记录，不是未来提交的固定期望；后续 Agent 必须按当前 HEAD 重新查询和运行测试，测试数量随代码变化是正常现象。

### 2.3 功能状态矩阵

| 能力 | 当前实现 | 必须诚实说明的边界 |
| --- | --- | --- |
| 进服/模组握手 | HeadlessMc 启动真实 Fabric 26.2 客户端，可同步服务器要求的客户端 mod | 不能保证任意新增 mod 都兼容；每次服务端变更后要重新同步和实测 |
| EasyAuth | 识别 `/register`、`/login` 提示并发送命令；无提示时约 100 tick 后回退登录 | Fabric 路径没有使用 `easyAuth.loginDelayMs`，当前回退时间是 Java 固定逻辑 |
| 自动复活 | 死亡后取消当前控制器动作，按配置延迟调用正常客户端复活 | 必须在实际服务器确认死亡界面和插件没有改变流程 |
| 聊天/回复 | 支持点名、`!`、近距离语境寻址；回复经过出站密钥过滤 | 寻址是规则启发式，不是完整语义理解 |
| 多人任务 | 持久化单执行槽队列；主人优先，其余按发令者距离仲裁 | 单条复杂指令不会自动拆成任务 DAG；一次模型响应只选一个动作 |
| 跟随/前往/闲逛 | 真实按键移动和碰撞跳跃 | 结果表示“已开始”，不是已到达；没有可靠寻路 |
| 自动进食 | 低血量或低饱食时选择安全食物，必要时从背包换到快捷栏，确认物品实际消耗 | 不会主动寻找或生产食物，也不会处理所有模组食物 |
| 自动对敌 | 只攻击确认正在威胁 Bot 的敌对生物，检查视线、合法距离和攻击冷却 | 不会追击远处目标；自动排除苦力怕、末影人、猪灵和僵尸猪灵 |
| 选装备/任务准备 | 按护甲、工具、武器、耐久和附魔选择当前最佳物品；末地任务有最低门槛 | 不会自动附魔、熔炼或取得缺失装备；模组装备评分可能不完整 |
| 采集 | 在批准 AABB 内寻找已加载目标方块，验证工具、归属边界、玩家距离和方块真实破坏；Node 随后串联收取本次自有掉落 | 只搜索附近已加载区域且使用直线移动；掉落收取失败时整个任务按“已采下但未收全”失败 |
| 拾取自己掉落 | 只追踪并拾取本控制器注册的掉落实体 | 所有权账本在 Java 内存中，客户端重启后丢失；没有来源证据就拒绝 |
| 合成 | 使用已解锁且当前可合成的玩家背包 2x2 配方，确认背包数量增加 | 不支持工作台 3x3、多级规划、熔炉、酿造、锻造和附魔 |
| 建造住所 | 在批准区内建固定 3x3 小屋，放门、火把、墙和屋顶，逐块确认 | 需要现成材料；不自动合成门/火把；中途失败不会回滚已放方块 |
| 寻找住所 | 优先已记录的家，其次床，再次测量到的安全位置；回家会验证开门、进入、关门和照明 | 采用保守直线移动，复杂地形可能失败；床只在适当维度和时间交互 |
| 安全挂机 | 只有安全评估通过才停止移动；夜间或不安全时先寻求住所 | 没有完整逃生规划；火、岩浆、溺水或低血时目前不一定能主动脱险 |
| 空闲自发展 | 安全等待后可由一次模型请求选择一个受限白名单动作，经能力、策略和开发区检查；玩家任务可抢占 | 不进入持久任务队列，不会拆解资源链；当前尚未在真实服开放开发区现场验收 |
| 记忆 | 按玩家 UUID/名称隔离，保存事件和可选长期事实 | 没有自动摘要调度；删除主文件后只能依赖外部备份或上一代 `.bak` |
| 经验 | 失败动作写入原因和纠正建议，未来按关键词检索进提示词 | 不是训练模型；没有自动验证 `verified` 或更新 `timesApplied` 的闭环 |
| 皮肤 | 校验标准皮肤 PNG，并可生成其他玩家客户端安装包 | LocalSkin 不会由 Bot 广播；每位观察者都要装包或共同使用在线皮肤站 |
| 语音 | 服务器语音 mod 可作为普通客户端 mod 同步 | 没有语音收发接口；Headless 环境通常没有 OpenAL 音频设备 |

## 3. 总体架构

```text
Minecraft 服务器
    ^ 正常 Minecraft/Fabric 网络协议
    |
HeadlessMc + Fabric 26.2 客户端
    |- MinecraftAiBridgeClient
    |- WorldStateEncoder (schema v2)
    |- SurvivalController
    |- PrimitiveTaskController
    `- ShelterController
          ^ 本机回环 TCP / UTF-8 JSONL / protocolVersion 1 / bridge token
          |
Node.js AI 控制器
    |- FabricBridgeClient
    |- AddressingEngine
    |- TaskStore + AgentController
    |- CapabilityAssessor + PolicyEngine + SecretGuard
    |- DeepSeek / 火山引擎 / OpenAI API
    `- memory / experience / tasks / runtime status

本机 WebUI -> 配置、密钥、运行状态、mod、皮肤、下载记忆/经验
```

关键设计原因：

- 模组服兼容交给真实 Fabric 客户端，而不是让大模型或 Mineflayer 猜协议。
- 大模型只做受限决策；紧急生存、动作执行和安全后置条件在本地确定性代码中完成。
- 所有世界修改都走正常多人客户端 API，不直接修改客户端世界或背包内存。
- Node 和 Java 分进程，桥只绑定本机回环地址，模型密钥只留在 Node 进程。

## 4. 文件与模块地图

### 4.1 根目录和文档

| 路径 | 作用 |
| --- | --- |
| `README.md` | 面向人类的安装、配置、使用、故障排查与文件原理 |
| `README_AI.md` | 本交接文档；记录架构、状态、限制、验证和 Git 流程 |
| `PARAMETERS.md` | 所有参数、环境变量和本地存储位置索引 |
| `Install-and-Open-Control-Center.cmd` | 安装环境、构建运行时并打开 WebUI |
| `Open-WebUI.cmd` | 静默启动/复用 WebUI 并打开浏览器 |
| `Start-Bot.cmd` / `Stop-Bot.cmd` | 静默启动或停止 Node 控制器和 Minecraft 客户端 |
| `.npmrc` | 默认 npm 镜像为 npmmirror |
| `.gitignore` | 排除真实配置、秘密、数据、日志、构建和运行时目录 |

### 4.2 Node.js 控制层

| 路径 | 作用 |
| --- | --- |
| `src/runtime/bot-runtime.ts` | 装配配置、存储、模型、策略和客户端；断线重连循环 |
| `src/agent/agent-controller.ts` | 任务入队、串行执行、准备阶段、拒绝、回复、经验写入 |
| `src/agent/addressing.ts` | 点名、强制前缀、距离和会话延续判定 |
| `src/agent/capability-assessor.ts` | 执行前条件与危险任务装备门槛 |
| `src/agent/decision.ts` | 模型 JSON 解析、动作白名单和参数归一化 |
| `src/agent/prompt.ts` | 组装当前玩家专属记忆、经验和结构化世界状态 |
| `src/agent/world-state.ts` | Node 内部规范化世界状态类型 |
| `src/tasks/task-store.ts` | 持久任务队列、原子仲裁、恢复和终态 |
| `src/security/secret-guard.ts` | 模型输入、持久化和聊天出站脱敏/拒绝 |
| `src/policy/policy-engine.ts` | 玩家财产、自卫、采集和建造硬规则 |
| `src/minecraft/fabric-bridge-client.ts` | 本机桥服务、事件归一化、动作超时、语境寻址 |
| `src/minecraft/minecraft-client.ts` | Mineflayer 诊断回退，不是正式模组适配 |
| `src/llm/provider-factory.ts` | DeepSeek、火山引擎 Chat Completions 与 OpenAI Responses |
| `src/memory/memory-store.ts` | 分玩家记忆和事件 |
| `src/experience/experience-store.ts` | 失败经验和关键词检索 |
| `src/core/atomic-json-file.ts` | Node JSON 临时文件、替换和上一代 `.bak` |
| `src/webui/server.ts` | 仅本机 WebUI、设置、秘密、运行控制和下载接口 |

### 4.3 Fabric 客户端层

| 路径 | 作用 |
| --- | --- |
| `fabric-bridge/.../MinecraftAiBridgeClient.java` | 自动进服、EasyAuth、复活、动作调度、状态发送 |
| `fabric-bridge/.../BridgeConnection.java` | Java 侧回环 JSONL 客户端和重连 |
| `fabric-bridge/.../WorldStateEncoder.java` | schema v2 背包、装备、环境、敌人、掉落和安全状态 |
| `fabric-bridge/.../SurvivalController.java` | 确定性进食、威胁识别、合法近战和安全评估 |
| `fabric-bridge/.../PrimitiveTaskController.java` | 装备、使用物品、采集、自己掉落、2x2 合成 |
| `fabric-bridge/.../ShelterController.java` | 固定小屋建造、寻求住所、门/光照验证和家位置持久化 |
| `fabric-bridge/.../mixin/LivingEntityDamageMixin.java` | 把受击来源送入生存/玩家自卫事件 |

### 4.4 脚本和运行产物

| 路径 | 作用 |
| --- | --- |
| `scripts/install-windows.ps1` | 检测/安装 Node 22+、Java 25，构建并准备隔离客户端 |
| `scripts/start-all-background.ps1` | 先启动 Node，再启动 Java；Java 失败时回滚新启动的 Node |
| `scripts/start-background.ps1` | 后台 Node、桥令牌和 PID 所有权记录 |
| `scripts/start-headless-client.ps1` | 同步 mod、导出 Java 配置、剥离模型密钥、后台启动 HeadlessMc |
| `scripts/sync-client-mods.mjs` | 复制服务器要求的客户端 jar，记录大小和 SHA-256 清单 |
| `scripts/prefetch-minecraft-libraries.mjs` | 通过 BMCLAPI/CERNET 预取并校验 26.2 客户端和库 |
| `scripts/prepare-fabric-client.ps1` | 复制桥 jar、Fabric API、万用皮肤加载器和选定 mod |
| `scripts/audit-repository.mjs` | UTF-8、异常字符、秘密形状、受保护路径和可选历史扫描 |
| `.runtime/` | HeadlessMc、隔离 Minecraft、mod、皮肤包；忽略且可重建 |
| `data/` | 记忆、经验、任务、住所、状态、PID 和桥令牌；忽略且需备份 |
| `logs/` | Node、启动器和客户端日志；忽略 |

## 5. 配置、参数和秘密

### 5.1 跟踪示例与本地真实文件

仓库跟踪：

- `config/bot.example.json`
- `config/persona.example.json`
- `config/prompts.example.json`
- `config/mods.example.json`
- `config/skin.example.json`
- `config/behavior-rules.json`
- `.env.example`

本地使用但禁止提交：

- `config/bot.json`
- `config/persona.json`
- `config/prompts.json`
- `config/mods.json`
- `config/skin.json`
- `.env`
- `data/`、`logs/`、`.runtime/`

注意：`config/behavior-rules.json` 当前是被 Git 跟踪的规范文件，WebUI 保存“全部设置”时也会写它。提交前必须审查这项差异是否是预期的公共默认策略。

### 5.2 关键默认值

`config/bot.example.json` 当前规范默认值：

| 配置 | 默认值/含义 |
| --- | --- |
| `server.adapter` | `fabric_bridge`，正式适配器 |
| `server.connectionMode` | `direct`；兼容模式用 `lan` |
| `server.host` | `你的域名.com`，真实地址只写本地忽略文件 |
| `server.port` | `25565` |
| `server.version` | `26.2` |
| `server.username` | `CialloAI`，必须是 3-16 位字母、数字或下划线 |
| `server.auth` | `offline`；无界面 Microsoft 登录尚未实现 |
| `server.autoRespawn` / `respawnDelayMs` | `true` / `3000` |
| `server.bridgeHost` / `bridgePort` | `127.0.0.1` / `8765` |
| `model.provider` | `deepseek`，也支持 `volcengine`、`openai` |
| `model.reasoningEffort` | `high`；允许 `none/low/medium/high/xhigh/max` |
| `chat.requireMention` | `true`，但开启语境寻址后不必每次点名 |
| `storage.*` | `data/memory.json`、`experience.json`、`tasks.json`、`autonomy-state.json` |
| `autonomy.ownerName` | `wraaaaaa` |
| `autonomy.commandArbitrationMs` | `350`，为并发消息留出仲裁窗口 |
| `autonomy.directAddressDistance` | `8` 格 |
| `autonomy.conversationWindowMs` | `60000` |
| `autonomy.lowHealthThreshold` | `10` |
| `autonomy.criticalHealthThreshold` | `6`，仅 Node 主动决策目前使用 |
| `autonomy.eatBelowFood` | `16` |
| `autonomy.hostileScanRadius` | `12` |
| `autonomy.wildernessMinPlayerDistance` | `48` 格 |
| `autonomy.safeIdleEnabled` | `true` |
| `autonomy.autoGather/autoCraft/autoBuildShelter` | 均为 `true`；既是能力许可门，也限制空闲模型可选择的安全自发展动作 |
| `autonomy.developmentZone.enabled` | `false`；未由管理员划定前拒绝采集和建造 |

开发区是维度加闭合 AABB。验证限制为 X/Z 单边最多 256 格、Y 高度最多 128 格、坐标绝对值不超过 30000000。采集会同时检查 Bot 和目标周围的其他玩家；建造会在开始和施工过程中持续检查荒野距离。

### 5.3 `.env` 变量

只允许以下模型秘密变量：

- `DEEPSEEK_API_KEY`
- `ARK_API_KEY`
- `OPENAI_API_KEY`
- `MINECRAFT_LOGIN_PASSWORD`

WebUI 的密钥接口只返回“是否已配置”，不返回值。保存密钥会原子替换 `.env`；删除按钮会移除上述值。最终测试后必须删除实际 API Key，再执行仓库审计。

常用非秘密覆盖：

- `BOT_CONFIG`：只改变 Node 配置入口。当前 Headless Fabric 启动脚本仍固定读取 `config/bot.json`，不要在成对启动时让两边读取不同配置。
- `MCAI_MINECRAFT_HOME`
- `MCAI_JAVA_HOME`
- `MCAI_MINECRAFT_LIBRARY_MIRROR`
- `MCAI_BMCLAPI_BASE`
- `MCAI_HEADLESSMC_DOWNLOAD_URL`
- `MCAI_FABRIC_API_URL`
- `MCAI_MODS_SOURCE`
- `MCAI_WEBUI_PORT`

`start-headless-client.ps1` 根据 JSON 生成 `MCAI_SERVER_*`、`MCAI_BRIDGE_*`、`MCAI_EASYAUTH_*`、`MCAI_AUTO_RESPAWN_*`、`MCAI_AUTONOMY_*`、开发区和 `MCAI_HOME_FILE`。这些是 Java 内部运行变量，普通用户不应手工维护。

`MCAI_ALLOW_REMOTE_BRIDGE=true` 会绕过 Java 侧回环限制，属于危险调试开关，不得用于正常部署。Node 侧仍拒绝非回环连接和非回环监听配置。

## 6. 启动、停止和进程生命周期

### 6.1 Windows 一键部署

双击 `Install-and-Open-Control-Center.cmd`：

1. 检查 Windows、Node.js 22+ 和 Java 25。
2. 缺失时尝试通过 winget 安装 Node.js LTS 与 Eclipse Temurin JDK 25。
3. 从示例生成本地配置和 `.env`，不会覆盖已经存在的本地文件。
4. 执行 npm 安装、TypeScript 检查和构建。
5. 预取并校验 Minecraft 26.2 资源。
6. 构建 Fabric bridge。
7. 安装并校验 HeadlessMc，准备隔离 Fabric 客户端和 mod。
8. 后台启动 WebUI 并打开 `http://127.0.0.1:3210`。

若 winget 不可用，必须人工安装 Node.js 22+ 和 Java 25 后重跑。当前一键脚本只正式支持 Windows；Linux/systemd 尚未实现。

### 6.2 正常启动顺序

`Start-Bot.cmd` 调用 `start-all-background.ps1`：

1. Node 控制器创建或复用 `data/bridge-token.txt`，加载模型和持久文件，在回环端口监听。
2. Headless 脚本读取同一令牌与配置，同步 mod，清除即将传给 JVM 的所有模型密钥。
3. Java 25 静默启动 HeadlessMc/Fabric 客户端。
4. Fabric mod 用令牌连接 Node，自动连接服务器并完成 EasyAuth。

两个主要进程都用 `Start-Process -WindowStyle Hidden`，标准输出和错误写入日志。PID 文件不仅记录数字，还记录可执行文件、项目根和入口；停止脚本会核对所有权，避免误杀复用同一 PID 的无关进程。

`Start-Bot.cmd` 不负责打开 WebUI；使用 `Open-WebUI.cmd`。`Stop-Bot.cmd` 停止 Node 和 Minecraft 客户端，WebUI 有单独停止脚本。

### 6.3 运行状态含义

| phase | 含义 |
| --- | --- |
| `starting` | Node 已加载配置并开始初始化 |
| `waiting_for_client` | Node 桥在等待 Fabric Java 客户端 |
| `connected` | Java 已通过桥 hello，但未必已经进入世界 |
| `in_world` | 已收到 `joined_world`/状态，任务才具备世界上下文 |
| `disconnected` | Fabric 桥断开 |
| `stopped` | Node 正常停止 |

WebUI 的“AI 控制器”“Minecraft 客户端”卡片来自 PID 所有权检测；“客户端已连接”来自 `data/runtime-status.json`。这两类状态来源不同，诊断时不能混为一谈。

## 7. 聊天寻址与玩家隔离

`AddressingEngine` 的判断顺序：

1. 消息包含 Bot 游戏名、人设名，或以 `!` 开头：置信度 1，明确交给 Bot。
2. `requireMention=false` 且 `contextualAddressing=false`：接收所有聊天。
3. 开启语境寻址时，如果同一玩家在 `conversationWindowMs` 内继续对话，且距离不超过 `directAddressDistance * 2`，视为延续对话。
4. 否则，发言者需在直接距离内，句式像命令或问题，并且是最近玩家或附近没有其他可能接收者。
5. 未明确点名 Bot、又明确称呼附近其他玩家的消息会被忽略。
6. 远距离或多人场景中证据不足的消息会被忽略。

默认直接距离 8 格、延续窗口 60 秒。Nearby player 世界状态只包含 32 格内玩家，因此更远玩家无法参与距离仲裁和语境寻址。

Bot 知道 `server.username` 与 `persona.name`，玩家不必每句话叫它名字。该机制是可测试的启发式规则，不是通用自然语言会话归属模型；方言、模糊代词和复杂群聊仍可能误判。

每位玩家的长期记忆 key 优先使用 UUID，缺少 UUID 时用小写名称。给模型的上下文只包含当前玩家专属事件/事实和全局事件，不会把另一位玩家的专属事实混进来。未被寻址的旁听聊天仍会按发言者记录，但不会触发任务。

## 8. 持久任务队列与多人优先级

`data/tasks.json` 为 schemaVersion 1，任务状态为 `queued/running/completed/failed`。全局最多一个 `running`；任务进入运行态时 `attempts` 加一。

### 8.1 仲裁顺序

精确优先级：

1. 纯“停止/取消”消息走带外停止路径，立即取消当前全局运行任务并向 Java 发送 `stop`。任何被寻址玩家都能触发，当前没有主人专属限制。
2. 普通队列中，只要有 `ownerName` 的任务，所有非主人任务都等待。
3. 主人的多项任务按 `urgency` 降序，再按入队序号 FIFO。
4. 没有主人任务时，先按发令者分组，选择与 Bot 实时距离最近的发令者；距离未知按无限远处理。
5. 距离相同按该玩家最早任务序号，再按稳定 key 排序。
6. 选中玩家后，其内部仍按 `urgency` 降序和 FIFO。

默认主人是 `wraaaaaa`，匹配不区分大小写。默认仲裁窗口 350ms，让近乎同时到达的消息先共同入队再选择。

### 8.2 紧急度启发式

- 100：停止、取消、救命、立刻、着火、溺水、危险、保护等。
- 80：末地、下界、战斗、守卫、回家、避难、低血等。
- 60：采集、挖掘、合成、制作、建造、准备、装备等。
- 50：跟随、过来、陪同等。
- 30：其他消息。

这是本地关键词规则，不是模型对所有任务“轻重缓急”的完整理解。它只在同一个发令者内部排序；主人优先级永远高于非主人紧急度。

### 8.3 恢复与终态

- 启动或控制器重新连接时，遗留 `running` 任务重新排入队列并增加 `requeueCount`。
- 动作中 Fabric 断线会暂停 drain 并把当前任务重新排队。
- 任务完成/失败终态先写入磁盘，再尽力发送聊天、写事实或经验；回复发送失败不会把任务改回运行。
- 明确停止会把旧运行任务标记失败，再创建并完成一个高优先级停止任务。
- 每次危险准备、主动作和采集后的掉落收取返回后都会复核 `cancellationEpoch` 与当前 task attempt；动作等待期间收到 stop 时，旧任务不能再写完成终态或发送迟到回复。
- 玩家任务或空闲自发展执行 `gather_resource` 成功后，Node 立即串联 `collect_own_drops`。只有自有掉落实进入背包才整体成功；方块已破坏但收取失败会保留精确的部分完成原因并写失败经验。
- 断线发生在服务器已经执行动作、但结果尚未返回时，重试可能重复非幂等动作。当前没有跨重启的动作幂等账本，采集/建造测试必须关注这一点。
- 任务文件当前不自动裁剪；长期运行需要后续增加归档或保留策略。

### 8.4 当前不是多步骤规划器

每条玩家消息产生一个任务，一次模型调用只返回一个动作。危险任务可自动插入一次 `prepare_for`，但不会把“收集木头、做工作台、做工具、挖矿、熔炼、建房”自动拆成可恢复的依赖图。多条玩家消息会排队；单条复合目标仍可能被拒绝或只完成其中一个动作。

## 9. 模型接入和决策流水线

### 9.1 供应商

- `deepseek`：`<baseUrl>/chat/completions`，JSON object 输出。`none` 关闭 thinking；`low/medium/high` 当前统一映射成有效 `high`，`xhigh/max` 映射成 `max`。
- `volcengine`：`<baseUrl>/chat/completions`，原样传递 `reasoning_effort`。
- `openai`：`<baseUrl>/responses`，使用 Responses API 的 `reasoning.effort`、低 verbosity 和 `max_output_tokens`。

`model.model` 是开放字符串，代码不会维护“全系模型白名单”。某个模型是否接受 `response_format`、thinking 或 reasoning 参数，必须用 WebUI 的最小模型测试确认；不能因为 provider 名称受支持就声称该供应商所有模型都通过。

`model.baseUrl` 必须是 HTTPS，仅 `127.0.0.1/localhost/::1` 测试端点可用 HTTP。超时允许 1 秒到 600 秒，最大输出允许 128 到 131072，但游戏决策通常不需要很大预算。

### 9.2 一条任务的完整顺序

1. 寻址层决定消息是否发给 Bot。
2. 消息经过持久化脱敏，写入当前玩家记忆并进入任务队列。
3. 本地安全层先拒绝索取秘密/本地配置的请求，不调用模型。
4. 加载当前玩家记忆、相关失败经验和最新结构化世界状态。
5. 系统提示和用户载荷再次脱敏后调用模型。
6. 解析唯一 JSON 对象；回复限制为单行 240 字，动作类型和参数本地归一化。
7. `CapabilityAssessor` 检查客户端、目标、物资、配置和危险度。
8. `PolicyEngine` 执行不可绕过的财产与自卫规则。
9. 挖矿、战斗或末地相关任务先执行 `prepare_for`。
10. Fabric 客户端执行动作并返回后置条件结果。
11. 失败写经验；成功写任务终态和模型选择的可选稳定事实。
12. 回复再经过聊天出站密钥过滤。

模型输出不是权限。任何未在白名单中的动作会变为 `none` 或失败；模型不能直接声明某方块“天然生成”从而绕过区域验证。

### 9.3 有效模型动作

模型提示词公开的动作：

- `none`、`stop`
- `follow_player`、`come_to_player`、`look_at_player`、`wander`
- `eat_best_food`、`attack_hostile`
- `equip_best`、`prepare_for`
- `use_item`
- `collect_own_drops`
- `gather_resource`
- `craft_item`
- `seek_shelter`、`build_shelter`、`wait_safe`

`attack_player` 只给本地自卫链路使用，默认模型合约不公开它。`break_block` 会被解析器拒绝并要求改用 `gather_resource`。`open_container` 虽有内部类型和策略分支，但 Fabric 执行器没有实现，也未对模型公开。

## 10. 本地控制器技术细节

### 10.1 调度与抢占

Java 客户端每 tick：

1. 检查桥断线、世界切换和死亡并取消旧会话控制。
2. 处理桥动作。
3. 运行本地生存控制器。
4. 若正在进食或战斗，清除普通移动输入；否则依次运行 Primitive、Shelter 或旧移动目标。
5. 每 20 tick 发送一次 schema v2 状态。

Primitive 与 Shelter 互斥；显式生存动作也不与它们并发。自动生存紧急状态能暂时压过其他移动，紧急状态结束后未完成的 tick 任务继续。`stop`、死亡、世界断开和桥断开都会取消当前控制器并释放按键。

### 10.2 `SurvivalController`

自动生存由 `autonomy.enabled` 控制；即使关闭自动能力，玩家显式请求进食/攻击敌对生物时仍可临时启用。

进食：

- 条件是生命值不高于 `lowHealthThreshold` 或饱食度不高于 `eatBelowFood`。
- 只接受同时具有 FOOD 和 CONSUMABLE 组件、当前可食用且没有消费效果回调的确定性安全食物。
- 优先快捷栏；背包里有安全食物时通过正常容器 SWAP 移到快捷栏。
- 只有观察到服务端同步后的物品数量减少才把显式动作判为成功。
- 3.25 格内有立即威胁时会中断进食。

敌对生物：

- 候选必须是活着的 `Enemy`，正在以 Bot 为目标、刚伤害过 Bot，或处在短期威胁记忆中。
- 自动排除 Creeper、Enderman、AbstractPiglin 和 ZombifiedPiglin，避免高风险误战。
- 选择最近威胁，挑快捷栏最佳可用武器，并检查可攻击、视线、合法攻击距离和至少 0.9 冷却。
- 成功仅表示真实调用了一次攻击，不表示造成伤害或击杀。
- 不会追击超出攻击距离的目标，也没有格挡、射箭、盾牌或走位 AI。

安全评估检查死亡、血量、饱食、着火、岩浆、低氧、坠落、脚下稳定性、夜间露天、可刷怪方块光和 12 格内敌对生物。它能判定“不安全”，但不等于已实现所有脱险行为。

### 10.3 `PrimitiveTaskController`

控制器是单活动任务的 tick 状态机，所有完成结果要求可观察后置条件。

`equip_best` / `prepare_for`：

- 通过正常玩家背包点击装备四个护甲槽。
- 工具根据目标方块挖掘速度、正确掉落能力、附魔和安全耐久评分。
- 武器根据攻击伤害、速度、武器组件、附魔和安全耐久评分。
- `general/mining/combat/end_combat` 使用不同选择目的。

`use_item`：

- 可按稳定 `itemId` 选择物品。
- 目标在主背包而不在快捷栏时，通过正常容器 `SWAP` 移到快捷栏，并等待服务端 stateId 和物品指纹确认；菜单改变、鼠标游标非空或超时都会失败。
- 只有数量、耐久、生命/饱食或冷却出现可观察变化才成功。
- 连续使用但没有上述变化的模组物品可能被诚实判为不支持。

`gather_resource`：

- 必须启用 `autoGather` 且配置明确批准的维度/AABB。
- 每个目标必须处于已加载区域、匹配稳定方块 ID 或 tag、可破坏、没有 block entity。
- 内建别名包括木头/原木、主世界石头、煤、铁、铜、金；也接受合法方块 ID 或 `#tag`。
- 搜索范围是 Bot 附近最多 12 格并裁剪到开发区，不是全图搜索。
- Bot 或目标附近出现小于荒野距离的其他玩家时立即安全取消。
- 需要正确工具的方块若没有足够耐久的正确工具就拒绝。
- 通过正常 start/continue destroy；只有观察到原方块状态改变才计数。
- 新出现的附近掉落登记为 Bot 自己产生的 provenance。
- Primitive 只负责采下并登记掉落；AgentController 在采集成功后自动执行一次 `collect_own_drops`，把“资源进入背包”作为玩家任务和空闲自发展采集的整体后置条件。

`collect_own_drops`：

- 只接受仍可见、entity ID/UUID/itemId 一致、未过期的已登记掉落。
- provenance TTL 为 5 分钟且只在 Java 内存中存在。
- 没有登记证据时拒绝，避免拿走玩家物品。
- 只有背包中对应物品增加才成功。

`craft_item`：

- 只使用已解锁的客户端 recipe book 配方。
- 只支持宽高不超过 2x2 的 shaped 配方，或最多四种输入的 shapeless 配方。
- 需要正常玩家背包菜单和空鼠标游标。
- 通过正常放置配方与 quick-move，观察目标物品数量增加后成功。

### 10.4 `ShelterController`

`build_shelter` 前置条件：

- 开发区已开启、维度匹配、整个建筑目标都位于 AABB 内。
- 所有其他玩家与 Bot/建造点至少保持配置的荒野距离。
- 8 格内没有敌对生物，门位没有红石信号。
- 找到已加载、稳定、无方块实体、无需破坏保护方块的平整 3x3 地面。
- 背包已有 23 个同种适合的普通完整方块、1 个可手动开启的门物品和 1 个原版普通火把。
- 默认方块预算 64，安全小屋实际最少占 26 个世界方块：23 个外壳位置、双格门和火把。

施工顺序为门、火把、外壳。所有放置使用正常 `useItemOn`，并等待服务器状态稳定。门的上下半块、朝向、铰链、OPEN、POWERED 必须一致，最终关闭且无供电；照明必须是 `minecraft:torch`，室内方块光必须高于维度刷怪阈值。外壳是 3x3 外围两格高加完整屋顶，室内为 1x1。

成功后写入家位置。若 `MCAI_HOME_FILE` 未配置，只保留内存；正常启动器把它指向经过路径限制的 `storage.autonomyFile`。文件格式：

```json
{
  "version": 1,
  "dimension": "minecraft:overworld",
  "x": 0,
  "y": 64,
  "z": 0,
  "doorX": 1,
  "doorY": 64,
  "doorZ": 0,
  "updatedAtEpochMs": 0
}
```

这只是字段示例，不是实际家坐标。写入使用同目录临时文件和原子移动；不生成 `.bak`。读取限制 16 KiB，并验证维度 ID、世界边界、门必须与室内水平相邻。

`seek_shelter` 的目标顺序：

1. 同维度且仍满足门和光照验证的已记录家。
2. 附近合适的床；只在可睡眠条件下交互。
3. 附近物理稳定、无危险、光照合格的测量安全点。

回家时会移动到门外、打开并确认门、进入室内、确认门口没有实体、关闭并确认门，最后检查室内光照和安全。移动仍是保守直线前进加碰撞跳跃；卡住或交互不被服务器确认就失败。

施工中途失败不会撤回已经放置的方块，因为自动回滚可能造成更大破坏。后续必须增加施工账本、可恢复阶段和管理员清理工具。

### 10.5 危险任务装备门槛

带末地/末影龙语义的任务在实际动作前自动执行 `prepare_for/end_combat`。门槛是：

- 头、胸、腿、脚四槽都有护甲。
- 每件护甲达到“附魔黄金”等效分数或更高；更高材质可无附魔达到等效值。
- 武器达到同等门槛且剩余耐久至少 5 点或最大耐久的 20%。
- 四件护甲也满足相同耐久余量。
- 背包至少 16 个可识别安全食物。

控制器先装备当前拥有的最佳物品；缺少材料、附魔、耐久或食物时返回每一项 gap 并拒绝冒险。它不会为了通过门槛自动完成采矿、熔炼、制造和附魔链。

### 10.6 主动空闲循环

Fabric 每 15 秒触发一次 Node 主动 tick。没有排队/运行任务且 `autonomy.enabled=true` 时：

1. 低血或低饱食：`eat_best_food`。
2. 有正在以 Bot 为目标的敌对生物且血量高于 critical：`attack_hostile`。
3. 夜间或当前不安全：`seek_shelter`；失败后仅在允许建造且有开发区时尝试 `build_shelter`。
4. 安全时：`wait_safe`，停止移动并警戒。
5. 满足 `chat.proactiveEnabled`、`proactiveIdleMs` 和 `proactiveMinIntervalMs` 后，调用一次模型的 `safe_idle_self_development` 决策。
6. 空闲模型一次最多选择一个动作：`none/wait_safe/eat_best_food/equip_best/prepare_for/attack_hostile/collect_own_drops/gather_resource/craft_item/use_item/seek_shelter/build_shelter`。
7. 动作仍须通过相同的 capability 与 policy 检查。空闲模型禁止跟随、接近、注视或攻击玩家，也不能越出批准区采集/建造。
8. 空闲采集会先按需要准备工具，采下后自动收取本次自有掉落；失败原因写经验。只有动作成功且期间没有玩家任务时，才可发送模型的可选自然回复。

玩家任务优先于空闲自发展：模型决策前后都会查看队列，玩家任务到达时会向正在运行的主动动作发送 `stop`；准备后和采集后也再次检查是否被抢占。`player_task_preempted` 不写成学习失败。

该循环已经具备受限的一步自发展能力，但不是长期规划器：每个间隔只有一个模型动作，不会自动拆解资源链，也不会持久写入 TaskStore。它仍不支持农业、狩猎、工作台、熔炼、附魔、跨区域探索或完整发展路线。`chat.proactiveEnabled` 当前同时控制主动模型自发展和可选闲聊，参数名比实际职责更窄，后续可拆成独立开关。

## 11. 本机桥协议与 WorldState schema v2

### 11.1 传输安全和生命周期

- TCP UTF-8 JSON Lines，每条消息一行，最大缓冲 1 MiB。
- protocolVersion 当前为 1。
- Node 只监听 `127.0.0.1/localhost/::1`，拒绝非本机来源和第二个同时连接的客户端。
- 正常脚本创建并复用 `data/bridge-token.txt`，Java hello 携带同一 token，Node 用定时安全比较验证。
- token 不是每次启动自动轮换；在两个进程停止后删除该文件，下次 Node 启动会生成新值。
- 手工运行 Node/Java 时若没有正确设置同一 `MCAI_BRIDGE_TOKEN`，会失去正常脚本提供的认证保证或无法连接，因此正式部署必须走启动脚本。
- Java 断线后约每 2 秒重连；检测到已连接到断开转换时释放移动、取消控制器并丢弃旧会话命令。

Java -> Node 事件：`hello`、`joined_world`、`state`、`player_chat`、`game_message`、`attacked_by_player`、`death`、`respawn_requested`、`respawned`、`action_result`。

Node -> Java 动作信封：

```json
{"type":"action","id":"unique-id","action":{"type":"wait_safe"}}
```

Java 终态：

```json
{"type":"action_result","id":"unique-id","ok":true,"detail":"postcondition detail"}
```

普通动作使用 `server.actionTimeoutMs`。装备、使用物品、采集、合成等长动作至少 120 秒；住所动作至少 180 秒。Node 超时会另发 `stop`，但不能撤销服务器已完成而结果丢失的动作。

### 11.2 schema v2 原始状态

`WorldStateEncoder` 每 20 tick 输出：

- `schemaVersion: 2`、单调 `seq`、`observedAt`、`connected`
- 位置、生命/最大生命、饱食/饱和、维度
- physical：空气、最大空气、着火、水下、岩浆、落地、坠落距离
- 当前快捷栏槽
- 背包：稳定 itemId、显示名、数量、槽位、耐久 damage/max/remaining/fraction、附魔 ID/等级
- 装备：mainhand/offhand/head/chest/legs/feet 等有效槽
- environment：世界时钟、日内时间、夜晚、天光维度、可见天空、方块/天空/原始光、刷怪光阈值
- 24 格内敌对生物：entity ID、UUID、typeId、距离、生命、视线、目标关系和自动战斗排除标志
- 24 格内掉落：entity ID、UUID、itemId、数量、距离、年龄、拾取延迟
- `safeToIdle`、`safetyReasons`、`survivalMode`、`survivalDetail`

`MinecraftAiBridgeClient` 再加入：

- `type: state`
- `activePrimitive`
- `timeOfDay`
- 32 格内玩家的名称、UUID、距离
- 可选 home：维度、室内坐标、门坐标、是否来自持久文件

Node 会把 v2 和部分旧字段归一化成 `WorldState`，例如 `hostiles` -> `nearbyHostiles`、`drops` -> `nearbyItems`、physical -> 顶层 air/fire/water/onGround。保留兼容读取是为了滚动升级，不代表可以长期让 Node 和 Java 使用不同版本。

### 11.3 聊天兼容

优先使用 Fabric CHAT 事件获得玩家名/UUID。部分插件把消息包装成 GAME 消息时，Node 支持解析形如 `<[前缀]玩家名> 内容` 的装饰聊天。相同玩家和文本在 1500ms 内去重。解析规则是严格启发式，插件格式改变时应补测试，不要放宽到可能把系统消息当玩家指令。

## 12. 持久化、备份与迁移

### 12.1 文件含义

| 文件 | 格式和作用 | 备份行为 |
| --- | --- | --- |
| `data/memory.json` | schema 1；Bot 名、分玩家档案、facts、事件、全局摘要字段 | Node 原子写入，覆盖前复制上一代到 `.bak` |
| `data/experience.json` | schema 1；失败任务、上下文、lesson、correction、tags | 同上 |
| `data/tasks.json` | schema 1；顺序、状态、尝试、重排、结果/错误 | 同上 |
| `data/autonomy-state.json` | Java 住所 version 1；家和门坐标 | 临时文件+替换，不创建 `.bak` |
| `data/runtime-status.json` | Node 运行 phase 和最后 WorldState | Node 原子写入并有 `.bak`，不是业务备份 |
| `data/bridge-token.txt` | 本机桥凭据 | 无备份；可在完全停止后删除并重建 |
| `data/*.pid.json` | 后台进程所有权 | 不应迁移到另一目录或机器 |

Memory 事件最多保留 `storage.maxEvents`，超出时删除最早事件；玩家 facts 不随该上限裁剪。`conversationSummary` 和 `globalSummary` 字段已存在，但当前没有自动摘要器更新它们。

经验系统只在装备准备或动作失败时自动添加条目，未来任务按 tag/词元匹配最多取相关记录。`verified` 默认 false、`timesApplied` 默认 0，当前没有自动闭环改变它们。因此“避免重复错误”依赖模型采纳 correction，并非强保证。

### 12.2 恢复规则

- `AtomicJsonFile` 遇到文件不存在会创建默认文件；遇到损坏 JSON 会报错，不会自动用 `.bak` 覆盖。
- 恢复前先停止所有进程，复制损坏文件留证，再人工验证 `.bak` 后替换。
- `.bak` 只保存上一次成功写入前的一代，不能代替定期外部备份。
- 如果主记忆和 `.bak` 都被误删，项目无法凭空恢复历史；“误删可恢复”只成立于用户保留了记忆文件或外部备份。
- 跨机器迁移至少保留 memory、experience、tasks、autonomy-state 和相应本地配置；不要迁移 PID、日志、bridge token 和整个 `.runtime`。
- WebUI 当前能显示并下载 memory/experience，也显示 tasks；没有经过验证的在线编辑/导入接口。需要修改时应停机、备份、校验 schema 后操作。

## 13. 安全边界

### 13.1 密钥防泄露

`SecretGuard` 同时保护模型输入、持久化和聊天出站：

- 已知实际值：API Key、EasyAuth 密码、真实 server host、当前项目绝对路径。
- 通用形状：常见 API key、Bearer、JWT、`/login`、`/register`、password/token/key 赋值。
- 索取 API Key、密码、令牌、`.env`、环境变量、系统提示词、本地配置、服务器地址或域名的请求，在模型前本地拒绝。
- 模型回复若含已知秘密或通用秘密形状，游戏内发送统一拒绝文本。
- Logger 递归清理错误、对象 key、登录命令、Bearer 和已知值。
- Fabric GAME 消息在送桥前清理登录命令和实际 EasyAuth 密码。

`start-headless-client.ps1` 在创建 JVM 之前显式删除进程环境中的 DeepSeek、ARK、OpenAI 和当前模型密钥。第三方 Minecraft mod 只继承 EasyAuth 所需密码和本机运行变量，不继承模型 API Key。

这些是纵深防御，不是形式化信息流证明。不要在提示词、文件名、命令行参数或测试夹具中写真实秘密，也不要把实际 `.env` 内容打印到对话或 CI 日志。

### 13.2 行为准则

`config/behavior-rules.json` 默认：

- 禁止破坏玩家财产。
- 禁止打开玩家容器。
- 禁止拿走玩家物品。
- 只允许荒野自主发展。
- 允许短窗口自卫，但不允许玩家命令主动 PVP。
- 归属未知时禁止破坏。

方块安全不能靠模型声称 ownership。`gather_resource` 由 Fabric 在开发区内选择并逐块验证；`collect_own_drops` 要求 provenance。`build_shelter` 只替换无方块实体的可替换空间，不破坏已有保护方块。

玩家攻击由 mixin 上报后，PolicyEngine 记录默认 15 秒自卫窗口并发送一次 `attack_player`。这表示尝试一次正常客户端反击，不表示伤害命中，也不是持续追杀。当前 `allowPlayerOrderedPvp=false`，模型合约也不公开玩家攻击动作。

### 13.3 WebUI 和本机威胁模型

WebUI 固定绑定 `127.0.0.1`，验证 Host/Origin，设置 CSP、nosniff 和 no-store，并限制配置/皮肤/存储路径在项目允许目录内。它没有登录认证；能登录这台 Windows 机器的本地用户可访问。因此不得用端口转发、反向代理或把监听地址改成公网。

## 14. WebUI 能力和限制

WebUI 当前可：

- 编辑 bot、persona、prompts、skin、behavior rules、mods。
- 安全保存或删除 `.env` 中四类秘密，只显示存在状态。
- 选择 DeepSeek、火山引擎、OpenAI，模型名、Base URL、推理强度、超时和输出预算。
- 设置服务器、LAN、EasyAuth、自动复活、聊天、任务仲裁、生存阈值、荒野距离和开发区。
- 查看 Node/Java PID 状态、运行 phase、最后世界状态、日志尾部、任务、记忆和经验。
- 启动、停止、重启 Bot。
- 发现 LAN 世界、同步 mod。
- 导入并校验皮肤、生成玩家分发包。
- 下载 memory/experience JSON。
- 发起一个最小模型连通性测试。

保存全部设置后，正在运行的 Node/Java 不会热重载；必须点“重新启动”。Memory/experience 当前只能查看和下载，不能在运行中安全编辑或恢复上传。

WebUI 进程本身独立于 Bot；关闭浏览器标签不会停止 WebUI或 Bot。修改 `MCAI_WEBUI_PORT` 后 Host/Origin 规则会使用新端口。

## 15. Minecraft、模组、LAN、EasyAuth 和复活

### 15.1 模组同步

本机服务器要求 mod 的历史来源目录是 `D:\开发\进服必须mod`，但真实路径只应写入忽略的 `config/mods.json` 或 WebUI，不要写入公共示例。未来服务器增加 mod 时：

1. 更新本地 mod 来源目录。
2. 在 WebUI 执行同步，或运行 `npm run sync:mods`。
3. 同步器先删除上一份 `managed-mods.json` 管理过的文件，再复制当前来源 jar。
4. 默认排除来源中的 Fabric API 和本项目 bridge，保留项目锁定版本。
5. 每个复制 jar 记录名称、大小和 SHA-256。
6. 重新构建/准备 Fabric 客户端并实际进服。

复制成功只证明文件一致，不证明客户端 mod 在 Headless/LWJGL 环境兼容。需要窗口、渲染、音频或特定认证的 mod 可能让启动失败。遇到问题应从客户端日志定位具体 mod，不要随意删除服务器声明必需的 jar。

### 15.2 直连和 LAN 兼容模式

- `direct`：使用本地 `server.host/port`。
- `lan`：强制 `auth=offline`，通过 UDP 4445 发现 Minecraft “对局域网开放”广播，使用第一个发现结果。

LAN 失败时确认人类世界已开放到 LAN、Windows 防火墙允许 UDP 4445、双方在同一广播域，并延长 `lanDiscoveryTimeoutMs`。VPN、虚拟网卡或路由隔离可能改变发现结果；必须在真实局域网测试。

### 15.3 EasyAuth

Fabric 接收 GAME 消息并识别 `/register` 或 `/login`。若允许注册则发送 `register <password> <password>`，否则发送 `login <password>`；没有识别到提示时约进入世界 100 tick 后发送 login。命令通过正常客户端 command API 发送，日志和桥消息会脱敏。

注意：`easyAuth.loginDelayMs` 在 Mineflayer 路径可能有用途，但当前 Fabric Java 回退时机没有接线到该字段。若要统一，应新增 Java 环境变量、启动脚本映射和测试，而不是只改文档。

### 15.4 自动复活

死亡时：

- 清除移动并取消生存、Primitive、Shelter 当前任务。
- 发送 death 状态并记录游戏事件。
- 等待 `respawnDelayMs` 对应 tick 后调用 `LocalPlayer.respawn()`，关闭死亡界面。
- 发送 requested/respawned 事件并记录复活。

Node 当前会把因死亡返回的一般动作失败写成失败经验；不会自动从死亡点恢复原动作。任务若因桥断线才会重排，死亡不是断线重排条件。

## 16. 皮肤、披风和语音

### 16.1 皮肤

WebUI 只接受标准 Minecraft PNG：现代 64x64 或旧版 64x32，手臂模型为 `classic` 或 `slim`。导入后：

- 原文件：`data/skins/<Bot名>.png`
- Bot 隔离客户端：`.runtime/minecraft/CustomSkinLoader/LocalSkin/skins/<Bot名>.png`
- 官方未修改万用皮肤加载器：`vendor/custom-skin-loader/CustomSkinLoader_Universal-15.0.1.jar`
- 给其他玩家的包：`.runtime/skin-pack/Minecraft-AI-Skin-Pack.zip`

`client_pack` 模式下，每个需要看到 Bot 皮肤的玩家都必须把 zip 内容复制到自己使用的 Minecraft 实例并重启。LocalSkin 是客户端本地查找，不会因为 Bot 安装了 mod 就自动广播给别人。

长期多人服更适合所有玩家共同配置兼容在线皮肤站，并让离线 Bot 名对应同名角色。`microsoft` 模式只是配置预留；当前 Headless Microsoft 自动登录未实现。

### 16.2 披风和语音

`skin.capeFile` 和 `data/capes` 只预留本地路径。正版官方披风不能用普通 PNG 伪造，必须由实际拥有披风的 Microsoft 账号提供；离线多人披风也需要共同皮肤站/客户端资源方案。

Simple Voice Chat 目前没有 API 适配、语音识别、TTS、麦克风或扬声器管线。历史环境曾能把其 jar 作为客户端 mod 加载，但 Headless 环境无音频设备不等于“已适配语音”。文本和结构化动作不依赖语音。

## 17. 中国大陆网络设计

已实现的路线：

- `.npmrc` 使用 `https://registry.npmmirror.com`，锁文件依赖也指向 npmmirror。
- Minecraft 版本元数据/客户端使用 BMCLAPI，按官方 SHA-1 和 size 校验。
- Minecraft 库默认使用 CERNET BMCLAPI 路径，按元数据 SHA-1 校验。
- HeadlessMc 默认先尝试 GitHub 下载镜像，再回退官方 URL，固定 SHA-256 校验。
- Fabric API 固定版本和 SHA-256，可用 `MCAI_FABRIC_API_URL` 指定可达镜像。
- 万用皮肤加载器二进制随仓库 vendor 并固定 SHA-256，运行时不必再访问 GitHub。
- WebUI 的 HTML/CSS/JS 全部本地提供，不依赖境外 CDN。
- 大模型可优先选择 DeepSeek 或火山引擎国内端点；OpenAI 是否可达取决于部署网络。

仍未完成的正式证明：

- 当前开发机使用全局美国 VPN，因此本机成功下载不构成“中国大陆无代理可用”验收。
- winget 源、GitHub 初次克隆、Fabric Maven/Gradle 和 Mojang/Loom server merge 仍可能在干净国内网络失败。
- `prepare-fabric-client.ps1` 的 Fabric API 默认 URL 是官方 Maven；国内环境应提供镜像覆盖，但仍必须匹配固定哈希。
- 应在一台无 Node、无 Java、无 Minecraft、无 VPN 的中国大陆 Windows 上从获取仓库开始完整测试，并记录每个失败点和镜像回退。

不得为了“能下载”关闭 TLS 或哈希校验。镜像只改变传输来源，完整性仍由官方哈希或项目固定哈希保证。

## 18. 验证策略

### 18.1 每次提交前的自动验证

在主仓根目录运行：

```powershell
npm run check
npm test
npm run build
Push-Location fabric-bridge
.\gradlew.bat build --no-daemon
Pop-Location
npm run audit
npm run audit -- --history
git diff --check
```

不要在文档里写“共 N 项测试”。以 `npm test` 当次输出为准。Fabric 当前主要验证是 Gradle 编译/构建，没有覆盖服务器行为的自动 Java 集成测试。

Java 改动后还要更新运行客户端：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-fabric-client.ps1
```

若本地 `config/mods.json` 配置了来源，也要重新同步。没有这一步，真实进服仍可能加载 `.runtime` 中的旧 bridge jar。

### 18.2 WebUI 验收

1. 双击 `Open-WebUI.cmd`，确认只监听回环地址。
2. 检查暖色界面、说明文本、所有设置读取/保存和重启。
3. 确认密钥只显示布尔存在状态，页面和 API snapshot 没有值。
4. 用最小模型测试一次，避免消耗有限 API 余额。
5. 检查 LAN 发现、mod 同步、皮肤 PNG 校验和分发包。
6. 检查 PID 状态、日志尾部、任务、记忆/经验下载。

浏览器测试最好自动化或保存截图，但不得把真实地址、玩家隐私或密钥放入截图后提交。

### 18.3 真实服务器安全验收顺序

低风险先行：

1. 启动后 phase 依次到 `waiting_for_client -> connected -> in_world`。
2. EasyAuth 成功，Bot 名称正确，真实 host 不出现在聊天/公开日志截图。
3. 不点名近距离发问、延续对话、远距离模糊聊天和明确称呼他人四种寻址。
4. `wraaaaaa` 与两个不同距离玩家近乎同时发令，核对任务顺序和分玩家回复。
5. 明确停止能取消当前动作。
6. 请求 API Key/密码/配置/服务器地址，确认模型前本地拒绝且数据文件无敏感值。
7. 跟随、前往、查看和安全等待。
8. 杀死 Bot，确认取消动作、延迟复活和恢复状态。
9. 给定食物后降低饱食/血量，确认实际消耗；用可控敌对生物确认合法攻击。
10. 检查装备选择与末地门槛不足的详细拒绝。

采集、合成、建造属于可能改变世界的测试，只能在管理员明确划定、可丢弃、远离所有玩家建筑的开发区进行：

11. 放置/选择天然测试资源，验证区外、玩家靠近、方块实体和错误工具均拒绝。
12. 验证方块真实改变、掉落 provenance、只拾取自己掉落和背包数量后置条件。
13. 用简单 2x2 配方验证真实合成；工作台配方应明确拒绝。
14. 提供 23 同种方块、门和火把，验证固定小屋、门上下半、关门、光照和家文件。
15. 重启客户端后执行 seek，确认家文件加载、开门、进入、关门和安全结果。
16. 在施工中途断线测试重复风险和部分建筑残留，记录但不要自动破坏清理。

目标服测试前必须征得管理员对开发区和破坏性步骤的明确许可。不得为了完成验收在玩家区域试挖或试建。

### 18.4 当前验收结论的写法

- 可以写：用户已确认进服和跟随。
- 只有当日志、状态、背包/方块后置条件和复测都支持时，才写某个新动作真实通过。
- 当前控制器源代码和编译成功不能替代真实 26.2 模组服验收。
- 本轮最终工作树已经完成第 2.2 节记录的 Node/TypeScript、Fabric clean build、WebUI 浏览器回归和真实服自动进食验证。任何后续代码改动都会使该快照失效，必须重跑并以新输出为准。

## 19. 故障排查

### 19.1 WebUI 显示已连接但两个进程停止

1. 查看 `data/bot.pid.json`、`data/minecraft-client.pid.json` 是否属于当前项目根。
2. 查看 `logs/background.stderr.log`、`logs/minecraft-client.stderr.log`。
3. 确认 `dist/src/index.js`、HeadlessMc jar 和 `.runtime/minecraft/mods/minecraft-ai-fabric-bridge-0.1.0.jar` 存在。
4. 用 `Start-Bot.cmd` 成对启动，不要只开 Java 或只开 Node。
5. 确认桥 host/port 相同且 `data/bridge-token.txt` 非空。
6. 如果项目移动过，删除已经停止进程遗留的 PID 文件；停止脚本会做所有权检查，不要手工杀不明 PID。

### 19.2 Bot 不回复

依次检查：

- phase 是否 `in_world`，EasyAuth 是否成功。
- 发言者是否在寻址距离内，消息是否点名 Bot、以 `!` 开头或满足会话延续。
- 装饰聊天格式是否仍能被 `chat-parser` 识别。
- `.env` 中当前 provider 对应 key 是否存在；WebUI 模型测试是否通过。
- `data/tasks.json` 是否卡在 running，Fabric 是否断线。
- `logs/bot.log` 的模型 HTTP 状态、JSON 解析、能力评估或动作失败原因。

通用“处理失败”回复意味着模型调用、解析或未分类异常失败；任务不会被当作完成。动作返回失败时应该回复具体服务器/控制器原因并写经验。

### 19.3 Bot 仍只有旧动作

最常见原因是 `.runtime` 仍加载旧 Java jar。重新运行 Gradle build 和 `prepare-fabric-client.ps1`，确认客户端完全停止后再启动。只改 `src/` 或只执行 `npm run build` 不会更新 Fabric 动作。

### 19.4 采集/建造拒绝

检查：

- `autonomy.autoGather` 或 `autoBuildShelter` 是否开启。
- `developmentZone.enabled`、维度和 min/max 是否覆盖 Bot 及全部目标。
- 48 格默认荒野距离内是否有其他玩家。
- 方块是否已加载、有 block entity、不可破坏或超出 12 格采集搜索。
- 工具耐久/类型、普通背包菜单和空鼠标游标。
- 建筑材料是否为同种完整方块，数量 23，且有手开门和普通火把。
- 地面是否平整、门位是否受红石供电、8 格内是否有敌人。

### 19.5 死亡不复活

确认本地 config 的 `server.autoRespawn=true`、延迟范围有效，启动脚本确实导出 `MCAI_AUTO_RESPAWN_ENABLED` 与 `MCAI_RESPAWN_DELAY_MS`。查看客户端日志是否有插件自定义死亡界面或拦截正常 respawn。

## 20. Git、隐私清理、推送和双目录同步

### 20.1 提交前

```powershell
git status --short --branch
git fetch origin
git rev-list --left-right --count HEAD...origin/main
git diff --check
git diff -- README.md README_AI.md PARAMETERS.md
git ls-files .env config/bot.json config/persona.json config/prompts.json config/mods.json config/skin.json data logs .runtime
npm run audit
npm run audit -- --history
```

`git ls-files` 对受保护路径应无输出。审计脚本会检查跟踪文本的严格 UTF-8、BOM、控制字符、双向/零宽字符、常见乱码、秘密形状、已知 `.env` 秘密和受保护路径；`--history` 扫描全部 Git 对象且不打印秘密值。

最终测试使用的 API Key 必须通过 WebUI 删除或从 `.env` 移除。即使 `.env` 已忽略，也要满足用户“完工后删除”的要求。真实服务器 host 可以留在忽略的本地 `config/bot.json` 供用户继续运行，但绝不能进入 Git 或截图。

### 20.2 提交和推送

只暂存明确审查过的文件：

```powershell
git add -- <explicit files>
git diff --cached --check
git diff --cached
git commit -m "feat: extend autonomous survival controls"
git push origin main
```

如果 `origin/main` 在本地之前，先确认工作树和提交安全，再采用非破坏性方式整合远端并重跑验证。禁止 `reset --hard`、强制 checkout、强推或覆盖其他 Agent/用户改动。推送成功后动态记录远端结果，不要把 SHA 固化在本文长期状态段。

### 20.3 同步旧目录

源代码以 Git 为唯一同步通道。主仓推送成功后：

1. 检查旧目录 `git status --short --branch`。
2. 旧目录干净时执行 `git fetch origin` 和 `git pull --ff-only origin main`。
3. 旧目录有改动时不要覆盖；报告冲突并由用户决定保留/合并。
4. `.env`、`config/*.json`、`data/`、皮肤和 mod 来源是忽略的机器状态，不会随 Git 同步。
5. 若确需迁移本地业务数据，停机后逐文件备份并校验目标；不要复制 PID、日志、bridge token 或整个 `.runtime`。

## 21. 已知技术债和下一阶段顺序

按优先级继续：

1. 在最终合并工作树上完成 Node 全套测试、Fabric build、仓库/历史审计和真实服务器低风险验收。
2. 为 Java 控制器增加可重复的单元/模拟集成测试；当前 Gradle 主要只能证明编译。
3. 引入可靠路径规划、危险地形规避、游泳/脱困/逃生和“到达”后置条件，替换直线按键移动。
4. 把一条复杂目标拆成持久任务图，记录前置、资源预算、幂等 key、恢复点和回滚策略。
5. 增加完整资源循环：自动寻找食物、农业/狩猎、工作台、3x3 合成、熔炼、锻造、附魔、装备维护。
6. 把当前“一次一个动作”的空闲自发展升级为可持久、可抢占、可恢复的安全计划，并把自发展开关与主动聊天开关分离。
7. 为采集掉落 provenance、施工账本和 home 增加跨重启持久化及断线幂等。
8. 支持更灵活但仍安全的住所设计，并提供管理员批准的清理/修复机制。
9. 为模组物品、工具、食物、方块和配方提供适配注册表；未知内容默认拒绝。
10. 增加记忆摘要、经验应用计数/验证、任务归档和 WebUI 安全导入/编辑流程。
11. 实现 Microsoft Headless 登录与正版皮肤/披风路径。
12. 在无 VPN 干净中国 Windows 上验证一键安装，补齐 Gradle/Fabric/Git 获取镜像回退。
13. 最后再研究 Simple Voice Chat API、虚拟音频和 TTS/STT；语音不得阻塞文本控制主线。

当前最重要的诚实限制：项目已经从早期的跟随基线扩展到真实动作控制框架，但距离“像人类朋友一样完整生存和长期发展”仍有明显差距。后续开发不能通过增加提示词假装完成；必须在本地控制器、状态后置条件、持久规划和真实服务器测试四层同时推进。

## 22. 交付完成清单

- [ ] `README.md`、`README_AI.md`、`PARAMETERS.md` 与实际代码一致。
- [ ] 示例只含 `你的域名.com`，没有真实服务器域名。
- [ ] 本地 API Key 已删除，EasyAuth 密码未出现在输出或 Git。
- [ ] `npm run check`、`npm test`、`npm run build` 以当次输出为准完成。
- [ ] Fabric `gradlew.bat build --no-daemon` 完成，新 jar 已复制到 `.runtime`。
- [ ] `npm run audit`、历史审计、`git diff --check` 完成。
- [ ] WebUI 设置、密钥、运行控制、mod、皮肤和下载路径完成浏览器验收。
- [ ] 真实服务器完成进服、EasyAuth、聊天、优先级、拒绝、复活和低风险动作验收。
- [ ] 采集/合成/住所只在管理员批准的可丢弃开发区测试，并记录后置条件。
- [ ] 中国大陆无 VPN 干净 Windows 验收结果明确；未测试就明确写“待验证”。
- [ ] 只暂存审查过的文件，提交前检查 cached diff。
- [ ] 推送 `origin/main` 成功后，再以 `--ff-only` 同步干净的旧目录。
- [ ] 未实现功能保留为限制/待办，没有写成已完成。
