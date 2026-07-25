// ─── Public typed error ──────────────────────────────────────────────
/**
 * Thrown by `Agent.run()` when a reliability rule routes to `'fail-fast'`
 * and the gate $breaks with a reason. Carries:
 *
 *   • `kind`     — machine-readable identifier from the matched rule's
 *                  `kind` field. Stable across versions; consumers
 *                  branch on this.
 *   • `reason`   — human-readable narrative string from `$break(reason)`.
 *                  Format: `'reliability-{phase}: {label}'` (e.g.,
 *                  `'reliability-post-decide: cost-cap-exceeded'`).
 *   • `cause`    — the originating error from the LLM call, when one
 *                  drove the fail-fast decision (e.g., the underlying
 *                  HTTP error that tripped a circuit breaker).
 *   • `snapshot` — the full `executor.getSnapshot()` at fail-fast time
 *                  for forensics. Consumers persist this for postmortem
 *                  analysis (commitLog, narrative, scope state, etc.).
 *
 * Three-channel discipline: `kind`/`payload` came from scope state,
 * `reason` came from $break, `snapshot` is the engine's own audit trail.
 * Emit events flowed independently to any attached observability adapter
 * (this error is the RUNTIME signal; emit is the OBSERVABILITY signal).
 */
export class ReliabilityFailFastError extends Error {
    code = 'ERR_RELIABILITY_FAIL_FAST';
    kind;
    reason;
    cause;
    snapshot;
    payload;
    constructor(opts) {
        super(`[reliability] ${opts.kind}: ${opts.reason}`);
        this.name = 'ReliabilityFailFastError';
        this.kind = opts.kind;
        this.reason = opts.reason;
        if (opts.cause !== undefined)
            this.cause = opts.cause;
        if (opts.snapshot !== undefined)
            this.snapshot = opts.snapshot;
        if (opts.payload !== undefined)
            this.payload = opts.payload;
    }
}
//# sourceMappingURL=types.js.map