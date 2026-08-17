import path from 'node:path'

/**
 * 每个安装、用户专属文件的统一根目录：密钥（.env）、皮肤图片、
 * 个性化设置、玩家画像、AI 提示词文档、记忆、经验和
 * 自我学习状态。此文件夹下的所有内容都可以整体迁移到项目的
 * 新版本，个人数据会原封不动地随之迁移。
 *
 * 当该文件夹必须位于工作区之外（例如在共享驱动器上）时，
 * 可用 MCAI_USERDATA_DIR 覆盖其位置。
 */
const projectRoot = path.resolve(process.cwd())
export const USER_DATA_ROOT = path.resolve(process.env.MCAI_USERDATA_DIR?.trim() || path.join(projectRoot, 'userdata'))

/** 解析用户数据根目录下的一个或多个路径段。 */
export function userDataPath(...segments: string[]): string {
  return path.resolve(USER_DATA_ROOT, ...segments)
}

/**
 * 按配置文件所指定的方式解析路径。相对值会相对于
 * 用户数据根目录解析（因此 `data/memory.json` 会变成 `userdata/data/memory.json`）；
 * 绝对值保持不变。
 */
export function resolveUserData(configured: string): string {
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(USER_DATA_ROOT, configured)
}

export function projectPath(...segments: string[]): string {
  return path.resolve(projectRoot, ...segments)
}
