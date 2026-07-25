/**
 * detach/drivers/setImmediate.ts — Defer detached work to a Node.js
 *                                  `setImmediate` boundary.
 *
 * Pattern:  Same producer-consumer batch flush as `microtaskBatch`,
 *           but the deferral is `setImmediate` instead of
 *           `queueMicrotask`. Yields control back to the event loop
 *           BEFORE running — allows pending I/O callbacks to drain
 *           first, which microtasks would block.
 * Role:     Node-specific driver for "fire-and-forget after the
 *           current I/O tick." Use when the parent stage handles
 *           latency-sensitive work and you don't want detached work
 *           to compete for the synchronous slice.
 *
 * When to pick this over microtaskBatch:
 *   - You're shipping logs / metrics in a hot HTTP path and don't
 *     want them blocking the response from being flushed
 *   - The detached work itself is CPU-heavy enough that running it on
 *     the same microtask cycle would delay other microtasks
 *   - You explicitly want "next event-loop tick" semantics — useful
 *     when interacting with third-party libraries that expect at
 *     least one I/O tick between schedule and execution
 *
 * Capability:
 *   - `nodeSafe: true` — relies on Node's `setImmediate`, NOT
 *     available in browsers / Deno / Cloudflare Workers (use
 *     `setTimeoutDriver` for cross-runtime alternative)
 */
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import { defaultRunChild } from '../runChild.js';
export function createSetImmediateDriver(runChild = defaultRunChild) {
    const queue = [];
    let scheduled = false;
    function flush() {
        scheduled = false;
        const items = queue.splice(0);
        for (const item of items) {
            executeOne(item, runChild).then(undefined, undefined);
        }
    }
    return {
        name: 'set-immediate',
        capabilities: { nodeSafe: true },
        validate() {
            if (typeof setImmediate !== 'function') {
                throw new Error('[detach] setImmediateDriver requires Node.js — global `setImmediate` is not defined ' +
                    'in this runtime. Use `microtaskBatchDriver` for cross-runtime use, or `setTimeoutDriver` ' +
                    'for browser/edge environments.');
            }
        },
        schedule(child, input, refId) {
            const handle = createHandle(refId);
            register(handle);
            queue.push({ child, input, handle });
            if (!scheduled) {
                scheduled = true;
                // `setImmediate` is non-undefined here in Node; runtime guard
                // is in `validate()`. The `!` is a deliberate assertion.
                setImmediate(flush);
            }
            return handle;
        },
    };
}
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
export const setImmediateDriver = createSetImmediateDriver();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2V0SW1tZWRpYXRlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9kZXRhY2gvZHJpdmVycy9zZXRJbW1lZGlhdGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTJCRztBQUdILE9BQU8sRUFBRSxNQUFNLEVBQUUsWUFBWSxFQUFFLE1BQU0sY0FBYyxDQUFDO0FBQ3BELE9BQU8sRUFBRSxRQUFRLEVBQUUsVUFBVSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDdEQsT0FBTyxFQUFvQixlQUFlLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQWVuRSxNQUFNLFVBQVUsd0JBQXdCLENBQUMsV0FBd0IsZUFBZTtJQUM5RSxNQUFNLEtBQUssR0FBZSxFQUFFLENBQUM7SUFDN0IsSUFBSSxTQUFTLEdBQUcsS0FBSyxDQUFDO0lBRXRCLFNBQVMsS0FBSztRQUNaLFNBQVMsR0FBRyxLQUFLLENBQUM7UUFDbEIsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM5QixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3pCLFVBQVUsQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxTQUFTLENBQUMsQ0FBQztRQUN4RCxDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU87UUFDTCxJQUFJLEVBQUUsZUFBZTtRQUNyQixZQUFZLEVBQUUsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ2hDLFFBQVE7WUFDTixJQUFJLE9BQU8sWUFBWSxLQUFLLFVBQVUsRUFBRSxDQUFDO2dCQUN2QyxNQUFNLElBQUksS0FBSyxDQUNiLHNGQUFzRjtvQkFDcEYsMkZBQTJGO29CQUMzRixnQ0FBZ0MsQ0FDbkMsQ0FBQztZQUNKLENBQUM7UUFDSCxDQUFDO1FBQ0QsUUFBUSxDQUFDLEtBQWdCLEVBQUUsS0FBYyxFQUFFLEtBQWE7WUFDdEQsTUFBTSxNQUFNLEdBQUcsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ25DLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUNqQixLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDO1lBQ3JDLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDZixTQUFTLEdBQUcsSUFBSSxDQUFDO2dCQUNqQiw4REFBOEQ7Z0JBQzlELHlEQUF5RDtnQkFDekQsWUFBYSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3ZCLENBQUM7WUFDRCxPQUFPLE1BQU0sQ0FBQztRQUNoQixDQUFDO0tBQ0YsQ0FBQztBQUNKLENBQUM7QUFFRCxLQUFLLFVBQVUsVUFBVSxDQUFDLElBQWMsRUFBRSxRQUFxQjtJQUM3RCxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2pDLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztJQUNwQixJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBRyxNQUFNLFFBQVEsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN0RCxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ2IsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDeEUsQ0FBQztZQUFTLENBQUM7UUFDVCxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ3RCLENBQUM7QUFDSCxDQUFDO0FBRUQsTUFBTSxDQUFDLE1BQU0sa0JBQWtCLEdBQWlCLHdCQUF3QixFQUFFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGRldGFjaC9kcml2ZXJzL3NldEltbWVkaWF0ZS50cyDigJQgRGVmZXIgZGV0YWNoZWQgd29yayB0byBhIE5vZGUuanNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBzZXRJbW1lZGlhdGVgIGJvdW5kYXJ5LlxuICpcbiAqIFBhdHRlcm46ICBTYW1lIHByb2R1Y2VyLWNvbnN1bWVyIGJhdGNoIGZsdXNoIGFzIGBtaWNyb3Rhc2tCYXRjaGAsXG4gKiAgICAgICAgICAgYnV0IHRoZSBkZWZlcnJhbCBpcyBgc2V0SW1tZWRpYXRlYCBpbnN0ZWFkIG9mXG4gKiAgICAgICAgICAgYHF1ZXVlTWljcm90YXNrYC4gWWllbGRzIGNvbnRyb2wgYmFjayB0byB0aGUgZXZlbnQgbG9vcFxuICogICAgICAgICAgIEJFRk9SRSBydW5uaW5nIOKAlCBhbGxvd3MgcGVuZGluZyBJL08gY2FsbGJhY2tzIHRvIGRyYWluXG4gKiAgICAgICAgICAgZmlyc3QsIHdoaWNoIG1pY3JvdGFza3Mgd291bGQgYmxvY2suXG4gKiBSb2xlOiAgICAgTm9kZS1zcGVjaWZpYyBkcml2ZXIgZm9yIFwiZmlyZS1hbmQtZm9yZ2V0IGFmdGVyIHRoZVxuICogICAgICAgICAgIGN1cnJlbnQgSS9PIHRpY2suXCIgVXNlIHdoZW4gdGhlIHBhcmVudCBzdGFnZSBoYW5kbGVzXG4gKiAgICAgICAgICAgbGF0ZW5jeS1zZW5zaXRpdmUgd29yayBhbmQgeW91IGRvbid0IHdhbnQgZGV0YWNoZWQgd29ya1xuICogICAgICAgICAgIHRvIGNvbXBldGUgZm9yIHRoZSBzeW5jaHJvbm91cyBzbGljZS5cbiAqXG4gKiBXaGVuIHRvIHBpY2sgdGhpcyBvdmVyIG1pY3JvdGFza0JhdGNoOlxuICogICAtIFlvdSdyZSBzaGlwcGluZyBsb2dzIC8gbWV0cmljcyBpbiBhIGhvdCBIVFRQIHBhdGggYW5kIGRvbid0XG4gKiAgICAgd2FudCB0aGVtIGJsb2NraW5nIHRoZSByZXNwb25zZSBmcm9tIGJlaW5nIGZsdXNoZWRcbiAqICAgLSBUaGUgZGV0YWNoZWQgd29yayBpdHNlbGYgaXMgQ1BVLWhlYXZ5IGVub3VnaCB0aGF0IHJ1bm5pbmcgaXQgb25cbiAqICAgICB0aGUgc2FtZSBtaWNyb3Rhc2sgY3ljbGUgd291bGQgZGVsYXkgb3RoZXIgbWljcm90YXNrc1xuICogICAtIFlvdSBleHBsaWNpdGx5IHdhbnQgXCJuZXh0IGV2ZW50LWxvb3AgdGlja1wiIHNlbWFudGljcyDigJQgdXNlZnVsXG4gKiAgICAgd2hlbiBpbnRlcmFjdGluZyB3aXRoIHRoaXJkLXBhcnR5IGxpYnJhcmllcyB0aGF0IGV4cGVjdCBhdFxuICogICAgIGxlYXN0IG9uZSBJL08gdGljayBiZXR3ZWVuIHNjaGVkdWxlIGFuZCBleGVjdXRpb25cbiAqXG4gKiBDYXBhYmlsaXR5OlxuICogICAtIGBub2RlU2FmZTogdHJ1ZWAg4oCUIHJlbGllcyBvbiBOb2RlJ3MgYHNldEltbWVkaWF0ZWAsIE5PVFxuICogICAgIGF2YWlsYWJsZSBpbiBicm93c2VycyAvIERlbm8gLyBDbG91ZGZsYXJlIFdvcmtlcnMgKHVzZVxuICogICAgIGBzZXRUaW1lb3V0RHJpdmVyYCBmb3IgY3Jvc3MtcnVudGltZSBhbHRlcm5hdGl2ZSlcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZsb3dDaGFydCB9IGZyb20gJy4uLy4uL2J1aWxkZXIvdHlwZXMuanMnO1xuaW1wb3J0IHsgYXNJbXBsLCBjcmVhdGVIYW5kbGUgfSBmcm9tICcuLi9oYW5kbGUuanMnO1xuaW1wb3J0IHsgcmVnaXN0ZXIsIHVucmVnaXN0ZXIgfSBmcm9tICcuLi9yZWdpc3RyeS5qcyc7XG5pbXBvcnQgeyB0eXBlIENoaWxkUnVubmVyLCBkZWZhdWx0UnVuQ2hpbGQgfSBmcm9tICcuLi9ydW5DaGlsZC5qcyc7XG5pbXBvcnQgdHlwZSB7IERldGFjaERyaXZlciwgRGV0YWNoSGFuZGxlIH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG4vLyBOb2RlLW9ubHkgZ2xvYmFsLiBXZSBkb24ndCBzaGlwIEB0eXBlcy9ub2RlLCBzbyBkZWNsYXJlIHRoZSBtaW5pbWFsXG4vLyBzaGFwZSBoZXJlLiBgc2V0SW1tZWRpYXRlRHJpdmVyYCBhZHZlcnRpc2VzIGBub2RlU2FmZTogdHJ1ZWAgYW5kXG4vLyBgdmFsaWRhdGUoKWAgdGhyb3dzIGhlbHBmdWxseSBpZiBgc2V0SW1tZWRpYXRlYCBpcyB1bmRlZmluZWQgYXQgdXNlXG4vLyB0aW1lIChlLmcuLCBicm93c2VyIGJ1bmRsZSkuXG5kZWNsYXJlIGNvbnN0IHNldEltbWVkaWF0ZTogKChjYjogKCkgPT4gdm9pZCkgPT4gdW5rbm93bikgfCB1bmRlZmluZWQ7XG5cbmludGVyZmFjZSBXb3JrSXRlbSB7XG4gIHJlYWRvbmx5IGNoaWxkOiBGbG93Q2hhcnQ7XG4gIHJlYWRvbmx5IGlucHV0OiB1bmtub3duO1xuICByZWFkb25seSBoYW5kbGU6IERldGFjaEhhbmRsZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNldEltbWVkaWF0ZURyaXZlcihydW5DaGlsZDogQ2hpbGRSdW5uZXIgPSBkZWZhdWx0UnVuQ2hpbGQpOiBEZXRhY2hEcml2ZXIge1xuICBjb25zdCBxdWV1ZTogV29ya0l0ZW1bXSA9IFtdO1xuICBsZXQgc2NoZWR1bGVkID0gZmFsc2U7XG5cbiAgZnVuY3Rpb24gZmx1c2goKTogdm9pZCB7XG4gICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgY29uc3QgaXRlbXMgPSBxdWV1ZS5zcGxpY2UoMCk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICBleGVjdXRlT25lKGl0ZW0sIHJ1bkNoaWxkKS50aGVuKHVuZGVmaW5lZCwgdW5kZWZpbmVkKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdzZXQtaW1tZWRpYXRlJyxcbiAgICBjYXBhYmlsaXRpZXM6IHsgbm9kZVNhZmU6IHRydWUgfSxcbiAgICB2YWxpZGF0ZSgpOiB2b2lkIHtcbiAgICAgIGlmICh0eXBlb2Ygc2V0SW1tZWRpYXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAnW2RldGFjaF0gc2V0SW1tZWRpYXRlRHJpdmVyIHJlcXVpcmVzIE5vZGUuanMg4oCUIGdsb2JhbCBgc2V0SW1tZWRpYXRlYCBpcyBub3QgZGVmaW5lZCAnICtcbiAgICAgICAgICAgICdpbiB0aGlzIHJ1bnRpbWUuIFVzZSBgbWljcm90YXNrQmF0Y2hEcml2ZXJgIGZvciBjcm9zcy1ydW50aW1lIHVzZSwgb3IgYHNldFRpbWVvdXREcml2ZXJgICcgK1xuICAgICAgICAgICAgJ2ZvciBicm93c2VyL2VkZ2UgZW52aXJvbm1lbnRzLicsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSxcbiAgICBzY2hlZHVsZShjaGlsZDogRmxvd0NoYXJ0LCBpbnB1dDogdW5rbm93biwgcmVmSWQ6IHN0cmluZyk6IERldGFjaEhhbmRsZSB7XG4gICAgICBjb25zdCBoYW5kbGUgPSBjcmVhdGVIYW5kbGUocmVmSWQpO1xuICAgICAgcmVnaXN0ZXIoaGFuZGxlKTtcbiAgICAgIHF1ZXVlLnB1c2goeyBjaGlsZCwgaW5wdXQsIGhhbmRsZSB9KTtcbiAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIC8vIGBzZXRJbW1lZGlhdGVgIGlzIG5vbi11bmRlZmluZWQgaGVyZSBpbiBOb2RlOyBydW50aW1lIGd1YXJkXG4gICAgICAgIC8vIGlzIGluIGB2YWxpZGF0ZSgpYC4gVGhlIGAhYCBpcyBhIGRlbGliZXJhdGUgYXNzZXJ0aW9uLlxuICAgICAgICBzZXRJbW1lZGlhdGUhKGZsdXNoKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBoYW5kbGU7XG4gICAgfSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZU9uZShpdGVtOiBXb3JrSXRlbSwgcnVuQ2hpbGQ6IENoaWxkUnVubmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGltcGwgPSBhc0ltcGwoaXRlbS5oYW5kbGUpO1xuICBpbXBsLl9tYXJrUnVubmluZygpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkNoaWxkKGl0ZW0uY2hpbGQsIGl0ZW0uaW5wdXQpO1xuICAgIGltcGwuX21hcmtEb25lKHJlc3VsdCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGltcGwuX21hcmtGYWlsZWQoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB1bnJlZ2lzdGVyKGltcGwuaWQpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBzZXRJbW1lZGlhdGVEcml2ZXI6IERldGFjaERyaXZlciA9IGNyZWF0ZVNldEltbWVkaWF0ZURyaXZlcigpO1xuIl19