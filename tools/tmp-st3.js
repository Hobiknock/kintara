
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
const pk = pks[5];
(async () => {
  const { client, player } = await KintaraClient.create({ privateKey: pk, forceLogin: true });
  const st = await client.playerStats(player.id);
  console.log(JSON.stringify(st).slice(0, 2500));
  process.exit(0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
