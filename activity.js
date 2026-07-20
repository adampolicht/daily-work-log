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

const FIGMA_LOG = path.join(os.homedir(), 'Documents', 'WorkLog', '.figma-sessions.json')

function getFigmaWindowTitles() {
  try {
    const script = `
      tell application "System Events"
        if exists process "Figma" then
          tell process "Figma"
            return name of every window
          end tell
        end if
      end tell`
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 3000 }).trim()
    if (!out || out === 'missing value') return []
    return out.split(', ').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function recordFigmaSessions() {
  const titles = getFigmaWindowTitles()
  if (!titles.length) return

  const today = todayLocal()
  let log = {}
  try { log = JSON.parse(fs.readFileSync(FIGMA_LOG, 'utf8')) } catch {}

  if (!log[today]) log[today] = []
  const now = new Date().toISOString()
  for (const title of titles) {
    if (!log[today].find(e => e.title === title)) {
      log[today].push({ title, first_seen: now })
    }
  }

  fs.writeFileSync(FIGMA_LOG, JSON.stringify(log, null, 2), 'utf8')
}

function getFigmaProjects() {
  const today = todayLocal()
  const titles = new Set(getFigmaWindowTitles())

  // Also load persisted sessions from today
  try {
    const log = JSON.parse(fs.readFileSync(FIGMA_LOG, 'utf8'))
    for (const entry of (log[today] || [])) titles.add(entry.title)
  } catch {}

  // Parse browser history for figma.com/design/ file names (last 2 days)
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
        titles.add(name)
      }
    }
  } catch {}

  return [...titles].filter(t => t && t !== 'missing value')
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
