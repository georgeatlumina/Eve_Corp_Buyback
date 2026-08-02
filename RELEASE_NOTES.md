## What's new in v2.1.2

Release notes since PR #14 (merged 2026-07-25).

### Acquisitions
- New **build-finder**: market-completable and hull-less finder modes with a UEXO shopping list, wired to a consuming allocator that respects quota priority order.
- **Add / replace inventory** modes.
- Bare-hull inventory count now shown in the quota expand panel, and subtracted from the Contracts shopping list.

### Contracts
- Survive ESI's 520 bursts on the contract-items endpoint.
- Contract scan run history is now recorded.
- Scanned-ship list shows total value.
- Fixed a bug where ESI 504s were silently counted as zero contracts instead of surfacing an error.

### HaulX
- Retry button for failed volume/price lookups, with failed lookups now distinguishable from an honest null.
- Shopping list can be downloaded as text file(s).
- Corrected haul route wording, Jita → UEXO.

### Doctrine Stock
- New sort-by-priority option.

### Liquidation / Pricing
- Cost basis now priced off Jita buy instead of Amarr.
- Liquidation + Contracts pricing now point at the configured market hub instead of a hardcoded one.
- Finished the Amarr → Jita wording pass on the Liquidation tab.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.
