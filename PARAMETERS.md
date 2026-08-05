# 项目参数与本地存储位置总表

本文专门回答“某个参数存在哪里、改什么值、产生什么效果”。路径都相对于项目根目录。推荐双击 `Open-WebUI.cmd` 修改；直接编辑 JSON 时必须保持合法 JSON，改完后重启 Bot。

## 1. API Key 与登录密码

实际秘密只保存在根目录 `.env`（已被 `.gitignore` 排除，不会推送）：

```dotenv
MINECRAFT_LOGIN_PASSWORD=EasyAuth登录密码
DEEPSEEK_API_KEY=DeepSeek密钥
ARK_API_KEY=火山方舟密钥
OPENAI_API_KEY=OpenAI密钥
```

`config/bot.json` 的 `model.apiKeyEnv` 决定当前模型读取上述哪个变量；`easyAuth.passwordEnv` 决定 EasyAuth 读取哪个变量。WebUI 只返回“已配置/未配置”，不会把密钥内容发回浏览器。页面里的“清空本机全部密钥”会清空四项；结束测试后还应确认 `.env` 不存在或全部为空。已经在聊天中发送过的 Key 无法由本项目删除，应到供应商控制台撤销并换新。

`data/bridge-token.txt` 是每次启动控制器时自动生成的本机桥会话令牌，Java 客户端必须持有相同令牌才会被 Node 接受。它不需要手工填写，位于被 Git 忽略的 `data` 目录；模型密钥只留在 Node 进程，启动 Java 前会显式从 Java 子进程环境中移除。

## 2. 服务器、局域网兼容与 Bot 身份

文件：`config/bot.json`，字段：`server`。

| 字段 | 示例/可选值 | 效果 |
| --- | --- | --- |
| `adapter` | `fabric_bridge` / `mineflayer` | 26.2 模组服和局域网世界用 `fabric_bridge`；后者仅作协议诊断。 |
| `connectionMode` | `direct` / `lan` | `direct` 连接固定地址；`lan` 自动监听 Minecraft 局域网广播。 |
| `host` / `port` | `你的域名.com` / `25565` | 固定服务器地址；LAN 扫描结果也会在页面显示到这里。 |
| `lanDiscoveryTimeoutMs` | `8000` | LAN 模式等待广播的毫秒数，可设 250-60000。 |
| `version` | `26.2` | Minecraft 协议/客户端版本。 |
| `username` | `CialloAI` | 离线 Bot 游戏名，必须匹配 `^[A-Za-z0-9_]{3,16}$`；EasyAuth 不接受连字符、空格或中文，皮肤文件名必须与它一致。 |
| `auth` | `offline` / `microsoft` | 当前原生无界面启动已实现 `offline`；LAN 模式强制离线。Microsoft 自动登录仍未实现。 |
| `connectTimeoutMs` | `30000` | 等待连接超时。 |
| `reconnectDelayMs` | `10000` | 断线后再次连接的等待。 |
| `autoRespawn` | `true` | 死亡后由原生 Fabric 客户端自动向服务器请求复活。 |
| `respawnDelayMs` | `3000` | 死亡后等待多久再复活，范围 0-60000；请求失败时每 5 秒重试。 |
| `bridgeHost` / `bridgePort` | `127.0.0.1` / `8765` | AI 控制器与 Fabric 客户端的本机桥；地址必须保持回环地址。 |
| `actionTimeoutMs` | `10000` | 普通动作等待结果的基础时限；采集/合成/装备至少允许 120 秒，住所动作至少允许 180 秒。长动作超时会先向 Java 发送 `stop`，防止任务文件报失败后客户端仍继续修改世界。 |

LAN 使用流程：人类玩家进入单人世界并选择“对局域网开放”，Bot 配置 `connectionMode:"lan"`、`auth:"offline"`，再启动。程序监听 `224.0.2.60:4445` 的广播并采用其中的动态端口。VPN、多网卡和 Windows 防火墙可能阻断广播；可先在 WebUI 点“扫描局域网世界”验证。

## 3. EasyAuth

文件：`config/bot.json`，字段：`easyAuth`。

- `enabled:true`：识别登录/注册提示并发送命令。
- `registerIfNeeded:true`：新 Bot 名称收到注册提示时允许 `/register`。这会在服务器创建账号；正式测试前应确认密码。
- `passwordEnv:"MINECRAFT_LOGIN_PASSWORD"`：只从 `.env`/进程环境读取，不交给模型。
- `loginDelayMs:1500`：Mineflayer 诊断适配器的提示后等待；Fabric 正式客户端优先在看到 `/login`/`/register` 提示时立即发送，未看到提示时进服约 5 秒后回退尝试登录。

普通单人 LAN 世界没有 EasyAuth，保持启用也不会在未看到提示时泄露密码；建议 LAN 配置中关闭它。

## 4. 模型、端点与推理强度

文件：`config/bot.json`，字段：`model`。

- DeepSeek：`provider:"deepseek"`、`baseUrl:"https://api.deepseek.com"`、`apiKeyEnv:"DEEPSEEK_API_KEY"`。
- 火山方舟/豆包 Seed 2.1 Pro：`provider:"volcengine"`，`model` 填方舟端点/模型 ID，`apiKeyEnv:"ARK_API_KEY"`，`baseUrl` 填方舟提供的 OpenAI 兼容地址。
- OpenAI：`provider:"openai"`、`apiKeyEnv:"OPENAI_API_KEY"`，使用 Responses API。旗舰模型填 `gpt-5.6-sol`，也可用会路由到 Sol 的 `gpt-5.6` 别名；`gpt-5.6-terra` 是平衡档，`gpt-5.6-luna` 面向高吞吐。以账号实际权限和 [OpenAI 官方 GPT-5.6 指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6) 为准。

`reasoningEffort` 可设：`none`、`low`、`medium`、`high`、`xhigh`、`max`。从左到右通常更慢、更贵。供应商不支持某个粒度时适配器会映射到其可用档位；实际请求档位写入日志。

- `timeoutMs`：单次 API 请求超时，默认 `120000` 毫秒，允许 `1000-600000`。
- `maxOutputTokens`：单次模型最大生成预算，默认 `4096`，允许 `128-131072`。DeepSeek/豆包映射为 `max_tokens`，OpenAI Responses 映射为 `max_output_tokens`。游戏决策不应盲目调大，否则会增加延迟和费用。

## 5. 人设与完整提示词

- 实际人设：`config/persona.json`；完整示例：`config/persona.example.json`。
- 实际提示词：`config/prompts.json`；完整示例：`config/prompts.example.json`。
- `config/bot.json` 中 `personaFile`、`promptsFile` 指向实际文件。

人设字段：`name`、`description`、`speakingStyle`、`goals[]`、`boundaries[]`。提示词字段：

- `identity`：角色模板，支持 `{{name}}`、`{{description}}`、`{{speakingStyle}}`、`{{goals}}`、`{{boundaries}}`。
- `capabilityRules[]`：结构化状态、不得假装、动作能力和安全边界。
- `memoryRules[]`：分玩家记忆、长期事实筛选、隐私和经验复用。
- `actionContract`：强制模型只返回指定 JSON 和白名单动作。
- `proactiveInstruction`：安全空闲时单独使用的指令；示例要求最多选择一个实际可执行的自主发展动作，条件不足返回 `none`，不得提前声称完成。

### 聊天、语境与空闲模型决策

这些字段位于 `config/bot.json` 的 `chat`：

| 字段 | 默认值 | 效果 |
| --- | --- | --- |
| `requireMention` | `true` | 没有足够近距离/连续对话语境时要求显式 Bot 名或 `!`；不是“每句话都必须点名”。 |
| `replyPrefix` | 空 | 每条任务回复前缀。 |
| `cooldownMs` | `2500` | 游戏聊天最小间隔。 |
| `proactiveEnabled` | `true` | 启用限频的空闲模型决策与偶尔聊天；关闭它不会关闭本地进食、防卫、安全挂机或持久任务恢复。 |
| `proactiveIdleMs` | `180000` | 最后一次玩家消息后至少等待多久才调用一次空闲决策。 |
| `proactiveMinIntervalMs` | `300000` | 两次空闲决策的最小间隔；同时控制主动聊天频率和模型 API 消耗。 |

游戏聊天出口固定为“玩家交互通道”：自然陪聊、接受/完成确认和一句简短拒绝。程序会拦截 JSON、代码块、动作内部名、`minecraft:` 命名空间 ID、工具/函数调用术语和接口参数；任务失败统一提示到 WebUI 查看，不把步骤号或底层错误广播给服务器玩家。完整诊断自动写入 `data/diagnostics.json`，WebUI“总聊天”每 4 秒独立刷新，筛选控件不会把设置页标成“未保存”。

空闲决策只允许 `none`、`wait_safe`、进食/装备/确认威胁战斗、收取自有掉落、批准区采集、2×2/工作台 3×3 合成、安全白名单方块放置、使用物品、住所和准备类动作；程序硬性拒绝空闲时跟随、接近、注视或攻击玩家。每轮只执行一个主动作，采集前自动 `prepare_for:mining`，成功破坏后自动串联 `collect_own_drops`。玩家任务到达会用 `stop` 抢占空闲动作；失败会写入 `experience.json`。本地开局规则能串起木板、工作台、木棍、工作台放置和木镐，但它不是任意目标的自动通关规划器。

行为准则另存 `config/behavior-rules.json`，它是模型输出之后的程序级硬限制，不应只依赖提示词。

## 6. 记忆、经验与自动写入机制

- 统一记忆文件：`data/memory.json`；结构示例：`config/memory.example.json`。
- 经验文件：`data/experience.json`；结构示例：`config/experience.example.json`。
- 路径和最大事件数：`config/bot.json` 的 `storage.memoryFile`、`storage.experienceFile`、`storage.maxEvents`。
- 自动备份：同目录的 `memory.json.bak`、`experience.json.bak`。

这不是 OpenClaw 的多层记忆目录，而是适合迁移的单一记忆 JSON：`players` 按 UUID/名称隔离每个人，`events` 保存玩家消息、Bot 回复、游戏事件和长期事实，`globalSummary` 保存全局摘要。程序在发生事件或模型返回合规的 `remember` 时立即原子写入，并先生成 `.bak`；当前不会定时让模型重写摘要，也不会静默删除玩家档案。经验文件在动作失败时自动新增 `lesson` 与 `correction`，相似任务会检索它以避免重复错误。

WebUI 可查看玩家档案、最近事件、经验摘要，并直接导出两个完整文件。迁移到新机器/新 Agent 时，保留整个 `data` 文件夹，至少保留上述两个 JSON。

## 7. 持久任务、自主生存与安全开发区

实际配置：`config/bot.json` 的 `autonomy` 与 `storage.taskFile` / `storage.autonomyFile` / `storage.progressionFile` / `storage.ownedBlocksFile`。运行数据：

- `data/tasks.json`：全部排队、执行中、完成、失败/拒绝的任务，含发令玩家、紧急度、顺序、尝试次数、时间和真实结果；控制器重连会恢复孤立的 `running`，进入世界后自动继续 `queued`。
- `data/diagnostics.json`：WebUI“总聊天”的本机诊断时间线，含结构化计划、动作参数、能力/策略结果、真实后置条件和完整脱敏错误；固定最多 1000 条，原子写入并保留 `diagnostics.json.bak`。它不是模型隐藏思维链，也不参与长期记忆提示。
- `data/autonomy-state.json`：Java 客户端确认建成住所后原子写入维度、室内位置、门位置和更新时间。
- `data/progression.json`：长期目标固定为 `reach_end`；保存已经进入的最高阶段、最近一步、原因、服务端结果、各动作里程碑和按资源隔离的失败计数。临时进食或补做工作台不会把最高阶段倒退。
- `data/owned-blocks.json`：Fabric 按维度、整数坐标和方块 ID 保存 Bot 实际放置的工作台、熔炉、床、附魔台、住所/传送门构件和开路垫脚块。使用前会与当前服务端方块核对；玩家设施不能仅凭“附近存在”被当作自己的。
- 上述文件都位于 `data`，应与记忆/经验一起备份。迁移前先停止旧 Bot 和客户端，复制 `tasks.json`、`autonomy-state.json`、`progression.json`、`owned-blocks.json`，并确认新配置四个 `storage.*File` 指向复制后的文件。不要迁移桥令牌、PID 或 `runtime-status.json`。
- `tasks.json`、`progression.json` 由 Node 原子写入并保留 `.bak`；`autonomy-state.json` 和 `owned-blocks.json` 由 Java 使用临时文件原子替换。Java 文件应另做外部备份。

| `autonomy` 字段 | 默认值 | 位置与效果 |
| --- | --- | --- |
| `enabled` | `true` | 主动进食/防卫、寻找住所和安全挂机的总开关；不会关闭玩家明确命令，也不会关闭启动时的任务恢复。 |
| `ownerName` | `wraaaaaa` | 离线服最高优先玩家名；其任务始终先于其他玩家。EasyAuth 必须保护该名称，避免冒用。 |
| `commandArbitrationMs` | `350` | 同时收集多人消息的短窗口；窗口后普通玩家按当前距离从近到远选人，同一玩家内部按紧急度再按先入先出。 |
| `contextualAddressing` | `true` | 结合命令语气、最近对话和距离判断是否在叫 Bot；近距离自然交流不要求每次点名。显式 `!` 或 Bot 名始终视为点名。 |
| `directAddressDistance` | `8` | 无点名直接交流的近距离范围，1–64 格。 |
| `conversationWindowMs` | `60000` | 同一玩家延续近距离对话的窗口，1 秒–10 分钟。 |
| `lowHealthThreshold` | `10` | 达到或低于时本地生存层优先找安全食物。 |
| `criticalHealthThreshold` | `6` | 达到或低于时不主动发起普通战斗；必须不高于低生命阈值。 |
| `eatBelowFood` | `20` | 饱食度低于此值就自主进食；默认意味着只要不是满格便吃安全食物。 |
| `hostileScanRadius` | `12` | 确认实际威胁的敌对生物扫描半径。苦力怕、末影人、猪灵等高风险/中立目标不会被盲目自动攻击。 |
| `wildernessMinPlayerDistance` | `48` | 采集/建房与其他客户端玩家的最小距离；Node 先检查，Java 在动作开始及建房过程中继续硬检查。 |
| `safeIdleEnabled` | `true` | 无任务时先验证安全；夜间/危险位置寻找已记录住所、床或安全点，安全后停止移动等待。 |
| `autoGather` / `autoCraft` / `autoBuildShelter` | `true` | 分别允许模型规划采集、合成和住所；不是绕过开发区或行为规则的授权。 |
| `autoHunt` / `autoSmelt` / `autoMine` | `true` | 允许确定性长期规划狩猎、烹饪/冶炼和阶梯矿道；每个 Java 动作仍单独检查生命、空气、危险流体、归属和后置条件。 |
| `autoTrade` / `autoEnchant` | `true` | 允许在已加载村民/自有附魔台满足费用时交易和附魔；不会打开玩家容器或无限刷新村民职业。 |
| `autoDimensionTravel` / `autoSleep` | `true` | 允许建门/使用已加载传送门、末影之眼搜索及夜间在自有床睡觉设置重生点。 |
| `protectOwner` | `true` | 怪物把 `ownerName` 设为攻击目标时保护主人；紧跟其他玩家期间也临时保护当前跟随目标。 |
| `allowVerifiedWilderness` | `false` | 开发区关闭时，是否允许 Java 通过自然地形扫描、玩家距离和逐块检查授权荒野采集/建造；公开示例保持关闭，使用者应明确开启。 |
| `longTermGoal` | `reach_end` | 当前唯一长期目标：从生存物资逐步推进到下界、要塞和末地；不能填其他字符串。 |
| `developmentZone` | 默认关闭 | 管理员批准的维度及 AABB 坐标。采集和建造只有在 `enabled:true` 且每个目标位于区域内时才执行。单边最大 256 格、高度最大 128 格。 |

危险任务还有本地强制准备：消息涉及末地/末影龙时，即使模型只选择跟随，也先执行 `prepare_for:end_combat`；四件护甲、武器、耐久和至少 16 个安全食物必须达到“附魔黄金套装等效”门槛，否则详细拒绝。挖矿和战斗任务分别先选择当前最好的工具/装备。明确且独立的“停止/停下/取消当前任务/stop/cancel”不调用模型，会立即取消当前 Java 长动作并把任务终态写入 `tasks.json`。

任务排序的准确含义是：全局同时只运行一项；`ownerName` 的全部排队任务先于其他玩家；普通玩家先按当前距离选择发令人，再在该玩家内部按紧急度、先入先出排序。独立停止命令取消的是当前全局任务，不只限于停止命令发令者自己的任务。

开发区坐标是包含边界的 AABB，维度必须与当前世界一致。`enabled:false` 时采集和建造一律拒绝；开启后，Java 仍会逐块检查目标、方块实体、碰撞和区域边界。`wildernessMinPlayerDistance` 针对其他客户端玩家，默认 48 格；Node 在开始前检查，采集/建房控制器在执行中继续检查，玩家中途进入半径会安全取消。WebUI 保存后必须重启 Bot 才会把这些配置传给 Java 客户端。

### 动作能力与住所前置条件

- 移动/交流：`look_at_player`、`follow_player`、`come_to_player`、`wander`、聊天与 `stop`；内部还有 `return_to_zone`、`explore_frontier`。`LocalPathNavigator` 在已加载区做有界 A*，支持平走、一步升降、水节点、半砖/雪层碰撞面、危险方块拒绝和分段重规划；探索无路时只允许破坏天然障碍。主人可借服务器定位栏跨全图分段寻找。它仍不支持任意门/梯子/跑酷。
- 生存/战斗：`eat_best_food`、`equip_best`、`prepare_for`、`attack_hostile`、`hunt_entity` 和短时自卫 `attack_player`。食物使用 26.2 数据组件识别；空气低于 75% 时暂停任务，搜索可呼吸水面，必要时破坏可验证的天然冰/雪顶。狩猎拒绝幼体、驯服、拴绳和自定义名称实体。
- 物品/生产：`use_item`、`gather_resource`/`break_block`、`collect_own_drops`、`craft_item`、`place_block`、`drop_item`、`smelt_item`、`trade_villager`、`enchant_item`、`sleep_in_bed`、`excavate_tunnel`、`build_nether_portal`、`travel_to_dimension`。合成走真实 2×2/3×3 菜单；熔炼、交易和附魔走对应容器并以背包增量/附魔状态确认。玩家/未知归属容器始终不支持。

`place_block.itemId` 可省略以自动选择安全材料，`count` 范围 1–16；当前 Java 白名单包括泥土类、基础石材、木板、羊毛、原木/木头和工作台。所有候选位置必须在 `developmentZone` 内，并通过已加载、可替换、稳定支撑、碰撞、方块实体及服务端 `mayUseItemAt` 检查。`craft_item.itemId` 是目标物品 ID，`count` 是目标新增数量；3×3 的工作台搜索半径为 8 格，工作台本身也必须在同一批准区内。
- 安全/住所：`seek_shelter`、`build_shelter`、`wait_safe`。长期规划会准备材料、建固定住所、取得三份同色羊毛、制作并登记床；夜间 `sleep_in_bed` 以 `player.isSleeping()` 确认睡觉和重生点设置。

固定住所外壳为 3×3、三格高，使用现有 3×3 稳定地面。背包必须预先具备：一个 `DoorBlock` 且可手动开关、一支普通 `minecraft:torch`、至少 23 个同一种安全实心满方块，并保持普通背包界面和空鼠标游标。整个施工目标必须在批准开发区内；候选空间需可替换、无方块实体和占位实体，门位不得受红石供电，8 格内不得有敌对威胁，其他玩家必须在 `wildernessMinPlayerDistance` 之外。门、火把和外壳全部走正常多人放置，并在服务端同步状态稳定后才计为完成；住所最终还要验证外壳、门关闭、内部光照和安全落脚点，成功后才写 `autonomy-state.json`。材料不足、移动卡住、保护插件拒绝、玩家靠近、断线或持久化失败都会明确返回失败。

### 密钥与迁移注意

`.env`、`data`、`logs` 和 `.runtime` 均被 Git 忽略，但“被忽略”不等于可以公开。不要把 API Key、EasyAuth 密码、桥令牌、服务器地址或本地配置发进游戏聊天、模型提示、Issue、提交记录或截图。秘密提取请求在调用模型前会被本地拒绝；已知秘密及常见密钥形状还会在模型输入、记忆、经验、日志和游戏聊天出口脱敏。模型密钥只留在 Node 进程，启动 Minecraft Java 子进程前会被移除。

换机器时，`.env` 必须经安全渠道重新建立，Git 不会搬运它；已经公开过的 Key 应在供应商控制台撤销并换新。`bridge-token.txt` 是每次控制器启动生成的本机会话令牌，不是长期配置，也不要迁移。至少迁移 `memory.json`、`experience.json`、`tasks.json`、`autonomy-state.json`、`progression.json` 和 `owned-blocks.json`；它们用途不同，不应互相覆盖或在程序运行时手工合并。

## 8. 皮肤、披风与多人可见条件

- 配置：`config/skin.json`；示例：`config/skin.example.json`。
- 导入后的皮肤：`data/skins/<Bot游戏名>.png`。
- Bot 客户端本地副本：`.runtime/minecraft/CustomSkinLoader/LocalSkin/skins/<Bot游戏名>.png`。
- 万用皮肤加载器：`vendor/custom-skin-loader/CustomSkinLoader_Universal-15.0.1.jar`，安装时复制到 Bot 实例 `mods`。
- 给其他玩家的包：`.runtime/skin-pack/Minecraft-AI-Skin-Pack.zip`。

WebUI 只接受标准 `64x64` 现代皮肤或 `64x32` 旧版 PNG；`model` 为 `classic`（4 像素手臂）或 `slim`（3 像素手臂）。`visibilityMode`：

- `client_pack`：每个需要看到 Bot 皮肤的玩家都安装生成的包，真实可用但更新皮肤后要重新分发。
- `online_provider`：把皮肤上传到所有玩家共同使用的 CustomSkinLoader 兼容站点，并让站点角色名与 Bot 名一致；更适合长期多人服务器。
- `microsoft`：正版账号皮肤/披风路径，当前自动登录未实现。

万用皮肤加载器官方明确说明 LocalSkin 只在安装该本地文件的客户端上可见，所以只给 Bot 安装 Mod 不能让别人看见。披风文件位置已预留为 `skin.capeFile` 和 `data/capes`；官方正版披风不能由普通 PNG 伪造，多人离线披风同样需要共同皮肤站或分发客户端文件。

## 9. 模组、日志、运行状态与快捷入口

- 服务器模组来源：`config/mods.json` 的 `sourceDirectory`。
- 启动自动同步：`syncOnClientStart`；排除正则：`excludeFilePatterns[]`。
- 受管理模组清单：`.runtime/minecraft/managed-mods.json`（含文件名、大小、SHA-256）。
- Bot 日志：`logs/bot.log`；日志参数：`config/bot.json` 的 `logging`。
- Minecraft 日志：`.runtime/minecraft/logs/latest.log`。
- 实时状态：`data/runtime-status.json`。
- 持久任务：`data/tasks.json`；住所：`data/autonomy-state.json`；末地发育检查点：`data/progression.json`；自有方块：`data/owned-blocks.json`；总聊天诊断：`data/diagnostics.json`；桥会话令牌：`data/bridge-token.txt`。
- 进程记录：`data/bot.pid.json`、`data/minecraft-client.pid.json`。
- 一键部署并打开：`Install-and-Open-Control-Center.cmd`。
- 只打开 WebUI：`Open-WebUI.cmd`。
- 静默启动/停止 Bot：`Start-Bot.cmd`、`Stop-Bot.cmd`。

## 10. Git 与 AI 接续信息

- 人类部署/使用/原理：`README.md`。
- 给后续 Agent 的完整状态、决策、测试和 Git 操作：`README_AI.md`。
- 参数位置总表：本文件 `PARAMETERS.md`。
- 远端：`https://github.com/wraaaaaa/Minecraftaiplayer.git`，分支 `main`。

任何功能、参数、迁移方式、测试结果或推送步骤发生变化时，必须同步更新三份文档中受影响的部分。推送前运行测试、无效字符扫描、敏感信息扫描，并确认 `.env`、`data`、`logs`、`.runtime` 仍被忽略。

## 11. 2026-08-05 新状态与动作参数

| 名称 | 存储/来源 | 含义 |
| --- | --- | --- |
| `world.blockSurvey` | 运行时 `data/runtime-status.json`，由 Fabric 自动生成，不手工配置 | 半径 8、上下 5 格的附近方块摘要；含资源、人造启发式、最近坐标和保护分类，5 秒缓存。 |
| `inventory[].placeableBlockId` | 同上 | 该背包物品若是 `BlockItem`，对应可放置方块 ID；用于放置能力预检。 |
| `place_block.itemId` | 动作参数，可省略 | 指定普通实心方块物品；省略时 Fabric 从安全白名单材料中选择。 |
| `place_block.count` | 动作参数，默认 1 | 单次 1–16 个，每个都必须在批准区并由服务器确认。 |
| `gather_resource.authorizedPlayer` | Node 内部临时字段，不写配置、不允许模型指定 | 仅对明确玩家命令豁免该发令人自身的荒野距离；其他玩家和主动采集不豁免。 |
| `nearbyPlayers[].lookingAtBlock` | 运行时 `data/runtime-status.json`，Fabric 服务器侧射线检测 | 玩家眼睛前方 6 格内实际指向的方块 ID、坐标和距离；“挖掉这个方块”只使用此值。 |
| `actions[]` | 单次模型 JSON，可省略 | 最多 12 个 `AgentAction`，按数组顺序逐步执行；不是持久化任务 DAG。 |
| `drop_item.itemId/count/target` | 动作参数 | Bot 走到明确指定的附近玩家，使用正常背包 `THROW` 操作，并以自身背包数量减少作为完成条件。 |
| `world.activePrimitive` | 运行时状态 | `movement` 表示异步路线仍在进行；主动心跳在它完成前不会执行 `wait_safe` 清掉按键。 |
| 主动发展间隔 | 由 `chat.proactiveMinIntervalMs` 派生 | 确定性自发展实际限制在 15–60 秒；不调用模型。主动聊天仍遵循完整配置间隔。 |

`developmentZone` 现在同时约束 `gather_resource`、`place_block`、`build_shelter`、自主 `wander` 和内部 `return_to_zone`。Bot 被跟随任务带出区域后，空闲循环先返回区域再发展。玩家命令的采集可以由发令玩家近距离监督，但其他玩家仍会阻止采集；建房仍不豁免任何附近玩家。WebUI 保存坐标后必须完整重启 Minecraft 客户端，因为 AABB 通过启动环境变量传给 Java。

本机真实 `config/bot.json` 可填写授权测试区，但文件被 Git 忽略，文档与公开仓库不记录实际坐标。公开的 `config/bot.example.json` 必须保持 `developmentZone.enabled:false` 和零坐标，使用者按自己的可丢弃场地填写。
