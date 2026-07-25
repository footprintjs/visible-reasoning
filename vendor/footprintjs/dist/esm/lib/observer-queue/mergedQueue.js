/**
 * observer-queue/mergedQueue.ts — RFC-001 Block 3: seq stamping + multi-channel merge.
 *
 * Pattern:  Single totally-ordered staging queue. All three observer
 *           channels (`scope` / `flow` / `emit`) funnel through ONE queue;
 *           the `seq` counter is assigned at capture under the single JS
 *           thread, so drain order == arrival order ACROSS channels with no
 *           cross-queue merge logic ever needed.
 * Role:     Glue between the capture tier (Block 1) and the flush driver
 *           (Block 4). Pure module — imports only `capture/envelope` and
 *           the ring (Block 2); zero engine knowledge.
 *
 * Seq semantics (normative, RFC-001 §5):
 *   - Stamped BEFORE admission — an event that is then dropped (overflow)
 *     or refused (`'block'`) still consumed its seq. Drops therefore leave
 *     VISIBLE gaps in the delivered stream (honest loss accounting), and
 *     `'block'`-refused events delivered inline keep their true arrival
 *     stamp even though they overtake the queued backlog.
 *   - Monotonic, starts at 0, never reused for the lifetime of the queue.
 *
 * Enqueue outcomes:
 *   - `'queued'`  — staged for the next flush (drop-oldest may have evicted
 *     an older event to make room; that loss is counted, never silent).
 *   - `'dropped'` — the event was sampled out at saturation. Lost; counted.
 *   - `'inline'`  — `'block'` policy refused the enqueue. NOT lost: the
 *     caller (the dispatcher, Block 5) must deliver the returned envelope
 *     synchronously inline — blocking delivery by explicit consumer choice.
 */
import { capture, } from '../capture/envelope.js';
import { BoundedRing } from './ring.js';
/** RFC-001 §5 default queue bound. */
export const DEFAULT_MAX_QUEUE = 10_000;
export class MergedQueue {
    ring;
    overflow;
    defaultPolicy;
    hooks;
    /** Arrival stamp — monotonic across ALL channels (see module header). */
    seq = 0;
    constructor(opts) {
        this.overflow = opts?.overflow ?? 'drop-oldest';
        this.ring = new BoundedRing({
            capacity: opts?.maxQueue ?? DEFAULT_MAX_QUEUE,
            policy: this.overflow,
            sampleEvery: opts?.sampleEvery,
        });
        this.defaultPolicy = opts?.capturePolicy ?? 'summary';
        this.hooks = opts?.hooks;
    }
    /**
     * Capture one event (seq-stamped at arrival) and stage it for deferred
     * delivery. `policy` overrides the queue default per call — e.g. `'ref'`
     * for payloads the caller proved immutable. Never throws.
     */
    enqueue(input, policy) {
        const envelope = capture({
            seq: this.seq,
            channel: input.channel,
            method: input.method,
            runtimeStageId: input.runtimeStageId,
            runId: input.runId,
            payload: input.payload,
        }, policy ?? this.defaultPolicy, this.hooks);
        this.seq += 1;
        const pushed = this.ring.push(envelope);
        if (pushed.accepted)
            return { envelope, outcome: 'queued' };
        return { envelope, outcome: this.overflow === 'block' ? 'inline' : 'dropped' };
    }
    /** Pop the oldest staged envelope (total arrival order across channels). */
    shift() {
        return this.ring.shift();
    }
    /** Current backlog. */
    get depth() {
        return this.ring.size;
    }
    /** Ring capacity (the `maxQueue` bound). */
    get capacity() {
        return this.ring.capacity;
    }
    /** The next seq to be assigned == total events captured so far. */
    get nextSeq() {
        return this.seq;
    }
    /** Lifetime loss/delivery accounting — delegated to the ring. */
    getCounters() {
        return this.ring.getCounters();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVyZ2VkUXVldWUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL29ic2VydmVyLXF1ZXVlL21lcmdlZFF1ZXVlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0EyQkc7QUFFSCxPQUFPLEVBS0wsT0FBTyxHQUNSLE1BQU0sd0JBQXdCLENBQUM7QUFDaEMsT0FBTyxFQUEwQyxXQUFXLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFFaEYsc0NBQXNDO0FBQ3RDLE1BQU0sQ0FBQyxNQUFNLGlCQUFpQixHQUFHLE1BQU0sQ0FBQztBQWtDeEMsTUFBTSxPQUFPLFdBQVc7SUFDTCxJQUFJLENBQStCO0lBQ25DLFFBQVEsQ0FBaUI7SUFDekIsYUFBYSxDQUFnQjtJQUM3QixLQUFLLENBQWdCO0lBQ3RDLHlFQUF5RTtJQUNqRSxHQUFHLEdBQUcsQ0FBQyxDQUFDO0lBRWhCLFlBQVksSUFBeUI7UUFDbkMsSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLEVBQUUsUUFBUSxJQUFJLGFBQWEsQ0FBQztRQUNoRCxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksV0FBVyxDQUFrQjtZQUMzQyxRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVEsSUFBSSxpQkFBaUI7WUFDN0MsTUFBTSxFQUFFLElBQUksQ0FBQyxRQUFRO1lBQ3JCLFdBQVcsRUFBRSxJQUFJLEVBQUUsV0FBVztTQUMvQixDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksRUFBRSxhQUFhLElBQUksU0FBUyxDQUFDO1FBQ3RELElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxFQUFFLEtBQUssQ0FBQztJQUMzQixDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILE9BQU8sQ0FBQyxLQUFtQixFQUFFLE1BQXNCO1FBQ2pELE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FDdEI7WUFDRSxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDYixPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDdEIsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNO1lBQ3BCLGNBQWMsRUFBRSxLQUFLLENBQUMsY0FBYztZQUNwQyxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUs7WUFDbEIsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1NBQ3ZCLEVBQ0QsTUFBTSxJQUFJLElBQUksQ0FBQyxhQUFhLEVBQzVCLElBQUksQ0FBQyxLQUFLLENBQ1gsQ0FBQztRQUNGLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDO1FBRWQsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDeEMsSUFBSSxNQUFNLENBQUMsUUFBUTtZQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxDQUFDO1FBQzVELE9BQU8sRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLElBQUksQ0FBQyxRQUFRLEtBQUssT0FBTyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFNBQVMsRUFBRSxDQUFDO0lBQ2pGLENBQUM7SUFFRCw0RUFBNEU7SUFDNUUsS0FBSztRQUNILE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUMzQixDQUFDO0lBRUQsdUJBQXVCO0lBQ3ZCLElBQUksS0FBSztRQUNQLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7SUFDeEIsQ0FBQztJQUVELDRDQUE0QztJQUM1QyxJQUFJLFFBQVE7UUFDVixPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO0lBQzVCLENBQUM7SUFFRCxtRUFBbUU7SUFDbkUsSUFBSSxPQUFPO1FBQ1QsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDO0lBQ2xCLENBQUM7SUFFRCxpRUFBaUU7SUFDakUsV0FBVztRQUNULE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUNqQyxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIG9ic2VydmVyLXF1ZXVlL21lcmdlZFF1ZXVlLnRzIOKAlCBSRkMtMDAxIEJsb2NrIDM6IHNlcSBzdGFtcGluZyArIG11bHRpLWNoYW5uZWwgbWVyZ2UuXG4gKlxuICogUGF0dGVybjogIFNpbmdsZSB0b3RhbGx5LW9yZGVyZWQgc3RhZ2luZyBxdWV1ZS4gQWxsIHRocmVlIG9ic2VydmVyXG4gKiAgICAgICAgICAgY2hhbm5lbHMgKGBzY29wZWAgLyBgZmxvd2AgLyBgZW1pdGApIGZ1bm5lbCB0aHJvdWdoIE9ORSBxdWV1ZTtcbiAqICAgICAgICAgICB0aGUgYHNlcWAgY291bnRlciBpcyBhc3NpZ25lZCBhdCBjYXB0dXJlIHVuZGVyIHRoZSBzaW5nbGUgSlNcbiAqICAgICAgICAgICB0aHJlYWQsIHNvIGRyYWluIG9yZGVyID09IGFycml2YWwgb3JkZXIgQUNST1NTIGNoYW5uZWxzIHdpdGggbm9cbiAqICAgICAgICAgICBjcm9zcy1xdWV1ZSBtZXJnZSBsb2dpYyBldmVyIG5lZWRlZC5cbiAqIFJvbGU6ICAgICBHbHVlIGJldHdlZW4gdGhlIGNhcHR1cmUgdGllciAoQmxvY2sgMSkgYW5kIHRoZSBmbHVzaCBkcml2ZXJcbiAqICAgICAgICAgICAoQmxvY2sgNCkuIFB1cmUgbW9kdWxlIOKAlCBpbXBvcnRzIG9ubHkgYGNhcHR1cmUvZW52ZWxvcGVgIGFuZFxuICogICAgICAgICAgIHRoZSByaW5nIChCbG9jayAyKTsgemVybyBlbmdpbmUga25vd2xlZGdlLlxuICpcbiAqIFNlcSBzZW1hbnRpY3MgKG5vcm1hdGl2ZSwgUkZDLTAwMSDCpzUpOlxuICogICAtIFN0YW1wZWQgQkVGT1JFIGFkbWlzc2lvbiDigJQgYW4gZXZlbnQgdGhhdCBpcyB0aGVuIGRyb3BwZWQgKG92ZXJmbG93KVxuICogICAgIG9yIHJlZnVzZWQgKGAnYmxvY2snYCkgc3RpbGwgY29uc3VtZWQgaXRzIHNlcS4gRHJvcHMgdGhlcmVmb3JlIGxlYXZlXG4gKiAgICAgVklTSUJMRSBnYXBzIGluIHRoZSBkZWxpdmVyZWQgc3RyZWFtIChob25lc3QgbG9zcyBhY2NvdW50aW5nKSwgYW5kXG4gKiAgICAgYCdibG9jaydgLXJlZnVzZWQgZXZlbnRzIGRlbGl2ZXJlZCBpbmxpbmUga2VlcCB0aGVpciB0cnVlIGFycml2YWxcbiAqICAgICBzdGFtcCBldmVuIHRob3VnaCB0aGV5IG92ZXJ0YWtlIHRoZSBxdWV1ZWQgYmFja2xvZy5cbiAqICAgLSBNb25vdG9uaWMsIHN0YXJ0cyBhdCAwLCBuZXZlciByZXVzZWQgZm9yIHRoZSBsaWZldGltZSBvZiB0aGUgcXVldWUuXG4gKlxuICogRW5xdWV1ZSBvdXRjb21lczpcbiAqICAgLSBgJ3F1ZXVlZCdgICDigJQgc3RhZ2VkIGZvciB0aGUgbmV4dCBmbHVzaCAoZHJvcC1vbGRlc3QgbWF5IGhhdmUgZXZpY3RlZFxuICogICAgIGFuIG9sZGVyIGV2ZW50IHRvIG1ha2Ugcm9vbTsgdGhhdCBsb3NzIGlzIGNvdW50ZWQsIG5ldmVyIHNpbGVudCkuXG4gKiAgIC0gYCdkcm9wcGVkJ2Ag4oCUIHRoZSBldmVudCB3YXMgc2FtcGxlZCBvdXQgYXQgc2F0dXJhdGlvbi4gTG9zdDsgY291bnRlZC5cbiAqICAgLSBgJ2lubGluZSdgICDigJQgYCdibG9jaydgIHBvbGljeSByZWZ1c2VkIHRoZSBlbnF1ZXVlLiBOT1QgbG9zdDogdGhlXG4gKiAgICAgY2FsbGVyICh0aGUgZGlzcGF0Y2hlciwgQmxvY2sgNSkgbXVzdCBkZWxpdmVyIHRoZSByZXR1cm5lZCBlbnZlbG9wZVxuICogICAgIHN5bmNocm9ub3VzbHkgaW5saW5lIOKAlCBibG9ja2luZyBkZWxpdmVyeSBieSBleHBsaWNpdCBjb25zdW1lciBjaG9pY2UuXG4gKi9cblxuaW1wb3J0IHtcbiAgdHlwZSBDYXB0dXJlQ2hhbm5lbCxcbiAgdHlwZSBDYXB0dXJlRW52ZWxvcGUsXG4gIHR5cGUgQ2FwdHVyZUhvb2tzLFxuICB0eXBlIENhcHR1cmVQb2xpY3ksXG4gIGNhcHR1cmUsXG59IGZyb20gJy4uL2NhcHR1cmUvZW52ZWxvcGUuanMnO1xuaW1wb3J0IHsgdHlwZSBPdmVyZmxvd1BvbGljeSwgdHlwZSBSaW5nQ291bnRlcnMsIEJvdW5kZWRSaW5nIH0gZnJvbSAnLi9yaW5nLmpzJztcblxuLyoqIFJGQy0wMDEgwqc1IGRlZmF1bHQgcXVldWUgYm91bmQuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9NQVhfUVVFVUUgPSAxMF8wMDA7XG5cbi8qKiBPbmUgb2JzZXJ2ZXIgZXZlbnQgdG8gbWVyZ2Ug4oCUIHtAbGluayBjYXB0dXJlfSdzIHJlcXVlc3QgbWludXMgYHNlcWAuICovXG5leHBvcnQgaW50ZXJmYWNlIEVucXVldWVJbnB1dCB7XG4gIHJlYWRvbmx5IGNoYW5uZWw6IENhcHR1cmVDaGFubmVsO1xuICByZWFkb25seSBtZXRob2Q6IHN0cmluZztcbiAgcmVhZG9ubHkgcnVudGltZVN0YWdlSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcnVuSWQ6IHN0cmluZztcbiAgLyoqIExJVkUgcGF5bG9hZCDigJQgbWF0ZXJpYWxpemVkIHBlciBjYXB0dXJlIHBvbGljeSBhdCBlbnF1ZXVlIHRpbWUuICovXG4gIHJlYWRvbmx5IHBheWxvYWQ6IHVua25vd247XG59XG5cbi8qKiBGYXRlIG9mIG9uZSBlbnF1ZXVlZCBldmVudCDigJQgc2VlIHRoZSBtb2R1bGUgaGVhZGVyLiAqL1xuZXhwb3J0IHR5cGUgRW5xdWV1ZU91dGNvbWUgPSAncXVldWVkJyB8ICdkcm9wcGVkJyB8ICdpbmxpbmUnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVucXVldWVSZXN1bHQge1xuICAvKiogVGhlIGNhcHR1cmVkLCBzZXEtc3RhbXBlZCBlbnZlbG9wZSAoYnVpbHQgZXZlbiB3aGVuIG5vdCBxdWV1ZWQpLiAqL1xuICByZWFkb25seSBlbnZlbG9wZTogQ2FwdHVyZUVudmVsb3BlO1xuICByZWFkb25seSBvdXRjb21lOiBFbnF1ZXVlT3V0Y29tZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNZXJnZWRRdWV1ZU9wdGlvbnMge1xuICAvKiogUmluZyBjYXBhY2l0eS4gRGVmYXVsdCB7QGxpbmsgREVGQVVMVF9NQVhfUVVFVUV9ICgxMCAwMDApLiAqL1xuICByZWFkb25seSBtYXhRdWV1ZT86IG51bWJlcjtcbiAgLyoqIE92ZXJmbG93IHBvbGljeSBhdCBjYXBhY2l0eS4gRGVmYXVsdCBgJ2Ryb3Atb2xkZXN0J2AuICovXG4gIHJlYWRvbmx5IG92ZXJmbG93PzogT3ZlcmZsb3dQb2xpY3k7XG4gIC8qKiBgJ3NhbXBsZSdgIG9ubHkg4oCUIGFkbWl0IDEgaW4gdGhpcyBtYW55IHNhdHVyYXRlZCBhcnJpdmFscy4gKi9cbiAgcmVhZG9ubHkgc2FtcGxlRXZlcnk/OiBudW1iZXI7XG4gIC8qKiBEZWZhdWx0IGNhcHR1cmUgcG9saWN5IHdoZW4gYGVucXVldWVgIGdldHMgbm9uZS4gRGVmYXVsdCBgJ3N1bW1hcnknYC4gKi9cbiAgcmVhZG9ubHkgY2FwdHVyZVBvbGljeT86IENhcHR1cmVQb2xpY3k7XG4gIC8qKiBFbmdpbmUtZnJlZSBzZWFtcyAoZGV2LXdhcm4sIGNsb2NrKSBwYXNzZWQgdGhyb3VnaCB0byB7QGxpbmsgY2FwdHVyZX0uICovXG4gIHJlYWRvbmx5IGhvb2tzPzogQ2FwdHVyZUhvb2tzO1xufVxuXG5leHBvcnQgY2xhc3MgTWVyZ2VkUXVldWUge1xuICBwcml2YXRlIHJlYWRvbmx5IHJpbmc6IEJvdW5kZWRSaW5nPENhcHR1cmVFbnZlbG9wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgb3ZlcmZsb3c6IE92ZXJmbG93UG9saWN5O1xuICBwcml2YXRlIHJlYWRvbmx5IGRlZmF1bHRQb2xpY3k6IENhcHR1cmVQb2xpY3k7XG4gIHByaXZhdGUgcmVhZG9ubHkgaG9va3M/OiBDYXB0dXJlSG9va3M7XG4gIC8qKiBBcnJpdmFsIHN0YW1wIOKAlCBtb25vdG9uaWMgYWNyb3NzIEFMTCBjaGFubmVscyAoc2VlIG1vZHVsZSBoZWFkZXIpLiAqL1xuICBwcml2YXRlIHNlcSA9IDA7XG5cbiAgY29uc3RydWN0b3Iob3B0cz86IE1lcmdlZFF1ZXVlT3B0aW9ucykge1xuICAgIHRoaXMub3ZlcmZsb3cgPSBvcHRzPy5vdmVyZmxvdyA/PyAnZHJvcC1vbGRlc3QnO1xuICAgIHRoaXMucmluZyA9IG5ldyBCb3VuZGVkUmluZzxDYXB0dXJlRW52ZWxvcGU+KHtcbiAgICAgIGNhcGFjaXR5OiBvcHRzPy5tYXhRdWV1ZSA/PyBERUZBVUxUX01BWF9RVUVVRSxcbiAgICAgIHBvbGljeTogdGhpcy5vdmVyZmxvdyxcbiAgICAgIHNhbXBsZUV2ZXJ5OiBvcHRzPy5zYW1wbGVFdmVyeSxcbiAgICB9KTtcbiAgICB0aGlzLmRlZmF1bHRQb2xpY3kgPSBvcHRzPy5jYXB0dXJlUG9saWN5ID8/ICdzdW1tYXJ5JztcbiAgICB0aGlzLmhvb2tzID0gb3B0cz8uaG9va3M7XG4gIH1cblxuICAvKipcbiAgICogQ2FwdHVyZSBvbmUgZXZlbnQgKHNlcS1zdGFtcGVkIGF0IGFycml2YWwpIGFuZCBzdGFnZSBpdCBmb3IgZGVmZXJyZWRcbiAgICogZGVsaXZlcnkuIGBwb2xpY3lgIG92ZXJyaWRlcyB0aGUgcXVldWUgZGVmYXVsdCBwZXIgY2FsbCDigJQgZS5nLiBgJ3JlZidgXG4gICAqIGZvciBwYXlsb2FkcyB0aGUgY2FsbGVyIHByb3ZlZCBpbW11dGFibGUuIE5ldmVyIHRocm93cy5cbiAgICovXG4gIGVucXVldWUoaW5wdXQ6IEVucXVldWVJbnB1dCwgcG9saWN5PzogQ2FwdHVyZVBvbGljeSk6IEVucXVldWVSZXN1bHQge1xuICAgIGNvbnN0IGVudmVsb3BlID0gY2FwdHVyZShcbiAgICAgIHtcbiAgICAgICAgc2VxOiB0aGlzLnNlcSxcbiAgICAgICAgY2hhbm5lbDogaW5wdXQuY2hhbm5lbCxcbiAgICAgICAgbWV0aG9kOiBpbnB1dC5tZXRob2QsXG4gICAgICAgIHJ1bnRpbWVTdGFnZUlkOiBpbnB1dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgICAgcnVuSWQ6IGlucHV0LnJ1bklkLFxuICAgICAgICBwYXlsb2FkOiBpbnB1dC5wYXlsb2FkLFxuICAgICAgfSxcbiAgICAgIHBvbGljeSA/PyB0aGlzLmRlZmF1bHRQb2xpY3ksXG4gICAgICB0aGlzLmhvb2tzLFxuICAgICk7XG4gICAgdGhpcy5zZXEgKz0gMTtcblxuICAgIGNvbnN0IHB1c2hlZCA9IHRoaXMucmluZy5wdXNoKGVudmVsb3BlKTtcbiAgICBpZiAocHVzaGVkLmFjY2VwdGVkKSByZXR1cm4geyBlbnZlbG9wZSwgb3V0Y29tZTogJ3F1ZXVlZCcgfTtcbiAgICByZXR1cm4geyBlbnZlbG9wZSwgb3V0Y29tZTogdGhpcy5vdmVyZmxvdyA9PT0gJ2Jsb2NrJyA/ICdpbmxpbmUnIDogJ2Ryb3BwZWQnIH07XG4gIH1cblxuICAvKiogUG9wIHRoZSBvbGRlc3Qgc3RhZ2VkIGVudmVsb3BlICh0b3RhbCBhcnJpdmFsIG9yZGVyIGFjcm9zcyBjaGFubmVscykuICovXG4gIHNoaWZ0KCk6IENhcHR1cmVFbnZlbG9wZSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMucmluZy5zaGlmdCgpO1xuICB9XG5cbiAgLyoqIEN1cnJlbnQgYmFja2xvZy4gKi9cbiAgZ2V0IGRlcHRoKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMucmluZy5zaXplO1xuICB9XG5cbiAgLyoqIFJpbmcgY2FwYWNpdHkgKHRoZSBgbWF4UXVldWVgIGJvdW5kKS4gKi9cbiAgZ2V0IGNhcGFjaXR5KCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMucmluZy5jYXBhY2l0eTtcbiAgfVxuXG4gIC8qKiBUaGUgbmV4dCBzZXEgdG8gYmUgYXNzaWduZWQgPT0gdG90YWwgZXZlbnRzIGNhcHR1cmVkIHNvIGZhci4gKi9cbiAgZ2V0IG5leHRTZXEoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5zZXE7XG4gIH1cblxuICAvKiogTGlmZXRpbWUgbG9zcy9kZWxpdmVyeSBhY2NvdW50aW5nIOKAlCBkZWxlZ2F0ZWQgdG8gdGhlIHJpbmcuICovXG4gIGdldENvdW50ZXJzKCk6IFJpbmdDb3VudGVycyB7XG4gICAgcmV0dXJuIHRoaXMucmluZy5nZXRDb3VudGVycygpO1xuICB9XG59XG4iXX0=