// Probe v2: masuk wild PERSIS seperti runCombat (portal north), dump mentah snap.npcs,
// lihat apakah server kirim wildMobs sama sekali.
const { KintaraClient } = require('../lib/kintaraClient');
const { connectPresence } = require('./farm-loops');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[p2 +${Math.round((Date.now() - T0) / 1000)}s]`, ...a);
const NORTH = { x: -0.5, z: -30.5 }; // NORTH_PORTAL di farm-loops (30-30.5, 0-30.5)
const WILD_OFF = -24.5;
const wildWorld = (col, row) => ({ x: col + WILD_OFF, z: row + WILD_OFF });

(async () => {
  const { client: cli } = await KintaraClient.create();
  log('login ok player=', cli.player?.id || cli.player);
  const p = await connectPresence(cli, (m) => log('EV:', m));
  await sleep(3000);
  log('region awal:', p.region, JSON.stringify(p.pos), 'shard:', p.shard);
  await p.walkTo(NORTH.x, NORTH.z, { until: () => /^wild/.test(p.region), maxSec: 40 }).catch((e) => log('walk err', e.message));
  if (!/^wild/.test(p.region)) { const sp = wildWorld(25, 48); p.setRegion('wild', sp.x, sp.z); await sleep(1600); }
  log('region:', p.region, 'pos:', JSON.stringify(p.pos), 'hp:', p.hp);
  // dump raw npcs dari snap mentah 3x
  let dumps = 0;
  p.on('snap', (d) => {
    if (dumps++ < 3) log('RAW snap region=' + d.region + ' npcs=' + JSON.stringify(d.npcs).slice(0, 400));
  });
  p.sendWildManifest([]);
  let kills = 0;
  p.on('wm_kill', (d) => { kills++; log('!! wm_kill:', JSON.stringify(d).slice(0, 200)); });
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const alive = (p.wildMobs || []).filter((m) => m && m.alive);
    log(`t=${i * 5}s alive=${alive.length} total=${(p.wildMobs || []).length} stale=${Math.round(p.staleMs() / 1000)}s hp=${p.hp} region=${p.region}`);
    if (alive.length) {
      const ti = p.wildMobs.findIndex((m) => m && m.alive && m.d !== 1); // ZOMBIE, jangan dragon (hp 60 tanpa potion = mati)
      const m = p.wildMobs[ti];
      if (ti < 0) { log('cuma dragon, gak disentuh'); break; }
      log('target zombie:', JSON.stringify(m), 'tile aku:', JSON.stringify(p.wildTile()));
      // jalan deketin lalu tembak max 12 swing
      const dest = wildWorld(m.col, m.row + 1);
      await p.walkTo(dest.x, dest.z, { maxSec: 40, until: () => p.hp <= 25 }).catch(() => {});
      try { p.equip('wild_sword'); } catch {}
      for (let s = 0; s < 12; s++) {
        const mm = p.wildMobs[ti];
        if (!mm || !mm.alive) { log('MOB MATI setelah', s, 'swing'); break; }
        const c = Math.max(Math.abs(mm.col - p.wildTile().col), Math.abs(mm.row - p.wildTile().row));
        log(`swing ${s}: cheb=${c} hp=${p.hp}`);
        if (c > 1) { log('masih jauh — walk lagi'); await p.walkTo(wildWorld(mm.col, mm.row + 1).x, wildWorld(mm.col, mm.row + 1).z, { maxSec: 25 }).catch(() => {}); continue; }
        const okSend = p.sendWildMobHit(ti, 1);
        if (!okSend) {
          const ws = p.presenceWs;
          log('send gagal -> ws=' + (ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'null'),
            'region=' + p.region, 'pos=' + JSON.stringify(p.pos), 'stale=' + Math.round(p.staleMs() / 1000) + 's', 'fails=' + p.sendFailCount());
          break;
        }
        await sleep(1500);
        if (p.hp < 30) { log('hp kritis', p.hp, '— keluar'); try { p.setRegion('world', NORTH.x, NORTH.z + 1); } catch {} break; }
      }
      log('akhir: hp=', p.hp, 'killEvents=', kills);
      break;
    }
  }
  try { if (/^wild/.test(p.region)) p.setRegion('world', NORTH.x, NORTH.z + 1); } catch {}
  await sleep(600);
  try { p.close(); } catch {}
  process.exit(0);
})().catch((e) => { console.error('[p2] FATAL', e); process.exit(1); });
