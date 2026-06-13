#!/bin/bash
# axle-send.sh - Taildrop one or more box-code files to the Axle box (Mac side).
# Usage:  axle-send.sh server.js send.js send-guard.js
#         (names are relative to the box-code folder; pass as many as you like)
# Then on the box run:  C:\Axle\axle-pull.ps1
set -e
DIR="$HOME/Documents/Claude/Projects/Axle/box-code"
NODE="axle-box"   # the box's Tailscale machine name; change here if yours differs

# Find the Tailscale CLI (Homebrew/standalone on PATH, or the Mac App Store app bundle).
TS="$(command -v tailscale || true)"
[ -z "$TS" ] && TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
if [ ! -x "$TS" ] && ! command -v "$TS" >/dev/null 2>&1; then
  echo "Tailscale CLI not found. Install Tailscale or fix the path in this script." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then echo "Usage: axle-send.sh <file> [file ...]" >&2; exit 1; fi

cd "$DIR"
"$TS" file cp "$@" "$NODE:"
echo "Sent to $NODE: $*"
echo "Now on the box run:  C:\\Axle\\axle-pull.ps1"
