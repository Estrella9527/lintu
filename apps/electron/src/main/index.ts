import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'path'
import { mkdirSync, writeFileSync, watch as fsWatch, type FSWatcher } from 'fs'
import { spawn, execSync, type ChildProcess } from 'child_process'

const isDev = !app.isPackaged
const SIDECAR_PORT = 7879

let mainWindow: BrowserWindow | null = null

function notifyRenderer(event: string, payload?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, payload)
  }
}

// ── Sidecar management ──

let pyProcess: ChildProcess | null = null

function killPortOccupant() {
  try {
    const pid = execSync(`lsof -ti :${SIDECAR_PORT}`, { encoding: 'utf8' }).trim()
    if (pid) {
      console.log(`[sidecar] killing stale process on port ${SIDECAR_PORT}: pid ${pid}`)
      execSync(`kill -9 ${pid}`)
    }
  } catch {
    // No process on port — good
  }
}

function startSidecar() {
  killPortOccupant()
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
  killPortOccupant()
}

// ── Dev hot-reload: watch sidecar python files and restart on change ──
//
// uvicorn --reload would also work but it's noisy and re-imports break our
// shared schedulers (BatchScheduler, OssSyncWorker). Doing the kill+restart
// at the process level is cleaner: in-flight requests die fast, schedulers
// re-init from DB cleanly.

let watcher: FSWatcher | null = null
let restartTimer: NodeJS.Timeout | null = null
let restarting = false

function debouncedRestart() {
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(async () => {
    if (restarting) return
    restarting = true
    notifyRenderer('lintu:sidecar-restarting', { reason: 'source-change' })
    console.log('[sidecar] source changed — restarting...')
    stopSidecar()
    await new Promise((r) => setTimeout(r, 500))
    startSidecar()
    const ready = await waitForSidecar(20000)
    notifyRenderer('lintu:sidecar-ready', { ok: ready })
    console.log(ready ? '[sidecar] restart complete' : '[sidecar] restart timed out')
    restarting = false
  }, 800)  // debounce — many editors save 2-3 files per CMD+S
}

function watchSidecarSources() {
  if (!isDev) return
  const sidecarRoot = join(__dirname, '../../sidecar/sidecar')
  try {
    watcher = fsWatch(sidecarRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      // Ignore byte-code, pycache, hidden files, transient swap files
      if (
        filename.endsWith('.pyc') ||
        filename.includes('__pycache__') ||
        filename.startsWith('.') ||
        filename.endsWith('~') ||
        filename.endsWith('.swp')
      ) return
      // Only react to .py changes (alembic migrations, models, routers, engines)
      if (!filename.endsWith('.py')) return
      console.log(`[sidecar-watch] ${filename}`)
      debouncedRestart()
    })
    console.log(`[sidecar-watch] watching ${sidecarRoot} (recursive)`)
  } catch (e) {
    console.warn('[sidecar-watch] fs.watch failed:', e)
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

ipcMain.handle('download-file', async (_event, url: string, filename: string) => {
  const result = await dialog.showSaveDialog({
    defaultPath: filename,
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePath) return null
  try {
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())
    writeFileSync(result.filePath, buffer)
    return result.filePath
  } catch (e) {
    console.error('[download]', e)
    return null
  }
})

ipcMain.handle('save-file-to-path', async (_event, url: string, absolutePath: string) => {
  // Bulk-mode helper: caller already chose a target directory (via
  // select-directory). We download the URL bytes and write them to the
  // exact path given — NO save dialog. This is what powers "select N
  // images → download" without surfacing N native pickers.
  try {
    mkdirSync(dirname(absolutePath), { recursive: true })
    const res = await fetch(url)
    if (!res.ok) {
      console.error('[save-file-to-path] fetch failed', url, res.status)
      return null
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    writeFileSync(absolutePath, buffer)
    return absolutePath
  } catch (e) {
    console.error('[save-file-to-path]', e)
    return null
  }
})

ipcMain.handle('open-file', async (_event, filePath: string) => {
  shell.openPath(filePath)
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
  mainWindow = createMainWindow()
  watchSidecarSources()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('will-quit', () => {
  if (watcher) { watcher.close(); watcher = null }
  stopSidecar()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
