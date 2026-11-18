# Apex Exteriors

Static site for apexexteriorsmidsouth.com. No build step, no bundler — plain
HTML/CSS/JS deployed straight to Netlify.

## Deploying

**This site builds from [github.com/alexs6360/apex](https://github.com/alexs6360/apex)
on `main` via Netlify's GitHub integration.** A push to `main` (or a merged
PR) is what ships — `netlify.toml` points the integration at
`tools/netlify-build.sh`, which does the same copy-and-substitute
`tools/deploy.sh` does manually (see below), and the site's `MAPBOX_TOKEN`
environment variable (Site settings → Environment variables in the Netlify
dashboard) is already set, scoped to builds, so the Git-triggered build can
read it — `.env.local` is local-only and a Git build can never see it.

**Manual CLI deploys to this site now return `405 Method Not Allowed`.**
`tools/deploy.sh` (and plain `netlify deploy`) call `POST
/sites/{id}/deploys` directly, and once a site is linked to continuous
deployment, Netlify's API stops accepting that from the CLI — deploys have
to come from a Git push/PR instead. `tools/deploy.sh` is kept below for the
substitution logic it documents and in case the integration ever gets
unlinked, but treat it as non-functional against this site until then. The
regular path for a change is: commit, push (ideally via a PR, for a deploy
preview to review first), merge to `main`.

The commands below describe `tools/deploy.sh`'s intended behavior; they are
not expected to succeed while the GitHub integration is linked.

Preview a change (does not touch the live site):

```
bash tools/deploy.sh
```

Ship to production — refuses to run if the working tree has uncommitted
changes, so what's live always matches a real commit:

```
bash tools/deploy.sh --prod
```

### netlify-cli lives under a custom npm prefix, not the default one

`netlify` resolves to `~/.local/bin/netlify`, a symlink into
`~/.local/lib/node_modules/netlify-cli` — an ordinary npm global install,
just under a custom prefix (`~/.local`) rather than npm's default
(`/usr/local`, confirmed via `npm config get prefix`). Because of that,
plain `npm ls -g netlify-cli` / `npm outdated -g netlify-cli` / `npm i -g
netlify-cli` all operate against the *default* prefix and never see or
touch this install — `npm i -g netlify-cli` will error with `EACCES` on
`/usr/local/lib/node_modules` (no permission there, and it's the wrong
location regardless). To actually update the CLI that's in use:

```
npm i -g netlify-cli --prefix ~/.local
```

(`npm install -g` is the only install method Netlify documents — there's no
official standalone/curl installer or Homebrew formula, despite how this
looks.) As of this writing the installed version is 27.1.2; latest on npm
is 27.20.0.

## DNS

- `apexexteriorsmidsouth.com` is registered at Squarespace Domains but uses
  Netlify DNS (nameservers `dns1-4.p03.nsone.net`). Netlify manages the zone.
- **DNSSEC is OFF and must stay off.** Netlify DNS does not support it; it
  had to be disabled at Squarespace to delegate the nameservers. Re-enabling
  it would publish DS records for keys Netlify does not sign with, and
  validating resolvers would stop resolving the domain entirely.
- SPF is `v=spf1 -all` (no mail authorized). When business email is set up,
  that record must be replaced with one authorizing the mail provider, and
  MX records added to the Netlify zone.
- Manual CLI deploys return `405` on this site. Deploys go through the
  GitHub integration from `github.com/alexs6360/apex` on `main`.

## Mapbox token

The storm history tool (`storm-history.html`) uses Mapbox for the basemap and
for turning a typed address into a coordinate. The token lives in
`.env.local` (gitignored, never committed):

```
export MAPBOX_TOKEN="pk.your_token_here"
```

**The token must have `apexexteriorsmidsouth.com` added to its allowed URLs
in the Mapbox account**, or requests from this site will fail with a
401/403. A token restricted to a different domain — for instance one
already in use on another site — will not work here.

**Deploy previews need their own entry, added by hand, every time.** Each
Netlify deploy preview gets its own subdomain
(`deploy-preview-<N>--apexexteriorsmidsouth.netlify.app`), and **Mapbox's
URL restrictions do not support wildcards** — confirmed directly in the
Mapbox console ("Wildcard characters (*) are not supported in URL
restrictions"), so there is no single entry that covers every future
preview the way `https://*.apexexteriorsmidsouth.netlify.app` might
suggest. Until a PR's preview URL is added to the token's allowed URLs
(Mapbox account → Tokens → the `apex` token → URLs), the map on that
preview will 403 on every tile/data request — the style itself still
loads (200), only the actual map data doesn't, so the failure isn't
obvious from a glance. The production domain and the site's own default
`https://apexexteriorsmidsouth.netlify.app` are both already allowed and
don't need touching.

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
<!-- throwaway check for coming-soon gate scoping -->
