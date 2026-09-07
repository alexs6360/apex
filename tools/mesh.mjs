/* MRMS MESH GRIB2 decoding — the one piece of the storm-data pipeline that
   needs a real binary dependency, split out so it can be imported cleanly by
   both tools/build-storm-data.mjs (production) and
   tools/verify-mesh-fixture.mjs (the regression fixture), without either one
   dragging in the other's top-level side effects.

   Shells out to tools/mesh_extract.py, which does the actual decode with
   eccodes' Python bindings (`pip install eccodes` — a self-contained wheel,
   no separate C library to hunt for on PATH). See that file's docstring for
   how the grid math was derived and verified against a real file. */
import { execFileSync } from "node:child_process";

export function hasEccodes() {
  try {
    execFileSync("python3", ["-c", "import eccodes"], { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

/* Returns [[lon, lat, value_mm], ...] for every non-missing point inside
   bbox. Throws on any decode failure — including "python3 not found" and
   "eccodes not installed" — so the caller's own error handling decides what
   a failed decode means, rather than this function guessing. */
export function extractMesh(gribPath, bbox) {
  const out = execFileSync(
    "python3",
    ["tools/mesh_extract.py", gribPath, bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].map(String),
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 64 }
  );
  const points = [];
  for (const line of out.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    points.push(JSON.parse(line));
  }
  return points;
}
