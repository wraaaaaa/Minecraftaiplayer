# Vendored Minecraft 26.2 protocol data

本目录仅保存 Minecraft Java Edition 26.2 的协议与版本数据，用于弥补当前 npm 版 `minecraft-data` 尚未发布完整 26.2 数据的问题。

- 上游项目：`https://github.com/PrismarineJS/minecraft-data`
- 上游 PR：`https://github.com/PrismarineJS/minecraft-data/pull/1198`
- 固定提交：`e4920932925f159c0c62b54b5cf07155669064e5`
- `26.2/protocol.json` SHA-256：`E5D14CB4F9C8B027AA6792804680020BE1CB5A24DD42DC553711E28A84A1A986`
- `26.2/version.json` SHA-256：`E4A731EFDC228A6DAFD61EB842E8EB76F9D6B766979254D743E161B86D7C1D0C`

安全审查结论：所采用提交只包含声明式 JSON/YAML 协议数据和索引变化，不包含安装脚本或可执行代码。本项目未采用同一实验 PR 中会打印完整数据包、动态写入依赖代码的临时 ProtoDef 调试补丁。

当前数据补丁沿用上游 PR 的策略：26.2 网络协议使用专用数据，方块、物品等高层数据暂时映射至 1.21.11。它的目标是先验证登录与基本动作，不代表所有 26.2 方块/物品数据已经准确。

安装脚本还将 `prismarine-chunk` 和 `prismarine-physics` 已存在的 26.1 实现显式复用于 26.2。这些修改仅扩展版本映射，不引入新的网络、文件或命令执行代码；是否与正式服务器完全兼容必须以连接探针和动作测试为准。
