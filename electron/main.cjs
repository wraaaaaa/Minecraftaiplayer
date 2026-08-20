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
  const entry = path.join(projectRoot, 'dist', 'src', 'webui', 'server.js')
  try {
    spawn('node', [entry], { cwd: projectRoot, stdio: 'ignore', detached: true, windowsHide: true }).unref()
  } catch { /* 后端未构建时静默，由页面报错 */ }
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
