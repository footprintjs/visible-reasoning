/**
 * QualityRecorder — per-step quality scoring keyed by runtimeStageId.
 *
 * Collects quality scores during traversal (accumulate pattern).
 * After execution, use qualityTrace() to backtrack from any low-scoring step.
 *
 * Composes a `KeyedStore<QualityEntry>` for O(1) lookup and standard operations
 * (Convention 1 — one purpose per recorder):
 *   - **Translate**: `getByKey('call-llm#5')` — quality at this step
 *   - **Accumulate**: progressive quality up to slider position
 *   - **Aggregate**: overall pipeline quality score
 *
 * @example
 * ```typescript
 * const quality = new QualityRecorder((runtimeStageId, context) => {
 *   // Custom scoring function — return { score: 0.0–1.0, factors? }
 *   if (context.stageName.includes('llm')) return { score: 0.7, factors: ['llm stage'] };
 *   return { score: 1.0 };
 * });
 * executor.attachScopeRecorder(quality);
 * await executor.run();
 *
 * // Per-step score
 * quality.getByKey('call-llm#5');  // { score: 0.7, stageName: 'CallLLM', factors: [...] }
 *
 * // Overall quality
 * quality.getOverallScore();  // 0.85
 *
 * // Lowest-scoring step
 * quality.getLowest();  // { runtimeStageId: 'call-llm#5', entry: { score: 0.7, ... } }
 * ```
 */
import { KeyedStore } from './KeyedStore.js';
export class QualityRecorder {
    static _counter = 0;
    id;
    preferredOperation;
    /** 1:1 per-step storage (Convention 1 — composed, not inherited). */
    store = new KeyedStore();
    scoringFn;
    // Per-stage buffers (reset on each stageStart)
    currentRuntimeStageId = '';
    currentStageId = '';
    currentStageName = '';
    currentKeysRead = [];
    currentKeysWritten = [];
    constructor(scoringFn, options) {
        this.scoringFn = scoringFn;
        this.id = options?.id ?? `quality-${++QualityRecorder._counter}`;
        this.preferredOperation = options?.preferredOperation ?? 'accumulate';
    }
    onStageStart(event) {
        this.currentRuntimeStageId = event.runtimeStageId;
        this.currentStageId = event.stageId;
        this.currentStageName = event.stageName;
        this.currentKeysRead = [];
        this.currentKeysWritten = [];
    }
    onRead(event) {
        if (event.key)
            this.currentKeysRead.push(event.key);
    }
    onWrite(event) {
        this.currentKeysWritten.push(event.key);
    }
    onStageEnd(event) {
        const { score, factors } = this.scoringFn(this.currentRuntimeStageId, {
            stageName: this.currentStageName,
            stageId: this.currentStageId,
            keysRead: this.currentKeysRead,
            keysWritten: this.currentKeysWritten,
            duration: event.duration,
        });
        this.store.set(this.currentRuntimeStageId, {
            stageName: this.currentStageName,
            stageId: this.currentStageId,
            score: Math.max(0, Math.min(1, score)),
            factors: factors ?? [],
            keysRead: [...this.currentKeysRead],
            keysWritten: [...this.currentKeysWritten],
        });
    }
    // ── Per-step query API (delegates to the composed store) ───────────────
    /** Translate: quality entry for a specific runtimeStageId. */
    getByKey(runtimeStageId) {
        return this.store.get(runtimeStageId);
    }
    /** All per-step quality entries as a read-only Map (insertion-ordered). */
    getMap() {
        return this.store.getMap();
    }
    /** All per-step quality entries (insertion-ordered). */
    values() {
        return this.store.values();
    }
    /** Number of scored steps. */
    get size() {
        return this.store.size;
    }
    /** Aggregate: reduce ALL scored steps to a single value. */
    aggregate(fn, initial) {
        return this.store.aggregate(fn, initial);
    }
    /** Accumulate: reduce scored steps up to a slider position. */
    accumulate(fn, initial, keys) {
        return this.store.accumulate(fn, initial, keys);
    }
    /** Overall quality score — average of all step scores. */
    getOverallScore() {
        if (this.store.size === 0)
            return 1.0;
        const total = this.store.aggregate((sum, e) => sum + e.score, 0);
        return total / this.store.size;
    }
    /** Find the lowest-scoring step. */
    getLowest() {
        let lowest;
        for (const [key, entry] of this.store.getMap()) {
            if (!lowest || entry.score < lowest.entry.score) {
                lowest = { runtimeStageId: key, entry };
            }
        }
        return lowest;
    }
    /** Progressive quality score up to a slider position. */
    getScoreUpTo(visibleKeys) {
        let count = 0;
        const total = this.store.accumulate((sum, e) => {
            count++;
            return sum + e.score;
        }, 0, visibleKeys);
        return count === 0 ? 1.0 : total / count;
    }
    toSnapshot() {
        const steps = {};
        for (const [key, value] of this.store.getMap()) {
            steps[key] = value;
        }
        return {
            name: 'Quality',
            description: 'Quality scores per execution step with backtracking support',
            preferredOperation: this.preferredOperation,
            data: {
                numericField: 'score',
                overallScore: this.getOverallScore(),
                lowestStep: this.getLowest()?.runtimeStageId,
                steps,
            },
        };
    }
    clear() {
        this.store.clear();
        this.currentRuntimeStageId = '';
        this.currentStageId = '';
        this.currentStageName = '';
        this.currentKeysRead = [];
        this.currentKeysWritten = [];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUXVhbGl0eVJlY29yZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9yZWNvcmRlci9RdWFsaXR5UmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0ErQkc7QUFHSCxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUEyQzdDLE1BQU0sT0FBTyxlQUFlO0lBQ2xCLE1BQU0sQ0FBQyxRQUFRLEdBQUcsQ0FBQyxDQUFDO0lBRW5CLEVBQUUsQ0FBUztJQUNYLGtCQUFrQixDQUFvQjtJQUMvQyxxRUFBcUU7SUFDcEQsS0FBSyxHQUFHLElBQUksVUFBVSxFQUFnQixDQUFDO0lBQ3ZDLFNBQVMsQ0FBbUI7SUFFN0MsK0NBQStDO0lBQ3ZDLHFCQUFxQixHQUFHLEVBQUUsQ0FBQztJQUMzQixjQUFjLEdBQUcsRUFBRSxDQUFDO0lBQ3BCLGdCQUFnQixHQUFHLEVBQUUsQ0FBQztJQUN0QixlQUFlLEdBQWEsRUFBRSxDQUFDO0lBQy9CLGtCQUFrQixHQUFhLEVBQUUsQ0FBQztJQUUxQyxZQUFZLFNBQTJCLEVBQUUsT0FBZ0M7UUFDdkUsSUFBSSxDQUFDLFNBQVMsR0FBRyxTQUFTLENBQUM7UUFDM0IsSUFBSSxDQUFDLEVBQUUsR0FBRyxPQUFPLEVBQUUsRUFBRSxJQUFJLFdBQVcsRUFBRSxlQUFlLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDakUsSUFBSSxDQUFDLGtCQUFrQixHQUFHLE9BQU8sRUFBRSxrQkFBa0IsSUFBSSxZQUFZLENBQUM7SUFDeEUsQ0FBQztJQUVELFlBQVksQ0FBQyxLQUFpQjtRQUM1QixJQUFJLENBQUMscUJBQXFCLEdBQUcsS0FBSyxDQUFDLGNBQWMsQ0FBQztRQUNsRCxJQUFJLENBQUMsY0FBYyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUM7UUFDcEMsSUFBSSxDQUFDLGdCQUFnQixHQUFHLEtBQUssQ0FBQyxTQUFTLENBQUM7UUFDeEMsSUFBSSxDQUFDLGVBQWUsR0FBRyxFQUFFLENBQUM7UUFDMUIsSUFBSSxDQUFDLGtCQUFrQixHQUFHLEVBQUUsQ0FBQztJQUMvQixDQUFDO0lBRUQsTUFBTSxDQUFDLEtBQWdCO1FBQ3JCLElBQUksS0FBSyxDQUFDLEdBQUc7WUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDdEQsQ0FBQztJQUVELE9BQU8sQ0FBQyxLQUFpQjtRQUN2QixJQUFJLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxQyxDQUFDO0lBRUQsVUFBVSxDQUFDLEtBQWlCO1FBQzFCLE1BQU0sRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMscUJBQXFCLEVBQUU7WUFDcEUsU0FBUyxFQUFFLElBQUksQ0FBQyxnQkFBZ0I7WUFDaEMsT0FBTyxFQUFFLElBQUksQ0FBQyxjQUFjO1lBQzVCLFFBQVEsRUFBRSxJQUFJLENBQUMsZUFBZTtZQUM5QixXQUFXLEVBQUUsSUFBSSxDQUFDLGtCQUFrQjtZQUNwQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7U0FDekIsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLHFCQUFxQixFQUFFO1lBQ3pDLFNBQVMsRUFBRSxJQUFJLENBQUMsZ0JBQWdCO1lBQ2hDLE9BQU8sRUFBRSxJQUFJLENBQUMsY0FBYztZQUM1QixLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDdEMsT0FBTyxFQUFFLE9BQU8sSUFBSSxFQUFFO1lBQ3RCLFFBQVEsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQztZQUNuQyxXQUFXLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxrQkFBa0IsQ0FBQztTQUMxQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsMEVBQTBFO0lBRTFFLDhEQUE4RDtJQUM5RCxRQUFRLENBQUMsY0FBc0I7UUFDN0IsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBRUQsMkVBQTJFO0lBQzNFLE1BQU07UUFDSixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUM7SUFDN0IsQ0FBQztJQUVELHdEQUF3RDtJQUN4RCxNQUFNO1FBQ0osT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDO0lBQzdCLENBQUM7SUFFRCw4QkFBOEI7SUFDOUIsSUFBSSxJQUFJO1FBQ04sT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQztJQUN6QixDQUFDO0lBRUQsNERBQTREO0lBQzVELFNBQVMsQ0FBSSxFQUFtRCxFQUFFLE9BQVU7UUFDMUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDM0MsQ0FBQztJQUVELCtEQUErRDtJQUMvRCxVQUFVLENBQUksRUFBbUQsRUFBRSxPQUFVLEVBQUUsSUFBMEI7UUFDdkcsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxFQUFFLEVBQUUsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ2xELENBQUM7SUFFRCwwREFBMEQ7SUFDMUQsZUFBZTtRQUNiLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLEtBQUssQ0FBQztZQUFFLE9BQU8sR0FBRyxDQUFDO1FBQ3RDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDakUsT0FBTyxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUM7SUFDakMsQ0FBQztJQUVELG9DQUFvQztJQUNwQyxTQUFTO1FBQ1AsSUFBSSxNQUFtRSxDQUFDO1FBQ3hFLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUM7WUFDL0MsSUFBSSxDQUFDLE1BQU0sSUFBSSxLQUFLLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7Z0JBQ2hELE1BQU0sR0FBRyxFQUFFLGNBQWMsRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFLENBQUM7WUFDMUMsQ0FBQztRQUNILENBQUM7UUFDRCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBRUQseURBQXlEO0lBQ3pELFlBQVksQ0FBQyxXQUFnQztRQUMzQyxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7UUFDZCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FDakMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUU7WUFDVCxLQUFLLEVBQUUsQ0FBQztZQUNSLE9BQU8sR0FBRyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUM7UUFDdkIsQ0FBQyxFQUNELENBQUMsRUFDRCxXQUFXLENBQ1osQ0FBQztRQUNGLE9BQU8sS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0lBQzNDLENBQUM7SUFFRCxVQUFVO1FBQ1IsTUFBTSxLQUFLLEdBQTRCLEVBQUUsQ0FBQztRQUMxQyxLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDO1lBQy9DLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxLQUFLLENBQUM7UUFDckIsQ0FBQztRQUNELE9BQU87WUFDTCxJQUFJLEVBQUUsU0FBUztZQUNmLFdBQVcsRUFBRSw2REFBNkQ7WUFDMUUsa0JBQWtCLEVBQUUsSUFBSSxDQUFDLGtCQUFrQjtZQUMzQyxJQUFJLEVBQUU7Z0JBQ0osWUFBWSxFQUFFLE9BQU87Z0JBQ3JCLFlBQVksRUFBRSxJQUFJLENBQUMsZUFBZSxFQUFFO2dCQUNwQyxVQUFVLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRSxFQUFFLGNBQWM7Z0JBQzVDLEtBQUs7YUFDTjtTQUNGLENBQUM7SUFDSixDQUFDO0lBRUQsS0FBSztRQUNILElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDbkIsSUFBSSxDQUFDLHFCQUFxQixHQUFHLEVBQUUsQ0FBQztRQUNoQyxJQUFJLENBQUMsY0FBYyxHQUFHLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsZ0JBQWdCLEdBQUcsRUFBRSxDQUFDO1FBQzNCLElBQUksQ0FBQyxlQUFlLEdBQUcsRUFBRSxDQUFDO1FBQzFCLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxFQUFFLENBQUM7SUFDL0IsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUXVhbGl0eVJlY29yZGVyIOKAlCBwZXItc3RlcCBxdWFsaXR5IHNjb3Jpbmcga2V5ZWQgYnkgcnVudGltZVN0YWdlSWQuXG4gKlxuICogQ29sbGVjdHMgcXVhbGl0eSBzY29yZXMgZHVyaW5nIHRyYXZlcnNhbCAoYWNjdW11bGF0ZSBwYXR0ZXJuKS5cbiAqIEFmdGVyIGV4ZWN1dGlvbiwgdXNlIHF1YWxpdHlUcmFjZSgpIHRvIGJhY2t0cmFjayBmcm9tIGFueSBsb3ctc2NvcmluZyBzdGVwLlxuICpcbiAqIENvbXBvc2VzIGEgYEtleWVkU3RvcmU8UXVhbGl0eUVudHJ5PmAgZm9yIE8oMSkgbG9va3VwIGFuZCBzdGFuZGFyZCBvcGVyYXRpb25zXG4gKiAoQ29udmVudGlvbiAxIOKAlCBvbmUgcHVycG9zZSBwZXIgcmVjb3JkZXIpOlxuICogICAtICoqVHJhbnNsYXRlKio6IGBnZXRCeUtleSgnY2FsbC1sbG0jNScpYCDigJQgcXVhbGl0eSBhdCB0aGlzIHN0ZXBcbiAqICAgLSAqKkFjY3VtdWxhdGUqKjogcHJvZ3Jlc3NpdmUgcXVhbGl0eSB1cCB0byBzbGlkZXIgcG9zaXRpb25cbiAqICAgLSAqKkFnZ3JlZ2F0ZSoqOiBvdmVyYWxsIHBpcGVsaW5lIHF1YWxpdHkgc2NvcmVcbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHlwZXNjcmlwdFxuICogY29uc3QgcXVhbGl0eSA9IG5ldyBRdWFsaXR5UmVjb3JkZXIoKHJ1bnRpbWVTdGFnZUlkLCBjb250ZXh0KSA9PiB7XG4gKiAgIC8vIEN1c3RvbSBzY29yaW5nIGZ1bmN0aW9uIOKAlCByZXR1cm4geyBzY29yZTogMC4w4oCTMS4wLCBmYWN0b3JzPyB9XG4gKiAgIGlmIChjb250ZXh0LnN0YWdlTmFtZS5pbmNsdWRlcygnbGxtJykpIHJldHVybiB7IHNjb3JlOiAwLjcsIGZhY3RvcnM6IFsnbGxtIHN0YWdlJ10gfTtcbiAqICAgcmV0dXJuIHsgc2NvcmU6IDEuMCB9O1xuICogfSk7XG4gKiBleGVjdXRvci5hdHRhY2hTY29wZVJlY29yZGVyKHF1YWxpdHkpO1xuICogYXdhaXQgZXhlY3V0b3IucnVuKCk7XG4gKlxuICogLy8gUGVyLXN0ZXAgc2NvcmVcbiAqIHF1YWxpdHkuZ2V0QnlLZXkoJ2NhbGwtbGxtIzUnKTsgIC8vIHsgc2NvcmU6IDAuNywgc3RhZ2VOYW1lOiAnQ2FsbExMTScsIGZhY3RvcnM6IFsuLi5dIH1cbiAqXG4gKiAvLyBPdmVyYWxsIHF1YWxpdHlcbiAqIHF1YWxpdHkuZ2V0T3ZlcmFsbFNjb3JlKCk7ICAvLyAwLjg1XG4gKlxuICogLy8gTG93ZXN0LXNjb3Jpbmcgc3RlcFxuICogcXVhbGl0eS5nZXRMb3dlc3QoKTsgIC8vIHsgcnVudGltZVN0YWdlSWQ6ICdjYWxsLWxsbSM1JywgZW50cnk6IHsgc2NvcmU6IDAuNywgLi4uIH0gfVxuICogYGBgXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZWFkRXZlbnQsIFNjb3BlUmVjb3JkZXIsIFN0YWdlRXZlbnQsIFdyaXRlRXZlbnQgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBLZXllZFN0b3JlIH0gZnJvbSAnLi9LZXllZFN0b3JlLmpzJztcbmltcG9ydCB0eXBlIHsgUmVjb3JkZXJPcGVyYXRpb24gfSBmcm9tICcuL1JlY29yZGVyT3BlcmF0aW9uLmpzJztcblxuLyoqIFBlci1zdGVwIHF1YWxpdHkgZGF0YSBzdG9yZWQgYnkgUXVhbGl0eVJlY29yZGVyLiAqL1xuZXhwb3J0IGludGVyZmFjZSBRdWFsaXR5RW50cnkge1xuICAvKiogSHVtYW4tcmVhZGFibGUgc3RhZ2UgbmFtZS4gKi9cbiAgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIC8qKiBTdGFibGUgc3RhZ2UgaWRlbnRpZmllci4gKi9cbiAgc3RhZ2VJZDogc3RyaW5nO1xuICAvKiogUXVhbGl0eSBzY29yZSBmb3IgdGhpcyBzdGVwICgwLjAgPSB3b3JzdCwgMS4wID0gYmVzdCkuICovXG4gIHNjb3JlOiBudW1iZXI7XG4gIC8qKiBXaGF0IGNvbnRyaWJ1dGVkIHRvIHRoaXMgc2NvcmUuICovXG4gIGZhY3RvcnM6IHN0cmluZ1tdO1xuICAvKiogS2V5cyByZWFkIGR1cmluZyB0aGlzIHN0ZXAgKGZvciBiYWNrdHJhY2tpbmcpLiAqL1xuICBrZXlzUmVhZDogc3RyaW5nW107XG4gIC8qKiBLZXlzIHdyaXR0ZW4gZHVyaW5nIHRoaXMgc3RlcCAoZm9yIGJhY2t0cmFja2luZykuICovXG4gIGtleXNXcml0dGVuOiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBTY29yaW5nIGZ1bmN0aW9uIGNhbGxlZCBhdCB0aGUgZW5kIG9mIGVhY2ggc3RhZ2UuXG4gKiBSZWNlaXZlcyB0aGUgcnVudGltZVN0YWdlSWQsIHN0YWdlIGV2ZW50LCBhbmQgYSBzdW1tYXJ5IG9mIHJlYWRzL3dyaXRlcy5cbiAqIFJldHVybiBhIHNjb3JlICgwLjDigJMxLjApIGFuZCBvcHRpb25hbCBmYWN0b3JzIGV4cGxhaW5pbmcgdGhlIHNjb3JlLlxuICovXG5leHBvcnQgdHlwZSBRdWFsaXR5U2NvcmluZ0ZuID0gKFxuICBydW50aW1lU3RhZ2VJZDogc3RyaW5nLFxuICBjb250ZXh0OiB7XG4gICAgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gICAgc3RhZ2VJZDogc3RyaW5nO1xuICAgIGtleXNSZWFkOiBzdHJpbmdbXTtcbiAgICBrZXlzV3JpdHRlbjogc3RyaW5nW107XG4gICAgZHVyYXRpb24/OiBudW1iZXI7XG4gIH0sXG4pID0+IHsgc2NvcmU6IG51bWJlcjsgZmFjdG9ycz86IHN0cmluZ1tdIH07XG5cbi8qKiBPcHRpb25zIGZvciBRdWFsaXR5UmVjb3JkZXIuICovXG5leHBvcnQgaW50ZXJmYWNlIFF1YWxpdHlSZWNvcmRlck9wdGlvbnMge1xuICAvKiogU2NvcGVSZWNvcmRlciBJRC4gRGVmYXVsdHMgdG8gYXV0by1pbmNyZW1lbnQuICovXG4gIGlkPzogc3RyaW5nO1xuICAvKiogUHJlZmVycmVkIFVJIG9wZXJhdGlvbi4gRGVmYXVsdHMgdG8gJ2FjY3VtdWxhdGUnIChwcm9ncmVzc2l2ZSBxdWFsaXR5KS4gKi9cbiAgcHJlZmVycmVkT3BlcmF0aW9uPzogUmVjb3JkZXJPcGVyYXRpb247XG59XG5cbmV4cG9ydCBjbGFzcyBRdWFsaXR5UmVjb3JkZXIgaW1wbGVtZW50cyBTY29wZVJlY29yZGVyIHtcbiAgcHJpdmF0ZSBzdGF0aWMgX2NvdW50ZXIgPSAwO1xuXG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByZWZlcnJlZE9wZXJhdGlvbjogUmVjb3JkZXJPcGVyYXRpb247XG4gIC8qKiAxOjEgcGVyLXN0ZXAgc3RvcmFnZSAoQ29udmVudGlvbiAxIOKAlCBjb21wb3NlZCwgbm90IGluaGVyaXRlZCkuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgc3RvcmUgPSBuZXcgS2V5ZWRTdG9yZTxRdWFsaXR5RW50cnk+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2NvcmluZ0ZuOiBRdWFsaXR5U2NvcmluZ0ZuO1xuXG4gIC8vIFBlci1zdGFnZSBidWZmZXJzIChyZXNldCBvbiBlYWNoIHN0YWdlU3RhcnQpXG4gIHByaXZhdGUgY3VycmVudFJ1bnRpbWVTdGFnZUlkID0gJyc7XG4gIHByaXZhdGUgY3VycmVudFN0YWdlSWQgPSAnJztcbiAgcHJpdmF0ZSBjdXJyZW50U3RhZ2VOYW1lID0gJyc7XG4gIHByaXZhdGUgY3VycmVudEtleXNSZWFkOiBzdHJpbmdbXSA9IFtdO1xuICBwcml2YXRlIGN1cnJlbnRLZXlzV3JpdHRlbjogc3RyaW5nW10gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihzY29yaW5nRm46IFF1YWxpdHlTY29yaW5nRm4sIG9wdGlvbnM/OiBRdWFsaXR5UmVjb3JkZXJPcHRpb25zKSB7XG4gICAgdGhpcy5zY29yaW5nRm4gPSBzY29yaW5nRm47XG4gICAgdGhpcy5pZCA9IG9wdGlvbnM/LmlkID8/IGBxdWFsaXR5LSR7KytRdWFsaXR5UmVjb3JkZXIuX2NvdW50ZXJ9YDtcbiAgICB0aGlzLnByZWZlcnJlZE9wZXJhdGlvbiA9IG9wdGlvbnM/LnByZWZlcnJlZE9wZXJhdGlvbiA/PyAnYWNjdW11bGF0ZSc7XG4gIH1cblxuICBvblN0YWdlU3RhcnQoZXZlbnQ6IFN0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRSdW50aW1lU3RhZ2VJZCA9IGV2ZW50LnJ1bnRpbWVTdGFnZUlkO1xuICAgIHRoaXMuY3VycmVudFN0YWdlSWQgPSBldmVudC5zdGFnZUlkO1xuICAgIHRoaXMuY3VycmVudFN0YWdlTmFtZSA9IGV2ZW50LnN0YWdlTmFtZTtcbiAgICB0aGlzLmN1cnJlbnRLZXlzUmVhZCA9IFtdO1xuICAgIHRoaXMuY3VycmVudEtleXNXcml0dGVuID0gW107XG4gIH1cblxuICBvblJlYWQoZXZlbnQ6IFJlYWRFdmVudCk6IHZvaWQge1xuICAgIGlmIChldmVudC5rZXkpIHRoaXMuY3VycmVudEtleXNSZWFkLnB1c2goZXZlbnQua2V5KTtcbiAgfVxuXG4gIG9uV3JpdGUoZXZlbnQ6IFdyaXRlRXZlbnQpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRLZXlzV3JpdHRlbi5wdXNoKGV2ZW50LmtleSk7XG4gIH1cblxuICBvblN0YWdlRW5kKGV2ZW50OiBTdGFnZUV2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgeyBzY29yZSwgZmFjdG9ycyB9ID0gdGhpcy5zY29yaW5nRm4odGhpcy5jdXJyZW50UnVudGltZVN0YWdlSWQsIHtcbiAgICAgIHN0YWdlTmFtZTogdGhpcy5jdXJyZW50U3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogdGhpcy5jdXJyZW50U3RhZ2VJZCxcbiAgICAgIGtleXNSZWFkOiB0aGlzLmN1cnJlbnRLZXlzUmVhZCxcbiAgICAgIGtleXNXcml0dGVuOiB0aGlzLmN1cnJlbnRLZXlzV3JpdHRlbixcbiAgICAgIGR1cmF0aW9uOiBldmVudC5kdXJhdGlvbixcbiAgICB9KTtcblxuICAgIHRoaXMuc3RvcmUuc2V0KHRoaXMuY3VycmVudFJ1bnRpbWVTdGFnZUlkLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuY3VycmVudFN0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IHRoaXMuY3VycmVudFN0YWdlSWQsXG4gICAgICBzY29yZTogTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc2NvcmUpKSxcbiAgICAgIGZhY3RvcnM6IGZhY3RvcnMgPz8gW10sXG4gICAgICBrZXlzUmVhZDogWy4uLnRoaXMuY3VycmVudEtleXNSZWFkXSxcbiAgICAgIGtleXNXcml0dGVuOiBbLi4udGhpcy5jdXJyZW50S2V5c1dyaXR0ZW5dLFxuICAgIH0pO1xuICB9XG5cbiAgLy8g4pSA4pSAIFBlci1zdGVwIHF1ZXJ5IEFQSSAoZGVsZWdhdGVzIHRvIHRoZSBjb21wb3NlZCBzdG9yZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIFRyYW5zbGF0ZTogcXVhbGl0eSBlbnRyeSBmb3IgYSBzcGVjaWZpYyBydW50aW1lU3RhZ2VJZC4gKi9cbiAgZ2V0QnlLZXkocnVudGltZVN0YWdlSWQ6IHN0cmluZyk6IFF1YWxpdHlFbnRyeSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0KHJ1bnRpbWVTdGFnZUlkKTtcbiAgfVxuXG4gIC8qKiBBbGwgcGVyLXN0ZXAgcXVhbGl0eSBlbnRyaWVzIGFzIGEgcmVhZC1vbmx5IE1hcCAoaW5zZXJ0aW9uLW9yZGVyZWQpLiAqL1xuICBnZXRNYXAoKTogUmVhZG9ubHlNYXA8c3RyaW5nLCBRdWFsaXR5RW50cnk+IHtcbiAgICByZXR1cm4gdGhpcy5zdG9yZS5nZXRNYXAoKTtcbiAgfVxuXG4gIC8qKiBBbGwgcGVyLXN0ZXAgcXVhbGl0eSBlbnRyaWVzIChpbnNlcnRpb24tb3JkZXJlZCkuICovXG4gIHZhbHVlcygpOiBRdWFsaXR5RW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUudmFsdWVzKCk7XG4gIH1cblxuICAvKiogTnVtYmVyIG9mIHNjb3JlZCBzdGVwcy4gKi9cbiAgZ2V0IHNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5zdG9yZS5zaXplO1xuICB9XG5cbiAgLyoqIEFnZ3JlZ2F0ZTogcmVkdWNlIEFMTCBzY29yZWQgc3RlcHMgdG8gYSBzaW5nbGUgdmFsdWUuICovXG4gIGFnZ3JlZ2F0ZTxSPihmbjogKGFjYzogUiwgZW50cnk6IFF1YWxpdHlFbnRyeSwga2V5OiBzdHJpbmcpID0+IFIsIGluaXRpYWw6IFIpOiBSIHtcbiAgICByZXR1cm4gdGhpcy5zdG9yZS5hZ2dyZWdhdGUoZm4sIGluaXRpYWwpO1xuICB9XG5cbiAgLyoqIEFjY3VtdWxhdGU6IHJlZHVjZSBzY29yZWQgc3RlcHMgdXAgdG8gYSBzbGlkZXIgcG9zaXRpb24uICovXG4gIGFjY3VtdWxhdGU8Uj4oZm46IChhY2M6IFIsIGVudHJ5OiBRdWFsaXR5RW50cnksIGtleTogc3RyaW5nKSA9PiBSLCBpbml0aWFsOiBSLCBrZXlzPzogUmVhZG9ubHlTZXQ8c3RyaW5nPik6IFIge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmFjY3VtdWxhdGUoZm4sIGluaXRpYWwsIGtleXMpO1xuICB9XG5cbiAgLyoqIE92ZXJhbGwgcXVhbGl0eSBzY29yZSDigJQgYXZlcmFnZSBvZiBhbGwgc3RlcCBzY29yZXMuICovXG4gIGdldE92ZXJhbGxTY29yZSgpOiBudW1iZXIge1xuICAgIGlmICh0aGlzLnN0b3JlLnNpemUgPT09IDApIHJldHVybiAxLjA7XG4gICAgY29uc3QgdG90YWwgPSB0aGlzLnN0b3JlLmFnZ3JlZ2F0ZSgoc3VtLCBlKSA9PiBzdW0gKyBlLnNjb3JlLCAwKTtcbiAgICByZXR1cm4gdG90YWwgLyB0aGlzLnN0b3JlLnNpemU7XG4gIH1cblxuICAvKiogRmluZCB0aGUgbG93ZXN0LXNjb3Jpbmcgc3RlcC4gKi9cbiAgZ2V0TG93ZXN0KCk6IHsgcnVudGltZVN0YWdlSWQ6IHN0cmluZzsgZW50cnk6IFF1YWxpdHlFbnRyeSB9IHwgdW5kZWZpbmVkIHtcbiAgICBsZXQgbG93ZXN0OiB7IHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmc7IGVudHJ5OiBRdWFsaXR5RW50cnkgfSB8IHVuZGVmaW5lZDtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiB0aGlzLnN0b3JlLmdldE1hcCgpKSB7XG4gICAgICBpZiAoIWxvd2VzdCB8fCBlbnRyeS5zY29yZSA8IGxvd2VzdC5lbnRyeS5zY29yZSkge1xuICAgICAgICBsb3dlc3QgPSB7IHJ1bnRpbWVTdGFnZUlkOiBrZXksIGVudHJ5IH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBsb3dlc3Q7XG4gIH1cblxuICAvKiogUHJvZ3Jlc3NpdmUgcXVhbGl0eSBzY29yZSB1cCB0byBhIHNsaWRlciBwb3NpdGlvbi4gKi9cbiAgZ2V0U2NvcmVVcFRvKHZpc2libGVLZXlzOiBSZWFkb25seVNldDxzdHJpbmc+KTogbnVtYmVyIHtcbiAgICBsZXQgY291bnQgPSAwO1xuICAgIGNvbnN0IHRvdGFsID0gdGhpcy5zdG9yZS5hY2N1bXVsYXRlKFxuICAgICAgKHN1bSwgZSkgPT4ge1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICByZXR1cm4gc3VtICsgZS5zY29yZTtcbiAgICAgIH0sXG4gICAgICAwLFxuICAgICAgdmlzaWJsZUtleXMsXG4gICAgKTtcbiAgICByZXR1cm4gY291bnQgPT09IDAgPyAxLjAgOiB0b3RhbCAvIGNvdW50O1xuICB9XG5cbiAgdG9TbmFwc2hvdCgpIHtcbiAgICBjb25zdCBzdGVwczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiB0aGlzLnN0b3JlLmdldE1hcCgpKSB7XG4gICAgICBzdGVwc1trZXldID0gdmFsdWU7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnUXVhbGl0eScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1F1YWxpdHkgc2NvcmVzIHBlciBleGVjdXRpb24gc3RlcCB3aXRoIGJhY2t0cmFja2luZyBzdXBwb3J0JyxcbiAgICAgIHByZWZlcnJlZE9wZXJhdGlvbjogdGhpcy5wcmVmZXJyZWRPcGVyYXRpb24sXG4gICAgICBkYXRhOiB7XG4gICAgICAgIG51bWVyaWNGaWVsZDogJ3Njb3JlJyxcbiAgICAgICAgb3ZlcmFsbFNjb3JlOiB0aGlzLmdldE92ZXJhbGxTY29yZSgpLFxuICAgICAgICBsb3dlc3RTdGVwOiB0aGlzLmdldExvd2VzdCgpPy5ydW50aW1lU3RhZ2VJZCxcbiAgICAgICAgc3RlcHMsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3JlLmNsZWFyKCk7XG4gICAgdGhpcy5jdXJyZW50UnVudGltZVN0YWdlSWQgPSAnJztcbiAgICB0aGlzLmN1cnJlbnRTdGFnZUlkID0gJyc7XG4gICAgdGhpcy5jdXJyZW50U3RhZ2VOYW1lID0gJyc7XG4gICAgdGhpcy5jdXJyZW50S2V5c1JlYWQgPSBbXTtcbiAgICB0aGlzLmN1cnJlbnRLZXlzV3JpdHRlbiA9IFtdO1xuICB9XG59XG4iXX0=