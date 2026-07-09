/**
 * Alberta Wildfire Map — zero-dependency Node server.
 *
 * Responsibilities:
 *   1. Serve the static frontend from ./public
 *   2. /api/wildfire.geojson  -> downloads the Government of Alberta historical
 *      wildfire CSV(s), caches them on disk, and converts them to a slim GeoJSON
 *      FeatureCollection (one point per fire). Serving it same-origin sidesteps
 *      any CORS restriction on the open-data host and makes repeat loads instant.
 *   3. /api/proxy?url=...      -> generic same-origin proxy for the Alberta ArcGIS
 *      "identify" calls so overlay pop-ups work even if a service omits CORS.
 *
 * No third-party packages are used — only Node's built-in modules.
 */

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const PORT = process.env.PORT || 5173;

// Acres → hectares (the 1961–1982 report form recorded areas in acres).
const ACRES_TO_HA = 0.404685642;

// Numeric size-class code → letter class (older FP48 form used numbers).
const SIZECLASS_NUM = { 0: "A", 1: "A", 2: "B", 3: "C", 4: "D", 5: "E" };

// GENCAUSE numeric code → label, per each dataset's data dictionary.
const CAUSE_1961 = {
  0: "Other Industry", 1: "Lightning", 2: "Resident", 3: "Wood Industry",
  4: "Railroad", 5: "Public Project", 6: "Recreation", 7: "Incendiary",
  8: "Miscellaneous (Known)", 9: "Unknown",
};
const CAUSE_1983 = {
  0: "Other Industry", 1: "Lightning", 2: "Resident", 3: "Forest Industry",
  4: "Railroad", 5: "Unknown", 6: "Recreation", 7: "Incendiary",
  8: "Miscellaneous (Known)", 9: "Unknown",
};

/**
 * Historical wildfire CSV sources published on open.alberta.ca.
 *
 * The 2006–2025 file is the current, fully-documented dataset and is parsed by
 * column auto-detection. The three older vintages have quite different schemas
 * (uppercase headers, 2-digit years, numeric cause codes, areas in acres), so
 * each carries an explicit column map + transforms derived from its published
 * data dictionary.
 */
const WILDFIRE_SOURCES = [
  {
    id: "2006-2025",
    url: "https://open.alberta.ca/dataset/a221e7a0-4f46-4be7-9c5a-e29de9a3447e/resource/80480824-0c50-456c-9723-f9d4fc136141/download/fp-historical-wildfire-data-2006-2025.csv",
    // no columns → auto-detect
  },
  {
    id: "1996-2005",
    url: "https://open.alberta.ca/dataset/301bf91d-6db7-4004-8cc9-40ac7e7b42f7/resource/b064057e-5179-4e23-904d-b4f304d46b14/download/af-historic-wildfires-1996-2005-data.csv",
    columns: {
      lat: "fire_location_latitude", lon: "fire_location_longitude", year: "fire_year",
      size: "current_size", cause: "general_cause_desc", sizeClass: "size_class",
      number: "fire_number", name: "fire_name", start: "fire_start_date", status: "fire_type",
    },
  },
  {
    id: "1983-1995",
    url: "https://open.alberta.ca/dataset/5278c6d3-f024-4e6b-87d9-60e4f1848a0b/resource/cf4b4084-f157-4f84-b2ec-4691fd28849a/download/af-historic-wildfires-1983-1995-data.csv",
    columns: {
      lat: "lat", lon: "long", year: "fire_year",
      size: ["extingsize", "grandarea"], cause: "gencause", sizeClass: "sizeclass",
      number: "firenumber", start: "startdate", status: "firetype",
    },
    transforms: { causeMap: CAUSE_1983 },
  },
  {
    id: "1961-1982",
    url: "https://open.alberta.ca/dataset/905c9b91-a769-4e64-abff-2e6d20c7c83f/resource/4b8c504d-1c95-48df-8fef-9371712ed3e6/download/af-historic-wildfires-1961-1982-data.csv",
    columns: {
      lat: "LAT", lon: "LONG", year: "YEAR",
      size: "TOTAL", cause: "GENCAUSE", sizeClass: "SIZECLAS", number: "FIRENUMBER",
      month: "MON", day: "DAY", // this vintage has no full date, only month/day fields
    },
    transforms: { twoDigitYear: true, sizeToHa: ACRES_TO_HA, causeMap: CAUSE_1961, sizeClassMap: SIZECLASS_NUM },
  },
];

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // refresh weekly

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Small HTTP helper: follow redirects, return a Buffer.
// ---------------------------------------------------------------------------
function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("http://") ? http : https;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "AlbertaWildfireMap/1.0 (+local)",
          Accept: "*/*",
        },
        timeout: 60000,
      },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          const next = new URL(headers.location, url).toString();
          return resolve(fetchBuffer(next, redirects + 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// RFC-4180-ish CSV parser (handles quoted fields, embedded commas & newlines).
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ignore; newline handled by \n
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Pick the first header whose normalized name matches a tester.
function findHeader(headers, testers) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const test of testers) {
    for (let i = 0; i < norm.length; i++) {
      if (test(norm[i])) return i;
    }
  }
  return -1;
}

function toNumber(v) {
  if (v == null) return NaN;
  const n = parseFloat(String(v).replace(/[^0-9eE.+-]/g, ""));
  return n;
}

// Auto-detect column indices from header names (used for the 2006–2025 file).
function autoDetectColumns(headers) {
  return {
    lat: findHeader(headers, [(h) => h.includes("latitude"), (h) => h === "lat" || h.endsWith("_lat")]),
    lon: findHeader(headers, [(h) => h.includes("longitude"), (h) => h === "lon" || h === "long" || h.endsWith("_lon")]),
    year: findHeader(headers, [(h) => h.includes("year")]),
    size: [
      findHeader(headers, [
        (h) => h.includes("current_size"),
        (h) => h.includes("fire_size"),
        (h) => h.includes("size_ha"),
        (h) => h.includes("size") && !h.includes("class"),
      ]),
    ].filter((i) => i >= 0),
    cause: findHeader(headers, [(h) => h.includes("general_cause"), (h) => h.includes("cause") && !h.includes("code")]),
    sizeClass: findHeader(headers, [(h) => h.includes("size_class")]),
    number: findHeader(headers, [(h) => h.includes("fire_number"), (h) => h === "fire_id" || h.includes("wildfire_number")]),
    name: findHeader(headers, [(h) => h.includes("fire_name")]),
    start: findHeader(headers, [
      (h) => h.includes("fire_start_date"),
      (h) => h.includes("start_date"),
      (h) => h.includes("discovered") || h.includes("reported"),
    ]),
    status: findHeader(headers, [(h) => h.includes("fire_type") || h.includes("activity_class")]),
    month: -1,
    day: -1,
  };
}

// Day-of-year (1–366) from a month/day, using a fixed non-leap calendar.
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function computeDoy(month, day) {
  if (!(month >= 1 && month <= 12)) return null;
  const d = day >= 1 && day <= 31 ? day : 15; // fall back to mid-month
  return DAYS_BEFORE_MONTH[month] + d;
}

// ---------------------------------------------------------------------------
// Convert a raw CSV string into GeoJSON features.
//   `source` may be a full source config ({id, columns?, transforms?}) or, for
//   backward compatibility, a plain string id (→ auto-detect, no transforms).
// ---------------------------------------------------------------------------
function csvToFeatures(csvText, source) {
  if (typeof source === "string") source = { id: source };
  const sourceId = source.id;
  const t = source.transforms || {};

  const rows = parseCsv(csvText).filter((r) => r.length > 1);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const lower = headers.map((h) => h.trim().toLowerCase());
  const byName = (name) => (name == null ? -1 : lower.indexOf(String(name).toLowerCase()));

  let idx;
  if (source.columns) {
    const c = source.columns;
    idx = {
      lat: byName(c.lat), lon: byName(c.lon), year: byName(c.year),
      size: (Array.isArray(c.size) ? c.size : [c.size]).map(byName).filter((i) => i >= 0),
      cause: byName(c.cause), sizeClass: byName(c.sizeClass),
      number: byName(c.number), name: byName(c.name), start: byName(c.start), status: byName(c.status),
      month: byName(c.month), day: byName(c.day),
    };
  } else {
    idx = autoDetectColumns(headers);
  }

  if (idx.lat === -1 || idx.lon === -1) {
    throw new Error(
      `Could not locate latitude/longitude columns in source ${sourceId}. Headers: ${headers.join(", ")}`
    );
  }

  const mapCode = (table, raw) => {
    const key = parseInt(toNumber(raw), 10);
    return isFinite(key) && table[key] != null ? table[key] : null;
  };

  const features = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lat = toNumber(row[idx.lat]);
    const lon = toNumber(row[idx.lon]);
    if (!isFinite(lat) || !isFinite(lon) || lat === 0 || lon === 0) continue;
    if (lat < 47 || lat > 61 || lon < -121 || lon > -108) continue; // Alberta bbox sanity

    // Year (with optional 2-digit expansion), falling back to the start date.
    let year = idx.year !== -1 ? parseInt(toNumber(row[idx.year]), 10) : NaN;
    if (t.twoDigitYear && isFinite(year) && year < 100) year += year >= 50 ? 1900 : 2000;
    if ((!isFinite(year) || year < 1900) && idx.start !== -1) {
      const m = String(row[idx.start]).match(/(19|20)\d{2}/);
      if (m) year = parseInt(m[0], 10);
    }
    if (!isFinite(year) || year < 1900) continue;

    // Size: first finite, positive candidate; convert units if configured.
    let size = null;
    for (const i of idx.size) {
      const v = toNumber(row[i]);
      if (isFinite(v) && v > 0) { size = v; break; }
    }
    if (size != null && t.sizeToHa) size *= t.sizeToHa;

    // Cause: decode numeric code table if configured, else use text.
    let cause = "Unknown";
    if (idx.cause !== -1) {
      cause = t.causeMap ? mapCode(t.causeMap, row[idx.cause]) || "Unknown" : (row[idx.cause] || "Unknown").trim() || "Unknown";
    }

    // Day-of-year for the season timeline: prefer a full start date, else the
    // dataset's month/day fields.
    let month = null, day = null;
    if (idx.start !== -1) {
      const m = String(row[idx.start]).match(/\b(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) { month = +m[2]; day = +m[3]; }
    }
    if (month == null && idx.month != null && idx.month !== -1) {
      const mn = parseInt(toNumber(row[idx.month]), 10);
      if (isFinite(mn)) month = mn;
      const dn = idx.day != null && idx.day !== -1 ? parseInt(toNumber(row[idx.day]), 10) : NaN;
      if (isFinite(dn)) day = dn;
    }
    const doy = computeDoy(month, day);

    // Size class: decode numeric code table if configured.
    let sizeClass = null;
    if (idx.sizeClass !== -1) {
      const raw = row[idx.sizeClass];
      sizeClass = t.sizeClassMap ? mapCode(t.sizeClassMap, raw) || null : raw || null;
    }

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        src: sourceId,
        year,
        size: size != null ? Math.round(size * 100) / 100 : null,
        sizeClass,
        doy,
        cause,
        number: idx.number !== -1 ? row[idx.number] || null : null,
        name: idx.name !== -1 ? row[idx.name] || null : null,
        start: idx.start !== -1 ? row[idx.start] || null : null,
        status: idx.status !== -1 ? row[idx.status] || null : null,
      },
    });
  }
  return features;
}

// ---------------------------------------------------------------------------
// Build (and cache) the merged wildfire GeoJSON.
// ---------------------------------------------------------------------------
async function buildWildfireGeoJSON() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const cachePath = path.join(DATA_DIR, "wildfire.geojson");

  // Serve fresh cache if young enough.
  try {
    const stat = await fsp.stat(cachePath);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return await fsp.readFile(cachePath);
    }
  } catch {
    /* no cache yet */
  }

  const allFeatures = [];
  const notes = [];
  for (const source of WILDFIRE_SOURCES) {
    const rawPath = path.join(DATA_DIR, `wildfire-${source.id}.csv`);
    let csvText;
    try {
      // Reuse a cached raw CSV if present & young; else download.
      let useCache = false;
      try {
        const st = await fsp.stat(rawPath);
        if (Date.now() - st.mtimeMs < CACHE_TTL_MS) useCache = true;
      } catch {}
      if (useCache) {
        csvText = await fsp.readFile(rawPath, "utf8");
      } else {
        console.log(`[wildfire] downloading ${source.id} …`);
        const buf = await fetchBuffer(source.url);
        csvText = buf.toString("utf8");
        await fsp.writeFile(rawPath, csvText);
      }
      const feats = csvToFeatures(csvText, source);
      allFeatures.push(...feats);
      notes.push(`${source.id}: ${feats.length} fires`);
      console.log(`[wildfire] ${source.id}: ${feats.length} fires parsed`);
    } catch (err) {
      notes.push(`${source.id}: FAILED (${err.message})`);
      console.warn(`[wildfire] source ${source.id} failed: ${err.message}`);
    }
  }

  const years = [...new Set(allFeatures.map((f) => f.properties.year))].sort((a, b) => a - b);
  const fc = {
    type: "FeatureCollection",
    metadata: {
      generated: new Date().toISOString(),
      count: allFeatures.length,
      years,
      notes,
      attribution: "Government of Alberta — Historical Wildfire Data (open.alberta.ca)",
    },
    features: allFeatures,
  };

  const out = Buffer.from(JSON.stringify(fc));
  await fsp.writeFile(cachePath, out);
  return out;
}

// In-flight de-duplication so concurrent requests trigger one download.
let wildfirePromise = null;
let wildfireGzip = null; // cached gzip of the geojson (built on first gzip request)
function getWildfire() {
  if (!wildfirePromise) {
    wildfirePromise = buildWildfireGeoJSON().catch((e) => {
      wildfirePromise = null; // allow retry on next request
      throw e;
    });
  }
  return wildfirePromise;
}

// ---------------------------------------------------------------------------
// Static file serving.
// ---------------------------------------------------------------------------
async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

// ---------------------------------------------------------------------------
// Request router.
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === "/api/wildfire.geojson") {
    try {
      const data = await getWildfire();
      const headers = { "Content-Type": MIME[".geojson"], "Cache-Control": "no-cache" };
      // Serve gzip when the client accepts it (~16 MB → ~3 MB). Compressed once,
      // then cached for the life of the process.
      if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
        if (!wildfireGzip) wildfireGzip = zlib.gzipSync(data);
        headers["Content-Encoding"] = "gzip";
        res.writeHead(200, headers);
        res.end(wildfireGzip);
      } else {
        res.writeHead(200, headers);
        res.end(data);
      }
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to load wildfire data", detail: err.message }));
    }
    return;
  }

  // Generic proxy limited to the Alberta ArcGIS host (for overlay identify calls).
  if (pathname === "/api/proxy") {
    const target = searchParams.get("url");
    try {
      const u = new URL(target);
      if (!/(^|\.)alberta\.ca$/.test(u.hostname)) {
        res.writeHead(400).end("Only *.alberta.ca targets are allowed");
        return;
      }
      const buf = await fetchBuffer(u.toString());
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      });
      res.end(buf);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  await serveStatic(req, res);
});

// Only start listening when executed directly (`node server.js`), so the pure
// helpers above can be imported by tests without opening a socket.
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, () => {
    console.log(`\n  Alberta Wildfire Map running:  http://localhost:${PORT}\n`);
    // Warm the cache in the background so the first page load is fast.
    getWildfire().catch(() => {});
  });
}

export { parseCsv, csvToFeatures, findHeader, WILDFIRE_SOURCES };
