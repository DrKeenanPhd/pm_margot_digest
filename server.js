/* VERSION: v1.6.0  (2026-06-15)
   CHANGELOG:
   - v1.6.0  Single stamp: priority_level holds P1-P5 or SU (status). Reads property_address for
   #          headline/grouping (falls back to contact address). Maps reporter_source/status_summary.
   - v1.5.1  CSV "Record Link" column (deep-links to the call's detail on /records).
   - v1.5.0  Records & Evidence: /records + /api/records (date range, address/text search,
   #          priority/handled filters), /api/records.csv, optional RECORDS_PASSWORD gate.
   - v1.4.0  CSV export endpoint (/api/export.csv) with handled + handled-at, ?scope or ?days.
   - v1.3.0  Scoped views: /api/calls?scope=today|yesterday|week|pending (multi-day paging).
   - v1.1.0  Add/remove "Handled" tag on contact when marking handled; pass contactId.
   - v1.0.0  Agent-filtered today's calls, P/S mapping, recording proxy, page-side resolve.
*/
/* ------------------------------------------------------------------
   Effortless AI — Property Manager's Instant Response
   Daily Call Digest backend (Margot)

   Env (set in Railway → Variables):
     GHL_PIT          Private Integration Token (pit-...)
     GHL_LOCATION_ID  sub-account location id
     DIGEST_TZ        IANA tz, e.g. America/Los_Angeles
     AGENT_ID         Margot's Voice AI agent id (scopes the digest)
     DATA_DIR         where resolved-state is stored (mount a Railway
                      Volume here for persistence; default ./data)
   ------------------------------------------------------------------ */

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GHL_BASE = "https://services.leadconnectorhq.com";
const PIT = process.env.GHL_PIT;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const TZ = process.env.DIGEST_TZ || "America/Los_Angeles";
const AGENT_ID = process.env.AGENT_ID || "6a0e385e321d30067d28477a"; // Margot
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RECORDS_PASSWORD = process.env.RECORDS_PASSWORD || ""; // empty = Records page open; set to lock

function ghlHeaders() {
  return { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", Accept: "application/json" };
}

// ---- resolved-state store (page-side "mark handled") --------------
const STORE = path.join(DATA_DIR, "resolved.json");
function ensureStore() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  if (!fs.existsSync(STORE)) { try { fs.writeFileSync(STORE, "{}"); } catch {} }
}
function readResolved() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}
function writeResolved(obj) {
  try { fs.writeFileSync(STORE, JSON.stringify(obj)); return true; } catch { return false; }
}
ensureStore();

// ---- field mapping (verified from /api/debug) ---------------------
// extractedData keys are inconsistently cased (priorityLevel vs CallerState
// vs status_level). Normalize to alphanumeric-lowercase so camel/snake/pascal
// all match the same candidate.
function indexExtracted(ed = {}) {
  const idx = {};
  for (const k of Object.keys(ed)) idx[k.replace(/[^a-z0-9]/gi, "").toLowerCase()] = ed[k];
  return idx;
}
function pick(idx, ...cands) {
  for (const c of cands) {
    const v = idx[c.replace(/[^a-z0-9]/gi, "").toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function abbrevAddress(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Title-case ALL CAPS input
  s = s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const repl = [
    [/\bStreet\b/gi, "St"], [/\bAvenue\b/gi, "Ave"], [/\bBoulevard\b/gi, "Blvd"],
    [/\bDrive\b/gi, "Dr"], [/\bRoad\b/gi, "Rd"], [/\bLane\b/gi, "Ln"],
    [/\bCourt\b/gi, "Ct"], [/\bPlace\b/gi, "Pl"], [/\bUnit\b/gi, "#"], [/\bApartment\b/gi, "Apt"],
  ];
  for (const [re, to] of repl) s = s.replace(re, to);
  s = s.replace(/#\s+/g, "#");                              // "# 4b" -> "#4b"
  s = s.replace(/(\d)([a-z])\b/g, (_m, d, l) => d + l.toUpperCase()); // 4b -> 4B
  return s.replace(/\s+/g, " ").trim();
}

function mapCall(c, resolved) {
  const ed = c.extractedData || {};
  const idx = indexExtracted(ed);
  const stamp = pick(idx, "priorityLevel", "priority_level");      // P1–P5 (client) or SU (status)
  const legacyStatus = pick(idx, "statusLevel", "status_level");   // S1–S4 from older calls
  const isSU = !!stamp && stamp.toString().trim().toUpperCase().startsWith("SU");
  const priority = isSU ? null : stamp;
  const status = isSU ? "SU" : legacyStatus;
  const propAddr = pick(idx, "propertyAddress", "property_address");
  const name =
    pick(idx, "name") ||
    [pick(idx, "firstName", "callerFirstName"), pick(idx, "lastName", "callerLastName")].filter(Boolean).join(" ") ||
    null;
  return {
    id: c.id,
    contactId: c.contactId || null,
    messageId: c.messageId || null,
    time: c.createdAt || null,
    duration: c.duration || 0,
    property: propAddr ? propAddr.trim() : abbrevAddress(pick(idx, "address")),
    city: pick(idx, "City"),
    state: pick(idx, "State"),
    name: name || "Unidentified caller",
    phone: c.fromNumber || pick(idx, "phoneNumber", "phone") || null,
    priority,
    priorityReason: pick(idx, "priorityReason"),
    status,
    callType: pick(idx, "callType", "call_type"),          // client | internal
    callerType: pick(idx, "CallerType"),                   // tenant | applicant | other
    callerState: pick(idx, "CallerState"),                 // Calm | Urgent | Distressed | Agro
    identifiedAs: pick(idx, "callerSelfIdentifiedAs", "customerSelfIdentifiedAs"),
    jobName: pick(idx, "jobName"),
    reporterSource: pick(idx, "reporterSource", "reporter_source"),
    statusSummary: pick(idx, "statusSummary", "status_summary"),
    outcome: pick(idx, "CallOutcome", "callOutcome"),
    incident: pick(idx, "incidentSummary"),
    photoRequested: pick(idx, "photoRequested"),
    summary: c.summary || null,
    transcript: c.transcript || null,
    day: c.createdAt ? ymd(new Date(c.createdAt), TZ) : null,
    hasRecording: Boolean(c.messageId),
    resolved: Boolean(resolved && resolved[c.id]),
    resolvedAt: resolved && resolved[c.id] ? resolved[c.id].at : null,
  };
}

// ---- date helpers -------------------------------------------------
function ymd(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// date helpers
function ymdAddDays(ymdStr, n) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const PENDING_DAYS = parseInt(process.env.PENDING_DAYS || "30", 10);

// scope → { earliest ymd to include, how to filter, sort direction }
function scopeWindow(scope, today) {
  switch (scope) {
    case "yesterday": { const y = ymdAddDays(today, -1); return { from: y, keep: (d) => d === y, asc: false }; }
    case "week":      { const f = ymdAddDays(today, -6); return { from: f, keep: (d) => d >= f && d <= today, asc: false }; }
    case "pending":   { const f = ymdAddDays(today, -(PENDING_DAYS - 1)); return { from: f, keep: (d) => d >= f && d <= today, asc: true, unresolvedOnly: true }; }
    case "today":
    default:          return { from: today, keep: (d) => d === today, asc: false };
  }
}

async function fetchCalls(scope, res, daysOverride) {
  const today = ymd(new Date(), TZ);
  let win = scopeWindow(scope, today);
  if (daysOverride && daysOverride > 0) {
    const from = ymdAddDays(today, -(daysOverride - 1));
    win = { from, keep: (d) => d >= from && d <= today, asc: false };
  }
  const PAGE_SIZE = 50;        // endpoint hard max
  const MAX_PAGES = 12;        // safety cap (≤600 most-recent calls)
  let raw = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(GHL_BASE + "/voice-ai/dashboard/call-logs");
    url.searchParams.set("locationId", LOCATION_ID);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const r = await fetch(url, { headers: ghlHeaders() });
    if (!r.ok) { res.status(r.status).json({ error: "GHL request failed", status: r.status, detail: await r.text() }); return null; }
    const data = await r.json();
    const logs = data.callLogs || [];
    raw.push(...logs);
    const oldest = logs[logs.length - 1];               // newest-first → last is oldest
    if (logs.length < PAGE_SIZE) break;
    if (oldest && oldest.createdAt && ymd(new Date(oldest.createdAt), TZ) < win.from) break;
  }
  const resolved = readResolved();
  let calls = raw
    .filter((c) => c.agentId === AGENT_ID)
    .filter((c) => c.createdAt && win.keep(ymd(new Date(c.createdAt), TZ)))
    .map((c) => mapCall(c, resolved));
  if (win.unresolvedOnly) calls = calls.filter((c) => !c.resolved);
  calls.sort((a, b) => (win.asc ? 1 : -1) * (new Date(a.time || 0) - new Date(b.time || 0)));
  return { scope, date: today, tz: TZ, count: calls.length, calls };
}

// ---- routes -------------------------------------------------------
app.get("/healthz", (_q, r) => r.json({ ok: true, tz: TZ, agent: AGENT_ID }));

app.get("/api/debug", async (_q, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID." });
  try {
    const url = new URL(GHL_BASE + "/voice-ai/dashboard/call-logs");
    url.searchParams.set("locationId", LOCATION_ID);
    url.searchParams.set("pageSize", "5");
    const r = await fetch(url, { headers: ghlHeaders() });
    const t = await r.text();
    let body; try { body = JSON.parse(t); } catch { body = t; }
    res.status(r.status).json({ status: r.status, body });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Scoped calls: ?scope=today|yesterday|week|pending  (default today)
app.get("/api/calls", async (req, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID." });
  try {
    const scope = ["today", "yesterday", "week", "pending"].includes(req.query.scope) ? req.query.scope : "today";
    const out = await fetchCalls(scope, res);
    if (out) res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Back-compat alias
app.get("/api/today", async (_q, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID." });
  try { const out = await fetchCalls("today", res); if (out) res.json(out); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// CSV helpers
function fmtTZParts(iso) {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso); if (isNaN(d)) return { date: "", time: "" };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return { date, time };
}
function csv(v) { if (v === null || v === undefined) return '""'; return '"' + String(v).replace(/"/g, '""') + '"'; }
function callsToCsv(calls, base) {
  const cols = ["Date","Time","Property","City","State","Caller","Phone","Call Type","Priority","Status","Urgency","Reason","Caller State","Incident","Outcome","Photo Requested","Handled","Handled At","Recording","Record Link","Call ID"];
  const lines = [cols.map(csv).join(",")];
  for (const c of calls) {
    const t = fmtTZParts(c.time);
    const pk = (c.priority || "").toString().toUpperCase().slice(0, 2);
    const sk = (c.status || "").toString().toUpperCase().slice(0, 2);
    const urgency = c.priority ? ({P1:"CRITICAL",P2:"URGENT",P3:"HIGH PRIORITY",P4:"STANDARD"}[pk] || "")
      : c.status ? ({S1:"URGENT",S2:"NEEDS ATTENTION",S3:"WORKING / ON-SITE",S4:"COMPLETE"}[sk] || "") : "";
    const ha = c.resolvedAt ? (() => { const p = fmtTZParts(c.resolvedAt); return p.date + " " + p.time; })() : "";
    lines.push([
      t.date, t.time, c.property, c.city, c.state, c.name, c.phone,
      c.callType, c.priority, c.status, urgency, c.priorityReason, c.callerState,
      c.incident, c.outcome, c.photoRequested, c.resolved ? "Yes" : "No", ha,
      c.hasRecording ? `${base}/api/recording/${c.messageId}` : "",
      `${base}/records?id=${encodeURIComponent(c.id)}&date=${t.date}`,
      c.id,
    ].map(csv).join(","));
  }
  return "\uFEFF" + lines.join("\r\n"); // BOM so Excel reads UTF-8 (accents) correctly
}
function reqBase(req) { return (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host"); }

// CSV export (accountability log). ?scope=today|yesterday|week|pending  OR  ?days=30
app.get("/api/export.csv", async (req, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID." });
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : 0;
    const scope = ["today", "yesterday", "week", "pending"].includes(req.query.scope) ? req.query.scope : "week";
    const out = await fetchCalls(scope, res, days);
    if (!out) return;
    const tag = days ? `${days}d` : scope;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="margot-call-log-${tag}-${out.date}.csv"`);
    res.send(callsToCsv(out.calls, reqBase(req)));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ===== RECORDS (evidence) =========================================
// Optional gate: if RECORDS_PASSWORD is set, require HTTP Basic auth.
function recordsAuth(req, res, next) {
  if (!RECORDS_PASSWORD) return next(); // open until a password is configured
  const h = req.headers.authorization || "";
  const [scheme, val] = h.split(" ");
  if (scheme === "Basic" && val) {
    const dec = Buffer.from(val, "base64").toString();
    const pass = dec.slice(dec.indexOf(":") + 1);
    if (pass === RECORDS_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Margot Records"');
  return res.status(401).send("Authentication required.");
}

// Filtered query across a date range (from/to in TZ), with text/priority/handled filters.
async function queryCalls({ from, to, q, priority, handled }, res) {
  const today = ymd(new Date(), TZ);
  to = to || today;
  from = from || ymdAddDays(to, -29);
  const PAGE_SIZE = 50, MAX_PAGES = 20; // ≤1000 most-recent calls (live-API limit; durable store removes this)
  let raw = [], truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(GHL_BASE + "/voice-ai/dashboard/call-logs");
    url.searchParams.set("locationId", LOCATION_ID);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const r = await fetch(url, { headers: ghlHeaders() });
    if (!r.ok) { res.status(r.status).json({ error: "GHL request failed", status: r.status, detail: await r.text() }); return null; }
    const data = await r.json();
    const logs = data.callLogs || [];
    raw.push(...logs);
    const oldest = logs[logs.length - 1];
    if (logs.length < PAGE_SIZE) break;
    if (oldest && oldest.createdAt && ymd(new Date(oldest.createdAt), TZ) < from) break;
    if (page === MAX_PAGES) truncated = true;
  }
  const resolved = readResolved();
  let calls = raw
    .filter((c) => c.agentId === AGENT_ID)
    .filter((c) => { const d = c.createdAt ? ymd(new Date(c.createdAt), TZ) : null; return d && d >= from && d <= to; })
    .map((c) => mapCall(c, resolved));
  if (q) {
    const needle = q.toLowerCase();
    calls = calls.filter((c) => [c.property, c.city, c.name, c.incident, c.outcome, c.phone]
      .filter(Boolean).join(" ").toLowerCase().includes(needle));
  }
  if (priority && priority !== "all") {
    const k = priority.toUpperCase();
    calls = calls.filter((c) => (c.priority || "").toUpperCase() === k || (c.status || "").toUpperCase() === k);
  }
  if (handled === "handled") calls = calls.filter((c) => c.resolved);
  else if (handled === "unhandled") calls = calls.filter((c) => !c.resolved);
  calls.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  return { from, to, tz: TZ, count: calls.length, truncated, calls };
}

app.get("/api/records", recordsAuth, async (req, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID." });
  try {
    const out = await queryCalls({
      from: req.query.from, to: req.query.to, q: req.query.q,
      priority: req.query.priority, handled: req.query.handled,
    }, res);
    if (out) res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/records.csv", recordsAuth, async (req, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID." });
  try {
    const out = await queryCalls({
      from: req.query.from, to: req.query.to, q: req.query.q,
      priority: req.query.priority, handled: req.query.handled,
    }, res);
    if (!out) return;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="margot-records-${out.from}_to_${out.to}.csv"`);
    res.send(callsToCsv(out.calls, reqBase(req)));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/records", recordsAuth, (_q, res) => res.sendFile(path.join(__dirname, "records.html")));
// ==================================================================

// Stream the call recording (token stays server-side)
app.get("/api/recording/:messageId", async (req, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing env." });
  try {
    const url = `${GHL_BASE}/conversations/messages/${encodeURIComponent(req.params.messageId)}/locations/${encodeURIComponent(LOCATION_ID)}/recording`;
    const r = await fetch(url, { headers: ghlHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: "No recording", status: r.status });
    res.set("Content-Type", r.headers.get("content-type") || "audio/x-wav");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Add/remove the "Handled" tag on the contact (best-effort: never blocks resolve)
const HANDLED_TAG = process.env.HANDLED_TAG || "Handled";
async function setHandledTag(contactId, add) {
  if (!contactId) return { tagged: false, reason: "no contactId" };
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
      method: add ? "POST" : "DELETE",
      headers: { ...ghlHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [HANDLED_TAG] }),
    });
    return { tagged: r.ok, status: r.status };
  } catch (e) {
    return { tagged: false, error: String(e) };
  }
}

// Mark handled / un-handle  (page-side store + "Handled" tag on the contact)
app.post("/api/resolve", async (req, res) => {
  const { id, contactId, resolved = true } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
  const store = readResolved();
  if (resolved) store[id] = { at: new Date().toISOString(), contactId: contactId || null };
  else delete store[id];
  const ok = writeResolved(store);
  const tag = await setHandledTag(contactId, resolved); // add on handle, remove on un-handle
  res.json({ ok, id, resolved, tag });
});

app.get("/", (_q, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Call digest running on :${PORT} (tz ${TZ}, agent ${AGENT_ID})`));
