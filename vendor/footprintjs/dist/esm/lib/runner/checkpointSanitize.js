/**
 * checkpointSanitize — clone-resilience helpers for `buildPauseCheckpoint`.
 *
 * The pause checkpoint is detached via one `structuredClone` of the assembled
 * checkpoint. The JSON-safe contract governs what CONSUMERS put into a
 * checkpoint (pauseData, shared state) — but the execution tree's diagnostic
 * bags (`logs`/`errors`/`metrics`/`evals`) accept ANY value at write time
 * without cloning (`$debug`/`$error`/`$metric`/`$eval` route through
 * `DiagnosticCollector`, which stores raw references). A `$debug`'d function
 * in any stage of a pausing run would make the whole-checkpoint clone throw
 * `DataCloneError` — swallowing the pause.
 *
 * That violates the library's error-isolation grain: observability side-bags
 * never abort traversal anywhere else. These helpers restore the grain:
 *
 *   - `sanitizeDiagnosticBags` — replace non-cloneable diagnostic values with
 *     marker strings (`'[non-serializable: function]'`) so the pause survives.
 *   - `describeCheckpointCloneFailure` — when the clone STILL fails after
 *     sanitization (the non-cloneable lives in consumer-owned data, e.g.
 *     `pauseData`), name the offending checkpoint field(s) and point at the
 *     JSON-safe contract instead of letting a naked `DataCloneError` escape.
 *
 * Both run ONLY on the clone-failure path of a pause — never on the hot path.
 */
/** The StageSnapshot fields written by `$debug`/`$error`/`$metric`/`$eval`. */
const DIAGNOSTIC_BAGS = ['logs', 'errors', 'metrics', 'evals'];
/** `true` when `structuredClone` accepts the value as-is. */
function isCloneable(value) {
    try {
        structuredClone(value);
        return true;
    }
    catch {
        return false;
    }
}
/** Human-readable kind for the `[non-serializable: …]` marker. */
function describeKind(value) {
    if (value === null)
        return 'null';
    if (typeof value !== 'object')
        return typeof value;
    return value.constructor?.name ?? 'object';
}
/** Plain data container we can rebuild entry-by-entry without lying about the type. */
function isPlainObject(value) {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/**
 * Deep-replace non-cloneable values with `'[non-serializable: <kind>]'`
 * marker strings, preserving everything `structuredClone` accepts.
 *
 * Fast path: a cloneable value is returned AS-IS (no copy — the caller
 * clones the whole checkpoint right after). Only containers that actually
 * hold a non-cloneable leaf are rebuilt, and only KNOWN container shapes
 * (array / Map / Set / plain object) are rebuilt entry-by-entry — exotic
 * non-cloneables (Promise, WeakMap, class instances holding a function, …)
 * become a typed marker rather than a misleading empty shell. Pure cycles
 * pass the fast path untouched (`structuredClone` supports them); a cycle
 * is only broken — with a marker — when it shares a container with a
 * non-cloneable value.
 */
function sanitizeValue(value, seen) {
    if (isCloneable(value))
        return value;
    if (value !== null && typeof value === 'object') {
        if (seen.has(value))
            return '[non-serializable: circular]';
        seen.add(value);
        if (Array.isArray(value)) {
            return value.map((v) => sanitizeValue(v, seen));
        }
        if (value instanceof Map) {
            return new Map([...value].map(([k, v]) => [sanitizeValue(k, seen), sanitizeValue(v, seen)]));
        }
        if (value instanceof Set) {
            return new Set([...value].map((v) => sanitizeValue(v, seen)));
        }
        if (isPlainObject(value)) {
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, seen)]));
        }
    }
    return `[non-serializable: ${describeKind(value)}]`;
}
/**
 * Walk a `StageSnapshot` tree (via `next` + `children`) and sanitize the four
 * diagnostic bags on every node IN PLACE.
 *
 * In-place is safe and intentional: `StageContext.getSnapshot()` builds fresh
 * node objects on every call, but the bag fields on those fresh nodes ALIAS
 * the live `DiagnosticCollector` bags. We replace the node's bag REFERENCE
 * with a sanitized copy — the live engine bags are never mutated, so a
 * same-executor resume keeps the original diagnostic values.
 */
export function sanitizeDiagnosticBags(tree) {
    const seen = new WeakSet();
    const visit = (node) => {
        for (const bag of DIAGNOSTIC_BAGS) {
            const bagValue = node[bag];
            if (bagValue !== undefined && !isCloneable(bagValue)) {
                node[bag] = sanitizeValue(bagValue, seen);
            }
        }
        if (node.next)
            visit(node.next);
        if (node.children)
            for (const child of node.children)
                visit(child);
    };
    visit(tree);
    return tree;
}
/**
 * Build the DESCRIPTIVE error for a checkpoint that still cannot be cloned
 * after diagnostic-bag sanitization — i.e. the non-cloneable value lives in
 * consumer-owned data (a genuine JSON-safe contract violation). Probes each
 * top-level checkpoint field individually so the message names the offending
 * field family. Never lets a naked `DataCloneError` escape.
 */
export function describeCheckpointCloneFailure(checkpoint, cause) {
    const failing = Object.entries(checkpoint)
        .filter(([, value]) => !isCloneable(value))
        .map(([field]) => field);
    const fields = failing.length > 0 ? failing.join(', ') : 'unknown';
    return new Error('FlowChartExecutor: cannot build the pause checkpoint — non-serializable value(s) in ' +
        `checkpoint field(s): ${fields}. The checkpoint contract is JSON-safe (no functions, no ` +
        "class instances). Check the pauseData returned by the pausable stage's execute(), and any " +
        'subflow state captured at the pause. Diagnostic values from $debug/$metric/$error/$eval ' +
        'are sanitized automatically and never cause this error. ' +
        'See docs/guides/execution-model.md ("Pause / resume — what a checkpoint captures").', { cause });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hlY2twb2ludFNhbml0aXplLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9ydW5uZXIvY2hlY2twb2ludFNhbml0aXplLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVCRztBQUlILCtFQUErRTtBQUMvRSxNQUFNLGVBQWUsR0FBRyxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLE9BQU8sQ0FBVSxDQUFDO0FBRXhFLDZEQUE2RDtBQUM3RCxTQUFTLFdBQVcsQ0FBQyxLQUFjO0lBQ2pDLElBQUksQ0FBQztRQUNILGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2QixPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7QUFDSCxDQUFDO0FBRUQsa0VBQWtFO0FBQ2xFLFNBQVMsWUFBWSxDQUFDLEtBQWM7SUFDbEMsSUFBSSxLQUFLLEtBQUssSUFBSTtRQUFFLE9BQU8sTUFBTSxDQUFDO0lBQ2xDLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sT0FBTyxLQUFLLENBQUM7SUFDbkQsT0FBTyxLQUFLLENBQUMsV0FBVyxFQUFFLElBQUksSUFBSSxRQUFRLENBQUM7QUFDN0MsQ0FBQztBQUVELHVGQUF1RjtBQUN2RixTQUFTLGFBQWEsQ0FBQyxLQUFhO0lBQ2xDLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFrQixDQUFDO0lBQzVELE9BQU8sS0FBSyxLQUFLLE1BQU0sQ0FBQyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksQ0FBQztBQUN0RCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7R0FhRztBQUNILFNBQVMsYUFBYSxDQUFDLEtBQWMsRUFBRSxJQUFxQjtJQUMxRCxJQUFJLFdBQVcsQ0FBQyxLQUFLLENBQUM7UUFBRSxPQUFP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QyxDQUFDLEVBQUUsS0FBSyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO1NBQzFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzNCLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDbkUsT0FBTyxJQUFJLEtBQUssQ0FDZCxzRkFBc0Y7UUFDcEYsd0JBQXdCLE1BQU0sMkRBQTJEO1FBQ3pGLDRGQUE0RjtRQUM1RiwwRkFBMEY7UUFDMUYsMERBQTBEO1FBQzFELHFGQUFxRixFQUN2RixFQUFFLEtBQUssRUFBRSxDQUNWLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBjaGVja3BvaW50U2FuaXRpemUg4oCUIGNsb25lLXJlc2lsaWVuY2UgaGVscGVycyBmb3IgYGJ1aWxkUGF1c2VDaGVja3BvaW50YC5cbiAqXG4gKiBUaGUgcGF1c2UgY2hlY2twb2ludCBpcyBkZXRhY2hlZCB2aWEgb25lIGBzdHJ1Y3R1cmVkQ2xvbmVgIG9mIHRoZSBhc3NlbWJsZWRcbiAqIGNoZWNrcG9pbnQuIFRoZSBKU09OLXNhZmUgY29udHJhY3QgZ292ZXJucyB3aGF0IENPTlNVTUVSUyBwdXQgaW50byBhXG4gKiBjaGVja3BvaW50IChwYXVzZURhdGEsIHNoYXJlZCBzdGF0ZSkg4oCUIGJ1dCB0aGUgZXhlY3V0aW9uIHRyZWUncyBkaWFnbm9zdGljXG4gKiBiYWdzIChgbG9nc2AvYGVycm9yc2AvYG1ldHJpY3NgL2BldmFsc2ApIGFjY2VwdCBBTlkgdmFsdWUgYXQgd3JpdGUgdGltZVxuICogd2l0aG91dCBjbG9uaW5nIChgJGRlYnVnYC9gJGVycm9yYC9gJG1ldHJpY2AvYCRldmFsYCByb3V0ZSB0aHJvdWdoXG4gKiBgRGlhZ25vc3RpY0NvbGxlY3RvcmAsIHdoaWNoIHN0b3JlcyByYXcgcmVmZXJlbmNlcykuIEEgYCRkZWJ1Z2AnZCBmdW5jdGlvblxuICogaW4gYW55IHN0YWdlIG9mIGEgcGF1c2luZyBydW4gd291bGQgbWFrZSB0aGUgd2hvbGUtY2hlY2twb2ludCBjbG9uZSB0aHJvd1xuICogYERhdGFDbG9uZUVycm9yYCDigJQgc3dhbGxvd2luZyB0aGUgcGF1c2UuXG4gKlxuICogVGhhdCB2aW9sYXRlcyB0aGUgbGlicmFyeSdzIGVycm9yLWlzb2xhdGlvbiBncmFpbjogb2JzZXJ2YWJpbGl0eSBzaWRlLWJhZ3NcbiAqIG5ldmVyIGFib3J0IHRyYXZlcnNhbCBhbnl3aGVyZSBlbHNlLiBUaGVzZSBoZWxwZXJzIHJlc3RvcmUgdGhlIGdyYWluOlxuICpcbiAqICAgLSBgc2FuaXRpemVEaWFnbm9zdGljQmFnc2Ag4oCUIHJlcGxhY2Ugbm9uLWNsb25lYWJsZSBkaWFnbm9zdGljIHZhbHVlcyB3aXRoXG4gKiAgICAgbWFya2VyIHN0cmluZ3MgKGAnW25vbi1zZXJpYWxpemFibGU6IGZ1bmN0aW9uXSdgKSBzbyB0aGUgcGF1c2Ugc3Vydml2ZXMuXG4gKiAgIC0gYGRlc2NyaWJlQ2hlY2twb2ludENsb25lRmFpbHVyZWAg4oCUIHdoZW4gdGhlIGNsb25lIFNUSUxMIGZhaWxzIGFmdGVyXG4gKiAgICAgc2FuaXRpemF0aW9uICh0aGUgbm9uLWNsb25lYWJsZSBsaXZlcyBpbiBjb25zdW1lci1vd25lZCBkYXRhLCBlLmcuXG4gKiAgICAgYHBhdXNlRGF0YWApLCBuYW1lIHRoZSBvZmZlbmRpbmcgY2hlY2twb2ludCBmaWVsZChzKSBhbmQgcG9pbnQgYXQgdGhlXG4gKiAgICAgSlNPTi1zYWZlIGNvbnRyYWN0IGluc3RlYWQgb2YgbGV0dGluZyBhIG5ha2VkIGBEYXRhQ2xvbmVFcnJvcmAgZXNjYXBlLlxuICpcbiAqIEJvdGggcnVuIE9OTFkgb24gdGhlIGNsb25lLWZhaWx1cmUgcGF0aCBvZiBhIHBhdXNlIOKAlCBuZXZlciBvbiB0aGUgaG90IHBhdGguXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTdGFnZVNuYXBzaG90IH0gZnJvbSAnLi4vbWVtb3J5L3R5cGVzLmpzJztcblxuLyoqIFRoZSBTdGFnZVNuYXBzaG90IGZpZWxkcyB3cml0dGVuIGJ5IGAkZGVidWdgL2AkZXJyb3JgL2AkbWV0cmljYC9gJGV2YWxgLiAqL1xuY29uc3QgRElBR05PU1RJQ19CQUdTID0gWydsb2dzJywgJ2Vycm9ycycsICdtZXRyaWNzJywgJ2V2YWxzJ10gYXMgY29uc3Q7XG5cbi8qKiBgdHJ1ZWAgd2hlbiBgc3RydWN0dXJlZENsb25lYCBhY2NlcHRzIHRoZSB2YWx1ZSBhcy1pcy4gKi9cbmZ1bmN0aW9uIGlzQ2xvbmVhYmxlKHZhbHVlOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgc3RydWN0dXJlZENsb25lKHZhbHVlKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBIdW1hbi1yZWFkYWJsZSBraW5kIGZvciB0aGUgYFtub24tc2VyaWFsaXphYmxlOiDigKZdYCBtYXJrZXIuICovXG5mdW5jdGlvbiBkZXNjcmliZUtpbmQodmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAnbnVsbCc7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gdHlwZW9mIHZhbHVlO1xuICByZXR1cm4gdmFsdWUuY29uc3RydWN0b3I/Lm5hbWUgPz8gJ29iamVjdCc7XG59XG5cbi8qKiBQbGFpbiBkYXRhIGNvbnRhaW5lciB3ZSBjYW4gcmVidWlsZCBlbnRyeS1ieS1lbnRyeSB3aXRob3V0IGx5aW5nIGFib3V0IHRoZSB0eXBlLiAqL1xuZnVuY3Rpb24gaXNQbGFpbk9iamVjdCh2YWx1ZTogb2JqZWN0KTogYm9vbGVhbiB7XG4gIGNvbnN0IHByb3RvID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKHZhbHVlKSBhcyBvYmplY3QgfCBudWxsO1xuICByZXR1cm4gcHJvdG8gPT09IE9iamVjdC5wcm90b3R5cGUgfHwgcHJvdG8gPT09IG51bGw7XG59XG5cbi8qKlxuICogRGVlcC1yZXBsYWNlIG5vbi1jbG9uZWFibGUgdmFsdWVzIHdpdGggYCdbbm9uLXNlcmlhbGl6YWJsZTogPGtpbmQ+XSdgXG4gKiBtYXJrZXIgc3RyaW5ncywgcHJlc2VydmluZyBldmVyeXRoaW5nIGBzdHJ1Y3R1cmVkQ2xvbmVgIGFjY2VwdHMuXG4gKlxuICogRmFzdCBwYXRoOiBhIGNsb25lYWJsZSB2YWx1ZSBpcyByZXR1cm5lZCBBUy1JUyAobm8gY29weSDigJQgdGhlIGNhbGxlclxuICogY2xvbmVzIHRoZSB3aG9sZSBjaGVja3BvaW50IHJpZ2h0IGFmdGVyKS4gT25seSBjb250YWluZXJzIHRoYXQgYWN0dWFsbHlcbiAqIGhvbGQgYSBub24tY2xvbmVhYmxlIGxlYWYgYXJlIHJlYnVpbHQsIGFuZCBvbmx5IEtOT1dOIGNvbnRhaW5lciBzaGFwZXNcbiAqIChhcnJheSAvIE1hcCAvIFNldCAvIHBsYWluIG9iamVjdCkgYXJlIHJlYnVpbHQgZW50cnktYnktZW50cnkg4oCUIGV4b3RpY1xuICogbm9uLWNsb25lYWJsZXMgKFByb21pc2UsIFdlYWtNYXAsIGNsYXNzIGluc3RhbmNlcyBob2xkaW5nIGEgZnVuY3Rpb24sIOKApilcbiAqIGJlY29tZSBhIHR5cGVkIG1hcmtlciByYXRoZXIgdGhhbiBhIG1pc2xlYWRpbmcgZW1wdHkgc2hlbGwuIFB1cmUgY3ljbGVzXG4gKiBwYXNzIHRoZSBmYXN0IHBhdGggdW50b3VjaGVkIChgc3RydWN0dXJlZENsb25lYCBzdXBwb3J0cyB0aGVtKTsgYSBjeWNsZVxuICogaXMgb25seSBicm9rZW4g4oCUIHdpdGggYSBtYXJrZXIg4oCUIHdoZW4gaXQgc2hhcmVzIGEgY29udGFpbmVyIHdpdGggYVxuICogbm9uLWNsb25lYWJsZSB2YWx1ZS5cbiAqL1xuZnVuY3Rpb24gc2FuaXRpemVWYWx1ZSh2YWx1ZTogdW5rbm93biwgc2VlbjogV2Vha1NldDxvYmplY3Q+KTogdW5rbm93biB7XG4gIGlmIChpc0Nsb25lYWJsZSh2YWx1ZSkpIHJldHVybiB2YWx1ZTtcbiAgaWYgKHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICBpZiAoc2Vlbi5oYXModmFsdWUpKSByZXR1cm4gJ1tub24tc2VyaWFsaXphYmxlOiBjaXJjdWxhcl0nO1xuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiB2YWx1ZS5tYXAoKHYpID0+IHNhbml0aXplVmFsdWUodiwgc2VlbikpO1xuICAgIH1cbiAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBNYXApIHtcbiAgICAgIHJldHVybiBuZXcgTWFwKFsuLi52YWx1ZV0ubWFwKChbaywgdl0pID0+IFtzYW5pdGl6ZVZhbHVlKGssIHNlZW4pLCBzYW5pdGl6ZVZhbHVlKHYsIHNlZW4pXSkpO1xuICAgIH1cbiAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBTZXQpIHtcbiAgICAgIHJldHVybiBuZXcgU2V0KFsuLi52YWx1ZV0ubWFwKCh2KSA9PiBzYW5pdGl6ZVZhbHVlKHYsIHNlZW4pKSk7XG4gICAgfVxuICAgIGlmIChpc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyh2YWx1ZSkubWFwKChbaywgdl0pID0+IFtrLCBzYW5pdGl6ZVZhbHVlKHYsIHNlZW4pXSkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYFtub24tc2VyaWFsaXphYmxlOiAke2Rlc2NyaWJlS2luZCh2YWx1ZSl9XWA7XG59XG5cbi8qKlxuICogV2FsayBhIGBTdGFnZVNuYXBzaG90YCB0cmVlICh2aWEgYG5leHRgICsgYGNoaWxkcmVuYCkgYW5kIHNhbml0aXplIHRoZSBmb3VyXG4gKiBkaWFnbm9zdGljIGJhZ3Mgb24gZXZlcnkgbm9kZSBJTiBQTEFDRS5cbiAqXG4gKiBJbi1wbGFjZSBpcyBzYWZlIGFuZCBpbnRlbnRpb25hbDogYFN0YWdlQ29udGV4dC5nZXRTbmFwc2hvdCgpYCBidWlsZHMgZnJlc2hcbiAqIG5vZGUgb2JqZWN0cyBvbiBldmVyeSBjYWxsLCBidXQgdGhlIGJhZyBmaWVsZHMgb24gdGhvc2UgZnJlc2ggbm9kZXMgQUxJQVNcbiAqIHRoZSBsaXZlIGBEaWFnbm9zdGljQ29sbGVjdG9yYCBiYWdzLiBXZSByZXBsYWNlIHRoZSBub2RlJ3MgYmFnIFJFRkVSRU5DRVxuICogd2l0aCBhIHNhbml0aXplZCBjb3B5IOKAlCB0aGUgbGl2ZSBlbmdpbmUgYmFncyBhcmUgbmV2ZXIgbXV0YXRlZCwgc28gYVxuICogc2FtZS1leGVjdXRvciByZXN1bWUga2VlcHMgdGhlIG9yaWdpbmFsIGRpYWdub3N0aWMgdmFsdWVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2FuaXRpemVEaWFnbm9zdGljQmFncyh0cmVlOiBTdGFnZVNuYXBzaG90KTogU3RhZ2VTbmFwc2hvdCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgV2Vha1NldDxvYmplY3Q+KCk7XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IFN0YWdlU25hcHNob3QpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGJhZyBvZiBESUFHTk9TVElDX0JBR1MpIHtcbiAgICAgIGNvbnN0IGJhZ1ZhbHVlID0gbm9kZVtiYWddO1xuICAgICAgaWYgKGJhZ1ZhbHVlICE9PSB1bmRlZmluZWQgJiYgIWlzQ2xvbmVhYmxlKGJhZ1ZhbHVlKSkge1xuICAgICAgICBub2RlW2JhZ10gPSBzYW5pdGl6ZVZhbHVlKGJhZ1ZhbHVlLCBzZWVuKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG5vZGUubmV4dCkgdmlzaXQobm9kZS5uZXh0KTtcbiAgICBpZiAobm9kZS5jaGlsZHJlbikgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkcmVuKSB2aXNpdChjaGlsZCk7XG4gIH07XG4gIHZpc2l0KHRyZWUpO1xuICByZXR1cm4gdHJlZTtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgREVTQ1JJUFRJVkUgZXJyb3IgZm9yIGEgY2hlY2twb2ludCB0aGF0IHN0aWxsIGNhbm5vdCBiZSBjbG9uZWRcbiAqIGFmdGVyIGRpYWdub3N0aWMtYmFnIHNhbml0aXphdGlvbiDigJQgaS5lLiB0aGUgbm9uLWNsb25lYWJsZSB2YWx1ZSBsaXZlcyBpblxuICogY29uc3VtZXItb3duZWQgZGF0YSAoYSBnZW51aW5lIEpTT04tc2FmZSBjb250cmFjdCB2aW9sYXRpb24pLiBQcm9iZXMgZWFjaFxuICogdG9wLWxldmVsIGNoZWNrcG9pbnQgZmllbGQgaW5kaXZpZHVhbGx5IHNvIHRoZSBtZXNzYWdlIG5hbWVzIHRoZSBvZmZlbmRpbmdcbiAqIGZpZWxkIGZhbWlseS4gTmV2ZXIgbGV0cyBhIG5ha2VkIGBEYXRhQ2xvbmVFcnJvcmAgZXNjYXBlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVDaGVja3BvaW50Q2xvbmVGYWlsdXJlKGNoZWNrcG9pbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBjYXVzZTogdW5rbm93bik6IEVycm9yIHtcbiAgY29uc3QgZmFpbGluZyA9IE9iamVjdC5lbnRyaWVzKGNoZWNrcG9pbnQpXG4gICAgLmZpbHRlcigoWywgdmFsdWVdKSA9PiAhaXNDbG9uZWFibGUodmFsdWUpKVxuICAgIC5tYXAoKFtmaWVsZF0pID0+IGZpZWxkKTtcbiAgY29uc3QgZmllbGRzID0gZmFpbGluZy5sZW5ndGggPiAwID8gZmFpbGluZy5qb2luKCcsICcpIDogJ3Vua25vd24nO1xuICByZXR1cm4gbmV3IEVycm9yKFxuICAgICdGbG93Q2hhcnRFeGVjdXRvcjogY2Fubm90IGJ1aWxkIHRoZSBwYXVzZSBjaGVja3BvaW50IOKAlCBub24tc2VyaWFsaXphYmxlIHZhbHVlKHMpIGluICcgK1xuICAgICAgYGNoZWNrcG9pbnQgZmllbGQocyk6ICR7ZmllbGRzfS4gVGhlIGNoZWNrcG9pbnQgY29udHJhY3QgaXMgSlNPTi1zYWZlIChubyBmdW5jdGlvbnMsIG5vIGAgK1xuICAgICAgXCJjbGFzcyBpbnN0YW5jZXMpLiBDaGVjayB0aGUgcGF1c2VEYXRhIHJldHVybmVkIGJ5IHRoZSBwYXVzYWJsZSBzdGFnZSdzIGV4ZWN1dGUoKSwgYW5kIGFueSBcIiArXG4gICAgICAnc3ViZmxvdyBzdGF0ZSBjYXB0dXJlZCBhdCB0aGUgcGF1c2UuIERpYWdub3N0aWMgdmFsdWVzIGZyb20gJGRlYnVnLyRtZXRyaWMvJGVycm9yLyRldmFsICcgK1xuICAgICAgJ2FyZSBzYW5pdGl6ZWQgYXV0b21hdGljYWxseSBhbmQgbmV2ZXIgY2F1c2UgdGhpcyBlcnJvci4gJyArXG4gICAgICAnU2VlIGRvY3MvZ3VpZGVzL2V4ZWN1dGlvbi1tb2RlbC5tZCAoXCJQYXVzZSAvIHJlc3VtZSDigJQgd2hhdCBhIGNoZWNrcG9pbnQgY2FwdHVyZXNcIikuJyxcbiAgICB7IGNhdXNlIH0sXG4gICk7XG59XG4iXX0=