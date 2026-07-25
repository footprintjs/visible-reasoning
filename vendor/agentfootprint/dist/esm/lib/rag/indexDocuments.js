/**
 * indexDocuments — seed a vector-capable MemoryStore with documents.
 *
 * Embeds each document, builds a `MemoryEntry<{content, metadata?}>`,
 * batches into `store.putMany()`. Used at application startup to
 * populate a RAG store before the first agent run.
 *
 * Pattern: Bulk-write helper. Not a flowchart stage — it runs once
 *          at boot, not per-iteration.
 * Role:    Layer-3 RAG pipeline starter. Pairs with `defineRAG()`
 *          which only does the read side.
 * Emits:   N/A — startup-time batch write, not part of the agent run.
 *
 * @example
 * ```ts
 * import { Agent, indexDocuments, defineRAG } from 'agentfootprint'
import { InMemoryStore, mockEmbedder } from 'agentfootprint/memory';
 *
 * const store = new InMemoryStore();
 * const embedder = mockEmbedder();
 *
 * await indexDocuments(store, embedder, [
 *   { id: 'doc1', content: 'Refunds processed within 3 business days.' },
 *   { id: 'doc2', content: 'Pro plan: $20/mo, includes priority support.', metadata: { tier: 'pro' } },
 *   { id: 'doc3', content: 'Free plan: limited to 100 calls/month.' },
 * ]);
 *
 * const docs = defineRAG({ id: 'product-docs', store, embedder });
 * const agent = Agent.create({ provider }).rag(docs).build();
 * ```
 */
const DEFAULT_IDENTITY = { conversationId: '_global' };
/**
 * Embed + persist documents. Returns the count actually indexed
 * (skips duplicates if the store rejects them). Throws on embedder
 * failure or store error — fail loud at startup is desirable.
 *
 * **Re-indexing semantics:** entries are written with `version: 1` and
 * `putMany` (most adapters: last-write-wins). Re-running this helper
 * after the store has been mutated by other writers may stomp their
 * versions. For idempotent corpus refresh, either delete-then-index
 * or use a custom upsert via `store.putIfVersion()` per document. A
 * first-class `mode: 'upsert' | 'replace'` API is planned for a
 * future release.
 */
export async function indexDocuments(store, embedder, documents, options = {}) {
    if (!store)
        throw new Error('indexDocuments: `store` is required.');
    if (!embedder)
        throw new Error('indexDocuments: `embedder` is required.');
    if (!Array.isArray(documents) || documents.length === 0)
        return 0;
    const identity = options.identity ?? DEFAULT_IDENTITY;
    const embedderId = options.embedderId ?? 'default-embedder';
    const now = Date.now();
    const ttl = options.ttlMs ? now + options.ttlMs : undefined;
    // Embed in batch when supported, else fall back to capped-concurrency
    // single calls. Unlimited concurrency on a large corpus would
    // saturate embedder rate limits; cap defaults to 8.
    const texts = documents.map((d) => d.content);
    let vectors;
    if (embedder.embedBatch) {
        vectors = await embedder.embedBatch({
            texts,
            ...(options.signal && { signal: options.signal }),
        });
    }
    else {
        const limit = Math.max(1, options.maxConcurrency ?? 8);
        vectors = await embedWithConcurrency(embedder, texts, limit, options.signal);
    }
    const entries = documents.map((doc, i) => {
        const vec = vectors[i];
        return {
            id: doc.id,
            value: doc,
            version: 1,
            createdAt: now,
            updatedAt: now,
            lastAccessedAt: now,
            accessCount: 0,
            ...(vec && vec.length > 0 && { embedding: [...vec] }),
            embeddingModel: embedderId,
            ...(ttl !== undefined && { ttl }),
            ...(options.tier && { tier: options.tier }),
            source: { turn: 0, identity },
        };
    });
    await store.putMany(identity, entries);
    return entries.length;
}
async function embedWithConcurrency(embedder, texts, limit, signal) {
    const results = new Array(texts.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, texts.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= texts.length)
                return;
            // i bounded by texts.length above; texts[i] is defined.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const text = texts[i];
            results[i] = await embedder.embed({
                text,
                ...(signal && { signal }),
            });
        }
    });
    await Promise.all(workers);
    return results;
}
//# sourceMappingURL=indexDocuments.js.map