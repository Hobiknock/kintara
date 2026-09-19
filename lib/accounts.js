// ============ MULTI-ACCOUNT LOADER (accounts.json) ============
// Satu repo = banyak akun. Semua akun didaftarkan di accounts.json:
//   [
//     { "name": "kwrock", "wallet": "<base58 pk>", "bot_token": "<tg token>", "chat_id": "<chat>", "mode": "auto", "server": 15 },
//     ...
//   ]
// Entry bot (telegram-ctl.js) set KINTARA_ACCOUNT=<name>; modul ini lalu:
//   - inject WALLET_PRIVATE_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID utk akun tsb
//   - persist perubahan (/setkey) balik ke accounts.json (bukan .env)
// aman: file chmod 600 kalau ada private key.
const fs = require('fs');
const path = require('path');

const ACC_PATH = path.join(__dirname, '..', 'accounts.json');

function loadRaw() {
  if (!fs.existsSync(ACC_PATH)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(ACC_PATH, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error(`[accounts] GAGAL parse ${ACC_PATH}: ${e.message}`);
    return [];
  }
}

function saveRaw(arr) {
  fs.writeFileSync(ACC_PATH, JSON.stringify(arr, null, 2) + '\n');
  try { fs.chmodSync(ACC_PATH, 0o600); } catch {}
}

function get(name) {
  return loadRaw().find((a) => a.name === name) || null;
}

// Terapkan kredensial akun ke process.env SEBELUM config.js dipakai.
function applyToEnv(name) {
  const acc = get(name);
  if (!acc) {
    console.error(`[accounts] Akun "${name}" tidak ada di accounts.json (isi: ${loadRaw().map((a) => a.name).join(', ') || 'kosong'})`);
    process.exit(1);
  }
  process.env.KINTARA_ACCOUNT = acc.name;
  if (acc.wallet) process.env.WALLET_PRIVATE_KEY = acc.wallet;
  if (acc.bot_token) process.env.TELEGRAM_BOT_TOKEN = acc.bot_token;
  if (acc.chat_id) process.env.TELEGRAM_CHAT_ID = String(acc.chat_id);
  if (acc.mode) process.env.KINTARA_MODE = acc.mode;
  if (acc.server) process.env.KINTARA_FORCE_SERVER = String(acc.server);
  return acc;
}

// Persist kredensial baru utk akun (dipakai /setkey & /settoken).
function update(name, patch) {
  const arr = loadRaw();
  const i = arr.findIndex((a) => a.name === name);
  if (i === -1) return false;
  Object.assign(arr[i], patch);
  saveRaw(arr);
  return true;
}

function ensureChmod() {
  try { if (fs.existsSync(ACC_PATH)) fs.chmodSync(ACC_PATH, 0o600); } catch {}
}

module.exports = { ACC_PATH, loadRaw, saveRaw, get, applyToEnv, update, ensureChmod };
