#!/bin/sh
set -eu

# モデルファイルの存在確認
for f in "$BASELM_FILE" "$ACOUSTIC_FILE"; do
  if [ ! -f "$MODELS_DIR/$f" ]; then
    echo "ERROR: $MODELS_DIR/$f not found. Run scripts/download-models.ps1 and check the ./models mount." >&2
    exit 1
  fi
done

echo "llama.cpp-omni revision: $(cat /opt/voxcpm2/REVISION)" >&2
echo "threads=$THREADS http_threads=$HTTP_THREADS port=$PORT baselm=$BASELM_FILE" >&2

# EXTRA_ARGS は意図的に単語分割させる
# shellcheck disable=SC2086
exec /opt/voxcpm2/bin/llama-tts-server \
  --host 0.0.0.0 --port "$PORT" -t "$THREADS" --threads-http "$HTTP_THREADS" \
  --voxcpm2-base-lm "$MODELS_DIR/$BASELM_FILE" \
  --voxcpm2-acoustic "$MODELS_DIR/$ACOUSTIC_FILE" \
  ${EXTRA_ARGS:-}
