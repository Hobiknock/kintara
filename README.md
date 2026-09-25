# ⛏️ Kintara Farm Bot

Bot farming multi-wallet untuk **Kintara** (kintara.com) — mining stone/coal otomatis dengan paywall gate, server dedicated 1/1, failover cerdas, dan laporan Telegram.

> Fokus: **stone & coal** dari rock mining. Wallet tanpa 1000 KINS yang sudah lv10+ otomatis dihentikan (paywall server-side).

## ✨ Fitur Utama

### 1. Paywall Gate (freeTier)
- Tiap wallet dicek on-chain (balance KINS) + `freeTier` dari `/api/auth/me`
- **lv10+ tanpa 1000 KINS = paywall** → mining STOP, tidak di-respawn, tidak listing
- Wallet dapat ≥1000 KINS → otomatis lanjut farming lagi
- Verifikasi **per private key** (bukan label nama) — selalu akurat

### 2. Login 1/1 — Server Dedicated
- Kandidat: asia 12–16, eu 8–11, us 1–7 (us hanya untuk wallet membership)
- Tiap wallet dapat **1 server yang tidak dipakai wallet lain**
- Watchdog respawn selalu balik ke server dedicated-nya sendiri

### 3. Failover Cerdas (port dari kintara-bot orchestrator)
- `pickHealthyShard()`: ambil `/api/servers` → **filter asia/eu saja (id ≥ 8, server us 1–7 kena `membership_required` 403)** → cek `gate-check?shard=N` → pilih sehat
- Trigger: >15 node skip beruntun + >5 mnt tanpa panen, ATAU stuck >5 mnt walau tanpa node skip
- Shard baru **diverifikasi beneran nyambung** — kandidat gagal → otomatis coba berikutnya
- Fallback lama tetap ada: scan shard by node (>8 mnt zero felled)

### 4. Laporan Telegram
- **Otomatis per jam**: hasil per wallet (nama akun in-game, stone/coal/ore/node, server) + TOTAL + rate ore/jam
- **On-demand**: kirim `/update` → laporan instan
- Command: `/update`, `/status`, `/help`
- Angka yang dilaporkan = **delta sejak laporan terakhir** (bukan kumulatif)

### 5. Kecepatan
- `KINTARA_SPEED` default **2.5** (max 3) — pangkas jeda client saja, protokol server tidak disentuh
- `harvestNodeV2 maxSec: 10` — node HP tinggi tidak kepotong

## 🚀 Cara Pakai

### 1. Install

```bash
git clone https://github.com/Hobiknock/kintara.git
cd kintara
npm install
```

### 2. Isi `.env`

```env
# Wallet — 1 private key per baris di block WALLETS (atau dipisah koma)
WALLETS=pk_wallet1_base58
pk_wallet2_base58
pk_wallet3_base58

# Telegram (wajib kalau mau laporan)
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=chat_id_kamu
REPORT_TG_TOKEN=123456:ABC...   # opsional, override token laporan
REPORT_TG_CHAT=chat_id_kamu

# Opsional
KINTARA_FORCE_SERVER=12   # paksa semua wallet ke 1 server (menonaktifkan 1/1)
KINTARA_AUTOLIST=0        # (default) auto-listing OFF — fee on-chain game menguras SOL; set 1 utk aktifkan lagi
```

### 3. Jalankan

```bash
# test di depan (Ctrl+C stop)
node tools/kintara-lifecycle.js

# produksi — background
screen -dmS lifetime bash -c 'node tools/kintara-lifecycle.js >> lifecycle.log 2>&1'
```

### 4. Monitor

```bash
tail -f lifecycle.log              # log utama
tail -f recon/multi/lc-w1.out      # log mining per wallet
screen -ls                          # screen aktif
```

Lalu di Telegram: kirim `/update` kapan saja untuk laporan instan.

## 📊 Contoh Laporan

```
📊 LAPORAN MINING (16.32 — 60 mnt)
▸ molie @srv12 — 1.620 stone + 420 coal = 2.040 ore (105 node)
▸ wuavee @srv13 — 3.000 stone + 780 coal = 3.780 ore (150 node)
...
TOTAL: 12.960 stone + 5.280 coal = 18.240 ore (1.500 node dipanen, ~18.240 ore/jam)
```

## 🔧 Tools Pendukung

```bash
node tools/list-names.js   # laporan semua wallet: nama, level, KINS on-chain, stone/coal inv+bank
node tools/check-inv.js    # cek inventory cepat
```

## ⚙️ Alur Fase

| Fase | Kondisi | Aksi |
|---|---|---|
| F1 | skill < 5 | push semua skill sampai rata (tutorial aman) |
| F2 | semua skill ≥ 5, akun < lv10 | mining rock gratis sampai avg lv 10 |
| F3 | lv10, KINS ≥ 1000, umur ≥ 24 jam | jaga screen mining; hasil ditumpuk di bank game (auto-listing OFF — fee on-chain menguras SOL; jual manual batch kalau perlu) |
| F4 | — | mining rock terus + watchdog (KINS habis → stop; dapat → mulai) |

Wallet lv10+ tanpa 1000 KINS → **paywall** → stop total (aturan: *gabisa farming*).

## ⚠️ Catatan

- Server kintara rate-limit login per-IP — bot auto-retry tiap 60 dtk (maks 20×/wallet)
- Server berkala 502/404 (Cloudflare) — failover menangani, tapi kalau semua server sumpek ya breather
- 1 akun = 1 aktivitas dalam satu waktu (aturan anti-cheat game)

## 📜 Lisensi

MIT
