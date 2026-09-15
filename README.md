# 🦞 Kintara Bot

Headless automation bot untuk **Kintara** (MMO isometrik berbasis Solana di kintara.com) — mining, woodcutting, fishing, cooking, combat zombie/dragon, banking, daily quest + spinner, dan orchestrator AUTO — semuanya dikontrol via **Telegram bot**. Tanpa browser.

> ⚠️ **Aturan anti-cheat game:** 1 akun = 1 aktivitas dalam satu waktu (fishing/gathering/combat). Bot ini menghormati timing protokol server (tidak mempercepat timer server) supaya aman.

## ✨ Fitur

| Command | Fungsi |
|---|---|
| `/auto` | 🧠 Smart orchestrator — panen otomatis berbasis target (lihat di bawah) |
| `/rock` | ⛏️ Mining stone + coal |
| `/wood` | 🪓 Woodcutting |
| `/fish` | 🎣 Fishing + auto-cooking |
| `/combat` | ⚔️ Hunt zombie (`/combat boss` = dragon) |
| `/spinner` | 🎡 Daily free spin (auto-kerjain quest dulu, lalu spin) |
| `/tutorial` | 🎓 Tutorial bot |
| `/status` | 📊 Status bot + inventory real-time |
| `/skills` | 📈 Skill levels |
| `/quest` | 📋 Daily quest progress (+ auto-claim) |
| `/market` | 💰 Harga pasar real-time |
| `/server` | 🖥️ Live queues + auto-pick shard |
| `/version` | ℹ️ Game version |
| `/diag` | 🔧 Auth/queue diagnostics |
| `/balance` | 👝 Cek gold |
| `/stop` | 🛑 Stop aktivitas |
| `/help` | 📖 Daftar command |

## 🤖 AUTO Mode (`/auto`)

Siklus target-based — fase berpindah otomatis begitu target tercapai (dicek tiap 30 detik):

```
🪓 wood 1000 → ⛏ stone/coal 2000 (yang duluan) → ⚔️ 20 kill zombie → 🎣 30 cooked fish → ulang
```

- Mati di wild → auto-respawn, re-equip pedang, refill potion, masuk lagi
- Potion auto-craft (health = 60 wood, shield = 50 stone — bahan ditarik dari bank)
- Quest harian auto-claim + spin di antara fase
- Fase stuck > 90 menit → auto-skip ke fase berikutnya

## 🚀 Cara Pakai

### One-line install (VPS Ubuntu/Debian baru)

```bash
curl -sL https://raw.githubusercontent.com/Hobiknock/kintara-bot/main/install.sh | bash
```

Installer otomatis: install Node.js ≥ 18 + screen, clone repo, `npm install`, siapkan `.env` template. **Kamu tinggal isi 2 kredensial sendiri** (jangan pernah share):

```bash
nano ~/kintara-bot/.env
```

- `WALLET_PRIVATE_KEY` — private key wallet akun game kamu
- `TELEGRAM_BOT_TOKEN` — token dari [@BotFather](https://t.me/BotFather) (`/newbot`)

Lalu start:

```bash
~/kintara-bot/start.sh
```

### 🛡️ Persistensi (otomatis terpasang di VPS kamu)

Installer & `start.sh` otomatis pasang cron di VPS kamu — bot **tersimpan dan tetap hidup**:

| Kejadian | Yang terjadi |
|---|---|
| Bot crash | Keeper auto-restart dalam 10 detik |
| Screen/keeper mati total | Cron keep-alive bangunin lagi (maks 5 menit) |
| **VPS reboot / restart** | **Bot auto-start sendiri saat boot** |
| `git pull` update | `.env` & log kamu gak pernah ketimpa — aman |
| Mau berhenti | `~/kintara-bot/stop.sh` — stop **permanen** (cron gak bangunin lagi) |
| Nyalain lagi | `~/kintara-bot/start.sh` |

### Install manual (kalau one-line gak jalan)

<details>
<summary>📋 Klik buat lihat langkah manual</summary>

```bash
# 1. Node.js >= 18 (Ubuntu/Debian)
sudo apt update && sudo apt install -y nodejs npm

# 2. Clone
git clone https://github.com/Hobiknock/kintara-bot.git
cd kintara-bot

# 3. Dependencies
npm install

# 4. Siapkan .env
cp .env.example .env
nano .env   # isi WALLET_PRIVATE_KEY + TELEGRAM_BOT_TOKEN

# 5. Jalanin persisten
./start.sh  # jalan di screen 'kintara' + auto-restart
```

</details>

## 💻 Yang harus di-install (requirements)

- **Node.js ≥ 18** (`node -v` buat cek)
- **npm** (ikut Node)
- **screen** (biasanya udah ada di VPS)
- **git** (buat clone)
- Tidak perlu browser / playwright — bot jalan headless via REST + WebSocket

Dependensi npm (`npm install` otomatis): `ws` (WebSocket), `tweetnacl` + `bs58` (sign auth Solana).

## 🗂️ Struktur

```
kintara-bot/
├── tools/telegram-ctl.js   # entry point — bot Telegram (17 command)
├── tools/farm-loops.js     # engine: mining/wood/fish/combat/spinner/quest
├── lib/
│   ├── kintaraClient.js    # REST client (login, quest, market, banking)
│   ├── presenceWs.js       # WebSocket engine (harvestNodeV2, fishing, combat)
│   ├── walletAuth.js       # auth via private key (Solana sign)
│   ├── bank.js             # deposit/withdraw bank
│   ├── skillXp.js          # level calculator
│   └── telegram.js         # Telegram bot client (long polling)
├── keeper.sh               # auto-restart wrapper
├── start.sh                # starter persisten (screen)
├── install.sh              # one-line installer
├── .env.example            # template kredensial (isi sendiri)
└── package.json
```

## 🔧 Konfigurasi opsional (.env)

| Var | Default | Fungsi |
|---|---|---|
| `KINTARA_SPEED` | `1.5` | Multiplier jeda antar aksi (1.0 = human-normal, 1.5 = cepat) |
| `KINTARA_PHASE_MAX_MIN` | `90` | Durasi maks 1 fase AUTO (menit) sebelum skip |
| `KINTARA_FORCE_SHARD` | auto | Paksa shard (s2 = node terbanyak) |

## 🔐 Keamanan

- `.env` **tidak ikut** ke repo (`.gitignore`) — private key & bot token tidak pernah ter-commit
- Setelah bot jalan, chat bot kamu di Telegram → kirim `/help`
- Chat ID kamu auto-terekam saat command pertama (bot gak mau bales orang lain)

## ⚙️ Troubleshooting

- **Bot gak bales** → cek log: `tail -f recon/telegram-ctl.log`
- **Crash** → keeper auto-restart dalam 10 detik; kalau screen mati total: `./start.sh` lagi
- **`502 / connect gagal`** → server game lagi down — bot auto-retry
- **Menu command lama** → cache Telegram: close-reopen chat bot

## 📜 Lisensi

MIT — pakai tanggung sendiri, ikutin aturan game biar gak kena ban.
