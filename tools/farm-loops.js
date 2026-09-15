// ============ FARM LOOPS — mesin aktivitas Kintara (dipakai telegram-ctl.js) ============
// Semua loop: connect presence (auto shard terpendek via resolveServer), jalan
// sampai stopRequested, auto-reconnect, lapor via callback onEvent(text).
// Dipanggil telegram-ctl.js; JANGAN jalanin langsung.
const fs = require('fs');
const path = require('path');
const { KintaraClient } = require('../lib/kintaraClient');
const { Presence } = require('../lib/presenceWs');
const gs = require('../lib/gameState');
const bank = require('../lib/bank');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---- SPEED FACTOR (jeda client saja — timer protokol server TIDAK disentuh) ----
// 1.0 = pace asli. 1.5 = jeda client dipotong ~33%. KINTARA_SPEED di .env utk override.
const SPEED = Math.max(1, Math.min(3, Number(process.env.KINTARA_SPEED || 1.5)));
const ssleep = (ms) => sleep(Math.max(60, Math.round(ms / SPEED)));
const rnd = (a, b) => a + Math.random() * (b - a);

// ============ INFRA (kintara.com baru — auto shard) ============
async function connectPresence(cli, onEvent, attempt = 0, forceShard = null) {
  try {
    const srv = await cli.resolveServer();
    // shard QUEUE url butuh format "sN" (string). srv.shardId udah "s2"; controllerId "s3" juga ok.
    // KINTARA_FORCE_SHARD=s4: bypass auto-pick (zona node per-shard beda — s4 ramai, node world banyak).
    // forceShard param: override per-panggilan (dipakai scanShardsForRocks — gak sentuh env global).
    const ctrl = String(srv.server?.controllerId || srv.controllerId || '');
    let shardStr;
    if (forceShard && /^s\d+$/.test(forceShard)) shardStr = forceShard;
    else if (/^s\d+$/.test(process.env.KINTARA_FORCE_SHARD || '')) shardStr = process.env.KINTARA_FORCE_SHARD;
    else if (/^s\d+$/.test(String(srv.shardId || ''))) shardStr = String(srv.shardId);
    else if (/^s\d+$/.test(ctrl)) shardStr = ctrl;
    else {
      const n = Number(srv.localShardId) > 0 ? Number(srv.localShardId) : 3;
      shardStr = 's' + n;
    }
    const wsBase = srv.wsBaseUrl;
    const base = String(wsBase || '').replace(/^wss:\/\//, '');
    // queue -> connectToken
    const connectToken = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${base}/ws/queue/${shardStr}`, { headers: { Cookie: cli.cookie, Origin: 'https://' + base } });
      const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('queue timeout')); }, 30000);
      ws.on('message', (buf) => { let d; try { d = JSON.parse(buf.toString()); } catch { return; }
        if (d.t === 'queue_ready') { clearTimeout(to); const t = d.connectToken || ''; try { ws.close(); } catch {} resolve(t); } });
      ws.on('error', (e) => { clearTimeout(to); reject(e); });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'q_ping' })));
    });
    const p = new Presence(shardStr, { clientRef: cli, wsBaseUrl: wsBase, connectToken });
    p.setCookie(cli.cookie, cli.player);
    p.tut = -1; // tutorial selesai (akun farm)
    p.on('log', () => {});
    await p.connect();
    await sleep(2500); // cdknya 5 dtk → 2,5 dtk (presence ack udah cukup buat multi-tick)
    return p;
  } catch (e) {
    if (attempt < 2) {
      onEvent && onEvent(`⚠️ connect gagal (${String(e.message).slice(0, 40)}) — retry ${attempt + 1}...`);
      await sleep(5000 * (attempt + 1));
      return connectPresence(cli, onEvent, attempt + 1, forceShard);
    }
    throw e;
  }
}

// pasang level-up watcher: tiap event skill_xp cek level naik → onImportant
function watchLevelUps(p, ctx) {
  if (!ctx || !ctx.onImportant) return;
  const { levelFromTotalXp } = require('../lib/skillXp');
  const last = {};
  p.on('skill_xp', (xp) => {
    try {
      for (const [skill, total] of Object.entries(xp || {})) {
        const lv = levelFromTotalXp(total);
        if (last[skill] != null && lv > last[skill]) ctx.onImportant(questPanel('LEVEL UP!', [['📈 ' + skill, 'lvl ' + lv + ' 🆙']], '🎉'));
        last[skill] = lv;
      }
    } catch {}
  });
}

// ============ PERSIST LOOT (client-authoritative, kunci dari rygroup) ============
// Yield v2026 (dari client resmi, nm()=6 hit per node @lv1): 1 node = 6 barang.
const NODE_YIELD = 6;
async function persistLoot(cli, loot, yld = NODE_YIELD) {
  try {
    const st = await gs.fetchState(cli); const bp = st.backpack; const slots = bp.invSlots || [];
    let put = false;
    for (const s of slots) if (s && s.t === loot) { s.n += yld; put = true; break; }
    if (!put) { const e = slots.findIndex((s) => !s); if (e >= 0) slots[e] = { t: loot, n: yld }; }
    bp[loot] = (Number(bp[loot]) || 0) + yld;
    const r = await gs.pushBackpack(cli, bp, st.stateSeq, []);
    return r?.backpack?.[loot] ?? null;
  } catch (e) { return null; }
}
// Queue serial non-blocking: loop gak nunggu 2.4 dtk save — save jalan di belakang, tetap urut (anti stateSeq race).
let _persistChain = Promise.resolve();
function persistLootAsync(cli, loot, yld = NODE_YIELD) {
  _persistChain = _persistChain.then(() => persistLoot(cli, loot, yld)).catch(() => {});
  return _persistChain;
}
async function flushPersist() { await _persistChain; }

function pickNodeFixed(p, kinds, avoid = null, avoidMs = 120000) {
  const here = { c: Math.round(p.pos.x - tileOff(p.region)), r: Math.round(p.pos.z - tileOff(p.region)) };
  const now = Date.now();
  let b = null, bd = Infinity;
  for (const kind of kinds) {
    for (const n of p.knownNodes(kind)) {
      if (n.seen < now - 600000) continue;
      if (avoid && avoid.has(n.key) && now - avoid.get(n.key) < avoidMs) continue; // baru gagal — tunggu respawn
      const h = n.h | 0, hm = n.hm | 0;
      if (hm > 0 && h >= hm) continue; // wear habis (depleted) — jangan pilih
      const un = n.until | 0;
      if (un > 0 && un < now + 15000) continue; // site expired/marked-old: node despawn — jangan pilih
      const [C, R] = n.key.split(',').map(Number);
      const d = Math.hypot(C - here.c, R - here.r);
      if (d > 0.5 && d < bd) { bd = d; b = n; }
    }
  }
  return b;
}

// ============ ZONA RESOURCE WORLD (dari bundle: rock col 6-12 row 46-53, tree sites col 4-14 row 45-54) ============
const WORLD_ROCK_C = { x: 9 - 30.5, z: 49.5 - 30.5 };   // pusat rock zone (col 9, row 49.5)
const WORLD_TREE_C = { x: 5.5 - 30.5, z: 22.5 - 30.5 }; // cluster tree live (col 3-8, row 19-26)

// Pulangkan player ke zona resource world (dipakai /auto sebelum rock/wood — dari pond/wild/eldergrove).
async function gotoResourceZone(p, onEvent, maxSec = 90, zone = 'rock') {
  // kalau bukan world: keluar via setRegion ke tile portal world yang sesuai
  if (p.region === 'pond') { try { p.setRegion('world', 30.5, 0.5); await sleep(3000); } catch {} }
  if (p.region === 'eldergrove') { try { await p.walkTo(0.5, -24.5, { maxSec: 25 }).catch(() => {}); p.setRegion('world', 0.5, 29.5); await sleep(3000); } catch {} }
  if (/^wild/.test(p.region || '')) { try { p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1); await sleep(3000); } catch {} }
  if (p.region !== 'world') return false;
  const c = zone === 'tree' ? WORLD_TREE_C : WORLD_ROCK_C;
  await p.walkTo(c.x, c.z, { maxSec }).catch(() => {});
  await sleep(1500);
  return p.region === 'world';
}

// offset tile per-region: world -30.5 | pond -19.5 | wild* -24.5
function tileOff(region) {
  if (/pond|desert/.test(region || '')) return -19.5;
  if (/^wild/.test(region || '')) return -24.5;
  return -30.5;
}

// ============ SCAN SHARD: cari shard yang node rock-nya HIDUP ============
// Node rock beda per-shard. Kalau zona pond & world dua-duanya steril di shard
// aktif, cek shard lain (s1..s6): connect singkat -> masuk world rock zone ->
// tunggu res_snap -> hitung node rock hidup. Balik daftar {shard, live} + best.
async function scanShardsForRocks(cli, onEvent, shardList = ['s1', 's2', 's3', 's4', 's5', 's6'], stop = null) {
  const results = [];
  for (const s of shardList) {
    if (stop && stop()) break; // /stop saat scan shard — jangan lanjut shard berikutnya
    let p = null;
    try {
      p = await connectPresence(cli, onEvent, 0, s);
      if (String(p.shard || '') !== s) { try { p.close(); } catch {} continue; } // connect nyasar — skip
      p.setRegion('world', 30.5, 0.5); await sleep(1200);
      await p.walkTo(9 - 30.5, 49.5 - 30.5, { maxSec: 30 }).catch(() => {}); // pusat zona rock world
      p.nodes = new Map(); // reset biar murni snap shard ini
      let wn = 0; while (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock')) && wn < 10000) { await sleep(500); wn += 500; }
      await sleep(1500);
      const live = p.knownNodes('rock').filter((n) => {
        const h = n.h | 0, hm = n.hm | 0;
        if (hm > 0 && h >= hm) return false;
        if (n.until > 0 && n.until < Date.now() + 15000) return false;
        return (n.seen || 0) > Date.now() - 300000;
      }).length;
      results.push({ shard: s, live });
      onEvent(`📡 shard ${s}: ${live} node rock hidup`);
      try { p.close(); } catch {}
    } catch (e) {
      onEvent(`📡 shard ${s}: skip (${String(e.message).slice(0, 30)})`);
      try { p && p.close(); } catch {}
    }
  }
  results.sort((a, b) => b.live - a.live);
  return results;
}

// ── keluar pond ke WORLD dengan pola terbukti: setRegion langsung (bukan walkTo) ──
// walkTo koordinat world dari pond = nyasar (region beda) → masak selalu gagal.
async function exitPondToWorld(p, onEvent, tx, tz) {
  if (p.region === 'pond') {
    try { p.setRegion('world', 30.5, 0.5); } catch {}
    let w = 0; while (p.region !== 'world' && w < 8000) { await sleep(1000); w += 1000; }
  }
  if (p.region === 'world') {
    await p.walkTo(tx, tz, { maxSec: 14 }).catch(() => {});
    await ssleep(800);
  }
  return p.region === 'world';
}

// Masuk Pond (pola runFish TERBUKTI): jalan ke portal world (30.5,0.5) → setRegion pond (-18.5,0.5).
// Return true kalau region === 'pond'.
async function gotoPond(p, onEvent, maxSec = 90) {
  if (p.region === 'pond') return true;
  onEvent && onEvent('🚶 ke Pond (portal timur)...');
  if (p.region !== 'world') {
    // dari region lain: pulang dulu ke world lewat portal masing-masing
    if (p.region === 'eldergrove') { try { await p.walkTo(0.5, -24.5, { maxSec: 25 }).catch(() => {}); p.setRegion('world', 0.5, 29.5); await sleep(3000); } catch {} }
    if (/^wild/.test(p.region || '')) { try { p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1); await sleep(3000); } catch {} }
    if (p.region !== 'world') return false;
  }
  try { await p.walkTo(30.5, 0.5, { maxSec }).catch(() => {}); } catch {}
  await sleep(800);
  if (Math.abs(p.pos.x - 30.5) > 2 || Math.abs(p.pos.z - 0.5) > 2) {
    try { p.setRegion('world', 30.5, 0.5); await sleep(2000); } catch {}
  }
  try { p.setRegion('pond', -18.5, 0.5); } catch {}
  let w = 0;
  while (p.region !== 'pond' && w < 20000) { await sleep(1000); w += 1000; }
  if (p.region === 'pond') { await sleep(2000); }
  return p.region === 'pond';
}

// ============ /rock — panen stone+coal (pace manusia: ~15 node/mnt) ============
async function runRock(ctx) {
  const { cli, stop, onEvent } = ctx;
  // mode: 'any' (default, stone+coal) | 'stone' (skip node coal) | 'coal' (HANYA node coal)
  const mode = ctx.mode || 'any';
  // zone: 'world' (default, zona rock lama) | 'pond' (ZONA BARU — node lebih rapat, respawn cepat)
  let zone = ctx.zone || 'pond'; const zone0 = zone; // zone dinamis: auto pindah pond↔world saat steril
  let emptyRotas = 0, sterilityCount = 0; // penghitung area kosong → trigger pindah zona/shard
  const wantCoal = mode === 'coal';
  const skipCoal = mode === 'stone';
  onEvent(`⛏️ Mulai panen ${mode === 'coal' ? 'COAL (khusus node coal)' : mode === 'stone' ? 'STONE (skip node coal)' : 'stone+coal'}${zone === 'pond' ? ' di POND 🎣' : ''}...`);
  const p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx); // notif LEVEL UP ke chat
  try { p.equip('tool_pickaxe'); } catch {} // human-like: bawa pickaxe pas mining
  if (zone === 'pond') {
    // masuk pond dulu (pola runFish) — node pond rapat & respawn deras
    if (!(await gotoPond(p, onEvent))) {
      onEvent('⚠️ gagal masuk pond — fallback ke zona rock world');
      if (!(await gotoResourceZone(p, onEvent))) onEvent(`⚠️ belum di zona rock (region=${p.region}) — coba node sekitar`);
    }
  } else if (!(await gotoResourceZone(p, onEvent))) onEvent(`⚠️ belum di zona rock (region=${p.region}) — coba node sekitar`);
  // tunggu res_snap ngisi node (pond butuh beberapa detik)
  let waitN = 0;
  while (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock')) && waitN < 20000) { await sleep(1000); waitN += 1000; }
  // Waypoint rotasi POND — 12 titik (tambah 2 biar rotasi lebih rapat, kurangi waktu jalan kosong)
  const POND_WP = [[8, -4], [14, 2], [10, 14], [2, 10], [-8, 12], [-14, 4], [-10, -4], [-2, -8], [6, 6], [-6, -6], [-18, -10], [18, 10]];
  let wpIdx = 0, skipStreak = 0, felledSinceMove = 0;
  const dead = new Map(); // key -> ts blacklist (node gagal/depleted)
  let stone = 0, coal = 0, metal = 0, fails = 0, skips = 0;
  while (!stop()) {
    const OFF = tileOff(p.region); // offset live — region bisa berubah pas reconnect
    let tgt = pickNodeFixed(p, ['rock'], dead);
    // filter sesuai mode
    if (tgt && skipCoal && tgt.hasCoal && !tgt.hasMetal) { // node coal murni — buang, tapi jangan blacklist (bisa dipanen mode lain)
      dead.set(tgt.key, Date.now()); skips++; tgt = null; let alt = pickNodeFixed(p, ['rock'], dead);
      while (alt && skipCoal && alt.hasCoal && !alt.hasMetal) { dead.set(alt.key, Date.now()); skips++; alt = pickNodeFixed(p, ['rock'], dead); }
      tgt = alt;
    }
    if (tgt && wantCoal && !tgt.hasCoal) { // mode coal: node bukan coal → blacklist sementara, cari node coal
      dead.set(tgt.key, Date.now()); skips++;
      const cands = [...p.knownNodes('rock')].filter((n) => n.hasCoal && !dead.has(n.key) && (n.seen || 0) > Date.now() - 600000);
      const me = { c: Math.round(p.pos.x - OFF), r: Math.round(p.pos.z - OFF) };
      if (cands.length) {
        cands.sort((a, b) => Math.hypot((a.key.split(',')[0] | 0) - me.c, (a.key.split(',')[1] | 0) - me.r) - Math.hypot((b.key.split(',')[0] | 0) - me.c, (b.key.split(',')[1] | 0) - me.r));
        tgt = cands[0];
      } else tgt = null;
    }
    if (!tgt) {
      // ROTASI AREA: gak ada node hidup sekitar sini → jalan ke waypoint pond berikutnya (jangan muter di tempat)
      if (zone === 'pond') {
        skipStreak++;
        if (skipStreak >= 3 || felledSinceMove === 0) {
          const wp = POND_WP[wpIdx % POND_WP.length]; wpIdx++;
          emptyRotas++; // tiap rotasi habisnya area = sinyal area steril
          onEvent(`🔄 area habis — rotasi ke titik ${wp[0]},${wp[1]}...`);
          await p.walkTo(wp[0], wp[1], { maxSec: 20 }).catch(() => {});
          await ssleep(rnd(500, 1000)); skipStreak = 0; felledSinceMove = 0;
          let wn = 0; while (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock')) && wn < 8000) { await sleep(1000); wn += 1000; }
          // AREA STERIL: 2x putaran waypoint penuh (24 rotasi) tanpa 1 pun felled → PINDAH ZONA otomatis
          if (emptyRotas >= POND_WP.length * 2 && felledSinceMove === 0) {
            emptyRotas = 0; sterilityCount++;
            dead.clear(); // blacklist node zona lama gak boleh ikut ke zona baru
            const target = zone === 'pond' ? 'world' : 'pond';
            onEvent(`🧭 zona ${zone} steril (${sterilityCount}x) — pindah ke ${target === 'pond' ? 'POND' : 'zona rock WORLD'}...`);
            let moved = false;
            if (target === 'pond') moved = await gotoPond(p, onEvent);
            else moved = await gotoResourceZone(p, onEvent);
            if (moved) zone = target; // FIX: sinkronkan var zone dgn region aktual (bug: muter WP pond di world)
            else { // gagal masuk zona target → tetap di zona lama, coba lagi nanti
              onEvent(`⚠️ gagal pindah ke ${target} — tetap di ${zone}`);
            }
            let wn2 = 0; while (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock')) && wn2 < 15000) { await sleep(1000); wn2 += 1000; }
            // DUA ZONA STERIL BERUNTUN (pond habis, world habis) → SCAN SEMUA SHARD, reconnect ke yang paling deras
            if (sterilityCount % 2 === 0 && fails >= 40 && felledSinceMove === 0) {
              onEvent('🛰️ dua zona steril — scan shard buat node rock hidup...');
              try { p.close(); } catch {} // tutup sesi lama dulu — jangan 2 sesi 1 akun pas scan
              const scan = await scanShardsForRocks(cli, onEvent, undefined, stop);
              const best = scan.find((x) => x.live >= 3);
              onEvent(`🛰️ hasil scan: ${scan.map((x) => `${x.shard}=${x.live}`).join(', ')}`);
              if (best) {
                onEvent(`🛰️ pindah shard ${best.shard} (${best.live} node hidup) — reconnect...`);
                try { p.close(); } catch {}
                const pn = await connectPresence(cli, onEvent, 0, best.shard);
                Object.assign(p, pn);
                dead.clear(); emptyRotas = 0; skipStreak = 0; felledSinceMove = 0;
                if (p.region !== 'pond') { await gotoPond(p, onEvent); } // pond dulu (respawn cepat), fallback world
                let wn3 = 0; while (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock')) && wn3 < 15000) { await sleep(1000); wn3 += 1000; }
                if (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock'))) { // pond kosong di shard baru → world
                  if (await gotoResourceZone(p, onEvent)) zone = 'world';
                  let wn4 = 0; while (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock')) && wn4 < 10000) { await sleep(1000); wn4 += 1000; }
                }
              } else {
                // breather 90 dtk → 9x (10 dtk + cek /stop) — /stop gak perlu nunggu 90 dtk
                onEvent('🛰️ semua shard steril — breather 90 dtk nunggu respawn (/stop responsif)...');
                for (let b = 0; b < 9 && !stop(); b++) await sleep(10000);
              }
            }
          }
          continue;
        }
      }
      if (dead.size) { dead.clear(); onEvent(`♻️ blacklist reset — cari node respawn${skips ? ` (${skips} skip mode ${mode})` : ''}`); skips = 0; }
      await ssleep(rnd(400, 800)); continue; // dipangkas
    }
    emptyRotas = 0; // node ketemu → area ada isi, reset penghitung steril
    // jalan dulu ke samping node (realistis, kaya orang) — jarak pendek karena pilih terdekat
    const [C, R] = tgt.key.split(',').map(Number);
    const dstx = C + OFF, dstz = (R + 1) + OFF;
    if (Math.abs(p.pos.x - dstx) > 0.6 || Math.abs(p.pos.z - dstz) > 0.6) {
      await p.walkTo(dstx, dstz, { maxSec: Math.min(12, 2 + Math.hypot(p.pos.x - dstx, p.pos.z - dstz) / 2) }).catch(() => {});
    }
    const res = await p.harvestNodeV2('rock', tgt.key, !!tgt.hasCoal, !!tgt.hasMetal, { maxSec: 8 });
    if (res.felled) {
      const loot = res.loot || 'stone';
      const y = res.yield || NODE_YIELD; // v2026: amt dari server (random), fallback 6
      persistLootAsync(cli, loot, y);
      if (loot === 'stone') stone += y; else if (loot === 'coal') coal += y; else metal += y;
      ctx.bump('felled'); ctx.bump(loot === 'stone' ? 'stone' : loot === 'coal' ? 'coal' : 'metal');
      onEvent(`✅ rock felled loot=${loot} x${y} (stone+${stone} coal+${coal} metal+${metal})`);
      dead.set(tgt.key, Date.now()); // node habis — tunggu respawn
      skipStreak = 0; felledSinceMove++; // panen sukses → reset streak, catat progres sejak rotasi
      await ssleep(rnd(200, 600)); // jeda antar node — dipangkas (client-only; protokol tetap)
    } else {
      fails++; dead.set(tgt.key, Date.now() + (p.region === 'pond' ? 150000 : 0)); // pond: blacklist 2.5 mnt (respawn lambat)
      if (fails % 10 === 1) onEvent(`⚠️ ${fails} node skip (gagal/depleted)`);
    }
    if (!p.ready) { onEvent('🔌 reconnect...'); try { p.close(); } catch {}
      const pn = await connectPresence(cli, onEvent); Object.assign(p, pn);
      if (zone === 'pond' && p.region !== 'pond') { await gotoPond(p, onEvent); } // masuk pond lagi pasca-reconnect
      let wn = 0; while (!(p.nodes && [...p.nodes.values()].some((n) => n.kind === 'rock')) && wn < 15000) { await sleep(1000); wn += 1000; } }
  }
  try { p.close(); } catch {}
  await flushPersist();
  return { stone, coal, metal, fails };
}

// ============ /wood — panen wood ============
async function runWood(ctx) {
  const { cli, stop, onEvent } = ctx;
  onEvent('🪓 Mulai panen wood...');
  const p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx); // notif LEVEL UP ke chat
  try { p.equip('tool_axe'); } catch {} // human-like: bawa axe pas chopping
  if (!(await gotoResourceZone(p, onEvent, 90, 'tree'))) onEvent(`⚠️ belum di zona tree (region=${p.region}) — coba node sekitar`);
  const dead = new Map(); // key -> ts blacklist
  let wood = 0, fails = 0;
  const targetWood = ctx.targetWood || 0; // refill potion: auto-berhenti saat bahan cukup (jgn jalan selamanya)
  while (!stop() && !(targetWood && wood >= targetWood)) {
    const tgt = pickNodeFixed(p, ['tree'], dead);
    if (!tgt) {
      if (dead.size) { dead.clear(); onEvent('♻️ blacklist reset — cari node respawn'); }
      await ssleep(rnd(800, 1500)); continue;
    }
    const [C, R] = tgt.key.split(',').map(Number);
    const dstx = C - 30.5, dstz = R + 1 - 30.5;
    if (Math.abs(p.pos.x - dstx) > 0.6 || Math.abs(p.pos.z - dstz) > 0.6) {
      await p.walkTo(dstx, dstz, { maxSec: Math.min(12, 2 + Math.hypot(p.pos.x - dstx, p.pos.z - dstz) / 2) }).catch(() => {});
    }
    const res = await p.harvestNodeV2('tree', tgt.key, false, false, { maxSec: 8 });
    if (res.felled) {
      const y = res.yield || NODE_YIELD; // v2026: amt dari server (random)
      persistLootAsync(cli, 'wood', y);
      wood += y;
      ctx.bump('felled'); ctx.bump('wood');
      onEvent(`✅ tree felled (wood+${wood})`);
      dead.set(tgt.key, Date.now());
      await ssleep(rnd(200, 600)); // dipangkas
    } else {
      fails++; dead.set(tgt.key, Date.now());
      if (fails % 10 === 1) onEvent(`⚠️ ${fails} node skip (gagal/depleted)`);
    }
    if (!p.ready) { onEvent('🔌 reconnect...');
      try { p.close(); } catch {}
      const pn = await connectPresence(cli, onEvent); Object.assign(p, pn); }
  }
  if (targetWood && wood >= targetWood) onEvent(`🎯 wood ${wood}/${targetWood} — cukup buat potion, selesai panen`);
  try { p.close(); } catch {}
  await flushPersist();
  return { wood, fails };
}

// ============ /combat — zombie (Wilderness) ============
const MAIN_OFF = -30.5;
const NORTH_PORTAL = { x: 30 - 30.5, z: 0 - 30.5 };
const WILD_OFF = -24.5;
const SAFE_CAMP = { col: 25, row: 47 };
const wildWorld = (col, row) => ({ x: col + WILD_OFF, z: row + WILD_OFF });
const SWING_CD = Math.round(1500 / SPEED); // 1500ms @1x — dipercepat SPEED
const ZOMBIE_LIVES = 5;
// pond layout (global — dipakai runFish & doFishQuest)
const ROAST = { x: -14.5, z: -12.5 }; // roast fire utk cook fish

async function refreshPotions(cli) {
  const me = await cli.me(); const bp = me.backpack || {};
  return { health: Number(bp.potion_health) || 0, shield: Number(bp.potion_shield) || 0 };
}

// ============ GEAR: alat starter gratis ulang via grant-tool (server ngasih terus) ============
// MATI = pedang+beliung+gancu ilang. Sebelum masuk wild lagi: cek & grant yang kurang.
const GEAR_SET = ['wild_sword', 'tool_axe', 'tool_pickaxe', 'tool_fishing_rod'];
async function ensureGear(cli, onEvent) {
  const me = await cli.me(); const bp = me.backpack || {};
  const have = new Set([...(bp.hotbar || []), ...(bp.invSlots || [])].filter(Boolean).map((s) => s.t));
  const got = [];
  for (const g of GEAR_SET) {
    if (have.has(g)) continue;
    try {
      const r = await cli.grantTool(g);
      if (r && r.ok !== false) { got.push(g); onEvent(`🧰 ambil alat: ${g} ✅`); }
      else onEvent(`🧰 grant ${g}: ${r && r.error || 'gagal'}`);
    } catch (e) { onEvent(`🧰 grant ${g} err: ${String(e.message).slice(0, 40)}`); }
  }
  const me2 = await cli.me(); const bp2 = me2.backpack || {};
  const have2 = new Set([...(bp2.hotbar || []), ...(bp2.invSlots || [])].filter(Boolean).map((s) => s.t));
  return { ok: have2.has('wild_sword'), got, have: [...have2].filter((t) => GEAR_SET.includes(t)) };
}

async function ensureCombatSupplies(cli, onEvent) {
  // resep BARU (v2026): health=60 wood, shield=50 stone — beda dr repo lama (6 wood/5 stone)
  const TARGET_H = 6, TARGET_S = 2;
  const COST_H_WOOD = 60, COST_S_STONE = 50;
  const bankCount = (bp, t) => { const s = (bp.bankSlots||[]).find((s) => s && s.t === t); return s ? Number(s.n)||0 : 0; };
  const me = await cli.me(); const bp = me.backpack || {};
  let health = Number(bp.potion_health) || 0, shield = Number(bp.potion_shield) || 0;
  const needH = Math.max(0, TARGET_H - health), needS = Math.max(0, TARGET_S - shield);
  const needWood = needH * COST_H_WOOD, needStone = needS * COST_S_STONE;
  const invWood = (bp.wood||0), invStone = (bp.stone||0);
  onEvent(`🧪 potion: health=${health}/${TARGET_H} shield=${shield}/${TARGET_S} | inv wood=${invWood} stone=${invStone} (bank wood=${bankCount(bp,'wood')} stone=${bankCount(bp,'stone')})`);
  // tarik bahan dari bank kalau kurang (server baru: bahan harus di backpack)
  const shortWood = Math.max(0, needWood - invWood), shortStone = Math.max(0, needStone - invStone);
  if (shortWood > 0 || shortStone > 0) {
    const r = await bank.withdraw(cli, {
      wood: Math.max(0, needWood - invWood),
      stone: Math.max(0, needStone - invStone),
    });
    if (r.moved && r.moved.length) onEvent(`📤 withdraw utk potion: ${r.moved.join(',')}`);
  }
  const buy = async (type, need) => {
    let bought = 0;
    for (let i = 0; i < need; i++) {
      try {
        const r = await cli.alchemistPotionBuy(type, 1);
        if (r && r.ok !== false && !r.error) { bought++; continue; }
        onEvent(`🧪 beli ${type} stop: ${r?.error || 'rejected'}`);
        break;
      } catch (e) { onEvent(`🧪 beli ${type} err: ${String(e.message).slice(0,40)}`); break; }
    }
    return bought;
  };
  if (needH > 0) health += await buy('potion_health', needH);
  if (needS > 0) shield += await buy('potion_shield', needS);
  onEvent(`🧪 stok final: health=${health} shield=${shield}`);
  // guard ekonomi: health potion = nyawa di wild. Kalau health=0 & wood kurang buat beli
  // → jangan masuk wild (gak akan dapet kill, cuma jadi bulu-bulu zombie).
  if (health === 0 && needH > 0) {
    onEvent(`🛑 health potion 0 (butuh ${needH * COST_H_WOOD} wood, kurang) — combat dibatalkan biar gak bunuh diri. Panen /wood dulu.`);
    return { health, shield, fatal: true };
  }
  return { health, shield };
}

async function tryPotion(cli, p, type, pot) {
  const now = Date.now();
  if (now - (tryPotion._t || 0) < 2500) return false;
  if (type === 'potion_health' && pot.health <= 0) return false;
  if (type === 'potion_shield' && pot.shield <= 0) return false;
  tryPotion._t = now;
  try {
    const r = await cli.consumePotion(type);
    if (r && r.ok !== false && !r.error) {
      if (type === 'potion_health') { pot.health--; p.hp = Math.min(100, (p.hp|0) + 30); try { await cli.saveHp(p.hp); } catch {} } // resep baru: 30 HP/3 ticks
      else { pot.shield--; p.shield = 5; }
      return true;
    }
  } catch {}
  return false;
}

async function survival(cli, p, pot, onEvent) {
  const hp = p.hp | 0;
  if (hp <= 0) return 'dead';
  if (hp <= 22) {
    if (pot.health <= 0 && pot.shield <= 0) { onEvent(`🩸 HP ${hp} kritis & potion habis — retreat`); return 'retreat'; }
    return 'retreat';
  }
  if (hp <= 28 && pot.shield > 0 && (p.shield|0) <= 0) await tryPotion(cli, p, 'potion_shield', pot);
  if (hp <= 45 && pot.health > 0) await tryPotion(cli, p, 'potion_health', pot);
  return 'ok';
}

async function retreatHeal(cli, p, pot, onEvent) {
  const sc = wildWorld(SAFE_CAMP.col, SAFE_CAMP.row);
  onEvent(`🏃 retreat ke safe camp (hp=${p.hp})...`);
  await p.walkTo(sc.x, sc.z, { maxSec: 30 });
  await sleep(1500);
  for (let i = 0; i < 8 && p.hp < 80 && pot.health > 0; i++) {
    await tryPotion(cli, p, 'potion_health', pot);
    await sleep(2600);
  }
  if (pot.health <= 0 && p.hp <= 22) {
    onEvent('🚪 potion habis & HP rendah — exit ke Mainland');
    p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1);
    await sleep(3000);
    return 'exited';
  }
  onEvent(`🛡️ recovered hp=${p.hp} — lanjut hunt`);
  return 'recovered';
}

// ============ MANUAL-ONLY: bahan potion habis → panen wood sendiri, beli, lanjut (tanpa stop sesi) ============
async function refillPotionsManual(ctx, p, pot, onEvent) {
  const cli = ctx.cli;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // TARGET (resep v2026: health potion = 60 wood/slot): panen CUKUP buat beli — jgn jalan selamanya
    const me = await cli.me().catch(() => null);
    const haveH = Number(me?.backpack?.potion_health) || 0;
    const needH = Math.max(0, 6 - haveH);
    const targetWood = needH * 60 + 60; // buffer +60
    onEvent(`🪓 MANUAL tanpa batas: bahan potion habis — panen wood target ${targetWood} (usaha ${attempt}/3)...`);
    try { p.close(); } catch {} // 1 akun 1 sesi presence — runWood buka sendiri
    const sub = { cli, stop: ctx.stop, onEvent, counters: ctx.counters, bump: (k) => ctx.bump(k), get: (k) => ctx.get(k), onImportant: ctx.onImportant, manual: true, targetWood };
    try { await runWood(sub); } catch (e) { onEvent('⚠️ panen wood err: ' + String(e.message).slice(0, 60)); }
    const r2 = await ensureCombatSupplies(cli, onEvent).catch(() => ({ health: 0, shield: 0, fatal: true }));
    pot.health = r2.health; pot.shield = r2.shield;
    if (!r2.fatal) break;
  }
  if (!(pot.health > 0)) return false; // bahan bener-bener habis di mana-mana
  onEvent('🧪 potion siap lagi — reconnect & lanjut...');
  const pn = await connectPresence(cli, onEvent);
  Object.assign(p, pn);
  try { p.equip('wild_sword'); } catch {}
  return true;
}

async function runCombat(ctx, opts = {}) {
  const { cli, stop, onEvent } = ctx;
  const dragon = !!opts.dragon;
  const label = dragon ? '🐉 BOSS (dragon)' : '🧟 zombie';
  onEvent(`${label} mulai...`);
  const p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx); // notif LEVEL UP ke chat
  p.on('wm_kill', (d) => {
    if (dragon && Number(d.dr) === 1) { ctx.bump('kill'); onEvent(`☠️ DRAGON KILLED #${ctx.get('kill')}`); ctx.onImportant?.(questPanel('DRAGON KILLED', [['⚔️ Total kill', `${ctx.get('kill')}`]], '🐉')); }
    else if (!dragon && Number(d.zm) === 1) { ctx.bump('kill'); onEvent(`☠️ zombie killed #${ctx.get('kill')}`); if (ctx.get('kill') % 10 === 0) ctx.onImportant?.(questPanel('ZOMBIE MILESTONE', [['⚔️ Kill sesi', `${ctx.get('kill')} 🧟`]], '⚔️')); }
  });
  p.on('hp', (hp) => { if (hp <= 30) onEvent(`🩸 HP=${hp}`); });
  // BELI POTION DULU (bahan panen masih di backpack — usul user), baru bank sisanya
  try {
    await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 30 });
    await sleep(1500);
  } catch (e) { onEvent('bank walk skip: ' + String(e.message).slice(0, 40)); }
  const pot = await ensureCombatSupplies(cli, onEvent);
  if (pot.fatal) {
    if (!ctx.manual) { // AUTO: stop biar gak bunuh diri
      try { const r = await bank.depositAll(cli); } catch {}
      try { p.close(); } catch {}
      return { kills: 0, err: 'no-potions' };
    }
    // MANUAL tanpa batas: bahan habis → panen wood sendiri buat potion, sesi lanjut
    if (!(await refillPotionsManual(ctx, p, pot, onEvent))) {
      try { const r = await bank.depositAll(cli); } catch {}
      try { p.close(); } catch {}
      return { kills: 0, err: 'no-potions' };
    }
    try { const r = await bank.depositAll(cli); } catch {} // sisa bahan ke bank
  }
  try {
    const r = await bank.depositAll(cli);
    if (r.moved && r.moved.length) onEvent(`🏦 banked sisa: ${r.moved.join(',')}`);
  } catch (e) { onEvent('bank skip: ' + String(e.message).slice(0, 40)); }
  // GUARD: mati zombie = ILANG SEMUA termasuk pedang & peralatan.
  // Sesi baru mulai: alat starter bisa di-gratis ulang (grant-tool) — ambil dulu.
  {
    const g = await ensureGear(cli, onEvent);
    if (!g.ok) {
      onEvent('🛑 alat gak bisa di-gratis ulang — combat DIBATALKAN');
      try { await bank.depositAll(cli); } catch {}
      try { p.close(); } catch {}
      return { kills: 0, err: 'no-sword' };
    }
  }
  // enter wild
  onEvent('⚔️ walk ke north portal...');
  p.equip('wild_sword');
  await p.walkTo(NORTH_PORTAL.x, NORTH_PORTAL.z, { until: () => /^wild/.test(p.region), maxSec: 40 });
  await sleep(1500);
  if (!/^wild/.test(p.region)) {
    const sp = wildWorld(25, 48);
    p.setRegion('wild', sp.x, sp.z);
    await sleep(3000);
  }
  if (!/^wild/.test(p.region)) { onEvent('🛑 gagal masuk wild'); try { p.close(); } catch {} return { kills: 0, err: 'no-wild' }; }
  p.sendWildManifest([]);
  onEvent('✅ di Wilderness, tunggu mob...');
  let deaths = 0, retreats = 0, noMob = 0;
  while (!stop()) {
    // tunggu mob
    for (let w = 0; w < 15 && !p.wildMobs.some((m) => m.alive && (dragon ? m.d === 1 : true)); w++) {
      await sleep(2000);
      if (w === 5) p.sendWildManifest([]);
    }
    const pool = p.wildMobs.filter((m) => m.alive && (dragon ? m.d === 1 : true));
    if (!pool.length) { noMob++; if (noMob % 5 === 0) onEvent('⏳ nunggu mob respawn...'); await ssleep(3000); continue; }
    noMob = 0;
    const sv = await survival(cli, p, pot, onEvent);
    if (sv === 'dead') {
      deaths++;
      p.wildMobs = []; // buang data mob basi — jangan mukul hantu
      p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1);
      await ssleep(5000);
      // MATI = ILANG SEMUA (pedang, potion, resource bawaan).
      // Death cap 2/sesi: HANYA AUTO. MANUAL = tanpa batas — lanjut sampai /stop.
      if (deaths >= 2 && !ctx.manual) { onEvent('🛑 mati 2x dalam sesi — STOP (cap anti bunuh diri). Repari pedang dulu (/combat lagi besok).'); return { kills: ctx.get('kill') || 0, deaths, retreats, err: 'death-cap' }; }
      if (deaths >= 2 && ctx.manual) onEvent(`💀 mati ${deaths}x — MANUAL tanpa batas: ambil alat & lanjut...`);
      try {
        // MATI = ILANG SEMUA (pedang, potion, resource bawaan).
        // Strategi user: auto ambil alat-alat dulu (grant-tool gratis), baru masuk lagi.
        const g = await ensureGear(cli, onEvent);
        if (!g.ok) { onEvent('🛑 alat gak bisa di-gratis ulang — STOP.'); return { kills: ctx.get('kill') || 0, deaths, retreats, err: 'sword-lost' }; }
        // refill potion dari bahan bank: withdraw wood/stone → beli
        const r2 = await ensureCombatSupplies(cli, (m) => {});
        pot.health = r2.health; pot.shield = r2.shield;
        if (r2.fatal && ctx.manual) { // MANUAL: panen bahan sendiri, jangan stop
          if (!(await refillPotionsManual(ctx, p, pot, onEvent))) { onEvent('🛑 bahan potion habis total — stop.'); return { kills: ctx.get('kill') || 0, deaths, retreats, err: 'no-potions' }; }
        } else if (r2.fatal) { onEvent('🛑 potion gak bisa diisi (bahan habis) — stop combat'); return { kills: ctx.get('kill') || 0, deaths, retreats, err: 'no-potions' }; }
        p.equip('wild_sword');
        // semua resource di-bank DULU — yang masuk wild cuma alat + potion
        try { const rb = await bank.depositAll(cli); if (rb.moved?.length) onEvent(`🏦 bank lagi: ${rb.moved.join(',')}`); } catch {}
        // masuk wild lagi
        await p.walkTo(NORTH_PORTAL.x, NORTH_PORTAL.z, { until: () => /^wild/.test(p.region), maxSec: 30 }).catch(() => {});
        if (!/^wild/.test(p.region)) {
          const sp = wildWorld(25, 48);
          p.setRegion('wild', sp.x, sp.z);
          await sleep(3000);
        }
        p.sendWildManifest([]);
      } catch (e) { onEvent('⚠️ pasca-mati err: ' + String(e.message).slice(0, 60)); }
      continue;
    }
    if (sv === 'retreat') {
      const r = await retreatHeal(cli, p, pot, onEvent);
      if (r === 'exited' && !ctx.manual) return { kills: ctx.get('kill') || 0, deaths, retreats, exited: true };
      if (r === 'exited') { // MANUAL tanpa batas: refill bahan & masuk wild lagi (region-check bawah yg masukin)
        onEvent('🔄 MANUAL: potion habis, keluar wild — panen bahan & refill...');
        if (!(await refillPotionsManual(ctx, p, pot, onEvent))) { onEvent('🛑 bahan habis total — stop.'); return { kills: ctx.get('kill') || 0, deaths, retreats, err: 'no-potions' }; }
      }
      retreats++; continue;
    }
    // region check: kalau kelempar ke world (mis. exit wild gak sengaja), masuk lagi
    if (!/^wild/.test(p.region)) {
      onEvent('🔄 keluar dari wild tanpa sengaja — masuk lagi');
      p.wildMobs = [];
      await p.walkTo(NORTH_PORTAL.x, NORTH_PORTAL.z, { until: () => /^wild/.test(p.region), maxSec: 30 }).catch(() => {});
      if (!/^wild/.test(p.region)) {
        const sp = wildWorld(25, 48);
        p.setRegion('wild', sp.x, sp.z);
        await sleep(3000);
      }
      p.sendWildManifest([]);
      continue;
    }
    // target terdekat
    let target = null, bd = Infinity;
    const me = p.wildTile();
    for (const m of pool) {
      if (m.col == null) continue;
      const d = Math.max(Math.abs(m.col - me.col), Math.abs(m.row - me.row));
      if (d < bd) { bd = d; target = m; }
    }
    if (!target) { await ssleep(2000); continue; }
    if (bd > 1) {
      const dest = wildWorld(target.col, target.row + 1);
      await p.walkTo(dest.x, dest.z, { maxSec: 18, until: () => p.hp <= 22 });
      await ssleep(400);
      if (p.hp <= 22) continue;
    }
    const ti = target.i;
    const tt = p.wildMobs[ti];
    if (!tt || !tt.alive) { await sleep(300); continue; }
    p.equip('wild_sword');
    for (let swing = 0; swing < (dragon ? 40 : ZOMBIE_LIVES + 3); swing++) {
      if (stop()) break;
      if (!/^wild/.test(p.region)) break; // keluar wild — stop mukul hantu
      const m = p.wildMobs[ti];
      if (!m || !m.alive) break;
      // stale guard: data mob lebih dari 2 mnt tanpa update & 12 swing tanpa kill → skip
      const c = Math.max(Math.abs(m.col - p.wildTile().col), Math.abs(m.row - p.wildTile().row));
      if (c > 1) break;
      p.sendWildMobHit(ti, 1);
      ctx.bump('hits');
      await sleep(SWING_CD);
      const sv2 = await survival(cli, p, pot, onEvent);
      if (sv2 === 'retreat') break;
      if (sv2 === 'dead') break;
    }
    await ssleep(600);
  }
  try { if (/^wild/.test(p.region)) { p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1); await sleep(2000); } } catch {}
  try { p.close(); } catch {}
  return { kills: ctx.get('kill') || 0, deaths, retreats };
}

// ============ /spinner — selesaikan quest dulu (fishing loop) lalu spin ============
// panel helper local (gaya stats-box, sama kayak telegram-ctl)
function questPanel(title, rows, icon = '📋') {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const w = Math.max(...rows.map((r) => esc(r[0]).replace(/[^\x20-\x7E]/g, '').length + 2));
  const lines = rows.map(([k, v]) => `${esc(k).padEnd(w)} : <b>${esc(v)}</b>`);
  return `<code>${icon} <b>${esc(title)}</b>\n${lines.join('\n')}</code>`;
}

async function runSpinner(ctx) {
  const { cli, stop, onEvent } = ctx;
  const say = (m) => { onEvent(m); (ctx.onImportant || (() => {}))(m); }; // quest progress → chat
  onEvent('🎡 Cek quest dulu...');
  const q = await cli.dailyQuestProgress().catch(() => null);
  const quests = q?.dailyQuestConfig?.quests || [];
  const prog = q?.dailyQuest?.prog || {};
  const claimed = q?.dailyQuest?.claimed || {};
  // claim yang sudah selesai
  for (const quest of quests) {
    const pr = prog[quest.id] || 0;
    if (pr >= quest.target && !claimed[quest.id]) {
      try { await cli.dailyQuestClaim(quest.id); say(`🎁 quest ${quest.kind} diklaim (+${quest.rewardXpSpreadTotal}XP)`); } catch {}
    }
  }
  // cari quest belum selesai -> kerjain sesuai jenis
  let remaining = quests.filter((x) => (prog[x.id] || 0) < x.target && !claimed[x.id]);
  // refresh prog setelah claim
  const q2 = await cli.dailyQuestProgress().catch(() => null);
  remaining = (q2?.dailyQuestConfig?.quests || []).filter((x) => ((q2?.dailyQuest?.prog || {})[x.id] || 0) < x.target && !((q2?.dailyQuest?.claimed || {})[x.id]));
  // QUEST PANEL: progress semua quest dlm 1 box (bar progress + persen)
  const qIcon = { wood: '🪓', mine: '⛏', stone: '🪨', coal: '⚫', fish: '🎣', kill: '⚔️', combat: '⚔️' };
  if (remaining.length) {
    const rows = remaining.map((x) => {
      const pr = ((q2?.dailyQuest?.prog || {})[x.id] || 0);
      const pct = Math.min(100, Math.round((pr / Math.max(1, x.target)) * 100));
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      return [`${qIcon[x.kind] || '📋'} ${x.kind}`, `${bar} ${pr}/${x.target} (${pct}%)`];
    });
    say(questPanel('DAILY QUEST — PROGRESS', rows));
  } else {
    say('📋 Semua daily quest selesai ✅');
  }
  for (const quest of remaining) {
    if (stop()) return { spun: false };
    const kind = quest.kind;
    onEvent(`▶️ kerjain quest ${kind} (${((q2?.dailyQuest?.prog || {})[quest.id] || 0)}/${quest.target})`); // file only
    if (kind === 'fish') await doFishQuest(ctx, quest);
    else if (kind === 'wood' || kind === 'chop' || kind === 'gather_wood' || /wood/.test(kind)) await doWoodQuest(ctx, quest);
    else if (kind === 'mine' || kind === 'stone' || kind === 'coal' || /mine|stone|coal/.test(kind)) await doRockQuest(ctx, quest);
    else if (kind === 'kill' || /combat|zombie|hunt/.test(kind)) await doCombatQuest(ctx, quest);
    else onEvent(`⚠️ quest kind "${kind}" belum didukung — skip`);
  }
  // klaim ulang
  const q3 = await cli.dailyQuestProgress().catch(() => null);
  for (const quest of (q3?.dailyQuestConfig?.quests || [])) {
    const pr = (q3?.dailyQuest?.prog || {})[quest.id] || 0;
    const cl = (q3?.dailyQuest?.claimed || {})[quest.id];
    if (pr >= quest.target && !cl) { try { await cli.dailyQuestClaim(quest.id); say(questPanel('QUEST SELESAI — CLAIMED', [[`${qIcon[quest.kind] || '📋'} ${quest.kind}`, `${quest.target}/${quest.target} ✅`]], '🎁')); } catch {} }
  }
  // spin
  onEvent('🎡 spin...');
  try {
    const r = await cli.dailySpinnerSpin();
    if (r && r.ok !== false) {
      const grant = r.grant || r.reward || r.prize || {};
      const icon = { gold: '🪙', wood: '🪵', stone: '🪨', coal: '⚫', metal: '🔩', fish: '🎣' }[grant.type] || '🎁';
      onEvent(`🎉 SPIN: ${icon} ${grant.type || '?'} +${grant.n || grant.amount || '?'} ${r.crit ? '(CRIT!)' : ''}`);
      (ctx.onImportant || (() => {}))(questPanel('SPIN RESULT', [
        ['🎁 Hadiah', `${icon} ${grant.n || grant.amount || '?'} ${grant.type || '?'}`],
        ['🎲 Crit', r.crit ? 'YA! 🔥' : 'no'],
      ], '🎡'));
      return { spun: true, grant };
    }
    return { spun: false, err: r?.error || 'rejected' };
  } catch (e) { return { spun: false, err: e.message }; }
}

async function doFishQuest(ctx, quest) {
  const { cli, stop, onEvent } = ctx;
  const PORTAL = { x: 61 - 30.5, z: 31 - 30.5 };
  const FISH_SPOT = { x: -11.5, z: 0 };
  // PROTOCOL BETUL (sama kayak runFish): cast ke tile spot aktif → tunggu fish_bite
  // → strike → reel → grantFishXp{mountCatch, shardId}. Cast palsu = server gak ngecount.
  const FISH_STRIKE_MS = 2350, FISH_REEL_MS = 1480;
  // ROD WAJIB (sama kayak runFish): server cuma push fish_spots kalau rod equipped.
  try {
    const me = await cli.me(); const bp = me.backpack || {};
    const have = new Set([...(bp.hotbar || []), ...(bp.invSlots || [])].filter(Boolean).map((s) => s.t));
    if (!have.has('tool_fishing_rod')) {
      onEvent('🧰 rod gak ada (mati?) — ambil gratis...');
      const r = await cli.grantTool('tool_fishing_rod');
      if (r && r.ok !== false) onEvent('🧰 rod ✅ diambil');
      else onEvent('❌ grant rod gagal: ' + ((r && r.error) || '?'));
    }
  } catch (e) { onEvent('⚠️ cek rod err: ' + String(e.message).slice(0, 50)); }
  let p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx); // notif LEVEL UP ke chat
  // pastikan bait (quest fish makan bait_feather per cast)
  const bait0 = await ensureBait(cli, p, onEvent, 40, stop).catch(() => 0);
  onEvent(`🪶 bait siap: ${bait0}`);
  try {
    try { p.equip('tool_fishing_rod'); } catch {} // WAJIB: equip rod sebelum nunggu spot
    if (p.region !== 'pond') {
      onEvent('🎣 walk ke Pond...');
      await p.walkTo(PORTAL.x, PORTAL.z, { until: () => p.region === 'pond', maxSec: 30 });
      await sleep(1500);
      if (p.region !== 'pond') { p.setRegion('pond', PORTAL.x, PORTAL.z); await sleep(3000); }
      if (p.region === 'pond') { p.pos.x = -18.5; p.pos.z = 0; await p.walkTo(FISH_SPOT.x, FISH_SPOT.z, { maxSec: 12 }); }
    }
    let casts = 0, ok = 0;
    let fishQN = Number(((await cli.me().catch(() => ({}))).backpack || {}).fish || 0); // counter lokal ikan mentah
    let noSpotMin = 0; // guard 3 menit tanpa spot → cek rod & stop kalau mati total
    while (!stop()) {
      if (casts % 20 === 0 && casts > 0) { // cek quest tiap 20 cast (hemat HTTP; dulu tiap cast)
        const q = await cli.dailyQuestProgress().catch(() => null);
        const qq = (q?.dailyQuestConfig?.quests || []).find((x) => x.id === quest.id);
        const pr = (q?.dailyQuest?.prog || {})[quest.id] || 0;
        if (qq && pr >= qq.target) { onEvent(`✅ quest fish selesai (${pr}/${qq.target})`); (ctx.onImportant || (() => {}))(questPanel('QUEST SELESAI', [['🎣 fish', `${pr}/${qq.target} ✅`]], '✅')); break; }
      }
      if (p.region !== 'pond') { onEvent('🔌 keluar pond — reconnect'); try { p.close(); } catch {} p = await connectPresence(cli, onEvent); p.setRegion('pond', -11.5, 0); await sleep(3000); continue; }
      // cari spot aktif terdekat (server-driven, bukan tile statis)
      let spot = p.nearestFishSpot ? p.nearestFishSpot(p.pondTile().col, p.pondTile().row, 6) : null;
      if (!spot) {
        noSpotMin++;
        // tiap 1 menit tanpa spot: cek rod (mati/hilang?) & re-equip
        if (noSpotMin % 12 === 1) { // iterasi ke-1,13,25... (~tiap 60 dtk)
          onEvent('⏳ nunggu fish_spots...' + (noSpotMin > 12 ? ` (${Math.floor(noSpotMin/12)} menit)` : ''));
          try { p.equip('tool_fishing_rod'); } catch {} // re-equip: kadang server "lupa" push
        }
        if (noSpotMin >= 36) { // 3 menit gak ada spot → cek rod beneran + stop kalau gak ada
          onEvent('🛑 3 menit gak ada spot — cek rod...');
          try {
            const me = await cli.me(); const bp = me.backpack || {};
            const have = new Set([...(bp.hotbar || []), ...(bp.invSlots || [])].filter(Boolean).map((s) => s.t));
            if (have.has('tool_fishing_rod')) { onEvent('🧰 rod masih ada — spot emang kosong, lanjut tunggu'); noSpotMin = 12; }
            else {
              const r = await cli.grantTool('tool_fishing_rod');
              if (r && r.ok !== false) { onEvent('🧰 rod ✅ diambil ulang'); try { p.equip('tool_fishing_rod'); } catch {} noSpotMin = 0; }
              else { onEvent('❌ rod gak bisa diambil — stop sesi. Coba /fish lagi nanti.'); break; }
            }
          } catch (e) { onEvent('⚠️ cek rod err — lanjut'); }
        }
        await ssleep(5000); continue;
      }
      noSpotMin = 0;
      const pt = p.pondTile();
      const n = p.fishSpotSize || 2;
      const dc = Math.max(spot.c - pt.col, pt.col - (spot.c + n - 1), 0);
      const dr = Math.max(spot.r - pt.row, pt.row - (spot.r + n - 1), 0);
      if (Math.max(dc, dr) > 3) {
        const ccol = Math.max(2, spot.c - 2), crow = spot.r + ((n - 1) >> 1);
        await p.walkTo(ccol - 19.5, crow - 20, { maxSec: 12 }).catch(() => {});
      }
      const castCol = spot.c, castRow = spot.r + ((n - 1) >> 1);
      p.fishBiteAt = null;
      p.setFishing(castCol, castRow, 0); // wait phase — mulai cast bener
      casts++; ctx.bump('cast');
      // tunggu fish_bite — EVENT-DRIVEN (reaksi instan, dulu polling 1 dtk)
      const biteAt = await waitForBite(p, 20000, stop);
      if (!biteAt) { p.setAct(null); await ssleep(rnd(300, 800)); continue; }
      const waitMs = Math.max(0, biteAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      p.setFishing(castCol, castRow, 1); await sleep(FISH_STRIKE_MS); // strike
      p.setFishing(castCol, castRow, 2); await sleep(FISH_REEL_MS);   // reel
      try {
        const shardNum = Number(String(p.shard || '').replace(/[^0-9]/g, '')) || 1;
        const g = await cli.grantFishXp({ mountCatch: true, shardId: shardNum });
        p.setAct(null);
        if (g?.ok !== false) { ok++; ctx.bump('fish'); fishQN++; onEvent(`🐟 quest catch ${ok}/${casts} fish=${fishQN}`); }
      } catch (e) { p.setAct(null); await ssleep(2000); }
      // masak tiap 8 ikan — pakai helper (keluar pond benar + retry ROAST)
      if (fishQN >= 8) {
        onEvent('🍳 masak batch (quest)...');
        const c = await cookBatchAtRoast(ctx, p, fishQN);
        if (c > 0) fishQN -= c;
        if (!(await gotoPond(p, onEvent))) onEvent('⚠️ gagal balik pond (quest)');
        if (p.region === 'pond') {
          try { p.equip('tool_fishing_rod'); } catch {}
          await sleep(1500);
          await p.walkTo(FISH_SPOT.x, FISH_SPOT.z, { maxSec: 12 }).catch(() => {});
        }
      }
    }
  } finally { try { p.close(); } catch {} }
}

async function doWoodQuest(ctx, quest) {
  const { cli, stop, onEvent } = ctx;
  let p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx); // notif LEVEL UP ke chat
  let done = 0;
  while (!stop()) {
    const q = await cli.dailyQuestProgress().catch(() => null);
    const qq = (q?.dailyQuestConfig?.quests || []).find((x) => x.id === quest.id);
    const pr = (q?.dailyQuest?.prog || {})[quest.id] || 0;
    if (qq && pr >= qq.target) { onEvent(`✅ quest wood selesai (${pr}/${qq.target})`); (ctx.onImportant || (() => {}))(questPanel('QUEST SELESAI', [['🪓 wood', `${pr}/${qq.target} ✅`]], '✅')); break; }
    const tgt = pickNodeFixed(p, ['tree']);
    if (!tgt) { await sleep(rnd(1000, 2000)); continue; }
    const res = await p.harvestNodeV2('tree', tgt.key, false, false, { maxSec: 12 });
    if (res.felled) { const y = res.yield || NODE_YIELD; persistLootAsync(cli, 'wood', y); done += y; if (done % 5 < y) onEvent(`🪓 wood quest: ${done} felled`); }
    else if (p.nodes && p.nodes.has(tgt.key)) p.nodes.delete(tgt.key);
    if (!p.ready) { onEvent('🔌 reconnect...'); try { p.close(); } catch {} p = await connectPresence(cli, onEvent); }
  }
  try { p.close(); } catch {}
}

async function doRockQuest(ctx, quest) {
  const { cli, stop, onEvent } = ctx;
  let p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx); // notif LEVEL UP ke chat
  let done = 0;
  while (!stop()) {
    const q = await cli.dailyQuestProgress().catch(() => null);
    const qq = (q?.dailyQuestConfig?.quests || []).find((x) => x.id === quest.id);
    const pr = (q?.dailyQuest?.prog || {})[quest.id] || 0;
    if (qq && pr >= qq.target) { onEvent(`✅ quest mine selesai (${pr}/${qq.target})`); (ctx.onImportant || (() => {}))(questPanel('QUEST SELESAI', [['⛏ mine', `${pr}/${qq.target} ✅`]], '✅')); break; }
    const tgt = pickNodeFixed(p, ['rock']);
    if (!tgt) { await sleep(rnd(1000, 2000)); continue; }
    const res = await p.harvestNodeV2('rock', tgt.key, !!tgt.hasCoal, !!tgt.hasMetal, { maxSec: 12 });
    if (res.felled) { const y = res.yield || NODE_YIELD; persistLootAsync(cli, res.loot || 'stone', y); done += y; if (done % 5 < y) onEvent(`⛏️ mine quest: ${done} felled`); }
    else if (p.nodes && p.nodes.has(tgt.key)) p.nodes.delete(tgt.key);
    if (!p.ready) { onEvent('🔌 reconnect...'); try { p.close(); } catch {} p = await connectPresence(cli, onEvent); }
  }
  try { p.close(); } catch {}
}

async function doCombatQuest(ctx, quest) {
  await runCombat(ctx, { dragon: false });
}

// ============ /tutorial — selesaikan tutorial 26 step via API ============
const TUT_STEPS = [
  ['open_map', 'Welcome'], ['meet_lumberjack', 'Lumberjack'], ['chop_tree', 'Chop a Tree'],
  ['meet_miner', 'Miner'], ['mine_resources', 'Mine'], ['meet_foreman', 'Foreman'],
  ['open_build', 'Build'], ['place_firepit', 'Firepit'], ['visit_bank', 'Bank'],
  ['visit_cosmetics', 'Cosmetics'], ['get_sword', 'Sword'], ['hit_dummy', 'Dummy'],
  ['collect_feather', 'Feather'], ['make_bait', 'Bait'], ['catch_fish', 'Fish'],
  ['cook_fish', 'Cook'], ['reach_wilderness', 'Wilderness'], ['visit_alchemist', 'Alchemist'],
  ['visit_arena', 'Arena'], ['inspect_player', 'Friend'], ['open_friends', 'Friends'],
  ['open_inventory', 'Inventory'], ['open_leaderboard', 'Rankings'], ['open_stats', 'Stats'],
  ['open_outfit', 'Look'], ['open_marketplace', 'Marketplace'],
  ['card_daily', 'Daily Card'], ['card_housing', 'Housing Card'],
];

async function runTutorial(ctx) {
  const { cli, stop, onEvent } = ctx;
  onEvent('📖 Cek tutorial step...');
  const me = await cli.me();
  let step = Number(me.tutorialStep);
  if (!(step >= 0)) step = -1;
  if (step < 0 || step > TUT_STEPS.length - 1) { onEvent('✅ Tutorial udah selesai (atau akun bukan akun baru)'); return { done: true, already: true }; }
  onEvent(`📖 Tutorial step ${step + 1}/${TUT_STEPS.length}: ${TUT_STEPS[Math.max(0, step)][1]}...`);
  // advance satu-satu; server validasi fromStep == stored
  let okCount = 0, refused = 0;
  while (step < TUT_STEPS.length - 1 && !stop()) {
    const r = await cli.post('/api/auth/tutorial-progress', { action: 'advance', fromStep: step })
      .catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok !== false && typeof r.tutorialStep === 'number') {
      step = r.tutorialStep; okCount++;
      onEvent(`✅ step → ${step + 1} (${TUT_STEPS[Math.min(step, TUT_STEPS.length-1)][1]})`);
      await sleep(rnd(1200, 2500)); // humanlike
    } else if (r && typeof r.tutorialStep === 'number') {
      step = r.tutorialStep; refused++; // server koreksi — adopt
    } else {
      refused++; onEvent(`⚠️ advance ditolak (step ${step}) — coba lagi`);
      if (refused > 3) break;
      await sleep(3000);
    }
  }
  // step terakhir: finish
  if (step >= TUT_STEPS.length - 1) {
    const r = await cli.post('/api/auth/tutorial-progress', { action: 'advance', fromStep: TUT_STEPS.length - 1 }).catch(() => null);
    if (r && typeof r.tutorialStep === 'number') step = r.tutorialStep;
  }
  const done = !(Number(step) >= 0 && Number(step) <= TUT_STEPS.length - 1) || Number(step) < 0 ? false : Number(step) >= TUT_STEPS.length;
  onEvent(step >= TUT_STEPS.length || step === -1 && okCount === 0 ? '🎉 Tutorial selesai!' : `📖 Tutorial berhenti di step ${step + 1}`);
  return { step, okCount };
}

// ============ BAIT FARM — kill chicken eldergrove (am_ev) → feather → exchange bait ============
// am_ev: {t:'am_ev', region:'eldergrove', a:'hit', i:<idx 0-11>, px, pz}
// server ACK kill: broadcast {t:'am_ev', by:<id>, a:'hit', ck:1}
async function huntChickens(p, cli, onEvent, want = 5, budgetMs = 120000, stop = null) {
  const t0 = Date.now();
  let feathers = 0;
  // equip sword + ke eldergrove: 2-fase — jalan portal world (col31,row61)→ setRegion eldergrove spawn (0.5,-23.5)
  if (p.region !== 'eldergrove') {
    onEvent('🚶 ke Whisperwood (portal timur)...');
    const EG_PORTAL = { x: 0.5, z: 30.5 };      // world col 31, row 61
    const EG_SPAWN = { x: 0.5, z: -23.5 };     // eldergrove col 25, row 1
    try { await p.walkTo(EG_PORTAL.x, EG_PORTAL.z, { maxSec: 45 }); } catch {}
    if (p.region === 'world' && Math.abs(p.pos.x - EG_PORTAL.x) < 1.2 && Math.abs(p.pos.z - EG_PORTAL.z) < 1.2) {
      p.setRegion('eldergrove', EG_SPAWN.x, EG_SPAWN.z); // dari tile portal → server validasi transisi
    } else if (p.region !== 'eldergrove') {
      p.setRegion('eldergrove', EG_SPAWN.x, EG_SPAWN.z); // fallback
    }
    for (let i = 0; i < 15 && p.region !== 'eldergrove'; i++) await ssleep(1000);
    if (p.region !== 'eldergrove') { onEvent('⚠️ gagal masuk Whisperwood'); return 0; }
    onEvent('🌲 masuk Whisperwood ✓');
    let w = 0; while (!p.chickens && w < 8000) { await sleep(1000); w += 1000; } // tunggu snap bawa ambientChickens
  }
  try { p.equip('wild_sword'); } catch {}
  let killWait = new Promise((resolve) => {
    const h = async (d) => {
      if (d && d.t === 'am_ev' && d.a === 'hit' && Number(d.ck) === 1 && Number(d.by) === Number(p.myId)) {
        feathers++;
        onEvent(`🐔 chicken killed (feather ${feathers}/${want})`);
        // client-authoritative: tulis loot ke backpack + push (1 feather + 1 raw_chicken per kill)
        await persistLoot(cli, 'feather', 1).catch(() => {});
        await persistLoot(cli, 'raw_chicken', 1).catch(() => {});
        const c = (p.chickens || []).find((x) => x.i === d.i);
        if (c) c.alive = false;
        if (feathers >= want) resolve();
      }
    };
    p.on('msg', h);
    p._chickenHandler = h;
  });
  try {
    while (feathers < want && Date.now() - t0 < budgetMs && !(stop && stop())) {
      const ch = (p.chickens || []).filter((c) => c.alive && c.x != null);
      if (!ch.length) { await sleep(2000); continue; }
      // chicken terdekat
      let best = null, bd = Infinity;
      for (const c of ch) {
        const d = Math.abs(c.x - p.pos.x) + Math.abs(c.z - p.pos.z);
        if (d < bd) { bd = d; best = c; }
      }
      if (!best) { await sleep(2000); continue; }
      // dekati chicken (jalan sampai jarak < 2)
      if (bd > 2.5) {
        try { await p.walkTo(best.x, best.z, { maxSec: Math.min(20, 2 + bd / 3) }); } catch {}
      }
      // smash hit berkali-kali (cooldown 700ms, sampai hp drop / mati)
      for (let k = 0; k < 12; k++) {
        if (!best || best.alive === false) break;
        try {
          p.presenceWs.send(JSON.stringify({ t: 'am_ev', region: 'eldergrove', a: 'hit', i: best.i, px: p.pos.x, pz: p.pos.z, n: 1 }));
        } catch { break; }
        await sleep(700);
        // refresh dari snap terbaru
        const cur = (p.chickens || []).find((c) => c.i === best.i);
        if (cur && cur.alive === false) break;
        if (cur && cur.hp != null && best.hp != null && cur.hp < best.hp) { best = cur; }
      }
      await sleep(800);
    }
  } finally {
    if (p._chickenHandler) { try { p.removeListener('msg', p._chickenHandler); } catch {} delete p._chickenHandler; }
  }
  // keluar eldergrove 2-fase: jalan ke exit tile (col 25, row 0 → x=0.5, z=-24.5) → setRegion world (0.5, 29.5)
  if (p.region === 'eldergrove') {
    try { await p.walkTo(0.5, -24.5, { maxSec: 30 }); } catch {}
    p.setRegion('world', 0.5, 29.5);
    let w = 0; while (p.region !== 'world' && w < 8000) { await sleep(1000); w += 1000; }
  }
  return feathers;
}

/** Pastikan bait_feather cukup (target default 40). Kalau kurang: farm chicken + exchange. */
async function ensureBait(cli, p, onEvent, target = 40, stop = null) {
  const countType = (bp, t) => (bp.invSlots || []).filter((s) => s && s.t === t).reduce((a, s) => a + (s.n || 0), 0) || (bp[t] || 0);
  const bp = (await cli.me().catch(() => ({}))).backpack || {};
  let bait = countType(bp, 'bait_feather'), feather = countType(bp, 'feather');
  if (bait >= target) return bait;
  // exchange semua feather dulu (response = backpack server baru)
  while (feather > 0 && bait < target) {
    try {
      const r = await cli.fishingExchange('bait_feather');
      if (r?.ok === false || !r?.backpack) break;
      bait = countType(r.backpack, 'bait_feather'); feather = countType(r.backpack, 'feather');
    } catch { break; }
  }
  if (bait >= target) return bait;
  // BATCH BESAR: farm SEMUA kekurangan sekali jalan ke Whisperwood (bukan 12-12).
  // budget 10 mnt — chicken respawn ±30 dtk; total transisi cukup 1x per fase.
  const need = target - bait;
  onEvent(`🪶 bait kurang (${bait}/${target}) — farm ${need} chicken (batch besar)...`);
  const got = await huntChickens(p, cli, onEvent, need, 600000, stop ? () => stop() : null);
  if (got > 0) {
    await sleep(1500);
    for (let i = 0; i < got; i++) {
      try { const r = await cli.fishingExchange('bait_feather'); if (r?.ok !== false) bait++; } catch { break; }
    }
  }
  return bait;
}
// Alur (dari game client): cast ke tile dlm spot aktif -> wait (fph=0) ->
// server kirim fish_bite {ms} -> saat ms habis: strike (fph=1) 2.35s -> reel (fph=2) 1.48s ->
// POST grant-fish-xp {mountCatch:true, shardId}
const FISH_STRIKE_MS = 2350;
const FISH_REEL_MS = 1480;

// ── tunggu fish_bite EVENT-DRIVEN (dulu polling 1 dtk = buang ~0.5 dtk/cast) ──
// Resolve = timestamp bite, atau null kalau: spot pindah / timeout / stop.
function waitForBite(p, timeoutMs = 20000, stop = null) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); clearInterval(iv); p.removeListener('fish_bite', onBite); resolve(v); };
    const onBite = () => { if (p.fishBiteAt) finish(p.fishBiteAt); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const iv = setInterval(() => {
      if (stop && stop()) return finish(null);
      if (p.tileInFishSpot && p.tileInFishSpot(p.fishCastCol, p.fishCastRow) === false) finish(null); // spot pindah
      if (p.fishBiteAt) finish(p.fishBiteAt);
    }, 250);
    p.on('fish_bite', onBite);
    if (p.fishBiteAt) onBite(); // udah keburu dateng sebelum listener nempel
  });
}


// ============ cook-at-roast helper (dipakai runFish & runCook & doFishQuest) ============
// Masak HARUS di dekat ROAST fire region WORLD (-14.5,-12.5).
// FIX UTAMA: keluar pond = setRegion('world', 30.5, 0.5) LANGSUNG (pola gotoPond dibalik).
// walkTo koordinat world dari dalam pond = nyasar (koordinat beda region) -> masak gagal total.
async function cookBatchAtRoast(ctx, p, count) {
  const { cli, stop, onEvent } = ctx;
  let cooked = 0, fails = 0;
  // 1) ke world dulu (kalau di pond/wild), lalu jalan ke ROAST
  if (/pond|wild/i.test(p.region || '')) {
    onEvent('🚶 keluar region -> ROAST (world)...');
    if (p.region === 'pond') await exitPondToWorld(p, onEvent, ROAST.x, ROAST.z);
    else { try { p.setRegion('world', 0.5, 29.5); } catch {} await sleep(2000); await p.walkTo(ROAST.x, ROAST.z, { maxSec: 14 }).catch(() => {}); }
  } else {
    await p.walkTo(ROAST.x, ROAST.z, { maxSec: 14 }).catch(() => {});
  }
  await ssleep(1200);
  // 2) masak loop (4.5 dtk/ikan — timer server, JANGAN diubah)
  while (!stop() && cooked < count) {
    try {
      const r = await cli.grantCookXp({ mode: 'fish' });
      if (r?.ok !== false) { cooked++; ctx.bump('cooked'); persistLootAsync(cli, 'cooked_fish_meat', 1); persistLootAsync(cli, 'fish', -1); }
      else fails++;
    } catch { fails++; }
    if (fails > 4) {
      onEvent(`⚠️ masak gagal ${fails}x — reset pos ke ROAST & retry...`);
      // pos mungkin nyasar: walk ulang ke ROAST + re-equip rod pasca region jump
      await p.walkTo(ROAST.x, ROAST.z, { maxSec: 14 }).catch(() => {});
      await ssleep(1200); fails = 0;
    }
    if (cooked % 4 === 0 || cooked === count) onEvent(`🍳 masak ${cooked}/${count}`);
    await ssleep(4500); // 4.5 dtk/ikan — timer server
  }
  return cooked;
}

// ============ /cook — masak semua ikan mentah (dipakai /fish & /cook) ============
async function runCook(ctx) {
  const { cli, stop, onEvent } = ctx;
  const me0 = await cli.me().catch(() => ({}));
  const raw = (me0.backpack || {}).fish || 0;
  onEvent(`🍳 Mulai masak — ${raw} ikan mentah`);
  if (raw < 1) { onEvent('⚠️ gak ada ikan mentah — mancing dulu (/fish)'); return { cooked: 0, err: 'no_fish' }; }
  const p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx);
  // walk & masak via helper yang sama (ROAST world — portal pond-aware, anti koordinat nyasar)
  const cooked = await cookBatchAtRoast(ctx, p, raw);
  try { p.close(); } catch {}
  await flushPersist();
  return { cooked };
}

async function runFish(ctx) {
  const { cli, stop, onEvent } = ctx;
  const PORTAL = { x: 61 - 30.5, z: 31 - 30.5 };
  const FISH_SPOT = { x: -11.5, z: 0 };
  onEvent('🎣 Mulai mancing (protokol baru)...');
  // ROD WAJIB: server cuma push fish_spots kalau rod EQUIPPED. Mati = rod ilang.
  // Cek + grant dulu SEBELUM connect (biar gak nunggu spot 1.5 jam kayak kemarin).
  try {
    const me = await cli.me(); const bp = me.backpack || {};
    const have = new Set([...(bp.hotbar || []), ...(bp.invSlots || [])].filter(Boolean).map((s) => s.t));
    if (!have.has('tool_fishing_rod')) {
      onEvent('🧰 rod gak ada (mati?) — ambil gratis...');
      const r = await cli.grantTool('tool_fishing_rod');
      if (r && r.ok !== false) onEvent('🧰 rod ✅ diambil');
      else onEvent('❌ grant rod gagal: ' + ((r && r.error) || '?'));
    }
  } catch (e) { onEvent('⚠️ cek rod err: ' + String(e.message).slice(0, 50)); }
  let p = await connectPresence(cli, onEvent);
  watchLevelUps(p, ctx); // notif LEVEL UP ke chat
  // BAIT WAJIB: tiap catch makan 1 bait_feather. Pastikan stok dulu.
  const bait0 = await ensureBait(cli, p, onEvent, 40, stop).catch((e) => { onEvent('⚠️ bait: ' + String(e.message).slice(0, 50)); return 0; });
  onEvent(`🪶 bait siap: ${bait0}`);
  let casts = 0, ok = 0, cooked = 0;
  let fishN = Number(((await cli.me().catch(() => ({}))).backpack || {}).fish || 0); // counter lokal — diupdate respons grantFishXp (hemat cli.me() tiap cast)
  let rodlessWarn = 0; // guard: nunggu spot miring tanpa rod = stop, jangan bakar waktu
  try {
    while (!stop()) {
      if (p.region !== 'pond') {
        onEvent('🚶 ke Pond...');
        // 2-fase: jalan ke portal world (col 61, row 31 → 30.5, 0.5) → setRegion pond spawn (-18.5, 0.5)
        try { await p.walkTo(30.5, 0.5, { maxSec: 60 }); } catch {}
        if (Math.abs(p.pos.x - 30.5) < 1.5 && Math.abs(p.pos.z - 0.5) < 1.5) {
          p.setRegion('pond', -18.5, 0.5);
          let w = 0; while (p.region !== 'pond' && w < 10000) { await sleep(1000); w += 1000; }
        }
        if (p.region === 'pond') {
          p.pos.x = -18.5; p.pos.z = 0;
          try { p.equip('tool_fishing_rod'); } catch {} // WAJIB: server push fish_spots cuma kalau rod equipped (tool_fishing_rod!)
          await sleep(2000);
          await p.walkTo(FISH_SPOT.x, FISH_SPOT.z, { maxSec: 12 }).catch(() => {});
        }
        if (p.region !== 'pond') { await sleep(3000); continue; }
      }
      // tunggu fish_spots dari hub (datang setelah equip rod)
      let spot = null;
      {
        let waited = 0;
        while (!spot && waited < 30000 && !stop()) {
          spot = p.nearestFishSpot(p.pondTile().col, p.pondTile().row, 5);
          if (!spot) { if (waited === 0) onEvent('⏳ nunggu fish_spots...'); await sleep(500); waited += 500; }
        }
        // GUARD RODLESS: 60 dtk tanpa spot & rod gak equipped → cek & grant rod.
        // (server push fish_spots HANYA kalau rod equipped — tanpa rod = nunggu selamanya)
        if (!spot) {
          rodlessWarn++;
          if (rodlessWarn === 1) {
            onEvent('⚠️ 60 dtk gak ada spot — cek rod...');
            try {
              const me = await cli.me(); const bp = me.backpack || {};
              const have = new Set([...(bp.hotbar || []), ...(bp.invSlots || [])].filter(Boolean).map((s) => s.t));
              if (have.has('tool_fishing_rod')) {
                try { p.equip('tool_fishing_rod'); } catch {}
                onEvent('🧰 rod ada tapi gak equipped — di-equip ulang');
              } else {
                const r = await cli.grantTool('tool_fishing_rod');
                if (r && r.ok !== false) { onEvent('🧰 rod ✅ diambil ulang — equip'); try { p.equip('tool_fishing_rod'); } catch {} }
                else onEvent('❌ grant rod gagal: ' + ((r && r.error) || '?'));
              }
            } catch (e) { onEvent('⚠️ cek rod err: ' + String(e.message).slice(0, 50)); }
          } else if (rodlessWarn >= 3 && !ctx.manual) {
            onEvent(`🛑 ${rodlessWarn * 60} dtk gak ada spot (rod bermasalah?) — stop sesi fish. Restart /fish buat coba lagi.`);
            break;
          } else if (rodlessWarn >= 3) {
            // MANUAL tanpa batas: jangan stop — cycle ulang, cek rod lagi & terus tunggu spot
            onEvent(`⏳ MANUAL: ${rodlessWarn * 60} dtk gak ada spot — cek rod ulang, lanjut tunggu...`);
            rodlessWarn = 0;
          }
        } else rodlessWarn = 0;
        // semua spot di luar range 5? ambil terdekat apa pun & jalan mendekat
        if (!spot && Array.isArray(p.fishSpots) && p.fishSpots.length) {
          const pt = p.pondTile();
          let bs = null, bd = Infinity;
          for (const s of p.fishSpots) {
            const d = Math.abs(s.c - pt.col) + Math.abs(s.r - pt.row);
            if (d < bd) { bd = d; bs = s; }
          }
          if (bs) {
            const n = p.fishSpotSize || 2;
            const goCol = Math.max(2, bs.c - 2), goRow = bs.r + ((n - 1) >> 1);
            // pond tile -> pos: x = col - 19.5, z = row - 20
            await p.walkTo(goCol - 19.5, goRow - 20, { maxSec: 15 }).catch(() => {});
            spot = p.nearestFishSpot(p.pondTile().col, p.pondTile().row, 5);
          }
        }
      }
      if (!spot) { await ssleep(2000); continue; }
      const pt = p.pondTile();
      const n = p.fishSpotSize || 2;
      const dc = Math.max(spot.c - pt.col, pt.col - (spot.c + n - 1), 0);
      const dr = Math.max(spot.r - pt.row, pt.row - (spot.r + n - 1), 0);
      if (Math.max(dc, dr) > 3) {
        // pond tile -> pos: x = col - 19.5, z = row - 20 (mapping terverifikasi live)
        const ccol = Math.max(2, spot.c - 2), crow = spot.r + ((n - 1) >> 1);
        await p.walkTo(ccol - 19.5, crow - 20, { maxSec: 12 }).catch(() => {});
      }
      // cast: pilih tile dlm spot (c = sisi barat spot, r tengah)
      const castCol = spot.c, castRow = spot.r + ((n - 1) >> 1);
      p.fishBiteAt = null;
      p.setFishing(castCol, castRow, 0); // wait
      casts++; ctx.bump('cast');
      // tunggu fish_bite — EVENT-DRIVEN (reaksi instan, dulu polling 1 dtk)
      const biteAt = await waitForBite(p, 20000, stop);
      if (!biteAt) { // gak ada gigitan / spot pindah — cancel & re-cast
        p.setAct(null);
        await ssleep(rnd(300, 800));
        continue;
      }
      // tunggu sampai ms habis lalu strike
      const waitMs = Math.max(0, biteAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      p.setFishing(castCol, castRow, 1); // strike
      await sleep(FISH_STRIKE_MS);
      p.setFishing(castCol, castRow, 2); // reel
      await sleep(FISH_REEL_MS);
      try {
        const shardNum = Number(String(p.shard || '').replace(/[^0-9]/g, '')) || 1;
        const g = await cli.grantFishXp({ mountCatch: true, shardId: shardNum });
        p.setAct(null);
        if (g?.ok !== false) { ok++; ctx.bump('fish'); const nf = Number(g?.backpack?.fish); if (Number.isFinite(nf)) fishN = nf; else fishN++; onEvent(`🐟 catch ok (${ok}/${casts}) fish=${g?.backpack?.fish ?? fishN} bait=${(g?.backpack?.invSlots || []).filter(s => s && s.t === 'bait_feather').reduce((a, s) => a + (s.n || 0), 0)}`); }
        else onEvent(`❌ grant gagal: ${g?.error || '?'}`);
      } catch (e) {
        p.setAct(null);
        const m = String(e.message || '');
        if (/not_in_pond/.test(m)) p.region = 'world';
        else if (/missing_bait/.test(m)) {
          onEvent('🪶 bait habis — farm ulang...');
          p.setAct(null); try { p.setRegion('world', 0.5, 29.5); } catch {}
          const b = await ensureBait(cli, p, onEvent, 40, stop).catch(() => 0);
          onEvent(`🪶 bait siap: ${b}`);
        }
        else if (/fish_spot_required/.test(m)) onEvent('💨 spot pindah — cari spot baru');
        else onEvent('cast err: ' + m.slice(0, 40));
        await sleep(2000);
      }
      // masak tiap 8 ikan — pakai counter fishN (respons grantFishXp; buang cli.me() per cast)
      if (fishN >= 8) {
        onEvent('🍳 masak batch...');
        const c = await cookBatchAtRoast(ctx, p, fishN);
        cooked += c; fishN = Math.max(0, fishN - c);
        onEvent(`🍳 batch done: +${c} cooked (total ${cooked})`);
        // balik ke pond & re-equip rod (pola gotoPond terbukti — bukan walkTo dari world)
        if (!(await gotoPond(p, onEvent))) onEvent('⚠️ gagal balik pond — coba loop berikutnya');
        if (p.region === 'pond') {
          try { p.equip('tool_fishing_rod'); } catch {}
          await sleep(1500);
          await p.walkTo(FISH_SPOT.x, FISH_SPOT.z, { maxSec: 12 }).catch(() => {});
        }
      }
      if (!p.ready) { onEvent('🔌 reconnect...'); try { p.close(); } catch {} p = await connectPresence(cli, onEvent); }
      await ssleep(rnd(500, 1200)); // jeda antar cast — dipangkas (client-side; timer server tetap)
    }
  } finally { try { p.close(); } catch {} }
  return { casts, ok, cooked };
}

// ============ EXPORT ============
module.exports = { runRock, runWood, runCombat, runSpinner, runTutorial, runFish, runCook, connectPresence, persistLoot, pickNodeFixed };
