/**
 * contextEngineering(agent) — first-class handle on the engineered
 * subset of `context.injected` events.
 *
 * The Block A8 piece. agentfootprint already emits `context.injected`
 * for EVERY piece of content that lands in a slot — including the
 * baseline flow (the user message, every tool result, the static
 * system prompt). For a developer who wants to inspect what their
 * RAG / Skills / Memory / Instructions / Steering / Facts ARE
 * INJECTING (the actual context-engineering work), the baseline flow
 * is noise.
 *
 * `contextEngineering(agent)` filters the stream to ONLY the
 * engineered injections and gives consumers two cleaner subscriptions:
 *
 *   - `onEngineered(cb)` — fires for `source` ∈ {rag, skill, memory,
 *     instructions, steering, fact, custom}. The actual
 *     context-engineering work.
 *   - `onBaseline(cb)` — fires for `source` ∈ {user, tool-result,
 *     assistant, base, registry}. The baseline message-history flow.
 *
 * Use cases:
 *   - **Lens UI**: render only engineered injections in the "context
 *     bin"; show the baseline flow as edges between iterations.
 *   - **Eval pipelines**: count how many RAG chunks vs Memory entries
 *     vs Skill bodies entered the prompt for an eval-set query.
 *   - **Cost attribution**: sum tokens by `source` to know what
 *     fraction of spend is RAG vs Skills vs baseline.
 *   - **Debug logging**: tail just the engineered signals to spot
 *     surprising activations during dev.
 *
 * Pattern: Strategy + Filter (GoF) — pure classifier function over
 *          the existing `context.injected` event payload, paired with
 *          a thin subscription helper.
 *
 * Role:    Layer-2 (event taxonomy) consumer-side helper. Doesn't
 *          emit new events; doesn't change the agent's flowchart.
 *          Pure observation.
 *
 * @example
 *   import { contextEngineering } from 'agentfootprint';
 *
 *   const ce = contextEngineering(agent);
 *   ce.onEngineered((e) => {
 *     console.log(`[${e.payload.source}] ${e.payload.contentSummary}`);
 *   });
 *   ce.onBaseline((e) => {
 *     console.log(`[baseline:${e.payload.source}]`);
 *   });
 *
 *   await agent.run({ message: 'help me' });
 *   // ... runs; engineered + baseline streams fire separately
 *
 *   ce.detach();   // stops both subscriptions; the agent itself is fine
 */
/**
 * Public set of "engineered" sources — the context-engineering
 * primitives that consumers configure (RAG, Skills, Memory,
 * Instructions, Steering, Facts) plus user-defined `custom`.
 *
 * Frozen so consumers can `.has(value)` directly without copy.
 */
export const ENGINEERED_SOURCES = new Set([
    'rag',
    'skill',
    'memory',
    'instructions',
    'steering',
    'fact',
    'custom',
]);
/**
 * Public set of "baseline" sources — the message-history flow that
 * exists regardless of context engineering: user input, tool results,
 * assistant outputs, the always-on system prompt anchor (`base`), and
 * the agent's static tool registry advertisement (`registry`).
 */
export const BASELINE_SOURCES = new Set([
    'user',
    'tool-result',
    'assistant',
    'base',
    'registry',
]);
/**
 * Pure classifier: given a `ContextSource`, is it engineered?
 *
 * Useful for ad-hoc filtering on a raw `agent.on('agentfootprint.context.injected', ...)`
 * subscription when you don't need the wrapper helper.
 */
export function isEngineeredSource(source) {
    return ENGINEERED_SOURCES.has(source);
}
/**
 * Pure classifier: given a `ContextSource`, is it baseline?
 */
export function isBaselineSource(source) {
    return BASELINE_SOURCES.has(source);
}
/**
 * Wrap a runner's `agentfootprint.context.injected` stream into two
 * filtered subscriptions: engineered + baseline. Multiple listeners
 * per stream are allowed; `detach()` removes all of them.
 *
 * The classifier inspects `event.payload.source`. Unknown sources
 * (forward-compat: `ContextSource` is open-extensible) are routed
 * to NEITHER stream — preferring under-firing over miscategorizing.
 * Use `agent.on('agentfootprint.context.injected', ...)` directly
 * if you need to observe sources that aren't (yet) classified.
 */
export function contextEngineering(agent) {
    const unsubscribers = [];
    function onEngineered(listener) {
        const wrapped = (e) => {
            if (isEngineeredSource(e.payload.source))
                listener(e);
        };
        const unsub = agent.on('agentfootprint.context.injected', wrapped);
        unsubscribers.push(unsub);
        return () => {
            unsub();
            const idx = unsubscribers.indexOf(unsub);
            if (idx >= 0)
                unsubscribers.splice(idx, 1);
        };
    }
    function onBaseline(listener) {
        const wrapped = (e) => {
            if (isBaselineSource(e.payload.source))
                listener(e);
        };
        const unsub = agent.on('agentfootprint.context.injected', wrapped);
        unsubscribers.push(unsub);
        return () => {
            unsub();
            const idx = unsubscribers.indexOf(unsub);
            if (idx >= 0)
                unsubscribers.splice(idx, 1);
        };
    }
    function detach() {
        for (const unsub of unsubscribers) {
            try {
                unsub();
            }
            catch {
                // Defensive: a misbehaving subscription's throw should not
                // prevent detaching the rest.
            }
        }
        unsubscribers.length = 0;
    }
    return { onEngineered, onBaseline, detach };
}
//# sourceMappingURL=contextEngineering.js.map