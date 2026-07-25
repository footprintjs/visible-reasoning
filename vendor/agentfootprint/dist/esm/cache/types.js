/**
 * Cache layer — public types.
 *
 * Three layers, each with one responsibility:
 *
 *   1. CONSUMER DSL — `CachePolicy` field on every injection factory.
 *      Declarative, like GraphQL schema input. Says WHAT should be
 *      cacheable. Examples: `cache: 'always'`, `cache: 'while-active'`.
 *
 *   2. AGNOSTIC MARKERS — `CacheMarker[]` produced by the
 *      `CacheDecision` subflow at runtime. Provider-independent
 *      identification of "cacheable prefix in field X up to index Y".
 *
 *   3. PROVIDER STRATEGY — one `CacheStrategy` implementation per
 *      provider (Anthropic / OpenAI / Bedrock / NoOp). Translates
 *      agnostic markers to provider-specific wire format AND extracts
 *      cache metrics from the provider's response.
 *
 * The interfaces are read-only / immutable by convention. Strategies
 * MUST be stateless across runs; per-run state lives in the
 * `CacheStrategyContext` passed into `prepareRequest`.
 */
export {};
//# sourceMappingURL=types.js.map