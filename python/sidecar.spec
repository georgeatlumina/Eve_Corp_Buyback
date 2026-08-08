# PyInstaller spec for the Naval Defence Alliance Management Tool Python sidecar.
# Build with: pyinstaller python/sidecar.spec
# -*- mode: python ; coding: utf-8 -*-

import os
import sys

from PyInstaller.utils.hooks import collect_submodules

block_cipher = None
is_windows = sys.platform == 'win32'
SPEC_DIR = os.path.dirname(os.path.abspath(SPEC))

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
    'industry',
    'janice',
    'liquidation',
    'market',
    'pi',
    'pi_layout',
    'pinned',
    'refining',
    'stockpile',
    'validate',
    'workforce_plan',
    'pyfa_engine',
]

# The Fitting tab embeds Pyfa's vendored `eos` engine (python/pyfa), which is
# loaded off sys.path at runtime and imports these dynamically — so PyInstaller's
# static analysis can't see them. Collect them explicitly. (eos itself is bundled
# as data below and imported from disk, which handles its by-name effect imports.)
hidden_imports += collect_submodules('sqlalchemy')
hidden_imports += ['numpy', 'logbook', 'roman', 'dateutil', 'greenlet']

# uvloop is a Unix-only event loop; pulling it in on Windows causes import
# failures at runtime. uvicorn's `auto` loop selector falls back to asyncio
# when uvloop is unavailable, which is what we want here.
if not is_windows:
    hidden_imports.append('uvicorn.loops.uvloop')

a = Analysis(
    ['server.py'],
    pathex=[os.path.dirname(os.path.abspath(SPEC))],
    binaries=[],
    # Bundle the whole data/ directory into <frozen>/data/ (loaded via
    # sys._MEIPASS/data/ at runtime): the reprocessing-yields CSV for moon
    # refining, plus the PI datasets (pi_data.json, pi_pins.json,
    # eve_systems.json). Bundling the directory means new data files are
    # picked up automatically.
    # data/ holds the refining CSV, PI + industry datasets, and the Fitting
    # engine's eve.db. pyfa/ is the vendored Pyfa `eos` engine (+ its utils),
    # bundled as source so it can be imported off sys.path at runtime
    # (pyfa_engine adds sys._MEIPASS/pyfa to the path). eos loads its ~hundreds
    # of effect modules by name, so shipping the .py tree is more reliable than
    # freezing it into the archive.
    datas=[
        (os.path.join(SPEC_DIR, 'data'), 'data'),
        (os.path.join(SPEC_DIR, 'pyfa'), 'pyfa'),
    ],
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
