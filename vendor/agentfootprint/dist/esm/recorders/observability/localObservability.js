/**
 * localObservability — Tier-3 (Debug) observability: RETAIN a live run model,
 * render it live, and snapshot it for offline replay.
 *
 * One handle, two outputs:
 *   - LIVE   — `onUpdate(graph)` fires per event; pass the handle to
 *              `<Lens recorder={handle} />` and it re-renders as the agent runs.
 *   - OFFLINE— `getTrace()` (any time) and `onComplete(trace)` (auto, at run
 *              exit) freeze the model into a JSON-lossless `Trace` for `<Replay>`.
 *
 * Contrast with `enable.observability({ strategy })` (Tier-4 / Monitor), which
 * ships each event to a vendor and FORGETS. localObservability KEEPS the model
 * so you can look at it — locally, with full content. See
 * `docs/design/local-observability-and-pii.md`.
 *
 * It's a thin wrapper over `enable.flowchart` (the existing live StepGraph) +
 * `serializeTrace` (the snapshot). UI-free: returns data, never React.
 */
import { attachFlowchart } from './FlowchartRecorder.js';
import { serializeTrace } from './trace.js';
/**
 * Attach a local-observability handle. `now` is injectable for tests (the
 * library otherwise stamps `Date.now()` at serialize time).
 *
 * @internal Called from `RunnerBase.enable.localObservability`.
 */
export function attachLocalObservability(runnerAttach, dispatcher, options = {}, now = Date.now, getStructure) {
    let completed = false;
    // `let` (not const): `handle` is referenced by `buildTrace` and the onUpdate
    // closure below, both defined before its assignment. The closures only run
    // after `attachFlowchart` returns, so `handle` is always set by call time.
    // eslint-disable-next-line prefer-const
    let handle;
    const buildTrace = (override) => serializeTrace(handle.boundary.getEvents(), {
        capturedAtMs: now(),
        ...(getStructure && { structure: getStructure() }),
        ...(options.redact && { redact: options.redact }),
        ...override,
    });
    handle = attachFlowchart(runnerAttach, dispatcher, {
        onUpdate: (graph) => {
            options.onLive?.(graph);
            // Fire onRecorded once, when the root run boundary closes.
            if (options.onRecorded &&
                !completed &&
                handle.boundary.getEvents().some((e) => e.type === 'run.exit')) {
                completed = true;
                options.onRecorded(buildTrace());
            }
        },
    });
    return { ...handle, getTrace: buildTrace };
}
//# sourceMappingURL=localObservability.js.map