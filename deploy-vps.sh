#!/bin/bash
# deploy-vps.sh — one-shot deploy kintara lifecycle di VPS baru
set -e
DIR="${1:-$HOME/kintara-bot-private}"

echo "=== 1. Clone repo ==="
if [ ! -d "$DIR" ]; then
  git clone -b lifetime https://github.com/Hobiknock/kintara-bot-private.git "$DIR"
else
  echo "repo sudah ada — skip clone"
fi
cd "$DIR"

echo "=== 2. npm install ==="
npm install

echo "=== 3. Siapkan .env ==="
if [ ! -f .env ] || ! grep -q '^WALLETS=' .env; then
  cat > .env << 'EOF'
# 1 private key per baris (baris pertama nyambung WALLETS=)
WALLETS=pk_pertama
pk_kedua
pk_ketiga

# Telegram lapor (opsional)
REPORT_TG_TOKEN=
REPORT_TG_CHAT=

# Server (opsional, kosong = auto)
KINTARA_FORCE_SERVER=
SELL_THRESHOLD=10000
EOF
  chmod 600 .env
  echo "!! EDIT .env SEKARANG: nano $DIR/.env — isi pk beneran !!"
  echo "!! setelah edit, jalankan lagi: bash $DIR/deploy-vps.sh $DIR"
  exit 0
fi

echo "=== 4. Start lifecycle + watchdog ==="
screen -dmS lifecycle bash -c "cd $DIR && node tools/kintara-lifecycle.js >> recon/lifecycle.out 2>&1"
screen -dmS watchdog bash -c "cd $DIR && node tools/mining-watchdog.js >> recon/watchdog.out 2>&1"

# cron penjaga (guarded, gak spawn dobel)
CRON_LINE="*/5 * * * * screen -ls 2>/dev/null | grep -q lifecycle || screen -dmS lifecycle bash -c 'cd $DIR && node tools/kintara-lifecycle.js >> $DIR/recon/lifecycle.out 2>&1'"
(crontab -l 2>/dev/null | grep -v 'kintara-lifecycle' ; echo "$CRON_LINE") | crontab -

sleep 3
echo "=== STATUS ==="
screen -ls
echo "log: tail -f $DIR/recon/lifecycle.out"
echo "SELESAI — bot jalan. Monitoring: screen -r lifecycle (keluar: Ctrl+A lalu D)"
