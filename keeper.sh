#!/bin/bash
# Kintara bot keeper — jalanin telegram-ctl.js, restart kalau mati (backoff max 5 mnt)
cd "$(dirname "$0")"
mkdir -p recon
while true; do
  echo "[$(date '+%H:%M:%S')] [keeper] start telegram-ctl.js" >> recon/telegram-ctl.log
  node tools/telegram-ctl.js >> recon/telegram-ctl.log 2>&1
  code=$?
  echo "[$(date '+%H:%M:%S')] [keeper] bot exit code=$code — restart dalam 10 dtk" >> recon/telegram-ctl.log
  sleep 10
done
