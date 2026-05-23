#!/usr/bin/env bash
# Setup verification for chess-game-explainer (macOS / Linux).
# Checks that Node, npm, ffmpeg, and a browser are findable, then runs npm install.
# Run from the repo root:  bash scripts/setup.sh

set -e
failed=0

check_cmd() {
  local name="$1"
  local hint="$2"
  if command -v "$name" >/dev/null 2>&1; then
    echo "  [OK]    $name -> $(command -v $name)"
  else
    echo "  [MISS]  $name not found. $hint"
    failed=1
  fi
}

echo "chess-game-explainer setup check"
echo

check_cmd node   "Install Node 22+ from https://nodejs.org or via nvm"
check_cmd npm    "Bundled with Node"
check_cmd ffmpeg "Install via 'brew install ffmpeg' (macOS) or 'apt install ffmpeg' (Debian/Ubuntu)"

# Browser: chrome / chromium / google-chrome / microsoft-edge — any works
browser=""
for b in google-chrome chrome chromium chromium-browser msedge; do
  if command -v "$b" >/dev/null 2>&1; then
    browser="$(command -v $b)"
    break
  fi
done
# macOS fallback
if [ -z "$browser" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  browser="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
if [ -n "$browser" ]; then
  echo "  [OK]    browser -> $browser"
else
  echo "  [MISS]  chrome/chromium/edge not found. Install Google Chrome or Chromium."
  failed=1
fi

if [ "$failed" -eq 1 ]; then
  echo
  echo "Some dependencies are missing. Install them and re-run this script."
  exit 1
fi

echo
echo "All deps look good. Running npm install..."
npm install
echo
echo "Done. Try: node src/cli.js analyze samples/sample-game.pgn"
