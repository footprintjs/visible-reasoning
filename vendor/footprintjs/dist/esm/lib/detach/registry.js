/**
 * detach/registry.ts — Process-singleton handle registry.
 *
 * Pattern:  Registry (GoF). Same shape as the cache strategy registry
 *           in agentfootprint v2.6 — a Map keyed by stable string id.
 * Role:     Glue between drivers and executors. When a driver schedules
 *           work it `register`s the handle here; later (during executor
 *           disposal, or for diagnostics) consumers `lookup` by refId.
 *
 * Why a singleton?
 *   - refIds are minted per detach call and are unique across the
 *     process lifetime (driver name + monotonic counter)
 *   - handles need to be cleanable from MULTIPLE call sites (executor
 *     disposal, driver-internal flush, test cleanup) without each one
 *     having to thread a Registry instance through ten layers
 *   - one-source-of-truth simplifies "is this handle still alive?"
 *     queries during debugging
 *
 * Why NOT a class instance per executor?
 *   - drivers (e.g., `microtaskBatchDriver`) are PROCESS-wide (one queue
 *     per driver, shared by every executor). Tying registry to executor
 *     would force per-executor driver instances, multiplying the queue
 *     count and breaking the batch-amortization the drivers exist for.
 *
 * Cleanup contract:
 *   - Drivers call `register(handle)` synchronously inside `schedule()`
 *   - Drivers (or executor disposal) call `unregister(refId)` once the
 *     handle is terminal AND the consumer has had a chance to observe it
 *   - `_resetForTests()` clears every entry — tests only
 *
 * Capacity:
 *   - No upper bound. The handle objects are tiny (~6 fields). A long-
 *     running process that detaches a million units WITHOUT cleanup
 *     would leak ~50 MB — acceptable for v1, since drivers ARE the
 *     cleanup site. If real-world programs hit the limit, add a
 *     sliding-window cap with telemetry hook (mirrors
 *     `LIVE_STATUS_LOG_CAP` in agentfootprint).
 */
// Process-wide singleton. Map preserves insertion order — useful for
// diagnostic dumps that want chronological ordering.
const HANDLES = new Map();
/**
 * Register a freshly-minted handle. Drivers MUST call this synchronously
 * inside `schedule()` so the handle is observable from the moment it
 * exists.
 *
 * Replacing an existing registration is treated as a programming error
 * (refIds are supposed to be unique). We don't throw — silent overwrite
 * could mask a bug, but throwing inside a driver's hot path could cascade
 * into the parent stage. Compromise: warn in dev mode, overwrite always.
 */
export function register(handle) {
    HANDLES.set(handle.id, handle);
}
/**
 * Look up a handle by refId. Returns `undefined` for unknown ids — the
 * caller decides whether that's an error or just a stale reference.
 *
 * Used by:
 *   - Executor disposal (find handles to mark cancelled / drain)
 *   - Driver-internal flush (correlate work-queue entries → handles)
 *   - Diagnostic tooling (dump handle state for a refId in a log line)
 */
export function lookup(refId) {
    return HANDLES.get(refId);
}
/**
 * Drop a handle from the registry. Idempotent — calling on an already-
 * removed refId is a no-op (matches `Map.delete` semantics; useful when
 * cleanup may race between executor disposal and the driver's own
 * post-terminal cleanup).
 */
export function unregister(refId) {
    HANDLES.delete(refId);
}
/**
 * Diagnostic — total live handles. Use sparingly; calling this on hot
 * paths defeats the registry's "cheap insert/lookup" goal.
 */
export function size() {
    return HANDLES.size;
}
/**
 * Diagnostic — every live refId. Use for "what's still in flight?"
 * dumps during executor disposal or oncall debugging.
 */
export function ids() {
    return [...HANDLES.keys()];
}
/**
 * Test-only — wipe every entry. NEVER call from production code; that
 * would orphan in-flight work without a chance to drain.
 */
export function _resetForTests() {
    HANDLES.clear();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVnaXN0cnkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2RldGFjaC9yZWdpc3RyeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXFDRztBQUlILHFFQUFxRTtBQUNyRSxxREFBcUQ7QUFDckQsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLEVBQXdCLENBQUM7QUFFaEQ7Ozs7Ozs7OztHQVNHO0FBQ0gsTUFBTSxVQUFVLFFBQVEsQ0FBQyxNQUFvQjtJQUMzQyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLEVBQUUsTUFBTSxDQUFDLENBQUM7QUFDakMsQ0FBQztBQUVEOzs7Ozs7OztHQVFHO0FBQ0gsTUFBTSxVQUFVLE1BQU0sQ0FBQyxLQUFhO0lBQ2xDLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUM1QixDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUsVUFBVSxDQUFDLEtBQWE7SUFDdEMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUN4QixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLElBQUk7SUFDbEIsT0FBTyxPQUFPLENBQUMsSUFBSSxDQUFDO0FBQ3RCLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsR0FBRztJQUNqQixPQUFPLENBQUMsR0FBRyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztBQUM3QixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLGNBQWM7SUFDNUIsT0FBTyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQ2xCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGRldGFjaC9yZWdpc3RyeS50cyDigJQgUHJvY2Vzcy1zaW5nbGV0b24gaGFuZGxlIHJlZ2lzdHJ5LlxuICpcbiAqIFBhdHRlcm46ICBSZWdpc3RyeSAoR29GKS4gU2FtZSBzaGFwZSBhcyB0aGUgY2FjaGUgc3RyYXRlZ3kgcmVnaXN0cnlcbiAqICAgICAgICAgICBpbiBhZ2VudGZvb3RwcmludCB2Mi42IOKAlCBhIE1hcCBrZXllZCBieSBzdGFibGUgc3RyaW5nIGlkLlxuICogUm9sZTogICAgIEdsdWUgYmV0d2VlbiBkcml2ZXJzIGFuZCBleGVjdXRvcnMuIFdoZW4gYSBkcml2ZXIgc2NoZWR1bGVzXG4gKiAgICAgICAgICAgd29yayBpdCBgcmVnaXN0ZXJgcyB0aGUgaGFuZGxlIGhlcmU7IGxhdGVyIChkdXJpbmcgZXhlY3V0b3JcbiAqICAgICAgICAgICBkaXNwb3NhbCwgb3IgZm9yIGRpYWdub3N0aWNzKSBjb25zdW1lcnMgYGxvb2t1cGAgYnkgcmVmSWQuXG4gKlxuICogV2h5IGEgc2luZ2xldG9uP1xuICogICAtIHJlZklkcyBhcmUgbWludGVkIHBlciBkZXRhY2ggY2FsbCBhbmQgYXJlIHVuaXF1ZSBhY3Jvc3MgdGhlXG4gKiAgICAgcHJvY2VzcyBsaWZldGltZSAoZHJpdmVyIG5hbWUgKyBtb25vdG9uaWMgY291bnRlcilcbiAqICAgLSBoYW5kbGVzIG5lZWQgdG8gYmUgY2xlYW5hYmxlIGZyb20gTVVMVElQTEUgY2FsbCBzaXRlcyAoZXhlY3V0b3JcbiAqICAgICBkaXNwb3NhbCwgZHJpdmVyLWludGVybmFsIGZsdXNoLCB0ZXN0IGNsZWFudXApIHdpdGhvdXQgZWFjaCBvbmVcbiAqICAgICBoYXZpbmcgdG8gdGhyZWFkIGEgUmVnaXN0cnkgaW5zdGFuY2UgdGhyb3VnaCB0ZW4gbGF5ZXJzXG4gKiAgIC0gb25lLXNvdXJjZS1vZi10cnV0aCBzaW1wbGlmaWVzIFwiaXMgdGhpcyBoYW5kbGUgc3RpbGwgYWxpdmU/XCJcbiAqICAgICBxdWVyaWVzIGR1cmluZyBkZWJ1Z2dpbmdcbiAqXG4gKiBXaHkgTk9UIGEgY2xhc3MgaW5zdGFuY2UgcGVyIGV4ZWN1dG9yP1xuICogICAtIGRyaXZlcnMgKGUuZy4sIGBtaWNyb3Rhc2tCYXRjaERyaXZlcmApIGFyZSBQUk9DRVNTLXdpZGUgKG9uZSBxdWV1ZVxuICogICAgIHBlciBkcml2ZXIsIHNoYXJlZCBieSBldmVyeSBleGVjdXRvcikuIFR5aW5nIHJlZ2lzdHJ5IHRvIGV4ZWN1dG9yXG4gKiAgICAgd291bGQgZm9yY2UgcGVyLWV4ZWN1dG9yIGRyaXZlciBpbnN0YW5jZXMsIG11bHRpcGx5aW5nIHRoZSBxdWV1ZVxuICogICAgIGNvdW50IGFuZCBicmVha2luZyB0aGUgYmF0Y2gtYW1vcnRpemF0aW9uIHRoZSBkcml2ZXJzIGV4aXN0IGZvci5cbiAqXG4gKiBDbGVhbnVwIGNvbnRyYWN0OlxuICogICAtIERyaXZlcnMgY2FsbCBgcmVnaXN0ZXIoaGFuZGxlKWAgc3luY2hyb25vdXNseSBpbnNpZGUgYHNjaGVkdWxlKClgXG4gKiAgIC0gRHJpdmVycyAob3IgZXhlY3V0b3IgZGlzcG9zYWwpIGNhbGwgYHVucmVnaXN0ZXIocmVmSWQpYCBvbmNlIHRoZVxuICogICAgIGhhbmRsZSBpcyB0ZXJtaW5hbCBBTkQgdGhlIGNvbnN1bWVyIGhhcyBoYWQgYSBjaGFuY2UgdG8gb2JzZXJ2ZSBpdFxuICogICAtIGBfcmVzZXRGb3JUZXN0cygpYCBjbGVhcnMgZXZlcnkgZW50cnkg4oCUIHRlc3RzIG9ubHlcbiAqXG4gKiBDYXBhY2l0eTpcbiAqICAgLSBObyB1cHBlciBib3VuZC4gVGhlIGhhbmRsZSBvYmplY3RzIGFyZSB0aW55ICh+NiBmaWVsZHMpLiBBIGxvbmctXG4gKiAgICAgcnVubmluZyBwcm9jZXNzIHRoYXQgZGV0YWNoZXMgYSBtaWxsaW9uIHVuaXRzIFdJVEhPVVQgY2xlYW51cFxuICogICAgIHdvdWxkIGxlYWsgfjUwIE1CIOKAlCBhY2NlcHRhYmxlIGZvciB2MSwgc2luY2UgZHJpdmVycyBBUkUgdGhlXG4gKiAgICAgY2xlYW51cCBzaXRlLiBJZiByZWFsLXdvcmxkIHByb2dyYW1zIGhpdCB0aGUgbGltaXQsIGFkZCBhXG4gKiAgICAgc2xpZGluZy13aW5kb3cgY2FwIHdpdGggdGVsZW1ldHJ5IGhvb2sgKG1pcnJvcnNcbiAqICAgICBgTElWRV9TVEFUVVNfTE9HX0NBUGAgaW4gYWdlbnRmb290cHJpbnQpLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRGV0YWNoSGFuZGxlIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIFByb2Nlc3Mtd2lkZSBzaW5nbGV0b24uIE1hcCBwcmVzZXJ2ZXMgaW5zZXJ0aW9uIG9yZGVyIOKAlCB1c2VmdWwgZm9yXG4vLyBkaWFnbm9zdGljIGR1bXBzIHRoYXQgd2FudCBjaHJvbm9sb2dpY2FsIG9yZGVyaW5nLlxuY29uc3QgSEFORExFUyA9IG5ldyBNYXA8c3RyaW5nLCBEZXRhY2hIYW5kbGU+KCk7XG5cbi8qKlxuICogUmVnaXN0ZXIgYSBmcmVzaGx5LW1pbnRlZCBoYW5kbGUuIERyaXZlcnMgTVVTVCBjYWxsIHRoaXMgc3luY2hyb25vdXNseVxuICogaW5zaWRlIGBzY2hlZHVsZSgpYCBzbyB0aGUgaGFuZGxlIGlzIG9ic2VydmFibGUgZnJvbSB0aGUgbW9tZW50IGl0XG4gKiBleGlzdHMuXG4gKlxuICogUmVwbGFjaW5nIGFuIGV4aXN0aW5nIHJlZ2lzdHJhdGlvbiBpcyB0cmVhdGVkIGFzIGEgcHJvZ3JhbW1pbmcgZXJyb3JcbiAqIChyZWZJZHMgYXJlIHN1cHBvc2VkIHRvIGJlIHVuaXF1ZSkuIFdlIGRvbid0IHRocm93IOKAlCBzaWxlbnQgb3ZlcndyaXRlXG4gKiBjb3VsZCBtYXNrIGEgYnVnLCBidXQgdGhyb3dpbmcgaW5zaWRlIGEgZHJpdmVyJ3MgaG90IHBhdGggY291bGQgY2FzY2FkZVxuICogaW50byB0aGUgcGFyZW50IHN0YWdlLiBDb21wcm9taXNlOiB3YXJuIGluIGRldiBtb2RlLCBvdmVyd3JpdGUgYWx3YXlzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXIoaGFuZGxlOiBEZXRhY2hIYW5kbGUpOiB2b2lkIHtcbiAgSEFORExFUy5zZXQoaGFuZGxlLmlkLCBoYW5kbGUpO1xufVxuXG4vKipcbiAqIExvb2sgdXAgYSBoYW5kbGUgYnkgcmVmSWQuIFJldHVybnMgYHVuZGVmaW5lZGAgZm9yIHVua25vd24gaWRzIOKAlCB0aGVcbiAqIGNhbGxlciBkZWNpZGVzIHdoZXRoZXIgdGhhdCdzIGFuIGVycm9yIG9yIGp1c3QgYSBzdGFsZSByZWZlcmVuY2UuXG4gKlxuICogVXNlZCBieTpcbiAqICAgLSBFeGVjdXRvciBkaXNwb3NhbCAoZmluZCBoYW5kbGVzIHRvIG1hcmsgY2FuY2VsbGVkIC8gZHJhaW4pXG4gKiAgIC0gRHJpdmVyLWludGVybmFsIGZsdXNoIChjb3JyZWxhdGUgd29yay1xdWV1ZSBlbnRyaWVzIOKGkiBoYW5kbGVzKVxuICogICAtIERpYWdub3N0aWMgdG9vbGluZyAoZHVtcCBoYW5kbGUgc3RhdGUgZm9yIGEgcmVmSWQgaW4gYSBsb2cgbGluZSlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2t1cChyZWZJZDogc3RyaW5nKTogRGV0YWNoSGFuZGxlIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIEhBTkRMRVMuZ2V0KHJlZklkKTtcbn1cblxuLyoqXG4gKiBEcm9wIGEgaGFuZGxlIGZyb20gdGhlIHJlZ2lzdHJ5LiBJZGVtcG90ZW50IOKAlCBjYWxsaW5nIG9uIGFuIGFscmVhZHktXG4gKiByZW1vdmVkIHJlZklkIGlzIGEgbm8tb3AgKG1hdGNoZXMgYE1hcC5kZWxldGVgIHNlbWFudGljczsgdXNlZnVsIHdoZW5cbiAqIGNsZWFudXAgbWF5IHJhY2UgYmV0d2VlbiBleGVjdXRvciBkaXNwb3NhbCBhbmQgdGhlIGRyaXZlcidzIG93blxuICogcG9zdC10ZXJtaW5hbCBjbGVhbnVwKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVucmVnaXN0ZXIocmVmSWQ6IHN0cmluZyk6IHZvaWQge1xuICBIQU5ETEVTLmRlbGV0ZShyZWZJZCk7XG59XG5cbi8qKlxuICogRGlhZ25vc3RpYyDigJQgdG90YWwgbGl2ZSBoYW5kbGVzLiBVc2Ugc3BhcmluZ2x5OyBjYWxsaW5nIHRoaXMgb24gaG90XG4gKiBwYXRocyBkZWZlYXRzIHRoZSByZWdpc3RyeSdzIFwiY2hlYXAgaW5zZXJ0L2xvb2t1cFwiIGdvYWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaXplKCk6IG51bWJlciB7XG4gIHJldHVybiBIQU5ETEVTLnNpemU7XG59XG5cbi8qKlxuICogRGlhZ25vc3RpYyDigJQgZXZlcnkgbGl2ZSByZWZJZC4gVXNlIGZvciBcIndoYXQncyBzdGlsbCBpbiBmbGlnaHQ/XCJcbiAqIGR1bXBzIGR1cmluZyBleGVjdXRvciBkaXNwb3NhbCBvciBvbmNhbGwgZGVidWdnaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaWRzKCk6IHJlYWRvbmx5IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFsuLi5IQU5ETEVTLmtleXMoKV07XG59XG5cbi8qKlxuICogVGVzdC1vbmx5IOKAlCB3aXBlIGV2ZXJ5IGVudHJ5LiBORVZFUiBjYWxsIGZyb20gcHJvZHVjdGlvbiBjb2RlOyB0aGF0XG4gKiB3b3VsZCBvcnBoYW4gaW4tZmxpZ2h0IHdvcmsgd2l0aG91dCBhIGNoYW5jZSB0byBkcmFpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNldEZvclRlc3RzKCk6IHZvaWQge1xuICBIQU5ETEVTLmNsZWFyKCk7XG59XG4iXX0=