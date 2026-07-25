/**
 * Embedder — text-to-vector abstraction.
 *
 * Pluggable interface: consumers bring their own embedding backend
 * (OpenAI, Voyage, Cohere, Sentence Transformers, a local model, a
 * custom rules-based hashing scheme, etc.). The library ships
 * `mockEmbedder()` for tests — no default real embedder, since LLM
 * providers' embedding APIs are not uniform (Anthropic doesn't
 * publish one at all).
 *
 * An embedder is configured once (model + api key + dims) and reused
 * across many turns. `dimensions` is a constant per instance — mixing
 * embedders of different dims within the same `MemoryStore` breaks
 * cosine similarity, so adapters should reject mismatched sizes.
 */
export {};
//# sourceMappingURL=types.js.map