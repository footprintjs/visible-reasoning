import { scoreInfluence } from './signals.js';
import { scoreLexicalInfluence } from './lexical.js';
/** The DEFAULT: the FDL four-signal embedding composite (`scoreInfluence`). */
export const semanticAlignmentStrategy = Object.freeze({
    name: 'semantic-alignment',
    description: 'Ranks sources by how semantically close their content is to the final answer, using ' +
        'embeddings (the four-signal composite). The default. Needs an embedder; scores are a ' +
        'proxy for alignment, never proof of cause.',
    requirements: Object.freeze(['embedder']),
    scorer: scoreInfluence,
});
/** The cheap option: deterministic word overlap (`scoreLexicalInfluence`), zero deps. */
export const lexicalOverlapStrategy = Object.freeze({
    name: 'lexical-overlap',
    description: 'Ranks sources by plain word overlap with the final answer. Deterministic, free, no ' +
        'dependencies — the simpler, cheaper option. Misses paraphrases; same proxy caveat: ' +
        'overlap is not cause.',
    requirements: Object.freeze([]),
    scorer: scoreLexicalInfluence,
});
const BUILT_IN = Object.freeze([semanticAlignmentStrategy, lexicalOverlapStrategy]);
/**
 * The built-in strategies, default first. Frozen — a host UI renders its
 * selector straight off this (concat your own custom strategies after).
 */
export function listInfluenceStrategies() {
    return BUILT_IN;
}
//# sourceMappingURL=strategies.js.map