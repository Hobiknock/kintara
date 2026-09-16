// probe-cook.js — cek stok fish/wood + posisi + simulasi grantCookXp 1x (mode fish)
const { KintaraClient } = require('../lib/kintaraClient');
(async () => {
  const { client: cli } = await KintaraClient.create();
  const me = await cli.me();
  const bp = me.backpack || {};
  const grab = (k) => Number(bp[k]) || 0;
  console.log('fish=' + grab('fish'), 'wood=' + grab('wood'), 'stone=' + grab('stone'), 'cooked_fish_meat=' + grab('cooked_fish_meat'));
  console.log('pos=' + JSON.stringify(me.position || me.pos || '?'), 'region=' + (me.region || me.realm || '?'));
  try {
    const r = await cli.grantCookXp({ mode: 'fish' });
    console.log('cook resp:', JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log('cook err:', String(e.message).slice(0, 200));
  }
})().catch((e) => { console.error('probe err:', String(e.message).slice(0, 200)); process.exit(1); });
