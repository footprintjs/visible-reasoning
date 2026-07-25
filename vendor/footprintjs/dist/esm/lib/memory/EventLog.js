/**
 * EventLog — Time-travel snapshot storage for flowchart execution
 *
 * Like git history: stores commit bundles (diffs), not full snapshots.
 * materialise(stepIdx) reconstructs state at any point by replaying commits.
 */
import { applySmartMerge } from './utils.js';
export class EventLog {
    /** Base snapshot BEFORE the first stage mutates anything. */
    base;
    /** Ordered list of commit bundles. */
    steps = [];
    constructor(initialMemory) {
        this.base = structuredClone(initialMemory);
    }
    /**
     * Reconstructs the full state at any given step.
     * Replays commits from the beginning — O(n) but low memory footprint.
     */
    materialise(stepIdx = this.steps.length) {
        let out = structuredClone(this.base);
        for (let i = 0; i < stepIdx; i++) {
            const { overwrite, updates, trace } = this.steps[i];
            out = applySmartMerge(out, updates, overwrite, trace);
        }
        return out;
    }
    /** Persists a commit bundle for a finished stage. */
    record(bundle) {
        bundle.idx = this.steps.length;
        this.steps.push(bundle);
    }
    /** Gets all recorded commit bundles. */
    list() {
        return this.steps;
    }
    /** Number of recorded commits. */
    get length() {
        return this.steps.length;
    }
    /** Wipes history (useful for test resets). */
    clear() {
        this.steps = [];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXZlbnRMb2cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL21lbW9yeS9FdmVudExvZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7R0FLRztBQUdILE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFN0MsTUFBTSxPQUFPLFFBQVE7SUFDbkIsNkRBQTZEO0lBQ3JELElBQUksQ0FBTTtJQUNsQixzQ0FBc0M7SUFDOUIsS0FBSyxHQUFtQixFQUFFLENBQUM7SUFFbkMsWUFBWSxhQUFrQjtRQUM1QixJQUFJLENBQUMsSUFBSSxHQUFHLGVBQWUsQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUM3QyxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsV0FBVyxDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU07UUFDckMsSUFBSSxHQUFHLEdBQUcsZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNyQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsT0FBTyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7WUFDakMsTUFBTSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNwRCxHQUFHLEdBQUcsZUFBZSxDQUFDLEdBQUcsRUFBRSxPQUFzQixFQUFFLFNBQXdCLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDdEYsQ0FBQztRQUNELE9BQU8sR0FBRyxDQUFDO0lBQ2IsQ0FBQztJQUVELHFEQUFxRDtJQUNyRCxNQUFNLENBQUMsTUFBb0I7UUFDekIsTUFBTSxDQUFDLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUMvQixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUMxQixDQUFDO0lBRUQsd0NBQXdDO0lBQ3hDLElBQUk7UUFDRixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUM7SUFDcEIsQ0FBQztJQUVELGtDQUFrQztJQUNsQyxJQUFJLE1BQU07UUFDUixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDO0lBQzNCLENBQUM7SUFFRCw4Q0FBOEM7SUFDOUMsS0FBSztRQUNILElBQUksQ0FBQyxLQUFLLEdBQUcsRUFBRSxDQUFDO0lBQ2xCLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRXZlbnRMb2cg4oCUIFRpbWUtdHJhdmVsIHNuYXBzaG90IHN0b3JhZ2UgZm9yIGZsb3djaGFydCBleGVjdXRpb25cbiAqXG4gKiBMaWtlIGdpdCBoaXN0b3J5OiBzdG9yZXMgY29tbWl0IGJ1bmRsZXMgKGRpZmZzKSwgbm90IGZ1bGwgc25hcHNob3RzLlxuICogbWF0ZXJpYWxpc2Uoc3RlcElkeCkgcmVjb25zdHJ1Y3RzIHN0YXRlIGF0IGFueSBwb2ludCBieSByZXBsYXlpbmcgY29tbWl0cy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IENvbW1pdEJ1bmRsZSwgTWVtb3J5UGF0Y2ggfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IGFwcGx5U21hcnRNZXJnZSB9IGZyb20gJy4vdXRpbHMuanMnO1xuXG5leHBvcnQgY2xhc3MgRXZlbnRMb2cge1xuICAvKiogQmFzZSBzbmFwc2hvdCBCRUZPUkUgdGhlIGZpcnN0IHN0YWdlIG11dGF0ZXMgYW55dGhpbmcuICovXG4gIHByaXZhdGUgYmFzZTogYW55O1xuICAvKiogT3JkZXJlZCBsaXN0IG9mIGNvbW1pdCBidW5kbGVzLiAqL1xuICBwcml2YXRlIHN0ZXBzOiBDb21taXRCdW5kbGVbXSA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKGluaXRpYWxNZW1vcnk6IGFueSkge1xuICAgIHRoaXMuYmFzZSA9IHN0cnVjdHVyZWRDbG9uZShpbml0aWFsTWVtb3J5KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWNvbnN0cnVjdHMgdGhlIGZ1bGwgc3RhdGUgYXQgYW55IGdpdmVuIHN0ZXAuXG4gICAqIFJlcGxheXMgY29tbWl0cyBmcm9tIHRoZSBiZWdpbm5pbmcg4oCUIE8obikgYnV0IGxvdyBtZW1vcnkgZm9vdHByaW50LlxuICAgKi9cbiAgbWF0ZXJpYWxpc2Uoc3RlcElkeCA9IHRoaXMuc3RlcHMubGVuZ3RoKTogYW55IHtcbiAgICBsZXQgb3V0ID0gc3RydWN0dXJlZENsb25lKHRoaXMuYmFzZSk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzdGVwSWR4OyBpKyspIHtcbiAgICAgIGNvbnN0IHsgb3ZlcndyaXRlLCB1cGRhdGVzLCB0cmFjZSB9ID0gdGhpcy5zdGVwc1tpXTtcbiAgICAgIG91dCA9IGFwcGx5U21hcnRNZXJnZShvdXQsIHVwZGF0ZXMgYXMgTWVtb3J5UGF0Y2gsIG92ZXJ3cml0ZSBhcyBNZW1vcnlQYXRjaCwgdHJhY2UpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgLyoqIFBlcnNpc3RzIGEgY29tbWl0IGJ1bmRsZSBmb3IgYSBmaW5pc2hlZCBzdGFnZS4gKi9cbiAgcmVjb3JkKGJ1bmRsZTogQ29tbWl0QnVuZGxlKTogdm9pZCB7XG4gICAgYnVuZGxlLmlkeCA9IHRoaXMuc3RlcHMubGVuZ3RoO1xuICAgIHRoaXMuc3RlcHMucHVzaChidW5kbGUpO1xuICB9XG5cbiAgLyoqIEdldHMgYWxsIHJlY29yZGVkIGNvbW1pdCBidW5kbGVzLiAqL1xuICBsaXN0KCk6IENvbW1pdEJ1bmRsZVtdIHtcbiAgICByZXR1cm4gdGhpcy5zdGVwcztcbiAgfVxuXG4gIC8qKiBOdW1iZXIgb2YgcmVjb3JkZWQgY29tbWl0cy4gKi9cbiAgZ2V0IGxlbmd0aCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnN0ZXBzLmxlbmd0aDtcbiAgfVxuXG4gIC8qKiBXaXBlcyBoaXN0b3J5ICh1c2VmdWwgZm9yIHRlc3QgcmVzZXRzKS4gKi9cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgdGhpcy5zdGVwcyA9IFtdO1xuICB9XG59XG4iXX0=