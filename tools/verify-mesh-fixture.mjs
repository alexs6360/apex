/* Regression fixture for MRMS MESH decoding.

   2025-04-02 is a confirmed hail day over Shelby/DeSoto County: Storm Events
   has a 2.75in report at -90.26,35.38 (see data/reports-2025.json). This
   fetches that day's last MESH file straight from NODD, decodes it, and
   checks the bbox-wide max comes back close to that report — verified once
   by hand at 2.50in (see tools/mesh_extract.py's docstring and
   MESH_EXPECTED_MIN_IN below).

   Run this after any change to meshRecent(), mesh_extract.py, or the
   eccodes setup in the workflow — a change that breaks decoding should
   break this, not surface for the first time in production three weeks
   from now.

     node tools/verify-mesh-fixture.mjs
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { extractMesh, hasEccodes } from "./mesh.mjs";

const FIXTURE_URL =
  "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_Max_1440min_00.50/20250402/MRMS_MESH_Max_1440min_00.50_20250402-233000.grib2.gz";
const BBOX = { minLon: -90.8, minLat: 34.4, maxLon: -89.0, maxLat: 35.6 };
/* Confirmed report was 2.75in; MESH is a radar estimate and is not expected
   to match a ground report exactly (2.50in on the one hand-verified run) —
   this just needs to be clearly in the same storm, not an exact match. A
   regression that zeroes out the decode, or one that mis-maps the grid
   entirely, will miss this by more than a rounding error. */
const MESH_EXPECTED_MIN_IN = 2.0;

async function main() {
  console.log(`Fetching fixture: ${FIXTURE_URL}`);
  const res = await fetch(FIXTURE_URL);
  if (!res.ok) {
    console.error(`FAIL: fixture fetch returned ${res.status} — NODD retention for this date may have lapsed`);
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-fixture-"));
  const gribPath = path.join(tmp, "fixture.grib2");
  fs.writeFileSync(gribPath, zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));

  if (!hasEccodes()) {
    console.error("FAIL: eccodes not available (pip install eccodes) — cannot verify decoding");
    process.exit(1);
  }
  const points = extractMesh(gribPath, BBOX);
  const maxIn = points.length ? Math.max(...points.map((p) => p[2])) / 25.4 : 0;
  console.log(`Extracted ${points.length} points, bbox max ${maxIn.toFixed(2)}in`);

  fs.rmSync(tmp, { recursive: true, force: true });

  if (maxIn < MESH_EXPECTED_MIN_IN) {
    console.error(`FAIL: expected >= ${MESH_EXPECTED_MIN_IN}in on this known hail date, got ${maxIn.toFixed(2)}in`);
    process.exit(1);
  }
  console.log("PASS");
}

main();
