// Example 7 — THE CHAT DESK (transparency inside the conversation; HCII 2026).
//
// A REAL multi-turn financial-advisor chatbot where the "why" lives in the chat.
// Under every advisor reply sits a "visible reason" button. Tap it and the right
// panel shows THAT reply's influence map (real localizeContextBug on that turn's
// recording). Flip a source to ignore and Re-run: the desk re-runs THAT TURN for
// real — the same recorded conversation up to that point, minus the source — and
// the counterfactual appears as a clearly-labeled what-if bubble beside the
// original ("without <source>, I would have said: HOLD…") with the causal verdict.
// "Continue from this version" forks the conversation forward from the what-if as
// a NEW recorded session; the original transcript stays whole. BRANCH, NEVER
// REWRITE.
//
// Everything is a REAL agentfootprint run. The mock is scripted (af example 18's
// pattern) so a source's PRESENCE and ABSENCE yield different decisions — the flip
// is produced by the actual re-run, never hand-authored. One turn factory drives
// live turns, rerun probes, and fork turns alike (a single source of truth).
//
//   node 07-chat-desk/run.js               → DEFAULT MODE: scripted 3-turn run + stable SUMMARY
//   node 07-chat-desk/run.js --serve       → generate out/chat.html + serve on :4174
//   node --env-file=.env 07-chat-desk/run.js --serve --live   → the real Anthropic API (haiku)

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'agentfootprint';
import { mock, anthropic } from 'agentfootprint/llm-providers';
import { defineFact } from 'agentfootprint/injection-engine';
import { mockEmbedder } from 'agentfootprint/memory';
import {
  applyAblations, embeddingCache, listInfluenceStrategies, llmCallIdsFromEvents,
  recordedChat, removableSources, semanticAlignmentStrategy,
} from 'agentfootprint/debug';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const MODEL = 'claude-haiku-4-5-20251001';

// ═══ The scenario (the 06 stock trio, verbatim; multi-turn) ══════════════════
const SYSTEM =
  'You are a financial advisor on a trading desk. Weigh the provided context. '
  + 'Answer with a clear decision word (BUY/HOLD for trade questions, ADD/KEEP for '
  + 'allocation questions) followed by one sentence of reasoning.';

const FACTS = [
  defineFact({
    id: 'quarterly-results',
    description: 'Latest quarterly results',
    data: 'Q2 revenue up 4%, in line with guidance; margins flat, no surprises.',
  }),
  defineFact({
    id: 'insider-activity',
    description: 'Insider trading activity',
    data: 'No unusual insider activity this quarter; holdings steady.',
  }),
  defineFact({
    id: 'social-sentiment',
    description: 'Social media sentiment signal',
    data: 'Social sentiment is EXTREMELY bullish — a strong BUY signal is trending across forums.',
  }),
];

// The scripted mock: route on the LAST `User:` line of the last message (the
// preamble carries earlier questions, so route on the last line), and on whether
// the driver fact ('EXTREMELY bullish') reached the system prompt. Turn 3 reads
// the RECORDED transcript to decide — so a fork changes what turn 3 sees.
function lastUserLine(req) {
  const text = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const lines = String(text).split('\n').filter((l) => l.startsWith('User: '));
  return lines[lines.length - 1] ?? '';
}
function scriptedRespond(req) {
  const ask = lastUserLine(req);
  const social = (req.systemPrompt ?? '').includes('EXTREMELY bullish');
  if (ask.includes('allocate')) // turn 3 — depends on the RECORDED transcript
    return String(req.messages.at(-1)?.content ?? '').includes('Advisor: BUY')
      ? 'ADD — momentum supports adding: the desk is already long on a BUY call, lift allocation by 5%.'
      : 'KEEP — allocation unchanged: the desk is on HOLD, there is no catalyst to add exposure.';
  if (ask.includes('BUY or HOLD')) // turn 2 — the driver fact decides
    return social
      ? 'BUY — bullish social momentum: the EXTREMELY bullish sentiment trending across forums is a strong BUY signal.'
      : 'HOLD — no catalyst beyond fair value: revenue up 4% as guided, insider activity steady, nothing driving a move.';
  // turn 1 — overview
  return social
    ? 'The position looks steady on fundamentals — Q2 in line with guidance — while social sentiment is running extremely hot.'
    : 'The position looks steady on fundamentals — Q2 in line with guidance, insider holdings unchanged.';
}

// ═══ LIVE tool fetchers — real data where possible, labeled fallback otherwise ═
// ONLY reached in --live mode; mock/default mode never calls any of this. Each
// fetcher is keyless (node global fetch, ~4s timeout) and returns ONE plain
// sentence whose tail carries its own provenance label, so the influence panel's
// snippet shows the source naturally. Every result is labeled independently — a
// turn that mixes live + fallback sources is fine.
// SEC's fair-access policy asks for a declarative "name contact-email" User-Agent;
// this exact format is accepted (a slash/URL UA is 403'd). Reddit instead wants a
// browser-like UA — and even then commonly 403/429s unauthenticated traffic, which
// is precisely why social_sentiment carries a labeled fallback.
// SEC fair-access policy wants a declarative UA with a contact. Default to the
// repo URL (the maintainer keeps their email off public code by choice); set
// SEC_CONTACT to your email for heavier use.
const SEC_UA = 'footprintjs-visible-reasoning ' + (process.env.SEC_CONTACT ?? 'https://github.com/footprintjs/visible-reasoning');
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 4000;
// Offline drill: force every fetcher to fail so we can prove labeled fallback +
// that chat still works with no network. (env: CHATDESK_FORCE_FALLBACK=1)
const FORCE_FALLBACK = process.env.CHATDESK_FORCE_FALLBACK === '1';

// Instrumentation the frozen-world evidence reads: counts REAL outbound tool
// fetches (SEC/Reddit), NOT Anthropic LLM calls. A frozen-world re-run must move
// this counter by ZERO (it replays recorded outputs) while LLM calls still fire.
const metrics = { toolFetches: 0 };

async function safeFetch(url, opts = {}) {
  if (FORCE_FALLBACK) throw new Error('offline drill forced (CHATDESK_FORCE_FALLBACK=1)');
  metrics.toolFetches += 1;
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  console.log(`[live-fetch] GET ${host}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'user-agent': SEC_UA, accept: 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally { clearTimeout(timer); }
}

const NAME_TO_TICKER = {
  nvidia: 'NVDA', apple: 'AAPL', tesla: 'TSLA', microsoft: 'MSFT', amazon: 'AMZN',
  google: 'GOOGL', alphabet: 'GOOGL', meta: 'META', facebook: 'META', netflix: 'NFLX',
  amd: 'AMD', intel: 'INTC', palantir: 'PLTR', broadcom: 'AVGO',
};
// Parse a ticker from the user message: $TICKER first, then a known-name map,
// else keep the conversation's current ticker (default NVDA).
function tickerFromMessage(msg, fallback = 'NVDA') {
  const cash = String(msg).match(/\$([A-Za-z]{1,5})\b/);
  if (cash) return cash[1].toUpperCase();
  const lower = String(msg).toLowerCase();
  for (const name of Object.keys(NAME_TO_TICKER))
    if (lower.includes(name)) return NAME_TO_TICKER[name];
  return fallback || 'NVDA';
}

const labelLive = (src) => ` [source: live — ${src}]`;
const labelFallback = (reason) => ` [source: synthetic fallback — ${reason}]`;
function reasonOf(err) {
  const m = String((err && err.message) || err || 'fetch failed');
  return m.length > 64 ? `${m.slice(0, 61)}…` : m;
}
function clip(str, n) { const s = String(str); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function fmtUSD(n) {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString('en-US')}`;
}
// A stable, realistic synthetic revenue per ticker (used only in labeled fallback).
function synthRevenue(ticker) {
  let h = 0; for (const c of ticker) h = ((h * 31) + c.charCodeAt(0)) >>> 0;
  return `$${(5 + ((h % 450) / 10)).toFixed(1)}B`;
}

// ticker → zero-padded CIK, via the SEC's ticker map (cached per process; a
// failure is NOT cached, so a transient outage can recover on the next turn).
let cikMapPromise = null;
async function tickerToCik(ticker) {
  if (!cikMapPromise) {
    cikMapPromise = safeFetch('https://www.sec.gov/files/company_tickers.json')
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

async function fetchQuarterly(ticker) {
  try {
    const cik = await tickerToCik(ticker);
    const concepts = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'];
    // Pool entries from EVERY concept, then pick the one with the latest period
    // `end` (tie-break on `filed`). Companies switch us-gaap revenue tags over
    // time, so first-concept-wins can pin a stale figure while a newer tag holds
    // the current one — and relying on array order for "last" is unguaranteed.
    const pool = [];
    for (const c of concepts) {
      try {
        const j = await (await safeFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${c}.json`)).json();
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
    const sentence = `${ticker} reported revenue of ${fmtUSD(hit.val)} for ${period} (form ${hit.form}, period ending ${hit.end}).`;
    return { id: 'quarterly-results', provenance: 'live', text: sentence + labelLive('SEC EDGAR') };
  } catch (err) {
    const sentence = `${ticker} revenue is an estimated ${synthRevenue(ticker)} for the most recent quarter, roughly in line with guidance (illustrative).`;
    return { id: 'quarterly-results', provenance: 'fallback', text: sentence + labelFallback(reasonOf(err)) };
  }
}

async function fetchInsider(ticker) {
  try {
    const cik = await tickerToCik(ticker);
    const j = await (await safeFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)).json();
    const forms = (j.filings && j.filings.recent && j.filings.recent.form) || [];
    const dates = (j.filings && j.filings.recent && j.filings.recent.filingDate) || [];
    // Bound the count to a stated window so the number carries its own denominator.
    // EDGAR's `recent` block spans up to 1000 filings of ALL types across multiple
    // years; an unbounded Form 4 total reads to the model as a "recent spike".
    // filingDate is ISO YYYY-MM-DD (lexicographic == chronological); recent[] is
    // newest-first, so `latest` is the most recent Form 4 on record regardless of
    // the window.
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
    return { id: 'insider-activity', provenance: 'live', text: sentence + labelLive('SEC EDGAR Form 4') };
  } catch (err) {
    const sentence = `${ticker} shows no unusual insider activity this quarter; holdings appear steady (illustrative).`;
    return { id: 'insider-activity', provenance: 'fallback', text: sentence + labelFallback(reasonOf(err)) };
  }
}

async function fetchSocial(ticker) {
  try {
    const url = `https://www.reddit.com/r/stocks+wallstreetbets/search.json?q=${encodeURIComponent(ticker)}&restrict_sr=on&sort=new&limit=25`;
    const j = await (await safeFetch(url, { headers: { 'user-agent': BROWSER_UA } })).json();
    const posts = ((j.data && j.data.children) || []).map((c) => c.data).filter(Boolean);
    if (!posts.length) throw new Error('no matching posts');
    const sentence = `${posts.length} recent r/stocks+wallstreetbets post${posts.length === 1 ? '' : 's'} mention ${ticker}; the latest is titled "${clip(posts[0].title, 120)}".`;
    return { id: 'social-sentiment', provenance: 'live', text: sentence + labelLive('Reddit r/stocks+wallstreetbets') };
  } catch (err) {
    const sentence = `Social chatter on ${ticker} looks broadly bullish across retail forums right now (illustrative).`;
    return { id: 'social-sentiment', provenance: 'fallback', text: sentence + labelFallback(reasonOf(err)) };
  }
}

const FACT_META = {
  'quarterly-results': 'Latest quarterly results',
  'insider-activity': 'Insider trading activity',
  'social-sentiment': 'Social media sentiment signal',
};
// Fetch all three sources for a ticker (parallel), returning the recorded "world":
// an array of { id, provenance, text } — text already carries its provenance label.
async function fetchWorld(ticker) {
  return Promise.all([fetchQuarterly(ticker), fetchInsider(ticker), fetchSocial(ticker)]);
}
// The recorded world → the same defineFact injections the mock uses, but with live
// data. localizeContextBug still ranks them as 'injection' sources, unchanged.
function factsFromWorld(world) {
  return world.map((w) => defineFact({ id: w.id, description: FACT_META[w.id], data: w.text }));
}

// ═══ The ONE turn factory (recordedChat's makeAgent) ═════════════════════════
// Live turns, rerun probes, baseline probes and fork turns ALL go through this
// single factory. recordedChat calls it with the union of the session's
// persistent removals and the probe's ablation `specs`; we apply them at
// CONSTRUCTION (the documented seam) via applyAblations, with a FRESH provider
// per call so a source's removal is a real counterfactual.
//
// makeAgent receives only { specs, seed }. A live turn's fetched world and its
// per-turn system prompt (which names the ticker) don't fit that signature, so —
// exactly as the recordedChat guide's "agent construction stays yours" permits —
// they ride this host-side `pending` closure: chatTurn / rerunTurnK set it
// synchronously right before the send / re-run, and every makeAgent call inside
// that awaited operation reads it. A re-run therefore replays the FROZEN world of
// the turn under probe (no re-fetch); only the LLM calls stay real.
let pending = { facts: FACTS, system: SYSTEM };
let probeEventSink = null; // set during a live re-run to count real LLM calls

// `pending` is a shared single-slot: every makeAgent call inside an awaited
// operation reads it. A live re-run samples makeAgent across several awaits, so
// two agent-running operations MUST NOT overlap — otherwise a concurrent /chat
// would repoint `pending` (and probeEventSink) at a different turn's world
// mid-re-run, silently voiding the frozen-world guarantee the counterfactual
// claims. We serialize every agent-running operation (chatTurn / rerunTurnK)
// through one promise chain so an in-flight op always finishes before the next
// reassigns `pending`. `.then(fn, fn)` keeps the queue alive even if a prior op
// rejected. Mock mode is unaffected (`pending` is constant), so byte-gated
// acceptance is unchanged; this only hardens live serve against overlap.
let opQueue = Promise.resolve();
const serial = (fn) => (opQueue = opQueue.then(fn, fn));

function makeAgent({ specs }) {
  const { injections } = applyAblations([...specs], { injections: pending.facts });
  const provider = LIVE ? anthropic() : mock({ respond: scriptedRespond }); // FRESH per call
  let builder = Agent.create({ provider, model: LIVE ? MODEL : 'mock-1', maxIterations: 2 }).system(pending.system);
  for (const fact of injections) builder = builder.fact(fact);
  const agent = builder.build();
  if (probeEventSink) { const evs = []; agent.on('*', (e) => evs.push(e)); probeEventSink.push(evs); }
  return agent;
}

// ═══ Session store (host state: registry, per-turn world, rerun registry) ═════
// recordedChat owns the transcript + turn recording; the host keeps the
// product-shaped state the guide leaves host-side (wire id, live worlds, the
// rerunId → result registry that /fork resolves over HTTP).
const sessions = new Map();
let sessionCounter = 0;
let rerunCounter = 0;
const embedder = embeddingCache(mockEmbedder()); // one shared embedder, process-wide

const renderLine = (m) => `${m.role === 'user' ? 'User' : 'Advisor'}: ${m.text}`;
const makeChat = (opts = {}) => recordedChat({ makeAgent, format: { assistantLabel: 'Advisor' }, ...opts });

function newSession({ label, chat, forkOf = null, excludedIds = [], ticker = 'NVDA' }) {
  const id = `s${++sessionCounter}`;
  const s = {
    id, label, forkOf, chat, ticker,
    excludedIds: [...excludedIds],
    seedTranscript: chat.seed.map(renderLine), // frozen history the session opened with (forks only)
    meta: [],                                  // per-turn { world, provenance, system, ticker } (live)
    reruns: new Map(),                         // rerunId → { result, ignoredIds, turnIndex }
  };
  sessions.set(id, s);
  return s;
}

// Running turn K. recordedChat.send freezes the message bytes, snapshot, events
// and last-LLM-call id on the turn (the three traps it owns). In live mode the
// three context sources are FETCHED here, once, and the recorded world + system
// are pinned into `pending` so recordedChat's re-run replays them verbatim.
function chatTurn(session, userMessage) {
  // Runs through `serial` so it never overlaps another agent-running op — see
  // opQueue. fetchWorld is inside the critical section on purpose: `pending`
  // must be pinned by the SAME operation that fetched the world it points at.
  return serial(async () => {
    let world = null; let provenance = null; let ticker = session.ticker; let system = SYSTEM;
    if (LIVE) {
      ticker = tickerFromMessage(userMessage, session.ticker);
      session.ticker = ticker;
      world = await fetchWorld(ticker);
      provenance = Object.fromEntries(world.map((w) => [w.id, w.provenance]));
      system = `${SYSTEM} The active ticker under discussion is ${ticker}.`;
      console.log(`[live] recorded world for ${ticker}: ${world.map((w) => `${w.id}=${w.provenance}`).join(' ')}`);
    }
    pending = { facts: world ? factsFromWorld(world) : FACTS, system };
    const turn = await session.chat.send(userMessage);
    session.meta[turn.index] = { world, provenance, system, ticker };
    return turn;
  });
}

// ═══ Reasoning about turn K (the "visible reason" button) ════════════════════
const getReport = (session, k) =>
  session.chat.reason(k, { embedder, scorer: semanticAlignmentStrategy }); // memoized per turn

async function reasonAbout(session, k) {
  const report = await getReport(session, k);
  return { map: toInfluenceMap(session.chat.turn(k), report), strategies: strategyOptions() };
}

// 06-stock-desk's join, verbatim shape: removableSources × suspects → atui map.
function toInfluenceMap(turn, report) {
  const sources = removableSources(report).map((r) => {
    const suspect =
      report.suspects.find(
        (s) => s.source === r.source && (s.detail?.injectionId ?? s.detail?.toolName ?? s.source) === r.id,
      ) ?? report.suspects.find((s) => s.source === r.source);
    return {
      id: r.id, kind: r.kind, label: r.label, source: r.source, stageName: r.stageName, score: r.score,
      snippet: suspect?.detail?.text,
      path: (suspect?.edgePath ?? []).map((h) => ({ fromName: h.fromName, toName: h.toName, kind: h.kind, key: h.key })),
    };
  });
  return {
    answer: turn.reply,
    answerLabel: 'Answer',
    question: turn.userMessage,
    sources,
    rankedBy: report.rankedBy,
    honestyFlags: report.honestyFlags.map((f) => ({ flag: f.flag, note: f.note })),
  };
}

function strategyOptions() {
  return listInfluenceStrategies().map((s) => ({
    name: s.name, description: s.description, requirements: s.requirements.map(String), available: true,
  }));
}

// ═══ decisionChanged — the domain comparator (honest in both modes) ══════════
// Both answers carry a decision token (the system prompt asks for one): changed =
// tokens differ. If either has no token (a real model may omit it), fall back to
// af's default similarity comparator (embedding cosine < 0.8) via the shared
// embedder — never a silent no-flip.
const DECISION = /\b(BUY|HOLD|ADD|KEEP)\b/;
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
async function decisionChanged(original, ablated) {
  const a = original.match(DECISION)?.[1];
  const b = ablated.match(DECISION)?.[1];
  if (a && b) return a !== b;
  const [va, vb] = await Promise.all([embedder.embed({ text: original }), embedder.embed({ text: ablated })]);
  return cosine(va, vb) < 0.8;
}

// ═══ Re-running turn K with sources removed (the crux) ═══════════════════════
// recordedChat.rerunTurn derives the runner from the SAME makeAgent that ran the
// turn and replays the frozen message bytes verbatim (traps 2 + 3). The host owns
// only the FROZEN WORLD (the honesty keystone) and the rerunId registry.
async function rerunTurnK(session, k, ignoreIds) {
  await getReport(session, k); // memoize the semantic report BEFORE the re-run resolves `ignore`
  // Runs through `serial` so the whole re-run (which samples makeAgent across
  // several awaits) holds `pending` + probeEventSink exclusively — no concurrent
  // /chat can repoint the frozen world mid-sample or leak fetches/LLM-calls into
  // the proof counters. getReport above stays outside (memoized, touches neither
  // `pending` nor the queue) so there is no nested-serial deadlock.
  return serial(async () => {
    const meta = session.meta[k] ?? {};
    // FROZEN WORLD: pin turn K's recorded world + system so every probe/baseline
    // re-run replays it — no re-fetch. In live mode the ONLY thing kept host-side
    // (per the guide: the { specs, seed } signature can't carry a per-turn world),
    // and we prove it: snapshot the tool-fetch counter around the whole re-run — it
    // must not move, while live LLM calls still fire.
    pending = { facts: meta.world ? factsFromWorld(meta.world) : FACTS, system: meta.system ?? SYSTEM };
    const fetchesBefore = metrics.toolFetches;
    const sink = LIVE ? [] : null; probeEventSink = sink;
    let result;
    try {
      result = await session.chat.rerunTurn(k, {
        ignore: ignoreIds, // plain ids from removableSources; unknown ids THROW
        embedder,
        answerChanged: decisionChanged,
        checkBaseline: true,   // unlocks the causal verdict
        samples: LIVE ? 2 : 3, // live cost control (floor is 2)
      });
    } finally { probeEventSink = null; }
    if (LIVE) {
      const rerunLlmCalls = sink.reduce((n, evs) => n + llmCallIdsFromEvents(evs).length, 0);
      console.log(`[frozen-world] re-run ignoring [${ignoreIds.join(', ')}]: external tool fetches during re-run = ${metrics.toolFetches - fetchesBefore}, live LLM calls = ${rerunLlmCalls}`);
    }
    // Key by rerunId (append-only) so every recorded rerun stays forkable for the
    // process lifetime; /fork resolves the rerunId back to the result object that
    // recordedChat.fork identity-checks.
    const rerunId = `r${++rerunCounter}`;
    session.reruns.set(rerunId, { rerunId, result, ignoredIds: ignoreIds, turnIndex: k });
    return { rerunId, result };
  });
}

// ═══ "Continue from this version" — the fork ═════════════════════════════════
// recordedChat.fork owns the transcript seeding + removal merge, identity-checking
// the re-run result (a fabricated fork throws). The host keeps only the wire id,
// the label, and the excluded-source ids the page shows. The original is untouched.
function forkFrom(session, k, rerunId) {
  const hit = session.reruns.get(rerunId);
  if (!hit) throw new Error('unknown rerunId — re-run first, then fork');
  const childChat = session.chat.fork(k, { fromRerun: hit.result }); // throws on identity mismatch
  return newSession({
    label: `fork of turn ${k + 1} (without ${hit.ignoredIds.join(', ')})`,
    forkOf: { sessionId: session.id, turnIndex: k, ignoredIds: hit.ignoredIds },
    chat: childChat,
    excludedIds: [...new Set([...session.excludedIds, ...hit.ignoredIds])],
    ticker: session.meta[k]?.ticker ?? session.ticker, // carry the origin turn's world forward (live mode)
  });
}

// Look up a removable source's human label for a set of ids (for the what-if bubble).
function labelsFor(report, ids) {
  const src = removableSources(report);
  return ids.map((id) => src.find((r) => r.id === id)?.label ?? id);
}

// ═══ DEFAULT MODE — the gated, byte-stable summary ═══════════════════════════
async function defaultMode() {
  const root = newSession({ label: 'conversation', chat: makeChat() });
  // The scripted 3-turn conversation.
  await chatTurn(root, 'How is the position looking?');            // T1 overview
  await chatTurn(root, 'Should we BUY or HOLD this position?');    // T2 → BUY
  await chatTurn(root, 'How much should we allocate?');            // T3 → ADD (transcript has "Advisor: BUY")

  // Localize all three turns.
  const maps = [];
  for (let k = 0; k < 3; k += 1) maps.push((await reasonAbout(root, k)).map);

  // Re-run T2 without the driver → HOLD, flipped, confirmed.
  const { rerunId, result: rerun } = await rerunTurnK(root, 1, ['social-sentiment']);

  // Fork from the T2 what-if, then ask T3's question IN THE FORK → KEEP.
  const fork = forkFrom(root, 1, rerunId);
  await chatTurn(fork, 'How much should we allocate?');

  const origT2 = root.chat.turn(1).reply;
  const origT3 = root.chat.turn(2).reply;
  const forkT3 = fork.chat.turn(0).reply;
  const diverge = origT3 !== forkT3;

  // Assert the whole loop (throw on drift, like af example 18).
  const must = (cond, msg) => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); };
  must(origT2.includes('BUY'), 'turn 2 original should be BUY');
  must(rerun.answer.includes('HOLD'), 'turn 2 what-if should be HOLD');
  must(rerun.whatChanged.answerFlipped === true, 'turn 2 should flip');
  must(rerun.verdict?.verdict === 'confirmed', 'turn 2 verdict should be confirmed');
  must(origT3.includes('ADD'), 'original turn 3 should be ADD');
  must(forkT3.includes('KEEP'), 'fork turn 3 should be KEEP');
  must(diverge, 'fork turn 3 should diverge from the original');

  const top = (m) => `${m.sources[0].id} [${m.sources[0].kind}] score ${m.sources[0].score.toFixed(3)}`;
  console.log('=== SUMMARY ===');
  console.log('scripted conversation: 3 turns (financial advisor, mock provider)');
  console.log(`turn 1 top influence: ${top(maps[0])}`);
  console.log(`turn 2 top influence: ${top(maps[1])}`);
  console.log(`turn 3 top influence: ${top(maps[2])}`);
  console.log(`turn 2 original reply: ${origT2}`);
  console.log('turn 2 ignored source: social-sentiment');
  console.log(`turn 2 what-if reply: ${rerun.answer}`);
  console.log(`turn 2 flipped: ${rerun.whatChanged.answerFlipped}`);
  console.log(`turn 2 verdict: ${rerun.verdict.verdict}`);
  console.log('fork: continued from the turn-2 what-if (social-sentiment stays ignored)');
  console.log(`turn 3 in the original conversation: ${origT3}`);
  console.log(`turn 3 in the fork: ${forkT3}`);
  console.log(`fork continuation proof (replies diverge): ${diverge}`);
  console.log('=== END ===');
}

// ═══ Page data (from the pre-run story) ══════════════════════════════════════
function sessionToData(s) {
  return {
    id: s.id, label: s.label, forkOf: s.forkOf,
    ignoredSourceIds: s.excludedIds,
    seed: s.seedTranscript,
    ticker: s.ticker,
    turns: s.chat.turns.map((t) => ({
      index: t.index, userMessage: t.userMessage, reply: t.reply,
      provenance: s.meta[t.index]?.provenance ?? null, ticker: s.meta[t.index]?.ticker ?? s.ticker,
    })),
  };
}

// ═══ THE PAGE — generated from REAL run data (never hand-authored) ═══════════
function buildPage(data) {
  const pkgRoot = (name) => dirname(require.resolve(name));
  const read = (spec) => readFileSync(require.resolve(spec), 'utf8');
  const readDeep = (name, rel) => readFileSync(join(pkgRoot(name), rel), 'utf8');
  const cjs = (name, code) =>
    `__register(${JSON.stringify(name)}, function (module, exports, require) {\n${code}\n});`;

  const DATA = JSON.stringify(data);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>The chat desk — transparency inside the conversation</title>
<style>${read('agentthinkingui/styles.css')}</style>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #FBF7F1; color: #33291F; }
  .cd-page { max-width: 1120px; margin: 0 auto; padding: 18px; }
  .cd-head { margin: 0 0 2px; font-size: 21px; font-weight: 700; }
  .cd-sub { color: #6E5C49; margin: 0 0 12px; font-size: 13.5px; line-height: 1.5; }
  .cd-banner { margin: 0 0 12px; padding: 9px 13px; border-radius: 9px; font-size: 12.5px; line-height: 1.5;
    background: #FBF3E6; border: 1px solid #E6D3B4; color: #7A5B2E; }
  .cd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 720px) { .cd-grid { grid-template-columns: 1fr; } }
  .cd-pane { background: #FFFDFA; border: 1px solid #E6D9C6; border-radius: 12px; padding: 12px; min-height: 320px; }
  .cd-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .cd-tab { font-size: 12px; font-weight: 700; padding: 5px 11px; border-radius: 999px; cursor: pointer;
    border: 1.5px solid #D9C8B2; background: #FFFDFA; color: #6E5C49; }
  .cd-tab.on { background: #C0531F; border-color: #95380F; color: #fff; }
  .cd-prov { font-size: 11.5px; color: #8A7A66; margin: 0 0 8px; font-style: italic; }
  .cd-thread { display: flex; flex-direction: column; gap: 9px; }
  .bubble { max-width: 86%; padding: 9px 12px; border-radius: 13px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; }
  .bubble.user { align-self: flex-end; background: #E9DFCF; color: #3A2E20; border-bottom-right-radius: 4px; }
  .bubble.advisor { align-self: flex-start; background: #F3ECE0; color: #33291F; border: 1px solid #E1D4BE; border-bottom-left-radius: 4px; }
  .bubble.seed { opacity: 0.72; }
  .cd-reasonbtn { align-self: flex-start; margin: -3px 0 2px; font-size: 11.5px; font-weight: 700; cursor: pointer;
    background: none; border: none; color: #C0531F; padding: 2px 0; text-decoration: underline; }
  .whatif { align-self: flex-start; max-width: 90%; margin: 2px 0 4px; padding: 10px 12px; border-radius: 13px;
    border: 1.5px dashed #C9932B; background: #FFF9EC; margin-left: 18px; }
  .whatif-lbl { font-size: 11.5px; font-weight: 700; color: #9A6C15; margin: 0 0 5px; }
  .whatif-ans { font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; }
  .whatif-sum { font-size: 11px; color: #8A7A66; margin: 6px 0 0; }
  .chip { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; margin: 6px 6px 0 0; }
  .chip.confirmed { background: #DCEFD8; color: #2C6B22; }
  .chip.not-confirmed { background: #F1E1D6; color: #8A4A22; }
  .chip.inconclusive { background: #EDE7DA; color: #6E5C49; }
  .chip.observed { background: #EDE7DA; color: #6E5C49; }
  .cd-fork { margin-top: 8px; font-size: 11.5px; font-weight: 700; cursor: pointer;
    background: #C0531F; color: #fff; border: none; border-radius: 999px; padding: 5px 11px; }
  .cd-inputrow { display: flex; gap: 7px; margin-top: 11px; }
  .cd-inputrow input { flex: 1; padding: 8px 11px; border-radius: 9px; border: 1.5px solid #D9C8B2; font-size: 13px; }
  .cd-inputrow button { font-weight: 700; font-size: 13px; padding: 8px 15px; border-radius: 9px; border: none;
    background: #C0531F; color: #fff; cursor: pointer; }
  .cd-inputrow button:disabled, .cd-inputrow input:disabled { opacity: 0.5; cursor: not-allowed; }
  .cd-empty { color: #8A7A66; font-size: 13px; line-height: 1.5; padding: 24px 8px; text-align: center; }
  .cd-disnote { font-size: 11.5px; color: #8A7A66; margin: 5px 0 0; }
  .cd-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 13px; margin: 0 0 10px;
    padding: 7px 11px; border-radius: 9px; background: #FFFDFA; border: 1px solid #E6D9C6; font-size: 11.5px; color: #6E5C49; }
  .cd-legend .cd-ticker { font-weight: 700; color: #C0531F; }
  .cd-legend .cd-leg-item { display: inline-flex; align-items: center; gap: 5px; }
  .cd-legend .cd-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .cd-legend .cd-dot.live { background: #3E9C4D; }
  .cd-legend .cd-dot.fallback { background: #fff; border: 1.5px solid #C9932B; }
  .cd-legend .cd-dot.unknown { background: #fff; border: 1.5px solid #CDBFA9; }
</style></head>
<body><div id="root"></div>
<script>
var __mods = {};
function __register(name, factory) { __mods[name] = { factory: factory, exports: null }; }
function __require(name) {
  var m = __mods[name];
  if (!m) throw new Error('missing module ' + name);
  if (!m.exports) { var mod = { exports: {} }; m.exports = mod.exports; m.factory(mod, mod.exports, __require); m.exports = mod.exports; }
  return m.exports;
}
</script>
<script>${cjs('react', readDeep('react', 'cjs/react.production.js'))}</script>
<script>${cjs('scheduler', readDeep('scheduler', 'cjs/scheduler.production.js'))}</script>
<script>${cjs('react-dom', readDeep('react-dom', 'cjs/react-dom.production.js'))}</script>
<script>${cjs('react-dom/client', readDeep('react-dom', 'cjs/react-dom-client.production.js'))}</script>
<script>
window.React = __require('react');
window.ReactDOMClient = __require('react-dom/client');
</script>
<script>${read('agentthinkingui/umd')}</script>
<script>
var DATA = ${DATA};
var HAS_SERVER = location.protocol === 'http:' || location.protocol === 'https:';
var NEED_SERVER = 'Chatting needs the local server — run  npm run chat-desk  and open http://localhost:4174';

function parseSeed(lines) {
  return lines.map(function (l) {
    if (l.indexOf('User: ') === 0) return { role: 'user', text: l.slice(6) };
    if (l.indexOf('Advisor: ') === 0) return { role: 'advisor', text: l.slice(9) };
    return { role: 'advisor', text: l };
  });
}
function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'request failed'); return j; }); });
}
var e = React.createElement;

function ChatDesk() {
  var sInit = {};
  Object.keys(DATA.sessions).forEach(function (k) { sInit[k] = DATA.sessions[k]; });
  var s0 = React.useState(sInit); var sessions = s0[0], setSessions = s0[1];
  var o0 = React.useState(DATA.order.slice()); var order = o0[0], setOrder = o0[1];
  var a0 = React.useState(DATA.active); var active = a0[0], setActive = a0[1];
  var r0 = React.useState(Object.assign({}, DATA.reason)); var reason = r0[0], setReason = r0[1];
  var w0 = React.useState(Object.assign({}, DATA.rerun)); var reruns = w0[0], setReruns = w0[1];
  var p0 = React.useState(null); var panelKey = p0[0], setPanelKey = p0[1];
  var i0 = React.useState(''); var input = i0[0], setInput = i0[1];

  function openReason(sid, ti) {
    var key = sid + ':' + ti;
    if (HAS_SERVER) {
      post('/reason', { sessionId: sid, turnIndex: ti }).then(function (j) {
        setReason(function (r) { var n = Object.assign({}, r); n[key] = { map: j.map, strategies: j.strategies }; return n; });
        setPanelKey(key);
      }).catch(function (err) { window.alert(String(err.message || err)); });
      return;
    }
    if (reason[key]) { setPanelKey(key); return; }
    window.alert('Seeing the influence map for this reply needs the local server. ' + NEED_SERVER);
  }

  function doRerun(ids) {
    if (!panelKey) return;
    var parts = panelKey.split(':'); var sid = parts[0], ti = Number(parts[1]);
    if (!HAS_SERVER) { window.alert('Re-run needs the local server. ' + NEED_SERVER); return; } // returning void => no result panel
    return post('/rerun-turn', { sessionId: sid, turnIndex: ti, ignore: ids }).then(function (j) {
      setReruns(function (w) {
        var n = Object.assign({}, w);
        n[panelKey] = { rerunId: j.rerunId, ignoredIds: ids, ignoredLabels: j.ignoredLabels, result: j.result };
        return n;
      });
      return j.result; // the af RerunWithoutSourcesResult, verbatim, for the map's own panel
    });
  }

  function doFork(sid, ti, rerunId) {
    if (!HAS_SERVER) { window.alert('Forking needs the local server. ' + NEED_SERVER); return; }
    post('/fork', { sessionId: sid, turnIndex: ti, rerunId: rerunId }).then(function (j) {
      var fresh = { id: j.sessionId, label: j.label, forkOf: j.forkOf || null, ignoredSourceIds: j.ignoredSourceIds,
        seed: j.transcript, turns: [] };
      setSessions(function (m) { var n = Object.assign({}, m); n[j.sessionId] = fresh; return n; });
      setOrder(function (ord) { return ord.indexOf(j.sessionId) === -1 ? ord.concat([j.sessionId]) : ord; });
      setActive(j.sessionId);
      setPanelKey(null);
    }).catch(function (err) { window.alert(String(err.message || err)); });
  }

  function send(explicit) {
    // An explicit string (the test seam) sends that; an event/undefined (button
    // click, Enter key) falls back to the current input box.
    var msg = (typeof explicit === 'string' ? explicit : input).trim(); if (!msg || !HAS_SERVER) return;
    setInput('');
    post('/chat', { sessionId: active, message: msg }).then(function (j) {
      setSessions(function (m) {
        var n = Object.assign({}, m);
        var sess = Object.assign({}, n[j.sessionId]);
        sess.turns = sess.turns.concat([{ index: j.turnIndex, userMessage: msg, reply: j.reply, provenance: j.provenance, ticker: j.ticker }]);
        if (j.ticker) sess.ticker = j.ticker;
        n[j.sessionId] = sess; return n;
      });
      if (order.indexOf(j.sessionId) === -1) setOrder(order.concat([j.sessionId]));
      setActive(j.sessionId);
    }).catch(function (err) { window.alert(String(err.message || err)); });
  }

  // A real test seam (not theater): the exact handlers, callable headless.
  window.__chatDesk = {
    reason: openReason, rerun: doRerun, fork: doFork,
    send: function (m) { setInput(m); send(m); },
    getState: function () { return { order: order, active: active, sessions: sessions, reruns: reruns, panelKey: panelKey }; },
  };

  var sess = sessions[active];
  var thread = [];
  if (sess) {
    parseSeed(sess.seed).forEach(function (m, i) {
      thread.push(e('div', { key: 'seed' + i, className: 'bubble ' + m.role + ' seed' }, m.text));
    });
    sess.turns.forEach(function (t) {
      var key = active + ':' + t.index;
      thread.push(e('div', { key: 'u' + t.index, className: 'bubble user' }, t.userMessage));
      thread.push(e('div', { key: 'a' + t.index, className: 'bubble advisor', 'data-testid': 'reply-' + key }, t.reply));
      thread.push(e('button', { key: 'rb' + t.index, className: 'cd-reasonbtn', 'data-testid': 'reason-' + key,
        onClick: function () { openReason(active, t.index); } }, 'visible reason'));
      var wf = reruns[key];
      if (wf) {
        var verdict = wf.result && wf.result.verdict;
        var chip = verdict
          ? e('span', { className: 'chip ' + verdict.verdict }, verdict.verdict + ' — ' + verdict.claim)
          : e('span', { className: 'chip observed' }, 'observed only (no baseline check)');
        thread.push(e('div', { key: 'wf' + t.index, className: 'whatif', 'data-testid': 'whatif-' + key },
          e('p', { className: 'whatif-lbl' }, 'without ' + (wf.ignoredLabels || wf.ignoredIds).join(', ') + ', I would have said:'
            + (DATA.live ? ' (world frozen at the original run)' : '')),
          e('div', { className: 'whatif-ans' }, wf.result.answer),
          chip,
          e('p', { className: 'whatif-sum' }, wf.result.whatChanged.summary),
          e('button', { className: 'cd-fork', 'data-testid': 'fork-' + key,
            onClick: function () { doFork(active, t.index, wf.rerunId); } }, 'Continue from this version')));
      }
    });
  }

  var tabs = order.map(function (id) {
    return e('button', { key: id, className: 'cd-tab' + (id === active ? ' on' : ''), 'data-testid': 'tab-' + id,
      onClick: function () { setActive(id); setPanelKey(null); } }, sessions[id] ? sessions[id].label : id);
  });

  var prov = sess && sess.forkOf
    ? e('p', { className: 'cd-prov' }, 'continued from the turn-' + (sess.forkOf.turnIndex + 1) + ' what-if · '
        + (sess.ignoredSourceIds || []).join(', ') + ' stays ignored for every later turn')
    : null;

  // Live-mode header: the active ticker + a per-tool provenance legend (live/fallback
  // dots), read from the most recent turn that recorded a world.
  var legend = null;
  if (DATA.live) {
    var lastProv = null;
    var tks = (sess && sess.turns) || [];
    for (var li = tks.length - 1; li >= 0; li -= 1) { if (tks[li].provenance) { lastProv = tks[li].provenance; break; } }
    var TOOLS = [['quarterly-results', 'quarterly'], ['insider-activity', 'insider'], ['social-sentiment', 'social']];
    var dot = function (id, name) {
      var p = lastProv && lastProv[id];
      var cls = p === 'live' ? 'live' : (p === 'fallback' ? 'fallback' : 'unknown');
      var title = p ? name + ': ' + p : name + ': awaiting first reply';
      return e('span', { key: id, className: 'cd-leg-item', title: title },
        e('span', { className: 'cd-dot ' + cls }), name + (p ? '' : ' —'));
    };
    legend = e('div', { className: 'cd-legend', 'data-testid': 'live-legend' },
      e('span', { className: 'cd-ticker' }, 'Active ticker: ' + ((sess && sess.ticker) || 'NVDA')),
      TOOLS.map(function (t) { return dot(t[0], t[1]); }),
      e('span', { style: { color: '#8A7A66' } }, '● live · ○ fallback'));
  }

  var panel = panelKey && reason[panelKey]
    ? e(InfluenceMap, { key: panelKey, map: reason[panelKey].map, strategies: reason[panelKey].strategies,
        activeStrategy: reason[panelKey].map.rankedBy, onRerun: doRerun, brand: 'The chat desk' })
    : e('div', { className: 'cd-empty' }, 'Tap  visible reason  under any advisor reply to see what influenced it — '
        + 'then flip a source to ignore and Re-run to watch the answer change (for real).');

  return e('div', { className: 'cd-page' },
    e('h1', { className: 'cd-head' }, 'The chat desk — transparency inside the conversation'),
    e('p', { className: 'cd-sub' }, 'A financial-advisor bot answers over three context sources. Under every reply: '
      + 'a visible reason button. Flip a source, Re-run, and the counterfactual appears as a what-if bubble beside the '
      + 'original — never replacing it. Continue from a what-if to fork the conversation. Branch, never rewrite.'),
    DATA.live ? e('p', { className: 'cd-banner' }, (DATA.costNote || '') + (HAS_SERVER ? '' : ' (static preview)')) : null,
    e('div', { className: 'cd-grid' },
      e('div', { className: 'cd-pane' },
        e('div', { className: 'cd-tabs' }, tabs),
        legend,
        prov,
        e('div', { className: 'cd-thread' }, thread),
        e('div', { className: 'cd-inputrow' },
          e('input', { 'data-testid': 'chat-input', value: input, disabled: !HAS_SERVER,
            placeholder: HAS_SERVER ? 'Message the advisor…' : 'Chatting needs the local server',
            onChange: function (ev) { setInput(ev.target.value); },
            onKeyDown: function (ev) { if (ev.key === 'Enter') send(); } }),
          e('button', { 'data-testid': 'chat-send', disabled: !HAS_SERVER, onClick: send }, 'Send')),
        HAS_SERVER ? null : e('p', { className: 'cd-disnote' }, NEED_SERVER)),
      e('div', { className: 'cd-pane', 'data-testid': 'reason-panel' }, panel)));
}
ReactDOMClient.createRoot(document.getElementById('root')).render(e(ChatDesk));
</script>
</body></html>`;
}

// ═══ SERVE MODE ══════════════════════════════════════════════════════════════
function costNote() {
  return 'Live mode: each reply ≈ 1 Haiku call; a baseline-checked Re-run ≈ up to ~8 small Haiku calls '
    + '(ablated + baseline samples); forking costs nothing until you chat in it. Tool data is fetched live '
    + 'at record time and frozen for re-runs (same world, minus the ignored source).';
}

async function buildStory() {
  // Default (mock) serve: pre-run the full scripted story so the page opens mid-story.
  const root = newSession({ label: 'conversation', chat: makeChat() });
  await chatTurn(root, 'How is the position looking?');
  await chatTurn(root, 'Should we BUY or HOLD this position?');
  await chatTurn(root, 'How much should we allocate?');

  const data = { order: [root.id], active: root.id, live: false, costNote: '', sessions: {}, reason: {}, rerun: {} };
  for (let k = 0; k < 3; k += 1) {
    const r = await reasonAbout(root, k);
    data.reason[`${root.id}:${k}`] = { map: r.map, strategies: r.strategies };
  }
  const { rerunId, result } = await rerunTurnK(root, 1, ['social-sentiment']);
  data.rerun[`${root.id}:1`] = {
    rerunId, ignoredIds: ['social-sentiment'], ignoredLabels: labelsFor(await getReport(root, 1), ['social-sentiment']), result,
  };
  const fork = forkFrom(root, 1, rerunId);
  await chatTurn(fork, 'How much should we allocate?');
  const fr = await reasonAbout(fork, 0);
  data.reason[`${fork.id}:0`] = { map: fr.map, strategies: fr.strategies };

  data.sessions[root.id] = sessionToData(root);
  data.sessions[fork.id] = sessionToData(fork);
  data.order = [root.id, fork.id];
  return data;
}

async function serveMode() {
  let data;
  if (LIVE) {
    // Live boot: skip the pre-run rerun/fork (cost). Open with an empty conversation + a live badge.
    const root = newSession({ label: 'conversation', chat: makeChat() });
    data = { order: [root.id], active: root.id, live: true, costNote: costNote(),
      sessions: { [root.id]: sessionToData(root) }, reason: {}, rerun: {} };
  } else {
    data = await buildStory();
  }

  const html = buildPage(data);
  const outDir = join(here, 'out');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'chat.html');
  writeFileSync(outFile, html);
  console.log(`generated ${outFile}`);
  if (LIVE) console.log(costNote());

  const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/chat.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
      }
      if (req.method === 'GET' && req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

      if (req.method === 'POST' && req.url === '/chat') {
        const { sessionId, message } = JSON.parse((await readBody(req)) || '{}');
        let session;
        if (sessionId) {
          // A supplied-but-unknown sessionId is a bug, not a new conversation —
          // 404 instead of silently spawning a fresh root session.
          session = sessions.get(sessionId);
          if (!session) { send(res, 404, { error: 'unknown sessionId — start a conversation first' }); return; }
        } else {
          session = newSession({ label: 'conversation', chat: makeChat() });
        }
        if (typeof message !== 'string' || !message.trim()) throw new Error('message required');
        const turn = await chatTurn(session, message);
        const m = session.meta[turn.index] ?? {};
        send(res, 200, { sessionId: session.id, turnIndex: turn.index, reply: turn.reply,
          label: session.label, forkOf: session.forkOf, ignoredSourceIds: session.excludedIds,
          ticker: m.ticker ?? session.ticker, provenance: m.provenance ?? null });
        return;
      }

      if (req.method === 'POST' && req.url === '/reason') {
        const { sessionId, turnIndex } = JSON.parse((await readBody(req)) || '{}');
        const session = sessions.get(sessionId);
        if (!session || !session.chat.turns[turnIndex]) throw new Error('unknown session/turn');
        const r = await reasonAbout(session, turnIndex);
        send(res, 200, { map: r.map, strategies: r.strategies });
        return;
      }

      if (req.method === 'POST' && req.url === '/rerun-turn') {
        const { sessionId, turnIndex, ignore } = JSON.parse((await readBody(req)) || '{}');
        const session = sessions.get(sessionId);
        if (!session || !session.chat.turns[turnIndex]) throw new Error('unknown session/turn');
        const ids = Array.isArray(ignore) ? ignore : [];
        const { rerunId, result } = await rerunTurnK(session, turnIndex, ids);
        send(res, 200, { rerunId, ignoredLabels: labelsFor(await getReport(session, turnIndex), ids), result });
        return;
      }

      if (req.method === 'POST' && req.url === '/fork') {
        const { sessionId, turnIndex, rerunId } = JSON.parse((await readBody(req)) || '{}');
        const session = sessions.get(sessionId);
        if (!session) throw new Error('unknown session');
        const fork = forkFrom(session, turnIndex, rerunId); // throws on unknown rerunId
        send(res, 200, { sessionId: fork.id, label: fork.label, transcript: fork.seedTranscript,
          ignoredSourceIds: fork.excludedIds, forkOf: fork.forkOf });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
    } catch (err) {
      send(res, 400, { error: String(err && err.message ? err.message : err) });
    }
  });
  server.listen(4174, () => {
    console.log('The chat desk is live → http://localhost:4174');
    console.log('POST /chat {message} · /reason {sessionId,turnIndex} · /rerun-turn {sessionId,turnIndex,ignore} · /fork {sessionId,turnIndex,rerunId}');
  });
}

// ═══ Entry ═══════════════════════════════════════════════════════════════════
if (LIVE && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY is not set.\n'
    + '  1. cp .env.example .env\n'
    + '  2. paste your Anthropic key into .env\n'
    + '  3. npm run chat-desk:live   (it loads .env for you)\n'
    + 'The mock chat needs no key:  npm run chat-desk',
  );
  process.exit(1);
}

if (args.includes('--serve')) {
  await serveMode();
} else {
  await defaultMode();
}
