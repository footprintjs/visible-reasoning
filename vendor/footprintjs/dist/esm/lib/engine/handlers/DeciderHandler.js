/**
 * DeciderHandler — Single-choice conditional branching.
 *
 * Handles scope-based deciders (stage IS the decider, returns branch ID).
 * Logs flow control decisions and narrative sentences.
 *
 * Two entry points:
 * - `prepareDispatch` — runs the decider stage, commits, resolves the chosen
 *   branch, fires narrative, and returns the chosen node + branch context
 *   WITHOUT executing it. The traverser's trampoline driver uses this so a
 *   decider with no continuation of its own can hand the branch to the
 *   driver as a flat hop (loop-heavy decider charts stay flat-stacked).
 * - `handleScopeBased` — prepareDispatch + immediate branch execution via
 *   the provided `executeNode` callback. Kept for direct/advanced callers
 *   and for deciders whose own `.next` must run after the branch completes.
 */
import { DECISION_RESULT } from '../../decide/types.js';
import { isPauseSignal } from '../../pause/types.js';
export class DeciderHandler {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Handle a scope-based decider (created via addDeciderFunction).
     * The stage function IS the decider — its return value is the branch ID.
     * Execution order: runStage(fn) → commit → resolve child → log → executeNode(child).
     */
    async handleScopeBased(node, stageFunc, context, breakFlag, branchPath, runStage, executeNode, traversalContext) {
        const dispatch = await this.prepareDispatch(node, stageFunc, context, breakFlag, branchPath, runStage, traversalContext);
        if (dispatch.kind === 'break') {
            return dispatch.branchId;
        }
        try {
            return await executeNode(dispatch.chosen, dispatch.branchContext, breakFlag, branchPath);
        }
        catch (error) {
            // Stamp invoker context on PauseSignal during bubble-up.
            // The decider (node) is the invoker; its .next is the continuation target.
            if (isPauseSignal(error)) {
                error.setInvoker(node.id, node.next?.id);
                throw error;
            }
            throw error;
        }
    }
    /**
     * Run the decider stage and resolve the chosen branch WITHOUT executing it.
     * Everything up to (and including) the `onDecision`/`onStageExecuted`
     * narrative and the branch context creation happens here — only the
     * branch execution itself is left to the caller.
     */
    async prepareDispatch(node, stageFunc, context, breakFlag, branchPath, runStage, traversalContext) {
        const breakFn = () => (breakFlag.shouldBreak = true);
        let branchId;
        let decisionEvidence;
        try {
            const stageOutput = await runStage(node, stageFunc, context, breakFn);
            // Detect DecisionResult from decide() helper via Symbol brand
            if (stageOutput && typeof stageOutput === 'object' && Reflect.has(stageOutput, DECISION_RESULT)) {
                branchId = stageOutput.branch;
                decisionEvidence = stageOutput.evidence;
            }
            else {
                branchId = String(stageOutput);
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
            return { kind: 'break', branchId };
        }
        // Resolve child by matching branch ID against node.children.
        // Match branchId first (original unprefixed ID), fall back to id for backward compat.
        const children = node.children;
        let chosen = children.find((child) => (child.branchId ?? child.id) === branchId);
        // Fall back to default branch
        if (!chosen) {
            const defaultChild = children.find((child) => (child.branchId ?? child.id) === 'default');
            if (defaultChild) {
                chosen = defaultChild;
            }
            else {
                const errorMessage = `Scope-based decider '${node.name}' returned branch ID '${branchId}' which doesn't match any child and no default branch is set`;
                context.addError('deciderError', errorMessage);
                throw new Error(errorMessage);
            }
        }
        const chosenName = chosen.name;
        const wasDefault = (chosen.branchId ?? chosen.id) !== branchId;
        const rationale = context.debug?.logContext?.deciderRationale;
        let branchReason;
        if (wasDefault) {
            branchReason = `Returned '${branchId}' (no match), fell back to default → ${chosenName} path.`;
        }
        else if (rationale) {
            branchReason = `Based on: ${rationale} → chose ${chosenName} path.`;
        }
        else {
            branchReason = `Evaluated scope and returned '${branchId}' → chose ${chosenName} path.`;
        }
        context.addFlowDebugMessage('branch', branchReason, {
            targetStage: chosen.name,
            rationale: rationale || `returned branchId: ${branchId}`,
        });
        this.deps.narrativeGenerator.onDecision(node.name, chosen.name, rationale, node.description, traversalContext, decisionEvidence);
        // Proposal #003: fire onStageExecuted AFTER the specialized event
        // so consumers tracking "did this stage run" work uniformly.
        this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'decider');
        const branchContext = context.createChild(branchPath, chosen.id, chosen.name, chosen.id);
        return { kind: 'dispatch', chosen, branchContext };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGVjaWRlckhhbmRsZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9EZWNpZGVySGFuZGxlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7O0dBZUc7QUFHSCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFFeEQsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBaUJyRCxNQUFNLE9BQU8sY0FBYztJQUNJO0lBQTdCLFlBQTZCLElBQStCO1FBQS9CLFNBQUksR0FBSixJQUFJLENBQTJCO0lBQUcsQ0FBQztJQUVoRTs7OztPQUlHO0lBQ0gsS0FBSyxDQUFDLGdCQUFnQixDQUNwQixJQUE2QixFQUM3QixTQUFzQyxFQUN0QyxPQUFxQixFQUNyQixTQUFtQyxFQUNuQyxVQUE4QixFQUM5QixRQUFrQyxFQUNsQyxXQUF3QyxFQUN4QyxnQkFBbUM7UUFFbkMsTUFBTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsZUFBZSxDQUN6QyxJQUFJLEVBQ0osU0FBUyxFQUNULE9BQU8sRUFDUCxTQUFTLEVBQ1QsVUFBVSxFQUNWLFFBQVEsRUFDUixnQkFBZ0IsQ0FDakIsQ0FBQztRQUVGLElBQUksUUFBUSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsQ0FBQztZQUM5QixPQUFPLFFBQVEsQ0FBQyxRQUFRLENBQUM7UUFDM0IsQ0FBQztRQUVELElBQUksQ0FBQztZQUNILE9BQU8sTUFBTSxXQUFXLENBQUMsUUFBUSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsYUFBYSxFQUFFLFNBQVMsRUFBRSxVQUFVLENBQUMsQ0FBQztRQUMzRixDQUFDO1FBQUMsT0FBTyxLQUFjLEVBQUUsQ0FBQztZQUN4Qix5REFBeUQ7WUFDekQsMkVBQTJFO1lBQzNFLElBQUksYUFBYSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQ3pC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QUMsV0FBVyxFQUNoQixnQkFBZ0IsRUFDaEIsZ0JBQWdCLENBQ2pCLENBQUM7UUFDRixrRUFBa0U7UUFDbEUsNkRBQTZEO1FBQzdELElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLFdBQVcsRUFBRSxnQkFBZ0IsRUFBRSxTQUFTLENBQUMsQ0FBQztRQUV2RyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDLFVBQW9CLEVBQUUsTUFBTSxDQUFDLEVBQUUsRUFBRSxNQUFNLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUVuRyxPQUFPLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFLENBQUM7SUFDckQsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEZWNpZGVySGFuZGxlciDigJQgU2luZ2xlLWNob2ljZSBjb25kaXRpb25hbCBicmFuY2hpbmcuXG4gKlxuICogSGFuZGxlcyBzY29wZS1iYXNlZCBkZWNpZGVycyAoc3RhZ2UgSVMgdGhlIGRlY2lkZXIsIHJldHVybnMgYnJhbmNoIElEKS5cbiAqIExvZ3MgZmxvdyBjb250cm9sIGRlY2lzaW9ucyBhbmQgbmFycmF0aXZlIHNlbnRlbmNlcy5cbiAqXG4gKiBUd28gZW50cnkgcG9pbnRzOlxuICogLSBgcHJlcGFyZURpc3BhdGNoYCDigJQgcnVucyB0aGUgZGVjaWRlciBzdGFnZSwgY29tbWl0cywgcmVzb2x2ZXMgdGhlIGNob3NlblxuICogICBicmFuY2gsIGZpcmVzIG5hcnJhdGl2ZSwgYW5kIHJldHVybnMgdGhlIGNob3NlbiBub2RlICsgYnJhbmNoIGNvbnRleHRcbiAqICAgV0lUSE9VVCBleGVjdXRpbmcgaXQuIFRoZSB0cmF2ZXJzZXIncyB0cmFtcG9saW5lIGRyaXZlciB1c2VzIHRoaXMgc28gYVxuICogICBkZWNpZGVyIHdpdGggbm8gY29udGludWF0aW9uIG9mIGl0cyBvd24gY2FuIGhhbmQgdGhlIGJyYW5jaCB0byB0aGVcbiAqICAgZHJpdmVyIGFzIGEgZmxhdCBob3AgKGxvb3AtaGVhdnkgZGVjaWRlciBjaGFydHMgc3RheSBmbGF0LXN0YWNrZWQpLlxuICogLSBgaGFuZGxlU2NvcGVCYXNlZGAg4oCUIHByZXBhcmVEaXNwYXRjaCArIGltbWVkaWF0ZSBicmFuY2ggZXhlY3V0aW9uIHZpYVxuICogICB0aGUgcHJvdmlkZWQgYGV4ZWN1dGVOb2RlYCBjYWxsYmFjay4gS2VwdCBmb3IgZGlyZWN0L2FkdmFuY2VkIGNhbGxlcnNcbiAqICAgYW5kIGZvciBkZWNpZGVycyB3aG9zZSBvd24gYC5uZXh0YCBtdXN0IHJ1biBhZnRlciB0aGUgYnJhbmNoIGNvbXBsZXRlcy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IERlY2lzaW9uRXZpZGVuY2UgfSBmcm9tICcuLi8uLi9kZWNpZGUvdHlwZXMuanMnO1xuaW1wb3J0IHsgREVDSVNJT05fUkVTVUxUIH0gZnJvbSAnLi4vLi4vZGVjaWRlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlU2lnbmFsIH0gZnJvbSAnLi4vLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBUcmF2ZXJzYWxDb250ZXh0IH0gZnJvbSAnLi4vbmFycmF0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgSGFuZGxlckRlcHMsIFN0YWdlRnVuY3Rpb24gfSBmcm9tICcuLi90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IEV4ZWN1dGVOb2RlRm4sIFJ1blN0YWdlRm4gfSBmcm9tICcuL3R5cGVzLmpzJztcblxuZXhwb3J0IHR5cGUgeyBFeGVjdXRlTm9kZUZuLCBSdW5TdGFnZUZuIH07XG5cbi8qKlxuICogUmVzdWx0IG9mIGBwcmVwYXJlRGlzcGF0Y2hgIOKAlCBlaXRoZXIgdGhlIGRlY2lkZXIgc3RhZ2UgYnJva2UgKG5vIGJyYW5jaFxuICogcnVuczsgYGJyYW5jaElkYCBpcyB0aGUgZGVjaWRlcidzIHJldHVybiB2YWx1ZSksIG9yIGEgYnJhbmNoIHdhcyBjaG9zZW5cbiAqIGFuZCBpcyByZWFkeSB0byBleGVjdXRlIGluIGBicmFuY2hDb250ZXh0YC5cbiAqL1xuZXhwb3J0IHR5cGUgRGVjaWRlckRpc3BhdGNoPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4gPVxuICB8IHsga2luZDogJ2JyZWFrJzsgYnJhbmNoSWQ6IHN0cmluZyB9XG4gIHwgeyBraW5kOiAnZGlzcGF0Y2gnOyBjaG9zZW46IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+OyBicmFuY2hDb250ZXh0OiBTdGFnZUNvbnRleHQgfTtcblxuZXhwb3J0IGNsYXNzIERlY2lkZXJIYW5kbGVyPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4pIHt9XG5cbiAgLyoqXG4gICAqIEhhbmRsZSBhIHNjb3BlLWJhc2VkIGRlY2lkZXIgKGNyZWF0ZWQgdmlhIGFkZERlY2lkZXJGdW5jdGlvbikuXG4gICAqIFRoZSBzdGFnZSBmdW5jdGlvbiBJUyB0aGUgZGVjaWRlciDigJQgaXRzIHJldHVybiB2YWx1ZSBpcyB0aGUgYnJhbmNoIElELlxuICAgKiBFeGVjdXRpb24gb3JkZXI6IHJ1blN0YWdlKGZuKSDihpIgY29tbWl0IOKGkiByZXNvbHZlIGNoaWxkIOKGkiBsb2cg4oaSIGV4ZWN1dGVOb2RlKGNoaWxkKS5cbiAgICovXG4gIGFzeW5jIGhhbmRsZVNjb3BlQmFzZWQoXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgc3RhZ2VGdW5jOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyZWFrRmxhZzogeyBzaG91bGRCcmVhazogYm9vbGVhbiB9LFxuICAgIGJyYW5jaFBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBydW5TdGFnZTogUnVuU3RhZ2VGbjxUT3V0LCBUU2NvcGU+LFxuICAgIGV4ZWN1dGVOb2RlOiBFeGVjdXRlTm9kZUZuPFRPdXQsIFRTY29wZT4sXG4gICAgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQsXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgZGlzcGF0Y2ggPSBhd2FpdCB0aGlzLnByZXBhcmVEaXNwYXRjaChcbiAgICAgIG5vZGUsXG4gICAgICBzdGFnZUZ1bmMsXG4gICAgICBjb250ZXh0LFxuICAgICAgYnJlYWtGbGFnLFxuICAgICAgYnJhbmNoUGF0aCxcbiAgICAgIHJ1blN0YWdlLFxuICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICApO1xuXG4gICAgaWYgKGRpc3BhdGNoLmtpbmQgPT09ICdicmVhaycpIHtcbiAgICAgIHJldHVybiBkaXNwYXRjaC5icmFuY2hJZDtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGV4ZWN1dGVOb2RlKGRpc3BhdGNoLmNob3NlbiwgZGlzcGF0Y2guYnJhbmNoQ29udGV4dCwgYnJlYWtGbGFnLCBicmFuY2hQYXRoKTtcbiAgICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgICAgLy8gU3RhbXAgaW52b2tlciBjb250ZXh0IG9uIFBhdXNlU2lnbmFsIGR1cmluZyBidWJibGUtdXAuXG4gICAgICAvLyBUaGUgZGVjaWRlciAobm9kZSkgaXMgdGhlIGludm9rZXI7IGl0cyAubmV4dCBpcyB0aGUgY29udGludWF0aW9uIHRhcmdldC5cbiAgICAgIGlmIChpc1BhdXNlU2lnbmFsKGVycm9yKSkge1xuICAgICAgICBlcnJvci5zZXRJbnZva2VyKG5vZGUuaWQhLCBub2RlLm5leHQ/LmlkKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUnVuIHRoZSBkZWNpZGVyIHN0YWdlIGFuZCByZXNvbHZlIHRoZSBjaG9zZW4gYnJhbmNoIFdJVEhPVVQgZXhlY3V0aW5nIGl0LlxuICAgKiBFdmVyeXRoaW5nIHVwIHRvIChhbmQgaW5jbHVkaW5nKSB0aGUgYG9uRGVjaXNpb25gL2BvblN0YWdlRXhlY3V0ZWRgXG4gICAqIG5hcnJhdGl2ZSBhbmQgdGhlIGJyYW5jaCBjb250ZXh0IGNyZWF0aW9uIGhhcHBlbnMgaGVyZSDigJQgb25seSB0aGVcbiAgICogYnJhbmNoIGV4ZWN1dGlvbiBpdHNlbGYgaXMgbGVmdCB0byB0aGUgY2FsbGVyLlxuICAgKi9cbiAgYXN5bmMgcHJlcGFyZURpc3BhdGNoKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIHN0YWdlRnVuYzogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBicmVha0ZsYWc6IHsgc2hvdWxkQnJlYWs6IGJvb2xlYW4gfSxcbiAgICBicmFuY2hQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgcnVuU3RhZ2U6IFJ1blN0YWdlRm48VE91dCwgVFNjb3BlPixcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgKTogUHJvbWlzZTxEZWNpZGVyRGlzcGF0Y2g8VE91dCwgVFNjb3BlPj4ge1xuICAgIGNvbnN0IGJyZWFrRm4gPSAoKSA9PiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrID0gdHJ1ZSk7XG5cbiAgICBsZXQgYnJhbmNoSWQ6IHN0cmluZztcbiAgICBsZXQgZGVjaXNpb25FdmlkZW5jZTogRGVjaXNpb25FdmlkZW5jZSB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3RhZ2VPdXRwdXQgPSBhd2FpdCBydW5TdGFnZShub2RlLCBzdGFnZUZ1bmMsIGNvbnRleHQsIGJyZWFrRm4pO1xuICAgICAgLy8gRGV0ZWN0IERlY2lzaW9uUmVzdWx0IGZyb20gZGVjaWRlKCkgaGVscGVyIHZpYSBTeW1ib2wgYnJhbmRcbiAgICAgIGlmIChzdGFnZU91dHB1dCAmJiB0eXBlb2Ygc3RhZ2VPdXRwdXQgPT09ICdvYmplY3QnICYmIFJlZmxlY3QuaGFzKHN0YWdlT3V0cHV0IGFzIG9iamVjdCwgREVDSVNJT05fUkVTVUxUKSkge1xuICAgICAgICBicmFuY2hJZCA9IChzdGFnZU91dHB1dCBhcyBhbnkpLmJyYW5jaDtcbiAgICAgICAgZGVjaXNpb25FdmlkZW5jZSA9IChzdGFnZU91dHB1dCBhcyBhbnkpLmV2aWRlbmNlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYnJhbmNoSWQgPSBTdHJpbmcoc3RhZ2VPdXRwdXQpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIC8vIFBhdXNlU2lnbmFsIGlzIGV4cGVjdGVkIGNvbnRyb2wgZmxvdyDigJQgY29tbWl0IGFuZCByZS10aHJvdyB3aXRob3V0IGVycm9yIGxvZ2dpbmcuXG4gICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgY29udGV4dC5jb21taXQoKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3IgfSk7XG4gICAgICBjb250ZXh0LmFkZEVycm9yKCdzdGFnZUV4ZWN1dGlvbkVycm9yJywgZXJyb3IudG9TdHJpbmcoKSk7XG4gICAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uRXJyb3Iobm9kZS5uYW1lLCBlcnJvci50b1N0cmluZygpLCBlcnJvciwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG5cbiAgICBjb250ZXh0LmNvbW1pdCgpO1xuXG4gICAgaWYgKGJyZWFrRmxhZy5zaG91bGRCcmVhaykge1xuICAgICAgcmV0dXJuIHsga2luZDogJ2JyZWFrJywgYnJhbmNoSWQgfTtcbiAgICB9XG5cbiAgICAvLyBSZXNvbHZlIGNoaWxkIGJ5IG1hdGNoaW5nIGJyYW5jaCBJRCBhZ2FpbnN0IG5vZGUuY2hpbGRyZW4uXG4gICAgLy8gTWF0Y2ggYnJhbmNoSWQgZmlyc3QgKG9yaWdpbmFsIHVucHJlZml4ZWQgSUQpLCBmYWxsIGJhY2sgdG8gaWQgZm9yIGJhY2t3YXJkIGNvbXBhdC5cbiAgICBjb25zdCBjaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4gYXMgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT5bXTtcbiAgICBsZXQgY2hvc2VuID0gY2hpbGRyZW4uZmluZCgoY2hpbGQpID0+IChjaGlsZC5icmFuY2hJZCA/PyBjaGlsZC5pZCkgPT09IGJyYW5jaElkKTtcblxuICAgIC8vIEZhbGwgYmFjayB0byBkZWZhdWx0IGJyYW5jaFxuICAgIGlmICghY2hvc2VuKSB7XG4gICAgICBjb25zdCBkZWZhdWx0Q2hpbGQgPSBjaGlsZHJlbi5maW5kKChjaGlsZCkgPT4gKGNoaWxkLmJyYW5jaElkID8/IGNoaWxkLmlkKSA9PT0gJ2RlZmF1bHQnKTtcbiAgICAgIGlmIChkZWZhdWx0Q2hpbGQpIHtcbiAgICAgICAgY2hvc2VuID0gZGVmYXVsdENoaWxkO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFNjb3BlLWJhc2VkIGRlY2lkZXIgJyR7bm9kZS5uYW1lfScgcmV0dXJuZWQgYnJhbmNoIElEICcke2JyYW5jaElkfScgd2hpY2ggZG9lc24ndCBtYXRjaCBhbnkgY2hpbGQgYW5kIG5vIGRlZmF1bHQgYnJhbmNoIGlzIHNldGA7XG4gICAgICAgIGNvbnRleHQuYWRkRXJyb3IoJ2RlY2lkZXJFcnJvcicsIGVycm9yTWVzc2FnZSk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGNob3Nlbk5hbWUgPSBjaG9zZW4ubmFtZTtcbiAgICBjb25zdCB3YXNEZWZhdWx0ID0gKGNob3Nlbi5icmFuY2hJZCA/PyBjaG9zZW4uaWQpICE9PSBicmFuY2hJZDtcbiAgICBjb25zdCByYXRpb25hbGUgPSBjb250ZXh0LmRlYnVnPy5sb2dDb250ZXh0Py5kZWNpZGVyUmF0aW9uYWxlIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgYnJhbmNoUmVhc29uOiBzdHJpbmc7XG4gICAgaWYgKHdhc0RlZmF1bHQpIHtcbiAgICAgIGJyYW5jaFJlYXNvbiA9IGBSZXR1cm5lZCAnJHticmFuY2hJZH0nIChubyBtYXRjaCksIGZlbGwgYmFjayB0byBkZWZhdWx0IOKGkiAke2Nob3Nlbk5hbWV9IHBhdGguYDtcbiAgICB9IGVsc2UgaWYgKHJhdGlvbmFsZSkge1xuICAgICAgYnJhbmNoUmVhc29uID0gYEJhc2VkIG9uOiAke3JhdGlvbmFsZX0g4oaSIGNob3NlICR7Y2hvc2VuTmFtZX0gcGF0aC5gO1xuICAgIH0gZWxzZSB7XG4gICAgICBicmFuY2hSZWFzb24gPSBgRXZhbHVhdGVkIHNjb3BlIGFuZCByZXR1cm5lZCAnJHticmFuY2hJZH0nIOKGkiBjaG9zZSAke2Nob3Nlbk5hbWV9IHBhdGguYDtcbiAgICB9XG4gICAgY29udGV4dC5hZGRGbG93RGVidWdNZXNzYWdlKCdicmFuY2gnLCBicmFuY2hSZWFzb24sIHtcbiAgICAgIHRhcmdldFN0YWdlOiBjaG9zZW4ubmFtZSxcbiAgICAgIHJhdGlvbmFsZTogcmF0aW9uYWxlIHx8IGByZXR1cm5lZCBicmFuY2hJZDogJHticmFuY2hJZH1gLFxuICAgIH0pO1xuXG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkRlY2lzaW9uKFxuICAgICAgbm9kZS5uYW1lLFxuICAgICAgY2hvc2VuLm5hbWUsXG4gICAgICByYXRpb25hbGUsXG4gICAgICBub2RlLmRlc2NyaXB0aW9uLFxuICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgIGRlY2lzaW9uRXZpZGVuY2UsXG4gICAgKTtcbiAgICAvLyBQcm9wb3NhbCAjMDAzOiBmaXJlIG9uU3RhZ2VFeGVjdXRlZCBBRlRFUiB0aGUgc3BlY2lhbGl6ZWQgZXZlbnRcbiAgICAvLyBzbyBjb25zdW1lcnMgdHJhY2tpbmcgXCJkaWQgdGhpcyBzdGFnZSBydW5cIiB3b3JrIHVuaWZvcm1seS5cbiAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uU3RhZ2VFeGVjdXRlZChub2RlLm5hbWUsIG5vZGUuZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQsICdkZWNpZGVyJyk7XG5cbiAgICBjb25zdCBicmFuY2hDb250ZXh0ID0gY29udGV4dC5jcmVhdGVDaGlsZChicmFuY2hQYXRoIGFzIHN0cmluZywgY2hvc2VuLmlkLCBjaG9zZW4ubmFtZSwgY2hvc2VuLmlkKTtcblxuICAgIHJldHVybiB7IGtpbmQ6ICdkaXNwYXRjaCcsIGNob3NlbiwgYnJhbmNoQ29udGV4dCB9O1xuICB9XG59XG4iXX0=