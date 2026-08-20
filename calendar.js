'use strict'

// Calendar / dashboard view. Renders a month grid where each filled day shows a
// checkmark, total hours and the top clients. Data comes in two phases: an
// instant local parse, then an LLM-normalized upgrade (parseMonth) if a key is
// set. Clicking a tile drills into that day's note via window.openNote (app.js).

const MONTHS   = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December']

const calTitle = document.getElementById('cal-title')
const calGrid  = document.getElementById('cal-grid')

let calYear  = new Date().getFullYear()
let calMonth = new Date().getMonth() + 1   // 1-based
let renderToken = 0                        // guards against stale async paints

const pad2 = n => String(n).padStart(2, '0')

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// Compact hours: 90 → "1h30", 480 → "8h", 45 → "45m"
function fmtHours(mins) {
  if (!mins) return ''
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h && m) return `${h}h${m}`
  return h ? `${h}h` : `${m}m`
}

function localTodayKey() {
  return new Date().toLocaleDateString('en-CA')
}

async function renderCalendar() {
  const token = ++renderToken
  calTitle.textContent = `${MONTHS[calMonth - 1]} ${calYear}`

  // Phase 1: instant (cache + local parse)
  const days = await window.worklog.listMonth(calYear, calMonth)
  if (token !== renderToken) return
  paintGrid(days)

  // Phase 2: LLM-normalized upgrade (no-op without an API key). Repaint only if
  // the user is still looking at this month.
  window.worklog.parseMonth(calYear, calMonth).then(updated => {
    if (token === renderToken && Array.isArray(updated) && updated.length) paintGrid(updated)
  })
}

function paintGrid(days) {
  const todayKey = localTodayKey()

  // Mon-based index of the 1st: JS getDay() is 0=Sun..6=Sat
  const firstDow = new Date(calYear, calMonth - 1, 1).getDay()
  const lead     = (firstDow + 6) % 7

  let html = ''
  for (let i = 0; i < lead; i++) html += '<div class="cal-cell blank"></div>'

  for (const day of days) {
    const dayNum   = Number(day.date.slice(-2))
    const isToday  = day.date === todayKey
    const classes  = ['cal-cell', 'cal-day']
    if (day.filled) classes.push('filled'); else classes.push('empty')
    if (isToday) classes.push('today')

    let inner = `<span class="cal-daynum">${dayNum}</span>`

    if (day.filled) {
      inner += `<span class="cal-check">✓</span>`
      if (day.totalMins) inner += `<span class="cal-hours">${fmtHours(day.totalMins)}</span>`

      const clients = (day.clients || []).filter(c => c.name && c.name !== '—')
      if (clients.length) {
        const shown = clients.slice(0, 2)
          .map(c => `<span class="cal-chip">${escapeHtml(c.name)}</span>`).join('')
        const more = clients.length > 2 ? `<span class="cal-chip more">+${clients.length - 2}</span>` : ''
        inner += `<div class="cal-clients">${shown}${more}</div>`
      }
    }

    html += `<button class="${classes.join(' ')}" data-date="${day.date}">${inner}</button>`
  }

  calGrid.innerHTML = html
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function shiftMonth(delta) {
  calMonth += delta
  if (calMonth < 1)  { calMonth = 12; calYear-- }
  if (calMonth > 12) { calMonth = 1;  calYear++ }
  renderCalendar()
}

document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1))
document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1))
document.getElementById('cal-folder').addEventListener('click', () => window.worklog.openFolder())
document.getElementById('cal-close').addEventListener('click', () => window.worklog.hide())

// Tile click → open that day's note (defined in app.js)
calGrid.addEventListener('click', e => {
  const tile = e.target.closest('.cal-day')
  if (tile && window.openNote) window.openNote(tile.dataset.date)
})

// Re-sync to the current month whenever the calendar is shown afresh.
function resetCalendarToToday() {
  calYear  = new Date().getFullYear()
  calMonth = new Date().getMonth() + 1
}

window.renderCalendar = renderCalendar
window.resetCalendarToToday = resetCalendarToToday
