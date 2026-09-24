
const ROOT = '/home/agentuser/kintara-lifecycle';
const { KintaraClient } = require(ROOT + '/lib/kintaraClient');
const gs = require(ROOT + '/lib/gameState');
const fs = require('fs');
const env = fs.readFileSync(ROOT + '/.env','utf8');
const pks = env.split('WALLETS=')[1].split('\n').filter(l=>l && !l.includes('=') && l.length>40);
const targets = [9,11,12,14];
(async () => {
  for (const n of targets) {
    const tag = 'w'+n;
    try {
      const { client } = await KintaraClient.create({ privateKey: pks[n-1], forceLogin: true });
      const st = await gs.fetchState(client);
      const bp = st.backpack || {};
      const sum = (arr, t) => (arr||[]).reduce((a,s)=>a+(s&&s.t===t?s.n:0),0);
      const invS = sum(bp.invSlots,'stone'), invC = sum(bp.invSlots,'coal');
      const bnkS = sum(bp.bankSlots,'stone'), bnkC = sum(bp.bankSlots,'coal');
      console.log(`${tag} INV stone=${invS} coal=${invC} | BANK stone=${bnkS} coal=${bnkC}`);
    } catch(e) { console.log(`${tag} ERR ${e.message.slice(0,60)}`); }
    await new Promise(r=>setTimeout(r,2000));
  }
  process.exit(0);
})();
