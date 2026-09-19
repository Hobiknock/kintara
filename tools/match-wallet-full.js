const fs = require('fs');
const { loadKeypair } = require('/home/agentuser/kintara-bot/lib/walletAuth');
const bs58 = require('bs58').default || require('bs58');
const WANT = (process.argv[2]||'').split(',').filter(Boolean);
for (const fn of ['/home/agentuser/wallets-batch2.txt','/home/agentuser/wallets-batch3.txt']) {
  const lines = fs.readFileSync(fn,'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
  lines.forEach((pk,i) => {
    try {
      const id = bs58.encode(Buffer.from(loadKeypair(pk).publicKey)).slice(0,8);
      if (!WANT.length || WANT.includes(id)) console.log(id, pk);
    } catch(e) { console.error(fn, i+1, e.message.slice(0,50)); }
  });
}
