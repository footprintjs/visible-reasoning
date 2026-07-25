/**
 * Typed utilities for querying the commit log.
 *
 * The commitLog is an ordered array of CommitBundle — one per stage commit.
 * These helpers provide type-safe queries without (b: any) casts.
 */
import { nativeGet } from './pathOps.js';
import { deepSmartMerge, DELIM } from './utils.js';
/** Find the first commit by stageId, optionally filtering by a written key. */
export function findCommit(commitLog, stageId, key) {
    return commitLog.find((b) => b.stageId === stageId && (!key || b.trace.some((t) => t.path === key)));
}
/** Find all commits by stageId. */
export function findCommits(commitLog, stageId) {
    return commitLog.filter((b) => b.stageId === stageId);
}
/** Find the last commit that wrote a specific key (for backtracking). */
export function findLastWriter(commitLog, key, beforeIdx) {
    const end = beforeIdx ?? commitLog.length;
    for (let i = end - 1; i >= 0; i--) {
        if (commitLog[i].trace.some((t) => t.path === key)) {
            return commitLog[i];
        }
    }
    return undefined;
}
/**
 * Reconstruct the FULL value of `key` as of commit array index `idx`
 * (inclusive) — the migration helper for the "read `bundle.overwrite[key]`
 * as the full value written" pattern (#13c-B).
 *
 * Under `commitValues: 'delta'`, an `append` bundle's `overwrite[key]` holds
 * only the TAIL of the array; this helper folds the verbs back together:
 * it scans `commitLog[0..idx]` for trace entries on `key`, anchors at the
 * latest full-value write (`set` — or `delete`, which resets to absent), and
 * replays forward (`append` → concat, `merge` → `deepSmartMerge`) — exactly
 * the per-key slice of `applySmartMerge`'s replay, O(key's commit span)
 * instead of a full `materialise()`.
 *
 * Works on full-mode logs too (every `set` is its own anchor — equivalent to
 * `findLastWriter(...).overwrite[key]`).
 *
 * @param key  Matched against `TraceEntry.path` exactly (same contract as
 *   `findLastWriter`) — DELIM-joined for nested paths.
 * @param idx  CommitBundle ARRAY index (the `bundle.idx` position),
 *   inclusive. NOT the executionIndex from a runtimeStageId.
 * @returns The reconstructed value (a detached clone), or `undefined` when
 *   the key was never written in `commitLog[0..idx]` or its last write was a
 *   delete. Caveat: values derived purely from the run's INITIAL state (no
 *   `set` anchor in the log — e.g. merges onto a seeded key) fold from
 *   absent; the commit log alone cannot see the pre-run base (the same blind
 *   spot `findLastWriter` has).
 */
export function commitValueAt(commitLog, idx, key) {
    const end = Math.min(idx, commitLog.length - 1);
    const segs = key.split(DELIM);
    // Collect every trace entry touching the key (in order) up to `end`.
    const touches = [];
    for (let i = 0; i <= end; i++) {
        for (const t of commitLog[i].trace) {
            if (t.path === key)
                touches.push({ verb: t.verb, bundle: commitLog[i] });
        }
    }
    if (touches.length === 0)
        return undefined;
    // Anchor at the latest entry that fully determines the value on its own.
    let start = 0;
    for (let i = touches.length - 1; i >= 0; i--) {
        if (touches[i].verb === 'set' || touches[i].verb === 'delete') {
            start = i;
            break;
        }
    }
    // Fold forward from the anchor — the per-key slice of applySmartMerge.
    let value;
    for (let i = start; i < touches.length; i++) {
        const { verb, bundle } = touches[i];
        if (verb === 'set') {
            value = structuredClone(nativeGet(bundle.overwrite, segs));
        }
        else if (verb === 'delete') {
            value = undefined;
        }
        else if (verb === 'append') {
            const tail = structuredClone(nativeGet(bundle.overwrite, segs));
            value = Array.isArray(value) && Array.isArray(tail) ? [...value, ...tail] : tail;
        }
        else {
            value = deepSmartMerge(value, structuredClone(nativeGet(bundle.updates, segs)));
        }
    }
    return value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29tbWl0TG9nVXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL21lbW9yeS9jb21taXRMb2dVdGlscy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7R0FLRztBQUVILE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxjQUFjLENBQUM7QUFFekMsT0FBTyxFQUFFLGNBQWMsRUFBRSxLQUFLLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFbkQsK0VBQStFO0FBQy9FLE1BQU0sVUFBVSxVQUFVLENBQUMsU0FBeUIsRUFBRSxPQUFlLEVBQUUsR0FBWTtJQUNqRixPQUFPLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLEtBQUssT0FBTyxJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZHLENBQUM7QUFFRCxtQ0FBbUM7QUFDbkMsTUFBTSxVQUFVLFdBQVcsQ0FBQyxTQUF5QixFQUFFLE9BQWU7SUFDcEUsT0FBTyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxLQUFLLE9BQU8sQ0FBQyxDQUFDO0FBQ3hELENBQUM7QUFFRCx5RUFBeUU7QUFDekUsTUFBTSxVQUFVLGNBQWMsQ0FBQyxTQUF5QixFQUFFLEdBQVcsRUFBRSxTQUFrQjtJQUN2RixNQUFNLEdBQUcsR0FBRyxTQUFTLElBQUksU0FBUyxDQUFDLE1BQU0sQ0FBQztJQUMxQyxLQUFLLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQ2xDLElBQUksU0FBUyxD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WUFDTixLQUFLLEdBQUcsY0FBYyxDQUFDLEtBQUssRUFBRSxlQUFlLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2xGLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUeXBlZCB1dGlsaXRpZXMgZm9yIHF1ZXJ5aW5nIHRoZSBjb21taXQgbG9nLlxuICpcbiAqIFRoZSBjb21taXRMb2cgaXMgYW4gb3JkZXJlZCBhcnJheSBvZiBDb21taXRCdW5kbGUg4oCUIG9uZSBwZXIgc3RhZ2UgY29tbWl0LlxuICogVGhlc2UgaGVscGVycyBwcm92aWRlIHR5cGUtc2FmZSBxdWVyaWVzIHdpdGhvdXQgKGI6IGFueSkgY2FzdHMuXG4gKi9cblxuaW1wb3J0IHsgbmF0aXZlR2V0IH0gZnJvbSAnLi9wYXRoT3BzLmpzJztcbmltcG9ydCB0eXBlIHsgQ29tbWl0QnVuZGxlIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5pbXBvcnQgeyBkZWVwU21hcnRNZXJnZSwgREVMSU0gfSBmcm9tICcuL3V0aWxzLmpzJztcblxuLyoqIEZpbmQgdGhlIGZpcnN0IGNvbW1pdCBieSBzdGFnZUlkLCBvcHRpb25hbGx5IGZpbHRlcmluZyBieSBhIHdyaXR0ZW4ga2V5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRDb21taXQoY29tbWl0TG9nOiBDb21taXRCdW5kbGVbXSwgc3RhZ2VJZDogc3RyaW5nLCBrZXk/OiBzdHJpbmcpOiBDb21taXRCdW5kbGUgfCB1bmRlZmluZWQge1xuICByZXR1cm4gY29tbWl0TG9nLmZpbmQoKGIpID0+IGIuc3RhZ2VJZCA9PT0gc3RhZ2VJZCAmJiAoIWtleSB8fCBiLnRyYWNlLnNvbWUoKHQpID0+IHQucGF0aCA9PT0ga2V5KSkpO1xufVxuXG4vKiogRmluZCBhbGwgY29tbWl0cyBieSBzdGFnZUlkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRDb21taXRzKGNvbW1pdExvZzogQ29tbWl0QnVuZGxlW10sIHN0YWdlSWQ6IHN0cmluZyk6IENvbW1pdEJ1bmRsZVtdIHtcbiAgcmV0dXJuIGNvbW1pdExvZy5maWx0ZXIoKGIpID0+IGIuc3RhZ2VJZCA9PT0gc3RhZ2VJZCk7XG59XG5cbi8qKiBGaW5kIHRoZSBsYXN0IGNvbW1pdCB0aGF0IHdyb3RlIGEgc3BlY2lmaWMga2V5IChmb3IgYmFja3RyYWNraW5nKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTGFzdFdyaXRlcihjb21taXRMb2c6IENvbW1pdEJ1bmRsZVtdLCBrZXk6IHN0cmluZywgYmVmb3JlSWR4PzogbnVtYmVyKTogQ29tbWl0QnVuZGxlIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgZW5kID0gYmVmb3JlSWR4ID8/IGNvbW1pdExvZy5sZW5ndGg7XG4gIGZvciAobGV0IGkgPSBlbmQgLSAxOyBpID49IDA7IGktLSkge1xuICAgIGlmIChjb21taXRMb2dbaV0udHJhY2Uuc29tZSgodCkgPT4gdC5wYXRoID09PSBrZXkpKSB7XG4gICAgICByZXR1cm4gY29tbWl0TG9nW2ldO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFJlY29uc3RydWN0IHRoZSBGVUxMIHZhbHVlIG9mIGBrZXlgIGFzIG9mIGNvbW1pdCBhcnJheSBpbmRleCBgaWR4YFxuICogKGluY2x1c2l2ZSkg4oCUIHRoZSBtaWdyYXRpb24gaGVscGVyIGZvciB0aGUgXCJyZWFkIGBidW5kbGUub3ZlcndyaXRlW2tleV1gXG4gKiBhcyB0aGUgZnVsbCB2YWx1ZSB3cml0dGVuXCIgcGF0dGVybiAoIzEzYy1CKS5cbiAqXG4gKiBVbmRlciBgY29tbWl0VmFsdWVzOiAnZGVsdGEnYCwgYW4gYGFwcGVuZGAgYnVuZGxlJ3MgYG92ZXJ3cml0ZVtrZXldYCBob2xkc1xuICogb25seSB0aGUgVEFJTCBvZiB0aGUgYXJyYXk7IHRoaXMgaGVscGVyIGZvbGRzIHRoZSB2ZXJicyBiYWNrIHRvZ2V0aGVyOlxuICogaXQgc2NhbnMgYGNvbW1pdExvZ1swLi5pZHhdYCBmb3IgdHJhY2UgZW50cmllcyBvbiBga2V5YCwgYW5jaG9ycyBhdCB0aGVcbiAqIGxhdGVzdCBmdWxsLXZhbHVlIHdyaXRlIChgc2V0YCDigJQgb3IgYGRlbGV0ZWAsIHdoaWNoIHJlc2V0cyB0byBhYnNlbnQpLCBhbmRcbiAqIHJlcGxheXMgZm9yd2FyZCAoYGFwcGVuZGAg4oaSIGNvbmNhdCwgYG1lcmdlYCDihpIgYGRlZXBTbWFydE1lcmdlYCkg4oCUIGV4YWN0bHlcbiAqIHRoZSBwZXIta2V5IHNsaWNlIG9mIGBhcHBseVNtYXJ0TWVyZ2VgJ3MgcmVwbGF5LCBPKGtleSdzIGNvbW1pdCBzcGFuKVxuICogaW5zdGVhZCBvZiBhIGZ1bGwgYG1hdGVyaWFsaXNlKClgLlxuICpcbiAqIFdvcmtzIG9uIGZ1bGwtbW9kZSBsb2dzIHRvbyAoZXZlcnkgYHNldGAgaXMgaXRzIG93biBhbmNob3Ig4oCUIGVxdWl2YWxlbnQgdG9cbiAqIGBmaW5kTGFzdFdyaXRlciguLi4pLm92ZXJ3cml0ZVtrZXldYCkuXG4gKlxuICogQHBhcmFtIGtleSAgTWF0Y2hlZCBhZ2FpbnN0IGBUcmFjZUVudHJ5LnBhdGhgIGV4YWN0bHkgKHNhbWUgY29udHJhY3QgYXNcbiAqICAgYGZpbmRMYXN0V3JpdGVyYCkg4oCUIERFTElNLWpvaW5lZCBmb3IgbmVzdGVkIHBhdGhzLlxuICogQHBhcmFtIGlkeCAgQ29tbWl0QnVuZGxlIEFSUkFZIGluZGV4ICh0aGUgYGJ1bmRsZS5pZHhgIHBvc2l0aW9uKSxcbiAqICAgaW5jbHVzaXZlLiBOT1QgdGhlIGV4ZWN1dGlvbkluZGV4IGZyb20gYSBydW50aW1lU3RhZ2VJZC5cbiAqIEByZXR1cm5zIFRoZSByZWNvbnN0cnVjdGVkIHZhbHVlIChhIGRldGFjaGVkIGNsb25lKSwgb3IgYHVuZGVmaW5lZGAgd2hlblxuICogICB0aGUga2V5IHdhcyBuZXZlciB3cml0dGVuIGluIGBjb21taXRMb2dbMC4uaWR4XWAgb3IgaXRzIGxhc3Qgd3JpdGUgd2FzIGFcbiAqICAgZGVsZXRlLiBDYXZlYXQ6IHZhbHVlcyBkZXJpdmVkIHB1cmVseSBmcm9tIHRoZSBydW4ncyBJTklUSUFMIHN0YXRlIChub1xuICogICBgc2V0YCBhbmNob3IgaW4gdGhlIGxvZyDigJQgZS5nLiBtZXJnZXMgb250byBhIHNlZWRlZCBrZXkpIGZvbGQgZnJvbVxuICogICBhYnNlbnQ7IHRoZSBjb21taXQgbG9nIGFsb25lIGNhbm5vdCBzZWUgdGhlIHByZS1ydW4gYmFzZSAodGhlIHNhbWUgYmxpbmRcbiAqICAgc3BvdCBgZmluZExhc3RXcml0ZXJgIGhhcykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21taXRWYWx1ZUF0KGNvbW1pdExvZzogQ29tbWl0QnVuZGxlW10sIGlkeDogbnVtYmVyLCBrZXk6IHN0cmluZyk6IHVua25vd24ge1xuICBjb25zdCBlbmQgPSBNYXRoLm1pbihpZHgsIGNvbW1pdExvZy5sZW5ndGggLSAxKTtcbiAgY29uc3Qgc2VncyA9IGtleS5zcGxpdChERUxJTSk7XG5cbiAgLy8gQ29sbGVjdCBldmVyeSB0cmFjZSBlbnRyeSB0b3VjaGluZyB0aGUga2V5IChpbiBvcmRlcikgdXAgdG8gYGVuZGAuXG4gIGNvbnN0IHRvdWNoZXM6IHsgdmVyYjogc3RyaW5nOyBidW5kbGU6IENvbW1pdEJ1bmRsZSB9W10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPD0gZW5kOyBpKyspIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgY29tbWl0TG9nW2ldLnRyYWNlKSB7XG4gICAgICBpZiAodC5wYXRoID09PSBrZXkpIHRvdWNoZXMucHVzaCh7IHZlcmI6IHQudmVyYiwgYnVuZGxlOiBjb21taXRMb2dbaV0gfSk7XG4gICAgfVxuICB9XG4gIGlmICh0b3VjaGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAvLyBBbmNob3IgYXQgdGhlIGxhdGVzdCBlbnRyeSB0aGF0IGZ1bGx5IGRldGVybWluZXMgdGhlIHZhbHVlIG9uIGl0cyBvd24uXG4gIGxldCBzdGFydCA9IDA7XG4gIGZvciAobGV0IGkgPSB0b3VjaGVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKHRvdWNoZXNbaV0udmVyYiA9PT0gJ3NldCcgfHwgdG91Y2hlc1tpXS52ZXJiID09PSAnZGVsZXRlJykge1xuICAgICAgc3RhcnQgPSBpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgLy8gRm9sZCBmb3J3YXJkIGZyb20gdGhlIGFuY2hvciDigJQgdGhlIHBlci1rZXkgc2xpY2Ugb2YgYXBwbHlTbWFydE1lcmdlLlxuICBsZXQgdmFsdWU6IHVua25vd247XG4gIGZvciAobGV0IGkgPSBzdGFydDsgaSA8IHRvdWNoZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB7IHZlcmIsIGJ1bmRsZSB9ID0gdG91Y2hlc1tpXTtcbiAgICBpZiAodmVyYiA9PT0gJ3NldCcpIHtcbiAgICAgIHZhbHVlID0gc3RydWN0dXJlZENsb25lKG5hdGl2ZUdldChidW5kbGUub3ZlcndyaXRlLCBzZWdzKSk7XG4gICAgfSBlbHNlIGlmICh2ZXJiID09PSAnZGVsZXRlJykge1xuICAgICAgdmFsdWUgPSB1bmRlZmluZWQ7XG4gICAgfSBlbHNlIGlmICh2ZXJiID09PSAnYXBwZW5kJykge1xuICAgICAgY29uc3QgdGFpbCA9IHN0cnVjdHVyZWRDbG9uZShuYXRpdmVHZXQoYnVuZGxlLm92ZXJ3cml0ZSwgc2VncykpO1xuICAgICAgdmFsdWUgPSBBcnJheS5pc0FycmF5KHZhbHVlKSAmJiBBcnJheS5pc0FycmF5KHRhaWwpID8gWy4uLnZhbHVlLCAuLi50YWlsXSA6IHRhaWw7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhbHVlID0gZGVlcFNtYXJ0TWVyZ2UodmFsdWUsIHN0cnVjdHVyZWRDbG9uZShuYXRpdmVHZXQoYnVuZGxlLnVwZGF0ZXMsIHNlZ3MpKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cbiJdfQ==