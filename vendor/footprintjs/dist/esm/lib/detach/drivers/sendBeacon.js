/**
 * detach/drivers/sendBeacon.ts — Browser-only driver that ships work
 *                                via `navigator.sendBeacon` so it
 *                                survives page-unload.
 *
 * Pattern:  Strategy / Adapter — translates the consumer's child
 *           flowchart into a sendBeacon POST. The "child" is expected
 *           to produce a JSON-serializable payload via its
 *           `inputMapper`; the URL endpoint is set at driver creation.
 * Role:     The narrow but high-value driver for analytics / error
 *           reporting / page-leave telemetry — the one case where
 *           "fire-and-forget" must really mean "ships even if the
 *           user closes the tab right after."
 *
 * `navigator.sendBeacon` semantics:
 *   - Browser queues the POST in the OS network stack BEFORE returning
 *     control. Survives page-unload, navigation, refresh.
 *   - Limited to ~64 KB per call (per HTML5 spec).
 *   - Fire-and-forget — no response observable.
 *
 * Caveats:
 *   - Browser-only (`browserSafe: true, survivesUnload: true`).
 *     `validate()` throws helpfully if `navigator.sendBeacon` isn't a
 *     function (e.g., when imported in Node).
 *   - The driver does NOT run the child flowchart through a
 *     `FlowChartExecutor` — it serializes the input and POSTs. This
 *     is an intentional simplification: sendBeacon's semantics
 *     wouldn't survive an executor's async stages anyway.
 */
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
export function createSendBeaconDriver(opts) {
    if (!opts.url) {
        throw new TypeError('[detach] createSendBeaconDriver requires a `url` option.');
    }
    function serialize(input) {
        if (opts.serialize)
            return opts.serialize(input);
        return new Blob([JSON.stringify(input ?? null)], { type: 'application/json' });
    }
    return {
        name: 'send-beacon',
        capabilities: {
            browserSafe: true,
            survivesUnload: true,
        },
        validate() {
            if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
                throw new Error('[detach] sendBeaconDriver requires a browser environment with `navigator.sendBeacon`. ' +
                    'Use `microtaskBatchDriver` for in-process detach, or `setImmediateDriver` for Node.js.');
            }
        },
        schedule(_child, input, refId) {
            const handle = createHandle(refId);
            register(handle);
            const impl = asImpl(handle);
            impl._markRunning();
            try {
                const payload = serialize(input);
                const accepted = navigator.sendBeacon(opts.url, payload);
                if (accepted) {
                    impl._markDone({ accepted: true, url: opts.url });
                }
                else {
                    impl._markFailed(new Error('[detach] navigator.sendBeacon refused the payload (likely over the ~64 KB limit).'));
                }
            }
            catch (err) {
                impl._markFailed(err instanceof Error ? err : new Error(String(err)));
            }
            finally {
                unregister(impl.id);
            }
            return handle;
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VuZEJlYWNvbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZGV0YWNoL2RyaXZlcnMvc2VuZEJlYWNvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTRCRztBQUdILE9BQU8sRUFBRSxNQUFNLEVBQUUsWUFBWSxFQUFFLE1BQU0sY0FBYyxDQUFDO0FBQ3BELE9BQU8sRUFBRSxRQUFRLEVBQUUsVUFBVSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFXdEQsTUFBTSxVQUFVLHNCQUFzQixDQUFDLElBQTZCO0lBQ2xFLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDZCxNQUFNLElBQUksU0FBUyxDQUFDLDBEQUEwRCxDQUFDLENBQUM7SUFDbEYsQ0FBQztJQUVELFNBQVMsU0FBUyxDQUFDLEtBQWM7UUFDL0IsSUFBSSxJQUFJLENBQUMsU0FBUztZQUFFLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqRCxPQUFPLElBQUksSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxrQkFBa0IsRUFBRSxDQUFDLENBQUM7SUFDakYsQ0FBQztJQUVELE9BQU87UUFDTCxJQUFJLEVBQUUsYUFBYTtRQUNuQixZQUFZLEVBQUU7WUFDWixXQUFXLEVBQUUsSUFBSTtZQUNqQixjQUFjLEVBQUUsSUFBSTtTQUNyQjtRQUNELFFBQVE7WUFDTixJQUFJLE9BQU8sU0FBUyxLQUFLLFdBQVcsSUFBSSxPQUFPLFNBQVMsQ0FBQyxVQUFVLEtBQUssVUFBVSxFQUFFLENBQUM7Z0JBQ25GLE1BQU0sSUFBSSxLQUFLLENBQ2Isd0ZBQXdGO29CQUN0Rix3RkFBd0YsQ0FDM0YsQ0FBQztZQUNKLENBQUM7UUFDSCxDQUFDO1FBQ0QsUUFBUSxDQUFDLE1BQWlCLEVBQUUsS0FBYyxFQUFFLEtBQWE7WUFDdkQsTUFBTSxNQUFNLEdBQUcsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ25DLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUNqQixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDNUIsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3BCLElBQUksQ0FBQztnQkFDSCxNQUFNLE9BQU8sR0FBRyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQ2pDLE1BQU0sUUFBUSxHQUFHLFNBQVMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxPQUFtQixDQUFDLENBQUM7Z0JBQ3JFLElBQUksUUFBUSxFQUFFLENBQUM7b0JBQ2IsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO2dCQUNwRCxDQUFDO3FCQUFNLENBQUM7b0JBQ04sSUFBSSxDQUFDLFdBQVcsQ0FDZCxJQUFJLEtBQUssQ0FBQyxtRkFBbUYsQ0FBQyxDQUMvRixDQUFDO2dCQUNKLENBQUM7WUFDSCxDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDYixJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN4RSxDQUFDO29CQUFTLENBQUM7Z0JBQ1QsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUN0QixDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUM7UUFDaEIsQ0FBQztLQUNGLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZXRhY2gvZHJpdmVycy9zZW5kQmVhY29uLnRzIOKAlCBCcm93c2VyLW9ubHkgZHJpdmVyIHRoYXQgc2hpcHMgd29ya1xuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZpYSBgbmF2aWdhdG9yLnNlbmRCZWFjb25gIHNvIGl0XG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3Vydml2ZXMgcGFnZS11bmxvYWQuXG4gKlxuICogUGF0dGVybjogIFN0cmF0ZWd5IC8gQWRhcHRlciDigJQgdHJhbnNsYXRlcyB0aGUgY29uc3VtZXIncyBjaGlsZFxuICogICAgICAgICAgIGZsb3djaGFydCBpbnRvIGEgc2VuZEJlYWNvbiBQT1NULiBUaGUgXCJjaGlsZFwiIGlzIGV4cGVjdGVkXG4gKiAgICAgICAgICAgdG8gcHJvZHVjZSBhIEpTT04tc2VyaWFsaXphYmxlIHBheWxvYWQgdmlhIGl0c1xuICogICAgICAgICAgIGBpbnB1dE1hcHBlcmA7IHRoZSBVUkwgZW5kcG9pbnQgaXMgc2V0IGF0IGRyaXZlciBjcmVhdGlvbi5cbiAqIFJvbGU6ICAgICBUaGUgbmFycm93IGJ1dCBoaWdoLXZhbHVlIGRyaXZlciBmb3IgYW5hbHl0aWNzIC8gZXJyb3JcbiAqICAgICAgICAgICByZXBvcnRpbmcgLyBwYWdlLWxlYXZlIHRlbGVtZXRyeSDigJQgdGhlIG9uZSBjYXNlIHdoZXJlXG4gKiAgICAgICAgICAgXCJmaXJlLWFuZC1mb3JnZXRcIiBtdXN0IHJlYWxseSBtZWFuIFwic2hpcHMgZXZlbiBpZiB0aGVcbiAqICAgICAgICAgICB1c2VyIGNsb3NlcyB0aGUgdGFiIHJpZ2h0IGFmdGVyLlwiXG4gKlxuICogYG5hdmlnYXRvci5zZW5kQmVhY29uYCBzZW1hbnRpY3M6XG4gKiAgIC0gQnJvd3NlciBxdWV1ZXMgdGhlIFBPU1QgaW4gdGhlIE9TIG5ldHdvcmsgc3RhY2sgQkVGT1JFIHJldHVybmluZ1xuICogICAgIGNvbnRyb2wuIFN1cnZpdmVzIHBhZ2UtdW5sb2FkLCBuYXZpZ2F0aW9uLCByZWZyZXNoLlxuICogICAtIExpbWl0ZWQgdG8gfjY0IEtCIHBlciBjYWxsIChwZXIgSFRNTDUgc3BlYykuXG4gKiAgIC0gRmlyZS1hbmQtZm9yZ2V0IOKAlCBubyByZXNwb25zZSBvYnNlcnZhYmxlLlxuICpcbiAqIENhdmVhdHM6XG4gKiAgIC0gQnJvd3Nlci1vbmx5IChgYnJvd3NlclNhZmU6IHRydWUsIHN1cnZpdmVzVW5sb2FkOiB0cnVlYCkuXG4gKiAgICAgYHZhbGlkYXRlKClgIHRocm93cyBoZWxwZnVsbHkgaWYgYG5hdmlnYXRvci5zZW5kQmVhY29uYCBpc24ndCBhXG4gKiAgICAgZnVuY3Rpb24gKGUuZy4sIHdoZW4gaW1wb3J0ZWQgaW4gTm9kZSkuXG4gKiAgIC0gVGhlIGRyaXZlciBkb2VzIE5PVCBydW4gdGhlIGNoaWxkIGZsb3djaGFydCB0aHJvdWdoIGFcbiAqICAgICBgRmxvd0NoYXJ0RXhlY3V0b3JgIOKAlCBpdCBzZXJpYWxpemVzIHRoZSBpbnB1dCBhbmQgUE9TVHMuIFRoaXNcbiAqICAgICBpcyBhbiBpbnRlbnRpb25hbCBzaW1wbGlmaWNhdGlvbjogc2VuZEJlYWNvbidzIHNlbWFudGljc1xuICogICAgIHdvdWxkbid0IHN1cnZpdmUgYW4gZXhlY3V0b3IncyBhc3luYyBzdGFnZXMgYW55d2F5LlxuICovXG5cbmltcG9ydCB0eXBlIHsgRmxvd0NoYXJ0IH0gZnJvbSAnLi4vLi4vYnVpbGRlci90eXBlcy5qcyc7XG5pbXBvcnQgeyBhc0ltcGwsIGNyZWF0ZUhhbmRsZSB9IGZyb20gJy4uL2hhbmRsZS5qcyc7XG5pbXBvcnQgeyByZWdpc3RlciwgdW5yZWdpc3RlciB9IGZyb20gJy4uL3JlZ2lzdHJ5LmpzJztcbmltcG9ydCB0eXBlIHsgRGV0YWNoRHJpdmVyLCBEZXRhY2hIYW5kbGUgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2VuZEJlYWNvbkRyaXZlck9wdGlvbnMge1xuICAvKiogRW5kcG9pbnQgVVJMIOKAlCByZXF1aXJlZC4gZS5nLiwgYCdodHRwczovL3RlbGVtZXRyeS5leGFtcGxlLmNvbS9pbmdlc3QnYC4gKi9cbiAgcmVhZG9ubHkgdXJsOiBzdHJpbmc7XG4gIC8qKiBDdXN0b20gc2VyaWFsaXplci4gRGVmYXVsdHMgdG8gYEpTT04uc3RyaW5naWZ5KGlucHV0KWAgd2l0aFxuICAgKiAgYGFwcGxpY2F0aW9uL2pzb25gIGNvbnRlbnQgdHlwZS4gKi9cbiAgcmVhZG9ubHkgc2VyaWFsaXplPzogKGlucHV0OiB1bmtub3duKSA9PiBCbG9iIHwgc3RyaW5nIHwgRm9ybURhdGE7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZW5kQmVhY29uRHJpdmVyKG9wdHM6IFNlbmRCZWFjb25Ecml2ZXJPcHRpb25zKTogRGV0YWNoRHJpdmVyIHtcbiAgaWYgKCFvcHRzLnVybCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1tkZXRhY2hdIGNyZWF0ZVNlbmRCZWFjb25Ecml2ZXIgcmVxdWlyZXMgYSBgdXJsYCBvcHRpb24uJyk7XG4gIH1cblxuICBmdW5jdGlvbiBzZXJpYWxpemUoaW5wdXQ6IHVua25vd24pOiBCbG9iIHwgc3RyaW5nIHwgRm9ybURhdGEge1xuICAgIGlmIChvcHRzLnNlcmlhbGl6ZSkgcmV0dXJuIG9wdHMuc2VyaWFsaXplKGlucHV0KTtcbiAgICByZXR1cm4gbmV3IEJsb2IoW0pTT04uc3RyaW5naWZ5KGlucHV0ID8/IG51bGwpXSwgeyB0eXBlOiAnYXBwbGljYXRpb24vanNvbicgfSk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdzZW5kLWJlYWNvbicsXG4gICAgY2FwYWJpbGl0aWVzOiB7XG4gICAgICBicm93c2VyU2FmZTogdHJ1ZSxcbiAgICAgIHN1cnZpdmVzVW5sb2FkOiB0cnVlLFxuICAgIH0sXG4gICAgdmFsaWRhdGUoKTogdm9pZCB7XG4gICAgICBpZiAodHlwZW9mIG5hdmlnYXRvciA9PT0gJ3VuZGVmaW5lZCcgfHwgdHlwZW9mIG5hdmlnYXRvci5zZW5kQmVhY29uICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAnW2RldGFjaF0gc2VuZEJlYWNvbkRyaXZlciByZXF1aXJlcyBhIGJyb3dzZXIgZW52aXJvbm1lbnQgd2l0aCBgbmF2aWdhdG9yLnNlbmRCZWFjb25gLiAnICtcbiAgICAgICAgICAgICdVc2UgYG1pY3JvdGFza0JhdGNoRHJpdmVyYCBmb3IgaW4tcHJvY2VzcyBkZXRhY2gsIG9yIGBzZXRJbW1lZGlhdGVEcml2ZXJgIGZvciBOb2RlLmpzLicsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSxcbiAgICBzY2hlZHVsZShfY2hpbGQ6IEZsb3dDaGFydCwgaW5wdXQ6IHVua25vd24sIHJlZklkOiBzdHJpbmcpOiBEZXRhY2hIYW5kbGUge1xuICAgICAgY29uc3QgaGFuZGxlID0gY3JlYXRlSGFuZGxlKHJlZklkKTtcbiAgICAgIHJlZ2lzdGVyKGhhbmRsZSk7XG4gICAgICBjb25zdCBpbXBsID0gYXNJbXBsKGhhbmRsZSk7XG4gICAgICBpbXBsLl9tYXJrUnVubmluZygpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IHNlcmlhbGl6ZShpbnB1dCk7XG4gICAgICAgIGNvbnN0IGFjY2VwdGVkID0gbmF2aWdhdG9yLnNlbmRCZWFjb24ob3B0cy51cmwsIHBheWxvYWQgYXMgQm9keUluaXQpO1xuICAgICAgICBpZiAoYWNjZXB0ZWQpIHtcbiAgICAgICAgICBpbXBsLl9tYXJrRG9uZSh7IGFjY2VwdGVkOiB0cnVlLCB1cmw6IG9wdHMudXJsIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGltcGwuX21hcmtGYWlsZWQoXG4gICAgICAgICAgICBuZXcgRXJyb3IoJ1tkZXRhY2hdIG5hdmlnYXRvci5zZW5kQmVhY29uIHJlZnVzZWQgdGhlIHBheWxvYWQgKGxpa2VseSBvdmVyIHRoZSB+NjQgS0IgbGltaXQpLicpLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpbXBsLl9tYXJrRmFpbGVkKGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB1bnJlZ2lzdGVyKGltcGwuaWQpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGhhbmRsZTtcbiAgICB9LFxuICB9O1xufVxuIl19