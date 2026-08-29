# v3.12.7 — Fixes logins failing with "Token exchange failed"

**Please update.** Some people were unable to log in, with:

```
Token exchange failed: Expecting ',' delimiter: line 206 column 23 (char 37893)
```

It usually showed up as the Buyback page's wallet section failing, because that's the first thing on
screen that needs an authenticated character.

## What was going wrong

The app stores every logged-in character in one file. That file was being written unsafely — truncated
first and rewritten after, with nothing stopping two writes overlapping. Refreshing several characters
at once (the SMT Intel Map alone can refresh 24 in a single request), or the app being closed at the
wrong moment during an update, could leave the file half-written and unreadable.

Once that happened, **every** logged-in character stopped working — and logging back in couldn't fix it,
because saving the new login had to read the same broken file first. That's the error above: it looks
like the login failed, but the login worked and saving it didn't.

A second, quieter version of the same fault could throw away a character's credentials when several
refreshed at once, so that character would need logging in again for no apparent reason.

## What's changed

- **Writes can't be interrupted any more.** The file is written to one side and swapped into place in a
  single step, so it's either the old contents or the new ones, never a broken mix.
- **Simultaneous refreshes take turns**, so they can't overwrite each other's credentials.
- **A backup copy is kept.** If the file is ever unreadable, the app falls back to the backup
  automatically and keeps the damaged copy alongside it for diagnosis.
- **Nothing to fix by hand.** If you're affected, launching v3.12.7 repairs it on startup. At worst a
  single character needs logging in again, since the backup can be one save behind.

The same protection now covers your settings file, which was written the same way.

---

### Downloads

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `*.dmg` | Open the DMG, drag into Applications |
| Windows | `*.exe` | Run the installer |
| Linux — Debian/Ubuntu | `*.deb` | `sudo apt install ./<file>.deb` |
| Linux — Fedora/RHEL/openSUSE | `*.rpm` | `sudo rpm -U <file>.rpm` (or `sudo dnf install ./<file>.rpm`) |

The `.deb`/`.rpm` packages are unsigned (RPM tools may warn about a missing GPG signature — expected). The in-app updater picks the format matching your distro.

_Intel matcher & map ported from [Slazanger's SMT](https://github.com/Slazanger/SMT) (MIT); region layouts © Wollari & CCP (Dotlan); Thera/Turnur connections from [eve-scout](https://www.eve-scout.com/); ship names from CCP's SDE._

_Full release history: see [CHANGELOG.md](CHANGELOG.md)._
