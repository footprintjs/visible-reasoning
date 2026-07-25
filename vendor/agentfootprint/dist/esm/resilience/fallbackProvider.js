/**
 * fallbackProvider — convenience for chained fallbacks across N providers.
 *
 * Pattern: Chain of Responsibility (GoF) over `LLMProvider` instances.
 * Role:    Outer ring (Hexagonal). Sugar over repeated `withFallback`.
 *
 * `fallbackProvider(p1, p2, p3)` is equivalent to
 * `withFallback(p1, withFallback(p2, p3))` — tries each provider in
 * order, advancing on errors that match the (optional) shouldFallback
 * predicate. The first success wins; if all fail, the last error throws.
 *
 * @example
 *   import { anthropic, openai, mock } from 'agentfootprint/llm-providers';
 *   import { fallbackProvider } from 'agentfootprint/resilience';
 *
 *   const provider = fallbackProvider(
 *     anthropic({ apiKey: A }),
 *     openai({ apiKey: O }),
 *     mock({ reply: '[degraded] all upstream providers failed' }),
 *   );
 */
import { withFallback } from './withFallback.js';
export function fallbackProvider(first, ...rest) {
    // Distinguish overload: an options object has no `name` of type "function".
    // LLMProvider has `complete: function`; options doesn't.
    const hasComplete = (x) => typeof x === 'object' && x !== null && typeof x.complete === 'function';
    let providers;
    let options = {};
    if (hasComplete(first)) {
        providers = [first, ...rest];
    }
    else {
        providers = rest;
        options = first;
    }
    // Length is checked first so the array accesses below are guaranteed
    // non-undefined; explicit guards satisfy TypeScript without `!`.
    if (providers.length === 0) {
        throw new Error('fallbackProvider() requires at least one provider');
    }
    const head = providers[0];
    const tail = providers[providers.length - 1];
    if (!head || !tail) {
        throw new Error('fallbackProvider() unreachable: array access after length guard');
    }
    if (providers.length === 1) {
        return head;
    }
    // Right-fold: withFallback(p0, withFallback(p1, withFallback(p2, p3)))
    let chained = tail;
    for (let i = providers.length - 2; i >= 0; i--) {
        const cur = providers[i];
        if (!cur)
            continue; // unreachable; guarded by loop bounds
        chained = withFallback(cur, chained, options);
    }
    // Optionally override the auto-generated name.
    if (options.name) {
        return { ...chained, name: options.name };
    }
    return chained;
}
//# sourceMappingURL=fallbackProvider.js.map