/* ------------------------------------------------------------------
   GHL Voice AI — Daily Call Digest backend
   Holds the Private Integration Token server-side and serves a
   mobile-friendly "today's calls" page.

   Deploy on Railway. Set these env vars in Railway (NOT in the repo):
     GHL_PIT          = your Private Integration Token (pit-...)
     GHL_LOCATION_ID  = the sub-account (location) id
     DIGEST_TZ        = IANA timezone, e.g. America/Tijuana
     PORT             = (Railway sets this automatically)
   ------------------------------------------------------------------ */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const GHL_BASE = "https://services.leadconnectorhq.com";
const PIT = process.env.GHL_PIT;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const TZ = process.env.DIGEST_TZ || "America/Tijuana";

/* =================================================================
   CONFIG TO VERIFY  ← the only guesses in this file.
   The List Call Logs docs confirm the endpoint and that it supports
   date-range (IANA tz), sorting, and pagination — but the literal
   query-param names and response field names render in an interactive
   explorer we could not extract. Hit /api/debug after deploy, read the
   real JSON, and correct anything in this block + mapCall() below.
   ================================================================= */
const ENDPOINT = "/voice-ai/dashboard/call-logs"; // CONFIRMED from docs
const PARAMS = {
  location: "locationId",   // verify
  startDate: "startDate",   // verify (epoch ms? ISO? exact key?)
  endDate: "endDate",       // verify
  timezone: "timezone",     // verify (timezone vs timeZone)
  sort: "sortOrder",        // verify
  sortDesc: "desc",         // verify (desc/asc vs -1/1)
  page: "page",             // verify
  pageSize: "pageSize",     // verify (pageSize vs limit)
};

function ghlHeaders() {
  return {
    Authorization: `Bearer ${PIT}`,
    Version: "2021-07-28", // confirmed header from PIT docs
    Accept: "application/json",
  };
}

// Start/end of "today" in the configured timezone, as ISO strings.
function todayRange() {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now); // e.g. 2026-06-06
  return { startDate: `${ymd}T00:00:00`, endDate: `${ymd}T23:59:59`, ymd };
}

/* Maps ONE raw GHL call-log object to the shape the page needs.
   Uses optional chaining + several likely keys so it degrades
   gracefully — but CONFIRM these against /api/debug output. */
function mapCall(c = {}) {
  return {
    id: c.id || c.callId || c._id || null,
    time: c.dateAdded || c.startTime || c.createdAt || c.date || null,
    name:
      c.contactName ||
      [c.firstName, c.lastName].filter(Boolean).join(" ") ||
      c.contact?.name ||
      "Unknown caller",
    phone: c.phone || c.from || c.contact?.phone || null,
    priority: c.priority_level || c.priority || c.contact?.priority_level || null,
    summary: c.incident_summary || c.summary || c.callSummary || null,
    recordingUrl: c.recordingUrl || c.recording_url || c.recording || null,
    transcriptUrl: c.transcriptUrl || c.transcript_url || null,
    hasTranscript: Boolean(c.transcript || c.transcriptUrl || c.transcript_url),
    _raw: undefined, // set to c only in debug
  };
}

// ---- Routes -------------------------------------------------------

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true, tz: TZ }));

// RAW passthrough — use this first to learn the real schema.
app.get("/api/debug", async (req, res) => {
  if (!PIT || !LOCATION_ID) {
    return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID env var." });
  }
  try {
    const url = new URL(GHL_BASE + ENDPOINT);
    url.searchParams.set(PARAMS.location, LOCATION_ID);
    url.searchParams.set(PARAMS.pageSize, "5"); // tiny sample
    const r = await fetch(url, { headers: ghlHeaders() });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    res.status(r.status).json({ requestedUrl: url.toString().replace(LOCATION_ID, "<LOCATION_ID>"), status: r.status, body });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Today's calls, mapped + sorted newest-first.
app.get("/api/today", async (_req, res) => {
  if (!PIT || !LOCATION_ID) {
    return res.status(500).json({ error: "Missing GHL_PIT or GHL_LOCATION_ID env var." });
  }
  try {
    const { startDate, endDate, ymd } = todayRange();
    const url = new URL(GHL_BASE + ENDPOINT);
    url.searchParams.set(PARAMS.location, LOCATION_ID);
    url.searchParams.set(PARAMS.startDate, startDate);
    url.searchParams.set(PARAMS.endDate, endDate);
    url.searchParams.set(PARAMS.timezone, TZ);
    url.searchParams.set(PARAMS.sort, PARAMS.sortDesc);
    url.searchParams.set(PARAMS.pageSize, "100");

    const r = await fetch(url, { headers: ghlHeaders() });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: "GHL request failed", status: r.status, detail: t });
    }
    const data = await r.json();
    // Response container key is also unknown — try the common ones.
    const list = data.callLogs || data.calls || data.logs || data.data || data.items || [];
    const calls = list.map(mapCall)
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
    res.json({ date: ymd, tz: TZ, count: calls.length, calls });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Single call detail (transcript). Verify path + fields via /api/debug too.
app.get("/api/call/:id", async (req, res) => {
  if (!PIT || !LOCATION_ID) return res.status(500).json({ error: "Missing env vars." });
  try {
    const url = new URL(`${GHL_BASE}${ENDPOINT}/${encodeURIComponent(req.params.id)}`);
    url.searchParams.set(PARAMS.location, LOCATION_ID);
    const r = await fetch(url, { headers: ghlHeaders() });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Call digest running on :${PORT} (tz ${TZ})`));
