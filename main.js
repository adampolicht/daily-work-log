const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, nativeTheme } = require('electron')
const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { getActivity, recordFigmaSessions } = require('./activity')

// ── Config ──────────────────────────────────────────────────────────────────
const POPUP_HOUR   = 16
const POPUP_MINUTE = 45
const NOTES_DIR    = path.join(os.homedir(), 'Documents', 'WorkLog')

// ── State ────────────────────────────────────────────────────────────────────
let win  = null
let tray = null

// ── Helpers ──────────────────────────────────────────────────────────────────
function todayKey() {
  return new Date().toISOString().slice(0, 10)   // "YYYY-MM-DD"
}

function notePath(key = todayKey()) {
  return path.join(NOTES_DIR, `${key}.md`)
}

function ensureNotesDir() {
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true })
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  if (win) {
    win.show()
    win.focus()
    return
  }

  win = new BrowserWindow({
    width:           700,
    height:          480,
    minWidth:        400,
    minHeight:       320,
    titleBarStyle:   'hiddenInset',
    backgroundColor: '#1c1c1e',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  win.loadFile('index.html')
  win.setAlwaysOnTop(true, 'floating')

  win.on('close', e => {
    // hide instead of destroy so next popup reuses the window
    e.preventDefault()
    win.hide()
  })

  win.on('closed', () => { win = null })
}

function showWindow() {
  if (!win) createWindow()
  else {
    win.show()
    win.webContents.send('refresh')
  }
  win.focus()
}

// ── Tray icon ────────────────────────────────────────────────────────────────
function buildTray() {
  // On macOS we use a template image (inverts with dark/light mode).
  // We create a tiny 16×16 pixel transparent PNG as placeholder,
  // then set the title string so the tray shows text.
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('✎')
  tray.setToolTip('Daily Work Log')

  const menu = Menu.buildFromTemplate([
    { label: "Open today's note",  click: showWindow },
    { type: 'separator' },
    { label: 'Open WorkLog folder', click: () => shell.openPath(NOTES_DIR) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.on('click', showWindow)
}

// ── Scheduler ────────────────────────────────────────────────────────────────
function msUntilNextPopup() {
  const now  = new Date()
  const next = new Date(now)
  next.setHours(POPUP_HOUR, POPUP_MINUTE, 0, 0)

  // if we already passed today's time, schedule for tomorrow
  if (next <= now) next.setDate(next.getDate() + 1)

  // skip to Monday if next day is weekend
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1)
  }

  return next - now
}

function schedulePopup() {
  const delay = msUntilNextPopup()
  const mins  = Math.round(delay / 60000)
  console.log(`Next popup in ${mins} min`)

  setTimeout(() => {
    showWindow()
    schedulePopup()   // reschedule for the following day
  }, delay)
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('load-note', (_e, key) => {
  const p = notePath(key)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
})

ipcMain.handle('save-note', (_e, key, text) => {
  if (!text.trim()) return true
  ensureNotesDir()
  fs.writeFileSync(notePath(key), text, 'utf8')
  return true
})

ipcMain.handle('open-folder', () => {
  ensureNotesDir()
  shell.openPath(NOTES_DIR)
})

ipcMain.handle('hide-window', () => {
  win?.hide()
})

ipcMain.handle('get-activity', () => {
  try { return getActivity() }
  catch (e) { return { apps: [], domains: [], error: e.message } }
})

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  app.dock.hide()   // no Dock icon — lives in menu bar only
  ensureNotesDir()
  buildTray()
  schedulePopup()
  showWindow()
  // Poll Figma window titles every 30 min to build daily history
  recordFigmaSessions()
  setInterval(recordFigmaSessions, 30 * 60 * 1000)
})

app.on('window-all-closed', e => e.preventDefault())  // keep alive in background
