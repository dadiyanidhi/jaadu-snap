#!/bin/sh
# Refreshes the bundled MediaPipe runtime and models (MV3 forbids loading remote code).
set -e
cd "$(dirname "$0")/.."
VERSION=${1:-latest}
TMP=$(mktemp -d)
(cd "$TMP" && npm pack "@mediapipe/tasks-vision@$VERSION" --silent && tar xzf mediapipe-tasks-vision-*.tgz)
cp "$TMP/package/vision_bundle.mjs" vendor/
cp "$TMP/package/wasm/vision_wasm_internal.js" "$TMP/package/wasm/vision_wasm_internal.wasm" vendor/wasm/
BASE=https://storage.googleapis.com/mediapipe-models
curl -sfL -o models/hand_landmarker.task "$BASE/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
curl -sfL -o models/selfie_segmenter.tflite "$BASE/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
curl -sfL -o models/blaze_face_short_range.tflite "$BASE/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
INSTALLED=$(node -p "require('$TMP/package/package.json').version")
rm -rf "$TMP"
echo "Updated to @mediapipe/tasks-vision $INSTALLED. Update the version in THIRD_PARTY_NOTICES.md."
