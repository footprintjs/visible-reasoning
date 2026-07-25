/**
 * DebugRecorder — Development-focused recorder for detailed debugging
 *
 * Captures errors (always), mutations and reads (in verbose mode),
 * and stage lifecycle events for troubleshooting.
 */
/**
 * Each instance gets a unique auto-increment ID (`debug-1`, `debug-2`, ...),
 * so multiple recorders with different verbosity coexist.
 *
 * @example
 * ```typescript
 * // Verbose debug for development
 * executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'verbose' }));
 *
 * // Minimal debug for production (errors only)
 * executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'minimal' }));
 *
 * // Both coexist — different auto IDs
 * ```
 */
export class DebugRecorder {
    static _counter = 0;
    id;
    preferredOperation;
    entries = [];
    verbosity;
    constructor(options) {
        this.id = options?.id ?? `debug-${++DebugRecorder._counter}`;
        this.verbosity = options?.verbosity ?? 'verbose';
        this.preferredOperation = options?.preferredOperation ?? 'translate';
    }
    onRead(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'read',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { key: event.key, value: event.value, pipelineId: event.pipelineId },
        });
    }
    onWrite(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'write',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { key: event.key, value: event.value, operation: event.operation, pipelineId: event.pipelineId },
        });
    }
    onError(event) {
        this.entries.push({
            type: 'error',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { error: event.error, operation: event.operation, key: event.key, pipelineId: event.pipelineId },
        });
    }
    onStageStart(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'stageStart',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { pipelineId: event.pipelineId },
        });
    }
    onStageEnd(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'stageEnd',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { pipelineId: event.pipelineId, duration: event.duration },
        });
    }
    onPause(event) {
        // Always log pauses (even in minimal mode — pauses are significant events)
        this.entries.push({
            type: 'pause',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { stageId: event.stageId, pauseData: event.pauseData, pipelineId: event.pipelineId },
        });
    }
    onResume(event) {
        // Always log resumes (even in minimal mode)
        this.entries.push({
            type: 'resume',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { stageId: event.stageId, hasInput: event.hasInput, pipelineId: event.pipelineId },
        });
    }
    getEntries() {
        return [...this.entries];
    }
    getErrors() {
        return this.entries.filter((e) => e.type === 'error');
    }
    getEntriesForStage(stageName) {
        return this.entries.filter((e) => e.stageName === stageName);
    }
    setVerbosity(level) {
        this.verbosity = level;
    }
    getVerbosity() {
        return this.verbosity;
    }
    clear() {
        this.entries = [];
    }
    toSnapshot() {
        return {
            name: 'Debug',
            description: 'Translator (Scope ScopeRecorder) — per-stage diagnostic entries',
            preferredOperation: this.preferredOperation,
            data: this.entries,
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGVidWdSZWNvcmRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvc2NvcGUvcmVjb3JkZXJzL0RlYnVnUmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7O0dBS0c7QUE2Qkg7Ozs7Ozs7Ozs7Ozs7O0dBY0c7QUFDSCxNQUFNLE9BQU8sYUFBYTtJQUNoQixNQUFNLENBQUMsUUFBUSxHQUFHLENBQUMsQ0FBQztJQUVuQixFQUFFLENBQVM7SUFDWCxrQkFBa0IsQ0FBb0I7SUFDdkMsT0FBTyxHQUFpQixFQUFFLENBQUM7SUFDM0IsU0FBUyxDQUFpQjtJQUVsQyxZQUFZLE9BQThCO1FBQ3hDLElBQUksQ0FBQyxFQUFFLEdBQUcsT0FBTyxFQUFFLEVBQUUsSUFBSSxTQUFTLEVBQUUsYUFBYSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQzdELElBQUksQ0FBQyxTQUFTLEdBQUcsT0FBTyxFQUFFLFNBQVMsSUFBSSxTQUFTLENBQUM7UUFDakQsSUFBSSxDQUFDLGtCQUFrQixHQUFHLE9BQU8sRUFBRSxrQkFBa0IsSUFBSSxXQUFXLENBQUM7SUFDdkUsQ0FBQztJQUVELE1BQU0sQ0FBQyxLQUFnQjtRQUNyQixJQUFJLElBQUksQ0FBQyxTQUFTLEtBQUssU0FBUztZQUFFLE9BQU87UUFDekMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDaEIsSUFBSSxFQUFFLE1BQU07WUFDWixTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDMUIsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLElBQUksRUFBRSxFQUFFLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSyxFQUFFLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVSxFQUFFO1NBQzNFLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxPQUFPLENBQUMsS0FBaUI7UUFDdkIsSUFBSSxJ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QUFPLENBQUMsQ0FBQztJQUMzQixDQUFDO0lBRUQsU0FBUztRQUNQLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssT0FBTyxDQUFDLENBQUM7SUFDeEQsQ0FBQztJQUVELGtCQUFrQixDQUFDLFNBQWlCO1FBQ2xDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxTQUFTLEtBQUssU0FBUyxDQUFDLENBQUM7SUFDL0QsQ0FBQztJQUVELFlBQVksQ0FBQyxLQUFxQjtRQUNoQyxJQUFJLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQztJQUN6QixDQUFDO0lBRUQsWUFBWTtRQUNWLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQztJQUN4QixDQUFDO0lBRUQsS0FBSztRQUNILElBQUksQ0FBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO0lBQ3BCLENBQUM7SUFFRCxVQUFVO1FBQ1IsT0FBTztZQUNMLElBQUksRUFBRSxPQUFPO1lBQ2IsV0FBVyxFQUFFLGlFQUFpRTtZQUM5RSxrQkFBa0IsRUFBRSxJQUFJLENBQUMsa0JBQWtCO1lBQzNDLElBQUksRUFBRSxJQUFJLENBQUMsT0FBTztTQUNuQixDQUFDO0lBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRGVidWdSZWNvcmRlciDigJQgRGV2ZWxvcG1lbnQtZm9jdXNlZCByZWNvcmRlciBmb3IgZGV0YWlsZWQgZGVidWdnaW5nXG4gKlxuICogQ2FwdHVyZXMgZXJyb3JzIChhbHdheXMpLCBtdXRhdGlvbnMgYW5kIHJlYWRzIChpbiB2ZXJib3NlIG1vZGUpLFxuICogYW5kIHN0YWdlIGxpZmVjeWNsZSBldmVudHMgZm9yIHRyb3VibGVzaG9vdGluZy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlY29yZGVyT3BlcmF0aW9uIH0gZnJvbSAnLi4vLi4vcmVjb3JkZXIvUmVjb3JkZXJPcGVyYXRpb24uanMnO1xuaW1wb3J0IHR5cGUge1xuICBFcnJvckV2ZW50LFxuICBQYXVzZUV2ZW50LFxuICBSZWFkRXZlbnQsXG4gIFJlc3VtZUV2ZW50LFxuICBTY29wZVJlY29yZGVyLFxuICBTdGFnZUV2ZW50LFxuICBXcml0ZUV2ZW50LFxufSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIERlYnVnVmVyYm9zaXR5ID0gJ21pbmltYWwnIHwgJ3ZlcmJvc2UnO1xuXG5leHBvcnQgaW50ZXJmYWNlIERlYnVnRW50cnkge1xuICB0eXBlOiAncmVhZCcgfCAnd3JpdGUnIHwgJ2Vycm9yJyB8ICdzdGFnZVN0YXJ0JyB8ICdzdGFnZUVuZCcgfCAncGF1c2UnIHwgJ3Jlc3VtZSc7XG4gIHN0YWdlTmFtZTogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbiAgZGF0YTogdW5rbm93bjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEZWJ1Z1JlY29yZGVyT3B0aW9ucyB7XG4gIGlkPzogc3RyaW5nO1xuICB2ZXJib3NpdHk/OiBEZWJ1Z1ZlcmJvc2l0eTtcbiAgLyoqIFByZWZlcnJlZCBVSSBvcGVyYXRpb24uIERlZmF1bHRzIHRvICd0cmFuc2xhdGUnIChwZXItc3RlcCBkaWFnbm9zdGljIGRldGFpbCkuICovXG4gIHByZWZlcnJlZE9wZXJhdGlvbj86IFJlY29yZGVyT3BlcmF0aW9uO1xufVxuXG4vKipcbiAqIEVhY2ggaW5zdGFuY2UgZ2V0cyBhIHVuaXF1ZSBhdXRvLWluY3JlbWVudCBJRCAoYGRlYnVnLTFgLCBgZGVidWctMmAsIC4uLiksXG4gKiBzbyBtdWx0aXBsZSByZWNvcmRlcnMgd2l0aCBkaWZmZXJlbnQgdmVyYm9zaXR5IGNvZXhpc3QuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIC8vIFZlcmJvc2UgZGVidWcgZm9yIGRldmVsb3BtZW50XG4gKiBleGVjdXRvci5hdHRhY2hTY29wZVJlY29yZGVyKG5ldyBEZWJ1Z1JlY29yZGVyKHsgdmVyYm9zaXR5OiAndmVyYm9zZScgfSkpO1xuICpcbiAqIC8vIE1pbmltYWwgZGVidWcgZm9yIHByb2R1Y3Rpb24gKGVycm9ycyBvbmx5KVxuICogZXhlY3V0b3IuYXR0YWNoU2NvcGVSZWNvcmRlcihuZXcgRGVidWdSZWNvcmRlcih7IHZlcmJvc2l0eTogJ21pbmltYWwnIH0pKTtcbiAqXG4gKiAvLyBCb3RoIGNvZXhpc3Qg4oCUIGRpZmZlcmVudCBhdXRvIElEc1xuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBEZWJ1Z1JlY29yZGVyIGltcGxlbWVudHMgU2NvcGVSZWNvcmRlciB7XG4gIHByaXZhdGUgc3RhdGljIF9jb3VudGVyID0gMDtcblxuICByZWFkb25seSBpZDogc3RyaW5nO1xuICByZWFkb25seSBwcmVmZXJyZWRPcGVyYXRpb246IFJlY29yZGVyT3BlcmF0aW9uO1xuICBwcml2YXRlIGVudHJpZXM6IERlYnVnRW50cnlbXSA9IFtdO1xuICBwcml2YXRlIHZlcmJvc2l0eTogRGVidWdWZXJib3NpdHk7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9ucz86IERlYnVnUmVjb3JkZXJPcHRpb25zKSB7XG4gICAgdGhpcy5pZCA9IG9wdGlvbnM/LmlkID8/IGBkZWJ1Zy0keysrRGVidWdSZWNvcmRlci5fY291bnRlcn1gO1xuICAgIHRoaXMudmVyYm9zaXR5ID0gb3B0aW9ucz8udmVyYm9zaXR5ID8/ICd2ZXJib3NlJztcbiAgICB0aGlzLnByZWZlcnJlZE9wZXJhdGlvbiA9IG9wdGlvbnM/LnByZWZlcnJlZE9wZXJhdGlvbiA/PyAndHJhbnNsYXRlJztcbiAgfVxuXG4gIG9uUmVhZChldmVudDogUmVhZEV2ZW50KTogdm9pZCB7XG4gICAgaWYgKHRoaXMudmVyYm9zaXR5ICE9PSAndmVyYm9zZScpIHJldHVybjtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAncmVhZCcsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgICAgZGF0YTogeyBrZXk6IGV2ZW50LmtleSwgdmFsdWU6IGV2ZW50LnZhbHVlLCBwaXBlbGluZUlkOiBldmVudC5waXBlbGluZUlkIH0sXG4gICAgfSk7XG4gIH1cblxuICBvbldyaXRlKGV2ZW50OiBXcml0ZUV2ZW50KTogdm9pZCB7XG4gICAgaWYgKHRoaXMudmVyYm9zaXR5ICE9PSAndmVyYm9zZScpIHJldHVybjtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnd3JpdGUnLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIGRhdGE6IHsga2V5OiBldmVudC5rZXksIHZhbHVlOiBldmVudC52YWx1ZSwgb3BlcmF0aW9uOiBldmVudC5vcGVyYXRpb24sIHBpcGVsaW5lSWQ6IGV2ZW50LnBpcGVsaW5lSWQgfSxcbiAgICB9KTtcbiAgfVxuXG4gIG9uRXJyb3IoZXZlbnQ6IEVycm9yRXZlbnQpOiB2b2lkIHtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnZXJyb3InLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIGRhdGE6IHsgZXJyb3I6IGV2ZW50LmVycm9yLCBvcGVyYXRpb246IGV2ZW50Lm9wZXJhdGlvbiwga2V5OiBldmVudC5rZXksIHBpcGVsaW5lSWQ6IGV2ZW50LnBpcGVsaW5lSWQgfSxcbiAgICB9KTtcbiAgfVxuXG4gIG9uU3RhZ2VTdGFydChldmVudDogU3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnZlcmJvc2l0eSAhPT0gJ3ZlcmJvc2UnKSByZXR1cm47XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3N0YWdlU3RhcnQnLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIGRhdGE6IHsgcGlwZWxpbmVJZDogZXZlbnQucGlwZWxpbmVJZCB9LFxuICAgIH0pO1xuICB9XG5cbiAgb25TdGFnZUVuZChldmVudDogU3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnZlcmJvc2l0eSAhPT0gJ3ZlcmJvc2UnKSByZXR1cm47XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3N0YWdlRW5kJyxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgICBkYXRhOiB7IHBpcGVsaW5lSWQ6IGV2ZW50LnBpcGVsaW5lSWQsIGR1cmF0aW9uOiBldmVudC5kdXJhdGlvbiB9LFxuICAgIH0pO1xuICB9XG5cbiAgb25QYXVzZShldmVudDogUGF1c2VFdmVudCk6IHZvaWQge1xuICAgIC8vIEFsd2F5cyBsb2cgcGF1c2VzIChldmVuIGluIG1pbmltYWwgbW9kZSDigJQgcGF1c2VzIGFyZSBzaWduaWZpY2FudCBldmVudHMpXG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3BhdXNlJyxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgICBkYXRhOiB7IHN0YWdlSWQ6IGV2ZW50LnN0YWdlSWQsIHBhdXNlRGF0YTogZXZlbnQucGF1c2VEYXRhLCBwaXBlbGluZUlkOiBldmVudC5waXBlbGluZUlkIH0sXG4gICAgfSk7XG4gIH1cblxuICBvblJlc3VtZShldmVudDogUmVzdW1lRXZlbnQpOiB2b2lkIHtcbiAgICAvLyBBbHdheXMgbG9nIHJlc3VtZXMgKGV2ZW4gaW4gbWluaW1hbCBtb2RlKVxuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdyZXN1bWUnLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIGRhdGE6IHsgc3RhZ2VJZDogZXZlbnQuc3RhZ2VJZCwgaGFzSW5wdXQ6IGV2ZW50Lmhhc0lucHV0LCBwaXBlbGluZUlkOiBldmVudC5waXBlbGluZUlkIH0sXG4gICAgfSk7XG4gIH1cblxuICBnZXRFbnRyaWVzKCk6IERlYnVnRW50cnlbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLmVudHJpZXNdO1xuICB9XG5cbiAgZ2V0RXJyb3JzKCk6IERlYnVnRW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMuZW50cmllcy5maWx0ZXIoKGUpID0+IGUudHlwZSA9PT0gJ2Vycm9yJyk7XG4gIH1cblxuICBnZXRFbnRyaWVzRm9yU3RhZ2Uoc3RhZ2VOYW1lOiBzdHJpbmcpOiBEZWJ1Z0VudHJ5W10ge1xuICAgIHJldHVybiB0aGlzLmVudHJpZXMuZmlsdGVyKChlKSA9PiBlLnN0YWdlTmFtZSA9PT0gc3RhZ2VOYW1lKTtcbiAgfVxuXG4gIHNldFZlcmJvc2l0eShsZXZlbDogRGVidWdWZXJib3NpdHkpOiB2b2lkIHtcbiAgICB0aGlzLnZlcmJvc2l0eSA9IGxldmVsO1xuICB9XG5cbiAgZ2V0VmVyYm9zaXR5KCk6IERlYnVnVmVyYm9zaXR5IHtcbiAgICByZXR1cm4gdGhpcy52ZXJib3NpdHk7XG4gIH1cblxuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLmVudHJpZXMgPSBbXTtcbiAgfVxuXG4gIHRvU25hcHNob3QoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6ICdEZWJ1ZycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1RyYW5zbGF0b3IgKFNjb3BlIFNjb3BlUmVjb3JkZXIpIOKAlCBwZXItc3RhZ2UgZGlhZ25vc3RpYyBlbnRyaWVzJyxcbiAgICAgIHByZWZlcnJlZE9wZXJhdGlvbjogdGhpcy5wcmVmZXJyZWRPcGVyYXRpb24sXG4gICAgICBkYXRhOiB0aGlzLmVudHJpZXMsXG4gICAgfTtcbiAgfVxufVxuIl19