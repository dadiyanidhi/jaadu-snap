#!/bin/sh
# Builds dist/jaadu-snap-<version>.zip for the Chrome Web Store or a GitHub release.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p dist
rm -f "dist/jaadu-snap-$VERSION.zip"
zip -qr "dist/jaadu-snap-$VERSION.zip" manifest.json src detector popup icons vendor models LICENSE THIRD_PARTY_NOTICES.md licenses
echo "dist/jaadu-snap-$VERSION.zip"
