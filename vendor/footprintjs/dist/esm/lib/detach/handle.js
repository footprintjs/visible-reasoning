/**
 * detach/handle.ts — DetachHandle implementation.
 *
 * Pattern:  Object-as-state-machine. Mutable status field; transitions
 *           are one-way and irreversible (queued → running → done/failed).
 * Role:     Backs the consumer-facing `DetachHandle` interface. The
 *           public surface is the interface (defined in `types.ts`);
 *           this class is the runtime impl.
 *
 * Internal vs public split:
 *   - PUBLIC (in `types.ts`)   — read-only properties + `wait()`
 *   - INTERNAL (this file)     — `_markRunning` / `_markDone` /
 *                                `_markFailed` mutators called by drivers
 *
 * The class implements `DetachHandle` (which has only readonly fields
 * exposed). Drivers cast to `HandleImpl` via the `asImpl()` helper to
 * call the mutators — a controlled escape from readonly. Consumers
 * cannot do this (they only see the interface).
 *
 * Promise caching contract:
 *   - First `wait()` call:
 *       - if status terminal → returns IMMEDIATELY-resolved Promise
 *       - if not terminal    → returns NEW Promise; resolvers stored
 *                              for use by `_markDone` / `_markFailed`
 *   - Subsequent `wait()` calls → returns the SAME cached Promise
 *   - The resolved/rejected value is the SAME on every call (no
 *     re-running, no duplicated work)
 *
 * Concurrency notes:
 *   - All transitions are sync. JavaScript is single-threaded so no
 *     atomics or locks needed.
 *   - State transitions out of terminal states are forbidden — calling
 *     `_markDone` after `_markFailed` (or vice-versa) is a no-op
 *     (defensive: prevents driver bugs from corrupting state).
 */
/**
 * Internal handle implementation. Drivers call the `_mark*` methods
 * to drive state transitions; consumers see only the readonly
 * `DetachHandle` interface.
 */
export class HandleImpl {
    id;
    status = 'queued';
    result = undefined;
    error = undefined;
    // Lazy Promise cache — created on first `wait()` call.
    waitPromise = null;
    // Resolvers captured when wait() was called BEFORE terminal state.
    resolveWait = null;
    rejectWait = null;
    constructor(id) {
        this.id = id;
    }
    /**
     * Public — opt-in async join. Returns a cached Promise.
     * See `DetachHandle.wait()` docstring for contract.
     */
    wait() {
        if (this.waitPromise)
            return this.waitPromise;
        if (this.status === 'done') {
            this.waitPromise = Promise.resolve({ result: this.result });
        }
        else if (this.status === 'failed') {
            this.waitPromise = Promise.reject(this.error);
        }
        else {
            // Pending terminal — store resolvers for _markDone / _markFailed.
            this.waitPromise = new Promise((resolve, reject) => {
                this.resolveWait = resolve;
                this.rejectWait = reject;
            });
        }
        return this.waitPromise;
    }
    // ── Internal mutators (called by drivers) ──────────────────────────
    /** Transition queued → running. No-op if already past 'queued'. */
    _markRunning() {
        if (this.status !== 'queued')
            return;
        this.status = 'running';
    }
    /**
     * Transition to terminal 'done' with the given result. No-op if
     * already terminal (defensive: prevents driver bugs from corrupting
     * state).
     */
    _markDone(result) {
        if (this.status === 'done' || this.status === 'failed')
            return;
        this.status = 'done';
        this.result = result;
        // If consumer already called wait(), unblock its Promise.
        this.resolveWait?.({ result });
        this.resolveWait = null;
        this.rejectWait = null;
    }
    /**
     * Transition to terminal 'failed' with the given error. No-op if
     * already terminal.
     */
    _markFailed(error) {
        if (this.status === 'done' || this.status === 'failed')
            return;
        this.status = 'failed';
        this.error = error;
        this.rejectWait?.(error);
        this.resolveWait = null;
        this.rejectWait = null;
    }
}
/**
 * Type-narrowing helper — cast a public `DetachHandle` to its
 * implementation. Drivers (only) use this to call internal mutators.
 *
 * Throws if the handle isn't actually a `HandleImpl` — defends
 * against consumers passing a hand-rolled object that satisfies the
 * interface shape but lacks the mutators.
 */
export function asImpl(handle) {
    if (!(handle instanceof HandleImpl)) {
        throw new TypeError('[detach] expected a HandleImpl returned by createHandle(); got an arbitrary DetachHandle. ' +
            'Drivers must use createHandle() to construct handles, not hand-roll them.');
    }
    return handle;
}
/**
 * Driver-facing factory. Drivers MUST use this to create handles
 * (NOT construct `HandleImpl` directly — keeps the impl type private).
 */
export function createHandle(id) {
    return new HandleImpl(id);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGFuZGxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9kZXRhY2gvaGFuZGxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBa0NHO0FBSUg7Ozs7R0FJRztBQUNILE1BQU0sT0FBTyxVQUFVO0lBQ1osRUFBRSxDQUFTO0lBQ3BCLE1BQU0sR0FBMkIsUUFBUSxDQUFDO0lBQzFDLE1BQU0sR0FBWSxTQUFTLENBQUM7SUFDNUIsS0FBSyxHQUFzQixTQUFTLENBQUM7SUFFckMsdURBQXVEO0lBQy9DLFdBQVcsR0FBcUMsSUFBSSxDQUFDO0lBQzdELG1FQUFtRTtJQUMzRCxXQUFXLEdBQTJDLElBQUksQ0FBQztJQUMzRCxVQUFVLEdBQWdDLElBQUksQ0FBQztJQUV2RCxZQUFZLEVBQVU7UUFDcEIsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUM7SUFDZixDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsSUFBSTtRQUNGLElBQUksSUFBSSxDQUFDLFdBQVc7WUFBRSxPQUFPLElBQUksQ0FBQyxXQUFXLENBQUM7UUFFOUMsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLE1BQU0sRUFBRSxDQUFDO1lBQzNCLElBQUksQ0FBQyxXQUFXLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztRQUM5RCxDQUFDO2FBQU0sSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3BDLElBQUksQ0FBQyxXQUFXLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDaEQsQ0FBQzthQUFNLENBQUM7WUFDTixrRUFBa0U7WUFDbEUsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLE9BQU8sQ0FBbUIsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7Z0JBQ25FLElBQUksQ0FBQyxXQUFXLEdBQUcsT0FBTyxDQUFDO2dCQUMzQixJQUFJLENBQUMsVUFBVSxHQUFHLE1BQU0sQ0FBQztZQUMzQixDQUFDLENBQUMsQ0FBQztRQUNMLENBQUM7UUFDRCxPQUFPLElBQUksQ0FBQyxXQUFXLENBQUM7SUFDMUIsQ0FBQztJQUVELHNFQUFzRTtJQUV0RSxtRUFBbUU7SUFDbkUsWUFBWTtRQUNWLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxRQUFRO1lBQUUsT0FBTztRQUNyQyxJQUFJLENBQUMsTUFBTSxHQUFHLFNBQVMsQ0FBQztJQUMxQixDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILFNBQVMsQ0FBQyxNQUFlO1FBQ3ZCLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxNQUFNLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxRQUFRO1lBQUUsT0FBTztRQUMvRCxJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQiwwREFBMEQ7UUFDMUQsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztRQUMvQixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztRQUN4QixJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQztJQUN6QixDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsV0FBVyxDQUFDLEtBQVk7UUFDdEIsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLE1BQU0sSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVE7WUFBRSxPQUFPO1FBQy9ELElBQUksQ0FBQyxNQUFNLEdBQUcsUUFBUSxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQ25CLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN6QixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztRQUN4QixJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQztJQUN6QixDQUFDO0NBQ0Y7QUFFRDs7Ozs7OztHQU9HO0FBQ0gsTUFBTSxVQUFVLE1BQU0sQ0FBQyxNQUFvQjtJQUN6QyxJQUFJLENBQUMsQ0FBQyxNQUFNLFlBQVksVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUNwQyxNQUFNLElBQUksU0FBUyxDQUNqQiw0RkFBNEY7WUFDMUYsMkVBQTJFLENBQzlFLENBQUM7SUFDSixDQUFDO0lBQ0QsT0FBTyxNQUFNLENBQUM7QUFDaEIsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSxZQUFZLENBQUMsRUFBVTtJQUNyQyxPQUFPLElBQUksVUFBVSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQzVCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGRldGFjaC9oYW5kbGUudHMg4oCUIERldGFjaEhhbmRsZSBpbXBsZW1lbnRhdGlvbi5cbiAqXG4gKiBQYXR0ZXJuOiAgT2JqZWN0LWFzLXN0YXRlLW1hY2hpbmUuIE11dGFibGUgc3RhdHVzIGZpZWxkOyB0cmFuc2l0aW9uc1xuICogICAgICAgICAgIGFyZSBvbmUtd2F5IGFuZCBpcnJldmVyc2libGUgKHF1ZXVlZCDihpIgcnVubmluZyDihpIgZG9uZS9mYWlsZWQpLlxuICogUm9sZTogICAgIEJhY2tzIHRoZSBjb25zdW1lci1mYWNpbmcgYERldGFjaEhhbmRsZWAgaW50ZXJmYWNlLiBUaGVcbiAqICAgICAgICAgICBwdWJsaWMgc3VyZmFjZSBpcyB0aGUgaW50ZXJmYWNlIChkZWZpbmVkIGluIGB0eXBlcy50c2ApO1xuICogICAgICAgICAgIHRoaXMgY2xhc3MgaXMgdGhlIHJ1bnRpbWUgaW1wbC5cbiAqXG4gKiBJbnRlcm5hbCB2cyBwdWJsaWMgc3BsaXQ6XG4gKiAgIC0gUFVCTElDIChpbiBgdHlwZXMudHNgKSAgIOKAlCByZWFkLW9ubHkgcHJvcGVydGllcyArIGB3YWl0KClgXG4gKiAgIC0gSU5URVJOQUwgKHRoaXMgZmlsZSkgICAgIOKAlCBgX21hcmtSdW5uaW5nYCAvIGBfbWFya0RvbmVgIC9cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgX21hcmtGYWlsZWRgIG11dGF0b3JzIGNhbGxlZCBieSBkcml2ZXJzXG4gKlxuICogVGhlIGNsYXNzIGltcGxlbWVudHMgYERldGFjaEhhbmRsZWAgKHdoaWNoIGhhcyBvbmx5IHJlYWRvbmx5IGZpZWxkc1xuICogZXhwb3NlZCkuIERyaXZlcnMgY2FzdCB0byBgSGFuZGxlSW1wbGAgdmlhIHRoZSBgYXNJbXBsKClgIGhlbHBlciB0b1xuICogY2FsbCB0aGUgbXV0YXRvcnMg4oCUIGEgY29udHJvbGxlZCBlc2NhcGUgZnJvbSByZWFkb25seS4gQ29uc3VtZXJzXG4gKiBjYW5ub3QgZG8gdGhpcyAodGhleSBvbmx5IHNlZSB0aGUgaW50ZXJmYWNlKS5cbiAqXG4gKiBQcm9taXNlIGNhY2hpbmcgY29udHJhY3Q6XG4gKiAgIC0gRmlyc3QgYHdhaXQoKWAgY2FsbDpcbiAqICAgICAgIC0gaWYgc3RhdHVzIHRlcm1pbmFsIOKGkiByZXR1cm5zIElNTUVESUFURUxZLXJlc29sdmVkIFByb21pc2VcbiAqICAgICAgIC0gaWYgbm90IHRlcm1pbmFsICAgIOKGkiByZXR1cm5zIE5FVyBQcm9taXNlOyByZXNvbHZlcnMgc3RvcmVkXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvciB1c2UgYnkgYF9tYXJrRG9uZWAgLyBgX21hcmtGYWlsZWRgXG4gKiAgIC0gU3Vic2VxdWVudCBgd2FpdCgpYCBjYWxscyDihpIgcmV0dXJucyB0aGUgU0FNRSBjYWNoZWQgUHJvbWlzZVxuICogICAtIFRoZSByZXNvbHZlZC9yZWplY3RlZCB2YWx1ZSBpcyB0aGUgU0FNRSBvbiBldmVyeSBjYWxsIChub1xuICogICAgIHJlLXJ1bm5pbmcsIG5vIGR1cGxpY2F0ZWQgd29yaylcbiAqXG4gKiBDb25jdXJyZW5jeSBub3RlczpcbiAqICAgLSBBbGwgdHJhbnNpdGlvbnMgYXJlIHN5bmMuIEphdmFTY3JpcHQgaXMgc2luZ2xlLXRocmVhZGVkIHNvIG5vXG4gKiAgICAgYXRvbWljcyBvciBsb2NrcyBuZWVkZWQuXG4gKiAgIC0gU3RhdGUgdHJhbnNpdGlvbnMgb3V0IG9mIHRlcm1pbmFsIHN0YXRlcyBhcmUgZm9yYmlkZGVuIOKAlCBjYWxsaW5nXG4gKiAgICAgYF9tYXJrRG9uZWAgYWZ0ZXIgYF9tYXJrRmFpbGVkYCAob3IgdmljZS12ZXJzYSkgaXMgYSBuby1vcFxuICogICAgIChkZWZlbnNpdmU6IHByZXZlbnRzIGRyaXZlciBidWdzIGZyb20gY29ycnVwdGluZyBzdGF0ZSkuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBEZXRhY2hIYW5kbGUsIERldGFjaFdhaXRSZXN1bHQgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLyoqXG4gKiBJbnRlcm5hbCBoYW5kbGUgaW1wbGVtZW50YXRpb24uIERyaXZlcnMgY2FsbCB0aGUgYF9tYXJrKmAgbWV0aG9kc1xuICogdG8gZHJpdmUgc3RhdGUgdHJhbnNpdGlvbnM7IGNvbnN1bWVycyBzZWUgb25seSB0aGUgcmVhZG9ubHlcbiAqIGBEZXRhY2hIYW5kbGVgIGludGVyZmFjZS5cbiAqL1xuZXhwb3J0IGNsYXNzIEhhbmRsZUltcGwgaW1wbGVtZW50cyBEZXRhY2hIYW5kbGUge1xuICByZWFkb25seSBpZDogc3RyaW5nO1xuICBzdGF0dXM6IERldGFjaEhhbmRsZVsnc3RhdHVzJ10gPSAncXVldWVkJztcbiAgcmVzdWx0OiB1bmtub3duID0gdW5kZWZpbmVkO1xuICBlcnJvcjogRXJyb3IgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cbiAgLy8gTGF6eSBQcm9taXNlIGNhY2hlIOKAlCBjcmVhdGVkIG9uIGZpcnN0IGB3YWl0KClgIGNhbGwuXG4gIHByaXZhdGUgd2FpdFByb21pc2U6IFByb21pc2U8RGV0YWNoV2FpdFJlc3VsdD4gfCBudWxsID0gbnVsbDtcbiAgLy8gUmVzb2x2ZXJzIGNhcHR1cmVkIHdoZW4gd2FpdCgpIHdhcyBjYWxsZWQgQkVGT1JFIHRlcm1pbmFsIHN0YXRlLlxuICBwcml2YXRlIHJlc29sdmVXYWl0OiAoKHY6IERldGFjaFdhaXRSZXN1bHQpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcmVqZWN0V2FpdDogKChlOiBFcnJvcikgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICBjb25zdHJ1Y3RvcihpZDogc3RyaW5nKSB7XG4gICAgdGhpcy5pZCA9IGlkO1xuICB9XG5cbiAgLyoqXG4gICAqIFB1YmxpYyDigJQgb3B0LWluIGFzeW5jIGpvaW4uIFJldHVybnMgYSBjYWNoZWQgUHJvbWlzZS5cbiAgICogU2VlIGBEZXRhY2hIYW5kbGUud2FpdCgpYCBkb2NzdHJpbmcgZm9yIGNvbnRyYWN0LlxuICAgKi9cbiAgd2FpdCgpOiBQcm9taXNlPERldGFjaFdhaXRSZXN1bHQ+IHtcbiAgICBpZiAodGhpcy53YWl0UHJvbWlzZSkgcmV0dXJuIHRoaXMud2FpdFByb21pc2U7XG5cbiAgICBpZiAodGhpcy5zdGF0dXMgPT09ICdkb25lJykge1xuICAgICAgdGhpcy53YWl0UHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSh7IHJlc3VsdDogdGhpcy5yZXN1bHQgfSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpIHtcbiAgICAgIHRoaXMud2FpdFByb21pc2UgPSBQcm9taXNlLnJlamVjdCh0aGlzLmVycm9yKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gUGVuZGluZyB0ZXJtaW5hbCDigJQgc3RvcmUgcmVzb2x2ZXJzIGZvciBfbWFya0RvbmUgLyBfbWFya0ZhaWxlZC5cbiAgICAgIHRoaXMud2FpdFByb21pc2UgPSBuZXcgUHJvbWlzZTxEZXRhY2hXYWl0UmVzdWx0PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIHRoaXMucmVzb2x2ZVdhaXQgPSByZXNvbHZlO1xuICAgICAgICB0aGlzLnJlamVjdFdhaXQgPSByZWplY3Q7XG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMud2FpdFByb21pc2U7XG4gIH1cblxuICAvLyDilIDilIAgSW50ZXJuYWwgbXV0YXRvcnMgKGNhbGxlZCBieSBkcml2ZXJzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogVHJhbnNpdGlvbiBxdWV1ZWQg4oaSIHJ1bm5pbmcuIE5vLW9wIGlmIGFscmVhZHkgcGFzdCAncXVldWVkJy4gKi9cbiAgX21hcmtSdW5uaW5nKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0YXR1cyAhPT0gJ3F1ZXVlZCcpIHJldHVybjtcbiAgICB0aGlzLnN0YXR1cyA9ICdydW5uaW5nJztcbiAgfVxuXG4gIC8qKlxuICAgKiBUcmFuc2l0aW9uIHRvIHRlcm1pbmFsICdkb25lJyB3aXRoIHRoZSBnaXZlbiByZXN1bHQuIE5vLW9wIGlmXG4gICAqIGFscmVhZHkgdGVybWluYWwgKGRlZmVuc2l2ZTogcHJldmVudHMgZHJpdmVyIGJ1Z3MgZnJvbSBjb3JydXB0aW5nXG4gICAqIHN0YXRlKS5cbiAgICovXG4gIF9tYXJrRG9uZShyZXN1bHQ6IHVua25vd24pOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdGF0dXMgPT09ICdkb25lJyB8fCB0aGlzLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpIHJldHVybjtcbiAgICB0aGlzLnN0YXR1cyA9ICdkb25lJztcbiAgICB0aGlzLnJlc3VsdCA9IHJlc3VsdDtcbiAgICAvLyBJZiBjb25zdW1lciBhbHJlYWR5IGNhbGxlZCB3YWl0KCksIHVuYmxvY2sgaXRzIFByb21pc2UuXG4gICAgdGhpcy5yZXNvbHZlV2FpdD8uKHsgcmVzdWx0IH0pO1xuICAgIHRoaXMucmVzb2x2ZVdhaXQgPSBudWxsO1xuICAgIHRoaXMucmVqZWN0V2FpdCA9IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogVHJhbnNpdGlvbiB0byB0ZXJtaW5hbCAnZmFpbGVkJyB3aXRoIHRoZSBnaXZlbiBlcnJvci4gTm8tb3AgaWZcbiAgICogYWxyZWFkeSB0ZXJtaW5hbC5cbiAgICovXG4gIF9tYXJrRmFpbGVkKGVycm9yOiBFcnJvcik6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0YXR1cyA9PT0gJ2RvbmUnIHx8IHRoaXMuc3RhdHVzID09PSAnZmFpbGVkJykgcmV0dXJuO1xuICAgIHRoaXMuc3RhdHVzID0gJ2ZhaWxlZCc7XG4gICAgdGhpcy5lcnJvciA9IGVycm9yO1xuICAgIHRoaXMucmVqZWN0V2FpdD8uKGVycm9yKTtcbiAgICB0aGlzLnJlc29sdmVXYWl0ID0gbnVsbDtcbiAgICB0aGlzLnJlamVjdFdhaXQgPSBudWxsO1xuICB9XG59XG5cbi8qKlxuICogVHlwZS1uYXJyb3dpbmcgaGVscGVyIOKAlCBjYXN0IGEgcHVibGljIGBEZXRhY2hIYW5kbGVgIHRvIGl0c1xuICogaW1wbGVtZW50YXRpb24uIERyaXZlcnMgKG9ubHkpIHVzZSB0aGlzIHRvIGNhbGwgaW50ZXJuYWwgbXV0YXRvcnMuXG4gKlxuICogVGhyb3dzIGlmIHRoZSBoYW5kbGUgaXNuJ3QgYWN0dWFsbHkgYSBgSGFuZGxlSW1wbGAg4oCUIGRlZmVuZHNcbiAqIGFnYWluc3QgY29uc3VtZXJzIHBhc3NpbmcgYSBoYW5kLXJvbGxlZCBvYmplY3QgdGhhdCBzYXRpc2ZpZXMgdGhlXG4gKiBpbnRlcmZhY2Ugc2hhcGUgYnV0IGxhY2tzIHRoZSBtdXRhdG9ycy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzSW1wbChoYW5kbGU6IERldGFjaEhhbmRsZSk6IEhhbmRsZUltcGwge1xuICBpZiAoIShoYW5kbGUgaW5zdGFuY2VvZiBIYW5kbGVJbXBsKSkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICAnW2RldGFjaF0gZXhwZWN0ZWQgYSBIYW5kbGVJbXBsIHJldHVybmVkIGJ5IGNyZWF0ZUhhbmRsZSgpOyBnb3QgYW4gYXJiaXRyYXJ5IERldGFjaEhhbmRsZS4gJyArXG4gICAgICAgICdEcml2ZXJzIG11c3QgdXNlIGNyZWF0ZUhhbmRsZSgpIHRvIGNvbnN0cnVjdCBoYW5kbGVzLCBub3QgaGFuZC1yb2xsIHRoZW0uJyxcbiAgICApO1xuICB9XG4gIHJldHVybiBoYW5kbGU7XG59XG5cbi8qKlxuICogRHJpdmVyLWZhY2luZyBmYWN0b3J5LiBEcml2ZXJzIE1VU1QgdXNlIHRoaXMgdG8gY3JlYXRlIGhhbmRsZXNcbiAqIChOT1QgY29uc3RydWN0IGBIYW5kbGVJbXBsYCBkaXJlY3RseSDigJQga2VlcHMgdGhlIGltcGwgdHlwZSBwcml2YXRlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUhhbmRsZShpZDogc3RyaW5nKTogRGV0YWNoSGFuZGxlIHtcbiAgcmV0dXJuIG5ldyBIYW5kbGVJbXBsKGlkKTtcbn1cbiJdfQ==