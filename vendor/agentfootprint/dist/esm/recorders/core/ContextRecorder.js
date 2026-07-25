/**
 * ContextRecorder — observes footprintjs subflow + scope events, emits
 * grouped `context.*` domain events via the EventDispatcher.
 *
 * Pattern: Observer (GoF) + Pipes & Filters (Hohpe & Woolf, 2003).
 * Role:    Core semantic grouping layer for the 3-slot model. Watches
 *          slot subflows (sf-system-prompt / sf-messages / sf-tools) and
 *          translates raw writes into context.injected / evicted /
 *          slot_composed / budget_pressure events.
 * Emits:   agentfootprint.context.injected
 *          agentfootprint.context.evicted
 *          agentfootprint.context.slot_composed
 *          agentfootprint.context.budget_pressure
 */
import { INJECTION_KEYS, slotFromSubflowId, slotFromRuntimeStageId } from '../../conventions.js';
import { buildEventMeta } from '../../bridge/eventMeta.js';
import { COMPOSITION_KEYS } from './types.js';
export class ContextRecorder {
    id;
    dispatcher;
    getRunContext;
    // Per-write slot attribution is resolved from each write's own
    // runtimeStageId (see onWrite) — NOT a "currently-open slot" stack.
    // The 3 slot subflows run in PARALLEL (selector fan-out), so their
    // entry/write/exit events interleave and a stack top would mis-route
    // or drop writes. onSubflowEntry/Exit only manage the per-slot
    // seen-set lifecycle below.
    // Previously seen injections per slot, by scope key. We diff old-vs-new
    // on each write to identify NEW injections (the builder may write the
    // whole array multiple times; we only emit events for the additions).
    seenInjections = new Map();
    constructor(options) {
        this.dispatcher = options.dispatcher;
        this.id = options.id ?? 'agentfootprint.context-recorder';
        this.getRunContext = options.getRunContext;
    }
    // ─── Subflow boundaries ────────────────────────────────────────
    onSubflowEntry(event) {
        const slot = event.subflowId ? slotFromSubflowId(event.subflowId) : undefined;
        if (!slot)
            return;
        // Reset the seen-set for this slot — new iteration. Safe under parallel
        // entry of all 3 slots: each slot owns its own seen-set key.
        this.seenInjections.set(slot, new Set());
    }
    onSubflowExit(event) {
        if (!event.subflowId)
            return;
        const slot = slotFromSubflowId(event.subflowId);
        if (!slot)
            return;
        this.seenInjections.delete(slot);
    }
    // ─── Scope writes — the injection / eviction / pressure signals ──
    onWrite(event) {
        // Resolve the slot from THIS write's own runtimeStageId path — correct
        // even when the 3 slots run concurrently and their events interleave.
        const activeSlot = slotFromRuntimeStageId(event.runtimeStageId);
        if (!activeSlot)
            return;
        const key = event.key;
        // Injection signals (INJECTION_KEYS) — per-slot arrays of InjectionRecord.
        if (key === INJECTION_KEYS.SYSTEM_PROMPT && activeSlot === 'system-prompt') {
            this.handleInjectionsWrite(activeSlot, event);
            return;
        }
        if (key === INJECTION_KEYS.MESSAGES && activeSlot === 'messages') {
            this.handleInjectionsWrite(activeSlot, event);
            return;
        }
        if (key === INJECTION_KEYS.TOOLS && activeSlot === 'tools') {
            this.handleInjectionsWrite(activeSlot, event);
            return;
        }
        // Composition summary — ONE record per slot exit, written just before exit.
        if (key === COMPOSITION_KEYS.SLOT_COMPOSED) {
            this.handleSlotComposedWrite(event);
            return;
        }
        // Evictions — per-piece removals under budget pressure.
        if (key === COMPOSITION_KEYS.EVICTED) {
            this.handleEvictionsWrite(event);
            return;
        }
        // Budget-pressure warnings — fired BEFORE evictions.
        if (key === COMPOSITION_KEYS.BUDGET_PRESSURE) {
            this.handleBudgetPressureWrite(event);
            return;
        }
    }
    // ─── Internals ─────────────────────────────────────────────────
    handleInjectionsWrite(slot, event) {
        const records = this.asInjectionArray(event.value);
        if (!records)
            return;
        const seen = this.seenInjections.get(slot) ?? new Set();
        for (const rec of records) {
            if (seen.has(rec.contentHash))
                continue;
            seen.add(rec.contentHash);
            this.emitInjected(rec, event);
        }
        this.seenInjections.set(slot, seen);
    }
    handleSlotComposedWrite(event) {
        const rec = this.asSlotComposition(event.value);
        if (!rec)
            return;
        this.dispatch('agentfootprint.context.slot_composed', rec, event);
    }
    handleEvictionsWrite(event) {
        const records = this.asEvictionArray(event.value);
        if (!records)
            return;
        for (const rec of records) {
            this.dispatch('agentfootprint.context.evicted', rec, event);
        }
    }
    handleBudgetPressureWrite(event) {
        const records = this.asPressureArray(event.value);
        if (!records)
            return;
        for (const rec of records) {
            this.dispatch('agentfootprint.context.budget_pressure', rec, event);
        }
    }
    emitInjected(rec, event) {
        // Payload is a structural subset of InjectionRecord — InjectionRecord is
        // designed to carry exactly what ContextInjectedPayload needs, so we
        // copy through directly.
        //
        // Redaction: footprintjs's scope layer sets `event.redacted = true` if
        // its RedactionPolicy matched the scope key. We trust that flag —
        // `rec.rawContent` arrives already-redacted if it was going to be. We
        // do NOT re-implement redaction here (single source of truth in
        // footprintjs's RedactionPolicy).
        this.dispatch('agentfootprint.context.injected', rec, event);
    }
    dispatch(type, payload, source) {
        if (!this.dispatcher.hasListenersFor(type))
            return;
        // FlowSubflowEvent nests traversal info under .traversalContext.
        // WriteEvent flattens runtimeStageId + stageId at the top level via
        // RecorderContext. buildEventMeta accepts either shape.
        const origin = 'traversalContext' in source && source.traversalContext
            ? source.traversalContext
            : source;
        const meta = buildEventMeta(origin, this.getRunContext());
        this.dispatcher.dispatch({ type, payload, meta });
    }
    // ─── Type-narrowing helpers ────────────────────────────────────
    asInjectionArray(value) {
        if (!Array.isArray(value))
            return undefined;
        // Duck-type — require at least `contentHash` + `slot` + `source`.
        for (const r of value) {
            if (!r || typeof r !== 'object')
                return undefined;
            const rec = r;
            if (typeof rec.contentHash !== 'string')
                return undefined;
            if (typeof rec.slot !== 'string')
                return undefined;
            if (typeof rec.source !== 'string')
                return undefined;
        }
        return value;
    }
    asSlotComposition(value) {
        if (!value || typeof value !== 'object')
            return undefined;
        const rec = value;
        if (typeof rec.slot !== 'string')
            return undefined;
        if (typeof rec.iteration !== 'number')
            return undefined;
        if (!rec.budget || typeof rec.budget !== 'object')
            return undefined;
        if (!rec.sourceBreakdown || typeof rec.sourceBreakdown !== 'object')
            return undefined;
        if (typeof rec.droppedCount !== 'number')
            return undefined;
        if (!Array.isArray(rec.droppedSummaries))
            return undefined;
        return value;
    }
    asEvictionArray(value) {
        if (!Array.isArray(value))
            return undefined;
        for (const r of value) {
            if (!r || typeof r !== 'object')
                return undefined;
            const rec = r;
            if (typeof rec.slot !== 'string')
                return undefined;
            if (typeof rec.contentHash !== 'string')
                return undefined;
        }
        return value;
    }
    asPressureArray(value) {
        if (!Array.isArray(value))
            return undefined;
        for (const r of value) {
            if (!r || typeof r !== 'object')
                return undefined;
            const rec = r;
            if (typeof rec.slot !== 'string')
                return undefined;
            if (typeof rec.capTokens !== 'number')
                return undefined;
        }
        return value;
    }
}
//# sourceMappingURL=ContextRecorder.js.map