/**
 * Bounded serialization helpers for the trace toolpack.
 *
 * Pattern: pure functions — no state, no events.
 * Role:    The token-economics layer. EVERY value the toolpack serves goes
 *          through these: previews are capped, truncation is EXPLICIT
 *          (never silent), and nested-path keys round-trip between the
 *          engine's DELIM encoding and LLM-friendly dot notation.
 */
/**
 * footprintjs's canonical nested-path delimiter (ASCII unit separator,
 * `src/lib/memory/utils.ts`). Internal to the engine — the toolpack
 * translates it to/from dot notation so the LLM never sees a control char.
 */
export const FP_PATH_DELIM = '\u001F';
/** Engine path → LLM-friendly dotted display form. */
export function displayKey(path) {
    return path.includes(FP_PATH_DELIM) ? path.split(FP_PATH_DELIM).join('.') : path;
}
/**
 * LLM-supplied key → engine path. Exact keys pass through; a dotted key
 * that doesn't exist verbatim but matches a known DELIM-joined path is
 * translated back. `knownPaths` is the set of every path seen in the
 * commit log's trace entries.
 */
export function normalizeKey(key, knownPaths) {
    if (knownPaths.has(key))
        return key;
    if (key.includes('.')) {
        const delimForm = key.split('.').join(FP_PATH_DELIM);
        if (knownPaths.has(delimForm))
            return delimForm;
    }
    return key;
}
/** Replace every DELIM in an already-formatted text block with '.' for display. */
export function displayText(text) {
    return text.split(FP_PATH_DELIM).join('.');
}
/**
 * Serialize a value to compact JSON, total-function style: cycles, BigInt
 * and other non-JSON values degrade to a tagged placeholder instead of
 * throwing — a debugger tool must never crash on the evidence it serves.
 */
export function safeStringify(value) {
    if (value === undefined)
        return 'undefined';
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    }
    catch {
        return '[unserializable value]';
    }
}
/** Serialize + cap at `maxChars`. Truncation is reported, never silent. */
export function boundedPreview(value, maxChars) {
    const full = safeStringify(value);
    if (full.length <= maxChars) {
        return { text: full, totalChars: full.length, truncated: false };
    }
    return { text: `${full.slice(0, maxChars)}…`, totalChars: full.length, truncated: true };
}
/** Render a preview with its honesty suffix when truncated. */
export function renderPreview(preview, fetchHint) {
    if (!preview.truncated)
        return preview.text;
    const hint = fetchHint ? ` — ${fetchHint}` : '';
    return `${preview.text} (${preview.totalChars} chars total${hint})`;
}
/** Clamp an LLM-supplied numeric param into [min, hardCap], with a default. */
export function clampParam(requested, fallback, min, hardCap) {
    const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : fallback;
    return Math.max(min, Math.min(Math.floor(value), hardCap));
}
//# sourceMappingURL=bounded.js.map