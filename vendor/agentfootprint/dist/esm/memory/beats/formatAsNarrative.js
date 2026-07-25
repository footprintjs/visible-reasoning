const DEFAULT_HEADER = 'Relevant context from prior conversations. Use when it helps answer the current turn.';
const DEFAULT_LEAD_IN = 'From earlier: ';
/**
 * Escape `</memory>` inside beat summaries — matches the defense
 * applied by `formatDefault` even though this formatter doesn't use
 * `<memory>` tags. Future consumers may wrap the paragraph in tags
 * (e.g. for custom prompt shells) and the escape prevents any
 * beat-content-sourced early-close of that wrapper.
 */
function escapeMemoryTag(text) {
    return text.replace(/<\/memory>/gi, '</m\u200Demory>');
}
/** Render one beat as a single sentence (with optional ref suffix). */
function renderBeat(entry, showRefs) {
    const beat = entry.value;
    const sentence = escapeMemoryTag(beat.summary.trim());
    if (!showRefs || beat.refs.length === 0)
        return sentence;
    return `${sentence} (refs: ${beat.refs.join(', ')})`;
}
export function formatAsNarrative(config = {}) {
    const header = config.header ?? DEFAULT_HEADER;
    const footer = config.footer ?? '';
    const showRefs = config.showRefs ?? false;
    const leadIn = config.leadIn ?? DEFAULT_LEAD_IN;
    const emitWhenEmpty = config.emitWhenEmpty ?? false;
    return async (scope) => {
        // `selected` is typed as MemoryEntry<Message>[] on MemoryState, but
        // in the narrative pipeline it carries MemoryEntry<NarrativeBeat>
        // entries. Cast at the boundary — the beats pipeline guarantees
        // the payload shape because extractBeats produced it.
        const selected = (scope.selected ?? []);
        if (selected.length === 0 && !emitWhenEmpty) {
            scope.formatted = [];
            return;
        }
        // Render beats as sentences joined into a paragraph. A trailing
        // period after each sentence gives the LLM a natural break; if the
        // beat's summary already ends with terminal punctuation we skip
        // adding one.
        const sentences = selected.map((entry) => {
            const s = renderBeat(entry, showRefs);
            return /[.!?]$/.test(s) ? s : `${s}.`;
        });
        const paragraph = `${leadIn}${sentences.join(' ')}`;
        const content = `${header ? `${header}\n\n` : ''}${paragraph}${footer ? `\n\n${footer}` : ''}`;
        scope.formatted = [{ role: 'system', content }];
    };
}
//# sourceMappingURL=formatAsNarrative.js.map