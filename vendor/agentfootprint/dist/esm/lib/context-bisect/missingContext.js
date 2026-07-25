/**
 * missingContext — interface #3: find context that was AVAILABLE but never
 * reached the model (RFC-003).
 *
 * The localizer's influence ranking (#1) + ablation (#2) handle culprits that
 * are PRESENT in the context. They are blind to the opposite failure: a needed
 * unit that was *dropped* — truncated out of the window, or never selected —
 * so the model never saw it. You cannot ablate what isn't there.
 *
 * This finder is the cheap, exact, deterministic half of that case: a SET
 * DIFFERENCE over unit ids. The library tracks context as identified units
 * (each injection / memory entry / tool result has a stable id), so "what got
 * dropped" is `available − sent` — no embeddings, no LLM, O(n).
 *
 * Causal confirmation is the MIRROR of ablation: RESTORATION. Add a dropped
 * unit back, re-run, and an outcome flip is the causal proof. Like ablation,
 * the re-run is consumer-supplied (the library doesn't own your agent loop);
 * see `findDroppedContext` docs + example 10 for the pattern.
 *
 * Honest claim: a dropped unit is a CANDIDATE missing-context culprit, never a
 * confirmed cause — most dropped context is correctly dropped. Only restoration
 * makes a causal claim.
 */
/**
 * Find context that was available for a turn but never reached the model —
 * `available − sent` by id. Pure, deterministic, O(n); no model or embedder.
 *
 * Ids are assumed stable and unique per side (duplicates are de-duplicated,
 * first occurrence wins). Units in `sent` but not `available` are ignored.
 *
 * Confirm a candidate causally by RESTORATION (the mirror of ablation): add the
 * dropped unit back into the context and re-run; an outcome flip is the proof.
 *
 * @example
 *   const { dropped, anyDropped } = findDroppedContext(assembled, sentToModel);
 *   if (anyDropped) {
 *     for (const unit of dropped) {
 *       if (await rerunWith(unit).outcomeFlips()) report(unit); // restoration = causal
 *     }
 *   }
 */
export function findDroppedContext(available, sent) {
    const sentIds = new Set();
    for (const u of sent)
        sentIds.add(u.id);
    const dropped = [];
    const seenAvailable = new Set();
    for (const u of available) {
        if (seenAvailable.has(u.id))
            continue; // de-dup by id, first wins
        seenAvailable.add(u.id);
        if (!sentIds.has(u.id))
            dropped.push(u.content === undefined ? { id: u.id } : { id: u.id, content: u.content });
    }
    const availableCount = seenAvailable.size;
    const sentCount = sentIds.size;
    const anyDropped = dropped.length > 0;
    const reason = anyDropped
        ? `${dropped.length} of ${availableCount} available unit(s) never reached the model — candidate(s) for a missing-context bug (truncation / dilution). Confirm by RESTORATION: add a unit back and re-run; an outcome flip is the causal proof (mirror of ablation). Most dropped context is correctly dropped — only restoration confirms.`
        : `All ${availableCount} available unit(s) reached the model — no missing-context bug here (nothing was dropped).`;
    return { dropped, availableCount, sentCount, anyDropped, reason };
}
//# sourceMappingURL=missingContext.js.map