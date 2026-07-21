'use strict'

const note      = document.getElementById('note')
const btnSave   = document.getElementById('btn-save')
const btnFolder = document.getElementById('btn-folder')
const dateLabel = document.getElementById('date-label')
const statusEl  = document.getElementById('save-status')

// ── Date key ──────────────────────────────────────────────────────────────────
function todayKey() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
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

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  dateLabel.textContent = formatDate(currentKey)
  const text = await window.worklog.loadNote(currentKey)
  note.value = text
  note.focus()
  note.setSelectionRange(note.value.length, note.value.length)
}

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

// ── Save & Close ──────────────────────────────────────────────────────────────
async function saveAndClose() {
  await save()
  window.worklog.hide()
}

// ── Auto-save on input (debounced) ────────────────────────────────────────────
let autoTimer = null
note.addEventListener('input', () => {
  clearTimeout(autoTimer)
  autoTimer = setTimeout(async () => {
    await window.worklog.saveNote(currentKey, note.value)
    statusEl.textContent = 'Auto-saved'
    setTimeout(() => { statusEl.textContent = '' }, 1200)
  }, 2000)
})

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', async e => {
  const cmd = e.metaKey || e.ctrlKey

  if (cmd && e.key === 's') {
    e.preventDefault()
    await save()
  }

  if (cmd && e.key === 'w') {
    e.preventDefault()
    await save()
    window.worklog.hide()
  }

  if (e.key === 'Escape') {
    await save()
    window.worklog.hide()
  }
})

// ── Buttons ───────────────────────────────────────────────────────────────────
btnSave.addEventListener('click', saveAndClose)
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
      figma.forEach(name => {
        html += `<div class="activity-domain-row">
          <span class="activity-dot" style="background:#a259ff"></span>
          <span class="activity-domain">${name}</span>
        </div>`
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

// ── Refresh on reopen (date may have changed since last open) ─────────────────
window.worklog.onRefresh(() => {
  currentKey = todayKey()
  init()
  loadActivity()
})

// ── Start ─────────────────────────────────────────────────────────────────────
init()
loadActivity()
