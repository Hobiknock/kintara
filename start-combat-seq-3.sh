#!/bin/bash
# start-combat-seq-3.sh — combat 3 akun (Subagyo, holimow, jojik) di Server 15 ASIA, dalam screen
BOT=/home/agentuser/kintara-bot
screen -S combat-seq3 -X quit 2>/dev/null
screen -dmS combat-seq3 bash -c "cd $BOT && KINTARA_ZONE=asia KINTARA_FORCE_SERVER=15 node tools/combat-seq-3.js >> $BOT/recon/multi/combat-seq-3.out 2>&1"
sleep 5
screen -ls | grep combat-seq3
tail -5 $BOT/recon/multi/combat-seq-3.out 2>/dev/null
