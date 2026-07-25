/**
 * SeparateNarrativeFlowRecorder — Collects loop iterations in a separate channel.
 *
 * Keeps the main narrative clean (no loop sentences) while preserving full
 * iteration detail in a separate accessor for consumers who need it.
 *
 * Best for: UIs or reports where loop detail is in a collapsible section,
 * or LLM pipelines where loop context should be available but not in the main prompt.
 *
 * @example
 * ```typescript
 * const recorder = new SeparateNarrativeFlowRecorder();
 * executor.attachFlowRecorder(recorder);
 * await executor.run();
 *
 * const mainEntries = executor.getNarrativeEntries(); // No loop sentences
 * const loopDetail = recorder.getLoopSentences();     // All loop detail
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class SeparateNarrativeFlowRecorder extends NarrativeFlowRecorder {
    loopSentences = [];
    loopCounts = new Map();
    constructor(id) {
        super(id ?? 'narrative-separate');
    }
    onLoop(event) {
        // Don't call super — keep loops out of main narrative
        // Track count for summary
        const count = (this.loopCounts.get(event.target) ?? 0) + 1;
        this.loopCounts.set(event.target, count);
        // Store in separate channel
        if (event.description) {
            this.loopSentences.push(`On pass ${event.iteration}: ${event.description} again.`);
        }
        else {
            this.loopSentences.push(`On pass ${event.iteration} through ${event.target}.`);
        }
    }
    /** Returns all loop iteration sentences (the separate channel). */
    getLoopSentences() {
        return [...this.loopSentences];
    }
    /** Returns total loop count per target. */
    getLoopCounts() {
        return new Map(this.loopCounts);
    }
    clear() {
        super.clear();
        this.loopSentences = [];
        this.loopCounts.clear();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2VwYXJhdGVOYXJyYXRpdmVGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL1NlcGFyYXRlTmFycmF0aXZlRmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FrQkc7QUFFSCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQUdwRSxNQUFNLE9BQU8sNkJBQThCLFNBQVEscUJBQXFCO0lBQzlELGFBQWEsR0FBYSxFQUFFLENBQUM7SUFDN0IsVUFBVSxHQUF3QixJQUFJLEdBQUcsRUFBRSxDQUFDO0lBRXBELFlBQVksRUFBVztRQUNyQixLQUFLLENBQUMsRUFBRSxJQUFJLG9CQUFvQixDQUFDLENBQUM7SUFDcEMsQ0FBQztJQUVRLE1BQU0sQ0FBQyxLQUFvQjtRQUNsQyxzREFBc0Q7UUFFdEQsMEJBQTBCO1FBQzFCLE1BQU0sS0FBSyxHQUFHLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMzRCxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXpDLDRCQUE0QjtRQUM1QixJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssQ0FBQyxTQUFTLEtBQUssS0FBSyxDQUFDLFdBQVcsU0FBUyxDQUFDLENBQUM7UUFDckYsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssQ0FBQyxTQUFTLFlBQVksS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFDakYsQ0FBQztJQUNILENBQUM7SUFFRCxtRUFBbUU7SUFDbkUsZ0JBQWdCO1FBQ2QsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFFRCwyQ0FBMkM7SUFDM0MsYUFBYTtRQUNYLE9BQU8sSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLENBQUM7SUFFUSxLQUFLO1FBQ1osS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2QsSUFBSSxDQUFDLGFBQWEsR0FBRyxFQUFFLENBQUM7UUFDeEIsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUMxQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNlcGFyYXRlTmFycmF0aXZlRmxvd1JlY29yZGVyIOKAlCBDb2xsZWN0cyBsb29wIGl0ZXJhdGlvbnMgaW4gYSBzZXBhcmF0ZSBjaGFubmVsLlxuICpcbiAqIEtlZXBzIHRoZSBtYWluIG5hcnJhdGl2ZSBjbGVhbiAobm8gbG9vcCBzZW50ZW5jZXMpIHdoaWxlIHByZXNlcnZpbmcgZnVsbFxuICogaXRlcmF0aW9uIGRldGFpbCBpbiBhIHNlcGFyYXRlIGFjY2Vzc29yIGZvciBjb25zdW1lcnMgd2hvIG5lZWQgaXQuXG4gKlxuICogQmVzdCBmb3I6IFVJcyBvciByZXBvcnRzIHdoZXJlIGxvb3AgZGV0YWlsIGlzIGluIGEgY29sbGFwc2libGUgc2VjdGlvbixcbiAqIG9yIExMTSBwaXBlbGluZXMgd2hlcmUgbG9vcCBjb250ZXh0IHNob3VsZCBiZSBhdmFpbGFibGUgYnV0IG5vdCBpbiB0aGUgbWFpbiBwcm9tcHQuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGNvbnN0IHJlY29yZGVyID0gbmV3IFNlcGFyYXRlTmFycmF0aXZlRmxvd1JlY29yZGVyKCk7XG4gKiBleGVjdXRvci5hdHRhY2hGbG93UmVjb3JkZXIocmVjb3JkZXIpO1xuICogYXdhaXQgZXhlY3V0b3IucnVuKCk7XG4gKlxuICogY29uc3QgbWFpbkVudHJpZXMgPSBleGVjdXRvci5nZXROYXJyYXRpdmVFbnRyaWVzKCk7IC8vIE5vIGxvb3Agc2VudGVuY2VzXG4gKiBjb25zdCBsb29wRGV0YWlsID0gcmVjb3JkZXIuZ2V0TG9vcFNlbnRlbmNlcygpOyAgICAgLy8gQWxsIGxvb3AgZGV0YWlsXG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9OYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93TG9vcEV2ZW50IH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgU2VwYXJhdGVOYXJyYXRpdmVGbG93UmVjb3JkZXIgZXh0ZW5kcyBOYXJyYXRpdmVGbG93UmVjb3JkZXIge1xuICBwcml2YXRlIGxvb3BTZW50ZW5jZXM6IHN0cmluZ1tdID0gW107XG4gIHByaXZhdGUgbG9vcENvdW50czogTWFwPHN0cmluZywgbnVtYmVyPiA9IG5ldyBNYXAoKTtcblxuICBjb25zdHJ1Y3RvcihpZD86IHN0cmluZykge1xuICAgIHN1cGVyKGlkID8/ICduYXJyYXRpdmUtc2VwYXJhdGUnKTtcbiAgfVxuXG4gIG92ZXJyaWRlIG9uTG9vcChldmVudDogRmxvd0xvb3BFdmVudCk6IHZvaWQge1xuICAgIC8vIERvbid0IGNhbGwgc3VwZXIg4oCUIGtlZXAgbG9vcHMgb3V0IG9mIG1haW4gbmFycmF0aXZlXG5cbiAgICAvLyBUcmFjayBjb3VudCBmb3Igc3VtbWFyeVxuICAgIGNvbnN0IGNvdW50ID0gKHRoaXMubG9vcENvdW50cy5nZXQoZXZlbnQudGFyZ2V0KSA/PyAwKSArIDE7XG4gICAgdGhpcy5sb29wQ291bnRzLnNldChldmVudC50YXJnZXQsIGNvdW50KTtcblxuICAgIC8vIFN0b3JlIGluIHNlcGFyYXRlIGNoYW5uZWxcbiAgICBpZiAoZXZlbnQuZGVzY3JpcHRpb24pIHtcbiAgICAgIHRoaXMubG9vcFNlbnRlbmNlcy5wdXNoKGBPbiBwYXNzICR7ZXZlbnQuaXRlcmF0aW9ufTogJHtldmVudC5kZXNjcmlwdGlvbn0gYWdhaW4uYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9vcFNlbnRlbmNlcy5wdXNoKGBPbiBwYXNzICR7ZXZlbnQuaXRlcmF0aW9ufSB0aHJvdWdoICR7ZXZlbnQudGFyZ2V0fS5gKTtcbiAgICB9XG4gIH1cblxuICAvKiogUmV0dXJucyBhbGwgbG9vcCBpdGVyYXRpb24gc2VudGVuY2VzICh0aGUgc2VwYXJhdGUgY2hhbm5lbCkuICovXG4gIGdldExvb3BTZW50ZW5jZXMoKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBbLi4udGhpcy5sb29wU2VudGVuY2VzXTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRvdGFsIGxvb3AgY291bnQgcGVyIHRhcmdldC4gKi9cbiAgZ2V0TG9vcENvdW50cygpOiBNYXA8c3RyaW5nLCBudW1iZXI+IHtcbiAgICByZXR1cm4gbmV3IE1hcCh0aGlzLmxvb3BDb3VudHMpO1xuICB9XG5cbiAgb3ZlcnJpZGUgY2xlYXIoKTogdm9pZCB7XG4gICAgc3VwZXIuY2xlYXIoKTtcbiAgICB0aGlzLmxvb3BTZW50ZW5jZXMgPSBbXTtcbiAgICB0aGlzLmxvb3BDb3VudHMuY2xlYXIoKTtcbiAgfVxufVxuIl19