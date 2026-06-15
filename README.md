# Effortless AI — Property Manager's Instant Response (Daily Call Digest)

Mobile-friendly page listing **today's calls** for the property-manager Voice AI
agent (Margot). Property-keyed entries, priority (P1–P4) or status (S1–S4) badges,
tap-to-open distilled notification + transcript, inline recording, tap-to-call, and
"mark handled" that drops an entry from the active board. (Repo: `pm_margot_digest`.)

## Deploy (GitHub → Railway)

1. Push these files to the repo root (so `package.json` and `public/` are at top level).
2. Railway → Deploy from GitHub repo → `pm_margot_digest`. It runs `npm start`.
3. Add Variables (from `.env.example`):
   - `GHL_PIT` — Private Integration Token from Margot's sub-account
   - `GHL_LOCATION_ID` — Margot's location id
   - `DIGEST_TZ` — `America/Los_Angeles`
   - `AGENT_ID` — `6a0e385e321d30067d28477a` (scopes the digest to Margot only)
   - `DATA_DIR` — `/data` if you mount a Volume (see "Mark handled" below)
   - Do NOT set `PORT` (Railway injects it).
4. Settings → Networking → Generate Domain. Link that URL in the daily digest SMS.

## How data flows (verified from /api/debug)

- Source: `GET /voice-ai/dashboard/call-logs` (newest 100, filtered in code to
  today-in-`DIGEST_TZ` and `agentId === AGENT_ID`).
- Fields read from each call's `extractedData` (case-normalized): `address`,
  `priorityLevel`, `priorityReason`, `status_level`, `callType`, `CallerState`,
  `incidentSummary`, `CallOutcome`, `jobName`, `callerSelfIdentifiedAs`,
  `photoRequested`, plus top-level `summary` and `transcript`.
- Recording: streamed via `/api/recording/:messageId` →
  `GET /conversations/messages/{messageId}/locations/{locationId}/recording`.
  Token stays server-side.

## Badges

- Client calls carry **priority** P1–P4 (red / orange / yellow / green).
- Internal/worker calls carry **status** S1–S4 (red / purple / blue / green).
- A card shows whichever field is populated; "Unclassified" when neither.

## Mark handled

"Mark handled" POSTs to `/api/resolve` and stores the call id in
`DATA_DIR/resolved.json`. Handled calls drop from the board (and would drop from a
daily report); "Show handled" reveals them. **For persistence across redeploys,
mount a Railway Volume and point `DATA_DIR` at it (e.g. `/data`)** — otherwise the
list resets on each deploy. (This is page-side resolve; syncing to GHL's
"Reply DONE" flow is a later upgrade.)

## Endpoints

- `/` page · `/api/today` · `/api/debug` (raw sample) ·
  `/api/recording/:messageId` · `POST /api/resolve` · `/healthz`

## Open items to verify with live data

- **Status key:** no worker/status call was in the debug sample, so the exact
  `extractedData` key for status is matched flexibly (`statusLevel` / `status_level`).
  Confirm the S badge appears on the first real status call.
- **Recording:** endpoint is confirmed in docs; verify audio actually returns on the
  first tap (recording must be enabled on the number).
- **S4 color:** green is a chosen default (your action defined colors only for S1–S3).
