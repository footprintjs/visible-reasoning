/**
 * PolicyHaltError — typed error thrown by `Agent.run()` when a
 * `PermissionChecker.check()` returns `{ result: 'halt', ... }`.
 *
 * Pattern: Typed Error (parallel to `ReliabilityFailFastError`).
 * Role:    Surface layer for sequence governance / security halts —
 *          terminates the run cleanly with full forensic context so
 *          callers can route alerts (PagerDuty / Slack / dashboard)
 *          based on the rule that fired.
 * Emits:   N/A (this file DEFINES the error class; the corresponding
 *          observability event `agentfootprint.permission.halt` fires
 *          from the toolCalls handler at the moment the halt resolves).
 *
 * Strict ordering on halt — the framework guarantees:
 *   1. Synthetic `tool_result` (with `tellLLM` content) appended to
 *      `scope.history` so the Anthropic / OpenAI tool_use ↔ tool_result
 *      pairing protocol is satisfied.
 *   2. `agentfootprint.permission.halt` event emitted.
 *   3. Stage commits (commitLog has the entry; runtimeStageId is
 *      complete).
 *   4. THEN this error is thrown by `Agent.run()`.
 *
 * @example
 *   try {
 *     await agent.run({ message: 'help me with order #42' });
 *   } catch (e) {
 *     if (e instanceof PolicyHaltError) {
 *       console.log(`HALT: rule='${e.reason}' iteration=${e.iteration}`);
 *       console.log(`Sequence: ${e.sequence.map(c => c.name).join(' → ')}`);
 *       if (e.reason.startsWith('security:')) {
 *         await pagerDuty.notify(e);
 *       }
 *     } else {
 *       throw e;
 *     }
 *   }
 */
export class PolicyHaltError extends Error {
    code = 'ERR_POLICY_HALT';
    reason;
    tellLLM;
    sequence;
    iteration;
    history;
    proposed;
    checkerId;
    constructor(ctx) {
        super(`Policy halt: ${ctx.reason} (tool='${ctx.proposed.name}', iteration=${ctx.iteration})`);
        this.name = 'PolicyHaltError';
        this.reason = ctx.reason;
        if (ctx.tellLLM !== undefined)
            this.tellLLM = ctx.tellLLM;
        this.sequence = ctx.sequence;
        this.iteration = ctx.iteration;
        this.history = ctx.history;
        this.proposed = ctx.proposed;
        if (ctx.checkerId !== undefined)
            this.checkerId = ctx.checkerId;
    }
}
//# sourceMappingURL=PolicyHaltError.js.map