# EVE Corp Buyback

Electron + Python desktop app for validating EVE Online corporation buyback
contracts and computing recommended payouts for moon-mining contracts.

## Install

Download the latest release for your platform:

https://github.com/georgeatlumina/Eve_Corp_Buyback/releases/latest

- macOS (Apple Silicon): `EVE-Corp-Buyback-X.Y.Z-arm64.dmg`
- Windows: `EVE-Corp-Buyback-Setup-X.Y.Z.exe`

## Troubleshooting

### macOS — "App is damaged and can't be opened"

The macOS builds are ad-hoc signed but **not** notarized by Apple, so the
first launch trips Gatekeeper. If you see *"EVE Corp Buyback.app is damaged
and can't be opened. You should move it to the Trash."*, this is **not** a
corrupted download — it's macOS refusing to run a non-notarized binary.

Clear the quarantine flag from a Terminal:

```bash
xattr -cr "/Applications/EVE Corp Buyback.app"
```

If the app is still in your Downloads folder, point at that path instead:

```bash
xattr -cr ~/Downloads/EVE\ Corp\ Buyback.app
```

After that the app opens normally. You may still see a standard *"unknown
developer"* prompt on the very first launch — click **Open** and macOS
remembers the choice for future launches.

### Windows — SmartScreen warning

Windows SmartScreen will show *"Windows protected your PC"* on first run
because the installer is unsigned. Click **More info → Run anyway**.

## Running from source (development)

```bash
pip install -r python/requirements.txt
npm install
npm start
```
