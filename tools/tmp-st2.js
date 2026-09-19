
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
const pk = pks[5];
(async () => {
  const { client, player } = await KintaraClient.create({ privateKey: pk, forceLogin: true });
  console.log('player:', player?.name || player?.displayName || player?.id);
  const st = await client.playerStats(player.id);
  for (const [k,v] of Object.entries(st)) {
    if (/tool|pick|energy|stamina|hp|equip|backpack|inv/i.test(k)) console.log(k, ':', JSON.stringify(v).slice(0,400));
  }
  process.exit(0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
