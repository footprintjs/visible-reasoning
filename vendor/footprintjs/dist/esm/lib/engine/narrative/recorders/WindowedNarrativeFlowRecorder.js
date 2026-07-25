/**
 * WindowedNarrativeFlowRecorder — Shows first N and last M loop iterations, skips the middle.
 *
 * Best for: Moderate loops (10–200 iterations) where you want to see how it started
 * and how it ended, without the noise in between.
 *
 * When total iterations <= head + tail, all iterations are emitted (no compression).
 * When total > head + tail, the middle is replaced with a summary line.
 *
 * @example
 * ```typescript
 * // Show first 3 and last 2 iterations
 * executor.attachFlowRecorder(new WindowedNarrativeFlowRecorder(3, 2));
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class WindowedNarrativeFlowRecorder extends NarrativeFlowRecorder {
    head;
    tail;
    loopEvents = new Map();
    constructor(head = 3, tail = 2, id) {
        super(id ?? 'narrative-windowed');
        this.head = head;
        this.tail = tail;
    }
    onLoop(event) {
        // Accumulate all loop events — we'll render them in getSentences
        const key = event.target;
        let events = this.loopEvents.get(key);
        if (!events) {
            events = [];
            this.loopEvents.set(key, events);
        }
        events.push(event);
        // Don't call super — we handle all loop sentence generation in getSentences
    }
    getSentences() {
        const baseSentences = super.getSentences();
        // Append windowed loop sentences for each target
        const result = [...baseSentences];
        for (const [, events] of this.loopEvents) {
            const total = events.length;
            if (total <= this.head + this.tail) {
                // Small loop — emit all iterations
                for (const ev of events) {
                    result.push(this.formatLoopSentence(ev));
                }
            }
            else {
                // Large loop — head + skip summary + tail
                for (let i = 0; i < this.head; i++) {
                    result.push(this.formatLoopSentence(events[i]));
                }
                const skipped = total - this.head - this.tail;
                result.push(`... (${skipped} iterations omitted)`);
                for (let i = total - this.tail; i < total; i++) {
                    result.push(this.formatLoopSentence(events[i]));
                }
            }
        }
        return result;
    }
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount() {
        let total = 0;
        for (const [, events] of this.loopEvents) {
            if (events.length > this.head + this.tail) {
                total += events.length - this.head - this.tail;
            }
        }
        return total;
    }
    clear() {
        super.clear();
        this.loopEvents.clear();
    }
    formatLoopSentence(event) {
        if (event.description) {
            return `On pass ${event.iteration}: ${event.description} again.`;
        }
        return `On pass ${event.iteration} through ${event.target}.`;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiV2luZG93ZWROYXJyYXRpdmVGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL1dpbmRvd2VkTmFycmF0aXZlRmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBRUgsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFHcEUsTUFBTSxPQUFPLDZCQUE4QixTQUFRLHFCQUFxQjtJQUNyRCxJQUFJLENBQVM7SUFDYixJQUFJLENBQVM7SUFDdEIsVUFBVSxHQUFpQyxJQUFJLEdBQUcsRUFBRSxDQUFDO0lBRTdELFlBQVksSUFBSSxHQUFHLENBQUMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxFQUFFLEVBQVc7UUFDekMsS0FBSyxDQUFDLEVBQUUsSUFBSSxvQkFBb0IsQ0FBQyxDQUFDO1FBQ2xDLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBQ2pCLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0lBQ25CLENBQUM7SUFFUSxNQUFNLENBQUMsS0FBb0I7UUFDbEMsaUVBQWlFO1FBQ2pFLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7UUFDekIsSUFBSSxNQUFNLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDdEMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ1osTUFBTSxHQUFHLEVBQUUsQ0FBQztZQUNaLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxNQUFNLENBQUMsQ0FBQztRQUNuQyxDQUFDO1FBQ0QsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVuQiw0RUFBNEU7SUFDOUUsQ0FBQztJQUVRLFlBQVk7UUFDbkIsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLFlBQVksRUFBRSxDQUFDO1FBRTNDLGlEQUFpRDtRQUNqRCxNQUFNLE1BQU0sR0FBRyxDQUFDLEdBQUcsYUFBYSxDQUFDLENBQUM7UUFDbEMsS0FBSyxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDekMsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQztZQUU1QixJQUFJLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDbkMsbUNBQW1DO2dCQUNuQyxLQUFLLE1BQU0sRUFBRSxJQUFJLE1BQU0sRUFBRSxDQUFDO29CQUN4QixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUMzQyxDQUFDO1lBQ0gsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLDBDQUEwQztnQkFDMUMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztvQkFDbkMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDbEQsQ0FBQztnQkFDRCxNQUFNLE9BQU8sR0FBRyxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO2dCQUM5QyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsT0FBTyxzQkFBc0IsQ0FBQyxDQUFDO2dCQUNuRCxLQUFLLElBQUksQ0FBQyxHQUFHLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztvQkFDL0MsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDbEQsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO1FBRUQsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQztJQUVELHVEQUF1RDtJQUN2RCxrQkFBa0I7UUFDaEIsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO1FBQ2QsS0FBSyxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDekMsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUMxQyxLQUFLLElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUM7WUFDakQsQ0FBQztRQUNILENBQUM7UUFDRCxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFFUSxLQUFLO1FBQ1osS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2QsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUMxQixDQUFDO0lBRU8sa0JBQWtCLENBQUMsS0FBb0I7UUFDN0MsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDdEIsT0FBTyxXQUFXLEtBQUssQ0FBQyxTQUFTLEtBQUssS0FBSyxDQUFDLFdBQVcsU0FBUyxDQUFDO1FBQ25FLENBQUM7UUFDRCxPQUFPLFdBQVcsS0FBSyxDQUFDLFNBQVMsWUFBWSxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUM7SUFDL0QsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXaW5kb3dlZE5hcnJhdGl2ZUZsb3dSZWNvcmRlciDigJQgU2hvd3MgZmlyc3QgTiBhbmQgbGFzdCBNIGxvb3AgaXRlcmF0aW9ucywgc2tpcHMgdGhlIG1pZGRsZS5cbiAqXG4gKiBCZXN0IGZvcjogTW9kZXJhdGUgbG9vcHMgKDEw4oCTMjAwIGl0ZXJhdGlvbnMpIHdoZXJlIHlvdSB3YW50IHRvIHNlZSBob3cgaXQgc3RhcnRlZFxuICogYW5kIGhvdyBpdCBlbmRlZCwgd2l0aG91dCB0aGUgbm9pc2UgaW4gYmV0d2Vlbi5cbiAqXG4gKiBXaGVuIHRvdGFsIGl0ZXJhdGlvbnMgPD0gaGVhZCArIHRhaWwsIGFsbCBpdGVyYXRpb25zIGFyZSBlbWl0dGVkIChubyBjb21wcmVzc2lvbikuXG4gKiBXaGVuIHRvdGFsID4gaGVhZCArIHRhaWwsIHRoZSBtaWRkbGUgaXMgcmVwbGFjZWQgd2l0aCBhIHN1bW1hcnkgbGluZS5cbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHlwZXNjcmlwdFxuICogLy8gU2hvdyBmaXJzdCAzIGFuZCBsYXN0IDIgaXRlcmF0aW9uc1xuICogZXhlY3V0b3IuYXR0YWNoRmxvd1JlY29yZGVyKG5ldyBXaW5kb3dlZE5hcnJhdGl2ZUZsb3dSZWNvcmRlcigzLCAyKSk7XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9OYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93TG9vcEV2ZW50IH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgV2luZG93ZWROYXJyYXRpdmVGbG93UmVjb3JkZXIgZXh0ZW5kcyBOYXJyYXRpdmVGbG93UmVjb3JkZXIge1xuICBwcml2YXRlIHJlYWRvbmx5IGhlYWQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSB0YWlsOiBudW1iZXI7XG4gIHByaXZhdGUgbG9vcEV2ZW50czogTWFwPHN0cmluZywgRmxvd0xvb3BFdmVudFtdPiA9IG5ldyBNYXAoKTtcblxuICBjb25zdHJ1Y3RvcihoZWFkID0gMywgdGFpbCA9IDIsIGlkPzogc3RyaW5nKSB7XG4gICAgc3VwZXIoaWQgPz8gJ25hcnJhdGl2ZS13aW5kb3dlZCcpO1xuICAgIHRoaXMuaGVhZCA9IGhlYWQ7XG4gICAgdGhpcy50YWlsID0gdGFpbDtcbiAgfVxuXG4gIG92ZXJyaWRlIG9uTG9vcChldmVudDogRmxvd0xvb3BFdmVudCk6IHZvaWQge1xuICAgIC8vIEFjY3VtdWxhdGUgYWxsIGxvb3AgZXZlbnRzIOKAlCB3ZSdsbCByZW5kZXIgdGhlbSBpbiBnZXRTZW50ZW5jZXNcbiAgICBjb25zdCBrZXkgPSBldmVudC50YXJnZXQ7XG4gICAgbGV0IGV2ZW50cyA9IHRoaXMubG9vcEV2ZW50cy5nZXQoa2V5KTtcbiAgICBpZiAoIWV2ZW50cykge1xuICAgICAgZXZlbnRzID0gW107XG4gICAgICB0aGlzLmxvb3BFdmVudHMuc2V0KGtleSwgZXZlbnRzKTtcbiAgICB9XG4gICAgZXZlbnRzLnB1c2goZXZlbnQpO1xuXG4gICAgLy8gRG9uJ3QgY2FsbCBzdXBlciDigJQgd2UgaGFuZGxlIGFsbCBsb29wIHNlbnRlbmNlIGdlbmVyYXRpb24gaW4gZ2V0U2VudGVuY2VzXG4gIH1cblxuICBvdmVycmlkZSBnZXRTZW50ZW5jZXMoKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IGJhc2VTZW50ZW5jZXMgPSBzdXBlci5nZXRTZW50ZW5jZXMoKTtcblxuICAgIC8vIEFwcGVuZCB3aW5kb3dlZCBsb29wIHNlbnRlbmNlcyBmb3IgZWFjaCB0YXJnZXRcbiAgICBjb25zdCByZXN1bHQgPSBbLi4uYmFzZVNlbnRlbmNlc107XG4gICAgZm9yIChjb25zdCBbLCBldmVudHNdIG9mIHRoaXMubG9vcEV2ZW50cykge1xuICAgICAgY29uc3QgdG90YWwgPSBldmVudHMubGVuZ3RoO1xuXG4gICAgICBpZiAodG90YWwgPD0gdGhpcy5oZWFkICsgdGhpcy50YWlsKSB7XG4gICAgICAgIC8vIFNtYWxsIGxvb3Ag4oCUIGVtaXQgYWxsIGl0ZXJhdGlvbnNcbiAgICAgICAgZm9yIChjb25zdCBldiBvZiBldmVudHMpIHtcbiAgICAgICAgICByZXN1bHQucHVzaCh0aGlzLmZvcm1hdExvb3BTZW50ZW5jZShldikpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBMYXJnZSBsb29wIOKAlCBoZWFkICsgc2tpcCBzdW1tYXJ5ICsgdGFpbFxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuaGVhZDsgaSsrKSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2godGhpcy5mb3JtYXRMb29wU2VudGVuY2UoZXZlbnRzW2ldKSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc2tpcHBlZCA9IHRvdGFsIC0gdGhpcy5oZWFkIC0gdGhpcy50YWlsO1xuICAgICAgICByZXN1bHQucHVzaChgLi4uICgke3NraXBwZWR9IGl0ZXJhdGlvbnMgb21pdHRlZClgKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IHRvdGFsIC0gdGhpcy50YWlsOyBpIDwgdG90YWw7IGkrKykge1xuICAgICAgICAgIHJlc3VsdC5wdXNoKHRoaXMuZm9ybWF0TG9vcFNlbnRlbmNlKGV2ZW50c1tpXSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSBudW1iZXIgb2Ygc3VwcHJlc3NlZCBsb29wIHNlbnRlbmNlcy4gKi9cbiAgZ2V0U3VwcHJlc3NlZENvdW50KCk6IG51bWJlciB7XG4gICAgbGV0IHRvdGFsID0gMDtcbiAgICBmb3IgKGNvbnN0IFssIGV2ZW50c10gb2YgdGhpcy5sb29wRXZlbnRzKSB7XG4gICAgICBpZiAoZXZlbnRzLmxlbmd0aCA+IHRoaXMuaGVhZCArIHRoaXMudGFpbCkge1xuICAgICAgICB0b3RhbCArPSBldmVudHMubGVuZ3RoIC0gdGhpcy5oZWFkIC0gdGhpcy50YWlsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdG90YWw7XG4gIH1cblxuICBvdmVycmlkZSBjbGVhcigpOiB2b2lkIHtcbiAgICBzdXBlci5jbGVhcigpO1xuICAgIHRoaXMubG9vcEV2ZW50cy5jbGVhcigpO1xuICB9XG5cbiAgcHJpdmF0ZSBmb3JtYXRMb29wU2VudGVuY2UoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiBzdHJpbmcge1xuICAgIGlmIChldmVudC5kZXNjcmlwdGlvbikge1xuICAgICAgcmV0dXJuIGBPbiBwYXNzICR7ZXZlbnQuaXRlcmF0aW9ufTogJHtldmVudC5kZXNjcmlwdGlvbn0gYWdhaW4uYDtcbiAgICB9XG4gICAgcmV0dXJuIGBPbiBwYXNzICR7ZXZlbnQuaXRlcmF0aW9ufSB0aHJvdWdoICR7ZXZlbnQudGFyZ2V0fS5gO1xuICB9XG59XG4iXX0=