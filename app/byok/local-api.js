// The gallery's four endpoints, minus HTTP.
//
// run.js's serve mode exposes POST /app/<id>/{chat,reason,rerun-turn,fork}. On
// the BYOK page there is no server to POST to — so these are the SAME four
// bodies, called as plain functions, returning the SAME response objects the
// desk UI already consumes. The error strings are kept identical too, so the UI
// code ports across unchanged.
//
// This is also the custody story in code: there is no request here, so there is
// nothing for a server (ours or anyone's) to observe. The only traffic the page
// makes is the agent's calls to api.anthropic.com and the tools' calls to the
// keyless public APIs.
export function createLocalApi({ core, packs, perApp }) {
  const byId = new Map(packs.map((p) => [p.id, p]));

  const startSession = (app, label = app.title) =>
    core.newSession({ pack: app, label, chat: core.makeChat(app), decoratedTools: perApp.get(app.id) });

  const appOr404 = (appId) => {
    const app = byId.get(appId);
    if (!app) throw new Error(`unknown app '${appId}'`);
    return app;
  };

  // A supplied-but-unknown sessionId is a bug, not a new conversation.
  const resolve = (app, sessionId) => {
    const s = core.sessions.get(sessionId);
    if (!s) throw new Error('unknown sessionId — start a conversation first');
    if (s.appId !== app.id) throw new Error(`session ${s.id} belongs to '${s.appId}', not '${app.id}'`);
    return s;
  };

  // `onEvent` is the page's live status/token sink for a TURN. Each of the two
  // agent-running calls takes its OWN sink (chat here, rerunTurn below) and
  // chat-core keeps them structurally apart — a probe's events cannot reach a
  // turn's sink and a turn's cannot reach a probe's — so a counterfactual can
  // never paint into a visitor's bubble. There is still no request in this file:
  // the agent runs in the tab, so these events are already local.
  async function chat({ appId, sessionId, message, onEvent }) {
    const app = appOr404(appId);
    const session = sessionId ? resolve(app, sessionId) : startSession(app);
    if (typeof message !== 'string' || !message.trim()) throw new Error('message required');
    const turn = await core.chatTurn(session, message, { onEvent });
    const m = session.meta[turn.index] ?? {};
    return {
      sessionId: session.id, turnIndex: turn.index, reply: turn.reply,
      label: session.label, forkOf: session.forkOf, ignoredSourceIds: session.excludedIds,
      entity: m.entity ?? session.entity, provenance: m.provenance ?? null,
      sourceLabels: m.sourceLabels ?? null,
      // Same field, same builder as the server demo — and here it never even
      // leaves the tab. Derived from the turn's frozen recording, so the debug
      // modal opens on data the page already has.
      debug: core.debugFor(session, turn.index),
    };
  }

  // The turn's own recording — snapshot, event log, blueprint — for the debug
  // modal's two library views. On the server demo this is an HTTP GET; here the
  // ChatTurn objects are already in tab memory, so it is a function call and a
  // read. Same shape, same bytes, no wire hop and nothing new to trust.
  //
  // COPIED, exactly as the wire copies it. The server path serializes, so what
  // reaches those views there is a detached copy; here the same call would hand
  // over the very objects recordedChat froze, and a view that wrote into one —
  // by accident or by design — would rewrite the session's own recording. The
  // recording is the evidence; a reader of it gets a copy.
  function artifacts({ appId, sessionId, turnIndex }) {
    const session = resolve(appOr404(appId), sessionId);
    const out = core.artifactsFor(session, turnIndex);
    if (!out) throw new Error('unknown session/turn');
    return structuredClone(out);
  }

  async function reason({ appId, sessionId, turnIndex }) {
    const session = resolve(appOr404(appId), sessionId);
    if (!session.chat.turns[turnIndex]) throw new Error('unknown session/turn');
    const r = await core.reasonAbout(session, turnIndex);
    return { map: r.map, strategies: r.strategies };
  }

  // The re-run's `onEvent` is the panel's status sink. On the server demo the
  // same events cross an SSE hop; here there is no transport at all, so the
  // statuses the tab shows ARE the probe's own events, one function call away.
  async function rerunTurn({ appId, sessionId, turnIndex, ignore, onEvent }) {
    const session = resolve(appOr404(appId), sessionId);
    if (!session.chat.turns[turnIndex]) throw new Error('unknown session/turn');
    const ids = Array.isArray(ignore) ? ignore : [];
    if (ids.length === 0) throw new Error('ignore must name at least one source');
    const { rerunId, result } = await core.rerunTurnK(session, turnIndex, ids, { onEvent });
    return { rerunId, ignoredLabels: core.labelsFor(await core.getReport(session, turnIndex), ids), result };
  }

  async function fork({ appId, sessionId, turnIndex, rerunId }) {
    const session = resolve(appOr404(appId), sessionId);
    const child = core.forkFrom(session, turnIndex, rerunId); // throws on unknown rerunId
    return {
      sessionId: child.id, label: child.label, transcript: child.seedTranscript,
      ignoredSourceIds: child.excludedIds, forkOf: child.forkOf, entity: child.entity,
    };
  }

  return { startSession, chat, artifacts, reason, rerunTurn, fork };
}
