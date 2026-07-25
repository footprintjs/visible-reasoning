/**
 * observer-queue/flushDriver.ts — RFC-001 Block 4: armed-once microtask batcher.
 *
 * Pattern:  Kernel-style bottom-half. Producers only set a flag ("work
 *           pending") and return; the actual work runs at the next
 *           scheduling checkpoint (a microtask), drains under a time
 *           budget, and re-arms itself if backlog remains. Same shape as
 *           the detach module's `microtaskBatchDriver` — accumulate during
 *           the current sync slice, drain at the boundary.
 * Role:     The scheduler of the deferred-observer pipeline. Owns WHEN
 *           delivery happens; knows nothing about envelopes or listeners
 *           (the dispatcher, Block 5, injects `depth`/`processNext`).
 *           Pure module — zero imports, zero engine knowledge.
 *
 * Scheduling semantics (normative, RFC-001 §5 + amendment A1):
 *   - `arm()` is idempotent: at most ONE pending flush exists (armed flag).
 *     N captures between checkpoints ⇒ exactly 1 flush.
 *   - A flush drains a SNAPSHOT: at most `depth()`-at-flush-start items.
 *     Events enqueued BY listeners during the flush exceed the snapshot and
 *     land at the NEXT checkpoint — listener-driven cascades cannot starve
 *     the event loop.
 *   - `flushBudgetMs` (default 2; `Infinity` = full snapshot drain): the
 *     flush stops once the budget is exhausted, counts `budgetExhausted`,
 *     and re-arms. At least ONE item is processed per flush regardless of
 *     budget — guaranteed progress under any clock.
 *   - If backlog remains after the flush (budget cut OR listener enqueues),
 *     the driver re-arms for the next checkpoint.
 *
 * Why stage boundaries make this safe: the engine `await`s every stage, so
 * the microtask queue runs at EVERY stage boundary — flushes are at most
 * "one beat behind" the producing stage. See
 * `docs/guides/execution-model.md` ("Stage boundaries are scheduling
 * points") and the FAQ in `docs/design/rfc-001-deferred-observers.md`.
 *
 * Testability: `now` (clock) and `schedule` (checkpoint primitive) are
 * injectable — tests pump flushes deterministically with a fake clock and
 * a captured-callback scheduler; production uses `performance.now` and
 * `queueMicrotask`.
 */
/** Rolling sample window for the p95 flush-duration stat (A4). */
export const FLUSH_SAMPLE_WINDOW = 128;
/** Default cascade cap for {@link FlushDriver.flushSync}. */
const DEFAULT_MAX_SYNC_ROUNDS = 1_000;
const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export class FlushDriver {
    depth;
    processNext;
    flushBudgetMs;
    now;
    schedule;
    onFlushStart;
    onFlushEnd;
    armed = false;
    flushes = 0;
    budgetExhaustedCount = 0;
    lastFlushMs = 0;
    samples = [];
    sampleWriteIdx = 0;
    constructor(opts) {
        const budget = opts.flushBudgetMs ?? 2;
        if (Number.isNaN(budget) || budget <= 0) {
            throw new RangeError(`flushBudgetMs must be > 0 (got ${budget}); use Infinity for full drains`);
        }
        this.depth = opts.depth;
        this.processNext = opts.processNext;
        this.flushBudgetMs = budget;
        this.now = opts.now ?? defaultNow;
        this.schedule = opts.schedule ?? ((cb) => queueMicrotask(cb));
        this.onFlushStart = opts.onFlushStart;
        this.onFlushEnd = opts.onFlushEnd;
    }
    /**
     * Request a flush at the next checkpoint. Idempotent — while one flush
     * is pending, further arms are free no-ops (the armed-once invariant).
     */
    arm() {
        if (this.armed)
            return;
        this.armed = true;
        this.schedule(() => this.flush());
    }
    /**
     * Synchronous full drain — the terminal-flush primitive (end of run /
     * shutdown). Repeats snapshot rounds until the queue is empty so
     * listener-enqueued cascades drain too, capped at `maxRounds` so a
     * listener that enqueues forever cannot hang the process (`remaining`
     * reports what the cap left behind).
     */
    flushSync(opts) {
        const maxRounds = opts?.maxRounds ?? DEFAULT_MAX_SYNC_ROUNDS;
        if (this.depth() === 0)
            return { drained: 0, remaining: 0 };
        this.onFlushStart?.();
        const start = this.now();
        let drained = 0;
        for (let round = 0; round < maxRounds && this.depth() > 0; round++) {
            const snapshot = this.depth();
            for (let i = 0; i < snapshot && this.depth() > 0; i++) {
                this.processNext();
                drained += 1;
            }
        }
        this.recordFlush(this.now() - start, false);
        const remaining = this.depth();
        this.onFlushEnd?.({ processed: drained, budgetExhausted: false, rearmed: false });
        return { drained, remaining };
    }
    getStats() {
        return {
            flushes: this.flushes,
            budgetExhausted: this.budgetExhaustedCount,
            lastFlushMs: this.lastFlushMs,
            p95FlushMs: this.p95FlushMs(),
            armed: this.armed,
        };
    }
    /** The microtask body — see the module-header semantics. */
    flush() {
        this.armed = false;
        const snapshot = this.depth();
        if (snapshot === 0)
            return; // raced with flushSync — zero-work wakeup
        this.onFlushStart?.();
        const start = this.now();
        let processed = 0;
        let exhausted = false;
        while (processed < snapshot && this.depth() > 0) {
            // Budget check AFTER the first item — guaranteed progress per flush.
            if (processed > 0 && this.now() - start >= this.flushBudgetMs) {
                exhausted = true;
                break;
            }
            this.processNext();
            processed += 1;
        }
        this.recordFlush(this.now() - start, exhausted);
        // Backlog left (budget cut, or listeners enqueued past the snapshot):
        // hand it to the NEXT checkpoint — never starve, never spin.
        const rearmed = this.depth() > 0;
        if (rearmed)
            this.arm();
        this.onFlushEnd?.({ processed, budgetExhausted: exhausted, rearmed });
    }
    recordFlush(elapsedMs, exhausted) {
        this.flushes += 1;
        this.lastFlushMs = elapsedMs;
        if (exhausted)
            this.budgetExhaustedCount += 1;
        if (this.samples.length < FLUSH_SAMPLE_WINDOW)
            this.samples.push(elapsedMs);
        else {
            this.samples[this.sampleWriteIdx] = elapsedMs;
            this.sampleWriteIdx = (this.sampleWriteIdx + 1) % FLUSH_SAMPLE_WINDOW;
        }
    }
    p95FlushMs() {
        if (this.samples.length === 0)
            return 0;
        const sorted = [...this.samples].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmx1c2hEcml2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL29ic2VydmVyLXF1ZXVlL2ZsdXNoRHJpdmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXNDRztBQXFESCxrRUFBa0U7QUFDbEUsTUFBTSxDQUFDLE1BQU0sbUJBQW1CLEdBQUcsR0FBRyxDQUFDO0FBRXZDLDZEQUE2RDtBQUM3RCxNQUFNLHVCQUF1QixHQUFHLEtBQUssQ0FBQztBQUV0QyxNQUFNLFVBQVUsR0FBRyxHQUFXLEVBQUUsQ0FBQyxDQUFDLE9BQU8sV0FBVyxLQUFLLFdBQVcsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztBQUV2RyxNQUFNLE9BQU8sV0FBVztJQUNMLEtBQUssQ0FBZTtJQUNwQixXQUFXLENBQWE7SUFDeEIsYUFBYSxDQUFTO0lBQ3RCLEdBQUcsQ0FBZTtJQUNsQixRQUFRLENBQTJCO0lBQ25DLFlBQVksQ0FBYztJQUMxQixVQUFVLENBQW1DO0lBRXRELEtBQUssR0FBRyxLQUFLLENBQUM7SUFDZCxPQUFPLEdBQUcsQ0FBQyxDQUFDO0lBQ1osb0JBQW9CLEdBQUcsQ0FBQyxDQUFDO0lBQ3pCLFdBQVcsR0FBRyxDQUFDLENBQUM7SUFDUCxPQUFPLEdBQWEsRUFBRSxDQUFDO0lBQ2hDLGNBQWMsR0FBRyxDQUFDLENBQUM7SUFFM0IsWUFBWSxJQUF3QjtRQUNsQyxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsYUFBYSxJQUFJLENBQUMsQ0FBQztRQUN2QyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ3hDLE1BQU0sSUFBSSxVQUFVLENBQUMsa0NBQWtDLE1BQU0saUNBQWlDLENBQUMsQ0FBQztRQUNsRyxDQUFDO1FBQ0QsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDO1FBQ3hCLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQztRQUNwQyxJQUFJLENBQUMsYUFBYSxHQUFHLE1BQU0sQ0FBQztRQUM1QixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLElBQUksVUFBVSxDQUFDO1FBQ2xDLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVEsSUFBSSxDQUFDLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxjQUFjLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUM5RCxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUM7UUFDdEMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDO0lBQ3BDLENBQUM7SUFFRDs7O09BR0c7SUFDSCxHQUFHO1FBQ0QsSUFBSSxJQUFJLENBQUMsS0FBSztZQUFFLE9BQU87UUFDdkIsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUM7UUFDbEIsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUNwQyxDQUFDO0lBRUQ7Ozs7OztPQU1HO0lBQ0gsU0FBUyxDQUFDLElBQTZCO1FBQ3JDLE1BQU0sU0FBUyxHQUFHLElBQUksRUFBRSxTQUFTLElBQUksdUJBQXVCLENBQUM7UUFDN0QsSUFBSSxJQUFJLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQztZQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsQ0FBQyxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQztRQUU1RCxJQUFJLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FBQztRQUN0QixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDekIsSUFBSSxPQUFPLEdBQUcsQ0FBQyxDQUFDO1FBQ2hCLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxTQUFTLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO1lBQ25FLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUM5QixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsUUFBUSxJQUFJLElBQUksQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztnQkFDdEQsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUNuQixPQUFPLElBQUksQ0FBQyxDQUFDO1lBQ2YsQ0FBQztRQUNILENBQUM7UUFDRCxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDNUMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQy9CLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQyxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsZUFBZSxFQUFFLEtBQUssRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztRQUNsRixPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxDQUFDO0lBQ2hDLENBQUM7SUFFRCxRQUFRO1FBQ04sT0FBTztZQUNMLE9BQU8sRUFBRSxJQUFJLENBQUMsT0FBTztZQUNyQixlQUFlLEVBQUUsSUFBSSxDQUFDLG9CQUFvQjtZQUMxQyxXQUFXLEVBQUUsSUFBSSxDQUFDLFdBQVc7WUFDN0IsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVLEVBQUU7WUFDN0IsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLO1NBQ2xCLENBQUM7SUFDSixDQUFDO0lBRUQsNERBQTREO0lBQ3BELEtBQUs7UUFDWCxJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztRQUNuQixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDOUIsSUFBSSxRQUFRLEtBQUssQ0FBQztZQUFFLE9BQU8sQ0FBQywwQ0FBMEM7UUFFdEUsSUFBSSxDQUFDLFlBQVksRUFBRSxFQUFFLENBQUM7UUFDdEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ3pCLElBQUksU0FBUyxHQUFHLENBQUMsQ0FBQztRQUNsQixJQUFJLFNBQVMsR0FBRyxLQUFLLENBQUM7UUFDdEIsT0FBTyxTQUFTLEdBQUcsUUFBUSxJQUFJLElBQUksQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUNoRCxxRUFBcUU7WUFDckUsSUFBSSxTQUFTLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxLQUFLLElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO2dCQUM5RCxTQUFTLEdBQUcsSUFBSSxDQUFDO2dCQUNqQixNQUFNO1lBQ1IsQ0FBQztZQUNELElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNuQixTQUFTLElBQUksQ0FBQyxDQUFDO1FBQ2pCLENBQUM7UUFDRCxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxLQUFLLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFFaEQsc0VBQXNFO1FBQ3RFLDZEQUE2RDtRQUM3RCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ2pDLElBQUksT0FBTztZQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUN4QixJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsRUFBRSxTQUFTLEVBQUUsZUFBZSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO0lBQ3hFLENBQUM7SUFFTyxXQUFXLENBQUMsU0FBaUIsRUFBRSxTQUFrQjtRQUN2RCxJQUFJLENBQUMsT0FBTyxJQUFJLENBQUMsQ0FBQztRQUNsQixJQUFJLENBQUMsV0FBVyxHQUFHLFNBQVMsQ0FBQztRQUM3QixJQUFJLFNBQVM7WUFBRSxJQUFJLENBQUMsb0JBQW9CLElBQUksQ0FBQyxDQUFDO1FBQzlDLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsbUJBQW1CO1lBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7YUFDdkUsQ0FBQztZQUNKLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLFNBQVMsQ0FBQztZQUM5QyxJQUFJLENBQUMsY0FBYyxHQUFHLENBQUMsSUFBSSxDQUFDLGNBQWMsR0FBRyxDQUFDLENBQUMsR0FBRyxtQkFBbUIsQ0FBQztRQUN4RSxDQUFDO0lBQ0gsQ0FBQztJQUVPLFVBQVU7UUFDaEIsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQUUsT0FBTyxDQUFDLENBQUM7UUFDeEMsTUFBTSxNQUFNLEdBQUcsQ0FBQyxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDdkQsT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQy9FLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogb2JzZXJ2ZXItcXVldWUvZmx1c2hEcml2ZXIudHMg4oCUIFJGQy0wMDEgQmxvY2sgNDogYXJtZWQtb25jZSBtaWNyb3Rhc2sgYmF0Y2hlci5cbiAqXG4gKiBQYXR0ZXJuOiAgS2VybmVsLXN0eWxlIGJvdHRvbS1oYWxmLiBQcm9kdWNlcnMgb25seSBzZXQgYSBmbGFnIChcIndvcmtcbiAqICAgICAgICAgICBwZW5kaW5nXCIpIGFuZCByZXR1cm47IHRoZSBhY3R1YWwgd29yayBydW5zIGF0IHRoZSBuZXh0XG4gKiAgICAgICAgICAgc2NoZWR1bGluZyBjaGVja3BvaW50IChhIG1pY3JvdGFzayksIGRyYWlucyB1bmRlciBhIHRpbWVcbiAqICAgICAgICAgICBidWRnZXQsIGFuZCByZS1hcm1zIGl0c2VsZiBpZiBiYWNrbG9nIHJlbWFpbnMuIFNhbWUgc2hhcGUgYXNcbiAqICAgICAgICAgICB0aGUgZGV0YWNoIG1vZHVsZSdzIGBtaWNyb3Rhc2tCYXRjaERyaXZlcmAg4oCUIGFjY3VtdWxhdGUgZHVyaW5nXG4gKiAgICAgICAgICAgdGhlIGN1cnJlbnQgc3luYyBzbGljZSwgZHJhaW4gYXQgdGhlIGJvdW5kYXJ5LlxuICogUm9sZTogICAgIFRoZSBzY2hlZHVsZXIgb2YgdGhlIGRlZmVycmVkLW9ic2VydmVyIHBpcGVsaW5lLiBPd25zIFdIRU5cbiAqICAgICAgICAgICBkZWxpdmVyeSBoYXBwZW5zOyBrbm93cyBub3RoaW5nIGFib3V0IGVudmVsb3BlcyBvciBsaXN0ZW5lcnNcbiAqICAgICAgICAgICAodGhlIGRpc3BhdGNoZXIsIEJsb2NrIDUsIGluamVjdHMgYGRlcHRoYC9gcHJvY2Vzc05leHRgKS5cbiAqICAgICAgICAgICBQdXJlIG1vZHVsZSDigJQgemVybyBpbXBvcnRzLCB6ZXJvIGVuZ2luZSBrbm93bGVkZ2UuXG4gKlxuICogU2NoZWR1bGluZyBzZW1hbnRpY3MgKG5vcm1hdGl2ZSwgUkZDLTAwMSDCpzUgKyBhbWVuZG1lbnQgQTEpOlxuICogICAtIGBhcm0oKWAgaXMgaWRlbXBvdGVudDogYXQgbW9zdCBPTkUgcGVuZGluZyBmbHVzaCBleGlzdHMgKGFybWVkIGZsYWcpLlxuICogICAgIE4gY2FwdHVyZXMgYmV0d2VlbiBjaGVja3BvaW50cyDih5IgZXhhY3RseSAxIGZsdXNoLlxuICogICAtIEEgZmx1c2ggZHJhaW5zIGEgU05BUFNIT1Q6IGF0IG1vc3QgYGRlcHRoKClgLWF0LWZsdXNoLXN0YXJ0IGl0ZW1zLlxuICogICAgIEV2ZW50cyBlbnF1ZXVlZCBCWSBsaXN0ZW5lcnMgZHVyaW5nIHRoZSBmbHVzaCBleGNlZWQgdGhlIHNuYXBzaG90IGFuZFxuICogICAgIGxhbmQgYXQgdGhlIE5FWFQgY2hlY2twb2ludCDigJQgbGlzdGVuZXItZHJpdmVuIGNhc2NhZGVzIGNhbm5vdCBzdGFydmVcbiAqICAgICB0aGUgZXZlbnQgbG9vcC5cbiAqICAgLSBgZmx1c2hCdWRnZXRNc2AgKGRlZmF1bHQgMjsgYEluZmluaXR5YCA9IGZ1bGwgc25hcHNob3QgZHJhaW4pOiB0aGVcbiAqICAgICBmbHVzaCBzdG9wcyBvbmNlIHRoZSBidWRnZXQgaXMgZXhoYXVzdGVkLCBjb3VudHMgYGJ1ZGdldEV4aGF1c3RlZGAsXG4gKiAgICAgYW5kIHJlLWFybXMuIEF0IGxlYXN0IE9ORSBpdGVtIGlzIHByb2Nlc3NlZCBwZXIgZmx1c2ggcmVnYXJkbGVzcyBvZlxuICogICAgIGJ1ZGdldCDigJQgZ3VhcmFudGVlZCBwcm9ncmVzcyB1bmRlciBhbnkgY2xvY2suXG4gKiAgIC0gSWYgYmFja2xvZyByZW1haW5zIGFmdGVyIHRoZSBmbHVzaCAoYnVkZ2V0IGN1dCBPUiBsaXN0ZW5lciBlbnF1ZXVlcyksXG4gKiAgICAgdGhlIGRyaXZlciByZS1hcm1zIGZvciB0aGUgbmV4dCBjaGVja3BvaW50LlxuICpcbiAqIFdoeSBzdGFnZSBib3VuZGFyaWVzIG1ha2UgdGhpcyBzYWZlOiB0aGUgZW5naW5lIGBhd2FpdGBzIGV2ZXJ5IHN0YWdlLCBzb1xuICogdGhlIG1pY3JvdGFzayBxdWV1ZSBydW5zIGF0IEVWRVJZIHN0YWdlIGJvdW5kYXJ5IOKAlCBmbHVzaGVzIGFyZSBhdCBtb3N0XG4gKiBcIm9uZSBiZWF0IGJlaGluZFwiIHRoZSBwcm9kdWNpbmcgc3RhZ2UuIFNlZVxuICogYGRvY3MvZ3VpZGVzL2V4ZWN1dGlvbi1tb2RlbC5tZGAgKFwiU3RhZ2UgYm91bmRhcmllcyBhcmUgc2NoZWR1bGluZ1xuICogcG9pbnRzXCIpIGFuZCB0aGUgRkFRIGluIGBkb2NzL2Rlc2lnbi9yZmMtMDAxLWRlZmVycmVkLW9ic2VydmVycy5tZGAuXG4gKlxuICogVGVzdGFiaWxpdHk6IGBub3dgIChjbG9jaykgYW5kIGBzY2hlZHVsZWAgKGNoZWNrcG9pbnQgcHJpbWl0aXZlKSBhcmVcbiAqIGluamVjdGFibGUg4oCUIHRlc3RzIHB1bXAgZmx1c2hlcyBkZXRlcm1pbmlzdGljYWxseSB3aXRoIGEgZmFrZSBjbG9jayBhbmRcbiAqIGEgY2FwdHVyZWQtY2FsbGJhY2sgc2NoZWR1bGVyOyBwcm9kdWN0aW9uIHVzZXMgYHBlcmZvcm1hbmNlLm5vd2AgYW5kXG4gKiBgcXVldWVNaWNyb3Rhc2tgLlxuICovXG5cbi8qKiBSZXN1bHQgb2Ygb25lIGZsdXNoIChhbHNvIGRlbGl2ZXJlZCB0byBgb25GbHVzaEVuZGApLiAqL1xuZXhwb3J0IGludGVyZmFjZSBGbHVzaE91dGNvbWUge1xuICAvKiogSXRlbXMgcHJvY2Vzc2VkIGluIHRoaXMgZmx1c2guICovXG4gIHJlYWRvbmx5IHByb2Nlc3NlZDogbnVtYmVyO1xuICAvKiogVHJ1ZSB3aGVuIHRoZSB0aW1lIGJ1ZGdldCBjdXQgdGhlIGZsdXNoIGJlZm9yZSB0aGUgc25hcHNob3QgZHJhaW5lZC4gKi9cbiAgcmVhZG9ubHkgYnVkZ2V0RXhoYXVzdGVkOiBib29sZWFuO1xuICAvKiogVHJ1ZSB3aGVuIGJhY2tsb2cgcmVtYWluZWQgYW5kIHRoZSBkcml2ZXIgcmUtYXJtZWQgaXRzZWxmLiAqL1xuICByZWFkb25seSByZWFybWVkOiBib29sZWFuO1xufVxuXG4vKiogUmVzdWx0IG9mIGEgc3luY2hyb25vdXMge0BsaW5rIEZsdXNoRHJpdmVyLmZsdXNoU3luY30gZHJhaW4uICovXG5leHBvcnQgaW50ZXJmYWNlIEZsdXNoU3luY1Jlc3VsdCB7XG4gIC8qKiBJdGVtcyBwcm9jZXNzZWQgYWNyb3NzIGFsbCByb3VuZHMuICovXG4gIHJlYWRvbmx5IGRyYWluZWQ6IG51bWJlcjtcbiAgLyoqIEl0ZW1zIHN0aWxsIHF1ZXVlZCB3aGVuIGBtYXhSb3VuZHNgIHN0b3BwZWQgYSBydW5hd2F5IGNhc2NhZGUuICovXG4gIHJlYWRvbmx5IHJlbWFpbmluZzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEZsdXNoRHJpdmVyT3B0aW9ucyB7XG4gIC8qKiBDdXJyZW50IGJhY2tsb2cgb2YgdGhlIHF1ZXVlIHRoaXMgZHJpdmVyIGRyYWlucy4gKi9cbiAgcmVhZG9ubHkgZGVwdGg6ICgpID0+IG51bWJlcjtcbiAgLyoqIFByb2Nlc3MgZXhhY3RseSBPTkUgcXVldWVkIGl0ZW0uIFByZWNvbmRpdGlvbjogYGRlcHRoKCkgPiAwYC4gKi9cbiAgcmVhZG9ubHkgcHJvY2Vzc05leHQ6ICgpID0+IHZvaWQ7XG4gIC8qKlxuICAgKiBQZXItZmx1c2ggdGltZSBidWRnZXQgaW4gbXMuIERlZmF1bHQgMi4gYEluZmluaXR5YCBkcmFpbnMgdGhlIGZ1bGxcbiAgICogc25hcHNob3QgZXZlcnkgY2hlY2twb2ludC4gTXVzdCBiZSA+IDAuXG4gICAqL1xuICByZWFkb25seSBmbHVzaEJ1ZGdldE1zPzogbnVtYmVyO1xuICAvKiogQ2xvY2sg4oCUIGRlZmF1bHQgYHBlcmZvcm1hbmNlLm5vd2AgKGZhbGxzIGJhY2sgdG8gYERhdGUubm93YCkuICovXG4gIHJlYWRvbmx5IG5vdz86ICgpID0+IG51bWJlcjtcbiAgLyoqIENoZWNrcG9pbnQgcHJpbWl0aXZlIOKAlCBkZWZhdWx0IGBxdWV1ZU1pY3JvdGFza2AuICovXG4gIHJlYWRvbmx5IHNjaGVkdWxlPzogKGNiOiAoKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAvKiogRmlyZXMgYmVmb3JlIHRoZSBmaXJzdCBpdGVtIG9mIGV2ZXJ5IGZsdXNoIChpbmNsLiBgZmx1c2hTeW5jYCkuICovXG4gIHJlYWRvbmx5IG9uRmx1c2hTdGFydD86ICgpID0+IHZvaWQ7XG4gIC8qKiBGaXJlcyBhZnRlciBldmVyeSBmbHVzaCB3aXRoIGl0cyBvdXRjb21lIChpbmNsLiBgZmx1c2hTeW5jYCkuICovXG4gIHJlYWRvbmx5IG9uRmx1c2hFbmQ/OiAob3V0Y29tZTogRmx1c2hPdXRjb21lKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEZsdXNoRHJpdmVyU3RhdHMge1xuICAvKiogQ29tcGxldGVkIGZsdXNoZXMgKHplcm8td29yayB3YWtldXBzIGFyZSBub3QgY291bnRlZCkuICovXG4gIHJlYWRvbmx5IGZsdXNoZXM6IG51bWJlcjtcbiAgLyoqIEZsdXNoZXMgY3V0IHNob3J0IGJ5IGBmbHVzaEJ1ZGdldE1zYCAoQTEg4oCUIGJhY2tsb2cgdmlzaWJpbGl0eSkuICovXG4gIHJlYWRvbmx5IGJ1ZGdldEV4aGF1c3RlZDogbnVtYmVyO1xuICAvKiogRHVyYXRpb24gb2YgdGhlIG1vc3QgcmVjZW50IGZsdXNoLCBtcy4gKi9cbiAgcmVhZG9ubHkgbGFzdEZsdXNoTXM6IG51bWJlcjtcbiAgLyoqIHA5NSBvdmVyIHRoZSBsYXN0IHtAbGluayBGTFVTSF9TQU1QTEVfV0lORE9XfSBmbHVzaCBkdXJhdGlvbnMsIG1zLiAqL1xuICByZWFkb25seSBwOTVGbHVzaE1zOiBudW1iZXI7XG4gIC8qKiBUcnVlIHdoaWxlIGEgZmx1c2ggaXMgc2NoZWR1bGVkIGJ1dCBub3QgeWV0IHJ1bi4gKi9cbiAgcmVhZG9ubHkgYXJtZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBSb2xsaW5nIHNhbXBsZSB3aW5kb3cgZm9yIHRoZSBwOTUgZmx1c2gtZHVyYXRpb24gc3RhdCAoQTQpLiAqL1xuZXhwb3J0IGNvbnN0IEZMVVNIX1NBTVBMRV9XSU5ET1cgPSAxMjg7XG5cbi8qKiBEZWZhdWx0IGNhc2NhZGUgY2FwIGZvciB7QGxpbmsgRmx1c2hEcml2ZXIuZmx1c2hTeW5jfS4gKi9cbmNvbnN0IERFRkFVTFRfTUFYX1NZTkNfUk9VTkRTID0gMV8wMDA7XG5cbmNvbnN0IGRlZmF1bHROb3cgPSAoKTogbnVtYmVyID0+ICh0eXBlb2YgcGVyZm9ybWFuY2UgIT09ICd1bmRlZmluZWQnID8gcGVyZm9ybWFuY2Uubm93KCkgOiBEYXRlLm5vdygpKTtcblxuZXhwb3J0IGNsYXNzIEZsdXNoRHJpdmVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBkZXB0aDogKCkgPT4gbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHByb2Nlc3NOZXh0OiAoKSA9PiB2b2lkO1xuICBwcml2YXRlIHJlYWRvbmx5IGZsdXNoQnVkZ2V0TXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBub3c6ICgpID0+IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBzY2hlZHVsZTogKGNiOiAoKSA9PiB2b2lkKSA9PiB2b2lkO1xuICBwcml2YXRlIHJlYWRvbmx5IG9uRmx1c2hTdGFydD86ICgpID0+IHZvaWQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgb25GbHVzaEVuZD86IChvdXRjb21lOiBGbHVzaE91dGNvbWUpID0+IHZvaWQ7XG5cbiAgcHJpdmF0ZSBhcm1lZCA9IGZhbHNlO1xuICBwcml2YXRlIGZsdXNoZXMgPSAwO1xuICBwcml2YXRlIGJ1ZGdldEV4aGF1c3RlZENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0Rmx1c2hNcyA9IDA7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2FtcGxlczogbnVtYmVyW10gPSBbXTtcbiAgcHJpdmF0ZSBzYW1wbGVXcml0ZUlkeCA9IDA7XG5cbiAgY29uc3RydWN0b3Iob3B0czogRmx1c2hEcml2ZXJPcHRpb25zKSB7XG4gICAgY29uc3QgYnVkZ2V0ID0gb3B0cy5mbHVzaEJ1ZGdldE1zID8/IDI7XG4gICAgaWYgKE51bWJlci5pc05hTihidWRnZXQpIHx8IGJ1ZGdldCA8PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcihgZmx1c2hCdWRnZXRNcyBtdXN0IGJlID4gMCAoZ290ICR7YnVkZ2V0fSk7IHVzZSBJbmZpbml0eSBmb3IgZnVsbCBkcmFpbnNgKTtcbiAgICB9XG4gICAgdGhpcy5kZXB0aCA9IG9wdHMuZGVwdGg7XG4gICAgdGhpcy5wcm9jZXNzTmV4dCA9IG9wdHMucHJvY2Vzc05leHQ7XG4gICAgdGhpcy5mbHVzaEJ1ZGdldE1zID0gYnVkZ2V0O1xuICAgIHRoaXMubm93ID0gb3B0cy5ub3cgPz8gZGVmYXVsdE5vdztcbiAgICB0aGlzLnNjaGVkdWxlID0gb3B0cy5zY2hlZHVsZSA/PyAoKGNiKSA9PiBxdWV1ZU1pY3JvdGFzayhjYikpO1xuICAgIHRoaXMub25GbHVzaFN0YXJ0ID0gb3B0cy5vbkZsdXNoU3RhcnQ7XG4gICAgdGhpcy5vbkZsdXNoRW5kID0gb3B0cy5vbkZsdXNoRW5kO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlcXVlc3QgYSBmbHVzaCBhdCB0aGUgbmV4dCBjaGVja3BvaW50LiBJZGVtcG90ZW50IOKAlCB3aGlsZSBvbmUgZmx1c2hcbiAgICogaXMgcGVuZGluZywgZnVydGhlciBhcm1zIGFyZSBmcmVlIG5vLW9wcyAodGhlIGFybWVkLW9uY2UgaW52YXJpYW50KS5cbiAgICovXG4gIGFybSgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5hcm1lZCkgcmV0dXJuO1xuICAgIHRoaXMuYXJtZWQgPSB0cnVlO1xuICAgIHRoaXMuc2NoZWR1bGUoKCkgPT4gdGhpcy5mbHVzaCgpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTeW5jaHJvbm91cyBmdWxsIGRyYWluIOKAlCB0aGUgdGVybWluYWwtZmx1c2ggcHJpbWl0aXZlIChlbmQgb2YgcnVuIC9cbiAgICogc2h1dGRvd24pLiBSZXBlYXRzIHNuYXBzaG90IHJvdW5kcyB1bnRpbCB0aGUgcXVldWUgaXMgZW1wdHkgc29cbiAgICogbGlzdGVuZXItZW5xdWV1ZWQgY2FzY2FkZXMgZHJhaW4gdG9vLCBjYXBwZWQgYXQgYG1heFJvdW5kc2Agc28gYVxuICAgKiBsaXN0ZW5lciB0aGF0IGVucXVldWVzIGZvcmV2ZXIgY2Fubm90IGhhbmcgdGhlIHByb2Nlc3MgKGByZW1haW5pbmdgXG4gICAqIHJlcG9ydHMgd2hhdCB0aGUgY2FwIGxlZnQgYmVoaW5kKS5cbiAgICovXG4gIGZsdXNoU3luYyhvcHRzPzogeyBtYXhSb3VuZHM/OiBudW1iZXIgfSk6IEZsdXNoU3luY1Jlc3VsdCB7XG4gICAgY29uc3QgbWF4Um91bmRzID0gb3B0cz8ubWF4Um91bmRzID8/IERFRkFVTFRfTUFYX1NZTkNfUk9VTkRTO1xuICAgIGlmICh0aGlzLmRlcHRoKCkgPT09IDApIHJldHVybiB7IGRyYWluZWQ6IDAsIHJlbWFpbmluZzogMCB9O1xuXG4gICAgdGhpcy5vbkZsdXNoU3RhcnQ/LigpO1xuICAgIGNvbnN0IHN0YXJ0ID0gdGhpcy5ub3coKTtcbiAgICBsZXQgZHJhaW5lZCA9IDA7XG4gICAgZm9yIChsZXQgcm91bmQgPSAwOyByb3VuZCA8IG1heFJvdW5kcyAmJiB0aGlzLmRlcHRoKCkgPiAwOyByb3VuZCsrKSB7XG4gICAgICBjb25zdCBzbmFwc2hvdCA9IHRoaXMuZGVwdGgoKTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgc25hcHNob3QgJiYgdGhpcy5kZXB0aCgpID4gMDsgaSsrKSB7XG4gICAgICAgIHRoaXMucHJvY2Vzc05leHQoKTtcbiAgICAgICAgZHJhaW5lZCArPSAxO1xuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnJlY29yZEZsdXNoKHRoaXMubm93KCkgLSBzdGFydCwgZmFsc2UpO1xuICAgIGNvbnN0IHJlbWFpbmluZyA9IHRoaXMuZGVwdGgoKTtcbiAgICB0aGlzLm9uRmx1c2hFbmQ/Lih7IHByb2Nlc3NlZDogZHJhaW5lZCwgYnVkZ2V0RXhoYXVzdGVkOiBmYWxzZSwgcmVhcm1lZDogZmFsc2UgfSk7XG4gICAgcmV0dXJuIHsgZHJhaW5lZCwgcmVtYWluaW5nIH07XG4gIH1cblxuICBnZXRTdGF0cygpOiBGbHVzaERyaXZlclN0YXRzIHtcbiAgICByZXR1cm4ge1xuICAgICAgZmx1c2hlczogdGhpcy5mbHVzaGVzLFxuICAgICAgYnVkZ2V0RXhoYXVzdGVkOiB0aGlzLmJ1ZGdldEV4aGF1c3RlZENvdW50LFxuICAgICAgbGFzdEZsdXNoTXM6IHRoaXMubGFzdEZsdXNoTXMsXG4gICAgICBwOTVGbHVzaE1zOiB0aGlzLnA5NUZsdXNoTXMoKSxcbiAgICAgIGFybWVkOiB0aGlzLmFybWVkLFxuICAgIH07XG4gIH1cblxuICAvKiogVGhlIG1pY3JvdGFzayBib2R5IOKAlCBzZWUgdGhlIG1vZHVsZS1oZWFkZXIgc2VtYW50aWNzLiAqL1xuICBwcml2YXRlIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMuYXJtZWQgPSBmYWxzZTtcbiAgICBjb25zdCBzbmFwc2hvdCA9IHRoaXMuZGVwdGgoKTtcbiAgICBpZiAoc25hcHNob3QgPT09IDApIHJldHVybjsgLy8gcmFjZWQgd2l0aCBmbHVzaFN5bmMg4oCUIHplcm8td29yayB3YWtldXBcblxuICAgIHRoaXMub25GbHVzaFN0YXJ0Py4oKTtcbiAgICBjb25zdCBzdGFydCA9IHRoaXMubm93KCk7XG4gICAgbGV0IHByb2Nlc3NlZCA9IDA7XG4gICAgbGV0IGV4aGF1c3RlZCA9IGZhbHNlO1xuICAgIHdoaWxlIChwcm9jZXNzZWQgPCBzbmFwc2hvdCAmJiB0aGlzLmRlcHRoKCkgPiAwKSB7XG4gICAgICAvLyBCdWRnZXQgY2hlY2sgQUZURVIgdGhlIGZpcnN0IGl0ZW0g4oCUIGd1YXJhbnRlZWQgcHJvZ3Jlc3MgcGVyIGZsdXNoLlxuICAgICAgaWYgKHByb2Nlc3NlZCA+IDAgJiYgdGhpcy5ub3coKSAtIHN0YXJ0ID49IHRoaXMuZmx1c2hCdWRnZXRNcykge1xuICAgICAgICBleGhhdXN0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHRoaXMucHJvY2Vzc05leHQoKTtcbiAgICAgIHByb2Nlc3NlZCArPSAxO1xuICAgIH1cbiAgICB0aGlzLnJlY29yZEZsdXNoKHRoaXMubm93KCkgLSBzdGFydCwgZXhoYXVzdGVkKTtcblxuICAgIC8vIEJhY2tsb2cgbGVmdCAoYnVkZ2V0IGN1dCwgb3IgbGlzdGVuZXJzIGVucXVldWVkIHBhc3QgdGhlIHNuYXBzaG90KTpcbiAgICAvLyBoYW5kIGl0IHRvIHRoZSBORVhUIGNoZWNrcG9pbnQg4oCUIG5ldmVyIHN0YXJ2ZSwgbmV2ZXIgc3Bpbi5cbiAgICBjb25zdCByZWFybWVkID0gdGhpcy5kZXB0aCgpID4gMDtcbiAgICBpZiAocmVhcm1lZCkgdGhpcy5hcm0oKTtcbiAgICB0aGlzLm9uRmx1c2hFbmQ/Lih7IHByb2Nlc3NlZCwgYnVkZ2V0RXhoYXVzdGVkOiBleGhhdXN0ZWQsIHJlYXJtZWQgfSk7XG4gIH1cblxuICBwcml2YXRlIHJlY29yZEZsdXNoKGVsYXBzZWRNczogbnVtYmVyLCBleGhhdXN0ZWQ6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICB0aGlzLmZsdXNoZXMgKz0gMTtcbiAgICB0aGlzLmxhc3RGbHVzaE1zID0gZWxhcHNlZE1zO1xuICAgIGlmIChleGhhdXN0ZWQpIHRoaXMuYnVkZ2V0RXhoYXVzdGVkQ291bnQgKz0gMTtcbiAgICBpZiAodGhpcy5zYW1wbGVzLmxlbmd0aCA8IEZMVVNIX1NBTVBMRV9XSU5ET1cpIHRoaXMuc2FtcGxlcy5wdXNoKGVsYXBzZWRNcyk7XG4gICAgZWxzZSB7XG4gICAgICB0aGlzLnNhbXBsZXNbdGhpcy5zYW1wbGVXcml0ZUlkeF0gPSBlbGFwc2VkTXM7XG4gICAgICB0aGlzLnNhbXBsZVdyaXRlSWR4ID0gKHRoaXMuc2FtcGxlV3JpdGVJZHggKyAxKSAlIEZMVVNIX1NBTVBMRV9XSU5ET1c7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBwOTVGbHVzaE1zKCk6IG51bWJlciB7XG4gICAgaWYgKHRoaXMuc2FtcGxlcy5sZW5ndGggPT09IDApIHJldHVybiAwO1xuICAgIGNvbnN0IHNvcnRlZCA9IFsuLi50aGlzLnNhbXBsZXNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgICByZXR1cm4gc29ydGVkW01hdGgubWluKHNvcnRlZC5sZW5ndGggLSAxLCBNYXRoLmZsb29yKHNvcnRlZC5sZW5ndGggKiAwLjk1KSldO1xuICB9XG59XG4iXX0=