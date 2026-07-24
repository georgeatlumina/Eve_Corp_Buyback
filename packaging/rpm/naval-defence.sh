#!/bin/sh
# /usr/bin/naval-defence — launcher for the vendored /opt install.
#
# A wrapper rather than a symlink: the symlink form gives no place to set
# TMPDIR, which the PyInstaller sidecar needs, or to pass Chromium flags.

APPDIR=/opt/naval-defence-management-tool

# The sidecar is a PyInstaller one-file binary: it unpacks itself into
# $TMPDIR/_MEIxxxxxx and execs from there. A noexec /tmp (common on hardened
# setups) makes that fail with "Failed to execute script". Give it a private,
# always-exec directory instead. Electron passes its own env down to the
# sidecar, so exporting here is enough.
if [ -z "${TMPDIR:-}" ]; then
    TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/naval-defence/tmp"
    mkdir -p "$TMPDIR" 2>/dev/null || TMPDIR=/tmp
    export TMPDIR
fi

# Escape hatch for Chromium flags, e.g.
#   NAVAL_DEFENCE_FLAGS="--ozone-platform=wayland --enable-features=WaylandWindowDecorations"
# shellcheck disable=SC2086
exec "$APPDIR/naval-defence" ${NAVAL_DEFENCE_FLAGS:-} "$@"
