/**
 * context-bisect types — RFC-003 Part B: the contextual-bug localizer
 * ("git bisect for context").
 *
 * Pattern: assembly contract. Part B is pure ASSEMBLY over shipped pieces:
 *          footprintjs 9.8.0's complete causal DAG (control edges, honesty
 *          markers, `EdgeWeigher` hook) × influence-core scoring (D6) ×
 *          consumer-run counterfactual ablation. No new engine features,
 *          no new typed events.
 * Role:    `src/lib/context-bisect/` leaf. Exported via
 *          `agentfootprint/observe`.
 *
 * ## The two-tier honest-claims discipline (RFC-003 §B2)
 *
 * Every number in these types belongs to exactly ONE of two tiers, and the
 * docs say which:
 *
 *   - **CORRELATIONAL** — edge weights, suspect scores, rankings. These are
 *     deterministic embedding-geometry PROXIES (influence-core composite:
 *     semantic alignment between what a source wrote and what the LLM step
 *     produced). They mean "high semantic alignment", never "the model
 *     answered BECAUSE of this". A report without reruns stops here and is
 *     marked `mode: 'correlational'`.
 *
 *   - **CAUSAL** — ablation verdicts ONLY. A suspect earns `verdict:
 *     'confirmed'` exclusively by counterfactual evidence: the consumer's
 *     `AblationRunner` re-ran the scenario WITHOUT the suspect N seeded
 *     times and the outcome flipped (with baseline stability checked and
 *     variance reported — never a single-run verdict).
 *
 * Slice completeness is bounded by tracking — and SAYS so: untracked reads
 * (`$getArgs()` / env / silent reads), missing control-dependence lookups,
 * missing read tracking, and depth/node truncation all surface as
 * `honestyFlags` on the report, mirrored from footprintjs's own A2/A4
 * markers.
 */
// ─── Defaults ────────────────────────────────────────────────────────
export const CONTEXT_BISECT_DEFAULTS = {
    /** Slice depth budget (forwarded to `causalChain`). */
    maxDepth: 12,
    /** Slice node budget (forwarded to `causalChain`). */
    maxNodes: 80,
    /** Ranked suspects kept on the report. */
    maxSuspects: 12,
    /** Chars of written content embedded per step text (D7). */
    maxTextChars: 2000,
    /** Seeded reruns per ablation probe (D9 — never single-run verdicts). */
    samples: 3,
    /** Default similarity floor for the default outcome comparator. */
    flipThreshold: 0.8,
    /** Ablation probes budget for `bisectCulprits`. */
    maxProbes: 24,
    /** Independent-culprit search rounds for `bisectCulprits`. */
    maxCulprits: 4,
};
//# sourceMappingURL=types.js.map