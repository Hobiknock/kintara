// ============ BANK — deposit barang ke bankSlots (safety sebelum combat) ============
// Confirmed live: walk ke gedung bank Mainland (col6.5,row13 = world -24,-17.5),
// pindah invSlots->bankSlots via save-backpack, carried total turun (aman kalau mati).
const gs = require('./gameState');

const BANK_WORLD = { x: 6.5 - 30.5, z: 13 - 30.5 }; // -24, -17.5

/**
 * Deposit resource tertentu (atau semua tradeable) ke bank. HARUS sudah di posisi
 * bank Mainland (panggil presence.walkTo(BANK_WORLD) dulu, region=world).
 * @param {KintaraClient} cli
 * @param {string[]} types resource types yg di-bank
 * @returns {Promise<{moved:string[], ok:boolean}>}
 */
async function depositAll(cli, types = ['wood', 'stone', 'coal', 'metal', 'fish', 'cooked_fish_meat']) {
  const st = await gs.fetchState(cli); const bp = st.backpack;
  const inv = bp.invSlots || []; const bank = bp.bankSlots || [];
  const moved = [];
  for (const type of types) {
    let movedQty = 0;
    for (let i = 0; i < inv.length; i++) {
      if (inv[i] && inv[i].t === type && inv[i].n > 0) {
        const n = inv[i].n;
        let bi = bank.findIndex((s) => s && s.t === type);
        if (bi >= 0) bank[bi].n += n;
        else { bi = bank.findIndex((s) => !s); if (bi >= 0) bank[bi] = { t: type, n }; else break; }
        movedQty += n;
        moved.push(`${n} ${type}`);
        inv[i] = null;
      }
    }
    if (movedQty > 0) bp[type] = Math.max(0, Number(bp[type] || 0) - movedQty);
  }
  if (!moved.length) return { moved: [], ok: true };
  try { await gs.pushBackpack(cli, bp, st.stateSeq, []); return { moved, ok: true }; }
  catch (e) { return { moved, ok: false, err: e.message }; }
}

/**
 * Withdraw resource dari bankSlots ke invSlots (kebalikan depositAll) —
 * alchemist-potion-buy versi server baru hanya baca bahan di BACKPACK (bukan bank).
 * HARUS sudah di posisi bank Mainland.
 * @param {KintaraClient} cli
 * @param {Record<string,number>} wants misal { wood: 40, stone: 12 }
 */
async function withdraw(cli, wants = {}) {
  const st = await gs.fetchState(cli); const bp = st.backpack;
  const inv = bp.invSlots || []; const bank = bp.bankSlots || [];
  const moved = [];
  for (const [type, wantQty] of Object.entries(wants)) {
    let need = Number(wantQty) || 0;
    if (need <= 0) continue;
    for (let i = 0; i < bank.length && need > 0; i++) {
      const s = bank[i];
      if (s && s.t === type && s.n > 0) {
        const take = Math.min(need, s.n);
        // taruh di slot inv pertama yang compatible/kosong
        let ii = inv.findIndex((x) => x && x.t === type && x.n > 0);
        if (ii < 0) ii = inv.findIndex((x) => !x);
        if (ii < 0) break;
        if (inv[ii] && inv[ii].t === type) inv[ii].n += take;
        else inv[ii] = { t: type, n: take };
        s.n -= take; if (s.n <= 0) bank[i] = null;
        bp[type] = (Number(bp[type]) || 0) + take;
        need -= take;
        moved.push(`${take} ${type}`);
      }
    }
  }
  if (!moved.length) return { moved: [], ok: true };
  try { await gs.pushBackpack(cli, bp, st.stateSeq, []); return { moved, ok: true }; }
  catch (e) { return { moved, ok: false, err: e.message }; }
}

module.exports = { depositAll, withdraw, BANK_WORLD };
