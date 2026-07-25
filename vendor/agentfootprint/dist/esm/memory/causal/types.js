/**
 * Causal memory — types.
 *
 * A `SnapshotEntry` is the value stored in a Causal `MemoryStore`. It
 * captures one agent run's "what happened and why" so future turns can
 * answer follow-up questions ("why did you reject this?") with EXACT
 * past facts instead of LLM reconstruction.
 *
 * Differentiator: footprintjs's `decide()`/`select()` already capture
 * decision evidence as first-class events during traversal — we just
 * persist them. Other libraries can't do this without rebuilding their
 * core to surface decision evidence.
 *
 * Stored as `MemoryEntry<SnapshotEntry>` so the existing store layer
 * (`MemoryStore`, `InMemoryStore`, future Redis/Dynamo/Postgres
 * adapters) handles persistence + identity isolation + TTL + vector
 * search out of the box.
 */
/**
 * Default truncation when serializing tool results into the snapshot.
 * Keeps snapshot entries small enough to fit many in context during
 * retrieval. Override per-call via `writeSnapshot` config.
 */
export const DEFAULT_TOOL_RESULT_PREVIEW_LEN = 500;
//# sourceMappingURL=types.js.map