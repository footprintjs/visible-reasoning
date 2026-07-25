// The gallery's two page shapes, both GENERATED from real run data:
//   buildGalleryPage(apps)      → out/gallery.html   (the cards landing page)
//   buildAppPage(app, data)     → out/<app>.html     (one chat desk per app)
//
// The chat page is 07-chat-desk's page shell generalized by app pack: same light
// conference skin, same React + agentthinkingui module shim, same HAS_SERVER
// honesty gating, plus a "← gallery" link and a per-app accent. The skin tokens
// and the module shim below are duplicated from 07-chat-desk/run.js — 07 is
// frozen as the paper's reference implementation.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgRoot = (name) => dirname(require.resolve(name));
const read = (spec) => readFileSync(require.resolve(spec), 'utf8');
const readDeep = (name, rel) => readFileSync(join(pkgRoot(name), rel), 'utf8');
const cjs = (name, code) =>
  `__register(${JSON.stringify(name)}, function (module, exports, require) {\n${code}\n});`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── The shared skin (07's tokens, verbatim) ────────────────────────────────
const SKIN = `
  :root {
    --bg: #FFFFFF; --panel-bg: #FFFFFF; --soft: #F6F4F0; --ink: #1E1A15; --muted: #786D5E;
    --line: #E9E3DA; --accent: #C0531F; --accent-dk: #95380F; --user: #EFEAE1; --whatif: #C9932B;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }

  /* provenance dots — one style per honest verdict */
  .cd-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
  .cd-dot.live { background: #3E9C4D; }
  .cd-dot.scripted { background: #8AA1B8; }
  .cd-dot.fallback { background: #fff; border: 1.5px solid #C9932B; }
  .cd-dot.synthetic { background: #FFF6E4; border: 1.5px dashed #C9932B; }
  .cd-dot.replay { background: #fff; border: 1.5px solid #7A4CBF; }
  .cd-dot.notconsulted { background: #fff; border: 1.5px solid #CDBFA9; }
  .cd-dot.unknown { background: #fff; border: 1.5px solid #CDBFA9; }
`;

// ─── THE CARDS LANDING PAGE ────────────────────────────────────────────────
/**
 * @param apps  the app packs, in gallery order
 * @param opts.live  true only when the real MCP client is serving the tools
 *   (stdio subprocess → mcp-server.js). Under the default `npm run gallery` the
 *   tools come from agentfootprint's in-memory mockMcpClient — no subprocess and
 *   no protocol frames — so the card must NOT claim MCP. Same honesty rule as
 *   every tool sentence: the label names what actually happened.
 * @param opts.model  the model id live turns actually send. Shown only when
 *   `live` — a mock desk calls no model, and the card says exactly that rather
 *   than borrowing a real model's name.
 */
export function buildGalleryPage(apps, { live = false, model = null } = {}) {
  const toolSourceLine = live ? 'tools served over MCP' : 'scripted mock tools — no MCP server';
  const modelLine = live && model ? `model: ${model}` : 'scripted mock — no model';
  const cards = apps.map((app) => {
    const tools = app.tools.map((t) => `
        <span class="ag-tool" title="${esc(t.description)}">
          <span class="cd-dot ${t.alwaysSynthetic ? 'synthetic' : 'scripted'}"></span>${esc(t.legendLabel)}
        </span>`).join('');
    const chips = app.starters.map((s) => `<span class="ag-chip">${esc(s)}</span>`).join('');
    return `
    <a class="ag-card" data-app="${esc(app.id)}" href="./${esc(app.id)}.html" style="--accent: ${esc(app.accent)}; --accent-dk: ${esc(app.accentDark)}">
      <span class="ag-rule"></span>
      <h2 class="ag-title">${esc(app.title)}</h2>
      <p class="ag-tag">${esc(app.tagline)}</p>
      <div class="ag-tools">${tools}</div>
      <p class="ag-mcp">${esc(toolSourceLine)}</p>
      <p class="ag-model">${esc(modelLine)}</p>
      <div class="ag-chips">${chips}</div>
      <span class="ag-cta">Open the desk →</span>
    </a>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The app gallery — one visible-reason machine, three apps</title>
<style>${SKIN}
  .ag-wrap { max-width: 1040px; margin: 0 auto; padding: 46px 22px 60px; }
  .ag-head { text-align: center; margin: 0 0 34px; }
  .ag-head h1 { font-size: 27px; letter-spacing: -0.015em; margin: 0 0 10px; }
  .ag-head p { font-size: 15px; line-height: 1.65; color: var(--muted); margin: 0 auto; max-width: 640px; }
  .ag-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
  .ag-card { display: flex; flex-direction: column; text-decoration: none; color: inherit;
    border: 1px solid var(--line); border-radius: 14px; padding: 0 18px 18px; background: var(--bg);
    overflow: hidden; transition: box-shadow .18s ease, transform .18s ease; }
  .ag-card:hover { box-shadow: 0 8px 26px rgba(40,30,20,.10); transform: translateY(-2px); }
  .ag-rule { display: block; height: 4px; margin: 0 -18px 16px; background: var(--accent); }
  .ag-title { font-size: 18px; margin: 0 0 5px; letter-spacing: -0.01em; }
  .ag-tag { font-size: 13.5px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
  .ag-tools { display: flex; flex-wrap: wrap; gap: 6px 13px; margin: 0 0 7px; }
  .ag-tool { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
  .ag-mcp { font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--accent);
    font-weight: 700; margin: 0 0 4px; }
  .ag-model { font-size: 11px; color: var(--muted); margin: 0 0 14px; }
  .ag-chips { display: flex; flex-direction: column; gap: 6px; margin: 0 0 18px; }
  .ag-chip { font-size: 12px; color: var(--muted); background: var(--soft); border: 1px solid var(--line);
    border-radius: 999px; padding: 5px 11px; line-height: 1.4; }
  .ag-cta { margin-top: auto; align-self: flex-start; font-size: 13px; font-weight: 700;
    color: #fff; background: var(--accent); border-radius: 999px; padding: 8px 16px; }
  .ag-card:hover .ag-cta { background: var(--accent-dk); }
  .ag-foot { margin: 34px auto 0; max-width: 720px; font-size: 12.5px; line-height: 1.7; color: var(--muted); text-align: center; }
  .ag-foot code { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; }
</style></head>
<body>
<div class="ag-wrap">
  <header class="ag-head">
    <h1>The app gallery — one visible-reason machine, three apps</h1>
    <p>Three real chat desks share one machine: every context source is an <strong>MCP tool the agent
    calls</strong>, every tool sentence carries its own provenance label, and every reply can be
    re-run without a source over the <strong>frozen</strong> tool results of the original turn.</p>
  </header>
  <div class="ag-grid">${cards}</div>
  <p class="ag-foot" id="ag-foot">Open a desk to chat. The trip advisor's crowd estimate is
    <strong>always synthetic</strong> — modeled, never measured — and always says so.</p>
</div>
<script>
// Served by the local server → route through it; opened as a file → keep the
// sibling .html artifacts so the gallery still walks card → app offline.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  document.querySelectorAll('.ag-card').forEach(function (a) { a.setAttribute('href', '/app/' + a.dataset.app); });
} else {
  document.getElementById('ag-foot').innerHTML +=
    '<br>Static preview — chatting needs the local server: run <code>npm run gallery</code> and open http://localhost:4175';
}
</script>
</body></html>`;
}

// ─── ONE APP'S CHAT DESK ───────────────────────────────────────────────────
export function buildAppPage(app, data) {
  const DATA = JSON.stringify({ ...data, app: appToData(app) });

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app.title)} — transparency inside the conversation</title>
<style>${read('agentthinkingui/styles.css')}</style>
<style>${SKIN}
  /* ── One desk of the app gallery — the 07 chat skin, per-app accent.
     A single centered conversation column with a fixed bottom composer; the
     "visible reason" panel slides in from the right (overlay on narrow
     screens). Light-first + high contrast for bright conference projectors. ── */
  :root { --accent: ${esc(app.accent)}; --accent-dk: ${esc(app.accentDark)}; }
  #root { height: 100%; }

  .cd-app { position: fixed; inset: 0; background: var(--bg); }
  .cd-main { height: 100%; display: flex; flex-direction: column; transition: margin-right .28s ease; }

  /* top bar — minimal chrome: gallery link, brand, tagline, session/fork tabs */
  .cd-bar { flex: 0 0 auto; display: flex; align-items: baseline; gap: 12px; padding: 12px 22px; border-bottom: 1px solid var(--line); }
  .cd-back { font-size: 12.5px; font-weight: 600; color: var(--muted); text-decoration: none; white-space: nowrap; }
  .cd-back:hover { color: var(--accent); }
  .cd-brand { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
  .cd-brand .cd-mark { color: var(--accent); font-weight: 700; }
  .cd-tagline { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* model badge — names what actually answers, in the same dot language as the
     tool legend: green dot + the real model id when a model is called, gray dot
     + "scripted mock — no model" when nothing is. */
  .cd-model { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
    color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
  .cd-model.live { color: #2C6B22; }
  .cd-tabs { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; align-self: center; }
  .cd-tab { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg); color: var(--muted); }
  .cd-tab.on { background: var(--accent); border-color: var(--accent-dk); color: #fff; }

  /* scrolling conversation + centered ~720px column */
  .cd-scroll { flex: 1 1 auto; overflow-y: auto; }
  .cd-col { max-width: 720px; margin: 0 auto; padding: 22px 22px 34px; }
  .cd-empty-hint { color: var(--muted); font-size: 14.5px; line-height: 1.65; padding: 52px 10px; text-align: center; }

  /* thread — user right in a subtle bubble, assistant left/full-width plain text */
  .cd-thread { display: flex; flex-direction: column; }
  .msg-user { align-self: flex-end; max-width: 76%; margin: 16px 0 2px; padding: 10px 15px;
    border-radius: 18px 18px 5px 18px; background: var(--user); color: var(--ink);
    font-size: 15px; line-height: 1.5; white-space: pre-wrap; }
  .msg-advisor { align-self: stretch; margin: 8px 0 0; padding: 2px 1px;
    font-size: 15.5px; line-height: 1.62; white-space: pre-wrap; color: var(--ink); }
  .msg-user.seed, .msg-advisor.seed { opacity: 0.62; }

  .cd-reasonbtn { align-self: flex-start; margin: 8px 0 2px; font-size: 12.5px; font-weight: 600; cursor: pointer;
    background: none; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); padding: 4px 13px; }
  .cd-reasonbtn:hover { color: var(--accent); border-color: var(--accent); }

  /* what-if — clearly a counterfactual (warm dashed accent) */
  .whatif { align-self: stretch; margin: 12px 0 6px; padding: 13px 15px; border-radius: 13px;
    border: 1px solid var(--line); border-left: 3px solid var(--whatif); background: var(--soft); }
  .whatif-lbl { font-size: 12px; font-weight: 700; color: #9A6C15; margin: 0 0 6px; }
  .whatif-ans { font-size: 14.5px; line-height: 1.5; white-space: pre-wrap; }
  .whatif-sum { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
  .chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; margin: 9px 6px 0 0; }
  .chip.confirmed { background: #E3F1DE; color: #2C6B22; }
  .chip.not-confirmed { background: #F6E5DA; color: #8A4A22; }
  .chip.inconclusive { background: #EEE8DD; color: #6E5C49; }
  .chip.observed { background: #EEE8DD; color: #6E5C49; }
  .cd-fork { margin-top: 11px; font-size: 12px; font-weight: 700; cursor: pointer;
    background: var(--accent); color: #fff; border: none; border-radius: 999px; padding: 7px 15px; }
  .cd-fork:hover { background: var(--accent-dk); }

  /* fork provenance note */
  .cd-prov { font-size: 12px; color: var(--muted); margin: 0 0 12px; padding: 8px 13px;
    background: var(--soft); border-radius: 9px; border: 1px solid var(--line); line-height: 1.5; }

  /* live cost banner */
  .cd-banner { margin: 0 0 12px; padding: 9px 13px; border-radius: 9px; font-size: 12px; line-height: 1.5;
    background: #FBF3E6; border: 1px solid #E6D3B4; color: #7A5B2E; }

  /* legend — active entity + per-tool provenance dots */
  .cd-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin: 0 0 12px;
    padding: 8px 13px; border-radius: 9px; background: var(--soft); border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .cd-legend .cd-entity { font-weight: 700; color: var(--accent); }
  .cd-legend .cd-leg-item { display: inline-flex; align-items: center; gap: 5px; }
  .cd-legend .cd-key { color: #8A7A66; }

  /* the "visible reason" panel — slides in from the right */
  .cd-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100%);
    background: var(--panel-bg); border-left: 1px solid var(--line); box-shadow: -10px 0 34px rgba(40,30,20,.10);
    transform: translateX(100%); transition: transform .28s ease; z-index: 50; display: flex; flex-direction: column; }
  .cd-panel.open { transform: translateX(0); }
  .cd-panel-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .cd-panel-title { font-size: 12px; font-weight: 700; color: var(--accent); letter-spacing: .04em; text-transform: uppercase; }
  .cd-panel-close { background: none; border: none; font-size: 23px; line-height: 1; color: var(--muted);
    cursor: pointer; padding: 0 8px 2px; border-radius: 8px; }
  .cd-panel-close:hover { background: var(--soft); color: var(--ink); }
  .cd-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 10px 14px 24px; }

  /* fixed bottom composer */
  .cd-composer { flex: 0 0 auto; border-top: 1px solid var(--line); background: var(--bg); }
  .cd-composer-col { max-width: 720px; margin: 0 auto; padding: 13px 22px 18px; }
  .cd-inputrow { display: flex; gap: 10px; align-items: center; }
  .cd-inputrow input { flex: 1; min-width: 0; padding: 12px 17px; border-radius: 999px; border: 1px solid var(--line);
    font-size: 15px; background: var(--soft); color: var(--ink); outline: none; }
  .cd-inputrow input:focus { border-color: var(--accent); background: #fff; }
  .cd-inputrow button { font-weight: 700; font-size: 14px; padding: 11px 22px; border-radius: 999px; border: none;
    background: var(--accent); color: #fff; cursor: pointer; }
  .cd-inputrow button:hover:not(:disabled) { background: var(--accent-dk); }
  .cd-inputrow button:disabled, .cd-inputrow input:disabled { opacity: 0.5; cursor: not-allowed; }
  .cd-disnote { font-size: 11.5px; color: var(--muted); margin: 9px 2px 0; text-align: center; }

  /* backdrop — only on narrow screens, where the panel is a full overlay */
  .cd-backdrop { position: fixed; inset: 0; background: rgba(30,22,14,.34); opacity: 0; pointer-events: none;
    transition: opacity .28s ease; z-index: 45; }

  @media (min-width: 721px) {
    .cd-app.panel-open .cd-main { margin-right: min(480px, 100%); }
    .cd-backdrop { display: none; }
  }
  @media (max-width: 720px) {
    .cd-panel { width: 100%; box-shadow: none; }
    .cd-backdrop.show { opacity: 1; pointer-events: auto; }
    /* Narrow top bar: drop the tagline and keep every tab to a single ellipsized
       line so a long "fork of turn 1 (without …)" chip can't wrap into a
       4-line pill. Desktop (>=721px) is untouched. */
    .cd-tagline, .cd-model { display: none; }
    .cd-tab { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
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
var API = '/app/' + DATA.app.id;
var GALLERY_HREF = HAS_SERVER ? '/' : './gallery.html';
var NEED_SERVER = 'Chatting needs the local server — run  npm run gallery  and open http://localhost:4175';

function parseSeed(lines) {
  var uP = 'User: ', aP = DATA.app.assistantLabel + ': ';
  return lines.map(function (l) {
    if (l.indexOf(uP) === 0) return { role: 'user', text: l.slice(uP.length) };
    if (l.indexOf(aP) === 0) return { role: 'advisor', text: l.slice(aP.length) };
    return { role: 'advisor', text: l };
  });
}
function post(path, body) {
  return fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'request failed'); return j; }); });
}
var e = React.createElement;

// A real model answers in markdown ("**WATCH** — ..."), so a bubble that prints
// the text verbatim shows the asterisks. This is the whole renderer: ESCAPE
// EVERYTHING FIRST, then re-admit exactly two inline marks — bold and italics.
// No library, no raw HTML from the model can survive the escape, and line breaks
// need no markup because the bubbles are white-space: pre-wrap.
function mdHtml(text) {
  var safe = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return safe
    .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?![*\\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\\w])_([^_\\n]+)_(?![_\\w])/g, '$1<em>$2</em>');
}
/** React's dangerous-HTML shape, fed only by mdHtml's escaped output. */
function md(text) { return { __html: mdHtml(text) }; }

function AppDesk() {
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
      // Seed the fork's entity from the response: the header must name the turn's
      // real subject on the FIRST paint, not the pack default until a reply lands.
      var fresh = { id: j.sessionId, label: j.label, forkOf: j.forkOf || null, ignoredSourceIds: j.ignoredSourceIds,
        seed: j.transcript, entity: j.entity || null, turns: [] };
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
    return post('/chat', { sessionId: active, message: msg }).then(function (j) {
      setSessions(function (m) {
        var n = Object.assign({}, m);
        var sess = Object.assign({}, n[j.sessionId]);
        sess.turns = sess.turns.concat([{ index: j.turnIndex, userMessage: msg, reply: j.reply, provenance: j.provenance, entity: j.entity }]);
        if (j.entity) sess.entity = j.entity;
        n[j.sessionId] = sess; return n;
      });
      if (order.indexOf(j.sessionId) === -1) setOrder(order.concat([j.sessionId]));
      setActive(j.sessionId);
      return j;
    }).catch(function (err) { window.alert(String(err.message || err)); });
  }

  // A real test seam (not theater): the exact handlers, callable headless.
  window.__appDesk = {
    appId: DATA.app.id,
    reason: openReason, rerun: doRerun, fork: doFork,
    send: function (m) { setInput(m); return send(m); },
    getState: function () { return { order: order, active: active, sessions: sessions, reruns: reruns, panelKey: panelKey }; },
  };

  var sess = sessions[active];
  var thread = [];
  if (sess) {
    parseSeed(sess.seed).forEach(function (m, i) {
      // Only the assistant's own words go through the markdown renderer; what the
      // user typed is shown exactly as typed.
      var cls = (m.role === 'user' ? 'msg-user' : 'msg-advisor') + ' seed';
      thread.push(m.role === 'user'
        ? e('div', { key: 'seed' + i, className: cls }, m.text)
        : e('div', { key: 'seed' + i, className: cls, dangerouslySetInnerHTML: md(m.text) }));
    });
    sess.turns.forEach(function (t) {
      var key = active + ':' + t.index;
      thread.push(e('div', { key: 'u' + t.index, className: 'msg-user' }, t.userMessage));
      thread.push(e('div', { key: 'a' + t.index, className: 'msg-advisor', 'data-testid': 'reply-' + key,
        dangerouslySetInnerHTML: md(t.reply) }));
      thread.push(e('button', { key: 'rb' + t.index, className: 'cd-reasonbtn', 'data-testid': 'reason-' + key,
        onClick: function () { openReason(active, t.index); } }, 'visible reason'));
      var wf = reruns[key];
      if (wf) {
        var verdict = wf.result && wf.result.verdict;
        var chip = verdict
          ? e('span', { className: 'chip ' + verdict.verdict }, verdict.verdict + ' — ' + verdict.claim)
          : e('span', { className: 'chip observed' }, 'observed only (no baseline check)');
        thread.push(e('div', { key: 'wf' + t.index, className: 'whatif', 'data-testid': 'whatif-' + key },
          e('p', { className: 'whatif-lbl' }, 'without ' + (wf.ignoredLabels || wf.ignoredIds).join(', ')
            + ', I would have said: (tool results frozen at the original run)'),
          e('div', { className: 'whatif-ans', dangerouslySetInnerHTML: md(wf.result.answer) }),
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

  // Per-tool provenance legend, read from the most recent turn that recorded one.
  var lastProv = null;
  var tks = (sess && sess.turns) || [];
  for (var li = tks.length - 1; li >= 0; li -= 1) { if (tks[li].provenance) { lastProv = tks[li].provenance; break; } }
  var dot = function (t) {
    var p = lastProv && lastProv[t.name];
    var cls = p === 'live' ? 'live'
      : p === 'fallback' ? 'fallback'
      : p === 'synthetic' ? 'synthetic'
      : p === 'scripted' ? 'scripted'
      : p === 'replay' ? 'replay'
      : p === 'not consulted' ? 'notconsulted' : 'unknown';
    var title = t.name + (p ? ': ' + p : ': awaiting first reply') + (t.alwaysSynthetic ? ' — always synthetic, modeled and never measured' : '');
    return e('span', { key: t.name, className: 'cd-leg-item', title: title },
      e('span', { className: 'cd-dot ' + cls }), t.legendLabel + (p ? '' : ' —'));
  };
  var legend = e('div', { className: 'cd-legend', 'data-testid': 'tool-legend' },
    e('span', { className: 'cd-entity' }, DATA.app.entityLabel + ': ' + ((sess && sess.entity) || DATA.app.entityDefault)),
    DATA.app.tools.map(dot),
    e('span', { className: 'cd-key' }, '● live · ● scripted · ○ fallback · ⬚ synthetic (never measured) · ○ not consulted'));

  // The influence panel reads as a ranked bar list (view="bars") with a native
  // strategy dropdown; all data wiring is identical to 07's.
  var panelOpen = !!(panelKey && reason[panelKey]);
  var panelInner = panelOpen
    ? e(InfluenceMap, { key: panelKey, map: reason[panelKey].map, strategies: reason[panelKey].strategies,
        activeStrategy: reason[panelKey].map.rankedBy, onRerun: doRerun,
        view: 'bars', strategyControl: 'dropdown', brand: DATA.app.title })
    : null;

  var hasContent = sess && ((sess.turns && sess.turns.length) || (sess.seed && sess.seed.length));
  var conversation = hasContent
    ? e('div', { className: 'cd-thread' }, thread)
    : e('div', { className: 'cd-empty-hint' }, 'Ask a question to begin. Every reply carries a '
        + '“visible reason” button — tap it to see, as a ranked bar list, exactly which sources shaped the answer.');

  return e('div', { className: 'cd-app' + (panelOpen ? ' panel-open' : '') },
    e('div', { className: 'cd-main' },
      e('div', { className: 'cd-bar' },
        e('a', { className: 'cd-back', href: GALLERY_HREF, 'data-testid': 'back-to-gallery' }, '← gallery'),
        e('span', { className: 'cd-brand' }, DATA.app.title, ' ', e('span', { className: 'cd-mark' }, '·'), ' ', DATA.app.assistantLabel),
        e('span', { className: 'cd-tagline' }, DATA.app.tagline),
        e('span', { className: 'cd-model' + (DATA.model ? ' live' : ''), 'data-testid': 'model-badge',
          title: DATA.model ? 'The model id sent on every request from this desk'
                            : 'Replies are scripted by the demo — no LLM is called' },
          e('span', { className: 'cd-dot ' + (DATA.model ? 'live' : 'scripted') }),
          DATA.model ? DATA.model : 'scripted mock — no model'),
        e('div', { className: 'cd-tabs' }, tabs)),
      e('div', { className: 'cd-scroll' },
        e('div', { className: 'cd-col' },
          DATA.live ? e('p', { className: 'cd-banner' }, (DATA.costNote || '') + (HAS_SERVER ? '' : ' (static preview)')) : null,
          legend,
          prov,
          conversation)),
      e('div', { className: 'cd-composer' },
        e('div', { className: 'cd-composer-col' },
          e('div', { className: 'cd-inputrow' },
            e('input', { 'data-testid': 'chat-input', value: input, disabled: !HAS_SERVER,
              placeholder: HAS_SERVER ? DATA.app.starters[0] : 'Chatting needs the local server',
              onChange: function (ev) { setInput(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === 'Enter') send(); } }),
            e('button', { 'data-testid': 'chat-send', disabled: !HAS_SERVER, onClick: send }, 'Send')),
          HAS_SERVER ? null : e('p', { className: 'cd-disnote' }, NEED_SERVER)))),
    e('div', { className: 'cd-panel' + (panelOpen ? ' open' : ''), 'data-testid': 'reason-panel' },
      e('div', { className: 'cd-panel-head' },
        e('span', { className: 'cd-panel-title' }, 'Visible reason'),
        e('button', { className: 'cd-panel-close', 'aria-label': 'close', onClick: function () { setPanelKey(null); } }, '×')),
      e('div', { className: 'cd-panel-body' }, panelInner)),
    e('div', { className: 'cd-backdrop' + (panelOpen ? ' show' : ''), onClick: function () { setPanelKey(null); } }));
}
ReactDOMClient.createRoot(document.getElementById('root')).render(e(AppDesk));
</script>
</body></html>`;
}

/** The page-safe slice of an app pack (no functions cross into the browser). */
function appToData(app) {
  return {
    id: app.id, title: app.title, tagline: app.tagline, assistantLabel: app.assistantLabel,
    accent: app.accent, entityLabel: app.entity.label, entityDefault: app.entity.default,
    starters: app.starters, driver: app.driver,
    tools: app.tools.map((t) => ({
      name: t.name, legendLabel: t.legendLabel, description: t.description,
      alwaysSynthetic: t.alwaysSynthetic === true,
    })),
  };
}
