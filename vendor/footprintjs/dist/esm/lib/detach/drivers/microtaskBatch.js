/**
 * detach/drivers/microtaskBatch.ts — Batch detached work into ONE microtask.
 *
 * Pattern:  Producer-consumer with batched flush. Same shape as
 *           agentfootprint's `EventDispatcher` flush queue and the React
 *           reconciler's microtask scheduling — accumulate during the
 *           current sync slice, drain at the next microtask boundary.
 * Role:     Default driver for in-process detach. Cheapest scheduling
 *           primitive on V8/JSC: one `queueMicrotask` per batch
 *           regardless of how many work items, so the perf budget
 *           amortizes. Suitable for browser AND node AND edge runtimes
 *           (queueMicrotask is universal since 2018).
 *
 * Lifecycle:
 *
 *   schedule(child, input, refId)            ← driver entry
 *     └─ create handle (queued)
 *     └─ register in detachRegistry
 *     └─ push work item onto local queue
 *     └─ if no microtask scheduled yet → queueMicrotask(flush)
 *     └─ return handle (sync — passive recorder rule)
 *
 *   flush() (microtask)                       ← deferred
 *     └─ swap out queue (drain races safely)
 *     └─ for each item: _markRunning, await runChild, _markDone/_markFailed
 *     └─ unregister handle from detachRegistry
 *
 * Why microtask (and not setImmediate / setTimeout):
 *   - Microtasks run BEFORE returning to the event loop — guarantees
 *     the work finishes within the current "tick" if the runtime allows
 *   - Lowest possible deferral cost (~50ns on modern V8)
 *   - Works in EVERY JS runtime (browser, node, deno, bun, edge)
 *   - Doesn't require any timer infrastructure → no GC pressure
 *
 * Re-entrancy:
 *   - If `runChild` calls `schedule()` for nested detach, the new item
 *     lands on the SAME queue. Because `scheduled` flips back to false
 *     at the start of `flush`, the new item triggers a fresh microtask.
 *   - Worst-case: O(n) microtasks for n nested levels. Acceptable —
 *     real-world detach trees are shallow.
 */
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import { defaultRunChild } from '../runChild.js';
/**
 * Build a microtask-batch driver wired to a custom child runner. Most
 * consumers want the default singleton `microtaskBatchDriver` instead;
 * this factory exists for tests and for advanced consumers who want to
 * inject their own runner (e.g., a runner that wraps the child in a
 * tracing context).
 */
export function createMicrotaskBatchDriver(runChild = defaultRunChild) {
    // Per-driver-instance queue and flush guard. Closed over by `schedule`
    // and `flush` so each call to `createMicrotaskBatchDriver` gets its
    // own isolated batch (test isolation, multi-tenant scenarios).
    const queue = [];
    let scheduled = false;
    function flush() {
        // Reset BEFORE draining so re-entrant schedule()s during runChild
        // queue a fresh microtask instead of joining the in-flight drain.
        scheduled = false;
        const items = queue.splice(0);
        for (const item of items) {
            // Each item runs concurrently — no awaits here, so the outer
            // for-loop completes within this microtask. Errors inside
            // `executeOne` are routed to the handle, not thrown. The promise
            // is intentionally not awaited; ignore-promise-returned via the
            // explicit no-op .then() pattern that the project's lint config
            // accepts (vs `void`, which `no-void` rejects).
            executeOne(item, runChild).then(undefined, undefined);
        }
    }
    return {
        name: 'microtask-batch',
        capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
        schedule(child, input, refId) {
            const handle = createHandle(refId);
            register(handle);
            queue.push({ child, input, handle });
            if (!scheduled) {
                scheduled = true;
                queueMicrotask(flush);
            }
            return handle;
        },
    };
}
/**
 * Per-item execution. Marks the handle running, awaits the runner,
 * routes outcome to the handle, cleans up the registry entry. Never
 * throws — errors land on the handle (passive recorder rule).
 */
async function executeOne(item, runChild) {
    const impl = asImpl(item.handle);
    impl._markRunning();
    try {
        const result = await runChild(item.child, item.input);
        impl._markDone(result);
    }
    catch (err) {
        impl._markFailed(err instanceof Error ? err : new Error(String(err)));
    }
    finally {
        unregister(impl.id);
    }
}
/**
 * Default singleton. Most consumers import this and pass it to
 * `executor.detachAndJoinLater(child, input, { driver: microtaskBatchDriver })`
 * (or rely on it being the executor's default driver, set in T5b).
 */
export const microtaskBatchDriver = createMicrotaskBatchDriver();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm90YXNrQmF0Y2guanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2RldGFjaC9kcml2ZXJzL21pY3JvdGFza0JhdGNoLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBd0NHO0FBR0gsT0FBTyxFQUFFLE1BQU0sRUFBRSxZQUFZLEVBQUUsTUFBTSxjQUFjLENBQUM7QUFDcEQsT0FBTyxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0RCxPQUFPLEVBQW9CLGVBQWUsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBU25FOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSwwQkFBMEIsQ0FBQyxXQUF3QixlQUFlO0lBQ2hGLHVFQUF1RTtJQUN2RSxvRUFBb0U7SUFDcEUsK0RBQStEO0lBQy9ELE1BQU0sS0FBSyxHQUFlLEVBQUUsQ0FBQztJQUM3QixJQUFJLFNBQVMsR0FBRyxLQUFLLENBQUM7SUFFdEIsU0FBUyxLQUFLO1FBQ1osa0VBQWtFO1FBQ2xFLGtFQUFrRTtRQUNsRSxTQUFTLEdBQUcsS0FBSyxDQUFDO1FBQ2xCLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDOUIsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUN6Qiw2REFBNkQ7WUFDN0QsMERBQTBEO1lBQzFELGlFQUFpRTtZQUNqRSxnRUFBZ0U7WUFDaEUsZ0VBQWdFO1lBQ2hFLGdEQUFnRDtZQUNoRCxVQUFVLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDeEQsQ0FBQztJQUNILENBQUM7SUFFRCxPQUFPO1FBQ0wsSUFBSSxFQUFFLGlCQUFpQjtRQUN2QixZQUFZLEVBQUUsRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNuRSxRQUFRLENBQUMsS0FBZ0IsRUFBRSxLQUFjLEVBQUUsS0FBYTtZQUN0RCxNQUFNLE1BQU0sR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDbkMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ2pCLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7WUFDckMsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO2dCQUNmLFNBQVMsR0FBRyxJQUFJLENBQUM7Z0JBQ2pCLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUN4QixDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUM7UUFDaEIsQ0FBQztLQUNGLENBQUM7QUFDSixDQUFDO0FBRUQ7Ozs7R0FJRztBQUNILEtBQUssVUFBVSxVQUFVLENBQUMsSUFBYyxFQUFFLFFBQXFCO0lBQzdELE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDakMsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO0lBQ3BCLElBQUksQ0FBQztRQUNILE1BQU0sTUFBTSxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3RELElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDYixJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN4RSxDQUFDO1lBQVMsQ0FBQztRQUNULFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDdEIsQ0FBQztBQUNILENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsTUFBTSxDQUFDLE1BQU0sb0JBQW9CLEdBQWlCLDBCQUEwQixFQUFFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGRldGFjaC9kcml2ZXJzL21pY3JvdGFza0JhdGNoLnRzIOKAlCBCYXRjaCBkZXRhY2hlZCB3b3JrIGludG8gT05FIG1pY3JvdGFzay5cbiAqXG4gKiBQYXR0ZXJuOiAgUHJvZHVjZXItY29uc3VtZXIgd2l0aCBiYXRjaGVkIGZsdXNoLiBTYW1lIHNoYXBlIGFzXG4gKiAgICAgICAgICAgYWdlbnRmb290cHJpbnQncyBgRXZlbnREaXNwYXRjaGVyYCBmbHVzaCBxdWV1ZSBhbmQgdGhlIFJlYWN0XG4gKiAgICAgICAgICAgcmVjb25jaWxlcidzIG1pY3JvdGFzayBzY2hlZHVsaW5nIOKAlCBhY2N1bXVsYXRlIGR1cmluZyB0aGVcbiAqICAgICAgICAgICBjdXJyZW50IHN5bmMgc2xpY2UsIGRyYWluIGF0IHRoZSBuZXh0IG1pY3JvdGFzayBib3VuZGFyeS5cbiAqIFJvbGU6ICAgICBEZWZhdWx0IGRyaXZlciBmb3IgaW4tcHJvY2VzcyBkZXRhY2guIENoZWFwZXN0IHNjaGVkdWxpbmdcbiAqICAgICAgICAgICBwcmltaXRpdmUgb24gVjgvSlNDOiBvbmUgYHF1ZXVlTWljcm90YXNrYCBwZXIgYmF0Y2hcbiAqICAgICAgICAgICByZWdhcmRsZXNzIG9mIGhvdyBtYW55IHdvcmsgaXRlbXMsIHNvIHRoZSBwZXJmIGJ1ZGdldFxuICogICAgICAgICAgIGFtb3J0aXplcy4gU3VpdGFibGUgZm9yIGJyb3dzZXIgQU5EIG5vZGUgQU5EIGVkZ2UgcnVudGltZXNcbiAqICAgICAgICAgICAocXVldWVNaWNyb3Rhc2sgaXMgdW5pdmVyc2FsIHNpbmNlIDIwMTgpLlxuICpcbiAqIExpZmVjeWNsZTpcbiAqXG4gKiAgIHNjaGVkdWxlKGNoaWxkLCBpbnB1dCwgcmVmSWQpICAgICAgICAgICAg4oaQIGRyaXZlciBlbnRyeVxuICogICAgIOKUlOKUgCBjcmVhdGUgaGFuZGxlIChxdWV1ZWQpXG4gKiAgICAg4pSU4pSAIHJlZ2lzdGVyIGluIGRldGFjaFJlZ2lzdHJ5XG4gKiAgICAg4pSU4pSAIHB1c2ggd29yayBpdGVtIG9udG8gbG9jYWwgcXVldWVcbiAqICAgICDilJTilIAgaWYgbm8gbWljcm90YXNrIHNjaGVkdWxlZCB5ZXQg4oaSIHF1ZXVlTWljcm90YXNrKGZsdXNoKVxuICogICAgIOKUlOKUgCByZXR1cm4gaGFuZGxlIChzeW5jIOKAlCBwYXNzaXZlIHJlY29yZGVyIHJ1bGUpXG4gKlxuICogICBmbHVzaCgpIChtaWNyb3Rhc2spICAgICAgICAgICAgICAgICAgICAgICDihpAgZGVmZXJyZWRcbiAqICAgICDilJTilIAgc3dhcCBvdXQgcXVldWUgKGRyYWluIHJhY2VzIHNhZmVseSlcbiAqICAgICDilJTilIAgZm9yIGVhY2ggaXRlbTogX21hcmtSdW5uaW5nLCBhd2FpdCBydW5DaGlsZCwgX21hcmtEb25lL19tYXJrRmFpbGVkXG4gKiAgICAg4pSU4pSAIHVucmVnaXN0ZXIgaGFuZGxlIGZyb20gZGV0YWNoUmVnaXN0cnlcbiAqXG4gKiBXaHkgbWljcm90YXNrIChhbmQgbm90IHNldEltbWVkaWF0ZSAvIHNldFRpbWVvdXQpOlxuICogICAtIE1pY3JvdGFza3MgcnVuIEJFRk9SRSByZXR1cm5pbmcgdG8gdGhlIGV2ZW50IGxvb3Ag4oCUIGd1YXJhbnRlZXNcbiAqICAgICB0aGUgd29yayBmaW5pc2hlcyB3aXRoaW4gdGhlIGN1cnJlbnQgXCJ0aWNrXCIgaWYgdGhlIHJ1bnRpbWUgYWxsb3dzXG4gKiAgIC0gTG93ZXN0IHBvc3NpYmxlIGRlZmVycmFsIGNvc3QgKH41MG5zIG9uIG1vZGVybiBWOClcbiAqICAgLSBXb3JrcyBpbiBFVkVSWSBKUyBydW50aW1lIChicm93c2VyLCBub2RlLCBkZW5vLCBidW4sIGVkZ2UpXG4gKiAgIC0gRG9lc24ndCByZXF1aXJlIGFueSB0aW1lciBpbmZyYXN0cnVjdHVyZSDihpIgbm8gR0MgcHJlc3N1cmVcbiAqXG4gKiBSZS1lbnRyYW5jeTpcbiAqICAgLSBJZiBgcnVuQ2hpbGRgIGNhbGxzIGBzY2hlZHVsZSgpYCBmb3IgbmVzdGVkIGRldGFjaCwgdGhlIG5ldyBpdGVtXG4gKiAgICAgbGFuZHMgb24gdGhlIFNBTUUgcXVldWUuIEJlY2F1c2UgYHNjaGVkdWxlZGAgZmxpcHMgYmFjayB0byBmYWxzZVxuICogICAgIGF0IHRoZSBzdGFydCBvZiBgZmx1c2hgLCB0aGUgbmV3IGl0ZW0gdHJpZ2dlcnMgYSBmcmVzaCBtaWNyb3Rhc2suXG4gKiAgIC0gV29yc3QtY2FzZTogTyhuKSBtaWNyb3Rhc2tzIGZvciBuIG5lc3RlZCBsZXZlbHMuIEFjY2VwdGFibGUg4oCUXG4gKiAgICAgcmVhbC13b3JsZCBkZXRhY2ggdHJlZXMgYXJlIHNoYWxsb3cuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBGbG93Q2hhcnQgfSBmcm9tICcuLi8uLi9idWlsZGVyL3R5cGVzLmpzJztcbmltcG9ydCB7IGFzSW1wbCwgY3JlYXRlSGFuZGxlIH0gZnJvbSAnLi4vaGFuZGxlLmpzJztcbmltcG9ydCB7IHJlZ2lzdGVyLCB1bnJlZ2lzdGVyIH0gZnJvbSAnLi4vcmVnaXN0cnkuanMnO1xuaW1wb3J0IHsgdHlwZSBDaGlsZFJ1bm5lciwgZGVmYXVsdFJ1bkNoaWxkIH0gZnJvbSAnLi4vcnVuQ2hpbGQuanMnO1xuaW1wb3J0IHR5cGUgeyBEZXRhY2hEcml2ZXIsIERldGFjaEhhbmRsZSB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuaW50ZXJmYWNlIFdvcmtJdGVtIHtcbiAgcmVhZG9ubHkgY2hpbGQ6IEZsb3dDaGFydDtcbiAgcmVhZG9ubHkgaW5wdXQ6IHVua25vd247XG4gIHJlYWRvbmx5IGhhbmRsZTogRGV0YWNoSGFuZGxlO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgbWljcm90YXNrLWJhdGNoIGRyaXZlciB3aXJlZCB0byBhIGN1c3RvbSBjaGlsZCBydW5uZXIuIE1vc3RcbiAqIGNvbnN1bWVycyB3YW50IHRoZSBkZWZhdWx0IHNpbmdsZXRvbiBgbWljcm90YXNrQmF0Y2hEcml2ZXJgIGluc3RlYWQ7XG4gKiB0aGlzIGZhY3RvcnkgZXhpc3RzIGZvciB0ZXN0cyBhbmQgZm9yIGFkdmFuY2VkIGNvbnN1bWVycyB3aG8gd2FudCB0b1xuICogaW5qZWN0IHRoZWlyIG93biBydW5uZXIgKGUuZy4sIGEgcnVubmVyIHRoYXQgd3JhcHMgdGhlIGNoaWxkIGluIGFcbiAqIHRyYWNpbmcgY29udGV4dCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVNaWNyb3Rhc2tCYXRjaERyaXZlcihydW5DaGlsZDogQ2hpbGRSdW5uZXIgPSBkZWZhdWx0UnVuQ2hpbGQpOiBEZXRhY2hEcml2ZXIge1xuICAvLyBQZXItZHJpdmVyLWluc3RhbmNlIHF1ZXVlIGFuZCBmbHVzaCBndWFyZC4gQ2xvc2VkIG92ZXIgYnkgYHNjaGVkdWxlYFxuICAvLyBhbmQgYGZsdXNoYCBzbyBlYWNoIGNhbGwgdG8gYGNyZWF0ZU1pY3JvdGFza0JhdGNoRHJpdmVyYCBnZXRzIGl0c1xuICAvLyBvd24gaXNvbGF0ZWQgYmF0Y2ggKHRlc3QgaXNvbGF0aW9uLCBtdWx0aS10ZW5hbnQgc2NlbmFyaW9zKS5cbiAgY29uc3QgcXVldWU6IFdvcmtJdGVtW10gPSBbXTtcbiAgbGV0IHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIGZsdXNoKCk6IHZvaWQge1xuICAgIC8vIFJlc2V0IEJFRk9SRSBkcmFpbmluZyBzbyByZS1lbnRyYW50IHNjaGVkdWxlKClzIGR1cmluZyBydW5DaGlsZFxuICAgIC8vIHF1ZXVlIGEgZnJlc2ggbWljcm90YXNrIGluc3RlYWQgb2Ygam9pbmluZyB0aGUgaW4tZmxpZ2h0IGRyYWluLlxuICAgIHNjaGVkdWxlZCA9IGZhbHNlO1xuICAgIGNvbnN0IGl0ZW1zID0gcXVldWUuc3BsaWNlKDApO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgLy8gRWFjaCBpdGVtIHJ1bnMgY29uY3VycmVudGx5IOKAlCBubyBhd2FpdHMgaGVyZSwgc28gdGhlIG91dGVyXG4gICAgICAvLyBmb3ItbG9vcCBjb21wbGV0ZXMgd2l0aGluIHRoaXMgbWljcm90YXNrLiBFcnJvcnMgaW5zaWRlXG4gICAgICAvLyBgZXhlY3V0ZU9uZWAgYXJlIHJvdXRlZCB0byB0aGUgaGFuZGxlLCBub3QgdGhyb3duLiBUaGUgcHJvbWlzZVxuICAgICAgLy8gaXMgaW50ZW50aW9uYWxseSBub3QgYXdhaXRlZDsgaWdub3JlLXByb21pc2UtcmV0dXJuZWQgdmlhIHRoZVxuICAgICAgLy8gZXhwbGljaXQgbm8tb3AgLnRoZW4oKSBwYXR0ZXJuIHRoYXQgdGhlIHByb2plY3QncyBsaW50IGNvbmZpZ1xuICAgICAgLy8gYWNjZXB0cyAodnMgYHZvaWRgLCB3aGljaCBgbm8tdm9pZGAgcmVqZWN0cykuXG4gICAgICBleGVjdXRlT25lKGl0ZW0sIHJ1bkNoaWxkKS50aGVuKHVuZGVmaW5lZCwgdW5kZWZpbmVkKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdtaWNyb3Rhc2stYmF0Y2gnLFxuICAgIGNhcGFiaWxpdGllczogeyBicm93c2VyU2FmZTogdHJ1ZSwgbm9kZVNhZmU6IHRydWUsIGVkZ2VTYWZlOiB0cnVlIH0sXG4gICAgc2NoZWR1bGUoY2hpbGQ6IEZsb3dDaGFydCwgaW5wdXQ6IHVua25vd24sIHJlZklkOiBzdHJpbmcpOiBEZXRhY2hIYW5kbGUge1xuICAgICAgY29uc3QgaGFuZGxlID0gY3JlYXRlSGFuZGxlKHJlZklkKTtcbiAgICAgIHJlZ2lzdGVyKGhhbmRsZSk7XG4gICAgICBxdWV1ZS5wdXNoKHsgY2hpbGQsIGlucHV0LCBoYW5kbGUgfSk7XG4gICAgICBpZiAoIXNjaGVkdWxlZCkge1xuICAgICAgICBzY2hlZHVsZWQgPSB0cnVlO1xuICAgICAgICBxdWV1ZU1pY3JvdGFzayhmbHVzaCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gaGFuZGxlO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogUGVyLWl0ZW0gZXhlY3V0aW9uLiBNYXJrcyB0aGUgaGFuZGxlIHJ1bm5pbmcsIGF3YWl0cyB0aGUgcnVubmVyLFxuICogcm91dGVzIG91dGNvbWUgdG8gdGhlIGhhbmRsZSwgY2xlYW5zIHVwIHRoZSByZWdpc3RyeSBlbnRyeS4gTmV2ZXJcbiAqIHRocm93cyDigJQgZXJyb3JzIGxhbmQgb24gdGhlIGhhbmRsZSAocGFzc2l2ZSByZWNvcmRlciBydWxlKS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZU9uZShpdGVtOiBXb3JrSXRlbSwgcnVuQ2hpbGQ6IENoaWxkUnVubmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGltcGwgPSBhc0ltcGwoaXRlbS5oYW5kbGUpO1xuICBpbXBsLl9tYXJrUnVubmluZygpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkNoaWxkKGl0ZW0uY2hpbGQsIGl0ZW0uaW5wdXQpO1xuICAgIGltcGwuX21hcmtEb25lKHJlc3VsdCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGltcGwuX21hcmtGYWlsZWQoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB1bnJlZ2lzdGVyKGltcGwuaWQpO1xuICB9XG59XG5cbi8qKlxuICogRGVmYXVsdCBzaW5nbGV0b24uIE1vc3QgY29uc3VtZXJzIGltcG9ydCB0aGlzIGFuZCBwYXNzIGl0IHRvXG4gKiBgZXhlY3V0b3IuZGV0YWNoQW5kSm9pbkxhdGVyKGNoaWxkLCBpbnB1dCwgeyBkcml2ZXI6IG1pY3JvdGFza0JhdGNoRHJpdmVyIH0pYFxuICogKG9yIHJlbHkgb24gaXQgYmVpbmcgdGhlIGV4ZWN1dG9yJ3MgZGVmYXVsdCBkcml2ZXIsIHNldCBpbiBUNWIpLlxuICovXG5leHBvcnQgY29uc3QgbWljcm90YXNrQmF0Y2hEcml2ZXI6IERldGFjaERyaXZlciA9IGNyZWF0ZU1pY3JvdGFza0JhdGNoRHJpdmVyKCk7XG4iXX0=