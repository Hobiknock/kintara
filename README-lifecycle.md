# kintara-lifecycle — Script Farming End-to-End Multi-Wallet

Script otomatis untuk akun kintara multi-wallet: dari tutorial sampai jual hasil mining di marketplace.

## Fase

| Fase | Apa yang dilakukan | Selesai kapan |
|---|---|---|
| **Deteksi** | Cek kondisi tiap wallet — fase yang udah selesai langsung di-skip | - |
| **1** | Tutorial + outfit random + semua skill ke **lv 5** | semua skill ≥ 5 |
| **2** | Mining rock SAJA (stone & coal) — skill lain berhenti di lv 5 | **level MINING ≥ 10** |
| **3** | Seleksi: wallet pegang **≥ 1000 $KINS**? | eligible semua / lapor TG |
| **4** | Cek umur KINS ≥ **24 jam** + **auto-sell** hasil mining di market | terus berjalan (cek per jam) |

### Aturan penting fase 2
- Setelah semua skill lv 5, yang jalan cuma **mining rock (stone & coal)** — skill lain berhenti di lv 5.
- Stop saat **level MINING ≥ 10** (bukan avg) → lanjut seleksi fase 3 (harus hold 1000 KINS).

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

#### Otomatis (rekomendasi)

```bash
bash start-lifecycle.sh            # spawn screen 'lifetime' + mining-watchdog
```

atau deploy sekali jalan (clone + install + env + start + cron watchdog):

```bash
bash deploy-vps.sh
```

#### Manual (run sendiri)

```bash
# 0) siapkan dulu: npm install (sekali) + isi WALLETS di .env (lihat langkah 1)
npm install

# 1) test dulu di depan (lihat log langsung, Ctrl+C buat stop)
node tools/kintara-lifecycle.js

# 2) kalau udah oke, jalankan di background via screen
screen -dmS lifetime bash -c 'node tools/kintara-lifecycle.js >> recon/lifecycle.out 2>&1'

# 3) jalankan watchdog manual (respawn mining screen tiap 2 menit)
screen -dmS watchdog bash -c 'node tools/mining-watchdog.js >> recon/watchdog.out 2>&1'

# masuk ke screen buat lihat log live:
screen -r lifetime      # detach lagi: Ctrl+A lalu D
```

Kalau mau run 1 wallet doang tanpa .env (quick test):

```bash
node tools/kintara-lifecycle.js <<< ""   # TIDAK — script baca dari .env saja.
# Buat test 1 wallet: buat .env mini berisi satu block WALLETS= pk_test
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

**Q: Knpa fase 2 cuma mining rock?**
A: Setelah semua skill lv 5, yang di-push cuma mining (stone & coal) sampai
**mining lv 10** — skill lain diem di lv 5. Setelah itu akun stop mining dan
masuk seleksi fase 3 (wajib hold 1000 KINS).
