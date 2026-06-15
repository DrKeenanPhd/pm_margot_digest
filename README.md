# Effortless AI — Property Manager's Instant Response (Daily Call Digest)

A mobile-friendly page that lists **today's calls** for the property-manager Voice AI
agent (Margot), sorted newest-first, filterable by priority, with tap-to-call, recording,
and transcript. Designed to be linked from the daily digest SMS. (Repo: `pm_margot_digest`.)

It is a tiny Node/Express service: it holds your GHL **Private Integration Token (PIT)**
server-side (never in the page), calls GHL's Voice AI Call Log API, and serves the page.

---

## 1. Create the GHL token

In the **sub-account** (location): **Settings → Private Integrations → Create New Integration**.
Select the **Voice AI** scopes (and Conversation AI / View Location as needed). Copy the token
(`pit-...`). Note: PITs are static and do not auto-refresh — if you rotate it, update Railway.

You also need the **Location ID** of that sub-account (Settings → Business Profile, or the
location id in the URL).

## 2. Push to GitHub

```
git init && git add . && git commit -m "call digest"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

The `.gitignore` keeps `node_modules` and any `.env` out of the repo. **Never commit the token.**

## 3. Deploy on Railway

- New Project → Deploy from GitHub repo → pick this repo.
- Railway auto-detects Node and runs `npm start`.
- Add **Variables** (from `.env.example`):
  - `GHL_PIT` = your token
  - `GHL_LOCATION_ID` = the sub-account id
  - `DIGEST_TZ` = `America/Los_Angeles` (US Pacific — the sub-account timezone)
- Railway gives you a public URL, e.g. `https://your-app.up.railway.app`.

## 4. CONFIRM THE FIELD MAPPING (important — do this once)

The endpoint and auth are confirmed from GHL's docs, but the exact **query-param names**
and **response field names** were not extractable from the docs, so they are marked
"verify" in `server.js`. Don't trust the guesses — read the real data:

1. Open `https://your-app.up.railway.app/api/debug`
   (returns a small raw sample from GHL, with your location id redacted).
2. Send me that JSON. I'll lock down the param names and the `mapCall()` field paths
   to match exactly, then we re-verify `/api/today`.

This is the one step that turns the scaffold into a correct, production build.

## 5. Wire it into the digest SMS

Link to the root URL (`https://your-app.up.railway.app/`). The page always shows the
current day in `DIGEST_TZ`, so one static link works every day.

---

## Endpoints

- `/` — the mobile page
- `/api/today` — today's calls, mapped + sorted newest-first
- `/api/debug` — raw GHL sample (for the mapping step above)
- `/api/call/:id` — single call detail / transcript
- `/healthz` — health check

## Notes / open items

- Multi-tenant resale: the same service can serve multiple sub-accounts later by scoping
  per location; v1 is single-location for correctness first.
- "Recording" links to GHL's native recording URL from the API; the `aialive.app` links in
  the marketing mockups are not needed unless you want your own short-link layer.
- Transcript retrieval uses the per-call detail endpoint; field path confirmed in step 4.
