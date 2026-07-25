/**
 * CacheGate — runtime decider that gates cache-marker application.
 *
 * Runs every iteration AFTER the CacheDecision subflow produces
 * `scope.cacheMarkers` and BEFORE the BuildLLMRequest stage applies
 * them. Three rules can fall through to "no-markers" (skip caching);
 * default branch is "apply-markers" (proceed with caching).
 *
 * Why a decider stage and not a function: footprintjs's `decide()`
 * captures evidence on `FlowRecorder.onDecision` natively. The
 * `cacheRecorder()` (Phase 9) reads
 * `event.evidence.rules.find(r => r.matched).inputs[]` to surface
 * WHY caching was applied or skipped each iter. Same channel
 * footprintjs uses for every other decision; same renderer in Lens.
 *
 * Three rules (evaluated top-down; first match wins):
 *   1. Kill switch — `Agent.create({ caching: 'off' })` was set
 *   2. Hit-rate floor — recent hit rate < 30%; cache writes outpacing
 *      reads, auto-disable to avoid the cache-write penalty
 *   3. Skill churn — active skills changing too rapidly for caching
 *      to amortize (Anthropic LLM expert's concern from Phase 4 review)
 *
 * Default branch (no rule matches): `'apply-markers'`.
 */
import { decide } from 'footprintjs';
/**
 * Hit-rate floor below which we auto-disable caching. The 30% number
 * is calibrated for Anthropic's pricing: cache write costs +25%
 * premium, cache read costs 90% off. Break-even at ~25% hit rate.
 * 30% gives a buffer; below that we're losing money on writes that
 * never recoup.
 *
 * Reasoning: if hit rate is X, cost-per-token vs no caching is
 *   (1 - X) * 1.0 + X * 0.1                                    // baseline
 *   minus
 *   write_iters * 1.25 + read_iters * 0.1                       // with caching
 * Solving for break-even gives X ≈ 0.25 for typical agent shapes.
 */
export const HIT_RATE_FLOOR = 0.3;
/**
 * Window size for skill-churn detection. Last 5 iterations of
 * active skill IDs are inspected.
 */
export const SKILL_CHURN_WINDOW = 5;
/**
 * Threshold above which skill churn is considered detected: this many
 * UNIQUE skills in the rolling window. With window=5 and threshold=3,
 * the pattern A → B → A → C still triggers (3 unique skills in 4 iters).
 */
export const SKILL_CHURN_THRESHOLD = 3;
/**
 * Pure helper: detect skill churn given a rolling history.
 * Exported for direct testing without decider/scope ceremony.
 */
export function detectSkillChurn(history, windowSize = SKILL_CHURN_WINDOW, threshold = SKILL_CHURN_THRESHOLD) {
    if (history.length < threshold)
        return false; // not enough history yet
    const recent = history.slice(-windowSize);
    const uniqueSkills = new Set();
    for (const s of recent) {
        if (s !== undefined)
            uniqueSkills.add(s);
    }
    return uniqueSkills.size >= threshold;
}
/**
 * The decider function. Mounted via `addDeciderFunction` in the
 * agent's main chart in Phase 6.
 *
 * Returns a `DecisionResult` (footprintjs's `decide()` helper output)
 * which the engine unwraps via `.branch` for routing AND publishes
 * `evidence.rules[matched].inputs[]` to FlowRecorder.onDecision.
 * cacheRecorder (Phase 9) subscribes to that channel for the audit trail.
 *
 * For non-routing consumers (testing the decision in isolation), read
 * the `.branch` field of the returned DecisionResult.
 */
export function cacheGateDecide(scope) {
    return decide(scope, [
        {
            when: (s) => s.cachingDisabled === true,
            then: 'no-markers',
            label: "kill switch active (Agent.create({ caching: 'off' }))",
        },
        {
            when: (s) => s.recentHitRate !== undefined && s.recentHitRate < HIT_RATE_FLOOR,
            then: 'no-markers',
            label: `hit rate < ${HIT_RATE_FLOOR * 100}% — auto-disable`,
        },
        {
            when: (s) => detectSkillChurn(s.skillHistory),
            then: 'no-markers',
            label: `skill churn (≥${SKILL_CHURN_THRESHOLD} unique skills in last ${SKILL_CHURN_WINDOW} iters)`,
        },
    ], 'apply-markers');
}
/**
 * Update the skill-history rolling window. Called as a function
 * stage BEFORE the CacheGate decider. Reads the current iteration's
 * active skill (the MOST-RECENTLY activated one — the TAIL of
 * `activatedInjectionIds`) and appends it to the `skillHistory` array.
 *
 * WHY THE TAIL, NOT THE HEAD: `read_skill` APPENDS each newly-activated
 * skill to the end of `activatedInjectionIds`, and the list is cumulative
 * + deduped per turn (reset only at seed). So the HEAD is frozen at the
 * FIRST skill activated and never changes mid-turn — sampling it made the
 * window record one constant value, so `detectSkillChurn` could never fire
 * (the skill-churn cache rule was effectively dead). The tail tracks what
 * the agent just switched to, which is the churn signal we actually want.
 *
 * KNOWN LIMITATION: if several skills are activated in the SAME iteration,
 * only the last (tail) is recorded for that iteration — churn can
 * under-count a multi-skill burst. A fully order-independent signal would
 * read `activatedInjectionIds.length` directly in the gate; that is a
 * larger change deferred for now.
 *
 * Window length is bounded at `SKILL_CHURN_WINDOW * 2` so the array
 * doesn't grow unboundedly across long agent runs. Old entries
 * fall off the front naturally.
 */
export function updateSkillHistory(scope) {
    const ids = scope.activatedInjectionIds ?? [];
    const current = ids.length > 0 ? ids[ids.length - 1] : undefined;
    const prior = scope.skillHistory ?? [];
    const next = [...prior, current];
    // Bounded buffer — keep window*2 to give detectSkillChurn room
    // without pinning every prior iteration in memory.
    const trimmed = next.length > SKILL_CHURN_WINDOW * 2 ? next.slice(-SKILL_CHURN_WINDOW * 2) : next;
    scope.skillHistory = trimmed;
}
//# sourceMappingURL=CacheGateDecider.js.map