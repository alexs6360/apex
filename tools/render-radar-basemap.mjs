/* Generates images/storm-radar-basemap.jpg: the static basemap behind the
   homepage radar panel's dots.

   Run by hand, rarely — not on every build, not even on every deploy.
   Rerun it only if data/storm-index.json's bbox changes or Mapbox changes
   the Standard style's night look enough to notice.

   Supersedes build-radar-basemap.py. That script fetched its source image
   from the Mapbox Static Images API, which cannot render
   mapbox://styles/mapbox/standard at all — confirmed both in Mapbox's own
   docs and by observing it silently fall back to a different default style
   rather than erroring. Standard (night preset) is the style storm-history
   actually uses, and the whole point of this image is to look like that
   page's own map, so the Static API was never going to get there no matter
   how it was tuned. This script renders the real thing instead: load
   mapbox-gl-js in a headless Chromium, screenshot the live map, then
   resample.

   One-time setup, local only (NOT added to package.json on purpose — see
   below):
     npm install --no-save playwright
     npx playwright install chromium
   Then: node tools/render-radar-basemap.mjs   (needs MAPBOX_TOKEN —
   source .env.local first)

   Why --no-save: Netlify runs `npm install` automatically before every
   build whenever package.json exists, and installs devDependencies too
   (confirmed against Netlify's own docs — only an explicit NODE_ENV=production
   skips them, which this site doesn't set). Playwright's Chromium download
   is ~300MB; adding it to package.json at all, dependencies or
   devDependencies, would put that on every production build for a script
   that runs maybe once a year. --no-save installs it into node_modules
   without writing it to package.json, so Netlify's install step never
   sees it and never fetches it.

   The hard requirement this exists to satisfy (same as the script it
   replaces): the image's visible extent must exactly equal the bbox
   script.js positions dots against (xFrac = (lon-minLon)/lonSpan,
   yFrac = (maxLat-lat)/latSpan), stretched to the panel's own 74:43 shape.
   A map camera can't produce that stretch directly — Web Mercator is
   isotropic (one scale in both directions), and this bbox's true Mercator
   aspect ratio is ~1.23:1, not 74:43 (~1.72:1). A direct "screenshot the
   bbox" render would have to pad one axis to avoid distorting the map,
   which would put the bbox at different edges than where the dots expect
   it — visible misalignment, not a rounding error.

   So, same as before: render a generously padded, square, isotropic source
   image first, then resample it pixel-by-pixel into the 74:43 output using
   the *exact same* lon/lat -> fraction formula script.js uses, inverted.
   Every output pixel's geographic coordinate is computed the way a dot at
   that position would be; this just asks "what does the map show there"
   and samples it — mathematically consistent by construction, not by
   matching parameters and hoping. Only the source-image step changed; the
   resample math is an unmodified port of the Python script's.

   Resample happens in-browser (Canvas 2D getImageData/putImageData), not
   via a Node image library — that would be another dependency this script
   doesn't want to force into node_modules by default. Chromium's canvas is
   already there via Playwright. */
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const ROOT = new URL("../", import.meta.url);

const { bbox } = JSON.parse(
  readFileSync(new URL("data/storm-index.json", ROOT), "utf8"),
);
const MIN_LON = bbox.minLon, MIN_LAT = bbox.minLat;
const MAX_LON = bbox.maxLon, MAX_LAT = bbox.maxLat;

// .storm-radar-panel's aspect-ratio in styles.css — keep in sync if that changes.
const PANEL_W_UNITS = 74, PANEL_H_UNITS = 43;
// 2x the panel's actual plateaued display width. That width is derived,
// not eyeballed: at the sitewide 1180px --container with --gutter capped
// at 3rem (48px) each side, the grid's content box is 1180 - 96 = 1084px;
// the panel track is clamp(380px, 54%, 680px), and 54% of 1084 = 585.4px,
// under the 680px cap, so that's the real plateau. 2x that is ~1171px.
const OUT_W = 1172;
const OUT_H = Math.round((OUT_W * PANEL_H_UNITS) / PANEL_W_UNITS); // 681

const TOKEN = process.env.MAPBOX_TOKEN;
if (!TOKEN) {
  console.error("MAPBOX_TOKEN not set — source .env.local first.");
  process.exit(1);
}

const TILE = 512; // Mapbox's logical tile size for zoom/world-size math

const centerLon = (MIN_LON + MAX_LON) / 2;
const centerLat = (MIN_LAT + MAX_LAT) / 2;

// Padded beyond the data bbox so every dot — including ones right at an
// edge — has real map imagery to sample around it, not an extrapolated
// edge pixel. Same value the Static-API version used; kept rather than
// re-derived since the tradeoff it balances (margin vs. zoom, and thus
// label size) hasn't changed.
const PAD = 1.08;
const spanLon = (MAX_LON - MIN_LON) * PAD;
const spanLat = (MAX_LAT - MIN_LAT) * PAD;

function latMercFrac(latDeg) {
  const latRad = (latDeg * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);
}

// Square source render, logical (CSS) pixels — not capped at 1280 like the
// Static API; chosen generously for resample headroom since nothing else
// constrains it now. Actual screenshot is this times devicePixelRatio.
const SRC_LOGICAL = 1600;
const DEVICE_SCALE = 2;

// Solve for the largest zoom where the padded span still fits inside
// SRC_LOGICAL on both axes — closed form, not a search. Unmodified port of
// the Static-API version's math: world_size(z) = TILE*2^z, and both the
// longitude pixel-span and the (Mercator) latitude pixel-span scale
// linearly with world_size for fixed lon/lat values, so each axis gives a
// direct cap on 2^z.
const maxPow2Lon = (SRC_LOGICAL * 360) / spanLon / TILE;
const latFracSpan = Math.abs(
  latMercFrac(centerLat + spanLat / 2) - latMercFrac(centerLat - spanLat / 2),
);
const maxPow2Lat = SRC_LOGICAL / (TILE * latFracSpan);
const zoom = Math.log2(Math.min(maxPow2Lon, maxPow2Lat) * 0.97); // 3% safety margin

console.log(
  `center=(${centerLon.toFixed(5)},${centerLat.toFixed(5)}) zoom=${zoom.toFixed(4)} ` +
    `padded_span=(${spanLon.toFixed(3)}lon, ${spanLat.toFixed(3)}lat)`,
);

// Headless Chromium throttles requestAnimationFrame on "backgrounded" pages,
// which is exactly how it treats every headless page — GL JS's idle event
// depends on rAF-driven renders actually happening at a normal rate, so
// without these flags idle can take many minutes or effectively never fire.
const browser = await chromium.launch({
  args: [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage({
  viewport: { width: SRC_LOGICAL, height: SRC_LOGICAL },
  deviceScaleFactor: DEVICE_SCALE,
});
// This token is referer-restricted to the production domain (same as the
// script this replaces had to work around with curl -H "Referer: ..."). A
// headless browser sends no Referer of its own, so every tile request 403s
// without this.
await page.setExtraHTTPHeaders({ Referer: "https://apexexteriorsmidsouth.com/" });

// page.setContent() serves the page from a blank/opaque origin, not a real
// http(s) one. Tiles still fetch fine from there (plain network requests),
// but Mapbox GL JS's web workers — which do the actual tile-parsing and
// symbol placement — never report back as finished, so sourceCache.loaded()
// gets stuck false forever with zero pending requests to show for it.
// Confirmed by checking sourceCache state directly at the point this used
// to hang: tiles all 200, "fill-extrusion:composite" loaded, "other:composite"
// and "symbol:composite" stuck false. A real http://localhost origin fixes
// it — same thing storm-history.html gets for free just by being served
// over HTTP normally.
const html = `<!doctype html>
<html><head>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.30.0/mapbox-gl.css" rel="stylesheet">
<script src="https://api.mapbox.com/mapbox-gl-js/v3.30.0/mapbox-gl.js"></script>
<style>html,body,#map{margin:0;padding:0;width:100%;height:100%;overflow:hidden}</style>
</head><body><div id="map"></div></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

await page.goto(`http://127.0.0.1:${port}/`);

await page.evaluate(
  ({ token, center, zoom }) => {
    mapboxgl.accessToken = token;
    window.__mapError = null;
    const map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/standard",
      // show3dObjects off: at this top-down pitch:0 camera, 3D building
      // extrusions aren't visible anyway (extrusions only read under some
      // camera pitch), and storm-history.js doesn't set this either so this
      // changes nothing about the two pages' look — but it's the heaviest
      // thing headless Chromium's software WebGL has to render, and turning
      // it off is what got idle to actually fire within a sane time.
      config: { basemap: { lightPreset: "night", show3dObjects: false } },
      center,
      zoom,
      bearing: 0,
      pitch: 0,
      interactive: false,
      attributionControl: false, // this render's attribution is the HTML overlay already on the page, not a baked-in logo
    });
    map.on("error", (e) => {
      window.__mapError = (e && e.error && e.error.message) || "unknown map error";
    });
    // setConfigProperty fallback, same belt-and-suspenders as storm-history.js —
    // the config option above should be enough, but this costs nothing.
    try {
      map.setConfigProperty("basemap", "lightPreset", "night");
    } catch (e) {
      console.warn("lightPreset not applied via setConfigProperty", e);
    }
    window.__map = map;
    window.__mapIdle = false;
    map.once("idle", () => {
      window.__mapIdle = true;
    });
  },
  { token: TOKEN, center: [centerLon, centerLat], zoom },
);

await page.waitForFunction(
  () => window.__mapIdle === true || window.__mapError,
  undefined,
  { timeout: 45000 },
);
const mapError = await page.evaluate(() => window.__mapError);
if (mapError) {
  await browser.close();
  console.error(`Mapbox GL error before idle: ${mapError}`);
  process.exit(1);
}

const screenshotPng = await page.screenshot({ type: "png" });
const screenshotDataUrl = `data:image/png;base64,${screenshotPng.toString("base64")}`;

const outDataUrl = await page.evaluate(
  async ({ dataUrl, minLon, minLat, maxLon, maxLat, outW, outH, srcLogical, zoomUsed, centerLon, centerLat }) => {
    const TILE = 512;
    function latMercFrac(latDeg) {
      const latRad = (latDeg * Math.PI) / 180;
      return 0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);
    }

    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const srcW = img.naturalWidth, srcH = img.naturalHeight;

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = srcW;
    srcCanvas.height = srcH;
    const srcCtx = srcCanvas.getContext("2d");
    srcCtx.drawImage(img, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

    // Actual-pixel world size — srcW/srcLogical plays the same role the
    // Python script's SRC_PX_W/SRC_LOGICAL ratio did (there, the Static
    // API's fixed @2x factor; here, whatever devicePixelRatio actually
    // rendered at, measured rather than assumed).
    const worldSize = TILE * 2 ** zoomUsed * (srcW / srcLogical);
    const centerWorldX = worldSize * ((centerLon + 180) / 360);
    const centerWorldY = worldSize * latMercFrac(centerLat);

    const outData = new Uint8ClampedArray(outW * outH * 4);
    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;

    for (let oy = 0; oy < outH; oy++) {
      const yFrac = (oy + 0.5) / outH;
      const lat = maxLat - yFrac * latSpan;
      const latRad = (lat * Math.PI) / 180;
      const worldY = worldSize * (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI));
      const srcY = srcH / 2 + (worldY - centerWorldY);

      for (let ox = 0; ox < outW; ox++) {
        const xFrac = (ox + 0.5) / outW;
        const lon = minLon + xFrac * lonSpan;
        const worldX = worldSize * ((lon + 180) / 360);
        const srcX = srcW / 2 + (worldX - centerWorldX);

        if (srcX < 0 || srcY < 0 || srcX > srcW - 1 || srcY > srcH - 1) {
          throw new Error(
            `Source image too small for the requested output — sampling would run ` +
              `off the edge at output (${ox},${oy}) -> src (${srcX.toFixed(1)},${srcY.toFixed(1)}) ` +
              `of ${srcW}x${srcH}. Raise PAD or SRC_LOGICAL and retry.`,
          );
        }

        const x0 = Math.floor(srcX), y0 = Math.floor(srcY);
        const x1 = Math.min(x0 + 1, srcW - 1), y1 = Math.min(y0 + 1, srcH - 1);
        const fx = srcX - x0, fy = srcY - y0;

        const i00 = (y0 * srcW + x0) * 4;
        const i10 = (y0 * srcW + x1) * 4;
        const i01 = (y1 * srcW + x0) * 4;
        const i11 = (y1 * srcW + x1) * 4;
        const outI = (oy * outW + ox) * 4;

        for (let c = 0; c < 3; c++) {
          const top = srcData[i00 + c] * (1 - fx) + srcData[i10 + c] * fx;
          const bottom = srcData[i01 + c] * (1 - fx) + srcData[i11 + c] * fx;
          outData[outI + c] = top * (1 - fy) + bottom * fy;
        }
        outData[outI + 3] = 255;
      }
    }

    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    outCanvas.getContext("2d").putImageData(new ImageData(outData, outW, outH), 0, 0);
    return outCanvas.toDataURL("image/jpeg", 0.88);
  },
  {
    dataUrl: screenshotDataUrl,
    minLon: MIN_LON,
    minLat: MIN_LAT,
    maxLon: MAX_LON,
    maxLat: MAX_LAT,
    outW: OUT_W,
    outH: OUT_H,
    srcLogical: SRC_LOGICAL,
    zoomUsed: zoom,
    centerLon,
    centerLat,
  },
);

await browser.close();
server.close();

const outPath = new URL("images/storm-radar-basemap.jpg", ROOT);
const base64 = outDataUrl.slice(outDataUrl.indexOf(",") + 1);
writeFileSync(outPath, Buffer.from(base64, "base64"));
console.log(`saved ${outPath.pathname} (${OUT_W}x${OUT_H})`);
