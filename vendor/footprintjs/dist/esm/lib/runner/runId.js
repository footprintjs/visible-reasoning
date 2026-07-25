/**
 * runId — per-`executor.run()` identifier generator.
 *
 * Pattern: monotonic counter + clock-guarded timestamp. One id per
 *          call to `executor.run()` (or `executor.resume()`). Stable
 *          for the duration of that run; unique across consecutive
 *          runs.
 * Role:    primitive that solves the "two consecutive runs of the
 *          same executor produce identical runtimeStageIds" class of
 *          bugs. Recorders that accumulate state across runs detect
 *          "new run" via `runId` change and reset transient
 *          bookkeeping.
 *
 * Format: `${timestamp}-${counter}`.
 *   - `timestamp` is `Date.now()` clamped to a monotonic-clock guard
 *     (never decreases — protects against NTP / system-clock
 *     adjustments).
 *   - `counter` is a process-local incrementing integer, ZERO-PADDED
 *     to 10 digits so lexicographic sort matches numeric order
 *     (`"...001"` < `"...010"` < `"...100"`). 10 digits = 10 billion
 *     runs in a single process — sufficient for any real workload.
 *
 * Lexicographic ordering of `runId` strings matches chronological
 * ordering for runs that are at least 1ms apart, AND for runs that
 * happen within the same millisecond (because the padded counter
 * tie-breaks). The counter NEVER resets — it is process-global.
 *
 * Process-local only. Cross-process correlation uses
 * `getEnv().traceId` (consumer-supplied), not `runId`. Documented
 * in `docs/design/v5-recorder-redesign.md` Section 8.1.
 */
let _counter = 0;
let _lastTimestamp = 0;
/**
 * Generate a fresh runId. Called once per `executor.run()` and once
 * per `executor.resume()`. Pure (deterministic for a given clock +
 * counter state); no side effects beyond advancing the counter and
 * monotonic-clock guard.
 */
export function generateRunId() {
    // Monotonic-clock guard: if Date.now() ticks backward (NTP slew,
    // VM pause + resume, etc.), pin to the last seen timestamp so
    // sort order never breaks.
    const now = Date.now();
    if (now > _lastTimestamp) {
        _lastTimestamp = now;
    }
    // Counter is process-global, monotonic. Never resets across runs.
    // Even if two runs share the same `_lastTimestamp` value, their
    // counter values differ, so runIds remain unique.
    // Pad to 10 digits so lexicographic sort matches numeric order.
    const counter = (++_counter).toString().padStart(10, '0');
    return `${_lastTimestamp}-${counter}`;
}
/**
 * Reset the runId state. Test-only. NEVER call from production code —
 * runIds must be process-globally monotonic.
 *
 * @internal
 */
export function _resetRunIdStateForTesting() {
    _counter = 0;
    _lastTimestamp = 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVuSWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3J1bm5lci9ydW5JZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBOEJHO0FBRUgsSUFBSSxRQUFRLEdBQUcsQ0FBQyxDQUFDO0FBQ2pCLElBQUksY0FBYyxHQUFHLENBQUMsQ0FBQztBQUV2Qjs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSxhQUFhO0lBQzNCLGlFQUFpRTtJQUNqRSw4REFBOEQ7SUFDOUQsMkJBQTJCO0lBQzNCLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN2QixJQUFJLEdBQUcsR0FBRyxjQUFjLEVBQUUsQ0FBQztRQUN6QixjQUFjLEdBQUcsR0FBRyxDQUFDO0lBQ3ZCLENBQUM7SUFDRCxrRUFBa0U7SUFDbEUsZ0VBQWdFO0lBQ2hFLGtEQUFrRDtJQUNsRCxnRUFBZ0U7SUFDaEUsTUFBTSxPQUFPLEdBQUcsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLFFBQVEsRUFBRSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDMUQsT0FBTyxHQUFHLGNBQWMsSUFBSSxPQUFPLEVBQUUsQ0FBQztBQUN4QyxDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUsMEJBQTBCO0lBQ3hDLFFBQVEsR0FBRyxDQUFDLENBQUM7SUFDYixjQUFjLEdBQUcsQ0FBQyxDQUFDO0FBQ3JCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHJ1bklkIOKAlCBwZXItYGV4ZWN1dG9yLnJ1bigpYCBpZGVudGlmaWVyIGdlbmVyYXRvci5cbiAqXG4gKiBQYXR0ZXJuOiBtb25vdG9uaWMgY291bnRlciArIGNsb2NrLWd1YXJkZWQgdGltZXN0YW1wLiBPbmUgaWQgcGVyXG4gKiAgICAgICAgICBjYWxsIHRvIGBleGVjdXRvci5ydW4oKWAgKG9yIGBleGVjdXRvci5yZXN1bWUoKWApLiBTdGFibGVcbiAqICAgICAgICAgIGZvciB0aGUgZHVyYXRpb24gb2YgdGhhdCBydW47IHVuaXF1ZSBhY3Jvc3MgY29uc2VjdXRpdmVcbiAqICAgICAgICAgIHJ1bnMuXG4gKiBSb2xlOiAgICBwcmltaXRpdmUgdGhhdCBzb2x2ZXMgdGhlIFwidHdvIGNvbnNlY3V0aXZlIHJ1bnMgb2YgdGhlXG4gKiAgICAgICAgICBzYW1lIGV4ZWN1dG9yIHByb2R1Y2UgaWRlbnRpY2FsIHJ1bnRpbWVTdGFnZUlkc1wiIGNsYXNzIG9mXG4gKiAgICAgICAgICBidWdzLiBSZWNvcmRlcnMgdGhhdCBhY2N1bXVsYXRlIHN0YXRlIGFjcm9zcyBydW5zIGRldGVjdFxuICogICAgICAgICAgXCJuZXcgcnVuXCIgdmlhIGBydW5JZGAgY2hhbmdlIGFuZCByZXNldCB0cmFuc2llbnRcbiAqICAgICAgICAgIGJvb2trZWVwaW5nLlxuICpcbiAqIEZvcm1hdDogYCR7dGltZXN0YW1wfS0ke2NvdW50ZXJ9YC5cbiAqICAgLSBgdGltZXN0YW1wYCBpcyBgRGF0ZS5ub3coKWAgY2xhbXBlZCB0byBhIG1vbm90b25pYy1jbG9jayBndWFyZFxuICogICAgIChuZXZlciBkZWNyZWFzZXMg4oCUIHByb3RlY3RzIGFnYWluc3QgTlRQIC8gc3lzdGVtLWNsb2NrXG4gKiAgICAgYWRqdXN0bWVudHMpLlxuICogICAtIGBjb3VudGVyYCBpcyBhIHByb2Nlc3MtbG9jYWwgaW5jcmVtZW50aW5nIGludGVnZXIsIFpFUk8tUEFEREVEXG4gKiAgICAgdG8gMTAgZGlnaXRzIHNvIGxleGljb2dyYXBoaWMgc29ydCBtYXRjaGVzIG51bWVyaWMgb3JkZXJcbiAqICAgICAoYFwiLi4uMDAxXCJgIDwgYFwiLi4uMDEwXCJgIDwgYFwiLi4uMTAwXCJgKS4gMTAgZGlnaXRzID0gMTAgYmlsbGlvblxuICogICAgIHJ1bnMgaW4gYSBzaW5nbGUgcHJvY2VzcyDigJQgc3VmZmljaWVudCBmb3IgYW55IHJlYWwgd29ya2xvYWQuXG4gKlxuICogTGV4aWNvZ3JhcGhpYyBvcmRlcmluZyBvZiBgcnVuSWRgIHN0cmluZ3MgbWF0Y2hlcyBjaHJvbm9sb2dpY2FsXG4gKiBvcmRlcmluZyBmb3IgcnVucyB0aGF0IGFyZSBhdCBsZWFzdCAxbXMgYXBhcnQsIEFORCBmb3IgcnVucyB0aGF0XG4gKiBoYXBwZW4gd2l0aGluIHRoZSBzYW1lIG1pbGxpc2Vjb25kIChiZWNhdXNlIHRoZSBwYWRkZWQgY291bnRlclxuICogdGllLWJyZWFrcykuIFRoZSBjb3VudGVyIE5FVkVSIHJlc2V0cyDigJQgaXQgaXMgcHJvY2Vzcy1nbG9iYWwuXG4gKlxuICogUHJvY2Vzcy1sb2NhbCBvbmx5LiBDcm9zcy1wcm9jZXNzIGNvcnJlbGF0aW9uIHVzZXNcbiAqIGBnZXRFbnYoKS50cmFjZUlkYCAoY29uc3VtZXItc3VwcGxpZWQpLCBub3QgYHJ1bklkYC4gRG9jdW1lbnRlZFxuICogaW4gYGRvY3MvZGVzaWduL3Y1LXJlY29yZGVyLXJlZGVzaWduLm1kYCBTZWN0aW9uIDguMS5cbiAqL1xuXG5sZXQgX2NvdW50ZXIgPSAwO1xubGV0IF9sYXN0VGltZXN0YW1wID0gMDtcblxuLyoqXG4gKiBHZW5lcmF0ZSBhIGZyZXNoIHJ1bklkLiBDYWxsZWQgb25jZSBwZXIgYGV4ZWN1dG9yLnJ1bigpYCBhbmQgb25jZVxuICogcGVyIGBleGVjdXRvci5yZXN1bWUoKWAuIFB1cmUgKGRldGVybWluaXN0aWMgZm9yIGEgZ2l2ZW4gY2xvY2sgK1xuICogY291bnRlciBzdGF0ZSk7IG5vIHNpZGUgZWZmZWN0cyBiZXlvbmQgYWR2YW5jaW5nIHRoZSBjb3VudGVyIGFuZFxuICogbW9ub3RvbmljLWNsb2NrIGd1YXJkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVSdW5JZCgpOiBzdHJpbmcge1xuICAvLyBNb25vdG9uaWMtY2xvY2sgZ3VhcmQ6IGlmIERhdGUubm93KCkgdGlja3MgYmFja3dhcmQgKE5UUCBzbGV3LFxuICAvLyBWTSBwYXVzZSArIHJlc3VtZSwgZXRjLiksIHBpbiB0byB0aGUgbGFzdCBzZWVuIHRpbWVzdGFtcCBzb1xuICAvLyBzb3J0IG9yZGVyIG5ldmVyIGJyZWFrcy5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgaWYgKG5vdyA+IF9sYXN0VGltZXN0YW1wKSB7XG4gICAgX2xhc3RUaW1lc3RhbXAgPSBub3c7XG4gIH1cbiAgLy8gQ291bnRlciBpcyBwcm9jZXNzLWdsb2JhbCwgbW9ub3RvbmljLiBOZXZlciByZXNldHMgYWNyb3NzIHJ1bnMuXG4gIC8vIEV2ZW4gaWYgdHdvIHJ1bnMgc2hhcmUgdGhlIHNhbWUgYF9sYXN0VGltZXN0YW1wYCB2YWx1ZSwgdGhlaXJcbiAgLy8gY291bnRlciB2YWx1ZXMgZGlmZmVyLCBzbyBydW5JZHMgcmVtYWluIHVuaXF1ZS5cbiAgLy8gUGFkIHRvIDEwIGRpZ2l0cyBzbyBsZXhpY29ncmFwaGljIHNvcnQgbWF0Y2hlcyBudW1lcmljIG9yZGVyLlxuICBjb25zdCBjb3VudGVyID0gKCsrX2NvdW50ZXIpLnRvU3RyaW5nKCkucGFkU3RhcnQoMTAsICcwJyk7XG4gIHJldHVybiBgJHtfbGFzdFRpbWVzdGFtcH0tJHtjb3VudGVyfWA7XG59XG5cbi8qKlxuICogUmVzZXQgdGhlIHJ1bklkIHN0YXRlLiBUZXN0LW9ubHkuIE5FVkVSIGNhbGwgZnJvbSBwcm9kdWN0aW9uIGNvZGUg4oCUXG4gKiBydW5JZHMgbXVzdCBiZSBwcm9jZXNzLWdsb2JhbGx5IG1vbm90b25pYy5cbiAqXG4gKiBAaW50ZXJuYWxcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNldFJ1bklkU3RhdGVGb3JUZXN0aW5nKCk6IHZvaWQge1xuICBfY291bnRlciA9IDA7XG4gIF9sYXN0VGltZXN0YW1wID0gMDtcbn1cbiJdfQ==