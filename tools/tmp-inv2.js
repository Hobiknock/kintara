
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
(async () => {
  const { client } = await KintaraClient.create({ privateKey: pks[0], forceLogin: true });
  const me = await client.me();
  const bp = me.backpack || {};
  console.log('hotbar:', JSON.stringify(bp.hotbar).slice(0,400));
  console.log('equippedHotbar:', JSON.stringify(bp.equippedHotbar).slice(0,400));
  console.log('invSlots[0..8]:', JSON.stringify((bp.invSlots||[]).slice(0,10)).slice(0,600));
  process.exit(0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
