const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, nativeTheme, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { getActivity, recordFigmaSessions } = require('./activity')
const { generateWeeklySummary, weeklyPathFor } = require('./weekly')

// ── Config ──────────────────────────────────────────────────────────────────
const POPUP_HOUR    = 16
const POPUP_MINUTE  = 45
const WEEKLY_DAY    = 5   // Friday
const WEEKLY_HOUR   = 17
const WEEKLY_MINUTE = 0
const NOTES_DIR     = path.join(os.homedir(), 'Documents', 'WorkLog')

// ── State ────────────────────────────────────────────────────────────────────
let win  = null
let tray = null

// ── Helpers ──────────────────────────────────────────────────────────────────
function todayKey() {
  return new Date().toLocaleDateString('en-CA')   // local "YYYY-MM-DD"
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

// ── Weekly summary ────────────────────────────────────────────────────────────
async function runWeeklySummary() {
  try {
    const outPath = await generateWeeklySummary()
    shell.openPath(outPath)
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Weekly Summary',
      message: 'Failed to generate summary',
      detail: err.message,
    })
  }
}

// Silent auto-trigger: generate this week's report only if it doesn't exist yet.
// No window, no dialog — errors are logged and swallowed so the app stays quiet.
async function runWeeklySummarySilent() {
  try {
    if (fs.existsSync(weeklyPathFor())) {
      console.log('Weekly summary already exists, skipping auto-generation')
      return
    }
    const outPath = await generateWeeklySummary()
    console.log(`Weekly summary auto-generated: ${outPath}`)
  } catch (err) {
    console.error(`Weekly summary auto-generation failed: ${err.message}`)
  }
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
    { label: 'Generate weekly summary', click: runWeeklySummary },
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

function msUntilNextWeekly() {
  const now  = new Date()
  const next = new Date(now)
  next.setHours(WEEKLY_HOUR, WEEKLY_MINUTE, 0, 0)

  // advance to the next WEEKLY_DAY; if it's already today but past the time,
  // roll a full week forward
  let add = (WEEKLY_DAY - next.getDay() + 7) % 7
  if (add === 0 && next <= now) add = 7
  next.setDate(next.getDate() + add)

  return next - now
}

function scheduleWeekly() {
  const delay = msUntilNextWeekly()
  const hrs   = Math.round(delay / 3600000)
  console.log(`Next weekly summary in ~${hrs} h`)

  setTimeout(() => {
    runWeeklySummarySilent()
    scheduleWeekly()   // reschedule for the following week
  }, delay)
}

// Catch-up: if the Fri 17:00 trigger was missed (Mac asleep / app not running),
// generate on launch when we're already past this week's slot.
function weeklyCatchUp() {
  const now = new Date()
  const day = now.getDay()
  const pastFridaySlot =
    day === WEEKLY_DAY &&
    (now.getHours() > WEEKLY_HOUR ||
      (now.getHours() === WEEKLY_HOUR && now.getMinutes() >= WEEKLY_MINUTE))
  const isWeekend = day === 6 || day === 0
  if (pastFridaySlot || isWeekend) runWeeklySummarySilent()
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
  scheduleWeekly()
  weeklyCatchUp()
  showWindow()
  // Poll Figma every minute: track which project is in focus (+1 min each tick)
  recordFigmaSessions()
  setInterval(recordFigmaSessions, 60 * 1000)
})

app.on('window-all-closed', e => e.preventDefault())  // keep alive in background
