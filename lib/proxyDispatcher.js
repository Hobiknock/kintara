// Proxy dispatcher opsional untuk fetch (undici) & ws — aktif via env KINTARA_PROXY.
// Contoh: KINTARA_PROXY=socks5://127.0.0.1:40000  (Cloudflare WARP mode proxy)
// Kalau env gak diset → return null → semua koneksi direct (perilaku lama).
const PROTO_RE = /^([a-z0-9]+):\/\/(.+)$/;

let cached = undefined; // undefined = belum dicek, null = nonaktif, object = aktif

function getProxyAgent() {
  if (cached !== undefined) return cached;
  const url = process.env.KINTARA_PROXY;
  if (!url) { cached = null; return cached; }
  const m = String(url).match(PROTO_RE);
  if (!m) {
    console.error('[proxy] KINTARA_PROXY format salah (harus proto://host:port) — proxy DIABAIKAN');
    cached = null; return cached;
  }
  const proto = m[1].toLowerCase();
  try {
    if (proto === 'socks5' || proto === 'socks5h' || proto === 'socks4' || proto === 'socks') {
      // undici ProxyAgent gak support SOCKS — pakai socks-proxy-agent
      let SocksAgent;
      try { ({ SocksProxyAgent: SocksAgent } = require('socks-proxy-agent')); }
      catch { SocksAgent = globalThis.__hermesSocksAgent; } // fallback injeksi eksternal
      if (SocksAgent) { cached = new SocksAgent(url); return cached; }
      console.error('[proxy] socks-proxy-agent gak terinstall — proxy DIABAIKAN (npm i socks-proxy-agent)');
      cached = null; return cached;
    }
    // http(s):// proxy → undici ProxyAgent (build dispatcher buat fetch/undici)
    const { ProxyAgent } = require('undici');
    cached = new ProxyAgent(url);
    return cached;
  } catch (e) {
    console.error('[proxy] gagal init:', e.message, '— proxy DIABAIKAN');
    cached = null; return cached;
  }
}

module.exports = function proxyDispatcher() { return getProxyAgent(); };
module.exports.agent = () => getProxyAgent(); // versi buat `ws` (http.Agent)
