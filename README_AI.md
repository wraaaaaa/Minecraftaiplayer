# README_AI - Minecraft AI Player 完整交接手册

> 本文写给后续 AI Agent、维护者和审查者。面向普通用户的安装、部署和使用教程是 `README.md`，参数索引是 `PARAMETERS.md`。任何功能或参数变更都必须同时更新这三处中受影响的内容。
>
> 本文不得保存真实服务器地址、API Key、EasyAuth 密码、桥接令牌或玩家隐私。仓库中的服务器地址一律写成 `你的域名.com`。


> **用户数据统一目录 `userdata/`**：`.env`、`config/*.json`、`data/` 已全部合并到项目根目录的 `userdata/`（可用 `MCAI_USERDATA_DIR` 覆盖位置）。升级版本 = 只替换 `userdata/` 一个文件夹。配置字段里的相对路径（如 `data/memory.json`、`config/persona.json`）仍按原字符串填写，由 `src/core/user-data.ts` 的 `resolveUserData()` 解析到 `userdata/` 下；仓库模板 `config/*.example.json`、`config/agent-prompts.example/`、`.env.example` 留在根目录。旧目录可跑 `node scripts/migrate-userdata.mjs` 一次性迁移。

> **本轮交付（文档 + 修复）**：README.md 最前新增“部署与配置（从零开始）”完整章节（环境安装、WebUI/本地文件配置对照、启动停止、常见问题）；PARAMETERS.md 顶部新增“存储位置速查”。修复：`scripts/test-voice-bridge.mjs` 改读 `userdata/config/bot.json`（带 example 回退）；`src/webui/server.ts` 为行为规则增加 `config/behavior-rules.example.json` 回退；`config/behavior-rules.json` 拆为跟踪模板 `config/behavior-rules.example.json` + 运行时 `userdata/config/behavior-rules.json`。

## 0. 接手时先做什么

当前工作机有两个目录：

- 运行部署目录：含本机忽略配置和实服运行数据，开发与现场测试先在这里完成。
- Git 本地仓库：只接收经过审计的非隐私源码/测试/示例/文档，用于提交和推送；实际绝对路径不得写入公开文档。

主开发仓才是本轮编辑、验证、提交和推送的来源。不要同时运行两个目录里的 Bot，否则可能发生端口、PID、日志和配置冲突。换电脑后这些绝对路径自然失效，应以 `git rev-parse --show-toplevel` 的结果为准。

远端仓库为 `https://github.com/wraaaaaa/Minecraftaiplayer.git`，默认分支为 `main`。本文不把提交 SHA 或测试数量当作长期不变量；第 2.2 节只保留带日期的本轮验证快照，接手时仍要动态查询：

### 0.0 人数监听、测试启动与模组握手跳过（最新）

- 新增 `playerMonitor` 配置（`userdata/config/bot.json`）：`src/player-monitor.ts` 作为独立进程（`npm run player-monitor` / `stop:player-monitor`，PID 在 `userdata/data/player-monitor.pid.json`）用 `src/network/server-status.ts` 的 Server List Ping（协议版本 776）轮询在线人数——该查询是短暂的未登录 TCP 连接，不占服务器人数空位。人类玩家（总数减掉 Bot 自己）在线满 `onlineAfterMs`（默认 1 分钟）自动运行 `start-all-background.ps1`，无人类玩家满 `offlineAfterMs`（默认 30 分钟）自动运行 `stop-all-background.ps1`；状态持久化在 `userdata/data/player-monitor-state.json`。
- WebUI 新增“测试启动（绕过监听）”按钮 → `POST /api/runtime/test-start`：写 `userdata/data/test-mode.flag` 后直接启动 Bot；监听进程看到该标志就跳过自动上下线，手动 `POST /api/runtime/stop`（或 restart）会清除标志恢复正常。
- 模组校验跳过（实测边界见下）：`userdata/config/mods.json` 新增 `skipHandshakeVerification`。为 `true` 时 `start-headless-client.ps1` 跳过 `sync-client-mods.mjs`，并设置 `MCAI_SKIP_REGISTRY_SYNC=true` 环境变量（HeadlessMc 用独立 JVM 启动客户端，不转发任意 `-D` 系统属性，所以用环境变量传递），由 bridge 的两个 Mixin——`ClientRegistrySyncMixin`（cancel `ClientRegistrySyncHandler.checkRemoteRemap`）与 `MappedRegistryRemapMixin`（cancel `MappedRegistry.remap`）——跳过 Fabric API 注册表同步的严格校验，让 Bot 通过 configuration phase。
- **模组跳过的真实边界（2026-08-16 实服排查）**：跳过 registry sync 后客户端能通过 configuration phase，但若服务器缺失的是“客户端+服务器模组”（如 `create`/`moredelight`/`travelersbackpack`），这些模组会在 play phase 发送自定义数据包，客户端会因 `DecoderException: Received unknown packet id` 断线。因此“完全跳过模组验证玩原版”只对**纯服务端模组**（`environment: server`）成立；对客户端模组，客户端仍必须安装对应 jar（把它们放进 `userdata/config/mods.json.sourceDirectory` 重新同步）。这是 Fabric 协议的根本约束，不是可以继续 patch 的 bug。默认 `skipHandshakeVerification=false`（同步模组、不做跳过）。

### 0.1 2026-08-07 水域/跨维度/交换/管理通道交接增量

- 默认对外角色名从“小粉”改为“小默”。服务器登录名仍受 Minecraft/EasyAuth 的 ASCII 规则约束，不能因此改成中文。模板源是 `config/persona.example.json`、`config/agent-prompts.example/{IDENTITY,SOUL}.md`；实际运行目录还要同步 `userdata/config/persona.json` 与 `userdata/data/agent-prompts/`。玩家专属旧称呼仍保留在各自 `USER.md`，不应全局删除。
- `LocalPathNavigator` 的水中一格上升现在把 `player.isInWater()` 视为可跳状态，避免只有 `onGround()` 才按跳跃。`TraversalRecovery` 连续 8 次规划失败后按“目标方向、左、右、反向”尝试天然障碍开路/缺口铺桥；水中会先寻找朝岸或脚下 1–4 格内的水格，只有存在合法相邻支撑面、背包有白名单普通方块且 `WildernessGuard.safePlacementArea()` 通过才替换水格。所有成功垫脚块调用 `OwnedBlockRegistry.registerPlacedStructure()`。
- `MinecraftAiBridgeClient` 在 `player/level` 暂时为 null 但游戏连接和本机桥仍在线时保留 `movement.follow=true` 的持续状态，只释放当前按键/局部路径；真正桥断开、死亡、显式停止仍清除。跟随目标在最近坐标附近消失时扫描玩家周围 12 格、纵向 8 格内的 `NETHER_PORTAL`/`END_PORTAL`，只有门体离最后目标不超过 8 格才将门中心作为临时目标。新维度加载会重置局部 A*/恢复器但不删除持续跟随，再从实体或 owner 定位栏重定位。该算法不是全局跨维度追踪；没有观察到传送门时不能猜测。
- 固定安全位置配置是 `autonomy.firstHome={enabled,dimension,x,y,z,radius}`，默认 `minecraft:overworld / 1226 / 65 / 199 / 10`。启动脚本映射为 `MCAI_FIRST_HOME_*`。`return_home` 先选当前维度 `ShelterController.homeSnapshot()`，否则选 fixed home，并启动持久安全寻路；不同维度明确失败。WorldState `home.source` 是 `registered_shelter` 或 `first_home`。固定位置只是安全区域，不代表已经存在门、床或建筑。
- 门禁路径：`WorldStateEncoder` 为 `nearbyBlocks[]` 增加 `interactable=button|lever|door|gate|portal` 并将可交互方块排到紧凑观察前部。`LocalPathNavigator` 仍直接开木门/栅栏门；铁门会在 3 格范围找未供能按钮/拉杆并点击，交互有 8 tick 去抖。可恢复的手开门/栅栏门/拉杆在通过且仍处于 5 格交互距离内时尝试关闭/复位；按钮依靠服务端自动回弹。复杂多路红石只能 best-effort，不能承诺一定找到正确控制器。
- 物品交换新增模型工具 `accept_items_from_player` → `AgentAction.accept_items` → `AdvancedTaskController.AcceptItemsTask`。它要求明确玩家、可选物品 ID、数量和 1–6 格半径，只考虑目标玩家碰撞箱附近且存在不超过约 30 秒的掉落实体，接近后等待原版服务端拾取，并仅用背包数量增量完成。`give_item_to_player` 仍走相反方向的 `DropItemTask`。收到盔甲后是否装备由模型读取新背包状态后再选 `equip_for`，没有自然语言关键词旁路。
- 游戏发言净化抽到 `src/agent/game-reply.ts`：模型文本先标准化；若出现目标玩家最后一个 `@name`，只取其后的最终段；逐句删除工具名、命名空间 ID、JSON、调用说明、“现在回应玩家/回复主人/客户端会”等内部元话语。句首没有第一人称、形如“已/已经停止、完成、选择、放置……”的工具回执也删除，并清理剩余台词前的孤立逗号。没有安全句时用本地自然回退。`ReplyComposer` 轮换 8 套开工确认并防止同一玩家连续完全重复。`#safeChat` 在净化正文后重新加唯一的 `@玩家名`。
- WebUI 最高权限通道由 `src/admin/admin-command-inbox.ts` 实现。每个请求是 `userdata/data/admin-inbox/<时间前缀-UUID>.<status>.json`，临时文件同目录原子 rename，状态为 pending/processing/done/error；控制器启动时只恢复孤立 processing，正常 submit/claim 不会重置正在执行的文件。`POST /api/admin/command` 只受既有 loopback Host/Origin 检查访问。`BotRuntime` 连接客户端后每 250 ms 串行领取；`AgentController.handleAdminMessage()` 增加 cancellation epoch、发送 stop、取消当前 running、以 `source:webui_admin`/urgency 100 入队。`TaskStore.takeNext()` 顺序是 WebUI admin → owner → 最近普通玩家。
- WebUI 读取运行 JSON 时会在主文件解析失败时只读回退同名 `.bak`，避免一次残缺诊断文件让总聊天整块空白；它不会由 WebUI 自动覆盖损坏的主文件。主动 ToolAgent 的 goal 不再 `JSON.stringify(world)`，因为 `initialWorld` 已经由 ToolAgent 紧凑发送。Chat Completions 的第二轮起把长 system 替换为 `FOLLOWUP_SYSTEM` 硬规则，把 user 缩成原始 `playerMessage/currentPlayer.name`，再附进度账本和当前工具结果；不得删掉工具后置条件、秘密/财产边界或最终发言规则。
- `AgentController.#manualHold` 是仅存于控制器进程的明确等候状态：每条新定向消息先解除旧 hold，独立停止或“停下+原地/等我”再次建立；owner/自身受到实际威胁、低血、严重饥饿、着火或水下低氧会清除。`#runProactiveTick()` 在威胁处理后、任何空闲工具循环之前检查它。它不持久化到磁盘，控制器完整重启后不会恢复旧 hold。
- 现场矿道失败 `goal_standable=false; support=minecraft:air` 的根因是 `ExcavateTask` 只在起点选方向。现在每一级 `dy!=0` 都重新执行 `chooseExcavationDirection()`，且上下行候选都要求目标 feet 下方为无流体的碰撞支撑；无安全方向明确失败，不继续挖入洞穴。`PlaceBlockTask.WAIT_SWAP` 改用 candidate/displaced 两个物品栈指纹确认交换；容器 `stateId` 仅留作失败诊断，因为快捷栏 SWAP 后它不保证变化。
- 新回归测试：`game-reply.test.ts`、`admin-command-inbox.test.ts`，并扩充 TaskStore 管理优先级、ToolAgent 回家/接物品/续轮压缩和停止保持断言。Java 必须至少用 Java 25 `compileClientJava --rerun-tasks`，随后构建 jar、同步运行目录，再做实服场景验证；“编译通过”不能写成“水域、门禁和跨维度现场已通过”。
- 2026-08-07 私有部署现场：新版 JAR 进入世界；WebUI 中文最高权限指令成功抢占自主任务。`look_at` 真实工具首轮输入 14026、续轮 6445 Token（旧同类停止任务续轮 16644），最终游戏回复无动作名/回执。随后 `stop_all_actions` 后观察超过 18 秒未出现新自主动作。水域上岸、传送门、门禁、物品交换仍缺少本轮玩家在场的逐项现场矩阵，只能报告代码/构建/自动回归状态。

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
2. 不输出 `userdata/.env`、`userdata/config/bot.json` 或日志中的真实敏感值。
3. 不把“代码已编译”写成“已在真实服务器完成行为验收”。
4. 不把“动作开始”写成“动作目标已经完成”。
5. 不写死测试用例数量、当前提交 SHA、服务器域名或当前 PID。
6. 修改 Java 桥后必须重新构建并把新 jar 复制到隔离客户端；只运行 TypeScript 构建不会更新游戏内代码。
7. 正式推送前必须删除本地测试 API Key，并扫描当前工作树和 Git 历史。

### 0.2 2026-08-07 分玩家称呼、适应性寻路、正确工具与二次 Token 收缩（最新）

- `AddressingEngine.decide()` 新增可选 `aliases` 参数。`FabricBridgeClient`/`MinecraftClient` 在寻址前异步调用 `PromptWorkspace.botAliases(identity)`，所以只加载当前发言者 `USER.md` 中“`## 该玩家对 AI 的称呼`”小节的项目符号；同一个昵称不会跨玩家传播。固定配置名、角色名、`!`、距离和连续对话逻辑仍然保留。
- `PromptWorkspace.ensurePlayerProfile()` 会给旧画像无损补入称呼小节；`appendBotAlias()` 原子追加；`extractDeclaredBotAlias()` 只学习“以后叫你/喊你/称呼你/管你叫”这类明确自述，不把普通聊天里的任意名词当别名。称呼最多 32 个、单个最长 24 字符，WebUI 仍通过现有玩家画像编辑器直接修改同一文件。
- ToolAgent 新增 `onToolSelected` 事件，发生在第一个模型工具已由供应商返回、但参数尚未本地解析且策略/执行器尚未运行之前。`AgentController` 每项玩家任务只在第一次真实工具选择时发送一次自然开工回应；零工具的普通聊天没有伪开工确认，也没有额外 API 调用。
- 工具提示二次收缩：`PromptWorkspace.buildSystemPrompt(...,{toolAgent:true})` 保留规则、身份、SOUL、MEMORY、当前 USER、安全/研究段和 `AI_LEARNED`，删除 `TOOLS.md` 里与运行时 JSON Schema 重复的“原子接口/连续技能”目录。`buildToolAgentGoal()` 限为 12 条事实、1500 字玩家摘要、6 条×240 字事件、1200 字全局摘要、4 条精简经验；首轮/续轮附近方块从 32/12 降到 16/6，实体列表从 12 降到 8；Schema 描述也改为短句，但工具名、参数约束和硬安全没有删除。
- 私有配置隔离 API 探针最多两轮，合计实际输入 25272、输出 463 Token，静态 system 15074 字、goal 1848 字、工具 schema 6842 字；约 12636 输入 Token/轮。旧总聊天样本常见约 17000–22000/轮，因此已下降，但不得把这组画像/世界/模型结果当固定费用保证。探针执行器拒绝世界动作，没有把模型选择冒充实服行为。
- `ToolSelector` 取代高级控制器和空气救援中的 hotbar-only 速度选择：遍历整个非装备背包，只接受剩余耐久大于 3 的 TOOL，`isCorrectToolForDrops` 加 10000 分，再比较破坏速度和附魔；背包工具通过 inventory `SWAP` 放入快捷栏并等待下一 Tick，选中后发送 `ServerboundSetCarriedItemPacket`。`PrimitiveTaskController.BreakBlockTask` 原先已有同等正确类别评分，继续保留。
- `LocalPathNavigator` 在原有一步跳跃、水节点和 A* 基础上加入：1.5 格碰撞盒潜行节点；可徒手门和栅栏门作为可规划节点并在进入前 `useItemOn`；潜行时禁用 sprint；碰撞投影同时验证潜行高度。铁门不被当作可手开门。
- `TraversalRecovery` 只在连续 8 次局部规划失败后接管：先检查目标方向脚/头方块，只有 `WildernessGuard.safeNaturalBreak`、可破坏、可触及且六面无流体才用 `ToolSelector` 开路；若前方身体空间清空而脚下是缺口，则要求 `safePlacementArea(radius=3)`，仅从六类普通材料中选择一块、正常交互放置并用 `OwnedBlockRegistry` 持久登记。玩家建筑、方块实体、危险流体、无合法支撑或材料丢失都会取消恢复。
- `follow_player` 现在即使第一次 A* 返回 no route 也返回 `continuous_follow_engaged` 并保留 `MovementTarget.follow=true`；短暂看不到非 owner 玩家时保留最后坐标，owner 继续使用定位栏分段。到达跟随距离只释放按键，不清除模式；`stop`、冲突任务、断桥/换世界仍会清理导航和恢复控制器。物理上不存在对目标离线、跨未加载维度或服务器断线的“绝不丢失”保证，文档不得这样宣称。
- 新 JAR 已在私有运行目录构建并替换。无模型实服桥测试确认连接、`followOk=true`、3 秒和 12 秒均保持 movement，随后 stop 成功；因为目标当时在停止距离内，这不证明门/潜行/开路/搭桥现场全部通过。Java 映射与安全分支已通过完整 Gradle build，复杂障碍仍列为后续实服矩阵。

### 0.3 2026-08-07 总聊天驱动的持续技能与会话压缩修复

- 私有运行数据中的任务 `10c6...` 对“你跟我过来”连续选择了五次 `navigate_to`，只追逐当轮观察到的旧坐标；每轮供应商实际输入约为 15584、18893、22252、25600、28955 Token，第六轮在发送前触发 `agent_input_budget_exhausted`。根因不是 Java 跟随器不会工作，而是原生工具 Agent 没有公开长期跟随工具。
- `AGENT_TOOLS` 现在公开 `follow_player_continuously {player}`，映射到既有 `AgentAction {type:'follow_player'}`。Java `MovementTarget.follow=true` 会持续读取目标实体新位置；到达期望距离时只松开移动键，不清除跟随目标。模型与 `TOOLS.md` 被明确要求只调用一次，禁止用重复 `navigate_to` 模拟。
- `AgentController.#runProactiveTick` 先处理正在威胁主人/Bot 的即时敌人，再检查 `world.activePrimitive`。`activePrimitive=movement` 时空闲 ToolAgent 和旧兼容自主规划器都不会启动，因此不会在一分钟后的主动心跳覆盖持续跟随。显式停止仍走带外 `stop`；玩家冲突任务、死亡或断线仍可合法终止。普通玩家短暂离开实体加载范围不再立即清除跟随，真正离线/跨维度时只能停在最后位置等待。
- 私有任务 `8a2f...` 的“做 10 个石镐”在五轮工具调用中输入约为 15485、18736、22126、25578、29585 Token，累计超过 11 万；第六轮估算 51780，超过单次 48000 上限。旧 `compactOldToolResults()` 只识别已经废弃的 `world` 字段，而当前回执使用 `observationDelta`，所以实际上没有压缩。
- 新 `compactContinuation()` 对 Chat Completions 只保留起始 system、纯文本 user、最多 16 条执行进度账本和最新一条含 `tool_calls`/`reasoning_content` 的 assistant；当前工具结果仍由 `toolResults` 单独追加，保持 DeepSeek 协议合法。账本的每条观察只保留位置、生命、饥饿、背包增量、维度、快捷栏、活动动作和导航状态，不保留近邻方块/实体/完整世界，多模态内容被降为首轮纯文本目标。OpenAI Responses 的非数组 continuation 不做这项改写，继续使用 `previous_response_id`。
- DeepSeek 偶发抛出“模型既未调用工具，也未返回最终文本”时，ToolAgent 会先递增 API 次数，用估算输入加完整单轮输出预算保守记账并写 WebUI warning，然后仅一次以 `agentFollowupReasoningEffort`（默认 `none`）重试。第二次空响应或预算不足直接停止；禁止无界重试。
- `ToolAgentTurnEvent` 新增 `estimated` 与可选 `error`。WebUI 总聊天标题会标记“空响应，准备降级”，并明确本轮 Token 是保守估算；不记录隐藏推理正文。
- 人设模板的 `IDENTITY.md`/`SOUL.md` 默认普通回复改为 2–4 句、约 45–140 个中文字符，顺序是具体回应→感受/关心→轻微撒娇/承接话题。柔弱是情感表达而不是能力退化；禁止自贬、威胁、内疚诱导和情绪绑架。内部通用失败与秘密拒绝文本也不再是机器式一句话。
- 回归测试覆盖：模型选择一次持续跟随；空闲心跳不覆盖 active movement；Chat continuation 移除旧推理且账本不含大世界字段；空响应只重试一次且失败轮计费。后续改动这些分支时必须继续保留上述断言。
- 受控真实 DeepSeek 探针使用运行目录私有配置，但只向控制台输出聚合用量和动作类型：模型在 2 次 API 中使用输入 6855、输出 115、总计 6970 Token（推理 26），唯一动作是 `{type:'follow_player',target:'wraaaaaa'}`，最终自然回复长度 51 字符。此探针的执行器是内存 mock，只证明真实模型选工具和会话协议，不冒充服务器动作证据。
- 随后只启动真实 Fabric 客户端和本地桥、不注册主动模型 handler：客户端进入实际服务器并观察到目标玩家，`follow_player` 返回成功；3 秒与 17 秒的真实 state 都为 `activePrimitive:'movement'`，发送 `stop` 后变为空字符串。第一次将桥等待保留为正式配置的 30 秒时，冷启动客户端未赶上握手；清理后用仅探针内存配置的 90 秒等待复测成功，没有修改 `userdata/config/bot.json`。结束后测试客户端已停止，现有 WebUI 未停止。

### 0.4 2026-08-07 紧急延迟/Token 重构（优先级最高）

- 现场任务 `0e6f...`（公开文档只保留截断 ID）在约十分钟内进行了 48 次模型工具轮，只从 Y=69 挖到 Y=52，最后以 `agent_step_budget_exhausted:48` 结束。用户侧观察到接近五百万 Token。直接原因是旧版要求模型每挖一格重新决策、每轮重复完整工具表/大世界状态，并且将世界状态在用户目标和 Agent 上下文中发送了两次；4096 输出预算和每轮高推理又放大了耗时与费用。
- 当前默认是“模型策略 Agent + 原子接口 + 连续运动技能”三层：模型根据自然语言和环境自行选择工具、参数、顺序和替代方案；`gather_resource`、`excavate_safely`、`craft_item`、`smelt_items`、`hunt_for`、`return_to_task_start` 等连续技能只负责逐 Tick 重复运动、安全检查和后置条件，不按聊天关键词自动运行，也不替模型决定总目标。不要把连续运动控制删回逐方块模型调用。
- 首轮只发送一次压缩 WorldState（附近方块最多 32）；后续工具结果只发位置、生命/饥饿、背包变化和最多 12 个近邻方块的增量观察。玩家目标不再内嵌第二份世界状态。连续技能完成、环境显著变化或失败后才重新调用模型；已删除动作后的固定 350 ms 等待。
- 默认玩家任务最多 12 个工具步、8 次云 API、累计 160000 Token、单次输入估算 48000 Token、单轮输出 1024 Token；第一次策略沿用管理员推理强度，后续重规划默认 `none`。优先使用供应商返回的真实 `usage`，否则按中英文保守估算。任一硬预算触发都停止继续请求，不允许靠重试突破。
- 安全挖矿禁止脚下垂直挖掘。`excavate_safely` 映射到 Fabric 已验证的双格阶梯/隧道控制器，持续检查危险流体、玩家结构、碰撞和支撑；模型应在地下目标结束后调用 `return_to_task_start`。若预算在下探后耗尽，本地安全层还会尝试最多四段向上阶梯回到任务起始高度。
- 上下文压缩不再阻塞玩家动作。世界状态不计入记忆压力；任务完成后才延迟 1.5 秒在后台检查真实记忆，压缩模型返回格式错误只写诊断，不能再使“来找我”等动作失败。
- 新增小米 MiMo：`provider=mimo`，官方基址 `https://api.xiaomimimo.com/v1`，支持 `mimo-v2.5` / `mimo-v2.5-pro`，密钥环境变量 `MIMO_API_KEY`。适配器使用 Chat Completions function tools、`max_completion_tokens`、`thinking`、图像/音频内容和 `usage`。
- 能力检测将 DeepSeek 固定为纯文本；MiMo 2.5 自动声明视觉、语音/视频理解和攻略搜索能力。视觉首轮优先读取 15 秒内的 `userdata/data/sensory/latest.png`，否则从真实方块/实体状态生成 128×128 语义俯视 PNG；语音只接受新鲜 `latest-audio.json`，当前 Simple Voice Chat 尚无帧生产器，因此缺帧时必须显示 unavailable。攻略搜索走现有百度/SearXNG 中国可达研究层，网页是不可信参考，不能执行代码。
- WebUI 已加入上述预算、多模态开关和 MiMo 密钥/预设；总聊天记录每个模型轮的耗时、输入/输出/推理/缓存/累计 Token，并汇总最近任务与 24 小时费用。禁止记录隐藏思维链正文。

### 0.5 2026-08-05 交接增量（历史仍有效）

- 人工 `developmentZone` 已取消。旧 JSON 字段只为升级兼容而解析，`autonomyConfig()` 删除它，WebUI 不显示，启动脚本不传坐标，Java 启动时清空遗留区域。AI 依据结构化环境选意图，Fabric 对每个实际目标执行天然性、玩家结构、方块实体、危险源、碰撞、玩家距离、撤退路线和服务端后置条件检查。
- 提示词运行源改为 `userdata/data/agent-prompts/{rules.md,IDENTITY.md,SOUL.md,TOOLS.md,MEMORY.md}`；每位玩家自动创建 `userdata/data/player-profiles/<uuid-or-name>/USER.md`。模板位于 `config/agent-prompts.example/`。`SOUL.md` 是核心人设；五份文档可在 WebUI 或本地直接编辑，每次模型决策前重新读取。
- 2026-08-05 后续人设增量：运行时与模板的 `SOUL.md`/`IDENTITY.md` 已从用户提供的 OpenClaw SOUL 中仅抽取角色设定并改写为 Minecraft 猫娘角色；2026-08-07 默认角色称呼进一步改为“小默”。保留粉色猫娘、温柔元气、有主见、主人关系和自然聊天句末“喵”；排除 OpenClaw 的外部行动、文件连续性和平台工具规则。只有 `wraaaaaa` 可称主人；JSON/工具输出禁止加入语气词或动作描写。
- `memory.json` 仍是统一原始记忆文件。`ContextCompressor` 在玩家任务结束后后台检查真实记忆压力，达到预算阈值时保留最近事件，用当前模型总结较旧事件；先原子更新当前玩家 `USER.md`，成功后才写玩家/全局摘要并按事件 ID 原子删除已压缩事件，避免画像写入失败造成上下文丢失。
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
- DeepSeek 等纯文本模型只接收结构化游戏状态和文本。多模态模型可额外接收真实/语义视觉帧及外部语音桥提供的音频帧；项目不伪造不存在的感官，也不把多模态能力等同于直接控制鼠标键盘。
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
- 真实服发现一次冰下追鱼溺亡，客户端聊天为 `BotName drowned`（公开文档已替换实际账号名）。已实现 75% 氧气提前接管、水面出口 A* 和天然冰/雪顶破拆并通过 Java 构建；该新自救路径尚待下一次冰下现场复测。
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
| 聊天/回复 | 支持固定名、`!`、近距离语境，以及当前玩家 `USER.md` 中独有的昵称/称号；第一个真实工具前先自然回应；游戏出口经过密钥和内部调用术语过滤 | 寻址仍是规则启发式；只有明确“以后叫你…”才自动学习称呼，其他情况应由用户在画像中编辑 |
| 多人任务 | 持久化单执行槽队列；主人优先，其余按发令者距离仲裁；模型逐轮选择原子接口或连续技能 | 当前任务不是可跨重启恢复的依赖 DAG；连续技能中途断线仍要按真实结果重新确认 |
| 跟随/前往/探索 | `follow_player_continuously` 首次无路也保持；Fabric 动态读位置；A* 支持跳跃、潜行、水、手动门/栅栏门，失败后受保护开天然障碍或铺自有桥；owner 可定位栏分段 | 不是全局 Baritone；跨维度/离线/断线无法保证；梯子、藤蔓、铁门、跑酷和未知模组碰撞仍可能阻塞，复杂障碍待逐项实服矩阵 |
| 自动进食/烹饪 | 饱食低于 20 即吃；26.2 `FOOD`/`CONSUMABLE` 支持模组熟食；储备不足会狩猎、准备自有工作台/熔炉并烹饪 | 未知模组食物副作用只靠已知有害名单；农业/繁殖未实现 |
| 自动对敌/狩猎 | 对实际威胁自卫和保护主人/跟随者；可狩猎成年未命名、未驯服、未拴绳的动物/鱼/任务怪并追踪掉落 | 中立高风险怪的自动反击仍保守；战斗 AI 不是竞技级走位 |
| 选装备/制造/附魔 | 制作五类石/铁/钻石工具、铁/钻石护甲、盾/桶；穿戴最佳装备；自有附魔台逐件附魔工具和护甲 | 暂无铁砧、锻造台/下界合金、药水和完整模组评分 |
| 采集/矿道 | 已加载资源直接采集；不可见资源按目标 Y 挖双格阶梯；天然障碍可开路，空洞可持久登记垫脚块；以最终稳定 Y 和背包增量确认 | 不透视；人造结构、危险流体和无法确认归属时停止 |
| 拾取自己掉落 | 只追踪并拾取本控制器注册的掉落实体 | 所有权账本在 Java 内存中，客户端重启后丢失；没有来源证据就拒绝 |
| 合成/容器生产 | 2x2/3x3 正常菜单；熔炉装料/加燃料/取出；村民可承担交易；附魔台装物品/青金石并选择可支付项 | 不操作玩家容器；没有酿造、铁砧、锻造台和村民职业刷新 |
| 建造住所 | 在动态验证的安全环境建固定 3x3 小屋，放门、火把、墙和屋顶，逐块确认 | 需要现成材料；不自动合成门/火把；中途失败不会回滚已放方块 |
| 寻找住所/睡觉 | 优先持久家与自有床；长期规划取得三份同色羊毛、制作/放床，夜间真实睡觉并以 `isSleeping()` 确认重生点 | 固定 3x3 住所，不是建筑生成器；床白天不会伪报睡眠 |
| 水下/安全挂机 | 水节点寻路；空气低于 75% 搜索可呼吸水面，无出口时尝试破坏天然冰/雪；只有安全评估通过才挂机 | 新冰下自救已编译部署但尚待现场复测；岩浆/火灾逃生仍以停止高风险动作和现有反射为主 |
| 空闲自发展 | 持久 `progression.json` 确定性推进食物、住所、床、全套装备、矿物、附魔（自给自足）；不再推进下界、要塞和末地；玩家任务/危险抢占 | 单个长期原语断线后由 Node 重试，不是任意依赖 DAG；完整端到端实服旅程未完成 |
| 记忆 | `memory.json` 统一保存原始事件；按玩家 UUID/名称隔离，自动加载对应 `USER.md`，达到预算阈值时压缩旧事件 | 压缩依赖当前模型；模型失败时保持原事件，不会冒险删除 |
| 经验/进化 | 失败写入经验；重复失败可研究公开资料并更新托管工具经验与声明式补丁 | 不是训练模型；不允许自改可执行代码、硬规则或秘密，补丁仍须通过原有能力/策略/Fabric 验证 |
| WebUI 总聊天 | 聚合记忆中的玩家/Bot 对话与 `userdata/data/diagnostics.json` 的结构化决策、步骤、后置条件和完整脱敏错误；独立 4 秒刷新和三种筛选 | 明确只展示可验证决策摘要，不提供或伪造模型隐藏思维链；诊断文件不是长期记忆输入 |
| 皮肤 | 校验标准皮肤 PNG，并可生成其他玩家客户端安装包 | LocalSkin 不会由 Bot 广播；每位观察者都要装包或共同使用在线皮肤站 |
| 语音 | 多模态输入协议可读取外部音频帧；TTS 输出支持火山、OpenAI、MiMo、音频多模态和自定义接口，并通过 Simple Voice Chat 的 Bot UDP 连接发声 | 输入帧生产器仍需外部实现；输出集成针对 2.6.20+26.2，后续内部类变化会安全关闭语音；服务端 UDP 端口仍需管理员正确开放 |

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
| `src/agent/decision.ts` | 模型 `chat/action` 意图、JSON 解析、动作白名单和参数归一化；显式聊天强制无工具 |
| `src/agent/autonomous-development.ts` | 自给自足确定性阶段规划：生存、食物/烹饪、住所/床、全套工具护甲、矿物、交易、附魔 |
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
| `fabric-bridge/.../TraversalRecovery.java` | 连续规划失败后的硬安全开路/铺桥阶段机；只破天然方块，只登记自身确认放置的桥块 |
| `fabric-bridge/.../ToolSelector.java` | 跨整个背包按正确工具类别、速度、耐久和附魔选矿具，完成 SWAP 与服务器快捷栏同步 |
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
| `userdata/` | 全部用户/个人化数据（`.env`、`config/*.json`、记忆、经验、任务、住所、状态、PID、桥令牌、皮肤、提示词）；忽略且需备份 |
| `logs/` | Node、启动器和客户端日志；忽略 |

## 5. 配置、参数和秘密

### 5.1 跟踪示例与本地真实文件

仓库跟踪（模板）：

- `config/bot.example.json`
- `config/persona.example.json`
- `config/prompts.example.json`
- `config/agent-prompts.example/`（五份全局 Markdown、`USER.md` 模板、`behavior-patches.json`）
- `config/mods.example.json`
- `config/skin.example.json`
- `config/behavior-rules.example.json`
- `.env.example`

本地使用但禁止提交（全部位于 `userdata/`）：

- `userdata/.env`
- `userdata/config/bot.json`
- `userdata/config/persona.json`
- `userdata/config/prompts.json`
- `userdata/config/mods.json`
- `userdata/config/skin.json`
- `userdata/config/behavior-rules.json`
- `userdata/data/`（记忆、经验、任务、住所、状态、PID、桥令牌、皮肤、玩家画像、运行时提示词）
- `logs/`、`.runtime/`

注意：`behavior-rules.json` 的运行时副本在 `userdata/config/`，仓库只跟踪 `config/behavior-rules.example.json` 模板；`load-config.ts` 在 userdata 副本缺失时回退到该模板。

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
| `storage.*` | `data/memory.json`、`data/experience.json`、`data/tasks.json`、`data/autonomy-state.json`（相对路径，解析到 `userdata/` 下） |
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

### 5.3 人设与三种名称的修改规则

维护者必须区分以下三层，不能在交接时统称“Bot 名字”：

1. `SOUL.md` 是核心人格、价值观、口癖、情绪表达和关系设定；运行源是 `userdata/data/agent-prompts/SOUL.md`，每次模型决策重新读取。
2. 对外角色称呼同时受 `userdata/config/persona.json.name`、`IDENTITY.md` 和 `SOUL.md` 影响。`{{name}}` 只替换为 `persona.name`，不是 Minecraft 登录名。WebUI 将它显示为“兼容角色名”；该值还参与聊天点名和 MemoryStore 的 Bot 标签，因此修改后应重启 Node 控制器。
3. Minecraft 实际登录名只由 `userdata/config/bot.json.server.username` 决定，WebUI 名为“Bot 游戏名”。它必须匹配 `^[A-Za-z0-9_]{3,16}$`，修改后必须重启 Node 与 Minecraft 客户端。

WebUI 标准流程：进入“提示词与玩家画像”→修改“兼容角色名”、`IDENTITY.md`、`SOUL.md`→点击“保存全部设置”→若改了角色名则点“重新启动”。只改 Markdown 正文时无需重启。实际登录名在“服务器与客户端”修改，保存后必须重启；离线 UUID、EasyAuth 注册身份、LocalSkin 文件名和在线皮肤站角色名可能随之变化。

本地标准流程：修改忽略文件 `userdata/config/persona.json` 的 `name` 和运行文件 `userdata/data/agent-prompts/{IDENTITY.md,SOUL.md}`。`config/agent-prompts.example/` 只负责新部署初始化，不能替代运行文件；确认人设稳定后才同步模板。只改 AI 自称时禁止顺手改 `server.username`。提示词不得含 API Key、密码、真实服务器地址或其他秘密。

### 5.4 `userdata/.env` 变量

只允许以下模型秘密变量：

- `DEEPSEEK_API_KEY`
- `ARK_API_KEY`
- `OPENAI_API_KEY`
- `MINECRAFT_LOGIN_PASSWORD`

WebUI 的密钥接口只返回“是否已配置”，不返回值。保存密钥会原子替换 `userdata/.env`；删除按钮会移除上述值。最终测试后必须删除实际 API Key，再执行仓库审计。

常用非秘密覆盖：

- `BOT_CONFIG`：只改变 Node 配置入口。当前 Headless Fabric 启动脚本仍固定读取 `userdata/config/bot.json`，不要在成对启动时让两边读取不同配置。
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
3. 从示例生成本地配置和 `userdata/.env`，不会覆盖已经存在的本地文件。
4. 执行 npm 安装、TypeScript 检查和构建。
5. 预取并校验 Minecraft 26.2 资源。
6. 构建 Fabric bridge。
7. 安装并校验 HeadlessMc，准备隔离 Fabric 客户端和 mod。
8. 后台启动 WebUI 并打开 `http://127.0.0.1:3210`。

若 winget 不可用，必须人工安装 Node.js 22+ 和 Java 25 后重跑。当前一键脚本只正式支持 Windows；Linux/systemd 尚未实现。

### 6.2 正常启动顺序

`Start-Bot.cmd` 调用 `start-all-background.ps1`：

1. Node 控制器创建或复用 `userdata/data/bridge-token.txt`，加载模型和持久文件，在回环端口监听。
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

WebUI 的“AI 控制器”“Minecraft 客户端”卡片来自 PID 所有权检测；“客户端已连接”来自 `userdata/data/runtime-status.json`。这两类状态来源不同，诊断时不能混为一谈。

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

`userdata/data/tasks.json` 为 schemaVersion 1，任务状态为 `queued/running/completed/failed`。全局最多一个 `running`；任务进入运行态时 `attempts` 加一。

### 8.1 仲裁顺序

精确优先级：

1. 纯“停止/取消”以及“不要再跟着我/不用跟我了”等解除跟随消息走带外停止路径，立即取消当前全局运行任务并向 Java 发送 `stop`。持续跟随早已从任务队列完成也能被解除。任何被寻址玩家都能触发，当前没有主人专属限制。
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

这是本地关键词队列优先级，不是工具选择器，也不会把文字转换为游戏动作。它只在同一个发令者内部排序；主人优先级永远高于非主人紧急度。真正的聊天/行动意图与工具组合由模型根据完整语句和上下文决定。

### 8.3 恢复与终态

- 启动或控制器重新连接时，遗留 `running` 任务重新排入队列并增加 `requeueCount`。
- 动作中 Fabric 断线会暂停 drain 并把当前任务重新排队。
- 任务完成/失败终态先写入磁盘，再尽力发送聊天、写事实或经验；回复发送失败不会把任务改回运行。
- 明确停止会把旧运行任务标记失败，再创建并完成一个高优先级停止任务。
- 每次危险准备、主动作和采集后的掉落收取返回后都会复核 `cancellationEpoch` 与当前 task attempt；动作等待期间收到 stop 时，旧任务不能再写完成终态或发送迟到回复。
- 玩家任务或空闲自发展执行 `gather_resource` 成功后，Node 立即串联 `collect_own_drops`。只有自有掉落实进入背包才整体成功；方块已破坏但收取失败会保留精确的部分完成原因并写失败经验。
- 断线发生在服务器已经执行动作、但结果尚未返回时，重试可能重复非幂等动作。当前没有跨重启的动作幂等账本，采集/建造测试必须关注这一点。
- 任务文件当前不自动裁剪；长期运行需要后续增加归档或保留策略。

### 8.4 历史 JSON 计划器（兼容分支，不是当前默认）

旧的 `intent=chat|action`、单个 `action` / `actions[]` JSON 计划器仍为不支持原生工具调用的适配器和旧测试保留，但 DeepSeek、豆包、MiMo 与 OpenAI 的当前 provider 默认进入第 28 节分层工具 Agent。任何新玩法都不得只增加自然语言关键词到旧分支。

历史数组仍只属于一个 TaskRecord，未逐步持久化程序计数器；进程在非幂等步骤后断线重试时可能重复动作。当前分层 Agent 同样不是可跨重启恢复的任意依赖 DAG，连续技能完成后仍以服务端后置条件为真值。

## 9. 模型接入和决策流水线

### 9.1 供应商

- `deepseek`：`<baseUrl>/chat/completions`，JSON object 输出。`none` 关闭 thinking；`low/medium/high` 当前统一映射成有效 `high`，`xhigh/max` 映射成 `max`。若官方已知的 JSON 空 `content` 问题发生，适配器记录不含思维链的响应元数据，并仅以 `thinking=disabled` 和强化非空 JSON 提示重试一次；第二次仍空则失败，不读取 `reasoning_content`。
- `volcengine`：`<baseUrl>/chat/completions`，原样传递 `reasoning_effort`。
- `mimo`：`<baseUrl>/chat/completions`，官方基址为 `https://api.xiaomimimo.com/v1`；使用 function tools、`max_completion_tokens` 与 `thinking.enabled/disabled`，解析标准图像/音频输入和 `usage`。`mimo-v2.5` / `mimo-v2.5-pro` 自动声明多模态与攻略研究能力。
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
- 正常脚本创建并复用 `userdata/data/bridge-token.txt`，Java hello 携带同一 token，Node 用定时安全比较验证。
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
| `userdata/data/memory.json` | schema 1；Bot 名、分玩家档案、facts、事件、全局摘要字段 | Node 原子写入，覆盖前复制上一代到 `.bak` |
| `userdata/data/experience.json` | schema 1；失败任务、上下文、lesson、correction、tags | 同上 |
| `userdata/data/tasks.json` | schema 1；顺序、状态、尝试、重排、结果/错误 | 同上 |
| `userdata/data/autonomy-state.json` | Java 住所 version 1；家和门坐标 | 临时文件+替换，不创建 `.bak` |
| `userdata/data/runtime-status.json` | Node 运行 phase 与 WebUI 轻量 WorldState 摘要 | 最快每秒、无实质变化时每 30 秒心跳写入；不含背包明细、`nearbyBlocks` 或 `lookingAtBlock`，完整观察只驻留控制器内存；有 `.bak`，不是业务备份 |
| `userdata/data/bridge-token.txt` | 本机桥凭据 | 无备份；可在完全停止后删除并重建 |
| `userdata/data/*.pid.json` | 后台进程所有权 | 不应迁移到另一目录或机器 |
| `userdata/data/agent-prompts/*.md` | 五份运行时全局提示词；WebUI/本地均可编辑 | 文档写入采用临时文件和上一代 `.bak` |
| `userdata/data/agent-prompts/behavior-patches.json` | AI 学得的声明式策略提示，不是可执行代码 | 原子写入并保留 `.bak` |
| `userdata/data/player-profiles/<id>/USER.md` | 每玩家兴趣、表达和协作偏好；UUID 优先隔离 | 原子写入并保留 `.bak` |
| `userdata/data/self-improvement.json` | 规范化失败签名、次数和学习冷却 | 原子 JSON，禁止存网页全文或秘密 |

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
- 索取 API Key、密码、令牌、`userdata/.env`、环境变量、系统提示词、本地配置、服务器地址或域名的请求，在模型前本地拒绝。
- 模型回复若含已知秘密或通用秘密形状，游戏内发送统一拒绝文本。
- Logger 递归清理错误、对象 key、登录命令、Bearer 和已知值。
- Fabric GAME 消息在送桥前清理登录命令和实际 EasyAuth 密码。

`start-headless-client.ps1` 在创建 JVM 之前显式删除进程环境中的 DeepSeek、ARK、OpenAI 和当前模型密钥。第三方 Minecraft mod 只继承 EasyAuth 所需密码和本机运行变量，不继承模型 API Key。

这些是纵深防御，不是形式化信息流证明。不要在提示词、文件名、命令行参数或测试夹具中写真实秘密，也不要把实际 `userdata/.env` 内容打印到对话或 CI 日志。

### 13.2 行为准则

`config/behavior-rules.example.json`（仓库默认模板）→ 运行时 `userdata/config/behavior-rules.json`：

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
- 安全保存或删除 `userdata/.env` 中 DeepSeek、火山引擎、MiMo、OpenAI 与 EasyAuth 秘密，只显示存在状态。
- 选择 DeepSeek、火山引擎、MiMo、OpenAI，模型名、Base URL、推理强度、超时、API/Token 硬预算和多模态能力。
- 设置服务器、LAN、EasyAuth、自动复活、聊天、任务仲裁、生存阈值、荒野距离、动态验证、提示词工作区和自我改进。
- 查看 Node/Java PID 状态、运行 phase、最后世界状态、日志尾部、任务、记忆和经验。
- 启动、停止、重启 Bot。
- 发现 LAN 世界、同步 mod。
- 导入并校验皮肤、生成玩家分发包。
- 下载 memory/experience JSON。
- 发起一个最小模型连通性测试，并显示延迟、实际 Token 与检测出的视觉/语音/搜索能力。
- 总聊天按任务显示每轮工具、耗时与供应商 `usage`，侧栏汇总最近任务及 24 小时 API/Token 消耗；不保存隐藏推理正文。

保存全部设置后，正在运行的 Node/Java 不会热重载；必须点“重新启动”。Memory/experience 当前只能查看和下载，不能在运行中安全编辑或恢复上传。

WebUI 进程本身独立于 Bot；关闭浏览器标签不会停止 WebUI或 Bot。修改 `MCAI_WEBUI_PORT` 后 Host/Origin 规则会使用新端口。

## 15. Minecraft、模组、LAN、EasyAuth 和复活

### 15.1 模组同步

服务器要求 mod 的真实来源目录只应写入被忽略的 `userdata/config/mods.json` 或 WebUI，不要写入公共示例或文档。未来服务器增加 mod 时：

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

- 原文件：`userdata/data/skins/<Bot名>.png`
- Bot 隔离客户端：`.runtime/minecraft/CustomSkinLoader/LocalSkin/skins/<Bot名>.png`
- 官方未修改万用皮肤加载器：`vendor/custom-skin-loader/CustomSkinLoader_Universal-15.0.1.jar`
- 给其他玩家的包：`.runtime/skin-pack/Minecraft-AI-Skin-Pack.zip`

`client_pack` 模式下，每个需要看到 Bot 皮肤的玩家都必须把 zip 内容复制到自己使用的 Minecraft 实例并重启。LocalSkin 是客户端本地查找，不会因为 Bot 安装了 mod 就自动广播给别人。

长期多人服更适合所有玩家共同配置兼容在线皮肤站，并让离线 Bot 名对应同名角色。`microsoft` 模式只是配置预留；当前 Headless Microsoft 自动登录未实现。

### 16.2 披风和多模态语音

`skin.capeFile` 和 `userdata/data/capes` 只预留本地路径。正版官方披风不能用普通 PNG 伪造，必须由实际拥有披风的 Microsoft 账号提供；离线多人披风也需要共同皮肤站/客户端资源方案。

多模态 Agent 已定义外部音频帧入口 `userdata/data/sensory/latest-audio.json`，只读取 15 秒内、最大 2 MiB 的受支持 MIME，并只在首个模型轮发送一次。当前仍没有把其他玩家的 Simple Voice Chat 收音写入该文件的生产器，因此没有真实输入帧时状态必须为 `audio:unavailable`。

语音输出是独立链路：`src/speech/speech-service.ts` 将已经通过严格游戏聊天出口的台词交给 TTS；`FabricBridgeClient` 用 `voice_playback_begin/chunk/end` 在本机鉴权桥分块传输 PCM；`VoicePlaybackManager` 重采样并复用 Simple Voice Chat 客户端已经建立的加密 UDP 连接发出 Opus 麦克风包。Headless 没有 OpenAL speaker 或物理 microphone 不再阻塞输出语音。输入不可用不得被误写为输出不可用，反之亦然。

## 17. 中国大陆网络设计

已实现的路线：

- `.npmrc` 使用 `https://registry.npmmirror.com`，锁文件依赖也指向 npmmirror。
- Minecraft 版本元数据/客户端使用 BMCLAPI，按官方 SHA-1 和 size 校验。
- Minecraft 库默认使用 CERNET BMCLAPI 路径，按元数据 SHA-1 校验。
- HeadlessMc 默认先尝试 GitHub 下载镜像，再回退官方 URL，固定 SHA-256 校验。
- Fabric API 固定版本和 SHA-256，可用 `MCAI_FABRIC_API_URL` 指定可达镜像。
- 万用皮肤加载器二进制随仓库 vendor 并固定 SHA-256，运行时不必再访问 GitHub。
- WebUI 的 HTML/CSS/JS 全部本地提供，不依赖境外 CDN。
- 大模型可优先选择 DeepSeek、火山引擎或小米 MiMo 国内端点；OpenAI 是否可达取决于部署网络。

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

若本地 `userdata/config/mods.json` 配置了来源，也要重新同步。没有这一步，真实进服仍可能加载 `.runtime` 中的旧 bridge jar。

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

1. 查看 `userdata/data/bot.pid.json`、`userdata/data/minecraft-client.pid.json` 是否属于当前项目根。
2. 查看 `logs/background.stderr.log`、`logs/minecraft-client.stderr.log`。
3. 确认 `dist/src/index.js`、HeadlessMc jar 和 `.runtime/minecraft/mods/minecraft-ai-fabric-bridge-1.0.0.jar` 存在。
4. 用 `Start-Bot.cmd` 成对启动，不要只开 Java 或只开 Node。
5. 确认桥 host/port 相同且 `userdata/data/bridge-token.txt` 非空。
6. 如果项目移动过，删除已经停止进程遗留的 PID 文件；停止脚本会做所有权检查，不要手工杀不明 PID。

### 19.2 Bot 不回复

依次检查：

- phase 是否 `in_world`，EasyAuth 是否成功。
- 发言者是否在寻址距离内，消息是否点名 Bot、以 `!` 开头或满足会话延续。
- 装饰聊天格式是否仍能被 `chat-parser` 识别。
- `userdata/.env` 中当前 provider 对应 key 是否存在；WebUI 模型测试是否通过。
- `userdata/data/tasks.json` 是否卡在 running，Fabric 是否断线。
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
git ls-files userdata .env config/bot.json config/persona.json config/prompts.json config/mods.json config/skin.json config/behavior-rules.json logs .runtime
npm run audit
npm run audit -- --history
```

`git ls-files` 对受保护路径应无输出。审计脚本会检查跟踪文本的严格 UTF-8、BOM、控制字符、双向/零宽字符、常见乱码、秘密形状、已知 `userdata/.env` 秘密和受保护路径；`--history` 扫描全部 Git 对象且不打印秘密值。

最终测试使用的 API Key 必须通过 WebUI 删除或从 `userdata/.env` 移除。即使 `userdata/.env` 已忽略，也要满足用户“完工后删除”的要求。真实服务器 host 可以留在忽略的本地 `userdata/config/bot.json` 供用户继续运行，但绝不能进入 Git 或截图。

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
4. `userdata/`（含 `.env`、`config/*.json`、`data/`）、皮肤和 mod 来源是忽略的机器状态，不会随 Git 同步。
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
5. 门和栅栏门已经纳入本地路线并可交互开启；继续增加梯子、藤蔓、脚手架、动态实体避让、岩浆/着火逃生及未知模组危险注册表，并评估 26.2 Baritone 适配但保持安全边界。
6. 把当前持久阶段检查点进一步升级为带前置、资源预算、幂等 key、恢复点和部分施工账本的任务 DAG。
7. 增加农业/繁殖、药水、铁砧、锻造台/下界合金和更灵活住所；未知模组物品默认拒绝。
8. 增加记忆摘要、经验实际应用计数/验证、任务归档和 WebUI 安全导入/编辑。
9. 实现 Microsoft Headless 登录与正版皮肤/披风路径。
10. 在无 VPN 的干净中国 Windows 验证一键安装和所有镜像回退。
11. Simple Voice Chat TTS 输出已实现；下一步是实服多人听见矩阵、版本升级兼容检查，以及独立的玩家语音收音/STT。语音始终不得阻塞文本控制主线。

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
- 运行目录的 `userdata/`、`logs`、`.runtime` 含本机部署数据并由 Git 忽略。不得把实际服务器地址、API Key、EasyAuth 密码、PID、记忆、玩家画像或日志同步到公开仓库。
- 最新用户指令授权在完成验证后把非隐私改动同步到本地仓库、提交并推送 `origin/main`；它取代本节旧版本曾记录的“禁止提前推送”阶段性约束。

### 23.2 新状态数据

`WorldStateEncoder` 每 5 秒最多扫描一次，以 Bot 方块坐标为中心，水平半径 8、垂直半径 5，只读取已加载位置。结果写入 JSONL state 的 `blockSurvey`，Node 经 `FabricBridgeClient.#blockSurvey` 严格校验后进入 `WorldState`：

- `resources[]`：按 tag/ID 识别 logs、leaves、stone、soil、surface、coal/iron/copper/gold ore；每项有 `blockId/category/count/nearestDistance/nearest`。
- `artificial[]`：方块实体，或名称含 planks、bricks、door、fence、stairs、slab、glass、concrete、terracotta、wool、carpet、bed、chest、barrel、furnace、crafting_table、redstone、rail、torch、lantern、ladder、bookshelf 的方块。
- `protectedLikely=true`：发现方块实体或至少 4 个疑似建筑方块；分类为 `protected_structure_nearby`。有自然资源且未触发保护启发式时为 `natural_terrain_likely`，否则 `uncertain`。
- 背包方块物品增加 `placeableBlockId`，供 Node 在执行前判断是否具备可放置材料。

这只是保守启发式，不是方块所有权证明。世界修改必须同时通过策略层和 Fabric 逐目标验证；不得仅因扫描“看起来天然”就破坏。

### 23.3 已退役：确定性基础命令

历史版本的 `src/agent/basic-command.ts` 会在 LLM 前根据关键词把玩家文字直接转换为动作。该文件及测试已于 2026-08-06 删除：它会把“我刚才挖到钻石了”一类聊天误判为任务，还会把“不要跟着我”中的“跟着我”错误识别成开始跟随。现在所有普通玩家消息都由模型读取完整上下文后选择 `chat/action` 和工具；本地只保留停止/取消的安全抢占、秘密拒绝、队列排序、能力/策略检查与 Fabric 后置条件。

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
- Fabric：Java 25 下 `gradlew.bat clean build --no-daemon` 成功，新 jar 已复制到 `.runtime/minecraft/mods/minecraft-ai-fabric-bridge-1.0.0.jar`。
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
- 拒绝岩浆、火、仙人掌、岩浆块、甜浆果丛、细雪和营火落脚点。水体节点支持水平游动和向上浮水；可徒手开启的门与栅栏门可作为路线节点并在到达时交互开启；低矮通道会用 1.5 格潜行碰撞箱规划并保持蹲下。当前仍未实现梯子、藤蔓、脚手架和未知模组危险注册表。
- 目标位移超过 1.25 格、80 tick 周期、当前 waypoint 失效、碰撞至少持续到规划后 4 tick 或 18 tick 无进展时重规划。路线驱动只朝下一个方块中心按前进，需要升高时跳跃；前方再次有碰撞且不是计划跳跃时立即松开前进并清空路线，下一 tick 重规划，绝不保持按键顶墙。
- `setMovement` 在接受普通移动动作时立即规划第一段：找不到已加载、碰撞安全的路线就返回失败并松开全部移动键，不能再把“朝目标开始移动”误报成成功。路线已经开始后，非跟随目标连续 20 次重规划失败才停止；跟随允许目标或加载地形变化后继续重试。
- `PrimitiveTaskController.finish`、`ShelterController.finish` 和桥断线/换世界/到达时释放导航状态与按键。住所控制器原来的 `moveConservatively` 也只负责调用同一 A*，寻找安全处、前往床、回家及进入建造点不再使用朝目标直走的独立实现。桥每秒上报 `navigationStatus`，WebUI 状态页可看到当前 waypoint、路线长度、目标或最近失败原因。

`LocalPathNavigator` 当前依赖 Minecraft 客户端类，Gradle 没有模拟世界测试；Java 25 `gradlew.bat build --no-daemon` 只证明编译和 Fabric 映射兼容。后续应抽出纯方块图接口，为长墙、U 形墙、一步升降、悬崖和危险地面建立确定性地图测试。

### 24.3 双聊天通道与诊断持久化

新增 `src/diagnostics/diagnostic-store.ts`，固定写 `userdata/data/diagnostics.json`，schemaVersion 1，最多 1000 条，使用 `AtomicJsonFile` 原子替换和 `.bak`。事件类型包括 request、decision、step、result、failure、lifecycle；记录 taskId、玩家、模型名、结构化 action JSON、逐步结果和完整错误。所有标题/摘要/detail 进入存储前都经过 `SecretGuard.sanitizeForPersistence`，detail 最长 12000 字符。

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
- Fabric Java 25 build：通过；新 jar 已覆盖 `.runtime/minecraft/mods/minecraft-ai-fabric-bridge-1.0.0.jar`。
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

`userdata/data/progression.json` 保存 `goal/stage/lastAction/lastReason/lastResult/milestones/failures`。`ProgressionStore.notePlan` 只允许最高阶段单调前进：钻石阶段中的临时进食、补工作台等不会让交接状态退回 survive/wood。采集失败键为 `gather_resource:<resource>`，石头路径失败不会污染煤、铁或钻石的决策。

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

现场根因证据是 Minecraft 日志中的 `BotName drowned`（公开文档已替换实际账号名）。新救援实现已编译、部署并重新进服，但尚未在相同冰下条件复测；后续 Agent 第一项实服安全验收应复现“追鱼进入冰下→氧气低于 75%→离水/破冰→未死亡”，并记录空气值、坐标、`survivalDetail` 和最终呼吸恢复，不能只等待日志无死亡。

### 25.6 食物、工具、设施和模组兼容

`WorldStateEncoder.item` 读取 `DataComponents.FOOD` 与 `CONSUMABLE`，向 Node 发送 `foodNutrition/foodSaturation/safeFood`。已知不安全名单包含腐肉、蜘蛛眼、毒马铃薯、河豚、生鸡肉、迷之炖菜和紫颂果；其他具有组件的模组食品可作为安全储备。现场确认 Farmer's Delight 鸡汤为 `safeFood=true`，腐肉为 false。

规划器按相同颜色最大羊毛栈制作床；不会把三种不同颜色各一份误当成配方。工作台、熔炉、床和附魔台只有在背包中或 `blockSurvey.owned[]` 中才算 Bot 可用设施。`OwnedBlockRegistry` 保存 `{dimension,x,y,z,blockId}`，扫描时删除/忽略与服务端实际方块不符的记录。这个精确账本高于“附近看起来是工作台”的启发式。

### 25.7 配置和迁移新增项

`config/bot.example.json` / 实际 `bot.json`：

- `storage.progressionFile` 默认 `data/progression.json`。
- `storage.ownedBlocksFile` 默认 `data/owned-blocks.json`，`start-headless-client.ps1` 限制它必须留在项目 `userdata` 内并通过 `MCAI_OWNED_BLOCKS_FILE` 传给 Java。
- `autonomy.eatBelowFood` 默认 20。
- `autoHunt/autoSmelt/autoMine/autoTrade/autoEnchant/autoDimensionTravel/autoSleep/protectOwner/allowVerifiedWilderness` 均由 loader 校验布尔值。
- `longTermGoal` 当前只能是 `reach_end`。

迁移/升级 = 只替换 `userdata/` 一个文件夹（含 `memory.json`、`experience.json`、`tasks.json`、`autonomy-state.json`、`progression.json`、`owned-blocks.json`、`agent-prompts/`、`player-profiles/`、`self-improvement.json` 和 `userdata/.env`）。不要迁移 PID、`bridge-token.txt`、`runtime-status.json` 或整个 `.runtime`。旧版可跑 `node scripts/migrate-userdata.mjs` 一次性迁移。

### 25.8 当前验证与尚未宣称完成的内容

最近候选工作树：TypeScript check、完整 Node 测试、TypeScript 生产 build、Java 25 完整 Gradle build和 WebUI 浏览器读写回归成功；同步到 Git 工作副本后仍要重跑审计和构建。实服既有证据已完成自动进食、工作台/熔炉放置、熔炉合成、完整石器和上下行矿道后置条件。交易、附魔、床、下界/要塞/末地是“代码实现 + 编译/Node 规划测试”，不是本轮现场完成；冰下自救也是“根因现场复现 + 修复部署，待复测”。

最终交付前仍必须：

1. 后续修改 WebUI 时重新回归运行状态、配置保存、总聊天、进度和自有方块；如果浏览器工具支持控制台事件，再补做控制台错误检查。
2. `npm run check/test/build/audit`、`node --check public/webui/app.js`、Gradle build、`git diff --check`、UTF-8/U+FFFD/控制字符/秘密/真实域名扫描。
3. 只把源码、测试、示例和三份文档同步到 Git 工作副本；绝不复制 `userdata/`、`logs`、`.runtime`、`node_modules`、`dist` 或 Fabric build。
4. 在 Git 副本再次审计，确认示例服务器仍为 `你的域名.com`，再暂存、提交、推送 `origin/main`。
5. 推送后对比远端 commit；本地部署目录继续保留真实配置和运行数据，不从干净仓反向覆盖。

## 26. 2026-08-06 对话意图、解除跟随与人类式表达

### 26.1 根因与行为变化

- 玩家消息旧链路为 `inferBasicDecision → 命中则跳过 LLM → 动作`，关键词不理解否定和陈述语气，导致聊天误动作，也让“不要跟着我”重新触发 `follow_player`。
- 当前链路为 `AddressingEngine → TaskStore → LLM intent/tool plan → decision parser → capability → policy → Fabric`。除秘密提取与停止抢占外，所有被寻址消息都调用模型。
- 模型输出新增向后兼容字段 `intent=chat|action`。显式 `chat` 会强制改为 `action=none`、丢弃误带的 `actions[]`，不进入 capability、policy 或 Fabric；旧模型未输出 intent 时根据规范化后是否存在动作自动推断。
- `TOOLS.md` 明确要求结合整句、上下文、玩家画像和结构化世界状态判断。聊天、分享、提问、玩笑、感叹不因含动作词而执行；明确行动请求才由模型选择一个或多个工具。

### 26.2 停止抢占

`isImmediateStop()` 除原有停止/取消外，接受“不要再跟着我”“别跟随我”“不用跟我了”“结束跟随”等独立表达。该路径增加 `cancellationEpoch`、取消当前 running task，并无条件向 Fabric 发送 `stop`；即使先前 `follow_player` 的 TaskRecord 已完成，Java 内仍在持续跟随，也会释放跟随目标、导航与移动键。

### 26.3 人设表达

模板 `SOUL.md` / `IDENTITY.md` 现在要求游戏内把自己当作平等联机玩家，不主动自称 AI、Bot、助手、模型、程序或工具；多用第一人称，减少第三人称自称、舞台动作、固定卖萌和“收到/正在执行/任务完成/当前条件不足”等系统腔。模型正文不再自己添加 `@玩家名`，由 `#bestEffortReply` 统一添加，避免重复。失败、超时、停止和秘密拒绝的本地兜底语也改成短而自然的说法，完整错误仍只进入 WebUI 总聊天。

### 26.4 回归重点

- `intent=chat` 即使错误附带采集/矿道动作也不得调用 executor。
- “我刚才挖矿挖到了三颗钻石”只回复聊天，并将任务结果记为 `chat_only`。
- “跟着我”由模型选择 `follow_player`；随后“不要再跟着我了”不再调用模型，必须执行 `stop`。
- 明确采集、交付、合成等玩家请求必须能证明调用了模型，不能重新引入关键词动作旁路。
- 停止/秘密/危险安全规则仍是本地硬约束；“模型决定工具”不代表模型能绕过能力、财产保护或 Fabric 验证。

### 26.5 DeepSeek V4 JSON 空响应兼容

运行目录历史日志和 2026-08-06 单次真实 API 检查都复现了 HTTP 成功但 `choices[0].message.content` 为空。DeepSeek 官方 JSON Output 文档将其列为偶发现象；思考模式文档说明隐藏推理位于同级 `reasoning_content`，不能当最终答案。`ChatCompletionsProvider` 现在先按用户配置的推理强度请求；空内容时只记录 `choiceCount/finishReason/contentType/hasReasoningContent`，不记录思维链正文，然后修改系统提示、删除 `reasoning_effort`、设置 `thinking.disabled` 重试一次。返回值的 `requestedEffort` 保留原配置，实际降级时 `effectiveEffort=none`。单测验证两次请求体、最多一次重试及隐藏推理不泄漏。

## 27. 2026-08-06：原生原子工具 Agent（历史架构，已被第 28 节取代）

本节保留 2026-08-06 的原子工具演进证据，但“每一步只调用一个原子工具、每格重新请求模型”已因严重延迟和 Token 放大在 2026-08-07 被第 28 节取代。旧解析器、高层控制器仍可被复用为经验证的执行器；正式 DeepSeek、火山方舟、MiMo 和 OpenAI provider 都进入第 28 节分层 Agent。

### 27.1 实际控制流

玩家路径：

```text
聊天 → 寻址/多人队列/停止抢占 → 加载人设、该玩家 USER.md、记忆与经验
     → ToolAgent
       → 模型读取目标 + 当前结构化世界状态
       → 模型原生 function call（只执行第一个）
       → 参数解析 → PolicyEngine 硬检查 → Fabric 原子操作
       → 服务端后置条件 + 最新世界状态回到模型
       → 模型重新判断下一步，直到自然语言结束/拒绝/达到步数上限
     → 最终自然语言进入游戏；完整脱敏工具结果进入 WebUI 总聊天
```

空闲路径同样创建 `ToolAgent`，目标为“根据当前环境自主推进生存发育，最终进入末地”。`model.autonomousAgentMaxSteps` 限制单轮工具数，玩家消息增加 cancellation epoch、发送 `stop` 并抢占空闲循环。Java 的进食、氧气、燃烧、近身威胁和死亡复活仍是硬实时反射：这些反射不依赖云模型延迟，但不负责决定采矿、建房或长期发展。

`src/agent/tool-agent.ts` 仍是核心循环，且仍只接受一次一个模型 tool call；区别是模型现在可以选择原子接口或连续运动技能。连续技能内部可执行许多 Tick/方块而不请求模型，在技能里持续做碰撞、安全和后置条件检查；模型在里程碑、失败或环境显著变化后重规划。

### 27.2 模型可见工具（唯一公开动作面）

下表是保留的原子能力。当前 `AGENT_TOOLS` 还包含第 28 节列出的连续技能；它们不是聊天关键词绑定的整套任务脚本，而是由模型选择参数的快速运动/生产原语：

| 工具 | 作用与真实边界 |
| --- | --- |
| `observe_world` | 刷新结构化观察；不改变世界。每个动作结果本身也附带新观察。 |
| `navigate_to` | 到明确坐标的碰撞安全 A*；等待到达、无路或超时才返回，不把“开始走”当完成。 |
| `look_at` / `select_hotbar` | 转视角；选择 0–8 快捷栏。 |
| `break_block` | 破坏观察中的一个精确坐标和预期方块 ID；Node/Fabric 均检查范围、天然性、玩家结构、方块实体、危险源和后置条件。 |
| `place_block` | 在精确空气方格放一个指定背包方块；逐目标验证支撑、碰撞、归属与服务端结果。 |
| `attack_entity` | 对观察中的非玩家实体做一次近战攻击；不自动选目标或追杀。 |
| `interact_entity` / `interact_block` | 对一个明确实体或方块交互一次；未知归属方块实体/容器被硬拒绝。 |
| `use_held_item` | 使用当前手中物品一次；进食等以可观察后置条件确认。 |
| `drop_inventory_item` | 从自己的背包槽位丢出指定数量，不自动移动或寻找收件人。 |
| `craft_recipe` | 执行一个已解锁且材料充足的具体配方；不自动采材料或继续后续配方。 |
| `send_server_command` | 只允许 `tp <player>` / `teleport <player>`，把 Bot 自己传向一个普通玩家名；默认禁用且无权限会正常失败。 |
| `stop_all_actions` / `wait_ticks` | 释放所有动作；或等待 1–100 tick 再观察。 |

这满足“给手脚而不是摆整套脚本按钮”的边界：模型可以根据目标自由组合最小操作，但真实能力仍必须以有限、类型化、可审计接口进入客户端。完全开放键盘、任意数据包、任意命令或模型生成 JS 会绕过财产保护与后置条件，因此不是本项目的 Agent 定义。

当前 `craft_recipe` 在 Java 内复用 `PrimitiveTaskController.CraftItemTask` 完成一个具体配方；精确 `break_block`/`place_block` 也复用旧控制器中已经验证的单块执行器。这里复用的是“一次具体原子操作”的后置条件代码，不是让模型调用采集资源、建房或生存主链脚本。新增玩法必须优先扩展感知字段和原子接口，禁止再用自然语言关键词增加高层旁路。

### 27.3 世界感知与 Fabric 接口

`WorldStateEncoder` 新增 `nearbyBlocks`：半径 6、上下 4 格，最多 256 个已加载且暴露/近身方块。每项包含 `x/y/z/blockId/resourceCategory/classification/blockEntity/replaceable/fluid/destroySpeed/distance`；classification 为 `natural_resource`、`protected_likely`、`bot_owned` 或 `unclassified`。Node 传模型前最多保留 96 个，附近实体/玩家/掉落分别最多 24 个，降低上下文膨胀。`selectedHotbarSlot` 与完整背包槽位一起提供。

`MinecraftAiBridgeClient.PendingNavigation` 让 `navigate_to` 保持 pending，只有到达、持续无安全路线、取消、死亡/换世界或超时才回 action result。`stop`、新玩家任务和桥断开都会取消导航并释放按键。新增 Java 原子 action：`look_at`、`select_hotbar`、`attack_entity`、`interact_entity`、`interact_block`、`drop_inventory_item`、`send_server_command`；精确 break/place/craft/use 规范化到单次可验证 primitive。Fabric action result 是模型下一轮的事实来源，Node 不能把请求已发送当成成功。

### 27.4 三类供应商的会话协议

- DeepSeek/火山方舟：`src/llm/provider-factory.ts#ChatCompletionsProvider.toolTurn` 发送 `tools`、`parallel_tool_calls:false` 和消息会话。工具结果以 `{role:"tool",tool_call_id,content}` 追加。DeepSeek 思考模式必须保留上一条 assistant 的 `reasoning_content`、`content` 和 `tool_calls`；适配器会原样留在 continuation，但不向日志/WebUI暴露推理正文。
- OpenAI：`OpenAiResponsesProvider.toolTurn` 使用 Responses API；首轮发送 system/user 和 function tools，后续使用 `previous_response_id` 与 `function_call_output`。只从 `function_call` 读取 call id/name/arguments，从 `output_text`/message 读取最终回复。
- `MissingKeyProvider` 同时拒绝 `complete` 与 `toolTurn`。`LlmProvider.complete` 仅给旧兼容分支、上下文压缩和自我改进摘要使用，不再承担当前游戏行动。

Chat Completions 每次完成一个工具后，ToolAgent 会在下一请求前重建最小合法 continuation：起始 system、去除图片/音频后的 user、旧步骤执行账本、最新含 `tool_calls` 的 assistant，再由 provider 追加当前 tool result。旧 assistant 推理和旧 tool message 不再线性累积；最新 DeepSeek assistant 的 `reasoning_content` 保持原样，避免破坏供应商续轮要求。OpenAI Responses continuation 不是消息数组，不经过这条压缩。

### 27.5 TP 权限与配置

`autonomy.allowTeleportCommand` 默认 `false`。`scripts/start-headless-client.ps1` 映射为 `MCAI_TP_COMMAND_ENABLED`；Java 环境变量未显式为 true 时返回 `permission_not_configured`，不会盲发命令。即使开关打开，Node PolicyEngine 和 Java 都只接受正则意义上的 `tp|teleport <普通玩家名>`，拒绝斜杠嵌套、坐标、选择器和其他命令。管理员必须先在服务器权限系统中给 Bot 账号相应权限，再从 WebUI 打开开关；没有权限时 Agent 收到失败结果后应走路或说明当前到不了。

`model.agentMaxSteps` 当前默认 12、范围 1–128；`model.autonomousAgentMaxSteps` 当前默认 8、范围 1–64。第 28 节另有 API 次数、任务累计 Token、单次输入和单轮输出四道硬上限；不要再提高步数来掩盖执行速度问题。

### 27.6 提示词、WebUI 与诊断

`config/agent-prompts.example/TOOLS.md` 和运行副本 `userdata/data/agent-prompts/TOOLS.md` 不再要求输出 action/actions JSON，而是解释观察→一个工具→结果→重规划。`IDENTITY.md`/`SOUL.md` 也只规定最终人类语言风格与工具参数纯净。运行时 function JSON Schema 由 `AGENT_TOOLS` 直接发送，是参数唯一真值；提示词不能凭空增加能力。

WebUI 增加玩家/空闲 Agent 步数和 TP 权限开关。每次工具调用在 `userdata/data/diagnostics.json` 写 `source:native-tool-loop`、工具名、参数、脱敏 detail、步数与成功状态；这里只保存可观察调用摘要，不保存隐藏思维链。游戏聊天只得到最终自然语言，`naturalGameText` 继续拦截 JSON、工具名、命名空间 ID 和底层错误。

### 27.7 测试和仍待实服证明的内容

新增 Node 测试覆盖：

- ToolAgent 必须用第一个真实工具结果重新调用模型；最终文本前执行顺序可验证。
- `send_server_command` 返回无权限时，失败和新世界状态必须交回模型，不能沿旧计划继续。
- DeepSeek 工具续轮必须携带 assistant `reasoning_content`、`tool_calls` 和对应 tool result。
- OpenAI Responses 第二轮必须携带 `previous_response_id` 与匹配 call id 的 `function_call_output`。

本次候选在 Java 25 下完成 Fabric Gradle build，`npm run check` 和 93 项 Node 测试全部通过，仓库审计为 0 问题。同步实际运行目录、更新 Fabric jar 并后台重启后，客户端重新达到 `in_world`，上报 `nearbyBlocks=256`。真实 DeepSeek 思考模式先调用 `craft_recipe(minecraft:torch,20)`，Fabric 返回 `verified_crafted_count=20` 且状态背包确认 20 个火把；模型读取该结果后第二轮调用 `select_hotbar(3)`，状态确认选中槽 3。随后 15 个实际工具步中，Agent 移动约 60 格；针对“附近玩家不足荒野 48 格”“无安全路线”“物品栏换位未确认”“缺自有 3×3 工作台”等失败分别重规划；成功制作木棍和工作台、第一次放置失败后选择快捷栏再成功放置，并破坏一块经验证的天然草方块。第 16 步预算耗尽后以 `agent_step_budget_exhausted:16` 安全结束。全部诊断来源都是 `model-tool-loop`，证明没有落入旧 `local-deterministic` 分支。

该轮同时定位到 `normalizeAgentPrimitive(craft_recipe)` 没有写入内部 `verifiedWilderness`，所以 `createCraftTask` 无法创建动态安全工作窗口，即使工作台已经成功登记也会提前拒绝 3×3 配方。现已在 Java 归一化层补入该内部标志：模型 schema 仍没有该字段，Fabric 仍须调用 `WildernessGuard.workZone` 并在 `OwnedBlockRegistry` 找到服务端现状一致的自有工作台。修复后 Java 25 build 成功，更新运行 jar 并重启实服客户端；第二轮 Agent 自行 `craft_recipe(crafting_table)`、`place_block(crafting_table)`，随后 `craft_recipe(furnace)` 得到 `verified_crafted_count=1; itemId=minecraft:furnace; grid=3x3`，再成功 `place_block(furnace)`，因此 3×3 修复已有真实后置条件证据。该证据仍不等于从零自主通关；TP 无权限实服回退、战斗和跨维度长链也需继续验收。当前没有通用容器槽点击工具，铁砧、锻造、酿造与任意模组菜单仍需新增“菜单观察 + 原子槽操作”后才能称为 Agent 可自由操作，不能借旧高级脚本宣称已经满足。

## 28. 2026-08-07：低延迟分层 Agent、费用硬预算与 MiMo 多模态

本节是当前实现真值，并取代第 27 节中“一次原子动作后必定重新请求模型”的控制频率。目标不是退回关键词脚本，而是像通用 Agent 使用 skill 一样，把策略判断留给模型，把无需语言推理的重复运动交给本地、可取消、可验证的执行器。

### 28.1 Token 事故复盘

`userdata/data/diagnostics.json` 中的现场任务显示：任务启动后先同步等待约 16 秒的上下文压缩；随后进行了 48 个模型工具轮，模型几乎每轮只选择一个 `break_block`，相邻动作通常间隔 7–27 秒，约十分钟后在 Y=52 以步数耗尽失败。该任务没有供应商 `usage` 字段，用户账单侧观测接近五百万 Token，因此不能把日志估算伪装成精确结算值。

四个根因同时存在：

1. 一个方块对应一次云端策略调用，网络、推理和排队延迟直接变成挖掘速度。
2. 完整 function tools 和不断增长的 Chat Completions 会话每轮重发。
3. `#processToolTask` 把 WorldState 放进玩家目标，`ToolAgent` 又追加一份，起始世界重复。
4. 单轮输出允许 4096 Token，且每轮沿用高推理；没有 API 次数、累计 Token 或单次输入硬闸。

### 28.2 当前控制流

```text
玩家自然语言 / 空闲目标
  → 模型读取一次紧凑世界、该玩家画像、人设、记忆和经验
  → 模型自行选择一个原子接口或连续技能，并填写参数
  → Node 能力/策略检查
  → Fabric 逐 Tick 执行、碰撞避障、安全验证、服务端后置条件
  → 只把增量观察返回模型
  → 模型在完成一个里程碑、环境改变或失败时重新规划
  → 自然聊天回复；完整脱敏诊断只进 WebUI
```

模型仍负责“为什么做、先做什么、目标在哪、参数多少、失败换哪条路”；连续技能只负责“怎样连续走、挖、放、合成、熔炼或攻击并确认成功”。没有任何聊天关键词可以直接启动这些技能。普通聊天可以直接结束，不会因为出现“钻石/挖矿”等词就行动；玩家命令只有在模型产生 tool call 后才进入执行层。

### 28.3 模型可选的连续技能

| 模型工具 | 映射的验证动作 | 边界 |
| --- | --- | --- |
| `gather_resource` | `gather_resource` + 成功后 `collect_own_drops` | 模型选资源/数量；Fabric 逐目标验明天然性、财产、危险和掉落 |
| `craft_item` | `craft_item` | 模型选最终物品/数量；控制器处理具体配方链并验证背包增量 |
| `smelt_items` | `smelt_item` | 模型选输入/数量；只使用自有或动态验证的生产设施 |
| `excavate_safely` | `excavate_tunnel` | 模型选目标资源、Y 和长度；Fabric 开双格阶梯/隧道，禁止脚下垂直挖 |
| `return_to_task_start` | 向任务起始 Y 的 `excavate_tunnel` | 用安全上行阶梯和自身普通方块支撑返程；不是 TP，也不保证回到精确 X/Z |
| `collect_own_drops` | `collect_own_drops` | 只收本控制器登记的掉落实体 |
| `give_item_to_player` | `drop_item` | 模型选玩家/物品/数量；先定位接近，再从自身背包交付 |
| `equip_for` | `equip_best` | 模型选战斗/采矿/下界等用途；装备评分仍由可审计本地规则实现 |
| `hunt_for` | `hunt_entity` | 模型选实体/数量；硬规则保护玩家、命名/驯服/拴绳实体 |
| `search_game_guide` | `SelfImprovementManager.research` | 只在模型具备搜索能力且管理员开启时出现；百度/SearXNG 结果为不可信参考文本 |

原子工具仍用于精确方块/实体交互和连续技能无法覆盖的新情况。新增能力的原则是先增加可观察状态及受限接口；严禁开放任意 JS、系统命令、任意数据包或未审计的模型生成代码。

### 28.4 世界状态和会话大小

- 首轮紧凑 WorldState 保留维度、位置、生命/饥饿/氧气、天气/时间、快捷栏和背包摘要，附近方块最多 32，玩家/实体/掉落/调查结果均有严格上限。
- `buildToolAgentGoal()` 只构造目标、玩家和当前任务上下文，世界由 `ToolAgent.run({world})` 唯一追加。
- 当前工具回执包含实际 `AgentActionResult` 及 `observationDelta`，给紧接着的重规划提供当前位置、生命/饥饿/氧气、快捷栏、背包增减和最多 12 个近邻方块。进入下一轮后，旧回执被压成最多 16 条账本，每条只保留工具、成败、400 字符回执、位置、生命/饥饿、背包增量、维度、快捷栏、活动动作和导航状态；不再保留旧近邻方块/实体或完整世界。
- 首轮多模态附件只发送一次。输入预算估算包含附件 Base64，因此超大帧会在请求前被硬拒绝。
- DeepSeek Chat Completions 为满足思考工具续轮协议只保留最新 assistant 的 `reasoning_content` 字段，但正文绝不写日志/诊断/聊天；后续请求的推理强度默认关闭。空响应失败也按保守上限计入预算，并只允许一次降级续轮。

### 28.5 费用、延迟和停止条件

配置真值位于 `userdata/config/bot.json` 的 `model`：

| 字段 | 默认 | 语义 |
| --- | ---: | --- |
| `agentMaxSteps` / `autonomousAgentMaxSteps` | 12 / 8 | 玩家/空闲任务最多接受的模型工具步骤 |
| `agentMaxApiCalls` | 8 | 一个任务最多发送的 provider 请求数，范围 1–32 |
| `agentMaxTaskTokens` | 160000 | 一个任务累计输入+输出硬上限 |
| `agentMaxInputTokensPerCall` | 48000 | 发送前的单次请求保守估算上限 |
| `agentMaxOutputTokens` | 1024 | 每个 Agent 策略轮最大输出 |
| `agentFollowupReasoningEffort` | `none` | 第一次工具成功后的重规划推理强度 |

`LlmUsage` 统一记录 `inputTokens/outputTokens/totalTokens/reasoningTokens/cachedTokens`。MiMo、DeepSeek、豆包工具轮按响应 `usage` 解析；供应商缺失时 `ToolAgent` 用保守估算：ASCII 约四字符一 Token，非 ASCII 约 1.1 字符一 Token，再加输出文本/工具参数。发送前会同时预留整段 `agentMaxOutputTokens`，因此不会明知下一轮可能超过任务预算仍发送。估算只用于提前停止，账单仍以供应商为准。

触发步数、API、任务 Token 或单次输入任一上限后，不再向模型发送请求。若本轮曾下探，安全层会用最多四个 64 格上行阶梯尝试回到起始 Y；每段仍经过 Fabric 的财产/流体/碰撞检查。WebUI 总聊天事件 `模型工具轮 n` 包含该轮耗时、真实或估算 usage 和累计值；侧栏按 `taskId` 汇总最近任务，另汇总 24 小时窗口。

### 28.6 MiMo 和多模态感知

`src/llm/provider-factory.ts` 新增 `mimo` Chat Completions provider。默认配置：

```json
{
  "provider": "mimo",
  "model": "mimo-v2.5",
  "apiKeyEnv": "MIMO_API_KEY",
  "baseUrl": "https://api.xiaomimimo.com/v1"
}
```

适配器使用 `max_completion_tokens`、`thinking:{type:"enabled|disabled"}`、function tools、标准 image/audio/video content，并解析 `usage`。官方参考：`https://mimo.mi.com/docs/en-US/api/chat/openai-api`、`https://mimo.mi.com/docs/en-US/api/model/list-models`、`https://mimo.mi.com/docs/quick-start/summary/model`。

`detectModelCapabilities()` 返回 `vision/audio/video/webSearch`：DeepSeek 明确为纯文本；MiMo 2.5/Pro 自动全开；OpenAI 与豆包按模型名保守识别。未知模型若 `model.multimodal.autoDetect=false`，管理员可用三个开关显式声明，随后必须做 WebUI 最小测试。

`src/agent/multimodal-sensors.ts` 的真实边界：

- 摄像桥可原子更新 `userdata/data/sensory/latest.png`；仅接受 15 秒内、最大 1.5 MiB。没有新鲜帧时由 WorldState 生成 128×128 PNG 语义俯视图，颜色来自实际附近方块/实体类别，不是假截图。
- 音频桥可原子更新 `userdata/data/sensory/latest-audio.json`：`{"capturedAt":"ISO","mimeType":"audio/wav","dataBase64":"..."}`。仅接受 15 秒内、最大 2 MiB 的 wav/mpeg/mp3/ogg/webm/flac。当前仓库没有 Simple Voice Chat 生产器，所以默认无附件。
- `onlineResearchEnabled` 只控制攻略查询工具是否暴露；它不让模型直接浏览任意 URL，不执行网页指令，也不允许网页改变 `rules.md` 或源代码。

### 28.7 测试与尚未完成的实服证据

新增回归覆盖：模型面对钻石目标选择 `excavate_safely` 时只产生一个连续 `excavate_tunnel`，而不是多个 `break_block`；累计 Token 触顶前停止下一次 provider 请求；MiMo 请求体、附件、thinking、usage 和能力检测；语义 PNG 的真实签名/尺寸；缺失语音帧不生成伪附件；DeepSeek 纯文本不附加视觉。

本节代码完成时 `npm run check` 与 99 项 Node 测试均通过；这是带日期的工作快照，不是以后固定数量。尚未完成的诚实边界：没有真实 MiMo Key，因此 MiMo 只完成协议 mock 回归；Simple Voice Chat 帧生产器未实现；“挖到一颗钻石并安全交付”仍需在同步运行目录、重建后用硬预算做一次完整现场验收，不能用单测替代。

受控现场验证追加证据：私有运行目录保留原配置/密钥/记忆并同步重建后，真实 Fabric 客户端成功进服。无模型调用的两段桥测试从 Y=52 下探到 Y=50：`verified_tunnel_steps=1; verified_broken_blocks=6; verified_support_blocks=0; inventory_delta=6; final_y=50`；再向上返回：`verified_tunnel_steps=1; verified_broken_blocks=1; verified_support_blocks=0; final_y=52`。测试后客户端停止。

真实 `deepseek-v4-flash` 的单 API 决策检查使用 1024 输出上限，约 6.7 秒，供应商 usage 为输入 3364、输出 590、总计 3954、其中 reasoning 414、cached input 3328。模型没有逐格调用 `break_block`，而是选择 `excavate_safely(resource=diamond_ore,target_y=-50,length=30)`，本地映射为一个带 `verifiedWilderness` 的连续 `excavate_tunnel`。该检查使用 mock executor，验证的是策略选择和真实计费，不修改世界；与上段 Fabric 测试组合证明“模型选连续技能”和“客户端快速连续执行/返程”两层均贯通，但仍不能宣称已经实际取得钻石。

同日还观测到：人为把 Agent 输出压到 512 时，DeepSeek 高思考偶尔只返回隐藏推理而没有工具/正文，provider 会安全报错且不执行动作。不要为此增加无界隐式重试；默认 1024 已在受控请求成功，WebUI 可按模型需要调大，但任务总 Token/API 硬预算必须保留。

## 29. 2026-08-07：寻址、任务确认、适应性跟随和工具选择实现细节

### 29.1 玩家专属称呼的数据流

唯一存储源是 `userdata/data/player-profiles/<uuid-or-name>/USER.md` 的“该玩家对 AI 的称呼”小节。`PromptWorkspace` 解析项目符号并去重；Fabric/Mineflayer 收到消息后先按 UUID/名称解析当前发言者画像，再把别名数组传给 `AddressingEngine`。被命中的固定名或别名会连同前导中文标点从交给模型的文本中删除。未命中消息仍只作为旁听记录写入统一记忆。别名读取失败会进入本机日志，不应把消息误发给模型。

运行时不会把玩家画像全部载入寻址器，也不会让 Alice 的昵称触发 Bob。自然声明学习位于 `AgentController.handlePlayerMessage`，因此玩家必须先用旧名称、`!` 或有效近距离语境进入消息处理器；程序只识别明确的未来称呼句式。WebUI 没有新增另一份设置表，仍编辑同一个 `USER.md`，避免双数据源漂移。

### 29.2 开工回应的时序

禁止在调用模型前猜测消息是聊天还是任务。ToolAgent 收到供应商首个 `tool_call` 后调用 `onToolSelected`，AgentController 用一次性闭包发送带玩家 `@name` 的自然回应，然后 ToolAgent 才解析参数、授权并执行。这样回应发生在动作之前，也不会增加一次模型请求。若参数随后非法或硬策略拒绝，详细原因仍写总聊天，最后游戏回复只自然说明未完成。纯文本最终响应没有 `tool_call`，所以普通聊天只发模型最终回复。

### 29.3 物理寻路和恢复层次

`LocalPathNavigator` 保持单段水平半径 24、垂直 6、最多 6000 节点。图节点先尝试站立碰撞盒，再尝试 1.5 格潜行盒；驾驶层对潜行 waypoint 持续按 Shift 并禁止冲刺。一格升高继续按 Jump；水节点支持水平和垂直；门/栅栏门只有带 `OPEN` 属性且可徒手操作时才临时视为通道，到达交互距离后点击并等待下一 Tick 重新验证碰撞。

`TraversalRecovery` 不参与正常 A*，只在规划失败计数达到 8 后处理正对目标的一格。破坏优先且必须同时满足天然性、可破坏、五格触及和六面无流体；搭桥只处理“前方身体清空、脚下可替换且无流体”的单格缺口，并再次扫描半径 3 的玩家构造/方块实体。桥材只允许 cobblestone、cobbled_deepslate、dirt、coarse_dirt、netherrack、end_stone，放置后服务端观察到同 ID 才登记。任何失败都返回 A* 继续等待/重规划，不允许连续盲挖或跨越未知结构。

持续跟随与普通 `navigate_to` 的生命周期不同：`setMovement` 对 follow 初次无路仍保留 movement；普通坐标导航初次无路仍快速失败并交回 Agent。跟随目标在加载范围内每 Tick 刷新位置；普通玩家短暂不可见时停在最后已知点等待，owner 额外读取定位栏分段目标。到达两格内只释放按键。明确 stop、其他互斥动作、死亡、换世界、桥断开会重置 A*、TraversalRecovery 和所有移动键。

### 29.4 工具选择与 Token 边界

`ToolSelector.ensureBestMiningTool` 的 false 不代表没有工具：可能表示已发出背包到快捷栏的 SWAP，调用者必须 return 并在下一 Tick 重试。高级矿道、探索开路、要塞下探和空气救援都遵守此契约；不得在 SWAP 同一 Tick 调用 `startDestroyBlock`。评分中正确掉落类别远高于速度，避免错误工具；近乎损坏但剩余耐久仍大于 0 的工具会优先继续用坏。没有 TOOL 组件时返回 true，让调用层按空手/当前物品继续，具体方块是否允许掉落仍由任务后置条件决定。

Token 收缩只删除重复和限长历史，不删除硬规则、当前玩家画像、人格或 JSON 参数校验。续轮仍通过 `compactContinuation` 保存最新合法工具协议和最多 16 条真实账本；实际供应商 usage 继续写诊断。未来如果再缩短，应先增加测试证明关键安全语义仍在，并用私有隔离探针比较真实 input tokens，禁止只按字符串长度宣称节省。

## 30. 2026-08-11：默认陪伴模式、零 Token 待机和低层连续动作交接

本节是当前行为真值，优先于前面带日期的自主生存历史快照。产品定位已由“无人时持续发育直到末地”调整为“玩家出现时陪伴、跟随和聊天的队友，空闲时本地自给自足”。采集、合成、建造、附魔、跨维度等自主工具没有从仓库删除，玩家明确任务仍会复用；`autonomy.mode` 与 `longTermGoal` 字段已删除，不再有 `survival`/`companion` 二分，空闲也不再以 `reach_end` 为目标。

### 30.1 配置和状态机

`AutonomyConfig` 新增：

- 不再有 `mode` 字段：统一为单一陪伴型自主玩家（保留全部自主能力，但不追求通关末地）。
- `autoInviteNearbyPlayers:true`、`inviteRadius:7`、`inviteCooldownMs:1800000`。
- `discardWornTools:true`、`wornToolRemainingDurability:1`。

定义、默认值和旧配置归一化位于 `src/config/types.ts`，边界校验位于 `src/config/load-config.ts`；WebUI 的读写映射在 `public/webui/app.js`。旧私有 `bot.json` 没有这些字段时会用默认值，不需要人工迁移才能启动。`config/bot.example.json` 同时把 `chat.proactiveEnabled` 改为 false。

`AgentController.#runProactiveTick` 在处理本地危险后先调用 `#maybeInvitePassingPlayer`。若不存在任务/持续动作，则进入 `#runUnifiedIdle`，不会构造 `ToolAgent`，因此空闲模型 API 调用为零。统一待机规则：已有 home 且不在区域内就执行一次 `return_home`；夜间/不安全时若有 home 则 `seek_shelter`、无 home 且材料足够则 `build_shelter`；随后用确定性 `planAutonomousDevelopment` 做一步自给自足（不再推进末地）；每五分钟清理一次近乎报废工具；最后执行一次 `wait_safe` 并设置 `#standbyEngaged`。玩家消息、受击/危险和新任务会清除待机标志。

路过邀请以“上个 Tick 不在半径、本 Tick 新进入”为触发，不会反复扫描同一个站在旁边的玩家。程序先启动 `follow_player`，再以固定自然句式询问并执行 `gesture:happy`，不调用模型。`#pendingCompanionInvite` 记录玩家和到期时间；接受/拒绝口语由本地正则识别，拒绝无需再次叫 Bot 名。拒绝会 `stop -> return_home`；接受保留持续跟随并执行两次蹲下。按玩家名维护冷却，玩家主动说话也会登记为已接触，避免 Bot 刚回复又发邀请。

Java `activeTaskType()` 现在区分 `follow_player`、`return_home` 与普通 `movement`。邀请只允许替换空闲状态，或已经回到 home 的 `return_home`；不会覆盖现有长期跟随。这一字符串也是 `WorldState.activePrimitive` 的真值，Node 不应再把所有移动都笼统当成可替换 `movement`。

### 30.2 持久任务、建房和采矿边界

玩家任务仍通过 `TaskStore` 持久化，控制器重启时恢复孤立 `running` 并继续 `queued`。持续物理技能在 Java 客户端内逐 Tick 运行，不应每个方块回到模型：

- `build_shelter` 已作为一个 Tool Agent 工具直接映射到同名 `AgentAction`，Fabric 的 `ShelterController` 完成固定 3×3 住所的全部放置和后置条件。系统提示明确要求先到目标区域，再只调用一次该技能，禁止多个 `place_block` 循环。
- `eat_safe_food` 映射到客户端 `eat_best_food`；它是完整消费动作，不是单次右键草稿。
- `discard_worn_tools` 是本地背包清理工具。

私有总聊天定位到旧建房延迟根因：一次任务在采集失败后尝试了非法快捷栏 10，随后连续六次模型调用 `place_block`；8 次 API 上限内约消耗 70,325 Token，却只放了少量方块。修复策略不是提高步数，而是把重复物理循环下沉到 Fabric 连续技能，并在首轮/续轮系统规则同时禁止逐块建房。`FOLLOWUP_SYSTEM` 必须继续保留该约束和严格 `<say>` 出口，避免上下文压缩后安全语义消失。

采矿提示已改为优先玩家带领到已知天然洞穴；禁止垂直直挖。当前世界感知只覆盖已加载邻域，没有跨地图洞穴索引，所以无法诚实实现“自动找到任意天然矿坑”。`excavate_safely` 仍是实验性阶梯后备而非默认策略。陪伴模式空闲不会采矿。后续如果实现 CaveLocator，应基于已加载区块的洞穴连通性、返回路径账本和真实进出后置条件，不可用模型臆测坐标。

### 30.3 耐久、基础陪伴动作和聊天出口

Java `ToolSelector`、`PrimitiveTaskController`、`SurvivalController` 不再排除剩余耐久 1–3 的工具/武器。剩余耐久大于 0 即可用，并给近乎报废工具较高选择分，让它优先被正常使用直至损坏；盔甲选择仍保留安全耐久门槛。`discard_worn_tools` 在 `MinecraftAiBridgeClient` 扫描普通背包槽，只丢 damageable 且带 TOOL/WEAPON 组件、无附魔、剩余耐久不高于阈值的物品；不丢盔甲、附魔物品或正常工具。Mineflayer 诊断适配器也只匹配镐/斧/铲/锄/剑名称。

`gesture` 为本地动作：`acknowledge` 两次蹲下，`happy` 两次跳跃，`afraid` 短时冲刺加跳跃。开工回调用 `onToolSelected` 与 acknowledge 并发；成功结果触发 happy；本地威胁可触发 afraid。完成后必须释放 Shift/Jump/Sprint，`stop` 也要清除所有移动键。动作名和回执只进入诊断。

最终游戏回复采用 `src/agent/game-reply.ts` 的双层边界。新模型合约要求最终文字只能出现在最后一个 `<say>...</say>` 内；存在标签时只抽取标签内容。无标签旧供应商走兼容清洗，过滤 JSON、代码块、工具/函数名、命名空间 ID、内部动词、`停止所有动作` 和执行回执。详细失败、模型文本和工具参数只写 `userdata/data/diagnostics.json`/WebUI 总聊天。不得为了“可观察”把内部日志重新发回 MC 聊天。

### 30.4 模组兼容的诚实结论

`scripts/sync-client-mods.mjs` 会验证 JAR/ZIP 文件头、复制未被排除的文件、计算 SHA-256，并在 `managed-mods.json` 为每项写 `compatibility` 提示。文件名可提示明显的 Forge/NeoForge、Quilt-only 或 server-only 风险；顶层 `compatibilityGuarantee` 固定为 `best_effort_copy_and_fabric_runtime_validation`。

这不是任意模组加载器，也不可能静态保证未来任意 mod：Minecraft/Fabric/Java 版本、客户端/服务端环境、前置依赖、Mixin 冲突、渲染和音频要求、登录握手都只能由 Fabric 实际启动验证。正确升级流程是更新私有 `userdata/config/mods.json.sourceDirectory` 指向的文件夹，重新同步，查看兼容提示，启动真实 26.2 客户端并检查 `latest.log`/是否进服。公共仓库不能记录真实来源路径或服务器必需模组清单。

### 30.5 WebUI 和验证快照

总控台保留暖白/橙色主题，新增多层半透明渐变、`backdrop-filter`、边缘高光、悬浮位移和背景流体动画，并为 `prefers-reduced-motion` 禁用动画。陪伴模式、邀请半径/冷却、近乎报废工具清理都可视化编辑；旧生存开关明确标为实验能力。模组页直接说明复制不等于兼容。

本次候选的自动验证：`npm run check` 通过；Node 测试 118/118 通过；`npm run build` 通过；Java 25 下 Fabric Gradle build 通过。浏览器回归确认桌面与 390×844 视口无水平溢出，新控件存在、默认 mode 为 companion、毛玻璃计算样式生效、控制台无 warning/error。新增测试覆盖 companion 空闲零 provider 调用、路过邀请拒绝回家、待机一次清理、严格 `<say>` 清洗、build/eat/discard 连续动作映射。

私有部署实服回归同步 23 个受管 mod 且无同步器警告，Headless Fabric 26.2 最终连接桥并通过 EasyAuth。第一次空闲观察暴露两个配置/状态问题：私有 `userdata/.env` 缺少 EasyAuth 密码；旧本机私密副本仍有该项，因此通过 WebUI secret API 只恢复缺失字段，没有输出值或覆盖其他秘密。其次，Fabric 明明上报 first-home radius/source，`FabricBridgeClient` 归一化却丢弃它们，Node 退回半径 2，导致边界附近每分钟重新发 `return_home`。现已在桥消息类型和归一化保留 `radius/source`，`insideHome` 加 0.75 格块中心容差，且 activePrimitive 已是 `return_home` 时不重复下发。重建后 Bot 从半径外返回第一个家，途中本地处理一次敌对威胁，随后 `activePrimitive` 清空并写入 `source=companion-local, tokenCost=0` 的零 Token 待机事件；该时段模型事件计数为 0。

随后实服出现真实路过玩家，诊断确认 `source=companion-local, tokenCost=0` 的陪伴邀请与 `follow_player` 已启动。玩家回复“就到这吧”时未命中旧拒绝正则，错误进入 Tool Agent，现场因此产生两轮模型调用后才停止。热修复把“就到这/到这就好/这样就好/够了”加入寻址和邀请拒绝语义，并将该实话替换进零 provider 调用测试；以后命中时本地执行 `stop -> return_home`。接受邀请、动作表情和物品交换仍以自动回归/编译证据为主，尚未在这次现场逐项验收。

同步到私有部署目录时，只复制源码、测试、模板和文档；绝不覆盖 `userdata/.env`、`userdata/config/bot.json` 中的真实连接/模型值、`userdata/config/persona.json`、`userdata/data/agent-prompts/SOUL.md`/`IDENTITY.md`、记忆、玩家画像、日志和 `.runtime` 业务状态。可用小脚本只向私有 bot.json 合并上述新字段并保持其他键值。公共提交前运行 `npm run audit`、`git diff --check`、`git ls-files` 敏感路径检查；公共文档只能使用 `你的域名.com`。

## 31. 2026-08-11：TTS 与 Simple Voice Chat 输出适配交接

### 31.1 已验证的上游约束

目标客户端 JAR 为 `voicechat-fabric-2.6.20+26.2`，其 `fabric.mod.json` 要求 Minecraft 26.2.x、Fabric Loader >=0.19.3、Java >=25，内嵌 API 版本 2.6.20。官方 API 要求音频为 48 kHz、16-bit PCM，发送节拍为每帧 960 samples/20 ms。官方服务端 `AudioSender` 只能模拟“没有安装语音模组”的玩家；Bot 本身已经安装该模组，所以注册必然失败，不能采用 server API 假发音。

本项目因此走客户端已鉴权路径。2.6.20 内部真实发送序列为 `MicThread.sendAudioPacket(short[960], whispering) -> OpusEncoder -> MicPacket -> NetworkMessage -> ClientVoicechatConnection.sendToServer`，停流包是空 Opus data 的 `MicPacket`。`VoicePlaybackManager` 优先反射调用同一个 `MicThread` 私有发送方法，并在播放期 `setMicrophoneLocked(true)`，避免物理麦克风和 TTS 的 sequence 交错；Headless 没有 MicThread 时，才创建 API Opus encoder 并反射构造 `MicPacket/NetworkMessage` 直接发送。任何类、方法、构造器或 UDP 鉴权状态不匹配都返回 `simple_voice_chat_unavailable`，不得影响文字聊天或其他动作。

不能把 `你的域名.com:25565` 占位符替换成真实域名后再提交到 Git；Minecraft 连接仍来自私有 `server.host/server.port`。Simple Voice Chat 的实际 UDP 主机、端口、secret 和加密连接由其服务端握手包建立。公网部署必须额外确认服务端实际语音 UDP 端口已开放；上游默认常见端口 24454 只是默认，不可硬编码为目标服事实。

### 31.2 Node TTS 层

唯一入口是 `src/speech/speech-service.ts`：

1. `FabricBridgeClient.chat()` 先发送已经过 `SecretGuard`/`game-reply` 边界的文字，成功后才调用 `SpeechService.enqueue()`。模型思考、tool call、动作结果和错误详情没有进入这个方法，不能被朗读。
2. 文本去除 Minecraft 格式码、URL、Markdown 控制字符并受 `maxTextChars` 限制。队列严格串行且不超过 `queueLimit`；满队列丢弃新语音但保留文字。
3. 缓存键包括 provider/protocol/model/voice/style/speed/text，缓存只在当前 Node 进程内，条数由 `cacheEntries` 限制，不写记忆文件和 Git。
4. 所有提供者归一化为单声道 little-endian PCM16；奇数字节被移除，时长受 `maxAudioSeconds` 限制，`volume` 本地饱和缩放。当前内置端点都按 `sampleRate=24000` 请求；若管理员改变供应商采样率，必须同步填写真实返回采样率。
5. 音频按 72 KiB 原始块经 Base64 发送，每块都有 session/sequence。Java 端只接受顺序块、预声明总字节一致、单会话不超过 6 MiB、队列不超过 3。桥仍逐行不超过 1 MiB，不需要共享绝对文件路径。

内置协议：

- `volcengine_v1`：POST 火山在线 TTS V1；Header `Authorization: Bearer;<access token>`；JSON 同时携带 AppID、cluster、voice_type、PCM encoding、sample_rate、唯一 reqid；只接受 code 3000 和 Base64 `data`。
- `openai_speech`：POST `${baseUrl}/audio/speech`，请求 `response_format:pcm`，支持 model/voice/instructions/speed，响应为原始 PCM。
- `mimo_chat_audio`：POST `${baseUrl}/chat/completions`，Header `api-key`；目标朗读文本必须放 assistant message，style 放 user message，音频 `format:pcm16`；读取 `choices[0].message.audio.data`。
- `openai_chat_audio`：适配能输出音频的多模态 Chat Completions 模型，发送 `modalities:[text,audio]` 与 `audio:{voice,format:pcm16}`，读取同一 message audio 路径。当前示例为 `gpt-audio-1.5`；普通 GPT-5.6 文本/视觉模型不应误选此协议。
- `custom_binary`：自定义端点直接返回 PCM16 binary；`custom_json_base64` 按 `customAudioJsonPath` 读取 Base64。请求体固定携带 model/input/voice/style/speed/format/sample_rate；鉴权 Header、scheme 和 key env 可配置，`apiKeyEnv` 留空时不发送鉴权 Header。自定义接口不允许把密钥字面值写进 bot.json。

中国网络默认推荐火山引擎或 MiMo；OpenAI 仅作为可选供应商，不得成为启动必需依赖。TTS 默认 `enabled:false`，旧配置无 `speech` 时由 `speechConfig()` 合并安全默认值。缺少任一语音密钥只会在第一条需要合成的回复上产生本地脱敏警告。

### 31.3 配置、WebUI 和秘密

类型/默认值在 `src/config/types.ts` 的 `SpeechConfig`/`DEFAULT_SPEECH_CONFIG`；校验在 `src/config/load-config.ts`；示例在 `config/bot.example.json`；完整字段索引在 `PARAMETERS.md`。WebUI `#speech` 面板读写同一个 `config.speech`，供应商切换只填公开预设，不回显秘密。

秘密键为 `VOLCENGINE_TTS_APP_ID`、`VOLCENGINE_TTS_ACCESS_TOKEN`、既有 `OPENAI_API_KEY`/`MIMO_API_KEY` 和 `CUSTOM_TTS_API_KEY`。`src/webui/server.ts` 的 `secretKeys` 控制 `userdata/.env` 原子写入与状态布尔值；`BotRuntime` 将当前 `speech.apiKeyEnv` 和 `volcengineAppIdEnv` 的值同时加入 Logger/SecretGuard 脱敏集合。禁止在诊断事件、错误消息、内存缓存键、WebUI snapshot、测试 fixture 或 README 中输出实际值。

### 31.4 Java 生命周期与失败模式

`MinecraftAiBridgeClient.processActions()` 在普通任务 busy 检查之前识别三种 voice action，因此正在持续跟随/建房时也能说话。上传完成时先检查 `ClientManager.getClient().getConnection().isInitialized()`，未完成 UDP 鉴权则拒绝入队。播放线程是 daemon platform thread，使用 `LockSupport.parkNanos` 按 20 ms 节拍发送。输入用线性插值重采样为 48 kHz并在最后一帧补零；每段结束发送停流包并释放 encoder/麦克风锁。

桥断开会 `voicePlayback.cancel("bridge_disconnected")`、清空上传和播放队列并中断线程。异步完成/失败通过 `voice_status` 回传 Node；Node 只记本地 debug/warn。未来升级 Simple Voice Chat 时必须重新用目标 JAR 的 `javap` 检查 `ClientManager`、`ClientVoicechat`、`MicThread.sendAudioPacket/sendStopPacket`、`MicPacket` 和 `NetworkMessage` 签名，再做真实多人听见验收；只有 Fabric build 成功不能证明内部运行签名没变。

`scripts/test-voice-bridge.mjs` 是零云端费用的现场诊断器。它要求 Node 控制器停止、Minecraft/Fabric 客户端保持在线，仅允许绑定回环 `bridgeHost`，发送 0.6 秒低音量 PCM 测试音，并等待 Java 返回 `voice_playback_completed`。它验证桥上传、重采样/分帧、Opus 与 SVC 客户端发送入口；它不验证另一名玩家的扬声器、距离衰减或服务端是否最终把包转发给听者。

### 31.5 本轮验证证据与未完成项

新增 `test/speech-service.test.ts` 覆盖 OpenAI 原始 PCM、火山 Bearer 分号/AppID/code 3000、MiMo 与多模态嵌套 Base64、无鉴权本机自定义 PCM、串行播放和重复缓存。完成代码时 `npm run check`、完整 Node 124/124 测试、Java 25 Fabric Gradle build 均通过。WebUI 已用真实浏览器验证：桌面 1280 宽和移动端 390×844 均无水平溢出；火山/OpenAI/MiMo/多模态/自定义预设联动中的 MiMo 样例已验证为 `mimo_chat_audio`、`mimo-v2.5-tts`、24 kHz 与“冰糖”；毛玻璃样式生效，语音密钥输入不回显，控制台无 warning/error，未保存或改写任何本机配置。

私有部署现场重新进服后，上游日志依次出现发送 secret 请求、收到 secret、语音服务端确认鉴权、确认连接检查。Headless 环境没有 OpenAL 扬声器和实体麦克风，上游因此打印对应警告，但 UDP 会话仍保持。停止 Node 控制器且保持 Fabric 客户端在线后运行 `npm run test:voice-bridge`，实际回传 `voice_playback_completed`，输入为 24 kHz、28,800 bytes 的 0.6 秒测试音；随后控制器和 WebUI 已恢复运行。该证据覆盖 Bot 端 PCM 上传、重采样、分帧、Opus 和已鉴权发送入口，不等价于另一名玩家已实际听见。

没有用户提供火山 TTS AppID/Access Token、OpenAI/MiMo 音频配额或自定义接口，因此本轮不能花费/猜测凭据做云端真实合成。真实服务器上还必须由另一名安装 Simple Voice Chat 的玩家站在 Bot 听距内，确认文字出现后能听到 Bot 的语音、距离衰减正确、离开范围听不到、连续两句顺序正确、TTS 失败不阻塞跟随。完成前只能声称“协议、编译和 mock 链路已验证”，不能声称服务器内实际听见已验收。Simple Voice Chat 收音/语音识别仍未实现，本轮只解决声音生成与输出。

## 32. 2026-08-12：全栈审计、竞态修复与长期运行收敛

### 32.1 Fabric 桥状态机

`FabricBridgeClient` 的传输边界现在明确分成 `listening -> tcp_connected -> authenticated -> ended`。只有正确的首个 `hello` 同时满足一次性桥令牌与 `protocolVersion=1` 后，`state/chat/action_result/voice_status` 才能进入业务层；握手前注入任何业务消息会拒绝连接。令牌或协议错误通过统一的 `#rejectHandshake` 同步拒绝 `connect()`，不会等满 `connectTimeoutMs`。断线原因会先存入实例，即使 socket 在 `waitForEnd()` 注册前已经关闭也能立即返回；主动 `close(reason)` 同时拒绝未完成连接、唤醒结束等待并清理动作 Promise。`MinecraftClient` 也缓存先到达的结束原因，消除“连接刚结束、上层稍后才等待”的竞态。

安全意义：桥仍只监听 `127.0.0.1`，一次性令牌由私有运行目录生成；协议状态机防止同机其他进程抢在真实客户端前伪造世界、聊天或动作完成。升级协议时必须同步修改两端版本、消息 schema 和握手测试，不能为了兼容直接跳过认证。

### 32.2 游戏连续任务

外部动作必须按“已接单”和“物理后置条件已收敛”分开建模。`follow_player`、`attack_hostile`、`return_home` 等返回成功表示 Java 状态机已接管，不表示目标已在同一 Tick 达成。远处敌对生物锁定 Bot/主人时，Node 下发 `attack_hostile`；Java `DefendTask` 持续寻路、选择武器和近战，直到目标消失、死亡、更换目标或 Bot 低血量，避免旧逻辑每 15 秒原地执行一次超出攻击距离的 `attack_entity`。跟随仍由本地持续任务维护，不依赖模型逐步驱动。

`LocalPathNavigator` 移除了每 80 Tick 无条件重算并丢弃有效路线的逻辑。回家任务保留路线进度；400 Tick 无进展进入本地恢复，1,200 Tick 仍失败则返回 `home_route_stalled_safe_wait` 并停止，Node 在当前位置安全时不会立刻重新排同一回家任务，不安全时才允许重试。副手 `use_held_item` 归一化为 `use_item`，Java 对 `OFF_HAND` 执行真实使用。WebUI/游戏内明确停止语句由本地高优先级路径取消任务与持续动作，零模型调用；普通“停止”与“解除跟随”分别生成符合当前状态的自然回复。

### 32.3 状态落盘与日志边界

Fabric 可以每秒上报数百个 `nearbyBlocks`、完整槽位和玩家凝视坐标，这些数据必须留在 `AgentController` 当前内存观察中。`RuntimeStatusStore.compactRuntimeWorld()` 只落盘连接、位置、生命/饥饿/空气、维度、最多 16 名附近玩家的身份与距离、最多 8 个威胁、环境/家/活动原语/导航摘要；`inventory=[]`，不包含 `nearbyBlocks` 或 `lookingAtBlock`。写入最快每秒一次，内容无实质变化时每 30 秒心跳；指纹排除 `sequence/observedAt`。若原子写入失败，会清空节流状态，下一次报告可以立刻重试。该文件只服务 WebUI 健康检查，不可作为记忆、背包或世界观察备份。

Logger 的敏感键规则继续覆盖 password/secret/token/apiKey/authorization，但显式放行 `tokens/inputTokens/outputTokens/totalTokens/reasoningTokens/cachedInputTokens/cumulativeTokens/maxTaskTokens/maxOutputTokens` 等纯计量字段，使总聊天可以审计调用成本。`accessToken/session_token` 等认证字段仍被隐藏。WebUI JWT 识别要求 `eyJ` 起始的三段结构，不再把 Java 包名/类名误当 JWT；Java 堆栈因此可用于真实诊断。Headless Java 子进程会从继承环境中删除所有模型/TTS Key，只有 EasyAuth 密码按连接职责保留。

### 32.4 配置与供应商兼容

WebUI 保存密钥使用 `mergeManagedEnv()`：仅替换受管键，保留注释、未知变量、原顺序、UTF-8 BOM 与 CRLF/LF；空输入不会意外删除既有密钥。OpenAI 音频输入模型走 Chat Completions，发送纯 Base64 `input_audio.data` 与显式 `format`；普通文本/视觉模型继续走 Responses。当前显式音频模型示例为 `gpt-audio-1.5`，能力表只为真正支持音频输入的模型开启 audio。TTS 的 `openai_chat_audio` 是音频输出协议，与普通 GPT 文本模型不可互换。

依赖锁定通过根级 npm `overrides` 把传递依赖 `uuid` 收敛到已修复版本；`npm run audit:dependencies` 显式使用 npm 官方审计端点，避免用户全局镜像不支持审计 API 导致误判。Fabric 构建启用 deprecation lint，已移除当前代码可控的废弃调用；构建仍必须使用项目要求的 Java 25。

### 32.5 实服证据和交接顺序

本轮私有部署现场确认：Bot 从旧的回家循环位置移动到首个家半径内；被 Pillager 击杀后自动点击重生并重新进入世界；管理员自然聊天只产生回复、不调用游戏动作；“停止当前任务，站在原地等待”立即执行且日志中没有模型轮次；Simple Voice Chat 完成鉴权，停 Node、保留 Fabric 在线后运行测试桥实际返回 `voice_playback_completed`（24 kHz、28,800 bytes）。这些证据不等价于穷举所有 Minecraft 动作，也不等价于另一名玩家已从扬声器听到测试音。

新 Agent 接手时按以下顺序操作：先读本文件、`README.md`、`PARAMETERS.md` 和 `git status/log`；区分公共仓库与私有部署目录；先跑 Node 全量测试/类型检查/构建/依赖审计和 Java clean build；再同步源码/JAR到私有目录，但绝不覆盖 `userdata/.env`、真实 `userdata/config/bot.json`/`mods.json`、人设提示词、记忆、玩家画像、日志和 `.runtime`；最后重启实际控制器并检查 WebUI、`runtime-status.json` 大小和 Fabric 日志。公开提交前运行 `npm run audit -- --history`、敏感字符串/真实域名扫描、`git diff --check`、`git fsck --full`。公共文件只保留 `你的域名.com` 与示例密钥，私有部署继续保留用户真实值。

仍需人工完成的外部验收：另一名玩家实际听见 TTS；中国大陆无 VPN 的纯净 Windows 下载/安装/调用各供应商；未来每个新增 mod 的真实客户端启动/进服；复杂地狱/水域/跨维度长时间跟随与全部物品交换组合。不得把这些边界写成已完成。
