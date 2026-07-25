/**
 * defineRAG — sugar factory for retrieval-augmented generation.
 *
 * RAG is a context-engineering flavor: embed the user's question,
 * retrieve top-K semantically similar chunks from a vector store,
 * inject those chunks into the messages slot of the next LLM call.
 * It's the same plumbing as `defineMemory({ type: SEMANTIC,
 * strategy: TOP_K })` — the rename is for intent + ergonomics.
 *
 *   defineMemory ─┬─► EPISODIC   (raw conversation)
 *                 ├─► SEMANTIC   (extracted facts / RAG chunks)
 *                 ├─► NARRATIVE  (beats / summaries)
 *                 └─► CAUSAL     (footprintjs decision snapshots)
 *
 *   defineRAG    ─►  SEMANTIC + TOP_K with RAG-specific defaults
 *                    (asRole='user', threshold=0.7, no LLM-extract)
 *
 * Pattern: Composition over duplication — defineRAG returns a
 *          MemoryDefinition produced by defineMemory. No new engine
 *          code, no new slot subflow, no new event type.
 *
 * Role:    Layer-3 context-engineering primitive. Lives next to
 *          defineSkill / defineSteering / defineInstruction / defineFact
 *          but resolves to a memory subflow rather than an Injection
 *          (RAG content is computed at runtime via async retrieval —
 *          can't fit the synchronous Injection.inject shape).
 *
 * Emits:   Indirectly — the underlying memory pipeline emits
 *          `agentfootprint.context.injected` when retrieved chunks
 *          land in the messages slot.
 *
 * @see ./indexDocuments.ts  for the seeding helper
 * @see ../../memory/define.ts  for the underlying factory
 *
 * @example  Basic usage
 * ```ts
 * import { *   Agent, defineRAG, indexDocuments, * } from 'agentfootprint'
import { InMemoryStore, mockEmbedder } from 'agentfootprint/memory'
import { mock } from 'agentfootprint/llm-providers';
 *
 * const embedder = mockEmbedder();
 * const store = new InMemoryStore();
 *
 * // Seed the store once at startup
 * await indexDocuments(store, embedder, [
 *   { id: 'doc1', content: 'Refunds are processed within 3 business days.' },
 *   { id: 'doc2', content: 'Pro plan costs $20/month.' },
 * ]);
 *
 * const docs = defineRAG({
 *   id: 'product-docs',
 *   description: 'Retrieve product documentation chunks',
 *   store,
 *   embedder,
 *   topK: 3,
 *   threshold: 0.6,
 * });
 *
 * const agent = Agent.create({ provider: mock({ reply: 'ok' }), model: 'mock' })
 *   .rag(docs)
 *   .build();
 * ```
 */
import { MEMORY_TYPES, MEMORY_STRATEGIES } from '../../memory/define.types.js';
import { defineMemory } from '../../memory/define.js';
/**
 * Build a RAG context-engineering definition. The returned
 * `MemoryDefinition` is registered on the Agent via `.rag(definition)`
 * (or, equivalently, `.memory(definition)` — same plumbing).
 *
 * @throws when `store` does not implement `search()`. RAG requires a
 *         vector-capable adapter.
 */
export function defineRAG(opts) {
    if (!opts.id || opts.id.trim() === '') {
        throw new Error('defineRAG: `id` is required and must be non-empty.');
    }
    if (!opts.store) {
        throw new Error(`defineRAG[${opts.id}]: \`store\` is required.`);
    }
    if (!opts.embedder) {
        throw new Error(`defineRAG[${opts.id}]: \`embedder\` is required.`);
    }
    if (!opts.store.search) {
        throw new Error(`defineRAG[${opts.id}]: store must implement search(). ` +
            'Pass a vector-capable adapter (InMemoryStore, pgvector, Pinecone, ...).');
    }
    return defineMemory({
        id: opts.id,
        ...(opts.description !== undefined && { description: opts.description }),
        type: MEMORY_TYPES.SEMANTIC,
        strategy: {
            kind: MEMORY_STRATEGIES.TOP_K,
            topK: opts.topK ?? 3,
            threshold: opts.threshold ?? 0.7,
            embedder: opts.embedder,
        },
        store: opts.store,
        asRole: opts.asRole ?? 'user',
    });
}
//# sourceMappingURL=defineRAG.js.map