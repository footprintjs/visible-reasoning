/**
 * MilestoneNarrativeFlowRecorder — Emits every Nth iteration (milestones only).
 *
 * Best for: High-iteration loops where you want regular progress markers
 * without caring about individual iterations.
 *
 * @example
 * ```typescript
 * // Emit every 10th iteration
 * executor.attachFlowRecorder(new MilestoneNarrativeFlowRecorder(10));
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class MilestoneNarrativeFlowRecorder extends NarrativeFlowRecorder {
    interval;
    alwaysEmitFirst;
    suppressedCount = 0;
    constructor(interval = 10, alwaysEmitFirst = true, id) {
        super(id ?? 'narrative-milestone');
        this.interval = interval;
        this.alwaysEmitFirst = alwaysEmitFirst;
    }
    onLoop(event) {
        if (this.alwaysEmitFirst && event.iteration === 1) {
            super.onLoop(event);
        }
        else if (event.iteration % this.interval === 0) {
            super.onLoop(event);
        }
        else {
            this.suppressedCount++;
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWlsZXN0b25lTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvbmFycmF0aXZlL3JlY29yZGVycy9NaWxlc3RvbmVOYXJyYXRpdmVGbG93UmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7O0dBV0c7QUFFSCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQUdwRSxNQUFNLE9BQU8sOEJBQStCLFNBQVEscUJBQXFCO0lBQ3RELFFBQVEsQ0FBUztJQUNqQixlQUFlLENBQVU7SUFDbEMsZUFBZSxHQUFHLENBQUMsQ0FBQztJQUU1QixZQUFZLFFBQVEsR0FBRyxFQUFFLEVBQUUsZUFBZSxHQUFHLElBQUksRUFBRSxFQUFXO1FBQzVELEtBQUssQ0FBQyxFQUFFLElBQUkscUJBQXFCLENBQUMsQ0FBQztRQUNuQyxJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztRQUN6QixJQUFJLENBQUMsZUFBZSxHQUFHLGVBQWUsQ0FBQztJQUN6QyxDQUFDO0lBRVEsTUFBTSxDQUFDLEtBQW9CO1FBQ2xDLElBQUksSUFBSSxDQUFDLGVBQWUsSUFBSSxLQUFLLENBQUMsU0FBUyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2xELEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdEIsQ0FBQzthQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsUUFBUSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2pELEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdEIsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7UUFDekIsQ0FBQztJQUNILENBQUM7SUFFRCx1REFBdUQ7SUFDdkQsa0JBQWtCO1FBQ2hCLE9BQU8sSUFBSSxDQUFDLGVBQWUsQ0FBQztJQUM5QixDQUFDO0lBRVEsS0FBSztRQUNaLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNkLElBQUksQ0FBQyxlQUFlLEdBQUcsQ0FBQyxDQUFDO0lBQzNCLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTWlsZXN0b25lTmFycmF0aXZlRmxvd1JlY29yZGVyIOKAlCBFbWl0cyBldmVyeSBOdGggaXRlcmF0aW9uIChtaWxlc3RvbmVzIG9ubHkpLlxuICpcbiAqIEJlc3QgZm9yOiBIaWdoLWl0ZXJhdGlvbiBsb29wcyB3aGVyZSB5b3Ugd2FudCByZWd1bGFyIHByb2dyZXNzIG1hcmtlcnNcbiAqIHdpdGhvdXQgY2FyaW5nIGFib3V0IGluZGl2aWR1YWwgaXRlcmF0aW9ucy5cbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHlwZXNjcmlwdFxuICogLy8gRW1pdCBldmVyeSAxMHRoIGl0ZXJhdGlvblxuICogZXhlY3V0b3IuYXR0YWNoRmxvd1JlY29yZGVyKG5ldyBNaWxlc3RvbmVOYXJyYXRpdmVGbG93UmVjb3JkZXIoMTApKTtcbiAqIGBgYFxuICovXG5cbmltcG9ydCB7IE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4uL05hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dMb29wRXZlbnQgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBNaWxlc3RvbmVOYXJyYXRpdmVGbG93UmVjb3JkZXIgZXh0ZW5kcyBOYXJyYXRpdmVGbG93UmVjb3JkZXIge1xuICBwcml2YXRlIHJlYWRvbmx5IGludGVydmFsOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgYWx3YXlzRW1pdEZpcnN0OiBib29sZWFuO1xuICBwcml2YXRlIHN1cHByZXNzZWRDb3VudCA9IDA7XG5cbiAgY29uc3RydWN0b3IoaW50ZXJ2YWwgPSAxMCwgYWx3YXlzRW1pdEZpcnN0ID0gdHJ1ZSwgaWQ/OiBzdHJpbmcpIHtcbiAgICBzdXBlcihpZCA/PyAnbmFycmF0aXZlLW1pbGVzdG9uZScpO1xuICAgIHRoaXMuaW50ZXJ2YWwgPSBpbnRlcnZhbDtcbiAgICB0aGlzLmFsd2F5c0VtaXRGaXJzdCA9IGFsd2F5c0VtaXRGaXJzdDtcbiAgfVxuXG4gIG92ZXJyaWRlIG9uTG9vcChldmVudDogRmxvd0xvb3BFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmFsd2F5c0VtaXRGaXJzdCAmJiBldmVudC5pdGVyYXRpb24gPT09IDEpIHtcbiAgICAgIHN1cGVyLm9uTG9vcChldmVudCk7XG4gICAgfSBlbHNlIGlmIChldmVudC5pdGVyYXRpb24gJSB0aGlzLmludGVydmFsID09PSAwKSB7XG4gICAgICBzdXBlci5vbkxvb3AoZXZlbnQpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnN1cHByZXNzZWRDb3VudCsrO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSBudW1iZXIgb2Ygc3VwcHJlc3NlZCBsb29wIHNlbnRlbmNlcy4gKi9cbiAgZ2V0U3VwcHJlc3NlZENvdW50KCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuc3VwcHJlc3NlZENvdW50O1xuICB9XG5cbiAgb3ZlcnJpZGUgY2xlYXIoKTogdm9pZCB7XG4gICAgc3VwZXIuY2xlYXIoKTtcbiAgICB0aGlzLnN1cHByZXNzZWRDb3VudCA9IDA7XG4gIH1cbn1cbiJdfQ==