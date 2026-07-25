/**
 * detectCircular — Dev-mode circular reference detection for scope values.
 *
 * Checks if a value contains circular references using a WeakSet traversal.
 * O(n) where n = total nested objects. Uses WeakSet so no memory leak.
 *
 * Gated by the caller — only called in dev mode to avoid production overhead.
 * Same approach as Immer (detect and warn at runtime).
 */
/**
 * Returns true if the value contains circular references.
 * Only checks plain objects and arrays — class instances, Date, Map, etc. are skipped.
 */
export function hasCircularReference(value, ancestors = new WeakSet()) {
    if (value === null || typeof value !== 'object')
        return false;
    // Skip non-plain objects (Date, Map, Set, class instances) — same as allowlist logic
    if (Array.isArray(value)) {
        if (ancestors.has(value))
            return true;
        ancestors.add(value);
        for (const item of value) {
            if (hasCircularReference(item, ancestors))
                return true;
        }
        ancestors.delete(value); // backtrack — allow diamond references
        return false;
    }
    const ctor = value.constructor;
    if (ctor !== undefined && ctor !== Object)
        return false; // class instance — skip
    if (ancestors.has(value))
        return true;
    ancestors.add(value);
    for (const v of Object.values(value)) {
        if (hasCircularReference(v, ancestors))
            return true;
    }
    ancestors.delete(value); // backtrack — allow diamond references
    return false;
}
/**
 * Global dev-mode flag for the whole `footprintjs` library.
 *
 * ## What it gates
 *
 * Multiple library subsystems use `isDevMode()` to decide whether to run
 * expensive or noisy developer-only checks. Production leaves it OFF (the
 * default) to avoid the cost and keep logs clean. Turning it ON enables:
 *
 *   - Circular-reference detection in `ScopeFacade.setValue()` (O(n) per write).
 *   - Warnings when `attachCombinedRecorder()` receives a recorder with no
 *     observer methods (likely mistake — easy to forget an `on*` handler).
 *   - Warnings from `decide()` / `select()` when a predicate or rule shape
 *     looks suspicious.
 *   - Structural-integrity warnings in `getSubtreeSnapshot()`.
 *   - Any future developer-only diagnostic added to the library.
 *
 * ## How to enable
 *
 * Call `enableDevMode()` once at application startup (typically near your
 * executor construction):
 *
 * ```ts
 * import { enableDevMode } from 'footprintjs';
 *
 * if (process.env.NODE_ENV !== 'production') {
 *   enableDevMode();
 * }
 * ```
 *
 * Alternatively, gate on your own flag — the point is that production stays
 * silent and fast, development is loud and helpful.
 *
 * ## Contract
 *
 * - Default: OFF. A library import does NOT enable dev-mode automatically.
 * - Global: one flag controls all library dev diagnostics. A consumer who
 *   calls `disableDevMode()` silences every dev warning at once.
 * - Process-wide: not per-executor. Enabling mid-run affects subsequent
 *   operations but does not retroactively replay missed checks.
 * - Safe in production: when OFF, every gated check is a cheap `!flag`
 *   branch and adds negligible overhead.
 */
let devModeEnabled = false;
/**
 * Enable dev-mode diagnostics across the whole library.
 *
 * When on, the library performs developer-only checks (circular references,
 * empty recorder detection, suspicious predicate shapes, etc.) and emits
 * `console.warn` messages to help you catch mistakes early.
 *
 * Call once at application startup. See the module header for the full
 * list of what dev-mode gates.
 *
 * @example
 * ```ts
 * import { enableDevMode } from 'footprintjs';
 * if (process.env.NODE_ENV !== 'production') enableDevMode();
 * ```
 */
export function enableDevMode() {
    devModeEnabled = true;
}
/**
 * Disable dev-mode diagnostics across the whole library (default state).
 *
 * All dev-only checks become no-ops. Safe to call in production paths —
 * typically the default never needs to be re-asserted, but this is the
 * documented way to turn the flag off if your code enabled it earlier.
 */
export function disableDevMode() {
    devModeEnabled = false;
}
/**
 * Returns whether dev-mode diagnostics are currently enabled.
 *
 * Library internals call this before running any dev-only check. Consumers
 * rarely need to call it directly — prefer `enableDevMode()` at startup and
 * let the library gate its own diagnostics internally.
 */
export function isDevMode() {
    return devModeEnabled;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGV0ZWN0Q2lyY3VsYXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL2RldGVjdENpcmN1bGFyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OztHQVFHO0FBRUg7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLG9CQUFvQixDQUFDLEtBQWMsRUFBRSxZQUE2QixJQUFJLE9BQU8sRUFBRTtJQUM3RixJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBRTlELHFGQUFxRjtJQUNyRixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN6QixJQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDdEMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNyQixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3pCLElBQUksb0JBQW9CLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQztnQkFBRSxPQUFPLElBQUksQ0FBQztRQUN6RCxDQUFDO1FBQ0QsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLHVDQUF1QztRQUNoRSxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFFRCxNQUFNLElBQUksR0FBSSxLQUFpQyxDQUFDLFdBQVcsQ0FBQztJQUM1RCxJQUFJLElBQUksS0FBSyxTQUFTLElBQUksSUFBSSxLQUFLLE1BQU07UUFBRSxPQUFPLEtBQUssQ0FBQyxDQUFDLHdCQUF3QjtJQUVqRixJQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdEMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUVyQixLQUFLLE1BQU0sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBZ0MsQ0FBQyxFQUFFLENBQUM7UUFDaEUsSUFBSSxvQkFBb0IsQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7SUFDdEQsQ0FBQztJQUNELFNBQVMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyx1Q0FBdUM7SUFDaEUsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTBDRztBQUNILElBQUksY0FBYyxHQUFHLEtBQUssQ0FBQztBQUUzQjs7Ozs7Ozs7Ozs7Ozs7O0dBZUc7QUFDSCxNQUFNLFVBQVUsYUFBYTtJQUMzQixjQUFjLEdBQUcsSUFBSSxDQUFDO0FBQ3hCLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsY0FBYztJQUM1QixjQUFjLEdBQUcsS0FBSyxDQUFDO0FBQ3pCLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsU0FBUztJQUN2QixPQUFPLGNBQWMsQ0FBQztBQUN4QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZXRlY3RDaXJjdWxhciDigJQgRGV2LW1vZGUgY2lyY3VsYXIgcmVmZXJlbmNlIGRldGVjdGlvbiBmb3Igc2NvcGUgdmFsdWVzLlxuICpcbiAqIENoZWNrcyBpZiBhIHZhbHVlIGNvbnRhaW5zIGNpcmN1bGFyIHJlZmVyZW5jZXMgdXNpbmcgYSBXZWFrU2V0IHRyYXZlcnNhbC5cbiAqIE8obikgd2hlcmUgbiA9IHRvdGFsIG5lc3RlZCBvYmplY3RzLiBVc2VzIFdlYWtTZXQgc28gbm8gbWVtb3J5IGxlYWsuXG4gKlxuICogR2F0ZWQgYnkgdGhlIGNhbGxlciDigJQgb25seSBjYWxsZWQgaW4gZGV2IG1vZGUgdG8gYXZvaWQgcHJvZHVjdGlvbiBvdmVyaGVhZC5cbiAqIFNhbWUgYXBwcm9hY2ggYXMgSW1tZXIgKGRldGVjdCBhbmQgd2FybiBhdCBydW50aW1lKS5cbiAqL1xuXG4vKipcbiAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgdmFsdWUgY29udGFpbnMgY2lyY3VsYXIgcmVmZXJlbmNlcy5cbiAqIE9ubHkgY2hlY2tzIHBsYWluIG9iamVjdHMgYW5kIGFycmF5cyDigJQgY2xhc3MgaW5zdGFuY2VzLCBEYXRlLCBNYXAsIGV0Yy4gYXJlIHNraXBwZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNDaXJjdWxhclJlZmVyZW5jZSh2YWx1ZTogdW5rbm93biwgYW5jZXN0b3JzOiBXZWFrU2V0PG9iamVjdD4gPSBuZXcgV2Vha1NldCgpKTogYm9vbGVhbiB7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gU2tpcCBub24tcGxhaW4gb2JqZWN0cyAoRGF0ZSwgTWFwLCBTZXQsIGNsYXNzIGluc3RhbmNlcykg4oCUIHNhbWUgYXMgYWxsb3dsaXN0IGxvZ2ljXG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIGlmIChhbmNlc3RvcnMuaGFzKHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gICAgYW5jZXN0b3JzLmFkZCh2YWx1ZSk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHZhbHVlKSB7XG4gICAgICBpZiAoaGFzQ2lyY3VsYXJSZWZlcmVuY2UoaXRlbSwgYW5jZXN0b3JzKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGFuY2VzdG9ycy5kZWxldGUodmFsdWUpOyAvLyBiYWNrdHJhY2sg4oCUIGFsbG93IGRpYW1vbmQgcmVmZXJlbmNlc1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGNvbnN0IGN0b3IgPSAodmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmNvbnN0cnVjdG9yO1xuICBpZiAoY3RvciAhPT0gdW5kZWZpbmVkICYmIGN0b3IgIT09IE9iamVjdCkgcmV0dXJuIGZhbHNlOyAvLyBjbGFzcyBpbnN0YW5jZSDigJQgc2tpcFxuXG4gIGlmIChhbmNlc3RvcnMuaGFzKHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gIGFuY2VzdG9ycy5hZGQodmFsdWUpO1xuXG4gIGZvciAoY29uc3QgdiBvZiBPYmplY3QudmFsdWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgIGlmIChoYXNDaXJjdWxhclJlZmVyZW5jZSh2LCBhbmNlc3RvcnMpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICBhbmNlc3RvcnMuZGVsZXRlKHZhbHVlKTsgLy8gYmFja3RyYWNrIOKAlCBhbGxvdyBkaWFtb25kIHJlZmVyZW5jZXNcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIEdsb2JhbCBkZXYtbW9kZSBmbGFnIGZvciB0aGUgd2hvbGUgYGZvb3RwcmludGpzYCBsaWJyYXJ5LlxuICpcbiAqICMjIFdoYXQgaXQgZ2F0ZXNcbiAqXG4gKiBNdWx0aXBsZSBsaWJyYXJ5IHN1YnN5c3RlbXMgdXNlIGBpc0Rldk1vZGUoKWAgdG8gZGVjaWRlIHdoZXRoZXIgdG8gcnVuXG4gKiBleHBlbnNpdmUgb3Igbm9pc3kgZGV2ZWxvcGVyLW9ubHkgY2hlY2tzLiBQcm9kdWN0aW9uIGxlYXZlcyBpdCBPRkYgKHRoZVxuICogZGVmYXVsdCkgdG8gYXZvaWQgdGhlIGNvc3QgYW5kIGtlZXAgbG9ncyBjbGVhbi4gVHVybmluZyBpdCBPTiBlbmFibGVzOlxuICpcbiAqICAgLSBDaXJjdWxhci1yZWZlcmVuY2UgZGV0ZWN0aW9uIGluIGBTY29wZUZhY2FkZS5zZXRWYWx1ZSgpYCAoTyhuKSBwZXIgd3JpdGUpLlxuICogICAtIFdhcm5pbmdzIHdoZW4gYGF0dGFjaENvbWJpbmVkUmVjb3JkZXIoKWAgcmVjZWl2ZXMgYSByZWNvcmRlciB3aXRoIG5vXG4gKiAgICAgb2JzZXJ2ZXIgbWV0aG9kcyAobGlrZWx5IG1pc3Rha2Ug4oCUIGVhc3kgdG8gZm9yZ2V0IGFuIGBvbipgIGhhbmRsZXIpLlxuICogICAtIFdhcm5pbmdzIGZyb20gYGRlY2lkZSgpYCAvIGBzZWxlY3QoKWAgd2hlbiBhIHByZWRpY2F0ZSBvciBydWxlIHNoYXBlXG4gKiAgICAgbG9va3Mgc3VzcGljaW91cy5cbiAqICAgLSBTdHJ1Y3R1cmFsLWludGVncml0eSB3YXJuaW5ncyBpbiBgZ2V0U3VidHJlZVNuYXBzaG90KClgLlxuICogICAtIEFueSBmdXR1cmUgZGV2ZWxvcGVyLW9ubHkgZGlhZ25vc3RpYyBhZGRlZCB0byB0aGUgbGlicmFyeS5cbiAqXG4gKiAjIyBIb3cgdG8gZW5hYmxlXG4gKlxuICogQ2FsbCBgZW5hYmxlRGV2TW9kZSgpYCBvbmNlIGF0IGFwcGxpY2F0aW9uIHN0YXJ0dXAgKHR5cGljYWxseSBuZWFyIHlvdXJcbiAqIGV4ZWN1dG9yIGNvbnN0cnVjdGlvbik6XG4gKlxuICogYGBgdHNcbiAqIGltcG9ydCB7IGVuYWJsZURldk1vZGUgfSBmcm9tICdmb290cHJpbnRqcyc7XG4gKlxuICogaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WICE9PSAncHJvZHVjdGlvbicpIHtcbiAqICAgZW5hYmxlRGV2TW9kZSgpO1xuICogfVxuICogYGBgXG4gKlxuICogQWx0ZXJuYXRpdmVseSwgZ2F0ZSBvbiB5b3VyIG93biBmbGFnIOKAlCB0aGUgcG9pbnQgaXMgdGhhdCBwcm9kdWN0aW9uIHN0YXlzXG4gKiBzaWxlbnQgYW5kIGZhc3QsIGRldmVsb3BtZW50IGlzIGxvdWQgYW5kIGhlbHBmdWwuXG4gKlxuICogIyMgQ29udHJhY3RcbiAqXG4gKiAtIERlZmF1bHQ6IE9GRi4gQSBsaWJyYXJ5IGltcG9ydCBkb2VzIE5PVCBlbmFibGUgZGV2LW1vZGUgYXV0b21hdGljYWxseS5cbiAqIC0gR2xvYmFsOiBvbmUgZmxhZyBjb250cm9scyBhbGwgbGlicmFyeSBkZXYgZGlhZ25vc3RpY3MuIEEgY29uc3VtZXIgd2hvXG4gKiAgIGNhbGxzIGBkaXNhYmxlRGV2TW9kZSgpYCBzaWxlbmNlcyBldmVyeSBkZXYgd2FybmluZyBhdCBvbmNlLlxuICogLSBQcm9jZXNzLXdpZGU6IG5vdCBwZXItZXhlY3V0b3IuIEVuYWJsaW5nIG1pZC1ydW4gYWZmZWN0cyBzdWJzZXF1ZW50XG4gKiAgIG9wZXJhdGlvbnMgYnV0IGRvZXMgbm90IHJldHJvYWN0aXZlbHkgcmVwbGF5IG1pc3NlZCBjaGVja3MuXG4gKiAtIFNhZmUgaW4gcHJvZHVjdGlvbjogd2hlbiBPRkYsIGV2ZXJ5IGdhdGVkIGNoZWNrIGlzIGEgY2hlYXAgYCFmbGFnYFxuICogICBicmFuY2ggYW5kIGFkZHMgbmVnbGlnaWJsZSBvdmVyaGVhZC5cbiAqL1xubGV0IGRldk1vZGVFbmFibGVkID0gZmFsc2U7XG5cbi8qKlxuICogRW5hYmxlIGRldi1tb2RlIGRpYWdub3N0aWNzIGFjcm9zcyB0aGUgd2hvbGUgbGlicmFyeS5cbiAqXG4gKiBXaGVuIG9uLCB0aGUgbGlicmFyeSBwZXJmb3JtcyBkZXZlbG9wZXItb25seSBjaGVja3MgKGNpcmN1bGFyIHJlZmVyZW5jZXMsXG4gKiBlbXB0eSByZWNvcmRlciBkZXRlY3Rpb24sIHN1c3BpY2lvdXMgcHJlZGljYXRlIHNoYXBlcywgZXRjLikgYW5kIGVtaXRzXG4gKiBgY29uc29sZS53YXJuYCBtZXNzYWdlcyB0byBoZWxwIHlvdSBjYXRjaCBtaXN0YWtlcyBlYXJseS5cbiAqXG4gKiBDYWxsIG9uY2UgYXQgYXBwbGljYXRpb24gc3RhcnR1cC4gU2VlIHRoZSBtb2R1bGUgaGVhZGVyIGZvciB0aGUgZnVsbFxuICogbGlzdCBvZiB3aGF0IGRldi1tb2RlIGdhdGVzLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgZW5hYmxlRGV2TW9kZSB9IGZyb20gJ2Zvb3RwcmludGpzJztcbiAqIGlmIChwcm9jZXNzLmVudi5OT0RFX0VOViAhPT0gJ3Byb2R1Y3Rpb24nKSBlbmFibGVEZXZNb2RlKCk7XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuYWJsZURldk1vZGUoKTogdm9pZCB7XG4gIGRldk1vZGVFbmFibGVkID0gdHJ1ZTtcbn1cblxuLyoqXG4gKiBEaXNhYmxlIGRldi1tb2RlIGRpYWdub3N0aWNzIGFjcm9zcyB0aGUgd2hvbGUgbGlicmFyeSAoZGVmYXVsdCBzdGF0ZSkuXG4gKlxuICogQWxsIGRldi1vbmx5IGNoZWNrcyBiZWNvbWUgbm8tb3BzLiBTYWZlIHRvIGNhbGwgaW4gcHJvZHVjdGlvbiBwYXRocyDigJRcbiAqIHR5cGljYWxseSB0aGUgZGVmYXVsdCBuZXZlciBuZWVkcyB0byBiZSByZS1hc3NlcnRlZCwgYnV0IHRoaXMgaXMgdGhlXG4gKiBkb2N1bWVudGVkIHdheSB0byB0dXJuIHRoZSBmbGFnIG9mZiBpZiB5b3VyIGNvZGUgZW5hYmxlZCBpdCBlYXJsaWVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGlzYWJsZURldk1vZGUoKTogdm9pZCB7XG4gIGRldk1vZGVFbmFibGVkID0gZmFsc2U7XG59XG5cbi8qKlxuICogUmV0dXJucyB3aGV0aGVyIGRldi1tb2RlIGRpYWdub3N0aWNzIGFyZSBjdXJyZW50bHkgZW5hYmxlZC5cbiAqXG4gKiBMaWJyYXJ5IGludGVybmFscyBjYWxsIHRoaXMgYmVmb3JlIHJ1bm5pbmcgYW55IGRldi1vbmx5IGNoZWNrLiBDb25zdW1lcnNcbiAqIHJhcmVseSBuZWVkIHRvIGNhbGwgaXQgZGlyZWN0bHkg4oCUIHByZWZlciBgZW5hYmxlRGV2TW9kZSgpYCBhdCBzdGFydHVwIGFuZFxuICogbGV0IHRoZSBsaWJyYXJ5IGdhdGUgaXRzIG93biBkaWFnbm9zdGljcyBpbnRlcm5hbGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNEZXZNb2RlKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gZGV2TW9kZUVuYWJsZWQ7XG59XG4iXX0=