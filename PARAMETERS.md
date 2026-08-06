# 项目参数与本地存储位置总表

本文专门回答“某个参数存在哪里、改什么值、产生什么效果”。路径都相对于项目根目录。推荐双击 `Open-WebUI.cmd` 修改；直接编辑 JSON 时必须保持合法 JSON，改完后重启 Bot。

## 1. API Key 与登录密码

实际秘密只保存在根目录 `.env`（已被 `.gitignore` 排除，不会推送）：

```dotenv
MINECRAFT_LOGIN_PASSWORD=EasyAuth登录密码
DEEPSEEK_API_KEY=DeepSeek密钥
ARK_API_KEY=火山方舟密钥
OPENAI_API_KEY=OpenAI密钥
MIMO_API_KEY=小米MiMo密钥
```

`config/bot.json` 的 `model.apiKeyEnv` 决定当前模型读取上述哪个变量；`easyAuth.passwordEnv` 决定 EasyAuth 读取哪个变量。WebUI 只返回“已配置/未配置”，不会把密钥内容发回浏览器。页面里的“清空本机全部密钥”会清空五项；结束测试后还应确认 `.env` 不存在或全部为空。已经在聊天中发送过的 Key 无法由本项目删除，应到供应商控制台撤销并换新。

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
- 小米 MiMo：`provider:"mimo"`、`model:"mimo-v2.5"`（或 `mimo-v2.5-pro`）、`apiKeyEnv:"MIMO_API_KEY"`、`baseUrl:"https://api.xiaomimimo.com/v1"`。使用官方 OpenAI 兼容 Chat Completions；模型列表可通过 `/models` 核对。

`reasoningEffort` 可设：`none`、`low`、`medium`、`high`、`xhigh`、`max`。从左到右通常更慢、更贵。供应商不支持某个粒度时适配器会映射到其可用档位；实际请求档位写入日志。

- `timeoutMs`：单次 API 请求超时，默认 `120000` 毫秒，允许 `1000-600000`。
- `maxOutputTokens`：普通聊天、上下文压缩等单次最大生成预算，默认 `4096`，允许 `128-131072`。DeepSeek/豆包映射为 `max_tokens`，MiMo 映射为 `max_completion_tokens`，OpenAI Responses 映射为 `max_output_tokens`。
- `agentMaxSteps`：一个玩家任务最多接受的模型工具调用，默认 `12`，允许 `1-128`。连续技能内部可执行许多方块/移动 Tick，但不再次调用模型。
- `autonomousAgentMaxSteps`：一次空闲自主发展最多工具步骤，默认 `8`，允许 `1-64`。玩家新消息会抢占并停止空闲循环。
- `agentMaxApiCalls`：每玩家任务模型 API 次数硬上限，默认 `8`，允许 `1-32`。观察调用同样占 API 次数。
- `agentMaxTaskTokens`：任务累计输入+输出硬上限，默认 `160000`，允许 `10000-2000000`。供应商返回 `usage` 时使用实际值；未返回时使用保守估算。发送下一轮前会把估算输入和完整 `agentMaxOutputTokens` 一起预留，预计可能越界时不发送。
- `agentMaxInputTokensPerCall`：单次请求发送前估算上限，默认 `48000`，允许 `4000-1000000`。中文按接近一字一 Token 估算，避免沿用 ASCII 的四字符估值而低估。
- `agentMaxOutputTokens`：Agent 单轮工具决策输出，默认 `1024`，允许 `128-16384`。
- `agentFollowupReasoningEffort`：第一次规划仍使用 `reasoningEffort`；工具成功后的续轮默认 `none`，可改成所有受支持强度。失败、新威胁等仍可由模型结合真实结果重规划，但不再为每个重复动作开启长思考。

DeepSeek、豆包和 MiMo 使用 Chat Completions `tools`；OpenAI 使用 Responses API function calling。DeepSeek 开启思考后，适配器会保留最新一轮助手消息中的 `reasoning_content` 与 `tool_calls`，再追加当前工具结果，否则供应商会拒绝续轮。更早工具轮不会无限叠加，而会变成最多 16 条紧凑执行账本；第二轮起还会把首轮完整 system/user 压成不可省略的续轮硬规则与原始玩家目标，只保留限长回执、位置、生命/饥饿、背包增量、维度和活动状态。视觉/音频只在首轮发送。供应商出现空工具响应时只允许一次 `none` 推理强度重试，失败轮按保守输入估算加完整 `agentMaxOutputTokens` 计入预算。隐藏推理不写入诊断或游戏聊天。OpenAI 后续轮使用 `previous_response_id` 与 `function_call_output` 保持状态。

### 多模态参数

`model.multimodal` 包含：`autoDetect`、`visionEnabled`、`audioEnabled`、`onlineResearchEnabled` 和 `sensoryDirectory`。默认全部开启并使用 `data/sensory`，但只有检测到模型具备对应能力才真正发送。DeepSeek 固定为纯文本；MiMo 2.5/2.5 Pro 自动识别为视觉、音频、视频理解和攻略搜索模型。未知模型可把 `autoDetect:false` 后用三个开关人工声明，修改后必须用 WebUI 最小测试确认。

- 视觉：优先读取 15 秒内、最大 1.5 MiB 的 `data/sensory/latest.png`；没有时由 `WorldState` 生成 128×128 PNG 语义俯视图。只在 Agent 首轮发送一次。
- 语音：读取 `data/sensory/latest-audio.json`，格式为 `{"capturedAt":"ISO时间","mimeType":"audio/wav","dataBase64":"..."}`；只接受 15 秒内、最大 2 MiB 的 wav/mpeg/mp3/ogg/webm/flac。Simple Voice Chat 当前尚无生产帧写入桥，所以默认显示 `unavailable`，不会伪造听觉。
- 攻略搜索：只有模型能力与开关同时为真时向 Agent 暴露 `search_game_guide`；实际使用 `agentWorkspace.selfImprovement.researchProvider` 的百度/SearXNG，查询会脱敏、结果限长并在当前任务缓存。

## 5. 人设、OpenClaw 风格提示词与自我改进

- 兼容人设：`config/persona.json`；示例：`config/persona.example.json`。其中 `name`、`description`、`speakingStyle`、`goals[]`、`boundaries[]` 会替换 Markdown 中的同名占位符。
- 运行时全局提示词：`data/agent-prompts/rules.md`、`IDENTITY.md`、`SOUL.md`、`TOOLS.md`、`MEMORY.md`。
- 每位玩家画像：`data/player-profiles/<uuid-or-name>/USER.md`；首次对话自动创建并按 UUID 优先隔离。
- 声明式经验补丁：`data/agent-prompts/behavior-patches.json`。
- 首次启动模板：`config/agent-prompts.example/`；`config/prompts.json` 只作旧版兼容。

五份文件在每次模型决策前读取，因此可用 WebUI 保存，也可直接编辑本地 Markdown，无需为纯提示词修改重启：

- `rules.md`：解释硬规则与权限边界，优先级最高；真正不可绕过的限制仍在策略、SecretGuard 和 Fabric。
- `IDENTITY.md`：Bot 名称、类型、职责和输出基线；默认普通回复 2–4 句、约 45–140 个中文字符，已写可修改示例。
- `SOUL.md`：核心人设、价值观、语气和判断风格；这是主要人设文件，示例采用更柔软、依恋、会轻微撒娇的猫娘表达，同时明确柔弱不等于无能、不得情绪绑架。
- `TOOLS.md`：Agent 循环、原子接口、连续技能、多模态感知、后置条件和失败处理；运行时 JSON Schema 才是参数真值。包含仅允许程序写入的 `AI_LEARNED` 托管段。
- `MEMORY.md`：记忆召回、分玩家隔离、摘要、压缩和过期规则；不存放秘密。
- `USER.md`：当前玩家的兴趣、表达方式、协作偏好、稳定事实，以及该玩家独有的 Bot 称呼；模型和寻址器都只加载正在对话玩家对应的一份。

玩家专属称呼没有第二份 JSON 参数，唯一位置就是对应 `USER.md`：

```markdown
## 该玩家对 AI 的称呼

- 粉粉
- 小不点
```

一行一个项目符号，最多读取 32 个、每个清洗后最长 24 字符；保存 WebUI 玩家画像或直接改文件均会在下一条消息生效，无需重启。玩家用当前有效称呼明确说“以后我就叫你粉粉”时也会原子追加。此列表只影响当前 UUID/名称画像，不会改变 `config/persona.json.name`、Minecraft 游戏名或其他玩家的叫法。

### 修改人设与名称

| 目标 | 修改位置 | 生效方式 |
| --- | --- | --- |
| 修改性格、语气、价值观 | WebUI 的 `SOUL.md`，或 `data/agent-prompts/SOUL.md` | 下一次模型决策热读取 |
| 修改身份摘要 | WebUI 的 `IDENTITY.md`，或 `data/agent-prompts/IDENTITY.md` | 下一次模型决策热读取 |
| 修改 AI 对外角色名 | WebUI“兼容角色名”或 `config/persona.json.name`，并同步替换上述两份 Markdown 中的旧角色称呼 | 保存后重启 Bot；`{{name}}` 会替换为此值 |
| 修改 Minecraft 头顶/玩家列表名称 | WebUI“Bot 游戏名”或 `config/bot.json.server.username` | 必须重启；只允许 3–16 位字母、数字、下划线 |

“兼容角色名”和“Bot 游戏名”可以不同。前者用于 AI 自称、点名识别和记忆标签；后者是离线登录身份。修改登录名可能触发新 EasyAuth 注册、离线 UUID 变化以及皮肤文件/皮肤站角色名迁移。`config/agent-prompts.example/` 是新安装模板，不是当前运行源。

配置位于 `config/bot.json` 的 `agentWorkspace`：

| 字段 | 默认值 | 效果 |
| --- | --- | --- |
| `promptDirectory` | `data/agent-prompts` | 五份全局 Markdown 与行为补丁目录；必须位于项目 `data`。 |
| `playerProfilesDirectory` | `data/player-profiles` | 分玩家 `USER.md` 根目录；必须与提示词目录不同。 |
| `contextBudgetChars` | `48000` | 上下文字符预算估值，允许 8000–500000。 |
| `compressionTriggerRatio` | `0.72` | 估算达到预算的此比例时压缩旧事件，允许 0.5–0.95。 |
| `retainRecentEvents` | `16` | 压缩后保留当前玩家最近事件，允许 4–64。 |
| `selfImprovement.enabled` | `true` | 启用重复失败聚合与受限学习。 |
| `allowPromptEdits` | `true` | 允许程序追加 `TOOLS.md` 托管经验段；不会改 rules/identity/soul。 |
| `allowBehaviorPatches` | `true` | 允许写声明式策略提示，不能执行 JS、Java、PowerShell 或系统命令。 |
| `minimumRepeatedFailures` | `3` | 同一规范化错误触发研究/学习前的次数，允许 2–10。 |
| `researchProvider` | `baidu` | `baidu`、`searxng` 或 `disabled`；中国环境默认百度。 |
| `researchEndpoint` | `https://www.baidu.com/s` | 百度搜索端点，或自建 SearXNG `/search`；远端必须 HTTPS，局域网/localhost 的 SearXNG 可 HTTP。 |
| `researchTimeoutMs` | `10000` | 检索超时，允许 1000–60000。 |

网页结果始终作为不可信参考文本，先脱敏、限长，再由模型总结。程序不会下载网页代码，不会执行搜索结果，也不会写可执行源码、启动脚本、硬规则或秘密。WebUI/本地人工仍可编辑全部五份提示词。

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

游戏聊天出口固定为“玩家交互通道”：自然陪聊、接受/完成确认和自然拒绝。默认人设要求普通回复 2–4 句，先回应具体内容，再加入感受、关心或轻微撒娇；紧急战斗警告和极简单确认可以更短。程序会拦截 JSON、代码块、动作内部名、`minecraft:` 命名空间 ID、工具/函数调用术语和接口参数；任务失败只概括说明并引导到 WebUI，不把步骤号或底层错误广播给服务器玩家。完整诊断自动写入 `data/diagnostics.json`，WebUI“总聊天”每 4 秒独立刷新，筛选控件不会把设置页标成“未保存”。

WebUI“总聊天”底部的文本栏调用本机 `POST /api/admin/command`，其消息是全项目最高任务优先级。每条命令独立存入 `data/admin-inbox/<时间前缀-UUID>.pending.json`；控制器领取后依次变为 `processing` 和 `done/error`。如果 Bot 没运行，文件会保留，下一次客户端连接后再处理。这里的“最高权限”是任务队列优先级，不会绕过 Fabric 财产保护、SecretGuard、游戏服务器权限或安全后置条件。明确“停止/原地等我”会建立进程内 hold；它没有单独 JSON 参数，也不跨控制器重启持久化。下一条定向消息，或受击、低血、严重饥饿、着火、水下低氧会解除。

空闲发展与玩家任务都使用分层工具循环：模型每轮只选择一个原子接口或连续技能；技能内部由 Fabric 快速执行多 Tick 动作，完成/失败后才把增量观察交回模型。玩家任务的第一个工具选择会先触发一次本地自然开工回应，不增加 API 调用；纯聊天不会触发。`follow_player_continuously` 映射为长期 `follow_player` 客户端状态，只需调用一次，第一次无路或普通玩家短暂离开实体加载范围不会清除它；空闲发展也不会在后续心跳覆盖。停止、冲突任务、紧急安全动作、死亡或断线可以结束；跨维度和真正离线时只能在最后已知位置等待，不能承诺物理意义上的永不丢失。空闲目标固定为安全生存、持续发展并最终到达末地；程序硬性拒绝侵害玩家财产，玩家任务会抢占。旧版一次性 JSON 规划器只作不支持 `toolTurn` 的兼容路径，DeepSeek、豆包、MiMo 和 OpenAI 默认不会进入。

Tool Agent 上下文限量不是 WebUI 可调参数：事实 12 条、玩家摘要 1500 字、事件 6×240 字、全局摘要 1200 字、经验 4 条；首轮/后续世界附近方块 16/6，实体各最多 8。工具模式首轮不重复发送 `TOOLS.md` 的接口目录，但仍发送规则、身份、SOUL、MEMORY、当前 USER、安全/研究内容、AI 学习段和运行时 JSON Schema；续轮 system/user 压缩常量也在 `src/agent/tool-agent.ts`。若未来需要改这些常量，位置是 `src/agent/prompt.ts`、`src/agent/tool-agent.ts` 与 `src/prompts/prompt-workspace.ts`，改后必须重新测真实供应商 usage。

注意 `server.connectTimeoutMs` 同时限制 Node 等待 Fabric 桥握手；安装 100 个以上模组的首次冷启动可能超过 30 秒。若 WebUI 显示客户端最终已启动但控制器先报等待超时，可在“服务器与客户端”适当提高该值后重启；这只延长启动等待，不改变游戏内动作超时。

行为准则另存 `config/behavior-rules.json`，它是模型输出之后的程序级硬限制，不应只依赖提示词。

## 6. 记忆、经验与自动写入机制

- 统一记忆文件：`data/memory.json`；结构示例：`config/memory.example.json`。
- 经验文件：`data/experience.json`；结构示例：`config/experience.example.json`。
- 路径和最大事件数：`config/bot.json` 的 `storage.memoryFile`、`storage.experienceFile`、`storage.maxEvents`。
- 自动备份：同目录的 `memory.json.bak`、`experience.json.bak`。

`memory.json` 仍是便于灾难恢复的统一原始记忆：`players` 按 UUID/名称隔离，`events` 保存消息、回复、游戏事件和长期事实，`globalSummary` 保存全局摘要。事件和合规 `remember` 立即原子写入并先生成 `.bak`。

当真实记忆提示估算接近 `contextBudgetChars × compressionTriggerRatio`，`ContextCompressor` 使用当前模型总结较旧事件，更新 `conversationSummary`、`globalSummary` 和对应 `USER.md`，再按事件 ID 原子移除已压缩内容。世界快照不计入记忆压力；压缩在玩家任务离开关键路径后延迟执行，格式错误只写警告，绝不再让当前游戏任务失败。最近 `retainRecentEvents` 条不删除；模型失败或触发 SecretGuard 时原事件不丢失。

## 7. 持久任务、自主生存与动态环境安全

实际配置：`config/bot.json` 的 `autonomy` 与 `storage.taskFile` / `storage.autonomyFile` / `storage.progressionFile` / `storage.ownedBlocksFile`。运行数据：

- `data/tasks.json`：全部排队、执行中、完成、失败/拒绝的任务，含发令玩家、紧急度、顺序、尝试次数、时间和真实结果；控制器重连会恢复孤立的 `running`，进入世界后自动继续 `queued`。
- `data/admin-inbox/`：WebUI 最高优先级管理指令的跨进程收件箱；一条一文件，状态后缀为 `pending/processing/done/error`。它是本机运行数据，不能提交 Git。
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
| `autoGather` / `autoCraft` / `autoBuildShelter` | `true` | 分别允许规划采集、合成和住所；不是绕过 Fabric 硬检查或行为规则的授权。 |
| `autoHunt` / `autoSmelt` / `autoMine` | `true` | 允许确定性长期规划狩猎、烹饪/冶炼和阶梯矿道；每个 Java 动作仍单独检查生命、空气、危险流体、归属和后置条件。 |
| `autoTrade` / `autoEnchant` | `true` | 允许在已加载村民/自有附魔台满足费用时交易和附魔；不会打开玩家容器或无限刷新村民职业。 |
| `autoDimensionTravel` / `autoSleep` | `true` | 允许建门/使用已加载传送门、末影之眼搜索及夜间在自有床睡觉设置重生点。 |
| `protectOwner` | `true` | 怪物把 `ownerName` 设为攻击目标时保护主人；紧跟其他玩家期间也临时保护当前跟随目标。 |
| `allowVerifiedWilderness` | `true` | 是否允许 Java 通过自然地形、玩家结构、玩家距离、方块实体、危险源和逐目标后置条件授权采集/放置/开矿/建造；关闭时直接拒绝世界修改。 |
| `allowTeleportCommand` | `false` | 只有服务器管理员已经给 Bot `/tp`/`/teleport` 权限后才改为 `true`。启动脚本把它映射为 `MCAI_TP_COMMAND_ENABLED`；只允许把 Bot 自己传到一个普通玩家名，坐标、选择器和其他命令全部拒绝。 |
| `longTermGoal` | `reach_end` | 当前唯一长期目标：从生存物资逐步推进到下界、要塞和末地；不能填其他字符串。 |
| `firstHome.enabled` | `true` | 是否启用固定第一个家/安全位置。它只表示回家目的区域，不代表已建房。 |
| `firstHome.dimension` | `minecraft:overworld` | 固定第一个家所在维度；可选主世界、下界、末地完整 ID。 |
| `firstHome.x/y/z` | `1226 / 65 / 199` | 固定第一个家的中心坐标，可在 WebUI“自主生存与任务”修改。 |
| `firstHome.radius` | `10` | 到中心此水平半径内即认为已回到安全区域，范围 1–64。`return_home` 优先当前维度已登记避难所，没有才选这里。 |
| `developmentZone` | 已废弃 | 仅为读取旧 `bot.json` 保留；`autonomyConfig()` 会删除并忽略它，WebUI 不显示，启动脚本不再传坐标。 |

危险任务还有本地强制准备：消息涉及末地/末影龙时，即使模型只选择跟随，也先执行 `prepare_for:end_combat`；四件护甲、武器、耐久和至少 16 个安全食物必须达到“附魔黄金套装等效”门槛，否则详细拒绝。挖矿和战斗任务分别先选择当前最好的工具/装备。明确且独立的“停止/停下/取消当前任务/stop/cancel”不调用模型，会立即取消当前 Java 长动作并把任务终态写入 `tasks.json`。

任务排序的准确含义是：全局同时只运行一项；WebUI 管理指令最先，其次是 `ownerName` 的全部排队任务，再次是普通玩家。普通玩家先按当前距离选择发令人，再在该玩家内部按紧急度、先入先出排序。独立停止命令取消的是当前全局任务，不只限于停止命令发令者自己的任务。

AI 不再依赖人工坐标框判断可挖、可采或可放置。Node 只验证能力开关并把意图交给 Fabric；Java 在当前已加载环境中为单次动作建立短生命周期工作窗口，对每个真实候选做不可绕过的检查。`wildernessMinPlayerDistance` 针对其他客户端玩家，默认 48 格；采集/建房执行中持续检查，玩家中途进入半径会安全取消。短生命周期窗口不是管理员配置，也不会持久化或授权人造结构。

### 动作能力与住所前置条件

- 移动/交流：`look_at_player`、`follow_player`、`come_to_player`、`return_home`、`wander`、`explore_frontier`、聊天与 `stop`；废弃的 `return_to_zone` 会明确拒绝。`LocalPathNavigator` 在已加载区做有界 A*，支持平走、一格跳跃、游泳态跳上岸、1.5 格潜行通道、水中水平/上下移动、半砖/雪层碰撞面、木门/栅栏门，以及为铁门寻找附近按钮/拉杆。通过门后会在仍可交互时尽量关闭/复位。持续 8 次无路后 `TraversalRecovery` 按目标、左右和后方尝试，只可破坏逐块验证的天然障碍，或在动态安全检查通过的缺口/水下支撑面铺一块自有普通材料并登记到 `owned-blocks.json`。持续跟随在目标从附近传送门消失时会进入所见门体并跨维度保留状态；没有观察到门时不会猜测。梯子、藤蔓、复杂红石门、复杂跑酷和未知模组碰撞仍可能失败。
- 生存/战斗：`eat_best_food`、`equip_best`、`prepare_for`、`attack_hostile`、`hunt_entity` 和短时自卫 `attack_player`。食物使用 26.2 数据组件识别；空气低于 75% 时暂停任务，搜索可呼吸水面，必要时破坏可验证的天然冰/雪顶。狩猎拒绝幼体、驯服、拴绳和自定义名称实体。
- 物品/生产：`use_item`、`gather_resource`/`break_block`、`collect_own_drops`、`craft_item`、`place_block`、`drop_item`、`accept_items`、`smelt_item`、`trade_villager`、`enchant_item`、`sleep_in_bed`、`excavate_tunnel`、`build_nether_portal`、`travel_to_dimension`。`drop_item` 是 Bot 给玩家；`accept_items` 是拾取明确玩家身边近期匹配掉落物并验证背包增加。合成走真实 2×2/3×3 菜单；熔炼、交易和附魔走对应容器并以背包增量/附魔状态确认。采掘工具由 `ToolSelector` 扫描整个背包，正确掉落类别优先于纯速度，剩余耐久不超过 3 的工具排除；背包换入快捷栏后等待下一 Tick 才开挖。玩家/未知归属容器始终不支持。

`place_block.itemId` 可省略以自动选择安全材料，`count` 范围 1–16；当前 Java 白名单包括泥土类、基础石材、木板、羊毛、原木/木头和基础设施方块。每个候选位置必须通过玩家结构扫描、已加载、可替换、稳定支撑、碰撞、方块实体、危险源、撤退路线及服务端 `mayUseItemAt` 检查。`craft_item.itemId` 是目标物品 ID，`count` 是目标新增数量；3×3 工作台搜索半径为 8 格，且必须在 `owned-blocks.json` 中登记并与服务端现状一致。
- 安全/住所：`seek_shelter`、`build_shelter`、`wait_safe`。长期规划会准备材料、建固定住所、取得三份同色羊毛、制作并登记床；夜间 `sleep_in_bed` 以 `player.isSleeping()` 确认睡觉和重生点设置。

固定住所外壳为 3×3、三格高，使用现有 3×3 稳定地面。背包必须预先具备：一个可手动开关的 `DoorBlock`、一支普通 `minecraft:torch`、至少 23 个同一种安全实心满方块，并保持普通背包界面和空鼠标游标。候选空间需逐格确认不是玩家结构、可替换、无方块实体和占位实体，门位不得受红石供电，8 格内不得有敌对威胁，其他玩家必须在 `wildernessMinPlayerDistance` 之外。住所最终还要验证外壳、门关闭、内部光照和安全落脚点，成功后才写 `autonomy-state.json`。

### 密钥与迁移注意

`.env`、`data`、`logs` 和 `.runtime` 均被 Git 忽略，但“被忽略”不等于可以公开。不要把 API Key、EasyAuth 密码、桥令牌、服务器地址或本地配置发进游戏聊天、模型提示、Issue、提交记录或截图。秘密提取请求在调用模型前会被本地拒绝；已知秘密及常见密钥形状还会在模型输入、记忆、经验、日志和游戏聊天出口脱敏。模型密钥只留在 Node 进程，启动 Minecraft Java 子进程前会被移除。

换机器时，`.env` 必须经安全渠道重新建立，Git 不会搬运它；已经公开过的 Key 应在供应商控制台撤销并换新。`bridge-token.txt` 是每次启动生成的本机会话令牌，不要迁移。至少迁移 `memory.json`、`experience.json`、`tasks.json`、`autonomy-state.json`、`progression.json`、`owned-blocks.json`、`agent-prompts/`、`player-profiles/` 和 `self-improvement.json`；它们用途不同，不应互相覆盖或在程序运行时手工合并。

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
| `place_block.count` | 动作参数，默认 1 | 单次 1–16 个，每个都必须通过 Fabric 逐目标检查并由服务器确认。 |
| `gather_resource.authorizedPlayer` | Node 内部临时字段，不写配置、不允许模型指定 | 仅对明确玩家命令豁免该发令人自身的荒野距离；其他玩家和主动采集不豁免。 |
| `nearbyPlayers[].lookingAtBlock` | 运行时 `data/runtime-status.json`，Fabric 服务器侧射线检测 | 玩家眼睛前方 6 格内实际指向的方块 ID、坐标和距离；“挖掉这个方块”只使用此值。 |
| `actions[]` | 单次模型 JSON，可省略 | 最多 12 个 `AgentAction`，按数组顺序逐步执行；不是持久化任务 DAG。 |
| `drop_item.itemId/count/target` | 动作参数 | Bot 走到明确指定的附近玩家，使用正常背包 `THROW` 操作，并以自身背包数量减少作为完成条件。 |
| `world.activePrimitive` | 运行时状态 | `movement` 表示异步路线仍在进行；主动心跳在它完成前不会执行 `wait_safe` 清掉按键。 |
| 主动发展间隔 | 由 `chat.proactiveMinIntervalMs` 派生 | 确定性自发展实际限制在 15–60 秒；不调用模型。主动聊天仍遵循完整配置间隔。 |

`developmentZone` 已彻底退出运行链：旧 JSON 仍可解析以避免升级时报错，但配置归一化会删除它，启动脚本不再生成 `MCAI_DEVELOPMENT_ZONE_*`，Java 启动时清空遗留坐标，WebUI 不显示也不保存该段。玩家命令的采集可由该发令人近距离监督；其他玩家仍会阻止采集，建房不豁免任何附近玩家。

是否可修改世界由两层共同决定：AI 根据 `world.blockSurvey`、任务、资源和风险选择意图；Fabric 逐目标验证并拥有最终否决权。文字提示词、网页研究和声明式补丁都不能设置 `verifiedWilderness`、伪造 ownership 或绕过服务器后置条件。
