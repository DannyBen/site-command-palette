#!/usr/bin/env bash
set -euo pipefail

version="$(node -p "require('./manifest.json').version")"
archive="dist/site-command-palette-${version}.zip"

mkdir -p dist
zip -j -FS -X "$archive" \
  manifest.json \
  background.js \
  core.js \
  storage.js \
  backup.js \
  content.js \
  palette.css \
  options.html \
  options.js \
  options.css

printf 'Created %s\n' "$archive"
