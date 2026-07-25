/**
 * influence-core types — the ONE embedding-based scoring contract.
 *
 * Pattern: Strategy seam (plug-and-play meta-pattern) — the frame and
 *          rule engine are the library's; the `Embedder` is consumer-
 *          injected, exactly like NarrativeFormatter / reliability /
 *          permission / commentary strategies.
 * Role:    `src/lib/` leaf module. Shared by the FDL paper pipeline
 *          (Visible Reasoning, Eq. 1–6), RFC-002's tool-catalog lint +
 *          margin recorder (C1/C4/C5), and RFC-003 Part B's LLM-edge
 *          weigher (D7). Extracted as RFC-003 block D6 so all three
 *          consumers share one scoring engine and one embedding cache.
 *
 * ## Honest claim (RFC-002 §2, the FDL discipline)
 *
 * Every score produced under these types is a PROXY computed from
 * embedding geometry — cosine similarity over consumer-injected
 * embeddings. None of it reads model internals. Scores mean "high
 * semantic alignment", never "the model chose/answered BECAUSE".
 * Scores are not additive across items and are not causal attribution
 * — counterfactual ablation (RFC-003 stage 4) is where causal claims
 * live.
 */
/** Paper defaults: α=0.40, β=0.30, γ=0.20, δ=0.10 (sum to 1.0). */
export const DEFAULT_INFLUENCE_WEIGHTS = Object.freeze({
    fa: 0.4,
    avg: 0.3,
    persist: 0.2,
    depth: 0.1,
});
/** Paper default for the PERSIST threshold T (Eq. 3). */
export const DEFAULT_PERSISTENCE_THRESHOLD = 0.3;
/** RFC-002 §4 default: margins below this flag the choice as `narrow`. */
export const DEFAULT_MARGIN_THRESHOLD = 0.05;
/**
 * RFC-003 default: an influence ranking whose top-1 vs top-2 score margin is
 * below this has NO clear winner — a shortlist, not a verdict. Escalate to
 * ablation.
 *
 * UNCALIBRATED proxy starting point, chosen for interpretability. `margin`
 * is an ABSOLUTE difference on the same scale as `scoreInfluence`'s composite
 * (S ∈ ≈[−0.7, 1]), so this threshold is EMBEDDER-RELATIVE — recalibrate by
 * sweeping clear-winner vs flat rankings on your embedder. The numeric
 * coincidence with `DEFAULT_MARGIN_THRESHOLD` is NOT a shared derivation: that
 * one measures `scoreMargin`'s chosen-vs-not-chosen distribution, a different
 * statistic.
 */
export const DEFAULT_CLEAR_WINNER_MARGIN = 0.05;
/**
 * RFC-003 default: when there is no clear winner, suspects scoring within this
 * band of the top form the shortlist ablation should COVER (the culprit may be
 * any of them — or, for absence bugs, none). UNCALIBRATED proxy; embedder-
 * relative (see `DEFAULT_CLEAR_WINNER_MARGIN`).
 */
export const DEFAULT_SHORTLIST_BAND = 0.1;
/**
 * RFC-003 default for `ratioStrategy`: the top-2 gap as a FRACTION of the top
 * score `(s0 − s1) / |s0|`. Unlike the absolute margin this is scale-invariant,
 * so it transfers across embedders / answer lengths. UNCALIBRATED proxy.
 */
export const DEFAULT_CLEAR_WINNER_RATIO = 0.05;
//# sourceMappingURL=types.js.map