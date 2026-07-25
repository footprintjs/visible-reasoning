/**
 * Facts — stable, timeless claims about the user or world.
 *
 * Unlike beats (which summarize what happened in a turn) and messages
 * (which are the raw conversation), facts capture *what's currently
 * true*:
 *   - Identity: "user.name" = "Alice"
 *   - Preferences: "user.favorite_color" = "blue"
 *   - Commitments: "task.ORD-123.status" = "refunded"
 *
 * Facts dedupe by `key`. The storage layer uses stable ids of the form
 * `fact:${key}`, so a second write to the same key overwrites the
 * first. This is the difference from beats/messages (which are
 * append-only log entries).
 */
/** Build the stable `MemoryStore` id for a fact with the given key. */
export function factId(key) {
    return `fact:${key}`;
}
/** True iff the string is a fact id (starts with the `fact:` prefix). */
export function isFactId(id) {
    return id.startsWith('fact:');
}
/**
 * Duck-typed guard — true iff `value` has the shape of a `Fact`.
 * Used by pipelines that handle mixed-payload stores (facts +
 * beats + raw messages) to route entries correctly.
 */
export function isFact(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.key === 'string' && v.key.length > 0 && 'value' in v;
}
/**
 * Clamp a value to `[0, 1]`; non-finite → 0.5 (neutral). Matches the
 * `asImportance` convention in the beats layer so pickers can treat
 * `confidence` and `importance` the same way.
 */
export function asConfidence(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return 0.5;
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
//# sourceMappingURL=types.js.map