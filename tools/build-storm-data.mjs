/* Storm data generator for storm-history.html.

   Ported from riseroofingms.com's storm history tool for the Memphis metro
   area: Shelby, Fayette, and Tipton counties in Tennessee, DeSoto, Marshall,
   Tate, and Tunica counties in Mississippi, and Crittenden county in
   Arkansas.

   Runs at build time or from a scheduled job, never in the request path.
   Output is committed as static JSON so the page stays on Netlify with no
   backend. Two schedules call this file — see MODE, set from the workflow —
   for the same reason radar and ground truth are split below: some of this
   data is only a couple of hours old and would be stale by the next morning,
   most of it changes at most once a day.

   Seven sources, all free, public, and keyless:

     hail cells      NCEI SWDI nx3hail — NEXRAD Level-III hail detections,
                      radar-estimated. The historical archive; finalizes
                      60-90 days behind.

     hail cells      NOAA MRMS MESH, via NOAA Open Data Dissemination —
     (recent)        ~1km gridded radar estimate, available within ~2 hours.
                      Short retention, so this only ever looks back a couple
                      of weeks; SWDI above is authoritative for anything
                      older, and wherever both describe the same storm SWDI
                      wins (see preferSwdiOverMesh).

     reports         NCEI Storm Events — the quality-controlled NWS reports,
                      observed. Four months behind; the historical layer.

     reports         Iowa State's NWS Local Storm Reports feed — the same
     (recent)        spotter reports Storm Events eventually publishes,
                      observed, available within a day. Used only for dates
                      after the newest Storm Events record, so the two can
                      never describe the same event twice.

     reports         CoCoRaHS — volunteer-measured hail, observed with a
     (ground truth)  ruler, not radar.

     reports         ASOS/AWOS station gusts, via Iowa Environmental Mesonet
     (ground truth)  — observed, measured, filtered to >= MIN_GUST_MPH so a
                      routine windy day doesn't read as a storm.

     warnings        NWS active alerts (api.weather.gov) — Severe
                      Thunderstorm and Tornado Warning polygons, polled every
                      4 hours and accumulated forever (see nwsWarnings). Not
                      a radar estimate or an observation — a forecaster's
                      judgment call, informed by radar, at the moment of
                      issuance.

   Units are normalised here: everything leaves this file in mph for wind and
   inches for hail. Storm Events and ASOS store knots, LSRs store mph, and
   having the browser guess which is which is exactly how a 66 mph gust
   becomes 76.
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { GRID_DEG, cellKey, bucketOf, preferred, preferredReport } from "./storm-grid.mjs";
import { hasEccodes, extractMesh } from "./mesh.mjs";

/* One geographic filter for every layer. A bbox rather than a list of county
   names: a homeowner two miles over the county line should not get an empty
   result because of where a surveyor drew a boundary in 1836. Covers the
   Memphis metro: Shelby/Fayette/Tipton TN, DeSoto/Marshall/Tate/Tunica MS,
   and Crittenden AR. */
const BBOX = { minLon: -90.8, minLat: 34.4, maxLon: -89.0, maxLat: 35.6 };
const BBOX_STR = [BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat].join(",");

const YEARS = Number(process.env.YEARS || 10);

/* Incremental mode. WINDOW_MONTHS=n fetches only the last n calendar months
   and
   merges the result into the committed archive, instead of pulling the whole
   ten-year window.

   A full run is 133 HTTP requests to NOAA and ~95 seconds, and all but a
   handful of those requests return data that cannot have changed. At several
   runs a day that is a lot of traffic for nothing. WINDOW_MONTHS=2 is 4
   requests.

   The merge is safe because every record is keyed by day and the dedupe is
   per-day: days inside the window are replaced wholesale, days outside are
   kept untouched. Nothing is merged at finer granularity than a day, so an
   incremental run cannot produce a half-updated day.

   It is still only an optimisation, not a replacement — SWDI and Storm Events
   both revise older records, so a periodic full rebuild is what catches those.
   The workflow runs one weekly. tools/verify-incremental.mjs checks that an
   incremental run and a full run agree byte for byte. */
const WINDOW_MONTHS = Number(process.env.WINDOW_MONTHS || 0);
const INCREMENTAL = WINDOW_MONTHS > 0;

const END = new Date(Number(process.env.END_MS) || Date.now());

/* First day of the window, or null for a full build. Declared here because it
   reads END, which is set just above. */
const windowStart = INCREMENTAL
  ? new Date(Date.UTC(END.getUTCFullYear(), END.getUTCMonth() - (WINDOW_MONTHS - 1), 1))
      .toISOString().slice(0, 10)
  : null;
const OUT = process.argv[2];

const BUFFER_KM = 1.5;      // stated on the page; the circle is a radar cell, not a footprint
const MIN_SIZE_IN = 1.0;    // roughly where hail starts mattering to asphalt shingles
/* Storm Events/LSR wind reports are pre-filtered at the source — a "Thunderstorm
   Wind" record only exists because someone already judged it stormy. Raw ASOS
   gusts carry no such judgment, so without a floor here every breezy cold front
   shows up as a wind "event": one month of unfiltered gusts across ten stations
   ran to 8,000+ rows. 40 mph is comfortably below NWS severe criteria (58 mph)
   but well outside routine gusty-day range. */
const MIN_GUST_MPH = 40;
const KT_TO_MPH = 1.15078;

const inBbox = (lon, lat) =>
  lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Set whenever a source request is exhausted after retries. A failed chunk
   used to just log a warning and move on — fine for a request that covers a
   month of a ten-year backfill, disastrous for an incremental run where the
   whole fetched window is a couple of failed chunks: mergeWindow() drops the
   archive's existing data for that window and replaces it with whatever came
   back, so a bad run would commit an emptied window over real data. Checked
   once, right before anything is written. */
let hadFailure = false;

async function get(url, tries = 3, headers) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: "follow", headers });
      if (res.ok) return res;
      if (res.status === 404) return null;
    } catch (e) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

const MONTHS = { JAN:"01", FEB:"02", MAR:"03", APR:"04", MAY:"05", JUN:"06",
                 JUL:"07", AUG:"08", SEP:"09", OCT:"10", NOV:"11", DEC:"12" };

/* Storm Events writes BEGIN_DATE_TIME as DD-MON-YY HH:MM:SS. Slicing the first
   ten characters leaves "15-JUN-16 ", which no date parser reads and which
   string-sorts by day of month — that put 2016 above 2026 in a list whose
   whole promise is "most recent first". */
function isoDate(raw) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2})/.exec((raw || "").trim().toUpperCase());
  if (!m) return "";
  return `20${m[3]}-${MONTHS[m[2]] || "01"}-${m[1]}`;
}

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ---- hail cells ---------------------------------------------------------- */

function monthsBack(n, end) {
  const out = [];
  const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  for (let i = 0; i < n * 12; i++) {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
    const f = (x) => x.toISOString().slice(0, 10).replace(/-/g, "");
    out.push([f(s), f(e)]);
  }
  return out.reverse();
}

async function hail() {
  const raw = [];
  for (const [s, e] of monthsBack(INCREMENTAL ? WINDOW_MONTHS / 12 : YEARS, END)) {
    /* SWDI silently returns nothing for ranges over ~31 days, so this is
       chunked by month rather than pulled a year at a time. */
    const res = await get(`https://www.ncei.noaa.gov/swdiws/csv/nx3hail/${s}:${e}?bbox=${BBOX_STR}`);
    if (!res) { hadFailure = true; process.stderr.write(`  ! hail ${s} failed\n`); continue; }
    const lines = (await res.text()).split("\n");
    const h = lines.findIndex((l) => l.startsWith("ZTIME,"));
    if (h < 0) continue;
    const cols = lines[h].trim().split(",");
    for (const line of lines.slice(h + 1)) {
      if (!line.trim()) continue;
      const v = line.trim().split(",");
      const r = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
      const size = parseFloat(r.MAXSIZE), lat = parseFloat(r.LAT), lon = parseFloat(r.LON);
      if (!isFinite(size) || !isFinite(lat) || !isFinite(lon) || size < MIN_SIZE_IN) continue;
      if (!inBbox(lon, lat)) continue;
      raw.push({ t: r.ZTIME, size, lat, lon, src: r.WSR_ID });
    }
    await sleep(250);
  }

  /* Three radars see one storm, so the same cell arrives two or three times a
     minute apart. Collapse by day and ~5km, keeping the largest estimate and
     the radars that saw it — otherwise one hailstorm reads as a dozen separate
     events in a homeowner's results list. */
  const byKey = new Map();
  for (const c of raw) {
    const day = c.t.slice(0, 10);
    const key = cellKey(day, c.lat, c.lon);
    const prev = byKey.get(key);
    if (preferred(c, prev)) {
      byKey.set(key, { ...c, day, srcs: new Set([...(prev?.srcs || []), c.src]) });
    } else prev.srcs.add(c.src);
  }

  /* Fully ordered, so insertion order never leaks into the file. */
  const cells = [...byKey.values()]
    .sort((a, b) =>
      a.day !== b.day ? (a.day < b.day ? 1 : -1)
      : a.lon !== b.lon ? a.lon - b.lon
      : a.lat - b.lat)
    .map((c) => {
      /* Bucket indices travel with the cell. The stored coordinate is the
         survivor detection rounded to 3dp, so a consumer recomputing the
         bucket from it can land on the wrong side of an edge — which is
         exactly the class of bug this ends. */
      const [by, bx] = bucketOf(c.lat, c.lon);
      return [c.day, +c.size.toFixed(2), +c.lon.toFixed(3), +c.lat.toFixed(3), [...c.srcs].sort().join("/"), by, bx];
    });
  return { raw: raw.length, cells };
}

/* ---- MRMS MESH: recent, near-real-time hail (~1km resolution, ~2hr lag) ---

   NOAA Open Data Dissemination mirrors MESH_Max_1440min (a rolling 24-hour
   maximum estimated hail size) as gzipped GRIB2 on S3. Retention up there is
   short — this only ever looks back MESH_LOOKBACK_DAYS, and an empty listing
   for an older day is normal, not a failure. SWDI above is authoritative for
   anything that has aged into its own QC window; this exists purely to cover
   the gap SWDI's lag leaves open, which is why the dedupe pass after both run
   drops an MRMS cell wherever a same-day, same-bucket SWDI cell exists.

   The actual GRIB2 decode is in tools/mesh.mjs / tools/mesh_extract.py — kept
   separate so tools/verify-mesh-fixture.mjs can exercise exactly the same
   decode path against a known hail date without dragging in everything else
   this file does. Run that fixture after touching any of this.

   Requires eccodes (`pip install eccodes`), installed by the workflow — see
   .github/workflows/update-storm-data.yml. Unlike a missing wgrib2 install,
   a missing eccodes is now a hard failure (hadFailure), not a silent skip:
   this file has already been wrong once in a way that looked like "no hail
   today" and was actually "the decoder never ran" (see the PR that added
   this comment), and those two outcomes must never be allowed to look the
   same again — see the storm-index.json mesh block below, and
   showStaleness() in storm-history.js, for the other half of that fix. */
const MESH_LOOKBACK_DAYS = 14;

async function meshRecent() {
  if (!hasEccodes()) {
    hadFailure = true;
    process.stderr.write("  ! eccodes not available — cannot decode MRMS MESH, failing rather than committing a silent zero\n");
    return { cells: [], filesDecoded: 0 };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-"));
  const raw = [];
  let filesDecoded = 0;
  try {
    for (let d = 0; d < MESH_LOOKBACK_DAYS; d++) {
      const day = new Date(END.getTime() - d * 86400000);
      const ymd = day.toISOString().slice(0, 10).replace(/-/g, "");
      const prefix = `CONUS/MESH_Max_1440min_00.50/${ymd}/`;
      const listRes = await get(`https://noaa-mrms-pds.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`);
      if (!listRes) {
        process.stderr.write(`  ! mesh listing ${ymd} failed (treated as aged out, not fatal)\n`);
        continue;
      }
      const keys = [...(await listRes.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      if (!keys.length) continue; // aged out of MRMS's short retention — expected
      const latestKey = keys.sort().pop();
      const fileRes = await get(`https://noaa-mrms-pds.s3.amazonaws.com/${latestKey}`);
      if (!fileRes) { hadFailure = true; process.stderr.write(`  ! mesh fetch ${latestKey} failed\n`); continue; }
      const gribPath = path.join(tmp, "mesh.grib2");
      fs.writeFileSync(gribPath, zlib.gunzipSync(Buffer.from(await fileRes.arrayBuffer())));

      let points;
      try {
        points = extractMesh(gribPath, BBOX);
      } catch (e) {
        hadFailure = true;
        process.stderr.write(`  ! mesh decode failed for ${latestKey}: ${e.message}\n`);
        continue;
      }
      filesDecoded++;
      for (const [lon, lat, mm] of points) {
        if (!isFinite(mm) || mm <= 0) continue;
        const inches = mm / 25.4;
        if (inches < MIN_SIZE_IN || !inBbox(lon, lat)) continue;
        raw.push({ t: day.toISOString().slice(0, 10) + "T12:00:00", size: inches, lat, lon, src: "MRMS" });
      }
      await sleep(250);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* Successfully decoded every file this run touched and found nothing over
     MIN_SIZE_IN — a real, loggable outcome, not the same thing as "the
     decoder was never available" above. Both are visible in the run's
     summary line rather than collapsing into one silent zero. */
  if (filesDecoded > 0 && raw.length === 0) {
    process.stderr.write(`  mesh: decoded ${filesDecoded} file(s), no hail >= ${MIN_SIZE_IN}in in bbox\n`);
  }

  /* Same day+bucket collapse as SWDI's raw detections above, so one storm is
     one cell here too instead of one per underlying MRMS pixel. */
  const byKey = new Map();
  for (const c of raw) {
    const day = c.t.slice(0, 10);
    const key = cellKey(day, c.lat, c.lon);
    if (preferred(c, byKey.get(key))) byKey.set(key, { ...c, day });
  }
  const cells = [...byKey.values()].map((c) => {
    const [by, bx] = bucketOf(c.lat, c.lon);
    return [c.day, +c.size.toFixed(2), +c.lon.toFixed(3), +c.lat.toFixed(3), "MRMS", by, bx];
  });
  return { cells, filesDecoded };
}

/* SWDI is the finalized, QC'd source; MRMS is the live gap-filler ahead of
   it. Wherever both describe the same storm — same day, same ~5km bucket —
   SWDI wins and the MRMS cell is dropped, per the instruction that a live
   estimate should never outrank a settled one once both exist. */
function preferSwdiOverMesh(cells) {
  const byBucket = new Map();
  for (const c of cells) {
    const key = `${c[0]}|${c[5]}|${c[6]}`;
    const isSwdi = c[4] !== "MRMS";
    const prev = byBucket.get(key);
    if (!prev || (isSwdi && prev[4] === "MRMS")) byBucket.set(key, c);
  }
  return [...byBucket.values()];
}

/* ---- reports: Storm Events for history, LSRs for the recent window ------- */

async function stormEvents() {
  const idx = await get("https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/");
  /* Losing this listing silently turns into "zero events for every year" —
     matchAll on an empty string just finds nothing, with no per-year warning
     to catch it. It gets its own explicit failure instead of falling through
     to that. */
  if (!idx) { hadFailure = true; process.stderr.write("  ! reports index listing failed\n"); }
  const listing = idx ? await idx.text() : "";
  const out = [];
  /* Incremental runs only need the years the window touches. Older yearly
     files are large, static, and already in the archive. */
  const first = INCREMENTAL
    ? Number(windowStart.slice(0, 4))
    : END.getUTCFullYear() - YEARS;
  for (let y = first; y <= END.getUTCFullYear(); y++) {
    /* NCEI stamps each file with a _c revision date. Taking the first match in
       HTML listing order would pin us to whichever the directory happened to
       list first — likely the older one, and liable to flip if the listing
       order ever changes.

       Lexical max works because every stamp is the same width (_cYYYYMMDD),
       so string order and date order agree. That holds across all 17 years
       listed today. If NCEI ever changes the stamp format — a different width,
       a suffix, a non-date — this silently picks the wrong file rather than
       failing, so it is worth re-checking if the archive starts looking
       stale. */
    const revisions = [
      ...listing.matchAll(new RegExp(`StormEvents_details-ftp_v1\\.0_d${y}_c\\d+\\.csv\\.gz`, "g")),
    ].map((x) => x[0]).sort();
    if (!revisions.length) continue;
    const file = revisions[revisions.length - 1];
    const res = await get(`https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/${file}`);
    if (!res) { hadFailure = true; process.stderr.write(`  ! reports ${y} (${file}) failed\n`); continue; }
    const text = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    const lines = text.split("\n");
    const cols = parseCsvLine(lines[0]);
    const at = (r, k) => r[cols.indexOf(k)];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const r = parseCsvLine(line);
      const kind = at(r, "EVENT_TYPE");
      if (kind !== "Hail" && kind !== "Thunderstorm Wind") continue;
      const lat = parseFloat(at(r, "BEGIN_LAT")), lon = parseFloat(at(r, "BEGIN_LON"));
      if (!isFinite(lat) || !isFinite(lon) || !inBbox(lon, lat)) continue;
      const mag = parseFloat(at(r, "MAGNITUDE"));
      const isHail = kind === "Hail";
      out.push({
        date: isoDate(at(r, "BEGIN_DATE_TIME")),
        kind: isHail ? "hail" : "wind",
        /* normalised here: Storm Events stores wind in knots */
        val: isFinite(mag) ? +(isHail ? mag : mag * KT_TO_MPH).toFixed(isHail ? 2 : 0) : null,
        lon: +lon.toFixed(4),
        lat: +lat.toFixed(4),
        src: "NWS Storm Events",
      });
    }
    process.stderr.write(`  storm events ${y}: ${out.length} running total\n`);
  }
  return out.filter((r) => r.date);
}

/* Local Storm Reports: the same spotter reports, a day old instead of four
   months. Only used after the newest Storm Events record, so the two can never
   hold the same event. */
async function localStormReports(afterDate) {
  const out = [];
  const start = new Date(afterDate + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() + 1);
  const chunkDays = 90;
  for (let from = new Date(start); from < END; from.setUTCDate(from.getUTCDate() + chunkDays)) {
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + chunkDays);
    const iso = (d) => d.toISOString().slice(0, 19) + "Z";
    const res = await get(
      `https://mesonet.agron.iastate.edu/geojson/lsr.php?sts=${iso(from)}&ets=${iso(to > END ? END : to)}&states=MS,TN,AR`
    );
    if (!res) { hadFailure = true; process.stderr.write(`  ! lsr ${iso(from)} failed\n`); continue; }
    let data;
    try { data = await res.json(); } catch (e) { continue; }
    for (const f of data.features || []) {
      const p = f.properties;
      const lon = parseFloat(p.lon), lat = parseFloat(p.lat);
      if (!isFinite(lon) || !isFinite(lat) || !inBbox(lon, lat)) continue;
      const type = (p.typetext || "").toUpperCase();
      const mag = parseFloat(p.magnitude);
      let kind = null, val = null;
      if (type === "HAIL") {
        kind = "hail";
        val = isFinite(mag) ? +mag.toFixed(2) : null;
      } else if (type === "TSTM WND GST") {
        kind = "wind";
        /* LSR gusts are already MPH — converting again turns 66 into 76. */
        val = isFinite(mag) ? Math.round(mag) : null;
      } else if (type === "TSTM WND DMG" || type === "NON-TSTM WND DMG") {
        /* A real event with no measured gust. Kept, with no number: dropping
           it hides a storm, and showing 0 mph invents a reading. */
        kind = "wind";
        val = null;
      } else continue;
      out.push({
        date: (p.valid || "").slice(0, 10),
        kind, val,
        lon: +lon.toFixed(4),
        lat: +lat.toFixed(4),
        src: "NWS Local Storm Report",
      });
    }
    await sleep(250);
  }
  return out.filter((r) => r.date);
}

/* ---- ground truth: measured, not estimated -------------------------------

   CoCoRaHS and ASOS/AWOS are both genuine observations — a trained volunteer
   with a ruler, a station's anemometer — as opposed to the radar-derived hail
   cells above. They land in the same "reports" array as Storm Events and LSR
   rather than a schema of their own: what tells a reader estimated from
   observed apart is the source label the UI shows, not the file it came
   from, and every ground source belongs together for the address lookup and
   the dedupe pass that follows. */

async function cocorahs(sinceIso) {
  const fmt = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  const start = fmt(new Date(sinceIso + "T00:00:00Z"));
  const end = fmt(END);
  const out = [];
  for (const state of ["TN", "MS", "AR"]) {
    const url = `https://data.cocorahs.org/cocorahs/export/exportreports.aspx?ReportType=Hail&Format=CSV&State=${state}&StartDate=${start}&EndDate=${end}`;
    const res = await get(url);
    if (!res) { hadFailure = true; process.stderr.write(`  ! cocorahs ${state} failed\n`); continue; }
    const lines = (await res.text()).split("\n");
    if (!lines.length || !lines[0].startsWith("ObservationDate")) {
      hadFailure = true;
      process.stderr.write(`  ! cocorahs ${state} returned an unrecognised response\n`);
      continue;
    }
    const cols = parseCsvLine(lines[0]);
    const at = (r, k) => r[cols.indexOf(k)];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const r = parseCsvLine(line);
      const lat = parseFloat(at(r, "Latitude")), lon = parseFloat(at(r, "Longitude"));
      if (!isFinite(lat) || !isFinite(lon) || !inBbox(lon, lat)) continue;
      /* LargestSize, not average — a roof only needs the biggest stone that
         actually fell. "NA" (no stone measured, just reported) parses to NaN
         and is kept the same way an LSR with no magnitude is: the event
         stays, with no invented number. */
      const size = parseFloat(at(r, "LargestSize"));
      out.push({
        date: (at(r, "ObservationDate") || "").trim().slice(0, 10),
        kind: "hail",
        val: isFinite(size) ? +size.toFixed(2) : null,
        lon: +lon.toFixed(4),
        lat: +lat.toFixed(4),
        src: "CoCoRaHS",
      });
    }
    await sleep(250);
  }
  return out.filter((r) => r.date);
}

async function asosStations() {
  const out = [];
  for (const net of ["TN_ASOS", "MS_ASOS", "AR_ASOS"]) {
    const res = await get(`https://mesonet.agron.iastate.edu/geojson/network.php?network=${net}`);
    if (!res) { hadFailure = true; process.stderr.write(`  ! asos network ${net} failed\n`); continue; }
    let j;
    try { j = await res.json(); } catch (e) { hadFailure = true; process.stderr.write(`  ! asos network ${net} unparsable\n`); continue; }
    for (const f of j.features || []) {
      const [lon, lat] = f.geometry.coordinates;
      if (inBbox(lon, lat)) out.push({ id: f.id, lon, lat });
    }
  }
  return out;
}

async function asosGusts(sinceIso) {
  const stations = await asosStations();
  if (!stations.length) return [];
  const start = new Date(sinceIso + "T00:00:00Z");
  const stationParam = stations.map((s) => `station=${s.id}`).join("&");
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${stationParam}` +
    `&data=gust&year1=${start.getUTCFullYear()}&month1=${start.getUTCMonth() + 1}&day1=${start.getUTCDate()}` +
    `&year2=${END.getUTCFullYear()}&month2=${END.getUTCMonth() + 1}&day2=${END.getUTCDate()}` +
    `&tz=Etc%2FUTC&format=onlycomma&latlon=no&missing=empty&trace=empty`;
  const res = await get(url);
  if (!res) { hadFailure = true; process.stderr.write("  ! asos gust query failed\n"); return []; }
  const byStation = new Map(stations.map((s) => [s.id, s]));
  const lines = (await res.text()).split("\n");
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const station = cells[0], valid = cells[1], gust = cells[2];
    /* Most 5-minute obs have no gust at all — that is the normal case, not a
       parse failure, so it is silently skipped rather than counted against
       hadFailure. */
    const kt = parseFloat(gust);
    if (!isFinite(kt)) continue;
    const mph = kt * KT_TO_MPH;
    if (mph < MIN_GUST_MPH) continue;
    const st = byStation.get(station);
    if (!st) continue;
    out.push({
      date: (valid || "").slice(0, 10),
      kind: "wind",
      /* IEM's ASOS service reports gust in knots — confirmed against the raw
         METAR (19018G32KT reads back as gust=32 here, not 37). Same KT_TO_MPH
         conversion as Storm Events, for the same reason: an unconverted
         knots figure reads as a lower, wrong wind speed. */
      val: Math.round(mph),
      lon: +st.lon.toFixed(4),
      lat: +st.lat.toFixed(4),
      src: "ASOS/AWOS",
    });
  }
  return out.filter((r) => r.date);
}

/* ---- NWS warning polygons --------------------------------------------------

   Unlike every other source here, there is no bulk historical feed for this:
   api.weather.gov/alerts only ever answers "what is active right now". The
   only way to build a history from it is to keep asking and remember what it
   said — which is why this polls on its own 4-hourly schedule (see the
   workflow) rather than the daily one, and why the archive this writes to
   (warnings.json, one flat file, not split by year — a decade of Severe
   Thunderstorm and Tornado Warnings for one metro area is a few hundred rows,
   nowhere near hail/reports' volume) is additive: existing records are read
   back and kept, not regenerated, because a warning that has already expired
   can never be re-fetched from "active" again. Point-in-polygon against a
   looked-up address happens client-side in storm-history.js, not here — this
   only has to store the geometry. */
async function nwsWarnings() {
  const res = await get("https://api.weather.gov/alerts/active?area=TN,MS,AR", 3, {
    "User-Agent": "apexexteriorsmidsouth.com storm-history (github.com/alexs6360/apex)",
  });
  if (!res) { hadFailure = true; process.stderr.write("  ! nws alerts failed\n"); return []; }
  let data;
  try { data = await res.json(); } catch (e) { hadFailure = true; process.stderr.write("  ! nws alerts unparsable\n"); return []; }

  const parseLeadingNumber = (s) => {
    const m = /([\d.]+)/.exec(s || "");
    return m ? parseFloat(m[1]) : null;
  };

  /* area=TN,MS,AR is a whole-state filter — Mississippi alone reaches from
     Memphis's latitude down to the Gulf coast, ~450 miles south of this bbox
     — so a real warning near Baton Rouge showed up in testing despite being
     nowhere near the service area. Rectangle overlap against each polygon's
     own bounding box (not a precise intersection, but warning polygons are
     compact enough that it does not matter) is what actually scopes this to
     the bbox everything else here uses. */
  const overlapsBbox = (geometry) => {
    const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const rings of polys) for (const ring of rings) for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return maxLon >= BBOX.minLon && minLon <= BBOX.maxLon && maxLat >= BBOX.minLat && minLat <= BBOX.maxLat;
  };

  const out = [];
  for (const f of data.features || []) {
    const p = f.properties;
    if (p.event !== "Severe Thunderstorm Warning" && p.event !== "Tornado Warning") continue;
    /* Zone-based alerts (no storm-based polygon) cannot be point-in-polygon
       tested and are skipped — current severe/tornado warnings are storm-
       based by NWS policy, so this should be rare. */
    if (!f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) continue;
    if (!overlapsBbox(f.geometry)) continue;
    const params = p.parameters || {};
    const hailIn = parseLeadingNumber((params.maxHailSize || [])[0]);
    const gustMph = parseLeadingNumber((params.maxWindGust || [])[0]);
    out.push({
      id: p.id,
      event: p.event,
      geometry: f.geometry,
      effective: p.effective || p.onset || null,
      expires: p.expires,
      /* Radar-derived, same as MESH and SWDI — NWS forecasters set this from
         the same radar signature, not a ground measurement. Labeled that way
         wherever the page shows it. */
      hail_in_estimated: isFinite(hailIn) ? hailIn : null,
      gust_mph_estimated: isFinite(gustMph) ? gustMph : null,
    });
  }
  return out;
}

function mergeWarnings(fresh) {
  const path = `${OUT}/warnings.json`;
  const existing = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : [];
  const byId = new Map(existing.map((w) => [w.id, w]));
  for (const w of fresh) byId.set(w.id, w);
  return [...byId.values()].sort((a, b) => (a.effective < b.effective ? 1 : -1));
}

/* Belt and braces. Splitting by date should make overlap impossible, but if
   Storm Events ever backfills past its own newest record this stops the same
   storm being listed twice. ~1km, same day, same kind, same value. */
function dedupe(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = [
      r.date, r.kind,
      Math.round(r.lat / 0.01), Math.round(r.lon / 0.01),
      r.val === null ? "null" : r.val,
    ].join("|");
    /* Not first-wins. Nothing collides in the current archive — 1,446 rows,
       1,446 distinct keys — but first-wins is the exact defect that made the
       hail files rewrite themselves every week, and it would wake up the first
       time two spotters report one storm from adjacent addresses. */
    if (preferredReport(r, byKey.get(key))) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/* ---- write, split by year ------------------------------------------------ */

/* Two schedules share this one script — see the workflow. "daily" (09:00
   UTC) runs everything, including the sources that are slow, large, or
   change at most once a day: SWDI's monthly-chunked backfill, Storm Events'
   whole-year gzip files, CoCoRaHS. "frequent" (every 4 hours) runs only what
   is actually time-sensitive — MRMS MESH and the NWS warnings poll, both of
   which would be hours stale by the next morning otherwise — plus the
   already-cheap LSR and ASOS gust pulls, so a storm that hits between daily
   runs still shows up same-day. Defaults to "daily" for a plain local run. */
const MODE = process.env.MODE === "frequent" ? "frequent" : "daily";

/* A frequent run without WINDOW_MONTHS would fall through to mergeWindow's
   non-incremental branch, which returns exactly what was just fetched as the
   WHOLE archive — for a run that deliberately skips Storm Events and
   CoCoRaHS, that means committing over ten years of history with a few
   months of LSR and ASOS. Refusing outright is cheaper than a subtle
   variant of the same "never overwrite good data with an empty result" rule
   this file already enforces elsewhere. */
if (MODE === "frequent" && !INCREMENTAL) {
  console.error("MODE=frequent requires WINDOW_MONTHS to be set — refusing to run a full rebuild with sources deliberately skipped.");
  process.exit(1);
}

const h = await hail();
const meshResult = await meshRecent();
h.cells = preferSwdiOverMesh([...h.cells, ...meshResult.cells]);

const warnings = mergeWarnings(await nwsWarnings());

const se = MODE === "daily" ? await stormEvents() : [];
/* Storm Events did not run this pass — reuse the cutoff the last daily run
   recorded, so LSR/ASOS still know where "recent" starts instead of pulling
   from the beginning of time. */
const priorIndex = fs.existsSync(`${OUT}/storm-index.json`)
  ? JSON.parse(fs.readFileSync(`${OUT}/storm-index.json`, "utf8")) : null;
const seThrough = se.length
  ? se.map((r) => r.date).sort().pop()
  : (priorIndex && priorIndex.wind && priorIndex.wind.storm_events_through) || "1970-01-01";
const lsr = await localStormReports(seThrough);
const asos = await asosGusts(seThrough);
/* CoCoRaHS is cheap enough (a few hundred rows a decade, per state) to pull
   over the same range as everything else on a daily run — full backfill on a
   full build, just the touched window on an incremental one — but there is
   no reason to hit it every four hours along with MESH and warnings. */
const historyStart = INCREMENTAL
  ? windowStart
  : new Date(Date.UTC(END.getUTCFullYear() - YEARS, END.getUTCMonth(), END.getUTCDate()))
      .toISOString().slice(0, 10);
const coco = MODE === "daily" ? await cocorahs(historyStart) : [];
const reports = dedupe([...se, ...lsr, ...coco, ...asos]).sort((a, b) =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1)
  : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1)
  : a.lon !== b.lon ? a.lon - b.lon
  : a.lat !== b.lat ? a.lat - b.lat
  : (a.val || 0) - (b.val || 0));

/* Refuse to write anything if a source came back incomplete. Partial or
   empty output is worse than no output: no output leaves yesterday's commit
   in place, partial output gets committed over it and reads as "nothing
   happened here" to a homeowner it happened to. */
if (hadFailure) {
  console.error(
    "\nOne or more source fetches failed after retries — refusing to write a partial archive."
  );
  process.exit(1);
}

/* Event count already on disk, read before anything here overwrites it, so
   the summary at the end can report how many were actually added by this
   run rather than just the total the archive now holds. */
let existingTotal = 0;
if (fs.existsSync(OUT)) {
  for (const f of fs.readdirSync(OUT)) {
    const m = /^(hail|reports)-\d{4}\.json$/.exec(f);
    if (!m) continue;
    const j = JSON.parse(fs.readFileSync(`${OUT}/${f}`, "utf8"));
    existingTotal += (j.cells || j.reports || []).length;
  }
}

fs.mkdirSync(OUT, { recursive: true });

/* Merge an incremental window into what is already committed.

   Days inside the window are dropped from the existing archive and replaced by
   what was just fetched; days outside are carried through untouched. Records
   are keyed by day and deduped per day, so this cannot leave a day half from
   one run and half from another.

   The comparators mirror the full-build sorts exactly — hail by day desc then
   lon, lat; reports by day desc then kind, lon, lat, val — so a merged file
   sorts identically to a rebuilt one. verify-incremental.mjs enforces that. */
function mergeWindow(freshCells, freshReports, preserveSrcs) {
  if (!INCREMENTAL) return { cells: freshCells, reports: freshReports };

  const keptCells = [];
  const keptReports = [];
  for (const f of fs.readdirSync(OUT)) {
    const m = /^(hail|reports)-(\d{4})\.json$/.exec(f);
    if (!m) continue;
    const j = JSON.parse(fs.readFileSync(`${OUT}/${f}`, "utf8"));
    if (m[1] === "hail") {
      for (const c of j.cells) if (c[0] < windowStart) keptCells.push(c);
    } else {
      for (const r of j.reports) {
        /* Window-replace assumes every source was just refetched, which is
           true on a daily run but not a frequent one — that skips Storm
           Events and CoCoRaHS entirely (see MODE above). Without this, a
           frequent run would drop those sources' already-merged records for
           the window and never put them back, since it never refetches them
           itself. preserveSrcs keeps them regardless of date on any run
           that didn't just refetch them. */
        if (r[0] < windowStart || (preserveSrcs && preserveSrcs.has(r[5]))) {
          keptReports.push({ date: r[0], kind: r[1], val: r[2], lon: r[3], lat: r[4], src: r[5] });
        }
      }
    }
  }

  /* The window is authoritative for dates inside it and the archive for dates
     outside — so BOTH sides are filtered on the same boundary. Storm Events is
     fetched a whole year at a time, so a fresh pull carries records from
     before the window that the archive already holds; without this filter they
     arrive twice and the file doubles. */
  const inWindow = (d) => d >= windowStart;
  freshCells = freshCells.filter((c) => inWindow(c[0]));
  freshReports = freshReports.filter((r) => inWindow(r.date));

  const cells = keptCells.concat(freshCells).sort((a, b) =>
    a[0] !== b[0] ? (a[0] < b[0] ? 1 : -1)
    : a[2] !== b[2] ? a[2] - b[2]
    : a[3] - b[3]);

  const merged = keptReports.concat(freshReports).sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1)
    : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1)
    : a.lon !== b.lon ? a.lon - b.lon
    : a.lat !== b.lat ? a.lat - b.lat
    : (a.val || 0) - (b.val || 0));

  return { cells: cells, reports: merged };
}

const preserveSrcs = MODE === "frequent" ? new Set(["NWS Storm Events", "CoCoRaHS"]) : null;
const mergedData = mergeWindow(h.cells, reports, preserveSrcs);
h.cells = mergedData.cells;
const allReports = mergedData.reports;

const years = new Set();
const byYear = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const y = key(r).slice(0, 4);
    years.add(y);
    if (!m.has(y)) m.set(y, []);
    m.get(y).push(r);
  }
  return m;
};

const hailYears = byYear(h.cells, (c) => c[0]);
const repYears = byYear(allReports, (r) => r.date);

let totalRaw = 0, totalGz = 0;
const write = (name, obj) => {
  const s = JSON.stringify(obj);
  fs.writeFileSync(`${OUT}/${name}`, s);
  totalRaw += s.length;
  totalGz += zlib.gzipSync(Buffer.from(s)).length;
};

for (const y of [...years].sort()) {
  write(`hail-${y}.json`, { fields: ["date", "in", "lon", "lat", "radar", "by", "bx"], cells: hailYears.get(y) || [] });
  write(`reports-${y}.json`, { fields: ["date", "kind", "val", "lon", "lat", "src"],
    reports: (repYears.get(y) || []).map((r) => [r.date, r.kind, r.val, r.lon, r.lat, r.src]) });
}

/* Not split by year — see the comment above nwsWarnings(). */
write("warnings.json", warnings);

/* Currency is per layer and computed from the data, not from the clock: a
   homeowner should never read "no wind" when the truth is "no wind data that
   recent". */
const hailThrough = h.cells.length ? h.cells[0][0] : null;
const windRows = allReports.filter((r) => r.kind === "wind");
const windThrough = windRows.length ? windRows[0].date : null;

/* No build timestamp here. It changed on every run whether or not any storm
   data did, which defeated the workflow's "commit only if something changed"
   guard and produced a commit every week regardless. Currency comes from the
   newest record in each layer instead — which is what a reader actually wants
   to know. */
write("storm-index.json", {
  years: [...years].sort(),
  buffer_km: BUFFER_KM,
  min_size_in: MIN_SIZE_IN,
  grid_deg: GRID_DEG,
  bbox: BBOX,
  hail: {
    through: hailThrough,
    source: "NOAA NCEI SWDI (NEXRAD Level-III, radar-estimated) + NOAA MRMS MESH (recent, radar-estimated)",
    cells: h.cells.length,
    mesh_cells: h.cells.filter((c) => c[4] === "MRMS").length,
  },
  wind: {
    through: windThrough,
    source: "NWS Storm Events, Local Storm Reports, and ASOS/AWOS (all observed)",
    storm_events_through: seThrough,
    reports: windRows.length,
  },
  ground_truth: {
    source: "CoCoRaHS (observed hail) and ASOS/AWOS (observed gusts)",
    reports: allReports.filter((r) => r.src === "CoCoRaHS" || r.src === "ASOS/AWOS").length,
  },
  warnings: {
    source: "NWS active alerts (api.weather.gov), polled every 4 hours since this system went live",
    count: warnings.length,
  },
  mesh: {
    /* Date, not a full timestamp — a timestamp would change on every run
       whether or not MESH found anything, which is the exact bug the "no
       build timestamp" comment above already fixed once for this file, and
       would reintroduce it via this field instead. Date-level granularity
       is what every other *_through field here already uses, and is more
       than enough precision for a "has this been broken for a day" check —
       see showStaleness() in storm-history.js, which is the only consumer.
       Reaching this write at all means MESH did not fail this run (a
       failure exits before any file is written — see the hadFailure guard
       above), so this is simply "today" every time execution gets here. */
    last_success: END.toISOString().slice(0, 10),
    files_decoded_last_run: meshResult.filesDecoded,
  },
});

console.log(`\n  hail:    ${h.raw} raw SWDI detections + ${meshResult.cells.length} MRMS cells (${meshResult.filesDecoded} files decoded) >= ${MIN_SIZE_IN}in -> ${h.cells.length} cells, through ${hailThrough}`);
console.log(`  reports: ${se.length} Storm Events (through ${seThrough}) + ${lsr.length} LSRs + ${coco.length} CoCoRaHS + ${asos.length} ASOS gusts -> ${reports.length} after dedupe`);
console.log(`  wind current through ${windThrough}`);
console.log(`  warnings: ${warnings.length} in archive (${MODE} run)`);
console.log(`  ${[...years].length * 2 + 2} files, ${(totalRaw / 1024).toFixed(0)} KB raw, ${(totalGz / 1024).toFixed(0)} KB gzipped`);

const newTotal = h.cells.length + allReports.length;
console.log(`  events added this run: ${newTotal - existingTotal} (${existingTotal} -> ${newTotal})`);
