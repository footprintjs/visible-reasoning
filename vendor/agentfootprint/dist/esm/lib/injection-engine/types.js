/**
 * Injection Engine — types.
 *
 * THE primitive that unifies every form of context engineering in the
 * library. Skills, Steering docs, Instructions, RAG, Memory, custom
 * Context — all reduce to one shape: an `Injection` with a `trigger`
 * (when), `inject` (what — one or more slot targets), and a `flavor`
 * (observability tag).
 *
 * Pattern: Strategy (GoF) — each Injection's trigger is a strategy for
 *          "should I activate this iteration?". Each Injection's
 *          `inject` is the Memento (GoF) carrying content to slots.
 * Role:    Layer-3 context engineering primitive in the stack.
 *          Sits below the slot subflows.
 * Emits:   Engine emits `agentfootprint.context.evaluated` once per
 *          iteration. Slot subflows emit `agentfootprint.context.injected`
 *          for each InjectionRecord they place.
 */
/** Project a full Injection (with functions) into a scope-safe POJO. */
export function projectActiveInjection(inj) {
    // Project per-skill metadata that slot subflows need to dispatch on.
    // `surfaceMode` drives the system-prompt-suppression decision (Block C).
    // `autoActivate` is reserved for runtime tool gating (forward-compat).
    const meta = inj.metadata;
    const out = {
        id: inj.id,
        flavor: inj.flavor,
        ...(inj.description && { description: inj.description }),
        ...(meta?.surfaceMode && { surfaceMode: meta.surfaceMode }),
        ...(meta?.autoActivate && {
            autoActivate: meta.autoActivate,
        }),
        inject: {
            ...(inj.inject.systemPrompt && { systemPrompt: inj.inject.systemPrompt }),
            ...(inj.inject.messages && { messages: inj.inject.messages.map((m) => ({ ...m })) }),
            ...(inj.inject.tools && {
                tools: inj.inject.tools.map((t) => ({
                    schema: { ...t.schema },
                    injectionId: inj.id,
                })),
            }),
        },
    };
    return out;
}
//# sourceMappingURL=types.js.map