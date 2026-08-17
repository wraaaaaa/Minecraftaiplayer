import { loadProjectConfig } from './config/load-config.js'
import { queryServerStatus } from './network/server-status.js'
import { setTimeout as delay } from 'node:timers/promises'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { userDataPath } from './core/user-data.js'

// 用于服务器列表 Ping 握手的 Minecraft 26.2 协议版本。
const PROTOCOL_VERSION = 776

interface PlayerMonitorState {
  humanSeenAt: number | null
  zeroSince: number | null
  botOnline: boolean
  lastPollAt: number
  lastOnlineAt: number | null
  lastOfflineAt: number | null
}

const projectRoot = process.cwd()
const stateFile = userDataPath('data', 'player-monitor-state.json')
const testFlagFile = userDataPath('data', 'test-mode.flag')
// Minecraft 客户端才是真正加入服务器并占用玩家槽位的进程；
// 判断是否要减去 Bot 时，应检查它的 pid（而不是 Node 控制器的 pid）。
const botPidFile = userDataPath('data', 'minecraft-client.pid.json')

function log(message: string): void {
  console.log('[' + new Date().toISOString() + '] ' + message)
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function botOnline(): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(botPidFile, 'utf8')) as { pid?: number }
    return processAlive(record.pid ?? -1)
  } catch { return false }
}

async function testMode(): Promise<boolean> {
  return exists(testFlagFile)
}

function runScript(script: 'start-all-background.ps1' | 'stop-all-background.ps1'): void {
  const scriptPath = path.join(projectRoot, 'scripts', script)
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    cwd: projectRoot,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', (error) => log('运行脚本失败 ' + script + ': ' + String(error)))
}

async function readState(): Promise<PlayerMonitorState> {
  try {
    const raw = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<PlayerMonitorState>
    return {
      humanSeenAt: typeof raw.humanSeenAt === 'number' ? raw.humanSeenAt : null,
      zeroSince: typeof raw.zeroSince === 'number' ? raw.zeroSince : null,
      botOnline: raw.botOnline === true,
      lastPollAt: typeof raw.lastPollAt === 'number' ? raw.lastPollAt : 0,
      lastOnlineAt: typeof raw.lastOnlineAt === 'number' ? raw.lastOnlineAt : null,
      lastOfflineAt: typeof raw.lastOfflineAt === 'number' ? raw.lastOfflineAt : null
    }
  } catch {
    return { humanSeenAt: null, zeroSince: null, botOnline: false, lastPollAt: 0, lastOnlineAt: null, lastOfflineAt: null }
  }
}

async function writeState(state: PlayerMonitorState): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true })
  const temporary = stateFile + '.tmp'
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  try { await rename(temporary, stateFile) }
  catch { await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8') }
}

async function main(): Promise<void> {
  const loaded = await loadProjectConfig()
  const config = loaded.config
  const monitor = config.playerMonitor
  if (!monitor?.enabled) {
    log('playerMonitor.enabled 未开启，监听进程退出。')
    return
  }
  const host = config.server.host
  const port = config.server.port
  const pollIntervalMs = monitor.pollIntervalMs ?? 15_000
  const onlineAfterMs = monitor.onlineAfterMs ?? 60_000
  const offlineAfterMs = monitor.offlineAfterMs ?? 30 * 60_000
  const timeoutMs = monitor.statusTimeoutMs ?? 5_000
  log('玩家监听已启动：' + host + ':' + port + '，轮询间隔 ' + pollIntervalMs + 'ms，上线延迟 ' + onlineAfterMs + 'ms，下线延迟 ' + offlineAfterMs + 'ms')

  let state = await readState()
  while (true) {
    const now = Date.now()
    const online = await botOnline()
    if (online !== state.botOnline) { state.botOnline = online; await writeState(state) }
    try {
      if (await testMode()) {
        log('检测到测试模式标志，跳过自动上下线管理。')
        await delay(pollIntervalMs)
        continue
      }
      const status = await queryServerStatus(host, port, PROTOCOL_VERSION, timeoutMs)
      const humans = Math.max(0, status.online - (online ? 1 : 0))
      log('在线 ' + status.online + '/' + status.max + '，人类玩家 ' + humans + '，AI ' + (online ? '在线' : '离线'))

      if (humans >= 1) {
        state.humanSeenAt = state.humanSeenAt ?? now
        state.zeroSince = null
        if (!online && state.humanSeenAt !== null && now - state.humanSeenAt >= onlineAfterMs) {
          log('检测到人类玩家已在线 ' + Math.round((now - state.humanSeenAt) / 1000) + ' 秒，AI 自动上线。')
          runScript('start-all-background.ps1')
          state.lastOnlineAt = now
          state.humanSeenAt = null
        }
      } else {
        state.zeroSince = state.zeroSince ?? now
        state.humanSeenAt = null
        if (online && state.zeroSince !== null && now - state.zeroSince >= offlineAfterMs) {
          log('检测到无人类玩家已持续 ' + Math.round((now - state.zeroSince) / 1000) + ' 秒，AI 自动下线。')
          runScript('stop-all-background.ps1')
          state.lastOfflineAt = now
          state.zeroSince = null
        }
      }
      state.lastPollAt = now
      await writeState(state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log('状态查询失败：' + detail)
    }
    await delay(pollIntervalMs)
  }
}

main().catch((error) => {
  log('监听进程异常退出：' + (error instanceof Error ? error.stack ?? error.message : String(error)))
  process.exitCode = 1
})
