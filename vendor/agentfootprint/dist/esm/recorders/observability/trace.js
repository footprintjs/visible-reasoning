/**
 * Trace — a UI-free, JSON-lossless snapshot of a run for OFFLINE REPLAY.
 *
 * `localObservability()` (Tier-3 / Debug) retains a live model during a run.
 * `serializeTrace()` freezes that model into a `Trace` — plain JSON you can
 * persist (file, Redis, a bug report) and later rehydrate WITHOUT re-running
 * the agent. `agentfootprint-lens`'s `<Replay trace={…} />` consumes it and
 * rebuilds the flowchart via the existing translators.
 *
 * A `Trace` stores ONLY the domain-event log (the single source of truth the
 * Lens already reads). The step graph is ALWAYS a derived projection of those
 * events (footprint.js's "graph is derived, never post-processed" principle) —
 * it is rebuilt at render time, never stored. Storing a derived graph would be
 * redundant AND a redaction hazard: a second content surface a per-event
 * `redact` could never reach.
 *
 * PII / trust boundary: the event log carries real content — `llm.end.content`,
 * `tool.start.args`, `tool.end.result`, `context.injected.contentSummary`,
 * `run`/`subflow` `payload`, `decision.branch.rationale`. A live, in-process
 * model is fine, but **serializing is a trust-boundary crossing** (the trace
 * can travel). So redaction is applied HERE, at serialize time, via a
 * consumer `redact` function — PII never enters the `Trace`. `redactContent`
 * is a ready-made redactor covering every content field. The result is
 * self-describing: `trace.redaction`. See
 * `docs/design/local-observability-and-pii.md`.
 *
 * Because `getEvents()` is FLAT (parent + every subflow), one `redact` pass
 * covers the whole tree — no per-subflow inheritance needed here. (The engine's
 * `RedactionPolicy` separately propagates to subflows for the OBSERVER mirror.)
 */
import { buildStepGraphFromEvents } from './FlowchartRecorder.js';
/**
 * Ready-made redactor: replaces every content-bearing field with a marker,
 * keeping structure/counts for a useful replay. Covers ALL `DomainEvent`
 * content surfaces — pass it to `getTrace({ redact: redactContent })`.
 *
 * Returns a copy only when it changes something, so unaffected events stay
 * referentially identical (cheap) and the caller's live model is never mutated.
 */
export function redactContent(event) {
    switch (event.type) {
        case 'llm.end':
            return { ...event, content: `[${event.content.length} chars]` };
        case 'tool.start':
            return event.args !== undefined ? { ...event, args: '[redacted]' } : event;
        case 'tool.end':
            return event.result !== undefined ? { ...event, result: '[redacted]' } : event;
        case 'context.injected':
            return event.contentSummary !== undefined
                ? { ...event, contentSummary: '[redacted]' }
                : event;
        case 'run.entry':
        case 'run.exit':
            return event.payload !== undefined ? { ...event, payload: '[redacted]' } : event;
        case 'subflow.entry':
        case 'subflow.exit':
            return event.payload !== undefined ? { ...event, payload: '[redacted]' } : event;
        case 'decision.branch':
            return event.rationale !== undefined ? { ...event, rationale: '[redacted]' } : event;
        default:
            return event;
    }
}
/**
 * Freeze a live run model into a `Trace`. Pure: pass the `BoundaryRecorder`'s
 * `getEvents()` output.
 *
 *   const trace = serializeTrace(handle.boundary.getEvents(), {
 *     redact: redactContent,         // PII stripped before it enters the trace
 *     capturedAtMs: Date.now(),
 *   });
 *   fs.writeFileSync('run.trace.json', JSON.stringify(trace));
 */
export function serializeTrace(events, options = {}) {
    const { redact, redactionLabel, structure, summary, capturedAtMs } = options;
    // A fresh array either way, so a held Trace is detached from the live store.
    const safeEvents = redact ? events.map((e) => redact(e)) : events.slice();
    const redaction = redactionLabel ?? (redact ? 'pii' : 'none');
    return {
        version: 1,
        events: safeEvents,
        ...(structure !== undefined && { structure }),
        ...(summary !== undefined && { summary }),
        redaction,
        ...(capturedAtMs !== undefined && { capturedAtMs }),
    };
}
/**
 * Rebuild the step graph from a `Trace` — the offline half of replay. The graph
 * is ALWAYS a derived projection of `trace.events`; because those events were
 * already redacted at serialize time, the rebuilt graph is clean too (no extra
 * redaction needed — that's exactly why the graph is never stored). UI-free:
 * `agentfootprint-lens`'s `<Replay>` translates this `StepGraph` into its
 * xyflow render model.
 */
export function traceToStepGraph(trace) {
    return buildStepGraphFromEvents(trace.events);
}
//# sourceMappingURL=trace.js.map