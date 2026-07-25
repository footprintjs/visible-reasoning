/**
 * patterns/ — factory functions that compose primitives + core-flow
 * into well-known agent patterns from the research literature.
 *
 * Each pattern is:
 *   - A factory function returning a `Runner` — drops into any
 *     `Sequence.step()`, `Parallel.branch()`, etc.
 *   - Purely composed — no new primitives, no state machinery beyond
 *     what the underlying compositions provide.
 *   - Documented with the canonical paper reference.
 *
 * Build-time-fixed cardinality: all patterns take a FIXED
 * shard/branch/agent count at build time. Run-time-variable branching
 * is a separate (not-yet-shipped) feature and would need a
 * `DynamicParallel` primitive.
 */
export { selfConsistency } from './SelfConsistency.js';
export { reflection } from './Reflection.js';
export { debate } from './Debate.js';
export { mapReduce } from './MapReduce.js';
export { tot } from './ToT.js';
export { swarm } from './Swarm.js';
//# sourceMappingURL=index.js.map