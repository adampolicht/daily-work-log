# daily-work-log

A minimal macOS menu bar app that pops up at 16:45 (Mon–Fri) and asks: *"What did you do today?"*

Notes are saved as plain Markdown files in `~/Documents/WorkLog/YYYY-MM-DD.md`.

## Features

- Lives in the menu bar as **✎** - no Dock icon
- Auto-popup at 16:45 on weekdays
- Notes stored as plain `.md` files, one per day
- Auto-saves while you type (2s debounce); empty notes are never written to disk
- **Cmd+S** to save, **Cmd+W** or **Esc** to save and hide
- Each day opens a fresh note; reopening the same day picks up where you left off
- Starts automatically at login via LaunchAgent
- **Activity sidebar** - shows today's app usage and visited sites pulled from macOS Screen Time data and browser history
  - Figma project names tracked via AppleScript (polled every 30 min)
  - Opera GX history parsed for work-relevant domains
  - Configurable blocklist (`blocklist.json`) to hide non-work apps and sites
  - Sidebar toggled via button in toolbar — state persists between sessions

## Requirements

- macOS 12+
- Node.js (`brew install node`)
- Full Disk Access granted to iTerm (or whichever terminal you use) — needed to read Screen Time data

## Setup

```bash
git clone <repo-url>
cd daily-work-log
npm install
```

### Grant Full Disk Access (one-time)

Open **System Settings → Privacy & Security → Full Disk Access** and enable your terminal app. Required to read `~/Library/Application Support/Knowledge/knowledgeC.db`.

### Start manually

```bash
npm start
```

### Auto-start at login (LaunchAgent)

```bash
cp com.worklog.app.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.worklog.app.plist
```

### Remove from login items

```bash
launchctl unload ~/Library/LaunchAgents/com.worklog.app.plist
rm ~/Library/LaunchAgents/com.worklog.app.plist
```

## File structure

```
daily-work-log/
├── main.js          # Electron main process — tray, scheduler, IPC
├── preload.js       # contextBridge (renderer ↔ main IPC)
├── activity.js      # Activity tracking — Screen Time DB + browser history
├── index.html       # Window markup
├── style.css        # Dark UI styling
├── app.js           # Renderer — load/save, sidebar, keyboard shortcuts
├── blocklist.json   # Apps and domains to hide from activity sidebar
├── package.json
└── com.worklog.app.plist  # LaunchAgent template
```

## Notes location

```
~/Documents/WorkLog/
├── 2026-07-20.md
├── 2026-07-21.md
└── ...
```

Figma session history (for the sidebar) is stored in `~/Documents/WorkLog/.figma-sessions.json`.

## Blocklist

Edit `blocklist.json` to control what appears in the activity sidebar. Changes take effect immediately on next window open — no restart needed.

```json
{
  "apps": ["com.spotify.client", "net.whatsapp.WhatsApp"],
  "domains": ["youtube.com", "reddit.com", "facebook.com"]
}
```

App identifiers use macOS bundle IDs (e.g. `com.figma.Desktop`, `com.tinyspeck.slackmacgap`).
