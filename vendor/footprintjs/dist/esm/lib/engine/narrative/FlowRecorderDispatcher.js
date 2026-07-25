/**
 * FlowRecorderDispatcher — Fans out control flow events to N attached FlowRecorders.
 *
 * Implements IControlFlowNarrative so it can replace the single
 * ControlFlowNarrativeGenerator in the traverser's HandlerDeps.
 *
 * Design mirrors ScopeFacade._invokeHook: iterate recorders, call optional
 * hooks, swallow errors so a failing recorder never breaks execution.
 *
 * When no recorders are attached, every method is a fast no-op (empty array check).
 */
import { isDevMode } from '../../scope/detectCircular.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
export class FlowRecorderDispatcher {
    recorders = [];
    /** Attach a FlowRecorder. Duplicate IDs are allowed (same as scope ScopeRecorder). */
    attach(recorder) {
        this.recorders.push(recorder);
    }
    /** Detach all FlowRecorders with the given ID. */
    detach(id) {
        this.recorders = this.recorders.filter((r) => r.id !== id);
    }
    /** Returns a defensive copy of attached recorders. */
    getScopeRecorders() {
        return [...this.recorders];
    }
    /** Find a recorder by ID. Useful for retrieving built-in recorders like NarrativeFlowRecorder. */
    getRecorderById(id) {
        return this.recorders.find((r) => r.id === id);
    }
    // ── IControlFlowNarrative implementation ──────────────────────────────────
    onStageExecuted(stageName, description, traversalContext, stageType) {
        if (this.recorders.length === 0)
            return;
        const event = { stageName, description, traversalContext, stageType };
        for (const r of this.recorders) {
            try {
                r.onStageExecuted?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onStageExecuted: ${err}`);
            }
        }
    }
    onNext(fromStage, toStage, description, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { from: fromStage, to: toStage, description, traversalContext };
        for (const r of this.recorders) {
            try {
                r.onNext?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onNext: ${err}`);
            }
        }
    }
    onDecision(deciderName, chosenBranch, rationale, deciderDescription, traversalContext, evidence) {
        if (this.recorders.length === 0)
            return;
        const event = {
            decider: deciderName,
            chosen: chosenBranch,
            rationale,
            description: deciderDescription,
            traversalContext,
            evidence,
        };
        for (const r of this.recorders) {
            try {
                r.onDecision?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onDecision: ${err}`);
            }
        }
    }
    onFork(parentStage, childNames, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { parent: parentStage, children: childNames, traversalContext };
        for (const r of this.recorders) {
            try {
                r.onFork?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onFork: ${err}`);
            }
        }
    }
    onSelected(parentStage, selectedNames, totalCount, traversalContext, evidence) {
        if (this.recorders.length === 0)
            return;
        const event = { parent: parentStage, selected: selectedNames, total: totalCount, traversalContext, evidence };
        for (const r of this.recorders) {
            try {
                r.onSelected?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSelected: ${err}`);
            }
        }
    }
    onSubflowEntry(subflowName, subflowId, description, traversalContext, mappedInput) {
        if (this.recorders.length === 0)
            return;
        const event = { name: subflowName, subflowId, description, traversalContext, mappedInput };
        for (const r of this.recorders) {
            try {
                r.onSubflowEntry?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowEntry: ${err}`);
            }
        }
    }
    onSubflowExit(subflowName, subflowId, traversalContext, outputState) {
        if (this.recorders.length === 0)
            return;
        const event = { name: subflowName, subflowId, traversalContext, outputState };
        for (const r of this.recorders) {
            try {
                r.onSubflowExit?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowExit: ${err}`);
            }
        }
    }
    onSubflowRegistered(subflowId, name, description, specStructure) {
        if (this.recorders.length === 0)
            return;
        const event = { subflowId, name, description, specStructure };
        for (const r of this.recorders) {
            try {
                r.onSubflowRegistered?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowRegistered: ${err}`);
            }
        }
    }
    onLoop(targetStage, iteration, description, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { target: targetStage, iteration, description, traversalContext };
        for (const r of this.recorders) {
            try {
                r.onLoop?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onLoop: ${err}`);
            }
        }
    }
    onBreak(stageName, traversalContext, reason, propagatedFromSubflow) {
        if (this.recorders.length === 0)
            return;
        const event = {
            stageName,
            ...(traversalContext && { traversalContext }),
            ...(reason !== undefined && { reason }),
            ...(propagatedFromSubflow !== undefined && { propagatedFromSubflow }),
        };
        for (const r of this.recorders) {
            try {
                r.onBreak?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onBreak: ${err}`);
            }
        }
    }
    onError(stageName, errorMessage, error, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const structuredError = extractErrorInfo(error);
        const event = { stageName, message: errorMessage, structuredError, traversalContext, channel: 'flow' };
        for (const r of this.recorders) {
            try {
                r.onError?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onError: ${err}`);
            }
        }
    }
    onPause(stageName, stageId, pauseData, subflowPath, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { stageName, stageId, pauseData, subflowPath, traversalContext, channel: 'flow' };
        for (const r of this.recorders) {
            try {
                r.onPause?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onPause: ${err}`);
            }
        }
    }
    onResume(stageName, stageId, hasInput, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { stageName, stageId, hasInput, traversalContext, channel: 'flow' };
        for (const r of this.recorders) {
            try {
                r.onResume?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onResume: ${err}`);
            }
        }
    }
    onRunStart(input, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { payload: input, traversalContext };
        for (const r of this.recorders) {
            try {
                r.onRunStart?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onRunStart: ${err}`);
            }
        }
    }
    onRunEnd(output, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { payload: output, traversalContext };
        for (const r of this.recorders) {
            try {
                r.onRunEnd?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onRunEnd: ${err}`);
            }
        }
    }
    onRunFailed(error, traversalContext) {
        if (this.recorders.length === 0)
            return;
        const event = { structuredError: error, traversalContext };
        for (const r of this.recorders) {
            try {
                r.onRunFailed?.(event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onRunFailed: ${err}`);
            }
        }
    }
    /**
     * Returns sentences from an attached NarrativeFlowRecorder (looked up by ID).
     * Callers that need sentences should attach a NarrativeFlowRecorder with id 'narrative'
     * and retrieve it directly via getRecorderById() if they need typed access.
     */
    getSentences() {
        const narrative = this.getRecorderById('narrative');
        return narrative?.getSentences() ?? [];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd1JlY29yZGVyRGlzcGF0Y2hlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL25hcnJhdGl2ZS9GbG93UmVjb3JkZXJEaXNwYXRjaGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7O0dBVUc7QUFHSCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFFMUQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sd0JBQXdCLENBQUM7QUFXMUQsTUFBTSxPQUFPLHNCQUFzQjtJQUN6QixTQUFTLEdBQW1CLEVBQUUsQ0FBQztJQUV2QyxzRkFBc0Y7SUFDdEYsTUFBTSxDQUFDLFFBQXNCO1FBQzNCLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7SUFFRCxrREFBa0Q7SUFDbEQsTUFBTSxDQUFDLEVBQVU7UUFDZixJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFFRCxzREFBc0Q7SUFDdEQsaUJBQWlCO1FBQ2YsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzdCLENBQUM7SUFFRCxrR0FBa0c7SUFDbEcsZUFBZSxDQUF3QyxFQUFVO1FBQy9ELE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFrQixDQUFDO0lBQ2xFLENBQUM7SUFFRCw2RUFBNkU7SUFFN0UsZUFBZSxDQUNiLFNBQWlCLEVBQ2pCLFdBQStCLEVBQy9CLGdCQUE4QyxFQUM5QyxTQUFvQjtRQUVwQixJQUFJLElBQUksQ0FBQyxT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RyxFQUFFLENBQUMsQ0FBQztZQUNyRyxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7SUFFRCxXQUFXLENBQUMsS0FBMEIsRUFBRSxnQkFBbUM7UUFDekUsSUFBSSxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQUUsT0FBTztRQUN4QyxNQUFNLEtBQUssR0FBRyxFQUFFLGVBQWUsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLEVBQUUsQ0FBQztRQUMzRCxLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUMvQixJQUFJLENBQUM7Z0JBQ0gsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3pCLENBQUM7WUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO2dCQUNiLElBQUksU0FBUyxFQUFFO29CQUNiLE9BQU8sQ0FBQyxJQUFJLENBQUMsaURBQWlELENBQUMsQ0FBQyxFQUFFLDJCQUEyQixHQUFHLEVBQUUsQ0FBQyxDQUFDO1lBQ3hHLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVEOzs7O09BSUc7SUFDSCxZQUFZO1FBQ1YsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBd0IsV0FBVyxDQUFDLENBQUM7UUFDM0UsT0FBTyxTQUFTLEVBQUUsWUFBWSxFQUFFLElBQUksRUFBRSxDQUFDO0lBQ3pDLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRmxvd1JlY29yZGVyRGlzcGF0Y2hlciDigJQgRmFucyBvdXQgY29udHJvbCBmbG93IGV2ZW50cyB0byBOIGF0dGFjaGVkIEZsb3dSZWNvcmRlcnMuXG4gKlxuICogSW1wbGVtZW50cyBJQ29udHJvbEZsb3dOYXJyYXRpdmUgc28gaXQgY2FuIHJlcGxhY2UgdGhlIHNpbmdsZVxuICogQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IgaW4gdGhlIHRyYXZlcnNlcidzIEhhbmRsZXJEZXBzLlxuICpcbiAqIERlc2lnbiBtaXJyb3JzIFNjb3BlRmFjYWRlLl9pbnZva2VIb29rOiBpdGVyYXRlIHJlY29yZGVycywgY2FsbCBvcHRpb25hbFxuICogaG9va3MsIHN3YWxsb3cgZXJyb3JzIHNvIGEgZmFpbGluZyByZWNvcmRlciBuZXZlciBicmVha3MgZXhlY3V0aW9uLlxuICpcbiAqIFdoZW4gbm8gcmVjb3JkZXJzIGFyZSBhdHRhY2hlZCwgZXZlcnkgbWV0aG9kIGlzIGEgZmFzdCBuby1vcCAoZW1wdHkgYXJyYXkgY2hlY2spLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRGVjaXNpb25FdmlkZW5jZSwgU2VsZWN0aW9uRXZpZGVuY2UgfSBmcm9tICcuLi8uLi9kZWNpZGUvdHlwZXMuanMnO1xuaW1wb3J0IHsgaXNEZXZNb2RlIH0gZnJvbSAnLi4vLi4vc2NvcGUvZGV0ZWN0Q2lyY3VsYXIuanMnO1xuaW1wb3J0IHR5cGUgeyBTdHJ1Y3R1cmVkRXJyb3JJbmZvIH0gZnJvbSAnLi4vZXJyb3JzL2Vycm9ySW5mby5qcyc7XG5pbXBvcnQgeyBleHRyYWN0RXJyb3JJbmZvIH0gZnJvbSAnLi4vZXJyb3JzL2Vycm9ySW5mby5qcyc7XG5pbXBvcnQgdHlwZSB7IE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4vTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgRmxvd0JyZWFrRXZlbnQsXG4gIEZsb3dSZWNvcmRlcixcbiAgRmxvd1N0YWdlRXZlbnQsXG4gIElDb250cm9sRmxvd05hcnJhdGl2ZSxcbiAgU3RhZ2VUeXBlLFxuICBUcmF2ZXJzYWxDb250ZXh0LFxufSBmcm9tICcuL3R5cGVzLmpzJztcblxuZXhwb3J0IGNsYXNzIEZsb3dSZWNvcmRlckRpc3BhdGNoZXIgaW1wbGVtZW50cyBJQ29udHJvbEZsb3dOYXJyYXRpdmUge1xuICBwcml2YXRlIHJlY29yZGVyczogRmxvd1JlY29yZGVyW10gPSBbXTtcblxuICAvKiogQXR0YWNoIGEgRmxvd1JlY29yZGVyLiBEdXBsaWNhdGUgSURzIGFyZSBhbGxvd2VkIChzYW1lIGFzIHNjb3BlIFNjb3BlUmVjb3JkZXIpLiAqL1xuICBhdHRhY2gocmVjb3JkZXI6IEZsb3dSZWNvcmRlcik6IHZvaWQge1xuICAgIHRoaXMucmVjb3JkZXJzLnB1c2gocmVjb3JkZXIpO1xuICB9XG5cbiAgLyoqIERldGFjaCBhbGwgRmxvd1JlY29yZGVycyB3aXRoIHRoZSBnaXZlbiBJRC4gKi9cbiAgZGV0YWNoKGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLnJlY29yZGVycyA9IHRoaXMucmVjb3JkZXJzLmZpbHRlcigocikgPT4gci5pZCAhPT0gaWQpO1xuICB9XG5cbiAgLyoqIFJldHVybnMgYSBkZWZlbnNpdmUgY29weSBvZiBhdHRhY2hlZCByZWNvcmRlcnMuICovXG4gIGdldFNjb3BlUmVjb3JkZXJzKCk6IEZsb3dSZWNvcmRlcltdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMucmVjb3JkZXJzXTtcbiAgfVxuXG4gIC8qKiBGaW5kIGEgcmVjb3JkZXIgYnkgSUQuIFVzZWZ1bCBmb3IgcmV0cmlldmluZyBidWlsdC1pbiByZWNvcmRlcnMgbGlrZSBOYXJyYXRpdmVGbG93UmVjb3JkZXIuICovXG4gIGdldFJlY29yZGVyQnlJZDxUIGV4dGVuZHMgRmxvd1JlY29yZGVyID0gRmxvd1JlY29yZGVyPihpZDogc3RyaW5nKTogVCB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMucmVjb3JkZXJzLmZpbmQoKHIpID0+IHIuaWQgPT09IGlkKSBhcyBUIHwgdW5kZWZpbmVkO1xuICB9XG5cbiAgLy8g4pSA4pSAIElDb250cm9sRmxvd05hcnJhdGl2ZSBpbXBsZW1lbnRhdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBvblN0YWdlRXhlY3V0ZWQoXG4gICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICAgZGVzY3JpcHRpb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICB0cmF2ZXJzYWxDb250ZXh0OiBUcmF2ZXJzYWxDb250ZXh0IHwgdW5kZWZpbmVkLFxuICAgIHN0YWdlVHlwZTogU3RhZ2VUeXBlLFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQ6IEZsb3dTdGFnZUV2ZW50ID0geyBzdGFnZU5hbWUsIGRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0LCBzdGFnZVR5cGUgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25TdGFnZUV4ZWN1dGVkPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uU3RhZ2VFeGVjdXRlZDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25OZXh0KGZyb21TdGFnZTogc3RyaW5nLCB0b1N0YWdlOiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgZnJvbTogZnJvbVN0YWdlLCB0bzogdG9TdGFnZSwgZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25OZXh0Py4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSkgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvbk5leHQ6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uRGVjaXNpb24oXG4gICAgZGVjaWRlck5hbWU6IHN0cmluZyxcbiAgICBjaG9zZW5CcmFuY2g6IHN0cmluZyxcbiAgICByYXRpb25hbGU/OiBzdHJpbmcsXG4gICAgZGVjaWRlckRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICAgIGV2aWRlbmNlPzogRGVjaXNpb25FdmlkZW5jZSxcbiAgKTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0ge1xuICAgICAgZGVjaWRlcjogZGVjaWRlck5hbWUsXG4gICAgICBjaG9zZW46IGNob3NlbkJyYW5jaCxcbiAgICAgIHJhdGlvbmFsZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBkZWNpZGVyRGVzY3JpcHRpb24sXG4gICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgZXZpZGVuY2UsXG4gICAgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25EZWNpc2lvbj8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvbkRlY2lzaW9uOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvbkZvcmsocGFyZW50U3RhZ2U6IHN0cmluZywgY2hpbGROYW1lczogc3RyaW5nW10sIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBwYXJlbnQ6IHBhcmVudFN0YWdlLCBjaGlsZHJlbjogY2hpbGROYW1lcywgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkZvcms/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uRm9yazogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25TZWxlY3RlZChcbiAgICBwYXJlbnRTdGFnZTogc3RyaW5nLFxuICAgIHNlbGVjdGVkTmFtZXM6IHN0cmluZ1tdLFxuICAgIHRvdGFsQ291bnQ6IG51bWJlcixcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgICBldmlkZW5jZT86IFNlbGVjdGlvbkV2aWRlbmNlLFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHBhcmVudDogcGFyZW50U3RhZ2UsIHNlbGVjdGVkOiBzZWxlY3RlZE5hbWVzLCB0b3RhbDogdG90YWxDb3VudCwgdHJhdmVyc2FsQ29udGV4dCwgZXZpZGVuY2UgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25TZWxlY3RlZD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblNlbGVjdGVkOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblN1YmZsb3dFbnRyeShcbiAgICBzdWJmbG93TmFtZTogc3RyaW5nLFxuICAgIHN1YmZsb3dJZD86IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgICBtYXBwZWRJbnB1dD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IG5hbWU6IHN1YmZsb3dOYW1lLCBzdWJmbG93SWQsIGRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0LCBtYXBwZWRJbnB1dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblN1YmZsb3dFbnRyeT8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblN1YmZsb3dFbnRyeTogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25TdWJmbG93RXhpdChcbiAgICBzdWJmbG93TmFtZTogc3RyaW5nLFxuICAgIHN1YmZsb3dJZD86IHN0cmluZyxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgICBvdXRwdXRTdGF0ZT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IG5hbWU6IHN1YmZsb3dOYW1lLCBzdWJmbG93SWQsIHRyYXZlcnNhbENvbnRleHQsIG91dHB1dFN0YXRlIH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uU3ViZmxvd0V4aXQ/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25TdWJmbG93RXhpdDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25TdWJmbG93UmVnaXN0ZXJlZChzdWJmbG93SWQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZywgc3BlY1N0cnVjdHVyZT86IHVua25vd24pOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHN1YmZsb3dJZCwgbmFtZSwgZGVzY3JpcHRpb24sIHNwZWNTdHJ1Y3R1cmUgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25TdWJmbG93UmVnaXN0ZXJlZD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblN1YmZsb3dSZWdpc3RlcmVkOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvbkxvb3AodGFyZ2V0U3RhZ2U6IHN0cmluZywgaXRlcmF0aW9uOiBudW1iZXIsIGRlc2NyaXB0aW9uPzogc3RyaW5nLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgdGFyZ2V0OiB0YXJnZXRTdGFnZSwgaXRlcmF0aW9uLCBkZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkxvb3A/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uTG9vcDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25CcmVhayhcbiAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgICByZWFzb24/OiBzdHJpbmcsXG4gICAgcHJvcGFnYXRlZEZyb21TdWJmbG93Pzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQ6IEZsb3dCcmVha0V2ZW50ID0ge1xuICAgICAgc3RhZ2VOYW1lLFxuICAgICAgLi4uKHRyYXZlcnNhbENvbnRleHQgJiYgeyB0cmF2ZXJzYWxDb250ZXh0IH0pLFxuICAgICAgLi4uKHJlYXNvbiAhPT0gdW5kZWZpbmVkICYmIHsgcmVhc29uIH0pLFxuICAgICAgLi4uKHByb3BhZ2F0ZWRGcm9tU3ViZmxvdyAhPT0gdW5kZWZpbmVkICYmIHsgcHJvcGFnYXRlZEZyb21TdWJmbG93IH0pLFxuICAgIH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uQnJlYWs/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25CcmVhazogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25FcnJvcihzdGFnZU5hbWU6IHN0cmluZywgZXJyb3JNZXNzYWdlOiBzdHJpbmcsIGVycm9yOiB1bmtub3duLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBzdHJ1Y3R1cmVkRXJyb3IgPSBleHRyYWN0RXJyb3JJbmZvKGVycm9yKTtcbiAgICBjb25zdCBldmVudCA9IHsgc3RhZ2VOYW1lLCBtZXNzYWdlOiBlcnJvck1lc3NhZ2UsIHN0cnVjdHVyZWRFcnJvciwgdHJhdmVyc2FsQ29udGV4dCwgY2hhbm5lbDogJ2Zsb3cnIGFzIGNvbnN0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uRXJyb3I/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25FcnJvcjogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25QYXVzZShcbiAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgICBzdGFnZUlkOiBzdHJpbmcsXG4gICAgcGF1c2VEYXRhOiB1bmtub3duLFxuICAgIHN1YmZsb3dQYXRoOiByZWFkb25seSBzdHJpbmdbXSxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgKTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBzdGFnZU5hbWUsIHN0YWdlSWQsIHBhdXNlRGF0YSwgc3ViZmxvd1BhdGgsIHRyYXZlcnNhbENvbnRleHQsIGNoYW5uZWw6ICdmbG93JyBhcyBjb25zdCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblBhdXNlPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uUGF1c2U6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uUmVzdW1lKHN0YWdlTmFtZTogc3RyaW5nLCBzdGFnZUlkOiBzdHJpbmcsIGhhc0lucHV0OiBib29sZWFuLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgc3RhZ2VOYW1lLCBzdGFnZUlkLCBoYXNJbnB1dCwgdHJhdmVyc2FsQ29udGV4dCwgY2hhbm5lbDogJ2Zsb3cnIGFzIGNvbnN0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uUmVzdW1lPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uUmVzdW1lOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblJ1blN0YXJ0KGlucHV0OiB1bmtub3duLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgcGF5bG9hZDogaW5wdXQsIHRyYXZlcnNhbENvbnRleHQgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25SdW5TdGFydD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblJ1blN0YXJ0OiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblJ1bkVuZChvdXRwdXQ6IHVua25vd24sIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBwYXlsb2FkOiBvdXRwdXQsIHRyYXZlcnNhbENvbnRleHQgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25SdW5FbmQ/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25SdW5FbmQ6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uUnVuRmFpbGVkKGVycm9yOiBTdHJ1Y3R1cmVkRXJyb3JJbmZvLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgc3RydWN0dXJlZEVycm9yOiBlcnJvciwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblJ1bkZhaWxlZD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblJ1bkZhaWxlZDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgc2VudGVuY2VzIGZyb20gYW4gYXR0YWNoZWQgTmFycmF0aXZlRmxvd1JlY29yZGVyIChsb29rZWQgdXAgYnkgSUQpLlxuICAgKiBDYWxsZXJzIHRoYXQgbmVlZCBzZW50ZW5jZXMgc2hvdWxkIGF0dGFjaCBhIE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB3aXRoIGlkICduYXJyYXRpdmUnXG4gICAqIGFuZCByZXRyaWV2ZSBpdCBkaXJlY3RseSB2aWEgZ2V0UmVjb3JkZXJCeUlkKCkgaWYgdGhleSBuZWVkIHR5cGVkIGFjY2Vzcy5cbiAgICovXG4gIGdldFNlbnRlbmNlcygpOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgbmFycmF0aXZlID0gdGhpcy5nZXRSZWNvcmRlckJ5SWQ8TmFycmF0aXZlRmxvd1JlY29yZGVyPignbmFycmF0aXZlJyk7XG4gICAgcmV0dXJuIG5hcnJhdGl2ZT8uZ2V0U2VudGVuY2VzKCkgPz8gW107XG4gIH1cbn1cbiJdfQ==