// The BYOK page's fetch context — the browser twin of mcp-server.js's `ctx`.
//
// The app packs (apps/trip.js, apps/movies.js) are byte-shared with the server
// demo: their `live(args, ctx)` handlers take every environment-specific thing
// through this object. So ALL browser adaptation lives here, and nothing in
// apps/ forks for the browser. If a pack ever seems to need a BYOK-only edit,
// that is a design smell — extend this ctx instead.
//
// Two adaptations the server ctx does not need, both measured (see the recon):
//   1. `user-agent` is a FORBIDDEN header name in browser fetch — setting it
//      makes the request fail outright. Wikipedia's anonymous-CORS path does not
//      want one anyway, so we strip it.
//   2. MediaWiki's action API (/w/api.php) refuses anonymous cross-origin reads
//      unless `origin=*` is on the query string (its documented switch). Without
//      it the movie desk's plot/reception fetches are CORS-blocked. The REST
//      endpoint (/api/rest_v1/...) needs nothing.
// There is no GALLERY_FORCE_FALLBACK here — a tab has no env. A dead network
// still degrades into a labeled fallback sentence through the packs' own
// try/catch plus lib/mcp.js's decorator.
const FETCH_TIMEOUT_MS = 4000;

/** Append MediaWiki's anonymous-CORS switch, without re-serializing the query. */
function forBrowser(url) {
  try {
    const u = new URL(url);
    const isWiki = u.hostname === 'wikipedia.org' || u.hostname.endsWith('.wikipedia.org');
    if (isWiki && u.pathname === '/w/api.php' && !/[?&]origin=/.test(u.search)) {
      return `${url}${u.search ? '&' : '?'}origin=*`;
    }
    return url;
  } catch {
    return url;
  }
}

/** Drop header names a browser refuses to let script set. */
function browserHeaders(headers = {}) {
  const out = { accept: 'application/json' };
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'user-agent') continue;
    out[k] = v;
  }
  return out;
}

function clip(str, n) { const s = String(str); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function reasonOf(err) {
  const m = String((err && err.message) || err || 'fetch failed');
  return m.length > 64 ? `${m.slice(0, 61)}…` : m;
}

function fmtUSD(n) {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString('en-US')}`;
}

/**
 * @param onFetch optional observer — called with the host of every tool fetch,
 *   so the page can show that tool traffic is keyless and goes nowhere near us.
 */
export function makeBrowserCtx({ onFetch = null } = {}) {
  async function safeFetch(url, opts = {}) {
    const target = forBrowser(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      if (onFetch) { try { onFetch(new URL(target).host); } catch { /* not a URL — skip */ } }
      const r = await fetch(target, {
        ...opts,
        signal: ctrl.signal,
        headers: browserHeaders(opts.headers),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } finally { clearTimeout(timer); }
  }

  return {
    safeFetch,
    clip,
    reasonOf,
    fmtUSD,
    // Kept for parity with the server ctx. Browsers set their own User-Agent and
    // refuse a scripted one, so nothing on this page can use it.
    BROWSER_UA: null,
    labelLive: (src) => ` [source: live — ${src}]`,
    labelFallback: (reason) => ` [source: synthetic fallback — ${reason}]`,
  };
}

export const __testables = { forBrowser, browserHeaders };
