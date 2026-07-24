#!/usr/bin/env bash
#
# Build the openSUSE RPM for the Naval Defence Alliance Management Tool.
#
#   packaging/rpm/build-rpm.sh              # sidecar + electron + rpm
#   packaging/rpm/build-rpm.sh --skip-build # reuse an existing dist/linux-unpacked
#
# Shell-agnostic on purpose: it puts .venv/bin on PATH itself instead of
# relying on `source .venv/bin/activate`, so it behaves identically under
# bash, fish, zsh or a bare /bin/sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
TOPDIR="${RPM_TOPDIR:-$HOME/rpmbuild}"
SKIP_BUILD=0

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

cd "$REPO_ROOT"

# --- preflight -------------------------------------------------------------
for tool in node npm rpmbuild tar; do
    command -v "$tool" >/dev/null || die "$tool not found — see packaging-naval-defence-rpm.md §1"
done

if [ -x .venv/bin/pyinstaller ]; then
    PATH="$REPO_ROOT/.venv/bin:$PATH"
    export PATH
elif ! command -v pyinstaller >/dev/null; then
    die "pyinstaller not found (expected .venv/bin/pyinstaller) — see §1"
fi

[ -d node_modules ] || die "node_modules missing — run: npm install"

VERSION="$(node -p 'require("./package.json").version')"
[ -n "$VERSION" ] || die "could not read version from package.json"
echo "Naval Defence Alliance Management Tool ${VERSION} → RPM (topdir: ${TOPDIR})"

# --- 1. electron + sidecar -------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
    step "Building Python sidecar and unpacked Electron app"
    npm run build:linux-dir
else
    step "Skipping build (--skip-build)"
fi

[ -d dist/linux-unpacked ] || die "dist/linux-unpacked missing — run without --skip-build"
[ -x dist/linux-unpacked/naval-defence ] \
    || die "dist/linux-unpacked/naval-defence missing — is \"executableName\" set in package.json build.linux?"
[ -x dist/linux-unpacked/resources/python-sidecar/sidecar ] \
    || die "sidecar missing from resources/ — did 'npm run build:python' succeed?"

# --- 2. stage sources ------------------------------------------------------
step "Staging ${TOPDIR}"
mkdir -p "$TOPDIR"/{SOURCES,SPECS,RPMS,SRPMS,BUILD,BUILDROOT}

TARBALL="$TOPDIR/SOURCES/naval-defence-management-tool-${VERSION}-linux-x86_64.tar.gz"
tar -C dist -czf "$TARBALL" linux-unpacked

cp "$SCRIPT_DIR/naval-defence.sh"      "$TOPDIR/SOURCES/"
cp "$SCRIPT_DIR/naval-defence.desktop" "$TOPDIR/SOURCES/"
cp assets/icon-128.png                 "$TOPDIR/SOURCES/icon-128.png"
cp assets/icon.png                     "$TOPDIR/SOURCES/icon-512.png"
cp LICENSE                             "$TOPDIR/SOURCES/LICENSE"
cp "$SCRIPT_DIR/naval-defence-management-tool.spec" "$TOPDIR/SPECS/"

# --- 3. rpmbuild -----------------------------------------------------------
step "rpmbuild"
rpmbuild -bb \
    --define "_topdir $TOPDIR" \
    --define "appversion $VERSION" \
    "$TOPDIR/SPECS/naval-defence-management-tool.spec"

RPM="$TOPDIR/RPMS/x86_64/naval-defence-management-tool-${VERSION}-0.x86_64.rpm"
[ -f "$RPM" ] || die "expected $RPM but it was not produced"

# --- 4. self-check ---------------------------------------------------------
step "Verifying"
# NB: capture first, test after. `rpm -qplv | grep -q` is a race — grep exits on
# the first match, rpm dies of SIGPIPE, and `set -o pipefail` then reports the
# whole pipeline as failed even though the match succeeded.
CONTENTS="$(rpm -qplv "$RPM")"
case "$(printf '%s\n' "$CONTENTS" | grep 'chrome-sandbox$')" in
    -rws*) echo "  ok: chrome-sandbox is setuid root" ;;
    *)     echo "  WARNING: chrome-sandbox is not setuid — the app will need --no-sandbox" >&2 ;;
esac
printf '%s\n' "$CONTENTS" | grep -E '/usr/bin/|/applications/|/icons/' || true

echo
echo "Built: $RPM"
echo "Install with: sudo zypper --no-gpg-checks install \"$RPM\""
