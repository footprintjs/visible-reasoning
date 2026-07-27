// The bring-your-own-key bundle — out/byok/{index,trip,movies}.html.
//
//   buildByokLanding({ apps, stock, providers })          → index.html, the home
//   buildByokPage({ importMap, app, providers })           → one desk per app page
//
// Fully static pages where a conference visitor pastes THEIR OWN API key —
// Anthropic's, OpenAI's, or their own Azure OpenAI resource's — and gets the
// same desk experience as the gallery (chat → visible reason → verified what-if
// re-run → fork), with every byte of agent machinery running in the tab:
// agentfootprint's browser providers call that provider's API directly, the
// tools are client-side fetchers against keyless public APIs, and the influence
// graph is the same recordedChat wiring lib/chat-core.js already uses.
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
// static file; the only requests carrying a key go to THAT key's own provider —
// api.anthropic.com, api.openai.com, or the visitor's own Azure resource, one
// slot each and never crossed; the keys live in a module-scoped object and
// reach storage only behind an explicit checkbox. Every one of those is
// asserted in verify-byok.mjs and driven in a headless browser with fake keys.
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
  DEBUG_CSS, PROVENANCE_CSS, REPLY_ACTIONS_CSS, STARTERS_CSS, buildHome, codeSeg, debugModalScript,
  deskNote, orderForHome, programNotes, provenanceHelpScript, question, replyActionsScript,
  startersScript, t as tSeg,
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

// ─── THE PROVIDERS A VISITOR MAY BRING A KEY FOR ────────────────────────────
// Three, and each is here on evidence read out of the agentfootprint bytes this
// bundle vendors — a browser factory, a real tool-call path (these desks are a
// three-source comparison; a provider that cannot call tools cannot run one),
// real streaming, and a destination host the custody sentence can NAME.
//
//   Anthropic     browserAnthropic({ apiKey, defaultModel, parallelToolCalls })
//                 → api.anthropic.com. One tool per reply is enforced ON THE
//                 WIRE: `parallelToolCalls: false` puts
//                 `tool_choice.disable_parallel_tool_use` in the body
//                 (BrowserAnthropicProvider.js buildBody).
//   OpenAI        browserOpenai({ apiKey, defaultModel })
//                 → api.openai.com. Tools are real in both directions —
//                 `req.tools` becomes `body.tools`, and the SSE reader
//                 accumulates `delta.tool_calls` and hands them back on the
//                 terminal chunk (BrowserOpenAIProvider.js). It has NO
//                 parallel-tool-call option, so the page enforces the same rule
//                 on the response — see `oneToolPerStep` in the boot script.
//   Azure OpenAI  browserAzureOpenai({ endpoint, apiKey, apiVersion, deployment })
//                 → the visitor's OWN resource host. It wraps browserOpenai, so
//                 the body, streaming and tool logic are literally the same
//                 code; what it adds is the deployment-scoped URL and the
//                 `api-key` header. Azure's "model" IS the deployment name,
//                 which is why the dialog asks for one.
//
// NOT OFFERED HERE, and the dialog says so rather than leaving a visitor to
// wonder:
//   Amazon Bedrock  there is no browser Bedrock provider in agentfootprint —
//                   `browserBedrock` does not exist and BedrockProvider.js is
//                   the server adapter, on @aws-sdk/client-bedrock-runtime. So
//                   it is not a choice that was weighed and declined; there is
//                   nothing here to choose. Were one written, SigV4 would need
//                   long-lived AWS credentials living in a stranger's tab — a
//                   worse trade than an API key, not a better one. (The absence
//                   is asserted against the vendored bytes in verify-byok.mjs,
//                   so the copy cannot outlive the fact.)
//   Ollama          it listens on http://localhost, which an https page may not
//                   call.
// Both are ordinary options for agentfootprint on a server.
const AZURE_API_VERSION = '2024-12-01-preview';
// Azure's destination is the visitor's own resource, so no build-time string can
// name it. The copy carries this slot and the page fills it from the endpoint
// they typed — a custody sentence names the real host or it names nothing.
const AZURE_HOST_SLOT = '{azure-host}';
// …and until they name one there is no host to print, so the copy names the
// FIELD instead. TWO FORMS FROM ONE NOUN, because the same sentence is read in
// two places: inside the key dialog the endpoint field really is below it, and
// in the top bar (the model badge's hover, the Key button's title, an error) it
// is not — a sentence there that says "below" points at nothing.
const AZURE_RESOURCE_NOUN = 'the Azure resource you name';
const AZURE_HOST_FALLBACK = {
  dialog: `${AZURE_RESOURCE_NOUN} below`,
  elsewhere: `${AZURE_RESOURCE_NOUN} in the Key dialog`,
};

const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    // The compile-time destination inside agentfootprint's browser provider.
    host: 'api.anthropic.com',
    // UNCHANGED: the model this demo has always sent.
    model: 'claude-haiku-4-5-20251001',
    keyTitle: 'Your Anthropic key',
    keyPlaceholder: 'sk-ant-…',
    goesTo: 'Anthropic',
    console: 'Anthropic console',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    host: 'api.openai.com',
    // WHY THIS MODEL: the cheapest OpenAI model that does BOTH things these
    // desks depend on — function calling and token streaming — and the exact id
    // agentfootprint's own browser provider falls back to when a request names
    // no model (`defaultModel ?? 'gpt-4o-mini'`), so what this page sends and
    // what the vendored library would have chosen are the same thing.
    model: 'gpt-4o-mini',
    keyTitle: 'Your OpenAI key',
    keyPlaceholder: 'sk-…',
    goesTo: 'OpenAI',
    console: 'OpenAI usage dashboard',
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    host: AZURE_HOST_SLOT,
    // Azure has no model of ours to name: the deployment IS the model, and it
    // is the visitor's. The badge shows the deployment they typed.
    model: null,
    keyTitle: 'Your Azure OpenAI key',
    keyPlaceholder: 'your Azure OpenAI key',
    goesTo: 'your own Azure resource',
    console: 'Azure portal',
  },
];
const providerById = (id) => PROVIDERS.find((p) => p.id === id);

// The promise, authored ONCE. The Key control's title and the dialog's front
// line are both built from it in the page (see `promiseLine`), so the control
// and the dialog cannot come to say different things about where a key goes.
const KEY_PROMISE = 'Your key stays in your browser.';

// WHAT CHANGED, AND WHAT DID NOT. The key is kept in localStorage — on the
// visitor's own machine, surviving a reload and a restart, because a demo whose
// key has to be re-pasted between runs gets re-pasted on a projector. There are
// now three possible keys, one slot each. The custody guarantee is untouched by
// both facts, and it is the only thing this copy is for: a key goes to ITS OWN
// provider and to no origin of ours, ever. Where it rests is the visitor's disk;
// where it travels is the provider they picked. Both are said.
//
// THIS array is the GALLERY HOME's version — the home takes no key and knows no
// provider, so it names all three destinations. A desk knows exactly which key
// it is holding, and its dialog renders `custodyFor(provider)` instead: the same
// contract with that provider's own host in it.
const CUSTODY_COPY = [
  [b(KEY_PROMISE)],
  // The hosted line. This page is published to GitHub Pages, so a visitor's
  // first question is "who is hosting this, and what do they get?" — answered
  // before the mechanics. Pages serves the files and sees those file requests;
  // it never sees the key, because no request carrying the key goes to it.
  [
    t('This is a live public demo — it runs entirely in your browser. Your key goes only to the provider you pick; this site’s host (GitHub Pages) never receives it.'),
  ],
  [
    t('Every model call goes straight from your browser to that provider’s own API — '),
    code('api.anthropic.com'), t(', '), code('api.openai.com'), t(', or your own '),
    code('*.openai.azure.com'),
    t(' resource — our demo server never sees your key. It is not sent to us, not logged, and not put in any URL. With '),
    b('keep it in this browser'),
    t(' ticked it is saved in this browser’s own storage, on your machine, and stays there through a reload or a restart until you press Forget; untick it and the key is held in memory only and is gone the moment you reload. '),
    b('Forget my key'), t(' erases every provider’s key from both, instantly.'),
  ],
  [
    t('Each provider gets its own slot: an OpenAI key is used for OpenAI calls and nothing else, and switching provider never sends one provider’s key to another.'),
  ],
  [
    t('This page doesn’t even need our server: it is a plain static file — any dumb file host can serve it, and it chats just the same. That is the guarantee: there is no server code that '),
    em('could'), t(' see your key.'),
  ],
  [
    b('Don’t take our word for it'), t(' — open DevTools → Network and watch: the only requests that carry your key go to the provider you picked. Everything else is weather, Wikipedia and iTunes, called keylessly from your browser.'),
  ],
];

/**
 * THE SAME CONTRACT, FOR ONE PROVIDER — what a desk's dialog holds behind its
 * disclosure. Every sentence names THAT provider's destination, so a visitor
 * reading the fold with OpenAI selected is never shown Anthropic's promise, and
 * the "open DevTools and check" invitation is true for whichever key they hold.
 */
const custodyFor = (p) => {
  const dest = p.host;                       // the slot, for Azure; the host otherwise
  const lines = [
    [t(`This is a live public demo — it runs entirely in your browser. Your key goes only to ${p.goesTo}; this site’s host (GitHub Pages) never receives it.`)],
    [
      t('Every model call goes straight from your browser to '), code(dest),
      t(' — our demo server never sees your key. It is not sent to us, not logged, and not put in any URL. With '),
      b('keep it in this browser'),
      t(' ticked it is saved in this browser’s own storage, on your machine, and stays there through a reload or a restart until you press Forget; untick it and the key is held in memory only and is gone the moment you reload. '),
      b('Forget my key'), t(' erases every provider’s key from both, instantly.'),
    ],
    [t(`Each provider gets its own slot: your ${p.label} key is used for ${p.label} calls and nothing else, and switching provider never sends one provider’s key to another. Switch whenever you like — the next reply uses whichever provider is armed then, and the replies already on screen do not change.`)],
    [
      t('This page doesn’t even need our server: it is a plain static file — any dumb file host can serve it, and it chats just the same. That is the guarantee: there is no server code that '),
      em('could'), t(' see your key.'),
    ],
    p.id === 'azure'
      ? [t('What this desk sends is your deployment, by name — the top bar shows which — at api-version '),
        code(AZURE_API_VERSION), t('. Azure’s “model” is the deployment, so the deployment you name is the model you get.')]
      : [t('What this desk sends is '), code(p.model),
        t(` — the small, cheap model of that family, and the id in the top bar. Usage shows up in your ${p.console} like any other API traffic.`)],
  ];
  // ONE HONEST WART PER PROVIDER, where there is one — said here rather than
  // discovered as a red console line during a demo.
  //
  // OpenAI's is small but confusing: measured live from a browser origin, its
  // 401 for a WRONG key is the one response it serves without an allow-origin
  // header (a no-key or junk-bearer 401 has one, and so does the preflight), so
  // the browser refuses to show that reply and a typo arrives looking like a
  // dropped network. The page's own error message says the same thing.
  if (p.id === 'openai') {
    lines.push([
      t('One quirk worth knowing: if the key is wrong, a browser cannot show you OpenAI’s “incorrect API key” reply — that one response comes back without the header a browser needs, so a typo looks like a network failure. This page says so when it happens, rather than sending you to check your wifi.'),
    ]);
  }
  // The one provider whose door may be shut from the inside.
  if (p.id === 'azure') {
    lines.push([
      t('Azure is the one provider that may refuse this page: plenty of '), code('*.openai.azure.com'),
      t(' resources do not allow direct browser calls (CORS). That is your resource’s own setting, not this page’s — if the call cannot be made you are told exactly that, and your key still went nowhere.'),
    ]);
  }
  // WHAT IS NOT HERE, and the true reason first. Bedrock is not a choice this
  // page turned down — agentfootprint ships no browser Bedrock provider at all
  // (its Bedrock adapter is server-side, on the AWS SDK), so there is nothing to
  // offer. The custody argument is the answer to "then add one", and it comes
  // second because it is the weaker of the two facts, not the stronger.
  lines.push([
    t('Two more providers agentfootprint can drive on a server are not on this list. Amazon Bedrock is not offered because there is nothing to offer: the library has no browser Bedrock provider — and one would have to sign every request with long-lived AWS credentials living in your tab, which is a worse trade than an API key rather than a better one. Ollama listens on '),
    code('http://localhost'), t(', which an https page is not allowed to call. Both are ordinary options on a server.'),
  ]);
  lines.push([
    b('Don’t take our word for it'), t(' — open DevTools → Network and watch: the only requests that carry your key go to '),
    code(dest), t('. Everything else is weather, Wikipedia and iTunes, called keylessly from your browser.'),
  ]);
  return lines;
};

// What a reply spends. True on both surfaces, so both carry it — but neither
// stands it up as prose any more: on the landing it is the "what a reply costs"
// note, and on a desk it is the ⓘ beside a reply's "visible reason" button,
// which is where the question is actually asked (after a reply exists, about
// that reply). See USAGE_TITLE.
const COST_COPY = [
  t('Runs on your key: each reply is a handful of small model calls (one per source the agent consults, plus one to answer); a verified what-if re-run is a few more, replayed over the '),
  b('frozen'), t(' tool results of the original turn — zero new fetches, and the counter on the re-run card proves it. Usage appears in your own provider’s console like any other API traffic.'),
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
  t('You’ll pick your provider and add your key on the desk you open — this page never asks for either. Leave '),
  b('keep it in this browser'),
  t(' ticked, as it is by default, and the key is saved on your own machine: it rides with you back to this gallery, into the other desk, across a reload and across a restart, until you press Forget. Untick it and the key is held in memory only, so a reload clears it and the next desk asks again. Keys are kept one slot per provider, so bringing an OpenAI key never disturbs an Anthropic one.'),
];

// ─── THE KEY DIALOG'S FRONT LAYER ───────────────────────────────────────────
// The dialog used to open with FIVE paragraphs of custody prose before the
// visitor reached the field, and repeat the usage paragraph under the Save
// button. A person who opens it has already decided to paste a key; what they
// need first is the promise and the field, in that order.
//
// So: WHOSE key (the three-way choice), the promise, then the field. Everything
// else — the static-file argument, the DevTools invitation, "not logged, not in
// any URL", what ticking the box actually does, and what is NOT offered — is one
// click away, behind the dialog's own disclosure row (KEY_MORE_LABEL). Nothing
// was dropped; the usage paragraph is the single exception, and it did not
// vanish either: it is the ⓘ beside each reply's "visible reason" button, which
// is where the question is asked.
//
// The promise line is NOT authored here as a fixed string any more, because it
// names a destination and the destination is now the visitor's choice: the page
// builds it from KEY_PROMISE + that provider's host (`promiseLine`), and the Key
// control's title is the very same call — so the control and the dialog cannot
// come to say different things about where a key goes.
const KEY_MORE_LABEL = 'how this works — and how to check it';
// The picker's own label — what the three buttons are asking.
const PICKER_LABEL = 'Whose key are you bringing?';

const CHECKBOX_LABEL = 'Keep it in this browser (saved on this machine — still here after a reload or a restart, until you press Forget)';
const STOCK_NOTE = 'The SEC’s servers don’t allow browser calls, so the stock desk runs only in the server demo.';

// The header control's two states. The second is the one a demo lives in: the
// key is already there, and the control is still the way to replace or clear it.
const KEY_BTN_IDLE = 'Key';
const KEY_BTN_SET = 'Key saved · change';
const USAGE_TITLE = 'What this reply cost';

// Leaving a desk for the gallery is a page load: this page's memory — every turn,
// every fork — goes with it. Asked, once there is something to lose. The key is
// named in the same breath because it is the visitor's other live question.
const LEAVE_CONFIRM = 'Leaving resets this conversation — your key stays per your “keep it in this browser” choice.';

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
 * @param opts.providers  the provider table every desk in this bundle offers —
 *   the one place the model ids and the destination hosts are written down
 */
export function buildByokLanding({ apps, stock, providers = PROVIDERS }) {
  const named = (id) => providers.find((p) => p.id === id);
  // Four capability lines, all true of THIS bundle: a real model on the
  // visitor's key — theirs, from whichever of the three providers they bring —
  // a key path with no server of ours in it, real arrival streaming, and the
  // re-run/fork machinery every reply carries.
  const facts = [
    [tSeg(`your key, your provider — Anthropic (${named('anthropic').model}), `
      + `OpenAI (${named('openai').model}) or your own Azure OpenAI deployment`)],
    [tSeg('browser-direct: every model call goes from your tab to that provider’s own API — no server in between')],
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
    description: 'Two small advisors you can chat with on your own API key — Anthropic, OpenAI or '
      + 'Azure OpenAI — visible reasons, verified what-if re-runs, all in your browser.',
    favicon: FAVICON,
    kicker: 'DEMO · BRING YOUR OWN KEY',
    heading: 'Visible Reasoning — the app gallery',
    lead: [tSeg('Three real chat desks share one machine; every reply can be re-run without a source, '
      + 'to see what that source really changed.')],
    sub: [tSeg('Two of them run right here in your browser, on your own API key — Anthropic, OpenAI or Azure OpenAI — '),
      // Not "this tab" any more: a kept key outlives the tab by design. What is
      // still exactly true, and is the claim that matters, is that it never
      // leaves the browser it was typed into.
      { em: 'the key never leaves your browser.' }],
    // ONE ROW ABOVE THE DESKS, and it is the only one that earns the position:
    // a visitor is about to decide whether to bring a key here. The standing
    // "what is visible reasoning?" block that used to sit beside it is gone —
    // the desks are the demo, and the one sentence of what this is now reads
    // under the listing, with the paper (lib/page.js's colophon()).
    topNotes: [
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
          // Kept from the block that used to stand above the desks, because it
          // belongs to THIS argument: a page you are asked to trust with a key
          // should say where every byte of it came from.
          { p: [tSeg('Every file here — this page, the desks, the vendored library bytes — is '
            + 'generated from that repo and served as-is: '),
          { href: 'https://github.com/footprintjs/visible-reasoning', label: 'source on GitHub' },
          tSeg('.')] },
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
 * @param opts.providers  the provider table — id, label, destination host, model
 *   id and dialog copy for every provider this desk will accept a key for
 */
export function buildByokPage({ importMap, app, providers = PROVIDERS }) {
  const DATA = JSON.stringify({
    app,
    // THE PROVIDER TABLE, shipped as data so the page never invents one: an id,
    // the label a visitor reads, the DESTINATION HOST its custody sentence
    // names, and the model id its requests carry.
    providers,
    azureApiVersion: AZURE_API_VERSION,
    azureHostSlot: AZURE_HOST_SLOT, azureHostFallback: AZURE_HOST_FALLBACK,
    // The custody contract is rendered inside the key dialog — at the moment the
    // visitor decides to paste, and reachable again at any later moment, instead
    // of as a slab above a chat window that a returning visitor never re-reads.
    // TWO LAYERS, ONE CONTRACT: the promise is built in the page from
    // `keyPromise` + the chosen provider's host (so the front line and the Key
    // control's title are one call, not two strings); `custody` is the whole of
    // it, one click behind the dialog's own row — one array per provider, each
    // naming that provider's own destination.
    keyPromise: KEY_PROMISE,
    custody: Object.fromEntries(providers.map((p) => [p.id, custodyFor(p)])),
    moreLabel: KEY_MORE_LABEL, pickerLabel: PICKER_LABEL,
    // Still carried, and still rendered — as the ⓘ on each reply, never again as
    // a second paragraph under this dialog's Save button.
    usage: [COST_COPY],
    checkboxLabel: CHECKBOX_LABEL, leaveConfirm: LEAVE_CONFIRM,
    keyBtnIdle: KEY_BTN_IDLE, keyBtnSet: KEY_BTN_SET,
    usageTitle: USAGE_TITLE,
  });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app.title)} — bring your own key</title>
<meta name="description" content="${esc(app.tagline)} — on your own API key (Anthropic, OpenAI or Azure OpenAI), with visible reasons and verified what-if re-runs, all in your browser.">
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

  /* ── THE HEADER, MINIMAL. Left: the way back and the desk's name, with its
     session tabs. Right: what answered (the model badge) and the Key control.
     Nothing here teaches — the landing does that — and nothing here is per-turn:
     the reply carries its own controls. ── */
  .cd-bar { flex: 0 0 auto; display: flex; align-items: baseline; gap: 12px; padding: 12px 22px; border-bottom: 1px solid var(--line); }
  .cd-back { font-size: 12.5px; font-weight: 600; color: var(--muted); text-decoration: none; white-space: nowrap; }
  .cd-back:hover { color: var(--accent); }
  .cd-brand { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
  .cd-brand .cd-mark { color: var(--accent); font-weight: 700; }
  /* model badge — names what actually answers, and nothing else. It used to
     carry the provider sentence and the key's last four; both were custody copy
     wearing a badge, and both now live in the key dialog where they are read. */
  .cd-model { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
    color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
  .cd-model.live { color: #2C6B22; }
  .cd-tabs { display: flex; gap: 6px; flex-wrap: wrap; align-self: center; }
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
${REPLY_ACTIONS_CSS}

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

  /* ── BYOK-only chrome: the key control and the dialog behind it ─────────────
     Everything about the key is now ONE control and ONE dialog. The custody
     slab, the green armed strip and the small print under the transcript are
     gone from the page body: they were three standing explanations of a thing
     the visitor does once, and the page they stood on is a chat window. ── */
  .by-keyzone { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; align-self: center; }
  .by-keybtn { font: inherit; font-size: 11.5px; font-weight: 600; color: var(--muted);
    background: var(--bg); border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 10px; cursor: pointer; white-space: nowrap; }
  .by-keybtn:hover, .by-keybtn[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); }
  .by-keybtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* armed: the same chip, in the same green the model badge uses when it is live */
  .by-keybtn.on { color: #2C6B22; border-color: #C6E0C0; background: #F3F8F1; }

  /* the dialog's own form — the paste field, the checkbox, and the two verbs */
  .by-copy p { font-size: 12.5px; line-height: 1.6; color: var(--ink); margin: 0 0 8px; }
  .by-copy p:last-child { margin-bottom: 0; }
  /* the promise, and only the promise, above the field */
  .by-lead { font-size: 13px; line-height: 1.6; color: var(--ink); margin: 0; }

  /* ── THE DIALOG'S ONE DISCLOSURE ────────────────────────────────────────────
     The landing's note-row gesture, brought to the desk: a native
     button[aria-expanded], a mono-ish label with a +/− at the far right, and the
     same 0fr→1fr grid fold. It is the page's second use of ONE gesture, not a
     second gesture — and the content is AUTHORED INTO THE DOM either way, hidden
     by CSS from .is-open alone, so a fold that never animates still ends up
     hidden and out of the tab order (there is no transitionend to miss). ── */
  .by-more { margin: 14px 0 0; padding-top: 11px; border-top: 1px solid var(--line); }
  .by-more-btn { display: flex; justify-content: space-between; align-items: center; gap: 14px;
    width: 100%; padding: 4px 0; margin: 0; background: transparent; border: none; cursor: pointer;
    text-align: left; font: inherit; font-size: 12px; font-weight: 600; color: var(--muted); }
  .by-more-btn:hover { color: var(--accent); }
  .by-more-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .by-more-mark { font-size: 15px; line-height: 1; color: var(--accent); flex: none; }
  .by-more-fold { display: grid; grid-template-rows: 0fr;
    transition: grid-template-rows .24s cubic-bezier(.4, 0, .2, 1); }
  .by-more.is-open .by-more-fold { grid-template-rows: 1fr; }
  .by-more-inner { overflow: hidden; min-height: 0; visibility: hidden; transition: visibility 0s .24s; }
  .by-more.is-open .by-more-inner { visibility: visible; transition: visibility 0s 0s; }
  .by-more .by-copy { padding-top: 9px; }
  .by-more .by-copy p { color: var(--muted); }
  @media (prefers-reduced-motion: reduce) {
    .by-more-fold { transition: none; }
    .by-more-inner { transition: none; }
  }

  /* ── THE PROVIDER PICKER ────────────────────────────────────────────────────
     Three real radios in one group, wearing the page's pill. Native on purpose:
     arrow keys move between them, Space picks, a screen reader announces "1 of
     3", and the whole behaviour is the browser's rather than ours. The label
     they carry is the provider's name and nothing else — the destination is one
     line above, in the promise, where it belongs. ── */
  .by-picker { margin: 12px 0 0; }
  .by-picklbl { font-size: 11.5px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 7px; }
  .by-picks { display: flex; flex-wrap: wrap; gap: 7px; }
  .by-pick { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
    color: var(--muted); background: var(--bg); border: 1px solid var(--line); border-radius: 999px;
    padding: 6px 13px; cursor: pointer; }
  .by-pick:hover { color: var(--accent); border-color: var(--accent); }
  .by-pick.on { color: #fff; background: var(--accent); border-color: var(--accent-dk); }
  .by-pick input { margin: 0; accent-color: var(--accent-dk); }
  .by-pick:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }

  .by-keyform { margin: 14px 0 0; padding: 13px 0 0; border-top: 1px solid var(--line); }
  .by-keyform input[type=password] { width: 100%; padding: 10px 14px; border-radius: 999px;
    border: 1px solid var(--line); background: #fff; font-size: 14px; color: var(--ink); outline: none; }
  .by-keyform input[type=password]:focus { border-color: var(--accent); }

  /* Azure's two extra facts, and ONLY when Azure is the choice: which resource,
     and which deployment. They are the visitor's coordinates, not their secret —
     plain text fields, shown back to them, saved beside the key. */
  .by-azure { display: grid; gap: 9px; margin: 11px 0 0; }
  .by-field { display: block; font-size: 11.5px; font-weight: 600; color: var(--muted); }
  .by-field span { display: block; margin: 0 0 4px; }
  .by-field input { width: 100%; padding: 9px 14px; border-radius: 999px; border: 1px solid var(--line);
    background: #fff; font-size: 13px; font-weight: 400; color: var(--ink); outline: none; }
  .by-field input:focus { border-color: var(--accent); }
  .by-remember { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.5;
    color: var(--muted); margin: 11px 0 0; }
  .by-remember input { margin-top: 2px; flex: 0 0 auto; }
  .by-keyacts { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin: 13px 0 0; }
  .by-keyacts button { font: inherit; font-weight: 700; font-size: 13px; padding: 9px 18px;
    border-radius: 999px; border: none; background: var(--accent); color: #fff; cursor: pointer; }
  .by-keyacts button:hover { background: var(--accent-dk); }
  .by-keyacts button.by-forget { background: var(--bg); color: var(--muted); border: 1px solid var(--line); font-weight: 600; }
  .by-keyacts button.by-forget:hover { color: var(--accent); border-color: var(--accent); background: var(--bg); }
  .by-keytail { font-size: 12px; color: #2C6B22; font-weight: 600; margin-left: auto; }

  @media (min-width: 721px) {
    .cd-app.panel-open .cd-main { margin-right: min(480px, 100%); }
    .cd-backdrop { display: none; }
  }
  @media (max-width: 720px) {
    .cd-panel { width: 100%; box-shadow: none; }
    .cd-backdrop.show { opacity: 1; pointer-events: auto; }
    .cd-tab { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The bar wraps rather than dropping anything: the model badge is what
       answered and the Key control is how you change it, and neither can be
       hidden on the machine this demo is most often shown from. */
    .cd-bar { flex-wrap: wrap; row-gap: 8px; }
    .by-keyzone { margin-left: auto; }
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
import { browserAnthropic, browserAzureOpenai, browserOpenai } from 'agentfootprint/llm-providers';
import { createChatCore } from './app/lib/chat-core.js';
import { metrics } from './app/lib/mcp.js';
import { ${app.id} as PACK } from './app/apps/${app.id}.js';
import { makeBrowserCtx } from './app/byok/browser-ctx.js';
import { browserToolsFor } from './app/byok/tools.js';
import { createLocalApi } from './app/byok/local-api.js';

var DATA = ${DATA};
var PROVIDERS = DATA.providers;
var PROVIDER_IDS = PROVIDERS.map(function (p) { return p.id; });
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
${replyActionsScript()}

// ═══ KEY CUSTODY ═══════════════════════════════════════════════════════════
// The visitor's keys live HERE and nowhere else: ONE SLOT PER PROVIDER in this
// module's closure. A slot is handed to that provider's own factory and to
// nothing else — an OpenAI key can no more reach Anthropic than it can reach us,
// because the only read of a slot is by the id that names it. In particular no
// key ever enters footprint's SharedMemory, so no snapshot, commit log,
// influence map or export can contain one — that is a property of where the
// value lives, not a promise about what we do with it.
var KEYS = { anthropic: null, openai: null, azure: null };
var TAILS = { anthropic: '', openai: '', azure: '' };
// Which provider is armed. Module-scope for the same reason the keys are: the
// send path must read the CURRENT choice, never one React render behind.
var PROVIDER = PROVIDER_IDS[0];
// The visitor's own Azure coordinates. Not secrets — the resource they are
// calling and the deployment they are calling on it — but theirs, so they are
// kept and cleared exactly like the key beside them. Azure's "model" IS the
// deployment name, which is why the badge shows it.
var AZURE = { endpoint: '', deployment: '' };

// WHERE A KEPT KEY RESTS: localStorage, on the visitor's own machine, one named
// slot per provider, and nowhere else.
var SLOT = { anthropic: 'byok:key:anthropic', openai: 'byok:key:openai', azure: 'byok:key:azure' };
var PROVIDER_SLOT = 'byok:provider';
var AZURE_ENDPOINT_SLOT = 'byok:azure-endpoint';
var AZURE_DEPLOYMENT_SLOT = 'byok:azure-deployment';
// Older builds of this page kept ONE key under ONE name — first in
// sessionStorage, then in localStorage. This build reads NEITHER: both are
// erased on sight (see the auto-arm effect), so a browser that once ran an older
// page is never left holding a key nothing can see and nothing would erase. The
// cost is one re-paste, once; the alternative is a second copy of a key.
var LEGACY_SLOT = 'byok:anthropic-key';
var ALL_SLOTS = [SLOT.anthropic, SLOT.openai, SLOT.azure,
  PROVIDER_SLOT, AZURE_ENDPOINT_SLOT, AZURE_DEPLOYMENT_SLOT, LEGACY_SLOT];

function providerDef(id) {
  for (var i = 0; i < PROVIDERS.length; i += 1) if (PROVIDERS[i].id === id) return PROVIDERS[i];
  return PROVIDERS[0];
}

// ── WHERE THIS KEY WOULD GO, said in one place ─────────────────────────────
// Anthropic's and OpenAI's hosts are compile-time constants inside
// agentfootprint's own providers, and they are in the table above. Azure's is
// the visitor's OWN resource, so it is read off the endpoint they typed: a
// custody sentence names the real destination or it names nothing.
// ONE READING of the endpoint field, shared: the host named in the promise is
// parsed out of the very URL the request will be sent to (azureEndpointUrl), so
// the sentence and the wire cannot come apart — including over the https upgrade.
function azureHost() {
  var url = azureEndpointUrl();
  if (!url) return '';
  try { return new URL(url).host; } catch (err) { return ''; }
}
// Azure before the visitor has named a resource: there is no host to print, so
// the copy says where they will name one — and WHERE it says that depends on
// where it is being read. \`where === 'dialog'\` is the only surface with the
// fields actually below the sentence; everywhere else (the top bar's badge and
// Key button, an error message) points at the dialog by name instead of at
// empty space. Both forms come from the one noun — see AZURE_HOST_FALLBACK.
function destinationOf(id, where) {
  if (id !== 'azure') return providerDef(id).host;
  return azureHost() || (where === 'dialog' ? DATA.azureHostFallback.dialog : DATA.azureHostFallback.elsewhere);
}
// ONE SENTENCE, TWO SURFACES: the Key control's title and the dialog's front
// line are this call, so the control and the dialog cannot come to say different
// things — and whichever provider is selected, the sentence names ITS host.
function promiseLine(id, where) { return 'It goes only to ' + destinationOf(id, where) + ', never to this site.'; }
// The custody paragraphs behind the fold are authored per provider at build
// time; only Azure's destination is unknowable then, so the slot in its copy is
// filled here with the resource the visitor actually named.
function custodyLines(id) {
  var lines = DATA.custody[id] || [];
  if (id !== 'azure') return lines;
  var host = azureHost();
  return lines.map(function (segs) {
    return segs.map(function (s) {
      if (s.code !== DATA.azureHostSlot) return s;
      // The fold is inside the key dialog, where the fields ARE below.
      return host ? { code: host } : { t: DATA.azureHostFallback.dialog };
    });
  });
}

// The API base is a compile-time constant inside agentfootprint's browser
// providers (https://api.anthropic.com/v1/messages, https://api.openai.com/v1/
// chat/completions). The ONLY override is this in-page hook, read LAZILY at
// provider construction so a headless test can set it after load. It is
// deliberately NOT read from the query string: no query-string configuration
// exists on this page, so no crafted link can redirect a request that carries
// someone's key. Azure needs no hook — its destination is a field the visitor
// fills in themselves, in front of them, and the promise line names it back.
function apiUrlOverride() {
  var hook = window.__BYOK_TEST__;
  return hook && typeof hook.apiUrl === 'string' ? hook.apiUrl : null;
}

// The endpoint agentfootprint is handed for Azure: what the visitor typed,
// without a trailing slash — and ALWAYS over https.
//
// WHY THE SCHEME IS NOT THE VISITOR'S CHOICE. An Azure key travels as the
// \`api-key\` REQUEST HEADER, so an endpoint typed as \`http://…\` would put it on
// the wire in the clear, on whatever network the demo is being shown from. A
// bare hostname was already being upgraded to https; honouring an explicitly
// typed http:// meant the safer input got the safer treatment and the riskier
// one did not. So any scheme the visitor types is replaced with https — the
// same rule for every input, and the promise line names the host that results.
function azureEndpointUrl() {
  var raw = String(AZURE.endpoint || '').trim().replace(/\\/+$/, '');
  if (!raw) return '';
  return 'https://' + raw.replace(/^[a-z][a-z0-9+.-]*:\\/\\//i, '');
}

// ═══ ONE TOOL PER STEP — on the providers that cannot say it on the wire ════
// Anthropic gets \`parallelToolCalls: false\`, which puts
// \`tool_choice.disable_parallel_tool_use\` into the request body and lets the API
// itself return at most one tool call per reply. agentfootprint's browser OpenAI
// provider has no such option (its options are apiKey, defaultModel,
// defaultMaxTokens, apiUrl, organization, authScheme, reasoning — and nothing
// about parallel tool calls), and Azure wraps that same provider, so the rule is
// kept HERE instead, on the response.
//
// WHY IT MATTERS, precisely: when a model answers with three tool calls at once,
// the agent runs all three inside ONE iteration, and agentfootprint's influence
// report reads ONE tool result per stage (defaultSuspectClassifier takes
// \`lastToolResult\`) — so the panel would credit the LAST tool of the batch and
// silently drop the other two. A desk that really consulted three sources would
// show one bar, and the two it hid could be neither ignored nor re-run. That
// comparison is the demo, so this is not optional.
//
// The decorator is a plain provider wrapper: it sees the request and the
// response and NEVER the key — the key stays inside the factory's own closure,
// which is exactly why this is a wrapper and not a fetch hook. Dropping the
// extra calls is safe for the conversation because agentfootprint rebuilds the
// wire messages from ITS OWN transcript: the assistant turn it records carries
// the one call we kept, so the next request has one tool call and one tool
// result, and the model asks for the next source on the following step —
// exactly what Anthropic's own switch makes it do.
function firstToolCallOnly(res) {
  if (!res || !res.toolCalls || res.toolCalls.length < 2) return res;
  return Object.assign({}, res, { toolCalls: [res.toolCalls[0]] });
}
function oneToolPerStep(inner) {
  var wrapped = {
    name: inner.name,
    complete: function (req) { return inner.complete(req).then(firstToolCallOnly); },
  };
  if (inner.stream) {
    wrapped.stream = async function* (req) {
      for await (var chunk of inner.stream(req)) {
        yield chunk && chunk.response
          ? Object.assign({}, chunk, { response: firstToolCallOnly(chunk.response) })
          : chunk;
      }
    };
  }
  return wrapped;
}

// The model id every request carries. Azure has none of ours to send: the
// deployment IS the model, so the deployment the visitor named is what goes.
function modelFor(id) {
  return id === 'azure' ? (AZURE.deployment || 'azure') : providerDef(id).model;
}
// What the badge prints — the same id, except before an Azure deployment exists.
function modelLabel(id) {
  return id === 'azure' ? (AZURE.deployment || 'your deployment') : providerDef(id).model;
}

// ═══ WHICH PROVIDER ANSWERED — stamped on the turn, replayed from the turn ═══
// A reply is made by ONE provider on ONE model, and the visitor may switch the
// picker at any moment afterwards. So every turn is stamped as it runs (this is
// chat-core's \`currentProvider\` seam) and everything that runs that turn AGAIN —
// the what-if re-run's probes — is built from the stamp instead of from the
// picker. Without it, chatting on Anthropic and then re-running on OpenAI would
// put a different model's answer on the what-if card and call it this reply's
// counterfactual, which is the one thing this desk exists to show honestly.
//
// The stamp carries no secret: an id, a model id and — for Azure, whose "model"
// is a deployment on a resource the visitor names — the coordinates that pair
// with them. The key itself stays in KEYS, where nothing but this file's own
// factory call can read it.
function providerNow() {
  var id = PROVIDER;
  return {
    id: id,
    model: modelFor(id),
    endpoint: id === 'azure' ? azureEndpointUrl() : '',
    deployment: id === 'azure' ? AZURE.deployment : '',
  };
}
// The model id an agent is built with: a re-run gets the one recorded on the
// turn; a fresh send gets the one the armed provider serves.
function modelForRun(stamp) { return stamp && stamp.model ? stamp.model : modelFor(PROVIDER); }

// THE ONE SENTENCE A WHAT-IF GETS when the provider that made the reply is no
// longer armed. There is no second branch: we do not fall back to another
// provider, because an answer from a different model is not this reply's
// counterfactual and presenting it as one would be a lie told by the exact
// feature that is supposed to prove honesty.
function rerunRefusal(id) {
  return 'This reply was made on ' + providerDef(id).label + ' — arm that key again to re-run it. '
    + 'Nothing was re-run on another provider: a what-if answered by a different model is not this reply\\u2019s what-if.';
}
// …and the ordinary missing-key sentence, for a fresh send.
function armFirst(id) {
  return 'Add your ' + providerDef(id).label + ' key first — the Key button in the top bar.';
}
// Both of those are sentences THIS PAGE wrote about its own state, so the error
// carries a flag saying "print me as I am" — see failMessage. Without it a
// refusal could be dressed as a provider's reply, and the provider it would name
// is the one armed NOW, which in the case that matters is precisely the wrong one.
function refuse(message) {
  var err = new Error(message);
  err.plainSentence = true;
  return err;
}

// Split in two: failMessage builds the plain-words sentence; \`fail\` (in the
// component) shows it in a dialog, and the re-run shows the SAME SENTENCE inside
// the panel — a failed counterfactual must leave the map and the toggles
// standing, and a modal that has to be dismissed before you can look at either
// is the wrong shape for it.
//
// The words name the provider that actually answered, and the host that actually
// refused — a message that said "Anthropic" over an OpenAI failure would be the
// same kind of untruth as a custody sentence naming the wrong host. So the
// caller passes an id rather than letting this read the selection, and there are
// two of them because there are two ways to be wrong about it:
//   a SEND captures the id when the call is made (the key dialog stays reachable
//     while a reply is in flight, so the selection may have moved since);
//   a RE-RUN cannot use the selection at all — its probes ran on the provider
//     recorded on the turn, which chat-core stamps on the error (err.providerId).
function failMessage(err, sentWith) {
  var raw = String((err && err.message) || err);
  // A SENTENCE THIS PAGE WROTE ABOUT ITS OWN STATE goes out as it is. Two of
  // them exist (armFirst, rerunRefusal) and both are marked at the throw. It
  // matters most for a refused re-run: that sentence is about the provider
  // that MADE the reply, and dressing it as a provider's own words would put
  // the name of the one armed now — the wrong one — at the end of it.
  if (err && err.plainSentence) return raw;
  var status = err && err.status;
  var id = sentWith || PROVIDER;
  var who = providerDef(id);
  var host = destinationOf(id);
  var lead = null;
  if (status === 401 || status === 403
    || /\b401\b|\b403\b|authentication_error|invalid x-api-key|invalid_api_key|Access denied/i.test(raw)) {
    lead = who.label + ' rejected that key (' + (status || 401) + '). Check it and paste it again. '
      + 'Nothing was stored, and the key went nowhere except ' + host + '.';
  } else if (status === 429 || /\b429\b|rate_limit/.test(raw)) {
    lead = who.label + ' is rate-limiting this key (429). Wait a moment and send again.';
  } else if (status === 400 && /credit|billing|quota/i.test(raw)) {
    lead = who.label + ' will not run this key right now (billing or quota). Check your ' + who.console + '.';
  } else if (status === 404 && id === 'azure') {
    lead = 'Azure answered 404 for that deployment. Check the deployment name and the endpoint — '
      + 'Azure’s “model” is the deployment, and it is the one in the top bar.';
  } else if (/Failed to fetch|NetworkError|load failed/i.test(raw)) {
    lead = 'The call to ' + host + ' could not be read back. Your key went to ' + host
      + ' and nowhere else.';
    // WHY THIS BRANCH IS NOT JUST "check the network" for OpenAI.
    // Measured against the live API on 2026-07-27, from a browser origin:
    //   • OPTIONS preflight            → 200, access-control-allow-origin: <origin>,
    //                                    allow-headers content-type,authorization
    //   • POST with NO key / a junk    → 401 WITH access-control-allow-origin: *
    //     bearer                         (served by OpenAI's own proxy)
    //   • POST with a well-formed but   → 401 WITHOUT any allow-origin header
    //     WRONG sk-… key                  (a different layer answers it)
    // So a mistyped OpenAI key is invisible to a browser: it arrives as a bare
    // fetch failure, exactly like a dropped network. Saying "check the network"
    // would send a visitor to their wifi over a typo, so this says the likelier
    // thing first. Anthropic has no such wart — its 401 carries allow-origin.
    if (id === 'openai') {
      lead += ' A wrong key looks exactly like this from a browser: OpenAI leaves the CORS header off its '
        + '“incorrect API key” reply, so the browser refuses to show it. Check the key first, then the network.';
    }
    // The other refusal that is nobody's mistake: an Azure resource that does
    // not allow browser calls at all.
    if (id === 'azure') {
      lead += ' Azure resources often block direct browser calls (CORS) — that is a setting on your '
        + 'resource, not on this page.';
    }
  }
  return lead ? lead + '\\n\\n(' + who.label + ' said: ' + raw + ')' : raw;
}

// Called fresh per agent construction (lib/chat-core.js's makeProvider seam):
// swapping a key, or switching provider outright, takes effect on the very next
// send. Each branch hands ITS OWN slot to ITS OWN factory — there is no path
// here by which one provider's key reaches another's API.
//
// \`opts.provider\` is the turn's stamp and \`opts.replay\` says whether this is a
// re-run of a recorded reply. A re-run therefore builds the provider the reply
// was MADE with — including the Azure resource and deployment it was made on —
// and refuses in words when that key is gone.
function makeProvider(opts) {
  var stamp = (opts && opts.provider) || null;
  var id = stamp ? stamp.id : PROVIDER;
  var keyValue = KEYS[id];
  if (!keyValue) throw refuse(opts && opts.replay ? rerunRefusal(id) : armFirst(id));
  var url = apiUrlOverride();
  if (id === 'openai') {
    var oOpts = { apiKey: keyValue, defaultModel: providerDef('openai').model };
    if (url) oOpts.apiUrl = url;
    return oneToolPerStep(browserOpenai(oOpts));
  }
  if (id === 'azure') {
    var zOpts = { apiKey: keyValue, endpoint: (stamp && stamp.endpoint) || azureEndpointUrl(),
      apiVersion: DATA.azureApiVersion, deployment: (stamp && stamp.deployment) || AZURE.deployment };
    return oneToolPerStep(browserAzureOpenai(zOpts));
  }
  // parallelToolCalls: false — the browser half of the server desk's setting
  // (see lib/chat-core.js). One tool per reply, so each source lands on its own
  // agent iteration and the influence panel can name all three.
  var aOpts = { apiKey: keyValue, defaultModel: providerDef('anthropic').model, parallelToolCalls: false };
  if (url) aOpts.apiUrl = url;
  return browserAnthropic(aOpts);
}

// A kept key rests in localStorage, on the visitor's own machine, in the slot
// that names its provider — and nowhere else. It is a deliberate choice over
// tab-scoped storage: a key that evaporates on reload gets re-pasted in front of
// an audience, and a key typed in front of an audience is the real hazard. What
// does NOT change with it is the only thing that matters: no request carrying
// this key goes to any origin of ours, so nothing of ours can read what is
// written here, whatever it survives.
//
// ONE WRITER FOR A KEY, and this is it. Everything else that persists is
// settings — which provider was last armed, and the Azure coordinates — and it
// goes through rememberSetting, which is never handed a key.
function storedKey(id) {
  try { return window.localStorage.getItem(SLOT[id]); } catch (e) { return null; }
}
function rememberKey(id, k) { try { window.localStorage.setItem(SLOT[id], k); } catch (e) {} }
function rememberSetting(slot, value) { try { window.localStorage.setItem(slot, value); } catch (e) {} }
function readSetting(slot) { try { return window.localStorage.getItem(slot) || ''; } catch (e) { return ''; } }
function eraseStored(slots) {
  // Unconditional, and BOTH storages: "Forget" must mean forgotten, including
  // anything an older build of this page put in the other one.
  for (var i = 0; i < slots.length; i += 1) {
    try { window.localStorage.removeItem(slots[i]); } catch (e) {}
    try { window.sessionStorage.removeItem(slots[i]); } catch (e) {}
  }
}

// ═══ The machine — identical wiring to the server demo ═════════════════════
// Three seams instead of one string, and all three exist for the same fact: on
// this page the provider is the VISITOR'S choice and can change between a reply
// and its what-if. \`currentProvider\` stamps each turn with who answered it;
// \`makeProvider\` and \`model\` are then handed that stamp, so a re-run is built
// with the provider and model id of the reply it is a counterfactual OF — never
// with whatever the picker says now. lib/chat-core.js still accepts a plain
// string model and no factory, which is what every server path passes.
var ctx = makeBrowserCtx();
var core = createChatCore({ live: true, model: modelForRun, makeProvider: makeProvider, currentProvider: providerNow });
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

/** Render one rich-text line of the custody copy — lib/page.js's segment renderer. */
function richLine(segs, key) { return e('p', { key: key }, infoSegs(segs)); }

/**
 * The dialog's own disclosure — the landing's note row, on the desk.
 *
 * The content is always in the DOM and hidden by the stylesheet from
 * \`.is-open\` alone, exactly as the landing does it: scripting is what folds it,
 * not what hides it, and a fold that never animates still ends up hidden. React
 * owns only the boolean.
 */
function KeyMore(props) {
  var o0 = React.useState(false); var open = o0[0], setOpen = o0[1];
  return e('div', { className: 'by-more' + (open ? ' is-open' : ''), 'data-testid': 'key-more' },
    e('button', { type: 'button', className: 'by-more-btn', 'data-testid': 'key-more-toggle',
      'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'by-key-more',
      onClick: function () { setOpen(!open); } },
      e('span', null, props.label),
      e('span', { className: 'by-more-mark', 'aria-hidden': 'true' }, open ? '\\u2212' : '+')),
    e('div', { className: 'by-more-fold' },
      e('div', { className: 'by-more-inner', id: 'by-key-more' },
        e('div', { className: 'by-copy', 'data-testid': 'key-more-body' },
          (props.lines || []).map(function (line, i) { return richLine(line, 'm' + i); })))));
}

/**
 * THE KEY DIALOG — the one place a provider is chosen and a key is entered,
 * replaced or erased.
 *
 * TWO LAYERS, IN THE ORDER THE VISITOR NEEDS THEM. The promise first, in one
 * line, naming THE HOST THIS KEY WOULD GO TO; then whose key it is (three
 * radios); then the field, the checkbox and Save. Everything else that was
 * standing prose above the field — the static-file argument, the DevTools
 * invitation, "not logged, not in any URL", what ticking the box does, and the
 * two providers this page does NOT offer — is one click behind this dialog's own
 * disclosure row. Nothing was cut. The usage paragraph that used to repeat under
 * the Save button is gone from here on purpose: it belongs to a reply, and it is
 * the ⓘ on one.
 *
 * Azure asks for two more things — the resource endpoint and the deployment —
 * and asks ONLY when Azure is chosen, because for the other two providers there
 * is nothing to ask: their host is a constant inside the library.
 *
 * The dialog is reachable at any time from the header control, which is the
 * whole point — a demo gets re-run, and re-running it must not mean re-typing a
 * key on a projector.
 *
 * Everything about it is deliberately dumb: no <form> (so no submit default that
 * could put a key in a URL), the field is cleared the instant the key is taken,
 * and only the last four characters are ever shown back.
 *
 * Same chrome as every other dialog on the page (PROVENANCE_CSS's .cd-modal),
 * with the same Escape / backdrop / × / focus-trap behaviour.
 */
function KeyModal(props) {
  var boxRef = React.useRef(null);
  var fieldRef = React.useRef(null);
  var closeRef = React.useRef(props.onClose);
  closeRef.current = props.onClose;

  React.useEffect(function () {
    var box = boxRef.current;
    if (fieldRef.current) fieldRef.current.focus();
    else if (box) box.focus();
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

  function save() { props.onSave(fieldRef.current); }

  var def = providerDef(props.provider);
  var isAzure = props.provider === 'azure';

  return e('div', { className: 'cd-modal-wrap' },
    e('div', { className: 'cd-modal-backdrop', 'data-testid': 'key-backdrop',
      onClick: function () { closeRef.current(); } }),
    e('div', { className: 'cd-modal', role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'by-key-title', id: 'by-key', 'data-testid': 'key-modal',
        tabIndex: -1, ref: boxRef },
      e('div', { className: 'cd-modal-head' },
        e('h2', { className: 'cd-modal-title', id: 'by-key-title' }, def.keyTitle),
        e('button', { type: 'button', className: 'cd-modal-close', 'data-testid': 'key-close',
          'aria-label': 'close', onClick: function () { closeRef.current(); } }, '\\u00d7')),
      e('div', { className: 'cd-modal-body' },
        // THE PROMISE, and then the choice, and then the field. One line, because
        // the person who opened this came to paste a key — and the line names the
        // host THIS choice would send it to, so switching provider rewrites it.
        // 'dialog': the one surface where Azure's not-yet-named resource can be
        // pointed at as "below", because its field is.
        e('p', { className: 'by-lead', 'data-testid': 'key-lead' },
          infoSegs([{ b: DATA.keyPromise }, { t: ' ' + promiseLine(props.provider, 'dialog') }])),
        // WHOSE KEY. Three native radios in one group: arrow keys move, Space
        // picks, and a screen reader announces the group and the position.
        e('div', { className: 'by-picker' },
          e('div', { className: 'by-picklbl', id: 'by-key-picker' }, DATA.pickerLabel),
          e('div', { className: 'by-picks', role: 'radiogroup', 'aria-labelledby': 'by-key-picker',
            'data-testid': 'key-picker' },
            PROVIDERS.map(function (p) {
              return e('label', { key: p.id, className: 'by-pick' + (p.id === props.provider ? ' on' : '') },
                e('input', { type: 'radio', name: 'byok-provider', value: p.id,
                  'data-testid': 'provider-' + p.id, checked: p.id === props.provider,
                  onChange: function () { props.onProvider(p.id); } }),
                p.label);
            }))),
        // NO <form> element: no submit default, so nothing here can ever turn
        // into a GET navigation that puts a key in a URL.
        e('div', { className: 'by-keyform' },
          e('input', { type: 'password', autoComplete: 'off', spellCheck: 'false', ref: fieldRef,
            'data-testid': 'byok-key',
            placeholder: def.keyPlaceholder + (props.armed ? '  (paste a new key to replace it)' : ''),
            onKeyDown: function (ev) { if (ev.key === 'Enter') save(); } }),
          // Azure's two coordinates — asked for only when Azure is the choice,
          // and never hidden behind the fold: the endpoint IS the destination
          // the promise line above names.
          isAzure
            ? e('div', { className: 'by-azure', 'data-testid': 'azure-fields' },
                e('label', { className: 'by-field' },
                  e('span', null, 'Resource endpoint'),
                  e('input', { type: 'text', autoComplete: 'off', spellCheck: 'false',
                    'data-testid': 'azure-endpoint', value: props.azure.endpoint,
                    placeholder: 'https://my-co.openai.azure.com',
                    onChange: function (ev) {
                      props.onAzure({ endpoint: ev.target.value, deployment: props.azure.deployment });
                    } })),
                e('label', { className: 'by-field' },
                  e('span', null, 'Deployment name'),
                  e('input', { type: 'text', autoComplete: 'off', spellCheck: 'false',
                    'data-testid': 'azure-deployment', value: props.azure.deployment,
                    placeholder: 'gpt-4o-mini',
                    onChange: function (ev) {
                      props.onAzure({ endpoint: props.azure.endpoint, deployment: ev.target.value });
                    } })))
            : null,
          e('label', { className: 'by-remember' },
            e('input', { type: 'checkbox', 'data-testid': 'byok-remember', checked: props.remember,
              onChange: function (ev) { props.onRemember(ev.target.checked); } }),
            DATA.checkboxLabel),
          e('div', { className: 'by-keyacts' },
            e('button', { type: 'button', 'data-testid': 'byok-arm', onClick: save }, 'Save'),
            // Forget is offered whenever ANY provider holds a key, because it
            // erases all of them — a button that says "my key" while leaving two
            // others behind would be the lie this page exists not to tell.
            props.anyArmed
              ? e('button', { type: 'button', className: 'by-forget', 'data-testid': 'byok-forget',
                  onClick: props.onForget }, 'Forget my key')
              : null,
            // The only echo of a key anywhere on this page — four characters, of
            // the key for THIS provider, in the dialog the visitor opened, never
            // in the page chrome.
            props.armed
              ? e('span', { className: 'by-keytail', 'data-testid': 'byok-keytail' }, 'key \\u2026' + props.tail)
              : null)),
        // …and the rest of the contract, whole, one click away — this provider's.
        // No remount on a provider switch: an open fold stays open and its words
        // change under the visitor, which is exactly how you compare two
        // custody promises.
        e(KeyMore, { label: DATA.moreLabel, lines: custodyLines(props.provider) }))));
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

/** The render-side view of the key slots: which providers hold one, and its tail. */
function emptyKeyInfo() {
  var info = {};
  PROVIDER_IDS.forEach(function (id) { info[id] = { has: false, tail: '' }; });
  return info;
}

function Byok() {
  var d0 = React.useState(INITIAL); var desk = d0[0], setDesk = d0[1];
  // ONE ROW PER PROVIDER, never a single flag: "is a key armed" is a question
  // about the provider that is selected, and the answer must not be borrowed
  // from another provider's slot.
  var a0 = React.useState(emptyKeyInfo); var keyInfo = a0[0], setKeyInfo = a0[1];
  var p0 = React.useState(PROVIDER_IDS[0]); var provider = p0[0], setProviderSel = p0[1];
  var z0 = React.useState({ endpoint: '', deployment: '' }); var azure = z0[0], setAzureCfg = z0[1];
  var armed = !!keyInfo[provider].has;
  var tail = keyInfo[provider].tail;
  var anyArmed = PROVIDER_IDS.some(function (id) { return keyInfo[id].has; });
  // DEFAULT ON. This desk is shown from a stage: the common case is the same
  // person, the same machine, several runs, and a key they should type once.
  var r0 = React.useState(true); var remember = r0[0], setRemember = r0[1];
  // The key dialog's open state. It is also what a keyless Send opens — asking
  // for the missing thing beats a lecture about it.
  var k0 = React.useState(false); var keyOpen = k0[0], setKeyOpen = k0[1];
  var i0 = React.useState(''); var input = i0[0], setInput = i0[1];
  // The in-flight turn — user bubble at once, then the honest status row, then
  // the reply writing itself from Anthropic's own arrival cadence.
  var v0 = React.useState(null); var liveTurn = v0[0], setLiveTurn = v0[1];
  SET_LIVE = setLiveTurn;
  // The in-flight re-run: which panel it belongs to, the sources it is removing,
  // the latest real status, and — if it failed — the honest note.
  var x0 = React.useState(null); var rerunLive = x0[0], setRerunLive = x0[1];
  // Which turn the reason panel is showing, tracked in a ref as well as in
  // state: a re-run fired in the same tick as the reason that opened the panel
  // would otherwise read a render-old panelKey and silently do nothing.
  var panelRef = React.useRef(null);

  // A kept key arms itself on load — that is the whole point of the checkbox:
  // surviving a reload, a restart, and the gap between two rehearsals. Every
  // provider's slot is read, so switching provider after a reload finds the key
  // that belongs to it, and finds nothing when there is nothing.
  //
  // The legacy sweep is not defensive noise: two older builds of this page wrote
  // a key under a different name (one of them in sessionStorage), and this build
  // reads neither. Clearing them on sight means a browser that once ran an older
  // page is not left holding a key nothing can see and nothing would erase.
  React.useEffect(function () {
    eraseStored([LEGACY_SLOT]);
    var info = emptyKeyInfo();
    var found = false;
    PROVIDER_IDS.forEach(function (id) {
      var k = storedKey(id);
      if (k) { KEYS[id] = k; TAILS[id] = k.slice(-4); found = true; info[id] = { has: true, tail: TAILS[id] }; }
    });
    AZURE = { endpoint: readSetting(AZURE_ENDPOINT_SLOT), deployment: readSetting(AZURE_DEPLOYMENT_SLOT) };
    var last = readSetting(PROVIDER_SLOT);
    if (last && SLOT[last]) PROVIDER = last;
    setKeyInfo(info);
    setAzureCfg({ endpoint: AZURE.endpoint, deployment: AZURE.deployment });
    setProviderSel(PROVIDER);
    if (found) setRemember(true);
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
  // telemetry on this page. No provider's error body echoes a key back, and the
  // raw line is kept after the plain-words lead so a visitor can still see
  // exactly what the API said.
  function closePanel() {
    panelRef.current = null;
    patch(function (d) { d.panelKey = null; return d; });
  }
  var fail = function (err, sentWith) { window.alert(failMessage(err, sentWith)); };

  // ═══ arming / forgetting ════════════════════════════════════════════════
  // The argument is the dialog's own field, handed in by KeyModal — this
  // component never holds a reference to the input, so there is no path by which
  // a key could be read back out of the DOM after it is taken.
  //
  // EVERYTHING HERE IS SCOPED TO ONE PROVIDER, the selected one: its slot, its
  // storage, its tail. Saving an OpenAI key cannot touch an Anthropic one, and
  // only Forget (below) reaches across all three.
  function persist(id) {
    // The checkbox, honoured: ticked writes THIS provider's slot and the
    // settings beside it; unticked ERASES them — it does not merely skip a write.
    if (remember) rememberKey(id, KEYS[id]); else eraseStored([SLOT[id]]);
    var settings = id === 'azure'
      ? [PROVIDER_SLOT, AZURE_ENDPOINT_SLOT, AZURE_DEPLOYMENT_SLOT]
      : [PROVIDER_SLOT];
    if (!remember) { eraseStored(settings); return; }
    rememberSetting(PROVIDER_SLOT, id);
    if (id === 'azure') {
      rememberSetting(AZURE_ENDPOINT_SLOT, AZURE.endpoint);
      rememberSetting(AZURE_DEPLOYMENT_SLOT, AZURE.deployment);
    }
  }
  function arm(el) {
    var id = PROVIDER;
    var k = el && el.value ? el.value.trim() : '';
    // Azure is the one provider we cannot call on a key alone: without the
    // resource and the deployment there is no URL to send it to, so we say that
    // instead of failing later with a network error.
    if (id === 'azure' && !(AZURE.endpoint.trim() && AZURE.deployment.trim())) {
      window.alert('Azure needs both the resource endpoint and the deployment name — the two fields above.');
      return;
    }
    // Re-saving with an empty field while a key is already armed is the visitor
    // changing the checkbox (or their Azure coordinates), not a mistake: honour
    // the choice for the key held.
    if (!k) {
      if (!KEYS[id]) { window.alert('Paste your ' + providerDef(id).label + ' API key first.'); return; }
      persist(id);
      setKeyOpen(false);
      return;
    }
    KEYS[id] = k;
    TAILS[id] = k.slice(-4);
    persist(id);
    if (el) el.value = '';           // the key string leaves the DOM immediately
    setKeyInfo(function (info) {
      var next = Object.assign({}, info);
      next[id] = { has: true, tail: TAILS[id] };
      return next;
    });
    setKeyOpen(false);
  }
  // FORGET MEANS ALL OF THEM. The button says "my key"; a visitor who presses it
  // means every key they ever gave this page — so it clears every provider's
  // slot in memory, every slot in BOTH storages, the settings beside them and the
  // names two older builds used.
  function forget() {
    PROVIDER_IDS.forEach(function (id) { KEYS[id] = null; TAILS[id] = ''; });
    AZURE = { endpoint: '', deployment: '' };
    eraseStored(ALL_SLOTS);
    setKeyInfo(emptyKeyInfo());
    setAzureCfg({ endpoint: '', deployment: '' });
    setKeyOpen(false);
  }
  // Switching provider is a live change to what the next send will do, so the
  // module-scope selection moves with the rendered one — never a render behind.
  function chooseProvider(id) {
    PROVIDER = id;
    setProviderSel(id);
  }
  // The Azure coordinates are the visitor's, not secrets: kept in state so the
  // fields show them back, and mirrored into module scope because makeProvider
  // reads them at construction time.
  function changeAzure(cfg) {
    AZURE = { endpoint: cfg.endpoint, deployment: cfg.deployment };
    setAzureCfg({ endpoint: cfg.endpoint, deployment: cfg.deployment });
  }

  // ═══ the four calls — local functions, no HTTP, no server ═══════════════
  function send(explicit) {
    var msg = (typeof explicit === 'string' ? explicit : input).trim();
    if (!msg) return;
    // Guard on the KEY OF THE SELECTED PROVIDER, not on a rendered flag: KEYS is
    // the module-scope object that actually enables a call, and unlike a rendered
    // flag it is never one render behind. A key in another provider's slot is not
    // a key for this call and does not open the gate.
    //
    // NO KEY IS NOT AN ERROR, IT IS A MISSING STEP. The composer and the starter
    // pills stay live without one, and asking for it here — the dialog, opened
    // at the moment it is needed — beats a disabled box that explains itself in
    // a placeholder. The message is put in the composer rather than dropped, so
    // a tapped pill is still there to send once the key is in.
    if (!KEYS[PROVIDER]) { setInput(msg); setKeyOpen(true); return; }
    if (LIVE) return;                    // one in-flight turn per page
    // WHO THIS TURN IS BEING SENT WITH, captured now: the key dialog stays
    // reachable while a reply is in flight, so a failure must be narrated
    // against the provider that made the call, not the one on screen when it
    // came back. chat-core stamps the same id on anything it throws (the turn
    // may sit in the queue behind a re-run before it runs at all); this is the
    // fallback for a failure that never reached a turn.
    var sentWith = PROVIDER;
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
    }).catch(function (err) { done(); return fail(err, (err && err.providerId) || sentWith); });
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
    // NARRATE A FAILURE AGAINST THE PROVIDER THAT RAN THE PROBES — which is the
    // one recorded on the turn, not the one selected now. chat-core stamps it on
    // the error (err.providerId) because only it knows; the selection is the
    // fallback for anything thrown before a probe ever existed.
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
      setRerunLive({ key: key, labels: labels, status: null,
        error: failMessage(err, (err && err.providerId) || PROVIDER) });
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
  // It exposes a key's LAST FOUR characters at most — never a key.
  window.__byok = {
    appId: APP.id,
    // arm() takes the dialog's own field (KeyModal hands it in), so a drive
    // gives it an { value } — the exact shape the real control passes.
    arm: arm, forget: forget,
    openKey: function () { setKeyOpen(true); },
    isKeyOpen: function () { return keyOpen; },
    isArmed: function () { return armed; },
    remembers: function () { return remember; },
    keyTail: function () { return tail; },
    // The provider seam, so a drive can prove per-provider isolation the way a
    // visitor makes it: pick, save, pick again.
    provider: function () { return PROVIDER; },
    chooseProvider: chooseProvider,
    setAzure: changeAzure,
    azure: function () { return { endpoint: AZURE.endpoint, deployment: AZURE.deployment }; },
    model: function () { return modelFor(PROVIDER); },
    // Which slots hold a key — the FACT, never the value.
    armedProviders: function () {
      return PROVIDER_IDS.filter(function (id) { return !!KEYS[id]; });
    },
    send: function (m) { setInput(m); return send(m); },
    reason: openReason, rerun: doRerun, fork: doFork,
    // The guard's own inputs, so a drive can prove WHEN it fires, not just that
    // a dialog appeared: false before the first message, true after it lands.
    hasConversation: hasConversation,
    getState: function () {
      return { appId: APP.id, desk: desk, armed: armed, tail: tail,
        provider: PROVIDER, model: modelFor(PROVIDER) };
    },
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
      // The reply's own controls: its visible reason, the ⓘ that says what this
      // reply spent (the one page where that is the visitor's own money), and
      // the debug dialog opened AT THIS TURN.
      thread.push(e(ReplyActions, { key: 'rb' + t.index, turnKey: key, turnIndex: t.index,
        onReason: function () { openReason(desk.active, t.index); },
        usage: { title: DATA.usageTitle, lines: DATA.usage },
        turns: (sess && sess.turns) || [],
        loadArtifacts: sess ? function (k) { return getArtifacts(sess.id, k); } : null,
        artifactsKey: (sess && sess.id) || 'none',
        devViews: DEV_VIEWS, appName: APP.assistantLabel }));
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
  //
  // A one-tab strip is not a choice, it is a label — and it was printing the
  // desk's own name a second time, right beside the brand that already says it.
  // So the strip appears with the second session, which is the first moment
  // there is anything to switch between.
  var tabs = desk.order.length < 2 ? [] : desk.order.map(function (id) {
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

  // ═══ the key control, and the dialog behind it ══════════════════════════
  // ONE control, two states, always in the same place — so replacing a key
  // between two rehearsal runs is a click, not a scroll back through a page.
  // Both of its titles name the SELECTED provider, and the idle one makes the
  // custody promise in the same words the dialog's front line does, because it
  // is the same call (promiseLine) — with no 'dialog' placement, because this
  // one lives in the top bar and there is nothing below it to point at.
  var keyControl = e('button', { type: 'button',
    className: 'by-keybtn' + (armed ? ' on' : ''), 'data-testid': 'key-open',
    'aria-haspopup': 'dialog', 'aria-controls': 'by-key',
    'aria-expanded': keyOpen ? 'true' : 'false',
    title: armed
      ? 'Your ' + providerDef(provider).label + ' key — replace it, switch provider, or erase it from this browser'
      : 'Add your ' + providerDef(provider).label + ' key. ' + promiseLine(provider),
    onClick: function () { setKeyOpen(true); } },
    armed ? DATA.keyBtnSet : DATA.keyBtnIdle);

  // The badge names what answered, and stops there — and now it FOLLOWS THE
  // PROVIDER: the model id of whichever key is armed, which for Azure is the
  // visitor's own deployment. The provider sentence and the key's last four used
  // to ride along here; both are custody copy, and custody copy belongs in the
  // key dialog, where it is read. The hover names the destination in its
  // PLACELESS form (see destinationOf): this badge is in the top bar, so an
  // Azure resource that has not been named yet is pointed at by the dialog it is
  // named in, not by a "below" with nothing under it.
  var badge = e('span', { className: 'cd-model' + (armed ? ' live' : ''), 'data-testid': 'model-badge',
    title: 'Every request from this page goes straight to ' + destinationOf(provider) + ' with this model id' },
    e('span', { className: 'cd-dot ' + (armed ? 'live' : 'notconsulted') }), modelLabel(provider));

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
        : 'Ask a question to begin — the Key button, top right, is where your API key goes (Anthropic, OpenAI or Azure OpenAI). Nothing is sent anywhere until it does.',
        // Offered with or without a key. A tap without one is not a failure: it
        // opens the key dialog and keeps the question in the composer, so the
        // pill is still one press from sending. (The pack's own questions, one
        // tap each — the same component the server desks render.)
        e(Starters, { starters: APP.starters, variant: 'big', onPick: send }));

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
        // The tagline is off this bar. It reads the same before the first
        // message and after the hundredth, which is the test for program notes
        // — and the gallery's desk listing already carries it, verbatim.
        e('div', { className: 'cd-tabs' }, tabs),
        e('div', { className: 'by-keyzone' }, badge, keyControl)),
      e('div', { className: 'cd-scroll' },
        e('div', { className: 'cd-col' },
          legend,
          prov,
          conversation)),
      e('div', { className: 'cd-composer' },
        e('div', { className: 'cd-composer-col' },
          // After the first turn the starters leave the transcript and live
          // here, in the composer, quietly — same component, compact size, and
          // exactly the composer's own enabled/disabled state.
          hasContent
            ? e(Starters, { starters: APP.starters, variant: 'compact',
                disabled: !!liveTurn, onPick: send })
            : null,
          e('div', { className: 'cd-inputrow' },
            e('input', { 'data-testid': 'chat-input', value: input, disabled: !!liveTurn,
              placeholder: APP.starters[0],
              onChange: function (ev) { setInput(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === 'Enter') send(); } }),
            e('button', { 'data-testid': 'chat-send', disabled: !!liveTurn, onClick: send }, 'Send'))))),
    keyOpen
      ? e(KeyModal, { armed: armed, anyArmed: anyArmed, tail: tail, remember: remember,
          provider: provider, onProvider: chooseProvider, azure: azure, onAzure: changeAzure,
          onRemember: setRemember, onSave: arm, onForget: forget,
          onClose: function () { setKeyOpen(false); } })
      : null,
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

/**
 * THE PROVIDER TABLE — the one place the destinations, the model ids and the
 * dialog's per-provider words are written down. byok.js hands it to both
 * builders and verify-byok.mjs checks the generated pages against it (with the
 * three hosts hard-coded there as well, so a change here cannot silently
 * retarget a key without a gate saying so).
 */
export const BYOK_PROVIDERS = PROVIDERS;

export const BYOK_COPY = {
  CUSTODY_COPY, COST_COPY, SCOPE_COPY, KEY_TRAVEL_COPY, custodyFor,
  CHECKBOX_LABEL, STOCK_NOTE, LEAVE_CONFIRM, BYOK_STATES,
  KEY_PROMISE, PICKER_LABEL, AZURE_API_VERSION, AZURE_HOST_SLOT, AZURE_HOST_FALLBACK,
};
