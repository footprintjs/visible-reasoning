import { DEFAULT_INFLUENCE_WEIGHTS, DEFAULT_PERSISTENCE_THRESHOLD } from './types.js';
import { adaptWeights, assertUniqueIds, assertValidWeights, compositeScore, structuralProximity, } from './signals.js';
/** Small, conservative stop list — fillers that would only add noise to
 *  the overlap. Copied verbatim from the injection-engine's `EntryScorer`
 *  (influence-core is a leaf — it restates rather than imports). */
const STOP_WORDS = new Set([
    'a',
    'an',
    'the',
    'and',
    'or',
    'but',
    'if',
    'to',
    'of',
    'for',
    'in',
    'on',
    'at',
    'by',
    'with',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'it',
    'this',
    'that',
    'these',
    'those',
    'i',
    'you',
    'we',
    'my',
    'our',
    'me',
    'please',
    'can',
    'could',
    'would',
    'should',
    'do',
    'does',
    'how',
    'what',
    'need',
    'want',
]);
/**
 * Lowercase → split on non-alphanumerics → drop 1-char tokens + stop words →
 * light plural fold → set. The plural fold (drop a single trailing `s` on
 * tokens length ≥ 4, but never `-ss`) lets `refund` match `refunds` while
 * `address` stays `address`. ASCII-only by construction (the regex splits
 * away non-Latin/accented text — use `'semantic-alignment'` for other
 * languages).
 */
function tokenize(text) {
    const out = new Set();
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 2 || STOP_WORDS.has(raw))
            continue;
        const fold = raw.length >= 4 && raw.endsWith('s') && !raw.endsWith('ss');
        out.add(fold ? raw.slice(0, -1) : raw);
    }
    return out;
}
/** |A ∩ B| / sqrt(|A| · |B|) — set cosine, range [0, 1]. Empty either side → 0.
 *  Iterates the smaller set (same kernel as EntryScorer's `setCosine`). */
function overlap(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    for (const t of small)
        if (large.has(t))
            shared += 1;
    return shared / Math.sqrt(a.size * b.size);
}
/**
 * Score every evidence item on the four FDL signals — the LEXICAL kernel
 * (set-cosine over word tokens instead of embedding cosine) — and rank by
 * composite, descending. Ties keep input order (stable sort).
 *
 * Deterministic: same inputs → byte-identical output, every run, every
 * machine. Zero dependencies, zero network, sync-fast (async only to satisfy
 * the `InfluenceScorer` seam). Never touches `args.embedder` or `args.signal`.
 *
 * Honest claim: ranked WORD-OVERLAP proxies — cheaper and blinder than the
 * embedding scorer (paraphrase = miss). NOT causal attribution — see module
 * docs.
 *
 * @throws on duplicate evidence ids or invalid weights.
 */
export async function scoreLexicalInfluence(args) {
    const weights = args.weights ?? DEFAULT_INFLUENCE_WEIGHTS;
    assertValidWeights(weights, 'scoreLexicalInfluence');
    const threshold = args.persistenceThreshold ?? DEFAULT_PERSISTENCE_THRESHOLD;
    assertUniqueIds(args.evidence, 'scoreLexicalInfluence');
    // One deduplicated tokenization pass over every distinct text.
    const tokensByText = new Map();
    const tokensOf = (text) => {
        let set = tokensByText.get(text);
        if (set === undefined) {
            set = tokenize(text);
            tokensByText.set(text, set);
        }
        return set;
    };
    const answerTokens = tokensOf(args.finalAnswerText);
    const scored = args.evidence.map((item) => {
        const evidenceTokens = tokensOf(item.text);
        const ancestorTokens = item.ancestorTexts.map((t) => tokensOf(t));
        const n = ancestorTokens.length;
        let avgSum = 0;
        let above = 0;
        for (const ancestor of ancestorTokens) {
            const sim = overlap(evidenceTokens, ancestor);
            avgSum += sim;
            if (sim > threshold)
                above += 1;
        }
        const signals = {
            fa: overlap(evidenceTokens, answerTokens),
            avg: n === 0 ? 0 : avgSum / n,
            persist: n === 0 ? 0 : above / n,
            depth: structuralProximity(n),
        };
        const effective = adaptWeights(weights, n);
        return {
            id: item.id,
            signals,
            weights: effective.weights,
            adapted: effective.adapted,
            score: compositeScore(signals, effective.weights),
        };
    });
    // Stable sort — equal scores keep evidence input order.
    return scored.sort((a, b) => b.score - a.score);
}
//# sourceMappingURL=lexical.js.map