const DEFAULT_HEADER = 'Relevant context from prior conversations. Use when it helps answer the current turn.';
/**
 * Escape any `</memory>` in user-controlled content so it can't close the
 * surrounding citation block prematurely. Without this guard, a user
 * message containing the literal close tag could trick the LLM into
 * treating subsequent text as "outside memory" — a small but real
 * prompt-injection vector. We insert a zero-width-joiner between `m` and
 * `emory` so the sequence survives tokenization but does NOT parse as a
 * closing tag.
 */
function escapeMemoryTag(text) {
    return text.replace(/<\/memory>/gi, '</m\u200Demory>');
}
function defaultRenderEntry(entry) {
    const msg = entry.value;
    const turnAttr = entry.source?.turn !== undefined ? ` turn="${entry.source.turn}"` : '';
    const updatedAttr = entry.updatedAt !== undefined ? ` updated="${new Date(entry.updatedAt).toISOString()}"` : '';
    const text = msg.content ?? '';
    const role = msg.role ?? 'unknown';
    return `<memory role="${role}"${turnAttr}${updatedAttr}>\n${escapeMemoryTag(text)}\n</memory>`;
}
export function formatDefault(config = {}) {
    const header = config.header ?? DEFAULT_HEADER;
    const footer = config.footer ?? '';
    const renderEntry = config.renderEntry ?? defaultRenderEntry;
    const emitWhenEmpty = config.emitWhenEmpty ?? false;
    return async (scope) => {
        const selected = scope.selected ?? [];
        if (selected.length === 0 && !emitWhenEmpty) {
            scope.formatted = [];
            return;
        }
        const blocks = selected.map(renderEntry).join('\n\n');
        const content = (header ? `${header}\n\n` : '') + blocks + (footer ? `\n\n${footer}` : '');
        scope.formatted = [{ role: 'system', content }];
        // Context-engineering emit: memory formatted N entries into a
        // system message that lands in the Agent's Messages slot via the
        // memory-pipeline's outputMapper. Lens tags the iteration with
        // "memory · N msg(s)" so the student sees WHERE the re-injected
        // prior turns came from.
        if (typeof scope.$emit === 'function') {
            scope.$emit('agentfootprint.context.memory.injected', {
                slot: 'messages',
                // Memory injects ONE system-role message containing every selected
                // entry as a citation block (see DEFAULT_HEADER + renderEntry).
                // The downstream count delta is therefore +1 system, regardless
                // of how many memory entries it carries.
                role: 'system',
                deltaCount: { system: 1 },
                count: selected.length,
                // Tiers present in the injection — lets the UI show "working / long-term"
                // differentiation later without a schema change.
                tiers: Array.from(new Set(selected.map((e) => e.tier).filter(Boolean))),
            });
        }
    };
}
//# sourceMappingURL=formatDefault.js.map