import { factId } from './types.js';
export function extractFacts(config) {
    const { extractor } = config;
    return async (scope) => {
        const messages = (scope.newMessages ?? []);
        const turnNumber = scope.turnNumber ?? 1;
        const identity = scope.identity;
        if (messages.length === 0) {
            scope.newFacts = [];
            return;
        }
        const env = scope.$getEnv?.();
        const signal = env?.signal;
        // Pass existing facts (if loaded) to the extractor so LLM-based
        // extractors can update/refine rather than duplicate.
        const existing = (scope.loadedFacts ?? []).map((e) => e.value);
        const facts = await extractor.extract({
            messages,
            turnNumber,
            ...(existing.length > 0 ? { existing } : {}),
            ...(signal ? { signal } : {}),
        });
        if (facts.length === 0) {
            scope.newFacts = [];
            return;
        }
        const now = Date.now();
        const ttl = config.ttlMs !== undefined ? now + config.ttlMs : undefined;
        const entries = facts.map((fact) => ({
            id: factId(fact.key),
            value: fact,
            version: 1,
            createdAt: now,
            updatedAt: now,
            lastAccessedAt: now,
            accessCount: 0,
            ...(ttl !== undefined && { ttl }),
            ...(config.tier && { tier: config.tier }),
            source: {
                turn: turnNumber,
                identity,
            },
        }));
        scope.newFacts = entries;
    };
}
//# sourceMappingURL=extractFacts.js.map