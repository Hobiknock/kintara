#!/bin/bash
# stop-account.sh <nama> — stop PERMANEN satu akun (flag STOP-<nama>, cron gak bangunin)
# Start ulang: rm recon/STOP-<nama> && ./start-account.sh <nama>
cd "$(dirname "$0")"
NAME="$1"
if [ -z "$NAME" ]; then echo "Pemakaian: $0 <nama-akun>"; exit 1; fi
mkdir -p recon
touch "recon/STOP-$NAME"
screen -S "kintara-$NAME" -X quit 2>/dev/null || true
sleep 1
if screen -ls 2>/dev/null | grep -q "kintara-$NAME"; then
  echo "⚠️ Screen masih ada — matiin manual: screen -S kintara-$NAME -X quit"
else
  echo "🛑 Akun '$NAME' stop permanen (akun lain tetap jalan)."
fi
