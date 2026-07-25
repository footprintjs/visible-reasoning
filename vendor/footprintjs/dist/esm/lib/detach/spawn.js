/**
 * detach/spawn.ts — One-call detach primitive used by both scope and
 * executor surfaces.
 *
 * Pattern:  Facade (GoF). Hides driver invocation + refId minting +
 *           registry registration behind two named functions
 *           (`detachAndJoinLater`, `detachAndForget`). Same helper is
 *           called from `scope.$detachAndJoinLater(...)` and from
 *           `executor.detachAndJoinLater(...)` — single source of truth.
 *
 * Why a separate module:
 *   - Avoids duplicating the "validate driver, mint refId, call schedule"
 *     sequence in both scope and executor entry points
 *   - Keeps the scope/executor files free of driver knowledge — they
 *     just call this and forward the result
 *
 * refId scheme:
 *   - When the caller is a stage (scope path): refId = `${runtimeStageId}:detach:${counter}`
 *     — the runtimeStageId prefix lets diagnostics correlate the handle
 *     back to the source stage
 *   - When the caller is bare executor (executor path):
 *     refId = `__executor__:detach:${counter}` — uniform "no source stage"
 *     marker
 *   - Counter is module-private + monotonic for the process lifetime —
 *     safe across re-entrant detach calls
 */
let counter = 0;
/** Reset the counter for tests — never call from production code. */
export function _resetSpawnCounterForTests() {
    counter = 0;
}
/**
 * Mint a refId. Format: `${prefix}:detach:${counter}`. The prefix carries
 * source-stage provenance (or `__executor__` when there is none).
 */
function mintRefId(prefix) {
    counter += 1;
    return `${prefix}:detach:${counter}`;
}
/**
 * Schedule `child` on the given driver, with the consumer's `input`,
 * and return the resulting `DetachHandle`. Callers can `wait()` on it,
 * read its `.status` property, or just hold the reference for later.
 *
 * **Joinable variant** — the caller wants to be able to await the result
 * (or check its status). The `forget` variant simply discards the handle.
 *
 * @param driver - The driver implementation to use. Required (no
 *   library-default — passing it explicitly avoids global state and
 *   keeps the engine free of driver imports).
 * @param child - The child flowchart to run.
 * @param input - The input to hand to the child's run() call.
 * @param sourcePrefix - Refix prefix for the minted refId; pass the
 *   parent's `runtimeStageId` from a stage caller, or `'__executor__'`
 *   from a bare-executor caller.
 */
export function detachAndJoinLater(driver, child, input, sourcePrefix) {
    if (!driver || typeof driver.schedule !== 'function') {
        throw new TypeError(`[detach] expected a DetachDriver as the first argument; got ${typeof driver}. ` +
            "Pass e.g. `microtaskBatchDriver` from 'footprintjs/detach'.");
    }
    const refId = mintRefId(sourcePrefix);
    return driver.schedule(child, input, refId);
}
/**
 * Same as `detachAndJoinLater` but discards the handle. Use when the
 * caller doesn't care about the result and doesn't need to await — e.g.,
 * fire-and-forget telemetry exports.
 *
 * The handle still exists internally (driver creates it, registry holds
 * it briefly) — but the caller cannot reference it. This is intentional:
 * having no handle reference is what gives "forget" its semantic — there
 * is no chance of the caller accidentally awaiting it.
 *
 * Errors raised by the child are STILL routed to the handle's failed
 * state (the driver does that). They just go unobserved unless something
 * else (a recorder, logging) is wired to surface them. See the docs in
 * T7 for recommended observability patterns for "forget" detach.
 */
export function detachAndForget(driver, child, input, sourcePrefix) {
    // Reuse the joinable path — the caller just chooses not to keep the
    // returned handle. We don't even bind it to a variable to make the
    // "forget" semantic explicit at the call site.
    detachAndJoinLater(driver, child, input, sourcePrefix);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3Bhd24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2RldGFjaC9zcGF3bi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXlCRztBQUtILElBQUksT0FBTyxHQUFHLENBQUMsQ0FBQztBQUVoQixxRUFBcUU7QUFDckUsTUFBTSxVQUFVLDBCQUEwQjtJQUN4QyxPQUFPLEdBQUcsQ0FBQyxDQUFDO0FBQ2QsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMsU0FBUyxDQUFDLE1BQWM7SUFDL0IsT0FBTyxJQUFJLENBQUMsQ0FBQztJQUNiLE9BQU8sR0FBRyxNQUFNLFdBQVcsT0FBTyxFQUFFLENBQUM7QUFDdkMsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7Ozs7O0dBZ0JHO0FBQ0gsTUFBTSxVQUFVLGtCQUFrQixDQUNoQyxNQUFvQixFQUNwQixLQUFnQixFQUNoQixLQUFjLEVBQ2QsWUFBb0I7SUFFcEIsSUFBSSxDQUFDLE1BQU0sSUFBSSxPQUFPLE1BQU0sQ0FBQyxRQUFRLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDckQsTUFBTSxJQUFJLFNBQVMsQ0FDakIsK0RBQStELE9BQU8sTUFBTSxJQUFJO1lBQzlFLDZEQUE2RCxDQUNoRSxDQUFDO0lBQ0osQ0FBQztJQUNELE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUN0QyxPQUFPLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztBQUM5QyxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7O0dBY0c7QUFDSCxNQUFNLFVBQVUsZUFBZSxDQUFDLE1BQW9CLEVBQUUsS0FBZ0IsRUFBRSxLQUFjLEVBQUUsWUFBb0I7SUFDMUcsb0VBQW9FO0lBQ3BFLG1FQUFtRTtJQUNuRSwrQ0FBK0M7SUFDL0Msa0JBQWtCLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsWUFBWSxDQUFDLENBQUM7QUFDekQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGV0YWNoL3NwYXduLnRzIOKAlCBPbmUtY2FsbCBkZXRhY2ggcHJpbWl0aXZlIHVzZWQgYnkgYm90aCBzY29wZSBhbmRcbiAqIGV4ZWN1dG9yIHN1cmZhY2VzLlxuICpcbiAqIFBhdHRlcm46ICBGYWNhZGUgKEdvRikuIEhpZGVzIGRyaXZlciBpbnZvY2F0aW9uICsgcmVmSWQgbWludGluZyArXG4gKiAgICAgICAgICAgcmVnaXN0cnkgcmVnaXN0cmF0aW9uIGJlaGluZCB0d28gbmFtZWQgZnVuY3Rpb25zXG4gKiAgICAgICAgICAgKGBkZXRhY2hBbmRKb2luTGF0ZXJgLCBgZGV0YWNoQW5kRm9yZ2V0YCkuIFNhbWUgaGVscGVyIGlzXG4gKiAgICAgICAgICAgY2FsbGVkIGZyb20gYHNjb3BlLiRkZXRhY2hBbmRKb2luTGF0ZXIoLi4uKWAgYW5kIGZyb21cbiAqICAgICAgICAgICBgZXhlY3V0b3IuZGV0YWNoQW5kSm9pbkxhdGVyKC4uLilgIOKAlCBzaW5nbGUgc291cmNlIG9mIHRydXRoLlxuICpcbiAqIFdoeSBhIHNlcGFyYXRlIG1vZHVsZTpcbiAqICAgLSBBdm9pZHMgZHVwbGljYXRpbmcgdGhlIFwidmFsaWRhdGUgZHJpdmVyLCBtaW50IHJlZklkLCBjYWxsIHNjaGVkdWxlXCJcbiAqICAgICBzZXF1ZW5jZSBpbiBib3RoIHNjb3BlIGFuZCBleGVjdXRvciBlbnRyeSBwb2ludHNcbiAqICAgLSBLZWVwcyB0aGUgc2NvcGUvZXhlY3V0b3IgZmlsZXMgZnJlZSBvZiBkcml2ZXIga25vd2xlZGdlIOKAlCB0aGV5XG4gKiAgICAganVzdCBjYWxsIHRoaXMgYW5kIGZvcndhcmQgdGhlIHJlc3VsdFxuICpcbiAqIHJlZklkIHNjaGVtZTpcbiAqICAgLSBXaGVuIHRoZSBjYWxsZXIgaXMgYSBzdGFnZSAoc2NvcGUgcGF0aCk6IHJlZklkID0gYCR7cnVudGltZVN0YWdlSWR9OmRldGFjaDoke2NvdW50ZXJ9YFxuICogICAgIOKAlCB0aGUgcnVudGltZVN0YWdlSWQgcHJlZml4IGxldHMgZGlhZ25vc3RpY3MgY29ycmVsYXRlIHRoZSBoYW5kbGVcbiAqICAgICBiYWNrIHRvIHRoZSBzb3VyY2Ugc3RhZ2VcbiAqICAgLSBXaGVuIHRoZSBjYWxsZXIgaXMgYmFyZSBleGVjdXRvciAoZXhlY3V0b3IgcGF0aCk6XG4gKiAgICAgcmVmSWQgPSBgX19leGVjdXRvcl9fOmRldGFjaDoke2NvdW50ZXJ9YCDigJQgdW5pZm9ybSBcIm5vIHNvdXJjZSBzdGFnZVwiXG4gKiAgICAgbWFya2VyXG4gKiAgIC0gQ291bnRlciBpcyBtb2R1bGUtcHJpdmF0ZSArIG1vbm90b25pYyBmb3IgdGhlIHByb2Nlc3MgbGlmZXRpbWUg4oCUXG4gKiAgICAgc2FmZSBhY3Jvc3MgcmUtZW50cmFudCBkZXRhY2ggY2FsbHNcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZsb3dDaGFydCB9IGZyb20gJy4uL2J1aWxkZXIvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBEZXRhY2hEcml2ZXIsIERldGFjaEhhbmRsZSB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5sZXQgY291bnRlciA9IDA7XG5cbi8qKiBSZXNldCB0aGUgY291bnRlciBmb3IgdGVzdHMg4oCUIG5ldmVyIGNhbGwgZnJvbSBwcm9kdWN0aW9uIGNvZGUuICovXG5leHBvcnQgZnVuY3Rpb24gX3Jlc2V0U3Bhd25Db3VudGVyRm9yVGVzdHMoKTogdm9pZCB7XG4gIGNvdW50ZXIgPSAwO1xufVxuXG4vKipcbiAqIE1pbnQgYSByZWZJZC4gRm9ybWF0OiBgJHtwcmVmaXh9OmRldGFjaDoke2NvdW50ZXJ9YC4gVGhlIHByZWZpeCBjYXJyaWVzXG4gKiBzb3VyY2Utc3RhZ2UgcHJvdmVuYW5jZSAob3IgYF9fZXhlY3V0b3JfX2Agd2hlbiB0aGVyZSBpcyBub25lKS5cbiAqL1xuZnVuY3Rpb24gbWludFJlZklkKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY291bnRlciArPSAxO1xuICByZXR1cm4gYCR7cHJlZml4fTpkZXRhY2g6JHtjb3VudGVyfWA7XG59XG5cbi8qKlxuICogU2NoZWR1bGUgYGNoaWxkYCBvbiB0aGUgZ2l2ZW4gZHJpdmVyLCB3aXRoIHRoZSBjb25zdW1lcidzIGBpbnB1dGAsXG4gKiBhbmQgcmV0dXJuIHRoZSByZXN1bHRpbmcgYERldGFjaEhhbmRsZWAuIENhbGxlcnMgY2FuIGB3YWl0KClgIG9uIGl0LFxuICogcmVhZCBpdHMgYC5zdGF0dXNgIHByb3BlcnR5LCBvciBqdXN0IGhvbGQgdGhlIHJlZmVyZW5jZSBmb3IgbGF0ZXIuXG4gKlxuICogKipKb2luYWJsZSB2YXJpYW50Kiog4oCUIHRoZSBjYWxsZXIgd2FudHMgdG8gYmUgYWJsZSB0byBhd2FpdCB0aGUgcmVzdWx0XG4gKiAob3IgY2hlY2sgaXRzIHN0YXR1cykuIFRoZSBgZm9yZ2V0YCB2YXJpYW50IHNpbXBseSBkaXNjYXJkcyB0aGUgaGFuZGxlLlxuICpcbiAqIEBwYXJhbSBkcml2ZXIgLSBUaGUgZHJpdmVyIGltcGxlbWVudGF0aW9uIHRvIHVzZS4gUmVxdWlyZWQgKG5vXG4gKiAgIGxpYnJhcnktZGVmYXVsdCDigJQgcGFzc2luZyBpdCBleHBsaWNpdGx5IGF2b2lkcyBnbG9iYWwgc3RhdGUgYW5kXG4gKiAgIGtlZXBzIHRoZSBlbmdpbmUgZnJlZSBvZiBkcml2ZXIgaW1wb3J0cykuXG4gKiBAcGFyYW0gY2hpbGQgLSBUaGUgY2hpbGQgZmxvd2NoYXJ0IHRvIHJ1bi5cbiAqIEBwYXJhbSBpbnB1dCAtIFRoZSBpbnB1dCB0byBoYW5kIHRvIHRoZSBjaGlsZCdzIHJ1bigpIGNhbGwuXG4gKiBAcGFyYW0gc291cmNlUHJlZml4IC0gUmVmaXggcHJlZml4IGZvciB0aGUgbWludGVkIHJlZklkOyBwYXNzIHRoZVxuICogICBwYXJlbnQncyBgcnVudGltZVN0YWdlSWRgIGZyb20gYSBzdGFnZSBjYWxsZXIsIG9yIGAnX19leGVjdXRvcl9fJ2BcbiAqICAgZnJvbSBhIGJhcmUtZXhlY3V0b3IgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0YWNoQW5kSm9pbkxhdGVyKFxuICBkcml2ZXI6IERldGFjaERyaXZlcixcbiAgY2hpbGQ6IEZsb3dDaGFydCxcbiAgaW5wdXQ6IHVua25vd24sXG4gIHNvdXJjZVByZWZpeDogc3RyaW5nLFxuKTogRGV0YWNoSGFuZGxlIHtcbiAgaWYgKCFkcml2ZXIgfHwgdHlwZW9mIGRyaXZlci5zY2hlZHVsZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICBgW2RldGFjaF0gZXhwZWN0ZWQgYSBEZXRhY2hEcml2ZXIgYXMgdGhlIGZpcnN0IGFyZ3VtZW50OyBnb3QgJHt0eXBlb2YgZHJpdmVyfS4gYCArXG4gICAgICAgIFwiUGFzcyBlLmcuIGBtaWNyb3Rhc2tCYXRjaERyaXZlcmAgZnJvbSAnZm9vdHByaW50anMvZGV0YWNoJy5cIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJlZklkID0gbWludFJlZklkKHNvdXJjZVByZWZpeCk7XG4gIHJldHVybiBkcml2ZXIuc2NoZWR1bGUoY2hpbGQsIGlucHV0LCByZWZJZCk7XG59XG5cbi8qKlxuICogU2FtZSBhcyBgZGV0YWNoQW5kSm9pbkxhdGVyYCBidXQgZGlzY2FyZHMgdGhlIGhhbmRsZS4gVXNlIHdoZW4gdGhlXG4gKiBjYWxsZXIgZG9lc24ndCBjYXJlIGFib3V0IHRoZSByZXN1bHQgYW5kIGRvZXNuJ3QgbmVlZCB0byBhd2FpdCDigJQgZS5nLixcbiAqIGZpcmUtYW5kLWZvcmdldCB0ZWxlbWV0cnkgZXhwb3J0cy5cbiAqXG4gKiBUaGUgaGFuZGxlIHN0aWxsIGV4aXN0cyBpbnRlcm5hbGx5IChkcml2ZXIgY3JlYXRlcyBpdCwgcmVnaXN0cnkgaG9sZHNcbiAqIGl0IGJyaWVmbHkpIOKAlCBidXQgdGhlIGNhbGxlciBjYW5ub3QgcmVmZXJlbmNlIGl0LiBUaGlzIGlzIGludGVudGlvbmFsOlxuICogaGF2aW5nIG5vIGhhbmRsZSByZWZlcmVuY2UgaXMgd2hhdCBnaXZlcyBcImZvcmdldFwiIGl0cyBzZW1hbnRpYyDigJQgdGhlcmVcbiAqIGlzIG5vIGNoYW5jZSBvZiB0aGUgY2FsbGVyIGFjY2lkZW50YWxseSBhd2FpdGluZyBpdC5cbiAqXG4gKiBFcnJvcnMgcmFpc2VkIGJ5IHRoZSBjaGlsZCBhcmUgU1RJTEwgcm91dGVkIHRvIHRoZSBoYW5kbGUncyBmYWlsZWRcbiAqIHN0YXRlICh0aGUgZHJpdmVyIGRvZXMgdGhhdCkuIFRoZXkganVzdCBnbyB1bm9ic2VydmVkIHVubGVzcyBzb21ldGhpbmdcbiAqIGVsc2UgKGEgcmVjb3JkZXIsIGxvZ2dpbmcpIGlzIHdpcmVkIHRvIHN1cmZhY2UgdGhlbS4gU2VlIHRoZSBkb2NzIGluXG4gKiBUNyBmb3IgcmVjb21tZW5kZWQgb2JzZXJ2YWJpbGl0eSBwYXR0ZXJucyBmb3IgXCJmb3JnZXRcIiBkZXRhY2guXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRhY2hBbmRGb3JnZXQoZHJpdmVyOiBEZXRhY2hEcml2ZXIsIGNoaWxkOiBGbG93Q2hhcnQsIGlucHV0OiB1bmtub3duLCBzb3VyY2VQcmVmaXg6IHN0cmluZyk6IHZvaWQge1xuICAvLyBSZXVzZSB0aGUgam9pbmFibGUgcGF0aCDigJQgdGhlIGNhbGxlciBqdXN0IGNob29zZXMgbm90IHRvIGtlZXAgdGhlXG4gIC8vIHJldHVybmVkIGhhbmRsZS4gV2UgZG9uJ3QgZXZlbiBiaW5kIGl0IHRvIGEgdmFyaWFibGUgdG8gbWFrZSB0aGVcbiAgLy8gXCJmb3JnZXRcIiBzZW1hbnRpYyBleHBsaWNpdCBhdCB0aGUgY2FsbCBzaXRlLlxuICBkZXRhY2hBbmRKb2luTGF0ZXIoZHJpdmVyLCBjaGlsZCwgaW5wdXQsIHNvdXJjZVByZWZpeCk7XG59XG4iXX0=