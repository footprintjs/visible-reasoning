// The debug view's DATA — built from the turn that already happened.
//
// A visitor who thinks a reply looks wrong gets three views of it, and only one
// of them needs anything prepared here:
//
//   story      an agentthinkingui `Trace`, built by agentfootprint's OWN
//              `agentThinkingTrace()` recorder (the one 03-user-facing-why
//              attaches to a live agent) driven POST-HOC over this turn's
//              recorded events. Same recorder, same mapping, same beats — the
//              events are simply replayed into it instead of arriving live. The
//              player renders it. It is small, so it rides the reply it
//              describes and the modal opens on data the page already has.
//
//   flowchart  agentfootprint-lens's `Lens`, and
//   inspector  footprint-explainable-ui's `ExplainableShell`
//              — the ecosystem's real developer views, which read the turn's
//              FROZEN RECORDING itself (run snapshot, typed event log, and the
//              agent's own blueprint). There is nothing to derive for them:
//              chat-core's `artifactsFor` hands that recording over unchanged,
//              and only when a visitor opens one of those two tabs.
//
// Nothing in this file runs an agent, calls a model, or fetches anything: it is
// a pure read of a recording.
import { agentThinkingTrace } from 'agentfootprint/observe';

const LLM_START = 'agentfootprint.stream.llm_start';

/**
 * The agentthinkingui `Trace` for one recorded turn.
 *
 * The recorder is agentfootprint's, unmodified; we hand it the turn's recorded
 * events in recorded order, adapting only the envelope (`{type, payload, meta}`
 * as captured → `{name, payload, pipelineId, subflowPath}` as the recorder's
 * `onEmit` reads it). No event is skipped, reordered or synthesized.
 */
function storyFor(events, { task, agent, asker }) {
  const first = events.find((e) => e.type === LLM_START);
  const model = (first && first.payload && first.payload.model) || 'unknown model';
  const att = agentThinkingTrace({ agent, model, asker });
  for (const e of events) {
    att.onEmit({
      name: e.type,
      payload: e.payload,
      pipelineId: e.meta && e.meta.runId,
      subflowPath: (e.meta && e.meta.subflowPath) || [],
    });
  }
  return att.getTrace({ task });
}

/**
 * The debug payload for one recorded turn — page-safe JSON, no functions and no
 * live references.
 *
 * @param turn            the recordedChat ChatTurn (its `artifacts.events` are the source)
 * @param assistantLabel  who the story says was thinking
 */
export function debugForTurn({ turn, assistantLabel }) {
  const events = (turn && turn.artifacts && turn.artifacts.events) || [];
  if (!events.length) return null;
  return {
    turnIndex: turn.index,
    question: turn.userMessage,
    answer: turn.reply,
    story: storyFor(events, { task: turn.userMessage, agent: assistantLabel, asker: 'You' }),
  };
}
