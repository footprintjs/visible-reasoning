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

/** "live: real data fetched from the internet just now (…)" — no tool name. */
function provBody(tool, p) {
  var body = p
    ? p + (PROV_WORDS[p] ? ': ' + PROV_WORDS[p] : '')
    : 'not used yet: waiting for the first reply';
  if (tool.alwaysSynthetic && p !== 'synthetic') {
    body += ' · this source is always synthetic by design — modeled, never measured';
  }
  return body;
}

/** "wiki_plot — live: real data fetched from the internet just now (…)" */
function provTitle(tool, p) {
  return tool.name + ' — ' + provBody(tool, p);
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
  var sources = prov
    ? tools.map(function (t) {
        var p = prov[t.name];
        return React.createElement('div', { key: t.name, className: 'cd-help-item' },
          provDot(p),
          React.createElement('span', null,
            React.createElement('b', null, t.name), ' — ', provBody(t, p)));
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
  return React.createElement('div', { className: 'cd-legend', 'data-testid': 'tool-legend' },
    React.createElement('div', { className: 'cd-legend-row' },
      React.createElement('span', { className: 'cd-entity' }, props.entityLabel + ': ' + props.entityValue),
      tools.map(function (t) {
        var p = prov && prov[t.name];
        return React.createElement('span', { key: t.name, className: 'cd-leg-item', title: provTitle(t, p) },
          provDot(p), t.legendLabel + (p ? '' : ' —'));
      }),
      React.createElement('button', { type: 'button', className: 'cd-help-btn', ref: btnRef,
        'data-testid': 'legend-help-toggle', 'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'cd-legend-help',
        onClick: function () { setOpen(true); } },
        React.createElement('span', { 'aria-hidden': 'true' }, 'ⓘ'), 'what do these mean?')),
    open ? React.createElement(ProvHelpModal, { tools: tools, provenance: prov, onClose: close }) : null);
}
`;
};

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

// ─── THE LANDING'S OWN VOCABULARY (static — nothing here changes at runtime) ─
// Tiny inline icons: decorative (aria-hidden), currentColor, zero requests.
const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" `
  + `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  // ✦ model — a chip
  model: svg('<rect x="7.5" y="7.5" width="9" height="9" rx="2"/><path d="M10 3.5v4M14 3.5v4M10 16.5v4M14 16.5v4'
    + 'M3.5 10h4M3.5 14h4M16.5 10h4M16.5 14h4"/>'),
  // → browser-direct — a window with an arrow leaving it (the BYOK key path)
  direct: svg('<path d="M13 20.5H4.5a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 19 5v4"/>'
    + '<path d="M3 8.2h16"/><path d="M13.5 16.5h7"/><path d="M17.8 13.2l3.2 3.3-3.2 3.3"/>'),
  // ⌁ tools — a plug
  tools: svg('<path d="M9 2.5v5.5M15 2.5v5.5"/><path d="M6 8h12v3.2a6 6 0 0 1-12 0z"/><path d="M12 17.2v4.3"/>'),
  // ≋ streaming — three offset waves
  stream: svg('<path d="M2.5 7.5c1.9-2 3.9-2 5.8 0s3.9 2 5.8 0 3.9-2 5.8 0"/>'
    + '<path d="M4.5 12.5c1.9-2 3.9-2 5.8 0s3.9 2 5.8 0"/>'
    + '<path d="M2.5 17.5c1.9-2 3.9-2 5.8 0s3.9 2 5.8 0 3.9-2 5.8 0"/>'),
  // ⑂ re-run + fork — a branch
  branch: svg('<circle cx="6.5" cy="5" r="2.2"/><circle cx="6.5" cy="19" r="2.2"/><circle cx="17.5" cy="9" r="2.2"/>'
    + '<path d="M6.5 7.2v9.6"/><path d="M17.5 11.2c0 3.4-3.4 4.2-6.6 5.1"/>'),
  // the ranked bar list the "visible reason" button opens
  bars: svg('<path d="M4 6h15M4 12h10M4 18h6"/>'),
  // leaving a source out
  ignore: svg('<path d="M3 3l18 18"/><path d="M10.6 5.3A9.3 9.3 0 0 1 12 5.2c5.2 0 9 4.5 9 6.8 0 .9-.7 2.3-1.9 3.6"/>'
    + '<path d="M6.4 7.1C4 8.7 3 10.9 3 12c0 2.3 3.8 6.8 9 6.8 1.5 0 2.8-.4 4-.9"/>'
    + '<path d="M9.6 9.9a3 3 0 0 0 4.3 4.2"/>'),
  // running the same question again
  rerun: svg('<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>'),
};

/** The live-build cost fact — a capability of the build, not of any one turn. */
export const LIVE_COST_LINE =
  'Live run — each reply spends real API tokens on the model named on its card, and the what-if '
  + 're-runs replay frozen tool results, so they cost model calls but zero new fetches.';

/**
 * What each control on a desk does. This is teaching, so it lives on the
 * landing: it reads exactly the same before the first message and after the
 * hundredth, which is the test for "not runtime".
 */
export const BUTTON_HELP = [
  { name: 'visible reason', icon: ICON.bars,
    what: 'opens a ranked list of exactly which sources shaped that reply' },
  { name: 'ignore a source', icon: ICON.ignore,
    what: 'inside that panel, pick a source to leave out' },
  { name: 're-run', icon: ICON.rerun,
    what: 'answers the same question again without it — over the frozen tool results of the original turn, zero new fetches' },
  { name: 'Continue from this version', icon: ICON.branch, solid: true,
    what: 'forks a new session from the what-if reply; the ignored source stays ignored for every later turn' },
];

// ─── THE LANDING'S DESIGN LANGUAGE, SHARED ─────────────────────────────────
// Two landings exist — the local gallery (below) and the BYOK gallery
// (lib/byok-page.js). They are the same page shape with different truths, so
// the CSS, the card and the guide section live HERE and are imported there.
// Forking them would let a card on one landing drift from a card on the other.
export const GALLERY_CSS = `
  .ag-wrap { max-width: 1040px; margin: 0 auto; padding: 46px 22px 60px; }
  .ag-head { text-align: center; margin: 0 0 34px; }
  .ag-head h1 { font-size: 27px; letter-spacing: -0.015em; margin: 0 0 10px; }
  .ag-head p { font-size: 15px; line-height: 1.65; color: var(--muted); margin: 0 auto; max-width: 640px; }
  .ag-cost { font-size: 12px; line-height: 1.6; color: var(--muted); margin: 12px auto 0; max-width: 640px; }
  .ag-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
  .ag-card { display: flex; flex-direction: column; text-decoration: none; color: inherit;
    border: 1px solid var(--line); border-radius: 14px; padding: 0 18px 18px; background: var(--bg);
    overflow: hidden; transition: box-shadow .18s ease, transform .18s ease; }
  a.ag-card:hover { box-shadow: 0 8px 26px rgba(40,30,20,.10); transform: translateY(-2px); }
  .ag-rule { display: block; height: 4px; margin: 0 -18px 16px; background: var(--accent); }
  .ag-title { font-size: 18px; margin: 0 0 5px; letter-spacing: -0.01em; }
  .ag-tag { font-size: 13.5px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
  .ag-tools { display: flex; flex-wrap: wrap; gap: 6px 13px; margin: 0 0 12px; }
  .ag-tool { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
  /* the capability strip — one icon+line per thing this build can actually do */
  .ag-caps { display: flex; flex-direction: column; gap: 6px; margin: 0 0 14px;
    padding: 10px 12px; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; }
  .ag-cap { display: flex; align-items: flex-start; gap: 8px; font-size: 11.5px; line-height: 1.45; color: var(--muted); }
  .ag-cap svg { flex: 0 0 auto; margin-top: 1px; color: var(--accent); }
  .ag-chips { display: flex; flex-direction: column; gap: 6px; margin: 0 0 18px; }
  .ag-chip { font-size: 12px; color: var(--muted); background: var(--soft); border: 1px solid var(--line);
    border-radius: 999px; padding: 5px 11px; line-height: 1.4; }
  .ag-cta { margin-top: auto; align-self: flex-start; font-size: 13px; font-weight: 700;
    color: #fff; background: var(--accent); border-radius: 999px; padding: 8px 16px; }
  a.ag-card:hover .ag-cta { background: var(--accent-dk); }

  /* the program notes: how to read the demo, what the buttons do, take-it-home */
  .ag-sec { margin: 34px auto 0; max-width: 760px; }
  #guide, #buttons, #byok { scroll-margin-top: 18px; }
  .ag-sec h2 { font-size: 16px; margin: 0 0 8px; letter-spacing: -0.01em; }
  .ag-sec p { font-size: 13px; line-height: 1.65; color: var(--muted); margin: 0 0 10px; }
  .ag-defs { margin: 0 0 12px; font-size: 13px; line-height: 1.6; color: var(--muted); }
  .ag-defs .cd-help-item { margin-bottom: 8px; }
  .ag-note { font-size: 12.5px; line-height: 1.65; color: var(--muted); margin: 0 0 8px; }
  .ag-btn-strip { display: flex; flex-wrap: wrap; gap: 10px; }
  .ag-btn-item { flex: 1 1 320px; display: flex; flex-direction: column; gap: 6px;
    padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
  .ag-btn-head { display: flex; align-items: center; gap: 8px; }
  .ag-btn-head svg { flex: 0 0 auto; color: var(--accent); }
  .ag-btn-what { font-size: 12px; line-height: 1.55; color: var(--muted); }
  .ag-fakebtn { font-size: 11.5px; font-weight: 600; color: var(--muted); background: none;
    border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; white-space: nowrap; }
  .ag-fakebtn.solid { color: #fff; background: var(--accent); border-color: var(--accent); font-weight: 700; }
  .ag-byok { padding: 14px 16px; border: 1px solid var(--line); border-left: 3px solid var(--whatif, #C9932B);
    border-radius: 11px; background: var(--soft); }
  .ag-byok p { margin: 0; font-size: 13px; line-height: 1.65; color: var(--muted); }
  .ag-byok strong { color: var(--ink); }
  .ag-byok a { color: var(--accent); font-weight: 700; text-decoration: none; white-space: nowrap; }
  .ag-byok a:hover { text-decoration: underline; }

  .ag-foot { margin: 34px auto 0; max-width: 720px; font-size: 12.5px; line-height: 1.7; color: var(--muted); text-align: center; }
  .ag-foot code { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; }
`;

/**
 * ONE gallery card. Both landings render THIS — the local gallery's live/mock
 * desks and the BYOK gallery's browser desks, including the one that honestly
 * cannot run in a browser at all.
 *
 * @param o.app    a page-safe app slice (id/title/tagline/accent/tools/starters)
 * @param o.caps   the capability strip, already icon+text — each landing owns
 *                 its own truths here (an MCP subprocess is not a browser fetch)
 * @param o.dotState  tool → provenance state this build can honestly claim
 * @param o.href   where the card goes; null makes it a non-link (a dead card
 *                 would be worse than a card that says why it is dead)
 * @param o.note   the honest reason a card is not a link
 */
export function galleryCard({ app, caps, dotState = () => 'scripted', href = null, dataApp = false, cta = 'Open the desk →', note = null }) {
  // Empty rows are omitted, not rendered hollow: a card with no tool dots and no
  // starters (the desk that cannot run here) must not carry the gaps where they
  // would have been.
  const tools = (app.tools ?? []).map((t) => `
        <span class="ag-tool" title="${esc(t.description)}">
          <span class="${provDotClass(dotState(t))}"></span>${esc(t.legendLabel)}
        </span>`).join('');
  const chips = (app.starters ?? []).map((s) => `<span class="ag-chip">${esc(s)}</span>`).join('');
  const capStrip = caps.map((c) => `
        <span class="ag-cap">${c.icon}<span>${esc(c.text)}</span></span>`).join('');
  const row = (cls, body) => (body ? `
      <div class="${cls}">${body}</div>` : '');
  const tag = href ? 'a' : 'div';
  const attrs = [
    `class="ag-card${href ? '' : ' off'}"`,
    dataApp ? `data-app="${esc(app.id)}"` : '',
    href ? `href="${esc(href)}"` : '',
    `style="--accent: ${esc(app.accent)}; --accent-dk: ${esc(app.accentDark)}"`,
  ].filter(Boolean).join(' ');
  return `
    <${tag} ${attrs}>
      <span class="ag-rule"></span>
      <h2 class="ag-title">${esc(app.title)}</h2>
      <p class="ag-tag">${esc(app.tagline)}</p>${note ? `
      <p class="ag-cardnote">${esc(note)}</p>` : ''}${row('ag-tools', tools)}${row('ag-caps', capStrip)}${row('ag-chips', chips)}
      <span class="ag-cta">${esc(cta)}</span>
    </${tag}>`;
}

/**
 * "How to read the demo" — the vocabulary section, rendered from the SAME table
 * the desks' dots and the BYOK dialog read. A definition here and a dot on a
 * desk cannot drift apart.
 *
 * @param states  the verdicts THIS build can honestly produce. The local
 *   gallery shows all five; the BYOK gallery has no scripted source anywhere,
 *   so it must not teach a word its desks can never say.
 */
export function guideSection(states = PROVENANCE_HELP.map((h) => h.state)) {
  const defs = PROVENANCE_HELP.filter((h) => states.includes(h.state)).map((h) => `
      <div class="cd-help-item">
        <span class="${provDotClass(h.state)}"></span>
        <span><b>${esc(h.label)}</b> — ${esc(h.what)}</span>
      </div>`).join('');
  return `
  <section class="ag-sec" id="guide">
    <h2>How to read the demo</h2>
    <p>Next to each desk's tools you'll see a dot. The dot is the demo's honest core — it names where
    that tool's data actually came from on the latest reply:</p>
    <div class="ag-defs">${defs}
    </div>
    <p class="ag-note">${esc(PROVENANCE_CLOSING)}</p>
    <p class="ag-note">${esc(PROVENANCE_PHILOSOPHY)}</p>
    <p class="ag-note">${esc(PROVENANCE_EXAMPLE)}</p>
  </section>`;
}

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
  // The capability strip, per card. Every line is build-honest: a mock build
  // names no model and claims no MCP, because neither one happened.
  const capLines = [
    { icon: ICON.model, text: live && model ? `model: ${model} — streamed token by token` : 'scripted mock — no model, no network' },
    { icon: ICON.tools, text: live ? 'tools served over MCP (real protocol frames)' : 'scripted mock tools — no MCP server' },
    { icon: ICON.stream, text: live ? 'statuses and reply arrive as they happen' : 'real event order, paced for reading' },
    { icon: ICON.branch, text: 'every reply: visible reason → re-run without a source → fork' },
  ];
  // The card dot IS the guide dot: same table, same class function, and it
  // reports what THIS build can actually do — live tools on a live build,
  // scripted on a mock one, synthetic where the data is invented by design.
  const dotState = (t) => (t.alwaysSynthetic ? 'synthetic' : (live ? 'live' : 'scripted'));
  const cards = apps.map((app) => galleryCard({
    app, caps: capLines, dotState, href: `./${app.id}.html`, dataApp: true,
  })).join('');

  const buttons = BUTTON_HELP.map((b) => `
      <div class="ag-btn-item">
        <span class="ag-btn-head">${b.icon}<span class="ag-fakebtn${b.solid ? ' solid' : ''}">${esc(b.name)}</span></span>
        <span class="ag-btn-what">${esc(b.what)}</span>
      </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The app gallery — one visible-reason machine, three apps</title>
<style>${SKIN}${GALLERY_CSS}${PROVENANCE_CSS}
</style></head>
<body>
<div class="ag-wrap">
  <header class="ag-head">
    <h1>The app gallery — one visible-reason machine, three apps</h1>
    <p>Three real chat desks share one machine: every context source is a tool the agent calls, and
    every reply can be re-run without a source to see what that source really changed. Everything
    below is the program — open a desk to watch it live.</p>${live ? `
    <p class="ag-cost" data-testid="gallery-cost">${esc(LIVE_COST_LINE)}</p>` : ''}
  </header>
  <div class="ag-grid">${cards}</div>
${guideSection()}

  <section class="ag-sec" id="buttons">
    <h2>What the buttons do</h2>
    <div class="ag-btn-strip">${buttons}
    </div>
  </section>

  <section class="ag-sec" id="byok">
    <div class="ag-byok">
      <p><strong>Take it with you — bring your own key.</strong> Two of these desks run as a public
      page entirely in your browser, on your own Anthropic key. The key goes only to
      api.anthropic.com; the page's host never receives it.
      <a href="https://footprintjs.github.io/visible-reasoning" target="_blank" rel="noopener noreferrer">→ footprintjs.github.io/visible-reasoning</a></p>
    </div>
  </section>

  <p class="ag-foot" id="ag-foot"></p>
</div>
<script>
// Served by the local server → route through it; opened as a file → keep the
// sibling .html artifacts so the gallery still walks card → app offline.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  document.querySelectorAll('.ag-card').forEach(function (a) { a.setAttribute('href', '/app/' + a.dataset.app); });
} else {
  document.getElementById('ag-foot').innerHTML =
    'Static preview — chatting needs the local server: run <code>npm run gallery</code> and open http://localhost:4175';
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

  /* top bar — runtime chrome only: gallery link, brand, model badge, session
     tabs. The tagline lives on the gallery card: it is the same words before
     the first message and after the hundredth, so it is program notes, not
     stage. */
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
      same PROVENANCE_HELP table, so the two cannot drift. */
  provenanceHelpScript(['live', 'scripted', 'fallback', 'synthetic', 'not consulted'],
    { defs: false, guideHref: "GALLERY_HREF + '#guide'" })}
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
      sess.turns = sess.turns.concat([{ index: j.turnIndex, userMessage: msg, reply: j.reply, provenance: j.provenance, entity: j.entity }]);
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
  var lastProv = null;
  var tks = (sess && sess.turns) || [];
  for (var li = tks.length - 1; li >= 0; li -= 1) { if (tks[li].provenance) { lastProv = tks[li].provenance; break; } }
  var legend = e(ProvLegend, {
    entityLabel: DATA.app.entityLabel,
    entityValue: (sess && sess.entity) || DATA.app.entityDefault,
    tools: DATA.app.tools,
    provenance: lastProv,
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
  // what is true right now: nothing has been asked yet.
  var conversation = hasContent
    ? e('div', { className: 'cd-thread' }, thread)
    : e('div', { className: 'cd-empty-hint' },
        'Ask a question to begin — or send the starter already in the box.');

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
        e('div', { className: 'cd-tabs' }, tabs)),
      e('div', { className: 'cd-scroll' },
        e('div', { className: 'cd-col' },
          legend,
          prov,
          conversation)),
      e('div', { className: 'cd-composer' },
        e('div', { className: 'cd-composer-col' },
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
