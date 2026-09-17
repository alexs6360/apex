#!/usr/bin/env bash
# Deploys the site to Netlify — a preview URL by default, production only
# with an explicit --prod flag.
#
# This used to default to `netlify deploy --prod`, which shipped straight to
# the live site from whatever was on disk, committed or not. That's why
# production and git history drifted apart: a whole day of storm-history
# work went live through this script without a single commit backing it up.
# Preview-by-default makes "verify a change" and "ship a change" two
# different, deliberately-chosen commands instead of one.
#
# storm-history.js and home-storm-search.js each ship with a
# "__MAPBOX_TOKEN__" placeholder so the real token never sits in the
# project's own files — this script copies the whole site to a temp
# directory, substitutes the token there from .env.local (which is
# gitignored), and deploys that copy. The working copies are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD=false
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--prod]" >&2
      exit 1
      ;;
  esac
done

if [ "$PROD" = true ]; then
  # Only deploy to prod from committed code — an uncommitted prod deploy is
  # exactly the situation that made "what's actually live" impossible to
  # answer without diffing the working tree against a screenshot.
  if [ -n "$(git status --porcelain)" ]; then
    echo "Refusing --prod deploy: working tree has uncommitted changes." >&2
    echo "Commit and push first, or run without --prod for a preview." >&2
    git status --short >&2
    exit 1
  fi
fi

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

if [ "$PROD" = true ]; then
  netlify deploy --prod --dir "$TMP"
else
  netlify deploy --dir "$TMP"
fi
