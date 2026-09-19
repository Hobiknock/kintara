#!/bin/bash
# start-account.sh <nama> — jalankan SATU akun dari accounts.json di screen 'kintara-<nama>'
# Nambah akun = nambah entry di accounts.json, lalu ./start-account.sh <nama>
set -e
cd "$(dirname "$0")"

NAME="$1"
if [ -z "$NAME" ]; then
  echo "Pemakaian: $0 <nama-akun>"
  echo "Akun di accounts.json:"
  node -e "const a=require('./lib/accounts').loadRaw(); console.log(a.length?a.map(x=>'  - '+x.name).join('\n'):'  (kosong — isi accounts.json dulu)')"
  exit 1
fi

if ! node -e "process.exit(require('./lib/accounts').get('$NAME')?0:1)"; then
  echo "❌ Akun '$NAME' gak ada di accounts.json"; exit 1
fi

SCREEN="kintara-$NAME"
mkdir -p recon/multi logs

screen -S "$SCREEN" -X quit 2>/dev/null || true
screen -dmS "$SCREEN" bash -c "KINTARA_ACCOUNT='$NAME' node $(pwd)/tools/telegram-ctl.js >> $(pwd)/recon/multi/$NAME.out 2>&1"
sleep 2
if screen -ls 2>/dev/null | grep -q "$SCREEN"; then
  echo "🚀 Akun '$NAME' jalan di screen '$SCREEN'"
  echo "   Log: tail -f $(pwd)/recon/multi/$NAME.out"
else
  echo "⚠️ Gagal start — cek: tail -20 $(pwd)/recon/multi/$NAME.out"; exit 1
fi
