/**
 * runCheckpoint — fault-tolerant resume primitives.
 *
 * Today's pause/resume only handles INTENTIONAL pauses (`askHuman`).
 * Errors mid-run (LLM 500s, vendor outages, tool throws, container
 * restarts) propagate all the way up and the consumer must restart
 * from scratch — losing the prior iterations' work.
 *
 * This module adds the third piece of the Reliability subsystem:
 *
 *   1. **`AgentRunCheckpoint`** — JSON-serializable snapshot of an
 *      agent run's progress. Captured automatically at each
 *      iteration boundary (the natural commit points). Survives
 *      process restart — persist to Redis / Postgres / S3 / queue.
 *
 *   2. **`RunCheckpointError`** — wraps the underlying error with
 *      the last-known-good checkpoint. Throwing this instead of the
 *      raw error lets consumers catch + persist + resume later
 *      without losing context.
 *
 *   3. **`agent.resumeOnError(checkpoint)`** — replays the agent run
 *      with the checkpointed conversation history restored. The
 *      next iteration retries the call that originally failed (with
 *      the latest provider state — circuit breaker may have closed,
 *      vendor may have recovered, etc.).
 *
 * Design tradeoff: we use a CONVERSATION-HISTORY checkpoint shape
 * rather than a full executor-state checkpoint (which would require
 * footprintjs API surface changes for mid-run snapshotting). The
 * tradeoff:
 *
 *   ✅ Survives process restart (JSON-serializable, tiny payload)
 *   ✅ Works with any LLM provider — replay starts from history
 *   ✅ No footprintjs core changes
 *   ⚠️  Loses mid-iteration partial state (acceptable — iterations
 *       are atomic; we resume from the last completed boundary)
 *   ⚠️  TOOL RE-EXECUTION (idempotency requirement): anything the
 *       failed iteration did after the last completed boundary —
 *       including tool side effects — is NOT in the checkpoint. On
 *       resume the model re-decides from the restored history and may
 *       re-issue those tool calls; they WILL execute again. There is
 *       NO built-in toolCallId-based dedup. Mutating tools (payments,
 *       emails, DB writes) must be idempotent — derive an idempotency
 *       key from stable call content, not from `ctx.toolCallId` (fresh
 *       per issued call, so a re-issued call gets a NEW id). Note the
 *       same requirement exists WITHOUT resume: a tool that performs
 *       its side effect and then throws reports the error message back
 *       to the model as the tool result, and the model typically
 *       retries the call on the next iteration.
 *
 * Pattern: Memento (GoF) — snapshot of an object's internal state
 *          for later restoration. Same shape as `FlowchartCheckpoint`
 *          but at the agent layer (one logical iteration vs. one
 *          DFS stage).
 */
/**
 * Thrown by `agent.run()` when a fault occurs mid-run. Carries the
 * underlying error AND the last-known-good checkpoint. Catch this
 * specifically to engage the resume-on-error path; let other errors
 * propagate normally.
 *
 * @example
 * ```ts
 * import { Agent, RunCheckpointError } from 'agentfootprint';
 *
 * try {
 *   const result = await agent.run({ message: 'long task' });
 * } catch (err) {
 *   if (err instanceof RunCheckpointError) {
 *     await checkpointStore.put(sessionId, err.checkpoint);
 *     // hours / restart later:
 *     const checkpoint = await checkpointStore.get(sessionId);
 *     const result = await agent.resumeOnError(checkpoint);
 *   } else {
 *     throw err; // not a recoverable error — propagate
 *   }
 * }
 * ```
 */
export class RunCheckpointError extends Error {
    code = 'ERR_RUN_CHECKPOINT';
    /** The error that triggered the checkpoint. Inspect for retry
     *  decisions ("if cause is CircuitOpenError, wait for cooldown
     *  before resuming"). */
    cause;
    /** The last-known-good checkpoint. Persist + pass back to
     *  `agent.resumeOnError(checkpoint)` to continue from here. */
    checkpoint;
    constructor(cause, checkpoint) {
        const phase = checkpoint.failurePoint?.phase ?? 'unknown';
        super(`[agent run] failed at iteration ${checkpoint.failurePoint?.iteration ?? '?'} (${phase}). ` +
            `Last-good checkpoint captured at iteration ${checkpoint.lastCompletedIteration}. ` +
            `Pass to agent.resumeOnError(checkpoint) to continue. ` +
            `Underlying error: ${cause.message}`);
        this.name = 'RunCheckpointError';
        this.cause = cause;
        this.checkpoint = checkpoint;
    }
}
/**
 * Build a JSON-serializable checkpoint from a tracker + failure
 * info. Pure function — no side effects.
 *
 * @internal
 */
export function buildCheckpoint(tracker, failurePoint) {
    return {
        version: 1,
        runId: tracker.runId,
        history: tracker.history,
        lastCompletedIteration: tracker.lastCompletedIteration,
        originalInput: tracker.originalInput,
        checkpointedAt: Date.now(),
        ...(failurePoint && { failurePoint }),
    };
}
/**
 * Validate a checkpoint at deserialization time. Catches forward-
 * incompatible payloads (someone tries to resume a v3 checkpoint on
 * a v1 runtime, or a corrupted JSON blob).
 *
 * Returns the checkpoint typed-narrowed; throws TypeError on
 * unknown shape.
 */
export function validateCheckpoint(value) {
    if (!value || typeof value !== 'object') {
        throw new TypeError('[resumeOnError] checkpoint is not an object.');
    }
    const c = value;
    if (c.version !== 1) {
        throw new TypeError(`[resumeOnError] unsupported checkpoint version: ${c.version}. ` +
            `This runtime supports version 1; persisted checkpoints from a future ` +
            `agentfootprint version need a matching runtime to resume.`);
    }
    if (typeof c.runId !== 'string' || !Array.isArray(c.history)) {
        throw new TypeError('[resumeOnError] checkpoint missing required fields (runId, history).');
    }
    if (typeof c.lastCompletedIteration !== 'number') {
        throw new TypeError('[resumeOnError] checkpoint missing required field: lastCompletedIteration.');
    }
    if (!c.originalInput || typeof c.originalInput.message !== 'string') {
        throw new TypeError('[resumeOnError] checkpoint missing required field: originalInput.message.');
    }
    return c;
}
/**
 * Classify a thrown error into one of the failure-point phase
 * buckets. Heuristic — uses error name / code / message inspection.
 * Fast path returns 'unknown' so unrecognized errors still produce
 * a checkpoint (the cause itself is preserved in
 * `RunCheckpointError.cause`).
 */
export function classifyFailurePhase(err) {
    const name = err.name;
    const code = err.code ?? '';
    const msg = err.message ?? '';
    // LLM provider failures: known codes + name patterns.
    if (code === 'ERR_CIRCUIT_OPEN' || // our own circuit breaker
        name === 'AnthropicError' ||
        name === 'OpenAIError' ||
        name === 'BedrockError' ||
        /\b(LLM|provider|anthropic|openai|bedrock)\b/i.test(msg)) {
        return 'llm';
    }
    if (/\b(tool|tool_call)\b/i.test(name) || /\bTool\b/.test(msg)) {
        return 'tool';
    }
    if (/iteration/i.test(msg))
        return 'iteration';
    return 'unknown';
}
//# sourceMappingURL=runCheckpoint.js.map