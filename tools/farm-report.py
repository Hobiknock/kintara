#!/usr/bin/env python3
# farm-report.py — tabel progres level semua akun kintara (stdout dikirim cron ke Telegram)
import json, glob, time

rows = []
for f in glob.glob('/home/agentuser/kintara-bot/recon/multi/*.levels.json'):
    d = json.load(open(f))
    lv = d['levels']
    done = sum(1 for v in lv.values() if v >= 5)
    rows.append((done, d['name'], lv, d['updated']))
rows.sort(key=lambda x: (-x[0], x[1]))

ok = '✅'
lines = ["*📊 KINTARA FARM — Progres Lv 5*",
         f"_{time.strftime('%d %b %Y %H:%M')}_", "",
         "| # | Akun | Cmb | Wd | Min | Fsh | Ck | Prog |",
         "|---|------|----|----|-----|-----|----|------|"]
for i, (done, name, lv, up) in enumerate(rows, 1):
    age = int((time.time() * 1000 - up) / 60000)
    c = lambda s: str(lv.get(s, 0))
    if done == 5:
        prog = "DONE 🏆"
    else:
        below = [s[:3] for s in ('combat','woodcutting','mining','fishing','cooking') if lv.get(s,0) < 5]
        prog = f"{done}/5 ({','.join(below)})"
    lines.append(f"| {i} | {name} | {c('combat')} | {c('woodcutting')} | {c('mining')} | {c('fishing')} | {c('cooking')} | {prog} |")

n = len(rows)
full = sum(1 for r in rows if r[0] == 5)
lines += ["", f"*Total:* {full}/{n} akun selesai penuh 🏆",
          "*Bottleneck:* combat / cooking masih jadi tumpuan"]
print('\n'.join(lines))
