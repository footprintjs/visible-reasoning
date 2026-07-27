// The streaming gate — protocol + honesty + graceful degrade, in seconds.
//
// The desks stream replies token by token over a `text/event-stream` sibling of
// /chat, with a status line driven by the agent's OWN typed events. Three things
// have to stay true or the feature is theatre:
//
//   1. every `status` frame is 1:1 with a real agentfootprint event, and the
//      order on the wire is the order the agent actually worked in;
//   2. the streamed reply and the plain /chat reply are the SAME bytes — the
//      stream is a projection of the turn, never a different turn;
//   3. killing the stream mid-flight costs the visitor nothing: /chat still
//      answers, the recovered turn is the SAME turn (no double model calls, no
//      duplicate transcript entry), and the next message is simply turn N+1.
//
//   node 08-app-gallery/verify-stream.mjs
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trip } from './apps/trip.js';
import { APPS } from './apps/index.js';
import { buildMockTools, decorateTools } from './lib/mcp.js';
import { createChatCore } from './lib/chat-core.js';
import { createLocalApi } from './byok/local-api.js';

const here = dirname(fileURLToPath(import.meta.url));
// The default is run.js's default. The override exists so this gate can run
// while a rehearsal server is already sitting on 4175 — it is passed straight
// through to the server this file spawns, and nothing else reads it.
const PORT = Number(process.env.VR_GALLERY_PORT || 4175);
const BASE = `http://localhost:${PORT}/app/trip`;
const MSG = 'Should I hike Mission Peak on Saturday?';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// ─── boot the mock serve mode as a subprocess ───────────────────────────────
const child = spawn(process.execPath, [join(here, 'run.js'), '--serve'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VR_GALLERY_PORT: String(PORT) },
});
const serverLog = [];
child.stdout.on('data', (c) => serverLog.push(String(c)));
child.stderr.on('data', (c) => serverLog.push(String(c)));
const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`server did not start:\n${serverLog.join('')}`)), 30000);
  child.stdout.on('data', (c) => { if (String(c).includes('The app gallery is live')) { clearTimeout(t); resolve(); } });
  child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited ${code}:\n${serverLog.join('')}`)); });
});

/**
 * Read one SSE response into an ordered frame list.
 * @param opts.path                  which streamed endpoint (default /chat-stream)
 * @param opts.abortAfterFirstToken  kill the socket the moment a token lands
 *   (the mid-stream-death drill).
 * @param opts.abortAfter            kill the socket once this many frames of the
 *   named event have arrived (the re-run's mid-stream-death drill — a re-run
 *   streams no tokens at all).
 */
async function readStream(body, { abortAfterFirstToken = false, path = '/chat-stream', abortAfter = null } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const frames = [];
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('text/event-stream')) return { res, ct, frames, json: await res.json().catch(() => null) };
  const dec = new TextDecoder();
  let buf = '';
  let aborted = false;
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = null;
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (name) frames.push({ name, data: JSON.parse(data) });
      }
      if (abortAfterFirstToken && frames.some((f) => f.name === 'token')) {
        aborted = true;
        controller.abort();
        break;
      }
      if (abortAfter && frames.filter((f) => f.name === abortAfter.name).length >= abortAfter.count) {
        aborted = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if (!aborted) throw err;
  }
  return { res, ct, frames, aborted };
}

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
};

try {
  await ready;
  console.log('=== STREAM VERIFY (mock serve mode, trip desk) ===\n');

  // ═══ 1. protocol + honest status order ════════════════════════════════════
  const run = await readStream({ message: MSG });
  const names = run.frames.map((f) => f.name);
  ok(run.ct.startsWith('text/event-stream'), 'chat-stream answers text/event-stream', run.ct);
  ok(names[0] === 'session' && typeof run.frames[0].data.sessionId === 'string',
    'the first frame is `session` and carries a wire id', `sessionId=${run.frames[0]?.data?.sessionId}`);
  ok(names[names.length - 1] === 'final', 'the last frame is `final`', names[names.length - 1]);

  const statuses = run.frames.filter((f) => f.name === 'status').map((f) => f.data);
  const tokens = run.frames.filter((f) => f.name === 'token').map((f) => f.data);
  const final = run.frames.find((f) => f.name === 'final')?.data;
  const packTools = new Set(trip.tools.map((t) => t.name));

  ok(statuses.length > 0 && statuses.every((s) => s.kind === 'thinking' || s.kind === 'tool'),
    'every status is one of the two real kinds', `${statuses.length} statuses`);
  ok(statuses[0]?.kind === 'thinking', 'the first status is `thinking` (the first real llm_start)');
  ok(statuses.filter((s) => s.kind === 'tool').every((s) => packTools.has(s.tool)),
    'every tool status names a tool this pack actually has',
    statuses.filter((s) => s.kind === 'tool').map((s) => s.tool).join(', '));
  // The real event order is: one llm_start per iteration, and a tool_start only
  // ever AFTER the model asked for it. So no tool status can lead, and the last
  // status before the answer's tokens is the answer pass's own `thinking`.
  const shape = statuses.map((s) => (s.kind === 'thinking' ? 't' : 'T')).join('');
  ok(/^t(Tt)*$/.test(shape), 'status order is a faithful projection of the agent loop (thinking→tool→thinking…)', shape);
  ok(statuses[statuses.length - 1]?.kind === 'thinking',
    'the last status before the reply streams is `thinking` (the answer pass)');
  // Frame-position proof: no status arrives after the first token.
  const firstToken = names.indexOf('token');
  const lastStatus = names.lastIndexOf('status');
  ok(firstToken > lastStatus, 'no status is emitted once the reply starts streaming',
    `lastStatus@${lastStatus} < firstToken@${firstToken}`);

  ok(tokens.length > 0, 'tokens were streamed', `${tokens.length} token frames`);
  ok(tokens.every((t, i) => t.i === i), 'token indexes are the provider’s own, in order');
  const joined = tokens.map((t) => t.text).join('');
  ok(joined === final?.reply, 'the streamed tokens reassemble to the final reply, byte for byte');
  ok(trip.decisionWords.test(final?.reply ?? ''), 'the reply carries a real decision word', final?.reply);
  console.log(`      wire sequence: ${names.map((n, i) => (n === 'token' ? (i === firstToken ? `token×${tokens.length}` : null) : n)).filter(Boolean).join(' → ')}`);
  console.log(`      status lines : ${statuses.map((s) => s.label).join(' | ')}\n`);

  // ═══ 2. the streamed final IS the plain /chat payload ═════════════════════
  const plain = await post('/chat', { message: MSG });
  ok(plain.res.status === 200, 'plain /chat still answers 200 (unchanged for every existing caller)');
  const shared = ['reply', 'provenance', 'sourceLabels', 'entity', 'turnIndex'];
  const same = shared.every((k) => JSON.stringify(plain.json?.[k]) === JSON.stringify(final?.[k]));
  ok(same, 'streamed `final` and plain /chat agree on reply/provenance/sourceLabels/entity/turnIndex',
    shared.map((k) => `${k}:${JSON.stringify(plain.json?.[k]) === JSON.stringify(final?.[k])}`).join(' '));
  ok(JSON.stringify(Object.keys(plain.json ?? {})) === JSON.stringify(Object.keys(final ?? {})),
    'both payloads carry the same keys in the same order (one builder, no drift)');

  // ═══ 3. kill SSE mid-stream → transparent recovery ═══════════════════════
  const drill = await readStream({ message: MSG }, { abortAfterFirstToken: true });
  const drillSession = drill.frames.find((f) => f.name === 'session')?.data?.sessionId;
  ok(drill.aborted === true && !drill.frames.some((f) => f.name === 'final'),
    'the drill really did die mid-stream (tokens seen, no final)',
    `${drill.frames.filter((f) => f.name === 'token').length} tokens before the kill`);

  const recovered = await post('/chat', { sessionId: drillSession, message: MSG, dedupe: true });
  ok(recovered.res.status === 200 && recovered.json?.turnIndex === 0,
    'the recovery POST returns the turn that already ran — no second turn',
    `turnIndex=${recovered.json?.turnIndex}`);
  ok(recovered.json?.reply === final?.reply, 'the recovered reply is the full, authoritative one');

  const next = await post('/chat', { sessionId: drillSession, message: 'What about "Mount Tamalpais"?' });
  ok(next.json?.turnIndex === 1, 'the next real message is simply turn N+1 — the transcript has no duplicate',
    `turnIndex=${next.json?.turnIndex}`);

  // A visitor legitimately repeating themselves is NEVER deduped (no flag sent).
  const repeat = await post('/chat', { sessionId: drillSession, message: 'What about "Mount Tamalpais"?' });
  ok(repeat.json?.turnIndex === 2, 'an ordinary repeated message still runs (dedupe is recovery-only)',
    `turnIndex=${repeat.json?.turnIndex}`);

  // ═══ 4. connect-phase failures are plain JSON, never a half-open stream ═══
  const bogus = await readStream({ sessionId: 'nope', message: MSG });
  ok(!bogus.ct.startsWith('text/event-stream') && bogus.res.status === 404,
    'a bad sessionId fails BEFORE any stream header — plain JSON 4xx, exactly like /chat',
    `${bogus.res.status} ${bogus.ct}`);
  const empty = await readStream({ message: '   ' });
  ok(!empty.ct.startsWith('text/event-stream') && empty.res.status === 400,
    'an empty message fails the same way on both endpoints', `${empty.res.status}`);
  const chatEmpty = await post('/chat', { message: '   ' });
  ok(chatEmpty.res.status === empty.res.status, 'both endpoints reject an empty message identically');

  // ═══ 5. the frozen-world re-run is untouched by the live sink ════════════
  // The live tap is scoped to a chatTurn op, so a counterfactual probe cannot
  // paint into it — and, more importantly, cannot be perturbed by it.
  const reasoned = await post('/reason', { sessionId: drillSession, turnIndex: 0 });
  ok(reasoned.res.status === 200 && reasoned.json?.map?.sources?.length > 0,
    'a streamed turn is still fully explainable', `${reasoned.json?.map?.sources?.length} sources`);
  const rerun = await post('/rerun-turn', { sessionId: drillSession, turnIndex: 0, ignore: [trip.driver] });
  ok(rerun.res.status === 200 && rerun.json?.result?.whatChanged?.answerFlipped === true,
    'the counterfactual re-run of a streamed turn still flips', String(rerun.json?.result?.verdict?.verdict));

  // ═══ 6. the RE-RUN stream — the counterfactual, narrated ═════════════════
  // A live re-run is 2×samples model passes over a frozen tool log and takes
  // tens of seconds; the panel showed nothing but one static sentence while it
  // ran. The stream that fixes that has to obey the same three rules as the
  // chat stream — every status is a real event, the terminal payload is the
  // plain endpoint's, and losing the stream costs only the status line.
  console.log('\n── the re-run stream ──\n');
  const RERUN = '/rerun-turn-stream';
  const rerunBody = { sessionId: drillSession, turnIndex: 0, ignore: [trip.driver] };
  const rs = await readStream(rerunBody, { path: RERUN });
  const rsNames = rs.frames.map((f) => f.name);
  const rsStatuses = rs.frames.filter((f) => f.name === 'status').map((f) => f.data);
  const rsFinal = rs.frames.find((f) => f.name === 'final')?.data;

  ok(rs.ct.startsWith('text/event-stream'), 'rerun-turn-stream answers text/event-stream', rs.ct);
  ok(rsNames[rsNames.length - 1] === 'final', 'the last frame is `final`', rsNames[rsNames.length - 1]);
  ok(!rsNames.includes('token'),
    'a probe streams NO tokens — a counterfactual never types itself into the transcript');

  // 6a. every status is one of the four real kinds, and the first one is the
  //     host arming the frozen world, named by the source's own label.
  const KINDS = new Set(['removing', 'probe', 'thinking', 'tool']);
  ok(rsStatuses.length > 0 && rsStatuses.every((s) => KINDS.has(s.kind)),
    'every status is one of the four real kinds', `${rsStatuses.length} statuses`);
  const driverLabel = rerun.json?.ignoredLabels?.[0];
  ok(rsStatuses[0]?.kind === 'removing' && rsStatuses[0].label.includes(driverLabel),
    'the first status names the sources actually being removed, in the map’s own words',
    rsStatuses[0]?.label);

  // 6b. the probe frames are 1:1 with af's REAL probe shape: the baseline runs
  //     first (checkBaseline: true), then the ablated ones, `samples` of each —
  //     and `samples` is read back off the result the same run produced.
  const probes = rsStatuses.filter((s) => s.kind === 'probe');
  const samples = rsFinal?.result?.whatChanged?.samples;
  const baselines = probes.filter((s) => s.phase === 'baseline');
  const withouts = probes.filter((s) => s.phase === 'without');
  ok(baselines.length === samples && withouts.length === samples,
    'one probe status per seeded run — baseline ×samples and ablated ×samples, matching the result’s own count',
    `baseline ${baselines.length} · without ${withouts.length} · result.samples ${samples}`);
  ok(probes.slice(0, samples).every((s) => s.phase === 'baseline')
    && probes.slice(samples).every((s) => s.phase === 'without'),
    'the phases arrive in af’s real order — the baseline probe runs FIRST, then the ablation');
  ok(baselines.every((s, i) => s.run === i + 1) && withouts.every((s, i) => s.run === i + 1),
    'each run is numbered 1..samples within its own probe');

  // 6c. the tool lines are the frozen world, and the ablation is REAL: once the
  //     ablated probe starts, the removed tool can never appear again — it is
  //     not in that agent's catalog.
  const toolLines = rsStatuses.filter((s) => s.kind === 'tool');
  ok(toolLines.length > 0 && toolLines.every((s) => packTools.has(s.tool)),
    'every tool status names a tool this pack actually has', `${toolLines.length} tool statuses`);
  const firstWithout = rsStatuses.findIndex((s) => s.kind === 'probe' && s.phase === 'without');
  ok(rsStatuses.slice(0, firstWithout).some((s) => s.kind === 'tool' && s.tool === trip.driver),
    'the baseline runs really do consult the source under test');
  ok(!rsStatuses.slice(firstWithout).some((s) => s.kind === 'tool' && s.tool === trip.driver),
    'once the ablated probe starts, the removed source is never consulted again — the status line cannot fake an ablation');
  // Every probe run really calls the model: a probe status is always followed by
  // at least one `thinking` before the next probe.
  const perRun = probes.map((p) => {
    const at = rsStatuses.indexOf(p);
    const next = rsStatuses.findIndex((s, i) => i > at && s.kind === 'probe');
    return rsStatuses.slice(at + 1, next === -1 ? undefined : next).filter((s) => s.kind === 'thinking').length;
  });
  ok(perRun.every((n) => n > 0), 'every seeded run is followed by real llm_start lines — no empty run is announced',
    `thinking per run: ${perRun.join(',')}`);
  console.log(`      status lines : ${rsStatuses.slice(0, 6).map((s) => s.label).join(' | ')} …\n`);

  // 6d. the terminal payload IS the plain endpoint's.
  ok(JSON.stringify(Object.keys(rsFinal ?? {})) === JSON.stringify(Object.keys(rerun.json ?? {})),
    'streamed `final` and plain /rerun-turn carry the same keys in the same order (one payload, no drift)');
  ok(JSON.stringify(rsFinal?.result) === JSON.stringify(rerun.json?.result),
    'the streamed re-run result is byte-identical to the plain POST’s — the stream is a projection, not a different probe');
  ok(JSON.stringify(rsFinal?.ignoredLabels) === JSON.stringify(rerun.json?.ignoredLabels),
    'both endpoints resolve the ignored sources to the same labels');

  // 6e. kill the stream mid-flight → the plain endpoint still answers, with the
  //     same result. (Unlike a chat turn there is nothing to de-duplicate: a
  //     re-run appends no transcript entry, so the fallback is a plain re-ask.)
  const rDrill = await readStream(rerunBody, { path: RERUN, abortAfter: { name: 'status', count: 3 } });
  ok(rDrill.aborted === true && !rDrill.frames.some((f) => f.name === 'final'),
    'the drill really did die mid-stream (statuses seen, no final)',
    `${rDrill.frames.filter((f) => f.name === 'status').length} statuses before the kill`);
  const rFallback = await post('/rerun-turn', rerunBody);
  ok(rFallback.res.status === 200
    && JSON.stringify(rFallback.json?.result) === JSON.stringify(rerun.json?.result),
    'after the stream dies the plain POST answers with the same result — the page loses the status line and nothing else');

  // 6f. connect-phase failures are plain JSON, never a half-open stream.
  const rBogus = await readStream({ sessionId: 'nope', turnIndex: 0, ignore: [trip.driver] }, { path: RERUN });
  ok(!rBogus.ct.startsWith('text/event-stream') && rBogus.res.status === 400,
    'a bad sessionId fails BEFORE any stream header — plain JSON 4xx',
    `${rBogus.res.status} ${rBogus.ct}`);
  const rEmpty = await readStream({ sessionId: drillSession, turnIndex: 0, ignore: [] }, { path: RERUN });
  ok(!rEmpty.ct.startsWith('text/event-stream') && rEmpty.res.status === 400,
    'an empty ignore list fails the same way — nothing to remove is not a re-run', `${rEmpty.res.status}`);

  // ═══ 7. the BYOK path — the same statuses, with no transport at all ══════
  // On the public page the agent runs IN THE TAB, so there is no SSE hop to
  // project anything: `onEvent` goes straight through byok/local-api.js into
  // chat-core. The vocabulary has to be identical anyway, or the two builds of
  // the same desk would tell a visitor different stories about the same probe.
  console.log('\n── the in-tab (BYOK) re-run ──\n');
  const { tools: rawTools } = await buildMockTools();
  const localCore = createChatCore({ live: false });
  const decorated = decorateTools(rawTools, localCore.getPending);
  const byName = new Map(decorated.map((t) => [t.schema.name, t]));
  const perApp = new Map(APPS.map((a) => [a.id, a.tools.map((t) => byName.get(t.name))]));
  const localApi = createLocalApi({ core: localCore, packs: APPS, perApp });
  const tabSession = localApi.startSession(trip);
  await localApi.chat({ appId: 'trip', sessionId: tabSession.id, message: MSG });
  await localApi.reason({ appId: 'trip', sessionId: tabSession.id, turnIndex: 0 });
  const tabEvents = [];
  const tabRerun = await localApi.rerunTurn({
    appId: 'trip', sessionId: tabSession.id, turnIndex: 0, ignore: [trip.driver],
    onEvent: (ev) => tabEvents.push(ev),
  });
  const tabTypes = tabEvents.map((ev) => ev.type);
  ok(tabTypes[0] === 'vr.rerun.start', 'the tab is told the frozen world is armed first', tabTypes[0]);
  const tabProbes = tabEvents.filter((ev) => ev.type === 'vr.rerun.probe').map((ev) => ev.payload);
  const tabSamples = tabRerun.result.whatChanged.samples;
  ok(tabProbes.filter((p) => p.phase === 'baseline').length === tabSamples
    && tabProbes.filter((p) => p.phase === 'without').length === tabSamples,
    'the in-tab probe emits the same run boundaries the wire does',
    `baseline ${tabProbes.filter((p) => p.phase === 'baseline').length} · without ${tabProbes.filter((p) => p.phase === 'without').length}`);
  ok(tabProbes.slice(0, tabSamples).every((p) => p.phase === 'baseline'),
    'and in the same real order — baseline probe first');
  ok(tabTypes.includes('agentfootprint.stream.llm_start') && tabTypes.includes('agentfootprint.stream.tool_start'),
    'the agent’s own typed events reach the tab unchanged — no adapter in between');
  // A probe really does stream prose — which is exactly why §6's "no tokens on
  // the wire" is a filter both mappers apply on purpose, not an absence they
  // inherited. The counterfactual's words exist; neither surface types them.
  ok(tabTypes.includes('agentfootprint.stream.token'),
    'the probe’s own tokens DO reach the sink — dropping them is a decision, not an accident',
    `${tabTypes.filter((t) => t === 'agentfootprint.stream.token').length} token events, 0 narrated`);
  ok(JSON.stringify(tabRerun.result.whatChanged) === JSON.stringify(rerun.json?.result?.whatChanged),
    'the in-tab re-run reaches the same verdict as the served one — the sink observes, it does not steer');

  // The sink is scoped to the op that owns it: a plain turn taken AFTER a
  // narrated re-run must reach no re-run sink at all.
  const afterEvents = [];
  await localApi.chat({ appId: 'trip', sessionId: tabSession.id, message: 'What about "Mount Tamalpais"?',
    onEvent: (ev) => afterEvents.push(ev) });
  ok(afterEvents.length > 0 && !afterEvents.some((ev) => String(ev.type).startsWith('vr.rerun.')),
    'a later turn is never narrated as a probe — the two sinks cannot cross',
    `${afterEvents.length} turn events, 0 re-run phases`);
} finally {
  child.kill('SIGINT');
}

console.log(failed === 0
  ? '\nAll checks passed — the stream is a faithful projection of the run, and it degrades to /chat cleanly.'
  : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
