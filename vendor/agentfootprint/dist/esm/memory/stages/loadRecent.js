const DEFAULT_COUNT = 20;
/**
 * Build a stage function that loads recent entries into `scope.loaded`.
 *
 * The returned stage is async and side-effect-free on failure: if the
 * store throws, the stage re-throws (fail-loud) — callers wrap with
 * `withRetry` / `withFallback` if they want degrade-to-empty behavior.
 */
export function loadRecent(config) {
    const count = config.count ?? DEFAULT_COUNT;
    return async (scope) => {
        const identity = scope.identity;
        const { entries } = await config.store.list(identity, {
            limit: count,
            ...(config.tiers && { tiers: config.tiers }),
        });
        // Store returns most-recently-updated first (see InMemoryStore.list).
        // Chat consumers want oldest-first for natural reading order, so
        // reverse before append. Allocates one array; acceptable for N ≤ a few
        // hundred (the only realistic scale for "recent messages").
        const chronological = [...entries].reverse();
        // Append rather than replace — lets multiple load stages compose.
        const existing = scope.loaded ?? [];
        scope.loaded = [...existing, ...chronological];
    };
}
//# sourceMappingURL=loadRecent.js.map