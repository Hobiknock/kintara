#!/bin/bash
# spawn-batch3.sh — wallet batch3 sebagai screen kw21..kw30, spawn stagger biar gak kena rate limit
BOT=/home/agentuser/kintara-bot
i=20
while IFS= read -r PK; do
  [ -z "$PK" ] && continue
  i=$((i+1))
  screen -S "kw$i" -X quit 2>/dev/null
  screen -dmS "kw$i" bash -c "node $BOT/tools/headless-runner.js '$PK' auto >> $BOT/recon/multi/kw$i.out 2>&1"
  echo "spawned kw$i"
  sleep 20  # stagger 20 detik antar akun — anti rate_limited
done < /home/agentuser/wallets-batch3.txt
echo "done: $(screen -ls | grep -c 'kw2')"
