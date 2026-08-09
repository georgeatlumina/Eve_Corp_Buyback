# v3.3.0 — native zKillboard

The **zKillboard** tab is now a native killboard instead of an embedded web view. Search a
pilot, corporation, alliance or system and see its recent kills and losses rendered inside
the app — pulled live from zKillboard and enriched with public ESI killmails.

- **Type-ahead search:** start typing (3+ letters) and pick from suggestions — pilots, corps,
  alliances and systems — with keyboard or mouse. Picking a result loads its board instantly.
- **Native killmail list:** ship renders, victim & final-blow portraits, security-coloured
  systems, ISK values, solo / NPC / awox flags and relative times. Click any row to open the
  full killmail on zkillboard.com.
- **Filters:** kills, losses, or both.

Killmails are cached locally (they never change), so boards you revisit load instantly.

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
