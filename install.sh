#!/bin/bash
# ============================================
# KINTARA BOT — ONE-LINE INSTALLER
# Dipanggil via: curl -sL https://raw.githubusercontent.com/USERNAME/kintara-bot/main/install.sh | bash
# ============================================
set -e

REPO_URL="https://github.com/Hobiknock/kintara-bot.git"
INSTALL_DIR="$HOME/kintara-bot"

echo "🦞 Kintara Bot Installer"
echo "======================"

# 1) Node.js (>=18)
if ! command -v node >/dev/null 2>&1; then
  echo "📦 Installing Node.js..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add nodejs npm
  else
    echo "❌ Package manager gak dikenal. Install Node.js >= 18 manual dulu: https://nodejs.org"
    exit 1
  fi
fi
NODE_MAJOR=$(node -e "console.log(Number(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "⚠️  Node.js kamu v$NODE_MAJOR (< 18) — upgrade dulu di https://nodejs.org"
  exit 1
fi
echo "✅ Node.js v$(node -v)"

# 2) screen (untuk jalanin bot persisten)
if ! command -v screen >/dev/null 2>&1; then
  echo "📦 Installing screen..."
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y -qq screen
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y screen
  elif command -v apk >/dev/null 2>&1; then sudo apk add screen
  fi
fi

# 3) Clone repo
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "🔄 Repo udah ada — pull update..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || true
else
  echo "📥 Cloning kintara-bot..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 4) Dependencies
echo "📦 Installing dependencies..."
npm install --omit=dev --no-fund --no-audit

# 5) .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "════════════════════════════════════════════════"
  echo "✅ INSTALL SELESAI — tapi belum bisa jalan!"
  echo "════════════════════════════════════════════════"
  echo ""
  echo "👉 LANGKAH TERAKHIR (WAJIB, isi sendiri):"
  echo "   nano ~/kintara-bot/.env"
  echo ""
  echo "   Isi 2 baris ini:"
  echo "   • WALLET_PRIVATE_KEY  → private key wallet akun game kamu"
  echo "   • TELEGRAM_BOT_TOKEN  → token dari @BotFather (chat /newbot)"
  echo ""
  echo "   Abis itu jalanin:"
  echo "   ~/kintara-bot/start.sh"
  echo ""
  echo "🤖 Kirim /help ke bot kamu di Telegram untuk daftar command."
else
  echo "✅ .env udah ada — skip"
  echo ""
  echo "🚀 Jalanin bot: ~/kintara-bot/start.sh"
fi
echo ""
