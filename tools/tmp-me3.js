
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
const pk = pks[5];
(async () => {
  const cli = await KintaraClient.create({ privateKey: pk, forceLogin: true });
  const r = await cli._request('GET', cli.baseUrl, '/api/me').catch(e=>({err:e.message}));
  console.log(JSON.stringify(r).slice(0,1500));
  process.exit(0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
