/**
 * cloudwatchObservability — Generic AWS CloudWatch Logs adapter.
 *
 * Ships every `AgentfootprintEvent` to a CloudWatch Logs stream. Use
 * when you want agent telemetry alongside the rest of your AWS
 * observability stack — CloudWatch Insights queries, alarms,
 * cross-service correlation. Same SDK as `agentcoreObservability`
 * but **without** the AgentCore-specific defaults (log-stream
 * convention, format opinions). Use this when:
 *
 *   1. You're shipping to CloudWatch but NOT running inside Bedrock
 *      AgentCore (most common case).
 *   2. You want full control over log group / stream / format and
 *      don't need AgentCore's hosted-agent telemetry conventions.
 *
 * Subpath:  `agentfootprint/observability-providers`
 * Peer dep: `@aws-sdk/client-cloudwatch-logs` (OPTIONAL — installed
 *           only when this adapter is used; declared via
 *           `peerDependenciesMeta.{name}.optional = true`).
 *
 * This module also exports the underlying base function used by
 * `agentcoreObservability` — keeps the per-event hot path in one
 * place so improvements (batching, retry, backpressure) flow to
 * every CloudWatch-shaped adapter automatically.
 *
 * @example
 * ```ts
 * import { cloudwatchObservability } from 'agentfootprint/observability-providers';
 * import { microtaskBatchDriver } from 'footprintjs/detach';
 *
 * agent.enable.observability({
 *   strategy: cloudwatchObservability({
 *     region: 'us-east-1',
 *     logGroupName: '/myapp/agent-prod',
 *     logStreamName: `${process.env.HOSTNAME}/${Date.now()}`,
 *   }),
 *   detach: { driver: microtaskBatchDriver, mode: 'forget' },
 * });
 * ```
 */
import { lazyRequire } from '../../lib/lazyRequire.js';
// ─── Generic base — also used by agentcoreObservability ──────────────
/**
 * Internal: shared CloudWatch Logs base used by every adapter that
 * ships to CWL. `cloudwatchObservability` is the public generic
 * factory; `agentcoreObservability` calls this with AgentCore-flavored
 * defaults.
 *
 * Exported for adapter authors only — consumers should call
 * `cloudwatchObservability` or `agentcoreObservability` directly.
 *
 * @internal
 */
export function _buildCloudWatchObservability(opts, strategyName) {
    if (!opts.logGroupName) {
        throw new TypeError(`[${strategyName}Observability] \`logGroupName\` is required. ` +
            `Pass an existing CloudWatch log group, e.g. '/myapp/agent-prod'.`);
    }
    const logStreamName = opts.logStreamName ?? 'agentfootprint';
    const maxBatchEvents = opts.maxBatchEvents ?? 100;
    const maxBatchBytes = opts.maxBatchBytes ?? 10_240;
    const flushIntervalMs = opts.flushIntervalMs ?? 1000;
    // Buffered batch — drained by `flush()` / size-trigger / time-trigger.
    const buffer = [];
    let bufferBytes = 0;
    let lastFlushPromise = Promise.resolve();
    let timer;
    let stopped = false;
    let onErrorHook;
    // Lazy-resolved on first flush so consumers who never trigger a
    // flush (because nothing was emitted) don't even hit the SDK.
    let client = opts._client;
    function ensureClient() {
        if (client)
            return client;
        client = createCloudWatchClient(opts.region, strategyName);
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
        if (buffer.length === 0 || stopped)
            return;
        // Snapshot + clear so concurrent emits during the in-flight put
        // accumulate into the next batch.
        const batch = buffer.splice(0);
        bufferBytes = 0;
        try {
            await ensureClient().putLogEvents({
                logGroupName: opts.logGroupName,
                logStreamName,
                logEvents: batch,
            });
        }
        catch (err) {
            onErrorHook?.(err instanceof Error ? err : new Error(String(err)));
        }
    }
    function enqueue(event) {
        if (stopped)
            return;
        const message = JSON.stringify(event);
        const bytes = Buffer.byteLength(message, 'utf8');
        buffer.push({ timestamp: Date.now(), message });
        bufferBytes += bytes;
        if (buffer.length >= maxBatchEvents || bufferBytes >= maxBatchBytes) {
            // Size trigger — flush immediately. Chain onto last to preserve
            // CloudWatch's per-stream ordering requirement.
            lastFlushPromise = lastFlushPromise.then(doFlush, doFlush);
        }
        else {
            scheduleTimedFlush();
        }
    }
    return {
        name: strategyName,
        capabilities: { events: true, logs: true },
        exportEvent: enqueue,
        async flush() {
            // Drain anything pending. Awaits both an in-flight put AND any
            // newly-buffered events that arrived during it.
            while (buffer.length > 0 || lastFlushPromise !== Promise.resolve()) {
                const before = lastFlushPromise;
                await before;
                if (buffer.length > 0) {
                    lastFlushPromise = doFlush();
                }
                // Loop one more pass if the chained doFlush() queued more
                // work, then bail.
                if (lastFlushPromise === before && buffer.length === 0)
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
            // Capture for use inside doFlush (the strategy doesn't know what
            // the consumer's error sink is unless they wire `_onError` via
            // the strategy options. We store it on this hook so put-failures
            // route correctly).
            onErrorHook =
                onErrorHook ??
                    ((e) => {
                        // eslint-disable-next-line no-console
                        console.error(`[${strategyName}Observability] flush failed:`, e.message);
                    });
            onErrorHook(err, event);
        },
    };
}
// ─── Public factory: cloudwatchObservability ─────────────────────────
/**
 * Generic CloudWatch Logs observability adapter. See
 * `CloudwatchObservabilityOptions` for the per-option contract.
 *
 * For AgentCore-specific conventions, use `agentcoreObservability`
 * which thin-wraps this with AgentCore-flavored defaults.
 */
export function cloudwatchObservability(opts) {
    return _buildCloudWatchObservability(opts, 'cloudwatch');
}
// ─── SDK client construction (lazy) ──────────────────────────────────
function createCloudWatchClient(region, strategyName) {
    let mod;
    try {
        mod = lazyRequire('@aws-sdk/client-cloudwatch-logs');
    }
    catch {
        throw new Error(`[${strategyName}Observability] requires the \`@aws-sdk/client-cloudwatch-logs\` peer dependency.\n` +
            `  Install:  npm install @aws-sdk/client-cloudwatch-logs\n` +
            `  Or pass \`_client\` for test injection.`);
    }
    if (!mod.CloudWatchLogsClient || !mod.PutLogEventsCommand) {
        throw new Error(`[${strategyName}Observability]: \`@aws-sdk/client-cloudwatch-logs\` is installed but ` +
            `\`CloudWatchLogsClient\` / \`PutLogEventsCommand\` was not found. Update the SDK.`);
    }
    const sdkClient = new mod.CloudWatchLogsClient({ ...(region && { region }) });
    return {
        async putLogEvents(input) {
            // Cast the SDK constructor to the call shape — same trick as
            // the memory adapter to stay forward-compat with SDK shape drift.
            const cmd = new mod.PutLogEventsCommand(input);
            await sdkClient.send(cmd);
        },
    };
}
//# sourceMappingURL=cloudwatch.js.map