/**
 * context-ledger/types.ts — the bookkeeper's vocabulary.
 *
 * WHY THIS LIBRARY EXISTS: context engineering fails in one predictable
 * direction — "include everything to be safe". Every injection, skill and
 * tool schema costs tokens EVERY turn, whether or not it ever mattered. The
 * ledger keeps score across runs: which pieces EARNED their tokens (were
 * called, activated, or sat on the answer's dependency slice) and which
 * never did. Its rows feed the L2 gates (gatedTools predicate, skill-graph
 * EntryScorer, injection demotion) so future turns include less — the
 * mechanism that makes lesser models viable.
 *
 * HONESTY (the discipline everything here inherits):
 * - Every counter is a STRUCTURAL fact from the run's own commit log —
 *   offers are recorded commits, uses are recorded calls/activations/slice
 *   membership. Nothing is inferred from model internals.
 * - Each kind's `used` definition is explicit ({@link UsedSignal}) and rides
 *   every count — a consumer can always see WHY a piece counted as used.
 * - Slice membership is slot-granular (all injections sharing a slot share
 *   its write) — the signal name says so: `'answer-slice(slot)'`.
 * - `approxTokens*` is a serialized-length estimate (JSON chars ÷ 4), named
 *   so nobody mistakes it for a tokenizer count.
 * - The ledger never claims causation. `earnRate` is bookkeeping;
 *   ablation (context-bisect) can upgrade individual claims when you pay
 *   for it.
 */
export {};
//# sourceMappingURL=types.js.map