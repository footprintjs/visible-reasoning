// NOTE on stage ordering:
//   This helper uses `addSubFlowChartNext`, which appends the subflow at
//   the current builder tail. Consumers who need the read subflow to run
//   BEFORE a specific agent stage should arrange the call order
//   accordingly — e.g., `mountMemoryPipeline(builder).addFunction('CallLLM', ...)`.
//   If the underlying builder gains "insert before stage id" API later,
//   this helper can be extended non-breakingly.
const DEFAULTS = {
    identityKey: 'identity',
    turnNumberKey: 'turnNumber',
    contextTokensKey: 'contextTokensRemaining',
    injectionKey: 'memoryInjection',
    newMessagesKey: 'newMessages',
    readSubflowId: 'sf-memory-read',
    writeSubflowId: 'sf-memory-write',
};
/**
 * Mount only the READ subflow. Appends at the current builder tail, so
 * callers typically invoke this BEFORE their LLM-call stage:
 *
 *   let b = flowChart('Seed', seedFn, 'seed');
 *   b = mountMemoryRead(b, { pipeline });
 *   b = b.addFunction('CallLLM', llmStage, 'call-llm');   // reads memoryInjection
 *   b = mountMemoryWrite(b, { pipeline });                // persists newMessages
 *
 * Returns the same builder reference (fluent).
 */
export function mountMemoryRead(builder, config) {
    const identityKey = config.identityKey ?? DEFAULTS.identityKey;
    const turnNumberKey = config.turnNumberKey ?? DEFAULTS.turnNumberKey;
    const contextTokensKey = config.contextTokensKey ?? DEFAULTS.contextTokensKey;
    const injectionKey = config.injectionKey ?? DEFAULTS.injectionKey;
    const readSubflowId = config.readSubflowId ?? DEFAULTS.readSubflowId;
    return builder.addSubFlowChartNext(readSubflowId, config.pipeline.read, 'Load Memory', {
        inputMapper: (parentState) => ({
            identity: parentState[identityKey],
            turnNumber: parentState[turnNumberKey],
            contextTokensRemaining: parentState[contextTokensKey],
            // Pass the current turn's messages through — semantic read stages
            // like `loadRelevant` derive the query from the last user
            // message here. The write-side `newMessages` field is empty
            // during read; these are two different concerns.
            // Agents carry the conversation as `history`; bare hosts may use
            // `messages`. Without this fallback, read stages that derive the query
            // from the last user message (loadSnapshot/loadRelevant) saw [] inside
            // an Agent and silently injected nothing — the causal READ never fired.
            messages: parentState.messages ?? parentState.history ?? [],
            newMessages: [], // write side unused in read subflow
        }),
        outputMapper: (subflowState) => ({
            [injectionKey]: subflowState.formatted,
        }),
    });
}
/**
 * Mount only the WRITE subflow. No-op when the pipeline has no `write`
 * (e.g., ephemeral pipelines) — returns the builder unchanged.
 */
export function mountMemoryWrite(builder, config) {
    if (!config.pipeline.write)
        return builder;
    const identityKey = config.identityKey ?? DEFAULTS.identityKey;
    const turnNumberKey = config.turnNumberKey ?? DEFAULTS.turnNumberKey;
    const contextTokensKey = config.contextTokensKey ?? DEFAULTS.contextTokensKey;
    const newMessagesKey = config.newMessagesKey ?? DEFAULTS.newMessagesKey;
    const writeSubflowId = config.writeSubflowId ?? DEFAULTS.writeSubflowId;
    return builder.addSubFlowChartNext(writeSubflowId, config.pipeline.write, 'Save Memory', {
        inputMapper: (parentState) => ({
            identity: parentState[identityKey],
            turnNumber: parentState[turnNumberKey],
            contextTokensRemaining: parentState[contextTokensKey] ?? 0,
            newMessages: parentState[newMessagesKey] ?? [],
            // Evidence bridge (#5): harvested run evidence for causal writeSnapshot.
            // Closure-delivered (no PARENT-scope write) — note it DOES land in the
            // write subflow's own tracked scope/commit log, like newMessages; the
            // values are already observable as events, so no new exposure class.
            ...(config.evidenceSource && { runEvidence: config.evidenceSource() }),
        }),
        // No outputMapper — write has no parent-visible output.
    });
}
/**
 * Convenience: mount both read and write subflows back-to-back.
 * Appropriate ONLY when the host flowchart has no stages between memory
 * read and memory write (rare — most agents have the LLM call between).
 * Prefer `mountMemoryRead` + stages + `mountMemoryWrite` for typical agents.
 */
export function mountMemoryPipeline(builder, config) {
    return mountMemoryWrite(mountMemoryRead(builder, config), config);
}
//# sourceMappingURL=mountMemoryPipeline.js.map