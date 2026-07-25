import { isFactId } from './types.js';
const DEFAULT_LIMIT = 100;
export function loadFacts(config) {
    const limit = config.limit ?? DEFAULT_LIMIT;
    return async (scope) => {
        const { entries } = await config.store.list(scope.identity, {
            limit,
            ...(config.tiers && { tiers: config.tiers }),
        });
        // Filter by fact-id prefix. `list` may return mixed payloads
        // (messages + beats + facts) if the store is shared. Prefix filter
        // keeps only the fact-shaped entries.
        const facts = [];
        for (const entry of entries) {
            if (isFactId(entry.id))
                facts.push(entry);
        }
        const existing = scope.loadedFacts ?? [];
        scope.loadedFacts = [...existing, ...facts];
    };
}
//# sourceMappingURL=loadFacts.js.map