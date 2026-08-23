const fs   = require('fs')
const path = require('path')
const os   = require('os')
const https = require('https')

const NOTES_DIR   = path.join(os.homedir(), 'Documents', 'WorkLog')
const WEEKLY_DIR  = path.join(NOTES_DIR, 'weekly')
const WORK_HOURS  = 8
const DAY_NAMES   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
// A note starting with one of these means a non-working day: no report, no
// hours, excluded from totals. Detected deterministically (no LLM) since the
// phrasing is short and unambiguous.
const DAY_OFF_RE  = /^(day off|urlop|wolne|off|pto|l4|chory|sick|holiday)\b/i
// Deterministic client-name canonicalization applied after the LLM parse. The
// prompt asks the model to normalize names, but it does so inconsistently
// between runs (e.g. "APTEOS" vs "ApteOS", "Memory" vs "Memory²"), which splits
// one project into duplicate rows. This map is the source of truth. Keys are
// lowercased. Note: the "Memory² · Internal" fill bucket is intentionally NOT
// listed, so it stays separate from client "Memory²".
const CLIENT_ALIASES = {
  apteos:  'ApteOS',
  celler:  'Cellier',
  cellier: 'Cellier',
  noba:    'NOBA',
  m2:      'Memory²',
  memory2: 'Memory²',
  memory:  'Memory²',
  'memory²': 'Memory²',
}
function normalizeClient(name) {
  const key = String(name).trim().toLowerCase()
  return CLIENT_ALIASES[key] || String(name).trim()
}
function isDayOff(content) {
  return DAY_OFF_RE.test(String(content).trim())
}

// ── Env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const candidates = [
    path.join(NOTES_DIR, '.env'),   // production location
    path.join(__dirname, '.env'),   // dev fallback
  ]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const env = {}
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq < 1) continue
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return env
  }
  return {}
}

// ── Week helpers ─────────────────────────────────────────────────────────────
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

function localDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function weekDates(date = new Date()) {
  const d    = new Date(date)
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay()
  const mon  = new Date(d)
  mon.setDate(d.getDate() + diff)
  mon.setHours(0, 0, 0, 0)
  return Array.from({ length: 5 }, (_, i) => {
    const dd = new Date(mon)
    dd.setDate(mon.getDate() + i)
    return localDateStr(dd)
  })
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function parseMins(t) {
  if (!t || t === '?') return null
  const h = t.match(/(\d+\.?\d*)h/)
  const m = t.match(/(\d+)\s*min/)
  let total = 0
  if (h) total += parseFloat(h[1]) * 60
  if (m) total += parseInt(m[1])
  return total || null
}

function fmtMins(mins) {
  if (mins === null) return '?'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h && m) return `${h}h ${m}min`
  return h ? `${h}h` : `${m}min`
}

// ── LLM call (Gemini or Groq via OpenAI-compatible API) ──────────────────────
function httpPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } },
      res => {
        let raw = ''
        res.on('data', c => raw += c)
        res.on('end', () => resolve(raw))
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function callLLM(env, prompt) {
  // Groq (OpenAI-compatible)
  if (env.GROQ_API_KEY) {
    const body = JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    })
    const raw    = await httpPost('api.groq.com', '/openai/v1/chat/completions', { Authorization: `Bearer ${env.GROQ_API_KEY}` }, body)
    const parsed = JSON.parse(raw)
    if (parsed.error) throw new Error(parsed.error.message)
    return parsed.choices?.[0]?.message?.content || ''
  }

  // Gemini
  if (env.GEMINI_API_KEY) {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    })
    const raw    = await httpPost('generativelanguage.googleapis.com', `/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`, {}, body)
    const parsed = JSON.parse(raw)
    if (parsed.error) throw new Error(parsed.error.message)
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }

  throw new Error('No API key found.\nAdd GROQ_API_KEY or GEMINI_API_KEY to ~/Documents/WorkLog/.env')
}

// ── Prompt ────────────────────────────────────────────────────────────────────
function buildPrompt(notes) {
  const notesBlock = notes.map(n => `### ${n.date}\n${n.content}`).join('\n\n')
  return `You are processing a weekly work log. Notes may be in Polish or English.

For each day, extract all work entries. Each entry has a client name and a description.

Rules:
- Normalize client names — fix typos, resolve abbreviations to the full canonical form. Example mappings: "Celler" → "Cellier", "M2" → "Memory²", "Memory2" → "Memory²", "Noba" → "NOBA"
- If a new client name appears that you haven't seen before, include it as-is (do not drop it)
- Translate all descriptions to concise, professional English
- When a description covers several distinct tasks, separate them with " & " rather than commas or the word "and" (e.g. "Promo codes & AB social media templates & status meeting")
- If an explicit time is written (e.g. "3h", "45min", "(1h)"), extract it as-is
- If no time is specified, use "?"
- Never invent or estimate times

Return ONLY valid JSON — no markdown, no explanation, nothing else:
{
  "days": [
    {
      "date": "YYYY-MM-DD",
      "entries": [
        { "client": "ClientName", "note": "English description", "time": "Xh or ?" }
      ]
    }
  ]
}

Work log:
${notesBlock}`
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function renderMarkdown(data, dates, year, week, rawNotes) {
  const rawByDate = Object.fromEntries(rawNotes.map(n => [n.date, n.content]))
  const totals = {}   // client → { mins: number, hasUnknown: bool }

  function addTotal(client, mins) {
    if (!totals[client]) totals[client] = { mins: 0, hasUnknown: false }
    if (mins !== null) totals[client].mins += mins
    else totals[client].hasUnknown = true
  }

  let md = `# Week ${week} · ${fmtDate(dates[0])}–${fmtDate(dates[4])}, ${year}\n\n`

  let daysOff = 0

  // Index parsed data by date. Day-off days are detected from the raw notes
  // (see generateWeeklySummary), never sent to the LLM, so they won't appear in
  // data.days — that's why we iterate over the week's dates, not data.days.
  const dataByDate = Object.fromEntries((data.days || []).map(d => [d.date, d]))

  for (let idx = 0; idx < dates.length; idx++) {
    const date = dates[idx]
    const raw  = rawByDate[date]
    if (!raw) continue   // no note logged that day

    md += `## ${DAY_NAMES[idx]} · ${fmtDate(date)}\n\n`
    md += `> ${raw.split('\n').join('\n> ')}\n\n`

    // Non-working day: render the note as-is, skip the table and the 8h
    // Internal fill so it doesn't inflate the weekly totals.
    if (isDayOff(raw)) {
      daysOff++
      continue
    }

    const day = dataByDate[date] || { entries: [] }

    md += `| Client | Note | Time |\n`
    md += `|--------|------|------|\n`

    let knownMins  = 0
    let hasUnknown = false

    // Group entries by client so one project's tasks share a single row,
    // with the tasks joined by " & " and their times summed.
    const groups   = []   // preserves first-seen client order
    const byClient = {}
    for (const entry of day.entries) {
      const client = normalizeClient(entry.client)
      if (!byClient[client]) {
        byClient[client] = { client, notes: [], mins: 0, anyKnown: false, anyUnknown: false }
        groups.push(byClient[client])
      }
      const g    = byClient[client]
      const mins = parseMins(entry.time)
      if (entry.note && !g.notes.includes(entry.note)) g.notes.push(entry.note)
      if (mins !== null) { g.mins += mins; g.anyKnown = true; knownMins += mins }
      else { g.anyUnknown = true; hasUnknown = true }
      addTotal(client, mins)
    }

    for (const g of groups) {
      const note = g.notes.join(' & ')
      const time = !g.anyKnown  ? '?'
                 : g.anyUnknown ? `${fmtMins(g.mins)}+`
                 : fmtMins(g.mins)
      md += `| ${g.client} | ${note} | ${time} |\n`
    }

    const remaining = WORK_HOURS * 60 - knownMins

    if (!hasUnknown && remaining > 0) {
      md += `| Memory² · Internal | — | ${fmtMins(remaining)} |\n`
      addTotal('Memory² · Internal', remaining)
    } else {
      md += `| Memory² · Internal | — | ? |\n`
      addTotal('Memory² · Internal', null)
    }

    md += `\n`
  }

  md += `---\n\n## Weekly totals\n\n`
  md += `| Client | Time |\n`
  md += `|--------|------|\n`

  for (const [client, t] of Object.entries(totals)) {
    const label = t.hasUnknown
      ? (t.mins > 0 ? `${fmtMins(t.mins)}+` : '?')
      : fmtMins(t.mins)
    md += `| ${client} | ${label} |\n`
  }

  if (daysOff) md += `\n_Days off: ${daysOff}_\n`

  return md
}

// Resolve API keys from process env + .env file (production or dev location).
function resolveEnv() {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY:   process.env.GROQ_API_KEY,
    ...loadEnv(),
  }
}

// Run the LLM parse on a set of { date, content } notes and return structured
// data: { days: [{ date, entries: [{ client, note, time }] }] }. Shared by the
// weekly report and the calendar's per-day cache.
async function parseNotesLLM(notes, env = resolveEnv()) {
  const raw = await callLLM(env, buildPrompt(notes))
  // Strip markdown code fences if Gemini wraps the JSON
  const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(jsonStr)
}

// ── Main export ───────────────────────────────────────────────────────────────
async function generateWeeklySummary(targetDate = new Date()) {
  const env = resolveEnv()

  const dates = weekDates(targetDate)
  const notes = dates
    .map(date => ({ date, content: (() => {
      const p = path.join(NOTES_DIR, `${date}.md`)
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : ''
    })() }))
    .filter(n => n.content)

  if (!notes.length) throw new Error('No notes found for this week.')

  // Day-off notes are handled deterministically by the renderer — keep them out
  // of the LLM call so the model can't drop the day or invent hours. If every
  // note is a day off, skip the LLM entirely.
  const workNotes = notes.filter(n => !isDayOff(n.content))
  const data = workNotes.length ? await parseNotesLLM(workNotes, env) : { days: [] }

  const week = isoWeek(targetDate)
  const year = targetDate.getFullYear()
  const md   = renderMarkdown(data, dates, year, week, notes)

  if (!fs.existsSync(WEEKLY_DIR)) fs.mkdirSync(WEEKLY_DIR, { recursive: true })

  const outPath = path.join(WEEKLY_DIR, `${year}-W${String(week).padStart(2, '0')}.md`)
  fs.writeFileSync(outPath, md, 'utf8')

  return outPath
}

// Path of the weekly report file for a given date (no side effects).
function weeklyPathFor(targetDate = new Date()) {
  const week = isoWeek(targetDate)
  const year = targetDate.getFullYear()
  return path.join(WEEKLY_DIR, `${year}-W${String(week).padStart(2, '0')}.md`)
}

module.exports = { generateWeeklySummary, weeklyPathFor, parseNotesLLM, resolveEnv, parseMins, fmtMins }
