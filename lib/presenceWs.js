// ============ PRESENCE WS — client headless (Path A, no browser) ============
// Replikasi koneksi game client:
//   1) login wallet -> cookie kintara_session
//   2) connect wss://kintara.gg/ws/queue/<shard>, kirim {t:q_ping} s/d {t:queue_ready}
//   3) connect wss://kintara.gg/ws/presence/<shard>, kirim {t:pos,...}
// Set region via pos -> server bales {t:region_ack}. Itu gerbang aksi region (fishing).
const WebSocket = require('ws');
const EventEmitter = require('events');
const { login } = require('./walletAuth');
const { config } = require('../config');

const HOST = process.env.KINTARA_WS_HOST || 'as.kintara.com'; // infra baru kintara.com (was kintara.gg)

class Presence extends EventEmitter {
  constructor(shard = config.shard || 's3', opts = {}) {
    super();
    this.shard = shard;
    this.opts = opts || {};
    this._wsBaseOverride = opts.wsBaseUrl || null;
    this._originOverride = opts.origin || null;
    this._clientRef = opts.clientRef || null;
    this.savedOutfit = opts.savedOutfit || null; // outfit dari cli.me() — biar char gak polos
    this._connectToken = opts.connectToken || null; // ?kt= token dari queue_ready/REST
    this.cookie = null;
    this.queueWs = null;
    this.presenceWs = null;
    this.ready = false;
    this.region = 'world';
    this.pos = { x: 8.5, y: 0.25, z: 13.5, ry: 0 };
    this._qping = null;
    this._posTimer = null;
    // combat / survival state
    this.eq = null;            // equipped item type (wild_sword utk combat)
    this.hp = 100;             // server-authoritative, di-update dari wild_mb_ack/snap self-entry
    this.shield = 0;           // shield charges (0-5), dari potion_shield
    this.lifeEpoch = 0;        // le terakhir dari server (echo di pos/wm_ev)
    this.wildMobs = [];        // [{i,d,lv,x,z,ry,col,row,alive}] dari snap.npcs.wildMobs
    this._mobsAt = 0;          // timestamp snap mob terakhir
    this._lastMsgAt = 0;       // pesan server terakhir — detektor WS beku (staleMs)
    this._wsSendFails = 0;     // hit gagal terkirim beruntun (WS tutup)
  }

  log(...a) { this.emit('log', a.join(' ')); }

  /**
   * Connect ke queue lalu presence. Kalau sudah ada cookie (di-inject dari luar
   * via setCookie/constructor), SKIP login — hemat 2 round-trip + kurangi risiko
   * rate-limit/ban. Login hanya dilakukan kalau belum ada cookie sama sekali.
   */
  async connect() {
    if (!this.cookie) {
      const auth = await login();
      this.cookie = auth.cookie;
      this.player = auth.player;
      this.myId = auth.player?.id;
      this.log('walletAuth ok pid=' + auth.player?.id);
    } else {
      this.log('reuse existing cookie pid=' + (this.myId || '?'));
    }
    await this._resolveWs();
    this.log('ws host=' + this._wsBase + ' origin=' + this._wsOrigin);
    await this._queue();
  }

  /** Inject cookie + player dari luar (KintaraClient) supaya connect() gak login ulang. */
  setCookie(cookie, player) {
    this.cookie = cookie;
    if (player) { this.player = player; this.myId = player.id; }
  }

  _wsOpts() {
    const opts = { headers: { Cookie: this.cookie, Origin: this._wsOrigin || ('https://' + (this._wsBase || HOST)) } };
    const agent = require('./proxyDispatcher').agent(); // http.Agent buat ws (SOCKS/HTTP proxy)
    if (agent) opts.agent = agent;
    return opts;
  }

  /** Resolve host WS per-zone dari /api/servers (infra baru). Fallback env/HOST. */
  async _resolveWs() {
    if (this._wsBase) return this._wsBase;
    let host = this._wsBaseOverride;
    if (!host && this._clientRef) {
      try { const r = await this._clientRef.resolveServer(); if (r && r.wsBaseUrl) host = r.wsBaseUrl; } catch {}
    }
    if (!host) host = process.env.KINTARA_WS_HOST || HOST;
    this._wsBase = String(host).replace(/^wss:\/\//, '').replace(/^https:\/\//, '');
    this._wsOrigin = this._originOverride || ('https://' + this._wsBase);
    return this._wsBase;
  }

  _queue() {
    return new Promise((resolve, reject) => {
      const url = `wss://${this._wsBase}/ws/queue/${this.shard}`;
      this.log('connect queue ' + url);
      const ws = new WebSocket(url, this._wsOpts());
      this.queueWs = ws;
      const to = setTimeout(() => reject(new Error('queue connect timeout')), 20000);
      ws.on('open', () => { clearTimeout(to); this.log('queue open'); this._qping = setInterval(() => { try { ws.send(JSON.stringify({ t: 'q_ping' })); } catch {} }, 5000); ws.send(JSON.stringify({ t: 'q_ping' })); });
      ws.on('message', (buf) => {
        let d; try { d = JSON.parse(buf.toString()); } catch { return; }
        if (d.t === 'queue_pos') this.emit('queue', d);
        else if (d.t === 'queue_ready') { if (d.connectToken) { this._connectToken = d.connectToken; this.log('connectToken captured (' + String(d.connectToken).length + ' ch)'); } this.log('queue_ready -> presence'); clearInterval(this._qping); try { ws.close(); } catch {} this._presence().then(resolve).catch(reject); }
      });
      ws.on('error', (e) => { clearTimeout(to); reject(new Error('queue ws err: ' + e.message)); });
      ws.on('close', () => { clearInterval(this._qping); });
    });
  }

  _presence() {
    return new Promise((resolve, reject) => {
      let url = `wss://${this._wsBase}/ws/presence/${this.shard}`;
      if (this._connectToken) url += '?kt=' + encodeURIComponent(this._connectToken);
      this.log('connect presence' + (this._connectToken ? ' (dgn token)' : ' (TANPA token!)'));
      this.log('connect presence ' + url);
      const ws = new WebSocket(url, this._wsOpts());
      this.presenceWs = ws;
      const to = setTimeout(() => reject(new Error('presence connect timeout')), 20000);
      ws.on('open', () => {
        clearTimeout(to); this.ready = true; this.log('presence open');
        this._sendPos(true);
        this._posTimer = setInterval(() => this._sendPos(false), 3000); // heartbeat posisi
        resolve();
      });
      ws.on('message', (buf) => {
        this._lastMsgAt = Date.now(); // WS beku-detek: pesan server terakhir
        let d; try { d = JSON.parse(buf.toString()); } catch { return; }
        this.emit('msg', d);
        this._trackLifeEpoch(d);
        if (d.t === 'region_ack') { this.region = d.region; this.emit('region_ack', d); }
        else if (d.t === 'snap') { this._onSnap(d); this.emit('snap', d); }
        else if (d.t === 'res_evt') { this._onResEvt(d); this.emit('res_evt', d); }
        else if (d.t === 'res_snap') this.emit('res_snap', d);
        else if (d.t === 'harv_full') this.emit('harv_full', d);
        else if (d.t === 'wild_mb_ack') this._onWildMbAck(d);
        else if (d.t === 'pvit') this._onPvit(d);
        else if (d.t === 'skill_xp' && d.xp) { this.skillXp = d.xp; this.emit('skill_xp', d.xp); }
        else if (d.t === 'wm_ev' && d.a === 'hit' && Number(d.by) === Number(this.myId)) this.emit('wm_kill', d);
        // ===== FISHING (protokol baru v2026: spot dinamis + fish_bite) =====
        else if (d.t === 'fish_spots') { this._onFishSpots(d); this.emit('fish_spots', d); }
        else if (d.t === 'fish_bite') { this._onFishBite(d); this.emit('fish_bite', d); }
        else if (d.t === 'fish_spot_moved') { this._onFishSpots(d); this.emit('fish_spots', d); }
      });
      ws.on('error', (e) => { clearTimeout(to); reject(new Error('presence ws err: ' + e.message)); });
      ws.on('close', () => {
        // close dr koneksi LAMA (sdh di-replace via Object.assign) — JANGAN bunuh heartbeat baru / salah flag
        if (this.presenceWs !== ws) return;
        clearInterval(this._posTimer); this.ready = false; this.emit('close');
      });
    });
  }

  _sendPos(full) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const base = { t: 'pos', region: this.region, x: this.pos.x, y: 0.25, z: this.pos.z, ry: this.pos.ry, mov: false, le: this.lifeEpoch || 0, tut: (this.tut != null ? this.tut : -1) };
    if (full) base.outfit = (this.savedOutfit && typeof this.savedOutfit === 'object' && Object.keys(this.savedOutfit).length) ? this.savedOutfit : { outfitSchema: 15, hat: 0, top: 0, pants: 0, shoe: 0, skinTone: 1 };
    // aksi gather (chop/mine/fish) — server butuh ini utk gate grant-*-xp
    if (this.act) { base.act = this.act; if (this.act === 'fish') { base.fc = this.fishCastCol; base.fr = this.fishCastRow; base.fph = this.fishPhase; } }
    // equipped item (presence visual + server context). wild_sword wajib utk combat.
    if (this.eq) base.eq = this.eq;
    // wild realm: HP + shield + spawn-protect + blocked-tile manifest (hub butuh utk spawn+path mob)
    if (/^wild/.test(this.region)) {
      base.php = Math.max(0, Math.min(100, this.hp | 0));
      base.wsh = Math.max(0, Math.min(5, this.shield | 0));
      base.wsp = 0;
      if (this.pendingWblk) { base.wblk = this.pendingWblk; this.pendingWblk = null; }
    }
    // wild blocked-tile manifest non-wild path (legacy harvest hosting)
    else if (this.pendingWblk) { base.wblk = this.pendingWblk; this.pendingWblk = null; }
    try { this.presenceWs.send(JSON.stringify(base)); } catch {}
  }

  /** Set aksi mancing di pos (act='fish' + cast tile + fase). Tile pond col/row. */
  setFishing(castCol, castRow, phase) { this.act = 'fish'; this.fishCastCol = castCol; this.fishCastRow = castRow; this.fishPhase = phase; this._sendPos(false); }
  setAct(a) { this.act = a || null; this._sendPos(false); }
  /** Kirim manifest blocked-tile wild ke hub (host) -> hub spawn+path mob. tiles=['col,row',...] */
  sendWildManifest(tiles) { this.pendingWblk = tiles && tiles.length ? tiles : null; this._sendPos(false); }

  // ===== FISHING v2026 (spot dinamis + fish_bite) =====
  // fish_spots: {region, n, spots:[{g,c,r}]} — n=size spot (default 2), spots di tile col/row.
  _onFishSpots(d) {
    const spots = [];
    for (const s of (Array.isArray(d.spots) ? d.spots : [])) {
      const c = Number(s && s.c), r = Number(s && s.r);
      if (Number.isFinite(c) && Number.isFinite(r)) spots.push({ g: String(s.g || ''), c: c | 0, r: r | 0 });
    }
    this.fishSpotRegion = String(d.region || '');
    this.fishSpotSize = Number.isFinite(Number(d.n)) && Number(d.n) >= 1 ? Number(d.n) | 0 : 2;
    this.fishSpots = spots;
  }

  // fish_bite: {fc, fr, ms} — gigitan datang dalam ms detik (adopt ke DL timer kita)
  _onFishBite(d) {
    if (this.fishPhase !== 0) return; // cuma relevan saat wait
    const fc = Number(d.fc), fr = Number(d.fr);
    if (Number.isFinite(fc) && Number.isFinite(fr) && (fc !== this.fishCastCol || fr !== this.fishCastRow)) return;
    const ms = Number(d.ms);
    if (!Number.isFinite(ms) || ms < 0 || ms > 120000) return;
    this.fishBiteAt = Date.now() + ms;
  }

  /** Tile aktif dlm spot range (cast tile harus dlm spot utk valid). */
  fishSpotsIn(region) {
    if (this.fishSpotRegion !== region || !Array.isArray(this.fishSpots)) return [];
    return this.fishSpots;
  }
  /** Apakah tile (c,r) ada dlm spot aktif (spot size n, misal 2x2). */
  tileInFishSpot(c, r) {
    const n = this.fishSpotSize || 2;
    for (const s of this.fishSpotsIn(this.region)) {
      if (c >= s.c && c < s.c + n && r >= s.r && r < s.r + n) return true;
    }
    return false;
  }
  /** Spot terdekat dari posisi player pond (col,row) dlm jarak cast (pond=5). */
  nearestFishSpot(col, row, range = 5) {
    let best = null, bd = Infinity;
    const n = this.fishSpotSize || 2;
    for (const s of this.fishSpotsIn(this.region)) {
      // jarak chebyshev dari player ke tepi spot terdekat
      const dc = Math.max(s.c - col, col - (s.c + n - 1), 0);
      const dr = Math.max(s.r - row, row - (s.r + n - 1), 0);
      const dist = Math.max(dc, dr);
      if (dist <= range && dist < bd) { bd = dist; best = s; }
    }
    return best;
  }

  // ===== COMBAT (Wilderness) =====
  // Mob server-authoritative: hub broadcast posisi+HP di snap.npcs.wildMobs.
  // Coord wild: world x=col-24.5, z=row-24.5 (WILD 50x50, off=-24.5).
  static WILD_OFF = -24.5;

  /** Track life-epoch dari pesan server (snap/ack bawa le). Echo balik di pos+wm_ev. */
  _trackLifeEpoch(d) {
    const le = d && d.le != null && Number.isFinite(Number(d.le)) ? Number(d.le) | 0 : null;
    if (le != null && le > (this.lifeEpoch | 0)) this.lifeEpoch = le;
  }

  /** Parse snap: extract wildMobs (nested di npcs) + self HP + RESOURCE (res) + wear. */
  _onSnap(d) {
    // self HP dari players[] self-entry kalau ada (php)
    if (Array.isArray(d.players) && this.myId != null) {
      const self = d.players.find((p) => Number(p.id) === Number(this.myId));
      if (self && self.php != null && Number.isFinite(Number(self.php))) this.hp = Number(self.php) | 0;
    }
    // wildMobs nested di npcs (INI yg dulu kelewat — recon lama cek top-level)
    const npcs = d.npcs && typeof d.npcs === 'object' ? d.npcs : null;
    const arr = npcs && Array.isArray(npcs.wildMobs) ? npcs.wildMobs : null;
    // ambientChickens (eldergrove): [{x,z,ry,lv,mx,hp}] per idx — posisi+HP chicken dari server
    const chick = npcs && Array.isArray(npcs.ambientChickens) ? npcs.ambientChickens : (Array.isArray(d.ambientChickens) ? d.ambientChickens : null);
    if (chick && this.region === 'eldergrove') {
      this.chickens = chick.map((c, i) => {
        const x = Number(c.x), z = Number(c.z);
        const hp = Number(c.hp);
        return { i, x: Number.isFinite(x) ? x : null, z: Number.isFinite(z) ? z : null, lv: Number(c.lv) | 0, hp: Number.isFinite(hp) ? hp | 0 : null, alive: Number.isFinite(hp) ? hp > 0 : true };
      });
    }
    if (arr && /^wild/.test(this.region)) {
      const OFF = Presence.WILD_OFF;
      this.wildMobs = arr.map((m, i) => {
        const lv = Number(m.lv) | 0;
        const x = Number(m.x), z = Number(m.z);
        return {
          i, d: Number(m.d) === 1 ? 1 : 0, lv, alive: lv > 0,
          x: Number.isFinite(x) ? x : null, z: Number.isFinite(z) ? z : null,
          col: Number.isFinite(x) ? Math.round(x - OFF) : null,
          row: Number.isFinite(z) ? Math.round(z - OFF) : null,
          st: Number(m.st) || 0,
        };
      });
      this._mobsAt = Date.now();
      this.emit('mobs', this.wildMobs);
    }
    // === RESOURCE SNAP (dari game client: applyResourceSnap(f.res, f.region)) ===
    // f.res = [{kind:'rock'|'tree', keys:['c,r',...], hasCoal, hasMetal}] utk region snap ini.
    // Ini sumber utama lokasi node (broadcast res_evt cuma update wear) — dulu KELEWAT!
    if (Array.isArray(d.res) && d.res.length) {
      if (!this.nodes) this.nodes = new Map();
      const snapRegion = String(d.region || this.region || '');
      this._nodesRegion = snapRegion;
      const seen = new Set();
      for (const r of d.res) {
        const kind = r.kind === 'rock' ? 'rock' : r.kind === 'tree' ? 'tree' : null;
        if (!kind) continue;
        const keys = (r.keys || []).map(String).filter((k) => /^\d+,\d+$/.test(k));
        if (!keys.length) continue;
        const until = Number(r.until) | 0;
        // SITE EXPIRED (until < now): node udah despawn — hapus, JANGAN pilih (sumber fails!)
        if (until > 0 && until < Date.now() - 2000) {
          for (const k of keys) this.nodes.delete(k);
          continue;
        }
        for (const k of keys) {
          seen.add(k);
          const cur = this.nodes.get(k) || {};
          // wear snapshot utk node ini (kalau ada)
          const w = Array.isArray(d.wear) ? d.wear.find((x) => (x.keys || []).map(String).includes(k)) : null;
          const h = w ? Math.max(0, Number(w.h) | 0) : (cur.h || 0);
          const hm = w ? Math.max(1, Number(w.hm) | 0) : (cur.hm || 0);
          this.nodes.set(k, {
            kind, hasCoal: kind === 'rock' ? !!r.hasCoal : false,
            hasMetal: kind === 'rock' ? !!r.hasMetal : false,
            lastProof: cur.lastProof, seen: Date.now(), h, hm,
            until: until || cur.until || 0,
            _fromSnap: true,
          });
        }
      }
      // node gak di snap TERAKHIR: jangan langsung hapus — snap periodik cuma viewport sekitar
      // player (bukan full region; full cuma snap awal connect). Hapus = bot kehilangan node sehat
      // yang jauh. Biarkan until/stale yang buang.
      for (const [k, v] of [...this.nodes.entries()]) {
        if (v.seen < Date.now() - 180000) this.nodes.delete(k); // basi >3 mnt gak keliatan lagi
      }
      this._resSnapAt = Date.now();
      this.emit('res_snap', { count: seen.size, region: snapRegion });
    }
  }

  /** wild_mb_ack: hub balas HP/shield setelah kita lapor kontak (wmb). Kita gak kirim wmb,
   *  tapi tetap update HP kalau server push (defense-in-depth). */
  _onWildMbAck(d) {
    if (d.php != null && Number.isFinite(Number(d.php))) { this.hp = Number(d.php) | 0; this.emit('hp', this.hp); }
    if (d.wsh != null && Number.isFinite(Number(d.wsh))) this.shield = Number(d.wsh) | 0;
    if (this.hp <= 0) this.emit('died', d);
  }

  /** pvit broadcast — biasanya remote, tapi kalau pid==kita ambil HP. */
  _onPvit(d) {
    if (Number(d.pid) === Number(this.myId)) {
      if (d.php != null && Number.isFinite(Number(d.php))) { this.hp = Number(d.php) | 0; this.emit('hp', this.hp); }
      if (d.wsh != null && Number.isFinite(Number(d.wsh))) this.shield = Number(d.wsh) | 0;
      if (this.hp <= 0) this.emit('died', d);
    }
  }

  /** Equip senjata (broadcast eq di pos). 'wild_sword' wajib utk wm_ev. */
  equip(itemType) { this.eq = itemType || null; this._sendPos(false); }

  /** Tile wild col/row dari posisi sekarang. */
  wildTile() { return { col: Math.round(this.pos.x - Presence.WILD_OFF), row: Math.round(this.pos.z - Presence.WILD_OFF) }; }

  /** Mob hidup terdekat dari posisi sekarang (cheb tile). null kalau gak ada. */
  nearestMob() {
    const me = this.wildTile();
    let best = null, bestD = Infinity;
    for (const m of this.wildMobs) {
      if (!m.alive || m.col == null) continue;
      const dd = Math.max(Math.abs(m.col - me.col), Math.abs(m.row - me.row));
      if (dd < bestD) { bestD = dd; best = m; }
    }
    return best ? { ...best, cheb: bestD } : null;
  }

  /** Kirim hit ke mob index i. n=hitMult (1 base, 2 L2, +1 strength). Hormati cooldown di caller. */
  sendWildMobHit(i, n = 1) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) { this._wsSendFails++; return false; }
    if (!/^wild/.test(this.region)) return false;
    const msg = { t: 'wm_ev', region: this.region, a: 'hit', i: i | 0, le: this.lifeEpoch | 0, px: this.pos.x, pz: this.pos.z };
    if (n > 1) msg.n = n | 0;
    try { this.presenceWs.send(JSON.stringify(msg)); this._wsSendFails = 0; return true; } catch { this._wsSendFails++; return false; }
  }

  /** Umur pesan server terakhir (ms). Half-open TCP: readyState masih OPEN tapi data BEKU —
   *  hp/wildMobs basi = mukul mob hantu. Caller WAJIB cek ini saat aksi aktif (combat). */
  staleMs() { return this._lastMsgAt ? Date.now() - this._lastMsgAt : 0; }
  sendFailCount() { return this._wsSendFails | 0; }


  // ===== GATHER (harvest) =====
  // Belajar lokasi node dari res_evt broadcast (key tile + kind + actionProof).
  _onResEvt(d) {
    if (!this.nodes) this.nodes = new Map();
    for (const k of (d.keys || [])) {
      const cur = this.nodes.get(k) || {};
      // node felled (oleh siapa pun, h>=hm) -> MATI: hapus dari peta, jangan kepilih lagi
      const h = Number(d.h) | 0, hm = Number(d.hm) | 0;
      if ((hm > 0 && h >= hm) || d.clear === true) { this.nodes.delete(k); continue; }
      this.nodes.set(k, { kind: d.kind, hasCoal: !!d.hasCoal, hasMetal: !!d.hasMetal, lastProof: d.actionProof || cur.lastProof, seen: Date.now() });
    }
    // proof utk node yg KITA panen
    if (this.myId && d.by === this.myId && d.actionProof) { this._lastMyProof = { keys: d.keys, proof: d.actionProof }; }
    // v2026: server kirim jumlah loot per node (amt) di event felled — client resmi pakai ini.
    if (d.amt != null) {
      const amt = Math.max(0, Number(d.amt) | 0);
      if (this._pendingHarvest && (d.keys || []).some((k) => this._pendingHarvest.keys.includes(k))) {
        this._pendingHarvest.yield = amt;
      }
    }
  }
  /** daftar node terkini by kind (dari res_evt). */
  knownNodes(kind) { return [...(this.nodes || new Map()).entries()].filter(([, v]) => v.kind === kind).map(([k, v]) => ({ key: k, ...v })); }

  /** Mulai harvest node (server balas actionProof utk node ini). keys=['col,row']. */
  sendHarv(kind, keys, hasCoal = false) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    try { this.presenceWs.send(JSON.stringify({ t: 'harv', region: this.region, k: kind, keys: uniq, hasCoal })); } catch {}
  }
  /** Harvest 1 node penuh (event-driven): harv -> tiap res_evt refresh proof+h -> harv_hit s/d felled. */
  async harvestNode(kind, key, hasCoal = false, hasMetal = false, { maxHits = 10, hitGap = 1700 } = {}) {
    this.setAct(kind === 'tree' ? 'chop' : 'mine');
    let h = 0, hm = 99, lastProof = '', loot = null, hits = 0;
    const onEvt = (d) => { if (d.by === this.myId && (d.keys || []).includes(key)) { h = d.h; hm = d.hm; if (d.actionProof) lastProof = d.actionProof; loot = d.loot; } };
    this.on('res_evt', onEvt);
    this.sendHarv(kind, [key], hasCoal);
    for (let i = 0; i < maxHits; i++) {
      await new Promise((r) => setTimeout(r, hitGap));
      if (hm < 99 && h >= hm) break; // felled
      this.sendHarvHit(kind, [key], hasCoal, hasMetal, lastProof); hits++;
    }
    await new Promise((r) => setTimeout(r, 800));
    this.removeListener('res_evt', onEvt); this.clearAct();
    return { felled: hm < 99 && h >= hm, h, hm, hits, loot };
  }

  /** Harvest 1 node penuh — PROTOCOL BARU (tes v28 BERHASIL):
   *  1) berdiri 1 tile dari node: x=C+(-30.5), z=(R+1)+(-30.5)
   *  2) kirim pos tiap 100ms: act=mine/chop + eq=tool + mc/mr=node + mp=t/2.8 (naik smooth)
   *  3) harv_hit tiap 0.52s; echo actionProof dari res_evt by=pid kita (hit pertama tanpa proof)
   *  Server ACK: res_evt {by:kita, h, hm, loot}. hm tercapai = node hancur. */
  async harvestNodeV2(kind, key, hasCoal = false, hasMetal = false, { maxSec = 20 } = {}) {
    const [C, R] = key.split(',').map(Number);
    const act = kind === 'tree' ? 'chop' : 'mine';
    const eq = kind === 'tree' ? 'tool_axe' : 'tool_pickaxe';
    // offset tile per-region: world -30.5 | pond/desert_south -19.5 | wild* -24.5
    const OFF = /pond|desert/.test(this.region) ? -19.5 : /^wild/.test(this.region) ? Presence.WILD_OFF : Presence.WORLD_OFF;
    // berdiri 1 tile di selatan node
    this.pos.x = C + OFF;
    this.pos.z = (R + 1) + OFF;
    if (this._posTimer) { clearInterval(this._posTimer); this._posTimer = null; }
    let h = 0, hm = 99, proof = '', loot = null, hits = 0, done = false, lastH = -1, stall = 0, yieldAmt = null;
    this._pendingHarvest = { keys: [key], yield: undefined };
    const onEvt = (d) => {
      if (d.by === this.myId && (d.keys || []).includes(key)) {
        h = d.h | 0; hm = d.hm | 0; if (d.actionProof) proof = d.actionProof;
        if (d.loot) loot = d.loot;
        if (d.amt != null) yieldAmt = Math.max(0, Number(d.amt) | 0); // v2026: jumlah loot dari server
        if (hm > 0 && hm < 99 && h >= hm) done = true;
      }
      if (d.t === 'action_proof' && (d.keys || []).includes(key)) proof = d.proof || proof;
    };
    this.on('res_evt', onEvt);
    this.on('msg', onEvt); // utk action_proof push
    const DUR = 2.8, SWING = 520;
    const t0 = Date.now();
    let nextHitAt = SWING;
    while (Date.now() - t0 < maxSec * 1000 && !done) {
      const t = Date.now() - t0;
      // DEAD-NODE ABORT: node hidup ACK hit pertama <2 dtk (h naik). 2.5 dtk h masih 0 & gak ada proof = depleted → jangan bakar waktu.
      if (t > 2500 && h === 0 && !proof) break;
      const mp = Math.min(1, t / (DUR * 1000));
      const b = { t: 'pos', region: this.region, x: this.pos.x, y: 0.256, z: this.pos.z, ry: this.pos.ry || 0, mov: false,
        outfit: (this.savedOutfit && typeof this.savedOutfit === 'object' && Object.keys(this.savedOutfit).length) ? this.savedOutfit : { outfitSchema: 15, hat: 0, top: 0, pants: 0, shoe: 0, skinTone: 1 },
        le: this.lifeEpoch || 3, tut: (this.tut != null ? this.tut : -1), act, eq, mc: C, mr: R, mp };
      try { this.presenceWs.send(JSON.stringify(b)); } catch {}
      if (t >= nextHitAt) {
        // ADAPTIVE: kirim hit hanya kalau progress terakhir SUDAH ter-ACK (atau hit pertama).
        // Hit saat h belum naik = server tolak (waste 2.8 dtk) — sumber 14-hit-untuk-6-progress.
        if (lastH < 0 || h > lastH || proof) {
          hits++;
          this.sendHarvHit(kind, [key], hasCoal, hasMetal, proof || undefined);
          lastH = h; stall = 0;
        } else if (++stall > 3) { lastH = -1; stall = 0; } // macet 3 swing — kirim polos reset
        nextHitAt += SWING;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 600));
    this.removeListener('res_evt', onEvt);
    this.removeListener('msg', onEvt);
    // pulihkan heartbeat pos
    this._posTimer = setInterval(() => this._sendPos(false), 3000);
    this.clearAct();
    const yld = yieldAmt != null ? yieldAmt : 6; // fallback 6 kalau server gak kirim amt
    this._pendingHarvest = null;
    return { felled: done, h, hm, hits, loot, yield: yld };
  }

  /** Hit harvest (echo actionProof yg didapat dari snap/res_evt utk node ini). */
  sendHarvHit(kind, keys, hasCoal, hasMetal, actionProof, eqi) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    const payload = { t: 'harv_hit', region: this.region, k: kind, keys: uniq, hasCoal: !!hasCoal, hasMetal: !!hasMetal };
    if (actionProof) payload.actionProof = actionProof;
    if (eqi) payload.eqi = eqi;
    try { this.presenceWs.send(JSON.stringify(payload)); } catch {}
  }
  clearAct() { this.act = null; this._sendPos(false); }
  /** Konversi world x/z -> tile col/row utk realm aktif. world 62x62 off=-30.5; pond/desert_south off=-19.5. */
  pondTile() { return { col: Math.round(this.pos.x + 19.5), row: Math.round(this.pos.z + 19.5) }; }
  worldTile() { return { col: Math.round(this.pos.x + 30.5), row: Math.round(this.pos.z + 30.5) }; }
  static WORLD_OFF = -30.5;

  /** Pindah realm + posisi. Server akan bales region_ack. */
  setRegion(region, x, z) { this.region = region; if (x != null) this.pos.x = x; if (z != null) this.pos.z = z; this._sendPos(true); }
  moveTo(x, z) { this.pos.x = x; this.pos.z = z; this._sendPos(false); }

  _sendPosMoving() {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const m = { t: 'pos', region: this.region, x: this.pos.x, y: 0.25, z: this.pos.z, ry: this.pos.ry, mov: true, le: this.lifeEpoch || 0, tut: (this.tut != null ? this.tut : -1) };
    if (this.eq) m.eq = this.eq;
    if (/^wild/.test(this.region)) {
      m.php = Math.max(0, Math.min(100, this.hp | 0));
      m.wsh = Math.max(0, Math.min(5, this.shield | 0));
      m.wsp = 0;
      if (this.pendingWblk) { m.wblk = this.pendingWblk; this.pendingWblk = null; }
    }
    try { this.presenceWs.send(JSON.stringify(m)); } catch {}
  }

  /** Jalan realistis ke (tx,tz) di world coord, kirim pos @MOVE_SPEED. Berhenti kalau until()=true. */
  async walkTo(tx, tz, { speed = 3.5, dt = 0.15, until = null, maxSec = 30 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const dx = tx - this.pos.x, dz = tz - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.4) break;
      if (until && until()) return 'until';
      if ((Date.now() - t0) / 1000 > maxSec) return 'timeout';
      const move = Math.min(dist, speed * dt);
      this.pos.x += (dx / dist) * move;
      this.pos.z += (dz / dist) * move;
      this.pos.ry = Math.atan2(dx, dz);
      this._sendPosMoving();
      await new Promise((r) => setTimeout(r, dt * 1000));
    }
    this.pos.x = tx; this.pos.z = tz; this._sendPos(false);
    return 'arrived';
  }
  close() { try { this.presenceWs?.close(); } catch {} try { this.queueWs?.close(); } catch {} clearInterval(this._qping); clearInterval(this._posTimer); }
}

module.exports = { Presence };

// ---- CLI smoke test: connect, masuk, tunggu region_ack + sampel snap ----
if (require.main === module) {
  const p = new Presence(process.argv[2] || config.shard || 's4');
  p.on('log', (m) => console.log('[ws]', m));
  p.on('queue', (d) => process.stdout.write(`queue ahead=${d.ahead}  \r`));
  p.on('region_ack', (d) => console.log('\n✅ region_ack:', d.region));
  let snaps = 0; p.on('snap', (d) => { if (snaps++ === 0) console.log('snap: region=' + d.region + ' online=' + d.onlineTotal + ' players=' + (d.players?.length)); });
  p.connect()
    .then(() => { console.log('✅ PRESENCE LIVE region=' + p.region + ' pos=', p.pos); setTimeout(() => { console.log('done sample'); p.close(); process.exit(0); }, 12000); })
    .catch((e) => { console.error('🛑', e.message); process.exit(1); });
}
