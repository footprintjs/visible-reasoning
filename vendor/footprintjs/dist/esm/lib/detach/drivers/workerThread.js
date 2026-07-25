/**
 * detach/drivers/workerThread.ts — Run detached work in a Node.js
 *                                  Worker Thread (or browser Web Worker).
 *
 * Pattern:  Adapter — translates the consumer's child flowchart into
 *           a worker message + lifecycle handoff. The worker is owned
 *           by the driver instance; restarted on crash.
 * Role:     CPU-isolation driver — when detached work is genuinely
 *           expensive (heavy parsing, hashing, image processing) and
 *           you don't want it blocking the main thread's event loop
 *           even for a microtask burst.
 *
 * Caveats / IMPORTANT v1 limitations:
 *   - The worker entry point is a CONSUMER-PROVIDED file path / URL —
 *     this driver does NOT auto-spawn FlowChartExecutor in a worker.
 *     Workers can't `import('footprintjs')` portably without setup,
 *     and the worker file's lifecycle differs by runtime
 *     (Node Worker vs Web Worker vs Bun). Consumer writes the worker
 *     code; this driver just hands them a uniform `(input, handle)`
 *     API.
 *   - The "child flowchart" parameter is IGNORED in v1 (we only ship
 *     the input). The chart shape doesn't survive structuredClone +
 *     postMessage anyway. v2 may add a serialization protocol.
 *
 * Two ways to consume:
 *
 *   1. Node.js: pass a file path
 *      `createWorkerThreadDriver({ workerScript: '/path/to/worker.js' })`
 *
 *   2. Browser: pass a URL or pre-built Worker instance
 *      `createWorkerThreadDriver({ worker: new Worker(url) })`
 */
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
let nextMessageId = 0;
export function createWorkerThreadDriver(opts) {
    let worker;
    const inFlight = new Map();
    // If consumer provided a Worker at construction time, bind its
    // 'message' handler eagerly so replies are routed back to handles.
    // Lazy construction (via `workerScript`) defers binding to first use.
    if (opts.worker) {
        worker = opts.worker;
        bindWorker(worker, inFlight);
    }
    function ensureWorker() {
        if (worker)
            return worker;
        if (!opts.workerScript) {
            throw new Error('[detach] workerThreadDriver: provide either `worker` (a constructed Worker) ' +
                'or `workerScript` (a path/URL) at driver creation.');
        }
        // Lazy-import Node's worker_threads — keeps browser bundles clean.
        if (typeof require !== 'function') {
            throw new Error('[detach] workerThreadDriver: `workerScript` requires Node.js (CommonJS `require`).');
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Worker } = require('worker_threads');
        worker = new Worker(opts.workerScript);
        bindWorker(worker, inFlight);
        return worker;
    }
    return {
        name: 'worker-thread',
        capabilities: { nodeSafe: true, cpuIsolated: true },
        validate() {
            if (!opts.worker && !opts.workerScript) {
                throw new Error('[detach] workerThreadDriver requires either a pre-built `worker` or a `workerScript` path.');
            }
        },
        schedule(_child, input, refId) {
            const handle = createHandle(refId);
            register(handle);
            const impl = asImpl(handle);
            impl._markRunning();
            const messageId = nextMessageId++;
            inFlight.set(messageId, { handle });
            try {
                const w = ensureWorker();
                w.postMessage({ messageId, refId, input });
            }
            catch (err) {
                impl._markFailed(err instanceof Error ? err : new Error(String(err)));
                unregister(impl.id);
                inFlight.delete(messageId);
            }
            return handle;
        },
    };
}
function bindWorker(worker, inFlight) {
    const handler = (msg) => {
        const m = msg;
        if (!m || typeof m.messageId !== 'number')
            return;
        const slot = inFlight.get(m.messageId);
        if (!slot)
            return;
        inFlight.delete(m.messageId);
        const impl = asImpl(slot.handle);
        if (m.ok) {
            impl._markDone(m.result);
        }
        else {
            impl._markFailed(new Error(m.error ?? 'worker reported failure'));
        }
        unregister(impl.id);
    };
    // Node Worker (worker_threads): EventEmitter-shape (`on('message', ...)`).
    if (typeof worker.on === 'function')
        worker.on('message', handler);
    // Browser Worker / Web Worker: EventTarget-shape (`addEventListener`).
    else if (typeof worker.addEventListener === 'function') {
        worker.addEventListener('message', (evt) => handler(evt?.data));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyVGhyZWFkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9kZXRhY2gvZHJpdmVycy93b3JrZXJUaHJlYWQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0ErQkc7QUFHSCxPQUFPLEVBQUUsTUFBTSxFQUFFLFlBQVksRUFBRSxNQUFNLGNBQWMsQ0FBQztBQUNwRCxPQUFPLEVBQUUsUUFBUSxFQUFFLFVBQVUsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBNkJ0RCxJQUFJLGFBQWEsR0FBRyxDQUFDLENBQUM7QUFFdEIsTUFBTSxVQUFVLHdCQUF3QixDQUFDLElBQStCO0lBQ3RFLElBQUksTUFBOEIsQ0FBQztJQUNuQyxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsRUFBb0IsQ0FBQztJQUU3QywrREFBK0Q7SUFDL0QsbUVBQW1FO0lBQ25FLHNFQUFzRTtJQUN0RSxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNoQixNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQztRQUNyQixVQUFVLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQy9CLENBQUM7SUFFRCxTQUFTLFlBQVk7UUFDbkIsSUFBSSxNQUFNO1lBQUUsT0FBTyxNQUFNLENBQUM7UUFDMUIsSUFBSSxDQUFDLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztZQUN2QixNQUFNLElBQUksS0FBSyxDQUNiLDhFQUE4RTtnQkFDNUUsb0RBQW9ELENBQ3ZELENBQUM7UUFDSixDQUFDO1FBQ0QsbUVBQW1FO1FBQ25FLElBQUksT0FBTyxPQUFPLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDbEMsTUFBTSxJQUFJLEtBQUssQ0FBQyxvRkFBb0YsQ0FBQyxDQUFDO1FBQ3hHLENBQUM7UUFDRCxpRUFBaUU7UUFDakUsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FB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QUFNLENBQUMsRUFBRSxDQUFDLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUNuRSx1RUFBdUU7U0FDbEUsSUFBSSxPQUFPLE1BQU0sQ0FBQyxnQkFBZ0IsS0FBSyxVQUFVLEVBQUUsQ0FBQztRQUN2RCxNQUFNLENBQUMsZ0JBQWdCLENBQUMsU0FBUyxFQUFFLENBQUMsR0FBWSxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUUsR0FBMEIsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQ25HLENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZXRhY2gvZHJpdmVycy93b3JrZXJUaHJlYWQudHMg4oCUIFJ1biBkZXRhY2hlZCB3b3JrIGluIGEgTm9kZS5qc1xuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgV29ya2VyIFRocmVhZCAob3IgYnJvd3NlciBXZWIgV29ya2VyKS5cbiAqXG4gKiBQYXR0ZXJuOiAgQWRhcHRlciDigJQgdHJhbnNsYXRlcyB0aGUgY29uc3VtZXIncyBjaGlsZCBmbG93Y2hhcnQgaW50b1xuICogICAgICAgICAgIGEgd29ya2VyIG1lc3NhZ2UgKyBsaWZlY3ljbGUgaGFuZG9mZi4gVGhlIHdvcmtlciBpcyBvd25lZFxuICogICAgICAgICAgIGJ5IHRoZSBkcml2ZXIgaW5zdGFuY2U7IHJlc3RhcnRlZCBvbiBjcmFzaC5cbiAqIFJvbGU6ICAgICBDUFUtaXNvbGF0aW9uIGRyaXZlciDigJQgd2hlbiBkZXRhY2hlZCB3b3JrIGlzIGdlbnVpbmVseVxuICogICAgICAgICAgIGV4cGVuc2l2ZSAoaGVhdnkgcGFyc2luZywgaGFzaGluZywgaW1hZ2UgcHJvY2Vzc2luZykgYW5kXG4gKiAgICAgICAgICAgeW91IGRvbid0IHdhbnQgaXQgYmxvY2tpbmcgdGhlIG1haW4gdGhyZWFkJ3MgZXZlbnQgbG9vcFxuICogICAgICAgICAgIGV2ZW4gZm9yIGEgbWljcm90YXNrIGJ1cnN0LlxuICpcbiAqIENhdmVhdHMgLyBJTVBPUlRBTlQgdjEgbGltaXRhdGlvbnM6XG4gKiAgIC0gVGhlIHdvcmtlciBlbnRyeSBwb2ludCBpcyBhIENPTlNVTUVSLVBST1ZJREVEIGZpbGUgcGF0aCAvIFVSTCDigJRcbiAqICAgICB0aGlzIGRyaXZlciBkb2VzIE5PVCBhdXRvLXNwYXduIEZsb3dDaGFydEV4ZWN1dG9yIGluIGEgd29ya2VyLlxuICogICAgIFdvcmtlcnMgY2FuJ3QgYGltcG9ydCgnZm9vdHByaW50anMnKWAgcG9ydGFibHkgd2l0aG91dCBzZXR1cCxcbiAqICAgICBhbmQgdGhlIHdvcmtlciBmaWxlJ3MgbGlmZWN5Y2xlIGRpZmZlcnMgYnkgcnVudGltZVxuICogICAgIChOb2RlIFdvcmtlciB2cyBXZWIgV29ya2VyIHZzIEJ1bikuIENvbnN1bWVyIHdyaXRlcyB0aGUgd29ya2VyXG4gKiAgICAgY29kZTsgdGhpcyBkcml2ZXIganVzdCBoYW5kcyB0aGVtIGEgdW5pZm9ybSBgKGlucHV0LCBoYW5kbGUpYFxuICogICAgIEFQSS5cbiAqICAgLSBUaGUgXCJjaGlsZCBmbG93Y2hhcnRcIiBwYXJhbWV0ZXIgaXMgSUdOT1JFRCBpbiB2MSAod2Ugb25seSBzaGlwXG4gKiAgICAgdGhlIGlucHV0KS4gVGhlIGNoYXJ0IHNoYXBlIGRvZXNuJ3Qgc3Vydml2ZSBzdHJ1Y3R1cmVkQ2xvbmUgK1xuICogICAgIHBvc3RNZXNzYWdlIGFueXdheS4gdjIgbWF5IGFkZCBhIHNlcmlhbGl6YXRpb24gcHJvdG9jb2wuXG4gKlxuICogVHdvIHdheXMgdG8gY29uc3VtZTpcbiAqXG4gKiAgIDEuIE5vZGUuanM6IHBhc3MgYSBmaWxlIHBhdGhcbiAqICAgICAgYGNyZWF0ZVdvcmtlclRocmVhZERyaXZlcih7IHdvcmtlclNjcmlwdDogJy9wYXRoL3RvL3dvcmtlci5qcycgfSlgXG4gKlxuICogICAyLiBCcm93c2VyOiBwYXNzIGEgVVJMIG9yIHByZS1idWlsdCBXb3JrZXIgaW5zdGFuY2VcbiAqICAgICAgYGNyZWF0ZVdvcmtlclRocmVhZERyaXZlcih7IHdvcmtlcjogbmV3IFdvcmtlcih1cmwpIH0pYFxuICovXG5cbmltcG9ydCB0eXBlIHsgRmxvd0NoYXJ0IH0gZnJvbSAnLi4vLi4vYnVpbGRlci90eXBlcy5qcyc7XG5pbXBvcnQgeyBhc0ltcGwsIGNyZWF0ZUhhbmRsZSB9IGZyb20gJy4uL2hhbmRsZS5qcyc7XG5pbXBvcnQgeyByZWdpc3RlciwgdW5yZWdpc3RlciB9IGZyb20gJy4uL3JlZ2lzdHJ5LmpzJztcbmltcG9ydCB0eXBlIHsgRGV0YWNoRHJpdmVyLCBEZXRhY2hIYW5kbGUgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbi8vIE5vZGUtb25seSBDb21tb25KUyBgcmVxdWlyZWAuIFdlIGRvbid0IHNoaXAgQHR5cGVzL25vZGUsIHNvIGRlY2xhcmVcbi8vIHRoZSBtaW5pbWFsIHNoYXBlIGhlcmUuIFVzZWQgb25seSBpbiB0aGUgbGF6eSBgd29ya2VyU2NyaXB0YCBwYXRoO1xuLy8gYnJvd3NlciBjb25zdW1lcnMgcGFzcyBhIHByZS1jb25zdHJ1Y3RlZCBgV29ya2VyYCBhbmQgbmV2ZXIgaGl0IGl0LlxuZGVjbGFyZSBjb25zdCByZXF1aXJlOiAoKG1vZDogc3RyaW5nKSA9PiB1bmtub3duKSB8IHVuZGVmaW5lZDtcblxuaW50ZXJmYWNlIFdvcmtlckxpa2Uge1xuICBwb3N0TWVzc2FnZShtZXNzYWdlOiB1bmtub3duLCB0cmFuc2Zlcj86IFRyYW5zZmVyYWJsZVtdKTogdm9pZDtcbiAgdGVybWluYXRlPygpOiB1bmtub3duO1xuICBvbj8oZXZlbnQ6IHN0cmluZywgbGlzdGVuZXI6IChtc2c6IHVua25vd24pID0+IHZvaWQpOiB2b2lkO1xuICBhZGRFdmVudExpc3RlbmVyPyhldmVudDogc3RyaW5nLCBsaXN0ZW5lcjogKG1zZzogdW5rbm93bikgPT4gdm9pZCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya2VyVGhyZWFkRHJpdmVyT3B0aW9ucyB7XG4gIC8qKiBQcmUtY29uc3RydWN0ZWQgV29ya2VyIGluc3RhbmNlLiBQYXNzIGVpdGhlciB0aGlzIE9SXG4gICAqICBgd29ya2VyU2NyaXB0YCDigJQgbm90IGJvdGguICovXG4gIHJlYWRvbmx5IHdvcmtlcj86IFdvcmtlckxpa2U7XG4gIC8qKiBQYXRoIC8gVVJMIHRvIHRoZSB3b3JrZXIgc2NyaXB0LiBVc2VkIG9ubHkgd2hlbiBgd29ya2VyYCBpc1xuICAgKiAgbm90IHByb3ZpZGVkOyB0aGUgZHJpdmVyIGNvbnN0cnVjdHMgYSBXb3JrZXIgZnJvbSB0aGlzIG9uIGRlbWFuZFxuICAgKiAgKE5vZGUgYHdvcmtlcl90aHJlYWRzYCBBUEkpLiAqL1xuICByZWFkb25seSB3b3JrZXJTY3JpcHQ/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBJbkZsaWdodCB7XG4gIHJlYWRvbmx5IGhhbmRsZTogRGV0YWNoSGFuZGxlO1xufVxuXG5sZXQgbmV4dE1lc3NhZ2VJZCA9IDA7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVXb3JrZXJUaHJlYWREcml2ZXIob3B0czogV29ya2VyVGhyZWFkRHJpdmVyT3B0aW9ucyk6IERldGFjaERyaXZlciB7XG4gIGxldCB3b3JrZXI6IFdvcmtlckxpa2UgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGluRmxpZ2h0ID0gbmV3IE1hcDxudW1iZXIsIEluRmxpZ2h0PigpO1xuXG4gIC8vIElmIGNvbnN1bWVyIHByb3ZpZGVkIGEgV29ya2VyIGF0IGNvbnN0cnVjdGlvbiB0aW1lLCBiaW5kIGl0c1xuICAvLyAnbWVzc2FnZScgaGFuZGxlciBlYWdlcmx5IHNvIHJlcGxpZXMgYXJlIHJvdXRlZCBiYWNrIHRvIGhhbmRsZXMuXG4gIC8vIExhenkgY29uc3RydWN0aW9uICh2aWEgYHdvcmtlclNjcmlwdGApIGRlZmVycyBiaW5kaW5nIHRvIGZpcnN0IHVzZS5cbiAgaWYgKG9wdHMud29ya2VyKSB7XG4gICAgd29ya2VyID0gb3B0cy53b3JrZXI7XG4gICAgYmluZFdvcmtlcih3b3JrZXIsIGluRmxpZ2h0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVuc3VyZVdvcmtlcigpOiBXb3JrZXJMaWtlIHtcbiAgICBpZiAod29ya2VyKSByZXR1cm4gd29ya2VyO1xuICAgIGlmICghb3B0cy53b3JrZXJTY3JpcHQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgJ1tkZXRhY2hdIHdvcmtlclRocmVhZERyaXZlcjogcHJvdmlkZSBlaXRoZXIgYHdvcmtlcmAgKGEgY29uc3RydWN0ZWQgV29ya2VyKSAnICtcbiAgICAgICAgICAnb3IgYHdvcmtlclNjcmlwdGAgKGEgcGF0aC9VUkwpIGF0IGRyaXZlciBjcmVhdGlvbi4nLFxuICAgICAgKTtcbiAgICB9XG4gICAgLy8gTGF6eS1pbXBvcnQgTm9kZSdzIHdvcmtlcl90aHJlYWRzIOKAlCBrZWVwcyBicm93c2VyIGJ1bmRsZXMgY2xlYW4uXG4gICAgaWYgKHR5cGVvZiByZXF1aXJlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1tkZXRhY2hdIHdvcmtlclRocmVhZERyaXZlcjogYHdvcmtlclNjcmlwdGAgcmVxdWlyZXMgTm9kZS5qcyAoQ29tbW9uSlMgYHJlcXVpcmVgKS4nKTtcbiAgICB9XG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHNcbiAgICBjb25zdCB7IFdvcmtlciB9ID0gcmVxdWlyZSgnd29ya2VyX3RocmVhZHMnKSBhcyB7IFdvcmtlcjogbmV3IChzOiBzdHJpbmcpID0+IFdvcmtlckxpa2UgfTtcbiAgICB3b3JrZXIgPSBuZXcgV29ya2VyKG9wdHMud29ya2VyU2NyaXB0KTtcbiAgICBiaW5kV29ya2VyKHdvcmtlciwgaW5GbGlnaHQpO1xuICAgIHJldHVybiB3b3JrZXI7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICd3b3JrZXItdGhyZWFkJyxcbiAgICBjYXBhYmlsaXRpZXM6IHsgbm9kZVNhZmU6IHRydWUsIGNwdUlzb2xhdGVkOiB0cnVlIH0sXG4gICAgdmFsaWRhdGUoKTogdm9pZCB7XG4gICAgICBpZiAoIW9wdHMud29ya2VyICYmICFvcHRzLndvcmtlclNjcmlwdCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1tkZXRhY2hdIHdvcmtlclRocmVhZERyaXZlciByZXF1aXJlcyBlaXRoZXIgYSBwcmUtYnVpbHQgYHdvcmtlcmAgb3IgYSBgd29ya2VyU2NyaXB0YCBwYXRoLicpO1xuICAgICAgfVxuICAgIH0sXG4gICAgc2NoZWR1bGUoX2NoaWxkOiBGbG93Q2hhcnQsIGlucHV0OiB1bmtub3duLCByZWZJZDogc3RyaW5nKTogRGV0YWNoSGFuZGxlIHtcbiAgICAgIGNvbnN0IGhhbmRsZSA9IGNyZWF0ZUhhbmRsZShyZWZJZCk7XG4gICAgICByZWdpc3RlcihoYW5kbGUpO1xuICAgICAgY29uc3QgaW1wbCA9IGFzSW1wbChoYW5kbGUpO1xuICAgICAgaW1wbC5fbWFya1J1bm5pbmcoKTtcblxuICAgICAgY29uc3QgbWVzc2FnZUlkID0gbmV4dE1lc3NhZ2VJZCsrO1xuICAgICAgaW5GbGlnaHQuc2V0KG1lc3NhZ2VJZCwgeyBoYW5kbGUgfSk7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHcgPSBlbnN1cmVXb3JrZXIoKTtcbiAgICAgICAgdy5wb3N0TWVzc2FnZSh7IG1lc3NhZ2VJZCwgcmVmSWQsIGlucHV0IH0pO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGltcGwuX21hcmtGYWlsZWQoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpKTtcbiAgICAgICAgdW5yZWdpc3RlcihpbXBsLmlkKTtcbiAgICAgICAgaW5GbGlnaHQuZGVsZXRlKG1lc3NhZ2VJZCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBoYW5kbGU7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gYmluZFdvcmtlcih3b3JrZXI6IFdvcmtlckxpa2UsIGluRmxpZ2h0OiBNYXA8bnVtYmVyLCBJbkZsaWdodD4pOiB2b2lkIHtcbiAgY29uc3QgaGFuZGxlciA9IChtc2c6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBjb25zdCBtID0gbXNnIGFzIHsgbWVzc2FnZUlkPzogbnVtYmVyOyBvaz86IGJvb2xlYW47IHJlc3VsdD86IHVua25vd247IGVycm9yPzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gICAgaWYgKCFtIHx8IHR5cGVvZiBtLm1lc3NhZ2VJZCAhPT0gJ251bWJlcicpIHJldHVybjtcbiAgICBjb25zdCBzbG90ID0gaW5GbGlnaHQuZ2V0KG0ubWVzc2FnZUlkKTtcbiAgICBpZiAoIXNsb3QpIHJldHVybjtcbiAgICBpbkZsaWdodC5kZWxldGUobS5tZXNzYWdlSWQpO1xuXG4gICAgY29uc3QgaW1wbCA9IGFzSW1wbChzbG90LmhhbmRsZSk7XG4gICAgaWYgKG0ub2spIHtcbiAgICAgIGltcGwuX21hcmtEb25lKG0ucmVzdWx0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgaW1wbC5fbWFya0ZhaWxlZChuZXcgRXJyb3IobS5lcnJvciA/PyAnd29ya2VyIHJlcG9ydGVkIGZhaWx1cmUnKSk7XG4gICAgfVxuICAgIHVucmVnaXN0ZXIoaW1wbC5pZCk7XG4gIH07XG5cbiAgLy8gTm9kZSBXb3JrZXIgKHdvcmtlcl90aHJlYWRzKTogRXZlbnRFbWl0dGVyLXNoYXBlIChgb24oJ21lc3NhZ2UnLCAuLi4pYCkuXG4gIGlmICh0eXBlb2Ygd29ya2VyLm9uID09PSAnZnVuY3Rpb24nKSB3b3JrZXIub24oJ21lc3NhZ2UnLCBoYW5kbGVyKTtcbiAgLy8gQnJvd3NlciBXb3JrZXIgLyBXZWIgV29ya2VyOiBFdmVudFRhcmdldC1zaGFwZSAoYGFkZEV2ZW50TGlzdGVuZXJgKS5cbiAgZWxzZSBpZiAodHlwZW9mIHdvcmtlci5hZGRFdmVudExpc3RlbmVyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgd29ya2VyLmFkZEV2ZW50TGlzdGVuZXIoJ21lc3NhZ2UnLCAoZXZ0OiB1bmtub3duKSA9PiBoYW5kbGVyKChldnQgYXMgeyBkYXRhPzogdW5rbm93biB9KT8uZGF0YSkpO1xuICB9XG59XG4iXX0=