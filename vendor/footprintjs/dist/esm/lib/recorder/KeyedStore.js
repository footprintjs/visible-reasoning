/**
 * KeyedStore<T> — concrete, composable 1:1 storage keyed by string id.
 *
 * Pattern: COMPOSITION primitive. Concrete class — instantiate with
 *          `new KeyedStore<T>()` and own it as a field on your
 *          recorder. Replaces the abstract `KeyedRecorder<T>` base
 *          class for the v5 "one purpose per recorder" rule.
 * Role:    1:1 Map keyed by `runtimeStageId` (or any string).
 *          Insertion-ordered iteration.
 *
 * **Contrast with `SequenceStore<T>`:** KeyedStore is 1:1 — one entry
 * per key. Use SequenceStore for 1:N (multiple entries per
 * runtimeStageId, ordering matters).
 *
 * @example
 * ```typescript
 * import { KeyedStore } from 'footprintjs/trace';
 *
 * interface TokenEntry { input: number; output: number; }
 *
 * // ONE PURPOSE: typed-event handler. Storage is composed in.
 * class TokenRecorder {
 *   readonly id = 'tokens';
 *   private readonly store = new KeyedStore<TokenEntry>();
 *
 *   onLLMCall(event: LLMCallEvent) {
 *     this.store.set(event.runtimeStageId, event.usage);
 *   }
 *
 *   getForStep(id: string)    { return this.store.get(id); }
 *   getTotalTokens()           { return this.store.aggregate((s, e) => s + e.input + e.output, 0); }
 *   getTokensUpTo(keys: Set<string>) {
 *     return this.store.accumulate((s, e) => s + e.input + e.output, 0, keys);
 *   }
 *
 *   clear() { this.store.clear(); }
 * }
 * ```
 */
export class KeyedStore {
    data = new Map();
    // ── Write ────────────────────────────────────────────────────────────
    /** Store a single entry. Replaces any existing entry for the same key. */
    set(key, entry) {
        this.data.set(key, entry);
    }
    /** Remove an entry. Returns true if the key existed, false otherwise. */
    delete(key) {
        return this.data.delete(key);
    }
    // ── Translate (raw per-key) ──────────────────────────────────────────
    /** O(1) lookup. */
    get(key) {
        return this.data.get(key);
    }
    /** True if a value exists for the key. */
    has(key) {
        return this.data.has(key);
    }
    /** All entries as a read-only Map (insertion-ordered). */
    getMap() {
        return this.data;
    }
    /** All values as an array (insertion-ordered). */
    values() {
        return [...this.data.values()];
    }
    /** Number of entries stored. */
    get size() {
        return this.data.size;
    }
    // ── Aggregate (reduce all entries) ───────────────────────────────────
    /** Reduce ALL entries to a single value. For dashboards, totals, summaries. */
    aggregate(fn, initial) {
        let acc = initial;
        for (const [key, entry] of this.data)
            acc = fn(acc, entry, key);
        return acc;
    }
    // ── Accumulate (progressive reduce) ──────────────────────────────────
    /**
     * Reduce entries, optionally filtered by a set of keys.
     * For time-travel progressive view: pass the keys visible at the
     * current slider position. Without keys, reduces all entries (same
     * as `aggregate`).
     */
    accumulate(fn, initial, keys) {
        let acc = initial;
        for (const [key, entry] of this.data) {
            if (keys && !keys.has(key))
                continue;
            acc = fn(acc, entry, key);
        }
        return acc;
    }
    // ── Filter (subset by keys) ──────────────────────────────────────────
    /** Return entries whose keys are in the set, preserving insertion order. */
    filterByKeys(keys) {
        const result = [];
        for (const [key, entry] of this.data) {
            if (keys.has(key))
                result.push(entry);
        }
        return result;
    }
    // ── Lifecycle ────────────────────────────────────────────────────────
    /** Clear all stored data. Recorders typically call this from their own
     *  `clear()` method, which the executor invokes before each run. */
    clear() {
        this.data.clear();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiS2V5ZWRTdG9yZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVjb3JkZXIvS2V5ZWRTdG9yZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FzQ0c7QUFDSCxNQUFNLE9BQU8sVUFBVTtJQUNKLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBYSxDQUFDO0lBRTdDLHdFQUF3RTtJQUV4RSwwRUFBMEU7SUFDMUUsR0FBRyxDQUFDLEdBQVcsRUFBRSxLQUFRO1FBQ3ZCLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztJQUM1QixDQUFDO0lBRUQseUVBQXlFO0lBQ3pFLE1BQU0sQ0FBQyxHQUFXO1FBQ2hCLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDL0IsQ0FBQztJQUVELHdFQUF3RTtJQUV4RSxtQkFBbUI7SUFDbkIsR0FBRyxDQUFDLEdBQVc7UUFDYixPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzVCLENBQUM7SUFFRCwwQ0FBMEM7SUFDMUMsR0FBRyxDQUFDLEdBQVc7UUFDYixPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzVCLENBQUM7SUFFRCwwREFBMEQ7SUFDMUQsTUFBTTtRQUNKLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQztJQUNuQixDQUFDO0lBRUQsa0RBQWtEO0lBQ2xELE1BQU07UUFDSixPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDakMsQ0FBQztJQUVELGdDQUFnQztJQUNoQyxJQUFJLElBQUk7UUFDTixPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0lBQ3hCLENBQUM7SUFFRCx3RUFBd0U7SUFFeEUsK0VBQStFO0lBQy9FLFNBQVMsQ0FBSSxFQUF3QyxFQUFFLE9BQVU7UUFDL0QsSUFBSSxHQUFHLEdBQUcsT0FBTyxDQUFDO1FBQ2xCLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSTtZQUFFLEdBQUcsR0FBRyxFQUFFLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUNoRSxPQUFPLEdBQUcsQ0FBQztJQUNiLENBQUM7SUFFRCx3RUFBd0U7SUFFeEU7Ozs7O09BS0c7SUFDSCxVQUFVLENBQUksRUFBd0MsRUFBRSxPQUFVLEVBQUUsSUFBMEI7UUFDNUYsSUFBSSxHQUFHLEdBQUcsT0FBTyxDQUFDO1FBQ2xCLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDckMsSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztnQkFBRSxTQUFTO1lBQ3JDLEdBQUcsR0FBRyxFQUFFLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUM1QixDQUFDO1FBQ0QsT0FBTyxHQUFHLENBQUM7SUFDYixDQUFDO0lBRUQsd0VBQXdFO0lBRXhFLDRFQUE0RTtJQUM1RSxZQUFZLENBQUMsSUFBeUI7UUFDcEMsTUFBTSxNQUFNLEdBQVEsRUFBRSxDQUFDO1FBQ3ZCLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDckMsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztnQkFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3hDLENBQUM7UUFDRCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBRUQsd0VBQXdFO0lBRXhFO3dFQUNvRTtJQUNwRSxLQUFLO1FBQ0gsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNwQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEtleWVkU3RvcmU8VD4g4oCUIGNvbmNyZXRlLCBjb21wb3NhYmxlIDE6MSBzdG9yYWdlIGtleWVkIGJ5IHN0cmluZyBpZC5cbiAqXG4gKiBQYXR0ZXJuOiBDT01QT1NJVElPTiBwcmltaXRpdmUuIENvbmNyZXRlIGNsYXNzIOKAlCBpbnN0YW50aWF0ZSB3aXRoXG4gKiAgICAgICAgICBgbmV3IEtleWVkU3RvcmU8VD4oKWAgYW5kIG93biBpdCBhcyBhIGZpZWxkIG9uIHlvdXJcbiAqICAgICAgICAgIHJlY29yZGVyLiBSZXBsYWNlcyB0aGUgYWJzdHJhY3QgYEtleWVkUmVjb3JkZXI8VD5gIGJhc2VcbiAqICAgICAgICAgIGNsYXNzIGZvciB0aGUgdjUgXCJvbmUgcHVycG9zZSBwZXIgcmVjb3JkZXJcIiBydWxlLlxuICogUm9sZTogICAgMToxIE1hcCBrZXllZCBieSBgcnVudGltZVN0YWdlSWRgIChvciBhbnkgc3RyaW5nKS5cbiAqICAgICAgICAgIEluc2VydGlvbi1vcmRlcmVkIGl0ZXJhdGlvbi5cbiAqXG4gKiAqKkNvbnRyYXN0IHdpdGggYFNlcXVlbmNlU3RvcmU8VD5gOioqIEtleWVkU3RvcmUgaXMgMToxIOKAlCBvbmUgZW50cnlcbiAqIHBlciBrZXkuIFVzZSBTZXF1ZW5jZVN0b3JlIGZvciAxOk4gKG11bHRpcGxlIGVudHJpZXMgcGVyXG4gKiBydW50aW1lU3RhZ2VJZCwgb3JkZXJpbmcgbWF0dGVycykuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGltcG9ydCB7IEtleWVkU3RvcmUgfSBmcm9tICdmb290cHJpbnRqcy90cmFjZSc7XG4gKlxuICogaW50ZXJmYWNlIFRva2VuRW50cnkgeyBpbnB1dDogbnVtYmVyOyBvdXRwdXQ6IG51bWJlcjsgfVxuICpcbiAqIC8vIE9ORSBQVVJQT1NFOiB0eXBlZC1ldmVudCBoYW5kbGVyLiBTdG9yYWdlIGlzIGNvbXBvc2VkIGluLlxuICogY2xhc3MgVG9rZW5SZWNvcmRlciB7XG4gKiAgIHJlYWRvbmx5IGlkID0gJ3Rva2Vucyc7XG4gKiAgIHByaXZhdGUgcmVhZG9ubHkgc3RvcmUgPSBuZXcgS2V5ZWRTdG9yZTxUb2tlbkVudHJ5PigpO1xuICpcbiAqICAgb25MTE1DYWxsKGV2ZW50OiBMTE1DYWxsRXZlbnQpIHtcbiAqICAgICB0aGlzLnN0b3JlLnNldChldmVudC5ydW50aW1lU3RhZ2VJZCwgZXZlbnQudXNhZ2UpO1xuICogICB9XG4gKlxuICogICBnZXRGb3JTdGVwKGlkOiBzdHJpbmcpICAgIHsgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0KGlkKTsgfVxuICogICBnZXRUb3RhbFRva2VucygpICAgICAgICAgICB7IHJldHVybiB0aGlzLnN0b3JlLmFnZ3JlZ2F0ZSgocywgZSkgPT4gcyArIGUuaW5wdXQgKyBlLm91dHB1dCwgMCk7IH1cbiAqICAgZ2V0VG9rZW5zVXBUbyhrZXlzOiBTZXQ8c3RyaW5nPikge1xuICogICAgIHJldHVybiB0aGlzLnN0b3JlLmFjY3VtdWxhdGUoKHMsIGUpID0+IHMgKyBlLmlucHV0ICsgZS5vdXRwdXQsIDAsIGtleXMpO1xuICogICB9XG4gKlxuICogICBjbGVhcigpIHsgdGhpcy5zdG9yZS5jbGVhcigpOyB9XG4gKiB9XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGNsYXNzIEtleWVkU3RvcmU8VD4ge1xuICBwcml2YXRlIHJlYWRvbmx5IGRhdGEgPSBuZXcgTWFwPHN0cmluZywgVD4oKTtcblxuICAvLyDilIDilIAgV3JpdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIFN0b3JlIGEgc2luZ2xlIGVudHJ5LiBSZXBsYWNlcyBhbnkgZXhpc3RpbmcgZW50cnkgZm9yIHRoZSBzYW1lIGtleS4gKi9cbiAgc2V0KGtleTogc3RyaW5nLCBlbnRyeTogVCk6IHZvaWQge1xuICAgIHRoaXMuZGF0YS5zZXQoa2V5LCBlbnRyeSk7XG4gIH1cblxuICAvKiogUmVtb3ZlIGFuIGVudHJ5LiBSZXR1cm5zIHRydWUgaWYgdGhlIGtleSBleGlzdGVkLCBmYWxzZSBvdGhlcndpc2UuICovXG4gIGRlbGV0ZShrZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmRhdGEuZGVsZXRlKGtleSk7XG4gIH1cblxuICAvLyDilIDilIAgVHJhbnNsYXRlIChyYXcgcGVyLWtleSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIE8oMSkgbG9va3VwLiAqL1xuICBnZXQoa2V5OiBzdHJpbmcpOiBUIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5kYXRhLmdldChrZXkpO1xuICB9XG5cbiAgLyoqIFRydWUgaWYgYSB2YWx1ZSBleGlzdHMgZm9yIHRoZSBrZXkuICovXG4gIGhhcyhrZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmRhdGEuaGFzKGtleSk7XG4gIH1cblxuICAvKiogQWxsIGVudHJpZXMgYXMgYSByZWFkLW9ubHkgTWFwIChpbnNlcnRpb24tb3JkZXJlZCkuICovXG4gIGdldE1hcCgpOiBSZWFkb25seU1hcDxzdHJpbmcsIFQ+IHtcbiAgICByZXR1cm4gdGhpcy5kYXRhO1xuICB9XG5cbiAgLyoqIEFsbCB2YWx1ZXMgYXMgYW4gYXJyYXkgKGluc2VydGlvbi1vcmRlcmVkKS4gKi9cbiAgdmFsdWVzKCk6IFRbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLmRhdGEudmFsdWVzKCldO1xuICB9XG5cbiAgLyoqIE51bWJlciBvZiBlbnRyaWVzIHN0b3JlZC4gKi9cbiAgZ2V0IHNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5kYXRhLnNpemU7XG4gIH1cblxuICAvLyDilIDilIAgQWdncmVnYXRlIChyZWR1Y2UgYWxsIGVudHJpZXMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBSZWR1Y2UgQUxMIGVudHJpZXMgdG8gYSBzaW5nbGUgdmFsdWUuIEZvciBkYXNoYm9hcmRzLCB0b3RhbHMsIHN1bW1hcmllcy4gKi9cbiAgYWdncmVnYXRlPFI+KGZuOiAoYWNjOiBSLCBlbnRyeTogVCwga2V5OiBzdHJpbmcpID0+IFIsIGluaXRpYWw6IFIpOiBSIHtcbiAgICBsZXQgYWNjID0gaW5pdGlhbDtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiB0aGlzLmRhdGEpIGFjYyA9IGZuKGFjYywgZW50cnksIGtleSk7XG4gICAgcmV0dXJuIGFjYztcbiAgfVxuXG4gIC8vIOKUgOKUgCBBY2N1bXVsYXRlIChwcm9ncmVzc2l2ZSByZWR1Y2UpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBSZWR1Y2UgZW50cmllcywgb3B0aW9uYWxseSBmaWx0ZXJlZCBieSBhIHNldCBvZiBrZXlzLlxuICAgKiBGb3IgdGltZS10cmF2ZWwgcHJvZ3Jlc3NpdmUgdmlldzogcGFzcyB0aGUga2V5cyB2aXNpYmxlIGF0IHRoZVxuICAgKiBjdXJyZW50IHNsaWRlciBwb3NpdGlvbi4gV2l0aG91dCBrZXlzLCByZWR1Y2VzIGFsbCBlbnRyaWVzIChzYW1lXG4gICAqIGFzIGBhZ2dyZWdhdGVgKS5cbiAgICovXG4gIGFjY3VtdWxhdGU8Uj4oZm46IChhY2M6IFIsIGVudHJ5OiBULCBrZXk6IHN0cmluZykgPT4gUiwgaW5pdGlhbDogUiwga2V5cz86IFJlYWRvbmx5U2V0PHN0cmluZz4pOiBSIHtcbiAgICBsZXQgYWNjID0gaW5pdGlhbDtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiB0aGlzLmRhdGEpIHtcbiAgICAgIGlmIChrZXlzICYmICFrZXlzLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgIGFjYyA9IGZuKGFjYywgZW50cnksIGtleSk7XG4gICAgfVxuICAgIHJldHVybiBhY2M7XG4gIH1cblxuICAvLyDilIDilIAgRmlsdGVyIChzdWJzZXQgYnkga2V5cykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIFJldHVybiBlbnRyaWVzIHdob3NlIGtleXMgYXJlIGluIHRoZSBzZXQsIHByZXNlcnZpbmcgaW5zZXJ0aW9uIG9yZGVyLiAqL1xuICBmaWx0ZXJCeUtleXMoa2V5czogUmVhZG9ubHlTZXQ8c3RyaW5nPik6IFRbXSB7XG4gICAgY29uc3QgcmVzdWx0OiBUW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiB0aGlzLmRhdGEpIHtcbiAgICAgIGlmIChrZXlzLmhhcyhrZXkpKSByZXN1bHQucHVzaChlbnRyeSk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvLyDilIDilIAgTGlmZWN5Y2xlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBDbGVhciBhbGwgc3RvcmVkIGRhdGEuIFJlY29yZGVycyB0eXBpY2FsbHkgY2FsbCB0aGlzIGZyb20gdGhlaXIgb3duXG4gICAqICBgY2xlYXIoKWAgbWV0aG9kLCB3aGljaCB0aGUgZXhlY3V0b3IgaW52b2tlcyBiZWZvcmUgZWFjaCBydW4uICovXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIHRoaXMuZGF0YS5jbGVhcigpO1xuICB9XG59XG4iXX0=