'use strict'

const note      = document.getElementById('note')
const btnSave   = document.getElementById('btn-save')
const btnFolder = document.getElementById('btn-folder')
const dateLabel = document.getElementById('date-label')
const statusEl  = document.getElementById('save-status')

// ── Date key ──────────────────────────────────────────────────────────────────
function todayKey() {
  return new Date().toLocaleDateString('en-CA')   // local "YYYY-MM-DD"
}

function formatDate(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentKey = todayKey()
let saveTimer  = null

// ── View switching ────────────────────────────────────────────────────────────
const viewCalendar = document.getElementById('view-calendar')
const viewNote     = document.getElementById('view-note')

function showView(name) {
  viewCalendar.classList.toggle('hidden', name !== 'calendar')
  viewNote.classList.toggle('hidden', name !== 'note')
}

function showCalendar() {
  showView('calendar')
  window.renderCalendar()   // re-lists notes so edits show immediately
}

// ── Open a day's note ─────────────────────────────────────────────────────────
async function openNote(key = todayKey()) {
  currentKey = key
  dateLabel.textContent = formatDate(currentKey)
  const text = await window.worklog.loadNote(currentKey)
  note.value = text
  showView('note')
  note.focus()
  note.setSelectionRange(note.value.length, note.value.length)

  // Activity sidebar only makes sense for today (Screen Time is today-scoped).
  const isToday = currentKey === todayKey()
  btnToggleSidebar.style.display = isToday ? '' : 'none'
  if (isToday) {
    setCollapsed(localStorage.getItem('activityCollapsed') === '1')
    loadActivity()
  } else {
    panel.classList.add('collapsed')
  }
}

window.openNote = openNote

// ── Save ──────────────────────────────────────────────────────────────────────
async function save() {
  await window.worklog.saveNote(currentKey, note.value)
  flashStatus('Saved ✓')
}

function flashStatus(msg) {
  statusEl.textContent = msg
  statusEl.classList.add('flash')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    statusEl.textContent = ''
    statusEl.classList.remove('flash')
  }, 2000)
}

// ── Save & return to calendar ─────────────────────────────────────────────────
async function saveAndReturn() {
  await save()
  showCalendar()
}

// ── Auto-save on input (debounced) ────────────────────────────────────────────
let autoTimer = null
note.addEventListener('input', () => {
  clearTimeout(autoTimer)
  autoTimer = setTimeout(async () => {
    await window.worklog.saveNote(currentKey, note.value)
    flashStatus('Auto-saved')
  }, 2000)
})

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', async e => {
  const cmd    = e.metaKey || e.ctrlKey
  const inNote = !viewNote.classList.contains('hidden')

  if (cmd && e.key === 's') {           // save, stay on the note
    e.preventDefault()
    if (inNote) await save()
    return
  }

  if (e.key === 'Escape' || (cmd && e.key === 'w')) {
    e.preventDefault()
    if (inNote) await saveAndReturn()   // note → save + back to calendar
    else window.worklog.hide()          // calendar → close the window
  }
})

// ── Buttons ───────────────────────────────────────────────────────────────────
btnSave.addEventListener('click', saveAndReturn)
btnFolder.addEventListener('click', () => window.worklog.openFolder())

// ── Activity sidebar collapse ─────────────────────────────────────────────────
const panel     = document.getElementById('activity-panel')
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar')

function setCollapsed(collapsed) {
  panel.classList.toggle('collapsed', collapsed)
  btnToggleSidebar.classList.toggle('active', !collapsed)
  localStorage.setItem('activityCollapsed', collapsed ? '1' : '0')
}

btnToggleSidebar.addEventListener('click', () => {
  setCollapsed(!panel.classList.contains('collapsed'))
})

if (localStorage.getItem('activityCollapsed') === '1') {
  setCollapsed(true)
} else {
  btnToggleSidebar.classList.add('active')
}

// ── Activity sidebar ──────────────────────────────────────────────────────────
function formatMins(m) {
  if (m >= 60) return `${Math.floor(m/60)}h ${m%60}m`
  return `${m}m`
}

async function loadActivity() {
  const el = document.getElementById('activity-content')
  try {
    const { apps, domains, figma } = await window.worklog.getActivity()

    let html = ''

    if (figma && figma.length) {
      html += '<div class="activity-section">'
      html += '<div class="activity-section-title">Figma</div>'
      figma.forEach(({ title, mins }) => {
        const label = title.length > 20 ? title.slice(0, 19) + '…' : title
        if (mins > 0) {
          html += `<div class="activity-row">
            <span class="activity-name" style="color:#a259ff">${label}</span>
            <span class="activity-time">${formatMins(mins)}</span>
          </div>`
        } else {
          html += `<div class="activity-domain-row">
            <span class="activity-dot" style="background:#a259ff"></span>
            <span class="activity-domain">${label}</span>
          </div>`
        }
      })
      html += '</div>'
    }

    if (apps.length) {
      html += '<div class="activity-section">'
      html += '<div class="activity-section-title">Apps</div>'
      apps.forEach(a => {
        const label = a.name.length > 16 ? a.name.slice(0, 15) + '…' : a.name
        html += `<div class="activity-row">
          <span class="activity-name">${label}</span>
          <span class="activity-time">${formatMins(a.mins)}</span>
        </div>`
      })
      html += '</div>'
    }

    if (domains.length) {
      html += '<div class="activity-section">'
      html += '<div class="activity-section-title">Sites</div>'
      domains.slice(0, 12).forEach(d => {
        html += `<div class="activity-domain-row">
          <span class="activity-dot"></span>
          <span class="activity-domain">${d.domain}</span>
        </div>`
      })
      html += '</div>'
    }

    if (!html) html = '<div class="activity-empty">No data yet</div>'
    el.className = ''
    el.innerHTML = html
  } catch (e) {
    el.className = 'activity-empty'
    el.textContent = 'Could not load'
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.getElementById('btn-back').addEventListener('click', saveAndReturn)

// Main process tells us which view to show (calendar on open, note at 16:45).
window.worklog.onNavigate(({ view, date }) => {
  if (view === 'note') openNote(date)
  else { window.resetCalendarToToday(); showCalendar() }
})
