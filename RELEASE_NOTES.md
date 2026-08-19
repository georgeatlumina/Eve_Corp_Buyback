# v3.6.0 — Planner memory bank & interactive chain calculator

## Memory bank — Production & Reaction planners
- **10 memory slots** per planner: record / recall / rename / clear, an auto label + product icon,
  and a **pulsing glow** on the active slot. Recalling over unsaved work offers to stash it first.
- **Auto-persistence**: everything you type is saved and **restored when you reopen the app** — no
  more losing a recipe on close. **Reset** clears the page (your saved memories are kept).
- **Pop out** any memory into its own window (several at once), and an in-tab **Compare** mode shows
  recipe chains read-only, side by side.

## Interactive Chain calculator — Production & Reaction
A node graph next to each tree: columns by tier (raw → product) with connector lines, and **every
quantity is editable — change any node and the whole page re-plans** (tree, jobs, shopping list).
- **Click a node** to trace its sub-chain and open a **blow-up detail**: the **blueprint /
  reaction-formula name to copy in-game**, the **inputs** (per-run + total) with **availability
  colouring** — green = enough, yellow = partial, red = missing (from your assets **and** on-hand
  stock) — the output, a **Build ↔ Buy** toggle, and **×2 / ×5 / ×10** multiply.

## Quality-of-life & fixes
- **Login / Re-login** now reliably opens the EVE SSO page (the packaged app's login previously
  appeared to do nothing).
- **Analyze** errors are explicit — a network failure names the backend / port instead of a bare
  "failed to fetch".
- The jobs **"buy"** action reads **"→ Shopping list"** and is visible by default.
- **Larger default window** (1280×860, clamped to your screen, centered) for a comfortable
  at-least-13-inch default.

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
