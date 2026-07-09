# Current Context

> **Living snapshot of the _current_ state only.** Overwrite these sections in place each
> session — do **not** prepend. Full history lives in `SESSION_INDEX.md` (one row per session)
> and `logs/` (detailed per-session entries). Keep this file lean (≤ ~150 lines). For stable
> rules see `/CLAUDE.md`.

## What the project does
The **Alberta Historical Wildfire Explorer** — a zero-dependency Node.js web app that serves a
vanilla-JS Leaflet frontend from `public/`. `server.js` downloads and merges four Government of
Alberta wildfire CSVs (1961–2025, ~67,500 fires) into a slim GeoJSON cached under `data/`, and
exposes `/api/wildfire.geojson` plus a same-origin proxy. The frontend (`public/app.js`) renders
fires as cause-coloured flame glyphs with a season timeline, a 2026 fire-risk forecast (⚠ hotspot
zones with % + reason), and a drone-patrol simulation with a command center. Runs with
`node server.js` → http://localhost:5173.

## Current branch
`None (not a git repository)`

## Current active task
**Just set up the `Claude_Logs/` memory system (this session).** No feature work in progress.

## Recent work (newest first — full history in `SESSION_INDEX.md` + `logs/`)
- **2026-07-08** — Bootstrapped the Claude_Logs memory system. `logs/2026-07-08_initial-claude-logging-setup.md`.
- _Pre-dating this log system (not individually logged here, but visible in the code/files):_
  flame-glyph fire markers with a burn→ember season animation; the 2026 fire-risk forecast
  (⚠ zones, risk-index % + auto reason); a drone-patrol simulation with live command-center feed;
  and English subtitles added to `Every_Angle_of_Mitch_Marner.mp4` (`.srt` + `.subtitled.mp4`).
- Older → see `SESSION_INDEX.md`.

## Open issues / things to watch
- No automated test suite — verification is manual (run the app and check behaviour).
- Minor UI: with "Show historical fires" on, the ⚠ zone **% badges** overlay the flames and look
  busy in the dense Calgary corridor; toggle historical off for the clean operational view.
- The drone patrol and its fire "detections" are a **simulation** over historical data, not a
  live sensor feed.

## Standing notes (operational facts, not open bugs)
- **Test/build runner:** No test suite and no build step. Run the app: `node server.js`
  (developed on Node 24) → http://localhost:5173. Override the port with `PORT=8080 node server.js`.
- **Not under version control:** the folder is not a git repo — there is no branch or history yet.
- **Zero npm dependencies:** the server uses only Node built-ins; the frontend loads Leaflet /
  esri-leaflet from CDN (needs internet on first run).
- **Data cache:** `data/wildfire.geojson` is generated/cached from the four CSVs — delete it to
  force a rebuild (sources are wired in `WILDFIRE_SOURCES` in `server.js`).

## Next recommended step
1. Review and keep the new, uncommitted `Claude_Logs/` files and the `CLAUDE.md` diff.
2. Optional but recommended: `git init` — the project isn't under version control, so there is no
   history or backup yet.

## Last updated
2026-07-08
