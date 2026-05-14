/**
 * Electron main process — boots the Next.js standalone server as a child
 * Node process, then opens a BrowserWindow pointing at it.
 *
 * Why a child process and not `require('./server.js')` directly?
 *   Next's standalone server expects a clean Node runtime (it sets globals,
 *   listens on a port, manages its own signals). Running it inside Electron's
 *   main process pollutes both. Spawning a separate Node — using Electron's
 *   own binary with ELECTRON_RUN_AS_NODE=1 so we don't ship a second runtime —
 *   keeps the boundary clean.
 */

const { app, BrowserWindow, shell, Menu } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')

// Single-instance lock — second launch of the .exe focuses the existing window
// instead of starting a second Next server on a busy port.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const isPackaged = app.isPackaged
const PORT = Number(process.env.OCR_CRM_PORT) || 3939
const HOST = '127.0.0.1'

// Where the standalone build lives at runtime.
//   dev:      <repo>/.next/standalone
//   packaged: <resources>/standalone   (see electron-builder extraResources)
const standaloneDir = isPackaged
  ? path.join(process.resourcesPath, 'standalone')
  : path.join(__dirname, '..', '.next', 'standalone')

const serverEntry = path.join(standaloneDir, 'server.js')
const tesseractRoot = path.join(standaloneDir, 'node_modules')

// Load .env next to the .exe (or repo root in dev) so users can drop a config
// file beside the binary instead of editing internals. Failures are non-fatal.
function loadDotEnv() {
  const envCandidates = isPackaged
    ? [
        path.join(path.dirname(app.getPath('exe')), '.env'),
        path.join(app.getPath('userData'), '.env'),
      ]
    : [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '.env.local')]

  for (const file of envCandidates) {
    if (!fs.existsSync(file)) continue
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      for (const raw of lines) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        let val = line.slice(eq + 1).trim()
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1)
        }
        if (!(key in process.env)) process.env[key] = val
      }
    } catch (err) {
      console.error('[electron] failed to load env file', file, err)
    }
  }
}

function waitForPort(port, host, timeoutMs = 30_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = net.createConnection({ port, host })
      sock.once('connect', () => {
        sock.end()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Next server did not start on ${host}:${port} within ${timeoutMs}ms`))
        } else {
          setTimeout(tick, 250)
        }
      })
    }
    tick()
  })
}

let nextProc = null

function startNextServer() {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Next standalone server not found at ${serverEntry}. Did you run "npm run build"?`,
    )
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOSTNAME: HOST,
    OCR_TESSERACT_ROOT: tesseractRoot,
  }

  nextProc = spawn(process.execPath, [serverEntry], {
    cwd: standaloneDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  nextProc.stdout.on('data', (chunk) => process.stdout.write(`[next] ${chunk}`))
  nextProc.stderr.on('data', (chunk) => process.stderr.write(`[next] ${chunk}`))
  nextProc.on('exit', (code, signal) => {
    console.error(`[electron] Next process exited (code=${code} signal=${signal})`)
    nextProc = null
    if (!app.isQuitting) app.quit()
  })
}

function stopNextServer() {
  if (!nextProc) return
  try {
    nextProc.kill()
  } catch {}
  nextProc = null
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  // Open external links in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://${HOST}:${PORT}`)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.once('ready-to-show', () => win.show())
  await win.loadURL(`http://${HOST}:${PORT}`)

  if (!isPackaged) win.webContents.openDevTools({ mode: 'detach' })

  return win
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  loadDotEnv()

  // Strip the default menu in packaged builds — keeps the chrome minimal.
  if (isPackaged) Menu.setApplicationMenu(null)

  try {
    startNextServer()
    await waitForPort(PORT, HOST)
    await createWindow()
  } catch (err) {
    console.error('[electron] startup failed:', err)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  app.isQuitting = true
  stopNextServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
  stopNextServer()
})
