#!/bin/bash
echo "🔍 Scanning for Chrome/Chromium..."

PATHS=(
  "/run/current-system/sw/bin/chromium"
  "/run/current-system/sw/bin/chromium-browser"
  "/usr/bin/chromium"
  "/usr/bin/chromium-browser"
  "/nix/var/nix/profiles/default/bin/chromium"
)

CHROME_PATH=""
for p in "${PATHS[@]}"; do
  if [ -f "$p" ]; then
    CHROME_PATH="$p"
    echo "✅ Chrome found at: $p"
    break
  fi
done

if [ -z "$CHROME_PATH" ]; then
  echo "❌ Chrome not found in standard paths, doing deep search..."
  CHROME_PATH=$(find /nix -name "chromium" -type f 2>/dev/null | head -1)
  if [ -n "$CHROME_PATH" ]; then
    echo "✅ Chrome found via deep search: $CHROME_PATH"
  else
    echo "❌ Chrome NOT found anywhere!"
  fi
fi

export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
echo "🚀 Starting server with PUPPETEER_EXECUTABLE_PATH=$CHROME_PATH"
node server.js
