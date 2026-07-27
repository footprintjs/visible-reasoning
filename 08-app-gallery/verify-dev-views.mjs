// The developer-views gate — the two library views, the recording they read,
// and the seams that carry it. Seconds, no browser.
//
// The debug modal's "flowchart" and "inspector" tabs are not ours: they are
// agentfootprint-lens's `Lens` and footprint-explainable-ui's `ExplainableShell`,
// mounted over ONE recorded turn. Four things have to stay true or the claim
// "these are the real developer views, over the real recording" is decoration:
//
//   1. THE BUNDLE IS WHAT IT SAYS — one built file that exposes exactly the
//      components the modal mounts, carries NO second React (it asks the page's
//      registry for one), and contains no key path of any kind;
//   2. THE RECORDING IS THE TURN'S — the snapshot and event log are the ones
//      recordedChat froze, and the blueprint is the agent's own, stashed at
//      construction and never overwritten by a counterfactual re-run;
//   3. BOTH TRANSPORTS HAND OVER THE SAME BYTES — the server's read-only
//      endpoint and BYOK's in-tab accessor;
//   4. NOTHING LOADS UNTIL IT IS ASKED FOR — no page references the view file
//      in its markup, and the BYOK page reaches it relatively.
//
//   node 08-app-gallery/verify-dev-views.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Agent } from 'agentfootprint';
import { buildDevViewsBundle, OUT_CSS, OUT_JS } from './dev-views/build.mjs';
import { APPS, appById } from './apps/index.js';
import { buildMockTools, decorateTools } from './lib/mcp.js';
import { createChatCore } from './lib/chat-core.js';
import { createLocalApi } from './byok/local-api.js';
import { buildAppPage, debugModalScript } from './lib/page.js';
import { generate } from './byok.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('=== DEV VIEWS VERIFY ===');

// ═══ 1. the bundle ══════════════════════════════════════════════════════════
// Built into scratch, never into out/: a gate reads, it does not write the tree
// the other gates are judging.
const scratch = mkdtempSync(join(tmpdir(), 'vr-dev-views-'));
const built = await buildDevViewsBundle({ outDir: scratch, quiet: true });
const js = readFileSync(built.js, 'utf8');
const css = readFileSync(built.css, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
ok(js.length > 400e3 && js.length < 900e3,
  'the view bundle is in the size band the design assumed (400–900 KB)', kb(js.length));
ok(css.length > 8e3 && css.length < 40e3,
  'the one stylesheet it needs is @xyflow/react-sized (8–40 KB)', kb(css.length));

// Every rule in that stylesheet is .react-flow-scoped, which is why it can be
// dropped into a desk page without touching the desk's own skin.
const selectors = css.split('}').map((b) => b.split('{')[0]).filter((s) => s.trim() && !s.trim().startsWith('@'));
const unscoped = selectors.filter((s) => !s.includes('.react-flow'));
ok(unscoped.length === 0, 'every stylesheet rule is scoped under .react-flow — the desk skin is untouchable',
  unscoped.slice(0, 3).join(' | ') || `${selectors.length} rules`);

// THE REACT SEAM, proven by loading the file the way a page does: give it a
// module registry and nothing else. A bundle carrying its own React would never
// ask, and a bundle that asked for something the pages do not register would
// throw here rather than in front of an audience.
const asked = [];
const registry = (name) => { asked.push(name); return require(name); };
let views = null;
let loadError = null;
try {
  // The evaluated string is the file this gate just built, from pinned
  // devDependencies, three lines above — running it IS the assertion, and there
  // is no input to inject: `js` is a build product, never a request or a file
  // this repo did not write.
  // eslint-disable-next-line no-new-func
  views = new Function('__require', 'window', 'document', 'self', `${js}\nreturn VRDevViews;`)(
    registry, undefined, undefined, undefined,
  );
} catch (err) { loadError = err; }
ok(!loadError, 'the built file loads with nothing but the page\'s module registry',
  loadError ? loadError.message : 'no window, no document needed at load');
ok(asked.length > 0 && asked.every((n) => ['react', 'react-dom', 'react-dom/client', 'scheduler'].includes(n)),
  'it asks the page for React instead of carrying one', [...new Set(asked)].join(', '));

const MOUNTS = [
  ['eui.ExplainableShell', views && views.eui && views.eui.ExplainableShell],
  ['eui.TraceViewer', views && views.eui && views.eui.TraceViewer],
  ['lens.Lens', views && views.lens && views.lens.Lens],
  ['lens.LensRecorder', views && views.lens && views.lens.LensRecorder],
  ['lens.structureGraphFromSpec', views && views.lens && views.lens.structureGraphFromSpec],
  ['lens.buildStepGraphFromSnapshot', views && views.lens && views.lens.buildStepGraphFromSnapshot],
  ['buildStepGraphFromEvents', views && views.buildStepGraphFromEvents],
];
for (const [name, value] of MOUNTS) {
  ok(typeof value === 'function', `the bundle exposes ${name} — the modal mounts it by that name`);
}

// The custody line, from the bytes: these are view components, and nothing in
// them knows about a key or a model endpoint.
for (const forbidden of ['api.anthropic.com', 'x-api-key', 'sk-ant-', 'ANTHROPIC_API_KEY']) {
  ok(!js.includes(forbidden), `the bundle contains no “${forbidden}” — it is a renderer, not a client`);
}
ok(!/process\.env\.NODE_ENV/.test(js), 'process.env was compiled out — nothing reads an environment in a tab');

// ═══ 2. the recording, and the blueprint stashed beside it ══════════════════
// THE ATTACH TAP. One thing about the observability recorders cannot be read off
// a finished snapshot: WHICH runs were given them. `Agent.prototype.attach` is
// the seam chat-core calls, and this gate and chat-core share the one
// 'agentfootprint' module instance — so watching it here watches the real thing.
// It delegates to the real method, so nothing about the runs below changes.
const attached = [];
const realAttach = Agent.prototype.attach;
Agent.prototype.attach = function tappedAttach(recorder) {
  attached.push(recorder);
  return realAttach.call(this, recorder);
};

const core = createChatCore({ live: false });
const { tools } = await buildMockTools();
const decorated = decorateTools(tools, core.getPending);
const byName = new Map(decorated.map((t) => [t.schema.name, t]));
const pack = appById('movies');
const subset = pack.tools.map((t) => byName.get(t.name));
const session = core.newSession({
  pack, label: pack.title, chat: core.makeChat(pack), decoratedTools: subset,
});
const turn = await core.chatTurn(session, pack.story[0]);
const recordedAttaches = attached.splice(0);
const art = core.artifactsFor(session, 0);

ok(art.snapshot === turn.artifacts.snapshot && art.events === turn.artifacts.events,
  'the artifacts ARE the turn\'s frozen recording — the same objects, not a copy or a derivation');
ok(Array.isArray(art.events) && art.events.length > 0 && Array.isArray(art.snapshot.commitLog),
  'the recording carries the typed event log and the run\'s commit log',
  `${art.events.length} events · ${art.snapshot.commitLog.length} commits`);
ok(art.blueprint && typeof art.blueprint === 'object',
  'the agent\'s own build-time structure was stashed at construction');
ok(JSON.stringify(art.blueprint).length < 50e3,
  'the blueprint is small enough to ride the same response', `${JSON.stringify(art.blueprint).length} bytes`);
ok(core.artifactsFor(session, 7) === null, 'a turn that does not exist has no artifacts, and none are invented');

// The blueprint the two views draw is the RECORDED turn's. A counterfactual
// re-run builds its own agents (that is the whole point of a counterfactual),
// and none of them may overwrite it.
const before = art.blueprint;
await core.rerunTurnK(session, 0, [pack.driver]);
const rerunAttaches = attached.splice(0);
Agent.prototype.attach = realAttach;
ok(core.artifactsFor(session, 0).blueprint === before,
  'a what-if re-run does not overwrite the recorded turn\'s blueprint');

// The story still rides the reply, and it no longer carries the removed view's data.
const dbg = core.debugFor(session, 0);
ok(dbg && dbg.story && !('trace' in dbg),
  'the reply\'s debug payload is the story alone — the hand-rendered trace list is gone with its view');

// ═══ 2b. the observability the two views read, recorded at RECORD time ══════
// The inspector's Insights list and its Gantt bars are not derived from the
// recording — they are read straight off `snapshot.recorders`, which is empty
// unless somebody attaches a recorder while the turn RUNS. That is why the panel
// used to say "No insights available. Attach recorders to see data." and every
// bar read 0 ms. chat-core now attaches two of the libraries' own recorders on a
// recorded turn, and these checks hold that to the standard the rest of this
// gate uses: the real recording, and the VIEWS' own code reading it.
const recorderEntries = art.snapshot.recorders ?? [];
const named = (name) => recorderEntries.filter((r) => r.name === name);
ok(named('Metrics').length === 1,
  'the recording carries exactly one Metrics entry — footprintjs\'s own stage timings',
  `${named('Metrics').length} of ${recorderEntries.length} entries`);
ok(named('BoundaryEvents').length === 1,
  'and exactly one BoundaryEvents entry — agentfootprint\'s own run/subflow boundaries',
  `${named('BoundaryEvents').length} of ${recorderEntries.length} entries`);
// The dedupe, asserted as the property it protects rather than as the bug it
// works around: explainable-ui keys an Insights tab by `id`, so a repeated id is
// a repeated tab AND a repeated React key. (footprintjs 9.11.0 collects the
// Metrics recorder once per channel it lands on; see chat-core's note.)
ok(new Set(recorderEntries.map((r) => r.id)).size === recorderEntries.length,
  'every recorder entry has its own id — no duplicate tab, no repeated React key',
  recorderEntries.map((r) => r.id).join(', '));

// THE DURATIONS, through explainable-ui's OWN extraction. toVisualizationSnapshots
// is the function the inspector builds its rail from; it calls extractStageTimings
// over `snapshot.recorders` internally. Driving the installed package means this
// check cannot pass by agreeing with a re-implementation of it.
const eui = await import('footprint-explainable-ui');
const railWithMetrics = eui.toVisualizationSnapshots(art.snapshot);
const timed = railWithMetrics.filter((s) => s.durationMs > 0);
ok(timed.length > 0,
  'explainable-ui\'s own reader finds real stage durations in the recording',
  `${timed.length} of ${railWithMetrics.length} steps timed · ${
    [...new Set(timed.map((s) => `${s.stageName} ${s.durationMs}ms`))].slice(0, 3).join(', ')}`);
// The before, measured rather than remembered: strip the recorders and the exact
// same reader finds nothing. That IS the defect the owner reported.
const withoutRecorders = { ...art.snapshot };
delete withoutRecorders.recorders;
ok(eui.toVisualizationSnapshots(withoutRecorders).every((s) => s.durationMs === 0),
  'and with those entries removed it finds none — which is what every bar read before');
// Nothing is padded or scaled: every duration the view shows is the Metrics
// recorder's own number for that stage, and a stage that really took under a
// millisecond stays at zero and is honestly dropped.
const steps = Object.values(named('Metrics')[0].data.steps ?? {});
const recorded = new Map();
for (const s of steps) {
  if (!s?.stageName || !(s.duration > 0)) continue;
  recorded.set(s.stageName, Math.round((recorded.get(s.stageName) ?? 0) + s.duration));
}
ok(timed.every((s) => recorded.get(s.stageName) === s.durationMs),
  'every bar is the recorder\'s own measurement for that stage — nothing scaled, nothing invented');
ok(steps.length > timed.length,
  'a stage too fast to measure stays at zero and is dropped, not padded',
  `${steps.length} stages measured · ${timed.length} above 0 ms under the mock provider`);

// THE BOUNDARY ENTRY, checked for the fields a step-strip rebuild consumes: the
// commit index each boundary happened at, and a matched entry/exit per range.
const boundary = named('BoundaryEvents')[0].data;
const entryTypes = new Set(['run.entry', 'subflow.entry']);
const exitTypes = new Set(['run.exit', 'subflow.exit']);
const opens = boundary.filter((e) => entryTypes.has(e.type));
const closes = boundary.filter((e) => exitTypes.has(e.type));
ok(boundary.length > 0 && boundary.every((e) => typeof e.commitIdxBefore === 'number'),
  'every boundary event is stamped with the commit index it happened at — the axis the step strip is built on',
  `${boundary.length} events`);
ok(opens.length > 1 && opens.length === closes.length,
  'and every boundary that opened also closed — one range per run and per subflow',
  `${opens.length} opened · ${closes.length} closed`);
ok(opens.every((e) => typeof e.runtimeStageId === 'string' && e.runtimeStageId
  && Array.isArray(e.subflowPath) && typeof e.depth === 'number'),
  'each one names the runtime stage, its subflow path and its depth — enough to rebuild the range index');
// It has to survive the wire: the modal reads this over HTTP (or through BYOK's
// in-tab copy), never off the live object.
const overWire = JSON.parse(JSON.stringify(core.artifactsFor(session, 0)));
const wireNames = (overWire.snapshot.recorders ?? []).map((r) => r.name).sort();
ok(JSON.stringify(wireNames) === JSON.stringify(['BoundaryEvents', 'Metrics']),
  'both entries survive the round trip the modal actually receives them through', wireNames.join(', '));

// RECORD MODE ONLY, read off the attach seam itself. A what-if re-run builds its
// own agents; those are counterfactuals, nobody reads their snapshot, and a lean
// probe is what keeps the comparison honest.
ok(recordedAttaches.length === 2
  && recordedAttaches.map((r) => r.toSnapshot().name).sort().join(',') === 'BoundaryEvents,Metrics',
  'a recorded turn is given exactly those two recorders, and nothing else',
  recordedAttaches.map((r) => r.id).join(', ') || 'none');
ok(rerunAttaches.length === 0,
  'a what-if re-run is given none — the counterfactual stays lean',
  rerunAttaches.map((r) => r.id).join(', ') || 'none attached');

// ═══ 3. the BYOK accessor — same bytes, no wire ═════════════════════════════
const perApp = new Map(APPS.map((a) => [a.id, a.tools.map((t) => byName.get(t.name))]));
const api = createLocalApi({ core, packs: APPS, perApp });
const local = api.artifacts({ appId: 'movies', sessionId: session.id, turnIndex: 0 });
ok(JSON.stringify(local) === JSON.stringify(art),
  'BYOK hands the modal the same recording, byte for byte — in-tab, with no request to make');
// The wire copies (it serializes); in-tab the accessor has to copy on purpose.
// The recording is this turn's evidence, and a reader of evidence gets a copy —
// otherwise one in-place write inside a view would edit the session's own past.
ok(local.snapshot !== art.snapshot && local.events !== art.events && local.blueprint !== art.blueprint,
  'and it is a COPY — no view holds the session\'s own frozen objects');
let threw = null;
try { api.artifacts({ appId: 'movies', sessionId: 'nope', turnIndex: 0 }); } catch (err) { threw = err; }
ok(threw && /unknown sessionId/.test(threw.message),
  'an unknown session is an error there too, worded exactly as the server words it');

// ═══ 4. the server's read-only endpoint ═════════════════════════════════════
// A gate must be able to run beside a rehearsal server, so the port is the
// override run.js reads and nothing else.
const PORT = 4278;
const child = spawn(process.execPath, [join(here, 'run.js'), '--serve'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VR_GALLERY_PORT: String(PORT) },
});
const log = [];
child.stdout.on('data', (c) => log.push(String(c)));
child.stderr.on('data', (c) => log.push(String(c)));
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${log.join('')}`)), 60000);
    child.stdout.on('data', (c) => { if (String(c).includes('The app gallery is live')) { clearTimeout(t); resolve(); } });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited ${code}:\n${log.join('')}`)); });
  });

  const base = `http://localhost:${PORT}`;
  // The pre-run mock stories give every desk a session with one recorded turn;
  // the page learns the id the same way, from its own page data.
  const page = await (await fetch(`${base}/app/movies`)).text();
  const sid = (page.match(/"active":"(s\d+)"/) ?? [])[1];
  ok(!!sid, 'the desk page names the session the modal will ask about', sid ?? 'none found');

  const res = await fetch(`${base}/app/movies/turn/0/artifacts?session=${sid}`);
  const body = await res.json();
  ok(res.status === 200, 'GET /app/<id>/turn/<k>/artifacts answers', `${res.status}`);
  ok(Array.isArray(body.events) && body.events.length > 0 && !!body.snapshot && !!body.blueprint,
    'it answers with the recording: event log, run snapshot, blueprint',
    `${body.events.length} events · ${body.snapshot.commitLog.length} commits`);
  ok(body.snapshot.commitValues === 'delta' || body.snapshot.commitValues === 'full',
    'the snapshot is the executor\'s own, dials and all', String(body.snapshot.commitValues));

  // The recording is the one big response this server sends. Measured on the
  // wire, with the raw client, because fetch() decompresses behind your back:
  // a client that says it reads gzip gets gzip, one that says nothing gets the
  // plain bytes, and both carry the same recording.
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = httpGet(`${base}/app/movies/turn/0/artifacts?session=${sid}`, { headers }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
  const plain = await raw({ 'accept-encoding': 'identity' });
  const zipped = await raw({ 'accept-encoding': 'gzip' });
  ok(!plain.headers['content-encoding'] && plain.headers.vary === 'accept-encoding',
    'a client that cannot read gzip gets the recording plain, and the answer says it varies',
    `${kb(plain.body.length)} plain`);
  ok(zipped.headers['content-encoding'] === 'gzip' && zipped.body.length < plain.body.length / 4,
    'a client that can read gzip gets it compressed — the same recording, a fraction of the bytes',
    `${kb(plain.body.length)} → ${kb(zipped.body.length)}`);
  ok(gunzipSync(zipped.body).equals(plain.body),
    'and the compressed bytes decompress to exactly the plain ones — compression changed nothing');

  const wrongSession = await fetch(`${base}/app/movies/turn/0/artifacts?session=nope`);
  ok(wrongSession.status === 404, 'an unknown session is a 404, not an empty recording', `${wrongSession.status}`);
  const wrongTurn = await fetch(`${base}/app/movies/turn/99/artifacts?session=${sid}`);
  ok(wrongTurn.status === 404, 'a turn that never happened is a 404', `${wrongTurn.status}`);
  const crossApp = await fetch(`${base}/app/trip/turn/0/artifacts?session=${sid}`);
  ok(crossApp.status === 400, 'a session belongs to its own desk and cannot be read through another',
    `${crossApp.status}`);
  const post = await fetch(`${base}/app/movies/turn/0/artifacts?session=${sid}`, { method: 'POST' });
  ok(post.status === 404, 'the recording route is read-only — POST finds nothing there', `${post.status}`);

  const viewJs = await fetch(`${base}/vendor/${OUT_JS}`);
  const viewCss = await fetch(`${base}/vendor/${OUT_CSS}`);
  ok(viewJs.status === 200 && (viewJs.headers.get('content-type') || '').includes('javascript'),
    'the view file is served, as script', `${viewJs.status} ${viewJs.headers.get('content-type')}`);
  ok(viewCss.status === 200 && (viewCss.headers.get('content-type') || '').includes('css'),
    'its stylesheet is served, as css', `${viewCss.status} ${viewCss.headers.get('content-type')}`);
  const walk = await fetch(`${base}/vendor/../run.js`);
  ok(walk.status === 404, 'the vendor route is two exact names — no path of ours reaches the filesystem',
    `${walk.status}`);
} finally {
  child.kill('SIGTERM');
}

// ═══ 5. nothing loads until it is asked for ═════════════════════════════════
const deskData = {
  order: ['s1'], active: 's1', live: false, model: null, costNote: '',
  sessions: { s1: { id: 's1', label: 'movies', forkOf: null, appId: 'movies', ignoredSourceIds: [], seed: [], entity: 'Heat', turns: [] } },
  reason: {}, rerun: {},
};
const desk = buildAppPage(APPS.find((a) => a.id === 'movies'), deskData);
ok(!/<script[^>]+vr-dev-views/.test(desk) && !/<link[^>]+vr-dev-views/.test(desk),
  'a desk page references the view file in no tag — it is injected only when a view is opened');
ok(desk.includes("'/vendor/vr-dev-views.iife.js'") && desk.includes('/turn/'),
  'the desk knows where the view file and the recording live, and asks for neither on load');
for (const id of ['story', 'flowchart', 'inspector']) {
  ok(desk.includes(`tab('${id}', '${id}')`), `the dialog offers the “${id}” tab`);
}
ok(!desk.includes("tab('trace'"), 'the hand-rendered trace tab is gone');

// ═══ 6. a recording that cannot be read costs the VIEW, never the desk ══════
// The flowchart's model is BUILT while the pane renders — which is ABOVE the
// error boundary, since a boundary only catches what a view throws while
// DRAWING. One unreadable event therefore used to throw where React could only
// answer by unmounting the whole desk: the visitor lost the chat, not the tab.
// Two guards now stand between those, and both are checked here against the
// real recorder in the real bundle, on the exact event that took the desk down:
// a null-payload `llm_end`, which the debugger reads a wall clock out of.
const modal = new Function('React',
  `${debugModalScript()}\nreturn { dbgLensModel: dbgLensModel, dbgLensSafe: dbgLensSafe,`
  + ' dbgOverlayFromCommitLog: dbgOverlayFromCommitLog };',
)({ Component: function ReactComponent() {}, createElement: () => null, Fragment: 'Fragment' });

const CORRUPT = { type: 'agentfootprint.stream.llm_end', payload: null, meta: null };
const recording = (events) => ({ turnIndex: 0, snapshot: art.snapshot, events, blueprint: art.blueprint });

let clean = null;
try { clean = modal.dbgLensModel(views, recording(art.events)); } catch (err) { clean = err; }
ok(clean && clean.recorder && clean.skipped === 0 && clean.total === art.events.length,
  'the real recording replays whole — every event read, none skipped',
  clean instanceof Error ? clean.message : `${art.events.length} events`);

let onlyBad = null;
try { onlyBad = modal.dbgLensModel(views, recording([CORRUPT])); } catch (err) { onlyBad = err; }
ok(onlyBad && onlyBad.recorder && onlyBad.skipped === 1,
  'an event the debugger cannot read is skipped and counted, not thrown out of the pane',
  onlyBad instanceof Error ? `threw: ${onlyBad.message}` : `${onlyBad.skipped} skipped`);

let mixed = null;
try { mixed = modal.dbgLensModel(views, recording([...art.events, CORRUPT])); } catch (err) { mixed = err; }
ok(mixed && mixed.skipped === 1 && mixed.total === art.events.length + 1,
  'and it degrades to exactly that one event — the rest of the turn still replays',
  mixed instanceof Error ? `threw: ${mixed.message}` : `${mixed.skipped} of ${mixed.total} skipped`);

// ═══ 6b. THE STEP STRIP'S AXIS, PUT BACK ════════════════════════════════════
// The flowchart's prev/next transport, its step count and its moments rail are
// all one array, and that array is derived from the recorder's commit-range
// index — which run and which subflow was open across which commits. A replay
// fires no footprintjs FlowRecorder hook, so the index used to stay EMPTY: zero
// groups, zero positions, "1 step", buttons disabled. The ranges are in the
// recording though (chat-core attaches agentfootprint's boundary recorder while
// the turn runs), so the modal replays them into the recorder's own public
// index. These checks hold that to "the index IS the recording", per range.
const boundaryEvents = named('BoundaryEvents')[0].data;
const openEvents = boundaryEvents.filter((e) => entryTypes.has(e.type));
const closeEvents = boundaryEvents.filter((e) => exitTypes.has(e.type));
ok(clean && clean.boundaryEvents === boundaryEvents.length && clean.boundaryRanges === openEvents.length,
  'every recorded boundary became a range on the replayed recorder — the index the strip reads is populated',
  clean instanceof Error ? clean.message : `${clean.boundaryRanges} ranges from ${clean.boundaryEvents} events`);
const rebuilt = clean.recorder.boundary.boundaryIndex.overlapping(0, Number.MAX_SAFE_INTEGER);
ok(rebuilt.length === openEvents.length && rebuilt.every((r) => typeof r.endIdx === 'number'),
  'and every one of them is CLOSED — an open-ended range would stretch the strip past the run',
  `${rebuilt.filter((r) => typeof r.endIdx === 'number').length} of ${rebuilt.length} closed`);
// Per range, against the recorded pair it came from: same start, same end, same
// runtime stage. Nothing is shifted, merged or invented.
const closeAt = new Map(closeEvents.map((e) => [e.runtimeStageId, e.commitIdxBefore]));
const byRid = new Map(rebuilt.map((r) => [r.label.runtimeStageId, r]));
const mismatched = openEvents.filter((e) => {
  const r = byRid.get(e.runtimeStageId);
  return !r || r.startIdx !== e.commitIdxBefore || r.endIdx !== closeAt.get(e.runtimeStageId);
});
ok(mismatched.length === 0,
  'each range spans exactly the commits its recorded entry/exit pair spanned — the recording, put back',
  mismatched.length ? `off: ${mismatched.slice(0, 3).map((e) => e.runtimeStageId).join(', ')}` : `${rebuilt.length} ranges`);
// The index is the SAFE projection: lens's own note says a chip rendered from it
// cannot leak a tool argument or an LLM message, and that is only true if the
// payload never rides along into the label.
ok(rebuilt.every((r) => !('payload' in r.label)),
  'no range label carries an event payload — the index stays the stripped projection lens documents');
// The library's own query over it answers, at a commit in the middle of the run.
const mid = Math.floor(art.snapshot.commitLog.length / 2);
ok(clean.recorder.boundary.boundaryIndex.enclosing(mid).length > 0,
  'and lens\'s own enclosing() query finds the boundaries open at a commit — the query the strip is built on',
  `${clean.recorder.boundary.boundaryIndex.enclosing(mid).length} enclosing at commit ${mid}`);

// THE HONEST LIMIT, run rather than promised. A turn recorded BEFORE the
// boundary capture existed carries no such entry, and there is no second path:
// deriving ranges from the commit log was measured at 20 stops where the run
// really had 17 (phantom milestones, mis-anchored slots), because the moment a
// fork's branches open is not a row in that log. So the pane degrades to a quiet
// transport and says why — it never guesses.
const oldShaped = { ...art.snapshot, recorders: (art.snapshot.recorders ?? []).filter((r) => r.name !== 'BoundaryEvents') };
let older = null;
try {
  older = modal.dbgLensModel(views, { turnIndex: 0, snapshot: oldShaped, events: art.events, blueprint: art.blueprint });
} catch (err) { older = err; }
ok(older && older.recorder && older.boundaryEvents === 0 && older.boundaryRanges === 0,
  'a recording made before the capture rebuilds nothing, and still builds a working model',
  older instanceof Error ? `threw: ${older.message}` : `${older.skipped} events skipped`);
ok(older && older.recorder.boundary.boundaryIndex.overlapping(0, Number.MAX_SAFE_INTEGER).length === 0,
  '…with an empty index — nothing was derived from the commit log to fill it in');
// A recording that carries the entry but whose events are unusable must not
// half-fill the index either: a boundary with no commit index is not a range.
const junk = { ...art.snapshot,
  recorders: [{ id: 'b', name: 'BoundaryEvents', data: [{ type: 'subflow.entry', runtimeStageId: 'x#1' }] }] };
const junkModel = modal.dbgLensModel(views, { turnIndex: 0, snapshot: junk, events: [], blueprint: art.blueprint });
ok(junkModel.boundaryRanges === 0,
  'a boundary event with no commit index opens no range — the axis is a number or it is nothing');

// …and the pane says which of the two this turn is, in the page a visitor gets.
ok(desk.includes('function dbgRebuildBoundaryIndex(rec, snapshot) {')
  && desk.includes('boundary = dbgRebuildBoundaryIndex(rec, artifacts.snapshot);'),
  'the desk page carries the rebuild, on the model the flowchart pane mounts');
ok(desk.includes('The step scrubber and the moments rail run on the run\\u2019s own boundaries'),
  'a turn WITH boundaries gets a note that says the scrubber is running, and on what');
ok(desk.includes('this turn was recorded before that capture ')
  && desk.includes('Nothing on this page reconstructs them from the commit log afterwards'),
  'a turn WITHOUT them keeps the honest degraded note — quiet transport, and the reason');
ok(!desk.includes('they need commit ranges that only a live attach records'),
  'and the old blanket claim (no page can ever have them) is gone — it is no longer true');

// The second guard, for the case the first cannot save: a model that cannot be
// built at all becomes a VALUE the pane can render, never a throw during render.
const brokenViews = { lens: { LensRecorder: function () { throw new Error('recorder refused this recording'); } } };
let brokeLoudly = null;
try { modal.dbgLensModel(brokenViews, recording([])); } catch (err) { brokeLoudly = err; }
ok(!!brokeLoudly, 'building the model can still fail — nothing here pretends a broken recorder worked');
const safe = modal.dbgLensSafe(brokenViews, recording([]));
ok(safe.model === null && safe.error && /refused this recording/.test(safe.error.message),
  'dbgLensSafe turns that failure into a value the pane renders — the desk never sees a render throw');

// …and the pane is wired to both, in the page a visitor actually gets.
ok(desk.includes('return dbgLensSafe(st.views, st.art);'),
  'the pane builds the flowchart model through the guard, not around it');
ok(desk.includes('if (lens && lens.error) return dbgUnreadable(lens.error);'),
  'a model that could not be built shows the pane\'s honest failure note instead of the view');
ok(desk.includes("'data-testid': 'debug-view-error'") && desk.includes('The recording could not be read: '),
  'and that note is the one wording, said plainly');

// FINDING 2's fix, in the bytes of the page: the flowchart is a two-column
// canvas app, and on a phone its chart column collapses to zero width and draws
// nothing unless it is given room to be panned to.
const phone = desk.slice(desk.indexOf('@media (max-width: 720px)'));
ok(phone.includes('.cd-dbg-dev[data-testid="debug-view-flowchart"] > * { min-width: 900px'),
  'on a phone the flowchart view is given a real width');
ok(phone.includes('.cd-dbg-dev[data-testid="debug-view-flowchart"] { overflow-x: auto'),
  'and the panel around it pans, so the whole chart is reachable on a phone');

// ═══ 7. the inspector lights its chart from the RECORDING ═══════════════════
// The chart is coloured by exactly one input — footprint-explainable-ui's
// runtime overlay — and the shell was never handed one, so nothing ever lit up.
// The overlay is not privileged information though: it is the order the stages
// ran in, and the run's own commit log IS that order. So the page derives it,
// and these checks hold the derivation to the same standard the live builder
// meets: same steps, same ids, nothing invented.
ok(desk.includes('function dbgOverlayFromCommitLog(commitLog) {'),
  'the page carries the overlay derivation, in the page a visitor actually gets');
ok(desk.includes('runtimeOverlay: overlay,'),
  'and hands it to the inspector — the one prop that colours the chart');

// The derivation itself, run over the REAL recording this gate just made.
const overlay = modal.dbgOverlayFromCommitLog(art.snapshot.commitLog);
const distinct = [];
const seenRsid = new Set();
for (const b of art.snapshot.commitLog) {
  if (typeof b.runtimeStageId !== 'string' || !b.runtimeStageId || seenRsid.has(b.runtimeStageId)) continue;
  seenRsid.add(b.runtimeStageId);
  distinct.push(b.runtimeStageId);
}
ok(overlay.executionOrder.length === distinct.length
  && overlay.executionOrder.every((s, i) => s.runtimeStageId === distinct[i]),
  'the derived path is one step per executed stage, in the commit log\'s own order',
  `${overlay.executionOrder.length} steps of ${art.snapshot.commitLog.length} commit bundles`);
ok(overlay.executionOrder.every((s) => s.stageName && s.timestampMs === 0),
  'every step is named by its own bundle, and carries no invented clock (timestampMs 0)');
ok(overlay.errors instanceof Map && overlay.errors.size === 0 && overlay.running === false,
  'and it says what it knows: no errors claimed, the run is over');

// The ids have to be the CHART's ids or the colour lands on nothing. lens
// path-qualifies its node ids, which is exactly what the overlay's stageIds are.
const quiet = console.warn;
console.warn = (first, ...rest) => {
  if (typeof first === 'string' && first.startsWith('[traceStructureRecorder] onSubflowMounted')) return;
  quiet(first, ...rest);
};
let graph = null;
try { graph = views.lens.structureGraphFromSpec(art.blueprint, { decorate: false }); }
finally { console.warn = quiet; }
const nodeIds = new Set((graph?.nodes ?? []).map((n) => n.id));
const executedIds = [...new Set(overlay.executionOrder.map((s) => s.stageId))];
const orphans = executedIds.filter((id) => !nodeIds.has(id));
ok(orphans.length === 0 && executedIds.length > 0,
  'every stage on that path is a node of the chart it lights — no id translation, no near-misses',
  orphans.length ? `unmatched: ${orphans.join(', ')}` : `${executedIds.length} of ${nodeIds.size} nodes executed`);

// …and the library's OWN slicer, the one the chart calls, lights a real node at
// every position of the scrubber. This is the defect's before/after, measured.
const { sliceOverlay } = await import('footprint-explainable-ui/flowchart');
const { toVisualizationSnapshots } = await import('footprint-explainable-ui');
const rail = toVisualizationSnapshots(art.snapshot);
let litEverywhere = rail.length > 0;
let maxLit = 0;
for (let i = 0; i < rail.length; i += 1) {
  const idx = overlay.executionOrder.findIndex((s) => s.runtimeStageId === rail[i].runtimeStageId);
  const slice = sliceOverlay(overlay, idx);
  const lit = [...slice.executedStageIds].filter((id) => nodeIds.has(id));
  maxLit = Math.max(maxLit, lit.length);
  if (idx < 0 || !slice.activeStageId || !nodeIds.has(slice.activeStageId) || lit.length === 0) litEverywhere = false;
}
ok(litEverywhere, 'at every position of the scrubber the chart has a lit node, and a real one',
  `${rail.length} positions · up to ${maxLit} nodes lit`);
ok(sliceOverlay({ executionOrder: [], errors: new Map(), running: false }, 0).executedStageIds.size === 0,
  'and with no overlay at all nothing lights — which is exactly what the defect looked like');

// ═══ 8. one token sheet themes both views ═══════════════════════════════════
// Both libraries fall back to a dark slate skin; the desk is paper. They share
// the --fp-* vocabulary, so ONE sheet on the container they mount into re-skins
// both — including the tokens eui reads but its own presets never emit, without
// which the Insights body and the lens cards stay dark whatever else is set.
const sheet = desk.slice(desk.indexOf('.cd-dbg-dev {\n'), desk.indexOf('.cd-dbg-dev {\n') + 1400);
ok(desk.includes('.cd-dbg-dev {\n'), 'the dev-view container carries a token sheet of its own');
for (const token of ['--fp-bg-primary', '--fp-text-primary', '--fp-border', '--fp-color-primary',
  '--fp-node-visited', '--fp-node-cursor']) {
  ok(sheet.includes(`${token}:`), `it sets ${token} — the shared token both libraries read`);
}
for (const drifted of ['--fp-accent', '--fp-accent-bg', '--fp-bg', '--fp-success', '--fp-bg-elevated']) {
  ok(new RegExp(`${drifted}\\s*:`).test(sheet),
    `it also sets ${drifted} — read by the views, emitted by no preset of theirs`);
}
ok(sheet.includes('--fp-color-primary: var(--accent)') && sheet.includes('--fp-node-cursor: var(--accent)'),
  'and the accent is the DESK\'S accent, so each app lights its own chart in its own colour');

// The props stay unpassed on purpose: an inline preset from either library
// would beat the inherited sheet and take the desk back to somebody else's grey.
const script = debugModalScript();
ok(!/\btraceTheme\b/.test(script), 'no traceTheme prop reaches the inspector — the sheet is the theme');
ok(!/\btheme\s*:/.test(script), 'and no theme prop reaches the lens view either');

const scratchByok = mkdtempSync(join(tmpdir(), 'vr-dev-views-byok-'));
const byok = generate({ quiet: true, outDir: scratchByok });
const byokDesk = byok.pages['movies.html'];
ok(!/<script[^>]+vr-dev-views/.test(byokDesk) && !/<link[^>]+vr-dev-views/.test(byokDesk),
  '[byok] the desk page references the view file in no tag either');
ok(byokDesk.includes("'./vendor/vr-dev-views.iife.js'"),
  '[byok] it reaches the view file RELATIVELY — the bundle still works at a subpath and off file://');
ok(byokDesk.includes('api.artifacts({'),
  '[byok] the recording is read in-tab, through local-api — there is no endpoint to ask');
const boot = byokDesk.slice(byokDesk.lastIndexOf('<script type="module">'));
ok(!/fetch\(\s*['"`]\//.test(boot) && !boot.includes("'/app/"),
  '[byok] the new views added no own-origin data path — the custody claim is unchanged');
// The dialog is ONE dialog: the BYOK page imports the same script and the same
// paint from lib/page.js, so a lit chart and a paper-skinned view are not a
// desk-only story. Asserted from the generated bytes rather than from that.
ok(byokDesk.includes('runtimeOverlay: overlay,') && byokDesk.includes('function dbgOverlayFromCommitLog(commitLog) {'),
  '[byok] the inspector lights its chart there too, from the same derivation');
ok(byokDesk.includes('--fp-node-cursor: var(--accent)') && byokDesk.includes('--fp-bg-elevated:'),
  '[byok] and wears the same token sheet, with the same per-app accent');
for (const name of [OUT_JS, OUT_CSS]) {
  const f = join(scratchByok, 'vendor', name);
  ok(statSync(f).size > 8e3, `[byok] ${name} is in the generated bundle`, kb(statSync(f).size));
}
rmSync(scratchByok, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });

console.log(failed === 0
  ? '\nAll checks passed — the two views are the libraries\' own, and they read the turn\'s own recording.'
  : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
