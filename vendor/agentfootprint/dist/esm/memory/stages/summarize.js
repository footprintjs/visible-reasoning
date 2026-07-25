const DEFAULT_TRIGGER = 20;
const DEFAULT_PRESERVE = 5;
const DEFAULT_SYSTEM_PROMPT = 'Summarize the following conversation concisely, preserving facts, ' +
    'names, numbers, decisions, and user preferences. Omit conversational ' +
    'filler. Output plain text under 500 tokens.';
export function summarize(config) {
    const triggerMinEntries = config.triggerMinEntries ?? DEFAULT_TRIGGER;
    const preserveRecent = config.preserveRecent ?? DEFAULT_PRESERVE;
    const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    return async (scope) => {
        const loaded = scope.loaded ?? [];
        if (loaded.length < triggerMinEntries)
            return;
        if (loaded.length <= preserveRecent)
            return;
        // Split: older entries become the summary; newer stay verbatim.
        // `loaded` from loadRecent is oldest-first, so we take a prefix for
        // summary and a suffix for preservation.
        const splitAt = loaded.length - preserveRecent;
        const toSummarize = loaded.slice(0, splitAt);
        const toPreserve = loaded.slice(splitAt);
        // Build LLM input: system prompt + the messages verbatim.
        const llmInput = [
            { role: 'system', content: systemPrompt },
            ...toSummarize.map((e) => e.value),
        ];
        const summaryText = await config.llm(llmInput);
        const first = toSummarize[0];
        const last = toSummarize[toSummarize.length - 1];
        const earliestTurn = first.source?.turn ?? 0;
        const latestTurn = last.source?.turn ?? 0;
        const now = Date.now();
        const summaryEntry = {
            id: `summary-${earliestTurn}-to-${latestTurn}`,
            value: { role: 'system', content: summaryText },
            version: 1,
            createdAt: now,
            updatedAt: now,
            lastAccessedAt: now,
            accessCount: 0,
            tier: 'cold',
            source: {
                turn: latestTurn,
                // Carry over identity from the summarized range for cross-session
                // provenance (caller can see "this summary came from this user's
                // earlier sessions").
                ...(first.source?.identity && { identity: first.source.identity }),
            },
        };
        // Replace the summarized range with the single summary entry.
        scope.loaded = [summaryEntry, ...toPreserve];
    };
}
//# sourceMappingURL=summarize.js.map