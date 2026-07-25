/**
 * StructureRecorderDispatcher — Fans build-time structure events out to N
 * attached `StructureRecorder` instances.
 *
 * Mirrors `FlowRecorderDispatcher` (engine/narrative/) exactly:
 *
 *   - `recorders: StructureRecorder[]` — attach order preserved
 *   - per-event fire methods early-return when no recorders attached
 *     (zero-allocation fast path)
 *   - per-recorder try/catch isolates errors; one bad recorder cannot
 *     cascade into the chain build or sibling recorders
 *   - errors route to BOTH the dev-mode console warning (matches
 *     FlowRecorderDispatcher) AND a structured `buildErrors`
 *     accumulator so consumers can inspect failures post-build
 *   - spec payloads are NOT frozen at dispatch time — handlers must
 *     respect the `readonly` markers on event payload types (the
 *     builder still needs to mutate `spec.next` after the immediate
 *     `onStageAdded` fires; see `fireStageAdded` for the full note,
 *     and `StructureRecorder.ts` header "Spec mutation" for the
 *     trust-model implications)
 *
 * The dispatcher itself owns NO chart state. The builder owns the
 * dispatcher; events fire from the natural mutation points in
 * FlowChartBuilder (L7.3).
 */
import { isDevMode } from '../../scope/detectCircular.js';
/**
 * Soft cap on the `errors[]` accumulator. Builds with thousands of
 * stages and a misbehaving recorder that throws on every event would
 * otherwise retain unbounded `{recorderId, method, message, error}`
 * records — each closing over the thrown value (often an Error with
 * a captured stack), preventing GC of any closure data the throw
 * captured. The cap is for diagnosis, not forensic completeness;
 * once exceeded, a single sentinel record signals truncation.
 */
const STRUCTURE_BUILD_ERRORS_CAP = 100;
export class StructureRecorderDispatcher {
    recorders = [];
    errors = [];
    _truncated = false;
    /** Attach a `StructureRecorder`. Multiple recorders with the same
     *  id are allowed; the convention is one id per logical concern. */
    attach(recorder) {
        this.recorders.push(recorder);
    }
    /** Detach every recorder with the given id. */
    detach(id) {
        this.recorders = this.recorders.filter((r) => r.id !== id);
    }
    /** Defensive copy of the attached recorders — used in tests + by
     *  tooling that wants to inspect what's registered. */
    getRecorders() {
        return [...this.recorders];
    }
    /** Find one recorder by id. */
    getRecorderById(id) {
        return this.recorders.find((r) => r.id === id);
    }
    /** Read accumulated errors from this build. Returns a defensive copy. */
    getErrors() {
        return [...this.errors];
    }
    // ── fire* methods — called by the builder at each event moment ─────
    fireStageAdded(event) {
        if (this.recorders.length === 0)
            return;
        // NOTE: `event.spec` is NOT frozen here. `onStageAdded` fires
        // IMMEDIATELY when a spec node is added — the builder still needs
        // to mutate `spec.next` later (in the subsequent `addX` call).
        // Freezing here would break the builder. Handler mutation of
        // `event.spec` is documented as undefined behavior — see the
        // StructureRecorder type's JSDoc + readonly markers on the
        // event payload interface.
        for (const r of this.recorders) {
            try {
                r.onStageAdded?.(event);
            }
            catch (err) {
                this.recordError(r.id, 'onStageAdded', err);
            }
        }
    }
    fireEdgeAdded(event) {
        if (this.recorders.length === 0)
            return;
        // No spec on this event — pass through.
        for (const r of this.recorders) {
            try {
                r.onEdgeAdded?.(event);
            }
            catch (err) {
                this.recordError(r.id, 'onEdgeAdded', err);
            }
        }
    }
    fireLoopEdgeAdded(event) {
        if (this.recorders.length === 0)
            return;
        for (const r of this.recorders) {
            try {
                r.onLoopEdgeAdded?.(event);
            }
            catch (err) {
                this.recordError(r.id, 'onLoopEdgeAdded', err);
            }
        }
    }
    fireDeciderComplete(event) {
        if (this.recorders.length === 0)
            return;
        for (const r of this.recorders) {
            try {
                r.onDeciderComplete?.(event);
            }
            catch (err) {
                this.recordError(r.id, 'onDeciderComplete', err);
            }
        }
    }
    fireSubflowMounted(event) {
        if (this.recorders.length === 0)
            return;
        for (const r of this.recorders) {
            try {
                r.onSubflowMounted?.(event);
            }
            catch (err) {
                this.recordError(r.id, 'onSubflowMounted', err);
            }
        }
    }
    /**
     * Externally-callable error capture for events the builder fires
     * OUTSIDE the normal fire* fan-out path — specifically the seed
     * replay in `FlowChartBuilder.attachStructureRecorder()`, which
     * targets one specific recorder rather than every attached recorder.
     *
     * Same observability contract as the internal `recordError`:
     * accumulates on `getErrors()` AND logs in dev mode.
     */
    recordErrorForReplay(recorderId, method, err) {
        this.recordError(recorderId, method, err);
    }
    // ── Internals ───────────────────────────────────────────────────────
    recordError(recorderId, method, err) {
        const e = err;
        const message = typeof e?.message === 'string' ? e.message : String(err);
        // Soft cap to prevent unbounded growth + closure retention. Once
        // hit, push a single sentinel describing the truncation and drop
        // further records on the floor (still log in dev mode so the
        // consumer notices the spam at its source).
        if (this.errors.length < STRUCTURE_BUILD_ERRORS_CAP) {
            this.errors.push({ recorderId, method, message, error: err });
        }
        else if (!this._truncated) {
            this._truncated = true;
            this.errors.push({
                recorderId: '__truncated__',
                method: '__truncated__',
                message: `StructureRecorderDispatcher: error accumulator truncated at ${STRUCTURE_BUILD_ERRORS_CAP} entries; further errors suppressed.`,
                error: null,
            });
        }
        if (isDevMode()) {
            // eslint-disable-next-line no-console
            console.warn(`[footprint] StructureRecorderDispatcher: recorder "${recorderId}" threw in ${method}: ${message}. ` +
                'See builder.getStructureBuildErrors() for the full list.');
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3RydWN0dXJlUmVjb3JkZXJEaXNwYXRjaGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9idWlsZGVyL3N0cnVjdHVyZS9TdHJ1Y3R1cmVSZWNvcmRlckRpc3BhdGNoZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXdCRztBQUVILE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSwrQkFBK0IsQ0FBQztBQTJCMUQ7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFNLDBCQUEwQixHQUFHLEdBQUcsQ0FBQztBQUV2QyxNQUFNLE9BQU8sMkJBQTJCO0lBQzlCLFNBQVMsR0FBd0IsRUFBRSxDQUFDO0lBQzNCLE1BQU0sR0FBMEIsRUFBRSxDQUFDO0lBQzVDLFVBQVUsR0FBRyxLQUFLLENBQUM7SUFFM0I7d0VBQ29FO0lBQ3BFLE1BQU0sQ0FBQyxRQUEyQjtRQUNoQyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNoQyxDQUFDO0lBRUQsK0NBQStDO0lBQy9DLE1BQU0sQ0FBQyxFQUFVO1FBQ2YsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUM3RCxDQUFDO0lBRUQ7MkRBQ3VEO0lBQ3ZELFlBQVk7UUFDVixPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVELCtCQUErQjtJQUMvQixlQUFlLENBQWtELEVBQVU7UUFDekUsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQWtCLENBQUM7SUFDbEUsQ0FBQztJQUVELHlFQUF5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QyxJQUFJLENBQ1Ysc0RBQXNELFVBQVUsY0FBYyxNQUFNLEtBQUssT0FBTyxJQUFJO2dCQUNsRywwREFBMEQsQ0FDN0QsQ0FBQztRQUNKLENBQUM7SUFDSCxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN0cnVjdHVyZVJlY29yZGVyRGlzcGF0Y2hlciDigJQgRmFucyBidWlsZC10aW1lIHN0cnVjdHVyZSBldmVudHMgb3V0IHRvIE5cbiAqIGF0dGFjaGVkIGBTdHJ1Y3R1cmVSZWNvcmRlcmAgaW5zdGFuY2VzLlxuICpcbiAqIE1pcnJvcnMgYEZsb3dSZWNvcmRlckRpc3BhdGNoZXJgIChlbmdpbmUvbmFycmF0aXZlLykgZXhhY3RseTpcbiAqXG4gKiAgIC0gYHJlY29yZGVyczogU3RydWN0dXJlUmVjb3JkZXJbXWAg4oCUIGF0dGFjaCBvcmRlciBwcmVzZXJ2ZWRcbiAqICAgLSBwZXItZXZlbnQgZmlyZSBtZXRob2RzIGVhcmx5LXJldHVybiB3aGVuIG5vIHJlY29yZGVycyBhdHRhY2hlZFxuICogICAgICh6ZXJvLWFsbG9jYXRpb24gZmFzdCBwYXRoKVxuICogICAtIHBlci1yZWNvcmRlciB0cnkvY2F0Y2ggaXNvbGF0ZXMgZXJyb3JzOyBvbmUgYmFkIHJlY29yZGVyIGNhbm5vdFxuICogICAgIGNhc2NhZGUgaW50byB0aGUgY2hhaW4gYnVpbGQgb3Igc2libGluZyByZWNvcmRlcnNcbiAqICAgLSBlcnJvcnMgcm91dGUgdG8gQk9USCB0aGUgZGV2LW1vZGUgY29uc29sZSB3YXJuaW5nIChtYXRjaGVzXG4gKiAgICAgRmxvd1JlY29yZGVyRGlzcGF0Y2hlcikgQU5EIGEgc3RydWN0dXJlZCBgYnVpbGRFcnJvcnNgXG4gKiAgICAgYWNjdW11bGF0b3Igc28gY29uc3VtZXJzIGNhbiBpbnNwZWN0IGZhaWx1cmVzIHBvc3QtYnVpbGRcbiAqICAgLSBzcGVjIHBheWxvYWRzIGFyZSBOT1QgZnJvemVuIGF0IGRpc3BhdGNoIHRpbWUg4oCUIGhhbmRsZXJzIG11c3RcbiAqICAgICByZXNwZWN0IHRoZSBgcmVhZG9ubHlgIG1hcmtlcnMgb24gZXZlbnQgcGF5bG9hZCB0eXBlcyAodGhlXG4gKiAgICAgYnVpbGRlciBzdGlsbCBuZWVkcyB0byBtdXRhdGUgYHNwZWMubmV4dGAgYWZ0ZXIgdGhlIGltbWVkaWF0ZVxuICogICAgIGBvblN0YWdlQWRkZWRgIGZpcmVzOyBzZWUgYGZpcmVTdGFnZUFkZGVkYCBmb3IgdGhlIGZ1bGwgbm90ZSxcbiAqICAgICBhbmQgYFN0cnVjdHVyZVJlY29yZGVyLnRzYCBoZWFkZXIgXCJTcGVjIG11dGF0aW9uXCIgZm9yIHRoZVxuICogICAgIHRydXN0LW1vZGVsIGltcGxpY2F0aW9ucylcbiAqXG4gKiBUaGUgZGlzcGF0Y2hlciBpdHNlbGYgb3ducyBOTyBjaGFydCBzdGF0ZS4gVGhlIGJ1aWxkZXIgb3ducyB0aGVcbiAqIGRpc3BhdGNoZXI7IGV2ZW50cyBmaXJlIGZyb20gdGhlIG5hdHVyYWwgbXV0YXRpb24gcG9pbnRzIGluXG4gKiBGbG93Q2hhcnRCdWlsZGVyIChMNy4zKS5cbiAqL1xuXG5pbXBvcnQgeyBpc0Rldk1vZGUgfSBmcm9tICcuLi8uLi9zY29wZS9kZXRlY3RDaXJjdWxhci5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dDaGFydFNwZWMgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIFN0cnVjdHVyZURlY2lkZXJDb21wbGV0ZUV2ZW50LFxuICBTdHJ1Y3R1cmVFZGdlQWRkZWRFdmVudCxcbiAgU3RydWN0dXJlTG9vcEVkZ2VBZGRlZEV2ZW50LFxuICBTdHJ1Y3R1cmVSZWNvcmRlcixcbiAgU3RydWN0dXJlU3RhZ2VBZGRlZEV2ZW50LFxuICBTdHJ1Y3R1cmVTdWJmbG93TW91bnRlZEV2ZW50LFxufSBmcm9tICcuL1N0cnVjdHVyZVJlY29yZGVyLmpzJztcblxuLyoqIFN0cnVjdHVyZWQgZXJyb3IgY2FwdHVyZWQgd2hlbiBhIHJlY29yZGVyIHRocm93cy4gUmVhZCBwb3N0LWJ1aWxkXG4gKiAgdmlhIGBidWlsZGVyLmdldFN0cnVjdHVyZUJ1aWxkRXJyb3JzKClgIOKAlCBjYWxsIG9uIHRoZSBCVUlMREVSXG4gKiAgcmVmZXJlbmNlIChOT1QgdGhlIGNoYXJ0IHJldHVybmVkIGJ5IGAuYnVpbGQoKWApLiBDYXB0dXJlIHRoZVxuICogIGJ1aWxkZXIgcmVmZXJlbmNlIGJlZm9yZSBgLmJ1aWxkKClgIGlmIHlvdSBuZWVkIHBvc3QtYnVpbGQgYWNjZXNzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdHJ1Y3R1cmVCdWlsZEVycm9yIHtcbiAgLyoqIFdoaWNoIHJlY29yZGVyJ3MgaGFuZGxlciB0aHJldy4gKi9cbiAgcmVhZG9ubHkgcmVjb3JkZXJJZDogc3RyaW5nO1xuICAvKiogV2hpY2ggZXZlbnQgbWV0aG9kIChgJ29uU3RhZ2VBZGRlZCdgLCBgJ29uRWRnZUFkZGVkJ2AsIC4uLikuICovXG4gIHJlYWRvbmx5IG1ldGhvZDogc3RyaW5nO1xuICAvKiogRXJyb3IgbWVzc2FnZSBleHRyYWN0ZWQgZnJvbSB0aGUgdGhyb3duIHZhbHVlLiAqL1xuICByZWFkb25seSBtZXNzYWdlOiBzdHJpbmc7XG4gIC8qKiBUaGUgb3JpZ2luYWwgdGhyb3duIHZhbHVlIOKAlCBgRXJyb3JgIGluc3RhbmNlIG9yIHdoYXRldmVyIHRoZVxuICAgKiAgcmVjb3JkZXIgdGhyZXcuIFVzZWZ1bCB3aGVuIGRpYWdub3NpcyBuZWVkcyBhIHN0YWNrIHRyYWNlLiAqL1xuICByZWFkb25seSBlcnJvcjogdW5rbm93bjtcbn1cblxuLyoqXG4gKiBTb2Z0IGNhcCBvbiB0aGUgYGVycm9yc1tdYCBhY2N1bXVsYXRvci4gQnVpbGRzIHdpdGggdGhvdXNhbmRzIG9mXG4gKiBzdGFnZXMgYW5kIGEgbWlzYmVoYXZpbmcgcmVjb3JkZXIgdGhhdCB0aHJvd3Mgb24gZXZlcnkgZXZlbnQgd291bGRcbiAqIG90aGVyd2lzZSByZXRhaW4gdW5ib3VuZGVkIGB7cmVjb3JkZXJJZCwgbWV0aG9kLCBtZXNzYWdlLCBlcnJvcn1gXG4gKiByZWNvcmRzIOKAlCBlYWNoIGNsb3Npbmcgb3ZlciB0aGUgdGhyb3duIHZhbHVlIChvZnRlbiBhbiBFcnJvciB3aXRoXG4gKiBhIGNhcHR1cmVkIHN0YWNrKSwgcHJldmVudGluZyBHQyBvZiBhbnkgY2xvc3VyZSBkYXRhIHRoZSB0aHJvd1xuICogY2FwdHVyZWQuIFRoZSBjYXAgaXMgZm9yIGRpYWdub3Npcywgbm90IGZvcmVuc2ljIGNvbXBsZXRlbmVzcztcbiAqIG9uY2UgZXhjZWVkZWQsIGEgc2luZ2xlIHNlbnRpbmVsIHJlY29yZCBzaWduYWxzIHRydW5jYXRpb24uXG4gKi9cbmNvbnN0IFNUUlVDVFVSRV9CVUlMRF9FUlJPUlNfQ0FQID0gMTAwO1xuXG5leHBvcnQgY2xhc3MgU3RydWN0dXJlUmVjb3JkZXJEaXNwYXRjaGVyIHtcbiAgcHJpdmF0ZSByZWNvcmRlcnM6IFN0cnVjdHVyZVJlY29yZGVyW10gPSBbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBlcnJvcnM6IFN0cnVjdHVyZUJ1aWxkRXJyb3JbXSA9IFtdO1xuICBwcml2YXRlIF90cnVuY2F0ZWQgPSBmYWxzZTtcblxuICAvKiogQXR0YWNoIGEgYFN0cnVjdHVyZVJlY29yZGVyYC4gTXVsdGlwbGUgcmVjb3JkZXJzIHdpdGggdGhlIHNhbWVcbiAgICogIGlkIGFyZSBhbGxvd2VkOyB0aGUgY29udmVudGlvbiBpcyBvbmUgaWQgcGVyIGxvZ2ljYWwgY29uY2Vybi4gKi9cbiAgYXR0YWNoKHJlY29yZGVyOiBTdHJ1Y3R1cmVSZWNvcmRlcik6IHZvaWQge1xuICAgIHRoaXMucmVjb3JkZXJzLnB1c2gocmVjb3JkZXIpO1xuICB9XG5cbiAgLyoqIERldGFjaCBldmVyeSByZWNvcmRlciB3aXRoIHRoZSBnaXZlbiBpZC4gKi9cbiAgZGV0YWNoKGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLnJlY29yZGVycyA9IHRoaXMucmVjb3JkZXJzLmZpbHRlcigocikgPT4gci5pZCAhPT0gaWQpO1xuICB9XG5cbiAgLyoqIERlZmVuc2l2ZSBjb3B5IG9mIHRoZSBhdHRhY2hlZCByZWNvcmRlcnMg4oCUIHVzZWQgaW4gdGVzdHMgKyBieVxuICAgKiAgdG9vbGluZyB0aGF0IHdhbnRzIHRvIGluc3BlY3Qgd2hhdCdzIHJlZ2lzdGVyZWQuICovXG4gIGdldFJlY29yZGVycygpOiBTdHJ1Y3R1cmVSZWNvcmRlcltdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMucmVjb3JkZXJzXTtcbiAgfVxuXG4gIC8qKiBGaW5kIG9uZSByZWNvcmRlciBieSBpZC4gKi9cbiAgZ2V0UmVjb3JkZXJCeUlkPFQgZXh0ZW5kcyBTdHJ1Y3R1cmVSZWNvcmRlciA9IFN0cnVjdHVyZVJlY29yZGVyPihpZDogc3RyaW5nKTogVCB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMucmVjb3JkZXJzLmZpbmQoKHIpID0+IHIuaWQgPT09IGlkKSBhcyBUIHwgdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIFJlYWQgYWNjdW11bGF0ZWQgZXJyb3JzIGZyb20gdGhpcyBidWlsZC4gUmV0dXJucyBhIGRlZmVuc2l2ZSBjb3B5LiAqL1xuICBnZXRFcnJvcnMoKTogU3RydWN0dXJlQnVpbGRFcnJvcltdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuZXJyb3JzXTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBmaXJlKiBtZXRob2RzIOKAlCBjYWxsZWQgYnkgdGhlIGJ1aWxkZXIgYXQgZWFjaCBldmVudCBtb21lbnQg4pSA4pSA4pSA4pSA4pSAXG5cbiAgZmlyZVN0YWdlQWRkZWQoZXZlbnQ6IFN0cnVjdHVyZVN0YWdlQWRkZWRFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICAvLyBOT1RFOiBgZXZlbnQuc3BlY2AgaXMgTk9UIGZyb3plbiBoZXJlLiBgb25TdGFnZUFkZGVkYCBmaXJlc1xuICAgIC8vIElNTUVESUFURUxZIHdoZW4gYSBzcGVjIG5vZGUgaXMgYWRkZWQg4oCUIHRoZSBidWlsZGVyIHN0aWxsIG5lZWRzXG4gICAgLy8gdG8gbXV0YXRlIGBzcGVjLm5leHRgIGxhdGVyIChpbiB0aGUgc3Vic2VxdWVudCBgYWRkWGAgY2FsbCkuXG4gICAgLy8gRnJlZXppbmcgaGVyZSB3b3VsZCBicmVhayB0aGUgYnVpbGRlci4gSGFuZGxlciBtdXRhdGlvbiBvZlxuICAgIC8vIGBldmVudC5zcGVjYCBpcyBkb2N1bWVudGVkIGFzIHVuZGVmaW5lZCBiZWhhdmlvciDigJQgc2VlIHRoZVxuICAgIC8vIFN0cnVjdHVyZVJlY29yZGVyIHR5cGUncyBKU0RvYyArIHJlYWRvbmx5IG1hcmtlcnMgb24gdGhlXG4gICAgLy8gZXZlbnQgcGF5bG9hZCBpbnRlcmZhY2UuXG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uU3RhZ2VBZGRlZD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0aGlzLnJlY29yZEVycm9yKHIuaWQsICdvblN0YWdlQWRkZWQnLCBlcnIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZpcmVFZGdlQWRkZWQoZXZlbnQ6IFN0cnVjdHVyZUVkZ2VBZGRlZEV2ZW50KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIC8vIE5vIHNwZWMgb24gdGhpcyBldmVudCDigJQgcGFzcyB0aHJvdWdoLlxuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkVkZ2VBZGRlZD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0aGlzLnJlY29yZEVycm9yKHIuaWQsICdvbkVkZ2VBZGRlZCcsIGVycik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZmlyZUxvb3BFZGdlQWRkZWQoZXZlbnQ6IFN0cnVjdHVyZUxvb3BFZGdlQWRkZWRFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25Mb29wRWRnZUFkZGVkPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHRoaXMucmVjb3JkRXJyb3Ioci5pZCwgJ29uTG9vcEVkZ2VBZGRlZCcsIGVycik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZmlyZURlY2lkZXJDb21wbGV0ZShldmVudDogU3RydWN0dXJlRGVjaWRlckNvbXBsZXRlRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uRGVjaWRlckNvbXBsZXRlPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHRoaXMucmVjb3JkRXJyb3Ioci5pZCwgJ29uRGVjaWRlckNvbXBsZXRlJywgZXJyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmaXJlU3ViZmxvd01vdW50ZWQoZXZlbnQ6IFN0cnVjdHVyZVN1YmZsb3dNb3VudGVkRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uU3ViZmxvd01vdW50ZWQ/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgdGhpcy5yZWNvcmRFcnJvcihyLmlkLCAnb25TdWJmbG93TW91bnRlZCcsIGVycik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEV4dGVybmFsbHktY2FsbGFibGUgZXJyb3IgY2FwdHVyZSBmb3IgZXZlbnRzIHRoZSBidWlsZGVyIGZpcmVzXG4gICAqIE9VVFNJREUgdGhlIG5vcm1hbCBmaXJlKiBmYW4tb3V0IHBhdGgg4oCUIHNwZWNpZmljYWxseSB0aGUgc2VlZFxuICAgKiByZXBsYXkgaW4gYEZsb3dDaGFydEJ1aWxkZXIuYXR0YWNoU3RydWN0dXJlUmVjb3JkZXIoKWAsIHdoaWNoXG4gICAqIHRhcmdldHMgb25lIHNwZWNpZmljIHJlY29yZGVyIHJhdGhlciB0aGFuIGV2ZXJ5IGF0dGFjaGVkIHJlY29yZGVyLlxuICAgKlxuICAgKiBTYW1lIG9ic2VydmFiaWxpdHkgY29udHJhY3QgYXMgdGhlIGludGVybmFsIGByZWNvcmRFcnJvcmA6XG4gICAqIGFjY3VtdWxhdGVzIG9uIGBnZXRFcnJvcnMoKWAgQU5EIGxvZ3MgaW4gZGV2IG1vZGUuXG4gICAqL1xuICByZWNvcmRFcnJvckZvclJlcGxheShyZWNvcmRlcklkOiBzdHJpbmcsIG1ldGhvZDogc3RyaW5nLCBlcnI6IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLnJlY29yZEVycm9yKHJlY29yZGVySWQsIG1ldGhvZCwgZXJyKTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBJbnRlcm5hbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSByZWNvcmRFcnJvcihyZWNvcmRlcklkOiBzdHJpbmcsIG1ldGhvZDogc3RyaW5nLCBlcnI6IHVua25vd24pOiB2b2lkIHtcbiAgICBjb25zdCBlID0gZXJyIGFzIHsgbWVzc2FnZT86IHVua25vd24gfSB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBtZXNzYWdlID0gdHlwZW9mIGU/Lm1lc3NhZ2UgPT09ICdzdHJpbmcnID8gZS5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgLy8gU29mdCBjYXAgdG8gcHJldmVudCB1bmJvdW5kZWQgZ3Jvd3RoICsgY2xvc3VyZSByZXRlbnRpb24uIE9uY2VcbiAgICAvLyBoaXQsIHB1c2ggYSBzaW5nbGUgc2VudGluZWwgZGVzY3JpYmluZyB0aGUgdHJ1bmNhdGlvbiBhbmQgZHJvcFxuICAgIC8vIGZ1cnRoZXIgcmVjb3JkcyBvbiB0aGUgZmxvb3IgKHN0aWxsIGxvZyBpbiBkZXYgbW9kZSBzbyB0aGVcbiAgICAvLyBjb25zdW1lciBub3RpY2VzIHRoZSBzcGFtIGF0IGl0cyBzb3VyY2UpLlxuICAgIGlmICh0aGlzLmVycm9ycy5sZW5ndGggPCBTVFJVQ1RVUkVfQlVJTERfRVJST1JTX0NBUCkge1xuICAgICAgdGhpcy5lcnJvcnMucHVzaCh7IHJlY29yZGVySWQsIG1ldGhvZCwgbWVzc2FnZSwgZXJyb3I6IGVyciB9KTtcbiAgICB9IGVsc2UgaWYgKCF0aGlzLl90cnVuY2F0ZWQpIHtcbiAgICAgIHRoaXMuX3RydW5jYXRlZCA9IHRydWU7XG4gICAgICB0aGlzLmVycm9ycy5wdXNoKHtcbiAgICAgICAgcmVjb3JkZXJJZDogJ19fdHJ1bmNhdGVkX18nLFxuICAgICAgICBtZXRob2Q6ICdfX3RydW5jYXRlZF9fJyxcbiAgICAgICAgbWVzc2FnZTogYFN0cnVjdHVyZVJlY29yZGVyRGlzcGF0Y2hlcjogZXJyb3IgYWNjdW11bGF0b3IgdHJ1bmNhdGVkIGF0ICR7U1RSVUNUVVJFX0JVSUxEX0VSUk9SU19DQVB9IGVudHJpZXM7IGZ1cnRoZXIgZXJyb3JzIHN1cHByZXNzZWQuYCxcbiAgICAgICAgZXJyb3I6IG51bGwsXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgW2Zvb3RwcmludF0gU3RydWN0dXJlUmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7cmVjb3JkZXJJZH1cIiB0aHJldyBpbiAke21ldGhvZH06ICR7bWVzc2FnZX0uIGAgK1xuICAgICAgICAgICdTZWUgYnVpbGRlci5nZXRTdHJ1Y3R1cmVCdWlsZEVycm9ycygpIGZvciB0aGUgZnVsbCBsaXN0LicsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG4vKiogUmUtZXhwb3J0IHRoZSBGbG93Q2hhcnRTcGVjIHR5cGUgZm9yIGRvd25zdHJlYW0gdHlwZSBjb21wbGV0ZW5lc3MuICovXG5leHBvcnQgdHlwZSB7IEZsb3dDaGFydFNwZWMgfTtcbiJdfQ==