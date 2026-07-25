/**
 * restoration — RFC-003 Part B: the causal tier for the missing-context finder
 * (interface #3), the MIRROR of ablation (D8's restoration half).
 *
 * Ablation confirms a PRESENT culprit by removing it and watching the outcome
 * flip. Restoration confirms an ABSENT culprit (a unit `findDroppedContext`
 * surfaced) by adding it BACK and watching the outcome flip. Same seeded-rerun
 * discipline, same verdict rule (`verdictFor(..., 'restoring')`), same honest
 * baseline check — only the intervention is inverted.
 *
 * The re-run is consumer-owned (the library doesn't own your agent loop), just
 * like `AblationRunner`. `RestorationRunner` receives the units to add back
 * (`[]` = the un-restored baseline) plus a seed, and returns the run's output.
 */
import { cosineSimilarity } from '../../memory/embedding/cosine.js';
import { defaultOutcomeComparator, resolveSamples, similarityStats } from './ablation.js';
import { CONTEXT_BISECT_DEFAULTS } from './types.js';
/**
 * Run ONE restoration probe: call the consumer's runner with `units` restored
 * once per seed, measure each output's similarity to the original, count flips.
 * `[]` units = the un-restored baseline. Mirror of `runAblationProbe`.
 */
export async function runRestorationProbe(config, units) {
    const samples = resolveSamples(config.rerun.samples);
    const flipThreshold = config.rerun.flipThreshold ?? CONTEXT_BISECT_DEFAULTS.flipThreshold;
    const outcomeChanged = config.rerun.outcomeChanged ?? defaultOutcomeComparator(config.embedder, flipThreshold);
    const similarities = [];
    let flips = 0;
    const originalVec = await config.embedder.embed({ text: config.rerun.originalOutput });
    for (let seed = 0; seed < samples; seed++) {
        const output = await config.rerun.runner(units, { seed });
        const outputVec = await config.embedder.embed({ text: output });
        similarities.push(cosineSimilarity(originalVec, outputVec));
        if (await outcomeChanged(config.rerun.originalOutput, output))
            flips++;
    }
    return { samples, flips, similarity: similarityStats(similarities) };
}
//# sourceMappingURL=restoration.js.map