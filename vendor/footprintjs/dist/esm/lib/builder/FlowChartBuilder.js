/**
 * FlowChartBuilder — Fluent API for constructing flowchart execution graphs.
 *
 * Builds StageNode trees and SerializedPipelineStructure (JSON) in tandem.
 * Zero dependencies on old code — only imports from local types.
 *
 * The builder creates two parallel structures:
 * 1. StageNode tree — runtime graph with embedded functions
 * 2. SerializedPipelineStructure — JSON-safe structure for visualization
 *
 * The execute() convenience method is intentionally omitted —
 * it belongs in the runner layer (Phase 5).
 */
import { makeRunnable } from '../runner/RunnableChart.js';
import { StructureRecorderDispatcher } from './structure/StructureRecorderDispatcher.js';
import { createTypedScopeFactory } from './typedFlowChart.js';
// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
const fail = (msg) => {
    throw new Error(`[FlowChartBuilder] ${msg}`);
};
// ─────────────────────────────────────────────────────────────────────────────
// DeciderList
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Fluent helper returned by addDeciderFunction to add branches.
 * `end()` sets `deciderFn = true` — the fn IS the decider.
 */
export class DeciderList {
    b;
    curNode;
    curSpec;
    branchIds = new Set();
    defaultId;
    parentDescriptionParts;
    parentStageDescriptions;
    reservedStepNumber;
    deciderDescription;
    branchDescInfo = [];
    constructor(builder, curNode, curSpec, parentDescriptionParts = [], parentStageDescriptions = new Map(), reservedStepNumber = 0, deciderDescription) {
        this.b = builder;
        this.curNode = curNode;
        this.curSpec = curSpec;
        this.parentDescriptionParts = parentDescriptionParts;
        this.parentStageDescriptions = parentStageDescriptions;
        this.reservedStepNumber = reservedStepNumber;
        this.deciderDescription = deciderDescription;
    }
    addFunctionBranch(id, name, fn, description, 
    /** `{ loopTo }` declares this branch loops back to an already-declared
     *  stage — the loop is SOURCED FROM THIS BRANCH (not the decider). */
    options) {
        if (this.branchIds.has(id))
            fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const node = { name: name ?? id, id, branchId: id };
        if (description)
            node.description = description;
        if (fn) {
            node.fn = fn;
            this.b._addToMap(id, fn);
        }
        const spec = { name: name ?? id, id, type: 'stage' };
        if (description)
            spec.description = description;
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Decider branch: stage + decision-branch edge keyed by id.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.branchDescInfo.push({ id, description });
        if (options?.loopTo)
            this._applyBranchLoop(node, spec, options.loopTo);
        return this;
    }
    /**
     * Add a pausable stage as a decider branch.
     *
     * When this branch is chosen, the handler's `execute` runs. If it returns
     * data, the pipeline pauses. On resume, `handler.resume` runs with the
     * human's input. If `execute` returns void, the stage continues normally
     * (conditional pause).
     */
    addPausableFunctionBranch(id, name, handler, description, 
    /** `{ loopTo }` declares this branch loops back to an already-declared
     *  stage — the loop is SOURCED FROM THIS BRANCH (not the decider). */
    options) {
        if (this.branchIds.has(id))
            fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const node = {
            name: name ?? id,
            id,
            branchId: id,
            fn: handler.execute,
            isPausable: true,
            resumeFn: handler.resume,
        };
        if (description)
            node.description = description;
        this.b._addToMap(id, handler.execute);
        const spec = { name: name ?? id, id, type: 'stage', isPausable: true };
        if (description)
            spec.description = description;
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Pausable decider branch.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.branchDescInfo.push({ id, description });
        if (options?.loopTo)
            this._applyBranchLoop(node, spec, options.loopTo);
        return this;
    }
    addSubFlowChartBranch(id, subflow, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        const prefixedRoot = this.b._prefixNodeTree(subflow.root, id);
        if (!this.b._subflowDefs.has(id)) {
            this.b._subflowDefs.set(id, { root: prefixedRoot });
        }
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowStructure: subflow.buildTimeStructure,
        };
        // STRUCTURE-ONLY convergence override — this branch's convergence edge
        // points at `convergeAt` instead of the shared next stage (see
        // `_fireNextEdgeFromParent`). Carried on the spec so the edge-firing
        // chokepoint (which iterates child specs) can read it.
        if (options?.convergeAt)
            spec.convergeAt = options.convergeAt;
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Subflow as decider branch: stage + decision edge + mount.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, false, subflow.buildTimeStructure);
        this.b._mergeStageMap(subflow.stageMap, id);
        this.b._mergeSubflows(subflow.subflows, id);
        return this;
    }
    addLazySubFlowChartBranch(id, resolver, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        // Store resolver on the node — NO eager tree cloning
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        // Spec stub — no subflowStructure (lazy). The lazy subflow's
        // internals will be shaped at resolution time.
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            isLazy: true,
        };
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Lazy subflow as decider branch.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, true);
        return this;
    }
    addBranchList(branches) {
        for (const { id, name, fn } of branches) {
            this.addFunctionBranch(id, name, fn);
        }
        return this;
    }
    setDefault(id) {
        this.defaultId = id;
        return this;
    }
    /**
     * Attach a loop-back edge to the LAST-added branch, so the loop is sourced
     * from THAT branch node (e.g. `'tool-calls' → loopTo('context')`) rather than
     * from the decider. The chart then reads honestly: the decider splits into a
     * looping branch `[ToolCalls → back to Context]` and a terminating branch
     * `[Final → end]`, instead of a single loop hanging off the decider.
     *
     * No engine change is needed: the runtime runs the chosen branch and then
     * follows that branch node's OWN `next` — and a `next` flagged `isLoopRef`
     * routes back to the target exactly like the decider's own loop does. This
     * method just lets the builder express what the engine already supports.
     *
     * Targets the branch added immediately before this call (chain it right after
     * the branch's `addFunctionBranch`/`addPausableFunctionBranch`/
     * `addSubFlowChartBranch`). Mirrors `FlowChartBuilder.loopTo` validation.
     *
     * Works on a SUBFLOW branch too: the branch node carries both its subflow
     * resolver AND the loop-back `next` — they coexist safely (the runtime runs
     * the subflow, then follows the loop ref). The target must be a stage already
     * declared BEFORE the decider (e.g. an upstream `context`); branch ids and the
     * synthetic `'default'` clone are NOT valid loop targets.
     */
    loopTo(stageId) {
        const children = this.curNode.children;
        const specChildren = this.curSpec.children;
        if (!children || children.length === 0 || !specChildren || specChildren.length === 0) {
            fail(`loopTo('${stageId}') called before any branch was added under '${this.curNode.name}'`);
        }
        // fail() throws, so children/specChildren are non-empty here.
        this._applyBranchLoop(children[children.length - 1], specChildren[specChildren.length - 1], stageId);
        return this;
    }
    /**
     * Decorate ONE branch node/spec with a loop-back edge to `stageId`. Shared by
     * the positional `loopTo()` (which targets the last-added branch) AND the
     * per-branch `{ loopTo }` option on `addFunctionBranch` /
     * `addPausableFunctionBranch` / `addSubFlowChartBranch`. Either way the loop
     * SOURCE is the branch — so visualizers read `tool-calls → context`, never
     * `Route → context`. Validates the target is a stage declared BEFORE the
     * decider (branch ids / the synthetic 'default' clone are not valid targets).
     */
    _applyBranchLoop(branchNode, branchSpec, stageId) {
        if (branchSpec.loopTarget)
            fail(`loopTo already defined on branch '${branchSpec.id}'`);
        if (branchNode.next) {
            fail(`cannot set loopTo on branch '${branchSpec.id}' — it already has a continuation`);
        }
        if (!this.b._knownStageIdsHas(stageId)) {
            fail(`loopTo('${stageId}') target not found — a branch loop must target a stage ` +
                "declared BEFORE the decider (branch ids and the synthetic 'default' branch " +
                'are not valid loop targets; did you pass a stage name instead of an id?)');
        }
        branchNode.next = { name: stageId, id: stageId, isLoopRef: true };
        branchSpec.loopTarget = stageId;
        branchSpec.next = { name: stageId, id: stageId, type: 'loop', isLoopReference: true };
        // Branch-scoped description — attribute the loop to the branch, not the
        // decider (parentDescriptionParts is the decider's description context).
        this.parentDescriptionParts.push(`   → branch '${branchSpec.id}' loops back to ${stageId}`);
        // Fire the loop back-edge SOURCED FROM THE BRANCH so visualizers read
        // `tool-calls → context`, not `Route → context`.
        this.b._fireLoopEdgeAddedFromSubBuilder(branchSpec.id, stageId);
    }
    end() {
        const children = this.curNode.children;
        if (!children || children.length === 0) {
            throw new Error(`[FlowChartBuilder] decider at '${this.curNode.name}' requires at least one branch`);
        }
        // Validate that every branch with no embedded fn is resolvable from the stageMap
        for (const child of children) {
            if (!child.fn && child.id && !child.isSubflowRoot && !child.subflowResolver) {
                const hasInMap = this.b._stageMapHas(child.id) || this.b._stageMapHas(child.name);
                if (!hasInMap) {
                    throw new Error(`[FlowChartBuilder] decider branch '${child.id}' under '${this.curNode.name}' has no function — ` +
                        `provide a fn argument to addFunctionBranch('${child.id}', ...)`);
                }
            }
        }
        this.curNode.deciderFn = true;
        // Build branchIds BEFORE appending the synthetic default — only user-specified branches
        this.curSpec.branchIds = children
            .map((c) => c.id)
            .filter((id) => typeof id === 'string' && id.length > 0);
        this.curSpec.type = 'decider';
        if (this.defaultId) {
            const defaultChild = children.find((c) => c.id === this.defaultId);
            if (defaultChild) {
                children.push({ ...defaultChild, id: 'default', branchId: 'default' });
            }
        }
        if (this.reservedStepNumber > 0) {
            const deciderLabel = this.curNode.name;
            const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
            const mainLine = this.deciderDescription
                ? `${this.reservedStepNumber}. ${deciderLabel} — ${this.deciderDescription} (branches: ${branchIdList})`
                : `${this.reservedStepNumber}. ${deciderLabel} — Decides between: ${branchIdList}`;
            this.parentDescriptionParts.push(mainLine);
            if (this.deciderDescription) {
                this.parentStageDescriptions.set(this.curNode.name, this.deciderDescription);
            }
            for (const branch of this.branchDescInfo) {
                const branchText = branch.description;
                if (branchText) {
                    this.parentDescriptionParts.push(`   → ${branch.id}: ${branchText}`);
                }
                if (branch.description) {
                    this.parentStageDescriptions.set(branch.id, branch.description);
                }
            }
        }
        // L7.3 — fire `onDeciderComplete` so consumers can trust no more
        // branches will arrive for this decider. Branch iteration order =
        // addition order = Set insertion order.
        this.b._fireDeciderCompleteFromSubBuilder(this.curSpec.id, 'decider', [...this.branchIds], this.defaultId);
        return this.b;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList (scope-based selector — mirrors DeciderList)
// ─────────────────────────────────────────────────────────────────────────────
export class SelectorFnList {
    b;
    curNode;
    curSpec;
    branchIds = new Set();
    parentDescriptionParts;
    parentStageDescriptions;
    reservedStepNumber;
    selectorDescription;
    branchDescInfo = [];
    constructor(builder, curNode, curSpec, parentDescriptionParts = [], parentStageDescriptions = new Map(), reservedStepNumber = 0, selectorDescription) {
        this.b = builder;
        this.curNode = curNode;
        this.curSpec = curSpec;
        this.parentDescriptionParts = parentDescriptionParts;
        this.parentStageDescriptions = parentStageDescriptions;
        this.reservedStepNumber = reservedStepNumber;
        this.selectorDescription = selectorDescription;
    }
    addFunctionBranch(id, name, fn, description) {
        if (this.branchIds.has(id))
            fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const node = { name: name ?? id, id, branchId: id };
        if (description)
            node.description = description;
        if (fn) {
            node.fn = fn;
            this.b._addToMap(id, fn);
        }
        const spec = { name: name ?? id, id, type: 'stage' };
        if (description)
            spec.description = description;
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Selector branch.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.branchDescInfo.push({ id, description });
        return this;
    }
    /**
     * Add a pausable stage as a selector branch.
     *
     * When this branch is selected, the handler's `execute` runs. If it returns
     * data, the pipeline pauses. On resume, `handler.resume` runs with the
     * human's input. If `execute` returns void, the stage continues normally.
     */
    addPausableFunctionBranch(id, name, handler, description) {
        if (this.branchIds.has(id))
            fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const node = {
            name: name ?? id,
            id,
            branchId: id,
            fn: handler.execute,
            isPausable: true,
            resumeFn: handler.resume,
        };
        if (description)
            node.description = description;
        this.b._addToMap(id, handler.execute);
        const spec = { name: name ?? id, id, type: 'stage', isPausable: true };
        if (description)
            spec.description = description;
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Pausable selector branch.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.branchDescInfo.push({ id, description });
        return this;
    }
    addSubFlowChartBranch(id, subflow, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        const prefixedRoot = this.b._prefixNodeTree(subflow.root, id);
        if (!this.b._subflowDefs.has(id)) {
            this.b._subflowDefs.set(id, { root: prefixedRoot });
        }
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowStructure: subflow.buildTimeStructure,
        };
        // STRUCTURE-ONLY convergence override (see `_fireNextEdgeFromParent` +
        // `SubflowMountOptions.convergeAt`): this branch's convergence edge points at
        // `convergeAt` (a DOWNSTREAM stage) instead of the shared next stage — e.g. a
        // `tools` slot that bypasses `messageAPI` to pair with its output at
        // `call-llm`. Visualization-only: NO runtime join barrier (data rides scope).
        if (options?.convergeAt)
            spec.convergeAt = options.convergeAt;
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Subflow as selector branch.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, false, subflow.buildTimeStructure);
        this.b._mergeStageMap(subflow.stageMap, id);
        this.b._mergeSubflows(subflow.subflows, id);
        return this;
    }
    addLazySubFlowChartBranch(id, resolver, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            isLazy: true,
        };
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        // L7.3 — Lazy subflow as selector branch.
        this.b._fireStageAddedFromSubBuilder(spec);
        this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
        this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, true);
        return this;
    }
    addBranchList(branches) {
        for (const { id, name, fn } of branches) {
            this.addFunctionBranch(id, name, fn);
        }
        return this;
    }
    end() {
        const children = this.curNode.children;
        if (!children || children.length === 0) {
            throw new Error(`[FlowChartBuilder] selector at '${this.curNode.name}' requires at least one branch`);
        }
        // Validate that every branch with no embedded fn is resolvable from the stageMap
        for (const child of children) {
            if (!child.fn && child.id && !child.isSubflowRoot && !child.subflowResolver) {
                const hasInMap = this.b._stageMapHas(child.id) || this.b._stageMapHas(child.name);
                if (!hasInMap) {
                    throw new Error(`[FlowChartBuilder] selector branch '${child.id}' under '${this.curNode.name}' has no function — ` +
                        `provide a fn argument to addFunctionBranch('${child.id}', ...)`);
                }
            }
        }
        this.curNode.selectorFn = true;
        this.curSpec.branchIds = children
            .map((c) => c.id)
            .filter((id) => typeof id === 'string' && id.length > 0);
        this.curSpec.type = 'selector'; // was 'decider' — incorrect; selectors are distinct from deciders
        this.curSpec.hasSelector = true;
        if (this.reservedStepNumber > 0) {
            const selectorLabel = this.curNode.name;
            const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
            const mainLine = this.selectorDescription
                ? `${this.reservedStepNumber}. ${selectorLabel} — ${this.selectorDescription}`
                : `${this.reservedStepNumber}. ${selectorLabel} — Selects from: ${branchIdList}`;
            this.parentDescriptionParts.push(mainLine);
            if (this.selectorDescription) {
                this.parentStageDescriptions.set(this.curNode.name, this.selectorDescription);
            }
            for (const branch of this.branchDescInfo) {
                const branchText = branch.description;
                if (branchText)
                    this.parentDescriptionParts.push(`   → ${branch.id}: ${branchText}`);
                if (branch.description)
                    this.parentStageDescriptions.set(branch.id, branch.description);
            }
        }
        // L7.3 — fire `onDeciderComplete` with type='selector'. Selectors
        // have no default branch (multi-select semantics differ); pass
        // undefined.
        this.b._fireDeciderCompleteFromSubBuilder(this.curSpec.id, 'selector', [...this.branchIds]);
        return this.b;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// FlowChartBuilder
// ─────────────────────────────────────────────────────────────────────────────
export class FlowChartBuilder {
    _root;
    _rootSpec;
    _cursor;
    _cursorSpec;
    _stageMap = new Map();
    _subflowDefs = new Map();
    _streamHandlers = {};
    /**
     * L7.3 — Build-time observer fan-out. Owned by the builder so every
     * `addX()` method can fire `StructureRecorder` events at the natural
     * moment of the corresponding mutation. Dispatcher is allocated
     * lazily on first attach to keep the zero-recorder path allocation-
     * free.
     */
    _structureDispatcher;
    /**
     * L7.3 — Sealed-after-build flag (Panel 2 phase invariant). Flips
     * to `true` when `.build()` returns; subsequent `attachStructureRecorder`
     * throws. Prevents the footgun where a consumer attaches a recorder
     * mid-execution and gets partial structure data (missed every event
     * already fired during construction).
     */
    _sealed = false;
    _enableNarrative = false;
    _logger;
    _descriptionParts = [];
    _stepCounter = 0;
    // NOTE: keyed by stage name (for human-readable descriptions), while stageMap
    // and knownStageIds use id (stable identifier). These are intentionally different
    // namespaces — descriptions are presentational, lookups are structural.
    _stageDescriptions = new Map();
    _stageStepMap = new Map();
    _knownStageIds = new Set();
    _inputSchema;
    _outputSchema;
    _outputMapper;
    _scopeFactory;
    // ── L7.3 — StructureRecorder attach + dispatch helpers ──────────────────
    /**
     * Attach a `StructureRecorder` for build-phase observation. Multiple
     * recorders coexist (same id allowed; iteration order = attach
     * order). Throws if called after `.build()` — the chart is sealed at
     * that point and any recorder attached late would miss every event
     * fired during construction.
     *
     * **Seed replay**: when this is called AFTER `start()` has already
     * fired (i.e., after the `flowChart()` factory returns), the
     * just-attached recorder receives a one-time `onStageAdded` for the
     * root stage so it observes the seed. Only the new recorder sees
     * the replay; already-attached recorders are not re-fired.
     *
     * **Mid-chain attach caveat**: a recorder attached AFTER one or more
     * `addX()` calls receives the seed replay but MISSES every
     * intermediate event. Attach BEFORE the first `addX()` for complete
     * capture.
     *
     * Public for now to enable direct attach in tests + early consumers.
     * L7.4 will wire `flowChart(..., { structureRecorders: [...] })` as
     * an additional registration site; this method will remain.
     */
    attachStructureRecorder(recorder) {
        if (this._sealed) {
            throw new Error(`[FlowChartBuilder] attachStructureRecorder('${recorder.id}') called after .build() — chart is sealed; ` +
                'the recorder would miss every structure event from construction. Attach BEFORE .build().');
        }
        if (!this._structureDispatcher) {
            this._structureDispatcher = new StructureRecorderDispatcher();
        }
        this._structureDispatcher.attach(recorder);
        // The seed fires inside `start()` — that runs BEFORE the consumer
        // can post-construct attach. Replay the seed event ONLY into the
        // just-attached recorder so other already-attached recorders don't
        // see a duplicate. Errors are routed through the dispatcher's
        // accumulator so the contract stays uniform.
        if (this._rootSpec) {
            try {
                recorder.onStageAdded?.({
                    stageId: this._rootSpec.id,
                    name: this._rootSpec.name,
                    type: this._rootSpec.type ?? 'stage',
                    ...(this._rootSpec.isPausable === true && { isPausable: true }),
                    spec: this._rootSpec,
                });
            }
            catch (err) {
                this._structureDispatcher.recordErrorForReplay(recorder.id, 'onStageAdded', err);
            }
        }
        return this;
    }
    /**
     * Inspect accumulated `StructureBuildError`s. Returns empty array
     * when no recorders attached OR no errors occurred. Returns a
     * defensive copy — caller mutations do not affect subsequent calls.
     *
     * **Call on the BUILDER, not the chart returned by `.build()`.**
     * Capture the builder reference before `.build()` if you need
     * post-build access:
     * ```ts
     * const builder = flowChart(...).attachStructureRecorder(rec);
     * const chart = builder.build();
     * const errors = builder.getStructureBuildErrors();
     * ```
     */
    getStructureBuildErrors() {
        return this._structureDispatcher?.getErrors() ?? [];
    }
    // Convenience fire helpers — no-op when no dispatcher attached. Keeps
    // every call site a one-liner without the `if (this._structureDispatcher)`
    // boilerplate everywhere.
    _fireStageAdded(spec) {
        if (!this._structureDispatcher)
            return;
        // Read `isPausable` directly from the spec — single source of truth.
        // The previous `extras` argument was a sub-builder footgun: branch
        // helpers in DeciderList/SelectorFnList went through
        // `_fireStageAddedFromSubBuilder` which dropped the extras, silently
        // losing `isPausable: true` on pausable decider/selector branches.
        const isPausable = spec.isPausable === true;
        this._structureDispatcher.fireStageAdded({
            stageId: spec.id,
            name: spec.name,
            type: spec.type ?? 'stage',
            ...(isPausable && { isPausable: true }),
            spec: spec,
        });
    }
    _fireEdgeAdded(from, to, kind, label) {
        if (!this._structureDispatcher)
            return;
        this._structureDispatcher.fireEdgeAdded({
            from,
            to,
            kind,
            ...(label !== undefined && { label }),
        });
    }
    _fireLoopEdgeAdded(from, to) {
        if (!this._structureDispatcher)
            return;
        this._structureDispatcher.fireLoopEdgeAdded({ from, to });
    }
    /**
     * Fire the `next` edge(s) from a parent spec to a freshly-added
     * node — with convergence expansion when the parent is a
     * fork / decider / selector with branches.
     *
     * A fork at `parent` is semantically `parent ──fork-branch──► child[i]`
     * for each child, and the chained `.addFunction(X)` continues
     * AFTER the fork converges. The runtime semantics are that each
     * child INDEPENDENTLY feeds `X` (parallel completion → join). The
     * literal "edge from parent to X" would misrepresent this —
     * visualizers and topological algorithms would see one edge where
     * there should be N convergence edges.
     *
     * Fix: when `parentSpec` has branch children (fork or branched
     * decider/selector), fire one `next` edge from EACH child to the
     * target. Otherwise fire the single edge from `parentSpec` itself.
     *
     * Loop-reference children (synthetic spec nodes created by
     * `.loopTo()`) are excluded — they're back-edge markers, not
     * convergence sources. A branch that carries an OWN loop-back `next`
     * (a branch-sourced `loopTo`) is likewise skipped — it loops, it does
     * not converge at the linear next stage.
     *
     * A branch carrying `convergeAt` is REDIRECTED: its single convergence
     * edge fires to its named target instead of `targetId` — expressing an
     * unequal-depth merge (e.g. `tools → call-llm`, bypassing `message-api`).
     * The named target is a forward stage, so it is NOT validated here.
     *
     * Call ORDER constraint: must be called BEFORE the cursor advances
     * to the new target. The caller passes the PRE-ADVANCE parent spec.
     */
    _fireNextEdgeFromParent(parentSpec, targetId, label) {
        if (!this._structureDispatcher)
            return;
        const childSpecs = parentSpec.children;
        const isBranchingParent = (parentSpec.type === 'fork' || parentSpec.type === 'decider' || parentSpec.type === 'selector') &&
            Array.isArray(childSpecs) &&
            childSpecs.length > 0;
        if (!isBranchingParent) {
            this._fireEdgeAdded(parentSpec.id, targetId, 'next', label);
            return;
        }
        for (const child of childSpecs) {
            if (child.isLoopReference)
                continue;
            // A branch with its own loop-back next (branch-sourced loopTo) loops —
            // it does not converge at the linear next stage.
            if (child.next?.isLoopReference)
                continue;
            if (child.convergeAt) {
                // Redirected convergence: this branch rejoins at its named target.
                this._fireEdgeAdded(child.id, child.convergeAt, 'next');
                continue;
            }
            this._fireEdgeAdded(child.id, targetId, 'next', label);
        }
    }
    _fireDeciderComplete(decider, type, branchIds, defaultBranch) {
        if (!this._structureDispatcher)
            return;
        this._structureDispatcher.fireDeciderComplete({
            decider,
            type,
            branchIds,
            ...(defaultBranch !== undefined && { defaultBranch }),
        });
    }
    _fireSubflowMounted(subflowId, subflowName, rootStageId, isLazy, subflowSpec, subflowPath) {
        if (!this._structureDispatcher)
            return;
        // subflowPath defaults to subflowId when the recorder is attached
        // to the immediate parent (top-level mount); composed paths apply
        // only when this builder is itself a nested subflow being
        // observed by the grandparent's recorder.
        const path = subflowPath ?? subflowId;
        this._structureDispatcher.fireSubflowMounted({
            subflowId,
            subflowName,
            rootStageId,
            ...(isLazy === true && { isLazy }),
            ...(subflowSpec !== undefined && { subflowSpec }),
            subflowPath: path,
        });
    }
    /** Sub-builder access (`.b._fireXxx`) is needed by DeciderList /
     *  SelectorFnList; expose the dispatcher through internal helpers
     *  that go through the same no-op-when-absent guard.
     *
     *  @internal — these methods are exposed because TypeScript `private`
     *  doesn't traverse class boundaries. Consumer code MUST NOT call
     *  them; calling them post-construction lets a hostile caller
     *  fabricate structure events and corrupt downstream visualizations
     *  or audit trails. The `_` prefix is intentional convention. */
    _fireEdgeAddedFromSubBuilder(from, to, kind, label) {
        this._fireEdgeAdded(from, to, kind, label);
    }
    /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
    _fireStageAddedFromSubBuilder(spec) {
        this._fireStageAdded(spec);
    }
    /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
    _fireDeciderCompleteFromSubBuilder(decider, type, branchIds, defaultBranch) {
        this._fireDeciderComplete(decider, type, branchIds, defaultBranch);
    }
    /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
    _fireSubflowMountedFromSubBuilder(subflowId, subflowName, rootStageId, isLazy, subflowSpec, subflowPath) {
        this._fireSubflowMounted(subflowId, subflowName, rootStageId, isLazy, subflowSpec, subflowPath);
    }
    /** @internal — see `_fireEdgeAddedFromSubBuilder`. Used by `DeciderList.loopTo`
     *  to validate a branch-sourced loop target against the known stage ids
     *  (mirrors `FlowChartBuilder.loopTo`'s `_knownStageIds.has` guard). */
    _knownStageIdsHas(id) {
        return this._knownStageIds.has(id);
    }
    /** @internal — see `_fireEdgeAddedFromSubBuilder`. Used by `DeciderList.loopTo`
     *  to fire a loop back-edge SOURCED FROM A BRANCH node (not the decider). */
    _fireLoopEdgeAddedFromSubBuilder(from, to) {
        this._fireLoopEdgeAdded(from, to);
    }
    // ── Description helpers ──
    _appendDescriptionLine(name, description) {
        this._stepCounter++;
        this._stageStepMap.set(name, this._stepCounter);
        const line = description ? `${this._stepCounter}. ${name} — ${description}` : `${this._stepCounter}. ${name}`;
        this._descriptionParts.push(line);
        if (description) {
            this._stageDescriptions.set(name, description);
        }
    }
    _appendSubflowDescription(id, name, subflow) {
        this._stepCounter++;
        this._stageStepMap.set(id, this._stepCounter);
        if (subflow.description) {
            const lines = subflow.description.split('\n');
            const stepsIdx = lines.findIndex((l) => l.startsWith('Steps:'));
            if (stepsIdx >= 0) {
                // Builder-composed description (`FlowChart: X\nSteps:\n...`).
                // Inline ONLY the summary above `Steps:` on the mount line, then
                // re-list the step lines once, indented. Embedding the FULL inner
                // description here AND re-listing its steps doubled the text per
                // nesting level — exponential growth, RangeError ("Invalid string
                // length") at ~22 nesting levels of nested build().
                const summary = lines.slice(0, stepsIdx).join(' ').trim();
                this._descriptionParts.push(summary
                    ? `${this._stepCounter}. [Sub-Execution: ${name}] — ${summary}`
                    : `${this._stepCounter}. [Sub-Execution: ${name}]`);
                for (let i = stepsIdx + 1; i < lines.length; i++) {
                    if (lines[i].trim())
                        this._descriptionParts.push(`   ${lines[i]}`);
                }
            }
            else {
                // Free-form (single-block) description — inline it whole, unchanged.
                this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}] — ${subflow.description}`);
            }
        }
        else {
            this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}]`);
        }
    }
    // ── Configuration ──
    setLogger(logger) {
        this._logger = logger;
        return this;
    }
    /**
     * Declare the API contract — input validation, output shape, and output mapper.
     * Replaces setInputSchema() + setOutputSchema() + setOutputMapper() in a single call.
     *
     * If a contract with input schema is declared, chart.run() validates input automatically.
     * Contract data is used by chart.toOpenAPI() and chart.toMCPTool().
     */
    contract(opts) {
        if (opts.input)
            this._inputSchema = opts.input;
        if (opts.output)
            this._outputSchema = opts.output;
        if (opts.mapper)
            this._outputMapper = opts.mapper;
        return this;
    }
    // ── Linear Chaining ──
    start(name, fn, id, description) {
        if (this._root)
            fail('root already defined; create a new builder');
        // Detect PausableHandler by duck-typing (has .execute property)
        // eslint-disable-next-line no-restricted-syntax
        const isPausable = typeof fn === 'object' && fn !== null && 'execute' in fn;
        const stageFn = isPausable
            ? fn.execute
            : fn;
        const node = { name, id, fn: stageFn };
        if (isPausable) {
            node.isPausable = true;
            node.resumeFn = fn.resume;
        }
        if (description)
            node.description = description;
        this._addToMap(id, stageFn);
        const spec = { name, id, type: 'stage' };
        if (isPausable)
            spec.isPausable = true;
        if (description)
            spec.description = description;
        this._root = node;
        this._rootSpec = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        this._knownStageIds.add(id);
        // L7.3 — Seed node fires `onStageAdded` (no edge — no predecessor).
        // `isPausable` is read directly from the spec by `_fireStageAdded`.
        this._fireStageAdded(spec);
        this._appendDescriptionLine(name, description);
        return this;
    }
    /**
     * Start a chart whose ROOT stage IS a selector — it runs first (reading
     * args, seeding state, returning the chosen branch ids via `select()`),
     * and its branches attach directly to the root. Mirrors `start()` for the
     * root-node setup, then returns a `SelectorFnList` bound to the root so
     * `.addFunctionBranch()` / `.addSubFlowChartBranch()` / `.end()` work
     * exactly as they do after `addSelectorFunction()`.
     *
     * Use when the first thing a chart does is choose among branches — e.g. a
     * `Context` selector that inits + picks which context slots to engineer,
     * with no separate seed stage before it.
     */
    startSelector(name, fn, id, description, options) {
        if (this._root)
            fail('root already defined; create a new builder');
        const node = { name, id, fn: fn };
        if (description)
            node.description = description;
        // See `addSelectorFunction` — `failFast: true` makes a multi-branch
        // selection fan out via `Promise.all` (first error aborts) instead of the
        // default `Promise.allSettled` (best-effort).
        if (options?.failFast)
            node.failFast = true;
        this._addToMap(id, fn);
        const spec = { name, id, type: 'stage', hasSelector: true };
        if (description)
            spec.description = description;
        this._root = node;
        this._rootSpec = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        this._knownStageIds.add(id);
        // Root selector node fires onStageAdded with NO predecessor edge (it's
        // the root). Branches + onDeciderComplete come from the SelectorFnList.
        this._fireStageAdded(spec);
        this._stepCounter++;
        this._stageStepMap.set(name, this._stepCounter);
        this._appendDescriptionLine(name, description);
        return new SelectorFnList(this, node, spec, this._descriptionParts, this._stageDescriptions, this._stepCounter, description);
    }
    addFunction(name, fn, id, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        // Capture the parent SPEC reference (not just id) BEFORE the
        // cursor advances — we need its `children` + `type` to decide
        // whether the `next` edge is a fork convergence (N edges from
        // each branch child) vs a plain linear chain (1 edge from parent).
        const parentSpec = curSpec;
        const node = { name, id, fn };
        if (description)
            node.description = description;
        this._addToMap(id, fn);
        const spec = { name, id, type: 'stage' };
        if (description)
            spec.description = description;
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        this._knownStageIds.add(id);
        // L7.3 — Linear node: announce the node first, then the edge
        // from the prior cursor. Order matters: endpoints announced
        // before any edge referencing them (StructureRecorder contract).
        this._fireStageAdded(spec);
        this._fireNextEdgeFromParent(parentSpec, id);
        this._appendDescriptionLine(name, description);
        return this;
    }
    addStreamingFunction(name, fn, id, streamId, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const parentSpec = curSpec;
        const node = {
            name,
            id,
            fn,
            isStreaming: true,
            streamId: streamId ?? name,
        };
        if (description)
            node.description = description;
        this._addToMap(id, fn);
        const spec = {
            name,
            id,
            type: 'streaming',
            isStreaming: true,
            streamId: streamId ?? name,
        };
        if (description)
            spec.description = description;
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        this._knownStageIds.add(id);
        // L7.3 — Streaming stage: same shape as linear addFunction.
        this._fireStageAdded(spec);
        this._fireNextEdgeFromParent(parentSpec, id);
        this._appendDescriptionLine(name, description);
        return this;
    }
    /**
     * Add a pausable stage — can pause execution and resume later with input.
     *
     * The handler has two phases:
     * - `execute`: runs first time. Return any non-void value to pause (it becomes
     *   the checkpoint's `pauseData`); return void/undefined to continue normally.
     * - `resume`: runs when the flowchart is resumed with input.
     *
     * @example
     * ```typescript
     * .addPausableFunction('ApproveOrder', {
     *   execute: async (scope) => {
     *     scope.orderId = '123';
     *     return { question: 'Approve?' };
     *   },
     *   resume: async (scope, input) => {
     *     scope.approved = input.approved;
     *   },
     * }, 'approve-order', 'Manager approval gate')
     * ```
     */
    addPausableFunction(name, handler, id, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const parentSpec = curSpec;
        const node = {
            name,
            id,
            fn: handler.execute,
            isPausable: true,
            resumeFn: handler.resume,
        };
        if (description)
            node.description = description;
        this._addToMap(id, handler.execute);
        const spec = {
            name,
            id,
            type: 'stage',
            isPausable: true,
        };
        if (description)
            spec.description = description;
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        this._knownStageIds.add(id);
        // L7.3 — Pausable stage: `_fireStageAdded` reads `isPausable`
        // directly from `spec.isPausable` (set above), so visualisers
        // see it on the event payload without a separate threading arg.
        this._fireStageAdded(spec);
        this._fireNextEdgeFromParent(parentSpec, id);
        this._appendDescriptionLine(name, description);
        return this;
    }
    // ── Detach (builder-native composition) ──
    //
    // Sugar over `addFunction` that generates a stage which calls
    // `scope.$detachAndForget(...)` or `scope.$detachAndJoinLater(...)`
    // at runtime. ZERO engine changes — pure composition over the
    // existing scope-method primitives.
    //
    // For `addDetachAndJoinLater`, the returned handle is stored in
    // shared state via `$setValue` (which bypasses the typed-proxy
    // unwrap that would otherwise strip the handle's class methods).
    // Downstream stages read it via `scope[options.handleKey]` or
    // `scope.$getValue(options.handleKey)` — both preserve methods
    // because the value was stored raw.
    /**
     * Add a stage that fires a child flowchart on the given driver and
     * DISCARDS the handle. Pure fire-and-forget — useful for telemetry
     * exports, audit log shipping, cache warm-up.
     *
     * @param id Stable id for this stage (also the stageMap key).
     * @param child The child flowchart to detach.
     * @param options.driver The driver to schedule on (e.g. `microtaskBatchDriver`).
     * @param options.inputMapper Maps the parent's scope to the child's input.
     *   Defaults to passing `undefined`.
     * @param options.mountName Display name; defaults to `id`.
     * @param options.description Stage description for narrative + tools.
     *
     * @example
     * ```ts
     * import { microtaskBatchDriver } from 'footprintjs/detach';
     *
     * flowChart('process', processFn, 'process')
     *   .addDetachAndForget('telemetry', telemetryChart, {
     *     driver: microtaskBatchDriver,
     *     inputMapper: (scope) => ({ event: 'processed', orderId: scope.orderId }),
     *   })
     *   .addFunction('next', nextFn, 'next')
     *   .build();
     * ```
     */
    addDetachAndForget(id, child, options) {
        const name = options.mountName ?? id;
        return this.addFunction(name, ((scope) => {
            const input = options.inputMapper ? options.inputMapper(scope) : undefined;
            scope.$detachAndForget(options.driver, child, input);
        }), id, options.description);
    }
    /**
     * Add a stage that fires a child flowchart on the given driver and
     * delivers the resulting `DetachHandle` to a consumer-supplied
     * `onHandle` callback. The handle CANNOT be stored in shared state
     * — `StageContext.setValue` calls `structuredClone` which drops
     * class prototypes (and therefore the handle's `.wait()` method).
     *
     * The callback pattern is the explicit alternative: keep handles in
     * a closure-local array (or whatever shape suits) and have a
     * downstream stage `await Promise.all(...)` over them.
     *
     * @example
     * ```ts
     * import { microtaskBatchDriver } from 'footprintjs/detach';
     * import type { DetachHandle } from 'footprintjs/detach';
     *
     * const handles: DetachHandle[] = [];
     *
     * const chart = flowChart('seed', seedFn, 'seed')
     *   .addDetachAndJoinLater('eval-a', evalChart, {
     *     driver: microtaskBatchDriver,
     *     inputMapper: (scope) => scope.configA,
     *     onHandle: (h) => handles.push(h),
     *   })
     *   .addDetachAndJoinLater('eval-b', evalChart, {
     *     driver: microtaskBatchDriver,
     *     inputMapper: (scope) => scope.configB,
     *     onHandle: (h) => handles.push(h),
     *   })
     *   .addFunction('join', async (scope) => {
     *     const settled = await Promise.all(handles.map((h) => h.wait()));
     *     scope.results = settled;
     *   }, 'join')
     *   .build();
     * ```
     *
     * Note: putting `handles` in a module-level closure is fine for
     * single-run scripts. For server code that runs the same chart
     * concurrently across requests, allocate a new closure per run
     * (e.g., wrap chart construction in a factory function) so handles
     * from different runs don't bleed into each other.
     */
    addDetachAndJoinLater(id, child, options) {
        const name = options.mountName ?? id;
        return this.addFunction(name, ((scope) => {
            const input = options.inputMapper ? options.inputMapper(scope) : undefined;
            const handle = scope.$detachAndJoinLater(options.driver, child, input);
            options.onHandle(handle);
        }), id, options.description);
    }
    // ── Branching ──
    addDeciderFunction(name, fn, id, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const parentSpec = curSpec;
        if (cur.deciderFn)
            fail(`decider already defined at '${cur.name}'`);
        const node = { name, id, fn };
        if (description)
            node.description = description;
        this._addToMap(id, fn);
        const spec = { name, id, type: 'stage', hasDecider: true };
        if (description)
            spec.description = description;
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        this._knownStageIds.add(id);
        // L7.3 — Decider node is reached via a `next` edge from the prior
        // cursor. Branches themselves fire via `addFunctionBranch` etc.
        // `onDeciderComplete` fires from sub-builder `.end()`.
        this._fireStageAdded(spec);
        this._fireNextEdgeFromParent(parentSpec, id);
        this._stepCounter++;
        this._stageStepMap.set(name, this._stepCounter);
        return new DeciderList(this, node, spec, this._descriptionParts, this._stageDescriptions, this._stepCounter, description);
    }
    addSelectorFunction(name, fn, id, description, options) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const parentSpec = curSpec;
        if (cur.selectorFn)
            fail(`selector already defined at '${cur.name}'`);
        if (cur.deciderFn)
            fail(`decider and selector are mutually exclusive at '${cur.name}'`);
        const node = { name, id, fn };
        if (description)
            node.description = description;
        // `failFast`: when the selector picks ≥2 branches they fan out in parallel
        // via ChildrenExecutor. Default = `Promise.allSettled` (best-effort: every
        // branch runs to completion even if some fail). `failFast: true` = `Promise.all`
        // (the first branch error rejects + aborts) — use when ALL selected branches
        // are REQUIRED (e.g. assembling a request from independent-but-required parts),
        // not best-effort fan-out. Same flag `addListOfFunction` exposes.
        if (options?.failFast)
            node.failFast = true;
        this._addToMap(id, fn);
        const spec = { name, id, type: 'stage', hasSelector: true };
        if (description)
            spec.description = description;
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        this._knownStageIds.add(id);
        // L7.3 — Selector node: same as decider. Branches + complete event
        // come from the SelectorFnList sub-builder.
        this._fireStageAdded(spec);
        this._fireNextEdgeFromParent(parentSpec, id);
        this._stepCounter++;
        this._stageStepMap.set(name, this._stepCounter);
        return new SelectorFnList(this, node, spec, this._descriptionParts, this._stageDescriptions, this._stepCounter, description);
    }
    // ── Parallel (Fork) ──
    addListOfFunction(children, options) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const forkId = cur.id;
        curSpec.type = 'fork';
        if (options?.failFast)
            cur.failFast = true;
        for (const { id, name, fn } of children) {
            if (!id)
                fail(`child id required under '${cur.name}'`);
            if (cur.children?.some((c) => c.id === id)) {
                fail(`duplicate child id '${id}' under '${cur.name}'`);
            }
            const node = { name: name ?? id, id };
            if (fn) {
                node.fn = fn;
                this._addToMap(id, fn);
            }
            const spec = {
                name: name ?? id,
                id,
                type: 'stage',
                isParallelChild: true,
                parallelGroupId: forkId,
            };
            cur.children = cur.children || [];
            cur.children.push(node);
            curSpec.children = curSpec.children || [];
            curSpec.children.push(spec);
            // L7.3 — fire structure events for the child + the fork edge.
            this._fireStageAdded(spec);
            this._fireEdgeAdded(curSpec.id, spec.id, 'fork-branch');
        }
        const childNames = children.map((c) => c.name || c.id).join(', ');
        this._stepCounter++;
        this._descriptionParts.push(`${this._stepCounter}. Runs in parallel: ${childNames}`);
        return this;
    }
    // ── Subflow Mounting ──
    addSubFlowChart(id, subflow, mountName, options) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (cur.children?.some((c) => c.id === id)) {
            fail(`duplicate child id '${id}' under '${cur.name}'`);
        }
        const subflowName = mountName || id;
        const forkId = cur.id;
        const prefixedRoot = this._prefixNodeTree(subflow.root, id);
        if (!this._subflowDefs.has(id)) {
            this._subflowDefs.set(id, { root: prefixedRoot });
        }
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            isParallelChild: true,
            parallelGroupId: forkId,
            subflowStructure: subflow.buildTimeStructure,
        };
        curSpec.type = 'fork';
        cur.children = cur.children || [];
        cur.children.push(node);
        curSpec.children = curSpec.children || [];
        curSpec.children.push(spec);
        this._knownStageIds.add(id);
        // L7.3 — Subflow mount: stage event + fork edge + mount lifecycle
        // event. Mount-only semantics: parent recorders do NOT replay the
        // subflow's own internal structure events.
        this._fireStageAdded(spec);
        this._fireEdgeAdded(curSpec.id, id, 'fork-branch');
        this._fireSubflowMounted(id, subflowName, id, false, subflow.buildTimeStructure);
        this._mergeStageMap(subflow.stageMap, id);
        this._mergeSubflows(subflow.subflows, id);
        this._appendSubflowDescription(id, subflowName, subflow);
        return this;
    }
    addLazySubFlowChart(id, resolver, mountName, options) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (cur.children?.some((c) => c.id === id)) {
            fail(`duplicate child id '${id}' under '${cur.name}'`);
        }
        const subflowName = mountName || id;
        const forkId = cur.id;
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        // Lazy mount stub. The lazy subflow's internals will be shaped at
        // resolution time.
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            isParallelChild: true,
            parallelGroupId: forkId,
            isLazy: true,
        };
        curSpec.type = 'fork';
        cur.children = cur.children || [];
        cur.children.push(node);
        curSpec.children = curSpec.children || [];
        curSpec.children.push(spec);
        // L7.3 — Lazy subflow parallel mount.
        this._fireStageAdded(spec);
        this._fireEdgeAdded(curSpec.id, id, 'fork-branch');
        this._fireSubflowMounted(id, subflowName, id, true);
        this._stepCounter++;
        this._stageStepMap.set(id, this._stepCounter);
        this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);
        return this;
    }
    addLazySubFlowChartNext(id, resolver, mountName, options) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (cur.next) {
            fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
        }
        const subflowName = mountName || id;
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        // Lazy mount stub. The lazy subflow's internals will be shaped at
        // resolution time.
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            isLazy: true,
        };
        const parentSpec = curSpec;
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._advanceCursorSpec(spec);
        // L7.3 — Lazy linear-mount subflow.
        this._fireStageAdded(spec);
        this._fireNextEdgeFromParent(parentSpec, id);
        this._fireSubflowMounted(id, subflowName, id, true);
        this._stepCounter++;
        this._stageStepMap.set(id, this._stepCounter);
        this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);
        return this;
    }
    addSubFlowChartNext(id, subflow, mountName, options) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (cur.next) {
            fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
        }
        const subflowName = mountName || id;
        const prefixedRoot = this._prefixNodeTree(subflow.root, id);
        if (!this._subflowDefs.has(id)) {
            this._subflowDefs.set(id, { root: prefixedRoot });
        }
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        const attachedSpec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowStructure: subflow.buildTimeStructure,
        };
        const parentSpec = curSpec;
        cur.next = node;
        curSpec.next = attachedSpec;
        this._cursor = node;
        this._advanceCursorSpec(attachedSpec);
        this._knownStageIds.add(id);
        // L7.3 — Linear-mount subflow.
        this._fireStageAdded(attachedSpec);
        this._fireNextEdgeFromParent(parentSpec, id);
        this._fireSubflowMounted(id, subflowName, id, false, subflow.buildTimeStructure);
        this._mergeStageMap(subflow.stageMap, id);
        this._mergeSubflows(subflow.subflows, id);
        this._appendSubflowDescription(id, subflowName, subflow);
        return this;
    }
    // ── Loop ──
    loopTo(stageId) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (curSpec.loopTarget)
            fail(`loopTo already defined at '${cur.name}'`);
        if (cur.next)
            fail(`cannot set loopTo when next is already defined at '${cur.name}'`);
        if (!this._knownStageIds.has(stageId)) {
            fail(`loopTo('${stageId}') target not found — did you pass a stage name instead of id?`);
        }
        cur.next = { name: stageId, id: stageId, isLoopRef: true };
        curSpec.loopTarget = stageId;
        curSpec.next = { name: stageId, id: stageId, type: 'loop', isLoopReference: true };
        const targetStep = this._stageStepMap.get(stageId);
        if (targetStep !== undefined) {
            this._descriptionParts.push(`→ loops back to step ${targetStep}`);
        }
        else {
            this._descriptionParts.push(`→ loops back to ${stageId}`);
        }
        // L7.3 — Fire the loop back-edge event. Distinct from `onEdgeAdded`
        // because runtime `onLoop` carries `iteration: number` which has no
        // build meaning — separate event keeps payloads honest.
        this._fireLoopEdgeAdded(cur.id, stageId);
        return this;
    }
    // ── Streaming ──
    onStream(handler) {
        this._streamHandlers.onToken = handler;
        return this;
    }
    onStreamStart(handler) {
        this._streamHandlers.onStart = handler;
        return this;
    }
    onStreamEnd(handler) {
        this._streamHandlers.onEnd = handler;
        return this;
    }
    // ── Output ──
    build() {
        // L7.3 — seal the chart so post-build attaches throw. Prevents
        // recorders attached mid-execution from getting partial data.
        this._sealed = true;
        const root = this._root ?? fail('empty tree; call start() first');
        const rootSpec = this._rootSpec ?? fail('empty spec; call start() first');
        const subflows = {};
        for (const [key, def] of this._subflowDefs) {
            subflows[key] = def;
        }
        const rootName = this._root?.name ?? 'FlowChart';
        const description = this._descriptionParts.length > 0 ? `FlowChart: ${rootName}\nSteps:\n${this._descriptionParts.join('\n')}` : '';
        const chart = {
            root,
            stageMap: this._stageMap,
            buildTimeStructure: rootSpec,
            ...(Object.keys(subflows).length > 0 ? { subflows } : {}),
            ...(this._enableNarrative ? { enableNarrative: true } : {}),
            ...(this._logger ? { logger: this._logger } : {}),
            description,
            stageDescriptions: new Map(this._stageDescriptions),
            ...(this._inputSchema ? { inputSchema: this._inputSchema } : {}),
            ...(this._outputSchema ? { outputSchema: this._outputSchema } : {}),
            ...(this._outputMapper ? { outputMapper: this._outputMapper } : {}),
            // Auto-embed TypedScope factory if none was explicitly set.
            // This means ANY way of creating a FlowChartBuilder (flowChart(), new FlowChartBuilder(),
            // or any subclass) automatically gets TypedScope — no manual setScopeFactory needed.
            scopeFactory: this._scopeFactory ?? createTypedScopeFactory(),
        };
        return makeRunnable(chart);
    }
    /** Override the scope factory. Rarely needed — auto-embeds TypedScope by default. */
    setScopeFactory(factory) {
        this._scopeFactory = factory;
        return this;
    }
    toSpec() {
        const rootSpec = this._rootSpec ?? fail('empty tree; call start() first');
        return rootSpec;
    }
    toMermaid() {
        const lines = ['flowchart TD'];
        const idOf = (k) => (k || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
        const root = this._root ?? fail('empty tree; call start() first');
        const walk = (n) => {
            const nid = idOf(n.id);
            lines.push(`${nid}["${n.name}"]`);
            for (const c of n.children || []) {
                const cid = idOf(c.id);
                lines.push(`${nid} --> ${cid}`);
                walk(c);
            }
            if (n.next) {
                const mid = idOf(n.next.id);
                lines.push(`${nid} --> ${mid}`);
                walk(n.next);
            }
        };
        walk(root);
        return lines.join('\n');
    }
    // ── Internals (exposed for helper classes) ──
    _needCursor() {
        return this._cursor ?? fail('cursor undefined; call start() first');
    }
    _needCursorSpec() {
        return this._cursorSpec ?? fail('cursor undefined; call start() first');
    }
    /**
     * Advance the spec cursor. Retained as a method so call sites stay
     * one-liners and future cursor-related side effects have a hook.
     */
    _advanceCursorSpec(newSpec) {
        this._cursorSpec = newSpec;
    }
    _stageMapHas(key) {
        return this._stageMap.has(key);
    }
    _addToMap(id, fn) {
        if (this._stageMap.has(id)) {
            const existing = this._stageMap.get(id);
            if (existing !== fn)
                fail(`stageMap collision for id '${id}'`);
        }
        this._stageMap.set(id, fn);
    }
    _mergeStageMap(other, prefix) {
        for (const [k, v] of other) {
            const key = prefix ? `${prefix}/${k}` : k;
            if (this._stageMap.has(key)) {
                const existing = this._stageMap.get(key);
                if (existing !== v)
                    fail(`stageMap collision while mounting flowchart at '${key}'`);
            }
            else {
                this._stageMap.set(key, v);
            }
        }
    }
    _prefixNodeTree(node, prefix) {
        if (!node)
            return node;
        const clone = { ...node };
        clone.name = `${prefix}/${node.name}`;
        clone.id = `${prefix}/${node.id}`;
        if (clone.subflowId)
            clone.subflowId = `${prefix}/${clone.subflowId}`;
        if (clone.next)
            clone.next = this._prefixNodeTree(clone.next, prefix);
        if (clone.children) {
            clone.children = clone.children.map((c) => this._prefixNodeTree(c, prefix));
        }
        return clone;
    }
    _mergeSubflows(subflows, prefix) {
        if (!subflows)
            return;
        for (const [key, def] of Object.entries(subflows)) {
            const prefixedKey = `${prefix}/${key}`;
            if (!this._subflowDefs.has(prefixedKey)) {
                this._subflowDefs.set(prefixedKey, {
                    root: this._prefixNodeTree(def.root, prefix),
                });
            }
        }
    }
}
// Single implementation — accepts the options bag (or undefined).
export function flowChart(name, fn, id, options) {
    const builder = new FlowChartBuilder();
    // Attach StructureRecorders BEFORE start() so the seed event fires through
    // the normal dispatcher path (no replay needed). Iteration order matches
    // array order, matching the fluent `.attachStructureRecorder()` chain
    // semantics.
    if (options?.structureRecorders) {
        for (const rec of options.structureRecorders) {
            builder.attachStructureRecorder(rec);
        }
    }
    return builder.start(name, fn, id, options?.description);
}
/**
 * Like `flowChart()`, but the ROOT stage is a SELECTOR — it runs first and
 * its branches attach directly to it (no separate seed stage). Returns a
 * `SelectorFnList`; declare branches then call `.end()` to get the builder
 * back for any subsequent stages.
 *
 * @example
 *   flowChartSelector<MyState>('Context', contextSelectorFn, 'context')
 *     .addSubFlowChartBranch('sf-system-prompt', sysSlot, 'System Prompt', {...})
 *     .addSubFlowChartBranch('sf-messages', msgSlot, 'Messages', {...})
 *     .end()
 *     .addFunction('messageAPI', assembleFn, 'message-api')
 *     .build();
 */
export function flowChartSelector(name, fn, id, options) {
    const builder = new FlowChartBuilder();
    if (options?.structureRecorders) {
        for (const rec of options.structureRecorders) {
            builder.attachStructureRecorder(rec);
        }
    }
    return builder.startSelector(name, fn, id, options?.description, {
        ...(options?.failFast !== undefined && { failFast: options.failFast }),
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Spec to StageNode Converter
// ─────────────────────────────────────────────────────────────────────────────
export function specToStageNode(spec) {
    const inflate = (s) => ({
        name: s.name,
        id: s.id,
        children: s.children?.length ? s.children.map(inflate) : undefined,
        next: s.next ? inflate(s.next) : undefined,
    });
    return inflate(spec);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd0NoYXJ0QnVpbGRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvYnVpbGRlci9GbG93Q2hhcnRCdWlsZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7R0FZRztBQUtILE9BQU8sRUFBMEIsWUFBWSxFQUFFLE1BQU0sNEJBQTRCLENBQUM7QUFFbEYsT0FBTyxFQUFFLDJCQUEyQixFQUFFLE1BQU0sNENBQTRDLENBQUM7QUFDekYsT0FBTyxFQUEyQix1QkFBdUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBZ0J2RixnRkFBZ0Y7QUFDaEYsbUJBQW1CO0FBQ25CLGdGQUFnRjtBQUVoRixNQUFNLElBQUksR0FBRyxDQUFDLEdBQVcsRUFBUyxFQUFFO0lBQ2xDLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFDL0MsQ0FBQyxDQUFDO0FBRUYsZ0ZBQWdGO0FBQ2hGLGNBQWM7QUFDZCxnRkFBZ0Y7QUFFaEY7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLFdBQVc7SUFDTCxDQUFDLENBQWlDO0lBQ2xDLE9BQU8sQ0FBMEI7SUFDakMsT0FBTyxDQUE4QjtJQUNyQyxTQUFTLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUN2QyxTQUFTLENBQVU7SUFFVixzQkFBc0IsQ0FBVztJQUNqQyx1QkFBdUIsQ0FBc0I7SUFDN0Msa0JBQWtCLENBQVM7SUFDM0Isa0JBQWtCLENBQVU7SUFDNUIsY0FBYyxHQUFnRCxFQUFFLENBQUM7SUFFbEYsWUFDRSxPQUF1QyxFQUN2QyxPQUFnQyxFQUNoQyxPQUFvQyxFQUNwQyx5QkFBbUMsRUFBRSxFQUNyQywwQkFBK0MsSUFBSSxHQUFHLEVBQUUsRUFDeEQsa0JBQWtCLEdBQUcsQ0FBQyxFQUN0QixrQkFBMkI7UUFFM0IsSUFBSSxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUM7UUFDakIsSUFBSSxDQUFDLE9BQU8sR0FB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QUMsU0FBUztRQUNsRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztLQUMzQyxDQUFDLENBQUM7SUFDSCxPQUFPLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN2QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBGbG93Q2hhcnRCdWlsZGVyIOKAlCBGbHVlbnQgQVBJIGZvciBjb25zdHJ1Y3RpbmcgZmxvd2NoYXJ0IGV4ZWN1dGlvbiBncmFwaHMuXG4gKlxuICogQnVpbGRzIFN0YWdlTm9kZSB0cmVlcyBhbmQgU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlIChKU09OKSBpbiB0YW5kZW0uXG4gKiBaZXJvIGRlcGVuZGVuY2llcyBvbiBvbGQgY29kZSDigJQgb25seSBpbXBvcnRzIGZyb20gbG9jYWwgdHlwZXMuXG4gKlxuICogVGhlIGJ1aWxkZXIgY3JlYXRlcyB0d28gcGFyYWxsZWwgc3RydWN0dXJlczpcbiAqIDEuIFN0YWdlTm9kZSB0cmVlIOKAlCBydW50aW1lIGdyYXBoIHdpdGggZW1iZWRkZWQgZnVuY3Rpb25zXG4gKiAyLiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUg4oCUIEpTT04tc2FmZSBzdHJ1Y3R1cmUgZm9yIHZpc3VhbGl6YXRpb25cbiAqXG4gKiBUaGUgZXhlY3V0ZSgpIGNvbnZlbmllbmNlIG1ldGhvZCBpcyBpbnRlbnRpb25hbGx5IG9taXR0ZWQg4oCUXG4gKiBpdCBiZWxvbmdzIGluIHRoZSBydW5uZXIgbGF5ZXIgKFBoYXNlIDUpLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU2NvcGVGYWN0b3J5IH0gZnJvbSAnLi4vZW5naW5lL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgUGF1c2FibGVIYW5kbGVyIH0gZnJvbSAnLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBUeXBlZFNjb3BlIH0gZnJvbSAnLi4vcmVhY3RpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHsgdHlwZSBSdW5uYWJsZUZsb3dDaGFydCwgbWFrZVJ1bm5hYmxlIH0gZnJvbSAnLi4vcnVubmVyL1J1bm5hYmxlQ2hhcnQuanMnO1xuaW1wb3J0IHR5cGUgeyBTdHJ1Y3R1cmVFZGdlS2luZCwgU3RydWN0dXJlUmVjb3JkZXIgfSBmcm9tICcuL3N0cnVjdHVyZS9TdHJ1Y3R1cmVSZWNvcmRlci5qcyc7XG5pbXBvcnQgeyBTdHJ1Y3R1cmVSZWNvcmRlckRpc3BhdGNoZXIgfSBmcm9tICcuL3N0cnVjdHVyZS9TdHJ1Y3R1cmVSZWNvcmRlckRpc3BhdGNoZXIuanMnO1xuaW1wb3J0IHsgdHlwZSBUeXBlZFN0YWdlRnVuY3Rpb24sIGNyZWF0ZVR5cGVkU2NvcGVGYWN0b3J5IH0gZnJvbSAnLi90eXBlZEZsb3dDaGFydC5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIEZsb3dDaGFydCxcbiAgRmxvd0NoYXJ0T3B0aW9ucyxcbiAgRmxvd0NoYXJ0U3BlYyxcbiAgSUxvZ2dlcixcbiAgU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICBTaW1wbGlmaWVkUGFyYWxsZWxTcGVjLFxuICBTdGFnZUZ1bmN0aW9uLFxuICBTdGFnZU5vZGUsXG4gIFN0cmVhbUhhbmRsZXJzLFxuICBTdHJlYW1MaWZlY3ljbGVIYW5kbGVyLFxuICBTdHJlYW1Ub2tlbkhhbmRsZXIsXG4gIFN1YmZsb3dNb3VudE9wdGlvbnMsXG59IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIEludGVybmFsIGhlbHBlcnNcbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5jb25zdCBmYWlsID0gKG1zZzogc3RyaW5nKTogbmV2ZXIgPT4ge1xuICB0aHJvdyBuZXcgRXJyb3IoYFtGbG93Q2hhcnRCdWlsZGVyXSAke21zZ31gKTtcbn07XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gRGVjaWRlckxpc3Rcbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIEZsdWVudCBoZWxwZXIgcmV0dXJuZWQgYnkgYWRkRGVjaWRlckZ1bmN0aW9uIHRvIGFkZCBicmFuY2hlcy5cbiAqIGBlbmQoKWAgc2V0cyBgZGVjaWRlckZuID0gdHJ1ZWAg4oCUIHRoZSBmbiBJUyB0aGUgZGVjaWRlci5cbiAqL1xuZXhwb3J0IGNsYXNzIERlY2lkZXJMaXN0PFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBwcml2YXRlIHJlYWRvbmx5IGI6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBjdXJOb2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBjdXJTcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnJhbmNoSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHByaXZhdGUgZGVmYXVsdElkPzogc3RyaW5nO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgcGFyZW50RGVzY3JpcHRpb25QYXJ0czogc3RyaW5nW107XG4gIHByaXZhdGUgcmVhZG9ubHkgcGFyZW50U3RhZ2VEZXNjcmlwdGlvbnM6IE1hcDxzdHJpbmcsIHN0cmluZz47XG4gIHByaXZhdGUgcmVhZG9ubHkgcmVzZXJ2ZWRTdGVwTnVtYmVyOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgZGVjaWRlckRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGJyYW5jaERlc2NJbmZvOiBBcnJheTx7IGlkOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH0+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgYnVpbGRlcjogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+LFxuICAgIGN1ck5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIGN1clNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSxcbiAgICBwYXJlbnREZXNjcmlwdGlvblBhcnRzOiBzdHJpbmdbXSA9IFtdLFxuICAgIHBhcmVudFN0YWdlRGVzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBzdHJpbmc+ID0gbmV3IE1hcCgpLFxuICAgIHJlc2VydmVkU3RlcE51bWJlciA9IDAsXG4gICAgZGVjaWRlckRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApIHtcbiAgICB0aGlzLmIgPSBidWlsZGVyO1xuICAgIHRoaXMuY3VyTm9kZSA9IGN1ck5vZGU7XG4gICAgdGhpcy5jdXJTcGVjID0gY3VyU3BlYztcbiAgICB0aGlzLnBhcmVudERlc2NyaXB0aW9uUGFydHMgPSBwYXJlbnREZXNjcmlwdGlvblBhcnRzO1xuICAgIHRoaXMucGFyZW50U3RhZ2VEZXNjcmlwdGlvbnMgPSBwYXJlbnRTdGFnZURlc2NyaXB0aW9ucztcbiAgICB0aGlzLnJlc2VydmVkU3RlcE51bWJlciA9IHJlc2VydmVkU3RlcE51bWJlcjtcbiAgICB0aGlzLmRlY2lkZXJEZXNjcmlwdGlvbiA9IGRlY2lkZXJEZXNjcmlwdGlvbjtcbiAgfVxuXG4gIGFkZEZ1bmN0aW9uQnJhbmNoKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIGZuPzogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICAgIC8qKiBgeyBsb29wVG8gfWAgZGVjbGFyZXMgdGhpcyBicmFuY2ggbG9vcHMgYmFjayB0byBhbiBhbHJlYWR5LWRlY2xhcmVkXG4gICAgICogIHN0YWdlIOKAlCB0aGUgbG9vcCBpcyBTT1VSQ0VEIEZST00gVEhJUyBCUkFOQ0ggKG5vdCB0aGUgZGVjaWRlcikuICovXG4gICAgb3B0aW9ucz86IHsgcmVhZG9ubHkgbG9vcFRvPzogc3RyaW5nIH0sXG4gICk6IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgZGVjaWRlciBicmFuY2ggaWQgJyR7aWR9JyB1bmRlciAnJHt0aGlzLmN1ck5vZGUubmFtZX0nYCk7XG4gICAgdGhpcy5icmFuY2hJZHMuYWRkKGlkKTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCwgYnJhbmNoSWQ6IGlkIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgaWYgKGZuKSB7XG4gICAgICBub2RlLmZuID0gZm47XG4gICAgICB0aGlzLmIuX2FkZFRvTWFwKGlkLCBmbik7XG4gICAgfVxuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCwgdHlwZTogJ3N0YWdlJyB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcbiAgICAvLyBMNy4zIOKAlCBEZWNpZGVyIGJyYW5jaDogc3RhZ2UgKyBkZWNpc2lvbi1icmFuY2ggZWRnZSBrZXllZCBieSBpZC5cbiAgICB0aGlzLmIuX2ZpcmVTdGFnZUFkZGVkRnJvbVN1YkJ1aWxkZXIoc3BlYyk7XG4gICAgdGhpcy5iLl9maXJlRWRnZUFkZGVkRnJvbVN1YkJ1aWxkZXIodGhpcy5jdXJTcGVjLmlkLCBzcGVjLmlkLCAnZGVjaXNpb24tYnJhbmNoJywgaWQpO1xuXG4gICAgdGhpcy5icmFuY2hEZXNjSW5mby5wdXNoKHsgaWQsIGRlc2NyaXB0aW9uIH0pO1xuICAgIGlmIChvcHRpb25zPy5sb29wVG8pIHRoaXMuX2FwcGx5QnJhbmNoTG9vcChub2RlLCBzcGVjLCBvcHRpb25zLmxvb3BUbyk7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGEgcGF1c2FibGUgc3RhZ2UgYXMgYSBkZWNpZGVyIGJyYW5jaC5cbiAgICpcbiAgICogV2hlbiB0aGlzIGJyYW5jaCBpcyBjaG9zZW4sIHRoZSBoYW5kbGVyJ3MgYGV4ZWN1dGVgIHJ1bnMuIElmIGl0IHJldHVybnNcbiAgICogZGF0YSwgdGhlIHBpcGVsaW5lIHBhdXNlcy4gT24gcmVzdW1lLCBgaGFuZGxlci5yZXN1bWVgIHJ1bnMgd2l0aCB0aGVcbiAgICogaHVtYW4ncyBpbnB1dC4gSWYgYGV4ZWN1dGVgIHJldHVybnMgdm9pZCwgdGhlIHN0YWdlIGNvbnRpbnVlcyBub3JtYWxseVxuICAgKiAoY29uZGl0aW9uYWwgcGF1c2UpLlxuICAgKi9cbiAgYWRkUGF1c2FibGVGdW5jdGlvbkJyYW5jaChcbiAgICBpZDogc3RyaW5nLFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBoYW5kbGVyOiBQYXVzYWJsZUhhbmRsZXI8VFNjb3BlPixcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgICAvKiogYHsgbG9vcFRvIH1gIGRlY2xhcmVzIHRoaXMgYnJhbmNoIGxvb3BzIGJhY2sgdG8gYW4gYWxyZWFkeS1kZWNsYXJlZFxuICAgICAqICBzdGFnZSDigJQgdGhlIGxvb3AgaXMgU09VUkNFRCBGUk9NIFRISVMgQlJBTkNIIChub3QgdGhlIGRlY2lkZXIpLiAqL1xuICAgIG9wdGlvbnM/OiB7IHJlYWRvbmx5IGxvb3BUbz86IHN0cmluZyB9LFxuICApOiBEZWNpZGVyTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAodGhpcy5icmFuY2hJZHMuaGFzKGlkKSkgZmFpbChgZHVwbGljYXRlIGRlY2lkZXIgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IG5hbWUgPz8gaWQsXG4gICAgICBpZCxcbiAgICAgIGJyYW5jaElkOiBpZCxcbiAgICAgIGZuOiBoYW5kbGVyLmV4ZWN1dGUgYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgICAgaXNQYXVzYWJsZTogdHJ1ZSxcbiAgICAgIHJlc3VtZUZuOiBoYW5kbGVyLnJlc3VtZSxcbiAgICB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuYi5fYWRkVG9NYXAoaWQsIGhhbmRsZXIuZXhlY3V0ZSBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCwgdHlwZTogJ3N0YWdlJywgaXNQYXVzYWJsZTogdHJ1ZSB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcbiAgICAvLyBMNy4zIOKAlCBQYXVzYWJsZSBkZWNpZGVyIGJyYW5jaC5cbiAgICB0aGlzLmIuX2ZpcmVTdGFnZUFkZGVkRnJvbVN1YkJ1aWxkZXIoc3BlYyk7XG4gICAgdGhpcy5iLl9maXJlRWRnZUFkZGVkRnJvbVN1YkJ1aWxkZXIodGhpcy5jdXJTcGVjLmlkLCBzcGVjLmlkLCAnZGVjaXNpb24tYnJhbmNoJywgaWQpO1xuXG4gICAgdGhpcy5icmFuY2hEZXNjSW5mby5wdXNoKHsgaWQsIGRlc2NyaXB0aW9uIH0pO1xuICAgIGlmIChvcHRpb25zPy5sb29wVG8pIHRoaXMuX2FwcGx5QnJhbmNoTG9vcChub2RlLCBzcGVjLCBvcHRpb25zLmxvb3BUbyk7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRTdWJGbG93Q2hhcnRCcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICBzdWJmbG93OiBGbG93Q2hhcnQ8YW55LCBhbnk+LFxuICAgIG1vdW50TmFtZT86IHN0cmluZyxcbiAgICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgKTogRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKHRoaXMuYnJhbmNoSWRzLmhhcyhpZCkpIGZhaWwoYGR1cGxpY2F0ZSBkZWNpZGVyIGJyYW5jaCBpZCAnJHtpZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfSdgKTtcbiAgICB0aGlzLmJyYW5jaElkcy5hZGQoaWQpO1xuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgcHJlZml4ZWRSb290ID0gdGhpcy5iLl9wcmVmaXhOb2RlVHJlZShzdWJmbG93LnJvb3QsIGlkKTtcblxuICAgIGlmICghdGhpcy5iLl9zdWJmbG93RGVmcy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLmIuX3N1YmZsb3dEZWZzLnNldChpZCwgeyByb290OiBwcmVmaXhlZFJvb3QgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgYnJhbmNoSWQ6IGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1N0cnVjdHVyZTogc3ViZmxvdy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgfTtcbiAgICAvLyBTVFJVQ1RVUkUtT05MWSBjb252ZXJnZW5jZSBvdmVycmlkZSDigJQgdGhpcyBicmFuY2gncyBjb252ZXJnZW5jZSBlZGdlXG4gICAgLy8gcG9pbnRzIGF0IGBjb252ZXJnZUF0YCBpbnN0ZWFkIG9mIHRoZSBzaGFyZWQgbmV4dCBzdGFnZSAoc2VlXG4gICAgLy8gYF9maXJlTmV4dEVkZ2VGcm9tUGFyZW50YCkuIENhcnJpZWQgb24gdGhlIHNwZWMgc28gdGhlIGVkZ2UtZmlyaW5nXG4gICAgLy8gY2hva2Vwb2ludCAod2hpY2ggaXRlcmF0ZXMgY2hpbGQgc3BlY3MpIGNhbiByZWFkIGl0LlxuICAgIGlmIChvcHRpb25zPy5jb252ZXJnZUF0KSBzcGVjLmNvbnZlcmdlQXQgPSBvcHRpb25zLmNvbnZlcmdlQXQ7XG5cbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuID0gdGhpcy5jdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuICAgIC8vIEw3LjMg4oCUIFN1YmZsb3cgYXMgZGVjaWRlciBicmFuY2g6IHN0YWdlICsgZGVjaXNpb24gZWRnZSArIG1vdW50LlxuICAgIHRoaXMuYi5fZmlyZVN0YWdlQWRkZWRGcm9tU3ViQnVpbGRlcihzcGVjKTtcbiAgICB0aGlzLmIuX2ZpcmVFZGdlQWRkZWRGcm9tU3ViQnVpbGRlcih0aGlzLmN1clNwZWMuaWQsIHNwZWMuaWQsICdkZWNpc2lvbi1icmFuY2gnLCBpZCk7XG4gICAgdGhpcy5iLl9maXJlU3ViZmxvd01vdW50ZWRGcm9tU3ViQnVpbGRlcihpZCwgc3ViZmxvd05hbWUsIGlkLCBmYWxzZSwgc3ViZmxvdy5idWlsZFRpbWVTdHJ1Y3R1cmUpO1xuXG4gICAgdGhpcy5iLl9tZXJnZVN0YWdlTWFwKHN1YmZsb3cuc3RhZ2VNYXAsIGlkKTtcbiAgICB0aGlzLmIuX21lcmdlU3ViZmxvd3Moc3ViZmxvdy5zdWJmbG93cywgaWQpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRMYXp5U3ViRmxvd0NoYXJ0QnJhbmNoKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcmVzb2x2ZXI6ICgpID0+IEZsb3dDaGFydDxhbnksIGFueT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiBEZWNpZGVyTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAodGhpcy5icmFuY2hJZHMuaGFzKGlkKSkgZmFpbChgZHVwbGljYXRlIGRlY2lkZXIgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG1vdW50TmFtZSB8fCBpZDtcblxuICAgIC8vIFN0b3JlIHJlc29sdmVyIG9uIHRoZSBub2RlIOKAlCBOTyBlYWdlciB0cmVlIGNsb25pbmdcbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgaWQsXG4gICAgICBicmFuY2hJZDogaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1Jlc29sdmVyOiByZXNvbHZlciBhcyBhbnksXG4gICAgfTtcbiAgICBpZiAob3B0aW9ucykgbm9kZS5zdWJmbG93TW91bnRPcHRpb25zID0gb3B0aW9ucztcblxuICAgIC8vIFNwZWMgc3R1YiDigJQgbm8gc3ViZmxvd1N0cnVjdHVyZSAobGF6eSkuIFRoZSBsYXp5IHN1YmZsb3cnc1xuICAgIC8vIGludGVybmFscyB3aWxsIGJlIHNoYXBlZCBhdCByZXNvbHV0aW9uIHRpbWUuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgaXNMYXp5OiB0cnVlLFxuICAgIH07XG5cbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuID0gdGhpcy5jdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuICAgIC8vIEw3LjMg4oCUIExhenkgc3ViZmxvdyBhcyBkZWNpZGVyIGJyYW5jaC5cbiAgICB0aGlzLmIuX2ZpcmVTdGFnZUFkZGVkRnJvbVN1YkJ1aWxkZXIoc3BlYyk7XG4gICAgdGhpcy5iLl9maXJlRWRnZUFkZGVkRnJvbVN1YkJ1aWxkZXIodGhpcy5jdXJTcGVjLmlkLCBzcGVjLmlkLCAnZGVjaXNpb24tYnJhbmNoJywgaWQpO1xuICAgIHRoaXMuYi5fZmlyZVN1YmZsb3dNb3VudGVkRnJvbVN1YkJ1aWxkZXIoaWQsIHN1YmZsb3dOYW1lLCBpZCwgdHJ1ZSk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZEJyYW5jaExpc3QoXG4gICAgYnJhbmNoZXM6IEFycmF5PHtcbiAgICAgIGlkOiBzdHJpbmc7XG4gICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICBmbj86IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPjtcbiAgICB9PixcbiAgKTogRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgZm9yIChjb25zdCB7IGlkLCBuYW1lLCBmbiB9IG9mIGJyYW5jaGVzKSB7XG4gICAgICB0aGlzLmFkZEZ1bmN0aW9uQnJhbmNoKGlkLCBuYW1lLCBmbik7XG4gICAgfVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgc2V0RGVmYXVsdChpZDogc3RyaW5nKTogRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgdGhpcy5kZWZhdWx0SWQgPSBpZDtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8qKlxuICAgKiBBdHRhY2ggYSBsb29wLWJhY2sgZWRnZSB0byB0aGUgTEFTVC1hZGRlZCBicmFuY2gsIHNvIHRoZSBsb29wIGlzIHNvdXJjZWRcbiAgICogZnJvbSBUSEFUIGJyYW5jaCBub2RlIChlLmcuIGAndG9vbC1jYWxscycg4oaSIGxvb3BUbygnY29udGV4dCcpYCkgcmF0aGVyIHRoYW5cbiAgICogZnJvbSB0aGUgZGVjaWRlci4gVGhlIGNoYXJ0IHRoZW4gcmVhZHMgaG9uZXN0bHk6IHRoZSBkZWNpZGVyIHNwbGl0cyBpbnRvIGFcbiAgICogbG9vcGluZyBicmFuY2ggYFtUb29sQ2FsbHMg4oaSIGJhY2sgdG8gQ29udGV4dF1gIGFuZCBhIHRlcm1pbmF0aW5nIGJyYW5jaFxuICAgKiBgW0ZpbmFsIOKGkiBlbmRdYCwgaW5zdGVhZCBvZiBhIHNpbmdsZSBsb29wIGhhbmdpbmcgb2ZmIHRoZSBkZWNpZGVyLlxuICAgKlxuICAgKiBObyBlbmdpbmUgY2hhbmdlIGlzIG5lZWRlZDogdGhlIHJ1bnRpbWUgcnVucyB0aGUgY2hvc2VuIGJyYW5jaCBhbmQgdGhlblxuICAgKiBmb2xsb3dzIHRoYXQgYnJhbmNoIG5vZGUncyBPV04gYG5leHRgIOKAlCBhbmQgYSBgbmV4dGAgZmxhZ2dlZCBgaXNMb29wUmVmYFxuICAgKiByb3V0ZXMgYmFjayB0byB0aGUgdGFyZ2V0IGV4YWN0bHkgbGlrZSB0aGUgZGVjaWRlcidzIG93biBsb29wIGRvZXMuIFRoaXNcbiAgICogbWV0aG9kIGp1c3QgbGV0cyB0aGUgYnVpbGRlciBleHByZXNzIHdoYXQgdGhlIGVuZ2luZSBhbHJlYWR5IHN1cHBvcnRzLlxuICAgKlxuICAgKiBUYXJnZXRzIHRoZSBicmFuY2ggYWRkZWQgaW1tZWRpYXRlbHkgYmVmb3JlIHRoaXMgY2FsbCAoY2hhaW4gaXQgcmlnaHQgYWZ0ZXJcbiAgICogdGhlIGJyYW5jaCdzIGBhZGRGdW5jdGlvbkJyYW5jaGAvYGFkZFBhdXNhYmxlRnVuY3Rpb25CcmFuY2hgL1xuICAgKiBgYWRkU3ViRmxvd0NoYXJ0QnJhbmNoYCkuIE1pcnJvcnMgYEZsb3dDaGFydEJ1aWxkZXIubG9vcFRvYCB2YWxpZGF0aW9uLlxuICAgKlxuICAgKiBXb3JrcyBvbiBhIFNVQkZMT1cgYnJhbmNoIHRvbzogdGhlIGJyYW5jaCBub2RlIGNhcnJpZXMgYm90aCBpdHMgc3ViZmxvd1xuICAgKiByZXNvbHZlciBBTkQgdGhlIGxvb3AtYmFjayBgbmV4dGAg4oCUIHRoZXkgY29leGlzdCBzYWZlbHkgKHRoZSBydW50aW1lIHJ1bnNcbiAgICogdGhlIHN1YmZsb3csIHRoZW4gZm9sbG93cyB0aGUgbG9vcCByZWYpLiBUaGUgdGFyZ2V0IG11c3QgYmUgYSBzdGFnZSBhbHJlYWR5XG4gICAqIGRlY2xhcmVkIEJFRk9SRSB0aGUgZGVjaWRlciAoZS5nLiBhbiB1cHN0cmVhbSBgY29udGV4dGApOyBicmFuY2ggaWRzIGFuZCB0aGVcbiAgICogc3ludGhldGljIGAnZGVmYXVsdCdgIGNsb25lIGFyZSBOT1QgdmFsaWQgbG9vcCB0YXJnZXRzLlxuICAgKi9cbiAgbG9vcFRvKHN0YWdlSWQ6IHN0cmluZyk6IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGNvbnN0IGNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuO1xuICAgIGNvbnN0IHNwZWNDaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbjtcbiAgICBpZiAoIWNoaWxkcmVuIHx8IGNoaWxkcmVuLmxlbmd0aCA9PT0gMCB8fCAhc3BlY0NoaWxkcmVuIHx8IHNwZWNDaGlsZHJlbi5sZW5ndGggPT09IDApIHtcbiAgICAgIGZhaWwoYGxvb3BUbygnJHtzdGFnZUlkfScpIGNhbGxlZCBiZWZvcmUgYW55IGJyYW5jaCB3YXMgYWRkZWQgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIH1cbiAgICAvLyBmYWlsKCkgdGhyb3dzLCBzbyBjaGlsZHJlbi9zcGVjQ2hpbGRyZW4gYXJlIG5vbi1lbXB0eSBoZXJlLlxuICAgIHRoaXMuX2FwcGx5QnJhbmNoTG9vcChjaGlsZHJlbiFbY2hpbGRyZW4hLmxlbmd0aCAtIDFdISwgc3BlY0NoaWxkcmVuIVtzcGVjQ2hpbGRyZW4hLmxlbmd0aCAtIDFdISwgc3RhZ2VJZCk7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvKipcbiAgICogRGVjb3JhdGUgT05FIGJyYW5jaCBub2RlL3NwZWMgd2l0aCBhIGxvb3AtYmFjayBlZGdlIHRvIGBzdGFnZUlkYC4gU2hhcmVkIGJ5XG4gICAqIHRoZSBwb3NpdGlvbmFsIGBsb29wVG8oKWAgKHdoaWNoIHRhcmdldHMgdGhlIGxhc3QtYWRkZWQgYnJhbmNoKSBBTkQgdGhlXG4gICAqIHBlci1icmFuY2ggYHsgbG9vcFRvIH1gIG9wdGlvbiBvbiBgYWRkRnVuY3Rpb25CcmFuY2hgIC9cbiAgICogYGFkZFBhdXNhYmxlRnVuY3Rpb25CcmFuY2hgIC8gYGFkZFN1YkZsb3dDaGFydEJyYW5jaGAuIEVpdGhlciB3YXkgdGhlIGxvb3BcbiAgICogU09VUkNFIGlzIHRoZSBicmFuY2gg4oCUIHNvIHZpc3VhbGl6ZXJzIHJlYWQgYHRvb2wtY2FsbHMg4oaSIGNvbnRleHRgLCBuZXZlclxuICAgKiBgUm91dGUg4oaSIGNvbnRleHRgLiBWYWxpZGF0ZXMgdGhlIHRhcmdldCBpcyBhIHN0YWdlIGRlY2xhcmVkIEJFRk9SRSB0aGVcbiAgICogZGVjaWRlciAoYnJhbmNoIGlkcyAvIHRoZSBzeW50aGV0aWMgJ2RlZmF1bHQnIGNsb25lIGFyZSBub3QgdmFsaWQgdGFyZ2V0cykuXG4gICAqL1xuICBwcml2YXRlIF9hcHBseUJyYW5jaExvb3AoXG4gICAgYnJhbmNoTm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgYnJhbmNoU3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICAgIHN0YWdlSWQ6IHN0cmluZyxcbiAgKTogdm9pZCB7XG4gICAgaWYgKGJyYW5jaFNwZWMubG9vcFRhcmdldCkgZmFpbChgbG9vcFRvIGFscmVhZHkgZGVmaW5lZCBvbiBicmFuY2ggJyR7YnJhbmNoU3BlYy5pZH0nYCk7XG4gICAgaWYgKGJyYW5jaE5vZGUubmV4dCkge1xuICAgICAgZmFpbChgY2Fubm90IHNldCBsb29wVG8gb24gYnJhbmNoICcke2JyYW5jaFNwZWMuaWR9JyDigJQgaXQgYWxyZWFkeSBoYXMgYSBjb250aW51YXRpb25gKTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLmIuX2tub3duU3RhZ2VJZHNIYXMoc3RhZ2VJZCkpIHtcbiAgICAgIGZhaWwoXG4gICAgICAgIGBsb29wVG8oJyR7c3RhZ2VJZH0nKSB0YXJnZXQgbm90IGZvdW5kIOKAlCBhIGJyYW5jaCBsb29wIG11c3QgdGFyZ2V0IGEgc3RhZ2UgYCArXG4gICAgICAgICAgXCJkZWNsYXJlZCBCRUZPUkUgdGhlIGRlY2lkZXIgKGJyYW5jaCBpZHMgYW5kIHRoZSBzeW50aGV0aWMgJ2RlZmF1bHQnIGJyYW5jaCBcIiArXG4gICAgICAgICAgJ2FyZSBub3QgdmFsaWQgbG9vcCB0YXJnZXRzOyBkaWQgeW91IHBhc3MgYSBzdGFnZSBuYW1lIGluc3RlYWQgb2YgYW4gaWQ/KScsXG4gICAgICApO1xuICAgIH1cblxuICAgIGJyYW5jaE5vZGUubmV4dCA9IHsgbmFtZTogc3RhZ2VJZCwgaWQ6IHN0YWdlSWQsIGlzTG9vcFJlZjogdHJ1ZSB9O1xuICAgIGJyYW5jaFNwZWMubG9vcFRhcmdldCA9IHN0YWdlSWQ7XG4gICAgYnJhbmNoU3BlYy5uZXh0ID0geyBuYW1lOiBzdGFnZUlkLCBpZDogc3RhZ2VJZCwgdHlwZTogJ2xvb3AnLCBpc0xvb3BSZWZlcmVuY2U6IHRydWUgfTtcblxuICAgIC8vIEJyYW5jaC1zY29wZWQgZGVzY3JpcHRpb24g4oCUIGF0dHJpYnV0ZSB0aGUgbG9vcCB0byB0aGUgYnJhbmNoLCBub3QgdGhlXG4gICAgLy8gZGVjaWRlciAocGFyZW50RGVzY3JpcHRpb25QYXJ0cyBpcyB0aGUgZGVjaWRlcidzIGRlc2NyaXB0aW9uIGNvbnRleHQpLlxuICAgIHRoaXMucGFyZW50RGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAgICDihpIgYnJhbmNoICcke2JyYW5jaFNwZWMuaWR9JyBsb29wcyBiYWNrIHRvICR7c3RhZ2VJZH1gKTtcblxuICAgIC8vIEZpcmUgdGhlIGxvb3AgYmFjay1lZGdlIFNPVVJDRUQgRlJPTSBUSEUgQlJBTkNIIHNvIHZpc3VhbGl6ZXJzIHJlYWRcbiAgICAvLyBgdG9vbC1jYWxscyDihpIgY29udGV4dGAsIG5vdCBgUm91dGUg4oaSIGNvbnRleHRgLlxuICAgIHRoaXMuYi5fZmlyZUxvb3BFZGdlQWRkZWRGcm9tU3ViQnVpbGRlcihicmFuY2hTcGVjLmlkLCBzdGFnZUlkKTtcbiAgfVxuXG4gIGVuZCgpOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4ge1xuICAgIGNvbnN0IGNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuO1xuICAgIGlmICghY2hpbGRyZW4gfHwgY2hpbGRyZW4ubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFtGbG93Q2hhcnRCdWlsZGVyXSBkZWNpZGVyIGF0ICcke3RoaXMuY3VyTm9kZS5uYW1lfScgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIGJyYW5jaGApO1xuICAgIH1cblxuICAgIC8vIFZhbGlkYXRlIHRoYXQgZXZlcnkgYnJhbmNoIHdpdGggbm8gZW1iZWRkZWQgZm4gaXMgcmVzb2x2YWJsZSBmcm9tIHRoZSBzdGFnZU1hcFxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHtcbiAgICAgIGlmICghY2hpbGQuZm4gJiYgY2hpbGQuaWQgJiYgIWNoaWxkLmlzU3ViZmxvd1Jvb3QgJiYgIWNoaWxkLnN1YmZsb3dSZXNvbHZlcikge1xuICAgICAgICBjb25zdCBoYXNJbk1hcCA9IHRoaXMuYi5fc3RhZ2VNYXBIYXMoY2hpbGQuaWQpIHx8IHRoaXMuYi5fc3RhZ2VNYXBIYXMoY2hpbGQubmFtZSk7XG4gICAgICAgIGlmICghaGFzSW5NYXApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgW0Zsb3dDaGFydEJ1aWxkZXJdIGRlY2lkZXIgYnJhbmNoICcke2NoaWxkLmlkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9JyBoYXMgbm8gZnVuY3Rpb24g4oCUIGAgK1xuICAgICAgICAgICAgICBgcHJvdmlkZSBhIGZuIGFyZ3VtZW50IHRvIGFkZEZ1bmN0aW9uQnJhbmNoKCcke2NoaWxkLmlkfScsIC4uLilgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLmN1ck5vZGUuZGVjaWRlckZuID0gdHJ1ZTtcblxuICAgIC8vIEJ1aWxkIGJyYW5jaElkcyBCRUZPUkUgYXBwZW5kaW5nIHRoZSBzeW50aGV0aWMgZGVmYXVsdCDigJQgb25seSB1c2VyLXNwZWNpZmllZCBicmFuY2hlc1xuICAgIHRoaXMuY3VyU3BlYy5icmFuY2hJZHMgPSBjaGlsZHJlblxuICAgICAgLm1hcCgoYykgPT4gYy5pZClcbiAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgaWQubGVuZ3RoID4gMCk7XG4gICAgdGhpcy5jdXJTcGVjLnR5cGUgPSAnZGVjaWRlcic7XG5cbiAgICBpZiAodGhpcy5kZWZhdWx0SWQpIHtcbiAgICAgIGNvbnN0IGRlZmF1bHRDaGlsZCA9IGNoaWxkcmVuLmZpbmQoKGMpID0+IGMuaWQgPT09IHRoaXMuZGVmYXVsdElkKTtcbiAgICAgIGlmIChkZWZhdWx0Q2hpbGQpIHtcbiAgICAgICAgY2hpbGRyZW4ucHVzaCh7IC4uLmRlZmF1bHRDaGlsZCwgaWQ6ICdkZWZhdWx0JywgYnJhbmNoSWQ6ICdkZWZhdWx0JyB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXIgPiAwKSB7XG4gICAgICBjb25zdCBkZWNpZGVyTGFiZWwgPSB0aGlzLmN1ck5vZGUubmFtZTtcbiAgICAgIGNvbnN0IGJyYW5jaElkTGlzdCA9IHRoaXMuYnJhbmNoRGVzY0luZm8ubWFwKChiKSA9PiBiLmlkKS5qb2luKCcsICcpO1xuICAgICAgY29uc3QgbWFpbkxpbmUgPSB0aGlzLmRlY2lkZXJEZXNjcmlwdGlvblxuICAgICAgICA/IGAke3RoaXMucmVzZXJ2ZWRTdGVwTnVtYmVyfS4gJHtkZWNpZGVyTGFiZWx9IOKAlCAke3RoaXMuZGVjaWRlckRlc2NyaXB0aW9ufSAoYnJhbmNoZXM6ICR7YnJhbmNoSWRMaXN0fSlgXG4gICAgICAgIDogYCR7dGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXJ9LiAke2RlY2lkZXJMYWJlbH0g4oCUIERlY2lkZXMgYmV0d2VlbjogJHticmFuY2hJZExpc3R9YDtcbiAgICAgIHRoaXMucGFyZW50RGVzY3JpcHRpb25QYXJ0cy5wdXNoKG1haW5MaW5lKTtcblxuICAgICAgaWYgKHRoaXMuZGVjaWRlckRlc2NyaXB0aW9uKSB7XG4gICAgICAgIHRoaXMucGFyZW50U3RhZ2VEZXNjcmlwdGlvbnMuc2V0KHRoaXMuY3VyTm9kZS5uYW1lLCB0aGlzLmRlY2lkZXJEZXNjcmlwdGlvbik7XG4gICAgICB9XG5cbiAgICAgIGZvciAoY29uc3QgYnJhbmNoIG9mIHRoaXMuYnJhbmNoRGVzY0luZm8pIHtcbiAgICAgICAgY29uc3QgYnJhbmNoVGV4dCA9IGJyYW5jaC5kZXNjcmlwdGlvbjtcbiAgICAgICAgaWYgKGJyYW5jaFRleHQpIHtcbiAgICAgICAgICB0aGlzLnBhcmVudERlc2NyaXB0aW9uUGFydHMucHVzaChgICAg4oaSICR7YnJhbmNoLmlkfTogJHticmFuY2hUZXh0fWApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChicmFuY2guZGVzY3JpcHRpb24pIHtcbiAgICAgICAgICB0aGlzLnBhcmVudFN0YWdlRGVzY3JpcHRpb25zLnNldChicmFuY2guaWQsIGJyYW5jaC5kZXNjcmlwdGlvbik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBMNy4zIOKAlCBmaXJlIGBvbkRlY2lkZXJDb21wbGV0ZWAgc28gY29uc3VtZXJzIGNhbiB0cnVzdCBubyBtb3JlXG4gICAgLy8gYnJhbmNoZXMgd2lsbCBhcnJpdmUgZm9yIHRoaXMgZGVjaWRlci4gQnJhbmNoIGl0ZXJhdGlvbiBvcmRlciA9XG4gICAgLy8gYWRkaXRpb24gb3JkZXIgPSBTZXQgaW5zZXJ0aW9uIG9yZGVyLlxuICAgIHRoaXMuYi5fZmlyZURlY2lkZXJDb21wbGV0ZUZyb21TdWJCdWlsZGVyKHRoaXMuY3VyU3BlYy5pZCwgJ2RlY2lkZXInLCBbLi4udGhpcy5icmFuY2hJZHNdLCB0aGlzLmRlZmF1bHRJZCk7XG4gICAgcmV0dXJuIHRoaXMuYjtcbiAgfVxufVxuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFNlbGVjdG9yRm5MaXN0IChzY29wZS1iYXNlZCBzZWxlY3RvciDigJQgbWlycm9ycyBEZWNpZGVyTGlzdClcbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgY2xhc3MgU2VsZWN0b3JGbkxpc3Q8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYjogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGN1ck5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGN1clNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgcHJpdmF0ZSByZWFkb25seSBicmFuY2hJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudERlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdO1xuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudFN0YWdlRGVzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xuICBwcml2YXRlIHJlYWRvbmx5IHJlc2VydmVkU3RlcE51bWJlcjogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHNlbGVjdG9yRGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnJhbmNoRGVzY0luZm86IEFycmF5PHsgaWQ6IHN0cmluZzsgZGVzY3JpcHRpb24/OiBzdHJpbmcgfT4gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBidWlsZGVyOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4sXG4gICAgY3VyTm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgY3VyU3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICAgIHBhcmVudERlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdID0gW10sXG4gICAgcGFyZW50U3RhZ2VEZXNjcmlwdGlvbnM6IE1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKCksXG4gICAgcmVzZXJ2ZWRTdGVwTnVtYmVyID0gMCxcbiAgICBzZWxlY3RvckRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApIHtcbiAgICB0aGlzLmIgPSBidWlsZGVyO1xuICAgIHRoaXMuY3VyTm9kZSA9IGN1ck5vZGU7XG4gICAgdGhpcy5jdXJTcGVjID0gY3VyU3BlYztcbiAgICB0aGlzLnBhcmVudERlc2NyaXB0aW9uUGFydHMgPSBwYXJlbnREZXNjcmlwdGlvblBhcnRzO1xuICAgIHRoaXMucGFyZW50U3RhZ2VEZXNjcmlwdGlvbnMgPSBwYXJlbnRTdGFnZURlc2NyaXB0aW9ucztcbiAgICB0aGlzLnJlc2VydmVkU3RlcE51bWJlciA9IHJlc2VydmVkU3RlcE51bWJlcjtcbiAgICB0aGlzLnNlbGVjdG9yRGVzY3JpcHRpb24gPSBzZWxlY3RvckRlc2NyaXB0aW9uO1xuICB9XG5cbiAgYWRkRnVuY3Rpb25CcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgZm4/OiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgc2VsZWN0b3IgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHsgbmFtZTogbmFtZSA/PyBpZCwgaWQsIGJyYW5jaElkOiBpZCB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIGlmIChmbikge1xuICAgICAgbm9kZS5mbiA9IGZuO1xuICAgICAgdGhpcy5iLl9hZGRUb01hcChpZCwgZm4pO1xuICAgIH1cblxuICAgIGNvbnN0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHsgbmFtZTogbmFtZSA/PyBpZCwgaWQsIHR5cGU6ICdzdGFnZScgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIHNwZWMuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcblxuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbiA9IHRoaXMuY3VyTm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4gPSB0aGlzLmN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG4gICAgLy8gTDcuMyDigJQgU2VsZWN0b3IgYnJhbmNoLlxuICAgIHRoaXMuYi5fZmlyZVN0YWdlQWRkZWRGcm9tU3ViQnVpbGRlcihzcGVjKTtcbiAgICB0aGlzLmIuX2ZpcmVFZGdlQWRkZWRGcm9tU3ViQnVpbGRlcih0aGlzLmN1clNwZWMuaWQsIHNwZWMuaWQsICdkZWNpc2lvbi1icmFuY2gnLCBpZCk7XG5cbiAgICB0aGlzLmJyYW5jaERlc2NJbmZvLnB1c2goeyBpZCwgZGVzY3JpcHRpb24gfSk7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGEgcGF1c2FibGUgc3RhZ2UgYXMgYSBzZWxlY3RvciBicmFuY2guXG4gICAqXG4gICAqIFdoZW4gdGhpcyBicmFuY2ggaXMgc2VsZWN0ZWQsIHRoZSBoYW5kbGVyJ3MgYGV4ZWN1dGVgIHJ1bnMuIElmIGl0IHJldHVybnNcbiAgICogZGF0YSwgdGhlIHBpcGVsaW5lIHBhdXNlcy4gT24gcmVzdW1lLCBgaGFuZGxlci5yZXN1bWVgIHJ1bnMgd2l0aCB0aGVcbiAgICogaHVtYW4ncyBpbnB1dC4gSWYgYGV4ZWN1dGVgIHJldHVybnMgdm9pZCwgdGhlIHN0YWdlIGNvbnRpbnVlcyBub3JtYWxseS5cbiAgICovXG4gIGFkZFBhdXNhYmxlRnVuY3Rpb25CcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgaGFuZGxlcjogUGF1c2FibGVIYW5kbGVyPFRTY29wZT4sXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgc2VsZWN0b3IgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IG5hbWUgPz8gaWQsXG4gICAgICBpZCxcbiAgICAgIGJyYW5jaElkOiBpZCxcbiAgICAgIGZuOiBoYW5kbGVyLmV4ZWN1dGUgYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgICAgaXNQYXVzYWJsZTogdHJ1ZSxcbiAgICAgIHJlc3VtZUZuOiBoYW5kbGVyLnJlc3VtZSxcbiAgICB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuYi5fYWRkVG9NYXAoaWQsIGhhbmRsZXIuZXhlY3V0ZSBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCwgdHlwZTogJ3N0YWdlJywgaXNQYXVzYWJsZTogdHJ1ZSB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcbiAgICAvLyBMNy4zIOKAlCBQYXVzYWJsZSBzZWxlY3RvciBicmFuY2guXG4gICAgdGhpcy5iLl9maXJlU3RhZ2VBZGRlZEZyb21TdWJCdWlsZGVyKHNwZWMpO1xuICAgIHRoaXMuYi5fZmlyZUVkZ2VBZGRlZEZyb21TdWJCdWlsZGVyKHRoaXMuY3VyU3BlYy5pZCwgc3BlYy5pZCwgJ2RlY2lzaW9uLWJyYW5jaCcsIGlkKTtcblxuICAgIHRoaXMuYnJhbmNoRGVzY0luZm8ucHVzaCh7IGlkLCBkZXNjcmlwdGlvbiB9KTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZFN1YkZsb3dDaGFydEJyYW5jaChcbiAgICBpZDogc3RyaW5nLFxuICAgIHN1YmZsb3c6IEZsb3dDaGFydDxhbnksIGFueT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiBTZWxlY3RvckZuTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAodGhpcy5icmFuY2hJZHMuaGFzKGlkKSkgZmFpbChgZHVwbGljYXRlIHNlbGVjdG9yIGJyYW5jaCBpZCAnJHtpZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfSdgKTtcbiAgICB0aGlzLmJyYW5jaElkcy5hZGQoaWQpO1xuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgcHJlZml4ZWRSb290ID0gdGhpcy5iLl9wcmVmaXhOb2RlVHJlZShzdWJmbG93LnJvb3QsIGlkKTtcblxuICAgIGlmICghdGhpcy5iLl9zdWJmbG93RGVmcy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLmIuX3N1YmZsb3dEZWZzLnNldChpZCwgeyByb290OiBwcmVmaXhlZFJvb3QgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgYnJhbmNoSWQ6IGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1N0cnVjdHVyZTogc3ViZmxvdy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgfTtcbiAgICAvLyBTVFJVQ1RVUkUtT05MWSBjb252ZXJnZW5jZSBvdmVycmlkZSAoc2VlIGBfZmlyZU5leHRFZGdlRnJvbVBhcmVudGAgK1xuICAgIC8vIGBTdWJmbG93TW91bnRPcHRpb25zLmNvbnZlcmdlQXRgKTogdGhpcyBicmFuY2gncyBjb252ZXJnZW5jZSBlZGdlIHBvaW50cyBhdFxuICAgIC8vIGBjb252ZXJnZUF0YCAoYSBET1dOU1RSRUFNIHN0YWdlKSBpbnN0ZWFkIG9mIHRoZSBzaGFyZWQgbmV4dCBzdGFnZSDigJQgZS5nLiBhXG4gICAgLy8gYHRvb2xzYCBzbG90IHRoYXQgYnlwYXNzZXMgYG1lc3NhZ2VBUElgIHRvIHBhaXIgd2l0aCBpdHMgb3V0cHV0IGF0XG4gICAgLy8gYGNhbGwtbGxtYC4gVmlzdWFsaXphdGlvbi1vbmx5OiBOTyBydW50aW1lIGpvaW4gYmFycmllciAoZGF0YSByaWRlcyBzY29wZSkuXG4gICAgaWYgKG9wdGlvbnM/LmNvbnZlcmdlQXQpIHNwZWMuY29udmVyZ2VBdCA9IG9wdGlvbnMuY29udmVyZ2VBdDtcblxuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbiA9IHRoaXMuY3VyTm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4gPSB0aGlzLmN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG4gICAgLy8gTDcuMyDigJQgU3ViZmxvdyBhcyBzZWxlY3RvciBicmFuY2guXG4gICAgdGhpcy5iLl9maXJlU3RhZ2VBZGRlZEZyb21TdWJCdWlsZGVyKHNwZWMpO1xuICAgIHRoaXMuYi5fZmlyZUVkZ2VBZGRlZEZyb21TdWJCdWlsZGVyKHRoaXMuY3VyU3BlYy5pZCwgc3BlYy5pZCwgJ2RlY2lzaW9uLWJyYW5jaCcsIGlkKTtcbiAgICB0aGlzLmIuX2ZpcmVTdWJmbG93TW91bnRlZEZyb21TdWJCdWlsZGVyKGlkLCBzdWJmbG93TmFtZSwgaWQsIGZhbHNlLCBzdWJmbG93LmJ1aWxkVGltZVN0cnVjdHVyZSk7XG5cbiAgICB0aGlzLmIuX21lcmdlU3RhZ2VNYXAoc3ViZmxvdy5zdGFnZU1hcCwgaWQpO1xuICAgIHRoaXMuYi5fbWVyZ2VTdWJmbG93cyhzdWJmbG93LnN1YmZsb3dzLCBpZCk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZExhenlTdWJGbG93Q2hhcnRCcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICByZXNvbHZlcjogKCkgPT4gRmxvd0NoYXJ0PGFueSwgYW55PixcbiAgICBtb3VudE5hbWU/OiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgc2VsZWN0b3IgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG1vdW50TmFtZSB8fCBpZDtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICBpZCxcbiAgICAgIGJyYW5jaElkOiBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBzdWJmbG93UmVzb2x2ZXI6IHJlc29sdmVyIGFzIGFueSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgaXNMYXp5OiB0cnVlLFxuICAgIH07XG5cbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuID0gdGhpcy5jdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuICAgIC8vIEw3LjMg4oCUIExhenkgc3ViZmxvdyBhcyBzZWxlY3RvciBicmFuY2guXG4gICAgdGhpcy5iLl9maXJlU3RhZ2VBZGRlZEZyb21TdWJCdWlsZGVyKHNwZWMpO1xuICAgIHRoaXMuYi5fZmlyZUVkZ2VBZGRlZEZyb21TdWJCdWlsZGVyKHRoaXMuY3VyU3BlYy5pZCwgc3BlYy5pZCwgJ2RlY2lzaW9uLWJyYW5jaCcsIGlkKTtcbiAgICB0aGlzLmIuX2ZpcmVTdWJmbG93TW91bnRlZEZyb21TdWJCdWlsZGVyKGlkLCBzdWJmbG93TmFtZSwgaWQsIHRydWUpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRCcmFuY2hMaXN0KFxuICAgIGJyYW5jaGVzOiBBcnJheTx7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgZm4/OiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT47XG4gICAgfT4sXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGZvciAoY29uc3QgeyBpZCwgbmFtZSwgZm4gfSBvZiBicmFuY2hlcykge1xuICAgICAgdGhpcy5hZGRGdW5jdGlvbkJyYW5jaChpZCwgbmFtZSwgZm4pO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGVuZCgpOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4ge1xuICAgIGNvbnN0IGNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuO1xuICAgIGlmICghY2hpbGRyZW4gfHwgY2hpbGRyZW4ubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFtGbG93Q2hhcnRCdWlsZGVyXSBzZWxlY3RvciBhdCAnJHt0aGlzLmN1ck5vZGUubmFtZX0nIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBicmFuY2hgKTtcbiAgICB9XG5cbiAgICAvLyBWYWxpZGF0ZSB0aGF0IGV2ZXJ5IGJyYW5jaCB3aXRoIG5vIGVtYmVkZGVkIGZuIGlzIHJlc29sdmFibGUgZnJvbSB0aGUgc3RhZ2VNYXBcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG4gICAgICBpZiAoIWNoaWxkLmZuICYmIGNoaWxkLmlkICYmICFjaGlsZC5pc1N1YmZsb3dSb290ICYmICFjaGlsZC5zdWJmbG93UmVzb2x2ZXIpIHtcbiAgICAgICAgY29uc3QgaGFzSW5NYXAgPSB0aGlzLmIuX3N0YWdlTWFwSGFzKGNoaWxkLmlkKSB8fCB0aGlzLmIuX3N0YWdlTWFwSGFzKGNoaWxkLm5hbWUpO1xuICAgICAgICBpZiAoIWhhc0luTWFwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYFtGbG93Q2hhcnRCdWlsZGVyXSBzZWxlY3RvciBicmFuY2ggJyR7Y2hpbGQuaWR9JyB1bmRlciAnJHt0aGlzLmN1ck5vZGUubmFtZX0nIGhhcyBubyBmdW5jdGlvbiDigJQgYCArXG4gICAgICAgICAgICAgIGBwcm92aWRlIGEgZm4gYXJndW1lbnQgdG8gYWRkRnVuY3Rpb25CcmFuY2goJyR7Y2hpbGQuaWR9JywgLi4uKWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuY3VyTm9kZS5zZWxlY3RvckZuID0gdHJ1ZTtcblxuICAgIHRoaXMuY3VyU3BlYy5icmFuY2hJZHMgPSBjaGlsZHJlblxuICAgICAgLm1hcCgoYykgPT4gYy5pZClcbiAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgaWQubGVuZ3RoID4gMCk7XG4gICAgdGhpcy5jdXJTcGVjLnR5cGUgPSAnc2VsZWN0b3InOyAvLyB3YXMgJ2RlY2lkZXInIOKAlCBpbmNvcnJlY3Q7IHNlbGVjdG9ycyBhcmUgZGlzdGluY3QgZnJvbSBkZWNpZGVyc1xuICAgIHRoaXMuY3VyU3BlYy5oYXNTZWxlY3RvciA9IHRydWU7XG5cbiAgICBpZiAodGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXIgPiAwKSB7XG4gICAgICBjb25zdCBzZWxlY3RvckxhYmVsID0gdGhpcy5jdXJOb2RlLm5hbWU7XG4gICAgICBjb25zdCBicmFuY2hJZExpc3QgPSB0aGlzLmJyYW5jaERlc2NJbmZvLm1hcCgoYikgPT4gYi5pZCkuam9pbignLCAnKTtcbiAgICAgIGNvbnN0IG1haW5MaW5lID0gdGhpcy5zZWxlY3RvckRlc2NyaXB0aW9uXG4gICAgICAgID8gYCR7dGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXJ9LiAke3NlbGVjdG9yTGFiZWx9IOKAlCAke3RoaXMuc2VsZWN0b3JEZXNjcmlwdGlvbn1gXG4gICAgICAgIDogYCR7dGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXJ9LiAke3NlbGVjdG9yTGFiZWx9IOKAlCBTZWxlY3RzIGZyb206ICR7YnJhbmNoSWRMaXN0fWA7XG4gICAgICB0aGlzLnBhcmVudERlc2NyaXB0aW9uUGFydHMucHVzaChtYWluTGluZSk7XG5cbiAgICAgIGlmICh0aGlzLnNlbGVjdG9yRGVzY3JpcHRpb24pIHtcbiAgICAgICAgdGhpcy5wYXJlbnRTdGFnZURlc2NyaXB0aW9ucy5zZXQodGhpcy5jdXJOb2RlLm5hbWUsIHRoaXMuc2VsZWN0b3JEZXNjcmlwdGlvbik7XG4gICAgICB9XG5cbiAgICAgIGZvciAoY29uc3QgYnJhbmNoIG9mIHRoaXMuYnJhbmNoRGVzY0luZm8pIHtcbiAgICAgICAgY29uc3QgYnJhbmNoVGV4dCA9IGJyYW5jaC5kZXNjcmlwdGlvbjtcbiAgICAgICAgaWYgKGJyYW5jaFRleHQpIHRoaXMucGFyZW50RGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAgICDihpIgJHticmFuY2guaWR9OiAke2JyYW5jaFRleHR9YCk7XG4gICAgICAgIGlmIChicmFuY2guZGVzY3JpcHRpb24pIHRoaXMucGFyZW50U3RhZ2VEZXNjcmlwdGlvbnMuc2V0KGJyYW5jaC5pZCwgYnJhbmNoLmRlc2NyaXB0aW9uKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBMNy4zIOKAlCBmaXJlIGBvbkRlY2lkZXJDb21wbGV0ZWAgd2l0aCB0eXBlPSdzZWxlY3RvcicuIFNlbGVjdG9yc1xuICAgIC8vIGhhdmUgbm8gZGVmYXVsdCBicmFuY2ggKG11bHRpLXNlbGVjdCBzZW1hbnRpY3MgZGlmZmVyKTsgcGFzc1xuICAgIC8vIHVuZGVmaW5lZC5cbiAgICB0aGlzLmIuX2ZpcmVEZWNpZGVyQ29tcGxldGVGcm9tU3ViQnVpbGRlcih0aGlzLmN1clNwZWMuaWQsICdzZWxlY3RvcicsIFsuLi50aGlzLmJyYW5jaElkc10pO1xuICAgIHJldHVybiB0aGlzLmI7XG4gIH1cbn1cblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBGbG93Q2hhcnRCdWlsZGVyXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGNsYXNzIEZsb3dDaGFydEJ1aWxkZXI8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgX3Jvb3Q/OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSBfcm9vdFNwZWM/OiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gIHByaXZhdGUgX2N1cnNvcj86IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIF9jdXJzb3JTcGVjPzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlO1xuICBwcml2YXRlIF9zdGFnZU1hcCA9IG5ldyBNYXA8c3RyaW5nLCBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4+KCk7XG4gIF9zdWJmbG93RGVmcyA9IG5ldyBNYXA8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+KCk7XG4gIHByaXZhdGUgX3N0cmVhbUhhbmRsZXJzOiBTdHJlYW1IYW5kbGVycyA9IHt9O1xuICAvKipcbiAgICogTDcuMyDigJQgQnVpbGQtdGltZSBvYnNlcnZlciBmYW4tb3V0LiBPd25lZCBieSB0aGUgYnVpbGRlciBzbyBldmVyeVxuICAgKiBgYWRkWCgpYCBtZXRob2QgY2FuIGZpcmUgYFN0cnVjdHVyZVJlY29yZGVyYCBldmVudHMgYXQgdGhlIG5hdHVyYWxcbiAgICogbW9tZW50IG9mIHRoZSBjb3JyZXNwb25kaW5nIG11dGF0aW9uLiBEaXNwYXRjaGVyIGlzIGFsbG9jYXRlZFxuICAgKiBsYXppbHkgb24gZmlyc3QgYXR0YWNoIHRvIGtlZXAgdGhlIHplcm8tcmVjb3JkZXIgcGF0aCBhbGxvY2F0aW9uLVxuICAgKiBmcmVlLlxuICAgKi9cbiAgcHJpdmF0ZSBfc3RydWN0dXJlRGlzcGF0Y2hlcj86IFN0cnVjdHVyZVJlY29yZGVyRGlzcGF0Y2hlcjtcbiAgLyoqXG4gICAqIEw3LjMg4oCUIFNlYWxlZC1hZnRlci1idWlsZCBmbGFnIChQYW5lbCAyIHBoYXNlIGludmFyaWFudCkuIEZsaXBzXG4gICAqIHRvIGB0cnVlYCB3aGVuIGAuYnVpbGQoKWAgcmV0dXJuczsgc3Vic2VxdWVudCBgYXR0YWNoU3RydWN0dXJlUmVjb3JkZXJgXG4gICAqIHRocm93cy4gUHJldmVudHMgdGhlIGZvb3RndW4gd2hlcmUgYSBjb25zdW1lciBhdHRhY2hlcyBhIHJlY29yZGVyXG4gICAqIG1pZC1leGVjdXRpb24gYW5kIGdldHMgcGFydGlhbCBzdHJ1Y3R1cmUgZGF0YSAobWlzc2VkIGV2ZXJ5IGV2ZW50XG4gICAqIGFscmVhZHkgZmlyZWQgZHVyaW5nIGNvbnN0cnVjdGlvbikuXG4gICAqL1xuICBwcml2YXRlIF9zZWFsZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBfZW5hYmxlTmFycmF0aXZlID0gZmFsc2U7XG4gIHByaXZhdGUgX2xvZ2dlcj86IElMb2dnZXI7XG4gIHByaXZhdGUgX2Rlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdID0gW107XG4gIHByaXZhdGUgX3N0ZXBDb3VudGVyID0gMDtcbiAgLy8gTk9URToga2V5ZWQgYnkgc3RhZ2UgbmFtZSAoZm9yIGh1bWFuLXJlYWRhYmxlIGRlc2NyaXB0aW9ucyksIHdoaWxlIHN0YWdlTWFwXG4gIC8vIGFuZCBrbm93blN0YWdlSWRzIHVzZSBpZCAoc3RhYmxlIGlkZW50aWZpZXIpLiBUaGVzZSBhcmUgaW50ZW50aW9uYWxseSBkaWZmZXJlbnRcbiAgLy8gbmFtZXNwYWNlcyDigJQgZGVzY3JpcHRpb25zIGFyZSBwcmVzZW50YXRpb25hbCwgbG9va3VwcyBhcmUgc3RydWN0dXJhbC5cbiAgcHJpdmF0ZSBfc3RhZ2VEZXNjcmlwdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBwcml2YXRlIF9zdGFnZVN0ZXBNYXAgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBwcml2YXRlIF9rbm93blN0YWdlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHByaXZhdGUgX2lucHV0U2NoZW1hPzogdW5rbm93bjtcbiAgcHJpdmF0ZSBfb3V0cHV0U2NoZW1hPzogdW5rbm93bjtcbiAgcHJpdmF0ZSBfb3V0cHV0TWFwcGVyPzogKGZpbmFsU2NvcGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB1bmtub3duO1xuICBwcml2YXRlIF9zY29wZUZhY3Rvcnk/OiBTY29wZUZhY3Rvcnk8VFNjb3BlPjtcblxuICAvLyDilIDilIAgTDcuMyDigJQgU3RydWN0dXJlUmVjb3JkZXIgYXR0YWNoICsgZGlzcGF0Y2ggaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQXR0YWNoIGEgYFN0cnVjdHVyZVJlY29yZGVyYCBmb3IgYnVpbGQtcGhhc2Ugb2JzZXJ2YXRpb24uIE11bHRpcGxlXG4gICAqIHJlY29yZGVycyBjb2V4aXN0IChzYW1lIGlkIGFsbG93ZWQ7IGl0ZXJhdGlvbiBvcmRlciA9IGF0dGFjaFxuICAgKiBvcmRlcikuIFRocm93cyBpZiBjYWxsZWQgYWZ0ZXIgYC5idWlsZCgpYCDigJQgdGhlIGNoYXJ0IGlzIHNlYWxlZCBhdFxuICAgKiB0aGF0IHBvaW50IGFuZCBhbnkgcmVjb3JkZXIgYXR0YWNoZWQgbGF0ZSB3b3VsZCBtaXNzIGV2ZXJ5IGV2ZW50XG4gICAqIGZpcmVkIGR1cmluZyBjb25zdHJ1Y3Rpb24uXG4gICAqXG4gICAqICoqU2VlZCByZXBsYXkqKjogd2hlbiB0aGlzIGlzIGNhbGxlZCBBRlRFUiBgc3RhcnQoKWAgaGFzIGFscmVhZHlcbiAgICogZmlyZWQgKGkuZS4sIGFmdGVyIHRoZSBgZmxvd0NoYXJ0KClgIGZhY3RvcnkgcmV0dXJucyksIHRoZVxuICAgKiBqdXN0LWF0dGFjaGVkIHJlY29yZGVyIHJlY2VpdmVzIGEgb25lLXRpbWUgYG9uU3RhZ2VBZGRlZGAgZm9yIHRoZVxuICAgKiByb290IHN0YWdlIHNvIGl0IG9ic2VydmVzIHRoZSBzZWVkLiBPbmx5IHRoZSBuZXcgcmVjb3JkZXIgc2Vlc1xuICAgKiB0aGUgcmVwbGF5OyBhbHJlYWR5LWF0dGFjaGVkIHJlY29yZGVycyBhcmUgbm90IHJlLWZpcmVkLlxuICAgKlxuICAgKiAqKk1pZC1jaGFpbiBhdHRhY2ggY2F2ZWF0Kio6IGEgcmVjb3JkZXIgYXR0YWNoZWQgQUZURVIgb25lIG9yIG1vcmVcbiAgICogYGFkZFgoKWAgY2FsbHMgcmVjZWl2ZXMgdGhlIHNlZWQgcmVwbGF5IGJ1dCBNSVNTRVMgZXZlcnlcbiAgICogaW50ZXJtZWRpYXRlIGV2ZW50LiBBdHRhY2ggQkVGT1JFIHRoZSBmaXJzdCBgYWRkWCgpYCBmb3IgY29tcGxldGVcbiAgICogY2FwdHVyZS5cbiAgICpcbiAgICogUHVibGljIGZvciBub3cgdG8gZW5hYmxlIGRpcmVjdCBhdHRhY2ggaW4gdGVzdHMgKyBlYXJseSBjb25zdW1lcnMuXG4gICAqIEw3LjQgd2lsbCB3aXJlIGBmbG93Q2hhcnQoLi4uLCB7IHN0cnVjdHVyZVJlY29yZGVyczogWy4uLl0gfSlgIGFzXG4gICAqIGFuIGFkZGl0aW9uYWwgcmVnaXN0cmF0aW9uIHNpdGU7IHRoaXMgbWV0aG9kIHdpbGwgcmVtYWluLlxuICAgKi9cbiAgYXR0YWNoU3RydWN0dXJlUmVjb3JkZXIocmVjb3JkZXI6IFN0cnVjdHVyZVJlY29yZGVyKTogdGhpcyB7XG4gICAgaWYgKHRoaXMuX3NlYWxlZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgW0Zsb3dDaGFydEJ1aWxkZXJdIGF0dGFjaFN0cnVjdHVyZVJlY29yZGVyKCcke3JlY29yZGVyLmlkfScpIGNhbGxlZCBhZnRlciAuYnVpbGQoKSDigJQgY2hhcnQgaXMgc2VhbGVkOyBgICtcbiAgICAgICAgICAndGhlIHJlY29yZGVyIHdvdWxkIG1pc3MgZXZlcnkgc3RydWN0dXJlIGV2ZW50IGZyb20gY29uc3RydWN0aW9uLiBBdHRhY2ggQkVGT1JFIC5idWlsZCgpLicsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoIXRoaXMuX3N0cnVjdHVyZURpc3BhdGNoZXIpIHtcbiAgICAgIHRoaXMuX3N0cnVjdHVyZURpc3BhdGNoZXIgPSBuZXcgU3RydWN0dXJlUmVjb3JkZXJEaXNwYXRjaGVyKCk7XG4gICAgfVxuICAgIHRoaXMuX3N0cnVjdHVyZURpc3BhdGNoZXIuYXR0YWNoKHJlY29yZGVyKTtcbiAgICAvLyBUaGUgc2VlZCBmaXJlcyBpbnNpZGUgYHN0YXJ0KClgIOKAlCB0aGF0IHJ1bnMgQkVGT1JFIHRoZSBjb25zdW1lclxuICAgIC8vIGNhbiBwb3N0LWNvbnN0cnVjdCBhdHRhY2guIFJlcGxheSB0aGUgc2VlZCBldmVudCBPTkxZIGludG8gdGhlXG4gICAgLy8ganVzdC1hdHRhY2hlZCByZWNvcmRlciBzbyBvdGhlciBhbHJlYWR5LWF0dGFjaGVkIHJlY29yZGVycyBkb24ndFxuICAgIC8vIHNlZSBhIGR1cGxpY2F0ZS4gRXJyb3JzIGFyZSByb3V0ZWQgdGhyb3VnaCB0aGUgZGlzcGF0Y2hlcidzXG4gICAgLy8gYWNjdW11bGF0b3Igc28gdGhlIGNvbnRyYWN0IHN0YXlzIHVuaWZvcm0uXG4gICAgaWYgKHRoaXMuX3Jvb3RTcGVjKSB7XG4gICAgICB0cnkge1xuICAgICAgICByZWNvcmRlci5vblN0YWdlQWRkZWQ/Lih7XG4gICAgICAgICAgc3RhZ2VJZDogdGhpcy5fcm9vdFNwZWMuaWQsXG4gICAgICAgICAgbmFtZTogdGhpcy5fcm9vdFNwZWMubmFtZSxcbiAgICAgICAgICB0eXBlOiB0aGlzLl9yb290U3BlYy50eXBlID8/ICdzdGFnZScsXG4gICAgICAgICAgLi4uKHRoaXMuX3Jvb3RTcGVjLmlzUGF1c2FibGUgPT09IHRydWUgJiYgeyBpc1BhdXNhYmxlOiB0cnVlIH0pLFxuICAgICAgICAgIHNwZWM6IHRoaXMuX3Jvb3RTcGVjIGFzIHVua25vd24gYXMgRmxvd0NoYXJ0U3BlYyxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgdGhpcy5fc3RydWN0dXJlRGlzcGF0Y2hlci5yZWNvcmRFcnJvckZvclJlcGxheShyZWNvcmRlci5pZCwgJ29uU3RhZ2VBZGRlZCcsIGVycik7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLyoqXG4gICAqIEluc3BlY3QgYWNjdW11bGF0ZWQgYFN0cnVjdHVyZUJ1aWxkRXJyb3Jgcy4gUmV0dXJucyBlbXB0eSBhcnJheVxuICAgKiB3aGVuIG5vIHJlY29yZGVycyBhdHRhY2hlZCBPUiBubyBlcnJvcnMgb2NjdXJyZWQuIFJldHVybnMgYVxuICAgKiBkZWZlbnNpdmUgY29weSDigJQgY2FsbGVyIG11dGF0aW9ucyBkbyBub3QgYWZmZWN0IHN1YnNlcXVlbnQgY2FsbHMuXG4gICAqXG4gICAqICoqQ2FsbCBvbiB0aGUgQlVJTERFUiwgbm90IHRoZSBjaGFydCByZXR1cm5lZCBieSBgLmJ1aWxkKClgLioqXG4gICAqIENhcHR1cmUgdGhlIGJ1aWxkZXIgcmVmZXJlbmNlIGJlZm9yZSBgLmJ1aWxkKClgIGlmIHlvdSBuZWVkXG4gICAqIHBvc3QtYnVpbGQgYWNjZXNzOlxuICAgKiBgYGB0c1xuICAgKiBjb25zdCBidWlsZGVyID0gZmxvd0NoYXJ0KC4uLikuYXR0YWNoU3RydWN0dXJlUmVjb3JkZXIocmVjKTtcbiAgICogY29uc3QgY2hhcnQgPSBidWlsZGVyLmJ1aWxkKCk7XG4gICAqIGNvbnN0IGVycm9ycyA9IGJ1aWxkZXIuZ2V0U3RydWN0dXJlQnVpbGRFcnJvcnMoKTtcbiAgICogYGBgXG4gICAqL1xuICBnZXRTdHJ1Y3R1cmVCdWlsZEVycm9ycygpOiBSZXR1cm5UeXBlPFN0cnVjdHVyZVJlY29yZGVyRGlzcGF0Y2hlclsnZ2V0RXJyb3JzJ10+IHtcbiAgICByZXR1cm4gdGhpcy5fc3RydWN0dXJlRGlzcGF0Y2hlcj8uZ2V0RXJyb3JzKCkgPz8gW107XG4gIH1cblxuICAvLyBDb252ZW5pZW5jZSBmaXJlIGhlbHBlcnMg4oCUIG5vLW9wIHdoZW4gbm8gZGlzcGF0Y2hlciBhdHRhY2hlZC4gS2VlcHNcbiAgLy8gZXZlcnkgY2FsbCBzaXRlIGEgb25lLWxpbmVyIHdpdGhvdXQgdGhlIGBpZiAodGhpcy5fc3RydWN0dXJlRGlzcGF0Y2hlcilgXG4gIC8vIGJvaWxlcnBsYXRlIGV2ZXJ5d2hlcmUuXG4gIHByaXZhdGUgX2ZpcmVTdGFnZUFkZGVkKHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSk6IHZvaWQge1xuICAgIGlmICghdGhpcy5fc3RydWN0dXJlRGlzcGF0Y2hlcikgcmV0dXJuO1xuICAgIC8vIFJlYWQgYGlzUGF1c2FibGVgIGRpcmVjdGx5IGZyb20gdGhlIHNwZWMg4oCUIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGguXG4gICAgLy8gVGhlIHByZXZpb3VzIGBleHRyYXNgIGFyZ3VtZW50IHdhcyBhIHN1Yi1idWlsZGVyIGZvb3RndW46IGJyYW5jaFxuICAgIC8vIGhlbHBlcnMgaW4gRGVjaWRlckxpc3QvU2VsZWN0b3JGbkxpc3Qgd2VudCB0aHJvdWdoXG4gICAgLy8gYF9maXJlU3RhZ2VBZGRlZEZyb21TdWJCdWlsZGVyYCB3aGljaCBkcm9wcGVkIHRoZSBleHRyYXMsIHNpbGVudGx5XG4gICAgLy8gbG9zaW5nIGBpc1BhdXNhYmxlOiB0cnVlYCBvbiBwYXVzYWJsZSBkZWNpZGVyL3NlbGVjdG9yIGJyYW5jaGVzLlxuICAgIGNvbnN0IGlzUGF1c2FibGUgPSBzcGVjLmlzUGF1c2FibGUgPT09IHRydWU7XG4gICAgdGhpcy5fc3RydWN0dXJlRGlzcGF0Y2hlci5maXJlU3RhZ2VBZGRlZCh7XG4gICAgICBzdGFnZUlkOiBzcGVjLmlkLFxuICAgICAgbmFtZTogc3BlYy5uYW1lLFxuICAgICAgdHlwZTogc3BlYy50eXBlID8/ICdzdGFnZScsXG4gICAgICAuLi4oaXNQYXVzYWJsZSAmJiB7IGlzUGF1c2FibGU6IHRydWUgfSksXG4gICAgICBzcGVjOiBzcGVjIGFzIHVua25vd24gYXMgRmxvd0NoYXJ0U3BlYyxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX2ZpcmVFZGdlQWRkZWQoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nLCBraW5kOiBTdHJ1Y3R1cmVFZGdlS2luZCwgbGFiZWw/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuX3N0cnVjdHVyZURpc3BhdGNoZXIpIHJldHVybjtcbiAgICB0aGlzLl9zdHJ1Y3R1cmVEaXNwYXRjaGVyLmZpcmVFZGdlQWRkZWQoe1xuICAgICAgZnJvbSxcbiAgICAgIHRvLFxuICAgICAga2luZCxcbiAgICAgIC4uLihsYWJlbCAhPT0gdW5kZWZpbmVkICYmIHsgbGFiZWwgfSksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIF9maXJlTG9vcEVkZ2VBZGRlZChmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuX3N0cnVjdHVyZURpc3BhdGNoZXIpIHJldHVybjtcbiAgICB0aGlzLl9zdHJ1Y3R1cmVEaXNwYXRjaGVyLmZpcmVMb29wRWRnZUFkZGVkKHsgZnJvbSwgdG8gfSk7XG4gIH1cblxuICAvKipcbiAgICogRmlyZSB0aGUgYG5leHRgIGVkZ2UocykgZnJvbSBhIHBhcmVudCBzcGVjIHRvIGEgZnJlc2hseS1hZGRlZFxuICAgKiBub2RlIOKAlCB3aXRoIGNvbnZlcmdlbmNlIGV4cGFuc2lvbiB3aGVuIHRoZSBwYXJlbnQgaXMgYVxuICAgKiBmb3JrIC8gZGVjaWRlciAvIHNlbGVjdG9yIHdpdGggYnJhbmNoZXMuXG4gICAqXG4gICAqIEEgZm9yayBhdCBgcGFyZW50YCBpcyBzZW1hbnRpY2FsbHkgYHBhcmVudCDilIDilIBmb3JrLWJyYW5jaOKUgOKUgOKWuiBjaGlsZFtpXWBcbiAgICogZm9yIGVhY2ggY2hpbGQsIGFuZCB0aGUgY2hhaW5lZCBgLmFkZEZ1bmN0aW9uKFgpYCBjb250aW51ZXNcbiAgICogQUZURVIgdGhlIGZvcmsgY29udmVyZ2VzLiBUaGUgcnVudGltZSBzZW1hbnRpY3MgYXJlIHRoYXQgZWFjaFxuICAgKiBjaGlsZCBJTkRFUEVOREVOVExZIGZlZWRzIGBYYCAocGFyYWxsZWwgY29tcGxldGlvbiDihpIgam9pbikuIFRoZVxuICAgKiBsaXRlcmFsIFwiZWRnZSBmcm9tIHBhcmVudCB0byBYXCIgd291bGQgbWlzcmVwcmVzZW50IHRoaXMg4oCUXG4gICAqIHZpc3VhbGl6ZXJzIGFuZCB0b3BvbG9naWNhbCBhbGdvcml0aG1zIHdvdWxkIHNlZSBvbmUgZWRnZSB3aGVyZVxuICAgKiB0aGVyZSBzaG91bGQgYmUgTiBjb252ZXJnZW5jZSBlZGdlcy5cbiAgICpcbiAgICogRml4OiB3aGVuIGBwYXJlbnRTcGVjYCBoYXMgYnJhbmNoIGNoaWxkcmVuIChmb3JrIG9yIGJyYW5jaGVkXG4gICAqIGRlY2lkZXIvc2VsZWN0b3IpLCBmaXJlIG9uZSBgbmV4dGAgZWRnZSBmcm9tIEVBQ0ggY2hpbGQgdG8gdGhlXG4gICAqIHRhcmdldC4gT3RoZXJ3aXNlIGZpcmUgdGhlIHNpbmdsZSBlZGdlIGZyb20gYHBhcmVudFNwZWNgIGl0c2VsZi5cbiAgICpcbiAgICogTG9vcC1yZWZlcmVuY2UgY2hpbGRyZW4gKHN5bnRoZXRpYyBzcGVjIG5vZGVzIGNyZWF0ZWQgYnlcbiAgICogYC5sb29wVG8oKWApIGFyZSBleGNsdWRlZCDigJQgdGhleSdyZSBiYWNrLWVkZ2UgbWFya2Vycywgbm90XG4gICAqIGNvbnZlcmdlbmNlIHNvdXJjZXMuIEEgYnJhbmNoIHRoYXQgY2FycmllcyBhbiBPV04gbG9vcC1iYWNrIGBuZXh0YFxuICAgKiAoYSBicmFuY2gtc291cmNlZCBgbG9vcFRvYCkgaXMgbGlrZXdpc2Ugc2tpcHBlZCDigJQgaXQgbG9vcHMsIGl0IGRvZXNcbiAgICogbm90IGNvbnZlcmdlIGF0IHRoZSBsaW5lYXIgbmV4dCBzdGFnZS5cbiAgICpcbiAgICogQSBicmFuY2ggY2FycnlpbmcgYGNvbnZlcmdlQXRgIGlzIFJFRElSRUNURUQ6IGl0cyBzaW5nbGUgY29udmVyZ2VuY2VcbiAgICogZWRnZSBmaXJlcyB0byBpdHMgbmFtZWQgdGFyZ2V0IGluc3RlYWQgb2YgYHRhcmdldElkYCDigJQgZXhwcmVzc2luZyBhblxuICAgKiB1bmVxdWFsLWRlcHRoIG1lcmdlIChlLmcuIGB0b29scyDihpIgY2FsbC1sbG1gLCBieXBhc3NpbmcgYG1lc3NhZ2UtYXBpYCkuXG4gICAqIFRoZSBuYW1lZCB0YXJnZXQgaXMgYSBmb3J3YXJkIHN0YWdlLCBzbyBpdCBpcyBOT1QgdmFsaWRhdGVkIGhlcmUuXG4gICAqXG4gICAqIENhbGwgT1JERVIgY29uc3RyYWludDogbXVzdCBiZSBjYWxsZWQgQkVGT1JFIHRoZSBjdXJzb3IgYWR2YW5jZXNcbiAgICogdG8gdGhlIG5ldyB0YXJnZXQuIFRoZSBjYWxsZXIgcGFzc2VzIHRoZSBQUkUtQURWQU5DRSBwYXJlbnQgc3BlYy5cbiAgICovXG4gIHByaXZhdGUgX2ZpcmVOZXh0RWRnZUZyb21QYXJlbnQocGFyZW50U3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLCB0YXJnZXRJZDogc3RyaW5nLCBsYWJlbD86IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5fc3RydWN0dXJlRGlzcGF0Y2hlcikgcmV0dXJuO1xuICAgIGNvbnN0IGNoaWxkU3BlY3MgPSBwYXJlbnRTcGVjLmNoaWxkcmVuO1xuICAgIGNvbnN0IGlzQnJhbmNoaW5nUGFyZW50ID1cbiAgICAgIChwYXJlbnRTcGVjLnR5cGUgPT09ICdmb3JrJyB8fCBwYXJlbnRTcGVjLnR5cGUgPT09ICdkZWNpZGVyJyB8fCBwYXJlbnRTcGVjLnR5cGUgPT09ICdzZWxlY3RvcicpICYmXG4gICAgICBBcnJheS5pc0FycmF5KGNoaWxkU3BlY3MpICYmXG4gICAgICBjaGlsZFNwZWNzLmxlbmd0aCA+IDA7XG4gICAgaWYgKCFpc0JyYW5jaGluZ1BhcmVudCkge1xuICAgICAgdGhpcy5fZmlyZUVkZ2VBZGRlZChwYXJlbnRTcGVjLmlkLCB0YXJnZXRJZCwgJ25leHQnLCBsYWJlbCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRTcGVjcyEpIHtcbiAgICAgIGlmIChjaGlsZC5pc0xvb3BSZWZlcmVuY2UpIGNvbnRpbnVlO1xuICAgICAgLy8gQSBicmFuY2ggd2l0aCBpdHMgb3duIGxvb3AtYmFjayBuZXh0IChicmFuY2gtc291cmNlZCBsb29wVG8pIGxvb3BzIOKAlFxuICAgICAgLy8gaXQgZG9lcyBub3QgY29udmVyZ2UgYXQgdGhlIGxpbmVhciBuZXh0IHN0YWdlLlxuICAgICAgaWYgKGNoaWxkLm5leHQ/LmlzTG9vcFJlZmVyZW5jZSkgY29udGludWU7XG4gICAgICBpZiAoY2hpbGQuY29udmVyZ2VBdCkge1xuICAgICAgICAvLyBSZWRpcmVjdGVkIGNvbnZlcmdlbmNlOiB0aGlzIGJyYW5jaCByZWpvaW5zIGF0IGl0cyBuYW1lZCB0YXJnZXQuXG4gICAgICAgIHRoaXMuX2ZpcmVFZGdlQWRkZWQoY2hpbGQuaWQsIGNoaWxkLmNvbnZlcmdlQXQsICduZXh0Jyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgdGhpcy5fZmlyZUVkZ2VBZGRlZChjaGlsZC5pZCwgdGFyZ2V0SWQsICduZXh0JywgbGFiZWwpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgX2ZpcmVEZWNpZGVyQ29tcGxldGUoXG4gICAgZGVjaWRlcjogc3RyaW5nLFxuICAgIHR5cGU6ICdkZWNpZGVyJyB8ICdzZWxlY3RvcicsXG4gICAgYnJhbmNoSWRzOiBzdHJpbmdbXSxcbiAgICBkZWZhdWx0QnJhbmNoPzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuX3N0cnVjdHVyZURpc3BhdGNoZXIpIHJldHVybjtcbiAgICB0aGlzLl9zdHJ1Y3R1cmVEaXNwYXRjaGVyLmZpcmVEZWNpZGVyQ29tcGxldGUoe1xuICAgICAgZGVjaWRlcixcbiAgICAgIHR5cGUsXG4gICAgICBicmFuY2hJZHMsXG4gICAgICAuLi4oZGVmYXVsdEJyYW5jaCAhPT0gdW5kZWZpbmVkICYmIHsgZGVmYXVsdEJyYW5jaCB9KSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX2ZpcmVTdWJmbG93TW91bnRlZChcbiAgICBzdWJmbG93SWQ6IHN0cmluZyxcbiAgICBzdWJmbG93TmFtZTogc3RyaW5nLFxuICAgIHJvb3RTdGFnZUlkOiBzdHJpbmcsXG4gICAgaXNMYXp5PzogYm9vbGVhbixcbiAgICBzdWJmbG93U3BlYz86IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSxcbiAgICBzdWJmbG93UGF0aD86IHN0cmluZyxcbiAgKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLl9zdHJ1Y3R1cmVEaXNwYXRjaGVyKSByZXR1cm47XG4gICAgLy8gc3ViZmxvd1BhdGggZGVmYXVsdHMgdG8gc3ViZmxvd0lkIHdoZW4gdGhlIHJlY29yZGVyIGlzIGF0dGFjaGVkXG4gICAgLy8gdG8gdGhlIGltbWVkaWF0ZSBwYXJlbnQgKHRvcC1sZXZlbCBtb3VudCk7IGNvbXBvc2VkIHBhdGhzIGFwcGx5XG4gICAgLy8gb25seSB3aGVuIHRoaXMgYnVpbGRlciBpcyBpdHNlbGYgYSBuZXN0ZWQgc3ViZmxvdyBiZWluZ1xuICAgIC8vIG9ic2VydmVkIGJ5IHRoZSBncmFuZHBhcmVudCdzIHJlY29yZGVyLlxuICAgIGNvbnN0IHBhdGggPSBzdWJmbG93UGF0aCA/PyBzdWJmbG93SWQ7XG4gICAgdGhpcy5fc3RydWN0dXJlRGlzcGF0Y2hlci5maXJlU3ViZmxvd01vdW50ZWQoe1xuICAgICAgc3ViZmxvd0lkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICByb290U3RhZ2VJZCxcbiAgICAgIC4uLihpc0xhenkgPT09IHRydWUgJiYgeyBpc0xhenkgfSksXG4gICAgICAuLi4oc3ViZmxvd1NwZWMgIT09IHVuZGVmaW5lZCAmJiB7IHN1YmZsb3dTcGVjIH0pLFxuICAgICAgc3ViZmxvd1BhdGg6IHBhdGgsXG4gICAgfSk7XG4gIH1cblxuICAvKiogU3ViLWJ1aWxkZXIgYWNjZXNzIChgLmIuX2ZpcmVYeHhgKSBpcyBuZWVkZWQgYnkgRGVjaWRlckxpc3QgL1xuICAgKiAgU2VsZWN0b3JGbkxpc3Q7IGV4cG9zZSB0aGUgZGlzcGF0Y2hlciB0aHJvdWdoIGludGVybmFsIGhlbHBlcnNcbiAgICogIHRoYXQgZ28gdGhyb3VnaCB0aGUgc2FtZSBuby1vcC13aGVuLWFic2VudCBndWFyZC5cbiAgICpcbiAgICogIEBpbnRlcm5hbCDigJQgdGhlc2UgbWV0aG9kcyBhcmUgZXhwb3NlZCBiZWNhdXNlIFR5cGVTY3JpcHQgYHByaXZhdGVgXG4gICAqICBkb2Vzbid0IHRyYXZlcnNlIGNsYXNzIGJvdW5kYXJpZXMuIENvbnN1bWVyIGNvZGUgTVVTVCBOT1QgY2FsbFxuICAgKiAgdGhlbTsgY2FsbGluZyB0aGVtIHBvc3QtY29uc3RydWN0aW9uIGxldHMgYSBob3N0aWxlIGNhbGxlclxuICAgKiAgZmFicmljYXRlIHN0cnVjdHVyZSBldmVudHMgYW5kIGNvcnJ1cHQgZG93bnN0cmVhbSB2aXN1YWxpemF0aW9uc1xuICAgKiAgb3IgYXVkaXQgdHJhaWxzLiBUaGUgYF9gIHByZWZpeCBpcyBpbnRlbnRpb25hbCBjb252ZW50aW9uLiAqL1xuICBfZmlyZUVkZ2VBZGRlZEZyb21TdWJCdWlsZGVyKGZyb206IHN0cmluZywgdG86IHN0cmluZywga2luZDogU3RydWN0dXJlRWRnZUtpbmQsIGxhYmVsPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fZmlyZUVkZ2VBZGRlZChmcm9tLCB0bywga2luZCwgbGFiZWwpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCDigJQgc2VlIGBfZmlyZUVkZ2VBZGRlZEZyb21TdWJCdWlsZGVyYC4gKi9cbiAgX2ZpcmVTdGFnZUFkZGVkRnJvbVN1YkJ1aWxkZXIoc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlKTogdm9pZCB7XG4gICAgdGhpcy5fZmlyZVN0YWdlQWRkZWQoc3BlYyk7XG4gIH1cblxuICAvKiogQGludGVybmFsIOKAlCBzZWUgYF9maXJlRWRnZUFkZGVkRnJvbVN1YkJ1aWxkZXJgLiAqL1xuICBfZmlyZURlY2lkZXJDb21wbGV0ZUZyb21TdWJCdWlsZGVyKFxuICAgIGRlY2lkZXI6IHN0cmluZyxcbiAgICB0eXBlOiAnZGVjaWRlcicgfCAnc2VsZWN0b3InLFxuICAgIGJyYW5jaElkczogc3RyaW5nW10sXG4gICAgZGVmYXVsdEJyYW5jaD86IHN0cmluZyxcbiAgKTogdm9pZCB7XG4gICAgdGhpcy5fZmlyZURlY2lkZXJDb21wbGV0ZShkZWNpZGVyLCB0eXBlLCBicmFuY2hJZHMsIGRlZmF1bHRCcmFuY2gpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCDigJQgc2VlIGBfZmlyZUVkZ2VBZGRlZEZyb21TdWJCdWlsZGVyYC4gKi9cbiAgX2ZpcmVTdWJmbG93TW91bnRlZEZyb21TdWJCdWlsZGVyKFxuICAgIHN1YmZsb3dJZDogc3RyaW5nLFxuICAgIHN1YmZsb3dOYW1lOiBzdHJpbmcsXG4gICAgcm9vdFN0YWdlSWQ6IHN0cmluZyxcbiAgICBpc0xhenk/OiBib29sZWFuLFxuICAgIHN1YmZsb3dTcGVjPzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICAgIHN1YmZsb3dQYXRoPzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICB0aGlzLl9maXJlU3ViZmxvd01vdW50ZWQoc3ViZmxvd0lkLCBzdWJmbG93TmFtZSwgcm9vdFN0YWdlSWQsIGlzTGF6eSwgc3ViZmxvd1NwZWMsIHN1YmZsb3dQYXRoKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwg4oCUIHNlZSBgX2ZpcmVFZGdlQWRkZWRGcm9tU3ViQnVpbGRlcmAuIFVzZWQgYnkgYERlY2lkZXJMaXN0Lmxvb3BUb2BcbiAgICogIHRvIHZhbGlkYXRlIGEgYnJhbmNoLXNvdXJjZWQgbG9vcCB0YXJnZXQgYWdhaW5zdCB0aGUga25vd24gc3RhZ2UgaWRzXG4gICAqICAobWlycm9ycyBgRmxvd0NoYXJ0QnVpbGRlci5sb29wVG9gJ3MgYF9rbm93blN0YWdlSWRzLmhhc2AgZ3VhcmQpLiAqL1xuICBfa25vd25TdGFnZUlkc0hhcyhpZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX2tub3duU3RhZ2VJZHMuaGFzKGlkKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwg4oCUIHNlZSBgX2ZpcmVFZGdlQWRkZWRGcm9tU3ViQnVpbGRlcmAuIFVzZWQgYnkgYERlY2lkZXJMaXN0Lmxvb3BUb2BcbiAgICogIHRvIGZpcmUgYSBsb29wIGJhY2stZWRnZSBTT1VSQ0VEIEZST00gQSBCUkFOQ0ggbm9kZSAobm90IHRoZSBkZWNpZGVyKS4gKi9cbiAgX2ZpcmVMb29wRWRnZUFkZGVkRnJvbVN1YkJ1aWxkZXIoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fZmlyZUxvb3BFZGdlQWRkZWQoZnJvbSwgdG8pO1xuICB9XG5cbiAgLy8g4pSA4pSAIERlc2NyaXB0aW9uIGhlbHBlcnMg4pSA4pSAXG5cbiAgcHJpdmF0ZSBfYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWU6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGVwQ291bnRlcisrO1xuICAgIHRoaXMuX3N0YWdlU3RlcE1hcC5zZXQobmFtZSwgdGhpcy5fc3RlcENvdW50ZXIpO1xuICAgIGNvbnN0IGxpbmUgPSBkZXNjcmlwdGlvbiA/IGAke3RoaXMuX3N0ZXBDb3VudGVyfS4gJHtuYW1lfSDigJQgJHtkZXNjcmlwdGlvbn1gIDogYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiAke25hbWV9YDtcbiAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2gobGluZSk7XG4gICAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgICB0aGlzLl9zdGFnZURlc2NyaXB0aW9ucy5zZXQobmFtZSwgZGVzY3JpcHRpb24pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgX2FwcGVuZFN1YmZsb3dEZXNjcmlwdGlvbihpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHN1YmZsb3c6IEZsb3dDaGFydDxhbnksIGFueT4pOiB2b2lkIHtcbiAgICB0aGlzLl9zdGVwQ291bnRlcisrO1xuICAgIHRoaXMuX3N0YWdlU3RlcE1hcC5zZXQoaWQsIHRoaXMuX3N0ZXBDb3VudGVyKTtcbiAgICBpZiAoc3ViZmxvdy5kZXNjcmlwdGlvbikge1xuICAgICAgY29uc3QgbGluZXMgPSBzdWJmbG93LmRlc2NyaXB0aW9uLnNwbGl0KCdcXG4nKTtcbiAgICAgIGNvbnN0IHN0ZXBzSWR4ID0gbGluZXMuZmluZEluZGV4KChsKSA9PiBsLnN0YXJ0c1dpdGgoJ1N0ZXBzOicpKTtcbiAgICAgIGlmIChzdGVwc0lkeCA+PSAwKSB7XG4gICAgICAgIC8vIEJ1aWxkZXItY29tcG9zZWQgZGVzY3JpcHRpb24gKGBGbG93Q2hhcnQ6IFhcXG5TdGVwczpcXG4uLi5gKS5cbiAgICAgICAgLy8gSW5saW5lIE9OTFkgdGhlIHN1bW1hcnkgYWJvdmUgYFN0ZXBzOmAgb24gdGhlIG1vdW50IGxpbmUsIHRoZW5cbiAgICAgICAgLy8gcmUtbGlzdCB0aGUgc3RlcCBsaW5lcyBvbmNlLCBpbmRlbnRlZC4gRW1iZWRkaW5nIHRoZSBGVUxMIGlubmVyXG4gICAgICAgIC8vIGRlc2NyaXB0aW9uIGhlcmUgQU5EIHJlLWxpc3RpbmcgaXRzIHN0ZXBzIGRvdWJsZWQgdGhlIHRleHQgcGVyXG4gICAgICAgIC8vIG5lc3RpbmcgbGV2ZWwg4oCUIGV4cG9uZW50aWFsIGdyb3d0aCwgUmFuZ2VFcnJvciAoXCJJbnZhbGlkIHN0cmluZ1xuICAgICAgICAvLyBsZW5ndGhcIikgYXQgfjIyIG5lc3RpbmcgbGV2ZWxzIG9mIG5lc3RlZCBidWlsZCgpLlxuICAgICAgICBjb25zdCBzdW1tYXJ5ID0gbGluZXMuc2xpY2UoMCwgc3RlcHNJZHgpLmpvaW4oJyAnKS50cmltKCk7XG4gICAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChcbiAgICAgICAgICBzdW1tYXJ5XG4gICAgICAgICAgICA/IGAke3RoaXMuX3N0ZXBDb3VudGVyfS4gW1N1Yi1FeGVjdXRpb246ICR7bmFtZX1dIOKAlCAke3N1bW1hcnl9YFxuICAgICAgICAgICAgOiBgJHt0aGlzLl9zdGVwQ291bnRlcn0uIFtTdWItRXhlY3V0aW9uOiAke25hbWV9XWAsXG4gICAgICAgICk7XG4gICAgICAgIGZvciAobGV0IGkgPSBzdGVwc0lkeCArIDE7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGlmIChsaW5lc1tpXS50cmltKCkpIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChgICAgJHtsaW5lc1tpXX1gKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gRnJlZS1mb3JtIChzaW5nbGUtYmxvY2spIGRlc2NyaXB0aW9uIOKAlCBpbmxpbmUgaXQgd2hvbGUsIHVuY2hhbmdlZC5cbiAgICAgICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAke3RoaXMuX3N0ZXBDb3VudGVyfS4gW1N1Yi1FeGVjdXRpb246ICR7bmFtZX1dIOKAlCAke3N1YmZsb3cuZGVzY3JpcHRpb259YCk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChgJHt0aGlzLl9zdGVwQ291bnRlcn0uIFtTdWItRXhlY3V0aW9uOiAke25hbWV9XWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgCBDb25maWd1cmF0aW9uIOKUgOKUgFxuXG4gIHNldExvZ2dlcihsb2dnZXI6IElMb2dnZXIpOiB0aGlzIHtcbiAgICB0aGlzLl9sb2dnZXIgPSBsb2dnZXI7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvKipcbiAgICogRGVjbGFyZSB0aGUgQVBJIGNvbnRyYWN0IOKAlCBpbnB1dCB2YWxpZGF0aW9uLCBvdXRwdXQgc2hhcGUsIGFuZCBvdXRwdXQgbWFwcGVyLlxuICAgKiBSZXBsYWNlcyBzZXRJbnB1dFNjaGVtYSgpICsgc2V0T3V0cHV0U2NoZW1hKCkgKyBzZXRPdXRwdXRNYXBwZXIoKSBpbiBhIHNpbmdsZSBjYWxsLlxuICAgKlxuICAgKiBJZiBhIGNvbnRyYWN0IHdpdGggaW5wdXQgc2NoZW1hIGlzIGRlY2xhcmVkLCBjaGFydC5ydW4oKSB2YWxpZGF0ZXMgaW5wdXQgYXV0b21hdGljYWxseS5cbiAgICogQ29udHJhY3QgZGF0YSBpcyB1c2VkIGJ5IGNoYXJ0LnRvT3BlbkFQSSgpIGFuZCBjaGFydC50b01DUFRvb2woKS5cbiAgICovXG4gIGNvbnRyYWN0KG9wdHM6IHtcbiAgICBpbnB1dD86IHVua25vd247XG4gICAgb3V0cHV0PzogdW5rbm93bjtcbiAgICBtYXBwZXI/OiAoZmluYWxTY29wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHVua25vd247XG4gIH0pOiB0aGlzIHtcbiAgICBpZiAob3B0cy5pbnB1dCkgdGhpcy5faW5wdXRTY2hlbWEgPSBvcHRzLmlucHV0O1xuICAgIGlmIChvcHRzLm91dHB1dCkgdGhpcy5fb3V0cHV0U2NoZW1hID0gb3B0cy5vdXRwdXQ7XG4gICAgaWYgKG9wdHMubWFwcGVyKSB0aGlzLl9vdXRwdXRNYXBwZXIgPSBvcHRzLm1hcHBlcjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBMaW5lYXIgQ2hhaW5pbmcg4pSA4pSAXG5cbiAgc3RhcnQoXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIGZuOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4gfCBQYXVzYWJsZUhhbmRsZXI8VFNjb3BlPixcbiAgICBpZDogc3RyaW5nLFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApOiB0aGlzIHtcbiAgICBpZiAodGhpcy5fcm9vdCkgZmFpbCgncm9vdCBhbHJlYWR5IGRlZmluZWQ7IGNyZWF0ZSBhIG5ldyBidWlsZGVyJyk7XG5cbiAgICAvLyBEZXRlY3QgUGF1c2FibGVIYW5kbGVyIGJ5IGR1Y2stdHlwaW5nIChoYXMgLmV4ZWN1dGUgcHJvcGVydHkpXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLXJlc3RyaWN0ZWQtc3ludGF4XG4gICAgY29uc3QgaXNQYXVzYWJsZSA9IHR5cGVvZiBmbiA9PT0gJ29iamVjdCcgJiYgZm4gIT09IG51bGwgJiYgJ2V4ZWN1dGUnIGluIGZuO1xuICAgIGNvbnN0IHN0YWdlRm4gPSBpc1BhdXNhYmxlXG4gICAgICA/ICgoZm4gYXMgUGF1c2FibGVIYW5kbGVyPFRTY29wZT4pLmV4ZWN1dGUgYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+KVxuICAgICAgOiAoZm4gYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+KTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lLCBpZCwgZm46IHN0YWdlRm4gfTtcbiAgICBpZiAoaXNQYXVzYWJsZSkge1xuICAgICAgbm9kZS5pc1BhdXNhYmxlID0gdHJ1ZTtcbiAgICAgIG5vZGUucmVzdW1lRm4gPSAoZm4gYXMgUGF1c2FibGVIYW5kbGVyPFRTY29wZT4pLnJlc3VtZTtcbiAgICB9XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIHN0YWdlRm4pO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lLCBpZCwgdHlwZTogJ3N0YWdlJyB9O1xuICAgIGlmIChpc1BhdXNhYmxlKSBzcGVjLmlzUGF1c2FibGUgPSB0cnVlO1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuXG4gICAgdGhpcy5fcm9vdCA9IG5vZGU7XG4gICAgdGhpcy5fcm9vdFNwZWMgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fYWR2YW5jZUN1cnNvclNwZWMoc3BlYyk7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgLy8gTDcuMyDigJQgU2VlZCBub2RlIGZpcmVzIGBvblN0YWdlQWRkZWRgIChubyBlZGdlIOKAlCBubyBwcmVkZWNlc3NvcikuXG4gICAgLy8gYGlzUGF1c2FibGVgIGlzIHJlYWQgZGlyZWN0bHkgZnJvbSB0aGUgc3BlYyBieSBgX2ZpcmVTdGFnZUFkZGVkYC5cbiAgICB0aGlzLl9maXJlU3RhZ2VBZGRlZChzcGVjKTtcblxuICAgIHRoaXMuX2FwcGVuZERlc2NyaXB0aW9uTGluZShuYW1lLCBkZXNjcmlwdGlvbik7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvKipcbiAgICogU3RhcnQgYSBjaGFydCB3aG9zZSBST09UIHN0YWdlIElTIGEgc2VsZWN0b3Ig4oCUIGl0IHJ1bnMgZmlyc3QgKHJlYWRpbmdcbiAgICogYXJncywgc2VlZGluZyBzdGF0ZSwgcmV0dXJuaW5nIHRoZSBjaG9zZW4gYnJhbmNoIGlkcyB2aWEgYHNlbGVjdCgpYCksXG4gICAqIGFuZCBpdHMgYnJhbmNoZXMgYXR0YWNoIGRpcmVjdGx5IHRvIHRoZSByb290LiBNaXJyb3JzIGBzdGFydCgpYCBmb3IgdGhlXG4gICAqIHJvb3Qtbm9kZSBzZXR1cCwgdGhlbiByZXR1cm5zIGEgYFNlbGVjdG9yRm5MaXN0YCBib3VuZCB0byB0aGUgcm9vdCBzb1xuICAgKiBgLmFkZEZ1bmN0aW9uQnJhbmNoKClgIC8gYC5hZGRTdWJGbG93Q2hhcnRCcmFuY2goKWAgLyBgLmVuZCgpYCB3b3JrXG4gICAqIGV4YWN0bHkgYXMgdGhleSBkbyBhZnRlciBgYWRkU2VsZWN0b3JGdW5jdGlvbigpYC5cbiAgICpcbiAgICogVXNlIHdoZW4gdGhlIGZpcnN0IHRoaW5nIGEgY2hhcnQgZG9lcyBpcyBjaG9vc2UgYW1vbmcgYnJhbmNoZXMg4oCUIGUuZy4gYVxuICAgKiBgQ29udGV4dGAgc2VsZWN0b3IgdGhhdCBpbml0cyArIHBpY2tzIHdoaWNoIGNvbnRleHQgc2xvdHMgdG8gZW5naW5lZXIsXG4gICAqIHdpdGggbm8gc2VwYXJhdGUgc2VlZCBzdGFnZSBiZWZvcmUgaXQuXG4gICAqL1xuICBzdGFydFNlbGVjdG9yKFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbjogU3RhZ2VGdW5jdGlvbjxhbnksIFRTY29wZT4sXG4gICAgaWQ6IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgICBvcHRpb25zPzogeyBmYWlsRmFzdD86IGJvb2xlYW4gfSxcbiAgKTogU2VsZWN0b3JGbkxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKHRoaXMuX3Jvb3QpIGZhaWwoJ3Jvb3QgYWxyZWFkeSBkZWZpbmVkOyBjcmVhdGUgYSBuZXcgYnVpbGRlcicpO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWUsIGlkLCBmbjogZm4gYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+IH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgLy8gU2VlIGBhZGRTZWxlY3RvckZ1bmN0aW9uYCDigJQgYGZhaWxGYXN0OiB0cnVlYCBtYWtlcyBhIG11bHRpLWJyYW5jaFxuICAgIC8vIHNlbGVjdGlvbiBmYW4gb3V0IHZpYSBgUHJvbWlzZS5hbGxgIChmaXJzdCBlcnJvciBhYm9ydHMpIGluc3RlYWQgb2YgdGhlXG4gICAgLy8gZGVmYXVsdCBgUHJvbWlzZS5hbGxTZXR0bGVkYCAoYmVzdC1lZmZvcnQpLlxuICAgIGlmIChvcHRpb25zPy5mYWlsRmFzdCkgbm9kZS5mYWlsRmFzdCA9IHRydWU7XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIGZuIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPik7XG5cbiAgICBjb25zdCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7IG5hbWUsIGlkLCB0eXBlOiAnc3RhZ2UnLCBoYXNTZWxlY3RvcjogdHJ1ZSB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuXG4gICAgdGhpcy5fcm9vdCA9IG5vZGU7XG4gICAgdGhpcy5fcm9vdFNwZWMgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fYWR2YW5jZUN1cnNvclNwZWMoc3BlYyk7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgLy8gUm9vdCBzZWxlY3RvciBub2RlIGZpcmVzIG9uU3RhZ2VBZGRlZCB3aXRoIE5PIHByZWRlY2Vzc29yIGVkZ2UgKGl0J3NcbiAgICAvLyB0aGUgcm9vdCkuIEJyYW5jaGVzICsgb25EZWNpZGVyQ29tcGxldGUgY29tZSBmcm9tIHRoZSBTZWxlY3RvckZuTGlzdC5cbiAgICB0aGlzLl9maXJlU3RhZ2VBZGRlZChzcGVjKTtcblxuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChuYW1lLCB0aGlzLl9zdGVwQ291bnRlcik7XG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcblxuICAgIHJldHVybiBuZXcgU2VsZWN0b3JGbkxpc3Q8VE91dCwgVFNjb3BlPihcbiAgICAgIHRoaXMsXG4gICAgICBub2RlLFxuICAgICAgc3BlYyxcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMsXG4gICAgICB0aGlzLl9zdGFnZURlc2NyaXB0aW9ucyxcbiAgICAgIHRoaXMuX3N0ZXBDb3VudGVyLFxuICAgICAgZGVzY3JpcHRpb24sXG4gICAgKTtcbiAgfVxuXG4gIGFkZEZ1bmN0aW9uKG5hbWU6IHN0cmluZywgZm46IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPiwgaWQ6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG4gICAgLy8gQ2FwdHVyZSB0aGUgcGFyZW50IFNQRUMgcmVmZXJlbmNlIChub3QganVzdCBpZCkgQkVGT1JFIHRoZVxuICAgIC8vIGN1cnNvciBhZHZhbmNlcyDigJQgd2UgbmVlZCBpdHMgYGNoaWxkcmVuYCArIGB0eXBlYCB0byBkZWNpZGVcbiAgICAvLyB3aGV0aGVyIHRoZSBgbmV4dGAgZWRnZSBpcyBhIGZvcmsgY29udmVyZ2VuY2UgKE4gZWRnZXMgZnJvbVxuICAgIC8vIGVhY2ggYnJhbmNoIGNoaWxkKSB2cyBhIHBsYWluIGxpbmVhciBjaGFpbiAoMSBlZGdlIGZyb20gcGFyZW50KS5cbiAgICBjb25zdCBwYXJlbnRTcGVjID0gY3VyU3BlYztcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lLCBpZCwgZm4gfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICB0aGlzLl9hZGRUb01hcChpZCwgZm4pO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lLCBpZCwgdHlwZTogJ3N0YWdlJyB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuXG4gICAgY3VyLm5leHQgPSBub2RlO1xuICAgIGN1clNwZWMubmV4dCA9IHNwZWM7XG4gICAgdGhpcy5fY3Vyc29yID0gbm9kZTtcbiAgICB0aGlzLl9hZHZhbmNlQ3Vyc29yU3BlYyhzcGVjKTtcbiAgICB0aGlzLl9rbm93blN0YWdlSWRzLmFkZChpZCk7XG5cbiAgICAvLyBMNy4zIOKAlCBMaW5lYXIgbm9kZTogYW5ub3VuY2UgdGhlIG5vZGUgZmlyc3QsIHRoZW4gdGhlIGVkZ2VcbiAgICAvLyBmcm9tIHRoZSBwcmlvciBjdXJzb3IuIE9yZGVyIG1hdHRlcnM6IGVuZHBvaW50cyBhbm5vdW5jZWRcbiAgICAvLyBiZWZvcmUgYW55IGVkZ2UgcmVmZXJlbmNpbmcgdGhlbSAoU3RydWN0dXJlUmVjb3JkZXIgY29udHJhY3QpLlxuICAgIHRoaXMuX2ZpcmVTdGFnZUFkZGVkKHNwZWMpO1xuICAgIHRoaXMuX2ZpcmVOZXh0RWRnZUZyb21QYXJlbnQocGFyZW50U3BlYywgaWQpO1xuXG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZFN0cmVhbWluZ0Z1bmN0aW9uKFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbjogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgIGlkOiBzdHJpbmcsXG4gICAgc3RyZWFtSWQ/OiBzdHJpbmcsXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICk6IHRoaXMge1xuICAgIGNvbnN0IGN1ciA9IHRoaXMuX25lZWRDdXJzb3IoKTtcbiAgICBjb25zdCBjdXJTcGVjID0gdGhpcy5fbmVlZEN1cnNvclNwZWMoKTtcbiAgICBjb25zdCBwYXJlbnRTcGVjID0gY3VyU3BlYztcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZSxcbiAgICAgIGlkLFxuICAgICAgZm4sXG4gICAgICBpc1N0cmVhbWluZzogdHJ1ZSxcbiAgICAgIHN0cmVhbUlkOiBzdHJlYW1JZCA/PyBuYW1lLFxuICAgIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIGZuKTtcblxuICAgIGNvbnN0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWUsXG4gICAgICBpZCxcbiAgICAgIHR5cGU6ICdzdHJlYW1pbmcnLFxuICAgICAgaXNTdHJlYW1pbmc6IHRydWUsXG4gICAgICBzdHJlYW1JZDogc3RyZWFtSWQgPz8gbmFtZSxcbiAgICB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuXG4gICAgY3VyLm5leHQgPSBub2RlO1xuICAgIGN1clNwZWMubmV4dCA9IHNwZWM7XG4gICAgdGhpcy5fY3Vyc29yID0gbm9kZTtcbiAgICB0aGlzLl9hZHZhbmNlQ3Vyc29yU3BlYyhzcGVjKTtcbiAgICB0aGlzLl9rbm93blN0YWdlSWRzLmFkZChpZCk7XG5cbiAgICAvLyBMNy4zIOKAlCBTdHJlYW1pbmcgc3RhZ2U6IHNhbWUgc2hhcGUgYXMgbGluZWFyIGFkZEZ1bmN0aW9uLlxuICAgIHRoaXMuX2ZpcmVTdGFnZUFkZGVkKHNwZWMpO1xuICAgIHRoaXMuX2ZpcmVOZXh0RWRnZUZyb21QYXJlbnQocGFyZW50U3BlYywgaWQpO1xuXG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8qKlxuICAgKiBBZGQgYSBwYXVzYWJsZSBzdGFnZSDigJQgY2FuIHBhdXNlIGV4ZWN1dGlvbiBhbmQgcmVzdW1lIGxhdGVyIHdpdGggaW5wdXQuXG4gICAqXG4gICAqIFRoZSBoYW5kbGVyIGhhcyB0d28gcGhhc2VzOlxuICAgKiAtIGBleGVjdXRlYDogcnVucyBmaXJzdCB0aW1lLiBSZXR1cm4gYW55IG5vbi12b2lkIHZhbHVlIHRvIHBhdXNlIChpdCBiZWNvbWVzXG4gICAqICAgdGhlIGNoZWNrcG9pbnQncyBgcGF1c2VEYXRhYCk7IHJldHVybiB2b2lkL3VuZGVmaW5lZCB0byBjb250aW51ZSBub3JtYWxseS5cbiAgICogLSBgcmVzdW1lYDogcnVucyB3aGVuIHRoZSBmbG93Y2hhcnQgaXMgcmVzdW1lZCB3aXRoIGlucHV0LlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIC5hZGRQYXVzYWJsZUZ1bmN0aW9uKCdBcHByb3ZlT3JkZXInLCB7XG4gICAqICAgZXhlY3V0ZTogYXN5bmMgKHNjb3BlKSA9PiB7XG4gICAqICAgICBzY29wZS5vcmRlcklkID0gJzEyMyc7XG4gICAqICAgICByZXR1cm4geyBxdWVzdGlvbjogJ0FwcHJvdmU/JyB9O1xuICAgKiAgIH0sXG4gICAqICAgcmVzdW1lOiBhc3luYyAoc2NvcGUsIGlucHV0KSA9PiB7XG4gICAqICAgICBzY29wZS5hcHByb3ZlZCA9IGlucHV0LmFwcHJvdmVkO1xuICAgKiAgIH0sXG4gICAqIH0sICdhcHByb3ZlLW9yZGVyJywgJ01hbmFnZXIgYXBwcm92YWwgZ2F0ZScpXG4gICAqIGBgYFxuICAgKi9cbiAgYWRkUGF1c2FibGVGdW5jdGlvbihuYW1lOiBzdHJpbmcsIGhhbmRsZXI6IFBhdXNhYmxlSGFuZGxlcjxUU2NvcGU+LCBpZDogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IHRoaXMge1xuICAgIGNvbnN0IGN1ciA9IHRoaXMuX25lZWRDdXJzb3IoKTtcbiAgICBjb25zdCBjdXJTcGVjID0gdGhpcy5fbmVlZEN1cnNvclNwZWMoKTtcbiAgICBjb25zdCBwYXJlbnRTcGVjID0gY3VyU3BlYztcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZSxcbiAgICAgIGlkLFxuICAgICAgZm46IGhhbmRsZXIuZXhlY3V0ZSBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgICBpc1BhdXNhYmxlOiB0cnVlLFxuICAgICAgcmVzdW1lRm46IGhhbmRsZXIucmVzdW1lLFxuICAgIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIGhhbmRsZXIuZXhlY3V0ZSBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZSxcbiAgICAgIGlkLFxuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIGlzUGF1c2FibGU6IHRydWUsXG4gICAgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIHNwZWMuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcblxuICAgIGN1ci5uZXh0ID0gbm9kZTtcbiAgICBjdXJTcGVjLm5leHQgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fYWR2YW5jZUN1cnNvclNwZWMoc3BlYyk7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgLy8gTDcuMyDigJQgUGF1c2FibGUgc3RhZ2U6IGBfZmlyZVN0YWdlQWRkZWRgIHJlYWRzIGBpc1BhdXNhYmxlYFxuICAgIC8vIGRpcmVjdGx5IGZyb20gYHNwZWMuaXNQYXVzYWJsZWAgKHNldCBhYm92ZSksIHNvIHZpc3VhbGlzZXJzXG4gICAgLy8gc2VlIGl0IG9uIHRoZSBldmVudCBwYXlsb2FkIHdpdGhvdXQgYSBzZXBhcmF0ZSB0aHJlYWRpbmcgYXJnLlxuICAgIHRoaXMuX2ZpcmVTdGFnZUFkZGVkKHNwZWMpO1xuICAgIHRoaXMuX2ZpcmVOZXh0RWRnZUZyb21QYXJlbnQocGFyZW50U3BlYywgaWQpO1xuXG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBEZXRhY2ggKGJ1aWxkZXItbmF0aXZlIGNvbXBvc2l0aW9uKSDilIDilIBcbiAgLy9cbiAgLy8gU3VnYXIgb3ZlciBgYWRkRnVuY3Rpb25gIHRoYXQgZ2VuZXJhdGVzIGEgc3RhZ2Ugd2hpY2ggY2FsbHNcbiAgLy8gYHNjb3BlLiRkZXRhY2hBbmRGb3JnZXQoLi4uKWAgb3IgYHNjb3BlLiRkZXRhY2hBbmRKb2luTGF0ZXIoLi4uKWBcbiAgLy8gYXQgcnVudGltZS4gWkVSTyBlbmdpbmUgY2hhbmdlcyDigJQgcHVyZSBjb21wb3NpdGlvbiBvdmVyIHRoZVxuICAvLyBleGlzdGluZyBzY29wZS1tZXRob2QgcHJpbWl0aXZlcy5cbiAgLy9cbiAgLy8gRm9yIGBhZGREZXRhY2hBbmRKb2luTGF0ZXJgLCB0aGUgcmV0dXJuZWQgaGFuZGxlIGlzIHN0b3JlZCBpblxuICAvLyBzaGFyZWQgc3RhdGUgdmlhIGAkc2V0VmFsdWVgICh3aGljaCBieXBhc3NlcyB0aGUgdHlwZWQtcHJveHlcbiAgLy8gdW53cmFwIHRoYXQgd291bGQgb3RoZXJ3aXNlIHN0cmlwIHRoZSBoYW5kbGUncyBjbGFzcyBtZXRob2RzKS5cbiAgLy8gRG93bnN0cmVhbSBzdGFnZXMgcmVhZCBpdCB2aWEgYHNjb3BlW29wdGlvbnMuaGFuZGxlS2V5XWAgb3JcbiAgLy8gYHNjb3BlLiRnZXRWYWx1ZShvcHRpb25zLmhhbmRsZUtleSlgIOKAlCBib3RoIHByZXNlcnZlIG1ldGhvZHNcbiAgLy8gYmVjYXVzZSB0aGUgdmFsdWUgd2FzIHN0b3JlZCByYXcuXG5cbiAgLyoqXG4gICAqIEFkZCBhIHN0YWdlIHRoYXQgZmlyZXMgYSBjaGlsZCBmbG93Y2hhcnQgb24gdGhlIGdpdmVuIGRyaXZlciBhbmRcbiAgICogRElTQ0FSRFMgdGhlIGhhbmRsZS4gUHVyZSBmaXJlLWFuZC1mb3JnZXQg4oCUIHVzZWZ1bCBmb3IgdGVsZW1ldHJ5XG4gICAqIGV4cG9ydHMsIGF1ZGl0IGxvZyBzaGlwcGluZywgY2FjaGUgd2FybS11cC5cbiAgICpcbiAgICogQHBhcmFtIGlkIFN0YWJsZSBpZCBmb3IgdGhpcyBzdGFnZSAoYWxzbyB0aGUgc3RhZ2VNYXAga2V5KS5cbiAgICogQHBhcmFtIGNoaWxkIFRoZSBjaGlsZCBmbG93Y2hhcnQgdG8gZGV0YWNoLlxuICAgKiBAcGFyYW0gb3B0aW9ucy5kcml2ZXIgVGhlIGRyaXZlciB0byBzY2hlZHVsZSBvbiAoZS5nLiBgbWljcm90YXNrQmF0Y2hEcml2ZXJgKS5cbiAgICogQHBhcmFtIG9wdGlvbnMuaW5wdXRNYXBwZXIgTWFwcyB0aGUgcGFyZW50J3Mgc2NvcGUgdG8gdGhlIGNoaWxkJ3MgaW5wdXQuXG4gICAqICAgRGVmYXVsdHMgdG8gcGFzc2luZyBgdW5kZWZpbmVkYC5cbiAgICogQHBhcmFtIG9wdGlvbnMubW91bnROYW1lIERpc3BsYXkgbmFtZTsgZGVmYXVsdHMgdG8gYGlkYC5cbiAgICogQHBhcmFtIG9wdGlvbnMuZGVzY3JpcHRpb24gU3RhZ2UgZGVzY3JpcHRpb24gZm9yIG5hcnJhdGl2ZSArIHRvb2xzLlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0c1xuICAgKiBpbXBvcnQgeyBtaWNyb3Rhc2tCYXRjaERyaXZlciB9IGZyb20gJ2Zvb3RwcmludGpzL2RldGFjaCc7XG4gICAqXG4gICAqIGZsb3dDaGFydCgncHJvY2VzcycsIHByb2Nlc3NGbiwgJ3Byb2Nlc3MnKVxuICAgKiAgIC5hZGREZXRhY2hBbmRGb3JnZXQoJ3RlbGVtZXRyeScsIHRlbGVtZXRyeUNoYXJ0LCB7XG4gICAqICAgICBkcml2ZXI6IG1pY3JvdGFza0JhdGNoRHJpdmVyLFxuICAgKiAgICAgaW5wdXRNYXBwZXI6IChzY29wZSkgPT4gKHsgZXZlbnQ6ICdwcm9jZXNzZWQnLCBvcmRlcklkOiBzY29wZS5vcmRlcklkIH0pLFxuICAgKiAgIH0pXG4gICAqICAgLmFkZEZ1bmN0aW9uKCduZXh0JywgbmV4dEZuLCAnbmV4dCcpXG4gICAqICAgLmJ1aWxkKCk7XG4gICAqIGBgYFxuICAgKi9cbiAgYWRkRGV0YWNoQW5kRm9yZ2V0KFxuICAgIGlkOiBzdHJpbmcsXG4gICAgY2hpbGQ6IGltcG9ydCgnLi90eXBlcy5qcycpLkZsb3dDaGFydDxhbnksIGFueT4sXG4gICAgb3B0aW9uczoge1xuICAgICAgZHJpdmVyOiBpbXBvcnQoJy4uL2RldGFjaC90eXBlcy5qcycpLkRldGFjaERyaXZlcjtcbiAgICAgIGlucHV0TWFwcGVyPzogKHNjb3BlOiBUU2NvcGUpID0+IHVua25vd247XG4gICAgICBtb3VudE5hbWU/OiBzdHJpbmc7XG4gICAgICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgICB9LFxuICApOiB0aGlzIHtcbiAgICBjb25zdCBuYW1lID0gb3B0aW9ucy5tb3VudE5hbWUgPz8gaWQ7XG4gICAgcmV0dXJuIHRoaXMuYWRkRnVuY3Rpb24oXG4gICAgICBuYW1lLFxuICAgICAgKChzY29wZTogYW55KSA9PiB7XG4gICAgICAgIGNvbnN0IGlucHV0ID0gb3B0aW9ucy5pbnB1dE1hcHBlciA/IG9wdGlvbnMuaW5wdXRNYXBwZXIoc2NvcGUgYXMgVFNjb3BlKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgc2NvcGUuJGRldGFjaEFuZEZvcmdldChvcHRpb25zLmRyaXZlciwgY2hpbGQsIGlucHV0KTtcbiAgICAgIH0pIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPixcbiAgICAgIGlkLFxuICAgICAgb3B0aW9ucy5kZXNjcmlwdGlvbixcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIEFkZCBhIHN0YWdlIHRoYXQgZmlyZXMgYSBjaGlsZCBmbG93Y2hhcnQgb24gdGhlIGdpdmVuIGRyaXZlciBhbmRcbiAgICogZGVsaXZlcnMgdGhlIHJlc3VsdGluZyBgRGV0YWNoSGFuZGxlYCB0byBhIGNvbnN1bWVyLXN1cHBsaWVkXG4gICAqIGBvbkhhbmRsZWAgY2FsbGJhY2suIFRoZSBoYW5kbGUgQ0FOTk9UIGJlIHN0b3JlZCBpbiBzaGFyZWQgc3RhdGVcbiAgICog4oCUIGBTdGFnZUNvbnRleHQuc2V0VmFsdWVgIGNhbGxzIGBzdHJ1Y3R1cmVkQ2xvbmVgIHdoaWNoIGRyb3BzXG4gICAqIGNsYXNzIHByb3RvdHlwZXMgKGFuZCB0aGVyZWZvcmUgdGhlIGhhbmRsZSdzIGAud2FpdCgpYCBtZXRob2QpLlxuICAgKlxuICAgKiBUaGUgY2FsbGJhY2sgcGF0dGVybiBpcyB0aGUgZXhwbGljaXQgYWx0ZXJuYXRpdmU6IGtlZXAgaGFuZGxlcyBpblxuICAgKiBhIGNsb3N1cmUtbG9jYWwgYXJyYXkgKG9yIHdoYXRldmVyIHNoYXBlIHN1aXRzKSBhbmQgaGF2ZSBhXG4gICAqIGRvd25zdHJlYW0gc3RhZ2UgYGF3YWl0IFByb21pc2UuYWxsKC4uLilgIG92ZXIgdGhlbS5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHNcbiAgICogaW1wb3J0IHsgbWljcm90YXNrQmF0Y2hEcml2ZXIgfSBmcm9tICdmb290cHJpbnRqcy9kZXRhY2gnO1xuICAgKiBpbXBvcnQgdHlwZSB7IERldGFjaEhhbmRsZSB9IGZyb20gJ2Zvb3RwcmludGpzL2RldGFjaCc7XG4gICAqXG4gICAqIGNvbnN0IGhhbmRsZXM6IERldGFjaEhhbmRsZVtdID0gW107XG4gICAqXG4gICAqIGNvbnN0IGNoYXJ0ID0gZmxvd0NoYXJ0KCdzZWVkJywgc2VlZEZuLCAnc2VlZCcpXG4gICAqICAgLmFkZERldGFjaEFuZEpvaW5MYXRlcignZXZhbC1hJywgZXZhbENoYXJ0LCB7XG4gICAqICAgICBkcml2ZXI6IG1pY3JvdGFza0JhdGNoRHJpdmVyLFxuICAgKiAgICAgaW5wdXRNYXBwZXI6IChzY29wZSkgPT4gc2NvcGUuY29uZmlnQSxcbiAgICogICAgIG9uSGFuZGxlOiAoaCkgPT4gaGFuZGxlcy5wdXNoKGgpLFxuICAgKiAgIH0pXG4gICAqICAgLmFkZERldGFjaEFuZEpvaW5MYXRlcignZXZhbC1iJywgZXZhbENoYXJ0LCB7XG4gICAqICAgICBkcml2ZXI6IG1pY3JvdGFza0JhdGNoRHJpdmVyLFxuICAgKiAgICAgaW5wdXRNYXBwZXI6IChzY29wZSkgPT4gc2NvcGUuY29uZmlnQixcbiAgICogICAgIG9uSGFuZGxlOiAoaCkgPT4gaGFuZGxlcy5wdXNoKGgpLFxuICAgKiAgIH0pXG4gICAqICAgLmFkZEZ1bmN0aW9uKCdqb2luJywgYXN5bmMgKHNjb3BlKSA9PiB7XG4gICAqICAgICBjb25zdCBzZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5hbGwoaGFuZGxlcy5tYXAoKGgpID0+IGgud2FpdCgpKSk7XG4gICAqICAgICBzY29wZS5yZXN1bHRzID0gc2V0dGxlZDtcbiAgICogICB9LCAnam9pbicpXG4gICAqICAgLmJ1aWxkKCk7XG4gICAqIGBgYFxuICAgKlxuICAgKiBOb3RlOiBwdXR0aW5nIGBoYW5kbGVzYCBpbiBhIG1vZHVsZS1sZXZlbCBjbG9zdXJlIGlzIGZpbmUgZm9yXG4gICAqIHNpbmdsZS1ydW4gc2NyaXB0cy4gRm9yIHNlcnZlciBjb2RlIHRoYXQgcnVucyB0aGUgc2FtZSBjaGFydFxuICAgKiBjb25jdXJyZW50bHkgYWNyb3NzIHJlcXVlc3RzLCBhbGxvY2F0ZSBhIG5ldyBjbG9zdXJlIHBlciBydW5cbiAgICogKGUuZy4sIHdyYXAgY2hhcnQgY29uc3RydWN0aW9uIGluIGEgZmFjdG9yeSBmdW5jdGlvbikgc28gaGFuZGxlc1xuICAgKiBmcm9tIGRpZmZlcmVudCBydW5zIGRvbid0IGJsZWVkIGludG8gZWFjaCBvdGhlci5cbiAgICovXG4gIGFkZERldGFjaEFuZEpvaW5MYXRlcihcbiAgICBpZDogc3RyaW5nLFxuICAgIGNoaWxkOiBpbXBvcnQoJy4vdHlwZXMuanMnKS5GbG93Q2hhcnQ8YW55LCBhbnk+LFxuICAgIG9wdGlvbnM6IHtcbiAgICAgIGRyaXZlcjogaW1wb3J0KCcuLi9kZXRhY2gvdHlwZXMuanMnKS5EZXRhY2hEcml2ZXI7XG4gICAgICBvbkhhbmRsZTogKGhhbmRsZTogaW1wb3J0KCcuLi9kZXRhY2gvdHlwZXMuanMnKS5EZXRhY2hIYW5kbGUpID0+IHZvaWQ7XG4gICAgICBpbnB1dE1hcHBlcj86IChzY29wZTogVFNjb3BlKSA9PiB1bmtub3duO1xuICAgICAgbW91bnROYW1lPzogc3RyaW5nO1xuICAgICAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gICAgfSxcbiAgKTogdGhpcyB7XG4gICAgY29uc3QgbmFtZSA9IG9wdGlvbnMubW91bnROYW1lID8/IGlkO1xuICAgIHJldHVybiB0aGlzLmFkZEZ1bmN0aW9uKFxuICAgICAgbmFtZSxcbiAgICAgICgoc2NvcGU6IGFueSkgPT4ge1xuICAgICAgICBjb25zdCBpbnB1dCA9IG9wdGlvbnMuaW5wdXRNYXBwZXIgPyBvcHRpb25zLmlucHV0TWFwcGVyKHNjb3BlIGFzIFRTY29wZSkgOiB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IGhhbmRsZSA9IHNjb3BlLiRkZXRhY2hBbmRKb2luTGF0ZXIob3B0aW9ucy5kcml2ZXIsIGNoaWxkLCBpbnB1dCk7XG4gICAgICAgIG9wdGlvbnMub25IYW5kbGUoaGFuZGxlKTtcbiAgICAgIH0pIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPixcbiAgICAgIGlkLFxuICAgICAgb3B0aW9ucy5kZXNjcmlwdGlvbixcbiAgICApO1xuICB9XG5cbiAgLy8g4pSA4pSAIEJyYW5jaGluZyDilIDilIBcblxuICBhZGREZWNpZGVyRnVuY3Rpb24oXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIGZuOiBTdGFnZUZ1bmN0aW9uPGFueSwgVFNjb3BlPixcbiAgICBpZDogc3RyaW5nLFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApOiBEZWNpZGVyTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG4gICAgY29uc3QgcGFyZW50U3BlYyA9IGN1clNwZWM7XG5cbiAgICBpZiAoY3VyLmRlY2lkZXJGbikgZmFpbChgZGVjaWRlciBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWUsIGlkLCBmbiB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuX2FkZFRvTWFwKGlkLCBmbik7XG5cbiAgICBjb25zdCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7IG5hbWUsIGlkLCB0eXBlOiAnc3RhZ2UnLCBoYXNEZWNpZGVyOiB0cnVlIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBzcGVjLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG5cbiAgICBjdXIubmV4dCA9IG5vZGU7XG4gICAgY3VyU3BlYy5uZXh0ID0gc3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2FkdmFuY2VDdXJzb3JTcGVjKHNwZWMpO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIC8vIEw3LjMg4oCUIERlY2lkZXIgbm9kZSBpcyByZWFjaGVkIHZpYSBhIGBuZXh0YCBlZGdlIGZyb20gdGhlIHByaW9yXG4gICAgLy8gY3Vyc29yLiBCcmFuY2hlcyB0aGVtc2VsdmVzIGZpcmUgdmlhIGBhZGRGdW5jdGlvbkJyYW5jaGAgZXRjLlxuICAgIC8vIGBvbkRlY2lkZXJDb21wbGV0ZWAgZmlyZXMgZnJvbSBzdWItYnVpbGRlciBgLmVuZCgpYC5cbiAgICB0aGlzLl9maXJlU3RhZ2VBZGRlZChzcGVjKTtcbiAgICB0aGlzLl9maXJlTmV4dEVkZ2VGcm9tUGFyZW50KHBhcmVudFNwZWMsIGlkKTtcblxuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChuYW1lLCB0aGlzLl9zdGVwQ291bnRlcik7XG5cbiAgICByZXR1cm4gbmV3IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4oXG4gICAgICB0aGlzLFxuICAgICAgbm9kZSxcbiAgICAgIHNwZWMsXG4gICAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLFxuICAgICAgdGhpcy5fc3RhZ2VEZXNjcmlwdGlvbnMsXG4gICAgICB0aGlzLl9zdGVwQ291bnRlcixcbiAgICAgIGRlc2NyaXB0aW9uLFxuICAgICk7XG4gIH1cblxuICBhZGRTZWxlY3RvckZ1bmN0aW9uKFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbjogU3RhZ2VGdW5jdGlvbjxhbnksIFRTY29wZT4sXG4gICAgaWQ6IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgICBvcHRpb25zPzogeyBmYWlsRmFzdD86IGJvb2xlYW4gfSxcbiAgKTogU2VsZWN0b3JGbkxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuICAgIGNvbnN0IHBhcmVudFNwZWMgPSBjdXJTcGVjO1xuXG4gICAgaWYgKGN1ci5zZWxlY3RvckZuKSBmYWlsKGBzZWxlY3RvciBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuICAgIGlmIChjdXIuZGVjaWRlckZuKSBmYWlsKGBkZWNpZGVyIGFuZCBzZWxlY3RvciBhcmUgbXV0dWFsbHkgZXhjbHVzaXZlIGF0ICcke2N1ci5uYW1lfSdgKTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lLCBpZCwgZm4gfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICAvLyBgZmFpbEZhc3RgOiB3aGVuIHRoZSBzZWxlY3RvciBwaWNrcyDiiaUyIGJyYW5jaGVzIHRoZXkgZmFuIG91dCBpbiBwYXJhbGxlbFxuICAgIC8vIHZpYSBDaGlsZHJlbkV4ZWN1dG9yLiBEZWZhdWx0ID0gYFByb21pc2UuYWxsU2V0dGxlZGAgKGJlc3QtZWZmb3J0OiBldmVyeVxuICAgIC8vIGJyYW5jaCBydW5zIHRvIGNvbXBsZXRpb24gZXZlbiBpZiBzb21lIGZhaWwpLiBgZmFpbEZhc3Q6IHRydWVgID0gYFByb21pc2UuYWxsYFxuICAgIC8vICh0aGUgZmlyc3QgYnJhbmNoIGVycm9yIHJlamVjdHMgKyBhYm9ydHMpIOKAlCB1c2Ugd2hlbiBBTEwgc2VsZWN0ZWQgYnJhbmNoZXNcbiAgICAvLyBhcmUgUkVRVUlSRUQgKGUuZy4gYXNzZW1ibGluZyBhIHJlcXVlc3QgZnJvbSBpbmRlcGVuZGVudC1idXQtcmVxdWlyZWQgcGFydHMpLFxuICAgIC8vIG5vdCBiZXN0LWVmZm9ydCBmYW4tb3V0LiBTYW1lIGZsYWcgYGFkZExpc3RPZkZ1bmN0aW9uYCBleHBvc2VzLlxuICAgIGlmIChvcHRpb25zPy5mYWlsRmFzdCkgbm9kZS5mYWlsRmFzdCA9IHRydWU7XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIGZuKTtcblxuICAgIGNvbnN0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHsgbmFtZSwgaWQsIHR5cGU6ICdzdGFnZScsIGhhc1NlbGVjdG9yOiB0cnVlIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBzcGVjLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG5cbiAgICBjdXIubmV4dCA9IG5vZGU7XG4gICAgY3VyU3BlYy5uZXh0ID0gc3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2FkdmFuY2VDdXJzb3JTcGVjKHNwZWMpO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIC8vIEw3LjMg4oCUIFNlbGVjdG9yIG5vZGU6IHNhbWUgYXMgZGVjaWRlci4gQnJhbmNoZXMgKyBjb21wbGV0ZSBldmVudFxuICAgIC8vIGNvbWUgZnJvbSB0aGUgU2VsZWN0b3JGbkxpc3Qgc3ViLWJ1aWxkZXIuXG4gICAgdGhpcy5fZmlyZVN0YWdlQWRkZWQoc3BlYyk7XG4gICAgdGhpcy5fZmlyZU5leHRFZGdlRnJvbVBhcmVudChwYXJlbnRTcGVjLCBpZCk7XG5cbiAgICB0aGlzLl9zdGVwQ291bnRlcisrO1xuICAgIHRoaXMuX3N0YWdlU3RlcE1hcC5zZXQobmFtZSwgdGhpcy5fc3RlcENvdW50ZXIpO1xuXG4gICAgcmV0dXJuIG5ldyBTZWxlY3RvckZuTGlzdDxUT3V0LCBUU2NvcGU+KFxuICAgICAgdGhpcyxcbiAgICAgIG5vZGUsXG4gICAgICBzcGVjLFxuICAgICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cyxcbiAgICAgIHRoaXMuX3N0YWdlRGVzY3JpcHRpb25zLFxuICAgICAgdGhpcy5fc3RlcENvdW50ZXIsXG4gICAgICBkZXNjcmlwdGlvbixcbiAgICApO1xuICB9XG5cbiAgLy8g4pSA4pSAIFBhcmFsbGVsIChGb3JrKSDilIDilIBcblxuICBhZGRMaXN0T2ZGdW5jdGlvbihjaGlsZHJlbjogU2ltcGxpZmllZFBhcmFsbGVsU3BlYzxUT3V0LCBUU2NvcGU+W10sIG9wdGlvbnM/OiB7IGZhaWxGYXN0PzogYm9vbGVhbiB9KTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuICAgIGNvbnN0IGZvcmtJZCA9IGN1ci5pZDtcblxuICAgIGN1clNwZWMudHlwZSA9ICdmb3JrJztcbiAgICBpZiAob3B0aW9ucz8uZmFpbEZhc3QpIGN1ci5mYWlsRmFzdCA9IHRydWU7XG5cbiAgICBmb3IgKGNvbnN0IHsgaWQsIG5hbWUsIGZuIH0gb2YgY2hpbGRyZW4pIHtcbiAgICAgIGlmICghaWQpIGZhaWwoYGNoaWxkIGlkIHJlcXVpcmVkIHVuZGVyICcke2N1ci5uYW1lfSdgKTtcbiAgICAgIGlmIChjdXIuY2hpbGRyZW4/LnNvbWUoKGMpID0+IGMuaWQgPT09IGlkKSkge1xuICAgICAgICBmYWlsKGBkdXBsaWNhdGUgY2hpbGQgaWQgJyR7aWR9JyB1bmRlciAnJHtjdXIubmFtZX0nYCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCB9O1xuICAgICAgaWYgKGZuKSB7XG4gICAgICAgIG5vZGUuZm4gPSBmbjtcbiAgICAgICAgdGhpcy5fYWRkVG9NYXAoaWQsIGZuKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgICBuYW1lOiBuYW1lID8/IGlkLFxuICAgICAgICBpZCxcbiAgICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgICAgaXNQYXJhbGxlbENoaWxkOiB0cnVlLFxuICAgICAgICBwYXJhbGxlbEdyb3VwSWQ6IGZvcmtJZCxcbiAgICAgIH07XG5cbiAgICAgIGN1ci5jaGlsZHJlbiA9IGN1ci5jaGlsZHJlbiB8fCBbXTtcbiAgICAgIGN1ci5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgICAgY3VyU3BlYy5jaGlsZHJlbiA9IGN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgICBjdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG4gICAgICAvLyBMNy4zIOKAlCBmaXJlIHN0cnVjdHVyZSBldmVudHMgZm9yIHRoZSBjaGlsZCArIHRoZSBmb3JrIGVkZ2UuXG4gICAgICB0aGlzLl9maXJlU3RhZ2VBZGRlZChzcGVjKTtcbiAgICAgIHRoaXMuX2ZpcmVFZGdlQWRkZWQoY3VyU3BlYy5pZCwgc3BlYy5pZCwgJ2ZvcmstYnJhbmNoJyk7XG4gICAgfVxuXG4gICAgY29uc3QgY2hpbGROYW1lcyA9IGNoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lIHx8IGMuaWQpLmpvaW4oJywgJyk7XG4gICAgdGhpcy5fc3RlcENvdW50ZXIrKztcbiAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiBSdW5zIGluIHBhcmFsbGVsOiAke2NoaWxkTmFtZXN9YCk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBTdWJmbG93IE1vdW50aW5nIOKUgOKUgFxuXG4gIGFkZFN1YkZsb3dDaGFydChpZDogc3RyaW5nLCBzdWJmbG93OiBGbG93Q2hhcnQ8YW55LCBhbnk+LCBtb3VudE5hbWU/OiBzdHJpbmcsIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1ci5jaGlsZHJlbj8uc29tZSgoYykgPT4gYy5pZCA9PT0gaWQpKSB7XG4gICAgICBmYWlsKGBkdXBsaWNhdGUgY2hpbGQgaWQgJyR7aWR9JyB1bmRlciAnJHtjdXIubmFtZX0nYCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgZm9ya0lkID0gY3VyLmlkO1xuICAgIGNvbnN0IHByZWZpeGVkUm9vdCA9IHRoaXMuX3ByZWZpeE5vZGVUcmVlKHN1YmZsb3cucm9vdCwgaWQpO1xuXG4gICAgaWYgKCF0aGlzLl9zdWJmbG93RGVmcy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLl9zdWJmbG93RGVmcy5zZXQoaWQsIHsgcm9vdDogcHJlZml4ZWRSb290IH0pO1xuICAgIH1cblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgfTtcbiAgICBpZiAob3B0aW9ucykgbm9kZS5zdWJmbG93TW91bnRPcHRpb25zID0gb3B0aW9ucztcblxuICAgIGNvbnN0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIGlzUGFyYWxsZWxDaGlsZDogdHJ1ZSxcbiAgICAgIHBhcmFsbGVsR3JvdXBJZDogZm9ya0lkLFxuICAgICAgc3ViZmxvd1N0cnVjdHVyZTogc3ViZmxvdy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgfTtcblxuICAgIGN1clNwZWMudHlwZSA9ICdmb3JrJztcbiAgICBjdXIuY2hpbGRyZW4gPSBjdXIuY2hpbGRyZW4gfHwgW107XG4gICAgY3VyLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgY3VyU3BlYy5jaGlsZHJlbiA9IGN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcbiAgICAvLyBMNy4zIOKAlCBTdWJmbG93IG1vdW50OiBzdGFnZSBldmVudCArIGZvcmsgZWRnZSArIG1vdW50IGxpZmVjeWNsZVxuICAgIC8vIGV2ZW50LiBNb3VudC1vbmx5IHNlbWFudGljczogcGFyZW50IHJlY29yZGVycyBkbyBOT1QgcmVwbGF5IHRoZVxuICAgIC8vIHN1YmZsb3cncyBvd24gaW50ZXJuYWwgc3RydWN0dXJlIGV2ZW50cy5cbiAgICB0aGlzLl9maXJlU3RhZ2VBZGRlZChzcGVjKTtcbiAgICB0aGlzLl9maXJlRWRnZUFkZGVkKGN1clNwZWMuaWQsIGlkLCAnZm9yay1icmFuY2gnKTtcbiAgICB0aGlzLl9maXJlU3ViZmxvd01vdW50ZWQoaWQsIHN1YmZsb3dOYW1lLCBpZCwgZmFsc2UsIHN1YmZsb3cuYnVpbGRUaW1lU3RydWN0dXJlKTtcblxuICAgIHRoaXMuX21lcmdlU3RhZ2VNYXAoc3ViZmxvdy5zdGFnZU1hcCwgaWQpO1xuICAgIHRoaXMuX21lcmdlU3ViZmxvd3Moc3ViZmxvdy5zdWJmbG93cywgaWQpO1xuICAgIHRoaXMuX2FwcGVuZFN1YmZsb3dEZXNjcmlwdGlvbihpZCwgc3ViZmxvd05hbWUsIHN1YmZsb3cpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRMYXp5U3ViRmxvd0NoYXJ0KFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcmVzb2x2ZXI6ICgpID0+IEZsb3dDaGFydDxUT3V0LCBUU2NvcGU+LFxuICAgIG1vdW50TmFtZT86IHN0cmluZyxcbiAgICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1ci5jaGlsZHJlbj8uc29tZSgoYykgPT4gYy5pZCA9PT0gaWQpKSB7XG4gICAgICBmYWlsKGBkdXBsaWNhdGUgY2hpbGQgaWQgJyR7aWR9JyB1bmRlciAnJHtjdXIubmFtZX0nYCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgZm9ya0lkID0gY3VyLmlkO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dSZXNvbHZlcjogcmVzb2x2ZXIgYXMgYW55LFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICAvLyBMYXp5IG1vdW50IHN0dWIuIFRoZSBsYXp5IHN1YmZsb3cncyBpbnRlcm5hbHMgd2lsbCBiZSBzaGFwZWQgYXRcbiAgICAvLyByZXNvbHV0aW9uIHRpbWUuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgaXNQYXJhbGxlbENoaWxkOiB0cnVlLFxuICAgICAgcGFyYWxsZWxHcm91cElkOiBmb3JrSWQsXG4gICAgICBpc0xhenk6IHRydWUsXG4gICAgfTtcblxuICAgIGN1clNwZWMudHlwZSA9ICdmb3JrJztcbiAgICBjdXIuY2hpbGRyZW4gPSBjdXIuY2hpbGRyZW4gfHwgW107XG4gICAgY3VyLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgY3VyU3BlYy5jaGlsZHJlbiA9IGN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuICAgIC8vIEw3LjMg4oCUIExhenkgc3ViZmxvdyBwYXJhbGxlbCBtb3VudC5cbiAgICB0aGlzLl9maXJlU3RhZ2VBZGRlZChzcGVjKTtcbiAgICB0aGlzLl9maXJlRWRnZUFkZGVkKGN1clNwZWMuaWQsIGlkLCAnZm9yay1icmFuY2gnKTtcbiAgICB0aGlzLl9maXJlU3ViZmxvd01vdW50ZWQoaWQsIHN1YmZsb3dOYW1lLCBpZCwgdHJ1ZSk7XG5cbiAgICB0aGlzLl9zdGVwQ291bnRlcisrO1xuICAgIHRoaXMuX3N0YWdlU3RlcE1hcC5zZXQoaWQsIHRoaXMuX3N0ZXBDb3VudGVyKTtcbiAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiBbTGF6eSBTdWItRXhlY3V0aW9uOiAke3N1YmZsb3dOYW1lfV1gKTtcblxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkTGF6eVN1YkZsb3dDaGFydE5leHQoXG4gICAgaWQ6IHN0cmluZyxcbiAgICByZXNvbHZlcjogKCkgPT4gRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBpZiAoY3VyLm5leHQpIHtcbiAgICAgIGZhaWwoYGNhbm5vdCBhZGQgc3ViZmxvdyBhcyBuZXh0IHdoZW4gbmV4dCBpcyBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gbW91bnROYW1lIHx8IGlkO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dSZXNvbHZlcjogcmVzb2x2ZXIgYXMgYW55LFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICAvLyBMYXp5IG1vdW50IHN0dWIuIFRoZSBsYXp5IHN1YmZsb3cncyBpbnRlcm5hbHMgd2lsbCBiZSBzaGFwZWQgYXRcbiAgICAvLyByZXNvbHV0aW9uIHRpbWUuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgaXNMYXp5OiB0cnVlLFxuICAgIH07XG5cbiAgICBjb25zdCBwYXJlbnRTcGVjID0gY3VyU3BlYztcbiAgICBjdXIubmV4dCA9IG5vZGU7XG4gICAgY3VyU3BlYy5uZXh0ID0gc3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2FkdmFuY2VDdXJzb3JTcGVjKHNwZWMpO1xuICAgIC8vIEw3LjMg4oCUIExhenkgbGluZWFyLW1vdW50IHN1YmZsb3cuXG4gICAgdGhpcy5fZmlyZVN0YWdlQWRkZWQoc3BlYyk7XG4gICAgdGhpcy5fZmlyZU5leHRFZGdlRnJvbVBhcmVudChwYXJlbnRTcGVjLCBpZCk7XG4gICAgdGhpcy5fZmlyZVN1YmZsb3dNb3VudGVkKGlkLCBzdWJmbG93TmFtZSwgaWQsIHRydWUpO1xuXG4gICAgdGhpcy5fc3RlcENvdW50ZXIrKztcbiAgICB0aGlzLl9zdGFnZVN0ZXBNYXAuc2V0KGlkLCB0aGlzLl9zdGVwQ291bnRlcik7XG4gICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAke3RoaXMuX3N0ZXBDb3VudGVyfS4gW0xhenkgU3ViLUV4ZWN1dGlvbjogJHtzdWJmbG93TmFtZX1dYCk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZFN1YkZsb3dDaGFydE5leHQoXG4gICAgaWQ6IHN0cmluZyxcbiAgICBzdWJmbG93OiBGbG93Q2hhcnQ8YW55LCBhbnk+LFxuICAgIG1vdW50TmFtZT86IHN0cmluZyxcbiAgICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1ci5uZXh0KSB7XG4gICAgICBmYWlsKGBjYW5ub3QgYWRkIHN1YmZsb3cgYXMgbmV4dCB3aGVuIG5leHQgaXMgYWxyZWFkeSBkZWZpbmVkIGF0ICcke2N1ci5uYW1lfSdgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG1vdW50TmFtZSB8fCBpZDtcbiAgICBjb25zdCBwcmVmaXhlZFJvb3QgPSB0aGlzLl9wcmVmaXhOb2RlVHJlZShzdWJmbG93LnJvb3QsIGlkKTtcblxuICAgIGlmICghdGhpcy5fc3ViZmxvd0RlZnMuaGFzKGlkKSkge1xuICAgICAgdGhpcy5fc3ViZmxvd0RlZnMuc2V0KGlkLCB7IHJvb3Q6IHByZWZpeGVkUm9vdCB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICBjb25zdCBhdHRhY2hlZFNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dTdHJ1Y3R1cmU6IHN1YmZsb3cuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgIH07XG5cbiAgICBjb25zdCBwYXJlbnRTcGVjID0gY3VyU3BlYztcbiAgICBjdXIubmV4dCA9IG5vZGU7XG4gICAgY3VyU3BlYy5uZXh0ID0gYXR0YWNoZWRTcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fYWR2YW5jZUN1cnNvclNwZWMoYXR0YWNoZWRTcGVjKTtcbiAgICB0aGlzLl9rbm93blN0YWdlSWRzLmFkZChpZCk7XG4gICAgLy8gTDcuMyDigJQgTGluZWFyLW1vdW50IHN1YmZsb3cuXG4gICAgdGhpcy5fZmlyZVN0YWdlQWRkZWQoYXR0YWNoZWRTcGVjKTtcbiAgICB0aGlzLl9maXJlTmV4dEVkZ2VGcm9tUGFyZW50KHBhcmVudFNwZWMsIGlkKTtcbiAgICB0aGlzLl9maXJlU3ViZmxvd01vdW50ZWQoaWQsIHN1YmZsb3dOYW1lLCBpZCwgZmFsc2UsIHN1YmZsb3cuYnVpbGRUaW1lU3RydWN0dXJlKTtcblxuICAgIHRoaXMuX21lcmdlU3RhZ2VNYXAoc3ViZmxvdy5zdGFnZU1hcCwgaWQpO1xuICAgIHRoaXMuX21lcmdlU3ViZmxvd3Moc3ViZmxvdy5zdWJmbG93cywgaWQpO1xuICAgIHRoaXMuX2FwcGVuZFN1YmZsb3dEZXNjcmlwdGlvbihpZCwgc3ViZmxvd05hbWUsIHN1YmZsb3cpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyDilIDilIAgTG9vcCDilIDilIBcblxuICBsb29wVG8oc3RhZ2VJZDogc3RyaW5nKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1clNwZWMubG9vcFRhcmdldCkgZmFpbChgbG9vcFRvIGFscmVhZHkgZGVmaW5lZCBhdCAnJHtjdXIubmFtZX0nYCk7XG4gICAgaWYgKGN1ci5uZXh0KSBmYWlsKGBjYW5ub3Qgc2V0IGxvb3BUbyB3aGVuIG5leHQgaXMgYWxyZWFkeSBkZWZpbmVkIGF0ICcke2N1ci5uYW1lfSdgKTtcblxuICAgIGlmICghdGhpcy5fa25vd25TdGFnZUlkcy5oYXMoc3RhZ2VJZCkpIHtcbiAgICAgIGZhaWwoYGxvb3BUbygnJHtzdGFnZUlkfScpIHRhcmdldCBub3QgZm91bmQg4oCUIGRpZCB5b3UgcGFzcyBhIHN0YWdlIG5hbWUgaW5zdGVhZCBvZiBpZD9gKTtcbiAgICB9XG5cbiAgICBjdXIubmV4dCA9IHsgbmFtZTogc3RhZ2VJZCwgaWQ6IHN0YWdlSWQsIGlzTG9vcFJlZjogdHJ1ZSB9O1xuICAgIGN1clNwZWMubG9vcFRhcmdldCA9IHN0YWdlSWQ7XG4gICAgY3VyU3BlYy5uZXh0ID0geyBuYW1lOiBzdGFnZUlkLCBpZDogc3RhZ2VJZCwgdHlwZTogJ2xvb3AnLCBpc0xvb3BSZWZlcmVuY2U6IHRydWUgfTtcblxuICAgIGNvbnN0IHRhcmdldFN0ZXAgPSB0aGlzLl9zdGFnZVN0ZXBNYXAuZ2V0KHN0YWdlSWQpO1xuICAgIGlmICh0YXJnZXRTdGVwICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChg4oaSIGxvb3BzIGJhY2sgdG8gc3RlcCAke3RhcmdldFN0ZXB9YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChg4oaSIGxvb3BzIGJhY2sgdG8gJHtzdGFnZUlkfWApO1xuICAgIH1cblxuICAgIC8vIEw3LjMg4oCUIEZpcmUgdGhlIGxvb3AgYmFjay1lZGdlIGV2ZW50LiBEaXN0aW5jdCBmcm9tIGBvbkVkZ2VBZGRlZGBcbiAgICAvLyBiZWNhdXNlIHJ1bnRpbWUgYG9uTG9vcGAgY2FycmllcyBgaXRlcmF0aW9uOiBudW1iZXJgIHdoaWNoIGhhcyBub1xuICAgIC8vIGJ1aWxkIG1lYW5pbmcg4oCUIHNlcGFyYXRlIGV2ZW50IGtlZXBzIHBheWxvYWRzIGhvbmVzdC5cbiAgICB0aGlzLl9maXJlTG9vcEVkZ2VBZGRlZChjdXIuaWQsIHN0YWdlSWQpO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8g4pSA4pSAIFN0cmVhbWluZyDilIDilIBcblxuICBvblN0cmVhbShoYW5kbGVyOiBTdHJlYW1Ub2tlbkhhbmRsZXIpOiB0aGlzIHtcbiAgICB0aGlzLl9zdHJlYW1IYW5kbGVycy5vblRva2VuID0gaGFuZGxlcjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIG9uU3RyZWFtU3RhcnQoaGFuZGxlcjogU3RyZWFtTGlmZWN5Y2xlSGFuZGxlcik6IHRoaXMge1xuICAgIHRoaXMuX3N0cmVhbUhhbmRsZXJzLm9uU3RhcnQgPSBoYW5kbGVyO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgb25TdHJlYW1FbmQoaGFuZGxlcjogU3RyZWFtTGlmZWN5Y2xlSGFuZGxlcik6IHRoaXMge1xuICAgIHRoaXMuX3N0cmVhbUhhbmRsZXJzLm9uRW5kID0gaGFuZGxlcjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBPdXRwdXQg4pSA4pSAXG5cbiAgYnVpbGQoKTogUnVubmFibGVGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPiB7XG4gICAgLy8gTDcuMyDigJQgc2VhbCB0aGUgY2hhcnQgc28gcG9zdC1idWlsZCBhdHRhY2hlcyB0aHJvdy4gUHJldmVudHNcbiAgICAvLyByZWNvcmRlcnMgYXR0YWNoZWQgbWlkLWV4ZWN1dGlvbiBmcm9tIGdldHRpbmcgcGFydGlhbCBkYXRhLlxuICAgIHRoaXMuX3NlYWxlZCA9IHRydWU7XG5cbiAgICBjb25zdCByb290ID0gdGhpcy5fcm9vdCA/PyBmYWlsKCdlbXB0eSB0cmVlOyBjYWxsIHN0YXJ0KCkgZmlyc3QnKTtcbiAgICBjb25zdCByb290U3BlYyA9IHRoaXMuX3Jvb3RTcGVjID8/IGZhaWwoJ2VtcHR5IHNwZWM7IGNhbGwgc3RhcnQoKSBmaXJzdCcpO1xuXG4gICAgY29uc3Qgc3ViZmxvd3M6IFJlY29yZDxzdHJpbmcsIHsgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfT4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGRlZl0gb2YgdGhpcy5fc3ViZmxvd0RlZnMpIHtcbiAgICAgIHN1YmZsb3dzW2tleV0gPSBkZWY7XG4gICAgfVxuXG4gICAgY29uc3Qgcm9vdE5hbWUgPSB0aGlzLl9yb290Py5uYW1lID8/ICdGbG93Q2hhcnQnO1xuICAgIGNvbnN0IGRlc2NyaXB0aW9uID1cbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMubGVuZ3RoID4gMCA/IGBGbG93Q2hhcnQ6ICR7cm9vdE5hbWV9XFxuU3RlcHM6XFxuJHt0aGlzLl9kZXNjcmlwdGlvblBhcnRzLmpvaW4oJ1xcbicpfWAgOiAnJztcblxuICAgIGNvbnN0IGNoYXJ0OiBGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIHJvb3QsXG4gICAgICBzdGFnZU1hcDogdGhpcy5fc3RhZ2VNYXAsXG4gICAgICBidWlsZFRpbWVTdHJ1Y3R1cmU6IHJvb3RTcGVjLFxuICAgICAgLi4uKE9iamVjdC5rZXlzKHN1YmZsb3dzKS5sZW5ndGggPiAwID8geyBzdWJmbG93cyB9IDoge30pLFxuICAgICAgLi4uKHRoaXMuX2VuYWJsZU5hcnJhdGl2ZSA/IHsgZW5hYmxlTmFycmF0aXZlOiB0cnVlIH0gOiB7fSksXG4gICAgICAuLi4odGhpcy5fbG9nZ2VyID8geyBsb2dnZXI6IHRoaXMuX2xvZ2dlciB9IDoge30pLFxuICAgICAgZGVzY3JpcHRpb24sXG4gICAgICBzdGFnZURlc2NyaXB0aW9uczogbmV3IE1hcCh0aGlzLl9zdGFnZURlc2NyaXB0aW9ucyksXG4gICAgICAuLi4odGhpcy5faW5wdXRTY2hlbWEgPyB7IGlucHV0U2NoZW1hOiB0aGlzLl9pbnB1dFNjaGVtYSB9IDoge30pLFxuICAgICAgLi4uKHRoaXMuX291dHB1dFNjaGVtYSA/IHsgb3V0cHV0U2NoZW1hOiB0aGlzLl9vdXRwdXRTY2hlbWEgfSA6IHt9KSxcbiAgICAgIC4uLih0aGlzLl9vdXRwdXRNYXBwZXIgPyB7IG91dHB1dE1hcHBlcjogdGhpcy5fb3V0cHV0TWFwcGVyIH0gOiB7fSksXG4gICAgICAvLyBBdXRvLWVtYmVkIFR5cGVkU2NvcGUgZmFjdG9yeSBpZiBub25lIHdhcyBleHBsaWNpdGx5IHNldC5cbiAgICAgIC8vIFRoaXMgbWVhbnMgQU5ZIHdheSBvZiBjcmVhdGluZyBhIEZsb3dDaGFydEJ1aWxkZXIgKGZsb3dDaGFydCgpLCBuZXcgRmxvd0NoYXJ0QnVpbGRlcigpLFxuICAgICAgLy8gb3IgYW55IHN1YmNsYXNzKSBhdXRvbWF0aWNhbGx5IGdldHMgVHlwZWRTY29wZSDigJQgbm8gbWFudWFsIHNldFNjb3BlRmFjdG9yeSBuZWVkZWQuXG4gICAgICBzY29wZUZhY3Rvcnk6IHRoaXMuX3Njb3BlRmFjdG9yeSA/PyAoY3JlYXRlVHlwZWRTY29wZUZhY3RvcnkoKSBhcyB1bmtub3duIGFzIFNjb3BlRmFjdG9yeTxUU2NvcGU+KSxcbiAgICB9O1xuXG4gICAgcmV0dXJuIG1ha2VSdW5uYWJsZShjaGFydCk7XG4gIH1cblxuICAvKiogT3ZlcnJpZGUgdGhlIHNjb3BlIGZhY3RvcnkuIFJhcmVseSBuZWVkZWQg4oCUIGF1dG8tZW1iZWRzIFR5cGVkU2NvcGUgYnkgZGVmYXVsdC4gKi9cbiAgc2V0U2NvcGVGYWN0b3J5KGZhY3Rvcnk6IFNjb3BlRmFjdG9yeTxUU2NvcGU+KTogdGhpcyB7XG4gICAgdGhpcy5fc2NvcGVGYWN0b3J5ID0gZmFjdG9yeTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHRvU3BlYzxUUmVzdWx0ID0gU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlPigpOiBUUmVzdWx0IHtcbiAgICBjb25zdCByb290U3BlYyA9IHRoaXMuX3Jvb3RTcGVjID8/IGZhaWwoJ2VtcHR5IHRyZWU7IGNhbGwgc3RhcnQoKSBmaXJzdCcpO1xuICAgIHJldHVybiByb290U3BlYyBhcyBUUmVzdWx0O1xuICB9XG5cbiAgdG9NZXJtYWlkKCk6IHN0cmluZyB7XG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gWydmbG93Y2hhcnQgVEQnXTtcbiAgICBjb25zdCBpZE9mID0gKGs6IHN0cmluZykgPT4gKGsgfHwgJycpLnJlcGxhY2UoL1teYS16QS1aMC05X10vZywgJ18nKSB8fCAnXyc7XG4gICAgY29uc3Qgcm9vdCA9IHRoaXMuX3Jvb3QgPz8gZmFpbCgnZW1wdHkgdHJlZTsgY2FsbCBzdGFydCgpIGZpcnN0Jyk7XG5cbiAgICBjb25zdCB3YWxrID0gKG46IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KSA9PiB7XG4gICAgICBjb25zdCBuaWQgPSBpZE9mKG4uaWQpO1xuICAgICAgbGluZXMucHVzaChgJHtuaWR9W1wiJHtuLm5hbWV9XCJdYCk7XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygbi5jaGlsZHJlbiB8fCBbXSkge1xuICAgICAgICBjb25zdCBjaWQgPSBpZE9mKGMuaWQpO1xuICAgICAgICBsaW5lcy5wdXNoKGAke25pZH0gLS0+ICR7Y2lkfWApO1xuICAgICAgICB3YWxrKGMpO1xuICAgICAgfVxuICAgICAgaWYgKG4ubmV4dCkge1xuICAgICAgICBjb25zdCBtaWQgPSBpZE9mKG4ubmV4dC5pZCk7XG4gICAgICAgIGxpbmVzLnB1c2goYCR7bmlkfSAtLT4gJHttaWR9YCk7XG4gICAgICAgIHdhbGsobi5uZXh0KTtcbiAgICAgIH1cbiAgICB9O1xuICAgIHdhbGsocm9vdCk7XG4gICAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpO1xuICB9XG5cbiAgLy8g4pSA4pSAIEludGVybmFscyAoZXhwb3NlZCBmb3IgaGVscGVyIGNsYXNzZXMpIOKUgOKUgFxuXG4gIHByaXZhdGUgX25lZWRDdXJzb3IoKTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4ge1xuICAgIHJldHVybiB0aGlzLl9jdXJzb3IgPz8gZmFpbCgnY3Vyc29yIHVuZGVmaW5lZDsgY2FsbCBzdGFydCgpIGZpcnN0Jyk7XG4gIH1cblxuICBwcml2YXRlIF9uZWVkQ3Vyc29yU3BlYygpOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUge1xuICAgIHJldHVybiB0aGlzLl9jdXJzb3JTcGVjID8/IGZhaWwoJ2N1cnNvciB1bmRlZmluZWQ7IGNhbGwgc3RhcnQoKSBmaXJzdCcpO1xuICB9XG5cbiAgLyoqXG4gICAqIEFkdmFuY2UgdGhlIHNwZWMgY3Vyc29yLiBSZXRhaW5lZCBhcyBhIG1ldGhvZCBzbyBjYWxsIHNpdGVzIHN0YXlcbiAgICogb25lLWxpbmVycyBhbmQgZnV0dXJlIGN1cnNvci1yZWxhdGVkIHNpZGUgZWZmZWN0cyBoYXZlIGEgaG9vay5cbiAgICovXG4gIHByaXZhdGUgX2FkdmFuY2VDdXJzb3JTcGVjKG5ld1NwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB8IHVuZGVmaW5lZCk6IHZvaWQge1xuICAgIHRoaXMuX2N1cnNvclNwZWMgPSBuZXdTcGVjO1xuICB9XG5cbiAgX3N0YWdlTWFwSGFzKGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlTWFwLmhhcyhrZXkpO1xuICB9XG5cbiAgX2FkZFRvTWFwKGlkOiBzdHJpbmcsIGZuOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pIHtcbiAgICBpZiAodGhpcy5fc3RhZ2VNYXAuaGFzKGlkKSkge1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLl9zdGFnZU1hcC5nZXQoaWQpO1xuICAgICAgaWYgKGV4aXN0aW5nICE9PSBmbikgZmFpbChgc3RhZ2VNYXAgY29sbGlzaW9uIGZvciBpZCAnJHtpZH0nYCk7XG4gICAgfVxuICAgIHRoaXMuX3N0YWdlTWFwLnNldChpZCwgZm4pO1xuICB9XG5cbiAgX21lcmdlU3RhZ2VNYXAob3RoZXI6IE1hcDxzdHJpbmcsIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPj4sIHByZWZpeD86IHN0cmluZykge1xuICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIG90aGVyKSB7XG4gICAgICBjb25zdCBrZXkgPSBwcmVmaXggPyBgJHtwcmVmaXh9LyR7a31gIDogaztcbiAgICAgIGlmICh0aGlzLl9zdGFnZU1hcC5oYXMoa2V5KSkge1xuICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuX3N0YWdlTWFwLmdldChrZXkpO1xuICAgICAgICBpZiAoZXhpc3RpbmcgIT09IHYpIGZhaWwoYHN0YWdlTWFwIGNvbGxpc2lvbiB3aGlsZSBtb3VudGluZyBmbG93Y2hhcnQgYXQgJyR7a2V5fSdgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX3N0YWdlTWFwLnNldChrZXksIHYpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIF9wcmVmaXhOb2RlVHJlZShub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgcHJlZml4OiBzdHJpbmcpOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKCFub2RlKSByZXR1cm4gbm9kZTtcbiAgICBjb25zdCBjbG9uZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IC4uLm5vZGUgfTtcbiAgICBjbG9uZS5uYW1lID0gYCR7cHJlZml4fS8ke25vZGUubmFtZX1gO1xuICAgIGNsb25lLmlkID0gYCR7cHJlZml4fS8ke25vZGUuaWR9YDtcbiAgICBpZiAoY2xvbmUuc3ViZmxvd0lkKSBjbG9uZS5zdWJmbG93SWQgPSBgJHtwcmVmaXh9LyR7Y2xvbmUuc3ViZmxvd0lkfWA7XG4gICAgaWYgKGNsb25lLm5leHQpIGNsb25lLm5leHQgPSB0aGlzLl9wcmVmaXhOb2RlVHJlZShjbG9uZS5uZXh0LCBwcmVmaXgpO1xuICAgIGlmIChjbG9uZS5jaGlsZHJlbikge1xuICAgICAgY2xvbmUuY2hpbGRyZW4gPSBjbG9uZS5jaGlsZHJlbi5tYXAoKGMpID0+IHRoaXMuX3ByZWZpeE5vZGVUcmVlKGMsIHByZWZpeCkpO1xuICAgIH1cbiAgICByZXR1cm4gY2xvbmU7XG4gIH1cblxuICBfbWVyZ2VTdWJmbG93cyhzdWJmbG93czogUmVjb3JkPHN0cmluZywgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9PiB8IHVuZGVmaW5lZCwgcHJlZml4OiBzdHJpbmcpIHtcbiAgICBpZiAoIXN1YmZsb3dzKSByZXR1cm47XG4gICAgZm9yIChjb25zdCBba2V5LCBkZWZdIG9mIE9iamVjdC5lbnRyaWVzKHN1YmZsb3dzKSkge1xuICAgICAgY29uc3QgcHJlZml4ZWRLZXkgPSBgJHtwcmVmaXh9LyR7a2V5fWA7XG4gICAgICBpZiAoIXRoaXMuX3N1YmZsb3dEZWZzLmhhcyhwcmVmaXhlZEtleSkpIHtcbiAgICAgICAgdGhpcy5fc3ViZmxvd0RlZnMuc2V0KHByZWZpeGVkS2V5LCB7XG4gICAgICAgICAgcm9vdDogdGhpcy5fcHJlZml4Tm9kZVRyZWUoZGVmLnJvb3QgYXMgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sIHByZWZpeCksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIEZhY3RvcnkgRnVuY3Rpb25cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIFN0YXJ0IGEgZmxvd2NoYXJ0IHdpdGggaXRzIGZpcnN0IHN0YWdlOyByZXR1cm5zIGEgZmx1ZW50IGJ1aWxkZXIuXG4gKlxuICogQ2hhaW4gYC5hZGRGdW5jdGlvbigpYCAvIGAuYWRkRGVjaWRlckZ1bmN0aW9uKClgIC8gYC5hZGRTZWxlY3RvckZ1bmN0aW9uKClgIC9cbiAqIGAuYWRkU3ViRmxvd0NoYXJ0KClgIGV0Yy4gdG8gYWRkIG1vcmUgc3RhZ2VzLCB0aGVuIGZpbmlzaCB3aXRoIGAuYnVpbGQoKWAuXG4gKlxuICogQHBhcmFtIG5hbWUgICAgSHVtYW4tcmVhZGFibGUgZGlzcGxheSBsYWJlbCBmb3IgdGhlIHN0YWdlIChzaG93biBpbiB0aGUgbmFycmF0aXZlL3RyYWNlKS5cbiAqIEBwYXJhbSBmbiAgICAgIFRoZSBzdGFnZSdzIHdvcmsg4oCUIGEgYChzY29wZSkgPT4g4oCmYCBmdW5jdGlvbiwgb3IgYSBgUGF1c2FibGVIYW5kbGVyYCBmb3IgaHVtYW4taW4tdGhlLWxvb3AgcGF1c2VzLlxuICogQHBhcmFtIGlkICAgICAgU3RhYmxlIHN0YWdlIGlkIHVzZWQgaW4gdHJhY2VzLCB0aGUgY29tbWl0IGxvZywgYW5kIGBydW50aW1lU3RhZ2VJZGAuIEtlZXAgaXQgdW5pcXVlIHdpdGhpbiB0aGUgY2hhcnQuXG4gKiBAcGFyYW0gb3B0aW9ucyBPcHRpb25hbCBgeyBkZXNjcmlwdGlvbj8sIHN0cnVjdHVyZVJlY29yZGVycz8gfWAuXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IGNoYXJ0ID0gZmxvd0NoYXJ0PFN0YXRlPignRmV0Y2hVc2VyJywgYXN5bmMgKHNjb3BlKSA9PiB7XG4gKiAgIHNjb3BlLnVzZXIgPSBhd2FpdCBnZXRVc2VyKCk7XG4gKiB9LCAnZmV0Y2gtdXNlcicpXG4gKiAgIC5hZGRGdW5jdGlvbignUHJvY2VzcycsIHByb2Nlc3NGbiwgJ3Byb2Nlc3MnKVxuICogICAuYnVpbGQoKTtcbiAqXG4gKiBjb25zdCB0cmFjZSA9IG5hcnJhdGl2ZSgpO1xuICogY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hhcnQucmVjb3JkZXIodHJhY2UpLnJ1bigpO1xuICogY29uc29sZS5sb2codHJhY2UuZ2V0RW50cmllcygpLm1hcCgoZSkgPT4gZS50ZXh0KS5qb2luKCdcXG4nKSk7XG4gKi9cbi8vIE92ZXJsb2FkIDE6IHR5cGVkIHN0YXRlIHdpdGggb3B0aW9ucyBvYmplY3QuXG5leHBvcnQgZnVuY3Rpb24gZmxvd0NoYXJ0PFRTdGF0ZSBleHRlbmRzIG9iamVjdD4oXG4gIG5hbWU6IHN0cmluZyxcbiAgZm46IFR5cGVkU3RhZ2VGdW5jdGlvbjxUU3RhdGU+IHwgUGF1c2FibGVIYW5kbGVyPFR5cGVkU2NvcGU8VFN0YXRlPj4sXG4gIGlkOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiBGbG93Q2hhcnRPcHRpb25zLFxuKTogRmxvd0NoYXJ0QnVpbGRlcjxhbnksIFR5cGVkU2NvcGU8VFN0YXRlPj47XG5cbi8vIE92ZXJsb2FkIDI6IGV4cGxpY2l0IGdlbmVyaWNzIHdpdGggb3B0aW9ucyBvYmplY3QuXG5leHBvcnQgZnVuY3Rpb24gZmxvd0NoYXJ0PFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4oXG4gIG5hbWU6IHN0cmluZyxcbiAgZm46IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPiB8IFBhdXNhYmxlSGFuZGxlcjxUU2NvcGU+LFxuICBpZDogc3RyaW5nLFxuICBvcHRpb25zPzogRmxvd0NoYXJ0T3B0aW9ucyxcbik6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPjtcblxuLy8gU2luZ2xlIGltcGxlbWVudGF0aW9uIOKAlCBhY2NlcHRzIHRoZSBvcHRpb25zIGJhZyAob3IgdW5kZWZpbmVkKS5cbmV4cG9ydCBmdW5jdGlvbiBmbG93Q2hhcnQ8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PihcbiAgbmFtZTogc3RyaW5nLFxuICBmbjogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+IHwgUGF1c2FibGVIYW5kbGVyPFRTY29wZT4sXG4gIGlkOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiBGbG93Q2hhcnRPcHRpb25zLFxuKTogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+IHtcbiAgY29uc3QgYnVpbGRlciA9IG5ldyBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4oKTtcbiAgLy8gQXR0YWNoIFN0cnVjdHVyZVJlY29yZGVycyBCRUZPUkUgc3RhcnQoKSBzbyB0aGUgc2VlZCBldmVudCBmaXJlcyB0aHJvdWdoXG4gIC8vIHRoZSBub3JtYWwgZGlzcGF0Y2hlciBwYXRoIChubyByZXBsYXkgbmVlZGVkKS4gSXRlcmF0aW9uIG9yZGVyIG1hdGNoZXNcbiAgLy8gYXJyYXkgb3JkZXIsIG1hdGNoaW5nIHRoZSBmbHVlbnQgYC5hdHRhY2hTdHJ1Y3R1cmVSZWNvcmRlcigpYCBjaGFpblxuICAvLyBzZW1hbnRpY3MuXG4gIGlmIChvcHRpb25zPy5zdHJ1Y3R1cmVSZWNvcmRlcnMpIHtcbiAgICBmb3IgKGNvbnN0IHJlYyBvZiBvcHRpb25zLnN0cnVjdHVyZVJlY29yZGVycykge1xuICAgICAgYnVpbGRlci5hdHRhY2hTdHJ1Y3R1cmVSZWNvcmRlcihyZWMpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYnVpbGRlci5zdGFydChuYW1lLCBmbiBhcyBhbnksIGlkLCBvcHRpb25zPy5kZXNjcmlwdGlvbik7XG59XG5cbi8qKlxuICogTGlrZSBgZmxvd0NoYXJ0KClgLCBidXQgdGhlIFJPT1Qgc3RhZ2UgaXMgYSBTRUxFQ1RPUiDigJQgaXQgcnVucyBmaXJzdCBhbmRcbiAqIGl0cyBicmFuY2hlcyBhdHRhY2ggZGlyZWN0bHkgdG8gaXQgKG5vIHNlcGFyYXRlIHNlZWQgc3RhZ2UpLiBSZXR1cm5zIGFcbiAqIGBTZWxlY3RvckZuTGlzdGA7IGRlY2xhcmUgYnJhbmNoZXMgdGhlbiBjYWxsIGAuZW5kKClgIHRvIGdldCB0aGUgYnVpbGRlclxuICogYmFjayBmb3IgYW55IHN1YnNlcXVlbnQgc3RhZ2VzLlxuICpcbiAqIEBleGFtcGxlXG4gKiAgIGZsb3dDaGFydFNlbGVjdG9yPE15U3RhdGU+KCdDb250ZXh0JywgY29udGV4dFNlbGVjdG9yRm4sICdjb250ZXh0JylcbiAqICAgICAuYWRkU3ViRmxvd0NoYXJ0QnJhbmNoKCdzZi1zeXN0ZW0tcHJvbXB0Jywgc3lzU2xvdCwgJ1N5c3RlbSBQcm9tcHQnLCB7Li4ufSlcbiAqICAgICAuYWRkU3ViRmxvd0NoYXJ0QnJhbmNoKCdzZi1tZXNzYWdlcycsIG1zZ1Nsb3QsICdNZXNzYWdlcycsIHsuLi59KVxuICogICAgIC5lbmQoKVxuICogICAgIC5hZGRGdW5jdGlvbignbWVzc2FnZUFQSScsIGFzc2VtYmxlRm4sICdtZXNzYWdlLWFwaScpXG4gKiAgICAgLmJ1aWxkKCk7XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmbG93Q2hhcnRTZWxlY3RvcjxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+KFxuICBuYW1lOiBzdHJpbmcsXG4gIGZuOiBTdGFnZUZ1bmN0aW9uPGFueSwgVFNjb3BlPixcbiAgaWQ6IHN0cmluZyxcbiAgb3B0aW9ucz86IEZsb3dDaGFydE9wdGlvbnMsXG4pOiBTZWxlY3RvckZuTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgY29uc3QgYnVpbGRlciA9IG5ldyBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4oKTtcbiAgaWYgKG9wdGlvbnM/LnN0cnVjdHVyZVJlY29yZGVycykge1xuICAgIGZvciAoY29uc3QgcmVjIG9mIG9wdGlvbnMuc3RydWN0dXJlUmVjb3JkZXJzKSB7XG4gICAgICBidWlsZGVyLmF0dGFjaFN0cnVjdHVyZVJlY29yZGVyKHJlYyk7XG4gICAgfVxuICB9XG4gIHJldHVybiBidWlsZGVyLnN0YXJ0U2VsZWN0b3IobmFtZSwgZm4sIGlkLCBvcHRpb25zPy5kZXNjcmlwdGlvbiwge1xuICAgIC4uLihvcHRpb25zPy5mYWlsRmFzdCAhPT0gdW5kZWZpbmVkICYmIHsgZmFpbEZhc3Q6IG9wdGlvbnMuZmFpbEZhc3QgfSksXG4gIH0pO1xufVxuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFNwZWMgdG8gU3RhZ2VOb2RlIENvbnZlcnRlclxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBzcGVjVG9TdGFnZU5vZGUoc3BlYzogRmxvd0NoYXJ0U3BlYyk6IFN0YWdlTm9kZTxhbnksIGFueT4ge1xuICBjb25zdCBpbmZsYXRlID0gKHM6IEZsb3dDaGFydFNwZWMpOiBTdGFnZU5vZGU8YW55LCBhbnk+ID0+ICh7XG4gICAgbmFtZTogcy5uYW1lLFxuICAgIGlkOiBzLmlkLFxuICAgIGNoaWxkcmVuOiBzLmNoaWxkcmVuPy5sZW5ndGggPyBzLmNoaWxkcmVuLm1hcChpbmZsYXRlKSA6IHVuZGVmaW5lZCxcbiAgICBuZXh0OiBzLm5leHQgPyBpbmZsYXRlKHMubmV4dCkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICByZXR1cm4gaW5mbGF0ZShzcGVjKTtcbn1cbiJdfQ==