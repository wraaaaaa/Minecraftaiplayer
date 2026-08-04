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
| `actionTimeoutMs` | `10000` | 单个游戏动作等待结果的最长时间。 |

LAN 使用流程：人类玩家进入单人世界并选择“对局域网开放”，Bot 配置 `connectionMode:"lan"`、`auth:"offline"`，再启动。程序监听 `224.0.2.60:4445` 的广播并采用其中的动态端口。VPN、多网卡和 Windows 防火墙可能阻断广播；可先在 WebUI 点“扫描局域网世界”验证。

## 3. EasyAuth

文件：`config/bot.json`，字段：`easyAuth`。

- `enabled:true`：识别登录/注册提示并发送命令。
- `registerIfNeeded:true`：新 Bot 名称收到注册提示时允许 `/register`。这会在服务器创建账号；正式测试前应确认密码。
- `passwordEnv:"MINECRAFT_LOGIN_PASSWORD"`：只从 `.env`/进程环境读取，不交给模型。
- `loginDelayMs:1500`：看到提示后延迟发送，避免插件尚未准备好。

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
- `proactiveInstruction`：空闲时单独使用的指令。

行为准则另存 `config/behavior-rules.json`，它是模型输出之后的程序级硬限制，不应只依赖提示词。

## 6. 记忆、经验与自动写入机制

- 统一记忆文件：`data/memory.json`；结构示例：`config/memory.example.json`。
- 经验文件：`data/experience.json`；结构示例：`config/experience.example.json`。
- 路径和最大事件数：`config/bot.json` 的 `storage.memoryFile`、`storage.experienceFile`、`storage.maxEvents`。
- 自动备份：同目录的 `memory.json.bak`、`experience.json.bak`。

这不是 OpenClaw 的多层记忆目录，而是适合迁移的单一记忆 JSON：`players` 按 UUID/名称隔离每个人，`events` 保存玩家消息、Bot 回复、游戏事件和长期事实，`globalSummary` 保存全局摘要。程序在发生事件或模型返回合规的 `remember` 时立即原子写入，并先生成 `.bak`；当前不会定时让模型重写摘要，也不会静默删除玩家档案。经验文件在动作失败时自动新增 `lesson` 与 `correction`，相似任务会检索它以避免重复错误。

WebUI 可查看玩家档案、最近事件、经验摘要，并直接导出两个完整文件。迁移到新机器/新 Agent 时，保留整个 `data` 文件夹，至少保留上述两个 JSON。

## 7. 皮肤、披风与多人可见条件

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

## 8. 模组、日志、运行状态与快捷入口

- 服务器模组来源：`config/mods.json` 的 `sourceDirectory`。
- 启动自动同步：`syncOnClientStart`；排除正则：`excludeFilePatterns[]`。
- 受管理模组清单：`.runtime/minecraft/managed-mods.json`（含文件名、大小、SHA-256）。
- Bot 日志：`logs/bot.log`；日志参数：`config/bot.json` 的 `logging`。
- Minecraft 日志：`.runtime/minecraft/logs/latest.log`。
- 实时状态：`data/runtime-status.json`。
- 进程记录：`data/bot.pid.json`、`data/minecraft-client.pid.json`。
- 一键部署并打开：`Install-and-Open-Control-Center.cmd`。
- 只打开 WebUI：`Open-WebUI.cmd`。
- 静默启动/停止 Bot：`Start-Bot.cmd`、`Stop-Bot.cmd`。

## 9. Git 与 AI 接续信息

- 人类部署/使用/原理：`README.md`。
- 给后续 Agent 的完整状态、决策、测试和 Git 操作：`README_AI.md`。
- 参数位置总表：本文件 `PARAMETERS.md`。
- 远端：`https://github.com/wraaaaaa/Minecraftaiplayer.git`，分支 `main`。

任何功能、参数、迁移方式、测试结果或推送步骤发生变化时，必须同步更新三份文档中受影响的部分。推送前运行测试、无效字符扫描、敏感信息扫描，并确认 `.env`、`data`、`logs`、`.runtime` 仍被忽略。
