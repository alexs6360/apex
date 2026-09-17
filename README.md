# Apex Exteriors

Static site for apexexteriorsmidsouth.com. No build step, no bundler — plain
HTML/CSS/JS deployed straight to Netlify.

## Deploying

Use `tools/deploy.sh`, not `netlify deploy` directly — it substitutes the
Mapbox token into a temporary copy of the site before deploying, so the real
token never sits in the project's own tracked files.

**As of this writing, this site has no Netlify GitHub integration set up
yet — see below to fix that.** Until it's linked, pushing to `origin/main`
does not deploy anything by itself; `tools/deploy.sh` (or the Netlify
dashboard) is the only thing that ships code. Keep the two in sync by
committing and pushing before every prod deploy.

Preview a change (does not touch the live site):

```
bash tools/deploy.sh
```

Ship to production — refuses to run if the working tree has uncommitted
changes, so what's live always matches a real commit:

```
bash tools/deploy.sh --prod
```

### Connecting Netlify's GitHub integration

This turns a push to `main` into an automatic deploy, same as the Rise site,
and makes `tools/deploy.sh --prod` unnecessary. It requires authorizing
Netlify's GitHub App, which only you can do from the dashboard:

1. `https://app.netlify.com/projects/apexexteriorsmidsouth/settings/deploys`
   → **Build & deploy → Continuous deployment → Link repository**.
2. Choose GitHub, authorize the app if prompted, select `alexs6360/apex`,
   branch `main`.
3. Add a site environment variable `MAPBOX_TOKEN` (Site settings →
   Environment variables) with the real token from `.env.local`.

`netlify.toml` and `tools/netlify-build.sh` already do the rest: the build
copies the site into a clean directory (same exclusions as
`tools/deploy.sh` — `tools/`, `.git`, `node_modules`, etc. never get
published) and substitutes `MAPBOX_TOKEN` into `storm-history.js` and
`home-storm-search.js` in place of their placeholder, exactly like the
manual script does. If `MAPBOX_TOKEN` isn't set, the build still succeeds
and the site falls back to "Map unavailable" rather than failing.

Once this is linked, `tools/deploy.sh --prod` becomes a manual override for
one-off deploys rather than the normal path — the GitHub Action that
regenerates storm data (`.github/workflows/update-storm-data.yml`) will also
start reaching production automatically instead of sitting in git until
someone runs the script.

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
