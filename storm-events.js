/* Address-event matching and summarizing, shared by every page that turns a
   coordinate into a storm history: the full storm-history.js lookup today,
   the homepage radar widget next.

   Extracted from storm-history.js so a second surface doesn't re-derive — or
   worse, quietly re-tune — logic that already has to be right. Behaviour is
   unchanged; this is a move, not a rewrite. Grid maths (bucketOf/GRID_DEG/
   cellKey) lives here too, moved out of storm-grid.js: that file is 625 lines
   of shape-fitting only the big interactive map needs, and a page that only
   wants to know which cell an address falls in should not have to load it.
   storm-grid.js imports these three back from window.StormEvents so its own
   existing callers (window.StormGrid.bucketOf, etc.) keep working untouched. */

/* ---- grid --------------------------------------------------------------- */

var GRID_DEG = 0.05;   // ~5km: three radars see one storm and report
                              // it two or three times a minute apart

/* The bucket a coordinate falls in, as [latIndex, lonIndex]. */
function bucketOf(lat, lon) {
  return [Math.round(lat / GRID_DEG), Math.round(lon / GRID_DEG)];
}

/* A detection's cell is a function of its own raw coordinate and nothing else. */
function cellKey(day, lat, lon) {
  var b = bucketOf(lat, lon);
  return day + "|" + b[0] + "|" + b[1];
}

/* ---- geometry ------------------------------------------------------------ */

function distanceKm(aLon, aLat, bLon, bLat) {
  var R = 6371;
  var dLat = ((bLat - aLat) * Math.PI) / 180;
  var dLon = ((bLon - aLon) * Math.PI) / 180;
  var la1 = (aLat * Math.PI) / 180;
  var la2 = (bLat * Math.PI) / 180;
  var h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* "2.3 mi NE" beats "nearby": it tells a homeowner whether to walk outside
   and look, or to stop reading. */
function bearingFrom(lon, lat, toLon, toLat) {
  var dLon = ((toLon - lon) * Math.PI) / 180;
  var la1 = (lat * Math.PI) / 180;
  var la2 = (toLat * Math.PI) / 180;
  var y = Math.sin(dLon) * Math.cos(la2);
  var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  var deg = (Math.atan2(y, x) * 180) / Math.PI;
  var names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(((deg + 360) % 360) / 45) % 8];
}

function awayFrom(lon, lat, toLon, toLat) {
  var miles = distanceKm(lon, lat, toLon, toLat) * 0.621371;
  return miles.toFixed(1) + " mi " + bearingFrom(lon, lat, toLon, toLat);
}

/* Standard ray-casting, one ring at a time. NWS warning polygons come as
   GeoJSON [lon, lat] rings. */
function pointInRing(x, y, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1];
    var xj = ring[j][0], yj = ring[j][1];
    var intersect = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  var polys = geometry.type === "Polygon" ? [geometry.coordinates]
    : geometry.type === "MultiPolygon" ? geometry.coordinates
    : [];
  for (var p = 0; p < polys.length; p++) {
    var rings = polys[p];
    if (!rings.length || !pointInRing(lon, lat, rings[0])) continue;
    var inHole = false;
    for (var h = 1; h < rings.length; h++) {
      if (pointInRing(lon, lat, rings[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/* ---- dates ---------------------------------------------------------------- */

function prettyDate(iso) {
  var d = new Date(iso.length > 10 ? iso : iso + "T12:00:00Z");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso + "T00:00:00Z").getTime()) / 86400000);
}

/* ---- matching and summarizing --------------------------------------------- */

function fmtIn(n) {
  return n.toFixed(2).replace(/0$/, "");
}

/* A radar hail cell is a storm-scale detection, not a damage footprint. The
   default radius is the same 5km the generator buffers hail/wind matching
   to everywhere else — pass a different one only to answer a genuinely
   different question. */
var REPORT_RADIUS_KM = 5;

/* Every record within radiusKm of (lon, lat), hail/wind/warnings combined,
   newest first. addrBucket, hail, reports and warnings are the caller's own
   loaded data — this function touches no DOM and no module-level state, so
   any page with a coordinate and the three data sets can call it. */
function eventsAt(lon, lat, addrBucket, hail, reports, warnings, radiusKm) {
  var radius = radiusKm || REPORT_RADIUS_KM;
  var out = [];

  /* Radar-estimated vs. observed, everywhere a number shows up: MESH runs
     high against a ruler, and an adjuster's own measurement is what a claim
     actually turns on. Raw fields (kind/size/val/here/away), not a pre-built
     label — grouping by date needs to compare and recombine these across
     records, and a baked-in sentence can't be un-said to build a different
     one. */
  hail.cells.forEach(function (c) {
    /* Containment, not proximity. A cell is ~5.6 x 4.6km, so its centroid
       can sit 3.6km from an address the cell still covers. Indices come
       from the file; nothing is recomputed here. */
    var here = addrBucket && c[5] === addrBucket[0] && c[6] === addrBucket[1];
    var near = !here && distanceKm(lon, lat, c[2], c[3]) <= radius;
    if (!here && !near) return;
    var isMesh = c[4] === "MRMS";
    out.push({
      date: c[0],
      kind: "hail",
      estimated: true,
      here: !!here,
      size: c[1],
      lon: c[2],
      lat: c[3],
      /* The cell's own center (from its bucket indices, not the reported
         radar centroid) — the honest position to plot a detection at. The
         centroid can sit anywhere inside its ~5.6 x 4.6km cell; the cell
         is the actual resolution the data supports, same reasoning
         hailBands() already applies when drawing the map envelope. Not
         used for the away-distance text above, which stays tied to the
         real detection point. */
      cellLon: c[6] * GRID_DEG,
      cellLat: c[5] * GRID_DEG,
      away: here ? null : awayFrom(lon, lat, c[2], c[3]),
      source: isMesh ? "NOAA MRMS MESH" : "NEXRAD radar" + (c[4] ? " (" + c[4] + ")" : ""),
    });
  });

  reports.features.forEach(function (f) {
    var g = f.geometry.coordinates;
    if (distanceKm(lon, lat, g[0], g[1]) > radius) return;
    var p = f.properties;
    /* CoCoRaHS and ASOS/AWOS are ground truth same as Storm Events and LSR
       — a volunteer's ruler, a station's anemometer. Reports never get a
       "here" containment test the way hail cells do — distance is all there
       is for a point report, so every one of these is "nearby", never "in
       your area". */
    out.push({
      date: (p.date || "").slice(0, 10),
      kind: p.kind,
      estimated: false,
      here: false,
      /* Already mph for wind — the generator normalises Storm Events' and
         ASOS's knots, so converting again here would turn 66 into 76. */
      val: p.kind === "hail" || p.val ? p.val : null,
      lon: g[0],
      lat: g[1],
      away: awayFrom(lon, lat, g[0], g[1]),
      source: p.src,
    });
  });

  /* Point-in-polygon, not proximity: an address is either inside the storm-
     based polygon a Severe Thunderstorm or Tornado Warning was issued for,
     or it is not. Kept as a fully-built label, not structured fields like
     the above — a warning is a forecaster's judgment call at a point in
     time, not a magnitude to merge with a radar cell or a ground report. */
  (warnings || []).forEach(function (w) {
    if (!pointInGeometry(lon, lat, w.geometry)) return;
    var bits = [];
    if (w.hail_in_estimated) bits.push(w.hail_in_estimated.toFixed(2).replace(/0$/, "") + '" hail');
    if (w.gust_mph_estimated) bits.push(w.gust_mph_estimated + " mph gusts");
    out.push({
      date: (w.effective || w.expires || "").slice(0, 10),
      kind: "warning",
      label: "Address was inside a " + w.event + " polygon" +
        (bits.length ? " — forecaster estimate at issuance: " + bits.join(", ") + " (radar estimate)" : ""),
      source: "NWS active alerts",
      here: true,
      estimated: true,
      lon: lon,
      lat: lat,
    });
  });

  out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  return out;
}

/* A winner picked from a pool of one keeps its own precise distance. A
   winner picked from a pool of more than one gets genericised to "nearby"
   instead: its specific bearing belonged to only that record, and the
   others that day were at other, different distances. Never applies to
   "here", which never carried a distance to begin with. */
function awayFor(record, poolSize) {
  if (record.here) return "in your area";
  return poolSize > 1 ? "nearby" : record.away;
}

function hailClause(cells, reports) {
  if (!cells.length && !reports.length) return null;
  var bestReport = reports.length
    ? reports.slice().sort(function (a, b) { return (b.val || 0) - (a.val || 0); })[0]
    : null;
  var bestCell = cells.length
    ? (cells.filter(function (c) { return c.here; })[0] ||
       cells.slice().sort(function (a, b) { return b.size - a.size; })[0])
    : null;

  /* pos: where this clause's dot belongs — the record actually driving the
     label. Observed beats estimated here same as the label itself does;
     an estimated-only day falls back to the cell's own center (see
     eventsAt's cellLon/cellLat), never the raw radar centroid. Consulted
     by the homepage radar only when the merged row isn't "here" — a row
     at the address's own cell renders at the panel center regardless. */
  if (bestReport && bestCell) {
    var reportPart = (bestReport.val ? bestReport.val + '" ' : "") +
      "hail observed " + awayFor(bestReport, reports.length);
    var cellPart = "with radar estimating up to " + fmtIn(bestCell.size) + '" ' +
      awayFor(bestCell, cells.length);
    return {
      label: reportPart + ", " + cellPart,
      source: bestReport.source + " + " + bestCell.source,
      pos: { lon: bestReport.lon, lat: bestReport.lat },
    };
  }
  if (bestReport) {
    return {
      label: (bestReport.val ? bestReport.val + '" ' : "") +
        "hail observed " + awayFor(bestReport, reports.length),
      source: bestReport.source,
      pos: { lon: bestReport.lon, lat: bestReport.lat },
    };
  }
  return {
    label: fmtIn(bestCell.size) + '" hail (radar estimate) ' + awayFor(bestCell, cells.length),
    source: bestCell.source,
    pos: { lon: bestCell.cellLon, lat: bestCell.cellLat },
  };
}

function windClause(reports) {
  if (!reports.length) return null;
  /* No radar estimate exists for wind in this system — every wind record is
     already observed, so this is the same "pick the strongest, reuse its
     own wording, drop the count" rule as a radar-only hail day. */
  var withVal = reports.filter(function (r) { return r.val; });
  var pool = withVal.length ? withVal : reports;
  var best = pool.slice().sort(function (a, b) { return (b.val || 0) - (a.val || 0); })[0];
  return {
    label: best.val
      ? best.val + " mph gust observed " + awayFor(best, pool.length)
      : "wind damage observed " + awayFor(best, pool.length),
    source: best.source,
    pos: { lon: best.lon, lat: best.lat },
  };
}

function summarizeDate(dateEvents) {
  var warningRows = dateEvents
    .filter(function (e) { return e.kind === "warning"; })
    .map(function (w) { return { label: w.label, source: w.source, here: w.here, lon: w.lon, lat: w.lat }; });

  var cells = dateEvents.filter(function (e) { return e.kind === "hail" && e.estimated; });
  var hailReports = dateEvents.filter(function (e) { return e.kind === "hail" && !e.estimated; });
  var windReports = dateEvents.filter(function (e) { return e.kind === "wind"; });

  var parts = [];
  var hail = hailClause(cells, hailReports);
  if (hail) parts.push(hail);
  var wind = windClause(windReports);
  if (wind) parts.push(wind);

  /* One dot per row: hail leads (it's listed first in parts whenever both
     occur), wind's position only matters on a wind-only day. */
  var pos = hail ? hail.pos : (wind ? wind.pos : null);

  var hazardRow = parts.length
    ? {
        label: parts.map(function (p) { return p.label; }).join("; "),
        source: parts.map(function (p) { return p.source; }).join(" + "),
        here: cells.some(function (c) { return c.here; }),
        lon: pos && pos.lon,
        lat: pos && pos.lat,
      }
    : null;

  return hazardRow ? [hazardRow].concat(warningRows) : warningRows;
}

/* One row per storm day, not per underlying record — four radar cells
   covering one address on one day are one storm, not four rows. */
function groupByDate(events) {
  var order = [];
  var byDate = {};
  events.forEach(function (e) {
    if (!byDate[e.date]) { byDate[e.date] = []; order.push(e.date); }
    byDate[e.date].push(e);
  });
  var rows = [];
  order.forEach(function (date) {
    summarizeDate(byDate[date]).forEach(function (row) {
      row.date = date;
      rows.push(row);
    });
  });
  return rows;
}

window.StormEvents = {
  GRID_DEG: GRID_DEG,
  bucketOf: bucketOf,
  cellKey: cellKey,
  distanceKm: distanceKm,
  bearingFrom: bearingFrom,
  awayFrom: awayFrom,
  pointInRing: pointInRing,
  pointInGeometry: pointInGeometry,
  prettyDate: prettyDate,
  daysSince: daysSince,
  fmtIn: fmtIn,
  REPORT_RADIUS_KM: REPORT_RADIUS_KM,
  eventsAt: eventsAt,
  awayFor: awayFor,
  hailClause: hailClause,
  windClause: windClause,
  summarizeDate: summarizeDate,
  groupByDate: groupByDate,
};
