import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'

const isDev = !app.isPackaged
const SIDECAR_PORT = 7879

// ── Sidecar management ──

let pyProcess: ChildProcess | null = null

function startSidecar() {
  const sidecarDir = isDev
    ? join(__dirname, '../../sidecar')
    : join(process.resourcesPath, 'sidecar')

  console.log(`[sidecar] cwd: ${sidecarDir}`)

  if (isDev) {
    // Dev: use uv run uvicorn
    const uvBin = (process.env.HOME || '') + '/.local/bin/uv'
    console.log(`[sidecar] launching: ${uvBin} run uvicorn ...`)
    pyProcess = spawn(uvBin, ['run', 'uvicorn', 'sidecar.main:app', '--port', String(SIDECAR_PORT), '--host', '127.0.0.1'], {
      cwd: sidecarDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      shell: false,
    })
  } else {
    // Prod: use bundled python
    const pythonBin = join(sidecarDir, 'python')
    pyProcess = spawn(pythonBin, ['-m', 'uvicorn', 'sidecar.main:app', '--port', String(SIDECAR_PORT)], {
      cwd: sidecarDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
  }

  pyProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[sidecar] ${data.toString().trim()}`)
  })

  pyProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[sidecar] ${data.toString().trim()}`)
  })

  pyProcess.on('exit', (code) => {
    console.log(`[sidecar] exited with code ${code}`)
    pyProcess = null
  })
}

function stopSidecar() {
  if (pyProcess) {
    pyProcess.kill('SIGTERM')
    pyProcess = null
  }
}

async function waitForSidecar(timeout = 15000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${SIDECAR_PORT}/health`)
      if (res.ok) return true
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// ── Window management ──

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f9f9fa',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, 'renderer/index.html'))
  }

  return win
}

// ── IPC handlers ──

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

// ── App lifecycle ──

app.whenReady().then(async () => {
  startSidecar()

  const ready = await waitForSidecar()
  if (!ready) {
    dialog.showErrorBox('启动失败', 'Python 后台服务启动超时，请检查环境配置。')
    app.quit()
    return
  }

  console.log('[main] Sidecar ready')
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('will-quit', () => {
  stopSidecar()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
