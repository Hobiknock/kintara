#!/bin/bash
# Kintara bot keeper — jalanin telegram-ctl.js, restart kalau mati
cd "$(dirname "$0")"
mkdir -p recon
echo $$ > recon/keeper.pid # cron cek PID file INI — bukan pgrep (cmdline node gak ngandung path folder, pgrep malah match bash cron sendiri)

# guard: di-stop permanen → diem aja (cron/start yang atur hidup lagi)
if [ -f recon/STOP ]; then
  exit 0
fi
# guard: jangan crash-loop kalau .env belum diisi
if [ ! -f .env ] || ! grep -q "^TELEGRAM_BOT_TOKEN=.\{10,\}" .env || grep -qE "IsiPrivateKeyKamuDisini|IsiTokenBotFatherDisini" .env; then
  echo "[$(date '+%H:%M:%S')] [keeper] ⏸ .env belum lengkap — isi dulu: nano $(pwd)/.env lalu ./start.sh" >> recon/telegram-ctl.log
  exit 1
fi

while true; do
  if [ -f recon/STOP ]; then exit 0; fi
  echo "[$(date '+%H:%M:%S')] [keeper] start telegram-ctl.js" >> recon/telegram-ctl.log
  node tools/telegram-ctl.js >> recon/telegram-ctl.log 2>&1
  code=$?
  echo "[$(date '+%H:%M:%S')] [keeper] bot exit code=$code — restart dalam 10 dtk" >> recon/telegram-ctl.log
  sleep 10
done
