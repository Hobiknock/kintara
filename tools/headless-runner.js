#!/usr/bin/env node
// headless-runner.js v2 — 1 wallet tanpa Telegram.
// Urutan: SELESAIKAN TUTORIAL dulu → lalu mode (auto = push semua skill ke lvl 5,
// setelah semua lvl 5 → fokus mining terus).
// Usage: node headless-runner.js <privateKeyBase58> [mode]   mode: auto (default) | rock | wood | fish | combat | tutorial-only
const fs = require('fs');
const path = require('path');
const BOT = '/home/agentuser/kintara-bot';
const { KintaraClient } = require(BOT + '/lib/kintaraClient');
const loops = require(BOT + '/tools/farm-loops');
const { loadKeypair } = require(BOT + '/lib/walletAuth');
const bs58 = require('bs58').default || require('bs58');
// report OFF by default (19 Sep: user minta stop kirim ke NOUSAGNT) — cuma jalan kalau REPORT_TG_TOKEN di-set
const TG_TOKEN = process.env.REPORT_TG_TOKEN || '';
const TG_CHAT = process.env.REPORT_TG_CHAT || '';
const report = (text) => { if (!TG_TOKEN) return; return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
}).catch((e) => log('tg report gagal: ' + e.message)); };

const PK = process.argv[2];
const MODE = (process.argv[3] || 'auto').toLowerCase();
if (!PK) { console.error('private key required'); process.exit(1); }

const OUT = BOT + '/recon/multi';
fs.mkdirSync(OUT, { recursive: true });


// ANTI-DOBEL v2: lockfile — proses kedua dgn pk sama langsung exit
try {
  const lockDir = 'recon/multi/.lock-' + require('crypto').createHash('md5').update(PK).digest('hex').slice(0,12);
  try {
    const st = require('fs').statSync(lockDir);
    // cek pemilik masih hidup?
    const ownerPid = Number(require('fs').readFileSync(lockDir + '/pid', 'utf8'));
    try { process.kill(ownerPid, 0); console.log('⛔ runner pk sama sudah jalan (pid ' + ownerPid + ') — exit'); process.exit(0); }
    catch { require('fs').rmSync(lockDir, { recursive: true, force: true }); } // pid mati → ambil alih
  } catch {}
  require('fs').mkdirSync(lockDir, { recursive: true });
  require('fs').writeFileSync(lockDir + '/pid', String(process.pid));
} catch {}

const WALLET_ID = bs58.encode(Buffer.from(loadKeypair(PK).publicKey)).slice(0, 8);
let CHAR_NAME = '';
const LOG = path.join(OUT, WALLET_ID + '.log');
const log = (...a) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}\n`); } catch {} console.error(a.join(' ')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// format laporan level-up persis gaya /skills (telegram-ctl)
let _lastStats = null;
function levelUpReport(m) {
  return `${CHAR_NAME || WALLET_ID}\n${m}`;
}

function makeCtx(name) {
  const ctx = { name, _stop: false, _lastBeat: Date.now(), counters: {}, cli: null, stop: () => ctx._stop,
    bump: (k) => { ctx.counters[k] = (ctx.counters[k] || 0) + 1; ctx._lastBeat = Date.now(); },
    get: (k) => ctx.counters[k] || 0,
    onEvent: (m) => { ctx._lastBeat = Date.now(); log(`[${name}] ${m}`); },
    onImportant: (m) => {
      log(`[!] ${m}`);
      if (m.includes('LEVEL UP')) report(levelUpReport(m));
      else report(`${CHAR_NAME || WALLET_ID}\n${m}`);
    } };
  return ctx;
}

// ---- baca skill XP dari /api (playerStats) — format: {skillXp:{combat,woodcutting,mining,fishing,cooking}} ----
const SKILL_XP_TABLE = (() => {
  // level N dicapai di total XP = sum 2^(i) *? — bot pakai levelFromTotalXp di lib/skillXp; pakai itu langsung.
  return require(BOT + '/lib/skillXp');
})();
const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];
const TARGET_LVL = 5;

function skillLevels(st) {
  const xp = st?.skillXp || {};
  const out = {};
  for (const s of SKILLS) out[s] = SKILL_XP_TABLE.levelFromTotalXp(xp[s] || 0);
  return out;
}
const allAtTarget = (lv) => SKILLS.every((s) => (lv[s] || 0) >= TARGET_LVL);

// ---- snapshot level ke file (dibaca /levels telegram-ctl, tanpa login ulang) ----
const LEVELS_FILE = path.join(OUT, WALLET_ID + '.levels.json');
let _lastSnapshotMs = 0;
async function snapshotLevels(cli) {
  try {
    const st = await cli.playerStats(cli.player?.id).catch(() => null);
    if (!st) return;
    _lastStats = st;
    const lv = skillLevels(st);
    const me = await cli.me().catch(() => null);
    fs.writeFileSync(LEVELS_FILE, JSON.stringify({
      updated: Date.now(),
      name: CHAR_NAME || me?.player?.display_name || WALLET_ID,
      levels: lv,
    }));
  } catch {}
}
setInterval(() => { if (globalThis._runCli) snapshotLevels(globalThis._runCli); }, 10 * 60 * 1000).unref();

// mapping skill → loop yang nge-push skill itu (kebalikan: fishing+cooking 1 flow di runFish)
const SKILL_LOOP = {
  combat: (ctx) => loops.runCombat(ctx, { dragon: false }),
  woodcutting: (ctx) => loops.runWood(ctx),
  mining: (ctx) => loops.runRock(ctx),
  fishing: (ctx) => loops.runFish(ctx), // fishing + auto-cook = naikin 2 skill sekaligus
  cooking: (ctx) => loops.runFish(ctx),
};

// ---- FASE 1: push semua skill sampai lvl 5, prioritas yang terendah dulu ----
async function phase1ToLevel5(cli) {
  const phase1 = {};
  for (let round = 1; round <= 200; round++) {
    // ROTASI 10+10: kalau file pause ada -> sleep 10 menit (gantian antar akun, kurangi 502 & rebutan spot)
    try {
      const fs = require('fs');
      const pauseFile = `recon/multi/${WALLET_ID}.pause`;
      if (fs.existsSync(pauseFile)) {
        log('⏸️ slot gantian — sleep 10 menit (hapus ' + pauseFile + ' utk aktif lagi)');
        await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
        continue;
      }
    } catch {}
    const st = await cli.playerStats(cli.player?.id).catch(() => null);
    if (!st) { log('gagal baca stats, retry 60s'); await sleep(60000); continue; }
    _lastStats = st;
    const lv = skillLevels(st);
    log(`[fase1 r${round}] lv: ${SKILLS.map((s) => `${s[0]}${lv[s]}`).join(' ')}`);
    // laporan Telegram saat semua skill capai lvl 5
    if (!phase1._notified && allAtTarget(lv)) {
      phase1._notified = true;
      if (false) report(`🎉 <b>${CHAR_NAME || WALLET_ID}</b> — SEMUA SKILL LV 5 ✅\n${SKILLS.map((s) => `• ${s}: lvl ${lv[s]}`).join('\n')}\n➡️ lanjut FASE 2: mining terus`); // USER: fase-1 tuntas JANGAN lapor Tele — langsung mining diam
    }
    // pilih skill: STICKY — lanjutkan skill yang sedang dikerjakan sampai lv 5
    // (gak pindah-pindah), baru pindah ke skill tertinggal berikutnya.
    const below = [];
    for (const s of SKILLS) {
      const eff = (s === 'cooking') ? Math.min(lv.fishing || 0, lv.cooking || 0) : lv[s];
      if (eff < TARGET_LVL) below.push({ s, eff });
    }
    let pick = 'mining';
    if (below.length) {
      if (phase1._current && below.some((b) => b.s === phase1._current)) {
        pick = phase1._current; // lanjutkan skill sekarang sampai lv 5
      } else {
        // pilih skill tertinggal berikutnya (terendah dulu, acak kalau seri)
        // ⚠️ PRIORITAS: fishing & cooking PALING TERAKHIR — push skill lain dulu baru mereka
        const prio = (s) => (s === 'fishing' || s === 'cooking') ? 100 : 0;
        below.sort((a, b) => (a.eff + prio(a.s)) - (b.eff + prio(b.s)));
        const minVal = below[0].eff + prio(below[0].s);
        const tied = below.filter((b) => b.eff + prio(b.s) === minVal);
        pick = tied[Math.floor(Math.random() * tied.length)].s;
        phase1._current = pick;
      }
      // skill selesai (capai lv5) → reset sticky di iterasi berikut
      const eff = (pick === 'cooking') ? Math.min(lv.fishing || 0, lv.cooking || 0) : lv[pick];
      if (eff >= TARGET_LVL) phase1._current = null;
    }
    // jitter jeda antar akun biar gak sinkron (2-20 detik acak)
    const jitterMs = 2000 + Math.floor(Math.random() * 18000);
    log(`[fase1 r${round}] push ${pick} (lv ${lv[pick]})`);
    const ctx = makeCtx(pick);
    ctx.cli = cli;
    ctx.capLevel = TARGET_LVL; // JANGAN lewat lv 5 — sesi berhenti saat skill nyentuh cap
    ctx.manual = true; // bahan potion habis → panen wood sendiri (woodcutting dulu sebelum combat), jgn abort
    try { await SKILL_LOOP[pick](ctx); } catch (e) { log(`[fase1] ${pick} error: ${e.message}`); }
    // fase selesai krn error → tunggu dikit, lanjut round berikutnya (loop luar re-cek level)
    await sleep(5000 + jitterMs);
    try { await cli.ensureLogin(); } catch {}
  }
  return allAtTarget(skillLevels((await cli.playerStats(cli.player?.id).catch(() => ({}))) || {}));
}

// ---- FASE 2: mining terus tanpa henti ----
async function phase2Mining(cli) {
  for (let i = 1; ; i++) {
    const ctx = makeCtx('mining');
    ctx.cli = cli;
    log(`[fase2] mining sesi ${i}`);
    try { await loops.runRock(ctx); } catch (e) { log(`[fase2] error: ${e.message}`); }
    await sleep(10000);
    try { await cli.ensureLogin(); } catch (e) { log('relogin gagal: ' + e.message); await sleep(60000); }
  }
}

// ---- OUTFIT RANDOM: pasang sebelum fase 1 ----
async function applyRandomOutfit(cli) {
  try {
    const me = await cli.me();
    const cur = me.outfit || {};
    const rnd = (n) => Math.floor(Math.random() * n);
    const hex = () => rnd(0xffffff);
    const outfit = {
      outfitSchema: 15,
      hat: rnd(6), top: rnd(8), pants: rnd(6), shoe: rnd(5),
      hatC: hex(), topC: hex(), pantsC: hex(), shoeC: hex(), strapC: hex(),
      skinTone: 1 + rnd(6),
      aura: null, cape: null, eyeFx: null, hatFx: null, wings: null,
      topFx: null, pantsFx: null, shoeFx: null, glasses: null,
      faceMask: null, handProp: null, torsoDecal: null, pantsPattern: null, shoeCosmetic: null,
    };
    const r = await cli.saveOutfit(outfit);
    if (r?.ok) { cli._outfitCache = outfit; log(`🎨 outfit random terpasang (hat=${outfit.hat} top=${outfit.top} pants=${outfit.pants} shoe=${outfit.shoe})`); }
    else log('outfit save: ' + JSON.stringify(r).slice(0, 100));
  } catch (e) { log('outfit gagal (lanjut tanpa outfit): ' + e.message); }
}

(async () => {
  log(`BOOT wallet=${WALLET_ID} mode=${MODE}`);
  const created = await KintaraClient.create({ privateKey: PK, forceLogin: true });
  const cli = created.client || created; // create() balikin {client, player}
  log(`login ok player=${created.player?.displayName || created.player?.id || cli.player?.id}`);
  try { const me0 = await cli.me(); CHAR_NAME = me0?.player?.display_name || me0?.player?.displayName || ''; } catch {}
  globalThis._runCli = cli;
  await snapshotLevels(cli);

  // LANGKAH 1 (WAJIB): selesaikan tutorial dulu
  const tctx = makeCtx('tutorial');
  tctx.cli = cli;
  log('📖 jalankan tutorial...');
  const t = await loops.runTutorial(tctx);
  if (t && t.step != null && t.step >= 0 && t.step < 28) {
    log(`⚠️ tutorial belum tuntas (step ${t.step + 1}/28) — coba sekali lagi`);
    await sleep(5000);
    await loops.runTutorial(tctx).catch((e) => log('tutorial retry gagal: ' + e.message));
  } else {
    log('✅ tutorial tuntas / akun bukan akun baru');
  }

  // LANGKAH 1.5: outfit random
  await applyRandomOutfit(cli);

  // LANGKAH 2: mode
  if (MODE === 'tutorial-only') { log('selesai (tutorial-only)'); return; }
  if (MODE === 'auto') {
    const done = await phase1ToLevel5(cli);
    if (done) { if (process.env.KINTARA_NO_PHASE2 === "1") { log("fase1 tuntas — keluar (no phase2)"); process.exit(0); } await phase2Mining(cli); }
  } else if (['rock', 'wood', 'fish', 'combat'].includes(MODE)) {
    const fns = { rock: loops.runRock, wood: loops.runWood, fish: loops.runFish, combat: (ctx) => loops.runCombat(ctx, { dragon: false }) };
    for (;;) { const ctx = makeCtx(MODE); ctx.cli = cli; try { await fns[MODE](ctx); } catch (e) { log('err: ' + e.message); } await sleep(30000); try { await cli.ensureLogin(); } catch {} }
  } else { log('mode tidak dikenal'); process.exit(1); }
})().catch((e) => { log('FATAL BOOT ' + e.message); process.exit(1); });
