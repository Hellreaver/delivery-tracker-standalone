"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Set by the Android app. In a plain browser this is null and GPS is off.
const native = window.TrackerNative || null;

const state = {
  settings: null,
  targets: [],
  view: "log",
  editingId: null,
  editDeliveries: null,   // deliveries of the saved live shift being edited
  deadheadAuto: null,     // median deadhead of recent GPS shifts, from /api/settings
  returnTo: null,
  weekStart: null,
  monthStart: null,
  histMonth: null,
  histEntries: new Map(),
  dayBefore: null,        // shifts already saved today, from /api/summary
  // Live shift. This is the local copy; the server copy replaces it whenever
  // nothing is waiting in the outbox.
  session: null,
  deliveries: [],
  sessionJSON: "",
  outbox: [],
  online: true,
  syncing: false,
  editingDeliveryId: null,
  finishOpen: false,
  finishMilesFromGps: false,
};

/* ---------- local storage ---------- */
const KEYS = {
  draft: "delivery-tracker:draft",
  live: "delivery-tracker:live",
  outbox: "delivery-tracker:outbox",
  settings: "delivery-tracker:settings",
  hellos: "delivery-tracker:hellos",
  editOrder: "delivery-tracker:edit-order",
  update: "delivery-tracker:update",   // last GitHub check: { checked_at, code, name, dismissed }   // "newest" (Uber's order) or "oldest"
};
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked */ }
}

// crypto.randomUUID needs HTTPS; getRandomValues works over plain HTTP too.
function uuid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---------- dates: local calendar dates only, never UTC ---------- */
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayISO = () => isoOf(new Date());
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return isoOf(d); };
const mondayOf = (s) => { const d = parseISO(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoOf(d); };
const monthStartOf = (s) => s.slice(0, 8) + "01";
const monthEndOf = (s) => { const d = parseISO(s); return isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
const addMonths = (s, n) => { const d = parseISO(s); return isoOf(new Date(d.getFullYear(), d.getMonth() + n, 1)); };
const daysInMonth = (s) => parseISO(monthEndOf(s)).getDate();
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const shortDate = (s) => { const d = parseISO(s); return `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`; };
const monDay = (s) => { const d = parseISO(s); return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
const monthLabel = (s) => { const d = parseISO(s); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const localTimeValue = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmm = (h) => { const m = Math.max(0, Math.floor(h * 60)); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
function rangeLabel(a, b) {
  const da = parseISO(a), db = parseISO(b);
  return da.getMonth() === db.getMonth()
    ? `${monDay(a)} to ${db.getDate()}, ${db.getFullYear()}`
    : `${monDay(a)} to ${monDay(b)}, ${db.getFullYear()}`;
}

/* ---------- formatting ---------- */
function money(v, dp = 0) {
  if (v == null || !Number.isFinite(v)) return "-";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v < 0 && Number(s.replace(/,/g, "")) !== 0 ? "-$" : "$") + s;
}
function num(v, dp = 1) {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
const signedMoney = (v, dp = 0) => (v >= 0 ? "+" : "") + money(v, dp);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer;
function toast(msg, isError = false, ms = null) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms || (isError ? 5000 : 2600));
}

/* ---------- API ---------- */
async function api(path, { method = "GET", body, timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      signal: ctl.signal,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error("Can't reach the server");
    e.network = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

async function loadSettings() {
  const d = await api("/api/settings");
  state.settings = d.settings;
  state.targets = d.targets;
  state.deadheadAuto = d.deadhead_auto || null;
  lsSet(KEYS.settings, d);
}

function openUrl(path) {
  const url = new URL(path, location.href).href;
  if (native && native.openExternal) native.openExternal(url);
  else window.location.href = url;
}

/* ---------- math (mirrors compute() in app.py) ---------- */
function calc(e) {
  const paid = Number(e.paid_miles) || 0;
  const hasDriven = e.driven_miles != null && e.driven_miles !== "" && Number.isFinite(Number(e.driven_miles));
  const driven = hasDriven ? Number(e.driven_miles) : paid / (1 - (Number(e.deadhead_pct) || 0) / 100);
  const mpg = Number(e.mpg);
  const fuel = mpg > 0 ? (driven / mpg) * (Number(e.gas_price) || 0) : 0;
  const deduction = driven * (Number(e.irs_rate) || 0);
  const gross = Number(e.gross) || 0;
  const tax = Math.max(gross - deduction, 0) * (Number(e.tax_rate) || 0) / 100;
  const wear = driven * (Number(e.maint_per_mile) || 0);
  const cash = gross - fuel - wear - tax;
  const hours = Number(e.hours) || 0;
  return {
    gross, driven, fuel, wear, deduction, tax, cash,
    perHour: hours ? gross / hours : null,
    cashPerHour: hours ? cash / hours : null,
    perMile: paid ? gross / paid : null,
  };
}

function targetFor(ym) {
  const t = state.targets;
  if (!t.length) return { survive: 0, thrive: 0 };
  let best = null;
  for (const x of t) { if (x.month <= ym) best = x; else break; }
  return best || t[0];
}

// New shifts start from the median of recent GPS shifts once there are
// enough of them; until then, the Deadhead % in Settings.
function shiftDeadhead() {
  if (state.settings.deadhead_mode === "fixed") return state.settings.deadhead_pct;
  const a = state.deadheadAuto;
  return a && a.pct != null ? a.pct : state.settings.deadhead_pct;
}

function perShift(dateStr) {
  const t = targetFor(dateStr.slice(0, 7));
  const shifts = Number(state.settings.shifts_per_week) * daysInMonth(dateStr) / 7;
  return { survive: t.survive / shifts, thrive: t.thrive / shifts };
}

function status(actual, survive, thrive) {
  if (!(survive > 0) && !(thrive > 0)) return { cls: "idle", text: "No target" };
  if (actual >= thrive) return { cls: "thrive", text: "Stretch pace" };
  if (actual >= survive) return { cls: "survive", text: "Base pace" };
  return { cls: "behind", text: "Below base" };
}

// A smooth version of perMileClass for the $/mile chips: red at or below the
// Minimum $/mile setting, amber halfway to Good $/mile, green at or above it,
// blended in between. Mixed in OKLCH so amber-to-green passes through
// yellow-green instead of grey. The class stays as the fallback colour.
function perMileStyle(ppm) {
  const lo = Number(state.settings.min_per_mile), hi = Number(state.settings.good_per_mile);
  if (ppm == null || !Number.isFinite(ppm) || !(hi > lo)) return "";
  const t = Math.min(Math.max((ppm - lo) / (hi - lo), 0), 1);
  const [a, b, w] = t < 0.5 ? ["--bad", "--warn", t * 2] : ["--warn", "--good", (t - 0.5) * 2];
  const pct = ((1 - w) * 100).toFixed(1);
  const mix = (x, y) => `color-mix(in oklch, var(${x}) ${pct}%, var(${y}))`;
  return `color:${mix(a, b)};background:${mix(a + "-bg", b + "-bg")}`;
}

function perMileClass(ppm) {
  if (ppm == null || !Number.isFinite(ppm)) return "idle";
  if (ppm >= Number(state.settings.good_per_mile)) return "thrive";
  if (ppm >= Number(state.settings.min_per_mile)) return "survive";
  return "behind";
}

/* ---------- GPS (Android app only) ---------- */
function gpsStatus() {
  if (!native) return null;
  try { return JSON.parse(native.status()); } catch { return null; }
}

function gpsForShift() {
  const g = gpsStatus();
  return g && state.session && g.session_cid === state.session.client_id ? g : null;
}

// Keep the phone's GPS pointed at the shift that's actually running.
function reconcileGps() {
  if (!native) return;
  const g = gpsStatus();
  if (!g) return;
  const cid = state.session ? state.session.client_id : null;
  // Only stop for a different shift. A missing session here can just mean the
  // server hasn't answered yet, and stopping would leave GPS off for good.
  if (g.wants_tracking && g.session_cid && cid && g.session_cid !== cid) native.stopTracking(false);
  else if (cid && g.session_cid === cid && g.wants_tracking && !g.tracking) native.startTracking(cid);
}

function renderGpsLine() {
  const el = $("#gps-line");
  if (!el) return;
  if (!native) {
    el.className = "gps-line muted-line";
    el.innerHTML = "GPS mileage works in the Android app.";
    return;
  }
  const g = gpsForShift();
  if (g && g.tracking) {
    const age = g.last_fix_ms ? Math.round((Date.now() - g.last_fix_ms) / 1000) : null;
    const stale = age == null || age > 90;
    el.className = `gps-line ${stale ? "warn" : ""}`;
    if (stale) {
      const mins = age == null ? null : Math.max(1, Math.round(age / 60));
      const off = g.gps_enabled === false ? ", and the phone's GPS is switched off" : "";
      el.innerHTML = `<strong>GPS stalled.</strong> <span class="mono">${num(g.miles, 1)}</span> mi so far,
        ${mins == null ? "no fix yet" : `no fix for ${mins} min`}${off}.
        <button type="button" class="linkish" id="gps-restart">Restart GPS</button>`;
      return;
    }
    const fix = age == null ? "Waiting for the first fix."
      : stale ? `No fix for ${Math.max(1, Math.round(age / 60))} min.`
      : `Last fix ${age}s ago, ±${Math.round(g.last_acc)} m.`;
    el.innerHTML = `<strong>GPS on:</strong> <span class="mono">${num(g.miles, 1)}</span> mi driven. ${fix}`;
  } else {
    const all = gpsStatus();
    const why = all && all.permission === "denied" ? " Location permission is off." : "";
    el.className = "gps-line warn";
    el.innerHTML = `<strong>GPS off.</strong>${why} <button type="button" class="linkish" id="gps-on">Turn on GPS</button>`;
  }
}

window.onNativeStatus = () => { renderGpsLine(); updateLiveNumbers(); };

// The Android app calls this when it comes back on screen. WebViews don't
// always fire visibilitychange on resume, which left the page showing whatever
// it loaded with until the app was force-closed.
window.onNativeResume = () => { onResume(); };

/* ---------- live shift: outbox and sync ---------- */
const COST_KEYS = ["vehicle", "mpg", "maint_per_mile", "gas_price", "deadhead_pct", "irs_rate", "tax_rate"];

function saveLive() { lsSet(KEYS.live, { session: state.session, deliveries: state.deliveries }); }

function byTime(a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; }

// Apply an operation to the local copy, the same way the server will.
function applyLocal(op) {
  switch (op.type) {
    case "start":
      state.session = { client_id: op.session_cid, date: op.date, started_at: op.started_at, status: "open" };
      for (const k of COST_KEYS) state.session[k] = op[k];
      state.deliveries = [];
      break;
    case "costs":
      if (state.session) {
        for (const k of COST_KEYS.concat("started_at")) if (op[k] != null) state.session[k] = op[k];
      }
      break;
    case "add":
      state.deliveries.push({ client_id: op.delivery_cid, at: op.at, amount: op.amount, miles: op.miles,
        uber_pay: op.uber_pay ?? null, tip: inferTip(op.amount, op.uber_pay) });
      state.deliveries.sort(byTime);
      break;
    case "edit": {
      const d = state.deliveries.find((x) => x.client_id === op.delivery_cid);
      if (d) {
        for (const k of ["amount", "miles", "uber_pay"]) if (k in op) d[k] = op[k];
        d.tip = inferTip(d.amount, d.uber_pay);
      }
      break;
    }
    case "delete":
      state.deliveries = state.deliveries.filter((x) => x.client_id !== op.delivery_cid);
      break;
    case "finish":
    case "discard":
      state.session = null;
      state.deliveries = [];
      break;
  }
}

function enqueue(op, renderOpts = {}) {
  op.op_id = uuid();
  state.outbox.push(op);
  lsSet(KEYS.outbox, state.outbox);
  applyLocal(op);
  saveLive();
  if (!state.session) {
    state.editingDeliveryId = null;
    state.finishOpen = false;
  }
  renderLive(renderOpts);
  refreshToday();
  flush();
}

let retryTimer = null;
function scheduleRetry(ms = 15000) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flush, ms);
}

async function flush() {
  if (state.syncing) return;
  if (!state.outbox.length) { updateNet(); return; }
  state.syncing = true;
  updateNet();
  const batch = state.outbox.slice();
  let ok = false;
  try {
    const res = await api("/api/sync", { method: "POST", body: { ops: batch }, timeout: 20000 });
    ok = true;
    state.online = true;
    const answered = new Set(res.results.map((r) => r.op_id));
    const failed = res.results.filter((r) => !r.ok);
    state.outbox = state.outbox.filter((o) => !answered.has(o.op_id));
    lsSet(KEYS.outbox, state.outbox);
    if (failed.length) {
      const first = failed[0].error || "rejected";
      toast(failed.length === 1 ? `A change couldn't be saved: ${first}`
        : `${failed.length} changes couldn't be saved. First: ${first}`, true);
    }
    if (!state.outbox.length) adoptServer(res);
    if (native && native.flushTrack) native.flushTrack();
  } catch (e) {
    if (e.network) state.online = false;
    else toast(`Sync problem: ${e.message}. Will retry.`, true);
    scheduleRetry();
  } finally {
    state.syncing = false;
    updateNet();
  }
  // Changes made while that request was in flight go out now.
  if (ok && state.outbox.some((o) => !batch.includes(o))) flush();
}

function adoptServer(d) {
  state.session = d.session;
  state.deliveries = d.deliveries || [];
  const json = JSON.stringify({ session: d.session, deliveries: d.deliveries || [] });
  const changed = json !== state.sessionJSON;
  state.sessionJSON = json;
  saveLive();
  if (!state.session) {
    state.editingDeliveryId = null;
    state.finishOpen = false;
  }
  reconcileGps();
  if (changed) { renderLive(); refreshToday(); }
  else updateLiveNumbers();
}

async function refreshSession() {
  if (state.outbox.length) return flush();
  try {
    const d = await api("/api/session");
    state.online = true;
    adoptServer(d);
  } catch (e) {
    if (e.network) state.online = false;
    else toast(e.message, true);
  }
  updateNet();
}

function updateNet() {
  const el = $("#netstatus");
  if (!el) return;
  const n = state.outbox.length;
  let text = "", cls = "";
  if (n) {
    text = `${n} change${n === 1 ? "" : "s"} waiting` + (!state.online ? ", offline" : state.syncing ? ", syncing" : "");
    cls = state.online ? "survive" : "behind";
  } else if (!state.online) {
    text = "Offline";
    cls = "behind";
  }
  el.textContent = text;
  el.className = `chip ${cls}`;
  el.hidden = !text;
}

/* ---------- live shift: rendering ---------- */
const liveField = (form, name) => $(`#${form}`)?.elements.namedItem(name);

function storeDraft(d) { lsSet(KEYS.draft, d); }
function readDraft() { return lsGet(KEYS.draft, null); }
function clearDraft() { lsSet(KEYS.draft, null); }

function captureLive() {
  const add = $("#add-delivery");
  const snap = add
    ? {
        amount: liveField("add-delivery", "amount").value,
        miles: liveField("add-delivery", "miles").value,
        uber_pay: liveField("add-delivery", "uber_pay").value,
        editing: state.editingDeliveryId,
      }
    : readDraft() || {};
  snap.costsOpen = $("#live-costs")?.open || false;
  if ($("#finish-form")) {
    snap.finish = {
      hours: liveField("finish-form", "hours").value,
      driven_miles: liveField("finish-form", "driven_miles").value,
      notes: liveField("finish-form", "notes").value,
    };
  }
  return snap;
}

function restoreLive(snap) {
  if (!snap || !$("#add-delivery")) return;
  const stillThere = snap.editing && state.deliveries.some((d) => d.client_id === snap.editing);
  state.editingDeliveryId = stillThere ? snap.editing : null;
  liveField("add-delivery", "amount").value = snap.amount ?? "";
  liveField("add-delivery", "miles").value = snap.miles ?? "";
  liveField("add-delivery", "uber_pay").value = snap.uber_pay ?? "";
  $("#live-costs").open = !!snap.costsOpen;
  if (snap.finish && state.finishOpen) {
    liveField("finish-form", "hours").value = snap.finish.hours;
    liveField("finish-form", "driven_miles").value = snap.finish.driven_miles;
    liveField("finish-form", "notes").value = snap.finish.notes;
  }
  syncAddButton();
  updateOfferHint();
}

function liveStats() {
  const s = state.session;
  const items = state.deliveries;
  const now = Date.now();
  const hours = Math.max((now - Date.parse(s.started_at)) / 3600000, 0);
  const gross = items.reduce((a, d) => a + d.amount, 0);
  const miles = items.reduce((a, d) => a + d.miles, 0);
  const tips = items.reduce((a, d) => a + (d.tip || 0), 0);
  const g = gpsForShift();
  const gpsMiles = g && g.miles > 0 ? g.miles : null;
  const c = calc({
    gross, paid_miles: miles, hours, driven_miles: gpsMiles, deadhead_pct: s.deadhead_pct, mpg: s.mpg,
    gas_price: s.gas_price, irs_rate: s.irs_rate, tax_rate: s.tax_rate, maint_per_mile: s.maint_per_mile,
  });
  const hourAgo = now - 3600000;
  const recent = items.filter((d) => Date.parse(d.at) >= hourAgo).reduce((a, d) => a + d.amount, 0);
  const window = Math.min(1, hours);
  return {
    hours, gross, miles, tips, c, gpsMiles, count: items.length,
    perHour: hours >= 0.05 ? gross / hours : null,
    keptPerHour: hours >= 0.05 ? c.cash / hours : null,
    lastHour: window >= 0.05 ? recent / window : null,
  };
}

function vehicleOptions(selected) {
  const names = state.settings.vehicles.map((v) => v.name);
  if (selected && !names.includes(selected)) names.push(selected);
  return names.map((n) => `<option ${n === selected ? "selected" : ""}>${esc(n)}</option>`).join("");
}

function renderLive({ clearAdd = false } = {}) {
  const el = $("#live");
  if (!state.settings) return;
  renderUpdateNote();   // hidden while a shift runs
  const snap = clearAdd ? {} : captureLive();

  if (!state.session) {
    const ps = perShift(todayISO());
    el.innerHTML = `
      <div class="card live idle">
        <div class="eyebrow">Tonight</div>
        <div class="start-row">
          <select id="start-vehicle" aria-label="Vehicle">${vehicleOptions(state.settings.default_vehicle)}</select>
          <button type="button" class="primary" id="start-shift">Start shift</button>
        </div>
        <div class="small muted">Add each delivery as you finish it, then save at the end of the night.
          Per-shift targets: base <span class="mono">${money(ps.survive, 2)}</span>, stretch <span class="mono">${money(ps.thrive, 2)}</span>.</div>
      </div>`;
    return;
  }

  const s = state.session;
  el.innerHTML = `
    <div class="card live">
      <div class="live-head">
        <span class="eyebrow">Shift running, started ${timeOf(s.started_at)}</span>
        <span class="mono" id="live-elapsed"></span>
      </div>
      <div id="gps-line" class="gps-line"></div>
      <div id="live-numbers"></div>

      <form id="add-delivery" class="add-row" autocomplete="off" novalidate>
        <label>Pay $<input name="amount" type="number" inputmode="decimal" step="any" min="0" required></label>
        <label>Miles<input name="miles" type="number" inputmode="decimal" step="any" min="0" required></label>
        <label>Before tip
          <input name="uber_pay" type="number" inputmode="decimal" step="any" min="0" placeholder="opt."></label>
        <button type="submit" class="primary" id="add-btn">Add</button>
      </form>
      <div class="offer-hint" id="offer-hint"></div>
      <div class="dlist" id="dlist"></div>

      <details id="live-costs" class="sub">
        <summary>Shift costs: ${esc(s.vehicle || "")}, gas <span class="mono">$${num(Number(s.gas_price), 2)}</span>, ${num(Number(s.deadhead_pct), 0)}% deadhead</summary>
        <form id="session-form" autocomplete="off" novalidate>
          <div class="grid2">
            <label>Vehicle<select name="vehicle">${vehicleOptions(s.vehicle)}</select></label>
            <label>Started at<input type="time" name="started_time" value="${localTimeValue(s.started_at)}" required></label>
            <label>Gas $/gal<input type="number" name="gas_price" inputmode="decimal" step="any" min="0" max="50" value="${s.gas_price}" required></label>
            <label>Deadhead %<input type="number" name="deadhead_pct" inputmode="decimal" step="any" min="0" max="90" value="${s.deadhead_pct}" required></label>
            <label>MPG<input type="number" name="mpg" inputmode="decimal" step="any" min="1" max="200" value="${s.mpg}" required></label>
            <label>Wear $/mi<input type="number" name="maint_per_mile" inputmode="decimal" step="any" min="0" max="2" value="${s.maint_per_mile ?? 0}" required></label>
            <label>Tax set-aside %<input type="number" name="tax_rate" inputmode="decimal" step="any" min="0" max="100" value="${s.tax_rate}" required></label>
            <label>IRS rate $/mi<input type="number" name="irs_rate" inputmode="decimal" step="any" min="0" max="5" value="${s.irs_rate}" required></label>
          </div>
          <p class="muted small">These freeze onto tonight's entry when you save it. Changing Settings won't touch them.</p>
          <button type="submit" class="primary wide">Save shift costs</button>
        </form>
      </details>

      <div class="actions" id="live-actions" ${state.finishOpen ? "hidden" : ""}>
        <button type="button" class="primary" id="finish-open">Finish and save</button>
        <button type="button" class="ghost danger" id="discard">Discard</button>
      </div>

      <form id="finish-form" class="finish" autocomplete="off" novalidate ${state.finishOpen ? "" : "hidden"}>
        <h3>Save tonight's shift</h3>
        <div class="grid2">
          <label>Hours<input type="number" name="hours" inputmode="decimal" step="any" min="0" max="24" required></label>
          <label><span>Driven miles <span class="hint" id="driven-hint">optional</span></span>
            <input type="number" name="driven_miles" inputmode="decimal" step="any" min="0"></label>
        </div>
        <label>Notes<input type="text" name="notes" maxlength="500"></label>
        <div id="finish-summary" class="small muted"></div>
        <div class="actions">
          <button type="submit" class="primary">Save to history</button>
          <button type="button" class="ghost" id="finish-cancel">Back</button>
        </div>
      </form>
    </div>`;
  restoreLive(snap);
  if (state.finishOpen && !(snap.finish && snap.finish.hours)) prefillFinish();
  renderDList();
  renderGpsLine();
  updateLiveNumbers();
}

function barHTML(label, actual, full, toDate, started) {
  if (!(full > 0)) return "";   // no target set for this period
  const pct = full > 0 ? Math.min(actual / full, 1) * 100 : 0;
  const tick = full > 0 ? Math.min(toDate / full, 1) * 100 : 0;
  const ok = started ? actual >= toDate : actual >= full;
  return `
    <div class="barrow">
      <div class="barhead"><span><strong>${label}</strong></span><span class="mono">${money(actual)} of ${money(full)}</span></div>
      <div class="bar">
        <div class="fill ${ok ? "ok" : ""}" style="width:${pct.toFixed(1)}%"></div>
        ${full > 0 && started ? `<div class="tick" style="left:${tick.toFixed(1)}%"></div>` : ""}
      </div>
      ${started ? `<div class="muted small">Where you should be by today: <span class="mono">${money(toDate)} (${signedMoney(actual - toDate)})</span></div>` : ""}
    </div>`;
}

function stat(label, value) {
  return `<div class="stat"><div class="k">${label}</div><div class="v">${value}</div></div>`;
}

function updateLiveNumbers() {
  if (!state.session || !$("#live-numbers")) return;
  const st = liveStats();
  const ps = perShift(state.session.date);
  $("#live-elapsed").textContent = hhmm(st.hours);
  // Shifts already saved today: a second run after an errand counts toward the
  // same day's target, so the bars track the day, not just this run.
  const before = state.dayBefore && state.dayBefore.date === state.session.date ? state.dayBefore : null;
  const dayGross = st.gross + (before ? before.gross : 0);
  const dayCash = st.c.cash + (before ? before.cash : 0);
  const chip = st.count || before ? status(dayGross, ps.survive, ps.thrive) : { cls: "idle", text: "No deliveries yet" };
  const avg = st.count ? st.gross / st.count : null;
  const need = (label, target) => {
    const left = target - dayGross;
    if (left <= 0.005) return `<li><strong>${label}:</strong> hit, <span class="mono">${money(-left, 2)}</span> over.</li>`;
    const more = avg ? `, about ${Math.ceil(left / avg)} more at tonight's <span class="mono">${money(avg, 2)}</span> average` : "";
    return `<li><strong>${label}:</strong> <span class="mono">${money(left, 2)}</span> to go${more}.</li>`;
  };
  const driven = st.gpsMiles != null ? `${num(st.gpsMiles, 1)} GPS` : `${num(st.c.driven, 1)} est.`;
  $("#live-numbers").innerHTML = `
    <div class="live-big">
      <div><span class="k">Gross tonight</span><div class="big">${money(st.gross, 2)}</div></div>
      <div class="right"><span class="k">You keep</span><div class="v">${money(st.c.cash, 2)}</div><span class="chip ${chip.cls}">${chip.text}</span></div>
    </div>
    ${before ? `<div class="small muted daybefore">Plus ${before.entries} earlier shift${before.entries === 1 ? "" : "s"} today:
      <span class="mono">${money(before.gross, 2)}</span> gross, <span class="mono">${money(before.cash, 2)}</span> kept.
      Today so far <span class="mono">${money(dayGross, 2)}</span> gross, <span class="mono">${money(dayCash, 2)}</span> kept.</div>` : ""}
    ${barHTML(before ? "Base today" : "Base", dayGross, ps.survive, 0, false)}
    ${barHTML(before ? "Stretch today" : "Stretch", dayGross, ps.thrive, 0, false)}
    ${ps.survive > 0 || ps.thrive > 0
      ? `<ul class="need">${need("Base", ps.survive)}${need("Stretch", ps.thrive)}</ul>`
      : `<div class="small muted">No targets yet. Set a monthly Base and Stretch in Settings.</div>`}
    <div class="stats" style="margin-top:12px">
      ${stat("Deliveries", st.count)}
      ${stat("Per hour", money(st.perHour, 2))}
      ${stat("Last 60 min", st.lastHour != null ? money(st.lastHour, 2) : "-")}
      ${stat("Paid miles", num(st.miles, 1))}
      ${stat("Driven miles", driven)}
      ${stat("Per driven mile", (() => { const dm = st.gpsMiles ?? st.c.driven; return dm ? money(st.gross / dm, 2) : "-"; })())}
      ${stat("Kept per hour", money(st.keptPerHour, 2))}
      ${stat("Tips", st.tips ? money(st.tips, 2) : "-")}
      ${stat("Per delivery", money(avg, 2))}
    </div>`;
  renderGpsLine();
  if (native && native.setNotificationText) {
    native.setNotificationText(`${money(st.gross, 2)} · ${st.count} ${st.count === 1 ? "delivery" : "deliveries"} · ${hhmm(st.hours)}`);
  }
  if (state.finishOpen) updateFinishSummary();
}

function renderDList() {
  const el = $("#dlist");
  if (!el) return;
  const items = state.deliveries;
  if (!items.length) {
    el.innerHTML = `<div class="muted small empty-note">No deliveries yet. Add each one as you finish it.</div>`;
    return;
  }
  el.innerHTML = items.map((d, i) => ({ d, n: i + 1 })).reverse().map(({ d, n }) => {
    const ppm = d.miles ? d.amount / d.miles : null;
    // The tip is inside the total, so show the split rather than "+tip".
    const uber = d.tip ? (d.uber_pay ?? round2(d.amount - d.tip)) : null;
    return `<div class="drow ${state.editingDeliveryId === d.client_id ? "editing" : ""}" data-did="${esc(d.client_id)}">
      <span class="mono"><span class="muted small">#${n}</span> ${money(d.amount, 2)}</span>
      <span class="mono">${num(d.miles, 1)} mi</span>
      <span class="chip ${perMileClass(ppm)}" style="${perMileStyle(ppm)}">${ppm != null ? `${money(ppm, 2)}/mi gross` : "-"}</span>
      <button type="button" class="x" data-ddel="${esc(d.client_id)}" aria-label="Delete delivery">✕</button>
      <span class="muted small mono drow-sub">${timeOf(d.at)}${d.tip ? ` · ${money(uber, 2)} Uber · ${money(d.tip, 2)} tip` : ""}</span>
    </div>`;
  }).join("");
}

function updateOfferHint() {
  const el = $("#offer-hint");
  if (!el) return;
  const amount = Number(liveField("add-delivery", "amount").value);
  const miles = Number(liveField("add-delivery", "miles").value);
  const editing = state.editingDeliveryId
    ? `Editing delivery. <button type="button" class="linkish" id="cancel-dedit">Cancel edit</button>`
    : "";
  if (amount > 0 && miles > 0) {
    const ppm = amount / miles;
    const cls = perMileClass(ppm);
    const word = { thrive: "good", survive: "okay", behind: "below your minimum" }[cls];
    el.innerHTML = `<span class="chip ${cls}" style="${perMileStyle(ppm)}">${money(ppm, 2)}/mi</span> <span class="muted">${word}</span> ${editing}`;
  } else {
    el.innerHTML = editing;
  }
}

function syncAddButton() {
  const btn = $("#add-btn");
  if (btn) btn.textContent = state.editingDeliveryId ? "Update" : "Add";
  $$(".drow").forEach((r) => r.classList.toggle("editing", r.dataset.did === state.editingDeliveryId));
}

/* ---------- live shift: actions ---------- */
// Shown once when a shift starts. Drawn from a shuffled bag so the whole list
// runs through before any of them comes round again.
const SHIFT_HELLOS = [
  "Shift started. Good luck.",
  "Clock's running. Go get it.",
  "Meter's on.",
  "Roll out.",
  "Lights, mirrors, go.",
  "Another night, another tank.",
  "Let's see what's out there.",
  "Time to work.",
  "Green light.",
  "Headlights on.",
  "Go find the good ones.",
  "Take the close ones.",
  "Short trips, fast turns.",
  "Decline the long cheap ones.",
  "Nothing under your floor tonight.",
  "The close orders pay best.",
  "Watch the deadhead.",
  "Every mile costs something.",
  "Get the miles that pay.",
  "Trust the numbers, not the vibe.",
  "Bank a good one early.",
  "First one's always slow.",
  "One order at a time.",
  "Steady pace beats a sprint.",
  "Patience early, speed later.",
  "Slow starts still end well.",
  "Half of this is patience.",
  "Make the first hour count.",
  "Stack the wins.",
  "Let's beat last Friday.",
  "Base first, stretch after.",
  "Tonight's target is on the card.",
  "Tips land later. Keep going.",
  "The tax set-aside is handled.",
  "The app counts. You drive.",
  "Log each one as you go.",
  "Tap Add after every drop.",
  "Hot bag zipped?",
  "Don't forget the drinks.",
  "Check the drink carrier.",
  "Bags upright.",
  "Knock, photo, gone.",
  "Snap the photo, move on.",
  "Park legal, walk fast.",
  "Don't wait twenty for a four dollar order.",
  "Cancel the stalls, keep moving.",
  "Ten minutes waiting is ten minutes gone.",
  "Gentle on the throttle.",
  "Drive like the car has to last.",
  "Easy on the hills.",
  "Keep an eye on the tach.",
  "Watch the temp gauge.",
  "Fuel light is a liar. Fill early.",
  "Mind the gas gauge.",
  "Tires up to pressure?",
  "Careful on the left turns.",
  "Nothing out here is worth a ticket.",
  "Deer after dark. Eyes up.",
  "Javelina at dusk.",
  "Don't cross a running wash.",
  "Storm season. Watch the low spots.",
  "It's cooler now. Small mercy.",
  "Water in the cupholder.",
  "Hydrate. It's a long one.",
  "Eat something before hour three.",
  "Stretch at the next light.",
  "Seatbelt, then pizza.",
  "Phone mounted?",
  "Charger plugged in?",
  "Batteries charged. Go.",
  "You've done harder nights.",
  "Steady hands.",
  "Long night. Short memory.",
  "Money's out there.",
  "Go earn it.",
  "Make it count.",
  "Drive safe out there.",
];

function shiftHello() {
  let bag = lsGet(KEYS.hellos, null);
  if (!Array.isArray(bag) || !bag.length || bag.some((i) => typeof i !== "number")) {
    bag = SHIFT_HELLOS.map((_, i) => i);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }
  const pick = bag.pop();
  lsSet(KEYS.hellos, bag);
  return SHIFT_HELLOS[pick] || SHIFT_HELLOS[0];
}

function startShift() {
  const s = state.settings;
  const vehicle = $("#start-vehicle").value;
  const cid = uuid();
  clearDraft();
  state.finishOpen = false;
  enqueue({
    type: "start",
    session_cid: cid,
    date: todayISO(),
    started_at: new Date().toISOString(),
    vehicle,
    mpg: Number(vehicleMpg(vehicle)) || null,
    maint_per_mile: vehicleMaint(vehicle),
    gas_price: s.gas_price,
    deadhead_pct: shiftDeadhead(),
    irs_rate: s.irs_rate,
    tax_rate: s.tax_rate,
  }, { clearAdd: true });
  if (native) native.startTracking(cid);
  toast(shiftHello(), false, 6000);
}

// Uber's screen shows its own pay first and the tip an hour later, so the
// tip is the difference between the running total and what Uber paid.
function inferTip(amount, uberPay) {
  return uberPay == null ? null : Math.max(round2(Number(amount) - Number(uberPay)), 0);
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function submitDelivery() {
  const f = $("#add-delivery");
  if (!f.reportValidity()) return;
  const get = (n) => liveField("add-delivery", n).value.trim();
  const amount = Number(get("amount"));
  const miles = Number(get("miles"));
  const uber_pay = get("uber_pay") === "" ? null : Number(get("uber_pay"));
  if (uber_pay != null && uber_pay > amount + 0.005) {
    return toast("Uber's pay can't be more than the total", true);
  }
  const editing = state.editingDeliveryId;
  state.editingDeliveryId = null;
  clearDraft();
  if (editing) {
    enqueue({ type: "edit", delivery_cid: editing, amount, miles, uber_pay }, { clearAdd: true });
    toast("Delivery updated");
  } else {
    enqueue({
      type: "add",
      session_cid: state.session.client_id,
      delivery_cid: uuid(),
      amount, miles, uber_pay,
      at: new Date().toISOString(),
    }, { clearAdd: true });
    toast(`Added ${money(amount, 2)}${miles ? `, ${money(amount / miles, 2)}/mi` : ""}`);
  }
}

function startDeliveryEdit(cid) {
  const d = state.deliveries.find((x) => x.client_id === cid);
  if (!d) return;
  state.editingDeliveryId = cid;
  liveField("add-delivery", "amount").value = d.amount;
  liveField("add-delivery", "miles").value = d.miles;
  liveField("add-delivery", "uber_pay").value = d.uber_pay ?? (d.tip != null ? round2(d.amount - d.tip) : "");
  syncAddButton();
  updateOfferHint();
  $("#add-delivery").scrollIntoView({ block: "center", behavior: "smooth" });
}

function cancelDeliveryEdit() {
  state.editingDeliveryId = null;
  $("#add-delivery").reset();
  clearDraft();
  syncAddButton();
  updateOfferHint();
}

function deleteDelivery(cid) {
  const d = state.deliveries.find((x) => x.client_id === cid);
  if (!d || !confirm(`Delete the ${money(d.amount, 2)} delivery from ${timeOf(d.at)}?`)) return;
  const wasEditing = state.editingDeliveryId === cid;
  if (wasEditing) { state.editingDeliveryId = null; clearDraft(); }
  enqueue({ type: "delete", delivery_cid: cid }, { clearAdd: wasEditing });
  toast("Delivery deleted");
}

function startedAtFromTime(t) {
  const [h, m] = t.split(":").map(Number);
  const d = parseISO(state.session.date);
  d.setHours(h, m, 0, 0);
  if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1);
  return d.toISOString();
}

function saveSessionCosts() {
  const f = $("#session-form");
  if (!f.reportValidity()) return;
  const g = (n) => f.elements.namedItem(n).value;
  enqueue({
    type: "costs",
    session_cid: state.session.client_id,
    vehicle: g("vehicle"),
    mpg: Number(g("mpg")),
    maint_per_mile: Number(g("maint_per_mile")),
    gas_price: Number(g("gas_price")),
    deadhead_pct: Number(g("deadhead_pct")),
    irs_rate: Number(g("irs_rate")),
    tax_rate: Number(g("tax_rate")),
    started_at: startedAtFromTime(g("started_time")),
  });
  toast("Shift costs saved");
}

function prefillFinish() {
  const st = liveStats();
  liveField("finish-form", "hours").value = (Math.round(st.hours * 100) / 100).toFixed(2);
  const driven = liveField("finish-form", "driven_miles");
  const hint = $("#driven-hint");
  if (st.gpsMiles != null) {
    driven.value = st.gpsMiles.toFixed(1);
    state.finishMilesFromGps = true;
    if (hint) hint.textContent = "from GPS";
  } else {
    state.finishMilesFromGps = false;
    if (hint) hint.textContent = native ? "optional, GPS was off" : "optional";
  }
  updateFinishSummary();
}

function updateFinishSummary() {
  const el = $("#finish-summary");
  if (!el || !state.session) return;
  const s = state.session;
  const st = liveStats();
  const hours = Number(liveField("finish-form", "hours").value) || 0;
  const driven = liveField("finish-form", "driven_miles").value;
  const c = calc({
    gross: st.gross, paid_miles: st.miles, hours, driven_miles: driven === "" ? null : driven,
    deadhead_pct: s.deadhead_pct, mpg: s.mpg, gas_price: s.gas_price, irs_rate: s.irs_rate, tax_rate: s.tax_rate,
    maint_per_mile: s.maint_per_mile,
  });
  el.innerHTML = `Saves as one shift on ${shortDate(s.date)}: <span class="mono">${money(st.gross, 2)}</span> gross,
    ${st.count} deliveries, <span class="mono">${num(st.miles, 1)}</span> paid mi, <span class="mono">${num(c.driven, 1)}</span> driven,
    you keep <span class="mono">${money(c.cash, 2)}</span>${c.perHour ? `, <span class="mono">${money(c.perHour, 2)}</span>/h` : ""}.`;
}

function openFinish() {
  if (!state.deliveries.length) return toast("Add at least one delivery first, or discard the shift", true);
  state.finishOpen = true;
  $("#live-actions").hidden = true;
  $("#finish-form").hidden = false;
  prefillFinish();
  $("#finish-form").scrollIntoView({ block: "center", behavior: "smooth" });
}

function closeFinish() {
  state.finishOpen = false;
  $("#live-actions").hidden = false;
  $("#finish-form").hidden = true;
}

function finishShift() {
  const f = $("#finish-form");
  if (!f.reportValidity()) return;
  const g = (n) => f.elements.namedItem(n).value.trim();
  const driven = g("driven_miles");
  const st = liveStats();
  const gross = st.gross;
  const op = {
    type: "finish",
    session_cid: state.session.client_id,
    hours: g("hours") === "" ? null : Number(g("hours")),
    driven_miles: driven === "" ? null : Number(driven),
    miles_source: driven === "" ? null : state.finishMilesFromGps ? "gps" : "entered",
    notes: g("notes") || null,
    ended_at: new Date().toISOString(),
  };
  clearDraft();
  state.finishOpen = false;
  enqueue(op, { clearAdd: true });
  if (native) native.stopTracking(false);
  toast(state.online ? `Saved: ${money(gross, 2)} gross` : `Saved on this phone. It uploads when you have signal.`);
}

function discardShift() {
  const n = state.deliveries.length;
  const what = n ? ` and its ${n} deliver${n === 1 ? "y" : "ies"}` : "";
  if (!confirm(`Discard this shift${what}? Nothing gets saved and this can't be undone.`)) return;
  clearDraft();
  enqueue({ type: "discard", session_cid: state.session.client_id }, { clearAdd: true });
  if (native) native.stopTracking(true);
  toast("Shift discarded");
}

function bindLive() {
  const live = $("#live");
  live.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.closest("#start-shift")) return startShift();
    if (t.closest("#finish-open")) return openFinish();
    if (t.closest("#finish-cancel")) return closeFinish();
    if (t.closest("#discard")) return discardShift();
    if (t.closest("#cancel-dedit")) return cancelDeliveryEdit();
    if (t.closest("#gps-on") || t.closest("#gps-restart")) {
      if (native && state.session) native.startTracking(state.session.client_id);
      return;
    }
    const del = t.closest("[data-ddel]");
    if (del) return deleteDelivery(del.dataset.ddel);
    const row = t.closest(".drow[data-did]");
    if (row) return startDeliveryEdit(row.dataset.did);
  });
  live.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (ev.target.id === "add-delivery") submitDelivery();
    else if (ev.target.id === "session-form") saveSessionCosts();
    else if (ev.target.id === "finish-form") finishShift();
  });
  live.addEventListener("input", (ev) => {
    if (ev.target.closest("#add-delivery")) {
      updateOfferHint();
      storeDraft(captureLive());
    } else if (ev.target.closest("#finish-form")) {
      if (ev.target.name === "driven_miles") {
        state.finishMilesFromGps = false;
        const hint = $("#driven-hint");
        if (hint) hint.textContent = "entered";
      }
      updateFinishSummary();
    }
  });
  live.addEventListener("change", (ev) => {
    if (ev.target.name === "vehicle" && ev.target.closest("#session-form")) {
      const m = vehicleMpg(ev.target.value);
      if (m !== "") $("#session-form").elements.namedItem("mpg").value = m;
      $("#session-form").elements.namedItem("maint_per_mile").value = vehicleMaint(ev.target.value);
    }
  });
  setInterval(() => {
    if (state.session && state.view === "log" && document.visibilityState === "visible") updateLiveNumbers();
  }, native ? 10000 : 20000);
  setInterval(() => { if (state.outbox.length) flush(); }, 30000);
  window.addEventListener("online", () => { state.online = true; flush(); refreshSession(); });
}

/* ---------- manual log form ---------- */
const FORM_FIELDS = ["date", "vehicle", "gross", "paid_miles", "hours", "orders", "tips",
  "gas_price", "deadhead_pct", "mpg", "maint_per_mile", "driven_miles", "irs_rate", "tax_rate", "notes"];
const NUMERIC = new Set(["gross", "paid_miles", "hours", "orders", "tips", "gas_price",
  "deadhead_pct", "mpg", "maint_per_mile", "driven_miles", "irs_rate", "tax_rate"]);
const field = (name) => $("#entry-form").elements.namedItem(name);

function readForm() {
  const out = {};
  for (const k of FORM_FIELDS) {
    const raw = String(field(k).value).trim();
    out[k] = raw === "" ? null : NUMERIC.has(k) ? Number(raw) : raw;
  }
  return out;
}

function vehicleMpg(name) {
  const v = state.settings.vehicles.find((x) => x.name === name);
  return v ? v.mpg : "";
}

function vehicleMaint(name) {
  const v = state.settings.vehicles.find((x) => x.name === name);
  return v && v.maint_per_mile != null ? v.maint_per_mile : 0;
}

function fillVehicles(selected) {
  const sel = field("vehicle");
  const names = state.settings.vehicles.map((v) => v.name);
  if (selected && !names.includes(selected)) names.push(selected);
  sel.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("");
  sel.value = selected && names.includes(selected) ? selected : state.settings.default_vehicle;
}

function resetForm(date, vehicle) {
  const s = state.settings;
  $("#entry-form").reset();
  const v = vehicle && s.vehicles.some((x) => x.name === vehicle) ? vehicle : s.default_vehicle;
  fillVehicles(v);
  field("date").value = date || todayISO();
  field("gas_price").value = s.gas_price;
  field("deadhead_pct").value = s.deadhead_pct;
  field("mpg").value = vehicleMpg(v);
  field("maint_per_mile").value = vehicleMaint(v);
  field("irs_rate").value = s.irs_rate;
  field("tax_rate").value = s.tax_rate;
  updatePreview();
}

function startEdit(entry) {
  state.editingId = entry.id;
  state.returnTo = state.view;
  fillVehicles(entry.vehicle);
  for (const k of FORM_FIELDS) {
    if (k !== "vehicle") field(k).value = entry[k] ?? "";
  }
  field("save_defaults").checked = false;
  $("#form-title").textContent = `Edit shift, ${shortDate(entry.date)}`;
  $("#save-btn").textContent = "Update shift";
  $("#cancel-edit").hidden = false;
  $("#manual").open = true;
  $("#assumptions").open = true;
  show("log");
  updatePreview();
  loadEditDeliveries(entry);
  $("#manual").scrollIntoView({ block: "start" });
}

/* ---------- deliveries on a saved live shift ---------- */
const ROLLUP_FIELDS = ["gross", "paid_miles", "orders", "tips"];

function clearEditDeliveries() {
  state.editDeliveries = null;
  const box = $("#edit-deliveries");
  if (box) { box.hidden = true; box.innerHTML = ""; box.oninput = null; }
  for (const k of ROLLUP_FIELDS) field(k).readOnly = false;
}

async function loadEditDeliveries(entry) {
  clearEditDeliveries();
  if (!entry.from_live) return;
  const box = $("#edit-deliveries");
  try {
    const { deliveries } = await api(`/api/entries/${entry.id}/deliveries`);
    if (state.editingId !== entry.id || !deliveries.length) return;
    state.editDeliveries = deliveries;
    // A total typed by hand after the shift isn't on any delivery. Say so,
    // because updating takes the total from the deliveries.
    const sum = round2(deliveries.reduce((a, d) => a + (Number(d.amount) || 0), 0));
    const gap = round2(Number(entry.gross) - sum);
    const gapNote = Math.abs(gap) > 0.005
      ? `<div class="gap-note small">Saved total is <span class="mono">${money(entry.gross, 2)}</span>, ${money(Math.abs(gap), 2)} ${gap > 0 ? "more" : "less"} than these deliveries add up to. Put that on the deliveries it belongs to, or updating will change the total to <span class="mono">${money(sum, 2)}</span>.</div>`
      : "";
    // Rows stay in time order in the page, so edits and the rollup keep their
    // positions; the toggle only flips how they're drawn (CSS column-reverse).
    const newest = lsGet(KEYS.editOrder, "newest") === "newest";
    box.innerHTML = `
      <div class="k">Deliveries <span class="hint">fix a late tip here and the totals follow</span>
        <button type="button" class="linkish" id="edit-order">${newest ? "Newest first" : "Oldest first"}</button></div>
      ${gapNote}
      <div class="erows${newest ? " newest-first" : ""}">
      ${deliveries.map((d, i) => `
        <div class="erow" data-edid="${d.id}">
          <span class="muted mono small erow-head">#${i + 1} ${timeOf(d.at)} · ${num(d.miles, 1)} mi<span data-tip></span></span>
          <label>Pay $<input type="number" data-k="amount" inputmode="decimal" step="any" min="0" value="${d.amount}"></label>
          <label>Before tip<input type="number" data-k="uber_pay" inputmode="decimal" step="any" min="0" placeholder="opt." value="${d.uber_pay ?? ""}"></label>
        </div>`).join("")}
      </div>`;
    $("#edit-order").onclick = (ev) => {
      const list = $(".erows", box);
      const nowNewest = list.classList.toggle("newest-first");
      lsSet(KEYS.editOrder, nowNewest ? "newest" : "oldest");
      ev.target.textContent = nowNewest ? "Newest first" : "Oldest first";
    };
    box.hidden = false;
    box.oninput = rollupDeliveries;
    for (const k of ROLLUP_FIELDS) field(k).readOnly = true;
    rollupDeliveries();
  } catch (e) {
    box.hidden = false;
    box.innerHTML = `<div class="muted small">${e.network
      ? "No signal, so this shift's deliveries can't load. The totals can still be typed in."
      : `Couldn't load this shift's deliveries: ${esc(e.message)}`}</div>`;
  }
}

// Totals on the form follow the deliveries, so a late tip is typed once.
function rollupDeliveries() {
  const rows = $$("#edit-deliveries .erow");
  if (!rows.length || !state.editDeliveries) return;
  let gross = 0, miles = 0, tips = 0, anyTip = false;
  rows.forEach((r, i) => {
    const amount = Number($("[data-k=amount]", r).value) || 0;
    const ub = $("[data-k=uber_pay]", r).value;
    const tip = ub === "" ? null : Math.max(round2(amount - Number(ub)), 0);
    $("[data-tip]", r).textContent = tip != null ? ` · ${money(tip, 2)} tip` : "";
    gross += amount;
    miles += Number(state.editDeliveries[i].miles) || 0;
    if (tip != null) { tips += tip; anyTip = true; }
  });
  field("gross").value = round2(gross);
  field("paid_miles").value = round2(miles);
  field("orders").value = rows.length;
  field("tips").value = anyTip ? round2(tips) : "";
  updatePreview();
}

function editedDeliveries() {
  return $$("#edit-deliveries .erow").map((r) => {
    const ub = $("[data-k=uber_pay]", r).value;
    const out = { id: Number(r.dataset.edid), amount: Number($("[data-k=amount]", r).value) };
    if (ub === "") { out.uber_pay = null; out.tip = null; } else out.uber_pay = Number(ub);
    return out;
  });
}

function exitEdit() {
  state.editingId = null;
  state.returnTo = null;
  $("#form-title").textContent = "Log a whole shift by hand";
  $("#save-btn").textContent = "Save shift";
  $("#cancel-edit").hidden = true;
  $("#assumptions").open = false;
  clearEditDeliveries();
}

function updatePreview() {
  if (!state.settings) return;
  const d = readForm();
  const c = calc(d);
  $("#assump-summary").textContent =
    `gas $${num(d.gas_price ?? 0, 2)}, ${num(d.deadhead_pct ?? 0, 0)}% deadhead, ${num(d.mpg ?? 0, 1)} mpg, $${num(d.maint_per_mile ?? 0, 3)}/mi wear`;
  const el = $("#preview");
  if (!d.gross && !d.paid_miles) {
    el.innerHTML = `<span class="muted">Enter gross and paid miles to see what you keep.</span>`;
    return;
  }
  const ps = d.date ? perShift(d.date) : null;
  const st = ps ? status(c.gross, ps.survive, ps.thrive) : null;
  el.innerHTML = `
    <div class="pv-main">
      <div><span class="k">You keep</span><div class="v">${money(c.cash, 2)}</div></div>
      ${st ? `<span class="chip ${st.cls}">${st.text}</span>` : ""}
    </div>
    <div class="pv-grid mono">
      <div><span class="k">Driven</span>${num(c.driven, 1)} mi</div>
      <div><span class="k">Fuel</span>${money(c.fuel, 2)}</div>
      <div><span class="k">Wear</span>${money(c.wear, 2)}</div>
      <div><span class="k">Tax set-aside</span>${money(c.tax, 2)}</div>
      <div><span class="k">Per hour</span>${money(c.perHour, 2)}</div>
      <div><span class="k">Kept per hour</span>${money(c.cashPerHour, 2)}</div>
      <div><span class="k">Per driven mile</span>${money(c.driven ? c.gross / c.driven : null, 2)}</div>
    </div>
    ${ps ? `<div class="muted small">Per-shift targets for ${MONTHS[parseISO(d.date).getMonth()]}: base ${money(ps.survive, 2)}, stretch ${money(ps.thrive, 2)}</div>` : ""}`;
}

async function onSubmit(ev) {
  ev.preventDefault();
  const f = $("#entry-form");
  if ($$("#assumptions input").some((i) => !i.checkValidity())) $("#assumptions").open = true;
  if (!f.reportValidity()) return;
  const data = readForm();
  const saveDefaults = field("save_defaults").checked;
  const btn = $("#save-btn");
  btn.disabled = true;
  try {
    const wasEditing = state.editingId;
    const back = state.returnTo;
    if (wasEditing) {
      const body = state.editDeliveries ? { ...data, deliveries: editedDeliveries() } : data;
      await api(`/api/entries/${wasEditing}`, { method: "PUT", body });
    } else {
      await api("/api/entries", { method: "POST", body: data });
    }
    if (saveDefaults) {
      await api("/api/settings", { method: "PUT", body: { gas_price: data.gas_price, deadhead_pct: data.deadhead_pct } });
      await loadSettings();
    }
    exitEdit();
    resetForm(todayISO(), data.vehicle);
    $("#manual").open = false;
    toast(wasEditing ? "Shift updated" : `Saved: you kept ${money(calc(data).cash, 2)}`);
    show(wasEditing && back && back !== "log" ? back : "log");
  } catch (e) {
    toast(e.network ? "No signal. Hand-entered shifts need the server; live shifts work offline." : e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- today card ---------- */
async function refreshToday() {
  const t = todayISO();
  const ws = mondayOf(t);
  const we = addDays(ws, 6);
  const el = $("#today-card");
  const run = state.session ? liveStats() : null;
  try {
    const s = await api(`/api/summary?start=${ws}&end=${we}&today=${t}`);
    state.online = true;
    const day = s.days.find((d) => d.date === t);
    state.dayBefore = day && day.entries
      ? { gross: day.gross, cash: day.cash, entries: day.entries, date: t } : null;
    updateLiveNumbers();
    const ps = perShift(t);
    const runToday = run && state.session && state.session.date === t ? run.gross : 0;
    const runWeek = run && state.session && state.session.date >= ws && state.session.date <= we ? run.gross : 0;
    const dayGross = day.gross + runToday;
    const weekGross = s.totals.gross + runWeek;
    const wk = status(weekGross, s.targets.survive_to_date, s.targets.thrive_to_date);
    const dayStatus = dayGross > 0 ? status(dayGross, ps.survive, ps.thrive) : { cls: "idle", text: "Nothing yet" };
    el.innerHTML = `
      <div class="today-grid">
        <div>
          <span class="k">Today</span>
          <div class="v">${money(dayGross, 2)}</div>
          <div class="small muted">shift target <span class="mono">${money(ps.survive, 0)}</span> base, <span class="mono">${money(ps.thrive, 0)}</span> stretch</div>
          <div style="margin-top:6px"><span class="chip ${dayStatus.cls}">${dayStatus.text}</span></div>
        </div>
        <div>
          <span class="k">This week</span>
          <div class="v">${money(weekGross)}</div>
          <div class="small muted">of <span class="mono">${money(s.targets.survive)}</span> base, <span class="mono">${money(s.targets.thrive)}</span> stretch</div>
          <div style="margin-top:6px"><span class="chip ${wk.cls}">${wk.text}</span></div>
        </div>
      </div>
      ${run && run.gross ? `<div class="small muted" style="margin-top:8px">Includes <span class="mono">${money(run.gross, 2)}</span> from the running shift, not saved yet.</div>` : ""}`;
  } catch (e) {
    if (e.network) state.online = false;
    el.innerHTML = e.network
      ? `<span class="muted">No signal. Today's and this week's totals update when you're back online.</span>`
      : `<span class="muted">${esc(e.message)}</span>`;
  }
  updateNet();
}

/* ---------- week / month ---------- */
function summaryHTML(s) {
  const T = s.totals, G = s.targets, R = s.remaining;
  const started = s.today >= s.start;
  const st = started ? status(T.gross, G.survive_to_date, G.thrive_to_date) : { cls: "idle", text: "Not started" };
  const shiftsLeft = R.shifts_left > 0 ? Math.max(1, Math.round(R.shifts_left)) : 0;
  const needLine = (label, needed) => {
    if (needed <= 0.005) return `<li><strong>${label}:</strong> target met.</li>`;
    if (!shiftsLeft) return `<li><strong>${label}:</strong> finished <span class="mono">${money(needed)}</span> short.</li>`;
    return `<li><strong>${label}:</strong> <span class="mono">${money(needed)}</span> to go, about <span class="mono">${money(needed / shiftsLeft, 2)}</span> a shift over your ${shiftsLeft} remaining shift${shiftsLeft === 1 ? "" : "s"}.</li>`;
  };
  const tips = T.tips_share != null ? `${money(T.tips)} (${num(T.tips_share * 100, 0)}%)` : "-";
  return `
    <div class="card">
      <div class="sum-top">
        <div>
          <span class="k">Gross</span>
          <div class="big">${money(T.gross)}</div>
          <div class="small muted">kept <span class="mono">${money(T.cash)}</span> after fuel, wear and tax set-aside</div>
        </div>
        <span class="chip ${st.cls}">${st.text}</span>
      </div>
      ${barHTML("Base", T.gross, G.survive, G.survive_to_date, started)}
      ${barHTML("Stretch", T.gross, G.thrive, G.thrive_to_date, started)}
      ${G.survive > 0 || G.thrive > 0
        ? `<ul class="need">${needLine("Base", R.survive_needed)}${needLine("Stretch", R.thrive_needed)}</ul>`
        : `<div class="small muted">No targets yet. Set a monthly Base and Stretch in Settings.</div>`}
      ${state.session && state.session.date >= s.start && state.session.date <= s.end
        ? `<div class="small muted" style="margin-top:6px">A shift is running and isn't counted here until you save it.</div>` : ""}
    </div>
    <div class="card stats">
      ${stat("Shift days", T.shift_days)}
      ${stat("Hours", num(T.hours, 1))}
      ${stat("Per hour", money(T.gross_per_hour, 2))}
      ${stat("Paid miles", num(T.paid_miles, 0))}
      ${stat("Driven miles", num(T.driven, 0))}
      ${stat("Per driven mile", money(T.gross_per_driven_mile, 2))}
      ${stat("Fuel", money(T.fuel, 2))}
      ${stat("Wear", money(T.wear, 2))}
      ${stat("Tax set-aside", money(T.tax, 2))}
      ${stat("Kept per hour", money(T.cash_per_hour, 2))}
      ${stat("Tips", tips)}
      ${stat("Per order", money(T.gross_per_order, 2))}
    </div>`;
}

function daysHTML(days, today) {
  const head = `<div class="row head"><span>Day</span><span class="num">Gross</span><span class="num">Kept</span><span class="num">Hrs</span><span class="num">$/hr</span></div>`;
  return head + days.map((d) => {
    const cls = `${d.entries ? "" : "empty"} ${d.date === today ? "today" : ""}`;
    const perHr = d.hours ? d.hours_gross / d.hours : null;
    const extra = d.entries > 1 ? ` <span class="muted small">x${d.entries}</span>` : "";
    return `<div class="row ${cls}">
      <span>${shortDate(d.date)}${extra}</span>
      <span class="num">${d.entries ? money(d.gross, 2) : "-"}</span>
      <span class="num">${d.entries ? money(d.cash, 2) : "-"}</span>
      <span class="num">${d.hours ? num(d.hours, 1) : "-"}</span>
      <span class="num">${money(perHr, 2)}</span>
    </div>`;
  }).join("");
}

function weeksHTML(days, today) {
  const groups = new Map();
  for (const d of days) {
    const key = mondayOf(d.date);
    if (!groups.has(key)) {
      groups.set(key, { start: d.date, end: d.date, gross: 0, shifts: 0, s: 0, t: 0, sTd: 0, tTd: 0 });
    }
    const g = groups.get(key);
    g.end = d.date;
    g.gross += d.gross;
    g.shifts += d.entries ? 1 : 0;
    g.s += d.survive_target;
    g.t += d.thrive_target;
    if (d.date <= today) { g.sTd += d.survive_target; g.tTd += d.thrive_target; }
  }
  const head = `<div class="row head"><span>Week</span><span class="num">Gross</span><span class="num">Base</span><span class="num">Stretch</span><span></span></div>`;
  return head + Array.from(groups.values()).map((g) => {
    const future = g.start > today;
    const st = future ? { cls: "idle", text: "Upcoming" } : status(g.gross, g.sTd, g.tTd);
    const short = { thrive: "Stretch", survive: "Base", behind: "Below", idle: st.text }[st.cls];
    const label = g.start === g.end ? monDay(g.start) : `${monDay(g.start)}-${parseISO(g.end).getDate()}`;
    return `<div class="row ${g.start <= today && today <= g.end ? "today" : ""}">
      <span>${label}<br><span class="muted small">${g.shifts} shift day${g.shifts === 1 ? "" : "s"}</span></span>
      <span class="num">${money(g.gross)}</span>
      <span class="num">${money(g.s)}</span>
      <span class="num">${money(g.t)}</span>
      <span class="chip ${st.cls}">${short}</span>
    </div>`;
  }).join("");
}

function viewError(e) {
  toast(e.network ? "No signal. This screen needs the server." : e.message, true);
}

async function renderWeek() {
  const start = state.weekStart, end = addDays(start, 6), today = todayISO();
  $("#week-label").textContent = start === mondayOf(today) ? `This week, ${rangeLabel(start, end)}` : rangeLabel(start, end);
  try {
    const s = await api(`/api/summary?start=${start}&end=${end}&today=${today}`);
    $("#week-summary").innerHTML = summaryHTML(s);
    $("#week-days").innerHTML = daysHTML(s.days, today);
  } catch (e) { viewError(e); }
}

async function renderMonth() {
  const start = state.monthStart, end = monthEndOf(start), today = todayISO();
  $("#month-label").textContent = monthLabel(start);
  try {
    const s = await api(`/api/summary?start=${start}&end=${end}&today=${today}`);
    $("#month-summary").innerHTML = summaryHTML(s);
    $("#month-weeks").innerHTML = weeksHTML(s.days, today);
  } catch (e) { viewError(e); }
}

/* ---------- history ---------- */
function drivenLabel(e) {
  if (e.miles_source === "gps") return `${num(e.driven, 1)} mi driven (GPS)`;
  if (e.driven_miles != null) return `${num(e.driven, 1)} mi driven (entered)`;
  return `${num(e.driven, 1)} mi driven (est.)`;
}

async function renderHistory() {
  const start = state.histMonth, end = monthEndOf(start);
  $("#hist-label").textContent = monthLabel(start);
  const el = $("#history-list");
  try {
    const { entries } = await api(`/api/entries?start=${start}&end=${end}`);
    state.histEntries = new Map(entries.map((e) => [e.id, e]));
    const perDay = new Map();
    for (const e of entries) perDay.set(e.date, (perDay.get(e.date) || 0) + 1);
    const seen = new Set();
    if (!entries.length) {
      el.innerHTML = `<div class="card empty-note muted">No shifts logged in ${monthLabel(start)}.</div>`;
      return;
    }
    el.innerHTML = entries.map((e) => `
      <div class="card entry">
        <div class="entry-top">
          <div><strong>${shortDate(e.date)}</strong> <span class="muted small">${esc(e.vehicle || "")}${e.from_live ? ", live shift" : ""}</span></div>
          <div class="gross">${money(e.gross, 2)}</div>
        </div>
        <div class="line">Kept <strong class="mono">${money(e.cash, 2)}</strong>, <strong class="mono">${money(e.gross_per_driven_mile, 2)}</strong>/driven mi, ${num(e.paid_miles, 1)} paid mi,
          ${e.hours ? `${num(e.hours, 2)} h at ${money(e.gross_per_hour, 2)}/h` : "no hours"}${e.orders ? `, ${e.orders} orders` : ""}${e.tips != null ? `, ${money(e.tips, 2)} tips` : ""}</div>
        <div class="line muted">${drivenLabel(e)}. Gas $${num(e.gas_price, 2)}, ${num(e.deadhead_pct, 1)}% deadhead, ${num(e.mpg, 2)} mpg, wear $${num(e.maint_per_mile ?? 0, 3)}/mi, IRS $${num(e.irs_rate, 3)}, ${num(e.tax_rate, 1)}% set-aside</div>
        ${e.notes ? `<div class="line">${esc(e.notes)}</div>` : ""}
        <div class="actions">
          <button type="button" data-edit="${e.id}">Edit</button>
          ${perDay.get(e.date) > 1 && !seen.has(e.date) && seen.add(e.date)
            ? `<button type="button" data-combine="${e.date}">Combine shifts</button>` : ""}
          <button type="button" class="danger" data-del="${e.id}">Delete</button>
        </div>
      </div>`).join("");
  } catch (e) { viewError(e); }
}

async function onHistoryClick(ev) {
  const edit = ev.target.closest("[data-edit]");
  const del = ev.target.closest("[data-del]");
  const comb = ev.target.closest("[data-combine]");
  if (comb) {
    const date = comb.dataset.combine;
    const same = [...state.histEntries.values()].filter((e) => e.date === date);
    const gross = same.reduce((a, e) => a + e.gross, 0);
    const hours = same.reduce((a, e) => a + (e.hours || 0), 0);
    if (!confirm(`Combine ${same.length} shifts on ${shortDate(date)} into one?

`
      + `${money(gross, 2)} gross, ${num(hours, 2)} hours. The hours add up, so a break between `
      + `shifts isn't counted. Deliveries and GPS tracks are kept. This can't be undone.`)) return;
    try {
      await api("/api/entries/combine", { method: "POST", body: { ids: same.map((e) => e.id) } });
      toast("Shifts combined");
      renderHistory();
    } catch (e) { viewError(e); }
    return;
  }
  if (edit) {
    const entry = state.histEntries.get(Number(edit.dataset.edit));
    if (entry) startEdit(entry);
  } else if (del) {
    const entry = state.histEntries.get(Number(del.dataset.del));
    if (!entry) return;
    const extra = entry.from_live ? " Its individual deliveries and GPS track are deleted too." : "";
    if (!confirm(`Delete the ${shortDate(entry.date)} shift (${money(entry.gross, 2)})?${extra} This can't be undone.`)) return;
    try {
      await api(`/api/entries/${entry.id}`, { method: "DELETE" });
      toast("Deleted");
      renderHistory();
    } catch (e) { viewError(e); }
  }
}

/* ---------- settings ---------- */
const SETTINGS_NUMBERS = ["gas_price", "deadhead_pct", "irs_rate", "tax_rate", "shifts_per_week",
  "good_per_mile", "min_per_mile"];

const vehicleRow = (v = { name: "", mpg: "", maint_per_mile: "" }) => `
  <div class="vrow">
    <input data-k="name" placeholder="Name" maxlength="40" value="${esc(v.name)}" required>
    <input data-k="mpg" type="number" inputmode="decimal" step="any" min="1" max="200" placeholder="MPG" value="${esc(v.mpg)}" required>
    <input data-k="maint" type="number" inputmode="decimal" step="any" min="0" max="2" placeholder="$/mi" value="${esc(v.maint_per_mile ?? "")}" required>
    <button type="button" class="ghost danger" data-remove aria-label="Remove">✕</button>
  </div>`;

const targetRow = (t = { month: "", survive: "", thrive: "" }) => `
  <div class="trow">
    <input data-k="month" type="month" value="${esc(t.month)}" required>
    <input data-k="survive" type="number" inputmode="decimal" step="any" min="0" value="${esc(t.survive)}" required>
    <input data-k="thrive" type="number" inputmode="decimal" step="any" min="0" value="${esc(t.thrive)}" required>
    <button type="button" class="ghost danger" data-remove aria-label="Remove">✕</button>
  </div>`;

function refreshDefaultVehicle(selected) {
  const sel = $("#settings-form").elements.namedItem("default_vehicle");
  const current = selected ?? sel.value;
  const names = $$("#vehicle-rows [data-k=name]").map((i) => i.value.trim()).filter(Boolean);
  sel.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("");
  if (names.includes(current)) sel.value = current;
}

// Says which deadhead the next shift starts with. Runs as the source or the
// box changes, so picking Calculated previews the figure before saving.
function updateDeadheadNote() {
  const f = $("#settings-form"), note = $("#deadhead-auto");
  if (!f || !note) return;
  const mode = f.elements.namedItem("deadhead_mode").value;
  const box = f.elements.namedItem("deadhead_pct").value;
  const boxText = box === "" ? "the Deadhead % box" : `${num(Number(box), 1)}%`;
  const a = state.deadheadAuto;
  const calc = a && a.pct != null ? num(a.pct, 1) : null;
  if (mode === "fixed") {
    note.textContent = `New shifts use ${boxText}.${calc ? ` Calculated would be ${calc}%.` : ""}`;
  } else if (calc) {
    note.textContent = `Calculated: ${calc}%, the median of your last ${a.shifts} GPS shifts. New shifts use that.`;
  } else {
    note.textContent = `Calculated needs ${a ? a.need : 3} GPS shifts and has ${a ? a.shifts : 0}, so new shifts use ${boxText} for now.`;
  }
}

function renderSettings() {
  const s = state.settings, f = $("#settings-form");
  for (const k of SETTINGS_NUMBERS) f.elements.namedItem(k).value = s[k];
  $("#vehicle-rows").innerHTML = s.vehicles.map(vehicleRow).join("");
  f.elements.namedItem("deadhead_mode").value = s.deadhead_mode || "auto";
  f.elements.namedItem("deadhead_mode").onchange = updateDeadheadNote;
  f.elements.namedItem("deadhead_pct").oninput = updateDeadheadNote;
  updateDeadheadNote();
  refreshDefaultVehicle(s.default_vehicle);
  // A fresh install has no targets; start with an empty row for this month.
  $("#target-rows").innerHTML = state.targets.length
    ? state.targets.map(targetRow).join("")
    : targetRow({ month: new Date().toISOString().slice(0, 7), survive: "", thrive: "" });
  renderAppCard();
}

// Every version's notes, folded away under the recent three.
function allChanges(changes) {
  const n = (changes || []).length;
  return n > 3 ? `<details><summary class="small muted">All changes (${n} versions)</summary>${changeList(changes)}</details>` : "";
}

// Changelog sections newer than versionCode `after`, from /api/app-info.
function changeList(changes, after = 0) {
  return (changes || []).filter((c) => c && c.code > after && Array.isArray(c.items)).map((c) => `
    <p class="small" style="margin:8px 0 2px"><b>${esc(c.version)}</b></p>
    <ul class="small muted" style="margin:0 0 6px;padding-left:18px">${c.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("");
}

// Everything lives in a database on this phone (the app runs its own
// server). These talk to the Android side, which does the file picking.
function backupInfo() {
  try { return JSON.parse(native.backupInfo()); } catch { return {}; }
}

function whenText(ms) {
  if (!ms) return "never";
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function backupHTML() {
  if (!native || !native.backupInfo) return "";
  const b = backupInfo();
  return `
    <div class="k" style="margin-top:10px">Backup</div>
    <p class="small muted">Your shifts, deliveries, GPS tracks and settings are stored only on this phone
      (<span class="mono">${num((b.db_bytes || 0) / 1048576, 1)} MB</span>). Uninstalling the app or losing the phone deletes them unless you have a backup.</p>
    <p class="small muted">Automatic backup folder: <b>${esc(b.folder_name || "not set")}</b>.
      ${b.folder_name ? `A copy is saved there when you leave the app, at most once an hour, one file per day, the last 14 days kept. Last one: ${esc(whenText(b.last_auto_ms))}.` : "Pick a folder on this phone, like Documents. For a copy that survives losing the phone, use Save a backup now and choose Google Drive in the picker."}</p>
    <button type="button" class="ghost" id="bk-folder">${b.folder_name ? "Change folder" : "Choose backup folder"}</button>
    <button type="button" class="ghost" id="bk-now">Save a backup now</button>
    <button type="button" class="ghost" id="bk-restore">Restore from a backup</button>
    ${b.last_manual_ms ? `<p class="small muted">Last saved by hand: ${esc(whenText(b.last_manual_ms))}.</p>` : ""}`;
}

// The Android side calls this when a backup, restore or folder pick finishes.
window.onBackupResult = (message, ok) => {
  toast(message, !ok);
  const box = $("#backup-box");
  if (box) box.innerHTML = backupHTML();
};

// Releases are published at github.com/Hellreaver/delivery-tracker-standalone,
// tagged v1.N where N is the versionCode.
const RELEASES_API = "https://api.github.com/repos/Hellreaver/delivery-tracker-standalone/releases/latest";

async function latestRelease() {
  const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (res.status === 404) return null;   // nothing released yet
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const r = await res.json();
  const m = /^v?\d+\.(\d+)$/.exec(r.tag_name || "");
  const apk = (r.assets || []).find((a) => /\.apk$/i.test(a.name));
  if (!m || !apk) return null;
  return { code: Number(m[1]), name: r.tag_name.replace(/^v/, ""), notes: (r.body || "").trim(),
           url: apk.browser_download_url, size: apk.size };
}

// A quiet heads-up when GitHub has a newer version: one line at the top of
// the Log tab and a dot on the Settings tab. Checked at most every 12 hours,
// never shown while a shift is running, and "Not now" hides the line until
// the next version (the dot stays until it's installed).
const UPDATE_EVERY_MS = 12 * 3600 * 1000;

async function checkForUpdate() {
  if (!native || !native.backupInfo) return;
  let u = lsGet(KEYS.update, {});
  if (!u.checked_at || Date.now() - u.checked_at > UPDATE_EVERY_MS) {
    try {
      const rel = await latestRelease();
      u = { ...u, checked_at: Date.now(), code: rel ? rel.code : 0, name: rel ? rel.name : "" };
      lsSet(KEYS.update, u);
    } catch {
      // no signal: the next launch tries again
    }
  }
  renderUpdateNote();
}

function renderUpdateNote() {
  const u = lsGet(KEYS.update, {});
  const mine = Number((gpsStatus() || {}).version_code) || 0;
  const newer = u.code > mine;
  const tab = $('.tabbar button[data-view="settings"]');
  if (tab) tab.classList.toggle("has-update", newer);
  const el = $("#update-note");
  if (!el) return;
  const visible = newer && !state.session && u.dismissed !== u.code;
  el.hidden = !visible;
  el.innerHTML = visible
    ? `Version ${esc(u.name)} of the app is available.<button type="button" class="linkish" id="update-see">See what's new</button><button type="button" class="linkish" id="update-later">Not now</button>`
    : "";
}

async function renderAppCard() {
  const body = $("#app-card-body");
  if (!body) return;
  if (native) {
    const g = gpsStatus() || {};
    const sw = g.switches || {};
    const switchLine = sw.count
      ? `<p class="small muted">Trips away from the app during shifts: <span class="mono">${sw.count}</span>. Average of those under 10 minutes: <span class="mono">${Math.round(sw.avg_s)} s</span>${sw.long ? ` (${sw.long} longer, left out)` : ""}. <span class="mono">${sw.within_pause_pct}%</span> came back inside the 60 second pause delay.</p>`
      : "";
    body.innerHTML = `
      <p class="small muted">Version ${esc(g.version || "?")}. GPS points waiting to be filed: <span class="mono">${g.pending_upload ?? 0}</span>.</p>
      ${switchLine}
      <div id="app-update"><p class="small muted">Checking GitHub for updates</p></div>
      <div id="backup-box">${backupHTML()}</div>`;
    const mine = Number(g.version_code) || 0;
    const box = $("#app-update");
    try {
      const rel = await latestRelease();
      if (!rel || rel.code <= mine) {
        box.innerHTML = `<p class="small muted">Up to date${rel ? ` (${esc(rel.name)} is the newest)` : ""}.</p>`;
      } else {
        box.innerHTML = `<p class="small">Version ${esc(rel.name)} is out.</p>
          ${rel.notes ? `<div class="small muted" style="white-space:pre-wrap;margin:4px 0 8px">${esc(rel.notes)}</div>` : ""}
          <button type="button" class="primary wide" id="app-download" data-url="${esc(rel.url)}">Download ${esc(rel.name)}${rel.size ? `, ${num(rel.size / 1048576, 1)} MB` : ""}</button>
          <p class="small muted">Opens in Chrome. Install it over this app; your data stays.${state.session
            ? " Installing stops the shift's GPS for a moment. It starts itself again straight after, and opening the app makes sure."
            : ""}</p>`;
      }
    } catch {
      box.innerHTML = `<p class="small muted">Couldn't reach GitHub to check for updates.</p>`;
    }
    return;
  }
  try {
    const info = await api("/api/app-info");
    const recent = info.apk ? changeList((info.changes || []).slice(0, 3)) : "";
    body.innerHTML = info.apk
      ? `<p class="small muted">The app adds GPS mileage and lets you log deliveries with no signal.</p>
         ${recent ? `<details><summary class="small muted">Recent changes</summary>${recent}</details>` : ""}${allChanges(info.changes)}
         <a class="button primary" href="${esc(info.url)}">Download the Android app${info.version_name ? ` ${esc(info.version_name)}` : ""} (${num(info.size / 1048576, 1)} MB)</a>`
      : `<p class="small muted">The Android app hasn't been put on the server yet.</p>`;
  } catch {
    body.innerHTML = `<p class="small muted">Couldn't check for the app.</p>`;
  }
}

function formIsPristine() {
  return !state.editingId && !field("gross").value && !field("paid_miles").value;
}

async function saveSettings(ev) {
  ev.preventDefault();
  const f = $("#settings-form");
  if (!f.reportValidity()) return;
  const body = {
    vehicles: $$("#vehicle-rows .vrow").map((r) => ({
      name: $("[data-k=name]", r).value.trim(),
      mpg: Number($("[data-k=mpg]", r).value),
      maint_per_mile: Number($("[data-k=maint]", r).value),
    })),
    default_vehicle: f.elements.namedItem("default_vehicle").value,
    deadhead_mode: f.elements.namedItem("deadhead_mode").value,
  };
  for (const k of SETTINGS_NUMBERS) body[k] = Number(f.elements.namedItem(k).value);
  try {
    const d = await api("/api/settings", { method: "PUT", body });
    state.settings = d.settings;
    state.targets = d.targets;
    state.deadheadAuto = d.deadhead_auto || null;
    lsSet(KEYS.settings, d);
    renderSettings();
    if (formIsPristine()) resetForm(field("date").value, field("vehicle").value);
    toast("Defaults saved. Past and running shifts keep their own numbers.");
  } catch (e) { viewError(e); }
}

async function saveTargets(ev) {
  ev.preventDefault();
  const f = $("#targets-form");
  if (!f.reportValidity()) return;
  const body = $$("#target-rows .trow").map((r) => ({
    month: $("[data-k=month]", r).value,
    survive: Number($("[data-k=survive]", r).value),
    thrive: Number($("[data-k=thrive]", r).value),
  }));
  try {
    const d = await api("/api/targets", { method: "PUT", body });
    state.targets = d.targets;
    state.deadheadAuto = d.deadhead_auto || null;
    lsSet(KEYS.settings, { settings: state.settings, targets: state.targets });
    renderSettings();
    updatePreview();
    toast("Targets saved");
  } catch (e) { viewError(e); }
}

function exportCSV(kind, start, end) {
  const p = new URLSearchParams({ kind, today: todayISO(), tz: String(new Date().getTimezoneOffset()) });
  if (start) p.set("start", start);
  if (end) p.set("end", end);
  openUrl(`/api/export.csv?${p}`);
}

/* ---------- navigation ---------- */
function show(view) {
  renderUpdateNote();
  state.view = view;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "log") { refreshToday(); updateLiveNumbers(); }
  else if (view === "week") renderWeek();
  else if (view === "month") renderMonth();
  else if (view === "history") renderHistory();
  else if (view === "settings") renderSettings();
}

function stepPeriod(view, step) {
  if (view === "week") { state.weekStart = addDays(state.weekStart, 7 * step); renderWeek(); }
  if (view === "month") { state.monthStart = addMonths(state.monthStart, step); renderMonth(); }
  if (view === "history") { state.histMonth = addMonths(state.histMonth, step); renderHistory(); }
}

function resetPeriod(view) {
  const t = todayISO();
  if (view === "week") { state.weekStart = mondayOf(t); renderWeek(); }
  if (view === "month") { state.monthStart = monthStartOf(t); renderMonth(); }
  if (view === "history") { state.histMonth = monthStartOf(t); renderHistory(); }
}

async function onResume() {
  if (!state.settings) return;
  const t = todayISO();
  $("#topdate").textContent = shortDate(t);
  if (formIsPristine() && field("date").value !== t) field("date").value = t;
  await refreshSession();
  // Settings carry the calculated deadhead and its GPS shift count. Without
  // this they stay as they were when the app opened, so the numbers only moved
  // after force-closing it.
  try { await loadSettings(); } catch { /* offline: keep the copy we have */ }
  reconcileGps();
  show(state.view);
}

function bind() {
  $$(".tabbar button").forEach((b) => b.addEventListener("click", () => {
    if (state.editingId && b.dataset.view !== "log") { exitEdit(); resetForm(); }
    show(b.dataset.view);
  }));

  const f = $("#entry-form");
  f.addEventListener("input", updatePreview);
  f.addEventListener("submit", onSubmit);
  field("vehicle").addEventListener("change", () => {
    const m = vehicleMpg(field("vehicle").value);
    if (m !== "") field("mpg").value = m;
    field("maint_per_mile").value = vehicleMaint(field("vehicle").value);
    updatePreview();
  });
  $("#cancel-edit").addEventListener("click", () => {
    const back = state.returnTo;
    exitEdit();
    resetForm();
    $("#manual").open = false;
    show(back && back !== "log" ? back : "history");
  });

  bindLive();

  for (const view of ["week", "month", "history"]) {
    $(`#view-${view}`).addEventListener("click", (ev) => {
      const step = ev.target.closest("[data-step]");
      if (step) return stepPeriod(view, Number(step.dataset.step));
      if (ev.target.closest("[data-reset]")) return resetPeriod(view);
    });
  }
  $("#history-list").addEventListener("click", onHistoryClick);

  $$("[data-export]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.export === "week") exportCSV("daily", state.weekStart, addDays(state.weekStart, 6));
    else exportCSV("daily", state.monthStart, monthEndOf(state.monthStart));
  }));
  $("#export-btn").addEventListener("click", () => {
    exportCSV($("#export-kind").value, $("#export-start").value, $("#export-end").value);
  });

  $("#settings-form").addEventListener("submit", saveSettings);
  $("#add-vehicle").addEventListener("click", () => {
    $("#vehicle-rows").insertAdjacentHTML("beforeend", vehicleRow());
  });
  $("#vehicle-rows").addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-remove]")) return;
    if ($$("#vehicle-rows .vrow").length <= 1) return toast("Keep at least one vehicle", true);
    ev.target.closest(".vrow").remove();
    refreshDefaultVehicle();
  });
  $("#vehicle-rows").addEventListener("input", () => refreshDefaultVehicle());

  $("#targets-form").addEventListener("submit", saveTargets);
  $("#add-target").addEventListener("click", () => {
    const months = $$("#target-rows [data-k=month]").map((i) => i.value).filter(Boolean).sort();
    const next = months.length ? addMonths(months[months.length - 1] + "-01", 1).slice(0, 7) : todayISO().slice(0, 7);
    $("#target-rows").insertAdjacentHTML("beforeend", targetRow({ month: next, survive: "", thrive: "" }));
  });
  $("#target-rows").addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-remove]")) return;
    if ($$("#target-rows .trow").length <= 1) return toast("Keep at least one target month", true);
    ev.target.closest(".trow").remove();
  });

  $("#update-note").addEventListener("click", (ev) => {
    if (ev.target.closest("#update-see")) {
      show("settings");
      $("#app-card").scrollIntoView({ block: "start" });
    } else if (ev.target.closest("#update-later")) {
      const u = lsGet(KEYS.update, {});
      lsSet(KEYS.update, { ...u, dismissed: u.code });
      renderUpdateNote();
    }
  });

  $("#app-card").addEventListener("click", (ev) => {
    if (!native || !native.backupInfo) return;
    const dl = ev.target.closest("#app-download");
    if (dl) return native.openExternal(dl.dataset.url);
    if (ev.target.closest("#bk-folder")) return native.chooseBackupFolder();
    if (ev.target.closest("#bk-now")) return native.backupNow();
    if (ev.target.closest("#bk-restore")) {
      if (state.session) return toast("Finish or discard the running shift before restoring", true);
      if (!confirm("Restore replaces everything in the app with the backup you pick. Anything logged since that backup is lost. Continue?")) return;
      return native.restoreBackup();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onResume();
  });
}

async function init() {
  bind();
  const t = todayISO();
  state.weekStart = mondayOf(t);
  state.monthStart = monthStartOf(t);
  state.histMonth = monthStartOf(t);
  $("#topdate").textContent = shortDate(t);
  state.outbox = lsGet(KEYS.outbox, []);
  const cached = lsGet(KEYS.live, null);

  try {
    await loadSettings();
  } catch (e) {
    const c = lsGet(KEYS.settings, null);
    if (!c) {
      $("#today-card").innerHTML = `<span class="muted">${esc(e.message)}. Open the app once with signal to set it up.</span>`;
      return;
    }
    state.settings = c.settings;
    state.targets = c.targets;
    state.deadheadAuto = c.deadhead_auto || null;
    state.online = false;
  }

  // With changes waiting (or no signal), the phone's copy is the truth until
  // they sync. Otherwise the server's copy wins.
  let loaded = false;
  if (!state.outbox.length && state.online) {
    try {
      const d = await api("/api/session");
      state.session = d.session;
      state.deliveries = d.deliveries;
      state.sessionJSON = JSON.stringify({ session: d.session, deliveries: d.deliveries });
      saveLive();
      loaded = true;
    } catch (e) {
      if (e.network) state.online = false;
    }
  }
  if (!loaded && cached) {
    state.session = cached.session;
    state.deliveries = cached.deliveries || [];
  }

  resetForm(t);
  renderLive();
  show("log");
  updateNet();
  reconcileGps();
  flush();
  if (native && native.flushTrack) native.flushTrack();
  checkForUpdate();
}

init();
