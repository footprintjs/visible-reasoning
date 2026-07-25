/**
 * GroupTranslator — UI-agnostic composition-level translator hook.
 *
 * Pattern: Visitor (GoF) at the composition boundary. Consumer supplies
 *          a translator function; each agentfootprint composition
 *          (Parallel, Sequence, Loop, Conditional, Agent, LLMCall)
 *          invokes it with composition-level metadata to produce a
 *          consumer-shaped UI output.
 * Role:    The per-COMPOSITION hook alongside footprintjs's per-NODE
 *          `StructureRecorder`. The two are independent — a consumer
 *          can attach either, both, or neither.
 *
 *          - StructureRecorder observes ONE spec node at a time (record).
 *          - GroupTranslator sees the WHOLE composition (compose).
 *
 *          For Lens's compound rendering (Parallel-as-container,
 *          Agent-as-drillable-card, LLMCall-as-card-with-slots),
 *          this is the right granularity: the translator knows the
 *          composition KIND and its full member list at once, so it
 *          can emit a single group-level shape with children pre-laid.
 *
 * Cascade: each composition that runs nested compositions exposes its
 *          members' OWN translated outputs via `GroupMember.uiGroup`.
 *          The consumer threads the same translator through every
 *          composition's construction (or per-method override via
 *          L1c) to get end-to-end coverage. No automatic propagation
 *          — propagation requires footprintjs-level changes which
 *          we're not making for this hook.
 */
export {};
//# sourceMappingURL=translator.js.map