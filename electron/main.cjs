const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { createConnection } = require('node:net')

const HOST = '127.0.0.1'
const PORT = 3210
const projectRoot = path.resolve(__dirname, '..')

function portOpen() {
  return new Promise(resolve => {
    const socket = createConnection({ host: HOST, port: PORT })
    socket.setTimeout(400, () => { socket.destroy(); resolve(false) })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

async function ensureServer() {
  if (await portOpen()) return
  // 复用 start-webui-background.ps1：自带 PID 跟踪与 stdout/stderr 日志，避免无日志孤儿进程。
  const script = path.join(projectRoot, 'scripts', 'start-webui-background.ps1')
  try {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: projectRoot, stdio: 'ignore', detached: true, windowsHide: true }).unref()
  } catch { /* 启动失败由下方端口探测超时兜底 */ }
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 300))
    if (await portOpen()) return
  }
}

let mainWindow
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })
  app.whenReady().then(async () => {
    await ensureServer()
    mainWindow = new BrowserWindow({
      width: 1360, height: 900, title: 'Minecraft AI 总控台',
      autoHideMenuBar: true, backgroundColor: '#edf1fb',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    mainWindow.setMenuBarVisibility(false)
    mainWindow.loadURL('http://' + HOST + ':' + PORT)
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
    mainWindow.on('closed', () => { mainWindow = null })
  })
  app.on('window-all-closed', () => app.quit())
}
