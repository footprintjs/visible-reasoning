/**
 * observer-queue/deferredDispatcher.ts — RFC-001 Block 5: deferred delivery façade.
 *
 * Pattern:  capture → enqueue → (microtask) flush → invoke, with per-listener
 *           error isolation. Composes the whole pure pipeline: MergedQueue
 *           (Block 3, which captures via Block 1) + FlushDriver (Block 4) +
 *           a listener registry with timing/inflight accounting.
 * Role:     The object the engine wiring (Block 6) will hold. Producers call
 *           `capture()` (cheap, never throws, never blocks); listeners
 *           receive envelopes at the next checkpoint, "one beat behind".
 *           Pure module — zero engine imports.
 *
 * Delivery semantics (normative, RFC-001 §5 + amendments A2/A4):
 *   - Per-listener FIFO: every listener sees envelopes in seq order
 *     (invocation order; an async listener's COMPLETION order is its own
 *     concern) — EXCEPT under `'block'` overflow, where a refused enqueue
 *     is delivered inline and overtakes the queued backlog. `seq` always
 *     records true arrival order, so order-sensitive consumers re-sort;
 *     see the `'block'` caveat below.
 *   - Error isolation: a throwing listener (sync) or rejecting listener
 *     (async) never affects siblings or the producer. Both failure modes
 *     route to the injected `onError`; a throwing `onError` is itself
 *     swallowed.
 *   - The flush NEVER awaits a listener. Async continuations are tracked in
 *     an inflight set; `drain({ timeoutMs })` settles them
 *     (`Promise.allSettled` + deadline, shaped like `flushAllDetached`).
 *   - `'block'` overflow: a refused enqueue is delivered synchronously
 *     INLINE from `capture()` — re-introducing blocking delivery by the
 *     consumer's explicit choice. Ordering caveat (documented + tested): an
 *     inline event overtakes the queued backlog — `'block'` trades global
 *     ordering for zero loss and bounded memory. `seq` still tells the
 *     true arrival order.
 *   - Listener registry is idempotent by id (same id replaces, different
 *     ids coexist) — mirrors the repo-wide recorder ID contract. Stats
 *     accumulate per id across replacement; `removeListener` keeps the
 *     id's accumulated stats for post-run reports.
 *   - Events captured BEFORE any listener attaches stay queued — a listener
 *     attached before the next checkpoint still receives the backlog.
 *
 * Per-listener time accounting (amendment A2 — "name the hog"): cumulative
 * `totalMs` and per-checkpoint `lastFlushMs` of SYNC time per listener id —
 * the time that actually blocks the flush. An async listener's continuation
 * time is intentionally not attributed (it does not block delivery).
 */
import { FlushDriver } from './flushDriver.js';
import { MergedQueue } from './mergedQueue.js';
const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function isThenable(value) {
    return typeof value === 'object' && value !== null && typeof value.then === 'function';
}
export class DeferredDispatcher {
    queue;
    driver;
    listeners = new Map();
    listenerStats = new Map();
    /** Tracked async continuations — resolve `true` (ok) / `false` (failed). */
    inflight = new Set();
    onError;
    now;
    inlineDeliveries = 0;
    constructor(opts) {
        this.onError = opts?.onError;
        this.now = opts?.now ?? defaultNow;
        this.queue = new MergedQueue({
            maxQueue: opts?.maxQueue,
            overflow: opts?.overflow,
            sampleEvery: opts?.sampleEvery,
            capturePolicy: opts?.capturePolicy,
            hooks: opts?.hooks,
        });
        this.driver = new FlushDriver({
            depth: () => this.queue.depth,
            processNext: () => this.deliverNext(),
            flushBudgetMs: opts?.flushBudgetMs,
            now: opts?.now,
            schedule: opts?.schedule,
            onFlushStart: () => {
                for (const stats of this.listenerStats.values())
                    stats.lastFlushMs = 0;
            },
        });
    }
    /** Idempotent by id — same id replaces (stats continue), ids coexist. */
    addListener(id, listener) {
        this.listeners.set(id, listener);
        if (!this.listenerStats.has(id)) {
            this.listenerStats.set(id, { events: 0, totalMs: 0, lastFlushMs: 0 });
        }
    }
    /** Stop delivering to `id`. Accumulated stats are kept for reports. */
    removeListener(id) {
        this.listeners.delete(id);
    }
    /**
     * Producer entry point: capture the event (seq-stamped, payload per
     * policy) and stage it for the next checkpoint. Cheap; NEVER throws;
     * never blocks — except under `'block'` overflow, where a refused
     * enqueue is delivered synchronously inline (explicit consumer choice).
     */
    capture(input, policy) {
        const result = this.queue.enqueue(input, policy);
        if (result.outcome === 'queued') {
            this.driver.arm();
            return;
        }
        if (result.outcome === 'inline') {
            this.inlineDeliveries += 1;
            this.deliver(result.envelope);
        }
        // 'dropped': counted by the queue; loss surfaces in stats + seq gaps.
    }
    /**
     * Terminal flush — synchronously deliver everything queued (end of run /
     * shutdown). Async listener continuations are NOT awaited; follow with
     * `drain()` for that.
     */
    flushNow(opts) {
        return this.driver.flushSync(opts);
    }
    /**
     * Flush the backlog, then settle all inflight async continuations —
     * `Promise.allSettled` under a deadline, shaped like `flushAllDetached`.
     * Loops while continuations spawn new captures, until quiescent or the
     * deadline expires.
     */
    async drain(opts) {
        const timeoutMs = opts?.timeoutMs ?? 30_000;
        const startedAt = Date.now();
        let done = 0;
        let failed = 0;
        this.flushNow();
        while (this.inflight.size > 0) {
            const remainingMs = timeoutMs - (Date.now() - startedAt);
            if (remainingMs <= 0)
                return { done, failed, pending: this.inflight.size + this.queue.depth };
            const batch = [...this.inflight];
            let timerId;
            const timeoutPromise = new Promise((resolve) => {
                timerId = setTimeout(() => resolve('__drain_timeout__'), remainingMs);
            });
            const settled = await Promise.race([Promise.allSettled(batch), timeoutPromise]);
            if (timerId !== undefined)
                clearTimeout(timerId);
            if (settled === '__drain_timeout__') {
                return { done, failed, pending: this.inflight.size + this.queue.depth };
            }
            for (const r of settled) {
                // Tracked promises never reject — they resolve true (ok) / false.
                if (r.status === 'fulfilled' && r.value === false)
                    failed += 1;
                else
                    done += 1;
            }
            // Continuations may have captured more events — flush and re-check.
            this.flushNow();
        }
        return { done, failed, pending: this.queue.depth };
    }
    /** A4 — the stats object Block 9 consumes. Pure getter, fresh snapshot. */
    getStats() {
        const counters = this.queue.getCounters();
        const driverStats = this.driver.getStats();
        const perListener = {};
        for (const [id, stats] of this.listenerStats) {
            perListener[id] = { events: stats.events, totalMs: stats.totalMs, lastFlushMs: stats.lastFlushMs };
        }
        return {
            depth: this.queue.depth,
            drops: counters.drops,
            flushes: driverStats.flushes,
            budgetExhausted: driverStats.budgetExhausted,
            p95FlushMs: driverStats.p95FlushMs,
            inlineDeliveries: this.inlineDeliveries,
            inflight: this.inflight.size,
            perListener,
        };
    }
    deliverNext() {
        const envelope = this.queue.shift();
        if (envelope === undefined)
            return;
        this.deliver(envelope);
    }
    /** Invoke every listener with full error isolation + time accounting. */
    deliver(envelope) {
        for (const [id, listener] of this.listeners) {
            const stats = this.listenerStats.get(id);
            const start = this.now();
            try {
                const result = listener(envelope);
                if (isThenable(result))
                    this.track(result, id, envelope);
            }
            catch (error) {
                this.safeOnError(error, { listenerId: id, envelope, phase: 'sync' });
            }
            finally {
                const elapsed = this.now() - start;
                stats.events += 1;
                stats.totalMs += elapsed;
                stats.lastFlushMs += elapsed;
            }
        }
    }
    /** Track an async continuation; route its rejection; never reject. */
    track(promise, listenerId, envelope) {
        const tracked = promise.then(() => true, (error) => {
            this.safeOnError(error, { listenerId, envelope, phase: 'async' });
            return false;
        });
        this.inflight.add(tracked);
        // Self-cleanup — `tracked` never rejects, so this chain cannot float an
        // unhandled rejection.
        tracked.then(() => this.inflight.delete(tracked));
    }
    /** The error sink must never become an error source. */
    safeOnError(error, context) {
        try {
            this.onError?.(error, context);
        }
        catch {
            // Swallow — isolation is absolute.
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVmZXJyZWREaXNwYXRjaGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9vYnNlcnZlci1xdWV1ZS9kZWZlcnJlZERpc3BhdGNoZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0EyQ0c7QUFHSCxPQUFPLEVBQXdCLFdBQVcsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ3JFLE9BQU8sRUFBcUIsV0FBVyxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUF3RmxFLE1BQU0sVUFBVSxHQUFHLEdBQVcsRUFBRSxDQUFDLENBQUMsT0FBTyxXQUFXLEtBQUssV0FBVyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO0FBRXZHLFNBQVMsVUFBVSxDQUFDLEtBQTJCO0lBQzdDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksT0FBUSxLQUF1QixDQUFDLElBQUksS0FBSyxVQUFVLENBQUM7QUFDNUcsQ0FBQztBQUVELE1BQU0sT0FBTyxrQkFBa0I7SUFDWixLQUFLLENBQWM7SUFDbkIsTUFBTSxDQUFjO0lBQ3BCLFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBNEIsQ0FBQztJQUNoRCxhQUFhLEdBQUcsSUFBSSxHQUFHLEVBQWdDLENBQUM7SUFDekUsNEVBQTRFO0lBQzNELFFBQVEsR0FBRyxJQUFJLEdBQUcsRUFBb0IsQ0FBQztJQUN2QyxPQUFPLENBQXdCO0lBQy9CLEdBQUcsQ0FBZTtJQUMzQixnQkFBZ0IsR0FBRyxDQUFDLENBQUM7SUFFN0IsWUFBWSxJQUFnQztRQUMxQyxJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksRUFBRSxPQUFPLENBQUM7UUFDN0IsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLEVBQUUsR0FBRyxJQUFJLFVBQVUsQ0FBQztRQUNuQyxJQUFJLENBQUMsS0FBSyxHQUFHLElBQUksV0FBVyxDQUFDO1lBQzNCLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUTtZQUN4QixRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVE7WUFDeEIsV0FBVyxFQUFFLElBQUksRUFBRSxXQUFXO1lBQzlCLGFBQWEsRUFBRSxJQUFJLEVBQUUsYUFBYTtZQUNsQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUs7U0FDbkIsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLFdBQVcsQ0FBQztZQUM1QixLQUFLLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLO1lBQzdCLFdBQVcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFO1lBQ3JDLGFBQWEsRUFBRSxJQUFJLEVBQUUsYUFBYTtZQUNsQyxHQUFHLEVBQUUsSUFBSSxFQUFFLEdBQUc7WUFDZCxRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVE7WUFDeEIsWUFBWSxFQUFFLEdBQUcsRUFBRTtnQkFDakIsS0FBSyxNQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtvQkFBRSxLQUFLLENBQUMsV0FBVyxHQUFHLENBQUMsQ0FBQztZQUN6RSxDQUFDO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELHlFQUF5RTtJQUN6RSxXQUFXLENBQUMsRUFBVSxFQUFFLFFBQTBCO1FBQ2hELElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsRUFBRSxRQUFRLENBQUMsQ0FBQztRQUNqQyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztZQUNoQyxJQUFJLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxDQUFDLEVBQUUsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDeEUsQ0FBQztJQUNILENBQUM7SUFFRCx1RUFBdUU7SUFDdkUsY0FBYyxDQUFDLEVBQVU7UUFDdkIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDNUIsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0gsT0FBTyxDQUFDLEtBQW1CLEVBQUUsTUFBc0I7UUFDakQsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ2pELElBQUksTUFBTSxDQUFDLE9BQU8sS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNoQyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2xCLE9BQU87UUFDVCxDQUFDO1FBQ0QsSUFBSSxNQUFNLENBQUMsT0FBTyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ2hDLElBQUksQ0FBQyxnQkFBZ0IsSUFBSSxDQUFDLENBQUM7WUFDM0IsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDaEMsQ0FBQztRQUNELHNFQUFzRTtJQUN4RSxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILFFBQVEsQ0FBQyxJQUE2QjtRQUNwQyxPQUFPLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3JDLENBQUM7SUFFRDs7Ozs7T0FLRztJQUNILEtBQUssQ0FBQyxLQUFLLENBQUMsSUFBNkI7UUFDdkMsTUFBTSxTQUFTLEdBQUcsSUFBSSxFQUFFLFNBQVMsSUFBSSxNQUFNLENBQUM7UUFDNUMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQzdCLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQztRQUNiLElBQUksTUFBTSxHQUFHLENBQUMsQ0FBQztRQUVmLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNoQixPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzlCLE1BQU0sV0FBVyxHQUFHLFNBQVMsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxTQUFTLENBQUMsQ0FBQztZQUN6RCxJQUFJLFdBQVcsSUFBSSxDQUFDO2dCQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBRTlGLE1BQU0sS0FBSyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDakMsSUFBSSxPQUFrRCxDQUFDO1lBQ3ZELE1BQU0sY0FBYyxHQUFHLElBQUksT0FBTyxDQUFzQixDQUFDLE9BQU8sRUFBRSxFQUFFO2dCQUNsRSxPQUFPLEdBQUcsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLE9BQU8sQ0FBQyxtQkFBbUIsQ0FBQyxFQUFFLFdBQVcsQ0FBQyxDQUFDO1lBQ3hFLENBQUMsQ0FBQyxDQUFDO1lBQ0gsTUFBTSxPQUFPLEdBQUcsTUFBTSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsRUFBRSxjQUFjLENBQUMsQ0FBQyxDQUFDO1lBQ2hGLElBQUksT0FBTyxLQUFLLFNBQVM7Z0JBQUUsWUFBWSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ2pELElBQUksT0FBTyxLQUFLLG1CQUFtQixFQUFFLENBQUM7Z0JBQ3BDLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQzFFLENBQUM7WUFDRCxLQUFLLE1BQU0sQ0FBQyxJQUFJLE9BQU8sRUFBRSxDQUFDO2dCQUN4QixrRUFBa0U7Z0JBQ2xFLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxXQUFXLElBQUksQ0FBQyxDQUFDLEtBQUssS0FBSyxLQUFLO29CQUFFLE1BQU0sSUFBSSxDQUFDLENBQUM7O29CQUMxRCxJQUFJLElBQUksQ0FBQyxDQUFDO1lBQ2pCLENBQUM7WUFDRCxvRUFBb0U7WUFDcEUsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ2xCLENBQUM7UUFDRCxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNyRCxDQUFDO0lBRUQsMkVBQTJFO0lBQzNFLFFBQVE7UUFDTixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQzFDLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDM0MsTUFBTSxXQUFXLEdBQWtDLEVBQUUsQ0FBQztRQUN0RCxLQUFLLE1BQU0sQ0FBQyxFQUFFLEVBQUUsS0FBSyxDQUFDLElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQzdDLFdBQVcsQ0FBQyxFQUFFLENBQUMsR0FBRyxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxFQUFFLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVyxFQUFFLENBQUM7UUFDckcsQ0FBQztRQUNELE9BQU87WUFDTCxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLO1lBQ3ZCLEtBQUssRUFBRSxRQUFRLENBQUMsS0FBSztZQUNyQixPQUFPLEVBQUUsV0FBVyxDQUFDLE9BQU87WUFDNUIsZUFBZSxFQUFFLFdBQVcsQ0FBQyxlQUFlO1lBQzVDLFVBQVUsRUFBRSxXQUFXLENBQUMsVUFBVTtZQUNsQyxnQkFBZ0IsRUFBRSxJQUFJLENBQUMsZ0JBQWdCO1lBQ3ZDLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUk7WUFDNUIsV0FBVztTQUNaLENBQUM7SUFDSixDQUFDO0lBRU8sV0FBVztRQUNqQixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ3BDLElBQUksUUFBUSxLQUFLLFNBQVM7WUFBRSxPQUFPO1FBQ25DLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUVELHlFQUF5RTtJQUNqRSxPQUFPLENBQUMsUUFBeUI7UUFDdkMsS0FBSyxNQUFNLENBQUMsRUFBRSxFQUFFLFFBQVEsQ0FBQyxJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUM1QyxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQXlCLENBQUM7WUFDakUsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3pCLElBQUksQ0FBQztnQkFDSCxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ2xDLElBQUksVUFBVSxDQUFDLE1BQU0sQ0FBQztvQkFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxFQUFFLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDM0QsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ2YsSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLEVBQUUsRUFBRSxVQUFVLEVBQUUsRUFBRSxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztZQUN2RSxDQUFDO29CQUFTLENBQUM7Z0JBQ1QsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLEtBQUssQ0FBQztnQkFDbkMsS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUM7Z0JBQ2xCLEtBQUssQ0FBQyxPQUFPLElBQUksT0FBTyxDQUFDO2dCQUN6QixLQUFLLENBQUMsV0FBVyxJQUFJLE9BQU8sQ0FBQztZQUMvQixDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7SUFFRCxzRUFBc0U7SUFDOUQsS0FBSyxDQUFDLE9BQXNCLEVBQUUsVUFBa0IsRUFBRSxRQUF5QjtRQUNqRixNQUFNLE9BQU8sR0FBcUIsT0FBTyxDQUFDLElBQUksQ0FDNUMsR0FBRyxFQUFFLENBQUMsSUFBSSxFQUNWLENBQUMsS0FBSyxFQUFFLEVBQUU7WUFDUixJQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssRUFBRSxFQUFFLFVBQVUsRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxDQUFDLENBQUM7WUFDbEUsT0FBTyxLQUFLLENBQUM7UUFDZixDQUFDLENBQ0YsQ0FBQztRQUNGLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzNCLHdFQUF3RTtRQUN4RSx1QkFBdUI7UUFDdkIsT0FBTyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQ3BELENBQUM7SUFFRCx3REFBd0Q7SUFDaEQsV0FBVyxDQUFDLEtBQWMsRUFBRSxPQUE2QjtRQUMvRCxJQUFJLENBQUM7WUFDSCxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBQ2pDLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDUCxtQ0FBbUM7UUFDckMsQ0FBQztJQUNILENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogb2JzZXJ2ZXItcXVldWUvZGVmZXJyZWREaXNwYXRjaGVyLnRzIOKAlCBSRkMtMDAxIEJsb2NrIDU6IGRlZmVycmVkIGRlbGl2ZXJ5IGZhw6dhZGUuXG4gKlxuICogUGF0dGVybjogIGNhcHR1cmUg4oaSIGVucXVldWUg4oaSIChtaWNyb3Rhc2spIGZsdXNoIOKGkiBpbnZva2UsIHdpdGggcGVyLWxpc3RlbmVyXG4gKiAgICAgICAgICAgZXJyb3IgaXNvbGF0aW9uLiBDb21wb3NlcyB0aGUgd2hvbGUgcHVyZSBwaXBlbGluZTogTWVyZ2VkUXVldWVcbiAqICAgICAgICAgICAoQmxvY2sgMywgd2hpY2ggY2FwdHVyZXMgdmlhIEJsb2NrIDEpICsgRmx1c2hEcml2ZXIgKEJsb2NrIDQpICtcbiAqICAgICAgICAgICBhIGxpc3RlbmVyIHJlZ2lzdHJ5IHdpdGggdGltaW5nL2luZmxpZ2h0IGFjY291bnRpbmcuXG4gKiBSb2xlOiAgICAgVGhlIG9iamVjdCB0aGUgZW5naW5lIHdpcmluZyAoQmxvY2sgNikgd2lsbCBob2xkLiBQcm9kdWNlcnMgY2FsbFxuICogICAgICAgICAgIGBjYXB0dXJlKClgIChjaGVhcCwgbmV2ZXIgdGhyb3dzLCBuZXZlciBibG9ja3MpOyBsaXN0ZW5lcnNcbiAqICAgICAgICAgICByZWNlaXZlIGVudmVsb3BlcyBhdCB0aGUgbmV4dCBjaGVja3BvaW50LCBcIm9uZSBiZWF0IGJlaGluZFwiLlxuICogICAgICAgICAgIFB1cmUgbW9kdWxlIOKAlCB6ZXJvIGVuZ2luZSBpbXBvcnRzLlxuICpcbiAqIERlbGl2ZXJ5IHNlbWFudGljcyAobm9ybWF0aXZlLCBSRkMtMDAxIMKnNSArIGFtZW5kbWVudHMgQTIvQTQpOlxuICogICAtIFBlci1saXN0ZW5lciBGSUZPOiBldmVyeSBsaXN0ZW5lciBzZWVzIGVudmVsb3BlcyBpbiBzZXEgb3JkZXJcbiAqICAgICAoaW52b2NhdGlvbiBvcmRlcjsgYW4gYXN5bmMgbGlzdGVuZXIncyBDT01QTEVUSU9OIG9yZGVyIGlzIGl0cyBvd25cbiAqICAgICBjb25jZXJuKSDigJQgRVhDRVBUIHVuZGVyIGAnYmxvY2snYCBvdmVyZmxvdywgd2hlcmUgYSByZWZ1c2VkIGVucXVldWVcbiAqICAgICBpcyBkZWxpdmVyZWQgaW5saW5lIGFuZCBvdmVydGFrZXMgdGhlIHF1ZXVlZCBiYWNrbG9nLiBgc2VxYCBhbHdheXNcbiAqICAgICByZWNvcmRzIHRydWUgYXJyaXZhbCBvcmRlciwgc28gb3JkZXItc2Vuc2l0aXZlIGNvbnN1bWVycyByZS1zb3J0O1xuICogICAgIHNlZSB0aGUgYCdibG9jaydgIGNhdmVhdCBiZWxvdy5cbiAqICAgLSBFcnJvciBpc29sYXRpb246IGEgdGhyb3dpbmcgbGlzdGVuZXIgKHN5bmMpIG9yIHJlamVjdGluZyBsaXN0ZW5lclxuICogICAgIChhc3luYykgbmV2ZXIgYWZmZWN0cyBzaWJsaW5ncyBvciB0aGUgcHJvZHVjZXIuIEJvdGggZmFpbHVyZSBtb2Rlc1xuICogICAgIHJvdXRlIHRvIHRoZSBpbmplY3RlZCBgb25FcnJvcmA7IGEgdGhyb3dpbmcgYG9uRXJyb3JgIGlzIGl0c2VsZlxuICogICAgIHN3YWxsb3dlZC5cbiAqICAgLSBUaGUgZmx1c2ggTkVWRVIgYXdhaXRzIGEgbGlzdGVuZXIuIEFzeW5jIGNvbnRpbnVhdGlvbnMgYXJlIHRyYWNrZWQgaW5cbiAqICAgICBhbiBpbmZsaWdodCBzZXQ7IGBkcmFpbih7IHRpbWVvdXRNcyB9KWAgc2V0dGxlcyB0aGVtXG4gKiAgICAgKGBQcm9taXNlLmFsbFNldHRsZWRgICsgZGVhZGxpbmUsIHNoYXBlZCBsaWtlIGBmbHVzaEFsbERldGFjaGVkYCkuXG4gKiAgIC0gYCdibG9jaydgIG92ZXJmbG93OiBhIHJlZnVzZWQgZW5xdWV1ZSBpcyBkZWxpdmVyZWQgc3luY2hyb25vdXNseVxuICogICAgIElOTElORSBmcm9tIGBjYXB0dXJlKClgIOKAlCByZS1pbnRyb2R1Y2luZyBibG9ja2luZyBkZWxpdmVyeSBieSB0aGVcbiAqICAgICBjb25zdW1lcidzIGV4cGxpY2l0IGNob2ljZS4gT3JkZXJpbmcgY2F2ZWF0IChkb2N1bWVudGVkICsgdGVzdGVkKTogYW5cbiAqICAgICBpbmxpbmUgZXZlbnQgb3ZlcnRha2VzIHRoZSBxdWV1ZWQgYmFja2xvZyDigJQgYCdibG9jaydgIHRyYWRlcyBnbG9iYWxcbiAqICAgICBvcmRlcmluZyBmb3IgemVybyBsb3NzIGFuZCBib3VuZGVkIG1lbW9yeS4gYHNlcWAgc3RpbGwgdGVsbHMgdGhlXG4gKiAgICAgdHJ1ZSBhcnJpdmFsIG9yZGVyLlxuICogICAtIExpc3RlbmVyIHJlZ2lzdHJ5IGlzIGlkZW1wb3RlbnQgYnkgaWQgKHNhbWUgaWQgcmVwbGFjZXMsIGRpZmZlcmVudFxuICogICAgIGlkcyBjb2V4aXN0KSDigJQgbWlycm9ycyB0aGUgcmVwby13aWRlIHJlY29yZGVyIElEIGNvbnRyYWN0LiBTdGF0c1xuICogICAgIGFjY3VtdWxhdGUgcGVyIGlkIGFjcm9zcyByZXBsYWNlbWVudDsgYHJlbW92ZUxpc3RlbmVyYCBrZWVwcyB0aGVcbiAqICAgICBpZCdzIGFjY3VtdWxhdGVkIHN0YXRzIGZvciBwb3N0LXJ1biByZXBvcnRzLlxuICogICAtIEV2ZW50cyBjYXB0dXJlZCBCRUZPUkUgYW55IGxpc3RlbmVyIGF0dGFjaGVzIHN0YXkgcXVldWVkIOKAlCBhIGxpc3RlbmVyXG4gKiAgICAgYXR0YWNoZWQgYmVmb3JlIHRoZSBuZXh0IGNoZWNrcG9pbnQgc3RpbGwgcmVjZWl2ZXMgdGhlIGJhY2tsb2cuXG4gKlxuICogUGVyLWxpc3RlbmVyIHRpbWUgYWNjb3VudGluZyAoYW1lbmRtZW50IEEyIOKAlCBcIm5hbWUgdGhlIGhvZ1wiKTogY3VtdWxhdGl2ZVxuICogYHRvdGFsTXNgIGFuZCBwZXItY2hlY2twb2ludCBgbGFzdEZsdXNoTXNgIG9mIFNZTkMgdGltZSBwZXIgbGlzdGVuZXIgaWQg4oCUXG4gKiB0aGUgdGltZSB0aGF0IGFjdHVhbGx5IGJsb2NrcyB0aGUgZmx1c2guIEFuIGFzeW5jIGxpc3RlbmVyJ3MgY29udGludWF0aW9uXG4gKiB0aW1lIGlzIGludGVudGlvbmFsbHkgbm90IGF0dHJpYnV0ZWQgKGl0IGRvZXMgbm90IGJsb2NrIGRlbGl2ZXJ5KS5cbiAqL1xuXG5pbXBvcnQgeyB0eXBlIENhcHR1cmVFbnZlbG9wZSwgdHlwZSBDYXB0dXJlSG9va3MsIHR5cGUgQ2FwdHVyZVBvbGljeSB9IGZyb20gJy4uL2NhcHR1cmUvZW52ZWxvcGUuanMnO1xuaW1wb3J0IHsgdHlwZSBGbHVzaFN5bmNSZXN1bHQsIEZsdXNoRHJpdmVyIH0gZnJvbSAnLi9mbHVzaERyaXZlci5qcyc7XG5pbXBvcnQgeyB0eXBlIEVucXVldWVJbnB1dCwgTWVyZ2VkUXVldWUgfSBmcm9tICcuL21lcmdlZFF1ZXVlLmpzJztcbmltcG9ydCB7IHR5cGUgT3ZlcmZsb3dQb2xpY3kgfSBmcm9tICcuL3JpbmcuanMnO1xuXG4vKipcbiAqIE9uZSBkZWZlcnJlZCBvYnNlcnZlci4gTWF5IHJldHVybiBhIFByb21pc2Ug4oCUIHRoZSBkaXNwYXRjaGVyIHRyYWNrcyBpdCBpblxuICogdGhlIGluZmxpZ2h0IHNldCBidXQgTkVWRVIgYXdhaXRzIGl0IGR1cmluZyBhIGZsdXNoLlxuICovXG5leHBvcnQgdHlwZSBEZWZlcnJlZExpc3RlbmVyID0gKGVudmVsb3BlOiBDYXB0dXJlRW52ZWxvcGUpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIERpc3BhdGNoRXJyb3JDb250ZXh0IHtcbiAgcmVhZG9ubHkgbGlzdGVuZXJJZDogc3RyaW5nO1xuICByZWFkb25seSBlbnZlbG9wZTogQ2FwdHVyZUVudmVsb3BlO1xuICAvKiogYCdzeW5jJ2AgPSBsaXN0ZW5lciB0aHJldzsgYCdhc3luYydgID0gcmV0dXJuZWQgcHJvbWlzZSByZWplY3RlZC4gKi9cbiAgcmVhZG9ubHkgcGhhc2U6ICdzeW5jJyB8ICdhc3luYyc7XG59XG5cbi8qKiBJbmplY3RlZCBlcnJvciBzaW5rIOKAlCB0aGUgd2lyaW5nIGxheWVyIHJvdXRlcyB0aGVzZSAoQmxvY2sgNikuICovXG5leHBvcnQgdHlwZSBEaXNwYXRjaEVycm9ySGFuZGxlciA9IChlcnJvcjogdW5rbm93biwgY29udGV4dDogRGlzcGF0Y2hFcnJvckNvbnRleHQpID0+IHZvaWQ7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVmZXJyZWREaXNwYXRjaGVyT3B0aW9ucyB7XG4gIC8qKiBRdWV1ZSBib3VuZCDigJQgZGVmYXVsdCAxMCAwMDAgKHNlZSBgTWVyZ2VkUXVldWVgKS4gKi9cbiAgcmVhZG9ubHkgbWF4UXVldWU/OiBudW1iZXI7XG4gIC8qKiBPdmVyZmxvdyBwb2xpY3kg4oCUIGRlZmF1bHQgYCdkcm9wLW9sZGVzdCdgLiAqL1xuICByZWFkb25seSBvdmVyZmxvdz86IE92ZXJmbG93UG9saWN5O1xuICAvKiogYCdzYW1wbGUnYCBvdmVyZmxvdyBvbmx5IOKAlCBhZG1pdCAxIGluIHRoaXMgbWFueSBzYXR1cmF0ZWQgYXJyaXZhbHMuICovXG4gIHJlYWRvbmx5IHNhbXBsZUV2ZXJ5PzogbnVtYmVyO1xuICAvKiogRGVmYXVsdCBjYXB0dXJlIHBvbGljeSDigJQgZGVmYXVsdCBgJ3N1bW1hcnknYC4gKi9cbiAgcmVhZG9ubHkgY2FwdHVyZVBvbGljeT86IENhcHR1cmVQb2xpY3k7XG4gIC8qKiBQZXItZmx1c2ggdGltZSBidWRnZXQsIG1zIChBMSkg4oCUIGRlZmF1bHQgMjsgYEluZmluaXR5YCA9IGZ1bGwgZHJhaW4uICovXG4gIHJlYWRvbmx5IGZsdXNoQnVkZ2V0TXM/OiBudW1iZXI7XG4gIC8qKiBMaXN0ZW5lci1mYWlsdXJlIHNpbmsuIE5vIGRlZmF1bHQg4oCUIHdpdGhvdXQgaXQsIGZhaWx1cmVzIGFyZSBzaWxlbnQuICovXG4gIHJlYWRvbmx5IG9uRXJyb3I/OiBEaXNwYXRjaEVycm9ySGFuZGxlcjtcbiAgLyoqIENhcHR1cmUgc2VhbXMgKGRldi13YXJuLCBjYXB0dXJlZEF0IGNsb2NrKSDigJQgc2VlIGBDYXB0dXJlSG9va3NgLiAqL1xuICByZWFkb25seSBob29rcz86IENhcHR1cmVIb29rcztcbiAgLyoqIFRpbWluZyBjbG9jayBmb3IgYnVkZ2V0ICsgcGVyLWxpc3RlbmVyIGFjY291bnRpbmcuIEluamVjdGFibGUuICovXG4gIHJlYWRvbmx5IG5vdz86ICgpID0+IG51bWJlcjtcbiAgLyoqIENoZWNrcG9pbnQgcHJpbWl0aXZlIOKAlCBkZWZhdWx0IGBxdWV1ZU1pY3JvdGFza2AuIEluamVjdGFibGUuICovXG4gIHJlYWRvbmx5IHNjaGVkdWxlPzogKGNiOiAoKSA9PiB2b2lkKSA9PiB2b2lkO1xufVxuXG4vKiogUGVyLWxpc3RlbmVyIGFjY291bnRpbmcgKEEyL0E0KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGlzdGVuZXJTdGF0cyB7XG4gIC8qKiBFbnZlbG9wZXMgZGVsaXZlcmVkIChpbnZvY2F0aW9ucywgaW5jbHVkaW5nIG9uZXMgdGhhdCB0aHJldykuICovXG4gIHJlYWRvbmx5IGV2ZW50czogbnVtYmVyO1xuICAvKiogQ3VtdWxhdGl2ZSBzeW5jIGRlbGl2ZXJ5IHRpbWUsIG1zLiAqL1xuICByZWFkb25seSB0b3RhbE1zOiBudW1iZXI7XG4gIC8qKiBTeW5jIGRlbGl2ZXJ5IHRpbWUgc2luY2UgdGhlIGxhc3QgZmx1c2ggc3RhcnRlZCwgbXMuICovXG4gIHJlYWRvbmx5IGxhc3RGbHVzaE1zOiBudW1iZXI7XG59XG5cbi8qKiBUaGUgQmxvY2sgOSBvYnNlcnZhYmlsaXR5IHN1cmZhY2UgKGFtZW5kbWVudCBBNCkg4oCUIHB1cmUgZ2V0dGVyLiAqL1xuZXhwb3J0IGludGVyZmFjZSBEaXNwYXRjaGVyU3RhdHMge1xuICAvKiogQ3VycmVudCBiYWNrbG9nLiAqL1xuICByZWFkb25seSBkZXB0aDogbnVtYmVyO1xuICAvKiogRXZlbnRzIExPU1QgKG92ZXJmbG93KSDigJQgbmV2ZXIgc2lsZW50OyBhbHNvIHZpc2libGUgYXMgc2VxIGdhcHMuICovXG4gIHJlYWRvbmx5IGRyb3BzOiBudW1iZXI7XG4gIC8qKiBDb21wbGV0ZWQgY2hlY2twb2ludCBmbHVzaGVzLiAqL1xuICByZWFkb25seSBmbHVzaGVzOiBudW1iZXI7XG4gIC8qKiBGbHVzaGVzIGN1dCBzaG9ydCBieSBgZmx1c2hCdWRnZXRNc2AgKEExKS4gKi9cbiAgcmVhZG9ubHkgYnVkZ2V0RXhoYXVzdGVkOiBudW1iZXI7XG4gIC8qKiBwOTUgZmx1c2ggZHVyYXRpb24sIG1zIChyb2xsaW5nIHdpbmRvdykuICovXG4gIHJlYWRvbmx5IHA5NUZsdXNoTXM6IG51bWJlcjtcbiAgLyoqIGAnYmxvY2snYC1wb2xpY3kgcmVmdXNhbHMgZGVsaXZlcmVkIHN5bmNocm9ub3VzbHkgaW5saW5lLiAqL1xuICByZWFkb25seSBpbmxpbmVEZWxpdmVyaWVzOiBudW1iZXI7XG4gIC8qKiBBc3luYyBsaXN0ZW5lciBjb250aW51YXRpb25zIG5vdCB5ZXQgc2V0dGxlZC4gKi9cbiAgcmVhZG9ubHkgaW5mbGlnaHQ6IG51bWJlcjtcbiAgLyoqIFBlci1saXN0ZW5lciB0aW1lIGFjY291bnRpbmcg4oCUIFwibmFtZSB0aGUgaG9nXCIgKEEyKS4gKi9cbiAgcmVhZG9ubHkgcGVyTGlzdGVuZXI6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIExpc3RlbmVyU3RhdHM+Pjtcbn1cblxuLyoqIFJlc3VsdCBvZiB7QGxpbmsgRGVmZXJyZWREaXNwYXRjaGVyLmRyYWlufSDigJQgYGZsdXNoQWxsRGV0YWNoZWRgIHNoYXBlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBEcmFpblJlc3VsdCB7XG4gIC8qKiBBc3luYyBjb250aW51YXRpb25zIHNlZW4gc2V0dGxpbmcgZnVsZmlsbGVkLiBCZXN0LWVmZm9ydCBjb3VudCDigJQgYVxuICAgKiAgY29udGludWF0aW9uIHRoYXQgc2V0dGxlcyBiZXR3ZWVuIGNoZWNrcyBpcyBkcmFpbmVkIGJ1dCBtYXkgbm90IGJlXG4gICAqICBjb3VudGVkIChzYW1lIHNlbWFudGljcyBhcyBgZmx1c2hBbGxEZXRhY2hlZGApLiAqL1xuICByZWFkb25seSBkb25lOiBudW1iZXI7XG4gIC8qKiBDb250aW51YXRpb25zIHdob3NlIGxpc3RlbmVyIHByb21pc2UgcmVqZWN0ZWQgKHJvdXRlZCB0byBvbkVycm9yKS4gKi9cbiAgcmVhZG9ubHkgZmFpbGVkOiBudW1iZXI7XG4gIC8qKiBTdGlsbCBpbiBmbGlnaHQgKG9yIHF1ZXVlZCkgd2hlbiB0aGUgZGVhZGxpbmUgZXhwaXJlZC4gYDBgID0gZHJhaW5lZC4gKi9cbiAgcmVhZG9ubHkgcGVuZGluZzogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTXV0YWJsZUxpc3RlbmVyU3RhdHMge1xuICBldmVudHM6IG51bWJlcjtcbiAgdG90YWxNczogbnVtYmVyO1xuICBsYXN0Rmx1c2hNczogbnVtYmVyO1xufVxuXG5jb25zdCBkZWZhdWx0Tm93ID0gKCk6IG51bWJlciA9PiAodHlwZW9mIHBlcmZvcm1hbmNlICE9PSAndW5kZWZpbmVkJyA/IHBlcmZvcm1hbmNlLm5vdygpIDogRGF0ZS5ub3coKSk7XG5cbmZ1bmN0aW9uIGlzVGhlbmFibGUodmFsdWU6IHZvaWQgfCBQcm9taXNlPHZvaWQ+KTogdmFsdWUgaXMgUHJvbWlzZTx2b2lkPiB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiAodmFsdWUgYXMgUHJvbWlzZTx2b2lkPikudGhlbiA9PT0gJ2Z1bmN0aW9uJztcbn1cblxuZXhwb3J0IGNsYXNzIERlZmVycmVkRGlzcGF0Y2hlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcXVldWU6IE1lcmdlZFF1ZXVlO1xuICBwcml2YXRlIHJlYWRvbmx5IGRyaXZlcjogRmx1c2hEcml2ZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgbGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsIERlZmVycmVkTGlzdGVuZXI+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgbGlzdGVuZXJTdGF0cyA9IG5ldyBNYXA8c3RyaW5nLCBNdXRhYmxlTGlzdGVuZXJTdGF0cz4oKTtcbiAgLyoqIFRyYWNrZWQgYXN5bmMgY29udGludWF0aW9ucyDigJQgcmVzb2x2ZSBgdHJ1ZWAgKG9rKSAvIGBmYWxzZWAgKGZhaWxlZCkuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgaW5mbGlnaHQgPSBuZXcgU2V0PFByb21pc2U8Ym9vbGVhbj4+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgb25FcnJvcj86IERpc3BhdGNoRXJyb3JIYW5kbGVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG5vdzogKCkgPT4gbnVtYmVyO1xuICBwcml2YXRlIGlubGluZURlbGl2ZXJpZXMgPSAwO1xuXG4gIGNvbnN0cnVjdG9yKG9wdHM/OiBEZWZlcnJlZERpc3BhdGNoZXJPcHRpb25zKSB7XG4gICAgdGhpcy5vbkVycm9yID0gb3B0cz8ub25FcnJvcjtcbiAgICB0aGlzLm5vdyA9IG9wdHM/Lm5vdyA/PyBkZWZhdWx0Tm93O1xuICAgIHRoaXMucXVldWUgPSBuZXcgTWVyZ2VkUXVldWUoe1xuICAgICAgbWF4UXVldWU6IG9wdHM/Lm1heFF1ZXVlLFxuICAgICAgb3ZlcmZsb3c6IG9wdHM/Lm92ZXJmbG93LFxuICAgICAgc2FtcGxlRXZlcnk6IG9wdHM/LnNhbXBsZUV2ZXJ5LFxuICAgICAgY2FwdHVyZVBvbGljeTogb3B0cz8uY2FwdHVyZVBvbGljeSxcbiAgICAgIGhvb2tzOiBvcHRzPy5ob29rcyxcbiAgICB9KTtcbiAgICB0aGlzLmRyaXZlciA9IG5ldyBGbHVzaERyaXZlcih7XG4gICAgICBkZXB0aDogKCkgPT4gdGhpcy5xdWV1ZS5kZXB0aCxcbiAgICAgIHByb2Nlc3NOZXh0OiAoKSA9PiB0aGlzLmRlbGl2ZXJOZXh0KCksXG4gICAgICBmbHVzaEJ1ZGdldE1zOiBvcHRzPy5mbHVzaEJ1ZGdldE1zLFxuICAgICAgbm93OiBvcHRzPy5ub3csXG4gICAgICBzY2hlZHVsZTogb3B0cz8uc2NoZWR1bGUsXG4gICAgICBvbkZsdXNoU3RhcnQ6ICgpID0+IHtcbiAgICAgICAgZm9yIChjb25zdCBzdGF0cyBvZiB0aGlzLmxpc3RlbmVyU3RhdHMudmFsdWVzKCkpIHN0YXRzLmxhc3RGbHVzaE1zID0gMDtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKiogSWRlbXBvdGVudCBieSBpZCDigJQgc2FtZSBpZCByZXBsYWNlcyAoc3RhdHMgY29udGludWUpLCBpZHMgY29leGlzdC4gKi9cbiAgYWRkTGlzdGVuZXIoaWQ6IHN0cmluZywgbGlzdGVuZXI6IERlZmVycmVkTGlzdGVuZXIpOiB2b2lkIHtcbiAgICB0aGlzLmxpc3RlbmVycy5zZXQoaWQsIGxpc3RlbmVyKTtcbiAgICBpZiAoIXRoaXMubGlzdGVuZXJTdGF0cy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLmxpc3RlbmVyU3RhdHMuc2V0KGlkLCB7IGV2ZW50czogMCwgdG90YWxNczogMCwgbGFzdEZsdXNoTXM6IDAgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFN0b3AgZGVsaXZlcmluZyB0byBgaWRgLiBBY2N1bXVsYXRlZCBzdGF0cyBhcmUga2VwdCBmb3IgcmVwb3J0cy4gKi9cbiAgcmVtb3ZlTGlzdGVuZXIoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubGlzdGVuZXJzLmRlbGV0ZShpZCk7XG4gIH1cblxuICAvKipcbiAgICogUHJvZHVjZXIgZW50cnkgcG9pbnQ6IGNhcHR1cmUgdGhlIGV2ZW50IChzZXEtc3RhbXBlZCwgcGF5bG9hZCBwZXJcbiAgICogcG9saWN5KSBhbmQgc3RhZ2UgaXQgZm9yIHRoZSBuZXh0IGNoZWNrcG9pbnQuIENoZWFwOyBORVZFUiB0aHJvd3M7XG4gICAqIG5ldmVyIGJsb2NrcyDigJQgZXhjZXB0IHVuZGVyIGAnYmxvY2snYCBvdmVyZmxvdywgd2hlcmUgYSByZWZ1c2VkXG4gICAqIGVucXVldWUgaXMgZGVsaXZlcmVkIHN5bmNocm9ub3VzbHkgaW5saW5lIChleHBsaWNpdCBjb25zdW1lciBjaG9pY2UpLlxuICAgKi9cbiAgY2FwdHVyZShpbnB1dDogRW5xdWV1ZUlucHV0LCBwb2xpY3k/OiBDYXB0dXJlUG9saWN5KTogdm9pZCB7XG4gICAgY29uc3QgcmVzdWx0ID0gdGhpcy5xdWV1ZS5lbnF1ZXVlKGlucHV0LCBwb2xpY3kpO1xuICAgIGlmIChyZXN1bHQub3V0Y29tZSA9PT0gJ3F1ZXVlZCcpIHtcbiAgICAgIHRoaXMuZHJpdmVyLmFybSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVzdWx0Lm91dGNvbWUgPT09ICdpbmxpbmUnKSB7XG4gICAgICB0aGlzLmlubGluZURlbGl2ZXJpZXMgKz0gMTtcbiAgICAgIHRoaXMuZGVsaXZlcihyZXN1bHQuZW52ZWxvcGUpO1xuICAgIH1cbiAgICAvLyAnZHJvcHBlZCc6IGNvdW50ZWQgYnkgdGhlIHF1ZXVlOyBsb3NzIHN1cmZhY2VzIGluIHN0YXRzICsgc2VxIGdhcHMuXG4gIH1cblxuICAvKipcbiAgICogVGVybWluYWwgZmx1c2gg4oCUIHN5bmNocm9ub3VzbHkgZGVsaXZlciBldmVyeXRoaW5nIHF1ZXVlZCAoZW5kIG9mIHJ1biAvXG4gICAqIHNodXRkb3duKS4gQXN5bmMgbGlzdGVuZXIgY29udGludWF0aW9ucyBhcmUgTk9UIGF3YWl0ZWQ7IGZvbGxvdyB3aXRoXG4gICAqIGBkcmFpbigpYCBmb3IgdGhhdC5cbiAgICovXG4gIGZsdXNoTm93KG9wdHM/OiB7IG1heFJvdW5kcz86IG51bWJlciB9KTogRmx1c2hTeW5jUmVzdWx0IHtcbiAgICByZXR1cm4gdGhpcy5kcml2ZXIuZmx1c2hTeW5jKG9wdHMpO1xuICB9XG5cbiAgLyoqXG4gICAqIEZsdXNoIHRoZSBiYWNrbG9nLCB0aGVuIHNldHRsZSBhbGwgaW5mbGlnaHQgYXN5bmMgY29udGludWF0aW9ucyDigJRcbiAgICogYFByb21pc2UuYWxsU2V0dGxlZGAgdW5kZXIgYSBkZWFkbGluZSwgc2hhcGVkIGxpa2UgYGZsdXNoQWxsRGV0YWNoZWRgLlxuICAgKiBMb29wcyB3aGlsZSBjb250aW51YXRpb25zIHNwYXduIG5ldyBjYXB0dXJlcywgdW50aWwgcXVpZXNjZW50IG9yIHRoZVxuICAgKiBkZWFkbGluZSBleHBpcmVzLlxuICAgKi9cbiAgYXN5bmMgZHJhaW4ob3B0cz86IHsgdGltZW91dE1zPzogbnVtYmVyIH0pOiBQcm9taXNlPERyYWluUmVzdWx0PiB7XG4gICAgY29uc3QgdGltZW91dE1zID0gb3B0cz8udGltZW91dE1zID8/IDMwXzAwMDtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIGxldCBkb25lID0gMDtcbiAgICBsZXQgZmFpbGVkID0gMDtcblxuICAgIHRoaXMuZmx1c2hOb3coKTtcbiAgICB3aGlsZSAodGhpcy5pbmZsaWdodC5zaXplID4gMCkge1xuICAgICAgY29uc3QgcmVtYWluaW5nTXMgPSB0aW1lb3V0TXMgLSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWRBdCk7XG4gICAgICBpZiAocmVtYWluaW5nTXMgPD0gMCkgcmV0dXJuIHsgZG9uZSwgZmFpbGVkLCBwZW5kaW5nOiB0aGlzLmluZmxpZ2h0LnNpemUgKyB0aGlzLnF1ZXVlLmRlcHRoIH07XG5cbiAgICAgIGNvbnN0IGJhdGNoID0gWy4uLnRoaXMuaW5mbGlnaHRdO1xuICAgICAgbGV0IHRpbWVySWQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICAgICAgY29uc3QgdGltZW91dFByb21pc2UgPSBuZXcgUHJvbWlzZTwnX19kcmFpbl90aW1lb3V0X18nPigocmVzb2x2ZSkgPT4ge1xuICAgICAgICB0aW1lcklkID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCdfX2RyYWluX3RpbWVvdXRfXycpLCByZW1haW5pbmdNcyk7XG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1Byb21pc2UuYWxsU2V0dGxlZChiYXRjaCksIHRpbWVvdXRQcm9taXNlXSk7XG4gICAgICBpZiAodGltZXJJZCAhPT0gdW5kZWZpbmVkKSBjbGVhclRpbWVvdXQodGltZXJJZCk7XG4gICAgICBpZiAoc2V0dGxlZCA9PT0gJ19fZHJhaW5fdGltZW91dF9fJykge1xuICAgICAgICByZXR1cm4geyBkb25lLCBmYWlsZWQsIHBlbmRpbmc6IHRoaXMuaW5mbGlnaHQuc2l6ZSArIHRoaXMucXVldWUuZGVwdGggfTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgciBvZiBzZXR0bGVkKSB7XG4gICAgICAgIC8vIFRyYWNrZWQgcHJvbWlzZXMgbmV2ZXIgcmVqZWN0IOKAlCB0aGV5IHJlc29sdmUgdHJ1ZSAob2spIC8gZmFsc2UuXG4gICAgICAgIGlmIChyLnN0YXR1cyA9PT0gJ2Z1bGZpbGxlZCcgJiYgci52YWx1ZSA9PT0gZmFsc2UpIGZhaWxlZCArPSAxO1xuICAgICAgICBlbHNlIGRvbmUgKz0gMTtcbiAgICAgIH1cbiAgICAgIC8vIENvbnRpbnVhdGlvbnMgbWF5IGhhdmUgY2FwdHVyZWQgbW9yZSBldmVudHMg4oCUIGZsdXNoIGFuZCByZS1jaGVjay5cbiAgICAgIHRoaXMuZmx1c2hOb3coKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgZG9uZSwgZmFpbGVkLCBwZW5kaW5nOiB0aGlzLnF1ZXVlLmRlcHRoIH07XG4gIH1cblxuICAvKiogQTQg4oCUIHRoZSBzdGF0cyBvYmplY3QgQmxvY2sgOSBjb25zdW1lcy4gUHVyZSBnZXR0ZXIsIGZyZXNoIHNuYXBzaG90LiAqL1xuICBnZXRTdGF0cygpOiBEaXNwYXRjaGVyU3RhdHMge1xuICAgIGNvbnN0IGNvdW50ZXJzID0gdGhpcy5xdWV1ZS5nZXRDb3VudGVycygpO1xuICAgIGNvbnN0IGRyaXZlclN0YXRzID0gdGhpcy5kcml2ZXIuZ2V0U3RhdHMoKTtcbiAgICBjb25zdCBwZXJMaXN0ZW5lcjogUmVjb3JkPHN0cmluZywgTGlzdGVuZXJTdGF0cz4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IFtpZCwgc3RhdHNdIG9mIHRoaXMubGlzdGVuZXJTdGF0cykge1xuICAgICAgcGVyTGlzdGVuZXJbaWRdID0geyBldmVudHM6IHN0YXRzLmV2ZW50cywgdG90YWxNczogc3RhdHMudG90YWxNcywgbGFzdEZsdXNoTXM6IHN0YXRzLmxhc3RGbHVzaE1zIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBkZXB0aDogdGhpcy5xdWV1ZS5kZXB0aCxcbiAgICAgIGRyb3BzOiBjb3VudGVycy5kcm9wcyxcbiAgICAgIGZsdXNoZXM6IGRyaXZlclN0YXRzLmZsdXNoZXMsXG4gICAgICBidWRnZXRFeGhhdXN0ZWQ6IGRyaXZlclN0YXRzLmJ1ZGdldEV4aGF1c3RlZCxcbiAgICAgIHA5NUZsdXNoTXM6IGRyaXZlclN0YXRzLnA5NUZsdXNoTXMsXG4gICAgICBpbmxpbmVEZWxpdmVyaWVzOiB0aGlzLmlubGluZURlbGl2ZXJpZXMsXG4gICAgICBpbmZsaWdodDogdGhpcy5pbmZsaWdodC5zaXplLFxuICAgICAgcGVyTGlzdGVuZXIsXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgZGVsaXZlck5leHQoKTogdm9pZCB7XG4gICAgY29uc3QgZW52ZWxvcGUgPSB0aGlzLnF1ZXVlLnNoaWZ0KCk7XG4gICAgaWYgKGVudmVsb3BlID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICB0aGlzLmRlbGl2ZXIoZW52ZWxvcGUpO1xuICB9XG5cbiAgLyoqIEludm9rZSBldmVyeSBsaXN0ZW5lciB3aXRoIGZ1bGwgZXJyb3IgaXNvbGF0aW9uICsgdGltZSBhY2NvdW50aW5nLiAqL1xuICBwcml2YXRlIGRlbGl2ZXIoZW52ZWxvcGU6IENhcHR1cmVFbnZlbG9wZSk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgW2lkLCBsaXN0ZW5lcl0gb2YgdGhpcy5saXN0ZW5lcnMpIHtcbiAgICAgIGNvbnN0IHN0YXRzID0gdGhpcy5saXN0ZW5lclN0YXRzLmdldChpZCkgYXMgTXV0YWJsZUxpc3RlbmVyU3RhdHM7XG4gICAgICBjb25zdCBzdGFydCA9IHRoaXMubm93KCk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBsaXN0ZW5lcihlbnZlbG9wZSk7XG4gICAgICAgIGlmIChpc1RoZW5hYmxlKHJlc3VsdCkpIHRoaXMudHJhY2socmVzdWx0LCBpZCwgZW52ZWxvcGUpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhpcy5zYWZlT25FcnJvcihlcnJvciwgeyBsaXN0ZW5lcklkOiBpZCwgZW52ZWxvcGUsIHBoYXNlOiAnc3luYycgfSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBjb25zdCBlbGFwc2VkID0gdGhpcy5ub3coKSAtIHN0YXJ0O1xuICAgICAgICBzdGF0cy5ldmVudHMgKz0gMTtcbiAgICAgICAgc3RhdHMudG90YWxNcyArPSBlbGFwc2VkO1xuICAgICAgICBzdGF0cy5sYXN0Rmx1c2hNcyArPSBlbGFwc2VkO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKiBUcmFjayBhbiBhc3luYyBjb250aW51YXRpb247IHJvdXRlIGl0cyByZWplY3Rpb247IG5ldmVyIHJlamVjdC4gKi9cbiAgcHJpdmF0ZSB0cmFjayhwcm9taXNlOiBQcm9taXNlPHZvaWQ+LCBsaXN0ZW5lcklkOiBzdHJpbmcsIGVudmVsb3BlOiBDYXB0dXJlRW52ZWxvcGUpOiB2b2lkIHtcbiAgICBjb25zdCB0cmFja2VkOiBQcm9taXNlPGJvb2xlYW4+ID0gcHJvbWlzZS50aGVuKFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICAgIChlcnJvcikgPT4ge1xuICAgICAgICB0aGlzLnNhZmVPbkVycm9yKGVycm9yLCB7IGxpc3RlbmVySWQsIGVudmVsb3BlLCBwaGFzZTogJ2FzeW5jJyB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICApO1xuICAgIHRoaXMuaW5mbGlnaHQuYWRkKHRyYWNrZWQpO1xuICAgIC8vIFNlbGYtY2xlYW51cCDigJQgYHRyYWNrZWRgIG5ldmVyIHJlamVjdHMsIHNvIHRoaXMgY2hhaW4gY2Fubm90IGZsb2F0IGFuXG4gICAgLy8gdW5oYW5kbGVkIHJlamVjdGlvbi5cbiAgICB0cmFja2VkLnRoZW4oKCkgPT4gdGhpcy5pbmZsaWdodC5kZWxldGUodHJhY2tlZCkpO1xuICB9XG5cbiAgLyoqIFRoZSBlcnJvciBzaW5rIG11c3QgbmV2ZXIgYmVjb21lIGFuIGVycm9yIHNvdXJjZS4gKi9cbiAgcHJpdmF0ZSBzYWZlT25FcnJvcihlcnJvcjogdW5rbm93biwgY29udGV4dDogRGlzcGF0Y2hFcnJvckNvbnRleHQpOiB2b2lkIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5vbkVycm9yPy4oZXJyb3IsIGNvbnRleHQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gU3dhbGxvdyDigJQgaXNvbGF0aW9uIGlzIGFic29sdXRlLlxuICAgIH1cbiAgfVxufVxuIl19