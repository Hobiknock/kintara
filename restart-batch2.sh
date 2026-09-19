#!/bin/bash
# restart-batch2.sh — quit screen kw11..kw20 lalu spawn ulang dengan runner terbaru
BOT=/home/agentuser/kintara-bot
for s in kw11 kw12 kw13 kw14 kw15 kw16 kw17 kw18 kw19 kw20; do
  screen -S "$s" -X quit 2>/dev/null
done
sleep 2
i=10
while IFS= read -r PK; do
  [ -z "$PK" ] && continue
  i=$((i+1))
  screen -dmS "kw$i" bash -c "node $BOT/tools/headless-runner.js '$PK' auto >> $BOT/recon/multi/kw$i.out 2>&1"
  sleep 1
done < /home/agentuser/wallets-batch2.txt
echo "respawned: $(screen -ls | grep -c 'kw1[1-9]\|kw20')"
