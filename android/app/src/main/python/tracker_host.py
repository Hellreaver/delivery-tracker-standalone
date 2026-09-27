"""Runs the tracker's server (app.py, copied here by build.sh) inside the
Android app, on 127.0.0.1 only, with the database in the app's private files.

The Kotlin side calls start() once per process, then backup_to() and
restore_from() for the Settings > Backup buttons.
"""

import os
import sqlite3
import threading
from contextlib import closing

_server = None
_lock = threading.Lock()
REQUIRED_TABLES = {"entries", "settings", "targets", "sessions", "deliveries"}


def start(data_dir, port):
    """Start serving in a background thread. Safe to call more than once."""
    global _server
    with _lock:
        if _server is not None:
            return
        os.environ["DATA_DIR"] = data_dir
        os.environ["PORT"] = str(port)
        os.environ["HOST"] = "127.0.0.1"
        import app  # reads DATA_DIR/PORT at import time
        app.init_db()
        srv = app.ThreadingHTTPServer(("127.0.0.1", int(port)), app.Handler)
        srv.daemon_threads = True
        # serve_forever wakes every poll_interval seconds only to check for a
        # shutdown that never comes; requests wake it immediately regardless.
        # The default 0.5 s would stop the phone idling during a shift.
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 3600},
                         name="tracker-http", daemon=True).start()
        _server = srv


def db_path():
    import app
    return app.DB_PATH


def backup_to(path):
    """Write a consistent copy of the live database to `path`, even mid-write."""
    import app
    if os.path.exists(path):
        os.remove(path)
    with closing(sqlite3.connect(app.DB_PATH, timeout=15)) as src, closing(sqlite3.connect(path)) as dst:
        src.backup(dst)
    return os.path.getsize(path)


def restore_from(path):
    """Replace the live database with the one at `path`. Returns "" or an error message."""
    import app
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as src:
            ok = src.execute("PRAGMA integrity_check").fetchone()[0]
            if ok != "ok":
                return "That file is damaged: " + ok
            tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            missing = REQUIRED_TABLES - tables
            if missing:
                return "That isn't a Delivery Tracker backup (missing " + ", ".join(sorted(missing)) + ")."
            with closing(sqlite3.connect(app.DB_PATH, timeout=15)) as dst:
                src.backup(dst)
    except sqlite3.DatabaseError as e:
        return "That file isn't a database this app can read: " + str(e)
    app.init_db()  # upgrades a backup made by an older version
    return ""
