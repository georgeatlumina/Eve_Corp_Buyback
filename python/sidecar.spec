# PyInstaller spec for the Naval Defence Alliance Management Tool Python sidecar.
# Build with: pyinstaller python/sidecar.spec
# -*- mode: python ; coding: utf-8 -*-

import os
import sys

block_cipher = None
is_windows = sys.platform == 'win32'

# uvicorn relies on dynamically-imported submodules that PyInstaller's static
# analysis doesn't always pick up. Local sibling modules of server.py are
# listed here too — Windows PyInstaller has historically missed sibling
# modules that aren't at the top of the entry file even though Mac is fine.
hidden_imports = [
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'uvicorn.lifespan.off',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.http.httptools_impl',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.websockets_impl',
    'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.loops.asyncio',
    'uvicorn.logging',
    'h11',
    'httptools',
    'websockets',
    # Local modules — also imported at the top of server.py, but listing them
    # here defends against bundler quirks that have surfaced on Windows.
    'auth',
    'config',
    'esi',
    'janice',
    'pinned',
    'refining',
    'validate',
]

# uvloop is a Unix-only event loop; pulling it in on Windows causes import
# failures at runtime. uvicorn's `auto` loop selector falls back to asyncio
# when uvloop is unavailable, which is what we want here.
if not is_windows:
    hidden_imports.append('uvicorn.loops.uvloop')

a = Analysis(
    ['server.py'],
    pathex=[os.path.dirname(os.path.abspath(SPEC))],
    binaries=[],
    datas=[],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
