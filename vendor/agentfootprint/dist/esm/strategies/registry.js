/**
 * Strategy registry — name → factory for each of the 4 groups.
 *
 * Mirrors `src/cache/strategyRegistry.ts` exactly: maps a string name
 * to a factory function that takes vendor-specific config and returns
 * a typed strategy instance. Vendor adapter subpaths self-register on
 * import via side-effect.
 *
 * Two ways consumers wire a strategy:
 *
 *   1. By NAME (registry lookup) — the recommended path for vendor
 *      adapters:
 *        ```ts
 *        import 'agentfootprint/observability-datadog';  // self-registers 'datadog'
 *        agent.enable.observability({ vendor: 'datadog', config: { apiKey } });
 *        ```
 *
 *   2. By INSTANCE (explicit pass) — for custom in-house strategies
 *      or test mocks:
 *        ```ts
 *        agent.enable.observability({ strategy: myCustomStrategy });
 *        ```
 *
 * The two paths are mutually exclusive in `EnableOptions` — the type
 * union enforces that consumers pick one.
 *
 * Lookup is exact-match by name (case-insensitive fallback). Unknown
 * names return `undefined`; the consumer's `enable.X` then no-ops
 * (per "do nothing if not configured" rule).
 */
// ─── 4 registries (one per group) ────────────────────────────────────
const OBSERVABILITY_REGISTRY = new Map();
const COST_REGISTRY = new Map();
const LIVE_STATUS_REGISTRY = new Map();
const LENS_REGISTRY = new Map();
// ─── Register / lookup / list — observability ────────────────────────
/**
 * Register a vendor observability strategy by name. Called from the
 * vendor's subpath at module load (side-effect import):
 *
 *   ```ts
 *   // agentfootprint/observability-datadog/index.ts
 *   import { registerObservabilityStrategy } from 'agentfootprint/strategies';
 *   registerObservabilityStrategy('datadog', (config) => datadogObservability(config));
 *   ```
 *
 * Replacing an existing registration is allowed — most-recent wins.
 * Useful for test mocks.
 */
export function registerObservabilityStrategy(name, factory) {
    OBSERVABILITY_REGISTRY.set(name, factory);
}
/** Look up an observability factory by vendor name. Case-insensitive
 *  fallback. Returns `undefined` when the name is unknown — caller
 *  decides to noop or throw. */
export function getObservabilityStrategy(name) {
    return OBSERVABILITY_REGISTRY.get(name) ?? OBSERVABILITY_REGISTRY.get(name.toLowerCase());
}
/** Diagnostic — list all registered vendor names. */
export function listObservabilityStrategies() {
    return [...OBSERVABILITY_REGISTRY.keys()];
}
// ─── Cost ────────────────────────────────────────────────────────────
export function registerCostStrategy(name, factory) {
    COST_REGISTRY.set(name, factory);
}
export function getCostStrategy(name) {
    return COST_REGISTRY.get(name) ?? COST_REGISTRY.get(name.toLowerCase());
}
export function listCostStrategies() {
    return [...COST_REGISTRY.keys()];
}
// ─── Live status ─────────────────────────────────────────────────────
export function registerLiveStatusStrategy(name, factory) {
    LIVE_STATUS_REGISTRY.set(name, factory);
}
export function getLiveStatusStrategy(name) {
    return LIVE_STATUS_REGISTRY.get(name) ?? LIVE_STATUS_REGISTRY.get(name.toLowerCase());
}
export function listLiveStatusStrategies() {
    return [...LIVE_STATUS_REGISTRY.keys()];
}
// ─── Lens ────────────────────────────────────────────────────────────
export function registerLensStrategy(name, factory) {
    LENS_REGISTRY.set(name, factory);
}
export function getLensStrategy(name) {
    return LENS_REGISTRY.get(name) ?? LENS_REGISTRY.get(name.toLowerCase());
}
export function listLensStrategies() {
    return [...LENS_REGISTRY.keys()];
}
// ─── Test helpers ────────────────────────────────────────────────────
/** Reset every registry to empty. Tests only — not in the public
 *  barrel. */
export function _resetRegistriesForTests() {
    OBSERVABILITY_REGISTRY.clear();
    COST_REGISTRY.clear();
    LIVE_STATUS_REGISTRY.clear();
    LENS_REGISTRY.clear();
}
//# sourceMappingURL=registry.js.map