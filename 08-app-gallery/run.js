// Example 8 — THE APP GALLERY (one visible-reason machine, three real chat apps).
//
// A cards landing page over three chat desks — a stock desk, a movie desk and a
// trip advisor — that share ONE machine (lib/chat-core.js, lifted from 07 and
// parameterized by app pack). The architectural step past 07: an app's context
// sources are no longer facts the host pins into the prompt, they are MCP TOOLS
// THE AGENT CALLS. One small local MCP server (mcp-server.js, official SDK,
// stdio) hosts every live fetcher; agentfootprint's mcpClient turns them into
// agent tools; a thin host decorator adds per-turn memoization (so a re-run
// replays the ORIGINAL turn's tool bytes — 0 new fetches, and a counter proves
// it), labeled fallbacks, and the dispatch count.
//
// Every tool sentence carries its own provenance label. The trip advisor's crowd
// estimate is SYNTHETIC BY CONSTRUCTION and says so in every mode — the honesty
// exhibit of the gallery.
//
//   node 08-app-gallery/run.js          → DEFAULT MODE: 1 scripted turn per app on
//                                          mock MCP tools + the byte-stable SUMMARY
//   node 08-app-gallery/run.js --serve  → generate out/*.html + serve on :4175
//   node --env-file=.env 08-app-gallery/run.js --serve --live
//                                       → real Anthropic (haiku) + the real MCP
//                                          server over stdio + keyless public APIs
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { encodeSSE } from 'agentfootprint/stream';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, appById } from './apps/index.js';
import { buildLiveClient, buildMockTools, decorateTools, metrics } from './lib/mcp.js';
import { createChatCore } from './lib/chat-core.js';
import { DEV_VIEWS_CSS, DEV_VIEWS_JS, ensureDevViews } from './lib/dev-views.js';
import { buildAppPage, buildGalleryPage } from './lib/page.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
// 4175 unless told otherwise. The override exists for one reason: a gate must
// be able to run while a rehearsal server is already sitting on the default
// port. Nothing else reads it, and the desks' own copy still names 4175.
const PORT = Number(process.env.VR_GALLERY_PORT || 4175);
// The model badge names what actually answers. Live turns go to THIS id (it is
// what Agent.create sends on every request); mock turns go to no model at all,
// and the pages say so rather than borrowing a real model's name.
const MODEL = 'claude-haiku-4-5-20251001';

const core = createChatCore({ live: LIVE, model: MODEL });

/** Boot the tool layer once, then hand each app its own subset (in pack order). */
async function bootTools() {
  const { client, tools } = LIVE ? await buildLiveClient() : await buildMockTools();
  const decorated = decorateTools(tools, core.getPending);
  const byName = new Map(decorated.map((t) => [t.schema.name, t]));
  const perApp = new Map();
  for (const app of APPS) {
    const subset = app.tools.map((t) => {
      const hit = byName.get(t.name);
      if (!hit) throw new Error(`MCP server did not serve tool '${t.name}'`);
      return hit;
    });
    perApp.set(app.id, subset);
  }
  return { client, perApp, served: decorated.map((t) => t.schema.name) };
}

const startSession = (app, perApp, label = app.title) =>
  core.newSession({ pack: app, label, chat: core.makeChat(app), decoratedTools: perApp.get(app.id) });

// ═══ DEFAULT MODE — the gated, byte-stable summary ═══════════════════════════
async function defaultMode() {
  const { perApp } = await bootTools();
  const must = (cond, msg) => { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); };

  const rows = [];
  const bySession = new Map();
  for (const app of APPS) {
    const session = startSession(app, perApp);
    bySession.set(app.id, session);
    const turn = await core.chatTurn(session, app.story[0]);
    const { map } = await core.reasonAbout(session, 0);
    rows.push({ app, turn, map });
    must(app.decisionWords.test(turn.reply), `${app.id} reply should carry a decision word`);
    must(map.sources[0].id === app.driver, `${app.id} top influence should be ${app.driver}`);
    must(map.sources[0].kind === 'tool', `${app.id} top influence should be a tool source`);
  }

  // The ONE gated counterfactual: the movie desk, without its reception source.
  const movies = APPS.find((a) => a.id === 'movies');
  const moviesSession = bySession.get('movies');
  const dispatchesBefore = metrics.toolDispatches;
  const { result: rerun } = await core.rerunTurnK(moviesSession, 0, [movies.driver]);

  must(rows[0].turn.reply.includes('BUY'), 'stocks reply should be BUY');
  must(rows[1].turn.reply.includes('WATCH'), 'movies reply should be WATCH');
  must(rows[2].turn.reply.includes('GO'), 'trip reply should be GO');
  must(rerun.answer.includes('SKIP'), 'movies what-if should be SKIP');
  must(rerun.whatChanged.answerFlipped === true, 'movies re-run should flip the decision');
  must(rerun.verdict?.verdict === 'confirmed', 'movies verdict should be confirmed');
  must(metrics.toolDispatches - dispatchesBefore === 0, 're-run must dispatch ZERO MCP tool calls');

  const top = (m) => `${m.sources[0].id} [${m.sources[0].kind}] score ${m.sources[0].score.toFixed(3)}`;
  console.log('=== SUMMARY ===');
  console.log('the app gallery: 3 apps, one scripted turn each (mock provider, mock MCP tools)');
  for (const { app, turn, map } of rows) {
    console.log(`[${app.id}] Q: ${turn.userMessage}`);
    console.log(`[${app.id}] reply: ${turn.reply}`);
    console.log(`[${app.id}] top influence: ${top(map)}`);
  }
  console.log(`[movies] ignored source: ${movies.driver}`);
  console.log(`[movies] what-if reply: ${rerun.answer}`);
  console.log(`[movies] flipped: ${rerun.whatChanged.answerFlipped}`);
  console.log(`[movies] verdict: ${rerun.verdict.verdict}`);
  console.log('=== END ===');
}

// ═══ SERVE MODE ══════════════════════════════════════════════════════════════
function costNote() {
  return 'Live mode: each reply ≈ one small Haiku call per tool the agent consults, plus one to answer; '
    + 'a baseline-checked Re-run is a handful more and replays the frozen tool results of the original '
    + 'turn — 0 new fetches (the dispatch counter prints the proof); forking costs nothing until you '
    + 'chat in it. Tool data comes from keyless public APIs over MCP with a 4s timeout and labeled '
    + 'fallbacks; the trip advisor’s crowd estimate is always synthetic.';
}

// The ONE chat response body. `/chat`'s 200 and `/chat-stream`'s `final` frame
// are the same bytes by construction — a visitor who falls back to the plain
// endpoint gets a payload the page cannot tell apart.
const chatPayload = (session, turn) => {
  const m = session.meta[turn.index] ?? {};
  return {
    sessionId: session.id, turnIndex: turn.index, reply: turn.reply,
    label: session.label, forkOf: session.forkOf, ignoredSourceIds: session.excludedIds,
    entity: m.entity ?? session.entity, provenance: m.provenance ?? null,
    sourceLabels: m.sourceLabels ?? null,
    // The debug view's data rides the reply it describes. It is derived from
    // the turn's own frozen recording (lib/debug-view.js), so it costs no model
    // call and no fetch — and shipping it here is why the modal never has to ask
    // the server for anything.
    debug: core.debugFor(session, turn.index),
  };
};

// ─── The status vocabulary: real events only ────────────────────────────────
// Every wire `status` frame is 1:1 with an event the agent's own dispatcher
// produced. There is no status without an event, and no event outside this map
// makes one. A `tool_end` WITHOUT an error deliberately produces nothing: the
// next real event replaces the line, which is honest — the agent moved on.
const plainToolNames = (app) =>
  new Map(app.tools.map((t) => [t.name, t.legendLabel ?? t.name.replace(/_/g, ' ')]));

/**
 * Build the event→frame mapper for one streamed turn.
 * @param plain  toolName → the pack's human label
 * @param frame  (name, payload) => void — writes one SSE frame
 */
function statusMapper(plain, frame) {
  const nameOf = new Map();  // toolCallId → toolName, learned on tool_start
  const label = (name) => plain.get(name) ?? String(name).replace(/_/g, ' ');
  return (e) => {
    const p = e.payload ?? {};
    if (e.type === 'agentfootprint.stream.llm_start') {
      frame('status', { kind: 'thinking', label: 'thinking…' });
    } else if (e.type === 'agentfootprint.stream.tool_start') {
      nameOf.set(p.toolCallId, p.toolName);
      frame('status', { kind: 'tool', tool: p.toolName, label: `consulting ${label(p.toolName)}…` });
    } else if (e.type === 'agentfootprint.stream.tool_end' && p.error) {
      // Rare by design: the tool decorator turns fetch failures into labeled
      // fallback SENTENCES (a normal result), so this only fires if the
      // decorator itself threw. Mapped anyway — honesty over tidiness.
      const name = nameOf.get(p.toolCallId) ?? 'a source';
      frame('status', { kind: 'tool', tool: name, label: `${label(name)} hit an error — answering without it` });
    } else if (e.type === 'agentfootprint.stream.token') {
      frame('token', { i: p.tokenIndex, text: p.content });
    }
  };
}

/** Mock serve: pre-run each app's scripted story so every page opens mid-story. */
async function buildStories(perApp) {
  const out = new Map();
  for (const app of APPS) {
    const session = startSession(app, perApp);
    await core.chatTurn(session, app.story[0]);
    const data = { order: [session.id], active: session.id, live: false, model: LIVE ? MODEL : null,
      costNote: '', sessions: {}, reason: {}, rerun: {} };
    const r = await core.reasonAbout(session, 0);
    data.reason[`${session.id}:0`] = { map: r.map, strategies: r.strategies };
    if (app.id === 'movies') {
      // Pre-run the gated what-if so the flip is visible the moment the page opens.
      const { rerunId, result } = await core.rerunTurnK(session, 0, [app.driver]);
      data.rerun[`${session.id}:0`] = {
        rerunId, ignoredIds: [app.driver],
        ignoredLabels: core.labelsFor(await core.getReport(session, 0), [app.driver]), result,
      };
    }
    data.sessions[session.id] = core.sessionToData(session);
    out.set(app.id, data);
  }
  return out;
}

async function serveMode() {
  const { client, perApp, served } = await bootTools();
  console.log(`MCP tool source: ${LIVE ? 'mcpClient (stdio subprocess → mcp-server.js)' : 'mockMcpClient (in-memory)'} `
    + `— ${served.length} tools: ${served.join(', ')}`);

  let pages;
  if (LIVE) {
    // Live boot: skip the pre-runs (cost). Open every desk empty, with the banner.
    pages = new Map();
    for (const app of APPS) {
      const session = startSession(app, perApp);
      pages.set(app.id, { order: [session.id], active: session.id, live: true, model: LIVE ? MODEL : null,
        costNote: costNote(), sessions: { [session.id]: core.sessionToData(session) }, reason: {}, rerun: {} });
    }
  } else {
    pages = await buildStories(perApp);
  }

  // The ecosystem's own developer views, built once per serve (esbuild over the
  // pinned devDependencies). The desks link at it but do not load it: the debug
  // modal fetches it the first time a visitor opens the flowchart or inspector
  // tab, so a desk that is only chatted with never pays the ~200 KB.
  const devViews = ensureDevViews({ quiet: true });
  console.log(`dev views: ${DEV_VIEWS_JS} ${(devViews.bytes.js / 1024).toFixed(0)} KB `
    + `+ ${DEV_VIEWS_CSS} ${(devViews.bytes.css / 1024).toFixed(0)} KB — served at /vendor/, loaded only when the debug modal needs it`);

  const outDir = join(here, 'out');
  mkdirSync(outDir, { recursive: true });
  const html = new Map();
  html.set('gallery', buildGalleryPage(APPS, { live: LIVE, model: MODEL }));
  for (const app of APPS) html.set(app.id, buildAppPage(app, pages.get(app.id)));
  for (const [name, body] of html) {
    const file = join(outDir, `${name}.html`);
    writeFileSync(file, body);
    console.log(`generated ${file}`);
  }
  if (LIVE) console.log(costNote());

  const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // The recording is by far the biggest thing this server sends (a turn is
  // ~340 KB of JSON, and JSON of that shape gzips to about 7% of itself). It is
  // the one response worth compressing, and only for a client that said it can
  // read it — everything else stays plain.
  const sendRecording = (req, res, obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { 'content-type': 'application/json', vary: 'accept-encoding' });
      res.end(body);
      return;
    }
    const gz = gzipSync(body);
    res.writeHead(200, {
      'content-type': 'application/json', 'content-encoding': 'gzip', vary: 'accept-encoding',
    });
    res.end(gz);
  };
  const sendHtml = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/' || path === '/gallery.html')) { sendHtml(res, html.get('gallery')); return; }
      if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const staticApp = path.match(/^\/(\w+)\.html$/);
      if (req.method === 'GET' && staticApp && html.has(staticApp[1])) { sendHtml(res, html.get(staticApp[1])); return; }
      const appRoute = path.match(/^\/app\/(\w+)$/);
      if (req.method === 'GET' && appRoute && html.has(appRoute[1])) { sendHtml(res, html.get(appRoute[1])); return; }

      // ─── GET /vendor/vr-dev-views.iife.{js,css} — the two dev-view files ──
      // Two exact names off one known directory: no path parameter reaches the
      // filesystem, so this route cannot be walked. The desks never request it
      // on load; the debug modal injects it when a visitor opens a view.
      if (req.method === 'GET' && (path === `/vendor/${DEV_VIEWS_JS}` || path === `/vendor/${DEV_VIEWS_CSS}`)) {
        const file = path.endsWith('.css') ? devViews.css : devViews.js;
        res.writeHead(200, {
          'content-type': path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        });
        res.end(readFileSync(file));
        return;
      }

      // ─── GET /app/<id>/turn/<k>/artifacts?session=<id> — the recording ────
      // A pure read of a turn that already happened: the frozen snapshot, the
      // frozen event log, and the agent's own blueprint. It runs nothing, and
      // it is the whole data path of the two library views in the debug modal.
      const artifactsRoute = path.match(/^\/app\/(\w+)\/turn\/(\d+)\/artifacts$/);
      if (req.method === 'GET' && artifactsRoute) {
        const app = appById(artifactsRoute[1]);
        if (!app) { send(res, 404, { error: `unknown app '${artifactsRoute[1]}'` }); return; }
        const session = core.sessions.get(url.searchParams.get('session') ?? '');
        if (!session) { send(res, 404, { error: 'unknown sessionId — start a conversation first' }); return; }
        if (session.appId !== app.id) { send(res, 400, { error: `session ${session.id} belongs to '${session.appId}'` }); return; }
        const artifacts = core.artifactsFor(session, Number(artifactsRoute[2]));
        if (!artifacts) { send(res, 404, { error: 'unknown session/turn' }); return; }
        sendRecording(req, res, artifacts);
        return;
      }

      // POST /app/<id>/{chat,reason,rerun-turn,fork} — 07's four endpoints, scoped per app.
      const api = path.match(/^\/app\/(\w+)\/([\w-]+)$/);
      if (req.method === 'POST' && api) {
        const app = appById(api[1]);
        if (!app) { send(res, 404, { error: `unknown app '${api[1]}'` }); return; }
        const body = JSON.parse((await readBody(req)) || '{}');
        // A supplied-but-unknown sessionId is a bug, not a new conversation.
        const resolve = () => {
          const s = core.sessions.get(body.sessionId);
          if (!s) throw new Error('unknown sessionId — start a conversation first');
          if (s.appId !== app.id) throw new Error(`session ${s.id} belongs to '${s.appId}', not '${app.id}'`);
          return s;
        };

        // A supplied-but-unknown sessionId is a bug; no sessionId starts a
        // conversation. Shared verbatim by /chat and /chat-stream so their
        // failure modes are identical — and so the stream's failures happen
        // BEFORE any stream header is written.
        const resolveOrStart = () => {
          if (!body.sessionId) return startSession(app, perApp);
          const s = core.sessions.get(body.sessionId);
          if (!s) { send(res, 404, { error: 'unknown sessionId — start a conversation first' }); return null; }
          if (s.appId !== app.id) { send(res, 400, { error: `session ${s.id} belongs to '${s.appId}'` }); return null; }
          return s;
        };

        if (api[2] === 'chat') {
          const session = resolveOrStart();
          if (!session) return;
          if (typeof body.message !== 'string' || !body.message.trim()) throw new Error('message required');
          // `dedupe` is the client's mid-stream recovery flag and nothing else:
          // a visitor legitimately repeating a message never sends it.
          const turn = await core.chatTurn(session, body.message, { dedupe: body.dedupe === true });
          send(res, 200, chatPayload(session, turn));
          return;
        }

        // ─── POST /app/<id>/chat-stream — the SSE sibling of /chat ───────────
        // Same request body, same final payload, same failures. The ONLY thing
        // it adds is a faithful projection of the agent's own event stream while
        // the turn runs: `status` frames (one per real llm_start / tool_start /
        // failed tool_end) and `token` frames (one per real stream.token).
        // The server never delays, pads or invents a frame — display pacing is
        // the page's business, and dies under prefers-reduced-motion.
        if (api[2] === 'chat-stream') {
          const session = resolveOrStart();
          if (!session) return;
          if (typeof body.message !== 'string' || !body.message.trim()) throw new Error('message required');

          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          // After this point the outer try/catch must never answer: it would
          // write a JSON body into an open event stream. This branch owns its
          // errors and always returns.
          const frame = (name, payload) => {
            if (!res.writableEnded && !res.destroyed) res.write(encodeSSE(name, payload));
          };
          // The opener. A fresh conversation learns its wire id here rather than
          // at `final` — which is what makes mid-stream recovery of a FIRST turn
          // possible at all.
          frame('session', { sessionId: session.id });
          const onEvent = statusMapper(plainToolNames(app), frame);
          try {
            // A disconnected client does NOT abort the turn: it runs to
            // completion inside the serialized queue (frames are dropped by the
            // guard above), which is exactly what makes the client's
            // `dedupe: true` recovery a deterministic read rather than a race.
            const turn = await core.chatTurn(session, body.message, { onEvent });
            frame('final', chatPayload(session, turn));
          } catch (err) {
            frame('error', { error: String(err && err.message ? err.message : err) });
          }
          res.end();
          return;
        }

        if (api[2] === 'reason') {
          const session = resolve();
          if (!session.chat.turns[body.turnIndex]) throw new Error('unknown session/turn');
          const r = await core.reasonAbout(session, body.turnIndex);
          send(res, 200, { map: r.map, strategies: r.strategies });
          return;
        }

        if (api[2] === 'rerun-turn') {
          const session = resolve();
          if (!session.chat.turns[body.turnIndex]) throw new Error('unknown session/turn');
          const ids = Array.isArray(body.ignore) ? body.ignore : [];
          const { rerunId, result } = await core.rerunTurnK(session, body.turnIndex, ids);
          send(res, 200, { rerunId, ignoredLabels: core.labelsFor(await core.getReport(session, body.turnIndex), ids), result });
          return;
        }

        if (api[2] === 'fork') {
          const session = resolve();
          const fork = core.forkFrom(session, body.turnIndex, body.rerunId); // throws on unknown rerunId
          // `entity` rides the response so the fork's header names the RIGHT subject
          // from its first paint — without it the client falls back to the pack
          // default and briefly labels the fork with the wrong movie/ticker/place.
          send(res, 200, { sessionId: fork.id, label: fork.label, transcript: fork.seedTranscript,
            ignoredSourceIds: fork.excludedIds, forkOf: fork.forkOf, entity: fork.entity });
          return;
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
    } catch (err) {
      send(res, 400, { error: String(err && err.message ? err.message : err) });
    }
  });

  server.listen(PORT, () => {
    console.log(`The app gallery is live → http://localhost:${PORT}`);
    console.log(`  ${APPS.map((a) => `/app/${a.id}`).join(' · ')}`);
    console.log('POST /app/<id>/chat {message} · /reason {sessionId,turnIndex} · /rerun-turn {sessionId,turnIndex,ignore} · /fork {sessionId,turnIndex,rerunId}');
    console.log('GET  /app/<id>/turn/<k>/artifacts?session=<id> → the turn\'s frozen recording (the debug modal\'s library views read it) · /vendor/vr-dev-views.iife.{js,css}');
    console.log('POST /app/<id>/chat-stream {message} → text/event-stream: session · status · token · final|error (the page falls back to /chat if it fails)');
  });

  // stdio MCP servers die with their parent, but close the client explicitly so
  // Ctrl-C leaves no orphan and the HTTP socket is released first.
  const shutdown = async () => {
    server.close();
    try { await client.close(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ═══ Entry ═══════════════════════════════════════════════════════════════════
if (LIVE && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY is not set.\n'
    + '  1. cp .env.example .env\n'
    + '  2. paste your Anthropic key into .env\n'
    + '  3. npm run gallery:live   (it loads .env for you)\n'
    + 'The mock gallery needs no key:  npm run gallery',
  );
  process.exit(1);
}

if (args.includes('--serve')) {
  await serveMode();
} else {
  await defaultMode();
}
