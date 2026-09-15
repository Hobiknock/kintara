#!/bin/bash
# Kintara bot — stop PERMANEN (cron gak akan bangunin lagi)
# Start ulang: ./start.sh (otomatis angkat flag STOP + refresh cron)
cd "$(dirname "$0")"
mkdir -p recon
touch recon/STOP
screen -S kintara -X quit 2>/dev/null || true
sleep 1
if screen -ls 2>/dev/null | grep -q kintara; then
  echo "⚠️ Screen masih ada — matiin manual: screen -S kintara -X quit"
else
  echo "🛑 Bot berhenti permanen (flag STOP aktif — cron & reboot gak akan bangunin)."
fi
echo "   Nyalain lagi: $(pwd)/start.sh"
