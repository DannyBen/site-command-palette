#!/usr/bin/env bash
set -euo pipefail

version="$(node -p "require('./manifest.json').version")"
archive="dist/site-command-palette-${version}.zip"

mkdir -p dist
zip -FS -X "$archive" \
  manifest.json \
  background.js \
  core.js \
  storage.js \
  backup.js \
  content.js \
  palette.css \
  options.html \
  options.js \
  options.css \
  LICENSE \
  icons/edit.svg \
  icons/delete.svg \
  support/icons/icon-16.png \
  support/icons/icon-32.png \
  support/icons/icon-48.png \
  support/icons/icon-128.png

printf 'Created %s\n' "$archive"
