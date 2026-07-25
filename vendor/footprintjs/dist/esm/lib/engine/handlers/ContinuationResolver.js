/**
 * ContinuationResolver — Back-edge resolution + iteration counting.
 *
 * Resolves dynamic continuations (loop-backs, dynamic next) and tracks
 * per-node iteration counts for context tree naming.
 *
 * Supports three dynamicNext patterns:
 * - String ID → reference to existing node (resolve via NodeResolver)
 * - StageNode with fn → truly dynamic node (execute directly)
 * - StageNode without fn → reference by ID (resolve via NodeResolver)
 *
 * Two entry points:
 * - `resolveTarget` — resolves the continuation to `{ node, context }` and
 *   fires every side effect (iteration counting, debug logs, `onLoop`
 *   narrative) WITHOUT executing. The traverser's trampoline driver uses
 *   this to follow loop edges iteratively — flat stack, so the iteration
 *   limit (not call-stack depth) is what bounds a loop.
 * - `resolve` — resolveTarget + immediate execution via the provided
 *   `executeNode` callback. Kept for direct/advanced callers.
 */
export const DEFAULT_MAX_ITERATIONS = 1000;
export class ContinuationResolver {
    deps;
    nodeResolver;
    /**
     * Iteration counter per node ID.
     * Key: node.id, Value: visit count (0 = first visit).
     */
    iterationCounters = new Map();
    /**
     * Total fn-bearing dynamic-next hops this traverser has followed.
     *
     * Fresh fn-bearing nodes bypass the per-node-id iteration counter (they
     * are new nodes, often without stable ids — there is no back-edge to
     * count). Without a bound, a stage that keeps returning a function-bearing
     * dynamic `next` runs FOREVER on the flat trampoline (no stack overflow
     * brakes it either). This run-total counter puts such chains under the
     * same `maxIterations` budget (default 1000, tuned via
     * `RunOptions.maxIterations`) that bounds loop edges.
     */
    dynamicNextHops = 0;
    onIterationUpdate;
    maxIterations;
    constructor(deps, nodeResolver, onIterationUpdate, maxIterations) {
        this.deps = deps;
        this.nodeResolver = nodeResolver;
        this.onIterationUpdate = onIterationUpdate;
        this.maxIterations = maxIterations ?? DEFAULT_MAX_ITERATIONS;
    }
    /**
     * Resolve a dynamic continuation and execute it immediately.
     * Equivalent to `executeNode(...resolveTarget(...))` — the traverser's
     * driver loop calls `resolveTarget` directly instead so the continuation
     * becomes a flat trampoline hop rather than a retained recursive frame.
     */
    async resolve(dynamicNext, node, context, breakFlag, branchPath, executeNode, traversalContext) {
        const target = this.resolveTarget(dynamicNext, node, context, branchPath, traversalContext);
        return executeNode(target.node, target.context, breakFlag, branchPath);
    }
    /**
     * Resolve a dynamic continuation to its target node + next StageContext
     * WITHOUT executing it. Fires the same side effects `resolve` always did
     * (iteration counting + limit, `dynamicNext*` logs, loop debug message,
     * `onLoop` narrative), in the same order.
     *
     * Three dynamicNext patterns:
     * - StageNode with fn → truly dynamic node, returned as-is (no per-node
     *   iteration tracking — it is a fresh node, not a back-edge — but the
     *   run-total dynamic-hop budget applies; see `dynamicNextHops`).
     * - String ID → reference to an existing node, resolved via NodeResolver.
     * - StageNode without fn → reference by ID, resolved via NodeResolver.
     */
    resolveTarget(dynamicNext, currentNode, context, branchPath, traversalContext) {
        // Truly dynamic node (has fn) → execute directly, no per-node iteration
        // tracking (fresh node, not a back-edge) — but the CHAIN of such hops is
        // bounded by the run-total guard below, mirroring the loop budget.
        if (typeof dynamicNext !== 'string' && dynamicNext.fn) {
            if (this.dynamicNextHops >= this.maxIterations) {
                throw new Error(`Maximum dynamic-next continuations (${this.maxIterations}) exceeded at stage '${currentNode.id ?? currentNode.name}' ` + `(dynamic target '${dynamicNext.name}'). Set maxIterations to increase the limit.`);
            }
            this.dynamicNextHops++;
            context.addLog('dynamicNextDirect', true);
            context.addLog('dynamicNextName', dynamicNext.name);
            context.addFlowDebugMessage('next', `Moving to ${dynamicNext.name} stage (dynamic)`, {
                targetStage: dynamicNext.name,
            });
            const nextStageContext = context.createNext(branchPath, dynamicNext.name, dynamicNext.id);
            return { node: dynamicNext, context: nextStageContext };
        }
        // Reference — by string ID or by node-without-fn ID. A node reference
        // without an id is a usage error; a string reference is passed through
        // verbatim (an unknown id surfaces as "target node not found" below).
        if (typeof dynamicNext !== 'string' && !dynamicNext.id) {
            const errorMessage = 'dynamicNext node must have an id when used as reference';
            this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
            throw new Error(errorMessage);
        }
        const nextNodeId = typeof dynamicNext === 'string' ? dynamicNext : dynamicNext.id;
        const targetNode = this.nodeResolver.findNodeById(nextNodeId);
        if (!targetNode) {
            const errorMessage = `dynamicNext target node not found: ${nextNodeId}`;
            this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${currentNode.name}]:`, { error: errorMessage });
            throw new Error(errorMessage);
        }
        const iteration = this.getAndIncrementIteration(nextNodeId);
        const iteratedStageName = this.getIteratedStageName(targetNode.name, iteration);
        context.addLog('dynamicNextTarget', nextNodeId);
        context.addLog('dynamicNextIteration', iteration);
        context.addFlowDebugMessage('loop', `Looping back to ${targetNode.name} (iteration ${iteration + 1})`, {
            targetStage: targetNode.name,
            iteration: iteration + 1,
        });
        this.deps.narrativeGenerator.onLoop(targetNode.name, iteration + 1, targetNode.description, traversalContext);
        const nextStageContext = context.createNext(branchPath, iteratedStageName, targetNode.id);
        return { node: targetNode, context: nextStageContext };
    }
    /**
     * Get the next iteration number for a node and increment.
     * Returns 0 for first visit, 1 for second, etc.
     * Throws if maxIterations exceeded (infinite loop guard).
     */
    getAndIncrementIteration(nodeId) {
        const current = this.iterationCounters.get(nodeId) ?? 0;
        if (current >= this.maxIterations) {
            throw new Error(`Maximum loop iterations (${this.maxIterations}) exceeded for node '${nodeId}'. ` +
                'Set maxIterations to increase the limit.');
        }
        this.iterationCounters.set(nodeId, current + 1);
        if (this.onIterationUpdate) {
            this.onIterationUpdate(nodeId, current + 1);
        }
        return current;
    }
    /**
     * Generate an iterated stage name for context tree.
     * First visit: "askLLM", second: "askLLM.1", third: "askLLM.2".
     */
    getIteratedStageName(baseName, iteration) {
        return iteration === 0 ? baseName : `${baseName}.${iteration}`;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29udGludWF0aW9uUmVzb2x2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9Db250aW51YXRpb25SZXNvbHZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRztBQVNILE1BQU0sQ0FBQyxNQUFNLHNCQUFzQixHQUFHLElBQUksQ0FBQztBQWEzQyxNQUFNLE9BQU8sb0JBQW9CO0lBd0JaO0lBQ0E7SUF4Qm5COzs7T0FHRztJQUNLLGlCQUFpQixHQUF3QixJQUFJLEdBQUcsRUFBRSxDQUFDO0lBRTNEOzs7Ozs7Ozs7O09BVUc7SUFDSyxlQUFlLEdBQUcsQ0FBQyxDQUFDO0lBRVgsaUJBQWlCLENBQTJDO0lBQzVELGFBQWEsQ0FBUztJQUV2QyxZQUNtQixJQUErQixFQUMvQixZQUF3QyxFQUN6RCxpQkFBMkQsRUFDM0QsYUFBc0I7UUFITCxTQUFJLEdBQUosSUFBSSxDQUEyQjtRQUMvQixpQkFBWSxHQUFaLFlBQVksQ0FBNEI7UUFJekQsSUFBSSxDQUFDLGlCQUFpQixHQUFHLGlCQUFpQixDQUFDO1FBQzNDLElBQUksQ0FBQyxhQUFhLEdBQUcsYUFBYSxJQUFJLHNCQUFzQixDQUFDO0lBQy9ELENBQUM7SUFFRDs7Ozs7T0FLRztJQUNILEtBQUssQ0FBQyxPQUFPLENBQ1gsV0FBNkMsRUFDN0MsSUFBNkIsRUFDN0IsT0FBcUIsRUFDckIsU0FBbUMsRUFDbkMsVUFBOEIsRUFDOUIsV0FBd0MsRUFDeEMsZ0JBQW1DO1FBRW5DLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsV0FBVyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsVUFBVSxFQUFFLGdCQUFnQixDQUFDLENBQUM7UUFDNUYsT0FBTyxXQUFXLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLFNBQVMsRUFBRSxVQUFVLENB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QUMsQ0FBQztRQUM5QyxDQUFDO1FBRUQsT0FBTyxPQUFPLENBQUM7SUFDakIsQ0FBQztJQUVEOzs7T0FHRztJQUNILG9CQUFvQixDQUFDLFFBQWdCLEVBQUUsU0FBaUI7UUFDdEQsT0FBTyxTQUFTLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsUUFBUSxJQUFJLFNBQVMsRUFBRSxDQUFDO0lBQ2pFLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29udGludWF0aW9uUmVzb2x2ZXIg4oCUIEJhY2stZWRnZSByZXNvbHV0aW9uICsgaXRlcmF0aW9uIGNvdW50aW5nLlxuICpcbiAqIFJlc29sdmVzIGR5bmFtaWMgY29udGludWF0aW9ucyAobG9vcC1iYWNrcywgZHluYW1pYyBuZXh0KSBhbmQgdHJhY2tzXG4gKiBwZXItbm9kZSBpdGVyYXRpb24gY291bnRzIGZvciBjb250ZXh0IHRyZWUgbmFtaW5nLlxuICpcbiAqIFN1cHBvcnRzIHRocmVlIGR5bmFtaWNOZXh0IHBhdHRlcm5zOlxuICogLSBTdHJpbmcgSUQg4oaSIHJlZmVyZW5jZSB0byBleGlzdGluZyBub2RlIChyZXNvbHZlIHZpYSBOb2RlUmVzb2x2ZXIpXG4gKiAtIFN0YWdlTm9kZSB3aXRoIGZuIOKGkiB0cnVseSBkeW5hbWljIG5vZGUgKGV4ZWN1dGUgZGlyZWN0bHkpXG4gKiAtIFN0YWdlTm9kZSB3aXRob3V0IGZuIOKGkiByZWZlcmVuY2UgYnkgSUQgKHJlc29sdmUgdmlhIE5vZGVSZXNvbHZlcilcbiAqXG4gKiBUd28gZW50cnkgcG9pbnRzOlxuICogLSBgcmVzb2x2ZVRhcmdldGAg4oCUIHJlc29sdmVzIHRoZSBjb250aW51YXRpb24gdG8gYHsgbm9kZSwgY29udGV4dCB9YCBhbmRcbiAqICAgZmlyZXMgZXZlcnkgc2lkZSBlZmZlY3QgKGl0ZXJhdGlvbiBjb3VudGluZywgZGVidWcgbG9ncywgYG9uTG9vcGBcbiAqICAgbmFycmF0aXZlKSBXSVRIT1VUIGV4ZWN1dGluZy4gVGhlIHRyYXZlcnNlcidzIHRyYW1wb2xpbmUgZHJpdmVyIHVzZXNcbiAqICAgdGhpcyB0byBmb2xsb3cgbG9vcCBlZGdlcyBpdGVyYXRpdmVseSDigJQgZmxhdCBzdGFjaywgc28gdGhlIGl0ZXJhdGlvblxuICogICBsaW1pdCAobm90IGNhbGwtc3RhY2sgZGVwdGgpIGlzIHdoYXQgYm91bmRzIGEgbG9vcC5cbiAqIC0gYHJlc29sdmVgIOKAlCByZXNvbHZlVGFyZ2V0ICsgaW1tZWRpYXRlIGV4ZWN1dGlvbiB2aWEgdGhlIHByb3ZpZGVkXG4gKiAgIGBleGVjdXRlTm9kZWAgY2FsbGJhY2suIEtlcHQgZm9yIGRpcmVjdC9hZHZhbmNlZCBjYWxsZXJzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgdHlwZSB7IFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFRyYXZlcnNhbENvbnRleHQgfSBmcm9tICcuLi9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcyB9IGZyb20gJy4uL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgTm9kZVJlc29sdmVyIH0gZnJvbSAnLi9Ob2RlUmVzb2x2ZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBFeGVjdXRlTm9kZUZuIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX01BWF9JVEVSQVRJT05TID0gMTAwMDtcblxuLyoqXG4gKiBBIHJlc29sdmVkIGNvbnRpbnVhdGlvbiB0YXJnZXQg4oCUIHRoZSBub2RlIHRvIGV4ZWN1dGUgbmV4dCBwbHVzIHRoZVxuICogU3RhZ2VDb250ZXh0IHRvIGV4ZWN1dGUgaXQgaW4uIEFsbCBzaWRlIGVmZmVjdHMgKGl0ZXJhdGlvbiBjb3VudGluZyxcbiAqIGRlYnVnIGxvZ3MsIGBvbkxvb3BgIG5hcnJhdGl2ZSkgaGF2ZSBhbHJlYWR5IGZpcmVkIGJ5IHRoZSB0aW1lIHRoaXNcbiAqIGlzIHJldHVybmVkLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkQ29udGludWF0aW9uPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgY29udGV4dDogU3RhZ2VDb250ZXh0O1xufVxuXG5leHBvcnQgY2xhc3MgQ29udGludWF0aW9uUmVzb2x2ZXI8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIC8qKlxuICAgKiBJdGVyYXRpb24gY291bnRlciBwZXIgbm9kZSBJRC5cbiAgICogS2V5OiBub2RlLmlkLCBWYWx1ZTogdmlzaXQgY291bnQgKDAgPSBmaXJzdCB2aXNpdCkuXG4gICAqL1xuICBwcml2YXRlIGl0ZXJhdGlvbkNvdW50ZXJzOiBNYXA8c3RyaW5nLCBudW1iZXI+ID0gbmV3IE1hcCgpO1xuXG4gIC8qKlxuICAgKiBUb3RhbCBmbi1iZWFyaW5nIGR5bmFtaWMtbmV4dCBob3BzIHRoaXMgdHJhdmVyc2VyIGhhcyBmb2xsb3dlZC5cbiAgICpcbiAgICogRnJlc2ggZm4tYmVhcmluZyBub2RlcyBieXBhc3MgdGhlIHBlci1ub2RlLWlkIGl0ZXJhdGlvbiBjb3VudGVyICh0aGV5XG4gICAqIGFyZSBuZXcgbm9kZXMsIG9mdGVuIHdpdGhvdXQgc3RhYmxlIGlkcyDigJQgdGhlcmUgaXMgbm8gYmFjay1lZGdlIHRvXG4gICAqIGNvdW50KS4gV2l0aG91dCBhIGJvdW5kLCBhIHN0YWdlIHRoYXQga2VlcHMgcmV0dXJuaW5nIGEgZnVuY3Rpb24tYmVhcmluZ1xuICAgKiBkeW5hbWljIGBuZXh0YCBydW5zIEZPUkVWRVIgb24gdGhlIGZsYXQgdHJhbXBvbGluZSAobm8gc3RhY2sgb3ZlcmZsb3dcbiAgICogYnJha2VzIGl0IGVpdGhlcikuIFRoaXMgcnVuLXRvdGFsIGNvdW50ZXIgcHV0cyBzdWNoIGNoYWlucyB1bmRlciB0aGVcbiAgICogc2FtZSBgbWF4SXRlcmF0aW9uc2AgYnVkZ2V0IChkZWZhdWx0IDEwMDAsIHR1bmVkIHZpYVxuICAgKiBgUnVuT3B0aW9ucy5tYXhJdGVyYXRpb25zYCkgdGhhdCBib3VuZHMgbG9vcCBlZGdlcy5cbiAgICovXG4gIHByaXZhdGUgZHluYW1pY05leHRIb3BzID0gMDtcblxuICBwcml2YXRlIHJlYWRvbmx5IG9uSXRlcmF0aW9uVXBkYXRlPzogKG5vZGVJZDogc3RyaW5nLCBjb3VudDogbnVtYmVyKSA9PiB2b2lkO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heEl0ZXJhdGlvbnM6IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4sXG4gICAgcHJpdmF0ZSByZWFkb25seSBub2RlUmVzb2x2ZXI6IE5vZGVSZXNvbHZlcjxUT3V0LCBUU2NvcGU+LFxuICAgIG9uSXRlcmF0aW9uVXBkYXRlPzogKG5vZGVJZDogc3RyaW5nLCBjb3VudDogbnVtYmVyKSA9PiB2b2lkLFxuICAgIG1heEl0ZXJhdGlvbnM/OiBudW1iZXIsXG4gICkge1xuICAgIHRoaXMub25JdGVyYXRpb25VcGRhdGUgPSBvbkl0ZXJhdGlvblVwZGF0ZTtcbiAgICB0aGlzLm1heEl0ZXJhdGlvbnMgPSBtYXhJdGVyYXRpb25zID8/IERFRkFVTFRfTUFYX0lURVJBVElPTlM7XG4gIH1cblxuICAvKipcbiAgICogUmVzb2x2ZSBhIGR5bmFtaWMgY29udGludWF0aW9uIGFuZCBleGVjdXRlIGl0IGltbWVkaWF0ZWx5LlxuICAgKiBFcXVpdmFsZW50IHRvIGBleGVjdXRlTm9kZSguLi5yZXNvbHZlVGFyZ2V0KC4uLikpYCDigJQgdGhlIHRyYXZlcnNlcidzXG4gICAqIGRyaXZlciBsb29wIGNhbGxzIGByZXNvbHZlVGFyZ2V0YCBkaXJlY3RseSBpbnN0ZWFkIHNvIHRoZSBjb250aW51YXRpb25cbiAgICogYmVjb21lcyBhIGZsYXQgdHJhbXBvbGluZSBob3AgcmF0aGVyIHRoYW4gYSByZXRhaW5lZCByZWN1cnNpdmUgZnJhbWUuXG4gICAqL1xuICBhc3luYyByZXNvbHZlKFxuICAgIGR5bmFtaWNOZXh0OiBzdHJpbmcgfCBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICAgYnJlYWtGbGFnOiB7IHNob3VsZEJyZWFrOiBib29sZWFuIH0sXG4gICAgYnJhbmNoUGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgIGV4ZWN1dGVOb2RlOiBFeGVjdXRlTm9kZUZuPFRPdXQsIFRTY29wZT4sXG4gICAgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQsXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gdGhpcy5yZXNvbHZlVGFyZ2V0KGR5bmFtaWNOZXh0LCBub2RlLCBjb250ZXh0LCBicmFuY2hQYXRoLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICByZXR1cm4gZXhlY3V0ZU5vZGUodGFyZ2V0Lm5vZGUsIHRhcmdldC5jb250ZXh0LCBicmVha0ZsYWcsIGJyYW5jaFBhdGgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc29sdmUgYSBkeW5hbWljIGNvbnRpbnVhdGlvbiB0byBpdHMgdGFyZ2V0IG5vZGUgKyBuZXh0IFN0YWdlQ29udGV4dFxuICAgKiBXSVRIT1VUIGV4ZWN1dGluZyBpdC4gRmlyZXMgdGhlIHNhbWUgc2lkZSBlZmZlY3RzIGByZXNvbHZlYCBhbHdheXMgZGlkXG4gICAqIChpdGVyYXRpb24gY291bnRpbmcgKyBsaW1pdCwgYGR5bmFtaWNOZXh0KmAgbG9ncywgbG9vcCBkZWJ1ZyBtZXNzYWdlLFxuICAgKiBgb25Mb29wYCBuYXJyYXRpdmUpLCBpbiB0aGUgc2FtZSBvcmRlci5cbiAgICpcbiAgICogVGhyZWUgZHluYW1pY05leHQgcGF0dGVybnM6XG4gICAqIC0gU3RhZ2VOb2RlIHdpdGggZm4g4oaSIHRydWx5IGR5bmFtaWMgbm9kZSwgcmV0dXJuZWQgYXMtaXMgKG5vIHBlci1ub2RlXG4gICAqICAgaXRlcmF0aW9uIHRyYWNraW5nIOKAlCBpdCBpcyBhIGZyZXNoIG5vZGUsIG5vdCBhIGJhY2stZWRnZSDigJQgYnV0IHRoZVxuICAgKiAgIHJ1bi10b3RhbCBkeW5hbWljLWhvcCBidWRnZXQgYXBwbGllczsgc2VlIGBkeW5hbWljTmV4dEhvcHNgKS5cbiAgICogLSBTdHJpbmcgSUQg4oaSIHJlZmVyZW5jZSB0byBhbiBleGlzdGluZyBub2RlLCByZXNvbHZlZCB2aWEgTm9kZVJlc29sdmVyLlxuICAgKiAtIFN0YWdlTm9kZSB3aXRob3V0IGZuIOKGkiByZWZlcmVuY2UgYnkgSUQsIHJlc29sdmVkIHZpYSBOb2RlUmVzb2x2ZXIuXG4gICAqL1xuICByZXNvbHZlVGFyZ2V0KFxuICAgIGR5bmFtaWNOZXh0OiBzdHJpbmcgfCBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBjdXJyZW50Tm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyYW5jaFBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgKTogUmVzb2x2ZWRDb250aW51YXRpb248VE91dCwgVFNjb3BlPiB7XG4gICAgLy8gVHJ1bHkgZHluYW1pYyBub2RlIChoYXMgZm4pIOKGkiBleGVjdXRlIGRpcmVjdGx5LCBubyBwZXItbm9kZSBpdGVyYXRpb25cbiAgICAvLyB0cmFja2luZyAoZnJlc2ggbm9kZSwgbm90IGEgYmFjay1lZGdlKSDigJQgYnV0IHRoZSBDSEFJTiBvZiBzdWNoIGhvcHMgaXNcbiAgICAvLyBib3VuZGVkIGJ5IHRoZSBydW4tdG90YWwgZ3VhcmQgYmVsb3csIG1pcnJvcmluZyB0aGUgbG9vcCBidWRnZXQuXG4gICAgaWYgKHR5cGVvZiBkeW5hbWljTmV4dCAhPT0gJ3N0cmluZycgJiYgZHluYW1pY05leHQuZm4pIHtcbiAgICAgIGlmICh0aGlzLmR5bmFtaWNOZXh0SG9wcyA+PSB0aGlzLm1heEl0ZXJhdGlvbnMpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBNYXhpbXVtIGR5bmFtaWMtbmV4dCBjb250aW51YXRpb25zICgke3RoaXMubWF4SXRlcmF0aW9uc30pIGV4Y2VlZGVkIGF0IHN0YWdlICcke1xuICAgICAgICAgICAgY3VycmVudE5vZGUuaWQgPz8gY3VycmVudE5vZGUubmFtZVxuICAgICAgICAgIH0nIGAgKyBgKGR5bmFtaWMgdGFyZ2V0ICcke2R5bmFtaWNOZXh0Lm5hbWV9JykuIFNldCBtYXhJdGVyYXRpb25zIHRvIGluY3JlYXNlIHRoZSBsaW1pdC5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdGhpcy5keW5hbWljTmV4dEhvcHMrKztcblxuICAgICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNOZXh0RGlyZWN0JywgdHJ1ZSk7XG4gICAgICBjb250ZXh0LmFkZExvZygnZHluYW1pY05leHROYW1lJywgZHluYW1pY05leHQubmFtZSk7XG5cbiAgICAgIGNvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZSgnbmV4dCcsIGBNb3ZpbmcgdG8gJHtkeW5hbWljTmV4dC5uYW1lfSBzdGFnZSAoZHluYW1pYylgLCB7XG4gICAgICAgIHRhcmdldFN0YWdlOiBkeW5hbWljTmV4dC5uYW1lLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IG5leHRTdGFnZUNvbnRleHQgPSBjb250ZXh0LmNyZWF0ZU5leHQoYnJhbmNoUGF0aCBhcyBzdHJpbmcsIGR5bmFtaWNOZXh0Lm5hbWUsIGR5bmFtaWNOZXh0LmlkKTtcbiAgICAgIHJldHVybiB7IG5vZGU6IGR5bmFtaWNOZXh0LCBjb250ZXh0OiBuZXh0U3RhZ2VDb250ZXh0IH07XG4gICAgfVxuXG4gICAgLy8gUmVmZXJlbmNlIOKAlCBieSBzdHJpbmcgSUQgb3IgYnkgbm9kZS13aXRob3V0LWZuIElELiBBIG5vZGUgcmVmZXJlbmNlXG4gICAgLy8gd2l0aG91dCBhbiBpZCBpcyBhIHVzYWdlIGVycm9yOyBhIHN0cmluZyByZWZlcmVuY2UgaXMgcGFzc2VkIHRocm91Z2hcbiAgICAvLyB2ZXJiYXRpbSAoYW4gdW5rbm93biBpZCBzdXJmYWNlcyBhcyBcInRhcmdldCBub2RlIG5vdCBmb3VuZFwiIGJlbG93KS5cbiAgICBpZiAodHlwZW9mIGR5bmFtaWNOZXh0ICE9PSAnc3RyaW5nJyAmJiAhZHluYW1pY05leHQuaWQpIHtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9ICdkeW5hbWljTmV4dCBub2RlIG11c3QgaGF2ZSBhbiBpZCB3aGVuIHVzZWQgYXMgcmVmZXJlbmNlJztcbiAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KSBzdGFnZSBbJHtjdXJyZW50Tm9kZS5uYW1lfV06YCwgeyBlcnJvcjogZXJyb3JNZXNzYWdlIH0pO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG4gICAgfVxuICAgIGNvbnN0IG5leHROb2RlSWQgPSB0eXBlb2YgZHluYW1pY05leHQgPT09ICdzdHJpbmcnID8gZHluYW1pY05leHQgOiBkeW5hbWljTmV4dC5pZCE7XG5cbiAgICBjb25zdCB0YXJnZXROb2RlID0gdGhpcy5ub2RlUmVzb2x2ZXIuZmluZE5vZGVCeUlkKG5leHROb2RlSWQpO1xuICAgIGlmICghdGFyZ2V0Tm9kZSkge1xuICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYGR5bmFtaWNOZXh0IHRhcmdldCBub2RlIG5vdCBmb3VuZDogJHtuZXh0Tm9kZUlkfWA7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBwaXBlbGluZSAoJHticmFuY2hQYXRofSkgc3RhZ2UgWyR7Y3VycmVudE5vZGUubmFtZX1dOmAsIHsgZXJyb3I6IGVycm9yTWVzc2FnZSB9KTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgIH1cblxuICAgIGNvbnN0IGl0ZXJhdGlvbiA9IHRoaXMuZ2V0QW5kSW5jcmVtZW50SXRlcmF0aW9uKG5leHROb2RlSWQpO1xuICAgIGNvbnN0IGl0ZXJhdGVkU3RhZ2VOYW1lID0gdGhpcy5nZXRJdGVyYXRlZFN0YWdlTmFtZSh0YXJnZXROb2RlLm5hbWUsIGl0ZXJhdGlvbik7XG4gICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNOZXh0VGFyZ2V0JywgbmV4dE5vZGVJZCk7XG4gICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNOZXh0SXRlcmF0aW9uJywgaXRlcmF0aW9uKTtcblxuICAgIGNvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZSgnbG9vcCcsIGBMb29waW5nIGJhY2sgdG8gJHt0YXJnZXROb2RlLm5hbWV9IChpdGVyYXRpb24gJHtpdGVyYXRpb24gKyAxfSlgLCB7XG4gICAgICB0YXJnZXRTdGFnZTogdGFyZ2V0Tm9kZS5uYW1lLFxuICAgICAgaXRlcmF0aW9uOiBpdGVyYXRpb24gKyAxLFxuICAgIH0pO1xuXG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkxvb3AodGFyZ2V0Tm9kZS5uYW1lLCBpdGVyYXRpb24gKyAxLCB0YXJnZXROb2RlLmRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0KTtcblxuICAgIGNvbnN0IG5leHRTdGFnZUNvbnRleHQgPSBjb250ZXh0LmNyZWF0ZU5leHQoYnJhbmNoUGF0aCBhcyBzdHJpbmcsIGl0ZXJhdGVkU3RhZ2VOYW1lLCB0YXJnZXROb2RlLmlkKTtcbiAgICByZXR1cm4geyBub2RlOiB0YXJnZXROb2RlLCBjb250ZXh0OiBuZXh0U3RhZ2VDb250ZXh0IH07XG4gIH1cblxuICAvKipcbiAgICogR2V0IHRoZSBuZXh0IGl0ZXJhdGlvbiBudW1iZXIgZm9yIGEgbm9kZSBhbmQgaW5jcmVtZW50LlxuICAgKiBSZXR1cm5zIDAgZm9yIGZpcnN0IHZpc2l0LCAxIGZvciBzZWNvbmQsIGV0Yy5cbiAgICogVGhyb3dzIGlmIG1heEl0ZXJhdGlvbnMgZXhjZWVkZWQgKGluZmluaXRlIGxvb3AgZ3VhcmQpLlxuICAgKi9cbiAgZ2V0QW5kSW5jcmVtZW50SXRlcmF0aW9uKG5vZGVJZDogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBjb25zdCBjdXJyZW50ID0gdGhpcy5pdGVyYXRpb25Db3VudGVycy5nZXQobm9kZUlkKSA/PyAwO1xuICAgIGlmIChjdXJyZW50ID49IHRoaXMubWF4SXRlcmF0aW9ucykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgTWF4aW11bSBsb29wIGl0ZXJhdGlvbnMgKCR7dGhpcy5tYXhJdGVyYXRpb25zfSkgZXhjZWVkZWQgZm9yIG5vZGUgJyR7bm9kZUlkfScuIGAgK1xuICAgICAgICAgICdTZXQgbWF4SXRlcmF0aW9ucyB0byBpbmNyZWFzZSB0aGUgbGltaXQuJyxcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMuaXRlcmF0aW9uQ291bnRlcnMuc2V0KG5vZGVJZCwgY3VycmVudCArIDEpO1xuXG4gICAgaWYgKHRoaXMub25JdGVyYXRpb25VcGRhdGUpIHtcbiAgICAgIHRoaXMub25JdGVyYXRpb25VcGRhdGUobm9kZUlkLCBjdXJyZW50ICsgMSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGN1cnJlbnQ7XG4gIH1cblxuICAvKipcbiAgICogR2VuZXJhdGUgYW4gaXRlcmF0ZWQgc3RhZ2UgbmFtZSBmb3IgY29udGV4dCB0cmVlLlxuICAgKiBGaXJzdCB2aXNpdDogXCJhc2tMTE1cIiwgc2Vjb25kOiBcImFza0xMTS4xXCIsIHRoaXJkOiBcImFza0xMTS4yXCIuXG4gICAqL1xuICBnZXRJdGVyYXRlZFN0YWdlTmFtZShiYXNlTmFtZTogc3RyaW5nLCBpdGVyYXRpb246IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGl0ZXJhdGlvbiA9PT0gMCA/IGJhc2VOYW1lIDogYCR7YmFzZU5hbWV9LiR7aXRlcmF0aW9ufWA7XG4gIH1cbn1cbiJdfQ==