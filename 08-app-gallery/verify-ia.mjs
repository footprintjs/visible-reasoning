// The information-architecture gate — program notes on the landing, stage clean.
//
// The split this file defends: STATIC information (what an app is, how to read a
// provenance dot, what the buttons do, what a live run costs, where a key goes)
// belongs on the gallery landing; a desk carries only what is true RIGHT NOW
// (the conversation, live statuses, this turn's source states, the model badge).
//
// Three properties have to stay true or the split is decoration:
//
//   1. SINGLE SOURCE — the landing's guide is rendered from the same
//      PROVENANCE_HELP table and the same state→dot mapping the desks and the
//      BYOK dialog use, so a definition and a dot cannot drift apart;
//   2. THE STAGE IS CLEAN — every static element listed below is gone from the
//      desks, and the vocabulary is still exactly one tap away (the dialog's
//      guide link, which resolves on both transports);
//   3. BYOK IS UNTOUCHED — a public visitor arrives with no landing behind
//      them, so its dialog keeps BOTH sections;
//   4. A MISSING SOURCE SAYS WHY — the vocabulary word is static and lives on
//      the landing, but the reason a source fell back belongs to one reply, so
//      it travels with the turn to the dot and the dialog. A dot that says
//      "fallback" and nothing else is honest and useless.
//
//   node 08-app-gallery/verify-ia.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUTTON_HELP, HEADER_LINKS, LIVE_COST_LINE, PAPER_AUTHORS, PROVENANCE_CLOSING, PROVENANCE_EXAMPLE,
  PROVENANCE_HELP, PROVENANCE_PHILOSOPHY, STARTERS_CSS, buildAppPage, buildGalleryPage,
  provenanceHelpScript, question, startersScript, statesForBuild,
} from './lib/page.js';
import { APPS } from './apps/index.js';
import { provenanceFromToolLog, sourceLabelsFromToolLog } from './lib/mcp.js';
import { generate } from './byok.js';

const MODEL = 'claude-haiku-4-5-20251001';
const COST_NOTE = 'Live mode: each reply ≈ one small Haiku call per tool the agent consults';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const deskData = (model) => ({
  order: ['s1'], active: 's1', live: !!model, model, costNote: model ? COST_NOTE : '',
  sessions: { s1: { id: 's1', label: 'trip', forkOf: null, appId: 'trip', ignoredSourceIds: [], seed: [], entity: 'Mission Peak', turns: [] } },
  reason: {}, rerun: {},
});

console.log('=== IA VERIFY (landing = program notes, desk = stage) ===\n');

// The BYOK bundle, built ONCE into a SCRATCH directory, never out/: a gate
// reads, it does not write the tree it is judging. (out/byok is a build product
// of `npm run byok:build` and of verify-byok, which owns that artifact; this run
// must not race them or leave a diff behind.) The pages come back as strings —
// no round trip to disk. `index.html` is the public landing (checked beside the
// local one below); `trip.html` is a BYOK DESK, the stage section A3 judges.
const scratch = mkdtempSync(join(tmpdir(), 'vr-ia-byok-'));
let byokPages;
try {
  byokPages = generate({ quiet: true, outDir: join(scratch, 'byok') }).pages;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const byokHome = byokPages['index.html'];
const byok = byokPages['trip.html'];

// ═══ A1. the landing carries the vocabulary, single-sourced ═════════════════
const mockGallery = buildGalleryPage(APPS, { live: false, model: MODEL });
const liveGallery = buildGalleryPage(APPS, { live: true, model: MODEL });
// One note row, from its own anchor to the next row's. Both landings are the
// same components (lib/page.js's buildHome), so one reader serves both.
const noteOf = (html, id) => {
  const start = html.indexOf(`<div class="vr-note" id="${id}"`);
  if (start === -1) return '';
  const next = html.indexOf('<div class="vr-note"', start + 10);
  return html.slice(start, next === -1 ? undefined : next);
};
const guide = noteOf(mockGallery, 'guide');
const liveGuide = noteOf(liveGallery, 'guide');

ok(mockGallery.includes('id="guide"'), 'the landing has the stable #guide anchor the desks deep-link');
ok(guide.includes('how to read the demo'), 'the guide note is labeled “how to read the demo”');
// A GUIDE DEFINES ONLY WHAT ITS OWN BUILD CAN PRODUCE. The mock build calls
// nothing, so “live — real data fetched from the internet just now” is a word
// its desks can never say; the live build runs the real fetchers, so “scripted”
// is. statesForBuild() is the one place that fact is written, and the desks'
// dialogs read it too (buildAppPage), so a tooltip word and a definition cannot
// come apart.
const DOT_CLASS = { live: 'live', scripted: 'scripted', fallback: 'fallback', synthetic: 'synthetic', 'not consulted': 'notconsulted' };
for (const [build, html, body] of [['mock', mockGallery, guide], ['live', liveGallery, liveGuide]]) {
  const can = statesForBuild(build === 'live');
  for (const h of PROVENANCE_HELP) {
    const mine = can.includes(h.state);
    ok(body.includes(h.what) === mine && body.includes(`class="cd-dot ${DOT_CLASS[h.state]}"`) === mine,
      `[${build}] #guide ${mine ? 'carries' : 'omits'} the “${h.label}” definition — ${mine ? 'byte-equal from PROVENANCE_HELP' : 'this build cannot report it'}`);
  }
  ok(html.includes(`class="cd-dot ${DOT_CLASS[build === 'live' ? 'live' : 'scripted']}"`),
    `[${build}] the verdict this build DOES report is on the page`);
}
ok(guide.includes(PROVENANCE_CLOSING), '#guide carries PROVENANCE_CLOSING verbatim');
ok(guide.includes(PROVENANCE_PHILOSOPHY), '#guide carries the honesty-philosophy line');
ok(guide.includes(PROVENANCE_EXAMPLE), '#guide carries the synthetic-crowd worked example (moved off the footer)');
ok(!mockGallery.includes('always synthetic</strong>'), 'the old footer sentence is gone from the footer');

// THE COUNT IN THE PROSE IS THE COUNT ON THE PAGE. “where the data comes from”
// points two rows up at the guide and names how many labels are there; the
// number is derived from the same list that renders them, so this re-counts the
// rendered rows on every landing rather than trusting the sentence.
const guideDefRows = (body) => (body.match(/<div class="vr-defrow">/g) || []).length;
const spelledOut = (body) => Number((body.match(/The (\d+) labels are spelled out in/) || [])[1]);
for (const [name, html] of [['gallery mock', mockGallery], ['gallery live', liveGallery], ['byok home', byokHome]]) {
  const rows = guideDefRows(noteOf(html, 'guide'));
  const said = spelledOut(noteOf(html, 'data'));
  ok(rows > 0 && said === rows,
    `[${name}] “the N labels are spelled out in how to read the demo” names the number of definitions actually rendered`,
    `says ${said}, renders ${rows}`);
}

// the other program notes + their anchors
ok(mockGallery.includes('id="buttons"') && mockGallery.includes('<span>what the buttons do</span>'),
  'the landing has #buttons — what every control does');
for (const b of BUTTON_HELP) {
  ok(mockGallery.includes(b.name) && mockGallery.includes(b.what), `#buttons explains “${b.name}”`);
}
ok(mockGallery.includes('id="byok"') && mockGallery.includes('footprintjs.github.io/visible-reasoning'),
  'the landing has #byok — the take-home pointer at the public page');
ok(/\.vr-note \{ border-top: 1px solid var\(--hair\); scroll-margin-top: 18px; \}/.test(mockGallery),
  'anchored arrivals get scroll-margin so they do not sit flush against the viewport edge');

// ═══ A1b. ONE DESIGN, TWO LANDINGS ══════════════════════════════════════════
// Static information, so it belongs here by the same rule as the guide: it reads
// the same before the first message and after the hundredth. Both landings are
// lib/page.js's buildHome — neither has its own copy of the chrome or the text,
// so a claim can only be wrong in one place.
//
// The reveal gesture is asserted structurally on both: rows are authored OPEN
// (scripting off ⇒ the whole page still reads), the control is a native
// button[aria-expanded], and the fold is the grid-template-rows animation.
const NOTES = [
  'what is visible reasoning?', 'how to read the demo', 'what the buttons do', 'what a reply costs',
  'why this isn’t the model explaining itself', 'what the scores mean — and don’t',
  'where the data comes from', 'the paper &amp; the libraries',
];
for (const [name, html] of [['gallery', mockGallery], ['byok home', byokHome]]) {
  for (const l of HEADER_LINKS) {
    ok(html.includes(`<a href="${l.href}" target="_blank" rel="noopener"`),
      `[${name}] the page links ${l.label} in a new tab`);
  }
  for (const label of NOTES) ok(html.includes(`<span>${label}</span>`), `[${name}] the note “${label}” is on the page`);
  const rows = (html.match(/<div class="vr-note" id="/g) || []).length;
  const openRows = (html.match(/data-note-toggle aria-expanded="true"/g) || []).length;
  ok(rows === openRows && !html.includes('aria-expanded="false"'),
    `[${name}] every note ships open — with scripting off nothing is hidden`, `${openRows}/${rows}`);
  ok(html.includes('<button type="button" class="vr-note-btn" data-note-toggle')
    && html.includes('aria-controls="note-guide"'),
    `[${name}] the reveal is a native button, wired to the pane it controls`);
  ok(html.includes('[data-fold="on"][data-motion="on"] .vr-fold { transition: grid-template-rows')
    && html.includes('[data-fold="on"] .vr-note.is-open .vr-fold { grid-template-rows: 1fr; }'),
    `[${name}] the fold is the 0fr→1fr grid animation the design specifies`);
  ok(/@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\[data-fold="on"\]\[data-motion="on"\] \.vr-fold \{ transition: none; \}\s*\n\s*\[data-fold="on"\]\[data-motion="on"\] \.vr-fold-inner \{ transition: none; \}/.test(html),
    `[${name}] reduced motion turns the fold instant — and drops the hide delay with it`);
  // CSS OWNS VISIBILITY, so a fold that never animates still ends up hidden.
  // Double-clicking a row (or holding Enter) opens and closes it inside one
  // style recalc: grid-template-rows never changes, no transition starts, and a
  // transitionend-driven hide would never fire — leaving closed content visible
  // and back in the tab order. Here the hide follows .is-open, delayed by the
  // length of the fold rather than waiting on an event.
  ok(html.includes('[data-fold="on"] .vr-fold-inner { visibility: hidden; }')
    && html.includes('[data-fold="on"] .vr-note.is-open .vr-fold-inner { visibility: visible; transition: visibility 0s 0s; }')
    && html.includes('[data-fold="on"][data-motion="on"] .vr-fold-inner { transition: visibility 0s 0.28s; }'),
    `[${name}] closed content is hidden by the stylesheet, from .is-open alone — no transitionend to miss`);
  const js = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  ok(js.length > 0 && !/style\.visibility|transitionend/.test(js),
    `[${name}] no script on the page manages visibility or waits for a transition to end`);
  ok(html.includes('.vr-note.is-open { border-top-color: var(--terra-edge); }'),
    `[${name}] an open row shows the terracotta edge`);
  ok(html.includes('a:focus-visible, button:focus-visible { outline: 2px solid var(--terra)'),
    `[${name}] the focus ring is :focus-visible only, in the accent`);
  // The listing is the one bold moment, and every desk on it is a row.
  ok(html.includes('border-top: 4px double var(--rule)'), `[${name}] the desk listing keeps its double rule`);
  ok((html.match(/<h2 class="vr-deskname">/g) || []).length === 3,
    `[${name}] all three desks are listed — including the one that cannot run here`,
    String((html.match(/<h2 class="vr-deskname">/g) || []).length));
  // The notes are an ADDITION, not a replacement: the guide's definitions are
  // what a dot on a desk is checked against, and they stay exactly where they
  // were, rendered from the same table.
  ok(html.includes('id="guide"') && html.includes('how to read the demo'),
    `[${name}] the provenance guide survived the redesign, intact`);
  ok(html.indexOf('id="about"') < html.indexOf('id="guide"'),
    `[${name}] what-this-is reads before how-to-read-it`);
  ok(html.includes('github.com/footprintjs/visible-reasoning'),
    `[${name}] the source is reachable from the page body, not only the top rail`);
  ok(html.includes(PAPER_AUTHORS), `[${name}] the paper note credits every author, in order`);
  ok(html.includes('doi.org/10.1007/978-3-032-30849-8_1'), `[${name}] the paper note cites the DOI`);
}

// ═══ A4. the desk listing is build-honest ═══════════════════════════════════
// The listing alone — it ends where the program notes begin. The slice must stop
// there or a note's prose would be read as a desk's claim.
const listingOf = (html) => html.slice(html.indexOf('<section class="vr-desks"'), html.indexOf('<section class="vr-program"'));
const mockList = listingOf(mockGallery);
const liveList = listingOf(liveGallery);
ok(!mockList.includes('cd-dot live'), 'mock build: no source dot claims a live source');
ok(mockList.includes('cd-dot scripted') && mockList.includes('cd-dot synthetic'),
  'mock build: source dots are scripted (+ synthetic where the data is invented by design)');
ok(liveList.includes('cd-dot live') && liveList.includes('cd-dot synthetic'),
  'live build: source dots are live (+ synthetic by design)');
ok(!liveList.includes('cd-dot scripted'), 'live build: no source dot claims a scripted source');
ok(liveList.includes(`model: ${MODEL} — streamed token by token`), 'live desk facts name the real model');
ok(liveList.includes('tools served over MCP (real protocol frames)'), 'live desk facts claim MCP');
ok(liveList.includes('statuses and reply arrive as they happen'), 'live desk facts describe real streaming');
ok(mockList.includes('scripted mock — no model, no network'), 'mock desk facts claim no model');
ok(mockList.includes('scripted mock tools — no MCP server'), 'mock desk facts do NOT claim MCP');
ok(mockList.includes('real event order, paced for reading'), 'mock desk facts are honest about pacing');
ok((mockList.match(/every reply: visible reason → re-run without a source → fork/g) || []).length === APPS.length,
  're-run + fork is claimed on every desk, in every build');
// The starters under a desk are the pack's own, not copy written for the page.
for (const app of APPS) {
  for (const s of app.starters) {
    ok(mockList.includes(`“${s.replace(/"/g, '&quot;')}”`),
      `[${app.id}] the listing shows the pack's real starter “${s.slice(0, 30)}…”`);
  }
  // The pack's own words, cased as a sentence by the renderer (the design sets
  // this line as "Should I hike it?"; the pack writes it lowercase for the
  // desk's bar). Same words, same order — only the first letter is the page's.
  const asked = app.tagline.split('—')[0].trim();
  ok(mockList.includes(`“${question(app)}”`) && question(app).slice(1) === asked.slice(1),
    `[${app.id}] the one-liner is the pack's own tagline, not new copy — capitalized, not rewritten`,
    question(app));
  ok(!mockList.includes(`“${asked}”`), `[${app.id}] …and it is not the uncapitalized copy the design does not show`);
}
ok(liveGallery.includes(LIVE_COST_LINE) && !mockGallery.includes(LIVE_COST_LINE),
  'the live cost line is the cost note on live builds only');
ok(mockGallery.includes('This build spends nothing: no model is called and no source is fetched'),
  'the mock build says it spends nothing, instead of borrowing the live line');
// The local gallery routes to its own server and opens a deep-linked note; the
// public home does neither, and carries no second script at all.
ok(mockGallery.includes("document.querySelectorAll('[data-app]')") && mockGallery.includes("'/app/' + el.dataset.app"),
  'the local gallery re-points its desk links at the server routes when it is served');
ok(mockGallery.includes('if (btn && btn.getAttribute(\'aria-expanded\') !== \'true\') btn.click();'),
  'a deep link (#guide, from a desk’s dialog) opens that note instead of landing on a folded row');
ok((byokHome.match(/<script\b/g) || []).length === 1
  && (mockGallery.match(/<script\b/g) || []).length === 2,
  'the public home carries ONE script (the unfold); the local gallery adds only its routing',
  `${(byokHome.match(/<script\b/g) || []).length} vs ${(mockGallery.match(/<script\b/g) || []).length}`);

// ═══ A2. every desk is a stage ══════════════════════════════════════════════
const EMPTY_HINT = 'Ask a question to begin — or tap one of these.';
for (const app of APPS) {
  const mockDesk = buildAppPage(app, deskData(null));
  const liveDesk = buildAppPage(app, deskData(MODEL));
  ok(!mockDesk.includes('legend-help-defs'), `[${app.id}] the desk dialog has no definitions section`);
  ok(mockDesk.includes('legend-help-guide-link'), `[${app.id}] the desk dialog links to the gallery guide`);
  ok(mockDesk.includes("href: GALLERY_HREF + '#guide'"), `[${app.id}] the guide link resolves on both transports`);
  ok(mockDesk.includes('How to read these dots → the gallery guide'), `[${app.id}] the link says what it is`);
  // THE CONVERSATION SURVIVES THE PROGRAM NOTES. A desk's HTML is built once at
  // boot with its sessions baked in and re-served byte-identical on every GET,
  // so a same-tab trip to the guide and back would repaint the boot snapshot —
  // the visitor's turns vanish from the screen while the server session still
  // holds them, and the next reply answers a context they can no longer see.
  // A new tab is the cheap fix that works on BOTH transports (server and
  // file://): the desk is never navigated away from at all.
  ok(mockDesk.includes("target: '_blank'") && mockDesk.includes("rel: 'noopener'"),
    `[${app.id}] the guide opens in a NEW TAB — reading it never truncates the live desk`);
  ok(/target: '_blank', rel: 'noopener'/.test(mockDesk.slice(
    mockDesk.indexOf('legend-help-guide-link'),
    mockDesk.indexOf('How to read these dots'),
  )), `[${app.id}] it is the guide link itself that carries target/rel, not some other anchor`);
  ok(!mockDesk.includes(PROVENANCE_CLOSING), `[${app.id}] the static closing line is off the desk`);
  ok(!mockDesk.includes("e('span', { className: 'cd-tagline' }"), `[${app.id}] the tagline is off the desk bar`);
  ok(mockDesk.includes(EMPTY_HINT), `[${app.id}] the empty hint is the one runtime sentence`);
  ok(!mockDesk.includes('“visible reason” button — tap it to see'), `[${app.id}] the teaching sentence retired to #buttons`);

  // ── the starter pills ────────────────────────────────────────────────────
  // Tappable starters are a CONTROL, not copy: they are the composer's own job
  // (send this message) in a second shape, so they are not counted as static
  // chrome below — see the note on PROBES. What has to stay true is that they
  // are the pack's own questions, that there is only ever one set on screen,
  // and that tapping one is the same send() a typed message goes through.
  ok(mockDesk.includes("e(Starters, { starters: DATA.app.starters, variant: 'big'"),
    `[${app.id}] the empty state offers the pack's OWN starters, never page copy`);
  ok(mockDesk.includes("e(Starters, { starters: DATA.app.starters, variant: 'compact'"),
    `[${app.id}] …and they stay one tap away in the composer once the conversation starts`);
  ok(/hasContent\s*\n?\s*\?\s*e\(Starters, \{ starters: DATA\.app\.starters, variant: 'compact'/.test(mockDesk)
    && mockDesk.includes("e('div', { className: 'cd-empty-hint' },\n        'Ask a question to begin"),
    `[${app.id}] exactly one set is mounted at a time — big only when empty, compact only when not`);
  ok(mockDesk.indexOf("variant: 'compact'") > mockDesk.indexOf("e('div', { className: 'cd-composer' }")
    && mockDesk.indexOf("variant: 'compact'") < mockDesk.indexOf("'data-testid': 'chat-input'"),
    `[${app.id}] the compact row is part of the COMPOSER, above the box — not a line in the transcript`);
  ok(mockDesk.includes('onPick: send') && !/onPick: function/.test(mockDesk),
    `[${app.id}] a tapped pill goes through the desk's own send() — no shortcut path`);
  for (const s of app.starters) {
    ok(mockDesk.includes(JSON.stringify(s).slice(1, -1)),
      `[${app.id}] the desk carries the pack's starter “${s.slice(0, 34)}…” verbatim`);
  }
  ok(!liveDesk.includes("className: 'cd-banner'"), `[${app.id}] live build: the cost banner is gone`);
  ok(liveDesk.includes("' · ' + DATA.costNote"), `[${app.id}] live build: the cost fact is one hover away on the model badge`);
}

// ═══ A3. BYOK keeps both sections ═══════════════════════════════════════════
// `byok` is a BYOK DESK page (built above), not the bundle's home: the home is a
// landing (its own gallery, with its own #guide) and the desk is the stage this
// section judges. verify-byok.mjs owns the home's custody assertions.
ok(byok.includes('legend-help-sources'), 'BYOK desk dialog keeps the runtime sources section');
ok(byok.includes('legend-help-defs'),
  'BYOK desk dialog keeps the definitions — its home carries them too, but reaching it costs the conversation');
ok(!byok.includes('legend-help-guide-link'),
  'BYOK does not send a live conversation away to read a definition');
ok(byok.includes(PROVENANCE_CLOSING), 'BYOK keeps the closing line');
ok(byok.includes("e('span', { className: 'cd-tagline' }"), 'BYOK keeps its tagline — one desk, named in its own bar');
// The starters are the SAME control on both builds — one generator, one set of
// classes, one send path — offered only where a message can actually be sent.
ok(byok.includes("e(Starters, { starters: APP.starters, variant: 'big'")
  && byok.includes("e(Starters, { starters: APP.starters, variant: 'compact'"),
  'BYOK offers the same starter pills, from its pack’s own starters');
ok(byok.includes("armed ? e(Starters, { starters: APP.starters, variant: 'big'"),
  'BYOK offers them only once a key can send them — no button that would fail on tap');
ok(byok.indexOf("variant: 'compact'") > byok.indexOf("e('div', { className: 'cd-composer' }")
  && byok.indexOf("variant: 'compact'") < byok.indexOf("'data-testid': 'chat-input'"),
  'BYOK’s compact row is part of the composer too');

// ═══ B2. the starter pills, as a control ════════════════════════════════════
// One generator (lib/page.js startersScript) for both page shells, so these run
// once over the emitted component and hold on every desk of both builds.
const startersSrc = startersScript();
for (const [html, name] of [[byok, 'BYOK'], [buildAppPage(APPS[0], deskData(null)), 'desk']]) {
  ok(html.includes(startersSrc), `[${name}] renders the shared Starters component, byte for byte`);
}
ok(startersSrc.includes("type: 'button'"), 'the pills are real buttons (type=button — no form, no submit)');
ok(startersSrc.includes("role: 'group', 'aria-label': 'Starter questions'"),
  'the set is one labelled group, so a screen reader announces what these buttons are');
ok(startersSrc.includes('props.onPick(q)') && startersSrc.includes('disabled: disabled'),
  'a pill sends the question it shows, and goes dead exactly when the composer does');
ok(!startersSrc.includes('starters ||') || startersSrc.includes('var list = props.starters || [];'),
  'the component has no starter list of its own — no page copy can leak in through it');
ok(STARTERS_CSS.includes('.cd-starters button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }'),
  'keyboard focus is visible, in the accent — the same ring every other control uses');
ok(STARTERS_CSS.includes('flex-wrap: wrap') && STARTERS_CSS.includes('max-width: 100%'),
  'the pills wrap and never exceed the column — no horizontal overflow at 390px');
ok(/@media \(prefers-reduced-motion: reduce\) \{ \.cd-starters button \{ transition: none; \} \}/.test(STARTERS_CSS),
  'reduced motion switches the pills’ only transition off');

// ═══ C. noise metrics — the counts, not the direction ═══════════════════════
// "desk static element" = chrome whose content reads the same before the first
// message and on every later render.
//
// Every counter below is a substring probe over generated page source, which has
// one failure mode: rename the class or reword the sentence and the probe stops
// matching ANYTHING, so the count silently reads 0 and the gate goes green on a
// page that got noisier. The defense is the `alive` column — a probe that claims
// to measure a real element must still match on a page that really renders it,
// and the BYOK page is exactly that page: it deliberately kept every static
// element the desks shed, so it is the living "before" picture.
//
// NOT COUNTED, on purpose: the compact starter row. Every probe below is
// EXPLANATION — prose that teaches something the desk could instead show. The
// starter row is the composer's own control in a second shape (it does what the
// input + Send do, with the pack's own questions as its labels), which is the
// same reason the input, the Send button, the session tabs and the debug control
// have never been counted either. It is asserted as a control in section B2.
const PROBES = [
  { id: 'tagline', weight: 1, alive: true, match: (h) => h.includes("className: 'cd-tagline'") },
  { id: 'dot definition rows', weight: PROVENANCE_HELP.length, alive: true, match: (h) => h.includes('legend-help-defs') },
  { id: 'closing line', weight: 1, alive: true, match: (h) => h.includes(PROVENANCE_CLOSING) },
  { id: 'teaching sentence', weight: 1, alive: true, match: (h) => h.includes('“visible reason” button — tap it to see') },
  // Live-only, and no surface renders it any more — so it cannot be proven alive
  // by matching. Its rename/re-introduction risk is covered by the exact top-bar
  // class set below, which fails on ANY new bar chrome whatever it is called.
  { id: 'live cost banner', weight: 1, alive: false, liveOnly: true, match: (h) => h.includes("className: 'cd-banner'") },
  { id: 'guide link', weight: 1, alive: true, match: (h) => h.includes('legend-help-guide-link') },
];
const staticElements = (html, live) => PROBES.reduce(
  (n, p) => n + ((p.liveOnly && !live) || !p.match(html) ? 0 : p.weight), 0);

const deskMock = buildAppPage(APPS[0], deskData(null));
const deskLive = buildAppPage(APPS[0], deskData(MODEL));

// C0. the counters can still see. Without this, a class rename turns the whole
// section into a row of always-0 assertions that pass forever.
for (const p of PROBES.filter((x) => x.alive && x.id !== 'guide link')) {
  ok(p.match(byok), `the “${p.id}” counter still matches real output (BYOK renders it) — a rename would fail here, not read 0`);
}
ok(PROBES.find((p) => p.id === 'guide link').match(deskMock),
  'the “guide link” counter still matches real output (the desk renders it)');
ok(staticElements(byok, false) === 8,
  'the “8 before” figure is measured, not prose: BYOK still carries exactly the 8 static elements a desk used to',
  String(staticElements(byok, false)));

const afterMock = staticElements(deskMock, false);
const afterLive = staticElements(deskLive, true);
ok(afterMock === 1, 'desk static elements, mock build: 8 before → 1 after (the guide link)', String(afterMock));
ok(afterLive === 1, 'desk static elements, live build: 9 before → 1 after (the guide link)', String(afterLive));

const barOf = (html) => html.slice(
  html.indexOf("e('div', { className: 'cd-bar' }"), html.indexOf("e('div', { className: 'cd-scroll' }"));
const barChildren = (html) => ['cd-back', 'cd-brand', 'cd-tagline', 'cd-model', 'cd-tabs']
  .filter((c) => barOf(html).includes(`'${c}'`)).length;
ok(barChildren(deskMock) === 4, 'top-bar children: 5 before → 4 after (back · brand · badge · tabs)', String(barChildren(deskMock)));

// The bar's class set, exactly — the tripwire that does not depend on knowing
// the name of tomorrow's noise. Anything added to the top bar (a cost banner
// under any name, a new badge) fails this line and re-opens the conversation.
const BAR_CLASSES = ['cd-back', 'cd-bar', 'cd-brand', 'cd-dot', 'cd-mark', 'cd-model', 'cd-tabs'];
const barClasses = (html) => [...new Set(
  [...barOf(html).matchAll(/className: '(cd-[a-z-]+)/g)].map((m) => m[1]))].sort();
ok(barClasses(deskMock).join(' ') === BAR_CLASSES.join(' '),
  'the top bar carries EXACTLY the allowed chrome — a new static element there cannot slip in unnamed',
  barClasses(deskMock).join(' '));

const modalSections = (html) => (html.includes('legend-help-sources') ? 1 : 0) + (html.includes('legend-help-defs') ? 1 : 0);
ok(modalSections(deskMock) === 1, 'desk dialog sections: 2 before → 1 after (+1 link)', String(modalSections(deskMock)));
ok(modalSections(byok) === 2, 'BYOK dialog sections: 2 before → 2 after (unchanged)', String(modalSections(byok)));

// ═══ D. the build-time guards still bite ════════════════════════════════════
let threw = false;
try { provenanceHelpScript(['live'], { defs: false }); } catch { threw = true; }
ok(threw, 'hiding the definitions without a guide link is a BUILD ERROR, not a quiet omission');

// The landing render reads the same table the guard covers: a vocabulary entry
// with no dot class cannot reach a page, on either surface.
ok(PROVENANCE_HELP.every((h) => guide.includes(`class="cd-dot `)) && !guide.includes('cd-dot unknown'),
  'no landing definition fell through to the “unknown” dot');

// ═══ E. a missing source says WHY, not just that it is missing ══════════════
// The vocabulary word ("fallback") is static and lives on the landing. The
// REASON ("HTTP 404", "no Wikipedia page named like …") is runtime, belongs to
// exactly one reply, and therefore has to travel with the turn all the way to
// the dot. Without it the dot is honest but useless: a visitor can see that a
// source did not answer and has no way, short of reading code, to learn why.
const LOG = new Map([
  ['weather_forecast::{"place":"mission peak"}',
    'A Saturday forecast for mission peak could not be retrieved (illustrative — no signal).'
    + ' [source: synthetic fallback — HTTP 404]'],
  ['wiki_place::{"place":"mission peak"}', 'Mission Peak is a mountain peak east of Fremont. [source: live — Wikipedia — Mission Peak]'],
  ['crowd_level::{"place":"mission peak"}', 'mission peak is modeled as heavily busy. [source: synthetic — modeled crowd estimate, not measured]'],
]);
const NAMES = ['weather_forecast', 'wiki_place', 'crowd_level', 'never_called'];
const verdicts = provenanceFromToolLog(LOG, NAMES);
const reasons = sourceLabelsFromToolLog(LOG, NAMES);

ok(verdicts.weather_forecast === 'fallback' && reasons.weather_forecast === 'synthetic fallback — HTTP 404',
  'a fallback records BOTH the verdict word and the reason behind it', reasons.weather_forecast);
ok(verdicts.wiki_place === 'live' && reasons.wiki_place === 'live — Wikipedia — Mission Peak',
  'a live source records which page actually answered', reasons.wiki_place);
ok(verdicts.crowd_level === 'synthetic' && reasons.crowd_level === 'synthetic — modeled crowd estimate, not measured',
  'the always-synthetic source keeps saying what it is', reasons.crowd_level);
ok(verdicts.never_called === 'not consulted' && reasons.never_called === null,
  'a tool this turn never called has no reason to report, and none is invented');
// Read off the SAME sentence tail with the SAME convention agentthinkingui uses
// on an influence-panel snippet, so the legend dot and the panel row cannot
// disagree about what a source said about itself.
ok(NAMES.filter((n) => reasons[n]).every((n) => reasons[n].startsWith(verdicts[n] === 'fallback' ? 'synthetic fallback' : verdicts[n])),
  'the verdict word is the head of the recorded label — one string, read one way');

// Both surfaces hand the turn's reasons to the ONE shared legend, and the
// tooltip really composes them in.
for (const [name, html] of [['desk', deskLive], ['byok', byok]]) {
  ok(html.includes('sourceLabels: lastLabels'), `[${name}] the legend is given THIS turn's reasons`);
  ok(html.includes("sourceLabels: j.sourceLabels || null"), `[${name}] a committed turn carries its reasons with it`);
}
ok(deskLive.includes("body += ' · this reply: ' + detail"),
  'the dot tooltip composes the reason in — the shared provBody, one copy, both surfaces');

console.log(failed === 0
  ? '\nAll checks passed — the landing teaches, the desk performs, and neither invented its own vocabulary.'
  : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
