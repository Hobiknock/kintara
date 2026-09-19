#!/bin/bash
# persist-keepalive.sh — dipanggil cron: pastikan tiap akun di accounts.json jalan.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
for NAME in $(node -e "console.log(require('./lib/accounts').loadRaw().map(a=>a.name).join(' '))"); do
  [ -f "recon/STOP-$NAME" ] && continue            # stop permanen per-akun
  screen -ls 2>/dev/null | grep -q "kintara-$NAME" && continue
  screen -wipe >/dev/null 2>&1
  screen -dmS "kintara-$NAME" bash -c "KINTARA_ACCOUNT='$NAME' node $DIR/tools/telegram-ctl.js >> $DIR/recon/multi/$NAME.out 2>&1"
done
