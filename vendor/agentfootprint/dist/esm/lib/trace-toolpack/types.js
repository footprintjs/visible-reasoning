/**
 * Trace toolpack types — RFC-003 Part C (the introspection toolpack).
 *
 * Pattern: artifact bag — everything a debugging LLM needs to navigate a
 *          COMPLETED run, captured once and handed to `traceToolpack()`.
 * Role:    Input contract. The toolpack never re-runs anything; it serves
 *          bounded, id-addressed views over these frozen artifacts.
 */
/** Hard caps — per-call params clamp to these regardless of what the LLM asks for. */
export const TOOLPACK_HARD_CAPS = {
    sliceMaxDepth: 20,
    sliceMaxNodes: 100,
    valueMaxChars: 8000,
    narrativeMaxLines: 200,
};
export function resolveToolpackOptions(options) {
    return {
        previewChars: options?.previewChars ?? 160,
        sliceMaxDepth: options?.sliceMaxDepth ?? 6,
        sliceMaxNodes: options?.sliceMaxNodes ?? 25,
        valueMaxChars: options?.valueMaxChars ?? 2000,
    };
}
//# sourceMappingURL=types.js.map