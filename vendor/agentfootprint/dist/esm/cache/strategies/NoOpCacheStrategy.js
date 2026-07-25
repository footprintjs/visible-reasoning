/**
 * NoOpCacheStrategy — fallback strategy for providers without cache
 * support (Mock, unknown providers, intentional opt-out).
 *
 * Returns the request unchanged; reports no metrics. The
 * `capabilities.enabled` flag is `false` so the CacheDecision subflow
 * could choose to skip emitting markers entirely (potential v2.7
 * optimization), though current Phase 4+5 always emit markers and
 * let the strategy decide what to do with them.
 *
 * Always-available default. Registered against the special wildcard
 * `'*'` so any unrecognized provider name falls back to NoOp.
 */
const NOOP_CAPABILITIES = Object.freeze({
    enabled: false,
    maxMarkers: 0,
    ttls: [],
    fields: [],
    automatic: false,
});
export class NoOpCacheStrategy {
    /**
     * Wildcard provider name. The strategy registry treats this as the
     * fallback for any provider that doesn't have a specific strategy
     * registered.
     */
    providerName = '*';
    capabilities = NOOP_CAPABILITIES;
    async prepareRequest(req, _candidates, _ctx) {
        return { request: req, markersApplied: [] };
    }
    extractMetrics(_usage) {
        return undefined;
    }
}
//# sourceMappingURL=NoOpCacheStrategy.js.map