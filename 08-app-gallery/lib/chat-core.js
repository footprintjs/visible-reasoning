// The visible-reason machine, parameterized by app pack.
//
// This is 07-chat-desk's turn factory + session store + reason/rerun/fork trio,
// generalized so three apps can share ONE copy of it. 07 stays byte-identical on
// disk (it is the paper's reference implementation and carries its own byte
// gate), so the generalization lives here rather than being extracted out of it.
//
// The one structural change 08 makes: the context sources are TOOLS the agent
// calls over MCP, not facts the host pins into the prompt. So ablation filters
// `tools` instead of `injections`, and the frozen world is the turn's recorded
// tool log (replayed by lib/mcp.js's decorator) instead of a re-pinned fact set.
import { Agent } from 'agentfootprint';
import { mock, anthropic } from 'agentfootprint/llm-providers';
import { mockEmbedder } from 'agentfootprint/memory';
import {
  applyAblations, embeddingCache, listInfluenceStrategies, llmCallIdsFromEvents,
  recordedChat, removableSources, semanticAlignmentStrategy,
} from 'agentfootprint/debug';
import { metrics, provenanceFromToolLog, sourceLabelsFromToolLog } from './mcp.js';

// `makeProvider` is the browser seam: the BYOK page (08-app-gallery/byok/) hands
// in a factory that returns a fresh `browserAnthropic({ apiKey })` reading the
// visitor's CURRENT in-tab key. Omitted (every server path), the core behaves
// exactly as before — node `anthropic()` live, `mock()` otherwise — so the frozen
// byte gate is untouched.
export function createChatCore({ live = false, model = 'claude-haiku-4-5-20251001', makeProvider = null } = {}) {
  // ═══ The ONE turn factory ═════════════════════════════════════════════════
  // Live turns, rerun probes, baseline probes and fork turns ALL go through this
  // single factory. recordedChat calls it with the union of the session's
  // persistent removals and the probe's ablation `specs`; we apply them at
  // CONSTRUCTION (the documented seam) via applyAblations, with a FRESH provider
  // per call so a source's removal is a real counterfactual.
  //
  // makeAgent receives only { specs, seed }. A turn's system prompt, its entity,
  // its tool subset and its frozen tool log don't fit that signature, so — as the
  // recordedChat guide's "agent construction stays yours" permits — they ride
  // this host-side `pending` closure.
  let pending = {
    system: '', tools: [], scriptedRespond: () => '', mode: 'record',
    toolLog: new Map(), maxIterations: 2,
  };
  let probeEventSink = null; // set during a live re-run to count real LLM calls
  // The LIVE event sink — the one seam the streaming UI rides. It is set ONLY
  // inside chatTurn's serialized op and cleared in its finally, so a rerun or
  // baseline probe (which runs in its own op, with the sink null and
  // pending.mode === 'replay') can never paint tokens into a visitor's bubble.
  // Absent an `onEvent` option the sink stays null and nothing changes.
  let liveEventSink = null;

  // `pending` is a shared single-slot: every makeAgent call inside an awaited
  // operation reads it. A re-run samples makeAgent across several awaits, so two
  // agent-running operations MUST NOT overlap — otherwise a concurrent /chat
  // would repoint `pending` (and probeEventSink) at a different turn's world
  // mid-re-run, silently voiding the frozen-world guarantee the counterfactual
  // claims. One process-wide queue serializes every agent-running operation —
  // across ALL THREE apps, which is exactly what a single slot requires.
  // `.then(fn, fn)` keeps the queue alive even if a prior op rejected.
  let opQueue = Promise.resolve();
  const serial = (fn) => (opQueue = opQueue.then(fn, fn));

  const getPending = () => pending;

  function makeAgent({ specs }) {
    const { tools } = applyAblations([...specs], { tools: pending.tools });
    const toolNames = tools.map((t) => t.schema.name);
    // FRESH per call — and for BYOK that is load-bearing twice: it keeps the
    // counterfactual discipline AND means swapping or forgetting a key takes
    // effect on the very next send with no re-wiring.
    const provider = makeProvider
      ? makeProvider()
      : live
        ? anthropic()
        : mock({ respond: (req) => pending.scriptedRespond(req, { toolNames }) });
    const agent = Agent.create({
      provider, model: live ? model : 'mock-1', maxIterations: pending.maxIterations,
    }).system(pending.system).tools(tools).build();
    if (probeEventSink) { const evs = []; agent.on('*', (e) => evs.push(e)); probeEventSink.push(evs); }
    // The live tap. Double-gated on purpose: a sink exists ONLY while a
    // chatTurn op is in flight, and the mode check makes a replay probe's
    // events structurally unable to reach it.
    agent.on('*', (e) => { if (liveEventSink && pending.mode === 'record') liveEventSink(e); });
    return agent;
  }

  // ═══ Session store ════════════════════════════════════════════════════════
  // recordedChat owns the transcript + turn recording; the host keeps the
  // product-shaped state the guide leaves host-side (wire id, the per-turn frozen
  // tool log, the rerunId → result registry that /fork resolves over HTTP).
  const sessions = new Map();
  let sessionCounter = 0;
  let rerunCounter = 0;
  const embedder = embeddingCache(mockEmbedder()); // one shared embedder, process-wide

  // A turn's system prompt: role + entity, plus — under a REAL model only — the
  // pack's advisor protocol ("consult every source before you decide"). Live, a
  // model that answers off the first tool it likes yields a one-bar influence
  // panel, and the three-way comparison this gallery exists to show never appears;
  // the protocol makes the desk behave like an advisor and call all three.
  //
  // Mock mode deliberately does NOT get it. The scripted router ignores the prompt,
  // so the directive could not change a mock reply — but the influence scorer
  // embeds the system prompt as an ANCESTOR of every tool source, so appending it
  // would shift the frozen scores in expected-output.txt. Mock stays byte-stable;
  // live gets the protocol. Both modes still share one `pack.system`.
  const systemFor = (pack, entity) =>
    pack.system + pack.systemForEntity(entity) + (live ? (pack.consultProtocol ?? '') : '');

  const renderLine = (pack) => (m) => `${m.role === 'user' ? 'User' : pack.assistantLabel}: ${m.text}`;
  const makeChat = (pack, opts = {}) =>
    recordedChat({ makeAgent, format: { assistantLabel: pack.assistantLabel }, ...opts });

  function newSession({ pack, label, chat, forkOf = null, excludedIds = [], entity = null, decoratedTools }) {
    const id = `s${++sessionCounter}`;
    const s = {
      id, label, forkOf, chat, pack, appId: pack.id, decoratedTools,
      entity: entity ?? pack.entity.default,
      excludedIds: [...excludedIds],
      seedTranscript: chat.seed.map(renderLine(pack)),
      meta: [],            // per-turn { toolLog, provenance, system, entity }
      reruns: new Map(),   // rerunId → { result, ignoredIds, turnIndex }
    };
    sessions.set(id, s);
    return s;
  }

  // ═══ Running turn K ═══════════════════════════════════════════════════════
  // recordedChat.send freezes the message bytes, snapshot, events and
  // last-LLM-call id on the turn. There is NO host-side pre-fetch here: the AGENT
  // decides which of its tools to consult, and whatever it consulted lands in
  // this turn's toolLog — which IS the frozen world a re-run replays.
  //
  // `opts.onEvent`  — a per-call live event sink (the streaming UI). Absent, the
  //                   sink stays null and this function behaves byte-identically.
  // `opts.dedupe`   — the transparent-recovery read. It runs INSIDE the
  //                   serialized queue, so it naturally waits out an in-flight
  //                   streamed turn before checking: if the last recorded turn
  //                   already carries these exact message bytes, the turn ALREADY
  //                   ran (the SSE connection died, the server finished anyway)
  //                   and we hand back that turn instead of running a second one.
  //                   Only the client's mid-stream recovery ever sets it.
  function chatTurn(session, userMessage, opts = {}) {
    return serial(async () => {
      if (opts.dedupe) {
        const last = session.chat.turns[session.chat.turns.length - 1];
        if (last && last.userMessage === userMessage) return last;
      }
      const pack = session.pack;
      const entity = pack.entity.parse(userMessage, session.entity);
      session.entity = entity;
      const toolLog = new Map();
      const system = systemFor(pack, entity);
      pending = {
        system,
        tools: session.decoratedTools,
        scriptedRespond: (req, extra) => pack.scriptedRespond(req, { entity, ...extra }),
        mode: 'record',
        toolLog,
        // one LLM call per tool the agent consults, plus one to answer.
        maxIterations: session.decoratedTools.length + 2,
      };
      liveEventSink = opts.onEvent ?? null;
      try {
        const turn = await session.chat.send(userMessage);
        const names = pack.tools.map((t) => t.name);
        const provenance = provenanceFromToolLog(toolLog, names);
        // The verdict WORD and the reason behind it are recorded together, so a
        // fallback can never reach the screen without the reason it fell back for.
        const sourceLabels = sourceLabelsFromToolLog(toolLog, names);
        session.meta[turn.index] = { toolLog, provenance, sourceLabels, system, entity };
        if (live) {
          console.log(`[live][${pack.id}] ${entity}: `
            + Object.entries(provenance).map(([k, v]) => `${k}=${v}`).join(' '));
        }
        return turn;
      } finally { liveEventSink = null; }
    });
  }

  // ═══ Reasoning about turn K (the "visible reason" button) ═════════════════
  const getReport = (session, k) =>
    session.chat.reason(k, { embedder, scorer: semanticAlignmentStrategy }); // memoized per turn

  async function reasonAbout(session, k) {
    const report = await getReport(session, k);
    return { map: toInfluenceMap(session, session.chat.turn(k), report), strategies: strategyOptions() };
  }

  // 06/07's join, verbatim shape: removableSources × suspects → atui map.
  function toInfluenceMap(session, turn, report) {
    const sources = removableSources(report).map((r) => {
      const suspect =
        report.suspects.find(
          (s) => s.source === r.source && (s.detail?.injectionId ?? s.detail?.toolName ?? s.source) === r.id,
        ) ?? report.suspects.find((s) => s.source === r.source);
      return {
        id: r.id, kind: r.kind, label: r.label, source: r.source, stageName: r.stageName, score: r.score,
        snippet: suspect?.detail?.text,
        path: (suspect?.edgePath ?? []).map((h) => ({ fromName: h.fromName, toName: h.toName, kind: h.kind, key: h.key })),
      };
    });
    return {
      answer: turn.reply,
      answerLabel: 'Answer',
      question: turn.userMessage,
      sources,
      rankedBy: report.rankedBy,
      honestyFlags: report.honestyFlags.map((f) => ({ flag: f.flag, note: f.note })),
    };
  }

  // Every map is ranked with ONE scorer (getReport → semanticAlignmentStrategy).
  // atui's dropdown is a controlled component: it only fires onStrategyChange for
  // an option whose `available` is true, and natively disables (🔒 + tooltip) any
  // option marked `available: false`. The re-rank round-trip isn't wired, so we
  // advertise the other real strategy honestly but lock it — a disabled option
  // can't be picked, so the selector can never snap back with unchanged scores.
  const RANKED_STRATEGY = semanticAlignmentStrategy.name;

  function strategyOptions() {
    return listInfluenceStrategies().map((s) => {
      const available = s.name === RANKED_STRATEGY;
      return {
        name: s.name,
        description: s.description,
        requirements: available
          ? s.requirements.map(String)
          : [...s.requirements.map(String), 'live re-ranking is not wired in this demo'],
        available,
      };
    });
  }

  // ═══ decisionChanged — the domain comparator, per pack ════════════════════
  // Both answers carry a decision token (the system prompt asks for one): changed
  // = tokens differ. If either has no token (a real model may omit it), fall back
  // to af's default similarity comparator (embedding cosine < 0.8) via the shared
  // embedder — never a silent no-flip.
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }
  function decisionChanged(pack) {
    return async (original, ablated) => {
      const a = original.match(pack.decisionWords)?.[1];
      const b = ablated.match(pack.decisionWords)?.[1];
      if (a && b) return a !== b;
      const [va, vb] = await Promise.all([embedder.embed({ text: original }), embedder.embed({ text: ablated })]);
      return cosine(va, vb) < 0.8;
    };
  }

  // ═══ Re-running turn K with sources removed (the crux) ════════════════════
  // recordedChat.rerunTurn derives the runner from the SAME makeAgent that ran
  // the turn and replays the frozen message bytes verbatim. The host owns only
  // the FROZEN WORLD (the honesty keystone) and the rerunId registry: `pending`
  // flips to replay mode over turn K's recorded tool log, so the decorator
  // returns the ORIGINAL bytes and dispatches nothing.
  async function rerunTurnK(session, k, ignoreIds) {
    await getReport(session, k); // memoize the report BEFORE the re-run resolves `ignore`
    return serial(async () => {
      const pack = session.pack;
      const meta = session.meta[k] ?? {};
      const entity = meta.entity ?? session.entity;
      pending = {
        system: meta.system ?? systemFor(pack, entity),
        tools: session.decoratedTools,
        scriptedRespond: (req, extra) => pack.scriptedRespond(req, { entity, ...extra }),
        mode: 'replay',
        toolLog: meta.toolLog ?? new Map(),
        maxIterations: session.decoratedTools.length + 2,
      };
      const dispatchesBefore = metrics.toolDispatches;
      const sink = live ? [] : null; probeEventSink = sink;
      let result;
      try {
        result = await session.chat.rerunTurn(k, {
          ignore: ignoreIds,          // plain tool ids from removableSources; unknown ids THROW
          embedder,
          answerChanged: decisionChanged(pack),
          checkBaseline: true,        // unlocks the causal verdict
          samples: live ? 2 : 3,      // live cost control (floor is 2)
        });
      } finally { probeEventSink = null; }
      if (live) {
        const rerunLlmCalls = sink.reduce((n, evs) => n + llmCallIdsFromEvents(evs).length, 0);
        console.log(`[frozen-world][${pack.id}] re-run ignoring [${ignoreIds.join(', ')}]: `
          + `MCP tool dispatches during re-run = ${metrics.toolDispatches - dispatchesBefore}, `
          + `live LLM calls = ${rerunLlmCalls}`);
      }
      // Key by rerunId (append-only) so every recorded re-run stays forkable for
      // the process lifetime; /fork resolves it back to the result object that
      // recordedChat.fork identity-checks.
      const rerunId = `r${++rerunCounter}`;
      session.reruns.set(rerunId, { rerunId, result, ignoredIds: ignoreIds, turnIndex: k });
      return { rerunId, result };
    });
  }

  // ═══ "Continue from this version" — the fork ══════════════════════════════
  // recordedChat.fork owns the transcript seeding + removal merge, identity-
  // checking the re-run result (a fabricated fork throws). The host keeps only
  // the wire id, the label and the excluded ids. The original is untouched.
  function forkFrom(session, k, rerunId) {
    const hit = session.reruns.get(rerunId);
    if (!hit) throw new Error('unknown rerunId — re-run first, then fork');
    const childChat = session.chat.fork(k, { fromRerun: hit.result }); // throws on identity mismatch
    return newSession({
      pack: session.pack,
      label: `fork of turn ${k + 1} (without ${hit.ignoredIds.join(', ')})`,
      forkOf: { sessionId: session.id, turnIndex: k, ignoredIds: hit.ignoredIds },
      chat: childChat,
      excludedIds: [...new Set([...session.excludedIds, ...hit.ignoredIds])],
      entity: session.meta[k]?.entity ?? session.entity,
      decoratedTools: session.decoratedTools,
    });
  }

  /** A removable source's human label, for the what-if bubble. */
  function labelsFor(report, ids) {
    const src = removableSources(report);
    return ids.map((id) => src.find((r) => r.id === id)?.label ?? id);
  }

  function sessionToData(s) {
    return {
      id: s.id, label: s.label, forkOf: s.forkOf, appId: s.appId,
      ignoredSourceIds: s.excludedIds,
      seed: s.seedTranscript,
      entity: s.entity,
      turns: s.chat.turns.map((t) => ({
        index: t.index, userMessage: t.userMessage, reply: t.reply,
        provenance: s.meta[t.index]?.provenance ?? null,
        sourceLabels: s.meta[t.index]?.sourceLabels ?? null,
        entity: s.meta[t.index]?.entity ?? s.entity,
      })),
    };
  }

  return {
    sessions, embedder, getPending, makeChat, newSession, chatTurn,
    getReport, reasonAbout, rerunTurnK, forkFrom, labelsFor, sessionToData,
  };
}
