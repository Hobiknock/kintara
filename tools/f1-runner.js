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
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/WALLETS=((?:[^\n#]*\n?)+)/);
    let pks = m[1].split('\n').map(x => x.trim()).filter(Boolean);
    if (pks.length === 1 && pks[0].includes(',')) pks = pks[0].split(',');
    const i = pks.findIndex(x => { try { return new PublicKey(bs58.decode(x).slice(32)).toBase58() === pub; } catch { return false; } });
    return i >= 0 ? i + 1 : '?';
  } catch { return '?'; }
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('id-ID')}] ${m}`);
const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];

function makeCtx(name) {
  return {
    name, bump(k){ this[k] = (this[k]||0)+1; }, get(k){ return this[k]||0; },
    stop(){ return this._stop === true; },
    onEvent: (m) => log(`[${name}] ${m}`), onImportant: (m) => log(`[${name}!] ${m}`),
    _lastBeat: Date.now(),
  };
}
const makeCtx2 = (name, cli) => { const c = makeCtx(name); c.cli = cli; c.capLevel = 5; return c; };

(async () => {
  log(`f1-runner ${TAG} start`);
  const wrapper = await KintaraClient.create({ privateKey: PK, forceLogin: true });
  const cli = wrapper.client;
  const player = wrapper.player || cli.player;
  log(`[${TAG}] login ok player=${player?.id}`);

  let guard = 0;
  while (guard++ < 40) {
    // re-check level tiap putaran
    const st = await cli.playerStats(player.id).catch(() => null);
    if (!st) { await sleep(10000); continue; }
    const sx = st.skillXp || {};
    const lvOf = {};
    for (const k of SKILLS) lvOf[k] = levelFromTotalXp(sx[k] || 0);
    if (SKILLS.every(k => lvOf[k] >= 5)) { log(`[${TAG}] FASE 1 SELESAI ✅`); break; }

    // urutan acak per putaran
    const order = ['combat', 'wood', 'rock', 'fish', 'cook'].sort(() => Math.random() - 0.5);
    for (const mode of order) {
      const key = { combat: 'combat', wood: 'woodcutting', rock: 'mining', fish: 'fishing', cook: 'cooking' }[mode];
      if (lvOf[key] >= 5) continue; // skill ini udah — skip
      log(`[${TAG}] sesi ${mode} (lv ${lvOf[key]})`);
      const fn = {
        combat: () => loops.runCombat(makeCtx2(mode, cli), { dragon: false }),
        wood: () => loops.runWood(makeCtx2(mode, cli)),
        rock: () => loops.runRock(makeCtx2(mode, cli)),
        fish: () => loops.runFish(makeCtx2(mode, cli)),
        cook: () => loops.runCook(makeCtx2(mode, cli)),
      };
      try { await fn[mode](); } catch (e) { log(`[${TAG}] ${mode} err: ${e.message.slice(0, 60)}`); }
      await sleep(rnd(5000, 10000));
      break; // kembali ke atas → re-check level & pilih skill berikutnya
    }
  }
  log(`[${TAG}] f1-runner exit (guard=${guard})`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
