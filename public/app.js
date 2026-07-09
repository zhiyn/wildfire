/* Alberta Historical Wildfire Explorer — frontend logic */
"use strict";

// Alberta Geospatial Services Platform public ArcGIS REST root.
const AGSP = "https://geospatial.alberta.ca/titan/rest/services";

// If Leaflet itself did not load (e.g. offline / CDN blocked), fail loudly and
// clearly instead of throwing an opaque "L is not defined".
if (typeof L === "undefined") {
  document.getElementById("map").innerHTML =
    '<div style="padding:24px;color:#ffd7bf;font:15px system-ui">' +
    "<strong>Map library failed to load.</strong><br>Leaflet is loaded from a CDN " +
    "(unpkg.com). Check your internet connection or firewall and reload." +
    "</div>";
  throw new Error("Leaflet (L) not available");
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = L.map("map", {
  center: [54.5, -114.5], // Alberta
  zoom: 6,
  minZoom: 4,
  maxZoom: 16,
  zoomControl: true,
  preferCanvas: true, // fast rendering for thousands of fire points
});
map.attributionControl.setPrefix(false);

const fireRenderer = L.canvas({ padding: 0.5 });

// ---------------------------------------------------------------------------
// Fire glyph — flames instead of circles
// ---------------------------------------------------------------------------
// A flame silhouette + inner "hot core", authored as SVG paths centered on
// (0,0) in a roughly unit-sized box. Each fire scales this by its area-based
// radius, so bigger fires draw bigger flames. Drawing goes straight onto the
// shared canvas renderer (one canvas, no per-marker DOM), so tens of thousands
// of flames stay smooth — the same performance profile as the circles they
// replace.
const FLAME_OUTER = new Path2D(
  "M0.06,-1.42 C0.34,-0.98 0.82,-0.66 0.82,-0.08 " +
  "C0.82,0.52 0.42,0.86 0,1.04 C-0.42,0.86 -0.82,0.52 -0.82,-0.08 " +
  "C-0.82,-0.62 -0.30,-0.98 0.06,-1.42 Z"
);
const FLAME_INNER = new Path2D(
  "M0.04,-0.66 C0.22,-0.32 0.44,-0.10 0.44,0.24 " +
  "C0.44,0.56 0.20,0.82 0,0.92 C-0.20,0.80 -0.44,0.54 -0.44,0.22 " +
  "C-0.44,-0.10 -0.16,-0.34 0.04,-0.66 Z"
);
const EMBER_FILL = "#31363d"; // charcoal — an extinguished / burned-out fire

// Lighten a #hex toward white by amt (0..1); used for each flame's hot core.
function lighten(hex, amt) {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const n = parseInt(s, 16);
  const mix = (v) => Math.round(v + (255 - v) * amt);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
const innerCache = new Map();
function innerColor(fill) {
  let c = innerCache.get(fill);
  if (c === undefined) { c = lighten(fill, 0.5); innerCache.set(fill, c); }
  return c;
}

// Inline-SVG flame, for the sidebar legend swatches (matches the map glyph).
function flameSwatch(color) {
  return (
    `<svg class="lg-flame" viewBox="-0.95 -1.55 1.9 2.75" width="12" height="16" aria-hidden="true">` +
    `<path d="M0.06,-1.42 C0.34,-0.98 0.82,-0.66 0.82,-0.08 C0.82,0.52 0.42,0.86 0,1.04 ` +
    `C-0.42,0.86 -0.82,0.52 -0.82,-0.08 C-0.82,-0.62 -0.30,-0.98 0.06,-1.42 Z" fill="${color}"/></svg>`
  );
}

// A CircleMarker that paints a flame instead of a disc. Subclassing keeps all
// of Leaflet's proven canvas positioning, pan/zoom handling and click
// hit-testing (a click within the marker radius opens the popup); we override
// only the draw step.
const FlameMarker = L.CircleMarker.extend({
  _updatePath() {
    const ctx = this._renderer && this._renderer._ctx;
    if (!ctx || !this._point) return;
    const r = this._radius, o = this.options;
    ctx.save();
    ctx.translate(this._point.x, this._point.y);
    ctx.scale(r, r);
    if (o.ember) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = EMBER_FILL;
      ctx.fill(FLAME_OUTER);
      ctx.fillStyle = "#4a515b";
      ctx.fill(FLAME_INNER);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.9 / r;
      ctx.strokeStyle = "#111418";
      ctx.stroke(FLAME_OUTER);
    } else {
      const a = o.fillOpacity == null ? 0.92 : o.fillOpacity;
      ctx.globalAlpha = a;
      ctx.fillStyle = o.fillColor;
      ctx.fill(FLAME_OUTER);
      ctx.globalAlpha = Math.min(1, a + 0.14);
      ctx.fillStyle = o._inner || innerColor(o.fillColor);
      ctx.fill(FLAME_INNER);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.8 / r;
      ctx.strokeStyle = "rgba(24,10,2,0.42)";
      ctx.stroke(FLAME_OUTER);
    }
    ctx.restore();
  },
});
function flameMarker(latlng, opts) { return new FlameMarker(latlng, opts); }

// During season playback we have no real "put-out" date, so a fire stays a live
// flame for `burnWindow` days after its start day, then greys to an ember. The
// window grows with fire size (bigger fires burn longer).
function burnWindow(sizeHa) {
  const w = 7 + Math.sqrt(sizeHa > 0 ? sizeHa : 0);
  return Math.max(7, Math.min(45, w));
}

// ---------------------------------------------------------------------------
// Base maps (mutually exclusive)
// ---------------------------------------------------------------------------
const baseMaps = {
  "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }),
  "Esri Topographic": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri" }
  ),
  "Esri Imagery": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar" }
  ),
  "Carto Light": L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: "© OpenStreetMap © CARTO",
  }),
};
let activeBase = baseMaps["OpenStreetMap"];
activeBase.addTo(map);

// ---------------------------------------------------------------------------
// Alberta ArcGIS overlay layers (rendered server-side, no CORS needed)
// ---------------------------------------------------------------------------
// Create an Alberta ArcGIS overlay lazily (only when first toggled on), and
// only if esri-leaflet actually loaded — so a CDN failure can never break the
// core map or the wildfire year dropdown.
function makeAlbertaLayer(service, opts = {}) {
  if (!window.L || !L.esri || !L.esri.dynamicMapLayer) {
    toast("Alberta base-layer plugin (esri-leaflet) failed to load; wildfire data still works.");
    return null;
  }
  return L.esri.dynamicMapLayer({
    url: `${AGSP}/${service}/MapServer`,
    opacity: opts.opacity ?? 0.85,
    useCors: false, // request rendered images, not CORS-bound JSON
    f: "image",
    attribution: "Government of Alberta / AGSP",
  });
}

// Definitions drive both the map layers and the sidebar toggles. Layers are
// instantiated on demand via .make() and cached on .layer.
const overlayDefs = [
  { key: "hydro", label: "Lakes & rivers (hydrography)", swatch: "#4aa3df",
    make: () => makeAlbertaLayer("base/base_water_feature_gcs_nad83", { opacity: 0.9 }) },
  { key: "muni", label: "Cities & municipalities", swatch: "#e8c14a",
    make: () => makeAlbertaLayer("base/municipalities", { opacity: 0.8 }) },
  { key: "roads", label: "Provincial basemap (roads, towns)", swatch: "#c8ccd2",
    make: () => makeAlbertaLayer("base/provincial_basemap_b", { opacity: 0.75 }) },
  { key: "ats", label: "ATS — Alberta Township System", swatch: "#7ee081",
    make: () => makeAlbertaLayer("base/alberta_township_system", { opacity: 0.7 }) },
  { key: "nts", label: "NTS — National Topographic System", swatch: "#d987f0",
    make: () => makeAlbertaLayer("grid/national_topographic_system", { opacity: 0.7 }) },
  { key: "landuse", label: "Land use", swatch: "#b6d47a",
    make: () => makeAlbertaLayer("base/land_use", { opacity: 0.55 }) },
];

// ---------------------------------------------------------------------------
// Build the base-map & overlay toggle UI
// ---------------------------------------------------------------------------
function buildLayerUI() {
  const baseBox = document.getElementById("baseLayers");
  Object.keys(baseMaps).forEach((name, i) => {
    const row = document.createElement("label");
    row.className = "layer-row";
    row.innerHTML = `<input type="radio" name="basemap" ${i === 0 ? "checked" : ""}><span>${name}</span>`;
    row.querySelector("input").addEventListener("change", () => {
      map.removeLayer(activeBase);
      activeBase = baseMaps[name];
      activeBase.addTo(map);
      activeBase.bringToBack();
    });
    baseBox.appendChild(row);
  });

  const ovBox = document.getElementById("overlayLayers");
  overlayDefs.forEach((def) => {
    const row = document.createElement("label");
    row.className = "layer-row";
    row.innerHTML =
      `<input type="checkbox" ${def.on ? "checked" : ""}>` +
      `<span class="swatch" style="background:${def.swatch}"></span><span>${def.label}</span>`;
    const cb = row.querySelector("input");
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!def.layer) def.layer = def.make();
        if (def.layer) {
          def.layer.addTo(map);
          keepFiresOnTop();
        } else {
          cb.checked = false; // plugin unavailable
        }
      } else if (def.layer) {
        map.removeLayer(def.layer);
      }
    });
    ovBox.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Wildfire cause → colour
// ---------------------------------------------------------------------------
const CAUSE_COLORS = [
  { test: /lightning/i, color: "#3b82f6" },
  { test: /recreat/i, color: "#f59e0b" },
  { test: /resident/i, color: "#eab308" },
  { test: /incendiary|arson/i, color: "#ef4444" },
  { test: /power ?line/i, color: "#8b5cf6" },
  { test: /rail/i, color: "#ec4899" },
  { test: /agricultur/i, color: "#22c55e" },
  { test: /industr/i, color: "#a855f7" },
  { test: /restart|hold ?over/i, color: "#14b8a6" },
  { test: /undeterm|unknown|unclass/i, color: "#94a3b8" },
  { test: /human/i, color: "#fb7c4a" },
];
const FALLBACK_PALETTE = ["#f97316", "#06b6d4", "#84cc16", "#e879f9", "#f43f5e", "#38bdf8"];
const dynamicColorCache = new Map();
let fallbackIdx = 0;

function causeColor(cause) {
  const c = (cause || "Unknown").trim();
  for (const rule of CAUSE_COLORS) if (rule.test.test(c)) return rule.color;
  if (!dynamicColorCache.has(c)) {
    dynamicColorCache.set(c, FALLBACK_PALETTE[fallbackIdx++ % FALLBACK_PALETTE.length]);
  }
  return dynamicColorCache.get(c);
}

// Marker radius scales with the square root of area burned (equal-area perception).
function fireRadius(sizeHa) {
  if (!sizeHa || sizeHa <= 0) return 3;
  const r = Math.sqrt(sizeHa) * 0.55;
  return Math.max(3, Math.min(38, r));
}

function fmt(n, digits = 0) {
  if (n == null || !isFinite(n)) return "—";
  return Number(n).toLocaleString("en-CA", { maximumFractionDigits: digits });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ALL = []; // all features
let byYear = new Map(); // year -> features[]
let currentYear = "all";
const disabledCauses = new Set();
let fireLayer = L.layerGroup().addTo(map);
let playTimer = null; // year-stepping play
let seasonCutoff = null; // day-of-year cutoff for the selected year's timeline (null = no filter)
let seasonPlayTimer = null;
let yearCumCounts = null; // Int32Array[367]: cumulative fires by doy for the current year
let riskZones = []; // top predicted high-risk zones for the forecast year
const riskLayer = L.layerGroup(); // ⚠ hotspot markers; toggled from the sidebar
let showHistorical = true; // "Show historical fires" toggle — off = clean operational map

function keepFiresOnTop() {
  if (map.hasLayer(fireLayer)) fireLayer.bringToFront?.();
}

// Show/hide the historical fire flames + season timeline for a clean map.
function setHistoricalVisible(on) {
  showHistorical = on;
  const tl = document.getElementById("timeline");
  if (on) {
    if (!map.hasLayer(fireLayer)) fireLayer.addTo(map);
    if (tl) tl.hidden = currentYear === "all";
  } else {
    if (map.hasLayer(fireLayer)) map.removeLayer(fireLayer);
    if (tl) tl.hidden = true;
  }
  render();
  keepFiresOnTop();
}
function initHistoricalToggle() {
  const cb = document.getElementById("histToggle");
  if (cb) cb.addEventListener("change", () => setHistoricalVisible(cb.checked));
}

// ---------------------------------------------------------------------------
// Fire-risk forecast — historical-frequency hotspots
// ---------------------------------------------------------------------------
// An honest, model-free "prediction": bin every historical fire into a coarse
// grid, score each cell by how many fires it has seen with recent years
// weighted far more heavily than the 1960s–70s (a 15-year half-life), and flag
// the highest-scoring cells with a ⚠ marker. This is a where-fires-keep-
// clustering forecast, NOT a weather/fuel model — and the UI says so.
const FORECAST_YEAR = 2026;
const RISK_CELL_DEG = 0.5; // ~50 km grid cells
const RISK_TOP_N = 20; // number of ⚠ zones to flag
const RISK_HALF_LIFE = 15; // years; a fire this many years ago counts half
const RISK_RECENT_SINCE = FORECAST_YEAR - 25; // "last 25 years" cutoff for the stats

function recencyWeight(year) {
  if (!year) return 0;
  return Math.pow(0.5, (FORECAST_YEAR - 1 - year) / RISK_HALF_LIFE);
}

// amber → red ramp for a normalized risk t in [0,1].
function riskColor(t) {
  const a = [245, 158, 11], b = [185, 28, 28]; // #f59e0b → #b91c1c
  const m = (i) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}
function riskLevel(t) {
  return t >= 0.8 ? "Extreme" : t >= 0.55 ? "Very high" : t >= 0.3 ? "High" : "Elevated";
}

function doyToMonth(doy) {
  let d = Math.max(1, Math.min(366, Math.round(doy)));
  for (let m = 0; m < 12; m++) { if (d <= DAYS_IN_MONTH[m]) return m; d -= DAYS_IN_MONTH[m]; }
  return 11;
}

// Bin all historical fires and return the top-N highest-scoring zones.
function computeRiskZones(features) {
  const cells = new Map();
  for (const f of features) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c) continue;
    const lon = c[0], lat = c[1];
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const key = Math.floor(lon / RISK_CELL_DEG) + "," + Math.floor(lat / RISK_CELL_DEG);
    let cell = cells.get(key);
    if (!cell) {
      cell = { score: 0, wsum: 0, wsumLat: 0, wsumLon: 0, count: 0, recent: 0,
               totalHa: 0, largest: 0, causes: new Map(), months: new Int32Array(12) };
      cells.set(key, cell);
    }
    const p = f.properties;
    const w = recencyWeight(p.year);
    cell.score += w;
    cell.wsum += w; cell.wsumLat += lat * w; cell.wsumLon += lon * w;
    cell.count++;
    if (p.year >= RISK_RECENT_SINCE) cell.recent++;
    if (p.size > 0) { cell.totalHa += p.size; if (p.size > cell.largest) cell.largest = p.size; }
    const cause = p.cause || "Unknown";
    cell.causes.set(cause, (cell.causes.get(cause) || 0) + 1);
    if (p.doy != null) cell.months[doyToMonth(p.doy)]++;
  }

  const top = [...cells.values()].sort((a, b) => b.score - a.score).slice(0, RISK_TOP_N);
  if (!top.length) return [];
  const maxScore = top[0].score || 1;

  return top.map((cell, i) => {
    // Grade colour/level evenly by rank (#1 = hottest). Raw scores are dominated
    // by one or two outlier cells, which would leave the rest visually identical;
    // the true fire counts stay in the popup.
    const t = top.length > 1 ? 1 - i / (top.length - 1) : 1;
    let topCause = "—", topN = -1;
    for (const [cz, n] of cell.causes) if (n > topN) { topCause = cz; topN = n; }
    let pm = 0; for (let m = 1; m < 12; m++) if (cell.months[m] > cell.months[pm]) pm = m;
    return {
      rank: i + 1, t, color: riskColor(t), level: riskLevel(t),
      pct: Math.max(1, Math.round((cell.score / maxScore) * 100)), // relative risk index
      lat: cell.wsum ? cell.wsumLat / cell.wsum : 0,
      lon: cell.wsum ? cell.wsumLon / cell.wsum : 0,
      count: cell.count, recent: cell.recent, totalHa: cell.totalHa, largest: cell.largest,
      topCause, peakMonth: cell.months.some((n) => n > 0) ? MONTH_NAMES[pm] : "—",
    };
  });
}

// ⚠ warning-triangle glyph (SVG), filled on the amber→red risk ramp; the hotter
// zones are slightly larger and gently pulse.
function warningIcon(zone) {
  const size = Math.round(28 + zone.t * 12); // 28..40 px
  const cls = "risk-marker" + (zone.t >= 0.8 ? " risk-pulse" : "");
  const w = Math.max(size, 38);
  const svg =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" class="risk-svg">` +
    `<path d="M12 2.6 L22.6 21 A1.6 1.6 0 0 1 21.2 21.6 L2.8 21.6 A1.6 1.6 0 0 1 1.4 21 Z" ` +
    `fill="${zone.color}" stroke="#3a1206" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<rect x="10.8" y="8.2" width="2.4" height="6.8" rx="1.2" fill="#fff"/>` +
    `<circle cx="12" cy="18.2" r="1.5" fill="#fff"/></svg>`;
  const html = `<div class="risk-wrap">${svg}<span class="risk-pct" style="color:${zone.color}">${zone.pct}%</span></div>`;
  return L.divIcon({ className: cls, html, iconSize: [w, size + 15], iconAnchor: [w / 2, size / 2] });
}

// One-line, human-readable "why this area" from the zone's own stats.
function riskReason(z) {
  const c = (z.topCause || "").toLowerCase();
  let driver;
  if (/lightning/.test(c)) driver = "frequent lightning ignitions";
  else if (/unknown|undeterm|investig/.test(c)) driver = "recurring ignitions of varied cause";
  else driver = `mostly ${c || "unclassified"}-caused fires`;
  let s = `${fmt(z.recent)} fires in the last 25 years, ${driver}, peaking in ${z.peakMonth}.`;
  if (z.largest >= 5000) s += ` Has produced very large burns (up to ${fmt(z.largest)} ha).`;
  return s;
}

function riskPopup(z) {
  const rows = [
    ["Risk index", `${z.pct}% · #${z.rank} of ${RISK_TOP_N} · ${z.level}`],
    ["Historical fires", `${fmt(z.count)} (${fmt(z.recent)} in last 25 yrs)`],
    ["Total burned", z.totalHa ? `${fmt(z.totalHa)} ha` : "—"],
    ["Largest fire", z.largest ? `${fmt(z.largest)} ha` : "—"],
    ["Top cause", z.topCause],
    ["Peak month", z.peakMonth],
    ["Center", `${z.lat.toFixed(2)}°, ${z.lon.toFixed(2)}°`],
  ];
  return (
    `<div class="fire-pop risk-pop"><h3>⚠ High fire potential · ${FORECAST_YEAR}</h3>` +
    `<p class="risk-why"><b>Why:</b> ${riskReason(z)}</p><table>` +
    rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("") +
    `</table><p class="risk-caveat">Risk index is relative (100% = the single highest-risk zone), ` +
    `from historical fire frequency with recent years weighted — not a weather- or fuel-based ` +
    `probability.</p></div>`
  );
}

// Compute the zones and (re)build their markers once, after data has loaded.
function buildRiskLayer() {
  riskLayer.clearLayers();
  riskZones = computeRiskZones(ALL);
  for (const z of riskZones) {
    const m = L.marker([z.lat, z.lon], { icon: warningIcon(z), zIndexOffset: 1000, riseOnHover: true });
    m.bindPopup(riskPopup(z), { maxWidth: 300 });
    riskLayer.addLayer(m);
  }
  const cnt = document.getElementById("riskCount");
  if (cnt) cnt.textContent = riskZones.length ? `${riskZones.length} zones flagged` : "no data";
  const cb = document.getElementById("riskToggle");
  if (cb && cb.checked) riskLayer.addTo(map);
}

function initRiskToggle() {
  const cb = document.getElementById("riskToggle");
  if (!cb) return;
  cb.addEventListener("change", () => {
    if (cb.checked) riskLayer.addTo(map);
    else map.removeLayer(riskLayer);
  });
}

// ---------------------------------------------------------------------------
// Drone patrol (simulation)
// ---------------------------------------------------------------------------
// Deploy a small drone fleet over the ⚠ hotspots. The zones are clustered into
// DRONE_COUNT geographic groups; each drone flies an auto-generated looping
// route through its group, sweeping a scan radius, and — while near a zone —
// "detects" fire with a chance scaled by that zone's risk index. Detections
// drop a pulsing alert and stream into the floating Command Center. This is a
// visual SIMULATION over historical data — there is no live drone or sensor.
const DRONE_COUNT = 3;
const DRONE_COLORS = ["#22d3ee", "#a3e635", "#f472b6"]; // cyan, lime, pink
const SCAN_KM = 40; // drone scan radius
const DRONE_SPEED = 40; // km per mission-minute
const DETECT_COOLDOWN_S = 2; // min real seconds between one drone's detections

let patrolActive = false;
let drones = [];
const patrolLayer = L.layerGroup(); // routes, drones, scan circles
const alertLayer = L.layerGroup(); // 🔥 detection markers
let patrolRAF = null;
let patrolLastTs = 0;
let missionMinutes = 0; // simulated mission clock
let patrolSpeedMul = 1;
let detectionLog = [];
let totalDetections = 0;
let lastCC = 0; // command-center DOM throttle

function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// k-means (deterministic farthest-point seeding) → k geographic clusters.
function clusterZones(zones, k) {
  if (zones.length <= k) return zones.map((z) => [z]);
  const d2 = (a, b) => {
    const dlon = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180), dlat = a.lat - b.lat;
    return dlon * dlon + dlat * dlat;
  };
  const seeds = [zones[0]];
  while (seeds.length < k) {
    let best = zones[0], bd = -1;
    for (const z of zones) {
      let m = Infinity;
      for (const s of seeds) m = Math.min(m, d2(z, s));
      if (m > bd) { bd = m; best = z; }
    }
    seeds.push(best);
  }
  const cent = seeds.map((s) => ({ lat: s.lat, lon: s.lon }));
  const assign = new Array(zones.length).fill(0);
  for (let it = 0; it < 14; it++) {
    for (let i = 0; i < zones.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dd = d2(zones[i], cent[c]); if (dd < bd) { bd = dd; bi = c; } }
      assign[i] = bi;
    }
    const acc = Array.from({ length: k }, () => ({ lat: 0, lon: 0, n: 0 }));
    for (let i = 0; i < zones.length; i++) { const a = assign[i]; acc[a].lat += zones[i].lat; acc[a].lon += zones[i].lon; acc[a].n++; }
    for (let c = 0; c < k; c++) if (acc[c].n) { cent[c] = { lat: acc[c].lat / acc[c].n, lon: acc[c].lon / acc[c].n }; }
  }
  const groups = Array.from({ length: k }, () => []);
  for (let i = 0; i < zones.length; i++) groups[assign[i]].push(zones[i]);
  return groups.filter((g) => g.length);
}

// Nearest-neighbour tour, starting from the group's highest-ranked zone.
function orderRoute(group) {
  const rest = [...group].sort((a, b) => a.rank - b.rank);
  const route = [rest.shift()];
  while (rest.length) {
    const last = route[route.length - 1];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) { const d = haversineKm(last, rest[i]); if (d < bd) { bd = d; bi = i; } }
    route.push(rest.splice(bi, 1)[0]);
  }
  return route;
}

// Top-down quadcopter glyph in the drone's colour.
function droneIcon(color) {
  const html =
    `<div class="drone-wrap">` +
    `<svg viewBox="-16 -16 32 32" width="30" height="30" class="drone-svg">` +
    `<g stroke="${color}" stroke-width="2"><line x1="-9" y1="-9" x2="9" y2="9"/><line x1="9" y1="-9" x2="-9" y2="9"/></g>` +
    `<g fill="${color}"><circle cx="-9" cy="-9" r="4.4"/><circle cx="9" cy="-9" r="4.4"/>` +
    `<circle cx="-9" cy="9" r="4.4"/><circle cx="9" cy="9" r="4.4"/></g>` +
    `<circle cx="0" cy="0" r="4.2" fill="#0f141b" stroke="${color}" stroke-width="2"/></svg></div>`;
  return L.divIcon({ className: "drone-marker", html, iconSize: [30, 30], iconAnchor: [15, 15] });
}

// Interpolate a position `dist` km along a drone's closed loop.
function posAlong(drone, dist) {
  let d = ((dist % drone.total) + drone.total) % drone.total;
  for (let s = 0; s < drone.segLens.length; s++) {
    if (d <= drone.segLens[s] || s === drone.segLens.length - 1) {
      const a = drone.loop[s], b = drone.loop[s + 1];
      const frac = drone.segLens[s] ? d / drone.segLens[s] : 0;
      return { lat: a.lat + (b.lat - a.lat) * frac, lon: a.lon + (b.lon - a.lon) * frac };
    }
    d -= drone.segLens[s];
  }
  return { lat: drone.loop[0].lat, lon: drone.loop[0].lon };
}

function nearestZone(pos) {
  let best = riskZones[0], bd = Infinity;
  for (const z of riskZones) { const d = haversineKm(pos, z); if (d < bd) { bd = d; best = z; } }
  return { zone: best, dist: bd };
}

function missionClock() {
  const m = missionMinutes;
  const p = (n) => String(Math.floor(n)).padStart(2, "0");
  return `T+${p(m / 60)}:${p(m % 60)}:${p((m * 60) % 60)}`;
}

function deployPatrol() {
  if (patrolActive) return;
  if (!riskZones.length) { toast("No forecast zones to patrol yet."); return; }
  const groups = clusterZones(riskZones, DRONE_COUNT);
  patrolLayer.clearLayers();
  alertLayer.clearLayers();
  drones = groups.map((g, i) => {
    const route = orderRoute(g);
    const loop = route.length > 1 ? [...route, route[0]] : [route[0], route[0]];
    const segLens = [];
    let total = 0;
    for (let s = 0; s < loop.length - 1; s++) { const d = Math.max(0.01, haversineKm(loop[s], loop[s + 1])); segLens.push(d); total += d; }
    const color = DRONE_COLORS[i % DRONE_COLORS.length];
    const latlngs = loop.map((z) => [z.lat, z.lon]);
    L.polyline(latlngs, { color, weight: 2, opacity: 0.5, dashArray: "6 8" }).addTo(patrolLayer);
    const scan = L.circle([loop[0].lat, loop[0].lon], { radius: SCAN_KM * 1000, color, weight: 1, opacity: 0.45, fillColor: color, fillOpacity: 0.06 }).addTo(patrolLayer);
    const marker = L.marker([loop[0].lat, loop[0].lon], { icon: droneIcon(color), zIndexOffset: 2000 }).addTo(patrolLayer);
    marker.bindTooltip(`Drone ${i + 1} · ${g.length} zones`, { direction: "top", offset: [0, -14] });
    return { id: i + 1, color, route, loop, segLens, total, dist: 0, marker, scan,
             curZone: route[0], battery: 100, coverage: 0, detections: 0, lastDetectAt: -1e9 };
  });
  patrolLayer.addTo(map);
  alertLayer.addTo(map);
  patrolActive = true;
  missionMinutes = 0; lastCC = 0; detectionLog = []; totalDetections = 0;
  patrolLastTs = performance.now();
  const cc = document.getElementById("commandCenter"); if (cc) cc.hidden = false;
  const btn = document.getElementById("patrolBtn"); if (btn) { btn.textContent = "■ Recall drones"; btn.classList.add("active"); }
  updateCommandCenter();
  patrolRAF = requestAnimationFrame(patrolTick);
}

function recallPatrol() {
  patrolActive = false;
  if (patrolRAF) cancelAnimationFrame(patrolRAF);
  patrolRAF = null;
  patrolLayer.clearLayers();
  alertLayer.clearLayers();
  if (map.hasLayer(patrolLayer)) map.removeLayer(patrolLayer);
  if (map.hasLayer(alertLayer)) map.removeLayer(alertLayer);
  drones = [];
  const cc = document.getElementById("commandCenter"); if (cc) cc.hidden = true;
  const btn = document.getElementById("patrolBtn"); if (btn) { btn.textContent = "🚁 Deploy patrol"; btn.classList.remove("active"); }
}

function patrolTick(ts) {
  if (!patrolActive) return;
  const dt = Math.min(0.1, (ts - patrolLastTs) / 1000);
  patrolLastTs = ts;
  const minPerSec = 0.8 * patrolSpeedMul;
  missionMinutes += minPerSec * dt;
  for (const dr of drones) {
    const km = DRONE_SPEED * minPerSec * dt;
    dr.dist += km;
    dr.coverage = Math.min(100, dr.coverage + (km / dr.total) * 100);
    dr.battery -= dt * 0.5 * patrolSpeedMul;
    if (dr.battery <= 12) dr.battery = 100; // swap/recharge at base — keep the demo running
    const pos = posAlong(dr, dr.dist);
    dr.marker.setLatLng([pos.lat, pos.lon]);
    dr.scan.setLatLng([pos.lat, pos.lon]);
    dr.curZone = nearestZone(pos).zone;
    maybeDetect(dr, pos, dt, ts);
  }
  if (ts - lastCC > 180) { updateCommandCenter(); lastCC = ts; }
  patrolRAF = requestAnimationFrame(patrolTick);
}

function maybeDetect(dr, pos, dt, ts) {
  if (ts - dr.lastDetectAt < (DETECT_COOLDOWN_S * 1000) / Math.max(0.5, patrolSpeedMul)) return;
  const { zone, dist } = nearestZone(pos);
  if (dist > SCAN_KM * 1.15) return; // only detect while actually over a hotspot
  const p = (zone.pct / 100) * 0.6 * patrolSpeedMul * dt;
  if (Math.random() < p) { dr.lastDetectAt = ts; spawnDetection(dr, zone, pos); }
}

function spawnDetection(dr, zone, pos) {
  dr.detections++;
  totalDetections++;
  const jlat = pos.lat + (Math.random() - 0.5) * 0.14, jlon = pos.lon + (Math.random() - 0.5) * 0.2;
  const conf = Math.round(56 + Math.random() * 43);
  const icon = L.divIcon({ className: "fire-alert", html: `<span class="fa-ring"></span><span class="fa-dot"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  const m = L.marker([jlat, jlon], { icon, zIndexOffset: 3000 }).addTo(alertLayer);
  m.bindPopup(
    `<div class="fire-pop"><h3>🔥 Fire detected · sim</h3><table>` +
    `<tr><td class="k">Drone</td><td>#${dr.id}</td></tr>` +
    `<tr><td class="k">Confidence</td><td>${conf}%</td></tr>` +
    `<tr><td class="k">Near</td><td>zone #${zone.rank} · ${zone.level}</td></tr>` +
    `<tr><td class="k">Location</td><td>${jlat.toFixed(2)}°, ${jlon.toFixed(2)}°</td></tr>` +
    `<tr><td class="k">Reported</td><td>${missionClock()}</td></tr></table></div>`, { maxWidth: 250 });
  setTimeout(() => { if (alertLayer.hasLayer(m)) alertLayer.removeLayer(m); }, 9000);
  detectionLog.unshift({ t: missionClock(), id: dr.id, color: dr.color, rank: zone.rank, conf, lat: jlat, lon: jlon });
  if (detectionLog.length > 9) detectionLog.pop();
}

function updateCommandCenter() {
  const cc = document.getElementById("commandCenter");
  if (!cc || cc.hidden) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("ccClock", missionClock());
  set("ccDetections", totalDetections);
  set("ccZones", riskZones.length);
  const dEl = document.getElementById("ccDrones");
  if (dEl) dEl.innerHTML = drones.map((d) =>
    `<div class="cc-drone">` +
    `<span class="cc-id" style="color:${d.color}">◈ Drone ${d.id}</span>` +
    `<span class="cc-meta">zone #${d.curZone.rank} · cov ${Math.round(d.coverage)}% · bat ${Math.round(d.battery)}% · ${d.detections}🔥</span>` +
    `<span class="cc-bar"><i style="width:${Math.round(d.coverage)}%;background:${d.color}"></i></span></div>`
  ).join("");
  const fEl = document.getElementById("ccFeed");
  if (fEl) fEl.innerHTML = detectionLog.length
    ? detectionLog.map((e) =>
        `<div class="cc-line"><span class="cc-t">${e.t}</span>` +
        `<span class="cc-dot" style="background:${e.color}"></span>` +
        `D${e.id} 🔥 ${e.lat.toFixed(2)},${e.lon.toFixed(2)} · #${e.rank} · ${e.conf}%</div>`
      ).join("")
    : `<div class="cc-line cc-idle">Scanning… no detections yet.</div>`;
}

function initPatrol() {
  const btn = document.getElementById("patrolBtn");
  if (btn) btn.addEventListener("click", () => (patrolActive ? recallPatrol() : deployPatrol()));
  const rc = document.getElementById("ccRecall");
  if (rc) rc.addEventListener("click", recallPatrol);
  const sp = document.getElementById("ccSpeed");
  if (sp) sp.addEventListener("input", () => { patrolSpeedMul = +sp.value; });
  const cc = document.getElementById("commandCenter");
  if (cc) { L.DomEvent.disableClickPropagation(cc); L.DomEvent.disableScrollPropagation(cc); }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function currentFeatures() {
  const feats = currentYear === "all" ? ALL : byYear.get(Number(currentYear)) || [];
  return feats.filter((f) => {
    if (disabledCauses.has(f.properties.cause || "Unknown")) return false;
    if (seasonCutoff != null) {
      const d = f.properties.doy == null ? 366 : f.properties.doy;
      if (d > seasonCutoff) return false;
    }
    return true;
  });
}

function render() {
  fireLayer.clearLayers();
  const feats = currentFeatures();

  // Historical layer turned off → keep the map clean (stats still update).
  if (!showHistorical) { updateStats(feats); updateLegend(); return; }

  // Embers only appear while the user is scrubbing/playing a single year's
  // season (a partial cutoff). Static views — All years, or the default
  // "Full year" position — show every fire as a live flame.
  const animating = currentYear !== "all" && seasonCutoff != null && seasonCutoff < 366;
  const isEmber = (f) =>
    animating && f.properties.doy != null &&
    seasonCutoff - f.properties.doy > burnWindow(f.properties.size);

  // Draw embers first (underneath), then live flames largest-last, so big
  // active fires sit on top.
  const sorted = [...feats].sort((a, b) => {
    const ea = isEmber(a), eb = isEmber(b);
    if (ea !== eb) return ea ? -1 : 1;
    return (a.properties.size || 0) - (b.properties.size || 0);
  });

  for (const f of sorted) {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    const ember = isEmber(f);
    const fill = ember ? EMBER_FILL : causeColor(p.cause);
    const marker = flameMarker([lat, lon], {
      renderer: fireRenderer,
      radius: fireRadius(p.size),
      ember,
      fillColor: fill,
      fillOpacity: 0.92,
      _inner: ember ? null : innerColor(fill),
    });
    marker.on("click", () => marker.bindPopup(firePopup(p), { maxWidth: 300 }).openPopup());
    fireLayer.addLayer(marker);
  }

  updateStats(feats);
  updateLegend();
}

function firePopup(p) {
  const rows = [
    ["Fire", [p.number, p.name].filter(Boolean).join(" · ") || "—"],
    ["Year", p.year],
    ["Cause", p.cause || "—"],
    ["Size", p.size != null ? `${fmt(p.size, 1)} ha` : "—"],
    ["Size class", p.sizeClass || "—"],
    ["Type", p.status || "—"],
    ["Start", p.start ? String(p.start).slice(0, 16).replace("T", " ") : "—"],
  ];
  return (
    `<div class="fire-pop"><h3>🔥 Wildfire ${p.year}</h3><table>` +
    rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("") +
    `</table></div>`
  );
}

function updateStats(feats) {
  const total = feats.reduce((s, f) => s + (f.properties.size || 0), 0);
  const largest = feats.reduce((m, f) => Math.max(m, f.properties.size || 0), 0);
  document.getElementById("statFires").textContent = fmt(feats.length);
  document.getElementById("statArea").textContent = fmt(total);
  document.getElementById("statLargest").textContent = fmt(largest);
}

function updateLegend() {
  const feats = currentYear === "all" ? ALL : byYear.get(Number(currentYear)) || [];
  const counts = new Map();
  for (const f of feats) {
    const c = f.properties.cause || "Unknown";
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const ul = document.getElementById("legend");
  ul.innerHTML = "";
  for (const [cause, n] of sorted) {
    const li = document.createElement("li");
    if (disabledCauses.has(cause)) li.classList.add("off");
    li.innerHTML =
      flameSwatch(causeColor(cause)) +
      `<span>${cause}</span><span class="count">${fmt(n)}</span>`;
    li.title = "Click to show/hide this cause";
    li.addEventListener("click", () => {
      if (disabledCauses.has(cause)) disabledCauses.delete(cause);
      else disabledCauses.add(cause);
      render();
    });
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Year controls
// ---------------------------------------------------------------------------
function populateYears(years) {
  const sel = document.getElementById("yearSelect");
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = `All years (${years[0]}–${years[years.length - 1]})`;
  sel.appendChild(all);
  // newest first
  [...years].reverse().forEach((y) => {
    const o = document.createElement("option");
    o.value = String(y);
    o.textContent = y;
    sel.appendChild(o);
  });
  sel.disabled = false;
  // Default to the most recent year — instant, smooth first paint. With 65 years
  // of data, "All years" (tens of thousands of points) stays available but opt-in.
  const newest = String(years[years.length - 1]);
  sel.value = newest;
  currentYear = newest;

  sel.addEventListener("change", () => {
    currentYear = sel.value;
    onYearSelected();
  });

  document.getElementById("prevYear").disabled = false;
  document.getElementById("nextYear").disabled = false;
  document.getElementById("playBtn").disabled = false;

  const step = (dir) => {
    const opts = [...sel.options].map((o) => o.value);
    let i = opts.indexOf(sel.value) + dir;
    if (i < 1) i = opts.length - 1; // wrap, skipping "all" at index 0
    if (i >= opts.length) i = 1;
    sel.value = opts[i];
    currentYear = sel.value;
    onYearSelected();
  };
  document.getElementById("prevYear").addEventListener("click", () => step(-1));
  document.getElementById("nextYear").addEventListener("click", () => step(1));

  document.getElementById("playBtn").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      btn.textContent = "▶ Play";
      return;
    }
    btn.textContent = "⏸ Pause";
    // start from the first real year
    const opts = [...sel.options].map((o) => o.value);
    if (sel.value === "all") { sel.value = opts[1]; currentYear = sel.value; onYearSelected(); }
    playTimer = setInterval(() => step(1), 1600);
  });
}

// ---------------------------------------------------------------------------
// Season timeline (per selected year)
// ---------------------------------------------------------------------------
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function doyToLabel(doy) {
  let d = Math.max(1, Math.min(366, Math.round(doy)));
  for (let m = 0; m < 12; m++) {
    if (d <= DAYS_IN_MONTH[m]) return `${MONTH_NAMES[m]} ${d}`;
    d -= DAYS_IN_MONTH[m];
  }
  return "Dec 31";
}

// Called whenever the selected year changes.
function onYearSelected() {
  stopSeasonPlay();
  const tl = document.getElementById("timeline");
  if (currentYear === "all") {
    seasonCutoff = null;
    yearCumCounts = null;
    tl.hidden = true;
    render();
  } else {
    buildTimeline(Number(currentYear)); // sets cutoff=366 (whole year) + draws chart
    tl.hidden = !showHistorical; // hidden when the historical layer is off
    render();
  }
}

const TL_BINS = 61; // ~6-day buckets across the year

function buildTimeline(year) {
  const feats = byYear.get(year) || [];
  const bins = new Array(TL_BINS).fill(0);
  const cum = new Int32Array(367);
  for (const f of feats) {
    const dd = f.properties.doy;
    const d = dd == null ? 366 : Math.max(1, Math.min(366, dd));
    cum[d]++;
    if (dd != null) bins[Math.min(TL_BINS - 1, Math.floor((d - 1) / 366 * TL_BINS))]++;
  }
  for (let i = 1; i <= 366; i++) cum[i] += cum[i - 1];
  yearCumCounts = cum;

  const max = Math.max(1, ...bins);
  const bw = 366 / TL_BINS;
  let svg = "";
  for (let i = 0; i < TL_BINS; i++) {
    const h = (bins[i] / max) * 96;
    svg += `<rect class="tl-bar" data-bin="${i}" x="${(i * bw).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(bw * 0.86).toFixed(2)}" height="${h.toFixed(2)}"></rect>`;
  }
  document.getElementById("tlSvg").innerHTML = svg;
  document.getElementById("tlYear").textContent = `(${year})`;
  document.getElementById("tlRange").value = 366;
  setSeason(366, false); // whole year selected; caller triggers render()
}

// Move the season cutoff; update readout, cursor, bar shading. Optionally render.
function setSeason(doy, doRender = true) {
  doy = Math.max(1, Math.min(366, Math.round(doy)));
  seasonCutoff = doy;
  document.getElementById("tlCursor").style.left = `${(doy / 366) * 100}%`;
  document.getElementById("tlDate").textContent = doyToLabel(doy);
  document.getElementById("tlCount").textContent = (yearCumCounts ? yearCumCounts[doy] : 0).toLocaleString();
  const bars = document.querySelectorAll("#tlSvg .tl-bar");
  bars.forEach((r) => {
    const center = ((+r.dataset.bin + 0.5) / TL_BINS) * 366;
    r.classList.toggle("past", center <= doy);
  });
  if (doRender) render();
}

function stopSeasonPlay() {
  if (seasonPlayTimer) {
    clearInterval(seasonPlayTimer);
    seasonPlayTimer = null;
    document.getElementById("tlPlay").textContent = "▶";
  }
}

function initTimeline() {
  // The timeline sits inside the Leaflet container; stop its pointer events from
  // panning/zooming the map when the user drags the slider or clicks buttons.
  const tl = document.getElementById("timeline");
  L.DomEvent.disableClickPropagation(tl);
  L.DomEvent.disableScrollPropagation(tl);

  const range = document.getElementById("tlRange");
  range.addEventListener("input", () => { stopSeasonPlay(); setSeason(+range.value); });

  document.getElementById("tlReset").addEventListener("click", () => {
    stopSeasonPlay();
    range.value = 366;
    setSeason(366);
  });

  document.getElementById("tlPlay").addEventListener("click", () => {
    const btn = document.getElementById("tlPlay");
    if (seasonPlayTimer) { stopSeasonPlay(); return; }
    btn.textContent = "⏸";
    let d = +range.value >= 366 ? 1 : +range.value; // replay from start if at the end
    const stepDays = 4;
    seasonPlayTimer = setInterval(() => {
      d += stepDays;
      if (d >= 366) { range.value = 366; setSeason(366); stopSeasonPlay(); return; }
      range.value = d;
      setSeason(d);
    }, 80);
  });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function toast(msg, ms = 6000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  if (ms) setTimeout(() => (el.hidden = true), ms);
}

function loadingBar() {
  const bar = document.createElement("div");
  bar.className = "loading-bar";
  document.getElementById("map").appendChild(bar);
  requestAnimationFrame(() => (bar.style.width = "70%"));
  return {
    done() {
      bar.style.width = "100%";
      setTimeout(() => bar.remove(), 400);
    },
  };
}

// Try several sources in order so the app works whether it is served by the
// bundled Node server (/api route), by any plain static server (bundled file),
// or is told clearly that it must be run from a server at all.
async function fetchWildfire() {
  const sources = [
    "/api/wildfire.geojson", // dynamic route (node server.js) — freshest
    "wildfire.geojson", // static copy bundled in public/ — works on any static server
  ];
  const errors = [];
  for (const url of sources) {
    try {
      // no-store so a reload always reflects the current server data (avoids a
      // stale browser-cached copy from an earlier, smaller dataset).
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      const fc = await res.json();
      if (fc && Array.isArray(fc.features) && fc.features.length) return fc;
      errors.push(`${url} → empty/invalid response`);
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  const err = new Error(errors.join(" | "));
  err.sources = errors;
  throw err;
}

async function loadWildfire() {
  const bar = loadingBar();
  try {
    const fc = await fetchWildfire();
    ALL = fc.features || [];

    byYear = new Map();
    for (const f of ALL) {
      const y = f.properties.year;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(f);
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    populateYears(years);
    onYearSelected(); // builds the season timeline for the default (newest) year + renders
    buildRiskLayer(); // 2026 fire-risk forecast (independent of the year selector)

    const meta = fc.metadata || {};
    document.getElementById("dataMeta").textContent =
      `${fmt(ALL.length)} fires · ${years[0]}–${years[years.length - 1]} · updated ${(
        meta.generated || ""
      ).slice(0, 10)}`;
  } catch (err) {
    console.error("Wildfire load failed:", err);
    document.getElementById("yearSelect").innerHTML = "<option>Unavailable</option>";
    showError(err);
  } finally {
    bar.done();
  }
}

// Prominent, actionable error panel (replaces the small auto-hiding toast).
function showError(err) {
  const isFile = location.protocol === "file:";
  const el = document.getElementById("toast");
  el.hidden = false;
  el.classList.add("error-panel");
  if (isFile) {
    el.innerHTML =
      `<strong>The app must be run from a local server</strong><br>` +
      `You opened the page directly from a file, so it cannot load the data. ` +
      `Open a terminal in the project folder and run:<br>` +
      `<code>node server.js</code><br>then visit <code>http://localhost:5173</code>.`;
  } else {
    el.innerHTML =
      `<strong>Could not load wildfire data.</strong><br>` +
      `Make sure the server is running (<code>node server.js</code>) and reload. ` +
      `On first run it downloads the data from open.alberta.ca, so an internet ` +
      `connection is needed once.<br><span class="err-detail">${err.message}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
buildLayerUI();
document.getElementById("emberNote").insertAdjacentHTML("afterbegin", flameSwatch(EMBER_FILL));
initTimeline();
initRiskToggle();
initHistoricalToggle();
initPatrol();
loadWildfire();
