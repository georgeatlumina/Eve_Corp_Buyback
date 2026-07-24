# Packaging Naval Defence Management Tool as an `.rpm` on openSUSE

Electron front-end + PyInstaller Python (FastAPI) sidecar → a vendored `/opt`
RPM built with `rpmbuild`, following openSUSE conventions (`%{_bindir}`
wrapper, `.desktop` entry, hicolor icons).

Everything the build needs now lives in the repo, so there is nothing to
hand-type into a spec file:

| File | Purpose |
|---|---|
| [packaging/rpm/build-rpm.sh](packaging/rpm/build-rpm.sh) | Whole flow: sidecar → Electron → tarball → `rpmbuild` → self-check |
| [packaging/rpm/naval-defence-management-tool.spec](packaging/rpm/naval-defence-management-tool.spec) | The spec |
| [packaging/rpm/naval-defence.sh](packaging/rpm/naval-defence.sh) | `/usr/bin/naval-defence` wrapper |
| [packaging/rpm/naval-defence.desktop](packaging/rpm/naval-defence.desktop) | Menu entry |

> **Reality check:** Electron bundles its own Chromium/Node and cannot be
> un-vendored, and the `npm`/`electron-builder` build needs network access — so
> this can't go through OBS as a "clean" package. This is the idiomatic *local*
> `rpmbuild` path. `rpmlint` warnings about bundled libraries and `/opt` are
> expected and unavoidable for any Electron app.

The version is read from `package.json` at build time — nothing to bump by hand.

**Verified on** openSUSE Tumbleweed 20260717, rpm 4.20.1, node 24.18.0, npm 11.16.0,
Python 3.13, Electron 28.3.3 — full build, all 14 runtime deps resolving, and a
sidecar boot check. See §9.

---

## 1. Prerequisites

```sh
sudo zypper install nodejs22 npm22 python3 python3-pip binutils rpm-build
# optional: rpmlint (linting), rpmdevtools (rpmdev-setuptree)
```

`binutils` is not optional: PyInstaller shells out to `objdump`/`ldd` while
collecting the sidecar's shared libraries.

If `pip` has to build PyInstaller's bootloader from source (happens when your
`python3` is newer than the latest PyInstaller wheel), also install
`gcc python3-devel zlib-devel`.

Then, in the project root:

**bash**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt pyinstaller
npm install
```

**fish**

```fish
python3 -m venv .venv
source .venv/bin/activate.fish     # NOT bin/activate — that is bash syntax
pip install -r python/requirements.txt pyinstaller
npm install
```

---

## 2. Build the RPM (scripted — recommended, shell-agnostic)

```sh
packaging/rpm/build-rpm.sh
```

or `npm run build:rpm`. The script puts `.venv/bin` on `PATH` itself, so it
does not care whether you activated the venv or which shell you use.

It will:

1. check `node`, `npm`, `rpmbuild`, `tar`, `pyinstaller`, `node_modules`;
2. run `npm run build:linux-dir` (PyInstaller sidecar → `electron-builder --linux dir`);
3. assert `dist/linux-unpacked/naval-defence` and
   `dist/linux-unpacked/resources/python-sidecar/sidecar` both exist;
4. stage `~/rpmbuild/{SOURCES,SPECS,...}` and run `rpmbuild -bb`;
5. verify `chrome-sandbox` came out setuid root and print the packaged paths.

Result:

```
~/rpmbuild/RPMS/x86_64/naval-defence-management-tool-2.0.3-0.x86_64.rpm
```

Useful flags / env:

```sh
packaging/rpm/build-rpm.sh --skip-build     # reuse an existing dist/linux-unpacked
RPM_TOPDIR=/var/tmp/rpmbuild packaging/rpm/build-rpm.sh
```

In fish, that env var goes in front the same way (`env RPM_TOPDIR=… script`) or
as `set -x RPM_TOPDIR /var/tmp/rpmbuild` first.

---

## 3. Build the RPM (manual, step by step)

Same thing, spelled out — useful when a step fails and you want to poke at the
intermediate state.

### 3a. Unpacked app

**bash**

```bash
source .venv/bin/activate
npm run build:linux-dir
```

**fish**

```fish
source .venv/bin/activate.fish
npm run build:linux-dir
```

Output lands in `dist/linux-unpacked/`: the Electron runtime,
`resources/app.asar`, `resources/python-sidecar/sidecar`, and a
`naval-defence` launcher. Sanity check it before packaging:

```sh
./dist/linux-unpacked/naval-defence
```

The splash appears, then the main UI once the sidecar answers `/api/health`
(up to 30 s on a cold start; `electron/main.js` gives up after that).

### 3b. Stage sources

**bash**

```bash
VERSION=$(node -p 'require("./package.json").version')
mkdir -p ~/rpmbuild/{SOURCES,SPECS,RPMS,SRPMS,BUILD,BUILDROOT}

tar -C dist -czf ~/rpmbuild/SOURCES/naval-defence-management-tool-$VERSION-linux-x86_64.tar.gz linux-unpacked
cp packaging/rpm/naval-defence.sh packaging/rpm/naval-defence.desktop LICENSE ~/rpmbuild/SOURCES/
cp assets/icon-128.png ~/rpmbuild/SOURCES/icon-128.png
cp assets/icon.png     ~/rpmbuild/SOURCES/icon-512.png
cp packaging/rpm/naval-defence-management-tool.spec ~/rpmbuild/SPECS/
```

**fish**

```fish
set VERSION (node -p 'require("./package.json").version')
mkdir -p ~/rpmbuild/{SOURCES,SPECS,RPMS,SRPMS,BUILD,BUILDROOT}

tar -C dist -czf ~/rpmbuild/SOURCES/naval-defence-management-tool-$VERSION-linux-x86_64.tar.gz linux-unpacked
cp packaging/rpm/naval-defence.sh packaging/rpm/naval-defence.desktop LICENSE ~/rpmbuild/SOURCES/
cp assets/icon-128.png ~/rpmbuild/SOURCES/icon-128.png
cp assets/icon.png     ~/rpmbuild/SOURCES/icon-512.png
cp packaging/rpm/naval-defence-management-tool.spec ~/rpmbuild/SPECS/
```

(Only the variable assignment differs. Note fish has **no heredocs** — that is
why the desktop file and wrapper are repo files you `cp`, rather than something
you `cat <<EOF` into place.)

### 3c. rpmbuild

**bash**

```bash
rpmbuild -bb --define "appversion $VERSION" ~/rpmbuild/SPECS/naval-defence-management-tool.spec
```

**fish**

```fish
rpmbuild -bb --define "appversion $VERSION" ~/rpmbuild/SPECS/naval-defence-management-tool.spec
```

---

## 4. Install & verify

```sh
# Locally built, unsigned → skip the signature check
sudo zypper --no-gpg-checks install ~/rpmbuild/RPMS/x86_64/naval-defence-management-tool-2.0.3-0.x86_64.rpm

naval-defence          # or launch it from the app menu
```

Inspect before/after installing:

```sh
rpm -qip  ~/rpmbuild/RPMS/x86_64/naval-defence-*.rpm      # metadata
rpm -qlp  ~/rpmbuild/RPMS/x86_64/naval-defence-*.rpm      # file list
rpm -qplv ~/rpmbuild/RPMS/x86_64/naval-defence-*.rpm | grep chrome-sandbox
#   want: -rwsr-xr-x  ... /opt/naval-defence-management-tool/chrome-sandbox
rpm -qpR  ~/rpmbuild/RPMS/x86_64/naval-defence-*.rpm      # requires — should be
#   a short soname list, NOT dozens of entries pointing back into /opt
```

Runtime log (spawn path, sidecar stdout/stderr, health timing):

```sh
tail -f ~/.config/naval-defence-management-tool/sidecar.log
```

Uninstall — leaves `~/.config/…` and the sidecar's `eve_auth/` alone:

```sh
sudo zypper remove naval-defence-management-tool
```

---

## 5. What was wrong with the first version of this flow

Recorded because most of these fail *late* — at `rpmbuild` or at first launch,
after a 10-minute Electron build.

| Problem | Why it broke | Fix now in the spec |
|---|---|---|
| `%define __brp_strip %{nil}`, `__brp_strip_static_archive`, `__brp_check_rpaths` | Fedora macros. They do **nothing** on openSUSE, where the brp chain hangs off `%__os_install_post`. Stripping corrupts the Electron binaries and the PyInstaller one-file archive. | `%global __os_install_post %{nil}` + `%global _build_id_links none` alongside `debug_package %{nil}` |
| Auto-generated **Provides** | rpm exports the bundled `libEGL.so`, `libGLESv2.so`, `libvulkan.so.1`, `libffmpeg.so` as system-wide provides — zypper can then satisfy *other* packages from your app bundle. | `%__provides_exclude_from ^/opt/…` |
| Auto-generated **Requires** | Worse in combination with the above: rpm generates `Requires: libGLESv2.so()(64bit)` from a bundled lib whose only provider was the provide you just suppressed → **package refuses to install**. | `%__requires_exclude_from ^/opt/…` plus an explicit soname `Requires:` list |
| `chrome-sandbox` listed twice in `%files` (once via `/opt/%{name}`, once via `%attr`) | rpm's "File listed twice" case; which entry's mode wins is not something to bet a setuid bit on. | `chmod 4755` in `%install`, tree listed once, and `build-rpm.sh` asserts `-rws` on the finished RPM |
| `ln -sf` into `%{_bindir}` | A symlink gives nowhere to set `TMPDIR` for the sidecar or pass Chromium flags. | Real wrapper script, `packaging/rpm/naval-defence.sh` |
| Desktop entry | Missing `Terminal=` (required for `Type=Application`) and `StartupWMClass` (Wayland/GNOME shows a generic icon and a separate taskbar group without it); `Exec=… %U` advertised URL handling the app does not implement. | Fixed and `desktop-file-validate`-clean |
| Hard-coded `Version: 2.0.3` | Silently drifts from `package.json`. | `-D "appversion …"`, read from `package.json` |
| No `linux` block in `package.json` | `electron-builder --linux` had no `executableName`, so the launcher was named after `productName` — spaces and all — and nothing matched `Exec=naval-defence`. | `build.linux` added |
| `source .venv/bin/activate` | bash-only syntax; errors out in fish. | `activate.fish` documented; `build-rpm.sh` sidesteps activation entirely |
| `zypper install … npm` | On Tumbleweed the npm package is versioned (`npm22`); a bare `npm` may not resolve. `binutils` was missing and PyInstaller needs it. | Corrected in §1 |
| 128×128 icon only | Blurry on HiDPI. | 128 and 512 both installed into hicolor |

---

## 6. Gotchas at runtime

| Symptom | Cause / fix |
|---|---|
| `The SUID sandbox helper binary was found, but is not configured correctly` | `chrome-sandbox` lost its setuid bit. Check `rpm -qplv … \| grep chrome-sandbox`; do **not** "fix" it by adding `--no-sandbox`. |
| Splash appears, UI never does; `sidecar.log` shows `Failed to execute script` | PyInstaller one-file unpacks into `$TMPDIR`. If `/tmp` is `noexec`, exec fails. The wrapper already redirects `TMPDIR` to `~/.cache/naval-defence/tmp`; if you launched `/opt/…/naval-defence` directly, you bypassed it. |
| `Python sidecar did not respond on /api/health within 30s` | Look at `sidecar.log` — usually a missing hidden import. Add it to `hiddenimports` in [python/sidecar.spec](python/sidecar.spec) and rebuild. |
| Port already in use after a crash | `electron/main.js` `pkill -x sidecar`s orphans at startup; if it persists, kill it by hand. |
| Blurry/black window on Wayland | `NAVAL_DEFENCE_FLAGS="--ozone-platform=wayland" naval-defence` (fish: `env NAVAL_DEFENCE_FLAGS=… naval-defence`). |
| `rpmlint` complains: bundled libs, `/opt`, no build-id, setuid file | Expected for any Electron app; not resolvable without un-bundling Chromium. |
| Installs on Tumbleweed, fails on Leap | The sidecar is linked against the glibc of the machine that built it. Build on the oldest target you care about. |
| User data | `~/.config/naval-defence-management-tool/` — Electron derives `userData` from package.json `name`, *not* `build.productName`. Holds `eve_auth/` and `sidecar.log`. Untouched by install/remove. |

---

## 7. Alternative: let electron-builder emit the RPM

Faster, but the packaging is auto-generated: no `%files` control, no wrapper,
no soname `Requires` list, and it drops the app in `/opt/<productName with
spaces>`.

```sh
npm run build:linux-rpm     # electron-builder --linux rpm --publish never
```

`package.json` already carries the `maintainer` field this target requires —
without it electron-builder aborts with *"Please specify author 'email' in the
application package.json"*. Needs `rpm-build` installed. You also have to switch
`build.linux.target` from `dir` to `rpm`, or pass the target explicitly as
above. Output goes to `dist/*.rpm`.

Use this if you just want a working package on your own machine and don't care
about spec-file control.

---

## 8. Build-verification record

Run on Tumbleweed 20260717 (rpm 4.20.1, node 24.18.0, npm 11.16.0, Python 3.13):

```
Built: ~/rpmbuild/RPMS/x86_64/naval-defence-management-tool-2.0.3-0.x86_64.rpm
  275 MiB, 85 files
  -rwsr-xr-x  /opt/naval-defence-management-tool/chrome-sandbox        (setuid ok)
  -rwxr-xr-x  /opt/naval-defence-management-tool/resources/python-sidecar/sidecar
  -rw-r--r--  /opt/naval-defence-management-tool/resources/app.asar
  Provides:   only the package itself + application(...) — no bundled sonames leaked
  Requires:   /bin/sh + 13 sonames, all resolving to installed packages
  Sidecar:    boots standalone, GET /api/health → {"ok":true}
  App:        packaged binary launches, full nav renders, splash→main in 1.4s
```

Two non-fatal notes from that run:

- **npm ≥ 11 gates lifecycle scripts.** `npm install` warns that `electron@28.3.3`
  (`postinstall: node install.js`) and `unrs-resolver` are "not yet covered by
  allowScripts". The postinstall still ran here, but if it is ever blocked,
  `node_modules/electron/dist` ends up empty and `electron-builder` fails in a
  way that does not name the cause. Check `du -sh node_modules/electron/dist`
  (expect ~253 MB) if a Linux build suddenly breaks.
- `rpmbuild` prints *"Macro expanded in comment"* for any `%{...}` in a spec
  comment. Harmless; the comments in the spec now escape as `%%{...}`.

---

## 9. aarch64

Untested. `electron-builder --linux dir --arm64` produces the tree, but the
PyInstaller sidecar is *not* cross-compiled — it must be built on an ARM host.
The spec's `BuildArch: x86_64` and `()(64bit)` dependency suffixes would need
adjusting too.
