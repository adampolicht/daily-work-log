'use strict'

const path    = require('path')
const fs      = require('fs')
const os      = require('os')
const { execFileSync } = require('child_process')

const KNOWLEDGE_DB  = path.join(os.homedir(), 'Library', 'Application Support', 'Knowledge', 'knowledgeC.db')
const OPERA_HISTORY = path.join(os.homedir(), 'Library', 'Application Support', 'com.operasoftware.OperaGX', 'Default', 'History')
const BLOCKLIST_PATH = path.join(__dirname, 'blocklist.json')

const APP_NAMES = {
  'com.figma.Desktop':         'Figma',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.microsoft.VSCode':      'VS Code',
  'com.googlecode.iterm2':     'iTerm',
  'com.operasoftware.OperaGX': 'Opera GX',
  'com.apple.Notes':           'Notatki',
  'com.github.Electron':       'Worklog',
  'com.apple.mail':            'Mail',
  'com.microsoft.teams':       'Teams',
  'com.notion.id':             'Notion',
  'com.linear.app':            'Linear',
  'com.github.GitHubDesktop':  'GitHub Desktop',
}

function loadBlocklist() {
  try {
    return JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8'))
  } catch {
    return { apps: [], domains: [] }
  }
}

function sqlite(dbPath, sql) {
  try {
    const result = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8', timeout: 5000 })
    return result.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD
}

function getAppUsage(blocklist) {
  const today = todayLocal()
  const sql = `
    SELECT ZVALUESTRING, ROUND(SUM(ZENDDATE - ZSTARTDATE) / 60.0) as mins
    FROM ZOBJECT
    WHERE ZSTREAMNAME = '/app/usage'
      AND date(ZSTARTDATE + 978307200, 'unixepoch', 'localtime') = '${today}'
      AND ZENDDATE > ZSTARTDATE
    GROUP BY ZVALUESTRING
    ORDER BY mins DESC;
  `
  const rows = sqlite(KNOWLEDGE_DB, sql)
  return rows
    .map(row => {
      const [bundleId, mins] = row.split('|')
      return { bundleId, name: APP_NAMES[bundleId] || bundleId, mins: parseInt(mins, 10) }
    })
    .filter(r => r.mins > 0 && !blocklist.apps.includes(r.bundleId))
}

function getBrowserDomains(blocklist) {
  const tmp = path.join(os.tmpdir(), 'worklog_opera_history.db')
  try {
    fs.copyFileSync(OPERA_HISTORY, tmp)
  } catch {
    return []
  }

  const today = todayLocal()
  const sql = `
    SELECT DISTINCT
      replace(replace(
        substr(url, 1,
          CASE WHEN instr(substr(url, instr(url,'://')+3), '/') > 0
            THEN instr(url,'://')+2 + instr(substr(url, instr(url,'://')+3), '/') - 1
            ELSE length(url)
          END
        ),
      'https://',''), 'http://','') as domain,
      COUNT(*) as visits
    FROM urls
    WHERE date(last_visit_time/1000000 - 11644473600, 'unixepoch', 'localtime') = '${today}'
      AND url NOT LIKE 'chrome://%'
      AND url NOT LIKE 'opera://%'
      AND url NOT LIKE 'data:%'
    GROUP BY domain
    ORDER BY visits DESC
    LIMIT 60;
  `

  const rows = sqlite(tmp, sql)
  const seen = new Set()

  return rows
    .map(row => {
      const [raw, visits] = row.split('|')
      const domain = raw.replace(/^www\./, '').split('/')[0].trim()
      return { domain, visits: parseInt(visits, 10) }
    })
    .filter(r => {
      if (!r.domain || r.domain.length < 3) return false
      if (seen.has(r.domain)) return false
      seen.add(r.domain)
      const blocked = blocklist.domains.some(b => r.domain === b || r.domain.endsWith('.' + b))
      return !blocked
    })
    .slice(0, 15)
}

// ── Figma project tracking ────────────────────────────────────────────────────

const FIGMA_LOG      = path.join(os.homedir(), 'Documents', 'WorkLog', '.figma-sessions.json')
const FIGMA_SETTINGS = path.join(os.homedir(), 'Library', 'Application Support', 'Figma', 'settings.json')

function isFigmaRunning() {
  try {
    execFileSync('pgrep', ['-x', 'Figma'], { encoding: 'utf8', timeout: 1000 })
    return true
  } catch {
    return false
  }
}

// Returns { all: [title, ...], active: title|null } from Figma's settings.json
// No Accessibility permission needed — reads a plain JSON file.
function getOpenFigmaTabs() {
  try {
    const settings = JSON.parse(fs.readFileSync(FIGMA_SETTINGS, 'utf8'))
    if (!Array.isArray(settings.windows)) return { all: [], active: null }

    const allSet = new Set()
    let active = null

    for (const win of settings.windows) {
      const tabs = (win.tabs || []).filter(t => t.title && !t.isDiscarded)
      for (const tab of tabs) allSet.add(tab.title)
      if (win.activeTabPath && !active) {
        const hit = tabs.find(t => t.path === win.activeTabPath)
        if (hit) active = hit.title
      }
    }

    return { all: [...allSet], active }
  } catch {
    return { all: [], active: null }
  }
}

function recordFigmaSessions() {
  if (!isFigmaRunning()) return

  const today = todayLocal()
  let log = {}
  try { log = JSON.parse(fs.readFileSync(FIGMA_LOG, 'utf8')) } catch {}

  // migrate old array format → object
  if (Array.isArray(log[today])) {
    const old = log[today]
    log[today] = {}
    for (const e of old) {
      if (e.title) log[today][e.title] = { mins: 0, first_seen: e.first_seen }
    }
  }
  if (!log[today]) log[today] = {}

  const now = new Date().toISOString()
  const { all, active } = getOpenFigmaTabs()

  for (const title of all) {
    if (!log[today][title]) log[today][title] = { mins: 0, first_seen: now }
  }

  if (active) {
    if (!log[today][active]) log[today][active] = { mins: 0, first_seen: now }
    log[today][active].mins += 1
  }

  fs.writeFileSync(FIGMA_LOG, JSON.stringify(log, null, 2), 'utf8')
}

function getFigmaProjects() {
  const today = todayLocal()
  const map = new Map()

  try {
    const log = JSON.parse(fs.readFileSync(FIGMA_LOG, 'utf8'))
    const day = log[today]
    if (day && !Array.isArray(day)) {
      for (const [title, data] of Object.entries(day)) {
        if (title) map.set(title, data.mins || 0)
      }
    } else if (Array.isArray(day)) {
      for (const e of day) {
        if (e.title) map.set(e.title, 0)
      }
    }
  } catch {}

  if (isFigmaRunning()) {
    for (const title of getOpenFigmaTabs().all) {
      if (!map.has(title)) map.set(title, 0)
    }
  }

  // browser history fallback for figma.com opened in browser
  const tmp = path.join(os.tmpdir(), 'worklog_opera_figma.db')
  try {
    fs.copyFileSync(OPERA_HISTORY, tmp)
    const sql = `
      SELECT DISTINCT url FROM urls
      WHERE (url LIKE '%figma.com/design/%' OR url LIKE '%figma.com/file/%')
        AND date(last_visit_time/1000000 - 11644473600, 'unixepoch', 'localtime') >= date('now', 'localtime', '-1 day')
      ORDER BY last_visit_time DESC LIMIT 30;`
    const rows = sqlite(tmp, sql)
    for (const url of rows) {
      const m = url.match(/figma\.com\/(?:design|file)\/[A-Za-z0-9_-]+\/([^"?&#\s]{2,80})/)
      if (m) {
        const name = decodeURIComponent(m[1]).replace(/-/g, ' ')
        if (!map.has(name)) map.set(name, 0)
      }
    }
  } catch {}

  return [...map.entries()]
    .map(([title, mins]) => ({ title, mins }))
    .sort((a, b) => b.mins - a.mins)
}

function getActivity() {
  const blocklist = loadBlocklist()
  return {
    apps:    getAppUsage(blocklist),
    domains: getBrowserDomains(blocklist),
    figma:   getFigmaProjects(),
  }
}

module.exports = { getActivity, recordFigmaSessions }
