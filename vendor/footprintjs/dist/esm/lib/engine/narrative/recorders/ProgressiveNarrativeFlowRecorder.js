/**
 * ProgressiveNarrativeFlowRecorder — Exponentially decreasing detail as iterations grow.
 *
 * Emits at exponentially increasing intervals: 1, 2, 4, 8, 16, 32, ...
 * Gives rich detail for early iterations and progressively less as the loop continues.
 *
 * Best for: Convergence-style loops (gradient descent, iterative refinement)
 * where early iterations are most informative.
 *
 * @example
 * ```typescript
 * executor.attachFlowRecorder(new ProgressiveNarrativeFlowRecorder());
 * // Emits: pass 1, 2, 4, 8, 16, 32, 64, 128...
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class ProgressiveNarrativeFlowRecorder extends NarrativeFlowRecorder {
    base;
    suppressedCount = 0;
    /**
     * @param base - The exponential base. Default 2 means emit at 1, 2, 4, 8, 16...
     */
    constructor(base = 2, id) {
        super(id ?? 'narrative-progressive');
        this.base = base;
    }
    onLoop(event) {
        if (this.shouldEmit(event.iteration)) {
            super.onLoop(event);
        }
        else {
            this.suppressedCount++;
        }
    }
    shouldEmit(iteration) {
        // Always emit iteration 1
        if (iteration === 1)
            return true;
        // Emit if iteration is a power of base
        let power = 1;
        while (power < iteration) {
            power *= this.base;
        }
        return power === iteration;
    }
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount() {
        return this.suppressedCount;
    }
    clear() {
        super.clear();
        this.suppressedCount = 0;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUHJvZ3Jlc3NpdmVOYXJyYXRpdmVGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL1Byb2dyZXNzaXZlTmFycmF0aXZlRmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBRUgsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFHcEUsTUFBTSxPQUFPLGdDQUFpQyxTQUFRLHFCQUFxQjtJQUN4RCxJQUFJLENBQVM7SUFDdEIsZUFBZSxHQUFHLENBQUMsQ0FBQztJQUU1Qjs7T0FFRztJQUNILFlBQVksSUFBSSxHQUFHLENBQUMsRUFBRSxFQUFXO1FBQy9CLEtBQUssQ0FBQyxFQUFFLElBQUksdUJBQXVCLENBQUMsQ0FBQztRQUNyQyxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztJQUNuQixDQUFDO0lBRVEsTUFBTSxDQUFDLEtBQW9CO1FBQ2xDLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztZQUNyQyxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3RCLENBQUM7YUFBTSxDQUFDO1lBQ04sSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1FBQ3pCLENBQUM7SUFDSCxDQUFDO0lBRU8sVUFBVSxDQUFDLFNBQWlCO1FBQ2xDLDBCQUEwQjtRQUMxQixJQUFJLFNBQVMsS0FBSyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDakMsdUNBQXVDO1FBQ3ZDLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztRQUNkLE9BQU8sS0FBSyxHQUFHLFNBQVMsRUFBRSxDQUFDO1lBQ3pCLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQ3JCLENBQUM7UUFDRCxPQUFPLEtBQUssS0FBSyxTQUFTLENBQUM7SUFDN0IsQ0FBQztJQUVELHVEQUF1RDtJQUN2RCxrQkFBa0I7UUFDaEIsT0FBTyxJQUFJLENBQUMsZUFBZSxDQUFDO0lBQzlCLENBQUM7SUFFUSxLQUFLO1FBQ1osS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2QsSUFBSSxDQUFDLGVBQWUsR0FBRyxDQUFDLENBQUM7SUFDM0IsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQcm9ncmVzc2l2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciDigJQgRXhwb25lbnRpYWxseSBkZWNyZWFzaW5nIGRldGFpbCBhcyBpdGVyYXRpb25zIGdyb3cuXG4gKlxuICogRW1pdHMgYXQgZXhwb25lbnRpYWxseSBpbmNyZWFzaW5nIGludGVydmFsczogMSwgMiwgNCwgOCwgMTYsIDMyLCAuLi5cbiAqIEdpdmVzIHJpY2ggZGV0YWlsIGZvciBlYXJseSBpdGVyYXRpb25zIGFuZCBwcm9ncmVzc2l2ZWx5IGxlc3MgYXMgdGhlIGxvb3AgY29udGludWVzLlxuICpcbiAqIEJlc3QgZm9yOiBDb252ZXJnZW5jZS1zdHlsZSBsb29wcyAoZ3JhZGllbnQgZGVzY2VudCwgaXRlcmF0aXZlIHJlZmluZW1lbnQpXG4gKiB3aGVyZSBlYXJseSBpdGVyYXRpb25zIGFyZSBtb3N0IGluZm9ybWF0aXZlLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBleGVjdXRvci5hdHRhY2hGbG93UmVjb3JkZXIobmV3IFByb2dyZXNzaXZlTmFycmF0aXZlRmxvd1JlY29yZGVyKCkpO1xuICogLy8gRW1pdHM6IHBhc3MgMSwgMiwgNCwgOCwgMTYsIDMyLCA2NCwgMTI4Li4uXG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9OYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93TG9vcEV2ZW50IH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgUHJvZ3Jlc3NpdmVOYXJyYXRpdmVGbG93UmVjb3JkZXIgZXh0ZW5kcyBOYXJyYXRpdmVGbG93UmVjb3JkZXIge1xuICBwcml2YXRlIHJlYWRvbmx5IGJhc2U6IG51bWJlcjtcbiAgcHJpdmF0ZSBzdXBwcmVzc2VkQ291bnQgPSAwO1xuXG4gIC8qKlxuICAgKiBAcGFyYW0gYmFzZSAtIFRoZSBleHBvbmVudGlhbCBiYXNlLiBEZWZhdWx0IDIgbWVhbnMgZW1pdCBhdCAxLCAyLCA0LCA4LCAxNi4uLlxuICAgKi9cbiAgY29uc3RydWN0b3IoYmFzZSA9IDIsIGlkPzogc3RyaW5nKSB7XG4gICAgc3VwZXIoaWQgPz8gJ25hcnJhdGl2ZS1wcm9ncmVzc2l2ZScpO1xuICAgIHRoaXMuYmFzZSA9IGJhc2U7XG4gIH1cblxuICBvdmVycmlkZSBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zaG91bGRFbWl0KGV2ZW50Lml0ZXJhdGlvbikpIHtcbiAgICAgIHN1cGVyLm9uTG9vcChldmVudCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc3VwcHJlc3NlZENvdW50Kys7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzaG91bGRFbWl0KGl0ZXJhdGlvbjogbnVtYmVyKTogYm9vbGVhbiB7XG4gICAgLy8gQWx3YXlzIGVtaXQgaXRlcmF0aW9uIDFcbiAgICBpZiAoaXRlcmF0aW9uID09PSAxKSByZXR1cm4gdHJ1ZTtcbiAgICAvLyBFbWl0IGlmIGl0ZXJhdGlvbiBpcyBhIHBvd2VyIG9mIGJhc2VcbiAgICBsZXQgcG93ZXIgPSAxO1xuICAgIHdoaWxlIChwb3dlciA8IGl0ZXJhdGlvbikge1xuICAgICAgcG93ZXIgKj0gdGhpcy5iYXNlO1xuICAgIH1cbiAgICByZXR1cm4gcG93ZXIgPT09IGl0ZXJhdGlvbjtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSBudW1iZXIgb2Ygc3VwcHJlc3NlZCBsb29wIHNlbnRlbmNlcy4gKi9cbiAgZ2V0U3VwcHJlc3NlZENvdW50KCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuc3VwcHJlc3NlZENvdW50O1xuICB9XG5cbiAgb3ZlcnJpZGUgY2xlYXIoKTogdm9pZCB7XG4gICAgc3VwZXIuY2xlYXIoKTtcbiAgICB0aGlzLnN1cHByZXNzZWRDb3VudCA9IDA7XG4gIH1cbn1cbiJdfQ==