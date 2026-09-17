/* NWS Local Storm Report parsing — pulled out of build-storm-data.mjs so
   verify-wind-fixture.mjs can exercise the exact same parsing logic
   production uses against a known-good date, the same way mesh.mjs's
   extractMesh() is shared with verify-mesh-fixture.mjs. Everything here is
   pure (a GeoJSON feature in, a normalized record or null out) — no
   network, no retry, no module-level mutable state — so it can be called
   from either build-storm-data.mjs's fetch loop or a standalone fixture
   without dragging in hadFailure, get(), or anything else that assumes it's
   running inside the full build.
*/

export const inBbox = (lon, lat, bbox) =>
  lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;

/* One raw LSR GeoJSON feature -> one normalized {date, kind, val, lon, lat,
   src} record, or null if it's outside the bbox or not a type this site
   tracks (hail or wind). Mirrors the filtering/normalizing localStormReports()
   used to do inline before this was extracted — behavior is unchanged, just
   now callable in isolation. */
export function parseLsrFeature(feature, bbox) {
  const p = feature.properties || {};
  const lon = parseFloat(p.lon), lat = parseFloat(p.lat);
  if (!isFinite(lon) || !isFinite(lat) || !inBbox(lon, lat, bbox)) return null;

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
    /* A real event with no measured gust. Kept, with no number: dropping it
       hides a storm, and showing 0 mph invents a reading. */
    kind = "wind";
    val = null;
  } else {
    return null;
  }

  return {
    date: (p.valid || "").slice(0, 10),
    kind, val,
    lon: +lon.toFixed(4),
    lat: +lat.toFixed(4),
    src: "NWS Local Storm Report",
  };
}
