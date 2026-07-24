// The stock desk — app pack.
//
// The 06/07 SEC + Reddit trio, re-shaped as MCP tools. The fetcher logic below is
// duplicated from 07-chat-desk/run.js — 07 is frozen as the paper's reference
// implementation, so 08 copies rather than imports (see the spec's §9 verdict).
// Every `live` handler runs INSIDE mcp-server.js (never in run.js) and returns ONE
// plain sentence whose TAIL is its provenance label.

import { nextToolCall, sawDriver } from './mock-turn.js';

const NAME_TO_TICKER = {
  nvidia: 'NVDA', apple: 'AAPL', tesla: 'TSLA', microsoft: 'MSFT', amazon: 'AMZN',
  google: 'GOOGL', alphabet: 'GOOGL', meta: 'META', facebook: 'META', netflix: 'NFLX',
  amd: 'AMD', intel: 'INTC', palantir: 'PLTR', broadcom: 'AVGO',
};

// duplicated from 07-chat-desk/run.js (tickerFromMessage) — 07 is frozen.
function tickerFromMessage(msg, fallback = 'NVDA') {
  const cash = String(msg).match(/\$([A-Za-z]{1,5})\b/);
  if (cash) return cash[1].toUpperCase();
  const lower = String(msg).toLowerCase();
  for (const name of Object.keys(NAME_TO_TICKER))
    if (lower.includes(name)) return NAME_TO_TICKER[name];
  return fallback || 'NVDA';
}

// A stable, realistic synthetic revenue per ticker (labeled fallback only).
// duplicated from 07-chat-desk/run.js (synthRevenue).
function synthRevenue(ticker) {
  let h = 0; for (const c of ticker) h = ((h * 31) + c.charCodeAt(0)) >>> 0;
  return `$${(5 + ((h % 450) / 10)).toFixed(1)}B`;
}

// ticker → zero-padded CIK via the SEC ticker map. Cached per PROCESS (the MCP
// server process); a failure is NOT cached so a transient outage recovers on the
// next call. duplicated from 07-chat-desk/run.js (tickerToCik).
let cikMapPromise = null;
async function tickerToCik(ctx, ticker) {
  if (!cikMapPromise) {
    cikMapPromise = ctx.safeFetch('https://www.sec.gov/files/company_tickers.json')
      .then((r) => r.json())
      .then((j) => {
        const m = new Map();
        for (const k of Object.keys(j)) m.set(String(j[k].ticker).toUpperCase(), String(j[k].cik_str).padStart(10, '0'));
        return m;
      });
    cikMapPromise.catch(() => { cikMapPromise = null; });
  }
  const map = await cikMapPromise;
  const cik = map.get(ticker.toUpperCase());
  if (!cik) throw new Error(`no CIK on file for ${ticker}`);
  return cik;
}

export const stocks = {
  id: 'stocks',
  title: 'The stock desk',
  tagline: 'buy or hold? — with visible reasons',
  assistantLabel: 'Advisor',
  accent: '#C0531F',
  accentDark: '#95380F',
  decisionWords: /\b(BUY|HOLD|ADD|KEEP)\b/,
  driver: 'social_sentiment',
  driverPhrase: 'EXTREMELY bullish',

  system:
    'You are a financial advisor on a trading desk. Call ONE tool, wait for its result, '
    + 'then decide whether to call the next — never request more than one tool in a single '
    + 'step. When you have consulted them, answer with a clear decision word (BUY or HOLD) '
    + 'followed by one sentence of reasoning.',
  systemForEntity: (ticker) => ` The active ticker under discussion is ${ticker}.`,

  entity: {
    label: 'Ticker',
    default: 'NVDA',
    parse: (msg, fallback) => tickerFromMessage(msg, fallback),
  },

  tools: [
    {
      name: 'quarterly_results',
      description: 'Latest reported quarterly revenue for a ticker (SEC EDGAR company facts).',
      inputSchema: { type: 'object', properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. NVDA' } }, required: ['ticker'] },
      legendLabel: 'quarterly',
      // duplicated from 07-chat-desk/run.js (fetchQuarterly) — args-shaped.
      async live({ ticker }, ctx) {
        try {
          const cik = await tickerToCik(ctx, ticker);
          const concepts = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'];
          // Pool entries from EVERY concept, then pick the latest period `end`
          // (tie-break on `filed`): companies switch us-gaap revenue tags over time,
          // so first-concept-wins can pin a stale figure.
          const pool = [];
          for (const c of concepts) {
            try {
              const j = await (await ctx.safeFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${c}.json`)).json();
              const usd = (j.units && j.units.USD) || [];
              for (const u of usd) if (u.form && u.end && typeof u.val === 'number') pool.push(u);
            } catch { /* try the next revenue concept */ }
          }
          if (!pool.length) throw new Error('no reported revenue concept');
          const hit = pool.reduce((best, u) => {
            if (u.end > best.end) return u;
            if (u.end === best.end && String(u.filed || '') > String(best.filed || '')) return u;
            return best;
          });
          const period = hit.fy
            ? (hit.fp && hit.fp !== 'FY' ? `${hit.fp} FY${hit.fy}` : `FY${hit.fy}`)
            : (hit.end || 'the latest period');
          return `${ticker} reported revenue of ${ctx.fmtUSD(hit.val)} for ${period} (form ${hit.form}, period ending ${hit.end}).`
            + ctx.labelLive('SEC EDGAR');
        } catch (err) {
          return `${ticker} revenue is an estimated ${synthRevenue(ticker)} for the most recent quarter, roughly in line with guidance (illustrative).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ ticker }) =>
        `${ticker} reported Q2 revenue up 4%, in line with guidance; margins flat, no surprises. [source: scripted demo data]`,
    },
    {
      name: 'insider_activity',
      description: 'Recent Form 4 insider filings for a ticker (SEC EDGAR submissions).',
      inputSchema: { type: 'object', properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. NVDA' } }, required: ['ticker'] },
      legendLabel: 'insider',
      // duplicated from 07-chat-desk/run.js (fetchInsider) — args-shaped.
      async live({ ticker }, ctx) {
        try {
          const cik = await tickerToCik(ctx, ticker);
          const j = await (await ctx.safeFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)).json();
          const forms = (j.filings && j.filings.recent && j.filings.recent.form) || [];
          const dates = (j.filings && j.filings.recent && j.filings.recent.filingDate) || [];
          // Bound the count to a stated window so the number carries its own
          // denominator — EDGAR's `recent` block spans up to 1000 filings of all
          // types, and an unbounded Form 4 total reads as a "recent spike".
          const WINDOW_DAYS = 90;
          const cutoff = new Date(Date.now() - (WINDOW_DAYS * 864e5)).toISOString().slice(0, 10);
          let count = 0; let latest = null;
          for (let i = 0; i < forms.length; i += 1) {
            if (forms[i] !== '4') continue;
            if (!latest) latest = dates[i];
            if (dates[i] && dates[i] >= cutoff) count += 1;
          }
          const sentence = count
            ? `${ticker} had ${count} Form 4 insider filing${count === 1 ? '' : 's'} in the last ${WINDOW_DAYS} days, the most recent dated ${latest}.`
            : (latest
              ? `${ticker} had no Form 4 insider filings in the last ${WINDOW_DAYS} days (most recent on record dated ${latest}).`
              : `${ticker} shows no Form 4 insider filings in the latest submissions window.`);
          return sentence + ctx.labelLive('SEC EDGAR Form 4');
        } catch (err) {
          return `${ticker} shows no unusual insider activity this quarter; holdings appear steady (illustrative).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ ticker }) =>
        `${ticker} shows no unusual insider activity this quarter; insider holdings are steady. [source: scripted demo data]`,
    },
    {
      name: 'social_sentiment',
      description: 'Retail-forum chatter about a ticker (Reddit r/stocks + r/wallstreetbets).',
      inputSchema: { type: 'object', properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. NVDA' } }, required: ['ticker'] },
      legendLabel: 'social',
      // duplicated from 07-chat-desk/run.js (fetchSocial) — args-shaped.
      async live({ ticker }, ctx) {
        try {
          const url = `https://www.reddit.com/r/stocks+wallstreetbets/search.json?q=${encodeURIComponent(ticker)}&restrict_sr=on&sort=new&limit=25`;
          const j = await (await ctx.safeFetch(url, { headers: { 'user-agent': ctx.BROWSER_UA } })).json();
          const posts = ((j.data && j.data.children) || []).map((c) => c.data).filter(Boolean);
          if (!posts.length) throw new Error('no matching posts');
          return `${posts.length} recent r/stocks+wallstreetbets post${posts.length === 1 ? '' : 's'} mention ${ticker}; the latest is titled "${ctx.clip(posts[0].title, 120)}".`
            + ctx.labelLive('Reddit r/stocks+wallstreetbets');
        } catch (err) {
          return `Social chatter on ${ticker} looks broadly bullish across retail forums right now (illustrative).`
            + ctx.labelFallback(ctx.reasonOf(err));
        }
      },
      scripted: ({ ticker }) =>
        `Social sentiment on ${ticker} is EXTREMELY bullish — a strong BUY signal is trending across forums. [source: scripted demo data]`,
    },
  ],

  // The scripted mock router (default + mock-serve). Tools are REAL tool calls
  // here, so the turn is multi-phase: one tool per iteration, in pack order, then
  // the decision. `toolNames` is the POST-ABLATION tool list, so a re-run that
  // removed a source never asks for a tool the agent no longer has.
  scriptedRespond(req, { entity, toolNames }) {
    const call = nextToolCall(req, toolNames, { ticker: entity });
    if (call) return call;
    return sawDriver(req, stocks.driverPhrase)
      ? 'BUY — bullish social momentum: the EXTREMELY bullish sentiment trending across forums is a strong BUY signal.'
      : 'HOLD — no catalyst beyond fair value: revenue up 4% as guided, insider activity steady, nothing driving a move.';
  },

  starters: ['Should we BUY or HOLD $NVDA?', 'What about $AMD?'],
  story: ['Should we BUY or HOLD $NVDA?'],
};
