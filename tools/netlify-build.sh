#!/usr/bin/env bash
# Build command for Netlify's GitHub integration. This site has no real
# build step — this only does what tools/deploy.sh does for manual deploys:
# copy the site into a clean directory (excluding tools/, .github/, and
# other internal files that shouldn't be publicly served) and substitute the
# real Mapbox token into storm-history.js and home-storm-search.js in place
# of their "__MAPBOX_TOKEN__" placeholder, so the token never sits in git.
#
# Set MAPBOX_TOKEN as a site environment variable in the Netlify dashboard
# (Site settings -> Environment variables). If it's unset, the placeholder
# is left in place and the site falls back to "Map unavailable" — see the
# token check in storm-history.js.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf .netlify-publish
mkdir -p .netlify-publish

rsync -a \
  --exclude='.git' \
  --exclude='.netlify' \
  --exclude='.netlify-publish' \
  --exclude='.env.local' \
  --exclude='node_modules' \
  --exclude='tools' \
  ./ .netlify-publish/

if [ -n "${MAPBOX_TOKEN:-}" ]; then
  sed -i "s|__MAPBOX_TOKEN__|${MAPBOX_TOKEN}|g" \
    .netlify-publish/storm-history.js \
    .netlify-publish/home-storm-search.js
else
  echo "MAPBOX_TOKEN not set — leaving placeholder in place; map will show as unavailable." >&2
fi

# Coming-soon gate, production only. [[redirects]] in netlify.toml is global
# and can't be scoped to a deploy context (Netlify's own docs are explicit
# about this), so this is done per-build instead: CONTEXT is set by Netlify
# on every build (production / deploy-preview / branch-deploy) and by
# `netlify dev` (dev) — only a production build appends the catch-all, so
# deploy previews and local dev keep serving the real site untouched.
# Appended, not overwritten — _redirects already carries the /process
# redirects from the repo root — and appended LAST, since first match wins
# and this one must not shadow anything above it. The trailing "!" forces
# the rewrite even though /coming-soon.html itself is a real file that
# would otherwise just be served normally for its own path; without it the
# gate would no-op for every other real file on the site too.
if [ "${CONTEXT:-}" = "production" ]; then
  printf '/*  /coming-soon.html  200!\n' >> .netlify-publish/_redirects
fi
