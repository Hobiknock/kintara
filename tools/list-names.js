// Laporan lengkap semua wallet: nama, level mining, kins, stone/coal (inventory + bank)
const { KintaraClient } = require(path.join(__dirname, '..', 'lib/kintaraClient'));
const bank = require(path.join(__dirname, '..', 'lib/bank'));
const { levelFromTotalXp } = require(path.join(__dirname, '..', 'lib/skillXp'));
const fs = require('fs');
const path = require('path');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
let pks = [];
const m = env.match(/WALLETS=([\s\S]*?)(?=\n[A-Z_]+=|\n*$)/);
if (m) {
  pks = m[1].replace(/^=?\s*/, '').split(/[\n,]/).map(s => s.trim()).filter(s => s.length > 50);
}
console.error('wallets found:', pks.length);

function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

(async () => {
  const rows = [];
  for (let i = 0; i < pks.length; i++) {
    const tag = `w${i + 1}`;
    try {
      const { player, client } = await KintaraClient.create({ privateKey: pks[i], forceLogin: true });
      const name = player?.display_name || player?.name || player?.username || '(kosong)';

      // level mining dari skillXp
      let miningLvl = '?';
      try {
        const st = await client.playerStats(player.id);
        if (st?.skillXp) miningLvl = levelFromTotalXp(st.skillXp.mining || 0);
      } catch {}

      // kins on-chain (RPC fetch, sama seperti kintara-lifecycle)
      let kins = 0;
      try {
        const nacl = require('tweetnacl');
        const bs58m = require('bs58'); const bs58 = bs58m.default || bs58m;
        const owner = bs58.encode(nacl.sign.keyPair.fromSecretKey(bs58.decode(pks[i])).publicKey);
        const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
        const MINT = process.env.KINS_MINT || 'Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump';
        const r = await fetch(RPC, { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',
            params:[owner,{mint:MINT},{encoding:'jsonParsed'}]}) }).then(x=>x.json());
        const accs = (r.result && r.result.value) || [];
        let raw = 0; for (const a of accs) raw += Number(a.account.data.parsed.info.tokenAmount.amount);
        kins = raw / 1e6;
      } catch (e) { kins = -1; }

      // inventory + bank stone/coal (dari backpack.invSlots & bankSlots)
      let stoneI = 0, coalI = 0, stoneB = 0, coalB = 0;
      try {
        const me = await client.me();
        const bp = me.backpack || {};
        for (const s of (bp.invSlots || [])) {
          if (!s) continue;
          if (s.t === 'stone') stoneI += Number(s.n) || 0;
          if (s.t === 'coal') coalI += Number(s.n) || 0;
        }
        for (const s of (bp.bankSlots || [])) {
          if (!s) continue;
          if (s.t === 'stone') stoneB += Number(s.n) || 0;
          if (s.t === 'coal') coalB += Number(s.n) || 0;
        }
      } catch {}

      rows.push({ tag, name, miningLvl, kins, stoneI, coalI, stoneB, coalB });
      console.log(`${tag}\t${name}\tlv=${miningLvl}\tkins=${kins}\tstone(inv)=${stoneI}\tcoal(inv)=${coalI}\tstone(bank)=${stoneB}\tcoal(bank)=${coalB}`);
      try { await client.logout(); } catch {}
    } catch (e) {
      console.log(`${tag}\tERR\t${e.message.slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  fs.writeFileSync(path.join(__dirname, '..', 'recon/wallet-report.json'), JSON.stringify(rows, null, 2));
  process.exit(0);
})();
