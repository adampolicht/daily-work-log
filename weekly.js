const fs   = require('fs')
const path = require('path')
const os   = require('os')
const https = require('https')

const NOTES_DIR   = path.join(os.homedir(), 'Documents', 'WorkLog')
const WEEKLY_DIR  = path.join(NOTES_DIR, 'weekly')
const WORK_HOURS  = 8
const DAY_NAMES   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

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
      model: 'llama-3.3-70b-versatile',
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

  for (const day of data.days) {
    const idx = dates.indexOf(day.date)
    if (idx === -1) continue

    md += `## ${DAY_NAMES[idx]} · ${fmtDate(day.date)}\n\n`

    const raw = rawByDate[day.date]
    if (raw) md += `> ${raw.split('\n').join('\n> ')}\n\n`

    md += `| Client | Note | Time |\n`
    md += `|--------|------|------|\n`

    let knownMins  = 0
    let hasUnknown = false

    // Group entries by client so one project's tasks share a single row,
    // with the tasks joined by " & " and their times summed.
    const groups   = []   // preserves first-seen client order
    const byClient = {}
    for (const entry of day.entries) {
      if (!byClient[entry.client]) {
        byClient[entry.client] = { client: entry.client, notes: [], mins: 0, anyKnown: false, anyUnknown: false }
        groups.push(byClient[entry.client])
      }
      const g    = byClient[entry.client]
      const mins = parseMins(entry.time)
      if (entry.note && !g.notes.includes(entry.note)) g.notes.push(entry.note)
      if (mins !== null) { g.mins += mins; g.anyKnown = true; knownMins += mins }
      else { g.anyUnknown = true; hasUnknown = true }
      addTotal(entry.client, mins)
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

  return md
}

// ── Main export ───────────────────────────────────────────────────────────────
async function generateWeeklySummary(targetDate = new Date()) {
  const env = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY:   process.env.GROQ_API_KEY,
    ...loadEnv(),
  }

  const dates = weekDates(targetDate)
  const notes = dates
    .map(date => ({ date, content: (() => {
      const p = path.join(NOTES_DIR, `${date}.md`)
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : ''
    })() }))
    .filter(n => n.content)

  if (!notes.length) throw new Error('No notes found for this week.')

  const raw = await callLLM(env, buildPrompt(notes))

  // Strip markdown code fences if Gemini wraps the JSON
  const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  const data    = JSON.parse(jsonStr)

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

module.exports = { generateWeeklySummary, weeklyPathFor }
