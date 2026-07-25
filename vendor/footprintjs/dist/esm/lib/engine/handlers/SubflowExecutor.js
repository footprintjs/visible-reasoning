/**
 * SubflowExecutor — Isolation boundary for subflow execution.
 *
 * Responsibilities:
 * - Create isolated ExecutionRuntime for each subflow
 * - Apply input/output mapping via SubflowInputMapper
 * - Delegate traversal to a factory-created FlowchartTraverser
 * - Track subflow results for debugging/visualization
 *
 * Each subflow gets its own GlobalStore for isolation.
 * Traversal uses the SAME 7-phase algorithm as the top-level traverser
 * (via SubflowTraverserFactory), so deciders, selectors, loops, lazy subflows,
 * and abort signals all work inside subflows automatically.
 */
import { isPauseSignal } from '../../pause/types.js';
import { applyOutputMapping, getInitialScopeValues, seedSubflowGlobalStore } from './SubflowInputMapper.js';
export class SubflowExecutor {
    deps;
    traverserFactory;
    constructor(deps, traverserFactory) {
        this.deps = deps;
        this.traverserFactory = traverserFactory;
    }
    /**
     * Execute a subflow with isolated context.
     *
     * 1. Creates a fresh ExecutionRuntime for the subflow
     * 2. Applies input mapping to seed the subflow's GlobalStore
     * 3. Delegates traversal to a factory-created FlowchartTraverser
     * 4. Applies output mapping to write results back to parent scope
     * 5. Stores execution data for debugging/visualization
     */
    async executeSubflow(node, parentContext, breakFlag, branchPath, subflowResultsMap, parentTraversalContext) {
        const subflowId = node.subflowId;
        const subflowName = node.subflowName ?? node.name;
        parentContext.addFlowDebugMessage('subflow', `Entering ${subflowName} subflow`, {
            targetStage: subflowId,
        });
        // ─── Input Mapping ───
        //
        // RESUME PATH NOTE: when `deps.subflowStatesForResume` carries a
        // capture for THIS subflow id, we SKIP the inputMapper entirely.
        // The capture is the post-input pre-pause memory — running the
        // mapper again would clobber post-input writes (history,
        // pausedToolCallId, etc.) with the parent's start-of-subflow view.
        const mountOptions = node.subflowMountOptions;
        let mappedInput = {};
        const resumeCapture = this.deps.subflowStatesForResume?.[subflowId];
        const isResumeForThisSubflow = resumeCapture !== undefined;
        if (mountOptions && !isResumeForThisSubflow) {
            try {
                const parentScope = parentContext.getScope();
                mappedInput = getInitialScopeValues(parentScope, mountOptions);
                if (Object.keys(mappedInput).length > 0) {
                    // mappedInput is captured in SubflowResult.treeContext for debugging
                }
            }
            catch (error) {
                parentContext.addError('inputMapperError', error.toString());
                this.deps.logger.error(`Error in inputMapper for subflow (${subflowId}):`, { error });
                throw error;
            }
        }
        // Narrative receives mapped input. inputMapper is a consumer function that may inject
        // values not from the scope (bypassing redaction). The recorder renders per includeValues.
        const narrativeInput = mappedInput;
        // `FlowSubflowEvent.description` is semantically "what this subflow does" — sourced from
        // the subflow's own root stage, not the parent mount point. The mount node never carries
        // a description (builders don't copy it), so reading `node.description` here returns
        // `undefined` and taxonomy markers set on the subflow root (e.g. agentfootprint's
        // `'Agent: ReAct loop'` / `'LLMCall: one-shot'`) never reach downstream consumers.
        const rootDescription = this.deps.subflows?.[subflowId]?.root?.description;
        this.deps.narrativeGenerator.onSubflowEntry(subflowName, subflowId, rootDescription ?? node.description, parentTraversalContext, narrativeInput);
        // Proposal #003: fire onStageExecuted for the mount node AFTER
        // onSubflowEntry so consumers tracking "did this stage run" work
        // uniformly across linear / decider / fork / selector / subflow-mount.
        // Fires on ENTRY (not exit) — entry = "this mount ran"; the
        // subflow's children execute after as separate stages.
        this.deps.narrativeGenerator.onStageExecuted(node.name, rootDescription ?? node.description, parentTraversalContext, 'subflow-mount');
        // Create isolated runtime via dynamic construction (avoids circular import)
        const ExecutionRuntimeClass = this.deps.executionRuntime.constructor;
        const nestedRuntime = new ExecutionRuntimeClass(node.name, node.id);
        let nestedRootContext = nestedRuntime.rootStageContext;
        // Seed GlobalStore with the right shape for the path:
        //   • Resume into THIS subflow → seed from the captured pre-pause
        //     scope so resume handlers see history, pausedToolCallId, etc.
        //   • Normal entry → seed from the inputMapper's mappedInput.
        const seedValues = isResumeForThisSubflow ? resumeCapture : mappedInput;
        if (Object.keys(seedValues).length > 0) {
            seedSubflowGlobalStore(nestedRuntime, seedValues);
            // Refresh rootStageContext so WriteBuffer sees committed data
            const StageContextClass = nestedRootContext.constructor;
            nestedRootContext = new StageContextClass('', nestedRootContext.stageName, nestedRootContext.stageId, nestedRuntime.globalStore, '', nestedRuntime.executionHistory);
            nestedRuntime.rootStageContext = nestedRootContext;
        }
        // Read-tracking policy (#14): subflows get an ISOLATED runtime, so the
        // executor-level policy doesn't reach them via the root context chain.
        // Inherit it from the parent-mount context (which inherited it from ITS
        // root via createNext/createChild) — applied to the FINAL nested root,
        // after the seeding block above may have replaced it. Nested subflows
        // chain the same way, one hop per mount. Optional-chained because this
        // section is duck-typed by design (dynamic construction to avoid the
        // circular import) — and skipped at the default 'full', where the fresh
        // nested context is already correct, so the default path does zero work.
        const parentReadTracking = parentContext.getReadTracking?.();
        if (parentReadTracking !== undefined && parentReadTracking !== 'full') {
            nestedRootContext.useReadTracking(parentReadTracking);
        }
        // Write-tracking policy (#13c-A): same inheritance hop as readTracking
        // above — subflow runtimes are isolated, so the parent-mount context's
        // mode is pushed into the FINAL nested root with the same duck-type
        // guard and the same skip-at-default fast path.
        const parentWriteTracking = parentContext.getWriteTracking?.();
        if (parentWriteTracking !== undefined && parentWriteTracking !== 'full') {
            nestedRootContext.useWriteTracking(parentWriteTracking);
        }
        // Commit-values encoding (#13c-B): same inheritance hop as the two
        // tracking dials above — subflow runtimes are isolated, so the
        // parent-mount context's mode is pushed into the FINAL nested root with
        // the same duck-type guard and the same skip-at-default fast path, so
        // nested charts commit in the same encoding as the parent.
        const parentCommitValues = parentContext.getCommitValues?.();
        if (parentCommitValues !== undefined && parentCommitValues !== 'full') {
            nestedRootContext.useCommitValues(parentCommitValues);
        }
        // Per-write read provenance (#P1): fourth dial, same inheritance hop —
        // duck-type guard, skip-at-default ('off') fast path, so nested charts
        // stamp TraceEntry.readKeys exactly when the parent does.
        const parentWriteProvenance = parentContext.getWriteProvenance?.();
        if (parentWriteProvenance !== undefined && parentWriteProvenance !== 'off') {
            nestedRootContext.useWriteProvenance(parentWriteProvenance);
        }
        // Prepare subflow root node — strip isSubflowRoot to prevent re-delegation.
        //
        // PRESERVE `next`. Earlier revisions stripped `next` whenever the
        // subflow root had children, on the assumption that `next` was
        // always the OUTER mount's continuation leaking into the inner
        // tree. That assumption was wrong: the resolved subflow root's
        // `next` is the INNER join stage (e.g., Parallel's Merge after a
        // fan-out, ToT's Pruner). Stripping it broke composite subflows —
        // the join stage never ran, so the subflow returned partial state.
        //
        // The outer mount's post-subflow continuation is handled separately
        // by the parent traverser via `parentContext.nextNode` and is never
        // conflated with the inner subflow's `next` chain.
        const subflowNode = {
            ...node,
            isSubflowRoot: false,
        };
        // ─── Execute via factory traverser ───
        // The factory creates a full FlowchartTraverser with the same 7-phase algorithm,
        // sharing the parent's stageMap, subflows dict, and narrative generator.
        let subflowOutput;
        let subflowError;
        let traverserHandle;
        try {
            traverserHandle = this.traverserFactory({
                root: subflowNode,
                executionRuntime: nestedRuntime,
                readOnlyContext: mappedInput,
                subflowId,
                // RFC-003 D1: the mount stage's runtimeStageId — the subflow root
                // stage's `parentRuntimeStageId` so ancestor chains cross the mount.
                parentMountRuntimeStageId: parentTraversalContext?.runtimeStageId,
            });
            subflowOutput = await traverserHandle.execute();
        }
        catch (error) {
            // PauseSignal is not an error — prepend subflow ID and re-throw
            // immediately. No error logging, no subflowResult recording —
            // the pause is control flow.
            //
            // BEFORE re-throw, snapshot the nested runtime's `sharedState`
            // onto the signal. This is the only chance — once we re-throw,
            // the outer traverser unwinds and the nested runtime is GC'd. On
            // resume, we'll re-seed a fresh nested runtime from this capture
            // so resume handlers can read the pre-pause subflow scope.
            //
            // Capture is keyed by the SAME path-prefixed `subflowId` used in
            // `subflowPath`, so resume can look up "scope for sf-foo" by id.
            if (isPauseSignal(error)) {
                try {
                    const snap = nestedRuntime.getSnapshot();
                    // `sharedState` is the subflow's working memory at pause
                    // time (after every committed write up to the pause). Cast
                    // is safe — SharedMemory snapshot returns a plain object.
                    error.captureSubflowScope(subflowId, snap.sharedState);
                }
                catch {
                    // Snapshot failure shouldn't mask the pause — let the pause
                    // bubble up; resume will fall back to checkpoint.sharedState
                    // (the parent scope) for this subflow's keys.
                }
                error.prependSubflow(subflowId);
                throw error;
            }
            subflowError = error;
            parentContext.addError('subflowError', error.toString());
            this.deps.logger.error(`Error in subflow (${subflowId}):`, { error });
        }
        // Always merge nested subflow results (even on error — partial results aid debugging)
        if (traverserHandle) {
            for (const [key, value] of traverserHandle.getSubflowResults()) {
                subflowResultsMap.set(key, value);
            }
        }
        // ─── Break propagation (opt-in via SubflowMountOptions.propagateBreak) ──
        //
        // If the subflow's inner traversal broke (because a stage called
        // `scope.$break(reason)`) AND the mount declared `propagateBreak: true`,
        // forward the break state to the PARENT's breakFlag. The parent
        // traverser will see `shouldBreak` on its next step and stop.
        //
        // Without this, inner breaks are locally scoped to the subflow — the
        // parent continues as if the subflow returned normally.
        //
        // IMPORTANT: this runs BEFORE `outputMapping` below, intentionally. The
        // outputMapper still executes, so the subflow's partial result still
        // lands in the parent scope. Consumers who need to suppress output on
        // break check the break state inside their outputMapper and early-return.
        // See `SubflowMountOptions.propagateBreak` JSDoc for rationale.
        if (traverserHandle && mountOptions?.propagateBreak === true) {
            const innerBreak = traverserHandle.getBreakState();
            if (innerBreak.shouldBreak) {
                breakFlag.shouldBreak = true;
                if (innerBreak.reason !== undefined && breakFlag.reason === undefined) {
                    breakFlag.reason = innerBreak.reason;
                }
                // Raise a parent-level onBreak event so recorders can distinguish
                // the inner originating break (fired inside the subflow) from this
                // propagated one (fired at the mount level on the parent).
                this.deps.narrativeGenerator.onBreak(subflowName, parentTraversalContext, innerBreak.reason, subflowId);
            }
        }
        const subflowTreeContext = nestedRuntime.getSnapshot();
        // ─── Output Mapping ───
        if (!subflowError && mountOptions?.outputMapper) {
            try {
                let outputContext = parentContext;
                if (parentContext.branchId && parentContext.branchId !== '' && parentContext.parent) {
                    outputContext = parentContext.parent;
                }
                const parentScope = outputContext.getScope();
                // For TypedScope subflows, stage functions return void — fall back to a shallow clone
                // of the subflow's shared state so outputMapper can access all scope values written
                // during the subflow. We shallow-clone to avoid aliasing the live SharedMemory context.
                // NOTE: the full scope is passed (not just declared outputs) — outputMapper must
                // explicitly select what to propagate to the parent.
                // Redaction: the subflow shares the parent's _redactedKeys Set (via the same ScopeFactory),
                // so any key marked redacted in the subflow is already visible in the parent's scope.
                // ScopeFacade.setValue checks _redactedKeys.has(key), so writes via outputMapper
                // automatically inherit the subflow's dynamic redaction state.
                const effectiveOutput = subflowOutput ?? { ...subflowTreeContext.sharedState };
                const mappedOutput = applyOutputMapping(effectiveOutput, parentScope, outputContext, mountOptions);
                outputContext.commit();
            }
            catch (error) {
                parentContext.addError('outputMapperError', error.toString());
                this.deps.logger.error(`Error in outputMapper for subflow (${subflowId}):`, { error });
            }
        }
        const subflowResult = {
            subflowId,
            subflowName,
            treeContext: {
                globalContext: subflowTreeContext.sharedState,
                stageContexts: subflowTreeContext.executionTree,
                history: subflowTreeContext.commitLog,
            },
            parentStageId: parentContext.getStageId(),
        };
        const subflowDef = this.deps.subflows?.[subflowId];
        if (subflowDef && subflowDef.buildTimeStructure) {
            subflowResult.pipelineStructure = subflowDef.buildTimeStructure;
        }
        subflowResultsMap.set(subflowId, subflowResult);
        // Additive per-execution key (design: docs/design/subflow-commit-visibility.md). A LOOPING
        // subflow re-enters with the SAME subflowId, so the path key above is OVERWRITTEN each
        // iteration (back-compat: it holds the LAST iteration — what getSubtreeSnapshot/listSubflowPaths
        // and the eui fallback see, unchanged). ALSO key by the mount's UNIQUE runtimeStageId so EVERY
        // iteration's result is retained and addressable (eui per-loop drill-down, per-scope localization).
        // runtimeStageId always contains '#'; subflowId never does — so they never collide, and
        // listSubflowPaths filters '#' keys to keep its path-only contract. The pause checkpoint filters
        // these out (buildPauseCheckpoint) so it stays lean.
        const mountRuntimeStageId = parentTraversalContext?.runtimeStageId;
        if (mountRuntimeStageId && mountRuntimeStageId !== subflowId) {
            subflowResultsMap.set(mountRuntimeStageId, subflowResult);
        }
        parentContext.addFlowDebugMessage('subflow', `Exiting ${subflowName} subflow`, {
            targetStage: subflowId,
        });
        this.deps.narrativeGenerator.onSubflowExit(subflowName, subflowId, parentTraversalContext, subflowResult.treeContext?.globalContext);
        parentContext.commit();
        if (subflowError) {
            throw subflowError;
        }
        return subflowOutput;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3ViZmxvd0V4ZWN1dG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvU3ViZmxvd0V4ZWN1dG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7O0dBYUc7QUFHSCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFVckQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLHFCQUFxQixFQUFFLHNCQUFzQixFQUFFLE1BQU0seUJBQXlCLENBQUM7QUFHNUcsTUFBTSxPQUFPLGVBQWU7SUFFaEI7SUFDQTtJQUZWLFlBQ1UsSUFBK0IsRUFDL0IsZ0JBQXVEO1FBRHZELFNBQUksR0FBSixJQUFJLENBQTJCO1FBQy9CLHFCQUFnQixHQUFoQixnQkFBZ0IsQ0FBdUM7SUFDOUQsQ0FBQztJQUVKOzs7Ozs7OztPQVFHO0lBQ0gsS0FBSyxDQUFDLGNBQWMsQ0FDbEIsSUFBNkIsRUFDN0IsYUFBMkIsRUFDM0IsU0FBb0IsRUFDcEIsVUFBOEIsRUFDOUIsaUJBQTZDLEVBQzdDLHNCQUF5QztRQUV6QyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsU0FBVSxDQUFDO1FBQ2xDLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxXQUFXLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQztRQUVsRCxhQUFhLENBQUMsbUJBQW1CLENBQUMsU0FBUyxFQUFFLFlBQVksV0FBVyxVQUFVLEVBQUU7WUFDOUUsV0FBVyxFQUFFLFNBQVM7U0FDdkIsQ0FBQyxDQUFDO1FBRUgsd0JBQXdCO1FBQ3hCLEVBQUU7UUFDRixpRUFBaUU7UUFDakUsaUVBQWlFO1FBQ2pFLCtEQUErRDtRQUMvRCx5REFBeUQ7UUFDekQsbUVBQW1FO1FBQ25FLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxtQkFBbUIsQ0FBQztRQUM5QyxJQUFJLFdBQVcsR0FBNEIsRUFBRSxDQUFDO1FBQzlDLE1BQU0sYUFB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MkZBQTJGO1FBQzNGLHVGQUF1RjtRQUN2RixpR0FBaUc7UUFDakcsK0ZBQStGO1FBQy9GLG9HQUFvRztRQUNwRyx3RkFBd0Y7UUFDeEYsaUdBQWlHO1FBQ2pHLHFEQUFxRDtRQUNyRCxNQUFNLG1CQUFtQixHQUFHLHNCQUFzQixFQUFFLGNBQWMsQ0FBQztRQUNuRSxJQUFJLG1CQUFtQixJQUFJLG1CQUFtQixLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzdELGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsRUFBRSxhQUFhLENBQUMsQ0FBQztRQUM1RCxDQUFDO1FBRUQsYUFBYSxDQUFDLG1CQUFtQixDQUFDLFNBQVMsRUFBRSxXQUFXLFdBQVcsVUFBVSxFQUFFO1lBQzdFLFdBQVcsRUFBRSxTQUFTO1NBQ3ZCLENBQUMsQ0FBQztRQUNILElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsYUFBYSxDQUN4QyxXQUFXLEVBQ1gsU0FBUyxFQUNULHNCQUFzQixFQUN0QixhQUFhLENBQUMsV0FBVyxFQUFFLGFBQWEsQ0FDekMsQ0FBQztRQUVGLGFBQWEsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUV2QixJQUFJLFlBQVksRUFBRSxDQUFDO1lBQ2pCLE1BQU0sWUFBWSxDQUFDO1FBQ3JCLENBQUM7UUFFRCxPQUFPLGFBQWEsQ0FBQztJQUN2QixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN1YmZsb3dFeGVjdXRvciDigJQgSXNvbGF0aW9uIGJvdW5kYXJ5IGZvciBzdWJmbG93IGV4ZWN1dGlvbi5cbiAqXG4gKiBSZXNwb25zaWJpbGl0aWVzOlxuICogLSBDcmVhdGUgaXNvbGF0ZWQgRXhlY3V0aW9uUnVudGltZSBmb3IgZWFjaCBzdWJmbG93XG4gKiAtIEFwcGx5IGlucHV0L291dHB1dCBtYXBwaW5nIHZpYSBTdWJmbG93SW5wdXRNYXBwZXJcbiAqIC0gRGVsZWdhdGUgdHJhdmVyc2FsIHRvIGEgZmFjdG9yeS1jcmVhdGVkIEZsb3djaGFydFRyYXZlcnNlclxuICogLSBUcmFjayBzdWJmbG93IHJlc3VsdHMgZm9yIGRlYnVnZ2luZy92aXN1YWxpemF0aW9uXG4gKlxuICogRWFjaCBzdWJmbG93IGdldHMgaXRzIG93biBHbG9iYWxTdG9yZSBmb3IgaXNvbGF0aW9uLlxuICogVHJhdmVyc2FsIHVzZXMgdGhlIFNBTUUgNy1waGFzZSBhbGdvcml0aG0gYXMgdGhlIHRvcC1sZXZlbCB0cmF2ZXJzZXJcbiAqICh2aWEgU3ViZmxvd1RyYXZlcnNlckZhY3RvcnkpLCBzbyBkZWNpZGVycywgc2VsZWN0b3JzLCBsb29wcywgbGF6eSBzdWJmbG93cyxcbiAqIGFuZCBhYm9ydCBzaWduYWxzIGFsbCB3b3JrIGluc2lkZSBzdWJmbG93cyBhdXRvbWF0aWNhbGx5LlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlU2lnbmFsIH0gZnJvbSAnLi4vLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBUcmF2ZXJzYWxDb250ZXh0IH0gZnJvbSAnLi4vbmFycmF0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgSGFuZGxlckRlcHMsXG4gIElFeGVjdXRpb25SdW50aW1lLFxuICBTdWJmbG93UmVzdWx0LFxuICBTdWJmbG93VHJhdmVyc2VyRmFjdG9yeSxcbiAgU3ViZmxvd1RyYXZlcnNlckhhbmRsZSxcbn0gZnJvbSAnLi4vdHlwZXMuanMnO1xuaW1wb3J0IHsgYXBwbHlPdXRwdXRNYXBwaW5nLCBnZXRJbml0aWFsU2NvcGVWYWx1ZXMsIHNlZWRTdWJmbG93R2xvYmFsU3RvcmUgfSBmcm9tICcuL1N1YmZsb3dJbnB1dE1hcHBlci5qcyc7XG5pbXBvcnQgdHlwZSB7IEJyZWFrRmxhZyB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgU3ViZmxvd0V4ZWN1dG9yPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4sXG4gICAgcHJpdmF0ZSB0cmF2ZXJzZXJGYWN0b3J5OiBTdWJmbG93VHJhdmVyc2VyRmFjdG9yeTxUT3V0LCBUU2NvcGU+LFxuICApIHt9XG5cbiAgLyoqXG4gICAqIEV4ZWN1dGUgYSBzdWJmbG93IHdpdGggaXNvbGF0ZWQgY29udGV4dC5cbiAgICpcbiAgICogMS4gQ3JlYXRlcyBhIGZyZXNoIEV4ZWN1dGlvblJ1bnRpbWUgZm9yIHRoZSBzdWJmbG93XG4gICAqIDIuIEFwcGxpZXMgaW5wdXQgbWFwcGluZyB0byBzZWVkIHRoZSBzdWJmbG93J3MgR2xvYmFsU3RvcmVcbiAgICogMy4gRGVsZWdhdGVzIHRyYXZlcnNhbCB0byBhIGZhY3RvcnktY3JlYXRlZCBGbG93Y2hhcnRUcmF2ZXJzZXJcbiAgICogNC4gQXBwbGllcyBvdXRwdXQgbWFwcGluZyB0byB3cml0ZSByZXN1bHRzIGJhY2sgdG8gcGFyZW50IHNjb3BlXG4gICAqIDUuIFN0b3JlcyBleGVjdXRpb24gZGF0YSBmb3IgZGVidWdnaW5nL3Zpc3VhbGl6YXRpb25cbiAgICovXG4gIGFzeW5jIGV4ZWN1dGVTdWJmbG93KFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIHBhcmVudENvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBicmVha0ZsYWc6IEJyZWFrRmxhZyxcbiAgICBicmFuY2hQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgc3ViZmxvd1Jlc3VsdHNNYXA6IE1hcDxzdHJpbmcsIFN1YmZsb3dSZXN1bHQ+LFxuICAgIHBhcmVudFRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IHN1YmZsb3dJZCA9IG5vZGUuc3ViZmxvd0lkITtcbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG5vZGUuc3ViZmxvd05hbWUgPz8gbm9kZS5uYW1lO1xuXG4gICAgcGFyZW50Q29udGV4dC5hZGRGbG93RGVidWdNZXNzYWdlKCdzdWJmbG93JywgYEVudGVyaW5nICR7c3ViZmxvd05hbWV9IHN1YmZsb3dgLCB7XG4gICAgICB0YXJnZXRTdGFnZTogc3ViZmxvd0lkLFxuICAgIH0pO1xuXG4gICAgLy8g4pSA4pSA4pSAIElucHV0IE1hcHBpbmcg4pSA4pSA4pSAXG4gICAgLy9cbiAgICAvLyBSRVNVTUUgUEFUSCBOT1RFOiB3aGVuIGBkZXBzLnN1YmZsb3dTdGF0ZXNGb3JSZXN1bWVgIGNhcnJpZXMgYVxuICAgIC8vIGNhcHR1cmUgZm9yIFRISVMgc3ViZmxvdyBpZCwgd2UgU0tJUCB0aGUgaW5wdXRNYXBwZXIgZW50aXJlbHkuXG4gICAgLy8gVGhlIGNhcHR1cmUgaXMgdGhlIHBvc3QtaW5wdXQgcHJlLXBhdXNlIG1lbW9yeSDigJQgcnVubmluZyB0aGVcbiAgICAvLyBtYXBwZXIgYWdhaW4gd291bGQgY2xvYmJlciBwb3N0LWlucHV0IHdyaXRlcyAoaGlzdG9yeSxcbiAgICAvLyBwYXVzZWRUb29sQ2FsbElkLCBldGMuKSB3aXRoIHRoZSBwYXJlbnQncyBzdGFydC1vZi1zdWJmbG93IHZpZXcuXG4gICAgY29uc3QgbW91bnRPcHRpb25zID0gbm9kZS5zdWJmbG93TW91bnRPcHRpb25zO1xuICAgIGxldCBtYXBwZWRJbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICBjb25zdCByZXN1bWVDYXB0dXJlID0gdGhpcy5kZXBzLnN1YmZsb3dTdGF0ZXNGb3JSZXN1bWU/LltzdWJmbG93SWRdO1xuICAgIGNvbnN0IGlzUmVzdW1lRm9yVGhpc1N1YmZsb3cgPSByZXN1bWVDYXB0dXJlICE9PSB1bmRlZmluZWQ7XG5cbiAgICBpZiAobW91bnRPcHRpb25zICYmICFpc1Jlc3VtZUZvclRoaXNTdWJmbG93KSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJlbnRTY29wZSA9IHBhcmVudENvbnRleHQuZ2V0U2NvcGUoKTtcbiAgICAgICAgbWFwcGVkSW5wdXQgPSBnZXRJbml0aWFsU2NvcGVWYWx1ZXMocGFyZW50U2NvcGUsIG1vdW50T3B0aW9ucyk7XG4gICAgICAgIGlmIChPYmplY3Qua2V5cyhtYXBwZWRJbnB1dCkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIC8vIG1hcHBlZElucHV0IGlzIGNhcHR1cmVkIGluIFN1YmZsb3dSZXN1bHQudHJlZUNvbnRleHQgZm9yIGRlYnVnZ2luZ1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgIHBhcmVudENvbnRleHQuYWRkRXJyb3IoJ2lucHV0TWFwcGVyRXJyb3InLCBlcnJvci50b1N0cmluZygpKTtcbiAgICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gaW5wdXRNYXBwZXIgZm9yIHN1YmZsb3cgKCR7c3ViZmxvd0lkfSk6YCwgeyBlcnJvciB9KTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gTmFycmF0aXZlIHJlY2VpdmVzIG1hcHBlZCBpbnB1dC4gaW5wdXRNYXBwZXIgaXMgYSBjb25zdW1lciBmdW5jdGlvbiB0aGF0IG1heSBpbmplY3RcbiAgICAvLyB2YWx1ZXMgbm90IGZyb20gdGhlIHNjb3BlIChieXBhc3NpbmcgcmVkYWN0aW9uKS4gVGhlIHJlY29yZGVyIHJlbmRlcnMgcGVyIGluY2x1ZGVWYWx1ZXMuXG4gICAgY29uc3QgbmFycmF0aXZlSW5wdXQgPSBtYXBwZWRJbnB1dDtcbiAgICAvLyBgRmxvd1N1YmZsb3dFdmVudC5kZXNjcmlwdGlvbmAgaXMgc2VtYW50aWNhbGx5IFwid2hhdCB0aGlzIHN1YmZsb3cgZG9lc1wiIOKAlCBzb3VyY2VkIGZyb21cbiAgICAvLyB0aGUgc3ViZmxvdydzIG93biByb290IHN0YWdlLCBub3QgdGhlIHBhcmVudCBtb3VudCBwb2ludC4gVGhlIG1vdW50IG5vZGUgbmV2ZXIgY2Fycmllc1xuICAgIC8vIGEgZGVzY3JpcHRpb24gKGJ1aWxkZXJzIGRvbid0IGNvcHkgaXQpLCBzbyByZWFkaW5nIGBub2RlLmRlc2NyaXB0aW9uYCBoZXJlIHJldHVybnNcbiAgICAvLyBgdW5kZWZpbmVkYCBhbmQgdGF4b25vbXkgbWFya2VycyBzZXQgb24gdGhlIHN1YmZsb3cgcm9vdCAoZS5nLiBhZ2VudGZvb3RwcmludCdzXG4gICAgLy8gYCdBZ2VudDogUmVBY3QgbG9vcCdgIC8gYCdMTE1DYWxsOiBvbmUtc2hvdCdgKSBuZXZlciByZWFjaCBkb3duc3RyZWFtIGNvbnN1bWVycy5cbiAgICBjb25zdCByb290RGVzY3JpcHRpb24gPSB0aGlzLmRlcHMuc3ViZmxvd3M/LltzdWJmbG93SWRdPy5yb290Py5kZXNjcmlwdGlvbjtcbiAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uU3ViZmxvd0VudHJ5KFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBzdWJmbG93SWQsXG4gICAgICByb290RGVzY3JpcHRpb24gPz8gbm9kZS5kZXNjcmlwdGlvbixcbiAgICAgIHBhcmVudFRyYXZlcnNhbENvbnRleHQsXG4gICAgICBuYXJyYXRpdmVJbnB1dCxcbiAgICApO1xuICAgIC8vIFByb3Bvc2FsICMwMDM6IGZpcmUgb25TdGFnZUV4ZWN1dGVkIGZvciB0aGUgbW91bnQgbm9kZSBBRlRFUlxuICAgIC8vIG9uU3ViZmxvd0VudHJ5IHNvIGNvbnN1bWVycyB0cmFja2luZyBcImRpZCB0aGlzIHN0YWdlIHJ1blwiIHdvcmtcbiAgICAvLyB1bmlmb3JtbHkgYWNyb3NzIGxpbmVhciAvIGRlY2lkZXIgLyBmb3JrIC8gc2VsZWN0b3IgLyBzdWJmbG93LW1vdW50LlxuICAgIC8vIEZpcmVzIG9uIEVOVFJZIChub3QgZXhpdCkg4oCUIGVudHJ5ID0gXCJ0aGlzIG1vdW50IHJhblwiOyB0aGVcbiAgICAvLyBzdWJmbG93J3MgY2hpbGRyZW4gZXhlY3V0ZSBhZnRlciBhcyBzZXBhcmF0ZSBzdGFnZXMuXG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblN0YWdlRXhlY3V0ZWQoXG4gICAgICBub2RlLm5hbWUsXG4gICAgICByb290RGVzY3JpcHRpb24gPz8gbm9kZS5kZXNjcmlwdGlvbixcbiAgICAgIHBhcmVudFRyYXZlcnNhbENvbnRleHQsXG4gICAgICAnc3ViZmxvdy1tb3VudCcsXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBpc29sYXRlZCBydW50aW1lIHZpYSBkeW5hbWljIGNvbnN0cnVjdGlvbiAoYXZvaWRzIGNpcmN1bGFyIGltcG9ydClcbiAgICBjb25zdCBFeGVjdXRpb25SdW50aW1lQ2xhc3MgPSB0aGlzLmRlcHMuZXhlY3V0aW9uUnVudGltZS5jb25zdHJ1Y3RvciBhcyBuZXcgKFxuICAgICAgbmFtZTogc3RyaW5nLFxuICAgICAgaWQ6IHN0cmluZyxcbiAgICApID0+IElFeGVjdXRpb25SdW50aW1lO1xuICAgIGNvbnN0IG5lc3RlZFJ1bnRpbWUgPSBuZXcgRXhlY3V0aW9uUnVudGltZUNsYXNzKG5vZGUubmFtZSwgbm9kZS5pZCk7XG4gICAgbGV0IG5lc3RlZFJvb3RDb250ZXh0ID0gbmVzdGVkUnVudGltZS5yb290U3RhZ2VDb250ZXh0O1xuXG4gICAgLy8gU2VlZCBHbG9iYWxTdG9yZSB3aXRoIHRoZSByaWdodCBzaGFwZSBmb3IgdGhlIHBhdGg6XG4gICAgLy8gICDigKIgUmVzdW1lIGludG8gVEhJUyBzdWJmbG93IOKGkiBzZWVkIGZyb20gdGhlIGNhcHR1cmVkIHByZS1wYXVzZVxuICAgIC8vICAgICBzY29wZSBzbyByZXN1bWUgaGFuZGxlcnMgc2VlIGhpc3RvcnksIHBhdXNlZFRvb2xDYWxsSWQsIGV0Yy5cbiAgICAvLyAgIOKAoiBOb3JtYWwgZW50cnkg4oaSIHNlZWQgZnJvbSB0aGUgaW5wdXRNYXBwZXIncyBtYXBwZWRJbnB1dC5cbiAgICBjb25zdCBzZWVkVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IGlzUmVzdW1lRm9yVGhpc1N1YmZsb3cgPyByZXN1bWVDYXB0dXJlISA6IG1hcHBlZElucHV0O1xuICAgIGlmIChPYmplY3Qua2V5cyhzZWVkVmFsdWVzKS5sZW5ndGggPiAwKSB7XG4gICAgICBzZWVkU3ViZmxvd0dsb2JhbFN0b3JlKG5lc3RlZFJ1bnRpbWUsIHNlZWRWYWx1ZXMpO1xuICAgICAgLy8gUmVmcmVzaCByb290U3RhZ2VDb250ZXh0IHNvIFdyaXRlQnVmZmVyIHNlZXMgY29tbWl0dGVkIGRhdGFcbiAgICAgIGNvbnN0IFN0YWdlQ29udGV4dENsYXNzID0gbmVzdGVkUm9vdENvbnRleHQuY29uc3RydWN0b3IgYXMgbmV3ICguLi5hcmdzOiBhbnlbXSkgPT4gU3RhZ2VDb250ZXh0O1xuICAgICAgbmVzdGVkUm9vdENvbnRleHQgPSBuZXcgU3RhZ2VDb250ZXh0Q2xhc3MoXG4gICAgICAgICcnLFxuICAgICAgICBuZXN0ZWRSb290Q29udGV4dC5zdGFnZU5hbWUsXG4gICAgICAgIG5lc3RlZFJvb3RDb250ZXh0LnN0YWdlSWQsXG4gICAgICAgIG5lc3RlZFJ1bnRpbWUuZ2xvYmFsU3RvcmUsXG4gICAgICAgICcnLFxuICAgICAgICBuZXN0ZWRSdW50aW1lLmV4ZWN1dGlvbkhpc3RvcnksXG4gICAgICApO1xuICAgICAgbmVzdGVkUnVudGltZS5yb290U3RhZ2VDb250ZXh0ID0gbmVzdGVkUm9vdENvbnRleHQ7XG4gICAgfVxuXG4gICAgLy8gUmVhZC10cmFja2luZyBwb2xpY3kgKCMxNCk6IHN1YmZsb3dzIGdldCBhbiBJU09MQVRFRCBydW50aW1lLCBzbyB0aGVcbiAgICAvLyBleGVjdXRvci1sZXZlbCBwb2xpY3kgZG9lc24ndCByZWFjaCB0aGVtIHZpYSB0aGUgcm9vdCBjb250ZXh0IGNoYWluLlxuICAgIC8vIEluaGVyaXQgaXQgZnJvbSB0aGUgcGFyZW50LW1vdW50IGNvbnRleHQgKHdoaWNoIGluaGVyaXRlZCBpdCBmcm9tIElUU1xuICAgIC8vIHJvb3QgdmlhIGNyZWF0ZU5leHQvY3JlYXRlQ2hpbGQpIOKAlCBhcHBsaWVkIHRvIHRoZSBGSU5BTCBuZXN0ZWQgcm9vdCxcbiAgICAvLyBhZnRlciB0aGUgc2VlZGluZyBibG9jayBhYm92ZSBtYXkgaGF2ZSByZXBsYWNlZCBpdC4gTmVzdGVkIHN1YmZsb3dzXG4gICAgLy8gY2hhaW4gdGhlIHNhbWUgd2F5LCBvbmUgaG9wIHBlciBtb3VudC4gT3B0aW9uYWwtY2hhaW5lZCBiZWNhdXNlIHRoaXNcbiAgICAvLyBzZWN0aW9uIGlzIGR1Y2stdHlwZWQgYnkgZGVzaWduIChkeW5hbWljIGNvbnN0cnVjdGlvbiB0byBhdm9pZCB0aGVcbiAgICAvLyBjaXJjdWxhciBpbXBvcnQpIOKAlCBhbmQgc2tpcHBlZCBhdCB0aGUgZGVmYXVsdCAnZnVsbCcsIHdoZXJlIHRoZSBmcmVzaFxuICAgIC8vIG5lc3RlZCBjb250ZXh0IGlzIGFscmVhZHkgY29ycmVjdCwgc28gdGhlIGRlZmF1bHQgcGF0aCBkb2VzIHplcm8gd29yay5cbiAgICBjb25zdCBwYXJlbnRSZWFkVHJhY2tpbmcgPSBwYXJlbnRDb250ZXh0LmdldFJlYWRUcmFja2luZz8uKCk7XG4gICAgaWYgKHBhcmVudFJlYWRUcmFja2luZyAhPT0gdW5kZWZpbmVkICYmIHBhcmVudFJlYWRUcmFja2luZyAhPT0gJ2Z1bGwnKSB7XG4gICAgICBuZXN0ZWRSb290Q29udGV4dC51c2VSZWFkVHJhY2tpbmcocGFyZW50UmVhZFRyYWNraW5nKTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZS10cmFja2luZyBwb2xpY3kgKCMxM2MtQSk6IHNhbWUgaW5oZXJpdGFuY2UgaG9wIGFzIHJlYWRUcmFja2luZ1xuICAgIC8vIGFib3ZlIOKAlCBzdWJmbG93IHJ1bnRpbWVzIGFyZSBpc29sYXRlZCwgc28gdGhlIHBhcmVudC1tb3VudCBjb250ZXh0J3NcbiAgICAvLyBtb2RlIGlzIHB1c2hlZCBpbnRvIHRoZSBGSU5BTCBuZXN0ZWQgcm9vdCB3aXRoIHRoZSBzYW1lIGR1Y2stdHlwZVxuICAgIC8vIGd1YXJkIGFuZCB0aGUgc2FtZSBza2lwLWF0LWRlZmF1bHQgZmFzdCBwYXRoLlxuICAgIGNvbnN0IHBhcmVudFdyaXRlVHJhY2tpbmcgPSBwYXJlbnRDb250ZXh0LmdldFdyaXRlVHJhY2tpbmc/LigpO1xuICAgIGlmIChwYXJlbnRXcml0ZVRyYWNraW5nICE9PSB1bmRlZmluZWQgJiYgcGFyZW50V3JpdGVUcmFja2luZyAhPT0gJ2Z1bGwnKSB7XG4gICAgICBuZXN0ZWRSb290Q29udGV4dC51c2VXcml0ZVRyYWNraW5nKHBhcmVudFdyaXRlVHJhY2tpbmcpO1xuICAgIH1cblxuICAgIC8vIENvbW1pdC12YWx1ZXMgZW5jb2RpbmcgKCMxM2MtQik6IHNhbWUgaW5oZXJpdGFuY2UgaG9wIGFzIHRoZSB0d29cbiAgICAvLyB0cmFja2luZyBkaWFscyBhYm92ZSDigJQgc3ViZmxvdyBydW50aW1lcyBhcmUgaXNvbGF0ZWQsIHNvIHRoZVxuICAgIC8vIHBhcmVudC1tb3VudCBjb250ZXh0J3MgbW9kZSBpcyBwdXNoZWQgaW50byB0aGUgRklOQUwgbmVzdGVkIHJvb3Qgd2l0aFxuICAgIC8vIHRoZSBzYW1lIGR1Y2stdHlwZSBndWFyZCBhbmQgdGhlIHNhbWUgc2tpcC1hdC1kZWZhdWx0IGZhc3QgcGF0aCwgc29cbiAgICAvLyBuZXN0ZWQgY2hhcnRzIGNvbW1pdCBpbiB0aGUgc2FtZSBlbmNvZGluZyBhcyB0aGUgcGFyZW50LlxuICAgIGNvbnN0IHBhcmVudENvbW1pdFZhbHVlcyA9IHBhcmVudENvbnRleHQuZ2V0Q29tbWl0VmFsdWVzPy4oKTtcbiAgICBpZiAocGFyZW50Q29tbWl0VmFsdWVzICE9PSB1bmRlZmluZWQgJiYgcGFyZW50Q29tbWl0VmFsdWVzICE9PSAnZnVsbCcpIHtcbiAgICAgIG5lc3RlZFJvb3RDb250ZXh0LnVzZUNvbW1pdFZhbHVlcyhwYXJlbnRDb21taXRWYWx1ZXMpO1xuICAgIH1cblxuICAgIC8vIFBlci13cml0ZSByZWFkIHByb3ZlbmFuY2UgKCNQMSk6IGZvdXJ0aCBkaWFsLCBzYW1lIGluaGVyaXRhbmNlIGhvcCDigJRcbiAgICAvLyBkdWNrLXR5cGUgZ3VhcmQsIHNraXAtYXQtZGVmYXVsdCAoJ29mZicpIGZhc3QgcGF0aCwgc28gbmVzdGVkIGNoYXJ0c1xuICAgIC8vIHN0YW1wIFRyYWNlRW50cnkucmVhZEtleXMgZXhhY3RseSB3aGVuIHRoZSBwYXJlbnQgZG9lcy5cbiAgICBjb25zdCBwYXJlbnRXcml0ZVByb3ZlbmFuY2UgPSBwYXJlbnRDb250ZXh0LmdldFdyaXRlUHJvdmVuYW5jZT8uKCk7XG4gICAgaWYgKHBhcmVudFdyaXRlUHJvdmVuYW5jZSAhPT0gdW5kZWZpbmVkICYmIHBhcmVudFdyaXRlUHJvdmVuYW5jZSAhPT0gJ29mZicpIHtcbiAgICAgIG5lc3RlZFJvb3RDb250ZXh0LnVzZVdyaXRlUHJvdmVuYW5jZShwYXJlbnRXcml0ZVByb3ZlbmFuY2UpO1xuICAgIH1cblxuICAgIC8vIFByZXBhcmUgc3ViZmxvdyByb290IG5vZGUg4oCUIHN0cmlwIGlzU3ViZmxvd1Jvb3QgdG8gcHJldmVudCByZS1kZWxlZ2F0aW9uLlxuICAgIC8vXG4gICAgLy8gUFJFU0VSVkUgYG5leHRgLiBFYXJsaWVyIHJldmlzaW9ucyBzdHJpcHBlZCBgbmV4dGAgd2hlbmV2ZXIgdGhlXG4gICAgLy8gc3ViZmxvdyByb290IGhhZCBjaGlsZHJlbiwgb24gdGhlIGFzc3VtcHRpb24gdGhhdCBgbmV4dGAgd2FzXG4gICAgLy8gYWx3YXlzIHRoZSBPVVRFUiBtb3VudCdzIGNvbnRpbnVhdGlvbiBsZWFraW5nIGludG8gdGhlIGlubmVyXG4gICAgLy8gdHJlZS4gVGhhdCBhc3N1bXB0aW9uIHdhcyB3cm9uZzogdGhlIHJlc29sdmVkIHN1YmZsb3cgcm9vdCdzXG4gICAgLy8gYG5leHRgIGlzIHRoZSBJTk5FUiBqb2luIHN0YWdlIChlLmcuLCBQYXJhbGxlbCdzIE1lcmdlIGFmdGVyIGFcbiAgICAvLyBmYW4tb3V0LCBUb1QncyBQcnVuZXIpLiBTdHJpcHBpbmcgaXQgYnJva2UgY29tcG9zaXRlIHN1YmZsb3dzIOKAlFxuICAgIC8vIHRoZSBqb2luIHN0YWdlIG5ldmVyIHJhbiwgc28gdGhlIHN1YmZsb3cgcmV0dXJuZWQgcGFydGlhbCBzdGF0ZS5cbiAgICAvL1xuICAgIC8vIFRoZSBvdXRlciBtb3VudCdzIHBvc3Qtc3ViZmxvdyBjb250aW51YXRpb24gaXMgaGFuZGxlZCBzZXBhcmF0ZWx5XG4gICAgLy8gYnkgdGhlIHBhcmVudCB0cmF2ZXJzZXIgdmlhIGBwYXJlbnRDb250ZXh0Lm5leHROb2RlYCBhbmQgaXMgbmV2ZXJcbiAgICAvLyBjb25mbGF0ZWQgd2l0aCB0aGUgaW5uZXIgc3ViZmxvdydzIGBuZXh0YCBjaGFpbi5cbiAgICBjb25zdCBzdWJmbG93Tm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICAuLi5ub2RlLFxuICAgICAgaXNTdWJmbG93Um9vdDogZmFsc2UsXG4gICAgfTtcblxuICAgIC8vIOKUgOKUgOKUgCBFeGVjdXRlIHZpYSBmYWN0b3J5IHRyYXZlcnNlciDilIDilIDilIBcbiAgICAvLyBUaGUgZmFjdG9yeSBjcmVhdGVzIGEgZnVsbCBGbG93Y2hhcnRUcmF2ZXJzZXIgd2l0aCB0aGUgc2FtZSA3LXBoYXNlIGFsZ29yaXRobSxcbiAgICAvLyBzaGFyaW5nIHRoZSBwYXJlbnQncyBzdGFnZU1hcCwgc3ViZmxvd3MgZGljdCwgYW5kIG5hcnJhdGl2ZSBnZW5lcmF0b3IuXG4gICAgbGV0IHN1YmZsb3dPdXRwdXQ6IGFueTtcbiAgICBsZXQgc3ViZmxvd0Vycm9yOiBFcnJvciB8IHVuZGVmaW5lZDtcbiAgICBsZXQgdHJhdmVyc2VySGFuZGxlOiBTdWJmbG93VHJhdmVyc2VySGFuZGxlPFRPdXQsIFRTY29wZT4gfCB1bmRlZmluZWQ7XG5cbiAgICB0cnkge1xuICAgICAgdHJhdmVyc2VySGFuZGxlID0gdGhpcy50cmF2ZXJzZXJGYWN0b3J5KHtcbiAgICAgICAgcm9vdDogc3ViZmxvd05vZGUsXG4gICAgICAgIGV4ZWN1dGlvblJ1bnRpbWU6IG5lc3RlZFJ1bnRpbWUsXG4gICAgICAgIHJlYWRPbmx5Q29udGV4dDogbWFwcGVkSW5wdXQsXG4gICAgICAgIHN1YmZsb3dJZCxcbiAgICAgICAgLy8gUkZDLTAwMyBEMTogdGhlIG1vdW50IHN0YWdlJ3MgcnVudGltZVN0YWdlSWQg4oCUIHRoZSBzdWJmbG93IHJvb3RcbiAgICAgICAgLy8gc3RhZ2UncyBgcGFyZW50UnVudGltZVN0YWdlSWRgIHNvIGFuY2VzdG9yIGNoYWlucyBjcm9zcyB0aGUgbW91bnQuXG4gICAgICAgIHBhcmVudE1vdW50UnVudGltZVN0YWdlSWQ6IHBhcmVudFRyYXZlcnNhbENvbnRleHQ/LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgfSk7XG5cbiAgICAgIHN1YmZsb3dPdXRwdXQgPSBhd2FpdCB0cmF2ZXJzZXJIYW5kbGUuZXhlY3V0ZSgpO1xuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIC8vIFBhdXNlU2lnbmFsIGlzIG5vdCBhbiBlcnJvciDigJQgcHJlcGVuZCBzdWJmbG93IElEIGFuZCByZS10aHJvd1xuICAgICAgLy8gaW1tZWRpYXRlbHkuIE5vIGVycm9yIGxvZ2dpbmcsIG5vIHN1YmZsb3dSZXN1bHQgcmVjb3JkaW5nIOKAlFxuICAgICAgLy8gdGhlIHBhdXNlIGlzIGNvbnRyb2wgZmxvdy5cbiAgICAgIC8vXG4gICAgICAvLyBCRUZPUkUgcmUtdGhyb3csIHNuYXBzaG90IHRoZSBuZXN0ZWQgcnVudGltZSdzIGBzaGFyZWRTdGF0ZWBcbiAgICAgIC8vIG9udG8gdGhlIHNpZ25hbC4gVGhpcyBpcyB0aGUgb25seSBjaGFuY2Ug4oCUIG9uY2Ugd2UgcmUtdGhyb3csXG4gICAgICAvLyB0aGUgb3V0ZXIgdHJhdmVyc2VyIHVud2luZHMgYW5kIHRoZSBuZXN0ZWQgcnVudGltZSBpcyBHQydkLiBPblxuICAgICAgLy8gcmVzdW1lLCB3ZSdsbCByZS1zZWVkIGEgZnJlc2ggbmVzdGVkIHJ1bnRpbWUgZnJvbSB0aGlzIGNhcHR1cmVcbiAgICAgIC8vIHNvIHJlc3VtZSBoYW5kbGVycyBjYW4gcmVhZCB0aGUgcHJlLXBhdXNlIHN1YmZsb3cgc2NvcGUuXG4gICAgICAvL1xuICAgICAgLy8gQ2FwdHVyZSBpcyBrZXllZCBieSB0aGUgU0FNRSBwYXRoLXByZWZpeGVkIGBzdWJmbG93SWRgIHVzZWQgaW5cbiAgICAgIC8vIGBzdWJmbG93UGF0aGAsIHNvIHJlc3VtZSBjYW4gbG9vayB1cCBcInNjb3BlIGZvciBzZi1mb29cIiBieSBpZC5cbiAgICAgIGlmIChpc1BhdXNlU2lnbmFsKGVycm9yKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHNuYXAgPSBuZXN0ZWRSdW50aW1lLmdldFNuYXBzaG90KCk7XG4gICAgICAgICAgLy8gYHNoYXJlZFN0YXRlYCBpcyB0aGUgc3ViZmxvdydzIHdvcmtpbmcgbWVtb3J5IGF0IHBhdXNlXG4gICAgICAgICAgLy8gdGltZSAoYWZ0ZXIgZXZlcnkgY29tbWl0dGVkIHdyaXRlIHVwIHRvIHRoZSBwYXVzZSkuIENhc3RcbiAgICAgICAgICAvLyBpcyBzYWZlIOKAlCBTaGFyZWRNZW1vcnkgc25hcHNob3QgcmV0dXJucyBhIHBsYWluIG9iamVjdC5cbiAgICAgICAgICBlcnJvci5jYXB0dXJlU3ViZmxvd1Njb3BlKHN1YmZsb3dJZCwgc25hcC5zaGFyZWRTdGF0ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIFNuYXBzaG90IGZhaWx1cmUgc2hvdWxkbid0IG1hc2sgdGhlIHBhdXNlIOKAlCBsZXQgdGhlIHBhdXNlXG4gICAgICAgICAgLy8gYnViYmxlIHVwOyByZXN1bWUgd2lsbCBmYWxsIGJhY2sgdG8gY2hlY2twb2ludC5zaGFyZWRTdGF0ZVxuICAgICAgICAgIC8vICh0aGUgcGFyZW50IHNjb3BlKSBmb3IgdGhpcyBzdWJmbG93J3Mga2V5cy5cbiAgICAgICAgfVxuICAgICAgICBlcnJvci5wcmVwZW5kU3ViZmxvdyhzdWJmbG93SWQpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIHN1YmZsb3dFcnJvciA9IGVycm9yO1xuICAgICAgcGFyZW50Q29udGV4dC5hZGRFcnJvcignc3ViZmxvd0Vycm9yJywgZXJyb3IudG9TdHJpbmcoKSk7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBzdWJmbG93ICgke3N1YmZsb3dJZH0pOmAsIHsgZXJyb3IgfSk7XG4gICAgfVxuXG4gICAgLy8gQWx3YXlzIG1lcmdlIG5lc3RlZCBzdWJmbG93IHJlc3VsdHMgKGV2ZW4gb24gZXJyb3Ig4oCUIHBhcnRpYWwgcmVzdWx0cyBhaWQgZGVidWdnaW5nKVxuICAgIGlmICh0cmF2ZXJzZXJIYW5kbGUpIHtcbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIHRyYXZlcnNlckhhbmRsZS5nZXRTdWJmbG93UmVzdWx0cygpKSB7XG4gICAgICAgIHN1YmZsb3dSZXN1bHRzTWFwLnNldChrZXksIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyDilIDilIDilIAgQnJlYWsgcHJvcGFnYXRpb24gKG9wdC1pbiB2aWEgU3ViZmxvd01vdW50T3B0aW9ucy5wcm9wYWdhdGVCcmVhaykg4pSA4pSAXG4gICAgLy9cbiAgICAvLyBJZiB0aGUgc3ViZmxvdydzIGlubmVyIHRyYXZlcnNhbCBicm9rZSAoYmVjYXVzZSBhIHN0YWdlIGNhbGxlZFxuICAgIC8vIGBzY29wZS4kYnJlYWsocmVhc29uKWApIEFORCB0aGUgbW91bnQgZGVjbGFyZWQgYHByb3BhZ2F0ZUJyZWFrOiB0cnVlYCxcbiAgICAvLyBmb3J3YXJkIHRoZSBicmVhayBzdGF0ZSB0byB0aGUgUEFSRU5UJ3MgYnJlYWtGbGFnLiBUaGUgcGFyZW50XG4gICAgLy8gdHJhdmVyc2VyIHdpbGwgc2VlIGBzaG91bGRCcmVha2Agb24gaXRzIG5leHQgc3RlcCBhbmQgc3RvcC5cbiAgICAvL1xuICAgIC8vIFdpdGhvdXQgdGhpcywgaW5uZXIgYnJlYWtzIGFyZSBsb2NhbGx5IHNjb3BlZCB0byB0aGUgc3ViZmxvdyDigJQgdGhlXG4gICAgLy8gcGFyZW50IGNvbnRpbnVlcyBhcyBpZiB0aGUgc3ViZmxvdyByZXR1cm5lZCBub3JtYWxseS5cbiAgICAvL1xuICAgIC8vIElNUE9SVEFOVDogdGhpcyBydW5zIEJFRk9SRSBgb3V0cHV0TWFwcGluZ2AgYmVsb3csIGludGVudGlvbmFsbHkuIFRoZVxuICAgIC8vIG91dHB1dE1hcHBlciBzdGlsbCBleGVjdXRlcywgc28gdGhlIHN1YmZsb3cncyBwYXJ0aWFsIHJlc3VsdCBzdGlsbFxuICAgIC8vIGxhbmRzIGluIHRoZSBwYXJlbnQgc2NvcGUuIENvbnN1bWVycyB3aG8gbmVlZCB0byBzdXBwcmVzcyBvdXRwdXQgb25cbiAgICAvLyBicmVhayBjaGVjayB0aGUgYnJlYWsgc3RhdGUgaW5zaWRlIHRoZWlyIG91dHB1dE1hcHBlciBhbmQgZWFybHktcmV0dXJuLlxuICAgIC8vIFNlZSBgU3ViZmxvd01vdW50T3B0aW9ucy5wcm9wYWdhdGVCcmVha2AgSlNEb2MgZm9yIHJhdGlvbmFsZS5cbiAgICBpZiAodHJhdmVyc2VySGFuZGxlICYmIG1vdW50T3B0aW9ucz8ucHJvcGFnYXRlQnJlYWsgPT09IHRydWUpIHtcbiAgICAgIGNvbnN0IGlubmVyQnJlYWsgPSB0cmF2ZXJzZXJIYW5kbGUuZ2V0QnJlYWtTdGF0ZSgpO1xuICAgICAgaWYgKGlubmVyQnJlYWsuc2hvdWxkQnJlYWspIHtcbiAgICAgICAgYnJlYWtGbGFnLnNob3VsZEJyZWFrID0gdHJ1ZTtcbiAgICAgICAgaWYgKGlubmVyQnJlYWsucmVhc29uICE9PSB1bmRlZmluZWQgJiYgYnJlYWtGbGFnLnJlYXNvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgYnJlYWtGbGFnLnJlYXNvbiA9IGlubmVyQnJlYWsucmVhc29uO1xuICAgICAgICB9XG4gICAgICAgIC8vIFJhaXNlIGEgcGFyZW50LWxldmVsIG9uQnJlYWsgZXZlbnQgc28gcmVjb3JkZXJzIGNhbiBkaXN0aW5ndWlzaFxuICAgICAgICAvLyB0aGUgaW5uZXIgb3JpZ2luYXRpbmcgYnJlYWsgKGZpcmVkIGluc2lkZSB0aGUgc3ViZmxvdykgZnJvbSB0aGlzXG4gICAgICAgIC8vIHByb3BhZ2F0ZWQgb25lIChmaXJlZCBhdCB0aGUgbW91bnQgbGV2ZWwgb24gdGhlIHBhcmVudCkuXG4gICAgICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25CcmVhayhzdWJmbG93TmFtZSwgcGFyZW50VHJhdmVyc2FsQ29udGV4dCwgaW5uZXJCcmVhay5yZWFzb24sIHN1YmZsb3dJZCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd1RyZWVDb250ZXh0ID0gbmVzdGVkUnVudGltZS5nZXRTbmFwc2hvdCgpO1xuXG4gICAgLy8g4pSA4pSA4pSAIE91dHB1dCBNYXBwaW5nIOKUgOKUgOKUgFxuICAgIGlmICghc3ViZmxvd0Vycm9yICYmIG1vdW50T3B0aW9ucz8ub3V0cHV0TWFwcGVyKSB7XG4gICAgICB0cnkge1xuICAgICAgICBsZXQgb3V0cHV0Q29udGV4dCA9IHBhcmVudENvbnRleHQ7XG4gICAgICAgIGlmIChwYXJlbnRDb250ZXh0LmJyYW5jaElkICYmIHBhcmVudENvbnRleHQuYnJhbmNoSWQgIT09ICcnICYmIHBhcmVudENvbnRleHQucGFyZW50KSB7XG4gICAgICAgICAgb3V0cHV0Q29udGV4dCA9IHBhcmVudENvbnRleHQucGFyZW50O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGFyZW50U2NvcGUgPSBvdXRwdXRDb250ZXh0LmdldFNjb3BlKCk7XG4gICAgICAgIC8vIEZvciBUeXBlZFNjb3BlIHN1YmZsb3dzLCBzdGFnZSBmdW5jdGlvbnMgcmV0dXJuIHZvaWQg4oCUIGZhbGwgYmFjayB0byBhIHNoYWxsb3cgY2xvbmVcbiAgICAgICAgLy8gb2YgdGhlIHN1YmZsb3cncyBzaGFyZWQgc3RhdGUgc28gb3V0cHV0TWFwcGVyIGNhbiBhY2Nlc3MgYWxsIHNjb3BlIHZhbHVlcyB3cml0dGVuXG4gICAgICAgIC8vIGR1cmluZyB0aGUgc3ViZmxvdy4gV2Ugc2hhbGxvdy1jbG9uZSB0byBhdm9pZCBhbGlhc2luZyB0aGUgbGl2ZSBTaGFyZWRNZW1vcnkgY29udGV4dC5cbiAgICAgICAgLy8gTk9URTogdGhlIGZ1bGwgc2NvcGUgaXMgcGFzc2VkIChub3QganVzdCBkZWNsYXJlZCBvdXRwdXRzKSDigJQgb3V0cHV0TWFwcGVyIG11c3RcbiAgICAgICAgLy8gZXhwbGljaXRseSBzZWxlY3Qgd2hhdCB0byBwcm9wYWdhdGUgdG8gdGhlIHBhcmVudC5cbiAgICAgICAgLy8gUmVkYWN0aW9uOiB0aGUgc3ViZmxvdyBzaGFyZXMgdGhlIHBhcmVudCdzIF9yZWRhY3RlZEtleXMgU2V0ICh2aWEgdGhlIHNhbWUgU2NvcGVGYWN0b3J5KSxcbiAgICAgICAgLy8gc28gYW55IGtleSBtYXJrZWQgcmVkYWN0ZWQgaW4gdGhlIHN1YmZsb3cgaXMgYWxyZWFkeSB2aXNpYmxlIGluIHRoZSBwYXJlbnQncyBzY29wZS5cbiAgICAgICAgLy8gU2NvcGVGYWNhZGUuc2V0VmFsdWUgY2hlY2tzIF9yZWRhY3RlZEtleXMuaGFzKGtleSksIHNvIHdyaXRlcyB2aWEgb3V0cHV0TWFwcGVyXG4gICAgICAgIC8vIGF1dG9tYXRpY2FsbHkgaW5oZXJpdCB0aGUgc3ViZmxvdydzIGR5bmFtaWMgcmVkYWN0aW9uIHN0YXRlLlxuICAgICAgICBjb25zdCBlZmZlY3RpdmVPdXRwdXQgPSBzdWJmbG93T3V0cHV0ID8/IHsgLi4uc3ViZmxvd1RyZWVDb250ZXh0LnNoYXJlZFN0YXRlIH07XG4gICAgICAgIGNvbnN0IG1hcHBlZE91dHB1dCA9IGFwcGx5T3V0cHV0TWFwcGluZyhlZmZlY3RpdmVPdXRwdXQsIHBhcmVudFNjb3BlLCBvdXRwdXRDb250ZXh0LCBtb3VudE9wdGlvbnMpO1xuXG4gICAgICAgIG91dHB1dENvbnRleHQuY29tbWl0KCk7XG4gICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgIHBhcmVudENvbnRleHQuYWRkRXJyb3IoJ291dHB1dE1hcHBlckVycm9yJywgZXJyb3IudG9TdHJpbmcoKSk7XG4gICAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIG91dHB1dE1hcHBlciBmb3Igc3ViZmxvdyAoJHtzdWJmbG93SWR9KTpgLCB7IGVycm9yIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHN1YmZsb3dSZXN1bHQ6IFN1YmZsb3dSZXN1bHQgPSB7XG4gICAgICBzdWJmbG93SWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHRyZWVDb250ZXh0OiB7XG4gICAgICAgIGdsb2JhbENvbnRleHQ6IHN1YmZsb3dUcmVlQ29udGV4dC5zaGFyZWRTdGF0ZSxcbiAgICAgICAgc3RhZ2VDb250ZXh0czogc3ViZmxvd1RyZWVDb250ZXh0LmV4ZWN1dGlvblRyZWUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICAgICAgaGlzdG9yeTogc3ViZmxvd1RyZWVDb250ZXh0LmNvbW1pdExvZyxcbiAgICAgIH0sXG4gICAgICBwYXJlbnRTdGFnZUlkOiBwYXJlbnRDb250ZXh0LmdldFN0YWdlSWQoKSxcbiAgICB9O1xuXG4gICAgY29uc3Qgc3ViZmxvd0RlZiA9IHRoaXMuZGVwcy5zdWJmbG93cz8uW3N1YmZsb3dJZF07XG4gICAgaWYgKHN1YmZsb3dEZWYgJiYgKHN1YmZsb3dEZWYgYXMgYW55KS5idWlsZFRpbWVTdHJ1Y3R1cmUpIHtcbiAgICAgIHN1YmZsb3dSZXN1bHQucGlwZWxpbmVTdHJ1Y3R1cmUgPSAoc3ViZmxvd0RlZiBhcyBhbnkpLmJ1aWxkVGltZVN0cnVjdHVyZTtcbiAgICB9XG5cbiAgICBzdWJmbG93UmVzdWx0c01hcC5zZXQoc3ViZmxvd0lkLCBzdWJmbG93UmVzdWx0KTtcbiAgICAvLyBBZGRpdGl2ZSBwZXItZXhlY3V0aW9uIGtleSAoZGVzaWduOiBkb2NzL2Rlc2lnbi9zdWJmbG93LWNvbW1pdC12aXNpYmlsaXR5Lm1kKS4gQSBMT09QSU5HXG4gICAgLy8gc3ViZmxvdyByZS1lbnRlcnMgd2l0aCB0aGUgU0FNRSBzdWJmbG93SWQsIHNvIHRoZSBwYXRoIGtleSBhYm92ZSBpcyBPVkVSV1JJVFRFTiBlYWNoXG4gICAgLy8gaXRlcmF0aW9uIChiYWNrLWNvbXBhdDogaXQgaG9sZHMgdGhlIExBU1QgaXRlcmF0aW9uIOKAlCB3aGF0IGdldFN1YnRyZWVTbmFwc2hvdC9saXN0U3ViZmxvd1BhdGhzXG4gICAgLy8gYW5kIHRoZSBldWkgZmFsbGJhY2sgc2VlLCB1bmNoYW5nZWQpLiBBTFNPIGtleSBieSB0aGUgbW91bnQncyBVTklRVUUgcnVudGltZVN0YWdlSWQgc28gRVZFUllcbiAgICAvLyBpdGVyYXRpb24ncyByZXN1bHQgaXMgcmV0YWluZWQgYW5kIGFkZHJlc3NhYmxlIChldWkgcGVyLWxvb3AgZHJpbGwtZG93biwgcGVyLXNjb3BlIGxvY2FsaXphdGlvbikuXG4gICAgLy8gcnVudGltZVN0YWdlSWQgYWx3YXlzIGNvbnRhaW5zICcjJzsgc3ViZmxvd0lkIG5ldmVyIGRvZXMg4oCUIHNvIHRoZXkgbmV2ZXIgY29sbGlkZSwgYW5kXG4gICAgLy8gbGlzdFN1YmZsb3dQYXRocyBmaWx0ZXJzICcjJyBrZXlzIHRvIGtlZXAgaXRzIHBhdGgtb25seSBjb250cmFjdC4gVGhlIHBhdXNlIGNoZWNrcG9pbnQgZmlsdGVyc1xuICAgIC8vIHRoZXNlIG91dCAoYnVpbGRQYXVzZUNoZWNrcG9pbnQpIHNvIGl0IHN0YXlzIGxlYW4uXG4gICAgY29uc3QgbW91bnRSdW50aW1lU3RhZ2VJZCA9IHBhcmVudFRyYXZlcnNhbENvbnRleHQ/LnJ1bnRpbWVTdGFnZUlkO1xuICAgIGlmIChtb3VudFJ1bnRpbWVTdGFnZUlkICYmIG1vdW50UnVudGltZVN0YWdlSWQgIT09IHN1YmZsb3dJZCkge1xuICAgICAgc3ViZmxvd1Jlc3VsdHNNYXAuc2V0KG1vdW50UnVudGltZVN0YWdlSWQsIHN1YmZsb3dSZXN1bHQpO1xuICAgIH1cblxuICAgIHBhcmVudENvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZSgnc3ViZmxvdycsIGBFeGl0aW5nICR7c3ViZmxvd05hbWV9IHN1YmZsb3dgLCB7XG4gICAgICB0YXJnZXRTdGFnZTogc3ViZmxvd0lkLFxuICAgIH0pO1xuICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25TdWJmbG93RXhpdChcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd0lkLFxuICAgICAgcGFyZW50VHJhdmVyc2FsQ29udGV4dCxcbiAgICAgIHN1YmZsb3dSZXN1bHQudHJlZUNvbnRleHQ/Lmdsb2JhbENvbnRleHQsXG4gICAgKTtcblxuICAgIHBhcmVudENvbnRleHQuY29tbWl0KCk7XG5cbiAgICBpZiAoc3ViZmxvd0Vycm9yKSB7XG4gICAgICB0aHJvdyBzdWJmbG93RXJyb3I7XG4gICAgfVxuXG4gICAgcmV0dXJuIHN1YmZsb3dPdXRwdXQ7XG4gIH1cbn1cbiJdfQ==