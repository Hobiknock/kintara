#!/bin/bash
# start-nous.sh — start nous-ctl (bot NOUSAGNT) di screen 'nous' dgn token dari runner
screen -S nous -X quit 2>/dev/null
sleep 1
screen -dmS nous bash -c "node /home/agentuser/kintara-bot/tools/nous-ctl.js >> /home/agentuser/kintara-bot/recon/nous-ctl.log 2>&1"
echo "nous screens: $(screen -ls | grep -c nous)"
