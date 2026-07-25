/**
 * observer-queue/ring.ts — RFC-001 Block 2: bounded ring with overflow policies.
 *
 * Pattern:  Fixed-capacity circular buffer with explicit, COUNTED overflow
 *           behavior. The deferred-observer queue must never grow without
 *           bound (a slow consumer cannot OOM the producer), and must never
 *           lose an event silently (every loss increments `drops`).
 * Role:     Storage primitive under the merged queue (Block 3). Pure data
 *           structure — zero imports, zero engine knowledge, generic over T.
 *
 * Overflow policies (RFC-001 §5, with the accepted 'block' resolution):
 *   - `'drop-oldest'` — evict the oldest queued item to admit the new one.
 *     The evicted item is LOST (`drops`++) and returned on the push result
 *     so the caller can account for it. Sequence stamps on surviving items
 *     keep loss visible as seq gaps (honest loss accounting). DEFAULT
 *     posture for telemetry-grade delivery.
 *   - `'sample'` — while saturated, admit 1 in `sampleEvery` arrivals
 *     (evicting the oldest to make room — that eviction is also a counted
 *     loss); refuse the rest (each a counted loss). Keeps a thinned,
 *     still-fresh stream under sustained overload. The saturation counter
 *     is episode-scoped: it resets whenever a push succeeds through the
 *     non-full path.
 *   - `'block'` — the ring REFUSES the new item (`accepted: false`,
 *     `rejections`++) and drops NOTHING. In a single-threaded runtime a
 *     queue cannot literally block its producer; the dispatcher (Block 5)
 *     interprets a refusal as "deliver this event synchronously inline" —
 *     re-introducing blocking delivery by the consumer's EXPLICIT choice.
 *     Rejections are NOT losses: the event is still delivered (inline), so
 *     `drops` stays untouched.
 *
 * Conservation invariant (property-tested):
 *   pushes === delivered + drops + rejections + size
 *
 * CURSOR-READY (amendment A2): v1 consumes destructively through ONE cursor
 * (`shift()` advances `head`). The designed v1.1 path keeps items in the
 * ring and gives each listener its own read cursor; `head` then advances to
 * `min(cursors)` (the reclaim watermark) instead of on read. The storage
 * layout (contiguous circular window, `head` + `count`) already supports
 * that — only the consumption surface changes. Documented, not implemented.
 */
const DEFAULT_SAMPLE_EVERY = 10;
export class BoundedRing {
    buffer;
    policy;
    sampleEvery;
    /** Index of the oldest queued item — the single v1 cursor (see header). */
    head = 0;
    count = 0;
    /** Arrivals seen while saturated in the current episode (`'sample'`). */
    saturatedArrivals = 0;
    pushes = 0;
    delivered = 0;
    drops = 0;
    rejections = 0;
    constructor(opts) {
        if (!Number.isInteger(opts.capacity) || opts.capacity <= 0) {
            throw new RangeError(`BoundedRing capacity must be a positive integer (got ${opts.capacity})`);
        }
        const sampleEvery = opts.sampleEvery ?? DEFAULT_SAMPLE_EVERY;
        if (!Number.isInteger(sampleEvery) || sampleEvery <= 0) {
            throw new RangeError(`BoundedRing sampleEvery must be a positive integer (got ${opts.sampleEvery})`);
        }
        this.buffer = new Array(opts.capacity);
        this.policy = opts.policy;
        this.sampleEvery = sampleEvery;
    }
    get size() {
        return this.count;
    }
    get capacity() {
        return this.buffer.length;
    }
    /** Lifetime counters — see {@link RingCounters}. */
    getCounters() {
        return { pushes: this.pushes, delivered: this.delivered, drops: this.drops, rejections: this.rejections };
    }
    /** Admit, evict-and-admit, refuse, or sample per policy — never throws. */
    push(item) {
        this.pushes += 1;
        if (this.count < this.buffer.length) {
            this.saturatedArrivals = 0; // new saturation episode starts fresh
            this.store(item);
            return { accepted: true };
        }
        if (this.policy === 'block') {
            this.rejections += 1;
            return { accepted: false };
        }
        if (this.policy === 'sample') {
            this.saturatedArrivals += 1;
            if (this.saturatedArrivals % this.sampleEvery !== 0) {
                this.drops += 1; // the incoming item is sampled out — lost
                return { accepted: false };
            }
            // The 1-in-N admission falls through to evict-and-store.
        }
        // 'drop-oldest' (and the 'sample' admission): evict the oldest — lost.
        const evicted = this.buffer[this.head];
        this.buffer[this.head] = undefined;
        this.head = (this.head + 1) % this.buffer.length;
        this.count -= 1;
        this.drops += 1;
        this.store(item);
        return { accepted: true, evicted };
    }
    /** Pop the oldest queued item (FIFO). `undefined` when empty. */
    shift() {
        if (this.count === 0)
            return undefined;
        const item = this.buffer[this.head];
        this.buffer[this.head] = undefined; // release the reference for GC
        this.head = (this.head + 1) % this.buffer.length;
        this.count -= 1;
        this.delivered += 1;
        return item;
    }
    store(item) {
        this.buffer[(this.head + this.count) % this.buffer.length] = item;
        this.count += 1;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmluZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvb2JzZXJ2ZXItcXVldWUvcmluZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBdUNHO0FBeUNILE1BQU0sb0JBQW9CLEdBQUcsRUFBRSxDQUFDO0FBRWhDLE1BQU0sT0FBTyxXQUFXO0lBQ0wsTUFBTSxDQUF1QjtJQUM3QixNQUFNLENBQWlCO0lBQ3ZCLFdBQVcsQ0FBUztJQUNyQywyRUFBMkU7SUFDbkUsSUFBSSxHQUFHLENBQUMsQ0FBQztJQUNULEtBQUssR0FBRyxDQUFDLENBQUM7SUFDbEIseUVBQXlFO0lBQ2pFLGlCQUFpQixHQUFHLENBQUMsQ0FBQztJQUV0QixNQUFNLEdBQUcsQ0FBQyxDQUFDO0lBQ1gsU0FBUyxHQUFHLENBQUMsQ0FBQztJQUNkLEtBQUssR0FBRyxDQUFDLENBQUM7SUFDVixVQUFVLEdBQUcsQ0FBQyxDQUFDO0lBRXZCLFlBQVksSUFBaUI7UUFDM0IsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDM0QsTUFBTSxJQUFJLFVBQVUsQ0FBQyx3REFBd0QsSUFBSSxDQUFDLFFBQVEsR0FBRyxDQUFDLENBQUM7UUFDakcsQ0FBQztRQUNELE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxXQUFXLElBQUksb0JBQW9CLENBQUM7UUFDN0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsV0FBVyxDQUFDLElBQUksV0FBVyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ3ZELE1BQU0sSUFBSSxVQUFVLENBQUMsMkRBQTJELElBQUksQ0FBQyxXQUFXLEdBQUcsQ0FBQyxDQUFDO1FBQ3ZHLENBQUM7UUFDRCxJQUFJLENBQUMsTUFBTSxHQUFHLElB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QyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDO1FBQ2pELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDO1FBQ2hCLElBQUksQ0FBQyxTQUFTLElBQUksQ0FBQyxDQUFDO1FBQ3BCLE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVPLEtBQUssQ0FBQyxJQUFPO1FBQ25CLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQztRQUNsRSxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsQ0FBQztJQUNsQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIG9ic2VydmVyLXF1ZXVlL3JpbmcudHMg4oCUIFJGQy0wMDEgQmxvY2sgMjogYm91bmRlZCByaW5nIHdpdGggb3ZlcmZsb3cgcG9saWNpZXMuXG4gKlxuICogUGF0dGVybjogIEZpeGVkLWNhcGFjaXR5IGNpcmN1bGFyIGJ1ZmZlciB3aXRoIGV4cGxpY2l0LCBDT1VOVEVEIG92ZXJmbG93XG4gKiAgICAgICAgICAgYmVoYXZpb3IuIFRoZSBkZWZlcnJlZC1vYnNlcnZlciBxdWV1ZSBtdXN0IG5ldmVyIGdyb3cgd2l0aG91dFxuICogICAgICAgICAgIGJvdW5kIChhIHNsb3cgY29uc3VtZXIgY2Fubm90IE9PTSB0aGUgcHJvZHVjZXIpLCBhbmQgbXVzdCBuZXZlclxuICogICAgICAgICAgIGxvc2UgYW4gZXZlbnQgc2lsZW50bHkgKGV2ZXJ5IGxvc3MgaW5jcmVtZW50cyBgZHJvcHNgKS5cbiAqIFJvbGU6ICAgICBTdG9yYWdlIHByaW1pdGl2ZSB1bmRlciB0aGUgbWVyZ2VkIHF1ZXVlIChCbG9jayAzKS4gUHVyZSBkYXRhXG4gKiAgICAgICAgICAgc3RydWN0dXJlIOKAlCB6ZXJvIGltcG9ydHMsIHplcm8gZW5naW5lIGtub3dsZWRnZSwgZ2VuZXJpYyBvdmVyIFQuXG4gKlxuICogT3ZlcmZsb3cgcG9saWNpZXMgKFJGQy0wMDEgwqc1LCB3aXRoIHRoZSBhY2NlcHRlZCAnYmxvY2snIHJlc29sdXRpb24pOlxuICogICAtIGAnZHJvcC1vbGRlc3QnYCDigJQgZXZpY3QgdGhlIG9sZGVzdCBxdWV1ZWQgaXRlbSB0byBhZG1pdCB0aGUgbmV3IG9uZS5cbiAqICAgICBUaGUgZXZpY3RlZCBpdGVtIGlzIExPU1QgKGBkcm9wc2ArKykgYW5kIHJldHVybmVkIG9uIHRoZSBwdXNoIHJlc3VsdFxuICogICAgIHNvIHRoZSBjYWxsZXIgY2FuIGFjY291bnQgZm9yIGl0LiBTZXF1ZW5jZSBzdGFtcHMgb24gc3Vydml2aW5nIGl0ZW1zXG4gKiAgICAga2VlcCBsb3NzIHZpc2libGUgYXMgc2VxIGdhcHMgKGhvbmVzdCBsb3NzIGFjY291bnRpbmcpLiBERUZBVUxUXG4gKiAgICAgcG9zdHVyZSBmb3IgdGVsZW1ldHJ5LWdyYWRlIGRlbGl2ZXJ5LlxuICogICAtIGAnc2FtcGxlJ2Ag4oCUIHdoaWxlIHNhdHVyYXRlZCwgYWRtaXQgMSBpbiBgc2FtcGxlRXZlcnlgIGFycml2YWxzXG4gKiAgICAgKGV2aWN0aW5nIHRoZSBvbGRlc3QgdG8gbWFrZSByb29tIOKAlCB0aGF0IGV2aWN0aW9uIGlzIGFsc28gYSBjb3VudGVkXG4gKiAgICAgbG9zcyk7IHJlZnVzZSB0aGUgcmVzdCAoZWFjaCBhIGNvdW50ZWQgbG9zcykuIEtlZXBzIGEgdGhpbm5lZCxcbiAqICAgICBzdGlsbC1mcmVzaCBzdHJlYW0gdW5kZXIgc3VzdGFpbmVkIG92ZXJsb2FkLiBUaGUgc2F0dXJhdGlvbiBjb3VudGVyXG4gKiAgICAgaXMgZXBpc29kZS1zY29wZWQ6IGl0IHJlc2V0cyB3aGVuZXZlciBhIHB1c2ggc3VjY2VlZHMgdGhyb3VnaCB0aGVcbiAqICAgICBub24tZnVsbCBwYXRoLlxuICogICAtIGAnYmxvY2snYCDigJQgdGhlIHJpbmcgUkVGVVNFUyB0aGUgbmV3IGl0ZW0gKGBhY2NlcHRlZDogZmFsc2VgLFxuICogICAgIGByZWplY3Rpb25zYCsrKSBhbmQgZHJvcHMgTk9USElORy4gSW4gYSBzaW5nbGUtdGhyZWFkZWQgcnVudGltZSBhXG4gKiAgICAgcXVldWUgY2Fubm90IGxpdGVyYWxseSBibG9jayBpdHMgcHJvZHVjZXI7IHRoZSBkaXNwYXRjaGVyIChCbG9jayA1KVxuICogICAgIGludGVycHJldHMgYSByZWZ1c2FsIGFzIFwiZGVsaXZlciB0aGlzIGV2ZW50IHN5bmNocm9ub3VzbHkgaW5saW5lXCIg4oCUXG4gKiAgICAgcmUtaW50cm9kdWNpbmcgYmxvY2tpbmcgZGVsaXZlcnkgYnkgdGhlIGNvbnN1bWVyJ3MgRVhQTElDSVQgY2hvaWNlLlxuICogICAgIFJlamVjdGlvbnMgYXJlIE5PVCBsb3NzZXM6IHRoZSBldmVudCBpcyBzdGlsbCBkZWxpdmVyZWQgKGlubGluZSksIHNvXG4gKiAgICAgYGRyb3BzYCBzdGF5cyB1bnRvdWNoZWQuXG4gKlxuICogQ29uc2VydmF0aW9uIGludmFyaWFudCAocHJvcGVydHktdGVzdGVkKTpcbiAqICAgcHVzaGVzID09PSBkZWxpdmVyZWQgKyBkcm9wcyArIHJlamVjdGlvbnMgKyBzaXplXG4gKlxuICogQ1VSU09SLVJFQURZIChhbWVuZG1lbnQgQTIpOiB2MSBjb25zdW1lcyBkZXN0cnVjdGl2ZWx5IHRocm91Z2ggT05FIGN1cnNvclxuICogKGBzaGlmdCgpYCBhZHZhbmNlcyBgaGVhZGApLiBUaGUgZGVzaWduZWQgdjEuMSBwYXRoIGtlZXBzIGl0ZW1zIGluIHRoZVxuICogcmluZyBhbmQgZ2l2ZXMgZWFjaCBsaXN0ZW5lciBpdHMgb3duIHJlYWQgY3Vyc29yOyBgaGVhZGAgdGhlbiBhZHZhbmNlcyB0b1xuICogYG1pbihjdXJzb3JzKWAgKHRoZSByZWNsYWltIHdhdGVybWFyaykgaW5zdGVhZCBvZiBvbiByZWFkLiBUaGUgc3RvcmFnZVxuICogbGF5b3V0IChjb250aWd1b3VzIGNpcmN1bGFyIHdpbmRvdywgYGhlYWRgICsgYGNvdW50YCkgYWxyZWFkeSBzdXBwb3J0c1xuICogdGhhdCDigJQgb25seSB0aGUgY29uc3VtcHRpb24gc3VyZmFjZSBjaGFuZ2VzLiBEb2N1bWVudGVkLCBub3QgaW1wbGVtZW50ZWQuXG4gKi9cblxuLyoqIEhvdyB0aGUgcmluZyB0cmVhdHMgYSBwdXNoIHdoZW4gaXQgaXMgYXQgY2FwYWNpdHkgKFJGQy0wMDEgwqc1KS4gKi9cbmV4cG9ydCB0eXBlIE92ZXJmbG93UG9saWN5ID0gJ2Jsb2NrJyB8ICdkcm9wLW9sZGVzdCcgfCAnc2FtcGxlJztcblxuZXhwb3J0IGludGVyZmFjZSBSaW5nT3B0aW9ucyB7XG4gIC8qKiBNYXggcXVldWVkIGl0ZW1zLiBQb3NpdGl2ZSBpbnRlZ2VyLiAqL1xuICByZWFkb25seSBjYXBhY2l0eTogbnVtYmVyO1xuICAvKiogT3ZlcmZsb3cgYmVoYXZpb3IgYXQgY2FwYWNpdHkg4oCUIHNlZSB0aGUgbW9kdWxlIGhlYWRlci4gKi9cbiAgcmVhZG9ubHkgcG9saWN5OiBPdmVyZmxvd1BvbGljeTtcbiAgLyoqXG4gICAqIGAnc2FtcGxlJ2Agb25seTogYWRtaXQgMSBpbiB0aGlzIG1hbnkgYXJyaXZhbHMgd2hpbGUgc2F0dXJhdGVkLlxuICAgKiBQb3NpdGl2ZSBpbnRlZ2VyOyBkZWZhdWx0IDEwLlxuICAgKi9cbiAgcmVhZG9ubHkgc2FtcGxlRXZlcnk/OiBudW1iZXI7XG59XG5cbi8qKiBPdXRjb21lIG9mIG9uZSB7QGxpbmsgQm91bmRlZFJpbmcucHVzaH0uICovXG5leHBvcnQgaW50ZXJmYWNlIFJpbmdQdXNoUmVzdWx0PFQ+IHtcbiAgLyoqIFRydWUgd2hlbiB0aGUgcHVzaGVkIGl0ZW0gaXMgbm93IHF1ZXVlZC4gKi9cbiAgcmVhZG9ubHkgYWNjZXB0ZWQ6IGJvb2xlYW47XG4gIC8qKlxuICAgKiBUaGUgb2xkZXN0IGl0ZW0sIHdoZW4gYWRtaXR0aW5nIHRoZSBuZXcgb25lIGV2aWN0ZWQgaXRcbiAgICogKGAnZHJvcC1vbGRlc3QnYCwgb3IgYSBgJ3NhbXBsZSdgIGFkbWlzc2lvbikuIEFscmVhZHkgY291bnRlZCBpblxuICAgKiBgZHJvcHNgIOKAlCBzdXJmYWNlZCBzbyBjYWxsZXJzIGNhbiBkbyB0aGVpciBvd24gbG9zcyBhY2NvdW50aW5nLlxuICAgKi9cbiAgcmVhZG9ubHkgZXZpY3RlZD86IFQ7XG59XG5cbi8qKiBNb25vdG9uaWMgY291bnRlcnMg4oCUIG5ldmVyIHJlc2V0IGZvciB0aGUgbGlmZXRpbWUgb2YgdGhlIHJpbmcuICovXG5leHBvcnQgaW50ZXJmYWNlIFJpbmdDb3VudGVycyB7XG4gIC8qKiBUb3RhbCBgcHVzaCgpYCBjYWxscy4gKi9cbiAgcmVhZG9ubHkgcHVzaGVzOiBudW1iZXI7XG4gIC8qKiBgc2hpZnQoKWAgY2FsbHMgdGhhdCByZXR1cm5lZCBhbiBpdGVtLiAqL1xuICByZWFkb25seSBkZWxpdmVyZWQ6IG51bWJlcjtcbiAgLyoqIEl0ZW1zIExPU1Qg4oCUIGV2aWN0aW9ucyBwbHVzIHNhbXBsZWQtb3V0IHJlZnVzYWxzLiBOZXZlciBzaWxlbnQuICovXG4gIHJlYWRvbmx5IGRyb3BzOiBudW1iZXI7XG4gIC8qKiBgJ2Jsb2NrJ2AgcmVmdXNhbHMg4oCUIE5PVCBsb3NzZXM7IHRoZSBjYWxsZXIgZGVsaXZlcnMgdGhlc2UgaW5saW5lLiAqL1xuICByZWFkb25seSByZWplY3Rpb25zOiBudW1iZXI7XG59XG5cbmNvbnN0IERFRkFVTFRfU0FNUExFX0VWRVJZID0gMTA7XG5cbmV4cG9ydCBjbGFzcyBCb3VuZGVkUmluZzxUPiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnVmZmVyOiBBcnJheTxUIHwgdW5kZWZpbmVkPjtcbiAgcHJpdmF0ZSByZWFkb25seSBwb2xpY3k6IE92ZXJmbG93UG9saWN5O1xuICBwcml2YXRlIHJlYWRvbmx5IHNhbXBsZUV2ZXJ5OiBudW1iZXI7XG4gIC8qKiBJbmRleCBvZiB0aGUgb2xkZXN0IHF1ZXVlZCBpdGVtIOKAlCB0aGUgc2luZ2xlIHYxIGN1cnNvciAoc2VlIGhlYWRlcikuICovXG4gIHByaXZhdGUgaGVhZCA9IDA7XG4gIHByaXZhdGUgY291bnQgPSAwO1xuICAvKiogQXJyaXZhbHMgc2VlbiB3aGlsZSBzYXR1cmF0ZWQgaW4gdGhlIGN1cnJlbnQgZXBpc29kZSAoYCdzYW1wbGUnYCkuICovXG4gIHByaXZhdGUgc2F0dXJhdGVkQXJyaXZhbHMgPSAwO1xuXG4gIHByaXZhdGUgcHVzaGVzID0gMDtcbiAgcHJpdmF0ZSBkZWxpdmVyZWQgPSAwO1xuICBwcml2YXRlIGRyb3BzID0gMDtcbiAgcHJpdmF0ZSByZWplY3Rpb25zID0gMDtcblxuICBjb25zdHJ1Y3RvcihvcHRzOiBSaW5nT3B0aW9ucykge1xuICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihvcHRzLmNhcGFjaXR5KSB8fCBvcHRzLmNhcGFjaXR5IDw9IDApIHtcbiAgICAgIHRocm93IG5ldyBSYW5nZUVycm9yKGBCb3VuZGVkUmluZyBjYXBhY2l0eSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlciAoZ290ICR7b3B0cy5jYXBhY2l0eX0pYCk7XG4gICAgfVxuICAgIGNvbnN0IHNhbXBsZUV2ZXJ5ID0gb3B0cy5zYW1wbGVFdmVyeSA/PyBERUZBVUxUX1NBTVBMRV9FVkVSWTtcbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIoc2FtcGxlRXZlcnkpIHx8IHNhbXBsZUV2ZXJ5IDw9IDApIHtcbiAgICAgIHRocm93IG5ldyBSYW5nZUVycm9yKGBCb3VuZGVkUmluZyBzYW1wbGVFdmVyeSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlciAoZ290ICR7b3B0cy5zYW1wbGVFdmVyeX0pYCk7XG4gICAgfVxuICAgIHRoaXMuYnVmZmVyID0gbmV3IEFycmF5PFQgfCB1bmRlZmluZWQ+KG9wdHMuY2FwYWNpdHkpO1xuICAgIHRoaXMucG9saWN5ID0gb3B0cy5wb2xpY3k7XG4gICAgdGhpcy5zYW1wbGVFdmVyeSA9IHNhbXBsZUV2ZXJ5O1xuICB9XG5cbiAgZ2V0IHNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5jb3VudDtcbiAgfVxuXG4gIGdldCBjYXBhY2l0eSgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmJ1ZmZlci5sZW5ndGg7XG4gIH1cblxuICAvKiogTGlmZXRpbWUgY291bnRlcnMg4oCUIHNlZSB7QGxpbmsgUmluZ0NvdW50ZXJzfS4gKi9cbiAgZ2V0Q291bnRlcnMoKTogUmluZ0NvdW50ZXJzIHtcbiAgICByZXR1cm4geyBwdXNoZXM6IHRoaXMucHVzaGVzLCBkZWxpdmVyZWQ6IHRoaXMuZGVsaXZlcmVkLCBkcm9wczogdGhpcy5kcm9wcywgcmVqZWN0aW9uczogdGhpcy5yZWplY3Rpb25zIH07XG4gIH1cblxuICAvKiogQWRtaXQsIGV2aWN0LWFuZC1hZG1pdCwgcmVmdXNlLCBvciBzYW1wbGUgcGVyIHBvbGljeSDigJQgbmV2ZXIgdGhyb3dzLiAqL1xuICBwdXNoKGl0ZW06IFQpOiBSaW5nUHVzaFJlc3VsdDxUPiB7XG4gICAgdGhpcy5wdXNoZXMgKz0gMTtcblxuICAgIGlmICh0aGlzLmNvdW50IDwgdGhpcy5idWZmZXIubGVuZ3RoKSB7XG4gICAgICB0aGlzLnNhdHVyYXRlZEFycml2YWxzID0gMDsgLy8gbmV3IHNhdHVyYXRpb24gZXBpc29kZSBzdGFydHMgZnJlc2hcbiAgICAgIHRoaXMuc3RvcmUoaXRlbSk7XG4gICAgICByZXR1cm4geyBhY2NlcHRlZDogdHJ1ZSB9O1xuICAgIH1cblxuICAgIGlmICh0aGlzLnBvbGljeSA9PT0gJ2Jsb2NrJykge1xuICAgICAgdGhpcy5yZWplY3Rpb25zICs9IDE7XG4gICAgICByZXR1cm4geyBhY2NlcHRlZDogZmFsc2UgfTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5wb2xpY3kgPT09ICdzYW1wbGUnKSB7XG4gICAgICB0aGlzLnNhdHVyYXRlZEFycml2YWxzICs9IDE7XG4gICAgICBpZiAodGhpcy5zYXR1cmF0ZWRBcnJpdmFscyAlIHRoaXMuc2FtcGxlRXZlcnkgIT09IDApIHtcbiAgICAgICAgdGhpcy5kcm9wcyArPSAxOyAvLyB0aGUgaW5jb21pbmcgaXRlbSBpcyBzYW1wbGVkIG91dCDigJQgbG9zdFxuICAgICAgICByZXR1cm4geyBhY2NlcHRlZDogZmFsc2UgfTtcbiAgICAgIH1cbiAgICAgIC8vIFRoZSAxLWluLU4gYWRtaXNzaW9uIGZhbGxzIHRocm91Z2ggdG8gZXZpY3QtYW5kLXN0b3JlLlxuICAgIH1cblxuICAgIC8vICdkcm9wLW9sZGVzdCcgKGFuZCB0aGUgJ3NhbXBsZScgYWRtaXNzaW9uKTogZXZpY3QgdGhlIG9sZGVzdCDigJQgbG9zdC5cbiAgICBjb25zdCBldmljdGVkID0gdGhpcy5idWZmZXJbdGhpcy5oZWFkXSBhcyBUO1xuICAgIHRoaXMuYnVmZmVyW3RoaXMuaGVhZF0gPSB1bmRlZmluZWQ7XG4gICAgdGhpcy5oZWFkID0gKHRoaXMuaGVhZCArIDEpICUgdGhpcy5idWZmZXIubGVuZ3RoO1xuICAgIHRoaXMuY291bnQgLT0gMTtcbiAgICB0aGlzLmRyb3BzICs9IDE7XG4gICAgdGhpcy5zdG9yZShpdGVtKTtcbiAgICByZXR1cm4geyBhY2NlcHRlZDogdHJ1ZSwgZXZpY3RlZCB9O1xuICB9XG5cbiAgLyoqIFBvcCB0aGUgb2xkZXN0IHF1ZXVlZCBpdGVtIChGSUZPKS4gYHVuZGVmaW5lZGAgd2hlbiBlbXB0eS4gKi9cbiAgc2hpZnQoKTogVCB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKHRoaXMuY291bnQgPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuYnVmZmVyW3RoaXMuaGVhZF0gYXMgVDtcbiAgICB0aGlzLmJ1ZmZlclt0aGlzLmhlYWRdID0gdW5kZWZpbmVkOyAvLyByZWxlYXNlIHRoZSByZWZlcmVuY2UgZm9yIEdDXG4gICAgdGhpcy5oZWFkID0gKHRoaXMuaGVhZCArIDEpICUgdGhpcy5idWZmZXIubGVuZ3RoO1xuICAgIHRoaXMuY291bnQgLT0gMTtcbiAgICB0aGlzLmRlbGl2ZXJlZCArPSAxO1xuICAgIHJldHVybiBpdGVtO1xuICB9XG5cbiAgcHJpdmF0ZSBzdG9yZShpdGVtOiBUKTogdm9pZCB7XG4gICAgdGhpcy5idWZmZXJbKHRoaXMuaGVhZCArIHRoaXMuY291bnQpICUgdGhpcy5idWZmZXIubGVuZ3RoXSA9IGl0ZW07XG4gICAgdGhpcy5jb3VudCArPSAxO1xuICB9XG59XG4iXX0=