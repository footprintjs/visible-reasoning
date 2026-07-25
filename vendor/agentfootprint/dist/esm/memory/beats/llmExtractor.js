import { asImportance } from './types.js';
const DEFAULT_SYSTEM_PROMPT = `You are an extractor that distills a single turn of a conversation into narrative beats for long-term memory.

A "beat" is a one-sentence, self-contained summary of something salient that happened this turn — a fact the user revealed, a decision the agent made, an important question, a result returned.

Return JSON in this exact shape:
{
  "beats": [
    {
      "summary": "one sentence",
      "importance": 0.0_to_1.0,
      "refs": ["msg-<turn>-<index>", ...],
      "category": "identity|preference|fact|task|question|tool-result|other"
    }
  ]
}

Guidelines:
- Importance 0.9+ for identity, strong preferences, commitments.
- Importance 0.5-0.7 for questions, task progress.
- Importance 0.3 or lower for low-salience tool chatter.
- Return [] if nothing salient happened.
- Return ONLY the JSON object — no prose, no code fences.`;
/** Build a stable ref id matching heuristicExtractor's convention. */
function refId(turnNumber, index) {
    return `msg-${turnNumber}-${index}`;
}
/** Serialize messages for the extractor LLM's user prompt. */
function formatMessagesForExtractor(messages, turnNumber) {
    const lines = [`Turn ${turnNumber}:`];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'system')
            continue;
        const ref = refId(turnNumber, i);
        lines.push(`[${ref}] ${m.role}: ${m.content}`);
    }
    return lines.join('\n');
}
/**
 * Parse the extractor's raw JSON response into validated beats.
 * Returns an empty array on any parse / shape failure — the `onParseError`
 * callback fires so consumers can observe failures without crashing turns.
 */
function parseBeatsResponse(raw, onParseError) {
    try {
        const parsed = JSON.parse(raw);
        const rawBeats = (parsed?.beats ?? []);
        if (!Array.isArray(rawBeats))
            return [];
        const beats = [];
        for (const rb of rawBeats) {
            if (!rb || typeof rb !== 'object')
                continue;
            const b = rb;
            if (typeof b.summary !== 'string' || b.summary.length === 0)
                continue;
            const refs = Array.isArray(b.refs) ? b.refs.filter((r) => typeof r === 'string') : [];
            const category = typeof b.category === 'string' ? b.category : undefined;
            beats.push({
                summary: b.summary,
                importance: asImportance(b.importance),
                refs,
                ...(category ? { category } : {}),
            });
        }
        return beats;
    }
    catch (err) {
        onParseError(err, raw);
        return [];
    }
}
export function llmExtractor(config) {
    const { provider } = config;
    const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const onParseError = config.onParseError ??
        ((err, raw) => {
            // eslint-disable-next-line no-console
            console.warn('[agentfootprint] llmExtractor: failed to parse LLM response — returning no beats', { error: err, rawPreview: raw.slice(0, 200) });
        });
    return {
        async extract(args) {
            const userContent = formatMessagesForExtractor(args.messages, args.turnNumber);
            const response = await provider.complete({
                systemPrompt,
                messages: [{ role: 'user', content: userContent }],
                model: 'memory-extractor',
                ...(args.signal ? { signal: args.signal } : {}),
            });
            return parseBeatsResponse(response.content ?? '', onParseError);
        },
    };
}
//# sourceMappingURL=llmExtractor.js.map