/**
 * CompositeRecorder — fan-out a single recorder attachment to multiple child recorders.
 *
 * Implements both ScopeRecorder (scope data ops) and FlowRecorder (control flow events)
 * so it works with both `executor.attachScopeRecorder()` and `executor.attachFlowRecorder()`.
 *
 * The composite has a single ID for idempotent attach/detach. Child recorders
 * keep their own IDs internally but are not individually visible to the executor.
 *
 * Domain libraries (e.g., agentfootprint) use this to bundle multiple recorders
 * into a single preset — the consumer calls one function, gets full observability.
 *
 * @example
 * ```typescript
 * import { CompositeRecorder, MetricRecorder, DebugRecorder } from 'footprintjs';
 *
 * // Bundle metrics + debug into a single recorder
 * const observability = new CompositeRecorder('observability', [
 *   new MetricRecorder({ stageFilter: (name) => name === 'CallLLM' }),
 *   new DebugRecorder({ verbosity: 'minimal' }),
 * ]);
 *
 * executor.attachScopeRecorder(observability);
 *
 * // Access child recorders by type
 * const metrics = observability.get(MetricRecorder);
 * metrics?.getMetrics(); // timing data
 * ```
 *
 * @example
 * ```typescript
 * // Domain library preset (e.g., agentfootprint)
 * export function agentObservability(options?: AgentObservabilityOptions) {
 *   return new CompositeRecorder('agent-observability', [
 *     new MetricRecorder(options?.stageFilter ? { stageFilter: options.stageFilter } : undefined),
 *     new TokenRecorder(),
 *     new ToolUsageRecorder(),
 *   ]);
 * }
 *
 * // Consumer
 * executor.attachScopeRecorder(agentObservability());
 * ```
 */
export class CompositeRecorder {
    id;
    children;
    constructor(id, children) {
        this.id = id;
        this.children = [...children];
    }
    // ── Child access ──────────────────────────────────────────────────────
    /**
     * Get a child recorder by class type.
     *
     * @example
     * ```typescript
     * const metrics = composite.get(MetricRecorder);
     * ```
     */
    get(type) {
        return this.children.find((c) => c instanceof type);
    }
    /** Get all child recorders. */
    getChildren() {
        return this.children;
    }
    // ── Scope ScopeRecorder hooks (fan-out to children that implement ScopeRecorder) ─
    onRead(event) {
        for (const c of this.children)
            if (c.onRead)
                c.onRead(event);
    }
    onWrite(event) {
        for (const c of this.children)
            if (c.onWrite)
                c.onWrite(event);
    }
    onCommit(event) {
        for (const c of this.children)
            if (c.onCommit)
                c.onCommit(event);
    }
    onError(event) {
        for (const c of this.children)
            if (c.onError)
                c.onError(event);
    }
    onStageStart(event) {
        for (const c of this.children)
            if (c.onStageStart)
                c.onStageStart(event);
    }
    onStageEnd(event) {
        for (const c of this.children)
            if (c.onStageEnd)
                c.onStageEnd(event);
    }
    // ── FlowRecorder hooks (fan-out to children that implement FlowRecorder) ─
    onStageExecuted(event) {
        for (const c of this.children)
            if (c.onStageExecuted)
                c.onStageExecuted(event);
    }
    onNext(event) {
        for (const c of this.children)
            if (c.onNext)
                c.onNext(event);
    }
    onDecision(event) {
        for (const c of this.children)
            if (c.onDecision)
                c.onDecision(event);
    }
    onFork(event) {
        for (const c of this.children)
            if (c.onFork)
                c.onFork(event);
    }
    onSelected(event) {
        for (const c of this.children)
            if (c.onSelected)
                c.onSelected(event);
    }
    onSubflowEntry(event) {
        for (const c of this.children)
            if (c.onSubflowEntry)
                c.onSubflowEntry(event);
    }
    onSubflowExit(event) {
        for (const c of this.children)
            if (c.onSubflowExit)
                c.onSubflowExit(event);
    }
    onSubflowRegistered(event) {
        for (const c of this.children)
            if (c.onSubflowRegistered)
                c.onSubflowRegistered(event);
    }
    onLoop(event) {
        for (const c of this.children)
            if (c.onLoop)
                c.onLoop(event);
    }
    onBreak(event) {
        for (const c of this.children)
            if (c.onBreak)
                c.onBreak(event);
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────
    clear() {
        for (const c of this.children)
            if (c.clear)
                c.clear();
    }
    /**
     * Snapshot merges all child snapshots into a single composite entry.
     * Each child's snapshot is preserved with its own id/name/data.
     */
    toSnapshot() {
        const childSnapshots = [];
        for (const c of this.children) {
            if (c.toSnapshot) {
                const { name, data } = c.toSnapshot();
                childSnapshots.push({ id: c.id, name, data });
            }
        }
        return {
            name: 'Composite',
            data: { children: childSnapshots },
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29tcG9zaXRlUmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3JlY29yZGVyL0NvbXBvc2l0ZVJlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBMkNHO0FBeUJILE1BQU0sT0FBTyxpQkFBaUI7SUFDbkIsRUFBRSxDQUFTO0lBQ0gsUUFBUSxDQUFzQztJQUUvRCxZQUFZLEVBQVUsRUFBRSxRQUE2QztRQUNuRSxJQUFJLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQztRQUNiLElBQUksQ0FBQyxRQUFRLEdBQUcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7SUFFRCx5RUFBeUU7SUFFekU7Ozs7Ozs7T0FPRztJQUNILEdBQUcsQ0FBSSxJQUErQjtRQUNwQyxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLFlBQVksSUFBSSxDQUFrQixDQUFDO0lBQ3ZFLENBQUM7SUFFRCwrQkFBK0I7SUFDL0IsV0FBVztRQUNULE9BQU8sSUFBSSxDQUFDLFFBQVEsQ0FBQztJQUN2QixDQUFDO0lBRUQsb0ZBQW9GO0lBRXBGLE1BQU0sQ0FBQyxLQUFnQjtRQUNyQixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFtQixDQUFDLE1BQU07Z0JBQUcsQ0FBbUIsQ0FBQyxNQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDdEcsQ0FBQztJQUVELE9BQU8sQ0FBQyxLQUFpQjtRQUN2QixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFtQixDQUFDLE9BQU87Z0JBQUcsQ0FBbUIsQ0FBQyxPQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDeEcsQ0FBQztJQUVELFFBQVEsQ0FBQyxLQUFrQjtRQUN6QixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFtQixDQUFDLFFBQVE7Z0JBQUcsQ0FBbUIsQ0FBQyxRQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDMUcsQ0FBQztJQUVELE9BQU8sQ0FBQyxLQUFrQztRQUN4QyxLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFtQixDQUFDLE9BQU87Z0JBQUcsQ0FBbUIsQ0FBQyxPQUFRLENBQUMsS0FBWSxDQUFDLENBQUM7SUFDL0csQ0FBQztJQUVELFlBQVksQ0FBQyxLQUFpQjtRQUM1QixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFtQixDQUFDLFlBQVk7Z0JBQUcsQ0FBbUIsQ0FBQyxZQUFhLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDbEgsQ0FBQztJQUVELFVBQVUsQ0FBQyxLQUFpQjtRQUMxQixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFtQixDQUFDLFVBQVU7Z0JBQUcsQ0FBbUIsQ0FBQyxVQUFXLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUcsQ0FBQztJQUVELDRFQUE0RTtJQUU1RSxlQUFlLENBQUMsS0FBcUI7UUFDbkMsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUTtZQUFFLElBQUssQ0FBa0IsQ0FBQyxlQUFlO2dCQUFHLENBQWtCLENBQUMsZUFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN0SCxDQUFDO0lBRUQsTUFBTSxDQUFDLEtBQW9CO1FBQ3pCLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWtCLENBQUMsTUFBTTtnQkFBRyxDQUFrQixDQUFDLE1BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNwRyxDQUFDO0lBRUQsVUFBVSxDQUFDLEtBQXdCO1FBQ2pDLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWtCLENBQUMsVUFBVTtnQkFBRyxDQUFrQixDQUFDLFVBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1RyxDQUFDO0lBRUQsTUFBTSxDQUFDLEtBQW9CO1FBQ3pCLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWtCLENBQUMsTUFBTTtnQkFBRyxDQUFrQixDQUFDLE1BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNwRyxDQUFDO0lBRUQsVUFBVSxDQUFDLEtBQXdCO1FBQ2pDLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWtCLENBQUMsVUFBVTtnQkFBRyxDQUFrQixDQUFDLFVBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1RyxDQUFDO0lBRUQsY0FBYyxDQUFDLEtBQXVCO1FBQ3BDLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWtCLENBQUMsY0FBYztnQkFBRyxDQUFrQixDQUFDLGNBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNwSCxDQUFDO0lBRUQsYUFBYSxDQUFDLEtBQXVCO1FBQ25DLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWtCLENBQUMsYUFBYTtnQkFBRyxDQUFrQixDQUFDLGFBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNsSCxDQUFDO0lBRUQsbUJBQW1CLENBQUMsS0FBaUM7UUFDbkQsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUTtZQUMzQixJQUFLLENBQWtCLENBQUMsbUJBQW1CO2dCQUFHLENBQWtCLENBQUMsbUJBQW9CLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDakcsQ0FBQztJQUVELE1BQU0sQ0FBQyxLQUFvQjtRQUN6QixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFrQixDQUFDLE1BQU07Z0JBQUcsQ0FBa0IsQ0FBQyxNQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDcEcsQ0FBQztJQUVELE9BQU8sQ0FBQyxLQUFxQjtRQUMzQixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFrQixDQUFDLE9BQU87Z0JBQUcsQ0FBa0IsQ0FBQyxPQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDdEcsQ0FBQztJQUVELHlFQUF5RTtJQUV6RSxLQUFLO1FBQ0gsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUTtZQUFFLElBQUksQ0FBQyxDQUFDLEtBQUs7Z0JBQUUsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQ3hELENBQUM7SUFFRDs7O09BR0c7SUFDSCxVQUFVO1FBQ1IsTUFBTSxjQUFjLEdBQXVELEVBQUUsQ0FBQztRQUM5RSxLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUM5QixJQUFJLENBQUMsQ0FBQyxVQUFVLEVBQUUsQ0FBQztnQkFDakIsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUMsVUFBVSxFQUFFLENBQUM7Z0JBQ3RDLGNBQWMsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUNoRCxDQUFDO1FBQ0gsQ0FBQztRQUNELE9BQU87WUFDTCxJQUFJLEVBQUUsV0FBVztZQUNqQixJQUFJLEVBQUUsRUFBRSxRQUFRLEVBQUUsY0FBYyxFQUFFO1NBQ25DLENBQUM7SUFDSixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvbXBvc2l0ZVJlY29yZGVyIOKAlCBmYW4tb3V0IGEgc2luZ2xlIHJlY29yZGVyIGF0dGFjaG1lbnQgdG8gbXVsdGlwbGUgY2hpbGQgcmVjb3JkZXJzLlxuICpcbiAqIEltcGxlbWVudHMgYm90aCBTY29wZVJlY29yZGVyIChzY29wZSBkYXRhIG9wcykgYW5kIEZsb3dSZWNvcmRlciAoY29udHJvbCBmbG93IGV2ZW50cylcbiAqIHNvIGl0IHdvcmtzIHdpdGggYm90aCBgZXhlY3V0b3IuYXR0YWNoU2NvcGVSZWNvcmRlcigpYCBhbmQgYGV4ZWN1dG9yLmF0dGFjaEZsb3dSZWNvcmRlcigpYC5cbiAqXG4gKiBUaGUgY29tcG9zaXRlIGhhcyBhIHNpbmdsZSBJRCBmb3IgaWRlbXBvdGVudCBhdHRhY2gvZGV0YWNoLiBDaGlsZCByZWNvcmRlcnNcbiAqIGtlZXAgdGhlaXIgb3duIElEcyBpbnRlcm5hbGx5IGJ1dCBhcmUgbm90IGluZGl2aWR1YWxseSB2aXNpYmxlIHRvIHRoZSBleGVjdXRvci5cbiAqXG4gKiBEb21haW4gbGlicmFyaWVzIChlLmcuLCBhZ2VudGZvb3RwcmludCkgdXNlIHRoaXMgdG8gYnVuZGxlIG11bHRpcGxlIHJlY29yZGVyc1xuICogaW50byBhIHNpbmdsZSBwcmVzZXQg4oCUIHRoZSBjb25zdW1lciBjYWxscyBvbmUgZnVuY3Rpb24sIGdldHMgZnVsbCBvYnNlcnZhYmlsaXR5LlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBpbXBvcnQgeyBDb21wb3NpdGVSZWNvcmRlciwgTWV0cmljUmVjb3JkZXIsIERlYnVnUmVjb3JkZXIgfSBmcm9tICdmb290cHJpbnRqcyc7XG4gKlxuICogLy8gQnVuZGxlIG1ldHJpY3MgKyBkZWJ1ZyBpbnRvIGEgc2luZ2xlIHJlY29yZGVyXG4gKiBjb25zdCBvYnNlcnZhYmlsaXR5ID0gbmV3IENvbXBvc2l0ZVJlY29yZGVyKCdvYnNlcnZhYmlsaXR5JywgW1xuICogICBuZXcgTWV0cmljUmVjb3JkZXIoeyBzdGFnZUZpbHRlcjogKG5hbWUpID0+IG5hbWUgPT09ICdDYWxsTExNJyB9KSxcbiAqICAgbmV3IERlYnVnUmVjb3JkZXIoeyB2ZXJib3NpdHk6ICdtaW5pbWFsJyB9KSxcbiAqIF0pO1xuICpcbiAqIGV4ZWN1dG9yLmF0dGFjaFNjb3BlUmVjb3JkZXIob2JzZXJ2YWJpbGl0eSk7XG4gKlxuICogLy8gQWNjZXNzIGNoaWxkIHJlY29yZGVycyBieSB0eXBlXG4gKiBjb25zdCBtZXRyaWNzID0gb2JzZXJ2YWJpbGl0eS5nZXQoTWV0cmljUmVjb3JkZXIpO1xuICogbWV0cmljcz8uZ2V0TWV0cmljcygpOyAvLyB0aW1pbmcgZGF0YVxuICogYGBgXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIC8vIERvbWFpbiBsaWJyYXJ5IHByZXNldCAoZS5nLiwgYWdlbnRmb290cHJpbnQpXG4gKiBleHBvcnQgZnVuY3Rpb24gYWdlbnRPYnNlcnZhYmlsaXR5KG9wdGlvbnM/OiBBZ2VudE9ic2VydmFiaWxpdHlPcHRpb25zKSB7XG4gKiAgIHJldHVybiBuZXcgQ29tcG9zaXRlUmVjb3JkZXIoJ2FnZW50LW9ic2VydmFiaWxpdHknLCBbXG4gKiAgICAgbmV3IE1ldHJpY1JlY29yZGVyKG9wdGlvbnM/LnN0YWdlRmlsdGVyID8geyBzdGFnZUZpbHRlcjogb3B0aW9ucy5zdGFnZUZpbHRlciB9IDogdW5kZWZpbmVkKSxcbiAqICAgICBuZXcgVG9rZW5SZWNvcmRlcigpLFxuICogICAgIG5ldyBUb29sVXNhZ2VSZWNvcmRlcigpLFxuICogICBdKTtcbiAqIH1cbiAqXG4gKiAvLyBDb25zdW1lclxuICogZXhlY3V0b3IuYXR0YWNoU2NvcGVSZWNvcmRlcihhZ2VudE9ic2VydmFiaWxpdHkoKSk7XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgdHlwZSB7XG4gIEZsb3dCcmVha0V2ZW50LFxuICBGbG93RGVjaXNpb25FdmVudCxcbiAgRmxvd0Vycm9yRXZlbnQsXG4gIEZsb3dGb3JrRXZlbnQsXG4gIEZsb3dMb29wRXZlbnQsXG4gIEZsb3dOZXh0RXZlbnQsXG4gIEZsb3dSZWNvcmRlcixcbiAgRmxvd1NlbGVjdGVkRXZlbnQsXG4gIEZsb3dTdGFnZUV2ZW50LFxuICBGbG93U3ViZmxvd0V2ZW50LFxuICBGbG93U3ViZmxvd1JlZ2lzdGVyZWRFdmVudCxcbn0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IENvbW1pdEV2ZW50LCBFcnJvckV2ZW50LCBSZWFkRXZlbnQsIFNjb3BlUmVjb3JkZXIsIFN0YWdlRXZlbnQsIFdyaXRlRXZlbnQgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5cbi8qKiBTbmFwc2hvdCBmb3JtYXQgZm9yIGNvbXBvc2l0ZSByZWNvcmRlcnMg4oCUIHdyYXBzIGNoaWxkIHNuYXBzaG90cy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcG9zaXRlU25hcHNob3Qge1xuICBuYW1lOiBzdHJpbmc7XG4gIGRhdGE6IHtcbiAgICBjaGlsZHJlbjogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGRhdGE6IHVua25vd24gfT47XG4gIH07XG59XG5cbmV4cG9ydCBjbGFzcyBDb21wb3NpdGVSZWNvcmRlciBpbXBsZW1lbnRzIFNjb3BlUmVjb3JkZXIsIEZsb3dSZWNvcmRlciB7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2hpbGRyZW46IEFycmF5PFNjb3BlUmVjb3JkZXIgfCBGbG93UmVjb3JkZXI+O1xuXG4gIGNvbnN0cnVjdG9yKGlkOiBzdHJpbmcsIGNoaWxkcmVuOiBBcnJheTxTY29wZVJlY29yZGVyIHwgRmxvd1JlY29yZGVyPikge1xuICAgIHRoaXMuaWQgPSBpZDtcbiAgICB0aGlzLmNoaWxkcmVuID0gWy4uLmNoaWxkcmVuXTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBDaGlsZCBhY2Nlc3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEdldCBhIGNoaWxkIHJlY29yZGVyIGJ5IGNsYXNzIHR5cGUuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogY29uc3QgbWV0cmljcyA9IGNvbXBvc2l0ZS5nZXQoTWV0cmljUmVjb3JkZXIpO1xuICAgKiBgYGBcbiAgICovXG4gIGdldDxUPih0eXBlOiBuZXcgKC4uLmFyZ3M6IGFueVtdKSA9PiBUKTogVCB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuY2hpbGRyZW4uZmluZCgoYykgPT4gYyBpbnN0YW5jZW9mIHR5cGUpIGFzIFQgfCB1bmRlZmluZWQ7XG4gIH1cblxuICAvKiogR2V0IGFsbCBjaGlsZCByZWNvcmRlcnMuICovXG4gIGdldENoaWxkcmVuKCk6IFJlYWRvbmx5QXJyYXk8U2NvcGVSZWNvcmRlciB8IEZsb3dSZWNvcmRlcj4ge1xuICAgIHJldHVybiB0aGlzLmNoaWxkcmVuO1xuICB9XG5cbiAgLy8g4pSA4pSAIFNjb3BlIFNjb3BlUmVjb3JkZXIgaG9va3MgKGZhbi1vdXQgdG8gY2hpbGRyZW4gdGhhdCBpbXBsZW1lbnQgU2NvcGVSZWNvcmRlcikg4pSAXG5cbiAgb25SZWFkKGV2ZW50OiBSZWFkRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFNjb3BlUmVjb3JkZXIpLm9uUmVhZCkgKGMgYXMgU2NvcGVSZWNvcmRlcikub25SZWFkIShldmVudCk7XG4gIH1cblxuICBvbldyaXRlKGV2ZW50OiBXcml0ZUV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBTY29wZVJlY29yZGVyKS5vbldyaXRlKSAoYyBhcyBTY29wZVJlY29yZGVyKS5vbldyaXRlIShldmVudCk7XG4gIH1cblxuICBvbkNvbW1pdChldmVudDogQ29tbWl0RXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFNjb3BlUmVjb3JkZXIpLm9uQ29tbWl0KSAoYyBhcyBTY29wZVJlY29yZGVyKS5vbkNvbW1pdCEoZXZlbnQpO1xuICB9XG5cbiAgb25FcnJvcihldmVudDogRXJyb3JFdmVudCB8IEZsb3dFcnJvckV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBTY29wZVJlY29yZGVyKS5vbkVycm9yKSAoYyBhcyBTY29wZVJlY29yZGVyKS5vbkVycm9yIShldmVudCBhcyBhbnkpO1xuICB9XG5cbiAgb25TdGFnZVN0YXJ0KGV2ZW50OiBTdGFnZUV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBTY29wZVJlY29yZGVyKS5vblN0YWdlU3RhcnQpIChjIGFzIFNjb3BlUmVjb3JkZXIpLm9uU3RhZ2VTdGFydCEoZXZlbnQpO1xuICB9XG5cbiAgb25TdGFnZUVuZChldmVudDogU3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgU2NvcGVSZWNvcmRlcikub25TdGFnZUVuZCkgKGMgYXMgU2NvcGVSZWNvcmRlcikub25TdGFnZUVuZCEoZXZlbnQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIEZsb3dSZWNvcmRlciBob29rcyAoZmFuLW91dCB0byBjaGlsZHJlbiB0aGF0IGltcGxlbWVudCBGbG93UmVjb3JkZXIpIOKUgFxuXG4gIG9uU3RhZ2VFeGVjdXRlZChldmVudDogRmxvd1N0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdGFnZUV4ZWN1dGVkKSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uU3RhZ2VFeGVjdXRlZCEoZXZlbnQpO1xuICB9XG5cbiAgb25OZXh0KGV2ZW50OiBGbG93TmV4dEV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uTmV4dCkgKGMgYXMgRmxvd1JlY29yZGVyKS5vbk5leHQhKGV2ZW50KTtcbiAgfVxuXG4gIG9uRGVjaXNpb24oZXZlbnQ6IEZsb3dEZWNpc2lvbkV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uRGVjaXNpb24pIChjIGFzIEZsb3dSZWNvcmRlcikub25EZWNpc2lvbiEoZXZlbnQpO1xuICB9XG5cbiAgb25Gb3JrKGV2ZW50OiBGbG93Rm9ya0V2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uRm9yaykgKGMgYXMgRmxvd1JlY29yZGVyKS5vbkZvcmshKGV2ZW50KTtcbiAgfVxuXG4gIG9uU2VsZWN0ZWQoZXZlbnQ6IEZsb3dTZWxlY3RlZEV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uU2VsZWN0ZWQpIChjIGFzIEZsb3dSZWNvcmRlcikub25TZWxlY3RlZCEoZXZlbnQpO1xuICB9XG5cbiAgb25TdWJmbG93RW50cnkoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93RW50cnkpIChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93RW50cnkhKGV2ZW50KTtcbiAgfVxuXG4gIG9uU3ViZmxvd0V4aXQoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93RXhpdCkgKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dFeGl0IShldmVudCk7XG4gIH1cblxuICBvblN1YmZsb3dSZWdpc3RlcmVkKGV2ZW50OiBGbG93U3ViZmxvd1JlZ2lzdGVyZWRFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKVxuICAgICAgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93UmVnaXN0ZXJlZCkgKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dSZWdpc3RlcmVkIShldmVudCk7XG4gIH1cblxuICBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25Mb29wKSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uTG9vcCEoZXZlbnQpO1xuICB9XG5cbiAgb25CcmVhayhldmVudDogRmxvd0JyZWFrRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25CcmVhaykgKGMgYXMgRmxvd1JlY29yZGVyKS5vbkJyZWFrIShldmVudCk7XG4gIH1cblxuICAvLyDilIDilIAgTGlmZWN5Y2xlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoYy5jbGVhcikgYy5jbGVhcigpO1xuICB9XG5cbiAgLyoqXG4gICAqIFNuYXBzaG90IG1lcmdlcyBhbGwgY2hpbGQgc25hcHNob3RzIGludG8gYSBzaW5nbGUgY29tcG9zaXRlIGVudHJ5LlxuICAgKiBFYWNoIGNoaWxkJ3Mgc25hcHNob3QgaXMgcHJlc2VydmVkIHdpdGggaXRzIG93biBpZC9uYW1lL2RhdGEuXG4gICAqL1xuICB0b1NuYXBzaG90KCk6IENvbXBvc2l0ZVNuYXBzaG90IHtcbiAgICBjb25zdCBjaGlsZFNuYXBzaG90czogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGRhdGE6IHVua25vd24gfT4gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikge1xuICAgICAgaWYgKGMudG9TbmFwc2hvdCkge1xuICAgICAgICBjb25zdCB7IG5hbWUsIGRhdGEgfSA9IGMudG9TbmFwc2hvdCgpO1xuICAgICAgICBjaGlsZFNuYXBzaG90cy5wdXNoKHsgaWQ6IGMuaWQsIG5hbWUsIGRhdGEgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnQ29tcG9zaXRlJyxcbiAgICAgIGRhdGE6IHsgY2hpbGRyZW46IGNoaWxkU25hcHNob3RzIH0sXG4gICAgfTtcbiAgfVxufVxuIl19