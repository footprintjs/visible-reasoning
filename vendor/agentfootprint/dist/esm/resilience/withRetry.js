/**
 * withRetry — provider decorator that retries failed calls.
 *
 * Pattern: Decorator (GoF) — wraps an `LLMProvider` and adds retry
 *          policy without changing its interface.
 * Role:    Outer ring (Hexagonal). Composable: `withRetry(withFallback(...))`.
 *
 * Retries `complete()` on transient failures with exponential backoff.
 * `stream()` is delegated as-is — once tokens start flowing the
 * pipeline is stateful and cannot safely be restarted. If you need
 * retry semantics for streaming, fall back to `complete()` or
 * implement custom resumability at the consumer.
 *
 * Default policy:
 *   • maxAttempts: 3 (initial + 2 retries)
 *   • backoff:     exponential — 200ms, 400ms, 800ms
 *   • shouldRetry: rejects 4xx-class errors (client mistakes don't
 *                  benefit from retry) and AbortError; retries 5xx,
 *                  network errors, and unknown shapes.
 */
/**
 * Wrap a provider so its `complete()` retries transient failures.
 *
 * @example
 *   import { withRetry } from 'agentfootprint/resilience';
 *   import { anthropic } from 'agentfootprint/llm-providers';
 *
 *   const robust = withRetry(anthropic({ apiKey }), {
 *     maxAttempts: 5,
 *     onRetry: (err, attempt, ms) => console.warn(`retry ${attempt} in ${ms}ms`, err),
 *   });
 */
export function withRetry(provider, options = {}) {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const initialDelayMs = options.initialDelayMs ?? 200;
    const backoffFactor = options.backoffFactor ?? 2;
    const maxDelayMs = options.maxDelayMs ?? 10_000;
    const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
    const onRetry = options.onRetry;
    const wrapped = {
        name: `${provider.name}+retry`,
        async complete(req) {
            let lastError;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    return await provider.complete(req);
                }
                catch (err) {
                    lastError = err;
                    if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
                        throw err;
                    }
                    const delay = Math.min(maxDelayMs, initialDelayMs * Math.pow(backoffFactor, attempt - 1));
                    onRetry?.(err, attempt + 1, delay);
                    await sleep(delay, req.signal);
                }
            }
            // Unreachable — last attempt either returned or threw above.
            throw lastError;
        },
    };
    // Pass-through `stream()` if the underlying provider supports it.
    // No retry on streams (mid-stream resumption is provider-specific).
    if (provider.stream) {
        // Guarded by `if (provider.stream)` above; assertion safe.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        wrapped.stream = (req) => provider.stream(req);
    }
    return wrapped;
}
// ── Defaults ────────────────────────────────────────────────────────
/**
 * Skip retry for AbortError + 4xx-class errors. Retry on everything
 * else (network errors, 5xx, unknown shapes). Provider adapters that
 * surface HTTP status should set `error.status` for this to work; the
 * predicate falls back to retrying when status is unknown (better to
 * retry once than to surface a flaky failure).
 *
 * Exported (module-level, NOT on the resilience barrel) as the single
 * source of truth for the decorators' transience policy — shared by
 * `withCredentialRetry` (identity) so "what counts as transient" never
 * drifts between the LLM and credential retry wrappers.
 */
export function defaultShouldRetry(err, _attempt) {
    if (isAbortError(err))
        return false;
    const status = err?.status ??
        err?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
        // 429 Too Many Requests is the one 4xx that benefits from retry.
        return status === 429;
    }
    return true;
}
function isAbortError(err) {
    if (!err || typeof err !== 'object')
        return false;
    const e = err;
    return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}
function sleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('Aborted'));
            return;
        }
        const id = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(id);
            reject(signal?.reason ?? new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
//# sourceMappingURL=withRetry.js.map