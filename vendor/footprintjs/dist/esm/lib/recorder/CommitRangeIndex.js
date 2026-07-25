/**
 * CommitRangeIndex<TLabel> — interval index over commit indices.
 *
 * Built incrementally during traversal: `open(label, startIdx)` when a
 * boundary begins, `close(token, endIdx)` when it ends. Query at any
 * commit position with `enclosing(idx)` (returns ranges containing
 * that index, ordered outer→inner) or `overlapping(start, end)`
 * (returns ranges intersecting a slice).
 *
 * See `docs/design/commit-range-index.md` for the full contract. In
 * one paragraph: this is a generic interval data structure for
 * commit-range queries. footprintjs owns ZERO knowledge of what
 * labels mean — consumers (agentfootprint, lens, OTel exporters)
 * pick their own `TLabel` type. Open ranges (mid-run, no end yet)
 * are first-class — query results carry `endIdx: undefined` for them.
 *
 * Pattern: incremental builder + interval query. Same "collect during
 *          traversal, never post-process" rule footprintjs's CLAUDE.md
 *          requires of every observer.
 * Role:    structural primitive for time-travel UIs and per-boundary
 *          aggregation.
 * Channel: consumer-driven (no engine subscription).
 *
 * @example
 * ```typescript
 * import { CommitRangeIndex } from 'footprintjs/trace';
 *
 * const idx = new CommitRangeIndex<string>();
 * const t = idx.open('LLMCall', executor.getCommitCount());
 * // ... LLM call runs, scope writes happen ...
 * idx.close(t, executor.getCommitCount());
 *
 * idx.enclosing(50);  // → ranges containing commit 50, outer→inner
 * idx.overlapping(40, 60);  // → ranges sharing the slice [40,60]
 * idx.clear();        // wipe (e.g., on new run)
 * ```
 *
 * REDACTION NOTE: labels are stored verbatim and returned verbatim in
 * query results — the index does NOT redact `TLabel` content. If a
 * consumer attaches a label containing PII (user email, scope reads
 * with sensitive keys, etc.) and then serializes the index for
 * logging or telemetry, that data leaves the trust boundary. Use
 * `RedactionPolicy` (or your own scrubbing) on the consumer side
 * BEFORE attaching labels. The index follows the same contract as
 * other footprintjs storage primitives (SequenceStore, KeyedStore):
 * storage is verbatim; redaction is the caller's responsibility.
 */
export class CommitRangeIndex {
    entries = [];
    byId = new Map();
    nextId = 0;
    /** Identity for token scoping — each index gets a fresh symbol so
     *  tokens from one index can't accidentally close ranges in another.
     *  ROTATED on `clear()` to invalidate stale tokens that survived a
     *  run reset (would otherwise hit a recycled id and silently mutate
     *  a different range — see DS+logic panel review RED #1). */
    owner = Symbol('CommitRangeIndex');
    /**
     * Open a new range. Returns a token the caller MUST hold and pass
     * to `close()` later. Each `open()` gets a fresh token; tokens
     * cannot be reused or shared across indices (silent no-op if
     * misused — see Law 2 in the design doc). Tokens from BEFORE
     * the most recent `clear()` are also invalid (owner symbol
     * rotates on clear).
     */
    open(label, startIdx) {
        const id = this.nextId++;
        const entry = {
            label,
            startIdx,
            endIdx: undefined,
            id,
            closed: false,
        };
        this.entries.push(entry);
        this.byId.set(id, entry);
        return { _id: id, _owner: this.owner };
    }
    /**
     * Close an open range at `endIdx` (inclusive). After close, the
     * range is queryable with both bounds. Closing an already-closed
     * token is a no-op. Closing an unknown token (from another index,
     * or fabricated) is a no-op.
     */
    close(token, endIdx) {
        if (token._owner !== this.owner)
            return; // cross-index misuse — silent no-op
        const entry = this.findById(token._id);
        if (!entry || entry.closed)
            return;
        entry.endIdx = endIdx;
        entry.closed = true;
    }
    /**
     * Returns ALL ranges enclosing `commitIdx`, ordered outer→inner.
     * Includes both closed and open ranges. For a closed range to
     * enclose: `startIdx <= commitIdx <= endIdx`. For an open range:
     * `startIdx <= commitIdx` (no upper bound check).
     *
     * Ordering rule: ascending by `startIdx`, with TIES BROKEN BY
     * descending `endIdx` (wider range = outer). Open ranges (endIdx
     * undefined) are treated as `+Infinity` for tie-break — they
     * always sort outer of any closed range starting at the same idx.
     * This is the only deterministic outer→inner ordering when two
     * boundaries open at the same commit (e.g., Parallel root +
     * its first branch).
     *
     * Returns a SHALLOW IMMUTABLE COPY — caller mutations don't affect
     * internal state.
     */
    enclosing(commitIdx) {
        const matches = [];
        for (const e of this.entries) {
            if (e.startIdx > commitIdx)
                continue;
            if (e.endIdx === undefined || e.endIdx >= commitIdx) {
                matches.push(toEntry(e));
            }
        }
        matches.sort(outerToInnerComparator);
        return matches;
    }
    /**
     * Returns all ranges OVERLAPPING the slice `[startIdx, endIdx]`. A
     * range overlaps if it shares at least one commit position with the
     * slice. Use for parallel-branch detection, time-window queries,
     * or "what boundaries fired during this slice."
     *
     * Sorted by the SAME outer→inner comparator as `enclosing()`:
     * ascending by `startIdx`, ties broken by descending `endIdx`
     * (wider = outer; open ranges treated as +Infinity).
     *
     * Returns a SHALLOW IMMUTABLE COPY.
     */
    overlapping(startIdx, endIdx) {
        const matches = [];
        for (const e of this.entries) {
            // Overlap test:
            //   range starts after slice ends → no overlap
            //   range ends (closed) before slice starts → no overlap
            //   otherwise → overlap (open ranges always overlap if they start <= endIdx)
            if (e.startIdx > endIdx)
                continue;
            if (e.endIdx !== undefined && e.endIdx < startIdx)
                continue;
            matches.push(toEntry(e));
        }
        matches.sort(outerToInnerComparator);
        return matches;
    }
    /** Total range count (open + closed). */
    get size() {
        return this.entries.length;
    }
    /**
     * Wipe all ranges + reset the token counter AND rotate the owner
     * symbol so any token from before this clear becomes invalid.
     * Critical: without rotating the owner, a stale token whose `_id`
     * happens to match a recycled id after clear would silently mutate
     * the wrong entry. Owner rotation makes stale-token close a no-op
     * via the `_owner !== this.owner` guard.
     *
     * Call from a consumer's runId guard when a new run starts (e.g.,
     * agentfootprint's `observeRunId(onNewRun)` from Phase 2).
     */
    clear() {
        this.entries.length = 0;
        this.byId.clear();
        this.nextId = 0;
        this.owner = Symbol('CommitRangeIndex');
    }
    // ─── Internals ────────────────────────────────────────────────────
    /** O(1) lookup by token id. Always returns the entry that the token
     *  references (or undefined if the id was never opened in this index). */
    findById(id) {
        return this.byId.get(id);
    }
}
/** Project the internal mutable shape into the public readonly entry.
 *  The OUTER object is a fresh allocation per query (so caller array
 *  mutations don't leak). The `label` field is a REFERENCE COPY —
 *  if `TLabel` is an object, mutating its fields will affect the
 *  internal entry too. Consumers MUST treat labels as immutable
 *  (or pass primitives). Documented in the class JSDoc as the
 *  "labels are stored verbatim" contract. */
function toEntry(e) {
    return e.endIdx === undefined
        ? { label: e.label, startIdx: e.startIdx }
        : { label: e.label, startIdx: e.startIdx, endIdx: e.endIdx };
}
/**
 * Shared outer→inner comparator for both `enclosing()` and
 * `overlapping()`. Primary key: `startIdx` ascending. Tie-break:
 * `endIdx` descending (wider range is outer). Open ranges (undefined
 * `endIdx`) sort as +Infinity → outermost when tied. Deterministic
 * ordering required so consumers (Lens breadcrumb, time-travel UIs)
 * never see flicker on equal-start boundaries (e.g., a Parallel
 * root and its first branch opening at the same commit).
 */
function outerToInnerComparator(a, b) {
    if (a.startIdx !== b.startIdx)
        return a.startIdx - b.startIdx;
    const ae = a.endIdx ?? Number.POSITIVE_INFINITY;
    const be = b.endIdx ?? Number.POSITIVE_INFINITY;
    return be - ae;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29tbWl0UmFuZ2VJbmRleC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVjb3JkZXIvQ29tbWl0UmFuZ2VJbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQThDRztBQTRDSCxNQUFNLE9BQU8sZ0JBQWdCO0lBQ25CLE9BQU8sR0FBNEIsRUFBRSxDQUFDO0lBQ3RDLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBaUMsQ0FBQztJQUNoRCxNQUFNLEdBQUcsQ0FBQyxDQUFDO0lBQ25COzs7O2lFQUk2RDtJQUNyRCxLQUFLLEdBQUcsTUFBTSxDQUFDLGtCQUFrQixDQUFDLENBQUM7SUFFM0M7Ozs7Ozs7T0FPRztJQUNILElBQUksQ0FBQyxLQUFhLEVBQUUsUUFBZ0I7UUFDbEMsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ3pCLE1BQU0sS0FBSyxHQUEwQjtZQUNuQyxLQUFLO1lBQ0wsUUFBUTtZQUNSLE1BQU0sRUFBRSxTQUFTO1lBQ2pCLEVBQUU7WUFDRixNQUFNLEVBQUUsS0FBSztTQUNkLENBQUM7UUFDRixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN6QixJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDekIsT0FBTyxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUN6QyxDQUFDO0lBRUQ7Ozs7O09BS0c7SUFDSCxLQUFLLENBQUMsS0FBaUIsRUFBRSxNQUFjO1FBQ3JDLElBQUksS0FBSyxDQUFDLE1BQU0sS0FBSyxJQUFJLENBQUMsS0FBSztZQUFFLE9BQU8sQ0FBQyxvQ0FBb0M7UUFDN0UsTUFBTSxLQUFLLEdBQUcsSUFB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QUFDLENBQUMsUUFBUSxLQUFLLENBQUMsQ0FBQyxRQUFRO1FBQUUsT0FBTyxDQUFDLENBQUMsUUFBUSxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUM7SUFDOUQsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsaUJBQWlCLENBQUM7SUFDaEQsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsaUJBQWlCLENBQUM7SUFDaEQsT0FBTyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBQ2pCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvbW1pdFJhbmdlSW5kZXg8VExhYmVsPiDigJQgaW50ZXJ2YWwgaW5kZXggb3ZlciBjb21taXQgaW5kaWNlcy5cbiAqXG4gKiBCdWlsdCBpbmNyZW1lbnRhbGx5IGR1cmluZyB0cmF2ZXJzYWw6IGBvcGVuKGxhYmVsLCBzdGFydElkeClgIHdoZW4gYVxuICogYm91bmRhcnkgYmVnaW5zLCBgY2xvc2UodG9rZW4sIGVuZElkeClgIHdoZW4gaXQgZW5kcy4gUXVlcnkgYXQgYW55XG4gKiBjb21taXQgcG9zaXRpb24gd2l0aCBgZW5jbG9zaW5nKGlkeClgIChyZXR1cm5zIHJhbmdlcyBjb250YWluaW5nXG4gKiB0aGF0IGluZGV4LCBvcmRlcmVkIG91dGVy4oaSaW5uZXIpIG9yIGBvdmVybGFwcGluZyhzdGFydCwgZW5kKWBcbiAqIChyZXR1cm5zIHJhbmdlcyBpbnRlcnNlY3RpbmcgYSBzbGljZSkuXG4gKlxuICogU2VlIGBkb2NzL2Rlc2lnbi9jb21taXQtcmFuZ2UtaW5kZXgubWRgIGZvciB0aGUgZnVsbCBjb250cmFjdC4gSW5cbiAqIG9uZSBwYXJhZ3JhcGg6IHRoaXMgaXMgYSBnZW5lcmljIGludGVydmFsIGRhdGEgc3RydWN0dXJlIGZvclxuICogY29tbWl0LXJhbmdlIHF1ZXJpZXMuIGZvb3RwcmludGpzIG93bnMgWkVSTyBrbm93bGVkZ2Ugb2Ygd2hhdFxuICogbGFiZWxzIG1lYW4g4oCUIGNvbnN1bWVycyAoYWdlbnRmb290cHJpbnQsIGxlbnMsIE9UZWwgZXhwb3J0ZXJzKVxuICogcGljayB0aGVpciBvd24gYFRMYWJlbGAgdHlwZS4gT3BlbiByYW5nZXMgKG1pZC1ydW4sIG5vIGVuZCB5ZXQpXG4gKiBhcmUgZmlyc3QtY2xhc3Mg4oCUIHF1ZXJ5IHJlc3VsdHMgY2FycnkgYGVuZElkeDogdW5kZWZpbmVkYCBmb3IgdGhlbS5cbiAqXG4gKiBQYXR0ZXJuOiBpbmNyZW1lbnRhbCBidWlsZGVyICsgaW50ZXJ2YWwgcXVlcnkuIFNhbWUgXCJjb2xsZWN0IGR1cmluZ1xuICogICAgICAgICAgdHJhdmVyc2FsLCBuZXZlciBwb3N0LXByb2Nlc3NcIiBydWxlIGZvb3RwcmludGpzJ3MgQ0xBVURFLm1kXG4gKiAgICAgICAgICByZXF1aXJlcyBvZiBldmVyeSBvYnNlcnZlci5cbiAqIFJvbGU6ICAgIHN0cnVjdHVyYWwgcHJpbWl0aXZlIGZvciB0aW1lLXRyYXZlbCBVSXMgYW5kIHBlci1ib3VuZGFyeVxuICogICAgICAgICAgYWdncmVnYXRpb24uXG4gKiBDaGFubmVsOiBjb25zdW1lci1kcml2ZW4gKG5vIGVuZ2luZSBzdWJzY3JpcHRpb24pLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBpbXBvcnQgeyBDb21taXRSYW5nZUluZGV4IH0gZnJvbSAnZm9vdHByaW50anMvdHJhY2UnO1xuICpcbiAqIGNvbnN0IGlkeCA9IG5ldyBDb21taXRSYW5nZUluZGV4PHN0cmluZz4oKTtcbiAqIGNvbnN0IHQgPSBpZHgub3BlbignTExNQ2FsbCcsIGV4ZWN1dG9yLmdldENvbW1pdENvdW50KCkpO1xuICogLy8gLi4uIExMTSBjYWxsIHJ1bnMsIHNjb3BlIHdyaXRlcyBoYXBwZW4gLi4uXG4gKiBpZHguY2xvc2UodCwgZXhlY3V0b3IuZ2V0Q29tbWl0Q291bnQoKSk7XG4gKlxuICogaWR4LmVuY2xvc2luZyg1MCk7ICAvLyDihpIgcmFuZ2VzIGNvbnRhaW5pbmcgY29tbWl0IDUwLCBvdXRlcuKGkmlubmVyXG4gKiBpZHgub3ZlcmxhcHBpbmcoNDAsIDYwKTsgIC8vIOKGkiByYW5nZXMgc2hhcmluZyB0aGUgc2xpY2UgWzQwLDYwXVxuICogaWR4LmNsZWFyKCk7ICAgICAgICAvLyB3aXBlIChlLmcuLCBvbiBuZXcgcnVuKVxuICogYGBgXG4gKlxuICogUkVEQUNUSU9OIE5PVEU6IGxhYmVscyBhcmUgc3RvcmVkIHZlcmJhdGltIGFuZCByZXR1cm5lZCB2ZXJiYXRpbSBpblxuICogcXVlcnkgcmVzdWx0cyDigJQgdGhlIGluZGV4IGRvZXMgTk9UIHJlZGFjdCBgVExhYmVsYCBjb250ZW50LiBJZiBhXG4gKiBjb25zdW1lciBhdHRhY2hlcyBhIGxhYmVsIGNvbnRhaW5pbmcgUElJICh1c2VyIGVtYWlsLCBzY29wZSByZWFkc1xuICogd2l0aCBzZW5zaXRpdmUga2V5cywgZXRjLikgYW5kIHRoZW4gc2VyaWFsaXplcyB0aGUgaW5kZXggZm9yXG4gKiBsb2dnaW5nIG9yIHRlbGVtZXRyeSwgdGhhdCBkYXRhIGxlYXZlcyB0aGUgdHJ1c3QgYm91bmRhcnkuIFVzZVxuICogYFJlZGFjdGlvblBvbGljeWAgKG9yIHlvdXIgb3duIHNjcnViYmluZykgb24gdGhlIGNvbnN1bWVyIHNpZGVcbiAqIEJFRk9SRSBhdHRhY2hpbmcgbGFiZWxzLiBUaGUgaW5kZXggZm9sbG93cyB0aGUgc2FtZSBjb250cmFjdCBhc1xuICogb3RoZXIgZm9vdHByaW50anMgc3RvcmFnZSBwcmltaXRpdmVzIChTZXF1ZW5jZVN0b3JlLCBLZXllZFN0b3JlKTpcbiAqIHN0b3JhZ2UgaXMgdmVyYmF0aW07IHJlZGFjdGlvbiBpcyB0aGUgY2FsbGVyJ3MgcmVzcG9uc2liaWxpdHkuXG4gKi9cblxuLyoqIE9wYXF1ZSB0b2tlbiBpZGVudGlmeWluZyBhbiBvcGVuIHJhbmdlLiBIb2xkIG9udG8gaXQ7IHBhc3MgdG8gYGNsb3NlKClgLlxuICogIEluZGV4LXNjb3BlZCDigJQgdXNpbmcgYSB0b2tlbiBmcm9tIG9uZSBDb21taXRSYW5nZUluZGV4IG9uIGFub3RoZXIgaXNcbiAqICBhIHNpbGVudCBuby1vcCAodmVyaWZpZWQgYnkgdGhlIHBlci1pbmRleCBgX293bmVyYCBzeW1ib2wpLlxuICpcbiAqICBTRUNVUklUWSBOT1RFOiB0aGUgYF9vd25lcmAgc3ltYm9sIGlzIGVudW1lcmFibGUgb24gdGhlIHRva2VuIG9iamVjdFxuICogIHZpYSBgT2JqZWN0LmdldE93blByb3BlcnR5U3ltYm9scyh0b2tlbilgLiBUaGlzIG1lYW5zIHRva2VucyBhcmUgTk9UXG4gKiAgYWR2ZXJzYXJ5LXNhZmUg4oCUIGEgbWFsaWNpb3VzIGNhbGxlciB3aXRoIGFjY2VzcyB0byBBTlkgdG9rZW4gZnJvbVxuICogIHRoaXMgaW5kZXggY2FuIHJlY292ZXIgdGhlIG93bmVyIHN5bWJvbCBhbmQgZm9yZ2UgbmV3IHRva2Vucy4gVGhlXG4gKiAgaW5kZXggaXMgZGVzaWduZWQgZm9yIGluLXByb2Nlc3MgdHJ1c3QgYm91bmRhcmllcyAoY29vcGVyYXRpdmVcbiAqICByZWNvcmRlcnMgc2hhcmluZyBvbmUgcnVubmVyKSwgbm90IGZvciBob3N0aWxlLWlucHV0IHNjZW5hcmlvcy5cbiAqICBJZiBhZHZlcnNhcnktc2FmZXR5IGJlY29tZXMgYSByZXF1aXJlbWVudCwgc3dpdGNoIHRvIGEgV2Vha01hcC1cbiAqICBzY29wZWQgdG9rZW4gbW9kZWwgKHNlZSBzZWN1cml0eSBwYW5lbCByZXZpZXcgWTIpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSYW5nZVRva2VuIHtcbiAgLyoqIFBlci1pbmRleCBzZXF1ZW50aWFsIGlkLiBPcGFxdWUgdG8gY29uc3VtZXJzIOKAlCB0aGV5IHNob3VsZG4ndCByZWFkIGl0LiAqL1xuICByZWFkb25seSBfaWQ6IG51bWJlcjtcbiAgLyoqIFBlci1pbmRleCBpZGVudGl0eSDigJQgcHJldmVudHMgYWNjaWRlbnRhbCBjcm9zcy1pbmRleCB0b2tlbiBtaXN1c2UuICovXG4gIHJlYWRvbmx5IF9vd25lcjogc3ltYm9sO1xufVxuXG4vKiogQSBzaW5nbGUgcmFuZ2UgYXMgcmV0dXJuZWQgYnkgcXVlcnkgbWV0aG9kcy4gRnJvemVuLXNoYXBlIOKAlCByZWFkb25seSBmaWVsZHMuICovXG5leHBvcnQgaW50ZXJmYWNlIFJhbmdlRW50cnk8VExhYmVsPiB7XG4gIHJlYWRvbmx5IGxhYmVsOiBUTGFiZWw7XG4gIHJlYWRvbmx5IHN0YXJ0SWR4OiBudW1iZXI7XG4gIC8qKiBVbmRlZmluZWQgd2hpbGUgdGhlIHJhbmdlIGlzIHN0aWxsIG9wZW4gKG1pZC1ydW4gYm91bmRhcnkpLiAqL1xuICByZWFkb25seSBlbmRJZHg/OiBudW1iZXI7XG59XG5cbi8qKlxuICogSW50ZXJuYWwgc3RvcmFnZSBzaGFwZS4gTXV0YWJsZSB3aGlsZSB0aGUgcmFuZ2UgaXMgb3Blbjsgb25jZVxuICogY2xvc2VkLCBgZW5kSWR4YCBpcyBzZXQgYW5kIG5ldmVyIGNoYW5nZXMuIFRva2VucyByZWZlcmVuY2UgdGhlc2VcbiAqIGJ5IHRoZWlyIHBvc2l0aW9uIGluIHRoZSBgZW50cmllc2AgYXJyYXkgKHRoZSBgX2lkYCkuXG4gKi9cbmludGVyZmFjZSBJbnRlcm5hbEVudHJ5PFRMYWJlbD4ge1xuICBsYWJlbDogVExhYmVsO1xuICBzdGFydElkeDogbnVtYmVyO1xuICBlbmRJZHg6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqIEludGVybmFsIGN1cnNvciDigJQgYXNzaWduZWQgb24gYG9wZW4oKWAsIHVzZWQgdG8gaWRlbnRpZnkgYnkgdG9rZW4uICovXG4gIGlkOiBudW1iZXI7XG4gIC8qKiBUcnVlIGFmdGVyIGBjbG9zZSgpYCBydW5zLiBQcmV2ZW50cyBkb3VibGUtY2xvc2UgbXV0YXRpb24uICovXG4gIGNsb3NlZDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGNsYXNzIENvbW1pdFJhbmdlSW5kZXg8VExhYmVsPiB7XG4gIHByaXZhdGUgZW50cmllczogSW50ZXJuYWxFbnRyeTxUTGFiZWw+W10gPSBbXTtcbiAgcHJpdmF0ZSBieUlkID0gbmV3IE1hcDxudW1iZXIsIEludGVybmFsRW50cnk8VExhYmVsPj4oKTtcbiAgcHJpdmF0ZSBuZXh0SWQgPSAwO1xuICAvKiogSWRlbnRpdHkgZm9yIHRva2VuIHNjb3Bpbmcg4oCUIGVhY2ggaW5kZXggZ2V0cyBhIGZyZXNoIHN5bWJvbCBzb1xuICAgKiAgdG9rZW5zIGZyb20gb25lIGluZGV4IGNhbid0IGFjY2lkZW50YWxseSBjbG9zZSByYW5nZXMgaW4gYW5vdGhlci5cbiAgICogIFJPVEFURUQgb24gYGNsZWFyKClgIHRvIGludmFsaWRhdGUgc3RhbGUgdG9rZW5zIHRoYXQgc3Vydml2ZWQgYVxuICAgKiAgcnVuIHJlc2V0ICh3b3VsZCBvdGhlcndpc2UgaGl0IGEgcmVjeWNsZWQgaWQgYW5kIHNpbGVudGx5IG11dGF0ZVxuICAgKiAgYSBkaWZmZXJlbnQgcmFuZ2Ug4oCUIHNlZSBEUytsb2dpYyBwYW5lbCByZXZpZXcgUkVEICMxKS4gKi9cbiAgcHJpdmF0ZSBvd25lciA9IFN5bWJvbCgnQ29tbWl0UmFuZ2VJbmRleCcpO1xuXG4gIC8qKlxuICAgKiBPcGVuIGEgbmV3IHJhbmdlLiBSZXR1cm5zIGEgdG9rZW4gdGhlIGNhbGxlciBNVVNUIGhvbGQgYW5kIHBhc3NcbiAgICogdG8gYGNsb3NlKClgIGxhdGVyLiBFYWNoIGBvcGVuKClgIGdldHMgYSBmcmVzaCB0b2tlbjsgdG9rZW5zXG4gICAqIGNhbm5vdCBiZSByZXVzZWQgb3Igc2hhcmVkIGFjcm9zcyBpbmRpY2VzIChzaWxlbnQgbm8tb3AgaWZcbiAgICogbWlzdXNlZCDigJQgc2VlIExhdyAyIGluIHRoZSBkZXNpZ24gZG9jKS4gVG9rZW5zIGZyb20gQkVGT1JFXG4gICAqIHRoZSBtb3N0IHJlY2VudCBgY2xlYXIoKWAgYXJlIGFsc28gaW52YWxpZCAob3duZXIgc3ltYm9sXG4gICAqIHJvdGF0ZXMgb24gY2xlYXIpLlxuICAgKi9cbiAgb3BlbihsYWJlbDogVExhYmVsLCBzdGFydElkeDogbnVtYmVyKTogUmFuZ2VUb2tlbiB7XG4gICAgY29uc3QgaWQgPSB0aGlzLm5leHRJZCsrO1xuICAgIGNvbnN0IGVudHJ5OiBJbnRlcm5hbEVudHJ5PFRMYWJlbD4gPSB7XG4gICAgICBsYWJlbCxcbiAgICAgIHN0YXJ0SWR4LFxuICAgICAgZW5kSWR4OiB1bmRlZmluZWQsXG4gICAgICBpZCxcbiAgICAgIGNsb3NlZDogZmFsc2UsXG4gICAgfTtcbiAgICB0aGlzLmVudHJpZXMucHVzaChlbnRyeSk7XG4gICAgdGhpcy5ieUlkLnNldChpZCwgZW50cnkpO1xuICAgIHJldHVybiB7IF9pZDogaWQsIF9vd25lcjogdGhpcy5vd25lciB9O1xuICB9XG5cbiAgLyoqXG4gICAqIENsb3NlIGFuIG9wZW4gcmFuZ2UgYXQgYGVuZElkeGAgKGluY2x1c2l2ZSkuIEFmdGVyIGNsb3NlLCB0aGVcbiAgICogcmFuZ2UgaXMgcXVlcnlhYmxlIHdpdGggYm90aCBib3VuZHMuIENsb3NpbmcgYW4gYWxyZWFkeS1jbG9zZWRcbiAgICogdG9rZW4gaXMgYSBuby1vcC4gQ2xvc2luZyBhbiB1bmtub3duIHRva2VuIChmcm9tIGFub3RoZXIgaW5kZXgsXG4gICAqIG9yIGZhYnJpY2F0ZWQpIGlzIGEgbm8tb3AuXG4gICAqL1xuICBjbG9zZSh0b2tlbjogUmFuZ2VUb2tlbiwgZW5kSWR4OiBudW1iZXIpOiB2b2lkIHtcbiAgICBpZiAodG9rZW4uX293bmVyICE9PSB0aGlzLm93bmVyKSByZXR1cm47IC8vIGNyb3NzLWluZGV4IG1pc3VzZSDigJQgc2lsZW50IG5vLW9wXG4gICAgY29uc3QgZW50cnkgPSB0aGlzLmZpbmRCeUlkKHRva2VuLl9pZCk7XG4gICAgaWYgKCFlbnRyeSB8fCBlbnRyeS5jbG9zZWQpIHJldHVybjtcbiAgICBlbnRyeS5lbmRJZHggPSBlbmRJZHg7XG4gICAgZW50cnkuY2xvc2VkID0gdHJ1ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIEFMTCByYW5nZXMgZW5jbG9zaW5nIGBjb21taXRJZHhgLCBvcmRlcmVkIG91dGVy4oaSaW5uZXIuXG4gICAqIEluY2x1ZGVzIGJvdGggY2xvc2VkIGFuZCBvcGVuIHJhbmdlcy4gRm9yIGEgY2xvc2VkIHJhbmdlIHRvXG4gICAqIGVuY2xvc2U6IGBzdGFydElkeCA8PSBjb21taXRJZHggPD0gZW5kSWR4YC4gRm9yIGFuIG9wZW4gcmFuZ2U6XG4gICAqIGBzdGFydElkeCA8PSBjb21taXRJZHhgIChubyB1cHBlciBib3VuZCBjaGVjaykuXG4gICAqXG4gICAqIE9yZGVyaW5nIHJ1bGU6IGFzY2VuZGluZyBieSBgc3RhcnRJZHhgLCB3aXRoIFRJRVMgQlJPS0VOIEJZXG4gICAqIGRlc2NlbmRpbmcgYGVuZElkeGAgKHdpZGVyIHJhbmdlID0gb3V0ZXIpLiBPcGVuIHJhbmdlcyAoZW5kSWR4XG4gICAqIHVuZGVmaW5lZCkgYXJlIHRyZWF0ZWQgYXMgYCtJbmZpbml0eWAgZm9yIHRpZS1icmVhayDigJQgdGhleVxuICAgKiBhbHdheXMgc29ydCBvdXRlciBvZiBhbnkgY2xvc2VkIHJhbmdlIHN0YXJ0aW5nIGF0IHRoZSBzYW1lIGlkeC5cbiAgICogVGhpcyBpcyB0aGUgb25seSBkZXRlcm1pbmlzdGljIG91dGVy4oaSaW5uZXIgb3JkZXJpbmcgd2hlbiB0d29cbiAgICogYm91bmRhcmllcyBvcGVuIGF0IHRoZSBzYW1lIGNvbW1pdCAoZS5nLiwgUGFyYWxsZWwgcm9vdCArXG4gICAqIGl0cyBmaXJzdCBicmFuY2gpLlxuICAgKlxuICAgKiBSZXR1cm5zIGEgU0hBTExPVyBJTU1VVEFCTEUgQ09QWSDigJQgY2FsbGVyIG11dGF0aW9ucyBkb24ndCBhZmZlY3RcbiAgICogaW50ZXJuYWwgc3RhdGUuXG4gICAqL1xuICBlbmNsb3NpbmcoY29tbWl0SWR4OiBudW1iZXIpOiByZWFkb25seSBSYW5nZUVudHJ5PFRMYWJlbD5bXSB7XG4gICAgY29uc3QgbWF0Y2hlczogUmFuZ2VFbnRyeTxUTGFiZWw+W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5lbnRyaWVzKSB7XG4gICAgICBpZiAoZS5zdGFydElkeCA+IGNvbW1pdElkeCkgY29udGludWU7XG4gICAgICBpZiAoZS5lbmRJZHggPT09IHVuZGVmaW5lZCB8fCBlLmVuZElkeCA+PSBjb21taXRJZHgpIHtcbiAgICAgICAgbWF0Y2hlcy5wdXNoKHRvRW50cnkoZSkpO1xuICAgICAgfVxuICAgIH1cbiAgICBtYXRjaGVzLnNvcnQob3V0ZXJUb0lubmVyQ29tcGFyYXRvcik7XG4gICAgcmV0dXJuIG1hdGNoZXM7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyBhbGwgcmFuZ2VzIE9WRVJMQVBQSU5HIHRoZSBzbGljZSBgW3N0YXJ0SWR4LCBlbmRJZHhdYC4gQVxuICAgKiByYW5nZSBvdmVybGFwcyBpZiBpdCBzaGFyZXMgYXQgbGVhc3Qgb25lIGNvbW1pdCBwb3NpdGlvbiB3aXRoIHRoZVxuICAgKiBzbGljZS4gVXNlIGZvciBwYXJhbGxlbC1icmFuY2ggZGV0ZWN0aW9uLCB0aW1lLXdpbmRvdyBxdWVyaWVzLFxuICAgKiBvciBcIndoYXQgYm91bmRhcmllcyBmaXJlZCBkdXJpbmcgdGhpcyBzbGljZS5cIlxuICAgKlxuICAgKiBTb3J0ZWQgYnkgdGhlIFNBTUUgb3V0ZXLihpJpbm5lciBjb21wYXJhdG9yIGFzIGBlbmNsb3NpbmcoKWA6XG4gICAqIGFzY2VuZGluZyBieSBgc3RhcnRJZHhgLCB0aWVzIGJyb2tlbiBieSBkZXNjZW5kaW5nIGBlbmRJZHhgXG4gICAqICh3aWRlciA9IG91dGVyOyBvcGVuIHJhbmdlcyB0cmVhdGVkIGFzICtJbmZpbml0eSkuXG4gICAqXG4gICAqIFJldHVybnMgYSBTSEFMTE9XIElNTVVUQUJMRSBDT1BZLlxuICAgKi9cbiAgb3ZlcmxhcHBpbmcoc3RhcnRJZHg6IG51bWJlciwgZW5kSWR4OiBudW1iZXIpOiByZWFkb25seSBSYW5nZUVudHJ5PFRMYWJlbD5bXSB7XG4gICAgY29uc3QgbWF0Y2hlczogUmFuZ2VFbnRyeTxUTGFiZWw+W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5lbnRyaWVzKSB7XG4gICAgICAvLyBPdmVybGFwIHRlc3Q6XG4gICAgICAvLyAgIHJhbmdlIHN0YXJ0cyBhZnRlciBzbGljZSBlbmRzIOKGkiBubyBvdmVybGFwXG4gICAgICAvLyAgIHJhbmdlIGVuZHMgKGNsb3NlZCkgYmVmb3JlIHNsaWNlIHN0YXJ0cyDihpIgbm8gb3ZlcmxhcFxuICAgICAgLy8gICBvdGhlcndpc2Ug4oaSIG92ZXJsYXAgKG9wZW4gcmFuZ2VzIGFsd2F5cyBvdmVybGFwIGlmIHRoZXkgc3RhcnQgPD0gZW5kSWR4KVxuICAgICAgaWYgKGUuc3RhcnRJZHggPiBlbmRJZHgpIGNvbnRpbnVlO1xuICAgICAgaWYgKGUuZW5kSWR4ICE9PSB1bmRlZmluZWQgJiYgZS5lbmRJZHggPCBzdGFydElkeCkgY29udGludWU7XG4gICAgICBtYXRjaGVzLnB1c2godG9FbnRyeShlKSk7XG4gICAgfVxuICAgIG1hdGNoZXMuc29ydChvdXRlclRvSW5uZXJDb21wYXJhdG9yKTtcbiAgICByZXR1cm4gbWF0Y2hlcztcbiAgfVxuXG4gIC8qKiBUb3RhbCByYW5nZSBjb3VudCAob3BlbiArIGNsb3NlZCkuICovXG4gIGdldCBzaXplKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuZW50cmllcy5sZW5ndGg7XG4gIH1cblxuICAvKipcbiAgICogV2lwZSBhbGwgcmFuZ2VzICsgcmVzZXQgdGhlIHRva2VuIGNvdW50ZXIgQU5EIHJvdGF0ZSB0aGUgb3duZXJcbiAgICogc3ltYm9sIHNvIGFueSB0b2tlbiBmcm9tIGJlZm9yZSB0aGlzIGNsZWFyIGJlY29tZXMgaW52YWxpZC5cbiAgICogQ3JpdGljYWw6IHdpdGhvdXQgcm90YXRpbmcgdGhlIG93bmVyLCBhIHN0YWxlIHRva2VuIHdob3NlIGBfaWRgXG4gICAqIGhhcHBlbnMgdG8gbWF0Y2ggYSByZWN5Y2xlZCBpZCBhZnRlciBjbGVhciB3b3VsZCBzaWxlbnRseSBtdXRhdGVcbiAgICogdGhlIHdyb25nIGVudHJ5LiBPd25lciByb3RhdGlvbiBtYWtlcyBzdGFsZS10b2tlbiBjbG9zZSBhIG5vLW9wXG4gICAqIHZpYSB0aGUgYF9vd25lciAhPT0gdGhpcy5vd25lcmAgZ3VhcmQuXG4gICAqXG4gICAqIENhbGwgZnJvbSBhIGNvbnN1bWVyJ3MgcnVuSWQgZ3VhcmQgd2hlbiBhIG5ldyBydW4gc3RhcnRzIChlLmcuLFxuICAgKiBhZ2VudGZvb3RwcmludCdzIGBvYnNlcnZlUnVuSWQob25OZXdSdW4pYCBmcm9tIFBoYXNlIDIpLlxuICAgKi9cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgdGhpcy5lbnRyaWVzLmxlbmd0aCA9IDA7XG4gICAgdGhpcy5ieUlkLmNsZWFyKCk7XG4gICAgdGhpcy5uZXh0SWQgPSAwO1xuICAgIHRoaXMub3duZXIgPSBTeW1ib2woJ0NvbW1pdFJhbmdlSW5kZXgnKTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBJbnRlcm5hbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIE8oMSkgbG9va3VwIGJ5IHRva2VuIGlkLiBBbHdheXMgcmV0dXJucyB0aGUgZW50cnkgdGhhdCB0aGUgdG9rZW5cbiAgICogIHJlZmVyZW5jZXMgKG9yIHVuZGVmaW5lZCBpZiB0aGUgaWQgd2FzIG5ldmVyIG9wZW5lZCBpbiB0aGlzIGluZGV4KS4gKi9cbiAgcHJpdmF0ZSBmaW5kQnlJZChpZDogbnVtYmVyKTogSW50ZXJuYWxFbnRyeTxUTGFiZWw+IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5ieUlkLmdldChpZCk7XG4gIH1cbn1cblxuLyoqIFByb2plY3QgdGhlIGludGVybmFsIG11dGFibGUgc2hhcGUgaW50byB0aGUgcHVibGljIHJlYWRvbmx5IGVudHJ5LlxuICogIFRoZSBPVVRFUiBvYmplY3QgaXMgYSBmcmVzaCBhbGxvY2F0aW9uIHBlciBxdWVyeSAoc28gY2FsbGVyIGFycmF5XG4gKiAgbXV0YXRpb25zIGRvbid0IGxlYWspLiBUaGUgYGxhYmVsYCBmaWVsZCBpcyBhIFJFRkVSRU5DRSBDT1BZIOKAlFxuICogIGlmIGBUTGFiZWxgIGlzIGFuIG9iamVjdCwgbXV0YXRpbmcgaXRzIGZpZWxkcyB3aWxsIGFmZmVjdCB0aGVcbiAqICBpbnRlcm5hbCBlbnRyeSB0b28uIENvbnN1bWVycyBNVVNUIHRyZWF0IGxhYmVscyBhcyBpbW11dGFibGVcbiAqICAob3IgcGFzcyBwcmltaXRpdmVzKS4gRG9jdW1lbnRlZCBpbiB0aGUgY2xhc3MgSlNEb2MgYXMgdGhlXG4gKiAgXCJsYWJlbHMgYXJlIHN0b3JlZCB2ZXJiYXRpbVwiIGNvbnRyYWN0LiAqL1xuZnVuY3Rpb24gdG9FbnRyeTxUTGFiZWw+KGU6IEludGVybmFsRW50cnk8VExhYmVsPik6IFJhbmdlRW50cnk8VExhYmVsPiB7XG4gIHJldHVybiBlLmVuZElkeCA9PT0gdW5kZWZpbmVkXG4gICAgPyB7IGxhYmVsOiBlLmxhYmVsLCBzdGFydElkeDogZS5zdGFydElkeCB9XG4gICAgOiB7IGxhYmVsOiBlLmxhYmVsLCBzdGFydElkeDogZS5zdGFydElkeCwgZW5kSWR4OiBlLmVuZElkeCB9O1xufVxuXG4vKipcbiAqIFNoYXJlZCBvdXRlcuKGkmlubmVyIGNvbXBhcmF0b3IgZm9yIGJvdGggYGVuY2xvc2luZygpYCBhbmRcbiAqIGBvdmVybGFwcGluZygpYC4gUHJpbWFyeSBrZXk6IGBzdGFydElkeGAgYXNjZW5kaW5nLiBUaWUtYnJlYWs6XG4gKiBgZW5kSWR4YCBkZXNjZW5kaW5nICh3aWRlciByYW5nZSBpcyBvdXRlcikuIE9wZW4gcmFuZ2VzICh1bmRlZmluZWRcbiAqIGBlbmRJZHhgKSBzb3J0IGFzICtJbmZpbml0eSDihpIgb3V0ZXJtb3N0IHdoZW4gdGllZC4gRGV0ZXJtaW5pc3RpY1xuICogb3JkZXJpbmcgcmVxdWlyZWQgc28gY29uc3VtZXJzIChMZW5zIGJyZWFkY3J1bWIsIHRpbWUtdHJhdmVsIFVJcylcbiAqIG5ldmVyIHNlZSBmbGlja2VyIG9uIGVxdWFsLXN0YXJ0IGJvdW5kYXJpZXMgKGUuZy4sIGEgUGFyYWxsZWxcbiAqIHJvb3QgYW5kIGl0cyBmaXJzdCBicmFuY2ggb3BlbmluZyBhdCB0aGUgc2FtZSBjb21taXQpLlxuICovXG5mdW5jdGlvbiBvdXRlclRvSW5uZXJDb21wYXJhdG9yPFRMYWJlbD4oYTogUmFuZ2VFbnRyeTxUTGFiZWw+LCBiOiBSYW5nZUVudHJ5PFRMYWJlbD4pOiBudW1iZXIge1xuICBpZiAoYS5zdGFydElkeCAhPT0gYi5zdGFydElkeCkgcmV0dXJuIGEuc3RhcnRJZHggLSBiLnN0YXJ0SWR4O1xuICBjb25zdCBhZSA9IGEuZW5kSWR4ID8/IE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcbiAgY29uc3QgYmUgPSBiLmVuZElkeCA/PyBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFk7XG4gIHJldHVybiBiZSAtIGFlO1xufVxuIl19