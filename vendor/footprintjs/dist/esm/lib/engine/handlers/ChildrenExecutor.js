/**
 * ChildrenExecutor — Parallel fan-out via Promise.allSettled.
 *
 * Responsibilities:
 * - Execute all children in parallel (fork pattern)
 * - Execute selected children based on selector output (multi-choice)
 * - Handle throttling error flagging for rate-limited operations
 * - Aggregate results into { childId: { result, isError } }
 */
import { isPauseSignal } from '../../pause/types.js';
export class ChildrenExecutor {
    deps;
    executeNode;
    constructor(deps, executeNode) {
        this.deps = deps;
        this.executeNode = executeNode;
    }
    /**
     * Execute all children in parallel. Each child commits on settle.
     * Uses Promise.allSettled to ensure all children complete even if some fail.
     */
    async executeNodeChildren(node, context, parentBreakFlag, branchPath, traversalContext) {
        let breakCount = 0;
        const totalChildren = node.children?.length ?? 0;
        const allChildren = node.children ?? [];
        // Narrative: capture the fan-out
        const childDisplayNames = allChildren.map((c) => c.name);
        this.deps.narrativeGenerator.onFork(node.name, childDisplayNames, traversalContext);
        // Proposal #003: fire onStageExecuted for the fork parent AFTER
        // the specialized event so consumers tracking "did this stage run"
        // work uniformly. Fires BEFORE children execute — matching the
        // "decision made" semantic (the fork's main work is the decision
        // to fan out; children are separate stages with their own lifecycles).
        this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'fork');
        const childPromises = allChildren.map((child) => {
            const childBranchPath = branchPath || child.id;
            const childContext = context.createChild(childBranchPath, child.id, child.name, child.id);
            const childBreakFlag = { shouldBreak: false };
            const updateParentBreakFlag = () => {
                if (childBreakFlag.shouldBreak)
                    breakCount += 1;
                if (parentBreakFlag && breakCount === totalChildren)
                    parentBreakFlag.shouldBreak = true;
            };
            return this.executeNode(child, childContext, childBreakFlag, childBranchPath)
                .then((result) => {
                childContext.commit();
                updateParentBreakFlag();
                return { id: child.id, result, isError: false };
            })
                .catch((error) => {
                // PauseSignal is expected control flow — re-throw immediately.
                if (isPauseSignal(error))
                    throw error;
                childContext.commit();
                updateParentBreakFlag();
                this.deps.logger.info(`TREE PIPELINE: executeNodeChildren - Error for id: ${child?.id}`, { error });
                if (this.deps.throttlingErrorChecker && this.deps.throttlingErrorChecker(error)) {
                    childContext.updateObject(['monitor'], 'isThrottled', true);
                }
                return { id: child.id, result: error, isError: true };
            });
        });
        const childrenResults = {};
        if (node.failFast) {
            // Fail-fast: first child error rejects immediately (unwrapped)
            const results = await Promise.all(allChildren.map((child, i) => childPromises[i].then((r) => {
                if (r.isError)
                    throw r.result;
                return r;
            })));
            for (const { id, result, isError } of results) {
                childrenResults[id] = { id, result, isError: isError ?? false };
            }
        }
        else {
            // Default: run all children to completion even if some fail
            const settled = await Promise.allSettled(childPromises);
            let pauseSignal;
            settled.forEach((s) => {
                if (s.status === 'fulfilled') {
                    const { id, result, isError } = s.value;
                    childrenResults[id] = { id, result, isError: isError ?? false };
                }
                else if (isPauseSignal(s.reason)) {
                    // PauseSignal from a child — re-throw after all children settle.
                    // Keep the first signal if multiple children pause.
                    pauseSignal ??= s.reason;
                }
                else {
                    this.deps.logger.error(`Execution failed: ${s.reason}`);
                }
            });
            // Re-throw PauseSignal after all children have settled
            if (pauseSignal)
                throw pauseSignal;
        }
        return childrenResults;
    }
    /**
     * Execute selected children based on selector result.
     * Validates IDs, records selection info, then delegates to executeNodeChildren.
     */
    async executeSelectedChildren(selector, children, input, context, branchPath, traversalContext, failFast) {
        const selectorResult = await selector(input);
        const selectedIds = Array.isArray(selectorResult) ? selectorResult : [selectorResult];
        context.addLog('selectedChildIds', selectedIds);
        context.addLog('selectorPattern', 'multi-choice');
        if (selectedIds.length === 0) {
            context.addLog('skippedAllChildren', true);
            return {};
        }
        const selectedChildren = children.filter((c) => selectedIds.includes(c.id));
        // Validate all IDs exist (fail fast)
        if (selectedChildren.length !== selectedIds.length) {
            const childIds = children.map((c) => c.id);
            const missing = selectedIds.filter((id) => !childIds.includes(id));
            const errorMessage = `Selector returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(', ')}`;
            this.deps.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
            context.addError('selectorError', errorMessage);
            throw new Error(errorMessage);
        }
        const skippedIds = children.filter((c) => !selectedIds.includes(c.id)).map((c) => c.id);
        if (skippedIds.length > 0) {
            context.addLog('skippedChildIds', skippedIds);
        }
        const selectedNames = selectedChildren.map((c) => c.name).join(', ');
        context.addFlowDebugMessage('selected', `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`, { count: selectedChildren.length, targetStage: selectedChildren.map((c) => c.name) });
        // Narrative: capture the selection
        const selectedDisplayNames = selectedChildren.map((c) => c.name);
        const selectorName = context.stageName || 'selector';
        this.deps.narrativeGenerator.onSelected(selectorName, selectedDisplayNames, children.length, traversalContext);
        // Proposal #003: fire onStageExecuted AFTER the specialized event.
        this.deps.narrativeGenerator.onStageExecuted(selectorName, undefined, traversalContext, 'selector');
        const tempNode = {
            name: 'selector-temp',
            id: 'selector-temp',
            children: selectedChildren,
            // Honor the selector node's fan-out error mode (Promise.all vs allSettled).
            failFast,
        };
        return await this.executeNodeChildren(tempNode, context, undefined, branchPath, traversalContext);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ2hpbGRyZW5FeGVjdXRvci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL2hhbmRsZXJzL0NoaWxkcmVuRXhlY3V0b3IudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7O0dBUUc7QUFHSCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFRckQsTUFBTSxPQUFPLGdCQUFnQjtJQUNQO0lBQXlDO0lBQTdELFlBQW9CLElBQStCLEVBQVUsV0FBd0M7UUFBakYsU0FBSSxHQUFKLElBQUksQ0FBMkI7UUFBVSxnQkFBVyxHQUFYLFdBQVcsQ0FBNkI7SUFBRyxDQUFDO0lBRXpHOzs7T0FHRztJQUNILEtBQUssQ0FBQyxtQkFBbUIsQ0FDdkIsSUFBNkIsRUFDN0IsT0FBcUIsRUFDckIsZUFBMEMsRUFDMUMsVUFBbUIsRUFDbkIsZ0JBQW1DO1FBRW5DLElBQUksVUFBVSxHQUFHLENBQUMsQ0FBQztRQUNuQixNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsUUFBUSxFQUFFLE1BQU0sSUFBSSxDQUFDLENBQUM7UUFDakQsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUM7UUFFeEMsaUNBQWlDO1FBQ2pDLE1BQU0saUJBQWlCLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pELElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztRQUNwRixnRUFBZ0U7UUFDaEUsbUVBQW1FO1FBQ25FLCtEQUErRDtRQUMvRCxpRUFBaUU7UUFDakUsdUVBQXVFO1FBQ3ZFLElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsZUFBZSxDQUFDLElBQUks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QUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNqRSxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsU0FBUyxJQUFJLFVBQVUsQ0FBQztRQUNyRCxJQUFJLENBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxZQUFZLEVBQUUsb0JBQW9CLEVBQUUsUUFBUSxDQUFDLE1BQU0sRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO1FBQy9HLG1FQUFtRTtRQUNuRSxJQUFJLENBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLGVBQWUsQ0FBQyxZQUFZLEVBQUUsU0FBUyxFQUFFLGdCQUFnQixFQUFFLFVBQVUsQ0FBQyxDQUFDO1FBRXBHLE1BQU0sUUFBUSxHQUE0QjtZQUN4QyxJQUFJLEVBQUUsZUFBZTtZQUNyQixFQUFFLEVBQUUsZUFBZTtZQUNuQixRQUFRLEVBQUUsZ0JBQWdCO1lBQzFCLDRFQUE0RTtZQUM1RSxRQUFRO1NBQ1QsQ0FBQztRQUNGLE9BQU8sTUFBTSxJQUFJLENBQUMsbUJBQW1CLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFDcEcsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDaGlsZHJlbkV4ZWN1dG9yIOKAlCBQYXJhbGxlbCBmYW4tb3V0IHZpYSBQcm9taXNlLmFsbFNldHRsZWQuXG4gKlxuICogUmVzcG9uc2liaWxpdGllczpcbiAqIC0gRXhlY3V0ZSBhbGwgY2hpbGRyZW4gaW4gcGFyYWxsZWwgKGZvcmsgcGF0dGVybilcbiAqIC0gRXhlY3V0ZSBzZWxlY3RlZCBjaGlsZHJlbiBiYXNlZCBvbiBzZWxlY3RvciBvdXRwdXQgKG11bHRpLWNob2ljZSlcbiAqIC0gSGFuZGxlIHRocm90dGxpbmcgZXJyb3IgZmxhZ2dpbmcgZm9yIHJhdGUtbGltaXRlZCBvcGVyYXRpb25zXG4gKiAtIEFnZ3JlZ2F0ZSByZXN1bHRzIGludG8geyBjaGlsZElkOiB7IHJlc3VsdCwgaXNFcnJvciB9IH1cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFN0YWdlQ29udGV4dCB9IGZyb20gJy4uLy4uL21lbW9yeS9TdGFnZUNvbnRleHQuanMnO1xuaW1wb3J0IHsgaXNQYXVzZVNpZ25hbCB9IGZyb20gJy4uLy4uL3BhdXNlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgU2VsZWN0b3IsIFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFRyYXZlcnNhbENvbnRleHQgfSBmcm9tICcuLi9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcywgTm9kZVJlc3VsdFR5cGUgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IEV4ZWN1dGVOb2RlRm4gfSBmcm9tICcuL3R5cGVzLmpzJztcblxuZXhwb3J0IHR5cGUgeyBFeGVjdXRlTm9kZUZuIH07XG5cbmV4cG9ydCBjbGFzcyBDaGlsZHJlbkV4ZWN1dG9yPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4sIHByaXZhdGUgZXhlY3V0ZU5vZGU6IEV4ZWN1dGVOb2RlRm48VE91dCwgVFNjb3BlPikge31cblxuICAvKipcbiAgICogRXhlY3V0ZSBhbGwgY2hpbGRyZW4gaW4gcGFyYWxsZWwuIEVhY2ggY2hpbGQgY29tbWl0cyBvbiBzZXR0bGUuXG4gICAqIFVzZXMgUHJvbWlzZS5hbGxTZXR0bGVkIHRvIGVuc3VyZSBhbGwgY2hpbGRyZW4gY29tcGxldGUgZXZlbiBpZiBzb21lIGZhaWwuXG4gICAqL1xuICBhc3luYyBleGVjdXRlTm9kZUNoaWxkcmVuKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBwYXJlbnRCcmVha0ZsYWc/OiB7IHNob3VsZEJyZWFrOiBib29sZWFuIH0sXG4gICAgYnJhbmNoUGF0aD86IHN0cmluZyxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBOb2RlUmVzdWx0VHlwZT4+IHtcbiAgICBsZXQgYnJlYWtDb3VudCA9IDA7XG4gICAgY29uc3QgdG90YWxDaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCA/PyAwO1xuICAgIGNvbnN0IGFsbENoaWxkcmVuID0gbm9kZS5jaGlsZHJlbiA/PyBbXTtcblxuICAgIC8vIE5hcnJhdGl2ZTogY2FwdHVyZSB0aGUgZmFuLW91dFxuICAgIGNvbnN0IGNoaWxkRGlzcGxheU5hbWVzID0gYWxsQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpO1xuICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25Gb3JrKG5vZGUubmFtZSwgY2hpbGREaXNwbGF5TmFtZXMsIHRyYXZlcnNhbENvbnRleHQpO1xuICAgIC8vIFByb3Bvc2FsICMwMDM6IGZpcmUgb25TdGFnZUV4ZWN1dGVkIGZvciB0aGUgZm9yayBwYXJlbnQgQUZURVJcbiAgICAvLyB0aGUgc3BlY2lhbGl6ZWQgZXZlbnQgc28gY29uc3VtZXJzIHRyYWNraW5nIFwiZGlkIHRoaXMgc3RhZ2UgcnVuXCJcbiAgICAvLyB3b3JrIHVuaWZvcm1seS4gRmlyZXMgQkVGT1JFIGNoaWxkcmVuIGV4ZWN1dGUg4oCUIG1hdGNoaW5nIHRoZVxuICAgIC8vIFwiZGVjaXNpb24gbWFkZVwiIHNlbWFudGljICh0aGUgZm9yaydzIG1haW4gd29yayBpcyB0aGUgZGVjaXNpb25cbiAgICAvLyB0byBmYW4gb3V0OyBjaGlsZHJlbiBhcmUgc2VwYXJhdGUgc3RhZ2VzIHdpdGggdGhlaXIgb3duIGxpZmVjeWNsZXMpLlxuICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25TdGFnZUV4ZWN1dGVkKG5vZGUubmFtZSwgbm9kZS5kZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCwgJ2ZvcmsnKTtcblxuICAgIGNvbnN0IGNoaWxkUHJvbWlzZXM6IFByb21pc2U8Tm9kZVJlc3VsdFR5cGU+W10gPSBhbGxDaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB7XG4gICAgICBjb25zdCBjaGlsZEJyYW5jaFBhdGggPSBicmFuY2hQYXRoIHx8IGNoaWxkLmlkO1xuICAgICAgY29uc3QgY2hpbGRDb250ZXh0ID0gY29udGV4dC5jcmVhdGVDaGlsZChjaGlsZEJyYW5jaFBhdGggYXMgc3RyaW5nLCBjaGlsZC5pZCBhcyBzdHJpbmcsIGNoaWxkLm5hbWUsIGNoaWxkLmlkKTtcbiAgICAgIGNvbnN0IGNoaWxkQnJlYWtGbGFnID0geyBzaG91bGRCcmVhazogZmFsc2UgfTtcblxuICAgICAgY29uc3QgdXBkYXRlUGFyZW50QnJlYWtGbGFnID0gKCkgPT4ge1xuICAgICAgICBpZiAoY2hpbGRCcmVha0ZsYWcuc2hvdWxkQnJlYWspIGJyZWFrQ291bnQgKz0gMTtcbiAgICAgICAgaWYgKHBhcmVudEJyZWFrRmxhZyAmJiBicmVha0NvdW50ID09PSB0b3RhbENoaWxkcmVuKSBwYXJlbnRCcmVha0ZsYWcuc2hvdWxkQnJlYWsgPSB0cnVlO1xuICAgICAgfTtcblxuICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZU5vZGUoY2hpbGQsIGNoaWxkQ29udGV4dCwgY2hpbGRCcmVha0ZsYWcsIGNoaWxkQnJhbmNoUGF0aClcbiAgICAgICAgLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIGNoaWxkQ29udGV4dC5jb21taXQoKTtcbiAgICAgICAgICB1cGRhdGVQYXJlbnRCcmVha0ZsYWcoKTtcbiAgICAgICAgICByZXR1cm4geyBpZDogY2hpbGQuaWQhLCByZXN1bHQsIGlzRXJyb3I6IGZhbHNlIH07XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAvLyBQYXVzZVNpZ25hbCBpcyBleHBlY3RlZCBjb250cm9sIGZsb3cg4oCUIHJlLXRocm93IGltbWVkaWF0ZWx5LlxuICAgICAgICAgIGlmIChpc1BhdXNlU2lnbmFsKGVycm9yKSkgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgY2hpbGRDb250ZXh0LmNvbW1pdCgpO1xuICAgICAgICAgIHVwZGF0ZVBhcmVudEJyZWFrRmxhZygpO1xuICAgICAgICAgIHRoaXMuZGVwcy5sb2dnZXIuaW5mbyhgVFJFRSBQSVBFTElORTogZXhlY3V0ZU5vZGVDaGlsZHJlbiAtIEVycm9yIGZvciBpZDogJHtjaGlsZD8uaWR9YCwgeyBlcnJvciB9KTtcbiAgICAgICAgICBpZiAodGhpcy5kZXBzLnRocm90dGxpbmdFcnJvckNoZWNrZXIgJiYgdGhpcy5kZXBzLnRocm90dGxpbmdFcnJvckNoZWNrZXIoZXJyb3IpKSB7XG4gICAgICAgICAgICBjaGlsZENvbnRleHQudXBkYXRlT2JqZWN0KFsnbW9uaXRvciddLCAnaXNUaHJvdHRsZWQnLCB0cnVlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHsgaWQ6IGNoaWxkLmlkISwgcmVzdWx0OiBlcnJvciwgaXNFcnJvcjogdHJ1ZSB9O1xuICAgICAgICB9KTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGNoaWxkcmVuUmVzdWx0czogUmVjb3JkPHN0cmluZywgTm9kZVJlc3VsdFR5cGU+ID0ge307XG5cbiAgICBpZiAobm9kZS5mYWlsRmFzdCkge1xuICAgICAgLy8gRmFpbC1mYXN0OiBmaXJzdCBjaGlsZCBlcnJvciByZWplY3RzIGltbWVkaWF0ZWx5ICh1bndyYXBwZWQpXG4gICAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIGFsbENoaWxkcmVuLm1hcCgoY2hpbGQsIGkpID0+XG4gICAgICAgICAgY2hpbGRQcm9taXNlc1tpXS50aGVuKChyKSA9PiB7XG4gICAgICAgICAgICBpZiAoci5pc0Vycm9yKSB0aHJvdyByLnJlc3VsdDtcbiAgICAgICAgICAgIHJldHVybiByO1xuICAgICAgICAgIH0pLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGZvciAoY29uc3QgeyBpZCwgcmVzdWx0LCBpc0Vycm9yIH0gb2YgcmVzdWx0cykge1xuICAgICAgICBjaGlsZHJlblJlc3VsdHNbaWRdID0geyBpZCwgcmVzdWx0LCBpc0Vycm9yOiBpc0Vycm9yID8/IGZhbHNlIH07XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIERlZmF1bHQ6IHJ1biBhbGwgY2hpbGRyZW4gdG8gY29tcGxldGlvbiBldmVuIGlmIHNvbWUgZmFpbFxuICAgICAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChjaGlsZFByb21pc2VzKTtcbiAgICAgIGxldCBwYXVzZVNpZ25hbDogdW5rbm93bjtcbiAgICAgIHNldHRsZWQuZm9yRWFjaCgocykgPT4ge1xuICAgICAgICBpZiAocy5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKSB7XG4gICAgICAgICAgY29uc3QgeyBpZCwgcmVzdWx0LCBpc0Vycm9yIH0gPSBzLnZhbHVlO1xuICAgICAgICAgIGNoaWxkcmVuUmVzdWx0c1tpZF0gPSB7IGlkLCByZXN1bHQsIGlzRXJyb3I6IGlzRXJyb3IgPz8gZmFsc2UgfTtcbiAgICAgICAgfSBlbHNlIGlmIChpc1BhdXNlU2lnbmFsKHMucmVhc29uKSkge1xuICAgICAgICAgIC8vIFBhdXNlU2lnbmFsIGZyb20gYSBjaGlsZCDigJQgcmUtdGhyb3cgYWZ0ZXIgYWxsIGNoaWxkcmVuIHNldHRsZS5cbiAgICAgICAgICAvLyBLZWVwIHRoZSBmaXJzdCBzaWduYWwgaWYgbXVsdGlwbGUgY2hpbGRyZW4gcGF1c2UuXG4gICAgICAgICAgcGF1c2VTaWduYWwgPz89IHMucmVhc29uO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoYEV4ZWN1dGlvbiBmYWlsZWQ6ICR7cy5yZWFzb259YCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gUmUtdGhyb3cgUGF1c2VTaWduYWwgYWZ0ZXIgYWxsIGNoaWxkcmVuIGhhdmUgc2V0dGxlZFxuICAgICAgaWYgKHBhdXNlU2lnbmFsKSB0aHJvdyBwYXVzZVNpZ25hbDtcbiAgICB9XG5cbiAgICByZXR1cm4gY2hpbGRyZW5SZXN1bHRzO1xuICB9XG5cbiAgLyoqXG4gICAqIEV4ZWN1dGUgc2VsZWN0ZWQgY2hpbGRyZW4gYmFzZWQgb24gc2VsZWN0b3IgcmVzdWx0LlxuICAgKiBWYWxpZGF0ZXMgSURzLCByZWNvcmRzIHNlbGVjdGlvbiBpbmZvLCB0aGVuIGRlbGVnYXRlcyB0byBleGVjdXRlTm9kZUNoaWxkcmVuLlxuICAgKi9cbiAgYXN5bmMgZXhlY3V0ZVNlbGVjdGVkQ2hpbGRyZW4oXG4gICAgc2VsZWN0b3I6IFNlbGVjdG9yLFxuICAgIGNoaWxkcmVuOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPltdLFxuICAgIGlucHV0OiBhbnksXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyYW5jaFBhdGg6IHN0cmluZyxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgICBmYWlsRmFzdD86IGJvb2xlYW4sXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgTm9kZVJlc3VsdFR5cGU+PiB7XG4gICAgY29uc3Qgc2VsZWN0b3JSZXN1bHQgPSBhd2FpdCBzZWxlY3RvcihpbnB1dCk7XG4gICAgY29uc3Qgc2VsZWN0ZWRJZHMgPSBBcnJheS5pc0FycmF5KHNlbGVjdG9yUmVzdWx0KSA/IHNlbGVjdG9yUmVzdWx0IDogW3NlbGVjdG9yUmVzdWx0XTtcblxuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RlZENoaWxkSWRzJywgc2VsZWN0ZWRJZHMpO1xuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RvclBhdHRlcm4nLCAnbXVsdGktY2hvaWNlJyk7XG5cbiAgICBpZiAoc2VsZWN0ZWRJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygnc2tpcHBlZEFsbENoaWxkcmVuJywgdHJ1ZSk7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0ZWRDaGlsZHJlbiA9IGNoaWxkcmVuLmZpbHRlcigoYykgPT4gc2VsZWN0ZWRJZHMuaW5jbHVkZXMoYy5pZCEpKTtcblxuICAgIC8vIFZhbGlkYXRlIGFsbCBJRHMgZXhpc3QgKGZhaWwgZmFzdClcbiAgICBpZiAoc2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGggIT09IHNlbGVjdGVkSWRzLmxlbmd0aCkge1xuICAgICAgY29uc3QgY2hpbGRJZHMgPSBjaGlsZHJlbi5tYXAoKGMpID0+IGMuaWQpO1xuICAgICAgY29uc3QgbWlzc2luZyA9IHNlbGVjdGVkSWRzLmZpbHRlcigoaWQpID0+ICFjaGlsZElkcy5pbmNsdWRlcyhpZCkpO1xuICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFNlbGVjdG9yIHJldHVybmVkIHVua25vd24gY2hpbGQgSURzOiAke21pc3Npbmcuam9pbignLCAnKX0uIEF2YWlsYWJsZTogJHtjaGlsZElkcy5qb2luKFxuICAgICAgICAnLCAnLFxuICAgICAgKX1gO1xuICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pOmAsIHsgZXJyb3I6IGVycm9yTWVzc2FnZSB9KTtcbiAgICAgIGNvbnRleHQuYWRkRXJyb3IoJ3NlbGVjdG9yRXJyb3InLCBlcnJvck1lc3NhZ2UpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcHBlZElkcyA9IGNoaWxkcmVuLmZpbHRlcigoYykgPT4gIXNlbGVjdGVkSWRzLmluY2x1ZGVzKGMuaWQhKSkubWFwKChjKSA9PiBjLmlkKTtcbiAgICBpZiAoc2tpcHBlZElkcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygnc2tpcHBlZENoaWxkSWRzJywgc2tpcHBlZElkcyk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0ZWROYW1lcyA9IHNlbGVjdGVkQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpLmpvaW4oJywgJyk7XG4gICAgY29udGV4dC5hZGRGbG93RGVidWdNZXNzYWdlKFxuICAgICAgJ3NlbGVjdGVkJyxcbiAgICAgIGBSdW5uaW5nICR7c2VsZWN0ZWROYW1lc30gKCR7c2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGh9IG9mICR7Y2hpbGRyZW4ubGVuZ3RofSBtYXRjaGVkKWAsXG4gICAgICB7IGNvdW50OiBzZWxlY3RlZENoaWxkcmVuLmxlbmd0aCwgdGFyZ2V0U3RhZ2U6IHNlbGVjdGVkQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpIH0sXG4gICAgKTtcblxuICAgIC8vIE5hcnJhdGl2ZTogY2FwdHVyZSB0aGUgc2VsZWN0aW9uXG4gICAgY29uc3Qgc2VsZWN0ZWREaXNwbGF5TmFtZXMgPSBzZWxlY3RlZENoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lKTtcbiAgICBjb25zdCBzZWxlY3Rvck5hbWUgPSBjb250ZXh0LnN0YWdlTmFtZSB8fCAnc2VsZWN0b3InO1xuICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25TZWxlY3RlZChzZWxlY3Rvck5hbWUsIHNlbGVjdGVkRGlzcGxheU5hbWVzLCBjaGlsZHJlbi5sZW5ndGgsIHRyYXZlcnNhbENvbnRleHQpO1xuICAgIC8vIFByb3Bvc2FsICMwMDM6IGZpcmUgb25TdGFnZUV4ZWN1dGVkIEFGVEVSIHRoZSBzcGVjaWFsaXplZCBldmVudC5cbiAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uU3RhZ2VFeGVjdXRlZChzZWxlY3Rvck5hbWUsIHVuZGVmaW5lZCwgdHJhdmVyc2FsQ29udGV4dCwgJ3NlbGVjdG9yJyk7XG5cbiAgICBjb25zdCB0ZW1wTm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiAnc2VsZWN0b3ItdGVtcCcsXG4gICAgICBpZDogJ3NlbGVjdG9yLXRlbXAnLFxuICAgICAgY2hpbGRyZW46IHNlbGVjdGVkQ2hpbGRyZW4sXG4gICAgICAvLyBIb25vciB0aGUgc2VsZWN0b3Igbm9kZSdzIGZhbi1vdXQgZXJyb3IgbW9kZSAoUHJvbWlzZS5hbGwgdnMgYWxsU2V0dGxlZCkuXG4gICAgICBmYWlsRmFzdCxcbiAgICB9O1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmV4ZWN1dGVOb2RlQ2hpbGRyZW4odGVtcE5vZGUsIGNvbnRleHQsIHVuZGVmaW5lZCwgYnJhbmNoUGF0aCwgdHJhdmVyc2FsQ29udGV4dCk7XG4gIH1cbn1cbiJdfQ==