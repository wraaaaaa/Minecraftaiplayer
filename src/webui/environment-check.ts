import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { parseJsonDocument } from '../core/json.js'
import { userDataPath } from '../core/user-data.js'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(process.cwd())

export interface EnvironmentCheckItem {
  id: string
  label: string
  status: 'pass' | 'fail' | 'warn'
  detail: string
}

export interface EnvironmentCheckResult {
  ok: boolean
  summary: string
  items: EnvironmentCheckItem[]
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}

async function readJson<T>(file: string): Promise<T> {
  // PID/状态文件可能由 PowerShell 5.1 写成带 UTF-8 BOM 的 JSON，先剥离 BOM 再解析。
  return parseJsonDocument<T>(await readFile(file, 'utf8'))
}

async function globFirst(dir: string, predicate: (name: string) => boolean): Promise<string | undefined> {
  try { return (await readdir(dir)).find(predicate) } catch { return undefined }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function portListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ port, host })
    socket.setTimeout(600, () => { socket.destroy(); resolve(false) })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

function item(id: string, label: string, status: EnvironmentCheckItem['status'], detail: string): EnvironmentCheckItem {
  return { id, label, status, detail }
}

export async function runEnvironmentCheck(): Promise<EnvironmentCheckResult> {
  const items: EnvironmentCheckItem[] = []

  const nodeVersion = process.version
  const nodeMajor = Number.parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10)
  items.push(item('node', 'Node.js 版本', nodeMajor >= 22 ? 'pass' : 'fail', nodeVersion + (nodeMajor >= 22 ? '' : '（需要 >= 22）')))

  try {
    const { stdout, stderr } = await execFileAsync('java', ['-version'], { windowsHide: true })
    const text = stderr + '\n' + stdout
    const version = text.match(/version "([^"]+)"/u)?.[1] ?? text.split(/\r?\n/u)[0] ?? ''
    const major = Number.parseInt(version.replace(/^1\./u, '').split('.')[0] ?? '0', 10)
    items.push(item('java', 'Java 运行时', major >= 25 ? 'pass' : major >= 21 ? 'warn' : 'fail', version + (major >= 25 ? '' : '（建议 >= 25）')))
  } catch {
    items.push(item('java', 'Java 运行时', 'fail', '未在 PATH 找到 java'))
  }

  const javaHome = process.env.JAVA_HOME
  items.push(item('java_home', 'JAVA_HOME（构建）', javaHome ? 'pass' : 'warn', javaHome ?? '未设置；Gradle 构建需手动指定 JDK 25/26'))

  const modsDir = path.join(projectRoot, '.runtime', 'minecraft', 'mods')
  const bridgeJar = await globFirst(modsDir, name => name.startsWith('minecraft-ai-fabric-bridge-') && name.endsWith('.jar'))
  items.push(item('bridge_jar', 'Fabric 桥 jar', bridgeJar ? 'pass' : 'fail', bridgeJar ?? '未找到'))
  const fabricApi = await globFirst(modsDir, name => name.startsWith('fabric-api-') && name.endsWith('.jar'))
  items.push(item('fabric_api', 'Fabric API jar', fabricApi ? 'pass' : 'fail', fabricApi ?? '未找到'))
  const headlessJar = await globFirst(path.join(projectRoot, '.runtime', 'headlessmc'), name => name.startsWith('headlessmc-launcher-') && name.endsWith('.jar'))
  items.push(item('headlessmc', 'HeadlessMC 启动器', headlessJar ? 'pass' : 'fail', headlessJar ?? '未找到'))

  const mcDir = path.join(projectRoot, '.runtime', 'minecraft')
  const hasMcAssets = await exists(path.join(mcDir, 'versions')) || await exists(path.join(mcDir, 'assets'))
  items.push(item('mc_assets', 'Minecraft 客户端资源', hasMcAssets ? 'pass' : 'warn', hasMcAssets ? '已准备' : '未完成 prefetch'))

  const hasManifest = await exists(path.join(mcDir, 'managed-mods.json'))
  items.push(item('mods_manifest', '模组同步清单', hasManifest ? 'pass' : 'warn', hasManifest ? '已生成' : '尚未同步模组'))

  const configFile = userDataPath('config', 'bot.json')
  const hasConfig = await exists(configFile)
  items.push(item('config', '用户配置', hasConfig ? 'pass' : 'fail', hasConfig ? 'userdata/config/bot.json' : '缺少 userdata/config/bot.json'))

  const hasEnv = await exists(userDataPath('.env'))
  items.push(item('env', '密钥配置', hasEnv ? 'pass' : 'fail', hasEnv ? '已配置（内容不回显）' : '缺少 userdata/.env'))

  const hasModules = await exists(path.join(projectRoot, 'node_modules'))
  items.push(item('modules', '依赖安装', hasModules ? 'pass' : 'fail', hasModules ? 'node_modules 已安装' : '请运行 npm install'))

  const hasMcData = await exists(path.join(projectRoot, 'vendor', 'minecraft-data', '26.2', 'version.json'))
  items.push(item('mc_data', '游戏数据', hasMcData ? 'pass' : 'fail', hasMcData ? 'vendor/minecraft-data/26.2' : '缺少 26.2 数据'))

  const bot = await readJson<{ pid?: number }>(userDataPath('data', 'bot.pid.json')).catch(() => null)
  const botAlive = bot?.pid !== undefined && processAlive(bot.pid)
  items.push(item('bot_proc', 'Bot 进程', botAlive ? 'pass' : 'warn', botAlive ? 'PID ' + bot.pid : '未运行'))

  const client = await readJson<{ pid?: number }>(userDataPath('data', 'minecraft-client.pid.json')).catch(() => null)
  const clientAlive = client?.pid !== undefined && processAlive(client.pid)
  items.push(item('client_proc', '客户端进程', clientAlive ? 'pass' : 'warn', clientAlive ? 'PID ' + client.pid : '未运行'))

  items.push(item('bridge_port', '桥接端口 8765', await portListening(8765) ? 'pass' : 'warn', '127.0.0.1:8765'))
  const webUiPort = Number.parseInt(process.env.MCAI_WEBUI_PORT ?? '3210', 10)
  items.push(item('webui_port', `WebUI 端口 ${webUiPort}`, await portListening(webUiPort) ? 'pass' : 'warn', `127.0.0.1:${webUiPort}`))

  const failures = items.filter(entry => entry.status === 'fail').length
  const warnings = items.filter(entry => entry.status === 'warn').length
  const ok = failures === 0
  const summary = ok
    ? '环境正常' + (warnings > 0 ? '（' + warnings + ' 项警告）' : '')
    : '发现 ' + failures + ' 项问题' + (warnings > 0 ? '、' + warnings + ' 项警告' : '')
  return { ok, summary, items }
}
