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
  embeddingCache, llmCallIdsFromEvents, listInfluenceStrategies,
  localizeContextBug, removableSources, rerunWithoutSources,
  semanticAlignmentStrategy,
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

// ═══ The ONE turn factory ════════════════════════════════════════════════════
// Live turns, rerun probes, and fork turns all go through it — a single source of
// truth. Ablations are applied at CONSTRUCTION (the documented seam): specs list
// injection ids to exclude; a FRESH provider per call makes removal a real
// counterfactual. History is the hcifootprint-demo convention: thread the frozen
// transcript into the message string, byte-exact between the recorded turn and its
// rerun.
async function runTurn({ transcriptBefore, userMessage, excludedIds, specs = [], live }) {
  const excluded = new Set(excludedIds);
  for (const spec of specs)
    if (spec.kind === 'injection') for (const id of spec.excludeInjectionIds) excluded.add(id);
  const facts = FACTS.filter((f) => !excluded.has(f.id));

  const provider = live ? anthropic() : mock({ respond: scriptedRespond }); // FRESH per call
  const events = [];
  let builder = Agent.create({ provider, model: live ? MODEL : 'mock-1', maxIterations: 2 }).system(SYSTEM);
  for (const fact of facts) builder = builder.fact(fact);
  const agent = builder.build();
  agent.on('*', (e) => events.push(e));

  const message =
    (transcriptBefore.length ? `Recent conversation:\n${transcriptBefore.join('\n')}\n\n` : '')
    + `User: ${userMessage}`;

  const out = await agent.run({ message });
  const content = typeof out === 'object' && out && 'content' in out ? String(out.content) : String(out);
  const llmIds = llmCallIdsFromEvents(events);
  // CAPTURE IMMEDIATELY — getLastSnapshot() is last-run-only.
  return { content, snapshot: agent.getLastSnapshot(), events, lastLlmCallId: llmIds[llmIds.length - 1] };
}

// ═══ Session store (host state; append-only transcripts) ═════════════════════
const sessions = new Map();
let sessionCounter = 0;
let rerunCounter = 0;
const embedder = embeddingCache(mockEmbedder()); // one shared embedder, process-wide

function newSession({ label, forkOf = null, excludedIds = [], transcript = [] }) {
  const id = `s${++sessionCounter}`;
  const s = {
    id, label, forkOf,
    excludedIds: [...excludedIds],
    seedTranscript: [...transcript], // frozen history the session opened with (forks only)
    transcript: [...transcript],     // append-only, never rewritten
    turns: [],
  };
  sessions.set(id, s);
  return s;
}

// Running turn K in a session (records a frozen TurnRecord).
async function chatTurn(session, userMessage) {
  const transcriptBefore = Object.freeze([...session.transcript]);
  const t = await runTurn({ transcriptBefore, userMessage, excludedIds: session.excludedIds, live: LIVE });
  session.transcript.push(`User: ${userMessage}`, `Advisor: ${t.content}`);
  const turn = {
    index: session.turns.length, userMessage, reply: t.content,
    transcriptBefore, snapshot: t.snapshot, events: t.events,
    lastLlmCallId: t.lastLlmCallId, report: null, reruns: new Map(),
  };
  session.turns.push(turn);
  return turn;
}

// ═══ Reasoning about turn K (the "visible reason" button) ════════════════════
async function reasonAbout(session, k) {
  const turn = session.turns[k];
  turn.report ??= await localizeContextBug({
    artifacts: { snapshot: turn.snapshot, events: turn.events },
    embedder,
    atStep: turn.lastLlmCallId,
    scorer: semanticAlignmentStrategy,
  });
  return { map: toInfluenceMap(turn), strategies: strategyOptions() };
}

// 06-stock-desk's join, verbatim shape: removableSources × suspects → atui map.
function toInfluenceMap(turn) {
  const report = turn.report;
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
async function rerunTurnK(session, k, ignoreIds) {
  const turn = session.turns[k];
  if (!turn.report) await reasonAbout(session, k);
  const result = await rerunWithoutSources({
    report: turn.report,
    ignore: ignoreIds, // plain ids from removableSources; unknown ids THROW
    runner: async (specs) =>
      (await runTurn({
        transcriptBefore: turn.transcriptBefore, // the FROZEN recorded history
        userMessage: turn.userMessage,
        excludedIds: session.excludedIds,        // fork sessions keep their exclusions
        specs, live: LIVE,
      })).content,
    originalAnswer: turn.reply,
    embedder,
    answerChanged: decisionChanged,
    checkBaseline: true,        // unlocks the causal verdict
    samples: LIVE ? 2 : 3,      // live cost control (floor is 2)
  });
  const rerunId = `r${++rerunCounter}`;
  // Key by rerunId (append-only) so every recorded rerun stays forkable for the
  // process lifetime — re-running the same ignore-set no longer orphans an
  // earlier rerunId that an embedded fork button might still reference.
  turn.reruns.set(rerunId, { rerunId, result, ignoredIds: ignoreIds });
  return { rerunId, result };
}

// ═══ "Continue from this version" — the fork ═════════════════════════════════
// Pure host state: a NEW session seeded with a SERVER-RECORDED rerun answer
// (referenced by rerunId), never client-supplied text. The fork carries the
// ablation forward (excludedIds persists) — the what-if world stays the what-if
// world. The original session is never touched.
function forkFrom(session, k, rerunId) {
  const turn = session.turns[k];
  if (!turn) throw new Error('unknown session/turn');
  const hit = turn.reruns.get(rerunId);
  if (!hit) throw new Error('unknown rerunId — re-run first, then fork');
  const fork = newSession({
    label: `fork of turn ${k + 1} (without ${hit.ignoredIds.join(', ')})`,
    forkOf: { sessionId: session.id, turnIndex: k, ignoredIds: hit.ignoredIds },
    excludedIds: [...new Set([...session.excludedIds, ...hit.ignoredIds])],
    transcript: [...turn.transcriptBefore, `User: ${turn.userMessage}`, `Advisor: ${hit.result.answer}`],
  });
  return fork;
}

// Look up a removable source's human label for a set of ids (for the what-if bubble).
function labelsFor(turn, ids) {
  const src = removableSources(turn.report);
  return ids.map((id) => src.find((r) => r.id === id)?.label ?? id);
}

// ═══ DEFAULT MODE — the gated, byte-stable summary ═══════════════════════════
async function defaultMode() {
  const root = newSession({ label: 'conversation' });
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

  const origT2 = root.turns[1].reply;
  const origT3 = root.turns[2].reply;
  const forkT3 = fork.turns[0].reply;
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
    turns: s.turns.map((t) => ({ index: t.index, userMessage: t.userMessage, reply: t.reply })),
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
        sess.turns = sess.turns.concat([{ index: j.turnIndex, userMessage: msg, reply: j.reply }]);
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
          e('p', { className: 'whatif-lbl' }, 'without ' + (wf.ignoredLabels || wf.ignoredIds).join(', ') + ', I would have said:'),
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
  return 'Live mode: each reply ≈ 1 Haiku call; each Re-run ≈ 4 Haiku calls '
    + '(2 ablated + 2 baseline); forking costs nothing until you chat in it.';
}

async function buildStory() {
  // Default (mock) serve: pre-run the full scripted story so the page opens mid-story.
  const root = newSession({ label: 'conversation' });
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
    rerunId, ignoredIds: ['social-sentiment'], ignoredLabels: labelsFor(root.turns[1], ['social-sentiment']), result,
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
    const root = newSession({ label: 'conversation' });
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
          session = newSession({ label: 'conversation' });
        }
        if (typeof message !== 'string' || !message.trim()) throw new Error('message required');
        const turn = await chatTurn(session, message);
        send(res, 200, { sessionId: session.id, turnIndex: turn.index, reply: turn.reply,
          label: session.label, forkOf: session.forkOf, ignoredSourceIds: session.excludedIds });
        return;
      }

      if (req.method === 'POST' && req.url === '/reason') {
        const { sessionId, turnIndex } = JSON.parse((await readBody(req)) || '{}');
        const session = sessions.get(sessionId);
        if (!session || !session.turns[turnIndex]) throw new Error('unknown session/turn');
        const r = await reasonAbout(session, turnIndex);
        send(res, 200, { map: r.map, strategies: r.strategies });
        return;
      }

      if (req.method === 'POST' && req.url === '/rerun-turn') {
        const { sessionId, turnIndex, ignore } = JSON.parse((await readBody(req)) || '{}');
        const session = sessions.get(sessionId);
        if (!session || !session.turns[turnIndex]) throw new Error('unknown session/turn');
        const ids = Array.isArray(ignore) ? ignore : [];
        const { rerunId, result } = await rerunTurnK(session, turnIndex, ids);
        send(res, 200, { rerunId, ignoredLabels: labelsFor(session.turns[turnIndex], ids), result });
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
