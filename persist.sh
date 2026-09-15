#!/bin/bash
# Kintara bot — pasang cron persistensi di VPS (idempotent, aman dijalankan berulang)
#   @reboot      : bot auto-start saat VPS nyala (kalau gak di-stop permanen via stop.sh)
#   tiap 5 menit : keep-alive — kalau screen/keeper mati, dihidupkan lagi
# Entri lama ditandai marker biar gak dobel; cron lain milik kamu gak disentuh.
DIR="$(cd "$(dirname "$0")" && pwd)"
MARK="kintara-bot-persist"

if ! command -v crontab >/dev/null 2>&1; then
  echo "⚠️  crontab gak ketemu — install dulu: sudo apt install -y cron (bot tetap jalan, tapi gak auto-start saat reboot)"
  exit 0
fi

TMP="$(mktemp)"
# buang entry kintara lama (biar gak dobel), sisakan cron lain milik user
crontab -l 2>/dev/null | grep -v "$MARK" > "$TMP"
echo "@reboot [ -f '$DIR/recon/STOP' ] || screen -dmS kintara bash -c '$DIR/keeper.sh' #$MARK" >> "$TMP"
echo "*/5 * * * * [ -f '$DIR/recon/STOP' ] || { screen -ls 2>/dev/null | grep -q kintara || (screen -wipe >/dev/null 2>&1; screen -dmS kintara bash -c '$DIR/keeper.sh'); } #$MARK" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"
echo "✅ Cron persistensi terpasang: auto-start saat reboot + keep-alive tiap 5 menit"
