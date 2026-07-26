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
//      them, so its dialog keeps BOTH sections.
//
//   node 08-app-gallery/verify-ia.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUTTON_HELP, HEADER_LINKS, LIVE_COST_LINE, PROVENANCE_CLOSING, PROVENANCE_EXAMPLE, PROVENANCE_HELP,
  PROVENANCE_PHILOSOPHY, aboutCards, buildAppPage, buildGalleryPage, provenanceHelpScript,
} from './lib/page.js';
import { APPS } from './apps/index.js';
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
const guideOf = (html) => {
  const start = html.indexOf('id="guide"');
  return start === -1 ? '' : html.slice(start, html.indexOf('</section>', start));
};
const guide = guideOf(mockGallery);

ok(mockGallery.includes('id="guide"'), 'the landing has the stable #guide anchor the desks deep-link');
ok(guide.includes('How to read the demo'), 'the guide is titled “How to read the demo”');
for (const h of PROVENANCE_HELP) {
  ok(guide.includes(h.label) && guide.includes(h.what),
    `#guide carries the “${h.label}” definition byte-equal from PROVENANCE_HELP`);
}
ok(guide.includes(PROVENANCE_CLOSING), '#guide carries PROVENANCE_CLOSING verbatim');
ok(guide.includes(PROVENANCE_PHILOSOPHY), '#guide carries the honesty-philosophy line');
ok(guide.includes(PROVENANCE_EXAMPLE), '#guide carries the synthetic-crowd worked example (moved off the footer)');
for (const cls of ['cd-dot live', 'cd-dot scripted', 'cd-dot fallback', 'cd-dot synthetic', 'cd-dot notconsulted']) {
  ok(guide.includes(`class="${cls}"`), `#guide paints a real “${cls}” dot (same classes as a desk)`);
}
ok(!mockGallery.includes('always synthetic</strong>'), 'the old footer sentence is gone from the footer');

// the other two new sections + their anchors
ok(mockGallery.includes('id="buttons"') && mockGallery.includes('What the buttons do'),
  'the landing has #buttons — what every control does');
for (const b of BUTTON_HELP) {
  ok(mockGallery.includes(b.name) && mockGallery.includes(b.what), `#buttons explains “${b.name}”`);
}
ok(mockGallery.includes('id="byok"') && mockGallery.includes('footprintjs.github.io/visible-reasoning'),
  'the landing has #byok — the take-home pointer at the public page');
ok(/#guide, #about, #buttons, #byok \{ scroll-margin-top: 18px; \}/.test(mockGallery),
  'anchored arrivals get scroll-margin so they do not sit flush against the viewport edge');

// ═══ A1b. the header rail + the about deck, on BOTH landings ════════════════
// Static information, so it belongs here by the same rule as the guide: it reads
// the same before the first message and after the hundredth. Both surfaces are
// rendered from lib/page.js by both landings — neither has its own copy of the
// text, so a claim can only be wrong in one place.
const backsOf = (html) => [...html.matchAll(/<p class="ab-body">([\s\S]*?)<\/p>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').trim());
for (const [name, html] of [['gallery', mockGallery], ['byok home', byokHome]]) {
  for (const l of HEADER_LINKS) {
    ok(html.includes(`<a href="${l.href}" target="_blank" rel="noopener"`),
      `[${name}] the header rail links ${l.label} in a new tab`);
  }
  const titles = aboutCards({ desks: '', sources: '' }).map((c) => c.title);
  ok((html.match(/data-testid="about-card"/g) || []).length === titles.length,
    `[${name}] the about deck carries five cards`, String((html.match(/data-testid="about-card"/g) || []).length));
  for (const title of titles) ok(html.includes(title), `[${name}] the about deck carries the “${title}” card`);
  // Short enough to read standing up, long enough to say something. Measured on
  // the RENDERED back of each card, so the per-landing facts are counted too.
  const backs = backsOf(html);
  ok(backs.length === titles.length, `[${name}] every card has a back`, String(backs.length));
  backs.forEach((text, i) => {
    // Words, not tokens: a lone em dash is punctuation, not something to read.
    const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    ok(words >= 40 && words <= 70, `[${name}] “${titles[i]}” is a card, not an essay`, `${words} words`);
  });
  // The deck is an ADDITION, not a replacement: the guide's definitions are what
  // a dot on a desk is checked against, and they stay exactly where they were.
  ok(html.includes('id="guide"') && html.includes('How to read the demo'),
    `[${name}] the provenance guide survived the about deck, intact`);
  ok(html.indexOf('id="about"') < html.indexOf('id="guide"'),
    `[${name}] the about deck reads before the guide — what this is, then how to read it`);
  ok(html.includes('github.com/footprintjs/visible-reasoning'),
    `[${name}] the source is reachable from the page body, not only the header rail`);
  // The flip is progressive: the deck ships flat and the script stacks it, so
  // scripting off costs a visitor the animation, never the words.
  ok(html.includes('<div class="ab-deck" data-about-deck>') && !/<div class="ab-deck"[^>]*data-flip/.test(html),
    `[${name}] the deck ships flat — every back is readable with scripting off`);
}

// ═══ A4. the cards are build-honest ═════════════════════════════════════════
// The app-card grid alone — it now ends at the about deck, which sits between
// the cards and the guide. The slice must stop there or the deck's prose would
// be read as a card's claim.
const cardsOf = (html) => html.slice(html.indexOf('<div class="ag-grid">'), html.indexOf('<section class="ag-sec ag-about"'));
const mockCards = cardsOf(mockGallery);
const liveCards = cardsOf(liveGallery);
ok(!mockCards.includes('cd-dot live'), 'mock build: no card dot claims a live source');
ok(mockCards.includes('cd-dot scripted') && mockCards.includes('cd-dot synthetic'),
  'mock build: card dots are scripted (+ synthetic where the data is invented by design)');
ok(liveCards.includes('cd-dot live') && liveCards.includes('cd-dot synthetic'),
  'live build: card dots are live (+ synthetic by design)');
ok(!liveCards.includes('cd-dot scripted'), 'live build: no card dot claims a scripted source');
ok(liveCards.includes(`model: ${MODEL} — streamed token by token`), 'live capability strip names the real model');
ok(liveCards.includes('tools served over MCP (real protocol frames)'), 'live capability strip claims MCP');
ok(liveCards.includes('statuses and reply arrive as they happen'), 'live capability strip describes real streaming');
ok(mockCards.includes('scripted mock — no model, no network'), 'mock capability strip claims no model');
ok(mockCards.includes('scripted mock tools — no MCP server'), 'mock capability strip does NOT claim MCP');
ok(mockCards.includes('real event order, paced for reading'), 'mock capability strip is honest about pacing');
ok((mockCards.match(/every reply: visible reason → re-run without a source → fork/g) || []).length === APPS.length,
  're-run + fork is claimed on every card, in every build');
ok(!mockGallery.includes('class="ag-mcp"') && !mockGallery.includes('class="ag-model"'),
  'the two loose capability lines are gone — the strip replaced them');
ok(liveGallery.includes(LIVE_COST_LINE) && !mockGallery.includes(LIVE_COST_LINE),
  'the live cost line is small print under the lead on live builds only');

// ═══ A2. every desk is a stage ══════════════════════════════════════════════
const EMPTY_HINT = 'Ask a question to begin — or send the starter already in the box.';
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

console.log(failed === 0
  ? '\nAll checks passed — the landing teaches, the desk performs, and neither invented its own vocabulary.'
  : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
