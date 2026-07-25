/**
 * agentfootprint/stream — agent events → Server-Sent Events helpers.
 *
 * Pattern: Adapter (event stream → SSE wire format).
 * Role:    Outer ring. Subscribes to a `Runner`'s `EventDispatcher`
 *          and yields SSE-formatted strings. Drop into any HTTP
 *          framework that accepts an async iterable response body
 *          (Fetch Response, Express res.write, Hono streaming, etc.).
 * Emits:   N/A — observes only.
 */
/**
 * Subscribe to a runner's `EventDispatcher` and yield SSE-formatted
 * strings until the run completes.
 */
export async function* toSSE(runner, options = {}) {
    const filter = options.filter;
    const format = options.format ?? 'full';
    const eventName = options.eventName ?? ((e) => e.type);
    const heartbeatMs = options.heartbeatMs ?? 0;
    // Pull the dispatcher off the runner. RunnerBase exposes it as
    // protected — we cast to access. No public dispatcher() method
    // exists ; runners forward .on/.off via their public API.
    const dispatcher = runner.dispatcher;
    // Bounded queue: events drained as the consumer iterates.
    const queue = [];
    let waiter = null;
    let done = false;
    const wakeup = () => {
        if (waiter) {
            const w = waiter;
            waiter = null;
            w.resolve();
        }
    };
    const unsub = dispatcher.on('*', (event) => {
        if (filter && !filter(event))
            return;
        queue.push(event);
        wakeup();
        // `agent.turn_end` (or composition exit on the outermost runner)
        // ends the stream naturally; the consumer's `for await` finishes
        // when the iterator returns.
        if (event.type === 'agentfootprint.agent.turn_end' ||
            event.type === 'agentfootprint.error.fatal') {
            done = true;
            wakeup();
        }
    });
    let heartbeat;
    if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
            queue.push({ type: '__heartbeat' });
            wakeup();
        }, heartbeatMs);
    }
    try {
        while (!done || queue.length > 0) {
            while (queue.length > 0) {
                // queue.length > 0 guards the shift; result is defined.
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const event = queue.shift();
                if (event.type === '__heartbeat') {
                    yield ': ping\n\n';
                    continue;
                }
                if (format === 'text') {
                    if (event.type === 'agentfootprint.stream.token') {
                        const payload = event.payload;
                        if (payload?.content)
                            yield payload.content;
                    }
                }
                else {
                    yield encodeSSE(eventName(event), event);
                }
            }
            if (done)
                break;
            await new Promise((resolve) => {
                waiter = { resolve };
            });
        }
    }
    finally {
        unsub();
        if (heartbeat)
            clearInterval(heartbeat);
    }
}
/**
 * Class form for consumers who prefer `new SSEFormatter(runner).stream()`.
 * Identical behavior to `toSSE(runner)` — pick by preference.
 */
export class SSEFormatter {
    runner;
    options;
    constructor(runner, options = {}) {
        this.runner = runner;
        this.options = options;
    }
    /** Async iterable of SSE chunks. Consume with `for await`. */
    stream() {
        return toSSE(this.runner, this.options);
    }
}
/**
 * Format any JSON-able payload as a single SSE event chunk.
 *
 * Useful for app-level events outside the runner's typed registry
 * (auth/error frames, app-state echoes). Most consumers won't need this.
 */
export function encodeSSE(eventName, payload) {
    const json = JSON.stringify(payload);
    // Escape newlines inside JSON (rare with stringify) so the data field
    // stays single-line. SSE's data: lines can be repeated, but the
    // canonical encoder keeps it simple.
    return `event: ${eventName}\ndata: ${json}\n\n`;
}
//# sourceMappingURL=stream.js.map