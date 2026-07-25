/**
 * contrastive — influence scoring against a REFERENCE output (RFC-003).
 *
 * Pattern: a SEPARATE, opt-in second stage over the four-signal scorer — not a
 *          modification of `scoreInfluence`. Same `InfluenceScore[]` return, so
 *          `rankingConfidence` and the rest compose on it unchanged.
 * Role:    `src/lib/influence-core/` leaf, sibling to `scoreInfluence`.
 *
 * ## Why this exists (the topical-innocent confound)
 *
 * Plain output-similarity (`scoreInfluence`'s FA) ranks a source by how much it
 * resembles the actual answer. That is confounded by **topically-central
 * innocents**: the policy a refund decision is *about* resembles ANY refund
 * output — right or wrong — so it can out-rank the source that actually caused
 * the wrong one. The fix: score by CONTRAST against a reference output (a
 * known-good / expected / prior-good run). A topical innocent is similar to
 * BOTH outputs, so it cancels (~0 contrast); the real culprit is similar to the
 * WRONG output specifically, so it stands out.
 *
 *   contrastive FA(e) = sim(e, answer) − sim(e, reference)
 *
 * Everything else (the AVG / PERSIST / DEPTH reasoning-trace signals, the
 * composite, adaptive weights) is shared with `scoreInfluence` verbatim — only
 * the FA term is contrastive.
 *
 * Honest claim (RFC-002 §2): still an embedding-geometry PROXY, never causal —
 * the contrast removes a confound, it does not prove causation. Ablation is the
 * causal tier. And it is OPT-IN: it needs a reference output, so it is for
 * regression / eval debugging (you have a prior-good or expected output), not
 * cold localization — without a reference, use `scoreInfluence`.
 */
import { cosineSimilarity } from '../../memory/embedding/cosine.js';
import { adaptWeights, assertValidWeights, averageRelevancy, compositeScore, embedAll, persistence, structuralProximity, } from './signals.js';
import { DEFAULT_INFLUENCE_WEIGHTS, DEFAULT_PERSISTENCE_THRESHOLD } from './types.js';
/**
 * Score evidence by CONTRASTIVE influence: `sim(e, answer) − sim(e, reference)`
 * for the FA term, the four-signal composite otherwise. Returns `InfluenceScore[]`
 * sorted descending — drop-in compatible with `scoreInfluence` consumers
 * (`rankingConfidence`, etc.).
 *
 * @throws when an evidence id is duplicated (same contract as `scoreInfluence`).
 */
export async function scoreContrastiveInfluence(args) {
    const weights = args.weights ?? DEFAULT_INFLUENCE_WEIGHTS;
    const threshold = args.persistenceThreshold ?? DEFAULT_PERSISTENCE_THRESHOLD;
    assertUniqueIds(args.evidence);
    assertValidWeights(weights, 'scoreContrastiveInfluence');
    // ONE deduplicated embedding pass over every distinct text (answer + reference
    // + evidence + ancestors).
    const texts = new Set([args.answerText, args.referenceText]);
    for (const item of args.evidence) {
        texts.add(item.text);
        for (const ancestor of item.ancestorTexts)
            texts.add(ancestor);
    }
    const vectorByText = await embedAll(args.embedder, [...texts], args.signal);
    const answerVec = vectorByText.get(args.answerText);
    const referenceVec = vectorByText.get(args.referenceText);
    const scored = args.evidence.map((item) => {
        const evidenceVec = vectorByText.get(item.text);
        const ancestorVecs = item.ancestorTexts.map((t) => vectorByText.get(t));
        // The only contrastive term: answer-similarity MINUS reference-similarity.
        const faContrast = cosineSimilarity(evidenceVec, answerVec) - cosineSimilarity(evidenceVec, referenceVec);
        const signals = {
            fa: faContrast,
            avg: averageRelevancy(evidenceVec, ancestorVecs),
            persist: persistence(evidenceVec, ancestorVecs, threshold),
            depth: structuralProximity(ancestorVecs.length),
        };
        const effective = adaptWeights(weights, ancestorVecs.length);
        return {
            id: item.id,
            signals,
            weights: effective.weights,
            adapted: effective.adapted,
            score: compositeScore(signals, effective.weights),
        };
    });
    return scored.sort((a, b) => b.score - a.score);
}
function assertUniqueIds(evidence) {
    const seen = new Set();
    for (const e of evidence) {
        if (seen.has(e.id))
            throw new Error(`scoreContrastiveInfluence: duplicate evidence id "${e.id}"`);
        seen.add(e.id);
    }
}
//# sourceMappingURL=contrastive.js.map