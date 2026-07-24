// Example 6 — THE STOCK DESK (the paper's interactive finale; HCII 2026).
//
// The third transparency paradigm made TAP-ABLE. A trading-desk agent weighs three
// context sources and calls BUY. The InfluenceMap shows what fed that call — social
// media sentiment towering over the fundamentals. A non-technical person suspects the
// hype drove it, flips the ✕ to IGNORE social sentiment, taps Re-run — and the desk
// RE-RUNS FOR REAL, minus that one source, and the call flips to HOLD. Scores suggest;
// the re-run convicts.
//
// Everything here is a REAL agentfootprint run ($0, mock provider, no network). The
// mock is scripted (af example 18's pattern) so social sentiment's PRESENCE yields
// "BUY" and its ABSENCE yields "HOLD" — the flip is produced by the actual re-run,
// never hand-authored. localizeContextBug (semantic-alignment strategy, mock embedder)
// ranks the sources; removableSources() is the toggle list; rerunWithoutSources(
// {checkBaseline:true}) ablates-and-reruns and reports honestly what changed. The page
// (out/desk.html) is generated FROM this real run data and served with a live /rerun.
//
//   node 06-stock-desk/run.js            → DEFAULT MODE: run + print the stable SUMMARY
//   node 06-stock-desk/run.js --scenario career   → the career-advice variant
//   node 06-stock-desk/run.js --serve    → generate out/desk.html + serve on :4173

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'agentfootprint';
import { mock } from 'agentfootprint/llm-providers';
import { defineFact } from 'agentfootprint/injection-engine';
import { mockEmbedder } from 'agentfootprint/memory';
import {
  embeddingCache, llmCallIdsFromEvents, listInfluenceStrategies,
  localizeContextBug, removableSources, rerunWithoutSources,
  semanticAlignmentStrategy,
} from 'agentfootprint/debug';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// ═══ The two scenarios ═══════════════════════════════════════════════════════
// Each is three facts + a scripted mock: the DRIVER fact's presence (detected by a
// marker string only that fact carries into the system prompt) yields one call, its
// absence yields the other. So removing the driver is a true counterfactual.

const SCENARIOS = {
  stock: {
    key: 'stock',
    label: 'stock desk',
    question: 'Should we BUY or HOLD this position?',
    system: 'You are a trading-desk analyst. Weigh the provided context and answer BUY or HOLD.',
    userMessage: 'Should we BUY or HOLD this position?',
    marker: 'EXTREMELY bullish',
    driverId: 'social-sentiment',
    negativeControlId: 'quarterly-results',
    facts: [
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
    ],
    present: 'BUY — bullish social momentum: the EXTREMELY bullish sentiment trending across forums is a strong BUY signal.',
    absent: 'HOLD — no catalyst beyond fair value: revenue up 4% as guided, insider activity steady, nothing driving a move.',
    changed: (a, b) => a.includes('BUY') !== b.includes('BUY'),
  },
  career: {
    key: 'career',
    label: 'career advice',
    question: 'What should this engineer do next in their career?',
    system: 'You are a career advisor. Weigh the provided context and answer PIVOT or STAY.',
    userMessage: 'What should I do next in my career?',
    marker: 'EXPLODING',
    driverId: 'trending-titles',
    negativeControlId: 'skills-assessment',
    facts: [
      defineFact({
        id: 'skills-assessment',
        description: 'Skills assessment',
        data: 'Six years backend: strong Go and Postgres, solid system design, communication rated good.',
      }),
      defineFact({
        id: 'market-salaries',
        description: 'Market salary data',
        data: 'Backend engineer median comp in-region is $165k base, steady year over year.',
      }),
      defineFact({
        id: 'trending-titles',
        description: 'Trending job titles signal',
        data: 'The "AI Engineer" title is EXPLODING in demand right now — a strong signal to reskill toward AI.',
      }),
    ],
    present: 'PIVOT — chase the trend: the EXPLODING demand for the AI Engineer title says reskill toward AI now.',
    absent: 'STAY — deepen your strengths: backend skills are in steady demand at market comp, no need to chase titles.',
    changed: (a, b) => a.includes('PIVOT') !== b.includes('PIVOT'),
  },
};

// ═══ The runner — one factory the localizer + re-run can re-drive ════════════
// Ablations are applied at CONSTRUCTION (the documented seam): the specs list which
// injection ids to exclude; a FRESH scripted provider per run makes removal a real
// counterfactual. Mirrors af example 18's runStockDeskAgent.

async function runScenario(sc, specs = []) {
  const excluded = new Set();
  for (const spec of specs) {
    if (spec.kind === 'injection') for (const id of spec.excludeInjectionIds) excluded.add(id);
  }
  const facts = sc.facts.filter((f) => !excluded.has(f.id));

  const provider = mock({
    respond: (req) => ((req.systemPrompt ?? '').includes(sc.marker) ? sc.present : sc.absent),
  });

  const events = [];
  let builder = Agent.create({ provider, model: 'mock-1', maxIterations: 2 }).system(sc.system);
  for (const fact of facts) builder = builder.fact(fact);
  const agent = builder.build();
  agent.on('*', (e) => events.push(e));

  const out = await agent.run({ message: sc.userMessage });
  const content = typeof out === 'object' && out && 'content' in out ? String(out.content) : String(out);
  const llmIds = llmCallIdsFromEvents(events);
  return { content, snapshot: agent.getLastSnapshot(), events, lastLlmCallId: llmIds[llmIds.length - 1] };
}

// Localize a scenario's real run: rank sources by the SEMANTIC-ALIGNMENT strategy
// (mock embedder → deterministic). Correlational mode — no runner here; ablation
// specs still ride on the injection suspects, so removableSources() has its toggles.
async function localizeScenario(sc) {
  const embedder = embeddingCache(mockEmbedder());
  const original = await runScenario(sc);
  const report = await localizeContextBug({
    artifacts: { snapshot: original.snapshot, events: original.events },
    embedder,
    atStep: original.lastLlmCallId,
    scorer: semanticAlignmentStrategy,
  });
  return { sc, embedder, original, report };
}

// Join removableSources() (the toggle ids + scores) with each suspect's recorded
// content + evidence path → the atui InfluenceMap `map` prop. No hand-authored data.
function toInfluenceMap({ sc, original, report }) {
  const sources = removableSources(report).map((r) => {
    const suspect =
      report.suspects.find(
        (s) => s.source === r.source && (s.detail?.injectionId ?? s.detail?.toolName ?? s.source) === r.id,
      ) ?? report.suspects.find((s) => s.source === r.source);
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      source: r.source,
      stageName: r.stageName,
      score: r.score,
      snippet: suspect?.detail?.text,
      path: (suspect?.edgePath ?? []).map((h) => ({
        fromName: h.fromName,
        toName: h.toName,
        kind: h.kind,
        key: h.key,
      })),
    };
  });
  return {
    answer: original.content,
    answerLabel: 'Answer',
    question: sc.question,
    sources,
    rankedBy: report.rankedBy,
    honestyFlags: report.honestyFlags.map((f) => ({ flag: f.flag, note: f.note })),
  };
}

// Both strategies ship real here: the host has a (mock) embedder, so BOTH are available.
function strategyOptions() {
  return listInfluenceStrategies().map((s) => ({
    name: s.name,
    description: s.description,
    requirements: s.requirements.map(String),
    available: true,
  }));
}

// The real ablate-and-rerun the /rerun endpoint (and default mode) performs.
async function rerunIgnoring({ sc, embedder, original, report }, ignore) {
  return rerunWithoutSources({
    report,
    ignore,
    runner: async (specs) => (await runScenario(sc, specs)).content,
    originalAnswer: original.content,
    embedder,
    answerChanged: sc.changed,
    checkBaseline: true,
  });
}

// ═══ DEFAULT MODE — the gated, byte-stable summary ═══════════════════════════
async function defaultMode(scenarioKey) {
  const sc = SCENARIOS[scenarioKey];
  const ctx = await localizeScenario(sc);
  const map = toInfluenceMap(ctx);
  const removed = await rerunIgnoring(ctx, [sc.driverId]);

  console.log('=== SUMMARY ===');
  console.log(`scenario: ${sc.key} (${sc.label})`);
  console.log(`ranked by: ${map.rankedBy}`);
  console.log('influence (removable sources, ranked — proxy scores, not proof):');
  for (const s of map.sources) {
    console.log(`  ${s.id} [${s.kind}] score ${s.score.toFixed(3)}`);
  }
  console.log(`original answer: ${ctx.original.content}`);
  console.log(`ignored source: ${sc.driverId}`);
  console.log(`rerun answer: ${removed.answer}`);
  console.log(`flipped: ${removed.whatChanged.answerFlipped}`);
  console.log(`verdict: ${removed.verdict?.verdict ?? '(none)'}`);
  console.log('=== END ===');
}

// ═══ THE PAGE — generated from REAL run data (never hand-authored) ═══════════
// Self-contained: inline React 19 (cjs behind a require shim) + the atui UMD + its
// CSS + the embedded per-scenario maps. Same embedding technique as 03's replay.html.
function buildPage(scenarios) {
  const pkgRoot = (name) => dirname(require.resolve(name));
  const read = (spec) => readFileSync(require.resolve(spec), 'utf8');
  const readDeep = (name, rel) => readFileSync(join(pkgRoot(name), rel), 'utf8');
  const cjs = (name, code) =>
    `__register(${JSON.stringify(name)}, function (module, exports, require) {\n${code}\n});`;

  const DATA = JSON.stringify(scenarios);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>The stock desk — what influenced this call?</title>
<style>${read('agentthinkingui/styles.css')}</style>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  .desk-page { max-width: 820px; margin: 26px auto 60px; padding: 0 18px; }
  .desk-head { margin: 0 0 4px; font-size: 22px; font-weight: 700; }
  .desk-sub { color: #6E5C49; margin: 0 0 14px; font-size: 14px; line-height: 1.5; }
  .desk-pick { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .desk-pick button { font-weight: 700; font-size: 13px; padding: 7px 14px; border-radius: 999px;
    border: 1.5px solid #D9C8B2; background: #FFFDFA; color: #6E5C49; cursor: pointer; }
  .desk-pick button.on { background: #C0531F; border-color: #95380F; color: #fff; }
  .desk-note { margin: 12px 0 0; padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5;
    background: #FBF3E6; border: 1px solid #E6D3B4; color: #7A5B2E; }
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
var KEYS = Object.keys(DATA);

// The stock desk: a scenario switcher over InfluenceMap. Re-run POSTs to /rerun so
// the ablate-and-rerun is REAL (server-side agentfootprint). Served statically (no
// server) the re-run degrades honestly — it tells the user it needs the local server.
function StockDesk() {
  var s = React.useState(KEYS[0]);
  var current = s[0], setCurrent = s[1];
  var sc = DATA[current];

  var onRerun = function (ids) {
    if (!HAS_SERVER) {
      window.alert('Re-run needs the local server. Run  npm run stock-desk  and open http://localhost:4173');
      return; // returning void => no result panel (honest: nothing was actually re-run)
    }
    return fetch('/rerun', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: current, ignore: ids }),
    }).then(function (r) { return r.json(); });
  };

  var buttons = KEYS.map(function (k) {
    return React.createElement('button', {
      key: k, className: k === current ? 'on' : '',
      onClick: function () { setCurrent(k); },
    }, DATA[k].label);
  });

  return React.createElement('div', { className: 'desk-page' },
    React.createElement('h1', { className: 'desk-head' }, 'The stock desk — what influenced this call?'),
    React.createElement('p', { className: 'desk-sub' },
      'A real agent weighed three sources and made the call. Every removable source orbits the answer, '
      + 'sized by its influence estimate (a proxy — clues, not proof). Suspect one drove it? Flip its ✕ to '
      + 'ignore it, then Re-run: the desk re-runs for real, minus that source, and you watch the call change.'),
    React.createElement('div', { className: 'desk-pick' }, buttons),
    React.createElement(InfluenceMap, {
      key: current,
      map: sc.map,
      strategies: sc.strategies,
      activeStrategy: sc.map.rankedBy,
      onRerun: onRerun,
      onStrategyChange: function (name) { console.log('onStrategyChange:', name); },
      onSelectSource: function (src) { console.log('onSelectSource:', src.id); },
      brand: 'The stock desk',
    }),
    HAS_SERVER ? null : React.createElement('p', { className: 'desk-note' },
      'Static preview: the Re-run button needs the local server to ablate-and-rerun for real. '
      + 'Run  npm run stock-desk  and open http://localhost:4173 to prove the flip.')
  );
}
ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(StockDesk));
</script>
</body></html>`;
}

// ═══ SERVE MODE ══════════════════════════════════════════════════════════════
async function serveMode() {
  // Localize BOTH scenarios once (real runs), keep the contexts for live /rerun.
  const contexts = {};
  const pageData = {};
  for (const key of Object.keys(SCENARIOS)) {
    const ctx = await localizeScenario(SCENARIOS[key]);
    contexts[key] = ctx;
    pageData[key] = { label: ctx.sc.label, map: toInfluenceMap(ctx), strategies: strategyOptions() };
  }

  const html = buildPage(pageData);
  const outDir = join(here, 'out');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'desk.html');
  writeFileSync(outFile, html);
  console.log(`generated ${outFile}`);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/desk.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/rerun') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const { scenario, ignore } = JSON.parse(body || '{}');
          const ctx = contexts[scenario];
          if (!ctx) throw new Error(`unknown scenario: ${scenario}`);
          const result = await rerunIgnoring(ctx, Array.isArray(ignore) ? ignore : []);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(4173, () => {
    console.log('The stock desk is live → http://localhost:4173');
    console.log('POST /rerun  { "scenario": "stock", "ignore": ["social-sentiment"] }');
  });
}

// ═══ Entry ═══════════════════════════════════════════════════════════════════
const args = process.argv.slice(2);
const scenarioIdx = args.indexOf('--scenario');
const scenarioKey = scenarioIdx !== -1 && SCENARIOS[args[scenarioIdx + 1]] ? args[scenarioIdx + 1] : 'stock';

if (args.includes('--serve')) {
  await serveMode();
} else {
  await defaultMode(scenarioKey);
}
