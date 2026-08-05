# README_AI - Minecraft AI Player 完整交接手册

> 本文写给后续 AI Agent、维护者和审查者。面向普通用户的安装、部署和使用教程是 `README.md`，参数索引是 `PARAMETERS.md`。任何功能或参数变更都必须同时更新这三处中受影响的内容。
>
> 本文不得保存真实服务器地址、API Key、EasyAuth 密码、桥接令牌或玩家隐私。仓库中的服务器地址一律写成 `你的域名.com`。

## 0. 接手时先做什么

当前工作机有两个目录：

- 运行部署目录：含本机忽略配置和实服运行数据，开发与现场测试先在这里完成。
- Git 本地仓库：只接收经过审计的非隐私源码/测试/示例/文档，用于提交和推送；实际绝对路径不得写入公开文档。

主开发仓才是本轮编辑、验证、提交和推送的来源。不要同时运行两个目录里的 Bot，否则可能发生端口、PID、日志和配置冲突。换电脑后这些绝对路径自然失效，应以 `git rev-parse --show-toplevel` 的结果为准。

远端仓库为 `https://github.com/wraaaaaa/Minecraftaiplayer.git`，默认分支为 `main`。本文不把提交 SHA 或测试数量当作长期不变量；第 2.2 节只保留带日期的本轮验证快照，接手时仍要动态查询：

```powershell
$projectRoot = 'C:\path\to\minecraft-aibot'
Set-Location -LiteralPath $projectRoot
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

### 0.1 2026-08-05 最新交接增量（优先于历史记录）

- 人工 `developmentZone` 已取消。旧 JSON 字段只为升级兼容而解析，`autonomyConfig()` 删除它，WebUI 不显示，启动脚本不传坐标，Java 启动时清空遗留区域。AI 依据结构化环境选意图，Fabric 对每个实际目标执行天然性、玩家结构、方块实体、危险源、碰撞、玩家距离、撤退路线和服务端后置条件检查。
- 提示词运行源改为 `data/agent-prompts/{rules.md,IDENTITY.md,SOUL.md,TOOLS.md,MEMORY.md}`；每位玩家自动创建 `data/player-profiles/<uuid-or-name>/USER.md`。模板位于 `config/agent-prompts.example/`。`SOUL.md` 是核心人设；五份文档可在 WebUI 或本地直接编辑，每次模型决策前重新读取。
- `memory.json` 仍是统一原始记忆文件。`ContextCompressor` 在估算上下文达到预算阈值时保留最近事件，用当前模型总结较旧事件；先原子更新当前玩家 `USER.md`，成功后才写玩家/全局摘要并按事件 ID 原子删除已压缩事件，避免画像写入失败造成上下文丢失。
- 同类动作失败达到阈值后，`SelfImprovementManager` 可通过百度或自建 SearXNG 查找思路。搜索结果是不可信文本，只能用于生成 `TOOLS.md` 托管经验段和 `behavior-patches.json` 声明式补丁；程序不能自改 JS/Java/PowerShell、硬规则、启动脚本或秘密。这是“可进化”与供应链/远程代码执行安全之间的硬边界。
- 无持久住所时，主动循环不再反复调用 `seek_shelter`；没有建房材料则继续确定性发育。探索单个动作到达一个安全分段即成功，不再为了寻找“完全无人造痕迹区域”耗尽八段而超时。矿道使用导航器真实落脚格修复两格上行判断错误。
- 实服发现 `eat_best_food` 可因客户端长用物状态不释放而重复超时。现同时用物品数量、饥饿值和生命值判定成功，60 tick 卡住会释放并短暂退避，RPC 超时也强制清理。最新重启后饥饿值已从 19 实际升到 20，随后成功放置工作台、合成并放置熔炉。
- 地下狩猎无目标的上行回退曾卡在 `goal=1199,43,201`：导航器把狭窄通道边缘的实际脚部格重新投影到下一层。稳定着地/水中时 `standingBlockPos` 现直接采用服务器 `blockPosition`，腾空时才回退图节点投影，并增加 500 advanced tick 无验证进展看门狗。重建后同场景实测从 Y=43 到 Y=59，`verified_tunnel_steps=31; verified_broken_blocks=95; verified_support_blocks=1; inventory_delta=72`，随后继续制作工作台/木板。
- Windows 原子替换在文件被 WebUI/安全软件短暂占用时会报 `EBUSY`。`AtomicJsonFile` 现保留备份、有界退避重试，持续被禁删时降级为原位 UTF-8 写入；实服重启后运行状态持续刷新且未再形成写入错误风暴。
- 本轮新增测试覆盖提示词隔离、上下文压缩和受限自我改进；最终测试数以当前 `npm test` 为准，不将数量当作长期不变量。

## 1. 项目目标和不可变约束

项目目标是让大模型驱动的玩家以真实 Minecraft 客户端身份加入 Minecraft Java 26.2 Fabric 模组服，通过结构化状态和白名单动作接口像队友一样交流、执行任务、生存和发展。

不可变约束：

- 目标服务器是 `online-mode=false`，正式无界面启动当前只支持离线账号。
- 目标版本固定为 Minecraft 26.2、Fabric Loader 0.19.3、Fabric API 0.156.0+26.2、Java 25。
- Bot 没有人类视觉、听觉或鼠标键盘输入；DeepSeek 等模型只接收结构化游戏状态和文本。
- 正式适配器是 `fabric_bridge`。`mineflayer` 只保留为诊断回退，不能代表 26.2 模组服兼容性。
- Bot 进程、Minecraft 客户端和 WebUI 均应可静默后台运行。
- 不破坏玩家建筑、容器、农田、红石和物品；不确定归属时拒绝破坏。
- 自主采集和建造必须显式开启 `allowVerifiedWilderness`，由 Java 对每个候选目标动态校验天然地形、玩家结构、玩家距离、危险源和撤退路线；人工坐标框不能授权或限制行为。
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

### 2.2 本轮验证快照（2026-08-05，Asia/Shanghai）

- Node/TypeScript：本轮已运行 `npm run check` 与 `npm test`，当前工作树全部成功；数量不是长期不变量，最终同步后必须再跑 `npm run build`。
- Fabric：Java 25 `gradlew.bat build` 成功；最新 jar 已复制到隔离客户端并完成后台重启、桥握手和重新进服。
- 真实目标服已证明：木板/工作台/熔炉、完整五件石制工具、工作台与熔炉放置、模组安全食物识别和实际进食、自动复活。
- 向下矿道现场证据：从 Y=64 到 Y=48，破坏 76 个天然方块，石材背包增量 49。
- 向上开路现场证据：从洞穴稳定达到 Y=64，结果 `verified_tunnel_steps=11; verified_broken_blocks=34; inventory_delta=9; final_y=64`。修复过程覆盖脚手基础、跨列头顶碰撞、空中假落地和跌落旧目标。
- 真实服发现一次冰下追鱼溺亡，客户端聊天为 `wraaaaaa_ai drowned`。已实现 75% 氧气提前接管、水面出口 A* 和天然冰/雪顶破拆并通过 Java 构建；该新自救路径尚待下一次冰下现场复测。
- 下列动作已经有原生实现和后置条件，但本轮未完成从零连续现场验收：完整铁/钻石链、熔炼生食/矿物、村民交易、逐件附魔、床睡觉、下界门、要塞和末地。文档必须区分“实现/编译/单测”与“实服完成”。
- WebUI 已用真实浏览器重新回归：运行状态、五份全局提示词、八个现有玩家画像、声明式行为补丁均可读取；人工开发区控件不存在；对 `wraaaaaa` 的 `USER.md` 完成保存往返并恢复原文，未留下测试标记。浏览器控制接口本轮未提供控制台消息读取能力，因此不能声称“控制台 0 error”。
- 最新重启后的实服状态从饥饿 19 实际恢复到 20；接着依次确认自有工作台放置、熔炉 3×3 合成和自有熔炉放置。后续狩猎在当前加载区没有合法食物目标时返回 `no_safe_loaded_hunt_target`，规划器已改为开掘/探索回退，没有把失败伪装成成功。
- 上述回退的最终现场结果为 Y=43→59、31 步、95 个天然方块、1 个自有支撑、石材增量 72；结束后 `activePrimitive` 释放，并继续执行工作台和木板配方。

该快照不包含固定提交 SHA。测试数量不是固定期望；后续 Agent 必须按当前 HEAD 重新查询和运行测试，测试数量随代码变化是正常现象。

### 2.3 功能状态矩阵

| 能力 | 当前实现 | 必须诚实说明的边界 |
| --- | --- | --- |
| 进服/模组握手 | HeadlessMc 启动真实 Fabric 26.2 客户端，可同步服务器要求的客户端 mod | 不能保证任意新增 mod 都兼容；每次服务端变更后要重新同步和实测 |
| EasyAuth | 识别 `/register`、`/login` 提示并发送命令；无提示时约 100 tick 后回退登录 | Fabric 路径没有使用 `easyAuth.loginDelayMs`，当前回退时间是 Java 固定逻辑 |
| 自动复活 | 死亡后取消当前控制器动作，按配置延迟调用正常客户端复活 | 必须在实际服务器确认死亡界面和插件没有改变流程 |
| 聊天/回复 | 支持点名、`!`、近距离语境寻址；游戏出口经过密钥和内部调用术语双重过滤，只输出自然对话、完成确认或简短拒绝 | 寻址是规则启发式，不是完整语义理解；历史 `memory.json` 仍会保留升级前真实发出的详细回复 |
| 多人任务 | 持久化单执行槽队列；主人优先，其余按发令者距离仲裁；单次模型可输出最多 12 步工具计划 | `actions[]` 是当前任务内的顺序计划，不是可跨重启恢复的依赖 DAG |
| 跟随/前往/探索 | 有界 A* 保存路线并重规划；探索无路可破坏安全天然障碍；主人可用定位栏分段全图寻找；跟随目标被怪物攻击时暂停移动保护 | 不是全局 Baritone；门、梯子、藤蔓、跑酷和未知模组碰撞仍可能阻塞 |
| 自动进食/烹饪 | 饱食低于 20 即吃；26.2 `FOOD`/`CONSUMABLE` 支持模组熟食；储备不足会狩猎、准备自有工作台/熔炉并烹饪 | 未知模组食物副作用只靠已知有害名单；农业/繁殖未实现 |
| 自动对敌/狩猎 | 对实际威胁自卫和保护主人/跟随者；可狩猎成年未命名、未驯服、未拴绳的动物/鱼/任务怪并追踪掉落 | 中立高风险怪的自动反击仍保守；战斗 AI 不是竞技级走位 |
| 选装备/制造/附魔 | 制作五类石/铁/钻石工具、铁/钻石护甲、盾/桶；穿戴最佳装备；自有附魔台逐件附魔工具和护甲 | 暂无铁砧、锻造台/下界合金、药水和完整模组评分 |
| 采集/矿道 | 已加载资源直接采集；不可见资源按目标 Y 挖双格阶梯；天然障碍可开路，空洞可持久登记垫脚块；以最终稳定 Y 和背包增量确认 | 不透视；人造结构、危险流体和无法确认归属时停止 |
| 拾取自己掉落 | 只追踪并拾取本控制器注册的掉落实体 | 所有权账本在 Java 内存中，客户端重启后丢失；没有来源证据就拒绝 |
| 合成/容器生产 | 2x2/3x3 正常菜单；熔炉装料/加燃料/取出；村民可承担交易；附魔台装物品/青金石并选择可支付项 | 不操作玩家容器；没有酿造、铁砧、锻造台和村民职业刷新 |
| 建造住所 | 在动态验证的安全环境建固定 3x3 小屋，放门、火把、墙和屋顶，逐块确认 | 需要现成材料；不自动合成门/火把；中途失败不会回滚已放方块 |
| 寻找住所/睡觉 | 优先持久家与自有床；长期规划取得三份同色羊毛、制作/放床，夜间真实睡觉并以 `isSleeping()` 确认重生点 | 固定 3x3 住所，不是建筑生成器；床白天不会伪报睡眠 |
| 水下/安全挂机 | 水节点寻路；空气低于 75% 搜索可呼吸水面，无出口时尝试破坏天然冰/雪；只有安全评估通过才挂机 | 新冰下自救已编译部署但尚待现场复测；岩浆/火灾逃生仍以停止高风险动作和现有反射为主 |
| 空闲自发展 | 持久 `progression.json` 目标 `reach_end`，确定性推进食物、住所、床、全套装备、矿物、附魔、下界、要塞和末地；玩家任务/危险抢占 | 单个长期原语断线后由 Node 重试，不是任意依赖 DAG；完整端到端实服旅程未完成 |
| 记忆 | `memory.json` 统一保存原始事件；按玩家 UUID/名称隔离，自动加载对应 `USER.md`，达到预算阈值时压缩旧事件 | 压缩依赖当前模型；模型失败时保持原事件，不会冒险删除 |
| 经验/进化 | 失败写入经验；重复失败可研究公开资料并更新托管工具经验与声明式补丁 | 不是训练模型；不允许自改可执行代码、硬规则或秘密，补丁仍须通过原有能力/策略/Fabric 验证 |
| WebUI 总聊天 | 聚合记忆中的玩家/Bot 对话与 `data/diagnostics.json` 的结构化决策、步骤、后置条件和完整脱敏错误；独立 4 秒刷新和三种筛选 | 明确只展示可验证决策摘要，不提供或伪造模型隐藏思维链；诊断文件不是长期记忆输入 |
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
    |- PromptWorkspace + ContextCompressor + SelfImprovementManager
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
| `src/agent/basic-command.ts` | 高置信度自然命令的本地确定性动作与基础工具顺序计划，避免基本玩法依赖模型抽签 |
| `src/agent/autonomous-development.ts` | `reach_end` 确定性阶段规划：生存、食物/烹饪、住所/床、全套工具护甲、矿物、交易、附魔、下界、要塞和末地 |
| `src/agent/prompt.ts` | 旧 `prompts.json` 兼容组装；新部署由 PromptWorkspace 动态构建 |
| `src/agent/world-state.ts` | Node 内部规范化世界状态类型 |
| `src/tasks/task-store.ts` | 持久任务队列、原子仲裁、恢复和终态 |
| `src/progression/progression-store.ts` | 最高发育阶段、最近计划/结果、里程碑和按资源隔离失败计数；阶段单调不回退 |
| `src/security/secret-guard.ts` | 模型输入、持久化和聊天出站脱敏/拒绝 |
| `src/policy/policy-engine.ts` | 玩家财产、自卫、采集和建造硬规则 |
| `src/minecraft/fabric-bridge-client.ts` | 本机桥服务、事件归一化、动作超时、语境寻址 |
| `src/minecraft/minecraft-client.ts` | Mineflayer 诊断回退，不是正式模组适配 |
| `src/llm/provider-factory.ts` | DeepSeek、火山引擎 Chat Completions 与 OpenAI Responses |
| `src/memory/memory-store.ts` | 分玩家记忆和事件 |
| `src/memory/context-compressor.ts` | 达到上下文预算阈值时总结旧事件并更新摘要/当前玩家画像 |
| `src/prompts/prompt-workspace.ts` | 五份 Markdown、每玩家 `USER.md`、托管段和声明式补丁的路径/原子读写边界 |
| `src/self-improvement/self-improvement-manager.ts` | 失败签名、研究、冷却、受限提示词经验和声明式补丁 |
| `src/experience/experience-store.ts` | 失败经验和关键词检索 |
| `src/core/atomic-json-file.ts` | Node JSON 临时文件、替换和上一代 `.bak` |
| `src/webui/server.ts` | 仅本机 WebUI、设置、秘密、运行控制和下载接口 |

### 4.3 Fabric 客户端层

| 路径 | 作用 |
| --- | --- |
| `fabric-bridge/.../MinecraftAiBridgeClient.java` | 自动进服、EasyAuth、复活、动作调度、跟随保护、水面出口/破冰自救和状态发送 |
| `fabric-bridge/.../BridgeConnection.java` | Java 侧回环 JSONL 客户端和重连 |
| `fabric-bridge/.../WorldStateEncoder.java` | schema v2 背包、装备、环境、敌人、掉落和安全状态 |
| `fabric-bridge/.../SurvivalController.java` | 确定性进食、威胁识别、合法近战和安全评估 |
| `fabric-bridge/.../PrimitiveTaskController.java` | 装备、使用物品、采集、自己掉落、普通方块放置、背包 2x2 与工作台 3x3 合成 |
| `fabric-bridge/.../AdvancedTaskController.java` | 狩猎、保护战斗、熔炼、交易、附魔、睡觉、阶梯矿道、目标探索、下界门和跨维度/要塞流程 |
| `fabric-bridge/.../LocalPathNavigator.java` | 碰撞安全有界 A*、水节点、动态重规划、稳定上跳与逐格状态 |
| `fabric-bridge/.../WildernessGuard.java` | 天然方块、危险流体、玩家距离、人工结构和动态荒野硬边界 |
| `fabric-bridge/.../OwnedBlockRegistry.java` | 按维度/坐标持久记录并验证 Bot 自己放置的设施和支撑方块 |
| `fabric-bridge/.../OwnerLocator.java` | 读取服务器同步定位栏 waypoint，仅为最高优先主人提供远距离续航方位 |
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
- `config/agent-prompts.example/`（五份全局 Markdown、`USER.md` 模板、`behavior-patches.json`）
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
| `autonomy.eatBelowFood` | `20`，只要饱食度未满就触发安全进食/食物获取链 |
| `autonomy.hostileScanRadius` | `12` |
| `autonomy.wildernessMinPlayerDistance` | `48` 格 |
| `autonomy.safeIdleEnabled` | `true` |
| `autonomy.autoGather/autoCraft/autoBuildShelter` | 均为 `true`；既是能力许可门，也限制空闲模型可选择的安全自发展动作 |
| `autonomy.allowVerifiedWilderness` | `true`；允许 Fabric 逐目标动态验证，关闭时拒绝世界修改 |
| `autonomy.developmentZone` | 已废弃；仅解析旧配置，归一化后删除且运行时忽略 |
| `agentWorkspace.*` | 提示词/画像目录、48000 字符预算、0.72 压缩阈值、保留 16 事件、自我改进和中国环境研究端点；完整字段见 `PARAMETERS.md` |

人工坐标开发区不再参与决策。Fabric 为单次动作建立短生命周期的已加载工作窗口，并对候选逐格检查；采集检查 Bot/目标周围的其他玩家，建造在开始和施工过程中持续检查荒野距离。该窗口不持久化，也不能把人造结构变成可修改目标。

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

`start-headless-client.ps1` 根据 JSON 生成 `MCAI_SERVER_*`、`MCAI_BRIDGE_*`、`MCAI_EASYAUTH_*`、`MCAI_AUTO_RESPAWN_*`、`MCAI_AUTONOMY_*` 和 `MCAI_HOME_FILE`。它不再生成任何开发区坐标变量。这些是 Java 内部运行变量，普通用户不应手工维护。

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

### 8.4 顺序工具计划，不是持久 DAG

每条玩家消息产生一个持久任务。模型可返回单个 `action`，也可返回最多 12 个按依赖顺序排列的 `actions[]`；本地基础命令还会确定性生成木板、木棍、工作台、工作台放置、木/石工具和必要采集步骤。`AgentController` 每步都重新读取 Fabric 快照，依次执行能力检查、策略检查、危险准备和服务器后置条件验证，任一步失败即停止后续步骤并记录第 N/总步数。

整个数组仍只属于一个 TaskRecord，未逐步持久化程序计数器；进程在非幂等步骤后断线重试时可能重复动作。因此它不是可跨重启恢复的依赖 DAG，也不会自动把熔炼、附魔、长期采矿、建城或通关目标无限拆解。

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
6. 解析唯一 JSON 对象；回复限制为单行 240 字，`action` 或最多 12 个 `actions[]` 的类型和参数本地归一化。
7. 对计划每一步重新读取最新 Fabric 世界快照。
8. `CapabilityAssessor` 检查客户端、目标、物资、配置和危险度；`PolicyEngine` 执行不可绕过的财产与自卫规则。
9. 当前步骤若为挖矿、战斗或末地相关任务，先执行 `prepare_for`。
10. Fabric 客户端执行当前步骤并返回后置条件结果；成功才进入下一步。
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
- `break_block`（仅模型兼容入口，Node 会转换为 `gather_resource`）
- `craft_item`
- `place_block`
- `drop_item`
- `seek_shelter`、`build_shelter`、`wait_safe`

`attack_player` 只给本地自卫链路使用，默认模型合约不公开它。`return_to_zone` 只由自主规划器产生，也不允许模型选择。`break_block`、`mine_block`、`break_natural_block` 在 `parseAgentDecision` 中只读取 `block/resource/blockId` 和 `count`，统一归一化为 `gather_resource`；模型给出的坐标和 `ownership` 都不会进入执行动作。“挖这个方块”的坐标只来自可信聊天身份对应玩家的 `nearbyPlayers[].lookingAtBlock`。`drop_item` 必须带明确玩家目标，Fabric 走近后使用正常背包 THROW，并验证 Bot 背包数量减少。`open_container` 虽有内部类型和策略分支，但 Fabric 执行器没有实现，也未对模型公开。

玩家任务解析会把可信聊天身份 `identity.name` 作为 `follow_player`、`come_to_player`、`look_at_player` 漏写 `target` 时的缺省目标，因此“来这里”不会因模型少一个字段失败。该回填不用于 `attack_player`，攻击仍必须显式目标并通过短时自卫策略。

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
- 完成检查必须先于 `player.isUsingItem()`：持续按住使用键时，客户端可能在吃掉一份后立即开始使用同一格的下一份食物，导致 `isUsingItem()` 始终为真。控制器现在保存初始物品种类和数量；观察到空栈、物品种类改变（例如汤变成碗）或数量减少后，先递增 `completedFoodConsumptions`、释放使用键，再让显式动作返回成功。
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
- 单次资源搜索是 Bot 当前已加载范围内最多约 12 格，不是透视或全图搜索；长距离依赖探索分段。
- Bot 或目标附近出现小于荒野距离的其他玩家时立即安全取消。
- 需要正确工具的方块若没有足够耐久的正确工具就拒绝。
- 通过正常 start/continue destroy；只有观察到原方块状态改变才计数。
- 新出现的附近掉落登记为 Bot 自己产生的 provenance。
- Primitive 只负责采下并登记掉落；AgentController 在采集成功后自动执行一次 `collect_own_drops`，把“资源进入背包”作为玩家任务和空闲自发展采集的整体后置条件。
- 玩家语义的 `break_block` 并不是第二套破坏执行器；Node 在策略检查前就把它转换为本段同一个 `gather_resource`。因此不存在通过模型声明 `ownership:natural` 或伪造坐标绕过区域验证的路径。

`collect_own_drops`：

- 只接受仍可见、entity ID/UUID/itemId 一致、未过期的已登记掉落。
- provenance TTL 为 5 分钟且只在 Java 内存中存在。
- 没有登记证据时拒绝，避免拿走玩家物品。
- 只有背包中对应物品增加才成功。

`craft_item`：

- 只使用已解锁的客户端 recipe book 配方。
- 宽高不超过 2x2 的 shaped 配方或最多四种输入的 shapeless 配方使用正常玩家背包菜单。
- 需要 3x3 的配方必须在 8 格内找到 `owned-blocks.json` 登记且服务端仍一致的已加载工作台，正常走近并通过 `useItemOn` 打开真实 `CraftingMenu`；不允许借用玩家工作台、远程或虚构工作台。
- 两类配方都要求已解锁、当前材料足够且鼠标游标为空，通过 recipe book/quick-move 完成，观察目标物品数量增加后才成功并关闭菜单。

### 10.4 `ShelterController`

`build_shelter` 前置条件：

- 已开启 `allowVerifiedWilderness`，整个建筑目标通过动态环境、玩家结构、距离和撤退路线验证。
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
3. 夜间或当前不安全：有已记录住所才 `seek_shelter`；否则材料齐备且动态验证开启时才尝试 `build_shelter`，避免无住所反复失败。
4. 若 `world.activePrimitive=movement`，本轮直接返回，不能用 `wait_safe` 清除上一轮移动。
5. 到达确定性发展间隔后，先运行 `planAutonomousDevelopment`：区外 `return_to_zone`，区内按短缺选择木板、工作台、木棍、放置工作台、木镐、木/石采集或 `wander`。管理员 owner 在附近可监督这条主动采集，其他玩家仍阻止。
6. 没有确定性步骤时才 `wait_safe`；随后在满足主动聊天间隔时调用一次受限模型决策。
7. 空闲模型一次最多选择一个动作：`none/wait_safe/wander/eat_best_food/equip_best/prepare_for/attack_hostile/collect_own_drops/gather_resource/craft_item/place_block/use_item/seek_shelter/build_shelter`。
8. 动作仍须通过相同的 capability、policy 与 Fabric 后置条件检查。空闲模型禁止跟随、接近、注视或攻击玩家，不能自行声明目标安全。
9. 空闲采集会先按需要准备工具；若 `inventory_delta >= verified_broken_blocks`，说明掉落已自动拾取，不再重复启动收集器，否则继续追踪本任务自有掉落。失败原因写经验。

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
| `data/agent-prompts/*.md` | 五份运行时全局提示词；WebUI/本地均可编辑 | 文档写入采用临时文件和上一代 `.bak` |
| `data/agent-prompts/behavior-patches.json` | AI 学得的声明式策略提示，不是可执行代码 | 原子写入并保留 `.bak` |
| `data/player-profiles/<id>/USER.md` | 每玩家兴趣、表达和协作偏好；UUID 优先隔离 | 原子写入并保留 `.bak` |
| `data/self-improvement.json` | 规范化失败签名、次数和学习冷却 | 原子 JSON，禁止存网页全文或秘密 |

Memory 事件最多保留 `storage.maxEvents`；玩家 facts 不随该上限裁剪。上下文估值达到阈值时，`ContextCompressor` 仅针对当前玩家选出旧事件，由当前模型生成 `conversationSummary`、`globalSummary` 和画像摘要；通过 JSON、脱敏与非空校验后才更新 `USER.md` 并删除对应事件 ID。最近事件保留，失败时原数据不变。

经验系统在装备准备或动作失败时添加条目，未来任务按 tag/词元匹配。相同规范化失败达到 `minimumRepeatedFailures` 后，自我改进管理器还有一条独立闭环：可检索公开方案、由模型总结，并把建议写入 `TOOLS.md` 托管段和声明式补丁。动作执行仍须重新经过能力、策略和 Fabric 验证，因此“学到建议”不等于已验证解决。

### 12.2 恢复规则

- `AtomicJsonFile` 遇到文件不存在会创建默认文件；遇到损坏 JSON 会报错，不会自动用 `.bak` 覆盖。
- 恢复前先停止所有进程，复制损坏文件留证，再人工验证 `.bak` 后替换。
- `.bak` 只保存上一次成功写入前的一代，不能代替定期外部备份。
- 如果主记忆和 `.bak` 都被误删，项目无法凭空恢复历史；“误删可恢复”只成立于用户保留了记忆文件或外部备份。
- 跨机器迁移至少保留 memory、experience、tasks、autonomy-state、progression、owned-blocks、agent-prompts、player-profiles、self-improvement 和相应本地配置；不要迁移 PID、日志、bridge token 和整个 `.runtime`。
- WebUI 能显示/下载 memory/experience、显示 tasks，并编辑五份全局提示词和选中玩家 `USER.md`。直接改 JSON 业务状态仍应停机、备份并校验 schema。

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

方块安全不能靠模型声称 ownership。`gather_resource` 由 Fabric 在动态环境中选择并逐块验证；`collect_own_drops` 要求 provenance。`build_shelter` 只替换经玩家结构扫描且无方块实体的可替换空间，不破坏已有保护方块。

玩家攻击由 mixin 上报后，PolicyEngine 记录默认 15 秒自卫窗口并发送一次 `attack_player`。这表示尝试一次正常客户端反击，不表示伤害命中，也不是持续追杀。当前 `allowPlayerOrderedPvp=false`，模型合约也不公开玩家攻击动作。

### 13.3 WebUI 和本机威胁模型

WebUI 固定绑定 `127.0.0.1`，验证 Host/Origin，设置 CSP、nosniff 和 no-store，并限制配置/皮肤/存储路径在项目允许目录内。它没有登录认证；能登录这台 Windows 机器的本地用户可访问。因此不得用端口转发、反向代理或把监听地址改成公网。

## 14. WebUI 能力和限制

WebUI 当前可：

- 编辑 bot、persona、prompts、skin、behavior rules、mods。
- 安全保存或删除 `.env` 中四类秘密，只显示存在状态。
- 选择 DeepSeek、火山引擎、OpenAI，模型名、Base URL、推理强度、超时和输出预算。
- 设置服务器、LAN、EasyAuth、自动复活、聊天、任务仲裁、生存阈值、荒野距离、动态验证、提示词工作区和自我改进。
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

服务器要求 mod 的真实来源目录只应写入被忽略的 `config/mods.json` 或 WebUI，不要写入公共示例或文档。未来服务器增加 mod 时：

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

采集、合成、建造属于可能改变世界的测试，只能在管理员明确许可、可丢弃、远离所有玩家建筑的场地进行：

11. 放置/选择天然测试资源，验证区外、玩家靠近、方块实体和错误工具均拒绝。
12. 验证方块真实改变、掉落 provenance、只拾取自己掉落和背包数量后置条件。
13. 用简单 2x2 配方验证背包合成；放置工作台后用 3x3 配方验证真实菜单合成。区外、工作台过远或材料不足时应明确拒绝。
14. 提供 23 同种方块、门和火把，验证固定小屋、门上下半、关门、光照和家文件。
15. 重启客户端后执行 seek，确认家文件加载、开门、进入、关门和安全结果。
16. 在施工中途断线测试重复风险和部分建筑残留，记录但不要自动破坏清理。

目标服测试前必须征得管理员对测试场地和破坏性步骤的明确许可。不得为了完成验收在玩家区域试挖或试建。

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
- `allowVerifiedWilderness` 是否开启，以及 `blockSurvey`、玩家结构、其他玩家距离和候选目标诊断是否允许本次动作。
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

### 21.1 开源 Minecraft Bot 方案评估（2026-08-05）

本轮只做架构与许可证评估，没有直接复制第三方源码，也没有把不兼容 jar 放入运行环境。后续引入前必须固定上游提交、保留许可证/NOTICE、审查供应链与远程代码执行面，并为中国网络准备可校验的镜像或仓库内固定来源。

| 项目 | 可借鉴内容 | 当前不能直接接入的原因 | 建议接入方式 |
| --- | --- | --- | --- |
| [Baritone](https://github.com/cabaletta/baritone) | Fabric 原生 Java 寻路、`goto`/`mine` 目标、复杂地形与 A* | 上游主页当前列出的 Fabric 快速版本止于 1.21.8，未给出本项目 Minecraft 26.2/Fabric Loader 0.19.3 的可直接使用构建；LGPL-3.0 还要求明确合规边界 | 第一优先候选。先做独立 `PathPlannerAdapter`，只调用公开 `baritone.api`，在隔离 26.2 分支完成映射迁移、模组握手与许可证审查后再替换直线移动；不要先把命令聊天透传给模型 |
| [mineflayer-collectblock](https://github.com/PrismarineJS/mineflayer-collectblock) | `寻路→最佳工具→挖掘→收掉落` 的高层采集阶段和队列设计 | 依赖 Mineflayer、pathfinder、tool；目标模组服正式路线必须是真实 Fabric 客户端，而且 Mineflayer 上游公开支持范围与 26.2 不一致 | 借鉴阶段机与错误分类，在 `PrimitiveTaskController` 以正常客户端 API 重写；`GatherResourceTask` 增加逐目标动态验证、provenance 和服务端后置条件 |
| [Voyager](https://github.com/MineDojo/Voyager) | 自动课程、可检索技能库、环境反馈/执行错误/自验证循环、任务分解 | 示例测试栈是 Fabric 1.19、GPT-4、额外 Python/Mineflayer 环境，不能作为 26.2 模组客户端；其任意代码技能不符合本项目服务器安全边界 | 借鉴持久任务图与“技能模板+前置/后置条件+经验修正”，技能必须来自本地审核白名单，不允许模型直接生成并执行宿主代码 |
| [Mindcraft](https://github.com/mindcraft-bots/mindcraft) | 多模型配置、Mineflayer 技能组合、多人协作思路 | 上游说明当前支持到 1.21.11，并明确警告启用模型写/执行代码会有提示注入风险；仍不是 26.2 Fabric 模组客户端 | 只借鉴模型/技能调度结构。禁止移植 `allow_insecure_coding` 类能力，模型输出继续限制为当前 JSON 动作契约 |
| [Mineflayer](https://github.com/PrismarineJS/mineflayer) | 成熟的方块/实体/背包/合成 API，以及 pathfinder、auto-eat、tool、PVP 等插件生态 | 上游当前公开支持到 1.21.11；无真实 Fabric 模组容器与服务器同模组握手能力 | 保留只读协议探针和测试参考，不替换正式 `fabric_bridge`；可将插件的行为拆成 Java 端可验证原语 |
| [Pendulum](https://modrinth.com/mod/pendulum) | MCP JSON-RPC、80+ Minecraft API、45 个 Baritone 函数和脚本组合 | 官方版本表仅把 1.20.1/1.21.1 标为可用，26.1.2 仍在开发，未提供 26.2 Fabric 构建；直接执行 JS 还会扩大远程代码执行面 | 借鉴“结构化工具目录 + 组合调用”，不下载不兼容 jar，不允许模型执行任意 JS |
| [FundamentalLabs minecraft-mcp](https://github.com/FundamentalLabs/minecraft-mcp) | Mineflayer MCP 工具中的 `goTo/mine/craft/smelt/drop/give/sleep` 技能分层 | 正式路线需要真实 Fabric 26.2 模组握手，Mineflayer MCP 不能替代；引入 MCP 传输本身也不会自动解决动作后置条件 | 借鉴工具命名、参数和技能编排，底层继续映射到本项目 `AgentAction` 与 Fabric 原语 |

选择原则：路径规划优先研究 Baritone；采集状态机参考 collectblock；长期任务/经验参考 Voyager；MCP 工具目录参考 Pendulum 与 minecraft-mcp；模型技能编排参考 Mindcraft。当前实现采用 MCP 的核心模式——类型化工具、结构化参数、组合计划、逐步结果——但没有伪装成一个已对外提供标准 MCP transport 的服务器。任何未来 MCP/第三方方案都必须经过 `AgentAction → capability → policy → Fabric 逐目标验证与后置条件`，不能绕开财产保护、玩家距离、停止抢占和任务恢复。可选依赖默认关闭，安装失败不能阻断中国网络下的核心启动链。

按优先级继续（第 25 节实现已计入，不能继续引用旧的“未实现熔炼/狩猎/游泳”结论）：

1. 在最终同步工作树完成 Node/Fabric/WebUI/仓库审计；复测冰下氧气救援，确认不再溺亡。
2. 用可控实服场景逐项验收：生食→自有熔炉→熟食，铁矿→熔炼→工具/护甲→穿戴，羊毛→床→夜间睡觉，村民交易，附魔台；记录真实后置条件。
3. 让长期进程在隔离可丢弃场地持续运行，观察从石器推进铁/钻石、下界、要塞和末地；每个新阻塞以动作/状态修复，不用提示词掩盖。
4. 为 Java 路径、矿道、容器和水下自救抽出模拟世界接口，增加确定性单元/集成测试；当前 Gradle 仍主要证明编译和映射兼容。
5. 增加门、梯子、藤蔓、脚手架、动态实体避让、岩浆/着火逃生及未知模组危险注册表；评估 26.2 Baritone 适配但保持安全边界。
6. 把当前持久阶段检查点进一步升级为带前置、资源预算、幂等 key、恢复点和部分施工账本的任务 DAG。
7. 增加农业/繁殖、药水、铁砧、锻造台/下界合金和更灵活住所；未知模组物品默认拒绝。
8. 增加记忆摘要、经验实际应用计数/验证、任务归档和 WebUI 安全导入/编辑。
9. 实现 Microsoft Headless 登录与正版皮肤/披风路径。
10. 在无 VPN 的干净中国 Windows 验证一键安装和所有镜像回退。
11. 最后研究 Simple Voice Chat API、虚拟音频和 TTS/STT；语音不得阻塞文本控制主线。

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
- [ ] 采集/合成/住所只在管理员许可的可丢弃场地测试，并记录逐目标验证与服务端后置条件。
- [ ] 中国大陆无 VPN 干净 Windows 验收结果明确；未测试就明确写“待验证”。
- [ ] 只暂存审查过的文件，提交前检查 cached diff。
- [ ] 推送 `origin/main` 成功后，再以 `--ff-only` 同步干净的旧目录。
- [ ] 未实现功能保留为限制/待办，没有写成已完成。

## 23. 2026-08-05 基础工具计划与自主移动交接

### 23.1 工作范围和隐私边界

- 运行部署目录与 Git 本地仓库是两个工作副本；同步只能复制受 Git 跟踪/明确新增的源码、测试、示例和文档。
- 运行目录的 `config/bot.json`、`.env`、`data`、`logs`、`.runtime` 含本机部署数据并由 Git 忽略。不得把实际服务器地址、API Key、EasyAuth 密码、PID、记忆、玩家画像或日志同步到公开仓库。
- 最新用户指令授权在完成验证后把非隐私改动同步到本地仓库、提交并推送 `origin/main`；它取代本节旧版本曾记录的“禁止提前推送”阶段性约束。

### 23.2 新状态数据

`WorldStateEncoder` 每 5 秒最多扫描一次，以 Bot 方块坐标为中心，水平半径 8、垂直半径 5，只读取已加载位置。结果写入 JSONL state 的 `blockSurvey`，Node 经 `FabricBridgeClient.#blockSurvey` 严格校验后进入 `WorldState`：

- `resources[]`：按 tag/ID 识别 logs、leaves、stone、soil、surface、coal/iron/copper/gold ore；每项有 `blockId/category/count/nearestDistance/nearest`。
- `artificial[]`：方块实体，或名称含 planks、bricks、door、fence、stairs、slab、glass、concrete、terracotta、wool、carpet、bed、chest、barrel、furnace、crafting_table、redstone、rail、torch、lantern、ladder、bookshelf 的方块。
- `protectedLikely=true`：发现方块实体或至少 4 个疑似建筑方块；分类为 `protected_structure_nearby`。有自然资源且未触发保护启发式时为 `natural_terrain_likely`，否则 `uncertain`。
- 背包方块物品增加 `placeableBlockId`，供 Node 在执行前判断是否具备可放置材料。

这只是保守启发式，不是方块所有权证明。世界修改必须同时通过策略层和 Fabric 逐目标验证；不得仅因扫描“看起来天然”就破坏。

### 23.3 确定性基础命令

`src/agent/basic-command.ts` 在 LLM 之前识别高置信度中文/英文命令：进食、安全白名单方块放置、2×2/3×3 合成、明确/模糊采集。支持阿拉伯数字和一至十九中文数量，常用资源别名、动态原木树种到木板 ID，以及依据 `blockSurvey` 和背包短缺为“采集材料”选择木材或石材。命中时日志模型名为 `local-deterministic`；未命中才构建记忆/经验上下文并调用 LLM。

新部署由 `PromptWorkspace.buildSystemPrompt()` 按 `rules → IDENTITY → SOUL → TOOLS → MEMORY → 当前 USER → behavior patches` 动态组合，并替换 persona 占位符。旧部署仍可由 `buildSystemPrompt` 给 `prompts.json` 追加 `place_block`、`blockSurvey` 和逐目标验证兼容规则，便于滚动升级；运行目录初始化后以 Markdown 工作区为准。

### 23.4 `place_block` 原语

链路：`AgentAction` → decision parser → capability → policy → Fabric JSONL → `PrimitiveTaskController.PlaceBlockTask`。参数为可选 `itemId` 与 `count`（1–16）。

Java 只接受安全白名单材料：泥土类、石头/圆石/深板岩等基础石材、木板、羊毛、原木/木头及必要基础设施；拒绝其他方块实体、非满方块、重力/特殊交互物。每个目标必须通过玩家结构扫描、已加载、可替换、无方块实体、稳定支撑、碰撞、危险与撤退检查；使用 `BlockPlaceContext` 验证 `canPlace/canSurvive/isUnobstructed/mayUseItemAt`。背包材料按服务器确认的 SWAP 移至快捷栏，通过正常 `gameMode.useItemOn` 放置并连续观察服务端状态。超时、材料耗尽、保护插件拒绝或目标变化均失败。

### 23.5 采集关键修复

- 玩家明确下令时，Node 内部附加 `authorizedPlayer`；模型解析器不能提供此字段。能力层和 Java 只豁免当前发令玩家本人，其他玩家仍受 `wildernessMinPlayerDistance` 保护，主动采集没有豁免。
- `findResourceTarget` 不再选择 Bot 当前 X/Z 支撑柱中位于脚下或更低的方块，并要求普通搜索目标至少有一个暴露面，避免穿过表层建筑挖到不可见地下资源。玩家准星明确指定的单块目标走独立验证路径。
- 旧状态机在 `BREAK` 之后先执行通用“目标变化”检查，导致每次真实成功都被当成外部变化、继续找下一个方块，最终耗尽当时工作窗口后报告 `verified_broken_blocks=0`。现在 `BREAK` 阶段优先消费服务器方块变化后置条件，计数一次后进入掉落观察。
- `GatherResourceTask` 记录任务开始时背包总物品数。完成结果包含 `verified_broken_blocks`、`registered_owned_drops` 和 `inventory_delta`：若背包增量已不少于确认破坏数，即使此前观察到掉落实体，也说明实体随后已自动拾取，Node 不再错误启动第二次收集；否则仍串联 provenance 收取。

### 23.6 主动发展和重连

历史版本曾在 Bot 位于人工坐标区外时生成 `return_to_zone`。该机制现已删除：`src/agent/autonomous-development.ts` 直接根据真实背包、环境、维度和 `progression.json` 选择下一步，`return_to_zone` 会返回已废弃。`activePrimitive=movement` 时下一次心跳直接返回，不会被 `wait_safe` 立即取消。

Node 每轮仍先处理生存、危险和持久玩家队列。确定性发展间隔夹在 15–60 秒之间，不消耗模型；只有没有确定性步骤且主动聊天时间条件满足时才调用模型。玩家任务可抢占。

修复了桥重连遗漏：旧实现只在 `joined_world` 消息启动主动 timer；Java 客户端仍在世界时 Node 重启只会重新握手并发送 state，不会再次发 joined_world，导致恢复的 queued 任务永不继续。现在任一 `connected:true` state 都调用幂等的 `#ensureProactiveTimer()`。

### 23.7 多人回复

TaskStore 原有串行仲裁不变。`AgentController.#bestEffortReply` 统一在所有成功、拒绝、失败、超时和停止回复前添加 `@<issuer.name>`（已有同名 mention 时不重复），再经过出站密钥过滤和聊天冷却。并发测试验证回复顺序为 owner `wraaaaaa`、近处 Alice、远处 Bob，且三条分别携带姓名。

### 23.8 本轮验证证据

- TypeScript：`npm run check` 成功。
- Node：最终候选工作树 `npm test` 为 74 tests、74 pass、0 fail；数量只代表本快照，后续以当次输出为准。
- Fabric：Java 25 下 `gradlew.bat clean build --no-daemon` 成功，新 jar 已复制到 `.runtime/minecraft/mods/minecraft-ai-fabric-bridge-0.1.0.jar`。
- 生产与审计：`npm run build` 成功；`npm run audit` 扫描 110 个跟踪文件，0 个秘密、编码、乱码、控制字符或 JSON 问题；`git diff --check` 成功。
- 真实服扫描和动作验证只记录动作后置条件，不在公开文档保存服务器地址或实际测试坐标。
- 第一次采集暴露并复现连续挖掘状态机 bug；测试区产生的旧圆石掉落属于此授权测试遗留物。
- 历史现场实测曾证明 `return_to_zone` 和当时人工窗口有效；该授权机制现已移除。仍有效的证据是自主 `wander` 真实移动，以及 `verified_placed_blocks=1` 后 `verified_broken_blocks=1; registered_owned_drops=1; inventory_delta=1` 的放置/采回后置条件链。
- 3x3 链路复测：背包 2x2 合成木棍、放置工作台、打开真实工作台菜单合成 `minecraft:wooden_pickaxe`，结果为 `verified_crafted_count=1; ...; grid=3x3`。当前版本还要求工作台登记在 `owned-blocks.json` 并与服务端现状一致。
- `wander` 实测使位置在批准 AABB 内变化，没有越界。
- 收尾回归发现“工作台已放在附近但背包为空时仍重复合成工作台”；规划条件现检查背包和 `blockSurvey.owned`，只认可自有账本中的工作台，背包工作台会在动态验证的安全候选点放置。
- 历史完整后台重启曾达到 `in_world`、桥 `connected=true`、扫描 `natural_terrain_likely`。本轮代码变更后必须重新部署 jar 并复验，不能沿用旧运行进程作为当前证据。

### 23.9 尚未完成

本节是基础工具阶段的历史快照。熔炼、容器、狩猎、完整石/铁/钻石制造、附魔、床、阶梯矿道、水节点和长期 `reach_end` 检查点已在第 25 节实现；农业、任意建筑、铁砧/锻造/药水、全局 Baritone 级寻路和完整端到端实服通关仍未完成。以后判断当前状态以第 25 节和实际 HEAD 为准。

## 24. 2026-08-05：有界 A*、游戏聊天隔离与 WebUI 总聊天

### 24.1 问题复现与根因

用户在真实服务器观察到 Bot 继续撞墙。旧 `MinecraftAiBridgeClient.driveToward` 和 `PrimitiveTaskController.moveToward` 只检查前方 0.5 格碰撞，然后把“前进+左/右”按键保持 24–30 tick；它没有方块图、路线、墙体边缘目标或可复用路径状态，所以长墙、墙角和动态目标会反复顶墙。任务层虽然能在 60–80 tick 无进展后失败，但不能产生绕墙路线。

第二个问题是 `AgentController` 直接把 `action.type`、步骤号、Fabric `detail`、物品 ID 和能力评估原因拼进游戏聊天。这样既破坏陪聊体验，也把内部工具契约暴露给所有服务器玩家；日志虽有错误，但 WebUI 没有按任务组织的总时间线。

### 24.2 Java 路径规划实现

新增 `fabric-bridge/src/client/java/kim/ciallo/minecraftai/bridge/LocalPathNavigator.java`，普通移动目标、全部 primitive 任务和住所/避难控制器各持有一个实例：

- 状态空间是玩家脚部可站立的 `BlockPos`；每个候选把当前玩家 `AABB` 平移到方块中心，以 `ClientLevel.noCollision` 验证身体净空，再向下 0.16 格确认真实支撑。`standingY` 从碰撞形状计算真实落脚面，半砖和雪层等非整数高度不会再被误判成悬空或把玩家压进方块。
- 四向邻接，依次尝试同高、上 1 格、下 1 格；上跳额外检查出发列抬高后的头部空间。单段 X/Z 半径 24、Y 半径 6、最多展开 6000 节点。
- 启发式为目标水平距离减停止半径，加 0.25 倍高度差；远目标投影到约 22 格本地段，段完成后继续规划，避免要求未加载区块参与一次全局搜索。
- 拒绝岩浆、火、仙人掌、岩浆块、甜浆果丛、细雪和营火落脚点。当前未实现液体游泳、门、梯子、脚手架、栅栏门和模组危险注册表。
- 目标位移超过 1.25 格、80 tick 周期、当前 waypoint 失效、碰撞至少持续到规划后 4 tick 或 18 tick 无进展时重规划。路线驱动只朝下一个方块中心按前进，需要升高时跳跃；前方再次有碰撞且不是计划跳跃时立即松开前进并清空路线，下一 tick 重规划，绝不保持按键顶墙。
- `setMovement` 在接受普通移动动作时立即规划第一段：找不到已加载、碰撞安全的路线就返回失败并松开全部移动键，不能再把“朝目标开始移动”误报成成功。路线已经开始后，非跟随目标连续 20 次重规划失败才停止；跟随允许目标或加载地形变化后继续重试。
- `PrimitiveTaskController.finish`、`ShelterController.finish` 和桥断线/换世界/到达时释放导航状态与按键。住所控制器原来的 `moveConservatively` 也只负责调用同一 A*，寻找安全处、前往床、回家及进入建造点不再使用朝目标直走的独立实现。桥每秒上报 `navigationStatus`，WebUI 状态页可看到当前 waypoint、路线长度、目标或最近失败原因。

`LocalPathNavigator` 当前依赖 Minecraft 客户端类，Gradle 没有模拟世界测试；Java 25 `gradlew.bat build --no-daemon` 只证明编译和 Fabric 映射兼容。后续应抽出纯方块图接口，为长墙、U 形墙、一步升降、悬崖和危险地面建立确定性地图测试。

### 24.3 双聊天通道与诊断持久化

新增 `src/diagnostics/diagnostic-store.ts`，固定写 `data/diagnostics.json`，schemaVersion 1，最多 1000 条，使用 `AtomicJsonFile` 原子替换和 `.bak`。事件类型包括 request、decision、step、result、failure、lifecycle；记录 taskId、玩家、模型名、结构化 action JSON、逐步结果和完整错误。所有标题/摘要/detail 进入存储前都经过 `SecretGuard.sanitizeForPersistence`，detail 最长 12000 字符。

`AgentController` 的边界：

- 玩家消息仍写统一 `memory.json`，入队后同时写 request 诊断。
- 模型或本地确定规划完成后写 decision；这里保存的是 action/actions 的结构化摘要，并明确标注“不是模型隐藏思维链”，不保存供应商原始 reasoning。
- 每步执行前/成功后写 step；完成写 result；能力、策略、准备、执行、超时、异常和断线分别写 failure/lifecycle。无人发令时的本地生存、自主发展选择、策略/条件拒绝及 Fabric 返回结果也进入同一诊断流。
- 游戏失败回复统一为 `@玩家 抱歉，这件事现在做不到。详细原因请在总控页面的“总聊天”查看。`；超时使用自然语言简短提示。游戏聊天不再拼接 Fabric detail、步骤号或 action.type。
- `naturalGameText` 拦截代码块、JSON action、`minecraft:` ID、内部动作名、tool/function/action call、动作名/调用名/接口参数等内部术语；成功时若模型 reply 不合格，动作任务降级为“好了。”，纯聊天降级为“我在听。”，主动聊天降级为普通陪伴语。

`src/webui/server.ts` 在 snapshot 中读取诊断，并新增只读 `/api/diagnostics`，只返回 memory/tasks/diagnostics，便于页面在设置未保存时仍独立刷新。`public/webui` 新增“总聊天”：合并记忆中的 player_message/bot_reply 和诊断事件，最多显示最近 250 条；支持全部、仅游戏对话、仅警告/错误，动作和错误 detail 折叠显示。UI 每 4 秒刷新一次，筛选与自动刷新控件标记为 `.ui-only`，不会触发全局 dirty 状态。

历史 `memory.json` 是事实记录，仍包含升级前曾真实发送的动作名/错误；不要为了美化页面篡改历史。新边界仅约束升级后的出站消息。

### 24.4 验证与运行状态

- `npm run check`：通过。
- `npm test`：76 tests、76 pass、0 fail；新增测试验证诊断文件持久化，以及完整动作名/参数/错误只进入诊断而不进入游戏聊天。
- `node --check public/webui/app.js`：通过。
- `npm run build`：通过。
- Fabric Java 25 build：通过；新 jar 已覆盖 `.runtime/minecraft/mods/minecraft-ai-fabric-bridge-0.1.0.jar`。
- 后台完整重启后，Node 控制器、Minecraft 客户端和 WebUI 均运行，Fabric 重新握手并达到 `in_world`。初次位于石砖/楼梯围场且已加载方块内无出口时，连续两次 `return_to_zone` 都立即返回 `no collision-safe loaded route`，没有把开始移动误报成成功；完整原因进入诊断。重生到自然地形后，状态上报出现 `following_path 3/13`、`19/30` 等逐段进度，坐标持续改变；玩家随后发出的 `come_to_player` 也由同一规划器接受。最终玩家要求停止移动后，实测 `activePrimitive=""`、`navigationStatus="idle"`。这证明安全拒绝、路线驱动和停止释放按键均工作，但尚未建立固定长墙/U 形墙的可重复实服测试地图，不能把任意复杂地形宣称为已验证。
- 最新一次完整重启还包含住所控制器 A* 接入；Java 编译通过，运行 jar 与构建 jar SHA-256 一致。自动避难的路线行为需等服务器再次进入夜间或人工下达可触发 `seek_shelter` 的条件继续实测。
- 浏览器回归：WebUI 显示运行进程、`in_world`、实时 `navigationStatus`、总聊天导航/说明/时间线/任务侧栏；“仅警告与错误”筛选工作，能展开最新任务的完整本机错误，操作后仍为“设置已同步”；浏览器控制台 0 warning/error。

> 上述第 24 节末尾原属于早期“暂不推送”阶段。本轮用户已明确要求全部完成后同步本地仓并推送；当前有效交接状态以下一节和最终 Git 记录为准，隐私排除规则始终不变。

## 25. 2026-08-05：长期末地发育、原生高级动作、矿道/游泳与最新实服证据

### 25.1 为什么没有直接引入 Mineflayer/Baritone 二进制

目标是 Minecraft/Fabric 26.2 模组客户端。调研时 Mineflayer 官方支持范围仍停在 Java 1.21.11，Baritone 发布物也没有可直接用于 26.2 的构建。把这些旧二进制塞入目标实例会产生协议/映射/模组握手不兼容。当前实现保留“感知状态→基本动作→可组合计划”和 A* 思路，但执行层继续使用目标版本真实 Fabric 客户端；后续若出现经过许可证和 26.2 验证的 Baritone/Pendulum 版本，可以替换 `LocalPathNavigator`，不得绕过 `WildernessGuard`、自有方块账本和服务端后置条件。

### 25.2 持久长期规划

`src/agent/autonomous-development.ts` 的 `planSurvivalProgression` 每次只选择一个可观察动作，不让 LLM 决定生存主链。顺序由当前状态动态重算，而不是死记已经发出的命令：

1. 任意维度先处理受击、危险、饥饿；`food < 20` 且有安全食物立即吃。
2. 没有熟食时先烹饪已有生食；缺工作台/熔炉/燃料时逐项准备；再无食物时狩猎或探索食物区域。
3. 主世界制作木板、工作台、木棍、木镐，储备木材/圆石/煤，制作熔炉和五类石器。
4. 地下且未建家时先用上行阶梯回到地表；准备至少 23 个外壳方块、门和火把，建固定住所并持久化 home。
5. 狩猎羊直到同一颜色羊毛达到 3，制作对应颜色床、放在自有工作点；夜间睡觉并确认 `player.isSleeping()`。
6. 开采/熔炼铁，制作五类铁工具、四件铁甲、盾和桶，执行 `equip_best`。
7. 在目标高度开采钻石，制作五类钻石工具和四件钻石甲并穿戴。
8. 获取黑曜石、皮革、甘蔗/纸/书、青金石和经验；制作/放置自有附魔台，逐件附魔钻石工具与护甲。经验为 0 时继续采煤获取经验。
9. 准备打火石与钢、黑曜石，建造并点燃下界门；下界补充食物/熔炉，寻找并击杀烈焰人，取足烈焰棒后返回。
10. 主世界狩猎末影人、合成末影之眼；`TravelTask` 投掷并跟踪眼、分段前进、保守下挖、扫描传送门框、填眼并进入末地。
11. 到达 `minecraft:the_end` 即把长期目标标记完成并安全待命；本服龙已被击败，不需要自动打龙作为完成条件。

`data/progression.json` 保存 `goal/stage/lastAction/lastReason/lastResult/milestones/failures`。`ProgressionStore.notePlan` 只允许最高阶段单调前进：钻石阶段中的临时进食、补工作台等不会让交接状态退回 survive/wood。采集失败键为 `gather_resource:<resource>`，石头路径失败不会污染煤、铁或钻石的决策。

### 25.3 原生高级动作和后置条件

`AdvancedTaskController` 支持：

- `hunt_entity(purpose,count)`：`food/wool/leather/ender_pearl/blaze_rod`；拒绝幼体、驯服、拴绳、自定义名称实体，非任务怪还要通过动态荒野校验。A* 到目标，按冷却攻击，登记本次掉落并以对应背包增量完成。
- `attack_hostile(targetId,protectPlayer)`：只选敌对实体；保护模式要求怪物当前目标确实是指定玩家。跟随任何玩家时 `SurvivalController.escortPlayerName` 动态指向该玩家，主人仍由固定配置保护。
- `smelt_item(inputItemId,outputItemId,count)`：只找 `OwnedBlockRegistry` 仍验证存在的自有熔炉；真实打开 `FurnaceMenu`，搬入输入/燃料、等待输出、取出，以输出背包增量完成。
- `trade_villager(desiredItemId,count)`：只找成年、未占用、已加载村民；按背包可承担性和结果价值选择交易，通过 `MerchantMenu`/选择数据包/结果槽执行并验证增量。
- `enchant_item(itemId,minLevel)`：只找自有附魔台；装入未附魔可损耗物品和青金石，从高到低选当前经验可承担的选项，确认附魔组件回到背包。
- `sleep_in_bed`：只找自有床，导航/交互并以实际 sleeping 状态确认。
- `excavate_tunnel(resource,targetY,length)`：逐段选择安全方向，清理双格净空和上跳出发列实际 AABB 涉及的全部头顶方块；空洞中可两阶段放地基/支撑。完成不是“发出移动”或累计跳跃次数，而是稳定落地并达到 `terminalY`。
- `explore_frontier(purpose,radius)`：按黄金角生成持久探索前沿，有路走 A*；无路时只破坏正前方安全天然障碍；资源/荒野目的还要求终点动态校验通过。
- `build_nether_portal`：在动态验证的荒野选择平整净空，逐块正常放置完整黑曜石框、登记自有方块、打火并等待服务端形成 portal block。
- `travel_to_dimension`：普通维度寻找已加载门并走入；末地目标包含末影眼实体轨迹、长距离分段、要塞/框扫描、天然下挖和逐框填眼。

`PrimitiveTaskController` 仍负责装备/准备、用物、近场采集、自有掉落、合成、普通放置和交付；`ShelterController` 负责固定住所与回家。Node 每次动作仍经过 capability、policy、SecretGuard 和游戏聊天隔离。

### 25.4 路径、开路和稳定落地关键修复

`LocalPathNavigator` 是已加载区域内单段水平 24、垂直 6、最多 6000 节点的 A*。远目标按约 22 格分段；目标变化、80 tick、waypoint 失效、碰撞和 18 tick 无进展触发重规划。水节点允许水平/上下游动。

本轮从实服日志发现并修复五类假成功/死循环：

- 到达判断原先只看水平距离，目标在脚下/头顶也会成功；现同时要求垂直误差不超过 0.8。
- 洞穴同层四向无支撑时不再失败循环；可先在更低位置放 foundation，再放目标 support，二者写入 `owned-blocks.json`。
- 玩家靠方块边缘时上跳真实 AABB 会跨两列；现按实际 `minX/maxX/minZ/maxZ` 清掉所有自然头顶阻挡。
- A* 图偶尔把脚下起点投影低一层；仅对相邻、目标可站立、真实碰撞箱安全的一格直线/对角上跳启用专用 direct step，不放松全局过渡规则。
- `blockPosition` 在空中会短暂升高；现必须 `onGround || inWater` 才计步骤完成。跌落导致旧目标高出当前超过一格时丢弃旧目标并从真实落脚点重算。垂直任务以实际稳定 `terminalY` 完成，不再以累计次数伪造。

保留 `diagnoseDirectStep`，路径最终失败时向 WebUI 返回 origin/start/goal、standing Y、目标可站立、过渡净空、支撑/脚/头/出发顶方块；禁止把这些内部字段发送到游戏聊天。

### 25.5 水下行为和冰下自救

`LocalPathNavigator` 可把水方块作为站立/游泳节点，狩猎鱼、追水中掉落和普通采集共享该路径。`SurvivalController` 在氧气低于最大值 75% 时把 detail 设为 `surfacing_for_air`，主循环暂停普通狩猎/移动并调用独立 `airRescueNavigator`：

1. 在半径 12、当前高度上下范围扫描“当前格为水、上一格和头部无液体且无碰撞”的水面节点。
2. A* 前往最低成本水面节点；接近后保持跳跃露头换气。
3. 找不到路线时继续上浮；四格交互范围内遇到经 `WildernessGuard.safeNaturalBreak` 验证的天然冰/雪/石质顶部，选择快捷栏最快工具并从下方持续破坏。
4. 氧气恢复后释放独立导航器和破坏状态，原任务继续。普通 `hunt_entity` 不再被标成可压过生存威胁的 advanced combat；实际怪物威胁会暂停动物狩猎。

现场根因证据是 Minecraft 日志中的 `wraaaaaa_ai drowned`。新救援实现已编译、部署并重新进服，但尚未在相同冰下条件复测；后续 Agent 第一项实服安全验收应复现“追鱼进入冰下→氧气低于 75%→离水/破冰→未死亡”，并记录空气值、坐标、`survivalDetail` 和最终呼吸恢复，不能只等待日志无死亡。

### 25.6 食物、工具、设施和模组兼容

`WorldStateEncoder.item` 读取 `DataComponents.FOOD` 与 `CONSUMABLE`，向 Node 发送 `foodNutrition/foodSaturation/safeFood`。已知不安全名单包含腐肉、蜘蛛眼、毒马铃薯、河豚、生鸡肉、迷之炖菜和紫颂果；其他具有组件的模组食品可作为安全储备。现场确认 Farmer's Delight 鸡汤为 `safeFood=true`，腐肉为 false。

规划器按相同颜色最大羊毛栈制作床；不会把三种不同颜色各一份误当成配方。工作台、熔炉、床和附魔台只有在背包中或 `blockSurvey.owned[]` 中才算 Bot 可用设施。`OwnedBlockRegistry` 保存 `{dimension,x,y,z,blockId}`，扫描时删除/忽略与服务端实际方块不符的记录。这个精确账本高于“附近看起来是工作台”的启发式。

### 25.7 配置和迁移新增项

`config/bot.example.json` / 实际 `bot.json`：

- `storage.progressionFile` 默认 `data/progression.json`。
- `storage.ownedBlocksFile` 默认 `data/owned-blocks.json`，`start-headless-client.ps1` 限制它必须留在项目 `data` 内并通过 `MCAI_OWNED_BLOCKS_FILE` 传给 Java。
- `autonomy.eatBelowFood` 默认 20。
- `autoHunt/autoSmelt/autoMine/autoTrade/autoEnchant/autoDimensionTravel/autoSleep/protectOwner/allowVerifiedWilderness` 均由 loader 校验布尔值。
- `longTermGoal` 当前只能是 `reach_end`。

迁移最少保存：`memory.json`、`experience.json`、`tasks.json`、`autonomy-state.json`、`progression.json`、`owned-blocks.json`、`agent-prompts/`、`player-profiles/`、`self-improvement.json`，以及经安全渠道重建的 `.env`。不要迁移 PID、`bridge-token.txt`、`runtime-status.json` 或整个 `.runtime`。

### 25.8 当前验证与尚未宣称完成的内容

最近候选工作树：TypeScript check、完整 Node 测试、TypeScript 生产 build、Java 25 完整 Gradle build和 WebUI 浏览器读写回归成功；同步到 Git 工作副本后仍要重跑审计和构建。实服既有证据已完成自动进食、工作台/熔炉放置、熔炉合成、完整石器和上下行矿道后置条件。交易、附魔、床、下界/要塞/末地是“代码实现 + 编译/Node 规划测试”，不是本轮现场完成；冰下自救也是“根因现场复现 + 修复部署，待复测”。

最终交付前仍必须：

1. 后续修改 WebUI 时重新回归运行状态、配置保存、总聊天、进度和自有方块；如果浏览器工具支持控制台事件，再补做控制台错误检查。
2. `npm run check/test/build/audit`、`node --check public/webui/app.js`、Gradle build、`git diff --check`、UTF-8/U+FFFD/控制字符/秘密/真实域名扫描。
3. 只把源码、测试、示例和三份文档同步到 Git 工作副本；绝不复制 `.env`、本机 `config/*.json`、`data`、`logs`、`.runtime`、`node_modules`、`dist` 或 Fabric build。
4. 在 Git 副本再次审计，确认示例服务器仍为 `你的域名.com`，再暂存、提交、推送 `origin/main`。
5. 推送后对比远端 commit；本地部署目录继续保留真实配置和运行数据，不从干净仓反向覆盖。
