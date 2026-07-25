/**
 * detach/flush.ts — Drain every in-flight detached handle to terminal.
 *
 * Pattern:  Drain-loop with deadline. Same shape as a graceful HTTP
 *           server shutdown: snapshot the queue, await everything in
 *           flight, repeat until empty or deadline.
 * Role:     Graceful-shutdown hook for consumers who launched
 *           fire-and-forget work and want to make sure it actually
 *           flushed before exiting (server stop, test cleanup, etc.).
 *
 * Why iterate (not single Promise.all over a snapshot):
 *   - A child stage can itself call `detachAndForget` while running —
 *     new handles arrive WHILE we're flushing. A single snapshot would
 *     miss them. Looping until `size() === 0` drains transitively.
 *
 * Why dedupe via `seen` Set:
 *   - Handles already terminal (but not yet `unregister`ed by their
 *     driver's finally-block) can re-appear in subsequent snapshots.
 *     Without dedupe, the `done` counter would double-count them.
 *
 * Why `Promise.allSettled` (not `Promise.all`):
 *   - One handle's rejection must NOT abort the rest. A failed child
 *     is normal (it's why `wait()` rejects); we still want to drain
 *     the siblings.
 */
import { ids, lookup, size } from './registry.js';
/**
 * Wait for every in-flight detached handle to reach a terminal state.
 * Returns counts for diagnostics. PROCESS-WIDE — drains every driver
 * across every executor. For per-executor scoping, consumers should
 * collect their own handles from `executor.detachAndJoinLater(...)`
 * calls and await `Promise.allSettled([...].map(h => h.wait()))`
 * themselves.
 *
 * @example Graceful server shutdown
 * ```typescript
 * import { flushAllDetached } from 'footprintjs/detach';
 *
 * process.on('SIGTERM', async () => {
 *   const stats = await flushAllDetached({ timeoutMs: 10_000 });
 *   console.log(`Drained ${stats.done} done, ${stats.failed} failed, ${stats.pending} pending.`);
 *   process.exit(stats.pending === 0 ? 0 : 1);
 * });
 * ```
 */
export async function flushAllDetached(opts) {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const startedAt = Date.now();
    const seen = new Set();
    let done = 0;
    let failed = 0;
    while (size() > 0) {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0)
            return { done, failed, pending: size() };
        // Snapshot of NEW (unseen) handles. Existing terminal-but-still-
        // registered handles re-appear in subsequent snapshots; the seen
        // set prevents double-counting.
        const newIds = ids().filter((id) => !seen.has(id));
        if (newIds.length === 0) {
            // Everything in the registry is already awaited — yield once and
            // re-check. The driver's unregister-in-finally hasn't run yet.
            await Promise.resolve();
            continue;
        }
        for (const id of newIds)
            seen.add(id);
        const handles = newIds.map((id) => lookup(id)).filter((h) => h !== undefined);
        // Race the drain against the per-iteration timeout. We use a
        // `'timeout'` sentinel on the timeout side so the type narrows.
        let timerId;
        const timeoutPromise = new Promise((resolve) => {
            timerId = setTimeout(() => resolve('__detach_timeout__'), remainingMs);
        });
        const drainPromise = Promise.allSettled(handles.map((h) => h.wait()));
        const result = await Promise.race([drainPromise, timeoutPromise]);
        if (timerId !== undefined)
            clearTimeout(timerId);
        if (result === '__detach_timeout__') {
            return { done, failed, pending: size() };
        }
        for (const r of result) {
            if (r.status === 'fulfilled')
                done++;
            else
                failed++;
        }
    }
    return { done, failed, pending: 0 };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmx1c2guanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2RldGFjaC9mbHVzaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBd0JHO0FBRUgsT0FBTyxFQUFFLEdBQUcsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBc0JsRDs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBa0JHO0FBQ0gsTUFBTSxDQUFDLEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxJQUFtQjtJQUN4RCxNQUFNLFNBQVMsR0FBRyxJQUFJLEVBQUUsU0FBUyxJQUFJLE1BQU0sQ0FBQztJQUM1QyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDN0IsTUFBTSxJQUFJLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUMvQixJQUFJLElBQUksR0FBRyxDQUFDLENBQUM7SUFDYixJQUFJLE1BQU0sR0FBRyxDQUFDLENBQUM7SUFFZixPQUFPLElBQUksRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2xCLE1BQU0sV0FBVyxHQUFHLFNBQVMsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxTQUFTLENBQUMsQ0FBQztRQUN6RCxJQUFJLFdBQVcsSUFBSSxDQUFDO1lBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxFQUFFLENBQUM7UUFFL0QsaUVBQWlFO1FBQ2pFLGlFQUFpRTtRQUNqRSxnQ0FBZ0M7UUFDaEMsTUFBTSxNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUNuRCxJQUFJLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7WUFDeEIsaUVBQWlFO1lBQ2pFLCtEQUErRDtZQUMvRCxNQUFNLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUN4QixTQUFTO1FBQ1gsQ0FBQztRQUNELEtBQUssTUFBTSxFQUFFLElBQUksTUFBTTtZQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7UUFFdEMsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFxQixFQUFFLENBQUMsQ0FBQyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1FBRWpHLDZEQUE2RDtRQUM3RCxnRUFBZ0U7UUFDaEUsSUFBSSxPQUFrRCxDQUFDO1FBQ3ZELE1BQU0sY0FBYyxHQUFHLElBQUksT0FBTyxDQUF1QixDQUFDLE9BQU8sRUFBRSxFQUFFO1lBQ25FLE9BQU8sR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLG9CQUFvQixDQUFDLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDekUsQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDdEUsTUFBTSxNQUFNLEdBQUcsTUFBTSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsWUFBWSxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUM7UUFDbEUsSUFBSSxPQUFPLEtBQUssU0FBUztZQUFFLFlBQVksQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUVqRCxJQUFJLE1BQU0sS0FBSyxvQkFBb0IsRUFBRSxDQUFDO1lBQ3BDLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDO1FBQzNDLENBQUM7UUFDRCxLQUFLLE1BQU0sQ0FBQyxJQUFJLE1BQU0sRUFBRSxDQUFDO1lBQ3ZCLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxXQUFXO2dCQUFFLElBQUksRUFBRSxDQUFDOztnQkFDaEMsTUFBTSxFQUFFLENBQUM7UUFDaEIsQ0FBQztJQUNILENBQUM7SUFFRCxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUM7QUFDdEMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGV0YWNoL2ZsdXNoLnRzIOKAlCBEcmFpbiBldmVyeSBpbi1mbGlnaHQgZGV0YWNoZWQgaGFuZGxlIHRvIHRlcm1pbmFsLlxuICpcbiAqIFBhdHRlcm46ICBEcmFpbi1sb29wIHdpdGggZGVhZGxpbmUuIFNhbWUgc2hhcGUgYXMgYSBncmFjZWZ1bCBIVFRQXG4gKiAgICAgICAgICAgc2VydmVyIHNodXRkb3duOiBzbmFwc2hvdCB0aGUgcXVldWUsIGF3YWl0IGV2ZXJ5dGhpbmcgaW5cbiAqICAgICAgICAgICBmbGlnaHQsIHJlcGVhdCB1bnRpbCBlbXB0eSBvciBkZWFkbGluZS5cbiAqIFJvbGU6ICAgICBHcmFjZWZ1bC1zaHV0ZG93biBob29rIGZvciBjb25zdW1lcnMgd2hvIGxhdW5jaGVkXG4gKiAgICAgICAgICAgZmlyZS1hbmQtZm9yZ2V0IHdvcmsgYW5kIHdhbnQgdG8gbWFrZSBzdXJlIGl0IGFjdHVhbGx5XG4gKiAgICAgICAgICAgZmx1c2hlZCBiZWZvcmUgZXhpdGluZyAoc2VydmVyIHN0b3AsIHRlc3QgY2xlYW51cCwgZXRjLikuXG4gKlxuICogV2h5IGl0ZXJhdGUgKG5vdCBzaW5nbGUgUHJvbWlzZS5hbGwgb3ZlciBhIHNuYXBzaG90KTpcbiAqICAgLSBBIGNoaWxkIHN0YWdlIGNhbiBpdHNlbGYgY2FsbCBgZGV0YWNoQW5kRm9yZ2V0YCB3aGlsZSBydW5uaW5nIOKAlFxuICogICAgIG5ldyBoYW5kbGVzIGFycml2ZSBXSElMRSB3ZSdyZSBmbHVzaGluZy4gQSBzaW5nbGUgc25hcHNob3Qgd291bGRcbiAqICAgICBtaXNzIHRoZW0uIExvb3BpbmcgdW50aWwgYHNpemUoKSA9PT0gMGAgZHJhaW5zIHRyYW5zaXRpdmVseS5cbiAqXG4gKiBXaHkgZGVkdXBlIHZpYSBgc2VlbmAgU2V0OlxuICogICAtIEhhbmRsZXMgYWxyZWFkeSB0ZXJtaW5hbCAoYnV0IG5vdCB5ZXQgYHVucmVnaXN0ZXJgZWQgYnkgdGhlaXJcbiAqICAgICBkcml2ZXIncyBmaW5hbGx5LWJsb2NrKSBjYW4gcmUtYXBwZWFyIGluIHN1YnNlcXVlbnQgc25hcHNob3RzLlxuICogICAgIFdpdGhvdXQgZGVkdXBlLCB0aGUgYGRvbmVgIGNvdW50ZXIgd291bGQgZG91YmxlLWNvdW50IHRoZW0uXG4gKlxuICogV2h5IGBQcm9taXNlLmFsbFNldHRsZWRgIChub3QgYFByb21pc2UuYWxsYCk6XG4gKiAgIC0gT25lIGhhbmRsZSdzIHJlamVjdGlvbiBtdXN0IE5PVCBhYm9ydCB0aGUgcmVzdC4gQSBmYWlsZWQgY2hpbGRcbiAqICAgICBpcyBub3JtYWwgKGl0J3Mgd2h5IGB3YWl0KClgIHJlamVjdHMpOyB3ZSBzdGlsbCB3YW50IHRvIGRyYWluXG4gKiAgICAgdGhlIHNpYmxpbmdzLlxuICovXG5cbmltcG9ydCB7IGlkcywgbG9va3VwLCBzaXplIH0gZnJvbSAnLi9yZWdpc3RyeS5qcyc7XG5pbXBvcnQgdHlwZSB7IERldGFjaEhhbmRsZSB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZsdXNoUmVzdWx0IHtcbiAgLyoqIEhhbmRsZXMgd2hvc2UgYHdhaXQoKWAgd2UgRVhQTElDSVRMWSBhd2FpdGVkIGFuZCBzYXcgZnVsZmlsbGVkLlxuICAgKiAgQmVzdC1lZmZvcnQgY291bnQg4oCUIGEgY2hpbGQgdGhhdCBjb21wbGV0ZXMgaW5zaWRlIGFub3RoZXInc1xuICAgKiAgYHdhaXQoKWAgbWF5IGZpbmlzaCAoYW5kIHVucmVnaXN0ZXIpIGJlZm9yZSB3ZSBnZXQgYSBjaGFuY2UgdG9cbiAgICogIGF3YWl0IGl0IGRpcmVjdGx5LiBUaGUgRFJBSU4gaXMgc3RpbGwgZ3VhcmFudGVlZCAocmVnaXN0cnkgZW1wdHlcbiAgICogIG9uIHJldHVybik7IG9ubHkgdGhlIENPVU5UIGlzIGFwcHJveGltYXRlLiAqL1xuICByZWFkb25seSBkb25lOiBudW1iZXI7XG4gIC8qKiBIYW5kbGVzIHdob3NlIGB3YWl0KClgIHJlamVjdGVkLiBTYW1lIGJlc3QtZWZmb3J0IHNlbWFudGljcy4gKi9cbiAgcmVhZG9ubHkgZmFpbGVkOiBudW1iZXI7XG4gIC8qKiBIYW5kbGVzIHN0aWxsIGluLWZsaWdodCB3aGVuIHRoZSBkZWFkbGluZSBleHBpcmVkLiBgMGAgaW5kaWNhdGVzXG4gICAqICBhIHN1Y2Nlc3NmdWwgKGNvbXBsZXRlKSBkcmFpbiDigJQgcmVnaXN0cnkgd2FzIGVtcHR5IG9uIHJldHVybi4gKi9cbiAgcmVhZG9ubHkgcGVuZGluZzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEZsdXNoT3B0aW9ucyB7XG4gIC8qKiBNYXggd2FsbC1jbG9jayB0byBzcGVuZCBkcmFpbmluZywgaW4gbWlsbGlzZWNvbmRzLiBEZWZhdWx0IDMwcy4gKi9cbiAgcmVhZG9ubHkgdGltZW91dE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFdhaXQgZm9yIGV2ZXJ5IGluLWZsaWdodCBkZXRhY2hlZCBoYW5kbGUgdG8gcmVhY2ggYSB0ZXJtaW5hbCBzdGF0ZS5cbiAqIFJldHVybnMgY291bnRzIGZvciBkaWFnbm9zdGljcy4gUFJPQ0VTUy1XSURFIOKAlCBkcmFpbnMgZXZlcnkgZHJpdmVyXG4gKiBhY3Jvc3MgZXZlcnkgZXhlY3V0b3IuIEZvciBwZXItZXhlY3V0b3Igc2NvcGluZywgY29uc3VtZXJzIHNob3VsZFxuICogY29sbGVjdCB0aGVpciBvd24gaGFuZGxlcyBmcm9tIGBleGVjdXRvci5kZXRhY2hBbmRKb2luTGF0ZXIoLi4uKWBcbiAqIGNhbGxzIGFuZCBhd2FpdCBgUHJvbWlzZS5hbGxTZXR0bGVkKFsuLi5dLm1hcChoID0+IGgud2FpdCgpKSlgXG4gKiB0aGVtc2VsdmVzLlxuICpcbiAqIEBleGFtcGxlIEdyYWNlZnVsIHNlcnZlciBzaHV0ZG93blxuICogYGBgdHlwZXNjcmlwdFxuICogaW1wb3J0IHsgZmx1c2hBbGxEZXRhY2hlZCB9IGZyb20gJ2Zvb3RwcmludGpzL2RldGFjaCc7XG4gKlxuICogcHJvY2Vzcy5vbignU0lHVEVSTScsIGFzeW5jICgpID0+IHtcbiAqICAgY29uc3Qgc3RhdHMgPSBhd2FpdCBmbHVzaEFsbERldGFjaGVkKHsgdGltZW91dE1zOiAxMF8wMDAgfSk7XG4gKiAgIGNvbnNvbGUubG9nKGBEcmFpbmVkICR7c3RhdHMuZG9uZX0gZG9uZSwgJHtzdGF0cy5mYWlsZWR9IGZhaWxlZCwgJHtzdGF0cy5wZW5kaW5nfSBwZW5kaW5nLmApO1xuICogICBwcm9jZXNzLmV4aXQoc3RhdHMucGVuZGluZyA9PT0gMCA/IDAgOiAxKTtcbiAqIH0pO1xuICogYGBgXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmbHVzaEFsbERldGFjaGVkKG9wdHM/OiBGbHVzaE9wdGlvbnMpOiBQcm9taXNlPEZsdXNoUmVzdWx0PiB7XG4gIGNvbnN0IHRpbWVvdXRNcyA9IG9wdHM/LnRpbWVvdXRNcyA/PyAzMF8wMDA7XG4gIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgbGV0IGRvbmUgPSAwO1xuICBsZXQgZmFpbGVkID0gMDtcblxuICB3aGlsZSAoc2l6ZSgpID4gMCkge1xuICAgIGNvbnN0IHJlbWFpbmluZ01zID0gdGltZW91dE1zIC0gKERhdGUubm93KCkgLSBzdGFydGVkQXQpO1xuICAgIGlmIChyZW1haW5pbmdNcyA8PSAwKSByZXR1cm4geyBkb25lLCBmYWlsZWQsIHBlbmRpbmc6IHNpemUoKSB9O1xuXG4gICAgLy8gU25hcHNob3Qgb2YgTkVXICh1bnNlZW4pIGhhbmRsZXMuIEV4aXN0aW5nIHRlcm1pbmFsLWJ1dC1zdGlsbC1cbiAgICAvLyByZWdpc3RlcmVkIGhhbmRsZXMgcmUtYXBwZWFyIGluIHN1YnNlcXVlbnQgc25hcHNob3RzOyB0aGUgc2VlblxuICAgIC8vIHNldCBwcmV2ZW50cyBkb3VibGUtY291bnRpbmcuXG4gICAgY29uc3QgbmV3SWRzID0gaWRzKCkuZmlsdGVyKChpZCkgPT4gIXNlZW4uaGFzKGlkKSk7XG4gICAgaWYgKG5ld0lkcy5sZW5ndGggPT09IDApIHtcbiAgICAgIC8vIEV2ZXJ5dGhpbmcgaW4gdGhlIHJlZ2lzdHJ5IGlzIGFscmVhZHkgYXdhaXRlZCDigJQgeWllbGQgb25jZSBhbmRcbiAgICAgIC8vIHJlLWNoZWNrLiBUaGUgZHJpdmVyJ3MgdW5yZWdpc3Rlci1pbi1maW5hbGx5IGhhc24ndCBydW4geWV0LlxuICAgICAgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBpZCBvZiBuZXdJZHMpIHNlZW4uYWRkKGlkKTtcblxuICAgIGNvbnN0IGhhbmRsZXMgPSBuZXdJZHMubWFwKChpZCkgPT4gbG9va3VwKGlkKSkuZmlsdGVyKChoKTogaCBpcyBEZXRhY2hIYW5kbGUgPT4gaCAhPT0gdW5kZWZpbmVkKTtcblxuICAgIC8vIFJhY2UgdGhlIGRyYWluIGFnYWluc3QgdGhlIHBlci1pdGVyYXRpb24gdGltZW91dC4gV2UgdXNlIGFcbiAgICAvLyBgJ3RpbWVvdXQnYCBzZW50aW5lbCBvbiB0aGUgdGltZW91dCBzaWRlIHNvIHRoZSB0eXBlIG5hcnJvd3MuXG4gICAgbGV0IHRpbWVySWQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IHRpbWVvdXRQcm9taXNlID0gbmV3IFByb21pc2U8J19fZGV0YWNoX3RpbWVvdXRfXyc+KChyZXNvbHZlKSA9PiB7XG4gICAgICB0aW1lcklkID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCdfX2RldGFjaF90aW1lb3V0X18nKSwgcmVtYWluaW5nTXMpO1xuICAgIH0pO1xuICAgIGNvbnN0IGRyYWluUHJvbWlzZSA9IFByb21pc2UuYWxsU2V0dGxlZChoYW5kbGVzLm1hcCgoaCkgPT4gaC53YWl0KCkpKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW2RyYWluUHJvbWlzZSwgdGltZW91dFByb21pc2VdKTtcbiAgICBpZiAodGltZXJJZCAhPT0gdW5kZWZpbmVkKSBjbGVhclRpbWVvdXQodGltZXJJZCk7XG5cbiAgICBpZiAocmVzdWx0ID09PSAnX19kZXRhY2hfdGltZW91dF9fJykge1xuICAgICAgcmV0dXJuIHsgZG9uZSwgZmFpbGVkLCBwZW5kaW5nOiBzaXplKCkgfTtcbiAgICB9XG4gICAgZm9yIChjb25zdCByIG9mIHJlc3VsdCkge1xuICAgICAgaWYgKHIuc3RhdHVzID09PSAnZnVsZmlsbGVkJykgZG9uZSsrO1xuICAgICAgZWxzZSBmYWlsZWQrKztcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBkb25lLCBmYWlsZWQsIHBlbmRpbmc6IDAgfTtcbn1cbiJdfQ==