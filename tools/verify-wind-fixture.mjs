/* Regression fixture for LSR wind parsing, parallel to
   verify-mesh-fixture.mjs.

   2026-08-22 is a confirmed wind report in the bbox: a 60 mph "TSTM WND GST"
   Local Storm Report at -89.98,35.05 (verified live against IEM's LSR feed
   while investigating why wind.through was sitting well behind hail.through
   — see the wind.last_success field this same change added). This fetches
   that day directly from IEM and runs the response through the exact same
   parseLsrFeature() the production ingest uses (see tools/lsr.mjs), so a
   change to the parsing logic — or IEM changing its response shape — breaks
   this instead of quietly returning zero records forever, which is exactly
   the failure mode wind.last_success alone cannot catch: a fetch that
   completes without error but can no longer find anything still updates
   last_success every run.

   Run this after any change to parseLsrFeature(), localStormReports(), or
   tools/lsr.mjs:

     node tools/verify-wind-fixture.mjs
*/
import { parseLsrFeature } from "./lsr.mjs";

const FIXTURE_URL =
  "https://mesonet.agron.iastate.edu/geojson/lsr.php?sts=2026-08-22T00:00:00Z&ets=2026-08-23T00:00:00Z&states=MS,TN,AR";
const BBOX = { minLon: -90.8, minLat: 34.4, maxLon: -89.0, maxLat: 35.6 };
/* Confirmed live: a 60 mph gust LSR at -89.98,35.05 on 2026-08-22. Matched
   with a small lon/lat tolerance rather than exact equality — IEM's own
   published coordinate for a station/spotter report has occasionally
   shifted by a thousandth of a degree between queries in the past, which is
   not the kind of drift this fixture exists to catch. */
const EXPECTED = { date: "2026-08-22", kind: "wind", val: 60, lon: -89.98, lat: 35.05 };
const COORD_TOLERANCE = 0.01;

async function main() {
  console.log(`Fetching fixture: ${FIXTURE_URL}`);
  const res = await fetch(FIXTURE_URL);
  if (!res.ok) {
    console.error(`FAIL: fixture fetch returned ${res.status} — IEM's LSR archive for this date may be unavailable`);
    process.exit(1);
  }

  const data = await res.json();
  const parsed = (data.features || [])
    .map((f) => parseLsrFeature(f, BBOX))
    .filter(Boolean);
  console.log(`Parsed ${parsed.length} in-bbox hail/wind LSR(s) for ${EXPECTED.date}`);

  const match = parsed.find((r) =>
    r.date === EXPECTED.date &&
    r.kind === EXPECTED.kind &&
    r.val === EXPECTED.val &&
    Math.abs(r.lon - EXPECTED.lon) < COORD_TOLERANCE &&
    Math.abs(r.lat - EXPECTED.lat) < COORD_TOLERANCE
  );

  if (!match) {
    console.error(
      `FAIL: expected a ${EXPECTED.val} mph wind report near ${EXPECTED.lon},${EXPECTED.lat} ` +
      `on ${EXPECTED.date}, not found in the parsed output.`
    );
    console.error("Records parsed:", JSON.stringify(parsed, null, 1));
    process.exit(1);
  }
  console.log(`PASS: found ${match.val} mph wind report at ${match.lon},${match.lat}`);
}

main();
