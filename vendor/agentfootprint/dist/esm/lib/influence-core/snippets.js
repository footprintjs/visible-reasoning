/**
 * Cut `value` (a tool result — arbitrary JSON value or prose string)
 * into at most `max` citable units for the data channel.
 */
export function snippetUnits(value, options = {}) {
    const channel = options.channel ?? 'data';
    const idPrefix = options.idPrefix ?? 'data';
    const max = options.max ?? 12;
    const maxLength = options.maxLength ?? 200;
    const texts = [];
    collect(value, texts, max, new WeakSet());
    return texts.map((text, i) => ({
        id: `${idPrefix}-${i + 1}`,
        channel,
        text: truncate(text, maxLength),
    }));
}
/** Walk `value` depth-first, pushing snippet texts until `max` is reached. */
function collect(value, out, max, seen) {
    if (out.length >= max)
        return;
    if (typeof value === 'string') {
        for (const sentence of splitSentences(value)) {
            if (out.length >= max)
                return;
            out.push(sentence);
        }
        return;
    }
    if (isCitablePrimitive(value)) {
        out.push(String(value));
        return;
    }
    if (typeof value !== 'object' || value === null)
        return; // boolean/null/undefined/function/symbol
    if (seen.has(value))
        return; // circular reference — already visited
    seen.add(value);
    if (Array.isArray(value)) {
        for (const element of value) {
            if (out.length >= max)
                return;
            if (isPlainRecord(element)) {
                // The natural citation grain: one unit per row/hit, then walk its
                // nested values (a hit may itself contain an array of hits).
                if (seen.has(element))
                    continue;
                seen.add(element);
                const summary = summarizeFields(element);
                if (summary !== '')
                    out.push(summary);
                for (const nested of Object.values(element)) {
                    if (typeof nested === 'object' && nested !== null)
                        collect(nested, out, max, seen);
                }
            }
            else {
                collect(element, out, max, seen);
            }
        }
        return;
    }
    // Non-array object: group its primitive fields into one unit, recurse
    // into the rest.
    const summary = summarizeFields(value);
    if (summary !== '')
        out.push(summary);
    for (const nested of Object.values(value)) {
        if (out.length >= max)
            return;
        if (typeof nested === 'object' && nested !== null)
            collect(nested, out, max, seen);
    }
}
/** Join an object's own citable primitive fields as `key: value` pairs. */
function summarizeFields(record) {
    const pairs = [];
    for (const [key, v] of Object.entries(record)) {
        if (typeof v === 'string') {
            const trimmed = v.trim();
            if (trimmed !== '')
                pairs.push(`${key}: ${trimmed}`);
        }
        else if (isCitablePrimitive(v)) {
            pairs.push(`${key}: ${String(v)}`);
        }
    }
    return pairs.join(', ');
}
/** Non-string primitives worth quoting: numbers and bigints. Booleans,
 *  null, and undefined carry no citable content — skipped. */
function isCitablePrimitive(value) {
    return typeof value === 'number' || typeof value === 'bigint';
}
/** A record-shaped object (not an array) — the row/hit case. */
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Split prose into sentences/lines; non-empty, trimmed. */
function splitSentences(text) {
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
}
/** Cap text at `maxLength` characters, ellipsis included. */
function truncate(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    if (maxLength <= 1)
        return '…';
    return `${text.slice(0, maxLength - 1)}…`;
}
//# sourceMappingURL=snippets.js.map