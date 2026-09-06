#!/usr/bin/env bash
# Deploys the site to Netlify production.
#
# storm-history.js and home-storm-search.js each ship with a
# "__MAPBOX_TOKEN__" placeholder so the real token never sits in the
# project's own files — this script copies the whole site to a temp
# directory, substitutes the token there from .env.local (which is
# gitignored), and deploys that copy. The working copies are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.local ]; then
  echo "Missing .env.local with MAPBOX_TOKEN — storm-history.js and home-storm-search.js will ship with their placeholders unsubstituted." >&2
else
  # shellcheck disable=SC1091
  source .env.local
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rsync -a \
  --exclude='.git' \
  --exclude='.netlify' \
  --exclude='.env.local' \
  --exclude='node_modules' \
  --exclude='tools' \
  ./ "$TMP/"

if [ -n "${MAPBOX_TOKEN:-}" ]; then
  sed -i '' "s|__MAPBOX_TOKEN__|${MAPBOX_TOKEN}|g" "$TMP/storm-history.js" "$TMP/home-storm-search.js"
fi

netlify deploy --prod --dir "$TMP"
