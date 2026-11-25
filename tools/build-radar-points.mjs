/* Generates data/radar-points.json for the homepage storm-check radar
   panel's dot field — a decorative summary, not the interactive tool
   (that's storm-history.html, driven directly by data/reports-*.json and
   data/hail-*.json). Run by hand after build-storm-data.mjs updates the
   archive; not wired into netlify-build.sh since this panel's data only
   needs to move when the archive does, not on every deploy.

   One dot per distinct grid cell (bucketOf/GRID_DEG from storm-grid.mjs —
   same ~5km bucketing the interactive map already uses, reused rather
   than re-derived) across every data/reports-*.json report, hail and wind
   together. A cell can hold many reports over 2016-2026; each dot
   represents the single most severe one, since the panel has room for one
   mark per location, not a history per location.

   "Most severe" has to cross hail (inches) and wind (mph) with no shared
   unit, so each report's severity is its value as a fraction of the max
   of its own kind across the whole archive (1 = the worst hail or worst
   wind on record, not comparable in absolute terms between kinds, only
   in rank). The cell keeps whichever single report scores highest.

   Output is sorted by severity descending. The client takes the first 60
   for the sweep's ping animation and renders the rest static — see
   script.js and the "60" the panel was asked to animate, not 394.

   reportCount (every individual report, pre-dedup) and count (distinct
   cells) are both real, both from this same pass — the panel's count
   block shows "reportCount storms across count locations since
   sinceYear", not just one of the two numbers alone. */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { bucketOf, GRID_DEG } from "./storm-grid.mjs";

const dataDir = new URL("../data/", import.meta.url);

const { bbox, years } = JSON.parse(
  readFileSync(new URL("storm-index.json", dataDir), "utf8")
);
const sinceYear = Math.min(...years.map(Number));

const reportFiles = readdirSync(dataDir).filter(
  (f) => f.startsWith("reports-") && f.endsWith(".json")
);

const allReports = [];
for (const file of reportFiles) {
  const { fields, reports } = JSON.parse(
    readFileSync(new URL(file, dataDir), "utf8")
  );
  const idx = Object.fromEntries(fields.map((name, i) => [name, i]));
  for (const r of reports) {
    allReports.push({
      date: r[idx.date],
      kind: r[idx.kind],
      val: r[idx.val],
      lon: r[idx.lon],
      lat: r[idx.lat],
    });
  }
}

const maxByKind = {};
for (const r of allReports) {
  maxByKind[r.kind] = Math.max(maxByKind[r.kind] || 0, r.val);
}

const severityOf = (r) => r.val / maxByKind[r.kind];

const cells = new Map();
for (const r of allReports) {
  const [by, bx] = bucketOf(r.lat, r.lon);
  const key = by + "," + bx;
  const existing = cells.get(key);
  if (!existing || severityOf(r) > severityOf(existing)) {
    cells.set(key, r);
  }
}

const points = [...cells.values()]
  .map((r) => ({
    lon: r.lon,
    lat: r.lat,
    kind: r.kind,
    val: r.val,
    severity: Math.round(severityOf(r) * 1000) / 1000,
  }))
  .sort((a, b) => b.severity - a.severity);

writeFileSync(
  new URL("radar-points.json", dataDir),
  JSON.stringify({
    gridDeg: GRID_DEG,
    bbox,
    sinceYear,
    reportCount: allReports.length,
    count: points.length,
    points,
  }),
  "utf8"
);

console.log(
  `data/radar-points.json: ${points.length} distinct cells from ${allReports.length} reports across ${reportFiles.length} files.`
);
