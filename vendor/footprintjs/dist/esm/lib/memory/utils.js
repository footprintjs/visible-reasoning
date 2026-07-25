/**
 * utils.ts — Helper functions for nested object manipulation
 *
 * Provides consistent path traversal and value manipulation for the memory system.
 * Zero external dependencies.
 */
import { nativeDelete, nativeGet as _get, nativeHas as _has, nativeSet as _set } from './pathOps.js';
/** ASCII Unit-Separator — cannot appear in JS identifiers, invisible in logs. */
export const DELIM = '\u001F';
/**
 * Resolves run-namespaced and global paths.
 * Each flowchart execution (run) stores data under `runs/{id}/` to prevent collisions.
 */
export function getRunAndGlobalPaths(runId, path = []) {
    return {
        runPath: runId ? ['runs', runId, ...path] : undefined,
        globalPath: [...path],
    };
}
/**
 * Sets a value at a nested path, creating intermediate objects as needed.
 */
export function setNestedValue(obj, runId, _path, field, value, defaultValues) {
    const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
    const path = runPath || globalPath;
    const pathCopy = [...path];
    let current = obj;
    while (pathCopy.length > 0) {
        const key = pathCopy.shift();
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
            current[key] = key === runId && defaultValues ? defaultValues : {};
        }
        current = current[key];
    }
    current[field] = value;
    return obj;
}
/**
 * Deep-merges a value into the object at the specified path.
 * - Arrays: concatenate
 * - Objects: shallow merge at each level
 * - Primitives: replace
 */
export function updateNestedValue(obj, runId, _path, field, value, defaultValues) {
    const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
    const path = runPath || globalPath;
    const pathCopy = [...path];
    let current = obj;
    while (pathCopy.length > 0) {
        const key = pathCopy.shift();
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
            current[key] = key === runId && defaultValues ? defaultValues : {};
        }
        current = current[key];
    }
    updateValue(current, field, value);
    return obj;
}
/**
 * In-place value update with merge semantics.
 * - Arrays (non-empty): concatenate onto existing
 * - Arrays (empty):     direct replace — writing `[]` clears the field
 * - Objects (non-empty): shallow merge (spread)
 * - Objects (empty):    direct replace — writing `{}` clears the field
 * - Primitives: direct assignment
 *
 * Note on empty arrays: both `value && Array.isArray(value)` and
 * `Array.isArray(value)` evaluate the same for arrays — `[]` is truthy in
 * JavaScript, so the `&&` guard was never the issue. The actual bug was the
 * concat path: `[...cur, ...[]]` silently returned `cur` unchanged when `value`
 * was `[]`, making `updateValue(obj, 'tags', [])` a no-op instead of a clear.
 * The fix is the explicit `value.length === 0` early-return branch.
 */
export function updateValue(object, key, value) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            object[key] = value; // clear: [] replaces whatever was there
        }
        else {
            const cur = object[key];
            object[key] = cur === undefined ? value : [...cur, ...value];
        }
    }
    else if (value && typeof value === 'object' && Object.keys(value).length) {
        const cur = object[key];
        object[key] = cur === undefined ? value : { ...cur, ...value };
    }
    else {
        object[key] = value;
    }
}
/**
 * Gets a value at a nested path with prototype-pollution protection.
 */
export function getNestedValue(root, path, field) {
    const node = path && path.length > 0 ? _get(root, path) : root;
    if (field === undefined || node === undefined)
        return node;
    if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, field)) {
        return node[field];
    }
    return undefined;
}
/**
 * Redacts sensitive values in a patch for logging/debugging.
 */
export function redactPatch(patch, redactedSet) {
    const out = structuredClone(patch);
    for (const flat of redactedSet) {
        const pathArr = flat.split(DELIM);
        if (_has(out, pathArr)) {
            const curr = _get(out, pathArr);
            if (typeof curr !== 'undefined') {
                _set(out, pathArr, 'REDACTED');
            }
        }
    }
    return out;
}
/**
 * Normalises an array path into a stable string key using DELIM.
 */
export function normalisePath(path) {
    return path.map(String).join(DELIM);
}
/**
 * Structural deep equality for committed-state values.
 *
 * Used by {@link TransactionBuffer} to decide whether a stage actually CHANGED
 * a path or merely re-wrote / reverted it to the value it already held (a
 * "no-op write"). Committed state is JSON-shaped — it must survive
 * `structuredClone` — so this only needs to handle the shapes that can reach a
 * commit: primitives, arrays, and plain objects.
 *
 * Semantics:
 *   - reference / identical-primitive short-circuits first (cheap fast path)
 *   - `NaN` equals `NaN` (primitive compare falls back to `Object.is`)
 *   - arrays: equal length AND deep-equal element-wise (order-sensitive)
 *   - objects: identical own-key set AND deep-equal per key
 *   - mismatched kinds (array vs object, object vs null) → not equal
 *
 * Cost & safety:
 *   - Allocates NOTHING but transient `Object.keys` arrays — no clones. It is
 *     strictly cheaper than the `structuredClone` the commit already performs.
 *   - Primitive comparisons (the bulk of state) are O(1) via the `===` /
 *     `Object.is` fast paths; only nested objects/arrays incur a walk, bounded
 *     by the value's own size.
 *   - Assumes ACYCLIC, JSON-shaped values — the same contract the memory layer
 *     already relies on (committed state is `structuredClone`d and must be
 *     JSON-serialisable for checkpoints). A cyclic value is out of contract
 *     here exactly as it is for checkpointing; dev mode flags cycles at write
 *     time via `ScopeFacade.setValue`.
 */
export function deepEqual(a, b) {
    if (a === b)
        return true; // same reference or identical primitive
    if (typeof a !== typeof b)
        return false;
    if (a === null || b === null)
        return a === b; // one is null, the other isn't
    if (typeof a !== 'object')
        return Object.is(a, b); // NaN-safe primitive compare
    const aIsArray = Array.isArray(a);
    if (aIsArray !== Array.isArray(b))
        return false; // array vs plain object
    if (aIsArray) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i]))
                return false;
        }
        return true;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length)
        return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key))
            return false;
        if (!deepEqual(a[key], b[key]))
            return false;
    }
    return true;
}
/**
 * Deep union merge helper.
 * - Arrays (non-empty): union without duplicates (encounter order preserved)
 * - Arrays (empty):     replace — src `[]` clears the destination array.
 *   Rationale: writing `scope.tags = []` means "clear tags", not "append nothing".
 *   Without this rule, an empty-array write silently becomes a no-op which is
 *   impossible to distinguish from a bug.
 * - Objects: recursive merge
 * - Primitives: source wins
 */
export function deepSmartMerge(dst, src) {
    if (src === null || typeof src !== 'object')
        return src;
    if (Array.isArray(src)) {
        if (src.length === 0)
            return []; // empty src = clear, not no-op
        if (Array.isArray(dst))
            return [...new Set([...dst, ...src])];
        return [...src];
    }
    const out = { ...(dst && typeof dst === 'object' ? dst : {}) };
    // Object.keys() is own-enumerable-only by spec — no DENIED check needed here.
    for (const k of Object.keys(src)) {
        out[k] = deepSmartMerge(out[k], src[k]);
    }
    return out;
}
/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Guarantees "last writer wins" semantics.
 *
 * The single replay primitive — three consumers inherit every verb from it:
 * live state (`SharedMemory.applyPatch`), time travel
 * (`EventLog.materialise`), and the redacted mirror
 * (`StageContext.commit`'s second `applyPatch`).
 *
 * Verb arms:
 *   - `'set'`    — overwrite with `overwrite[path]` (the full final value).
 *   - `'merge'`  — `deepSmartMerge` the accumulated `updates[path]` delta in.
 *   - `'append'` — (#13c-B delta mode) `overwrite[path]` holds ONLY the tail;
 *     reconstruct by concatenating it onto the current array. When the
 *     current value or the recorded tail is not an array (out-of-order
 *     replay base, or a REDACTED tail — `redactPatch` replaces matched
 *     payloads with the `'REDACTED'` string), degrade to a direct set of the
 *     recorded value — the same terminal value a redacted/corrupt `'set'`
 *     produces.
 *   - `'delete'` — (#13c-B delta mode) remove the key (`nativeDelete`,
 *     prototype-pollution-safe). The path stays enumerated in `overwrite`
 *     (value `undefined`) for key-set consumers; replay ignores that value.
 */
export function applySmartMerge(base, updates, overwrite, trace) {
    const out = structuredClone(base);
    for (const { path, verb } of trace) {
        const segs = path.split(DELIM);
        if (verb === 'set') {
            _set(out, segs, structuredClone(_get(overwrite, segs)));
        }
        else if (verb === 'append') {
            const tail = structuredClone(_get(overwrite, segs));
            const current = _get(out, segs);
            _set(out, segs, Array.isArray(current) && Array.isArray(tail) ? [...current, ...tail] : tail);
        }
        else if (verb === 'delete') {
            nativeDelete(out, segs);
        }
        else {
            const current = _get(out, segs) ?? {};
            _set(out, segs, deepSmartMerge(current, _get(updates, segs)));
        }
    }
    return out;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL21lbW9yeS91dGlscy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7R0FLRztBQUVILE9BQU8sRUFBRSxZQUFZLEVBQUUsU0FBUyxJQUFJLElBQUksRUFBRSxTQUFTLElBQUksSUFBSSxFQUFFLFNBQVMsSUFBSSxJQUFJLEVBQUUsTUFBTSxjQUFjLENBQUM7QUFHckcsaUZBQWlGO0FBQ2pGLE1BQU0sQ0FBQyxNQUFNLEtBQUssR0FBRyxRQUFRLENBQUM7QUFJOUI7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLG9CQUFvQixDQUFDLEtBQWMsRUFBRSxPQUE0QixFQUFFO0lBQ2pGLE9BQU87UUFDTCxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztRQUNyRCxVQUFVLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQztLQUN0QixDQUFDO0FBQ0osQ0FBQztBQUVEOztHQUVHO0FBQ0gsTUFBTSxVQUFVLGNBQWMsQ0FDNUIsR0FBaUIsRUFDakIsS0FBYSxFQUNiLEtBQWUsRUFDZixLQUFhLEVBQ2IsS0FBUSxFQUNSLGFBQXVCO0lBRXZCLE1BQU0sRUFBRSxPQUFPLEVBQUUsVUFBVSxFQUFFLEdBQUcsb0JBQW9CLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQ25FLE1BQU0sSUFBSSxHQUFHLE9BQU8sSUFBSSxVQUFVLENBQUM7SUFDbkMsTUFBTSxRQUFRLEdBQUcsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQzNCLElBQUksT0FBTyxHQUFpQixHQUFHLENBQUM7SUFDaEMsT0FBTyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQzNCLE1BQU0sR0FBRyxHQUFHLFFBQVEsQ0FBQyxLQUFLLEVBQVksQ0FBQztRQUN2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RCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQ2hDLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLE9BQU8sRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNoRyxDQUFDO2FBQU0sSUFBSSxJQUFJLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDN0IsWUFBWSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUMxQixDQUFDO2FBQU0sQ0FBQztZQUNOLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3RDLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLGNBQWMsQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDaEUsQ0FBQztJQUNILENBQUM7SUFDRCxPQUFPLEdBQUcsQ0FBQztBQUNiLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHV0aWxzLnRzIOKAlCBIZWxwZXIgZnVuY3Rpb25zIGZvciBuZXN0ZWQgb2JqZWN0IG1hbmlwdWxhdGlvblxuICpcbiAqIFByb3ZpZGVzIGNvbnNpc3RlbnQgcGF0aCB0cmF2ZXJzYWwgYW5kIHZhbHVlIG1hbmlwdWxhdGlvbiBmb3IgdGhlIG1lbW9yeSBzeXN0ZW0uXG4gKiBaZXJvIGV4dGVybmFsIGRlcGVuZGVuY2llcy5cbiAqL1xuXG5pbXBvcnQgeyBuYXRpdmVEZWxldGUsIG5hdGl2ZUdldCBhcyBfZ2V0LCBuYXRpdmVIYXMgYXMgX2hhcywgbmF0aXZlU2V0IGFzIF9zZXQgfSBmcm9tICcuL3BhdGhPcHMuanMnO1xuaW1wb3J0IHR5cGUgeyBNZW1vcnlQYXRjaCwgVHJhY2VFbnRyeSB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vKiogQVNDSUkgVW5pdC1TZXBhcmF0b3Ig4oCUIGNhbm5vdCBhcHBlYXIgaW4gSlMgaWRlbnRpZmllcnMsIGludmlzaWJsZSBpbiBsb2dzLiAqL1xuZXhwb3J0IGNvbnN0IERFTElNID0gJ1xcdTAwMUYnO1xuXG50eXBlIE5lc3RlZE9iamVjdCA9IHsgW2tleTogc3RyaW5nXTogYW55IH07XG5cbi8qKlxuICogUmVzb2x2ZXMgcnVuLW5hbWVzcGFjZWQgYW5kIGdsb2JhbCBwYXRocy5cbiAqIEVhY2ggZmxvd2NoYXJ0IGV4ZWN1dGlvbiAocnVuKSBzdG9yZXMgZGF0YSB1bmRlciBgcnVucy97aWR9L2AgdG8gcHJldmVudCBjb2xsaXNpb25zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UnVuQW5kR2xvYmFsUGF0aHMocnVuSWQ/OiBzdHJpbmcsIHBhdGg6IChzdHJpbmcgfCBudW1iZXIpW10gPSBbXSkge1xuICByZXR1cm4ge1xuICAgIHJ1blBhdGg6IHJ1bklkID8gWydydW5zJywgcnVuSWQsIC4uLnBhdGhdIDogdW5kZWZpbmVkLFxuICAgIGdsb2JhbFBhdGg6IFsuLi5wYXRoXSxcbiAgfTtcbn1cblxuLyoqXG4gKiBTZXRzIGEgdmFsdWUgYXQgYSBuZXN0ZWQgcGF0aCwgY3JlYXRpbmcgaW50ZXJtZWRpYXRlIG9iamVjdHMgYXMgbmVlZGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0TmVzdGVkVmFsdWU8VD4oXG4gIG9iajogTmVzdGVkT2JqZWN0LFxuICBydW5JZDogc3RyaW5nLFxuICBfcGF0aDogc3RyaW5nW10sXG4gIGZpZWxkOiBzdHJpbmcsXG4gIHZhbHVlOiBULFxuICBkZWZhdWx0VmFsdWVzPzogdW5rbm93bixcbik6IE5lc3RlZE9iamVjdCB7XG4gIGNvbnN0IHsgcnVuUGF0aCwgZ2xvYmFsUGF0aCB9ID0gZ2V0UnVuQW5kR2xvYmFsUGF0aHMocnVuSWQsIF9wYXRoKTtcbiAgY29uc3QgcGF0aCA9IHJ1blBhdGggfHwgZ2xvYmFsUGF0aDtcbiAgY29uc3QgcGF0aENvcHkgPSBbLi4ucGF0aF07XG4gIGxldCBjdXJyZW50OiBOZXN0ZWRPYmplY3QgPSBvYmo7XG4gIHdoaWxlIChwYXRoQ29weS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qga2V5ID0gcGF0aENvcHkuc2hpZnQoKSBhcyBzdHJpbmc7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoY3VycmVudCwga2V5KSkge1xuICAgICAgY3VycmVudFtrZXldID0ga2V5ID09PSBydW5JZCAmJiBkZWZhdWx0VmFsdWVzID8gZGVmYXVsdFZhbHVlcyA6IHt9O1xuICAgIH1cbiAgICBjdXJyZW50ID0gY3VycmVudFtrZXldO1xuICB9XG4gIGN1cnJlbnRbZmllbGRdID0gdmFsdWU7XG4gIHJldHVybiBvYmo7XG59XG5cbi8qKlxuICogRGVlcC1tZXJnZXMgYSB2YWx1ZSBpbnRvIHRoZSBvYmplY3QgYXQgdGhlIHNwZWNpZmllZCBwYXRoLlxuICogLSBBcnJheXM6IGNvbmNhdGVuYXRlXG4gKiAtIE9iamVjdHM6IHNoYWxsb3cgbWVyZ2UgYXQgZWFjaCBsZXZlbFxuICogLSBQcmltaXRpdmVzOiByZXBsYWNlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVOZXN0ZWRWYWx1ZTxUPihcbiAgb2JqOiBhbnksXG4gIHJ1bklkOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIF9wYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdLFxuICBmaWVsZDogc3RyaW5nIHwgbnVtYmVyLFxuICB2YWx1ZTogVCxcbiAgZGVmYXVsdFZhbHVlcz86IHVua25vd24sXG4pOiBhbnkge1xuICBjb25zdCB7IHJ1blBhdGgsIGdsb2JhbFBhdGggfSA9IGdldFJ1bkFuZEdsb2JhbFBhdGhzKHJ1bklkLCBfcGF0aCk7XG4gIGNvbnN0IHBhdGggPSBydW5QYXRoIHx8IGdsb2JhbFBhdGg7XG4gIGNvbnN0IHBhdGhDb3B5ID0gWy4uLnBhdGhdO1xuICBsZXQgY3VycmVudDogTmVzdGVkT2JqZWN0ID0gb2JqO1xuICB3aGlsZSAocGF0aENvcHkubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGtleSA9IHBhdGhDb3B5LnNoaWZ0KCkgYXMgc3RyaW5nO1xuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGN1cnJlbnQsIGtleSkpIHtcbiAgICAgIGN1cnJlbnRba2V5XSA9IGtleSA9PT0gcnVuSWQgJiYgZGVmYXVsdFZhbHVlcyA/IGRlZmF1bHRWYWx1ZXMgOiB7fTtcbiAgICB9XG4gICAgY3VycmVudCA9IGN1cnJlbnRba2V5XTtcbiAgfVxuICB1cGRhdGVWYWx1ZShjdXJyZW50LCBmaWVsZCwgdmFsdWUpO1xuICByZXR1cm4gb2JqO1xufVxuXG4vKipcbiAqIEluLXBsYWNlIHZhbHVlIHVwZGF0ZSB3aXRoIG1lcmdlIHNlbWFudGljcy5cbiAqIC0gQXJyYXlzIChub24tZW1wdHkpOiBjb25jYXRlbmF0ZSBvbnRvIGV4aXN0aW5nXG4gKiAtIEFycmF5cyAoZW1wdHkpOiAgICAgZGlyZWN0IHJlcGxhY2Ug4oCUIHdyaXRpbmcgYFtdYCBjbGVhcnMgdGhlIGZpZWxkXG4gKiAtIE9iamVjdHMgKG5vbi1lbXB0eSk6IHNoYWxsb3cgbWVyZ2UgKHNwcmVhZClcbiAqIC0gT2JqZWN0cyAoZW1wdHkpOiAgICBkaXJlY3QgcmVwbGFjZSDigJQgd3JpdGluZyBge31gIGNsZWFycyB0aGUgZmllbGRcbiAqIC0gUHJpbWl0aXZlczogZGlyZWN0IGFzc2lnbm1lbnRcbiAqXG4gKiBOb3RlIG9uIGVtcHR5IGFycmF5czogYm90aCBgdmFsdWUgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSlgIGFuZFxuICogYEFycmF5LmlzQXJyYXkodmFsdWUpYCBldmFsdWF0ZSB0aGUgc2FtZSBmb3IgYXJyYXlzIOKAlCBgW11gIGlzIHRydXRoeSBpblxuICogSmF2YVNjcmlwdCwgc28gdGhlIGAmJmAgZ3VhcmQgd2FzIG5ldmVyIHRoZSBpc3N1ZS4gVGhlIGFjdHVhbCBidWcgd2FzIHRoZVxuICogY29uY2F0IHBhdGg6IGBbLi4uY3VyLCAuLi5bXV1gIHNpbGVudGx5IHJldHVybmVkIGBjdXJgIHVuY2hhbmdlZCB3aGVuIGB2YWx1ZWBcbiAqIHdhcyBgW11gLCBtYWtpbmcgYHVwZGF0ZVZhbHVlKG9iaiwgJ3RhZ3MnLCBbXSlgIGEgbm8tb3AgaW5zdGVhZCBvZiBhIGNsZWFyLlxuICogVGhlIGZpeCBpcyB0aGUgZXhwbGljaXQgYHZhbHVlLmxlbmd0aCA9PT0gMGAgZWFybHktcmV0dXJuIGJyYW5jaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVZhbHVlKG9iamVjdDogYW55LCBrZXk6IHN0cmluZyB8IG51bWJlciwgdmFsdWU6IGFueSk6IHZvaWQge1xuICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICBpZiAodmFsdWUubGVuZ3RoID09PSAwKSB7XG4gICAgICBvYmplY3Rba2V5XSA9IHZhbHVlOyAvLyBjbGVhcjogW10gcmVwbGFjZXMgd2hhdGV2ZXIgd2FzIHRoZXJlXG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGN1ciA9IG9iamVjdFtrZXldIGFzIGFueTtcbiAgICAgIG9iamVjdFtrZXldID0gY3VyID09PSB1bmRlZmluZWQgPyB2YWx1ZSA6IFsuLi5jdXIsIC4uLnZhbHVlXTtcbiAgICB9XG4gIH0gZWxzZSBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoKSB7XG4gICAgY29uc3QgY3VyID0gb2JqZWN0W2tleV0gYXMgYW55O1xuICAgIG9iamVjdFtrZXldID0gY3VyID09PSB1bmRlZmluZWQgPyB2YWx1ZSA6IHsgLi4uY3VyLCAuLi52YWx1ZSB9O1xuICB9IGVsc2Uge1xuICAgIG9iamVjdFtrZXldID0gdmFsdWU7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXRzIGEgdmFsdWUgYXQgYSBuZXN0ZWQgcGF0aCB3aXRoIHByb3RvdHlwZS1wb2xsdXRpb24gcHJvdGVjdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldE5lc3RlZFZhbHVlKHJvb3Q6IGFueSwgcGF0aDogKHN0cmluZyB8IG51bWJlcilbXSwgZmllbGQ/OiBzdHJpbmcgfCBudW1iZXIpOiBhbnkge1xuICBjb25zdCBub2RlID0gcGF0aCAmJiBwYXRoLmxlbmd0aCA+IDAgPyBfZ2V0KHJvb3QsIHBhdGgpIDogcm9vdDtcbiAgaWYgKGZpZWxkID09PSB1bmRlZmluZWQgfHwgbm9kZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9kZTtcbiAgaWYgKG5vZGUgIT09IG51bGwgJiYgdHlwZW9mIG5vZGUgPT09ICdvYmplY3QnICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChub2RlLCBmaWVsZCkpIHtcbiAgICByZXR1cm4gbm9kZVtmaWVsZF07XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBSZWRhY3RzIHNlbnNpdGl2ZSB2YWx1ZXMgaW4gYSBwYXRjaCBmb3IgbG9nZ2luZy9kZWJ1Z2dpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWRhY3RQYXRjaChwYXRjaDogTWVtb3J5UGF0Y2gsIHJlZGFjdGVkU2V0OiBTZXQ8c3RyaW5nPik6IE1lbW9yeVBhdGNoIHtcbiAgY29uc3Qgb3V0ID0gc3RydWN0dXJlZENsb25lKHBhdGNoKTtcbiAgZm9yIChjb25zdCBmbGF0IG9mIHJlZGFjdGVkU2V0KSB7XG4gICAgY29uc3QgcGF0aEFyciA9IGZsYXQuc3BsaXQoREVMSU0pO1xuICAgIGlmIChfaGFzKG91dCwgcGF0aEFycikpIHtcbiAgICAgIGNvbnN0IGN1cnIgPSBfZ2V0KG91dCwgcGF0aEFycik7XG4gICAgICBpZiAodHlwZW9mIGN1cnIgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIF9zZXQob3V0LCBwYXRoQXJyLCAnUkVEQUNURUQnKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBOb3JtYWxpc2VzIGFuIGFycmF5IHBhdGggaW50byBhIHN0YWJsZSBzdHJpbmcga2V5IHVzaW5nIERFTElNLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXNlUGF0aChwYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdKTogc3RyaW5nIHtcbiAgcmV0dXJuIHBhdGgubWFwKFN0cmluZykuam9pbihERUxJTSk7XG59XG5cbi8qKlxuICogU3RydWN0dXJhbCBkZWVwIGVxdWFsaXR5IGZvciBjb21taXR0ZWQtc3RhdGUgdmFsdWVzLlxuICpcbiAqIFVzZWQgYnkge0BsaW5rIFRyYW5zYWN0aW9uQnVmZmVyfSB0byBkZWNpZGUgd2hldGhlciBhIHN0YWdlIGFjdHVhbGx5IENIQU5HRURcbiAqIGEgcGF0aCBvciBtZXJlbHkgcmUtd3JvdGUgLyByZXZlcnRlZCBpdCB0byB0aGUgdmFsdWUgaXQgYWxyZWFkeSBoZWxkIChhXG4gKiBcIm5vLW9wIHdyaXRlXCIpLiBDb21taXR0ZWQgc3RhdGUgaXMgSlNPTi1zaGFwZWQg4oCUIGl0IG11c3Qgc3Vydml2ZVxuICogYHN0cnVjdHVyZWRDbG9uZWAg4oCUIHNvIHRoaXMgb25seSBuZWVkcyB0byBoYW5kbGUgdGhlIHNoYXBlcyB0aGF0IGNhbiByZWFjaCBhXG4gKiBjb21taXQ6IHByaW1pdGl2ZXMsIGFycmF5cywgYW5kIHBsYWluIG9iamVjdHMuXG4gKlxuICogU2VtYW50aWNzOlxuICogICAtIHJlZmVyZW5jZSAvIGlkZW50aWNhbC1wcmltaXRpdmUgc2hvcnQtY2lyY3VpdHMgZmlyc3QgKGNoZWFwIGZhc3QgcGF0aClcbiAqICAgLSBgTmFOYCBlcXVhbHMgYE5hTmAgKHByaW1pdGl2ZSBjb21wYXJlIGZhbGxzIGJhY2sgdG8gYE9iamVjdC5pc2ApXG4gKiAgIC0gYXJyYXlzOiBlcXVhbCBsZW5ndGggQU5EIGRlZXAtZXF1YWwgZWxlbWVudC13aXNlIChvcmRlci1zZW5zaXRpdmUpXG4gKiAgIC0gb2JqZWN0czogaWRlbnRpY2FsIG93bi1rZXkgc2V0IEFORCBkZWVwLWVxdWFsIHBlciBrZXlcbiAqICAgLSBtaXNtYXRjaGVkIGtpbmRzIChhcnJheSB2cyBvYmplY3QsIG9iamVjdCB2cyBudWxsKSDihpIgbm90IGVxdWFsXG4gKlxuICogQ29zdCAmIHNhZmV0eTpcbiAqICAgLSBBbGxvY2F0ZXMgTk9USElORyBidXQgdHJhbnNpZW50IGBPYmplY3Qua2V5c2AgYXJyYXlzIOKAlCBubyBjbG9uZXMuIEl0IGlzXG4gKiAgICAgc3RyaWN0bHkgY2hlYXBlciB0aGFuIHRoZSBgc3RydWN0dXJlZENsb25lYCB0aGUgY29tbWl0IGFscmVhZHkgcGVyZm9ybXMuXG4gKiAgIC0gUHJpbWl0aXZlIGNvbXBhcmlzb25zICh0aGUgYnVsayBvZiBzdGF0ZSkgYXJlIE8oMSkgdmlhIHRoZSBgPT09YCAvXG4gKiAgICAgYE9iamVjdC5pc2AgZmFzdCBwYXRoczsgb25seSBuZXN0ZWQgb2JqZWN0cy9hcnJheXMgaW5jdXIgYSB3YWxrLCBib3VuZGVkXG4gKiAgICAgYnkgdGhlIHZhbHVlJ3Mgb3duIHNpemUuXG4gKiAgIC0gQXNzdW1lcyBBQ1lDTElDLCBKU09OLXNoYXBlZCB2YWx1ZXMg4oCUIHRoZSBzYW1lIGNvbnRyYWN0IHRoZSBtZW1vcnkgbGF5ZXJcbiAqICAgICBhbHJlYWR5IHJlbGllcyBvbiAoY29tbWl0dGVkIHN0YXRlIGlzIGBzdHJ1Y3R1cmVkQ2xvbmVgZCBhbmQgbXVzdCBiZVxuICogICAgIEpTT04tc2VyaWFsaXNhYmxlIGZvciBjaGVja3BvaW50cykuIEEgY3ljbGljIHZhbHVlIGlzIG91dCBvZiBjb250cmFjdFxuICogICAgIGhlcmUgZXhhY3RseSBhcyBpdCBpcyBmb3IgY2hlY2twb2ludGluZzsgZGV2IG1vZGUgZmxhZ3MgY3ljbGVzIGF0IHdyaXRlXG4gKiAgICAgdGltZSB2aWEgYFNjb3BlRmFjYWRlLnNldFZhbHVlYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZXBFcXVhbChhOiBhbnksIGI6IGFueSk6IGJvb2xlYW4ge1xuICBpZiAoYSA9PT0gYikgcmV0dXJuIHRydWU7IC8vIHNhbWUgcmVmZXJlbmNlIG9yIGlkZW50aWNhbCBwcmltaXRpdmVcbiAgaWYgKHR5cGVvZiBhICE9PSB0eXBlb2YgYikgcmV0dXJuIGZhbHNlO1xuICBpZiAoYSA9PT0gbnVsbCB8fCBiID09PSBudWxsKSByZXR1cm4gYSA9PT0gYjsgLy8gb25lIGlzIG51bGwsIHRoZSBvdGhlciBpc24ndFxuICBpZiAodHlwZW9mIGEgIT09ICdvYmplY3QnKSByZXR1cm4gT2JqZWN0LmlzKGEsIGIpOyAvLyBOYU4tc2FmZSBwcmltaXRpdmUgY29tcGFyZVxuXG4gIGNvbnN0IGFJc0FycmF5ID0gQXJyYXkuaXNBcnJheShhKTtcbiAgaWYgKGFJc0FycmF5ICE9PSBBcnJheS5pc0FycmF5KGIpKSByZXR1cm4gZmFsc2U7IC8vIGFycmF5IHZzIHBsYWluIG9iamVjdFxuXG4gIGlmIChhSXNBcnJheSkge1xuICAgIGlmIChhLmxlbmd0aCAhPT0gYi5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGEubGVuZ3RoOyBpKyspIHtcbiAgICAgIGlmICghZGVlcEVxdWFsKGFbaV0sIGJbaV0pKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgY29uc3QgYUtleXMgPSBPYmplY3Qua2V5cyhhKTtcbiAgY29uc3QgYktleXMgPSBPYmplY3Qua2V5cyhiKTtcbiAgaWYgKGFLZXlzLmxlbmd0aCAhPT0gYktleXMubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gIGZvciAoY29uc3Qga2V5IG9mIGFLZXlzKSB7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoYiwga2V5KSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghZGVlcEVxdWFsKGFba2V5XSwgYltrZXldKSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIERlZXAgdW5pb24gbWVyZ2UgaGVscGVyLlxuICogLSBBcnJheXMgKG5vbi1lbXB0eSk6IHVuaW9uIHdpdGhvdXQgZHVwbGljYXRlcyAoZW5jb3VudGVyIG9yZGVyIHByZXNlcnZlZClcbiAqIC0gQXJyYXlzIChlbXB0eSk6ICAgICByZXBsYWNlIOKAlCBzcmMgYFtdYCBjbGVhcnMgdGhlIGRlc3RpbmF0aW9uIGFycmF5LlxuICogICBSYXRpb25hbGU6IHdyaXRpbmcgYHNjb3BlLnRhZ3MgPSBbXWAgbWVhbnMgXCJjbGVhciB0YWdzXCIsIG5vdCBcImFwcGVuZCBub3RoaW5nXCIuXG4gKiAgIFdpdGhvdXQgdGhpcyBydWxlLCBhbiBlbXB0eS1hcnJheSB3cml0ZSBzaWxlbnRseSBiZWNvbWVzIGEgbm8tb3Agd2hpY2ggaXNcbiAqICAgaW1wb3NzaWJsZSB0byBkaXN0aW5ndWlzaCBmcm9tIGEgYnVnLlxuICogLSBPYmplY3RzOiByZWN1cnNpdmUgbWVyZ2VcbiAqIC0gUHJpbWl0aXZlczogc291cmNlIHdpbnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZXBTbWFydE1lcmdlKGRzdDogYW55LCBzcmM6IGFueSk6IGFueSB7XG4gIGlmIChzcmMgPT09IG51bGwgfHwgdHlwZW9mIHNyYyAhPT0gJ29iamVjdCcpIHJldHVybiBzcmM7XG5cbiAgaWYgKEFycmF5LmlzQXJyYXkoc3JjKSkge1xuICAgIGlmIChzcmMubGVuZ3RoID09PSAwKSByZXR1cm4gW107IC8vIGVtcHR5IHNyYyA9IGNsZWFyLCBub3Qgbm8tb3BcbiAgICBpZiAoQXJyYXkuaXNBcnJheShkc3QpKSByZXR1cm4gWy4uLm5ldyBTZXQoWy4uLmRzdCwgLi4uc3JjXSldO1xuICAgIHJldHVybiBbLi4uc3JjXTtcbiAgfVxuXG4gIGNvbnN0IG91dDogYW55ID0geyAuLi4oZHN0ICYmIHR5cGVvZiBkc3QgPT09ICdvYmplY3QnID8gZHN0IDoge30pIH07XG4gIC8vIE9iamVjdC5rZXlzKCkgaXMgb3duLWVudW1lcmFibGUtb25seSBieSBzcGVjIOKAlCBubyBERU5JRUQgY2hlY2sgbmVlZGVkIGhlcmUuXG4gIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhzcmMpKSB7XG4gICAgb3V0W2tdID0gZGVlcFNtYXJ0TWVyZ2Uob3V0W2tdLCBzcmNba10pO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogQXBwbGllcyBhIGNvbW1pdCBidW5kbGUgdG8gYSBiYXNlIHN0YXRlIGJ5IHJlcGxheWluZyBvcGVyYXRpb25zIGluIG9yZGVyLlxuICogR3VhcmFudGVlcyBcImxhc3Qgd3JpdGVyIHdpbnNcIiBzZW1hbnRpY3MuXG4gKlxuICogVGhlIHNpbmdsZSByZXBsYXkgcHJpbWl0aXZlIOKAlCB0aHJlZSBjb25zdW1lcnMgaW5oZXJpdCBldmVyeSB2ZXJiIGZyb20gaXQ6XG4gKiBsaXZlIHN0YXRlIChgU2hhcmVkTWVtb3J5LmFwcGx5UGF0Y2hgKSwgdGltZSB0cmF2ZWxcbiAqIChgRXZlbnRMb2cubWF0ZXJpYWxpc2VgKSwgYW5kIHRoZSByZWRhY3RlZCBtaXJyb3JcbiAqIChgU3RhZ2VDb250ZXh0LmNvbW1pdGAncyBzZWNvbmQgYGFwcGx5UGF0Y2hgKS5cbiAqXG4gKiBWZXJiIGFybXM6XG4gKiAgIC0gYCdzZXQnYCAgICDigJQgb3ZlcndyaXRlIHdpdGggYG92ZXJ3cml0ZVtwYXRoXWAgKHRoZSBmdWxsIGZpbmFsIHZhbHVlKS5cbiAqICAgLSBgJ21lcmdlJ2AgIOKAlCBgZGVlcFNtYXJ0TWVyZ2VgIHRoZSBhY2N1bXVsYXRlZCBgdXBkYXRlc1twYXRoXWAgZGVsdGEgaW4uXG4gKiAgIC0gYCdhcHBlbmQnYCDigJQgKCMxM2MtQiBkZWx0YSBtb2RlKSBgb3ZlcndyaXRlW3BhdGhdYCBob2xkcyBPTkxZIHRoZSB0YWlsO1xuICogICAgIHJlY29uc3RydWN0IGJ5IGNvbmNhdGVuYXRpbmcgaXQgb250byB0aGUgY3VycmVudCBhcnJheS4gV2hlbiB0aGVcbiAqICAgICBjdXJyZW50IHZhbHVlIG9yIHRoZSByZWNvcmRlZCB0YWlsIGlzIG5vdCBhbiBhcnJheSAob3V0LW9mLW9yZGVyXG4gKiAgICAgcmVwbGF5IGJhc2UsIG9yIGEgUkVEQUNURUQgdGFpbCDigJQgYHJlZGFjdFBhdGNoYCByZXBsYWNlcyBtYXRjaGVkXG4gKiAgICAgcGF5bG9hZHMgd2l0aCB0aGUgYCdSRURBQ1RFRCdgIHN0cmluZyksIGRlZ3JhZGUgdG8gYSBkaXJlY3Qgc2V0IG9mIHRoZVxuICogICAgIHJlY29yZGVkIHZhbHVlIOKAlCB0aGUgc2FtZSB0ZXJtaW5hbCB2YWx1ZSBhIHJlZGFjdGVkL2NvcnJ1cHQgYCdzZXQnYFxuICogICAgIHByb2R1Y2VzLlxuICogICAtIGAnZGVsZXRlJ2Ag4oCUICgjMTNjLUIgZGVsdGEgbW9kZSkgcmVtb3ZlIHRoZSBrZXkgKGBuYXRpdmVEZWxldGVgLFxuICogICAgIHByb3RvdHlwZS1wb2xsdXRpb24tc2FmZSkuIFRoZSBwYXRoIHN0YXlzIGVudW1lcmF0ZWQgaW4gYG92ZXJ3cml0ZWBcbiAqICAgICAodmFsdWUgYHVuZGVmaW5lZGApIGZvciBrZXktc2V0IGNvbnN1bWVyczsgcmVwbGF5IGlnbm9yZXMgdGhhdCB2YWx1ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5U21hcnRNZXJnZShiYXNlOiBhbnksIHVwZGF0ZXM6IE1lbW9yeVBhdGNoLCBvdmVyd3JpdGU6IE1lbW9yeVBhdGNoLCB0cmFjZTogVHJhY2VFbnRyeVtdKTogYW55IHtcbiAgY29uc3Qgb3V0ID0gc3RydWN0dXJlZENsb25lKGJhc2UpO1xuICBmb3IgKGNvbnN0IHsgcGF0aCwgdmVyYiB9IG9mIHRyYWNlKSB7XG4gICAgY29uc3Qgc2VncyA9IHBhdGguc3BsaXQoREVMSU0pO1xuICAgIGlmICh2ZXJiID09PSAnc2V0Jykge1xuICAgICAgX3NldChvdXQsIHNlZ3MsIHN0cnVjdHVyZWRDbG9uZShfZ2V0KG92ZXJ3cml0ZSwgc2VncykpKTtcbiAgICB9IGVsc2UgaWYgKHZlcmIgPT09ICdhcHBlbmQnKSB7XG4gICAgICBjb25zdCB0YWlsID0gc3RydWN0dXJlZENsb25lKF9nZXQob3ZlcndyaXRlLCBzZWdzKSk7XG4gICAgICBjb25zdCBjdXJyZW50ID0gX2dldChvdXQsIHNlZ3MpO1xuICAgICAgX3NldChvdXQsIHNlZ3MsIEFycmF5LmlzQXJyYXkoY3VycmVudCkgJiYgQXJyYXkuaXNBcnJheSh0YWlsKSA/IFsuLi5jdXJyZW50LCAuLi50YWlsXSA6IHRhaWwpO1xuICAgIH0gZWxzZSBpZiAodmVyYiA9PT0gJ2RlbGV0ZScpIHtcbiAgICAgIG5hdGl2ZURlbGV0ZShvdXQsIHNlZ3MpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gX2dldChvdXQsIHNlZ3MpID8/IHt9O1xuICAgICAgX3NldChvdXQsIHNlZ3MsIGRlZXBTbWFydE1lcmdlKGN1cnJlbnQsIF9nZXQodXBkYXRlcywgc2VncykpKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cbiJdfQ==