/**
 * recorded-chat types — the session-scoped turn recorder over the existing
 * context-bisect product loop (localizeContextBug + rerunWithoutSources +
 * removableSources).
 *
 * WHY THIS EXISTS: multi-turn chat on agentfootprint is a HOST convention —
 * `AgentInput` has no history field, so hosts thread the transcript into the
 * `message` string themselves. Every chat host that wanted per-turn
 * transparency then re-wrote the same correctness-critical glue and got three
 * things subtly wrong:
 *
 *   1. `agent.getLastSnapshot()` is last-run-only — a second `run()` clobbers
 *      it, so reasoning about turn K after turn K+1 ran silently attributes
 *      the wrong run.
 *   2. History is a convention — the transcript preamble must be BYTE-identical
 *      between the recorded turn and its counterfactual re-run, or the re-run
 *      ablates a subtly different scenario without failing anything.
 *   3. The `AblationRunner` duplicates turn construction — the re-run is only
 *      valid if the rebuilt turn matches the recorded one (same system, facts,
 *      preamble).
 *
 * `recordedChat({ makeAgent })` owns exactly those three: per-turn artifact
 * freezing (1), byte-exact history threading (2), and deriving the turn-K
 * runner from the SAME `makeAgent` that ran the turn (3). It COMPOSES with the
 * 7.5 surface — `reason()` calls `localizeContextBug`, `rerunTurn()` delegates
 * to `rerunWithoutSources` and returns its result UNMODIFIED (the honesty
 * tiers are not hidden). Session registries, UI joins, comparators and
 * persistence stay host-side by design (see the guide's "What stays yours").
 */
export {};
//# sourceMappingURL=types.js.map