/**
 * withFallback — provider decorator that falls back to a secondary
 * on error.
 *
 * Pattern: Decorator (GoF) — composes two `LLMProvider`s into one.
 * Role:    Outer ring (Hexagonal). Stacks with `withRetry`:
 *          `withRetry(withFallback(primary, fallback))` first retries
 *          the primary, then on exhaustion falls back to the secondary.
 *
 * Common pairings:
 *   • Anthropic primary, OpenAI fallback (vendor outage tolerance)
 *   • Real provider primary, Mock fallback (degrade gracefully in dev)
 *   • Premium model primary, cheaper model fallback (cost ceiling)
 *
 * `stream()` falls back too — if the primary's stream errors before
 * yielding any chunks, we restart on the fallback. Once the primary
 * has yielded chunks the stream is committed — fallback would
 * duplicate the partial output.
 */
/**
 * Wrap a primary provider with a fallback. Tries primary first; on
 * error matching the policy, calls the fallback.
 *
 * @example
 *   const provider = withFallback(
 *     anthropic({ apiKey: A }),
 *     openai({ apiKey: O }),
 *     { onFallback: (err) => console.warn('primary failed, falling back:', err) },
 *   );
 */
export function withFallback(primary, fallback, options = {}) {
    const shouldFallback = options.shouldFallback ?? defaultShouldFallback;
    const onFallback = options.onFallback;
    const wrapped = {
        name: `${primary.name}|${fallback.name}`,
        async complete(req) {
            try {
                return await primary.complete(req);
            }
            catch (err) {
                if (!shouldFallback(err))
                    throw err;
                onFallback?.(err);
                return fallback.complete(req);
            }
        },
    };
    // Stream fallback — only if the primary stream fails before any
    // chunk yields. Once a chunk is consumed downstream, restarting
    // would replay tokens. Yields from primary as long as it's working;
    // catches errors in the iteration setup or first chunk only.
    if (primary.stream || fallback.stream) {
        wrapped.stream = async function* fallbackStream(req) {
            // No primary stream support → fallback's stream (or its complete-only).
            if (!primary.stream) {
                if (fallback.stream)
                    yield* fallback.stream(req);
                else
                    yield* completeAsStream(fallback, req);
                return;
            }
            let yieldedAny = false;
            try {
                for await (const chunk of primary.stream(req)) {
                    yieldedAny = true;
                    yield chunk;
                }
            }
            catch (err) {
                if (yieldedAny || !shouldFallback(err))
                    throw err;
                onFallback?.(err);
                if (fallback.stream)
                    yield* fallback.stream(req);
                else
                    yield* completeAsStream(fallback, req);
            }
        };
    }
    return wrapped;
}
// ── Defaults ────────────────────────────────────────────────────────
function defaultShouldFallback(err) {
    if (!err || typeof err !== 'object')
        return true;
    const e = err;
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR')
        return false;
    return true;
}
/**
 * Synthesize a stream from a non-streaming provider's `complete()`
 * call: one terminal chunk carrying the whole response. Lets the
 * fallback chain still satisfy a `stream()` request even when the
 * fallback only implements `complete()`.
 */
async function* completeAsStream(provider, req) {
    const response = await provider.complete(req);
    yield {
        tokenIndex: 0,
        content: '',
        done: true,
        response,
    };
}
//# sourceMappingURL=withFallback.js.map