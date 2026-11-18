#!/usr/bin/env bash
# Build command for Netlify's GitHub integration. This site has no real
# build step — this only does what tools/deploy.sh does for manual deploys:
# copy the site into a clean directory (excluding tools/, .github/, and
# other internal files that shouldn't be publicly served) and substitute
# real values into placeholders so none of them sit in git: the Mapbox
# token into storm-history.js and home-storm-search.js
# ("__MAPBOX_TOKEN__"), the phone number into every page
# ("__PHONE_TEL__" / "__PHONE_DISPLAY__" — not a secret, just a single
# source of truth instead of 68 hand-typed copies), and the shared
# styles.css/script.js cache-bust string into every page
# ("__ASSET_VER__" — computed below, not hand-typed at all).
#
# Set MAPBOX_TOKEN as a site environment variable in the Netlify dashboard
# (Site settings -> Environment variables). If it's unset, the placeholder
# is left in place and the site falls back to "Map unavailable" — see the
# token check in storm-history.js.
set -euo pipefail
cd "$(dirname "$0")/.."

# The one place the real phone number lives. Source HTML carries
# __PHONE_TEL__ / __PHONE_DISPLAY__ instead of either format — change a
# digit here, not in up to 18 places per file across 6 files.
PHONE_TEL="19014947506"
PHONE_DISPLAY="(901) 494-7506"

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
  # Redirect-to-tempfile, not sed -i — see the note below on the phone/
  # version substitution for why. This one only escaped notice because
  # MAPBOX_TOKEN is unset in local runs, so the branch never executed
  # here; same failure the moment it's set on a Mac.
  for f in .netlify-publish/storm-history.js .netlify-publish/home-storm-search.js; do
    sed "s|__MAPBOX_TOKEN__|${MAPBOX_TOKEN}|g" "$f" > "$f.tmp"
    mv "$f.tmp" "$f"
  done
else
  echo "MAPBOX_TOKEN not set — leaving placeholder in place; map will show as unavailable." >&2
fi

# Cache-bust version: sha256 of styles.css + script.js concatenated, first
# 8 chars. Computed once here rather than hand-typed per page, so it's
# impossible for pages to drift out of sync with each other, and it only
# changes when one of those two files actually does. Hashes the publish
# copies (identical to the source ones — neither file has a placeholder
# of its own), so this reads whatever actually shipped, not what's on disk
# before rsync. sha256sum is standard on Netlify's (Linux) build image;
# shasum is the macOS fallback for running this locally.
if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD=(sha256sum)
else
  HASH_CMD=(shasum -a 256)
fi
ASSET_VER=$(cat .netlify-publish/styles.css .netlify-publish/script.js | "${HASH_CMD[@]}" | cut -c1-8)

# Every published HTML page: phone number + asset version. find, not a
# fixed file list, so a new page picks this up automatically. grep -l
# first so this only touches files that actually have a placeholder,
# rather than rewriting (and bumping the mtime of) every HTML file —
# coming-soon.html, for one, has none of these. Redirect-to-tempfile
# instead of sed -i: BSD sed (this Mac, for local runs) and GNU sed
# (Netlify's Linux build image) disagree on -i's syntax with multiple
# -e flags — this form works identically on both, no flavor-detection
# needed.
find .netlify-publish -name '*.html' -print0 | xargs -0 grep -l \
  -e '__PHONE_TEL__' -e '__PHONE_DISPLAY__' -e '__ASSET_VER__' 2>/dev/null \
  | while IFS= read -r f; do
      sed \
        -e "s|__PHONE_TEL__|${PHONE_TEL}|g" \
        -e "s|__PHONE_DISPLAY__|${PHONE_DISPLAY}|g" \
        -e "s|__ASSET_VER__|${ASSET_VER}|g" \
        "$f" > "$f.tmp"
      mv "$f.tmp" "$f"
    done

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
