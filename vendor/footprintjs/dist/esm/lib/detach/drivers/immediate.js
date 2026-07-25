/**
 * detach/drivers/immediate.ts — Run detached work synchronously inside `schedule()`.
 *
 * Pattern:  Null-object driver for the "no actual deferral" case. Same
 *           intent as a `setTimeout(fn, 0)` shim that just calls `fn()`
 *           — keeps the API surface uniform so consumers can swap drivers
 *           without changing call sites.
 * Role:     Test fixture + opt-in for consumers who want fire-and-forget
 *           ergonomics (the handle API) without actually deferring. Useful
 *           for:
 *
 *             - unit tests where deterministic, synchronous completion
 *               beats microtask gymnastics
 *             - very small detach payloads where the overhead of a
 *               microtask roundtrip exceeds the work itself
 *             - debugging — easier to step through with breakpoints
 *
 * Performance:
 *   - Sync runChild → handle becomes terminal before `schedule()` returns
 *   - Async runChild → handle marks running sync, terminal at runChild's
 *     resolution. The `wait()` Promise is the same one consumers use for
 *     any other driver; behaviour is uniform.
 *
 * Caveat — this is NOT a passive-recorder by default:
 *   When runChild is sync, the parent stage observes the work's side
 *   effects WITHIN its own slice. That's intentional for the test/debug
 *   use case but means consumers should NOT use `immediateDriver` for
 *   long-running work in production hot paths — pick `microtaskBatchDriver`
 *   for that.
 */
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import { defaultRunChild } from '../runChild.js';
/**
 * Build an immediate driver wired to a custom child runner. Most
 * consumers want the default singleton `immediateDriver`.
 */
export function createImmediateDriver(runChild = defaultRunChild) {
    return {
        name: 'immediate',
        capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
        schedule(child, input, refId) {
            const handle = createHandle(refId);
            register(handle);
            const impl = asImpl(handle);
            impl._markRunning();
            // Don't await here — driver schedule() must return synchronously
            // (passive recorder rule). The Promise from runChild handles the
            // rest; if it's already-resolved (sync runner), the .then runs on
            // the next microtask but the schedule() call still returns sync.
            Promise.resolve()
                .then(() => runChild(child, input))
                .then((result) => {
                impl._markDone(result);
                unregister(impl.id);
            }, (err) => {
                impl._markFailed(err instanceof Error ? err : new Error(String(err)));
                unregister(impl.id);
            });
            return handle;
        },
    };
}
/** Default singleton — most consumers use this. */
export const immediateDriver = createImmediateDriver();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1tZWRpYXRlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9kZXRhY2gvZHJpdmVycy9pbW1lZGlhdGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBNkJHO0FBR0gsT0FBTyxFQUFFLE1BQU0sRUFBRSxZQUFZLEVBQUUsTUFBTSxjQUFjLENBQUM7QUFDcEQsT0FBTyxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0RCxPQUFPLEVBQW9CLGVBQWUsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBR25FOzs7R0FHRztBQUNILE1BQU0sVUFBVSxxQkFBcUIsQ0FBQyxXQUF3QixlQUFlO0lBQzNFLE9BQU87UUFDTCxJQUFJLEVBQUUsV0FBVztRQUNqQixZQUFZLEVBQUUsRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtRQUNuRSxRQUFRLENBQUMsS0FBZ0IsRUFBRSxLQUFjLEVBQUUsS0FBYTtZQUN0RCxNQUFNLE1BQU0sR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDbkMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ2pCLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUM1QixJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDcEIsaUVBQWlFO1lBQ2pFLGlFQUFpRTtZQUNqRSxrRUFBa0U7WUFDbEUsaUVBQWlFO1lBQ2pFLE9BQU8sQ0FBQyxPQUFPLEVBQUU7aUJBQ2QsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUM7aUJBQ2xDLElBQUksQ0FDSCxDQUFDLE1BQU0sRUFBRSxFQUFFO2dCQUNULElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUM7Z0JBQ3ZCLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDdEIsQ0FBQyxFQUNELENBQUMsR0FBWSxFQUFFLEVBQUU7Z0JBQ2YsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3RFLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDdEIsQ0FBQyxDQUNGLENBQUM7WUFDSixPQUFPLE1BQU0sQ0FBQztRQUNoQixDQUFDO0tBQ0YsQ0FBQztBQUNKLENBQUM7QUFFRCxtREFBbUQ7QUFDbkQsTUFBTSxDQUFDLE1BQU0sZUFBZSxHQUFpQixxQkFBcUIsRUFBRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZXRhY2gvZHJpdmVycy9pbW1lZGlhdGUudHMg4oCUIFJ1biBkZXRhY2hlZCB3b3JrIHN5bmNocm9ub3VzbHkgaW5zaWRlIGBzY2hlZHVsZSgpYC5cbiAqXG4gKiBQYXR0ZXJuOiAgTnVsbC1vYmplY3QgZHJpdmVyIGZvciB0aGUgXCJubyBhY3R1YWwgZGVmZXJyYWxcIiBjYXNlLiBTYW1lXG4gKiAgICAgICAgICAgaW50ZW50IGFzIGEgYHNldFRpbWVvdXQoZm4sIDApYCBzaGltIHRoYXQganVzdCBjYWxscyBgZm4oKWBcbiAqICAgICAgICAgICDigJQga2VlcHMgdGhlIEFQSSBzdXJmYWNlIHVuaWZvcm0gc28gY29uc3VtZXJzIGNhbiBzd2FwIGRyaXZlcnNcbiAqICAgICAgICAgICB3aXRob3V0IGNoYW5naW5nIGNhbGwgc2l0ZXMuXG4gKiBSb2xlOiAgICAgVGVzdCBmaXh0dXJlICsgb3B0LWluIGZvciBjb25zdW1lcnMgd2hvIHdhbnQgZmlyZS1hbmQtZm9yZ2V0XG4gKiAgICAgICAgICAgZXJnb25vbWljcyAodGhlIGhhbmRsZSBBUEkpIHdpdGhvdXQgYWN0dWFsbHkgZGVmZXJyaW5nLiBVc2VmdWxcbiAqICAgICAgICAgICBmb3I6XG4gKlxuICogICAgICAgICAgICAgLSB1bml0IHRlc3RzIHdoZXJlIGRldGVybWluaXN0aWMsIHN5bmNocm9ub3VzIGNvbXBsZXRpb25cbiAqICAgICAgICAgICAgICAgYmVhdHMgbWljcm90YXNrIGd5bW5hc3RpY3NcbiAqICAgICAgICAgICAgIC0gdmVyeSBzbWFsbCBkZXRhY2ggcGF5bG9hZHMgd2hlcmUgdGhlIG92ZXJoZWFkIG9mIGFcbiAqICAgICAgICAgICAgICAgbWljcm90YXNrIHJvdW5kdHJpcCBleGNlZWRzIHRoZSB3b3JrIGl0c2VsZlxuICogICAgICAgICAgICAgLSBkZWJ1Z2dpbmcg4oCUIGVhc2llciB0byBzdGVwIHRocm91Z2ggd2l0aCBicmVha3BvaW50c1xuICpcbiAqIFBlcmZvcm1hbmNlOlxuICogICAtIFN5bmMgcnVuQ2hpbGQg4oaSIGhhbmRsZSBiZWNvbWVzIHRlcm1pbmFsIGJlZm9yZSBgc2NoZWR1bGUoKWAgcmV0dXJuc1xuICogICAtIEFzeW5jIHJ1bkNoaWxkIOKGkiBoYW5kbGUgbWFya3MgcnVubmluZyBzeW5jLCB0ZXJtaW5hbCBhdCBydW5DaGlsZCdzXG4gKiAgICAgcmVzb2x1dGlvbi4gVGhlIGB3YWl0KClgIFByb21pc2UgaXMgdGhlIHNhbWUgb25lIGNvbnN1bWVycyB1c2UgZm9yXG4gKiAgICAgYW55IG90aGVyIGRyaXZlcjsgYmVoYXZpb3VyIGlzIHVuaWZvcm0uXG4gKlxuICogQ2F2ZWF0IOKAlCB0aGlzIGlzIE5PVCBhIHBhc3NpdmUtcmVjb3JkZXIgYnkgZGVmYXVsdDpcbiAqICAgV2hlbiBydW5DaGlsZCBpcyBzeW5jLCB0aGUgcGFyZW50IHN0YWdlIG9ic2VydmVzIHRoZSB3b3JrJ3Mgc2lkZVxuICogICBlZmZlY3RzIFdJVEhJTiBpdHMgb3duIHNsaWNlLiBUaGF0J3MgaW50ZW50aW9uYWwgZm9yIHRoZSB0ZXN0L2RlYnVnXG4gKiAgIHVzZSBjYXNlIGJ1dCBtZWFucyBjb25zdW1lcnMgc2hvdWxkIE5PVCB1c2UgYGltbWVkaWF0ZURyaXZlcmAgZm9yXG4gKiAgIGxvbmctcnVubmluZyB3b3JrIGluIHByb2R1Y3Rpb24gaG90IHBhdGhzIOKAlCBwaWNrIGBtaWNyb3Rhc2tCYXRjaERyaXZlcmBcbiAqICAgZm9yIHRoYXQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBGbG93Q2hhcnQgfSBmcm9tICcuLi8uLi9idWlsZGVyL3R5cGVzLmpzJztcbmltcG9ydCB7IGFzSW1wbCwgY3JlYXRlSGFuZGxlIH0gZnJvbSAnLi4vaGFuZGxlLmpzJztcbmltcG9ydCB7IHJlZ2lzdGVyLCB1bnJlZ2lzdGVyIH0gZnJvbSAnLi4vcmVnaXN0cnkuanMnO1xuaW1wb3J0IHsgdHlwZSBDaGlsZFJ1bm5lciwgZGVmYXVsdFJ1bkNoaWxkIH0gZnJvbSAnLi4vcnVuQ2hpbGQuanMnO1xuaW1wb3J0IHR5cGUgeyBEZXRhY2hEcml2ZXIsIERldGFjaEhhbmRsZSB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuLyoqXG4gKiBCdWlsZCBhbiBpbW1lZGlhdGUgZHJpdmVyIHdpcmVkIHRvIGEgY3VzdG9tIGNoaWxkIHJ1bm5lci4gTW9zdFxuICogY29uc3VtZXJzIHdhbnQgdGhlIGRlZmF1bHQgc2luZ2xldG9uIGBpbW1lZGlhdGVEcml2ZXJgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlSW1tZWRpYXRlRHJpdmVyKHJ1bkNoaWxkOiBDaGlsZFJ1bm5lciA9IGRlZmF1bHRSdW5DaGlsZCk6IERldGFjaERyaXZlciB7XG4gIHJldHVybiB7XG4gICAgbmFtZTogJ2ltbWVkaWF0ZScsXG4gICAgY2FwYWJpbGl0aWVzOiB7IGJyb3dzZXJTYWZlOiB0cnVlLCBub2RlU2FmZTogdHJ1ZSwgZWRnZVNhZmU6IHRydWUgfSxcbiAgICBzY2hlZHVsZShjaGlsZDogRmxvd0NoYXJ0LCBpbnB1dDogdW5rbm93biwgcmVmSWQ6IHN0cmluZyk6IERldGFjaEhhbmRsZSB7XG4gICAgICBjb25zdCBoYW5kbGUgPSBjcmVhdGVIYW5kbGUocmVmSWQpO1xuICAgICAgcmVnaXN0ZXIoaGFuZGxlKTtcbiAgICAgIGNvbnN0IGltcGwgPSBhc0ltcGwoaGFuZGxlKTtcbiAgICAgIGltcGwuX21hcmtSdW5uaW5nKCk7XG4gICAgICAvLyBEb24ndCBhd2FpdCBoZXJlIOKAlCBkcml2ZXIgc2NoZWR1bGUoKSBtdXN0IHJldHVybiBzeW5jaHJvbm91c2x5XG4gICAgICAvLyAocGFzc2l2ZSByZWNvcmRlciBydWxlKS4gVGhlIFByb21pc2UgZnJvbSBydW5DaGlsZCBoYW5kbGVzIHRoZVxuICAgICAgLy8gcmVzdDsgaWYgaXQncyBhbHJlYWR5LXJlc29sdmVkIChzeW5jIHJ1bm5lciksIHRoZSAudGhlbiBydW5zIG9uXG4gICAgICAvLyB0aGUgbmV4dCBtaWNyb3Rhc2sgYnV0IHRoZSBzY2hlZHVsZSgpIGNhbGwgc3RpbGwgcmV0dXJucyBzeW5jLlxuICAgICAgUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgLnRoZW4oKCkgPT4gcnVuQ2hpbGQoY2hpbGQsIGlucHV0KSlcbiAgICAgICAgLnRoZW4oXG4gICAgICAgICAgKHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgaW1wbC5fbWFya0RvbmUocmVzdWx0KTtcbiAgICAgICAgICAgIHVucmVnaXN0ZXIoaW1wbC5pZCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICAoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgICAgICAgICBpbXBsLl9tYXJrRmFpbGVkKGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSk7XG4gICAgICAgICAgICB1bnJlZ2lzdGVyKGltcGwuaWQpO1xuICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgICByZXR1cm4gaGFuZGxlO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKiBEZWZhdWx0IHNpbmdsZXRvbiDigJQgbW9zdCBjb25zdW1lcnMgdXNlIHRoaXMuICovXG5leHBvcnQgY29uc3QgaW1tZWRpYXRlRHJpdmVyOiBEZXRhY2hEcml2ZXIgPSBjcmVhdGVJbW1lZGlhdGVEcml2ZXIoKTtcbiJdfQ==