/**
 * staticTools — the simplest ToolProvider. Wraps a fixed Tool[] list.
 *
 * 90% case. What `agent.tools(arr)` does today, made composable.
 * Equivalent to passing `arr` directly EXCEPT that `staticTools(arr)`
 * is now a `ToolProvider` you can wrap with `gatedTools(...)` for
 * permission filtering or per-skill gating.
 *
 * Pattern: identity ToolProvider — no filtering, just exposes the
 *          underlying list verbatim.
 *
 * @example
 *   const provider = staticTools([weatherTool, lookupTool]);
 *   // Materialize the visible list and register via .tools(...).
 *   // Direct .toolProvider(...) wiring on the builder lands in Block A5 / v2.5+.
 *   const visible = provider.list({ iteration: 0, identity: { conversationId: '_' } });
 *   const agent = Agent.create({ provider: llm, model }).tools(visible).build();
 */
// #region staticTools
export function staticTools(tools) {
    // Capture the input list once. `list()` returns a fresh array each
    // call so the agent's reference-equality check always sees an update
    // (matches the `gatedTools` decorator's per-call recomputation).
    const captured = [...tools];
    return {
        id: 'static',
        list(_ctx) {
            return [...captured];
        },
    };
}
// #endregion staticTools
//# sourceMappingURL=staticTools.js.map