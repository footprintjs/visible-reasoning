/**
 * slice/elementProvenance.ts — APPEND-FOLD PROVENANCE.
 *
 * THE PROBLEM (why this file exists): in agent charts, almost all dataflow
 * funnels through ONE array key (`history`). A key-level slice on it
 * degenerates to "everything depends on history" — true and useless. The
 * question that actually triages an agent run is element-level:
 * "which stage produced history[7]?".
 *
 * THE INSIGHT: the commit log already contains the answer. Under
 * `commitValues: 'delta'` every array growth is recorded as an `append` verb
 * whose `overwrite[key]` holds exactly the new tail — each element has an
 * explicit birth record. Under `'full'` mode, push-style growth appears as
 * consecutive `set`s where the previous array is a strict prefix of the next
 * — the tail is attributable by inference. No new capture is needed; this is
 * a pure post-hoc query.
 *
 * THE ALGORITHM (append-fold): replay the per-key verb fold — the SAME fold
 * `commitValueAt` runs (set → replace, append → concat, merge → deepSmartMerge,
 * delete → clear) — while carrying a births array kept index-aligned with the
 * value. One difference from `commitValueAt`: that helper ANCHORS at the
 * latest `set`/`delete` as a skip optimization (earlier commits cannot change
 * the final VALUE). Provenance must fold from the FIRST touch, because
 * full-mode growth is a chain of `set`s and the anchor would erase every
 * birth but the last. The final value is identical either way (the fold is
 * deterministic left-to-right) — a property test pins this equivalence.
 *
 * INVARIANT (maintained on every branch): when the folded value is an array,
 * `births.length === value.length` and `births[i]` describes `value[i]`.
 *
 * HONESTY: every birth is labeled with how it was determined
 * ({@link AttributionBasis}) — `'append-verb'` is engine-recorded truth,
 * `'prefix-inference'` is a heuristic (a wholesale replacement that happens
 * to share the old prefix is indistinguishable from an append), and
 * `'whole-value'` is an explicit reset. Absence is honest too: a missing
 * provenance carries a {@link MissingProvenanceReason}, mirroring
 * `VariableSlice.missing` — one absence pattern module-wide.
 *
 * COMPLEXITY: delta-mode logs need no equality checks — O(total elements).
 * Full-mode logs pay a strict-prefix check (deepEqual per element) per
 * full-value touch: O(touches × length) element comparisons worst case.
 * Post-hoc query, off the hot path — acceptable; measured in the perf tests.
 */
import { nativeGet } from '../memory/pathOps.js';
import { deepEqual, deepSmartMerge, DELIM } from '../memory/utils.js';
import { normaliseStateKey } from './sliceForKey.js';
/** `prev` is a strict (leading, element-equal) prefix of `next`. */
function isStrictPrefix(prev, next) {
    if (prev.length > next.length)
        return false;
    for (let i = 0; i < prev.length; i++) {
        if (!deepEqual(prev[i], next[i]))
            return false;
    }
    return true;
}
function birthOf(index, touch, basis, value) {
    return {
        index,
        commitIdx: touch.commitIdx,
        runtimeStageId: touch.bundle.runtimeStageId,
        stageId: touch.bundle.stageId,
        stageName: touch.bundle.stage,
        verb: touch.verb,
        basis,
        value,
    };
}
/**
 * Element-level provenance for one array-valued key: fold the key's commits
 * and return index-aligned birth records for every element.
 *
 * @param key A {@link StateKey}: the top-level key string, or a path array
 *   for nested keys (normalised internally — no engine delimiters needed).
 * @param options.atIdx Inclusive commit array index to fold to (default: the
 *   whole log). NOT the executionIndex from a runtimeStageId.
 * @returns Always an {@link ArrayProvenance}; on failure `missing` says why
 *   (`'not-an-array'` for scalar/deleted/degraded keys — those are
 *   `sliceForKey` territory). Blind spot shared with the whole commit-log
 *   family: elements present in the run's INITIAL state (seeded, never
 *   re-set in range) are invisible here.
 */
export function arrayProvenance(commitLog, key, options) {
    const normalisedKey = normaliseStateKey(key);
    if (commitLog.length === 0)
        return { key: normalisedKey, missing: 'empty-log' };
    const end = Math.min(options?.atIdx ?? commitLog.length - 1, commitLog.length - 1);
    const segs = normalisedKey.split(DELIM);
    // Collect every touch of the key up to `end`, in commit order — the same
    // scan commitValueAt does, plus the commit position for birth records.
    const touches = [];
    for (let i = 0; i <= end; i++) {
        for (const t of commitLog[i].trace) {
            if (t.path === normalisedKey)
                touches.push({ verb: t.verb, bundle: commitLog[i], commitIdx: i });
        }
    }
    if (touches.length === 0)
        return { key: normalisedKey, missing: 'never-written' };
    // The append-fold. `value` mirrors commitValueAt's fold byte-for-byte;
    // `births` is the added provenance track, index-aligned whenever `value`
    // is an array (the module invariant).
    let value;
    let births = [];
    for (const touch of touches) {
        const { verb, bundle } = touch;
        if (verb === 'set') {
            const next = structuredClone(nativeGet(bundle.overwrite, segs));
            births = rebaseBirths(value, next, births, touch, 'prefix-inference');
            value = next;
        }
        else if (verb === 'delete') {
            value = undefined;
            births = [];
        }
        else if (verb === 'append') {
            const tail = structuredClone(nativeGet(bundle.overwrite, segs));
            if (Array.isArray(value) && Array.isArray(tail)) {
                // Engine-recorded tail: exact attribution, no equality checks.
                for (let j = 0; j < tail.length; j++) {
                    births.push(birthOf(value.length + j, touch, 'append-verb', tail[j]));
                }
                value = [...value, ...tail];
            }
            else {
                // Degenerate append onto a non-array, or a non-array tail (e.g. a
                // redacted tail replaced by the '[REDACTED]' string). Mirrors
                // commitValueAt: the tail BECOMES the value. Attribution stays exact.
                value = tail;
                births = Array.isArray(tail) ? tail.map((el, j) => birthOf(j, touch, 'append-verb', el)) : [];
            }
        }
        else {
            // 'merge' — deepSmartMerge (non-mutating: fresh array/object on every
            // path), then re-derive births from the shape change. Note merge's
            // array semantics are UNION-dedup: growth keeps the old prefix (tail
            // attributed by inference); a dedup-shrink is a wholesale rebirth.
            const next = deepSmartMerge(value, structuredClone(nativeGet(bundle.updates, segs)));
            births = rebaseBirths(value, next, births, touch, 'prefix-inference');
            value = next;
        }
    }
    if (!Array.isArray(value))
        return { key: normalisedKey, missing: 'not-an-array' };
    return { key: normalisedKey, atIdx: end, length: value.length, births };
}
/**
 * Re-derive births after a full-value transition (`set`/`merge`):
 * - non-array result → no births (invariant: births track arrays only)
 * - previous array is a strict prefix → keep old births, attribute the tail
 *   to this touch with the given (heuristic) basis
 * - otherwise → wholesale replacement: every element reborn 'whole-value'
 */
function rebaseBirths(prev, next, births, touch, tailBasis) {
    if (!Array.isArray(next))
        return [];
    if (Array.isArray(prev) && isStrictPrefix(prev, next)) {
        const kept = births.slice(0, prev.length);
        for (let i = prev.length; i < next.length; i++) {
            kept.push(birthOf(i, touch, tailBasis, next[i]));
        }
        return kept;
    }
    return next.map((el, i) => birthOf(i, touch, 'whole-value', el));
}
/**
 * Convenience over {@link arrayProvenance}: the birth of ONE element.
 * Returns `undefined` when the key has no array provenance (any
 * {@link MissingProvenanceReason}) or `index` is out of range at `atIdx` —
 * Map.get-like semantics; use {@link arrayProvenance} directly when you need
 * the missing reason.
 *
 * @see ElementBirth
 */
export function elementProvenance(commitLog, key, index, options) {
    const prov = arrayProvenance(commitLog, key, options);
    if (!prov.births || index < 0 || index >= prov.births.length)
        return undefined;
    return prov.births[index];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWxlbWVudFByb3ZlbmFuY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3NsaWNlL2VsZW1lbnRQcm92ZW5hbmNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0EwQ0c7QUFFSCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFakQsT0FBTyxFQUFFLFNBQVMsRUFBRSxjQUFjLEVBQUUsS0FBSyxFQUFFLE1BQU0sb0JBQW9CLENBQUM7QUFDdEUsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFXckQsb0VBQW9FO0FBQ3BFLFNBQVMsY0FBYyxDQUFDLElBQWUsRUFBRSxJQUFlO0lBQ3RELElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQzVDLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7UUFDckMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQUUsT0FBTyxLQUFLLENBQUM7SUFDakQsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2QsQ0FBQztBQUVELFNBQVMsT0FBTyxDQUFDLEtBQWEsRUFBRSxLQUFlLEVBQUUsS0FBdUIsRUFBRSxLQUFjO0lBQ3RGLE9BQU87UUFDTCxLQUFLO1FBQ0wsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1FBQzFCLGNBQWMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLGNBQWM7UUFDM0MsT0FBTyxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsT0FBTztRQUM3QixTQUFTLEVBQUUsS0FBSyxDQUFDLE1B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QUFFLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUN0RCxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sSUFBSSxLQUFLLEdBQUcsQ0FBQyxJQUFJLEtBQUssSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU07UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUMvRSxPQUFPLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDNUIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogc2xpY2UvZWxlbWVudFByb3ZlbmFuY2UudHMg4oCUIEFQUEVORC1GT0xEIFBST1ZFTkFOQ0UuXG4gKlxuICogVEhFIFBST0JMRU0gKHdoeSB0aGlzIGZpbGUgZXhpc3RzKTogaW4gYWdlbnQgY2hhcnRzLCBhbG1vc3QgYWxsIGRhdGFmbG93XG4gKiBmdW5uZWxzIHRocm91Z2ggT05FIGFycmF5IGtleSAoYGhpc3RvcnlgKS4gQSBrZXktbGV2ZWwgc2xpY2Ugb24gaXRcbiAqIGRlZ2VuZXJhdGVzIHRvIFwiZXZlcnl0aGluZyBkZXBlbmRzIG9uIGhpc3RvcnlcIiDigJQgdHJ1ZSBhbmQgdXNlbGVzcy4gVGhlXG4gKiBxdWVzdGlvbiB0aGF0IGFjdHVhbGx5IHRyaWFnZXMgYW4gYWdlbnQgcnVuIGlzIGVsZW1lbnQtbGV2ZWw6XG4gKiBcIndoaWNoIHN0YWdlIHByb2R1Y2VkIGhpc3RvcnlbN10/XCIuXG4gKlxuICogVEhFIElOU0lHSFQ6IHRoZSBjb21taXQgbG9nIGFscmVhZHkgY29udGFpbnMgdGhlIGFuc3dlci4gVW5kZXJcbiAqIGBjb21taXRWYWx1ZXM6ICdkZWx0YSdgIGV2ZXJ5IGFycmF5IGdyb3d0aCBpcyByZWNvcmRlZCBhcyBhbiBgYXBwZW5kYCB2ZXJiXG4gKiB3aG9zZSBgb3ZlcndyaXRlW2tleV1gIGhvbGRzIGV4YWN0bHkgdGhlIG5ldyB0YWlsIOKAlCBlYWNoIGVsZW1lbnQgaGFzIGFuXG4gKiBleHBsaWNpdCBiaXJ0aCByZWNvcmQuIFVuZGVyIGAnZnVsbCdgIG1vZGUsIHB1c2gtc3R5bGUgZ3Jvd3RoIGFwcGVhcnMgYXNcbiAqIGNvbnNlY3V0aXZlIGBzZXRgcyB3aGVyZSB0aGUgcHJldmlvdXMgYXJyYXkgaXMgYSBzdHJpY3QgcHJlZml4IG9mIHRoZSBuZXh0XG4gKiDigJQgdGhlIHRhaWwgaXMgYXR0cmlidXRhYmxlIGJ5IGluZmVyZW5jZS4gTm8gbmV3IGNhcHR1cmUgaXMgbmVlZGVkOyB0aGlzIGlzXG4gKiBhIHB1cmUgcG9zdC1ob2MgcXVlcnkuXG4gKlxuICogVEhFIEFMR09SSVRITSAoYXBwZW5kLWZvbGQpOiByZXBsYXkgdGhlIHBlci1rZXkgdmVyYiBmb2xkIOKAlCB0aGUgU0FNRSBmb2xkXG4gKiBgY29tbWl0VmFsdWVBdGAgcnVucyAoc2V0IOKGkiByZXBsYWNlLCBhcHBlbmQg4oaSIGNvbmNhdCwgbWVyZ2Ug4oaSIGRlZXBTbWFydE1lcmdlLFxuICogZGVsZXRlIOKGkiBjbGVhcikg4oCUIHdoaWxlIGNhcnJ5aW5nIGEgYmlydGhzIGFycmF5IGtlcHQgaW5kZXgtYWxpZ25lZCB3aXRoIHRoZVxuICogdmFsdWUuIE9uZSBkaWZmZXJlbmNlIGZyb20gYGNvbW1pdFZhbHVlQXRgOiB0aGF0IGhlbHBlciBBTkNIT1JTIGF0IHRoZVxuICogbGF0ZXN0IGBzZXRgL2BkZWxldGVgIGFzIGEgc2tpcCBvcHRpbWl6YXRpb24gKGVhcmxpZXIgY29tbWl0cyBjYW5ub3QgY2hhbmdlXG4gKiB0aGUgZmluYWwgVkFMVUUpLiBQcm92ZW5hbmNlIG11c3QgZm9sZCBmcm9tIHRoZSBGSVJTVCB0b3VjaCwgYmVjYXVzZVxuICogZnVsbC1tb2RlIGdyb3d0aCBpcyBhIGNoYWluIG9mIGBzZXRgcyBhbmQgdGhlIGFuY2hvciB3b3VsZCBlcmFzZSBldmVyeVxuICogYmlydGggYnV0IHRoZSBsYXN0LiBUaGUgZmluYWwgdmFsdWUgaXMgaWRlbnRpY2FsIGVpdGhlciB3YXkgKHRoZSBmb2xkIGlzXG4gKiBkZXRlcm1pbmlzdGljIGxlZnQtdG8tcmlnaHQpIOKAlCBhIHByb3BlcnR5IHRlc3QgcGlucyB0aGlzIGVxdWl2YWxlbmNlLlxuICpcbiAqIElOVkFSSUFOVCAobWFpbnRhaW5lZCBvbiBldmVyeSBicmFuY2gpOiB3aGVuIHRoZSBmb2xkZWQgdmFsdWUgaXMgYW4gYXJyYXksXG4gKiBgYmlydGhzLmxlbmd0aCA9PT0gdmFsdWUubGVuZ3RoYCBhbmQgYGJpcnRoc1tpXWAgZGVzY3JpYmVzIGB2YWx1ZVtpXWAuXG4gKlxuICogSE9ORVNUWTogZXZlcnkgYmlydGggaXMgbGFiZWxlZCB3aXRoIGhvdyBpdCB3YXMgZGV0ZXJtaW5lZFxuICogKHtAbGluayBBdHRyaWJ1dGlvbkJhc2lzfSkg4oCUIGAnYXBwZW5kLXZlcmInYCBpcyBlbmdpbmUtcmVjb3JkZWQgdHJ1dGgsXG4gKiBgJ3ByZWZpeC1pbmZlcmVuY2UnYCBpcyBhIGhldXJpc3RpYyAoYSB3aG9sZXNhbGUgcmVwbGFjZW1lbnQgdGhhdCBoYXBwZW5zXG4gKiB0byBzaGFyZSB0aGUgb2xkIHByZWZpeCBpcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGFuIGFwcGVuZCksIGFuZFxuICogYCd3aG9sZS12YWx1ZSdgIGlzIGFuIGV4cGxpY2l0IHJlc2V0LiBBYnNlbmNlIGlzIGhvbmVzdCB0b286IGEgbWlzc2luZ1xuICogcHJvdmVuYW5jZSBjYXJyaWVzIGEge0BsaW5rIE1pc3NpbmdQcm92ZW5hbmNlUmVhc29ufSwgbWlycm9yaW5nXG4gKiBgVmFyaWFibGVTbGljZS5taXNzaW5nYCDigJQgb25lIGFic2VuY2UgcGF0dGVybiBtb2R1bGUtd2lkZS5cbiAqXG4gKiBDT01QTEVYSVRZOiBkZWx0YS1tb2RlIGxvZ3MgbmVlZCBubyBlcXVhbGl0eSBjaGVja3Mg4oCUIE8odG90YWwgZWxlbWVudHMpLlxuICogRnVsbC1tb2RlIGxvZ3MgcGF5IGEgc3RyaWN0LXByZWZpeCBjaGVjayAoZGVlcEVxdWFsIHBlciBlbGVtZW50KSBwZXJcbiAqIGZ1bGwtdmFsdWUgdG91Y2g6IE8odG91Y2hlcyDDlyBsZW5ndGgpIGVsZW1lbnQgY29tcGFyaXNvbnMgd29yc3QgY2FzZS5cbiAqIFBvc3QtaG9jIHF1ZXJ5LCBvZmYgdGhlIGhvdCBwYXRoIOKAlCBhY2NlcHRhYmxlOyBtZWFzdXJlZCBpbiB0aGUgcGVyZiB0ZXN0cy5cbiAqL1xuXG5pbXBvcnQgeyBuYXRpdmVHZXQgfSBmcm9tICcuLi9tZW1vcnkvcGF0aE9wcy5qcyc7XG5pbXBvcnQgdHlwZSB7IENvbW1pdEJ1bmRsZSwgVHJhY2VFbnRyeSB9IGZyb20gJy4uL21lbW9yeS90eXBlcy5qcyc7XG5pbXBvcnQgeyBkZWVwRXF1YWwsIGRlZXBTbWFydE1lcmdlLCBERUxJTSB9IGZyb20gJy4uL21lbW9yeS91dGlscy5qcyc7XG5pbXBvcnQgeyBub3JtYWxpc2VTdGF0ZUtleSB9IGZyb20gJy4vc2xpY2VGb3JLZXkuanMnO1xuaW1wb3J0IHR5cGUgeyBBcnJheVByb3ZlbmFuY2UsIEF0dHJpYnV0aW9uQmFzaXMsIEVsZW1lbnRCaXJ0aCwgU3RhdGVLZXkgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLyoqIE9uZSBwZXIta2V5IHRvdWNoIG9mIHRoZSBjb21taXQgbG9nLCBpbiBjb21taXQgb3JkZXIuICovXG5pbnRlcmZhY2UgS2V5VG91Y2gge1xuICB2ZXJiOiBUcmFjZUVudHJ5Wyd2ZXJiJ107XG4gIGJ1bmRsZTogQ29tbWl0QnVuZGxlO1xuICAvKiogQ29tbWl0IEFSUkFZIHBvc2l0aW9uICg9PSBgYnVuZGxlLmlkeGAgZm9yIGVuZ2luZS1wcm9kdWNlZCBsb2dzKS4gKi9cbiAgY29tbWl0SWR4OiBudW1iZXI7XG59XG5cbi8qKiBgcHJldmAgaXMgYSBzdHJpY3QgKGxlYWRpbmcsIGVsZW1lbnQtZXF1YWwpIHByZWZpeCBvZiBgbmV4dGAuICovXG5mdW5jdGlvbiBpc1N0cmljdFByZWZpeChwcmV2OiB1bmtub3duW10sIG5leHQ6IHVua25vd25bXSk6IGJvb2xlYW4ge1xuICBpZiAocHJldi5sZW5ndGggPiBuZXh0Lmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHByZXYubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoIWRlZXBFcXVhbChwcmV2W2ldLCBuZXh0W2ldKSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBiaXJ0aE9mKGluZGV4OiBudW1iZXIsIHRvdWNoOiBLZXlUb3VjaCwgYmFzaXM6IEF0dHJpYnV0aW9uQmFzaXMsIHZhbHVlOiB1bmtub3duKTogRWxlbWVudEJpcnRoIHtcbiAgcmV0dXJuIHtcbiAgICBpbmRleCxcbiAgICBjb21taXRJZHg6IHRvdWNoLmNvbW1pdElkeCxcbiAgICBydW50aW1lU3RhZ2VJZDogdG91Y2guYnVuZGxlLnJ1bnRpbWVTdGFnZUlkLFxuICAgIHN0YWdlSWQ6IHRvdWNoLmJ1bmRsZS5zdGFnZUlkLFxuICAgIHN0YWdlTmFtZTogdG91Y2guYnVuZGxlLnN0YWdlLFxuICAgIHZlcmI6IHRvdWNoLnZlcmIsXG4gICAgYmFzaXMsXG4gICAgdmFsdWUsXG4gIH07XG59XG5cbi8qKlxuICogRWxlbWVudC1sZXZlbCBwcm92ZW5hbmNlIGZvciBvbmUgYXJyYXktdmFsdWVkIGtleTogZm9sZCB0aGUga2V5J3MgY29tbWl0c1xuICogYW5kIHJldHVybiBpbmRleC1hbGlnbmVkIGJpcnRoIHJlY29yZHMgZm9yIGV2ZXJ5IGVsZW1lbnQuXG4gKlxuICogQHBhcmFtIGtleSBBIHtAbGluayBTdGF0ZUtleX06IHRoZSB0b3AtbGV2ZWwga2V5IHN0cmluZywgb3IgYSBwYXRoIGFycmF5XG4gKiAgIGZvciBuZXN0ZWQga2V5cyAobm9ybWFsaXNlZCBpbnRlcm5hbGx5IOKAlCBubyBlbmdpbmUgZGVsaW1pdGVycyBuZWVkZWQpLlxuICogQHBhcmFtIG9wdGlvbnMuYXRJZHggSW5jbHVzaXZlIGNvbW1pdCBhcnJheSBpbmRleCB0byBmb2xkIHRvIChkZWZhdWx0OiB0aGVcbiAqICAgd2hvbGUgbG9nKS4gTk9UIHRoZSBleGVjdXRpb25JbmRleCBmcm9tIGEgcnVudGltZVN0YWdlSWQuXG4gKiBAcmV0dXJucyBBbHdheXMgYW4ge0BsaW5rIEFycmF5UHJvdmVuYW5jZX07IG9uIGZhaWx1cmUgYG1pc3NpbmdgIHNheXMgd2h5XG4gKiAgIChgJ25vdC1hbi1hcnJheSdgIGZvciBzY2FsYXIvZGVsZXRlZC9kZWdyYWRlZCBrZXlzIOKAlCB0aG9zZSBhcmVcbiAqICAgYHNsaWNlRm9yS2V5YCB0ZXJyaXRvcnkpLiBCbGluZCBzcG90IHNoYXJlZCB3aXRoIHRoZSB3aG9sZSBjb21taXQtbG9nXG4gKiAgIGZhbWlseTogZWxlbWVudHMgcHJlc2VudCBpbiB0aGUgcnVuJ3MgSU5JVElBTCBzdGF0ZSAoc2VlZGVkLCBuZXZlclxuICogICByZS1zZXQgaW4gcmFuZ2UpIGFyZSBpbnZpc2libGUgaGVyZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFycmF5UHJvdmVuYW5jZShcbiAgY29tbWl0TG9nOiBDb21taXRCdW5kbGVbXSxcbiAga2V5OiBTdGF0ZUtleSxcbiAgb3B0aW9ucz86IHsgYXRJZHg/OiBudW1iZXIgfSxcbik6IEFycmF5UHJvdmVuYW5jZSB7XG4gIGNvbnN0IG5vcm1hbGlzZWRLZXkgPSBub3JtYWxpc2VTdGF0ZUtleShrZXkpO1xuICBpZiAoY29tbWl0TG9nLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsga2V5OiBub3JtYWxpc2VkS2V5LCBtaXNzaW5nOiAnZW1wdHktbG9nJyB9O1xuICBjb25zdCBlbmQgPSBNYXRoLm1pbihvcHRpb25zPy5hdElkeCA/PyBjb21taXRMb2cubGVuZ3RoIC0gMSwgY29tbWl0TG9nLmxlbmd0aCAtIDEpO1xuICBjb25zdCBzZWdzID0gbm9ybWFsaXNlZEtleS5zcGxpdChERUxJTSk7XG5cbiAgLy8gQ29sbGVjdCBldmVyeSB0b3VjaCBvZiB0aGUga2V5IHVwIHRvIGBlbmRgLCBpbiBjb21taXQgb3JkZXIg4oCUIHRoZSBzYW1lXG4gIC8vIHNjYW4gY29tbWl0VmFsdWVBdCBkb2VzLCBwbHVzIHRoZSBjb21taXQgcG9zaXRpb24gZm9yIGJpcnRoIHJlY29yZHMuXG4gIGNvbnN0IHRvdWNoZXM6IEtleVRvdWNoW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPD0gZW5kOyBpKyspIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgY29tbWl0TG9nW2ldLnRyYWNlKSB7XG4gICAgICBpZiAodC5wYXRoID09PSBub3JtYWxpc2VkS2V5KSB0b3VjaGVzLnB1c2goeyB2ZXJiOiB0LnZlcmIsIGJ1bmRsZTogY29tbWl0TG9nW2ldLCBjb21taXRJZHg6IGkgfSk7XG4gICAgfVxuICB9XG4gIGlmICh0b3VjaGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsga2V5OiBub3JtYWxpc2VkS2V5LCBtaXNzaW5nOiAnbmV2ZXItd3JpdHRlbicgfTtcblxuICAvLyBUaGUgYXBwZW5kLWZvbGQuIGB2YWx1ZWAgbWlycm9ycyBjb21taXRWYWx1ZUF0J3MgZm9sZCBieXRlLWZvci1ieXRlO1xuICAvLyBgYmlydGhzYCBpcyB0aGUgYWRkZWQgcHJvdmVuYW5jZSB0cmFjaywgaW5kZXgtYWxpZ25lZCB3aGVuZXZlciBgdmFsdWVgXG4gIC8vIGlzIGFuIGFycmF5ICh0aGUgbW9kdWxlIGludmFyaWFudCkuXG4gIGxldCB2YWx1ZTogdW5rbm93bjtcbiAgbGV0IGJpcnRoczogRWxlbWVudEJpcnRoW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHRvdWNoIG9mIHRvdWNoZXMpIHtcbiAgICBjb25zdCB7IHZlcmIsIGJ1bmRsZSB9ID0gdG91Y2g7XG4gICAgaWYgKHZlcmIgPT09ICdzZXQnKSB7XG4gICAgICBjb25zdCBuZXh0ID0gc3RydWN0dXJlZENsb25lKG5hdGl2ZUdldChidW5kbGUub3ZlcndyaXRlLCBzZWdzKSk7XG4gICAgICBiaXJ0aHMgPSByZWJhc2VCaXJ0aHModmFsdWUsIG5leHQsIGJpcnRocywgdG91Y2gsICdwcmVmaXgtaW5mZXJlbmNlJyk7XG4gICAgICB2YWx1ZSA9IG5leHQ7XG4gICAgfSBlbHNlIGlmICh2ZXJiID09PSAnZGVsZXRlJykge1xuICAgICAgdmFsdWUgPSB1bmRlZmluZWQ7XG4gICAgICBiaXJ0aHMgPSBbXTtcbiAgICB9IGVsc2UgaWYgKHZlcmIgPT09ICdhcHBlbmQnKSB7XG4gICAgICBjb25zdCB0YWlsID0gc3RydWN0dXJlZENsb25lKG5hdGl2ZUdldChidW5kbGUub3ZlcndyaXRlLCBzZWdzKSk7XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkgJiYgQXJyYXkuaXNBcnJheSh0YWlsKSkge1xuICAgICAgICAvLyBFbmdpbmUtcmVjb3JkZWQgdGFpbDogZXhhY3QgYXR0cmlidXRpb24sIG5vIGVxdWFsaXR5IGNoZWNrcy5cbiAgICAgICAgZm9yIChsZXQgaiA9IDA7IGogPCB0YWlsLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgYmlydGhzLnB1c2goYmlydGhPZih2YWx1ZS5sZW5ndGggKyBqLCB0b3VjaCwgJ2FwcGVuZC12ZXJiJywgdGFpbFtqXSkpO1xuICAgICAgICB9XG4gICAgICAgIHZhbHVlID0gWy4uLnZhbHVlLCAuLi50YWlsXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIERlZ2VuZXJhdGUgYXBwZW5kIG9udG8gYSBub24tYXJyYXksIG9yIGEgbm9uLWFycmF5IHRhaWwgKGUuZy4gYVxuICAgICAgICAvLyByZWRhY3RlZCB0YWlsIHJlcGxhY2VkIGJ5IHRoZSAnW1JFREFDVEVEXScgc3RyaW5nKS4gTWlycm9yc1xuICAgICAgICAvLyBjb21taXRWYWx1ZUF0OiB0aGUgdGFpbCBCRUNPTUVTIHRoZSB2YWx1ZS4gQXR0cmlidXRpb24gc3RheXMgZXhhY3QuXG4gICAgICAgIHZhbHVlID0gdGFpbDtcbiAgICAgICAgYmlydGhzID0gQXJyYXkuaXNBcnJheSh0YWlsKSA/IHRhaWwubWFwKChlbCwgaikgPT4gYmlydGhPZihqLCB0b3VjaCwgJ2FwcGVuZC12ZXJiJywgZWwpKSA6IFtdO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyAnbWVyZ2UnIOKAlCBkZWVwU21hcnRNZXJnZSAobm9uLW11dGF0aW5nOiBmcmVzaCBhcnJheS9vYmplY3Qgb24gZXZlcnlcbiAgICAgIC8vIHBhdGgpLCB0aGVuIHJlLWRlcml2ZSBiaXJ0aHMgZnJvbSB0aGUgc2hhcGUgY2hhbmdlLiBOb3RlIG1lcmdlJ3NcbiAgICAgIC8vIGFycmF5IHNlbWFudGljcyBhcmUgVU5JT04tZGVkdXA6IGdyb3d0aCBrZWVwcyB0aGUgb2xkIHByZWZpeCAodGFpbFxuICAgICAgLy8gYXR0cmlidXRlZCBieSBpbmZlcmVuY2UpOyBhIGRlZHVwLXNocmluayBpcyBhIHdob2xlc2FsZSByZWJpcnRoLlxuICAgICAgY29uc3QgbmV4dCA9IGRlZXBTbWFydE1lcmdlKHZhbHVlLCBzdHJ1Y3R1cmVkQ2xvbmUobmF0aXZlR2V0KGJ1bmRsZS51cGRhdGVzLCBzZWdzKSkpO1xuICAgICAgYmlydGhzID0gcmViYXNlQmlydGhzKHZhbHVlLCBuZXh0LCBiaXJ0aHMsIHRvdWNoLCAncHJlZml4LWluZmVyZW5jZScpO1xuICAgICAgdmFsdWUgPSBuZXh0O1xuICAgIH1cbiAgfVxuXG4gIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB7IGtleTogbm9ybWFsaXNlZEtleSwgbWlzc2luZzogJ25vdC1hbi1hcnJheScgfTtcbiAgcmV0dXJuIHsga2V5OiBub3JtYWxpc2VkS2V5LCBhdElkeDogZW5kLCBsZW5ndGg6IHZhbHVlLmxlbmd0aCwgYmlydGhzIH07XG59XG5cbi8qKlxuICogUmUtZGVyaXZlIGJpcnRocyBhZnRlciBhIGZ1bGwtdmFsdWUgdHJhbnNpdGlvbiAoYHNldGAvYG1lcmdlYCk6XG4gKiAtIG5vbi1hcnJheSByZXN1bHQg4oaSIG5vIGJpcnRocyAoaW52YXJpYW50OiBiaXJ0aHMgdHJhY2sgYXJyYXlzIG9ubHkpXG4gKiAtIHByZXZpb3VzIGFycmF5IGlzIGEgc3RyaWN0IHByZWZpeCDihpIga2VlcCBvbGQgYmlydGhzLCBhdHRyaWJ1dGUgdGhlIHRhaWxcbiAqICAgdG8gdGhpcyB0b3VjaCB3aXRoIHRoZSBnaXZlbiAoaGV1cmlzdGljKSBiYXNpc1xuICogLSBvdGhlcndpc2Ug4oaSIHdob2xlc2FsZSByZXBsYWNlbWVudDogZXZlcnkgZWxlbWVudCByZWJvcm4gJ3dob2xlLXZhbHVlJ1xuICovXG5mdW5jdGlvbiByZWJhc2VCaXJ0aHMoXG4gIHByZXY6IHVua25vd24sXG4gIG5leHQ6IHVua25vd24sXG4gIGJpcnRoczogRWxlbWVudEJpcnRoW10sXG4gIHRvdWNoOiBLZXlUb3VjaCxcbiAgdGFpbEJhc2lzOiBBdHRyaWJ1dGlvbkJhc2lzLFxuKTogRWxlbWVudEJpcnRoW10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkobmV4dCkpIHJldHVybiBbXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkocHJldikgJiYgaXNTdHJpY3RQcmVmaXgocHJldiwgbmV4dCkpIHtcbiAgICBjb25zdCBrZXB0ID0gYmlydGhzLnNsaWNlKDAsIHByZXYubGVuZ3RoKTtcbiAgICBmb3IgKGxldCBpID0gcHJldi5sZW5ndGg7IGkgPCBuZXh0Lmxlbmd0aDsgaSsrKSB7XG4gICAgICBrZXB0LnB1c2goYmlydGhPZihpLCB0b3VjaCwgdGFpbEJhc2lzLCBuZXh0W2ldKSk7XG4gICAgfVxuICAgIHJldHVybiBrZXB0O1xuICB9XG4gIHJldHVybiBuZXh0Lm1hcCgoZWwsIGkpID0+IGJpcnRoT2YoaSwgdG91Y2gsICd3aG9sZS12YWx1ZScsIGVsKSk7XG59XG5cbi8qKlxuICogQ29udmVuaWVuY2Ugb3ZlciB7QGxpbmsgYXJyYXlQcm92ZW5hbmNlfTogdGhlIGJpcnRoIG9mIE9ORSBlbGVtZW50LlxuICogUmV0dXJucyBgdW5kZWZpbmVkYCB3aGVuIHRoZSBrZXkgaGFzIG5vIGFycmF5IHByb3ZlbmFuY2UgKGFueVxuICoge0BsaW5rIE1pc3NpbmdQcm92ZW5hbmNlUmVhc29ufSkgb3IgYGluZGV4YCBpcyBvdXQgb2YgcmFuZ2UgYXQgYGF0SWR4YCDigJRcbiAqIE1hcC5nZXQtbGlrZSBzZW1hbnRpY3M7IHVzZSB7QGxpbmsgYXJyYXlQcm92ZW5hbmNlfSBkaXJlY3RseSB3aGVuIHlvdSBuZWVkXG4gKiB0aGUgbWlzc2luZyByZWFzb24uXG4gKlxuICogQHNlZSBFbGVtZW50QmlydGhcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsZW1lbnRQcm92ZW5hbmNlKFxuICBjb21taXRMb2c6IENvbW1pdEJ1bmRsZVtdLFxuICBrZXk6IFN0YXRlS2V5LFxuICBpbmRleDogbnVtYmVyLFxuICBvcHRpb25zPzogeyBhdElkeD86IG51bWJlciB9LFxuKTogRWxlbWVudEJpcnRoIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcHJvdiA9IGFycmF5UHJvdmVuYW5jZShjb21taXRMb2csIGtleSwgb3B0aW9ucyk7XG4gIGlmICghcHJvdi5iaXJ0aHMgfHwgaW5kZXggPCAwIHx8IGluZGV4ID49IHByb3YuYmlydGhzLmxlbmd0aCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHByb3YuYmlydGhzW2luZGV4XTtcbn1cbiJdfQ==