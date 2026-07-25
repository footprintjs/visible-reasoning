import { asConfidence } from './types.js';
const DEFAULT_SYSTEM_PROMPT = `You are an extractor that distills a turn of conversation into stable, timeless facts for long-term memory.

A "fact" is a key/value claim that is currently true — not a narration of what happened. Facts dedupe by key, so later turns overwrite earlier claims.

Return JSON in this exact shape:
{
  "facts": [
    {
      "key": "user.name",
      "value": "Alice",
      "confidence": 0.0_to_1.0,
      "category": "identity|contact|profile|preference|commitment|fact|other",
      "refs": ["msg-<turn>-<index>", ...]
    }
  ]
}

Guidelines:
- Use dotted keys for nested taxonomies: user.name, user.email, user.preferences.color, task.ORD-123.status.
- Values are JSON-serializable: strings, numbers, booleans, arrays, small objects.
- Confidence 0.9+ for direct self-disclosures ("my name is X"); 0.6-0.8 for inferences; below 0.5 for guesses.
- Only extract what the user explicitly claimed or committed to. Do not invent, do not infer personality traits.
- If a prior fact is being corrected ("actually, my name is Alicia"), emit the corrected value under the SAME key.
- Return [] if no stable claims appeared in this turn.
- Return ONLY the JSON object — no prose, no code fences.`;
/** Build a stable ref id matching the beat extractor's convention. */
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
/** Serialize existing facts for the LLM's update-awareness context. */
function formatExistingFacts(existing, limit) {
    if (limit <= 0 || existing.length === 0)
        return '';
    const take = existing.slice(0, limit);
    const lines = ['Previously known facts (update or extend — do NOT re-emit unchanged):'];
    for (const f of take) {
        const conf = typeof f.confidence === 'number' ? ` (conf ${f.confidence.toFixed(2)})` : '';
        const cat = f.category ? ` [${f.category}]` : '';
        lines.push(`- ${f.key}: ${JSON.stringify(f.value)}${cat}${conf}`);
    }
    return lines.join('\n');
}
/**
 * Parse the extractor's raw JSON response into validated facts.
 * Returns an empty array on any parse / shape failure — the `onParseError`
 * callback fires so consumers can observe failures without crashing turns.
 *
 * Dedup policy: within one response, if the LLM emits the same key
 * twice, the LAST occurrence wins (matches patternFactExtractor).
 */
function parseFactsResponse(raw, onParseError) {
    try {
        const parsed = JSON.parse(raw);
        const rawFacts = (parsed?.facts ?? []);
        if (!Array.isArray(rawFacts))
            return [];
        const byKey = new Map();
        for (const rf of rawFacts) {
            if (!rf || typeof rf !== 'object')
                continue;
            const f = rf;
            if (typeof f.key !== 'string' || f.key.length === 0)
                continue;
            if (!('value' in f))
                continue;
            const refs = Array.isArray(f.refs) ? f.refs.filter((r) => typeof r === 'string') : [];
            const category = typeof f.category === 'string' ? f.category : undefined;
            byKey.set(f.key, {
                key: f.key,
                value: f.value,
                confidence: asConfidence(f.confidence),
                ...(category ? { category } : {}),
                ...(refs.length > 0 ? { refs } : {}),
            });
        }
        return Array.from(byKey.values());
    }
    catch (err) {
        onParseError(err, raw);
        return [];
    }
}
export function llmFactExtractor(config) {
    const { provider } = config;
    const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const includeExistingLimit = config.includeExistingLimit ?? 16;
    const onParseError = config.onParseError ??
        ((err, raw) => {
            // eslint-disable-next-line no-console
            console.warn('[agentfootprint] llmFactExtractor: failed to parse LLM response — returning no facts', { error: err, rawPreview: raw.slice(0, 200) });
        });
    return {
        async extract(args) {
            const turn = formatMessagesForExtractor(args.messages, args.turnNumber);
            const prior = formatExistingFacts(args.existing ?? [], includeExistingLimit);
            const userContent = prior.length > 0 ? `${prior}\n\n${turn}` : turn;
            const response = await provider.complete({
                systemPrompt,
                messages: [{ role: 'user', content: userContent }],
                model: 'memory-extractor',
                ...(args.signal ? { signal: args.signal } : {}),
            });
            return parseFactsResponse(response.content ?? '', onParseError);
        },
    };
}
//# sourceMappingURL=llmFactExtractor.js.map