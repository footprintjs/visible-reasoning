import { decide } from 'footprintjs';
import { approximateTokenCounter, countMessageTokens } from './tokenize.js';
const DEFAULT_RESERVE = 256;
const DEFAULT_MINIMUM = 100;
/**
 * Build the decider function. Returns the full `DecisionResult` so
 * DeciderHandler recognizes the DECISION_RESULT brand and attaches
 * evidence to `FlowRecorder.onDecision`. Predicates read from `scope`
 * (not closed-over locals) so the temp recorder captures the values
 * that drove the choice.
 */
function buildPickDecider(config) {
    const reserveTokens = config.reserveTokens ?? DEFAULT_RESERVE;
    const minimumTokens = config.minimumTokens ?? DEFAULT_MINIMUM;
    return (scope) => decide(scope, [
        {
            when: (s) => (s.loaded ?? []).length === 0,
            then: 'skip-empty',
            label: 'no entries loaded — nothing to pick',
        },
        {
            when: (s) => (s.contextTokensRemaining ?? 0) - reserveTokens < minimumTokens,
            then: 'skip-no-budget',
            label: 'budget below minimum threshold — skip injection',
        },
    ], 'pick');
}
/** Both skip branches share the same body — no entries survive. */
const skipStage = (scope) => {
    scope.selected = [];
};
/** The `pick` branch: greedy newest-first selection within budget. */
function buildPickStage(config) {
    const reserveTokens = config.reserveTokens ?? DEFAULT_RESERVE;
    const countTokens = config.countTokens ?? approximateTokenCounter;
    const maxEntries = config.maxEntries;
    return (scope) => {
        const loaded = scope.loaded ?? [];
        const budget = (scope.contextTokensRemaining ?? 0) - reserveTokens;
        // Sort newest-first. Secondary key on `id` guarantees deterministic
        // ordering when entries share `updatedAt` (batch writes, low-resolution
        // clocks) — without it, ties resolve to implementation-defined order
        // which breaks trace replay and A/B eval comparisons.
        const byNewest = [...loaded].sort((a, b) => {
            const byTime = b.updatedAt - a.updatedAt;
            if (byTime !== 0)
                return byTime;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const picked = [];
        let used = 0;
        for (const entry of byNewest) {
            if (maxEntries !== undefined && picked.length >= maxEntries)
                break;
            const cost = countMessageTokens(entry.value, countTokens);
            if (used + cost > budget)
                continue; // skip this entry, try smaller ones
            picked.push(entry);
            used += cost;
        }
        // Emit in chronological order — `picked` is newest-first; reverse.
        scope.selected = picked.reverse();
    };
}
/**
 * Append the pick-by-budget decider + branches to `builder`. Returns
 * the builder so calls chain naturally:
 *
 * ```ts
 * let b = flowChart<MemoryState>('LoadRecent', loadRecent(config), 'load-recent');
 * b = pickByBudget(pickConfig)(b);
 * b = b.addFunction('Format', formatDefault(formatConfig), 'format-default');
 * ```
 *
 * Generic in `T` so consumers whose scope extends `MemoryState` (e.g.,
 * an AgentLoopState that embeds memory fields) can compose this into
 * their own pipeline without casting.
 */
export function pickByBudget(config = {}) {
    const decider = buildPickDecider(config);
    const pickStage = buildPickStage(config);
    return (builder) => {
        return builder
            .addDeciderFunction('PickDecider', decider, 'pick-decider', 'Decide whether to pick entries, skip (empty), or skip (no budget)')
            .addFunctionBranch('skip-empty', 'SkipEmpty', skipStage, 'Mark selected as [] — no entries loaded')
            .addFunctionBranch('skip-no-budget', 'SkipNoBudget', skipStage, 'Mark selected as [] — budget below minimum')
            .addFunctionBranch('pick', 'Pick', pickStage, 'Greedy newest-first selection within token budget')
            .end();
    };
}
//# sourceMappingURL=pickByBudget.js.map