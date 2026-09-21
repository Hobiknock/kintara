# kintara-lifecycle — Script Farming End-to-End Multi-Wallet

Script otomatis untuk akun kintara multi-wallet: dari tutorial sampai jual hasil mining di marketplace.

## Fase

| Fase | Apa yang dilakukan | Selesai kapan |
|---|---|---|
| **Deteksi** | Cek kondisi tiap wallet — fase yang udah selesai langsung di-skip | - |
| **1** | Tutorial + outfit random + semua skill ke **lv 5** | semua skill ≥ 5 |
| **2** | Mining rock (stone & coal) terus-menerus | **rata-rata (avg) semua skill ≥ 10** |
| **3** | Seleksi: wallet pegang **≥ 1000 $KINS**? | eligible semua / lapor TG |
| **4** | Cek umur KINS ≥ **24 jam** + **auto-sell** hasil mining di market | terus berjalan (cek per jam) |

### Aturan penting fase 2
- Semua skill sudah lv 5 tapi **avg belum 10** → tetap mining rock, jangan berhenti.
- Berhenti hanya saat **avg ≥ 10**.

### Aturan penting fase 4 (auto-sell)
- Listing **maksimal 5.000 stone/coal per listing**
- **Maksimal 5 listing aktif** per akun — kalau penuh, tunggu siklus berikutnya
- Harga = floor token saat itu (min $0.01 USD)
- Hanya jual wallet yang KINS-nya ≥ 1000 **dan** umur ≥ 24 jam

## Cara Pakai

### 1. Siapkan wallet di `.env`

Di root repo, edit `.env` dan tambahkan block `WALLETS` — 1 private key per baris:

```env
WALLETS=pk_wallet_pertama_base58
pk_wallet_kedua_base58
pk_wallet_ketiga_base58
```

Atau satu baris pakai koma:

```env
WALLETS=pk1,pk2,pk3
```

Opsional:

```env
# Lapor fase 3 ke Telegram (daftar wallet ineligible)
REPORT_TG_TOKEN=123456:ABC...
REPORT_TG_CHAT=123456789

# Paksa server tertentu (mis. 12)
KINTARA_FORCE_SERVER=12

# Target jual per siklus (default 10000)
SELL_THRESHOLD=10000
```

### 2. Jalankan

```bash
# langsung
node tools/kintara-lifecycle.js

# atau via screen (rekomendasi)
screen -dmS lifecycle bash -c 'node tools/kintara-lifecycle.js >> recon/lifecycle.out 2>&1'
```

### 3. Monitor

```bash
tail -f recon/lifecycle.out          # log utama
tail -f recon/multi/lc-w1.out        # log mining per wallet (fase 2)
screen -ls                           # lihat screen aktif
```

## Kenapa wallet bisa "ditahan server"?

Server kintara punya rate-limit login per-IP (`registration_blocked`). Kalau lo login
banyak akun berturut-turut, login sementara diblokir. Script ini **otomatis retry
tiap 60 detik (maks 20x per wallet)** — biarkan aja, begitu dibuka dia lanjut sendiri.

Tips: jangan matiin screen yang udah login — session cookie aktif itu berharga.
Minimize login baru: jalankan lifecycle sekali, biarkan jalan.

## Verifikasi $KINS & umur token

Script cek lewat Solana mainnet RPC:
- Saldo: `getTokenAccountsByOwner` (mint $KINS)
- Umur: `getSignaturesForAddress` — transfer pertama di token account = umur KINS

Mint $KINS default: `Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump` (bisa dioverride via `KINS_MINT` di .env)

## Struktur

```
tools/kintara-lifecycle.js   # script utama
lib/kintaraClient.js         # API client (login, marketplace, dll)
lib/presenceWs.js            # presence WS (wajib utk sell — region_required)
lib/skillXp.js               # perhitungan level per skill
```

## FAQ

**Q: Kenapa wallet saya skip fase 1?**
A: Semua skill-nya udah ≥ 5 — deteksi otomatis langsung loncat ke fase berikutnya.

**Q: Listing saya gak muncul di market?**
A: Cek `marketplaceListings({mine:true})` — max 5 listing aktif per akun. Kalau penuh,
tunggu yang lama kejual/expired.

**Q: Bisa gak mining lebih dari avg 10?**
A: Fase 2 stop di avg 10 sesuai aturan pengguna gratis. Ubah di `phase2` monitor kalau perlu.
