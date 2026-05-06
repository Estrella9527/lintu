import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, writeFileSync, watch as fsWatch, type FSWatcher } from 'fs'
import { spawn, execSync, type ChildProcess } from 'child_process'

const isDev = !app.isPackaged
const isWin = process.platform === 'win32'
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
    if (isWin) {
      // netstat -ano lists "  TCP  127.0.0.1:7879  ...  LISTENING  <PID>"
      const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' })
      const pids = new Set<string>()
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/.test(line)) continue
        if (!new RegExp(`[:.]${SIDECAR_PORT}\\b`).test(line)) continue
        const pid = line.trim().split(/\s+/).pop()
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
      }
      for (const pid of pids) {
        console.log(`[sidecar] killing stale process on port ${SIDECAR_PORT}: pid ${pid}`)
        try { execSync(`taskkill /F /PID ${pid}`) } catch { /* already gone */ }
      }
    } else {
      const pid = execSync(`lsof -ti :${SIDECAR_PORT}`, { encoding: 'utf8' }).trim()
      if (pid) {
        console.log(`[sidecar] killing stale process on port ${SIDECAR_PORT}: pid ${pid}`)
        execSync(`kill -9 ${pid}`)
      }
    }
  } catch {
    // No process on port — good
  }
}

function findUvBin(): string | null {
  // uv installs into ~/.local/bin on macOS/Linux and %USERPROFILE%\.local\bin on Windows.
  // Pip-installed uv lands in <Python>/Scripts on Windows.
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = isWin
    ? [
        join(home, '.local', 'bin', 'uv.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'Scripts', 'uv.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'Scripts', 'uv.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'uv.exe'),
      ]
    : [join(home, '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function startSidecar() {
  killPortOccupant()
  const sidecarDir = isDev
    ? join(__dirname, '../../sidecar')
    : join(process.resourcesPath, 'sidecar')

  console.log(`[sidecar] cwd: ${sidecarDir}`)

  if (isDev) {
    // Dev: use `uv run uvicorn ...`
    const uvBin = findUvBin()
    if (!uvBin) {
      dialog.showErrorBox(
        '启动失败',
        '未找到 uv（Python 包管理器）。请安装 uv：\n\n' +
          '  macOS / Linux: curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
          '  Windows:        irm https://astral.sh/uv/install.ps1 | iex',
      )
      app.quit()
      return
    }
    console.log(`[sidecar] launching: ${uvBin} run uvicorn ...`)
    pyProcess = spawn(
      uvBin,
      ['run', 'uvicorn', 'sidecar.main:app', '--port', String(SIDECAR_PORT), '--host', '127.0.0.1'],
      {
        cwd: sidecarDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        shell: false,
      },
    )
  } else {
    // Prod: use PyInstaller-bundled sidecar binary.
    // Layout: <resources>/sidecar/sidecar(.exe)  + <resources>/sidecar/_internal/
    const sidecarBin = join(sidecarDir, isWin ? 'sidecar.exe' : 'sidecar')
    console.log(`[sidecar] launching bundled: ${sidecarBin}`)
    pyProcess = spawn(
      sidecarBin,
      ['--port', String(SIDECAR_PORT), '--host', '127.0.0.1'],
      {
        cwd: sidecarDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        // Hide stray console window on Windows
        windowsHide: true,
      },
    )
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

async function waitForSidecar(timeout = 90000): Promise<boolean> {
  // 90s default — first launch on Windows runs every Alembic migration from
  // baseline against a fresh SQLite DB, which can take 20-40s on slow disks.
  // Subsequent launches hit /health within ~2s.
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

// ── Auto-update (path C: silent check + silent download + restart prompt) ──
//
// Boot timeline:
//   t=0      app.whenReady → spawn sidecar → wait for /health
//   t=ready  open main window
//   t+10s    autoUpdater.checkForUpdates() — quiet check, no UI noise
//   t+~30s   if update available, download finishes silently in background
//   t+done   notify renderer; user sees a corner toast with [立即重启 / 稍后]
//   on quit  if user dismissed the toast, NSIS upgrades on app exit anyway
//
// Disabling in dev because checking against an OSS URL when running locally
// against vite is just noise.

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = {
  info:  (m: string) => console.log('[updater]', m),
  warn:  (m: string) => console.warn('[updater]', m),
  error: (m: string) => console.error('[updater]', m),
  debug: (_m: string) => {},
}

function notifyUpdater(event: string, payload?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`updater:${event}`, payload)
  }
}

autoUpdater.on('checking-for-update',  () =>     notifyUpdater('checking'))
autoUpdater.on('update-available',     (info) => notifyUpdater('available', info))
autoUpdater.on('update-not-available', (info) => notifyUpdater('not-available', info))
autoUpdater.on('download-progress',    (p) =>    notifyUpdater('progress', p))
autoUpdater.on('update-downloaded',    (info) => notifyUpdater('downloaded', info))
autoUpdater.on('error',                (e) =>    notifyUpdater('error', e?.message ?? String(e)))

ipcMain.handle('updater:check',  async () => {
  if (isDev) return { ok: false, reason: 'dev mode' }
  try {
    const result = await autoUpdater.checkForUpdates()
    return { ok: true, version: result?.updateInfo?.version }
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) }
  }
})

ipcMain.handle('updater:quit-and-install', () => {
  // isSilent=true skips the NSIS UI; isForceRunAfter=true relaunches us.
  autoUpdater.quitAndInstall(true, true)
})

ipcMain.handle('app:get-version', () => app.getVersion())

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

  // Kick off the silent update check 10s after window opens. Avoid checking
  // immediately at startup — the first impression is "app is loading", users
  // shouldn't see "downloading update" before they see the home screen.
  if (!isDev) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((e) =>
        console.warn('[updater] background check failed:', e?.message ?? e),
      )
    }, 10_000)
  }

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
