#!/usr/bin/env python3
"""delivery-tracker (standalone): log delivery shifts and compare them to base/stretch targets.

This copy runs on the phone itself (see android/app/src/main/python/tracker_host.py);
the database columns are still named survive/thrive, the screens say base/stretch.

Two ways to record a shift:
  * Live: start a shift, add each delivery as you finish it, then save. The
    deliveries roll up into one entry (gross, paid miles, orders, tips).
  * Manual: type in a whole shift's totals afterwards.

Live-shift changes arrive through /api/sync as a list of operations, each with
a client-generated op_id. A phone with no signal queues them and sends them
later; resending the same op_id never applies it twice.

The Android app also posts GPS points to /api/track. The phone computes the
driven miles and sends them with the finish operation; the points are kept on
the server as the record behind the mileage log.

Every entry stores the gas price, deadhead %, mpg, wear $/mile, IRS mileage rate and tax
set-aside % in effect when it was saved (for a live shift, when it was
started). Changing a default in Settings only affects entries saved
afterwards; old entries keep their own numbers.

Standard library only. State lives in SQLite at $DATA_DIR/tracker.db.
"""

import calendar
import csv
import datetime as dt
import io
import json
import math
import os
import re
import sqlite3
import sys
import traceback
import uuid
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "tracker.db")
APK_PATH = os.path.join(DATA_DIR, "delivery-tracker.apk")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = int(os.environ.get("PORT", "8095"))

# Seeded on first run only. After that, the Settings screen owns these.
DEFAULT_SETTINGS = {
    "gas_price": 4.20,      # $/gal
    "deadhead_pct": 15.0,   # % of driven miles that are unpaid; 15% -> 1.176 driven per paid mile
    "deadhead_mode": "auto",  # auto: median of recent GPS shifts once 3 exist; fixed: deadhead_pct
    "irs_rate": 0.76,       # $/mi IRS standard mileage rate, Jul-Dec 2026
    "tax_rate": 26.0,       # % of (gross - mileage deduction) to set aside
    "shifts_per_week": 5,
    "good_per_mile": 1.25,  # $/paid mile shown green
    "min_per_mile": 0.75,   # $/paid mile below this shows red
    "default_vehicle": "Civic",
    # Starting guesses for a 2019 Civic, meant to be replaced in Settings:
    # mpg is the EPA combined figure for the sedan 2.0L CVT (fueleconomy.gov);
    # 6.5 cents/mi is CarEdge's year-7/8 Civic repair cost (~$760/yr) over
    # 12,000 mi. See README for measuring your own.
    "vehicles": [
        {"name": "Civic", "mpg": 33.0, "maint_per_mile": 0.065},
    ],
}

# Monthly gross targets seeded on first run. $300 a week x 52 / 12 is
# ~$1,300 a month (Stretch); Base is $1,000. A single row applies to every
# month until Settings adds another.
DEFAULT_BASE = 1000.0
DEFAULT_STRETCH = 1300.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT NOT NULL,
    gross         REAL NOT NULL,
    tips          REAL,
    orders        INTEGER,
    hours         REAL,
    paid_miles    REAL NOT NULL,
    driven_miles  REAL,
    miles_source  TEXT,
    vehicle       TEXT,
    mpg           REAL NOT NULL,
    maint_per_mile REAL,
    gas_price     REAL NOT NULL,
    deadhead_pct  REAL NOT NULL,
    irs_rate      REAL NOT NULL,
    tax_rate      REAL NOT NULL,
    notes         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries (date);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
    month   TEXT PRIMARY KEY,
    survive REAL NOT NULL,
    thrive  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT,
    date          TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    status        TEXT NOT NULL DEFAULT 'open',
    entry_id      INTEGER,
    vehicle       TEXT,
    mpg           REAL NOT NULL,
    maint_per_mile REAL,
    gas_price     REAL NOT NULL,
    deadhead_pct  REAL NOT NULL,
    irs_rate      REAL NOT NULL,
    tax_rate      REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT,
    session_id  INTEGER NOT NULL,
    at          TEXT NOT NULL,
    amount      REAL NOT NULL,
    tip         REAL,
    uber_pay    REAL,
    miles       REAL NOT NULL,
    note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_session ON deliveries (session_id);
CREATE TABLE IF NOT EXISTS track_points (
    session_id  INTEGER NOT NULL,
    t           INTEGER NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    acc         REAL,
    spd         REAL,
    PRIMARY KEY (session_id, t)
);
-- Every fix the phone heard while a shift ran, including ones other apps asked
-- for. Measurement only: nothing reads this for mileage, maps or earnings.
CREATE TABLE IF NOT EXISTS passive_points (
    session_id  INTEGER NOT NULL,
    t           INTEGER NOT NULL,
    prov        TEXT NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    acc         REAL,
    spd         REAL,
    PRIMARY KEY (session_id, t, prov)
);
CREATE TABLE IF NOT EXISTS ops_log (
    op_id       TEXT PRIMARY KEY,
    type        TEXT,
    ok          INTEGER NOT NULL,
    error       TEXT,
    applied_at  TEXT NOT NULL
);
"""

ENTRY_COLUMNS = (
    "date", "gross", "tips", "orders", "hours", "paid_miles", "driven_miles", "miles_source",
    "vehicle", "mpg", "maint_per_mile", "gas_price", "deadhead_pct", "irs_rate", "tax_rate", "notes",
)
COST_FIELDS = (
    ("gas_price", "Gas price", 0, 50),
    ("deadhead_pct", "Deadhead", 0, 90),
    ("irs_rate", "IRS rate", 0, 5),
    ("tax_rate", "Tax set-aside", 0, 100),
)
MILES_SOURCES = ("gps", "entered")
MILEAGE_PURPOSE = "Food delivery (Uber Eats)"

STATIC_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "manifest.webmanifest": "application/manifest+json",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "apple-touch-icon.png": "image/png",
    "favicon-32.png": "image/png",
}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
CID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class HTTPError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def bad(message):
    return HTTPError(400, message)


def now_utc():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_cid():
    return uuid.uuid4().hex


# ---------------------------------------------------------------- storage

def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def columns(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with closing(connect()) as conn:
        conn.executescript(SCHEMA)
        with conn:
            # Upgrades for databases created by earlier versions.
            if "miles_source" not in columns(conn, "entries"):
                conn.execute("ALTER TABLE entries ADD COLUMN miles_source TEXT")
                conn.execute("UPDATE entries SET miles_source = 'entered' WHERE driven_miles IS NOT NULL")
            if "client_id" not in columns(conn, "sessions"):
                conn.execute("ALTER TABLE sessions ADD COLUMN client_id TEXT")
            if "client_id" not in columns(conn, "deliveries"):
                conn.execute("ALTER TABLE deliveries ADD COLUMN client_id TEXT")
            conn.execute("UPDATE sessions SET client_id = 'srv-s' || id WHERE client_id IS NULL")
            conn.execute("UPDATE deliveries SET client_id = 'srv-d' || id WHERE client_id IS NULL")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_client ON sessions (client_id)")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_deliveries_client ON deliveries (client_id)")
            # Uber's own pay (fare and promotions). The tip is the rest of
            # the total, so an old row's tip tells us what Uber paid.
            if "uber_pay" not in columns(conn, "deliveries"):
                conn.execute("ALTER TABLE deliveries ADD COLUMN uber_pay REAL")
                conn.execute("UPDATE deliveries SET uber_pay = ROUND(amount - tip, 2) WHERE tip IS NOT NULL")
            for table in ("entries", "sessions"):
                if "maint_per_mile" not in columns(conn, table):
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN maint_per_mile REAL")
            for key, value in DEFAULT_SETTINGS.items():
                conn.execute(
                    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                    (key, json.dumps(value)),
                )
            # Shifts saved before wear was tracked get their vehicle's measured
            # rate, once. After this every new shift carries its own value.
            rates = {v["name"]: v["maint_per_mile"] for v in load_settings(conn)["vehicles"]}
            for table in ("entries", "sessions"):
                for name, rate in rates.items():
                    conn.execute(f"UPDATE {table} SET maint_per_mile = ? WHERE maint_per_mile IS NULL AND vehicle = ?",
                                 (rate, name))
                conn.execute(f"UPDATE {table} SET maint_per_mile = 0 WHERE maint_per_mile IS NULL")
            if conn.execute("SELECT COUNT(*) FROM targets").fetchone()[0] == 0:
                conn.execute(
                    "INSERT INTO targets (month, survive, thrive) VALUES (?, ?, ?)",
                    (dt.date.today().strftime("%Y-%m"), DEFAULT_BASE, DEFAULT_STRETCH),
                )


def load_settings(conn):
    settings = json.loads(json.dumps(DEFAULT_SETTINGS))
    for row in conn.execute("SELECT key, value FROM settings"):
        settings[row["key"]] = json.loads(row["value"])
    # Vehicles saved before wear was tracked take the default rate for their name.
    defaults = {v["name"]: v["maint_per_mile"] for v in DEFAULT_SETTINGS["vehicles"]}
    for v in settings.get("vehicles", []):
        v.setdefault("maint_per_mile", defaults.get(v["name"], 0.0))
    return settings


def load_targets(conn):
    return [dict(r) for r in conn.execute(
        "SELECT month, survive, thrive FROM targets ORDER BY month")]


def get_entry_raw(conn, entry_id):
    row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if row is None:
        raise HTTPError(404, "entry not found")
    return dict(row)


def insert_entry_sql(conn, e):
    """Insert without committing, so callers can wrap it in a larger transaction."""
    ts = now_utc()
    cols = ENTRY_COLUMNS + ("created_at", "updated_at")
    cur = conn.execute(
        f"INSERT INTO entries ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
        [e[c] for c in ENTRY_COLUMNS] + [ts, ts],
    )
    return cur.lastrowid


def insert_entry(conn, e):
    with conn:
        return insert_entry_sql(conn, e)


def update_entry(conn, entry_id, e):
    sets = ", ".join(f"{c} = ?" for c in ENTRY_COLUMNS)
    with conn:
        conn.execute(
            f"UPDATE entries SET {sets}, updated_at = ? WHERE id = ?",
            [e[c] for c in ENTRY_COLUMNS] + [now_utc(), entry_id],
        )


def delete_session_rows(conn, session_id):
    conn.execute("DELETE FROM deliveries WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM track_points WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM passive_points WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


def delete_entry(conn, entry_id):
    """Delete an entry and the live-shift deliveries and GPS track rolled into it."""
    with conn:
        for (sid,) in conn.execute("SELECT id FROM sessions WHERE entry_id = ?", (entry_id,)).fetchall():
            delete_session_rows(conn, sid)
        conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))


def list_entries(conn, q):
    start = iso_date(q["start"], "start").isoformat() if q.get("start") else "0000-01-01"
    end = iso_date(q["end"], "end").isoformat() if q.get("end") else "9999-12-31"
    limit = int(number(q.get("limit", 2000), "limit", 1, 10000))
    rows = conn.execute(
        "SELECT e.*, (SELECT COUNT(*) FROM sessions s WHERE s.entry_id = e.id) AS from_live "
        "FROM entries e WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC LIMIT ?",
        (start, end, limit),
    )
    return [compute(dict(r)) for r in rows]


# ---------------------------------------------------------------- validation

def number(value, name, lo=None, hi=None, required=True):
    if value is None or (isinstance(value, str) and value.strip() == ""):
        if required:
            raise bad(f"{name} is required")
        return None
    if isinstance(value, bool):
        raise bad(f"{name} must be a number")
    try:
        x = float(value)
    except (TypeError, ValueError):
        raise bad(f"{name} must be a number")
    if not math.isfinite(x):
        raise bad(f"{name} must be a number")
    if lo is not None and x < lo:
        raise bad(f"{name} must be at least {lo:g}")
    if hi is not None and x > hi:
        raise bad(f"{name} must be at most {hi:g}")
    return x


def blank(value):
    return value is None or (isinstance(value, str) and value.strip() == "")


def iso_date(value, name="date"):
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise bad(f"{name} must be YYYY-MM-DD")
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        raise bad(f"{name} is not a real date")


def timestamp(value, name):
    """ISO 8601 with a timezone -> normalized UTC 'YYYY-MM-DDTHH:MM:SSZ'."""
    if not isinstance(value, str):
        raise bad(f"{name} must be a timestamp")
    try:
        t = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise bad(f"{name} must be an ISO timestamp")
    if t.tzinfo is None:
        raise bad(f"{name} needs a timezone")
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def text(value, name, max_len):
    if value is None:
        return None
    if not isinstance(value, str):
        raise bad(f"{name} must be text")
    value = value.strip()
    if len(value) > max_len:
        raise bad(f"{name} is longer than {max_len} characters")
    return value or None


def client_id(value, name="id"):
    if not isinstance(value, str) or not CID_RE.match(value):
        raise bad(f"{name} is missing or malformed")
    return value


def vehicle_mpg(settings, name):
    for v in settings.get("vehicles", []):
        if v["name"] == name:
            return v["mpg"]
    vehicles = settings.get("vehicles") or []
    return vehicles[0]["mpg"] if vehicles else None


def vehicle_maint(settings, name):
    for v in settings.get("vehicles", []):
        if v["name"] == name:
            return v.get("maint_per_mile", 0.0)
    return 0.0


def resolve_costs(body, settings, stored=None):
    """Vehicle, mpg and the four cost fields. Blank values fall back to the
    stored record (when editing) and then to the current defaults."""
    stored = stored or {}
    out = {}
    vehicle = (text(body.get("vehicle"), "Vehicle", 40)
               or stored.get("vehicle") or settings.get("default_vehicle"))
    out["vehicle"] = vehicle
    if not blank(body.get("mpg")):
        out["mpg"] = number(body["mpg"], "MPG", 1, 200)
    elif stored.get("mpg") is not None and stored.get("vehicle") == vehicle:
        out["mpg"] = stored["mpg"]
    else:
        out["mpg"] = number(vehicle_mpg(settings, vehicle), "MPG", 1, 200)
    if not blank(body.get("maint_per_mile")):
        out["maint_per_mile"] = number(body["maint_per_mile"], "Wear $/mi", 0, 2)
    elif stored.get("maint_per_mile") is not None and stored.get("vehicle") == vehicle:
        out["maint_per_mile"] = stored["maint_per_mile"]
    else:
        out["maint_per_mile"] = number(vehicle_maint(settings, vehicle), "Wear $/mi", 0, 2)
    for key, name, lo, hi in COST_FIELDS:
        if not blank(body.get(key)):
            value = body[key]
        elif stored.get(key) is not None:
            value = stored[key]
        else:
            value = settings[key]
        out[key] = number(value, name, lo, hi)
    return out


def build_entry(body, settings, stored=None):
    """Validate an entry payload.

    A cost field (gas, deadhead, mpg, IRS rate, tax %) left blank comes from
    the stored entry when editing, or from the current defaults when creating.
    Whatever value results is written onto the entry and never recomputed from
    Settings again. That is what stops Thursday's gas price from rewriting
    Tuesday's shift.
    """
    if not isinstance(body, dict):
        raise bad("entry must be a JSON object")
    stored = stored or {}

    def raw(key):
        return body[key] if key in body else stored.get(key)

    e = {}
    e["date"] = iso_date(raw("date")).isoformat()
    e["gross"] = number(raw("gross"), "Gross", 0, 100000)
    e["paid_miles"] = number(raw("paid_miles"), "Paid miles", 0, 5000)
    e["tips"] = number(raw("tips"), "Tips", 0, 100000, required=False)
    if e["tips"] is not None and e["tips"] > e["gross"]:
        raise bad("Tips can't be more than gross")
    orders = number(raw("orders"), "Orders", 0, 1000, required=False)
    e["orders"] = int(round(orders)) if orders is not None else None
    e["hours"] = number(raw("hours"), "Hours", 0, 24, required=False)
    e["driven_miles"] = number(raw("driven_miles"), "Driven miles", 0, 5000, required=False)
    e["notes"] = text(raw("notes"), "Notes", 500)

    # Where the driven miles came from: 'gps' (phone), 'entered' (typed), or
    # None when they're estimated from paid miles and deadhead.
    source = body.get("miles_source")
    if e["driven_miles"] is None:
        e["miles_source"] = None
    elif source in MILES_SOURCES and "driven_miles" in body:
        e["miles_source"] = source
    elif stored.get("miles_source") and stored.get("driven_miles") == e["driven_miles"]:
        e["miles_source"] = stored["miles_source"]
    else:
        e["miles_source"] = "entered"

    e.update(resolve_costs(body, settings, stored))
    return e


def update_settings(conn, body):
    if not isinstance(body, dict):
        raise bad("settings must be a JSON object")
    current = load_settings(conn)
    new = {}
    for key, name, lo, hi in COST_FIELDS + (
        ("shifts_per_week", "Shifts per week", 1, 14),
        ("good_per_mile", "Good $/mile", 0, 20),
        ("min_per_mile", "Minimum $/mile", 0, 20),
    ):
        if key in body:
            new[key] = number(body[key], name, lo, hi)
    good = new.get("good_per_mile", current["good_per_mile"])
    floor = new.get("min_per_mile", current["min_per_mile"])
    if floor > good:
        raise bad("Minimum $/mile can't be above good $/mile")

    if "deadhead_mode" in body:
        if body["deadhead_mode"] not in ("auto", "fixed"):
            raise bad("Deadhead source must be calculated or fixed")
        new["deadhead_mode"] = body["deadhead_mode"]

    if "vehicles" in body:
        vehicles = body["vehicles"]
        if not isinstance(vehicles, list) or not vehicles:
            raise bad("Keep at least one vehicle")
        clean, seen = [], set()
        for v in vehicles:
            if not isinstance(v, dict):
                raise bad("each vehicle must be an object")
            name = text(v.get("name"), "Vehicle name", 40)
            if not name:
                raise bad("Every vehicle needs a name")
            if name.lower() in seen:
                raise bad(f"{name} is listed twice")
            seen.add(name.lower())
            maint = v.get("maint_per_mile")
            if blank(maint):
                maint = vehicle_maint(current, name)
            clean.append({"name": name, "mpg": number(v.get("mpg"), f"{name} MPG", 1, 200),
                          "maint_per_mile": number(maint, f"{name} wear $/mi", 0, 2)})
        new["vehicles"] = clean

    names = [v["name"] for v in new.get("vehicles", current["vehicles"])]
    if "default_vehicle" in body:
        if body["default_vehicle"] not in names:
            raise bad("Default vehicle must be one of your vehicles")
        new["default_vehicle"] = body["default_vehicle"]
    elif current["default_vehicle"] not in names:
        new["default_vehicle"] = names[0]

    with conn:
        for key, value in new.items():
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                         (key, json.dumps(value)))


def replace_targets(conn, body):
    if not isinstance(body, list) or not body:
        raise bad("Keep at least one target month")
    rows, seen = [], set()
    for t in body:
        if not isinstance(t, dict):
            raise bad("each target must be an object")
        month = t.get("month")
        if not isinstance(month, str) or not MONTH_RE.match(month):
            raise bad("Target month must be YYYY-MM")
        if month in seen:
            raise bad(f"{month} is listed twice")
        seen.add(month)
        rows.append((month,
                     number(t.get("survive"), f"{month} survive", 0, 1e6),
                     number(t.get("thrive"), f"{month} thrive", 0, 1e6)))
    with conn:
        conn.execute("DELETE FROM targets")
        conn.executemany("INSERT INTO targets (month, survive, thrive) VALUES (?, ?, ?)",
                         sorted(rows))


# ---------------------------------------------------------------- live shift
#
# The _functions below do their writes without committing. Callers wrap them
# in a transaction ("with conn:"), so each sync operation lands whole or not
# at all.

def open_session(conn):
    row = conn.execute(
        "SELECT * FROM sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def require_open(conn):
    s = open_session(conn)
    if s is None:
        raise HTTPError(409, "No shift is running")
    return s


def session_by_cid(conn, cid, need_open=True):
    row = conn.execute("SELECT * FROM sessions WHERE client_id = ?",
                       (client_id(cid, "shift id"),)).fetchone()
    if row is None:
        raise HTTPError(404, "That shift isn't on the server")
    s = dict(row)
    if need_open and s["status"] != "open":
        raise HTTPError(409, "That shift was already saved")
    return s


def delivery_by_cid(conn, cid):
    row = conn.execute("SELECT * FROM deliveries WHERE client_id = ?",
                       (client_id(cid, "delivery id"),)).fetchone()
    return dict(row) if row else None


def session_payload(conn):
    s = open_session(conn)
    if s is None:
        return {"session": None, "deliveries": []}
    items = [dict(r) for r in conn.execute(
        "SELECT * FROM deliveries WHERE session_id = ? ORDER BY at, id", (s["id"],))]
    return {"session": s, "deliveries": items}


def _start(conn, body, cid, settings):
    if open_session(conn):
        raise HTTPError(409, "A shift is already running")
    date = iso_date(body.get("date")).isoformat()
    started = timestamp(body["started_at"], "Start time") if body.get("started_at") else now_utc()
    c = resolve_costs(body, settings)
    conn.execute(
        "INSERT INTO sessions (client_id, date, started_at, status, vehicle, mpg, maint_per_mile, "
        "gas_price, deadhead_pct, irs_rate, tax_rate) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
        (cid, date, started, c["vehicle"], c["mpg"], c["maint_per_mile"], c["gas_price"],
         c["deadhead_pct"], c["irs_rate"], c["tax_rate"]),
    )


def _update_costs(conn, s, body, settings):
    c = resolve_costs(body, settings, s)
    started = timestamp(body["started_at"], "Start time") if body.get("started_at") else s["started_at"]
    date = iso_date(body["date"]).isoformat() if body.get("date") else s["date"]
    conn.execute(
        "UPDATE sessions SET date = ?, started_at = ?, vehicle = ?, mpg = ?, maint_per_mile = ?, "
        "gas_price = ?, deadhead_pct = ?, irs_rate = ?, tax_rate = ? WHERE id = ?",
        (date, started, c["vehicle"], c["mpg"], c["maint_per_mile"], c["gas_price"],
         c["deadhead_pct"], c["irs_rate"], c["tax_rate"], s["id"]),
    )


def delivery_values(body, stored=None):
    if not isinstance(body, dict):
        raise bad("delivery must be a JSON object")
    stored = stored or {}

    def raw(key):
        return body[key] if key in body else stored.get(key)

    amount = number(raw("amount"), "Pay", 0, 10000)
    miles = number(raw("miles"), "Miles", 0, 1000)
    # The page sends what Uber paid; the tip is whatever the total is above it.
    uber_pay = number(raw("uber_pay"), "Uber's pay", 0, 10000, required=False)
    if uber_pay is not None:
        if uber_pay > amount + 0.005:
            raise bad("Uber's pay can't be more than the total")
        tip = round(max(amount - uber_pay, 0.0), 2)
    else:
        tip = number(raw("tip"), "Tip", 0, 10000, required=False)
        if tip is not None and tip > amount:
            raise bad("Tip can't be more than the pay")
    note = text(raw("note"), "Note", 200)
    at = timestamp(body["at"], "Time") if body.get("at") else (stored.get("at") or now_utc())
    return amount, tip, uber_pay, miles, note, at


def _add_delivery(conn, s, body, cid):
    amount, tip, uber_pay, miles, note, at = delivery_values(body)
    conn.execute(
        "INSERT INTO deliveries (client_id, session_id, at, amount, tip, uber_pay, miles, note) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (cid, s["id"], at, amount, tip, uber_pay, miles, note),
    )


def _edit_delivery(conn, d, body):
    amount, tip, uber_pay, miles, note, at = delivery_values(body, d)
    conn.execute(
        "UPDATE deliveries SET at = ?, amount = ?, tip = ?, uber_pay = ?, miles = ?, note = ? WHERE id = ?",
        (at, amount, tip, uber_pay, miles, note, d["id"]))


def recent_deadhead(conn, want=10, need=3):
    """Median deadhead % over the latest GPS-measured shifts.

    Only phone-tracked shifts count: typed driven miles tend to include the
    commute. A shift below 0% (GPS lost miles) or above 60% is dropped as a bad
    reading. With fewer than `need` usable shifts, new shifts keep the Settings
    value.
    """
    vals = []
    for r in conn.execute(
            "SELECT paid_miles, driven_miles FROM entries WHERE miles_source = 'gps' "
            "AND driven_miles > 0 AND paid_miles > 0 ORDER BY date DESC, id DESC LIMIT 60"):
        pct = (1 - r["paid_miles"] / r["driven_miles"]) * 100
        if 0 <= pct <= 60:
            vals.append(pct)
            if len(vals) == want:
                break
    if len(vals) < need:
        return {"pct": None, "shifts": len(vals), "need": need}
    s = sorted(vals)
    mid = len(s) // 2
    med = s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2
    return {"pct": round(med, 1), "shifts": len(vals), "need": need}


def settings_payload(conn):
    return {"settings": load_settings(conn), "targets": load_targets(conn),
            "deadhead_auto": recent_deadhead(conn)}


def entry_deliveries(conn, entry_id):
    return [dict(r) for r in conn.execute(
        "SELECT d.* FROM deliveries d JOIN sessions s ON s.id = d.session_id "
        "WHERE s.entry_id = ? ORDER BY d.at, d.id", (entry_id,))]


def apply_delivery_edits(conn, entry_id, body):
    """Save changes to a saved live shift's deliveries, then take the shift's
    gross, tips, orders and paid miles from them. A tip that lands after the
    shift only has to be typed on its own delivery."""
    edits = body.pop("deliveries")
    if not isinstance(edits, list):
        raise bad("deliveries must be a list")
    items = {d["id"]: d for d in entry_deliveries(conn, entry_id)}
    if not items:
        return
    for ed in edits:
        d = items.get(ed.get("id")) if isinstance(ed, dict) else None
        if d is None:
            raise bad("That delivery isn't part of this shift")
        change = {k: ed[k] for k in ("amount", "uber_pay", "tip", "miles") if k in ed}
        amount, tip, uber_pay, miles, _note, _at = delivery_values(change, d)
        d.update(amount=amount, tip=tip, uber_pay=uber_pay, miles=miles)
        conn.execute("UPDATE deliveries SET amount = ?, tip = ?, uber_pay = ?, miles = ? WHERE id = ?",
                     (amount, tip, uber_pay, miles, d["id"]))
    tips = [d["tip"] for d in items.values() if d["tip"] is not None]
    body["gross"] = round(sum(d["amount"] for d in items.values()), 2)
    body["paid_miles"] = round(sum(d["miles"] for d in items.values()), 2)
    body["orders"] = len(items)
    body["tips"] = round(sum(tips), 2) if tips else None


def combine_entries(conn, ids):
    """Merge same-day shifts into one.

    Hours add up rather than spanning the clock: two three-hour shifts with a
    three-hour break make six hours, not nine. Live shifts keep their
    deliveries and GPS track by pointing them at the surviving entry.
    """
    if not isinstance(ids, list) or len(ids) < 2:
        raise bad("Pick at least two shifts to combine")
    rows = []
    for i in ids:
        try:
            rows.append(get_entry_raw(conn, int(i)))
        except (TypeError, ValueError):
            raise bad("bad entry id")
    if len({r["id"] for r in rows}) != len(rows):
        raise bad("That lists the same shift twice")
    if len({r["date"] for r in rows}) != 1:
        raise bad("Those shifts aren't all on the same day")
    if len({r["vehicle"] or "" for r in rows}) != 1:
        raise bad("Those shifts used different vehicles, so their fuel and wear don't combine")

    rows.sort(key=lambda r: r["id"])
    keep, others = rows[0], rows[1:]

    def added(key):
        vals = [r[key] for r in rows if r.get(key) is not None]
        return round(sum(vals), 2) if vals else None

    payload = dict(keep)
    payload.update(
        gross=round(sum(r["gross"] for r in rows), 2),
        paid_miles=round(sum(r["paid_miles"] for r in rows), 2),
        tips=added("tips"), hours=added("hours"), driven_miles=added("driven_miles"),
        notes="; ".join(n for n in (r["notes"] for r in rows) if n) or None,
    )
    orders = added("orders")
    payload["orders"] = int(orders) if orders is not None else None
    e = build_entry(payload, load_settings(conn), keep)
    if payload["driven_miles"] is None:
        e["miles_source"] = None
    else:
        sources = {r["miles_source"] for r in rows if r.get("driven_miles") is not None}
        e["miles_source"] = sources.pop() if len(sources) == 1 else "entered"

    with conn:
        update_entry(conn, keep["id"], e)
        for r in others:
            conn.execute("UPDATE sessions SET entry_id = ? WHERE entry_id = ?", (keep["id"], r["id"]))
            conn.execute("DELETE FROM entries WHERE id = ?", (r["id"],))
    return compute(get_entry_raw(conn, keep["id"]))


def _finish(conn, s, body, settings):
    """Roll a running shift's deliveries into one entry and close the shift."""
    items = [dict(r) for r in conn.execute(
        "SELECT * FROM deliveries WHERE session_id = ? ORDER BY at, id", (s["id"],))]
    if not items:
        raise bad("Add at least one delivery before saving, or discard the shift")
    tips = [i["tip"] for i in items if i["tip"] is not None]
    payload = {
        "date": s["date"],
        "gross": round(sum(i["amount"] for i in items), 2),
        "paid_miles": round(sum(i["miles"] for i in items), 2),
        "orders": len(items),
        "tips": round(sum(tips), 2) if tips else None,
        "hours": body.get("hours"),
        "driven_miles": body.get("driven_miles"),
        "miles_source": body.get("miles_source"),
        "notes": body.get("notes"),
    }
    for key in ("vehicle", "mpg", "maint_per_mile", "gas_price", "deadhead_pct", "irs_rate", "tax_rate"):
        payload[key] = s[key]
    e = build_entry(payload, settings)
    ended = timestamp(body["ended_at"], "End time") if body.get("ended_at") else now_utc()
    entry_id = insert_entry_sql(conn, e)
    conn.execute("UPDATE sessions SET status = 'saved', ended_at = ?, entry_id = ? WHERE id = ?",
                 (ended, entry_id, s["id"]))
    return entry_id


def _require_open_delivery(conn, d):
    status = conn.execute("SELECT status FROM sessions WHERE id = ?", (d["session_id"],)).fetchone()
    if status is None or status["status"] != "open":
        raise HTTPError(409, "That delivery's shift was already saved")


def apply_op(conn, op, settings):
    """Apply one sync operation. Returns a new entry id for 'finish', else None.
    Operations that were already applied by an earlier attempt are no-ops."""
    kind = op.get("type")
    if kind == "start":
        cid = client_id(op.get("session_cid"), "shift id")
        if conn.execute("SELECT 1 FROM sessions WHERE client_id = ?", (cid,)).fetchone():
            return None
        _start(conn, op, cid, settings)
    elif kind == "costs":
        _update_costs(conn, session_by_cid(conn, op.get("session_cid")), op, settings)
    elif kind == "add":
        s = session_by_cid(conn, op.get("session_cid"))
        cid = client_id(op.get("delivery_cid"), "delivery id")
        if delivery_by_cid(conn, cid):
            return None
        _add_delivery(conn, s, op, cid)
    elif kind == "edit":
        d = delivery_by_cid(conn, op.get("delivery_cid"))
        if d is None:
            raise HTTPError(404, "That delivery isn't on the server")
        _require_open_delivery(conn, d)
        _edit_delivery(conn, d, op)
    elif kind == "delete":
        d = delivery_by_cid(conn, op.get("delivery_cid"))
        if d is None:
            return None
        _require_open_delivery(conn, d)
        conn.execute("DELETE FROM deliveries WHERE id = ?", (d["id"],))
    elif kind == "finish":
        return _finish(conn, session_by_cid(conn, op.get("session_cid")), op, settings)
    elif kind == "discard":
        cid = client_id(op.get("session_cid"), "shift id")
        row = conn.execute("SELECT * FROM sessions WHERE client_id = ?", (cid,)).fetchone()
        if row is None:
            return None
        if row["status"] != "open":
            raise HTTPError(409, "That shift was already saved")
        delete_session_rows(conn, row["id"])
    else:
        raise bad(f"unknown operation: {kind!r}")
    return None


def sync(conn, body):
    """Apply a queued list of operations in order, each in its own transaction.

    A rejected operation (validation or conflict) is recorded and reported, and
    the rest still run. A server fault stops the batch with a 500; everything
    before it is committed and logged, so the client can simply resend.
    """
    if not isinstance(body, dict) or not isinstance(body.get("ops"), list):
        raise bad("body must be {\"ops\": [...]}")
    if len(body["ops"]) > 1000:
        raise bad("too many operations in one batch")
    settings = load_settings(conn)
    results, created = [], []
    for op in body["ops"]:
        op_id = op.get("op_id") if isinstance(op, dict) else None
        if not isinstance(op_id, str) or not CID_RE.match(op_id):
            results.append({"op_id": op_id, "ok": False, "error": "operation id is missing or malformed"})
            continue
        prev = conn.execute("SELECT ok, error FROM ops_log WHERE op_id = ?", (op_id,)).fetchone()
        if prev is not None:
            results.append({"op_id": op_id, "ok": bool(prev["ok"]), "error": prev["error"], "duplicate": True})
            continue
        try:
            with conn:
                entry_id = apply_op(conn, op, settings)
                conn.execute("INSERT INTO ops_log (op_id, type, ok, applied_at) VALUES (?, ?, 1, ?)",
                             (op_id, op.get("type"), now_utc()))
            result = {"op_id": op_id, "ok": True}
            if entry_id:
                result["entry_id"] = entry_id
                created.append(entry_id)
        except HTTPError as e:
            with conn:
                conn.execute("INSERT INTO ops_log (op_id, type, ok, error, applied_at) VALUES (?, ?, 0, ?, ?)",
                             (op_id, str(op.get("type")), str(e), now_utc()))
            result = {"op_id": op_id, "ok": False, "error": str(e)}
        results.append(result)
    payload = session_payload(conn)
    payload["results"] = results
    payload["entries"] = [compute(get_entry_raw(conn, i)) for i in created]
    return payload


def add_track(conn, body):
    """Store GPS points for a shift. Resending the same points is harmless."""
    if not isinstance(body, dict):
        raise bad("body must be a JSON object")
    cid = client_id(body.get("session_cid"), "shift id")
    row = conn.execute("SELECT id FROM sessions WHERE client_id = ?", (cid,)).fetchone()
    if row is None:
        raise HTTPError(404, "That shift isn't on the server yet")
    points = body.get("points")
    if not isinstance(points, list) or len(points) > 5000:
        raise bad("points must be a list of at most 5000")
    rows = []
    for p in points:
        if not isinstance(p, dict):
            raise bad("each point must be an object")
        t = number(p.get("t"), "t", 1e12, 1e13)
        lat = number(p.get("lat"), "lat", -90, 90)
        lon = number(p.get("lon"), "lon", -180, 180)
        acc = number(p.get("acc"), "acc", 0, 1e5, required=False)
        spd = number(p.get("spd"), "spd", 0, 1e3, required=False)
        rows.append((row["id"], int(t), lat, lon, acc, spd))
    with conn:
        before = conn.total_changes
        conn.executemany(
            "INSERT OR IGNORE INTO track_points (session_id, t, lat, lon, acc, spd) VALUES (?, ?, ?, ?, ?, ?)",
            rows)
        stored = conn.total_changes - before
    total = conn.execute("SELECT COUNT(*) FROM track_points WHERE session_id = ?", (row["id"],)).fetchone()[0]
    return {"stored": stored, "total": total}


def add_passive(conn, body):
    """Store every fix the phone heard during a shift (body kind "passive").
    Kept apart from track_points so it can never change mileage or maps."""
    cid = client_id(body.get("session_cid"), "shift id")
    row = conn.execute("SELECT id FROM sessions WHERE client_id = ?", (cid,)).fetchone()
    if row is None:
        raise HTTPError(404, "That shift isn't on the server yet")
    # Not "points": a server without this code would then reject the batch
    # instead of filing these fixes as part of the real track.
    points = body.get("heard")
    if not isinstance(points, list) or len(points) > 5000:
        raise bad("heard must be a list of at most 5000")
    rows = []
    for p in points:
        if not isinstance(p, dict):
            raise bad("each point must be an object")
        prov = p.get("prov")
        if not isinstance(prov, str) or not (0 < len(prov) <= 20):
            raise bad("prov must be a short text")
        rows.append((
            row["id"],
            int(number(p.get("t"), "t", 1e12, 1e13)),
            prov,
            number(p.get("lat"), "lat", -90, 90),
            number(p.get("lon"), "lon", -180, 180),
            number(p.get("acc"), "acc", 0, 1e5, required=False),
            number(p.get("spd"), "spd", 0, 1e3, required=False),
        ))
    with conn:
        before = conn.total_changes
        conn.executemany(
            "INSERT OR IGNORE INTO passive_points (session_id, t, prov, lat, lon, acc, spd) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
        stored = conn.total_changes - before
    return {"stored": stored}


# ---------------------------------------------------------------- math

def compute(e):
    """Derived numbers, from the entry's own stored inputs only."""
    paid = e["paid_miles"]
    if e.get("driven_miles") is not None:
        driven = e["driven_miles"]
    else:
        driven = paid / (1 - e["deadhead_pct"] / 100)
    fuel = driven / e["mpg"] * e["gas_price"]
    wear = driven * (e.get("maint_per_mile") or 0.0)
    deduction = driven * e["irs_rate"]
    tax = max(e["gross"] - deduction, 0.0) * e["tax_rate"] / 100
    cash = e["gross"] - fuel - wear - tax
    hours = e.get("hours") or 0
    out = dict(e)
    out.update(
        driven=driven,
        fuel=fuel,
        wear=wear,
        deduction=deduction,
        tax=tax,
        cash=cash,
        gross_per_hour=e["gross"] / hours if hours else None,
        cash_per_hour=cash / hours if hours else None,
        gross_per_paid_mile=e["gross"] / paid if paid else None,
        gross_per_driven_mile=e["gross"] / driven if driven else None,
    )
    return out


def target_for(targets, month):
    """Exact month, else the latest earlier month, else the earliest month."""
    best = None
    for t in targets:
        if t["month"] <= month:
            best = t
        else:
            break
    if best is None:
        best = targets[0] if targets else {"survive": 0.0, "thrive": 0.0}
    return best


SUM_KEYS = ("gross", "tips", "cash", "fuel", "wear", "tax", "deduction",
            "paid_miles", "driven", "hours", "orders",
            "hours_gross", "hours_cash", "orders_gross", "tips_gross")


def summarize(conn, start, end, today, max_days=400):
    if end < start:
        raise bad("end is before start")
    if (end - start).days >= max_days:
        raise bad("date range is too long")
    settings = load_settings(conn)
    targets = load_targets(conn)
    entries = [compute(dict(r)) for r in conn.execute(
        "SELECT * FROM entries WHERE date BETWEEN ? AND ? ORDER BY date, id",
        (start.isoformat(), end.isoformat()))]

    days = {}
    d = start
    while d <= end:
        t = target_for(targets, d.strftime("%Y-%m"))
        dim = calendar.monthrange(d.year, d.month)[1]
        row = {k: 0.0 for k in SUM_KEYS}
        row.update(date=d.isoformat(), entries=0,
                   survive_target=t["survive"] / dim, thrive_target=t["thrive"] / dim)
        days[row["date"]] = row
        d += dt.timedelta(days=1)

    for e in entries:
        row = days[e["date"]]
        row["entries"] += 1
        for k in ("gross", "tips", "cash", "fuel", "wear", "tax", "deduction",
                  "paid_miles", "driven", "hours", "orders"):
            row[k] += e.get(k) or 0
        if e.get("hours"):
            row["hours_gross"] += e["gross"]
            row["hours_cash"] += e["cash"]
        if e.get("orders"):
            row["orders_gross"] += e["gross"]
        if e.get("tips") is not None:
            row["tips_gross"] += e["gross"]

    day_list = list(days.values())
    totals = {k: sum(r[k] for r in day_list) for k in SUM_KEYS}
    totals["entries"] = len(entries)
    totals["shift_days"] = sum(1 for r in day_list if r["entries"])
    totals["gross_per_hour"] = totals["hours_gross"] / totals["hours"] if totals["hours"] else None
    totals["cash_per_hour"] = totals["hours_cash"] / totals["hours"] if totals["hours"] else None
    totals["gross_per_paid_mile"] = (totals["gross"] / totals["paid_miles"]
                                     if totals["paid_miles"] else None)
    # Uber's base pay is flat (~$1.50) whatever miles it reports, and its miles
    # include the drive to the restaurant, so gross per mile actually driven is
    # the per-mile figure that means something.
    totals["gross_per_driven_mile"] = (totals["gross"] / totals["driven"]
                                       if totals["driven"] else None)
    totals["gross_per_order"] = (totals["orders_gross"] / totals["orders"]
                                 if totals["orders"] else None)
    totals["tips_share"] = (totals["tips"] / totals["tips_gross"]
                            if totals["tips_gross"] else None)

    tstr = today.isoformat()
    survive = sum(r["survive_target"] for r in day_list)
    thrive = sum(r["thrive_target"] for r in day_list)
    logged_today = tstr in days and days[tstr]["entries"] > 0
    days_left = sum(1 for r in day_list
                    if r["date"] > tstr or (r["date"] == tstr and not logged_today))
    spw = float(settings["shifts_per_week"])
    # Shifts left is the period's plan minus the shifts already worked, not a
    # slice of the calendar days remaining: four shifts into a five-shift week
    # leaves one, not three. Never more shifts than there are days left, and
    # never zero while a day and some money remain.
    planned = spw * len(day_list) / 7
    shifts_left = max(min(planned - totals["shift_days"], float(days_left)), 0.0)
    if days_left > 0:
        shifts_left = max(shifts_left, 1.0)

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "today": tstr,
        "days": day_list,
        "entries": entries,
        "totals": totals,
        "targets": {
            "survive": survive,
            "thrive": thrive,
            "survive_to_date": sum(r["survive_target"] for r in day_list if r["date"] <= tstr),
            "thrive_to_date": sum(r["thrive_target"] for r in day_list if r["date"] <= tstr),
        },
        "remaining": {
            "days_left": days_left,
            "shifts_left": shifts_left,
            "planned_shifts": planned,
            "survive_needed": max(survive - totals["gross"], 0.0),
            "thrive_needed": max(thrive - totals["gross"], 0.0),
        },
        "shifts_per_week": spw,
    }


# ---------------------------------------------------------------- CSV

def fmt(v, dp=None):
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if dp is not None:
            return f"{v:.{dp}f}"
        s = f"{v:.4f}".rstrip("0").rstrip(".")
        return "0" if s in ("", "-0") else s
    return str(v)


def local_time(utc_text, offset):
    if not utc_text:
        return ""
    at = dt.datetime.strptime(utc_text, "%Y-%m-%dT%H:%M:%SZ")
    return (at - offset).strftime("%Y-%m-%d %H:%M")


ENTRY_CSV = (
    ("id", "id", None), ("date", "date", None), ("vehicle", "vehicle", None),
    ("gross", "gross", 2), ("tips", "tips", 2), ("orders", "orders", None),
    ("hours", "hours", None), ("paid_miles", "paid_miles", None),
    ("driven_miles_entered", "driven_miles", None), ("miles_source", "miles_source", None),
    ("deadhead_pct", "deadhead_pct", None),
    ("driven_miles_used", "driven", 1), ("mpg", "mpg", None), ("gas_price", "gas_price", None),
    ("fuel_cost", "fuel", 2), ("wear_per_mile", "maint_per_mile", None), ("wear_cost", "wear", 2),
    ("irs_rate", "irs_rate", None), ("mileage_deduction", "deduction", 2),
    ("tax_setaside_pct", "tax_rate", None), ("tax_setaside", "tax", 2), ("cash_kept", "cash", 2),
    ("gross_per_hour", "gross_per_hour", 2), ("cash_per_hour", "cash_per_hour", 2),
    ("gross_per_paid_mile", "gross_per_paid_mile", 2),
    ("gross_per_driven_mile", "gross_per_driven_mile", 2), ("notes", "notes", None),
    ("created_at_utc", "created_at", None), ("updated_at_utc", "updated_at", None),
)
EXPORT_KINDS = ("entries", "daily", "weekly", "deliveries", "mileage")


def export_csv(conn, kind, start, end, today, tz_offset_min=0):
    if kind not in EXPORT_KINDS:
        raise bad("kind must be one of " + ", ".join(EXPORT_KINDS))
    if start is None or end is None:
        lo, hi = conn.execute(
            "SELECT MIN(d), MAX(d) FROM (SELECT date AS d FROM entries UNION ALL SELECT date FROM sessions)"
        ).fetchone()
        if lo is None:
            lo = hi = today.isoformat()
        start = start or dt.date.fromisoformat(lo)
        end = end or dt.date.fromisoformat(hi)
    if end < start:
        raise bad("end is before start")
    if kind == "weekly":
        start -= dt.timedelta(days=start.weekday())
        end += dt.timedelta(days=6 - end.weekday())
    offset = dt.timedelta(minutes=tz_offset_min)

    buf = io.StringIO()
    w = csv.writer(buf)
    if kind == "entries":
        w.writerow([h for h, _, _ in ENTRY_CSV])
        for r in conn.execute("SELECT * FROM entries WHERE date BETWEEN ? AND ? ORDER BY date, id",
                              (start.isoformat(), end.isoformat())):
            e = compute(dict(r))
            w.writerow([fmt(e.get(key), dp) for _, key, dp in ENTRY_CSV])
    elif kind == "mileage":
        w.writerow(["date", "vehicle", "start_local", "end_local", "business_miles", "miles_source",
                    "paid_miles", "gps_points", "purpose", "notes"])
        rows = conn.execute(
            "SELECT e.*, s.id AS sid, s.started_at, s.ended_at FROM entries e "
            "LEFT JOIN sessions s ON s.entry_id = e.id WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.id",
            (start.isoformat(), end.isoformat()))
        for r in rows:
            e = compute(dict(r))
            points = conn.execute("SELECT COUNT(*) FROM track_points WHERE session_id = ?",
                                  (r["sid"],)).fetchone()[0] if r["sid"] else 0
            source = e.get("miles_source") or ("entered" if e.get("driven_miles") is not None else "estimated")
            w.writerow([e["date"], e.get("vehicle") or "", local_time(r["started_at"], offset),
                        local_time(r["ended_at"], offset), fmt(e["driven"], 1), source,
                        fmt(e["paid_miles"]), points, MILEAGE_PURPOSE, e.get("notes") or ""])
    elif kind == "deliveries":
        w.writerow(["shift_date", "time_local", "time_utc", "pay", "uber_pay", "tip", "paid_miles",
                    "pay_per_paid_mile", "note", "shift_status", "entry_id"])
        for r in conn.execute(
                "SELECT d.*, s.date AS shift_date, s.status, s.entry_id FROM deliveries d "
                "JOIN sessions s ON s.id = d.session_id WHERE s.date BETWEEN ? AND ? "
                "ORDER BY d.at, d.id", (start.isoformat(), end.isoformat())):
            w.writerow([r["shift_date"], local_time(r["at"], offset), r["at"],
                        fmt(r["amount"], 2), fmt(r["uber_pay"], 2), fmt(r["tip"], 2), fmt(r["miles"]),
                        fmt(r["amount"] / r["miles"], 2) if r["miles"] else "",
                        r["note"] or "", r["status"], r["entry_id"] or ""])
    else:
        s = summarize(conn, start, end, today, max_days=20000)
        if kind == "daily":
            w.writerow(["date", "weekday", "entries", "gross", "tips", "cash_kept", "fuel_cost",
                        "wear_cost", "tax_setaside", "hours", "paid_miles", "driven_miles", "orders",
                        "survive_target", "thrive_target", "gross_minus_survive", "gross_minus_thrive"])
            for d in s["days"]:
                day = dt.date.fromisoformat(d["date"])
                w.writerow([d["date"], day.strftime("%a"), d["entries"],
                            fmt(d["gross"], 2), fmt(d["tips"], 2), fmt(d["cash"], 2),
                            fmt(d["fuel"], 2), fmt(d["wear"], 2), fmt(d["tax"], 2), fmt(d["hours"], 2),
                            fmt(d["paid_miles"], 1), fmt(d["driven"], 1), int(d["orders"]),
                            fmt(d["survive_target"], 2), fmt(d["thrive_target"], 2),
                            fmt(d["gross"] - d["survive_target"], 2),
                            fmt(d["gross"] - d["thrive_target"], 2)])
        else:
            weeks = {}
            for d in s["days"]:
                day = dt.date.fromisoformat(d["date"])
                monday = day - dt.timedelta(days=day.weekday())
                g = weeks.setdefault(monday, {
                    "start": day, "end": day, "shift_days": 0, "gross": 0.0, "cash": 0.0,
                    "hours": 0.0, "hours_gross": 0.0, "paid_miles": 0.0,
                    "survive": 0.0, "thrive": 0.0})
                g["end"] = day
                g["shift_days"] += 1 if d["entries"] else 0
                for k in ("gross", "cash", "hours", "hours_gross", "paid_miles"):
                    g[k] += d[k]
                g["survive"] += d["survive_target"]
                g["thrive"] += d["thrive_target"]
            w.writerow(["week_start", "week_end", "shift_days", "gross", "cash_kept", "hours",
                        "gross_per_hour", "paid_miles", "survive_target", "thrive_target",
                        "gross_minus_survive", "gross_minus_thrive", "status"])
            for g in weeks.values():
                if g["start"] > today:
                    status = "not started"
                elif g["end"] > today:
                    status = "in progress"
                elif g["gross"] >= g["thrive"]:
                    status = "thrive"
                elif g["gross"] >= g["survive"]:
                    status = "survive"
                else:
                    status = "below survive"
                w.writerow([g["start"].isoformat(), g["end"].isoformat(), g["shift_days"],
                            fmt(g["gross"], 2), fmt(g["cash"], 2), fmt(g["hours"], 2),
                            fmt(g["hours_gross"] / g["hours"], 2) if g["hours"] else "",
                            fmt(g["paid_miles"], 1), fmt(g["survive"], 2), fmt(g["thrive"], 2),
                            fmt(g["gross"] - g["survive"], 2), fmt(g["gross"] - g["thrive"], 2),
                            status])
    return buf.getvalue(), f"delivery-{kind}-{start.isoformat()}_{end.isoformat()}.csv"


def track_gaps(conn, date_str, min_gap_s=30):
    """When GPS fixes stopped arriving, per shift. Diagnostics for the app."""
    day = iso_date(date_str) if date_str else dt.date.today()
    out = []
    for s_row in conn.execute(
            "SELECT id, date, status, started_at, ended_at, entry_id FROM sessions "
            "WHERE date = ? ORDER BY id", (day.isoformat(),)):
        times = [r[0] for r in conn.execute(
            "SELECT t FROM track_points WHERE session_id = ? ORDER BY t", (s_row["id"],))]
        gaps = []
        for a, b in zip(times, times[1:]):
            if b - a >= min_gap_s * 1000:
                gaps.append({"from": iso_ms(a), "to": iso_ms(b), "seconds": round((b - a) / 1000, 1)})
        gaps.sort(key=lambda g: g["seconds"], reverse=True)
        span = (times[-1] - times[0]) / 1000 if len(times) > 1 else 0
        out.append({
            "session_id": s_row["id"], "status": s_row["status"], "entry_id": s_row["entry_id"],
            "started_at": s_row["started_at"], "ended_at": s_row["ended_at"],
            "points": len(times),
            "first_fix": iso_ms(times[0]) if times else None,
            "last_fix": iso_ms(times[-1]) if times else None,
            "covered_seconds": round(span, 1),
            "quiet_seconds": round(sum(g["seconds"] for g in gaps), 1),
            "gaps": gaps[:20],
        })
    return {"date": day.isoformat(), "min_gap_seconds": min_gap_s, "sessions": out}


def iso_ms(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def app_info():
    if not os.path.isfile(APK_PATH):
        return {"apk": False}
    st = os.stat(APK_PATH)
    info = {
        "apk": True,
        "size": st.st_size,
        "updated": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "url": "/download/delivery-tracker.apk",
    }
    # build.sh writes the APK's version next to it.
    try:
        with open(APK_PATH + ".json", encoding="utf-8") as fh:
            v = json.load(fh)
        info["version_code"] = int(v["version_code"])
        info["version_name"] = str(v.get("version_name", ""))
        if isinstance(v.get("changes"), list):
            info["changes"] = v["changes"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return info


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "delivery-tracker/1.3"

    def log_message(self, fmt_, *args):
        sys.stdout.write("%s %s\n" % (self.address_string(), fmt_ % args))
        sys.stdout.flush()

    def send_bytes(self, status, body, ctype, cache="no-store", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(status, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 5_000_000:
            raise bad("request body is too large")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise bad("request body must be JSON")

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        url = urlparse(self.path)
        query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            if url.path.startswith("/api/"):
                with closing(connect()) as conn:
                    self.api(conn, method, url.path, query)
            elif method == "GET" and url.path == "/download/delivery-tracker.apk":
                self.apk()
            elif method == "GET":
                self.static(url.path)
            else:
                raise HTTPError(405, "method not allowed")
        except HTTPError as e:
            self.send_json({"error": str(e)}, e.status)
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "server error, see the container log"}, 500)

    def static(self, path):
        name = path.lstrip("/") or "index.html"
        ctype = STATIC_TYPES.get(name)
        if ctype is None:
            raise HTTPError(404, "not found")
        with open(os.path.join(STATIC_DIR, name), "rb") as f:
            body = f.read()
        self.send_bytes(200, body, ctype, cache="no-cache")

    def apk(self):
        if not os.path.isfile(APK_PATH):
            raise HTTPError(404, "No Android app has been uploaded to the server")
        with open(APK_PATH, "rb") as f:
            body = f.read()
        # Name the download after its version, so Downloads doesn't fill up with
        # delivery-tracker (1).apk, (2).apk and no way to tell them apart.
        name = "delivery-tracker.apk"
        try:
            with open(APK_PATH + ".json", encoding="utf-8") as fh:
                ver = str(json.load(fh).get("version_name") or "")
            if ver and all(ch.isdigit() or ch == "." for ch in ver):
                name = f"delivery-tracker-{ver}.apk"
        except (OSError, ValueError, AttributeError):
            pass
        self.send_bytes(200, body, "application/vnd.android.package-archive",
                        extra={"Content-Disposition": f'attachment; filename="{name}"'})

    def api(self, conn, method, path, q):
        parts = path.strip("/").split("/")
        route = parts[1] if len(parts) > 1 else ""

        if route == "health" and method == "GET":
            return self.send_json({"ok": True})

        if route == "app-info" and method == "GET":
            return self.send_json(app_info())

        if route == "settings":
            if method == "GET":
                return self.send_json(settings_payload(conn))
            if method == "PUT":
                update_settings(conn, self.read_json())
                return self.send_json(settings_payload(conn))

        if route == "targets" and method == "PUT":
            replace_targets(conn, self.read_json())
            return self.send_json({"targets": load_targets(conn)})

        if route == "entries":
            if len(parts) == 2:
                if method == "GET":
                    return self.send_json({"entries": list_entries(conn, q)})
                if method == "POST":
                    e = build_entry(self.read_json(), load_settings(conn))
                    new_id = insert_entry(conn, e)
                    return self.send_json({"entry": compute(get_entry_raw(conn, new_id))}, 201)
            elif len(parts) == 4 and parts[3] == "deliveries" and method == "GET":
                try:
                    entry_id = int(parts[2])
                except ValueError:
                    raise HTTPError(404, "entry not found")
                get_entry_raw(conn, entry_id)
                return self.send_json({"deliveries": entry_deliveries(conn, entry_id)})
            elif len(parts) == 3 and parts[2] == "combine" and method == "POST":
                body = self.read_json()
                ids = body.get("ids") if isinstance(body, dict) else None
                return self.send_json({"entry": combine_entries(conn, ids)})
            elif len(parts) == 3:
                try:
                    entry_id = int(parts[2])
                except ValueError:
                    raise HTTPError(404, "entry not found")
                stored = get_entry_raw(conn, entry_id)
                if method == "GET":
                    return self.send_json({"entry": compute(stored)})
                if method == "PUT":
                    body = self.read_json()
                    with conn:
                        if isinstance(body, dict) and "deliveries" in body:
                            apply_delivery_edits(conn, entry_id, body)
                        e = build_entry(body, load_settings(conn), stored)
                        update_entry(conn, entry_id, e)
                    return self.send_json({"entry": compute(get_entry_raw(conn, entry_id))})
                if method == "DELETE":
                    delete_entry(conn, entry_id)
                    return self.send_json({"deleted": entry_id})

        if route == "sync" and method == "POST":
            return self.send_json(sync(conn, self.read_json()))

        if route == "track" and method == "POST":
            body = self.read_json()
            if isinstance(body, dict) and body.get("kind") == "passive":
                return self.send_json(add_passive(conn, body))
            return self.send_json(add_track(conn, body))

        if route == "track" and method == "GET":
            return self.send_json(track_gaps(conn, q.get("date"),
                                             int(q.get("min_gap", 30) or 30)))

        if route == "session":
            # Direct endpoints, kept for scripts and older clients. The web UI
            # uses /api/sync.
            sub = parts[2] if len(parts) > 2 else ""
            settings = load_settings(conn)
            if sub == "" and method == "GET":
                return self.send_json(session_payload(conn))
            if sub == "" and method == "PUT":
                body = self.read_json()
                s = require_open(conn)
                with conn:
                    _update_costs(conn, s, body, settings)
                return self.send_json(session_payload(conn))
            if sub == "" and method == "DELETE":
                s = require_open(conn)
                with conn:
                    delete_session_rows(conn, s["id"])
                return self.send_json(session_payload(conn))
            if sub == "start" and method == "POST":
                body = self.read_json()
                if not isinstance(body, dict):
                    raise bad("body must be a JSON object")
                with conn:
                    _start(conn, body, new_cid(), settings)
                return self.send_json(session_payload(conn), 201)
            if sub == "finish" and method == "POST":
                body = self.read_json()
                if not isinstance(body, dict):
                    raise bad("body must be a JSON object")
                s = require_open(conn)
                with conn:
                    entry_id = _finish(conn, s, body, settings)
                return self.send_json({"entry": compute(get_entry_raw(conn, entry_id)),
                                       **session_payload(conn)})
            if sub == "deliveries":
                if len(parts) == 3 and method == "POST":
                    body = self.read_json()
                    s = require_open(conn)
                    with conn:
                        _add_delivery(conn, s, body, new_cid())
                    return self.send_json(session_payload(conn), 201)
                if len(parts) == 4:
                    try:
                        delivery_id = int(parts[3])
                    except ValueError:
                        raise HTTPError(404, "delivery not found")
                    s = require_open(conn)
                    row = conn.execute("SELECT * FROM deliveries WHERE id = ? AND session_id = ?",
                                       (delivery_id, s["id"])).fetchone()
                    if row is None:
                        raise HTTPError(404, "delivery not found in the running shift")
                    if method == "PUT":
                        body = self.read_json()
                        with conn:
                            _edit_delivery(conn, dict(row), body)
                        return self.send_json(session_payload(conn))
                    if method == "DELETE":
                        with conn:
                            conn.execute("DELETE FROM deliveries WHERE id = ?", (delivery_id,))
                        return self.send_json(session_payload(conn))

        if route == "summary" and method == "GET":
            start = iso_date(q.get("start"), "start")
            end = iso_date(q.get("end"), "end")
            today = iso_date(q["today"], "today") if q.get("today") else dt.date.today()
            return self.send_json(summarize(conn, start, end, today))

        if route == "export.csv" and method == "GET":
            start = iso_date(q["start"], "start") if q.get("start") else None
            end = iso_date(q["end"], "end") if q.get("end") else None
            today = iso_date(q["today"], "today") if q.get("today") else dt.date.today()
            tz = int(number(q.get("tz", 0), "tz", -840, 840))
            body, filename = export_csv(conn, q.get("kind", "entries"), start, end, today, tz)
            return self.send_bytes(200, body.encode("utf-8"), "text/csv; charset=utf-8",
                                   extra={"Content-Disposition": f'attachment; filename="{filename}"'})

        raise HTTPError(404, "not found")


def main():
    init_db()
    server = ThreadingHTTPServer((os.environ.get("HOST", "0.0.0.0"), PORT), Handler)
    server.daemon_threads = True
    print(f"delivery-tracker listening on :{PORT}, data at {DB_PATH}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
