// reclaim-rent.js — tutup token account kosong (reclaim rent), fee payer = vault
const bs58 = require('bs58').default || require('bs58');
const fs = require('fs');
const path = require('path');
const { PublicKey, Connection, Transaction, Keypair, ComputeBudgetProgram } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } = require('@solana/spl-token');
const TOKEN_PROGRAM_ID = TOKEN_2022_PROGRAM_ID; // KINS & ATA game = Token-2022

const conn = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
const vault = Keypair.fromSecretKey(bs58.decode(fs.readFileSync(path.join(__dirname, '..', '.env.vault'), 'utf8').match(/VAULT_PK=(\S+)/)[1]));

function loadPks() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const m = env.match(/WALLETS=((?:[^\n#]*\n?)+)/);
  let pks = m[1].split('\n').map(x => x.trim()).filter(Boolean);
  if (pks.length === 1 && pks[0].includes(',')) pks = pks[0].split(',');
  return pks;
}

(async () => {
  const pks = loadPks();
  for (let i = 0; i < Math.min(21, pks.length); i++) {
    const pub = new PublicKey(bs58.decode(pks[i]).slice(32));
    const r = await fetch(conn.rpcEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [pub.toBase58(), { programId: TOKEN_PROGRAM_ID.toBase58() }, { encoding: 'base64' }] }) }).then(r => r.json());
    const accs = r.result?.value || [];
    for (const a of accs) {
      const ata = new PublicKey(a.pubkey);
      const info = await conn.getParsedAccountInfo(ata);
      const amt = info.value?.data?.parsed?.info?.tokenAmount?.amount;
      if (amt !== '0') continue;
      const owner = new PublicKey(info.value.data.parsed.info.owner);
      const oi = pks.findIndex(pk => { try { return new PublicKey(bs58.decode(pk).slice(32)).equals(owner); } catch { return false; } });
      if (oi < 0) { console.log('w' + (i + 1), 'owner luar .env — skip'); continue; }
      const src = Keypair.fromSecretKey(bs58.decode(pks[oi]));
      const rent = a.account.lamports;
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }))
        .add(createCloseAccountInstruction(ata, src.publicKey, src.publicKey, [], TOKEN_2022_PROGRAM_ID));
      tx.feePayer = vault.publicKey;
      const bh = await conn.getLatestBlockhash();
      tx.recentBlockhash = bh.blockhash;
      tx.sign(src, vault);
      try {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await new Promise(r => setTimeout(r, 4000));
        const s = await conn.getSignatureStatuses([sig]);
        if (s.value[0]?.err) console.log('w' + (oi + 1), 'ERR:', JSON.stringify(s.value[0].err));
        else console.log('w' + (oi + 1), `✅ close ${ata.toBase58().slice(0, 8)} → ${(rent / 1e9).toFixed(6)} SOL balik, tx ${sig.slice(0, 14)}`);
      } catch (e) { console.log('w' + (oi + 1), 'fail:', e.message.slice(0, 90)); }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  const b = await conn.getBalance(vault.publicKey);
  console.log('SOL vault:', (b / 1e9).toFixed(6));
})();
