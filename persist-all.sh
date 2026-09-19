#!/bin/bash
# persist-all.sh — cron persistensi MULTI-ACCOUNT (satu entry cron untuk SEMUA akun)
# - @reboot            : spawn ulang semua akun (kalau gak di-stop via stop-account.sh)
# - tiap 5 menit       : keep-alive, cek per-akun (screen kintara-<nama> yang mati dihidupkan lagi)
# Per-akun stop permanen: touch recon/STOP-<nama> — akun itu gak dibangunin, akun lain jalan terus.
DIR="$(cd "$(dirname "$0")" && pwd)"
MARK="kintara-multi-persist"

if ! command -v crontab >/dev/null 2>&1; then
  echo "⚠️  crontab gak ketemu — sudo apt install -y cron"; exit 0
fi

TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$MARK" > "$TMP"
echo "@reboot $DIR/persist-keepalive.sh #$MARK" >> "$TMP"
echo "*/5 * * * * $DIR/persist-keepalive.sh #$MARK" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"
echo "✅ Cron persistensi multi-account terpasang (marker: $MARK)"
echo "   Stop satu akun permanen: touch $DIR/recon/STOP-<nama>"
