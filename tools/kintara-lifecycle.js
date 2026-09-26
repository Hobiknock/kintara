#!/usr/bin/env node
/**
 * kintara-lifecycle.js — end-to-end akun kintara dari .env multi-wallet
 *
 * ENV (.env, format):
 *   WALLETS=pk1
 * pk2
 * pk3            (multi-line, 1 pk per baris — parser baca block WALLETS= sampai baris kosong/EOF)
 *   --atau--
 *   WALLETS=pk1,pk2,pk3   (comma)
 *   REPORT_TG_TOKEN= / REPORT_TG_CHAT=   (opsional — lapor fase 3 ke Telegram)
 *   KINTARA_FORCE_SERVER= / KINTARA_ZONE= (opsional)
 *   SELL_THRESHOLD=10000  (stone/coal per akun sebelum auto-sell)
 *   SELL_USD=0.01         (harga listing token USD)
 *
 * FASE:
 *   1) tutorial + outfit random + semua skill ke lv 5 (sequential 1 akun 1 waktu)
 *   2) rock mining (stone&coal) semua akun, mining cap lv 10
 *   3) seleksi: wallet pegang >=1000 $KINS? lanjut mining; tidak → lapor TG daftar ineligible
 *   4) cek umur KINS (transfer pertama >=24 jam) + auto-sell 10000 stone/coal per akun di market (floor)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { KintaraClient } = require('../lib/kintaraClient');
const loops = require('./farm-loops');
const bank = require('../lib/bank');

// ---------- .env loader (root repo) ----------
const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  // multi-line WALLETS block
  let inWallets = false; const walletLines = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('WALLETS=')) {
      const v = line.slice(8).trim();
      if (v) walletLines.push(v); // inline comma or first pk
      inWallets = true; continue;
    }
    if (inWallets) {
      if (/^[A-Z_0-9]+=/.test(line)) { inWallets = false; } // next var — block selesai, lanjut parse var ini
      else { if (line.trim()) walletLines.push(line.trim()); continue; }
    }
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
  if (walletLines.length) {
    const pks = walletLines.join(',').split(',').map(s => s.trim()).filter(Boolean);
    process.env.WALLET_LIST = pks.join(',');
  }
}
loadEnv();

// ---------- utils ----------
const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (a,b) => a + Math.floor(Math.random()*(b-a));

function getPks() {
  let v = process.env.WALLET_LIST || process.env.WALLETS || '';
  if (!v.trim()) { log('TIDAK ADA WALLET di .env (WALLETS=) — keluar'); process.exit(1); }
  return v.split(',').map(s=>s.trim()).filter(Boolean);
}

const TG_TOKEN = process.env.REPORT_TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.REPORT_TG_CHAT || process.env.TELEGRAM_CHAT_ID || '';
function report(text) {
  if (!TG_TOKEN || !TG_CHAT) { log('[tg] (skip, no token) ' + text.split('\n')[0]); return; }
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode:'HTML' })
  }).catch(e=>log('tg err: '+e.message));
}

let srv4 = 0;
const LISTS_PER_ITEM = Number(process.env.LISTS_PER_ITEM || 1);
const PER_LISTING = Number(process.env.PER_LISTING || 5000);
const KEEP_IN_INV = Number(process.env.KEEP_IN_INV || 5000);

// ---------- Solana RPC helpers ----------
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const KINS_MINT = process.env.KINS_MINT || 'Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump';
const bs58m = require('bs58'); const bs58 = bs58m.default || bs58m;
const nacl = require('tweetnacl');
async function rpc(method, params, retry = 4) {
  for (let i = 0; i < retry; i++) {
    try {
      const r = await fetch(RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0',id:1,method,params}) });
      if (r.status === 429) { await sleep(6000); continue; }
      return await r.json();
    } catch (e) { if (i === retry-1) throw e; await sleep(3000); }
  }
}
function pubkeyOf(pk) { return bs58.encode(nacl.sign.keyPair.fromSecretKey(bs58.decode(pk)).publicKey); }
async function kinsBalance(pk) {
  const owner = pubkeyOf(pk);
  const r = await rpc('getTokenAccountsByOwner', [owner, {mint: KINS_MINT}, {encoding:'jsonParsed'}]);
  const accs = (r.result && r.result.value) || [];
  let raw = 0; for (const a of accs) raw += Number(a.account.data.parsed.info.tokenAmount.amount);
  return raw / 1e6;
}
async function kinsAgeDays(pk) {
  const owner = pubkeyOf(pk);
  const r = await rpc('getTokenAccountsByOwner', [owner, {mint: KINS_MINT}, {encoding:'jsonParsed'}]);
  const accs = (r.result && r.result.value) || [];
  if (!accs.length) return -1;
  const s = await rpc('getSignaturesForAddress', [accs[0].pubkey, {limit: 1000}]);
  const sigs = (s.result || []).filter(x => x.blockTime);
  if (!sigs.length) return -1;
  const first = sigs[sigs.length-1].blockTime;
  return (Date.now()/1000 - first) / 86400;
}

// ---------- makeCtx (copy dari headless-runner — helper wajib) ----------
function makeCtx(name) {
  const ctxRef = { stopRequested: false };
  const ctx = {
    name, bump(k){ this[k] = (this[k]||0)+1; }, get(k){ return this[k]||0; },
    stop(){ return ctxRef.stopRequested; }, onEvent: (m)=>log(`[${name}] ${m}`), onImportant: (m)=>log(`[${name}!] ${m}`),
    _lastBeat: Date.now(),
  };
  Object.defineProperty(ctx, '_stop', {    set(v) { ctxRef.stopRequested = !!v; },
    get() { return ctxRef.stopRequested; },
    configurable: true,
  });
  return ctx;
}

// ---------- outfit random ----------
async function applyRandomOutfit(cli) {
  try {
    const me = await cli.me();
    if (me.outfit && me.outfit.hat != null) { log('outfit sudah ada — skip'); return; }
    const rnd=(n)=>Math.floor(Math.random()*n), hex=()=>rnd(0xffffff);
    const outfit = { outfitSchema:15, hat:rnd(6), top:rnd(8), pants:rnd(6), shoe:rnd(5),
      hatC:hex(), topC:hex(), pantsC:hex(), shoeC:hex(), strapC:hex(), skinTone:1+rnd(6),
      aura:null,cape:null,eyeFx:null,hatFx:null,wings:null,topFx:null,shoeFx:null,glasses:null,
      faceMask:null,handProp:null,torsoDecal:null,pantsPattern:null,shoeCosmetic:null };
    const r = await cli.saveOutfit({ outfit });
    const me2 = await cli.me(); // VERIFY — jangan percaya ok saja
    if (me2.outfit && me2.outfit.hat != null) log(`🎨 outfit terpasang (hat=${outfit.hat} top=${outfit.top})`);
    else log('⚠️ outfit save ok tapi me.outfit kosong — retry sekali');
  } catch (e) { log('outfit gagal: ' + e.message); }
}

// ---------- fase 1 ----------
const SKILLS = ['combat','woodcutting','mining','fishing','cooking'];
async function levelStats(cli) {
  const st = await cli.playerStats(cli.player.id).catch(()=>null);
  return st && st.skillXp ? st : null;
}
const { levelFromTotalXp } = require('../lib/skillXp');
async function allAt5(cli) {
  const st = await levelStats(cli); if (!st || !st.skillXp) return false;
  return SKILLS.every(k => levelFromTotalXp(st.skillXp[k] || 0) >= 5); // semua skill benar2 lv 5
}
async function phase1(cli, tag) {
  // tutorial
  let tctx = makeCtx('tutorial'); tctx.cli = cli;
  let t = await loops.runTutorial(tctx);
  if (t && t.step != null && t.step >= 0 && t.step < 28) {
    await sleep(5000); await loops.runTutorial(tctx).catch(()=>{});
  } else log(`[${tag}] tutorial tuntas`);
  await applyRandomOutfit(cli);
  // push skills ke 5 — URUTAN ACAK per akun (mulai random: bisa mining dulu, wood, combat, dll)
  const order = ['combat','wood','rock','fish','cook'];
  const start = Math.floor(Math.random() * order.length);
  const rotated = [...order.slice(start), ...order.slice(0, start)];
  log(`[${tag}] 🔀 urutan push acak: ${rotated.join(' → ')}`);
  let guard = 0;
  while (!(await allAt5(cli)) && guard++ < 40) {
    for (const mode of rotated) {
      const fn = { combat:()=>loops.runCombat(makeCtx2(mode,cli),{dragon:false}), wood:()=>loops.runWood(makeCtx2(mode,cli)), rock:()=>loops.runRock(makeCtx2(mode,cli)), fish:()=>loops.runFish(makeCtx2(mode,cli)), cook:()=>loops.runCook(makeCtx2(mode,cli)) };
      try { await fn[mode](); } catch(e) { log(`[${tag}] ${mode} err: ${e.message.slice(0,60)}`); }
      if (await allAt5(cli)) break;
    }
  }
  log(`[${tag}] FASE 1 ${await allAt5(cli) ? 'SELESAI ✅' : 'belum (guard) '}`);
}
function makeCtx2(name, cli) { const c = makeCtx(name); c.cli = cli; c.capLevel = 5; return c; }

// ---------- fase 2: rock mining, cap lv 10 ----------
async function phase2(cli, tag) {
  for (let i=1;;i++) {
    const ctx = makeCtx('rock'); ctx.cli = cli; ctx.capLevel = 10; // mining cap lv 10 (free user)
    ctx.autoBankMin = Number(process.env.SELL_THRESHOLD || 10000);
    log(`[${tag}] rock sesi ${i}`);
    try { await loops.runRock(ctx); } catch(e) { log(`[${tag}] rock err: ${e.message.slice(0,60)}`); }
    await sleep(10000);
    try { await cli.ensureLogin(); } catch {}
  }
}

// ---------- fase 4: auto-sell ----------
// AUTO-LISTING DIMATIKAN (25 Sep, atas permintaan user): fee on-chain game menguras SOL
// (~$11,5 dari w1/w12/w16). SETELAH sini: hasil mining aman di inventory/bank game (gratis),
// jual manual nanti kalau mau. Untuk aktifkan lagi: KINTARA_AUTOLIST=1 di .env.
async function autoSell(cli, tag, items = ['stone','coal'], totalTarget = Number(process.env.SELL_THRESHOLD||10000)) {
  if (process.env.KINTARA_AUTOLIST !== '1') {
    log(`[${tag}] 📴 auto-listing OFF (hemat fee SOL) — hasil mining disimpan di inv/bank game`);
    return { sold: 0, skipped: true };
  }
  const p = await loops.connectPresence(cli, (m)=>log(`[${tag}] ${m}`)).catch(e=>{ throw new Error('presence: '+e.message); });
  try {
    await sleep(2500);
    await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 60 }).catch(()=>{});
    // hitung listing aktif — max 5 (kita pakai 4: 2 stone + 2 coal per siklus)
    const mine = await cli.marketplaceListings({ mine:true, limit: 50 });
    let active = (mine.listings || []).length;
    const MAX_LISTINGS = 5, MAX_PER_LISTING = PER_LISTING;
    let remainingSlots = Math.max(0, MAX_LISTINGS - active);
    if (!remainingSlots) {
      log(`[${tag}] listing penuh (${active}/5) — sisanya yang over disimpan ke bank`);
      try {
        const meB = await cli.me(); const bpB = meB.backpack || {};
        const over = (Number(bpB.stone)||0) + (Number(bpB.coal)||0) - KEEP_IN_INV;
        if (false && over > 1000) {
          // harus ada presence utk walk ke bank — reuse sesi p yang udah nyambung
          await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 60 }).catch(()=>{});
          const r = await bank.depositAll(cli, ['stone','coal']);
          log(`[${tag}] 🏦 banked (fallback): ${(r.moved||[]).join(', ') || 'tidak ada yang pindah'}`);
        }
      } catch(e) { log(`[${tag}] bank fallback err: ${e.message.slice(0,60)}`); }
      return;
    }
    const me = await cli.me(); const bp = me.backpack || {};
    const inv = bp.invSlots || [];
    let totalListed = 0;
    for (const itemType of items) {
      if (remainingSlots <= 0) {
        log(`[${tag}] slot listing habis — sisanya disimpan ke bank`);
        try {
          const meB = await cli.me(); const bpB = meB.backpack || {};
          const overB = (Number(bpB.stone)||0) + (Number(bpB.coal)||0) - KEEP_IN_INV;
          if (false && overB > 1000) {
            await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 60 }).catch(()=>{});
            const rb = await bank.depositAll(cli, ['stone','coal']);
            log(`[${tag}] 🏦 banked (sisa listing): ${(rb.moved||[]).join(', ') || 'tidak ada yang pindah'}`);
          }
        } catch(e) { log(`[${tag}] bank sisa err: ${e.message.slice(0,60)}`); }
        break;
      }
      // ATURAN SIKLUS: butuh LISTS_PER_ITEM × PER_LISTING stok per item — kalau belum, jangan list (tunggu kumpul)
      const needPerItem = LISTS_PER_ITEM * PER_LISTING; // 10000 per item
      let qtyTotal = Number(bp[itemType]) || 0;
      if (qtyTotal < needPerItem) {
        log(`[${tag}] ${itemType} ${qtyTotal} < ${needPerItem} (${LISTS_PER_ITEM}x${PER_LISTING}) — jangan list dulu, tunggu kumpul`);
        continue;
      }
      const stats = await cli.marketplaceStats(itemType);
      let left = Math.min(qtyTotal, needPerItem);
      let listedThisItem = 0;
      while (left >= 1000 && remainingSlots > 0 && listedThisItem < LISTS_PER_ITEM) {
        const chunk = Math.min(PER_LISTING, left); // 5000/listing
        // slot index diambil fresh tiap listing (backpack berubah setelah listing)
        const meNow = await cli.me();
        const invNow = (meNow.backpack || {}).invSlots || [];
        const idx = invNow.findIndex(s => s && s.t === itemType && (Number(s.n)||0) >= Math.min(chunk, 100));
        if (idx < 0) { log(`[${tag}] slot ${itemType} tidak cukup untuk chunk ${chunk}`); break; }
        const priceUsd = Math.max(0.01, (stats.floorToken || 0.000029) * chunk);
        try {
          const r = await cli.marketplaceSell({ itemType, slotKind:'inv', slotIndex:idx, quantity:chunk, currency:'token', priceUsd:Number(priceUsd.toFixed(2)), fleet:'', shardId:'' });
          if (r && r.ok !== false) {
            log(`[${tag}] 🏷️ listed ${chunk} ${itemType} @ ${priceUsd.toFixed(2)} USD (${remainingSlots-1} slot sisa)`);
            totalListed += chunk; listedThisItem++; remainingSlots--; left -= chunk;
          } else { log(`[${tag}] listing ${itemType} ditolak: ${JSON.stringify(r).slice(0,80)}`); break; }
        } catch(e) { log(`[${tag}] sell ${itemType} err: ${e.message.slice(0,80)}`); break; }
        await sleep(rnd(2000, 4000)); // humanlike antar listing
      }
    }
  } finally {
    try { p.close(); } catch {}
  }
}

// helper: simpan kelebihan stok (di atas KEEP_IN_INV) ke bank — butuh presence aktif
async function bankOverflow(cli, tag, items = ['stone','coal']) {
  // FITUR BANK DIMATIKAN (permintaan user) — stok tetap di inventory untuk listing
  return false;
}
async function bankOverflowDisabled(cli, tag, items = ['stone','coal']) {
  try {
    const me = await cli.me(); const bp = me.backpack || {};
    const tot = items.reduce((a,t)=>a+(Number(bp[t])||0),0);
    if (tot <= KEEP_IN_INV) return false;
    const p = await loops.connectPresence(cli, (m)=>log(`[${tag}] ${m}`));
    try {
      await sleep(2000);
      await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 60 }).catch(()=>{});
      const r = await bank.depositAll(cli, items);
      log(`[${tag}] 🏦 banked: ${(r.moved||[]).join(', ') || 'tidak ada yang pindah'}`);
      return true;
    } finally { try { p.close(); } catch {} }
  } catch(e) { log(`[${tag}] bankOverflow err: ${e.message.slice(0,60)}`); return false; }
}

// ---------- orchestrator ----------
(async () => {
  const pks = getPks();
  log(`BOOT lifecycle — ${pks.length} wallet`);
  const state = pks.map((pk,i) => ({ idx:i, pk, tag:'w'+(i+1), cli:null, phase:1 }));
  const FORCE_SERVER = process.env.KINTARA_FORCE_SERVER || '';

  const openClient = async (s, retries = 20) => {
    for (let a = 1; a <= retries; a++) {
      try {
        const { client } = await KintaraClient.create({ privateKey: s.pk, forceLogin: true });
        s.cli = client; return client;
      } catch (e) {
        if (/registration_blocked|rate_limited|502|challenge/i.test(e.message) && a < retries) {
          log(`${s.tag} login ditahan server (${e.message.slice(0,50)}) — retry ${a}/${retries} dalam 60 dtk`);
          await sleep(60000);
          continue;
        }
        throw e;
      }
    }
    throw new Error('login gagal terus');
  };

  // DETEKSI FASE AWAL per wallet — skip fase yang udah beres:
  // semua skill >=5? skip F1 → mining>=10? skip F2 → KINS>=1000 & umur>=24h? skip F3 → langsung F4 (autosell)
  const paywalled = [];
  for (const s of state) {
    try {
      const cli = await openClient(s);
      log(`${s.tag} login ok player=${cli.player && cli.player.id}`);
      s._name = cli.player?.display_name || cli.player?.name || null; // nama akun in-game buat laporan
      // DETEKSI PAYWALL: freeTier=true berarti lv10+ tanpa 1000 KINS — server-side gated
      try {
        const me0 = await cli.get('/api/auth/me');
        s.freeTier = !!me0.freeTier;
        if (s.freeTier) {
          s.paywalled = true;
          paywalled.push(`${s.tag} (lv10+ tanpa KINS — free play habis)`);
          log(`${s.tag} 🔒 freeTier=true — PAYWALL (lv10 tanpa KINS): tidak bisa mining/listing sampai punya 1000 KINS`);
          continue;
        }
        log(`${s.tag} freeTier=false — free play / eligible`);
      } catch(e) { log(`${s.tag} freeTier check err: ${e.message.slice(0,50)}`); }
      const st = await levelStats(cli);
      const all5 = st && st.skillXp && SKILLS.every(k => levelFromTotalXp(st.skillXp[k]||0) >= 5);
      if (!all5) { s.phase = 1; log(`${s.tag} → mulai FASE 1`); continue; }
      log(`${s.tag} semua skill ≥5 — SKIP FASE 1`);
      const alv = Number(st.avg) || 0;
      if (alv < 10) { s.phase = 2; log(`${s.tag} level akun=${alv.toFixed(1)} <10 → mulai FASE 2 (rock)`); continue; }
      log(`${s.tag} level akun=${alv.toFixed(1)} ≥10 — SKIP FASE 2`);
      const bal = await kinsBalance(s.pk);
      if (bal < 1000) { s.phase = 3; s.kins = bal; log(`${s.tag} kins=${bal} <1000 → tunggu FASE 3`); continue; }
      const age = await kinsAgeDays(s.pk);
      if (age < 1.0) { s.phase = 3; s.kins = bal; s.kinsAge = age; log(`${s.tag} kins=${bal} umur ${age.toFixed(1)}h <24jam → tunggu FASE 3/4`); continue; }
      s.phase = 4; s.kins = bal; s.kinsAge = age;
      log(`${s.tag} kins=${bal} umur ${age.toFixed(1)}d — LANGSUNG FASE 4 (autosell)`);
    } catch(e) { log(`${s.tag} deteksi gagal: ${e.message.slice(0,80)}`); }
    await sleep(rnd(15000, 30000));
  }
  // (laporan paywall ke Telegram dihapus atas permintaan user — hanya tercatat di log lokal)

  // FASE 1 — PARALEL 1/1 (per permintaan user 25 Sep): tiap wallet langsung dapat sesi F1-nya
  // sendiri di screen terpisah — w2 gak nunggu w1 selesai. Jeda login antar wallet 15-30 dtk
  // tetap ada (anti rate-limit per IP), tapi setelah login semua jalan BERSAMAAN.
  {
    const { execSync } = require('child_process');
    for (const s of state.filter(x => x.phase === 1)) {
      log(`=== ${s.tag} FASE 1 — launch paralel ===`);
      const name = `f1-${s.tag}`;
      try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {}
      execSync(`screen -dmS ${name} bash -c "node ${ROOT}/tools/f1-runner.js '${s.pk}' >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
      await sleep(rnd(15000, 30000)); // stagger login anti rate-limit
    }
  }

  // FASE 2 — mining rock (stone & coal) SAJA setelah semua skill lv 5.
  // Skill lain berhenti di lv 5 (nggak di-push lagi). Stop saat LEVEL AKUN (avg) >= 10.
  const { execSync, spawn } = require('child_process');
  // LEVEL AKUN = avg semua skill (st.avg dari playerStats)
  const accountLevelOf = async (cli) => {
    const st = await cli.playerStats(cli.player.id).catch(()=>null);
    return st ? (Number(st.avg) || 0) : 0;
  };
  // buat sesi mining berkelanjutan per wallet — hanya yang phase=2 (mining <10)
  // SEBAR ke berbagai server: round-robin 12-16 asia
  const SERVERS = (process.env.KINTARA_SERVERS || '12,13,14,15,16').split(',').map(n=>n.trim()).filter(Boolean);
  let srvIdx = 0;
  for (const s of state) {
    if (s.phase !== 2) continue;
    if (s.paywalled) { log(`${s.tag} 🔒 paywalled — SKIP FASE 2 mining`); continue; }
    const name = `lc-${s.tag}`;
    const srv = FORCE_SERVER || SERVERS[srvIdx % SERVERS.length];
    srvIdx++;
    try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {}
    const envSrv = `KINTARA_FORCE_SERVER=${srv} `;
    execSync(`screen -dmS ${name} bash -c "${envSrv}KINTARA_NO_PHASE2=1 node ${ROOT}/tools/headless-runner.js '${s.pk}' rock >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
    log(`${s.tag} → screen ${name} (fase 2 rock @ server ${srv} — lanjut sampai level akun ≥10)`);
    await sleep(20000);
  }
  // FASE 4 — ROLLBACK: mining rock biasa (Pond/World), tetap: hanya ≥1000 KINS
  // LOGIN 1/1: 1 wallet = 1 server DEDICATED (nggak dipakai wallet lain selama sesi ini)
  {
    log('⛏️ MODE ROCK — login 1/1: setiap wallet di server BERBEDA (dedicated)');
    // kandidat server: RR 12-16 + sisanya (9,10,11,1-7) — cukup buat 21 wallet 1/1
    const allServers = ['12','13','14','15','16','9','10','11','1','2','3','4','5','6','7'];
    const usedServers = new Set();
    let wi = 0;
    for (const s of state) {
      const name = `lc-${s.tag}`;
      if (s.paywalled) { log(`${s.tag} 🔒 paywalled — SKIP (paywall aktif)`); continue; }
      let bal = 0;
      try { bal = await kinsBalance(s.pk); } catch (e) { log(`${s.tag} kins check err: ${e.message.slice(0,50)}`); }
      s._lastKins = bal;
      if (bal < 1000) {
        s.kinsBlocked = true;
        log(`${s.tag} 🚫 kins=${bal} <1000 — TIDAK mining (tanpa KINS gabisa farming)`);
        try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {}
        continue;
      }
      s.kinsBlocked = false;
      // pilih server yang BELUM dipakai wallet lain (1/1)
      const srv = allServers.find(x => !usedServers.has(x)) || allServers[wi % allServers.length];
      usedServers.add(srv); s._srv = srv; wi++;
      try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {}
      execSync(`screen -dmS ${name} bash -c "KINTARA_FORCE_SERVER=${srv} KINTARA_NO_PHASE2=1 node ${ROOT}/tools/headless-runner.js '${s.pk}' rock >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
      log(`${s.tag} ⛏️ kins=${bal} — rock mining @ server ${srv} (DEDICATED 1/1) (screen ${name})`);
      await sleep(15000);
    }
    // ===== LAPORAN MINING (jam-jaman + /update on-demand) =====
    // Snapshot hasil dari recon/multi/lc-wN.out → format laporan → Telegram.
    // /update di Telegram = laporan instan tanpa nunggu 1 jam.
    const _hourly = { lastAt: Date.now(), snap: {}, _p: Date.now() };
    const readLast = (f, re) => { try { const t = fs.readFileSync(path.join(ROOT, 'recon/multi', f), 'utf8').match(new RegExp(re, 'g')); return t ? Number(String(t[t.length - 1]).replace(/\D/g, '')) || 0 : 0; } catch { return 0; } };
    const readFelled = (f) => { try { return fs.readFileSync(path.join(ROOT, 'recon/multi', f), 'utf8').split('rock felled').length - 1; } catch { return 0; } };
    async function buildReport() {
      const now = Date.now();
      const dtMin = Math.max(1, Math.round((now - _hourly._p) / 60000));
      const lines = []; let totS = 0, totC = 0, totF = 0;
      for (const s of state) {
        if (s.paywalled || s.kinsBlocked) continue;
        const f = `lc-${s.tag}.out`;
        const st = readLast(f, 'stone\\+\\d+'), co = readLast(f, 'coal\\+\\d+'), fel = readFelled(f);
        const dS = st - (_hourly.snap[s.tag]?.st || 0), dC = co - (_hourly.snap[s.tag]?.co || 0), dF = fel - (_hourly.snap[s.tag]?.fel || 0);
        _hourly.snap[s.tag] = { st, co, fel };
        totS += dS; totC += dC; totF += dF;
        lines.push(`▸ ${s._name || s.tag} @srv${s._srv || '?'} — ${dS.toLocaleString('id-ID')} stone + ${dC.toLocaleString('id-ID')} coal = <b>${(dS + dC).toLocaleString('id-ID')} ore</b> (${dF.toLocaleString('id-ID')} node)`);
      }
      _hourly._p = now;
      const jam = Math.round(dtMin / 60 * 10) / 10;
      return `📊 <b>LAPORAN MINING</b> (${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} — ${dtMin} mnt)\n${lines.join('\n')}\n\n<b>TOTAL: ${totS.toLocaleString('id-ID')} stone + ${totC.toLocaleString('id-ID')} coal = ${(totS + totC).toLocaleString('id-ID')} ore</b> (${totF.toLocaleString('id-ID')} node dipanen, ~${Math.round((totS + totC) / jam).toLocaleString('id-ID')} ore/jam)`;
    }
    (async () => { // jam-jaman
      for (;;) {
        await sleep(10 * 60 * 1000);
        if (Date.now() - _hourly.lastAt < 60 * 60 * 1000) continue;
        _hourly.lastAt = Date.now();
        await report(await buildReport());
      }
    })();
    (async () => { // /update on-demand (polling Telegram, dedupe via offset di memori)
      let off = 0;
      for (;;) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${off}${TG_TOKEN ? '' : '&x=1'}`);
          const j = await r.json();
          for (const u of (j.result || [])) {
            off = u.update_id + 1;
            const msg = u.message || {};
            const cmd = String(msg.text || '').trim().split(/\s+/)[0];
            if (!cmd || String(msg.chat?.id) !== String(TG_CHAT)) continue;
            if (cmd === '/update' || cmd === '/status') {
              log(`[tg] ${cmd} dari user — kirim laporan instan`);
              await report(await buildReport());
            } else if (cmd === '/help') {
              await report('📖 <b>Command bot farm:</b>\n/update — laporan mining instan\n/status — sama dengan /update\n/help — daftar command');
            }
          }
        } catch (e) { log(`[tg poll] err: ${e.message.slice(0, 40)}`); }
        await sleep(3000);
      }
    })();
    // watchdog: jaga screen hidup + re-cek KINS (habis → stop; dapat → mulai)
    for (;;) {
      await sleep(5 * 60 * 1000);
      for (const s of state) {
        const name = `lc-${s.tag}`;
        const alive = (() => { try { execSync(`screen -ls | grep -q ${name}`); return true; } catch { return false; } })();
        let bal = s._lastKins || 0;
        try { bal = await kinsBalance(s.pk); s._lastKins = bal; } catch {}
        // re-cek paywall (wallet free play bisa naik lv10 saat bot jalan)
        if (!s.paywalled && s.cli) {
          try {
            const me0 = await s.cli.get('/api/auth/me');
            if (me0.freeTier) {
              s.paywalled = true;
              log(`${s.tag} 🔒 BARU kena paywall (lv10+ tanpa KINS) — mining dihentikan`);
            }
          } catch {}
        }
        if (s.paywalled && bal < 1000) {
          if (!s.kinsBlocked) log(`${s.tag} 🚫 paywall + kins=${bal} <1000 — tetap di-stop`);
          s.kinsBlocked = true;
          if (alive) { try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {} }
          continue;
        } else if (s.paywalled && bal >= 1000) {
          log(`${s.tag} ✅ kins=${bal} ≥1000 — paywall lewat, mining lanjut`);
          s.paywalled = false;
        }
        if (bal < 1000) {
          if (!s.kinsBlocked) log(`${s.tag} 🚫 kins=${bal} <1000 — mining DI-STOP`);
          s.kinsBlocked = true;
          if (alive) { try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {} }
          usedServers.delete(String(s._srv || ''));
          continue;
        }
        if (s.kinsBlocked) { log(`${s.tag} ✅ kins=${bal} ≥1000 — mulai mining`); s.kinsBlocked = false; }
        if (!alive) {
          // respawn: tetap pakai server dedicated-nya sendiri
          const srv = s._srv || allServers.find(x => !usedServers.has(x)) || allServers[wi % allServers.length];
          usedServers.add(srv); s._srv = srv;
          execSync(`screen -dmS ${name} bash -c "KINTARA_FORCE_SERVER=${srv} KINTARA_NO_PHASE2=1 node ${ROOT}/tools/headless-runner.js '${s.pk}' rock >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
          log(`${s.tag} 🔁 respawn rock mining @ ${srv} (dedicated)`);
          await sleep(10000);
        }
      }
    }
  }

  // FASE 3 — seleksi KINS (loop jam-jaman; iterasi pertama langsung jalan) — PARALEL
  const phase3Loop = (async () => {
  
  for (let iter = 0; ; iter++) {
    if (iter > 0) await sleep(15 * 60 * 1000);
    log('=== FASE 3 cek KINS ===');
    const ineligible = [];
    for (const s of state) {
      try {
        const bal = await kinsBalance(s.pk);
        const age = bal >= 1000 ? await kinsAgeDays(s.pk) : -1;
        log(`${s.tag} kins=${bal} age=${age.toFixed(1)}d`);
        s._lastKins = bal;
        if (bal < 1000) ineligible.push(`${s.tag} (${pubkeyOf(s.pk).slice(0,8)}… kins=${bal})`);
        // GATE: tanpa 1000 KINS → stop mining & jangan listing (aturan gabisa farming)
        if (bal < 1000) {
          s.kinsBlocked = true;
          const name = `lc-${s.tag}`;
          const alive = (() => { try { execSync(`screen -ls | grep -q ${name}`); return true; } catch { return false; } })();
          if (alive) {
            try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {}
            log(`${s.tag} 🚫 kins=${bal} <1000 — mining DI-STOP (gabisa farming tanpa KINS)`);
          }
          await sleep(1000);
          continue;
        }
        s.kinsBlocked = false;
        // FASE 4: umur >= 24 jam → siklus jual-mining
        if (bal >= 1000 && age >= 1.0) {
          try {
            const now = Date.now();
            const lastList = s.lastListingAt || 0;
            const hoursSince = (now - lastList) / 3600000;
            // wajib: >= 3 jam sejak listing terakhir
            if (lastList && hoursSince < 3) {
              log(`${s.tag} baru listing ${hoursSince.toFixed(1)}j lalu — mining dulu (listing berikut ≥3j)`);
            } else {
              const cli = s.cli || await openClient(s);
              const me = await cli.me();
              const bp = me.backpack || {};
              const stock = (Number(bp.stone)||0) + (Number(bp.coal)||0);
              // listing lama yang belum laku → cancel dulu, tarik stoknya balik biar bisa re-list
              try {
                const mine = await cli.marketplaceListings({ mine:true, limit: 50 });
                const rows = (mine && (mine.listings || mine.data || mine)) || [];
                if (Array.isArray(rows) && rows.length) {
                  for (const L of rows) {
                    const id = L.listingId || L.id; if (!id) continue;
                    const qty = Number(L.quantity || L.qty || 0);
                    log(`${s.tag} listing lama ${L.itemType} x${qty} belum laku — cancel`);
                    try { await cli.marketplaceCancel(id); } catch(e){ log(`${s.tag} cancel err: ${e.message.slice(0,50)}`); }
                    await sleep(rnd(1500,3000));
                  }
                }
              } catch(e) { log(`${s.tag} cek listing lama err: ${e.message.slice(0,60)}`); }
              // setelah cancel, baca ulang backpack — item canceled balik ke inv
              const me2 = await cli.me();
              const bp2 = me2.backpack || {};
              const stockS = (Number(bp2.stone)||0), stockC = (Number(bp2.coal)||0);
              // LISTING PER ITEM: stone dan coal berdiri sendiri — yang sudah cukup langsung dilist, jangan nunggu item lain
              let listedAny = false;
              if (stockS >= PER_LISTING) {
                log(`${s.tag} stone=${stockS} ≥ ${PER_LISTING} — list stone langsung (tanpa nunggu coal)`);
                await autoSell(cli, s.tag, ['stone'], PER_LISTING);
                listedAny = true;
                await sleep(rnd(2000,4000));
              }
              if (stockC >= PER_LISTING) {
                log(`${s.tag} coal=${stockC} ≥ ${PER_LISTING} — list coal langsung (tanpa nunggu stone)`);
                await autoSell(cli, s.tag, ['coal'], PER_LISTING);
                listedAny = true;
                await sleep(rnd(2000,4000));
              }
              if (listedAny) {
                s.lastListingAt = Date.now();
                log(`${s.tag} 🏷️ listing selesai — wajib mining 3 jam sebelum listing lagi`);
                // AUTO-BANK fallback: sisanya (di atas KEEP_IN_INV) masuk bank
                await bankOverflow(cli, s.tag, ['stone','coal']);
              } else {
                log(`${s.tag} stok stone=${stockS} coal=${stockC} (butuh ${PER_LISTING}/item) — belum cukup untuk list apapun, mining dulu`);
                await bankOverflow(cli, s.tag, ['stone','coal']); // jaga inv tetap ada ruang
              }
            }
            // pastikan mining rock jalan (apapun kondisi di atas, setelah listing / selama nunggu 3 jam)
            const { execSync } = require('child_process');
            const name = `lc-${s.tag}`;
            const alive = (() => { try { execSync(`screen -ls | grep -q ${name}`); return true; } catch { return false; } })();
            if (!alive) {
              const srv = `KINTARA_FORCE_SERVER=${SERVERS[srv4++ % SERVERS.length]} `;
              execSync(`screen -dmS ${name} bash -c "${srv}KINTARA_NO_PHASE2=1 node ${ROOT}/tools/headless-runner.js '${s.pk}' rock >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
              log(`${s.tag} ⛏️ mining rock jalan (screen ${name}) — cek: tail -f recon/multi/${name}.out`);
              // verifikasi screen beneran hidup
              await sleep(3000);
              const ok = (() => { try { execSync(`screen -ls | grep -q ${name}`); return true; } catch { return false; } })();
              if (!ok) {
                log(`${s.tag} ⚠️ screen ${name} gagal hidup — coba lagi 10 dtk`);
                await sleep(10000);
                execSync(`screen -dmS ${name} bash -c "${srv}KINTARA_NO_PHASE2=1 node ${ROOT}/tools/headless-runner.js '${s.pk}' rock >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
                log(`${s.tag} mining respawn attempt 2`);
              }
            } else {
              log(`${s.tag} ⛏️ screen ${name} udah jalan — mining tetap jalan (cek tail -f recon/multi/${name}.out)`);
            }
          } catch(e) { log(`${s.tag} fase4 err: ${e.message.slice(0,60)}`); }
        }
      } catch(e) { log(`${s.tag} kins check err: ${e.message.slice(0,60)}`); }
      await sleep(1500);
    }
    // KOREKSI ATURAN: akun avg level >=10 TANPA 1000 KINS → TIDAK BOLEH farming.
    // Stop screen mining-nya dan tandai ineligible (screen dijaga tetap mati).
    for (const s of state) {
      try {
        const bal = s._lastKins !== undefined ? s._lastKins : await kinsBalance(s.pk);
        s._lastKins = bal;
        if (bal < 1000) {
          const name = `lc-${s.tag}`;
          const alive = (() => { try { execSync(`screen -ls | grep -q ${name}`); return true; } catch { return false; } })();
          if (alive) {
            try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {}
            log(`${s.tag} 🚫 kins=${bal} <1000 & level ≥10 — mining DI-STOP (aturan: tanpa KINS gabisa farming)`);
          }
          s.kinsBlocked = true;
        } else {
          if (s.kinsBlocked) log(`${s.tag} ✅ kins=${bal} ≥1000 — farming boleh jalan lagi`);
          s.kinsBlocked = false;
        }
      } catch(e) { log(`${s.tag} kins-gate err: ${e.message.slice(0,60)}`); }
      await sleep(1000);
    }
    // WATCHDOG: log .out runner stale >15 menit → respawn screen
    for (const s of state) {
      if (s.phase < 2) continue;
      if (s.kinsBlocked) continue; // TANPA KINS: jangan respawn mining
      try {
        const name = `lc-${s.tag}`;
        const f = `${ROOT}/recon/multi/${name}.out`;
        const st2 = require('fs').statSync(f);
        if (Date.now() - st2.mtimeMs > 15 * 60 * 1000) {
          log(`${s.tag} ⏰ log stale >15m — respawn screen ${name}`);
          try { execSync(`screen -S ${name} -X quit 2>/dev/null`); } catch {}
          await sleep(2000);
          const srv = `KINTARA_FORCE_SERVER=${SERVERS[srv4++ % SERVERS.length]} `;
          execSync(`screen -dmS ${name} bash -c "${srv}KINTARA_NO_PHASE2=1 node ${ROOT}/tools/headless-runner.js '${s.pk}' rock >> ${ROOT}/recon/multi/${name}.out 2>&1"`);
          await sleep(1500);
        }
      } catch {}
    }
    // (lapor eligible/ineligible dihapus atas permintaan user — cukup log lokal)
  }
  })();

  // monitor level akun: cek tiap 15 menit; avg level >= 10 → STOP script akun itu (screen quit)
  for (;;) {
    await sleep(15 * 60 * 1000);
    for (const s of state) {
      if (!s.cli || s.phase >= 3) continue;
      try {
        const alv = await accountLevelOf(s.cli);
        if (alv >= 10) {
          try { execSync(`screen -S lc-${s.tag} -X quit 2>/dev/null`); } catch {}
          s.phase = 3;
          log(`${s.tag} level akun=${alv.toFixed(1)} ≥ 10 — FASE 2 selesai, mining STOP, masuk seleksi FASE 3 (harus hold 1000 KINS)`);
        } else {
          log(`${s.tag} level akun=${alv.toFixed(1)} < 10 — mining rock lanjut`);
        }
      } catch(e) { log(`${s.tag} level check err: ${e.message.slice(0,60)}`); }
      await sleep(1500);
    }
    // begitu semua fase 2 selesai → keluar dari monitor ke fase 3
    if (state.every(s => s.phase >= 3)) break;
  }


  // monitor fase-2 tetap jalan bersamaan
})().catch(e => { log('FATAL ' + e.message); process.exit(1); });
