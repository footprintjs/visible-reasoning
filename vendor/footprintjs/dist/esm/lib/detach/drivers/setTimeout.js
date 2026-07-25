/**
 * detach/drivers/setTimeout.ts — Defer detached work via `setTimeout(..., delayMs)`.
 *
 * Pattern:  Producer-consumer batch flush; deferral mechanism is
 *           `setTimeout` with a configurable delay (default `0`).
 * Role:     Cross-runtime "next macrotask" driver. Works in browsers,
 *           Node.js, Deno, Cloudflare Workers, Bun, etc.
 *
 * When to pick this:
 *   - Consumer wants a SPECIFIC delay (e.g. "ship telemetry in 5
 *     seconds, batched") — pass `createSetTimeoutDriver({ delayMs: 5000 })`
 *   - Cross-runtime detach where `setImmediate` isn't available
 *   - Coalescing high-frequency events into a low-frequency flush
 *
 * Caveats:
 *   - Not for low-latency hot paths — minimum delay is ~4ms in
 *     browsers per the HTML5 spec, ~1ms in Node. Use
 *     `microtaskBatchDriver` for sub-ms scheduling.
 *   - Browser tab freezing / throttling can extend the delay
 *     significantly. Don't rely on precise timing.
 */
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import { defaultRunChild } from '../runChild.js';
export function createSetTimeoutDriver(opts = {}) {
    const delayMs = opts.delayMs ?? 0;
    const runChild = opts.runChild ?? defaultRunChild;
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
        name: delayMs === 0 ? 'set-timeout' : `set-timeout-${delayMs}ms`,
        capabilities: { browserSafe: true, nodeSafe: true, edgeSafe: true },
        schedule(child, input, refId) {
            const handle = createHandle(refId);
            register(handle);
            queue.push({ child, input, handle });
            if (!scheduled) {
                scheduled = true;
                setTimeout(flush, delayMs);
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
/** Default singleton — zero-delay (next macrotask). For configurable
 *  delays, use `createSetTimeoutDriver({ delayMs })`. */
export const setTimeoutDriver = createSetTimeoutDriver();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2V0VGltZW91dC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZGV0YWNoL2RyaXZlcnMvc2V0VGltZW91dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FvQkc7QUFHSCxPQUFPLEVBQUUsTUFBTSxFQUFFLFlBQVksRUFBRSxNQUFNLGNBQWMsQ0FBQztBQUNwRCxPQUFPLEVBQUUsUUFBUSxFQUFFLFVBQVUsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ3RELE9BQU8sRUFBb0IsZUFBZSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFpQm5FLE1BQU0sVUFBVSxzQkFBc0IsQ0FBQyxPQUFnQyxFQUFFO0lBQ3ZFLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxPQUFPLElBQUksQ0FBQyxDQUFDO0lBQ2xDLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRLElBQUksZUFBZSxDQUFDO0lBQ2xELE1BQU0sS0FBSyxHQUFlLEVBQUUsQ0FBQztJQUM3QixJQUFJLFNBQVMsR0FBRyxLQUFLLENBQUM7SUFFdEIsU0FBUyxLQUFLO1FBQ1osU0FBUyxHQUFHLEtBQUssQ0FBQztRQUNsQixNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzlCLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7WUFDekIsVUFBVSxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBQ3hELENBQUM7SUFDSCxDQUFDO0lBRUQsT0FBTztRQUNMLElBQUksRUFBRSxPQUFPLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLGVBQWUsT0FBTyxJQUFJO1FBQ2hFLFlBQVksRUFBRSxFQUFFLFdBQVcsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO1FBQ25FLFFBQVEsQ0FBQyxLQUFnQixFQUFFLEtBQWMsRUFBRSxLQUFhO1lBQ3RELE1BQU0sTUFBTSxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNuQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDakIsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztZQUNyQyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7Z0JBQ2YsU0FBUyxHQUFHLElBQUksQ0FBQztnQkFDakIsVUFBVSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsQ0FBQztZQUM3QixDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUM7UUFDaEIsQ0FBQztLQUNGLENBQUM7QUFDSixDQUFDO0FBRUQsS0FBSyxVQUFVLFVBQVUsQ0FBQyxJQUFjLEVBQUUsUUFBcUI7SUFDN0QsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNqQyxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7SUFDcEIsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdEQsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNiLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3hFLENBQUM7WUFBUyxDQUFDO1FBQ1QsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUN0QixDQUFDO0FBQ0gsQ0FBQztBQUVEO3lEQUN5RDtBQUN6RCxNQUFNLENBQUMsTUFBTSxnQkFBZ0IsR0FBaUIsc0JBQXNCLEVBQUUsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGV0YWNoL2RyaXZlcnMvc2V0VGltZW91dC50cyDigJQgRGVmZXIgZGV0YWNoZWQgd29yayB2aWEgYHNldFRpbWVvdXQoLi4uLCBkZWxheU1zKWAuXG4gKlxuICogUGF0dGVybjogIFByb2R1Y2VyLWNvbnN1bWVyIGJhdGNoIGZsdXNoOyBkZWZlcnJhbCBtZWNoYW5pc20gaXNcbiAqICAgICAgICAgICBgc2V0VGltZW91dGAgd2l0aCBhIGNvbmZpZ3VyYWJsZSBkZWxheSAoZGVmYXVsdCBgMGApLlxuICogUm9sZTogICAgIENyb3NzLXJ1bnRpbWUgXCJuZXh0IG1hY3JvdGFza1wiIGRyaXZlci4gV29ya3MgaW4gYnJvd3NlcnMsXG4gKiAgICAgICAgICAgTm9kZS5qcywgRGVubywgQ2xvdWRmbGFyZSBXb3JrZXJzLCBCdW4sIGV0Yy5cbiAqXG4gKiBXaGVuIHRvIHBpY2sgdGhpczpcbiAqICAgLSBDb25zdW1lciB3YW50cyBhIFNQRUNJRklDIGRlbGF5IChlLmcuIFwic2hpcCB0ZWxlbWV0cnkgaW4gNVxuICogICAgIHNlY29uZHMsIGJhdGNoZWRcIikg4oCUIHBhc3MgYGNyZWF0ZVNldFRpbWVvdXREcml2ZXIoeyBkZWxheU1zOiA1MDAwIH0pYFxuICogICAtIENyb3NzLXJ1bnRpbWUgZGV0YWNoIHdoZXJlIGBzZXRJbW1lZGlhdGVgIGlzbid0IGF2YWlsYWJsZVxuICogICAtIENvYWxlc2NpbmcgaGlnaC1mcmVxdWVuY3kgZXZlbnRzIGludG8gYSBsb3ctZnJlcXVlbmN5IGZsdXNoXG4gKlxuICogQ2F2ZWF0czpcbiAqICAgLSBOb3QgZm9yIGxvdy1sYXRlbmN5IGhvdCBwYXRocyDigJQgbWluaW11bSBkZWxheSBpcyB+NG1zIGluXG4gKiAgICAgYnJvd3NlcnMgcGVyIHRoZSBIVE1MNSBzcGVjLCB+MW1zIGluIE5vZGUuIFVzZVxuICogICAgIGBtaWNyb3Rhc2tCYXRjaERyaXZlcmAgZm9yIHN1Yi1tcyBzY2hlZHVsaW5nLlxuICogICAtIEJyb3dzZXIgdGFiIGZyZWV6aW5nIC8gdGhyb3R0bGluZyBjYW4gZXh0ZW5kIHRoZSBkZWxheVxuICogICAgIHNpZ25pZmljYW50bHkuIERvbid0IHJlbHkgb24gcHJlY2lzZSB0aW1pbmcuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBGbG93Q2hhcnQgfSBmcm9tICcuLi8uLi9idWlsZGVyL3R5cGVzLmpzJztcbmltcG9ydCB7IGFzSW1wbCwgY3JlYXRlSGFuZGxlIH0gZnJvbSAnLi4vaGFuZGxlLmpzJztcbmltcG9ydCB7IHJlZ2lzdGVyLCB1bnJlZ2lzdGVyIH0gZnJvbSAnLi4vcmVnaXN0cnkuanMnO1xuaW1wb3J0IHsgdHlwZSBDaGlsZFJ1bm5lciwgZGVmYXVsdFJ1bkNoaWxkIH0gZnJvbSAnLi4vcnVuQ2hpbGQuanMnO1xuaW1wb3J0IHR5cGUgeyBEZXRhY2hEcml2ZXIsIERldGFjaEhhbmRsZSB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuaW50ZXJmYWNlIFdvcmtJdGVtIHtcbiAgcmVhZG9ubHkgY2hpbGQ6IEZsb3dDaGFydDtcbiAgcmVhZG9ubHkgaW5wdXQ6IHVua25vd247XG4gIHJlYWRvbmx5IGhhbmRsZTogRGV0YWNoSGFuZGxlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldFRpbWVvdXREcml2ZXJPcHRpb25zIHtcbiAgLyoqIE1pbGxpc2Vjb25kcyB0byB3YWl0IGJlZm9yZSBmbHVzaGluZyB0aGUgYmF0Y2guIERlZmF1bHQgMFxuICAgKiAgKG5leHQgbWFjcm90YXNrKS4gKi9cbiAgcmVhZG9ubHkgZGVsYXlNcz86IG51bWJlcjtcbiAgLyoqIEN1c3RvbSBgcnVuQ2hpbGRgLiBEZWZhdWx0cyB0byBzcGF3bmluZyBhIGBGbG93Q2hhcnRFeGVjdXRvcmAuICovXG4gIHJlYWRvbmx5IHJ1bkNoaWxkPzogQ2hpbGRSdW5uZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXRUaW1lb3V0RHJpdmVyKG9wdHM6IFNldFRpbWVvdXREcml2ZXJPcHRpb25zID0ge30pOiBEZXRhY2hEcml2ZXIge1xuICBjb25zdCBkZWxheU1zID0gb3B0cy5kZWxheU1zID8/IDA7XG4gIGNvbnN0IHJ1bkNoaWxkID0gb3B0cy5ydW5DaGlsZCA/PyBkZWZhdWx0UnVuQ2hpbGQ7XG4gIGNvbnN0IHF1ZXVlOiBXb3JrSXRlbVtdID0gW107XG4gIGxldCBzY2hlZHVsZWQgPSBmYWxzZTtcblxuICBmdW5jdGlvbiBmbHVzaCgpOiB2b2lkIHtcbiAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICBjb25zdCBpdGVtcyA9IHF1ZXVlLnNwbGljZSgwKTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgIGV4ZWN1dGVPbmUoaXRlbSwgcnVuQ2hpbGQpLnRoZW4odW5kZWZpbmVkLCB1bmRlZmluZWQpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbmFtZTogZGVsYXlNcyA9PT0gMCA/ICdzZXQtdGltZW91dCcgOiBgc2V0LXRpbWVvdXQtJHtkZWxheU1zfW1zYCxcbiAgICBjYXBhYmlsaXRpZXM6IHsgYnJvd3NlclNhZmU6IHRydWUsIG5vZGVTYWZlOiB0cnVlLCBlZGdlU2FmZTogdHJ1ZSB9LFxuICAgIHNjaGVkdWxlKGNoaWxkOiBGbG93Q2hhcnQsIGlucHV0OiB1bmtub3duLCByZWZJZDogc3RyaW5nKTogRGV0YWNoSGFuZGxlIHtcbiAgICAgIGNvbnN0IGhhbmRsZSA9IGNyZWF0ZUhhbmRsZShyZWZJZCk7XG4gICAgICByZWdpc3RlcihoYW5kbGUpO1xuICAgICAgcXVldWUucHVzaCh7IGNoaWxkLCBpbnB1dCwgaGFuZGxlIH0pO1xuICAgICAgaWYgKCFzY2hlZHVsZWQpIHtcbiAgICAgICAgc2NoZWR1bGVkID0gdHJ1ZTtcbiAgICAgICAgc2V0VGltZW91dChmbHVzaCwgZGVsYXlNcyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gaGFuZGxlO1xuICAgIH0sXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVPbmUoaXRlbTogV29ya0l0ZW0sIHJ1bkNoaWxkOiBDaGlsZFJ1bm5lcik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBpbXBsID0gYXNJbXBsKGl0ZW0uaGFuZGxlKTtcbiAgaW1wbC5fbWFya1J1bm5pbmcoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5DaGlsZChpdGVtLmNoaWxkLCBpdGVtLmlucHV0KTtcbiAgICBpbXBsLl9tYXJrRG9uZShyZXN1bHQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpbXBsLl9tYXJrRmFpbGVkKGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSk7XG4gIH0gZmluYWxseSB7XG4gICAgdW5yZWdpc3RlcihpbXBsLmlkKTtcbiAgfVxufVxuXG4vKiogRGVmYXVsdCBzaW5nbGV0b24g4oCUIHplcm8tZGVsYXkgKG5leHQgbWFjcm90YXNrKS4gRm9yIGNvbmZpZ3VyYWJsZVxuICogIGRlbGF5cywgdXNlIGBjcmVhdGVTZXRUaW1lb3V0RHJpdmVyKHsgZGVsYXlNcyB9KWAuICovXG5leHBvcnQgY29uc3Qgc2V0VGltZW91dERyaXZlcjogRGV0YWNoRHJpdmVyID0gY3JlYXRlU2V0VGltZW91dERyaXZlcigpO1xuIl19