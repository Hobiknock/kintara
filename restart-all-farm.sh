#!/bin/bash
# restart-all-farm.sh — restart SEMUA screen farm (kw11..kw30) pakai kode terbaru, stagger 20 dtk
BOT=/home/agentuser/kintara-bot
restart() {
  local n=$1 pk=$2
  screen -S "$n" -X quit 2>/dev/null
  screen -dmS "$n" bash -c "node $BOT/tools/headless-runner.js '$pk' auto >> $BOT/recon/multi/$n.out 2>&1"
  echo "restarted $n"
  sleep 20
}
i=10
while IFS= read -r PK; do
  [ -z "$PK" ] && continue
  i=$((i+1))
  restart "kw$i" "$PK"
done < /home/agentuser/wallets-batch2.txt
i=20
while IFS= read -r PK; do
  [ -z "$PK" ] && continue
  i=$((i+1))
  restart "kw$i" "$PK"
done < /home/agentuser/wallets-batch3.txt
echo "done: $(screen -ls | grep -c 'kw')"
