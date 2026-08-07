from logbook import Logger
import shutil
import time

# --- Vendored for headless use (Eve Corp Buyback) ------------------------------
# Upstream Pyfa does `import config`, pulling in its wxPython GUI config module.
# Only config.savePath / config.saveDB are used here, and only when migrating a
# *persistent* saveddata DB — never for the in-memory saveddata this app runs.
# A self-contained stub keeps eos fully decoupled from the app's own config.py.
import os as _os
import types as _types
config = _types.ModuleType('config')
config.savePath = _os.path.expanduser('~')
config.saveDB = ':memory:'
# ------------------------------------------------------------------------------
from . import migrations

pyfalog = Logger(__name__)


def getVersion(db):
    cursor = db.execute('PRAGMA user_version')
    return cursor.fetchone()[0]


def getAppVersion():
    return migrations.appVersion


def update(saveddata_engine):
    dbVersion = getVersion(saveddata_engine)
    appVersion = getAppVersion()

    if dbVersion == appVersion:
        return

    if dbVersion < appVersion:
        # Automatically backup database
        toFile = "%s/saveddata_migration_%d-%d_%s.db" % (
            config.savePath,
            dbVersion,
            appVersion,
            time.strftime("%Y%m%d_%H%M%S"))

        shutil.copyfile(config.saveDB, toFile)

        for version in range(dbVersion, appVersion):
            func = migrations.updates[version + 1]
            if func:
                pyfalog.info("Applying database update: {0}", version + 1)
                func(saveddata_engine)

        # when all is said and done, set version to current
        saveddata_engine.execute("PRAGMA user_version = {}".format(appVersion))
