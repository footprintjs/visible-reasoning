/**
 * SelectorHandler — Multi-choice filtered fan-out.
 *
 * Responsibilities:
 * - Execute scope-based selector nodes (stage → commit → resolve children → parallel execution)
 * - The selector function IS a stage: reads scope, returns string[] of branch IDs
 * - Delegates parallel execution of selected children to ChildrenExecutor
 */
import { DECISION_RESULT } from '../../decide/types.js';
import { isPauseSignal } from '../../pause/types.js';
export class SelectorHandler {
    deps;
    childrenExecutor;
    constructor(deps, childrenExecutor) {
        this.deps = deps;
        this.childrenExecutor = childrenExecutor;
    }
    /**
     * Handle a scope-based selector node (created via addSelectorFunction).
     * The stage function IS the selector — its return value contains branch IDs.
     * Execution order: runStage(fn) → commit → resolve children → parallel execute.
     */
    async handleScopeBased(node, stageFunc, context, breakFlag, branchPath, runStage, executeNode, traversalContext) {
        const breakFn = () => (breakFlag.shouldBreak = true);
        let selectedIds;
        let selectionEvidence;
        try {
            const stageOutput = await runStage(node, stageFunc, context, breakFn);
            // Detect SelectionResult from select() helper via Symbol brand
            if (stageOutput &&
                typeof stageOutput === 'object' &&
                Reflect.has(stageOutput, DECISION_RESULT) &&
                Array.isArray(stageOutput.branches)) {
                selectedIds = stageOutput.branches;
                selectionEvidence = stageOutput.evidence;
            }
            else {
                selectedIds = Array.isArray(stageOutput) ? stageOutput.map(String) : [String(stageOutput)];
            }
        }
        catch (error) {
            // PauseSignal is expected control flow — commit and re-throw without error logging.
            if (isPauseSignal(error)) {
                context.commit();
                throw error;
            }
            context.commit();
            this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
            context.addError('stageExecutionError', error.toString());
            this.deps.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
            throw error;
        }
        context.commit();
        if (breakFlag.shouldBreak) {
            return {};
        }
        context.addLog('selectedChildIds', selectedIds);
        context.addLog('selectorPattern', 'scope-based-multi-choice');
        if (selectedIds.length === 0) {
            context.addLog('skippedAllChildren', true);
            context.addFlowDebugMessage('selected', 'No children selected — skipping all branches.', {
                count: 0,
                targetStage: [],
            });
            this.deps.narrativeGenerator.onSelected(node.name, [], (node.children ?? []).length, traversalContext);
            // Proposal #003: fire onStageExecuted even on zero-select path —
            // the selector DID complete (it picked none); consumers tracking
            // visited need the signal.
            this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'selector');
            return {};
        }
        // Resolve children by matching selected IDs against node.children.
        // Match branchId first (original unprefixed ID), fall back to id for backward compat.
        const children = node.children;
        const selectedChildren = children.filter((c) => selectedIds.includes(c.branchId ?? c.id));
        // Validate all IDs exist (fail fast)
        if (selectedChildren.length !== selectedIds.length) {
            const childIds = children.map((c) => c.branchId ?? c.id);
            const missing = selectedIds.filter((id) => !childIds.includes(id));
            const errorMessage = `Scope-based selector '${node.name}' returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(', ')}`;
            this.deps.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
            context.addError('selectorError', errorMessage);
            throw new Error(errorMessage);
        }
        const skippedIds = children
            .filter((c) => !selectedIds.includes(c.branchId ?? c.id))
            .map((c) => c.branchId ?? c.id);
        if (skippedIds.length > 0) {
            context.addLog('skippedChildIds', skippedIds);
        }
        const selectedNames = selectedChildren.map((c) => c.name).join(', ');
        context.addFlowDebugMessage('selected', `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`, { count: selectedChildren.length, targetStage: selectedChildren.map((c) => c.name) });
        const selectedDisplayNames = selectedChildren.map((c) => c.name);
        this.deps.narrativeGenerator.onSelected(node.name, selectedDisplayNames, children.length, traversalContext, selectionEvidence);
        // Proposal #003: fire onStageExecuted AFTER the specialized event
        // so consumers tracking "did this stage run" work uniformly.
        this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'selector');
        const tempNode = {
            name: 'selector-temp',
            id: 'selector-temp',
            children: selectedChildren,
            // Propagate the selector's fan-out error mode. Without this, ChildrenExecutor
            // reads `tempNode.failFast` (undefined) and always uses Promise.allSettled —
            // silently swallowing a required branch's error. See builder `failFast` option.
            failFast: node.failFast,
        };
        try {
            return await this.childrenExecutor.executeNodeChildren(tempNode, context, undefined, branchPath, traversalContext);
        }
        catch (error) {
            // Stamp invoker context on PauseSignal during bubble-up.
            if (isPauseSignal(error)) {
                error.setInvoker(node.id, node.next?.id);
                throw error;
            }
            throw error;
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2VsZWN0b3JIYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvU2VsZWN0b3JIYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7O0dBT0c7QUFHSCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFFeEQsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBT3JELE1BQU0sT0FBTyxlQUFlO0lBRVA7SUFDQTtJQUZuQixZQUNtQixJQUErQixFQUMvQixnQkFBZ0Q7UUFEaEQsU0FBSSxHQUFKLElBQUksQ0FBMkI7UUFDL0IscUJBQWdCLEdBQWhCLGdCQUFnQixDQUFnQztJQUNoRSxDQUFDO0lBRUo7Ozs7T0FJRztJQUNILEtBQUssQ0FBQyxnQkFBZ0IsQ0FDcEIsSUFBNkIsRUFDN0IsU0FBc0MsRUFDdEMsT0FBcUIsRUFDckIsU0FBbUMsRUFDbkMsVUFBOEIsRUFDOUIsUUFBa0MsRUFDbEMsV0FBd0MsRUFDeEMsZ0JBQW1DO1FBRW5DLE1BQU0sT0FBTyxHQUFHLEdBQUcsRUFBRSxDQUFDLENBQUMsU0FBUyxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsQ0FBQztRQUVyRCxJQUFJLFdBQXFCLENBQUM7UUFDMUIsSUFBSSxpQkFBZ0QsQ0FBQztRQUNyRCxJQUFJLENBQUM7WUFDSCxNQUFNLFdBQVcsR0FBRyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztZQUN0RSwrREFBK0Q7WUFDL0QsSUFDRSxXQUFXO2dCQUNYLE9BQU8sV0FBVyxLQUFLLFFBQVE7Z0JBQy9CLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBcUIsRUFBRSxlQUFlLENBQUM7Z0JBQ25ELEtBQUssQ0FBQyxPQUFPLENBQUUsV0FBbUIsQ0FBQyxRQUFRLENBQUMsRUFDNUMsQ0FBQztnQkFD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QUMsbUJBQW1CLENBQ3BELFFBQVEsRUFDUixPQUFPLEVBQ1AsU0FBUyxFQUNULFVBQVUsRUFDVixnQkFBZ0IsQ0FDakIsQ0FBQztRQUNKLENBQUM7UUFBQyxPQUFPLEtBQWMsRUFBRSxDQUFDO1lBQ3hCLHlEQUF5RDtZQUN6RCxJQUFJLGFBQWEsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO2dCQUN6QixLQUFLLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFHLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQztnQkFDMUMsTUFBTSxLQUFLLENBQUM7WUFDZCxDQUFDO1lBQ0QsTUFBTSxLQUFLLENBQUM7UUFDZCxDQUFDO0lBQ0gsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTZWxlY3RvckhhbmRsZXIg4oCUIE11bHRpLWNob2ljZSBmaWx0ZXJlZCBmYW4tb3V0LlxuICpcbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAtIEV4ZWN1dGUgc2NvcGUtYmFzZWQgc2VsZWN0b3Igbm9kZXMgKHN0YWdlIOKGkiBjb21taXQg4oaSIHJlc29sdmUgY2hpbGRyZW4g4oaSIHBhcmFsbGVsIGV4ZWN1dGlvbilcbiAqIC0gVGhlIHNlbGVjdG9yIGZ1bmN0aW9uIElTIGEgc3RhZ2U6IHJlYWRzIHNjb3BlLCByZXR1cm5zIHN0cmluZ1tdIG9mIGJyYW5jaCBJRHNcbiAqIC0gRGVsZWdhdGVzIHBhcmFsbGVsIGV4ZWN1dGlvbiBvZiBzZWxlY3RlZCBjaGlsZHJlbiB0byBDaGlsZHJlbkV4ZWN1dG9yXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTZWxlY3Rpb25FdmlkZW5jZSB9IGZyb20gJy4uLy4uL2RlY2lkZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBERUNJU0lPTl9SRVNVTFQgfSBmcm9tICcuLi8uLi9kZWNpZGUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi8uLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB7IGlzUGF1c2VTaWduYWwgfSBmcm9tICcuLi8uLi9wYXVzZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFRyYXZlcnNhbENvbnRleHQgfSBmcm9tICcuLi9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcywgTm9kZVJlc3VsdFR5cGUsIFN0YWdlRnVuY3Rpb24gfSBmcm9tICcuLi90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IENoaWxkcmVuRXhlY3V0b3IgfSBmcm9tICcuL0NoaWxkcmVuRXhlY3V0b3IuanMnO1xuaW1wb3J0IHR5cGUgeyBFeGVjdXRlTm9kZUZuLCBSdW5TdGFnZUZuIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBTZWxlY3RvckhhbmRsZXI8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgZGVwczogSGFuZGxlckRlcHM8VE91dCwgVFNjb3BlPixcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNoaWxkcmVuRXhlY3V0b3I6IENoaWxkcmVuRXhlY3V0b3I8VE91dCwgVFNjb3BlPixcbiAgKSB7fVxuXG4gIC8qKlxuICAgKiBIYW5kbGUgYSBzY29wZS1iYXNlZCBzZWxlY3RvciBub2RlIChjcmVhdGVkIHZpYSBhZGRTZWxlY3RvckZ1bmN0aW9uKS5cbiAgICogVGhlIHN0YWdlIGZ1bmN0aW9uIElTIHRoZSBzZWxlY3RvciDigJQgaXRzIHJldHVybiB2YWx1ZSBjb250YWlucyBicmFuY2ggSURzLlxuICAgKiBFeGVjdXRpb24gb3JkZXI6IHJ1blN0YWdlKGZuKSDihpIgY29tbWl0IOKGkiByZXNvbHZlIGNoaWxkcmVuIOKGkiBwYXJhbGxlbCBleGVjdXRlLlxuICAgKi9cbiAgYXN5bmMgaGFuZGxlU2NvcGVCYXNlZChcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBzdGFnZUZ1bmM6IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPixcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICAgYnJlYWtGbGFnOiB7IHNob3VsZEJyZWFrOiBib29sZWFuIH0sXG4gICAgYnJhbmNoUGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgIHJ1blN0YWdlOiBSdW5TdGFnZUZuPFRPdXQsIFRTY29wZT4sXG4gICAgZXhlY3V0ZU5vZGU6IEV4ZWN1dGVOb2RlRm48VE91dCwgVFNjb3BlPixcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBOb2RlUmVzdWx0VHlwZT4+IHtcbiAgICBjb25zdCBicmVha0ZuID0gKCkgPT4gKGJyZWFrRmxhZy5zaG91bGRCcmVhayA9IHRydWUpO1xuXG4gICAgbGV0IHNlbGVjdGVkSWRzOiBzdHJpbmdbXTtcbiAgICBsZXQgc2VsZWN0aW9uRXZpZGVuY2U6IFNlbGVjdGlvbkV2aWRlbmNlIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGFnZU91dHB1dCA9IGF3YWl0IHJ1blN0YWdlKG5vZGUsIHN0YWdlRnVuYywgY29udGV4dCwgYnJlYWtGbik7XG4gICAgICAvLyBEZXRlY3QgU2VsZWN0aW9uUmVzdWx0IGZyb20gc2VsZWN0KCkgaGVscGVyIHZpYSBTeW1ib2wgYnJhbmRcbiAgICAgIGlmIChcbiAgICAgICAgc3RhZ2VPdXRwdXQgJiZcbiAgICAgICAgdHlwZW9mIHN0YWdlT3V0cHV0ID09PSAnb2JqZWN0JyAmJlxuICAgICAgICBSZWZsZWN0LmhhcyhzdGFnZU91dHB1dCBhcyBvYmplY3QsIERFQ0lTSU9OX1JFU1VMVCkgJiZcbiAgICAgICAgQXJyYXkuaXNBcnJheSgoc3RhZ2VPdXRwdXQgYXMgYW55KS5icmFuY2hlcylcbiAgICAgICkge1xuICAgICAgICBzZWxlY3RlZElkcyA9IChzdGFnZU91dHB1dCBhcyBhbnkpLmJyYW5jaGVzO1xuICAgICAgICBzZWxlY3Rpb25FdmlkZW5jZSA9IChzdGFnZU91dHB1dCBhcyBhbnkpLmV2aWRlbmNlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2VsZWN0ZWRJZHMgPSBBcnJheS5pc0FycmF5KHN0YWdlT3V0cHV0KSA/IHN0YWdlT3V0cHV0Lm1hcChTdHJpbmcpIDogW1N0cmluZyhzdGFnZU91dHB1dCldO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIC8vIFBhdXNlU2lnbmFsIGlzIGV4cGVjdGVkIGNvbnRyb2wgZmxvdyDigJQgY29tbWl0IGFuZCByZS10aHJvdyB3aXRob3V0IGVycm9yIGxvZ2dpbmcuXG4gICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgY29udGV4dC5jb21taXQoKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3IgfSk7XG4gICAgICBjb250ZXh0LmFkZEVycm9yKCdzdGFnZUV4ZWN1dGlvbkVycm9yJywgZXJyb3IudG9TdHJpbmcoKSk7XG4gICAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uRXJyb3Iobm9kZS5uYW1lLCBlcnJvci50b1N0cmluZygpLCBlcnJvciwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG5cbiAgICBjb250ZXh0LmNvbW1pdCgpO1xuXG4gICAgaWYgKGJyZWFrRmxhZy5zaG91bGRCcmVhaykge1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cblxuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RlZENoaWxkSWRzJywgc2VsZWN0ZWRJZHMpO1xuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RvclBhdHRlcm4nLCAnc2NvcGUtYmFzZWQtbXVsdGktY2hvaWNlJyk7XG5cbiAgICBpZiAoc2VsZWN0ZWRJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygnc2tpcHBlZEFsbENoaWxkcmVuJywgdHJ1ZSk7XG4gICAgICBjb250ZXh0LmFkZEZsb3dEZWJ1Z01lc3NhZ2UoJ3NlbGVjdGVkJywgJ05vIGNoaWxkcmVuIHNlbGVjdGVkIOKAlCBza2lwcGluZyBhbGwgYnJhbmNoZXMuJywge1xuICAgICAgICBjb3VudDogMCxcbiAgICAgICAgdGFyZ2V0U3RhZ2U6IFtdLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uU2VsZWN0ZWQobm9kZS5uYW1lLCBbXSwgKG5vZGUuY2hpbGRyZW4gPz8gW10pLmxlbmd0aCwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICAvLyBQcm9wb3NhbCAjMDAzOiBmaXJlIG9uU3RhZ2VFeGVjdXRlZCBldmVuIG9uIHplcm8tc2VsZWN0IHBhdGgg4oCUXG4gICAgICAvLyB0aGUgc2VsZWN0b3IgRElEIGNvbXBsZXRlIChpdCBwaWNrZWQgbm9uZSk7IGNvbnN1bWVycyB0cmFja2luZ1xuICAgICAgLy8gdmlzaXRlZCBuZWVkIHRoZSBzaWduYWwuXG4gICAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uU3RhZ2VFeGVjdXRlZChub2RlLm5hbWUsIG5vZGUuZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQsICdzZWxlY3RvcicpO1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cblxuICAgIC8vIFJlc29sdmUgY2hpbGRyZW4gYnkgbWF0Y2hpbmcgc2VsZWN0ZWQgSURzIGFnYWluc3Qgbm9kZS5jaGlsZHJlbi5cbiAgICAvLyBNYXRjaCBicmFuY2hJZCBmaXJzdCAob3JpZ2luYWwgdW5wcmVmaXhlZCBJRCksIGZhbGwgYmFjayB0byBpZCBmb3IgYmFja3dhcmQgY29tcGF0LlxuICAgIGNvbnN0IGNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbiBhcyBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPltdO1xuICAgIGNvbnN0IHNlbGVjdGVkQ2hpbGRyZW4gPSBjaGlsZHJlbi5maWx0ZXIoKGMpID0+IHNlbGVjdGVkSWRzLmluY2x1ZGVzKGMuYnJhbmNoSWQgPz8gYy5pZCEpKTtcblxuICAgIC8vIFZhbGlkYXRlIGFsbCBJRHMgZXhpc3QgKGZhaWwgZmFzdClcbiAgICBpZiAoc2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGggIT09IHNlbGVjdGVkSWRzLmxlbmd0aCkge1xuICAgICAgY29uc3QgY2hpbGRJZHMgPSBjaGlsZHJlbi5tYXAoKGMpID0+IGMuYnJhbmNoSWQgPz8gYy5pZCk7XG4gICAgICBjb25zdCBtaXNzaW5nID0gc2VsZWN0ZWRJZHMuZmlsdGVyKChpZCkgPT4gIWNoaWxkSWRzLmluY2x1ZGVzKGlkKSk7XG4gICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBgU2NvcGUtYmFzZWQgc2VsZWN0b3IgJyR7bm9kZS5uYW1lfScgcmV0dXJuZWQgdW5rbm93biBjaGlsZCBJRHM6ICR7bWlzc2luZy5qb2luKFxuICAgICAgICAnLCAnLFxuICAgICAgKX0uIEF2YWlsYWJsZTogJHtjaGlsZElkcy5qb2luKCcsICcpfWA7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBwaXBlbGluZSAoJHticmFuY2hQYXRofSk6YCwgeyBlcnJvcjogZXJyb3JNZXNzYWdlIH0pO1xuICAgICAgY29udGV4dC5hZGRFcnJvcignc2VsZWN0b3JFcnJvcicsIGVycm9yTWVzc2FnZSk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgICB9XG5cbiAgICBjb25zdCBza2lwcGVkSWRzID0gY2hpbGRyZW5cbiAgICAgIC5maWx0ZXIoKGMpID0+ICFzZWxlY3RlZElkcy5pbmNsdWRlcyhjLmJyYW5jaElkID8/IGMuaWQhKSlcbiAgICAgIC5tYXAoKGMpID0+IGMuYnJhbmNoSWQgPz8gYy5pZCk7XG4gICAgaWYgKHNraXBwZWRJZHMubGVuZ3RoID4gMCkge1xuICAgICAgY29udGV4dC5hZGRMb2coJ3NraXBwZWRDaGlsZElkcycsIHNraXBwZWRJZHMpO1xuICAgIH1cblxuICAgIGNvbnN0IHNlbGVjdGVkTmFtZXMgPSBzZWxlY3RlZENoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lKS5qb2luKCcsICcpO1xuICAgIGNvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZShcbiAgICAgICdzZWxlY3RlZCcsXG4gICAgICBgUnVubmluZyAke3NlbGVjdGVkTmFtZXN9ICgke3NlbGVjdGVkQ2hpbGRyZW4ubGVuZ3RofSBvZiAke2NoaWxkcmVuLmxlbmd0aH0gbWF0Y2hlZClgLFxuICAgICAgeyBjb3VudDogc2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGgsIHRhcmdldFN0YWdlOiBzZWxlY3RlZENoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lKSB9LFxuICAgICk7XG5cbiAgICBjb25zdCBzZWxlY3RlZERpc3BsYXlOYW1lcyA9IHNlbGVjdGVkQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpO1xuICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25TZWxlY3RlZChcbiAgICAgIG5vZGUubmFtZSxcbiAgICAgIHNlbGVjdGVkRGlzcGxheU5hbWVzLFxuICAgICAgY2hpbGRyZW4ubGVuZ3RoLFxuICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgIHNlbGVjdGlvbkV2aWRlbmNlLFxuICAgICk7XG4gICAgLy8gUHJvcG9zYWwgIzAwMzogZmlyZSBvblN0YWdlRXhlY3V0ZWQgQUZURVIgdGhlIHNwZWNpYWxpemVkIGV2ZW50XG4gICAgLy8gc28gY29uc3VtZXJzIHRyYWNraW5nIFwiZGlkIHRoaXMgc3RhZ2UgcnVuXCIgd29yayB1bmlmb3JtbHkuXG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblN0YWdlRXhlY3V0ZWQobm9kZS5uYW1lLCBub2RlLmRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0LCAnc2VsZWN0b3InKTtcblxuICAgIGNvbnN0IHRlbXBOb2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6ICdzZWxlY3Rvci10ZW1wJyxcbiAgICAgIGlkOiAnc2VsZWN0b3ItdGVtcCcsXG4gICAgICBjaGlsZHJlbjogc2VsZWN0ZWRDaGlsZHJlbixcbiAgICAgIC8vIFByb3BhZ2F0ZSB0aGUgc2VsZWN0b3IncyBmYW4tb3V0IGVycm9yIG1vZGUuIFdpdGhvdXQgdGhpcywgQ2hpbGRyZW5FeGVjdXRvclxuICAgICAgLy8gcmVhZHMgYHRlbXBOb2RlLmZhaWxGYXN0YCAodW5kZWZpbmVkKSBhbmQgYWx3YXlzIHVzZXMgUHJvbWlzZS5hbGxTZXR0bGVkIOKAlFxuICAgICAgLy8gc2lsZW50bHkgc3dhbGxvd2luZyBhIHJlcXVpcmVkIGJyYW5jaCdzIGVycm9yLiBTZWUgYnVpbGRlciBgZmFpbEZhc3RgIG9wdGlvbi5cbiAgICAgIGZhaWxGYXN0OiBub2RlLmZhaWxGYXN0LFxuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLmNoaWxkcmVuRXhlY3V0b3IuZXhlY3V0ZU5vZGVDaGlsZHJlbihcbiAgICAgICAgdGVtcE5vZGUsXG4gICAgICAgIGNvbnRleHQsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgYnJhbmNoUGF0aCxcbiAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIC8vIFN0YW1wIGludm9rZXIgY29udGV4dCBvbiBQYXVzZVNpZ25hbCBkdXJpbmcgYnViYmxlLXVwLlxuICAgICAgaWYgKGlzUGF1c2VTaWduYWwoZXJyb3IpKSB7XG4gICAgICAgIGVycm9yLnNldEludm9rZXIobm9kZS5pZCEsIG5vZGUubmV4dD8uaWQpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxufVxuIl19