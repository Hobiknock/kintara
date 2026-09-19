# Multi-Account — 1 repo, banyak akun di 1 VPS

## Cara pakai
1. Daftarkan akun di `accounts.json` (file di root repo, chmod 600 otomatis):
   ```json
   [
     { "name": "kwrock", "wallet": "<base58 pk>", "bot_token": "<token @BotFather>", "chat_id": "<chat id>", "mode": "auto", "server": 15 },
     { "name": "kw31", "wallet": "...", "bot_token": "...", "chat_id": "...", "mode": "rock" }
   ]
   ```
   - `name` = unik, dipakai sebagai nama screen `kintara-<name>`
   - `wallet` = base58 private key Solana
   - `bot_token` = token bot Telegram milik akun itu (1 bot per akun, bikin di @BotFather)
   - `mode` = aktivitas awal (auto/rock/wood/combat/fish/cook), `server` = KINTARA_FORCE_SERVER
2. Jalankan:
   - Semua akun sekaligus: `./start-all.sh` (stagger 20 dtk per akun, anti rate-limit)
   - Satu akun saja: `./start-account.sh kwrock`
3. Persistensi: `./persist-all.sh` — pasang 1 cron (keep-alive tiap 5 mnt + @reboot) untuk SEMUA akun.
   Akun yang screen-nya mati dihidupkan ulang otomatis.
4. Kontrol tetap lewat Telegram: chat bot masing-masing akun → /status /rock /combat /setkey dst.

## Stop
- Stop permanen 1 akun (cron gak bangunin): `./stop-account.sh <nama>` → bikin `recon/STOP-<nama>`
- Nyalakan lagi: `rm recon/STOP-<nama> && ./start-account.sh <nama>`

## Ganti wallet via Telegram
- `/setkey <pk>` di bot akun itu → tulis ke `accounts.json` (mode multi), relogin, lapor wallet+nama+levels.
  Tidak menyalin clone lain — tiap bot token hanya pegang akunnya.

## Catatan
- Bot token HARUS unik per akun. Dua proses pakai token sama → Telegram error
  "Conflict: terminated by other getUpdates request".
- Mode lama (satu akun via .env) tetap jalan kalau `KINTARA_ACCOUNT` tidak diset —
  fleet kw11–kw30 (headless-runner) & bot `kintara` tidak terpengaruh.
- Log per akun: `recon/multi/<nama>.out`
