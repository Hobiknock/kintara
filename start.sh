#!/bin/bash
# Kintara bot — starter persisten (screen + auto-restart)
cd "$(dirname "$0")"

# cek .env
if [ ! -f .env ]; then
  echo "❌ .env belum ada — copy .env.example jadi .env lalu isi token & private key"
  exit 1
fi
if ! grep -q "^TELEGRAM_BOT_TOKEN=.\{10,\}" .env || grep -q "IsiTokenBotFatherDisini" .env; then
  echo "❌ TELEGRAM_BOT_TOKEN belum diisi — chat @BotFather (/newbot) lalu taruh token di .env"
  exit 1
fi
if grep -q "IsiPrivateKeyKamuDisini" .env; then
  echo "❌ WALLET_PRIVATE_KEY belum diisi — isi private key wallet game kamu di .env"
  exit 1
fi

mkdir -p recon logs

# hentikan session lama kalau ada
screen -S kintara -X quit 2>/dev/null || true

# jalanin via keeper (auto-restart kalau crash)
screen -dmS kintara bash -c "$(pwd)/keeper.sh"
sleep 3
if screen -ls 2>/dev/null | grep -q kintara; then
  echo "🚀 Bot jalan di screen 'kintara' (auto-restart + cron keep-alive)"
  echo "   Cek log: tail -f $(pwd)/recon/telegram-ctl.log"
  echo "   Stop:    screen -S kintara -X quit"
  echo "   Chat bot kamu di Telegram → /help"
else
  echo "⚠️ Gagal start — cek log: $(pwd)/recon/telegram-ctl.log"
  exit 1
fi
