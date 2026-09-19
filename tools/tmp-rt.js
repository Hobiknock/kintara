
const { KintaraClient } = require('/home/agentuser/kintara-bot/lib/kintaraClient');
const { Presence } = require('/home/agentuser/kintara-bot/lib/presenceWs');
const fs = require('fs');
const pks = fs.readFileSync('/home/agentuser/wallets-batch2.txt','utf8').split('\n').map(s=>s.trim()).filter(s=>s.length>50);
const pk = pks[3]; // kw14 Mbgracun lulus
(async () => {
  const cli = await KintaraClient.create({ privateKey: pk, forceLogin: true });
  const p = new Presence(cli, {});
  await p.connect();
  await new Promise(r=>setTimeout(r,4000));
  const nodes = [...(p.nodes||new Map()).values()].filter(n=>n.kind==='rock');
  console.log('rock nodes seen:', nodes.length);
  if (nodes.length) {
    const tgt = nodes[0];
    console.log('coba node', tgt.key, 'coal', tgt.hasCoal);
    const [C,R] = tgt.key.split(',').map(Number);
    const OFF = 19.5;
    await p.walkTo(C+OFF, (R+1)+OFF, { maxSec: 20 }).catch(e=>console.log('walk err', e.message));
    await new Promise(r=>setTimeout(r,1500));
    const res = await p.harvestNodeV2('rock', tgt.key, !!tgt.hasCoal, !!tgt.hasMetal, { maxSec: 8 }).catch(e=>({err:e.message}));
    console.log('res:', JSON.stringify(res).slice(0,300));
    // coba lagi node kedua
    if (nodes[1]) {
      const t2 = nodes[1];
      const [C2,R2] = t2.key.split(',').map(Number);
      await p.walkTo(C2+OFF, (R2+1)+OFF, { maxSec: 20 }).catch(()=>{});
      await new Promise(r=>setTimeout(r,1500));
      const res2 = await p.harvestNodeV2('rock', t2.key, !!t2.hasCoal, !!t2.hasMetal, { maxSec: 8 }).catch(e=>({err:e.message}));
      console.log('res2:', JSON.stringify(res2).slice(0,300));
    }
  }
  process.exit(0);
})().catch(e=>{console.log('ERR', e.message); process.exit(1);});
