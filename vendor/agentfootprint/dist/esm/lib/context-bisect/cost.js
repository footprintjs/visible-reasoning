/** Minimum loops saved (over the placebo band) to call a piece a cost cause. */
export const MIN_LOOPS_SAVED = 1;
function effectOf(suspect, baseline) {
    const c = suspect.runs?.cost;
    if (c === undefined)
        return undefined;
    const baseLoops = baseline.cost?.loops?.median;
    const baseTokens = baseline.cost?.tokens?.median;
    const loopsSaved = baseLoops !== undefined && c.loops !== undefined ? baseLoops - c.loops.median : 0;
    const tokensSaved = baseTokens !== undefined && c.tokens !== undefined ? baseTokens - c.tokens.median : 0;
    const consistent = baseLoops !== undefined && c.loops !== undefined ? c.loops.max <= baseLoops : false;
    return { loopsSaved, tokensSaved, consistent };
}
/**
 * Attach a `CostVerdict` to each suspect from the ablation reruns + a
 * leave-one-out placebo control. Suspects without cost data are returned
 * unchanged (quality-only). See the module honesty note.
 */
export function assignCostVerdicts(suspects, baseline) {
    // The placebo population: non-flipping suspects (removal didn't change the
    // answer) with cost data. Their loops-saved is benign path variance.
    const nonFlip = suspects
        .filter((s) => s.verdict?.verdict !== 'confirmed')
        .map((s) => ({ id: s.source, e: effectOf(s, baseline) }))
        .filter((x) => x.e !== undefined);
    return suspects.map((suspect) => {
        const e = effectOf(suspect, baseline);
        if (e === undefined)
            return suspect; // no cost data → unchanged
        // Leave-one-out placebo: exclude the suspect itself from its own band.
        const band = nonFlip.filter((x) => x.id !== suspect.source).map((x) => x.e.loopsSaved);
        const placeboExists = band.length > 0;
        const placeboMax = placeboExists ? Math.max(...band) : 0;
        const stable = placeboExists && e.consistent;
        const reducedCostOnRemoval = stable && e.loopsSaved >= MIN_LOOPS_SAVED && e.loopsSaved > placeboMax;
        const cost = {
            reducedCostOnRemoval,
            loopsSaved: e.loopsSaved,
            tokensSaved: e.tokensSaved,
            stable,
        };
        return { ...suspect, cost };
    });
}
/**
 * Derive the 2×2 class from the flip verdict (quality) and the cost verdict.
 * The no-bug cell is `'no-detected-effect'` — never "innocent" (a piece can
 * matter in ways neither axis sees: overdetermination, same-loops-different-path).
 */
export function classifySuspect(suspect) {
    const flips = suspect.verdict?.verdict === 'confirmed';
    const costCause = suspect.cost?.reducedCostOnRemoval === true && suspect.cost.stable;
    if (flips && costCause)
        return 'both';
    if (flips)
        return 'content-bug';
    if (costCause)
        return 'cost-cause';
    return 'no-detected-effect';
}
//# sourceMappingURL=cost.js.map