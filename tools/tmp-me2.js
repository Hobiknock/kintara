
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
const pk = pks[5]; // gomtri? mapping kw15 idx5? kira2
(async () => {
  const cli = await KintaraClient.create({ privateKey: pk, forceLogin: true });
  const me = await cli.me();
  console.log('name:', me.display_name || me.name);
  console.log('bp:', JSON.stringify(me.backpack || me.bp || {}).slice(0,400));
  console.log('energy/stamina:', me.energy, me.stamina, me.hp);
  console.log('tools:', JSON.stringify((me.inventory||[]).filter(i=>String(i).includes('tool')||String(i).includes('pick'))).slice(0,300));
  console.log(JSON.stringify(me).slice(0, 1200));
  process.exit(0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
