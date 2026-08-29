'use strict'

// Calendar data layer: scans daily notes, extracts client/hours per day.
// Two sources: an instant local parser (offline, no key) and an LLM parse whose
// normalized result is cached per-day in .parsed.json, keyed by a hash of the
// raw note so edits invalidate the cache automatically.

const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const crypto = require('crypto')
const { parseNotesLLM, resolveEnv, parseMins, weeklyPathFor, normalizeClient } = require('./weekly')

const NOTES_DIR  = path.join(os.homedir(), 'Documents', 'WorkLog')
const CACHE_PATH = path.join(NOTES_DIR, '.parsed.json')

const pad = n => String(n).padStart(2, '0')

function readDay(date) {
  const p = path.join(NOTES_DIR, `${date}.md`)
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) } catch { return {} }
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8') } catch {}
}

// ── Local parser (fallback / instant) ─────────────────────────────────────────
// Notes follow "Client: description (Xh)" per line. Client = text before the
// first colon; hours = explicit time tokens on that line.
function parseLocal(text) {
  const byClient = new Map()
  let totalMins = 0

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const colon = line.indexOf(':')
    const client = colon > 0 && colon <= 30 ? normalizeClient(line.slice(0, colon).trim()) : '—'
    const mins   = parseMins(line) || 0

    totalMins += mins
    byClient.set(client, (byClient.get(client) || 0) + mins)
  }

  return { source: 'local', totalMins, clients: clientsFrom(byClient) }
}

// Collapse LLM entries ({ client, note, time }) into per-client minute totals.
function summarizeLLMDay(entries) {
  const byClient = new Map()
  let totalMins = 0

  for (const e of entries) {
    const mins = parseMins(e.time) || 0
    totalMins += mins
    const client = normalizeClient(e.client)
    byClient.set(client, (byClient.get(client) || 0) + mins)
  }

  return { source: 'llm', totalMins, clients: clientsFrom(byClient) }
}

function clientsFrom(map) {
  return [...map.entries()]
    .map(([name, mins]) => ({ name, mins }))
    .sort((a, b) => b.mins - a.mins)
}

// ── Month listing ──────────────────────────────────────────────────────────────
// Returns one entry per calendar day. Filled days carry cached LLM data when the
// note is unchanged since it was parsed, otherwise an instant local parse.
function listMonth(year, month) {
  const cache = loadCache()
  const count = new Date(year, month, 0).getDate()   // month is 1-based here
  const out   = []

  for (let d = 1; d <= count; d++) {
    const date = `${year}-${pad(month)}-${pad(d)}`
    const text = readDay(date).trim()

    let entry
    if (!text) {
      entry = { date, filled: false }
    } else {
      const h      = hash(text)
      const cached = cache[date]
      entry = (cached && cached.hash === h)
        ? { date, filled: true, ...cached }
        : { date, filled: true, hash: h, ...parseLocal(text) }
    }

    // Saturday: if the week's summary has been generated, mark the tile so it
    // opens the report instead of a day note.
    const dayDate = new Date(year, month - 1, d)
    if (dayDate.getDay() === 6) {
      const wp = weeklyPathFor(dayDate)
      if (fs.existsSync(wp)) {
        entry.weekly = true
        const m = path.basename(wp).match(/W(\d+)/)
        if (m) entry.week = Number(m[1])
      }
    }

    out.push(entry)
  }

  return out
}

// LLM-parse every filled day that isn't already cached (or whose note changed),
// batched into a single call, then persist and return the refreshed month.
// No-op (returns local data) when there's no API key or nothing to parse.
async function parseMonth(year, month) {
  const cache = loadCache()
  const count = new Date(year, month, 0).getDate()
  const pending = []

  for (let d = 1; d <= count; d++) {
    const date = `${year}-${pad(month)}-${pad(d)}`
    const text = readDay(date).trim()
    if (!text) continue
    const h = hash(text)
    if (cache[date] && cache[date].hash === h && cache[date].source === 'llm') continue
    pending.push({ date, content: text, hash: h })
  }

  if (!pending.length) return listMonth(year, month)

  const env = resolveEnv()
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) return listMonth(year, month)

  const data   = await parseNotesLLM(pending.map(({ date, content }) => ({ date, content })), env)
  const hashOf = new Map(pending.map(p => [p.date, p.hash]))

  for (const day of data.days || []) {
    if (!hashOf.has(day.date)) continue
    cache[day.date] = { hash: hashOf.get(day.date), ...summarizeLLMDay(day.entries || []) }
  }

  saveCache(cache)
  return listMonth(year, month)
}

module.exports = { listMonth, parseMonth }
