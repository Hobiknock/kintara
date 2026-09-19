#!/bin/bash
# start-combat-seq.sh — jalankan combat-sequential dalam screen (biar survive)
BOT=/home/agentuser/kintara-bot
screen -S combat-seq -X quit 2>/dev/null
screen -dmS combat-seq bash -c "cd $BOT && node tools/combat-sequential.js >> $BOT/recon/multi/combat-seq.out 2>&1"
sleep 10
screen -ls | grep combat-seq
tail -5 $BOT/recon/multi/combat-seq.out
