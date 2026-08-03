# Minecraft AI Player

让大模型以真正的 Minecraft 客户端玩家身份进入 Java Edition `26.2` Fabric 模组服务器，在后台接收聊天指令、区分玩家、保存记忆，并执行受行为准则约束的游戏动作。

当前是可运行的第一阶段版本：原生 Fabric 无界面客户端、AI 控制器、聊天/状态桥、三种模型 API、记忆与经验文件、EasyAuth、安全规则和静默后台运行均已实现。客户端已经真实连接到 `ciallo.kim`；由于测试实例没有该服务器的完整客户端模组包，服务器在同步 611 个模组注册项时拒绝进入。复制服务器对应的客户端模组包后才能完成正式进服验证。

## 当前能力

已实现：

- Minecraft `26.2`、Fabric Loader `0.19.3`、Fabric API `0.156.0+26.2` 原生客户端桥。
- Windows 无界面启动，控制器与游戏客户端均隐藏在后台；提供安全启动、停止和 PID 记录。
- DeepSeek、火山方舟（豆包）OpenAI 兼容接口、OpenAI Responses API；模型名、端点与推理强度均可配置。
- 通过结构化世界状态和动作接口控制游戏，不依赖屏幕、图像、声音或鼠标模拟，适合 DeepSeek 等纯文本模型。
- 玩家聊天、系统消息、位置、生命、饱食度、维度、时间、背包和附近玩家状态。
- 按玩家 UUID 保存独立档案和事件的单一 `memory.json`；经验另存为 `experience.json`；两者原子写入并保留 `.bak`。
- 自定义人设、回复限频、被提及时回复、空闲主动聊天。
- EasyAuth 自动执行 `/login`，密码只从环境变量读取且日志脱敏。
- `聊天、停止、看向玩家、跟随、走向玩家、有限半径闲逛、受击后一次自卫反击`动作。
- 独立行为准则：禁止破坏玩家物品、禁止打开玩家容器、未知归属时拒绝破坏、仅允许短时针对实际攻击者自卫。
- Mineflayer 兼容探针与固定来源的 26.2 协议数据，供诊断使用；目标模组服默认使用原生 Fabric 适配器。
- 中国大陆下载路线：npm 镜像、BMCLAPI/CERNET Minecraft 资源镜像、GitHub 下载镜像回退，并对游戏资源或工具执行官方 SHA-1/SHA-256 校验。

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

## Windows 部署教程

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

然后把服务器客户端模组包合并进隔离实例。假设模组包在 `D:\server-mods`：

```powershell
.\scripts\prepare-fabric-client.ps1 -AdditionalModsDirectory 'D:\server-mods'
```

该步骤会复制本项目桥接模组和 Fabric API。不要把服务端专用、明确不能装客户端的模组盲目复制进来；优先使用服主提供的同版本客户端整合包。实例位于 `.runtime\minecraft`，不会把模组写进项目源码。

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

Fabric 客户端进入世界后会从 `MINECRAFT_LOGIN_PASSWORD` 读取密码并直接发送 `login <密码>`，不会把密码交给大模型。聊天和日志会将 `/login` 参数及已知密码替换为 `[REDACTED]`。

当前安全规则默认：

- 不破坏玩家财产，不打开玩家容器，不拿玩家物品。
- 无法识别归属时按“不允许破坏”处理。
- 自主发展必须位于荒野；完整选址算法仍待实现，所以当前不会执行自主挖掘/建造。
- 只在记录到真实玩家伤害事件后的 15 秒内允许针对该攻击者反击；其他 PVP 指令会被拒绝。

## 故障排查

**日志出现 `Received 611 registry entries that are unknown to this client`**

客户端缺少服务器模组。目标服实测涉及 `beautify`、`farmersdelight`、`waystones`、`xaerominimap` 和另一个命名空间。使用服主提供的完整 26.2 客户端整合包重新执行 `prepare-fabric-client.ps1`。

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
- Simple Voice Chat `fabric-2.6.20+26.2` 接口仅在路线图中，当前无语音能力。
- 项目许可证尚未确定，暂不应把仓库内容视为已授予开源再分发许可。引入第三方内容前继续核对其许可证。
