"""Rebuild python/data/eve.db from a Pyfa source checkout.

The fitting engine (python/pyfa/eos) needs Pyfa's `eve.db`, built from CCP's
static data. That build lives in Pyfa's own `db_update.py` + `staticdata/`
(~240 MB of JSON) which we do NOT vendor — only the resulting eve.db (~96 MB)
is committed. To refresh it after an EVE patch:

    1. Clone Pyfa:  git clone --depth 1 https://github.com/pyfa-org/Pyfa
    2. Install the engine deps (see requirements.txt): sqlalchemy==1.4.50 logbook ...
    3. python build_eve_db.py /path/to/Pyfa
    4. Copy Pyfa/eve.db -> python/data/eve.db and commit.

Upstream `eos.db.migration` does `import config` (Pyfa's wx GUI config); this
injects a wx-free stub so the build runs headless, exactly as the app does.
"""
import os
import runpy
import sys
import types


def main(pyfa_dir):
    pyfa_dir = os.path.abspath(pyfa_dir)
    if not os.path.exists(os.path.join(pyfa_dir, 'db_update.py')):
        raise SystemExit(f'{pyfa_dir} is not a Pyfa checkout (no db_update.py).')
    os.chdir(pyfa_dir)
    sys.path.insert(0, pyfa_dir)
    stub = types.ModuleType('config')
    stub.savePath = os.path.abspath('.')
    stub.saveDB = os.path.abspath('saveddata_dummy.db')
    sys.modules['config'] = stub
    runpy.run_path('db_update.py', run_name='__main__')
    print(f'\nBuilt {os.path.join(pyfa_dir, "eve.db")} — copy it to python/data/eve.db')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: python build_eve_db.py /path/to/Pyfa')
    main(sys.argv[1])
