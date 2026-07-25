import { asImportance } from './types.js';
/** Build a stable ref id for a message at a given position in a turn. */
function refId(turnNumber, index) {
    return `msg-${turnNumber}-${index}`;
}
/** Extract short text from any Message content shape. */
function textOf(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
            if (block && typeof block === 'object') {
                const b = block;
                if (b.type === 'text' && typeof b.text === 'string')
                    parts.push(b.text);
            }
        }
        return parts.join(' ');
    }
    return '';
}
/**
 * Classify a user message: is it an identity claim, a question, or
 * generic? Returns `{ importance, category? }` hints for the beat.
 */
function classifyUserText(text) {
    const lower = text.toLowerCase();
    // Identity — highest priority for recall
    if (lower.includes('my name is') || lower.includes("i'm ") || lower.includes('i am ')) {
        return { importance: 0.9, category: 'identity' };
    }
    // Question — users asking things is generally salient
    if (text.trimEnd().endsWith('?')) {
        return { importance: 0.75, category: 'question' };
    }
    return { importance: 0.6 };
}
/** Default heuristic. Takes no config; factory function for consistency. */
export function heuristicExtractor() {
    return {
        async extract(args) {
            const beats = [];
            for (let i = 0; i < args.messages.length; i++) {
                const msg = args.messages[i];
                // Skip system messages — they're prompt framing, not conversation.
                if (msg.role === 'system')
                    continue;
                const text = textOf(msg.content).trim();
                if (text.length === 0)
                    continue;
                const ref = refId(args.turnNumber, i);
                if (msg.role === 'user') {
                    const { importance, category } = classifyUserText(text);
                    beats.push({
                        summary: `User said: ${text}`,
                        importance: asImportance(importance),
                        refs: [ref],
                        ...(category ? { category } : {}),
                    });
                }
                else if (msg.role === 'assistant') {
                    beats.push({
                        summary: `Assistant replied: ${text}`,
                        importance: asImportance(0.5),
                        refs: [ref],
                    });
                }
                else if (msg.role === 'tool') {
                    beats.push({
                        summary: `Tool result: ${text}`,
                        importance: asImportance(0.3),
                        refs: [ref],
                        category: 'tool-result',
                    });
                }
            }
            return beats;
        },
    };
}
//# sourceMappingURL=heuristicExtractor.js.map