/**
 * Electron shell for the DeepSeek whale-girl desktop pet.
 *
 * One frameless, transparent, always-on-top window that renders the pet
 * document served by the DSH plugin's loopback bridge. Everything the pet
 * actually does (speech, transcription, conversation) happens in the renderer;
 * this process only owns the OS window, the tray icon, and the two window
 * commands the user can reach from the tray.
 *
 * Flags:
 *   --url=<pet document url>   required
 *   --hidden                   start without showing the window
 *   --no-topmost               do not force the window above other windows
 *   --selftest --shot=<path>   render, save a PNG, print one JSON line, exit
 */
'use strict'

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

/** Parsed `--flag=value` / `--flag` command line. */
function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq === -1) out[arg.slice(2)] = true
    else out[arg.slice(2, eq)] = arg.slice(eq + 1)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const PET_URL = typeof args.url === 'string' ? args.url : ''
const SELFTEST = args.selftest === true
const SHOT_PATH = typeof args.shot === 'string' ? args.shot : ''

/** Window geometry from the plugin, passed through the environment. */
function windowSpec() {
  const fallback = { width: 320, height: 420, margin: 24, corner: 'bottom-right', alwaysOnTop: true, opacity: 1 }
  const raw = process.env.DSH_WHALE_PET_WINDOW
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

const spec = windowSpec()
const WIDTH = Number(spec.width) || 320
const HEIGHT = Number(spec.height) || 420
const MARGIN = Number(spec.margin) || 24

/** Place the window in the requested corner of the primary work area. */
function cornerPosition() {
  const area = screen.getPrimaryDisplay().workArea
  const right = area.x + area.width - WIDTH - MARGIN
  const bottom = area.y + area.height - HEIGHT - MARGIN
  const left = area.x + MARGIN
  const top = area.y + MARGIN
  switch (spec.corner) {
    case 'bottom-left': return { x: left, y: bottom }
    case 'top-right': return { x: right, y: top }
    case 'top-left': return { x: left, y: top }
    default: return { x: right, y: bottom }
  }
}

/** Icon path, preferring artwork the user may have dropped in as PNG. */
function iconPath(name) {
  const png = join(__dirname, 'assets', 'whale', 'png', `${name}.png`)
  return existsSync(png) ? png : undefined
}

let mainWindow = null
let tray = null
let topmost = spec.alwaysOnTop !== false && args['no-topmost'] !== true
let quitting = false

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** Create the single pet window. */
function createWindow() {
  const position = cornerPosition()
  mainWindow = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'DeepSeek Whale Pet',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  mainWindow.setAlwaysOnTop(topmost, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const opacity = Number(spec.opacity)
  if (Number.isFinite(opacity) && opacity < 1) mainWindow.setOpacity(Math.max(0.2, opacity))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (SELFTEST || args.hidden !== true) {
    mainWindow.once('ready-to-show', () => {
      if (!SELFTEST || SHOT_PATH.length > 0) mainWindow.showInactive()
    })
  }
  mainWindow.loadURL(PET_URL).catch((error) => {
    report({ ok: false, error: `cannot load ${PET_URL}: ${error.message}` })
  })
  return mainWindow
}

/** Create the tray entry when an icon is available. */
function createTray() {
  const icon = iconPath('tray') ?? iconPath('icon')
  if (icon === undefined) return
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  } catch {
    tray = null
    return
  }
  const rebuild = () => {
    if (tray === null) return
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示鲸鱼娘', click: () => showWindow() },
      { label: '隐藏鲸鱼娘', click: () => mainWindow?.hide() },
      { type: 'separator' },
      {
        label: '总在最前',
        type: 'checkbox',
        checked: topmost,
        click: (item) => setTopmost(item.checked),
      },
      { type: 'separator' },
      { label: '退出桌宠', click: () => quit() },
    ]))
  }
  rebuild()
  tray.setToolTip('DeepSeek 鲸鱼娘桌宠')
  tray.on('click', () => showWindow())
  tray.on('double-click', () => showWindow())
  tray.on('right-click', () => rebuild())
}

/** Show and focus the window, recreating it when it was closed. */
function showWindow() {
  if (mainWindow === null) createWindow()
  mainWindow.showInactive()
}

/** Apply the always-on-top preference to the live window. */
function setTopmost(value) {
  topmost = value === true
  mainWindow?.setAlwaysOnTop(topmost, 'screen-saver')
  return topmost
}

/** Finish the process cleanly. */
function quit() {
  quitting = true
  app.quit()
}

/** Print one JSON line; the selftest harness reads it from stdout. */
function report(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** Render, capture, and exit — the visual self-test used by the repository tests. */
async function runSelftest() {
  const target = SHOT_PATH.length > 0 ? SHOT_PATH : join(__dirname, '..', 'tests', 'artifacts', 'pet-window.png')
  const fail = (message) => {
    report({ ok: false, error: message })
    app.exit(2)
  }
  const timer = setTimeout(() => fail('the pet window did not report ready within 20s'), 20000)
  ipcMain.once('pet:ready', async () => {
    try {
      // Let one animation frame settle so the character is actually painted.
      await new Promise(resolve => setTimeout(resolve, 1200))
      const image = await mainWindow.capturePage()
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, image.toPNG())
      report({
        ok: true,
        value: {
          shot: target,
          size: image.getSize(),
          url: PET_URL.replace(/token=[^&]+/u, 'token=***'),
          ready: true,
        },
      })
    } catch (error) {
      report({ ok: false, error: String(error?.message ?? error) })
      app.exit(2)
      return
    } finally {
      clearTimeout(timer)
    }
    app.exit(0)
  })
}

ipcMain.handle('pet:quit', () => quit())
ipcMain.handle('pet:hide', () => mainWindow?.hide())
ipcMain.handle('pet:show', () => showWindow())
ipcMain.handle('pet:set-topmost', (_event, value) => setTopmost(value === true))
ipcMain.handle('pet:get-topmost', () => topmost)
ipcMain.handle('pet:resize', (_event, size) => {
  const width = Math.max(160, Math.min(1200, Number(size?.width) || WIDTH))
  const height = Math.max(160, Math.min(1200, Number(size?.height) || HEIGHT))
  mainWindow?.setBounds({ ...mainWindow.getBounds(), width, height })
  return { width, height }
})
ipcMain.on('pet:move-by', (_event, dx, dy) => {
  if (mainWindow === null) return
  const ox = Number(dx)
  const oy = Number(dy)
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return
  const [x, y] = mainWindow.getPosition()
  mainWindow.setPosition(x + Math.round(ox), y + Math.round(oy))
})

ipcMain.handle('pet:log', (_event, message) => {
  process.stdout.write(`[whale-pet window] ${String(message)}\n`)
})

if (app.requestSingleInstanceLock() === false) {
  // A second pet window would duplicate every spoken line.
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(() => {
    if (PET_URL.length === 0) {
      report({ ok: false, error: 'usage: electron pet/electron-main.cjs --url=<pet url>' })
      app.exit(2)
      return
    }
    if (SELFTEST) runSelftest()
    createWindow()
    createTray()
  })
  app.on('window-all-closed', () => {
    if (SELFTEST) return
    // Closing the pet window means hiding it: the tray keeps the pet reachable.
    if (!quitting) showWindow()
  })
  app.on('before-quit', () => {
    quitting = true
  })
}
