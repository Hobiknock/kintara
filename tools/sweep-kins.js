// sweep-kins.js — pindahkan SEMUA KINS dari wallet game ke vault (fee payer = vault)
// Pakai: node tools/sweep-kins.js <wN|pubkey>   (contoh: node tools/sweep-kins.js w10)
// Butuh: .env.vault (VAULT_PK), SOL di vault (min ~0.01) & di wallet sumber (min ~0.005)
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58').default || require('bs58');
const {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, createTransferInstruction, getAssociatedTokenAddress,
} = require('@solana/spl-token');

// KINS bisa jadi token Token-2022 — deteksi program mint-nya dulu lewat ATA sumber
let KINS_TOKEN_PROGRAM = TOKEN_PROGRAM_ID;

const KINS_MINT = new PublicKey('Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump');
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

function loadVault() {
  const f = path.join(__dirname, '..', '.env.vault');
  const raw = fs.readFileSync(f, 'utf8');
  const pk = (raw.match(/VAULT_PK=(\S+)/) || [])[1];
  if (!pk) throw new Error('VAULT_PK tidak ada di .env.vault');
  return Keypair.fromSecretKey(bs58.decode(pk));
}
function loadGameKeypair(tag) {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const m = env.match(/WALLETS=((?:[^\n#]*\n?)+)/);
  let pks = m[1].split('\n').map(x => x.trim()).filter(Boolean);
  if (pks.length === 1 && pks[0].includes(',')) pks = pks[0].split(',');
  let idx = -1;
  if (/^w\d+$/.test(tag)) idx = Number(tag.slice(1)) - 1;
  else idx = pks.findIndex(x => { try { return bs58.encode(Buffer.from(bs58.decode(x).slice(32))) === tag; } catch { return false; } });
  if (idx < 0 || !pks[idx]) throw new Error('wallet tidak ketemu: ' + tag);
  return Keypair.fromSecretKey(bs58.decode(pks[idx].trim()));
}

(async () => {
  const tag = process.argv[2];
  if (!tag) { console.error('Pakai: node tools/sweep-kins.js <wN|pubkey>'); process.exit(1); }
  const vault = loadVault();
  const src = loadGameKeypair(tag);
  console.log('sumber :', src.publicKey.toBase58());
  console.log('vault  :', vault.publicKey.toBase58());

  const conn = new Connection(RPC, 'confirmed');
  const [srcSol, vaultSol] = await Promise.all([
    conn.getBalance(src.publicKey), conn.getBalance(vault.publicKey),
  ]);
  console.log('SOL sumber:', (srcSol / LAMPORTS_PER_SOL).toFixed(6), '| SOL vault:', (vaultSol / LAMPORTS_PER_SOL).toFixed(6));

  const srcAta = await getAssociatedTokenAddress(KINS_MINT, src.publicKey);
  const vaultAta = await getAssociatedTokenAddress(KINS_MINT, vault.publicKey);
  // ATA real wallet game kadang bukan derived standar — deteksi otomatis via getTokenAccountsByOwner
  let srcAtaReal = srcAta;
  let srcTok = await conn.getTokenAccountBalance(srcAta).catch(() => null);
  if (!srcTok?.value?.uiAmount) {
    const rpc = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [src.publicKey.toBase58(), { mint: KINS_MINT.toBase58() }, { encoding: 'jsonParsed' }] }) }).then(r => r.json());
    const accs = rpc?.result?.value || [];
    for (const a of accs) {
      const b = await conn.getTokenAccountBalance(new PublicKey(a.pubkey)).catch(() => null);
      if (b?.value?.uiAmount > 0) { srcAtaReal = new PublicKey(a.pubkey); srcTok = b; break; }
    }
  }
  // deteksi program token (spl-token / token-2022) dari akun sumber
  const srcAccInfo = await conn.getParsedAccountInfo(srcAtaReal).catch(() => null);
  const srcOwnerProgram = srcAccInfo?.value?.owner?.toBase58?.() || srcAccInfo?.value?.owner;
  KINS_TOKEN_PROGRAM = srcOwnerProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  console.log('token program:', KINS_TOKEN_PROGRAM.toBase58().slice(0, 12));
  const amount = srcTok?.value?.uiAmount || 0;
  if (amount < 1) { console.log('KINS sumber 0 — nggak ada yang di-sweep'); return; }
  console.log('KINS sumber:', amount.toLocaleString('id-ID'));

  // biaya: rent vault ATA (~0.002 kalau belum ada) + gas 2 tx + topup gas sumber + buffer
  const vaultInfo = await conn.getAccountInfo(vaultAta).catch(() => null);
  const topup = 1000000; // 0.001 SOL ke sumber
  const needVault = (vaultInfo ? 0 : 2070000) + 30000 + topup + 20000;
  if (vaultSol < needVault + 200000) throw new Error(`SOL vault kurang: ${(vaultSol / 1e9).toFixed(6)} SOL — isi vault minimal ${((needVault + 200000) / 1e9).toFixed(4)} SOL (saran 0.015) lalu ulangi`);
  // sumber SOL 0 = tidak apa-apa: vault top-up gas dulu (fee payer = vault)

  // top-up gas ke sumber dari vault (system transfer)
  // PENTING: sumber harus rent-exempt ~0.00089 SOL + gas transfer ~0.00001
  // Vault juga harus sisa cukup buat rent ATA vault-nya sendiri (~0.00207) + fee
  let tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
    SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: src.publicKey, lamports: topup }),
  );
  tx.feePayer = vault.publicKey;
  const bh1 = await conn.getLatestBlockhash();
  tx.recentBlockhash = bh1.blockhash;
  tx.sign(vault);
  const sig1 = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  try { await conn.confirmTransaction(sig1, 'confirmed'); } catch (e) { const l = await conn.getSignatureStatuses([sig1]); if (l.value?.[0]?.err) throw new Error('topup gagal: ' + JSON.stringify(l.value[0].err)); }
  console.log('✅ top-up gas ke sumber:', sig1.slice(0, 20));

  // build transfer KINS src → vault
  const vaultAta2 = await getAssociatedTokenAddress(KINS_MINT, vault.publicKey, false, KINS_TOKEN_PROGRAM);
  const vaultInfo2 = await conn.getAccountInfo(vaultAta2).catch(() => null);
  const tx2 = new Transaction();
  if (!vaultInfo2) tx2.add(createAssociatedTokenAccountInstruction(vault.publicKey, vaultAta2, vault.publicKey, KINS_MINT, KINS_TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID));
  const decimals = srcTok?.value?.decimals ?? 6;
  tx2.add(createTransferInstruction(srcAtaReal, vaultAta2, src.publicKey, BigInt(Math.floor(amount * 10 ** decimals)), [], KINS_TOKEN_PROGRAM));
  tx2.feePayer = vault.publicKey;
  const bh2 = await conn.getLatestBlockhash();
  tx2.recentBlockhash = bh2.blockhash;
  tx2.sign(src, vault); // owner token & fee payer sama-sama sign
  const sig2 = await conn.sendRawTransaction(tx2.serialize(), { skipPreflight: true });
  let conf2;
  try { conf2 = await conn.confirmTransaction(sig2, 'confirmed'); }
  catch (e) {
    const st = await conn.getSignatureStatuses([sig2]);
    if (st.value?.[0]?.err) {
      // kalau gagal InsufficientFundsForRent → butuh lebih banyak SOL di vault (buat rent ATA vault)
      throw new Error('transfer gagal: ' + JSON.stringify(st.value[0].err) + ' — isi vault lagi ~0.01 SOL lalu ulangi');
    }
  }
  console.log('✅ SWEEP OK:', sig2);

  const bal = await conn.getTokenAccountBalance(vaultAta).catch(() => null);
  console.log('KINS di vault sekarang:', bal?.value?.uiAmount ?? '?');
})().catch(e => { console.error('GAGAL:', e.message); process.exit(1); });
