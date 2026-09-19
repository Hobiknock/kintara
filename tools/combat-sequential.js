#!/usr/bin/env node
// combat-sequential.js — jalanin SEMUA akun mode COMBAT SATU-SATU (tidak paralel).
// Tiap akun: grind combat sampai lv 5 (atau udah >=5 langsung skip) → lanjut akun berikutnya.
// Loop terus: kalau semua udah lv5+, tidur 30 menit lalu cek lagi (kalau ada yang turun kebawah 5, dikit).
const fs = require('fs');
const { loadKeypair } = require('/home/agentuser/kintara-bot/lib/walletAuth');
const bs58 = require('bs58').default || require('bs58');
const KintaraMod = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const KintaraClient = KintaraMod.KintaraClient || KintaraMod.default || KintaraMod;
const loops = require('/home/agentuser/kintara-bot/tools/farm-loops');
const { levelFromTotalXp } = require('/home/agentuser/kintara-bot/lib/skillXp');

const WALLETS = [
  ...fs.readFileSync('/home/agentuser/wallets-batch2.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean),
  ...fs.readFileSync('/home/agentuser/wallets-batch3.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean),
];
const OUT = '/home/agentuser/kintara-bot/recon/multi';
const LOG = OUT + '/combat-sequential.log';
const STATE = OUT + '/combat-seq-state.json';
const TARGET = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => { try { fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${m}\n`); } catch {} console.log(m); };

const walletId = pk => bs58.encode(Buffer.from(loadKeypair(pk).publicKey)).slice(0, 8);
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

function makeCtx() {
  const ctx = { name: 'combat', _stop: false, _lastBeat: Date.now(), counters: {}, cli: null,
    stop: () => { ctx._stop = true; },
    bump: (k) => { ctx.counters[k] = (ctx.counters[k] || 0) + 1; ctx._lastBeat = Date.now(); },
    get: (k) => ctx.counters[k] || 0,
    onEvent: () => {}, onImportant: () => {} };
  return ctx;
}

async function combatLevel(cli) {
  const st = await cli.playerStats(cli.player?.id).catch(() => null);
  return st ? levelFromTotalXp((st.skillXp || {}).combat || 0) : null;
}

(async () => {
  log('🚀 combat-sequential start — ' + WALLETS.length + ' wallet, satu-per-satu');
  const state = loadState();
  for (;;) {
    for (let i = 0; i < WALLETS.length; i++) {
      const pk = WALLETS[i];
      const wid = walletId(pk);
      let created;
      try {
        created = await KintaraClient.create({ privateKey: pk, forceLogin: true });
      } catch (e) {
        log(`[${i + 1}/${WALLETS.length}] ${wid} login gagal: ${e.message} — skip, lanjut akun berikut`);
        continue;
      }
      const cli = created.client || created;
      const name = (created.player?.displayName || created.player?.display_name || cli.player?.displayName || cli.player?.id || wid);
      let lv = await combatLevel(cli);
      if (lv == null) { log(`${name}: gagal baca level — skip`); continue; }
      if (lv >= TARGET) {
        log(`✅ ${name} combat udah lv ${lv} — skip`);
        state[wid] = { name, combat: lv, done: Date.now() };
        saveState(state);
        continue;
      }
      log(`⚔️ ${name} combat lv ${lv} — mulai grind ke ${TARGET}...`);
      const t0 = Date.now();
      // grind: sesi combat berulang sampai capai target
      while ((lv = await combatLevel(cli)) != null && lv < TARGET) {
        const ctx = makeCtx(); ctx.cli = cli;
        try { await loops.runCombat(ctx, { dragon: false }); }
        catch (e) { log(`  ⚠️ combat err: ${e.message.slice(0, 60)}`); await sleep(30000); }
        try { await cli.ensureLogin(); } catch {}
      }
      const mins = Math.round((Date.now() - t0) / 60000);
      if (lv != null) {
        log(`🎯 ${name} combat capai lv ${lv} (${mins} menit) — lanjut akun berikutnya`);
        state[wid] = { name, combat: lv, done: Date.now() };
        saveState(state);
      }
    }
    log('🔄 satu putaran semua akun selesai — tidur 30 menit, lalu cek lagi');
    await sleep(30 * 60 * 1000);
  }
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
