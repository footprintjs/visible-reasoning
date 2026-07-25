/**
 * ControlDepRecorder — control-dependence tracking from flow events (RFC-003 D5).
 *
 * The gap this fills:
 *   The backtracker's `controlDeps` option (D3) needs a `ControlDepLookup`:
 *   "which decider execution allowed this stage to run?" The engine knows
 *   this during traversal but the commit log doesn't record it — control
 *   flow is a FlowRecorder concern. This recorder is the standard producer:
 *   one subscription, one lookup, plug it straight into `causalChain`.
 *
 * How it works — two correlation structures built during traversal:
 *
 *   1. `parentOf` — the runtime ancestor chain, from every stage event's
 *      `traversalContext.parentRuntimeStageId` (RFC-003 D1). Crosses
 *      subflow boundaries; loop re-entries stay unambiguous because
 *      runtime ids differ per iteration.
 *
 *   2. `branchEntryToDecision` — on `onDecision`/`onSelected` the decision
 *      is recorded as PENDING; the next stage(s) executed whose
 *      `parentRuntimeStageId` IS the decider's runtimeStageId are its
 *      branch entries (1 for a decider, N = selected.length for a
 *      selector). Correlation is by parent-id + count, NOT by stage name —
 *      subflow-mount events carry path-prefixed inner-root names that
 *      don't match `FlowDecisionEvent.chosen`, and selectors emit a
 *      synthetic fork event sharing the selector's own runtimeStageId
 *      (excluded via the self-id guard). A branch that THROWS before
 *      completing consumes its slot via `onError`, so the post-fan-out
 *      convergence stage is never misattributed as a branch entry.
 *
 *   `lookup(runtimeStageId)` then walks the ancestor chain from the stage
 *   upward; the first ancestor (or the stage itself) registered as a
 *   branch entry yields its governing decider — the NEAREST decision.
 *   Nested decisions compose naturally: the backtracker expands the
 *   decider node and asks again.
 *
 * Convention 4: state resets when `traversalContext.runId` changes — each
 * run (and each resume, which mints a fresh runId) starts clean. Control
 * chains therefore do NOT survive a pause/resume boundary: post-resume
 * stages cannot resolve pre-pause decisions.
 *
 * @example
 * ```typescript
 * import { controlDepRecorder, causalChain } from 'footprintjs/trace';
 *
 * const ctrl = controlDepRecorder();
 * executor.attachCombinedRecorder(ctrl); // auto-routes to FlowRecorder channel
 *
 * await executor.run({ input });
 *
 * const dag = causalChain(commitLog, 'approve#2', keysRead, {
 *   controlDeps: ctrl.asLookup(),
 * });
 * ```
 */
let _counter = 0;
/**
 * Factory — matches the `topologyRecorder()` / `inOutRecorder()` style.
 */
export function controlDepRecorder(options = {}) {
    return new ControlDepRecorder(options);
}
/**
 * Stateful accumulator that watches FlowRecorder events and answers
 * "which decision allowed this stage to run?" Attach via
 * `executor.attachCombinedRecorder(recorder)` (or `attachFlowRecorder`).
 */
export class ControlDepRecorder {
    id;
    /** Runtime ancestor chain: runtimeStageId → parentRuntimeStageId (D1). */
    parentOf = new Map();
    /** Recorded decisions, keyed by decider runtimeStageId. */
    decisions = new Map();
    /** Branch-entry runtimeStageId → governing decider runtimeStageId. */
    branchEntryToDecision = new Map();
    /** Decisions whose branch entries have not all been seen yet. */
    pending = [];
    /** Stage ids that already consumed a pending slot (entry OR error). */
    consumedSlots = new Set();
    /** Convention 4 — runId of the run currently being recorded. */
    lastRunId;
    constructor(options = {}) {
        this.id = options.id ?? `control-deps-${++_counter}`;
    }
    // ── FlowRecorder hooks ────────────────────────────────────────────────
    onDecision(event) {
        const ctx = event.traversalContext;
        if (!ctx)
            return;
        this.resetIfNewRun(ctx.runId);
        const deciderId = ctx.runtimeStageId;
        const ruleLabel = matchedRuleLabel(event.evidence);
        this.decisions.set(deciderId, {
            deciderRuntimeStageId: deciderId,
            chosen: event.chosen,
            ...(event.evidence && { evidence: event.evidence }),
            ...(ruleLabel !== undefined && { ruleLabel }),
        });
        this.pending.push({ deciderId, remaining: 1 });
    }
    onSelected(event) {
        const ctx = event.traversalContext;
        if (!ctx)
            return;
        this.resetIfNewRun(ctx.runId);
        if (event.selected.length === 0)
            return; // nothing selected → nothing governed
        const deciderId = ctx.runtimeStageId;
        this.decisions.set(deciderId, {
            deciderRuntimeStageId: deciderId,
            chosen: [...event.selected],
            ...(event.evidence && { evidence: event.evidence }),
        });
        this.pending.push({ deciderId, remaining: event.selected.length });
    }
    onStageExecuted(event) {
        const ctx = event.traversalContext;
        if (!ctx)
            return;
        this.resetIfNewRun(ctx.runId);
        const { runtimeStageId, parentRuntimeStageId } = ctx;
        if (parentRuntimeStageId) {
            this.parentOf.set(runtimeStageId, parentRuntimeStageId);
            this.consumePendingSlot(runtimeStageId, parentRuntimeStageId, /* register */ true);
        }
    }
    /**
     * A branch that throws never fires `onStageExecuted` — without this hook
     * its pending slot would leak and the post-fan-out convergence stage
     * (whose context also chains to the selector) would be misattributed as
     * a branch entry under best-effort (`failFast: false`) fan-outs.
     */
    onError(event) {
        const ctx = event.traversalContext;
        if (!ctx)
            return;
        this.resetIfNewRun(ctx.runId);
        if (ctx.parentRuntimeStageId) {
            // Record the chain AND attribute the failed stage to its decision —
            // the stage RAN (and may have committed partial writes) because the
            // decision chose it; failing afterwards doesn't undo the dependency.
            this.parentOf.set(ctx.runtimeStageId, ctx.parentRuntimeStageId);
            this.consumePendingSlot(ctx.runtimeStageId, ctx.parentRuntimeStageId, /* register */ true);
        }
    }
    // ── Queries ───────────────────────────────────────────────────────────
    /**
     * Resolve the NEAREST governing decision for an execution step: walks the
     * runtime ancestor chain (the step itself first) until it hits a
     * registered branch entry. `undefined` when the step is not downstream of
     * any recorded decision.
     */
    lookup(runtimeStageId) {
        const seen = new Set();
        let cur = runtimeStageId;
        while (cur !== undefined && !seen.has(cur)) {
            seen.add(cur);
            const deciderId = this.branchEntryToDecision.get(cur);
            if (deciderId !== undefined) {
                const record = this.decisions.get(deciderId);
                return {
                    deciderId,
                    ...(record?.ruleLabel !== undefined && { label: record.ruleLabel }),
                };
            }
            cur = this.parentOf.get(cur);
        }
        return undefined;
    }
    /** The lookup as a bare function — plug into `causalChain(..., { controlDeps })`. */
    asLookup() {
        return (runtimeStageId) => this.lookup(runtimeStageId);
    }
    /** All decisions recorded for the current run, in event order. */
    getDecisions() {
        return [...this.decisions.values()];
    }
    /** Reset all state (also happens automatically on runId change). */
    clear() {
        this.parentOf.clear();
        this.decisions.clear();
        this.branchEntryToDecision.clear();
        this.pending = [];
        this.consumedSlots.clear();
    }
    // ── Internals ─────────────────────────────────────────────────────────
    /** Convention 4: a new runId means a new run — reset transient state. */
    resetIfNewRun(runId) {
        if (runId === this.lastRunId)
            return;
        this.clear();
        this.lastRunId = runId;
    }
    /**
     * If `parentRuntimeStageId` is a decider with an unmatched pending slot,
     * consume one. `register` controls whether the stage is recorded as a
     * branch entry (stage executed/errored) — both paths consume the slot so
     * counts stay exact even when a stage produces both events.
     */
    consumePendingSlot(runtimeStageId, parentRuntimeStageId, register) {
        if (runtimeStageId === parentRuntimeStageId)
            return; // synthetic self-events
        if (this.consumedSlots.has(runtimeStageId))
            return;
        for (let i = 0; i < this.pending.length; i++) {
            const p = this.pending[i];
            if (p.deciderId !== parentRuntimeStageId)
                continue;
            this.consumedSlots.add(runtimeStageId);
            if (register)
                this.branchEntryToDecision.set(runtimeStageId, p.deciderId);
            p.remaining--;
            if (p.remaining <= 0)
                this.pending.splice(i, 1);
            return;
        }
    }
}
/**
 * The decide() rule label that produced the decision: the matched rule
 * mapping to the chosen branch (first matched rule as fallback).
 */
function matchedRuleLabel(evidence) {
    if (!evidence)
        return undefined;
    const rule = evidence.rules.find((r) => r.matched && r.branch === evidence.chosen) ?? evidence.rules.find((r) => r.matched);
    return rule?.label;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29udHJvbERlcFJlY29yZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9yZWNvcmRlci9Db250cm9sRGVwUmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBcURHO0FBd0NILElBQUksUUFBUSxHQUFHLENBQUMsQ0FBQztBQUVqQjs7R0FFRztBQUNILE1BQU0sVUFBVSxrQkFBa0IsQ0FBQyxVQUFxQyxFQUFFO0lBQ3hFLE9BQU8sSUFBSSxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUN6QyxDQUFDO0FBRUQ7Ozs7R0FJRztBQUNILE1BQU0sT0FBTyxrQkFBa0I7SUFDcEIsRUFBRSxDQUFTO0lBRXBCLDBFQUEwRTtJQUN6RCxRQUFRLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7SUFDdEQsMkRBQTJEO0lBQzFDLFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBaUMsQ0FBQztJQUN0RSxzRUFBc0U7SUFDckQscUJBQXFCLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7SUFDbkUsaUVBQWlFO0lBQ3pELE9BQU8sR0FBc0IsRUFBRSxDQUFDO0lBQ3hDLHVFQUF1RTtJQUN0RCxhQUFhLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUNuRCxnRUFBZ0U7SUFDeEQsU0FBUyxDQUFVO0lBRTNCLFlBQVksVUFBcUMsRUFBRTtRQUNqRCxJQUFJLENBQUMsRUFBRSxHQUFHLE9BQU8sQ0FBQyxFQUFFLElBQUksZ0JBQWdCLEVBQUUsUUFBUSxFQUFFLENBQUM7SUFDdkQsQ0FBQztJQUVELHlFQUF5RTtJQUV6RSxVQUFVLENBQUMsS0FBd0I7UUFDakMsTUFBTSxHQUFHLEdBQUcsS0FBSyxDQUFDLGdCQUFnQixDQUFDO1FBQ25DLElBQUksQ0FBQyxHQUFHO1lBQUUsT0FBTztRQUNqQixJQUFJLENBQUMsYUFB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Q0FBQyxTQUFTLENBQUMsQ0FBQztZQUMxRSxDQUFDLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDZCxJQUFJLENBQUMsQ0FBQyxTQUFTLElBQUksQ0FBQztnQkFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7WUFDaEQsT0FBTztRQUNULENBQUM7SUFDSCxDQUFDO0NBQ0Y7QUFFRDs7O0dBR0c7QUFDSCxTQUFTLGdCQUFnQixDQUFDLFFBQXNDO0lBQzlELElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDaEMsTUFBTSxJQUFJLEdBQ1IsUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxRQUFRLENBQUMsTUFBTSxDQUFDLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNqSCxPQUFPLElBQUksRUFBRSxLQUFLLENBQUM7QUFDckIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29udHJvbERlcFJlY29yZGVyIOKAlCBjb250cm9sLWRlcGVuZGVuY2UgdHJhY2tpbmcgZnJvbSBmbG93IGV2ZW50cyAoUkZDLTAwMyBENSkuXG4gKlxuICogVGhlIGdhcCB0aGlzIGZpbGxzOlxuICogICBUaGUgYmFja3RyYWNrZXIncyBgY29udHJvbERlcHNgIG9wdGlvbiAoRDMpIG5lZWRzIGEgYENvbnRyb2xEZXBMb29rdXBgOlxuICogICBcIndoaWNoIGRlY2lkZXIgZXhlY3V0aW9uIGFsbG93ZWQgdGhpcyBzdGFnZSB0byBydW4/XCIgVGhlIGVuZ2luZSBrbm93c1xuICogICB0aGlzIGR1cmluZyB0cmF2ZXJzYWwgYnV0IHRoZSBjb21taXQgbG9nIGRvZXNuJ3QgcmVjb3JkIGl0IOKAlCBjb250cm9sXG4gKiAgIGZsb3cgaXMgYSBGbG93UmVjb3JkZXIgY29uY2Vybi4gVGhpcyByZWNvcmRlciBpcyB0aGUgc3RhbmRhcmQgcHJvZHVjZXI6XG4gKiAgIG9uZSBzdWJzY3JpcHRpb24sIG9uZSBsb29rdXAsIHBsdWcgaXQgc3RyYWlnaHQgaW50byBgY2F1c2FsQ2hhaW5gLlxuICpcbiAqIEhvdyBpdCB3b3JrcyDigJQgdHdvIGNvcnJlbGF0aW9uIHN0cnVjdHVyZXMgYnVpbHQgZHVyaW5nIHRyYXZlcnNhbDpcbiAqXG4gKiAgIDEuIGBwYXJlbnRPZmAg4oCUIHRoZSBydW50aW1lIGFuY2VzdG9yIGNoYWluLCBmcm9tIGV2ZXJ5IHN0YWdlIGV2ZW50J3NcbiAqICAgICAgYHRyYXZlcnNhbENvbnRleHQucGFyZW50UnVudGltZVN0YWdlSWRgIChSRkMtMDAzIEQxKS4gQ3Jvc3Nlc1xuICogICAgICBzdWJmbG93IGJvdW5kYXJpZXM7IGxvb3AgcmUtZW50cmllcyBzdGF5IHVuYW1iaWd1b3VzIGJlY2F1c2VcbiAqICAgICAgcnVudGltZSBpZHMgZGlmZmVyIHBlciBpdGVyYXRpb24uXG4gKlxuICogICAyLiBgYnJhbmNoRW50cnlUb0RlY2lzaW9uYCDigJQgb24gYG9uRGVjaXNpb25gL2BvblNlbGVjdGVkYCB0aGUgZGVjaXNpb25cbiAqICAgICAgaXMgcmVjb3JkZWQgYXMgUEVORElORzsgdGhlIG5leHQgc3RhZ2UocykgZXhlY3V0ZWQgd2hvc2VcbiAqICAgICAgYHBhcmVudFJ1bnRpbWVTdGFnZUlkYCBJUyB0aGUgZGVjaWRlcidzIHJ1bnRpbWVTdGFnZUlkIGFyZSBpdHNcbiAqICAgICAgYnJhbmNoIGVudHJpZXMgKDEgZm9yIGEgZGVjaWRlciwgTiA9IHNlbGVjdGVkLmxlbmd0aCBmb3IgYVxuICogICAgICBzZWxlY3RvcikuIENvcnJlbGF0aW9uIGlzIGJ5IHBhcmVudC1pZCArIGNvdW50LCBOT1QgYnkgc3RhZ2UgbmFtZSDigJRcbiAqICAgICAgc3ViZmxvdy1tb3VudCBldmVudHMgY2FycnkgcGF0aC1wcmVmaXhlZCBpbm5lci1yb290IG5hbWVzIHRoYXRcbiAqICAgICAgZG9uJ3QgbWF0Y2ggYEZsb3dEZWNpc2lvbkV2ZW50LmNob3NlbmAsIGFuZCBzZWxlY3RvcnMgZW1pdCBhXG4gKiAgICAgIHN5bnRoZXRpYyBmb3JrIGV2ZW50IHNoYXJpbmcgdGhlIHNlbGVjdG9yJ3Mgb3duIHJ1bnRpbWVTdGFnZUlkXG4gKiAgICAgIChleGNsdWRlZCB2aWEgdGhlIHNlbGYtaWQgZ3VhcmQpLiBBIGJyYW5jaCB0aGF0IFRIUk9XUyBiZWZvcmVcbiAqICAgICAgY29tcGxldGluZyBjb25zdW1lcyBpdHMgc2xvdCB2aWEgYG9uRXJyb3JgLCBzbyB0aGUgcG9zdC1mYW4tb3V0XG4gKiAgICAgIGNvbnZlcmdlbmNlIHN0YWdlIGlzIG5ldmVyIG1pc2F0dHJpYnV0ZWQgYXMgYSBicmFuY2ggZW50cnkuXG4gKlxuICogICBgbG9va3VwKHJ1bnRpbWVTdGFnZUlkKWAgdGhlbiB3YWxrcyB0aGUgYW5jZXN0b3IgY2hhaW4gZnJvbSB0aGUgc3RhZ2VcbiAqICAgdXB3YXJkOyB0aGUgZmlyc3QgYW5jZXN0b3IgKG9yIHRoZSBzdGFnZSBpdHNlbGYpIHJlZ2lzdGVyZWQgYXMgYVxuICogICBicmFuY2ggZW50cnkgeWllbGRzIGl0cyBnb3Zlcm5pbmcgZGVjaWRlciDigJQgdGhlIE5FQVJFU1QgZGVjaXNpb24uXG4gKiAgIE5lc3RlZCBkZWNpc2lvbnMgY29tcG9zZSBuYXR1cmFsbHk6IHRoZSBiYWNrdHJhY2tlciBleHBhbmRzIHRoZVxuICogICBkZWNpZGVyIG5vZGUgYW5kIGFza3MgYWdhaW4uXG4gKlxuICogQ29udmVudGlvbiA0OiBzdGF0ZSByZXNldHMgd2hlbiBgdHJhdmVyc2FsQ29udGV4dC5ydW5JZGAgY2hhbmdlcyDigJQgZWFjaFxuICogcnVuIChhbmQgZWFjaCByZXN1bWUsIHdoaWNoIG1pbnRzIGEgZnJlc2ggcnVuSWQpIHN0YXJ0cyBjbGVhbi4gQ29udHJvbFxuICogY2hhaW5zIHRoZXJlZm9yZSBkbyBOT1Qgc3Vydml2ZSBhIHBhdXNlL3Jlc3VtZSBib3VuZGFyeTogcG9zdC1yZXN1bWVcbiAqIHN0YWdlcyBjYW5ub3QgcmVzb2x2ZSBwcmUtcGF1c2UgZGVjaXNpb25zLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBpbXBvcnQgeyBjb250cm9sRGVwUmVjb3JkZXIsIGNhdXNhbENoYWluIH0gZnJvbSAnZm9vdHByaW50anMvdHJhY2UnO1xuICpcbiAqIGNvbnN0IGN0cmwgPSBjb250cm9sRGVwUmVjb3JkZXIoKTtcbiAqIGV4ZWN1dG9yLmF0dGFjaENvbWJpbmVkUmVjb3JkZXIoY3RybCk7IC8vIGF1dG8tcm91dGVzIHRvIEZsb3dSZWNvcmRlciBjaGFubmVsXG4gKlxuICogYXdhaXQgZXhlY3V0b3IucnVuKHsgaW5wdXQgfSk7XG4gKlxuICogY29uc3QgZGFnID0gY2F1c2FsQ2hhaW4oY29tbWl0TG9nLCAnYXBwcm92ZSMyJywga2V5c1JlYWQsIHtcbiAqICAgY29udHJvbERlcHM6IGN0cmwuYXNMb29rdXAoKSxcbiAqIH0pO1xuICogYGBgXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBEZWNpc2lvbkV2aWRlbmNlLCBTZWxlY3Rpb25FdmlkZW5jZSB9IGZyb20gJy4uL2RlY2lkZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIEZsb3dEZWNpc2lvbkV2ZW50LFxuICBGbG93RXJyb3JFdmVudCxcbiAgRmxvd1JlY29yZGVyLFxuICBGbG93U2VsZWN0ZWRFdmVudCxcbiAgRmxvd1N0YWdlRXZlbnQsXG59IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBDb250cm9sRGVwZW5kZW5jeSwgQ29udHJvbERlcExvb2t1cCB9IGZyb20gJy4uL21lbW9yeS9iYWNrdHJhY2suanMnO1xuXG4vKiogT25lIHJlY29yZGVkIGRlY2lzaW9uL3NlbGVjdGlvbiBldmVudCAoUkZDLTAwMyBENSkuICovXG5leHBvcnQgaW50ZXJmYWNlIENvbnRyb2xEZWNpc2lvblJlY29yZCB7XG4gIC8qKiBydW50aW1lU3RhZ2VJZCBvZiB0aGUgZGVjaWRlci9zZWxlY3RvciBleGVjdXRpb24gc3RlcC4gKi9cbiAgZGVjaWRlclJ1bnRpbWVTdGFnZUlkOiBzdHJpbmc7XG4gIC8qKiBDaG9zZW4gYnJhbmNoIGRpc3BsYXkgbmFtZSAoZGVjaWRlcikgb3Igc2VsZWN0ZWQgbmFtZXMgKHNlbGVjdG9yKS4gKi9cbiAgY2hvc2VuOiBzdHJpbmcgfCByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFN0cnVjdHVyZWQgZXZpZGVuY2UgZnJvbSBkZWNpZGUoKS9zZWxlY3QoKSwgd2hlbiB0aGUgc3RhZ2UgdXNlZCB0aGVtLiAqL1xuICBldmlkZW5jZT86IERlY2lzaW9uRXZpZGVuY2UgfCBTZWxlY3Rpb25FdmlkZW5jZTtcbiAgLyoqXG4gICAqIFRoZSBkZWNpZGUoKSBydWxlIGxhYmVsIHRoYXQgcHJvZHVjZWQgdGhlIGRlY2lzaW9uIChlLmcuICdHb29kIGNyZWRpdCcpLlxuICAgKiBEZWNpZGVycyBvbmx5IOKAlCBhIHNlbGVjdG9yIHBpY2tzIE4gYnJhbmNoZXMgYW5kIG5vIHNpbmdsZSBsYWJlbFxuICAgKiBhdHRyaWJ1dGVzIHRvIGFsbCBvZiB0aGVtIChpbnNwZWN0IGBldmlkZW5jZWAgaW5zdGVhZCkuXG4gICAqL1xuICBydWxlTGFiZWw/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29udHJvbERlcFJlY29yZGVyT3B0aW9ucyB7XG4gIC8qKiBSZWNvcmRlciBpZC4gRGVmYXVsdHMgdG8gYGNvbnRyb2wtZGVwcy1OYCAoYXV0by1pbmNyZW1lbnRlZCkuICovXG4gIGlkPzogc3RyaW5nO1xufVxuXG4vKiogQSBkZWNpc2lvbiBhd2FpdGluZyBicmFuY2gtZW50cnkgY29ycmVsYXRpb24uICovXG5pbnRlcmZhY2UgUGVuZGluZ0RlY2lzaW9uIHtcbiAgZGVjaWRlcklkOiBzdHJpbmc7XG4gIC8qKiBIb3cgbWFueSBicmFuY2ggZW50cmllcyBhcmUgc3RpbGwgZXhwZWN0ZWQgKGRlY2lkZXI6IDEsIHNlbGVjdG9yOiBOKS4gKi9cbiAgcmVtYWluaW5nOiBudW1iZXI7XG59XG5cbmxldCBfY291bnRlciA9IDA7XG5cbi8qKlxuICogRmFjdG9yeSDigJQgbWF0Y2hlcyB0aGUgYHRvcG9sb2d5UmVjb3JkZXIoKWAgLyBgaW5PdXRSZWNvcmRlcigpYCBzdHlsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRyb2xEZXBSZWNvcmRlcihvcHRpb25zOiBDb250cm9sRGVwUmVjb3JkZXJPcHRpb25zID0ge30pOiBDb250cm9sRGVwUmVjb3JkZXIge1xuICByZXR1cm4gbmV3IENvbnRyb2xEZXBSZWNvcmRlcihvcHRpb25zKTtcbn1cblxuLyoqXG4gKiBTdGF0ZWZ1bCBhY2N1bXVsYXRvciB0aGF0IHdhdGNoZXMgRmxvd1JlY29yZGVyIGV2ZW50cyBhbmQgYW5zd2Vyc1xuICogXCJ3aGljaCBkZWNpc2lvbiBhbGxvd2VkIHRoaXMgc3RhZ2UgdG8gcnVuP1wiIEF0dGFjaCB2aWFcbiAqIGBleGVjdXRvci5hdHRhY2hDb21iaW5lZFJlY29yZGVyKHJlY29yZGVyKWAgKG9yIGBhdHRhY2hGbG93UmVjb3JkZXJgKS5cbiAqL1xuZXhwb3J0IGNsYXNzIENvbnRyb2xEZXBSZWNvcmRlciBpbXBsZW1lbnRzIEZsb3dSZWNvcmRlciB7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG5cbiAgLyoqIFJ1bnRpbWUgYW5jZXN0b3IgY2hhaW46IHJ1bnRpbWVTdGFnZUlkIOKGkiBwYXJlbnRSdW50aW1lU3RhZ2VJZCAoRDEpLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudE9mID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIFJlY29yZGVkIGRlY2lzaW9ucywga2V5ZWQgYnkgZGVjaWRlciBydW50aW1lU3RhZ2VJZC4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBkZWNpc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgQ29udHJvbERlY2lzaW9uUmVjb3JkPigpO1xuICAvKiogQnJhbmNoLWVudHJ5IHJ1bnRpbWVTdGFnZUlkIOKGkiBnb3Zlcm5pbmcgZGVjaWRlciBydW50aW1lU3RhZ2VJZC4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBicmFuY2hFbnRyeVRvRGVjaXNpb24gPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogRGVjaXNpb25zIHdob3NlIGJyYW5jaCBlbnRyaWVzIGhhdmUgbm90IGFsbCBiZWVuIHNlZW4geWV0LiAqL1xuICBwcml2YXRlIHBlbmRpbmc6IFBlbmRpbmdEZWNpc2lvbltdID0gW107XG4gIC8qKiBTdGFnZSBpZHMgdGhhdCBhbHJlYWR5IGNvbnN1bWVkIGEgcGVuZGluZyBzbG90IChlbnRyeSBPUiBlcnJvcikuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgY29uc3VtZWRTbG90cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAvKiogQ29udmVudGlvbiA0IOKAlCBydW5JZCBvZiB0aGUgcnVuIGN1cnJlbnRseSBiZWluZyByZWNvcmRlZC4gKi9cbiAgcHJpdmF0ZSBsYXN0UnVuSWQ/OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9uczogQ29udHJvbERlcFJlY29yZGVyT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5pZCA9IG9wdGlvbnMuaWQgPz8gYGNvbnRyb2wtZGVwcy0keysrX2NvdW50ZXJ9YDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBGbG93UmVjb3JkZXIgaG9va3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgb25EZWNpc2lvbihldmVudDogRmxvd0RlY2lzaW9uRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjdHggPSBldmVudC50cmF2ZXJzYWxDb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm47XG4gICAgdGhpcy5yZXNldElmTmV3UnVuKGN0eC5ydW5JZCk7XG5cbiAgICBjb25zdCBkZWNpZGVySWQgPSBjdHgucnVudGltZVN0YWdlSWQ7XG4gICAgY29uc3QgcnVsZUxhYmVsID0gbWF0Y2hlZFJ1bGVMYWJlbChldmVudC5ldmlkZW5jZSk7XG4gICAgdGhpcy5kZWNpc2lvbnMuc2V0KGRlY2lkZXJJZCwge1xuICAgICAgZGVjaWRlclJ1bnRpbWVTdGFnZUlkOiBkZWNpZGVySWQsXG4gICAgICBjaG9zZW46IGV2ZW50LmNob3NlbixcbiAgICAgIC4uLihldmVudC5ldmlkZW5jZSAmJiB7IGV2aWRlbmNlOiBldmVudC5ldmlkZW5jZSB9KSxcbiAgICAgIC4uLihydWxlTGFiZWwgIT09IHVuZGVmaW5lZCAmJiB7IHJ1bGVMYWJlbCB9KSxcbiAgICB9KTtcbiAgICB0aGlzLnBlbmRpbmcucHVzaCh7IGRlY2lkZXJJZCwgcmVtYWluaW5nOiAxIH0pO1xuICB9XG5cbiAgb25TZWxlY3RlZChldmVudDogRmxvd1NlbGVjdGVkRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjdHggPSBldmVudC50cmF2ZXJzYWxDb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm47XG4gICAgdGhpcy5yZXNldElmTmV3UnVuKGN0eC5ydW5JZCk7XG4gICAgaWYgKGV2ZW50LnNlbGVjdGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuOyAvLyBub3RoaW5nIHNlbGVjdGVkIOKGkiBub3RoaW5nIGdvdmVybmVkXG5cbiAgICBjb25zdCBkZWNpZGVySWQgPSBjdHgucnVudGltZVN0YWdlSWQ7XG4gICAgdGhpcy5kZWNpc2lvbnMuc2V0KGRlY2lkZXJJZCwge1xuICAgICAgZGVjaWRlclJ1bnRpbWVTdGFnZUlkOiBkZWNpZGVySWQsXG4gICAgICBjaG9zZW46IFsuLi5ldmVudC5zZWxlY3RlZF0sXG4gICAgICAuLi4oZXZlbnQuZXZpZGVuY2UgJiYgeyBldmlkZW5jZTogZXZlbnQuZXZpZGVuY2UgfSksXG4gICAgfSk7XG4gICAgdGhpcy5wZW5kaW5nLnB1c2goeyBkZWNpZGVySWQsIHJlbWFpbmluZzogZXZlbnQuc2VsZWN0ZWQubGVuZ3RoIH0pO1xuICB9XG5cbiAgb25TdGFnZUV4ZWN1dGVkKGV2ZW50OiBGbG93U3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGN0eCA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ7XG4gICAgaWYgKCFjdHgpIHJldHVybjtcbiAgICB0aGlzLnJlc2V0SWZOZXdSdW4oY3R4LnJ1bklkKTtcblxuICAgIGNvbnN0IHsgcnVudGltZVN0YWdlSWQsIHBhcmVudFJ1bnRpbWVTdGFnZUlkIH0gPSBjdHg7XG4gICAgaWYgKHBhcmVudFJ1bnRpbWVTdGFnZUlkKSB7XG4gICAgICB0aGlzLnBhcmVudE9mLnNldChydW50aW1lU3RhZ2VJZCwgcGFyZW50UnVudGltZVN0YWdlSWQpO1xuICAgICAgdGhpcy5jb25zdW1lUGVuZGluZ1Nsb3QocnVudGltZVN0YWdlSWQsIHBhcmVudFJ1bnRpbWVTdGFnZUlkLCAvKiByZWdpc3RlciAqLyB0cnVlKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQSBicmFuY2ggdGhhdCB0aHJvd3MgbmV2ZXIgZmlyZXMgYG9uU3RhZ2VFeGVjdXRlZGAg4oCUIHdpdGhvdXQgdGhpcyBob29rXG4gICAqIGl0cyBwZW5kaW5nIHNsb3Qgd291bGQgbGVhayBhbmQgdGhlIHBvc3QtZmFuLW91dCBjb252ZXJnZW5jZSBzdGFnZVxuICAgKiAod2hvc2UgY29udGV4dCBhbHNvIGNoYWlucyB0byB0aGUgc2VsZWN0b3IpIHdvdWxkIGJlIG1pc2F0dHJpYnV0ZWQgYXNcbiAgICogYSBicmFuY2ggZW50cnkgdW5kZXIgYmVzdC1lZmZvcnQgKGBmYWlsRmFzdDogZmFsc2VgKSBmYW4tb3V0cy5cbiAgICovXG4gIG9uRXJyb3IoZXZlbnQ6IEZsb3dFcnJvckV2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY3R4ID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dDtcbiAgICBpZiAoIWN0eCkgcmV0dXJuO1xuICAgIHRoaXMucmVzZXRJZk5ld1J1bihjdHgucnVuSWQpO1xuICAgIGlmIChjdHgucGFyZW50UnVudGltZVN0YWdlSWQpIHtcbiAgICAgIC8vIFJlY29yZCB0aGUgY2hhaW4gQU5EIGF0dHJpYnV0ZSB0aGUgZmFpbGVkIHN0YWdlIHRvIGl0cyBkZWNpc2lvbiDigJRcbiAgICAgIC8vIHRoZSBzdGFnZSBSQU4gKGFuZCBtYXkgaGF2ZSBjb21taXR0ZWQgcGFydGlhbCB3cml0ZXMpIGJlY2F1c2UgdGhlXG4gICAgICAvLyBkZWNpc2lvbiBjaG9zZSBpdDsgZmFpbGluZyBhZnRlcndhcmRzIGRvZXNuJ3QgdW5kbyB0aGUgZGVwZW5kZW5jeS5cbiAgICAgIHRoaXMucGFyZW50T2Yuc2V0KGN0eC5ydW50aW1lU3RhZ2VJZCwgY3R4LnBhcmVudFJ1bnRpbWVTdGFnZUlkKTtcbiAgICAgIHRoaXMuY29uc3VtZVBlbmRpbmdTbG90KGN0eC5ydW50aW1lU3RhZ2VJZCwgY3R4LnBhcmVudFJ1bnRpbWVTdGFnZUlkLCAvKiByZWdpc3RlciAqLyB0cnVlKTtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgUXVlcmllcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogUmVzb2x2ZSB0aGUgTkVBUkVTVCBnb3Zlcm5pbmcgZGVjaXNpb24gZm9yIGFuIGV4ZWN1dGlvbiBzdGVwOiB3YWxrcyB0aGVcbiAgICogcnVudGltZSBhbmNlc3RvciBjaGFpbiAodGhlIHN0ZXAgaXRzZWxmIGZpcnN0KSB1bnRpbCBpdCBoaXRzIGFcbiAgICogcmVnaXN0ZXJlZCBicmFuY2ggZW50cnkuIGB1bmRlZmluZWRgIHdoZW4gdGhlIHN0ZXAgaXMgbm90IGRvd25zdHJlYW0gb2ZcbiAgICogYW55IHJlY29yZGVkIGRlY2lzaW9uLlxuICAgKi9cbiAgbG9va3VwKHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmcpOiBDb250cm9sRGVwZW5kZW5jeSB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGxldCBjdXI6IHN0cmluZyB8IHVuZGVmaW5lZCA9IHJ1bnRpbWVTdGFnZUlkO1xuICAgIHdoaWxlIChjdXIgIT09IHVuZGVmaW5lZCAmJiAhc2Vlbi5oYXMoY3VyKSkge1xuICAgICAgc2Vlbi5hZGQoY3VyKTtcbiAgICAgIGNvbnN0IGRlY2lkZXJJZCA9IHRoaXMuYnJhbmNoRW50cnlUb0RlY2lzaW9uLmdldChjdXIpO1xuICAgICAgaWYgKGRlY2lkZXJJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHRoaXMuZGVjaXNpb25zLmdldChkZWNpZGVySWQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRlY2lkZXJJZCxcbiAgICAgICAgICAuLi4ocmVjb3JkPy5ydWxlTGFiZWwgIT09IHVuZGVmaW5lZCAmJiB7IGxhYmVsOiByZWNvcmQucnVsZUxhYmVsIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY3VyID0gdGhpcy5wYXJlbnRPZi5nZXQoY3VyKTtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKiBUaGUgbG9va3VwIGFzIGEgYmFyZSBmdW5jdGlvbiDigJQgcGx1ZyBpbnRvIGBjYXVzYWxDaGFpbiguLi4sIHsgY29udHJvbERlcHMgfSlgLiAqL1xuICBhc0xvb2t1cCgpOiBDb250cm9sRGVwTG9va3VwIHtcbiAgICByZXR1cm4gKHJ1bnRpbWVTdGFnZUlkKSA9PiB0aGlzLmxvb2t1cChydW50aW1lU3RhZ2VJZCk7XG4gIH1cblxuICAvKiogQWxsIGRlY2lzaW9ucyByZWNvcmRlZCBmb3IgdGhlIGN1cnJlbnQgcnVuLCBpbiBldmVudCBvcmRlci4gKi9cbiAgZ2V0RGVjaXNpb25zKCk6IENvbnRyb2xEZWNpc2lvblJlY29yZFtdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuZGVjaXNpb25zLnZhbHVlcygpXTtcbiAgfVxuXG4gIC8qKiBSZXNldCBhbGwgc3RhdGUgKGFsc28gaGFwcGVucyBhdXRvbWF0aWNhbGx5IG9uIHJ1bklkIGNoYW5nZSkuICovXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIHRoaXMucGFyZW50T2YuY2xlYXIoKTtcbiAgICB0aGlzLmRlY2lzaW9ucy5jbGVhcigpO1xuICAgIHRoaXMuYnJhbmNoRW50cnlUb0RlY2lzaW9uLmNsZWFyKCk7XG4gICAgdGhpcy5wZW5kaW5nID0gW107XG4gICAgdGhpcy5jb25zdW1lZFNsb3RzLmNsZWFyKCk7XG4gIH1cblxuICAvLyDilIDilIAgSW50ZXJuYWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBDb252ZW50aW9uIDQ6IGEgbmV3IHJ1bklkIG1lYW5zIGEgbmV3IHJ1biDigJQgcmVzZXQgdHJhbnNpZW50IHN0YXRlLiAqL1xuICBwcml2YXRlIHJlc2V0SWZOZXdSdW4ocnVuSWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChydW5JZCA9PT0gdGhpcy5sYXN0UnVuSWQpIHJldHVybjtcbiAgICB0aGlzLmNsZWFyKCk7XG4gICAgdGhpcy5sYXN0UnVuSWQgPSBydW5JZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBJZiBgcGFyZW50UnVudGltZVN0YWdlSWRgIGlzIGEgZGVjaWRlciB3aXRoIGFuIHVubWF0Y2hlZCBwZW5kaW5nIHNsb3QsXG4gICAqIGNvbnN1bWUgb25lLiBgcmVnaXN0ZXJgIGNvbnRyb2xzIHdoZXRoZXIgdGhlIHN0YWdlIGlzIHJlY29yZGVkIGFzIGFcbiAgICogYnJhbmNoIGVudHJ5IChzdGFnZSBleGVjdXRlZC9lcnJvcmVkKSDigJQgYm90aCBwYXRocyBjb25zdW1lIHRoZSBzbG90IHNvXG4gICAqIGNvdW50cyBzdGF5IGV4YWN0IGV2ZW4gd2hlbiBhIHN0YWdlIHByb2R1Y2VzIGJvdGggZXZlbnRzLlxuICAgKi9cbiAgcHJpdmF0ZSBjb25zdW1lUGVuZGluZ1Nsb3QocnVudGltZVN0YWdlSWQ6IHN0cmluZywgcGFyZW50UnVudGltZVN0YWdlSWQ6IHN0cmluZywgcmVnaXN0ZXI6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBpZiAocnVudGltZVN0YWdlSWQgPT09IHBhcmVudFJ1bnRpbWVTdGFnZUlkKSByZXR1cm47IC8vIHN5bnRoZXRpYyBzZWxmLWV2ZW50c1xuICAgIGlmICh0aGlzLmNvbnN1bWVkU2xvdHMuaGFzKHJ1bnRpbWVTdGFnZUlkKSkgcmV0dXJuO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLnBlbmRpbmcubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHAgPSB0aGlzLnBlbmRpbmdbaV07XG4gICAgICBpZiAocC5kZWNpZGVySWQgIT09IHBhcmVudFJ1bnRpbWVTdGFnZUlkKSBjb250aW51ZTtcblxuICAgICAgdGhpcy5jb25zdW1lZFNsb3RzLmFkZChydW50aW1lU3RhZ2VJZCk7XG4gICAgICBpZiAocmVnaXN0ZXIpIHRoaXMuYnJhbmNoRW50cnlUb0RlY2lzaW9uLnNldChydW50aW1lU3RhZ2VJZCwgcC5kZWNpZGVySWQpO1xuICAgICAgcC5yZW1haW5pbmctLTtcbiAgICAgIGlmIChwLnJlbWFpbmluZyA8PSAwKSB0aGlzLnBlbmRpbmcuc3BsaWNlKGksIDEpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIFRoZSBkZWNpZGUoKSBydWxlIGxhYmVsIHRoYXQgcHJvZHVjZWQgdGhlIGRlY2lzaW9uOiB0aGUgbWF0Y2hlZCBydWxlXG4gKiBtYXBwaW5nIHRvIHRoZSBjaG9zZW4gYnJhbmNoIChmaXJzdCBtYXRjaGVkIHJ1bGUgYXMgZmFsbGJhY2spLlxuICovXG5mdW5jdGlvbiBtYXRjaGVkUnVsZUxhYmVsKGV2aWRlbmNlOiBEZWNpc2lvbkV2aWRlbmNlIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFldmlkZW5jZSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcnVsZSA9XG4gICAgZXZpZGVuY2UucnVsZXMuZmluZCgocikgPT4gci5tYXRjaGVkICYmIHIuYnJhbmNoID09PSBldmlkZW5jZS5jaG9zZW4pID8/IGV2aWRlbmNlLnJ1bGVzLmZpbmQoKHIpID0+IHIubWF0Y2hlZCk7XG4gIHJldHVybiBydWxlPy5sYWJlbDtcbn1cbiJdfQ==