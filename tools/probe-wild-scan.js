// Scan cepat: zombie hidup di shard mana saja? (connect per shard -> masuk wild -> manifest -> hitung)
const { KintaraClient } = require('../lib/kintaraClient');
const { connectPresence } = require('./farm-loops');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[scan]', ...a);

(async () => {
  const { client: cli } = await KintaraClient.create();
  log('login ok player=', cli.player?.id || cli.player);
  const out = [];
  for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) {
    let p = null;
    try {
      p = await connectPresence(cli, (m) => {}, 0, s);
      if (String(p.shard || '') !== s) { log(s, 'nyasar ke', p.shard, '— skip'); try { p.close(); } catch {} continue; }
      try { p.setRegion('world', -0.5, -29.5); } catch {}
      await sleep(900);
      await p.walkTo(-0.5, -30.5, { maxSec: 25 }).catch(() => {});
      try { if (!/^wild/.test(p.region)) { p.setRegion('wild', 25, 48); } } catch {}
      await sleep(1200);
      p.sendWildManifest([]);
      await sleep(2500);
      const alive = (p.wildMobs || []).filter((m) => m && m.alive).length;
      out.push([s, alive, p.region]);
      log(`shard ${s}: ${alive} zombie hidup (region=${p.region})`);
      try { p.close(); } catch {}
    } catch (e) {
      log(`shard ${s}: ERROR ${String(e.message).slice(0, 60)}`);
      try { p && p.close(); } catch {}
    }
    await sleep(1500);
  }
  console.log('RINGKASAN:', JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error('[scan] FATAL', e); process.exit(1); });
