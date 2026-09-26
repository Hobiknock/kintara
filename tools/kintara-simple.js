// kintara-simple.js — bot Kintara versi simpel (1 file, 1 log, 1 screen)
// Fase: F1 paralel (semua skill → lv5) → F2 mining rock (avg lv <10) → F4 mining rock (KINS ≥1000)
// Auto-listing SELALU OFF (hemat SOL). Laporan ke Telegram per jam + /update /status /help.
//
// PAKAI:
//   screen -dmS kintara bash -c 'node tools/kintara-simple.js >> recon/simple.log 2>&1'
//   tail -f recon/simple.log        # SEMUA log nyatu di sini
//   screen -r kintara               # keluar: Ctrl+A lalu D
//   pkill -f kintara-simple.js      # stop total
//
// .env: WALLETS=pk1\npk2... | TELEGRAM_BOT_TOKEN= | REPORT_TG_CHAT=

const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');
const bs58 = require('bs58').default || require('bs58');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { KintaraClient } = require(path.join(ROOT, 'lib/kintaraClient'));
const loops = require(path.join(ROOT, 'tools/farm-loops.js'));
const { levelFromTotalXp } = require(path.join(ROOT, 'lib/skillXp'));

// ---------- env ----------
const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const PKS = require(path.join(ROOT, 'lib/parseWallets')).loadPks();
const TG_TOKEN = (envText.match(/REPORT_TG_TOKEN=(\S+)/) || envText.match(/TELEGRAM_BOT_TOKEN=(\S+)/) || [])[1] || '';
const TG_CHAT = (envText.match(/REPORT_TG_CHAT=(\S+)/) || envText.match(/TELEGRAM_CHAT_ID=(\S+)/) || [])[1] || '';
const SERVERS = (process.env.KINTARA_SERVERS || '12,13,14,15,16').split(',').map(Number);
const KINS_MINT = new PublicKey('Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('id-ID')}] ${m}`);

// ---------- ctx aman (stop() tidak bergantung this — pelajaran dari bug kemarin) ----------
function makeCtx(name) {
  const ref = { stopped: false };
  return {
    name, bump(k){ this[k] = (this[k]||0)+1; }, get(k){ return this[k]||0; },
    stop(){ return ref.stopped; },
    requestStop(){ ref.stopped = true; this._stop = true; },
    onEvent: (m) => log(`[${name}] ${m}`), onImportant: (m) => log(`[${name}!] ${m}`),
    _lastBeat: Date.now(),
  };
}
function makeCtx2(name, cli) { const c = makeCtx(name); c.cli = cli; c.capLevel = 5; return c; }

// ---------- Telegram ----------
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { log('[tg] skip (no token)'); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (e) { log(`[tg] err ${e.message.slice(0, 40)}`); }
}

// ---------- state ----------
const state = PKS.map((pk, i) => ({
  tag: `w${i + 1}`, pk, phase: 1, kins: 0, avg: 0, name: null,
  cli: null, player: null, freeTier: null, dead: false,
}));
const stats = {}; // {tag: {stone, coal, felled}} delta sejak laporan terakhir
for (const s of state) stats[s.tag] = { stone: 0, coal: 0, felled: 0 };

async function kinsBalance(pk) {
  try {
    const pub = new PublicKey(bs58.decode(pk).slice(32)).toBase58();
    const r = await fetch(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [pub, { mint: KINS_MINT.toBase58() }, { encoding: 'jsonParsed' }] }),
    }).then(r => r.json());
    return (r.result?.value || []).reduce((s, a) => s + parseFloat(a.account.data.parsed.info.tokenAmount.uiAmountString), 0);
  } catch { return 0; }
}

// ---------- wrapper client ----------
async function openClient(s) {
  const w = await KintaraClient.create({ privateKey: s.pk, forceLogin: true });
  s.cli = w.client; s.player = w.player || w.client.player;
  return s.cli;
}

// ---------- helpers game ----------
const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];
async function levelStats(s) {
  const st = await s.cli.playerStats(s.player.id).catch(() => null);
  if (!st) return null;
  const sx = st.skillXp || {};
  const lv = {}; for (const k of SKILLS) lv[k] = levelFromTotalXp(sx[k] || 0);
  return { lv, avg: Number(st.avg) || 0 };
}
async function allAt5(s) { const st = await levelStats(s); return st && SKILLS.every(k => st.lv[k] >= 5); }

// ---------- F1 paralel (1 task per wallet, jalan bersamaan) ----------
async function fase1(s) {
  const order = ['combat', 'wood', 'rock', 'fish', 'cook'];
  let guard = 0;
  while (guard++ < 40 && !s.dead) {
    const st = await levelStats(s);
    if (!st) { await sleep(10000); continue; }
    s.avg = st.avg;
    if (SKILLS.every(k => st.lv[k] >= 5)) { log(`${s.tag} F1 SELESAI ✅ (avg ${st.avg.toFixed(1)})`); s.phase = 2; return; }
    for (const mode of order.sort(() => Math.random() - 0.5)) {
      const key = { combat: 'combat', wood: 'woodcutting', rock: 'mining', fish: 'fishing', cook: 'cooking' }[mode];
      if (st.lv[key] >= 5) continue;
      log(`${s.tag} F1 sesi ${mode} (lv ${st.lv[key]})`);
      const fn = {
        combat: () => loops.runCombat(makeCtx2(mode, s.cli), { dragon: false }),
        wood: () => loops.runWood(makeCtx2(mode, s.cli)),
        rock: () => loops.runRock(makeCtx2(mode, s.cli)),
        fish: () => loops.runFish(makeCtx2(mode, s.cli)),
        cook: () => loops.runCook(makeCtx2(mode, s.cli)),
      };
      try { await fn[mode](); } catch (e) { log(`${s.tag} ${mode} err: ${e.message.slice(0, 60)}`); }
      await sleep(rnd(5000, 10000));
      break; // re-check level
    }
  }
  s.phase = 2;
}

// ---------- F2/F4 mining (satu task per wallet, jalan paralel) ----------
async function miningLoop(s, srv, capLevel) {
  for (let i = 1; !s.dead; i++) {
    const ctx = makeCtx(`${s.tag}-rock${i}`); ctx.cli = s.cli; ctx.capLevel = capLevel;
    try {
      await loops.runRock(ctx);
      stats[s.tag].stone += ctx.stone || 0; stats[s.tag].coal += ctx.coal || 0; stats[s.tag].felled += ctx.felled || 0;
    } catch (e) { log(`${s.tag} mining err: ${e.message.slice(0, 60)}`); }
    await sleep(10000);
    try { await s.cli.ensureLogin(); } catch {}
    if (i % 20 === 0) { // re-check level tiap ±20 sesi
      const st = await levelStats(s);
      if (st) { s.avg = st.avg; if (capLevel === 10 && st.avg >= 10) { log(`${s.tag} avg ${st.avg.toFixed(1)} ≥10 — F2 tuntas`); return; } }
    }
  }
}

// ---------- laporan ----------
function buildReport() {
  const lines = [];
  let ts = 0, tc = 0;
  for (const s of state) {
    if (s.dead) continue;
    const d = stats[s.tag];
    lines.push(`▸ ${s.name || s.tag} — ${s.phase === 1 ? 'F1 skill-push' : s.phase === 2 ? `F2 rock (avg ${s.avg.toFixed(1)})` : 'F4 rock (KINS)'} — ${d.stone} stone + ${d.coal} coal`);
    ts += d.stone; tc += d.coal;
  }
  return `📊 <b>LAPORAN KINTARA</b>\n${lines.join('\n')}\n\n<b>TOTAL: ${ts} stone + ${tc} coal</b>`;
}
function resetReport() { for (const t of Object.keys(stats)) stats[t] = { stone: 0, coal: 0, felled: 0 }; }

(async () => {
  log(`BOOT simple — ${state.length} wallet`);
  // login berurutan dengan jeda (anti rate-limit), SETELAH itu semua paralel
  for (const s of state) {
    try {
      await openClient(s);
      s.name = s.player?.display_name || s.player?.name || null;
      const me = await s.cli.me().catch(() => ({}));
      s.freeTier = !!me.freeTier;
      s.kins = await kinsBalance(s.pk);
      const st = await levelStats(s);
      s.avg = st ? st.avg : 0;
      const all5 = st && SKILLS.every(k => st.lv[k] >= 5);
      s.phase = !all5 ? 1 : (s.avg < 10 ? 2 : (s.kins >= 1000 && !s.freeTier ? 4 : (s.freeTier ? -1 : 2)));
      if (s.phase === -1) { s.dead = true; log(`${s.tag} ${s.name} 🔒 paywall (lv10+ tanpa KINS) — skip`); }
      else log(`${s.tag} ${s.name} login ok — fase ${s.phase} (avg ${s.avg.toFixed(1)}, kins ${s.kins})`);
    } catch (e) { s.dead = true; log(`${s.tag} login gagal: ${e.message.slice(0, 70)}`); }
    await sleep(rnd(15000, 30000));
  }

  // PARALEL: tiap wallet satu task async, jalan bersamaan
  let srvIdx = 0;
  const tasks = state.filter(s => !s.dead).map(async (s) => {
    try {
      if (s.phase === 1) await fase1(s);
      if (s.phase === 2 || s.phase === 4) {
        const srv = SERVERS[(srvIdx++) % SERVERS.length];
        log(`${s.tag} mulai mining paralel @srv${srv}`);
        await miningLoop(s, srv, s.phase === 2 ? 10 : 99);
      }
    } catch (e) { log(`${s.tag} task fatal: ${e.message.slice(0, 70)}`); s.dead = true; }
  });
  await Promise.all(tasks);
  log('semua task selesai — bot exit');
  process.exit(0);
})();

// ---------- jam-jaman + /update ----------
(async () => {
  let last = Date.now();
  for (;;) {
    await sleep(60000);
    if (Date.now() - last < 3600000) continue;
    last = Date.now();
    await tg(buildReport()); resetReport();
  }
})();

(async () => {
  let off = 0;
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${off}`);
      const j = await r.json();
      for (const u of (j.result || [])) {
        off = u.update_id + 1;
        const cmd = String(u.message?.text || '').trim().split(/\s+/)[0];
        if (!cmd || String(u.message?.chat?.id) !== String(TG_CHAT)) continue;
        if (cmd === '/update' || cmd === '/status') await tg(buildReport());
        else if (cmd === '/help') await tg('📖 /update atau /status — laporan instan');
      }
    } catch (e) { log(`[tg poll] ${e.message.slice(0, 40)}`); }
    await sleep(3000);
  }
})();
