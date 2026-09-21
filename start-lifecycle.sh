#!/bin/bash
# start-lifecycle.sh — jalankan lifecycle di screen dengan guard dobel
DIR="$(cd "$(dirname "$0")" && pwd)"
if screen -ls 2>/dev/null | grep -q 'lifecycle'; then
  echo "lifecycle sudah jalan"
  exit 0
fi
cd "$DIR"
screen -dmS lifecycle bash -c "node tools/kintara-lifecycle.js >> recon/lifecycle.out 2>&1"
echo "lifecycle start — log: recon/lifecycle.out"
