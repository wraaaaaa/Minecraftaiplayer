# Minecraft AI Player

让大模型以真正的 Minecraft 客户端玩家身份进入 Java Edition `26.2` Fabric 模组服务器，在后台接收聊天指令、区分玩家、保存记忆，并执行受行为准则约束的游戏动作。

当前是可运行的第一阶段版本：原生 Fabric 无界面客户端、AI 控制器、本机图形总控台、三种模型 API、记忆与经验文件、EasyAuth、安全规则、服务器模组同步和静默后台运行均已实现。2026-08-04 已使用用户提供的 24 个“进服必须 mod”真实进入 `ciallo.kim` 世界，客户端完成注册表、地图、配方、语音通道握手和初始物品同步；测试没有注入 EasyAuth 密码、发送聊天或执行动作，并已正常结束全部进程。

## 当前能力

已实现：

- Minecraft `26.2`、Fabric Loader `0.19.3`、Fabric API `0.156.0+26.2` 原生客户端桥。
- Windows 无界面启动，控制器与游戏客户端均隐藏在后台；提供安全启动、停止和 PID 记录。
- 本机 Web 总控台：可视化编辑所有 Bot 参数、人设、规则、模组路径和秘密，并查看运行进程、世界坐标、生命、饱食度、维度、附近玩家及日志。
- DeepSeek、火山方舟（豆包）OpenAI 兼容接口、OpenAI Responses API；模型名、端点与推理强度均可配置。
- 通过结构化世界状态和动作接口控制游戏，不依赖屏幕、图像、声音或鼠标模拟，适合 DeepSeek 等纯文本模型。
- 玩家聊天、系统消息、位置、生命、饱食度、维度、时间、背包和附近玩家状态。
- 按玩家 UUID 保存独立档案和事件的单一 `memory.json`；经验另存为 `experience.json`；两者原子写入并保留 `.bak`。
- 自定义人设、回复限频、被提及时回复、空闲主动聊天。
- EasyAuth 根据服务器提示自动执行 `/login`，首次使用新名称时可选自动 `/register`；密码只从环境变量读取且日志脱敏。
- `聊天、停止、看向玩家、跟随、走向玩家、有限半径闲逛、受击后一次自卫反击`动作。
- 独立行为准则：禁止破坏玩家物品、禁止打开玩家容器、未知归属时拒绝破坏、仅允许短时针对实际攻击者自卫。
- Mineflayer 兼容探针与固定来源的 26.2 协议数据，供诊断使用；目标模组服默认使用原生 Fabric 适配器。
- 中国大陆下载路线：npm 镜像、BMCLAPI/CERNET Minecraft 资源镜像、GitHub 下载镜像回退，并对游戏资源或工具执行官方 SHA-1/SHA-256 校验。
- 受管理的服务器模组同步：记录来源、文件名和 SHA-256；未来更新来源文件夹后可从总控台一键替换，不会误删项目自己的桥或 Fabric API。
- 纯净 Windows 一键部署入口，可安装 Node.js LTS、Java 25 并完成全套构建、资源准备和总控台启动。

尚未实现：完整寻路、挖掘、采集、制作、建筑、自主生存闭环、Microsoft 正版登录自动化、皮肤/披风管理、Simple Voice Chat 语音适配。当前移动是轻量键位控制，不能绕开复杂障碍。

## 运行结构

```text
玩家聊天/世界事件
        ↓
Minecraft 26.2 + Fabric 桥（无界面）
        ↕ 仅本机 127.0.0.1:8765，JSON Lines
Node.js AI 控制器
        ├─ 模型适配器（DeepSeek / 豆包 / OpenAI）
        ├─ 人设、多人记忆、经验
        └─ 行为规则审查 → 结构化游戏动作
```

Fabric 桥只监听/连接本机回环地址，不向局域网或公网开放控制端口。大模型只能返回白名单动作，不能直接操作协议、文件或系统命令。

## 最简单的使用方式：图形总控台

已经构建过项目时，双击根目录的 `Install-and-Open-Control-Center.cmd` 会检查环境、补齐部署并打开总控台。只想再次打开页面时执行：

```powershell
npm run dashboard
```

地址固定为 `http://127.0.0.1:3210`，只允许本机访问。页面包括：

- 运行概览：控制器和 Minecraft 进程、PID、游戏阶段、坐标、生命、饱食度、维度、附近玩家、模组数量。
- 启停：启动、停止、重启整个 Bot。
- 服务器/EasyAuth：地址、名称、离线模式、超时、首次注册、登录密码。
- 模型：DeepSeek/豆包/OpenAI、模型 ID、端点、推理强度、密钥以及一次最小额度测试。
- 聊天、人设、安全、记忆、日志等全部可设置项；难理解的区域带有可展开说明。
- 模组：填写服务器客户端模组来源文件夹，保存后点“立即同步”；以后新增或升级 mod 仍使用同一个入口。

所有设置最终仍保存在普通 JSON/`.env` 文件中，总控台不是唯一入口，换机器后可以直接携带这些文件。

## Windows 部署教程

### 0. 纯净 Windows 一键安装

适用于只下载了本项目、尚未安装 Node.js/Java/Minecraft 的 Windows 10/11/Server：

1. 解压项目到有写入权限的文件夹。
2. 双击 `Install-and-Open-Control-Center.cmd`。
3. Windows 询问安装权限时允许。脚本会通过 `winget` 安装 Node.js LTS 24（最低要求 22）和 Eclipse Temurin JDK 25。
4. 等待总控台自动打开；在页面填写模型 Key、EasyAuth 密码和模组来源，再启动 Bot。

脚本会依次执行环境检查、创建本地配置、npm 安装/构建、Minecraft 26.2 资源预取及哈希校验、Fabric bridge 构建、HeadlessMc 安装、模组同步和总控台启动。完整日志在 `logs\install-windows.log`。

如果系统没有 `winget` 或自动安装失败，先人工安装：

- Node.js 22 或更高版本：`https://nodejs.org/zh-cn/download`
- Eclipse Temurin JDK 25：`https://adoptium.net/temurin/releases/?version=25`

然后在项目目录运行：

```powershell
.\scripts\install-windows.ps1 -SkipEnvironmentInstall
```

当前一键安装流程已在本机用“跳过已有环境”的完整模式验证通过；由于本机开启全局美国 VPN，这不构成中国大陆无代理网络验证。项目保留 npmmirror、BMCLAPI/CERNET 和 GitHub 镜像回退，但应在一台没有代理的干净中国网络 Windows 上再做正式验收。

### 1. 准备环境

- Windows 10/11 或 Windows Server。
- Node.js `22` 或更新版本（开发测试使用 Node `24`）。
- Java `25`。安装 Minecraft 26.2 官方启动器运行时后，脚本通常可自动找到 `%APPDATA%\.minecraft\runtime\java-runtime-epsilon`。
- 至少约 2 GB 可用内存；无界面客户端实测工作集约 0.8–1 GB。
- 目标服务器完整的 **26.2 客户端模组包**。只有 Fabric API 无法进入本项目的目标服务器。

在项目目录执行：

```powershell
npm install
Copy-Item config\bot.example.json config\bot.json
Copy-Item config\persona.example.json config\persona.json
```

`npm install` 使用仓库中的 `.npmrc`，默认从 npmmirror 获取 npm 包。

### 2. 配置模型、服务器和人设

编辑 `config\bot.json`。默认服务器已设为：

```json
{
  "server": {
    "adapter": "fabric_bridge",
    "host": "ciallo.kim",
    "port": 25565,
    "version": "26.2",
    "username": "CialloAI",
    "auth": "offline"
  }
}
```

不要删除示例中其余字段。`online-mode:false` 对应 `auth:"offline"`。离线名称可直接修改 `username`；离线皮肤和披风是否显示取决于服务器的皮肤插件/模组。官方披风只能来自拥有该披风的正版账号。

编辑 `config\persona.json` 可以修改名字、性格、说话方式、目标和边界；编辑 `config\behavior-rules.json` 可以调整行为准则。

模型配置示例：

```json
{
  "model": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "baseUrl": "https://api.deepseek.com",
    "reasoningEffort": "high",
    "timeoutMs": 60000
  }
}
```

- `provider:"deepseek"`：使用 `/chat/completions`；`none` 关闭思考，其余强度映射为 DeepSeek 当前支持的 `high/max`。
- `provider:"volcengine"`：把 `model` 改成方舟控制台创建的豆包 Seed 2.1 Pro 端点/模型 ID，把 `baseUrl` 改成控制台给出的 OpenAI 兼容地址，密钥变量建议用 `ARK_API_KEY`。
- `provider:"openai"`：使用 `/responses`，密钥变量建议用 `OPENAI_API_KEY`；模型和推理强度按账号可用范围填写。

### 3. 注入秘密

可在当前终端、系统服务环境或被 Git 忽略的 `.env` 中设置。最简单的方式是复制模板后填写：

```powershell
Copy-Item .env.example .env
```

也可以只为当前终端注入：

```powershell
$env:DEEPSEEK_API_KEY='你的 API Key'
$env:MINECRAFT_LOGIN_PASSWORD='你的 EasyAuth 密码'
```

改用豆包或 OpenAI 时设置 `ARK_API_KEY` 或 `OPENAI_API_KEY`，并让 `apiKeyEnv` 与变量名一致。程序会自动读取项目根目录的 `.env`，但不会覆盖终端里已有的同名变量；`.env` 已被 Git 忽略，仍需避免复制到 README、日志或聊天中。

### 4. 构建控制器和 Fabric 桥

```powershell
npm run check
npm run build

$env:JAVA_HOME="$env:APPDATA\.minecraft\runtime\java-runtime-epsilon"
$env:Path="$env:JAVA_HOME\bin;$env:Path"
Set-Location fabric-bridge
.\gradlew.bat build --no-daemon
Set-Location ..
```

Gradle 配置包含国内镜像回退；所有版本都固定在 `fabric-bridge\gradle.properties`。

### 5. 准备无界面客户端

先下载并校验 Minecraft 26.2 客户端、库文件和 HeadlessMc：

```powershell
npm run prefetch:minecraft
.\scripts\install-headlessmc.ps1
```

然后把服务器客户端模组包合并进隔离实例。当前开发机来源是 `D:\开发\进服必须mod`；换机器时假设模组包在 `D:\server-mods`：

```powershell
.\scripts\prepare-fabric-client.ps1 -AdditionalModsDirectory 'D:\server-mods'
```

该步骤会复制本项目桥接模组和固定 Fabric API，并从外部包导入 23 个文件；包内旧版 `fabric-api-0.152.2+26.2.jar` 会按规则跳过，避免重复 mod ID。不要把服务端专用、明确不能装客户端的模组盲目复制进来；优先使用服主提供的同版本客户端整合包。实例位于 `.runtime\minecraft`，不会把模组写进项目源码。

模组来源和同步规则保存于 `config\mods.json`。以后服务器新增 mod 时：把新 jar 放进来源文件夹，删除被替换的旧 jar，然后在总控台点“立即同步”或执行 `npm run sync:mods`。同步器只删除上次清单中由自己复制的 jar，再复制当前来源文件并重建 `.runtime\minecraft\managed-mods.json`，不会删除未知文件。

如默认镜像不可达，可设置：

```powershell
$env:MCAI_MINECRAFT_LIBRARY_MIRROR='https://你可用的BMCLAPI镜像/bmclapi'
$env:MCAI_BMCLAPI_BASE='https://你可用的BMCLAPI镜像'
$env:MCAI_HEADLESSMC_DOWNLOAD_URL='https://可访问的、内容相同的HeadlessMc文件地址'
$env:MCAI_FABRIC_API_URL='https://可访问的、内容相同的Fabric-API文件地址'
```

下载文件仍会按官方元数据 SHA-1 或仓库固定 SHA-256 校验，镜像内容不符会立即停止。

### 6. 静默启动和停止

```powershell
npm run start:all
```

控制器与 Minecraft 客户端都会隐藏运行，不弹出游戏窗口。状态和错误写入：

- `logs\bot.log`
- `logs\background.stderr.log`
- `logs\minecraft-client.stderr.log`
- `.runtime\minecraft\logs\latest.log`

停止全部组件：

```powershell
npm run stop:all
```

也可分别使用 `npm run start:background`、`npm run stop:background`、`npm run start:client` 和 `npm run stop:client`。停止脚本会核对 PID 和可执行文件，避免误杀复用同一 PID 的其他程序。

## 使用方法

默认 `requireMention:true`，玩家消息中包含 Bot 名称时才触发回复，例如：

```text
CialloAI 跟着我
CialloAI 过来
CialloAI 看着我
CialloAI 停下
```

模型会根据当前世界状态返回回复和白名单动作。每名玩家使用 UUID 建立独立档案；显示名会随最近一次消息更新。空闲发言可用 `chat.proactiveEnabled` 关闭或调整间隔。

记忆迁移时至少保留：

- `data\memory.json`：所有玩家档案、长期事件与摘要，满足“统一为一个记忆文件”。
- `data\experience.json`：任务经验和纠错记录。

正常写入时程序还生成同名 `.bak`。误删主文件但备份仍在时，应先停止程序，再把 `.bak` 复制回原文件名。

## EasyAuth 与安全行为

Fabric 客户端读取服务器提示后，从 `MINECRAFT_LOGIN_PASSWORD` 取得密码并发送 `login <密码>`；新 Bot 名称收到 `/register` 提示且 `easyAuth.registerIfNeeded:true` 时发送两次密码完成注册。若插件没有提示，进入世界 5 秒后回退尝试登录。密码不会交给大模型；聊天和日志会将 `/login`、`/register` 参数及已知密码替换为 `[REDACTED]`。

当前安全规则默认：

- 不破坏玩家财产，不打开玩家容器，不拿玩家物品。
- 无法识别归属时按“不允许破坏”处理。
- 自主发展必须位于荒野；完整选址算法仍待实现，所以当前不会执行自主挖掘/建造。
- 只在记录到真实玩家伤害事件后的 15 秒内允许针对该攻击者反击；其他 PVP 指令会被拒绝。

## 文件作用与实现原理

### 使用者会接触的文件

| 文件 | 效果 | 实现原理 |
| --- | --- | --- |
| `Install-and-Open-Control-Center.cmd` | 双击完成安装并打开总控台 | 从项目目录调用 PowerShell 部署器，失败时保留窗口和日志 |
| `config/bot.json` | 实际服务器、模型、聊天、存储和日志参数 | 总控台将表单转换为 JSON；启动时严格校验后一次性载入 |
| `config/persona.json` | 实际 Bot 人设 | 每次模型请求把描述、说话风格、目标和边界放入系统上下文 |
| `config/behavior-rules.json` | 实际安全规则 | LLM 动作执行前由 `PolicyEngine` 再审查，不能靠提示词绕过 |
| `config/mods.json` | 服务器 mod 来源和同步规则 | 启动前/按钮触发时与上次清单比较，受管理地替换 jar |
| `.env` | API Key 和 EasyAuth 密码 | 仅本机载入且被 Git 忽略；WebUI 只显示是否存在，不返回值 |
| `data/memory.json` | 所有长期记忆和玩家档案 | UUID 分玩家、限制事件数量、原子写入并保留 `.bak` |
| `data/experience.json` | 任务经验、失败与修正 | 与记忆独立，提示组装时按任务检索相关经验 |
| `data/runtime-status.json` | 当前游戏阶段、坐标、生命、背包等 | Fabric 每秒上报结构化状态，Node 原子落盘，WebUI 轮询读取 |
| `.runtime/minecraft/managed-mods.json` | 最近一次服务器 mod 同步清单 | 记录来源、时间、文件名、大小和 SHA-256，用于安全升级/删除 |
| `logs/bot.log` | AI 控制器 JSONL 日志 | 每行一个结构化事件，递归脱敏 password/token/authorization |
| `.runtime/minecraft/logs/latest.log` | 原生客户端和 mod 日志 | Minecraft/Fabric 自身日志，用于排查注册表和模组崩溃 |

`config/*.example.json` 和 `.env.example` 是可提交的无秘密模板；同名非 example 文件才是本机实际设置。

### 程序源码与脚本

| 文件/目录 | 作用和原理 |
| --- | --- |
| `src/index.ts` | 后台控制器入口，加载配置并处理停止信号 |
| `src/config/types.ts` | 所有配置、规则、人设和推理强度的 TypeScript 契约 |
| `src/config/load-config.ts` | 读取 `.env`/JSON、校验必填值，进程环境变量优先于 `.env` |
| `src/llm/provider-factory.ts` | 用统一接口分别生成 DeepSeek/方舟 Chat Completions 与 OpenAI Responses 请求 |
| `src/llm/types.ts` | 模型请求/响应边界，使核心逻辑不绑定供应商 SDK |
| `src/agent/prompt.ts` | 组合人设、玩家专属记忆、经验、世界状态和安全规则；明确模型没有视听觉 |
| `src/agent/decision.ts` | 把模型 JSON 清洗成有限动作，未知动作降级为 `none` |
| `src/agent/agent-controller.ts` | 聊天→模型→策略→动作/回复/记忆的主编排 |
| `src/agent/world-state.ts` | 位置、生命、饱食、背包和附近玩家的统一结构 |
| `src/memory/memory-store.ts` | 单文件长期记忆、UUID 玩家隔离和事件裁剪 |
| `src/experience/experience-store.ts` | 独立经验文件及任务关键词检索 |
| `src/policy/policy-engine.ts` | 财产保护、未知归属拒绝、自卫攻击者与时间窗口验证 |
| `src/minecraft/fabric-bridge-client.ts` | 仅本机 TCP JSON Lines 服务，接收 Fabric 状态并发送带结果 ID 的白名单动作 |
| `src/minecraft/minecraft-client.ts` | Mineflayer 诊断适配器，不用于当前模组服正式运行 |
| `src/minecraft/easy-auth.ts` | Mineflayer 路线的认证提示处理；正式 Fabric 路线在 Java 模组中处理 |
| `src/runtime/bot-runtime.ts` | 创建模块、连接/关闭/重连循环并写运行阶段 |
| `src/runtime/status-store.ts` | 将 WebUI 所需实时状态原子保存到 `data/runtime-status.json` |
| `src/core/atomic-json-file.ts` | 临时文件→备份→替换，避免断电留下半个 JSON |
| `src/core/logger.ts` | 后台 JSONL 日志和秘密脱敏 |
| `src/webui/server.ts` | 仅绑定 `127.0.0.1:3210` 的管理 API、静态文件、配置校验、启停和模组同步；限制 Host/Origin/1 MiB 请求 |
| `public/webui/index.html` | 总控台信息架构和无障碍表单 |
| `public/webui/styles.css` | 不依赖外部 CDN 的响应式界面，适配桌面和窄屏 |
| `public/webui/app.js` | 读取状态、表单映射、保存、启停、同步、模型最小测试；不读取或回显秘密 |
| `fabric-bridge/.../MinecraftAiBridgeClient.java` | 在 Minecraft 内部主动连服、读取真实状态、EasyAuth 和执行键位/聊天/攻击动作 |
| `fabric-bridge/.../BridgeConnection.java` | Java 侧本机 JSON Lines 连接、重连和动作队列 |
| `fabric-bridge/.../LivingEntityDamageMixin.java` | 从真实伤害事件识别玩家攻击者，作为允许自卫的唯一依据 |
| `fabric-bridge/src/main/resources/*` | Fabric 模组元数据和 Mixin 声明 |
| `fabric-bridge/build.gradle`、`gradle.properties` | 固定 MC 26.2、Loader 0.19.3、API、Loom、Java 25 和国内 Maven 回退 |
| `fabric-bridge/gradle/wrapper/*`、`gradlew*` | 固定且可校验的 Gradle 9.5.1 构建入口，不要求预装 Gradle |
| `scripts/install-windows.ps1` | 纯净 Windows 环境检查/安装及从源码到总控台的全流程部署 |
| `scripts/prefetch-minecraft-libraries.mjs` | 从 BMCLAPI/CERNET 计算当前平台所需 26.2 库并逐项验证官方 SHA-1 |
| `scripts/install-headlessmc.ps1` | 下载固定 HeadlessMc 2.10.0 并验证 SHA-256 |
| `scripts/prepare-fabric-client.ps1` | 组装隔离客户端、桥、固定 Fabric API 和服务器模组 |
| `scripts/sync-client-mods.mjs` | 清理上次受管理 jar、复制当前来源、生成 SHA-256 清单 |
| `scripts/apply-minecraft-data-26.2.mjs` | 给 Mineflayer 诊断栈补充经审查的 26.2 协议数据 |
| `scripts/start-*`、`stop-*` | WebUI、Node、Minecraft 的隐藏启动和精确 PID 停止，组合启动失败会回滚 |
| `src/probe.ts` | 不发言、不动作的 Mineflayer 握手诊断 |
| `test/*.test.ts` | 决策、记忆、经验、策略、脱敏、本机桥和后续回归测试 |
| `vendor/minecraft-data/26.2/*` | 固定上游提交的声明式协议 JSON，仅用于诊断 |
| `package.json` / `package-lock.json` / `tsconfig.json` | 固定 Node 依赖、命令和严格 TypeScript 构建 |
| `.npmrc` / `.gitignore` | npmmirror 默认源；排除秘密、数据、日志、构建和运行时目录 |
| `README.md` / `README_AI.md` | 本文是人类教程；后者是跨账号/Agent 的完整续作档案 |

## 所有参数存放位置

### `config/bot.json`

| JSON 路径 | 默认值 | 作用 |
| --- | --- | --- |
| `server.adapter` | `fabric_bridge` | 正式原生 Fabric 或诊断 Mineflayer |
| `server.host` / `server.port` | `ciallo.kim` / `25565` | 目标服务器 |
| `server.version` | `26.2` | Minecraft 协议/客户端版本 |
| `server.username` | `CialloAI` | 离线玩家名称，也是默认聊天提及词 |
| `server.auth` | `offline` | `online-mode:false` 使用 offline；Microsoft 尚未完成 |
| `server.connectTimeoutMs` | `30000` | Node 等待游戏桥的单次时间 |
| `server.reconnectDelayMs` | `10000` | 断开后的重试间隔 |
| `server.bridgeHost` / `bridgePort` | `127.0.0.1` / `8765` | Java 与 Node 的本机控制通道；Host 必须为回环地址 |
| `server.actionTimeoutMs` | `10000` | 单个游戏动作等待结果的时间 |
| `easyAuth.enabled` | `true` | 是否启用服内登录 |
| `easyAuth.registerIfNeeded` | `true` | 新名称收到提示时是否允许注册 |
| `easyAuth.passwordEnv` | `MINECRAFT_LOGIN_PASSWORD` | 从哪个环境变量读取密码 |
| `easyAuth.loginDelayMs` | `1500` | Mineflayer 诊断路线等待时间；Fabric 使用提示优先/5 秒回退 |
| `model.provider` | `deepseek` | `deepseek`、`volcengine` 或 `openai` |
| `model.model` | `deepseek-v4-flash` | 实际模型名或方舟端点 ID |
| `model.apiKeyEnv` | `DEEPSEEK_API_KEY` | 当前供应商密钥变量名 |
| `model.baseUrl` | `https://api.deepseek.com` | API 根地址，可换兼容网关 |
| `model.reasoningEffort` | `high` | `none/low/medium/high/xhigh/max` |
| `model.timeoutMs` | `60000` | 单次模型请求超时 |
| `chat.requireMention` | `true` | 是否只有提到 Bot/`!` 开头才回复 |
| `chat.replyPrefix` | 空 | 每次游戏回复前缀 |
| `chat.cooldownMs` | `2500` | 防止连续回复刷屏 |
| `chat.proactiveEnabled` | `true` | 是否启用空闲主动发言 |
| `chat.proactiveIdleMs` | `180000` | 多久无消息视为空闲 |
| `chat.proactiveMinIntervalMs` | `300000` | 两次主动发言最小间隔 |
| `storage.memoryFile` | `data/memory.json` | 唯一长期记忆文件 |
| `storage.experienceFile` | `data/experience.json` | 独立经验文件 |
| `storage.maxEvents` | `5000` | 长期事件最多保留数 |
| `policyFile` / `personaFile` | `config/...json` | 规则和人设路径；WebUI 只允许项目 config 内 |
| `logging.file` | `logs/bot.log` | JSONL 日志路径 |
| `logging.level` | `info` | `debug/info/warn/error` |
| `logging.console` | `false` | 是否同时输出控制台；静默后台建议 false |

### 其他设置文件

| 文件/路径 | 参数 |
| --- | --- |
| `config/persona.json` | `name` 名称、`description` 身份、`speakingStyle` 风格、`goals[]` 目标、`boundaries[]` 边界 |
| `config/behavior-rules.json` | `denyBreakingPlayerProperty`、`denyOpeningPlayerContainers`、`denyTakingPlayerItems`、`wildernessDevelopmentOnly`、`allowSelfDefense`、`selfDefenseWindowMs`、`stopSelfDefenseWhenThreatEnds`、`allowPlayerOrderedPvp`、`allowDestructiveActionsWhenOwnershipUnknown` 和 `proactiveChat.*` |
| `config/mods.json` | `sourceDirectory` 外部 mod 文件夹、`syncOnClientStart` 启动自动同步、`excludeFilePatterns[]` 文件名正则排除 |
| `.env` | `MINECRAFT_LOGIN_PASSWORD`、`DEEPSEEK_API_KEY`、`ARK_API_KEY`、`OPENAI_API_KEY`；内容绝不提交 |
| 环境变量 | `MCAI_MINECRAFT_HOME`、`MCAI_MINECRAFT_LIBRARY_MIRROR`、`MCAI_BMCLAPI_BASE`、`MCAI_HEADLESSMC_DOWNLOAD_URL`、`MCAI_FABRIC_API_URL`、`MCAI_JAVA_HOME`、`MCAI_WEBUI_PORT` 可覆盖运行/下载位置 |

总控台保存“全部设置”时写前三个 JSON 和 `mods.json`；“安全保存密钥”只写 `.env`。修改设置后，已运行的 Bot 需要点“重新启动”才会重新载入。

## 故障排查

**日志出现 `Received 611 registry entries that are unknown to this client`**

客户端缺少服务器模组。项目已经用 `D:\开发\进服必须mod` 的包解决并真实进服；换机器时在总控台设置同一模组包来源并点“立即同步”。

**日志出现大量 `Missing sound` 或 `OpenAL 1.1 not supported`**

这是无界面模式使用虚拟资源/无音频设备的预期警告；声音系统会关闭，不影响文本、网络与结构化游戏控制。

**出现 Mojang Realms 401**

离线账号无法访问 Realms，目标服务器为 `online-mode:false`，该错误不阻断普通服务器连接。

**控制器提示等待 Fabric 桥超时**

确认客户端也已启动、桥接 jar 在 `.runtime\minecraft\mods`、端口 `127.0.0.1:8765` 未被其他程序占用。控制器会按配置自动重试。

**模型没有回复**

检查 API Key 环境变量、`config\bot.json` 的模型 ID/端点，以及 `logs\bot.log`。默认需要在消息中提到 Bot 名称，并有 2.5 秒聊天冷却。

## 开发与验证

```powershell
npm run check
npm test
npm run build
npm run probe
```

`probe` 使用 Mineflayer 做只读连接诊断，不适合作为该模组服的正式客户端。正式路线是 `fabric_bridge`。

每次变更必须同步更新本文档和 `README_AI.md`。提交前还应运行 Fabric 构建、`git diff --check`、秘密扫描和相关真实环境测试。远端为 `https://github.com/wraaaaaa/Minecraftaiplayer.git`，默认分支 `main`。

## 兼容范围与许可证

- 当前完整部署脚本针对 Windows/Windows Server；核心 Node 和 Java 代码可移植，但 Linux 无界面服务脚本尚未提供。
- Simple Voice Chat `fabric-2.6.20+26.2` 已随服务器模组成功握手并请求语音 secret；Headless 环境没有 OpenAL 设备，日志显示 `Speaker unavailable`，因此当前只有兼容进服、没有收发语音能力。文本与结构化游戏控制不受影响。
- 2026-08-04 的安装、下载和进服测试均在用户开启全局美国 VPN 的电脑完成，不能作为中国大陆无代理可用性的证明；“国内镜像路径已实现”与“无代理正式验收”必须区分。
- 项目许可证尚未确定，暂不应把仓库内容视为已授予开源再分发许可。引入第三方内容前继续核对其许可证。
