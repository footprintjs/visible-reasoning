/**
 * adapters/types — the Ports of the hexagonal architecture.
 *
 * Pattern: Adapter (GoF, Design Patterns ch. 4) + Ports-and-Adapters
 *          (Cockburn, 2005).
 * Role:    Contracts for every external dependency the library reaches for:
 *          LLM providers, memory stores, context sources, embeddings,
 *          guardrails, policy engines, pricing tables.
 * Emits:   N/A (interfaces only).
 *
 * Concrete adapters (AnthropicProvider, PineconeStore, LlamaGuardDetector,
 * ...) implement these contracts. `core/` and `core-flow/` depend only on
 * these interfaces — never on concrete adapters.
 */
export {};
//# sourceMappingURL=types.js.map