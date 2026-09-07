#!/usr/bin/env python3
"""Extract MESH hail-size grid points within a bbox from a GRIB2 file.

Shelled out to from tools/build-storm-data.mjs's meshRecent(), which used to
shell out to wgrib2 and parse its -csv text output — a format that could not
be pinned down without a real wgrib2 install to test against. This does the
decode with eccodes' Python bindings instead, which install cleanly via
`pip install eccodes` (a self-contained wheel, no separate C library to find
on PATH) and were used to derive and verify every assumption below against a
real file.

Verified against MRMS_MESH_Max_1440min_00.50_20250402-233000.grib2.gz — the
last file of 2025-04-02, a day with a confirmed 2.75in Storm Events hail
report over Shelby/DeSoto County (see tools/verify-mesh-fixture.mjs). That
file's bbox-wide max came back 2.50in, in line with the ground report. Grid
layout (regular lat/lon, scanningMode 0: origin at the northwest corner, +i
east, -j south) was read from that file's own metadata, not assumed — a
different scanningMode on some future file is refused rather than silently
mismapped (see below).

Usage: mesh_extract.py <grib2-path> <minLon> <minLat> <maxLon> <maxLat>
Output: newline-delimited JSON, one [lon, lat, value_mm] triple per line, for
every non-missing grid point inside the bbox. No stdout output means the
bbox had no data in this file (a legitimate outcome — see the point count
logged to stderr to tell that apart from a real failure).
"""
import sys
import json

try:
    import eccodes as ec
except ImportError:
    print("eccodes not installed", file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) != 6:
        print("usage: mesh_extract.py <grib2-path> <minLon> <minLat> <maxLon> <maxLat>", file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    min_lon, min_lat, max_lon, max_lat = (float(x) for x in sys.argv[2:6])

    with open(path, "rb") as f:
        gid = ec.codes_grib_new_from_file(f)
        if gid is None:
            print("no GRIB message found in file", file=sys.stderr)
            sys.exit(1)
        try:
            ni = ec.codes_get(gid, "Ni")
            nj = ec.codes_get(gid, "Nj")
            lat0 = ec.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
            lon0 = ec.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
            di = ec.codes_get(gid, "iDirectionIncrementInDegrees")
            dj = ec.codes_get(gid, "jDirectionIncrementInDegrees")
            missing = ec.codes_get(gid, "missingValue")
            scanning_mode = ec.codes_get(gid, "scanningMode")
            if scanning_mode != 0:
                print(
                    f"unexpected scanningMode {scanning_mode} (verified against 0 only) "
                    "-- refusing to guess grid layout",
                    file=sys.stderr,
                )
                sys.exit(1)
            values = ec.codes_get_values(gid)
        finally:
            ec.codes_release(gid)

    def i_of(lon):
        return round(((lon % 360) - lon0) / di)

    def j_of(lat):
        return round((lat0 - lat) / dj)

    i_min, i_max = sorted((i_of(min_lon), i_of(max_lon)))
    j_min, j_max = sorted((j_of(max_lat), j_of(min_lat)))
    i_min, i_max = max(i_min, 0), min(i_max, ni - 1)
    j_min, j_max = max(j_min, 0), min(j_max, nj - 1)

    count = 0
    for j in range(j_min, j_max + 1):
        row_offset = j * ni
        lat = lat0 - j * dj
        for i in range(i_min, i_max + 1):
            v = values[row_offset + i]
            if v >= missing or v < 0:
                continue
            lon = lon0 + i * di
            if lon > 180:
                lon -= 360
            print(json.dumps([round(lon, 4), round(lat, 4), v]))
            count += 1
    print(f"{count} points extracted", file=sys.stderr)


if __name__ == "__main__":
    main()
