#!/usr/bin/env python3
"""Generates images/storm-radar-basemap.jpg: the static Mapbox basemap
behind the homepage radar panel's dots.

Run by hand (like tools/build-radar-points.mjs) — the pre-search view
never changes per visitor, so this bakes one image at build time instead
of loading Mapbox GL JS on every homepage load. Needs MAPBOX_TOKEN
(source .env.local) and Pillow + numpy (pip install pillow numpy).

The hard requirement this exists to satisfy: the image's visible extent
must exactly equal the bbox script.js positions dots against (bucket
positioning: left = (lon-minLon)/lonSpan*100%, top = (maxLat-lat)/latSpan
*100%), stretched to the panel's own 74:43 shape — not whatever
rectangle Mapbox's own bbox-fit would naturally choose. Those are
different things: Mapbox's bbox array endpoint fits the whole bbox
inside the requested image preserving true aspect ratio (padding
whichever axis doesn't need it), which is not the same non-uniform
stretch the dots use. A single Mapbox center+zoom request also can't
produce that stretch directly — Mercator is isotropic (one scale in both
directions); the dots' positioning isn't (lonSpan and latSpan are
stretched independently to fill a 74:43 rectangle regardless of their
true geographic proportions).

So instead of asking Mapbox for the final shape directly: fetch a
generously-padded, square-ish source image at a center/zoom this script
computes (not eyeballed), then resample it pixel-by-pixel into the
output canvas using the *exact same* lon/lat -> fraction formula
script.js uses, inverted. Every output pixel's geographic coordinate is
computed the way a dot at that position would be; this script just asks
"what does Mapbox show there" and samples it. That makes the two
mathematically consistent by construction, not by matching parameters
and hoping — the one approximation left is Mercator's own latitude
curvature inside the small padded source region (checked separately:
well under a pixel across this bbox's full span, see chat).
"""
import json
import math
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

index = json.loads((ROOT / "data" / "storm-index.json").read_text())
bbox = index["bbox"]
MIN_LON, MIN_LAT = bbox["minLon"], bbox["minLat"]
MAX_LON, MAX_LAT = bbox["maxLon"], bbox["maxLat"]

# .storm-radar-panel's aspect-ratio in styles.css — keep in sync if that changes.
PANEL_W_UNITS, PANEL_H_UNITS = 74, 43
OUT_W = 1480  # 2x the Figma 740x430 reference, for a sharp background at any panel size up to that
OUT_H = round(OUT_W * PANEL_H_UNITS / PANEL_W_UNITS)

STYLE = "dark-v11"
TOKEN = os.environ.get("MAPBOX_TOKEN")
if not TOKEN:
    sys.exit("MAPBOX_TOKEN not set — source .env.local first.")
# This token is referer-restricted to the production domain (confirmed: a
# bare curl gets 403, this header gets 200) — same token the browser map
# already uses from that domain, just supplied server-side here.
REFERER = "https://apexexteriorsmidsouth.com/"

TILE = 512  # Mapbox's logical tile size for zoom/world-size math

center_lon = (MIN_LON + MAX_LON) / 2
center_lat = (MIN_LAT + MAX_LAT) / 2

# Padded beyond the data bbox so every dot — including ones right at an
# edge — has real map imagery to sample around it, not an extrapolated
# edge pixel.
PAD = 1.35
span_lon = (MAX_LON - MIN_LON) * PAD
span_lat = (MAX_LAT - MIN_LAT) * PAD


def lat_merc_frac(lat_deg):
    """Monotonic Mercator latitude term — the non-x-linear part of the
    projection. World-size-independent; multiply by world_size(zoom) for
    actual pixels."""
    lat_rad = math.radians(lat_deg)
    return 0.5 - math.log(math.tan(math.pi / 4 + lat_rad / 2)) / (2 * math.pi)


# Source image: request this many *logical* pixels, fetched @2x (so the
# real fetched image is double this). Mapbox's static API caps logical
# size at 1280x1280.
SRC_LOGICAL = 1280

# Solve for the largest zoom where the padded span still fits inside
# SRC_LOGICAL on both axes — closed form, not a search: world_size(z) =
# TILE*2^z, and both the longitude pixel-span and the (Mercator)
# latitude pixel-span scale linearly with world_size for fixed lon/lat
# values, so each axis gives a direct cap on 2^z.
max_pow2_lon = (SRC_LOGICAL * 360 / span_lon) / TILE
lat_frac_span = abs(
    lat_merc_frac(center_lat + span_lat / 2) - lat_merc_frac(center_lat - span_lat / 2)
)
max_pow2_lat = SRC_LOGICAL / (TILE * lat_frac_span)
zoom = math.log2(min(max_pow2_lon, max_pow2_lat) * 0.97)  # 3% safety margin

print(f"center=({center_lon:.5f},{center_lat:.5f}) zoom={zoom:.4f} "
      f"padded_span=({span_lon:.3f}lon, {span_lat:.3f}lat)")

url = (
    f"https://api.mapbox.com/styles/v1/mapbox/{STYLE}/static/"
    f"{center_lon},{center_lat},{zoom:.6f},0,0/{SRC_LOGICAL}x{SRC_LOGICAL}@2x"
    f"?access_token={TOKEN}"
)
req = urllib.request.Request(url, headers={"Referer": REFERER})
with urllib.request.urlopen(req) as resp:
    src_bytes = resp.read()

src_path = ROOT / "tools" / "_radar-basemap-source.png"
src_path.write_bytes(src_bytes)
src_img = Image.open(src_path).convert("RGB")
src_arr = np.asarray(src_img, dtype=np.float64)
SRC_PX_W, SRC_PX_H = src_img.size  # actual fetched pixels (@2x of SRC_LOGICAL)
print(f"fetched source image: {SRC_PX_W}x{SRC_PX_H}")

world_size = TILE * (2 ** zoom) * (SRC_PX_W / SRC_LOGICAL)  # actual-pixel world size
center_world_x = world_size * (center_lon + 180) / 360
center_world_y = world_size * lat_merc_frac(center_lat)

# Every output pixel's lon/lat, via the exact inverse of script.js's dot
# formula (left = xFrac*100%, top = yFrac*100%).
px = np.arange(OUT_W) + 0.5
py = np.arange(OUT_H) + 0.5
x_frac = px / OUT_W
y_frac = py / OUT_H
lon = MIN_LON + x_frac * (MAX_LON - MIN_LON)  # (OUT_W,)
lat = MAX_LAT - y_frac * (MAX_LAT - MIN_LAT)  # (OUT_H,)

lon_grid, lat_grid = np.meshgrid(lon, lat)  # (OUT_H, OUT_W) each

world_x = world_size * (lon_grid + 180) / 360
lat_rad = np.radians(lat_grid)
world_y = world_size * (0.5 - np.log(np.tan(np.pi / 4 + lat_rad / 2)) / (2 * np.pi))

src_x = (SRC_PX_W / 2) + (world_x - center_world_x)
src_y = (SRC_PX_H / 2) + (world_y - center_world_y)

if src_x.min() < 0 or src_y.min() < 0 or src_x.max() > SRC_PX_W or src_y.max() > SRC_PX_H:
    sys.exit(
        f"Source image too small for the requested output — sampling would run "
        f"off the edge (src_x: {src_x.min():.1f}..{src_x.max():.1f} of {SRC_PX_W}, "
        f"src_y: {src_y.min():.1f}..{src_y.max():.1f} of {SRC_PX_H}). Raise PAD or "
        f"SRC_LOGICAL and retry."
    )

# Bilinear sample src_arr at (src_x, src_y) for every output pixel, vectorized.
x0 = np.floor(src_x).astype(int)
y0 = np.floor(src_y).astype(int)
x1 = np.clip(x0 + 1, 0, SRC_PX_W - 1)
y1 = np.clip(y0 + 1, 0, SRC_PX_H - 1)
x0 = np.clip(x0, 0, SRC_PX_W - 1)
y0 = np.clip(y0, 0, SRC_PX_H - 1)
fx = (src_x - x0)[..., None]
fy = (src_y - y0)[..., None]

top = src_arr[y0, x0] * (1 - fx) + src_arr[y0, x1] * fx
bottom = src_arr[y1, x0] * (1 - fx) + src_arr[y1, x1] * fx
out = top * (1 - fy) + bottom * fy

out_img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")
out_path = ROOT / "images" / "storm-radar-basemap.jpg"
out_img.save(out_path, quality=88)
src_path.unlink()

print(f"saved {out_path} ({OUT_W}x{OUT_H})")
