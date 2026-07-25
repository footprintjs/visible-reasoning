/**
 * Wire each grouped strategy to its data source on the dispatcher /
 * recorder substrate. These are the 4 `enable.*` facades' actual
 * implementations; `RunnerBase.enable` calls them with the right
 * dispatcher / attach handle.
 *
 * Pattern: every facade follows the same shape:
 *
 *   1. Resolve strategy (consumer-supplied OR default)
 *   2. Run `strategy.validate?()` — early-fail on misconfig (New Relic
 *      panel review)
 *   3. Set up subscription / projection
 *   4. Apply per-strategy event-type filter (`relevantEventTypes`)
 *   5. Apply per-call sample rate
 *   6. Wrap calls in try/catch — route errors to `_onError` (passive
 *      recorder rule: never throw to caller)
 *   7. Return Unsubscribe (or handle for lens)
 */
import { flowChart } from 'footprintjs';
import { selectStatus, renderStatusLine, defaultStatusTemplates, } from '../recorders/observability/status/statusTemplates.js';
// Registry-lookup helpers (`getObservabilityStrategy` etc.) are
// defined in `./registry.js` and used by consumers via the
// `enable.*({ vendor, config })` path elsewhere — not used in the
// current attach() implementations, which take `opts.strategy` directly.
/**
 * Sentinel returned when consumer calls `enable.X()` without supplying
 * a strategy or vendor. We DON'T auto-default — that would be an
 * unwelcome opinion. Consumer chose to call `enable.X` but didn't hand
 * us anywhere to ship; just no-op silently and return a stoppable
 * unsubscribe so the call site stays composable.
 */
const NOOP_UNSUBSCRIBE = () => undefined;
/** Build a one-stage flowchart that performs `args.work(event)` and
 *  routes any thrown error to `args.onError`. The driver schedules
 *  this chart per event. */
function buildDetachWrapperChart(args) {
    return flowChart('agentfootprint:detach:wrapper', async (scope) => {
        const event = scope.$getArgs();
        try {
            args.work(event);
        }
        catch (err) {
            args.onError?.(err instanceof Error ? err : new Error(String(err)), event);
        }
    }, 'wrap').build();
}
let detachExecutorSingleton;
/** Lazy-import a shared `FlowChartExecutor` we use purely as the
 *  bare-executor entry point for `detachAndForget` / `detachAndJoinLater`.
 *  No chart actually runs through it — we just need its detach methods. */
async function getDetachExecutor() {
    if (detachExecutorSingleton)
        return detachExecutorSingleton;
    const fp = await import('footprintjs');
    // Trivial host chart — never run, just satisfies the constructor.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const noopHostStage = async () => { };
    const noopChart = fp.flowChart('agentfootprint:detach:host', noopHostStage, 'host').build();
    detachExecutorSingleton = new fp.FlowChartExecutor(noopChart);
    return detachExecutorSingleton;
}
/**
 * Build an event-handling function that respects `opts.detach`.
 *
 *   - `opts.detach` undefined → returns a sync handler that runs
 *     `work(event)` inline and routes errors to `onError`. Same as
 *     pre-v2.8 behavior.
 *
 *   - `opts.detach` set → returns a handler that schedules a wrapper
 *     chart on the driver. `mode === 'forget'` discards the handle;
 *     `mode === 'join-later'` delivers it to `opts.detach.onHandle`.
 *
 * The detached path is async-loaded — the executor singleton is built
 * on first call so consumers who don't enable detach pay zero cost.
 */
function buildEventHandler(detach, args) {
    if (!detach) {
        // Sync path — current behavior.
        return (event) => {
            try {
                args.work(event);
            }
            catch (err) {
                args.onError?.(err instanceof Error ? err : new Error(String(err)), event);
            }
        };
    }
    // Detached path — schedule via the driver. We need the wrapper chart
    // (for the runChild side) and the executor (for the bare-executor
    // entry point that returns / discards the handle).
    const wrapperChart = buildDetachWrapperChart(args);
    const mode = detach.mode ?? 'forget';
    const onHandle = detach.onHandle;
    if (mode === 'join-later' && !onHandle) {
        throw new TypeError(`[enable.*] detach.mode === 'join-later' requires \`onHandle\`. ` +
            `Without it, the returned DetachHandle would be unreachable. ` +
            `Pass \`onHandle: (h) => myHandles.push(h)\` (and await later via ` +
            `Promise.all(myHandles.map(h => h.wait()))).`);
    }
    return (event) => {
        // Lazy-resolve the executor. The Promise here is fire-and-forget
        // itself — we never await it, so the agent loop returns sync. Any
        // error from the import OR the schedule call routes to onError.
        getDetachExecutor()
            .then((exec) => {
            if (mode === 'forget') {
                exec.detachAndForget(detach.driver, wrapperChart, event);
            }
            else {
                const handle = exec.detachAndJoinLater(detach.driver, wrapperChart, event);
                // Caller validates onHandle is set when mode !== 'forget' (see
                // mode-discrimination above; the mode='joinLater' branch requires it).
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                onHandle(handle);
            }
        })
            .catch((err) => {
            args.onError?.(err instanceof Error ? err : new Error(String(err)), event);
        });
    };
}
const TIER_FILTER = {
    minimal: (t) => t.startsWith('agentfootprint.error.') || t.startsWith('agentfootprint.agent.'),
    standard: (t) => !t.startsWith('agentfootprint.stream.token'),
    firehose: () => true,
};
export function attachObservabilityStrategy(dispatcher, opts = {}) {
    const strategy = opts.strategy;
    // Consumer chose to call enable.observability() but didn't supply
    // a strategy. Don't auto-default — that imposes an opinion. Just
    // no-op so the call site stays composable.
    if (!strategy)
        return NOOP_UNSUBSCRIBE;
    strategy.validate?.();
    const tierFilter = TIER_FILTER[opts.tier ?? 'standard'];
    const sampleRate = opts.sampleRate ?? 1;
    const relevant = strategy.relevantEventTypes
        ? new Set(strategy.relevantEventTypes)
        : null;
    // Build the event handler ONCE per attach call. Sync if no
    // `opts.detach`; otherwise schedules on the driver so the agent
    // loop never blocks on slow exporters.
    const handle = buildEventHandler(opts.detach, {
        work: (event) => strategy.exportEvent(event),
        onError: (err, event) => strategy._onError?.(err, event),
    });
    return dispatcher.on('*', (event) => {
        if (!tierFilter(event.type))
            return;
        if (relevant && !relevant.has(event.type))
            return;
        if (sampleRate < 1 && Math.random() > sampleRate)
            return;
        handle(event);
    });
}
/**
 * Subscribe to `agentfootprint.cost.tick` events, project payload into
 * the canonical `CostTick` shape, hand to strategy.
 */
export function attachCostStrategy(dispatcher, opts = {}) {
    const strategy = opts.strategy;
    if (!strategy)
        return NOOP_UNSUBSCRIBE;
    strategy.validate?.();
    // Cost strategy detach mirrors observability — sync by default,
    // schedules on the driver when `opts.detach` is set. Useful when
    // `recordCost` does heavy work (per-tick DB write, vendor budget
    // API, etc.).
    const handle = buildEventHandler(opts.detach, {
        work: (tickInput) => strategy.recordCost(tickInput),
        onError: (err, tickInput) => strategy._onError?.(err, tickInput),
    });
    return dispatcher.on('agentfootprint.cost.tick', (event) => {
        const p = event.payload;
        const tick = {
            cumulativeInputTokens: Number(p.cumulativeInputTokens ?? 0),
            cumulativeOutputTokens: Number(p.cumulativeOutputTokens ?? 0),
            cumulativeCostUsd: Number(p.cumulativeCostUsd ?? 0),
            recentInputTokens: Number(p.recentInputTokens ?? 0),
            recentOutputTokens: Number(p.recentOutputTokens ?? 0),
            recentCostUsd: Number(p.recentCostUsd ?? 0),
            model: String(p.model ?? 'unknown'),
            ...(typeof p.iteration === 'number' ? { iteration: p.iteration } : {}),
            ...(typeof p.runtimeStageId === 'string' ? { runtimeStageId: p.runtimeStageId } : {}),
        };
        handle(tick);
    });
}
/**
 * Subscribe to '*', maintain a rolling event log, project current
 * thinking state on each event, render via templates, hand to strategy.
 *
 * Lower bound on emissions: dedupes — only fires `renderStatus` when
 * the rendered line CHANGES (avoids floods on every token).
 */
/** Sliding-window cap for `attachLiveStatusStrategy`'s internal event
 *  log. Long-lived agent servers would otherwise leak memory through
 *  unbounded growth (per OTel SIG panel review). The cap is high
 *  enough that `selectStatus` always sees the relevant recent
 *  history. */
const LIVE_STATUS_LOG_CAP = 1000;
export function attachLiveStatusStrategy(dispatcher, opts) {
    opts.strategy.validate?.();
    const templates = { ...defaultStatusTemplates, ...(opts.templates ?? {}) };
    const ctx = { appName: opts.appName ?? 'Agent' };
    const eventLog = [];
    let lastLine = null;
    return dispatcher.on('*', (event) => {
        eventLog.push(event);
        // Sliding-window — drop oldest when over cap. O(1) amortized
        // because shift() runs only once per overflow.
        while (eventLog.length > LIVE_STATUS_LOG_CAP)
            eventLog.shift();
        const state = selectStatus(eventLog);
        if (!state) {
            lastLine = null;
            return;
        }
        const line = renderStatusLine(state, ctx, templates);
        if (line === null || line === lastLine)
            return;
        lastLine = line;
        try {
            opts.strategy.renderStatus({ line, state });
        }
        catch (err) {
            opts.strategy._onError?.(err instanceof Error ? err : new Error(String(err)), event);
        }
    });
}
//# sourceMappingURL=attach.js.map