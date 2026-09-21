#!/usr/bin/env node
/**
 * mining-watchdog.js — jaga screen mining lc-wN tetap hidup.
 * Cek tiap 2 menit: kalau screen lc-w* mati tapi wallet-nya eligible fase 4, respawn.
 * Jalankan: screen -dmS watchdog node tools/mining-watchdog.js
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
// load env sama seperti lifecycle
try {
  const lines = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n');
  let inW = false; const wl = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('WALLETS=')) { const v = line.slice(8).trim(); if (v) wl.push(v); inW = true; continue; }
    if (inW) { if (/^[A-Z_0-9]+=/.test(line)) inW = false; else if (line.trim()) wl.push(line.trim()); continue; }
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
  if (wl.length) process.env.WALLET_LIST = wl.join(',');
} catch {}
const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const pks = (process.env.WALLET_LIST || '').split(',').map(s=>s.trim()).filter(Boolean);
if (!pks.length) { log('no wallets'); process.exit(1); }
const FORCE_SERVER = process.env.KINTARA_FORCE_SERVER || '';
setInterval(() => {
  pks.forEach((pk, i) => {
    const name = 'lc-w' + (i+1);
    try {
      execSync(`screen -ls 2>/dev/null | grep -q ${name}`);
      // hidup — ok
    } catch {
      // mati → respawn (mining rock terus)
      const srv = FORCE_SERVER ? `KINTARA_FORCE_SERVER=${FORCE_SERVER} ` : '';
      log(`${name} mati — respawn`);
      execSync(`screen -dmS ${name} bash -c "${srv}KINTARA_NO_PHASE2=1 node ${ROOT}/tools/headless-runner.js '${pk}' rock >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
    }
  });
}, 2 * 60 * 1000);
log(`watchdog jalan — ${pks.length} wallet dimonitor`);
