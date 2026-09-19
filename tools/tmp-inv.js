
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
// mapping: cek nama tiap pk sampe ketemu gomtri terlalu ribet — pakai idx 4 (kw15?) & 0
(async () => {
  const { client } = await KintaraClient.create({ privateKey: pks[0], forceLogin: true });
  const me = await client.me();
  console.log('name:', me.player?.displayName || me.displayName);
  const bp = me.backpack || {};
  const inv = bp.invSlots || [];
  const tools = inv.filter(s => s && /tool|pick|axe/i.test(JSON.stringify(s)));
  console.log('tools:', JSON.stringify(tools).slice(0,500));
  console.log('bp keys:', Object.keys(bp).join(','));
  process.exit(0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
