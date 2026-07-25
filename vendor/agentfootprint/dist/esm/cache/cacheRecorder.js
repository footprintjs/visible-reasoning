/**
 * cacheRecorder() — observability for the v2.6 cache layer.
 *
 * Subscribes to:
 *   - `FlowRecorder.onDecision` — captures CacheGate routing decisions
 *     (apply-markers / no-markers + the rule that fired + evidence
 *     from `decide()`). Read directly from `event.evidence.rules[matched]`
 *     since footprintjs already auto-captures predicate `inputs[]`.
 *   - `agentfootprint.stream.llm_end` events — read provider's `usage`
 *     and call the agent's CacheStrategy.extractMetrics() to normalize
 *     into CacheMetrics (cacheReadTokens / cacheWriteTokens / fresh).
 *
 * Produces:
 *   - per-iteration `agentfootprint.cache.applied` events (markers
 *     applied this iter or empty if skipped) — for Lens trace
 *   - per-iteration `agentfootprint.cache.metrics` events (hit/write
 *     token counts + estimated dollars via PricingTable) — for
 *     dashboards
 *   - a turn-end summary printable via `recorder.report()` —
 *     numeric tally plus dollars saved
 *
 * v2.6 LIMITATION: doesn't yet write `scope.recentHitRate` back into
 * agent state. CacheGate's hit-rate-floor rule won't fire automatically;
 * consumers can manually wire feedback via `Agent.create(...).attach(rec)`.
 * Full feedback loop deferred to v2.7 (needs an agent-side accessor
 * convention since recorders don't normally write to scope).
 */
import { splitStageId } from 'footprintjs/trace';
import { STAGE_IDS } from '../conventions.js';
export function cacheRecorder(options = {}) {
    const perIter = [];
    let lastDecision;
    let iterationCounter = 0;
    function dollars(tokens, kind) {
        if (!options.pricing)
            return 0;
        const model = options.model ?? 'unknown';
        return tokens * options.pricing.pricePerToken(model, kind);
    }
    const handle = {
        id: 'cache-recorder',
        onDecision(event) {
            // Only care about CacheGate decisions, matched by the decider's LOCAL
            // stage id. Both `event.decider` (the node NAME) and the prefixed
            // `traversalContext.stageId` become `sf-cache/…` now that CacheGate is
            // nested in sf-cache, so we strip the subflow path with splitStageId and
            // compare the local id. This is id-stable (survives a display-name
            // rename) and nesting-safe (works top-level or inside sf-cache).
            // (The old `event.decider !== 'cache-gate'` was a no-op: event.decider is
            // the NAME 'CacheGate', never the id 'cache-gate'.)
            const stageId = event.traversalContext?.stageId;
            if (!stageId || splitStageId(stageId).localStageId !== STAGE_IDS.CACHE_GATE)
                return;
            const matched = event.evidence?.rules.find((r) => r.matched);
            lastDecision = {
                branch: event.chosen,
                ...(matched?.label !== undefined && { rule: matched.label }),
            };
        },
        onEmit(event) {
            if (event.type !== 'agentfootprint.stream.llm_end')
                return;
            iterationCounter++;
            const usage = event.payload.usage;
            const metrics = options.strategy?.extractMetrics(usage);
            const branch = lastDecision?.branch ?? 'apply-markers';
            // Compute dollar math:
            //   spent = freshInput * inputPrice
            //         + cacheRead * cacheReadPrice
            //         + cacheWrite * cacheWritePrice
            //   no-cache cost = (freshInput + cacheRead + cacheWrite) * inputPrice
            //   saved        = no-cache cost - spent
            let dollarsSpent = 0;
            let savedVsNoCache = 0;
            if (metrics) {
                dollarsSpent =
                    dollars(metrics.freshInputTokens, 'input') +
                        dollars(metrics.cacheReadTokens, 'cacheRead') +
                        dollars(metrics.cacheWriteTokens, 'cacheWrite');
                const noCacheCost = dollars(metrics.freshInputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens, 'input');
                savedVsNoCache = noCacheCost - dollarsSpent;
            }
            const entry = {
                iteration: iterationCounter,
                branch,
                ...(lastDecision?.rule !== undefined && { rule: lastDecision.rule }),
                ...(metrics !== undefined && { metrics }),
                dollarsSpent,
                dollarsSavedVsNoCache: savedVsNoCache,
            };
            perIter.push(entry);
            lastDecision = undefined;
        },
        report() {
            const apply = perIter.filter((p) => p.branch === 'apply-markers').length;
            const skip = perIter.filter((p) => p.branch === 'no-markers').length;
            const cacheRead = perIter.reduce((s, p) => s + (p.metrics?.cacheReadTokens ?? 0), 0);
            const cacheWrite = perIter.reduce((s, p) => s + (p.metrics?.cacheWriteTokens ?? 0), 0);
            const fresh = perIter.reduce((s, p) => s + (p.metrics?.freshInputTokens ?? 0), 0);
            const totalRequest = cacheRead + cacheWrite + fresh;
            const hitRate = totalRequest > 0 ? cacheRead / totalRequest : 0;
            const dollarsSpent = perIter.reduce((s, p) => s + p.dollarsSpent, 0);
            const dollarsSaved = perIter.reduce((s, p) => s + p.dollarsSavedVsNoCache, 0);
            return Object.freeze({
                totalIterations: perIter.length,
                applyMarkersIterations: apply,
                noMarkersIterations: skip,
                cacheReadTokensTotal: cacheRead,
                cacheWriteTokensTotal: cacheWrite,
                freshInputTokensTotal: fresh,
                hitRate,
                estimatedDollarsSpent: dollarsSpent,
                estimatedDollarsSavedVsNoCache: dollarsSaved,
                perIter: Object.freeze([...perIter]),
            });
        },
        reset() {
            perIter.length = 0;
            lastDecision = undefined;
            iterationCounter = 0;
        },
    };
    return handle;
}
//# sourceMappingURL=cacheRecorder.js.map