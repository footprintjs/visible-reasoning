// The bring-your-own-key bundle — out/byok/{index,trip,movies}.html.
//
//   buildByokLanding({ apps, stock, model })     → index.html, the gallery home
//   buildByokPage({ importMap, app, model })     → one desk per app page
//
// Fully static pages where a conference visitor pastes THEIR OWN Anthropic key
// and gets the same desk experience as the gallery (chat → visible reason →
// verified what-if re-run → fork), with every byte of agent machinery running in
// the tab: agentfootprint's browserAnthropic calls api.anthropic.com directly,
// the tools are client-side fetchers against keyless public APIs, and the
// influence graph is the same recordedChat wiring lib/chat-core.js already uses.
//
// The home is a GALLERY, not a desk: cards → click → the app. It teaches (the
// custody contract, the provenance vocabulary) and takes no key input at all —
// arming happens on the desk the visitor picked. Every link on it is relative,
// so the same folder works at /visible-reasoning/, at a domain root, or off a
// local file server.
//
// THE ARCHITECTURAL GUARANTEE the page exists to make true: the key is
// UNRECORDABLE BY US. There is no server in the key path — not "we promise not
// to log it", but "there is no code of ours that could". The page is a plain
// static file; the only requests carrying the key go to api.anthropic.com; the
// key lives in a module-scoped variable and reaches storage only behind an
// explicit checkbox. Every one of those is asserted in verify-byok.mjs and
// driven in a headless browser with a fake key.
//
// The skin tokens and the React/atui module shim are duplicated from
// lib/page.js per the repo's freeze-and-copy convention (07 is the paper's
// frozen reference; 08's desk pages carry the byte gate).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// The provenance legend is NOT copied: the vocabulary, the state→dot paint, the
// CSS and the legend component itself all live in lib/page.js, and both pages
// render the SAME DOM from it. Drift is impossible by construction. The landing
// borrows the same way — the gallery skin, the card and the guide section are
// imported, never re-authored, so a card here and a card in the local gallery
// are the same element with different truths in it.
import {
  DEBUG_CSS, PROVENANCE_CSS, STARTERS_CSS, buildHome, codeSeg, debugModalScript, deskNote,
  orderForHome, programNotes, provenanceHelpScript, question, startersScript, t as tSeg,
} from './page.js';

const require = createRequire(import.meta.url);
const pkgRoot = (name) => dirname(require.resolve(name));
const read = (spec) => readFileSync(require.resolve(spec), 'utf8');
const readDeep = (name, rel) => readFileSync(join(pkgRoot(name), rel), 'utf8');
const cjs = (name, code) =>
  `__register(${JSON.stringify(name)}, function (module, exports, require) {\n${code}\n});`;

// ─── The custody copy, EXACTLY as specified ─────────────────────────────────
// Authored here as rich-text segments so the literal sentences land in the
// generated HTML verbatim (verify-byok.mjs asserts them) while still rendering
// with the bold / code / italic emphasis the copy needs.
const t = (s) => ({ t: s });
const b = (s) => ({ b: s });
const code = (s) => ({ code: s });
const em = (s) => ({ em: s });

const CUSTODY_COPY = [
  [b('Your key stays in this tab.')],
  // The hosted line. This page is published to GitHub Pages, so a visitor's
  // first question is "who is hosting this, and what do they get?" — answered
  // before the mechanics. Pages serves the files and sees those file requests;
  // it never sees the key, because no request carrying the key goes to it.
  [
    t('This is a live public demo — it runs entirely in your browser. Your key goes only to Anthropic; this site’s host (GitHub Pages) never receives it.'),
  ],
  [
    t('Every Claude call goes straight from your browser to '), code('api.anthropic.com'),
    t(' — our demo server never sees your key. It is not sent to us, not logged, not put in any URL, and not stored unless you tick “remember”, which keeps it in this tab only until you close it. '),
    b('Forget my key'), t(' erases it instantly.'),
  ],
  [
    t('This page doesn’t even need our server: it is a plain static file — any dumb file host can serve it, and it chats just the same. That is the guarantee: there is no server code that '),
    em('could'), t(' see your key.'),
  ],
  [
    b('Don’t take our word for it'), t(' — open DevTools → Network and watch: the only requests that carry your key go to '),
    code('api.anthropic.com'), t('. Everything else is weather, Wikipedia and iTunes, called keylessly from your browser.'),
  ],
];

// What a reply spends. True on both surfaces, so both carry it: the landing
// (before you pick a desk) and the desk itself (while you spend it).
const COST_COPY = [
  t('Runs on your key: each reply is a handful of small Haiku calls (one per source the agent consults, plus one to answer); a verified what-if re-run is a few more, replayed over the '),
  b('frozen'), t(' tool results of the original turn — zero new fetches, and the counter on the re-run card proves it. Usage appears in your Anthropic console like any other API traffic.'),
];

// Why the gallery has two cards and a disabled third — a fact about the GALLERY,
// so it lives on the gallery home beside the card it explains.
const SCOPE_COPY = [
  t('Two desks are here, not three: the SEC’s servers don’t allow browser calls, so the stock desk runs only in the server demo. Fewer desks, honestly labeled, beats a desk that pretends.'),
];

// The home links into the desks in the SAME TAB, which makes "does my key come
// with me?" a real question with two different answers. Both are stated, because
// the custody card's promise ("this tab, until you close it") is only kept if the
// visitor knows which of the two they chose.
const KEY_TRAVEL_COPY = [
  t('You’ll paste your key on the desk you open — this page never asks for one. Tick '),
  b('remember'),
  t(' there and the key rides with you in this tab: back to this gallery, into the other desk, and across a reload, until you close the tab. Leave it unticked and the key lives in that one page only, so coming back here clears it and the next desk asks again.'),
];

const CHECKBOX_LABEL = 'Remember my key in this tab (survives reload and the trip back to the gallery; forgotten when the tab closes)';
const STOCK_NOTE = 'The SEC’s servers don’t allow browser calls, so the stock desk runs only in the server demo.';

// Leaving a desk for the gallery is a page load: this page's memory — every turn,
// every fork — goes with it. Asked, once there is something to lose. The key is
// named in the same breath because it is the visitor's other live question.
const LEAVE_CONFIRM = 'Leaving resets this conversation — your key stays per your “remember” choice.';

// The provenance verdicts a desk in THIS bundle can honestly produce. Every tool
// here is a real browser fetcher, so `scripted` is absent — from the guide on
// the home and from the dialog on a desk, which read this same list.
const BYOK_STATES = ['live', 'fallback', 'synthetic', 'not consulted'];

// A key, drawn in the page's accent — inline so it costs no request.
const FAVICON = 'data:image/svg+xml,'
  + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<rect width="32" height="32" rx="7" fill="#C0531F"/>'
    + '<circle cx="12.5" cy="12.5" r="5" fill="none" stroke="#fff" stroke-width="3"/>'
    + '<path d="M16.2 16.2 L24 24 M20.5 20.5 l3.2 -3.2" fill="none" stroke="#fff"'
    + ' stroke-width="3" stroke-linecap="round"/></svg>',
  );

// ─── The shared skin (page.js's tokens, verbatim) ───────────────────────────
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * THE GALLERY HOME — out/byok/index.html.
 *
 * The desks are listed, key entry never happens here: a visitor arriving cold
 * reads what this is and where their key would go, then picks a desk and arms it
 * there. Zero absolute paths — it is honest under a subpath, at a root, and off
 * file://.
 *
 * ONE script rides along, and only one: lib/page.js's NOTE_UNFOLD_SCRIPT, the
 * page's single reveal gesture. It makes no request, touches no storage, reads
 * no URL and knows nothing about keys — the custody guarantees are unchanged and
 * verify-byok.mjs asserts each of those properties about the script's own bytes,
 * not just about the page. Scripting off leaves every note open and readable.
 *
 * @param opts.apps   page-safe slices of the packs the bundle carries, in order
 * @param opts.stock  the page-safe slice of the desk that CANNOT run here; it is
 *   listed anyway, not enterable, saying why — the alternative is pretending the
 *   third desk never existed
 * @param opts.model  the model id every desk in this bundle will send
 */
export function buildByokLanding({ apps, stock, model }) {
  // Four capability lines, all true of THIS bundle: a real model on the
  // visitor's key, a key path with no server of ours in it, real arrival
  // streaming, and the re-run/fork machinery every reply carries.
  const facts = [
    [tSeg(`model: ${model} — on your key, streamed token by token`)],
    [tSeg('browser-direct: every Claude call goes from your tab to api.anthropic.com — no server in between')],
    [tSeg('statuses and reply arrive as they happen')],
    [tSeg('every reply: visible reason → re-run without a source → fork')],
  ];
  // Nothing on these desks is scripted: every tool is a real browser fetcher, so
  // a dot may claim live — except the source that is synthetic by design.
  const dotState = (tool) => (tool.alwaysSynthetic ? 'synthetic' : 'live');

  const runnable = orderForHome(apps).map((app, i) => ({
    n: String(i + 1).padStart(2, '0'),
    name: app.title,
    oneLiner: question(app),
    href: `./${app.id}.html`,
    note: deskNote(app, { facts, dotState }),
  }));

  // The desk that cannot run in a browser is listed, not deleted — and it gets
  // no starter questions and no source dots, because a starter you cannot send
  // is a dead end and a dot would claim a verdict nothing here can produce.
  const offDesk = {
    n: String(runnable.length + 1).padStart(2, '0'),
    name: stock.title,
    oneLiner: question(stock),
    href: null,
    badge: 'runs locally only · needs a server',
    note: {
      id: `desk-${stock.id}`,
      label: 'why it isn’t here · how to run it',
      body: [
        { p: [tSeg(`${STOCK_NOTE} A browser cannot fetch a filing from EDGAR, and this page has no `
          + 'server of ours behind it to fetch one on your behalf — so the desk is not here, and it '
          + 'will not pretend.')] },
        { p: [tSeg('Where it does run, it runs '), { b: 'server-side' },
          tSeg(' — which is the honest difference from the two desks above. In the local demo a '
            + 'local MCP server calls SEC EDGAR and Reddit over the real protocol, and that server, '
            + 'not your browser, calls the model.')] },
        { p: [tSeg('Run it yourself with '), codeSeg('npm run gallery:live'), tSeg(', then open '),
          codeSeg('http://localhost:4175'), tSeg('.')] },
      ],
    },
  };

  return buildHome({
    docTitle: 'Bring your own key — the app gallery',
    description: 'Two small advisors you can chat with on your own Anthropic key — visible reasons, '
      + 'verified what-if re-runs, all in your browser.',
    favicon: FAVICON,
    kicker: 'DEMO · BRING YOUR OWN KEY',
    heading: 'Visible Reasoning — the app gallery',
    lead: [tSeg('Three real chat desks share one machine; every reply can be re-run without a source, '
      + 'to see what that source really changed.')],
    sub: [tSeg('Two of them run right here in your browser, on your own Anthropic API key — '),
      { em: 'the key never leaves this tab.' }],
    topNotes: [
      {
        id: 'about',
        label: 'what is visible reasoning?',
        body: [
          { p: [tSeg('Three chat desks that answer a question and then show why: the sources that '
            + 'shaped the answer, ranked — each one droppable, so the same turn can be re-run without '
            + 'it and compared. A working companion to a published paper, not a product.')] },
          { p: [tSeg('None of them narrates its own reasoning. Each one records it: every source the '
            + 'agent consults is a tool call, and the record of which tools ran, what came back and '
            + 'what it changed survives the reply.')] },
          { p: [tSeg('Two of the three run here, in your browser; the third needs a server, and its '
            + 'row below says so. The paper and the method are under '), { em: 'program notes' },
          tSeg(', below. Everything — the stock desk included — runs from '),
          { href: 'https://github.com/footprintjs/visible-reasoning', label: 'source on GitHub' },
          tSeg('. Every file here — this page, the desks, the vendored library bytes — is generated '
            + 'from that repo and served as-is.')] },
        ],
      },
      {
        id: 'key',
        label: 'the key, in full',
        body: [
          // The custody contract, verbatim: the same segment arrays the desks
          // render, so a sentence cannot be true on one surface and edited on
          // the other. The last line — "don't take our word for it" — is the
          // design's ruled closing aside.
          ...CUSTODY_COPY.slice(0, -1).map((segs) => ({ p: segs })),
          { p: KEY_TRAVEL_COPY },
          // BOTH font hosts are named, and no request count is implied. This
          // page tells visitors to open DevTools → Network and read it, and what
          // they see there is a stylesheet from fonts.googleapis.com plus the
          // font files themselves from fonts.gstatic.com — a host the old
          // sentence never mentioned.
          { p: [tSeg('The one thing this page fetches is its web fonts, from '),
            codeSeg('fonts.googleapis.com'), tSeg(' and '), codeSeg('fonts.gstatic.com'),
            tSeg(' — a stylesheet and a few font files, no key, no data of yours, and if those '
              + 'requests fail you get your system fonts and the same page. Nothing else leaves it: '
              + 'this page takes no key at all.')] },
          { aside: CUSTODY_COPY[CUSTODY_COPY.length - 1] },
        ],
      },
    ],
    desks: [...runnable, offDesk],
    programNotes: programNotes({
      states: BYOK_STATES,
      cost: [{ p: COST_COPY }, { p: SCOPE_COPY }],
      sources: 'Weather comes from Open-Meteo, plots and reception from Wikipedia, prices from '
        + 'iTunes — keyless public APIs, called straight from your tab.',
    }),
    footLeft: 'a plain static page — it takes no key and stores nothing',
  });
}

/**
 * ONE DESK — out/byok/<app>.html.
 *
 * @param opts.importMap  the generated, resolution-verified import map (JSON string)
 * @param opts.app        the page-safe slice of the ONE pack this page carries
 * @param opts.model      the model id every request from this page will send
 */
export function buildByokPage({ importMap, app, model }) {
  const DATA = JSON.stringify({
    app, model,
    custody: CUSTODY_COPY, footer: [COST_COPY],
    checkboxLabel: CHECKBOX_LABEL, leaveConfirm: LEAVE_CONFIRM,
  });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app.title)} — bring your own key</title>
<meta name="description" content="${esc(app.tagline)} — on your own Anthropic key, with visible reasons and verified what-if re-runs, all in your browser.">
${/* An inline data: icon, not a file. The custody copy tells visitors to open
     DevTools → Network and read every request; the browser's automatic
     /favicon.ico probe would put a 404 in that list and make them wonder. This
     costs zero requests and keeps the tab honest-looking. */''}
<link rel="icon" href="${FAVICON}">
<script type="importmap">
${importMap}
</script>
<style>${read('agentthinkingui/styles.css')}</style>
<style>${SKIN}
  /* ── The desk skin, copied from lib/page.js. The accent is this desk's own,
     set on .cd-app (inline), so the page wears the card's colour. ── */
  #root { height: 100%; }
  .cd-app { position: fixed; inset: 0; background: var(--bg); }
  .cd-main { height: 100%; display: flex; flex-direction: column; transition: margin-right .28s ease; }

  .cd-bar { flex: 0 0 auto; display: flex; align-items: baseline; gap: 12px; padding: 12px 22px; border-bottom: 1px solid var(--line); }
  .cd-back { font-size: 12.5px; font-weight: 600; color: var(--muted); text-decoration: none; white-space: nowrap; }
  .cd-back:hover { color: var(--accent); }
  .cd-brand { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
  .cd-brand .cd-mark { color: var(--accent); font-weight: 700; }
  .cd-tagline { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* model badge — names what actually answers */
  .cd-model { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
    color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
  .cd-model.live { color: #2C6B22; }
  .cd-tabs { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; align-self: center; }
  .cd-tab { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg); color: var(--muted); }
  .cd-tab.on { background: var(--accent); border-color: var(--accent-dk); color: #fff; }

  .cd-scroll { flex: 1 1 auto; overflow-y: auto; }
  .cd-col { max-width: 720px; margin: 0 auto; padding: 22px 22px 34px; }
  .cd-empty-hint { color: var(--muted); font-size: 14.5px; line-height: 1.65; padding: 40px 10px; text-align: center; }

  .cd-thread { display: flex; flex-direction: column; }
  .msg-user { align-self: flex-end; max-width: 76%; margin: 16px 0 2px; padding: 10px 15px;
    border-radius: 18px 18px 5px 18px; background: var(--user); color: var(--ink);
    font-size: 15px; line-height: 1.5; white-space: pre-wrap; }
  .msg-advisor { align-self: stretch; margin: 8px 0 0; padding: 2px 1px;
    font-size: 15.5px; line-height: 1.62; white-space: pre-wrap; color: var(--ink); }
  .msg-user.seed, .msg-advisor.seed { opacity: 0.62; }

  /* the live status row — one line per REAL agent event, in this tab */
  .cd-status { display: flex; align-items: center; gap: 7px; margin: 10px 0 0;
    font-size: 12.5px; color: var(--muted); }
  .cd-status .cd-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
    animation: cdpulse 1.1s ease-in-out infinite; }
  @keyframes cdpulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) { .cd-status .cd-pulse { animation: none; } }

  .cd-reasonbtn { align-self: flex-start; margin: 8px 0 2px; font-size: 12.5px; font-weight: 600; cursor: pointer;
    background: none; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); padding: 4px 13px; }
  .cd-reasonbtn:hover { color: var(--accent); border-color: var(--accent); }

  .whatif { align-self: stretch; margin: 12px 0 6px; padding: 13px 15px; border-radius: 13px;
    border: 1px solid var(--line); border-left: 3px solid var(--whatif); background: var(--soft); }
  .whatif-lbl { font-size: 12px; font-weight: 700; color: #9A6C15; margin: 0 0 6px; }
  .whatif-ans { font-size: 14.5px; line-height: 1.5; white-space: pre-wrap; }
  .whatif-sum { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
  .whatif-frozen { font-size: 12px; color: #2C6B22; font-weight: 600; margin: 6px 0 0; }
  .chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; margin: 9px 6px 0 0; }
  .chip.confirmed { background: #E3F1DE; color: #2C6B22; }
  .chip.not-confirmed { background: #F6E5DA; color: #8A4A22; }
  .chip.inconclusive { background: #EEE8DD; color: #6E5C49; }
  .chip.observed { background: #EEE8DD; color: #6E5C49; }
  .cd-fork { margin-top: 11px; font-size: 12px; font-weight: 700; cursor: pointer;
    background: var(--accent); color: #fff; border: none; border-radius: 999px; padding: 7px 15px; }
  .cd-fork:hover { background: var(--accent-dk); }

  .cd-prov { font-size: 12px; color: var(--muted); margin: 0 0 12px; padding: 8px 13px;
    background: var(--soft); border-radius: 9px; border: 1px solid var(--line); line-height: 1.5; }

${PROVENANCE_CSS}
${DEBUG_CSS}
${STARTERS_CSS}

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

  /* the re-run's status row (lib/page.js's, duplicated per the freeze-and-copy
     convention): the same pulse + one muted sentence as the chat status line,
     pinned to the top of the panel so it cannot scroll out of sight. The pulse
     inherits .cd-status's reduced-motion rule. */
  .cd-rerun-status { position: sticky; top: -10px; z-index: 2; margin: 0 0 8px;
    padding: 8px 10px; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; }
  .cd-rerun-err { margin: 0 0 8px; padding: 9px 11px; font-size: 12.5px; line-height: 1.5;
    color: #8A2B14; background: #FDEDE7; border: 1px solid #F3C9BA; border-radius: 10px; }
  .cd-inf.busy .inf-bar-ignore, .cd-inf.busy .inf-toggle, .cd-inf.busy .inf-rerun {
    pointer-events: none; opacity: .45; }
  .cd-inf.busy { cursor: progress; }

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

  .cd-backdrop { position: fixed; inset: 0; background: rgba(30,22,14,.34); opacity: 0; pointer-events: none;
    transition: opacity .28s ease; z-index: 45; }

  /* ── BYOK-only chrome: the custody panel, the armed strip, the small print ── */
  .by-custody { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 12px;
    background: var(--soft); padding: 15px 17px; margin: 0 0 16px; }
  .by-custody h2 { font-size: 15px; margin: 0 0 8px; letter-spacing: -0.01em; }
  .by-copy p { font-size: 13px; line-height: 1.62; color: var(--ink); margin: 0 0 8px; }
  .by-copy p:last-child { margin-bottom: 0; }
  .by-copy code { background: #fff; border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; font-size: 12px; }
  .by-form { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; margin: 13px 0 0; }
  .by-form input[type=password] { flex: 1 1 260px; min-width: 0; padding: 10px 14px; border-radius: 999px;
    border: 1px solid var(--line); background: #fff; font-size: 14px; color: var(--ink); outline: none; }
  .by-form input[type=password]:focus { border-color: var(--accent); }
  .by-form button { font-weight: 700; font-size: 13px; padding: 10px 18px; border-radius: 999px; border: none;
    background: var(--accent); color: #fff; cursor: pointer; }
  .by-form button:hover { background: var(--accent-dk); }
  .by-remember { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); flex: 1 1 100%; }
  .by-armed { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 14px; padding: 9px 14px;
    border-radius: 999px; background: #E9F3E7; border: 1px solid #C6E0C0; font-size: 12.5px; color: #2C6B22; font-weight: 600; }
  .by-armed button { font-size: 12px; font-weight: 700; padding: 5px 13px; border-radius: 999px; cursor: pointer;
    border: 1px solid #C6E0C0; background: #fff; color: #2C6B22; }
  .by-armed .by-armed-note { font-weight: 500; color: #4B6B46; }
  .by-foot { margin: 18px 0 0; font-size: 12px; line-height: 1.65; color: var(--muted); }
  .by-foot p { margin: 0 0 7px; }

  @media (min-width: 721px) {
    .cd-app.panel-open .cd-main { margin-right: min(480px, 100%); }
    .cd-backdrop { display: none; }
  }
  @media (max-width: 720px) {
    .cd-panel { width: 100%; box-shadow: none; }
    .cd-backdrop.show { opacity: 1; pointer-events: auto; }
    .cd-tagline { display: none; }
    .cd-tab { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* This bar carries one thing the desks' does not: a badge that names the
       model AND the key's four characters. It cannot be dropped on a phone (it
       is a custody signal) and it cannot be ellipsized without lying, so the bar
       wraps instead — every control stays on screen and reachable. */
    .cd-bar { flex-wrap: wrap; row-gap: 8px; }
    .cd-model { white-space: normal; }
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
<script type="module">
${bootScript(DATA, app)}
</script>
</body></html>`;
}

// ─── The page's own module: key custody + the desk over local-api.js ────────
/**
 * @param DATA  the page-safe payload, already JSON
 * @param app   the ONE pack this page carries. Its `id` names both the copied
 *   module (app/apps/<id>.js) and that module's export — a build-time fact
 *   byok.js asserts against the files it just wrote, so a rename cannot ship a
 *   page whose only import is broken.
 */
function bootScript(DATA, app) {
  return `
import { browserAnthropic } from 'agentfootprint/llm-providers';
import { createChatCore } from './app/lib/chat-core.js';
import { metrics } from './app/lib/mcp.js';
import { ${app.id} as PACK } from './app/apps/${app.id}.js';
import { makeBrowserCtx } from './app/byok/browser-ctx.js';
import { browserToolsFor } from './app/byok/tools.js';
import { createLocalApi } from './app/byok/local-api.js';

var DATA = ${DATA};
var MODEL = DATA.model;
var APP = DATA.app;
// One desk per page: the visitor picked it on the gallery home, so there is no
// cross-desk state here at all — only this pack, and its own fork tabs.
var PACKS = [PACK];
${/* No 'scripted' here: every tool on this page is a real browser fetcher, so
      the states it can honestly show are live / fallback / synthetic / not
      consulted — the same four its key line has always listed.

      defs: true — and it must stay true. The home DOES carry the same guide
      now, but reaching it costs this page's conversation (a page load ends it),
      so the vocabulary still has to be readable without leaving the desk. */
  provenanceHelpScript(BYOK_STATES, { defs: true })}
${debugModalScript()}
${startersScript()}

// ═══ KEY CUSTODY ═══════════════════════════════════════════════════════════
// The visitor's key lives HERE and nowhere else: a variable in this module's
// closure. It is handed to browserAnthropic and to nothing else. In particular
// it never enters footprint's SharedMemory, so no snapshot, commit log,
// influence map or export can contain it — that is a property of where the
// value lives, not a promise about what we do with it.
var apiKey = null;
var keyTail = '';
var STORE_KEY = 'byok:anthropic-key';

// The API base is a compile-time constant inside agentfootprint's browser
// provider (https://api.anthropic.com/v1/messages). The ONLY override is this
// in-page hook, read LAZILY at provider construction so a headless test can set
// it after load. It is deliberately NOT read from the query string: no
// query-string configuration exists on this page, so no crafted link can
// redirect a request that carries someone's key.
function apiUrlOverride() {
  var hook = window.__BYOK_TEST__;
  return hook && typeof hook.apiUrl === 'string' ? hook.apiUrl : null;
}

// Called fresh per agent construction (lib/chat-core.js's makeProvider seam):
// swapping or forgetting a key takes effect on the very next send.
function makeProvider() {
  if (!apiKey) throw new Error('Paste your Anthropic key above to start.');
  var url = apiUrlOverride();
  // parallelToolCalls: false — the browser half of the server desk's setting
  // (see lib/chat-core.js). One tool per reply, so each source lands on its own
  // agent iteration and the influence panel can name all three.
  var opts = { apiKey: apiKey, defaultModel: MODEL, parallelToolCalls: false };
  if (url) opts.apiUrl = url;
  return browserAnthropic(opts);
}

function storedKey() {
  try { return window.sessionStorage.getItem(STORE_KEY); } catch (e) { return null; }
}
function rememberKey(k) { try { window.sessionStorage.setItem(STORE_KEY, k); } catch (e) {} }
function eraseStoredKey() {
  // sessionStorage is the only place this page ever writes a key; localStorage
  // is cleared too so "forget" is unconditional, whatever an older build did.
  try { window.sessionStorage.removeItem(STORE_KEY); } catch (e) {}
  try { window.localStorage.removeItem(STORE_KEY); } catch (e) {}
}

// ═══ The machine — identical wiring to the server demo ═════════════════════
var ctx = makeBrowserCtx();
var core = createChatCore({ live: true, model: MODEL, makeProvider: makeProvider });
var built = browserToolsFor(PACKS, ctx, core.getPending);
var api = createLocalApi({ core: core, packs: PACKS, perApp: built.perApp });

// ── the debug modal's two library views, and the recording they read ────────
// The views are one built file beside this page — the only thing this desk ever
// asks its own host for after load, and it asks only when a visitor opens the
// flowchart or inspector tab. The RECORDING those views read never travels at
// all: the turn is already in this tab, so api.artifacts is a read, not a
// request. Relative paths, like everything else here, so the bundle works at a
// subpath, at a root and off file://.
var DEV_VIEWS = { js: './vendor/vr-dev-views.iife.js', css: './vendor/vr-dev-views.iife.css' };
function getArtifacts(sessionId, k) {
  return Promise.resolve(api.artifacts({ appId: APP.id, sessionId: sessionId, turnIndex: k }));
}

// The desk's whole state: the first session, plus whatever forks it grows.
var FIRST = api.startSession(PACK);
var INITIAL = { order: [FIRST.id], active: FIRST.id, sessions: {}, reason: {}, reruns: {}, panelKey: null };
INITIAL.sessions[FIRST.id] = core.sessionToData(FIRST);

var e = React.createElement;

function parseSeed(lines, assistantLabel) {
  var uP = 'User: ', aP = assistantLabel + ': ';
  return lines.map(function (l) {
    if (l.indexOf(uP) === 0) return { role: 'user', text: l.slice(uP.length) };
    if (l.indexOf(aP) === 0) return { role: 'advisor', text: l.slice(aP.length) };
    return { role: 'advisor', text: l };
  });
}

// Escape everything first, then re-admit exactly two inline marks (page.js's
// renderer, verbatim) — no raw HTML from a model can survive the escape.
function mdHtml(text) {
  var safe = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return safe
    .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?![*\\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\\w])_([^_\\n]+)_(?![_\\w])/g, '$1<em>$2</em>');
}
function md(text) { return { __html: mdHtml(text) }; }

// ═══ STREAMING — the same honest status vocabulary, with no wire at all ═════
// The agent runs IN THIS TAB, so its events are already local: no SSE, no
// server, no new key path. browserAnthropic implements stream(), so the agent
// loop consumes Anthropic's own SSE and fires agentfootprint.stream.token per
// chunk — the typewriter pacing here is REAL arrival pacing, not a timer.
// The event→status map is lib/page.js's, duplicated per the freeze-and-copy
// convention: llm_start → "thinking…", tool_start → "consulting <plain>…",
// a FAILED tool_end → "<plain> hit an error — answering without it". Nothing else
// makes a status, and no status exists without an event.
var REDUCED = false;
try { REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (err) {}
document.documentElement.setAttribute('data-stream-motion', REDUCED ? 'reduced' : 'full');
var STATUS_HOLD_MS = REDUCED ? 0 : 300;

var TOOL_LABEL = {};
APP.tools.forEach(function (t) { TOOL_LABEL[t.name] = t.legendLabel || t.name.replace(/_/g, ' '); });
function plainTool(name) { return TOOL_LABEL[name] || String(name).replace(/_/g, ' '); }

var LIVE = null;
var SET_LIVE = null;
var LAST_STREAM = null;

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

// Display pacing only (lib/page.js's pacer, duplicated per the freeze-and-copy
// convention): statuses show in ARRIVAL order, each with a minimum display floor
// of STATUS_HOLD_MS. retire() — the first token — stops further statuses and
// lets the one on screen finish its floor while the reply streams underneath;
// clear() — the committed turn — drops everything. Reduced motion → floor 0.
var PACER = {
  queue: [], timer: null, busy: false, shownAt: 0,
  push: function (s) {
    if (LAST_STREAM) LAST_STREAM.statuses.push(s);
    PACER.queue.push(s);
    if (!PACER.busy) {
      if (PACER.timer) { clearTimeout(PACER.timer); PACER.timer = null; }
      PACER.pump();
    }
  },
  pump: function () {
    if (!PACER.queue.length) { PACER.busy = false; PACER.timer = null; return; }
    PACER.busy = true;
    var s = PACER.queue.shift();
    if (LIVE) { LIVE.status = s; PACER.shownAt = Date.now(); paint(); }
    PACER.timer = setTimeout(PACER.pump, STATUS_HOLD_MS);
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
  },
};

/** One raw agentfootprint event → at most one UI effect. Real events only. */
function makeLiveSink() {
  var nameOf = {};        // toolCallId → toolName, learned on tool_start
  var sawToken = false;
  return function (ev) {
    var p = ev.payload || {};
    if (ev.type === 'agentfootprint.stream.llm_start') {
      if (LIVE) { LIVE.text = ''; sawToken = false; }
      PACER.push({ kind: 'thinking', label: 'thinking…' });
    } else if (ev.type === 'agentfootprint.stream.tool_start') {
      nameOf[p.toolCallId] = p.toolName;
      PACER.push({ kind: 'tool', tool: p.toolName, label: 'consulting ' + plainTool(p.toolName) + '…' });
    } else if (ev.type === 'agentfootprint.stream.tool_end' && p.error) {
      var name = nameOf[p.toolCallId] || 'a source';
      PACER.push({ kind: 'tool', tool: name, label: plainTool(name) + ' hit an error — answering without it' });
    } else if (ev.type === 'agentfootprint.stream.token') {
      if (LAST_STREAM) LAST_STREAM.tokenCount += 1;
      if (!LIVE) return;
      if (!sawToken) { sawToken = true; PACER.retire(); }
      LIVE.text += (p.content == null ? '' : p.content);
      if (!REDUCED) { paint(); scrollDown(); }
    }
  };
}

// ═══ THE RE-RUN'S STATUS LINE — the counterfactual, narrated ════════════════
// A re-run here is 2×samples real Anthropic calls made from this tab over the
// turn's frozen tool log, and it takes tens of seconds. atui's own footer says
// "this can take a moment" once, at the bottom of a scrollable panel — and it
// erases that sentence the instant an ignore toggle is tapped. So the panel gets
// the same honest line the chat thread has.
//
// The event→status map is run.js's rerunStatusMapper, duplicated per the
// freeze-and-copy convention. Two host phases the probe really has (the frozen
// world being armed, and each seeded run starting — chat-core emits both from
// the run itself) plus the SAME agent events the chat sink maps. No tokens: a
// probe's prose is a counterfactual and must never type itself into the
// transcript. Nothing is paced — a re-run's phases are what the visitor is
// waiting on, and holding a finished one on screen would misreport the work.
var LAST_RERUN = null;   // what the headless drive reads (window.__byok.lastRerun)

/** One raw event → at most one status line. Real events only. @param show (status) => void */
function makeRerunSink(labels, show) {
  var nameOf = {};
  var without = labels.length > 0 ? labels.join(', ') : 'the selected sources';
  return function (ev) {
    var p = ev.payload || {};
    var s = null;
    if (ev.type === 'vr.rerun.start') {
      s = { kind: 'removing', removed: p.removed,
        label: 'removing ' + without + ' \\u2014 the original turn\\u2019s tool results stay frozen' };
    } else if (ev.type === 'vr.rerun.probe') {
      var text = p.phase === 'baseline'
        ? 'baseline run ' + p.run + ' of ' + p.samples + ' \\u2014 nothing removed'
        : p.phase === 'without'
          ? 're-run ' + p.run + ' of ' + p.samples + ' without ' + without
          // Unclassifiable: an ignored id this pack serves no tool for. Say the
          // one thing we do know rather than guess which probe this is.
          : 'seeded re-run ' + p.run;
      s = { kind: 'probe', phase: p.phase || null, run: p.run, of: p.samples, label: text };
    } else if (ev.type === 'agentfootprint.stream.llm_start') {
      s = { kind: 'thinking', label: 'thinking\\u2026' };
    } else if (ev.type === 'agentfootprint.stream.tool_start') {
      nameOf[p.toolCallId] = p.toolName;
      s = { kind: 'tool', tool: p.toolName,
        label: 'replaying ' + plainTool(p.toolName) + ' from the original turn \\u2014 no new fetch' };
    } else if (ev.type === 'agentfootprint.stream.tool_end' && p.error) {
      var name = nameOf[p.toolCallId] || 'a source';
      s = { kind: 'tool', tool: name, label: plainTool(name) + ' hit an error \\u2014 this run answers without it' };
    }
    if (!s) return;
    if (LAST_RERUN) LAST_RERUN.statuses.push(s);
    show(s);
  };
}

/** Render one rich-text line of the custody copy. */
function richLine(segs, key) {
  return e('p', { key: key }, segs.map(function (s, i) {
    if (s.b !== undefined) return e('strong', { key: i }, s.b);
    if (s.code !== undefined) return e('code', { key: i }, s.code);
    if (s.em !== undefined) return e('em', { key: i }, s.em);
    return s.t;
  }));
}

/** Depth-safe stringify for the leak check — cycles become '[circular]'. */
function safeStringify(value) {
  var seen = new WeakSet();
  return JSON.stringify(value, function (k, v) {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    if (typeof v === 'function') return '[function]';
    if (v instanceof Map) return Array.from(v.entries());
    return v;
  });
}

function Byok() {
  var d0 = React.useState(INITIAL); var desk = d0[0], setDesk = d0[1];
  var a0 = React.useState(!!storedKey()); var armed = a0[0], setArmed = a0[1];
  var t0 = React.useState(''); var tail = t0[0], setTail = t0[1];
  var r0 = React.useState(false); var remember = r0[0], setRemember = r0[1];
  var i0 = React.useState(''); var input = i0[0], setInput = i0[1];
  // The in-flight turn — user bubble at once, then the honest status row, then
  // the reply writing itself from Anthropic's own arrival cadence.
  var v0 = React.useState(null); var liveTurn = v0[0], setLiveTurn = v0[1];
  SET_LIVE = setLiveTurn;
  // The in-flight re-run: which panel it belongs to, the sources it is removing,
  // the latest real status, and — if it failed — the honest note.
  var x0 = React.useState(null); var rerunLive = x0[0], setRerunLive = x0[1];
  var keyRef = React.useRef(null);
  // Which turn the reason panel is showing, tracked in a ref as well as in
  // state: a re-run fired in the same tick as the reason that opened the panel
  // would otherwise read a render-old panelKey and silently do nothing.
  var panelRef = React.useRef(null);

  // A key remembered for this tab auto-arms on load (that is the whole point of
  // the checkbox: surviving an accidental mid-demo reload).
  React.useEffect(function () {
    var k = storedKey();
    if (k) { apiKey = k; keyTail = k.slice(-4); setArmed(true); setTail(keyTail); setRemember(true); }
  }, []);

  var sess = desk.sessions[desk.active];

  function patch(fn) {
    setDesk(function (d) { return fn(Object.assign({}, d)); });
  }

  // ═══ leaving for the gallery ════════════════════════════════════════════
  // The "← gallery" link is a real same-tab navigation, and this page's memory
  // is the conversation: every turn and every fork lives in the tab, nowhere
  // else. So the trip is never blocked and never silent — once there is
  // something to lose, the visitor is asked, and the same sentence names what
  // happens to their key (sessionStorage if they ticked "remember", gone if
  // they didn't). Before the first message there is nothing to lose and the
  // link just goes.
  function hasConversation() {
    if (LIVE) return true;
    return desk.order.some(function (id) {
      var s = desk.sessions[id];
      return !!(s && ((s.turns && s.turns.length) || (s.seed && s.seed.length)));
    });
  }
  function onLeave(ev) {
    if (!hasConversation()) return;
    if (!window.confirm(DATA.leaveConfirm)) ev.preventDefault();
  }

  // Failures are shown, never swallowed — and never posted anywhere: there is no
  // telemetry on this page. Anthropic's own error bodies do not echo keys, and
  // the raw line is kept after the plain-words lead so a visitor can still see
  // exactly what the API said.
  function closePanel() {
    panelRef.current = null;
    patch(function (d) { d.panelKey = null; return d; });
  }
  // Split in two: failMessage builds the plain-words sentence, fail shows it
  // in a dialog. The re-run reuses the SENTENCE inside the panel — a failed
  // counterfactual must leave the map and the toggles standing, and a modal that
  // has to be dismissed before you can look at either is the wrong shape for it.
  var failMessage = function (err) {
    var raw = String((err && err.message) || err);
    var status = err && err.status;
    var lead = null;
    if (status === 401 || /\b401\b|authentication_error|invalid x-api-key/.test(raw)) {
      lead = 'Anthropic rejected that key (401 — invalid x-api-key). Check it and paste it again. '
        + 'Nothing was stored, and the key went nowhere except api.anthropic.com.';
    } else if (status === 429 || /\b429\b|rate_limit/.test(raw)) {
      lead = 'Anthropic is rate-limiting this key (429). Wait a moment and send again.';
    } else if (status === 400 && /credit|billing/i.test(raw)) {
      lead = 'Anthropic will not run this key right now (billing or credit). Check your Anthropic console.';
    } else if (/Failed to fetch|NetworkError|load failed/i.test(raw)) {
      lead = 'The call to api.anthropic.com could not be made — check the network. Your key never left this tab.';
    }
    return lead ? lead + '\\n\\n(Anthropic said: ' + raw + ')' : raw;
  };
  var fail = function (err) { window.alert(failMessage(err)); };

  // ═══ arming / forgetting ════════════════════════════════════════════════
  function arm() {
    var el = keyRef.current;
    var k = el && el.value ? el.value.trim() : '';
    if (!k) { window.alert('Paste your Anthropic API key first.'); return; }
    apiKey = k;
    keyTail = k.slice(-4);
    if (remember) rememberKey(k); else eraseStoredKey();
    if (el) el.value = '';           // the key string leaves the DOM immediately
    setArmed(true);
    setTail(keyTail);
  }
  function forget() {
    apiKey = null;
    keyTail = '';
    eraseStoredKey();
    if (keyRef.current) keyRef.current.value = '';
    setArmed(false);
    setTail('');
    setRemember(false);
  }

  // ═══ the four calls — local functions, no HTTP, no server ═══════════════
  function send(explicit) {
    var msg = (typeof explicit === 'string' ? explicit : input).trim();
    // Guard on the KEY, not on React's armed flag: apiKey is the module-scope
    // variable that actually enables a call, and unlike a rendered flag it is
    // never one render behind. (armed still drives the disabled composer.)
    if (!msg || !apiKey) return;
    if (LIVE) return;                    // one in-flight turn per page
    setInput('');
    LIVE = { userMessage: msg, status: null, text: '' };
    LAST_STREAM = { statuses: [], tokenCount: 0, finalReceived: false };
    paint(); scrollDown();
    var done = function () { PACER.clear(); LIVE = null; paint(); };
    return api.chat({ appId: APP.id, sessionId: desk.active, message: msg, onEvent: makeLiveSink() }).then(function (j) {
      LAST_STREAM.finalReceived = true;
      done();
      patch(function (d) {
        var sessions = Object.assign({}, d.sessions);
        var s = Object.assign({}, sessions[j.sessionId]);
        // The debug payload came back with the reply, from the turn's own
        // recording — computed in this tab, never requested, never stored.
        s.turns = s.turns.concat([{ index: j.turnIndex, userMessage: msg, reply: j.reply,
          provenance: j.provenance, sourceLabels: j.sourceLabels || null, entity: j.entity,
          debug: j.debug || null }]);
        if (j.entity) s.entity = j.entity;
        sessions[j.sessionId] = s;
        d.sessions = sessions;
        if (d.order.indexOf(j.sessionId) === -1) d.order = d.order.concat([j.sessionId]);
        d.active = j.sessionId;
        return d;
      });
      return j;
    }).catch(function (err) { done(); return fail(err); });
  }

  function openReason(sid, ti) {
    var key = sid + ':' + ti;
    return api.reason({ appId: APP.id, sessionId: sid, turnIndex: ti }).then(function (j) {
      panelRef.current = key;
      patch(function (d) {
        d.reason = Object.assign({}, d.reason);
        d.reason[key] = { map: j.map, strategies: j.strategies };
        d.panelKey = key;
        return d;
      });
      return j;
    }).catch(fail);
  }

  /** The words the map itself used for these ids — never an id in prose. */
  function labelsForIds(key, ids) {
    var srcs = (desk.reason[key] && desk.reason[key].map && desk.reason[key].map.sources) || [];
    return ids.map(function (id) {
      for (var i = 0; i < srcs.length; i += 1) if (srcs[i].id === id) return srcs[i].label;
      return id;
    });
  }

  function doRerun(ids) {
    var key = desk.panelKey || panelRef.current;
    if (!key) return;
    var parts = key.split(':'), sid = parts[0], ti = Number(parts[1]);
    var before = metrics.toolDispatches;
    var labels = labelsForIds(key, ids);
    LAST_RERUN = { key: key, ids: ids, statuses: [], finalReceived: false };
    setRerunLive({ key: key, labels: labels, status: null, error: null });
    // Only the panel this re-run belongs to may be repainted by it.
    var show = function (s) {
      setRerunLive(function (r) { return r && r.key === key ? { key: key, labels: labels, status: s, error: null } : r; });
    };
    return api.rerunTurn({ appId: APP.id, sessionId: sid, turnIndex: ti, ignore: ids,
      onEvent: makeRerunSink(labels, show) }).then(function (j) {
      LAST_RERUN.finalReceived = true;
      var dispatched = metrics.toolDispatches - before;
      patch(function (d) {
        d.reruns = Object.assign({}, d.reruns);
        d.reruns[key] = { rerunId: j.rerunId, ignoredIds: ids, ignoredLabels: j.ignoredLabels,
          result: j.result, dispatched: dispatched };
        return d;
      });
      setRerunLive(null);
      return j.result;   // the af RerunWithoutSourcesResult, verbatim, for atui's own panel
    }, function (err) {
      // The panel stays alive and the map stays exactly as it was — the note
      // names what was being removed and what failed, and Re-run works again.
      setRerunLive({ key: key, labels: labels, status: null, error: failMessage(err) });
      throw err;
    });
  }

  function doFork(sid, ti, rerunId) {
    return api.fork({ appId: APP.id, sessionId: sid, turnIndex: ti, rerunId: rerunId }).then(function (j) {
      panelRef.current = null;
      patch(function (d) {
        d.sessions = Object.assign({}, d.sessions);
        d.sessions[j.sessionId] = { id: j.sessionId, label: j.label, forkOf: j.forkOf || null,
          ignoredSourceIds: j.ignoredSourceIds, seed: j.transcript, entity: j.entity || null, turns: [] };
        if (d.order.indexOf(j.sessionId) === -1) d.order = d.order.concat([j.sessionId]);
        d.active = j.sessionId;
        d.panelKey = null;
        return d;
      });
      return j;
    }).catch(fail);
  }

  // A real test seam (not theater): the exact handlers, callable headless.
  // It exposes the key's LAST FOUR characters at most — never the key.
  window.__byok = {
    appId: APP.id,
    arm: arm, forget: forget,
    isArmed: function () { return armed; },
    keyTail: function () { return tail; },
    send: function (m) { setInput(m); return send(m); },
    reason: openReason, rerun: doRerun, fork: doFork,
    // The guard's own inputs, so a drive can prove WHEN it fires, not just that
    // a dialog appeared: false before the first message, true after it lands.
    hasConversation: hasConversation,
    getState: function () { return { appId: APP.id, desk: desk, armed: armed, tail: tail }; },
    // What the last send really saw on the in-tab event channel.
    get lastStream() { return LAST_STREAM; },
    // The same, for the last re-run: every status in arrival order.
    get lastRerun() { return LAST_RERUN; },
    // Everything the page holds, deep-serialized — the assertion that the key
    // never entered the recorded state, run against real bytes.
    dump: function () {
      var sessions = [];
      core.sessions.forEach(function (s) {
        sessions.push({ id: s.id, appId: s.appId, meta: s.meta, data: core.sessionToData(s),
          turns: s.chat.turns, reruns: Array.from(s.reruns.entries()) });
      });
      return safeStringify({ ui: { appId: APP.id, desk: desk, tail: tail }, sessions: sessions });
    },
  };

  // ═══ the thread ═════════════════════════════════════════════════════════
  var thread = [];
  if (sess) {
    parseSeed(sess.seed || [], APP.assistantLabel).forEach(function (m, i) {
      var cls = (m.role === 'user' ? 'msg-user' : 'msg-advisor') + ' seed';
      thread.push(m.role === 'user'
        ? e('div', { key: 'seed' + i, className: cls }, m.text)
        : e('div', { key: 'seed' + i, className: cls, dangerouslySetInnerHTML: md(m.text) }));
    });
    (sess.turns || []).forEach(function (t) {
      var key = desk.active + ':' + t.index;
      thread.push(e('div', { key: 'u' + t.index, className: 'msg-user' }, t.userMessage));
      thread.push(e('div', { key: 'a' + t.index, className: 'msg-advisor', 'data-testid': 'reply-' + key,
        dangerouslySetInnerHTML: md(t.reply) }));
      thread.push(e('button', { key: 'rb' + t.index, className: 'cd-reasonbtn', 'data-testid': 'reason-' + key,
        onClick: function () { openReason(desk.active, t.index); } }, 'visible reason'));
      var wf = desk.reruns[key];
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
          e('p', { className: 'whatif-frozen', 'data-testid': 'dispatches-' + key },
            wf.dispatched + ' new tool fetches during this re-run — the original turn\\u2019s tool results were replayed'),
          e('button', { className: 'cd-fork', 'data-testid': 'fork-' + key,
            onClick: function () { doFork(desk.active, t.index, wf.rerunId); } }, 'Continue from this version')));
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

  // Session tabs — the original conversation and every fork of it. There are no
  // cross-desk tabs: the other desk is its own page, one click back through the
  // gallery.
  var tabs = desk.order.map(function (id) {
    return e('button', { key: id, className: 'cd-tab' + (id === desk.active ? ' on' : ''), 'data-testid': 'tab-' + id,
      onClick: function () { panelRef.current = null; patch(function (d) { d.active = id; d.panelKey = null; return d; }); } },
      desk.sessions[id] ? desk.sessions[id].label : id);
  });

  var prov = sess && sess.forkOf
    ? e('p', { className: 'cd-prov' }, 'continued from the turn-' + (sess.forkOf.turnIndex + 1) + ' what-if · '
        + (sess.ignoredSourceIds || []).join(', ') + ' stays ignored for every later turn')
    : null;

  // The newest turn that recorded a verdict map drives the dots — and the same
  // shared ProvLegend the desk pages render draws them (see lib/page.js).
  // The verdict and its reason come off the SAME turn — never a word from one
  // reply explained by another reply's label.
  var lastProv = null;
  var lastLabels = null;
  var tks = (sess && sess.turns) || [];
  for (var li = tks.length - 1; li >= 0; li -= 1) {
    if (tks[li].provenance) { lastProv = tks[li].provenance; lastLabels = tks[li].sourceLabels || null; break; }
  }
  var legend = e(ProvLegend, {
    entityLabel: APP.entityLabel,
    entityValue: (sess && sess.entity) || APP.entityDefault,
    tools: APP.tools,
    provenance: lastProv,
    sourceLabels: lastLabels,
  });

  // ═══ custody panel / armed strip ════════════════════════════════════════
  var custody = armed
    ? e('div', { className: 'by-armed', 'data-testid': 'byok-armed' },
        e('span', null, 'key …' + tail + ' — in this tab'),
        // The armed strip answers the same question the checkbox asked, now that
        // the answer matters: this desk is one link away from the gallery.
        e('span', { className: 'by-armed-note' },
          remember
            ? 'remembered until you close this tab — the gallery and the other desk keep it'
            : 'kept in this page only — going back to the gallery clears it'),
        e('button', { 'data-testid': 'byok-forget', onClick: forget }, 'Forget my key'))
    : e('div', { className: 'by-custody', 'data-testid': 'byok-custody' },
        e('h2', null, 'Bring your own key'),
        e('div', { className: 'by-copy' }, DATA.custody.map(function (line, i) { return richLine(line, 'c' + i); })),
        // NO <form> element: no submit default, so nothing here can ever turn
        // into a GET navigation that puts a key in a URL.
        e('div', { className: 'by-form' },
          e('input', { type: 'password', autoComplete: 'off', spellCheck: 'false', ref: keyRef,
            'data-testid': 'byok-key', placeholder: 'sk-ant-…  (stays in this tab)',
            onKeyDown: function (ev) { if (ev.key === 'Enter') arm(); } }),
          e('button', { 'data-testid': 'byok-arm', onClick: arm }, 'Start chatting'),
          e('label', { className: 'by-remember' },
            e('input', { type: 'checkbox', 'data-testid': 'byok-remember', checked: remember,
              onChange: function (ev) { setRemember(ev.target.checked); } }),
            DATA.checkboxLabel)));

  var badgeText = MODEL + ' — direct from your browser · ' + (armed ? 'key …' + tail + ' in this tab' : 'no key yet');
  var badge = e('span', { className: 'cd-model' + (armed ? ' live' : ''), 'data-testid': 'model-badge',
    title: 'Every request from this page goes straight to api.anthropic.com with this model id' },
    e('span', { className: 'cd-dot ' + (armed ? 'live' : 'scripted') }), badgeText);

  var panelOpen = !!(desk.panelKey && desk.reason[desk.panelKey]);
  var panelInner = panelOpen
    ? e(InfluenceMap, { key: desk.panelKey, map: desk.reason[desk.panelKey].map,
        strategies: desk.reason[desk.panelKey].strategies,
        activeStrategy: desk.reason[desk.panelKey].map.rankedBy, onRerun: doRerun,
        view: 'bars', strategyControl: 'dropdown', brand: APP.title })
    : null;

  // ── the panel while a re-run is in flight (lib/page.js's, verbatim) ───────
  // The map NEVER goes away: it is the thing the re-run is about. What changes
  // is that the three controls that would invalidate the running probe freeze,
  // and one sticky line at the top says where the work actually is. Freezing is
  // not decoration: atui resets its own re-run state on any ignore toggle, so a
  // tap mid-flight erased the only "running" sentence AND let the finished
  // result land under a caption naming a different set of sources.
  var rerunOnThisPanel = !!(rerunLive && rerunLive.key === desk.panelKey);
  var rerunBusy = rerunOnThisPanel && !rerunLive.error;
  var freezeWhileRerunning = function (ev) {
    if (!rerunBusy) return;
    var hit = ev.target && ev.target.closest ? ev.target.closest('.inf-bar-ignore, .inf-toggle, .inf-rerun') : null;
    if (!hit) return;
    ev.preventDefault(); ev.stopPropagation();
  };
  var rerunNote = !rerunOnThisPanel ? null : (rerunLive.error
    ? e('div', { className: 'cd-rerun-err', 'data-testid': 'rerun-error' },
        'the re-run without ' + rerunLive.labels.join(', ') + ' did not finish \\u2014 ' + rerunLive.error
        + ' This map and your ignore toggles are unchanged, so Re-run works again.')
    : e('div', { className: 'cd-status cd-rerun-status', 'data-testid': 'rerun-status', role: 'status',
        'aria-live': 'polite' },
        e('span', { className: 'cd-pulse' }),
        rerunLive.status ? rerunLive.status.label : 're-run requested \\u2014 waiting for the first status'));

  var hasContent = sess && ((sess.turns && sess.turns.length) || (sess.seed && sess.seed.length) || liveTurn);
  var conversation = hasContent
    ? e('div', { className: 'cd-thread' }, thread)
    : e('div', { className: 'cd-empty-hint' }, armed
        ? 'Ask a question to begin. Every reply carries a “visible reason” button — tap it to see, as a ranked bar list, exactly which sources shaped the answer.'
        : 'Paste your Anthropic key above to start. Nothing is sent anywhere until you do.',
        // Only once a key can actually send them: an offer that would fail on
        // tap is worse than no offer. (The pack's own questions, one tap each —
        // the same component the server desks render.)
        armed ? e(Starters, { starters: APP.starters, variant: 'big', onPick: send }) : null);

  return e('div', { className: 'cd-app' + (panelOpen ? ' panel-open' : ''),
      style: { '--accent': APP.accent, '--accent-dk': APP.accentDark } },
    e('div', { className: 'cd-main' },
      e('div', { className: 'cd-bar' },
        // './index.html' — the bundle's own gallery home, one folder level, no
        // origin and no base path, so it resolves under /visible-reasoning/, at
        // a domain root and off file:// alike. SAME TAB on purpose: the gallery
        // is where the visitor came from and where the other desk is. The cost
        // of that (this page's memory is the conversation) is not hidden — see
        // onLeave: once there is something to lose, it asks first.
        e('a', { className: 'cd-back', href: './index.html', onClick: onLeave,
          'data-testid': 'back-to-gallery' }, '← gallery'),
        e('span', { className: 'cd-brand' }, 'Bring your own key ', e('span', { className: 'cd-mark' }, '·'), ' ', APP.title),
        e('span', { className: 'cd-tagline' }, APP.tagline),
        badge,
        // One small control; everything it opens lives inside the dialog.
        e(DebugControl, { turns: (sess && sess.turns) || [],
          loadArtifacts: sess ? function (k) { return getArtifacts(sess.id, k); } : null,
          artifactsKey: (sess && sess.id) || 'none',
          devViews: DEV_VIEWS, appName: APP.assistantLabel }),
        e('div', { className: 'cd-tabs' }, tabs)),
      e('div', { className: 'cd-scroll' },
        e('div', { className: 'cd-col' },
          custody,
          legend,
          prov,
          conversation,
          e('div', { className: 'by-foot', 'data-testid': 'byok-footer' },
            DATA.footer.map(function (line, i) { return richLine(line, 'f' + i); })))),
      e('div', { className: 'cd-composer' },
        e('div', { className: 'cd-composer-col' },
          // After the first turn the starters leave the transcript and live
          // here, in the composer, quietly — same component, compact size, and
          // exactly the composer's own enabled/disabled state.
          hasContent
            ? e(Starters, { starters: APP.starters, variant: 'compact',
                disabled: !armed || !!liveTurn, onPick: send })
            : null,
          e('div', { className: 'cd-inputrow' },
            e('input', { 'data-testid': 'chat-input', value: input, disabled: !armed || !!liveTurn,
              placeholder: armed ? APP.starters[0] : 'Paste your Anthropic key above to start',
              onChange: function (ev) { setInput(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === 'Enter') send(); } }),
            e('button', { 'data-testid': 'chat-send', disabled: !armed || !!liveTurn, onClick: send }, 'Send'))))),
    e('div', { className: 'cd-panel' + (panelOpen ? ' open' : ''), 'data-testid': 'reason-panel' },
      e('div', { className: 'cd-panel-head' },
        e('span', { className: 'cd-panel-title' }, 'Visible reason'),
        e('button', { className: 'cd-panel-close', 'aria-label': 'close', onClick: closePanel }, '×')),
      e('div', { className: 'cd-panel-body' },
        rerunNote,
        e('div', { className: 'cd-inf' + (rerunBusy ? ' busy' : ''),
          'aria-busy': rerunBusy ? 'true' : null,
          onClickCapture: freezeWhileRerunning, onKeyDownCapture: freezeWhileRerunning },
          panelInner))),
    e('div', { className: 'cd-backdrop' + (panelOpen ? ' show' : ''), onClick: closePanel }));
}

ReactDOMClient.createRoot(document.getElementById('root')).render(e(Byok));
`;
}

/** The page-safe slice of an app pack (no functions cross into the browser). */
export function packToPageData(app) {
  return {
    id: app.id, title: app.title, tagline: app.tagline, assistantLabel: app.assistantLabel,
    accent: app.accent, accentDark: app.accentDark,
    entityLabel: app.entity.label, entityDefault: app.entity.default,
    starters: app.starters, driver: app.driver,
    tools: app.tools.map((tool) => ({
      name: tool.name, legendLabel: tool.legendLabel, description: tool.description,
      alwaysSynthetic: tool.alwaysSynthetic === true,
    })),
  };
}

export const BYOK_COPY = {
  CUSTODY_COPY, COST_COPY, SCOPE_COPY, KEY_TRAVEL_COPY,
  CHECKBOX_LABEL, STOCK_NOTE, LEAVE_CONFIRM, BYOK_STATES,
};
