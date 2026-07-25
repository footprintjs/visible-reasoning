/**
 * EventDispatcher — the central event bus (one per runner).
 *
 * Pattern: Observer (GoF) + Pub/Sub over a typed discriminated union.
 * Role:    Single flat dispatcher for every event emitted during a run.
 *          Replaces DOM-style bubbling — we have a central bus by
 *          construction, so tree propagation is unnecessary.
 * Emits:   N/A — this IS the emitter. It ROUTES events to listeners.
 *
 * Semantics:
 *   - Observers are ALWAYS fire-and-forget (inherited from footprintjs's
 *     recorder contract). Promise returns are never awaited.
 *   - Listener errors are caught; they become `agentfootprint.error.fatal`
 *     events with stage:'observer'. The run continues.
 *   - Dispatch is O(1) hash lookup by event type.
 *   - Zero allocation when no listener for an event type AND no wildcard.
 *   - Dev-mode wraps listeners to warn on async listener Promise return.
 *   - Lifecycle: subscriptions release via the returned Unsubscribe or an
 *     AbortSignal (`{ signal }`); `removeAllListeners()` is the bulk
 *     escape hatch for long-lived server consumers; `listenerCount()` is
 *     the leak diagnostic. Every removal path prunes emptied buckets and
 *     detaches abort handlers, so listener storage is bounded by LIVE
 *     subscriptions — never by subscription history.
 */
import { isDevMode } from 'footprintjs';
/** Shared no-op returned when subscribing to an already-aborted signal —
 *  the listener was never registered, so unsubscribe has nothing to do. */
const noopUnsubscribe = () => undefined;
/**
 * Empty a bucket, detaching each subscription's abort handler from its
 * AbortSignal first. Used by removeAllListeners().
 */
function drainBucket(bucket) {
    for (const stored of bucket)
        stored.cleanup?.();
    bucket.clear();
}
// ─── Dispatcher ──────────────────────────────────────────────────────
/**
 * Central event bus. One per executable runner.
 *
 * Zero-alloc fast path: if `hasListenersFor(type)` is false AND there are
 * no wildcards, `dispatch` returns immediately without iteration.
 */
export class EventDispatcher {
    byType = new Map();
    domainWildcards = new Map();
    allWildcards = new Set();
    // ─── Query ────────────────────────────────────────────────────────
    /**
     * Fast-path check. Returns true when at least one listener would fire
     * for this type. Used by emitters to skip event-object allocation.
     */
    hasListenersFor(type) {
        if (this.allWildcards.size > 0)
            return true;
        const typed = this.byType.get(type);
        if (typed && typed.size > 0)
            return true;
        const domainKey = this.domainKey(type);
        const domain = this.domainWildcards.get(domainKey);
        return domain ? domain.size > 0 : false;
    }
    on(type, listener, options) {
        return this.subscribe(type, listener, options);
    }
    once(type, listener, options) {
        return this.subscribe(type, listener, { ...options, once: true });
    }
    /**
     * Shared subscribe path for on()/once(). The public overloads constrain
     * `type` to either typed keys or wildcards; internally the dispatcher's
     * bucket logic accepts any string and classifies by shape.
     */
    subscribe(type, listener, options) {
        const signal = options?.signal;
        if (signal?.aborted) {
            // Already aborted; register nothing — return a no-op unsubscribe.
            return noopUnsubscribe;
        }
        const wrapped = {
            fn: wrapForDev(listener, type),
            once: options?.once === true,
        };
        const remove = this.addListener(type, wrapped);
        if (!signal)
            return remove;
        // DOM-parity AbortSignal wiring: abort → unsubscribe, AND every other
        // removal path (manual unsubscribe, off(), once-auto-removal,
        // removeAllListeners()) → detach the abort handler from the signal,
        // so a long-lived, never-aborted signal doesn't accumulate handlers.
        const onAbort = () => {
            remove();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        wrapped.cleanup = () => {
            signal.removeEventListener('abort', onAbort);
        };
        return () => {
            wrapped.cleanup?.();
            remove();
        };
    }
    off(type, listener) {
        const bucket = this.bucketFor(type);
        if (!bucket)
            return;
        const originalFn = originalsMap.get(listener) ?? listener;
        for (const stored of bucket) {
            const storedOriginal = originalsMap.get(stored.fn) ?? stored.fn;
            if (storedOriginal === originalFn) {
                bucket.delete(stored);
                stored.cleanup?.();
                this.pruneBucket(type, bucket);
                return;
            }
        }
    }
    /**
     * Lifecycle escape hatch — drop EVERY listener (typed, domain-wildcard,
     * and `'*'`) in one call. For long-lived server consumers that reuse one
     * runner across many requests: when you can't thread an AbortSignal or
     * keep every Unsubscribe handle, call this between requests to guarantee
     * the dispatcher holds zero subscriptions.
     *
     * Safe to call mid-dispatch: the bucket currently being iterated
     * finishes its already-taken snapshot (same semantics as `off()` during
     * dispatch), buckets the in-flight dispatch has NOT yet reached deliver
     * nothing (DOM-like "stop now"), and every SUBSEQUENT event sees no
     * listeners. Abort handlers registered on consumer AbortSignals via
     * `{ signal }` are detached too. Previously returned Unsubscribe
     * handles become harmless no-ops.
     */
    removeAllListeners() {
        for (const bucket of this.byType.values())
            drainBucket(bucket);
        this.byType.clear();
        for (const bucket of this.domainWildcards.values())
            drainBucket(bucket);
        this.domainWildcards.clear();
        drainBucket(this.allWildcards);
    }
    listenerCount(type) {
        if (type !== undefined) {
            const bucket = this.bucketFor(type);
            return bucket ? bucket.size : 0;
        }
        let total = this.allWildcards.size;
        for (const bucket of this.byType.values())
            total += bucket.size;
        for (const bucket of this.domainWildcards.values())
            total += bucket.size;
        return total;
    }
    // ─── Dispatch ─────────────────────────────────────────────────────
    /**
     * Route an event to all matching listeners (typed + domain-wildcard + all).
     *
     * Fire-and-forget: any returned Promise is IGNORED. Listener exceptions
     * are caught and re-dispatched as `error.fatal` events with scope='observer'.
     * The run continues regardless.
     */
    dispatch(event) {
        const typed = this.byType.get(event.type);
        const domainKey = this.domainKey(event.type);
        const domain = this.domainWildcards.get(domainKey);
        this.fireBucket(typed, event);
        // Prune only when once-listeners actually emptied the bucket — keeps the
        // hot path free of per-event work (incl. the `${domainKey}.*` string build).
        if (typed && typed.size === 0)
            this.pruneBucket(event.type, typed);
        this.fireBucket(domain, event);
        if (domain && domain.size === 0)
            this.pruneBucket(`${domainKey}.*`, domain);
        this.fireBucket(this.allWildcards, event);
    }
    // ─── Internals ────────────────────────────────────────────────────
    addListener(type, stored) {
        const bucket = this.ensureBucket(type);
        bucket.add(stored);
        return () => {
            bucket.delete(stored);
            this.pruneBucket(type, bucket);
        };
    }
    /**
     * Bounded-leak guarantee: a bucket emptied by ANY removal path is
     * deleted from its Map so `byType` / `domainWildcards` never retain
     * empty Sets for event types subscribed once and released. The
     * identity check (`get(...) === bucket`) guards stale Unsubscribe
     * closures — they must never delete a NEWER bucket re-created under
     * the same key after this one was pruned. (`allWildcards` is a stable
     * field, not a Map entry — nothing to prune.)
     */
    pruneBucket(type, bucket) {
        if (bucket.size > 0 || type === '*')
            return;
        if (type.endsWith('.*')) {
            const key = type.slice(0, -2);
            if (this.domainWildcards.get(key) === bucket)
                this.domainWildcards.delete(key);
            return;
        }
        if (this.byType.get(type) === bucket)
            this.byType.delete(type);
    }
    ensureBucket(type) {
        if (type === '*')
            return this.allWildcards;
        if (type.endsWith('.*')) {
            const key = type.slice(0, -2);
            let bucket = this.domainWildcards.get(key);
            if (!bucket) {
                bucket = new Set();
                this.domainWildcards.set(key, bucket);
            }
            return bucket;
        }
        let bucket = this.byType.get(type);
        if (!bucket) {
            bucket = new Set();
            this.byType.set(type, bucket);
        }
        return bucket;
    }
    bucketFor(type) {
        if (type === '*')
            return this.allWildcards;
        if (type.endsWith('.*'))
            return this.domainWildcards.get(type.slice(0, -2));
        return this.byType.get(type);
    }
    fireBucket(bucket, event) {
        if (!bucket || bucket.size === 0)
            return;
        // Snapshot to allow removal during iteration (once-listeners, off(),
        // removeAllListeners()). Removal mid-dispatch takes effect for
        // SUBSEQUENT events; the in-flight snapshot completes delivery.
        const snapshot = [...bucket];
        for (const stored of snapshot) {
            if (stored.once) {
                bucket.delete(stored);
                stored.cleanup?.(); // detach abort handler from the consumer's signal
            }
            try {
                stored.fn(event);
            }
            catch (err) {
                // Error isolation — never let a listener break the run. We do not
                // re-dispatch here to avoid infinite recursion if an error-listener
                // itself throws. Errors are surfaced via console.error in dev mode.
                if (isDevMode()) {
                    // eslint-disable-next-line no-console
                    console.error(`[agentfootprint] Listener for "${event.type}" threw:`, err);
                }
            }
        }
    }
    domainKey(eventType) {
        // 'agentfootprint.context.injected' → 'agentfootprint.context'
        const lastDot = eventType.lastIndexOf('.');
        return lastDot === -1 ? eventType : eventType.slice(0, lastDot);
    }
}
// ─── Dev-mode async-listener warning wrapper ─────────────────────────
/**
 * Original-function map — preserves consumer's function identity across
 * dev-mode wrapping so `off(type, originalFn)` still finds and removes
 * the stored listener.
 */
// eslint-disable-next-line @typescript-eslint/ban-types -- WeakMap value preserves arbitrary listener identity; narrowing breaks identity equality.
const originalsMap = new WeakMap();
/**
 * Wrap a listener in dev mode to warn if it returns a Promise.
 * Production pass-through.
 *
 * Why: consumers occasionally write `on('x', async (e) => await ...)` and
 * expect the dispatcher to wait. It does NOT — observers are always
 * fire-and-forget. This warning catches the mistake loudly in dev.
 */
function wrapForDev(listener, type) {
    if (!isDevMode())
        return listener;
    const wrapped = (event) => {
        const result = listener(event);
        if (result && typeof result === 'object' && 'then' in result) {
            // eslint-disable-next-line no-console
            console.warn(`[agentfootprint] Listener for "${type}" returned a Promise.\n` +
                `Observers are NEVER awaited — your Promise will run in the background.\n` +
                `If you need back-pressure, collect promises and await AFTER run().\n` +
                `  See: https://agentfootprint.dev/docs/events/async-listeners`);
            // Capture unhandled rejections so they don't vanish silently.
            result.catch((err) => {
                // eslint-disable-next-line no-console
                console.error(`[agentfootprint] Listener Promise for "${type}" rejected:`, err);
            });
        }
    };
    originalsMap.set(wrapped, listener);
    return wrapped;
}
//# sourceMappingURL=dispatcher.js.map