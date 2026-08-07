# Third-party notice — Pyfa `eos` fitting engine

The ship-fitting feature embeds the **`eos`** calculation engine from
**[Pyfa](https://github.com/pyfa-org/Pyfa)** (Python Fitting Assistant), vendored
under [`python/pyfa/eos`](python/pyfa/eos). The game database
(`python/data/eve.db`) is built from Pyfa's bundled EVE static data via
`python/build_eve_db.py`.

## Licensing
`eos` is distributed by Pyfa mostly under the **GNU Lesser General Public License**,
but its calculation core (`eos/calc.py`, `eos/const.py`) is under the **GNU General
Public License v3**. Because those GPL files are included and linked into this
application, **this application as distributed is licensed under the GPL v3**.

- Pyfa license text: [`python/pyfa/PYFA-LICENSE.txt`](python/pyfa/PYFA-LICENSE.txt) (GPLv3)
- eos LGPL text: [`python/pyfa/lgpl.txt`](python/pyfa/lgpl.txt)

## Source offer
Complete corresponding source for this application (including any modifications to
`eos`) is available to recipients of the built installers. The upstream engine is
at https://github.com/pyfa-org/Pyfa. Local modifications to the vendored copy are
limited and marked in-file (e.g. the headless `config` shim in
`python/pyfa/eos/db/migration.py`).

EVE Online and all related materials are property of CCP hf.
