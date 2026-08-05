# Minecraft AI Player

让大模型以真正的 Minecraft 客户端玩家身份进入 Java Edition `26.2` Fabric 模组服务器，在后台接收聊天指令、区分玩家、保存记忆，并执行受行为准则约束的游戏动作。

当前版本已经不是“只能跟随”的演示：它包含原生 Fabric 无界面客户端、AI 控制器、本机图形总控台、持久任务/记忆/经验，以及一套不依赖大模型临场猜测的确定性生存发育规划器。Bot 会按真实世界状态从食物、木石工具、熔炉和住所开始，继续制作全套铁/钻石工具与护甲、采矿、熔炼、交易、附魔、建床睡觉、进入下界并寻找末地。每一步都必须由服务端方块、背包、菜单、实体或维度状态确认；完整从零到末地的连续实服旅程尚未跑完，因此不能把“链路已实现”误写成“已经自动通关”。

## 当前能力

已实现：

- Minecraft `26.2`、Fabric Loader `0.19.3`、Fabric API `0.156.0+26.2` 原生客户端桥。
- Windows 无界面启动，控制器与游戏客户端均隐藏在后台；提供安全启动、停止和 PID 记录。
- 本机 Web 总控台：可视化编辑所有 Bot 参数、人设、规则、模组路径和秘密，并查看运行进程、世界坐标、生命、饱食度、维度、附近玩家及日志；“总聊天”把分玩家对话、结构化决策摘要、动作步骤、后置条件和完整脱敏错误合并成一条本机时间线。
- DeepSeek、火山方舟（豆包）OpenAI 兼容接口、OpenAI Responses API；模型名、端点与推理强度均可配置。
- 通过结构化世界状态和动作接口控制游戏，不依赖屏幕、图像、声音或鼠标模拟，适合 DeepSeek 等纯文本模型。
- 玩家聊天、系统消息、位置、生命、饱食度、空气、着火/入水、维度、时间、光照、装备/附魔/耐久、背包、附近玩家、敌对生物和掉落物状态。
- 按玩家 UUID 保存独立档案和事件的单一 `memory.json`；经验另存为 `experience.json`；两者原子写入并保留 `.bak`。
- 自定义人设、真实回复限频、近距离/语境寻址、显式名称或 `!` 寻址，以及限频的空闲 AI 决策/偶尔聊天；近距离自然命令无需每次喊 Bot 名。
- EasyAuth 根据服务器提示自动执行 `/login`，首次使用新名称时可选自动 `/register`；密码只从环境变量读取且日志脱敏。
- 持久任务队列：`wraaaaaa` 始终最高优先；其他玩家按当前距离由近到远，同一玩家内部按紧急度和先入先出；全局只执行一项。明确“停止/取消”绕过模型立即抢占。
- 本地生存反射：低生命/低饱食时选择无负面效果的安全食物；只攻击正在威胁 Bot 的敌对生物，自动选择快捷栏最佳武器；死亡后自动复活。
- 白名单动作：聊天、停止、看向/跟随/走向玩家、安全探索、进食、选择最佳装备、准备危险任务、攻击确认敌对目标、使用物品、受保护采集、收集本任务掉落、合成、放置普通方块、把背包物品交给指定玩家、建造/寻找住所和安全等待。复杂指令可由最多 12 个基础动作组成顺序计划，每一步都重新读取游戏状态并验证后置条件。
- 危险度准备：末地/末影龙任务在执行跟随等主动作前也会强制检查装备，最低为四件附魔黄金等效护甲、同等级武器、安全耐久和至少 16 个安全食物；不足时选择现有最佳装备后详细拒绝。
- 住所：AI 自行选择候选环境，Fabric 对施工点逐格验证天然性、玩家结构、容器、危险源、碰撞、撤退路线和其他玩家距离；施工前要求门、普通火把和 23 个同类安全实心方块，住所坐标持久化到单独文件。
- 独立行为准则：禁止破坏玩家物品、禁止打开玩家容器、未知归属时拒绝破坏、仅允许短时针对实际攻击者自卫。
- Mineflayer 兼容探针与固定来源的 26.2 协议数据，供诊断使用；目标模组服默认使用原生 Fabric 适配器。
- 中国大陆下载路线：npm 镜像、BMCLAPI/CERNET Minecraft 资源镜像、GitHub 下载镜像回退，并对游戏资源或工具执行官方 SHA-1/SHA-256 校验。
- 受管理的服务器模组同步：记录来源、文件名和 SHA-256；未来更新来源文件夹后可从总控台一键替换，不会误删项目自己的桥或 Fabric API。
- 局域网兼容模式：自动监听 Java 版“对局域网开放”的广播和动态端口，用离线 Bot 与同一台电脑或同一局域网的人类玩家游玩。
- 皮肤管理：WebUI 严格校验 64x64/64x32 PNG、选择 classic/slim，并集成官方万用皮肤加载器；可生成分发给所有玩家的客户端皮肤包，确保安装者看见 Bot 皮肤。
- OpenClaw 风格提示词工作区：`rules.md`、`IDENTITY.md`、`SOUL.md`、`TOOLS.md`、`MEMORY.md` 可在 WebUI 或本地同步编辑；每位玩家自动生成隔离的 `USER.md`。上下文接近预算时会调用当前模型压缩旧事件、更新摘要和对应玩家画像。
- 受限自我改进：同类动作重复失败达到阈值后，可经百度或自建 SearXNG 检索公开解决思路；网页内容按不可信文本处理。AI 只可写 `TOOLS.md` 的托管经验段和声明式 `behavior-patches.json`，不能修改可执行源码、启动脚本、硬规则或秘密。
- 纯净 Windows 一键部署入口，可安装 Node.js LTS、Java 25 并完成全套构建、资源准备和总控台启动。
- 持久自主目标 `reach_end`：本地规划器按饥饿/食物储备、工作设施、住所、床、石器、铁器、钻石装备、附魔、下界材料、末影之眼、要塞和末地逐步推进；安全、玩家任务和受击会抢占长期计划。
- 高级生产动作：狩猎成年且未驯服/未命名的食物生物、羊和牛，追踪本次掉落；熔炉菜单自动装入原料/燃料并取出结果；制作五类石/铁/钻石工具和铁/钻石四件护甲；穿戴最佳护甲并切换任务所需工具。
- 世界发展动作：煤/铁/青金石/钻石等资源扫描与阶梯矿道，遇到天然墙体可安全开路；固定小屋、同色羊毛床、睡觉重生点、村民可承担交易、附魔台和逐件装备附魔、下界门建造、下界/主世界/末地通行及末影之眼要塞搜索。
- 路径与水下生存：有界 A* 记录逐格路线、重新规划、绕开危险落脚点；阶梯挖掘可清理头顶、在洞穴内放置自有垫脚块并以稳定落地作为后置条件；游泳时搜索可呼吸水面，冰下无出口时可破坏天然冰/雪顶部自救。
- 主人全图寻找：仅 `autonomy.ownerName`（默认 `wraaaaaa`）可使用服务器定位栏航向跨已加载路段持续续航；普通玩家仍只在客户端能观测到时跟随。跟随任意玩家时，确认有怪物把该玩家设为目标会暂停普通活动并保护他。
- 自有方块账本：工作台、熔炉、床、附魔台、住所和上行垫脚块按维度/坐标写入 `data/owned-blocks.json`；只把账本中仍与服务端实际方块一致的设施当作自己的，避免借用或破坏玩家设施。

当前明确限制：

- 寻路仍是围绕当前已加载区块的本地规划，不是全局 Baritone。长距离依靠分段加载；门、梯子、藤蔓、复杂跑酷、动态船只和未知模组地形仍可能阻塞。普通探索最多尝试有限方向，只会破坏经 `WildernessGuard` 判定的天然障碍。
- 自主发展检查点会持久化，但它不是通用依赖 DAG；客户端在单个长动作中断线时由 Node 重新排队，已完成的局部世界修改不会自动回滚。完整下界要塞、要塞传送门和末地链必须在目标服继续长时间验收。
- 自动采集只读取已加载范围；矿道是安全的双格阶梯/隧道搜索，不具备透视。人造结构、方块实体、危险流体或归属不明方块会停止并在 WebUI 说明原因。
- 已实现熔炼、村民交易、附魔和床，但没有农业种植/繁殖、药水酿造、铁砧组合、锻造台升级或任意建筑设计器。住所目前是固定 3×3 安全小屋。
- 村民交易只在成年、未占用且已加载的村民旁选择当前背包付得起的有益交易；不会自动刷职业或重置交易。附魔只使用当前附魔台可提供且经验/青金石付得起的选项。
- 模组食物通过 26.2 的 `FOOD`/`CONSUMABLE` 数据组件识别；已知有害原版食物被拒绝，但未知模组副作用无法完全推断。模组矿物、装备、容器和配方需要后续注册表扩展。
- Microsoft 正版登录自动化、正版披风上传、Simple Voice Chat 语音收发和自动通关尚未实现。语音模组可完成网络握手，但无界面环境没有音频设备。

### 2026-08-05 实服回归结果

- 最新候选版本在后台重新进服后，饥饿值从 `19` 实际恢复到 `20`；随后连续得到服务端后置条件：放置自有工作台、3×3 合成熔炉、放置自有熔炉。Bot 坐标随路径移动而变化，不是只生成文字计划。
- 同轮在地下找不到合法食物目标后自动选择向上开路；修复狭窄通道脚部格投影后，实测从 Y=43 到 Y=59，完成 `31` 个阶梯步骤、破坏 `95` 个天然方块、放置 `1` 个自有支撑，石材背包增量 `72`。到达后规划器继续制作工作台和木板，没有停在矿道原语中。
- 修复了 Windows 下 WebUI/安全软件读取运行状态时可能长期阻止 `rename/unlink` 的问题：状态文件先保留 `.bak`，再有界重试，仍被占用时才降级为原位写入；重启后的 `runtime-status.json` 已持续刷新。
- 已实测自主制作木板、工作台、熔炉、木镐，以及石镐、石斧、石剑、石铲、石锄；不是只在单元测试中生成计划。
- 地下阶梯挖掘已实测从 Y=64 下探到 Y=48，破坏 76 个天然方块并产生 49 个石材背包增量；随后从洞穴 Y=54 稳定开路上浮到 Y=64，结果为 `verified_tunnel_steps=11; verified_broken_blocks=34; inventory_delta=9; final_y=64`。
- 上浮测试复现并修复了水平距离假到达、悬空脚手、跨列头顶碰撞、空中 tick 假落地和跌落后保留旧目标；最终只在实际落地且达到终点高度时成功。
- 模组食物实测识别 `farmersdelight:chicken_soup` 为安全食物并实际食用；腐肉被标记为不安全。饥饿阈值为 20，只要未满就尝试进食。
- 实测完成荒野工作台/熔炉放置及持久自有方块登记，附近玩家工作台不会被当作自己的设施。
- 实测发现 Bot 追鱼时在冰下溺亡；服务器聊天明确记录 `drowned`。现已加入提前氧气接管、水面出口寻路和天然冰层破拆，自救代码已完成 Java 25 构建并部署；仍需下一次冰下场景复测，不能把编译通过写成现场通过。
- 自动复活在该次溺亡后实测成功，Bot 约 3 秒后重新进入活动状态。完整铁/钻石、交易、附魔、下界和末地长链已有动作后置条件实现，但尚未在本轮从零连续跑到终点。

## 运行结构

```text
玩家聊天/世界事件
        ↓
Minecraft 26.2 + Fabric 桥（无界面）
        ↕ 仅本机 127.0.0.1:8765，JSON Lines
Node.js AI 控制器
        ├─ 模型适配器（DeepSeek / 豆包 / OpenAI）
        ├─ 人设、多人记忆、经验、持久任务调度
        ├─ 语境寻址、危险度准备、密钥出站防护
        └─ 行为规则审查 → 结构化游戏动作
```

Fabric 桥只监听/连接本机回环地址，不向局域网或公网开放控制端口，并使用每次启动生成的会话令牌。大模型只能返回白名单动作，不能直接操作协议、文件或系统命令；模型密钥不会传入 Minecraft Java 进程。

## 最简单的使用方式：图形总控台

首次安装双击根目录的 `Install-and-Open-Control-Center.cmd`；以后只打开页面双击 `Open-WebUI.cmd`，静默启动或停止 Bot 双击 `Start-Bot.cmd` / `Stop-Bot.cmd`。命令行也可以执行：

```powershell
npm run dashboard
```

地址固定为 `http://127.0.0.1:3210`，只允许本机访问。页面包括：

- 运行概览：控制器和 Minecraft 进程、PID、游戏阶段、坐标、生命、饱食度、维度、附近玩家、模组数量。
- 启停：启动、停止、重启整个 Bot。
- 服务器/EasyAuth：地址、名称、离线模式、超时、首次注册、登录密码。
- 模型：DeepSeek/豆包/OpenAI、模型 ID、端点、推理强度、密钥以及一次最小额度测试。
- 聊天、人设、安全、记忆、日志等全部可设置项；难理解的区域带有可展开说明。
- 总聊天：自动刷新玩家消息、Bot 游戏内回复、任务计划、逐步执行结果与完整错误；可切换“全部 / 仅游戏对话 / 仅警告与错误”。这里显示的是可验证的结构化决策摘要，不是模型隐藏思维链。
- 模组：填写服务器客户端模组来源文件夹，保存后点“立即同步”；以后新增或升级 mod 仍使用同一个入口。
- 局域网：选择“局域网自动发现”，在人类世界开放 LAN 后扫描并自动填写动态端口。
- 皮肤：导入标准 PNG、选择手臂模型、安装万用皮肤加载器并生成其他玩家使用的皮肤包。
- 记忆与提示词：可视化编辑完整提示词，查看和导出统一记忆/经验文件。

所有设置最终仍保存在普通 JSON/`.env` 文件中，总控台不是唯一入口，换机器后可以直接携带这些文件。

游戏聊天与诊断聊天有明确边界：游戏里只进行自然对话、接受任务、报告完成或用一句话说明“现在做不到”；不会再广播动作名、物品命名空间 ID、调用参数、步骤序号或底层报错。需要排错时打开 WebUI 的“总聊天”，完整原因保存在本机 `data/diagnostics.json`，并在写入前经过密钥、登录信息、服务器地址和本地路径脱敏。

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
    "host": "你的域名.com",
    "port": 25565,
    "version": "26.2",
    "username": "CialloAI",
    "auth": "offline"
  }
}
```

不要删除示例中其余字段。`online-mode:false` 对应 `auth:"offline"`。离线名称可直接修改 `username`，但 EasyAuth 只接受 3–16 位英文字母、数字或下划线，不能使用空格、连字符或中文；WebUI 和后端都会在保存时拦截无效名称。所有参数的精确路径、允许值和效果见 [`PARAMETERS.md`](PARAMETERS.md)。

### 局域网兼容模式

人类玩家在单人世界暂停菜单选择“对局域网开放”，然后在 WebUI 将连接模式改为 `lan`（或直接点“扫描局域网世界”）并保持 `auth:"offline"`。Bot 启动时监听 `224.0.2.60:4445`，读取广播里的动态端口后静默加入；无需把世界改成固定端口。同机和同路由器都支持。扫描失败时先检查 Windows 防火墙是否允许 UDP 4445、是否真的已开放 LAN，以及 VPN/虚拟网卡是否抢占组播接口。

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
    "timeoutMs": 120000,
    "maxOutputTokens": 4096
  }
}
```

- `provider:"deepseek"`：使用 `/chat/completions`；`none` 关闭思考，其余强度映射为 DeepSeek 当前支持的 `high/max`。
- `provider:"volcengine"`：把 `model` 改成方舟控制台创建的豆包 Seed 2.1 Pro 端点/模型 ID，把 `baseUrl` 改成控制台给出的 OpenAI 兼容地址，密钥变量建议用 `ARK_API_KEY`。
- `provider:"openai"`：使用 `/responses`，密钥变量建议用 `OPENAI_API_KEY`。GPT-5.6 旗舰可填 `gpt-5.6-sol`（或会路由到 Sol 的 `gpt-5.6` 别名），平衡/高吞吐角色可分别选择 `gpt-5.6-terra` / `gpt-5.6-luna`；以账号实际权限为准。官方说明见 [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)。

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

改用豆包或 OpenAI 时设置 `ARK_API_KEY` 或 `OPENAI_API_KEY`，并让 `apiKeyEnv` 与变量名一致。程序会自动读取项目根目录的 `.env`，但不会覆盖终端里已有的同名变量；`.env` 已被 Git 忽略，仍需避免复制到 README、日志或聊天中。没有模型 Key 时 Bot 仍会进入游戏并保持后台连接，但收到 AI 请求会明确失败，不会伪造回答。

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

然后把服务器客户端模组包合并进隔离实例。真实来源目录只保存在本机 `config/mods.json`；以下用 `C:\MinecraftMods` 举例：

```powershell
.\scripts\prepare-fabric-client.ps1 -AdditionalModsDirectory 'C:\MinecraftMods'
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

默认启用语境判断。明确写 Bot 名称或用 `!` 开头一定会触发；当玩家是附近最可能的说话对象、语句像直接命令/提问，或正在延续刚才的近距离对话时，不需要喊名字。例如：

```text
CialloAI 跟着我
过来
帮我挖 8 个原木
陪我去末地打怪
停止
```

远处闲聊、明确叫其他人的话、多名玩家之间含糊的陈述不会误触发。模型根据结构化世界状态返回回复和白名单动作；程序再做能力、危险度、财产和真实后置条件检查。每名玩家使用 UUID 建立独立档案；显示名会随最近一次消息更新。空闲模型决策与偶尔发言可用 `chat.proactiveEnabled` 一并关闭或调整间隔；关闭它不影响无需模型的本地进食、防卫和安全挂机。

### 动作、任务顺序与逐目标环境验证

当前动作不是“只能跟随”。Bot 可以聊天、停止、看向/跟随/走向玩家、分段探索、进食、选择装备、准备挖矿/战斗、攻击已确认威胁、使用背包物品、受保护采集、收集本任务掉落、执行受限合成、建造或寻找住所，以及在安全位置停止等待。针对玩家的攻击只允许行为规则认可的短时自卫；打开容器和无法证明归属的直接破坏会被拒绝。

玩家可以自然地说“挖掉 3 个石头”“破坏 2 个原木”或“采 5 个铁矿”。模型可返回 `break_block`，程序会在 Node 层把它转换为同一个受保护的 `gather_resource` 原语；这不是任意坐标拆除接口。人工坐标开发区已经取消：AI 根据结构化环境选择意图，Fabric 才是最终授权层，并对每个候选方块检查方块 ID/tag、天然性、附近玩家结构、方块实体、工具、危险流体、玩家距离、碰撞、撤退路线和服务端实际状态。

无玩家任务时，确定性长期规划器每轮选择一个朝 `reach_end` 前进的可观察步骤；采集会先选择挖矿工具并收取本次登记的自有掉落。空闲模型决策硬性禁止跟随、接近、注视或攻击玩家；所有世界修改继续接受 Fabric 的逐目标检查。玩家任务、受击、饥饿和危险会抢占长期计划，失败写入经验和总聊天，并可能触发受限自我改进。

玩家命令进入全局单任务队列。`autonomy.ownerName` 对应玩家的任务始终优先；没有该玩家任务时，先选择当前离 Bot 最近的发令玩家，再在该玩家的任务中按紧急度从高到低、同紧急度按先入先出执行。明确且独立发送“停止”“停下”“取消当前任务”“stop”或“cancel”会绕过模型，立即停止 Java 长动作并把当前全局任务记为失败；这不是只取消发令者自己的任务。

采集、放置、探索、开矿和建房需要 `autonomy.allowVerifiedWilderness:true`（公开示例已启用）。`autonomy.developmentZone` 是仅为旧配置解析保留的废弃字段，运行时会忽略，WebUI 也不再提供坐标表单。默认与其他客户端玩家保持至少 `48` 格（`autonomy.wildernessMinPlayerDistance`）；发令玩家可近距离监督自己明确要求的单次采集，但其他玩家靠近仍会让 Fabric 取消动作。

`build_shelter` 建造固定 3×3、三格高的简易住所。背包需预先有一个可手动开关的门、一支普通火把，以及至少 23 个同一种安全实心满方块；光源、门和外壳都通过正常多人交互放置并等待服务端状态确认。候选点还必须有稳定 3×3 地面、可替换且无方块实体的施工空间、未被实体占用、门位无红石信号、8 格内无敌对威胁，并通过玩家结构、玩家距离和逐目标安全验证。`seek_shelter` 只在确有已记录住所时主动使用，避免没有住所时反复失败。

### 运行数据迁移

记忆与运行状态迁移时保留：

- `data\memory.json`：所有玩家档案、长期事件与摘要，满足“统一为一个记忆文件”。
- `data\experience.json`：任务经验和纠错记录。
- `data\tasks.json`：所有排队、运行、完成、失败/拒绝任务；重启/重连后恢复未完成项。
- `data\autonomy-state.json`：服务端确认过的住所维度、室内位置和门位置。
- `data\diagnostics.json`：WebUI“总聊天”的结构化决策、每步参数、后置条件和完整脱敏错误，最多保留最近 1000 条并原子写入 `.bak`；它用于排错，不替代统一记忆。
- `data\agent-prompts\`：运行时五份全局 Markdown 提示词及声明式行为补丁；可直接编辑，也可由 WebUI 保存。
- `data\player-profiles\<uuid-or-name>\USER.md`：每位玩家的画像，首次对话自动创建；不能跨玩家混用。
- `data\self-improvement.json`：失败签名、重复次数、研究与学习时间；不含网页全文和密钥。

迁移 `tasks.json` 和 `autonomy-state.json` 时，先停止旧目录中的 Bot 和 Minecraft 客户端，再把这两个文件复制到新项目 `data` 目录，并确认 `config/bot.json` 的 `storage.taskFile` / `storage.autonomyFile` 仍指向它们。`tasks.json` 会保留 `.bak`，启动时会把遗留的 `running` 任务重新排为 `queued`；`autonomy-state.json` 使用临时文件原子替换但不生成 `.bak`，加载时还会校验格式、维度和门/室内坐标，因此应另行备份。不要迁移 `bridge-token.txt`、PID 或 `runtime-status.json`；它们会在新实例启动时重建。

`memory.json`、`experience.json`、`tasks.json` 和 `diagnostics.json` 正常写入时会生成同名 `.bak`。误删这些主文件但备份仍在时，应先停止程序，再把对应 `.bak` 复制回原文件名。`.env` 也不会随源码或 Git 自动迁移，必须通过安全渠道在新机器重新配置，不能发进游戏聊天、提交记录或问题截图。

原始事件仍统一保存在 `memory.json`，玩家消息、实际回复和游戏事件即时原子追加；不同玩家按 UUID/名称隔离。接近上下文预算时，`ContextCompressor` 保留最近事件，把更早内容总结到该玩家摘要、全局摘要和对应 `USER.md`，随后原子删除已经压缩的事件 ID。动作失败同时写入 `experience.json`；同类错误达到阈值后，自我改进层可研究并只写受限托管区。示例在 `config/agent-prompts.example/`，运行副本在 `data/agent-prompts/`。

## 离线皮肤与多人可见

1. 在 WebUI“Bot 皮肤”选择 `classic` 或 `slim`，上传标准 64x64（或旧版 64x32）PNG。
2. 点击“校验并导入皮肤”；官方 `CustomSkinLoader_Universal-15.0.1.jar` 会进入 Bot 的隔离客户端。
3. 点击“生成给其他玩家的皮肤包”，取得 `.runtime\skin-pack\Minecraft-AI-Skin-Pack.zip`。
4. 每个需要看见 Bot 皮肤的人将压缩包内容复制到自己正在使用的 Minecraft 实例目录，然后重启并重新进服。

万用皮肤加载器官方明确说明 LocalSkin 只能由持有同一文件的客户端看见，所以“只给 Bot 装 Mod”不会把纹理广播给其他玩家。长期服务器更推荐把同名 Bot 角色上传到所有玩家共同配置的 LittleSkin/兼容皮肤站；配置位置为 `config/skin.json`。官方正版披风仍只能随实际拥有披风的 Microsoft 账号使用。

## EasyAuth 与安全行为

Fabric 客户端读取服务器提示后，从 `MINECRAFT_LOGIN_PASSWORD` 取得密码并发送 `login <密码>`；新 Bot 名称收到 `/register` 提示且 `easyAuth.registerIfNeeded:true` 时发送两次密码完成注册。若插件没有提示，进入世界 5 秒后回退尝试登录。密码不会交给大模型；聊天和日志会将 `/login`、`/register` 参数及已知密码替换为 `[REDACTED]`。

当前安全规则默认：

- 不破坏玩家财产，不打开玩家容器，不拿玩家物品。
- 无法识别归属时按“不允许破坏”处理。
- 采集和建造必须通过 Fabric 的目标逐格验证与其他玩家最小距离；人工坐标框不能授权或放宽任何行为，玩家在长动作中途靠近也会终止。
- 只在记录到真实玩家伤害事件后的 15 秒内允许针对该攻击者反击；其他 PVP 指令会被拒绝。
- 索取 API Key、密码、令牌、服务器地址、本地路径、配置或系统提示词时，本地规则会在调用模型前拒绝。已知秘密和常见密钥形状还会在模型输入、记忆、经验、日志和游戏聊天出口再次脱敏。
- 断开本机桥时 Java 立即清空移动键并取消采集/建房；长动作在 Node 侧超时也会先发 `stop`，避免失去控制后继续修改世界。

## 文件作用与实现原理

### 使用者会接触的文件

| 文件 | 效果 | 实现原理 |
| --- | --- | --- |
| `Install-and-Open-Control-Center.cmd` | 双击完成安装并打开总控台 | 从项目目录调用 PowerShell 部署器，失败时保留窗口和日志 |
| `Open-WebUI.cmd` / `Start-Bot.cmd` / `Stop-Bot.cmd` | 日常打开页面、静默启动和停止 | 调用固定脚本并保持工作目录正确 |
| `config/bot.json` | 实际服务器、模型、聊天、存储和日志参数 | 总控台将表单转换为 JSON；启动时严格校验后一次性载入 |
| `config/persona.json` | 实际 Bot 人设 | 每次模型请求把描述、说话风格、目标和边界放入系统上下文 |
| `config/prompts.json` | 完整系统/记忆/动作/空闲提示词 | 启动时读取，页面可编辑，模板再注入人设 |
| `config/skin.json` | 皮肤模型、路径和多人可见方式 | PNG 校验后保存本地副本或指导共同皮肤站配置 |
| `config/behavior-rules.json` | 实际安全规则 | LLM 动作执行前由 `PolicyEngine` 再审查，不能靠提示词绕过 |
| `config/mods.json` | 服务器 mod 来源和同步规则 | 启动前/按钮触发时与上次清单比较，受管理地替换 jar |
| `.env` | API Key 和 EasyAuth 密码 | 仅本机载入且被 Git 忽略；WebUI 只显示是否存在，不返回值 |
| `data/memory.json` | 所有长期记忆和玩家档案 | UUID 分玩家、限制事件数量、原子写入并保留 `.bak` |
| `data/experience.json` | 任务经验、失败与修正 | 与记忆独立，提示组装时按任务检索相关经验 |
| `data/tasks.json` | 持久任务队列和全部终态 | 保存发令者、优先级、尝试次数、真实结果；同进程重连与进程重启均可恢复孤立任务 |
| `data/autonomy-state.json` | 已验证住所位置 | Java 仅在门、光照、外壳和服务端状态全部确认后原子写入 |
| `data/bridge-token.txt` | Node 与 Java 的临时本机会话令牌 | 启动控制器生成；被 Git 忽略，不交给模型或玩家 |
| `data/runtime-status.json` | 当前游戏阶段、坐标、生命、背包等 | Fabric 每秒上报结构化状态，Node 原子落盘，WebUI 轮询读取 |
| `.runtime/minecraft/managed-mods.json` | 最近一次服务器 mod 同步清单 | 记录来源、时间、文件名、大小和 SHA-256，用于安全升级/删除 |
| `.runtime/skin-pack/Minecraft-AI-Skin-Pack.zip` | 给其他玩家安装的离线皮肤包 | 含官方万用皮肤加载器和按 Bot 名称放置的本地皮肤 |
| `logs/bot.log` | AI 控制器 JSONL 日志 | 每行一个结构化事件，递归脱敏 password/token/authorization |
| `.runtime/minecraft/logs/latest.log` | 原生客户端和 mod 日志 | Minecraft/Fabric 自身日志，用于排查注册表和模组崩溃 |

`config/*.example.json` 和 `.env.example` 是可提交的无秘密模板；同名非 example 文件才是本机实际设置。Node 控制器和直接双击启动的 Fabric 客户端都会读取 `.env`，已有进程环境变量优先；EasyAuth 密码按 `easyAuth.passwordEnv` 映射且不会输出。

### 程序源码与脚本

| 文件/目录 | 作用和原理 |
| --- | --- |
| `src/index.ts` | 后台控制器入口，加载配置并处理停止信号 |
| `src/config/types.ts` | 所有配置、规则、人设和推理强度的 TypeScript 契约 |
| `src/config/load-config.ts` | 读取 `.env`/JSON、校验必填值，进程环境变量优先于 `.env` |
| `src/llm/provider-factory.ts` | 用统一接口分别生成 DeepSeek/方舟 Chat Completions 与 OpenAI Responses 请求 |
| `src/llm/types.ts` | 模型请求/响应边界，使核心逻辑不绑定供应商 SDK |
| `src/agent/prompt.ts` | 旧 `prompts.json` 兼容提示词；新部署由 Markdown 工作区接管 |
| `src/agent/decision.ts` | 把模型 JSON 清洗成有限动作，未知动作降级为 `none` |
| `src/agent/basic-command.ts` | 在调用模型前把高置信度采集、放置、合成、交付和基础工具指令转换为确定性动作/顺序计划 |
| `src/agent/autonomous-development.ts` | 根据背包、附近资源、维度和持久进度选择求生、补充物资、制作工具或向末地推进 |
| `src/agent/agent-controller.ts` | 聊天→持久队列→模型→危险度准备→策略→真实动作结果/回复/记忆的主编排；停止指令走抢占通道 |
| `src/agent/addressing.ts` | 根据显式名称、`!`、玩家距离、语气和最近对话判断消息是否在叫 Bot |
| `src/agent/capability-assessor.ts` | 在动作前检查开关、目标、食物和装备门槛；逐格环境与玩家距离由 Fabric 硬检查 |
| `src/agent/world-state.ts` | 结构化世界状态，包括生命、物理环境、装备/附魔、实体、动作和住所 |
| `src/memory/memory-store.ts` | 单文件长期记忆、UUID 玩家隔离和事件裁剪 |
| `src/memory/context-compressor.ts` | 上下文接近预算时压缩旧事件，更新摘要和当前玩家 `USER.md` |
| `src/prompts/prompt-workspace.ts` | 管理五份 Markdown 提示词、分玩家画像和声明式行为补丁，限制运行时写入边界 |
| `src/self-improvement/self-improvement-manager.ts` | 聚合同类失败、可选检索公开资料，并只写受限经验段/声明式补丁 |
| `src/experience/experience-store.ts` | 独立经验文件及任务关键词检索 |
| `src/tasks/task-store.ts` | 原子任务 schema、owner/距离/紧急度排序、单运行任务、终态、取消和重连恢复 |
| `src/security/secret-guard.ts` | 在模型、持久化和游戏聊天出口拦截已知秘密、密钥形状及秘密提取请求 |
| `src/policy/policy-engine.ts` | 财产保护、未知归属拒绝、自卫攻击者与时间窗口验证 |
| `src/minecraft/fabric-bridge-client.ts` | 仅本机 TCP JSON Lines 服务，接收 Fabric 状态并发送带结果 ID 的白名单动作 |
| `src/minecraft/minecraft-client.ts` | Mineflayer 诊断适配器，不用于当前模组服正式运行 |
| `src/minecraft/easy-auth.ts` | Mineflayer 路线的认证提示处理；正式 Fabric 路线在 Java 模组中处理 |
| `src/runtime/bot-runtime.ts` | 创建模块、连接/关闭/重连循环并写运行阶段 |
| `src/runtime/status-store.ts` | 将 WebUI 所需实时状态原子保存到 `data/runtime-status.json` |
| `src/network/lan-discovery.ts` | 监听 224.0.2.60:4445、解析 LAN 世界动态地址和端口 |
| `src/skin/png.ts` | 校验 PNG 签名和 Minecraft 标准皮肤尺寸 |
| `src/core/atomic-json-file.ts` | 临时文件→备份→替换，避免断电留下半个 JSON |
| `src/core/logger.ts` | 后台 JSONL 日志和秘密脱敏 |
| `src/webui/server.ts` | 仅绑定 `127.0.0.1:3210` 的管理 API、静态文件、配置校验、启停、LAN、皮肤、记忆和模组同步；限制 Host/Origin/2 MiB 请求 |
| `public/webui/index.html` | 总控台信息架构和无障碍表单 |
| `public/webui/styles.css` | 不依赖外部 CDN 的响应式界面，适配桌面和窄屏 |
| `public/webui/app.js` | 读取状态、表单映射、保存、启停、同步、模型最小测试；不读取或回显秘密 |
| `fabric-bridge/.../MinecraftAiBridgeClient.java` | 在 Minecraft 内部主动连服、EasyAuth、动作互斥/超时结果、断桥取消、复活和各控制器调度 |
| `fabric-bridge/.../BridgeConnection.java` | Java 侧本机 JSON Lines 连接、重连和动作队列 |
| `fabric-bridge/.../LivingEntityDamageMixin.java` | 从真实伤害事件识别玩家攻击者，作为允许自卫的唯一依据 |
| `fabric-bridge/.../WorldStateEncoder.java` | 每秒输出 schema v2 的稳定物品 ID、槽位、耐久/附魔、装备、危险实体、光照和安全原因 |
| `fabric-bridge/.../SurvivalController.java` | 每 tick 的安全进食和确认威胁反击；只使用正常背包点击、使用物品和攻击 API |
| `fabric-bridge/.../PrimitiveTaskController.java` | 装备、物品、Bot 掉落、逐目标验证采集/放置和真实配方合成；以服务端同步后置条件结束 |
| `fabric-bridge/.../ShelterController.java` | 动态验证环境中的 3×3 住所、门/火把/外壳验证、住所原子保存及安全进入 |
| `fabric-bridge/src/main/resources/*` | Fabric 模组元数据和 Mixin 声明 |
| `fabric-bridge/build.gradle`、`gradle.properties` | 固定 MC 26.2、Loader 0.19.3、API、Loom、Java 25 和国内 Maven 回退 |
| `fabric-bridge/gradle/wrapper/*`、`gradlew*` | 固定且可校验的 Gradle 9.5.1 构建入口，不要求预装 Gradle |
| `scripts/install-windows.ps1` | 纯净 Windows 环境检查/安装及从源码到总控台的全流程部署 |
| `scripts/prefetch-minecraft-libraries.mjs` | 从 BMCLAPI/CERNET 计算当前平台所需 26.2 库并逐项验证官方 SHA-1 |
| `scripts/install-headlessmc.ps1` | 下载固定 HeadlessMc 2.10.0 并验证 SHA-256 |
| `scripts/prepare-fabric-client.ps1` | 组装隔离客户端、桥、固定 Fabric API 和服务器模组 |
| `scripts/sync-client-mods.mjs` | 清理上次受管理 jar、复制当前来源、生成 SHA-256 清单 |
| `scripts/audit-repository.mjs` | 扫描跟踪文件的 UTF-8、控制字符、乱码、JSON、秘密形状和受保护路径；只输出位置/计数，不回显秘密 |
| `scripts/build-skin-pack.ps1` | 在受限运行目录组装并压缩供其他客户端使用的离线皮肤包 |
| `scripts/apply-minecraft-data-26.2.mjs` | 给 Mineflayer 诊断栈补充经审查的 26.2 协议数据 |
| `scripts/start-*`、`stop-*` | WebUI、Node、Minecraft 的隐藏启动和精确 PID 停止，组合启动失败会回滚 |
| `src/probe.ts` | 不发言、不动作的 Mineflayer 握手诊断 |
| `test/*.test.ts` | 决策、记忆、经验、策略、脱敏、本机桥和后续回归测试 |
| `vendor/minecraft-data/26.2/*` | 固定上游提交的声明式协议 JSON，仅用于诊断 |
| `package.json` / `package-lock.json` / `tsconfig.json` | 固定 Node 依赖、命令和严格 TypeScript 构建 |
| `.npmrc` / `.gitignore` | npmmirror 默认源；排除秘密、数据、日志、构建和运行时目录 |
| `README.md` / `README_AI.md` / `PARAMETERS.md` | 人类教程、跨 Agent 续作档案、精确参数位置总表 |

## 所有参数存放位置

### `config/bot.json`

| JSON 路径 | 默认值 | 作用 |
| --- | --- | --- |
| `server.adapter` | `fabric_bridge` | 正式原生 Fabric 或诊断 Mineflayer |
| `server.connectionMode` | `direct` | 固定服务器或自动发现局域网世界 |
| `server.host` / `server.port` | `你的域名.com` / `25565` | 目标服务器 |
| `server.lanDiscoveryTimeoutMs` | `8000` | LAN 广播等待时间（250-60000ms） |
| `server.version` | `26.2` | Minecraft 协议/客户端版本 |
| `server.username` | `CialloAI` | 离线玩家名称，也是默认聊天提及词 |
| `server.auth` | `offline` | `online-mode:false` 使用 offline；Microsoft 尚未完成 |
| `server.connectTimeoutMs` | `30000` | Node 等待游戏桥的单次时间 |
| `server.reconnectDelayMs` | `10000` | 断开后的重试间隔 |
| `server.autoRespawn` | `true` | 死亡后自动向服务器请求复活 |
| `server.respawnDelayMs` | `3000` | 复活前等待时间；失败每 5 秒重试 |
| `server.bridgeHost` / `bridgePort` | `127.0.0.1` / `8765` | Java 与 Node 的本机控制通道；Host 必须为回环地址 |
| `server.actionTimeoutMs` | `10000` | 普通动作基础时限；长原语至少 120 秒、住所至少 180 秒，超时自动取消 Java 动作 |
| `easyAuth.enabled` | `true` | 是否启用服内登录 |
| `easyAuth.registerIfNeeded` | `true` | 新名称收到提示时是否允许注册 |
| `easyAuth.passwordEnv` | `MINECRAFT_LOGIN_PASSWORD` | 从哪个环境变量读取密码 |
| `easyAuth.loginDelayMs` | `1500` | Mineflayer 诊断路线等待时间；Fabric 使用提示优先/5 秒回退 |
| `model.provider` | `deepseek` | `deepseek`、`volcengine` 或 `openai` |
| `model.model` | `deepseek-v4-flash` | 实际模型名或方舟端点 ID |
| `model.apiKeyEnv` | `DEEPSEEK_API_KEY` | 当前供应商密钥变量名 |
| `model.baseUrl` | `https://api.deepseek.com` | API 根地址，可换兼容网关 |
| `model.reasoningEffort` | `high` | `none/low/medium/high/xhigh/max` |
| `model.timeoutMs` | `120000` | 单次模型请求超时；高推理建议至少 120 秒 |
| `model.maxOutputTokens` | `4096` | 单次最大生成量；同时约束推理内容，避免游戏决策长时间卡住 |
| `chat.requireMention` | `true` | 无充分近距离/连续对话语境时是否要求提到 Bot 或用 `!`；并非关闭语境判断 |
| `chat.replyPrefix` | 空 | 每次游戏回复前缀 |
| `chat.cooldownMs` | `2500` | 防止连续回复刷屏 |
| `chat.proactiveEnabled` | `true` | 是否启用限频的空闲模型决策与偶尔发言；关闭后本地生存反射仍运行 |
| `chat.proactiveIdleMs` | `180000` | 多久无玩家消息后允许一次空闲模型决策 |
| `chat.proactiveMinIntervalMs` | `300000` | 两次空闲模型决策的最小间隔，也限制其发言和 API 消耗 |
| `storage.memoryFile` | `data/memory.json` | 唯一长期记忆文件 |
| `storage.experienceFile` | `data/experience.json` | 独立经验文件 |
| `storage.taskFile` | `data/tasks.json` | 持久任务队列、优先级、尝试与终态 |
| `storage.autonomyFile` | `data/autonomy-state.json` | Java 确认后的住所位置和门坐标 |
| `storage.maxEvents` | `5000` | 长期事件最多保留数 |
| `autonomy.enabled` | `true` | 本地自主进食/防卫、安全挂机和空闲行为总开关；玩家明确动作仍可执行 |
| `autonomy.ownerName` | `wraaaaaa` | 离线服最高优先玩家名；先于距离规则 |
| `autonomy.commandArbitrationMs` | `350` | 收集近同时多人命令后再排序的窗口 |
| `autonomy.contextualAddressing` | `true` | 根据语气、距离和最近对话判断无点名消息 |
| `autonomy.directAddressDistance` | `8` | 无点名直接命令的近距离范围 |
| `autonomy.conversationWindowMs` | `60000` | 同一玩家自然续接对话的时间 |
| `autonomy.lowHealthThreshold` / `criticalHealthThreshold` | `10` / `6` | 进食与避免普通主动战斗的阈值 |
| `autonomy.eatBelowFood` / `hostileScanRadius` | `16` / `12` | 自主进食饱食阈值与威胁扫描距离 |
| `autonomy.wildernessMinPlayerDistance` | `48` | 采集/建房开始及运行期间与其他玩家的硬距离 |
| `autonomy.safeIdleEnabled` | `true` | 任务完成后寻找住所/安全点并停止等待 |
| `autonomy.autoGather/autoCraft/autoBuildShelter` | `true` | 允许规划对应原语，仍需安全前置条件 |
| `autonomy.allowVerifiedWilderness` | `true` | 允许 Fabric 对每个候选目标做动态环境/财产/危险/距离验证；关闭时拒绝世界修改 |
| `autonomy.developmentZone.*` | 已废弃 | 旧 `bot.json` 可保留但运行时忽略，WebUI 不再显示；不能授权或限制行为 |
| `agentWorkspace.promptDirectory` | `data/agent-prompts` | 五份运行时 Markdown 提示词和 `behavior-patches.json` |
| `agentWorkspace.playerProfilesDirectory` | `data/player-profiles` | 每位玩家单独目录中的 `USER.md` |
| `agentWorkspace.contextBudgetChars` | `48000` | 估算提示上下文字符预算 |
| `agentWorkspace.compressionTriggerRatio` | `0.72` | 达到预算比例后压缩旧记忆，范围 0.5–0.95 |
| `agentWorkspace.retainRecentEvents` | `16` | 压缩时保留当前玩家最近事件数 |
| `agentWorkspace.selfImprovement.*` | 见 `PARAMETERS.md` | 自我改进开关、托管提示词/声明式补丁权限、重复失败阈值、百度/SearXNG 与超时 |
| `policyFile` / `personaFile` / `promptsFile` | `config/...json` | 规则、人设和提示词路径；WebUI 只允许项目 config 内 |
| `logging.file` | `logs/bot.log` | JSONL 日志路径 |
| `logging.level` | `info` | `debug/info/warn/error` |
| `logging.console` | `false` | 是否同时输出控制台；静默后台建议 false |

### 其他设置文件

| 文件/路径 | 参数 |
| --- | --- |
| `config/persona.json` | `name` 名称、`description` 身份、`speakingStyle` 风格、`goals[]` 目标、`boundaries[]` 边界 |
| `config/behavior-rules.json` | `denyBreakingPlayerProperty`、`denyOpeningPlayerContainers`、`denyTakingPlayerItems`、`wildernessDevelopmentOnly`、`allowSelfDefense`、`selfDefenseWindowMs`、`stopSelfDefenseWhenThreatEnds`、`allowPlayerOrderedPvp`、`allowDestructiveActionsWhenOwnershipUnknown` 和 `proactiveChat.*` |
| `config/mods.json` | `sourceDirectory` 外部 mod 文件夹、`syncOnClientStart` 启动自动同步、`excludeFilePatterns[]` 文件名正则排除 |
| `config/prompts.json` | 旧版兼容提示词；新运行时以 `data/agent-prompts/*.md` 为准 |
| `config/agent-prompts.example/` | 新工作区首次启动模板；含五份全局 Markdown、`USER.md` 模板和行为补丁 schema |
| `config/skin.json` | `enabled`、`model`、`visibilityMode`、`skinFile`、`capeFile`、`onlineProvider.*` |

更完整的允许值、修改效果、记忆自动写入机制和全部运行文件位置见 [`PARAMETERS.md`](PARAMETERS.md)。
| `.env` | `MINECRAFT_LOGIN_PASSWORD`、`DEEPSEEK_API_KEY`、`ARK_API_KEY`、`OPENAI_API_KEY`；内容绝不提交 |
| 环境变量 | `MCAI_MINECRAFT_HOME`、`MCAI_MINECRAFT_LIBRARY_MIRROR`、`MCAI_BMCLAPI_BASE`、`MCAI_HEADLESSMC_DOWNLOAD_URL`、`MCAI_FABRIC_API_URL`、`MCAI_JAVA_HOME`、`MCAI_WEBUI_PORT` 可覆盖运行/下载位置 |

总控台保存“全部设置”时校验并写入 bot/persona/旧版 prompts/skin/behavior-rules/mods JSON，同时原子保存五份 Markdown 提示词；单独的玩家画像按钮只写选中玩家的 `USER.md`。“安全保存密钥”只写 `.env`。提示词会在每次模型决策前重新读取，本地直接编辑无需重启；配置项修改仍建议重启。

## 故障排查

**日志出现 `Received 611 registry entries that are unknown to this client`**

客户端缺少服务器模组。请在总控台设置服务器提供的客户端模组包来源并点“立即同步”；真实本机路径不要写入文档或提交。

**日志出现大量 `Missing sound` 或 `OpenAL 1.1 not supported`**

这是无界面模式使用虚拟资源/无音频设备的预期警告；声音系统会关闭，不影响文本、网络与结构化游戏控制。

**出现 Mojang Realms 401**

离线账号无法访问 Realms，目标服务器为 `online-mode:false`，该错误不阻断普通服务器连接。

**控制器提示等待 Fabric 桥超时**

确认客户端也已启动、桥接 jar 在 `.runtime\minecraft\mods`、端口 `127.0.0.1:8765` 未被其他程序占用。控制器会按配置自动重试。

**模型没有回复**

检查 API Key 环境变量、`config\bot.json` 的模型 ID/端点，以及 `logs\bot.log`。近距离且语句像直接指令时可以不点名；远距离、多人含糊聊天或明确叫其他人时不会触发。回复仍受默认 2.5 秒聊天冷却限制。

如果服务器聊天带称号并显示为 `<[称号]玩家名> 内容`，它可能通过 Minecraft 的系统消息通道到达。Fabric 桥会解析这一种受限格式、剥离连续方括号称号，并要求最终玩家名符合 `^[A-Za-z0-9_]{3,16}$` 后才交给 AI；与签名聊天在 1.5 秒内内容相同时自动去重。其他系统提示不会冒充玩家指令。

**移动/复制项目后，页面仍显示旧目录状态**

同一台电脑默认只能有一个控制台占用 `127.0.0.1:3210`。先在旧目录停止 Bot 和 WebUI，再从新目录双击 `Open-WebUI.cmd`。新版 PID 记录包含项目根目录，启动脚本也会核对进程命令行和端口归属；如果旧实例仍占用端口，会明确报错而不会打开旧页面。配置与秘密不会因复制源码自动迁移：新目录仍需检查 `config/*.json` 和被 Git 忽略的 `.env`。

如果游戏阶段持续更新但两个进程卡片显示“已停止”，旧版可能读取不了 Windows PowerShell 5 写入的带 UTF-8 BOM 的 PID JSON。新版 JSON 读取器会先剥离 BOM，并用项目根目录和 PID 双重核验进程；升级、重新构建并重启 WebUI 后即可恢复准确显示。

**客户端反复连接但始终进不了 EasyAuth 服务器**

先确认 Bot 游戏名匹配 `^[A-Za-z0-9_]{3,16}$`。EasyAuth 会直接拒绝包含 `-`、空格、中文或超过 16 位的离线名称；将连字符改为下划线后保存，并完整停止再启动 Bot。

**Bot 死亡后停在死亡界面**

确认 WebUI 的“死亡后自动复活”已开启，默认等待 3000 毫秒。Fabric 桥会停止残留移动、调用与原版死亡界面相同的复活接口并清除界面；服务器暂未响应时每 5 秒重试。死亡和复活结果同时写入 Bot 日志与记忆文件。旧配置没有这两个字段时仍默认开启并等待 3 秒。

**Bot 回复“我刚才处理失败了，稍后再试”**

先在 WebUI 点击“测试模型接口”。若最小测试成功而真人消息仍失败，查看 Bot 日志是否为 `TimeoutError`。V4 思考模式可能生成很长的推理内容；按照 [DeepSeek JSON Output 官方说明](https://api-docs.deepseek.com/guides/json_mode/)应合理设置输出上限。本项目默认把最大输出限制为 4096 Token，并把超时设为 120000 毫秒。可在“大模型”页面继续降低推理强度或调整这两个值。新版本遇到超时会明确回复“我这次思考超时了，请再说一次”。

## 测试状态

自动回归以当前工作树实际执行的 `npm test` 为准，测试数量会随覆盖范围变化。每次交付前都要重新运行 Node 测试、TypeScript 类型检查、生产构建、Fabric 完整 clean build、工作树审计与无效字符检查；自动测试通过不等于目标服务器已经接受每一种真实游戏动作。

当前真实环境已验证过 Fabric 26.2 进服、EasyAuth、模型最小请求、带称号聊天解析、自动复活、LAN 发现、皮肤加载链路与自动进食。本轮又在管理员明确授权的可丢弃测试场地验证了附近扫描、单方块采集与自有掉落、普通方块放置、背包 2×2 合成、Bot 自有工作台放置/3×3 合成、分段探索和 Node 重连后任务恢复。固定住所、复杂地形寻路、断线中途恢复及中国大陆无代理纯净 Windows 下载/安装仍需独立验收。

本轮修复了显式“吃东西”动作在食物已经消耗后仍停留于 `consuming_safe_food` 的完成判定：客户端现在先观察服务端同步后的物品种类/数量变化，再判断是否仍在使用物品。任何涉及世界修改的新动作仍必须在管理员授权的可丢弃场地现场验收，不能只凭自动测试和构建宣称可用。

## 开发与验证

```powershell
npm run check
npm test
npm run build
npm run probe
```

`probe` 使用 Mineflayer 做只读连接诊断，不适合作为该模组服的正式客户端。正式路线是 `fabric_bridge`。

针对更完整的游戏能力，项目已评估 Baritone、Mineflayer/collectblock、Voyager 和 Mindcraft。近期最值得投入的是把 Baritone 的公开 API 隔离在可选 Fabric 寻路适配层，collectblock 的“寻路→选工具→挖掘→收掉落”作为状态机参考，Voyager 的技能库/自验证用于持久任务规划。它们目前公开的 Minecraft 版本或运行方式都不能直接替代本项目的 26.2 模组客户端，所以本轮没有直接下载不兼容 jar 或开启模型生成代码；完整版本、许可证、安全性和接入顺序见 `README_AI.md` 第 21.1 节。

每次变更必须同步更新本文档和 `README_AI.md`。提交前还应运行 Fabric 构建、`git diff --check`、秘密扫描和相关真实环境测试。远端为 `https://github.com/wraaaaaa/Minecraftaiplayer.git`，默认分支 `main`。

## 2026-08-05 基础采集、合成、放置与主动探索更新

当前本地候选版已不再把简单基础玩法完全交给大模型判断。玩家说“挖掘三个石头”“采集材料”“随便放一个方块”“合成四个木板”或“吃东西”时，`src/agent/basic-command.ts` 会先按聊天内容、背包和附近方块扫描生成确定动作；只有无法可靠判断的复杂请求才调用大模型。这既减少 API 消耗，也避免模型错误回答“动作列表没有该选项”。

使用前确认 WebUI“自主能力与安全”中的“允许 Fabric 动态环境验证”已开启。AI 根据附近结构化状态决定去哪里，Fabric 在执行时逐目标判断；不再填写任何人工坐标范围。关闭此开关会直接拒绝采集、放置、开矿和建房。

运行时会把 Bot 周围半径 8 格、上下 5 格的已加载方块摘要写入 `data/runtime-status.json` 的 `world.blockSurvey`。`resources` 是原木、石头、泥土和矿物等自然资源；`artificial` 是门、木板、楼梯、玻璃、箱子、工作台、灯等疑似人造内容；`classification` 为 `natural_terrain_likely`、`protected_structure_nearby` 或 `uncertain`。自动行为不靠图片或声音，仍完全使用这一结构化状态和正常客户端动作。

当前可真实执行：

- `gather_resource`：在动态验证的已加载候选中准备最佳工具、正常挖掘、等待服务器确认变化，并验证掉落已登记或已自动进入背包。发令玩家本人可在旁监督，其他玩家进入安全半径仍会取消动作。
- `craft_item`：合成已解锁且材料足够的配方。2×2 使用背包菜单；3×3 只寻找 8 格内账本确认属于 Bot 的已加载工作台，再正常打开菜单、执行配方并验证产物。
- `place_block`：从安全白名单材料中选择，逐候选检查玩家结构、方块实体、碰撞、支撑、危险和撤退路线，使用正常多人交互并等待服务器确认。
- 主动发展：安全且无玩家任务时，确定性规划器从食物、设施、工具和住所继续到铁/钻石、下界和末地；移动使用有界 A* 和分段探索，难以绕开的天然障碍可在逐块验证后开路。

多人消息仍进入同一持久任务队列逐条执行；`wraaaaaa` 最高优先，其余玩家按实时距离、紧急度和先后顺序仲裁。每条定向回复现在固定带 `@玩家名`，避免多人同时聊天时看不出回复对象。

本轮已在授权的 5×5×5 子测试区完成真实服务器验证：方块扫描识别为天然地形；单次挖掘只完成 1 个石头并收取 1 个自有掉落；放置动作由服务器确认 1 个方块出现；木板从 4 增至 8；随后依次确认合成 4 个木棍、放置 1 个工作台、使用真实工作台 3×3 配方合成 1 把木镐。自动测试以当前 `npm test` 输出为准，不在文档中固定总数。

`README_AI.md` 是完整技术交接源，现已逐项记录主/旧工作目录、启动与重连时序、Fabric JSONL v1 每类消息和动作、模型请求参数、提示词上下文、策略实际接线范围、记忆/经验 schema 与恢复方式、WebUI 全部 API、安全边界、Windows PID 所有权、迁移/灾难恢复、测试矩阵、已知缺口和 Git 推送流程。更换账号或 Agent 时，应先完整阅读该文件，再以当前源码和 `git status/log` 核对文档快照。

## 兼容范围与许可证

- 当前完整部署脚本针对 Windows/Windows Server；核心 Node 和 Java 代码可移植，但 Linux 无界面服务脚本尚未提供。
- Simple Voice Chat `fabric-2.6.20+26.2` 已随服务器模组成功握手并请求语音 secret；Headless 环境没有 OpenAL 设备，日志显示 `Speaker unavailable`，因此当前只有兼容进服、没有收发语音能力。文本与结构化游戏控制不受影响。
- 2026-08-04 的安装、下载和进服测试均在用户开启全局美国 VPN 的电脑完成，不能作为中国大陆无代理可用性的证明；“国内镜像路径已实现”与“无代理正式验收”必须区分。
- 项目许可证尚未确定，暂不应把仓库内容视为已授予开源再分发许可。引入第三方内容前继续核对其许可证。
