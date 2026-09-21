# DEPLOY DI VPS LAIN (copy-paste ready)

## 1. Clone & install
```bash
git clone -b lifetime https://github.com/Hobiknock/kintara-bot-private.git
cd kintara-bot-private
npm install
```

## 2. Buat .env (template)
```bash
cat > .env << 'EOF'
# ===== WALLET (WAJIB - 1 pk per baris) =====
WALLETS=pk_pertama_disini
pk_kedua_disini
pk_ketiga_disini

# ===== TELEGRAM (opsional - lapor wallet ineligible) =====
REPORT_TG_TOKEN=
REPORT_TG_CHAT=

# ===== OPSI (opsional) =====
KINTARA_FORCE_SERVER=
SELL_THRESHOLD=10000
EOF
chmod 600 .env
nano .env   # isi pk beneran + token TG kalau mau lapor
```

## 3. Jalankan di screen
```bash
# start
screen -dmS lifecycle bash -c 'node tools/kintara-lifecycle.js >> recon/lifecycle.out 2>&1'

# lihat log
tail -f recon/lifecycle.out

# lihat layar langsung (keluar: Ctrl+A lalu D)
screen -r lifecycle
```

## 4. Kontrol
```bash
# stop
screen -S lifecycle -X quit

# restart
screen -S lifecycle -X quit; screen -dmS lifecycle bash -c 'node tools/kintara-lifecycle.js >> recon/lifecycle.out 2>&1'
```

## 5. Biar hidup terus (auto-restart tiap 5 menit)
```bash
(crontab -l; echo '*/5 * * * * screen -dmS lifecycle bash -c "cd $(pwd) && node tools/kintara-lifecycle.js >> recon/lifecycle.out 2>&1"' ) | crontab -
```
Hati-hati: ini bisa spawn dobel — lebih aman versi guarded:
```bash
(crontab -l; echo '*/5 * * * * screen -ls | grep -q lifecycle || screen -dmS lifecycle bash -c "node /path/ke/kintara-bot-private/tools/kintara-lifecycle.js >> /path/ke/kintara-bot-private/recon/lifecycle.out 2>&1"') | crontab -
```
(Ganti /path/ke/ sesuai lokasi repo di VPS baru)
