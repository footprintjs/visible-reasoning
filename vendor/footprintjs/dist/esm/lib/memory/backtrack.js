/**
 * backtrack.ts — Backward causal chain analysis on the commit log.
 *
 * Implements **backward program slicing** (Weiser 1984, thin-slice variant):
 * given a starting execution step, walk backwards through read→write
 * dependencies to build the causal DAG that produced the data at that step.
 *
 * ## Algorithm
 *
 * BFS on the implicit dependency graph where edges run from reader → writer.
 *
 * 1. Locate startId in commitLog → root node
 * 2. Get keysRead for root via `getKeysRead` callback
 * 3. For each key read, find who last wrote it before this step → parent commit
 * 4. Create parent CausalNode, link to root.parents
 * 5. Enqueue parent. Repeat until queue empty or limits hit.
 *
 * Output is a **DAG** (not a linked list): a stage reading `creditScore` AND `dti`
 * from different writers has two parents.
 *
 * ## Staged Optimization
 *
 * Two writer-lookup strategies, chosen automatically by commit log size:
 *
 * | Strategy | When | Complexity per lookup |
 * |----------|------|----------------------|
 * | Linear scan | N ≤ 256 | O(N) — simple backward scan |
 * | Reverse index | N > 256 | O(K log N) — prebuilt key→[indices], binary search |
 *
 * The threshold (256) is chosen so the O(N) build cost of the reverse index
 * is amortized over the BFS traversal. Below 256, linear scan wins because
 * there's no index build overhead. The consumer never sees this — `causalChain()`
 * picks the right strategy internally (like a query optimizer choosing between
 * sequential scan vs index scan based on table size).
 *
 * ## Complexity
 *
 * - **Small logs (N ≤ 256):** O(V × K × N) total. V=visited, K=avg keys/node.
 * - **Large logs (N > 256):** O(N × U) index build + O(V × K × log N) lookups.
 *   U = unique keys. Amortized over all BFS hops.
 *
 * ## References
 *
 * - Weiser, M. (1984). "Program Slicing." IEEE TSE.
 * - Sridharan, M. et al. (2007). "Thin Slicing." PLDI.
 *
 * @example
 * ```typescript
 * import { causalChain, flattenCausalDAG, formatCausalChain } from 'footprintjs/trace';
 *
 * const dag = causalChain(commitLog, 'decide#2', (id) => recorder.getKeysRead(id));
 * const flat = flattenCausalDAG(dag);     // BFS-ordered flat list
 * console.log(formatCausalChain(dag));     // human-readable
 * ```
 */
import { isDevMode } from '../scope/detectCircular.js';
import { findLastWriter } from './commitLogUtils.js';
// ── Staged optimization: writer lookup strategies ──────────────────────
/**
 * Threshold for switching from linear scan to reverse index.
 * Below this, O(N) scan is faster (no index build cost).
 * Above this, O(log N) binary search wins.
 */
const REVERSE_INDEX_THRESHOLD = 256;
/** Strategy 1: Linear scan — O(N) per lookup, zero setup cost. */
function linearScanLookup(commitLog) {
    return (key, beforeIdx) => findLastWriter(commitLog, key, beforeIdx);
}
/**
 * Strategy 2: Reverse index — O(N×U) build, O(log N) per lookup.
 * Builds a Map<key, sortedIndices[]> where indices are commit positions
 * that wrote that key. Lookup uses binary search to find the last writer
 * before a given position.
 */
function reverseIndexLookup(commitLog) {
    // Build: key → sorted array of commit indices that wrote this key
    const index = new Map();
    for (let i = 0; i < commitLog.length; i++) {
        for (const t of commitLog[i].trace) {
            let arr = index.get(t.path);
            if (!arr) {
                arr = [];
                index.set(t.path, arr);
            }
            arr.push(i); // already sorted (we iterate in order)
        }
    }
    return (key, beforeIdx) => {
        const indices = index.get(key);
        if (!indices || indices.length === 0)
            return undefined;
        // Binary search: find largest index < beforeIdx
        let lo = 0;
        let hi = indices.length - 1;
        let result = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (indices[mid] < beforeIdx) {
                result = indices[mid];
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }
        return result >= 0 ? commitLog[result] : undefined;
    };
}
/**
 * Staged optimization: pick the right writer-lookup strategy based on data size.
 *
 * Like a database query optimizer choosing between sequential scan and index scan:
 *
 * - **Small log (≤ 256):** Linear scan wins. Zero setup cost, good cache locality.
 *   The overhead of building a reverse index isn't worth it for short logs.
 *
 * - **Large log (> 256):** Reverse index wins. O(N×U) upfront build cost is amortized
 *   across all BFS hops. Each lookup becomes O(log N) via binary search instead of O(N).
 *   For an agent loop with 500 iterations and 5 keys per hop, this is 500×5×log(500)≈22K ops
 *   vs 500×5×500=1.25M ops with linear scan.
 *
 * The caller never sees this — `causalChain()` picks automatically.
 */
function createWriterLookup(commitLog) {
    if (commitLog.length <= REVERSE_INDEX_THRESHOLD) {
        return linearScanLookup(commitLog);
    }
    return reverseIndexLookup(commitLog);
}
// ── Core algorithm ─────────────────────────────────────────────────────
/**
 * RFC-003 D2: the `incompleteSources` node fragment for a commit — `{}`
 * when the stage consumed no untracked read paths, keeping the field
 * ABSENT (not empty-array-valued) for fully-tracked stages.
 */
function incompleteSourcesFragment(commit) {
    if (!commit.untrackedSources || commit.untrackedSources.length === 0)
        return {};
    return { incompleteSources: commit.untrackedSources };
}
/**
 * Build the causal DAG rooted at `startId` by walking backwards
 * through read→write dependencies in the commit log.
 *
 * Automatically selects the optimal writer lookup strategy:
 * - Linear scan for small logs (≤ 256 commits)
 * - Reverse index with binary search for large logs (> 256 commits)
 *
 * Produces a DAG (not a tree): if two children both read from the same
 * parent, the parent node is shared (deduped by runtimeStageId).
 *
 * @param commitLog   Ordered commit bundles from executor.getSnapshot().commitLog
 * @param startId     runtimeStageId to start backtracking from
 * @param getKeysRead Callback returning keys read by a given execution step
 * @param options     Depth and node limits
 * @returns Root CausalNode with .parents forming the DAG, or undefined if startId not found
 */
export function causalChain(commitLog, startId, getKeysRead, options) {
    const maxDepth = options?.maxDepth ?? 20;
    const maxNodes = options?.maxNodes ?? 100;
    const controlDeps = options?.controlDeps;
    const weigh = options?.weigh;
    const perWrite = options?.edgeAttribution === 'per-write';
    // RFC-003 D4 — truncation visibility. Set only when a limit actually
    // cuts the slice; surfaced on the root as `truncated` so a consumer can
    // never mistake a truncated slice for a complete one.
    let truncatedByDepth = false;
    let truncatedByNodes = false;
    // Build position index: runtimeStageId → array position (O(n) once)
    const idxMap = new Map();
    for (let i = 0; i < commitLog.length; i++) {
        idxMap.set(commitLog[i].runtimeStageId, i);
    }
    const startIdx = idxMap.get(startId);
    if (startIdx === undefined)
        return undefined;
    const startCommit = commitLog[startIdx];
    // Pick writer lookup strategy based on log size
    const findWriter = createWriterLookup(commitLog);
    // Node dedup map: runtimeStageId → CausalNode (ensures DAG, not tree)
    const nodeMap = new Map();
    const root = {
        runtimeStageId: startId,
        stageId: startCommit.stageId,
        stageName: startCommit.stage,
        keysWritten: startCommit.trace.map((t) => t.path),
        linkedBy: '',
        depth: 0,
        parents: [],
        parentEdges: [],
        ...incompleteSourcesFragment(startCommit),
    };
    nodeMap.set(startId, root);
    // ── #P1 per-write attribution machinery (inert under 'stage') ──────────
    // expandedReads: per node, the reads already queued for expansion — late
    // links via additional keys re-enqueue only the DELTA, so the slice grows
    // monotonically toward the stage-level ceiling and terminates (each key
    // expands at most once per node). fullyExpanded: nodes that fell back to
    // stage level (no readKeys on a linking entry) — nothing left to add.
    const expandedReads = new Map();
    const fullyExpanded = new Set();
    /**
     * Resolve a node's expansion read-set for the given linking WRITTEN keys.
     * Per-write mode with provenance present → union of the linking writes'
     * temporal-prefix `readKeys`. Any linking entry WITHOUT `readKeys` (or no
     * linkKeys at all) → honest stage-level fallback, flagged via the second
     * tuple member so the caller marks the node fully expanded.
     */
    function readsForLinks(commit, linkKeys) {
        if (!perWrite || !linkKeys || linkKeys.length === 0) {
            return [getKeysRead(commit.runtimeStageId), true];
        }
        const union = new Set();
        for (const linkKey of linkKeys) {
            const entry = commit.trace.find((t) => t.path === linkKey);
            if (!entry || entry.readKeys === undefined) {
                // Mixed/dial-off log — degrade THIS node to stage level, honestly.
                return [getKeysRead(commit.runtimeStageId), true];
            }
            for (const rk of entry.readKeys)
                union.add(rk);
        }
        return [[...union], false];
    }
    // BFS/worklist queue: [node, commitIdx, depth, keysToExpand]
    const [rootReads, rootIsFull] = perWrite
        ? readsForLinks(startCommit, options?.rootLinkKeys)
        : [getKeysRead(startId), true];
    expandedReads.set(startId, new Set(rootReads));
    if (rootIsFull)
        fullyExpanded.add(startId);
    const queue = [[root, startIdx, 0, rootReads]];
    let visited = 1;
    /**
     * Link `node → parent` (creating + enqueueing the parent when new).
     * Shared by data-edge expansion (read→write) and control-edge expansion
     * (D3). One CausalEdge per distinct (parent, kind, key) link; `parents`
     * keeps its historical one-entry-per-parent dedup.
     */
    function linkParent(node, parentCommit, kind, key, depth) {
        const parentId = parentCommit.runtimeStageId;
        // #P1: the parent's expansion reads, resolved LAZILY (only for new nodes
        // or per-write re-expansion — duplicate links under 'stage' pay nothing).
        // Data links expand through the reads that fed the parent's write of
        // `key`; control links expand the decider at stage level (a decision
        // depends on everything it read).
        const resolveLinkReads = () => kind === 'data'
            ? readsForLinks(parentCommit, key !== undefined ? [key] : undefined)
            : [getKeysRead(parentId), true];
        let parentNode = nodeMap.get(parentId);
        if (!parentNode) {
            // New node — create and enqueue (respecting the node budget)
            if (visited >= maxNodes) {
                truncatedByNodes = true; // D4: a discovered parent was dropped
                return;
            }
            const parentIdx = idxMap.get(parentId);
            if (parentIdx === undefined)
                return;
            parentNode = {
                runtimeStageId: parentId,
                stageId: parentCommit.stageId,
                stageName: parentCommit.stage,
                keysWritten: parentCommit.trace.map((t) => t.path),
                // linkedBy stays a DATA-key concept (back-compat) — control-linked
                // nodes carry their label on the edge instead.
                linkedBy: kind === 'data' ? key ?? '' : '',
                depth: depth + 1,
                parents: [],
                parentEdges: [],
                ...incompleteSourcesFragment(parentCommit),
            };
            nodeMap.set(parentId, parentNode);
            visited++;
            const [linkReads, linkIsFull] = resolveLinkReads();
            expandedReads.set(parentId, new Set(linkReads));
            if (linkIsFull)
                fullyExpanded.add(parentId);
            queue.push([parentNode, parentIdx, depth + 1, linkReads]);
        }
        else if (perWrite && !fullyExpanded.has(parentId)) {
            // #P1 worklist: an EXISTING node linked via another key may owe more
            // expansion — enqueue only the reads not yet expanded (monotone; the
            // node budget is untouched, no node is created). Re-expansion keeps
            // the node's ORIGINAL depth so its parents get a consistent depth+1.
            const [linkReads, linkIsFull] = resolveLinkReads();
            const expanded = expandedReads.get(parentId);
            const delta = linkReads.filter((k) => !expanded.has(k));
            if (linkIsFull)
                fullyExpanded.add(parentId);
            if (delta.length > 0) {
                for (const k of delta)
                    expanded.add(k);
                const parentIdx = idxMap.get(parentId);
                if (parentIdx !== undefined)
                    queue.push([parentNode, parentIdx, parentNode.depth, delta]);
            }
        }
        // DAG merge: one parents[] entry per distinct parent (historical shape)
        if (!node.parents.some((p) => p.runtimeStageId === parentId)) {
            node.parents.push(parentNode);
        }
        // One edge per distinct (parent, kind, key) link. The weigher (D4)
        // stamps the weight at creation; `undefined` → 1.0 — the engine never
        // computes weights itself.
        if (!node.parentEdges.some((e) => e.parent.runtimeStageId === parentId && e.kind === kind && e.key === key)) {
            // Error isolation (review finding): a consumer weigher that throws
            // must degrade to the default weight, never crash the slice — the
            // same contract every other consumer callback in the library gets.
            let weight = 1.0;
            if (weigh) {
                try {
                    weight = weigh(node, parentNode, key, kind) ?? 1.0;
                }
                catch {
                    /* weigher threw — keep 1.0, the slice stays usable */
                }
            }
            node.parentEdges.push({ parent: parentNode, kind, key, weight });
        }
    }
    while (queue.length > 0) {
        const [node, commitIdx, depth, keysToExpand] = queue.shift();
        if (depth >= maxDepth) {
            // D4: only a node that still HAD something to expand counts as a cut
            // (a leaf at the horizon truncates nothing).
            if (keysToExpand.length > 0 || controlDeps?.(node.runtimeStageId) !== undefined) {
                truncatedByDepth = true;
            }
            continue;
        }
        // Data edges: for each key in this expansion's read-set, find who wrote
        // it. Under 'stage' this is the node's full read-set (historical
        // behavior); under 'per-write' it is the linking writes' temporal prefix
        // (or a worklist delta on re-expansion).
        const keysRead = keysToExpand;
        for (const key of keysRead) {
            const writer = findWriter(key, commitIdx);
            if (!writer)
                continue;
            linkParent(node, writer, 'data', key, depth);
        }
        // Control edge (RFC-003 D3): link the governing decider, labeled by the
        // decide() rule label when present. The decider node then expands
        // normally through its own data reads (and its own control parent).
        if (controlDeps) {
            const dep = controlDeps(node.runtimeStageId);
            if (dep) {
                const deciderIdx = idxMap.get(dep.deciderId);
                if (deciderIdx !== undefined) {
                    linkParent(node, commitLog[deciderIdx], 'control', dep.label, depth);
                }
            }
        }
    }
    // RFC-003 D4 — truncation visibility on the root (absent when complete).
    if (truncatedByDepth || truncatedByNodes) {
        root.truncated = { byDepth: truncatedByDepth, byNodes: truncatedByNodes };
        if (isDevMode()) {
            // eslint-disable-next-line no-console
            console.warn(`[footprint] causalChain('${startId}') truncated by ` +
                `${[truncatedByDepth && `maxDepth (${maxDepth})`, truncatedByNodes && `maxNodes (${maxNodes})`]
                    .filter(Boolean)
                    .join(' + ')} — the slice is incomplete. Raise the limits or narrow keysRead.`);
        }
    }
    return root;
}
// ── Utilities ──────────────────────────────────────────────────────────
/**
 * Flatten the causal DAG into a BFS-ordered list of nodes.
 * Each node appears exactly once (first occurrence by BFS order).
 * Useful for linear display or iteration.
 */
export function flattenCausalDAG(root) {
    const result = [];
    const visited = new Set();
    const queue = [root];
    while (queue.length > 0) {
        const node = queue.shift();
        if (visited.has(node.runtimeStageId))
            continue;
        visited.add(node.runtimeStageId);
        result.push(node);
        for (const parent of node.parents) {
            if (!visited.has(parent.runtimeStageId)) {
                queue.push(parent);
            }
        }
    }
    return result;
}
/**
 * Format a causal DAG as human-readable indented text.
 * Shows the dependency chain with depth indentation and linked-by keys.
 *
 * RFC-003 D2: nodes that consumed untracked read paths render an extra
 * `⚠ also consumed … — slice may be incomplete here` line, so a consumer
 * (human or LLM) debugging from the slice is TOLD when it is incomplete.
 *
 * RFC-003 D3: control edges render as `← [control: <rule label>]`
 * (label omitted when the decision carried none). Data rendering is
 * byte-identical to the pre-D3 output — `← via <key>` from the node's
 * discovery-time `linkedBy`.
 *
 * RFC-003 D4: edge weights from the `weigh` hook render as a suffix —
 * `← via systemPrompt (0.18)` — only when ≠ 1.0, so unweighted output is
 * unchanged. A truncated slice (root.truncated) appends a final
 * `⚠ slice truncated …` line.
 */
export function formatCausalChain(root) {
    const lines = [];
    const visited = new Set();
    const weightSuffix = (edge) => edge !== undefined && edge.weight !== 1 ? ` (${edge.weight})` : '';
    function walk(node, indent, edgesFromChild) {
        if (visited.has(node.runtimeStageId)) {
            lines.push(`${'  '.repeat(indent)}↳ ${node.runtimeStageId} (see above)`);
            return;
        }
        visited.add(node.runtimeStageId);
        const linkParts = [];
        if (node.linkedBy) {
            const dataEdge = edgesFromChild?.find((e) => e.kind === 'data');
            linkParts.push(`via ${node.linkedBy}${weightSuffix(dataEdge)}`);
        }
        const controlEdge = edgesFromChild?.find((e) => e.kind === 'control');
        if (controlEdge) {
            linkParts.push(`[control${controlEdge.key ? `: ${controlEdge.key}` : ''}]${weightSuffix(controlEdge)}`);
        }
        const link = linkParts.length > 0 ? ` ← ${linkParts.join(' ← ')}` : '';
        const writes = node.keysWritten.length > 0 ? ` [wrote: ${node.keysWritten.join(', ')}]` : '';
        lines.push(`${'  '.repeat(indent)}${node.stageName} (${node.runtimeStageId})${link}${writes}`);
        if (node.incompleteSources && node.incompleteSources.length > 0) {
            lines.push(`${'  '.repeat(indent + 1)}⚠ also consumed ${node.incompleteSources.join('/')} — slice may be incomplete here`);
        }
        for (const parent of node.parents) {
            walk(parent, indent + 1, node.parentEdges.filter((e) => e.parent === parent));
        }
    }
    walk(root, 0);
    if (root.truncated) {
        const causes = [root.truncated.byDepth && 'maxDepth reached', root.truncated.byNodes && 'maxNodes reached']
            .filter(Boolean)
            .join(', ');
        lines.push(`⚠ slice truncated (${causes}) — older causes exist beyond this horizon`);
    }
    return lines.join('\n');
}
// ── Exported for testing (internal) ────────────────────────────────────
/** @internal Exposed for testing the strategy selection. */
export const _REVERSE_INDEX_THRESHOLD = REVERSE_INDEX_THRESHOLD;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja3RyYWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9tZW1vcnkvYmFja3RyYWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FzREc7QUFFSCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sNEJBQTRCLENBQUM7QUFDdkQsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBcUtyRCwwRUFBMEU7QUFFMUU7Ozs7R0FJRztBQUNILE1BQU0sdUJBQXVCLEdBQUcsR0FBRyxDQUFDO0FBUXBDLGtFQUFrRTtBQUNsRSxTQUFTLGdCQUFnQixDQUFDLFNBQXlCO0lBQ2pELE9BQU8sQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFLEVBQUUsQ0FBQyxjQUFjLENBQUMsU0FBUyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUMsQ0FBQztBQUN2RSxDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxTQUFTLGtCQUFrQixDQUFDLFNBQXlCO0lBQ25ELGtFQUFrRTtJQUNsRSxNQUFNLEtBQUssR0FBRyxJQUFJLEdBQUcsRUFBb0IsQ0FBQztJQUMxQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsU0FBUyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQzFDLEtBQUssTUFBTSxDQUFDLElBQUksU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ25DLElBQUksR0FBRyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzVCLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztnQkFDVCxHQUFHLEdBQUcsRUFBRSxDQUFDO2dCQUNULEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxH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QUFDLENBQ3BELENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQztJQUVELElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFFZCxJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztRQUNuQixNQUFNLE1BQU0sR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxJQUFJLGtCQUFrQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxJQUFJLGtCQUFrQixDQUFDO2FBQ3hHLE1BQU0sQ0FBQyxPQUFPLENBQUM7YUFDZixJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDZCxLQUFLLENBQUMsSUFBSSxDQUFDLHNCQUFzQixNQUFNLDRDQUE0QyxDQUFDLENBQUM7SUFDdkYsQ0FBQztJQUVELE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMxQixDQUFDO0FBRUQsMEVBQTBFO0FBRTFFLDREQUE0RDtBQUM1RCxNQUFNLENBQUMsTUFBTSx3QkFBd0IsR0FBRyx1QkFBdUIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogYmFja3RyYWNrLnRzIOKAlCBCYWNrd2FyZCBjYXVzYWwgY2hhaW4gYW5hbHlzaXMgb24gdGhlIGNvbW1pdCBsb2cuXG4gKlxuICogSW1wbGVtZW50cyAqKmJhY2t3YXJkIHByb2dyYW0gc2xpY2luZyoqIChXZWlzZXIgMTk4NCwgdGhpbi1zbGljZSB2YXJpYW50KTpcbiAqIGdpdmVuIGEgc3RhcnRpbmcgZXhlY3V0aW9uIHN0ZXAsIHdhbGsgYmFja3dhcmRzIHRocm91Z2ggcmVhZOKGkndyaXRlXG4gKiBkZXBlbmRlbmNpZXMgdG8gYnVpbGQgdGhlIGNhdXNhbCBEQUcgdGhhdCBwcm9kdWNlZCB0aGUgZGF0YSBhdCB0aGF0IHN0ZXAuXG4gKlxuICogIyMgQWxnb3JpdGhtXG4gKlxuICogQkZTIG9uIHRoZSBpbXBsaWNpdCBkZXBlbmRlbmN5IGdyYXBoIHdoZXJlIGVkZ2VzIHJ1biBmcm9tIHJlYWRlciDihpIgd3JpdGVyLlxuICpcbiAqIDEuIExvY2F0ZSBzdGFydElkIGluIGNvbW1pdExvZyDihpIgcm9vdCBub2RlXG4gKiAyLiBHZXQga2V5c1JlYWQgZm9yIHJvb3QgdmlhIGBnZXRLZXlzUmVhZGAgY2FsbGJhY2tcbiAqIDMuIEZvciBlYWNoIGtleSByZWFkLCBmaW5kIHdobyBsYXN0IHdyb3RlIGl0IGJlZm9yZSB0aGlzIHN0ZXAg4oaSIHBhcmVudCBjb21taXRcbiAqIDQuIENyZWF0ZSBwYXJlbnQgQ2F1c2FsTm9kZSwgbGluayB0byByb290LnBhcmVudHNcbiAqIDUuIEVucXVldWUgcGFyZW50LiBSZXBlYXQgdW50aWwgcXVldWUgZW1wdHkgb3IgbGltaXRzIGhpdC5cbiAqXG4gKiBPdXRwdXQgaXMgYSAqKkRBRyoqIChub3QgYSBsaW5rZWQgbGlzdCk6IGEgc3RhZ2UgcmVhZGluZyBgY3JlZGl0U2NvcmVgIEFORCBgZHRpYFxuICogZnJvbSBkaWZmZXJlbnQgd3JpdGVycyBoYXMgdHdvIHBhcmVudHMuXG4gKlxuICogIyMgU3RhZ2VkIE9wdGltaXphdGlvblxuICpcbiAqIFR3byB3cml0ZXItbG9va3VwIHN0cmF0ZWdpZXMsIGNob3NlbiBhdXRvbWF0aWNhbGx5IGJ5IGNvbW1pdCBsb2cgc2l6ZTpcbiAqXG4gKiB8IFN0cmF0ZWd5IHwgV2hlbiB8IENvbXBsZXhpdHkgcGVyIGxvb2t1cCB8XG4gKiB8LS0tLS0tLS0tLXwtLS0tLS18LS0tLS0tLS0tLS0tLS0tLS0tLS0tLXxcbiAqIHwgTGluZWFyIHNjYW4gfCBOIOKJpCAyNTYgfCBPKE4pIOKAlCBzaW1wbGUgYmFja3dhcmQgc2NhbiB8XG4gKiB8IFJldmVyc2UgaW5kZXggfCBOID4gMjU2IHwgTyhLIGxvZyBOKSDigJQgcHJlYnVpbHQga2V54oaSW2luZGljZXNdLCBiaW5hcnkgc2VhcmNoIHxcbiAqXG4gKiBUaGUgdGhyZXNob2xkICgyNTYpIGlzIGNob3NlbiBzbyB0aGUgTyhOKSBidWlsZCBjb3N0IG9mIHRoZSByZXZlcnNlIGluZGV4XG4gKiBpcyBhbW9ydGl6ZWQgb3ZlciB0aGUgQkZTIHRyYXZlcnNhbC4gQmVsb3cgMjU2LCBsaW5lYXIgc2NhbiB3aW5zIGJlY2F1c2VcbiAqIHRoZXJlJ3Mgbm8gaW5kZXggYnVpbGQgb3ZlcmhlYWQuIFRoZSBjb25zdW1lciBuZXZlciBzZWVzIHRoaXMg4oCUIGBjYXVzYWxDaGFpbigpYFxuICogcGlja3MgdGhlIHJpZ2h0IHN0cmF0ZWd5IGludGVybmFsbHkgKGxpa2UgYSBxdWVyeSBvcHRpbWl6ZXIgY2hvb3NpbmcgYmV0d2VlblxuICogc2VxdWVudGlhbCBzY2FuIHZzIGluZGV4IHNjYW4gYmFzZWQgb24gdGFibGUgc2l6ZSkuXG4gKlxuICogIyMgQ29tcGxleGl0eVxuICpcbiAqIC0gKipTbWFsbCBsb2dzIChOIOKJpCAyNTYpOioqIE8oViDDlyBLIMOXIE4pIHRvdGFsLiBWPXZpc2l0ZWQsIEs9YXZnIGtleXMvbm9kZS5cbiAqIC0gKipMYXJnZSBsb2dzIChOID4gMjU2KToqKiBPKE4gw5cgVSkgaW5kZXggYnVpbGQgKyBPKFYgw5cgSyDDlyBsb2cgTikgbG9va3Vwcy5cbiAqICAgVSA9IHVuaXF1ZSBrZXlzLiBBbW9ydGl6ZWQgb3ZlciBhbGwgQkZTIGhvcHMuXG4gKlxuICogIyMgUmVmZXJlbmNlc1xuICpcbiAqIC0gV2Vpc2VyLCBNLiAoMTk4NCkuIFwiUHJvZ3JhbSBTbGljaW5nLlwiIElFRUUgVFNFLlxuICogLSBTcmlkaGFyYW4sIE0uIGV0IGFsLiAoMjAwNykuIFwiVGhpbiBTbGljaW5nLlwiIFBMREkuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGltcG9ydCB7IGNhdXNhbENoYWluLCBmbGF0dGVuQ2F1c2FsREFHLCBmb3JtYXRDYXVzYWxDaGFpbiB9IGZyb20gJ2Zvb3RwcmludGpzL3RyYWNlJztcbiAqXG4gKiBjb25zdCBkYWcgPSBjYXVzYWxDaGFpbihjb21taXRMb2csICdkZWNpZGUjMicsIChpZCkgPT4gcmVjb3JkZXIuZ2V0S2V5c1JlYWQoaWQpKTtcbiAqIGNvbnN0IGZsYXQgPSBmbGF0dGVuQ2F1c2FsREFHKGRhZyk7ICAgICAvLyBCRlMtb3JkZXJlZCBmbGF0IGxpc3RcbiAqIGNvbnNvbGUubG9nKGZvcm1hdENhdXNhbENoYWluKGRhZykpOyAgICAgLy8gaHVtYW4tcmVhZGFibGVcbiAqIGBgYFxuICovXG5cbmltcG9ydCB7IGlzRGV2TW9kZSB9IGZyb20gJy4uL3Njb3BlL2RldGVjdENpcmN1bGFyLmpzJztcbmltcG9ydCB7IGZpbmRMYXN0V3JpdGVyIH0gZnJvbSAnLi9jb21taXRMb2dVdGlscy5qcyc7XG5pbXBvcnQgdHlwZSB7IENvbW1pdEJ1bmRsZSwgVW50cmFja2VkU291cmNlIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIOKUgOKUgCBUeXBlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqIEEgc2luZ2xlIG5vZGUgaW4gdGhlIGNhdXNhbCBEQUcuICovXG5leHBvcnQgaW50ZXJmYWNlIENhdXNhbE5vZGUge1xuICAvKiogVW5pcXVlIGV4ZWN1dGlvbiBzdGVwIGlkZW50aWZpZXIuICovXG4gIHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmc7XG4gIC8qKiBTdGFibGUgc3RhZ2UgaWRlbnRpZmllci4gKi9cbiAgc3RhZ2VJZDogc3RyaW5nO1xuICAvKiogSHVtYW4tcmVhZGFibGUgc3RhZ2UgbmFtZS4gKi9cbiAgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIC8qKiBLZXlzIHRoaXMgc3RhZ2Ugd3JvdGUgKGZyb20gaXRzIENvbW1pdEJ1bmRsZS50cmFjZSkuICovXG4gIGtleXNXcml0dGVuOiBzdHJpbmdbXTtcbiAgLyoqIFRoZSBrZXkgd2hvc2UgcmVhZOKGkndyaXRlIGRlcGVuZGVuY3kgbGlua2VkIHRoaXMgbm9kZSB0byBpdHMgY2hpbGQuIEVtcHR5IGZvciB0aGUgcm9vdC4gKi9cbiAgbGlua2VkQnk6IHN0cmluZztcbiAgLyoqIEJGUyBkZXB0aCBmcm9tIHRoZSBzdGFydGluZyBub2RlICgwID0gc3RhcnQpLiAqL1xuICBkZXB0aDogbnVtYmVyO1xuICAvKipcbiAgICogUGFyZW50IG5vZGVzIOKAlCBzdGFnZXMgdGhpcyBub2RlIGRlcGVuZHMgb24uIERBRzogbXVsdGlwbGUgcGFyZW50c1xuICAgKiBwb3NzaWJsZS4gS0VQVCBmb3IgY29tcGF0aWJpbGl0eTsgd2l0aCB0aGUgYGNvbnRyb2xEZXBzYCBvcHRpb25cbiAgICogKFJGQy0wMDMgRDMpIGdvdmVybmluZyBkZWNpZGVycyBhcHBlYXIgaGVyZSB0b28uIEZvciB0eXBlZC9rZXllZC9cbiAgICogd2VpZ2h0ZWQgZGV0YWlsIHVzZSB7QGxpbmsgcGFyZW50RWRnZXN9LlxuICAgKi9cbiAgcGFyZW50czogQ2F1c2FsTm9kZVtdO1xuICAvKipcbiAgICogUkZDLTAwMyBEMyDigJQgb25lIGVkZ2UgcGVyIGRlcGVuZGVuY3kgTElOSyAobm90IHBlciBwYXJlbnQpOiBhIG5vZGVcbiAgICogcmVhZGluZyB0d28ga2V5cyBmcm9tIHRoZSBzYW1lIHdyaXRlciBoYXMgT05FIGVudHJ5IGluIHtAbGluayBwYXJlbnRzfVxuICAgKiBidXQgVFdPIGAnZGF0YSdgIGVkZ2VzIGhlcmUuIENvbnRyb2wgZGVwZW5kZW5jaWVzICh2aWEgdGhlXG4gICAqIGBjb250cm9sRGVwc2Agb3B0aW9uKSBhZGQgYSBgJ2NvbnRyb2wnYCBlZGdlIHRvIHRoZSBnb3Zlcm5pbmcgZGVjaWRlci5cbiAgICovXG4gIHBhcmVudEVkZ2VzOiBDYXVzYWxFZGdlW107XG4gIC8qKlxuICAgKiBSRkMtMDAzIEQyIGhvbmVzdHkgbWFya2VyIOKAlCBzdGFtcGVkIGZyb20gdGhlIHN0YWdlJ3NcbiAgICogYENvbW1pdEJ1bmRsZS51bnRyYWNrZWRTb3VyY2VzYC4gUHJlc2VudCB3aGVuIHRoaXMgc3RhZ2UgQUxTTyBjb25zdW1lZFxuICAgKiB1bnRyYWNrZWQgcmVhZCBwYXRocyAoYGFyZ3NgIC8gYGVudmAgLyB1bnNoYWRvd2VkIGBzaWxlbnRgIHJlYWRzKTogdGhlXG4gICAqIGJhY2t3YXJkIHNsaWNlIHRocm91Z2ggdGhpcyBub2RlIG1heSBiZSBpbmNvbXBsZXRlLCBiZWNhdXNlIHRob3NlIHJlYWRzXG4gICAqIHByb2R1Y2Ugbm8gcmVhZOKGkndyaXRlIGVkZ2UgdG8gZm9sbG93LiBgZm9ybWF0Q2F1c2FsQ2hhaW5gIHJlbmRlcnMgdGhpc1xuICAgKiBhcyBhIGDimqAg4oCmIHNsaWNlIG1heSBiZSBpbmNvbXBsZXRlIGhlcmVgIGxpbmUuIEFic2VudCB3aGVuIHRoZSBzdGFnZSdzXG4gICAqIHJlYWRzIHdlcmUgZnVsbHkgdHJhY2tlZC5cbiAgICovXG4gIGluY29tcGxldGVTb3VyY2VzPzogUmVhZG9ubHlBcnJheTxVbnRyYWNrZWRTb3VyY2U+O1xuICAvKipcbiAgICogUkZDLTAwMyBENCB0cnVuY2F0aW9uIHZpc2liaWxpdHkg4oCUIHNldCBvbiB0aGUgUk9PVCBub2RlIG9ubHksIGFuZCBvbmx5XG4gICAqIHdoZW4gYSBsaW1pdCBhY3R1YWxseSBjdXQgdGhlIHNsaWNlOiBgYnlEZXB0aGAgd2hlbiBhIG5vZGUgYXQgdGhlXG4gICAqIGBtYXhEZXB0aGAgaG9yaXpvbiBzdGlsbCBoYWQgZWRnZXMgdG8gZXhwYW5kLCBgYnlOb2Rlc2Agd2hlbiB0aGVcbiAgICogYG1heE5vZGVzYCBidWRnZXQgYmxvY2tlZCBjcmVhdGluZyBhIGRpc2NvdmVyZWQgcGFyZW50LiBBYnNlbnQgd2hlbiB0aGVcbiAgICogc2xpY2UgaXMgY29tcGxldGUuIERldiBtb2RlIChgZW5hYmxlRGV2TW9kZSgpYCkgYWxzbyB3YXJucyBvblxuICAgKiB0cnVuY2F0aW9uLCBhbmQgYGZvcm1hdENhdXNhbENoYWluYCBhcHBlbmRzIGEgYOKaoCBzbGljZSB0cnVuY2F0ZWQg4oCmYFxuICAgKiBsaW5lIOKAlCBhIGNvbnN1bWVyIG11c3QgbmV2ZXIgbWlzdGFrZSBhIHRydW5jYXRlZCBzbGljZSBmb3IgYSBmdWxsIG9uZS5cbiAgICovXG4gIHRydW5jYXRlZD86IHsgYnlEZXB0aDogYm9vbGVhbjsgYnlOb2RlczogYm9vbGVhbiB9O1xufVxuXG4vKipcbiAqIFJGQy0wMDMgRDMg4oCUIGEgdHlwZWQgZGVwZW5kZW5jeSBlZGdlIGZyb20gYSBjaGlsZCBub2RlIHRvIG9uZSBwYXJlbnQuXG4gKlxuICogLSBga2luZDogJ2RhdGEnYCAgICDigJQgcmVhZOKGkndyaXRlIGRlcGVuZGVuY3k7IGBrZXlgIGlzIHRoZSBzdGF0ZSBrZXkuXG4gKiAtIGBraW5kOiAnY29udHJvbCdgIOKAlCB0aGUgcGFyZW50IGlzIHRoZSBkZWNpZGVyL3NlbGVjdG9yIHdob3NlIGRlY2lzaW9uXG4gKiAgIGFsbG93ZWQgdGhlIGNoaWxkIHRvIHJ1bjsgYGtleWAgaXMgdGhlIGRlY2lkZSgpIHJ1bGUgbGFiZWwgd2hlbiBwcmVzZW50LlxuICpcbiAqIGB3ZWlnaHRgIGRlZmF1bHRzIHRvIDEuMDsgdGhlIGB3ZWlnaGAgaG9vayAoUkZDLTAwMyBENCkgY2FuIG92ZXJyaWRlIGl0LlxuICogVGhlIGVuZ2luZSBpdHNlbGYgTkVWRVIgY29tcHV0ZXMgd2VpZ2h0cyDigJQgc2VtYW50aWNzIGJlbG9uZyB0byB0aGVcbiAqIGNvbnN1bWVyLWluamVjdGVkIHdlaWdoZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2F1c2FsRWRnZSB7XG4gIHBhcmVudDogQ2F1c2FsTm9kZTtcbiAga2luZDogJ2RhdGEnIHwgJ2NvbnRyb2wnO1xuICBrZXk/OiBzdHJpbmc7XG4gIHdlaWdodDogbnVtYmVyO1xufVxuXG4vKipcbiAqIFJGQy0wMDMgRDMg4oCUIGEgY29udHJvbCBkZXBlbmRlbmN5IHJlc29sdmVkIGZvciBvbmUgZXhlY3V0aW9uIHN0ZXA6XG4gKiB3aGljaCBkZWNpZGVyL3NlbGVjdG9yIGV4ZWN1dGlvbiBhbGxvd2VkIHRoaXMgc3RhZ2UgdG8gcnVuLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIENvbnRyb2xEZXBlbmRlbmN5IHtcbiAgLyoqIHJ1bnRpbWVTdGFnZUlkIG9mIHRoZSBnb3Zlcm5pbmcgZGVjaWRlci9zZWxlY3RvciBleGVjdXRpb24gc3RlcC4gKi9cbiAgZGVjaWRlcklkOiBzdHJpbmc7XG4gIC8qKiBUaGUgZGVjaWRlKCkgcnVsZSBsYWJlbCBmb3IgdGhlIGNob3NlbiBicmFuY2gsIHdoZW4gcHJlc2VudC4gKi9cbiAgbGFiZWw/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUkZDLTAwMyBEMyDigJQgY2FsbGJhY2sgcmVzb2x2aW5nIHRoZSBnb3Zlcm5pbmcgZGVjaWRlciBmb3IgYW4gZXhlY3V0aW9uXG4gKiBzdGVwLiBSZXR1cm4gYHVuZGVmaW5lZGAgd2hlbiB0aGUgc3RlcCBpcyBub3QgY29udHJvbC1kZXBlbmRlbnQgb24gYW55XG4gKiByZWNvcmRlZCBkZWNpc2lvbi4gQnVpbGQgb25lIHdpdGggYGNvbnRyb2xEZXBSZWNvcmRlcigpYCBmcm9tXG4gKiBgZm9vdHByaW50anMvdHJhY2VgLCBvciBzdXBwbHkgeW91ciBvd24uXG4gKi9cbmV4cG9ydCB0eXBlIENvbnRyb2xEZXBMb29rdXAgPSAocnVudGltZVN0YWdlSWQ6IHN0cmluZykgPT4gQ29udHJvbERlcGVuZGVuY3kgfCB1bmRlZmluZWQ7XG5cbi8qKlxuICogUkZDLTAwMyBENCDigJQgY29uc3VtZXItaW5qZWN0ZWQgZWRnZSB3ZWlnaGVyLiBDYWxsZWQgb25jZSBwZXIgY3JlYXRlZFxuICogZWRnZTsgcmV0dXJuIGEgd2VpZ2h0LCBvciBgdW5kZWZpbmVkYCB0byBrZWVwIHRoZSBkZWZhdWx0IDEuMC4gVGhlXG4gKiBFTkdJTkUgbmV2ZXIgY29tcHV0ZXMgd2VpZ2h0cyAoemVybyBuZXcgZGVwZW5kZW5jaWVzIOKAlCBzZW1hbnRpY3MgbGlrZVxuICogZW1iZWRkaW5nIHNpbWlsYXJpdHkgb3IgRkRMIGluZmx1ZW5jZSBiZWxvbmcgdG8gZG93bnN0cmVhbSBsaWJyYXJpZXMsXG4gKiB0aGUgc2FtZSBwbHVnLWluIHBhdHRlcm4gYXMgYE5hcnJhdGl2ZUZvcm1hdHRlcmApLiBXZWlnaHRzIHJlbmRlciBpblxuICogYGZvcm1hdENhdXNhbENoYWluYCBhcyBg4oaQIHZpYSBzeXN0ZW1Qcm9tcHQgKDAuMTgpYC5cbiAqL1xuZXhwb3J0IHR5cGUgRWRnZVdlaWdoZXIgPSAoXG4gIGNoaWxkOiBDYXVzYWxOb2RlLFxuICBwYXJlbnQ6IENhdXNhbE5vZGUsXG4gIGtleTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBraW5kOiAnZGF0YScgfCAnY29udHJvbCcsXG4pID0+IG51bWJlciB8IHVuZGVmaW5lZDtcblxuLyoqIE9wdGlvbnMgZm9yIGNhdXNhbENoYWluKCkuICovXG5leHBvcnQgaW50ZXJmYWNlIENhdXNhbENoYWluT3B0aW9ucyB7XG4gIC8qKiBNYXhpbXVtIEJGUyBkZXB0aCAoZGVmYXVsdDogMjApLiBQcmV2ZW50cyBydW5hd2F5IHRyYXZlcnNhbC4gKi9cbiAgbWF4RGVwdGg/OiBudW1iZXI7XG4gIC8qKiBNYXhpbXVtIHRvdGFsIG5vZGVzIHRvIHZpc2l0IChkZWZhdWx0OiAxMDApLiBIYXJkIGNhcCBmb3Igc2FmZXR5LiAqL1xuICBtYXhOb2Rlcz86IG51bWJlcjtcbiAgLyoqXG4gICAqIFJGQy0wMDMgRDMg4oCUIGNvbnRyb2wtZGVwZW5kZW5jZSBsb29rdXAuIFdoZW4gcHJvdmlkZWQsIGV4cGFuZGluZyBhIG5vZGVcbiAgICogQUxTTyBsaW5rcyBhIGAnY29udHJvbCdgIGVkZ2UgdG8gaXRzIGdvdmVybmluZyBkZWNpZGVyIChsYWJlbGVkIGJ5IHRoZVxuICAgKiBkZWNpZGUoKSBydWxlIGxhYmVsIHdoZW4gcHJlc2VudCk7IHRoZSBkZWNpZGVyIG5vZGUgdGhlbiBleHBhbmRzXG4gICAqIG5vcm1hbGx5IHRocm91Z2ggaXRzIG93biBkYXRhIHJlYWRzLCBzbyBjaGFpbnMgbGlrZVxuICAgKiBgc3RhdHVzIOKGkCBbY29udHJvbF0gQ2xhc3NpZnlSaXNrIOKGkCBbZGF0YTogY3JlZGl0U2NvcmVdIFB1bGxCdXJlYXVgXG4gICAqIHJlc29sdmUgZW5kLXRvLWVuZC4gV2l0aG91dCB0aGlzIG9wdGlvbiBiZWhhdmlvciBpcyB1bmNoYW5nZWQuXG4gICAqL1xuICBjb250cm9sRGVwcz86IENvbnRyb2xEZXBMb29rdXA7XG4gIC8qKlxuICAgKiBSRkMtMDAzIEQ0IOKAlCBlZGdlIHdlaWdoZXIuIFN0YW1wcyBgQ2F1c2FsRWRnZS53ZWlnaHRgIGF0IGVkZ2UgY3JlYXRpb247XG4gICAqIGB1bmRlZmluZWRgIChvciBubyB3ZWlnaGVyKSDihpIgMS4wLiBTZWUge0BsaW5rIEVkZ2VXZWlnaGVyfS5cbiAgICovXG4gIHdlaWdoPzogRWRnZVdlaWdoZXI7XG4gIC8qKlxuICAgKiAjUDEg4oCUIGhvdyBhIG5vZGUncyBleHBhbnNpb24gcmVhZC1zZXQgaXMgZGVyaXZlZDpcbiAgICpcbiAgICogLSBgJ3N0YWdlJ2AgKGRlZmF1bHQsIGhpc3RvcmljYWwpIOKAlCBldmVyeSB2aXNpdGVkIG5vZGUgZXhwYW5kcyB0aHJvdWdoXG4gICAqICAgQUxMIG9mIGl0cyBzdGFnZSdzIHJlYWRzIChgZ2V0S2V5c1JlYWRgKS4gQSBzdGFnZSByZWFkaW5nIGBhLGJgIGFuZFxuICAgKiAgIHdyaXRpbmcgYHgseWAgbGlua3MgYm90aCByZWFkcyBhcyBjYXVzZXMgb2YgYm90aCB3cml0ZXMg4oCUIGEgc291bmQgYnV0XG4gICAqICAgY29hcnNlIG92ZXItYXBwcm94aW1hdGlvbi5cbiAgICogLSBgJ3Blci13cml0ZSdgIOKAlCB3aGVuIHRoZSBjb21taXQgbG9nIGNhcnJpZXMgcGVyLXdyaXRlIHJlYWQgcHJvdmVuYW5jZVxuICAgKiAgIChgVHJhY2VFbnRyeS5yZWFkS2V5c2AsIHJlY29yZGVkIHVuZGVyIHRoZSBleGVjdXRvcidzXG4gICAqICAgYHdyaXRlUHJvdmVuYW5jZTogJ3JlYWRzLXByZWZpeCdgIGRpYWwpLCBhIG5vZGUgcmVhY2hlZCB2aWEga2V5IGBrYFxuICAgKiAgIGV4cGFuZHMgdGhyb3VnaCBPTkxZIHRoZSByZWFkcyB0aGF0IHByZWNlZGVkIGl0cyB3cml0ZSBvZiBga2BcbiAgICogICAodGVtcG9yYWwgcHJlZml4KS4gTm9kZXMgbGlua2VkIGxhdGVyIHZpYSBhZGRpdGlvbmFsIGtleXMgYXJlXG4gICAqICAgaW5jcmVtZW50YWxseSByZS1leHBhbmRlZCB3aXRoIGp1c3QgdGhlIG5ldyByZWFkcyAod29ya2xpc3Qg4oCUIHRoZVxuICAgKiAgIHNsaWNlIG9ubHkgZXZlciBHUk9XUyB0b3dhcmQgdGhlIHN0YWdlLWxldmVsIGNlaWxpbmcpLiBIT05FU1RcbiAgICogICBGQUxMQkFDSzogYW55IGxpbmsgd2hvc2UgdHJhY2UgZW50cnkgbGFja3MgYHJlYWRLZXlzYCBleHBhbmRzIHRoYXRcbiAgICogICBub2RlIGF0IHN0YWdlIGxldmVsIOKAlCBtaXhlZCBvciBkaWFsLW9mZiBsb2dzIGRlZ3JhZGUgdG8gYCdzdGFnZSdgXG4gICAqICAgYmVoYXZpb3IgZXhhY3RseSwgbmV2ZXIgdG8gc2lsZW5jZS5cbiAgICovXG4gIGVkZ2VBdHRyaWJ1dGlvbj86ICdzdGFnZScgfCAncGVyLXdyaXRlJztcbiAgLyoqXG4gICAqICNQMSDigJQgdGhlIHdyaXR0ZW4ga2V5cyB0aGF0IGFuY2hvciB0aGUgUk9PVCdzIGV4cGFuc2lvbiB1bmRlclxuICAgKiBgJ3Blci13cml0ZSdgIChlLmcuIGBzbGljZUZvcktleWAgcGFzc2VzIHRoZSBzbGljZWQga2V5LCBzbyB0aGUgcm9vdFxuICAgKiBleHBhbmRzIHRocm91Z2ggdGhlIHJlYWRzIHRoYXQgZmVkIFRIQVQgd3JpdGUsIG5vdCB0aGUgd2hvbGUgc3RhZ2UpLlxuICAgKiBJZ25vcmVkIHVuZGVyIGAnc3RhZ2UnYC4gVW5zZXQg4oaSIHJvb3QgZXhwYW5kcyBhdCBzdGFnZSBsZXZlbC5cbiAgICovXG4gIHJvb3RMaW5rS2V5cz86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIENhbGxiYWNrIHRoYXQgcmV0dXJucyB0aGUga2V5cyBhIHN0YWdlIHJlYWQgZHVyaW5nIGV4ZWN1dGlvbi5cbiAqIFRoZSBiYWNrdHJhY2tlciBjYWxscyB0aGlzIGZvciBlYWNoIHZpc2l0ZWQgbm9kZSB0byBkZXRlcm1pbmVcbiAqIHdoaWNoIHJlYWTihpJ3cml0ZSBlZGdlcyB0byBmb2xsb3cuXG4gKlxuICogSW1wbGVtZW50b3JzOiBRdWFsaXR5UmVjb3JkZXIgdHJhY2tzIGtleXNSZWFkIHBlciBzdGVwLFxuICogb3IgYnVpbGQgYSBNYXA8cnVudGltZVN0YWdlSWQsIHN0cmluZ1tdPiBmcm9tIFNjb3BlUmVjb3JkZXIub25SZWFkIGV2ZW50cy5cbiAqL1xuZXhwb3J0IHR5cGUgS2V5c1JlYWRMb29rdXAgPSAocnVudGltZVN0YWdlSWQ6IHN0cmluZykgPT4gc3RyaW5nW107XG5cbi8vIOKUgOKUgCBTdGFnZWQgb3B0aW1pemF0aW9uOiB3cml0ZXIgbG9va3VwIHN0cmF0ZWdpZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICogVGhyZXNob2xkIGZvciBzd2l0Y2hpbmcgZnJvbSBsaW5lYXIgc2NhbiB0byByZXZlcnNlIGluZGV4LlxuICogQmVsb3cgdGhpcywgTyhOKSBzY2FuIGlzIGZhc3RlciAobm8gaW5kZXggYnVpbGQgY29zdCkuXG4gKiBBYm92ZSB0aGlzLCBPKGxvZyBOKSBiaW5hcnkgc2VhcmNoIHdpbnMuXG4gKi9cbmNvbnN0IFJFVkVSU0VfSU5ERVhfVEhSRVNIT0xEID0gMjU2O1xuXG4vKipcbiAqIFdyaXRlciBsb29rdXAgZnVuY3Rpb24gc2lnbmF0dXJlLlxuICogUmV0dXJucyB0aGUgQ29tbWl0QnVuZGxlIHRoYXQgbGFzdCB3cm90ZSBga2V5YCBiZWZvcmUgcG9zaXRpb24gYGJlZm9yZUlkeGAuXG4gKi9cbnR5cGUgV3JpdGVyTG9va3VwID0gKGtleTogc3RyaW5nLCBiZWZvcmVJZHg6IG51bWJlcikgPT4gQ29tbWl0QnVuZGxlIHwgdW5kZWZpbmVkO1xuXG4vKiogU3RyYXRlZ3kgMTogTGluZWFyIHNjYW4g4oCUIE8oTikgcGVyIGxvb2t1cCwgemVybyBzZXR1cCBjb3N0LiAqL1xuZnVuY3Rpb24gbGluZWFyU2Nhbkxvb2t1cChjb21taXRMb2c6IENvbW1pdEJ1bmRsZVtdKTogV3JpdGVyTG9va3VwIHtcbiAgcmV0dXJuIChrZXksIGJlZm9yZUlkeCkgPT4gZmluZExhc3RXcml0ZXIoY29tbWl0TG9nLCBrZXksIGJlZm9yZUlkeCk7XG59XG5cbi8qKlxuICogU3RyYXRlZ3kgMjogUmV2ZXJzZSBpbmRleCDigJQgTyhOw5dVKSBidWlsZCwgTyhsb2cgTikgcGVyIGxvb2t1cC5cbiAqIEJ1aWxkcyBhIE1hcDxrZXksIHNvcnRlZEluZGljZXNbXT4gd2hlcmUgaW5kaWNlcyBhcmUgY29tbWl0IHBvc2l0aW9uc1xuICogdGhhdCB3cm90ZSB0aGF0IGtleS4gTG9va3VwIHVzZXMgYmluYXJ5IHNlYXJjaCB0byBmaW5kIHRoZSBsYXN0IHdyaXRlclxuICogYmVmb3JlIGEgZ2l2ZW4gcG9zaXRpb24uXG4gKi9cbmZ1bmN0aW9uIHJldmVyc2VJbmRleExvb2t1cChjb21taXRMb2c6IENvbW1pdEJ1bmRsZVtdKTogV3JpdGVyTG9va3VwIHtcbiAgLy8gQnVpbGQ6IGtleSDihpIgc29ydGVkIGFycmF5IG9mIGNvbW1pdCBpbmRpY2VzIHRoYXQgd3JvdGUgdGhpcyBrZXlcbiAgY29uc3QgaW5kZXggPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyW10+KCk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY29tbWl0TG9nLmxlbmd0aDsgaSsrKSB7XG4gICAgZm9yIChjb25zdCB0IG9mIGNvbW1pdExvZ1tpXS50cmFjZSkge1xuICAgICAgbGV0IGFyciA9IGluZGV4LmdldCh0LnBhdGgpO1xuICAgICAgaWYgKCFhcnIpIHtcbiAgICAgICAgYXJyID0gW107XG4gICAgICAgIGluZGV4LnNldCh0LnBhdGgsIGFycik7XG4gICAgICB9XG4gICAgICBhcnIucHVzaChpKTsgLy8gYWxyZWFkeSBzb3J0ZWQgKHdlIGl0ZXJhdGUgaW4gb3JkZXIpXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIChrZXk6IHN0cmluZywgYmVmb3JlSWR4OiBudW1iZXIpOiBDb21taXRCdW5kbGUgfCB1bmRlZmluZWQgPT4ge1xuICAgIGNvbnN0IGluZGljZXMgPSBpbmRleC5nZXQoa2V5KTtcbiAgICBpZiAoIWluZGljZXMgfHwgaW5kaWNlcy5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAvLyBCaW5hcnkgc2VhcmNoOiBmaW5kIGxhcmdlc3QgaW5kZXggPCBiZWZvcmVJZHhcbiAgICBsZXQgbG8gPSAwO1xuICAgIGxldCBoaSA9IGluZGljZXMubGVuZ3RoIC0gMTtcbiAgICBsZXQgcmVzdWx0ID0gLTE7XG5cbiAgICB3aGlsZSAobG8gPD0gaGkpIHtcbiAgICAgIGNvbnN0IG1pZCA9IChsbyArIGhpKSA+Pj4gMTtcbiAgICAgIGlmIChpbmRpY2VzW21pZF0gPCBiZWZvcmVJZHgpIHtcbiAgICAgICAgcmVzdWx0ID0gaW5kaWNlc1ttaWRdO1xuICAgICAgICBsbyA9IG1pZCArIDE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBoaSA9IG1pZCAtIDE7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdCA+PSAwID8gY29tbWl0TG9nW3Jlc3VsdF0gOiB1bmRlZmluZWQ7XG4gIH07XG59XG5cbi8qKlxuICogU3RhZ2VkIG9wdGltaXphdGlvbjogcGljayB0aGUgcmlnaHQgd3JpdGVyLWxvb2t1cCBzdHJhdGVneSBiYXNlZCBvbiBkYXRhIHNpemUuXG4gKlxuICogTGlrZSBhIGRhdGFiYXNlIHF1ZXJ5IG9wdGltaXplciBjaG9vc2luZyBiZXR3ZWVuIHNlcXVlbnRpYWwgc2NhbiBhbmQgaW5kZXggc2NhbjpcbiAqXG4gKiAtICoqU21hbGwgbG9nICjiiaQgMjU2KToqKiBMaW5lYXIgc2NhbiB3aW5zLiBaZXJvIHNldHVwIGNvc3QsIGdvb2QgY2FjaGUgbG9jYWxpdHkuXG4gKiAgIFRoZSBvdmVyaGVhZCBvZiBidWlsZGluZyBhIHJldmVyc2UgaW5kZXggaXNuJ3Qgd29ydGggaXQgZm9yIHNob3J0IGxvZ3MuXG4gKlxuICogLSAqKkxhcmdlIGxvZyAoPiAyNTYpOioqIFJldmVyc2UgaW5kZXggd2lucy4gTyhOw5dVKSB1cGZyb250IGJ1aWxkIGNvc3QgaXMgYW1vcnRpemVkXG4gKiAgIGFjcm9zcyBhbGwgQkZTIGhvcHMuIEVhY2ggbG9va3VwIGJlY29tZXMgTyhsb2cgTikgdmlhIGJpbmFyeSBzZWFyY2ggaW5zdGVhZCBvZiBPKE4pLlxuICogICBGb3IgYW4gYWdlbnQgbG9vcCB3aXRoIDUwMCBpdGVyYXRpb25zIGFuZCA1IGtleXMgcGVyIGhvcCwgdGhpcyBpcyA1MDDDlzXDl2xvZyg1MDAp4omIMjJLIG9wc1xuICogICB2cyA1MDDDlzXDlzUwMD0xLjI1TSBvcHMgd2l0aCBsaW5lYXIgc2Nhbi5cbiAqXG4gKiBUaGUgY2FsbGVyIG5ldmVyIHNlZXMgdGhpcyDigJQgYGNhdXNhbENoYWluKClgIHBpY2tzIGF1dG9tYXRpY2FsbHkuXG4gKi9cbmZ1bmN0aW9uIGNyZWF0ZVdyaXRlckxvb2t1cChjb21taXRMb2c6IENvbW1pdEJ1bmRsZVtdKTogV3JpdGVyTG9va3VwIHtcbiAgaWYgKGNvbW1pdExvZy5sZW5ndGggPD0gUkVWRVJTRV9JTkRFWF9USFJFU0hPTEQpIHtcbiAgICByZXR1cm4gbGluZWFyU2Nhbkxvb2t1cChjb21taXRMb2cpO1xuICB9XG4gIHJldHVybiByZXZlcnNlSW5kZXhMb29rdXAoY29tbWl0TG9nKTtcbn1cblxuLy8g4pSA4pSAIENvcmUgYWxnb3JpdGhtIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIFJGQy0wMDMgRDI6IHRoZSBgaW5jb21wbGV0ZVNvdXJjZXNgIG5vZGUgZnJhZ21lbnQgZm9yIGEgY29tbWl0IOKAlCBge31gXG4gKiB3aGVuIHRoZSBzdGFnZSBjb25zdW1lZCBubyB1bnRyYWNrZWQgcmVhZCBwYXRocywga2VlcGluZyB0aGUgZmllbGRcbiAqIEFCU0VOVCAobm90IGVtcHR5LWFycmF5LXZhbHVlZCkgZm9yIGZ1bGx5LXRyYWNrZWQgc3RhZ2VzLlxuICovXG5mdW5jdGlvbiBpbmNvbXBsZXRlU291cmNlc0ZyYWdtZW50KGNvbW1pdDogQ29tbWl0QnVuZGxlKTogeyBpbmNvbXBsZXRlU291cmNlcz86IFJlYWRvbmx5QXJyYXk8VW50cmFja2VkU291cmNlPiB9IHtcbiAgaWYgKCFjb21taXQudW50cmFja2VkU291cmNlcyB8fCBjb21taXQudW50cmFja2VkU291cmNlcy5sZW5ndGggPT09IDApIHJldHVybiB7fTtcbiAgcmV0dXJuIHsgaW5jb21wbGV0ZVNvdXJjZXM6IGNvbW1pdC51bnRyYWNrZWRTb3VyY2VzIH07XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGNhdXNhbCBEQUcgcm9vdGVkIGF0IGBzdGFydElkYCBieSB3YWxraW5nIGJhY2t3YXJkc1xuICogdGhyb3VnaCByZWFk4oaSd3JpdGUgZGVwZW5kZW5jaWVzIGluIHRoZSBjb21taXQgbG9nLlxuICpcbiAqIEF1dG9tYXRpY2FsbHkgc2VsZWN0cyB0aGUgb3B0aW1hbCB3cml0ZXIgbG9va3VwIHN0cmF0ZWd5OlxuICogLSBMaW5lYXIgc2NhbiBmb3Igc21hbGwgbG9ncyAo4omkIDI1NiBjb21taXRzKVxuICogLSBSZXZlcnNlIGluZGV4IHdpdGggYmluYXJ5IHNlYXJjaCBmb3IgbGFyZ2UgbG9ncyAoPiAyNTYgY29tbWl0cylcbiAqXG4gKiBQcm9kdWNlcyBhIERBRyAobm90IGEgdHJlZSk6IGlmIHR3byBjaGlsZHJlbiBib3RoIHJlYWQgZnJvbSB0aGUgc2FtZVxuICogcGFyZW50LCB0aGUgcGFyZW50IG5vZGUgaXMgc2hhcmVkIChkZWR1cGVkIGJ5IHJ1bnRpbWVTdGFnZUlkKS5cbiAqXG4gKiBAcGFyYW0gY29tbWl0TG9nICAgT3JkZXJlZCBjb21taXQgYnVuZGxlcyBmcm9tIGV4ZWN1dG9yLmdldFNuYXBzaG90KCkuY29tbWl0TG9nXG4gKiBAcGFyYW0gc3RhcnRJZCAgICAgcnVudGltZVN0YWdlSWQgdG8gc3RhcnQgYmFja3RyYWNraW5nIGZyb21cbiAqIEBwYXJhbSBnZXRLZXlzUmVhZCBDYWxsYmFjayByZXR1cm5pbmcga2V5cyByZWFkIGJ5IGEgZ2l2ZW4gZXhlY3V0aW9uIHN0ZXBcbiAqIEBwYXJhbSBvcHRpb25zICAgICBEZXB0aCBhbmQgbm9kZSBsaW1pdHNcbiAqIEByZXR1cm5zIFJvb3QgQ2F1c2FsTm9kZSB3aXRoIC5wYXJlbnRzIGZvcm1pbmcgdGhlIERBRywgb3IgdW5kZWZpbmVkIGlmIHN0YXJ0SWQgbm90IGZvdW5kXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYXVzYWxDaGFpbihcbiAgY29tbWl0TG9nOiBDb21taXRCdW5kbGVbXSxcbiAgc3RhcnRJZDogc3RyaW5nLFxuICBnZXRLZXlzUmVhZDogS2V5c1JlYWRMb29rdXAsXG4gIG9wdGlvbnM/OiBDYXVzYWxDaGFpbk9wdGlvbnMsXG4pOiBDYXVzYWxOb2RlIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbWF4RGVwdGggPSBvcHRpb25zPy5tYXhEZXB0aCA/PyAyMDtcbiAgY29uc3QgbWF4Tm9kZXMgPSBvcHRpb25zPy5tYXhOb2RlcyA/PyAxMDA7XG4gIGNvbnN0IGNvbnRyb2xEZXBzID0gb3B0aW9ucz8uY29udHJvbERlcHM7XG4gIGNvbnN0IHdlaWdoID0gb3B0aW9ucz8ud2VpZ2g7XG4gIGNvbnN0IHBlcldyaXRlID0gb3B0aW9ucz8uZWRnZUF0dHJpYnV0aW9uID09PSAncGVyLXdyaXRlJztcblxuICAvLyBSRkMtMDAzIEQ0IOKAlCB0cnVuY2F0aW9uIHZpc2liaWxpdHkuIFNldCBvbmx5IHdoZW4gYSBsaW1pdCBhY3R1YWxseVxuICAvLyBjdXRzIHRoZSBzbGljZTsgc3VyZmFjZWQgb24gdGhlIHJvb3QgYXMgYHRydW5jYXRlZGAgc28gYSBjb25zdW1lciBjYW5cbiAgLy8gbmV2ZXIgbWlzdGFrZSBhIHRydW5jYXRlZCBzbGljZSBmb3IgYSBjb21wbGV0ZSBvbmUuXG4gIGxldCB0cnVuY2F0ZWRCeURlcHRoID0gZmFsc2U7XG4gIGxldCB0cnVuY2F0ZWRCeU5vZGVzID0gZmFsc2U7XG5cbiAgLy8gQnVpbGQgcG9zaXRpb24gaW5kZXg6IHJ1bnRpbWVTdGFnZUlkIOKGkiBhcnJheSBwb3NpdGlvbiAoTyhuKSBvbmNlKVxuICBjb25zdCBpZHhNYXAgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGNvbW1pdExvZy5sZW5ndGg7IGkrKykge1xuICAgIGlkeE1hcC5zZXQoY29tbWl0TG9nW2ldLnJ1bnRpbWVTdGFnZUlkLCBpKTtcbiAgfVxuXG4gIGNvbnN0IHN0YXJ0SWR4ID0gaWR4TWFwLmdldChzdGFydElkKTtcbiAgaWYgKHN0YXJ0SWR4ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3Qgc3RhcnRDb21taXQgPSBjb21taXRMb2dbc3RhcnRJZHhdO1xuXG4gIC8vIFBpY2sgd3JpdGVyIGxvb2t1cCBzdHJhdGVneSBiYXNlZCBvbiBsb2cgc2l6ZVxuICBjb25zdCBmaW5kV3JpdGVyID0gY3JlYXRlV3JpdGVyTG9va3VwKGNvbW1pdExvZyk7XG5cbiAgLy8gTm9kZSBkZWR1cCBtYXA6IHJ1bnRpbWVTdGFnZUlkIOKGkiBDYXVzYWxOb2RlIChlbnN1cmVzIERBRywgbm90IHRyZWUpXG4gIGNvbnN0IG5vZGVNYXAgPSBuZXcgTWFwPHN0cmluZywgQ2F1c2FsTm9kZT4oKTtcblxuICBjb25zdCByb290OiBDYXVzYWxOb2RlID0ge1xuICAgIHJ1bnRpbWVTdGFnZUlkOiBzdGFydElkLFxuICAgIHN0YWdlSWQ6IHN0YXJ0Q29tbWl0LnN0YWdlSWQsXG4gICAgc3RhZ2VOYW1lOiBzdGFydENvbW1pdC5zdGFnZSxcbiAgICBrZXlzV3JpdHRlbjogc3RhcnRDb21taXQudHJhY2UubWFwKCh0KSA9PiB0LnBhdGgpLFxuICAgIGxpbmtlZEJ5OiAnJyxcbiAgICBkZXB0aDogMCxcbiAgICBwYXJlbnRzOiBbXSxcbiAgICBwYXJlbnRFZGdlczogW10sXG4gICAgLi4uaW5jb21wbGV0ZVNvdXJjZXNGcmFnbWVudChzdGFydENvbW1pdCksXG4gIH07XG4gIG5vZGVNYXAuc2V0KHN0YXJ0SWQsIHJvb3QpO1xuXG4gIC8vIOKUgOKUgCAjUDEgcGVyLXdyaXRlIGF0dHJpYnV0aW9uIG1hY2hpbmVyeSAoaW5lcnQgdW5kZXIgJ3N0YWdlJykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vIGV4cGFuZGVkUmVhZHM6IHBlciBub2RlLCB0aGUgcmVhZHMgYWxyZWFkeSBxdWV1ZWQgZm9yIGV4cGFuc2lvbiDigJQgbGF0ZVxuICAvLyBsaW5rcyB2aWEgYWRkaXRpb25hbCBrZXlzIHJlLWVucXVldWUgb25seSB0aGUgREVMVEEsIHNvIHRoZSBzbGljZSBncm93c1xuICAvLyBtb25vdG9uaWNhbGx5IHRvd2FyZCB0aGUgc3RhZ2UtbGV2ZWwgY2VpbGluZyBhbmQgdGVybWluYXRlcyAoZWFjaCBrZXlcbiAgLy8gZXhwYW5kcyBhdCBtb3N0IG9uY2UgcGVyIG5vZGUpLiBmdWxseUV4cGFuZGVkOiBub2RlcyB0aGF0IGZlbGwgYmFjayB0b1xuICAvLyBzdGFnZSBsZXZlbCAobm8gcmVhZEtleXMgb24gYSBsaW5raW5nIGVudHJ5KSDigJQgbm90aGluZyBsZWZ0IHRvIGFkZC5cbiAgY29uc3QgZXhwYW5kZWRSZWFkcyA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcbiAgY29uc3QgZnVsbHlFeHBhbmRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8qKlxuICAgKiBSZXNvbHZlIGEgbm9kZSdzIGV4cGFuc2lvbiByZWFkLXNldCBmb3IgdGhlIGdpdmVuIGxpbmtpbmcgV1JJVFRFTiBrZXlzLlxuICAgKiBQZXItd3JpdGUgbW9kZSB3aXRoIHByb3ZlbmFuY2UgcHJlc2VudCDihpIgdW5pb24gb2YgdGhlIGxpbmtpbmcgd3JpdGVzJ1xuICAgKiB0ZW1wb3JhbC1wcmVmaXggYHJlYWRLZXlzYC4gQW55IGxpbmtpbmcgZW50cnkgV0lUSE9VVCBgcmVhZEtleXNgIChvciBub1xuICAgKiBsaW5rS2V5cyBhdCBhbGwpIOKGkiBob25lc3Qgc3RhZ2UtbGV2ZWwgZmFsbGJhY2ssIGZsYWdnZWQgdmlhIHRoZSBzZWNvbmRcbiAgICogdHVwbGUgbWVtYmVyIHNvIHRoZSBjYWxsZXIgbWFya3MgdGhlIG5vZGUgZnVsbHkgZXhwYW5kZWQuXG4gICAqL1xuICBmdW5jdGlvbiByZWFkc0ZvckxpbmtzKGNvbW1pdDogQ29tbWl0QnVuZGxlLCBsaW5rS2V5czogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBbc3RyaW5nW10sIGJvb2xlYW5dIHtcbiAgICBpZiAoIXBlcldyaXRlIHx8ICFsaW5rS2V5cyB8fCBsaW5rS2V5cy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiBbZ2V0S2V5c1JlYWQoY29tbWl0LnJ1bnRpbWVTdGFnZUlkKSwgdHJ1ZV07XG4gICAgfVxuICAgIGNvbnN0IHVuaW9uID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBsaW5rS2V5IG9mIGxpbmtLZXlzKSB7XG4gICAgICBjb25zdCBlbnRyeSA9IGNvbW1pdC50cmFjZS5maW5kKCh0KSA9PiB0LnBhdGggPT09IGxpbmtLZXkpO1xuICAgICAgaWYgKCFlbnRyeSB8fCBlbnRyeS5yZWFkS2V5cyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIC8vIE1peGVkL2RpYWwtb2ZmIGxvZyDigJQgZGVncmFkZSBUSElTIG5vZGUgdG8gc3RhZ2UgbGV2ZWwsIGhvbmVzdGx5LlxuICAgICAgICByZXR1cm4gW2dldEtleXNSZWFkKGNvbW1pdC5ydW50aW1lU3RhZ2VJZCksIHRydWVdO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCByayBvZiBlbnRyeS5yZWFkS2V5cykgdW5pb24uYWRkKHJrKTtcbiAgICB9XG4gICAgcmV0dXJuIFtbLi4udW5pb25dLCBmYWxzZV07XG4gIH1cblxuICAvLyBCRlMvd29ya2xpc3QgcXVldWU6IFtub2RlLCBjb21taXRJZHgsIGRlcHRoLCBrZXlzVG9FeHBhbmRdXG4gIGNvbnN0IFtyb290UmVhZHMsIHJvb3RJc0Z1bGxdID0gcGVyV3JpdGVcbiAgICA/IHJlYWRzRm9yTGlua3Moc3RhcnRDb21taXQsIG9wdGlvbnM/LnJvb3RMaW5rS2V5cylcbiAgICA6IFtnZXRLZXlzUmVhZChzdGFydElkKSwgdHJ1ZV07XG4gIGV4cGFuZGVkUmVhZHMuc2V0KHN0YXJ0SWQsIG5ldyBTZXQocm9vdFJlYWRzKSk7XG4gIGlmIChyb290SXNGdWxsKSBmdWxseUV4cGFuZGVkLmFkZChzdGFydElkKTtcbiAgY29uc3QgcXVldWU6IEFycmF5PFtDYXVzYWxOb2RlLCBudW1iZXIsIG51bWJlciwgc3RyaW5nW11dPiA9IFtbcm9vdCwgc3RhcnRJZHgsIDAsIHJvb3RSZWFkc11dO1xuICBsZXQgdmlzaXRlZCA9IDE7XG5cbiAgLyoqXG4gICAqIExpbmsgYG5vZGUg4oaSIHBhcmVudGAgKGNyZWF0aW5nICsgZW5xdWV1ZWluZyB0aGUgcGFyZW50IHdoZW4gbmV3KS5cbiAgICogU2hhcmVkIGJ5IGRhdGEtZWRnZSBleHBhbnNpb24gKHJlYWTihpJ3cml0ZSkgYW5kIGNvbnRyb2wtZWRnZSBleHBhbnNpb25cbiAgICogKEQzKS4gT25lIENhdXNhbEVkZ2UgcGVyIGRpc3RpbmN0IChwYXJlbnQsIGtpbmQsIGtleSkgbGluazsgYHBhcmVudHNgXG4gICAqIGtlZXBzIGl0cyBoaXN0b3JpY2FsIG9uZS1lbnRyeS1wZXItcGFyZW50IGRlZHVwLlxuICAgKi9cbiAgZnVuY3Rpb24gbGlua1BhcmVudChcbiAgICBub2RlOiBDYXVzYWxOb2RlLFxuICAgIHBhcmVudENvbW1pdDogQ29tbWl0QnVuZGxlLFxuICAgIGtpbmQ6ICdkYXRhJyB8ICdjb250cm9sJyxcbiAgICBrZXk6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBkZXB0aDogbnVtYmVyLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBwYXJlbnRJZCA9IHBhcmVudENvbW1pdC5ydW50aW1lU3RhZ2VJZDtcbiAgICAvLyAjUDE6IHRoZSBwYXJlbnQncyBleHBhbnNpb24gcmVhZHMsIHJlc29sdmVkIExBWklMWSAob25seSBmb3IgbmV3IG5vZGVzXG4gICAgLy8gb3IgcGVyLXdyaXRlIHJlLWV4cGFuc2lvbiDigJQgZHVwbGljYXRlIGxpbmtzIHVuZGVyICdzdGFnZScgcGF5IG5vdGhpbmcpLlxuICAgIC8vIERhdGEgbGlua3MgZXhwYW5kIHRocm91Z2ggdGhlIHJlYWRzIHRoYXQgZmVkIHRoZSBwYXJlbnQncyB3cml0ZSBvZlxuICAgIC8vIGBrZXlgOyBjb250cm9sIGxpbmtzIGV4cGFuZCB0aGUgZGVjaWRlciBhdCBzdGFnZSBsZXZlbCAoYSBkZWNpc2lvblxuICAgIC8vIGRlcGVuZHMgb24gZXZlcnl0aGluZyBpdCByZWFkKS5cbiAgICBjb25zdCByZXNvbHZlTGlua1JlYWRzID0gKCk6IFtzdHJpbmdbXSwgYm9vbGVhbl0gPT5cbiAgICAgIGtpbmQgPT09ICdkYXRhJ1xuICAgICAgICA/IHJlYWRzRm9yTGlua3MocGFyZW50Q29tbWl0LCBrZXkgIT09IHVuZGVmaW5lZCA/IFtrZXldIDogdW5kZWZpbmVkKVxuICAgICAgICA6IFtnZXRLZXlzUmVhZChwYXJlbnRJZCksIHRydWVdO1xuXG4gICAgbGV0IHBhcmVudE5vZGUgPSBub2RlTWFwLmdldChwYXJlbnRJZCk7XG4gICAgaWYgKCFwYXJlbnROb2RlKSB7XG4gICAgICAvLyBOZXcgbm9kZSDigJQgY3JlYXRlIGFuZCBlbnF1ZXVlIChyZXNwZWN0aW5nIHRoZSBub2RlIGJ1ZGdldClcbiAgICAgIGlmICh2aXNpdGVkID49IG1heE5vZGVzKSB7XG4gICAgICAgIHRydW5jYXRlZEJ5Tm9kZXMgPSB0cnVlOyAvLyBENDogYSBkaXNjb3ZlcmVkIHBhcmVudCB3YXMgZHJvcHBlZFxuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHBhcmVudElkeCA9IGlkeE1hcC5nZXQocGFyZW50SWQpO1xuICAgICAgaWYgKHBhcmVudElkeCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG5cbiAgICAgIHBhcmVudE5vZGUgPSB7XG4gICAgICAgIHJ1bnRpbWVTdGFnZUlkOiBwYXJlbnRJZCxcbiAgICAgICAgc3RhZ2VJZDogcGFyZW50Q29tbWl0LnN0YWdlSWQsXG4gICAgICAgIHN0YWdlTmFtZTogcGFyZW50Q29tbWl0LnN0YWdlLFxuICAgICAgICBrZXlzV3JpdHRlbjogcGFyZW50Q29tbWl0LnRyYWNlLm1hcCgodCkgPT4gdC5wYXRoKSxcbiAgICAgICAgLy8gbGlua2VkQnkgc3RheXMgYSBEQVRBLWtleSBjb25jZXB0IChiYWNrLWNvbXBhdCkg4oCUIGNvbnRyb2wtbGlua2VkXG4gICAgICAgIC8vIG5vZGVzIGNhcnJ5IHRoZWlyIGxhYmVsIG9uIHRoZSBlZGdlIGluc3RlYWQuXG4gICAgICAgIGxpbmtlZEJ5OiBraW5kID09PSAnZGF0YScgPyBrZXkgPz8gJycgOiAnJyxcbiAgICAgICAgZGVwdGg6IGRlcHRoICsgMSxcbiAgICAgICAgcGFyZW50czogW10sXG4gICAgICAgIHBhcmVudEVkZ2VzOiBbXSxcbiAgICAgICAgLi4uaW5jb21wbGV0ZVNvdXJjZXNGcmFnbWVudChwYXJlbnRDb21taXQpLFxuICAgICAgfTtcbiAgICAgIG5vZGVNYXAuc2V0KHBhcmVudElkLCBwYXJlbnROb2RlKTtcbiAgICAgIHZpc2l0ZWQrKztcbiAgICAgIGNvbnN0IFtsaW5rUmVhZHMsIGxpbmtJc0Z1bGxdID0gcmVzb2x2ZUxpbmtSZWFkcygpO1xuICAgICAgZXhwYW5kZWRSZWFkcy5zZXQocGFyZW50SWQsIG5ldyBTZXQobGlua1JlYWRzKSk7XG4gICAgICBpZiAobGlua0lzRnVsbCkgZnVsbHlFeHBhbmRlZC5hZGQocGFyZW50SWQpO1xuICAgICAgcXVldWUucHVzaChbcGFyZW50Tm9kZSwgcGFyZW50SWR4LCBkZXB0aCArIDEsIGxpbmtSZWFkc10pO1xuICAgIH0gZWxzZSBpZiAocGVyV3JpdGUgJiYgIWZ1bGx5RXhwYW5kZWQuaGFzKHBhcmVudElkKSkge1xuICAgICAgLy8gI1AxIHdvcmtsaXN0OiBhbiBFWElTVElORyBub2RlIGxpbmtlZCB2aWEgYW5vdGhlciBrZXkgbWF5IG93ZSBtb3JlXG4gICAgICAvLyBleHBhbnNpb24g4oCUIGVucXVldWUgb25seSB0aGUgcmVhZHMgbm90IHlldCBleHBhbmRlZCAobW9ub3RvbmU7IHRoZVxuICAgICAgLy8gbm9kZSBidWRnZXQgaXMgdW50b3VjaGVkLCBubyBub2RlIGlzIGNyZWF0ZWQpLiBSZS1leHBhbnNpb24ga2VlcHNcbiAgICAgIC8vIHRoZSBub2RlJ3MgT1JJR0lOQUwgZGVwdGggc28gaXRzIHBhcmVudHMgZ2V0IGEgY29uc2lzdGVudCBkZXB0aCsxLlxuICAgICAgY29uc3QgW2xpbmtSZWFkcywgbGlua0lzRnVsbF0gPSByZXNvbHZlTGlua1JlYWRzKCk7XG4gICAgICBjb25zdCBleHBhbmRlZCA9IGV4cGFuZGVkUmVhZHMuZ2V0KHBhcmVudElkKSE7XG4gICAgICBjb25zdCBkZWx0YSA9IGxpbmtSZWFkcy5maWx0ZXIoKGspID0+ICFleHBhbmRlZC5oYXMoaykpO1xuICAgICAgaWYgKGxpbmtJc0Z1bGwpIGZ1bGx5RXhwYW5kZWQuYWRkKHBhcmVudElkKTtcbiAgICAgIGlmIChkZWx0YS5sZW5ndGggPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgayBvZiBkZWx0YSkgZXhwYW5kZWQuYWRkKGspO1xuICAgICAgICBjb25zdCBwYXJlbnRJZHggPSBpZHhNYXAuZ2V0KHBhcmVudElkKTtcbiAgICAgICAgaWYgKHBhcmVudElkeCAhPT0gdW5kZWZpbmVkKSBxdWV1ZS5wdXNoKFtwYXJlbnROb2RlLCBwYXJlbnRJZHgsIHBhcmVudE5vZGUuZGVwdGgsIGRlbHRhXSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gREFHIG1lcmdlOiBvbmUgcGFyZW50c1tdIGVudHJ5IHBlciBkaXN0aW5jdCBwYXJlbnQgKGhpc3RvcmljYWwgc2hhcGUpXG4gICAgaWYgKCFub2RlLnBhcmVudHMuc29tZSgocCkgPT4gcC5ydW50aW1lU3RhZ2VJZCA9PT0gcGFyZW50SWQpKSB7XG4gICAgICBub2RlLnBhcmVudHMucHVzaChwYXJlbnROb2RlKTtcbiAgICB9XG4gICAgLy8gT25lIGVkZ2UgcGVyIGRpc3RpbmN0IChwYXJlbnQsIGtpbmQsIGtleSkgbGluay4gVGhlIHdlaWdoZXIgKEQ0KVxuICAgIC8vIHN0YW1wcyB0aGUgd2VpZ2h0IGF0IGNyZWF0aW9uOyBgdW5kZWZpbmVkYCDihpIgMS4wIOKAlCB0aGUgZW5naW5lIG5ldmVyXG4gICAgLy8gY29tcHV0ZXMgd2VpZ2h0cyBpdHNlbGYuXG4gICAgaWYgKCFub2RlLnBhcmVudEVkZ2VzLnNvbWUoKGUpID0+IGUucGFyZW50LnJ1bnRpbWVTdGFnZUlkID09PSBwYXJlbnRJZCAmJiBlLmtpbmQgPT09IGtpbmQgJiYgZS5rZXkgPT09IGtleSkpIHtcbiAgICAgIC8vIEVycm9yIGlzb2xhdGlvbiAocmV2aWV3IGZpbmRpbmcpOiBhIGNvbnN1bWVyIHdlaWdoZXIgdGhhdCB0aHJvd3NcbiAgICAgIC8vIG11c3QgZGVncmFkZSB0byB0aGUgZGVmYXVsdCB3ZWlnaHQsIG5ldmVyIGNyYXNoIHRoZSBzbGljZSDigJQgdGhlXG4gICAgICAvLyBzYW1lIGNvbnRyYWN0IGV2ZXJ5IG90aGVyIGNvbnN1bWVyIGNhbGxiYWNrIGluIHRoZSBsaWJyYXJ5IGdldHMuXG4gICAgICBsZXQgd2VpZ2h0ID0gMS4wO1xuICAgICAgaWYgKHdlaWdoKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgd2VpZ2h0ID0gd2VpZ2gobm9kZSwgcGFyZW50Tm9kZSwga2V5LCBraW5kKSA/PyAxLjA7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIHdlaWdoZXIgdGhyZXcg4oCUIGtlZXAgMS4wLCB0aGUgc2xpY2Ugc3RheXMgdXNhYmxlICovXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIG5vZGUucGFyZW50RWRnZXMucHVzaCh7IHBhcmVudDogcGFyZW50Tm9kZSwga2luZCwga2V5LCB3ZWlnaHQgfSk7XG4gICAgfVxuICB9XG5cbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBbbm9kZSwgY29tbWl0SWR4LCBkZXB0aCwga2V5c1RvRXhwYW5kXSA9IHF1ZXVlLnNoaWZ0KCkhO1xuXG4gICAgaWYgKGRlcHRoID49IG1heERlcHRoKSB7XG4gICAgICAvLyBENDogb25seSBhIG5vZGUgdGhhdCBzdGlsbCBIQUQgc29tZXRoaW5nIHRvIGV4cGFuZCBjb3VudHMgYXMgYSBjdXRcbiAgICAgIC8vIChhIGxlYWYgYXQgdGhlIGhvcml6b24gdHJ1bmNhdGVzIG5vdGhpbmcpLlxuICAgICAgaWYgKGtleXNUb0V4cGFuZC5sZW5ndGggPiAwIHx8IGNvbnRyb2xEZXBzPy4obm9kZS5ydW50aW1lU3RhZ2VJZCkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0cnVuY2F0ZWRCeURlcHRoID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIERhdGEgZWRnZXM6IGZvciBlYWNoIGtleSBpbiB0aGlzIGV4cGFuc2lvbidzIHJlYWQtc2V0LCBmaW5kIHdobyB3cm90ZVxuICAgIC8vIGl0LiBVbmRlciAnc3RhZ2UnIHRoaXMgaXMgdGhlIG5vZGUncyBmdWxsIHJlYWQtc2V0IChoaXN0b3JpY2FsXG4gICAgLy8gYmVoYXZpb3IpOyB1bmRlciAncGVyLXdyaXRlJyBpdCBpcyB0aGUgbGlua2luZyB3cml0ZXMnIHRlbXBvcmFsIHByZWZpeFxuICAgIC8vIChvciBhIHdvcmtsaXN0IGRlbHRhIG9uIHJlLWV4cGFuc2lvbikuXG4gICAgY29uc3Qga2V5c1JlYWQgPSBrZXlzVG9FeHBhbmQ7XG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5c1JlYWQpIHtcbiAgICAgIGNvbnN0IHdyaXRlciA9IGZpbmRXcml0ZXIoa2V5LCBjb21taXRJZHgpO1xuICAgICAgaWYgKCF3cml0ZXIpIGNvbnRpbnVlO1xuICAgICAgbGlua1BhcmVudChub2RlLCB3cml0ZXIsICdkYXRhJywga2V5LCBkZXB0aCk7XG4gICAgfVxuXG4gICAgLy8gQ29udHJvbCBlZGdlIChSRkMtMDAzIEQzKTogbGluayB0aGUgZ292ZXJuaW5nIGRlY2lkZXIsIGxhYmVsZWQgYnkgdGhlXG4gICAgLy8gZGVjaWRlKCkgcnVsZSBsYWJlbCB3aGVuIHByZXNlbnQuIFRoZSBkZWNpZGVyIG5vZGUgdGhlbiBleHBhbmRzXG4gICAgLy8gbm9ybWFsbHkgdGhyb3VnaCBpdHMgb3duIGRhdGEgcmVhZHMgKGFuZCBpdHMgb3duIGNvbnRyb2wgcGFyZW50KS5cbiAgICBpZiAoY29udHJvbERlcHMpIHtcbiAgICAgIGNvbnN0IGRlcCA9IGNvbnRyb2xEZXBzKG5vZGUucnVudGltZVN0YWdlSWQpO1xuICAgICAgaWYgKGRlcCkge1xuICAgICAgICBjb25zdCBkZWNpZGVySWR4ID0gaWR4TWFwLmdldChkZXAuZGVjaWRlcklkKTtcbiAgICAgICAgaWYgKGRlY2lkZXJJZHggIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGxpbmtQYXJlbnQobm9kZSwgY29tbWl0TG9nW2RlY2lkZXJJZHhdLCAnY29udHJvbCcsIGRlcC5sYWJlbCwgZGVwdGgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gUkZDLTAwMyBENCDigJQgdHJ1bmNhdGlvbiB2aXNpYmlsaXR5IG9uIHRoZSByb290IChhYnNlbnQgd2hlbiBjb21wbGV0ZSkuXG4gIGlmICh0cnVuY2F0ZWRCeURlcHRoIHx8IHRydW5jYXRlZEJ5Tm9kZXMpIHtcbiAgICByb290LnRydW5jYXRlZCA9IHsgYnlEZXB0aDogdHJ1bmNhdGVkQnlEZXB0aCwgYnlOb2RlczogdHJ1bmNhdGVkQnlOb2RlcyB9O1xuICAgIGlmIChpc0Rldk1vZGUoKSkge1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgYFtmb290cHJpbnRdIGNhdXNhbENoYWluKCcke3N0YXJ0SWR9JykgdHJ1bmNhdGVkIGJ5IGAgK1xuICAgICAgICAgIGAke1t0cnVuY2F0ZWRCeURlcHRoICYmIGBtYXhEZXB0aCAoJHttYXhEZXB0aH0pYCwgdHJ1bmNhdGVkQnlOb2RlcyAmJiBgbWF4Tm9kZXMgKCR7bWF4Tm9kZXN9KWBdXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAgICAgICAuam9pbignICsgJyl9IOKAlCB0aGUgc2xpY2UgaXMgaW5jb21wbGV0ZS4gUmFpc2UgdGhlIGxpbWl0cyBvciBuYXJyb3cga2V5c1JlYWQuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJvb3Q7XG59XG5cbi8vIOKUgOKUgCBVdGlsaXRpZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICogRmxhdHRlbiB0aGUgY2F1c2FsIERBRyBpbnRvIGEgQkZTLW9yZGVyZWQgbGlzdCBvZiBub2Rlcy5cbiAqIEVhY2ggbm9kZSBhcHBlYXJzIGV4YWN0bHkgb25jZSAoZmlyc3Qgb2NjdXJyZW5jZSBieSBCRlMgb3JkZXIpLlxuICogVXNlZnVsIGZvciBsaW5lYXIgZGlzcGxheSBvciBpdGVyYXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmbGF0dGVuQ2F1c2FsREFHKHJvb3Q6IENhdXNhbE5vZGUpOiBDYXVzYWxOb2RlW10ge1xuICBjb25zdCByZXN1bHQ6IENhdXNhbE5vZGVbXSA9IFtdO1xuICBjb25zdCB2aXNpdGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHF1ZXVlOiBDYXVzYWxOb2RlW10gPSBbcm9vdF07XG5cbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBub2RlID0gcXVldWUuc2hpZnQoKSE7XG4gICAgaWYgKHZpc2l0ZWQuaGFzKG5vZGUucnVudGltZVN0YWdlSWQpKSBjb250aW51ZTtcbiAgICB2aXNpdGVkLmFkZChub2RlLnJ1bnRpbWVTdGFnZUlkKTtcbiAgICByZXN1bHQucHVzaChub2RlKTtcblxuICAgIGZvciAoY29uc3QgcGFyZW50IG9mIG5vZGUucGFyZW50cykge1xuICAgICAgaWYgKCF2aXNpdGVkLmhhcyhwYXJlbnQucnVudGltZVN0YWdlSWQpKSB7XG4gICAgICAgIHF1ZXVlLnB1c2gocGFyZW50KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIGNhdXNhbCBEQUcgYXMgaHVtYW4tcmVhZGFibGUgaW5kZW50ZWQgdGV4dC5cbiAqIFNob3dzIHRoZSBkZXBlbmRlbmN5IGNoYWluIHdpdGggZGVwdGggaW5kZW50YXRpb24gYW5kIGxpbmtlZC1ieSBrZXlzLlxuICpcbiAqIFJGQy0wMDMgRDI6IG5vZGVzIHRoYXQgY29uc3VtZWQgdW50cmFja2VkIHJlYWQgcGF0aHMgcmVuZGVyIGFuIGV4dHJhXG4gKiBg4pqgIGFsc28gY29uc3VtZWQg4oCmIOKAlCBzbGljZSBtYXkgYmUgaW5jb21wbGV0ZSBoZXJlYCBsaW5lLCBzbyBhIGNvbnN1bWVyXG4gKiAoaHVtYW4gb3IgTExNKSBkZWJ1Z2dpbmcgZnJvbSB0aGUgc2xpY2UgaXMgVE9MRCB3aGVuIGl0IGlzIGluY29tcGxldGUuXG4gKlxuICogUkZDLTAwMyBEMzogY29udHJvbCBlZGdlcyByZW5kZXIgYXMgYOKGkCBbY29udHJvbDogPHJ1bGUgbGFiZWw+XWBcbiAqIChsYWJlbCBvbWl0dGVkIHdoZW4gdGhlIGRlY2lzaW9uIGNhcnJpZWQgbm9uZSkuIERhdGEgcmVuZGVyaW5nIGlzXG4gKiBieXRlLWlkZW50aWNhbCB0byB0aGUgcHJlLUQzIG91dHB1dCDigJQgYOKGkCB2aWEgPGtleT5gIGZyb20gdGhlIG5vZGUnc1xuICogZGlzY292ZXJ5LXRpbWUgYGxpbmtlZEJ5YC5cbiAqXG4gKiBSRkMtMDAzIEQ0OiBlZGdlIHdlaWdodHMgZnJvbSB0aGUgYHdlaWdoYCBob29rIHJlbmRlciBhcyBhIHN1ZmZpeCDigJRcbiAqIGDihpAgdmlhIHN5c3RlbVByb21wdCAoMC4xOClgIOKAlCBvbmx5IHdoZW4g4omgIDEuMCwgc28gdW53ZWlnaHRlZCBvdXRwdXQgaXNcbiAqIHVuY2hhbmdlZC4gQSB0cnVuY2F0ZWQgc2xpY2UgKHJvb3QudHJ1bmNhdGVkKSBhcHBlbmRzIGEgZmluYWxcbiAqIGDimqAgc2xpY2UgdHJ1bmNhdGVkIOKApmAgbGluZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENhdXNhbENoYWluKHJvb3Q6IENhdXNhbE5vZGUpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGNvbnN0IHdlaWdodFN1ZmZpeCA9IChlZGdlOiBDYXVzYWxFZGdlIHwgdW5kZWZpbmVkKTogc3RyaW5nID0+XG4gICAgZWRnZSAhPT0gdW5kZWZpbmVkICYmIGVkZ2Uud2VpZ2h0ICE9PSAxID8gYCAoJHtlZGdlLndlaWdodH0pYCA6ICcnO1xuXG4gIGZ1bmN0aW9uIHdhbGsobm9kZTogQ2F1c2FsTm9kZSwgaW5kZW50OiBudW1iZXIsIGVkZ2VzRnJvbUNoaWxkPzogQ2F1c2FsRWRnZVtdKTogdm9pZCB7XG4gICAgaWYgKHZpc2l0ZWQuaGFzKG5vZGUucnVudGltZVN0YWdlSWQpKSB7XG4gICAgICBsaW5lcy5wdXNoKGAkeycgICcucmVwZWF0KGluZGVudCl94oazICR7bm9kZS5ydW50aW1lU3RhZ2VJZH0gKHNlZSBhYm92ZSlgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmlzaXRlZC5hZGQobm9kZS5ydW50aW1lU3RhZ2VJZCk7XG5cbiAgICBjb25zdCBsaW5rUGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKG5vZGUubGlua2VkQnkpIHtcbiAgICAgIGNvbnN0IGRhdGFFZGdlID0gZWRnZXNGcm9tQ2hpbGQ/LmZpbmQoKGUpID0+IGUua2luZCA9PT0gJ2RhdGEnKTtcbiAgICAgIGxpbmtQYXJ0cy5wdXNoKGB2aWEgJHtub2RlLmxpbmtlZEJ5fSR7d2VpZ2h0U3VmZml4KGRhdGFFZGdlKX1gKTtcbiAgICB9XG4gICAgY29uc3QgY29udHJvbEVkZ2UgPSBlZGdlc0Zyb21DaGlsZD8uZmluZCgoZSkgPT4gZS5raW5kID09PSAnY29udHJvbCcpO1xuICAgIGlmIChjb250cm9sRWRnZSkge1xuICAgICAgbGlua1BhcnRzLnB1c2goYFtjb250cm9sJHtjb250cm9sRWRnZS5rZXkgPyBgOiAke2NvbnRyb2xFZGdlLmtleX1gIDogJyd9XSR7d2VpZ2h0U3VmZml4KGNvbnRyb2xFZGdlKX1gKTtcbiAgICB9XG4gICAgY29uc3QgbGluayA9IGxpbmtQYXJ0cy5sZW5ndGggPiAwID8gYCDihpAgJHtsaW5rUGFydHMuam9pbignIOKGkCAnKX1gIDogJyc7XG5cbiAgICBjb25zdCB3cml0ZXMgPSBub2RlLmtleXNXcml0dGVuLmxlbmd0aCA+IDAgPyBgIFt3cm90ZTogJHtub2RlLmtleXNXcml0dGVuLmpvaW4oJywgJyl9XWAgOiAnJztcbiAgICBsaW5lcy5wdXNoKGAkeycgICcucmVwZWF0KGluZGVudCl9JHtub2RlLnN0YWdlTmFtZX0gKCR7bm9kZS5ydW50aW1lU3RhZ2VJZH0pJHtsaW5rfSR7d3JpdGVzfWApO1xuXG4gICAgaWYgKG5vZGUuaW5jb21wbGV0ZVNvdXJjZXMgJiYgbm9kZS5pbmNvbXBsZXRlU291cmNlcy5sZW5ndGggPiAwKSB7XG4gICAgICBsaW5lcy5wdXNoKFxuICAgICAgICBgJHsnICAnLnJlcGVhdChpbmRlbnQgKyAxKX3imqAgYWxzbyBjb25zdW1lZCAke25vZGUuaW5jb21wbGV0ZVNvdXJjZXMuam9pbignLycpfSDigJQgc2xpY2UgbWF5IGJlIGluY29tcGxldGUgaGVyZWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgcGFyZW50IG9mIG5vZGUucGFyZW50cykge1xuICAgICAgd2FsayhcbiAgICAgICAgcGFyZW50LFxuICAgICAgICBpbmRlbnQgKyAxLFxuICAgICAgICBub2RlLnBhcmVudEVkZ2VzLmZpbHRlcigoZSkgPT4gZS5wYXJlbnQgPT09IHBhcmVudCksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHdhbGsocm9vdCwgMCk7XG5cbiAgaWYgKHJvb3QudHJ1bmNhdGVkKSB7XG4gICAgY29uc3QgY2F1c2VzID0gW3Jvb3QudHJ1bmNhdGVkLmJ5RGVwdGggJiYgJ21heERlcHRoIHJlYWNoZWQnLCByb290LnRydW5jYXRlZC5ieU5vZGVzICYmICdtYXhOb2RlcyByZWFjaGVkJ11cbiAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgIC5qb2luKCcsICcpO1xuICAgIGxpbmVzLnB1c2goYOKaoCBzbGljZSB0cnVuY2F0ZWQgKCR7Y2F1c2VzfSkg4oCUIG9sZGVyIGNhdXNlcyBleGlzdCBiZXlvbmQgdGhpcyBob3Jpem9uYCk7XG4gIH1cblxuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG5cbi8vIOKUgOKUgCBFeHBvcnRlZCBmb3IgdGVzdGluZyAoaW50ZXJuYWwpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKiogQGludGVybmFsIEV4cG9zZWQgZm9yIHRlc3RpbmcgdGhlIHN0cmF0ZWd5IHNlbGVjdGlvbi4gKi9cbmV4cG9ydCBjb25zdCBfUkVWRVJTRV9JTkRFWF9USFJFU0hPTEQgPSBSRVZFUlNFX0lOREVYX1RIUkVTSE9MRDtcbiJdfQ==