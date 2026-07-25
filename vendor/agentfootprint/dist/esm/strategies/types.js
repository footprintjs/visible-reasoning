/**
 * Strategy interface types for the v2.8 grouped-enabler architecture.
 *
 * Pattern: Strategy + Bridge + Hexagonal port. See the design memo
 *          `docs/inspiration/strategy-everywhere.md`.
 *
 * Four groups, four typed strategy interfaces. Each follows the same
 * shape (one canonical contract, locked at the type level):
 *
 *   1. `name: string`            — registry key for auto-registration
 *   2. `capabilities: {...}`     — what this strategy supports
 *   3. `onEvent(...)`            — hot path; sync, side-effect-only
 *   4. `flush?(): Promise<void>` — optional batch flushing
 *   5. `stop?(): void`           — optional teardown
 *
 * Design constraints (from the panel review):
 *   - **PASSIVE / non-blocking by construction.** Strategies are
 *     observers — they NEVER block the agent loop. Async work
 *     (HTTP shipment, disk I/O, batching) is the STRATEGY's internal
 *     concern: buffer in `onEvent` (sync), drain in `flush()` (async
 *     OK). The dispatcher never awaits a strategy's `onEvent`.
 *   - `onEvent` MUST be sync `void`. MUST NOT throw. Errors caught +
 *     routed to `_onError` at the dispatch layer; one bad strategy
 *     never breaks the agent loop.
 *   - Idempotent registration — registering the same `name` twice
 *     replaces, doesn't double-fire.
 *   - `stop()` is idempotent — halts everything that strategy enabled,
 *     nothing else, calling twice is a no-op.
 *   - `flush()` is optional, may be sync OR async — strategies that
 *     don't batch can omit it. Consumer's `agent.run()` lifecycle
 *     calls flush at boundary points (turn end, run end) so batched
 *     strategies don't lose tail events. Flush is the ONLY async
 *     path; the hot path is always sync.
 */
export {};
//# sourceMappingURL=types.js.map