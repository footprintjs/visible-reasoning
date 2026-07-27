// The debug view's DATA — built from the turn that already happened.
//
// A visitor who thinks a reply looks wrong wants two things: to watch what the
// agent did (the story), and to read what it actually ran (the trace). Both are
// derived HERE, from `turn.artifacts.events` — the typed event log recordedChat
// froze on the turn at record time. Nothing in this file runs an agent, calls a
// model, or fetches anything: it is a pure read of a recording.
//
// Two products, one source:
//
//   story — an agentthinkingui `Trace`, built by agentfootprint's OWN
//           `agentThinkingTrace()` recorder (the one 03-user-facing-why attaches
//           to a live agent) driven POST-HOC over this turn's recorded events.
//           Same recorder, same mapping, same beats — the events are simply
//           replayed into it instead of arriving live. The player renders it.
//
//   trace — the run's structure in the recording's own terms: every model call
//           with the tool menu it was given, every tool call with its arguments,
//           its returned sentence and that sentence's [source: …] label, and —
//           the question this view exists for — which tools were offered and
//           never asked for.
//
// The honesty rule of the whole gallery applies to the second one hardest. The
// recording proves what was OFFERED and what was ASKED FOR. It does NOT contain
// the model's reason for skipping a tool, and it does not prove that a tool the
// model read actually changed the answer. Both facts are stated in the payload
// (`notes`) rather than papered over — the causal question has its own machinery
// one click away ("visible reason" → re-run without a source).
import { agentThinkingTrace } from 'agentfootprint/observe';

const LLM_START = 'agentfootprint.stream.llm_start';
const LLM_END = 'agentfootprint.stream.llm_end';
const TOOL_START = 'agentfootprint.stream.tool_start';
const TOOL_END = 'agentfootprint.stream.tool_end';

/** The `[source: …]` tail a tool sentence carries, or null. Same regex as lib/mcp.js. */
const sourceLabelOf = (text) => {
  const m = /\[source:\s*([^\]]+)\]/i.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
};

/**
 * The sentence WITHOUT its label tail — so the view can show the two things a
 * tool returned as the two things they are (what it said, and what it said
 * about itself) instead of printing the tail twice. The full sentence stays on
 * the payload as `result`; nothing is dropped, only laid out.
 */
const sentenceOf = (text) => String(text ?? '').replace(/\s*\[source:[^\]]*\]\s*$/i, '').trim();

/** lib/mcp.js's verdict words, re-read off one sentence (not the whole turn). */
function provenanceOf(text) {
  const s = String(text ?? '');
  if (s.includes('[source: live')) return 'live';
  if (s.includes('[source: synthetic fallback')) return 'fallback';
  if (s.includes('[source: frozen-world replay')) return 'replay';
  if (s.includes('[source: synthetic —')) return 'synthetic';
  if (s.includes('[source: scripted demo data')) return 'scripted';
  return 'unknown';
}

/** A tool result is a string in this gallery; anything else is shown as JSON. */
function resultText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (err) { return String(value); }
}

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
 * The run's structure, step by step, plus the per-tool verdict.
 *
 * Every field below is READ from an event. Where the recording is silent the
 * payload says so instead of guessing — that is what `timingRecorded` and
 * `notes` are for.
 */
function traceFor(events, toolMeta, excludedIds) {
  const labelOf = new Map(toolMeta.map((t) => [t.name, t.legendLabel || t.name.replace(/_/g, ' ')]));
  const steps = [];
  const started = new Map();          // toolCallId → the open ask
  const offeredOn = new Map();        // toolName → how many model calls listed it
  const calls = new Map();            // toolName → [step numbers]
  let llmCalls = 0;
  let toolCalls = 0;
  let timingRecorded = false;
  let runId = null;
  let provider = null;
  let model = null;
  let firstMs = null;
  let lastMs = null;

  for (const e of events) {
    const p = e.payload || {};
    const meta = e.meta || {};
    if (runId == null && meta.runId) runId = meta.runId;
    if (typeof meta.runOffsetMs === 'number') {
      if (firstMs == null) firstMs = meta.runOffsetMs;
      lastMs = meta.runOffsetMs;
    }

    if (e.type === LLM_START) {
      provider = p.provider ?? provider;
      model = p.model ?? model;
      const offered = (p.tools || []).map((t) => t.name);
      for (const name of offered) offeredOn.set(name, (offeredOn.get(name) || 0) + 1);
      steps.push({
        n: steps.length + 1,
        kind: 'llm',
        iteration: p.iteration ?? null,
        offered,
        systemPromptChars: p.systemPromptChars ?? null,
        messagesCount: p.messagesCount ?? null,
        atMs: meta.runOffsetMs ?? null,
        stage: meta.runtimeStageId ?? null,
        // filled by the matching llm_end
        asked: [], answered: false, content: '', stopReason: null,
        tokensIn: null, tokensOut: null, ms: null,
      });
      llmCalls += 1;
      continue;
    }

    if (e.type === LLM_END) {
      // The open model call is the last one pushed — the agent loop is strictly
      // serial, so there is never more than one in flight.
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        if (steps[i].kind === 'llm') {
          steps[i].answered = (p.toolCallCount ?? 0) === 0;
          steps[i].content = p.content ?? '';
          steps[i].stopReason = p.stopReason ?? null;
          steps[i].tokensIn = p.usage ? p.usage.input ?? null : null;
          steps[i].tokensOut = p.usage ? p.usage.output ?? null : null;
          steps[i].ms = p.durationMs ?? null;
          if (p.durationMs) timingRecorded = true;
          break;
        }
      }
      continue;
    }

    if (e.type === TOOL_START) {
      const step = {
        n: steps.length + 1,
        kind: 'tool',
        name: p.toolName ?? '(tool)',
        label: labelOf.get(p.toolName) || String(p.toolName ?? 'tool').replace(/_/g, ' '),
        args: p.args ?? {},
        atMs: meta.runOffsetMs ?? null,
        stage: meta.runtimeStageId ?? null,
        // filled by the matching tool_end
        result: null, sentence: null, sourceLabel: null, provenance: null, ms: null, error: null,
      };
      steps.push(step);
      toolCalls += 1;
      if (p.toolCallId) started.set(p.toolCallId, step);
      const list = calls.get(step.name) || [];
      list.push(step.n);
      calls.set(step.name, list);
      // The model call that asked for it is the most recent one.
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        if (steps[i].kind === 'llm') { steps[i].asked.push(step.name); break; }
      }
      continue;
    }

    if (e.type === TOOL_END) {
      const step = p.toolCallId ? started.get(p.toolCallId) : null;
      if (!step) continue;
      started.delete(p.toolCallId);
      const text = resultText(p.result);
      step.result = text;
      step.sentence = sentenceOf(text);
      step.sourceLabel = sourceLabelOf(text);
      step.provenance = text ? provenanceOf(text) : null;
      step.ms = p.durationMs ?? null;
      step.error = p.error ? String(p.error) : null;
      if (p.durationMs) timingRecorded = true;
    }
  }

  // ── The per-tool verdict: the question the debug view exists to answer ──────
  // Three states, and each one is a fact the recording carries:
  //   used     — a tool_start/tool_end pair exists for it in this turn.
  //   offered  — it was in the menu of at least one model call, and never asked.
  //   absent   — it never appeared in any menu (a fork removed it, or this turn
  //              ran before it existed).
  const tools = toolMeta.map((t) => {
    const offered = offeredOn.get(t.name) || 0;
    const asked = calls.get(t.name) || [];
    const last = [...steps].reverse().find((s) => s.kind === 'tool' && s.name === t.name);
    const removed = (excludedIds || []).indexOf(t.name) !== -1;
    let state = 'absent';
    if (asked.length) state = 'used';
    else if (offered) state = 'offered';
    return {
      name: t.name,
      label: t.legendLabel || t.name.replace(/_/g, ' '),
      description: t.description || '',
      alwaysSynthetic: t.alwaysSynthetic === true,
      offeredOn: offered,
      calledAt: asked,
      state,
      removed,
      result: last ? last.result : null,
      sentence: last ? last.sentence : null,
      sourceLabel: last ? last.sourceLabel : null,
      provenance: last ? last.provenance : (state === 'absent' ? null : 'not consulted'),
      // The plain sentence a visitor reads. Written from the state, never guessed.
      why: state === 'used'
        ? `Asked for at step ${asked.join(', ')}. Its answer went back into the conversation, so it was in front of the model when the model wrote the reply.`
        : state === 'offered'
          ? `On the menu for ${offered} model call${offered === 1 ? '' : 's'} and never asked for. The recording proves the offer; it does not record why the model passed.`
          : removed
            ? 'Removed from this conversation by an earlier what-if, so it was never offered on this turn.'
            : 'Never appeared in a model call’s tool menu on this turn.',
    };
  });

  const notes = [];
  notes.push('Every line here is read from this turn’s recorded event log. Opening this view runs nothing: no model call, no tool call, no network request.');
  notes.push('“Asked for” is not the same as “changed the answer”. The recording proves what the model read; only a re-run without a source can prove what it changed — that is what “visible reason” → “re-run without this source” does.');
  if (tools.some((t) => t.state === 'offered')) {
    notes.push('For a tool that was offered and never asked for, the recording is silent on the reason. The model’s choice is not in the event log, so nothing here explains it — the story view’s tool rack shows the menu it chose from.');
  }
  if (!timingRecorded) {
    notes.push('No step recorded a duration above 0 ms — this build answers from scripted data with no network, so there is no timing to show.');
  }
  if (tools.some((t) => t.alwaysSynthetic)) {
    notes.push('A source marked synthetic is invented by construction and says so in its own sentence — it is never presented as measured data.');
  }

  return {
    runId, provider, model,
    llmCalls, toolCalls,
    wallMs: firstMs != null && lastMs != null ? lastMs - firstMs : null,
    timingRecorded,
    steps, tools, notes,
  };
}

/**
 * The whole debug payload for one recorded turn — page-safe JSON, no functions,
 * no live references.
 *
 * @param turn         the recordedChat ChatTurn (its `artifacts.events` are the source)
 * @param toolMeta     the pack's page-safe tool descriptors (name/legendLabel/description)
 * @param assistantLabel  who the story says was thinking
 * @param excludedIds  sources a fork removed from this session, if any
 */
export function debugForTurn({ turn, toolMeta, assistantLabel, excludedIds = [] }) {
  const events = (turn && turn.artifacts && turn.artifacts.events) || [];
  if (!events.length) return null;
  return {
    turnIndex: turn.index,
    question: turn.userMessage,
    answer: turn.reply,
    story: storyFor(events, { task: turn.userMessage, agent: assistantLabel, asker: 'You' }),
    trace: traceFor(events, toolMeta || [], excludedIds),
  };
}
