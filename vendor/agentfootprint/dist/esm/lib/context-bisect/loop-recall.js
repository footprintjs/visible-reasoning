import { scoreInfluence } from '../influence-core/index.js';
import { defaultSuspectClassifier, } from './localize.js';
/**
 * Default recency decay for the per-loop aggregation. A loop N's per-suspect score is weighted by
 * `recencyDecay^(lastLoop − N)` — recent loops weigh more. H2 swept `{0.5, 0.7, 0.9, 1.0}`; the
 * recall@k gate (running THIS shipped scorer) confirmed `0.5` and `0.7` reproduce top-3 10/10 vs
 * plain 9/10, while `≥0.9` does not — so the validated band is `[0.5, 0.7]` and the default is the
 * lowest measured winner, `0.5`. (We do NOT ship an unmeasured value.) `1` = uniform; `0` = last-loop-only.
 */
export const DEFAULT_RECENCY_DECAY = 0.5;
/** Build a ClassifyContext from a loop frame's contextSources (the localizer's view, per loop). */
function classifyContextFor(frame) {
    const byKey = new Map(frame.contextSources.map((s) => [s.key, s.value]));
    return {
        node: { incompleteSources: frame.incompleteSources },
        keysWritten: frame.contextSources.map((s) => s.key),
        valueOf: (key) => byKey.get(key),
    };
}
/** Resolve a frame to its content-bearing suspects (injection / memory / tool), dedup'd by suspectId. */
function suspectsOf(frame, classify) {
    const seeds = classify(classifyContextFor(frame)) ?? [];
    const out = [];
    const seen = new Set();
    for (const seed of seeds) {
        const suspectId = seed.detail?.injectionId ?? seed.detail?.toolName;
        if (suspectId === undefined)
            continue; // skip 'stage' / 'arg' fallbacks — no content identity
        if (seen.has(suspectId))
            continue;
        seen.add(suspectId);
        out.push({ suspectId, kind: seed.kind, text: seed.detail?.text ?? '' });
    }
    return out;
}
/**
 * Score a recorded agent run into a per-loop RECALL shortlist (L3). Works on BOTH flat and grouped
 * trajectories (it reads each frame's contextSources + intermediateText regardless of shape).
 *
 * Returns the top-`k` candidates ranked recall-first, each joinable 1:1 with a localizer `Suspect`
 * via `suspectId`. Feed it to `localizeContextBug({ shortlist })` to REORDER suspects before the
 * ablation budget is spent — narrow (recall), then convict (causal).
 */
export async function shortlistEarlyCulprits(trajectory, opts) {
    const recencyDecay = opts.recencyDecay ?? DEFAULT_RECENCY_DECAY;
    const k = opts.k ?? 5;
    const classify = opts.classifier ?? defaultSuspectClassifier;
    const truncated = trajectory.truncated?.byFrames === true;
    // The last loop index — recency is measured back from here (weight = recencyDecay^(lastLoop − N)).
    const lastLoop = trajectory.frames.reduce((m, f) => Math.max(m, f.loopIndex), 0);
    // Per-suspect accumulators (keyed on suspectId — the no-double-count identity).
    const score = new Map();
    const kindOf = new Map();
    const enteredLoop = new Map();
    const perLoop = new Map();
    const incomplete = new Map();
    for (const frame of trajectory.frames) {
        const suspects = suspectsOf(frame, classify);
        // Per-loop relevance: each suspect's content vs THIS loop's output (one batched call).
        let scoreById = new Map();
        if (suspects.length > 0) {
            const evidence = suspects.map((s) => ({
                id: s.suspectId,
                text: s.text,
                ancestorTexts: [],
            }));
            const scored = await scoreInfluence({
                evidence,
                finalAnswerText: frame.intermediateText ?? '',
                embedder: opts.embedder,
                ...(opts.weights ? { weights: opts.weights } : {}),
                ...(opts.signal ? { signal: opts.signal } : {}),
            });
            // Clamp to ≥0: a source dissimilar to the loop output contributes nothing, never subtracts.
            scoreById = new Map(scored.map((r) => [r.id, Math.max(0, r.score)]));
        }
        // Recency-weighted aggregation (the H2-VALIDATED mechanism — gate-confirmed over a forward sum):
        // weight a loop's per-suspect score by recencyDecay^(lastLoop − N), then SUM across loops. The
        // win over plain is the PER-LOOP signal (each source vs the loop it fed, not the final answer);
        // recencyDecay tunes how fast older loops fade (1 = uniform, 0 = last-loop-only).
        const weight = Math.pow(recencyDecay, lastLoop - frame.loopIndex);
        for (const s of suspects) {
            const sc = scoreById.get(s.suspectId) ?? 0;
            score.set(s.suspectId, (score.get(s.suspectId) ?? 0) + weight * sc);
            if (!kindOf.has(s.suspectId))
                kindOf.set(s.suspectId, s.kind);
            if (!enteredLoop.has(s.suspectId))
                enteredLoop.set(s.suspectId, frame.loopIndex);
            const track = perLoop.get(s.suspectId) ?? [];
            track.push({ loopIndex: frame.loopIndex, recallScore: sc });
            perLoop.set(s.suspectId, track);
            if (frame.untrackedReadsPresent || truncated)
                incomplete.set(s.suspectId, true);
        }
    }
    const max = Math.max(0, ...score.values());
    const candidates = [...score.entries()]
        .map(([suspectId, sum]) => ({
        suspectId,
        kind: kindOf.get(suspectId) ?? 'stage',
        recallScore: max > 0 ? sum / max : 0,
        eligibility: sum,
        enteredLoop: enteredLoop.get(suspectId) ?? 0,
        perLoop: perLoop.get(suspectId) ?? [],
        incomplete: incomplete.get(suspectId) ?? false,
    }))
        // recall-first; ties keep earlier-entered first, then suspectId for stable determinism.
        .sort((a, b) => b.recallScore - a.recallScore ||
        a.enteredLoop - b.enteredLoop ||
        a.suspectId.localeCompare(b.suspectId))
        .slice(0, k);
    return { candidates, k, recencyDecay, honestyFlags: trajectory.honestyFlags };
}
//# sourceMappingURL=loop-recall.js.map