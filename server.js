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
  return s.replace(/\s+/g, " ").trim();
}

function mapCall(c, resolved) {
  const ed = c.extractedData || {};
  const idx = indexExtracted(ed);
  const priority = pick(idx, "priorityLevel", "priority_level");
  const status = pick(idx, "statusLevel", "status_level");
  const name =
    pick(idx, "name") ||
    [pick(idx, "firstName", "callerFirstName"), pick(idx, "lastName", "callerLastName")].filter(Boolean).join(" ") ||
    null;
  return {
    id: c.id,
    messageId: c.messageId || null,
    time: c.createdAt || null,
    duration: c.duration || 0,
    property: abbrevAddress(pick(idx, "address")),
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
    outcome: pick(idx, "CallOutcome", "callOutcome"),
    incident: pick(idx, "incidentSummary"),
    photoRequested: pick(idx, "photoRequested"),
    summary: c.summary || null,
    transcript: c.transcript || null,
    hasRecording: Boolean(c.messageId),
    resolved: Boolean(resolved && resolved[c.id]),
  };
}

// ---- date helpers -------------------------------------------------
function ymd(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
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

app.get("/api/today", async (_q, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID." });
  try {
    const url = new URL(GHL_BASE + "/voice-ai/dashboard/call-logs");
    url.searchParams.set("locationId", LOCATION_ID);
    url.searchParams.set("pageSize", "100"); // newest-first; we filter to today + agent in code
    const r = await fetch(url, { headers: ghlHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: "GHL request failed", status: r.status, detail: await r.text() });
    const data = await r.json();
    const today = ymd(new Date(), TZ);
    const resolved = readResolved();
    const calls = (data.callLogs || [])
      .filter((c) => c.agentId === AGENT_ID)
      .filter((c) => c.createdAt && ymd(new Date(c.createdAt), TZ) === today)
      .map((c) => mapCall(c, resolved))
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
    res.json({ date: today, tz: TZ, count: calls.length, calls });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

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

// Mark handled / un-handle
app.post("/api/resolve", (req, res) => {
  const { id, resolved = true } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
  const store = readResolved();
  if (resolved) store[id] = { at: new Date().toISOString() };
  else delete store[id];
  const ok = writeResolved(store);
  res.json({ ok, id, resolved });
});

app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log(`Call digest running on :${PORT} (tz ${TZ}, agent ${AGENT_ID})`));
