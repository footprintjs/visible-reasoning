const defaultIdFrom = (turn, index) => `beat-${turn}-${index}`;
/**
 * Build the `extractBeats` stage function.
 *
 * ```ts
 * let b = flowChart<ExtractBeatsState>('Seed', seed, 'seed');
 * b = b.addFunction('ExtractBeats', extractBeats({ extractor }), 'extract-beats');
 * b = b.addFunction('WriteBeats', writeBeats({ store }), 'write-beats');
 * ```
 */
export function extractBeats(config) {
    const { extractor } = config;
    const idFrom = config.idFrom ?? defaultIdFrom;
    return async (scope) => {
        const messages = (scope.newMessages ?? []);
        const turnNumber = scope.turnNumber ?? 1;
        const identity = scope.identity;
        if (messages.length === 0) {
            scope.newBeats = [];
            return;
        }
        const env = scope.$getEnv?.();
        const signal = env?.signal;
        const beats = await extractor.extract({
            messages,
            turnNumber,
            ...(signal ? { signal } : {}),
        });
        if (beats.length === 0) {
            scope.newBeats = [];
            return;
        }
        const now = Date.now();
        const ttl = config.ttlMs !== undefined ? now + config.ttlMs : undefined;
        const entries = beats.map((beat, index) => ({
            id: idFrom(turnNumber, index, beat),
            value: beat,
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
        scope.newBeats = entries;
    };
}
//# sourceMappingURL=extractBeats.js.map