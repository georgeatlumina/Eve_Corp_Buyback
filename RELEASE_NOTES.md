# v3.4.0 — Buyback locations, reliability & port move

## Ore buyback — location names & controls
- Contract **locations are now resolved to names** (stations via public ESI; player structures via
  the authenticated structure endpoint) instead of raw location IDs.
- New controls on the Ore Buyback tab: **Sort** (oldest [default] / newest / location), **filter by
  location**, and **group by location** (oldest-first within each group).

## Reliability
- Wallet and corp-contract loads no longer fail with a raw 500 on ESI errors — a **403 now gives a
  clear "needs Accountant role + wallet scope" message**, and other failures a safe reason.

## Security
- The access token that ESI embeds in error URLs is now **redacted** from the UI and logs (a
  corp-contracts scan could previously surface the full token).

## Under the hood
- The local sidecar (the API **and** the ESI login callback) **moved from port 8765 to 8766**.

## Upgrade notes
- **Re-authenticate your characters** to grant the new structure-names permission
  (`esi-universe.read_structures.v1`), or structure names fall back to IDs.
- Running your own EVE application: set its callback URL to **`http://localhost:8766/callback`** and
  enable the **`esi-universe.read_structures.v1`** scope in the developer portal, or logins will fail.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
