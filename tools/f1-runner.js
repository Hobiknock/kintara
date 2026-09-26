// f1-runner.js — FASE 1 paralel per wallet: push semua skill ke lv5, lalu exit.
// Dipanggil: node tools/f1-runner.js '<pk>'  (satu proses = satu wallet = satu screen f1-wN)
const path = require('path');
const ROOT = path.join(__dirname, '..');
const bs58 = require('bs58').default || require('bs58');
const fs = require('fs');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { KintaraClient } = require(path.join(ROOT, 'lib/kintaraClient'));
const loops = require(path.join(ROOT, 'tools/farm-loops.js'));
const { levelFromTotalXp } = require(path.join(ROOT, 'lib/skillXp'));

const PK = process.argv[2];
if (!PK) { console.error('Pakai: node tools/f1-runner.js <privateKey>'); process.exit(1); }
const TAG = 'w' + (function () {
  try {
    const pub = new PublicKey(bs58.decode(PK).slice(32)).toBase58();
    const { loadPks } = require(path.join(ROOT, 'lib/parseWallets'));
    const pks = loadPks();
    const i = pks.findIndex(x => { try { return new PublicKey(bs58.decode(x).slice(32)).toBase58() === pub; } catch { return false; } });
    return i >= 0 ? i + 1 : '?';
  } catch { return '?'; }
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('id-ID')}] ${m}`);
const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];

function makeCtx(name) {
  const ctxRef = { stopRequested: false };
  const ctx = {
    name, bump(k){ this[k] = (this[k]||0)+1; }, get(k){ return this[k]||0; },
    stop(){ return ctxRef.stopRequested; }, // closure — imun destructured-call (this hilang)
    onEvent: (m) => log(`[${name}] ${m}`), onImportant: (m) => log(`[${name}!] ${m}`),
    _lastBeat: Date.now(),
  };
  Object.defineProperty(ctx, '_stop', { set(v){ ctxRef.stopRequested = !!v; }, get(){ return ctxRef.stopRequested; } });
  return ctx;
}
const makeCtx2 = (name, cli) => { const c = makeCtx(name); c.cli = cli; c.capLevel = 5; return c; };

(async () => {
  log(`f1-runner ${TAG} start`);
  const wrapper = await KintaraClient.create({ privateKey: PK, forceLogin: true });
  const cli = wrapper.client;
  const player = wrapper.player || cli.player;
  log(`[${TAG}] login ok player=${player?.id}`);

  // URUTAN FAIR-ROTASI: tiap wallet mulai dari skill acak BEDA (anti rebutan node),
  // lalu urut tetap; skill yang gagal macet (mis. wood kehabisan pohon) di-skip
  // maksimal 2 putaran beruntun supaya skill lain kebagian.
  const BASE_ORDER = ['combat', 'wood', 'rock', 'fish', 'cook'];
  const startIdx = (TAG_num) => (TAG_num - 1) % BASE_ORDER.length; // w1→combat, w2→wood, w3→rock, w4→fish, w5→cook
  const TAG_num = Number((TAG.match(/w(\d+)/) || [0, 1])[1]);
  const rotate = (arr, n) => [...arr.slice(n), ...arr.slice(0, n)];
  const failStreak = {}; // mode → berapa putaran gagal macet
  let guard = 0;
  while (guard++ < 120) {
    // re-check level tiap putaran
    const st = await cli.playerStats(player.id).catch(() => null);
    if (!st) { await sleep(10000); continue; }
    const sx = st.skillXp || {};
    const lvOf = {};
    for (const k of SKILLS) lvOf[k] = levelFromTotalXp(sx[k] || 0);
    if (SKILLS.every(k => lvOf[k] >= 5)) { log(`[${TAG}] FASE 1 SELESAI ✅`); break; }

    const order = rotate(BASE_ORDER, startIdx(TAG_num));
    // FAIR-ROTASI KETAT: skill yang macet >=2x DI-LOCK 3 putaran — jangan dicoba lagi
    // sampai skill lain kebagian (cegah wood ngabisin semua waktu saat node sepi)
    const locked = {};
    for (const m of order) if ((failStreak[m] || 0) >= 2) locked[m] = (locked[m] || 0) + 1;
    const usable = order.filter(m => !locked[m] || locked[m] >= 3);
    for (const m of order) if (locked[m] && locked[m] >= 3) locked[m] = 0; // reset lock setelah 3 putaran
    if (usable.length === 0) { await sleep(30000); continue; }
    order.length = 0; order.push(...usable);
    // naikkan skill yang macet ke akhir urutan biar yang lain jalan dulu
    order.sort((a, b) => (failStreak[a] || 0) - (failStreak[b] || 0));
    for (const mode of order) {
      const key = { combat: 'combat', wood: 'woodcutting', rock: 'mining', fish: 'fishing', cook: 'cooking' }[mode];
      if (lvOf[key] >= 5) { failStreak[mode] = 0; continue; } // skill ini udah — skip
      const lvBefore = lvOf[key];
      log(`[${TAG}] sesi ${mode} (lv ${lvBefore})`);
      const fn = {
        combat: () => loops.runCombat(makeCtx2(mode, cli), { dragon: false }),
        wood: () => loops.runWood(makeCtx2(mode, cli)),
        rock: () => loops.runRock(makeCtx2(mode, cli)),
        fish: () => loops.runFish(makeCtx2(mode, cli)),
        cook: () => loops.runCook(makeCtx2(mode, cli)),
      };
      let errMuted = false;
      try { await fn[mode](); } catch (e) { log(`[${TAG}] ${mode} err: ${e.message.slice(0, 60)}`); errMuted = true; }
      // cek naik tidak — kalau tidak, tandai macet
      const st2 = await cli.playerStats(player.id).catch(() => null);
      const lvAfter = st2 ? levelFromTotalXp((st2.skillXp || {})[key] || 0) : lvBefore;
      if (lvAfter > lvBefore) failStreak[mode] = 0;
      else failStreak[mode] = (failStreak[mode] || 0) + 1;
      if (failStreak[mode] >= 2) log(`[${TAG}] ⏭️ ${mode} macet ${failStreak[mode]}x — diprioritaskan belakangan`);
      await sleep(rnd(5000, 10000));
      break; // kembali ke atas → re-check level & pilih skill berikutnya
    }
  }
  log(`[${TAG}] f1-runner exit (guard=${guard})`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
