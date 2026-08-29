# daily-work-log

A minimal macOS menu bar app that nudges you at the end of each workday and asks: *"What did you do today?"* – then turns those daily notes into a calendar dashboard and an auto-generated weekly summary.

Everything is stored as plain Markdown in `~/Documents/WorkLog/`. No cloud account, no database, no lock-in – just files you own.

Packaged as **Worklog.app** (menu bar only, no Dock icon).

## What it does

Three things, built on top of one plain-text note per day:

1. **Daily capture** – a small window pops up at 16:45 on weekdays asking what you worked on. You type, it saves.
2. **Calendar dashboard** – a month grid where each day shows the hours logged and the top clients, so you can see your week and month at a glance.
3. **Weekly summary** – every Friday the week's notes are turned into a clean per-client, per-day report via an LLM, saved as its own Markdown file.

## Features

### Daily notes
- Lives in the menu bar as **✎** – no Dock icon, no window clutter
- Auto-popup at 16:45 Mon–Fri, landing straight on today's entry
- One plain `.md` file per day: `~/Documents/WorkLog/YYYY-MM-DD.md`
- Auto-saves while you type (2s debounce); empty notes are never written to disk
- **Cmd+S** to save, **Cmd+W** or **Esc** to save and hide
- Each day opens a fresh note; reopening the same day picks up where you left off
- Starts automatically at login via LaunchAgent

Notes follow a light `Client: what you did (Xh)` convention per line, which is what the dashboard and weekly summary parse:

```
ApteOS: dashboard redesign, SARA module states (3h)
Cellier: wine detail page in Figma (2h30)
Memory Squared: internal tooling (1h)
```

### Calendar dashboard
- Month grid; the default landing view when you open the app
- Each filled day shows a checkmark, total hours and the top clients for that day
- Two-phase rendering: an **instant local parse** (offline, no key) upgraded by an **LLM-normalized** pass that canonicalizes client names and hours
- LLM results are cached per day in `.parsed.json`, keyed by a hash of the raw note, so edits invalidate the cache automatically and unchanged days never hit the API again
- Click any day tile to drill into that day's note
- Saturday tiles link straight to that week's summary

### Weekly summary
- Auto-generated silently every **Friday at 17:00**; if the Mac was asleep or the app wasn't running, it catches up on next launch (Friday evening or weekend)
- Also available on demand from the tray menu (**Generate weekly summary**)
- Produces a per-day breakdown plus **weekly totals per client**, saved to `~/Documents/WorkLog/weekly/YYYY-Wxx.md`
- Uses Groq (`openai/gpt-oss-120b`) to normalize free-form notes into structured client/hours, with Google Gemini (`gemini-2.0-flash-lite`) as a fallback
- **Day-off aware**: notes starting with `day off`, `urlop`, `wolne`, `pto`, `l4`, `sick`, `holiday` etc. are detected deterministically (no LLM), get no hours and are excluded from totals
- **Client-name canonicalization**: a fixed alias map merges inconsistent spellings (e.g. `APTEOS`/`ApteOS`, `memory`/`m2`/`Memory²`) into the canonical `Memory Squared` so one project never splits into duplicate rows
- Assumes an 8h workday; time not attributed to a client on a working day is rolled into a `Memory Squared · Internal` bucket

### Activity sidebar
Toggled from the toolbar (state persists between sessions), it reconstructs where your day actually went:

- **App usage** pulled from macOS Screen Time data (`knowledgeC.db`)
- **Visited sites** parsed from Opera GX browser history
- **Figma project tracking** – reads Figma's local `settings.json` to see which project is in focus and accumulates time per project (polled every minute), with a browser-history fallback for `figma.com` files opened in a browser
- Configurable **blocklist** (`blocklist.json`) hides non-work apps and sites; changes take effect on next window open, no restart needed

## Requirements

- macOS 12+
- Node.js (`brew install node`)
- **Full Disk Access** granted to the app that reads Screen Time / Opera history:
  - during development: your terminal app (iTerm, Ghostty, etc.)
  - once packaged: `Worklog.app` itself
  - required to read `~/Library/Application Support/Knowledge/knowledgeC.db` and Opera's `History`
- A **Groq API key** for weekly summaries and dashboard normalization (Gemini key optional as fallback)

## Setup

```bash
git clone <repo-url>
cd daily-work-log
npm install
```

### API keys

Weekly summaries and the LLM dashboard pass read keys from a `.env` file. Create one in the notes folder (production) or the project root (dev fallback):

```
# ~/Documents/WorkLog/.env
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...        # optional fallback
```

Without a key the app still runs: daily notes work fully and the calendar falls back to the instant local parser.

### Grant Full Disk Access (one-time)

Open **System Settings → Privacy & Security → Full Disk Access** and enable the relevant app (your terminal in dev, or `Worklog.app` once installed). Required to read the Screen Time database.

### Run in development

```bash
npm start
```

### Auto-start at login (LaunchAgent)

```bash
cp com.worklog.app.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.worklog.app.plist
```

Remove it again with:

```bash
launchctl unload ~/Library/LaunchAgents/com.worklog.app.plist
rm ~/Library/LaunchAgents/com.worklog.app.plist
```

## Build & deploy

```bash
npm run dist     # build Worklog.app into dist_app/ (electron-builder, arm64)
npm run deploy   # rebuild, then hot-swap into the installed app and restart
```

`npm run deploy` copies **only** the rebuilt `app.asar` into `/Applications/Worklog.app`, then kills and relaunches it via `launchctl`. Swapping just the asar (instead of replacing the whole bundle) preserves the app's existing TCC grants, so you don't have to re-grant Full Disk Access after every update. The build is ad-hoc signed (`identity: null`) and marked `LSUIElement`, so it lives in the menu bar only.

## File structure

```
daily-work-log/
├── main.js               # Electron main: tray, scheduler, IPC, weekly triggers
├── preload.js            # contextBridge (renderer ↔ main IPC)
├── activity.js           # Activity tracking: Screen Time DB, Opera history, Figma
├── weekly.js             # Weekly summary: LLM parse, canonicalization, Markdown out
├── days.js               # Calendar data layer: local + LLM parse, per-day cache
├── calendar.js           # Calendar dashboard renderer
├── app.js                # Renderer: note load/save, sidebar, keyboard shortcuts
├── index.html            # Window markup
├── style.css             # Dark UI styling
├── blocklist.json        # Apps and domains to hide from the activity sidebar
├── package.json
└── com.worklog.app.plist # LaunchAgent template
```

## Data location

```
~/Documents/WorkLog/
├── 2026-08-24.md          # daily notes, one per day
├── 2026-08-23.md
├── weekly/
│   └── 2026-W34.md        # generated weekly summaries
├── .parsed.json           # per-day LLM parse cache (calendar)
├── .figma-sessions.json   # accumulated Figma per-project time
└── .env                   # API keys (production location)
```

## Blocklist

Edit `blocklist.json` to control what appears in the activity sidebar:

```json
{
  "apps": ["com.spotify.client", "net.whatsapp.WhatsApp"],
  "domains": ["youtube.com", "reddit.com", "facebook.com"]
}
```

App identifiers use macOS bundle IDs (e.g. `com.figma.Desktop`, `com.tinyspeck.slackmacgap`).
