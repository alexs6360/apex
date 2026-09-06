# Apex Exteriors

Static site for apexexteriorsmidsouth.com. No build step, no bundler — plain
HTML/CSS/JS deployed straight to Netlify.

## Deploying

Use `tools/deploy.sh`, not `netlify deploy` directly — it substitutes the
Mapbox token into a temporary copy of the site before deploying, so the real
token never sits in the project's own tracked files.

```
bash tools/deploy.sh
```

## Mapbox token

The storm history tool (`storm-history.html`) uses Mapbox for the basemap and
for turning a typed address into a coordinate. The token lives in
`.env.local` (gitignored, never committed):

```
export MAPBOX_TOKEN="pk.your_token_here"
```

**The token must have `apexexteriorsmidsouth.com` (and the
`*.netlify.app` preview domain) added to its allowed URLs in the Mapbox
account**, or requests from this site will fail with a 401/403. A token
restricted to a different domain — for instance one already in use on another
site — will not work here.

If `.env.local` is missing or empty when `tools/deploy.sh` runs, the site
still deploys, but the storm history page shows "Map unavailable — no Mapbox
token configured" instead of failing outright.

## Storm history data

`storm-history.html` reads static JSON from `data/` — `storm-index.json` plus
`hail-YYYY.json` and `reports-YYYY.json` per year. Nothing is fetched live at
request time except Mapbox.

Regenerate the full ten-year archive:

```
node tools/build-storm-data.mjs data
```

This pulls ~130 requests from three free, public NOAA/NWS sources (SWDI for
hail, NCEI Storm Events and Iowa State's Local Storm Reports feed for wind)
and takes roughly 1–2 minutes. The bounding box is set in
`tools/build-storm-data.mjs` and covers the Memphis metro: Shelby, Fayette,
and Tipton counties in Tennessee; DeSoto, Marshall, Tate, and Tunica counties
in Mississippi; and Crittenden county in Arkansas. If that area ever needs to
change, `storm-history.js` and `storm-autocomplete.js` both hard-code the same
bbox and must be updated to match — search each file for the `AREA` constant.

An incremental pull (last N months only, merged into the committed archive)
is available via `WINDOW_MONTHS`:

```
WINDOW_MONTHS=2 node tools/build-storm-data.mjs data
```

## Lead capture

Two Netlify Forms are wired up:

- `apex-estimate` — the hero and footer estimate forms
- `apex-storm-lookup` — fired automatically by `storm-history.js` the moment
  an address lookup succeeds, so a homeowner is captured as a lead without
  filling out a second form. The static, hidden form declaration for schema
  registration lives at the bottom of `storm-history.html`.

Submissions arrive by email via Netlify's built-in form notifications — there
is no custom Netlify Function or third-party email service wired up.

## Credit

The storm history tool — data pipeline, contour fitting, and lookup UI — was
ported from a sibling project, riseroofingms.com, and re-pointed at the
Memphis metro with its own data, colors, and copy.
