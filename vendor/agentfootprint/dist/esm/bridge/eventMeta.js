/**
 * eventMeta — build EventMeta from a footprintjs TraversalContext.
 *
 * Pattern: Adapter (GoF) — translates footprintjs's per-stage context into
 *          agentfootprint's per-event metadata shape.
 * Role:    Used by every core recorder to attach meta to emitted events.
 * Emits:   N/A (helper only).
 */
import { parseRuntimeStageId } from 'footprintjs/trace';
/**
 * Build an EventMeta from a stage origin + run-level context.
 *
 * Accepts footprintjs's TraversalContext (FlowRecorder events), RecorderContext
 * (WriteEvent / CommitEvent / etc.), or a bare StageOrigin. When the origin
 * has no runtimeStageId (rare — manual emit during tests), the meta degrades
 * gracefully to 'unknown#0'.
 */
export function buildEventMeta(origin, run) {
    const now = Date.now();
    const runtimeStageId = origin?.runtimeStageId ?? 'unknown#0';
    // Normalize subflowPath across the 3 shapes footprintjs uses:
    //   - undefined (RecorderContext: derive from runtimeStageId)
    //   - /-separated string (TraversalContext: parse)
    //   - readonly string[] (EmitEvent: pass through)
    const raw = origin?.subflowPath;
    const subflowPath = Array.isArray(raw)
        ? raw
        : typeof raw === 'string'
            ? parseSubflowPath(raw)
            : parseSubflowPath(parseRuntimeStageId(runtimeStageId).subflowPath);
    return {
        wallClockMs: now,
        runOffsetMs: now - run.runStartMs,
        runtimeStageId,
        subflowPath,
        compositionPath: run.compositionPath,
        runId: run.runId,
        ...(run.traceId !== undefined && { traceId: run.traceId }),
        ...(run.correlationId !== undefined && { correlationId: run.correlationId }),
        ...(run.turnIndex !== undefined && { turnIndex: run.turnIndex }),
        ...(run.iterIndex !== undefined && { iterIndex: run.iterIndex }),
    };
}
/**
 * Parse footprintjs's `/`-separated subflow path into a readonly array.
 *
 * The source of truth for runtimeStageId parsing lives in footprintjs at
 * `footprintjs/trace::parseRuntimeStageId`. We only need the path-split
 * convenience here; the `/` separator is stable across footprintjs
 * versions (covered by their `parseRuntimeStageId` tests).
 */
export function parseSubflowPath(raw) {
    if (!raw)
        return [];
    return raw.split('/').filter((s) => s.length > 0);
}
//# sourceMappingURL=eventMeta.js.map