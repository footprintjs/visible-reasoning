/**
 * semanticPipeline — vector-retrieval memory preset.
 *
 * Instead of loading the N most-recent messages, this preset embeds
 * the user's current turn and pulls the k most semantically similar
 * prior messages from a vector-capable store.
 *
 *   READ  :  LoadRelevant → PickByBudget → FormatDefault
 *   WRITE :  EmbedMessages → WriteMessages
 *
 * Contrast with `defaultPipeline` (recency) and `narrativePipeline`
 * (beat-level compression). Semantic retrieval is the right tool when:
 *   - Conversations are long enough that recency misses relevant
 *     context from many turns ago.
 *   - The user asks questions that reference topics from distant
 *     history ("what did I say about X last week?").
 *   - You have a real vector store (pgvector / Pinecone / Qdrant) —
 *     `InMemoryStore`'s O(n) scan is only useful for dev / tests.
 *
 * You MUST supply an `Embedder`. No default. The library ships
 * `mockEmbedder()` for tests — bring your own for production
 * (OpenAI, Voyage, Cohere, Sentence Transformers, custom).
 *
 * Most consumers reach for `semanticPipeline` indirectly through
 * `defineMemory({ type: MEMORY_TYPES.SEMANTIC, strategy: { kind:
 * MEMORY_STRATEGIES.TOP_K, topK, threshold, embedder }, store })`.
 *
 * @example Direct usage (low-level — custom flowchart composition):
 * ```ts
 * import { semanticPipeline, mockEmbedder, InMemoryStore } from 'agentfootprint/memory';
 *
 * const pipeline = semanticPipeline({
 *   store: new InMemoryStore(),
 *   embedder: mockEmbedder(),  // swap for openaiEmbedder() etc. in production
 * });
 * ```
 */
import { flowChart } from 'footprintjs';
import { pickByBudget } from '../stages/pickByBudget.js';
import { formatDefault } from '../stages/formatDefault.js';
import { writeMessages } from '../stages/writeMessages.js';
import { loadRelevant } from '../embedding/loadRelevant.js';
import { embedMessages, } from '../embedding/embedMessages.js';
/**
 * Build the semantic read + write pipelines sharing a single store.
 * Returns `{ read, write }` ready to pass to `Agent.memory()` via the appropriate `defineMemory` config (or used directly via `mountMemoryRead`/`mountMemoryWrite`).
 */
export function semanticPipeline(config) {
    if (!config.store.search) {
        throw new Error('semanticPipeline: the configured store does not implement search(). ' +
            'Pass a vector-capable adapter (InMemoryStore, pgvector, Pinecone, ...).');
    }
    const loadConfig = {
        store: config.store,
        embedder: config.embedder,
        ...(config.embedderId !== undefined && { embedderId: config.embedderId }),
        ...(config.k !== undefined && { k: config.k }),
        ...(config.minScore !== undefined && { minScore: config.minScore }),
        ...(config.tiers && { tiers: config.tiers }),
    };
    const pickConfig = {
        ...(config.reserveTokens !== undefined && { reserveTokens: config.reserveTokens }),
        ...(config.minimumTokens !== undefined && { minimumTokens: config.minimumTokens }),
        ...(config.maxEntries !== undefined && { maxEntries: config.maxEntries }),
    };
    const formatConfig = {
        ...(config.formatHeader !== undefined && { header: config.formatHeader }),
        ...(config.formatFooter !== undefined && { footer: config.formatFooter }),
    };
    const embedConfig = {
        embedder: config.embedder,
        ...(config.embedderId !== undefined && { embedderId: config.embedderId }),
    };
    const writeConfig = {
        store: config.store,
        ...(config.writeTier && { tier: config.writeTier }),
        ...(config.writeTtlMs !== undefined && { ttlMs: config.writeTtlMs }),
    };
    // ── Read subflow: LoadRelevant → PickByBudget → FormatDefault
    let readBuilder = flowChart('LoadRelevant', loadRelevant(loadConfig), 'load-relevant', { description: 'Embed the query + fetch top-k semantically similar entries' });
    readBuilder = pickByBudget(pickConfig)(readBuilder);
    const read = readBuilder
        .addFunction('Format', formatDefault(formatConfig), 'format-default', 'Render selected entries as a system message')
        .build();
    // ── Write subflow: EmbedMessages → WriteMessages
    const write = flowChart('EmbedMessages', embedMessages(embedConfig), 'embed-messages', { description: 'Embed newMessages into per-message vectors for vector search' })
        .addFunction('WriteMessages', writeMessages(writeConfig), 'write-messages', 'Batch-persist messages with embeddings via store.putMany')
        .build();
    return { read, write };
}
//# sourceMappingURL=semantic.js.map