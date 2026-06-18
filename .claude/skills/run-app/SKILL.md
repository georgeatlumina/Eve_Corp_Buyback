---
name: run-app
description: Launch and drive the Eve Corp Buyback Electron desktop app. Use when asked to start the app, take a screenshot, test a UI change, or interact with any tab (Buyback, Contracts, Pricing, etc.).
---

Eve Corp Buyback is an Electron app with a Python sidecar (FastAPI, port 8765). On startup it shows a splash window while the sidecar boots (~15s), then transitions to the main UI (`renderer/index.html`). The driver handles this wait.

All paths relative to the project root (`C:\dev\Eve_Corp_Buyback\Eve_Corp_Buyback`).

## Run (human path)

```powershell
npm start   # opens the Electron window directly
```

## Run (agent path — Playwright REPL)

```powershell
node .claude/skills/run-app/driver.mjs
```

Then at the `driver>` prompt:

```
launch          # starts the app, waits for main window (~20s total)
ss landing      # screenshot → C:\tmp\shots\landing.png
tab Contracts   # click a nav tab by name
click-text Save # click a button by label
quit
```

### Commands

| command | what it does |
|---|---|
| `launch` | launch app, wait for splash→main transition |
| `ss [name]` | screenshot → `C:\tmp\shots\<name>.png` |
| `click <css>` | click element via DOM (bypasses coordinate issues) |
| `click-text <text>` | click button/link/tab containing text |
| `tab <name>` | click a nav tab by name (case-insensitive) |
| `type <text>` / `press <key>` | keyboard input |
| `wait <css>` | wait for element, 10s timeout |
| `eval <js>` | evaluate JS in the page, print JSON |
| `text [css]` | print innerText of element (or whole body) |
| `windows` | list all open windows by URL |
| `quit` | close app, exit driver |

Screenshots land in `C:\tmp\shots\` (override: `SCREENSHOT_DIR` env var).

## Gotchas

- **Splash window is not the UI.** The app opens with `splash.html` while the Python sidecar starts. The driver polls for `index.html` and only sets `page` once that window appears. If you call `ss` before `launch` finishes you get nothing.
- **BOM in `node_modules/electron/path.txt`** can cause `ENOENT: electron.exe` on `npm start`. May recur after `npm install`. The driver auto-fixes it at launch time. Manual fix: `[System.IO.File]::WriteAllText("...\node_modules\electron\path.txt", "electron.exe", [System.Text.Encoding]::ASCII)` in PowerShell.
- **Python sidecar must be on PATH as `python3`** in dev mode. If it isn't, set `PYTHON_BIN=python` (or the full path) before `npm start`.
- **Port 8765 conflict** from a crashed previous run: `main.js` auto-kills orphan `sidecar.exe` via `taskkill /IM sidecar.exe` on startup, so this is usually self-healing.

## Troubleshooting

- **`launch` hangs past 60s:** sidecar failed to start. Check `%APPDATA%\naval-defence-management-tool\sidecar.log`.
- **`ERR_FILE_NOT_FOUND` on `electron.exe`:** BOM issue — see Gotchas above.
- **Blank screenshot:** you got the splash, not the main window. Wait longer or check that the sidecar started.
