/**
 * reactive/createTypedScope -- Core Proxy factory for TypedScope<T>.
 *
 * Wraps a ReactiveTarget (ScopeFacade) in a Proxy that provides:
 * - Typed property access: scope.creditTier (read), scope.creditTier = 'A' (write)
 * - Deep write interception: scope.customer.address.zip = '90210'
 * - Array mutation interception: scope.items.push('new')
 * - $-prefixed escape hatches: $getValue, $setValue, $read, $getArgs, etc.
 *
 * Read semantics: top-level get calls getValue() (fires onRead ONCE).
 *   Nested get traps navigate in-memory -- no additional onRead.
 *
 * Write semantics: top-level set calls setValue(). Nested set calls
 *   updateValue() with a partial object built from the accumulated path.
 */
import { nativeGet as lodashGet } from '../memory/pathOps.js';
import { shouldWrapWithProxy } from './allowlist.js';
import { createArrayProxy } from './arrayTraps.js';
import { buildNestedPatch } from './pathBuilder.js';
import { BREAK_SETTER, EXECUTOR_INTERNAL_METHODS, IS_TYPED_SCOPE, SCOPE_METHOD_NAMES } from './types.js';
// -- Proxy unwrapping --------------------------------------------------------
// structuredClone in TransactionBuffer cannot clone Proxy objects.
// When a user does `scope.backup = scope.customer`, the value is a Proxy.
// Unwrap to a plain object before storing.
function unwrapProxy(value) {
    if (value === null || value === undefined)
        return value;
    if (typeof value !== 'object')
        return value;
    // Fast path: plain objects and arrays don't need unwrapping
    try {
        // JSON round-trip strips Proxies. Safe because state values must be JSON-serializable.
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        // Non-serializable (functions, symbols, etc.) — return as-is
        return value;
    }
}
const METHOD_ROUTES = {
    $getValue: (t) => t.getValue.bind(t),
    $setValue: (t) => t.setValue.bind(t),
    $update: (t) => t.updateValue.bind(t),
    $delete: (t) => t.deleteValue.bind(t),
    $read: (t) => (dotPath) => {
        const rootKey = dotPath.split('.')[0];
        const value = t.getValue(rootKey);
        if (!dotPath.includes('.'))
            return value;
        return lodashGet(value, dotPath.slice(rootKey.length + 1));
    },
    $getArgs: (t) => t.getArgs.bind(t),
    $getEnv: (t) => t.getEnv.bind(t),
    $debug: (t) => t.addDebugInfo.bind(t),
    $log: (t) => t.addDebugMessage.bind(t),
    $error: (t) => t.addErrorInfo.bind(t),
    $metric: (t) => t.addMetric.bind(t),
    $eval: (t) => t.addEval.bind(t),
    $attachScopeRecorder: (t) => t.attachScopeRecorder.bind(t),
    $detachScopeRecorder: (t) => t.detachScopeRecorder.bind(t),
    $getScopeRecorders: (t) => t.getScopeRecorders.bind(t),
    $batchArray: (t) => (key, fn) => {
        // One getValue — fires onRead once
        const current = t.getValue(key);
        // Clone once (or start empty if missing/non-array)
        const clone = Array.isArray(current) ? [...current] : [];
        // User applies all mutations to the plain clone — no Proxy, no per-mutation commit
        fn(clone);
        // One setValue — fires onWrite once with the final array
        t.setValue(key, clone);
    },
    $break: (_t, opts) => (reason) => {
        if (!opts.breakFn)
            throw new Error('$break() is not available outside stage execution');
        opts.breakFn(reason);
    },
    // Observability — Emit channel (Phase 3). Routes to ScopeFacade.emitEvent
    // which handles fast-path, enrichment, redaction, and error isolation.
    $emit: (t) => t.emitEvent.bind(t),
    // Detach (T4) — fire-and-forget child flowcharts. Delegates to ScopeFacade
    // which minted refIds from runtimeStageId.
    $detachAndJoinLater: (t) => t.detachAndJoinLater.bind(t),
    $detachAndForget: (t) => t.detachAndForget.bind(t),
    $toRaw: (t) => () => t,
};
// -- Guard properties --------------------------------------------------------
// These must be handled to prevent Proxy from being treated as a Promise,
// breaking instanceof checks, or confusing test matchers.
const GUARD_PROPS = {
    then: undefined, // prevent Promise detection
    asymmetricMatch: undefined, // prevent vitest/jest matcher confusion
    constructor: Object, // safe prototype
    [Symbol.toStringTag]: 'TypedScope',
};
// -- Nested child proxy (for deep write interception) ------------------------
//
// Cycle safety: an immutable Set<object> of ancestor objects is passed down
// each access chain. Each branch gets its own copy (new Set(parent)) so
// scope.x.friend and scope.x.coworker don't pollute each other's tracking.
// When a child value is already in the ancestor set, we've hit a cycle.
// At the cycle break: return a terminal proxy that tracks writes (set trap
// still builds path + calls updateValue) but doesn't recurse reads further.
function createTerminalProxy(obj, rootKey, segments, target, state, visited = new Set()) {
    visited.add(obj);
    return new Proxy(obj, {
        get(raw, prop) {
            if (typeof prop === 'symbol')
                return raw[prop];
            if (prop === 'then')
                return undefined;
            if (prop === 'asymmetricMatch')
                return undefined;
            if (prop === 'constructor')
                return Object;
            if (prop === 'toJSON')
                return () => {
                    // Strip object-typed values to prevent circular JSON errors
                    const safe = {};
                    for (const k of Object.keys(raw)) {
                        const v = raw[k];
                        if (v === null || typeof v !== 'object')
                            safe[k] = v;
                    }
                    return safe;
                };
            const value = raw[prop];
            // Continue tracking writes at deeper levels via chained terminal proxies.
            // Use visited set to prevent re-entering the same object (cycle in terminal chain).
            if (shouldWrapWithProxy(value) && !Array.isArray(value) && !visited.has(value)) {
                return createTerminalProxy(value, rootKey, [...segments, prop], target, state, visited);
            }
            return value;
        },
        set(raw, prop, value) {
            if (typeof prop !== 'string')
                return true;
            const childSegments = [...segments, prop];
            const patch = buildNestedPatch(childSegments, unwrapProxy(value));
            target.updateValue(rootKey, patch);
            state.childCache.delete(rootKey);
            return true;
        },
    });
}
function createNestedProxy(obj, rootKey, segments, target, readSilent, state, ancestors = new Set()) {
    return new Proxy(obj, {
        get(raw, prop) {
            if (typeof prop === 'symbol')
                return raw[prop];
            // Guard properties
            if (prop === 'then')
                return undefined;
            if (prop === 'asymmetricMatch')
                return undefined;
            if (prop === 'constructor')
                return Object;
            if (prop === 'toJSON')
                return () => {
                    // Strip object-typed values to prevent circular JSON errors
                    const safe = {};
                    for (const k of Object.keys(raw)) {
                        const v = raw[k];
                        if (v === null || typeof v !== 'object')
                            safe[k] = v;
                    }
                    return safe;
                };
            const value = raw[prop];
            // Primitive or non-wrappable -- return as-is (no deeper proxy)
            if (!shouldWrapWithProxy(value))
                return value;
            const childSegments = [...segments, prop];
            // Array -- return array proxy
            if (Array.isArray(value)) {
                return createArrayProxy(() => {
                    const current = readSilent(rootKey);
                    return lodashGet(current, childSegments.join('.')) ?? [];
                }, (newArr) => {
                    const patch = buildNestedPatch(childSegments, unwrapProxy(newArr));
                    target.updateValue(rootKey, patch);
                    state.childCache.delete(rootKey);
                });
            }
            // Cycle detection: if this value is an ancestor in the current access
            // chain, return a terminal proxy (tracks writes, stops recursing reads).
            if (ancestors.has(value)) {
                return createTerminalProxy(value, rootKey, childSegments, target, state);
            }
            // Build new ancestor set for this branch (immutable -- no cross-branch pollution)
            const childAncestors = new Set(ancestors);
            childAncestors.add(value);
            return createNestedProxy(value, rootKey, childSegments, target, readSilent, state, childAncestors);
        },
        set(raw, prop, value) {
            if (typeof prop !== 'string')
                return true;
            const childSegments = [...segments, prop];
            const patch = buildNestedPatch(childSegments, unwrapProxy(value));
            target.updateValue(rootKey, patch);
            state.childCache.delete(rootKey);
            return true;
        },
    });
}
// -- Top-level proxy (the main TypedScope) -----------------------------------
/**
 * Creates a TypedScope<T> proxy wrapping a ReactiveTarget.
 *
 * @param target - The underlying scope (ScopeFacade or any ReactiveTarget)
 * @param options - Optional configuration (breakPipeline injection)
 * @returns A Proxy with typed property access and $-prefixed methods
 */
export function createTypedScope(target, options) {
    const state = {
        breakFn: options?.breakPipeline,
        childCache: new Map(),
    };
    // Bind silent-read method once — avoids per-call ?? + .call() in array proxy getCurrent closures
    const readSilent = (target.getValueSilent ?? target.getValue).bind(target);
    const proxy = new Proxy(target, {
        get(_proxyTarget, prop, _receiver) {
            // 1. Internal symbols (check before other symbols)
            if (prop === IS_TYPED_SCOPE)
                return true;
            if (prop === BREAK_SETTER) {
                return (fn) => {
                    state.breakFn = fn;
                };
            }
            // 2. Symbol properties (guard + inspection)
            if (typeof prop === 'symbol') {
                if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop))
                    return GUARD_PROPS[prop];
                // Node.js util.inspect — show state snapshot, not proxy internals
                if (prop === Symbol.for('nodejs.util.inspect.custom')) {
                    return () => target.getValue();
                }
                return undefined;
            }
            // 3. String guard properties
            if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop))
                return GUARD_PROPS[prop];
            // 4. $-prefixed methods -- route to facade
            if (SCOPE_METHOD_NAMES.has(prop)) {
                const router = METHOD_ROUTES[prop];
                if (router)
                    return router(target, state);
                return undefined;
            }
            // 5. Executor-internal method pass-through (explicit allowlist)
            //    FlowChartExecutor wrapping calls attachScopeRecorder, notifyStageStart, etc.
            //    directly on the scope. Forward only allowlisted methods.
            if (EXECUTOR_INTERNAL_METHODS.has(prop) && typeof target[prop] === 'function') {
                return target[prop].bind(target);
            }
            // 6. State key -- call getValue (fires onRead ONCE)
            const value = target.getValue(prop);
            // Primitive or null/undefined -- return as-is
            if (value === null || value === undefined || typeof value !== 'object') {
                return value;
            }
            // Non-wrappable (Date, Map, class instance, etc.) -- return unwrapped
            if (!shouldWrapWithProxy(value))
                return value;
            // Array -- return array proxy (cached for identity equality)
            if (Array.isArray(value)) {
                const cached = state.childCache.get(prop);
                if (cached && cached.ref === value)
                    return cached.proxy;
                const arrProxy = createArrayProxy(() => readSilent(prop) ?? [], (newArr) => {
                    target.setValue(prop, unwrapProxy(newArr));
                    state.childCache.delete(prop);
                });
                state.childCache.set(prop, { ref: value, proxy: arrProxy });
                return arrProxy;
            }
            // Plain object -- return nested proxy (cached for identity equality)
            const cached = state.childCache.get(prop);
            if (cached && cached.ref === value)
                return cached.proxy;
            const nested = createNestedProxy(value, prop, [], target, readSilent, state, new Set([value]));
            state.childCache.set(prop, { ref: value, proxy: nested });
            return nested;
        },
        set(_proxyTarget, prop, value) {
            if (typeof prop !== 'string')
                return true;
            if (SCOPE_METHOD_NAMES.has(prop)) {
                throw new Error(`Cannot set state key "${prop}" -- it conflicts with a reserved TypedScope method. Rename the state key to avoid $-prefixed names.`);
            }
            // Unwrap Proxy values before storing — structuredClone in TransactionBuffer
            // cannot clone Proxy objects. This handles: scope.backup = scope.customer
            const unwrapped = unwrapProxy(value);
            target.setValue(prop, unwrapped);
            state.childCache.delete(prop); // invalidate cache
            return true;
        },
        deleteProperty(_proxyTarget, prop) {
            if (typeof prop !== 'string')
                return true;
            target.deleteValue(prop);
            state.childCache.delete(prop);
            return true;
        },
        has(_proxyTarget, prop) {
            if (typeof prop === 'symbol')
                return Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop);
            if (SCOPE_METHOD_NAMES.has(prop))
                return true;
            // Use non-tracking hasKey if available, else fallback to getStateKeys
            if (target.hasKey)
                return target.hasKey(prop);
            if (target.getStateKeys)
                return target.getStateKeys().includes(prop);
            // Fallback: getValue fires onRead (acceptable degradation)
            return target.getValue(prop) !== undefined;
        },
        ownKeys() {
            // Use non-tracking getStateKeys if available, else fallback
            if (target.getStateKeys)
                return target.getStateKeys();
            const snapshot = target.getValue();
            if (!snapshot || typeof snapshot !== 'object')
                return [];
            return Object.keys(snapshot);
        },
        getOwnPropertyDescriptor(_proxyTarget, prop) {
            if (typeof prop !== 'string')
                return undefined;
            if (SCOPE_METHOD_NAMES.has(prop))
                return undefined; // $-methods are non-enumerable
            // Check existence without firing onRead — no getValue call here
            const exists = target.hasKey
                ? target.hasKey(prop)
                : target.getStateKeys
                    ? target.getStateKeys().includes(prop)
                    : target.getValue(prop) !== undefined; // fallback only
            if (!exists)
                return undefined;
            // Return a minimal descriptor — actual value is fetched via the get trap
            return { configurable: true, enumerable: true, writable: true };
        },
    });
    return proxy;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JlYXRlVHlwZWRTY29wZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVhY3RpdmUvY3JlYXRlVHlwZWRTY29wZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUVILE9BQU8sRUFBRSxTQUFTLElBQUksU0FBUyxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDOUQsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDckQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDbkQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFFcEQsT0FBTyxFQUFFLFlBQVksRUFBRSx5QkFBeUIsRUFBRSxjQUFjLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFekcsK0VBQStFO0FBQy9FLG1FQUFtRTtBQUNuRSwwRUFBMEU7QUFDMUUsMkNBQTJDO0FBRTNDLFNBQVMsV0FBVyxDQUFDLEtBQWM7SUFDakMsSUFBSSxLQUFLLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDeEQsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDNUMsNERBQTREO0lBQzVELElBQUksQ0FBQztRQUNILHVGQUF1RjtRQUN2RixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQzNDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCw2REFBNkQ7UUFDN0QsT0FBTyxLQUFLLENBQUM7SUFDZixDQUFDO0FBQ0gsQ0FBQztBQU1ELE1BQU0sYUFBYSxHQUFpQztJQUNsRCxTQUFTLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUNwQyxTQUFTLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUNwQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUNyQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUNyQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsT0FBZSxFQUFFLEVBQUU7UUFDaEMsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUN0QyxNQUFNLEtBQUssR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2xDLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQztZQUFFLE9BQU8sS0FBSyxDQUFDO1FBQ3pDLE9BQU8sU0FBUyxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM3RCxDQUFDO0lBQ0QsUUFBUSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDbEMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDaEMsTUFBTSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDckMsSUFBSSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDdEMsTUFBTSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDckMsT0FBTyxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDbkMsS0FBSyxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDL0Isb0JBQW9CLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQzFELG9CQUFvQixFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsbUJBQW1CLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUMxRCxrQkFBa0IsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDdEQsV0FBVyxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQVcsRUFBRSxFQUE0QixFQUFFLEVBQUU7UUFDaEUsbUNBQW1DO1FBQ25DLE1BQU0sT0FBTyxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDaEMsbURBQW1EO1FBQ25ELE1BQU0sS0FBSyxHQUFjLEtBQUssQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3BFLG1GQUFtRjtRQUNuRixFQUFFLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDVix5REFBeUQ7UUFDekQsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUNELE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUMsTUFBZSxFQUFFLEVBQUU7UUFDeEMsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO1FBQ3hGLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkIsQ0FBQztJQUNELDBFQUEwRTtJQUMxRSx1RUFBdUU7SUFDdkUsS0FBSyxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDakMsMkVBQTJFO0lBQzNFLDJDQUEyQztJQUMzQyxtQkFBbUIsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDeEQsZ0JBQWdCLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUNsRCxNQUFNLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7Q0FDdkIsQ0FBQztBQUVGLCtFQUErRTtBQUMvRSwwRUFBMEU7QUFDMUUsMERBQTBEO0FBRTFELE1BQU0sV0FBVyxHQUFxQztJQUNwRCxJQUFJLEVBQUUsU0FBUyxFQUFFLDRCQUE0QjtJQUM3QyxlQUFlLEVBQUUsU0FBUyxFQUFFLHdDQUF3QztJQUNwRSxXQUFXLEVBQUUsTUFBTSxFQUFFLGlCQUFpQjtJQUN0QyxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsRUFBRSxZQUFZO0NBQ25DLENBQUM7QUFVRiwrRUFBK0U7QUFDL0UsRUFBRTtBQUNGLDRFQUE0RTtBQUM1RSx3RUFBd0U7QUFDeEUsMkVBQTJFO0FBQzNFLHdFQUF3RTtBQUN4RSwyRUFBMkU7QUFDM0UsNEVBQTRFO0FBRTVFLFNBQVMsbUJBQW1CLENBQzFCLEdBQTRCLEVBQzVCLE9BQWUsRUFDZixRQUFrQixFQUNsQixNQUFzQixFQUN0QixLQUFvQixFQUNwQixVQUF1QixJQUFJLEdBQUcsRUFBRTtJQUVoQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE9BQU8sSUFBSSxLQUFLLENBQUMsR0FBRyxFQUFFO1FBQ3BCLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSTtZQUNYLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUTtnQkFBRSxPQUFRLEdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN4RCxJQUFJLElBQUksS0FBSyxNQUFNO2dCQUFFLE9BQU8sU0FBUyxDQUFDO1lBQ3RDLElBQUksSUFBSSxLQUFLLGlCQUFpQjtnQkFBRSxPQUFPLFNBQVMsQ0FBQztZQUNqRCxJQUFJLElBQUksS0FBSyxhQUFhO2dCQUFFLE9BQU8sTUFBTSxDQUFDO1lBQzFDLElBQUksSUFBSSxLQUFLLFFBQVE7Z0JBQ25CLE9BQU8sR0FBRyxFQUFFO29CQUNWLDREQUE0RDtvQkFDNUQsTUFBTSxJQUFJLEdBQTRCLEVBQUUsQ0FBQztvQkFDekMsS0FBSyxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7d0JBQ2pDLE1BQU0sQ0FBQyxHQUFJLEdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQzt3QkFDMUIsSUFBSSxDQUFDLEtBQUssSUFBSSxJQUFJLE9BQU8sQ0FBQyxLQUFLLFFBQVE7NEJBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztvQkFDdkQsQ0FBQztvQkFDRCxPQUFPLElBQUksQ0FBQztnQkFDZCxDQUFDLENBQUM7WUFFSixNQUFNLEtBQUssR0FBSSxHQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7WUFFakMsMEVBQTBFO1lBQzFFLG9GQUFvRjtZQUNwRixJQUFJLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsS0FBZSxDQUFDLEVBQUUsQ0FBQztnQkFDekYsT0FBTyxtQkFBbUIsQ0FDeEIsS0FBZ0MsRUFDaEMsT0FBTyxFQUNQLENBQUMsR0FBRyxRQUFRLEVBQUUsSUFBYyxDQUFDLEVBQzdCLE1BQU0sRUFDTixLQUFLLEVBQ0wsT0FBTyxDQUNSLENBQUM7WUFDSixDQUFDO1lBRUQsT0FBTyxLQUFLLENBQUM7UUFDZixDQUFDO1FBQ0QsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsS0FBSztZQUNsQixJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVE7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDMUMsTUFBTSxhQUFhLEdBQUcsQ0FBQyxHQUFHLFFBQVEsRUFBRSxJQUFJLENBQUMsQ0FBQztZQUMxQyxNQUFNLEtBQUssR0FBRyxnQkFBZ0IsQ0FBQyxhQUFhLEVBQUUsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7WUFDbEUsTUFBTSxDQUFDLFdBQVcsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDbkMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDakMsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVELFNBQVMsaUJBQWlCLENBQ3hCLEdBQTRCLEVBQzVCLE9BQWUsRUFDZixRQUFrQixFQUNsQixNQUFzQixFQUN0QixVQUFxQyxFQUNyQyxLQUFvQixFQUNwQixZQUF5QixJQUFJLEdBQUcsRUFBRTtJQUVsQyxPQUFPLElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRTtRQUNwQixHQUFHLENBQUMsR0FBRyxFQUFFLElBQUk7WUFDWCxJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVE7Z0JBQUUsT0FBUSxHQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7WUFFeEQsbUJBQW1CO1lBQ25CLElBQUksSUFBSSxLQUFLLE1BQU07Z0JBQUUsT0FBTyxTQUFTLENBQUM7WUFDdEMsSUFBSSxJQUFJLEtBQUssaUJBQWlCO2dCQUFFLE9BQU8sU0FBUyxDQUFDO1lBQ2pELElBQUksSUFBSSxLQUFLLGFBQWE7Z0JBQUUsT0FBTyxNQUFNLENBQUM7WUFDMUMsSUFBSSxJQUFJLEtBQUssUUFBUTtnQkFDbkIsT0FBTyxHQUFHLEVBQUU7b0JBQ1YsNERBQTREO29CQUM1RCxNQUFNLElBQUksR0FBNEIsRUFBRSxDQUFDO29CQUN6QyxLQUFLLE1BQU0sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQzt3QkFDakMsTUFBTSxDQUFDLEdBQUksR0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUMxQixJQUFJLENBQUMsS0FBSyxJQUFJLElBQUksT0FBTyxDQUFDLEtBQUssUUFBUTs0QkFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO29CQUN2RCxDQUFDO29CQUNELE9BQU8sSUFBSSxDQUFDO2dCQUNkLENBQUMsQ0FBQztZQUVKLE1BQU0sS0FBSyxHQUFJLEdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUVqQywrREFBK0Q7WUFDL0QsSUFBSSxDQUFDLG1CQUFtQixDQUFDLEtBQUssQ0FBQztnQkFBRSxPQUFPLEtBQUssQ0FBQztZQUU5QyxNQUFNLGFBQWEsR0FBRyxDQUFDLEdBQUcsUUFBUSxFQUFFLElBQWMsQ0FBQyxDQUFDO1lBRXBELDhCQUE4QjtZQUM5QixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztnQkFDekIsT0FBTyxnQkFBZ0IsQ0FDckIsR0FBRyxFQUFFO29CQUNILE1BQU0sT0FBTyxHQUFHLFVBQVUsQ0FBQyxPQUFPLENBQVEsQ0FBQztvQkFDM0MsT0FBTyxTQUFTLENBQUMsT0FBTyxFQUFFLGFBQWEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7Z0JBQzNELENBQUMsRUFDRCxDQUFDLE1BQU0sRUFBRSxFQUFFO29CQUNULE1BQU0sS0FBSyxHQUFHLGdCQUFnQixDQUFDLGFBQWEsRUFBRSxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztvQkFDbkUsTUFBTSxDQUFDLFdBQVcsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7b0JBQ25DLEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO2dCQUNuQyxDQUFDLENBQ0YsQ0FBQztZQUNKLENBQUM7WUFFRCxzRUFBc0U7WUFDdEUseUVBQXlFO1lBQ3pFLElBQUksU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFlLENBQUMsRUFBRSxDQUFDO2dCQUNuQyxPQUFPLG1CQUFtQixDQUFDLEtBQWdDLEVBQUUsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDdEcsQ0FBQztZQUVELGtGQUFrRjtZQUNsRixNQUFNLGNBQWMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztZQUMxQyxjQUFjLENBQUMsR0FBRyxDQUFDLEtBQWUsQ0FBQyxDQUFDO1lBRXBDLE9BQU8saUJBQWlCLENBQ3RCLEtBQWdDLEVBQ2hDLE9BQU8sRUFDUCxhQUFhLEVBQ2IsTUFBTSxFQUNOLFVBQVUsRUFDVixLQUFLLEVBQ0wsY0FBYyxDQUNmLENBQUM7UUFDSixDQUFDO1FBRUQsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsS0FBSztZQUNsQixJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVE7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFFMUMsTUFBTSxhQUFhLEdBQUcsQ0FBQyxHQUFHLFFBQVEsRUFBRSxJQUFJLENBQUMsQ0FBQztZQUMxQyxNQUFNLEtBQUssR0FBRyxnQkFBZ0IsQ0FBQyxhQUFhLEVBQUUsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7WUFDbEUsTUFBTSxDQUFDLFdBQVcsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDbkMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDakMsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVELCtFQUErRTtBQUUvRTs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsZ0JBQWdCLENBQW1CLE1BQXNCLEVBQUUsT0FBeUI7SUFDbEcsTUFBTSxLQUFLLEdBQWtCO1FBQzNCLE9BQU8sRUFBRSxPQUFPLEVBQUUsYUFBYTtRQUMvQixVQUFVLEVBQUUsSUFBSSxHQUFHLEVBQUU7S0FDdEIsQ0FBQztJQUVGLGlHQUFpRztJQUNqRyxNQUFNLFVBQVUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxjQUFjLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUUzRSxNQUFNLEtBQUssR0FBRyxJQUFJLEtBQUssQ0FBQyxNQUFrQyxFQUFFO1FBQzFELEdBQUcsQ0FBQyxZQUFZLEVBQUUsSUFBSSxFQUFFLFNBQVM7WUFDL0IsbURBQW1EO1lBQ25ELElBQUksSUFBSSxLQUFLLGNBQWM7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDekMsSUFBSSxJQUFJLEtBQUssWUFBWSxFQUFFLENBQUM7Z0JBQzFCLE9BQU8sQ0FBQyxFQUFjLEVBQUUsRUFBRTtvQkFDeEIsS0FBSyxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7Z0JBQ3JCLENBQUMsQ0FBQztZQUNKLENBQUM7WUFFRCw0Q0FBNEM7WUFDNUMsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztnQkFDN0IsSUFBSSxNQUFNLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQztvQkFBRSxPQUFPLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDdEYsa0VBQWtFO2dCQUNsRSxJQUFJLElBQUksS0FBSyxNQUFNLENBQUMsR0FBRyxDQUFDLDRCQUE0QixDQUFDLEVBQUUsQ0FBQztvQkFDdEQsT0FBTyxHQUFHLEVBQUUsQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ2pDLENBQUM7Z0JBQ0QsT0FBTyxTQUFTLENBQUM7WUFDbkIsQ0FBQztZQUVELDZCQUE2QjtZQUM3QixJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDO2dCQUFFLE9BQU8sV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBRXRGLDJDQUEyQztZQUMzQyxJQUFJLGtCQUFrQixDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO2dCQUNqQyxNQUFNLE1BQU0sR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ25DLElBQUksTUFBTTtvQkFBRSxPQUFPLE1BQU0sQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7Z0JBQ3pDLE9BQU8sU0FBUyxDQUFDO1lBQ25CLENBQUM7WUFFRCxnRUFBZ0U7WUFDaEUsa0ZBQWtGO1lBQ2xGLDhEQUE4RDtZQUM5RCxJQUFJLHlCQUF5QixDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxPQUFRLE1BQWMsQ0FBQyxJQUFJLENBQUMsS0FBSyxVQUFVLEVBQUUsQ0FBQztnQkFDdkYsT0FBUSxNQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQzVDLENBQUM7WUFFRCxvREFBb0Q7WUFDcEQsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUVwQyw4Q0FBOEM7WUFDOUMsSUFBSSxLQUFLLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQ3ZFLE9BQU8sS0FBSyxDQUFDO1lBQ2YsQ0FBQztZQUVELHNFQUFzRTtZQUN0RSxJQUFJLENBQUMsbUJBQW1CLENBQUMsS0FBSyxDQUFDO2dCQUFFLE9BQU8sS0FBSyxDQUFDO1lBRTlDLDZEQUE2RDtZQUM3RCxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztnQkFDekIsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQzFDLElBQUksTUFBTSxJQUFJLE1BQU0sQ0FBQyxHQUFHLEtBQUssS0FBSztvQkFBRSxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUM7Z0JBRXhELE1BQU0sUUFBUSxHQUFHLGdCQUFnQixDQUMvQixHQUFHLEVBQUUsQ0FBRSxVQUFVLENBQUMsSUFBSSxDQUFlLElBQUksRUFBRSxFQUMzQyxDQUFDLE1BQU0sRUFBRSxFQUFFO29CQUNULE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO29CQUMzQyxLQUFLLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDaEMsQ0FBQyxDQUNGLENBQUM7Z0JBQ0YsS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLEVBQUUsR0FBRyxFQUFFLEtBQWUsRUFBRSxLQUFLLEVBQUUsUUFBNkIsRUFBRSxDQUFDLENBQUM7Z0JBQzNGLE9BQU8sUUFBUSxDQUFDO1lBQ2xCLENBQUM7WUFFRCxxRUFBcUU7WUFDckUsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDMUMsSUFBSSxNQUFNLElBQUksTUFBTSxDQUFDLEdBQUcsS0FBSyxLQUFLO2dCQUFFLE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQztZQUV4RCxNQUFNLE1BQU0sR0FBRyxpQkFBaUIsQ0FDOUIsS0FBZ0MsRUFDaEMsSUFBSSxFQUNKLEVBQUUsRUFDRixNQUFNLEVBQ04sVUFBVSxFQUNWLEtBQUssRUFDTCxJQUFJLEdBQUcsQ0FBUyxDQUFDLEtBQWUsQ0FBQyxDQUFDLENBQ25DLENBQUM7WUFDRixLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsRUFBRSxHQUFHLEVBQUUsS0FBZSxFQUFFLEtBQUssRUFBRSxNQUFnQixFQUFFLENBQUMsQ0FBQztZQUM5RSxPQUFPLE1BQU0sQ0FBQztRQUNoQixDQUFDO1FBRUQsR0FBRyxDQUFDLFlBQVksRUFBRSxJQUFJLEVBQUUsS0FBSztZQUMzQixJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVE7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDMUMsSUFBSSxrQkFBa0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFDakMsTUFBTSxJQUFJLEtBQUssQ0FDYix5QkFBeUIsSUFBSSxzR0FBc0csQ0FDcEksQ0FBQztZQUNKLENBQUM7WUFDRCw0RUFBNEU7WUFDNUUsMEVBQTBFO1lBQzFFLE1BQU0sU0FBUyxHQUFHLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNyQyxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQztZQUNqQyxLQUFLLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLG1CQUFtQjtZQUNsRCxPQUFPLElBQUksQ0FBQztRQUNkLENBQUM7UUFFRCxjQUFjLENBQUMsWUFBWSxFQUFFLElBQUk7WUFDL0IsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRO2dCQUFFLE9BQU8sSUFBSSxDQUFDO1lBQzFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDekIsS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDOUIsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO1FBRUQsR0FBRyxDQUFDLFlBQVksRUFBRSxJQUFJO1lBQ3BCLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUTtnQkFBRSxPQUFPLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFDN0YsSUFBSSxrQkFBa0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDO2dCQUFFLE9BQU8sSUFBSSxDQUFDO1lBQzlDLHNFQUFzRTtZQUN0RSxJQUFJLE1BQU0sQ0FBQyxNQUFNO2dCQUFFLE9BQU8sTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUM5QyxJQUFJLE1BQU0sQ0FBQyxZQUFZO2dCQUFFLE9BQU8sTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNyRSwyREFBMkQ7WUFDM0QsT0FBTyxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLFNBQVMsQ0FBQztRQUM3QyxDQUFDO1FBRUQsT0FBTztZQUNMLDREQUE0RDtZQUM1RCxJQUFJLE1BQU0sQ0FBQyxZQUFZO2dCQUFFLE9BQU8sTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3RELE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxRQUFRLEVBQXlDLENBQUM7WUFDMUUsSUFBSSxDQUFDLFFBQVEsSUFBSSxPQUFPLFFBQVEsS0FBSyxRQUFRO2dCQUFFLE9BQU8sRUFBRSxDQUFDO1lBQ3pELE9BQU8sTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUMvQixDQUFDO1FBRUQsd0JBQXdCLENBQUMsWUFBWSxFQUFFLElBQUk7WUFDekMsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRO2dCQUFFLE9BQU8sU0FBUyxDQUFDO1lBQy9DLElBQUksa0JBQWtCLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQztnQkFBRSxPQUFPLFNBQVMsQ0FBQyxDQUFDLCtCQUErQjtZQUNuRixnRUFBZ0U7WUFDaEUsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLE1BQU07Z0JBQzFCLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQztnQkFDckIsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxZQUFZO29CQUNyQixDQUFDLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUM7b0JBQ3RDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLFNBQVMsQ0FBQyxDQUFDLGdCQUFnQjtZQUN6RCxJQUFJLENBQUMsTUFBTTtnQkFBRSxPQUFPLFNBQVMsQ0FBQztZQUM5Qix5RUFBeUU7WUFDekUsT0FBTyxFQUFFLFlBQVksRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFDbEUsQ0FBQztLQUNGLENBQUMsQ0FBQztJQUVILE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogcmVhY3RpdmUvY3JlYXRlVHlwZWRTY29wZSAtLSBDb3JlIFByb3h5IGZhY3RvcnkgZm9yIFR5cGVkU2NvcGU8VD4uXG4gKlxuICogV3JhcHMgYSBSZWFjdGl2ZVRhcmdldCAoU2NvcGVGYWNhZGUpIGluIGEgUHJveHkgdGhhdCBwcm92aWRlczpcbiAqIC0gVHlwZWQgcHJvcGVydHkgYWNjZXNzOiBzY29wZS5jcmVkaXRUaWVyIChyZWFkKSwgc2NvcGUuY3JlZGl0VGllciA9ICdBJyAod3JpdGUpXG4gKiAtIERlZXAgd3JpdGUgaW50ZXJjZXB0aW9uOiBzY29wZS5jdXN0b21lci5hZGRyZXNzLnppcCA9ICc5MDIxMCdcbiAqIC0gQXJyYXkgbXV0YXRpb24gaW50ZXJjZXB0aW9uOiBzY29wZS5pdGVtcy5wdXNoKCduZXcnKVxuICogLSAkLXByZWZpeGVkIGVzY2FwZSBoYXRjaGVzOiAkZ2V0VmFsdWUsICRzZXRWYWx1ZSwgJHJlYWQsICRnZXRBcmdzLCBldGMuXG4gKlxuICogUmVhZCBzZW1hbnRpY3M6IHRvcC1sZXZlbCBnZXQgY2FsbHMgZ2V0VmFsdWUoKSAoZmlyZXMgb25SZWFkIE9OQ0UpLlxuICogICBOZXN0ZWQgZ2V0IHRyYXBzIG5hdmlnYXRlIGluLW1lbW9yeSAtLSBubyBhZGRpdGlvbmFsIG9uUmVhZC5cbiAqXG4gKiBXcml0ZSBzZW1hbnRpY3M6IHRvcC1sZXZlbCBzZXQgY2FsbHMgc2V0VmFsdWUoKS4gTmVzdGVkIHNldCBjYWxsc1xuICogICB1cGRhdGVWYWx1ZSgpIHdpdGggYSBwYXJ0aWFsIG9iamVjdCBidWlsdCBmcm9tIHRoZSBhY2N1bXVsYXRlZCBwYXRoLlxuICovXG5cbmltcG9ydCB7IG5hdGl2ZUdldCBhcyBsb2Rhc2hHZXQgfSBmcm9tICcuLi9tZW1vcnkvcGF0aE9wcy5qcyc7XG5pbXBvcnQgeyBzaG91bGRXcmFwV2l0aFByb3h5IH0gZnJvbSAnLi9hbGxvd2xpc3QuanMnO1xuaW1wb3J0IHsgY3JlYXRlQXJyYXlQcm94eSB9IGZyb20gJy4vYXJyYXlUcmFwcy5qcyc7XG5pbXBvcnQgeyBidWlsZE5lc3RlZFBhdGNoIH0gZnJvbSAnLi9wYXRoQnVpbGRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlYWN0aXZlT3B0aW9ucywgUmVhY3RpdmVUYXJnZXQsIFR5cGVkU2NvcGUgfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IEJSRUFLX1NFVFRFUiwgRVhFQ1VUT1JfSU5URVJOQUxfTUVUSE9EUywgSVNfVFlQRURfU0NPUEUsIFNDT1BFX01FVEhPRF9OQU1FUyB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLSBQcm94eSB1bndyYXBwaW5nIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBzdHJ1Y3R1cmVkQ2xvbmUgaW4gVHJhbnNhY3Rpb25CdWZmZXIgY2Fubm90IGNsb25lIFByb3h5IG9iamVjdHMuXG4vLyBXaGVuIGEgdXNlciBkb2VzIGBzY29wZS5iYWNrdXAgPSBzY29wZS5jdXN0b21lcmAsIHRoZSB2YWx1ZSBpcyBhIFByb3h5LlxuLy8gVW53cmFwIHRvIGEgcGxhaW4gb2JqZWN0IGJlZm9yZSBzdG9yaW5nLlxuXG5mdW5jdGlvbiB1bndyYXBQcm94eSh2YWx1ZTogdW5rbm93bik6IHVua25vd24ge1xuICBpZiAodmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHZhbHVlO1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIHZhbHVlO1xuICAvLyBGYXN0IHBhdGg6IHBsYWluIG9iamVjdHMgYW5kIGFycmF5cyBkb24ndCBuZWVkIHVud3JhcHBpbmdcbiAgdHJ5IHtcbiAgICAvLyBKU09OIHJvdW5kLXRyaXAgc3RyaXBzIFByb3hpZXMuIFNhZmUgYmVjYXVzZSBzdGF0ZSB2YWx1ZXMgbXVzdCBiZSBKU09OLXNlcmlhbGl6YWJsZS5cbiAgICByZXR1cm4gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tc2VyaWFsaXphYmxlIChmdW5jdGlvbnMsIHN5bWJvbHMsIGV0Yy4pIOKAlCByZXR1cm4gYXMtaXNcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn1cblxuLy8gLS0gJC1tZXRob2Qgcm91dGluZyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG50eXBlIE1ldGhvZFJvdXRlciA9ICh0YXJnZXQ6IFJlYWN0aXZlVGFyZ2V0LCBvcHRzOiBSZWFjdGl2ZVN0YXRlKSA9PiB1bmtub3duO1xuXG5jb25zdCBNRVRIT0RfUk9VVEVTOiBSZWNvcmQ8c3RyaW5nLCBNZXRob2RSb3V0ZXI+ID0ge1xuICAkZ2V0VmFsdWU6ICh0KSA9PiB0LmdldFZhbHVlLmJpbmQodCksXG4gICRzZXRWYWx1ZTogKHQpID0+IHQuc2V0VmFsdWUuYmluZCh0KSxcbiAgJHVwZGF0ZTogKHQpID0+IHQudXBkYXRlVmFsdWUuYmluZCh0KSxcbiAgJGRlbGV0ZTogKHQpID0+IHQuZGVsZXRlVmFsdWUuYmluZCh0KSxcbiAgJHJlYWQ6ICh0KSA9PiAoZG90UGF0aDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3Qgcm9vdEtleSA9IGRvdFBhdGguc3BsaXQoJy4nKVswXTtcbiAgICBjb25zdCB2YWx1ZSA9IHQuZ2V0VmFsdWUocm9vdEtleSk7XG4gICAgaWYgKCFkb3RQYXRoLmluY2x1ZGVzKCcuJykpIHJldHVybiB2YWx1ZTtcbiAgICByZXR1cm4gbG9kYXNoR2V0KHZhbHVlLCBkb3RQYXRoLnNsaWNlKHJvb3RLZXkubGVuZ3RoICsgMSkpO1xuICB9LFxuICAkZ2V0QXJnczogKHQpID0+IHQuZ2V0QXJncy5iaW5kKHQpLFxuICAkZ2V0RW52OiAodCkgPT4gdC5nZXRFbnYuYmluZCh0KSxcbiAgJGRlYnVnOiAodCkgPT4gdC5hZGREZWJ1Z0luZm8uYmluZCh0KSxcbiAgJGxvZzogKHQpID0+IHQuYWRkRGVidWdNZXNzYWdlLmJpbmQodCksXG4gICRlcnJvcjogKHQpID0+IHQuYWRkRXJyb3JJbmZvLmJpbmQodCksXG4gICRtZXRyaWM6ICh0KSA9PiB0LmFkZE1ldHJpYy5iaW5kKHQpLFxuICAkZXZhbDogKHQpID0+IHQuYWRkRXZhbC5iaW5kKHQpLFxuICAkYXR0YWNoU2NvcGVSZWNvcmRlcjogKHQpID0+IHQuYXR0YWNoU2NvcGVSZWNvcmRlci5iaW5kKHQpLFxuICAkZGV0YWNoU2NvcGVSZWNvcmRlcjogKHQpID0+IHQuZGV0YWNoU2NvcGVSZWNvcmRlci5iaW5kKHQpLFxuICAkZ2V0U2NvcGVSZWNvcmRlcnM6ICh0KSA9PiB0LmdldFNjb3BlUmVjb3JkZXJzLmJpbmQodCksXG4gICRiYXRjaEFycmF5OiAodCkgPT4gKGtleTogc3RyaW5nLCBmbjogKGFycjogdW5rbm93bltdKSA9PiB2b2lkKSA9PiB7XG4gICAgLy8gT25lIGdldFZhbHVlIOKAlCBmaXJlcyBvblJlYWQgb25jZVxuICAgIGNvbnN0IGN1cnJlbnQgPSB0LmdldFZhbHVlKGtleSk7XG4gICAgLy8gQ2xvbmUgb25jZSAob3Igc3RhcnQgZW1wdHkgaWYgbWlzc2luZy9ub24tYXJyYXkpXG4gICAgY29uc3QgY2xvbmU6IHVua25vd25bXSA9IEFycmF5LmlzQXJyYXkoY3VycmVudCkgPyBbLi4uY3VycmVudF0gOiBbXTtcbiAgICAvLyBVc2VyIGFwcGxpZXMgYWxsIG11dGF0aW9ucyB0byB0aGUgcGxhaW4gY2xvbmUg4oCUIG5vIFByb3h5LCBubyBwZXItbXV0YXRpb24gY29tbWl0XG4gICAgZm4oY2xvbmUpO1xuICAgIC8vIE9uZSBzZXRWYWx1ZSDigJQgZmlyZXMgb25Xcml0ZSBvbmNlIHdpdGggdGhlIGZpbmFsIGFycmF5XG4gICAgdC5zZXRWYWx1ZShrZXksIGNsb25lKTtcbiAgfSxcbiAgJGJyZWFrOiAoX3QsIG9wdHMpID0+IChyZWFzb24/OiBzdHJpbmcpID0+IHtcbiAgICBpZiAoIW9wdHMuYnJlYWtGbikgdGhyb3cgbmV3IEVycm9yKCckYnJlYWsoKSBpcyBub3QgYXZhaWxhYmxlIG91dHNpZGUgc3RhZ2UgZXhlY3V0aW9uJyk7XG4gICAgb3B0cy5icmVha0ZuKHJlYXNvbik7XG4gIH0sXG4gIC8vIE9ic2VydmFiaWxpdHkg4oCUIEVtaXQgY2hhbm5lbCAoUGhhc2UgMykuIFJvdXRlcyB0byBTY29wZUZhY2FkZS5lbWl0RXZlbnRcbiAgLy8gd2hpY2ggaGFuZGxlcyBmYXN0LXBhdGgsIGVucmljaG1lbnQsIHJlZGFjdGlvbiwgYW5kIGVycm9yIGlzb2xhdGlvbi5cbiAgJGVtaXQ6ICh0KSA9PiB0LmVtaXRFdmVudC5iaW5kKHQpLFxuICAvLyBEZXRhY2ggKFQ0KSDigJQgZmlyZS1hbmQtZm9yZ2V0IGNoaWxkIGZsb3djaGFydHMuIERlbGVnYXRlcyB0byBTY29wZUZhY2FkZVxuICAvLyB3aGljaCBtaW50ZWQgcmVmSWRzIGZyb20gcnVudGltZVN0YWdlSWQuXG4gICRkZXRhY2hBbmRKb2luTGF0ZXI6ICh0KSA9PiB0LmRldGFjaEFuZEpvaW5MYXRlci5iaW5kKHQpLFxuICAkZGV0YWNoQW5kRm9yZ2V0OiAodCkgPT4gdC5kZXRhY2hBbmRGb3JnZXQuYmluZCh0KSxcbiAgJHRvUmF3OiAodCkgPT4gKCkgPT4gdCxcbn07XG5cbi8vIC0tIEd1YXJkIHByb3BlcnRpZXMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRoZXNlIG11c3QgYmUgaGFuZGxlZCB0byBwcmV2ZW50IFByb3h5IGZyb20gYmVpbmcgdHJlYXRlZCBhcyBhIFByb21pc2UsXG4vLyBicmVha2luZyBpbnN0YW5jZW9mIGNoZWNrcywgb3IgY29uZnVzaW5nIHRlc3QgbWF0Y2hlcnMuXG5cbmNvbnN0IEdVQVJEX1BST1BTOiBSZWNvcmQ8c3RyaW5nIHwgc3ltYm9sLCB1bmtub3duPiA9IHtcbiAgdGhlbjogdW5kZWZpbmVkLCAvLyBwcmV2ZW50IFByb21pc2UgZGV0ZWN0aW9uXG4gIGFzeW1tZXRyaWNNYXRjaDogdW5kZWZpbmVkLCAvLyBwcmV2ZW50IHZpdGVzdC9qZXN0IG1hdGNoZXIgY29uZnVzaW9uXG4gIGNvbnN0cnVjdG9yOiBPYmplY3QsIC8vIHNhZmUgcHJvdG90eXBlXG4gIFtTeW1ib2wudG9TdHJpbmdUYWddOiAnVHlwZWRTY29wZScsXG59O1xuXG4vLyAtLSBNdXRhYmxlIHN0YXRlIHBlciBwcm94eSBpbnN0YW5jZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBSZWFjdGl2ZVN0YXRlIHtcbiAgYnJlYWtGbj86IChyZWFzb24/OiBzdHJpbmcpID0+IHZvaWQ7XG4gIC8qKiBDYWNoZTogdG9wLWxldmVsIGtleSAtPiB7IHJhdyBvYmplY3QgcmVmLCBjaGlsZCBwcm94eSB9ICovXG4gIGNoaWxkQ2FjaGU6IE1hcDxzdHJpbmcsIHsgcmVmOiBvYmplY3Q7IHByb3h5OiBvYmplY3QgfT47XG59XG5cbi8vIC0tIE5lc3RlZCBjaGlsZCBwcm94eSAoZm9yIGRlZXAgd3JpdGUgaW50ZXJjZXB0aW9uKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vXG4vLyBDeWNsZSBzYWZldHk6IGFuIGltbXV0YWJsZSBTZXQ8b2JqZWN0PiBvZiBhbmNlc3RvciBvYmplY3RzIGlzIHBhc3NlZCBkb3duXG4vLyBlYWNoIGFjY2VzcyBjaGFpbi4gRWFjaCBicmFuY2ggZ2V0cyBpdHMgb3duIGNvcHkgKG5ldyBTZXQocGFyZW50KSkgc29cbi8vIHNjb3BlLnguZnJpZW5kIGFuZCBzY29wZS54LmNvd29ya2VyIGRvbid0IHBvbGx1dGUgZWFjaCBvdGhlcidzIHRyYWNraW5nLlxuLy8gV2hlbiBhIGNoaWxkIHZhbHVlIGlzIGFscmVhZHkgaW4gdGhlIGFuY2VzdG9yIHNldCwgd2UndmUgaGl0IGEgY3ljbGUuXG4vLyBBdCB0aGUgY3ljbGUgYnJlYWs6IHJldHVybiBhIHRlcm1pbmFsIHByb3h5IHRoYXQgdHJhY2tzIHdyaXRlcyAoc2V0IHRyYXBcbi8vIHN0aWxsIGJ1aWxkcyBwYXRoICsgY2FsbHMgdXBkYXRlVmFsdWUpIGJ1dCBkb2Vzbid0IHJlY3Vyc2UgcmVhZHMgZnVydGhlci5cblxuZnVuY3Rpb24gY3JlYXRlVGVybWluYWxQcm94eShcbiAgb2JqOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgcm9vdEtleTogc3RyaW5nLFxuICBzZWdtZW50czogc3RyaW5nW10sXG4gIHRhcmdldDogUmVhY3RpdmVUYXJnZXQsXG4gIHN0YXRlOiBSZWFjdGl2ZVN0YXRlLFxuICB2aXNpdGVkOiBTZXQ8b2JqZWN0PiA9IG5ldyBTZXQoKSxcbik6IHVua25vd24ge1xuICB2aXNpdGVkLmFkZChvYmopO1xuXG4gIHJldHVybiBuZXcgUHJveHkob2JqLCB7XG4gICAgZ2V0KHJhdywgcHJvcCkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wID09PSAnc3ltYm9sJykgcmV0dXJuIChyYXcgYXMgYW55KVtwcm9wXTtcbiAgICAgIGlmIChwcm9wID09PSAndGhlbicpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2FzeW1tZXRyaWNNYXRjaCcpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2NvbnN0cnVjdG9yJykgcmV0dXJuIE9iamVjdDtcbiAgICAgIGlmIChwcm9wID09PSAndG9KU09OJylcbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAvLyBTdHJpcCBvYmplY3QtdHlwZWQgdmFsdWVzIHRvIHByZXZlbnQgY2lyY3VsYXIgSlNPTiBlcnJvcnNcbiAgICAgICAgICBjb25zdCBzYWZlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhyYXcpKSB7XG4gICAgICAgICAgICBjb25zdCB2ID0gKHJhdyBhcyBhbnkpW2tdO1xuICAgICAgICAgICAgaWYgKHYgPT09IG51bGwgfHwgdHlwZW9mIHYgIT09ICdvYmplY3QnKSBzYWZlW2tdID0gdjtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHNhZmU7XG4gICAgICAgIH07XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gKHJhdyBhcyBhbnkpW3Byb3BdO1xuXG4gICAgICAvLyBDb250aW51ZSB0cmFja2luZyB3cml0ZXMgYXQgZGVlcGVyIGxldmVscyB2aWEgY2hhaW5lZCB0ZXJtaW5hbCBwcm94aWVzLlxuICAgICAgLy8gVXNlIHZpc2l0ZWQgc2V0IHRvIHByZXZlbnQgcmUtZW50ZXJpbmcgdGhlIHNhbWUgb2JqZWN0IChjeWNsZSBpbiB0ZXJtaW5hbCBjaGFpbikuXG4gICAgICBpZiAoc2hvdWxkV3JhcFdpdGhQcm94eSh2YWx1ZSkgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpICYmICF2aXNpdGVkLmhhcyh2YWx1ZSBhcyBvYmplY3QpKSB7XG4gICAgICAgIHJldHVybiBjcmVhdGVUZXJtaW5hbFByb3h5KFxuICAgICAgICAgIHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICAgIHJvb3RLZXksXG4gICAgICAgICAgWy4uLnNlZ21lbnRzLCBwcm9wIGFzIHN0cmluZ10sXG4gICAgICAgICAgdGFyZ2V0LFxuICAgICAgICAgIHN0YXRlLFxuICAgICAgICAgIHZpc2l0ZWQsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9LFxuICAgIHNldChyYXcsIHByb3AsIHZhbHVlKSB7XG4gICAgICBpZiAodHlwZW9mIHByb3AgIT09ICdzdHJpbmcnKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGNvbnN0IGNoaWxkU2VnbWVudHMgPSBbLi4uc2VnbWVudHMsIHByb3BdO1xuICAgICAgY29uc3QgcGF0Y2ggPSBidWlsZE5lc3RlZFBhdGNoKGNoaWxkU2VnbWVudHMsIHVud3JhcFByb3h5KHZhbHVlKSk7XG4gICAgICB0YXJnZXQudXBkYXRlVmFsdWUocm9vdEtleSwgcGF0Y2gpO1xuICAgICAgc3RhdGUuY2hpbGRDYWNoZS5kZWxldGUocm9vdEtleSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTmVzdGVkUHJveHkoXG4gIG9iajogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIHJvb3RLZXk6IHN0cmluZyxcbiAgc2VnbWVudHM6IHN0cmluZ1tdLFxuICB0YXJnZXQ6IFJlYWN0aXZlVGFyZ2V0LFxuICByZWFkU2lsZW50OiAoa2V5Pzogc3RyaW5nKSA9PiB1bmtub3duLFxuICBzdGF0ZTogUmVhY3RpdmVTdGF0ZSxcbiAgYW5jZXN0b3JzOiBTZXQ8b2JqZWN0PiA9IG5ldyBTZXQoKSxcbik6IHVua25vd24ge1xuICByZXR1cm4gbmV3IFByb3h5KG9iaiwge1xuICAgIGdldChyYXcsIHByb3ApIHtcbiAgICAgIGlmICh0eXBlb2YgcHJvcCA9PT0gJ3N5bWJvbCcpIHJldHVybiAocmF3IGFzIGFueSlbcHJvcF07XG5cbiAgICAgIC8vIEd1YXJkIHByb3BlcnRpZXNcbiAgICAgIGlmIChwcm9wID09PSAndGhlbicpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2FzeW1tZXRyaWNNYXRjaCcpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2NvbnN0cnVjdG9yJykgcmV0dXJuIE9iamVjdDtcbiAgICAgIGlmIChwcm9wID09PSAndG9KU09OJylcbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAvLyBTdHJpcCBvYmplY3QtdHlwZWQgdmFsdWVzIHRvIHByZXZlbnQgY2lyY3VsYXIgSlNPTiBlcnJvcnNcbiAgICAgICAgICBjb25zdCBzYWZlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhyYXcpKSB7XG4gICAgICAgICAgICBjb25zdCB2ID0gKHJhdyBhcyBhbnkpW2tdO1xuICAgICAgICAgICAgaWYgKHYgPT09IG51bGwgfHwgdHlwZW9mIHYgIT09ICdvYmplY3QnKSBzYWZlW2tdID0gdjtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHNhZmU7XG4gICAgICAgIH07XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gKHJhdyBhcyBhbnkpW3Byb3BdO1xuXG4gICAgICAvLyBQcmltaXRpdmUgb3Igbm9uLXdyYXBwYWJsZSAtLSByZXR1cm4gYXMtaXMgKG5vIGRlZXBlciBwcm94eSlcbiAgICAgIGlmICghc2hvdWxkV3JhcFdpdGhQcm94eSh2YWx1ZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgY29uc3QgY2hpbGRTZWdtZW50cyA9IFsuLi5zZWdtZW50cywgcHJvcCBhcyBzdHJpbmddO1xuXG4gICAgICAvLyBBcnJheSAtLSByZXR1cm4gYXJyYXkgcHJveHlcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gY3JlYXRlQXJyYXlQcm94eShcbiAgICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFNpbGVudChyb290S2V5KSBhcyBhbnk7XG4gICAgICAgICAgICByZXR1cm4gbG9kYXNoR2V0KGN1cnJlbnQsIGNoaWxkU2VnbWVudHMuam9pbignLicpKSA/PyBbXTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIChuZXdBcnIpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHBhdGNoID0gYnVpbGROZXN0ZWRQYXRjaChjaGlsZFNlZ21lbnRzLCB1bndyYXBQcm94eShuZXdBcnIpKTtcbiAgICAgICAgICAgIHRhcmdldC51cGRhdGVWYWx1ZShyb290S2V5LCBwYXRjaCk7XG4gICAgICAgICAgICBzdGF0ZS5jaGlsZENhY2hlLmRlbGV0ZShyb290S2V5KTtcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBDeWNsZSBkZXRlY3Rpb246IGlmIHRoaXMgdmFsdWUgaXMgYW4gYW5jZXN0b3IgaW4gdGhlIGN1cnJlbnQgYWNjZXNzXG4gICAgICAvLyBjaGFpbiwgcmV0dXJuIGEgdGVybWluYWwgcHJveHkgKHRyYWNrcyB3cml0ZXMsIHN0b3BzIHJlY3Vyc2luZyByZWFkcykuXG4gICAgICBpZiAoYW5jZXN0b3JzLmhhcyh2YWx1ZSBhcyBvYmplY3QpKSB7XG4gICAgICAgIHJldHVybiBjcmVhdGVUZXJtaW5hbFByb3h5KHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCByb290S2V5LCBjaGlsZFNlZ21lbnRzLCB0YXJnZXQsIHN0YXRlKTtcbiAgICAgIH1cblxuICAgICAgLy8gQnVpbGQgbmV3IGFuY2VzdG9yIHNldCBmb3IgdGhpcyBicmFuY2ggKGltbXV0YWJsZSAtLSBubyBjcm9zcy1icmFuY2ggcG9sbHV0aW9uKVxuICAgICAgY29uc3QgY2hpbGRBbmNlc3RvcnMgPSBuZXcgU2V0KGFuY2VzdG9ycyk7XG4gICAgICBjaGlsZEFuY2VzdG9ycy5hZGQodmFsdWUgYXMgb2JqZWN0KTtcblxuICAgICAgcmV0dXJuIGNyZWF0ZU5lc3RlZFByb3h5KFxuICAgICAgICB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICAgICAgcm9vdEtleSxcbiAgICAgICAgY2hpbGRTZWdtZW50cyxcbiAgICAgICAgdGFyZ2V0LFxuICAgICAgICByZWFkU2lsZW50LFxuICAgICAgICBzdGF0ZSxcbiAgICAgICAgY2hpbGRBbmNlc3RvcnMsXG4gICAgICApO1xuICAgIH0sXG5cbiAgICBzZXQocmF3LCBwcm9wLCB2YWx1ZSkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wICE9PSAnc3RyaW5nJykgcmV0dXJuIHRydWU7XG5cbiAgICAgIGNvbnN0IGNoaWxkU2VnbWVudHMgPSBbLi4uc2VnbWVudHMsIHByb3BdO1xuICAgICAgY29uc3QgcGF0Y2ggPSBidWlsZE5lc3RlZFBhdGNoKGNoaWxkU2VnbWVudHMsIHVud3JhcFByb3h5KHZhbHVlKSk7XG4gICAgICB0YXJnZXQudXBkYXRlVmFsdWUocm9vdEtleSwgcGF0Y2gpO1xuICAgICAgc3RhdGUuY2hpbGRDYWNoZS5kZWxldGUocm9vdEtleSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICB9KTtcbn1cblxuLy8gLS0gVG9wLWxldmVsIHByb3h5ICh0aGUgbWFpbiBUeXBlZFNjb3BlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIENyZWF0ZXMgYSBUeXBlZFNjb3BlPFQ+IHByb3h5IHdyYXBwaW5nIGEgUmVhY3RpdmVUYXJnZXQuXG4gKlxuICogQHBhcmFtIHRhcmdldCAtIFRoZSB1bmRlcmx5aW5nIHNjb3BlIChTY29wZUZhY2FkZSBvciBhbnkgUmVhY3RpdmVUYXJnZXQpXG4gKiBAcGFyYW0gb3B0aW9ucyAtIE9wdGlvbmFsIGNvbmZpZ3VyYXRpb24gKGJyZWFrUGlwZWxpbmUgaW5qZWN0aW9uKVxuICogQHJldHVybnMgQSBQcm94eSB3aXRoIHR5cGVkIHByb3BlcnR5IGFjY2VzcyBhbmQgJC1wcmVmaXhlZCBtZXRob2RzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVUeXBlZFNjb3BlPFQgZXh0ZW5kcyBvYmplY3Q+KHRhcmdldDogUmVhY3RpdmVUYXJnZXQsIG9wdGlvbnM/OiBSZWFjdGl2ZU9wdGlvbnMpOiBUeXBlZFNjb3BlPFQ+IHtcbiAgY29uc3Qgc3RhdGU6IFJlYWN0aXZlU3RhdGUgPSB7XG4gICAgYnJlYWtGbjogb3B0aW9ucz8uYnJlYWtQaXBlbGluZSxcbiAgICBjaGlsZENhY2hlOiBuZXcgTWFwKCksXG4gIH07XG5cbiAgLy8gQmluZCBzaWxlbnQtcmVhZCBtZXRob2Qgb25jZSDigJQgYXZvaWRzIHBlci1jYWxsID8/ICsgLmNhbGwoKSBpbiBhcnJheSBwcm94eSBnZXRDdXJyZW50IGNsb3N1cmVzXG4gIGNvbnN0IHJlYWRTaWxlbnQgPSAodGFyZ2V0LmdldFZhbHVlU2lsZW50ID8/IHRhcmdldC5nZXRWYWx1ZSkuYmluZCh0YXJnZXQpO1xuXG4gIGNvbnN0IHByb3h5ID0gbmV3IFByb3h5KHRhcmdldCBhcyB1bmtub3duIGFzIFR5cGVkU2NvcGU8VD4sIHtcbiAgICBnZXQoX3Byb3h5VGFyZ2V0LCBwcm9wLCBfcmVjZWl2ZXIpIHtcbiAgICAgIC8vIDEuIEludGVybmFsIHN5bWJvbHMgKGNoZWNrIGJlZm9yZSBvdGhlciBzeW1ib2xzKVxuICAgICAgaWYgKHByb3AgPT09IElTX1RZUEVEX1NDT1BFKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGlmIChwcm9wID09PSBCUkVBS19TRVRURVIpIHtcbiAgICAgICAgcmV0dXJuIChmbjogKCkgPT4gdm9pZCkgPT4ge1xuICAgICAgICAgIHN0YXRlLmJyZWFrRm4gPSBmbjtcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gMi4gU3ltYm9sIHByb3BlcnRpZXMgKGd1YXJkICsgaW5zcGVjdGlvbilcbiAgICAgIGlmICh0eXBlb2YgcHJvcCA9PT0gJ3N5bWJvbCcpIHtcbiAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChHVUFSRF9QUk9QUywgcHJvcCkpIHJldHVybiBHVUFSRF9QUk9QU1twcm9wXTtcbiAgICAgICAgLy8gTm9kZS5qcyB1dGlsLmluc3BlY3Qg4oCUIHNob3cgc3RhdGUgc25hcHNob3QsIG5vdCBwcm94eSBpbnRlcm5hbHNcbiAgICAgICAgaWYgKHByb3AgPT09IFN5bWJvbC5mb3IoJ25vZGVqcy51dGlsLmluc3BlY3QuY3VzdG9tJykpIHtcbiAgICAgICAgICByZXR1cm4gKCkgPT4gdGFyZ2V0LmdldFZhbHVlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgLy8gMy4gU3RyaW5nIGd1YXJkIHByb3BlcnRpZXNcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoR1VBUkRfUFJPUFMsIHByb3ApKSByZXR1cm4gR1VBUkRfUFJPUFNbcHJvcF07XG5cbiAgICAgIC8vIDQuICQtcHJlZml4ZWQgbWV0aG9kcyAtLSByb3V0ZSB0byBmYWNhZGVcbiAgICAgIGlmIChTQ09QRV9NRVRIT0RfTkFNRVMuaGFzKHByb3ApKSB7XG4gICAgICAgIGNvbnN0IHJvdXRlciA9IE1FVEhPRF9ST1VURVNbcHJvcF07XG4gICAgICAgIGlmIChyb3V0ZXIpIHJldHVybiByb3V0ZXIodGFyZ2V0LCBzdGF0ZSk7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIC8vIDUuIEV4ZWN1dG9yLWludGVybmFsIG1ldGhvZCBwYXNzLXRocm91Z2ggKGV4cGxpY2l0IGFsbG93bGlzdClcbiAgICAgIC8vICAgIEZsb3dDaGFydEV4ZWN1dG9yIHdyYXBwaW5nIGNhbGxzIGF0dGFjaFNjb3BlUmVjb3JkZXIsIG5vdGlmeVN0YWdlU3RhcnQsIGV0Yy5cbiAgICAgIC8vICAgIGRpcmVjdGx5IG9uIHRoZSBzY29wZS4gRm9yd2FyZCBvbmx5IGFsbG93bGlzdGVkIG1ldGhvZHMuXG4gICAgICBpZiAoRVhFQ1VUT1JfSU5URVJOQUxfTUVUSE9EUy5oYXMocHJvcCkgJiYgdHlwZW9mICh0YXJnZXQgYXMgYW55KVtwcm9wXSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICByZXR1cm4gKHRhcmdldCBhcyBhbnkpW3Byb3BdLmJpbmQodGFyZ2V0KTtcbiAgICAgIH1cblxuICAgICAgLy8gNi4gU3RhdGUga2V5IC0tIGNhbGwgZ2V0VmFsdWUgKGZpcmVzIG9uUmVhZCBPTkNFKVxuICAgICAgY29uc3QgdmFsdWUgPSB0YXJnZXQuZ2V0VmFsdWUocHJvcCk7XG5cbiAgICAgIC8vIFByaW1pdGl2ZSBvciBudWxsL3VuZGVmaW5lZCAtLSByZXR1cm4gYXMtaXNcbiAgICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgfVxuXG4gICAgICAvLyBOb24td3JhcHBhYmxlIChEYXRlLCBNYXAsIGNsYXNzIGluc3RhbmNlLCBldGMuKSAtLSByZXR1cm4gdW53cmFwcGVkXG4gICAgICBpZiAoIXNob3VsZFdyYXBXaXRoUHJveHkodmFsdWUpKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgIC8vIEFycmF5IC0tIHJldHVybiBhcnJheSBwcm94eSAoY2FjaGVkIGZvciBpZGVudGl0eSBlcXVhbGl0eSlcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICBjb25zdCBjYWNoZWQgPSBzdGF0ZS5jaGlsZENhY2hlLmdldChwcm9wKTtcbiAgICAgICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQucmVmID09PSB2YWx1ZSkgcmV0dXJuIGNhY2hlZC5wcm94eTtcblxuICAgICAgICBjb25zdCBhcnJQcm94eSA9IGNyZWF0ZUFycmF5UHJveHkoXG4gICAgICAgICAgKCkgPT4gKHJlYWRTaWxlbnQocHJvcCkgYXMgdW5rbm93bltdKSA/PyBbXSxcbiAgICAgICAgICAobmV3QXJyKSA9PiB7XG4gICAgICAgICAgICB0YXJnZXQuc2V0VmFsdWUocHJvcCwgdW53cmFwUHJveHkobmV3QXJyKSk7XG4gICAgICAgICAgICBzdGF0ZS5jaGlsZENhY2hlLmRlbGV0ZShwcm9wKTtcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgICBzdGF0ZS5jaGlsZENhY2hlLnNldChwcm9wLCB7IHJlZjogdmFsdWUgYXMgb2JqZWN0LCBwcm94eTogYXJyUHJveHkgYXMgdW5rbm93biBhcyBvYmplY3QgfSk7XG4gICAgICAgIHJldHVybiBhcnJQcm94eTtcbiAgICAgIH1cblxuICAgICAgLy8gUGxhaW4gb2JqZWN0IC0tIHJldHVybiBuZXN0ZWQgcHJveHkgKGNhY2hlZCBmb3IgaWRlbnRpdHkgZXF1YWxpdHkpXG4gICAgICBjb25zdCBjYWNoZWQgPSBzdGF0ZS5jaGlsZENhY2hlLmdldChwcm9wKTtcbiAgICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLnJlZiA9PT0gdmFsdWUpIHJldHVybiBjYWNoZWQucHJveHk7XG5cbiAgICAgIGNvbnN0IG5lc3RlZCA9IGNyZWF0ZU5lc3RlZFByb3h5KFxuICAgICAgICB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICAgICAgcHJvcCxcbiAgICAgICAgW10sXG4gICAgICAgIHRhcmdldCxcbiAgICAgICAgcmVhZFNpbGVudCxcbiAgICAgICAgc3RhdGUsXG4gICAgICAgIG5ldyBTZXQ8b2JqZWN0PihbdmFsdWUgYXMgb2JqZWN0XSksIC8vIHNlZWQgYW5jZXN0b3Igc2V0IHdpdGggcm9vdCBvYmplY3RcbiAgICAgICk7XG4gICAgICBzdGF0ZS5jaGlsZENhY2hlLnNldChwcm9wLCB7IHJlZjogdmFsdWUgYXMgb2JqZWN0LCBwcm94eTogbmVzdGVkIGFzIG9iamVjdCB9KTtcbiAgICAgIHJldHVybiBuZXN0ZWQ7XG4gICAgfSxcblxuICAgIHNldChfcHJveHlUYXJnZXQsIHByb3AsIHZhbHVlKSB7XG4gICAgICBpZiAodHlwZW9mIHByb3AgIT09ICdzdHJpbmcnKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGlmIChTQ09QRV9NRVRIT0RfTkFNRVMuaGFzKHByb3ApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQ2Fubm90IHNldCBzdGF0ZSBrZXkgXCIke3Byb3B9XCIgLS0gaXQgY29uZmxpY3RzIHdpdGggYSByZXNlcnZlZCBUeXBlZFNjb3BlIG1ldGhvZC4gUmVuYW1lIHRoZSBzdGF0ZSBrZXkgdG8gYXZvaWQgJC1wcmVmaXhlZCBuYW1lcy5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gVW53cmFwIFByb3h5IHZhbHVlcyBiZWZvcmUgc3RvcmluZyDigJQgc3RydWN0dXJlZENsb25lIGluIFRyYW5zYWN0aW9uQnVmZmVyXG4gICAgICAvLyBjYW5ub3QgY2xvbmUgUHJveHkgb2JqZWN0cy4gVGhpcyBoYW5kbGVzOiBzY29wZS5iYWNrdXAgPSBzY29wZS5jdXN0b21lclxuICAgICAgY29uc3QgdW53cmFwcGVkID0gdW53cmFwUHJveHkodmFsdWUpO1xuICAgICAgdGFyZ2V0LnNldFZhbHVlKHByb3AsIHVud3JhcHBlZCk7XG4gICAgICBzdGF0ZS5jaGlsZENhY2hlLmRlbGV0ZShwcm9wKTsgLy8gaW52YWxpZGF0ZSBjYWNoZVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcblxuICAgIGRlbGV0ZVByb3BlcnR5KF9wcm94eVRhcmdldCwgcHJvcCkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wICE9PSAnc3RyaW5nJykgcmV0dXJuIHRydWU7XG4gICAgICB0YXJnZXQuZGVsZXRlVmFsdWUocHJvcCk7XG4gICAgICBzdGF0ZS5jaGlsZENhY2hlLmRlbGV0ZShwcm9wKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG5cbiAgICBoYXMoX3Byb3h5VGFyZ2V0LCBwcm9wKSB7XG4gICAgICBpZiAodHlwZW9mIHByb3AgPT09ICdzeW1ib2wnKSByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKEdVQVJEX1BST1BTLCBwcm9wKTtcbiAgICAgIGlmIChTQ09QRV9NRVRIT0RfTkFNRVMuaGFzKHByb3ApKSByZXR1cm4gdHJ1ZTtcbiAgICAgIC8vIFVzZSBub24tdHJhY2tpbmcgaGFzS2V5IGlmIGF2YWlsYWJsZSwgZWxzZSBmYWxsYmFjayB0byBnZXRTdGF0ZUtleXNcbiAgICAgIGlmICh0YXJnZXQuaGFzS2V5KSByZXR1cm4gdGFyZ2V0Lmhhc0tleShwcm9wKTtcbiAgICAgIGlmICh0YXJnZXQuZ2V0U3RhdGVLZXlzKSByZXR1cm4gdGFyZ2V0LmdldFN0YXRlS2V5cygpLmluY2x1ZGVzKHByb3ApO1xuICAgICAgLy8gRmFsbGJhY2s6IGdldFZhbHVlIGZpcmVzIG9uUmVhZCAoYWNjZXB0YWJsZSBkZWdyYWRhdGlvbilcbiAgICAgIHJldHVybiB0YXJnZXQuZ2V0VmFsdWUocHJvcCkgIT09IHVuZGVmaW5lZDtcbiAgICB9LFxuXG4gICAgb3duS2V5cygpIHtcbiAgICAgIC8vIFVzZSBub24tdHJhY2tpbmcgZ2V0U3RhdGVLZXlzIGlmIGF2YWlsYWJsZSwgZWxzZSBmYWxsYmFja1xuICAgICAgaWYgKHRhcmdldC5nZXRTdGF0ZUtleXMpIHJldHVybiB0YXJnZXQuZ2V0U3RhdGVLZXlzKCk7XG4gICAgICBjb25zdCBzbmFwc2hvdCA9IHRhcmdldC5nZXRWYWx1ZSgpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKCFzbmFwc2hvdCB8fCB0eXBlb2Ygc25hcHNob3QgIT09ICdvYmplY3QnKSByZXR1cm4gW107XG4gICAgICByZXR1cm4gT2JqZWN0LmtleXMoc25hcHNob3QpO1xuICAgIH0sXG5cbiAgICBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoX3Byb3h5VGFyZ2V0LCBwcm9wKSB7XG4gICAgICBpZiAodHlwZW9mIHByb3AgIT09ICdzdHJpbmcnKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgaWYgKFNDT1BFX01FVEhPRF9OQU1FUy5oYXMocHJvcCkpIHJldHVybiB1bmRlZmluZWQ7IC8vICQtbWV0aG9kcyBhcmUgbm9uLWVudW1lcmFibGVcbiAgICAgIC8vIENoZWNrIGV4aXN0ZW5jZSB3aXRob3V0IGZpcmluZyBvblJlYWQg4oCUIG5vIGdldFZhbHVlIGNhbGwgaGVyZVxuICAgICAgY29uc3QgZXhpc3RzID0gdGFyZ2V0Lmhhc0tleVxuICAgICAgICA/IHRhcmdldC5oYXNLZXkocHJvcClcbiAgICAgICAgOiB0YXJnZXQuZ2V0U3RhdGVLZXlzXG4gICAgICAgID8gdGFyZ2V0LmdldFN0YXRlS2V5cygpLmluY2x1ZGVzKHByb3ApXG4gICAgICAgIDogdGFyZ2V0LmdldFZhbHVlKHByb3ApICE9PSB1bmRlZmluZWQ7IC8vIGZhbGxiYWNrIG9ubHlcbiAgICAgIGlmICghZXhpc3RzKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgLy8gUmV0dXJuIGEgbWluaW1hbCBkZXNjcmlwdG9yIOKAlCBhY3R1YWwgdmFsdWUgaXMgZmV0Y2hlZCB2aWEgdGhlIGdldCB0cmFwXG4gICAgICByZXR1cm4geyBjb25maWd1cmFibGU6IHRydWUsIGVudW1lcmFibGU6IHRydWUsIHdyaXRhYmxlOiB0cnVlIH07XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIHByb3h5O1xufVxuIl19