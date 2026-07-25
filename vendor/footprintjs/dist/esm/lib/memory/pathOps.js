/**
 * pathOps.ts — Native nested-path helpers (replaces lodash.get/set/has/mergewith)
 *
 * Security contract: all functions guard against prototype-pollution and
 * prototype-chain-read attacks. The DENIED set blocks the three canonical
 * pollution vectors (__proto__, constructor, prototype) on every function.
 *
 * Intentional asymmetry:
 *   - nativeSet  — DENIED check only at each segment. No hasOwnProperty
 *     check is needed because writing always creates an OWN property on `curr`,
 *     which cannot pollute the prototype chain.
 *   - nativeGet / nativeHas — DENIED check + hasOwnProperty at every step.
 *     Reads follow the prototype chain by default (bracket notation), so the
 *     hasOwnProperty guard is required to prevent leaking inherited values
 *     (e.g. Object.prototype, Object constructor, toString).
 *   - mergeContextWins — DENIED check only; Object.keys() is own-enumerable-only
 *     by spec so prototype keys never appear in the iteration.
 *
 * Do NOT "fix" the nativeSet asymmetry by adding hasOwnProperty — it is
 * intentional and would break path creation for new intermediate nodes.
 *
 * Paths may be dot-notation strings or pre-split (string|number)[] arrays.
 */
const DENIED = new Set(['__proto__', 'constructor', 'prototype']);
function toSegments(path) {
    return Array.isArray(path) ? path : path.split('.');
}
/**
 * Get the value at `path` in `obj`, returning `defaultValue` if absent.
 *
 * Security: each path segment is checked against the DENIED list and requires
 * an own property at every step, preventing prototype-chain reads.
 * e.g. nativeGet({}, '__proto__') and nativeGet({}, 'constructor') both return
 * `defaultValue` instead of leaking Object.prototype / the Object constructor.
 */
export function nativeGet(obj, path, defaultValue) {
    const segs = toSegments(path);
    let curr = obj;
    for (const seg of segs) {
        if (curr == null)
            return defaultValue;
        if (DENIED.has(String(seg)))
            return defaultValue;
        if (!Object.prototype.hasOwnProperty.call(curr, seg))
            return defaultValue;
        curr = curr[seg];
    }
    return curr === undefined ? defaultValue : curr;
}
/** Mutate `obj`, setting `value` at `path` (creates intermediate objects). Returns `obj`. */
export function nativeSet(obj, path, value) {
    const segs = toSegments(path);
    let curr = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i];
        if (DENIED.has(String(k)))
            return obj;
        if (curr[k] == null || typeof curr[k] !== 'object') {
            curr[k] = typeof segs[i + 1] === 'number' ? [] : {};
        }
        curr = curr[k];
    }
    const last = segs[segs.length - 1];
    if (DENIED.has(String(last)))
        return obj;
    curr[last] = value;
    return obj;
}
/**
 * Remove the own property at `path` in `obj` (the replay primitive for the
 * `delete` commit verb, #13c-B). No-op when any intermediate segment is
 * missing — deleting an absent key has nothing to remove.
 *
 * Security: same DENIED + hasOwnProperty discipline as nativeGet — every
 * segment is checked, so `nativeDelete(obj, '__proto__x')` and
 * prototype-chain walks are inert.
 */
export function nativeDelete(obj, path) {
    const segs = toSegments(path);
    let curr = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i];
        if (DENIED.has(String(seg)))
            return;
        if (curr == null || typeof curr !== 'object' || !Object.prototype.hasOwnProperty.call(curr, seg))
            return;
        curr = curr[seg];
    }
    const last = segs[segs.length - 1];
    if (DENIED.has(String(last)))
        return;
    if (curr != null && typeof curr === 'object') {
        delete curr[last];
    }
}
/** Returns true if `obj` has an own property at every segment of `path`. */
export function nativeHas(obj, path) {
    const segs = toSegments(path);
    let curr = obj;
    for (let i = 0; i < segs.length; i++) {
        if (curr == null || !Object.prototype.hasOwnProperty.call(curr, segs[i]))
            return false;
        if (i < segs.length - 1)
            curr = curr[segs[i]];
    }
    return true;
}
/**
 * Deep merge where destination wins for any defined value.
 * Fills missing keys from `src`, but never overwrites defined keys in `dst`.
 * Arrays are not recursed — dst array always wins when present.
 *
 * Replaces: `mergeWith(dst, src, (objValue) => objValue !== undefined ? objValue : undefined)`
 */
export function mergeContextWins(dst, src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
        return dst !== undefined ? dst : src;
    }
    const out = dst != null && typeof dst === 'object' ? { ...dst } : {};
    for (const key of Object.keys(src)) {
        if (DENIED.has(key))
            continue;
        const dstVal = out[key];
        if (dstVal !== undefined) {
            // dst wins; recurse only if both sides are plain objects
            if (dstVal !== null &&
                typeof dstVal === 'object' &&
                !Array.isArray(dstVal) &&
                src[key] !== null &&
                typeof src[key] === 'object' &&
                !Array.isArray(src[key])) {
                out[key] = mergeContextWins(dstVal, src[key]);
            }
            // else keep dstVal unchanged
        }
        else {
            out[key] = src[key];
        }
    }
    return out;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aE9wcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvbWVtb3J5L3BhdGhPcHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FzQkc7QUFFSCxNQUFNLE1BQU0sR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxhQUFhLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQztBQUVsRSxTQUFTLFVBQVUsQ0FBQyxJQUFrQztJQUNwRCxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN0RCxDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILE1BQU0sVUFBVSxTQUFTLENBQUMsR0FBUSxFQUFFLElBQWtDLEVBQUUsWUFBa0I7SUFDeEYsTUFBTSxJQUFJLEdBQUcsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzlCLElBQUksSUFBSSxHQUFHLEdBQUcsQ0FBQztJQUNmLEtBQUssTUFBTSxHQUFHLElBQUksSUFBSSxFQUFFLENBQUM7UUFDdkIsSUFBSSxJQUFJLElBQUksSUFBSTtZQUFFLE9BQU8sWUFBWSxDQUFDO1FBQ3RDLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7WUFBRSxPQUFPLFlBQVksQ0FBQztRQUNqRCxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxHQUFHLENBQUM7WUFBRSxPQUFPLFlBQVksQ0FBQztRQUMxRSxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ25CLENBQUM7SUFDRCxPQUFPLElBQUksS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMs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RSxNQUFNLEtBQUssSUFBSTtnQkFDZixPQUFPLE1BQU0sS0FBSyxRQUFRO2dCQUMxQixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDO2dCQUN0QixHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssSUFBSTtnQkFDakIsT0FBTyxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssUUFBUTtnQkFDNUIsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUN4QixDQUFDO2dCQUNELEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxnQkFBZ0IsQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDaEQsQ0FBQztZQUNELDZCQUE2QjtRQUMvQixDQUFDO2FBQU0sQ0FBQztZQUNOLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDdEIsQ0FBQztJQUNILENBQUM7SUFDRCxPQUFPLEdBQUcsQ0FBQztBQUNiLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHBhdGhPcHMudHMg4oCUIE5hdGl2ZSBuZXN0ZWQtcGF0aCBoZWxwZXJzIChyZXBsYWNlcyBsb2Rhc2guZ2V0L3NldC9oYXMvbWVyZ2V3aXRoKVxuICpcbiAqIFNlY3VyaXR5IGNvbnRyYWN0OiBhbGwgZnVuY3Rpb25zIGd1YXJkIGFnYWluc3QgcHJvdG90eXBlLXBvbGx1dGlvbiBhbmRcbiAqIHByb3RvdHlwZS1jaGFpbi1yZWFkIGF0dGFja3MuIFRoZSBERU5JRUQgc2V0IGJsb2NrcyB0aGUgdGhyZWUgY2Fub25pY2FsXG4gKiBwb2xsdXRpb24gdmVjdG9ycyAoX19wcm90b19fLCBjb25zdHJ1Y3RvciwgcHJvdG90eXBlKSBvbiBldmVyeSBmdW5jdGlvbi5cbiAqXG4gKiBJbnRlbnRpb25hbCBhc3ltbWV0cnk6XG4gKiAgIC0gbmF0aXZlU2V0ICDigJQgREVOSUVEIGNoZWNrIG9ubHkgYXQgZWFjaCBzZWdtZW50LiBObyBoYXNPd25Qcm9wZXJ0eVxuICogICAgIGNoZWNrIGlzIG5lZWRlZCBiZWNhdXNlIHdyaXRpbmcgYWx3YXlzIGNyZWF0ZXMgYW4gT1dOIHByb3BlcnR5IG9uIGBjdXJyYCxcbiAqICAgICB3aGljaCBjYW5ub3QgcG9sbHV0ZSB0aGUgcHJvdG90eXBlIGNoYWluLlxuICogICAtIG5hdGl2ZUdldCAvIG5hdGl2ZUhhcyDigJQgREVOSUVEIGNoZWNrICsgaGFzT3duUHJvcGVydHkgYXQgZXZlcnkgc3RlcC5cbiAqICAgICBSZWFkcyBmb2xsb3cgdGhlIHByb3RvdHlwZSBjaGFpbiBieSBkZWZhdWx0IChicmFja2V0IG5vdGF0aW9uKSwgc28gdGhlXG4gKiAgICAgaGFzT3duUHJvcGVydHkgZ3VhcmQgaXMgcmVxdWlyZWQgdG8gcHJldmVudCBsZWFraW5nIGluaGVyaXRlZCB2YWx1ZXNcbiAqICAgICAoZS5nLiBPYmplY3QucHJvdG90eXBlLCBPYmplY3QgY29uc3RydWN0b3IsIHRvU3RyaW5nKS5cbiAqICAgLSBtZXJnZUNvbnRleHRXaW5zIOKAlCBERU5JRUQgY2hlY2sgb25seTsgT2JqZWN0LmtleXMoKSBpcyBvd24tZW51bWVyYWJsZS1vbmx5XG4gKiAgICAgYnkgc3BlYyBzbyBwcm90b3R5cGUga2V5cyBuZXZlciBhcHBlYXIgaW4gdGhlIGl0ZXJhdGlvbi5cbiAqXG4gKiBEbyBOT1QgXCJmaXhcIiB0aGUgbmF0aXZlU2V0IGFzeW1tZXRyeSBieSBhZGRpbmcgaGFzT3duUHJvcGVydHkg4oCUIGl0IGlzXG4gKiBpbnRlbnRpb25hbCBhbmQgd291bGQgYnJlYWsgcGF0aCBjcmVhdGlvbiBmb3IgbmV3IGludGVybWVkaWF0ZSBub2Rlcy5cbiAqXG4gKiBQYXRocyBtYXkgYmUgZG90LW5vdGF0aW9uIHN0cmluZ3Mgb3IgcHJlLXNwbGl0IChzdHJpbmd8bnVtYmVyKVtdIGFycmF5cy5cbiAqL1xuXG5jb25zdCBERU5JRUQgPSBuZXcgU2V0KFsnX19wcm90b19fJywgJ2NvbnN0cnVjdG9yJywgJ3Byb3RvdHlwZSddKTtcblxuZnVuY3Rpb24gdG9TZWdtZW50cyhwYXRoOiBzdHJpbmcgfCAoc3RyaW5nIHwgbnVtYmVyKVtdKTogKHN0cmluZyB8IG51bWJlcilbXSB7XG4gIHJldHVybiBBcnJheS5pc0FycmF5KHBhdGgpID8gcGF0aCA6IHBhdGguc3BsaXQoJy4nKTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIHZhbHVlIGF0IGBwYXRoYCBpbiBgb2JqYCwgcmV0dXJuaW5nIGBkZWZhdWx0VmFsdWVgIGlmIGFic2VudC5cbiAqXG4gKiBTZWN1cml0eTogZWFjaCBwYXRoIHNlZ21lbnQgaXMgY2hlY2tlZCBhZ2FpbnN0IHRoZSBERU5JRUQgbGlzdCBhbmQgcmVxdWlyZXNcbiAqIGFuIG93biBwcm9wZXJ0eSBhdCBldmVyeSBzdGVwLCBwcmV2ZW50aW5nIHByb3RvdHlwZS1jaGFpbiByZWFkcy5cbiAqIGUuZy4gbmF0aXZlR2V0KHt9LCAnX19wcm90b19fJykgYW5kIG5hdGl2ZUdldCh7fSwgJ2NvbnN0cnVjdG9yJykgYm90aCByZXR1cm5cbiAqIGBkZWZhdWx0VmFsdWVgIGluc3RlYWQgb2YgbGVha2luZyBPYmplY3QucHJvdG90eXBlIC8gdGhlIE9iamVjdCBjb25zdHJ1Y3Rvci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUdldChvYmo6IGFueSwgcGF0aDogc3RyaW5nIHwgKHN0cmluZyB8IG51bWJlcilbXSwgZGVmYXVsdFZhbHVlPzogYW55KTogYW55IHtcbiAgY29uc3Qgc2VncyA9IHRvU2VnbWVudHMocGF0aCk7XG4gIGxldCBjdXJyID0gb2JqO1xuICBmb3IgKGNvbnN0IHNlZyBvZiBzZWdzKSB7XG4gICAgaWYgKGN1cnIgPT0gbnVsbCkgcmV0dXJuIGRlZmF1bHRWYWx1ZTtcbiAgICBpZiAoREVOSUVELmhhcyhTdHJpbmcoc2VnKSkpIHJldHVybiBkZWZhdWx0VmFsdWU7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoY3Vyciwgc2VnKSkgcmV0dXJuIGRlZmF1bHRWYWx1ZTtcbiAgICBjdXJyID0gY3VycltzZWddO1xuICB9XG4gIHJldHVybiBjdXJyID09PSB1bmRlZmluZWQgPyBkZWZhdWx0VmFsdWUgOiBjdXJyO1xufVxuXG4vKiogTXV0YXRlIGBvYmpgLCBzZXR0aW5nIGB2YWx1ZWAgYXQgYHBhdGhgIChjcmVhdGVzIGludGVybWVkaWF0ZSBvYmplY3RzKS4gUmV0dXJucyBgb2JqYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVTZXQob2JqOiBhbnksIHBhdGg6IHN0cmluZyB8IChzdHJpbmcgfCBudW1iZXIpW10sIHZhbHVlOiBhbnkpOiBhbnkge1xuICBjb25zdCBzZWdzID0gdG9TZWdtZW50cyhwYXRoKTtcbiAgbGV0IGN1cnIgPSBvYmo7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc2Vncy5sZW5ndGggLSAxOyBpKyspIHtcbiAgICBjb25zdCBrID0gc2Vnc1tpXTtcbiAgICBpZiAoREVOSUVELmhhcyhTdHJpbmcoaykpKSByZXR1cm4gb2JqO1xuICAgIGlmIChjdXJyW2tdID09IG51bGwgfHwgdHlwZW9mIGN1cnJba10gIT09ICdvYmplY3QnKSB7XG4gICAgICBjdXJyW2tdID0gdHlwZW9mIHNlZ3NbaSArIDFdID09PSAnbnVtYmVyJyA/IFtdIDoge307XG4gICAgfVxuICAgIGN1cnIgPSBjdXJyW2tdO1xuICB9XG4gIGNvbnN0IGxhc3QgPSBzZWdzW3NlZ3MubGVuZ3RoIC0gMV07XG4gIGlmIChERU5JRUQuaGFzKFN0cmluZyhsYXN0KSkpIHJldHVybiBvYmo7XG4gIGN1cnJbbGFzdF0gPSB2YWx1ZTtcbiAgcmV0dXJuIG9iajtcbn1cblxuLyoqXG4gKiBSZW1vdmUgdGhlIG93biBwcm9wZXJ0eSBhdCBgcGF0aGAgaW4gYG9iamAgKHRoZSByZXBsYXkgcHJpbWl0aXZlIGZvciB0aGVcbiAqIGBkZWxldGVgIGNvbW1pdCB2ZXJiLCAjMTNjLUIpLiBOby1vcCB3aGVuIGFueSBpbnRlcm1lZGlhdGUgc2VnbWVudCBpc1xuICogbWlzc2luZyDigJQgZGVsZXRpbmcgYW4gYWJzZW50IGtleSBoYXMgbm90aGluZyB0byByZW1vdmUuXG4gKlxuICogU2VjdXJpdHk6IHNhbWUgREVOSUVEICsgaGFzT3duUHJvcGVydHkgZGlzY2lwbGluZSBhcyBuYXRpdmVHZXQg4oCUIGV2ZXJ5XG4gKiBzZWdtZW50IGlzIGNoZWNrZWQsIHNvIGBuYXRpdmVEZWxldGUob2JqLCAnX19wcm90b19fXHUwMDFmeCcpYCBhbmRcbiAqIHByb3RvdHlwZS1jaGFpbiB3YWxrcyBhcmUgaW5lcnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVEZWxldGUob2JqOiBhbnksIHBhdGg6IHN0cmluZyB8IChzdHJpbmcgfCBudW1iZXIpW10pOiB2b2lkIHtcbiAgY29uc3Qgc2VncyA9IHRvU2VnbWVudHMocGF0aCk7XG4gIGxldCBjdXJyID0gb2JqO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHNlZ3MubGVuZ3RoIC0gMTsgaSsrKSB7XG4gICAgY29uc3Qgc2VnID0gc2Vnc1tpXTtcbiAgICBpZiAoREVOSUVELmhhcyhTdHJpbmcoc2VnKSkpIHJldHVybjtcbiAgICBpZiAoY3VyciA9PSBudWxsIHx8IHR5cGVvZiBjdXJyICE9PSAnb2JqZWN0JyB8fCAhT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGN1cnIsIHNlZykpIHJldHVybjtcbiAgICBjdXJyID0gY3VycltzZWddO1xuICB9XG4gIGNvbnN0IGxhc3QgPSBzZWdzW3NlZ3MubGVuZ3RoIC0gMV07XG4gIGlmIChERU5JRUQuaGFzKFN0cmluZyhsYXN0KSkpIHJldHVybjtcbiAgaWYgKGN1cnIgIT0gbnVsbCAmJiB0eXBlb2YgY3VyciA9PT0gJ29iamVjdCcpIHtcbiAgICBkZWxldGUgY3VycltsYXN0XTtcbiAgfVxufVxuXG4vKiogUmV0dXJucyB0cnVlIGlmIGBvYmpgIGhhcyBhbiBvd24gcHJvcGVydHkgYXQgZXZlcnkgc2VnbWVudCBvZiBgcGF0aGAuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlSGFzKG9iajogYW55LCBwYXRoOiBzdHJpbmcgfCAoc3RyaW5nIHwgbnVtYmVyKVtdKTogYm9vbGVhbiB7XG4gIGNvbnN0IHNlZ3MgPSB0b1NlZ21lbnRzKHBhdGgpO1xuICBsZXQgY3VyciA9IG9iajtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzZWdzLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGN1cnIgPT0gbnVsbCB8fCAhT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGN1cnIsIHNlZ3NbaV0pKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGkgPCBzZWdzLmxlbmd0aCAtIDEpIGN1cnIgPSBjdXJyW3NlZ3NbaV1dO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIERlZXAgbWVyZ2Ugd2hlcmUgZGVzdGluYXRpb24gd2lucyBmb3IgYW55IGRlZmluZWQgdmFsdWUuXG4gKiBGaWxscyBtaXNzaW5nIGtleXMgZnJvbSBgc3JjYCwgYnV0IG5ldmVyIG92ZXJ3cml0ZXMgZGVmaW5lZCBrZXlzIGluIGBkc3RgLlxuICogQXJyYXlzIGFyZSBub3QgcmVjdXJzZWQg4oCUIGRzdCBhcnJheSBhbHdheXMgd2lucyB3aGVuIHByZXNlbnQuXG4gKlxuICogUmVwbGFjZXM6IGBtZXJnZVdpdGgoZHN0LCBzcmMsIChvYmpWYWx1ZSkgPT4gb2JqVmFsdWUgIT09IHVuZGVmaW5lZCA/IG9ialZhbHVlIDogdW5kZWZpbmVkKWBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlQ29udGV4dFdpbnMoZHN0OiBhbnksIHNyYzogYW55KTogYW55IHtcbiAgaWYgKCFzcmMgfHwgdHlwZW9mIHNyYyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShzcmMpKSB7XG4gICAgcmV0dXJuIGRzdCAhPT0gdW5kZWZpbmVkID8gZHN0IDogc3JjO1xuICB9XG4gIGNvbnN0IG91dDogYW55ID0gZHN0ICE9IG51bGwgJiYgdHlwZW9mIGRzdCA9PT0gJ29iamVjdCcgPyB7IC4uLmRzdCB9IDoge307XG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHNyYykpIHtcbiAgICBpZiAoREVOSUVELmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICBjb25zdCBkc3RWYWwgPSBvdXRba2V5XTtcbiAgICBpZiAoZHN0VmFsICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIC8vIGRzdCB3aW5zOyByZWN1cnNlIG9ubHkgaWYgYm90aCBzaWRlcyBhcmUgcGxhaW4gb2JqZWN0c1xuICAgICAgaWYgKFxuICAgICAgICBkc3RWYWwgIT09IG51bGwgJiZcbiAgICAgICAgdHlwZW9mIGRzdFZhbCA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgIUFycmF5LmlzQXJyYXkoZHN0VmFsKSAmJlxuICAgICAgICBzcmNba2V5XSAhPT0gbnVsbCAmJlxuICAgICAgICB0eXBlb2Ygc3JjW2tleV0gPT09ICdvYmplY3QnICYmXG4gICAgICAgICFBcnJheS5pc0FycmF5KHNyY1trZXldKVxuICAgICAgKSB7XG4gICAgICAgIG91dFtrZXldID0gbWVyZ2VDb250ZXh0V2lucyhkc3RWYWwsIHNyY1trZXldKTtcbiAgICAgIH1cbiAgICAgIC8vIGVsc2Uga2VlcCBkc3RWYWwgdW5jaGFuZ2VkXG4gICAgfSBlbHNlIHtcbiAgICAgIG91dFtrZXldID0gc3JjW2tleV07XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG4iXX0=