import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from 'fs'
import { spawn, execSync, execFile, type ChildProcess } from 'child_process'

const isDev = !app.isPackaged
const isWin = process.platform === 'win32'
const SIDECAR_PORT = 7879

/**
 * Build flavor — baked at compile time via esbuild `--define:__BUILD_FLAVOR__`.
 *
 * Possible values:
 *   - 'dev'  : 开发模式（unpackaged 启动）— env 完全透传
 *   - 'user' : 普通分发版 — 物理屏蔽 cloud sync env vars，**永远不会**改线上
 *   - 'ops'  : 运营管理版 — 透传 env vars，能推送到云端 UGC
 *
 * 在 src/main 里通过 `BUILD_FLAVOR` 引用。esbuild 把 `__BUILD_FLAVOR__` 替换成
 * 对应的字符串字面量（比如 `--define:__BUILD_FLAVOR__='"user"'`），打包后这一段
 * 是死代码消除的常量。
 *
 * **优先级（重要 — 修复 2026-05-07）**：
 *   1. unpackaged（npx electron .）→ 永远 'dev'，无视烤进去的常量
 *      原因：开发者本地经常会跑 `npm run build` 测试 electron-builder，会把
 *      'user' / 'ops' 烤进 main.cjs；下次 dev 启动时如果常量优先就会误判
 *   2. packaged + 有烤入常量 → 用烤入值（'user' / 'ops'）
 *   3. packaged + 没烤入常量 → 'user'（保守默认）
 */
declare const __BUILD_FLAVOR__: string | undefined
function detectBuildFlavor(): 'dev' | 'user' | 'ops' {
  if (isDev) return 'dev'
  if (typeof __BUILD_FLAVOR__ !== 'undefined' && __BUILD_FLAVOR__) {
    const v = String(__BUILD_FLAVOR__)
    if (v === 'user' || v === 'ops' || v === 'dev') return v
  }
  return 'user'   // packaged-without-define 默认按用户版处理（保守）
}
const BUILD_FLAVOR = detectBuildFlavor()
console.log(`[main] BUILD_FLAVOR=${BUILD_FLAVOR} isDev=${isDev}`)

// ── Baked SMS credentials (CI 注入到 user 版打包) ──────────────────────
// 设计：dev / ops 不烧凭据（开发者从终端 export，运维机有 systemd env）；
// user 版 CI 通过 GitHub Secrets 把阿里云 SMS AK/SK 烧进 main.cjs，启动
// sidecar 时通过 env 转发，让客户机零配置就能发短信登录。
//
// 反编译风险：main.cjs 在 .asar 里，能解包看到字面量。缓解：
//   · RAM 子账号只有 AliyunDysmsFullAccess（被滥用最多发垃圾短信）
//   · 阿里云用量阈值告警（单日 > 500 触发邮件）
//   · 一旦泄漏：吊销 RAM AK + 重发版即可（所有客户端自动升级）
declare const __BAKED_SMS_ACCESS_KEY__:    string | undefined
declare const __BAKED_SMS_ACCESS_SECRET__: string | undefined
declare const __BAKED_SMS_SIGN_NAME__:     string | undefined
declare const __BAKED_SMS_TEMPLATE_CODE__: string | undefined

function readBakedSms() {
  const safe = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    access_key:    safe(typeof __BAKED_SMS_ACCESS_KEY__    !== 'undefined' ? __BAKED_SMS_ACCESS_KEY__    : ''),
    access_secret: safe(typeof __BAKED_SMS_ACCESS_SECRET__ !== 'undefined' ? __BAKED_SMS_ACCESS_SECRET__ : ''),
    sign_name:     safe(typeof __BAKED_SMS_SIGN_NAME__     !== 'undefined' ? __BAKED_SMS_SIGN_NAME__     : ''),
    template_code: safe(typeof __BAKED_SMS_TEMPLATE_CODE__ !== 'undefined' ? __BAKED_SMS_TEMPLATE_CODE__ : ''),
  }
}
const BAKED_SMS = readBakedSms()
const BAKED_SMS_PRESENT = !!(BAKED_SMS.access_key && BAKED_SMS.access_secret &&
                              BAKED_SMS.sign_name && BAKED_SMS.template_code)
console.log(`[main] baked SMS credentials: ${BAKED_SMS_PRESENT ? 'present' : 'absent'}`)

/** 用户版必须剥离的 env 变量 — 防止有人在 user 版机器上手动设了这两个变量
 *  就能影响线上。物理隔离 = 不传给 sidecar 子进程。 */
const CLOUD_SYNC_ENV_KEYS = ['LINTU_CLOUD_SYNC_URL', 'LINTU_INTERNAL_SYNC_TOKEN'] as const

// ── Cloud sync credentials（safeStorage 持久化）────────────────────────
// 设计：让 dev / ops flavor 用户能在 UI 里配 sync URL + token，不用每次
// 启动 Electron 前 export shell env。凭据用 OS keychain 加密存盘
// （macOS Keychain / Windows DPAPI / Linux libsecret），main 进程启动
// sidecar 时解密合并到 env。
//
// User flavor：永远忽略持久化值，物理屏蔽不可绕过。这是产品安全约定。
//
// 文件位置：app.getPath('userData')/cloud-sync-creds.bin
const CREDS_FILE_NAME = 'cloud-sync-creds.bin'
function credsFilePath(): string {
  return join(app.getPath('userData'), CREDS_FILE_NAME)
}

interface CloudSyncCreds {
  url: string
  token: string
}

function readStoredCreds(): CloudSyncCreds | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const path = credsFilePath()
    if (!existsSync(path)) return null
    const raw = readFileSync(path)
    const json = safeStorage.decryptString(raw)
    const obj = JSON.parse(json)
    if (typeof obj?.url === 'string' && typeof obj?.token === 'string') {
      return { url: obj.url, token: obj.token }
    }
    return null
  } catch (e) {
    console.warn('[creds] read failed:', e)
    return null
  }
}

function writeStoredCreds(creds: CloudSyncCreds | null): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[creds] safeStorage not available — refusing to write plaintext')
      return false
    }
    const path = credsFilePath()
    mkdirSync(dirname(path), { recursive: true })
    if (creds === null) {
      // 清除：删文件即可
      try { require('fs').unlinkSync(path) } catch { /* not exist */ }
      return true
    }
    const enc = safeStorage.encryptString(JSON.stringify(creds))
    writeFileSync(path, enc, { mode: 0o600 })
    return true
  } catch (e) {
    console.warn('[creds] write failed:', e)
    return false
  }
}


// ── Auth token (用户登录 token，与 cloud-sync-creds 同款 safeStorage 加密)
const AUTH_TOKEN_FILE = 'auth-token.bin'
function authTokenPath(): string {
  return join(app.getPath('userData'), AUTH_TOKEN_FILE)
}

function readAuthToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const path = authTokenPath()
    if (!existsSync(path)) return null
    const raw = readFileSync(path)
    const token = safeStorage.decryptString(raw).trim()
    return token || null
  } catch (e) {
    console.warn('[auth-token] read failed:', e)
    return null
  }
}

function writeAuthToken(token: string | null): boolean {
  try {
    if (token && !safeStorage.isEncryptionAvailable()) {
      console.warn('[auth-token] safeStorage not available — refusing to write plaintext')
      return false
    }
    const path = authTokenPath()
    if (!token) {
      try { require('fs').unlinkSync(path) } catch { /* not exist */ }
      return true
    }
    mkdirSync(dirname(path), { recursive: true })
    const enc = safeStorage.encryptString(token)
    writeFileSync(path, enc, { mode: 0o600 })
    return true
  } catch (e) {
    console.warn('[auth-token] write failed:', e)
    return false
  }
}

function buildSidecarEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' }

  // 让 sidecar 知道自己被哪种 flavor 启动 — 决定 user_auth 中间件是否
  // 自动派 root（ops 自动派；user 必须真登录；dev 视 LINTU_AUTH_BYPASS）
  env.LINTU_BUILD_FLAVOR = BUILD_FLAVOR

  // ── Baked SMS 凭据 forward（仅 user 版 CI 烤入） ────────────────────
  // 优先级：shell env > sidecar config.json > main.cjs 烤入值
  // 也就是：开发者临时 export 测试凭据 / 客户在 UI 配的凭据 / 都比 baked 优先；
  // baked 是兜底，让客户什么都不做就能发短信登录。
  if (BAKED_SMS_PRESENT) {
    if (!env.LINTU_SMS_ACCESS_KEY)    env.LINTU_SMS_ACCESS_KEY    = BAKED_SMS.access_key
    if (!env.LINTU_SMS_ACCESS_SECRET) env.LINTU_SMS_ACCESS_SECRET = BAKED_SMS.access_secret
    if (!env.LINTU_SMS_SIGN_NAME)     env.LINTU_SMS_SIGN_NAME     = BAKED_SMS.sign_name
    if (!env.LINTU_SMS_TEMPLATE_CODE) env.LINTU_SMS_TEMPLATE_CODE = BAKED_SMS.template_code
  }

  if (BUILD_FLAVOR === 'user') {
    // 用户版：剥离同步凭据。即使 shell / safeStorage 里有，也不传给 sidecar。
    for (const key of CLOUD_SYNC_ENV_KEYS) delete env[key]
    return env
  }

  // dev / ops：尝试合并 safeStorage 里的凭据。环境里已设的（shell export）
  // 优先级**更高**，避免存盘旧值覆盖临时调试设置。
  const stored = readStoredCreds()
  if (stored) {
    if (!env.LINTU_CLOUD_SYNC_URL)        env.LINTU_CLOUD_SYNC_URL = stored.url
    if (!env.LINTU_INTERNAL_SYNC_TOKEN)   env.LINTU_INTERNAL_SYNC_TOKEN = stored.token
  }
  return env
}

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
        env: buildSidecarEnv(),
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
        env: buildSidecarEnv(),
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

// autoDownload = false → 我们手动控制下载时机,以便先做版本反回滚检查;
// 通过版本检查后再 manually trigger downloadUpdate()。autoInstallOnAppQuit
// 保持 true,下载完后用户退出 app 时 NSIS 自动接管升级。
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = {
  info:  (m: string) => console.log('[updater]', m),
  warn:  (m: string) => console.warn('[updater]', m),
  error: (m: string) => console.error('[updater]', m),
  debug: (_m: string) => {},
}

// ── Windows 自签证书指纹固定 (cert pinning) ───────────────────────────────
// 背景:我们用自签证书签 Windows installer,electron-updater 默认走 Windows
// 链校验,UntrustedRoot 直接 reject (即使 publisherName 匹配也不行)。
// 解法:覆盖 verifyUpdateCodeSignature,改用 SHA-256 证书指纹完全匹配 —
// 比原版链校验更严格 (链校验只看 CN,指纹固定锁定**这一张**证书的私钥)。
// 换证书时必须同步改这个常量并发版。
const EXPECTED_CERT_THUMBPRINT_SHA256 =
  '8DC5A968C7A83FC7960E127D513B7BF90C739CABEC433BA724E0B8CF0ADC4078'

if (isWin) {
  ;(autoUpdater as any).verifyUpdateCodeSignature = (
    _publisherNames: string[],
    filePath: string,
  ): Promise<string | null> => {
    return new Promise((resolve) => {
      const escaped = filePath.replace(/'/g, "''")
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-AuthenticodeSignature -FilePath '${escaped}').SignerCertificate.GetCertHashString('SHA256')`,
        ],
        { windowsHide: true, timeout: 15_000 },
        (err, stdout) => {
          if (err) {
            resolve(`cert verification failed: ${err.message}`)
            return
          }
          const actual = String(stdout).trim().toUpperCase()
          if (actual === EXPECTED_CERT_THUMBPRINT_SHA256) {
            console.log('[updater] cert thumbprint verified')
            resolve(null)
          } else {
            resolve(
              `cert thumbprint mismatch: got ${actual}, expected ${EXPECTED_CERT_THUMBPRINT_SHA256}`,
            )
          }
        },
      )
    })
  }
}

function notifyUpdater(event: string, payload?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`updater:${event}`, payload)
  }
}

// 反回滚:解析 dotted version 字符串,只比较前三段数字。仅供"是否新版"决策。
function isNewerVersion(remote: string, current: string): boolean {
  const parse = (s: string) =>
    s.split('-')[0].split('.').slice(0, 3).map((n) => parseInt(n, 10) || 0)
  const r = parse(remote)
  const c = parse(current)
  for (let i = 0; i < 3; i++) {
    if (r[i] > c[i]) return true
    if (r[i] < c[i]) return false
  }
  return false
}

autoUpdater.on('checking-for-update',  () =>     notifyUpdater('checking'))
autoUpdater.on('update-available', (info) => {
  const current = app.getVersion()
  const remote = info?.version ?? ''
  if (!remote || !isNewerVersion(remote, current)) {
    console.warn(`[updater] refusing downgrade/equal: current=${current} remote=${remote}`)
    notifyUpdater('not-available', info)
    return
  }
  notifyUpdater('available', info)
  // 通过反回滚检查后才真正触发下载
  autoUpdater.downloadUpdate().catch((e) =>
    console.warn('[updater] downloadUpdate failed:', e?.message ?? e),
  )
})
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
ipcMain.handle('app:get-build-flavor', () => BUILD_FLAVOR)

// ── Auth token IPC ─────────────────────────────────────────────────────
// 登录 token 走 safeStorage 加密落盘，跟 cloud-sync-creds 同样保护级别。
// renderer 在登录后写一次，每次 fetch 拿出来挂 Authorization 头；登出清空。
ipcMain.handle('auth-token:get', () => {
  return readAuthToken()
})
ipcMain.handle('auth-token:set', (_e, token: string) => {
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, reason: 'invalid_token' }
  }
  return { ok: writeAuthToken(token) }
})
ipcMain.handle('auth-token:clear', () => {
  return { ok: writeAuthToken(null) }
})

// ── Cloud sync credentials IPC ─────────────────────────────────────────
// 让 dev / ops 用户从 UI 配凭据，不用 shell export。User flavor 永远拒绝。
ipcMain.handle('cloud-sync-creds:get', () => {
  if (BUILD_FLAVOR === 'user') {
    return { available: false, reason: 'user_flavor_locked', has_creds: false }
  }
  const stored = readStoredCreds()
  return {
    available: safeStorage.isEncryptionAvailable(),
    has_creds: !!stored,
    url: stored?.url ?? null,
    // 不回传明文 token；只告诉 UI 是否设置了
    token_set: !!stored?.token,
  }
})

ipcMain.handle('cloud-sync-creds:set', async (_e, payload: { url: string; token: string }) => {
  if (BUILD_FLAVOR === 'user') {
    return { ok: false, reason: 'user_flavor_locked' }
  }
  if (!payload?.url?.trim() || !payload?.token?.trim()) {
    return { ok: false, reason: 'invalid_payload' }
  }
  const ok = writeStoredCreds({ url: payload.url.trim(), token: payload.token.trim() })
  if (!ok) return { ok: false, reason: 'write_failed' }
  // 写完不主动重启 sidecar — 让 UI 提示用户重启，避免操作中突然断流
  return { ok: true }
})

ipcMain.handle('cloud-sync-creds:clear', () => {
  if (BUILD_FLAVOR === 'user') return { ok: false, reason: 'user_flavor_locked' }
  return { ok: writeStoredCreds(null) }
})

// 重启 sidecar — UI 在改完凭据后调一下，让新 env 立刻生效。
// 重启完后强制 reload renderer：杀 sidecar 时 Electron 网络层会因为有
// 在飞的 fetch 而触发 "Network service crashed"，残留的连接对象会让
// 后续请求飞不出去。reload 重置渲染端网络状态最干净。
ipcMain.handle('sidecar:restart', async () => {
  try {
    if (pyProcess) {
      pyProcess.kill()
      pyProcess = null
    }
    startSidecar()
    const ok = await waitForSidecar()
    if (ok && mainWindow && !mainWindow.isDestroyed()) {
      // 给 renderer 一点时间收 toast / 关 dialog 再 reload
      setTimeout(() => {
        try { mainWindow!.webContents.reloadIgnoringCache() } catch {}
      }, 600)
    }
    return { ok }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
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
