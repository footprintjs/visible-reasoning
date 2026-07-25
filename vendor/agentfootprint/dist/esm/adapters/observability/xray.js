/**
 * xrayObservability — AWS X-Ray distributed-tracing adapter.
 *
 * Maps agentfootprint's event taxonomy onto AWS X-Ray segment trees:
 *
 *     agent.turn_start          ↦  root segment (one trace per turn)
 *     agent.turn_end            ↦  close root segment + flush
 *     agent.iteration_start     ↦  push subsegment under root
 *     agent.iteration_end       ↦  close iteration subsegment
 *     stream.llm_start          ↦  push leaf subsegment (model call)
 *     stream.llm_end            ↦  close llm subsegment
 *     stream.tool_start         ↦  push leaf subsegment (tool call)
 *     stream.tool_end           ↦  close tool subsegment (correlated
 *                                  by toolCallId — parallel-safe)
 *     error.fatal               ↦  fault on root + close the whole
 *                                  tree (turn_end never arrives)
 *
 * Events are anchored on `meta.runId` (the dispatcher envelope),
 * with a `payload.runId` fallback for hand-built events.
 *
 * The result in the X-Ray Trace Map: a hierarchical timeline of every
 * agent run — turn → iteration → llm-call/tool-call — queryable in
 * X-Ray Insights, joinable with the rest of your AWS distributed
 * trace via `AWSTraceHeader` propagation (consumer's responsibility
 * to wire upstream/downstream IDs).
 *
 * Subpath:  `agentfootprint/observability-providers`
 * Peer dep: `@aws-sdk/client-xray` (OPTIONAL — installed only when
 *           this adapter is used).
 *
 * Sampling:
 *   By default every turn produces one trace. Pass `sampleRate: 0.1`
 *   to sample 10% of turns — sampling decisions are made at
 *   `turn_start` and persist for the whole turn (so partial traces
 *   never reach X-Ray).
 *
 * @example
 * ```ts
 * import { xrayObservability } from 'agentfootprint/observability-providers';
 * import { microtaskBatchDriver } from 'footprintjs/detach';
 *
 * agent.enable.observability({
 *   strategy: xrayObservability({
 *     region: 'us-east-1',
 *     serviceName: 'my-agent',
 *     sampleRate: 0.1,                    // 10% sampling
 *   }),
 *   detach: { driver: microtaskBatchDriver, mode: 'forget' },
 * });
 * ```
 *
 * @example Test injection
 * ```ts
 * xrayObservability({
 *   serviceName: 'test',
 *   _client: {
 *     putTraceSegments: async (input) => { capturedDocs.push(input); },
 *   },
 * });
 * ```
 */
import { lazyRequire } from '../../lib/lazyRequire.js';
// ─── Strategy factory ────────────────────────────────────────────────
export function xrayObservability(opts) {
    if (!opts.serviceName) {
        throw new TypeError(`[xrayObservability] \`serviceName\` is required. ` +
            `Pass an identifier visible in your X-Ray service map, e.g. 'my-agent-prod'.`);
    }
    const sampleRate = opts.sampleRate ?? 1;
    const maxBatchSegments = opts.maxBatchSegments ?? 25;
    const flushIntervalMs = opts.flushIntervalMs ?? 1000;
    // Per-turn state. agentfootprint events arrive interleaved across
    // multiple in-flight turns; we key the active stack by the run
    // anchor (`meta.runId` — see anchorRunId).
    const activeTurns = new Map();
    // Outbound segment buffer (flat list of closed segments ready for
    // PutTraceSegments). Drained by flush() / size-trigger / time-trigger.
    const outbox = [];
    let lastFlushPromise = Promise.resolve();
    let timer;
    let stopped = false;
    let onErrorHook;
    // Lazy SDK client.
    let client = opts._client;
    function ensureClient() {
        if (client)
            return client;
        client = createXRayClient(opts.region);
        return client;
    }
    function scheduleTimedFlush() {
        if (timer || flushIntervalMs <= 0 || stopped)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            void doFlush();
        }, flushIntervalMs);
    }
    async function doFlush() {
        if (outbox.length === 0 || stopped)
            return;
        const batch = outbox.splice(0, maxBatchSegments);
        try {
            await ensureClient().putTraceSegments({
                TraceSegmentDocuments: batch.map((s) => JSON.stringify(s)),
            });
        }
        catch (err) {
            onErrorHook?.(err instanceof Error ? err : new Error(String(err)));
        }
        // If outbox grew during the put (size > maxBatchSegments emits
        // arrived), chain another flush.
        if (outbox.length > 0 && !stopped) {
            lastFlushPromise = lastFlushPromise.then(doFlush, doFlush);
        }
    }
    function pushSegment(turnState, name) {
        const parent = turnState.stack[turnState.stack.length - 1];
        const seg = {
            name,
            id: hexId(16),
            trace_id: turnState.traceId,
            ...(parent && { parent_id: parent.id }),
            start_time: nowSeconds(),
            in_progress: true,
        };
        turnState.stack.push(seg);
        return seg;
    }
    function popSegment(turnState, expectedName) {
        // Defensive: pop the topmost segment whose name matches (if
        // provided). Out-of-order events would otherwise leave dangling
        // segments. If no match, pop the topmost.
        let idx = turnState.stack.length - 1;
        if (expectedName) {
            // idx >= 0 guard above guarantees stack[idx] exists.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            while (idx >= 0 && turnState.stack[idx].name !== expectedName)
                idx--;
        }
        if (idx < 0)
            return undefined;
        // splice(idx, 1) returns a 1-element array; idx < 0 guarded above.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const seg = turnState.stack.splice(idx, 1)[0];
        seg.end_time = nowSeconds();
        delete seg.in_progress;
        return seg;
    }
    function closeSegment(turnState, expectedName, extra) {
        const seg = popSegment(turnState, expectedName);
        if (!seg)
            return;
        finishSegment(turnState, seg, extra);
    }
    /** Seal an already-popped segment and graduate the turn to the
     *  outbox once its stack is empty. */
    function finishSegment(turnState, seg, extra) {
        // Idempotent seal — popSegment stamps end_time; segments removed
        // from the stack by identity (toolCallId correlation) arrive raw.
        if (seg.end_time === undefined) {
            seg.end_time = nowSeconds();
            delete seg.in_progress;
        }
        if (extra?.error)
            seg.error = true;
        if (extra?.fault)
            seg.fault = true;
        if (extra?.annotations)
            seg.annotations = { ...seg.annotations, ...extra.annotations };
        if (extra?.metadata)
            seg.metadata = { default: { ...(seg.metadata?.default ?? {}), ...extra.metadata } };
        if (turnState.sampled) {
            turnState.closed.push(seg);
            // Once the root closes, the whole turn graduates to outbox.
            if (turnState.stack.length === 0) {
                outbox.push(...turnState.closed);
                if (outbox.length >= maxBatchSegments) {
                    lastFlushPromise = lastFlushPromise.then(doFlush, doFlush);
                }
                else {
                    scheduleTimedFlush();
                }
            }
        }
    }
    // ─── Event-to-segment dispatch ─────────────────────────────────────
    /**
     * Resolve the run anchor for an event.
     *
     * Real runtime events are dispatcher envelopes — the run id lives on
     * `event.meta.runId` (built by `bridge/eventMeta.ts`). The legacy
     * `payload.runId` read is kept as a fallback for consumers feeding
     * hand-built events (the pre-fix shape this adapter's own tests
     * used). Without the meta read, NO segment ever opened on a real
     * agent run — the bug the fabricated test shapes masked.
     */
    function anchorRunId(event) {
        const meta = event.meta;
        return meta?.runId ?? event.payload?.runId;
    }
    function handleEvent(event) {
        if (stopped)
            return;
        const runId = anchorRunId(event);
        if (!runId)
            return; // Events without a turn anchor — skip.
        switch (event.type) {
            case 'agentfootprint.agent.turn_start': {
                const sampled = sampleRate >= 1 || Math.random() < sampleRate;
                const turnState = {
                    traceId: makeTraceId(),
                    stack: [],
                    closed: [],
                    sampled,
                    toolSegments: new Map(),
                };
                activeTurns.set(runId, turnState);
                if (sampled)
                    pushSegment(turnState, opts.serviceName);
                break;
            }
            case 'agentfootprint.agent.turn_end': {
                const t = activeTurns.get(runId);
                if (!t)
                    break;
                // Close everything still on the stack — defensive against
                // missing `_end` events (e.g., pause/resume mid-turn).
                while (t.stack.length > 0)
                    closeSegment(t, undefined);
                activeTurns.delete(runId);
                break;
            }
            case 'agentfootprint.agent.iteration_start': {
                const t = activeTurns.get(runId);
                if (t?.sampled) {
                    // Runtime shape: `iterIndex` (AgentIterationStartPayload).
                    // Legacy fallback `iteration` keeps hand-fed events working.
                    const iteration = event.payload.iterIndex ??
                        event.payload.iteration;
                    pushSegment(t, `iteration:${iteration ?? '?'}`);
                }
                break;
            }
            case 'agentfootprint.agent.iteration_end': {
                const t = activeTurns.get(runId);
                if (t?.sampled)
                    closeSegment(t, undefined);
                break;
            }
            case 'agentfootprint.stream.llm_start': {
                const t = activeTurns.get(runId);
                if (!t?.sampled)
                    break;
                const seg = pushSegment(t, 'llm');
                const model = event.payload.model;
                if (model)
                    seg.annotations = { model };
                break;
            }
            case 'agentfootprint.stream.llm_end': {
                const t = activeTurns.get(runId);
                if (!t?.sampled)
                    break;
                closeSegment(t, 'llm', {
                    metadata: { event: event.payload },
                });
                break;
            }
            case 'agentfootprint.stream.tool_start': {
                const t = activeTurns.get(runId);
                if (!t?.sampled)
                    break;
                const p = event.payload;
                const toolName = p.toolName ?? 'tool';
                const seg = pushSegment(t, `tool:${toolName}`);
                seg.annotations = { toolName };
                if (p.toolCallId !== undefined)
                    t.toolSegments.set(p.toolCallId, seg);
                break;
            }
            case 'agentfootprint.stream.tool_end': {
                const t = activeTurns.get(runId);
                if (!t?.sampled)
                    break;
                const p = event.payload;
                const errored = p.error !== undefined && p.error !== false;
                // Correlate by toolCallId — the only identity ToolEndPayload
                // carries at runtime (it has NO toolName), and parallel tool
                // calls end out of LIFO order. Fallback chain keeps legacy
                // hand-fed events (toolName) working.
                const byId = p.toolCallId === undefined ? undefined : t.toolSegments.get(p.toolCallId);
                if (byId !== undefined && p.toolCallId !== undefined) {
                    t.toolSegments.delete(p.toolCallId);
                    // Remove from the stack by identity so the LIFO unwind stays clean.
                    const idx = t.stack.indexOf(byId);
                    if (idx >= 0)
                        t.stack.splice(idx, 1);
                    finishSegment(t, byId, { error: errored });
                }
                else {
                    closeSegment(t, p.toolName !== undefined ? `tool:${p.toolName}` : undefined, {
                        error: errored,
                    });
                }
                break;
            }
            // A fatal run error: the turn will never see turn_end, so close
            // the segment tree here (fault on the root — X-Ray's marker for
            // unhandled exceptions) instead of leaking it in activeTurns,
            // where the closed segments would never graduate to the outbox.
            case 'agentfootprint.error.fatal': {
                const t = activeTurns.get(runId);
                if (!t)
                    break;
                while (t.stack.length > 1)
                    closeSegment(t, undefined);
                const p = event.payload;
                // Stage + scope only — error MESSAGES can echo PII.
                const annotations = {
                    ...(p.stage !== undefined && { errorStage: p.stage }),
                    ...(p.scope !== undefined && { errorScope: p.scope }),
                };
                closeSegment(t, undefined, {
                    fault: true,
                    ...(Object.keys(annotations).length > 0 && { annotations }),
                });
                activeTurns.delete(runId);
                break;
            }
            // Other events become annotations on the topmost active segment
            // (cheaper than spawning a subsegment per event).
            default: {
                const t = activeTurns.get(runId);
                const top = t?.stack[t.stack.length - 1];
                if (!t?.sampled || !top)
                    break;
                // Annotate cost ticks specially so they're queryable in
                // X-Ray Insights. Runtime shape: `cumulative.estimatedUsd`
                // (CostTickPayload); legacy fallback `cumulativeCostUsd`
                // keeps hand-fed events working.
                if (event.type === 'agentfootprint.cost.tick') {
                    const p = event.payload;
                    const usd = p.cumulative?.estimatedUsd ?? p.cumulativeCostUsd;
                    if (typeof usd === 'number') {
                        top.annotations = { ...top.annotations, cumulativeCostUsd: usd };
                    }
                }
                break;
            }
        }
    }
    return {
        name: 'xray',
        capabilities: { events: true, traces: true },
        exportEvent: handleEvent,
        async flush() {
            // Force-close any in-flight turn segments so partial traces
            // make it into X-Ray on shutdown.
            for (const [, t] of activeTurns) {
                if (!t.sampled)
                    continue;
                while (t.stack.length > 0)
                    closeSegment(t, undefined);
            }
            while (outbox.length > 0) {
                const before = lastFlushPromise;
                await before;
                if (outbox.length > 0) {
                    lastFlushPromise = doFlush();
                }
                if (lastFlushPromise === before && outbox.length === 0)
                    break;
            }
        },
        stop() {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
        _onError(err, event) {
            onErrorHook =
                onErrorHook ??
                    ((e) => {
                        // eslint-disable-next-line no-console
                        console.error(`[xrayObservability] flush failed:`, e.message);
                    });
            onErrorHook(err, event);
        },
    };
}
// ─── ID + time helpers ───────────────────────────────────────────────
/**
 * Generate an X-Ray trace ID. Format:
 *   `1-{8-hex-of-unix-timestamp}-{24-hex-random}`
 * (Note X-Ray's docs say "12 hex" for the random part; the actual
 * spec is 24 hex / 96-bit. AWS examples use 24.)
 */
function makeTraceId() {
    const seconds = Math.floor(Date.now() / 1000);
    return `1-${seconds.toString(16).padStart(8, '0')}-${hexId(24)}`;
}
/** Generate a hex string of `len` chars, cryptographically-strong
 *  where available, falling back to Math.random for environments
 *  without `crypto.getRandomValues` (older runtimes). */
function hexId(len) {
    const bytes = Math.ceil(len / 2);
    // Try the Web Crypto / Node Crypto API first.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.getRandomValues) {
        const buf = new Uint8Array(bytes);
        cryptoApi.getRandomValues(buf);
        return Array.from(buf, (b) => b.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, len);
    }
    // Fallback (deterministic-quality, NOT for security-critical IDs —
    // X-Ray IDs aren't security boundaries, just trace correlation).
    let s = '';
    while (s.length < len)
        s += Math.random().toString(16).slice(2);
    return s.slice(0, len);
}
/** X-Ray timestamps are unix seconds with fractional precision. */
function nowSeconds() {
    return Date.now() / 1000;
}
// ─── SDK construction (lazy) ─────────────────────────────────────────
function createXRayClient(region) {
    let mod;
    try {
        mod = lazyRequire('@aws-sdk/client-xray');
    }
    catch {
        throw new Error('xrayObservability requires the `@aws-sdk/client-xray` peer dependency.\n' +
            '  Install:  npm install @aws-sdk/client-xray\n' +
            '  Or pass `_client` for test injection.');
    }
    if (!mod.XRayClient || !mod.PutTraceSegmentsCommand) {
        throw new Error('xrayObservability: `@aws-sdk/client-xray` is installed but `XRayClient` / ' +
            '`PutTraceSegmentsCommand` was not found. Update the SDK.');
    }
    const sdkClient = new mod.XRayClient({ ...(region && { region }) });
    return {
        async putTraceSegments(input) {
            const cmd = new mod.PutTraceSegmentsCommand(input);
            await sdkClient.send(cmd);
        },
    };
}
//# sourceMappingURL=xray.js.map