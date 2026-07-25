/**
 * SequenceStore<T> — concrete, composable storage for ordered sequence data.
 *
 * Pattern: COMPOSITION primitive. Concrete class — instantiate with
 *          `new SequenceStore<T>()` and own it as a field on your
 *          recorder. Replaces the abstract `SequenceRecorder<T>` base
 *          class for the v5 "one purpose per recorder" rule:
 *          stores ARE storage; recorders ARE event handlers; consumers
 *          COMPOSE.
 * Role:    Dual-indexed append-only sequence: a flat array preserving
 *          insertion order plus a `Map<runtimeStageId, T[]>` for O(1)
 *          per-step lookup. Plus a precomputed range index for time-
 *          travel scrubbing.
 *
 * @example
 * ```typescript
 * import { SequenceStore } from 'footprintjs/trace';
 * import type { ScopeRecorder, ReadEvent, WriteEvent } from 'footprintjs';
 *
 * interface AuditEntry {
 *   runtimeStageId?: string;
 *   type: 'read' | 'write' | 'decision';
 *   detail: string;
 * }
 *
 * // ONE PURPOSE: scope-event handler. Storage is composed in.
 * class AuditRecorder implements ScopeRecorder {
 *   readonly id = 'audit';
 *   private readonly store = new SequenceStore<AuditEntry>();
 *
 *   onRead(event: ReadEvent) {
 *     this.store.push({
 *       runtimeStageId: event.runtimeStageId,
 *       type: 'read',
 *       detail: event.key,
 *     });
 *   }
 *   onWrite(event: WriteEvent) {
 *     this.store.push({
 *       runtimeStageId: event.runtimeStageId,
 *       type: 'write',
 *       detail: event.key,
 *     });
 *   }
 *
 *   getAudit() { return this.store.getAll(); }
 *   getAuditUpTo(ids: ReadonlySet<string>) {
 *     return this.store.getEntriesUpTo(ids);
 *   }
 *
 *   clear() { this.store.clear(); }
 * }
 * ```
 *
 * **Contrast with `KeyedStore<T>`:** SequenceStore stores 1:N entries
 * per runtimeStageId in insertion order. Use KeyedStore for 1:1
 * (one record per step — token counts, metric snapshots).
 */
export class SequenceStore {
    /** Ordered sequence of all entries (insertion order). */
    entries = [];
    /** Per-step index: runtimeStageId → entries for that step. Same objects as `entries[]`. */
    byRuntimeStageId = new Map();
    /** Per-step range index: runtimeStageId → [firstIdx, endIdx) in entries array.
     *  endIdx includes trailing keyless entries (structural markers). Maintained during push(). */
    entryRanges = new Map();
    /** The runtimeStageId of the most recently emitted keyed entry. Used to extend
     *  ranges for trailing markers (entries without runtimeStageId attached after a step). */
    lastEmittedId;
    // ── Write ────────────────────────────────────────────────────────────
    /**
     * Append an entry to both the ordered sequence, keyed index, and range index.
     * All three reference the SAME entry object — no duplication.
     */
    push(entry) {
        const idx = this.entries.length;
        this.entries.push(entry);
        const id = entry.runtimeStageId;
        if (id) {
            let arr = this.byRuntimeStageId.get(id);
            if (!arr) {
                arr = [];
                this.byRuntimeStageId.set(id, arr);
                this.entryRanges.set(id, { firstIdx: idx, endIdx: idx + 1 });
            }
            else {
                this.entryRanges.get(id).endIdx = idx + 1;
            }
            arr.push(entry);
            this.lastEmittedId = id;
        }
        else if (this.lastEmittedId) {
            // Structural marker (no runtimeStageId) — extend the preceding step's range.
            this.entryRanges.get(this.lastEmittedId).endIdx = idx + 1;
        }
    }
    // ── Ordered access ───────────────────────────────────────────────────
    /** All entries in insertion order. Returns a shallow copy — entry objects are shared. */
    getAll() {
        return [...this.entries];
    }
    /** Number of entries in the sequence. */
    get size() {
        return this.entries.length;
    }
    /** Zero-copy iteration. Avoids the `getAll()` spread when the caller just needs
     *  to walk the entries (e.g., aggregating, rendering). */
    forEach(fn) {
        for (const entry of this.entries)
            fn(entry);
    }
    // ── Keyed access ─────────────────────────────────────────────────────
    /** O(1) lookup: all entries for a specific execution step. Returns a copy. */
    getByKey(runtimeStageId) {
        return [...(this.byRuntimeStageId.get(runtimeStageId) ?? [])];
    }
    /** Number of distinct execution steps that have at least one entry. */
    get keyCount() {
        return this.byRuntimeStageId.size;
    }
    /**
     * Pre-built range index: runtimeStageId → half-open `[firstIdx, endIdx)`
     * range in the entries array. Maintained during `push()` — no rebuild
     * needed. Use for O(1) per-step lookups during time-travel scrubbing.
     * `endIdx` includes trailing keyless entries (structural markers
     * following a step).
     */
    getEntryRanges() {
        return this.entryRanges;
    }
    // ── Aggregate (reduce all entries) ───────────────────────────────────
    /** Reduce ALL entries to a single value. For dashboards, totals, summaries. */
    aggregate(fn, initial) {
        let acc = initial;
        for (const entry of this.entries)
            acc = fn(acc, entry);
        return acc;
    }
    // ── Accumulate (progressive reduce) ──────────────────────────────────
    /**
     * Reduce entries, optionally filtered by a set of `runtimeStageIds`.
     * For time-travel progressive view: pass the runtimeStageIds visible
     * at the current slider position. Entries without `runtimeStageId`
     * (structural markers) are excluded when keys are provided. Without
     * keys, reduces all entries (same as `aggregate`).
     */
    accumulate(fn, initial, keys) {
        let acc = initial;
        for (const entry of this.entries) {
            if (keys) {
                if (!entry.runtimeStageId || !keys.has(entry.runtimeStageId))
                    continue;
            }
            acc = fn(acc, entry);
        }
        return acc;
    }
    // ── Time-travel ──────────────────────────────────────────────────────
    /**
     * Progressive reveal: entries whose `runtimeStageId` is in the visible
     * set. Preserves insertion order. Entries without `runtimeStageId`
     * (structural markers) are buffered and included only when surrounded
     * by visible steps on both sides — trailing markers after the last
     * visible step are discarded.
     */
    getEntriesUpTo(visibleIds) {
        const result = [];
        let pendingMarkers = [];
        for (const entry of this.entries) {
            const id = entry.runtimeStageId;
            if (!id) {
                if (result.length > 0)
                    pendingMarkers.push(entry);
            }
            else if (visibleIds.has(id)) {
                if (pendingMarkers.length > 0) {
                    result.push(...pendingMarkers);
                    pendingMarkers = [];
                }
                result.push(entry);
            }
        }
        return result;
    }
    // ── Lifecycle ────────────────────────────────────────────────────────
    /** Clear all stored data. Recorders typically call this from their own
     *  `clear()` method, which the executor invokes before each run. */
    clear() {
        this.entries.length = 0;
        this.byRuntimeStageId.clear();
        this.entryRanges.clear();
        this.lastEmittedId = undefined;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2VxdWVuY2VTdG9yZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVjb3JkZXIvU2VxdWVuY2VTdG9yZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBeURHO0FBQ0gsTUFBTSxPQUFPLGFBQWE7SUFDeEIseURBQXlEO0lBQ3hDLE9BQU8sR0FBUSxFQUFFLENBQUM7SUFDbkMsMkZBQTJGO0lBQzFFLGdCQUFnQixHQUFHLElBQUksR0FBRyxFQUFlLENBQUM7SUFDM0Q7bUdBQytGO0lBQzlFLFdBQVcsR0FBRyxJQUFJLEdBQUcsRUFBZ0QsQ0FBQztJQUN2Rjs4RkFDMEY7SUFDbEYsYUFBYSxDQUFxQjtJQUUxQyx3RUFBd0U7SUFFeEU7OztPQUdHO0lBQ0gsSUFBSSxDQUFDLEtBQVE7UUFDWCxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQztRQUNoQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN6QixNQUFNLEVBQUUsR0FBRyxLQUFLLENBQUMsY0FBYyxDQUFDO1FBQ2hDLElBQUksRUFBRSxFQUFFLENBQUM7WUFDUCxJQUFJLEdBQUcsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ3hDLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztnQkFDVCxHQUFHLEdBQUcsRUFBRSxDQUFDO2dCQUNULElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO2dCQUNuQyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLE1BQU0sRUFBRSxHQUFHLEdBQUcsQ0FBQyxFQUFFLENB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LENBQUM7b0JBQUUsY0FBYyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNwRCxDQUFDO2lCQUFNLElBQUksVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO2dCQUM5QixJQUFJLGNBQWMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7b0JBQzlCLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxjQUFjLENBQUMsQ0FBQztvQkFDL0IsY0FBYyxHQUFHLEVBQUUsQ0FBQztnQkFDdEIsQ0FBQztnQkFDRCxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3JCLENBQUM7UUFDSCxDQUFDO1FBQ0QsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQztJQUVELHdFQUF3RTtJQUV4RTt3RUFDb0U7SUFDcEUsS0FBSztRQUNILElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztRQUN4QixJQUFJLENBQUMsZ0JBQWdCLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDOUIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsYUFBYSxHQUFHLFNBQVMsQ0FBQztJQUNqQyxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNlcXVlbmNlU3RvcmU8VD4g4oCUIGNvbmNyZXRlLCBjb21wb3NhYmxlIHN0b3JhZ2UgZm9yIG9yZGVyZWQgc2VxdWVuY2UgZGF0YS5cbiAqXG4gKiBQYXR0ZXJuOiBDT01QT1NJVElPTiBwcmltaXRpdmUuIENvbmNyZXRlIGNsYXNzIOKAlCBpbnN0YW50aWF0ZSB3aXRoXG4gKiAgICAgICAgICBgbmV3IFNlcXVlbmNlU3RvcmU8VD4oKWAgYW5kIG93biBpdCBhcyBhIGZpZWxkIG9uIHlvdXJcbiAqICAgICAgICAgIHJlY29yZGVyLiBSZXBsYWNlcyB0aGUgYWJzdHJhY3QgYFNlcXVlbmNlUmVjb3JkZXI8VD5gIGJhc2VcbiAqICAgICAgICAgIGNsYXNzIGZvciB0aGUgdjUgXCJvbmUgcHVycG9zZSBwZXIgcmVjb3JkZXJcIiBydWxlOlxuICogICAgICAgICAgc3RvcmVzIEFSRSBzdG9yYWdlOyByZWNvcmRlcnMgQVJFIGV2ZW50IGhhbmRsZXJzOyBjb25zdW1lcnNcbiAqICAgICAgICAgIENPTVBPU0UuXG4gKiBSb2xlOiAgICBEdWFsLWluZGV4ZWQgYXBwZW5kLW9ubHkgc2VxdWVuY2U6IGEgZmxhdCBhcnJheSBwcmVzZXJ2aW5nXG4gKiAgICAgICAgICBpbnNlcnRpb24gb3JkZXIgcGx1cyBhIGBNYXA8cnVudGltZVN0YWdlSWQsIFRbXT5gIGZvciBPKDEpXG4gKiAgICAgICAgICBwZXItc3RlcCBsb29rdXAuIFBsdXMgYSBwcmVjb21wdXRlZCByYW5nZSBpbmRleCBmb3IgdGltZS1cbiAqICAgICAgICAgIHRyYXZlbCBzY3J1YmJpbmcuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGltcG9ydCB7IFNlcXVlbmNlU3RvcmUgfSBmcm9tICdmb290cHJpbnRqcy90cmFjZSc7XG4gKiBpbXBvcnQgdHlwZSB7IFNjb3BlUmVjb3JkZXIsIFJlYWRFdmVudCwgV3JpdGVFdmVudCB9IGZyb20gJ2Zvb3RwcmludGpzJztcbiAqXG4gKiBpbnRlcmZhY2UgQXVkaXRFbnRyeSB7XG4gKiAgIHJ1bnRpbWVTdGFnZUlkPzogc3RyaW5nO1xuICogICB0eXBlOiAncmVhZCcgfCAnd3JpdGUnIHwgJ2RlY2lzaW9uJztcbiAqICAgZGV0YWlsOiBzdHJpbmc7XG4gKiB9XG4gKlxuICogLy8gT05FIFBVUlBPU0U6IHNjb3BlLWV2ZW50IGhhbmRsZXIuIFN0b3JhZ2UgaXMgY29tcG9zZWQgaW4uXG4gKiBjbGFzcyBBdWRpdFJlY29yZGVyIGltcGxlbWVudHMgU2NvcGVSZWNvcmRlciB7XG4gKiAgIHJlYWRvbmx5IGlkID0gJ2F1ZGl0JztcbiAqICAgcHJpdmF0ZSByZWFkb25seSBzdG9yZSA9IG5ldyBTZXF1ZW5jZVN0b3JlPEF1ZGl0RW50cnk+KCk7XG4gKlxuICogICBvblJlYWQoZXZlbnQ6IFJlYWRFdmVudCkge1xuICogICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gKiAgICAgICBydW50aW1lU3RhZ2VJZDogZXZlbnQucnVudGltZVN0YWdlSWQsXG4gKiAgICAgICB0eXBlOiAncmVhZCcsXG4gKiAgICAgICBkZXRhaWw6IGV2ZW50LmtleSxcbiAqICAgICB9KTtcbiAqICAgfVxuICogICBvbldyaXRlKGV2ZW50OiBXcml0ZUV2ZW50KSB7XG4gKiAgICAgdGhpcy5zdG9yZS5wdXNoKHtcbiAqICAgICAgIHJ1bnRpbWVTdGFnZUlkOiBldmVudC5ydW50aW1lU3RhZ2VJZCxcbiAqICAgICAgIHR5cGU6ICd3cml0ZScsXG4gKiAgICAgICBkZXRhaWw6IGV2ZW50LmtleSxcbiAqICAgICB9KTtcbiAqICAgfVxuICpcbiAqICAgZ2V0QXVkaXQoKSB7IHJldHVybiB0aGlzLnN0b3JlLmdldEFsbCgpOyB9XG4gKiAgIGdldEF1ZGl0VXBUbyhpZHM6IFJlYWRvbmx5U2V0PHN0cmluZz4pIHtcbiAqICAgICByZXR1cm4gdGhpcy5zdG9yZS5nZXRFbnRyaWVzVXBUbyhpZHMpO1xuICogICB9XG4gKlxuICogICBjbGVhcigpIHsgdGhpcy5zdG9yZS5jbGVhcigpOyB9XG4gKiB9XG4gKiBgYGBcbiAqXG4gKiAqKkNvbnRyYXN0IHdpdGggYEtleWVkU3RvcmU8VD5gOioqIFNlcXVlbmNlU3RvcmUgc3RvcmVzIDE6TiBlbnRyaWVzXG4gKiBwZXIgcnVudGltZVN0YWdlSWQgaW4gaW5zZXJ0aW9uIG9yZGVyLiBVc2UgS2V5ZWRTdG9yZSBmb3IgMToxXG4gKiAob25lIHJlY29yZCBwZXIgc3RlcCDigJQgdG9rZW4gY291bnRzLCBtZXRyaWMgc25hcHNob3RzKS5cbiAqL1xuZXhwb3J0IGNsYXNzIFNlcXVlbmNlU3RvcmU8VCBleHRlbmRzIHsgcnVudGltZVN0YWdlSWQ/OiBzdHJpbmcgfT4ge1xuICAvKiogT3JkZXJlZCBzZXF1ZW5jZSBvZiBhbGwgZW50cmllcyAoaW5zZXJ0aW9uIG9yZGVyKS4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBlbnRyaWVzOiBUW10gPSBbXTtcbiAgLyoqIFBlci1zdGVwIGluZGV4OiBydW50aW1lU3RhZ2VJZCDihpIgZW50cmllcyBmb3IgdGhhdCBzdGVwLiBTYW1lIG9iamVjdHMgYXMgYGVudHJpZXNbXWAuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgYnlSdW50aW1lU3RhZ2VJZCA9IG5ldyBNYXA8c3RyaW5nLCBUW10+KCk7XG4gIC8qKiBQZXItc3RlcCByYW5nZSBpbmRleDogcnVudGltZVN0YWdlSWQg4oaSIFtmaXJzdElkeCwgZW5kSWR4KSBpbiBlbnRyaWVzIGFycmF5LlxuICAgKiAgZW5kSWR4IGluY2x1ZGVzIHRyYWlsaW5nIGtleWxlc3MgZW50cmllcyAoc3RydWN0dXJhbCBtYXJrZXJzKS4gTWFpbnRhaW5lZCBkdXJpbmcgcHVzaCgpLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGVudHJ5UmFuZ2VzID0gbmV3IE1hcDxzdHJpbmcsIHsgZmlyc3RJZHg6IG51bWJlcjsgZW5kSWR4OiBudW1iZXIgfT4oKTtcbiAgLyoqIFRoZSBydW50aW1lU3RhZ2VJZCBvZiB0aGUgbW9zdCByZWNlbnRseSBlbWl0dGVkIGtleWVkIGVudHJ5LiBVc2VkIHRvIGV4dGVuZFxuICAgKiAgcmFuZ2VzIGZvciB0cmFpbGluZyBtYXJrZXJzIChlbnRyaWVzIHdpdGhvdXQgcnVudGltZVN0YWdlSWQgYXR0YWNoZWQgYWZ0ZXIgYSBzdGVwKS4gKi9cbiAgcHJpdmF0ZSBsYXN0RW1pdHRlZElkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbiAgLy8g4pSA4pSAIFdyaXRlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBBcHBlbmQgYW4gZW50cnkgdG8gYm90aCB0aGUgb3JkZXJlZCBzZXF1ZW5jZSwga2V5ZWQgaW5kZXgsIGFuZCByYW5nZSBpbmRleC5cbiAgICogQWxsIHRocmVlIHJlZmVyZW5jZSB0aGUgU0FNRSBlbnRyeSBvYmplY3Qg4oCUIG5vIGR1cGxpY2F0aW9uLlxuICAgKi9cbiAgcHVzaChlbnRyeTogVCk6IHZvaWQge1xuICAgIGNvbnN0IGlkeCA9IHRoaXMuZW50cmllcy5sZW5ndGg7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goZW50cnkpO1xuICAgIGNvbnN0IGlkID0gZW50cnkucnVudGltZVN0YWdlSWQ7XG4gICAgaWYgKGlkKSB7XG4gICAgICBsZXQgYXJyID0gdGhpcy5ieVJ1bnRpbWVTdGFnZUlkLmdldChpZCk7XG4gICAgICBpZiAoIWFycikge1xuICAgICAgICBhcnIgPSBbXTtcbiAgICAgICAgdGhpcy5ieVJ1bnRpbWVTdGFnZUlkLnNldChpZCwgYXJyKTtcbiAgICAgICAgdGhpcy5lbnRyeVJhbmdlcy5zZXQoaWQsIHsgZmlyc3RJZHg6IGlkeCwgZW5kSWR4OiBpZHggKyAxIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5lbnRyeVJhbmdlcy5nZXQoaWQpIS5lbmRJZHggPSBpZHggKyAxO1xuICAgICAgfVxuICAgICAgYXJyLnB1c2goZW50cnkpO1xuICAgICAgdGhpcy5sYXN0RW1pdHRlZElkID0gaWQ7XG4gICAgfSBlbHNlIGlmICh0aGlzLmxhc3RFbWl0dGVkSWQpIHtcbiAgICAgIC8vIFN0cnVjdHVyYWwgbWFya2VyIChubyBydW50aW1lU3RhZ2VJZCkg4oCUIGV4dGVuZCB0aGUgcHJlY2VkaW5nIHN0ZXAncyByYW5nZS5cbiAgICAgIHRoaXMuZW50cnlSYW5nZXMuZ2V0KHRoaXMubGFzdEVtaXR0ZWRJZCkhLmVuZElkeCA9IGlkeCArIDE7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIE9yZGVyZWQgYWNjZXNzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBBbGwgZW50cmllcyBpbiBpbnNlcnRpb24gb3JkZXIuIFJldHVybnMgYSBzaGFsbG93IGNvcHkg4oCUIGVudHJ5IG9iamVjdHMgYXJlIHNoYXJlZC4gKi9cbiAgZ2V0QWxsKCk6IFRbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLmVudHJpZXNdO1xuICB9XG5cbiAgLyoqIE51bWJlciBvZiBlbnRyaWVzIGluIHRoZSBzZXF1ZW5jZS4gKi9cbiAgZ2V0IHNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5lbnRyaWVzLmxlbmd0aDtcbiAgfVxuXG4gIC8qKiBaZXJvLWNvcHkgaXRlcmF0aW9uLiBBdm9pZHMgdGhlIGBnZXRBbGwoKWAgc3ByZWFkIHdoZW4gdGhlIGNhbGxlciBqdXN0IG5lZWRzXG4gICAqICB0byB3YWxrIHRoZSBlbnRyaWVzIChlLmcuLCBhZ2dyZWdhdGluZywgcmVuZGVyaW5nKS4gKi9cbiAgZm9yRWFjaChmbjogKGVudHJ5OiBUKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLmVudHJpZXMpIGZuKGVudHJ5KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBLZXllZCBhY2Nlc3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIE8oMSkgbG9va3VwOiBhbGwgZW50cmllcyBmb3IgYSBzcGVjaWZpYyBleGVjdXRpb24gc3RlcC4gUmV0dXJucyBhIGNvcHkuICovXG4gIGdldEJ5S2V5KHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmcpOiBUW10ge1xuICAgIHJldHVybiBbLi4uKHRoaXMuYnlSdW50aW1lU3RhZ2VJZC5nZXQocnVudGltZVN0YWdlSWQpID8/IFtdKV07XG4gIH1cblxuICAvKiogTnVtYmVyIG9mIGRpc3RpbmN0IGV4ZWN1dGlvbiBzdGVwcyB0aGF0IGhhdmUgYXQgbGVhc3Qgb25lIGVudHJ5LiAqL1xuICBnZXQga2V5Q291bnQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5ieVJ1bnRpbWVTdGFnZUlkLnNpemU7XG4gIH1cblxuICAvKipcbiAgICogUHJlLWJ1aWx0IHJhbmdlIGluZGV4OiBydW50aW1lU3RhZ2VJZCDihpIgaGFsZi1vcGVuIGBbZmlyc3RJZHgsIGVuZElkeClgXG4gICAqIHJhbmdlIGluIHRoZSBlbnRyaWVzIGFycmF5LiBNYWludGFpbmVkIGR1cmluZyBgcHVzaCgpYCDigJQgbm8gcmVidWlsZFxuICAgKiBuZWVkZWQuIFVzZSBmb3IgTygxKSBwZXItc3RlcCBsb29rdXBzIGR1cmluZyB0aW1lLXRyYXZlbCBzY3J1YmJpbmcuXG4gICAqIGBlbmRJZHhgIGluY2x1ZGVzIHRyYWlsaW5nIGtleWxlc3MgZW50cmllcyAoc3RydWN0dXJhbCBtYXJrZXJzXG4gICAqIGZvbGxvd2luZyBhIHN0ZXApLlxuICAgKi9cbiAgZ2V0RW50cnlSYW5nZXMoKTogUmVhZG9ubHlNYXA8c3RyaW5nLCB7IHJlYWRvbmx5IGZpcnN0SWR4OiBudW1iZXI7IHJlYWRvbmx5IGVuZElkeDogbnVtYmVyIH0+IHtcbiAgICByZXR1cm4gdGhpcy5lbnRyeVJhbmdlcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBBZ2dyZWdhdGUgKHJlZHVjZSBhbGwgZW50cmllcykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIFJlZHVjZSBBTEwgZW50cmllcyB0byBhIHNpbmdsZSB2YWx1ZS4gRm9yIGRhc2hib2FyZHMsIHRvdGFscywgc3VtbWFyaWVzLiAqL1xuICBhZ2dyZWdhdGU8Uj4oZm46IChhY2M6IFIsIGVudHJ5OiBUKSA9PiBSLCBpbml0aWFsOiBSKTogUiB7XG4gICAgbGV0IGFjYyA9IGluaXRpYWw7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLmVudHJpZXMpIGFjYyA9IGZuKGFjYywgZW50cnkpO1xuICAgIHJldHVybiBhY2M7XG4gIH1cblxuICAvLyDilIDilIAgQWNjdW11bGF0ZSAocHJvZ3Jlc3NpdmUgcmVkdWNlKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogUmVkdWNlIGVudHJpZXMsIG9wdGlvbmFsbHkgZmlsdGVyZWQgYnkgYSBzZXQgb2YgYHJ1bnRpbWVTdGFnZUlkc2AuXG4gICAqIEZvciB0aW1lLXRyYXZlbCBwcm9ncmVzc2l2ZSB2aWV3OiBwYXNzIHRoZSBydW50aW1lU3RhZ2VJZHMgdmlzaWJsZVxuICAgKiBhdCB0aGUgY3VycmVudCBzbGlkZXIgcG9zaXRpb24uIEVudHJpZXMgd2l0aG91dCBgcnVudGltZVN0YWdlSWRgXG4gICAqIChzdHJ1Y3R1cmFsIG1hcmtlcnMpIGFyZSBleGNsdWRlZCB3aGVuIGtleXMgYXJlIHByb3ZpZGVkLiBXaXRob3V0XG4gICAqIGtleXMsIHJlZHVjZXMgYWxsIGVudHJpZXMgKHNhbWUgYXMgYGFnZ3JlZ2F0ZWApLlxuICAgKi9cbiAgYWNjdW11bGF0ZTxSPihmbjogKGFjYzogUiwgZW50cnk6IFQpID0+IFIsIGluaXRpYWw6IFIsIGtleXM/OiBSZWFkb25seVNldDxzdHJpbmc+KTogUiB7XG4gICAgbGV0IGFjYyA9IGluaXRpYWw7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLmVudHJpZXMpIHtcbiAgICAgIGlmIChrZXlzKSB7XG4gICAgICAgIGlmICghZW50cnkucnVudGltZVN0YWdlSWQgfHwgIWtleXMuaGFzKGVudHJ5LnJ1bnRpbWVTdGFnZUlkKSkgY29udGludWU7XG4gICAgICB9XG4gICAgICBhY2MgPSBmbihhY2MsIGVudHJ5KTtcbiAgICB9XG4gICAgcmV0dXJuIGFjYztcbiAgfVxuXG4gIC8vIOKUgOKUgCBUaW1lLXRyYXZlbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogUHJvZ3Jlc3NpdmUgcmV2ZWFsOiBlbnRyaWVzIHdob3NlIGBydW50aW1lU3RhZ2VJZGAgaXMgaW4gdGhlIHZpc2libGVcbiAgICogc2V0LiBQcmVzZXJ2ZXMgaW5zZXJ0aW9uIG9yZGVyLiBFbnRyaWVzIHdpdGhvdXQgYHJ1bnRpbWVTdGFnZUlkYFxuICAgKiAoc3RydWN0dXJhbCBtYXJrZXJzKSBhcmUgYnVmZmVyZWQgYW5kIGluY2x1ZGVkIG9ubHkgd2hlbiBzdXJyb3VuZGVkXG4gICAqIGJ5IHZpc2libGUgc3RlcHMgb24gYm90aCBzaWRlcyDigJQgdHJhaWxpbmcgbWFya2VycyBhZnRlciB0aGUgbGFzdFxuICAgKiB2aXNpYmxlIHN0ZXAgYXJlIGRpc2NhcmRlZC5cbiAgICovXG4gIGdldEVudHJpZXNVcFRvKHZpc2libGVJZHM6IFJlYWRvbmx5U2V0PHN0cmluZz4pOiBUW10ge1xuICAgIGNvbnN0IHJlc3VsdDogVFtdID0gW107XG4gICAgbGV0IHBlbmRpbmdNYXJrZXJzOiBUW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHRoaXMuZW50cmllcykge1xuICAgICAgY29uc3QgaWQgPSBlbnRyeS5ydW50aW1lU3RhZ2VJZDtcbiAgICAgIGlmICghaWQpIHtcbiAgICAgICAgaWYgKHJlc3VsdC5sZW5ndGggPiAwKSBwZW5kaW5nTWFya2Vycy5wdXNoKGVudHJ5KTtcbiAgICAgIH0gZWxzZSBpZiAodmlzaWJsZUlkcy5oYXMoaWQpKSB7XG4gICAgICAgIGlmIChwZW5kaW5nTWFya2Vycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2goLi4ucGVuZGluZ01hcmtlcnMpO1xuICAgICAgICAgIHBlbmRpbmdNYXJrZXJzID0gW107XG4gICAgICAgIH1cbiAgICAgICAgcmVzdWx0LnB1c2goZW50cnkpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLy8g4pSA4pSAIExpZmVjeWNsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQ2xlYXIgYWxsIHN0b3JlZCBkYXRhLiBSZWNvcmRlcnMgdHlwaWNhbGx5IGNhbGwgdGhpcyBmcm9tIHRoZWlyIG93blxuICAgKiAgYGNsZWFyKClgIG1ldGhvZCwgd2hpY2ggdGhlIGV4ZWN1dG9yIGludm9rZXMgYmVmb3JlIGVhY2ggcnVuLiAqL1xuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLmVudHJpZXMubGVuZ3RoID0gMDtcbiAgICB0aGlzLmJ5UnVudGltZVN0YWdlSWQuY2xlYXIoKTtcbiAgICB0aGlzLmVudHJ5UmFuZ2VzLmNsZWFyKCk7XG4gICAgdGhpcy5sYXN0RW1pdHRlZElkID0gdW5kZWZpbmVkO1xuICB9XG59XG4iXX0=