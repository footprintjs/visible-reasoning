// The gallery's two page shapes, both GENERATED from real run data:
//   buildGalleryPage(apps)      → out/gallery.html   (the home: desk listing + notes)
//   buildAppPage(app, data)     → out/<app>.html     (one chat desk per app)
//
// The home's components — its skin, its one reveal gesture, the desk listing and
// the program notes — live in this file too (see THE HOME PAGE, below) and are
// shared with the public BYOK home in lib/byok-page.js, so the two landings are
// the same page with different facts in it.
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

// ─── The provenance vocabulary, in plain words ──────────────────────────────
// The dots are the honest core of a desk — and "fallback" / "synthetic (never
// measured)" are jargon to a conference visitor who has never read the paper.
// So the vocabulary is defined ONCE, here, and drives every surface: the tool
// dots in the legend row, their native title tooltips, and both sections of the
// "what do these mean?" dialog. A label and its explanation cannot drift apart
// because there is only one of each. (byok-page.js imports this too.)
//
//   state — the provenance verdict the recorder actually reports
//   label — the plain name a visitor reads
//   what  — the one-sentence explanation
export const PROVENANCE_HELP = [
  { state: 'live', label: 'live',
    what: 'real data fetched from the internet just now (this source really answered)' },
  { state: 'scripted', label: 'scripted',
    what: 'rehearsal data written into the demo; no model or network involved' },
  { state: 'fallback', label: 'fallback',
    what: 'we tried the real source but couldn’t reach it, so the demo used realistic stand-in data — and says so' },
  { state: 'synthetic', label: 'synthetic (never measured)',
    what: 'data that is invented by design (like the crowd estimate); it is always labeled, never passed off as real' },
  { state: 'not consulted', label: 'not consulted',
    what: 'the assistant didn’t use this source for this reply' },
];

// THE ONE state→paint mapping. Nothing else in either page may turn a
// provenance verdict into a dot class: the legend row's tool dots, the
// dialog's current-run rows and the dialog's definitions all call
// provDotClass(), so the definition dot IS the row dot, byte for byte.
// 'replay' never appears in the definitions list (it is a re-run artifact,
// not a source verdict) but a row can still report it, so it lives here.
const PROVENANCE_DOT_CLASS = {
  live: 'live',
  scripted: 'scripted',
  fallback: 'fallback',
  synthetic: 'synthetic',
  'not consulted': 'notconsulted',
  replay: 'replay',
};

// Build-time guard: a new vocabulary entry without a paint is a build error,
// not a silently gray dot.
for (const h of PROVENANCE_HELP) {
  if (!PROVENANCE_DOT_CLASS[h.state]) {
    throw new Error(`PROVENANCE_DOT_CLASS is missing a dot class for state '${h.state}'`);
  }
}

/** The dialog's closing line — where these labels live in the text itself. */
export const PROVENANCE_CLOSING =
  'Every tool sentence carries its own [source: …] label — the map never hides where data came from.';

/** The honesty rule the whole demo is built on. Landing-only (static philosophy). */
export const PROVENANCE_PHILOSOPHY =
  'The rule everywhere: the label names what actually happened. A desk that can\'t reach a source '
  + 'says so, and data that was invented is never passed off as real.';

/** A worked example of the `synthetic` dot — it belongs beside the definition. */
export const PROVENANCE_EXAMPLE =
  'The trip advisor\'s crowd estimate is always synthetic — modeled, never measured — and always says so.';

/**
 * THE server-side twin of the browser's provDotClass(). The landing's guide is
 * rendered at BUILD time, so it needs the same table the page script gets —
 * this is the one function that gives it, and it reads the same object.
 * Exported because the BYOK landing (lib/byok-page.js) paints its cards and its
 * guide at build time too, and must not invent a second mapping.
 */
export const provDotClass = (state) => `cd-dot ${PROVENANCE_DOT_CLASS[state] || 'unknown'}`;

/**
 * THE verdicts a build of the local gallery can honestly produce — the fact
 * `dotState()` already encodes for the landing's static dots, widened to what a
 * DESK in that build can report once a reply exists (a source it could not reach
 * → `fallback`; a source this turn didn't use → `not consulted`).
 *
 * Both surfaces of a build read it, so neither can name a verdict the build
 * cannot produce: the landing's guide (which defines the words) and the desk's
 * dialog (whose tooltips explain the word a turn actually reported). A mock
 * build calls nothing, so `live` and `fallback` are impossible; a live build
 * runs the real fetchers, so `scripted` is.
 *
 * `replay` is deliberately absent — it is a re-run artifact, not a source
 * verdict, which is why PROVENANCE_HELP has no entry for it either. The BYOK
 * bundle keeps its own list (BYOK_STATES) for the same reason: every tool there
 * is a real browser fetcher, so nothing on it is ever scripted.
 */
export const statesForBuild = (live) => (live
  ? ['live', 'fallback', 'synthetic', 'not consulted']
  : ['scripted', 'synthetic', 'not consulted']);

/**
 * The legend + its explanation dialog, as CSS. Imported by BOTH page shells so
 * the two desks cannot drift apart on paint either.
 */
export const PROVENANCE_CSS = `
  /* legend — active entity + per-tool provenance dots */
  .cd-legend { margin: 0 0 12px; padding: 8px 13px; border-radius: 9px;
    background: var(--soft); border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .cd-legend-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
  .cd-legend .cd-entity { font-weight: 700; color: var(--accent); }
  .cd-legend .cd-leg-item { display: inline-flex; align-items: center; gap: 5px; }

  /* "ⓘ what do these mean?" — the only always-visible explanation control.
     There is no glyph key row: the dots explain themselves in the dialog. */
  .cd-help-btn { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 11.5px;
    font-weight: 600; color: var(--muted); background: var(--bg); border: 1px solid var(--line);
    border-radius: 999px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
  .cd-help-btn:hover, .cd-help-btn[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); }
  .cd-help-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* the explanation dialog — quiet, light, same skin as the desk */
  .cd-modal-backdrop { position: fixed; inset: 0; background: rgba(30,22,14,.34); z-index: 60; }
  .cd-modal { position: fixed; z-index: 61; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(520px, calc(100vw - 32px)); max-height: min(80vh, 660px);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 18px 48px rgba(40,30,20,.18); }
  .cd-modal:focus { outline: none; }
  .cd-modal-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 12px 10px 11px 16px; border-bottom: 1px solid var(--line); }
  .cd-modal-title { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--accent); }
  .cd-modal-close { background: none; border: none; cursor: pointer; font-size: 20px; line-height: 1;
    color: var(--muted); padding: 3px 9px; border-radius: 7px; }
  .cd-modal-close:hover { background: var(--soft); color: var(--ink); }
  .cd-modal-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .cd-modal-body { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 13px 16px 16px;
    font-size: 12.5px; line-height: 1.55; color: var(--muted); }
  .cd-modal-sec + .cd-modal-sec { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); }
  .cd-modal-sec h3 { margin: 0 0 8px; font-size: 12px; font-weight: 700; color: var(--ink);
    letter-spacing: .01em; }
  .cd-help-item { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 7px;
    overflow-wrap: anywhere; }
  .cd-help-item .cd-dot { margin-top: 5px; }
  .cd-help-item b { color: var(--ink); }
  .cd-help-none { margin: 0; font-style: italic; }
  .cd-help-foot { margin: 10px 0 0; padding-top: 9px; border-top: 1px solid var(--line); }
  /* desk mode: the vocabulary is not in the dialog — this is the way to it */
  a.cd-help-guide { display: block; color: var(--muted); font-weight: 600; text-decoration: none; }
  a.cd-help-guide:hover { color: var(--accent); }
  a.cd-help-guide:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  /* narrow screens: the dialog becomes a bottom sheet, full width, no overflow */
  @media (max-width: 520px) {
    .cd-modal { top: auto; bottom: 0; left: 0; transform: none; width: 100%; max-width: 100%;
      max-height: 86vh; border-radius: 14px 14px 0 0; border-left: 0; border-right: 0; border-bottom: 0; }
  }
`;

/**
 * The browser-side twin of the vocabulary above, plus the ONE legend component
 * both pages render. Emitted into the page script; nothing here is forked.
 *
 * ONE component, two modes — the split is information architecture, not code:
 *   defs: true  (BYOK) — a visitor arrives cold at a public URL with no landing
 *     behind them, so the vocabulary must be reachable without leaving the tab.
 *   defs: false (desks) — the desk is the stage: the dialog carries only what is
 *     true right now (this reply's sources) and links out to the landing's
 *     `#guide`, which is rendered from THIS SAME table.
 *
 * @param states     the provenance verdicts this page can honestly show
 * @param opts.defs  render the "what each dot means" section + closing line
 * @param opts.guideHref  a JS EXPRESSION (evaluated in the page) for the guide
 *   link's href. Required when defs is false — a desk that hides the vocabulary
 *   without pointing at it is a build error, not a quiet omission.
 */
export const provenanceHelpScript = (states, { defs = true, guideHref = null } = {}) => {
  if (!defs && !guideHref) {
    throw new Error('provenanceHelpScript({ defs: false }) needs a guideHref — the vocabulary must stay reachable');
  }
  const helpFoot = defs
    ? `React.createElement('section', { className: 'cd-modal-sec', 'data-testid': 'legend-help-defs' },
          React.createElement('h3', null, 'What each dot means'),
          PROV_HELP.map(function (h) {
            return React.createElement('div', { key: h.state, className: 'cd-help-item' },
              provDot(h.state),
              React.createElement('span', null,
                React.createElement('b', null, h.label), ' — ', h.what));
          }),
          React.createElement('p', { className: 'cd-help-foot' }, PROV_CLOSING))`
    : `React.createElement('a', { className: 'cd-help-foot cd-help-guide',
          'data-testid': 'legend-help-guide-link', href: ${guideHref},
          // A NEW TAB, deliberately. The desk's HTML is built once at boot with
          // its sessions baked in, so a same-tab trip to the guide and back
          // re-serves the boot snapshot and silently truncates the conversation
          // on screen while the server session keeps every turn. Reading the
          // program notes must never cost the visitor the show.
          target: '_blank', rel: 'noopener',
          title: 'Opens the gallery guide in a new tab — this conversation stays open here' },
          'How to read these dots → the gallery guide')`;
  return `
// ─── generated from lib/page.js — do not hand-edit in a page shell ──────────
// The legend's plain-words vocabulary, its state→dot paint, and the legend
// component itself all come from here, so the desk pages and the BYOK page
// render the SAME DOM with the SAME classes.
// PROV_HELP stays in both modes — the legend's own tooltips are built from the
// same explanations, and a tooltip is runtime (it names THIS reply's verdict).
var PROV_HELP = ${JSON.stringify(PROVENANCE_HELP.filter((h) => states.includes(h.state)))};
${defs ? `var PROV_CLOSING = ${JSON.stringify(PROVENANCE_CLOSING)};` : '// the closing line is static philosophy — it lives on the gallery guide'}
var PROV_DOT_CLASS = ${JSON.stringify(PROVENANCE_DOT_CLASS)};
var PROV_WORDS = {};
PROV_HELP.forEach(function (h) { PROV_WORDS[h.state] = h.what; });

/** THE state→class function. Every dot on the page is painted through it. */
function provDotClass(state) {
  return 'cd-dot ' + (PROV_DOT_CLASS[state] || 'unknown');
}

/** THE dot element. One call site shape ⇒ the legend row and the dialog agree. */
function provDot(state) {
  return React.createElement('span', { className: provDotClass(state) });
}

/**
 * "live: real data fetched from the internet just now (…)" — no tool name.
 *
 * @param detail  the sentence's OWN "[source: …]" text for THIS turn, when the
 *   turn recorded one (lib/mcp.js sourceLabelsFromToolLog). The verdict is the
 *   word; this is the reason behind it — "synthetic fallback — HTTP 404" — and
 *   without it a hollow fallback dot is a dead end for anyone not reading code.
 */
function provBody(tool, p, detail) {
  var body = p
    ? p + (PROV_WORDS[p] ? ': ' + PROV_WORDS[p] : '')
    : 'not used yet: waiting for the first reply';
  if (tool.alwaysSynthetic && p !== 'synthetic') {
    body += ' · this source is always synthetic by design — modeled, never measured';
  }
  if (detail) body += ' · this reply: ' + detail;
  return body;
}

/** "wiki_plot — live: real data fetched from the internet just now (…)" */
function provTitle(tool, p, detail) {
  return tool.name + ' — ' + provBody(tool, p, detail);
}

var PROV_FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The explanation dialog. The first section is always what THIS reply actually
 * used; what follows depends on the mode this script was generated in — the
 * definitions themselves (BYOK) or a link to the landing's guide (desks). Both
 * paint their dots with provDotClass(), so a definition dot is literally the
 * same element as the row dot.
 *
 * Accessibility: role=dialog + aria-modal, focus moves in on open, Tab is
 * trapped, Escape / backdrop / × all close, and the caller returns focus to
 * the ⓘ button that opened it.
 */
function ProvHelpModal(props) {
  var boxRef = React.useRef(null);
  // The latest onClose, so the once-only key listener never calls a stale one.
  var closeRef = React.useRef(props.onClose);
  closeRef.current = props.onClose;

  React.useEffect(function () {
    var box = boxRef.current;
    if (box) box.focus();
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); closeRef.current(); return; }
      if (ev.key !== 'Tab' || !box) return;
      var items = Array.prototype.slice.call(box.querySelectorAll(PROV_FOCUSABLE))
        .filter(function (el) { return !el.disabled && el.getClientRects().length > 0; });
      if (!items.length) { ev.preventDefault(); box.focus(); return; }
      var first = items[0];
      var last = items[items.length - 1];
      var here = document.activeElement;
      var inside = box.contains(here) && here !== box;
      if (ev.shiftKey) {
        if (!inside || here === first) { ev.preventDefault(); last.focus(); }
      } else if (!inside || here === last) { ev.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    return function () { document.removeEventListener('keydown', onKey, true); };
  }, []);

  var tools = props.tools || [];
  var prov = props.provenance || null;
  var labels = props.sourceLabels || null;
  var sources = prov
    ? tools.map(function (t) {
        var p = prov[t.name];
        return React.createElement('div', { key: t.name, className: 'cd-help-item',
            'data-testid': 'legend-help-source-' + t.name },
          provDot(p),
          React.createElement('span', null,
            React.createElement('b', null, t.name), ' — ', provBody(t, p, labels && labels[t.name])));
      })
    : React.createElement('p', { className: 'cd-help-none', 'data-testid': 'legend-help-noreply' },
        'no reply yet — sources appear here after you ask something');

  return React.createElement('div', { className: 'cd-modal-wrap' },
    React.createElement('div', { className: 'cd-modal-backdrop', 'data-testid': 'legend-help-backdrop',
      onClick: function () { closeRef.current(); } }),
    React.createElement('div', { className: 'cd-modal', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'cd-legend-help-title', id: 'cd-legend-help', 'data-testid': 'legend-help',
        tabIndex: -1, ref: boxRef },
      React.createElement('div', { className: 'cd-modal-head' },
        React.createElement('h2', { className: 'cd-modal-title', id: 'cd-legend-help-title' },
          'Where this reply’s data came from'),
        React.createElement('button', { type: 'button', className: 'cd-modal-close',
          'data-testid': 'legend-help-close', 'aria-label': 'close',
          onClick: function () { closeRef.current(); } }, '×')),
      React.createElement('div', { className: 'cd-modal-body' },
        React.createElement('section', { className: 'cd-modal-sec', 'data-testid': 'legend-help-sources' },
          React.createElement('h3', null, 'This reply’s sources'),
          sources),
        ${helpFoot})));
}

/**
 * The legend: the entity line, the per-tool dots (with their tooltips), and the
 * quiet ⓘ control. Both page shells render THIS — there is no second copy.
 *
 * @param props.entityLabel/entityValue  the "Trail: Mission Peak" line
 * @param props.tools        the pack's page-safe tool descriptors
 * @param props.provenance   the newest turn's verdict map, or null before one
 */
function ProvLegend(props) {
  var o0 = React.useState(false);
  var open = o0[0];
  var setOpen = o0[1];
  var btnRef = React.useRef(null);
  function close() {
    setOpen(false);
    // Focus returns to the control that opened the dialog.
    if (btnRef.current) btnRef.current.focus();
  }
  var tools = props.tools || [];
  var prov = props.provenance || null;
  var labels = props.sourceLabels || null;
  return React.createElement('div', { className: 'cd-legend', 'data-testid': 'tool-legend' },
    React.createElement('div', { className: 'cd-legend-row' },
      React.createElement('span', { className: 'cd-entity' }, props.entityLabel + ': ' + props.entityValue),
      tools.map(function (t) {
        var p = prov && prov[t.name];
        return React.createElement('span', { key: t.name, className: 'cd-leg-item',
            'data-testid': 'leg-item-' + t.name,
            title: provTitle(t, p, labels && labels[t.name]) },
          provDot(p), t.legendLabel + (p ? '' : ' —'));
      }),
      React.createElement('button', { type: 'button', className: 'cd-help-btn', ref: btnRef,
        'data-testid': 'legend-help-toggle', 'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'cd-legend-help',
        onClick: function () { setOpen(true); } },
        React.createElement('span', { 'aria-hidden': 'true' }, 'ⓘ'), 'what do these mean?')),
    open ? React.createElement(ProvHelpModal, { tools: tools, provenance: prov,
      sourceLabels: labels, onClose: close }) : null);
}
`;
};

/**
 * The debug view's paint. ONE copy, worn by the desk pages and the BYOK page —
 * the same dialog, the same two tabs, the same trace rows.
 *
 * The dialog is deliberately big (this is a workbench, not a tooltip) and goes
 * full-screen below 720px. It carries no transitions of its own, so there is
 * nothing here for reduced motion to switch off; the player inside brings its
 * own reduced-motion rules (agentthinkingui/styles.css).
 */
export const DEBUG_CSS = `
  /* the quiet entry — one small control in the top bar, nothing else */
  .cd-debugbtn { font: inherit; font-size: 11.5px; font-weight: 600; color: var(--muted);
    background: var(--bg); border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 10px; cursor: pointer; white-space: nowrap; }
  .cd-debugbtn:hover, .cd-debugbtn[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); }
  .cd-debugbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cd-debugbtn:disabled { opacity: .45; cursor: not-allowed; }

  .cd-dbg { position: fixed; z-index: 61; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(1060px, calc(100vw - 32px)); height: min(84vh, 820px);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 18px 48px rgba(40,30,20,.18); }
  .cd-dbg:focus { outline: none; }
  .cd-dbg-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 11px 10px 11px 16px; border-bottom: 1px solid var(--line); }
  .cd-dbg-title { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--accent); }
  .cd-dbg-turn { margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; color: var(--muted); }
  .cd-dbg-turn select { font: inherit; font-size: 11.5px; padding: 3px 7px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); max-width: 46vw; }
  .cd-dbg-tabs { flex: 0 0 auto; display: flex; gap: 6px; padding: 9px 16px 0; }
  .cd-dbg-tab { font: inherit; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 999px;
    cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--muted); }
  .cd-dbg-tab[aria-selected="true"] { background: var(--accent); border-color: var(--accent-dk); color: #fff; }
  .cd-dbg-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cd-dbg-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 16px 16px; }
  .cd-dbg-body:focus { outline: none; }
  /* the player owns its panel: it lays itself out to the height it is given */
  .cd-dbg-body.player { overflow: hidden; padding: 0; }
  .cd-dbg-player { height: 100%; min-height: 380px; }

  /* ── the two library views (agentfootprint-lens · footprint-explainable-ui) ──
     They own their panel exactly as the player does, and they must be given a
     REAL height: the flowchart is a canvas, and a canvas in an auto-height box
     measures zero and draws nothing. Both ship their own (dark) styling; the
     one stylesheet either of them needs is @xyflow/react's, loaded beside the
     bundle and scoped entirely under .react-flow. */
  .cd-dbg-body.devview { overflow: hidden; padding: 0; display: flex; flex-direction: column; }
  .cd-dbg-dev { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .cd-dbg-devnote { flex: 0 0 auto; margin: 0; padding: 7px 16px 8px; font-size: 11px; line-height: 1.5;
    color: var(--muted); background: var(--soft); border-bottom: 1px solid var(--line); }
  .cd-dbg-devwait { padding: 26px 16px; font-size: 12.5px; line-height: 1.6; color: var(--muted); font-style: italic; }
  .cd-dbg-foot { flex: 0 0 auto; padding: 8px 16px 10px; border-top: 1px solid var(--line);
    font-size: 11.5px; line-height: 1.5; color: var(--muted); }

  /* the only state the dialog draws itself: nothing to show, said plainly */
  .cd-tr-empty { font-size: 12.5px; line-height: 1.6; color: var(--muted); font-style: italic; }

  @media (max-width: 720px) {
    /* phone: the workbench is the screen */
    .cd-dbg { top: 0; left: 0; transform: none; width: 100%; height: 100%; max-height: 100%;
      border-radius: 0; border: 0; }
    /* two rows, not three: the title keeps the × beside it and the turn picker
       takes the full second line, where a long question has room to be read */
    .cd-dbg-head .cd-dbg-title { flex: 1 1 auto; }
    .cd-dbg-head .cd-modal-close { order: 2; }
    .cd-dbg-turn { order: 3; margin-left: 0; flex: 1 1 100%; }
    .cd-dbg-turn select { max-width: 100%; flex: 1 1 auto; }

    /* THE FLOWCHART NEEDS ROOM, NOT A SMALLER SHARE OF NONE.
       agentfootprint-lens lays itself out in two columns; on a phone the chart
       column is squeezed to zero, and a canvas with no width draws nothing —
       a visitor gets an empty box instead of the chart. So give the view the
       width it was designed for and let the panel pan sideways: the chart is
       there, in full, one drag away. The inspector lays out fine narrow and is
       left alone. */
    .cd-dbg-dev[data-testid="debug-view-flowchart"] { overflow-x: auto; overflow-y: hidden;
      -webkit-overflow-scrolling: touch; }
    .cd-dbg-dev[data-testid="debug-view-flowchart"] > * { min-width: 900px; min-height: 100%; }
  }
`;

/**
 * The debug view, as a browser component — generated ONCE here and embedded by
 * both page shells, so the desks and the BYOK page render the same dialog.
 *
 * THREE VIEWS OVER ONE RECORDED TURN, and only the first one is ours:
 *
 *   story      agentthinkingui's player over the trace agentfootprint's OWN
 *              recorder built from this turn's events (lib/debug-view.js).
 *   flowchart  agentfootprint-lens's `Lens` — the agent debugger its library
 *              ships, driven by replaying this turn's recorded event log into a
 *              real LensRecorder.
 *   inspector  footprint-explainable-ui's `ExplainableShell` — footprintjs's
 *              own inspector, reading this turn's frozen run snapshot.
 *
 * The last two are the ecosystem's real developer tools, unmodified: a visitor
 * who wants to know what happened is looking at the same screens the people who
 * build these libraries look at. They are lazily loaded (`dbgLoadViews`) and
 * lazily fed (`load`, the page shell's transport) — a desk that is only chatted
 * with never fetches either.
 *
 * `storageKey: null` switches off the player's own scrub-position persistence,
 * which would otherwise be the one thing on the page that writes to
 * localStorage.
 *
 * Emit it AFTER provenanceHelpScript — the story's tool rows paint their dots
 * with that script's provDot(), so the same verdict is the same dot everywhere.
 */
export const debugModalScript = () => `
// ─── generated from lib/page.js — do not hand-edit in a page shell ──────────
var DBG_FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
var DBG_FOOT = 'Everything here is read from this turn\\u2019s own recording. Opening it called no model, '
  + 'ran no tool and stored nothing \\u2014 the only requests it can make go to this site, for the recording '
  + 'it is showing you and the two view files that draw it.';

// ═══ THE TWO LIBRARY VIEWS ══════════════════════════════════════════════════
// One vendored browser file (built by dev-views/build.mjs) carrying
// agentfootprint-lens and footprint-explainable-ui, on the React instance this
// page already registered. It is fetched the FIRST time a visitor opens a view
// that needs it, once per page, and never on load.
var DBG_VIEWS = null;
var DBG_VIEWS_LOADING = null;

function dbgLoadViews(src) {
  if (DBG_VIEWS) return Promise.resolve(DBG_VIEWS);
  if (DBG_VIEWS_LOADING) return DBG_VIEWS_LOADING;
  DBG_VIEWS_LOADING = new Promise(function (resolve, reject) {
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = src.css;
    document.head.appendChild(css);
    var js = document.createElement('script');
    js.src = src.js;
    js.async = true;
    js.onload = function () {
      if (!window.VRDevViews) { reject(new Error('the view file loaded but registered nothing')); return; }
      DBG_VIEWS = window.VRDevViews;
      resolve(DBG_VIEWS);
    };
    js.onerror = function () { reject(new Error('the view file could not be loaded from ' + src.js)); };
    document.head.appendChild(js);
  });
  return DBG_VIEWS_LOADING;
}

// The turn's recording, once per turn per page. A recording never changes, so
// a second look at the same turn costs nothing; a failed read is not cached.
var DBG_ART = {};
function dbgArtifacts(key, k, load) {
  var id = key + ':' + k;
  if (!DBG_ART[id]) {
    DBG_ART[id] = Promise.resolve().then(function () { return load(k); }).catch(function (err) {
      delete DBG_ART[id];
      throw err;
    });
  }
  return DBG_ART[id];
}

/**
 * A LensRecorder fed by REPLAY. The recorder is agentfootprint-lens's own,
 * unmodified; it expects to observe a live runner, so it is given one whose
 * only job is subscription plumbing — every byte it then reports comes from
 * \`artifacts.events\` (the recorded log, in recorded order) and
 * \`artifacts.snapshot\` (the frozen run). The blueprint, when the recording
 * carries one, is the agent's own build-time structure, so the chart is the
 * composition that actually ran rather than one inferred from what it did.
 */
function dbgLensModel(views, artifacts) {
  var rec = new views.lens.LensRecorder();
  var subs = [];
  var runner = {
    on: function (type, handler) { subs.push({ type: type, handler: handler }); return function () {}; },
    attach: function () { return function () {}; },
    enable: { flowchart: function () {
      return { getSnapshot: function () { return undefined; }, unsubscribe: function () {} };
    } },
    getLastSnapshot: function () { return artifacts.snapshot; },
    getSpec: function () { return { buildTimeStructure: artifacts.blueprint }; },
  };
  rec.observe(runner);
  var events = artifacts.events || [];
  var skipped = 0;
  events.forEach(function (ev) {
    var lost = false;
    for (var i = 0; i < subs.length; i += 1) {
      if (subs[i].type !== '*' && subs[i].type !== ev.type) continue;
      // footprintjs's own invariant, kept on the replay rail: a recorder that
      // throws never aborts the run feeding it. A replay IS that run played
      // back, so one event this debugger cannot read costs that event and
      // nothing else — it is skipped, counted, and the panel says how many.
      try { subs[i].handler(ev); } catch (err) { lost = true; }
    }
    if (lost) skipped += 1;
  });
  var stepGraph = null;
  try { stepGraph = views.lens.buildStepGraphFromSnapshot(artifacts.snapshot); } catch (err) { stepGraph = null; }
  return { recorder: rec, stepGraph: stepGraph, runner: artifacts.blueprint ? runner : null,
    skipped: skipped, total: events.length };
}

/**
 * The same model, built where a failure is survivable.
 *
 * The model is BUILT during render, not rendered — so a throw from it lands
 * ABOVE DbgBoundary (which only catches what a view throws while drawing), and
 * in React 19 an uncaught error there unmounts the whole desk. A visitor who
 * opens a view over an unreadable recording must lose the view, never the desk.
 */
function dbgLensSafe(views, artifacts) {
  try { return { model: dbgLensModel(views, artifacts), error: null }; }
  catch (err) { return { model: null, error: err }; }
}

/** The pane's one honest failure note, worded once and used wherever it is true. */
function dbgUnreadable(err) {
  return React.createElement('p', { className: 'cd-dbg-devwait', 'data-testid': 'debug-view-error' },
    'The recording could not be read: '
    + (err && err.message ? err.message : String(err))
    + '. The story view reads the same turn and is unaffected.');
}

/** A view that throws must not take the desk with it. */
function DbgBoundary(props) { React.Component.call(this, props); this.state = { error: null }; }
DbgBoundary.prototype = Object.create(React.Component.prototype);
DbgBoundary.prototype.constructor = DbgBoundary;
DbgBoundary.getDerivedStateFromError = function (error) { return { error: error }; };
DbgBoundary.prototype.render = function () {
  if (this.state.error) {
    return React.createElement('p', { className: 'cd-dbg-devwait', 'data-testid': 'debug-view-error' },
      'This view could not render this recording: '
      + (this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error))
      + '. The story view reads the same turn and is unaffected.');
  }
  return this.props.children;
};

/**
 * One of the two library views, over one recorded turn.
 *
 * Both need the same two things — the view file and the turn's recording — so
 * they share this component and switching tabs re-renders rather than re-loads.
 * Every honest limit below is stated in the panel itself, not here.
 */
function DbgDevPane(props) {
  var s0 = React.useState({ phase: 'loading', views: null, art: null, error: null });
  var st = s0[0], setSt = s0[1];
  var key = props.cacheKey;
  var k = props.turnIndex;
  var src = props.src;
  var hasLoad = !!props.load;
  // The desk re-renders on every keystroke of a live turn, and its transport
  // closure is new each time. Held in a ref so identity churn cannot re-enter
  // this effect and blank a view a visitor is reading; only WHICH turn (or
  // whether a transport exists at all) does.
  var loadRef = React.useRef(props.load);
  loadRef.current = props.load;

  React.useEffect(function () {
    if (!hasLoad) { setSt({ phase: 'no-transport', views: null, art: null, error: null }); return undefined; }
    var alive = true;
    setSt({ phase: 'loading', views: null, art: null, error: null });
    Promise.all([dbgLoadViews(src), dbgArtifacts(key, k, loadRef.current)]).then(function (both) {
      if (!alive) return;
      if (!both[1] || !both[1].snapshot) {
        setSt({ phase: 'empty', views: null, art: null, error: null });
        return;
      }
      setSt({ phase: 'ready', views: both[0], art: both[1], error: null });
    }, function (err) {
      if (!alive) return;
      setSt({ phase: 'error', views: null, art: null, error: err });
    });
    return function () { alive = false; };
  }, [hasLoad, key, k, src]);

  var lens = React.useMemo(function () {
    if (st.phase !== 'ready' || props.kind !== 'flowchart') return null;
    return dbgLensSafe(st.views, st.art);
  }, [st.phase, st.views, st.art, props.kind]);

  // The inspector's chart, from the SAME recorded blueprint — lens owns the
  // bridge between the two vocabularies, and \`decorate: false\` is its
  // footprintjs-level view (plain stages and subflows, no agent semantics),
  // which is what this shell is a renderer for. No runtime overlay is passed:
  // the stage-by-stage colouring is recorded only by a live attach, so the
  // chart shows the structure and the timeline beside it shows the execution.
  var chart = React.useMemo(function () {
    if (st.phase !== 'ready' || props.kind !== 'inspector' || !st.art.blueprint) return null;
    // WHY the console is narrowed for exactly this call: the bridge walks lens's
    // structure into explainable-ui's structure recorder, and the two disagree
    // about when a subflow's MOUNT NODE is announced — so eui warns "unknown
    // rootStageId" once per subflow and drops metadata this chart does not use.
    // That is a library-level contract gap (agentfootprint-lens <-> footprint-
    // explainable-ui) and the fix belongs there; until then this hides exactly
    // that one message, for exactly this one synchronous call, and restores the
    // console whatever happens. Every other warning still reaches the console.
    var warn = console.warn;
    var KNOWN = '[traceStructureRecorder] onSubflowMounted fired for unknown rootStageId';
    console.warn = function (first) {
      if (typeof first === 'string' && first.indexOf(KNOWN) === 0) return;
      warn.apply(console, arguments);
    };
    try { return st.views.lens.structureGraphFromSpec(st.art.blueprint, { decorate: false }); }
    catch (err) { return null; }
    finally { console.warn = warn; }
  }, [st.phase, st.views, st.art, props.kind]);

  if (st.phase === 'no-transport') {
    return React.createElement('p', { className: 'cd-dbg-devwait', 'data-testid': 'debug-view-noserver' },
      'These two views read the turn\\u2019s full recording, and this page has no way to reach it '
      + '\\u2014 it was opened as a file. Run the gallery locally and they work; the story view above '
      + 'needs nothing, because its data arrived with the reply.');
  }
  if (st.phase === 'loading') {
    return React.createElement('p', { className: 'cd-dbg-devwait', 'data-testid': 'debug-view-loading' },
      'Loading this turn\\u2019s recording and the view that draws it\\u2026');
  }
  if (st.phase === 'empty') {
    return React.createElement('p', { className: 'cd-dbg-devwait', 'data-testid': 'debug-view-empty' },
      'This turn carries no run snapshot, so there is nothing for these views to read.');
  }
  if (st.phase === 'error') return dbgUnreadable(st.error);
  // The recording arrived but this debugger could not be built from it. Same
  // phase, same words: the view is gone, the desk and the story are not.
  if (lens && lens.error) return dbgUnreadable(lens.error);

  var V = st.views;
  var note;
  var body;
  if (props.kind === 'flowchart') {
    // Stated because it is true: the step strip and the moments rail are driven
    // by boundary COMMIT RANGES, which only a live attach records. Everything
    // else on this screen — chart, summary, event stream, commentary — is this
    // turn's recording.
    var m = lens.model;
    note = 'agentfootprint-lens \\u2014 the agent debugger its library ships, reading this turn\\u2019s '
      + 'recorded event log and run snapshot. The step scrubber and the moments rail stay quiet here: '
      + 'they need commit ranges that only a live attach records, and nothing on this page invents them.';
    // Said because it happened: a replayed event the debugger could not read is
    // dropped, and a count is the honest way to show what is missing.
    if (m.skipped) {
      note += ' ' + m.skipped + ' of this turn\\u2019s ' + m.total + ' recorded events could not be read '
        + 'by it and were skipped \\u2014 what is drawn here is the rest of them.';
    }
    var lensProps = {
      recorder: m.recorder,
      view: 'engineer',
      appName: props.appName || 'This desk',
    };
    if (m.stepGraph) lensProps.stepGraph = m.stepGraph;
    if (m.runner) lensProps.runner = m.runner;
    body = React.createElement(V.lens.Lens, lensProps);
  } else {
    note = 'footprint-explainable-ui \\u2014 footprintjs\\u2019s own inspector, over the run snapshot '
      + 'recordedChat froze on this turn: every stage in order, a transport to step through them, and the '
      + 'state each one left behind (right panel \\u2192 INSPECTOR). The chart is this agent\\u2019s own '
      + 'build-time structure; it is not lit stage by stage, because that colouring is recorded only while '
      + 'a run is happening. \\u201cInsights\\u201d is empty for the same honest reason \\u2014 this run '
      + 'attached no extra recorders.';
    body = React.createElement(V.eui.ExplainableShell, {
      runtimeSnapshot: st.art.snapshot,
      traceGraph: chart,
      title: props.title || 'this turn',
      // Narrative is honestly absent (this run attached no narrative recorder);
      // naming it here keeps an empty tab from claiming otherwise.
      hideTabs: ['narrative'],
      defaultExpanded: { details: true, timeline: true },
    });
  }

  return React.createElement(React.Fragment, null,
    React.createElement('p', { className: 'cd-dbg-devnote', 'data-testid': 'debug-view-note-' + props.kind }, note),
    React.createElement('div', { className: 'cd-dbg-dev', 'data-testid': 'debug-view-' + props.kind },
      React.createElement(DbgBoundary, null, body)));
}

/**
 * The dialog. THREE views over ONE recorded turn: the story (agentthinkingui's
 * player over the trace agentfootprint's own recorder built from this turn's
 * events), the flowchart (agentfootprint-lens) and the inspector
 * (footprint-explainable-ui). The first arrived with the reply; the other two
 * load themselves, and the recording they read, on first open.
 *
 * Accessibility: role=dialog + aria-modal, focus moves in on open, Tab is
 * trapped, Escape / backdrop / \\u00d7 all close, and the caller returns focus
 * to the control that opened it.
 */
function DebugModal(props) {
  var boxRef = React.useRef(null);
  var closeRef = React.useRef(props.onClose);
  closeRef.current = props.onClose;
  var turns = props.turns || [];
  var v0 = React.useState('story'); var view = v0[0], setView = v0[1];
  // Newest turn by default — the one a visitor just watched go wrong.
  var k0 = React.useState(turns.length ? turns[turns.length - 1].index : 0);
  var pick = k0[0], setPick = k0[1];

  React.useEffect(function () {
    var box = boxRef.current;
    if (box) box.focus();
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); closeRef.current(); return; }
      if (ev.key !== 'Tab' || !box) return;
      var items = Array.prototype.slice.call(box.querySelectorAll(DBG_FOCUSABLE))
        .filter(function (el) { return !el.disabled && el.getClientRects().length > 0; });
      if (!items.length) { ev.preventDefault(); box.focus(); return; }
      var first = items[0];
      var last = items[items.length - 1];
      var here = document.activeElement;
      var inside = box.contains(here) && here !== box;
      if (ev.shiftKey) {
        if (!inside || here === first) { ev.preventDefault(); last.focus(); }
      } else if (!inside || here === last) { ev.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    return function () { document.removeEventListener('keydown', onKey, true); };
  }, []);

  var turn = null;
  for (var i = 0; i < turns.length; i += 1) if (turns[i].index === pick) turn = turns[i];
  if (!turn && turns.length) turn = turns[turns.length - 1];
  var dbg = turn && turn.debug;

  var tab = function (id, label) {
    return React.createElement('button', { type: 'button', key: id, role: 'tab',
      className: 'cd-dbg-tab', id: 'cd-dbg-tab-' + id, 'data-testid': 'debug-tab-' + id,
      'aria-selected': view === id ? 'true' : 'false', 'aria-controls': 'cd-dbg-panel',
      onClick: function () { setView(id); } }, label);
  };

  var body;
  if (!dbg) {
    body = React.createElement('p', { className: 'cd-tr-empty', 'data-testid': 'debug-empty' },
      turns.length
        ? 'This turn was recorded before the debug view existed, so there is nothing to replay for it.'
        : 'Nothing has been asked yet \\u2014 there is no recorded turn to look inside.');
  } else if (view === 'story') {
    body = React.createElement('div', { className: 'cd-dbg-player', 'data-testid': 'debug-story' },
      React.createElement(AgentThinkingUI, {
        trace: dbg.story,
        // the rack shows every tool the model SAW on that call, the asked-for one
        // lit — the menu, next to the reasoning, which is the whole question here
        toolMenu: 'rack',
        // no persistence: the one thing on this page that would write to storage
        storageKey: null,
        mobile: props.narrow,
        style: { height: '100%' },
      }));
  } else {
    // Same component for both library views: they need the same two loads, so
    // switching between them re-renders instead of re-fetching, and React
    // unmounts the view being left on its own.
    body = React.createElement(DbgDevPane, {
      kind: view,
      turnIndex: turn.index,
      load: props.loadArtifacts || null,
      cacheKey: props.artifactsKey || 'turn',
      src: props.devViews,
      appName: props.appName,
      title: 'turn ' + (turn.index + 1) + ' \\u2014 ' + turn.userMessage,
    });
  }
  var devview = dbg && (view === 'flowchart' || view === 'inspector');

  return React.createElement('div', { className: 'cd-dbg-wrap' },
    React.createElement('div', { className: 'cd-modal-backdrop', 'data-testid': 'debug-backdrop',
      onClick: function () { closeRef.current(); } }),
    React.createElement('div', { className: 'cd-dbg', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'cd-dbg-title', id: 'cd-debug', 'data-testid': 'debug-modal',
        tabIndex: -1, ref: boxRef },
      React.createElement('div', { className: 'cd-dbg-head' },
        React.createElement('h2', { className: 'cd-dbg-title', id: 'cd-dbg-title' },
          'What actually happened'),
        turns.length > 1
          ? React.createElement('label', { className: 'cd-dbg-turn' }, 'turn',
              React.createElement('select', { 'data-testid': 'debug-turn', value: String(pick),
                onChange: function (ev) { setPick(Number(ev.target.value)); } },
                turns.map(function (t) {
                  return React.createElement('option', { key: t.index, value: String(t.index) },
                    (t.index + 1) + ' \\u00b7 ' + t.userMessage);
                })))
          : null,
        React.createElement('button', { type: 'button', className: 'cd-modal-close',
          'data-testid': 'debug-close', 'aria-label': 'close',
          onClick: function () { closeRef.current(); } }, '\\u00d7')),
      React.createElement('div', { className: 'cd-dbg-tabs', role: 'tablist',
        'aria-label': 'how to read this turn' },
        tab('story', 'story'), tab('flowchart', 'flowchart'), tab('inspector', 'inspector')),
      React.createElement('div', {
        className: 'cd-dbg-body' + (dbg && view === 'story' ? ' player' : '') + (devview ? ' devview' : ''),
        id: 'cd-dbg-panel', role: 'tabpanel', 'aria-labelledby': 'cd-dbg-tab-' + view,
        tabIndex: -1 }, body),
      React.createElement('p', { className: 'cd-dbg-foot', 'data-testid': 'debug-foot' }, DBG_FOOT)));
}

/**
 * The control in the top bar. Owns the open state and gives focus back to
 * itself on close. Disabled (and honest about it) until a turn exists.
 *
 * The transport props are the page shell's, not this component's business:
 * loadArtifacts(turnIndex) returns the turn's recording (an HTTP GET on the
 * desks, a function call in the tab on BYOK) and devViews says where the two
 * view files live. Both are only ever used inside the dialog.
 */
function DebugControl(props) {
  var o0 = React.useState(false); var open = o0[0], setOpen = o0[1];
  var btnRef = React.useRef(null);
  var narrow = false;
  try { narrow = !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches); } catch (err) {}
  var turns = props.turns || [];
  function close() {
    setOpen(false);
    if (btnRef.current) btnRef.current.focus();
  }
  return React.createElement(React.Fragment, null,
    React.createElement('button', { type: 'button', className: 'cd-debugbtn', ref: btnRef,
      'data-testid': 'debug-open', 'aria-haspopup': 'dialog', 'aria-controls': 'cd-debug',
      'aria-expanded': open ? 'true' : 'false', disabled: !turns.length,
      title: turns.length
        ? 'Look inside the last reply: the story it played out, and the two developer views of the run it made'
        : 'Nothing has been asked yet',
      onClick: function () { setOpen(true); } }, 'debug'),
    open ? React.createElement(DebugModal, {
      turns: turns, narrow: narrow, onClose: close,
      loadArtifacts: props.loadArtifacts, artifactsKey: props.artifactsKey,
      devViews: props.devViews, appName: props.appName,
    }) : null);
}
`;

/**
 * The starter questions, as a control. ONE copy, worn by the desk pages and the
 * BYOK page — same markup, same classes, same behaviour on both transports.
 *
 * TWO SIZES, AND ONLY EVER ONE ON SCREEN. Before the first message the desk has
 * nothing to say except "ask something", so the questions ARE the empty state:
 * big, centered, tappable. From the first turn on they leave the transcript
 * entirely and reappear as a quiet row inside the composer — the chat window
 * keeps carrying runtime information only, and the questions stay one tap away
 * without ever competing with a reply.
 *
 * The compact row is deliberately the muted-chip treatment already used by the
 * ⓘ and debug controls (var(--muted) on var(--bg), 1px --line, no fill), so it
 * reads as composer furniture rather than as a second conversation.
 */
export const STARTERS_CSS = `
  .cd-starters { display: flex; flex-wrap: wrap; }
  .cd-starters button { font: inherit; cursor: pointer; border-radius: 999px; text-align: left;
    max-width: 100%; transition: color .18s ease, border-color .18s ease, background-color .18s ease; }
  .cd-starters button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cd-starters button:disabled { opacity: .5; cursor: not-allowed; }
  @media (prefers-reduced-motion: reduce) { .cd-starters button { transition: none; } }

  /* the empty desk: the one thing to do, in the size of a thing to do */
  .cd-starters.big { gap: 10px; justify-content: center; margin: 20px 0 0; }
  .cd-starters.big button { font-size: 15px; font-weight: 600; line-height: 1.35; padding: 12px 20px;
    color: var(--ink); background: var(--bg); border: 1.5px solid var(--line); }
  .cd-starters.big button:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); background: var(--soft); }

  /* the composer row: quiet, and never wider than the column */
  .cd-starters.compact { gap: 7px; margin: 0 0 9px; }
  .cd-starters.compact button { font-size: 12px; font-weight: 600; padding: 5px 12px;
    color: var(--muted); background: var(--bg); border: 1px solid var(--line);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cd-starters.compact button:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
`;

/**
 * The starter pills, as a browser component — generated ONCE here and embedded
 * by both page shells.
 *
 * The questions are the PACK's own (`app.starters`, carried in the page data by
 * both shells); this component writes no copy of its own and has no fallback
 * list — a pack with no starters renders nothing at all.
 *
 * `onPick` is the shell's own `send()`: the identical function the Send button
 * calls, given the identical argument a typed message produces. A tapped pill is
 * therefore a typed turn in every way that is recorded — it streams, it commits,
 * it gets a visible reason and it can be re-run. There is no second send path.
 */
export const startersScript = () => `
// ─── generated from lib/page.js — do not hand-edit in a page shell ──────────
function Starters(props) {
  var list = props.starters || [];
  if (!list.length) return null;
  var variant = props.variant === 'compact' ? 'compact' : 'big';
  var disabled = !!props.disabled;
  return React.createElement('div', {
      className: 'cd-starters ' + variant, 'data-testid': 'starters-' + variant,
      role: 'group', 'aria-label': 'Starter questions' },
    list.map(function (q, i) {
      return React.createElement('button', {
        key: q, type: 'button', 'data-testid': 'starter-' + variant + '-' + i,
        disabled: disabled,
        // The compact chip may ellipsize on a phone; the full question stays
        // readable on hover and is the button's accessible name either way.
        title: variant === 'compact' ? q : null,
        onClick: function () { props.onPick(q); } }, q);
    }));
}
`;

/**
 * The paints for a provenance verdict. ONE copy, shared by the desks' skin
 * (below) and the home's (HOME_CSS): a definition dot on the home is literally
 * the same element, with the same paint, as the dot on a desk.
 */
export const DOT_CSS = `
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

// ─── The shared skin (07's tokens, verbatim) ────────────────────────────────
const SKIN = `
  :root {
    --bg: #FFFFFF; --panel-bg: #FFFFFF; --soft: #F6F4F0; --ink: #1E1A15; --muted: #786D5E;
    --line: #E9E3DA; --accent: #C0531F; --accent-dk: #95380F; --user: #EFEAE1; --whatif: #C9932B;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }
${DOT_CSS}`;

// ─── THE HOME PAGE — one design, two landings ───────────────────────────────
// Two landings exist — the local rehearsal gallery (buildGalleryPage, below) and
// the public bring-your-own-key home (lib/byok-page.js). They are the SAME page,
// built from the components in this section; only the FACTS differ, and every
// fact is passed in by the landing that can honestly claim it.
//
// The design (a Claude Design project, approved by the site owner) has one
// reveal gesture and no other: the note row. A full-width row between hairline
// rules, mono lowercase label on the left, a terracotta +/− on the right;
// activating it unfolds its content in place and turns the row's top rule
// terracotta. Rows are independent. It is a native button[aria-expanded], the
// fold is grid-template-rows 0fr→1fr, reduced motion degrades to instant, and
// closed content is out of the tab order. There is no second gesture.
//
// Type: Newsreader (everything a human reads) + IBM Plex Mono (the machine
// voice: model ids, [source: …] labels, commands, row labels). Both come from
// Google Fonts and both fall back to a system serif / system mono, so a blocked
// or failed font request costs the page nothing but the typeface.

/** The live-build cost fact — a capability of the build, not of any one turn. */
export const LIVE_COST_LINE =
  'Live run — each reply spends real API tokens on the model named on its card, and the what-if '
  + 're-runs replay frozen tool results, so they cost model calls but zero new fetches.';

/**
 * What each control on a desk does. This is teaching, so it lives on the home:
 * it reads exactly the same before the first message and after the hundredth,
 * which is the test for "not runtime".
 */
export const BUTTON_HELP = [
  { name: 'visible reason',
    what: 'opens a ranked list of exactly which sources shaped that reply' },
  { name: 'ignore a source',
    what: 'inside that panel, pick a source to leave out' },
  { name: 're-run',
    what: 'answers the same question again without it — over the frozen tool results of the original turn, zero new fetches' },
  { name: 'Continue from this version',
    what: 'forks a new session from the what-if reply; the ignored source stays ignored for every later turn' },
];

// ─── The paper ──────────────────────────────────────────────────────────────
const PAPER_TITLE = 'Visible Reasoning: User-Facing Decision Transparency for Generative AI Systems';
const PAPER_WHERE = 'HCII 2026 · LNCS 16745 · pp. 3–21 · ';
const PAPER_DOI = 'https://doi.org/10.1007/978-3-032-30849-8_1';
/** Every author, in the order they appear on the paper. */
export const PAPER_AUTHORS = 'Anbalagan, Nie, Kommalapati, Kanamarlapudi, Radhakrishnan, Zhao, Mohan';

// ─── THE WAYS OFF THIS PAGE ─────────────────────────────────────────────────
/**
 * Three links, in the order a visitor needs them: the code behind the page, the
 * library the desks actually run on, then the rest of the family. Both landings
 * render THIS list — in the header (the first one, as GITHUB) and in the footer
 * (all three). `↗` is decorative and target=_blank keeps a half-read page where
 * the visitor left it.
 */
export const HEADER_LINKS = [
  { href: 'https://github.com/footprintjs/visible-reasoning', label: 'source',
    title: 'The repository these pages are generated from' },
  { href: 'https://footprintjs.github.io/agentfootprint/', label: 'agentfootprint',
    title: 'The library these demos run on' },
  { href: 'https://footprintjs.github.io/', label: 'footprintjs',
    title: 'The rest of the ecosystem' },
];

// ─── Rich text ──────────────────────────────────────────────────────────────
// One segment vocabulary for every sentence on the home. lib/byok-page.js
// authors its custody copy in exactly these segments and renders it through
// richHtml too, so the custody sentences land in the page verbatim.
export const richHtml = (segs) => segs.map((s) => {
  if (s.b !== undefined) return `<strong>${esc(s.b)}</strong>`;
  if (s.code !== undefined) return `<code>${esc(s.code)}</code>`;
  if (s.em !== undefined) return `<em>${esc(s.em)}</em>`;
  if (s.href !== undefined) {
    return `<a href="${esc(s.href)}" target="_blank" rel="noopener">${esc(s.label)}</a>`;
  }
  return esc(s.t);
}).join('');

/** Segment constructors — `t`ext, `b`old, `code`, `em`phasis, `a`nchor. */
export const t = (s) => ({ t: s });
export const b = (s) => ({ b: s });
export const codeSeg = (s) => ({ code: s });
export const em = (s) => ({ em: s });
export const a = (href, label) => ({ href, label });

// ─── Note bodies ────────────────────────────────────────────────────────────
// A note body is a list of blocks. Every block is a shape the design actually
// draws — there is no free-form HTML anywhere on this page, so a note cannot
// invent chrome the design never specified.
//
//   { p: segs }            a paragraph
//   { aside: segs }        the ruled closing line (italic)
//   { kicker: 'STARTERS' } a small mono section label
//   { q: 'question' }      a starter question, quoted and italic
//   { lines: [segs] }      the small stacked fact lines
//   { defs: [{state,label,what}] }  provenance definitions, painted with REAL dots
//   { rows: [[name, what]] }        name → meaning rows (the buttons)
//   { cite: 'title' } / { meta: segs }  the paper's title and its mono line
const noteBlock = (bl) => {
  if (bl.p) return `<p>${richHtml(bl.p)}</p>`;
  if (bl.aside) return `<p class="vr-aside">${richHtml(bl.aside)}</p>`;
  if (bl.kicker) return `<div class="vr-kicker">${esc(bl.kicker)}</div>`;
  if (bl.q) return `<p class="vr-q">“${esc(bl.q)}”</p>`;
  if (bl.cite) return `<p class="vr-cite">${esc(bl.cite)}</p>`;
  if (bl.meta) return `<p class="vr-meta">${richHtml(bl.meta)}</p>`;
  if (bl.lines) return `<div class="vr-lines">${bl.lines.map((l) => `
              <div>${richHtml(l)}</div>`).join('')}
            </div>`;
  if (bl.defs) {
    return bl.defs.map((d) => `<div class="vr-defrow">
              <span class="vr-defname"><span class="${provDotClass(d.state)}"></span>${esc(d.label)}</span>
              <span>${esc(d.what)}</span>
            </div>`).join('\n            ');
  }
  if (bl.rows) {
    return bl.rows.map(([name, what]) => `<div class="vr-defrow">
              <span class="vr-rowname">${esc(name)}</span>
              <span>${esc(what)}</span>
            </div>`).join('\n            ');
  }
  throw new Error(`noteBlock: unknown block shape ${JSON.stringify(Object.keys(bl))}`);
};

/**
 * ONE note row — the page's only reveal gesture.
 *
 * It SHIPS OPEN: aria-expanded="true", the − mark, content in flow. The script
 * is what folds it, so scripting off costs a visitor the gesture and never the
 * words. `id` is the deep-link anchor (a desk's dialog links the home's #guide).
 */
export function noteRow({ id, label, body }) {
  return `
      <div class="vr-note" id="${esc(id)}" data-note-row>
        <button type="button" class="vr-note-btn" data-note-toggle aria-expanded="true" aria-controls="note-${esc(id)}">
          <span>${esc(label)}</span>
          <span class="vr-mark" aria-hidden="true" data-note-mark>−</span>
        </button>
        <div class="vr-fold" data-note-fold>
          <div class="vr-fold-inner" id="note-${esc(id)}" data-note-pane>
            <div class="vr-body">
            ${body.map(noteBlock).join('\n            ')}
            </div>
          </div>
        </div>
      </div>`;
}

/** A ruled group of independent rows. */
export function noteGroup(rows) {
  if (!rows.length) return '';
  return `
    <div class="vr-notes" data-note-group>${rows.map(noteRow).join('')}
    </div>`;
}

/**
 * THE DESK LISTING — the page's one bold moment (double rule, large names).
 *
 * @param d.n         the printed index ("01")
 * @param d.name/oneLiner  the desk's own title and its question
 * @param d.href      where it goes; null makes it a non-link, which is how a
 *                    desk that honestly cannot run here is shown
 * @param d.dataApp   stamp data-app so the local gallery can re-point the link
 *                    at its server route
 * @param d.badge     the honest reason a desk is not enterable
 * @param d.note      the row under it (starters, sources, what it runs on)
 */
export function deskListing(desks) {
  const items = desks.map((d) => {
    const name = `<h2 class="vr-deskname">${esc(d.name)}</h2>`;
    const head = d.href
      ? `<a class="vr-desklink" href="${esc(d.href)}"${d.dataApp ? ` data-app="${esc(d.dataApp)}"` : ''}>${name}</a>`
      : name;
    const way = d.href
      ? `
            <a class="vr-enter" href="${esc(d.href)}"${d.dataApp ? ` data-app="${esc(d.dataApp)}"` : ''}>enter →</a>`
      : `
            <p class="vr-badgerow"><span class="vr-badge">${esc(d.badge)}</span></p>`;
    return `
        <article class="vr-desk${d.href ? '' : ' is-off'}">
          <div class="vr-num">${esc(d.n)}</div>
          <div class="vr-deskmain">
            ${head}
            <p class="vr-deskone">“${esc(d.oneLiner)}”</p>${way}
            <div class="vr-desknote">${noteGroup([d.note])}
            </div>
          </div>
        </article>`;
  }).join('');
  return `
    <section class="vr-desks" aria-label="The desks">
      <div class="vr-seckick">THE DESKS</div>
      <div class="vr-listing">${items}
      </div>
    </section>`;
}

/**
 * The program notes both landings carry, in the order a visitor asks them.
 * Everything that differs between the two builds is a parameter — a landing can
 * only say what its own build does.
 *
 * @param o.states  the provenance verdicts THIS build can honestly produce
 * @param o.cost    the blocks under "what a reply costs"
 * @param o.sources one sentence naming where THIS build's data really comes from
 * @param o.extra   landing-specific rows, spliced in before the paper
 */
export function programNotes({ states = PROVENANCE_HELP.map((h) => h.state), cost, sources, extra = [] }) {
  const defs = PROVENANCE_HELP.filter((h) => states.includes(h.state));
  return [
    {
      id: 'guide',
      label: 'how to read the demo',
      body: [
        { p: [t('Next to each desk’s sources you’ll see a dot. The dot is the demo’s honest '
          + 'core — it names where that source’s data actually came from on the latest reply:')] },
        { defs },
        { p: [t(PROVENANCE_CLOSING)] },
        { p: [t(PROVENANCE_PHILOSOPHY)] },
        { p: [t(PROVENANCE_EXAMPLE)] },
      ],
    },
    {
      id: 'buttons',
      label: 'what the buttons do',
      body: [{ rows: BUTTON_HELP.map((x) => [x.name, x.what]) }],
    },
    { id: 'cost', label: 'what a reply costs', body: cost },
    {
      id: 'why',
      label: 'why this isn’t the model explaining itself',
      body: [
        { p: [t('Ask a model why it said something and you get a story about itself — fluent, '
          + 'plausible, unverified. Here the why is established outside the model: remove a source, '
          + 'run the same turn again, read what changed.')] },
        { p: [t('The paper calls this a third paradigm. Instead of asking the model to narrate its '
          + 'reasons — which cannot be checked — or asking a second model to judge it, the substrate '
          + 'that runs the work keeps the record. Tool calls, sources, scores and re-runs are typed '
          + 'events captured as the run happens, not a story told afterwards.')] },
      ],
    },
    {
      id: 'scores',
      label: 'what the scores mean — and don’t',
      body: [
        { p: [t('The visible-reason panel ranks each source by semantic alignment: a deterministic '
          + 'score comparing what that source said with what the answer said. It is a proxy for '
          + 'influence, not a proof — a high score means “this reads like it mattered”.')] },
        { p: [t('Only the re-run convicts: drop a source, answer again over the frozen tool results, '
          + 'and see whether the decision actually changes.')] },
      ],
    },
    {
      id: 'data',
      label: 'where the data comes from',
      body: [
        { p: [t(sources)] },
        // The count is DERIVED, never written: this note sits two rows under the
        // guide it points at, and the guide renders one row per verdict THIS
        // build can produce — so a hardcoded number would be wrong on the build
        // that has one fewer. verify-ia re-counts the rendered rows against it.
        { p: [t('Every tool sentence carries its own '), codeSeg('[source: …]'),
          t(' label, and the dot beside a source names what really happened on the latest reply. '
            + `The ${defs.length} labels are spelled out in `), em('how to read the demo'), t(', above.')] },
      ],
    },
    ...extra,
    {
      id: 'paper',
      label: 'the paper & the libraries',
      body: [
        { cite: PAPER_TITLE },
        { meta: [t(PAPER_WHERE), a(PAPER_DOI, 'doi.org/10.1007/978-3-032-30849-8_1')] },
        { meta: [t(PAPER_AUTHORS)] },
        { p: [t('The machinery is three MIT-licensed libraries: '),
          a('https://www.npmjs.com/package/footprintjs', 'footprintjs'), t(' records the run, '),
          a('https://www.npmjs.com/package/agentfootprint', 'agentfootprint'),
          t(' turns that recording into agents, influence rankings and re-runs, and '),
          a('https://www.npmjs.com/package/agentthinkingui', 'agentthinkingui'),
          t(' draws the panels you are clicking. The whole site is open: '),
          a('https://github.com/footprintjs/visible-reasoning', 'source on GitHub'), t('.')] },
      ],
    },
  ];
}

// ─── THE ONE REVEAL SCRIPT ──────────────────────────────────────────────────
/**
 * The note-row unfold, and nothing else. It is the only script the public BYOK
 * home carries, so it is deliberately small enough to read in one sitting:
 *
 *   · it touches nothing but rows inside a [data-note-group];
 *   · it makes no request of any kind, reads and writes no storage, reads no
 *     URL and navigates nowhere;
 *   · rows are independent — opening one never closes another;
 *   · the control is a native <button aria-expanded>, so Enter and Space are
 *     the browser's, not ours;
 *   · it never reads location — a deep link does NOT open the row it points at.
 *     That is the public home's choice, not an oversight: reading the URL is one
 *     more thing a visitor would have to trust, so the BYOK desks carry the
 *     provenance definitions inline (provenanceHelpScript with defs: true)
 *     instead of linking at the home's #guide. Only the LOCAL gallery, whose
 *     desk dialogs do link at #guide, adds the opener — in its own second
 *     script (GALLERY_ROUTING_SCRIPT), which the public home does not ship;
 *   · closed content is out of the tab order and out of the accessibility tree,
 *     and the script does not do that either: HOME_CSS hides it from .is-open
 *     alone, and delays the hide by the length of the fold so the animation is
 *     never cut short. A fold that never animates (double-click, or Enter twice
 *     inside one style recalc) therefore still ends up hidden — there is no
 *     transitionend to miss;
 *   · reduced motion drops that delay, so it hides at once;
 *   · the transition is armed one frame after the first fold, so nothing
 *     animates on load and the page never re-lays-out behind the visitor.
 *
 * verify-byok.mjs asserts each of those properties against this script's own
 * bytes (and, for the ones CSS owns, against the stylesheet's), not against
 * prose about it.
 */
export const NOTE_UNFOLD_SCRIPT = `<script>
(function () {
  var groups = document.querySelectorAll('[data-note-group]');
  if (!groups.length) return;
  Array.prototype.forEach.call(groups, function (group) {
    group.setAttribute('data-fold', 'on');
    Array.prototype.forEach.call(group.querySelectorAll('[data-note-row]'), function (row) {
      var btn = row.querySelector('[data-note-toggle]');
      // The fold and its pane are not touched — the stylesheet drives both from
      // .is-open. They are looked up only to leave a malformed row alone.
      var fold = row.querySelector('[data-note-fold]');
      var pane = row.querySelector('[data-note-pane]');
      var mark = row.querySelector('[data-note-mark]');
      if (!btn || !fold || !pane || !mark) return;
      function paint(open) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        mark.textContent = open ? '\\u2212' : '+';
        row.classList.toggle('is-open', open);
      }
      btn.addEventListener('click', function () {
        paint(btn.getAttribute('aria-expanded') !== 'true');
      });
      paint(false);
    });
  });
  var arm = function () {
    Array.prototype.forEach.call(groups, function (g) { g.setAttribute('data-motion', 'on'); });
  };
  if (window.requestAnimationFrame) window.requestAnimationFrame(arm); else arm();
}());
</script>`;

// ─── THE HOME'S SKIN ────────────────────────────────────────────────────────
// Paper #FAF7F2 · ink #211E19 · body #3A352C · muted #57503F · faint #8A8274 ·
// hairline #DCD5C9 · terracotta #A8461F (marks, open edges, focus) · green
// #3F6B4E (the way in) · purple #5D4E8C (synthetic). Accents are edges and
// glyphs, never fills. The provenance dots keep the desks' paints exactly — a
// definition dot here IS the dot on a desk, byte for byte.
export const HOME_CSS = `
  :root {
    --paper: #FAF7F2; --ink: #211E19; --body: #3A352C; --muted: #57503F; --faint: #8A8274;
    --hair: #DCD5C9; --hair-soft: #EFE9DD; --rule: #C3BBAA;
    --terra: #A8461F; --terra-edge: #C77B52; --terra-hover: #9C4423;
    --green: #3F6B4E; --green-dk: #2E523B; --green-soft: #A9C2AF;
    --serif: 'Newsreader', Georgia, 'Times New Roman', serif;
    --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); }
  body { font-family: var(--serif); font-size: 17px; line-height: 1.55;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  a { color: var(--green); }
  a:hover { color: var(--green-dk); }
  ::selection { background: #EAD9CB; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--terra); outline-offset: 3px; border-radius: 1px; }
  a:focus:not(:focus-visible), button:focus:not(:focus-visible) { outline: none; }

  .vr-page { min-height: 100dvh; padding: 0 clamp(20px, 5.5vw, 72px) 56px; }
  .vr-col { max-width: 768px; }

  /* header — the demo's own label, the way to the code, the venue */
  .vr-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
    gap: 4px 16px; padding: 16px 2px 10px; border-bottom: 1px solid var(--hair);
    font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.14em; color: var(--faint); }
  .vr-top-right { display: flex; gap: 20px; align-items: baseline; }
  .vr-top-right > * { white-space: nowrap; }
  .vr-top a { color: var(--green); text-decoration: none; }
  .vr-top a:hover { text-decoration: underline; text-underline-offset: 4px; }
  .vr-h1 { margin: clamp(30px, 6vh, 54px) 0 0; font-size: clamp(27px, 4.8vw, 38px);
    font-weight: 500; letter-spacing: -0.01em; line-height: 1.15; }
  .vr-lead { margin: 14px 0 0; font-size: clamp(17.5px, 2.2vw, 19.5px); line-height: 1.6;
    max-width: 56ch; color: var(--body); }
  .vr-sub { margin: 16px 0 22px; font-size: 16.5px; max-width: 56ch; color: var(--muted); }

  /* THE ONE GESTURE — a note row between hairlines */
  .vr-notes { border-bottom: 1px solid var(--hair); }
  .vr-note { border-top: 1px solid var(--hair); scroll-margin-top: 18px; }
  .vr-note.is-open { border-top-color: var(--terra-edge); }
  .vr-note-btn { display: flex; justify-content: space-between; align-items: center; gap: 16px;
    width: 100%; min-height: 46px; padding: 11px 2px; margin: 0; background: transparent; border: none;
    cursor: pointer; text-align: left; font-family: var(--mono); font-size: 13.5px;
    letter-spacing: 0.01em; color: #6E675C; }
  .vr-note-btn:hover { color: var(--ink); }
  .vr-mark { font-size: 16px; line-height: 1; color: var(--terra); flex: none; }
  /* Authored open, folded by script: with no script every note is simply read. */
  .vr-fold { display: grid; grid-template-rows: 1fr; }
  .vr-fold-inner { overflow: hidden; min-height: 0; }
  [data-fold="on"] .vr-fold { grid-template-rows: 0fr; }
  [data-fold="on"] .vr-fold-inner { visibility: hidden; }
  [data-fold="on"] .vr-note.is-open .vr-fold { grid-template-rows: 1fr; }
  /* CLOSED CONTENT IS HIDDEN BY CSS, NOT BY THE SCRIPT. The script only sets
     .is-open; visibility follows from it, so a fold that never animates (a
     double-click, or Enter twice inside one style recalc) still ends hidden and
     out of the tab order. Closing waits out the fold with a pure delay (the
     0.28s below) instead of a transitionend the browser may never fire; opening
     cancels that delay (0s 0s, higher specificity), so the content appears the
     moment the row opens. */
  [data-fold="on"] .vr-note.is-open .vr-fold-inner { visibility: visible; transition: visibility 0s 0s; }
  [data-fold="on"][data-motion="on"] .vr-fold { transition: grid-template-rows 0.28s cubic-bezier(0.4, 0, 0.2, 1); }
  [data-fold="on"][data-motion="on"] .vr-fold-inner { transition: visibility 0s 0.28s; }
  @media (prefers-reduced-motion: reduce) {
    [data-fold="on"][data-motion="on"] .vr-fold { transition: none; }
    [data-fold="on"][data-motion="on"] .vr-fold-inner { transition: none; }
  }

  .vr-body { padding: 4px 2px 30px; max-width: 62ch; font-size: 16.5px; line-height: 1.62;
    color: var(--body); overflow-wrap: anywhere; }
  .vr-body p { margin: 0 0 12px; }
  .vr-body p:last-child { margin-bottom: 0; }
  .vr-body code { font-family: var(--mono); font-size: 0.85em; color: var(--ink); }
  .vr-aside { margin: 12px 0 0; padding-top: 12px; border-top: 1px solid var(--hair-soft); font-style: italic; }
  .vr-aside code { font-style: normal; }
  .vr-kicker { font-family: var(--mono); font-size: 11px; letter-spacing: 0.16em; color: var(--faint);
    margin: 20px 0 8px; }
  .vr-body > .vr-kicker:first-child { margin-top: 4px; }
  .vr-q { margin: 0 0 6px; font-style: italic; font-size: 17.5px; }
  .vr-lines { display: grid; gap: 6px; font-size: 15.5px; color: var(--muted); margin: 0 0 12px; }
  .vr-cite { margin: 0 0 6px; font-style: italic; font-size: 18px; }
  .vr-meta { margin: 0 0 6px; font-family: var(--mono); font-size: 13px; color: var(--muted); }
  .vr-defrow { display: grid; grid-template-columns: minmax(0, 170px) minmax(0, 1fr); gap: 4px 14px;
    align-items: start; padding: 8px 0; border-top: 1px solid var(--hair-soft); font-size: 15.5px; }
  .vr-defrow + p { margin-top: 12px; }
  .vr-defname { display: inline-flex; align-items: flex-start; gap: 7px; font-family: var(--mono);
    font-size: 12.5px; color: var(--ink); }
  .vr-defname .cd-dot { margin-top: 4px; }
  .vr-rowname { font-family: var(--mono); font-size: 13px; color: var(--ink); }
  @media (max-width: 460px) { .vr-defrow { grid-template-columns: minmax(0, 1fr); } }
  /* a phone: the header rail is three mono labels, so it gets a tighter track
     rather than a broken word */
  @media (max-width: 520px) {
    .vr-top { font-size: 10.5px; letter-spacing: 0.09em; gap: 10px; }
    .vr-top-right { gap: 12px; }
  }

  /* the section labels */
  .vr-seckick { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.16em;
    color: var(--faint); margin: 0 0 10px; }

  /* THE ONE BOLD MOMENT — the desk listing */
  .vr-desks { margin-top: clamp(44px, 8vh, 80px); }
  .vr-listing { border-top: 4px double var(--rule); border-bottom: 1px solid var(--hair); }
  .vr-desk { display: grid; grid-template-columns: clamp(44px, 7vw, 84px) minmax(0, 1fr);
    column-gap: clamp(10px, 2vw, 18px); padding-top: clamp(20px, 3.5vw, 30px); }
  .vr-desk + .vr-desk { border-top: 1px solid var(--hair); }
  .vr-num { font-family: var(--mono); font-size: 13px; color: var(--faint); padding-top: 12px; }
  .vr-deskmain { min-width: 0; }
  .vr-deskname { margin: 0; font-size: clamp(30px, 6.5vw, 52px); font-weight: 500;
    line-height: 1.04; letter-spacing: -0.015em; }
  a.vr-desklink { color: inherit; text-decoration: none; display: inline-block; }
  a.vr-desklink:hover .vr-deskname { color: var(--terra-hover); }
  .vr-deskone { margin: 10px 0 2px; font-style: italic; font-size: clamp(17.5px, 2.4vw, 19.5px);
    color: var(--muted); }
  .vr-enter { display: inline-block; padding: 10px 0; font-family: var(--mono); font-size: 13.5px;
    color: var(--green); text-decoration: underline; text-underline-offset: 5px;
    text-decoration-thickness: 1px; text-decoration-color: var(--green-soft); }
  .vr-enter:hover { color: var(--green-dk); text-decoration-color: var(--green-dk); }
  .vr-badgerow { margin: 8px 0 0; }
  .vr-badge { display: inline-block; padding: 6px 10px; border: 1px dashed #C4BCAD; border-radius: 2px;
    font-family: var(--mono); font-size: 12.5px; color: #7A7265; }
  .vr-desk.is-off .vr-deskname { color: #6F6A60; }
  .vr-desk.is-off .vr-deskone { color: #7A7265; }
  /* a desk's own note: the same row, no bottom rule of its own */
  .vr-desknote { margin-top: 12px; }
  .vr-desknote .vr-notes { border-bottom: none; }

  .vr-program { margin-top: clamp(48px, 8vh, 88px); }

  .vr-foot { margin-top: clamp(56px, 10vh, 96px); border-top: 1px solid var(--hair);
    padding: 16px 2px 8px; display: flex; flex-wrap: wrap; gap: 10px 28px; justify-content: space-between;
    font-family: var(--mono); font-size: 12.5px; color: var(--faint); }
  .vr-foot a { color: var(--green); text-decoration: none; }
  .vr-foot a:hover { text-decoration: underline; text-underline-offset: 4px; }
  /* A DELIBERATE DEPARTURE FROM THE DESIGN, recorded so it is not "restored":
     the design paints the provenance vocabulary as bordered pill badges and
     gives the synthetic verdict a purple (#5D4E8C). Both are dropped here. A
     definition on this page must be THE SAME ELEMENT as the dot on a desk —
     that is the whole point of one shared DOT_CSS — so the definitions wear the
     desks' dots, and the desks' amber dashed synthetic comes with them. Purple
     is therefore absent from the home on purpose; there is no --purple token to
     find, and adding one would re-open the drift DOT_CSS exists to close. */
${DOT_CSS}`;

/**
 * The home's tab icon: the page's own mark — a terracotta + on paper. Inline, so
 * it costs no request AND stops the browser's automatic /favicon.ico probe,
 * which would otherwise be a 404 in the network log of a page that invites
 * visitors to read that log.
 */
export const HOME_FAVICON = 'data:image/svg+xml,'
  + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<rect width="32" height="32" rx="4" fill="#FAF7F2"/>'
    + '<path d="M4 9h24M4 23h24" stroke="#DCD5C9" stroke-width="1.5"/>'
    + '<path d="M16 10.5v11M10.5 16h11" stroke="#A8461F" stroke-width="3" stroke-linecap="round"/></svg>',
  );

// The two web fonts — a stylesheet from fonts.googleapis.com whose font files
// come from fonts.gstatic.com, which is why the BYOK home's custody note names
// BOTH hosts: a visitor reading their own network log sees both. Each stack
// falls back to a system face, so a blocked or slow font host costs the page its
// typeface and nothing else.
const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..500&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap">`;

/**
 * THE HOME PAGE. Both landings are this function; everything that could be
 * false on the other build is an argument.
 *
 * @param o.docTitle/description  the tab and the search snippet
 * @param o.favicon      an inline data: icon, or null
 * @param o.kicker       the mono label at the top left — what THIS build is
 * @param o.venue        the mono label at the top right
 * @param o.heading/lead/sub   the header
 * @param o.topNotes     the rows above the desks
 * @param o.desks        the desk listing
 * @param o.programNotes the rows below it
 * @param o.footLeft     one honest sentence about the page itself
 * @param o.scripts      extra scripts (the local gallery's routing); the unfold
 *                       script is always present and always first
 */
export function buildHome({
  docTitle, description = null, favicon = null, lang = 'en',
  kicker, venue = 'HCII 2026', heading, lead, sub,
  topNotes = [], desks = [], programNotes: notes = [], footLeft, scripts = '',
}) {
  const source = HEADER_LINKS[0];
  const footLinks = HEADER_LINKS.map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener"
      title="${esc(l.title)}">${esc(l.label)}</a>`).join(' · ');
  return `<!DOCTYPE html><html lang="${esc(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docTitle)}</title>${description ? `
<meta name="description" content="${esc(description)}">` : ''}${favicon ? `
<link rel="icon" href="${favicon}">` : ''}
${FONT_LINKS}
<style>${HOME_CSS}
</style></head>
<body>
<div class="vr-page">
  <div class="vr-col">

    <header>
      <div class="vr-top">
        <span>${esc(kicker)}</span>
        <span class="vr-top-right"><a href="${esc(source.href)}" target="_blank" rel="noopener"
          title="${esc(source.title)}">GITHUB <span aria-hidden="true">↗</span></a><span>${esc(venue)}</span></span>
      </div>
      <h1 class="vr-h1">${esc(heading)}</h1>
      <p class="vr-lead">${richHtml(lead)}</p>
      <p class="vr-sub">${richHtml(sub)}</p>
    </header>
${noteGroup(topNotes)}
${deskListing(desks)}

    <section class="vr-program" aria-label="Program notes">
      <div class="vr-seckick">PROGRAM NOTES</div>${noteGroup(notes)}
    </section>

    <footer class="vr-foot">
      <span id="vr-foot-note">${esc(footLeft)}</span>
      <span>${footLinks}</span>
    </footer>

  </div>
</div>
${NOTE_UNFOLD_SCRIPT}${scripts}
</body></html>`;
}

// ─── THE LOCAL REHEARSAL GALLERY ────────────────────────────────────────────
/**
 * @param apps  the app packs, in gallery order
 * @param opts.live  true only when the real MCP client is serving the tools
 *   (stdio subprocess → mcp-server.js). Under the default `npm run gallery` the
 *   tools come from agentfootprint's in-memory mockMcpClient — no subprocess and
 *   no protocol frames — so the page must NOT claim MCP. Same honesty rule as
 *   every tool sentence: the label names what actually happened.
 * @param opts.model  the model id live turns actually send. Named only when
 *   `live` — a mock desk calls no model, and the page says exactly that rather
 *   than borrowing a real model's name.
 */
export function buildGalleryPage(apps, { live = false, model = null } = {}) {
  // The facts under each desk, all build-honest: a mock build names no model and
  // claims no MCP, because neither one happened.
  const facts = [
    [t(live && model ? `model: ${model} — streamed token by token` : 'scripted mock — no model, no network')],
    [t(live ? 'tools served over MCP (real protocol frames)' : 'scripted mock tools — no MCP server')],
    [t(live ? 'statuses and reply arrive as they happen' : 'real event order, paced for reading')],
    [t('every reply: visible reason → re-run without a source → fork')],
  ];
  // The dot under a desk IS the dot in the guide: same table, same class
  // function, reporting what THIS build can actually do.
  const dotState = (tool) => (tool.alwaysSynthetic ? 'synthetic' : (live ? 'live' : 'scripted'));
  // …and the guide defines only the verdicts this build can reach. A mock build
  // that explained “live — real data fetched from the internet just now” would
  // be teaching a word its own desks can never say.
  const states = statesForBuild(live);

  const desks = orderForHome(apps).map((app, i) => ({
    n: String(i + 1).padStart(2, '0'),
    name: app.title,
    oneLiner: question(app),
    href: `./${app.id}.html`,
    dataApp: app.id,
    note: deskNote(app, { facts, dotState }),
  }));

  const cost = live
    ? [{ p: [t(LIVE_COST_LINE)] }]
    : [{ p: [t('This build spends nothing: no model is called and no source is fetched — every reply '
        + 'is rehearsal data written into the demo.')] },
      { p: [t('Run it live with '), codeSeg('npm run gallery:live'), t(' and each reply costs a handful '
        + 'of small model calls on the key in your .env, plus the real fetches its sources make.')] }];

  const sources = live
    ? 'Weather comes from Open-Meteo, plots and reception from Wikipedia, prices from iTunes, '
      + 'filings from SEC EDGAR — real public sources, called as tools.'
    : 'This build answers from rehearsal data written into the demo — no network. Run it live and '
      + 'the same tool calls reach the real sources: Open-Meteo, Wikipedia, iTunes, SEC EDGAR.';

  const takeItHome = {
    id: 'byok',
    label: 'take it with you — bring your own key',
    body: [
      { p: [b('Two of these desks run as a public page entirely in your browser'),
        t(', on your own Anthropic key. The key goes only to '), codeSeg('api.anthropic.com'),
        t('; the page’s host never receives it. The stock desk stays here — it needs a server.')] },
      { p: [a('https://footprintjs.github.io/visible-reasoning', 'footprintjs.github.io/visible-reasoning')] },
    ],
  };

  return buildHome({
    docTitle: 'The app gallery — one visible-reason machine, three apps',
    favicon: HOME_FAVICON,
    kicker: live ? 'DEMO · LIVE RUN · REAL SOURCES' : 'DEMO · REHEARSAL · SCRIPTED DATA',
    heading: 'Visible Reasoning — the app gallery',
    lead: [t('Three real chat desks share one machine; every reply can be re-run without a source, '
      + 'to see what that source really changed.')],
    sub: live
      ? [t('This build is live: a real model answers and the sources are really fetched — '),
        em('open a desk to watch it happen.')]
      : [t('This build is the rehearsal: scripted data, no model and no network — '),
        em('the machinery is the same, and every label says which it is.')],
    topNotes: [{
      id: 'about',
      label: 'what is visible reasoning?',
      body: [
        { p: [t('Three chat desks that answer a question and then show why: the sources that shaped '
          + 'the answer, ranked — each one droppable, so the same turn can be re-run without it and '
          + 'compared. A working companion to a published paper, not a product.')] },
        { p: [t('None of them narrates its own reasoning. Each one records it: every source the '
          + 'agent consults is a tool call, and the record of which tools ran, what came back and '
          + 'what it changed survives the reply.')] },
        { p: [t('All three run here, on this machine. The paper and the method are under '),
          em('program notes'), t(', below. This page and the desks behind it are generated from '),
          a(HEADER_LINKS[0].href, 'source on GitHub'), t(' — every sentence on them is something '
            + 'the code does.')] },
      ],
    }],
    desks,
    programNotes: programNotes({ states, cost, sources, extra: [takeItHome] }),
    footLeft: 'generated from the repo — every sentence on this page is something the code does',
    scripts: GALLERY_ROUTING_SCRIPT,
  });
}

// The local gallery's own wiring, and the only reason it carries a second
// script: served by the local server → route the desk links through it; opened
// as a file → keep the sibling .html artifacts and say so. It also opens the row
// a deep link points at, because a desk's dialog links this page's #guide and
// arriving at a folded row would be a dead end.
const GALLERY_ROUTING_SCRIPT = `<script>
(function () {
  var served = location.protocol === 'http:' || location.protocol === 'https:';
  if (served) {
    document.querySelectorAll('[data-app]').forEach(function (el) {
      el.setAttribute('href', '/app/' + el.dataset.app);
    });
  } else {
    document.getElementById('vr-foot-note').innerHTML =
      'static preview — chatting needs the local server: run <code>npm run gallery</code> and open http://localhost:4175';
  }
  var target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
  if (target && target.hasAttribute('data-note-row')) {
    var btn = target.querySelector('[data-note-toggle]');
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
    target.scrollIntoView();
  }
}());
</script>`;

// ─── the pieces both landings build a desk row from ─────────────────────────
/** The design's reading order for the listing: trip, movies, then the stock desk. */
const HOME_ORDER = ['trip', 'movies', 'stocks'];
export const orderForHome = (apps) => [...apps].sort(
  (x, y) => HOME_ORDER.indexOf(x.id) - HOME_ORDER.indexOf(y.id),
);

/**
 * A desk's one-liner, taken from the pack's own tagline ("buy or hold? — with
 * visible reasons" → "Buy or hold?"), so the listing cannot describe a desk as
 * something the desk itself doesn't claim.
 *
 * The capital is the RENDERER's, not the copy's: the design sets this line as a
 * sentence ("Should I hike it?") while a pack's tagline is written lowercase for
 * the desk's own bar. Casing the first letter here keeps both — the words are
 * still the pack's, byte for byte.
 */
export const question = (app) => {
  const q = String(app.tagline).split('—')[0].trim();
  return q.charAt(0).toUpperCase() + q.slice(1);
};

/**
 * ONE desk's note row: its real starter questions, its sources with the dot this
 * build can honestly paint, and what it runs on.
 *
 * @param o.facts     the capability lines, already segments
 * @param o.dotState  tool → the provenance verdict this build can claim
 */
export function deskNote(app, { facts, dotState }) {
  const starters = (app.starters ?? []).map((s) => ({ q: s }));
  const sources = (app.tools ?? []).map((tool) => ({
    state: dotState(tool), label: tool.legendLabel, what: tool.description,
  }));
  return {
    id: `desk-${app.id}`,
    label: 'starter questions · what this desk runs on',
    body: [
      { kicker: 'STARTER QUESTIONS' },
      ...starters,
      // Build-scoped on purpose. The guide's sentence is about a REPLY ("where
      // that source's data actually came from on the latest reply"); these dots
      // are painted at build time, before any reply exists, so the kicker says
      // which of the two this is — otherwise a live desk that cannot reach a
      // source would report `fallback` where the landing showed `live`.
      { kicker: 'SOURCES — AND THE VERDICT THIS BUILD CAN REPORT' },
      { defs: sources },
      { kicker: 'THIS DESK' },
      { lines: facts },
    ],
  };
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

  /* top bar — runtime chrome only: gallery link, brand, model badge, session
     tabs. The tagline lives on the gallery's desk listing: it is the same words
     before the first message and after the hundredth, so it is program notes,
     not stage. */
  .cd-bar { flex: 0 0 auto; display: flex; align-items: baseline; gap: 12px; padding: 12px 22px; border-bottom: 1px solid var(--line); }
  .cd-back { font-size: 12.5px; font-weight: 600; color: var(--muted); text-decoration: none; white-space: nowrap; }
  .cd-back:hover { color: var(--accent); }
  .cd-brand { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
  .cd-brand .cd-mark { color: var(--accent); font-weight: 700; }
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

  /* the live status row — one line per REAL agent event, where the reply will land */
  .cd-status { display: flex; align-items: center; gap: 7px; margin: 10px 0 0;
    font-size: 12.5px; color: var(--muted); }
  .cd-status .cd-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
    animation: cdpulse 1.1s ease-in-out infinite; }
  @keyframes cdpulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) { .cd-status .cd-pulse { animation: none; } }

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

${PROVENANCE_CSS}
${DEBUG_CSS}
${STARTERS_CSS}

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
    /* Narrow top bar: drop the model badge and keep every tab to a single
       ellipsized line so a long "fork of turn 1 (without …)" chip can't wrap
       into a 4-line pill. Desktop (>=721px) is untouched. */
    .cd-model { display: none; }
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
${/* A desk's dialog is runtime-only: this reply's sources, then the way to the
      gallery's guide. The vocabulary itself is rendered on the landing from the
      same PROVENANCE_HELP table AND the same per-build state list, so the words
      this desk can put in a tooltip are exactly the words that guide defines. */
  provenanceHelpScript(statesForBuild(data.live),
    { defs: false, guideHref: "GALLERY_HREF + '#guide'" })}
${debugModalScript()}
${startersScript()}
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

// ── the debug modal's two library views, and the recording they read ────────
// Both are same-origin GETs and neither happens on load: the view file is
// injected the first time a visitor opens the flowchart or inspector tab, and
// the recording is asked for per turn, once. The reply's own debug payload
// (the story) still arrives with the reply and needs none of this.
var DEV_VIEWS = { js: '/vendor/vr-dev-views.iife.js', css: '/vendor/vr-dev-views.iife.css' };
function getArtifacts(sessionId, k) {
  return fetch(API + '/turn/' + k + '/artifacts?session=' + encodeURIComponent(sessionId))
    .then(function (r) {
      // A page opened from disk, or served by a plain file server, gets an HTML
      // 404 here. Saying so beats handing a visitor a JSON parse error.
      if (!r.ok) {
        throw new Error('this desk\\u2019s server did not answer for turn ' + (k + 1)
          + ' (HTTP ' + r.status + ') \\u2014 the recording lives in the running gallery');
      }
      return r.json();
    });
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

// ═══ STREAMING — honest status, token-by-token replies ══════════════════════
// Every status line on this page is a projection of a REAL agentfootprint event
// the server forwarded (llm_start → "thinking…", tool_start → "consulting X…",
// a FAILED tool_end → "X hit an error…"). Nothing is invented, nothing is
// padded. The one presentation liberty is DISPLAY pacing — a minimum hold so a
// fast tool bracket is readable — and it collapses to zero under reduced motion.
var REDUCED = false;
try { REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (err) {}
document.documentElement.setAttribute('data-stream-motion', REDUCED ? 'reduced' : 'full');
var STATUS_HOLD_MS = REDUCED ? 0 : 300;   // display min-hold per status line
var BEAT_MS = 350;                        // fallback presenter only
var WORD_MS = 30;                         // mirrors the mock provider's own chunk cadence

// A MOCK desk calls no model and touches no network: the agent's entire tool
// phase finishes inside a millisecond, so EVERY status frame is already on the
// wire before the first token. The order is real, the wall clock is not — left
// alone, three true lines ("consulting weather…/place…/crowd…") would be retired
// by the first token before a single one of them was ever painted.
//
// So a mock turn is PRESENTED rather than raced: the recorded statuses play out
// in their real recorded order at the same min-hold, and only then does the
// (already complete, already authoritative) reply type itself. Nothing is
// invented and nothing is reordered — the only liberty is the clock.
//
// A LIVE turn is never presented: its content is never delayed by us, and the
// first token retires the status line exactly as it did before. Reduced motion
// turns the whole thing off on both.
var PACED = !DATA.live && !REDUCED;

var TOOL_LABEL = {};
DATA.app.tools.forEach(function (t) { TOOL_LABEL[t.name] = t.legendLabel || t.name.replace(/_/g, ' '); });
function plainTool(name) { return TOOL_LABEL[name] || String(name).replace(/_/g, ' '); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// The in-flight turn's mutable state, plus the bridge that copies it into React.
var LIVE = null;
var SET_LIVE = null;
var LAST_STREAM = null;   // what the headless drive reads (window.__appDesk.lastStream)

function paint() {
  if (!SET_LIVE) return;
  SET_LIVE(LIVE ? { userMessage: LIVE.userMessage, status: LIVE.status, text: LIVE.text } : null);
}

var scrollPending = false;
function scrollDown() {
  if (scrollPending) return;
  scrollPending = true;
  window.requestAnimationFrame(function () {
    scrollPending = false;
    var el = document.querySelector('.cd-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// Statuses are DISPLAYED in arrival order, each held a minimum of
// STATUS_HOLD_MS before the next queued one replaces it. That floor is the ONLY
// presentation liberty: the whole tool phase of a mock turn arrives in a single
// network chunk, so without it a real status line would exist for a fraction of
// a frame and the visitor would see nothing at all.
//
// On a LIVE turn it never delays content. retire() (the first token) stops any
// further status from showing and lets the one on screen finish its floor while
// the reply streams underneath it; clear() (the final payload) drops everything
// at once. Under reduced motion the floor is 0, so both are immediate.
//
// On a PACED (mock) turn nothing retires the queue: the presenter awaits
// drained() — every recorded status shown, in order, for its full floor — and
// only then types the reply. There is no content to delay yet, because a mock
// turn's tokens have all arrived already.
var PACER = {
  queue: [], timer: null, busy: false, shownAt: 0, waiters: [],
  push: function (s) {
    if (LAST_STREAM) LAST_STREAM.statuses.push(s);   // recorded in ARRIVAL order
    PACER.queue.push(s);
    if (!PACER.busy) {
      if (PACER.timer) { clearTimeout(PACER.timer); PACER.timer = null; }
      PACER.pump();
    }
  },
  pump: function () {
    if (!PACER.queue.length) { PACER.busy = false; PACER.timer = null; PACER.settle(); return; }
    PACER.busy = true;
    var s = PACER.queue.shift();
    if (LIVE) { LIVE.status = s; PACER.shownAt = Date.now(); paint(); }
    PACER.timer = setTimeout(PACER.pump, STATUS_HOLD_MS);
  },
  /** Wake everyone waiting on drained() — the queue is spent, one way or another. */
  settle: function () {
    var ws = PACER.waiters; PACER.waiters = [];
    ws.forEach(function (r) { r(); });
  },
  /**
   * Resolves once every status pushed so far has been SHOWN for its full floor
   * (or the pacer was cleared). The mock presenter's only ordering primitive.
   */
  drained: function () {
    if (!PACER.busy && !PACER.queue.length) return Promise.resolve();
    return new Promise(function (resolve) { PACER.waiters.push(resolve); });
  },
  retire: function () {
    PACER.queue = []; PACER.busy = false;
    if (PACER.timer) { clearTimeout(PACER.timer); PACER.timer = null; }
    var left = Math.max(0, STATUS_HOLD_MS - (Date.now() - PACER.shownAt));
    if (left === 0) { if (LIVE) LIVE.status = null; return; }
    PACER.timer = setTimeout(function () {
      PACER.timer = null;
      if (LIVE) { LIVE.status = null; paint(); }
    }, left);
  },
  clear: function () {
    PACER.queue = []; PACER.busy = false;
    if (PACER.timer) clearTimeout(PACER.timer);
    PACER.timer = null;
    PACER.settle();   // a cleared pacer must never leave a presenter awaiting it
  },
};

/**
 * POST + SSE, dependency-free (EventSource cannot POST a body).
 * Rejects with { phase: 'connect' }  — the turn never started; re-POST /chat.
 * Rejects with { phase: 'midstream' } — frames arrived but no final/error; the
 *   server is finishing the turn regardless, so recover with dedupe.
 */
function streamChat(body, on) {
  return fetch(API + '/chat-stream', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(function (r) {
    var ct = r.headers.get('content-type') || '';
    if (!r.ok || ct.indexOf('text/event-stream') !== 0) return Promise.reject({ phase: 'connect' });
    var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', terminal = false, opened = false;
    function pump() {
      return reader.read().then(function (step) {
        if (step.done) return terminal ? undefined : Promise.reject({ phase: opened ? 'midstream' : 'connect' });
        buf += dec.decode(step.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\\n\\n')) !== -1) {
          var raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          var ev = null, data = '';
          raw.split('\\n').forEach(function (l) {
            if (l.indexOf('event: ') === 0) ev = l.slice(7);
            else if (l.indexOf('data: ') === 0) data = l.slice(6);
          });
          if (ev) {
            opened = true;
            if (ev === 'final' || ev === 'error') terminal = true;
            if (on[ev]) on[ev](JSON.parse(data));
          }
        }
        return pump();
      }, function () {
        return Promise.reject({ phase: opened ? 'midstream' : 'connect' });
      });
    }
    return pump();
  }, function () { return Promise.reject({ phase: 'connect' }); });
}

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
  // The in-flight turn: the user's bubble lands at once, then the status row,
  // then the reply writing itself. Cleared the moment 'final' commits the turn.
  var v0 = React.useState(null); var liveTurn = v0[0], setLiveTurn = v0[1];
  SET_LIVE = setLiveTurn;

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

  // The turn is RECORDED here and nowhere else — which is why the "visible
  // reason" button appears exactly here too: it renders off sess.turns, so no
  // reason or re-run is ever offered for a reply that is still streaming.
  function commitFinal(j, msg) {
    PACER.clear();
    LIVE = null; paint();
    setSessions(function (m) {
      var n = Object.assign({}, m);
      var sess = Object.assign({}, n[j.sessionId]);
      // The debug payload rode in with the reply (chatPayload) — the debug modal
      // reads it from here and never asks the server for anything.
      sess.turns = sess.turns.concat([{ index: j.turnIndex, userMessage: msg, reply: j.reply, provenance: j.provenance, sourceLabels: j.sourceLabels || null, entity: j.entity, debug: j.debug || null }]);
      if (j.entity) sess.entity = j.entity;
      n[j.sessionId] = sess; return n;
    });
    if (order.indexOf(j.sessionId) === -1) setOrder(order.concat([j.sessionId]));
    setActive(j.sessionId);
    scrollDown();
  }

  // ── The fallback presenter (plain /chat only) ──────────────────────────────
  // The reply is already complete and authoritative; this re-paces its DISPLAY.
  // The beats are read off the turn's OWN recorded provenance — the sources it
  // really consulted — never invented. (Provenance is a set, not a sequence, so
  // pack order is the honest approximation; the content is real either way.)
  function presentFallback(j, msg) {
    // This presenter owns the status line from here on — drop anything the dead
    // stream left queued so two clocks can't drive one row.
    PACER.clear();
    var beats = [{ kind: 'thinking', label: 'thinking…' }];
    var prov = j.provenance || {};
    DATA.app.tools.forEach(function (t) {
      if (prov[t.name] && prov[t.name] !== 'not consulted') {
        beats.push({ kind: 'tool', tool: t.name, label: 'consulting ' + plainTool(t.name) + '…' });
      }
    });
    var chain = beats.reduce(function (p, s) {
      return p.then(function () {
        if (!LIVE) return null;
        if (LAST_STREAM) LAST_STREAM.statuses.push(s);
        LIVE.status = s; paint();
        return delay(BEAT_MS);
      });
    }, Promise.resolve());
    return chain.then(function () { return typewrite(j.reply); })
      .then(function () { commitFinal(j, msg); return j; });
  }

  function typewrite(reply) {
    if (!LIVE) return Promise.resolve();
    LIVE.status = null;
    var words = String(reply == null ? '' : reply).match(/\\S+\\s*/g) || [];
    var i = 0;
    function step() {
      if (!LIVE || i >= words.length) return Promise.resolve();
      LIVE.text += words[i]; i += 1;
      paint(); scrollDown();
      if (i >= words.length) return Promise.resolve();
      return delay(WORD_MS).then(step);
    }
    return step();
  }

  function send(explicit) {
    // An explicit string (the test seam) sends that; an event/undefined (button
    // click, Enter key) falls back to the current input box.
    var msg = (typeof explicit === 'string' ? explicit : input).trim(); if (!msg || !HAS_SERVER) return;
    if (LIVE) return;                     // one in-flight turn, mirroring the server's queue
    setInput('');
    var sid = active;
    LIVE = { userMessage: msg, status: null, text: '' };
    LAST_STREAM = { sessionId: sid || null, statuses: [], tokenCount: 0, finalReceived: false, fellBack: null };
    paint(); scrollDown();
    // presented — the mock desk's presentation promise. Set only on a PACED
    // turn, and awaited by the caller so send() still resolves when the turn is
    // actually on screen and committed.
    var finalJson = null, sawToken = false, presented = null;

    return streamChat({ sessionId: sid, message: msg }, {
      session: function (j) { LAST_STREAM.sessionId = j.sessionId; },
      status: function (j) {
        // A fresh 'thinking' means a fresh model pass: any prose an earlier
        // iteration streamed belongs to THAT pass, not to the answer. 'final'
        // corrects everything regardless.
        if (j.kind === 'thinking' && LIVE) { LIVE.text = ''; sawToken = false; }
        PACER.push(j);
      },
      token: function (j) {
        LAST_STREAM.tokenCount += 1;
        if (!LIVE) return;
        // PACED (mock): the tokens are real and still counted, but they all
        // arrived in the same millisecond as the statuses. Retiring the status
        // line on them would kill lines nobody has seen yet, so the presenter
        // types the authoritative 'final' reply instead — after the statuses.
        if (PACED) return;
        // The reply is now visibly writing itself — the status line has done its job.
        if (!sawToken) { sawToken = true; PACER.retire(); }
        LIVE.text += (j.text == null ? '' : j.text);
        // Under reduced motion the tokens are still consumed (arrival pacing is
        // the server's, never ours) but the bubble paints once, on 'final'.
        if (!REDUCED) { paint(); scrollDown(); }
      },
      final: function (j) {
        LAST_STREAM.finalReceived = true; finalJson = j;
        if (!PACED) { commitFinal(j, msg); return; }
        // Every recorded status, in its recorded order, held long enough to
        // read — THEN the reply writes itself. Same bytes, same order, a clock
        // a human can follow.
        presented = PACER.drained()
          .then(function () { return typewrite(j.reply); })
          .then(function () { commitFinal(j, msg); });
      },
      error: function (j) {
        // The server answered authoritatively: the turn threw. Re-POSTing /chat
        // would only fail the same way, and re-running a turn is never transparent.
        PACER.clear(); LIVE = null; paint();
        window.alert(String(j.error || 'request failed'));
      },
    }).then(function () {
      // A paced turn is not done when the wire is done — it is done when the
      // presentation is.
      return presented ? presented.then(function () { return finalJson; }) : finalJson;
    }, function (rej) {
      // If the authoritative payload already landed, a later reader hiccup is
      // not a reason to run anything again — the turn is done and committed.
      if (LAST_STREAM.finalReceived) return finalJson;
      var phase = (rej && rej.phase) || 'connect';
      LAST_STREAM.fellBack = phase;
      var body = { sessionId: LAST_STREAM.sessionId || sid, message: msg };
      // Mid-stream death: the server finished (or is finishing) the turn. The
      // dedupe read waits it out inside the serialized queue and hands back the
      // very turn we lost — no second turn, no second model call.
      if (phase === 'midstream') body.dedupe = true;
      return post('/chat', body).then(function (j) {
        LAST_STREAM.finalReceived = true;
        if (phase === 'midstream' || REDUCED) { commitFinal(j, msg); return j; }
        return presentFallback(j, msg);
      }).catch(function (err) {
        PACER.clear(); LIVE = null; paint();
        window.alert(String(err.message || err));
      });
    });
  }

  // A real test seam (not theater): the exact handlers, callable headless.
  window.__appDesk = {
    appId: DATA.app.id,
    reason: openReason, rerun: doRerun, fork: doFork,
    send: function (m) { setInput(m); return send(m); },
    getState: function () { return { order: order, active: active, sessions: sessions, reruns: reruns, panelKey: panelKey }; },
    // What the last send actually received on the wire — statuses in arrival
    // order, real token count, and which degrade path (if any) was taken.
    get lastStream() { return LAST_STREAM; },
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
    if (liveTurn) {
      thread.push(e('div', { key: 'live-u', className: 'msg-user' }, liveTurn.userMessage));
      if (liveTurn.status) {
        thread.push(e('div', { key: 'live-s', className: 'cd-status', 'data-testid': 'live-status' },
          e('span', { className: 'cd-pulse' }), liveTurn.status.label));
      }
      if (liveTurn.text) {
        thread.push(e('div', { key: 'live-a', className: 'msg-advisor', 'data-testid': 'reply-live',
          dangerouslySetInnerHTML: md(liveTurn.text) }));
      }
    }
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
  // The legend itself is the SHARED ProvLegend (generated by lib/page.js's
  // provenanceHelpScript) — the same component the BYOK page renders.
  // The verdict and its reason come off the SAME turn — never a word from one
  // reply explained by another reply's label.
  var lastProv = null;
  var lastLabels = null;
  var tks = (sess && sess.turns) || [];
  for (var li = tks.length - 1; li >= 0; li -= 1) {
    if (tks[li].provenance) { lastProv = tks[li].provenance; lastLabels = tks[li].sourceLabels || null; break; }
  }
  var legend = e(ProvLegend, {
    entityLabel: DATA.app.entityLabel,
    entityValue: (sess && sess.entity) || DATA.app.entityDefault,
    tools: DATA.app.tools,
    provenance: lastProv,
    sourceLabels: lastLabels,
  });

  // The influence panel reads as a ranked bar list (view="bars") with a native
  // strategy dropdown; all data wiring is identical to 07's.
  var panelOpen = !!(panelKey && reason[panelKey]);
  var panelInner = panelOpen
    ? e(InfluenceMap, { key: panelKey, map: reason[panelKey].map, strategies: reason[panelKey].strategies,
        activeStrategy: reason[panelKey].map.rankedBy, onRerun: doRerun,
        view: 'bars', strategyControl: 'dropdown', brand: DATA.app.title })
    : null;

  var hasContent = sess && ((sess.turns && sess.turns.length) || (sess.seed && sess.seed.length) || liveTurn);
  // What the buttons do is taught on the gallery (#buttons). The desk says only
  // what is true right now: nothing has been asked yet — and the fastest way out
  // of that state, which is this pack's own starter questions, one tap each.
  var conversation = hasContent
    ? e('div', { className: 'cd-thread' }, thread)
    : e('div', { className: 'cd-empty-hint' },
        'Ask a question to begin — or tap one of these.',
        e(Starters, { starters: DATA.app.starters, variant: 'big',
          disabled: !HAS_SERVER, onPick: send }));

  return e('div', { className: 'cd-app' + (panelOpen ? ' panel-open' : '') },
    e('div', { className: 'cd-main' },
      e('div', { className: 'cd-bar' },
        e('a', { className: 'cd-back', href: GALLERY_HREF, 'data-testid': 'back-to-gallery' }, '← gallery'),
        e('span', { className: 'cd-brand' }, DATA.app.title, ' ', e('span', { className: 'cd-mark' }, '·'), ' ', DATA.app.assistantLabel),
        // The live cost fact is a capability of the build, not of this turn, so
        // it lives on the gallery. It stays one hover away here — on the badge
        // that names the model doing the spending — at zero visible chrome.
        e('span', { className: 'cd-model' + (DATA.model ? ' live' : ''), 'data-testid': 'model-badge',
          title: DATA.model
            ? 'The model id sent on every request from this desk'
              + (DATA.costNote ? ' · ' + DATA.costNote : '')
            : 'Replies are scripted by the demo — no LLM is called' },
          e('span', { className: 'cd-dot ' + (DATA.model ? 'live' : 'scripted') }),
          DATA.model ? DATA.model : 'scripted mock — no model'),
        // One small control, and everything it opens is inside the dialog: the
        // chat surface stays a chat surface.
        e(DebugControl, { turns: (sess && sess.turns) || [],
          loadArtifacts: HAS_SERVER && sess ? function (k) { return getArtifacts(sess.id, k); } : null,
          artifactsKey: (sess && sess.id) || 'none',
          devViews: DEV_VIEWS, appName: DATA.app.assistantLabel }),
        e('div', { className: 'cd-tabs' }, tabs)),
      e('div', { className: 'cd-scroll' },
        e('div', { className: 'cd-col' },
          legend,
          prov,
          conversation)),
      e('div', { className: 'cd-composer' },
        e('div', { className: 'cd-composer-col' },
          // Once the conversation exists it owns the transcript alone, so the
          // starters move HERE — part of the composer, above the box that does
          // the same job, in the muted chip treatment the desk's other small
          // controls already use.
          hasContent
            ? e(Starters, { starters: DATA.app.starters, variant: 'compact',
                disabled: !HAS_SERVER || !!liveTurn, onPick: send })
            : null,
          e('div', { className: 'cd-inputrow' },
            e('input', { 'data-testid': 'chat-input', value: input, disabled: !HAS_SERVER || !!liveTurn,
              placeholder: HAS_SERVER ? DATA.app.starters[0] : 'Chatting needs the local server',
              onChange: function (ev) { setInput(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === 'Enter') send(); } }),
            e('button', { 'data-testid': 'chat-send', disabled: !HAS_SERVER || !!liveTurn, onClick: send }, 'Send')),
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
