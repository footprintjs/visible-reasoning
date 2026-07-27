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
 * Read one chat-stream response into an ordered frame list.
 * @param opts.abortAfterFirstToken  kill the socket the moment a token lands
 *   (the mid-stream-death drill).
 */
async function readStream(body, { abortAfterFirstToken = false } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/chat-stream`, {
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
} finally {
  child.kill('SIGINT');
}

console.log(failed === 0
  ? '\nAll checks passed — the stream is a faithful projection of the run, and it degrades to /chat cleanly.'
  : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
