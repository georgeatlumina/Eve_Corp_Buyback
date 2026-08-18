---
name: run-app
description: Launch and drive the Eve Corp Buyback Electron desktop app. Use when asked to start the app, take a screenshot, test a UI change, or interact with any tab (Buyback, Contracts, Pricing, etc.).
---

Eve Corp Buyback is an Electron app with a Python sidecar (FastAPI, port 8766). On startup it shows a splash window while the sidecar boots (~15s), then transitions to the main UI (`renderer/index.html`). The driver handles this wait.

Cross-platform (macOS / Windows / Linux). All paths below are relative to the project root.

## Which method to use

| Goal | Method |
|---|---|
| **"Run the app so I can use it"** — user wants the window to stay open | `npm start` in background (see below) |
| **Take a screenshot / interact / test a UI change** — agent needs to drive the UI | Playwright driver (see below) |

**IMPORTANT:** The Playwright driver owns the Electron process — when the driver session ends (or `quit` is called), the window closes. Never use the driver when the goal is simply to launch the app for the user to use.

## Run for the user (background, window stays open)

Kill any existing instance first, then launch via `npm start` in the background:

```sh
pkill -x Electron 2>/dev/null; sleep 1
cd /Users/i840005/dev/Eve_Corp_Buyback
unset ELECTRON_RUN_AS_NODE
npm start &
```

Wait ~5s then confirm the sidecar started by checking the background task output. The window will remain open until the user closes it.

## Run (agent path — Playwright REPL)

```sh
node .claude/skills/run-app/driver.mjs
```

The driver auto-detects the Electron binary per platform and strips `ELECTRON_RUN_AS_NODE` from the launch env (IDE/agent shells set it, which otherwise crashes the app on startup).

Then at the `driver>` prompt:

```
launch          # starts the app, waits for main window (~20s total)
ss landing      # screenshot → /tmp/eve-shots/landing.png
tab Contracts   # click a nav tab by name
click-text Save # click a button by label
quit            # WARNING: this closes the Electron window
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

Screenshots land in `<os-tmpdir>/eve-shots/` by default (e.g. `/tmp/eve-shots` on macOS/Linux, `%TEMP%\eve-shots` on Windows). Override with the `SCREENSHOT_DIR` env var.

## Gotchas

- **Splash window is not the UI.** The app opens with `splash.html` while the Python sidecar starts. The driver polls for `index.html` and only sets `page` once that window appears. If you call `ss` before `launch` finishes you get nothing.
- **`ELECTRON_RUN_AS_NODE=1`** (commonly exported by IDE/agent terminals) makes the Electron binary run as plain Node, so the app crashes on startup (`ipcMain` is undefined / "Process failed to launch!"). The driver strips it from the launch env automatically. For `npm start`, unset it first (`unset ELECTRON_RUN_AS_NODE` / `$env:ELECTRON_RUN_AS_NODE=$null`).
- **Windows — BOM in `node_modules/electron/path.txt`** can cause `ENOENT: electron.exe` on `npm start`. May recur after `npm install`. The driver auto-fixes it at launch time (Windows only). Manual fix: `[System.IO.File]::WriteAllText("...\node_modules\electron\path.txt", "electron.exe", [System.Text.Encoding]::ASCII)` in PowerShell.
- **Python sidecar must be on PATH as `python3`** in dev mode. If it isn't, set `PYTHON_BIN=python` (or the full path) before `npm start`.
- **Port 8766 conflict** from a crashed previous run: `main.js` auto-kills the orphan sidecar on startup, so this is usually self-healing.

## Troubleshooting

- **`launch` hangs past 60s:** sidecar failed to start. Check the sidecar log under the app's userData dir (macOS: `~/Library/Application Support/naval-defence-management-tool/sidecar.log`; Windows: `%APPDATA%\naval-defence-management-tool\sidecar.log`).
- **App window never appears / "Process failed to launch!":** almost always `ELECTRON_RUN_AS_NODE` — see Gotchas.
- **Blank screenshot:** you got the splash, not the main window. Wait longer or check that the sidecar started.
