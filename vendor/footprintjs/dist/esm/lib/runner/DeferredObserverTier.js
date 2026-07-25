/**
 * runner/DeferredObserverTier.ts — RFC-001 Blocks 6–9: the engine wiring of
 * the deferred-observer pipeline.
 *
 * Pattern:  Thin adapter between the executor's three observer channels and
 *           the PURE `observer-queue` module. The pure module stays
 *           engine-free (it imports nothing from the engine — the engine
 *           imports IT); this tier owns every engine-flavored concern:
 *             - the `isDevMode()`-gated, deduplicated `CaptureHooks.warn`
 *               binding (the dev-warn seam, RFC-001 §"Resolution");
 *             - routing `DeferredDispatcher.onError` into the existing
 *               recorder error channel (`onError` on sibling observers);
 *             - the capture TAPS — synthetic recorders placed on the
 *               existing inline dispatch lists so the three dispatch sites
 *               (`ScopeFacade._invokeHook`, `ScopeFacade.emitEvent`,
 *               `FlowRecorderDispatcher`) need NO per-site tier logic: a
 *               tap's hook body IS `dispatcher.capture(...)`, and because
 *               the tap sits in the same loop as inline recorders it sees
 *               exactly the post-redaction event object inline observers
 *               see — capture can never observe a pre-redaction value;
 *             - the terminal flush (Block 8) with honest stranding
 *               accounting, and the Block 9 stats surface.
 *
 * Role:     One instance per `FlowChartExecutor`, created LAZILY on the
 *           first `delivery: 'deferred'` attach (zero allocation when nobody
 *           opts in — mirrors the emit fast-path precedent). Holds the ONE
 *           `DeferredDispatcher` (one merged queue, total order across
 *           channels) plus the registry of deferred recorders.
 *
 * Delivery: a deferred recorder's hooks are invoked through the SAME
 * `invokeRecorderHook` helper the inline tier uses (RFC-001 §9 mitigation) —
 * one beat behind, with `envelope.payload` materialized per the capture
 * policy (`'summary'` default — bounded, reference-free; `'clone'` — full
 * structural copy, event-shape compatible with inline; `'ref'` — the live
 * event object, dev-warned).
 *
 * Channel filter: a registration remembers which channels would have
 * reached the recorder inline (scope-list recorders see `scope` + `emit`
 * envelopes; flow-list recorders see `flow` envelopes) and skips the rest —
 * same reach as the inline tier, one beat behind.
 */
import { DeferredDispatcher, } from '../observer-queue/index.js';
import { EMIT_RECORDER_EVENT_METHODS, FLOW_RECORDER_EVENT_METHODS, RECORDER_EVENT_METHODS, } from '../recorder/CombinedRecorder.js';
import { invokeRecorderHook } from '../recorder/invokeHook.js';
import { isDevMode } from '../scope/detectCircular.js';
/** Well-known ids of the synthetic capture taps (internal, documented for debugging). */
export const DEFERRED_SCOPE_TAP_ID = '__deferred-scope-tap__';
export const DEFERRED_FLOW_TAP_ID = '__deferred-flow-tap__';
/** Channel reach of the scope-recorder list (scope events + emit events). */
const SCOPE_LIST_CHANNELS = ['scope', 'emit'];
/** Channel reach of the flow-recorder list. */
const FLOW_LIST_CHANNELS = ['flow'];
/** Map an envelope method onto the scope error-event `operation` vocabulary
 *  (same mapping `ScopeFacade._invokeHook` uses for inline failures). */
function operationFor(method) {
    if (method === 'onRead')
        return 'read';
    if (method === 'onCommit')
        return 'commit';
    return 'write';
}
export class DeferredObserverTier {
    dispatcher;
    registrations = new Map();
    appliedConfig;
    /** Dedup memory for the dev-warn seam (one warning per unique message). */
    warnedMessages = new Set();
    terminalStranded = 0;
    constructor(options) {
        this.appliedConfig = {
            // Attach-surface default is 'clone' (review CRITICAL-2): a recorder
            // ported with `{ delivery: 'deferred' }` keeps receiving the SAME
            // event shape as inline (e.key/e.value/e.runtimeStageId all intact).
            // The module-internal envelope default stays 'summary' for raw-
            // envelope consumers; 'summary' here is an explicit telemetry choice.
            capture: options?.capture ?? 'clone',
            maxQueue: options?.maxQueue,
            overflow: options?.overflow,
            sampleEvery: options?.sampleEvery,
            flushBudgetMs: options?.flushBudgetMs,
        };
        this.dispatcher = new DeferredDispatcher({
            maxQueue: options?.maxQueue,
            overflow: options?.overflow,
            sampleEvery: options?.sampleEvery,
            capturePolicy: options?.capture ?? 'clone',
            flushBudgetMs: options?.flushBudgetMs,
            // The dev-warn seam (RFC-001 §"Resolution: the dev-warn seam"): the
            // pure module invokes `warn` on every 'ref' capture and every 'clone'
            // degradation; the tier binds it to the central isDevMode() flag and
            // dedupes by message so a hot loop cannot spam the console.
            hooks: { warn: (message) => this.devWarnDeduped(message) },
            // Listener failures (sync throws AND async rejections) route into the
            // existing recorder error channel — see routeListenerError.
            onError: (error, ctx) => this.routeListenerError(error, ctx.listenerId, ctx.envelope, ctx.phase),
        });
    }
    // ── Registry ─────────────────────────────────────────────────────────────
    /**
     * Register a recorder for deferred delivery on the scope-list channels
     * (`scope` + `emit`) and/or the flow channel. Idempotent by id — same id
     * replaces the recorder object; channel lists MERGE across calls (same as
     * the inline tier, where `attachScopeRecorder(x)` + `attachFlowRecorder(x)`
     * lands `x` on both lists). Later attaches passing dispatcher-level
     * options that differ from the first attach's configuration keep the
     * original config and dev-warn.
     */
    register(recorder, lists, options) {
        this.warnOnConfigConflict(recorder.id, options);
        const channels = this.registrations.get(recorder.id)?.channels ?? new Set();
        if (lists.scope)
            for (const c of SCOPE_LIST_CHANNELS)
                channels.add(c);
        if (lists.flow)
            for (const c of FLOW_LIST_CHANNELS)
                channels.add(c);
        this.registrations.set(recorder.id, { recorder, channels });
        this.dispatcher.addListener(recorder.id, (envelope) => {
            const registration = this.registrations.get(recorder.id);
            if (!registration || !registration.channels.has(envelope.channel))
                return;
            // SAME invoke helper as the inline tier (RFC-001 §9 mitigation) — a
            // returned Promise lands in the dispatcher's inflight set.
            return invokeRecorderHook(recorder, envelope.method, envelope.payload);
        });
    }
    /**
     * Remove the given channel lists from a registration (mirrors the inline
     * tier, where `detachScopeRecorder` / `detachFlowRecorder` each clear one
     * list). When no channels remain, the listener is fully removed.
     */
    removeFromLists(id, lists) {
        const registration = this.registrations.get(id);
        if (!registration)
            return;
        if (lists.scope)
            for (const c of SCOPE_LIST_CHANNELS)
                registration.channels.delete(c);
        if (lists.flow)
            for (const c of FLOW_LIST_CHANNELS)
                registration.channels.delete(c);
        if (registration.channels.size === 0) {
            this.registrations.delete(id);
            this.dispatcher.removeListener(id);
        }
    }
    /** True when `id` is registered for deferred delivery (any channel). */
    has(id) {
        return this.registrations.has(id);
    }
    /** Deferred recorders whose reach includes the scope list (scope+emit). */
    scopeListRecorders() {
        return this.byChannel('scope');
    }
    /** Deferred recorders whose reach includes the flow channel. */
    flowListRecorders() {
        return this.byChannel('flow');
    }
    /** Reset deferred recorders before a fresh run (same contract as inline). */
    clearRecorders() {
        for (const { recorder } of this.registrations.values()) {
            recorder.clear?.();
        }
    }
    // ── Capture taps (Block 7) ───────────────────────────────────────────────
    /**
     * Build the synthetic scope-channel tap — a `ScopeRecorder` placed on the
     * normal scope-recorder list whose hooks capture into the queue. Built
     * fresh per traverser so it reflects the current registrations. Only
     * methods some deferred recorder actually implements are present (no
     * wasted captures). Returns `undefined` when nothing is registered for
     * the scope list.
     *
     * Redaction ordering: the tap is invoked from the SAME loops as inline
     * recorders (`_invokeHook` / `emitEvent`), which receive events AFTER the
     * redaction decision — so a captured payload can never contain a
     * pre-redaction value the inline tier would not have seen.
     */
    buildScopeTap() {
        const recorders = this.scopeListRecorders();
        if (recorders.length === 0)
            return undefined;
        const tap = { id: DEFERRED_SCOPE_TAP_ID };
        for (const method of RECORDER_EVENT_METHODS) {
            if (!this.anyImplements(recorders, method))
                continue;
            tap[method] = (event) => this.captureScopeEvent('scope', method, event);
        }
        for (const method of EMIT_RECORDER_EVENT_METHODS) {
            if (!this.anyImplements(recorders, method))
                continue;
            tap[method] = (event) => this.captureScopeEvent('emit', method, event);
        }
        return tap;
    }
    /**
     * Build the synthetic flow-channel tap — a `FlowRecorder` appended to the
     * flow-recorders list handed to the traverser. Same contract as
     * {@link buildScopeTap}.
     */
    buildFlowTap() {
        const recorders = this.flowListRecorders();
        if (recorders.length === 0)
            return undefined;
        const tap = { id: DEFERRED_FLOW_TAP_ID };
        for (const method of FLOW_RECORDER_EVENT_METHODS) {
            if (!this.anyImplements(recorders, method))
                continue;
            tap[method] = (event) => this.captureFlowEvent(method, event);
        }
        return tap;
    }
    /**
     * Direct capture for executor-synthesized events that bypass the dispatch
     * sites (e.g. the synthetic `onResume` the executor fires on resume).
     */
    capture(channel, method, runtimeStageId, runId, payload) {
        this.dispatcher.capture({ channel, method, runtimeStageId, runId, payload });
    }
    // ── Terminal flush + drain (Block 8) ─────────────────────────────────────
    /**
     * Synchronously deliver everything still queued — called by the executor
     * at the OUTERMOST run boundary (resolve, reject, pause), BEFORE `run()`
     * returns / rethrows / the checkpoint becomes available. Inspects
     * `flushSync`'s `remaining` (reviewer N1): `flushSync` already loops
     * snapshot rounds up to its runaway-cascade cap, so a non-zero remainder
     * means a pathological self-enqueueing listener — counted in
     * `observerStats.terminalStranded` and dev-warned, never silent.
     */
    terminalFlush() {
        const { remaining } = this.dispatcher.flushNow();
        if (remaining > 0) {
            this.terminalStranded += remaining;
            if (isDevMode()) {
                // eslint-disable-next-line no-console
                console.warn(`[footprintjs] deferred observers: terminal flush hit the runaway-cascade cap with ${remaining} ` +
                    'event(s) still queued — a listener kept enqueueing during the flush. The stranded count is ' +
                    'surfaced on snapshot.observerStats.terminalStranded.');
            }
        }
    }
    /**
     * Flush the backlog, then settle async listener continuations under a
     * deadline — the serverless / graceful-shutdown pattern (RFC-001 §11).
     */
    drain(opts) {
        return this.dispatcher.drain(opts);
    }
    // ── Stats (Block 9) ──────────────────────────────────────────────────────
    /** The `snapshot.observerStats` payload — A4 stats + Block 8 stranding. */
    getStats() {
        return { ...this.dispatcher.getStats(), terminalStranded: this.terminalStranded };
    }
    // ── Internals ────────────────────────────────────────────────────────────
    byChannel(channel) {
        const out = [];
        for (const { recorder, channels } of this.registrations.values()) {
            if (channels.has(channel))
                out.push(recorder);
        }
        return out;
    }
    /** Normal property lookup — invocation parity with the inline tier. */
    anyImplements(recorders, method) {
        return recorders.some((r) => typeof r[method] === 'function');
    }
    /** Scope/emit events carry their own ids (`runtimeStageId` + `pipelineId`). */
    captureScopeEvent(channel, method, event) {
        const e = event;
        this.dispatcher.capture({
            channel,
            method,
            runtimeStageId: e?.runtimeStageId ?? '',
            runId: e?.pipelineId ?? '',
            payload: event,
        });
    }
    /** Flow events carry ids on `traversalContext` (absent on a few events). */
    captureFlowEvent(method, event) {
        const ctx = event
            ?.traversalContext;
        this.dispatcher.capture({
            channel: 'flow',
            method,
            runtimeStageId: ctx?.runtimeStageId ?? '',
            runId: ctx?.runId ?? '',
            payload: event,
        });
    }
    /**
     * Route a deferred listener failure into the existing recorder error
     * channel: every OTHER registered observer (deferred siblings first, in
     * registration order) receives a scope-shaped `onError` event — the same
     * contract the inline tier honors when a recorder throws mid-dispatch.
     * The error sink must never become an error source: sink throws are
     * swallowed (isolation is absolute).
     */
    routeListenerError(error, listenerId, envelope, phase) {
        const hashIdx = envelope.runtimeStageId.lastIndexOf('#');
        const errorEvent = {
            stageName: '',
            stageId: hashIdx >= 0 ? envelope.runtimeStageId.slice(0, hashIdx) : envelope.runtimeStageId,
            runtimeStageId: envelope.runtimeStageId,
            pipelineId: envelope.runId,
            timestamp: Date.now(),
            error: error instanceof Error ? error : new Error(String(error)),
            operation: operationFor(envelope.method),
            channel: 'scope',
        };
        for (const [id, { recorder, channels }] of this.registrations) {
            if (id === listenerId)
                continue;
            // Inline-tier parity (review CRITICAL-1): the synthesized event is
            // scope-typed, so it reaches ONLY recorders registered on the scope
            // lists — a flow-only recorder never receives scope-channel errors
            // inline and must not here either.
            if (!channels.has('scope'))
                continue;
            try {
                invokeRecorderHook(recorder, 'onError', errorEvent);
            }
            catch {
                // Swallow — same rule as DeferredDispatcher.safeOnError.
            }
        }
        if (isDevMode()) {
            // eslint-disable-next-line no-console
            console.warn(`[footprintjs] deferred observer '${listenerId}' failed (${phase}) handling ` +
                `${envelope.channel}.${envelope.method} (seq ${envelope.seq}): ${String(error)}`);
        }
    }
    /** Dispatcher-level options are first-attach-wins; differing later values dev-warn. */
    warnOnConfigConflict(recorderId, options) {
        if (!options)
            return;
        const conflicts = [];
        const requested = {
            capture: options.capture,
            maxQueue: options.maxQueue,
            overflow: options.overflow,
            sampleEvery: options.sampleEvery,
            flushBudgetMs: options.flushBudgetMs,
        };
        for (const key of Object.keys(requested)) {
            if (requested[key] !== undefined && requested[key] !== this.appliedConfig[key]) {
                conflicts.push(String(key));
            }
        }
        if (conflicts.length > 0) {
            this.devWarnDeduped(`[footprintjs] attach '${recorderId}': the executor's deferred-observer queue was already ` +
                `configured by the first deferred attach — ignoring differing option(s): ${conflicts.join(', ')}. ` +
                'One executor has ONE merged queue; configure it on the first deferred attach.');
        }
    }
    /** `isDevMode()`-gated, deduplicated warner — the bound warn seam. */
    devWarnDeduped(message) {
        if (!isDevMode())
            return;
        if (this.warnedMessages.has(message))
            return;
        this.warnedMessages.add(message);
        // eslint-disable-next-line no-console
        console.warn(message);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGVmZXJyZWRPYnNlcnZlclRpZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3J1bm5lci9EZWZlcnJlZE9ic2VydmVyVGllci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXdDRztBQUdILE9BQU8sRUFPTCxrQkFBa0IsR0FDbkIsTUFBTSw0QkFBNEIsQ0FBQztBQUNwQyxPQUFPLEVBQ0wsMkJBQTJCLEVBQzNCLDJCQUEyQixFQUMzQixzQkFBc0IsR0FDdkIsTUFBTSxpQ0FBaUMsQ0FBQztBQUN6QyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSwyQkFBMkIsQ0FBQztBQUMvRCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sNEJBQTRCLENBQUM7QUE2RHZELHlGQUF5RjtBQUN6RixNQUFNLENBQUMsTUFBTSxxQkFBcUIsR0FBRyx3QkFBd0IsQ0FBQztBQUM5RCxNQUFNLENBQUMsTUFBTSxvQkFBb0IsR0FBRyx1QkFBdUIsQ0FBQztBQUU1RCw2RUFBNkU7QUFDN0UsTUFBTSxtQkFBbUIsR0FBOEIsQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDLENBQUM7QUFDekUsK0NBQStDO0FBQy9DLE1BQU0sa0JBQWtCLEdBQThCLENBQUMsTUFBTSxDQUFDLENBQUM7QUFpQi9EO3lFQUN5RTtBQUN6RSxTQUFTLFlBQVksQ0FBQyxNQUFjO0lBQ2xDLElBQUksTUFBTSxLQUFLLFFBQVE7UUFBRSxPQUFPLE1BQU0sQ0FBQztJQUN2QyxJQUFJLE1BQU0sS0FBSyxVQUFVO1FBQUUsT0FBTyxRQUFRLENBQUM7SUFDM0MsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQztBQUVELE1BQU0sT0FBTyxvQkFBb0I7SUFDZCxVQUFVLENBQXFCO0lBQy9CLGFBQWEsR0FBRyxJQUFJLEdBQUcsRUFBZ0MsQ0FBQztJQUN4RCxhQUFhLENBQTBCO0lBQ3hELDJFQUEy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QUM7WUFDakYsSUFBSSxTQUFTLENBQUMsR0FBRyxDQUFDLEtBQUssU0FBUyxJQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsS0FBSyxJQUFJLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQy9FLFNBQVMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDOUIsQ0FBQztRQUNILENBQUM7UUFDRCxJQUFJLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDekIsSUFBSSxDQUFDLGNBQWMsQ0FDakIseUJBQXlCLFVBQVUsd0RBQXdEO2dCQUN6RiwyRUFBMkUsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSTtnQkFDbkcsK0VBQStFLENBQ2xGLENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQztJQUVELHNFQUFzRTtJQUM5RCxjQUFjLENBQUMsT0FBZTtRQUNwQyxJQUFJLENBQUMsU0FBUyxFQUFFO1lBQUUsT0FBTztRQUN6QixJQUFJLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQztZQUFFLE9BQU87UUFDN0MsSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDakMsc0NBQXNDO1FBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDeEIsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBydW5uZXIvRGVmZXJyZWRPYnNlcnZlclRpZXIudHMg4oCUIFJGQy0wMDEgQmxvY2tzIDbigJM5OiB0aGUgZW5naW5lIHdpcmluZyBvZlxuICogdGhlIGRlZmVycmVkLW9ic2VydmVyIHBpcGVsaW5lLlxuICpcbiAqIFBhdHRlcm46ICBUaGluIGFkYXB0ZXIgYmV0d2VlbiB0aGUgZXhlY3V0b3IncyB0aHJlZSBvYnNlcnZlciBjaGFubmVscyBhbmRcbiAqICAgICAgICAgICB0aGUgUFVSRSBgb2JzZXJ2ZXItcXVldWVgIG1vZHVsZS4gVGhlIHB1cmUgbW9kdWxlIHN0YXlzXG4gKiAgICAgICAgICAgZW5naW5lLWZyZWUgKGl0IGltcG9ydHMgbm90aGluZyBmcm9tIHRoZSBlbmdpbmUg4oCUIHRoZSBlbmdpbmVcbiAqICAgICAgICAgICBpbXBvcnRzIElUKTsgdGhpcyB0aWVyIG93bnMgZXZlcnkgZW5naW5lLWZsYXZvcmVkIGNvbmNlcm46XG4gKiAgICAgICAgICAgICAtIHRoZSBgaXNEZXZNb2RlKClgLWdhdGVkLCBkZWR1cGxpY2F0ZWQgYENhcHR1cmVIb29rcy53YXJuYFxuICogICAgICAgICAgICAgICBiaW5kaW5nICh0aGUgZGV2LXdhcm4gc2VhbSwgUkZDLTAwMSDCp1wiUmVzb2x1dGlvblwiKTtcbiAqICAgICAgICAgICAgIC0gcm91dGluZyBgRGVmZXJyZWREaXNwYXRjaGVyLm9uRXJyb3JgIGludG8gdGhlIGV4aXN0aW5nXG4gKiAgICAgICAgICAgICAgIHJlY29yZGVyIGVycm9yIGNoYW5uZWwgKGBvbkVycm9yYCBvbiBzaWJsaW5nIG9ic2VydmVycyk7XG4gKiAgICAgICAgICAgICAtIHRoZSBjYXB0dXJlIFRBUFMg4oCUIHN5bnRoZXRpYyByZWNvcmRlcnMgcGxhY2VkIG9uIHRoZVxuICogICAgICAgICAgICAgICBleGlzdGluZyBpbmxpbmUgZGlzcGF0Y2ggbGlzdHMgc28gdGhlIHRocmVlIGRpc3BhdGNoIHNpdGVzXG4gKiAgICAgICAgICAgICAgIChgU2NvcGVGYWNhZGUuX2ludm9rZUhvb2tgLCBgU2NvcGVGYWNhZGUuZW1pdEV2ZW50YCxcbiAqICAgICAgICAgICAgICAgYEZsb3dSZWNvcmRlckRpc3BhdGNoZXJgKSBuZWVkIE5PIHBlci1zaXRlIHRpZXIgbG9naWM6IGFcbiAqICAgICAgICAgICAgICAgdGFwJ3MgaG9vayBib2R5IElTIGBkaXNwYXRjaGVyLmNhcHR1cmUoLi4uKWAsIGFuZCBiZWNhdXNlXG4gKiAgICAgICAgICAgICAgIHRoZSB0YXAgc2l0cyBpbiB0aGUgc2FtZSBsb29wIGFzIGlubGluZSByZWNvcmRlcnMgaXQgc2Vlc1xuICogICAgICAgICAgICAgICBleGFjdGx5IHRoZSBwb3N0LXJlZGFjdGlvbiBldmVudCBvYmplY3QgaW5saW5lIG9ic2VydmVyc1xuICogICAgICAgICAgICAgICBzZWUg4oCUIGNhcHR1cmUgY2FuIG5ldmVyIG9ic2VydmUgYSBwcmUtcmVkYWN0aW9uIHZhbHVlO1xuICogICAgICAgICAgICAgLSB0aGUgdGVybWluYWwgZmx1c2ggKEJsb2NrIDgpIHdpdGggaG9uZXN0IHN0cmFuZGluZ1xuICogICAgICAgICAgICAgICBhY2NvdW50aW5nLCBhbmQgdGhlIEJsb2NrIDkgc3RhdHMgc3VyZmFjZS5cbiAqXG4gKiBSb2xlOiAgICAgT25lIGluc3RhbmNlIHBlciBgRmxvd0NoYXJ0RXhlY3V0b3JgLCBjcmVhdGVkIExBWklMWSBvbiB0aGVcbiAqICAgICAgICAgICBmaXJzdCBgZGVsaXZlcnk6ICdkZWZlcnJlZCdgIGF0dGFjaCAoemVybyBhbGxvY2F0aW9uIHdoZW4gbm9ib2R5XG4gKiAgICAgICAgICAgb3B0cyBpbiDigJQgbWlycm9ycyB0aGUgZW1pdCBmYXN0LXBhdGggcHJlY2VkZW50KS4gSG9sZHMgdGhlIE9ORVxuICogICAgICAgICAgIGBEZWZlcnJlZERpc3BhdGNoZXJgIChvbmUgbWVyZ2VkIHF1ZXVlLCB0b3RhbCBvcmRlciBhY3Jvc3NcbiAqICAgICAgICAgICBjaGFubmVscykgcGx1cyB0aGUgcmVnaXN0cnkgb2YgZGVmZXJyZWQgcmVjb3JkZXJzLlxuICpcbiAqIERlbGl2ZXJ5OiBhIGRlZmVycmVkIHJlY29yZGVyJ3MgaG9va3MgYXJlIGludm9rZWQgdGhyb3VnaCB0aGUgU0FNRVxuICogYGludm9rZVJlY29yZGVySG9va2AgaGVscGVyIHRoZSBpbmxpbmUgdGllciB1c2VzIChSRkMtMDAxIMKnOSBtaXRpZ2F0aW9uKSDigJRcbiAqIG9uZSBiZWF0IGJlaGluZCwgd2l0aCBgZW52ZWxvcGUucGF5bG9hZGAgbWF0ZXJpYWxpemVkIHBlciB0aGUgY2FwdHVyZVxuICogcG9saWN5IChgJ3N1bW1hcnknYCBkZWZhdWx0IOKAlCBib3VuZGVkLCByZWZlcmVuY2UtZnJlZTsgYCdjbG9uZSdgIOKAlCBmdWxsXG4gKiBzdHJ1Y3R1cmFsIGNvcHksIGV2ZW50LXNoYXBlIGNvbXBhdGlibGUgd2l0aCBpbmxpbmU7IGAncmVmJ2Ag4oCUIHRoZSBsaXZlXG4gKiBldmVudCBvYmplY3QsIGRldi13YXJuZWQpLlxuICpcbiAqIENoYW5uZWwgZmlsdGVyOiBhIHJlZ2lzdHJhdGlvbiByZW1lbWJlcnMgd2hpY2ggY2hhbm5lbHMgd291bGQgaGF2ZVxuICogcmVhY2hlZCB0aGUgcmVjb3JkZXIgaW5saW5lIChzY29wZS1saXN0IHJlY29yZGVycyBzZWUgYHNjb3BlYCArIGBlbWl0YFxuICogZW52ZWxvcGVzOyBmbG93LWxpc3QgcmVjb3JkZXJzIHNlZSBgZmxvd2AgZW52ZWxvcGVzKSBhbmQgc2tpcHMgdGhlIHJlc3Qg4oCUXG4gKiBzYW1lIHJlYWNoIGFzIHRoZSBpbmxpbmUgdGllciwgb25lIGJlYXQgYmVoaW5kLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQge1xuICB0eXBlIENhcHR1cmVDaGFubmVsLFxuICB0eXBlIENhcHR1cmVFbnZlbG9wZSxcbiAgdHlwZSBDYXB0dXJlUG9saWN5LFxuICB0eXBlIERpc3BhdGNoZXJTdGF0cyxcbiAgdHlwZSBEcmFpblJlc3VsdCxcbiAgdHlwZSBPdmVyZmxvd1BvbGljeSxcbiAgRGVmZXJyZWREaXNwYXRjaGVyLFxufSBmcm9tICcuLi9vYnNlcnZlci1xdWV1ZS9pbmRleC5qcyc7XG5pbXBvcnQge1xuICBFTUlUX1JFQ09SREVSX0VWRU5UX01FVEhPRFMsXG4gIEZMT1dfUkVDT1JERVJfRVZFTlRfTUVUSE9EUyxcbiAgUkVDT1JERVJfRVZFTlRfTUVUSE9EUyxcbn0gZnJvbSAnLi4vcmVjb3JkZXIvQ29tYmluZWRSZWNvcmRlci5qcyc7XG5pbXBvcnQgeyBpbnZva2VSZWNvcmRlckhvb2sgfSBmcm9tICcuLi9yZWNvcmRlci9pbnZva2VIb29rLmpzJztcbmltcG9ydCB7IGlzRGV2TW9kZSB9IGZyb20gJy4uL3Njb3BlL2RldGVjdENpcmN1bGFyLmpzJztcbmltcG9ydCB0eXBlIHsgU2NvcGVSZWNvcmRlciB9IGZyb20gJy4uL3Njb3BlL3R5cGVzLmpzJztcblxuLyoqIERlbGl2ZXJ5IHRpZXIgZm9yIGFuIGF0dGFjaGVkIG9ic2VydmVyIChSRkMtMDAxKS4gKi9cbmV4cG9ydCB0eXBlIE9ic2VydmVyRGVsaXZlcnkgPSAnaW5saW5lJyB8ICdkZWZlcnJlZCc7XG5cbi8qKlxuICogT3B0aW9ucyBiYWcgYWNjZXB0ZWQgYnkgZXZlcnkgYGF0dGFjaCpSZWNvcmRlcmAgY2FsbC5cbiAqXG4gKiBgZGVsaXZlcnk6ICdkZWZlcnJlZCdgIG9wdHMgdGhlIHJlY29yZGVyIGludG8gdGhlIGJvdW5kZWQgY2FwdHVyZSBxdWV1ZVxuICogKFwib25lIGJlYXQgYmVoaW5kXCIpOyBhYnNlbnQgLyBgJ2lubGluZSdgIGtlZXBzIHRoZSBoaXN0b3JpY2FsIHN5bmNocm9ub3VzXG4gKiBjYWxsIOKAlCBieXRlLWlkZW50aWNhbCB0byB0aGUgcHJlLVJGQyBwYXRoLlxuICpcbiAqIFRoZSByZW1haW5pbmcgZmllbGRzIGNvbmZpZ3VyZSB0aGUgZXhlY3V0b3IncyBPTkUgc2hhcmVkIGRpc3BhdGNoZXIgYW5kXG4gKiBhcmUgYXBwbGllZCB3aGVuIHRoZSBGSVJTVCBkZWZlcnJlZCBhdHRhY2ggY3JlYXRlcyBpdDsgbGF0ZXIgYXR0YWNoZXNcbiAqIHBhc3NpbmcgZGlmZmVyZW50IHZhbHVlcyBnZXQgYSBkZXYtbW9kZSB3YXJuaW5nIGFuZCBrZWVwIHRoZSBvcmlnaW5hbFxuICogY29uZmlndXJhdGlvbiAob25lIHF1ZXVlIHBlciBleGVjdXRvciDigJQgcGVyLXJlY29yZGVyIHF1ZXVlcyB3b3VsZCBicmVha1xuICogdGhlIHRvdGFsIGNyb3NzLWNoYW5uZWwgb3JkZXIpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF0dGFjaFJlY29yZGVyT3B0aW9ucyB7XG4gIC8qKiBgJ2RlZmVycmVkJ2AgPSBjYXB0dXJlIOKGkiBxdWV1ZSDihpIgbmV4dC1jaGVja3BvaW50IGRlbGl2ZXJ5LiBEZWZhdWx0IGAnaW5saW5lJ2AuICovXG4gIHJlYWRvbmx5IGRlbGl2ZXJ5PzogT2JzZXJ2ZXJEZWxpdmVyeTtcbiAgLyoqXG4gICAqIFBheWxvYWQgbWF0ZXJpYWxpemF0aW9uIGF0IGNhcHR1cmUgdGltZS4gRGVmYXVsdCBgJ2Nsb25lJ2Ag4oCUIHlvdXJcbiAgICogcmVjb3JkZXIncyBob29rcyByZWNlaXZlIHRoZSBTQU1FIGV2ZW50IHNoYXBlIGFzIGlubGluZSBkZWxpdmVyeVxuICAgKiAoYHN0cnVjdHVyZWRDbG9uZWBkOyBgZS5rZXlgL2BlLnZhbHVlYC9gZS5ydW50aW1lU3RhZ2VJZGAgYWxsIHdvcmtcbiAgICogdW5jaGFuZ2VkKSwgc28gYHsgZGVsaXZlcnk6ICdkZWZlcnJlZCcgfWAgaXMgYSBkcm9wLWluIHBvcnQuXG4gICAqIGAnc3VtbWFyeSdgIOKAlCBhIGJvdW5kZWQgdHlwZS9zaXplL3ByZXZpZXcgZGlnZXN0IChgUGF5bG9hZFN1bW1hcnlgKVxuICAgKiBpbnN0ZWFkIG9mIHRoZSBldmVudCBzaGFwZTogY2hlYXBlciBjYXB0dXJlIGZvciB0ZWxlbWV0cnktb25seVxuICAgKiBjb25zdW1lcnMgdGhhdCBkb24ndCByZWFkIGRvbWFpbiBmaWVsZHMuIGAncmVmJ2Ag4oCUIHBhc3MtdGhyb3VnaCBieVxuICAgKiByZWZlcmVuY2U7IHRoZSBjYWxsZXIgYXNzZXJ0cyBpbW11dGFiaWxpdHkgKGRldi1tb2RlIHdhcm5zKS5cbiAgICovXG4gIHJlYWRvbmx5IGNhcHR1cmU/OiBDYXB0dXJlUG9saWN5O1xuICAvKiogUXVldWUgYm91bmQg4oCUIGRlZmF1bHQgMTAgMDAwLiAqL1xuICByZWFkb25seSBtYXhRdWV1ZT86IG51bWJlcjtcbiAgLyoqIE92ZXJmbG93IHBvbGljeSBhdCBgbWF4UXVldWVgIOKAlCBkZWZhdWx0IGAnZHJvcC1vbGRlc3QnYC4gKi9cbiAgcmVhZG9ubHkgb3ZlcmZsb3c/OiBPdmVyZmxvd1BvbGljeTtcbiAgLyoqIGAnc2FtcGxlJ2Agb3ZlcmZsb3cgb25seSDigJQgYWRtaXQgMSBpbiB0aGlzIG1hbnkgc2F0dXJhdGVkIGFycml2YWxzLiAqL1xuICByZWFkb25seSBzYW1wbGVFdmVyeT86IG51bWJlcjtcbiAgLyoqIFBlci1jaGVja3BvaW50IGZsdXNoIGJ1ZGdldCwgbXMgKEExKSDigJQgZGVmYXVsdCAyOyBgSW5maW5pdHlgID0gZnVsbCBkcmFpbi4gKi9cbiAgcmVhZG9ubHkgZmx1c2hCdWRnZXRNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBUaGUgQmxvY2sgOSBvYnNlcnZhYmlsaXR5IHN1cmZhY2Ug4oCUIGBzbmFwc2hvdC5vYnNlcnZlclN0YXRzYC4gVGhlIEE0XG4gKiBkaXNwYXRjaGVyIHN0YXRzIHBsdXMgdGhlIHRlcm1pbmFsLWZsdXNoIHN0cmFuZGluZyBjb3VudCBmcm9tIEJsb2NrIDguXG4gKiBQcmVzZW50IG9uIGBSdW50aW1lU25hcHNob3RgIG9ubHkgd2hlbiBhIGRlZmVycmVkIG9ic2VydmVyIHdhcyBhdHRhY2hlZC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBPYnNlcnZlclN0YXRzIGV4dGVuZHMgRGlzcGF0Y2hlclN0YXRzIHtcbiAgLyoqXG4gICAqIEVudmVsb3BlcyBzdGlsbCBxdWV1ZWQgd2hlbiBhIHRlcm1pbmFsIGZsdXNoIGhpdCBpdHMgcnVuYXdheS1jYXNjYWRlXG4gICAqIHJvdW5kIGNhcCAoQmxvY2sgOCkuIGAwYCBpbiBhbnkgc2FuZSBydW4g4oCUIGEgbm9uLXplcm8gdmFsdWUgbWVhbnMgYVxuICAgKiBsaXN0ZW5lciBrZXB0IGVucXVldWVpbmcgd29yayBhdCBlbmQtb2YtcnVuIGFuZCBkZWxpdmVyeSB3YXMgY3V0IG9mZlxuICAgKiAoYWxzbyBkZXYtd2FybmVkIGF0IHRoZSBtb21lbnQgaXQgaGFwcGVuZWQpLiBOZXZlciBzaWxlbnQuXG4gICAqL1xuICByZWFkb25seSB0ZXJtaW5hbFN0cmFuZGVkOiBudW1iZXI7XG59XG5cbi8qKiBSZXN1bHQgc2hhcGUgb2YgYGV4ZWN1dG9yLmRyYWluT2JzZXJ2ZXJzKClgIOKAlCBzZWUgYERyYWluUmVzdWx0YC4gKi9cbmV4cG9ydCB0eXBlIE9ic2VydmVyRHJhaW5SZXN1bHQgPSBEcmFpblJlc3VsdDtcblxuLyoqIFdlbGwta25vd24gaWRzIG9mIHRoZSBzeW50aGV0aWMgY2FwdHVyZSB0YXBzIChpbnRlcm5hbCwgZG9jdW1lbnRlZCBmb3IgZGVidWdnaW5nKS4gKi9cbmV4cG9ydCBjb25zdCBERUZFUlJFRF9TQ09QRV9UQVBfSUQgPSAnX19kZWZlcnJlZC1zY29wZS10YXBfXyc7XG5leHBvcnQgY29uc3QgREVGRVJSRURfRkxPV19UQVBfSUQgPSAnX19kZWZlcnJlZC1mbG93LXRhcF9fJztcblxuLyoqIENoYW5uZWwgcmVhY2ggb2YgdGhlIHNjb3BlLXJlY29yZGVyIGxpc3QgKHNjb3BlIGV2ZW50cyArIGVtaXQgZXZlbnRzKS4gKi9cbmNvbnN0IFNDT1BFX0xJU1RfQ0hBTk5FTFM6IHJlYWRvbmx5IENhcHR1cmVDaGFubmVsW10gPSBbJ3Njb3BlJywgJ2VtaXQnXTtcbi8qKiBDaGFubmVsIHJlYWNoIG9mIHRoZSBmbG93LXJlY29yZGVyIGxpc3QuICovXG5jb25zdCBGTE9XX0xJU1RfQ0hBTk5FTFM6IHJlYWRvbmx5IENhcHR1cmVDaGFubmVsW10gPSBbJ2Zsb3cnXTtcblxuLyoqIERpc3BhdGNoZXItbGV2ZWwgb3B0aW9ucyBzbmFwc2hvdCwga2VwdCBmb3IgY29uZmxpY3QgZGV0ZWN0aW9uLiAqL1xuaW50ZXJmYWNlIEFwcGxpZWREaXNwYXRjaGVyQ29uZmlnIHtcbiAgcmVhZG9ubHkgY2FwdHVyZT86IENhcHR1cmVQb2xpY3k7XG4gIHJlYWRvbmx5IG1heFF1ZXVlPzogbnVtYmVyO1xuICByZWFkb25seSBvdmVyZmxvdz86IE92ZXJmbG93UG9saWN5O1xuICByZWFkb25seSBzYW1wbGVFdmVyeT86IG51bWJlcjtcbiAgcmVhZG9ubHkgZmx1c2hCdWRnZXRNcz86IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIERlZmVycmVkUmVnaXN0cmF0aW9uIHtcbiAgcmVhZG9ubHkgcmVjb3JkZXI6IFNjb3BlUmVjb3JkZXIgfCBGbG93UmVjb3JkZXI7XG4gIC8qKiBXaGljaCBlbnZlbG9wZSBjaGFubmVscyByZWFjaCB0aGlzIHJlY29yZGVyIChpbmxpbmUtdGllciBwYXJpdHkpLiAqL1xuICByZWFkb25seSBjaGFubmVsczogU2V0PENhcHR1cmVDaGFubmVsPjtcbn1cblxuLyoqIE1hcCBhbiBlbnZlbG9wZSBtZXRob2Qgb250byB0aGUgc2NvcGUgZXJyb3ItZXZlbnQgYG9wZXJhdGlvbmAgdm9jYWJ1bGFyeVxuICogIChzYW1lIG1hcHBpbmcgYFNjb3BlRmFjYWRlLl9pbnZva2VIb29rYCB1c2VzIGZvciBpbmxpbmUgZmFpbHVyZXMpLiAqL1xuZnVuY3Rpb24gb3BlcmF0aW9uRm9yKG1ldGhvZDogc3RyaW5nKTogJ3JlYWQnIHwgJ3dyaXRlJyB8ICdjb21taXQnIHtcbiAgaWYgKG1ldGhvZCA9PT0gJ29uUmVhZCcpIHJldHVybiAncmVhZCc7XG4gIGlmIChtZXRob2QgPT09ICdvbkNvbW1pdCcpIHJldHVybiAnY29tbWl0JztcbiAgcmV0dXJuICd3cml0ZSc7XG59XG5cbmV4cG9ydCBjbGFzcyBEZWZlcnJlZE9ic2VydmVyVGllciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgZGlzcGF0Y2hlcjogRGVmZXJyZWREaXNwYXRjaGVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlZ2lzdHJhdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgRGVmZXJyZWRSZWdpc3RyYXRpb24+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgYXBwbGllZENvbmZpZzogQXBwbGllZERpc3BhdGNoZXJDb25maWc7XG4gIC8qKiBEZWR1cCBtZW1vcnkgZm9yIHRoZSBkZXYtd2FybiBzZWFtIChvbmUgd2FybmluZyBwZXIgdW5pcXVlIG1lc3NhZ2UpLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHdhcm5lZE1lc3NhZ2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHByaXZhdGUgdGVybWluYWxTdHJhbmRlZCA9IDA7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9ucz86IEF0dGFjaFJlY29yZGVyT3B0aW9ucykge1xuICAgIHRoaXMuYXBwbGllZENvbmZpZyA9IHtcbiAgICAgIC8vIEF0dGFjaC1zdXJmYWNlIGRlZmF1bHQgaXMgJ2Nsb25lJyAocmV2aWV3IENSSVRJQ0FMLTIpOiBhIHJlY29yZGVyXG4gICAgICAvLyBwb3J0ZWQgd2l0aCBgeyBkZWxpdmVyeTogJ2RlZmVycmVkJyB9YCBrZWVwcyByZWNlaXZpbmcgdGhlIFNBTUVcbiAgICAgIC8vIGV2ZW50IHNoYXBlIGFzIGlubGluZSAoZS5rZXkvZS52YWx1ZS9lLnJ1bnRpbWVTdGFnZUlkIGFsbCBpbnRhY3QpLlxuICAgICAgLy8gVGhlIG1vZHVsZS1pbnRlcm5hbCBlbnZlbG9wZSBkZWZhdWx0IHN0YXlzICdzdW1tYXJ5JyBmb3IgcmF3LVxuICAgICAgLy8gZW52ZWxvcGUgY29uc3VtZXJzOyAnc3VtbWFyeScgaGVyZSBpcyBhbiBleHBsaWNpdCB0ZWxlbWV0cnkgY2hvaWNlLlxuICAgICAgY2FwdHVyZTogb3B0aW9ucz8uY2FwdHVyZSA/PyAnY2xvbmUnLFxuICAgICAgbWF4UXVldWU6IG9wdGlvbnM/Lm1heFF1ZXVlLFxuICAgICAgb3ZlcmZsb3c6IG9wdGlvbnM/Lm92ZXJmbG93LFxuICAgICAgc2FtcGxlRXZlcnk6IG9wdGlvbnM/LnNhbXBsZUV2ZXJ5LFxuICAgICAgZmx1c2hCdWRnZXRNczogb3B0aW9ucz8uZmx1c2hCdWRnZXRNcyxcbiAgICB9O1xuICAgIHRoaXMuZGlzcGF0Y2hlciA9IG5ldyBEZWZlcnJlZERpc3BhdGNoZXIoe1xuICAgICAgbWF4UXVldWU6IG9wdGlvbnM/Lm1heFF1ZXVlLFxuICAgICAgb3ZlcmZsb3c6IG9wdGlvbnM/Lm92ZXJmbG93LFxuICAgICAgc2FtcGxlRXZlcnk6IG9wdGlvbnM/LnNhbXBsZUV2ZXJ5LFxuICAgICAgY2FwdHVyZVBvbGljeTogb3B0aW9ucz8uY2FwdHVyZSA/PyAnY2xvbmUnLFxuICAgICAgZmx1c2hCdWRnZXRNczogb3B0aW9ucz8uZmx1c2hCdWRnZXRNcyxcbiAgICAgIC8vIFRoZSBkZXYtd2FybiBzZWFtIChSRkMtMDAxIMKnXCJSZXNvbHV0aW9uOiB0aGUgZGV2LXdhcm4gc2VhbVwiKTogdGhlXG4gICAgICAvLyBwdXJlIG1vZHVsZSBpbnZva2VzIGB3YXJuYCBvbiBldmVyeSAncmVmJyBjYXB0dXJlIGFuZCBldmVyeSAnY2xvbmUnXG4gICAgICAvLyBkZWdyYWRhdGlvbjsgdGhlIHRpZXIgYmluZHMgaXQgdG8gdGhlIGNlbnRyYWwgaXNEZXZNb2RlKCkgZmxhZyBhbmRcbiAgICAgIC8vIGRlZHVwZXMgYnkgbWVzc2FnZSBzbyBhIGhvdCBsb29wIGNhbm5vdCBzcGFtIHRoZSBjb25zb2xlLlxuICAgICAgaG9va3M6IHsgd2FybjogKG1lc3NhZ2UpID0+IHRoaXMuZGV2V2FybkRlZHVwZWQobWVzc2FnZSkgfSxcbiAgICAgIC8vIExpc3RlbmVyIGZhaWx1cmVzIChzeW5jIHRocm93cyBBTkQgYXN5bmMgcmVqZWN0aW9ucykgcm91dGUgaW50byB0aGVcbiAgICAgIC8vIGV4aXN0aW5nIHJlY29yZGVyIGVycm9yIGNoYW5uZWwg4oCUIHNlZSByb3V0ZUxpc3RlbmVyRXJyb3IuXG4gICAgICBvbkVycm9yOiAoZXJyb3IsIGN0eCkgPT4gdGhpcy5yb3V0ZUxpc3RlbmVyRXJyb3IoZXJyb3IsIGN0eC5saXN0ZW5lcklkLCBjdHguZW52ZWxvcGUsIGN0eC5waGFzZSksXG4gICAgfSk7XG4gIH1cblxuICAvLyDilIDilIAgUmVnaXN0cnkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFJlZ2lzdGVyIGEgcmVjb3JkZXIgZm9yIGRlZmVycmVkIGRlbGl2ZXJ5IG9uIHRoZSBzY29wZS1saXN0IGNoYW5uZWxzXG4gICAqIChgc2NvcGVgICsgYGVtaXRgKSBhbmQvb3IgdGhlIGZsb3cgY2hhbm5lbC4gSWRlbXBvdGVudCBieSBpZCDigJQgc2FtZSBpZFxuICAgKiByZXBsYWNlcyB0aGUgcmVjb3JkZXIgb2JqZWN0OyBjaGFubmVsIGxpc3RzIE1FUkdFIGFjcm9zcyBjYWxscyAoc2FtZSBhc1xuICAgKiB0aGUgaW5saW5lIHRpZXIsIHdoZXJlIGBhdHRhY2hTY29wZVJlY29yZGVyKHgpYCArIGBhdHRhY2hGbG93UmVjb3JkZXIoeClgXG4gICAqIGxhbmRzIGB4YCBvbiBib3RoIGxpc3RzKS4gTGF0ZXIgYXR0YWNoZXMgcGFzc2luZyBkaXNwYXRjaGVyLWxldmVsXG4gICAqIG9wdGlvbnMgdGhhdCBkaWZmZXIgZnJvbSB0aGUgZmlyc3QgYXR0YWNoJ3MgY29uZmlndXJhdGlvbiBrZWVwIHRoZVxuICAgKiBvcmlnaW5hbCBjb25maWcgYW5kIGRldi13YXJuLlxuICAgKi9cbiAgcmVnaXN0ZXIoXG4gICAgcmVjb3JkZXI6IFNjb3BlUmVjb3JkZXIgfCBGbG93UmVjb3JkZXIsXG4gICAgbGlzdHM6IHsgc2NvcGU/OiBib29sZWFuOyBmbG93PzogYm9vbGVhbiB9LFxuICAgIG9wdGlvbnM/OiBBdHRhY2hSZWNvcmRlck9wdGlvbnMsXG4gICk6IHZvaWQge1xuICAgIHRoaXMud2Fybk9uQ29uZmlnQ29uZmxpY3QocmVjb3JkZXIuaWQsIG9wdGlvbnMpO1xuICAgIGNvbnN0IGNoYW5uZWxzID0gdGhpcy5yZWdpc3RyYXRpb25zLmdldChyZWNvcmRlci5pZCk/LmNoYW5uZWxzID8/IG5ldyBTZXQ8Q2FwdHVyZUNoYW5uZWw+KCk7XG4gICAgaWYgKGxpc3RzLnNjb3BlKSBmb3IgKGNvbnN0IGMgb2YgU0NPUEVfTElTVF9DSEFOTkVMUykgY2hhbm5lbHMuYWRkKGMpO1xuICAgIGlmIChsaXN0cy5mbG93KSBmb3IgKGNvbnN0IGMgb2YgRkxPV19MSVNUX0NIQU5ORUxTKSBjaGFubmVscy5hZGQoYyk7XG4gICAgdGhpcy5yZWdpc3RyYXRpb25zLnNldChyZWNvcmRlci5pZCwgeyByZWNvcmRlciwgY2hhbm5lbHMgfSk7XG4gICAgdGhpcy5kaXNwYXRjaGVyLmFkZExpc3RlbmVyKHJlY29yZGVyLmlkLCAoZW52ZWxvcGUpID0+IHtcbiAgICAgIGNvbnN0IHJlZ2lzdHJhdGlvbiA9IHRoaXMucmVnaXN0cmF0aW9ucy5nZXQocmVjb3JkZXIuaWQpO1xuICAgICAgaWYgKCFyZWdpc3RyYXRpb24gfHwgIXJlZ2lzdHJhdGlvbi5jaGFubmVscy5oYXMoZW52ZWxvcGUuY2hhbm5lbCkpIHJldHVybjtcbiAgICAgIC8vIFNBTUUgaW52b2tlIGhlbHBlciBhcyB0aGUgaW5saW5lIHRpZXIgKFJGQy0wMDEgwqc5IG1pdGlnYXRpb24pIOKAlCBhXG4gICAgICAvLyByZXR1cm5lZCBQcm9taXNlIGxhbmRzIGluIHRoZSBkaXNwYXRjaGVyJ3MgaW5mbGlnaHQgc2V0LlxuICAgICAgcmV0dXJuIGludm9rZVJlY29yZGVySG9vayhyZWNvcmRlciwgZW52ZWxvcGUubWV0aG9kLCBlbnZlbG9wZS5wYXlsb2FkKSBhcyB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgdGhlIGdpdmVuIGNoYW5uZWwgbGlzdHMgZnJvbSBhIHJlZ2lzdHJhdGlvbiAobWlycm9ycyB0aGUgaW5saW5lXG4gICAqIHRpZXIsIHdoZXJlIGBkZXRhY2hTY29wZVJlY29yZGVyYCAvIGBkZXRhY2hGbG93UmVjb3JkZXJgIGVhY2ggY2xlYXIgb25lXG4gICAqIGxpc3QpLiBXaGVuIG5vIGNoYW5uZWxzIHJlbWFpbiwgdGhlIGxpc3RlbmVyIGlzIGZ1bGx5IHJlbW92ZWQuXG4gICAqL1xuICByZW1vdmVGcm9tTGlzdHMoaWQ6IHN0cmluZywgbGlzdHM6IHsgc2NvcGU/OiBib29sZWFuOyBmbG93PzogYm9vbGVhbiB9KTogdm9pZCB7XG4gICAgY29uc3QgcmVnaXN0cmF0aW9uID0gdGhpcy5yZWdpc3RyYXRpb25zLmdldChpZCk7XG4gICAgaWYgKCFyZWdpc3RyYXRpb24pIHJldHVybjtcbiAgICBpZiAobGlzdHMuc2NvcGUpIGZvciAoY29uc3QgYyBvZiBTQ09QRV9MSVNUX0NIQU5ORUxTKSByZWdpc3RyYXRpb24uY2hhbm5lbHMuZGVsZXRlKGMpO1xuICAgIGlmIChsaXN0cy5mbG93KSBmb3IgKGNvbnN0IGMgb2YgRkxPV19MSVNUX0NIQU5ORUxTKSByZWdpc3RyYXRpb24uY2hhbm5lbHMuZGVsZXRlKGMpO1xuICAgIGlmIChyZWdpc3RyYXRpb24uY2hhbm5lbHMuc2l6ZSA9PT0gMCkge1xuICAgICAgdGhpcy5yZWdpc3RyYXRpb25zLmRlbGV0ZShpZCk7XG4gICAgICB0aGlzLmRpc3BhdGNoZXIucmVtb3ZlTGlzdGVuZXIoaWQpO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBUcnVlIHdoZW4gYGlkYCBpcyByZWdpc3RlcmVkIGZvciBkZWZlcnJlZCBkZWxpdmVyeSAoYW55IGNoYW5uZWwpLiAqL1xuICBoYXMoaWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnJlZ2lzdHJhdGlvbnMuaGFzKGlkKTtcbiAgfVxuXG4gIC8qKiBEZWZlcnJlZCByZWNvcmRlcnMgd2hvc2UgcmVhY2ggaW5jbHVkZXMgdGhlIHNjb3BlIGxpc3QgKHNjb3BlK2VtaXQpLiAqL1xuICBzY29wZUxpc3RSZWNvcmRlcnMoKTogU2NvcGVSZWNvcmRlcltdIHtcbiAgICByZXR1cm4gdGhpcy5ieUNoYW5uZWwoJ3Njb3BlJykgYXMgU2NvcGVSZWNvcmRlcltdO1xuICB9XG5cbiAgLyoqIERlZmVycmVkIHJlY29yZGVycyB3aG9zZSByZWFjaCBpbmNsdWRlcyB0aGUgZmxvdyBjaGFubmVsLiAqL1xuICBmbG93TGlzdFJlY29yZGVycygpOiBGbG93UmVjb3JkZXJbXSB7XG4gICAgcmV0dXJuIHRoaXMuYnlDaGFubmVsKCdmbG93JykgYXMgRmxvd1JlY29yZGVyW107XG4gIH1cblxuICAvKiogUmVzZXQgZGVmZXJyZWQgcmVjb3JkZXJzIGJlZm9yZSBhIGZyZXNoIHJ1biAoc2FtZSBjb250cmFjdCBhcyBpbmxpbmUpLiAqL1xuICBjbGVhclJlY29yZGVycygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHsgcmVjb3JkZXIgfSBvZiB0aGlzLnJlZ2lzdHJhdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIChyZWNvcmRlciBhcyB7IGNsZWFyPzogKCkgPT4gdm9pZCB9KS5jbGVhcj8uKCk7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIENhcHR1cmUgdGFwcyAoQmxvY2sgNykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEJ1aWxkIHRoZSBzeW50aGV0aWMgc2NvcGUtY2hhbm5lbCB0YXAg4oCUIGEgYFNjb3BlUmVjb3JkZXJgIHBsYWNlZCBvbiB0aGVcbiAgICogbm9ybWFsIHNjb3BlLXJlY29yZGVyIGxpc3Qgd2hvc2UgaG9va3MgY2FwdHVyZSBpbnRvIHRoZSBxdWV1ZS4gQnVpbHRcbiAgICogZnJlc2ggcGVyIHRyYXZlcnNlciBzbyBpdCByZWZsZWN0cyB0aGUgY3VycmVudCByZWdpc3RyYXRpb25zLiBPbmx5XG4gICAqIG1ldGhvZHMgc29tZSBkZWZlcnJlZCByZWNvcmRlciBhY3R1YWxseSBpbXBsZW1lbnRzIGFyZSBwcmVzZW50IChub1xuICAgKiB3YXN0ZWQgY2FwdHVyZXMpLiBSZXR1cm5zIGB1bmRlZmluZWRgIHdoZW4gbm90aGluZyBpcyByZWdpc3RlcmVkIGZvclxuICAgKiB0aGUgc2NvcGUgbGlzdC5cbiAgICpcbiAgICogUmVkYWN0aW9uIG9yZGVyaW5nOiB0aGUgdGFwIGlzIGludm9rZWQgZnJvbSB0aGUgU0FNRSBsb29wcyBhcyBpbmxpbmVcbiAgICogcmVjb3JkZXJzIChgX2ludm9rZUhvb2tgIC8gYGVtaXRFdmVudGApLCB3aGljaCByZWNlaXZlIGV2ZW50cyBBRlRFUiB0aGVcbiAgICogcmVkYWN0aW9uIGRlY2lzaW9uIOKAlCBzbyBhIGNhcHR1cmVkIHBheWxvYWQgY2FuIG5ldmVyIGNvbnRhaW4gYVxuICAgKiBwcmUtcmVkYWN0aW9uIHZhbHVlIHRoZSBpbmxpbmUgdGllciB3b3VsZCBub3QgaGF2ZSBzZWVuLlxuICAgKi9cbiAgYnVpbGRTY29wZVRhcCgpOiBTY29wZVJlY29yZGVyIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCByZWNvcmRlcnMgPSB0aGlzLnNjb3BlTGlzdFJlY29yZGVycygpO1xuICAgIGlmIChyZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGNvbnN0IHRhcDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IGlkOiBERUZFUlJFRF9TQ09QRV9UQVBfSUQgfTtcbiAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiBSRUNPUkRFUl9FVkVOVF9NRVRIT0RTKSB7XG4gICAgICBpZiAoIXRoaXMuYW55SW1wbGVtZW50cyhyZWNvcmRlcnMsIG1ldGhvZCkpIGNvbnRpbnVlO1xuICAgICAgdGFwW21ldGhvZF0gPSAoZXZlbnQ6IHVua25vd24pID0+IHRoaXMuY2FwdHVyZVNjb3BlRXZlbnQoJ3Njb3BlJywgbWV0aG9kLCBldmVudCk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIEVNSVRfUkVDT1JERVJfRVZFTlRfTUVUSE9EUykge1xuICAgICAgaWYgKCF0aGlzLmFueUltcGxlbWVudHMocmVjb3JkZXJzLCBtZXRob2QpKSBjb250aW51ZTtcbiAgICAgIHRhcFttZXRob2RdID0gKGV2ZW50OiB1bmtub3duKSA9PiB0aGlzLmNhcHR1cmVTY29wZUV2ZW50KCdlbWl0JywgbWV0aG9kLCBldmVudCk7XG4gICAgfVxuICAgIHJldHVybiB0YXAgYXMgdW5rbm93biBhcyBTY29wZVJlY29yZGVyO1xuICB9XG5cbiAgLyoqXG4gICAqIEJ1aWxkIHRoZSBzeW50aGV0aWMgZmxvdy1jaGFubmVsIHRhcCDigJQgYSBgRmxvd1JlY29yZGVyYCBhcHBlbmRlZCB0byB0aGVcbiAgICogZmxvdy1yZWNvcmRlcnMgbGlzdCBoYW5kZWQgdG8gdGhlIHRyYXZlcnNlci4gU2FtZSBjb250cmFjdCBhc1xuICAgKiB7QGxpbmsgYnVpbGRTY29wZVRhcH0uXG4gICAqL1xuICBidWlsZEZsb3dUYXAoKTogRmxvd1JlY29yZGVyIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCByZWNvcmRlcnMgPSB0aGlzLmZsb3dMaXN0UmVjb3JkZXJzKCk7XG4gICAgaWYgKHJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgdGFwOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgaWQ6IERFRkVSUkVEX0ZMT1dfVEFQX0lEIH07XG4gICAgZm9yIChjb25zdCBtZXRob2Qgb2YgRkxPV19SRUNPUkRFUl9FVkVOVF9NRVRIT0RTKSB7XG4gICAgICBpZiAoIXRoaXMuYW55SW1wbGVtZW50cyhyZWNvcmRlcnMsIG1ldGhvZCkpIGNvbnRpbnVlO1xuICAgICAgdGFwW21ldGhvZF0gPSAoZXZlbnQ6IHVua25vd24pID0+IHRoaXMuY2FwdHVyZUZsb3dFdmVudChtZXRob2QsIGV2ZW50KTtcbiAgICB9XG4gICAgcmV0dXJuIHRhcCBhcyB1bmtub3duIGFzIEZsb3dSZWNvcmRlcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBEaXJlY3QgY2FwdHVyZSBmb3IgZXhlY3V0b3Itc3ludGhlc2l6ZWQgZXZlbnRzIHRoYXQgYnlwYXNzIHRoZSBkaXNwYXRjaFxuICAgKiBzaXRlcyAoZS5nLiB0aGUgc3ludGhldGljIGBvblJlc3VtZWAgdGhlIGV4ZWN1dG9yIGZpcmVzIG9uIHJlc3VtZSkuXG4gICAqL1xuICBjYXB0dXJlKGNoYW5uZWw6IENhcHR1cmVDaGFubmVsLCBtZXRob2Q6IHN0cmluZywgcnVudGltZVN0YWdlSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywgcGF5bG9hZDogdW5rbm93bik6IHZvaWQge1xuICAgIHRoaXMuZGlzcGF0Y2hlci5jYXB0dXJlKHsgY2hhbm5lbCwgbWV0aG9kLCBydW50aW1lU3RhZ2VJZCwgcnVuSWQsIHBheWxvYWQgfSk7XG4gIH1cblxuICAvLyDilIDilIAgVGVybWluYWwgZmx1c2ggKyBkcmFpbiAoQmxvY2sgOCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFN5bmNocm9ub3VzbHkgZGVsaXZlciBldmVyeXRoaW5nIHN0aWxsIHF1ZXVlZCDigJQgY2FsbGVkIGJ5IHRoZSBleGVjdXRvclxuICAgKiBhdCB0aGUgT1VURVJNT1NUIHJ1biBib3VuZGFyeSAocmVzb2x2ZSwgcmVqZWN0LCBwYXVzZSksIEJFRk9SRSBgcnVuKClgXG4gICAqIHJldHVybnMgLyByZXRocm93cyAvIHRoZSBjaGVja3BvaW50IGJlY29tZXMgYXZhaWxhYmxlLiBJbnNwZWN0c1xuICAgKiBgZmx1c2hTeW5jYCdzIGByZW1haW5pbmdgIChyZXZpZXdlciBOMSk6IGBmbHVzaFN5bmNgIGFscmVhZHkgbG9vcHNcbiAgICogc25hcHNob3Qgcm91bmRzIHVwIHRvIGl0cyBydW5hd2F5LWNhc2NhZGUgY2FwLCBzbyBhIG5vbi16ZXJvIHJlbWFpbmRlclxuICAgKiBtZWFucyBhIHBhdGhvbG9naWNhbCBzZWxmLWVucXVldWVpbmcgbGlzdGVuZXIg4oCUIGNvdW50ZWQgaW5cbiAgICogYG9ic2VydmVyU3RhdHMudGVybWluYWxTdHJhbmRlZGAgYW5kIGRldi13YXJuZWQsIG5ldmVyIHNpbGVudC5cbiAgICovXG4gIHRlcm1pbmFsRmx1c2goKTogdm9pZCB7XG4gICAgY29uc3QgeyByZW1haW5pbmcgfSA9IHRoaXMuZGlzcGF0Y2hlci5mbHVzaE5vdygpO1xuICAgIGlmIChyZW1haW5pbmcgPiAwKSB7XG4gICAgICB0aGlzLnRlcm1pbmFsU3RyYW5kZWQgKz0gcmVtYWluaW5nO1xuICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBgW2Zvb3RwcmludGpzXSBkZWZlcnJlZCBvYnNlcnZlcnM6IHRlcm1pbmFsIGZsdXNoIGhpdCB0aGUgcnVuYXdheS1jYXNjYWRlIGNhcCB3aXRoICR7cmVtYWluaW5nfSBgICtcbiAgICAgICAgICAgICdldmVudChzKSBzdGlsbCBxdWV1ZWQg4oCUIGEgbGlzdGVuZXIga2VwdCBlbnF1ZXVlaW5nIGR1cmluZyB0aGUgZmx1c2guIFRoZSBzdHJhbmRlZCBjb3VudCBpcyAnICtcbiAgICAgICAgICAgICdzdXJmYWNlZCBvbiBzbmFwc2hvdC5vYnNlcnZlclN0YXRzLnRlcm1pbmFsU3RyYW5kZWQuJyxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRmx1c2ggdGhlIGJhY2tsb2csIHRoZW4gc2V0dGxlIGFzeW5jIGxpc3RlbmVyIGNvbnRpbnVhdGlvbnMgdW5kZXIgYVxuICAgKiBkZWFkbGluZSDigJQgdGhlIHNlcnZlcmxlc3MgLyBncmFjZWZ1bC1zaHV0ZG93biBwYXR0ZXJuIChSRkMtMDAxIMKnMTEpLlxuICAgKi9cbiAgZHJhaW4ob3B0cz86IHsgdGltZW91dE1zPzogbnVtYmVyIH0pOiBQcm9taXNlPE9ic2VydmVyRHJhaW5SZXN1bHQ+IHtcbiAgICByZXR1cm4gdGhpcy5kaXNwYXRjaGVyLmRyYWluKG9wdHMpO1xuICB9XG5cbiAgLy8g4pSA4pSAIFN0YXRzIChCbG9jayA5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogVGhlIGBzbmFwc2hvdC5vYnNlcnZlclN0YXRzYCBwYXlsb2FkIOKAlCBBNCBzdGF0cyArIEJsb2NrIDggc3RyYW5kaW5nLiAqL1xuICBnZXRTdGF0cygpOiBPYnNlcnZlclN0YXRzIHtcbiAgICByZXR1cm4geyAuLi50aGlzLmRpc3BhdGNoZXIuZ2V0U3RhdHMoKSwgdGVybWluYWxTdHJhbmRlZDogdGhpcy50ZXJtaW5hbFN0cmFuZGVkIH07XG4gIH1cblxuICAvLyDilIDilIAgSW50ZXJuYWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHByaXZhdGUgYnlDaGFubmVsKGNoYW5uZWw6IENhcHR1cmVDaGFubmVsKTogQXJyYXk8U2NvcGVSZWNvcmRlciB8IEZsb3dSZWNvcmRlcj4ge1xuICAgIGNvbnN0IG91dDogQXJyYXk8U2NvcGVSZWNvcmRlciB8IEZsb3dSZWNvcmRlcj4gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHsgcmVjb3JkZXIsIGNoYW5uZWxzIH0gb2YgdGhpcy5yZWdpc3RyYXRpb25zLnZhbHVlcygpKSB7XG4gICAgICBpZiAoY2hhbm5lbHMuaGFzKGNoYW5uZWwpKSBvdXQucHVzaChyZWNvcmRlcik7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKiogTm9ybWFsIHByb3BlcnR5IGxvb2t1cCDigJQgaW52b2NhdGlvbiBwYXJpdHkgd2l0aCB0aGUgaW5saW5lIHRpZXIuICovXG4gIHByaXZhdGUgYW55SW1wbGVtZW50cyhyZWNvcmRlcnM6IEFycmF5PFNjb3BlUmVjb3JkZXIgfCBGbG93UmVjb3JkZXI+LCBtZXRob2Q6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiByZWNvcmRlcnMuc29tZSgocikgPT4gdHlwZW9mIChyIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW21ldGhvZF0gPT09ICdmdW5jdGlvbicpO1xuICB9XG5cbiAgLyoqIFNjb3BlL2VtaXQgZXZlbnRzIGNhcnJ5IHRoZWlyIG93biBpZHMgKGBydW50aW1lU3RhZ2VJZGAgKyBgcGlwZWxpbmVJZGApLiAqL1xuICBwcml2YXRlIGNhcHR1cmVTY29wZUV2ZW50KGNoYW5uZWw6IENhcHR1cmVDaGFubmVsLCBtZXRob2Q6IHN0cmluZywgZXZlbnQ6IHVua25vd24pOiB2b2lkIHtcbiAgICBjb25zdCBlID0gZXZlbnQgYXMgeyBydW50aW1lU3RhZ2VJZD86IHN0cmluZzsgcGlwZWxpbmVJZD86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgIHRoaXMuZGlzcGF0Y2hlci5jYXB0dXJlKHtcbiAgICAgIGNoYW5uZWwsXG4gICAgICBtZXRob2QsXG4gICAgICBydW50aW1lU3RhZ2VJZDogZT8ucnVudGltZVN0YWdlSWQgPz8gJycsXG4gICAgICBydW5JZDogZT8ucGlwZWxpbmVJZCA/PyAnJyxcbiAgICAgIHBheWxvYWQ6IGV2ZW50LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIEZsb3cgZXZlbnRzIGNhcnJ5IGlkcyBvbiBgdHJhdmVyc2FsQ29udGV4dGAgKGFic2VudCBvbiBhIGZldyBldmVudHMpLiAqL1xuICBwcml2YXRlIGNhcHR1cmVGbG93RXZlbnQobWV0aG9kOiBzdHJpbmcsIGV2ZW50OiB1bmtub3duKTogdm9pZCB7XG4gICAgY29uc3QgY3R4ID0gKGV2ZW50IGFzIHsgdHJhdmVyc2FsQ29udGV4dD86IHsgcnVudGltZVN0YWdlSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nIH0gfSB8IHVuZGVmaW5lZClcbiAgICAgID8udHJhdmVyc2FsQ29udGV4dDtcbiAgICB0aGlzLmRpc3BhdGNoZXIuY2FwdHVyZSh7XG4gICAgICBjaGFubmVsOiAnZmxvdycsXG4gICAgICBtZXRob2QsXG4gICAgICBydW50aW1lU3RhZ2VJZDogY3R4Py5ydW50aW1lU3RhZ2VJZCA/PyAnJyxcbiAgICAgIHJ1bklkOiBjdHg/LnJ1bklkID8/ICcnLFxuICAgICAgcGF5bG9hZDogZXZlbnQsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUm91dGUgYSBkZWZlcnJlZCBsaXN0ZW5lciBmYWlsdXJlIGludG8gdGhlIGV4aXN0aW5nIHJlY29yZGVyIGVycm9yXG4gICAqIGNoYW5uZWw6IGV2ZXJ5IE9USEVSIHJlZ2lzdGVyZWQgb2JzZXJ2ZXIgKGRlZmVycmVkIHNpYmxpbmdzIGZpcnN0LCBpblxuICAgKiByZWdpc3RyYXRpb24gb3JkZXIpIHJlY2VpdmVzIGEgc2NvcGUtc2hhcGVkIGBvbkVycm9yYCBldmVudCDigJQgdGhlIHNhbWVcbiAgICogY29udHJhY3QgdGhlIGlubGluZSB0aWVyIGhvbm9ycyB3aGVuIGEgcmVjb3JkZXIgdGhyb3dzIG1pZC1kaXNwYXRjaC5cbiAgICogVGhlIGVycm9yIHNpbmsgbXVzdCBuZXZlciBiZWNvbWUgYW4gZXJyb3Igc291cmNlOiBzaW5rIHRocm93cyBhcmVcbiAgICogc3dhbGxvd2VkIChpc29sYXRpb24gaXMgYWJzb2x1dGUpLlxuICAgKi9cbiAgcHJpdmF0ZSByb3V0ZUxpc3RlbmVyRXJyb3IoXG4gICAgZXJyb3I6IHVua25vd24sXG4gICAgbGlzdGVuZXJJZDogc3RyaW5nLFxuICAgIGVudmVsb3BlOiBDYXB0dXJlRW52ZWxvcGUsXG4gICAgcGhhc2U6ICdzeW5jJyB8ICdhc3luYycsXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGhhc2hJZHggPSBlbnZlbG9wZS5ydW50aW1lU3RhZ2VJZC5sYXN0SW5kZXhPZignIycpO1xuICAgIGNvbnN0IGVycm9yRXZlbnQgPSB7XG4gICAgICBzdGFnZU5hbWU6ICcnLFxuICAgICAgc3RhZ2VJZDogaGFzaElkeCA+PSAwID8gZW52ZWxvcGUucnVudGltZVN0YWdlSWQuc2xpY2UoMCwgaGFzaElkeCkgOiBlbnZlbG9wZS5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHJ1bnRpbWVTdGFnZUlkOiBlbnZlbG9wZS5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHBpcGVsaW5lSWQ6IGVudmVsb3BlLnJ1bklkLFxuICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICAgIG9wZXJhdGlvbjogb3BlcmF0aW9uRm9yKGVudmVsb3BlLm1ldGhvZCksXG4gICAgICBjaGFubmVsOiAnc2NvcGUnIGFzIGNvbnN0LFxuICAgIH07XG4gICAgZm9yIChjb25zdCBbaWQsIHsgcmVjb3JkZXIsIGNoYW5uZWxzIH1dIG9mIHRoaXMucmVnaXN0cmF0aW9ucykge1xuICAgICAgaWYgKGlkID09PSBsaXN0ZW5lcklkKSBjb250aW51ZTtcbiAgICAgIC8vIElubGluZS10aWVyIHBhcml0eSAocmV2aWV3IENSSVRJQ0FMLTEpOiB0aGUgc3ludGhlc2l6ZWQgZXZlbnQgaXNcbiAgICAgIC8vIHNjb3BlLXR5cGVkLCBzbyBpdCByZWFjaGVzIE9OTFkgcmVjb3JkZXJzIHJlZ2lzdGVyZWQgb24gdGhlIHNjb3BlXG4gICAgICAvLyBsaXN0cyDigJQgYSBmbG93LW9ubHkgcmVjb3JkZXIgbmV2ZXIgcmVjZWl2ZXMgc2NvcGUtY2hhbm5lbCBlcnJvcnNcbiAgICAgIC8vIGlubGluZSBhbmQgbXVzdCBub3QgaGVyZSBlaXRoZXIuXG4gICAgICBpZiAoIWNoYW5uZWxzLmhhcygnc2NvcGUnKSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICBpbnZva2VSZWNvcmRlckhvb2socmVjb3JkZXIsICdvbkVycm9yJywgZXJyb3JFdmVudCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gU3dhbGxvdyDigJQgc2FtZSBydWxlIGFzIERlZmVycmVkRGlzcGF0Y2hlci5zYWZlT25FcnJvci5cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgW2Zvb3RwcmludGpzXSBkZWZlcnJlZCBvYnNlcnZlciAnJHtsaXN0ZW5lcklkfScgZmFpbGVkICgke3BoYXNlfSkgaGFuZGxpbmcgYCArXG4gICAgICAgICAgYCR7ZW52ZWxvcGUuY2hhbm5lbH0uJHtlbnZlbG9wZS5tZXRob2R9IChzZXEgJHtlbnZlbG9wZS5zZXF9KTogJHtTdHJpbmcoZXJyb3IpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBEaXNwYXRjaGVyLWxldmVsIG9wdGlvbnMgYXJlIGZpcnN0LWF0dGFjaC13aW5zOyBkaWZmZXJpbmcgbGF0ZXIgdmFsdWVzIGRldi13YXJuLiAqL1xuICBwcml2YXRlIHdhcm5PbkNvbmZpZ0NvbmZsaWN0KHJlY29yZGVySWQ6IHN0cmluZywgb3B0aW9ucz86IEF0dGFjaFJlY29yZGVyT3B0aW9ucyk6IHZvaWQge1xuICAgIGlmICghb3B0aW9ucykgcmV0dXJuO1xuICAgIGNvbnN0IGNvbmZsaWN0czogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXF1ZXN0ZWQ6IEFwcGxpZWREaXNwYXRjaGVyQ29uZmlnID0ge1xuICAgICAgY2FwdHVyZTogb3B0aW9ucy5jYXB0dXJlLFxuICAgICAgbWF4UXVldWU6IG9wdGlvbnMubWF4UXVldWUsXG4gICAgICBvdmVyZmxvdzogb3B0aW9ucy5vdmVyZmxvdyxcbiAgICAgIHNhbXBsZUV2ZXJ5OiBvcHRpb25zLnNhbXBsZUV2ZXJ5LFxuICAgICAgZmx1c2hCdWRnZXRNczogb3B0aW9ucy5mbHVzaEJ1ZGdldE1zLFxuICAgIH07XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocmVxdWVzdGVkKSBhcyBBcnJheTxrZXlvZiBBcHBsaWVkRGlzcGF0Y2hlckNvbmZpZz4pIHtcbiAgICAgIGlmIChyZXF1ZXN0ZWRba2V5XSAhPT0gdW5kZWZpbmVkICYmIHJlcXVlc3RlZFtrZXldICE9PSB0aGlzLmFwcGxpZWRDb25maWdba2V5XSkge1xuICAgICAgICBjb25mbGljdHMucHVzaChTdHJpbmcoa2V5KSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChjb25mbGljdHMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5kZXZXYXJuRGVkdXBlZChcbiAgICAgICAgYFtmb290cHJpbnRqc10gYXR0YWNoICcke3JlY29yZGVySWR9JzogdGhlIGV4ZWN1dG9yJ3MgZGVmZXJyZWQtb2JzZXJ2ZXIgcXVldWUgd2FzIGFscmVhZHkgYCArXG4gICAgICAgICAgYGNvbmZpZ3VyZWQgYnkgdGhlIGZpcnN0IGRlZmVycmVkIGF0dGFjaCDigJQgaWdub3JpbmcgZGlmZmVyaW5nIG9wdGlvbihzKTogJHtjb25mbGljdHMuam9pbignLCAnKX0uIGAgK1xuICAgICAgICAgICdPbmUgZXhlY3V0b3IgaGFzIE9ORSBtZXJnZWQgcXVldWU7IGNvbmZpZ3VyZSBpdCBvbiB0aGUgZmlyc3QgZGVmZXJyZWQgYXR0YWNoLicsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBgaXNEZXZNb2RlKClgLWdhdGVkLCBkZWR1cGxpY2F0ZWQgd2FybmVyIOKAlCB0aGUgYm91bmQgd2FybiBzZWFtLiAqL1xuICBwcml2YXRlIGRldldhcm5EZWR1cGVkKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghaXNEZXZNb2RlKCkpIHJldHVybjtcbiAgICBpZiAodGhpcy53YXJuZWRNZXNzYWdlcy5oYXMobWVzc2FnZSkpIHJldHVybjtcbiAgICB0aGlzLndhcm5lZE1lc3NhZ2VzLmFkZChtZXNzYWdlKTtcbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgIGNvbnNvbGUud2FybihtZXNzYWdlKTtcbiAgfVxufVxuIl19