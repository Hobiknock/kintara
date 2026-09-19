#!/usr/bin/env node
// nous-ctl.js — command bot NOUSAGNT (token REPORT_TG_TOKEN): /levels & /help
// TIDAK menyentuh bot "Kintara mining" (punya user). Baca snapshot lokal saja.
const fs = require('fs');
const path = require('path');
let TG_TOKEN = process.env.REPORT_TG_TOKEN || '';
if (!TG_TOKEN) { try { TG_TOKEN = fs.readFileSync('/home/agentuser/kintara-bot/recon/nous-token','utf8').trim(); } catch {} }
if (!TG_TOKEN) { console.error('no token'); process.exit(1); }
const DIR = '/home/agentuser/kintara-bot/recon/multi';
const LOG = '/home/agentuser/kintara-bot/recon/nous-ctl.log';
const log = (...a) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}\n`); } catch {} console.error(a.join(' ')); };

async function api(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
function hLevels() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.levels.json')); } catch { return '⚠️ Folder snapshot gak ada.'; }
  if (!files.length) return '⚠️ Belum ada snapshot (runner belum nulis).';
  const now = Date.now();
  const rows = files.map((f) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const age = Math.round((now - d.updated) / 60000);
      const stale = age > 30;
      const l = d.levels || {};
      const lv = [l.combat, l.woodcutting, l.mining, l.fishing, l.cooking].map((x) => x ?? '?').join('/');
      return `${stale ? '⚠️' : '✅'} <b>${d.name}</b>: ${lv} <i>(${age} mnt lalu)</i>`;
    } catch { return `❌ ${f}: corrupt`; }
  }).sort();
  return ['📊 <b>Level Semua Akun</b> (combat/wood/mining/fish/cook)', ...rows].join('\n');
}
(async () => {
  let offset = 0;
  // sync offset awal
  const u0 = await api('getUpdates', { offset: -1, limit: 1 });
  if (u0.ok && u0.result.length) offset = u0.result[0].update_id + 1;
  log('nous-ctl boot, offset', offset);
  for (;;) {
    try {
      const r = await api('getUpdates', { offset, timeout: 50 });
      if (!r.ok) { log('getUpdates gagal:', JSON.stringify(r).slice(0, 120)); await new Promise((s) => setTimeout(s, 15000)); continue; }
      for (const up of r.result || []) {
        offset = up.update_id + 1;
        const msg = up.message; if (!msg || !msg.text) continue;
        const cmd = msg.text.split(' ')[0].replace(/@.*$/, '');
        let out = null;
        if (cmd === '/levels') out = hLevels();
        else if (cmd === '/help' || cmd === '/start') out = '🤖 <b>NOUSAGNT — Kintara farm reports</b>\n/levels — 📊 level semua akun (snapshot lokal, instan)\n/help — ini';
        if (out) await api('sendMessage', { chat_id: msg.chat.id, text: out, parse_mode: 'HTML' });
      }
    } catch (e) { log('loop err:', e.message); await new Promise((s) => setTimeout(s, 10000)); }
  }
})();
