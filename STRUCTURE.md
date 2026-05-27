# File Structure

Repo layout and what each directory/file is responsible for. For a
function-level index see [FUNCTIONS.md](FUNCTIONS.md). For higher-level
project context see [CONTEXT.md](CONTEXT.md).

## Top-level tree

```
Eve_Corp_Buyback/
├── electron/                   Electron main + preload (Node)
├── renderer/                   Static HTML/CSS/JS UI (no build step)
├── python/                     FastAPI sidecar (ESI, Janice, refining)
├── assets/                     Icons (PNG variants + ICO/ICNS)
├── build/                      Build artifacts (PyInstaller, electron-builder)
├── dist/                       Packaged installers (DMG / NSIS)
├── contracts.json              Sample contract payload (dev fixture)
├── package.json                npm + electron-builder config
├── package-lock.json
├── LICENSE
├── README.md                   User-facing docs (install, usage, config)
├── CONTEXT.md                  Architecture & decisions (this folder)
├── STRUCTURE.md                You are here
└── FUNCTIONS.md                Function-level index
```

## `electron/` — Electron main process (Node)

Boots the desktop app, owns windows, spawns the Python sidecar, brokers the
small set of features the renderer can't do via plain `fetch()` (Alliance
Auth session, native windows, auto-update).

| File | Lines | Role |
|------|-------|------|
| [main.js](electron/main.js) | ~353 | App lifecycle, sidecar spawn (`startPythonSidecar`), main window, calculator popout, Alliance Auth BrowserWindow + cookie-jar partition, GitHub-Releases auto-update (`checkForUpdate`). |
| [preload.js](electron/preload.js) | 9 | `contextBridge` exposing `window.api` with `openCalculator`, `aaOpen`, `aaLogout`, `aaFetchHtml`. The renderer's *entire* surface area for IPC. |
| [afterSign.js](electron/afterSign.js) | 21 | electron-builder hook; runs after code-signing during `npm run build:mac`. |

**Sidecar log:** `<userData>/sidecar.log` — truncated each startup, captures
stdout/stderr from the Python child.

## `renderer/` — UI (vanilla HTML/CSS/JS, no build step)

Loaded by `mainWindow.loadFile('renderer/index.html')`. No bundler, no
framework. All DOM updates are imperative.

| File | Lines | Role |
|------|-------|------|
| [index.html](renderer/index.html) | 203 | Tab shell (Config / Auth / Buyback / Moon / Mail / Doctrines / Readiness), mail modal, calculator sidebar mount point. |
| [calculator.html](renderer/calculator.html) | 16 | Standalone calculator window template (popout target). |
| [app.js](renderer/app.js) | 2143 | **Everything else.** Config form ↔ sidecar, auth status polling, SSE consumption for `/api/validate` and `/api/aa/market/stream`, buyback + moon row rendering, mail template engine, AA HTML scraping, doctrine + fit rendering, readiness dashboard. |
| [calculator.js](renderer/calculator.js) | 211 | Self-contained numpad calculator with 70/80/90% copy-to-clipboard buttons; mounted both inline (Moon tab sidebar) and in the popout window. |
| [styles.css](renderer/styles.css) | 313 | Dark theme, tab styles, table layouts, progress bars, modal. |

**State lives in `app.js` module-level lets:** `cfg`, `walletData`,
`buybackResults`, `moonResults`, `aaState`, `readinessState`. No global store
beyond that. `readinessState` is the only chunk persisted to `localStorage`.

## `python/` — FastAPI sidecar

Bound to `localhost:8765`. Started as `python3 python/server.py` in dev or
as a PyInstaller binary in packaged builds. All external HTTP (ESI, Janice,
Fuzzwork) goes through here.

| File | Lines | Role |
|------|-------|------|
| [server.py](python/server.py) | 576 | FastAPI app, all routes, SSE streaming for validate + AA market, EVE SSO callback page. |
| [auth.py](python/auth.py) | 104 | EVE SSO authorize URL, code↔token exchange, refresh, token-cache file (`tokens.json`, chmod 600), JWT payload decoder. |
| [config.py](python/config.py) | 119 | Config schema + defaults, JSON load/save (chmod 600), legacy-shape migration (`_migrate`). |
| [esi.py](python/esi.py) | 179 | Thin ESI wrappers: `resolve_names`, `send_evemail`, `fetch_corp_wallets`, `fetch_corp_contracts`, `fetch_contract_items`, `fetch_type_info`, `fetch_group_info`, paged + non-paged `fetch_structure_orders`. |
| [janice.py](python/janice.py) | 211 | Janice appraisal fetch (RPC-first, API fallback), appraisal creation. `_normalize` is the single source of truth for the response shape consumed by `validate.py`. |
| [refining.py](python/refining.py) | 325 | Type classification (`is_mineable`, `is_moon_ore`, `is_ice`, `is_prismaticite`, `is_donation`), Fuzzwork material dump loader, Fuzzwork market buy-price fetch, and the core `compute_refined_payout` that produces the moon-contract payout. |
| [validate.py](python/validate.py) | 170 | `categorize` (courier/moon/buyback split), `validate_buyback_contract`, `process_moon_contract`, `validate_all`. Pure logic, no IO except via injected `payout_lookup`. |
| [requirements.txt](python/requirements.txt) | — | `fastapi`, `uvicorn`, `pydantic`, `requests`. |
| [sidecar.spec](python/sidecar.spec) | — | PyInstaller spec for the bundled binary. |

**Caches & state on disk** (under `EVE_BUYBACK_DATA_DIR`, typically
`<userData>/eve_auth/`):
- `config.json` — user settings (chmod 600).
- `tokens.json` — ESI tokens (chmod 600).
- `invTypeMaterials.csv` — Fuzzwork dump, lazy-loaded once per process.

## `assets/`

App icon in several sizes — `icon.png` (used by electron-builder + window
icon), `icon-128.png` (favicon for renderer HTML), plus ICO/ICNS variants for
the packaged installers.

## `build/` and `dist/`

Generated artifacts — both gitignored.
- `build/python-sidecar/` is electron-builder's `extraResources` source for
  the bundled Python binary.
- `build/pyinstaller-work/` is PyInstaller's intermediate workdir.
- `dist/` holds the packaged DMG (mac) and NSIS installer (Windows).

## Tracked-but-loose files

- [contracts.json](contracts.json) — sample contract response, useful as a
  fixture when iterating on `validate.py` without hitting ESI.
- [LICENSE](LICENSE) — repo license.

## Boundaries that matter

- **Renderer → sidecar:** direct `fetch('http://localhost:8765/...')`. No
  IPC. Means the renderer can be opened in any browser (e.g. for debugging)
  if the sidecar is running.
- **Renderer → main process:** only via `window.api` (defined in
  [preload.js](electron/preload.js)). If you need a new IPC channel, add it
  to **both** `preload.js` and `main.js`.
- **Sidecar → outside world:** all HTTP via `requests`; user-agent is built
  in `auth.get_user_agent()` and reused.
- **PyInstaller bundle boundary:** any Python file added to the project must
  be reachable from `server.py`'s imports for PyInstaller to pick it up;
  alternatively add it to [sidecar.spec](python/sidecar.spec).
