// Cek durabilitas wild_sword + isian hotbar/inv dari sisi REST (cli.me)
const { KintaraClient } = require('../lib/kintaraClient');
(async () => {
  const { client: cli } = await KintaraClient.create();
  const me = await cli.me();
  const bp = me.backpack || {};
  const dump = (arr, label) => (arr || []).forEach((s, i) => {
    if (!s) return;
    const wear = s.w ?? s.dur ?? s.du ?? s.durability ?? s.h ?? '';
    if (/sword|rod|axe|pick/.test(s.t || '')) console.log(`${label}[${i}]`, s.t, 'wear=' + JSON.stringify(wear), 'raw=' + JSON.stringify(s).slice(0, 200));
  });
  dump(bp.hotbar, 'hotbar');
  dump(bp.invSlots, 'inv');
  console.log('potions:', bp.potion_health, bp.potion_shield);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
