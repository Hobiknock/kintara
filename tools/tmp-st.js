
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
const pk = pks[5];
(async () => {
  const cli = await KintaraClient.create({ privateKey: pk, forceLogin: true });
  const st = await cli.playerStats(cli.player.id);
  const keys = Object.keys(st);
  console.log('keys:', keys.join(',').slice(0,500));
  // cari tool/energy/stamina
  for (const k of keys) {
    const v = st[k];
    if (/tool|pick|energy|stamina|hp|equip/i.test(k)) console.log(k, ':', JSON.stringify(v).slice(0,300));
  }
  process.exit(0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
