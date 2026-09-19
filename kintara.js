#!/usr/bin/env node
// ============ kintara.js — launcher simpel ============
//   node kintara.js          → start bot akun dari .env (mode lama, 1 akun)
//   node kintara.js all      → start SEMUA akun dari accounts.json (multi)
//   node kintara.js <nama>   → start 1 akun dari accounts.json
//   node kintara.js stop     → stop bot .env | node kintara.js stop <nama>
const { execSync } = require('child_process');
const path = require('path');
const cmd = (process.argv[2] || '').toLowerCase();
const arg = process.argv[3] || '';
const sh = (f, a) => execSync(`bash ${path.join(__dirname, f)} ${a}`, { stdio: 'inherit' });

if (cmd === 'all') return sh('start-all.sh', '');
if (cmd === 'stop' && arg) return sh('stop-account.sh', arg);
if (cmd === 'stop') return sh('stop.sh', '');
if (cmd) return sh('start-account.sh', cmd);
// tanpa argumen → mode .env (1 akun, bot telegram-ctl klasik)
// .env belum ada? bikin dari template biar tinggal nano .env
const fs = require('fs');
const envP = path.join(__dirname, '.env');
if (!fs.existsSync(envP)) {
  fs.copyFileSync(path.join(__dirname, '.env.example'), envP);
  try { fs.chmodSync(envP, 0o600); } catch {}
  console.log('✅ .env belum ada — udah kubuatkan dari template.');
  console.log('   Isi 2 baris ini:  nano .env');
  console.log('     WALLET_PRIVATE_KEY=***');
  console.log('     TELEGRAM_BOT_TOKEN=***');
  console.log('   lalu jalan lagi:  node kintara.js');
  process.exit(0);
}
require('./tools/telegram-ctl.js');
