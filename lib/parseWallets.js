// parseWallets.js — parser .env block WALLETS yang bener (dipakai semua tools)
// Format support:
//   WALLETS=pk1,pk2,pk3          (koma satu baris)
//   WALLETS=pk1
//   pk2
//   pk3                          (multi-baris — berhenti di VAR= berikutnya)
// PK murni base58 32-88 char; baris lain (VAR=/komentar/kosong) di-skip otomatis.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');

function isPlausiblePk(line) {
  // PK Solana base58: 32..96 char, hanya [1-9A-HJ-NP-Za-km-z] (tanpa 0 O I l)
  return /^[1-9A-HJ-NP-Za-km-z]{32,96}$/.test(line);
}

function loadPks(envPath) {
  const env = fs.readFileSync(envPath || path.join(ROOT, '.env'), 'utf8');
  const out = [];
  let inWallets = false;
  for (const raw of env.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Za-z_0-9]+=/ .test(line)) {
      if (line.startsWith('WALLETS=')) {
        inWallets = true;
        const v = line.slice(8).trim();
        if (v.includes(',')) { out.push(...v.split(',').map(x => x.trim()).filter(Boolean)); inWallets = false; }
        else if (v && isPlausiblePk(v)) out.push(v);
        else if (v) inWallets = false; // value aneh — jangan baca sebagai pk
      } else {
        inWallets = false; // VAR lain = block WALLETS selesai
      }
      continue;
    }
    if (inWallets && isPlausiblePk(line)) out.push(line);
  }
  return out;
}

module.exports = { loadPks, isPlausiblePk };
if (require.main === module) {
  const pks = loadPks();
  console.log(`wallets terbaca: ${pks.length}`);
  pks.forEach((p, i) => console.log(`w${i + 1} len=${p.length} ${p.slice(0, 6)}…`));
}
