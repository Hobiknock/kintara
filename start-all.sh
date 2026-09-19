#!/bin/bash
# start-all.sh — jalankan SEMUA akun di accounts.json, stagger 20 dtk per akun (anti rate-limit)
cd "$(dirname "$0")"
NAMES=$(node -e "console.log(require('./lib/accounts').loadRaw().map(a=>a.name).join(' '))")
if [ -z "$NAMES" ]; then echo "accounts.json kosong"; exit 1; fi
for n in $NAMES; do
  ./start-account.sh "$n" || true
  sleep 20
done
echo "== Semua akun di-spawn. screens: =="
screen -ls | grep kintara- || true
