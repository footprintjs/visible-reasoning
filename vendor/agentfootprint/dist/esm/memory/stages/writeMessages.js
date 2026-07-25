const defaultIdFrom = (turn, index) => `msg-${turn}-${index}`;
export function writeMessages(config) {
    const idFrom = config.idFrom ?? defaultIdFrom;
    return async (scope) => {
        const identity = scope.identity;
        const turn = scope.turnNumber;
        const messages = scope.newMessages ?? [];
        if (messages.length === 0)
            return;
        // Optional: embedMessages may have run earlier and written
        // per-message vectors to scope. Attach them to the entries so
        // vector-capable stores index on `embedding`.
        const embeddings = scope.newMessageEmbeddings;
        const embeddingModel = scope.newMessageEmbeddingModel;
        const now = Date.now();
        const ttl = config.ttlMs ? now + config.ttlMs : undefined;
        // Build all entries first, then batch-write. For N messages this
        // turns N sequential store round-trips into 1 (real backends:
        // Redis pipeline, DynamoDB BatchWriteItem, Postgres multi-row
        // INSERT). InMemoryStore resolves the slot once.
        const entries = [];
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const embedding = embeddings?.[i];
            entries.push({
                id: idFrom(turn, i, message),
                value: message,
                version: 1,
                createdAt: now,
                updatedAt: now,
                lastAccessedAt: now,
                accessCount: 0,
                ...(ttl !== undefined && { ttl }),
                ...(config.tier && { tier: config.tier }),
                ...(embedding && embedding.length > 0 && { embedding: [...embedding] }),
                ...(embeddingModel && { embeddingModel }),
                source: { turn, identity },
            });
        }
        await config.store.putMany(identity, entries);
        // Signatures still written individually — the recognition set is
        // an orthogonal index that adapters rarely batch (signatures get
        // hashed into a set, not a k-v store).
        if (config.signatureFrom) {
            for (const message of messages) {
                await config.store.recordSignature(identity, config.signatureFrom(message));
            }
        }
    };
}
//# sourceMappingURL=writeMessages.js.map