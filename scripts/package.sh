#!/bin/sh
# Builds dist/meet-snap-fx-<version>.zip for the Chrome Web Store or a GitHub release.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p dist
rm -f "dist/meet-snap-fx-$VERSION.zip"
zip -qr "dist/meet-snap-fx-$VERSION.zip" manifest.json src detector popup icons vendor models LICENSE THIRD_PARTY_NOTICES.md licenses
echo "dist/meet-snap-fx-$VERSION.zip"
