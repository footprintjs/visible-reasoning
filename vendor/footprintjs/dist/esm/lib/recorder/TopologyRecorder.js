/**
 * TopologyRecorder — composition graph built during traversal.
 *
 * The gap this fills:
 *   footprintjs fires atomic flow events (onSubflowEntry, onFork, onDecision,
 *   onLoop) but the accumulated *shape* of a run — who nests inside whom,
 *   which nodes are parallel siblings vs branches of a decision — is only
 *   visible post-run via `executor.getSnapshot()` tree-walking.
 *
 *   Streaming consumers (live UIs, in-flight debuggers) see only the event
 *   stream. Every such consumer has to rebuild subflow-stack + fork-map +
 *   decision-tracker from scratch, usually slightly wrong in different ways.
 *
 *   TopologyRecorder is the standard accumulator: one subscription to the
 *   three primitive channels, one live graph, queryable at any moment during
 *   or after a run.
 *
 * What it records — THREE node kinds for complete composition coverage:
 *   1. 'subflow'          — via onSubflowEntry (a mounted subflow boundary)
 *   2. 'fork-branch'      — via onFork (one node per child, synthesized)
 *   3. 'decision-branch'  — via onDecision (the chosen branch, synthesized)
 *
 *   When a fork-branch or decision-branch target IS ALSO a subflow, the
 *   subsequent onSubflowEntry creates a subflow CHILD of the synthetic node.
 *   The layered shape preserves both "who branched" and "what the branch ran."
 *
 *   Plain sequential stages are NOT nodes — that's StageContext's job.
 *   Topology is a graph of control-flow branching, not a full execution tree.
 *
 * Edges:
 *   One edge per traversal transition — `kind` matches the child's
 *   `incomingKind`. A consumer rendering "parallel columns" filters edges
 *   where `kind === 'fork-branch'` sharing the same `from`.
 *
 * @example
 * ```typescript
 * import { topologyRecorder } from 'footprintjs/trace';
 *
 * const topo = topologyRecorder();
 * executor.attachCombinedRecorder(topo);  // auto-routes to FlowRecorder channel
 *
 * await executor.run();
 *
 * const { nodes, edges, activeNodeId, rootId } = topo.getTopology();
 * // Consumer queries:
 * topo.getChildren('sf-parent');              // direct children (any kind)
 * topo.getByKind('fork-branch');              // all parallel branches
 * topo.getSubflowNodes();                     // only mounted subflows
 * ```
 */
let _counter = 0;
/**
 * Factory — matches the `narrative()` / `metrics()` style.
 */
export function topologyRecorder(options = {}) {
    return new TopologyRecorder(options);
}
/**
 * Stateful accumulator that watches FlowRecorder events and maintains a live
 * composition graph. Attach via `executor.attachCombinedRecorder(recorder)` —
 * footprintjs detects the `FlowRecorder` method shape and routes events.
 */
export class TopologyRecorder {
    id;
    nodesById = new Map();
    nodeOrder = [];
    edges = [];
    /** Stack of active SUBFLOW node ids. Fork/decision-branch nodes never push. */
    subflowStack = [];
    /** Map of childName → pending fork-branch synthetic node, consumed by
     *  the next matching `onSubflowEntry`. */
    pendingForkByName = new Map();
    /** Pending decision-branch synthetic node, consumed by a matching entry. */
    pendingDecision;
    /**
     * The previous subflow that just finished, keyed by scope (parentId,
     * or '' for root). When a new subflow enters in the same scope via
     * the normal next-chained path (not fork/decision), we emit a `next`
     * edge from the previous subflow to the new one — matching how the
     * builder actually wired them: `.addSubFlowChartNext(A).addSubFlowChartNext(B)`
     * means A → B, one after the other.
     *
     * Without this, consumers only see parent→child edges (A, B, C all
     * children of their common ancestor) with no record of the actual
     * A → B → C sequential chain that ran — which is exactly what
     * TopologyRecorder is supposed to expose.
     */
    previousSubflowInScope = new Map();
    constructor(options = {}) {
        this.id = options.id ?? `topology-${++_counter}`;
    }
    // ── FlowRecorder hooks ────────────────────────────────────────────────
    onSubflowEntry(event) {
        const subflowId = event.subflowId;
        if (!subflowId)
            return; // Need a stable id to track.
        const enteredAt = event.traversalContext?.runtimeStageId ?? '';
        // Determine the parent: prefer a pending fork/decision match by name,
        // otherwise the current top-of-subflow-stack.
        let parentId;
        let incomingKind;
        const pendingFork = this.pendingForkByName.get(event.name);
        if (pendingFork) {
            parentId = pendingFork.nodeId;
            incomingKind = 'next'; // Child OF a fork-branch node; the fork semantic
            // is captured by the fork-branch's own incomingKind.
            this.pendingForkByName.delete(event.name);
        }
        else if (this.pendingDecision && this.pendingDecision.name === event.name) {
            parentId = this.pendingDecision.nodeId;
            incomingKind = 'next';
            this.pendingDecision = undefined;
        }
        else {
            parentId = this.subflowStack[this.subflowStack.length - 1];
            incomingKind = parentId ? 'next' : 'root';
        }
        // Disambiguate re-entry (e.g., loop body re-enters the same subflow).
        let nodeId = subflowId;
        if (this.nodesById.has(nodeId)) {
            let n = 1;
            while (this.nodesById.has(`${subflowId}#${n}`))
                n++;
            nodeId = `${subflowId}#${n}`;
        }
        const depth = parentId ? this.nodesById.get(parentId).depth + 1 : 0;
        const metadata = event.description ? { description: event.description } : undefined;
        const node = {
            id: nodeId,
            kind: 'subflow',
            name: event.name,
            parentId,
            depth,
            incomingKind,
            enteredAt,
            metadata,
        };
        this.nodesById.set(nodeId, node);
        this.nodeOrder.push(nodeId);
        if (parentId && incomingKind !== 'root') {
            this.edges.push({
                from: parentId,
                to: nodeId,
                kind: incomingKind,
                at: enteredAt,
            });
        }
        // Next-chained edge from the PREVIOUS subflow in this scope.
        //
        // `.addSubFlowChartNext(A).addSubFlowChartNext(B).addSubFlowChartNext(C)`
        // runs as: A enters → A exits → B enters → B exits → C enters. At
        // B's entry the stack has returned to the scope it was in before A
        // entered (root, or the shared ancestor). Without this edge we'd
        // see nodes {A, B, C} but no record that A ran BEFORE B which ran
        // BEFORE C — and downstream consumers would have to reconstruct
        // sequential ordering themselves.
        //
        // Only emit on the regular-entry path. Fork/decision entries have
        // their own edge mechanics (parent→fork-branch, parent→decision-
        // branch) that carry the branching semantics.
        if (incomingKind === 'next' || incomingKind === 'root') {
            const scopeKey = parentId ?? '';
            const previous = this.previousSubflowInScope.get(scopeKey);
            if (previous) {
                this.edges.push({
                    from: previous.nodeId,
                    to: nodeId,
                    kind: 'next',
                    at: enteredAt,
                });
                this.previousSubflowInScope.delete(scopeKey);
            }
        }
        this.subflowStack.push(nodeId);
    }
    onSubflowExit(event) {
        const nodeId = this.subflowStack.pop();
        if (!nodeId)
            return;
        const node = this.nodesById.get(nodeId);
        const exitedAt = event.traversalContext?.runtimeStageId ?? '';
        if (node) {
            node.exitedAt = exitedAt;
            // Remember this node as the "previous subflow" in its scope.
            // Whatever subflow enters NEXT in the same scope (normal-entry
            // path, not fork/decision) gets a `next` edge drawn from here
            // — this is the real sequential A → B transition that the
            // `.addSubFlowChartNext()` builder produced.
            const scopeKey = node.parentId ?? '';
            this.previousSubflowInScope.set(scopeKey, { nodeId, exitedAt });
        }
        // Clear pendingDecision on exit — a decision identifies exactly ONE
        // target. If the chosen goes to a plain stage (not a subflow), the
        // pending entry would otherwise linger and falsely match an
        // unrelated subflow later in a different scope.
        this.pendingDecision = undefined;
        // Deliberately NOT clearing pendingForkByName — fork siblings need
        // their pending entries to survive scope exits of earlier siblings
        // (e.g. Alpha's inner sf-messages exits before Beta enters). Fork
        // pending entries are cleared on new `onFork` or consumed on match.
    }
    onFork(event) {
        const activeId = this.subflowStack[this.subflowStack.length - 1];
        const at = event.traversalContext?.runtimeStageId ?? '';
        const depth = activeId ? this.nodesById.get(activeId).depth + 1 : 0;
        // Reset any prior pending fork state — a new fork starts fresh.
        this.pendingForkByName.clear();
        event.children.forEach((childName, i) => {
            const nodeId = `fork-${at || event.parent}-${i}-${childName}`;
            const node = {
                id: nodeId,
                kind: 'fork-branch',
                name: childName,
                parentId: activeId,
                depth,
                incomingKind: 'fork-branch',
                enteredAt: at,
                metadata: { forkParent: event.parent },
            };
            this.nodesById.set(nodeId, node);
            this.nodeOrder.push(nodeId);
            if (activeId) {
                this.edges.push({ from: activeId, to: nodeId, kind: 'fork-branch', at });
            }
            this.pendingForkByName.set(childName, { nodeId, at });
        });
    }
    onDecision(event) {
        const activeId = this.subflowStack[this.subflowStack.length - 1];
        const at = event.traversalContext?.runtimeStageId ?? '';
        const depth = activeId ? this.nodesById.get(activeId).depth + 1 : 0;
        // A new decision supersedes any prior unresolved pending one.
        this.pendingDecision = undefined;
        const nodeId = `decision-${at || event.decider}-${event.chosen}`;
        const metadata = { decider: event.decider };
        if (event.rationale)
            metadata.rationale = event.rationale;
        if (event.description)
            metadata.description = event.description;
        const node = {
            id: nodeId,
            kind: 'decision-branch',
            name: event.chosen,
            parentId: activeId,
            depth,
            incomingKind: 'decision-branch',
            enteredAt: at,
            metadata,
        };
        this.nodesById.set(nodeId, node);
        this.nodeOrder.push(nodeId);
        if (activeId) {
            this.edges.push({ from: activeId, to: nodeId, kind: 'decision-branch', at });
        }
        this.pendingDecision = { name: event.chosen, nodeId, at };
    }
    onLoop(event) {
        // loopTo jumps back inside the CURRENT subflow. Record a self-edge on the
        // active subflow — synthetic fork/decision nodes don't participate in loops.
        const activeId = this.subflowStack[this.subflowStack.length - 1];
        if (!activeId)
            return;
        this.edges.push({
            from: activeId,
            to: activeId,
            kind: 'loop-iteration',
            at: event.traversalContext?.runtimeStageId ?? '',
        });
    }
    /** Called by the executor before each `run()` — resets all state. */
    clear() {
        this.nodesById.clear();
        this.nodeOrder.length = 0;
        this.edges.length = 0;
        this.subflowStack.length = 0;
        this.pendingForkByName.clear();
        this.previousSubflowInScope.clear();
        this.pendingDecision = undefined;
    }
    // ── Query API ─────────────────────────────────────────────────────────
    /** Live snapshot of the composition graph. Safe during or after a run. */
    getTopology() {
        const nodes = this.nodeOrder.map((id) => this.nodesById.get(id));
        return {
            nodes,
            edges: [...this.edges],
            activeNodeId: this.subflowStack[this.subflowStack.length - 1] ?? null,
            rootId: this.nodeOrder[0] ?? null,
        };
    }
    /** Direct children of a node — insertion-ordered. */
    getChildren(nodeId) {
        return this.nodeOrder.map((id) => this.nodesById.get(id)).filter((n) => n.parentId === nodeId);
    }
    /** All nodes of a given kind. */
    getByKind(kind) {
        return this.nodeOrder.map((id) => this.nodesById.get(id)).filter((n) => n.kind === kind);
    }
    /** All mounted subflow nodes. Convenience for agent-centric views. */
    getSubflowNodes() {
        return this.getByKind('subflow');
    }
    /** All fork-branch nodes sharing the same parent as `nodeId` — i.e.,
     *  parallel siblings of a parallel branch. Empty if `nodeId` isn't a
     *  fork-branch or has no parent. */
    getParallelSiblings(nodeId) {
        const node = this.nodesById.get(nodeId);
        if (!node || node.kind !== 'fork-branch' || !node.parentId)
            return [];
        return this.getChildren(node.parentId).filter((n) => n.kind === 'fork-branch');
    }
    /** Emit a snapshot bundle for inclusion in `executor.getSnapshot()`. */
    toSnapshot() {
        return {
            name: 'Topology',
            description: 'Composition graph: subflow boundaries, fork branches, decision branches',
            preferredOperation: 'translate',
            data: this.getTopology(),
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiVG9wb2xvZ3lSZWNvcmRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVjb3JkZXIvVG9wb2xvZ3lSZWNvcmRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQWlERztBQTJFSCxJQUFJLFFBQVEsR0FBRyxDQUFDLENBQUM7QUFFakI7O0dBRUc7QUFDSCxNQUFNLFVBQVUsZ0JBQWdCLENBQUMsVUFBbUMsRUFBRTtJQUNwRSxPQUFPLElBQUksZ0JBQWdCLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDdkMsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxNQUFNLE9BQU8sZ0JBQWdCO0lBQ2xCLEVBQUUsQ0FBUztJQUVILFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBd0IsQ0FBQztJQUM1QyxTQUFTLEdBQWEsRUFBRSxDQUFDO0lBQ3pCLEtBQUssR0FBbUIsRUFBRSxDQUFDO0lBQzVDLCtFQUErRTtJQUM5RCxZQUFZLEdBQWEsRUFBRSxDQUFDO0lBRTdDOzhDQUMwQztJQUN6QixpQkFBaUIsR0FBRyxJQUFJLEdBQUcsRUFBd0IsQ0FBQztJQUNyRSw0RUFBNEU7SUFDcEUsZUFBZSxDQUFtQztJQUMxRDs7Ozs7Ozs7Ozs7O09BWUc7SUFDYyxzQkFBc0IsR0FBRyxJQUFJLEdBQUcsRUFBZ0QsQ0FBQztJQUVsRyxZQUFZLFVBQW1DLEVBQUU7UUFDL0MsSUFBSSxDQUFDLEVBQUUsR0FBRyxPQUFPLENBQUMsRUFBRSxJQUFJLFlBQVksRUFBRSxRQUFRLEVBQUUsQ0FBQztJQUNuRCxDQUFDO0lBRUQseUVBQXlFO0lBRXpFLGNBQWMsQ0FBQyxLQUF1QjtRQUNwQyxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsU0FBUyxDQUFDO1FBQ2xDLElBQUksQ0FBQyxTQUFTO1lBQUUsT0FBTyxDQUFDLDZCQUE2QjtRQUVyRCxNQUFNLFNBQVMsR0FB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LENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxhQUFhLENBQUMsQ0FBQztJQUNqRixDQUFDO0lBRUQsd0VBQXdFO0lBQ3hFLFVBQVU7UUFDUixPQUFPO1lBQ0wsSUFBSSxFQUFFLFVBQVU7WUFDaEIsV0FBVyxFQUFFLHlFQUF5RTtZQUN0RixrQkFBa0IsRUFBRSxXQUFvQjtZQUN4QyxJQUFJLEVBQUUsSUFBSSxDQUFDLFdBQVcsRUFBRTtTQUN6QixDQUFDO0lBQ0osQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUb3BvbG9neVJlY29yZGVyIOKAlCBjb21wb3NpdGlvbiBncmFwaCBidWlsdCBkdXJpbmcgdHJhdmVyc2FsLlxuICpcbiAqIFRoZSBnYXAgdGhpcyBmaWxsczpcbiAqICAgZm9vdHByaW50anMgZmlyZXMgYXRvbWljIGZsb3cgZXZlbnRzIChvblN1YmZsb3dFbnRyeSwgb25Gb3JrLCBvbkRlY2lzaW9uLFxuICogICBvbkxvb3ApIGJ1dCB0aGUgYWNjdW11bGF0ZWQgKnNoYXBlKiBvZiBhIHJ1biDigJQgd2hvIG5lc3RzIGluc2lkZSB3aG9tLFxuICogICB3aGljaCBub2RlcyBhcmUgcGFyYWxsZWwgc2libGluZ3MgdnMgYnJhbmNoZXMgb2YgYSBkZWNpc2lvbiDigJQgaXMgb25seVxuICogICB2aXNpYmxlIHBvc3QtcnVuIHZpYSBgZXhlY3V0b3IuZ2V0U25hcHNob3QoKWAgdHJlZS13YWxraW5nLlxuICpcbiAqICAgU3RyZWFtaW5nIGNvbnN1bWVycyAobGl2ZSBVSXMsIGluLWZsaWdodCBkZWJ1Z2dlcnMpIHNlZSBvbmx5IHRoZSBldmVudFxuICogICBzdHJlYW0uIEV2ZXJ5IHN1Y2ggY29uc3VtZXIgaGFzIHRvIHJlYnVpbGQgc3ViZmxvdy1zdGFjayArIGZvcmstbWFwICtcbiAqICAgZGVjaXNpb24tdHJhY2tlciBmcm9tIHNjcmF0Y2gsIHVzdWFsbHkgc2xpZ2h0bHkgd3JvbmcgaW4gZGlmZmVyZW50IHdheXMuXG4gKlxuICogICBUb3BvbG9neVJlY29yZGVyIGlzIHRoZSBzdGFuZGFyZCBhY2N1bXVsYXRvcjogb25lIHN1YnNjcmlwdGlvbiB0byB0aGVcbiAqICAgdGhyZWUgcHJpbWl0aXZlIGNoYW5uZWxzLCBvbmUgbGl2ZSBncmFwaCwgcXVlcnlhYmxlIGF0IGFueSBtb21lbnQgZHVyaW5nXG4gKiAgIG9yIGFmdGVyIGEgcnVuLlxuICpcbiAqIFdoYXQgaXQgcmVjb3JkcyDigJQgVEhSRUUgbm9kZSBraW5kcyBmb3IgY29tcGxldGUgY29tcG9zaXRpb24gY292ZXJhZ2U6XG4gKiAgIDEuICdzdWJmbG93JyAgICAgICAgICDigJQgdmlhIG9uU3ViZmxvd0VudHJ5IChhIG1vdW50ZWQgc3ViZmxvdyBib3VuZGFyeSlcbiAqICAgMi4gJ2ZvcmstYnJhbmNoJyAgICAgIOKAlCB2aWEgb25Gb3JrIChvbmUgbm9kZSBwZXIgY2hpbGQsIHN5bnRoZXNpemVkKVxuICogICAzLiAnZGVjaXNpb24tYnJhbmNoJyAg4oCUIHZpYSBvbkRlY2lzaW9uICh0aGUgY2hvc2VuIGJyYW5jaCwgc3ludGhlc2l6ZWQpXG4gKlxuICogICBXaGVuIGEgZm9yay1icmFuY2ggb3IgZGVjaXNpb24tYnJhbmNoIHRhcmdldCBJUyBBTFNPIGEgc3ViZmxvdywgdGhlXG4gKiAgIHN1YnNlcXVlbnQgb25TdWJmbG93RW50cnkgY3JlYXRlcyBhIHN1YmZsb3cgQ0hJTEQgb2YgdGhlIHN5bnRoZXRpYyBub2RlLlxuICogICBUaGUgbGF5ZXJlZCBzaGFwZSBwcmVzZXJ2ZXMgYm90aCBcIndobyBicmFuY2hlZFwiIGFuZCBcIndoYXQgdGhlIGJyYW5jaCByYW4uXCJcbiAqXG4gKiAgIFBsYWluIHNlcXVlbnRpYWwgc3RhZ2VzIGFyZSBOT1Qgbm9kZXMg4oCUIHRoYXQncyBTdGFnZUNvbnRleHQncyBqb2IuXG4gKiAgIFRvcG9sb2d5IGlzIGEgZ3JhcGggb2YgY29udHJvbC1mbG93IGJyYW5jaGluZywgbm90IGEgZnVsbCBleGVjdXRpb24gdHJlZS5cbiAqXG4gKiBFZGdlczpcbiAqICAgT25lIGVkZ2UgcGVyIHRyYXZlcnNhbCB0cmFuc2l0aW9uIOKAlCBga2luZGAgbWF0Y2hlcyB0aGUgY2hpbGQnc1xuICogICBgaW5jb21pbmdLaW5kYC4gQSBjb25zdW1lciByZW5kZXJpbmcgXCJwYXJhbGxlbCBjb2x1bW5zXCIgZmlsdGVycyBlZGdlc1xuICogICB3aGVyZSBga2luZCA9PT0gJ2ZvcmstYnJhbmNoJ2Agc2hhcmluZyB0aGUgc2FtZSBgZnJvbWAuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGltcG9ydCB7IHRvcG9sb2d5UmVjb3JkZXIgfSBmcm9tICdmb290cHJpbnRqcy90cmFjZSc7XG4gKlxuICogY29uc3QgdG9wbyA9IHRvcG9sb2d5UmVjb3JkZXIoKTtcbiAqIGV4ZWN1dG9yLmF0dGFjaENvbWJpbmVkUmVjb3JkZXIodG9wbyk7ICAvLyBhdXRvLXJvdXRlcyB0byBGbG93UmVjb3JkZXIgY2hhbm5lbFxuICpcbiAqIGF3YWl0IGV4ZWN1dG9yLnJ1bigpO1xuICpcbiAqIGNvbnN0IHsgbm9kZXMsIGVkZ2VzLCBhY3RpdmVOb2RlSWQsIHJvb3RJZCB9ID0gdG9wby5nZXRUb3BvbG9neSgpO1xuICogLy8gQ29uc3VtZXIgcXVlcmllczpcbiAqIHRvcG8uZ2V0Q2hpbGRyZW4oJ3NmLXBhcmVudCcpOyAgICAgICAgICAgICAgLy8gZGlyZWN0IGNoaWxkcmVuIChhbnkga2luZClcbiAqIHRvcG8uZ2V0QnlLaW5kKCdmb3JrLWJyYW5jaCcpOyAgICAgICAgICAgICAgLy8gYWxsIHBhcmFsbGVsIGJyYW5jaGVzXG4gKiB0b3BvLmdldFN1YmZsb3dOb2RlcygpOyAgICAgICAgICAgICAgICAgICAgIC8vIG9ubHkgbW91bnRlZCBzdWJmbG93c1xuICogYGBgXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBGbG93RGVjaXNpb25FdmVudCxcbiAgRmxvd0ZvcmtFdmVudCxcbiAgRmxvd0xvb3BFdmVudCxcbiAgRmxvd1JlY29yZGVyLFxuICBGbG93U3ViZmxvd0V2ZW50LFxufSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL3R5cGVzLmpzJztcblxuLyoqIFRoZSBraW5kIG9mIGNvbXBvc2l0aW9uIHVuaXQgYSBub2RlIHJlcHJlc2VudHMuICovXG5leHBvcnQgdHlwZSBUb3BvbG9neU5vZGVLaW5kID0gJ3N1YmZsb3cnIHwgJ2ZvcmstYnJhbmNoJyB8ICdkZWNpc2lvbi1icmFuY2gnO1xuXG4vKiogSG93IHRoZSB0cmF2ZXJzYWwgcmVhY2hlZCB0aGlzIG5vZGUg4oCUIGRyaXZlcyBjb25zdW1lciBsYXlvdXQgZGVjaXNpb25zLiAqL1xuZXhwb3J0IHR5cGUgVG9wb2xvZ3lJbmNvbWluZ0tpbmQgPSAncm9vdCcgfCAnbmV4dCcgfCAnZm9yay1icmFuY2gnIHwgJ2RlY2lzaW9uLWJyYW5jaCcgfCAnbG9vcC1pdGVyYXRpb24nO1xuXG4vKiogQSBjb21wb3NpdGlvbi1zaWduaWZpY2FudCBwb2ludCBpbiB0aGUgZ3JhcGguICovXG5leHBvcnQgaW50ZXJmYWNlIFRvcG9sb2d5Tm9kZSB7XG4gIC8qKiBVbmlxdWUgaWQuIFN1YmZsb3dzIHVzZSB0aGVpciBzdWJmbG93SWQgKHdpdGggYCNuYCBzdWZmaXggb24gcmUtZW50cnkpLlxuICAgKiAgU3ludGhldGljIG5vZGVzIChmb3JrLWJyYW5jaCAvIGRlY2lzaW9uLWJyYW5jaCkgdXNlXG4gICAqICBgZm9yay0ke3J1bnRpbWVTdGFnZUlkfS0ke2l9LSR7Y2hpbGROYW1lfWAgLyBgZGVjaXNpb24tJHtydW50aW1lU3RhZ2VJZH0tJHtjaG9zZW59YCBmb3JtLiAqL1xuICByZWFkb25seSBpZDogc3RyaW5nO1xuICAvKiogV2hhdCB0aGlzIG5vZGUgcmVwcmVzZW50cy4gKi9cbiAgcmVhZG9ubHkga2luZDogVG9wb2xvZ3lOb2RlS2luZDtcbiAgLyoqIERpc3BsYXkgbmFtZS4gRm9yIHN1YmZsb3dzOiBgRmxvd1N1YmZsb3dFdmVudC5uYW1lYC4gRm9yIGZvcmstYnJhbmNoZXM6XG4gICAqICB0aGUgY2hpbGQgbmFtZSBmcm9tIGBGbG93Rm9ya0V2ZW50LmNoaWxkcmVuYC4gRm9yIGRlY2lzaW9uLWJyYW5jaGVzOlxuICAgKiAgdGhlIGNob3NlbiBuYW1lIGZyb20gYEZsb3dEZWNpc2lvbkV2ZW50LmNob3NlbmAuICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcbiAgLyoqIFBhcmVudCBub2RlIGlkLiBVbmRlZmluZWQgd2hlbiB0aGlzIG5vZGUgc2l0cyBhdCB0aGUgcnVuJ3MgdG9wIGxldmVsLiAqL1xuICByZWFkb25seSBwYXJlbnRJZD86IHN0cmluZztcbiAgLyoqIERlcHRoIGluIHRoZSB0b3BvbG9neSB0cmVlICgwID0gdG9wLWxldmVsKS4gKi9cbiAgcmVhZG9ubHkgZGVwdGg6IG51bWJlcjtcbiAgLyoqIEhvdyB0aGUgdHJhdmVyc2FsIHJlYWNoZWQgdGhpcyBub2RlLiAqL1xuICByZWFkb25seSBpbmNvbWluZ0tpbmQ6IFRvcG9sb2d5SW5jb21pbmdLaW5kO1xuICAvKiogcnVudGltZVN0YWdlSWQgYXQgdGhlIG1vbWVudCB0aGUgbm9kZSB3YXMgY3JlYXRlZC4gKi9cbiAgcmVhZG9ubHkgZW50ZXJlZEF0OiBzdHJpbmc7XG4gIC8qKiBydW50aW1lU3RhZ2VJZCB3aGVuIHRoZSBjb3JyZXNwb25kaW5nIHN1YmZsb3cgZXhpdGVkLiBPbmx5IG1lYW5pbmdmdWxcbiAgICogIGZvciBraW5kPSdzdWJmbG93JzsgZm9yay9kZWNpc2lvbi1icmFuY2ggbm9kZXMgYXJlIGluc3RhbnRhbmVvdXMuICovXG4gIGV4aXRlZEF0Pzogc3RyaW5nO1xuICAvKiogS2luZC1zcGVjaWZpYyBleHRyYXM6IGZvcmtQYXJlbnQsIGRlY2lkZXIsIHJhdGlvbmFsZSwgZGVzY3JpcHRpb24uICovXG4gIHJlYWRvbmx5IG1ldGFkYXRhPzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xufVxuXG4vKiogQSB0cmF2ZXJzYWwgdHJhbnNpdGlvbiBiZXR3ZWVuIHR3byBub2Rlcy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9wb2xvZ3lFZGdlIHtcbiAgcmVhZG9ubHkgZnJvbTogc3RyaW5nO1xuICByZWFkb25seSB0bzogc3RyaW5nO1xuICByZWFkb25seSBraW5kOiBFeGNsdWRlPFRvcG9sb2d5SW5jb21pbmdLaW5kLCAncm9vdCc+O1xuICByZWFkb25seSBhdDogc3RyaW5nO1xufVxuXG4vKiogU25hcHNob3Qgb2YgdGhlIGNvbXBvc2l0aW9uIGdyYXBoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb3BvbG9neSB7XG4gIHJlYWRvbmx5IG5vZGVzOiBSZWFkb25seUFycmF5PFRvcG9sb2d5Tm9kZT47XG4gIHJlYWRvbmx5IGVkZ2VzOiBSZWFkb25seUFycmF5PFRvcG9sb2d5RWRnZT47XG4gIC8qKiBDdXJyZW50bHktYWN0aXZlIHN1YmZsb3cgKHRvcCBvZiB0aGUgc3ViZmxvdyBzdGFjaykuIEZvcmstYnJhbmNoIGFuZFxuICAgKiAgZGVjaXNpb24tYnJhbmNoIG5vZGVzIGFyZSBpbnN0YW50YW5lb3VzIOKAlCB0aGV5IGRvbid0IGFmZmVjdCBhY3RpdmVOb2RlSWQuICovXG4gIHJlYWRvbmx5IGFjdGl2ZU5vZGVJZDogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIEZpcnN0IG5vZGUgaW5zZXJ0ZWQuIG51bGwgYmVmb3JlIGFueSBjb21wb3NpdGlvbiBldmVudCBmaXJlcy4gKi9cbiAgcmVhZG9ubHkgcm9vdElkOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRvcG9sb2d5UmVjb3JkZXJPcHRpb25zIHtcbiAgLyoqIFNjb3BlUmVjb3JkZXIgaWQuIERlZmF1bHRzIHRvIGB0b3BvbG9neS1OYCAoYXV0by1pbmNyZW1lbnRlZCkuICovXG4gIGlkPzogc3RyaW5nO1xufVxuXG4vLyBDb3JyZWxhdGlvbiBzdGF0ZTogbWFwcyBhIHBlbmRpbmcgZm9yay9kZWNpc2lvbiBjaGlsZCBuYW1lIHRvIGl0cyBzeW50aGV0aWNcbi8vIG5vZGUgaWQsIHNvIGEgc3Vic2VxdWVudCBvblN1YmZsb3dFbnRyeSBtYXRjaGluZyB0aGF0IG5hbWUgY2FuIGJlIG5lc3RlZFxuLy8gdW5kZXIgdGhlIHN5bnRoZXRpYyBub2RlIChyYXRoZXIgdGhhbiBjcmVhdGluZyBhIHBlZXIpLlxuaW50ZXJmYWNlIFBlbmRpbmdDaGlsZCB7XG4gIG5vZGVJZDogc3RyaW5nO1xuICBhdDogc3RyaW5nO1xufVxuXG5sZXQgX2NvdW50ZXIgPSAwO1xuXG4vKipcbiAqIEZhY3Rvcnkg4oCUIG1hdGNoZXMgdGhlIGBuYXJyYXRpdmUoKWAgLyBgbWV0cmljcygpYCBzdHlsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvcG9sb2d5UmVjb3JkZXIob3B0aW9uczogVG9wb2xvZ3lSZWNvcmRlck9wdGlvbnMgPSB7fSk6IFRvcG9sb2d5UmVjb3JkZXIge1xuICByZXR1cm4gbmV3IFRvcG9sb2d5UmVjb3JkZXIob3B0aW9ucyk7XG59XG5cbi8qKlxuICogU3RhdGVmdWwgYWNjdW11bGF0b3IgdGhhdCB3YXRjaGVzIEZsb3dSZWNvcmRlciBldmVudHMgYW5kIG1haW50YWlucyBhIGxpdmVcbiAqIGNvbXBvc2l0aW9uIGdyYXBoLiBBdHRhY2ggdmlhIGBleGVjdXRvci5hdHRhY2hDb21iaW5lZFJlY29yZGVyKHJlY29yZGVyKWAg4oCUXG4gKiBmb290cHJpbnRqcyBkZXRlY3RzIHRoZSBgRmxvd1JlY29yZGVyYCBtZXRob2Qgc2hhcGUgYW5kIHJvdXRlcyBldmVudHMuXG4gKi9cbmV4cG9ydCBjbGFzcyBUb3BvbG9neVJlY29yZGVyIGltcGxlbWVudHMgRmxvd1JlY29yZGVyIHtcbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcblxuICBwcml2YXRlIHJlYWRvbmx5IG5vZGVzQnlJZCA9IG5ldyBNYXA8c3RyaW5nLCBUb3BvbG9neU5vZGU+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgbm9kZU9yZGVyOiBzdHJpbmdbXSA9IFtdO1xuICBwcml2YXRlIHJlYWRvbmx5IGVkZ2VzOiBUb3BvbG9neUVkZ2VbXSA9IFtdO1xuICAvKiogU3RhY2sgb2YgYWN0aXZlIFNVQkZMT1cgbm9kZSBpZHMuIEZvcmsvZGVjaXNpb24tYnJhbmNoIG5vZGVzIG5ldmVyIHB1c2guICovXG4gIHByaXZhdGUgcmVhZG9ubHkgc3ViZmxvd1N0YWNrOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8qKiBNYXAgb2YgY2hpbGROYW1lIOKGkiBwZW5kaW5nIGZvcmstYnJhbmNoIHN5bnRoZXRpYyBub2RlLCBjb25zdW1lZCBieVxuICAgKiAgdGhlIG5leHQgbWF0Y2hpbmcgYG9uU3ViZmxvd0VudHJ5YC4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBwZW5kaW5nRm9ya0J5TmFtZSA9IG5ldyBNYXA8c3RyaW5nLCBQZW5kaW5nQ2hpbGQ+KCk7XG4gIC8qKiBQZW5kaW5nIGRlY2lzaW9uLWJyYW5jaCBzeW50aGV0aWMgbm9kZSwgY29uc3VtZWQgYnkgYSBtYXRjaGluZyBlbnRyeS4gKi9cbiAgcHJpdmF0ZSBwZW5kaW5nRGVjaXNpb24/OiB7IG5hbWU6IHN0cmluZyB9ICYgUGVuZGluZ0NoaWxkO1xuICAvKipcbiAgICogVGhlIHByZXZpb3VzIHN1YmZsb3cgdGhhdCBqdXN0IGZpbmlzaGVkLCBrZXllZCBieSBzY29wZSAocGFyZW50SWQsXG4gICAqIG9yICcnIGZvciByb290KS4gV2hlbiBhIG5ldyBzdWJmbG93IGVudGVycyBpbiB0aGUgc2FtZSBzY29wZSB2aWFcbiAgICogdGhlIG5vcm1hbCBuZXh0LWNoYWluZWQgcGF0aCAobm90IGZvcmsvZGVjaXNpb24pLCB3ZSBlbWl0IGEgYG5leHRgXG4gICAqIGVkZ2UgZnJvbSB0aGUgcHJldmlvdXMgc3ViZmxvdyB0byB0aGUgbmV3IG9uZSDigJQgbWF0Y2hpbmcgaG93IHRoZVxuICAgKiBidWlsZGVyIGFjdHVhbGx5IHdpcmVkIHRoZW06IGAuYWRkU3ViRmxvd0NoYXJ0TmV4dChBKS5hZGRTdWJGbG93Q2hhcnROZXh0KEIpYFxuICAgKiBtZWFucyBBIOKGkiBCLCBvbmUgYWZ0ZXIgdGhlIG90aGVyLlxuICAgKlxuICAgKiBXaXRob3V0IHRoaXMsIGNvbnN1bWVycyBvbmx5IHNlZSBwYXJlbnTihpJjaGlsZCBlZGdlcyAoQSwgQiwgQyBhbGxcbiAgICogY2hpbGRyZW4gb2YgdGhlaXIgY29tbW9uIGFuY2VzdG9yKSB3aXRoIG5vIHJlY29yZCBvZiB0aGUgYWN0dWFsXG4gICAqIEEg4oaSIEIg4oaSIEMgc2VxdWVudGlhbCBjaGFpbiB0aGF0IHJhbiDigJQgd2hpY2ggaXMgZXhhY3RseSB3aGF0XG4gICAqIFRvcG9sb2d5UmVjb3JkZXIgaXMgc3VwcG9zZWQgdG8gZXhwb3NlLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBwcmV2aW91c1N1YmZsb3dJblNjb3BlID0gbmV3IE1hcDxzdHJpbmcsIHsgbm9kZUlkOiBzdHJpbmc7IGV4aXRlZEF0OiBzdHJpbmcgfT4oKTtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBUb3BvbG9neVJlY29yZGVyT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5pZCA9IG9wdGlvbnMuaWQgPz8gYHRvcG9sb2d5LSR7KytfY291bnRlcn1gO1xuICB9XG5cbiAgLy8g4pSA4pSAIEZsb3dSZWNvcmRlciBob29rcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBvblN1YmZsb3dFbnRyeShldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IHN1YmZsb3dJZCA9IGV2ZW50LnN1YmZsb3dJZDtcbiAgICBpZiAoIXN1YmZsb3dJZCkgcmV0dXJuOyAvLyBOZWVkIGEgc3RhYmxlIGlkIHRvIHRyYWNrLlxuXG4gICAgY29uc3QgZW50ZXJlZEF0ID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8ucnVudGltZVN0YWdlSWQgPz8gJyc7XG5cbiAgICAvLyBEZXRlcm1pbmUgdGhlIHBhcmVudDogcHJlZmVyIGEgcGVuZGluZyBmb3JrL2RlY2lzaW9uIG1hdGNoIGJ5IG5hbWUsXG4gICAgLy8gb3RoZXJ3aXNlIHRoZSBjdXJyZW50IHRvcC1vZi1zdWJmbG93LXN0YWNrLlxuICAgIGxldCBwYXJlbnRJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBpbmNvbWluZ0tpbmQ6IFRvcG9sb2d5SW5jb21pbmdLaW5kO1xuXG4gICAgY29uc3QgcGVuZGluZ0ZvcmsgPSB0aGlzLnBlbmRpbmdGb3JrQnlOYW1lLmdldChldmVudC5uYW1lKTtcbiAgICBpZiAocGVuZGluZ0ZvcmspIHtcbiAgICAgIHBhcmVudElkID0gcGVuZGluZ0Zvcmsubm9kZUlkO1xuICAgICAgaW5jb21pbmdLaW5kID0gJ25leHQnOyAvLyBDaGlsZCBPRiBhIGZvcmstYnJhbmNoIG5vZGU7IHRoZSBmb3JrIHNlbWFudGljXG4gICAgICAvLyBpcyBjYXB0dXJlZCBieSB0aGUgZm9yay1icmFuY2gncyBvd24gaW5jb21pbmdLaW5kLlxuICAgICAgdGhpcy5wZW5kaW5nRm9ya0J5TmFtZS5kZWxldGUoZXZlbnQubmFtZSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLnBlbmRpbmdEZWNpc2lvbiAmJiB0aGlzLnBlbmRpbmdEZWNpc2lvbi5uYW1lID09PSBldmVudC5uYW1lKSB7XG4gICAgICBwYXJlbnRJZCA9IHRoaXMucGVuZGluZ0RlY2lzaW9uLm5vZGVJZDtcbiAgICAgIGluY29taW5nS2luZCA9ICduZXh0JztcbiAgICAgIHRoaXMucGVuZGluZ0RlY2lzaW9uID0gdW5kZWZpbmVkO1xuICAgIH0gZWxzZSB7XG4gICAgICBwYXJlbnRJZCA9IHRoaXMuc3ViZmxvd1N0YWNrW3RoaXMuc3ViZmxvd1N0YWNrLmxlbmd0aCAtIDFdO1xuICAgICAgaW5jb21pbmdLaW5kID0gcGFyZW50SWQgPyAnbmV4dCcgOiAncm9vdCc7XG4gICAgfVxuXG4gICAgLy8gRGlzYW1iaWd1YXRlIHJlLWVudHJ5IChlLmcuLCBsb29wIGJvZHkgcmUtZW50ZXJzIHRoZSBzYW1lIHN1YmZsb3cpLlxuICAgIGxldCBub2RlSWQgPSBzdWJmbG93SWQ7XG4gICAgaWYgKHRoaXMubm9kZXNCeUlkLmhhcyhub2RlSWQpKSB7XG4gICAgICBsZXQgbiA9IDE7XG4gICAgICB3aGlsZSAodGhpcy5ub2Rlc0J5SWQuaGFzKGAke3N1YmZsb3dJZH0jJHtufWApKSBuKys7XG4gICAgICBub2RlSWQgPSBgJHtzdWJmbG93SWR9IyR7bn1gO1xuICAgIH1cblxuICAgIGNvbnN0IGRlcHRoID0gcGFyZW50SWQgPyB0aGlzLm5vZGVzQnlJZC5nZXQocGFyZW50SWQpIS5kZXB0aCArIDEgOiAwO1xuICAgIGNvbnN0IG1ldGFkYXRhID0gZXZlbnQuZGVzY3JpcHRpb24gPyB7IGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbiB9IDogdW5kZWZpbmVkO1xuXG4gICAgY29uc3Qgbm9kZTogVG9wb2xvZ3lOb2RlID0ge1xuICAgICAgaWQ6IG5vZGVJZCxcbiAgICAgIGtpbmQ6ICdzdWJmbG93JyxcbiAgICAgIG5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICBwYXJlbnRJZCxcbiAgICAgIGRlcHRoLFxuICAgICAgaW5jb21pbmdLaW5kLFxuICAgICAgZW50ZXJlZEF0LFxuICAgICAgbWV0YWRhdGEsXG4gICAgfTtcbiAgICB0aGlzLm5vZGVzQnlJZC5zZXQobm9kZUlkLCBub2RlKTtcbiAgICB0aGlzLm5vZGVPcmRlci5wdXNoKG5vZGVJZCk7XG5cbiAgICBpZiAocGFyZW50SWQgJiYgaW5jb21pbmdLaW5kICE9PSAncm9vdCcpIHtcbiAgICAgIHRoaXMuZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb206IHBhcmVudElkLFxuICAgICAgICB0bzogbm9kZUlkLFxuICAgICAgICBraW5kOiBpbmNvbWluZ0tpbmQsXG4gICAgICAgIGF0OiBlbnRlcmVkQXQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBOZXh0LWNoYWluZWQgZWRnZSBmcm9tIHRoZSBQUkVWSU9VUyBzdWJmbG93IGluIHRoaXMgc2NvcGUuXG4gICAgLy9cbiAgICAvLyBgLmFkZFN1YkZsb3dDaGFydE5leHQoQSkuYWRkU3ViRmxvd0NoYXJ0TmV4dChCKS5hZGRTdWJGbG93Q2hhcnROZXh0KEMpYFxuICAgIC8vIHJ1bnMgYXM6IEEgZW50ZXJzIOKGkiBBIGV4aXRzIOKGkiBCIGVudGVycyDihpIgQiBleGl0cyDihpIgQyBlbnRlcnMuIEF0XG4gICAgLy8gQidzIGVudHJ5IHRoZSBzdGFjayBoYXMgcmV0dXJuZWQgdG8gdGhlIHNjb3BlIGl0IHdhcyBpbiBiZWZvcmUgQVxuICAgIC8vIGVudGVyZWQgKHJvb3QsIG9yIHRoZSBzaGFyZWQgYW5jZXN0b3IpLiBXaXRob3V0IHRoaXMgZWRnZSB3ZSdkXG4gICAgLy8gc2VlIG5vZGVzIHtBLCBCLCBDfSBidXQgbm8gcmVjb3JkIHRoYXQgQSByYW4gQkVGT1JFIEIgd2hpY2ggcmFuXG4gICAgLy8gQkVGT1JFIEMg4oCUIGFuZCBkb3duc3RyZWFtIGNvbnN1bWVycyB3b3VsZCBoYXZlIHRvIHJlY29uc3RydWN0XG4gICAgLy8gc2VxdWVudGlhbCBvcmRlcmluZyB0aGVtc2VsdmVzLlxuICAgIC8vXG4gICAgLy8gT25seSBlbWl0IG9uIHRoZSByZWd1bGFyLWVudHJ5IHBhdGguIEZvcmsvZGVjaXNpb24gZW50cmllcyBoYXZlXG4gICAgLy8gdGhlaXIgb3duIGVkZ2UgbWVjaGFuaWNzIChwYXJlbnTihpJmb3JrLWJyYW5jaCwgcGFyZW504oaSZGVjaXNpb24tXG4gICAgLy8gYnJhbmNoKSB0aGF0IGNhcnJ5IHRoZSBicmFuY2hpbmcgc2VtYW50aWNzLlxuICAgIGlmIChpbmNvbWluZ0tpbmQgPT09ICduZXh0JyB8fCBpbmNvbWluZ0tpbmQgPT09ICdyb290Jykge1xuICAgICAgY29uc3Qgc2NvcGVLZXkgPSBwYXJlbnRJZCA/PyAnJztcbiAgICAgIGNvbnN0IHByZXZpb3VzID0gdGhpcy5wcmV2aW91c1N1YmZsb3dJblNjb3BlLmdldChzY29wZUtleSk7XG4gICAgICBpZiAocHJldmlvdXMpIHtcbiAgICAgICAgdGhpcy5lZGdlcy5wdXNoKHtcbiAgICAgICAgICBmcm9tOiBwcmV2aW91cy5ub2RlSWQsXG4gICAgICAgICAgdG86IG5vZGVJZCxcbiAgICAgICAgICBraW5kOiAnbmV4dCcsXG4gICAgICAgICAgYXQ6IGVudGVyZWRBdCxcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMucHJldmlvdXNTdWJmbG93SW5TY29wZS5kZWxldGUoc2NvcGVLZXkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuc3ViZmxvd1N0YWNrLnB1c2gobm9kZUlkKTtcbiAgfVxuXG4gIG9uU3ViZmxvd0V4aXQoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBub2RlSWQgPSB0aGlzLnN1YmZsb3dTdGFjay5wb3AoKTtcbiAgICBpZiAoIW5vZGVJZCkgcmV0dXJuO1xuICAgIGNvbnN0IG5vZGUgPSB0aGlzLm5vZGVzQnlJZC5nZXQobm9kZUlkKTtcbiAgICBjb25zdCBleGl0ZWRBdCA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnJ1bnRpbWVTdGFnZUlkID8/ICcnO1xuICAgIGlmIChub2RlKSB7XG4gICAgICBub2RlLmV4aXRlZEF0ID0gZXhpdGVkQXQ7XG4gICAgICAvLyBSZW1lbWJlciB0aGlzIG5vZGUgYXMgdGhlIFwicHJldmlvdXMgc3ViZmxvd1wiIGluIGl0cyBzY29wZS5cbiAgICAgIC8vIFdoYXRldmVyIHN1YmZsb3cgZW50ZXJzIE5FWFQgaW4gdGhlIHNhbWUgc2NvcGUgKG5vcm1hbC1lbnRyeVxuICAgICAgLy8gcGF0aCwgbm90IGZvcmsvZGVjaXNpb24pIGdldHMgYSBgbmV4dGAgZWRnZSBkcmF3biBmcm9tIGhlcmVcbiAgICAgIC8vIOKAlCB0aGlzIGlzIHRoZSByZWFsIHNlcXVlbnRpYWwgQSDihpIgQiB0cmFuc2l0aW9uIHRoYXQgdGhlXG4gICAgICAvLyBgLmFkZFN1YkZsb3dDaGFydE5leHQoKWAgYnVpbGRlciBwcm9kdWNlZC5cbiAgICAgIGNvbnN0IHNjb3BlS2V5ID0gbm9kZS5wYXJlbnRJZCA/PyAnJztcbiAgICAgIHRoaXMucHJldmlvdXNTdWJmbG93SW5TY29wZS5zZXQoc2NvcGVLZXksIHsgbm9kZUlkLCBleGl0ZWRBdCB9KTtcbiAgICB9XG4gICAgLy8gQ2xlYXIgcGVuZGluZ0RlY2lzaW9uIG9uIGV4aXQg4oCUIGEgZGVjaXNpb24gaWRlbnRpZmllcyBleGFjdGx5IE9ORVxuICAgIC8vIHRhcmdldC4gSWYgdGhlIGNob3NlbiBnb2VzIHRvIGEgcGxhaW4gc3RhZ2UgKG5vdCBhIHN1YmZsb3cpLCB0aGVcbiAgICAvLyBwZW5kaW5nIGVudHJ5IHdvdWxkIG90aGVyd2lzZSBsaW5nZXIgYW5kIGZhbHNlbHkgbWF0Y2ggYW5cbiAgICAvLyB1bnJlbGF0ZWQgc3ViZmxvdyBsYXRlciBpbiBhIGRpZmZlcmVudCBzY29wZS5cbiAgICB0aGlzLnBlbmRpbmdEZWNpc2lvbiA9IHVuZGVmaW5lZDtcbiAgICAvLyBEZWxpYmVyYXRlbHkgTk9UIGNsZWFyaW5nIHBlbmRpbmdGb3JrQnlOYW1lIOKAlCBmb3JrIHNpYmxpbmdzIG5lZWRcbiAgICAvLyB0aGVpciBwZW5kaW5nIGVudHJpZXMgdG8gc3Vydml2ZSBzY29wZSBleGl0cyBvZiBlYXJsaWVyIHNpYmxpbmdzXG4gICAgLy8gKGUuZy4gQWxwaGEncyBpbm5lciBzZi1tZXNzYWdlcyBleGl0cyBiZWZvcmUgQmV0YSBlbnRlcnMpLiBGb3JrXG4gICAgLy8gcGVuZGluZyBlbnRyaWVzIGFyZSBjbGVhcmVkIG9uIG5ldyBgb25Gb3JrYCBvciBjb25zdW1lZCBvbiBtYXRjaC5cbiAgfVxuXG4gIG9uRm9yayhldmVudDogRmxvd0ZvcmtFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGFjdGl2ZUlkID0gdGhpcy5zdWJmbG93U3RhY2tbdGhpcy5zdWJmbG93U3RhY2subGVuZ3RoIC0gMV07XG4gICAgY29uc3QgYXQgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5ydW50aW1lU3RhZ2VJZCA/PyAnJztcbiAgICBjb25zdCBkZXB0aCA9IGFjdGl2ZUlkID8gdGhpcy5ub2Rlc0J5SWQuZ2V0KGFjdGl2ZUlkKSEuZGVwdGggKyAxIDogMDtcblxuICAgIC8vIFJlc2V0IGFueSBwcmlvciBwZW5kaW5nIGZvcmsgc3RhdGUg4oCUIGEgbmV3IGZvcmsgc3RhcnRzIGZyZXNoLlxuICAgIHRoaXMucGVuZGluZ0ZvcmtCeU5hbWUuY2xlYXIoKTtcblxuICAgIGV2ZW50LmNoaWxkcmVuLmZvckVhY2goKGNoaWxkTmFtZSwgaSkgPT4ge1xuICAgICAgY29uc3Qgbm9kZUlkID0gYGZvcmstJHthdCB8fCBldmVudC5wYXJlbnR9LSR7aX0tJHtjaGlsZE5hbWV9YDtcbiAgICAgIGNvbnN0IG5vZGU6IFRvcG9sb2d5Tm9kZSA9IHtcbiAgICAgICAgaWQ6IG5vZGVJZCxcbiAgICAgICAga2luZDogJ2ZvcmstYnJhbmNoJyxcbiAgICAgICAgbmFtZTogY2hpbGROYW1lLFxuICAgICAgICBwYXJlbnRJZDogYWN0aXZlSWQsXG4gICAgICAgIGRlcHRoLFxuICAgICAgICBpbmNvbWluZ0tpbmQ6ICdmb3JrLWJyYW5jaCcsXG4gICAgICAgIGVudGVyZWRBdDogYXQsXG4gICAgICAgIG1ldGFkYXRhOiB7IGZvcmtQYXJlbnQ6IGV2ZW50LnBhcmVudCB9LFxuICAgICAgfTtcbiAgICAgIHRoaXMubm9kZXNCeUlkLnNldChub2RlSWQsIG5vZGUpO1xuICAgICAgdGhpcy5ub2RlT3JkZXIucHVzaChub2RlSWQpO1xuICAgICAgaWYgKGFjdGl2ZUlkKSB7XG4gICAgICAgIHRoaXMuZWRnZXMucHVzaCh7IGZyb206IGFjdGl2ZUlkLCB0bzogbm9kZUlkLCBraW5kOiAnZm9yay1icmFuY2gnLCBhdCB9KTtcbiAgICAgIH1cbiAgICAgIHRoaXMucGVuZGluZ0ZvcmtCeU5hbWUuc2V0KGNoaWxkTmFtZSwgeyBub2RlSWQsIGF0IH0pO1xuICAgIH0pO1xuICB9XG5cbiAgb25EZWNpc2lvbihldmVudDogRmxvd0RlY2lzaW9uRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBhY3RpdmVJZCA9IHRoaXMuc3ViZmxvd1N0YWNrW3RoaXMuc3ViZmxvd1N0YWNrLmxlbmd0aCAtIDFdO1xuICAgIGNvbnN0IGF0ID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8ucnVudGltZVN0YWdlSWQgPz8gJyc7XG4gICAgY29uc3QgZGVwdGggPSBhY3RpdmVJZCA/IHRoaXMubm9kZXNCeUlkLmdldChhY3RpdmVJZCkhLmRlcHRoICsgMSA6IDA7XG5cbiAgICAvLyBBIG5ldyBkZWNpc2lvbiBzdXBlcnNlZGVzIGFueSBwcmlvciB1bnJlc29sdmVkIHBlbmRpbmcgb25lLlxuICAgIHRoaXMucGVuZGluZ0RlY2lzaW9uID0gdW5kZWZpbmVkO1xuXG4gICAgY29uc3Qgbm9kZUlkID0gYGRlY2lzaW9uLSR7YXQgfHwgZXZlbnQuZGVjaWRlcn0tJHtldmVudC5jaG9zZW59YDtcbiAgICBjb25zdCBtZXRhZGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IGRlY2lkZXI6IGV2ZW50LmRlY2lkZXIgfTtcbiAgICBpZiAoZXZlbnQucmF0aW9uYWxlKSBtZXRhZGF0YS5yYXRpb25hbGUgPSBldmVudC5yYXRpb25hbGU7XG4gICAgaWYgKGV2ZW50LmRlc2NyaXB0aW9uKSBtZXRhZGF0YS5kZXNjcmlwdGlvbiA9IGV2ZW50LmRlc2NyaXB0aW9uO1xuXG4gICAgY29uc3Qgbm9kZTogVG9wb2xvZ3lOb2RlID0ge1xuICAgICAgaWQ6IG5vZGVJZCxcbiAgICAgIGtpbmQ6ICdkZWNpc2lvbi1icmFuY2gnLFxuICAgICAgbmFtZTogZXZlbnQuY2hvc2VuLFxuICAgICAgcGFyZW50SWQ6IGFjdGl2ZUlkLFxuICAgICAgZGVwdGgsXG4gICAgICBpbmNvbWluZ0tpbmQ6ICdkZWNpc2lvbi1icmFuY2gnLFxuICAgICAgZW50ZXJlZEF0OiBhdCxcbiAgICAgIG1ldGFkYXRhLFxuICAgIH07XG4gICAgdGhpcy5ub2Rlc0J5SWQuc2V0KG5vZGVJZCwgbm9kZSk7XG4gICAgdGhpcy5ub2RlT3JkZXIucHVzaChub2RlSWQpO1xuICAgIGlmIChhY3RpdmVJZCkge1xuICAgICAgdGhpcy5lZGdlcy5wdXNoKHsgZnJvbTogYWN0aXZlSWQsIHRvOiBub2RlSWQsIGtpbmQ6ICdkZWNpc2lvbi1icmFuY2gnLCBhdCB9KTtcbiAgICB9XG4gICAgdGhpcy5wZW5kaW5nRGVjaXNpb24gPSB7IG5hbWU6IGV2ZW50LmNob3Nlbiwgbm9kZUlkLCBhdCB9O1xuICB9XG5cbiAgb25Mb29wKGV2ZW50OiBGbG93TG9vcEV2ZW50KTogdm9pZCB7XG4gICAgLy8gbG9vcFRvIGp1bXBzIGJhY2sgaW5zaWRlIHRoZSBDVVJSRU5UIHN1YmZsb3cuIFJlY29yZCBhIHNlbGYtZWRnZSBvbiB0aGVcbiAgICAvLyBhY3RpdmUgc3ViZmxvdyDigJQgc3ludGhldGljIGZvcmsvZGVjaXNpb24gbm9kZXMgZG9uJ3QgcGFydGljaXBhdGUgaW4gbG9vcHMuXG4gICAgY29uc3QgYWN0aXZlSWQgPSB0aGlzLnN1YmZsb3dTdGFja1t0aGlzLnN1YmZsb3dTdGFjay5sZW5ndGggLSAxXTtcbiAgICBpZiAoIWFjdGl2ZUlkKSByZXR1cm47XG4gICAgdGhpcy5lZGdlcy5wdXNoKHtcbiAgICAgIGZyb206IGFjdGl2ZUlkLFxuICAgICAgdG86IGFjdGl2ZUlkLFxuICAgICAga2luZDogJ2xvb3AtaXRlcmF0aW9uJyxcbiAgICAgIGF0OiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5ydW50aW1lU3RhZ2VJZCA/PyAnJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDYWxsZWQgYnkgdGhlIGV4ZWN1dG9yIGJlZm9yZSBlYWNoIGBydW4oKWAg4oCUIHJlc2V0cyBhbGwgc3RhdGUuICovXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIHRoaXMubm9kZXNCeUlkLmNsZWFyKCk7XG4gICAgdGhpcy5ub2RlT3JkZXIubGVuZ3RoID0gMDtcbiAgICB0aGlzLmVkZ2VzLmxlbmd0aCA9IDA7XG4gICAgdGhpcy5zdWJmbG93U3RhY2subGVuZ3RoID0gMDtcbiAgICB0aGlzLnBlbmRpbmdGb3JrQnlOYW1lLmNsZWFyKCk7XG4gICAgdGhpcy5wcmV2aW91c1N1YmZsb3dJblNjb3BlLmNsZWFyKCk7XG4gICAgdGhpcy5wZW5kaW5nRGVjaXNpb24gPSB1bmRlZmluZWQ7XG4gIH1cblxuICAvLyDilIDilIAgUXVlcnkgQVBJIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBMaXZlIHNuYXBzaG90IG9mIHRoZSBjb21wb3NpdGlvbiBncmFwaC4gU2FmZSBkdXJpbmcgb3IgYWZ0ZXIgYSBydW4uICovXG4gIGdldFRvcG9sb2d5KCk6IFRvcG9sb2d5IHtcbiAgICBjb25zdCBub2RlcyA9IHRoaXMubm9kZU9yZGVyLm1hcCgoaWQpID0+IHRoaXMubm9kZXNCeUlkLmdldChpZCkhKTtcbiAgICByZXR1cm4ge1xuICAgICAgbm9kZXMsXG4gICAgICBlZGdlczogWy4uLnRoaXMuZWRnZXNdLFxuICAgICAgYWN0aXZlTm9kZUlkOiB0aGlzLnN1YmZsb3dTdGFja1t0aGlzLnN1YmZsb3dTdGFjay5sZW5ndGggLSAxXSA/PyBudWxsLFxuICAgICAgcm9vdElkOiB0aGlzLm5vZGVPcmRlclswXSA/PyBudWxsLFxuICAgIH07XG4gIH1cblxuICAvKiogRGlyZWN0IGNoaWxkcmVuIG9mIGEgbm9kZSDigJQgaW5zZXJ0aW9uLW9yZGVyZWQuICovXG4gIGdldENoaWxkcmVuKG5vZGVJZDogc3RyaW5nKTogVG9wb2xvZ3lOb2RlW10ge1xuICAgIHJldHVybiB0aGlzLm5vZGVPcmRlci5tYXAoKGlkKSA9PiB0aGlzLm5vZGVzQnlJZC5nZXQoaWQpISkuZmlsdGVyKChuKSA9PiBuLnBhcmVudElkID09PSBub2RlSWQpO1xuICB9XG5cbiAgLyoqIEFsbCBub2RlcyBvZiBhIGdpdmVuIGtpbmQuICovXG4gIGdldEJ5S2luZChraW5kOiBUb3BvbG9neU5vZGVLaW5kKTogVG9wb2xvZ3lOb2RlW10ge1xuICAgIHJldHVybiB0aGlzLm5vZGVPcmRlci5tYXAoKGlkKSA9PiB0aGlzLm5vZGVzQnlJZC5nZXQoaWQpISkuZmlsdGVyKChuKSA9PiBuLmtpbmQgPT09IGtpbmQpO1xuICB9XG5cbiAgLyoqIEFsbCBtb3VudGVkIHN1YmZsb3cgbm9kZXMuIENvbnZlbmllbmNlIGZvciBhZ2VudC1jZW50cmljIHZpZXdzLiAqL1xuICBnZXRTdWJmbG93Tm9kZXMoKTogVG9wb2xvZ3lOb2RlW10ge1xuICAgIHJldHVybiB0aGlzLmdldEJ5S2luZCgnc3ViZmxvdycpO1xuICB9XG5cbiAgLyoqIEFsbCBmb3JrLWJyYW5jaCBub2RlcyBzaGFyaW5nIHRoZSBzYW1lIHBhcmVudCBhcyBgbm9kZUlkYCDigJQgaS5lLixcbiAgICogIHBhcmFsbGVsIHNpYmxpbmdzIG9mIGEgcGFyYWxsZWwgYnJhbmNoLiBFbXB0eSBpZiBgbm9kZUlkYCBpc24ndCBhXG4gICAqICBmb3JrLWJyYW5jaCBvciBoYXMgbm8gcGFyZW50LiAqL1xuICBnZXRQYXJhbGxlbFNpYmxpbmdzKG5vZGVJZDogc3RyaW5nKTogVG9wb2xvZ3lOb2RlW10ge1xuICAgIGNvbnN0IG5vZGUgPSB0aGlzLm5vZGVzQnlJZC5nZXQobm9kZUlkKTtcbiAgICBpZiAoIW5vZGUgfHwgbm9kZS5raW5kICE9PSAnZm9yay1icmFuY2gnIHx8ICFub2RlLnBhcmVudElkKSByZXR1cm4gW107XG4gICAgcmV0dXJuIHRoaXMuZ2V0Q2hpbGRyZW4obm9kZS5wYXJlbnRJZCkuZmlsdGVyKChuKSA9PiBuLmtpbmQgPT09ICdmb3JrLWJyYW5jaCcpO1xuICB9XG5cbiAgLyoqIEVtaXQgYSBzbmFwc2hvdCBidW5kbGUgZm9yIGluY2x1c2lvbiBpbiBgZXhlY3V0b3IuZ2V0U25hcHNob3QoKWAuICovXG4gIHRvU25hcHNob3QoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6ICdUb3BvbG9neScsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvbXBvc2l0aW9uIGdyYXBoOiBzdWJmbG93IGJvdW5kYXJpZXMsIGZvcmsgYnJhbmNoZXMsIGRlY2lzaW9uIGJyYW5jaGVzJyxcbiAgICAgIHByZWZlcnJlZE9wZXJhdGlvbjogJ3RyYW5zbGF0ZScgYXMgY29uc3QsXG4gICAgICBkYXRhOiB0aGlzLmdldFRvcG9sb2d5KCksXG4gICAgfTtcbiAgfVxufVxuIl19