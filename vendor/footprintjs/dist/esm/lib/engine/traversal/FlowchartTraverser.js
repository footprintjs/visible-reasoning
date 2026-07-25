/**
 * FlowchartTraverser — Pre-order DFS traversal of StageNode graph.
 *
 * Unified traversal algorithm for all node shapes. `executeNode` is a
 * TRAMPOLINE driver: it runs `executeNodeStep` (one node, all 7 phases) in
 * a flat loop, following tail continuations (linear `next`, loop edges,
 * dynamic next, flat decider dispatch) iteratively — so chain length and
 * loop iterations never grow the call stack. Only true tree nesting (fork
 * children, with-continuation decider/selector branches, subflow mounts)
 * recurses.
 *
 * For each node, executeNodeStep follows 7 phases:
 *   0. CLASSIFY  — subflow detection, early delegation
 *   1. VALIDATE  — node invariants, role markers
 *   2. EXECUTE   — run stage fn, commit, break check
 *   3. DYNAMIC   — StageNode return detection, subflow auto-registration, structure updates
 *   4. CHILDREN  — fork/selector/decider dispatch
 *   5. CONTINUE  — dynamic next / linear next resolution
 *   6. LEAF      — no continuation, return output
 *
 * Break semantics: If a stage calls breakFn(), commit and STOP.
 * Patch model: Stage writes into local patch; commitPatch() after return or throw.
 */
import { isPauseSignal } from '../../pause/types.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
import { isStageNodeReturn } from '../graph/StageNode.js';
import { ChildrenExecutor } from '../handlers/ChildrenExecutor.js';
import { ContinuationResolver } from '../handlers/ContinuationResolver.js';
import { DeciderHandler } from '../handlers/DeciderHandler.js';
import { NodeResolver } from '../handlers/NodeResolver.js';
import { RuntimeStructureManager } from '../handlers/RuntimeStructureManager.js';
import { SelectorHandler } from '../handlers/SelectorHandler.js';
import { StageRunner } from '../handlers/StageRunner.js';
import { SubflowExecutor } from '../handlers/SubflowExecutor.js';
import { FlowRecorderDispatcher } from '../narrative/FlowRecorderDispatcher.js';
import { NarrativeFlowRecorder } from '../narrative/NarrativeFlowRecorder.js';
import { NullControlFlowNarrativeGenerator } from '../narrative/NullControlFlowNarrativeGenerator.js';
import { buildRuntimeStageId } from '../runtimeStageId.js';
/**
 * Trampoline brand — marks a continuation hop returned by `executeNodeStep`
 * to the driver loop in `executeNode`. Module-private symbol so a stage's own
 * return value (which can be any object) can never be mistaken for a hop.
 */
const CONTINUE_HOP = Symbol('footprintjs.executeNode.continue');
function isContinuationHop(value) {
    return typeof value === 'object' && value !== null && value[CONTINUE_HOP] === true;
}
export class FlowchartTraverser {
    root;
    stageMap;
    executionRuntime;
    subflows;
    logger;
    signal;
    parentSubflowId;
    /** RFC-003 D1: runtimeStageId of the subflow mount stage in the parent
     *  traverser. Fallback `parentRuntimeStageId` for stages whose context has
     *  no parent (the subflow root). Undefined at the top level. */
    parentMountRuntimeStageId;
    /** Frozen value passed via `run({input})`. Surfaced on `onRunStart` at the
     *  top-level traversal so consumers (e.g. `InOutRecorder`) can bracket
     *  the run with the same payload shape that subflows already have. */
    readOnlyContext;
    /** Per-`executor.run()` identifier. Stamped onto every TraversalContext.
     *  Inherited by subflow traversers so all events of one run share one runId. */
    runId;
    // Handler modules
    nodeResolver;
    childrenExecutor;
    subflowExecutor;
    stageRunner;
    continuationResolver;
    deciderHandler;
    selectorHandler;
    structureManager;
    narrativeGenerator;
    flowRecorderDispatcher;
    // Execution state
    subflowResults = new Map();
    /**
     * Per-traverser set of lazy subflow IDs that have been resolved by THIS run.
     * Used instead of writing `node.subflowResolver = undefined` back to the shared
     * StageNode graph — avoids a race where a concurrent traverser clears the shared
     * resolver before another traverser has finished using it.
     */
    resolvedLazySubflows = new Set();
    /**
     * Per-traverser overlay of dynamic StageNode returns, keyed by `node.id`.
     * Phase 4 writes patches HERE instead of mutating the shared built-chart
     * node objects (same isolation convention as `resolvedLazySubflows`).
     * All engine reads of the patched fields go through the `eff*` accessors
     * below. The map dies with the traverser — one run, one overlay — so a
     * fresh executor over the same built chart always sees the original graph.
     *
     * Keyed by the node OBJECT (WeakMap), not `node.id`: a dynamic child that
     * reuses a built node's id must NOT make the built node inherit the patch
     * (id-keyed lookup caused phantom double-execution). `patchCount` is the
     * fast-path check — WeakMap has no `size`.
     */
    dynamicPatches = new WeakMap();
    patchCount = 0;
    /**
     * TREE-nesting depth counter for executeNode (the trampoline driver).
     * Each driver invocation increments this; decrements on exit (try/finally).
     *
     * Linear `next` chains, loop edges, and dynamic continuations are followed
     * ITERATIVELY inside one driver invocation, so they never grow this
     * counter. Only true tree recursion does: fork children, decider/selector
     * branch dispatch (when the decider has its own continuation), and
     * unbounded dynamic recursion. Prevents call-stack overflow on runaway
     * recursive composition.
     */
    _executeDepth = 0;
    /**
     * Memoized parent-chain depth per StageContext. The context tree deepens
     * by one per executed stage along a chain, so the naive parent-walk in
     * `computeContextDepth` is O(chain length) per stage — O(n²) per run once
     * the trampoline allows chains of tens of thousands of stages. Contexts
     * are visited parent-before-child, so the memo makes each lookup O(1)
     * amortized. WeakMap — dies with the traverser.
     */
    contextDepthCache = new WeakMap();
    /**
     * Shared mutable execution counter — monotonic, incremented per stage execution.
     * Shared with child traversers (subflows) so indices are globally unique within a run.
     */
    _executionCounter;
    /**
     * Shared per-run visit counts keyed by stageId — how many times each stage
     * has executed in this run. Shared with child traversers (subflows) so a
     * looped-back stage's iteration count is monotonic across subflow re-mounts,
     * matching the narrative recorder's single-map semantics. Drives
     * `TraversalContext.loopIteration`.
     */
    _visitCounts;
    /**
     * Per-instance maximum depth (set from TraverserOptions.maxDepth or the class default).
     */
    _maxDepth;
    /**
     * Per-instance loop-iteration limit forwarded to the ContinuationResolver
     * and propagated to subflow traversers. Undefined → resolver default (1000).
     */
    _maxIterations;
    /**
     * Default maximum nested executeNode depth before an error is thrown.
     *
     * **What counts as depth (trampoline model):** `executeNode` is an iterative
     * driver — linear `next` hops, loop edges (`loopTo`/dynamic next), and
     * dynamic-subflow re-entry are followed in a flat loop and consume NO depth.
     * Depth grows only with true tree nesting: one tick per fork child, one per
     * decider/selector branch dispatch that must return to its invoker (decider
     * with its own `next`), one per subflow mount frame in the parent (the
     * subflow body itself runs on a FRESH traverser with its own budget).
     *
     * 500 therefore covers any realistic chart — it bounds recursive
     * COMPOSITION, not chain length or loop count. Loops are bounded by
     * `ContinuationResolver`'s independent iteration limit (default 1000,
     * configurable via `RunOptions.maxIterations`), which is now the binding
     * constraint for loop-heavy pipelines.
     *
     * @remarks Not safe for concurrent `.execute()` calls on the same instance — concurrent
     * executions race on `_executeDepth`. Use a separate `FlowchartTraverser` per concurrent
     * execution. `FlowChartExecutor.run()` always creates a fresh traverser per call.
     */
    static MAX_EXECUTE_DEPTH = 500;
    constructor(opts) {
        const maxDepth = opts.maxDepth ?? FlowchartTraverser.MAX_EXECUTE_DEPTH;
        if (maxDepth < 1)
            throw new Error('FlowchartTraverser: maxDepth must be >= 1');
        this._maxDepth = maxDepth;
        if (opts.maxIterations !== undefined && opts.maxIterations < 1) {
            throw new Error('FlowchartTraverser: maxIterations must be >= 1');
        }
        this._maxIterations = opts.maxIterations;
        this._executionCounter = opts.executionCounter ?? { value: 0 };
        this._visitCounts = opts.visitCounts ?? new Map();
        this.root = opts.root;
        // Shallow-copy stageMap and subflows so that lazy-resolution mutations
        // (prefixed entries added during execution) stay scoped to THIS traverser
        // and do not escape to the shared FlowChart object. Without the copy,
        // concurrent FlowChartExecutor runs sharing the same FlowChart would race
        // on these two mutable dictionaries.
        this.stageMap = new Map(opts.stageMap);
        this.executionRuntime = opts.executionRuntime;
        this.subflows = opts.subflows ? { ...opts.subflows } : {};
        this.logger = opts.logger;
        this.signal = opts.signal;
        this.parentSubflowId = opts.parentSubflowId;
        this.parentMountRuntimeStageId = opts.parentMountRuntimeStageId;
        this.readOnlyContext = opts.readOnlyContext;
        this.runId = opts.runId;
        // Structure manager (deep-clones build-time structure)
        this.structureManager = new RuntimeStructureManager();
        this.structureManager.init(opts.buildTimeStructure);
        // Narrative generator
        // Priority: explicit narrativeGenerator > flowRecorders > default NarrativeFlowRecorder > null.
        // Subflow traversers receive the parent's narrativeGenerator so all events flow to one place.
        if (opts.narrativeGenerator) {
            this.narrativeGenerator = opts.narrativeGenerator;
        }
        else if (opts.narrativeEnabled) {
            const dispatcher = new FlowRecorderDispatcher();
            this.flowRecorderDispatcher = dispatcher;
            // If custom FlowRecorders are provided, use them; otherwise attach default NarrativeFlowRecorder
            if (opts.flowRecorders && opts.flowRecorders.length > 0) {
                for (const recorder of opts.flowRecorders) {
                    dispatcher.attach(recorder);
                }
            }
            else {
                dispatcher.attach(new NarrativeFlowRecorder());
            }
            this.narrativeGenerator = dispatcher;
        }
        else {
            this.narrativeGenerator = new NullControlFlowNarrativeGenerator();
        }
        // Build shared deps bag
        const deps = this.createDeps(opts);
        // Build O(1) node ID map from the root graph (avoids repeated DFS on every loopTo())
        const nodeIdMap = this.buildNodeIdMap(opts.root);
        // Initialize handler modules.
        // NodeResolver's DFS fallback resolves loop targets against the LIVE
        // runtime shape, so it reads children through the dynamic-patch overlay
        // (a loop can target a node added by a dynamic StageNode return).
        this.nodeResolver = new NodeResolver(deps, nodeIdMap, (n) => this.effChildren(n));
        this.childrenExecutor = new ChildrenExecutor(deps, this.executeNode.bind(this));
        this.stageRunner = new StageRunner(deps);
        this.continuationResolver = new ContinuationResolver(deps, this.nodeResolver, (nodeId, count) => this.structureManager.updateIterationCount(nodeId, count), this._maxIterations);
        this.deciderHandler = new DeciderHandler(deps);
        this.selectorHandler = new SelectorHandler(deps, this.childrenExecutor);
        this.subflowExecutor = new SubflowExecutor(deps, this.createSubflowTraverserFactory(opts));
    }
    /**
     * Create a factory that produces FlowchartTraverser instances for subflow execution.
     * Captures parent config in closure — SubflowExecutor provides subflow-specific overrides.
     * Each subflow gets a full traverser with all 7 phases (deciders, selectors, loops, etc.).
     */
    createSubflowTraverserFactory(parentOpts) {
        // Capture references to mutable state — factory reads the CURRENT state when called,
        // not the state at factory creation time. This is correct because lazy subflow resolution
        // may add entries to stageMap/subflows before a nested subflow is encountered.
        const parentStageMap = this.stageMap;
        const parentSubflows = this.subflows;
        const narrativeGenerator = this.narrativeGenerator;
        return (subflowOpts) => {
            const traverser = new FlowchartTraverser({
                root: subflowOpts.root,
                stageMap: parentStageMap, // Constructor shallow-copies this
                scopeFactory: parentOpts.scopeFactory,
                executionRuntime: subflowOpts.executionRuntime,
                readOnlyContext: subflowOpts.readOnlyContext,
                executionEnv: parentOpts.executionEnv,
                throttlingErrorChecker: parentOpts.throttlingErrorChecker,
                streamHandlers: parentOpts.streamHandlers,
                scopeProtectionMode: parentOpts.scopeProtectionMode,
                subflows: parentSubflows, // Constructor shallow-copies this
                narrativeGenerator, // Share parent's — all events flow to one place
                logger: parentOpts.logger,
                signal: parentOpts.signal,
                maxDepth: this._maxDepth,
                ...(this._maxIterations !== undefined && { maxIterations: this._maxIterations }),
                parentSubflowId: subflowOpts.subflowId,
                // RFC-003 D1: the mount stage's runtimeStageId — parent fallback for
                // the subflow's root stage so ancestor chains cross the boundary.
                parentMountRuntimeStageId: subflowOpts.parentMountRuntimeStageId,
                executionCounter: this._executionCounter, // Share counter — subflow continues global numbering
                visitCounts: this._visitCounts, // Share visit counts — loopIteration stays monotonic across subflow re-mounts
                runId: this.runId, // Subflow inherits parent's runId — same logical run
                // Forward the resume-only subflow scope captures so nested
                // SubflowExecutors can re-seed deeper-nested runtimes (e.g.
                // Sequence(Agent(...)) where the inner Agent subflow paused).
                ...(parentOpts.subflowStatesForResume && {
                    subflowStatesForResume: parentOpts.subflowStatesForResume,
                }),
            });
            return {
                execute: () => traverser.execute(),
                getSubflowResults: () => traverser.getSubflowResults(),
                getBreakState: () => traverser.getBreakState(),
            };
        };
    }
    createDeps(opts) {
        return {
            stageMap: this.stageMap,
            root: this.root,
            executionRuntime: this.executionRuntime,
            scopeFactory: opts.scopeFactory,
            subflows: this.subflows,
            throttlingErrorChecker: opts.throttlingErrorChecker,
            streamHandlers: opts.streamHandlers,
            scopeProtectionMode: opts.scopeProtectionMode ?? 'error',
            readOnlyContext: opts.readOnlyContext,
            executionEnv: opts.executionEnv,
            narrativeGenerator: this.narrativeGenerator,
            logger: this.logger,
            signal: opts.signal,
            ...(opts.subflowStatesForResume && {
                subflowStatesForResume: opts.subflowStatesForResume,
            }),
        };
    }
    // ─────────────────────── Public API ───────────────────────
    /**
     * Holds the top-level break flag for the duration of `execute()`. Kept as
     * a field (not a local) so `getBreakState()` can surface the final state
     * for callers like `SubflowExecutor` that implement `propagateBreak`.
     */
    _topBreakFlag = { shouldBreak: false };
    async execute(branchPath) {
        const context = this.executionRuntime.rootStageContext;
        this._topBreakFlag = { shouldBreak: false };
        // Fire onRunStart ONLY at the top-level traversal — subflow traversers
        // already produce onSubflowEntry/onSubflowExit pairs, so emitting run
        // events for them would double-bracket the boundary stream. The
        // top-level traverser is the one without a parentSubflowId.
        const isTopLevel = this.parentSubflowId === undefined;
        // Synthetic TraversalContext for run.entry / run.exit. Fields use
        // root-stage defaults (stageId='__root__', runtimeStageId='__root__#0',
        // depth 0) so the runId is reliably available on run events without
        // forcing recorders to handle `traversalContext === undefined`.
        const rootContext = {
            runId: this.runId,
            stageId: '__root__',
            runtimeStageId: '__root__#0',
            stageName: '__root__',
            depth: 0,
        };
        if (isTopLevel) {
            // `readOnlyContext` is the engine's view of `run({input})` — passed
            // through from `FlowChartExecutor.run()` as the validated input.
            this.narrativeGenerator.onRunStart(this.readOnlyContext, rootContext);
        }
        // Top-level runs close their boundary SYMMETRICALLY: every onRunStart
        // is followed by exactly one onRunEnd (clean) or onRunFailed (error).
        // Without the catch, a thrown run fired onRunStart then nothing — a
        // monitor couldn't tell "still running" from "crashed." Pause is NOT
        // an error (it's expected suspension), so it skips onRunFailed and
        // re-throws untouched. The stage-level catch already recorded the
        // failing stage (onError + commit); this adds the run-level terminal
        // signal. The error still propagates — this is observation, not
        // recovery. Subflow traversers don't fire run events; their errors
        // bubble up and surface here at the top level.
        if (!isTopLevel) {
            return this.executeNode(this.root, context, this._topBreakFlag, branchPath ?? '');
        }
        let result;
        try {
            result = await this.executeNode(this.root, context, this._topBreakFlag, branchPath ?? '');
        }
        catch (error) {
            if (!isPauseSignal(error)) {
                this.narrativeGenerator.onRunFailed(extractErrorInfo(error), rootContext);
            }
            throw error;
        }
        this.narrativeGenerator.onRunEnd(result, rootContext);
        return result;
    }
    /**
     * Break state captured at the top-level of the most recent `execute()`.
     * `shouldBreak` is true when a stage called `scope.$break(reason)`; the
     * optional `reason` carries the string passed to `$break`.
     *
     * Used by `SubflowExecutor` to propagate an inner subflow's break up to
     * the parent traverser when the mount sets `propagateBreak: true`.
     */
    getBreakState() {
        return { ...this._topBreakFlag };
    }
    getRuntimeStructure() {
        return this.structureManager.getStructure();
    }
    getSnapshot(options) {
        // Stamp the run's id onto the runtime snapshot here — the traverser is
        // the single authority for `runId` (it already stamps the same value on
        // every TraversalContext/event), while the runtime is run-agnostic
        // memory (its getSnapshot returns Omit<RuntimeSnapshot, 'runId'>).
        // Fresh per run() AND per resume() — see runner/runId.ts.
        return { ...this.executionRuntime.getSnapshot(options), runId: this.runId };
    }
    getRuntime() {
        return this.executionRuntime;
    }
    setRootObject(path, key, value) {
        this.executionRuntime.setRootObject(path, key, value);
    }
    getBranchIds() {
        return this.executionRuntime.getPipelines();
    }
    getRuntimeRoot() {
        return this.root;
    }
    getSubflowResults() {
        return this.subflowResults;
    }
    getNarrative() {
        return this.narrativeGenerator.getSentences();
    }
    /** Returns the FlowRecorderDispatcher, or undefined if narrative is disabled. */
    getFlowRecorderDispatcher() {
        return this.flowRecorderDispatcher;
    }
    // ─────────────────────── Core Traversal ───────────────────────
    /**
     * Build an O(1) ID→node map from the root graph.
     * Used by NodeResolver to avoid repeated DFS on every loopTo() call.
     * Iterative worklist (no recursion) so arbitrarily long chains index fully;
     * the `map.has` guard handles cyclic refs. First-visited node wins per ID —
     * worklist order matches the old recursive pre-order (children, then next).
     * Dynamic subflows and lazy-resolved nodes are added to stageMap at runtime but not to this map —
     * those use the DFS fallback in NodeResolver.
     */
    buildNodeIdMap(root) {
        const map = new Map();
        const stack = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (map.has(node.id))
                continue; // already visited (avoids infinite loops on cyclic refs)
            map.set(node.id, node);
            // Push in reverse visit order (LIFO stack): next first, then children
            // reversed — so children are visited before next, first child first,
            // matching the recursive pre-order exactly.
            if (node.next)
                stack.push(node.next);
            if (node.children) {
                for (let i = node.children.length - 1; i >= 0; i--)
                    stack.push(node.children[i]);
            }
        }
        return map;
    }
    getStageFn(node) {
        if (typeof node.fn === 'function')
            return node.fn;
        // Primary: look up by id (stable identifier, keyed by FlowChartBuilder)
        const byId = this.stageMap.get(node.id);
        if (byId !== undefined)
            return byId;
        // Fallback: look up by name (supports hand-crafted stageMaps in tests and advanced use)
        return this.stageMap.get(node.name);
    }
    // ─────────────── Dynamic-patch overlay accessors ───────────────
    //
    // Every engine read of a field that Phase 4 can patch (children,
    // nextNodeSelector, subflow meta) goes through these. Fast path: charts
    // with no dynamic returns never allocate and pay one `size === 0` check.
    getPatch(node) {
        if (this.patchCount === 0)
            return undefined;
        return this.dynamicPatches.get(node);
    }
    getOrCreatePatch(node) {
        let patch = this.dynamicPatches.get(node);
        if (!patch) {
            patch = {};
            this.dynamicPatches.set(node, patch);
            this.patchCount++;
        }
        return patch;
    }
    /** Effective children: dynamic patch first, then the built node's children. */
    effChildren(node) {
        return this.getPatch(node)?.children ?? node.children;
    }
    /** Effective output-based selector: dynamic patch first, then the built node's. */
    effSelector(node) {
        return this.getPatch(node)?.nextNodeSelector ?? node.nextNodeSelector;
    }
    /** Effective subflow-root marker (true when a dynamic subflow was patched on). */
    effIsSubflowRoot(node) {
        const meta = this.getPatch(node)?.subflowMeta;
        return meta ? true : node.isSubflowRoot;
    }
    /** Effective subflow id (patched verbatim by a dynamic subflow return). */
    effSubflowId(node) {
        const meta = this.getPatch(node)?.subflowMeta;
        return meta ? meta.subflowId : node.subflowId;
    }
    /**
     * Materialize the effective view of a node — field-identical to what the
     * pre-overlay code produced by mutating the shared node. Used where a node
     * is handed to a helper executor (NodeResolver / SubflowExecutor /
     * ChildrenExecutor) so helpers never read stale built fields. Returns the
     * node itself (no allocation) when it carries no patch.
     */
    effNode(node) {
        const patch = this.getPatch(node);
        if (!patch)
            return node;
        const merged = { ...node };
        if (patch.subflowMeta) {
            merged.isSubflowRoot = true;
            merged.subflowId = patch.subflowMeta.subflowId;
            merged.subflowName = patch.subflowMeta.subflowName;
            merged.subflowMountOptions = patch.subflowMeta.subflowMountOptions;
        }
        if (patch.children)
            merged.children = patch.children;
        if (patch.nextNodeSelector)
            merged.nextNodeSelector = patch.nextNodeSelector;
        return merged;
    }
    async executeStage(node, stageFunc, context, breakFn) {
        // runtimeStageId is assigned in executeNode() before traversalContext creation,
        // ensuring scope events and flow events use the same value.
        return this.stageRunner.run(node, stageFunc, context, breakFn);
    }
    /**
     * Trampoline driver — pre-order DFS traversal entry point.
     *
     * Runs `executeNodeStep` (one node, all 7 phases) in a flat loop: every
     * TAIL continuation (linear `next`, loop edge, dynamic next / dynamic
     * re-entry, no-continuation decider dispatch) comes back as a
     * `ContinuationHop` and is followed ITERATIVELY — neither the call stack
     * nor the retained promise chain grows with chain length or loop count.
     *
     * Recursion remains ONLY for true tree nesting (each gets a nested driver
     * call): fork children (`ChildrenExecutor`), selector branches (parallel
     * fan-out), decider branch dispatch when the decider has its own `next`
     * (the branch must complete BEFORE the decider's continuation runs), and
     * subflow mounts (fresh traverser; the mount frame stays in the parent).
     * `_executeDepth` therefore counts chart COMPOSITION depth only, guarded
     * by `_maxDepth` (default `MAX_EXECUTE_DEPTH` = 500).
     *
     * PauseSignal: a flat decider dispatch records an `InvokerStamp`; if the
     * continued chain later pauses, the driver stamps the signal during
     * unwind — same invoker context the recursive dispatch's catch used to
     * stamp, innermost (most recent dispatch) first.
     */
    async executeNode(node, context, breakFlag, branchPath) {
        // Invoker stamps from flat decider dispatches in THIS driver — kept
        // local so nested drivers (fork children, with-next decider branches)
        // get their own windows, matching the old frame-on-stack stamping scope.
        let pendingInvokers;
        // ─── Tree-depth guard ───
        // The increment is inside `try` so `finally` always decrements — no
        // fragile gap between check and try entry.
        try {
            if (++this._executeDepth > this._maxDepth) {
                throw new Error(`FlowchartTraverser: maximum traversal depth exceeded (${this._maxDepth}). ` +
                    'Depth counts NESTED dispatch (fork children, decider/selector branches, recursive composition) — ' +
                    'linear chains and loop iterations run flat and do not consume it. ' +
                    `Last stage: '${node.name}'. ` +
                    'Check for unbounded recursive chart composition, or raise the limit via RunOptions.maxDepth.');
            }
            let current = { [CONTINUE_HOP]: true, node, context, branchPath };
            for (;;) {
                const result = await this.executeNodeStep(current.node, current.context, breakFlag, current.branchPath);
                if (!isContinuationHop(result)) {
                    return result;
                }
                if (result.invokerStamp)
                    (pendingInvokers ??= []).push(result.invokerStamp);
                current = result;
            }
        }
        catch (error) {
            // Replay invoker stamps most-recent-first. `setInvoker` is
            // first-write-wins, so the innermost dispatch's stamp lands — exactly
            // the old bubble-up order through nested catch frames.
            if (pendingInvokers !== undefined && isPauseSignal(error)) {
                for (let i = pendingInvokers.length - 1; i >= 0; i--) {
                    error.setInvoker(pendingInvokers[i].invokerStageId, pendingInvokers[i].continuationStageId);
                }
            }
            throw error;
        }
        finally {
            this._executeDepth--;
        }
    }
    /** Build a flat continuation hop for the driver loop. */
    hop(node, context, branchPath, invokerStamp) {
        return { [CONTINUE_HOP]: true, node, context, branchPath, ...(invokerStamp && { invokerStamp }) };
    }
    /**
     * Execute ONE node through all 7 phases — the old recursive `executeNode`
     * body; only the tail calls became `ContinuationHop` returns. Returns the
     * node's result, or a hop for the driver loop to follow.
     */
    async executeNodeStep(node, context, breakFlag, branchPath) {
        // Attach builder metadata to context for snapshot enrichment.
        // Subflow meta reads go through the dynamic-patch overlay — a node
        // patched by a dynamic-subflow return re-enters executeNode and must
        // classify as a subflow without the shared node ever being mutated.
        if (node.description)
            context.description = node.description;
        const effSubflowId = this.effSubflowId(node);
        if (this.effIsSubflowRoot(node) && effSubflowId)
            context.subflowId = effSubflowId;
        // Assign runtimeStageId BEFORE traversalContext creation — ensures scope events
        // (buffered by runtimeStageId) and flow events (flushed by traversalContext.runtimeStageId)
        // use the same value. Must happen before executeStage AND before traversalContext.
        const idx = this._executionCounter.value++;
        context.runtimeStageId = buildRuntimeStageId(node.id, idx);
        // RFC-003 D1: runtime parent — the previous execution step's runtimeStageId.
        // Falls back to the subflow MOUNT's runtimeStageId for the subflow root
        // stage (its StageContext is created fresh with no parent), so runtime
        // ancestor chains cross subflow boundaries. `||` (not `??`) on purpose:
        // a parent context that never executed still carries the field's
        // initial `''`, which must also fall through to the mount fallback.
        const parentRuntimeStageId = context.parent?.runtimeStageId || this.parentMountRuntimeStageId;
        // loopIteration — how many times THIS stage has run before in this run.
        // Keyed by the same stageId we stamp on the context (and the same value the
        // narrative recorder counts on), run-scoped and shared across subflow
        // re-mounts via `_visitCounts`. undefined on the first visit; 1 on the
        // first loop-back, 2 on the next, … — i.e. visitCount - 1. Counted for
        // EVERY stage kind (any node can be a loop target), unlike the narrative
        // recorder which only renders it for linear stages.
        const contextStageId = node.id ?? context.stageId;
        const visitCount = (this._visitCounts.get(contextStageId) ?? 0) + 1;
        this._visitCounts.set(contextStageId, visitCount);
        const loopIteration = visitCount > 1 ? visitCount - 1 : undefined;
        // Build traversal context for recorder events — created once per stage, shared by all events
        const traversalContext = {
            runId: this.runId,
            stageId: contextStageId,
            runtimeStageId: context.runtimeStageId,
            stageName: node.name,
            parentStageId: context.parent?.stageId,
            ...(parentRuntimeStageId && { parentRuntimeStageId }),
            ...(loopIteration !== undefined && { loopIteration }),
            subflowId: context.subflowId ?? this.parentSubflowId,
            subflowPath: branchPath || undefined,
            depth: this.computeContextDepth(context),
        };
        // ─── Phase 0a: LAZY RESOLVE — deferred subflow resolution ───
        // Guard uses the per-traverser resolvedLazySubflows set (not the shared node) so
        // concurrent traversers do not race on node.subflowResolver or clear it for each other.
        if (node.isSubflowRoot && node.subflowResolver && !this.resolvedLazySubflows.has(node.subflowId)) {
            const resolved = node.subflowResolver();
            const prefixedRoot = this.prefixNodeTree(resolved.root, node.subflowId);
            // Register the resolved subflow (same path as eager registration)
            this.subflows[node.subflowId] = { root: prefixedRoot };
            // Merge stageMap entries
            for (const [key, fn] of resolved.stageMap) {
                const prefixedKey = `${node.subflowId}/${key}`;
                if (!this.stageMap.has(prefixedKey)) {
                    this.stageMap.set(prefixedKey, fn);
                }
            }
            // Merge nested subflows
            if (resolved.subflows) {
                for (const [key, def] of Object.entries(resolved.subflows)) {
                    const prefixedKey = `${node.subflowId}/${key}`;
                    if (!this.subflows[prefixedKey]) {
                        this.subflows[prefixedKey] = def;
                    }
                }
            }
            // Update runtime structure with the now-resolved spec
            this.structureManager.updateDynamicSubflow(node.id, node.subflowId, node.subflowName, resolved.buildTimeStructure);
            // Mark as resolved for THIS traverser — per-traverser set prevents re-entry
            // without mutating the shared StageNode graph (which would race concurrent traversers).
            this.resolvedLazySubflows.add(node.subflowId);
        }
        // ─── Phase 0: CLASSIFY — subflow detection ───
        if (this.effIsSubflowRoot(node) && effSubflowId) {
            // Hand helpers the EFFECTIVE node view (built fields + dynamic patch)
            // so SubflowExecutor/NodeResolver never read stale built fields.
            const mountNode = this.effNode(node);
            const resolvedNode = this.nodeResolver.resolveSubflowReference(mountNode);
            const subflowOutput = await this.subflowExecutor.executeSubflow(resolvedNode, context, breakFlag, branchPath, this.subflowResults, traversalContext);
            const isReferenceBasedSubflow = resolvedNode !== mountNode;
            const hasChildren = Boolean(mountNode.children && mountNode.children.length > 0);
            const shouldExecuteContinuation = isReferenceBasedSubflow || hasChildren;
            // ─── Break-flag check AFTER subflow returns ───
            // If the subflow was mounted with `propagateBreak: true` and broke
            // internally, `SubflowExecutor` has already flipped our breakFlag.
            // Stop the outer traversal here — do not run the next linear stage.
            if (breakFlag.shouldBreak) {
                return subflowOutput;
            }
            if (node.next && shouldExecuteContinuation) {
                const nextCtx = context.createNext(branchPath, node.next.name, node.next.id);
                return this.hop(node.next, nextCtx, branchPath);
            }
            return subflowOutput;
        }
        const stageFunc = this.getStageFn(node);
        const hasStageFunction = Boolean(stageFunc);
        const isScopeBasedDecider = Boolean(node.deciderFn);
        const isScopeBasedSelector = Boolean(node.selectorFn);
        const isDeciderNode = isScopeBasedDecider;
        const hasChildren = Boolean(this.effChildren(node)?.length);
        // `next` is never overlaid — a dynamic next applies only to the visit
        // that produced it (handled via the `dynamicNext` local below), so the
        // built chart's next is always the correct continuation here.
        const hasNext = Boolean(node.next);
        const originalNext = node.next;
        // ─── Phase 1: VALIDATE — node invariants ───
        if (!hasStageFunction && !isDeciderNode && !isScopeBasedSelector && !hasChildren) {
            const errorMessage = `Node '${node.name}' must define: embedded fn OR a stageMap entry OR have children/decider`;
            this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
            throw new Error(errorMessage);
        }
        if (isDeciderNode && !hasChildren) {
            const errorMessage = 'Decider node needs to have children to execute';
            this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
            throw new Error(errorMessage);
        }
        if (isScopeBasedSelector && !hasChildren) {
            const errorMessage = 'Selector node needs to have children to execute';
            this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
            throw new Error(errorMessage);
        }
        // Role markers for debug panels
        if (!hasStageFunction) {
            if (isDeciderNode)
                context.setAsDecider();
            else if (hasChildren)
                context.setAsFork();
        }
        // Break handler wired to the scope. Captures the optional reason
        // passed via `scope.$break(reason)` and parks it on the breakFlag so
        // downstream code (FlowRecorder.onBreak, subflow propagation) can
        // surface it. A second $break call in the same stage keeps the FIRST
        // reason — first-break-wins — matching the "execution stopped" story.
        const breakFn = (reason) => {
            breakFlag.shouldBreak = true;
            if (reason !== undefined && breakFlag.reason === undefined) {
                breakFlag.reason = reason;
            }
        };
        // ─── Phase 2a: SELECTOR — scope-based multi-choice ───
        if (isScopeBasedSelector) {
            const selectorResult = await this.selectorHandler.handleScopeBased(node, stageFunc, context, breakFlag, branchPath, this.executeStage.bind(this), this.executeNode.bind(this), traversalContext);
            if (hasNext) {
                const nextCtx = context.createNext(branchPath, node.next.name, node.next.id);
                return this.hop(node.next, nextCtx, branchPath);
            }
            return selectorResult;
        }
        // ─── Phase 2b: DECIDER — scope-based single-choice conditional branch ───
        if (isDeciderNode) {
            const dispatch = await this.deciderHandler.prepareDispatch(node, stageFunc, context, breakFlag, branchPath, this.executeStage.bind(this), traversalContext);
            // No decider-level continuation → the branch dispatch is a tail
            // call. Hand it to the driver as a flat hop so loop-heavy decider
            // charts (e.g. agent ReAct loops with branch-sourced `loopTo`) stay
            // flat-stacked. The invoker stamp preserves PauseSignal semantics —
            // the decider is the invoker of whatever pauses in the chain.
            if (!hasNext && dispatch.kind === 'dispatch') {
                return this.hop(dispatch.chosen, dispatch.branchContext, branchPath, {
                    invokerStageId: node.id,
                    continuationStageId: node.next?.id,
                });
            }
            // Decider WITH its own next: the branch chain must complete BEFORE
            // the decider's continuation runs — true tree nesting, kept
            // recursive (a nested driver). Mirrors handleScopeBased exactly,
            // including the PauseSignal invoker stamp on bubble-up.
            let deciderResult;
            if (dispatch.kind === 'break') {
                deciderResult = dispatch.branchId;
            }
            else {
                try {
                    deciderResult = await this.executeNode(dispatch.chosen, dispatch.branchContext, breakFlag, branchPath);
                }
                catch (error) {
                    if (isPauseSignal(error)) {
                        error.setInvoker(node.id, node.next?.id);
                    }
                    throw error;
                }
            }
            // After branch execution, follow decider's own next (e.g., loopTo target)
            if (hasNext && !breakFlag.shouldBreak) {
                const nextNode = originalNext;
                // Use the isLoopRef flag set by loopTo() — do not rely on stageMap absence,
                // since id-keyed stageMaps would otherwise cause loop targets to be executed directly.
                const isLoopRef = nextNode.isLoopRef === true ||
                    (!this.getStageFn(nextNode) &&
                        !this.effChildren(nextNode)?.length &&
                        !nextNode.deciderFn &&
                        !nextNode.selectorFn &&
                        !this.effIsSubflowRoot(nextNode));
                if (isLoopRef) {
                    const target = this.continuationResolver.resolveTarget(nextNode, node, context, branchPath);
                    return this.hop(target.node, target.context, branchPath);
                }
                this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
                const nextCtx = context.createNext(branchPath, nextNode.name, nextNode.id);
                return this.hop(nextNode, nextCtx, branchPath);
            }
            return deciderResult;
        }
        // ─── Abort check — cooperative cancellation ───
        if (this.signal?.aborted) {
            const reason = this.signal.reason instanceof Error ? this.signal.reason : new Error(this.signal.reason ?? 'Aborted');
            throw reason;
        }
        // ─── Phase 3: EXECUTE — run stage function ───
        let stageOutput;
        let dynamicNext;
        if (stageFunc) {
            try {
                stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
            }
            catch (error) {
                // PauseSignal is expected control flow, not an error — fire narrative, commit, re-throw.
                if (isPauseSignal(error)) {
                    context.commit();
                    this.narrativeGenerator.onPause(node.name, node.id, error.pauseData, error.subflowPath, traversalContext);
                    throw error;
                }
                context.commit();
                this.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
                this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
                context.addError('stageExecutionError', error.toString());
                throw error;
            }
            context.commit();
            this.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'linear');
            if (breakFlag.shouldBreak) {
                // Forward the optional reason captured on breakFlag — set by the
                // stage's $break(reason) call OR by a subflow's propagateBreak.
                this.narrativeGenerator.onBreak(node.name, traversalContext, breakFlag.reason);
                return stageOutput;
            }
            // ─── Phase 4: DYNAMIC — StageNode return detection ───
            if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
                const dynamicNode = stageOutput;
                context.addLog('isDynamic', true);
                context.addLog('dynamicPattern', 'StageNodeReturn');
                // Dynamic subflow auto-registration. The subflow meta lands in the
                // traverser-local overlay (NOT on the shared node); the immediate
                // executeNode re-entry sees it through the eff* accessors and
                // classifies the node as a subflow mount in Phase 0.
                if (dynamicNode.isSubflowRoot && dynamicNode.subflowDef && dynamicNode.subflowId) {
                    context.addLog('dynamicPattern', 'dynamicSubflow');
                    context.addLog('dynamicSubflowId', dynamicNode.subflowId);
                    this.autoRegisterSubflowDef(dynamicNode.subflowId, dynamicNode.subflowDef, node.id);
                    this.getOrCreatePatch(node).subflowMeta = {
                        isSubflowRoot: true,
                        subflowId: dynamicNode.subflowId,
                        subflowName: dynamicNode.subflowName,
                        subflowMountOptions: dynamicNode.subflowMountOptions,
                    };
                    this.structureManager.updateDynamicSubflow(node.id, dynamicNode.subflowId, dynamicNode.subflowName, dynamicNode.subflowDef?.buildTimeStructure);
                    // Re-enter THIS node (same context): the overlay patch makes the
                    // next step classify it as a subflow mount in Phase 0.
                    return this.hop(node, context, branchPath);
                }
                // Check children for subflowDef
                if (dynamicNode.children) {
                    for (const child of dynamicNode.children) {
                        if (child.isSubflowRoot && child.subflowDef && child.subflowId) {
                            this.autoRegisterSubflowDef(child.subflowId, child.subflowDef, child.id);
                            this.structureManager.updateDynamicSubflow(child.id, child.subflowId, child.subflowName, child.subflowDef?.buildTimeStructure);
                        }
                    }
                }
                // Dynamic children (fork pattern) — patched into the overlay;
                // Phase 5 below reads them back through effChildren/effSelector.
                if (dynamicNode.children && dynamicNode.children.length > 0) {
                    this.getOrCreatePatch(node).children = dynamicNode.children;
                    context.addLog('dynamicChildCount', dynamicNode.children.length);
                    context.addLog('dynamicChildIds', dynamicNode.children.map((c) => c.id));
                    this.structureManager.updateDynamicChildren(node.id, dynamicNode.children, Boolean(dynamicNode.nextNodeSelector), Boolean(dynamicNode.deciderFn));
                    if (typeof dynamicNode.nextNodeSelector === 'function') {
                        this.getOrCreatePatch(node).nextNodeSelector = dynamicNode.nextNodeSelector;
                        context.addLog('hasSelector', true);
                    }
                }
                // Dynamic next (linear continuation) — stays a LOCAL: it applies
                // only to this visit (Phase 6 routes it through the
                // ContinuationResolver), so the shared node's next is never touched
                // and a loop revisit naturally sees the built continuation.
                if (dynamicNode.next) {
                    dynamicNext = dynamicNode.next;
                    this.structureManager.updateDynamicNext(node.id, dynamicNode.next);
                    context.addLog('hasDynamicNext', true);
                }
                stageOutput = undefined;
            }
        }
        // ─── Phase 5: CHILDREN — fork dispatch ───
        // Re-read through the overlay: Phase 4 may have just patched dynamic
        // children/selector for THIS visit (or an earlier visit in this run).
        const childrenAfterStage = this.effChildren(node);
        const hasChildrenAfterStage = Boolean(childrenAfterStage?.length);
        if (hasChildrenAfterStage) {
            context.addLog('totalChildren', childrenAfterStage?.length);
            context.addLog('orderOfExecution', 'ChildrenAfterStage');
            let nodeChildrenResults;
            const effSelectorFn = this.effSelector(node);
            if (effSelectorFn) {
                nodeChildrenResults = await this.childrenExecutor.executeSelectedChildren(effSelectorFn, childrenAfterStage, stageOutput, context, branchPath, traversalContext, node.failFast);
            }
            else {
                const childCount = childrenAfterStage?.length ?? 0;
                const childNames = childrenAfterStage?.map((c) => c.name).join(', ');
                context.addFlowDebugMessage('children', `Executing all ${childCount} children in parallel: ${childNames}`, {
                    count: childCount,
                    targetStage: childrenAfterStage?.map((c) => c.name),
                });
                // effNode: ChildrenExecutor reads node.children/node.failFast itself.
                nodeChildrenResults = await this.childrenExecutor.executeNodeChildren(this.effNode(node), context, undefined, branchPath, traversalContext);
            }
            // Fork-only: return bundle
            if (!hasNext && !dynamicNext) {
                return nodeChildrenResults;
            }
            // Capture dynamic children as synthetic subflow result for UI
            const isDynamic = context.debug?.logContext?.isDynamic;
            if (isDynamic && childrenAfterStage && childrenAfterStage.length > 0) {
                this.captureDynamicChildrenResult(node, childrenAfterStage, context);
            }
        }
        // ─── Phase 6: CONTINUE — dynamic next / linear next ───
        if (dynamicNext) {
            const target = this.continuationResolver.resolveTarget(dynamicNext, node, context, branchPath);
            return this.hop(target.node, target.context, branchPath);
        }
        if (hasNext) {
            const nextNode = originalNext;
            // Detect loop reference nodes created by loopTo() — marked with isLoopRef flag.
            // Route through ContinuationResolver for proper ID resolution, iteration
            // tracking, and narrative generation. The resolved target comes back
            // as a hop — loop edges consume no stack, so the iteration limit
            // (not call-stack depth) is what bounds a loop.
            const isLoopReference = nextNode.isLoopRef;
            if (isLoopReference) {
                const target = this.continuationResolver.resolveTarget(nextNode, node, context, branchPath, traversalContext);
                return this.hop(target.node, target.context, branchPath);
            }
            this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
            context.addFlowDebugMessage('next', `Moving to ${nextNode.name} stage`, {
                targetStage: nextNode.name,
            });
            const nextCtx = context.createNext(branchPath, nextNode.name, nextNode.id);
            return this.hop(nextNode, nextCtx, branchPath);
        }
        // ─── Phase 7: LEAF — no continuation ───
        return stageOutput;
    }
    // ─────────────────────── Private Helpers ───────────────────────
    captureDynamicChildrenResult(node, children, context) {
        const parentStageId = context.getStageId();
        const childStructure = {
            id: `${node.id}-children`,
            name: 'Dynamic Children',
            type: 'fork',
            children: children.map((c) => ({
                id: c.id,
                name: c.name,
                type: 'stage',
            })),
        };
        const childStages = {};
        if (context.children) {
            for (const childCtx of context.children) {
                const snapshot = childCtx.getSnapshot();
                childStages[snapshot.name || snapshot.id] = {
                    name: snapshot.name,
                    output: snapshot.logs,
                    errors: snapshot.errors,
                    metrics: snapshot.metrics,
                    status: snapshot.errors && Object.keys(snapshot.errors).length > 0 ? 'error' : 'success',
                };
            }
        }
        this.subflowResults.set(node.id, {
            subflowId: node.id,
            subflowName: node.name,
            treeContext: {
                globalContext: {},
                stageContexts: childStages,
                history: [],
            },
            parentStageId,
            pipelineStructure: childStructure,
        });
    }
    /**
     * Parent-chain length of a StageContext — same value the pre-trampoline
     * walk produced, memoized. The context tree deepens by one per executed
     * stage along a chain, so the naive walk is O(chain length) per stage —
     * O(n²) per run once chains reach trampoline scale. Contexts are visited
     * parent-before-child, so the cached parent makes this O(1) amortized.
     */
    computeContextDepth(context) {
        const cached = this.contextDepthCache.get(context);
        if (cached !== undefined)
            return cached;
        // Walk up to the nearest cached ancestor (or the root), then fill the
        // cache back down — iterative, so a cold deep chain can't overflow.
        const uncached = [];
        let depth = -1; // depth of the node ABOVE the first uncached entry
        let current = context;
        while (current) {
            const hit = this.contextDepthCache.get(current);
            if (hit !== undefined) {
                depth = hit;
                break;
            }
            uncached.push(current);
            current = current.parent;
        }
        for (let i = uncached.length - 1; i >= 0; i--) {
            depth++;
            this.contextDepthCache.set(uncached[i], depth);
        }
        return depth;
    }
    prefixNodeTree(node, prefix) {
        if (!node)
            return node;
        const clone = { ...node };
        clone.name = `${prefix}/${node.name}`;
        clone.id = `${prefix}/${clone.id}`;
        if (clone.subflowId)
            clone.subflowId = `${prefix}/${clone.subflowId}`;
        if (clone.next)
            clone.next = this.prefixNodeTree(clone.next, prefix);
        if (clone.children) {
            clone.children = clone.children.map((c) => this.prefixNodeTree(c, prefix));
        }
        return clone;
    }
    autoRegisterSubflowDef(subflowId, subflowDef, mountNodeId) {
        // this.subflows is always initialized in the constructor; the null guard below is unreachable.
        const subflowsDict = this.subflows;
        // First-write-wins
        const isNewRegistration = !subflowsDict[subflowId];
        if (isNewRegistration && subflowDef.root) {
            subflowsDict[subflowId] = {
                root: subflowDef.root,
                ...(subflowDef.buildTimeStructure ? { buildTimeStructure: subflowDef.buildTimeStructure } : {}),
            };
        }
        // Merge stageMap entries (parent entries preserved)
        if (subflowDef.stageMap) {
            for (const [key, fn] of Array.from(subflowDef.stageMap.entries())) {
                if (!this.stageMap.has(key)) {
                    this.stageMap.set(key, fn);
                }
            }
        }
        // Merge nested subflows
        if (subflowDef.subflows) {
            for (const [key, def] of Object.entries(subflowDef.subflows)) {
                if (!subflowsDict[key]) {
                    subflowsDict[key] = def;
                }
            }
        }
        if (mountNodeId) {
            this.structureManager.updateDynamicSubflow(mountNodeId, subflowId, subflowDef.root?.subflowName || subflowDef.root?.name, subflowDef.buildTimeStructure);
        }
        // Notify FlowRecorders only on first registration (matches first-write-wins)
        if (isNewRegistration) {
            const subflowName = subflowDef.root?.subflowName || subflowDef.root?.name || subflowId;
            this.narrativeGenerator.onSubflowRegistered(subflowId, subflowName, subflowDef.root?.description, subflowDef.buildTimeStructure);
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd2NoYXJ0VHJhdmVyc2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvdHJhdmVyc2FsL0Zsb3djaGFydFRyYXZlcnNlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXNCRztBQUdILE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUVyRCxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUMxRCxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUMxRCxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxpQ0FBaUMsQ0FBQztBQUNuRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxxQ0FBcUMsQ0FBQztBQUMzRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDL0QsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLDZCQUE2QixDQUFDO0FBQzNELE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQ2pGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxnQ0FBZ0MsQ0FBQztBQUNqRSxPQUFPLEVBQUUsV0FBVyxFQUFFLE1BQU0sNEJBQTRCLENBQUM7QUFDekQsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLGdDQUFnQyxDQUFDO0FBRWpFLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQ2hGLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHVDQUF1QyxDQUFDO0FBQzlFLE9BQU8sRUFBRSxpQ0FBaUMsRUFBRSxNQUFNLG1EQUFtRCxDQUFDO0FBRXRHLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBOEgzRDs7OztHQUlHO0FBQ0gsTUFBTSxZQUFZLEdBQWtCLE1BQU0sQ0FBQyxr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QUUsV0FBVyxJQUFJLFVBQVUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUNyRCxVQUFVLENBQUMsa0JBQWtCLENBQzlCLENBQUM7UUFDSixDQUFDO1FBRUQsNkVBQTZFO1FBQzdFLElBQUksaUJBQWlCLEVBQUUsQ0FBQztZQUN0QixNQUFNLFdBQVcsR0FBRyxVQUFVLENBQUMsSUFBSSxFQUFFLFdBQVcsSUFBSSxVQUFVLENBQUMsSUFBSSxFQUFFLElBQUksSUFBSSxTQUFTLENBQUM7WUFDdkYsSUFBSSxDQUFDLGtCQUFrQixDQUFDLG1CQUFtQixDQUN6QyxTQUFTLEVBQ1QsV0FBVyxFQUNYLFVBQVUsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUM1QixVQUFVLENBQUMsa0JBQWtCLENBQzlCLENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRmxvd2NoYXJ0VHJhdmVyc2VyIOKAlCBQcmUtb3JkZXIgREZTIHRyYXZlcnNhbCBvZiBTdGFnZU5vZGUgZ3JhcGguXG4gKlxuICogVW5pZmllZCB0cmF2ZXJzYWwgYWxnb3JpdGhtIGZvciBhbGwgbm9kZSBzaGFwZXMuIGBleGVjdXRlTm9kZWAgaXMgYVxuICogVFJBTVBPTElORSBkcml2ZXI6IGl0IHJ1bnMgYGV4ZWN1dGVOb2RlU3RlcGAgKG9uZSBub2RlLCBhbGwgNyBwaGFzZXMpIGluXG4gKiBhIGZsYXQgbG9vcCwgZm9sbG93aW5nIHRhaWwgY29udGludWF0aW9ucyAobGluZWFyIGBuZXh0YCwgbG9vcCBlZGdlcyxcbiAqIGR5bmFtaWMgbmV4dCwgZmxhdCBkZWNpZGVyIGRpc3BhdGNoKSBpdGVyYXRpdmVseSDigJQgc28gY2hhaW4gbGVuZ3RoIGFuZFxuICogbG9vcCBpdGVyYXRpb25zIG5ldmVyIGdyb3cgdGhlIGNhbGwgc3RhY2suIE9ubHkgdHJ1ZSB0cmVlIG5lc3RpbmcgKGZvcmtcbiAqIGNoaWxkcmVuLCB3aXRoLWNvbnRpbnVhdGlvbiBkZWNpZGVyL3NlbGVjdG9yIGJyYW5jaGVzLCBzdWJmbG93IG1vdW50cylcbiAqIHJlY3Vyc2VzLlxuICpcbiAqIEZvciBlYWNoIG5vZGUsIGV4ZWN1dGVOb2RlU3RlcCBmb2xsb3dzIDcgcGhhc2VzOlxuICogICAwLiBDTEFTU0lGWSAg4oCUIHN1YmZsb3cgZGV0ZWN0aW9uLCBlYXJseSBkZWxlZ2F0aW9uXG4gKiAgIDEuIFZBTElEQVRFICDigJQgbm9kZSBpbnZhcmlhbnRzLCByb2xlIG1hcmtlcnNcbiAqICAgMi4gRVhFQ1VURSAgIOKAlCBydW4gc3RhZ2UgZm4sIGNvbW1pdCwgYnJlYWsgY2hlY2tcbiAqICAgMy4gRFlOQU1JQyAgIOKAlCBTdGFnZU5vZGUgcmV0dXJuIGRldGVjdGlvbiwgc3ViZmxvdyBhdXRvLXJlZ2lzdHJhdGlvbiwgc3RydWN0dXJlIHVwZGF0ZXNcbiAqICAgNC4gQ0hJTERSRU4gIOKAlCBmb3JrL3NlbGVjdG9yL2RlY2lkZXIgZGlzcGF0Y2hcbiAqICAgNS4gQ09OVElOVUUgIOKAlCBkeW5hbWljIG5leHQgLyBsaW5lYXIgbmV4dCByZXNvbHV0aW9uXG4gKiAgIDYuIExFQUYgICAgICDigJQgbm8gY29udGludWF0aW9uLCByZXR1cm4gb3V0cHV0XG4gKlxuICogQnJlYWsgc2VtYW50aWNzOiBJZiBhIHN0YWdlIGNhbGxzIGJyZWFrRm4oKSwgY29tbWl0IGFuZCBTVE9QLlxuICogUGF0Y2ggbW9kZWw6IFN0YWdlIHdyaXRlcyBpbnRvIGxvY2FsIHBhdGNoOyBjb21taXRQYXRjaCgpIGFmdGVyIHJldHVybiBvciB0aHJvdy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFN0YWdlQ29udGV4dCB9IGZyb20gJy4uLy4uL21lbW9yeS9TdGFnZUNvbnRleHQuanMnO1xuaW1wb3J0IHsgaXNQYXVzZVNpZ25hbCB9IGZyb20gJy4uLy4uL3BhdXNlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgU2NvcGVQcm90ZWN0aW9uTW9kZSB9IGZyb20gJy4uLy4uL3Njb3BlL3Byb3RlY3Rpb24vdHlwZXMuanMnO1xuaW1wb3J0IHsgZXh0cmFjdEVycm9ySW5mbyB9IGZyb20gJy4uL2Vycm9ycy9lcnJvckluZm8uanMnO1xuaW1wb3J0IHsgaXNTdGFnZU5vZGVSZXR1cm4gfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHsgQ2hpbGRyZW5FeGVjdXRvciB9IGZyb20gJy4uL2hhbmRsZXJzL0NoaWxkcmVuRXhlY3V0b3IuanMnO1xuaW1wb3J0IHsgQ29udGludWF0aW9uUmVzb2x2ZXIgfSBmcm9tICcuLi9oYW5kbGVycy9Db250aW51YXRpb25SZXNvbHZlci5qcyc7XG5pbXBvcnQgeyBEZWNpZGVySGFuZGxlciB9IGZyb20gJy4uL2hhbmRsZXJzL0RlY2lkZXJIYW5kbGVyLmpzJztcbmltcG9ydCB7IE5vZGVSZXNvbHZlciB9IGZyb20gJy4uL2hhbmRsZXJzL05vZGVSZXNvbHZlci5qcyc7XG5pbXBvcnQgeyBSdW50aW1lU3RydWN0dXJlTWFuYWdlciB9IGZyb20gJy4uL2hhbmRsZXJzL1J1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyLmpzJztcbmltcG9ydCB7IFNlbGVjdG9ySGFuZGxlciB9IGZyb20gJy4uL2hhbmRsZXJzL1NlbGVjdG9ySGFuZGxlci5qcyc7XG5pbXBvcnQgeyBTdGFnZVJ1bm5lciB9IGZyb20gJy4uL2hhbmRsZXJzL1N0YWdlUnVubmVyLmpzJztcbmltcG9ydCB7IFN1YmZsb3dFeGVjdXRvciB9IGZyb20gJy4uL2hhbmRsZXJzL1N1YmZsb3dFeGVjdXRvci5qcyc7XG5pbXBvcnQgdHlwZSB7IEJyZWFrRmxhZyB9IGZyb20gJy4uL2hhbmRsZXJzL3R5cGVzLmpzJztcbmltcG9ydCB7IEZsb3dSZWNvcmRlckRpc3BhdGNoZXIgfSBmcm9tICcuLi9uYXJyYXRpdmUvRmxvd1JlY29yZGVyRGlzcGF0Y2hlci5qcyc7XG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9uYXJyYXRpdmUvTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB7IE51bGxDb250cm9sRmxvd05hcnJhdGl2ZUdlbmVyYXRvciB9IGZyb20gJy4uL25hcnJhdGl2ZS9OdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93UmVjb3JkZXIsIElDb250cm9sRmxvd05hcnJhdGl2ZSwgVHJhdmVyc2FsQ29udGV4dCB9IGZyb20gJy4uL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBidWlsZFJ1bnRpbWVTdGFnZUlkIH0gZnJvbSAnLi4vcnVudGltZVN0YWdlSWQuanMnO1xuaW1wb3J0IHR5cGUge1xuICBIYW5kbGVyRGVwcyxcbiAgSUV4ZWN1dGlvblJ1bnRpbWUsXG4gIElMb2dnZXIsXG4gIE5vZGVSZXN1bHRUeXBlLFxuICBTY29wZUZhY3RvcnksXG4gIFNlbGVjdG9yLFxuICBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsXG4gIFN0YWdlRnVuY3Rpb24sXG4gIFN0YWdlTm9kZSxcbiAgU3RyZWFtSGFuZGxlcnMsXG4gIFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gIFN1YmZsb3dSZXN1bHQsXG4gIFN1YmZsb3dUcmF2ZXJzZXJGYWN0b3J5LFxuICBUcmF2ZXJzYWxSZXN1bHQsXG59IGZyb20gJy4uL3R5cGVzLmpzJztcblxuZXhwb3J0IGludGVyZmFjZSBUcmF2ZXJzZXJPcHRpb25zPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgc3RhZ2VNYXA6IE1hcDxzdHJpbmcsIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPj47XG4gIHNjb3BlRmFjdG9yeTogU2NvcGVGYWN0b3J5PFRTY29wZT47XG4gIGV4ZWN1dGlvblJ1bnRpbWU6IElFeGVjdXRpb25SdW50aW1lO1xuICByZWFkT25seUNvbnRleHQ/OiB1bmtub3duO1xuICAvKiogRXhlY3V0aW9uIGVudmlyb25tZW50IOKAlCBwcm9wYWdhdGVzIHRvIHN1YmZsb3dzIGF1dG9tYXRpY2FsbHkuICovXG4gIGV4ZWN1dGlvbkVudj86IGltcG9ydCgnLi4vLi4vZW5naW5lL3R5cGVzLmpzJykuRXhlY3V0aW9uRW52O1xuICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyPzogKGVycm9yOiB1bmtub3duKSA9PiBib29sZWFuO1xuICBzdHJlYW1IYW5kbGVycz86IFN0cmVhbUhhbmRsZXJzO1xuICBzY29wZVByb3RlY3Rpb25Nb2RlPzogU2NvcGVQcm90ZWN0aW9uTW9kZTtcbiAgc3ViZmxvd3M/OiBSZWNvcmQ8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+O1xuICBuYXJyYXRpdmVFbmFibGVkPzogYm9vbGVhbjtcbiAgYnVpbGRUaW1lU3RydWN0dXJlPzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlO1xuICBsb2dnZXI6IElMb2dnZXI7XG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogUHJlLWNvbmZpZ3VyZWQgRmxvd1JlY29yZGVycyB0byBhdHRhY2ggd2hlbiBuYXJyYXRpdmUgaXMgZW5hYmxlZC4gKi9cbiAgZmxvd1JlY29yZGVycz86IEZsb3dSZWNvcmRlcltdO1xuICAvKipcbiAgICogUHJlLWNvbmZpZ3VyZWQgbmFycmF0aXZlIGdlbmVyYXRvci4gSWYgcHJvdmlkZWQsIHRha2VzIHByZWNlZGVuY2Ugb3ZlclxuICAgKiBmbG93UmVjb3JkZXJzIGFuZCBuYXJyYXRpdmVFbmFibGVkLiBVc2VkIGJ5IHRoZSBzdWJmbG93IHRyYXZlcnNlciBmYWN0b3J5XG4gICAqIHRvIHNoYXJlIHRoZSBwYXJlbnQncyBuYXJyYXRpdmUgZ2VuZXJhdG9yIHdpdGggc3ViZmxvdyB0cmF2ZXJzZXJzLlxuICAgKi9cbiAgbmFycmF0aXZlR2VuZXJhdG9yPzogSUNvbnRyb2xGbG93TmFycmF0aXZlO1xuICAvKipcbiAgICogTWF4aW11bSBuZXN0ZWQgZXhlY3V0ZU5vZGUgZGVwdGggKHRyZWUgbmVzdGluZyDigJQgYnJhbmNoL2ZvcmsgZGlzcGF0Y2ggYW5kXG4gICAqIGR5bmFtaWMgcmVjdXJzaW9uLCBOT1QgbGluZWFyIGNoYWlucyBvciBsb29wIGl0ZXJhdGlvbnMsIHdoaWNoIHJ1biBmbGF0KS5cbiAgICogRGVmYXVsdHMgdG8gRmxvd2NoYXJ0VHJhdmVyc2VyLk1BWF9FWEVDVVRFX0RFUFRIICg1MDApLlxuICAgKi9cbiAgbWF4RGVwdGg/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBNYXhpbXVtIGxvb3AgaXRlcmF0aW9ucyBwZXIgbm9kZSAodGhlIENvbnRpbnVhdGlvblJlc29sdmVyIGd1YXJkKS5cbiAgICogRGVmYXVsdHMgdG8gREVGQVVMVF9NQVhfSVRFUkFUSU9OUyAoMTAwMCkuIFByb3BhZ2F0ZWQgdG8gc3ViZmxvd1xuICAgKiB0cmF2ZXJzZXJzLiBNdXN0IGJlID49IDEuXG4gICAqL1xuICBtYXhJdGVyYXRpb25zPzogbnVtYmVyO1xuICAvKipcbiAgICogV2hlbiB0aGlzIHRyYXZlcnNlciBydW5zIGluc2lkZSBhIHN1YmZsb3csIHNldCB0aGlzIHRvIHRoZSBzdWJmbG93J3MgSUQuXG4gICAqIFByb3BhZ2F0ZWQgdG8gVHJhdmVyc2FsQ29udGV4dCBzbyBuYXJyYXRpdmUgZW50cmllcyBjYXJyeSB0aGUgY29ycmVjdCBzdWJmbG93SWQuXG4gICAqL1xuICBwYXJlbnRTdWJmbG93SWQ/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGVuIHRoaXMgdHJhdmVyc2VyIHJ1bnMgaW5zaWRlIGEgc3ViZmxvdywgdGhlIHJ1bnRpbWVTdGFnZUlkIG9mIHRoZVxuICAgKiBzdWJmbG93IE1PVU5UIHN0YWdlIGluIHRoZSBwYXJlbnQgdHJhdmVyc2VyLiBVc2VkIGFzIHRoZVxuICAgKiBgcGFyZW50UnVudGltZVN0YWdlSWRgIGZhbGxiYWNrIGZvciBzdGFnZXMgd2hvc2UgU3RhZ2VDb250ZXh0IGhhcyBub1xuICAgKiBwYXJlbnQgKHRoZSBzdWJmbG93J3Mgb3duIHJvb3QgY29udGV4dCBpcyBjcmVhdGVkIGZyZXNoIGJ5XG4gICAqIFN1YmZsb3dFeGVjdXRvcikgc28gcnVudGltZSBhbmNlc3RvciBjaGFpbnMgY3Jvc3Mgc3ViZmxvdyBib3VuZGFyaWVzXG4gICAqIChSRkMtMDAzIEQxKS5cbiAgICovXG4gIHBhcmVudE1vdW50UnVudGltZVN0YWdlSWQ/OiBzdHJpbmc7XG4gIC8qKiBTaGFyZWQgZXhlY3V0aW9uIGNvdW50ZXIgZnJvbSBwYXJlbnQgdHJhdmVyc2VyLiBTdWJmbG93cyBjb250aW51ZSB0aGUgcGFyZW50J3MgbnVtYmVyaW5nLiAqL1xuICBleGVjdXRpb25Db3VudGVyPzogeyB2YWx1ZTogbnVtYmVyIH07XG4gIC8qKlxuICAgKiBTaGFyZWQgcGVyLXJ1biB2aXNpdC1jb3VudCBtYXAgKGtleWVkIGJ5IHN0YWdlSWQpIGZyb20gdGhlIHBhcmVudCB0cmF2ZXJzZXIuXG4gICAqIERyaXZlcyBgVHJhdmVyc2FsQ29udGV4dC5sb29wSXRlcmF0aW9uYC4gU2hhcmVkIHdpdGggc3ViZmxvd3Mgc28gYSBzdGFnZVxuICAgKiByZS1lbnRlcmVkIGFjcm9zcyBhIHN1YmZsb3cgcmUtbW91bnQga2VlcHMgYSBjb3JyZWN0LCBtb25vdG9uaWMgaXRlcmF0aW9uXG4gICAqIGNvdW50IOKAlCB0aGUgc2FtZSBzaW5nbGUtbWFwIHNlbWFudGljcyB0aGUgbmFycmF0aXZlIHJlY29yZGVyIHVzZXMuXG4gICAqL1xuICB2aXNpdENvdW50cz86IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIC8qKlxuICAgKiBQZXItc3ViZmxvdyBzY29wZSBjYXB0dXJlcyBmcm9tIGEgY2hlY2twb2ludCwgb24gdGhlIHJlc3VtZSBwYXRoLlxuICAgKiBGb3J3YXJkZWQgdG8gYEhhbmRsZXJEZXBzLnN1YmZsb3dTdGF0ZXNGb3JSZXN1bWVgIHNvIFN1YmZsb3dFeGVjdXRvclxuICAgKiBjYW4gcmUtc2VlZCBuZXN0ZWQgcnVudGltZXMgZnJvbSBwcmUtcGF1c2Ugc3RhdGUgaW5zdGVhZCBvZiBydW5uaW5nXG4gICAqIHRoZSBpbnB1dE1hcHBlci4gVW5kZWZpbmVkIG9uIG5vcm1hbCBgcnVuKClgIHBhdGhzLlxuICAgKi9cbiAgc3ViZmxvd1N0YXRlc0ZvclJlc3VtZT86IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgLyoqXG4gICAqIFBlci1gZXhlY3V0b3IucnVuKClgIGlkZW50aWZpZXIuIFRocmVhZGVkIGludG8gZXZlcnkgVHJhdmVyc2FsQ29udGV4dFxuICAgKiB0aGlzIHRyYXZlcnNlciBwcm9kdWNlcyBzbyByZWNvcmRlcnMgY2FuIHNjb3BlIHN0YXRlIHRvIGEgc2luZ2xlIHJ1bi5cbiAgICogU3ViZmxvdyB0cmF2ZXJzZXJzIGluaGVyaXQgdGhlIHBhcmVudCdzIHJ1bklkICh0aGUgc3ViZmxvdyBpcyBwYXJ0IG9mXG4gICAqIHRoZSBzYW1lIHJ1biBmcm9tIHRoZSBjb25zdW1lcidzIFBPVikuIFJlcXVpcmVkIGZpZWxkIOKAlCBldmVyeSBldmVudFxuICAgKiBuZWVkcyBpdC4gU2VlIGBydW5uZXIvcnVuSWQudHNgLlxuICAgKi9cbiAgcnVuSWQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBUcmF2ZXJzZXItbG9jYWwgb3ZlcmxheSBlbnRyeSBmb3IgYSBub2RlIHdob3NlIHN0YWdlIGZ1bmN0aW9uIHJldHVybmVkIGFcbiAqIFN0YWdlTm9kZSAoZHluYW1pYyBjb250aW51YXRpb24pLiBIb2xkcyB0aGUgZHluYW1pYyB2YWx1ZXMgdGhhdCBlYXJsaWVyXG4gKiB2ZXJzaW9ucyB3cm90ZSBESVJFQ1RMWSBvbnRvIHRoZSBzaGFyZWQgYnVpbHQtY2hhcnQgbm9kZSDigJQgd2hpY2ggbGVha2VkIHRoZVxuICogZHluYW1pYyBzaGFwZSBpbnRvIGV2ZXJ5IGxhdGVyIHJ1biBvZiB0aGUgc2FtZSBidWlsdCBjaGFydCBhbmQgcmFjZWRcbiAqIGNvbmN1cnJlbnQgZXhlY3V0b3JzLiBUaGUgb3ZlcmxheSBrZWVwcyB0aGUgYnVpbHQgZ3JhcGggaW1tdXRhYmxlOiBwYXRjaGVzXG4gKiBsaXZlIGluIGEgcGVyLXRyYXZlcnNlciBNYXAga2V5ZWQgYnkgYG5vZGUuaWRgIGFuZCBkaWUgd2l0aCB0aGUgcnVuLlxuICpcbiAqIGBuZXh0YCBpcyBpbnRlbnRpb25hbGx5IEFCU0VOVDogYSBkeW5hbWljIGBuZXh0YCBvbmx5IGV2ZXIgYXBwbGllcyB0byB0aGVcbiAqIHZpc2l0IHRoYXQgcHJvZHVjZWQgaXQgKHRoZSBvbGQgY29kZSB3cm90ZSBgbm9kZS5uZXh0YCBhbmQgcmVzdG9yZWQgaXRcbiAqIGJlZm9yZSBhbnl0aGluZyBjb3VsZCBvYnNlcnZlIHRoZSB3cml0ZSksIHNvIGl0IHN0YXlzIGEgbG9jYWwgdmFyaWFibGUgaW5cbiAqIGBleGVjdXRlTm9kZWAgYW5kIGlzIHJvdXRlZCB0aHJvdWdoIGBDb250aW51YXRpb25SZXNvbHZlcmAgZGlyZWN0bHkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRHluYW1pY05vZGVQYXRjaDxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgLyoqXG4gICAqIFN1YmZsb3cgbW91bnQgbWV0YWRhdGEgZnJvbSBhIGR5bmFtaWMtc3ViZmxvdyByZXR1cm4uIEdyb3VwZWQgc28gdGhlXG4gICAqIG1lcmdlZCB2aWV3IHJlcHJvZHVjZXMgdGhlIG9sZCBmaWVsZC13aXNlIG92ZXJ3cml0ZSBleGFjdGx5IOKAlCBpbmNsdWRpbmdcbiAgICogYHN1YmZsb3dOYW1lYC9gc3ViZmxvd01vdW50T3B0aW9uc2AgYmVjb21pbmcgdW5kZWZpbmVkIHdoZW4gdGhlIGR5bmFtaWNcbiAgICogcmV0dXJuIG9taXR0ZWQgdGhlbS5cbiAgICovXG4gIHN1YmZsb3dNZXRhPzoge1xuICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWU7XG4gICAgc3ViZmxvd0lkOiBzdHJpbmc7XG4gICAgc3ViZmxvd05hbWU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBzdWJmbG93TW91bnRPcHRpb25zOiBTdWJmbG93TW91bnRPcHRpb25zIHwgdW5kZWZpbmVkO1xuICB9O1xuICAvKiogRHluYW1pYyBmb3JrIGNoaWxkcmVuIChyZXBsYWNlcyB0aGUgYnVpbHQgbm9kZSdzIGNoaWxkcmVuIGZvciB0aGlzIHJ1bikuICovXG4gIGNoaWxkcmVuPzogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT5bXTtcbiAgLyoqIER5bmFtaWMgb3V0cHV0LWJhc2VkIHNlbGVjdG9yIGFjY29tcGFueWluZyBkeW5hbWljIGNoaWxkcmVuLiAqL1xuICBuZXh0Tm9kZVNlbGVjdG9yPzogU2VsZWN0b3I7XG59XG5cbi8qKlxuICogVHJhbXBvbGluZSBicmFuZCDigJQgbWFya3MgYSBjb250aW51YXRpb24gaG9wIHJldHVybmVkIGJ5IGBleGVjdXRlTm9kZVN0ZXBgXG4gKiB0byB0aGUgZHJpdmVyIGxvb3AgaW4gYGV4ZWN1dGVOb2RlYC4gTW9kdWxlLXByaXZhdGUgc3ltYm9sIHNvIGEgc3RhZ2UncyBvd25cbiAqIHJldHVybiB2YWx1ZSAod2hpY2ggY2FuIGJlIGFueSBvYmplY3QpIGNhbiBuZXZlciBiZSBtaXN0YWtlbiBmb3IgYSBob3AuXG4gKi9cbmNvbnN0IENPTlRJTlVFX0hPUDogdW5pcXVlIHN5bWJvbCA9IFN5bWJvbCgnZm9vdHByaW50anMuZXhlY3V0ZU5vZGUuY29udGludWUnKTtcblxuLyoqXG4gKiBBIGZsYXQgY29udGludWF0aW9uIOKAlCBcImV4ZWN1dGUgdGhpcyBub2RlIG5leHQsIGluIHRoaXMgY29udGV4dFwiIOKAlCByZXR1cm5lZFxuICogYnkgYGV4ZWN1dGVOb2RlU3RlcGAgZm9yIGV2ZXJ5IFRBSUwgY29udGludWF0aW9uIChsaW5lYXIgYG5leHRgLCBsb29wXG4gKiBlZGdlcywgZHluYW1pYyBuZXh0LCBkeW5hbWljLXN1YmZsb3cgcmUtZW50cnksIG5vLWNvbnRpbnVhdGlvbiBkZWNpZGVyXG4gKiBkaXNwYXRjaCkuIFRoZSBkcml2ZXIgbG9vcCBpbiBgZXhlY3V0ZU5vZGVgIGNvbnN1bWVzIGhvcHMgaXRlcmF0aXZlbHk6XG4gKiBgY3VycmVudCA9IGhvcDsgY29udGludWU7YCDigJQgc28gbmVpdGhlciB0aGUgY2FsbCBzdGFjayBub3IgdGhlIHJldGFpbmVkXG4gKiBwcm9taXNlIGNoYWluIGdyb3dzIHdpdGggY2hhaW4gbGVuZ3RoIG9yIGxvb3AgaXRlcmF0aW9ucy5cbiAqL1xuaW50ZXJmYWNlIENvbnRpbnVhdGlvbkhvcDxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcmVhZG9ubHkgW0NPTlRJTlVFX0hPUF06IHRydWU7XG4gIHJlYWRvbmx5IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICByZWFkb25seSBjb250ZXh0OiBTdGFnZUNvbnRleHQ7XG4gIHJlYWRvbmx5IGJyYW5jaFBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIFByZXNlbnQgd2hlbiB0aGUgaG9wIGlzIGEgZGVjaWRlcidzIGJyYW5jaCBkaXNwYXRjaCAoZGVjaWRlciB3aXRob3V0IGl0c1xuICAgKiBvd24gYG5leHRgKS4gVGhlIGRyaXZlciByZWNvcmRzIGl0IHNvIGEgUGF1c2VTaWduYWwgdGhyb3duIGFueXdoZXJlIGluXG4gICAqIHRoZSBjb250aW51ZWQgY2hhaW4gc3RpbGwgZ2V0cyB0aGUgZGVjaWRlciBzdGFtcGVkIGFzIGl0cyBpbnZva2VyIOKAlFxuICAgKiBleGFjdGx5IHdoYXQgdGhlIHJlY3Vyc2l2ZSBkaXNwYXRjaCdzIGNhdGNoIHVzZWQgdG8gZG8uXG4gICAqL1xuICByZWFkb25seSBpbnZva2VyU3RhbXA/OiBJbnZva2VyU3RhbXA7XG59XG5cbi8qKiBQYXVzZS1pbnZva2VyIGNvbnRleHQgcmVjb3JkZWQgYnkgdGhlIGRyaXZlciBmb3IgZmxhdCBkZWNpZGVyIGRpc3BhdGNoZXMuICovXG5pbnRlcmZhY2UgSW52b2tlclN0YW1wIHtcbiAgcmVhZG9ubHkgaW52b2tlclN0YWdlSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGludWF0aW9uU3RhZ2VJZD86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gaXNDb250aW51YXRpb25Ib3A8VE91dCwgVFNjb3BlPih2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIENvbnRpbnVhdGlvbkhvcDxUT3V0LCBUU2NvcGU+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGwgJiYgKHZhbHVlIGFzIFJlY29yZDxzeW1ib2wsIHVua25vd24+KVtDT05USU5VRV9IT1BdID09PSB0cnVlO1xufVxuXG5leHBvcnQgY2xhc3MgRmxvd2NoYXJ0VHJhdmVyc2VyPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHN0YWdlTWFwOiBNYXA8c3RyaW5nLCBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4+O1xuICBwcml2YXRlIHJlYWRvbmx5IGV4ZWN1dGlvblJ1bnRpbWU6IElFeGVjdXRpb25SdW50aW1lO1xuICBwcml2YXRlIHN1YmZsb3dzOiBSZWNvcmQ8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvZ2dlcjogSUxvZ2dlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgcHJpdmF0ZSByZWFkb25seSBwYXJlbnRTdWJmbG93SWQ/OiBzdHJpbmc7XG4gIC8qKiBSRkMtMDAzIEQxOiBydW50aW1lU3RhZ2VJZCBvZiB0aGUgc3ViZmxvdyBtb3VudCBzdGFnZSBpbiB0aGUgcGFyZW50XG4gICAqICB0cmF2ZXJzZXIuIEZhbGxiYWNrIGBwYXJlbnRSdW50aW1lU3RhZ2VJZGAgZm9yIHN0YWdlcyB3aG9zZSBjb250ZXh0IGhhc1xuICAgKiAgbm8gcGFyZW50ICh0aGUgc3ViZmxvdyByb290KS4gVW5kZWZpbmVkIGF0IHRoZSB0b3AgbGV2ZWwuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgcGFyZW50TW91bnRSdW50aW1lU3RhZ2VJZD86IHN0cmluZztcbiAgLyoqIEZyb3plbiB2YWx1ZSBwYXNzZWQgdmlhIGBydW4oe2lucHV0fSlgLiBTdXJmYWNlZCBvbiBgb25SdW5TdGFydGAgYXQgdGhlXG4gICAqICB0b3AtbGV2ZWwgdHJhdmVyc2FsIHNvIGNvbnN1bWVycyAoZS5nLiBgSW5PdXRSZWNvcmRlcmApIGNhbiBicmFja2V0XG4gICAqICB0aGUgcnVuIHdpdGggdGhlIHNhbWUgcGF5bG9hZCBzaGFwZSB0aGF0IHN1YmZsb3dzIGFscmVhZHkgaGF2ZS4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSByZWFkT25seUNvbnRleHQ/OiB1bmtub3duO1xuICAvKiogUGVyLWBleGVjdXRvci5ydW4oKWAgaWRlbnRpZmllci4gU3RhbXBlZCBvbnRvIGV2ZXJ5IFRyYXZlcnNhbENvbnRleHQuXG4gICAqICBJbmhlcml0ZWQgYnkgc3ViZmxvdyB0cmF2ZXJzZXJzIHNvIGFsbCBldmVudHMgb2Ygb25lIHJ1biBzaGFyZSBvbmUgcnVuSWQuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgcnVuSWQ6IHN0cmluZztcblxuICAvLyBIYW5kbGVyIG1vZHVsZXNcbiAgcHJpdmF0ZSByZWFkb25seSBub2RlUmVzb2x2ZXI6IE5vZGVSZXNvbHZlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGNoaWxkcmVuRXhlY3V0b3I6IENoaWxkcmVuRXhlY3V0b3I8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBzdWJmbG93RXhlY3V0b3I6IFN1YmZsb3dFeGVjdXRvcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IHN0YWdlUnVubmVyOiBTdGFnZVJ1bm5lcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGNvbnRpbnVhdGlvblJlc29sdmVyOiBDb250aW51YXRpb25SZXNvbHZlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGRlY2lkZXJIYW5kbGVyOiBEZWNpZGVySGFuZGxlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IHNlbGVjdG9ySGFuZGxlcjogU2VsZWN0b3JIYW5kbGVyPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgc3RydWN0dXJlTWFuYWdlcjogUnVudGltZVN0cnVjdHVyZU1hbmFnZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgbmFycmF0aXZlR2VuZXJhdG9yOiBJQ29udHJvbEZsb3dOYXJyYXRpdmU7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogRmxvd1JlY29yZGVyRGlzcGF0Y2hlciB8IHVuZGVmaW5lZDtcblxuICAvLyBFeGVjdXRpb24gc3RhdGVcbiAgcHJpdmF0ZSBzdWJmbG93UmVzdWx0czogTWFwPHN0cmluZywgU3ViZmxvd1Jlc3VsdD4gPSBuZXcgTWFwKCk7XG5cbiAgLyoqXG4gICAqIFBlci10cmF2ZXJzZXIgc2V0IG9mIGxhenkgc3ViZmxvdyBJRHMgdGhhdCBoYXZlIGJlZW4gcmVzb2x2ZWQgYnkgVEhJUyBydW4uXG4gICAqIFVzZWQgaW5zdGVhZCBvZiB3cml0aW5nIGBub2RlLnN1YmZsb3dSZXNvbHZlciA9IHVuZGVmaW5lZGAgYmFjayB0byB0aGUgc2hhcmVkXG4gICAqIFN0YWdlTm9kZSBncmFwaCDigJQgYXZvaWRzIGEgcmFjZSB3aGVyZSBhIGNvbmN1cnJlbnQgdHJhdmVyc2VyIGNsZWFycyB0aGUgc2hhcmVkXG4gICAqIHJlc29sdmVyIGJlZm9yZSBhbm90aGVyIHRyYXZlcnNlciBoYXMgZmluaXNoZWQgdXNpbmcgaXQuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHJlc29sdmVkTGF6eVN1YmZsb3dzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgLyoqXG4gICAqIFBlci10cmF2ZXJzZXIgb3ZlcmxheSBvZiBkeW5hbWljIFN0YWdlTm9kZSByZXR1cm5zLCBrZXllZCBieSBgbm9kZS5pZGAuXG4gICAqIFBoYXNlIDQgd3JpdGVzIHBhdGNoZXMgSEVSRSBpbnN0ZWFkIG9mIG11dGF0aW5nIHRoZSBzaGFyZWQgYnVpbHQtY2hhcnRcbiAgICogbm9kZSBvYmplY3RzIChzYW1lIGlzb2xhdGlvbiBjb252ZW50aW9uIGFzIGByZXNvbHZlZExhenlTdWJmbG93c2ApLlxuICAgKiBBbGwgZW5naW5lIHJlYWRzIG9mIHRoZSBwYXRjaGVkIGZpZWxkcyBnbyB0aHJvdWdoIHRoZSBgZWZmKmAgYWNjZXNzb3JzXG4gICAqIGJlbG93LiBUaGUgbWFwIGRpZXMgd2l0aCB0aGUgdHJhdmVyc2VyIOKAlCBvbmUgcnVuLCBvbmUgb3ZlcmxheSDigJQgc28gYVxuICAgKiBmcmVzaCBleGVjdXRvciBvdmVyIHRoZSBzYW1lIGJ1aWx0IGNoYXJ0IGFsd2F5cyBzZWVzIHRoZSBvcmlnaW5hbCBncmFwaC5cbiAgICpcbiAgICogS2V5ZWQgYnkgdGhlIG5vZGUgT0JKRUNUIChXZWFrTWFwKSwgbm90IGBub2RlLmlkYDogYSBkeW5hbWljIGNoaWxkIHRoYXRcbiAgICogcmV1c2VzIGEgYnVpbHQgbm9kZSdzIGlkIG11c3QgTk9UIG1ha2UgdGhlIGJ1aWx0IG5vZGUgaW5oZXJpdCB0aGUgcGF0Y2hcbiAgICogKGlkLWtleWVkIGxvb2t1cCBjYXVzZWQgcGhhbnRvbSBkb3VibGUtZXhlY3V0aW9uKS4gYHBhdGNoQ291bnRgIGlzIHRoZVxuICAgKiBmYXN0LXBhdGggY2hlY2sg4oCUIFdlYWtNYXAgaGFzIG5vIGBzaXplYC5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgZHluYW1pY1BhdGNoZXMgPSBuZXcgV2Vha01hcDxTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgRHluYW1pY05vZGVQYXRjaDxUT3V0LCBUU2NvcGU+PigpO1xuICBwcml2YXRlIHBhdGNoQ291bnQgPSAwO1xuXG4gIC8qKlxuICAgKiBUUkVFLW5lc3RpbmcgZGVwdGggY291bnRlciBmb3IgZXhlY3V0ZU5vZGUgKHRoZSB0cmFtcG9saW5lIGRyaXZlcikuXG4gICAqIEVhY2ggZHJpdmVyIGludm9jYXRpb24gaW5jcmVtZW50cyB0aGlzOyBkZWNyZW1lbnRzIG9uIGV4aXQgKHRyeS9maW5hbGx5KS5cbiAgICpcbiAgICogTGluZWFyIGBuZXh0YCBjaGFpbnMsIGxvb3AgZWRnZXMsIGFuZCBkeW5hbWljIGNvbnRpbnVhdGlvbnMgYXJlIGZvbGxvd2VkXG4gICAqIElURVJBVElWRUxZIGluc2lkZSBvbmUgZHJpdmVyIGludm9jYXRpb24sIHNvIHRoZXkgbmV2ZXIgZ3JvdyB0aGlzXG4gICAqIGNvdW50ZXIuIE9ubHkgdHJ1ZSB0cmVlIHJlY3Vyc2lvbiBkb2VzOiBmb3JrIGNoaWxkcmVuLCBkZWNpZGVyL3NlbGVjdG9yXG4gICAqIGJyYW5jaCBkaXNwYXRjaCAod2hlbiB0aGUgZGVjaWRlciBoYXMgaXRzIG93biBjb250aW51YXRpb24pLCBhbmRcbiAgICogdW5ib3VuZGVkIGR5bmFtaWMgcmVjdXJzaW9uLiBQcmV2ZW50cyBjYWxsLXN0YWNrIG92ZXJmbG93IG9uIHJ1bmF3YXlcbiAgICogcmVjdXJzaXZlIGNvbXBvc2l0aW9uLlxuICAgKi9cbiAgcHJpdmF0ZSBfZXhlY3V0ZURlcHRoID0gMDtcblxuICAvKipcbiAgICogTWVtb2l6ZWQgcGFyZW50LWNoYWluIGRlcHRoIHBlciBTdGFnZUNvbnRleHQuIFRoZSBjb250ZXh0IHRyZWUgZGVlcGVuc1xuICAgKiBieSBvbmUgcGVyIGV4ZWN1dGVkIHN0YWdlIGFsb25nIGEgY2hhaW4sIHNvIHRoZSBuYWl2ZSBwYXJlbnQtd2FsayBpblxuICAgKiBgY29tcHV0ZUNvbnRleHREZXB0aGAgaXMgTyhjaGFpbiBsZW5ndGgpIHBlciBzdGFnZSDigJQgTyhuwrIpIHBlciBydW4gb25jZVxuICAgKiB0aGUgdHJhbXBvbGluZSBhbGxvd3MgY2hhaW5zIG9mIHRlbnMgb2YgdGhvdXNhbmRzIG9mIHN0YWdlcy4gQ29udGV4dHNcbiAgICogYXJlIHZpc2l0ZWQgcGFyZW50LWJlZm9yZS1jaGlsZCwgc28gdGhlIG1lbW8gbWFrZXMgZWFjaCBsb29rdXAgTygxKVxuICAgKiBhbW9ydGl6ZWQuIFdlYWtNYXAg4oCUIGRpZXMgd2l0aCB0aGUgdHJhdmVyc2VyLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBjb250ZXh0RGVwdGhDYWNoZSA9IG5ldyBXZWFrTWFwPFN0YWdlQ29udGV4dCwgbnVtYmVyPigpO1xuXG4gIC8qKlxuICAgKiBTaGFyZWQgbXV0YWJsZSBleGVjdXRpb24gY291bnRlciDigJQgbW9ub3RvbmljLCBpbmNyZW1lbnRlZCBwZXIgc3RhZ2UgZXhlY3V0aW9uLlxuICAgKiBTaGFyZWQgd2l0aCBjaGlsZCB0cmF2ZXJzZXJzIChzdWJmbG93cykgc28gaW5kaWNlcyBhcmUgZ2xvYmFsbHkgdW5pcXVlIHdpdGhpbiBhIHJ1bi5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgX2V4ZWN1dGlvbkNvdW50ZXI6IHsgdmFsdWU6IG51bWJlciB9O1xuXG4gIC8qKlxuICAgKiBTaGFyZWQgcGVyLXJ1biB2aXNpdCBjb3VudHMga2V5ZWQgYnkgc3RhZ2VJZCDigJQgaG93IG1hbnkgdGltZXMgZWFjaCBzdGFnZVxuICAgKiBoYXMgZXhlY3V0ZWQgaW4gdGhpcyBydW4uIFNoYXJlZCB3aXRoIGNoaWxkIHRyYXZlcnNlcnMgKHN1YmZsb3dzKSBzbyBhXG4gICAqIGxvb3BlZC1iYWNrIHN0YWdlJ3MgaXRlcmF0aW9uIGNvdW50IGlzIG1vbm90b25pYyBhY3Jvc3Mgc3ViZmxvdyByZS1tb3VudHMsXG4gICAqIG1hdGNoaW5nIHRoZSBuYXJyYXRpdmUgcmVjb3JkZXIncyBzaW5nbGUtbWFwIHNlbWFudGljcy4gRHJpdmVzXG4gICAqIGBUcmF2ZXJzYWxDb250ZXh0Lmxvb3BJdGVyYXRpb25gLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBfdmlzaXRDb3VudHM6IE1hcDxzdHJpbmcsIG51bWJlcj47XG5cbiAgLyoqXG4gICAqIFBlci1pbnN0YW5jZSBtYXhpbXVtIGRlcHRoIChzZXQgZnJvbSBUcmF2ZXJzZXJPcHRpb25zLm1heERlcHRoIG9yIHRoZSBjbGFzcyBkZWZhdWx0KS5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgX21heERlcHRoOiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFBlci1pbnN0YW5jZSBsb29wLWl0ZXJhdGlvbiBsaW1pdCBmb3J3YXJkZWQgdG8gdGhlIENvbnRpbnVhdGlvblJlc29sdmVyXG4gICAqIGFuZCBwcm9wYWdhdGVkIHRvIHN1YmZsb3cgdHJhdmVyc2Vycy4gVW5kZWZpbmVkIOKGkiByZXNvbHZlciBkZWZhdWx0ICgxMDAwKS5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgX21heEl0ZXJhdGlvbnM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIERlZmF1bHQgbWF4aW11bSBuZXN0ZWQgZXhlY3V0ZU5vZGUgZGVwdGggYmVmb3JlIGFuIGVycm9yIGlzIHRocm93bi5cbiAgICpcbiAgICogKipXaGF0IGNvdW50cyBhcyBkZXB0aCAodHJhbXBvbGluZSBtb2RlbCk6KiogYGV4ZWN1dGVOb2RlYCBpcyBhbiBpdGVyYXRpdmVcbiAgICogZHJpdmVyIOKAlCBsaW5lYXIgYG5leHRgIGhvcHMsIGxvb3AgZWRnZXMgKGBsb29wVG9gL2R5bmFtaWMgbmV4dCksIGFuZFxuICAgKiBkeW5hbWljLXN1YmZsb3cgcmUtZW50cnkgYXJlIGZvbGxvd2VkIGluIGEgZmxhdCBsb29wIGFuZCBjb25zdW1lIE5PIGRlcHRoLlxuICAgKiBEZXB0aCBncm93cyBvbmx5IHdpdGggdHJ1ZSB0cmVlIG5lc3Rpbmc6IG9uZSB0aWNrIHBlciBmb3JrIGNoaWxkLCBvbmUgcGVyXG4gICAqIGRlY2lkZXIvc2VsZWN0b3IgYnJhbmNoIGRpc3BhdGNoIHRoYXQgbXVzdCByZXR1cm4gdG8gaXRzIGludm9rZXIgKGRlY2lkZXJcbiAgICogd2l0aCBpdHMgb3duIGBuZXh0YCksIG9uZSBwZXIgc3ViZmxvdyBtb3VudCBmcmFtZSBpbiB0aGUgcGFyZW50ICh0aGVcbiAgICogc3ViZmxvdyBib2R5IGl0c2VsZiBydW5zIG9uIGEgRlJFU0ggdHJhdmVyc2VyIHdpdGggaXRzIG93biBidWRnZXQpLlxuICAgKlxuICAgKiA1MDAgdGhlcmVmb3JlIGNvdmVycyBhbnkgcmVhbGlzdGljIGNoYXJ0IOKAlCBpdCBib3VuZHMgcmVjdXJzaXZlXG4gICAqIENPTVBPU0lUSU9OLCBub3QgY2hhaW4gbGVuZ3RoIG9yIGxvb3AgY291bnQuIExvb3BzIGFyZSBib3VuZGVkIGJ5XG4gICAqIGBDb250aW51YXRpb25SZXNvbHZlcmAncyBpbmRlcGVuZGVudCBpdGVyYXRpb24gbGltaXQgKGRlZmF1bHQgMTAwMCxcbiAgICogY29uZmlndXJhYmxlIHZpYSBgUnVuT3B0aW9ucy5tYXhJdGVyYXRpb25zYCksIHdoaWNoIGlzIG5vdyB0aGUgYmluZGluZ1xuICAgKiBjb25zdHJhaW50IGZvciBsb29wLWhlYXZ5IHBpcGVsaW5lcy5cbiAgICpcbiAgICogQHJlbWFya3MgTm90IHNhZmUgZm9yIGNvbmN1cnJlbnQgYC5leGVjdXRlKClgIGNhbGxzIG9uIHRoZSBzYW1lIGluc3RhbmNlIOKAlCBjb25jdXJyZW50XG4gICAqIGV4ZWN1dGlvbnMgcmFjZSBvbiBgX2V4ZWN1dGVEZXB0aGAuIFVzZSBhIHNlcGFyYXRlIGBGbG93Y2hhcnRUcmF2ZXJzZXJgIHBlciBjb25jdXJyZW50XG4gICAqIGV4ZWN1dGlvbi4gYEZsb3dDaGFydEV4ZWN1dG9yLnJ1bigpYCBhbHdheXMgY3JlYXRlcyBhIGZyZXNoIHRyYXZlcnNlciBwZXIgY2FsbC5cbiAgICovXG4gIHN0YXRpYyByZWFkb25seSBNQVhfRVhFQ1VURV9ERVBUSCA9IDUwMDtcblxuICBjb25zdHJ1Y3RvcihvcHRzOiBUcmF2ZXJzZXJPcHRpb25zPFRPdXQsIFRTY29wZT4pIHtcbiAgICBjb25zdCBtYXhEZXB0aCA9IG9wdHMubWF4RGVwdGggPz8gRmxvd2NoYXJ0VHJhdmVyc2VyLk1BWF9FWEVDVVRFX0RFUFRIO1xuICAgIGlmIChtYXhEZXB0aCA8IDEpIHRocm93IG5ldyBFcnJvcignRmxvd2NoYXJ0VHJhdmVyc2VyOiBtYXhEZXB0aCBtdXN0IGJlID49IDEnKTtcbiAgICB0aGlzLl9tYXhEZXB0aCA9IG1heERlcHRoO1xuICAgIGlmIChvcHRzLm1heEl0ZXJhdGlvbnMgIT09IHVuZGVmaW5lZCAmJiBvcHRzLm1heEl0ZXJhdGlvbnMgPCAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Zsb3djaGFydFRyYXZlcnNlcjogbWF4SXRlcmF0aW9ucyBtdXN0IGJlID49IDEnKTtcbiAgICB9XG4gICAgdGhpcy5fbWF4SXRlcmF0aW9ucyA9IG9wdHMubWF4SXRlcmF0aW9ucztcbiAgICB0aGlzLl9leGVjdXRpb25Db3VudGVyID0gb3B0cy5leGVjdXRpb25Db3VudGVyID8/IHsgdmFsdWU6IDAgfTtcbiAgICB0aGlzLl92aXNpdENvdW50cyA9IG9wdHMudmlzaXRDb3VudHMgPz8gbmV3IE1hcCgpO1xuICAgIHRoaXMucm9vdCA9IG9wdHMucm9vdDtcbiAgICAvLyBTaGFsbG93LWNvcHkgc3RhZ2VNYXAgYW5kIHN1YmZsb3dzIHNvIHRoYXQgbGF6eS1yZXNvbHV0aW9uIG11dGF0aW9uc1xuICAgIC8vIChwcmVmaXhlZCBlbnRyaWVzIGFkZGVkIGR1cmluZyBleGVjdXRpb24pIHN0YXkgc2NvcGVkIHRvIFRISVMgdHJhdmVyc2VyXG4gICAgLy8gYW5kIGRvIG5vdCBlc2NhcGUgdG8gdGhlIHNoYXJlZCBGbG93Q2hhcnQgb2JqZWN0LiBXaXRob3V0IHRoZSBjb3B5LFxuICAgIC8vIGNvbmN1cnJlbnQgRmxvd0NoYXJ0RXhlY3V0b3IgcnVucyBzaGFyaW5nIHRoZSBzYW1lIEZsb3dDaGFydCB3b3VsZCByYWNlXG4gICAgLy8gb24gdGhlc2UgdHdvIG11dGFibGUgZGljdGlvbmFyaWVzLlxuICAgIHRoaXMuc3RhZ2VNYXAgPSBuZXcgTWFwKG9wdHMuc3RhZ2VNYXApO1xuICAgIHRoaXMuZXhlY3V0aW9uUnVudGltZSA9IG9wdHMuZXhlY3V0aW9uUnVudGltZTtcbiAgICB0aGlzLnN1YmZsb3dzID0gb3B0cy5zdWJmbG93cyA/IHsgLi4ub3B0cy5zdWJmbG93cyB9IDoge307XG4gICAgdGhpcy5sb2dnZXIgPSBvcHRzLmxvZ2dlcjtcbiAgICB0aGlzLnNpZ25hbCA9IG9wdHMuc2lnbmFsO1xuICAgIHRoaXMucGFyZW50U3ViZmxvd0lkID0gb3B0cy5wYXJlbnRTdWJmbG93SWQ7XG4gICAgdGhpcy5wYXJlbnRNb3VudFJ1bnRpbWVTdGFnZUlkID0gb3B0cy5wYXJlbnRNb3VudFJ1bnRpbWVTdGFnZUlkO1xuICAgIHRoaXMucmVhZE9ubHlDb250ZXh0ID0gb3B0cy5yZWFkT25seUNvbnRleHQ7XG4gICAgdGhpcy5ydW5JZCA9IG9wdHMucnVuSWQ7XG5cbiAgICAvLyBTdHJ1Y3R1cmUgbWFuYWdlciAoZGVlcC1jbG9uZXMgYnVpbGQtdGltZSBzdHJ1Y3R1cmUpXG4gICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyID0gbmV3IFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyKCk7XG4gICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLmluaXQob3B0cy5idWlsZFRpbWVTdHJ1Y3R1cmUpO1xuXG4gICAgLy8gTmFycmF0aXZlIGdlbmVyYXRvclxuICAgIC8vIFByaW9yaXR5OiBleHBsaWNpdCBuYXJyYXRpdmVHZW5lcmF0b3IgPiBmbG93UmVjb3JkZXJzID4gZGVmYXVsdCBOYXJyYXRpdmVGbG93UmVjb3JkZXIgPiBudWxsLlxuICAgIC8vIFN1YmZsb3cgdHJhdmVyc2VycyByZWNlaXZlIHRoZSBwYXJlbnQncyBuYXJyYXRpdmVHZW5lcmF0b3Igc28gYWxsIGV2ZW50cyBmbG93IHRvIG9uZSBwbGFjZS5cbiAgICBpZiAob3B0cy5uYXJyYXRpdmVHZW5lcmF0b3IpIHtcbiAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yID0gb3B0cy5uYXJyYXRpdmVHZW5lcmF0b3I7XG4gICAgfSBlbHNlIGlmIChvcHRzLm5hcnJhdGl2ZUVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IGRpc3BhdGNoZXIgPSBuZXcgRmxvd1JlY29yZGVyRGlzcGF0Y2hlcigpO1xuICAgICAgdGhpcy5mbG93UmVjb3JkZXJEaXNwYXRjaGVyID0gZGlzcGF0Y2hlcjtcblxuICAgICAgLy8gSWYgY3VzdG9tIEZsb3dSZWNvcmRlcnMgYXJlIHByb3ZpZGVkLCB1c2UgdGhlbTsgb3RoZXJ3aXNlIGF0dGFjaCBkZWZhdWx0IE5hcnJhdGl2ZUZsb3dSZWNvcmRlclxuICAgICAgaWYgKG9wdHMuZmxvd1JlY29yZGVycyAmJiBvcHRzLmZsb3dSZWNvcmRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgICBmb3IgKGNvbnN0IHJlY29yZGVyIG9mIG9wdHMuZmxvd1JlY29yZGVycykge1xuICAgICAgICAgIGRpc3BhdGNoZXIuYXR0YWNoKHJlY29yZGVyKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGlzcGF0Y2hlci5hdHRhY2gobmV3IE5hcnJhdGl2ZUZsb3dSZWNvcmRlcigpKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3IgPSBkaXNwYXRjaGVyO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvciA9IG5ldyBOdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IoKTtcbiAgICB9XG5cbiAgICAvLyBCdWlsZCBzaGFyZWQgZGVwcyBiYWdcbiAgICBjb25zdCBkZXBzID0gdGhpcy5jcmVhdGVEZXBzKG9wdHMpO1xuXG4gICAgLy8gQnVpbGQgTygxKSBub2RlIElEIG1hcCBmcm9tIHRoZSByb290IGdyYXBoIChhdm9pZHMgcmVwZWF0ZWQgREZTIG9uIGV2ZXJ5IGxvb3BUbygpKVxuICAgIGNvbnN0IG5vZGVJZE1hcCA9IHRoaXMuYnVpbGROb2RlSWRNYXAob3B0cy5yb290KTtcblxuICAgIC8vIEluaXRpYWxpemUgaGFuZGxlciBtb2R1bGVzLlxuICAgIC8vIE5vZGVSZXNvbHZlcidzIERGUyBmYWxsYmFjayByZXNvbHZlcyBsb29wIHRhcmdldHMgYWdhaW5zdCB0aGUgTElWRVxuICAgIC8vIHJ1bnRpbWUgc2hhcGUsIHNvIGl0IHJlYWRzIGNoaWxkcmVuIHRocm91Z2ggdGhlIGR5bmFtaWMtcGF0Y2ggb3ZlcmxheVxuICAgIC8vIChhIGxvb3AgY2FuIHRhcmdldCBhIG5vZGUgYWRkZWQgYnkgYSBkeW5hbWljIFN0YWdlTm9kZSByZXR1cm4pLlxuICAgIHRoaXMubm9kZVJlc29sdmVyID0gbmV3IE5vZGVSZXNvbHZlcihkZXBzLCBub2RlSWRNYXAsIChuKSA9PiB0aGlzLmVmZkNoaWxkcmVuKG4pKTtcbiAgICB0aGlzLmNoaWxkcmVuRXhlY3V0b3IgPSBuZXcgQ2hpbGRyZW5FeGVjdXRvcihkZXBzLCB0aGlzLmV4ZWN1dGVOb2RlLmJpbmQodGhpcykpO1xuICAgIHRoaXMuc3RhZ2VSdW5uZXIgPSBuZXcgU3RhZ2VSdW5uZXIoZGVwcyk7XG4gICAgdGhpcy5jb250aW51YXRpb25SZXNvbHZlciA9IG5ldyBDb250aW51YXRpb25SZXNvbHZlcihcbiAgICAgIGRlcHMsXG4gICAgICB0aGlzLm5vZGVSZXNvbHZlcixcbiAgICAgIChub2RlSWQsIGNvdW50KSA9PiB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlSXRlcmF0aW9uQ291bnQobm9kZUlkLCBjb3VudCksXG4gICAgICB0aGlzLl9tYXhJdGVyYXRpb25zLFxuICAgICk7XG4gICAgdGhpcy5kZWNpZGVySGFuZGxlciA9IG5ldyBEZWNpZGVySGFuZGxlcihkZXBzKTtcbiAgICB0aGlzLnNlbGVjdG9ySGFuZGxlciA9IG5ldyBTZWxlY3RvckhhbmRsZXIoZGVwcywgdGhpcy5jaGlsZHJlbkV4ZWN1dG9yKTtcbiAgICB0aGlzLnN1YmZsb3dFeGVjdXRvciA9IG5ldyBTdWJmbG93RXhlY3V0b3IoZGVwcywgdGhpcy5jcmVhdGVTdWJmbG93VHJhdmVyc2VyRmFjdG9yeShvcHRzKSk7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlIGEgZmFjdG9yeSB0aGF0IHByb2R1Y2VzIEZsb3djaGFydFRyYXZlcnNlciBpbnN0YW5jZXMgZm9yIHN1YmZsb3cgZXhlY3V0aW9uLlxuICAgKiBDYXB0dXJlcyBwYXJlbnQgY29uZmlnIGluIGNsb3N1cmUg4oCUIFN1YmZsb3dFeGVjdXRvciBwcm92aWRlcyBzdWJmbG93LXNwZWNpZmljIG92ZXJyaWRlcy5cbiAgICogRWFjaCBzdWJmbG93IGdldHMgYSBmdWxsIHRyYXZlcnNlciB3aXRoIGFsbCA3IHBoYXNlcyAoZGVjaWRlcnMsIHNlbGVjdG9ycywgbG9vcHMsIGV0Yy4pLlxuICAgKi9cbiAgcHJpdmF0ZSBjcmVhdGVTdWJmbG93VHJhdmVyc2VyRmFjdG9yeShcbiAgICBwYXJlbnRPcHRzOiBUcmF2ZXJzZXJPcHRpb25zPFRPdXQsIFRTY29wZT4sXG4gICk6IFN1YmZsb3dUcmF2ZXJzZXJGYWN0b3J5PFRPdXQsIFRTY29wZT4ge1xuICAgIC8vIENhcHR1cmUgcmVmZXJlbmNlcyB0byBtdXRhYmxlIHN0YXRlIOKAlCBmYWN0b3J5IHJlYWRzIHRoZSBDVVJSRU5UIHN0YXRlIHdoZW4gY2FsbGVkLFxuICAgIC8vIG5vdCB0aGUgc3RhdGUgYXQgZmFjdG9yeSBjcmVhdGlvbiB0aW1lLiBUaGlzIGlzIGNvcnJlY3QgYmVjYXVzZSBsYXp5IHN1YmZsb3cgcmVzb2x1dGlvblxuICAgIC8vIG1heSBhZGQgZW50cmllcyB0byBzdGFnZU1hcC9zdWJmbG93cyBiZWZvcmUgYSBuZXN0ZWQgc3ViZmxvdyBpcyBlbmNvdW50ZXJlZC5cbiAgICBjb25zdCBwYXJlbnRTdGFnZU1hcCA9IHRoaXMuc3RhZ2VNYXA7XG4gICAgY29uc3QgcGFyZW50U3ViZmxvd3MgPSB0aGlzLnN1YmZsb3dzO1xuICAgIGNvbnN0IG5hcnJhdGl2ZUdlbmVyYXRvciA9IHRoaXMubmFycmF0aXZlR2VuZXJhdG9yO1xuXG4gICAgcmV0dXJuIChzdWJmbG93T3B0cykgPT4ge1xuICAgICAgY29uc3QgdHJhdmVyc2VyID0gbmV3IEZsb3djaGFydFRyYXZlcnNlcjxUT3V0LCBUU2NvcGU+KHtcbiAgICAgICAgcm9vdDogc3ViZmxvd09wdHMucm9vdCxcbiAgICAgICAgc3RhZ2VNYXA6IHBhcmVudFN0YWdlTWFwLCAvLyBDb25zdHJ1Y3RvciBzaGFsbG93LWNvcGllcyB0aGlzXG4gICAgICAgIHNjb3BlRmFjdG9yeTogcGFyZW50T3B0cy5zY29wZUZhY3RvcnksXG4gICAgICAgIGV4ZWN1dGlvblJ1bnRpbWU6IHN1YmZsb3dPcHRzLmV4ZWN1dGlvblJ1bnRpbWUsXG4gICAgICAgIHJlYWRPbmx5Q29udGV4dDogc3ViZmxvd09wdHMucmVhZE9ubHlDb250ZXh0LFxuICAgICAgICBleGVjdXRpb25FbnY6IHBhcmVudE9wdHMuZXhlY3V0aW9uRW52LFxuICAgICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyOiBwYXJlbnRPcHRzLnRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgICAgIHN0cmVhbUhhbmRsZXJzOiBwYXJlbnRPcHRzLnN0cmVhbUhhbmRsZXJzLFxuICAgICAgICBzY29wZVByb3RlY3Rpb25Nb2RlOiBwYXJlbnRPcHRzLnNjb3BlUHJvdGVjdGlvbk1vZGUsXG4gICAgICAgIHN1YmZsb3dzOiBwYXJlbnRTdWJmbG93cywgLy8gQ29uc3RydWN0b3Igc2hhbGxvdy1jb3BpZXMgdGhpc1xuICAgICAgICBuYXJyYXRpdmVHZW5lcmF0b3IsIC8vIFNoYXJlIHBhcmVudCdzIOKAlCBhbGwgZXZlbnRzIGZsb3cgdG8gb25lIHBsYWNlXG4gICAgICAgIGxvZ2dlcjogcGFyZW50T3B0cy5sb2dnZXIsXG4gICAgICAgIHNpZ25hbDogcGFyZW50T3B0cy5zaWduYWwsXG4gICAgICAgIG1heERlcHRoOiB0aGlzLl9tYXhEZXB0aCxcbiAgICAgICAgLi4uKHRoaXMuX21heEl0ZXJhdGlvbnMgIT09IHVuZGVmaW5lZCAmJiB7IG1heEl0ZXJhdGlvbnM6IHRoaXMuX21heEl0ZXJhdGlvbnMgfSksXG4gICAgICAgIHBhcmVudFN1YmZsb3dJZDogc3ViZmxvd09wdHMuc3ViZmxvd0lkLFxuICAgICAgICAvLyBSRkMtMDAzIEQxOiB0aGUgbW91bnQgc3RhZ2UncyBydW50aW1lU3RhZ2VJZCDigJQgcGFyZW50IGZhbGxiYWNrIGZvclxuICAgICAgICAvLyB0aGUgc3ViZmxvdydzIHJvb3Qgc3RhZ2Ugc28gYW5jZXN0b3IgY2hhaW5zIGNyb3NzIHRoZSBib3VuZGFyeS5cbiAgICAgICAgcGFyZW50TW91bnRSdW50aW1lU3RhZ2VJZDogc3ViZmxvd09wdHMucGFyZW50TW91bnRSdW50aW1lU3RhZ2VJZCxcbiAgICAgICAgZXhlY3V0aW9uQ291bnRlcjogdGhpcy5fZXhlY3V0aW9uQ291bnRlciwgLy8gU2hhcmUgY291bnRlciDigJQgc3ViZmxvdyBjb250aW51ZXMgZ2xvYmFsIG51bWJlcmluZ1xuICAgICAgICB2aXNpdENvdW50czogdGhpcy5fdmlzaXRDb3VudHMsIC8vIFNoYXJlIHZpc2l0IGNvdW50cyDigJQgbG9vcEl0ZXJhdGlvbiBzdGF5cyBtb25vdG9uaWMgYWNyb3NzIHN1YmZsb3cgcmUtbW91bnRzXG4gICAgICAgIHJ1bklkOiB0aGlzLnJ1bklkLCAvLyBTdWJmbG93IGluaGVyaXRzIHBhcmVudCdzIHJ1bklkIOKAlCBzYW1lIGxvZ2ljYWwgcnVuXG4gICAgICAgIC8vIEZvcndhcmQgdGhlIHJlc3VtZS1vbmx5IHN1YmZsb3cgc2NvcGUgY2FwdHVyZXMgc28gbmVzdGVkXG4gICAgICAgIC8vIFN1YmZsb3dFeGVjdXRvcnMgY2FuIHJlLXNlZWQgZGVlcGVyLW5lc3RlZCBydW50aW1lcyAoZS5nLlxuICAgICAgICAvLyBTZXF1ZW5jZShBZ2VudCguLi4pKSB3aGVyZSB0aGUgaW5uZXIgQWdlbnQgc3ViZmxvdyBwYXVzZWQpLlxuICAgICAgICAuLi4ocGFyZW50T3B0cy5zdWJmbG93U3RhdGVzRm9yUmVzdW1lICYmIHtcbiAgICAgICAgICBzdWJmbG93U3RhdGVzRm9yUmVzdW1lOiBwYXJlbnRPcHRzLnN1YmZsb3dTdGF0ZXNGb3JSZXN1bWUsXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGV4ZWN1dGU6ICgpID0+IHRyYXZlcnNlci5leGVjdXRlKCksXG4gICAgICAgIGdldFN1YmZsb3dSZXN1bHRzOiAoKSA9PiB0cmF2ZXJzZXIuZ2V0U3ViZmxvd1Jlc3VsdHMoKSxcbiAgICAgICAgZ2V0QnJlYWtTdGF0ZTogKCkgPT4gdHJhdmVyc2VyLmdldEJyZWFrU3RhdGUoKSxcbiAgICAgIH07XG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRGVwcyhvcHRzOiBUcmF2ZXJzZXJPcHRpb25zPFRPdXQsIFRTY29wZT4pOiBIYW5kbGVyRGVwczxUT3V0LCBUU2NvcGU+IHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhZ2VNYXA6IHRoaXMuc3RhZ2VNYXAsXG4gICAgICByb290OiB0aGlzLnJvb3QsXG4gICAgICBleGVjdXRpb25SdW50aW1lOiB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUsXG4gICAgICBzY29wZUZhY3Rvcnk6IG9wdHMuc2NvcGVGYWN0b3J5LFxuICAgICAgc3ViZmxvd3M6IHRoaXMuc3ViZmxvd3MsXG4gICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyOiBvcHRzLnRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgICBzdHJlYW1IYW5kbGVyczogb3B0cy5zdHJlYW1IYW5kbGVycyxcbiAgICAgIHNjb3BlUHJvdGVjdGlvbk1vZGU6IG9wdHMuc2NvcGVQcm90ZWN0aW9uTW9kZSA/PyAnZXJyb3InLFxuICAgICAgcmVhZE9ubHlDb250ZXh0OiBvcHRzLnJlYWRPbmx5Q29udGV4dCxcbiAgICAgIGV4ZWN1dGlvbkVudjogb3B0cy5leGVjdXRpb25FbnYsXG4gICAgICBuYXJyYXRpdmVHZW5lcmF0b3I6IHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLFxuICAgICAgbG9nZ2VyOiB0aGlzLmxvZ2dlcixcbiAgICAgIHNpZ25hbDogb3B0cy5zaWduYWwsXG4gICAgICAuLi4ob3B0cy5zdWJmbG93U3RhdGVzRm9yUmVzdW1lICYmIHtcbiAgICAgICAgc3ViZmxvd1N0YXRlc0ZvclJlc3VtZTogb3B0cy5zdWJmbG93U3RhdGVzRm9yUmVzdW1lLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCBQdWJsaWMgQVBJIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBIb2xkcyB0aGUgdG9wLWxldmVsIGJyZWFrIGZsYWcgZm9yIHRoZSBkdXJhdGlvbiBvZiBgZXhlY3V0ZSgpYC4gS2VwdCBhc1xuICAgKiBhIGZpZWxkIChub3QgYSBsb2NhbCkgc28gYGdldEJyZWFrU3RhdGUoKWAgY2FuIHN1cmZhY2UgdGhlIGZpbmFsIHN0YXRlXG4gICAqIGZvciBjYWxsZXJzIGxpa2UgYFN1YmZsb3dFeGVjdXRvcmAgdGhhdCBpbXBsZW1lbnQgYHByb3BhZ2F0ZUJyZWFrYC5cbiAgICovXG4gIHByaXZhdGUgX3RvcEJyZWFrRmxhZzogeyBzaG91bGRCcmVhazogYm9vbGVhbjsgcmVhc29uPzogc3RyaW5nIH0gPSB7IHNob3VsZEJyZWFrOiBmYWxzZSB9O1xuXG4gIGFzeW5jIGV4ZWN1dGUoYnJhbmNoUGF0aD86IHN0cmluZyk6IFByb21pc2U8VHJhdmVyc2FsUmVzdWx0PiB7XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuZXhlY3V0aW9uUnVudGltZS5yb290U3RhZ2VDb250ZXh0O1xuICAgIHRoaXMuX3RvcEJyZWFrRmxhZyA9IHsgc2hvdWxkQnJlYWs6IGZhbHNlIH07XG5cbiAgICAvLyBGaXJlIG9uUnVuU3RhcnQgT05MWSBhdCB0aGUgdG9wLWxldmVsIHRyYXZlcnNhbCDigJQgc3ViZmxvdyB0cmF2ZXJzZXJzXG4gICAgLy8gYWxyZWFkeSBwcm9kdWNlIG9uU3ViZmxvd0VudHJ5L29uU3ViZmxvd0V4aXQgcGFpcnMsIHNvIGVtaXR0aW5nIHJ1blxuICAgIC8vIGV2ZW50cyBmb3IgdGhlbSB3b3VsZCBkb3VibGUtYnJhY2tldCB0aGUgYm91bmRhcnkgc3RyZWFtLiBUaGVcbiAgICAvLyB0b3AtbGV2ZWwgdHJhdmVyc2VyIGlzIHRoZSBvbmUgd2l0aG91dCBhIHBhcmVudFN1YmZsb3dJZC5cbiAgICBjb25zdCBpc1RvcExldmVsID0gdGhpcy5wYXJlbnRTdWJmbG93SWQgPT09IHVuZGVmaW5lZDtcbiAgICAvLyBTeW50aGV0aWMgVHJhdmVyc2FsQ29udGV4dCBmb3IgcnVuLmVudHJ5IC8gcnVuLmV4aXQuIEZpZWxkcyB1c2VcbiAgICAvLyByb290LXN0YWdlIGRlZmF1bHRzIChzdGFnZUlkPSdfX3Jvb3RfXycsIHJ1bnRpbWVTdGFnZUlkPSdfX3Jvb3RfXyMwJyxcbiAgICAvLyBkZXB0aCAwKSBzbyB0aGUgcnVuSWQgaXMgcmVsaWFibHkgYXZhaWxhYmxlIG9uIHJ1biBldmVudHMgd2l0aG91dFxuICAgIC8vIGZvcmNpbmcgcmVjb3JkZXJzIHRvIGhhbmRsZSBgdHJhdmVyc2FsQ29udGV4dCA9PT0gdW5kZWZpbmVkYC5cbiAgICBjb25zdCByb290Q29udGV4dDogVHJhdmVyc2FsQ29udGV4dCA9IHtcbiAgICAgIHJ1bklkOiB0aGlzLnJ1bklkLFxuICAgICAgc3RhZ2VJZDogJ19fcm9vdF9fJyxcbiAgICAgIHJ1bnRpbWVTdGFnZUlkOiAnX19yb290X18jMCcsXG4gICAgICBzdGFnZU5hbWU6ICdfX3Jvb3RfXycsXG4gICAgICBkZXB0aDogMCxcbiAgICB9O1xuICAgIGlmIChpc1RvcExldmVsKSB7XG4gICAgICAvLyBgcmVhZE9ubHlDb250ZXh0YCBpcyB0aGUgZW5naW5lJ3MgdmlldyBvZiBgcnVuKHtpbnB1dH0pYCDigJQgcGFzc2VkXG4gICAgICAvLyB0aHJvdWdoIGZyb20gYEZsb3dDaGFydEV4ZWN1dG9yLnJ1bigpYCBhcyB0aGUgdmFsaWRhdGVkIGlucHV0LlxuICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25SdW5TdGFydCh0aGlzLnJlYWRPbmx5Q29udGV4dCwgcm9vdENvbnRleHQpO1xuICAgIH1cblxuICAgIC8vIFRvcC1sZXZlbCBydW5zIGNsb3NlIHRoZWlyIGJvdW5kYXJ5IFNZTU1FVFJJQ0FMTFk6IGV2ZXJ5IG9uUnVuU3RhcnRcbiAgICAvLyBpcyBmb2xsb3dlZCBieSBleGFjdGx5IG9uZSBvblJ1bkVuZCAoY2xlYW4pIG9yIG9uUnVuRmFpbGVkIChlcnJvcikuXG4gICAgLy8gV2l0aG91dCB0aGUgY2F0Y2gsIGEgdGhyb3duIHJ1biBmaXJlZCBvblJ1blN0YXJ0IHRoZW4gbm90aGluZyDigJQgYVxuICAgIC8vIG1vbml0b3IgY291bGRuJ3QgdGVsbCBcInN0aWxsIHJ1bm5pbmdcIiBmcm9tIFwiY3Jhc2hlZC5cIiBQYXVzZSBpcyBOT1RcbiAgICAvLyBhbiBlcnJvciAoaXQncyBleHBlY3RlZCBzdXNwZW5zaW9uKSwgc28gaXQgc2tpcHMgb25SdW5GYWlsZWQgYW5kXG4gICAgLy8gcmUtdGhyb3dzIHVudG91Y2hlZC4gVGhlIHN0YWdlLWxldmVsIGNhdGNoIGFscmVhZHkgcmVjb3JkZWQgdGhlXG4gICAgLy8gZmFpbGluZyBzdGFnZSAob25FcnJvciArIGNvbW1pdCk7IHRoaXMgYWRkcyB0aGUgcnVuLWxldmVsIHRlcm1pbmFsXG4gICAgLy8gc2lnbmFsLiBUaGUgZXJyb3Igc3RpbGwgcHJvcGFnYXRlcyDigJQgdGhpcyBpcyBvYnNlcnZhdGlvbiwgbm90XG4gICAgLy8gcmVjb3ZlcnkuIFN1YmZsb3cgdHJhdmVyc2VycyBkb24ndCBmaXJlIHJ1biBldmVudHM7IHRoZWlyIGVycm9yc1xuICAgIC8vIGJ1YmJsZSB1cCBhbmQgc3VyZmFjZSBoZXJlIGF0IHRoZSB0b3AgbGV2ZWwuXG4gICAgaWYgKCFpc1RvcExldmVsKSB7XG4gICAgICByZXR1cm4gdGhpcy5leGVjdXRlTm9kZSh0aGlzLnJvb3QsIGNvbnRleHQsIHRoaXMuX3RvcEJyZWFrRmxhZywgYnJhbmNoUGF0aCA/PyAnJyk7XG4gICAgfVxuICAgIGxldCByZXN1bHQ6IFRyYXZlcnNhbFJlc3VsdDtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlTm9kZSh0aGlzLnJvb3QsIGNvbnRleHQsIHRoaXMuX3RvcEJyZWFrRmxhZywgYnJhbmNoUGF0aCA/PyAnJyk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIGlmICghaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25SdW5GYWlsZWQoZXh0cmFjdEVycm9ySW5mbyhlcnJvciksIHJvb3RDb250ZXh0KTtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblJ1bkVuZChyZXN1bHQsIHJvb3RDb250ZXh0KTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLyoqXG4gICAqIEJyZWFrIHN0YXRlIGNhcHR1cmVkIGF0IHRoZSB0b3AtbGV2ZWwgb2YgdGhlIG1vc3QgcmVjZW50IGBleGVjdXRlKClgLlxuICAgKiBgc2hvdWxkQnJlYWtgIGlzIHRydWUgd2hlbiBhIHN0YWdlIGNhbGxlZCBgc2NvcGUuJGJyZWFrKHJlYXNvbilgOyB0aGVcbiAgICogb3B0aW9uYWwgYHJlYXNvbmAgY2FycmllcyB0aGUgc3RyaW5nIHBhc3NlZCB0byBgJGJyZWFrYC5cbiAgICpcbiAgICogVXNlZCBieSBgU3ViZmxvd0V4ZWN1dG9yYCB0byBwcm9wYWdhdGUgYW4gaW5uZXIgc3ViZmxvdydzIGJyZWFrIHVwIHRvXG4gICAqIHRoZSBwYXJlbnQgdHJhdmVyc2VyIHdoZW4gdGhlIG1vdW50IHNldHMgYHByb3BhZ2F0ZUJyZWFrOiB0cnVlYC5cbiAgICovXG4gIGdldEJyZWFrU3RhdGUoKTogeyBzaG91bGRCcmVhazogYm9vbGVhbjsgcmVhc29uPzogc3RyaW5nIH0ge1xuICAgIHJldHVybiB7IC4uLnRoaXMuX3RvcEJyZWFrRmxhZyB9O1xuICB9XG5cbiAgZ2V0UnVudGltZVN0cnVjdHVyZSgpOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLnN0cnVjdHVyZU1hbmFnZXIuZ2V0U3RydWN0dXJlKCk7XG4gIH1cblxuICBnZXRTbmFwc2hvdChvcHRpb25zPzogeyByZWRhY3Q/OiBib29sZWFuIH0pIHtcbiAgICAvLyBTdGFtcCB0aGUgcnVuJ3MgaWQgb250byB0aGUgcnVudGltZSBzbmFwc2hvdCBoZXJlIOKAlCB0aGUgdHJhdmVyc2VyIGlzXG4gICAgLy8gdGhlIHNpbmdsZSBhdXRob3JpdHkgZm9yIGBydW5JZGAgKGl0IGFscmVhZHkgc3RhbXBzIHRoZSBzYW1lIHZhbHVlIG9uXG4gICAgLy8gZXZlcnkgVHJhdmVyc2FsQ29udGV4dC9ldmVudCksIHdoaWxlIHRoZSBydW50aW1lIGlzIHJ1bi1hZ25vc3RpY1xuICAgIC8vIG1lbW9yeSAoaXRzIGdldFNuYXBzaG90IHJldHVybnMgT21pdDxSdW50aW1lU25hcHNob3QsICdydW5JZCc+KS5cbiAgICAvLyBGcmVzaCBwZXIgcnVuKCkgQU5EIHBlciByZXN1bWUoKSDigJQgc2VlIHJ1bm5lci9ydW5JZC50cy5cbiAgICByZXR1cm4geyAuLi50aGlzLmV4ZWN1dGlvblJ1bnRpbWUuZ2V0U25hcHNob3Qob3B0aW9ucyksIHJ1bklkOiB0aGlzLnJ1bklkIH07XG4gIH1cblxuICBnZXRSdW50aW1lKCkge1xuICAgIHJldHVybiB0aGlzLmV4ZWN1dGlvblJ1bnRpbWU7XG4gIH1cblxuICBzZXRSb290T2JqZWN0KHBhdGg6IHN0cmluZ1tdLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUuc2V0Um9vdE9iamVjdChwYXRoLCBrZXksIHZhbHVlKTtcbiAgfVxuXG4gIGdldEJyYW5jaElkcygpIHtcbiAgICByZXR1cm4gdGhpcy5leGVjdXRpb25SdW50aW1lLmdldFBpcGVsaW5lcygpO1xuICB9XG5cbiAgZ2V0UnVudGltZVJvb3QoKTogU3RhZ2VOb2RlIHtcbiAgICByZXR1cm4gdGhpcy5yb290O1xuICB9XG5cbiAgZ2V0U3ViZmxvd1Jlc3VsdHMoKTogTWFwPHN0cmluZywgU3ViZmxvd1Jlc3VsdD4ge1xuICAgIHJldHVybiB0aGlzLnN1YmZsb3dSZXN1bHRzO1xuICB9XG5cbiAgZ2V0TmFycmF0aXZlKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3IuZ2V0U2VudGVuY2VzKCk7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgRmxvd1JlY29yZGVyRGlzcGF0Y2hlciwgb3IgdW5kZWZpbmVkIGlmIG5hcnJhdGl2ZSBpcyBkaXNhYmxlZC4gKi9cbiAgZ2V0Rmxvd1JlY29yZGVyRGlzcGF0Y2hlcigpOiBGbG93UmVjb3JkZXJEaXNwYXRjaGVyIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5mbG93UmVjb3JkZXJEaXNwYXRjaGVyO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIENvcmUgVHJhdmVyc2FsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBCdWlsZCBhbiBPKDEpIElE4oaSbm9kZSBtYXAgZnJvbSB0aGUgcm9vdCBncmFwaC5cbiAgICogVXNlZCBieSBOb2RlUmVzb2x2ZXIgdG8gYXZvaWQgcmVwZWF0ZWQgREZTIG9uIGV2ZXJ5IGxvb3BUbygpIGNhbGwuXG4gICAqIEl0ZXJhdGl2ZSB3b3JrbGlzdCAobm8gcmVjdXJzaW9uKSBzbyBhcmJpdHJhcmlseSBsb25nIGNoYWlucyBpbmRleCBmdWxseTtcbiAgICogdGhlIGBtYXAuaGFzYCBndWFyZCBoYW5kbGVzIGN5Y2xpYyByZWZzLiBGaXJzdC12aXNpdGVkIG5vZGUgd2lucyBwZXIgSUQg4oCUXG4gICAqIHdvcmtsaXN0IG9yZGVyIG1hdGNoZXMgdGhlIG9sZCByZWN1cnNpdmUgcHJlLW9yZGVyIChjaGlsZHJlbiwgdGhlbiBuZXh0KS5cbiAgICogRHluYW1pYyBzdWJmbG93cyBhbmQgbGF6eS1yZXNvbHZlZCBub2RlcyBhcmUgYWRkZWQgdG8gc3RhZ2VNYXAgYXQgcnVudGltZSBidXQgbm90IHRvIHRoaXMgbWFwIOKAlFxuICAgKiB0aG9zZSB1c2UgdGhlIERGUyBmYWxsYmFjayBpbiBOb2RlUmVzb2x2ZXIuXG4gICAqL1xuICBwcml2YXRlIGJ1aWxkTm9kZUlkTWFwKHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KTogTWFwPHN0cmluZywgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4+IHtcbiAgICBjb25zdCBtYXAgPSBuZXcgTWFwPHN0cmluZywgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4+KCk7XG4gICAgY29uc3Qgc3RhY2s6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+W10gPSBbcm9vdF07XG4gICAgd2hpbGUgKHN0YWNrLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5vZGUgPSBzdGFjay5wb3AoKSE7XG4gICAgICBpZiAobWFwLmhhcyhub2RlLmlkKSkgY29udGludWU7IC8vIGFscmVhZHkgdmlzaXRlZCAoYXZvaWRzIGluZmluaXRlIGxvb3BzIG9uIGN5Y2xpYyByZWZzKVxuICAgICAgbWFwLnNldChub2RlLmlkLCBub2RlKTtcbiAgICAgIC8vIFB1c2ggaW4gcmV2ZXJzZSB2aXNpdCBvcmRlciAoTElGTyBzdGFjayk6IG5leHQgZmlyc3QsIHRoZW4gY2hpbGRyZW5cbiAgICAgIC8vIHJldmVyc2VkIOKAlCBzbyBjaGlsZHJlbiBhcmUgdmlzaXRlZCBiZWZvcmUgbmV4dCwgZmlyc3QgY2hpbGQgZmlyc3QsXG4gICAgICAvLyBtYXRjaGluZyB0aGUgcmVjdXJzaXZlIHByZS1vcmRlciBleGFjdGx5LlxuICAgICAgaWYgKG5vZGUubmV4dCkgc3RhY2sucHVzaChub2RlLm5leHQpO1xuICAgICAgaWYgKG5vZGUuY2hpbGRyZW4pIHtcbiAgICAgICAgZm9yIChsZXQgaSA9IG5vZGUuY2hpbGRyZW4ubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHN0YWNrLnB1c2gobm9kZS5jaGlsZHJlbltpXSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBtYXA7XG4gIH1cblxuICBwcml2YXRlIGdldFN0YWdlRm4obm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4gfCB1bmRlZmluZWQge1xuICAgIGlmICh0eXBlb2Ygbm9kZS5mbiA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIG5vZGUuZm4gYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+O1xuICAgIC8vIFByaW1hcnk6IGxvb2sgdXAgYnkgaWQgKHN0YWJsZSBpZGVudGlmaWVyLCBrZXllZCBieSBGbG93Q2hhcnRCdWlsZGVyKVxuICAgIGNvbnN0IGJ5SWQgPSB0aGlzLnN0YWdlTWFwLmdldChub2RlLmlkKTtcbiAgICBpZiAoYnlJZCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYnlJZDtcbiAgICAvLyBGYWxsYmFjazogbG9vayB1cCBieSBuYW1lIChzdXBwb3J0cyBoYW5kLWNyYWZ0ZWQgc3RhZ2VNYXBzIGluIHRlc3RzIGFuZCBhZHZhbmNlZCB1c2UpXG4gICAgcmV0dXJuIHRoaXMuc3RhZ2VNYXAuZ2V0KG5vZGUubmFtZSk7XG4gIH1cblxuICAvLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgRHluYW1pYy1wYXRjaCBvdmVybGF5IGFjY2Vzc29ycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy9cbiAgLy8gRXZlcnkgZW5naW5lIHJlYWQgb2YgYSBmaWVsZCB0aGF0IFBoYXNlIDQgY2FuIHBhdGNoIChjaGlsZHJlbixcbiAgLy8gbmV4dE5vZGVTZWxlY3Rvciwgc3ViZmxvdyBtZXRhKSBnb2VzIHRocm91Z2ggdGhlc2UuIEZhc3QgcGF0aDogY2hhcnRzXG4gIC8vIHdpdGggbm8gZHluYW1pYyByZXR1cm5zIG5ldmVyIGFsbG9jYXRlIGFuZCBwYXkgb25lIGBzaXplID09PSAwYCBjaGVjay5cblxuICBwcml2YXRlIGdldFBhdGNoKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KTogRHluYW1pY05vZGVQYXRjaDxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICBpZiAodGhpcy5wYXRjaENvdW50ID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHJldHVybiB0aGlzLmR5bmFtaWNQYXRjaGVzLmdldChub2RlKTtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0T3JDcmVhdGVQYXRjaChub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IER5bmFtaWNOb2RlUGF0Y2g8VE91dCwgVFNjb3BlPiB7XG4gICAgbGV0IHBhdGNoID0gdGhpcy5keW5hbWljUGF0Y2hlcy5nZXQobm9kZSk7XG4gICAgaWYgKCFwYXRjaCkge1xuICAgICAgcGF0Y2ggPSB7fTtcbiAgICAgIHRoaXMuZHluYW1pY1BhdGNoZXMuc2V0KG5vZGUsIHBhdGNoKTtcbiAgICAgIHRoaXMucGF0Y2hDb3VudCsrO1xuICAgIH1cbiAgICByZXR1cm4gcGF0Y2g7XG4gIH1cblxuICAvKiogRWZmZWN0aXZlIGNoaWxkcmVuOiBkeW5hbWljIHBhdGNoIGZpcnN0LCB0aGVuIHRoZSBidWlsdCBub2RlJ3MgY2hpbGRyZW4uICovXG4gIHByaXZhdGUgZWZmQ2hpbGRyZW4obm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPltdIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5nZXRQYXRjaChub2RlKT8uY2hpbGRyZW4gPz8gbm9kZS5jaGlsZHJlbjtcbiAgfVxuXG4gIC8qKiBFZmZlY3RpdmUgb3V0cHV0LWJhc2VkIHNlbGVjdG9yOiBkeW5hbWljIHBhdGNoIGZpcnN0LCB0aGVuIHRoZSBidWlsdCBub2RlJ3MuICovXG4gIHByaXZhdGUgZWZmU2VsZWN0b3Iobm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBTZWxlY3RvciB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuZ2V0UGF0Y2gobm9kZSk/Lm5leHROb2RlU2VsZWN0b3IgPz8gbm9kZS5uZXh0Tm9kZVNlbGVjdG9yO1xuICB9XG5cbiAgLyoqIEVmZmVjdGl2ZSBzdWJmbG93LXJvb3QgbWFya2VyICh0cnVlIHdoZW4gYSBkeW5hbWljIHN1YmZsb3cgd2FzIHBhdGNoZWQgb24pLiAqL1xuICBwcml2YXRlIGVmZklzU3ViZmxvd1Jvb3Qobm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBib29sZWFuIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBtZXRhID0gdGhpcy5nZXRQYXRjaChub2RlKT8uc3ViZmxvd01ldGE7XG4gICAgcmV0dXJuIG1ldGEgPyB0cnVlIDogbm9kZS5pc1N1YmZsb3dSb290O1xuICB9XG5cbiAgLyoqIEVmZmVjdGl2ZSBzdWJmbG93IGlkIChwYXRjaGVkIHZlcmJhdGltIGJ5IGEgZHluYW1pYyBzdWJmbG93IHJldHVybikuICovXG4gIHByaXZhdGUgZWZmU3ViZmxvd0lkKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBtZXRhID0gdGhpcy5nZXRQYXRjaChub2RlKT8uc3ViZmxvd01ldGE7XG4gICAgcmV0dXJuIG1ldGEgPyBtZXRhLnN1YmZsb3dJZCA6IG5vZGUuc3ViZmxvd0lkO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hdGVyaWFsaXplIHRoZSBlZmZlY3RpdmUgdmlldyBvZiBhIG5vZGUg4oCUIGZpZWxkLWlkZW50aWNhbCB0byB3aGF0IHRoZVxuICAgKiBwcmUtb3ZlcmxheSBjb2RlIHByb2R1Y2VkIGJ5IG11dGF0aW5nIHRoZSBzaGFyZWQgbm9kZS4gVXNlZCB3aGVyZSBhIG5vZGVcbiAgICogaXMgaGFuZGVkIHRvIGEgaGVscGVyIGV4ZWN1dG9yIChOb2RlUmVzb2x2ZXIgLyBTdWJmbG93RXhlY3V0b3IgL1xuICAgKiBDaGlsZHJlbkV4ZWN1dG9yKSBzbyBoZWxwZXJzIG5ldmVyIHJlYWQgc3RhbGUgYnVpbHQgZmllbGRzLiBSZXR1cm5zIHRoZVxuICAgKiBub2RlIGl0c2VsZiAobm8gYWxsb2NhdGlvbikgd2hlbiBpdCBjYXJyaWVzIG5vIHBhdGNoLlxuICAgKi9cbiAgcHJpdmF0ZSBlZmZOb2RlKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4ge1xuICAgIGNvbnN0IHBhdGNoID0gdGhpcy5nZXRQYXRjaChub2RlKTtcbiAgICBpZiAoIXBhdGNoKSByZXR1cm4gbm9kZTtcbiAgICBjb25zdCBtZXJnZWQ6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyAuLi5ub2RlIH07XG4gICAgaWYgKHBhdGNoLnN1YmZsb3dNZXRhKSB7XG4gICAgICBtZXJnZWQuaXNTdWJmbG93Um9vdCA9IHRydWU7XG4gICAgICBtZXJnZWQuc3ViZmxvd0lkID0gcGF0Y2guc3ViZmxvd01ldGEuc3ViZmxvd0lkO1xuICAgICAgbWVyZ2VkLnN1YmZsb3dOYW1lID0gcGF0Y2guc3ViZmxvd01ldGEuc3ViZmxvd05hbWU7XG4gICAgICBtZXJnZWQuc3ViZmxvd01vdW50T3B0aW9ucyA9IHBhdGNoLnN1YmZsb3dNZXRhLnN1YmZsb3dNb3VudE9wdGlvbnM7XG4gICAgfVxuICAgIGlmIChwYXRjaC5jaGlsZHJlbikgbWVyZ2VkLmNoaWxkcmVuID0gcGF0Y2guY2hpbGRyZW47XG4gICAgaWYgKHBhdGNoLm5leHROb2RlU2VsZWN0b3IpIG1lcmdlZC5uZXh0Tm9kZVNlbGVjdG9yID0gcGF0Y2gubmV4dE5vZGVTZWxlY3RvcjtcbiAgICByZXR1cm4gbWVyZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlU3RhZ2UoXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgc3RhZ2VGdW5jOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyZWFrRm46ICgpID0+IHZvaWQsXG4gICkge1xuICAgIC8vIHJ1bnRpbWVTdGFnZUlkIGlzIGFzc2lnbmVkIGluIGV4ZWN1dGVOb2RlKCkgYmVmb3JlIHRyYXZlcnNhbENvbnRleHQgY3JlYXRpb24sXG4gICAgLy8gZW5zdXJpbmcgc2NvcGUgZXZlbnRzIGFuZCBmbG93IGV2ZW50cyB1c2UgdGhlIHNhbWUgdmFsdWUuXG4gICAgcmV0dXJuIHRoaXMuc3RhZ2VSdW5uZXIucnVuKG5vZGUsIHN0YWdlRnVuYywgY29udGV4dCwgYnJlYWtGbik7XG4gIH1cblxuICAvKipcbiAgICogVHJhbXBvbGluZSBkcml2ZXIg4oCUIHByZS1vcmRlciBERlMgdHJhdmVyc2FsIGVudHJ5IHBvaW50LlxuICAgKlxuICAgKiBSdW5zIGBleGVjdXRlTm9kZVN0ZXBgIChvbmUgbm9kZSwgYWxsIDcgcGhhc2VzKSBpbiBhIGZsYXQgbG9vcDogZXZlcnlcbiAgICogVEFJTCBjb250aW51YXRpb24gKGxpbmVhciBgbmV4dGAsIGxvb3AgZWRnZSwgZHluYW1pYyBuZXh0IC8gZHluYW1pY1xuICAgKiByZS1lbnRyeSwgbm8tY29udGludWF0aW9uIGRlY2lkZXIgZGlzcGF0Y2gpIGNvbWVzIGJhY2sgYXMgYVxuICAgKiBgQ29udGludWF0aW9uSG9wYCBhbmQgaXMgZm9sbG93ZWQgSVRFUkFUSVZFTFkg4oCUIG5laXRoZXIgdGhlIGNhbGwgc3RhY2tcbiAgICogbm9yIHRoZSByZXRhaW5lZCBwcm9taXNlIGNoYWluIGdyb3dzIHdpdGggY2hhaW4gbGVuZ3RoIG9yIGxvb3AgY291bnQuXG4gICAqXG4gICAqIFJlY3Vyc2lvbiByZW1haW5zIE9OTFkgZm9yIHRydWUgdHJlZSBuZXN0aW5nIChlYWNoIGdldHMgYSBuZXN0ZWQgZHJpdmVyXG4gICAqIGNhbGwpOiBmb3JrIGNoaWxkcmVuIChgQ2hpbGRyZW5FeGVjdXRvcmApLCBzZWxlY3RvciBicmFuY2hlcyAocGFyYWxsZWxcbiAgICogZmFuLW91dCksIGRlY2lkZXIgYnJhbmNoIGRpc3BhdGNoIHdoZW4gdGhlIGRlY2lkZXIgaGFzIGl0cyBvd24gYG5leHRgXG4gICAqICh0aGUgYnJhbmNoIG11c3QgY29tcGxldGUgQkVGT1JFIHRoZSBkZWNpZGVyJ3MgY29udGludWF0aW9uIHJ1bnMpLCBhbmRcbiAgICogc3ViZmxvdyBtb3VudHMgKGZyZXNoIHRyYXZlcnNlcjsgdGhlIG1vdW50IGZyYW1lIHN0YXlzIGluIHRoZSBwYXJlbnQpLlxuICAgKiBgX2V4ZWN1dGVEZXB0aGAgdGhlcmVmb3JlIGNvdW50cyBjaGFydCBDT01QT1NJVElPTiBkZXB0aCBvbmx5LCBndWFyZGVkXG4gICAqIGJ5IGBfbWF4RGVwdGhgIChkZWZhdWx0IGBNQVhfRVhFQ1VURV9ERVBUSGAgPSA1MDApLlxuICAgKlxuICAgKiBQYXVzZVNpZ25hbDogYSBmbGF0IGRlY2lkZXIgZGlzcGF0Y2ggcmVjb3JkcyBhbiBgSW52b2tlclN0YW1wYDsgaWYgdGhlXG4gICAqIGNvbnRpbnVlZCBjaGFpbiBsYXRlciBwYXVzZXMsIHRoZSBkcml2ZXIgc3RhbXBzIHRoZSBzaWduYWwgZHVyaW5nXG4gICAqIHVud2luZCDigJQgc2FtZSBpbnZva2VyIGNvbnRleHQgdGhlIHJlY3Vyc2l2ZSBkaXNwYXRjaCdzIGNhdGNoIHVzZWQgdG9cbiAgICogc3RhbXAsIGlubmVybW9zdCAobW9zdCByZWNlbnQgZGlzcGF0Y2gpIGZpcnN0LlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlTm9kZShcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICAgYnJlYWtGbGFnOiBCcmVha0ZsYWcsXG4gICAgYnJhbmNoUGF0aD86IHN0cmluZyxcbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICAvLyBJbnZva2VyIHN0YW1wcyBmcm9tIGZsYXQgZGVjaWRlciBkaXNwYXRjaGVzIGluIFRISVMgZHJpdmVyIOKAlCBrZXB0XG4gICAgLy8gbG9jYWwgc28gbmVzdGVkIGRyaXZlcnMgKGZvcmsgY2hpbGRyZW4sIHdpdGgtbmV4dCBkZWNpZGVyIGJyYW5jaGVzKVxuICAgIC8vIGdldCB0aGVpciBvd24gd2luZG93cywgbWF0Y2hpbmcgdGhlIG9sZCBmcmFtZS1vbi1zdGFjayBzdGFtcGluZyBzY29wZS5cbiAgICBsZXQgcGVuZGluZ0ludm9rZXJzOiBJbnZva2VyU3RhbXBbXSB8IHVuZGVmaW5lZDtcbiAgICAvLyDilIDilIDilIAgVHJlZS1kZXB0aCBndWFyZCDilIDilIDilIBcbiAgICAvLyBUaGUgaW5jcmVtZW50IGlzIGluc2lkZSBgdHJ5YCBzbyBgZmluYWxseWAgYWx3YXlzIGRlY3JlbWVudHMg4oCUIG5vXG4gICAgLy8gZnJhZ2lsZSBnYXAgYmV0d2VlbiBjaGVjayBhbmQgdHJ5IGVudHJ5LlxuICAgIHRyeSB7XG4gICAgICBpZiAoKyt0aGlzLl9leGVjdXRlRGVwdGggPiB0aGlzLl9tYXhEZXB0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEZsb3djaGFydFRyYXZlcnNlcjogbWF4aW11bSB0cmF2ZXJzYWwgZGVwdGggZXhjZWVkZWQgKCR7dGhpcy5fbWF4RGVwdGh9KS4gYCArXG4gICAgICAgICAgICAnRGVwdGggY291bnRzIE5FU1RFRCBkaXNwYXRjaCAoZm9yayBjaGlsZHJlbiwgZGVjaWRlci9zZWxlY3RvciBicmFuY2hlcywgcmVjdXJzaXZlIGNvbXBvc2l0aW9uKSDigJQgJyArXG4gICAgICAgICAgICAnbGluZWFyIGNoYWlucyBhbmQgbG9vcCBpdGVyYXRpb25zIHJ1biBmbGF0IGFuZCBkbyBub3QgY29uc3VtZSBpdC4gJyArXG4gICAgICAgICAgICBgTGFzdCBzdGFnZTogJyR7bm9kZS5uYW1lfScuIGAgK1xuICAgICAgICAgICAgJ0NoZWNrIGZvciB1bmJvdW5kZWQgcmVjdXJzaXZlIGNoYXJ0IGNvbXBvc2l0aW9uLCBvciByYWlzZSB0aGUgbGltaXQgdmlhIFJ1bk9wdGlvbnMubWF4RGVwdGguJyxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbGV0IGN1cnJlbnQ6IENvbnRpbnVhdGlvbkhvcDxUT3V0LCBUU2NvcGU+ID0geyBbQ09OVElOVUVfSE9QXTogdHJ1ZSwgbm9kZSwgY29udGV4dCwgYnJhbmNoUGF0aCB9O1xuICAgICAgZm9yICg7Oykge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVOb2RlU3RlcChjdXJyZW50Lm5vZGUsIGN1cnJlbnQuY29udGV4dCwgYnJlYWtGbGFnLCBjdXJyZW50LmJyYW5jaFBhdGgpO1xuICAgICAgICBpZiAoIWlzQ29udGludWF0aW9uSG9wPFRPdXQsIFRTY29wZT4ocmVzdWx0KSkge1xuICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5pbnZva2VyU3RhbXApIChwZW5kaW5nSW52b2tlcnMgPz89IFtdKS5wdXNoKHJlc3VsdC5pbnZva2VyU3RhbXApO1xuICAgICAgICBjdXJyZW50ID0gcmVzdWx0O1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgICAvLyBSZXBsYXkgaW52b2tlciBzdGFtcHMgbW9zdC1yZWNlbnQtZmlyc3QuIGBzZXRJbnZva2VyYCBpc1xuICAgICAgLy8gZmlyc3Qtd3JpdGUtd2lucywgc28gdGhlIGlubmVybW9zdCBkaXNwYXRjaCdzIHN0YW1wIGxhbmRzIOKAlCBleGFjdGx5XG4gICAgICAvLyB0aGUgb2xkIGJ1YmJsZS11cCBvcmRlciB0aHJvdWdoIG5lc3RlZCBjYXRjaCBmcmFtZXMuXG4gICAgICBpZiAocGVuZGluZ0ludm9rZXJzICE9PSB1bmRlZmluZWQgJiYgaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgZm9yIChsZXQgaSA9IHBlbmRpbmdJbnZva2Vycy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICAgIGVycm9yLnNldEludm9rZXIocGVuZGluZ0ludm9rZXJzW2ldLmludm9rZXJTdGFnZUlkLCBwZW5kaW5nSW52b2tlcnNbaV0uY29udGludWF0aW9uU3RhZ2VJZCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLl9leGVjdXRlRGVwdGgtLTtcbiAgICB9XG4gIH1cblxuICAvKiogQnVpbGQgYSBmbGF0IGNvbnRpbnVhdGlvbiBob3AgZm9yIHRoZSBkcml2ZXIgbG9vcC4gKi9cbiAgcHJpdmF0ZSBob3AoXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyYW5jaFBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBpbnZva2VyU3RhbXA/OiBJbnZva2VyU3RhbXAsXG4gICk6IENvbnRpbnVhdGlvbkhvcDxUT3V0LCBUU2NvcGU+IHtcbiAgICByZXR1cm4geyBbQ09OVElOVUVfSE9QXTogdHJ1ZSwgbm9kZSwgY29udGV4dCwgYnJhbmNoUGF0aCwgLi4uKGludm9rZXJTdGFtcCAmJiB7IGludm9rZXJTdGFtcCB9KSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV4ZWN1dGUgT05FIG5vZGUgdGhyb3VnaCBhbGwgNyBwaGFzZXMg4oCUIHRoZSBvbGQgcmVjdXJzaXZlIGBleGVjdXRlTm9kZWBcbiAgICogYm9keTsgb25seSB0aGUgdGFpbCBjYWxscyBiZWNhbWUgYENvbnRpbnVhdGlvbkhvcGAgcmV0dXJucy4gUmV0dXJucyB0aGVcbiAgICogbm9kZSdzIHJlc3VsdCwgb3IgYSBob3AgZm9yIHRoZSBkcml2ZXIgbG9vcCB0byBmb2xsb3cuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIGV4ZWN1dGVOb2RlU3RlcChcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICAgYnJlYWtGbGFnOiBCcmVha0ZsYWcsXG4gICAgYnJhbmNoUGF0aD86IHN0cmluZyxcbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICAvLyBBdHRhY2ggYnVpbGRlciBtZXRhZGF0YSB0byBjb250ZXh0IGZvciBzbmFwc2hvdCBlbnJpY2htZW50LlxuICAgIC8vIFN1YmZsb3cgbWV0YSByZWFkcyBnbyB0aHJvdWdoIHRoZSBkeW5hbWljLXBhdGNoIG92ZXJsYXkg4oCUIGEgbm9kZVxuICAgIC8vIHBhdGNoZWQgYnkgYSBkeW5hbWljLXN1YmZsb3cgcmV0dXJuIHJlLWVudGVycyBleGVjdXRlTm9kZSBhbmQgbXVzdFxuICAgIC8vIGNsYXNzaWZ5IGFzIGEgc3ViZmxvdyB3aXRob3V0IHRoZSBzaGFyZWQgbm9kZSBldmVyIGJlaW5nIG11dGF0ZWQuXG4gICAgaWYgKG5vZGUuZGVzY3JpcHRpb24pIGNvbnRleHQuZGVzY3JpcHRpb24gPSBub2RlLmRlc2NyaXB0aW9uO1xuICAgIGNvbnN0IGVmZlN1YmZsb3dJZCA9IHRoaXMuZWZmU3ViZmxvd0lkKG5vZGUpO1xuICAgIGlmICh0aGlzLmVmZklzU3ViZmxvd1Jvb3Qobm9kZSkgJiYgZWZmU3ViZmxvd0lkKSBjb250ZXh0LnN1YmZsb3dJZCA9IGVmZlN1YmZsb3dJZDtcblxuICAgIC8vIEFzc2lnbiBydW50aW1lU3RhZ2VJZCBCRUZPUkUgdHJhdmVyc2FsQ29udGV4dCBjcmVhdGlvbiDigJQgZW5zdXJlcyBzY29wZSBldmVudHNcbiAgICAvLyAoYnVmZmVyZWQgYnkgcnVudGltZVN0YWdlSWQpIGFuZCBmbG93IGV2ZW50cyAoZmx1c2hlZCBieSB0cmF2ZXJzYWxDb250ZXh0LnJ1bnRpbWVTdGFnZUlkKVxuICAgIC8vIHVzZSB0aGUgc2FtZSB2YWx1ZS4gTXVzdCBoYXBwZW4gYmVmb3JlIGV4ZWN1dGVTdGFnZSBBTkQgYmVmb3JlIHRyYXZlcnNhbENvbnRleHQuXG4gICAgY29uc3QgaWR4ID0gdGhpcy5fZXhlY3V0aW9uQ291bnRlci52YWx1ZSsrO1xuICAgIGNvbnRleHQucnVudGltZVN0YWdlSWQgPSBidWlsZFJ1bnRpbWVTdGFnZUlkKG5vZGUuaWQsIGlkeCk7XG5cbiAgICAvLyBSRkMtMDAzIEQxOiBydW50aW1lIHBhcmVudCDigJQgdGhlIHByZXZpb3VzIGV4ZWN1dGlvbiBzdGVwJ3MgcnVudGltZVN0YWdlSWQuXG4gICAgLy8gRmFsbHMgYmFjayB0byB0aGUgc3ViZmxvdyBNT1VOVCdzIHJ1bnRpbWVTdGFnZUlkIGZvciB0aGUgc3ViZmxvdyByb290XG4gICAgLy8gc3RhZ2UgKGl0cyBTdGFnZUNvbnRleHQgaXMgY3JlYXRlZCBmcmVzaCB3aXRoIG5vIHBhcmVudCksIHNvIHJ1bnRpbWVcbiAgICAvLyBhbmNlc3RvciBjaGFpbnMgY3Jvc3Mgc3ViZmxvdyBib3VuZGFyaWVzLiBgfHxgIChub3QgYD8/YCkgb24gcHVycG9zZTpcbiAgICAvLyBhIHBhcmVudCBjb250ZXh0IHRoYXQgbmV2ZXIgZXhlY3V0ZWQgc3RpbGwgY2FycmllcyB0aGUgZmllbGQnc1xuICAgIC8vIGluaXRpYWwgYCcnYCwgd2hpY2ggbXVzdCBhbHNvIGZhbGwgdGhyb3VnaCB0byB0aGUgbW91bnQgZmFsbGJhY2suXG4gICAgY29uc3QgcGFyZW50UnVudGltZVN0YWdlSWQgPSBjb250ZXh0LnBhcmVudD8ucnVudGltZVN0YWdlSWQgfHwgdGhpcy5wYXJlbnRNb3VudFJ1bnRpbWVTdGFnZUlkO1xuXG4gICAgLy8gbG9vcEl0ZXJhdGlvbiDigJQgaG93IG1hbnkgdGltZXMgVEhJUyBzdGFnZSBoYXMgcnVuIGJlZm9yZSBpbiB0aGlzIHJ1bi5cbiAgICAvLyBLZXllZCBieSB0aGUgc2FtZSBzdGFnZUlkIHdlIHN0YW1wIG9uIHRoZSBjb250ZXh0IChhbmQgdGhlIHNhbWUgdmFsdWUgdGhlXG4gICAgLy8gbmFycmF0aXZlIHJlY29yZGVyIGNvdW50cyBvbiksIHJ1bi1zY29wZWQgYW5kIHNoYXJlZCBhY3Jvc3Mgc3ViZmxvd1xuICAgIC8vIHJlLW1vdW50cyB2aWEgYF92aXNpdENvdW50c2AuIHVuZGVmaW5lZCBvbiB0aGUgZmlyc3QgdmlzaXQ7IDEgb24gdGhlXG4gICAgLy8gZmlyc3QgbG9vcC1iYWNrLCAyIG9uIHRoZSBuZXh0LCDigKYg4oCUIGkuZS4gdmlzaXRDb3VudCAtIDEuIENvdW50ZWQgZm9yXG4gICAgLy8gRVZFUlkgc3RhZ2Uga2luZCAoYW55IG5vZGUgY2FuIGJlIGEgbG9vcCB0YXJnZXQpLCB1bmxpa2UgdGhlIG5hcnJhdGl2ZVxuICAgIC8vIHJlY29yZGVyIHdoaWNoIG9ubHkgcmVuZGVycyBpdCBmb3IgbGluZWFyIHN0YWdlcy5cbiAgICBjb25zdCBjb250ZXh0U3RhZ2VJZCA9IG5vZGUuaWQgPz8gY29udGV4dC5zdGFnZUlkO1xuICAgIGNvbnN0IHZpc2l0Q291bnQgPSAodGhpcy5fdmlzaXRDb3VudHMuZ2V0KGNvbnRleHRTdGFnZUlkKSA/PyAwKSArIDE7XG4gICAgdGhpcy5fdmlzaXRDb3VudHMuc2V0KGNvbnRleHRTdGFnZUlkLCB2aXNpdENvdW50KTtcbiAgICBjb25zdCBsb29wSXRlcmF0aW9uID0gdmlzaXRDb3VudCA+IDEgPyB2aXNpdENvdW50IC0gMSA6IHVuZGVmaW5lZDtcblxuICAgIC8vIEJ1aWxkIHRyYXZlcnNhbCBjb250ZXh0IGZvciByZWNvcmRlciBldmVudHMg4oCUIGNyZWF0ZWQgb25jZSBwZXIgc3RhZ2UsIHNoYXJlZCBieSBhbGwgZXZlbnRzXG4gICAgY29uc3QgdHJhdmVyc2FsQ29udGV4dDogVHJhdmVyc2FsQ29udGV4dCA9IHtcbiAgICAgIHJ1bklkOiB0aGlzLnJ1bklkLFxuICAgICAgc3RhZ2VJZDogY29udGV4dFN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogY29udGV4dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHN0YWdlTmFtZTogbm9kZS5uYW1lLFxuICAgICAgcGFyZW50U3RhZ2VJZDogY29udGV4dC5wYXJlbnQ/LnN0YWdlSWQsXG4gICAgICAuLi4ocGFyZW50UnVudGltZVN0YWdlSWQgJiYgeyBwYXJlbnRSdW50aW1lU3RhZ2VJZCB9KSxcbiAgICAgIC4uLihsb29wSXRlcmF0aW9uICE9PSB1bmRlZmluZWQgJiYgeyBsb29wSXRlcmF0aW9uIH0pLFxuICAgICAgc3ViZmxvd0lkOiBjb250ZXh0LnN1YmZsb3dJZCA/PyB0aGlzLnBhcmVudFN1YmZsb3dJZCxcbiAgICAgIHN1YmZsb3dQYXRoOiBicmFuY2hQYXRoIHx8IHVuZGVmaW5lZCxcbiAgICAgIGRlcHRoOiB0aGlzLmNvbXB1dGVDb250ZXh0RGVwdGgoY29udGV4dCksXG4gICAgfTtcblxuICAgIC8vIOKUgOKUgOKUgCBQaGFzZSAwYTogTEFaWSBSRVNPTFZFIOKAlCBkZWZlcnJlZCBzdWJmbG93IHJlc29sdXRpb24g4pSA4pSA4pSAXG4gICAgLy8gR3VhcmQgdXNlcyB0aGUgcGVyLXRyYXZlcnNlciByZXNvbHZlZExhenlTdWJmbG93cyBzZXQgKG5vdCB0aGUgc2hhcmVkIG5vZGUpIHNvXG4gICAgLy8gY29uY3VycmVudCB0cmF2ZXJzZXJzIGRvIG5vdCByYWNlIG9uIG5vZGUuc3ViZmxvd1Jlc29sdmVyIG9yIGNsZWFyIGl0IGZvciBlYWNoIG90aGVyLlxuICAgIGlmIChub2RlLmlzU3ViZmxvd1Jvb3QgJiYgbm9kZS5zdWJmbG93UmVzb2x2ZXIgJiYgIXRoaXMucmVzb2x2ZWRMYXp5U3ViZmxvd3MuaGFzKG5vZGUuc3ViZmxvd0lkISkpIHtcbiAgICAgIGNvbnN0IHJlc29sdmVkID0gbm9kZS5zdWJmbG93UmVzb2x2ZXIoKTtcbiAgICAgIGNvbnN0IHByZWZpeGVkUm9vdCA9IHRoaXMucHJlZml4Tm9kZVRyZWUocmVzb2x2ZWQucm9vdCBhcyBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgbm9kZS5zdWJmbG93SWQhKTtcblxuICAgICAgLy8gUmVnaXN0ZXIgdGhlIHJlc29sdmVkIHN1YmZsb3cgKHNhbWUgcGF0aCBhcyBlYWdlciByZWdpc3RyYXRpb24pXG4gICAgICB0aGlzLnN1YmZsb3dzW25vZGUuc3ViZmxvd0lkIV0gPSB7IHJvb3Q6IHByZWZpeGVkUm9vdCB9O1xuXG4gICAgICAvLyBNZXJnZSBzdGFnZU1hcCBlbnRyaWVzXG4gICAgICBmb3IgKGNvbnN0IFtrZXksIGZuXSBvZiByZXNvbHZlZC5zdGFnZU1hcCkge1xuICAgICAgICBjb25zdCBwcmVmaXhlZEtleSA9IGAke25vZGUuc3ViZmxvd0lkfS8ke2tleX1gO1xuICAgICAgICBpZiAoIXRoaXMuc3RhZ2VNYXAuaGFzKHByZWZpeGVkS2V5KSkge1xuICAgICAgICAgIHRoaXMuc3RhZ2VNYXAuc2V0KHByZWZpeGVkS2V5LCBmbiBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIE1lcmdlIG5lc3RlZCBzdWJmbG93c1xuICAgICAgaWYgKHJlc29sdmVkLnN1YmZsb3dzKSB7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgZGVmXSBvZiBPYmplY3QuZW50cmllcyhyZXNvbHZlZC5zdWJmbG93cykpIHtcbiAgICAgICAgICBjb25zdCBwcmVmaXhlZEtleSA9IGAke25vZGUuc3ViZmxvd0lkfS8ke2tleX1gO1xuICAgICAgICAgIGlmICghdGhpcy5zdWJmbG93c1twcmVmaXhlZEtleV0pIHtcbiAgICAgICAgICAgIHRoaXMuc3ViZmxvd3NbcHJlZml4ZWRLZXldID0gZGVmIGFzIHsgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVXBkYXRlIHJ1bnRpbWUgc3RydWN0dXJlIHdpdGggdGhlIG5vdy1yZXNvbHZlZCBzcGVjXG4gICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgICAgIG5vZGUuaWQsXG4gICAgICAgIG5vZGUuc3ViZmxvd0lkISxcbiAgICAgICAgbm9kZS5zdWJmbG93TmFtZSxcbiAgICAgICAgcmVzb2x2ZWQuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgICAgKTtcblxuICAgICAgLy8gTWFyayBhcyByZXNvbHZlZCBmb3IgVEhJUyB0cmF2ZXJzZXIg4oCUIHBlci10cmF2ZXJzZXIgc2V0IHByZXZlbnRzIHJlLWVudHJ5XG4gICAgICAvLyB3aXRob3V0IG11dGF0aW5nIHRoZSBzaGFyZWQgU3RhZ2VOb2RlIGdyYXBoICh3aGljaCB3b3VsZCByYWNlIGNvbmN1cnJlbnQgdHJhdmVyc2VycykuXG4gICAgICB0aGlzLnJlc29sdmVkTGF6eVN1YmZsb3dzLmFkZChub2RlLnN1YmZsb3dJZCEpO1xuICAgIH1cblxuICAgIC8vIOKUgOKUgOKUgCBQaGFzZSAwOiBDTEFTU0lGWSDigJQgc3ViZmxvdyBkZXRlY3Rpb24g4pSA4pSA4pSAXG4gICAgaWYgKHRoaXMuZWZmSXNTdWJmbG93Um9vdChub2RlKSAmJiBlZmZTdWJmbG93SWQpIHtcbiAgICAgIC8vIEhhbmQgaGVscGVycyB0aGUgRUZGRUNUSVZFIG5vZGUgdmlldyAoYnVpbHQgZmllbGRzICsgZHluYW1pYyBwYXRjaClcbiAgICAgIC8vIHNvIFN1YmZsb3dFeGVjdXRvci9Ob2RlUmVzb2x2ZXIgbmV2ZXIgcmVhZCBzdGFsZSBidWlsdCBmaWVsZHMuXG4gICAgICBjb25zdCBtb3VudE5vZGUgPSB0aGlzLmVmZk5vZGUobm9kZSk7XG4gICAgICBjb25zdCByZXNvbHZlZE5vZGUgPSB0aGlzLm5vZGVSZXNvbHZlci5yZXNvbHZlU3ViZmxvd1JlZmVyZW5jZShtb3VudE5vZGUpO1xuXG4gICAgICBjb25zdCBzdWJmbG93T3V0cHV0ID0gYXdhaXQgdGhpcy5zdWJmbG93RXhlY3V0b3IuZXhlY3V0ZVN1YmZsb3coXG4gICAgICAgIHJlc29sdmVkTm9kZSxcbiAgICAgICAgY29udGV4dCxcbiAgICAgICAgYnJlYWtGbGFnLFxuICAgICAgICBicmFuY2hQYXRoLFxuICAgICAgICB0aGlzLnN1YmZsb3dSZXN1bHRzLFxuICAgICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgKTtcblxuICAgICAgY29uc3QgaXNSZWZlcmVuY2VCYXNlZFN1YmZsb3cgPSByZXNvbHZlZE5vZGUgIT09IG1vdW50Tm9kZTtcbiAgICAgIGNvbnN0IGhhc0NoaWxkcmVuID0gQm9vbGVhbihtb3VudE5vZGUuY2hpbGRyZW4gJiYgbW91bnROb2RlLmNoaWxkcmVuLmxlbmd0aCA+IDApO1xuICAgICAgY29uc3Qgc2hvdWxkRXhlY3V0ZUNvbnRpbnVhdGlvbiA9IGlzUmVmZXJlbmNlQmFzZWRTdWJmbG93IHx8IGhhc0NoaWxkcmVuO1xuXG4gICAgICAvLyDilIDilIDilIAgQnJlYWstZmxhZyBjaGVjayBBRlRFUiBzdWJmbG93IHJldHVybnMg4pSA4pSA4pSAXG4gICAgICAvLyBJZiB0aGUgc3ViZmxvdyB3YXMgbW91bnRlZCB3aXRoIGBwcm9wYWdhdGVCcmVhazogdHJ1ZWAgYW5kIGJyb2tlXG4gICAgICAvLyBpbnRlcm5hbGx5LCBgU3ViZmxvd0V4ZWN1dG9yYCBoYXMgYWxyZWFkeSBmbGlwcGVkIG91ciBicmVha0ZsYWcuXG4gICAgICAvLyBTdG9wIHRoZSBvdXRlciB0cmF2ZXJzYWwgaGVyZSDigJQgZG8gbm90IHJ1biB0aGUgbmV4dCBsaW5lYXIgc3RhZ2UuXG4gICAgICBpZiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrKSB7XG4gICAgICAgIHJldHVybiBzdWJmbG93T3V0cHV0O1xuICAgICAgfVxuXG4gICAgICBpZiAobm9kZS5uZXh0ICYmIHNob3VsZEV4ZWN1dGVDb250aW51YXRpb24pIHtcbiAgICAgICAgY29uc3QgbmV4dEN0eCA9IGNvbnRleHQuY3JlYXRlTmV4dChicmFuY2hQYXRoIGFzIHN0cmluZywgbm9kZS5uZXh0Lm5hbWUsIG5vZGUubmV4dC5pZCk7XG4gICAgICAgIHJldHVybiB0aGlzLmhvcChub2RlLm5leHQsIG5leHRDdHgsIGJyYW5jaFBhdGgpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gc3ViZmxvd091dHB1dDtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFnZUZ1bmMgPSB0aGlzLmdldFN0YWdlRm4obm9kZSk7XG4gICAgY29uc3QgaGFzU3RhZ2VGdW5jdGlvbiA9IEJvb2xlYW4oc3RhZ2VGdW5jKTtcbiAgICBjb25zdCBpc1Njb3BlQmFzZWREZWNpZGVyID0gQm9vbGVhbihub2RlLmRlY2lkZXJGbik7XG4gICAgY29uc3QgaXNTY29wZUJhc2VkU2VsZWN0b3IgPSBCb29sZWFuKG5vZGUuc2VsZWN0b3JGbik7XG4gICAgY29uc3QgaXNEZWNpZGVyTm9kZSA9IGlzU2NvcGVCYXNlZERlY2lkZXI7XG4gICAgY29uc3QgaGFzQ2hpbGRyZW4gPSBCb29sZWFuKHRoaXMuZWZmQ2hpbGRyZW4obm9kZSk/Lmxlbmd0aCk7XG4gICAgLy8gYG5leHRgIGlzIG5ldmVyIG92ZXJsYWlkIOKAlCBhIGR5bmFtaWMgbmV4dCBhcHBsaWVzIG9ubHkgdG8gdGhlIHZpc2l0XG4gICAgLy8gdGhhdCBwcm9kdWNlZCBpdCAoaGFuZGxlZCB2aWEgdGhlIGBkeW5hbWljTmV4dGAgbG9jYWwgYmVsb3cpLCBzbyB0aGVcbiAgICAvLyBidWlsdCBjaGFydCdzIG5leHQgaXMgYWx3YXlzIHRoZSBjb3JyZWN0IGNvbnRpbnVhdGlvbiBoZXJlLlxuICAgIGNvbnN0IGhhc05leHQgPSBCb29sZWFuKG5vZGUubmV4dCk7XG4gICAgY29uc3Qgb3JpZ2luYWxOZXh0ID0gbm9kZS5uZXh0O1xuXG4gICAgLy8g4pSA4pSA4pSAIFBoYXNlIDE6IFZBTElEQVRFIOKAlCBub2RlIGludmFyaWFudHMg4pSA4pSA4pSAXG4gICAgaWYgKCFoYXNTdGFnZUZ1bmN0aW9uICYmICFpc0RlY2lkZXJOb2RlICYmICFpc1Njb3BlQmFzZWRTZWxlY3RvciAmJiAhaGFzQ2hpbGRyZW4pIHtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGBOb2RlICcke25vZGUubmFtZX0nIG11c3QgZGVmaW5lOiBlbWJlZGRlZCBmbiBPUiBhIHN0YWdlTWFwIGVudHJ5IE9SIGhhdmUgY2hpbGRyZW4vZGVjaWRlcmA7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3I6IGVycm9yTWVzc2FnZSB9KTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgIH1cbiAgICBpZiAoaXNEZWNpZGVyTm9kZSAmJiAhaGFzQ2hpbGRyZW4pIHtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9ICdEZWNpZGVyIG5vZGUgbmVlZHMgdG8gaGF2ZSBjaGlsZHJlbiB0byBleGVjdXRlJztcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBwaXBlbGluZSAoJHticmFuY2hQYXRofSkgc3RhZ2UgWyR7bm9kZS5uYW1lfV06YCwgeyBlcnJvcjogZXJyb3JNZXNzYWdlIH0pO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG4gICAgfVxuICAgIGlmIChpc1Njb3BlQmFzZWRTZWxlY3RvciAmJiAhaGFzQ2hpbGRyZW4pIHtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9ICdTZWxlY3RvciBub2RlIG5lZWRzIHRvIGhhdmUgY2hpbGRyZW4gdG8gZXhlY3V0ZSc7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3I6IGVycm9yTWVzc2FnZSB9KTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgIH1cblxuICAgIC8vIFJvbGUgbWFya2VycyBmb3IgZGVidWcgcGFuZWxzXG4gICAgaWYgKCFoYXNTdGFnZUZ1bmN0aW9uKSB7XG4gICAgICBpZiAoaXNEZWNpZGVyTm9kZSkgY29udGV4dC5zZXRBc0RlY2lkZXIoKTtcbiAgICAgIGVsc2UgaWYgKGhhc0NoaWxkcmVuKSBjb250ZXh0LnNldEFzRm9yaygpO1xuICAgIH1cblxuICAgIC8vIEJyZWFrIGhhbmRsZXIgd2lyZWQgdG8gdGhlIHNjb3BlLiBDYXB0dXJlcyB0aGUgb3B0aW9uYWwgcmVhc29uXG4gICAgLy8gcGFzc2VkIHZpYSBgc2NvcGUuJGJyZWFrKHJlYXNvbilgIGFuZCBwYXJrcyBpdCBvbiB0aGUgYnJlYWtGbGFnIHNvXG4gICAgLy8gZG93bnN0cmVhbSBjb2RlIChGbG93UmVjb3JkZXIub25CcmVhaywgc3ViZmxvdyBwcm9wYWdhdGlvbikgY2FuXG4gICAgLy8gc3VyZmFjZSBpdC4gQSBzZWNvbmQgJGJyZWFrIGNhbGwgaW4gdGhlIHNhbWUgc3RhZ2Uga2VlcHMgdGhlIEZJUlNUXG4gICAgLy8gcmVhc29uIOKAlCBmaXJzdC1icmVhay13aW5zIOKAlCBtYXRjaGluZyB0aGUgXCJleGVjdXRpb24gc3RvcHBlZFwiIHN0b3J5LlxuICAgIGNvbnN0IGJyZWFrRm4gPSAocmVhc29uPzogc3RyaW5nKSA9PiB7XG4gICAgICBicmVha0ZsYWcuc2hvdWxkQnJlYWsgPSB0cnVlO1xuICAgICAgaWYgKHJlYXNvbiAhPT0gdW5kZWZpbmVkICYmIGJyZWFrRmxhZy5yZWFzb24gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBicmVha0ZsYWcucmVhc29uID0gcmVhc29uO1xuICAgICAgfVxuICAgIH07XG5cbiAgICAvLyDilIDilIDilIAgUGhhc2UgMmE6IFNFTEVDVE9SIOKAlCBzY29wZS1iYXNlZCBtdWx0aS1jaG9pY2Ug4pSA4pSA4pSAXG4gICAgaWYgKGlzU2NvcGVCYXNlZFNlbGVjdG9yKSB7XG4gICAgICBjb25zdCBzZWxlY3RvclJlc3VsdCA9IGF3YWl0IHRoaXMuc2VsZWN0b3JIYW5kbGVyLmhhbmRsZVNjb3BlQmFzZWQoXG4gICAgICAgIG5vZGUsXG4gICAgICAgIHN0YWdlRnVuYyEsXG4gICAgICAgIGNvbnRleHQsXG4gICAgICAgIGJyZWFrRmxhZyxcbiAgICAgICAgYnJhbmNoUGF0aCxcbiAgICAgICAgdGhpcy5leGVjdXRlU3RhZ2UuYmluZCh0aGlzKSxcbiAgICAgICAgdGhpcy5leGVjdXRlTm9kZS5iaW5kKHRoaXMpLFxuICAgICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgKTtcblxuICAgICAgaWYgKGhhc05leHQpIHtcbiAgICAgICAgY29uc3QgbmV4dEN0eCA9IGNvbnRleHQuY3JlYXRlTmV4dChicmFuY2hQYXRoIGFzIHN0cmluZywgbm9kZS5uZXh0IS5uYW1lLCBub2RlLm5leHQhLmlkKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuaG9wKG5vZGUubmV4dCEsIG5leHRDdHgsIGJyYW5jaFBhdGgpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHNlbGVjdG9yUmVzdWx0O1xuICAgIH1cblxuICAgIC8vIOKUgOKUgOKUgCBQaGFzZSAyYjogREVDSURFUiDigJQgc2NvcGUtYmFzZWQgc2luZ2xlLWNob2ljZSBjb25kaXRpb25hbCBicmFuY2gg4pSA4pSA4pSAXG4gICAgaWYgKGlzRGVjaWRlck5vZGUpIHtcbiAgICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgdGhpcy5kZWNpZGVySGFuZGxlci5wcmVwYXJlRGlzcGF0Y2goXG4gICAgICAgIG5vZGUsXG4gICAgICAgIHN0YWdlRnVuYyEsXG4gICAgICAgIGNvbnRleHQsXG4gICAgICAgIGJyZWFrRmxhZyxcbiAgICAgICAgYnJhbmNoUGF0aCxcbiAgICAgICAgdGhpcy5leGVjdXRlU3RhZ2UuYmluZCh0aGlzKSxcbiAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICk7XG5cbiAgICAgIC8vIE5vIGRlY2lkZXItbGV2ZWwgY29udGludWF0aW9uIOKGkiB0aGUgYnJhbmNoIGRpc3BhdGNoIGlzIGEgdGFpbFxuICAgICAgLy8gY2FsbC4gSGFuZCBpdCB0byB0aGUgZHJpdmVyIGFzIGEgZmxhdCBob3Agc28gbG9vcC1oZWF2eSBkZWNpZGVyXG4gICAgICAvLyBjaGFydHMgKGUuZy4gYWdlbnQgUmVBY3QgbG9vcHMgd2l0aCBicmFuY2gtc291cmNlZCBgbG9vcFRvYCkgc3RheVxuICAgICAgLy8gZmxhdC1zdGFja2VkLiBUaGUgaW52b2tlciBzdGFtcCBwcmVzZXJ2ZXMgUGF1c2VTaWduYWwgc2VtYW50aWNzIOKAlFxuICAgICAgLy8gdGhlIGRlY2lkZXIgaXMgdGhlIGludm9rZXIgb2Ygd2hhdGV2ZXIgcGF1c2VzIGluIHRoZSBjaGFpbi5cbiAgICAgIGlmICghaGFzTmV4dCAmJiBkaXNwYXRjaC5raW5kID09PSAnZGlzcGF0Y2gnKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmhvcChkaXNwYXRjaC5jaG9zZW4sIGRpc3BhdGNoLmJyYW5jaENvbnRleHQsIGJyYW5jaFBhdGgsIHtcbiAgICAgICAgICBpbnZva2VyU3RhZ2VJZDogbm9kZS5pZCEsXG4gICAgICAgICAgY29udGludWF0aW9uU3RhZ2VJZDogbm9kZS5uZXh0Py5pZCxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIERlY2lkZXIgV0lUSCBpdHMgb3duIG5leHQ6IHRoZSBicmFuY2ggY2hhaW4gbXVzdCBjb21wbGV0ZSBCRUZPUkVcbiAgICAgIC8vIHRoZSBkZWNpZGVyJ3MgY29udGludWF0aW9uIHJ1bnMg4oCUIHRydWUgdHJlZSBuZXN0aW5nLCBrZXB0XG4gICAgICAvLyByZWN1cnNpdmUgKGEgbmVzdGVkIGRyaXZlcikuIE1pcnJvcnMgaGFuZGxlU2NvcGVCYXNlZCBleGFjdGx5LFxuICAgICAgLy8gaW5jbHVkaW5nIHRoZSBQYXVzZVNpZ25hbCBpbnZva2VyIHN0YW1wIG9uIGJ1YmJsZS11cC5cbiAgICAgIGxldCBkZWNpZGVyUmVzdWx0OiBhbnk7XG4gICAgICBpZiAoZGlzcGF0Y2gua2luZCA9PT0gJ2JyZWFrJykge1xuICAgICAgICBkZWNpZGVyUmVzdWx0ID0gZGlzcGF0Y2guYnJhbmNoSWQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGRlY2lkZXJSZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVOb2RlKGRpc3BhdGNoLmNob3NlbiwgZGlzcGF0Y2guYnJhbmNoQ29udGV4dCwgYnJlYWtGbGFnLCBicmFuY2hQYXRoKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgICAgIGVycm9yLnNldEludm9rZXIobm9kZS5pZCEsIG5vZGUubmV4dD8uaWQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBBZnRlciBicmFuY2ggZXhlY3V0aW9uLCBmb2xsb3cgZGVjaWRlcidzIG93biBuZXh0IChlLmcuLCBsb29wVG8gdGFyZ2V0KVxuICAgICAgaWYgKGhhc05leHQgJiYgIWJyZWFrRmxhZy5zaG91bGRCcmVhaykge1xuICAgICAgICBjb25zdCBuZXh0Tm9kZSA9IG9yaWdpbmFsTmV4dCE7XG4gICAgICAgIC8vIFVzZSB0aGUgaXNMb29wUmVmIGZsYWcgc2V0IGJ5IGxvb3BUbygpIOKAlCBkbyBub3QgcmVseSBvbiBzdGFnZU1hcCBhYnNlbmNlLFxuICAgICAgICAvLyBzaW5jZSBpZC1rZXllZCBzdGFnZU1hcHMgd291bGQgb3RoZXJ3aXNlIGNhdXNlIGxvb3AgdGFyZ2V0cyB0byBiZSBleGVjdXRlZCBkaXJlY3RseS5cbiAgICAgICAgY29uc3QgaXNMb29wUmVmID1cbiAgICAgICAgICBuZXh0Tm9kZS5pc0xvb3BSZWYgPT09IHRydWUgfHxcbiAgICAgICAgICAoIXRoaXMuZ2V0U3RhZ2VGbihuZXh0Tm9kZSkgJiZcbiAgICAgICAgICAgICF0aGlzLmVmZkNoaWxkcmVuKG5leHROb2RlKT8ubGVuZ3RoICYmXG4gICAgICAgICAgICAhbmV4dE5vZGUuZGVjaWRlckZuICYmXG4gICAgICAgICAgICAhbmV4dE5vZGUuc2VsZWN0b3JGbiAmJlxuICAgICAgICAgICAgIXRoaXMuZWZmSXNTdWJmbG93Um9vdChuZXh0Tm9kZSkpO1xuXG4gICAgICAgIGlmIChpc0xvb3BSZWYpIHtcbiAgICAgICAgICBjb25zdCB0YXJnZXQgPSB0aGlzLmNvbnRpbnVhdGlvblJlc29sdmVyLnJlc29sdmVUYXJnZXQobmV4dE5vZGUsIG5vZGUsIGNvbnRleHQsIGJyYW5jaFBhdGgpO1xuICAgICAgICAgIHJldHVybiB0aGlzLmhvcCh0YXJnZXQubm9kZSwgdGFyZ2V0LmNvbnRleHQsIGJyYW5jaFBhdGgpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25OZXh0KG5vZGUubmFtZSwgbmV4dE5vZGUubmFtZSwgbmV4dE5vZGUuZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQpO1xuICAgICAgICBjb25zdCBuZXh0Q3R4ID0gY29udGV4dC5jcmVhdGVOZXh0KGJyYW5jaFBhdGggYXMgc3RyaW5nLCBuZXh0Tm9kZS5uYW1lLCBuZXh0Tm9kZS5pZCk7XG4gICAgICAgIHJldHVybiB0aGlzLmhvcChuZXh0Tm9kZSwgbmV4dEN0eCwgYnJhbmNoUGF0aCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBkZWNpZGVyUmVzdWx0O1xuICAgIH1cblxuICAgIC8vIOKUgOKUgOKUgCBBYm9ydCBjaGVjayDigJQgY29vcGVyYXRpdmUgY2FuY2VsbGF0aW9uIOKUgOKUgOKUgFxuICAgIGlmICh0aGlzLnNpZ25hbD8uYWJvcnRlZCkge1xuICAgICAgY29uc3QgcmVhc29uID1cbiAgICAgICAgdGhpcy5zaWduYWwucmVhc29uIGluc3RhbmNlb2YgRXJyb3IgPyB0aGlzLnNpZ25hbC5yZWFzb24gOiBuZXcgRXJyb3IodGhpcy5zaWduYWwucmVhc29uID8/ICdBYm9ydGVkJyk7XG4gICAgICB0aHJvdyByZWFzb247XG4gICAgfVxuXG4gICAgLy8g4pSA4pSA4pSAIFBoYXNlIDM6IEVYRUNVVEUg4oCUIHJ1biBzdGFnZSBmdW5jdGlvbiDilIDilIDilIBcbiAgICBsZXQgc3RhZ2VPdXRwdXQ6IFRPdXQgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGR5bmFtaWNOZXh0OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChzdGFnZUZ1bmMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0YWdlT3V0cHV0ID0gYXdhaXQgdGhpcy5leGVjdXRlU3RhZ2Uobm9kZSwgc3RhZ2VGdW5jLCBjb250ZXh0LCBicmVha0ZuKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgICAgLy8gUGF1c2VTaWduYWwgaXMgZXhwZWN0ZWQgY29udHJvbCBmbG93LCBub3QgYW4gZXJyb3Ig4oCUIGZpcmUgbmFycmF0aXZlLCBjb21taXQsIHJlLXRocm93LlxuICAgICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uUGF1c2Uobm9kZS5uYW1lLCBub2RlLmlkLCBlcnJvci5wYXVzZURhdGEsIGVycm9yLnN1YmZsb3dQYXRoLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkVycm9yKG5vZGUubmFtZSwgZXJyb3IudG9TdHJpbmcoKSwgZXJyb3IsIHRyYXZlcnNhbENvbnRleHQpO1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3IgfSk7XG4gICAgICAgIGNvbnRleHQuYWRkRXJyb3IoJ3N0YWdlRXhlY3V0aW9uRXJyb3InLCBlcnJvci50b1N0cmluZygpKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25TdGFnZUV4ZWN1dGVkKG5vZGUubmFtZSwgbm9kZS5kZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCwgJ2xpbmVhcicpO1xuXG4gICAgICBpZiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrKSB7XG4gICAgICAgIC8vIEZvcndhcmQgdGhlIG9wdGlvbmFsIHJlYXNvbiBjYXB0dXJlZCBvbiBicmVha0ZsYWcg4oCUIHNldCBieSB0aGVcbiAgICAgICAgLy8gc3RhZ2UncyAkYnJlYWsocmVhc29uKSBjYWxsIE9SIGJ5IGEgc3ViZmxvdydzIHByb3BhZ2F0ZUJyZWFrLlxuICAgICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkJyZWFrKG5vZGUubmFtZSwgdHJhdmVyc2FsQ29udGV4dCwgYnJlYWtGbGFnLnJlYXNvbik7XG4gICAgICAgIHJldHVybiBzdGFnZU91dHB1dDtcbiAgICAgIH1cblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDQ6IERZTkFNSUMg4oCUIFN0YWdlTm9kZSByZXR1cm4gZGV0ZWN0aW9uIOKUgOKUgOKUgFxuICAgICAgaWYgKHN0YWdlT3V0cHV0ICYmIHR5cGVvZiBzdGFnZU91dHB1dCA9PT0gJ29iamVjdCcgJiYgaXNTdGFnZU5vZGVSZXR1cm4oc3RhZ2VPdXRwdXQpKSB7XG4gICAgICAgIGNvbnN0IGR5bmFtaWNOb2RlID0gc3RhZ2VPdXRwdXQgYXMgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT47XG4gICAgICAgIGNvbnRleHQuYWRkTG9nKCdpc0R5bmFtaWMnLCB0cnVlKTtcbiAgICAgICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNQYXR0ZXJuJywgJ1N0YWdlTm9kZVJldHVybicpO1xuXG4gICAgICAgIC8vIER5bmFtaWMgc3ViZmxvdyBhdXRvLXJlZ2lzdHJhdGlvbi4gVGhlIHN1YmZsb3cgbWV0YSBsYW5kcyBpbiB0aGVcbiAgICAgICAgLy8gdHJhdmVyc2VyLWxvY2FsIG92ZXJsYXkgKE5PVCBvbiB0aGUgc2hhcmVkIG5vZGUpOyB0aGUgaW1tZWRpYXRlXG4gICAgICAgIC8vIGV4ZWN1dGVOb2RlIHJlLWVudHJ5IHNlZXMgaXQgdGhyb3VnaCB0aGUgZWZmKiBhY2Nlc3NvcnMgYW5kXG4gICAgICAgIC8vIGNsYXNzaWZpZXMgdGhlIG5vZGUgYXMgYSBzdWJmbG93IG1vdW50IGluIFBoYXNlIDAuXG4gICAgICAgIGlmIChkeW5hbWljTm9kZS5pc1N1YmZsb3dSb290ICYmIGR5bmFtaWNOb2RlLnN1YmZsb3dEZWYgJiYgZHluYW1pY05vZGUuc3ViZmxvd0lkKSB7XG4gICAgICAgICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNQYXR0ZXJuJywgJ2R5bmFtaWNTdWJmbG93Jyk7XG4gICAgICAgICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNTdWJmbG93SWQnLCBkeW5hbWljTm9kZS5zdWJmbG93SWQpO1xuXG4gICAgICAgICAgdGhpcy5hdXRvUmVnaXN0ZXJTdWJmbG93RGVmKGR5bmFtaWNOb2RlLnN1YmZsb3dJZCwgZHluYW1pY05vZGUuc3ViZmxvd0RlZiwgbm9kZS5pZCk7XG5cbiAgICAgICAgICB0aGlzLmdldE9yQ3JlYXRlUGF0Y2gobm9kZSkuc3ViZmxvd01ldGEgPSB7XG4gICAgICAgICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgICAgICAgc3ViZmxvd0lkOiBkeW5hbWljTm9kZS5zdWJmbG93SWQsXG4gICAgICAgICAgICBzdWJmbG93TmFtZTogZHluYW1pY05vZGUuc3ViZmxvd05hbWUsXG4gICAgICAgICAgICBzdWJmbG93TW91bnRPcHRpb25zOiBkeW5hbWljTm9kZS5zdWJmbG93TW91bnRPcHRpb25zLFxuICAgICAgICAgIH07XG5cbiAgICAgICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgICAgICAgICBub2RlLmlkLFxuICAgICAgICAgICAgZHluYW1pY05vZGUuc3ViZmxvd0lkISxcbiAgICAgICAgICAgIGR5bmFtaWNOb2RlLnN1YmZsb3dOYW1lLFxuICAgICAgICAgICAgZHluYW1pY05vZGUuc3ViZmxvd0RlZj8uYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgICAgICAgICk7XG5cbiAgICAgICAgICAvLyBSZS1lbnRlciBUSElTIG5vZGUgKHNhbWUgY29udGV4dCk6IHRoZSBvdmVybGF5IHBhdGNoIG1ha2VzIHRoZVxuICAgICAgICAgIC8vIG5leHQgc3RlcCBjbGFzc2lmeSBpdCBhcyBhIHN1YmZsb3cgbW91bnQgaW4gUGhhc2UgMC5cbiAgICAgICAgICByZXR1cm4gdGhpcy5ob3Aobm9kZSwgY29udGV4dCwgYnJhbmNoUGF0aCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDaGVjayBjaGlsZHJlbiBmb3Igc3ViZmxvd0RlZlxuICAgICAgICBpZiAoZHluYW1pY05vZGUuY2hpbGRyZW4pIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGR5bmFtaWNOb2RlLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICBpZiAoY2hpbGQuaXNTdWJmbG93Um9vdCAmJiBjaGlsZC5zdWJmbG93RGVmICYmIGNoaWxkLnN1YmZsb3dJZCkge1xuICAgICAgICAgICAgICB0aGlzLmF1dG9SZWdpc3RlclN1YmZsb3dEZWYoY2hpbGQuc3ViZmxvd0lkLCBjaGlsZC5zdWJmbG93RGVmLCBjaGlsZC5pZCk7XG4gICAgICAgICAgICAgIHRoaXMuc3RydWN0dXJlTWFuYWdlci51cGRhdGVEeW5hbWljU3ViZmxvdyhcbiAgICAgICAgICAgICAgICBjaGlsZC5pZCxcbiAgICAgICAgICAgICAgICBjaGlsZC5zdWJmbG93SWQhLFxuICAgICAgICAgICAgICAgIGNoaWxkLnN1YmZsb3dOYW1lLFxuICAgICAgICAgICAgICAgIGNoaWxkLnN1YmZsb3dEZWY/LmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBEeW5hbWljIGNoaWxkcmVuIChmb3JrIHBhdHRlcm4pIOKAlCBwYXRjaGVkIGludG8gdGhlIG92ZXJsYXk7XG4gICAgICAgIC8vIFBoYXNlIDUgYmVsb3cgcmVhZHMgdGhlbSBiYWNrIHRocm91Z2ggZWZmQ2hpbGRyZW4vZWZmU2VsZWN0b3IuXG4gICAgICAgIGlmIChkeW5hbWljTm9kZS5jaGlsZHJlbiAmJiBkeW5hbWljTm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgdGhpcy5nZXRPckNyZWF0ZVBhdGNoKG5vZGUpLmNoaWxkcmVuID0gZHluYW1pY05vZGUuY2hpbGRyZW47XG4gICAgICAgICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNDaGlsZENvdW50JywgZHluYW1pY05vZGUuY2hpbGRyZW4ubGVuZ3RoKTtcbiAgICAgICAgICBjb250ZXh0LmFkZExvZyhcbiAgICAgICAgICAgICdkeW5hbWljQ2hpbGRJZHMnLFxuICAgICAgICAgICAgZHluYW1pY05vZGUuY2hpbGRyZW4ubWFwKChjKSA9PiBjLmlkKSxcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUR5bmFtaWNDaGlsZHJlbihcbiAgICAgICAgICAgIG5vZGUuaWQsXG4gICAgICAgICAgICBkeW5hbWljTm9kZS5jaGlsZHJlbixcbiAgICAgICAgICAgIEJvb2xlYW4oZHluYW1pY05vZGUubmV4dE5vZGVTZWxlY3RvciksXG4gICAgICAgICAgICBCb29sZWFuKGR5bmFtaWNOb2RlLmRlY2lkZXJGbiksXG4gICAgICAgICAgKTtcblxuICAgICAgICAgIGlmICh0eXBlb2YgZHluYW1pY05vZGUubmV4dE5vZGVTZWxlY3RvciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgdGhpcy5nZXRPckNyZWF0ZVBhdGNoKG5vZGUpLm5leHROb2RlU2VsZWN0b3IgPSBkeW5hbWljTm9kZS5uZXh0Tm9kZVNlbGVjdG9yO1xuICAgICAgICAgICAgY29udGV4dC5hZGRMb2coJ2hhc1NlbGVjdG9yJywgdHJ1ZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gRHluYW1pYyBuZXh0IChsaW5lYXIgY29udGludWF0aW9uKSDigJQgc3RheXMgYSBMT0NBTDogaXQgYXBwbGllc1xuICAgICAgICAvLyBvbmx5IHRvIHRoaXMgdmlzaXQgKFBoYXNlIDYgcm91dGVzIGl0IHRocm91Z2ggdGhlXG4gICAgICAgIC8vIENvbnRpbnVhdGlvblJlc29sdmVyKSwgc28gdGhlIHNoYXJlZCBub2RlJ3MgbmV4dCBpcyBuZXZlciB0b3VjaGVkXG4gICAgICAgIC8vIGFuZCBhIGxvb3AgcmV2aXNpdCBuYXR1cmFsbHkgc2VlcyB0aGUgYnVpbHQgY29udGludWF0aW9uLlxuICAgICAgICBpZiAoZHluYW1pY05vZGUubmV4dCkge1xuICAgICAgICAgIGR5bmFtaWNOZXh0ID0gZHluYW1pY05vZGUubmV4dDtcbiAgICAgICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY05leHQobm9kZS5pZCwgZHluYW1pY05vZGUubmV4dCk7XG4gICAgICAgICAgY29udGV4dC5hZGRMb2coJ2hhc0R5bmFtaWNOZXh0JywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBzdGFnZU91dHB1dCA9IHVuZGVmaW5lZDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyDilIDilIDilIAgUGhhc2UgNTogQ0hJTERSRU4g4oCUIGZvcmsgZGlzcGF0Y2gg4pSA4pSA4pSAXG4gICAgLy8gUmUtcmVhZCB0aHJvdWdoIHRoZSBvdmVybGF5OiBQaGFzZSA0IG1heSBoYXZlIGp1c3QgcGF0Y2hlZCBkeW5hbWljXG4gICAgLy8gY2hpbGRyZW4vc2VsZWN0b3IgZm9yIFRISVMgdmlzaXQgKG9yIGFuIGVhcmxpZXIgdmlzaXQgaW4gdGhpcyBydW4pLlxuICAgIGNvbnN0IGNoaWxkcmVuQWZ0ZXJTdGFnZSA9IHRoaXMuZWZmQ2hpbGRyZW4obm9kZSk7XG4gICAgY29uc3QgaGFzQ2hpbGRyZW5BZnRlclN0YWdlID0gQm9vbGVhbihjaGlsZHJlbkFmdGVyU3RhZ2U/Lmxlbmd0aCk7XG5cbiAgICBpZiAoaGFzQ2hpbGRyZW5BZnRlclN0YWdlKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygndG90YWxDaGlsZHJlbicsIGNoaWxkcmVuQWZ0ZXJTdGFnZT8ubGVuZ3RoKTtcbiAgICAgIGNvbnRleHQuYWRkTG9nKCdvcmRlck9mRXhlY3V0aW9uJywgJ0NoaWxkcmVuQWZ0ZXJTdGFnZScpO1xuXG4gICAgICBsZXQgbm9kZUNoaWxkcmVuUmVzdWx0czogUmVjb3JkPHN0cmluZywgTm9kZVJlc3VsdFR5cGU+O1xuXG4gICAgICBjb25zdCBlZmZTZWxlY3RvckZuID0gdGhpcy5lZmZTZWxlY3Rvcihub2RlKTtcbiAgICAgIGlmIChlZmZTZWxlY3RvckZuKSB7XG4gICAgICAgIG5vZGVDaGlsZHJlblJlc3VsdHMgPSBhd2FpdCB0aGlzLmNoaWxkcmVuRXhlY3V0b3IuZXhlY3V0ZVNlbGVjdGVkQ2hpbGRyZW4oXG4gICAgICAgICAgZWZmU2VsZWN0b3JGbixcbiAgICAgICAgICBjaGlsZHJlbkFmdGVyU3RhZ2UhLFxuICAgICAgICAgIHN0YWdlT3V0cHV0LFxuICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgYnJhbmNoUGF0aCBhcyBzdHJpbmcsXG4gICAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICAgICBub2RlLmZhaWxGYXN0LFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgY2hpbGRDb3VudCA9IGNoaWxkcmVuQWZ0ZXJTdGFnZT8ubGVuZ3RoID8/IDA7XG4gICAgICAgIGNvbnN0IGNoaWxkTmFtZXMgPSBjaGlsZHJlbkFmdGVyU3RhZ2U/Lm1hcCgoYykgPT4gYy5uYW1lKS5qb2luKCcsICcpO1xuICAgICAgICBjb250ZXh0LmFkZEZsb3dEZWJ1Z01lc3NhZ2UoJ2NoaWxkcmVuJywgYEV4ZWN1dGluZyBhbGwgJHtjaGlsZENvdW50fSBjaGlsZHJlbiBpbiBwYXJhbGxlbDogJHtjaGlsZE5hbWVzfWAsIHtcbiAgICAgICAgICBjb3VudDogY2hpbGRDb3VudCxcbiAgICAgICAgICB0YXJnZXRTdGFnZTogY2hpbGRyZW5BZnRlclN0YWdlPy5tYXAoKGMpID0+IGMubmFtZSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIGVmZk5vZGU6IENoaWxkcmVuRXhlY3V0b3IgcmVhZHMgbm9kZS5jaGlsZHJlbi9ub2RlLmZhaWxGYXN0IGl0c2VsZi5cbiAgICAgICAgbm9kZUNoaWxkcmVuUmVzdWx0cyA9IGF3YWl0IHRoaXMuY2hpbGRyZW5FeGVjdXRvci5leGVjdXRlTm9kZUNoaWxkcmVuKFxuICAgICAgICAgIHRoaXMuZWZmTm9kZShub2RlKSxcbiAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICBicmFuY2hQYXRoLFxuICAgICAgICAgIHRyYXZlcnNhbENvbnRleHQsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIEZvcmstb25seTogcmV0dXJuIGJ1bmRsZVxuICAgICAgaWYgKCFoYXNOZXh0ICYmICFkeW5hbWljTmV4dCkge1xuICAgICAgICByZXR1cm4gbm9kZUNoaWxkcmVuUmVzdWx0cyE7XG4gICAgICB9XG5cbiAgICAgIC8vIENhcHR1cmUgZHluYW1pYyBjaGlsZHJlbiBhcyBzeW50aGV0aWMgc3ViZmxvdyByZXN1bHQgZm9yIFVJXG4gICAgICBjb25zdCBpc0R5bmFtaWMgPSBjb250ZXh0LmRlYnVnPy5sb2dDb250ZXh0Py5pc0R5bmFtaWM7XG4gICAgICBpZiAoaXNEeW5hbWljICYmIGNoaWxkcmVuQWZ0ZXJTdGFnZSAmJiBjaGlsZHJlbkFmdGVyU3RhZ2UubGVuZ3RoID4gMCkge1xuICAgICAgICB0aGlzLmNhcHR1cmVEeW5hbWljQ2hpbGRyZW5SZXN1bHQobm9kZSwgY2hpbGRyZW5BZnRlclN0YWdlLCBjb250ZXh0KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyDilIDilIDilIAgUGhhc2UgNjogQ09OVElOVUUg4oCUIGR5bmFtaWMgbmV4dCAvIGxpbmVhciBuZXh0IOKUgOKUgOKUgFxuICAgIGlmIChkeW5hbWljTmV4dCkge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gdGhpcy5jb250aW51YXRpb25SZXNvbHZlci5yZXNvbHZlVGFyZ2V0KGR5bmFtaWNOZXh0LCBub2RlLCBjb250ZXh0LCBicmFuY2hQYXRoKTtcbiAgICAgIHJldHVybiB0aGlzLmhvcCh0YXJnZXQubm9kZSwgdGFyZ2V0LmNvbnRleHQsIGJyYW5jaFBhdGgpO1xuICAgIH1cblxuICAgIGlmIChoYXNOZXh0KSB7XG4gICAgICBjb25zdCBuZXh0Tm9kZSA9IG9yaWdpbmFsTmV4dCE7XG5cbiAgICAgIC8vIERldGVjdCBsb29wIHJlZmVyZW5jZSBub2RlcyBjcmVhdGVkIGJ5IGxvb3BUbygpIOKAlCBtYXJrZWQgd2l0aCBpc0xvb3BSZWYgZmxhZy5cbiAgICAgIC8vIFJvdXRlIHRocm91Z2ggQ29udGludWF0aW9uUmVzb2x2ZXIgZm9yIHByb3BlciBJRCByZXNvbHV0aW9uLCBpdGVyYXRpb25cbiAgICAgIC8vIHRyYWNraW5nLCBhbmQgbmFycmF0aXZlIGdlbmVyYXRpb24uIFRoZSByZXNvbHZlZCB0YXJnZXQgY29tZXMgYmFja1xuICAgICAgLy8gYXMgYSBob3Ag4oCUIGxvb3AgZWRnZXMgY29uc3VtZSBubyBzdGFjaywgc28gdGhlIGl0ZXJhdGlvbiBsaW1pdFxuICAgICAgLy8gKG5vdCBjYWxsLXN0YWNrIGRlcHRoKSBpcyB3aGF0IGJvdW5kcyBhIGxvb3AuXG4gICAgICBjb25zdCBpc0xvb3BSZWZlcmVuY2UgPSBuZXh0Tm9kZS5pc0xvb3BSZWY7XG5cbiAgICAgIGlmIChpc0xvb3BSZWZlcmVuY2UpIHtcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gdGhpcy5jb250aW51YXRpb25SZXNvbHZlci5yZXNvbHZlVGFyZ2V0KG5leHROb2RlLCBub2RlLCBjb250ZXh0LCBicmFuY2hQYXRoLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgICAgcmV0dXJuIHRoaXMuaG9wKHRhcmdldC5ub2RlLCB0YXJnZXQuY29udGV4dCwgYnJhbmNoUGF0aCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uTmV4dChub2RlLm5hbWUsIG5leHROb2RlLm5hbWUsIG5leHROb2RlLmRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgIGNvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZSgnbmV4dCcsIGBNb3ZpbmcgdG8gJHtuZXh0Tm9kZS5uYW1lfSBzdGFnZWAsIHtcbiAgICAgICAgdGFyZ2V0U3RhZ2U6IG5leHROb2RlLm5hbWUsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IG5leHRDdHggPSBjb250ZXh0LmNyZWF0ZU5leHQoYnJhbmNoUGF0aCBhcyBzdHJpbmcsIG5leHROb2RlLm5hbWUsIG5leHROb2RlLmlkKTtcbiAgICAgIHJldHVybiB0aGlzLmhvcChuZXh0Tm9kZSwgbmV4dEN0eCwgYnJhbmNoUGF0aCk7XG4gICAgfVxuXG4gICAgLy8g4pSA4pSA4pSAIFBoYXNlIDc6IExFQUYg4oCUIG5vIGNvbnRpbnVhdGlvbiDilIDilIDilIBcbiAgICByZXR1cm4gc3RhZ2VPdXRwdXQ7XG4gIH1cblxuICAvLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgUHJpdmF0ZSBIZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHByaXZhdGUgY2FwdHVyZUR5bmFtaWNDaGlsZHJlblJlc3VsdChcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBjaGlsZHJlbjogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT5bXSxcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IHBhcmVudFN0YWdlSWQgPSBjb250ZXh0LmdldFN0YWdlSWQoKTtcblxuICAgIGNvbnN0IGNoaWxkU3RydWN0dXJlOiBhbnkgPSB7XG4gICAgICBpZDogYCR7bm9kZS5pZH0tY2hpbGRyZW5gLFxuICAgICAgbmFtZTogJ0R5bmFtaWMgQ2hpbGRyZW4nLFxuICAgICAgdHlwZTogJ2ZvcmsnLFxuICAgICAgY2hpbGRyZW46IGNoaWxkcmVuLm1hcCgoYykgPT4gKHtcbiAgICAgICAgaWQ6IGMuaWQsXG4gICAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIH0pKSxcbiAgICB9O1xuXG4gICAgY29uc3QgY2hpbGRTdGFnZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgaWYgKGNvbnRleHQuY2hpbGRyZW4pIHtcbiAgICAgIGZvciAoY29uc3QgY2hpbGRDdHggb2YgY29udGV4dC5jaGlsZHJlbikge1xuICAgICAgICBjb25zdCBzbmFwc2hvdCA9IGNoaWxkQ3R4LmdldFNuYXBzaG90KCk7XG4gICAgICAgIGNoaWxkU3RhZ2VzW3NuYXBzaG90Lm5hbWUgfHwgc25hcHNob3QuaWRdID0ge1xuICAgICAgICAgIG5hbWU6IHNuYXBzaG90Lm5hbWUsXG4gICAgICAgICAgb3V0cHV0OiBzbmFwc2hvdC5sb2dzLFxuICAgICAgICAgIGVycm9yczogc25hcHNob3QuZXJyb3JzLFxuICAgICAgICAgIG1ldHJpY3M6IHNuYXBzaG90Lm1ldHJpY3MsXG4gICAgICAgICAgc3RhdHVzOiBzbmFwc2hvdC5lcnJvcnMgJiYgT2JqZWN0LmtleXMoc25hcHNob3QuZXJyb3JzKS5sZW5ndGggPiAwID8gJ2Vycm9yJyA6ICdzdWNjZXNzJyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLnN1YmZsb3dSZXN1bHRzLnNldChub2RlLmlkLCB7XG4gICAgICBzdWJmbG93SWQ6IG5vZGUuaWQsXG4gICAgICBzdWJmbG93TmFtZTogbm9kZS5uYW1lLFxuICAgICAgdHJlZUNvbnRleHQ6IHtcbiAgICAgICAgZ2xvYmFsQ29udGV4dDoge30sXG4gICAgICAgIHN0YWdlQ29udGV4dHM6IGNoaWxkU3RhZ2VzIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgIGhpc3Rvcnk6IFtdLFxuICAgICAgfSxcbiAgICAgIHBhcmVudFN0YWdlSWQsXG4gICAgICBwaXBlbGluZVN0cnVjdHVyZTogY2hpbGRTdHJ1Y3R1cmUsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUGFyZW50LWNoYWluIGxlbmd0aCBvZiBhIFN0YWdlQ29udGV4dCDigJQgc2FtZSB2YWx1ZSB0aGUgcHJlLXRyYW1wb2xpbmVcbiAgICogd2FsayBwcm9kdWNlZCwgbWVtb2l6ZWQuIFRoZSBjb250ZXh0IHRyZWUgZGVlcGVucyBieSBvbmUgcGVyIGV4ZWN1dGVkXG4gICAqIHN0YWdlIGFsb25nIGEgY2hhaW4sIHNvIHRoZSBuYWl2ZSB3YWxrIGlzIE8oY2hhaW4gbGVuZ3RoKSBwZXIgc3RhZ2Ug4oCUXG4gICAqIE8obsKyKSBwZXIgcnVuIG9uY2UgY2hhaW5zIHJlYWNoIHRyYW1wb2xpbmUgc2NhbGUuIENvbnRleHRzIGFyZSB2aXNpdGVkXG4gICAqIHBhcmVudC1iZWZvcmUtY2hpbGQsIHNvIHRoZSBjYWNoZWQgcGFyZW50IG1ha2VzIHRoaXMgTygxKSBhbW9ydGl6ZWQuXG4gICAqL1xuICBwcml2YXRlIGNvbXB1dGVDb250ZXh0RGVwdGgoY29udGV4dDogU3RhZ2VDb250ZXh0KTogbnVtYmVyIHtcbiAgICBjb25zdCBjYWNoZWQgPSB0aGlzLmNvbnRleHREZXB0aENhY2hlLmdldChjb250ZXh0KTtcbiAgICBpZiAoY2FjaGVkICE9PSB1bmRlZmluZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgICAvLyBXYWxrIHVwIHRvIHRoZSBuZWFyZXN0IGNhY2hlZCBhbmNlc3RvciAob3IgdGhlIHJvb3QpLCB0aGVuIGZpbGwgdGhlXG4gICAgLy8gY2FjaGUgYmFjayBkb3duIOKAlCBpdGVyYXRpdmUsIHNvIGEgY29sZCBkZWVwIGNoYWluIGNhbid0IG92ZXJmbG93LlxuICAgIGNvbnN0IHVuY2FjaGVkOiBTdGFnZUNvbnRleHRbXSA9IFtdO1xuICAgIGxldCBkZXB0aCA9IC0xOyAvLyBkZXB0aCBvZiB0aGUgbm9kZSBBQk9WRSB0aGUgZmlyc3QgdW5jYWNoZWQgZW50cnlcbiAgICBsZXQgY3VycmVudDogU3RhZ2VDb250ZXh0IHwgdW5kZWZpbmVkID0gY29udGV4dDtcbiAgICB3aGlsZSAoY3VycmVudCkge1xuICAgICAgY29uc3QgaGl0ID0gdGhpcy5jb250ZXh0RGVwdGhDYWNoZS5nZXQoY3VycmVudCk7XG4gICAgICBpZiAoaGl0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVwdGggPSBoaXQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgdW5jYWNoZWQucHVzaChjdXJyZW50KTtcbiAgICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudDtcbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IHVuY2FjaGVkLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgICBkZXB0aCsrO1xuICAgICAgdGhpcy5jb250ZXh0RGVwdGhDYWNoZS5zZXQodW5jYWNoZWRbaV0sIGRlcHRoKTtcbiAgICB9XG4gICAgcmV0dXJuIGRlcHRoO1xuICB9XG5cbiAgcHJpdmF0ZSBwcmVmaXhOb2RlVHJlZShub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgcHJlZml4OiBzdHJpbmcpOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKCFub2RlKSByZXR1cm4gbm9kZTtcbiAgICBjb25zdCBjbG9uZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IC4uLm5vZGUgfTtcbiAgICBjbG9uZS5uYW1lID0gYCR7cHJlZml4fS8ke25vZGUubmFtZX1gO1xuICAgIGNsb25lLmlkID0gYCR7cHJlZml4fS8ke2Nsb25lLmlkfWA7XG4gICAgaWYgKGNsb25lLnN1YmZsb3dJZCkgY2xvbmUuc3ViZmxvd0lkID0gYCR7cHJlZml4fS8ke2Nsb25lLnN1YmZsb3dJZH1gO1xuICAgIGlmIChjbG9uZS5uZXh0KSBjbG9uZS5uZXh0ID0gdGhpcy5wcmVmaXhOb2RlVHJlZShjbG9uZS5uZXh0LCBwcmVmaXgpO1xuICAgIGlmIChjbG9uZS5jaGlsZHJlbikge1xuICAgICAgY2xvbmUuY2hpbGRyZW4gPSBjbG9uZS5jaGlsZHJlbi5tYXAoKGMpID0+IHRoaXMucHJlZml4Tm9kZVRyZWUoYywgcHJlZml4KSk7XG4gICAgfVxuICAgIHJldHVybiBjbG9uZTtcbiAgfVxuXG4gIHByaXZhdGUgYXV0b1JlZ2lzdGVyU3ViZmxvd0RlZihcbiAgICBzdWJmbG93SWQ6IHN0cmluZyxcbiAgICBzdWJmbG93RGVmOiBOb25OdWxsYWJsZTxTdGFnZU5vZGVbJ3N1YmZsb3dEZWYnXT4sXG4gICAgbW91bnROb2RlSWQ/OiBzdHJpbmcsXG4gICk6IHZvaWQge1xuICAgIC8vIHRoaXMuc3ViZmxvd3MgaXMgYWx3YXlzIGluaXRpYWxpemVkIGluIHRoZSBjb25zdHJ1Y3RvcjsgdGhlIG51bGwgZ3VhcmQgYmVsb3cgaXMgdW5yZWFjaGFibGUuXG4gICAgY29uc3Qgc3ViZmxvd3NEaWN0ID0gdGhpcy5zdWJmbG93cztcblxuICAgIC8vIEZpcnN0LXdyaXRlLXdpbnNcbiAgICBjb25zdCBpc05ld1JlZ2lzdHJhdGlvbiA9ICFzdWJmbG93c0RpY3Rbc3ViZmxvd0lkXTtcbiAgICBpZiAoaXNOZXdSZWdpc3RyYXRpb24gJiYgc3ViZmxvd0RlZi5yb290KSB7XG4gICAgICBzdWJmbG93c0RpY3Rbc3ViZmxvd0lkXSA9IHtcbiAgICAgICAgcm9vdDogc3ViZmxvd0RlZi5yb290IGFzIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgICAgICAuLi4oc3ViZmxvd0RlZi5idWlsZFRpbWVTdHJ1Y3R1cmUgPyB7IGJ1aWxkVGltZVN0cnVjdHVyZTogc3ViZmxvd0RlZi5idWlsZFRpbWVTdHJ1Y3R1cmUgfSA6IHt9KSxcbiAgICAgIH0gYXMgYW55O1xuICAgIH1cblxuICAgIC8vIE1lcmdlIHN0YWdlTWFwIGVudHJpZXMgKHBhcmVudCBlbnRyaWVzIHByZXNlcnZlZClcbiAgICBpZiAoc3ViZmxvd0RlZi5zdGFnZU1hcCkge1xuICAgICAgZm9yIChjb25zdCBba2V5LCBmbl0gb2YgQXJyYXkuZnJvbShzdWJmbG93RGVmLnN0YWdlTWFwLmVudHJpZXMoKSkpIHtcbiAgICAgICAgaWYgKCF0aGlzLnN0YWdlTWFwLmhhcyhrZXkpKSB7XG4gICAgICAgICAgdGhpcy5zdGFnZU1hcC5zZXQoa2V5LCBmbiBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gTWVyZ2UgbmVzdGVkIHN1YmZsb3dzXG4gICAgaWYgKHN1YmZsb3dEZWYuc3ViZmxvd3MpIHtcbiAgICAgIGZvciAoY29uc3QgW2tleSwgZGVmXSBvZiBPYmplY3QuZW50cmllcyhzdWJmbG93RGVmLnN1YmZsb3dzKSkge1xuICAgICAgICBpZiAoIXN1YmZsb3dzRGljdFtrZXldKSB7XG4gICAgICAgICAgc3ViZmxvd3NEaWN0W2tleV0gPSBkZWYgYXMgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKG1vdW50Tm9kZUlkKSB7XG4gICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgICAgIG1vdW50Tm9kZUlkLFxuICAgICAgICBzdWJmbG93SWQsXG4gICAgICAgIHN1YmZsb3dEZWYucm9vdD8uc3ViZmxvd05hbWUgfHwgc3ViZmxvd0RlZi5yb290Py5uYW1lLFxuICAgICAgICBzdWJmbG93RGVmLmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gTm90aWZ5IEZsb3dSZWNvcmRlcnMgb25seSBvbiBmaXJzdCByZWdpc3RyYXRpb24gKG1hdGNoZXMgZmlyc3Qtd3JpdGUtd2lucylcbiAgICBpZiAoaXNOZXdSZWdpc3RyYXRpb24pIHtcbiAgICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gc3ViZmxvd0RlZi5yb290Py5zdWJmbG93TmFtZSB8fCBzdWJmbG93RGVmLnJvb3Q/Lm5hbWUgfHwgc3ViZmxvd0lkO1xuICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25TdWJmbG93UmVnaXN0ZXJlZChcbiAgICAgICAgc3ViZmxvd0lkLFxuICAgICAgICBzdWJmbG93TmFtZSxcbiAgICAgICAgc3ViZmxvd0RlZi5yb290Py5kZXNjcmlwdGlvbixcbiAgICAgICAgc3ViZmxvd0RlZi5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuIl19