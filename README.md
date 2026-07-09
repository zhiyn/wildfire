# Alberta Historical Wildfire Explorer

A web application for exploring **Government of Alberta historical wildfire GIS data**
on an interactive Alberta base map. Pick a year from the dropdown to see every
recorded wildfire for that year, coloured by cause and sized by area burned, over
Alberta reference layers (ATS, NTS, cities, roads, lakes/hydrography).

## What it does

- **Loads all historical wildfire data** published on
  [open.alberta.ca](https://open.alberta.ca/opendata/wildfire-data) —
  **67,500+ fires spanning 1961–2025**, one point per fire, merged from the four
  Government of Alberta datasets (1961–1982, 1983–1995, 1996–2005, 2006–2025).
- **Year dropdown** — choose a single year or *All years*. Prev/Next buttons and a
  **▶ Play** button animate through the years.
- **Season timeline** — when a single year is selected, a timeline appears along the
  bottom of the map showing that year's fires as a day-of-year histogram. Drag the
  scrubber (or press ▶) to advance through the fire season: the map, the stats, and the
  "fires by this date" counter update to show only fires that had started by that date.
- **Cause legend** with live counts; click a cause to show/hide it.
- **Stats panel** — number of fires, total hectares burned, and largest fire for the
  current selection.
- **Alberta base layers** served from the province's public ArcGIS services
  (Alberta Geospatial Services Platform):
  - **ATS** — Alberta Township System
  - **NTS** — National Topographic System grid
  - **Cities & municipalities**
  - **Provincial basemap** (roads, towns, hydro)
  - **Lakes & rivers** (hydrography)
  - **Land use**
- **Switchable base maps**: OpenStreetMap, Esri Topographic, Esri Imagery, Carto Light.
- Click any fire for full details (fire number/name, cause, size, size class, type, start).

## Data sources

| Data | Source |
|------|--------|
| Wildfire records | Government of Alberta — *Historical wildfire data* (four CSVs: [1961–1982](https://open.alberta.ca/opendata/wildfire-data-1961-1982), [1983–1995](https://open.alberta.ca/opendata/wildfire-data-1983-1995), [1996–2005](https://open.alberta.ca/opendata/wildfire-data-1996-2005), [2006–2025](https://open.alberta.ca/opendata/wildfire-data)) |
| ATS, NTS, municipalities, hydrography, land use, provincial basemap | Alberta Geospatial Services Platform public ArcGIS REST services (`geospatial.alberta.ca/titan`) |
| Global base maps | OpenStreetMap, Esri, CARTO |

The Node server downloads the four wildfire CSVs on first run, converts and merges
them into a single GeoJSON, and caches it under `data/` (refreshed weekly). Serving it
same-origin (gzip-compressed, ~16 MB → ~1.3 MB) avoids any browser CORS restriction on
the open-data host and makes repeat loads instant.

**Reconciling the four vintages.** The older datasets use different schemas — the
1961–1982 file has uppercase headers, 2-digit years, numeric cause codes and areas in
**acres**; 1983–1995 uses numeric cause codes with areas in hectares; 1996–2025 use the
modern text schema. The server normalizes all of them (2-digit years expanded, cause
codes decoded to labels, acres converted to hectares) using each dataset's published
data dictionary, so the year dropdown, cause legend, and hectare totals are consistent
across the whole 1961–2025 range. Note that some early-era fire coordinates are
approximate (recorded to the legal land location of origin).

## Requirements

- **Node.js 18+** (developed on Node 24). No npm packages to install — the server uses
  only Node's built-in modules.
- An internet connection on **first run** (to download the wildfire CSV and to fetch the
  Alberta ArcGIS base-layer tiles / Leaflet from CDN).

## Run it

```bash
node server.js
```

Then open **http://localhost:5173**.

Set a different port with `PORT=8080 node server.js`.

## How it works

```
server.js            Zero-dependency Node server:
                       • serves the static frontend from public/
                       • GET /api/wildfire.geojson  – downloads + caches the Alberta
                         wildfire CSV and converts it to slim GeoJSON
                       • GET /api/proxy?url=…        – same-origin proxy (Alberta hosts)
public/index.html    App shell + sidebar
public/style.css     Styling
public/app.js        Leaflet map, Alberta ArcGIS overlays (via esri-leaflet),
                       year filtering, cause colouring, legend, stats
data/                Cached CSV + generated GeoJSON (auto-created)
```

### Data sources / adding more

All four published historical datasets (1961–2025) are already wired into
`WILDFIRE_SOURCES` in `server.js`. Each entry is either auto-detected (modern schema) or
given an explicit `columns` map plus `transforms` (2-digit-year expansion, `causeMap`
code lookup, `sizeToHa` unit conversion) derived from that dataset's data dictionary. To
add or refresh a source, edit that array and delete `data/wildfire.geojson` to force a
rebuild.

## Notes

- The map defaults to Alberta (54.5°N, 114.5°W, zoom 6).
- Fire marker radius scales with the square root of area burned (equal-area perception);
  markers are drawn on an HTML canvas so tens of thousands of points stay smooth.
- Base-layer overlays are rendered server-side by ArcGIS (image export), so they display
  without requiring CORS.

## License

MIT. Wildfire and geospatial data © Government of Alberta, used under the
[Open Government Licence – Alberta](https://open.alberta.ca/licence).
