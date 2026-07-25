/**
 * Default query extractor — last user message.
 *
 * Inside the memory-read subflow (mounted by `mountMemoryRead`), the
 * current turn's messages are piped in as `scope.messages` via the
 * mount's inputMapper. Falls back to `newMessages` for custom pipelines
 * that wire differently.
 */
function defaultQueryFrom(scope) {
    const scopeAny = scope;
    const incoming = scopeAny.messages ?? [];
    const source = incoming.length > 0 ? incoming : (scope.newMessages ?? []);
    for (let i = source.length - 1; i >= 0; i--) {
        const m = source[i];
        if (m.role !== 'user')
            continue;
        if (m.content)
            return m.content;
    }
    return '';
}
export function loadRelevant(config) {
    const { store, embedder } = config;
    if (!store.search) {
        throw new Error('loadRelevant: the configured store does not implement search(). ' +
            'Use a vector-capable adapter (InMemoryStore, pgvector, Pinecone, ...).');
    }
    const queryFrom = config.queryFrom ?? defaultQueryFrom;
    const k = config.k ?? 20;
    return async (scope) => {
        const identity = scope.identity;
        const text = queryFrom(scope).trim();
        if (text.length === 0) {
            scope.loaded = [];
            return;
        }
        const signal = scope.$getEnv?.()?.signal;
        const queryVec = (await embedder.embed({
            text,
            ...(signal ? { signal } : {}),
        }));
        // store.search optional on MemoryStore but required when an embedder
        // is configured (validated upstream by defineMemory).
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const results = await store.search(identity, queryVec, {
            k,
            ...(config.minScore !== undefined && { minScore: config.minScore }),
            ...(config.tiers && { tiers: config.tiers }),
            ...(config.embedderId !== undefined && { embedderId: config.embedderId }),
        });
        // Write loaded entries to scope in best-first order — downstream
        // pickByBudget further narrows by the token budget.
        scope.loaded = results.map((r) => r.entry);
    };
}
//# sourceMappingURL=loadRelevant.js.map