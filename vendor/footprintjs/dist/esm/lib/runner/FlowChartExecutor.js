/**
 * FlowChartExecutor — Public API for executing a compiled FlowChart.
 *
 * Wraps FlowchartTraverser. Build a chart with flowChart() and pass the result here:
 *
 *   const chart = flowChart('entry', entryFn).addFunction('process', processFn).build();
 *
 *   // No-options form (uses auto-detected TypedScope factory from the chart):
 *   const executor = new FlowChartExecutor(chart);
 *
 *   // Options-object form (preferred when you need to customize behavior):
 *   const executor = new FlowChartExecutor(chart, { scopeFactory: myFactory });
 *
 *   // 2-param form (accepts a ScopeFactory directly, for backward compatibility):
 *   const executor = new FlowChartExecutor(chart, myFactory);
 *
 *   const result = await executor.run({ input: data, env: { traceId: 'req-123' } });
 */
import { detachAndForget as _detachAndForget, detachAndJoinLater as _detachAndJoinLater } from '../detach/spawn.js';
import { CombinedNarrativeRecorder } from '../engine/narrative/CombinedNarrativeRecorder.js';
import { ManifestFlowRecorder } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import { buildRuntimeStageId } from '../engine/runtimeStageId.js';
import { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import { defaultLogger, } from '../engine/types.js';
import { isPauseSignal } from '../pause/types.js';
import { hasEmitRecorderMethods, hasFlowRecorderMethods, hasRecorderMethods } from '../recorder/CombinedRecorder.js';
import { isDevMode } from '../scope/detectCircular.js';
import { deepFreeze } from '../scope/protection/readonlyInput.js';
import { ScopeFacade } from '../scope/ScopeFacade.js';
import { describeCheckpointCloneFailure, sanitizeDiagnosticBags } from './checkpointSanitize.js';
import { DeferredObserverTier } from './DeferredObserverTier.js';
import { ExecutionRuntime } from './ExecutionRuntime.js';
import { generateRunId } from './runId.js';
import { validateInput } from './validateInput.js';
/** Default scope factory — creates a plain ScopeFacade for each stage. */
const defaultScopeFactory = (ctx, stageName, readOnly, env) => new ScopeFacade(ctx, stageName, readOnly, env);
export class FlowChartExecutor {
    traverser;
    /** Shared execution counter — survives pause/resume. Reset on fresh run(). */
    _executionCounter = { value: 0 };
    /** Shared per-run visit counts (by stageId) driving TraversalContext.loopIteration.
     *  Twin of _executionCounter: survives pause/resume, reset on fresh run(). */
    _visitCounts = new Map();
    /** Per-`run()` identifier — generated fresh per run + per resume. Threaded
     *  through every TraversalContext so recorders can scope state to a single
     *  run. See `runId.ts`. */
    _currentRunId = '';
    narrativeEnabled = false;
    narrativeOptions;
    combinedRecorder;
    flowRecorders = [];
    scopeRecorders = [];
    /**
     * RFC-001 deferred-observer wiring — created LAZILY on the first
     * `delivery: 'deferred'` attach. `undefined` for every executor that never
     * opts in: zero allocation, zero per-event cost, byte-identical behavior
     * (the emit fast-path precedent).
     */
    deferredTier;
    redactionPolicy;
    sharedRedactedKeys = new Set();
    sharedRedactedFieldsByKey = new Map();
    lastCheckpoint;
    /**
     * `true` once `run()` (or a previous `resume()`) has executed on
     * this instance. `resume()` branches on it:
     *
     *   • true  → reuse the constructor-time runtime (same-executor
     *             continuity: execution tree, recorders, narrative
     *             accumulate across pause/resume cycles)
     *   • false → seed a fresh runtime from `checkpoint.sharedState`
     *             (cross-executor / cross-process resume: new instance
     *             reconstructed from a serialized checkpoint)
     *
     * Without this flag, fresh executors silently discarded the
     * checkpoint's sharedState and resume handlers couldn't read pre-pause
     * scope. See `test/lib/pause/cross-executor-resume.test.ts`.
     */
    _hasRunBefore = false;
    /**
     * Re-entrancy guard. `run()` and `resume()` mutate per-run instance state
     * (traverser, runId, execution counter, checkpoint) and clear attached
     * recorders — a second concurrent entry on the SAME executor would
     * interleave runIds and cross-contaminate recorder/narrative state, and
     * `getCheckpoint()` would return whichever run paused last. One executor =
     * one in-flight execution; create an executor per concurrent run.
     * See docs/guides/execution-model.md.
     */
    _isExecuting = false;
    // SYNC REQUIRED: every optional field here must mirror FlowChartExecutorOptions
    // AND be assigned in the constructor's options-resolution block (the `else if` branch).
    // Adding a field to only one of the three places causes silent omission.
    flowChartArgs;
    /**
     * Create a FlowChartExecutor.
     *
     * **Options object form** (preferred):
     * ```typescript
     * new FlowChartExecutor(chart, { scopeFactory, defaultValuesForContext })
     * ```
     *
     * **2-param form** (also supported):
     * ```typescript
     * new FlowChartExecutor(chart, scopeFactory)
     * ```
     *
     * @param flowChart - The compiled FlowChart returned by `flowChart(...).build()`
     * @param factoryOrOptions - A `ScopeFactory<TScope>` OR a `FlowChartExecutorOptions<TScope>` options object.
     */
    constructor(flowChart, factoryOrOptions) {
        // Detect options-object form vs factory form
        let scopeFactory;
        let defaultValuesForContext;
        let initialContext;
        let readOnlyContext;
        let throttlingErrorChecker;
        let streamHandlers;
        let scopeProtectionMode;
        let readTracking;
        let writeTracking;
        let commitValues;
        let writeProvenance;
        if (typeof factoryOrOptions === 'function') {
            // 2-param form: new FlowChartExecutor(chart, scopeFactory)
            scopeFactory = factoryOrOptions;
        }
        else if (factoryOrOptions !== undefined) {
            // Options object form
            const opts = factoryOrOptions;
            scopeFactory = opts.scopeFactory;
            defaultValuesForContext = opts.defaultValuesForContext;
            initialContext = opts.initialContext;
            readOnlyContext = opts.readOnlyContext;
            throttlingErrorChecker = opts.throttlingErrorChecker;
            streamHandlers = opts.streamHandlers;
            scopeProtectionMode = opts.scopeProtectionMode;
            readTracking = opts.readTracking;
            writeTracking = opts.writeTracking;
            commitValues = opts.commitValues;
            writeProvenance = opts.writeProvenance;
        }
        this.flowChartArgs = {
            flowChart,
            scopeFactory: scopeFactory ?? flowChart.scopeFactory ?? defaultScopeFactory,
            defaultValuesForContext,
            initialContext,
            readOnlyContext,
            throttlingErrorChecker,
            streamHandlers,
            scopeProtectionMode,
            readTracking,
            writeTracking,
            commitValues,
            writeProvenance,
        };
        this.traverser = this.createTraverser();
    }
    createTraverser(signal, readOnlyContextOverride, env, maxDepth, maxIterations, overrides) {
        const args = this.flowChartArgs;
        const fc = args.flowChart;
        const narrativeFlag = this.narrativeEnabled || (fc.enableNarrative ?? false);
        // ── Composed scope factory ─────────────────────────────────────────
        // Collect all scope modifiers (recorders, redaction) into a single list,
        // then create ONE factory that applies them in a loop. Replaces the
        // previous 4-deep closure nesting with a flat, debuggable composition.
        if (overrides?.preserveRecorders) {
            // Resume mode: keep existing combinedRecorder so narrative accumulates
        }
        else if (narrativeFlag) {
            this.combinedRecorder = new CombinedNarrativeRecorder(this.narrativeOptions);
        }
        else {
            this.combinedRecorder = undefined;
        }
        this.sharedRedactedKeys = new Set();
        this.sharedRedactedFieldsByKey = new Map();
        const modifiers = [];
        // 1. Narrative recorder (if enabled)
        if (this.combinedRecorder) {
            const recorder = this.combinedRecorder;
            modifiers.push((scope) => {
                if (typeof scope.attachScopeRecorder === 'function')
                    scope.attachScopeRecorder(recorder);
            });
        }
        // 2. User-provided scope recorders
        if (this.scopeRecorders.length > 0) {
            const recorders = this.scopeRecorders;
            modifiers.push((scope) => {
                if (typeof scope.attachScopeRecorder === 'function') {
                    for (const r of recorders)
                        scope.attachScopeRecorder(r);
                }
            });
        }
        // 2b. Deferred-observer scope tap (RFC-001 Block 7) — a synthetic
        // recorder whose hooks CAPTURE into the bounded queue instead of doing
        // observer work. It rides the same per-stage recorder list as inline
        // recorders, so it receives exactly the post-redaction events they do.
        // Absent (zero work, identical list) when nobody opted into deferral.
        const scopeTap = this.deferredTier?.buildScopeTap();
        if (scopeTap) {
            modifiers.push((scope) => {
                if (typeof scope.attachScopeRecorder === 'function')
                    scope.attachScopeRecorder(scopeTap);
            });
        }
        // 3. Redaction policy (conditional — only when policy is set)
        if (this.redactionPolicy) {
            const policy = this.redactionPolicy;
            modifiers.push((scope) => {
                if (typeof scope.useRedactionPolicy === 'function') {
                    scope.useRedactionPolicy(policy);
                }
            });
            // Pre-populate executor-level field redaction map from policy
            // so getRedactionReport() includes field-level redactions.
            if (policy.fields) {
                for (const [key, fields] of Object.entries(policy.fields)) {
                    this.sharedRedactedFieldsByKey.set(key, new Set(fields));
                }
            }
        }
        // Compose: base factory + modifiers in a single pass.
        // Shared redacted keys are ALWAYS wired up (unconditional — ensures cross-stage
        // propagation even without a policy, because stages can call setValue(key, val, true)
        // for per-call redaction). Optional modifiers (recorders, policy) are in the list.
        const baseFactory = args.scopeFactory;
        const sharedRedactedKeys = this.sharedRedactedKeys;
        const scopeFactory = ((ctx, stageName, readOnly, envArg) => {
            const scope = baseFactory(ctx, stageName, readOnly, envArg);
            // Always wire shared redaction state
            if (typeof scope.useSharedRedactedKeys === 'function') {
                scope.useSharedRedactedKeys(sharedRedactedKeys);
            }
            // Apply optional modifiers
            for (const mod of modifiers)
                mod(scope);
            return scope;
        });
        const effectiveRoot = overrides?.root ?? fc.root;
        const effectiveInitialContext = overrides?.initialContext ?? args.initialContext;
        let runtime;
        if (overrides?.existingRuntime) {
            // Resume mode: reuse existing runtime so execution tree continues from pause point.
            // Preserve the original root for getSnapshot() (full tree), then advance
            // rootStageContext to a continuation from the leaf (for traversal).
            runtime = overrides.existingRuntime;
            runtime.preserveSnapshotRoot();
            let leaf = runtime.rootStageContext;
            while (leaf.next)
                leaf = leaf.next;
            runtime.rootStageContext = leaf.createNext('', effectiveRoot.name, effectiveRoot.id);
        }
        else {
            runtime = new ExecutionRuntime(effectiveRoot.name, effectiveRoot.id, args.defaultValuesForContext, effectiveInitialContext);
        }
        // When a redaction policy is configured, maintain a parallel redacted
        // mirror of `globalStore` during traversal. Each commit applies the
        // already-computed redacted patches — same ones fed to the event log —
        // so `getSnapshot({ redact: true })` returns a scrubbed sharedState at
        // zero post-pass cost. Skipped when no policy exists (zero allocation).
        if (this.redactionPolicy) {
            runtime.enableRedactedMirror();
        }
        // Read-tracking policy (#14): set on the runtime's root context so every
        // descendant context (createNext/createChild) and subflow root inherits.
        // Applied AFTER the resume-path root swap above so the continuation root
        // carries the policy too. Skipped for the default 'full' — zero work.
        const readTracking = args.readTracking;
        if (readTracking !== undefined && readTracking !== 'full') {
            runtime.useReadTracking(readTracking);
        }
        // Write-tracking policy (#13c-A): identical plumbing to readTracking —
        // same root-context anchor, same inheritance, same resume-path ordering.
        const writeTracking = args.writeTracking;
        if (writeTracking !== undefined && writeTracking !== 'full') {
            runtime.useWriteTracking(writeTracking);
        }
        // Commit-values encoding (#13c-B): identical plumbing to the two dials
        // above — root-context anchor, createNext/createChild inheritance,
        // SubflowExecutor duck-push, resume-path re-application. Skipped for the
        // default 'full' — zero work, byte-identical commit log.
        const commitValues = args.commitValues;
        if (commitValues !== undefined && commitValues !== 'full') {
            runtime.useCommitValues(commitValues);
        }
        // Per-write read provenance (#P1): identical plumbing to the three dials
        // above — root-context anchor, createNext/createChild inheritance,
        // SubflowExecutor duck-push, resume-path re-application. Skipped for the
        // default 'off' — zero work, byte-identical commit log.
        const writeProvenance = args.writeProvenance;
        if (writeProvenance !== undefined && writeProvenance !== 'off') {
            runtime.useWriteProvenance(writeProvenance);
        }
        return new FlowchartTraverser({
            root: effectiveRoot,
            stageMap: fc.stageMap,
            scopeFactory,
            executionRuntime: runtime,
            readOnlyContext: readOnlyContextOverride ?? args.readOnlyContext,
            throttlingErrorChecker: args.throttlingErrorChecker,
            streamHandlers: args.streamHandlers,
            scopeProtectionMode: args.scopeProtectionMode,
            subflows: fc.subflows,
            narrativeEnabled: narrativeFlag,
            buildTimeStructure: fc.buildTimeStructure,
            logger: fc.logger ?? defaultLogger,
            signal,
            executionEnv: env,
            flowRecorders: this.buildFlowRecordersList(),
            executionCounter: this._executionCounter,
            visitCounts: this._visitCounts,
            runId: this._currentRunId,
            ...(overrides?.subflowsOverride && { subflows: overrides.subflowsOverride }),
            ...(overrides?.subflowStatesForResume && {
                subflowStatesForResume: overrides.subflowStatesForResume,
            }),
            ...(maxDepth !== undefined && { maxDepth }),
            ...(maxIterations !== undefined && { maxIterations }),
        });
    }
    enableNarrative(options) {
        this.narrativeEnabled = true;
        if (options)
            this.narrativeOptions = options;
    }
    /**
     * Set a declarative redaction policy that applies to all stages.
     * Must be called before run().
     */
    setRedactionPolicy(policy) {
        this.redactionPolicy = policy;
    }
    /**
     * Set the read-tracking policy for `StageSnapshot.stageReads` (#14).
     * Must be called before run(). Equivalent to the `readTracking`
     * constructor option — see {@link FlowChartExecutorOptions.readTracking}
     * for the mode semantics ('full' default / 'summary' / 'off').
     */
    setReadTracking(mode) {
        this.flowChartArgs.readTracking = mode;
    }
    /**
     * Set the write-tracking policy for `StageSnapshot.stageWrites` (#13c-A).
     * Must be called before run(). Equivalent to the `writeTracking`
     * constructor option — see {@link FlowChartExecutorOptions.writeTracking}
     * for the mode semantics ('full' default / 'summary' / 'off'), the
     * onCommit-payload consequence, and the redaction-precedence rule.
     */
    setWriteTracking(mode) {
        this.flowChartArgs.writeTracking = mode;
    }
    /**
     * Set the commit-values encoding policy for the commit log (#13c-B).
     * Must be called before run(). Equivalent to the `commitValues`
     * constructor option — see {@link FlowChartExecutorOptions.commitValues}
     * for the mode semantics ('full' default / 'delta'), the verb-qualified
     * `overwrite` consequence, and the `commitValueAt` migration helper.
     */
    setCommitValues(mode) {
        this.flowChartArgs.commitValues = mode;
    }
    /**
     * Returns a compliance-friendly report of all redaction activity from the
     * most recent run. Never includes actual values.
     */
    getRedactionReport() {
        const fieldRedactions = {};
        for (const [key, fields] of this.sharedRedactedFieldsByKey) {
            fieldRedactions[key] = [...fields];
        }
        return {
            redactedKeys: [...this.sharedRedactedKeys],
            fieldRedactions,
            patterns: (this.redactionPolicy?.patterns ?? []).map((p) => p.source),
        };
    }
    // ─── Pause/Resume ───
    /**
     * Returns the checkpoint from the most recent paused execution, or `undefined`
     * if the last run completed without pausing.
     *
     * The checkpoint is JSON-serializable — store it in Redis, Postgres, localStorage, etc.
     *
     * It is fully DETACHED from engine state: every field was deep-copied at
     * pause time (see `buildPauseCheckpoint`). Holding, mutating, or persisting
     * it cannot affect the executor, and a later same-executor resume cannot
     * mutate a checkpoint you already stored.
     *
     * @example
     * ```typescript
     * const result = await executor.run({ input });
     * if (executor.isPaused()) {
     *   const checkpoint = executor.getCheckpoint()!;
     *   await redis.set(`session:${id}`, JSON.stringify(checkpoint));
     * }
     * ```
     */
    getCheckpoint() {
        return this.lastCheckpoint;
    }
    /** Returns `true` if the most recent run() was paused (checkpoint available). */
    isPaused() {
        return this.lastCheckpoint !== undefined;
    }
    /**
     * Number of commits in the run's commit log. O(1) — direct length
     * read, no snapshot materialization. Use this to stamp commit
     * indices on observer events (e.g., `BoundaryRecorder` storing
     * `commitIdxBefore` / `commitIdxAfter` per domain event for
     * `CommitRangeIndex` queries — see `footprintjs/trace`).
     *
     * Returns 0 before any run; after, returns the cumulative commit
     * count across the executor's lifetime (including resumes).
     *
     * IMPLEMENTATION NOTE: this returns `runtime.executionHistory.length`,
     * which is the same value as `getSnapshot().commitLog.length`. The
     * naming asymmetry is historical — the underlying `EventLog` field
     * is named `executionHistory` but stores the `CommitBundle[]` that
     * `commitLog` exposes. They are the SAME array (verified by the
     * "matches commitLog.length" integration test).
     */
    getCommitCount() {
        const runtime = this.traverser.getRuntime();
        return runtime?.executionHistory.length ?? 0;
    }
    /**
     * Resume a paused flowchart from a checkpoint.
     *
     * Restores the scope state, calls the paused stage's `resumeFn` with the
     * provided input, then continues traversal from the next stage.
     *
     * The checkpoint can come from `getCheckpoint()` on a previous run, or from
     * a serialized checkpoint stored in Redis/Postgres/localStorage.
     *
     * **Recorder/narrative state depends on the resume mode.** Resuming on the SAME
     * executor that ran preserves and accumulates narrative/metrics/debug across the
     * pause/resume cycle (preserveRecorders). Resuming on a FRESH executor
     * (reconstructed from a stored checkpoint) starts with empty recorder state —
     * collect what you need before discarding the paused executor. A fresh `runId`
     * is generated either way.
     *
     * @example
     * ```typescript
     * // Process A — after a pause, persist the checkpoint:
     * const checkpoint = executor.getCheckpoint()!;
     * await redis.set(`session:${id}`, JSON.stringify(checkpoint));
     *
     * // Process B (possibly different server, same chart) — restore and resume:
     * const restored = JSON.parse(await redis.get(`session:${id}`));
     * const executor = new FlowChartExecutor(chart);
     * const result = await executor.resume(restored, { approved: true });
     * ```
     */
    async resume(checkpoint, resumeInput, options) {
        // Re-entrancy guard FIRST — resume() mutates the same per-run state run()
        // does (traverser, runId, checkpoint), so resume-during-run and
        // double-resume are the same corruption class as concurrent run().
        if (this._isExecuting) {
            throw new Error('FlowChartExecutor: resume() called while another run()/resume() is in flight on this ' +
                'executor. An executor holds per-run state (runId, recorders, checkpoint) — create ' +
                'one executor per concurrent run. See docs/guides/execution-model.md.');
        }
        // ── Validate checkpoint structure (may come from untrusted external storage) ──
        // (lastCheckpoint is wiped AFTER validation — a rejected checkpoint must
        // not destroy the executor's existing checkpoint state.)
        if (!checkpoint ||
            typeof checkpoint !== 'object' ||
            typeof checkpoint.sharedState !== 'object' ||
            checkpoint.sharedState === null ||
            Array.isArray(checkpoint.sharedState)) {
            throw new Error('Invalid checkpoint: sharedState must be a plain object.');
        }
        if (typeof checkpoint.pausedStageId !== 'string' || checkpoint.pausedStageId === '') {
            throw new Error('Invalid checkpoint: pausedStageId must be a non-empty string.');
        }
        if (!Array.isArray(checkpoint.subflowPath) ||
            !checkpoint.subflowPath.every((s) => typeof s === 'string')) {
            throw new Error('Invalid checkpoint: subflowPath must be an array of strings.');
        }
        // ── Seed the shared execution counter + per-stage visit counts ──
        //
        // MUST run before the counter is READ below (the resume-node runtimeStageId
        // reconstruction) AND before createTraverser() hands the traverser these
        // objects BY REFERENCE. Seeding keeps runtimeStageIds unique and
        // loopIteration monotonic across a CROSS-executor resume (a fresh executor
        // starts both at 0/empty; the checkpoint carries the pause-time values).
        //
        // MUTATE, never REPLACE: `_executionCounter` and `_visitCounts` are shared
        // by reference into the traverser (and, transitively, every subflow
        // traverser — see FlowchartTraverser's sub-traverser factory). Assigning a
        // fresh object here would sever that shared reference. Both fields are
        // optional on the checkpoint (older persisted checkpoints omit them) — skip
        // seeding when absent, preserving the previous behavior. Same-executor
        // resume is idempotent: at pause the instance values already equal the
        // checkpoint's, so re-seeding them changes nothing.
        if (typeof checkpoint.executionCount === 'number') {
            this._executionCounter.value = checkpoint.executionCount;
        }
        if (checkpoint.visitCounts) {
            this._visitCounts.clear();
            for (const [stageId, count] of Object.entries(checkpoint.visitCounts)) {
                this._visitCounts.set(stageId, count);
            }
        }
        // Find the paused node in the graph
        const pausedNode = this.findNodeInGraph(checkpoint.pausedStageId, checkpoint.subflowPath);
        if (!pausedNode) {
            throw new Error(`Cannot resume: stage '${checkpoint.pausedStageId}' not found in flowchart. ` +
                'The chart may have changed since the checkpoint was created.');
        }
        if (!pausedNode.resumeFn) {
            throw new Error(`Cannot resume: stage '${pausedNode.name}' (${pausedNode.id}) has no resumeFn. ` +
                'Only stages created with addPausableFunction() can be resumed.');
        }
        this.lastCheckpoint = undefined;
        // Build a synthetic resume node: calls resumeFn with resumeInput, then continues.
        // resumeFn signature is (scope, input) per PausableHandler — wrap to match StageFunction(scope, breakFn).
        const resumeFn = pausedNode.resumeFn;
        const resumeStageFn = (scope) => {
            return resumeFn(scope, resumeInput);
        };
        // Determine continuation: for branch children (decider/selector),
        // pausedNode.next is undefined. The checkpoint's
        // continuationStageId (collected during traversal bubble-up)
        // points to the invoker's next node.
        //
        // For pauses inside a subflow, the continuation lives INSIDE the
        // leaf subflow (e.g., the loop target back to `messages`). Search
        // the leaf subflow first; fall back to top-level for root-level
        // pauses.
        // Clone-in: `subflowStates` seeds nested runtimes in SubflowExecutor
        // (shallow-merged into each nested SharedMemory), so without a copy the
        // engine would hold live references into the caller's checkpoint object —
        // caller mutations would bleed into the resumed run and engine writes
        // would reach a checkpoint the caller may have already persisted.
        const sfStates = structuredClone(checkpoint.subflowStates);
        const leafSubflowId = checkpoint.subflowPath.length > 0 ? checkpoint.subflowPath[checkpoint.subflowPath.length - 1] : undefined;
        let continuationNext = pausedNode.next;
        // A branch-sourced loop (`{ loopTo }` / `DeciderList.loopTo`) sets the
        // looping branch's `next` to a loop-ref STUB — `{ id, isLoopRef:true }`
        // with no fn/children/subflowId. On a NORMAL run that stub resolves fine:
        // the real target node is reachable from the chart root, so the traverser's
        // node map already holds it (the stub is skipped — first-write-wins). On
        // RESUME the node map is built from the truncated resume root, where the
        // real target is unreachable, so the stub would win the id slot and
        // `executeNode` throws "Node '<target>' must define ...". Resolve the stub
        // to the REAL target node here (dfsFind skips loop-refs and returns the
        // real node WITH its full downstream chain — e.g. a subflow MOUNT node,
        // whose `.next` carries the decider/terminal continuation the loop must
        // re-enter). See test/lib/pause/resume-branch-loop-subflow.test.ts.
        if (continuationNext?.isLoopRef) {
            const loopTargetId = continuationNext.id;
            const realTarget = (leafSubflowId !== undefined ? this.findNodeInGraph(loopTargetId, checkpoint.subflowPath) : undefined) ??
                this.findNodeInGraph(loopTargetId, []);
            if (realTarget)
                continuationNext = realTarget;
        }
        if (!continuationNext && checkpoint.continuationStageId) {
            // Search leaf subflow first (loop targets / branch joins live there),
            // then fall back to top level.
            continuationNext = leafSubflowId
                ? this.findNodeInGraph(checkpoint.continuationStageId, checkpoint.subflowPath)
                : undefined;
            if (!continuationNext) {
                continuationNext = this.findNodeInGraph(checkpoint.continuationStageId, []);
            }
        }
        // The "inner" resume chain: resumeFn → continuation. This is what
        // runs INSIDE the leaf subflow's body. For a root-level pause
        // (subflowPath empty), this is also the top-level resume root.
        const innerResumeChain = {
            name: pausedNode.name,
            id: pausedNode.id,
            description: pausedNode.description,
            fn: resumeStageFn,
            next: continuationNext,
        };
        // Don't clear recorders — resume continues from previous state.
        // Narrative, metrics, debug entries accumulate across pause/resume.
        //
        // Two-mode resume:
        //   • Same-executor (run() previously called on THIS instance):
        //     reuse the existing runtime so the execution tree continues
        //     from the pause point and recorders/narrative accumulate.
        //   • Cross-executor (fresh executor reconstructed from a stored
        //     checkpoint): seed a NEW runtime from `checkpoint.sharedState`
        //     so resume handlers can read pre-pause scope. The execution
        //     tree starts at the resume node — we don't have the previous
        //     traversal's tree on a fresh process anyway.
        const sameExecutor = this._hasRunBefore;
        const existingRuntime = sameExecutor
            ? this.traverser.getRuntime()
            : undefined;
        this._hasRunBefore = true; // any path that resumes counts as a run
        // Resume gets a NEW runId — resume is logically a distinct run.
        // Original runId is recoverable from checkpoint metadata if a consumer
        // needs cross-run audit (we don't store it on the checkpoint today;
        // future enhancement). See `runId.ts`.
        this._currentRunId = generateRunId();
        // Pick the resume root + initial context.
        //
        //   ROOT-LEVEL PAUSE (subflowPath empty):
        //     resume root = innerResumeChain (run resumeFn at top level).
        //     initialContext = checkpoint.sharedState.
        //
        //   SUBFLOW-NESTED PAUSE (subflowPath non-empty):
        //     The pause was INSIDE a subflow's body. To run the subflow's
        //     outputMapper and the parent's continuation, we have to enter
        //     through the OUTER MOUNT (the parent's node that mounts the
        //     leaf subflow). We swap the leaf subflow's root with
        //     innerResumeChain so SubflowExecutor:
        //       1. enters the subflow boundary,
        //       2. seeds the nested runtime from subflowStates[leaf]
        //          (skipping the inputMapper — see SubflowExecutor.ts),
        //       3. runs the resumeFn → continuation chain,
        //       4. runs the outputMapper at exit,
        //       5. parent traversal continues normally.
        //
        //     Cross-executor: initialContext = checkpoint.sharedState (the
        //       parent's view at pause time — outputMapper writes back into it).
        //     Same-executor: existingRuntime is reused; initialContext is moot
        //       for the subflow frame (already in the runtime stack), but we
        //       still pass sharedState for consistency.
        const fc = this.flowChartArgs.flowChart;
        let resumeRoot = innerResumeChain;
        let subflowsOverride;
        if (leafSubflowId !== undefined) {
            // Find the OUTER mount node for the FIRST entry on the path.
            // For single-level pauses, this is the only mount we need to
            // enter through. For nested mounts the pattern would extend, but
            // single-level covers all current use cases (Sequence(Agent),
            // Conditional(Agent), Parallel branches with paused agents).
            const outerSubflowId = checkpoint.subflowPath[0];
            const outerMount = this.findMountInGraph(fc.root, outerSubflowId);
            if (outerMount) {
                resumeRoot = outerMount;
            }
            // Replace the leaf subflow's root with the resume chain so the
            // body runs from the pause point forward.
            subflowsOverride = { ...(fc.subflows ?? {}) };
            subflowsOverride[leafSubflowId] = { root: innerResumeChain };
        }
        // Clone-in for the same reason as `sfStates` above: `initialContext`
        // seeds the fresh SharedMemory via `mergeContextWins`, which copies only
        // the TOP level — nested objects would alias the caller's checkpoint.
        const resumeInitialContext = structuredClone(checkpoint.sharedState);
        this.traverser = this.createTraverser(options?.signal, undefined, options?.env, options?.maxDepth, options?.maxIterations, {
            root: resumeRoot,
            initialContext: resumeInitialContext,
            preserveRecorders: true,
            ...(existingRuntime ? { existingRuntime } : {}),
            // Hand the per-subflow scope captures down to SubflowExecutor.
            // Always present on a checkpoint — empty `{}` for root pauses.
            subflowStatesForResume: sfStates,
            ...(subflowsOverride && { subflowsOverride }),
        });
        // Fire onResume event on all recorders (flow + scope). Stamp the
        // synthetic TraversalContext for the resumed stage with the NEW
        // runId so consumers detect "this is a fresh logical run" via
        // the same runId-change pattern they use for `onRunStart`.
        const hasInput = resumeInput !== undefined;
        const resumeRuntimeStageId = buildRuntimeStageId(pausedNode.id, this._executionCounter.value);
        const flowResumeEvent = {
            stageName: pausedNode.name,
            stageId: pausedNode.id,
            hasInput,
            traversalContext: {
                runId: this._currentRunId,
                stageId: pausedNode.id,
                runtimeStageId: resumeRuntimeStageId,
                stageName: pausedNode.name,
                depth: 0,
            },
            channel: 'flow',
        };
        if (this.combinedRecorder)
            this.combinedRecorder.onResume(flowResumeEvent);
        for (const r of this.flowRecorders)
            r.onResume?.(flowResumeEvent);
        const scopeResumeEvent = {
            stageName: pausedNode.name,
            stageId: pausedNode.id,
            runtimeStageId: buildRuntimeStageId(pausedNode.id, this._executionCounter.value),
            hasInput,
            pipelineId: '',
            timestamp: Date.now(),
            channel: 'scope',
        };
        for (const r of this.scopeRecorders)
            r.onResume?.(scopeResumeEvent);
        // Deferred tier (RFC-001): these executor-synthesized onResume events
        // bypass the per-stage dispatch sites, so capture them directly.
        if (this.deferredTier) {
            this.deferredTier.capture('flow', 'onResume', resumeRuntimeStageId, this._currentRunId, flowResumeEvent);
            this.deferredTier.capture('scope', 'onResume', scopeResumeEvent.runtimeStageId, scopeResumeEvent.pipelineId, scopeResumeEvent);
        }
        // Set AFTER all sync validation/lookup throws above (nothing can leak the
        // flag); no await between the top-of-method check and here, so race-free.
        this._isExecuting = true;
        try {
            const result = await this.traverser.execute();
            // Terminal flush (RFC-001 Block 8) — same boundary contract as run().
            this.deferredTier?.terminalFlush();
            return result;
        }
        catch (error) {
            this.deferredTier?.terminalFlush();
            if (isPauseSignal(error)) {
                this.lastCheckpoint = this.buildPauseCheckpoint(error);
                return { paused: true, checkpoint: this.lastCheckpoint };
            }
            throw error;
        }
        finally {
            this._isExecuting = false;
        }
    }
    /**
     * Build a fully DETACHED checkpoint from a caught PauseSignal.
     *
     * Every field is deep-copied via one `structuredClone` of the assembled
     * checkpoint, because the raw pieces alias live engine state:
     *
     *   - `sharedState` IS `SharedMemory`'s internal context object — the alias
     *     only detaches at the next commit (`applySmartMerge` rebuilds it), and
     *     after a pause there is no next commit until resume.
     *   - `executionTree` nodes are fresh, but their `logs`/`errors`/`metrics`/
     *     `evals`/`stageReads`/`flowMessages` fields reference live
     *     `DiagnosticCollector` bags that keep accumulating on same-executor
     *     resume.
     *   - `subflowStates` values are shallow copies whose NESTED objects alias
     *     subflow memory, and they get seeded back into live runtimes on resume.
     *   - `subflowResults` values stay referenced by the traverser's results map.
     *
     * The checkpoint is persisted by contract ("store in Redis/Postgres") — it
     * must never share structure with the engine. Pause is not a hot path; the
     * clone cost is irrelevant.
     *
     * The JSON-safe checkpoint contract (no functions, no class instances)
     * governs CONSUMER-owned data — but the executionTree's diagnostic bags
     * accept ANY value at write time without cloning ($debug/$error/$metric/
     * $eval store raw references), so a contract-compliant run can still carry
     * a non-cloneable diagnostic. Observability side-bags never abort traversal
     * anywhere else in the library, so they must not abort the pause either:
     * on clone failure we sanitize the diagnostic bags (non-cloneable values
     * become '[non-serializable: …]' markers — the live engine bags are never
     * touched) and retry. If the retry STILL fails, the violation is in
     * consumer-owned data (realistically `pauseData` — a function can never
     * reach shared state in the first place: TransactionBuffer clones every
     * written value at write time, so the offending write already rejected)
     * and we throw a DESCRIPTIVE contract error naming the offending
     * checkpoint field(s). A naked DataCloneError never escapes.
     *
     * Subflow scope capture (`subflowStates`) survives ONLY on the signal — the
     * nested runtimes are GC'd as the stack unwinds. Promoting it onto the
     * checkpoint here lets cross-executor resume restore pre-pause subflow
     * scope (e.g. an Agent's `scope.history`). Empty `{}` for root-level pauses.
     */
    buildPauseCheckpoint(signal) {
        const snapshot = this.traverser.getSnapshot();
        const sfResults = this.traverser.getSubflowResults();
        // Lean subflowResults for the checkpoint (design: docs/design/subflow-commit-visibility.md):
        //   • DROP the per-iteration mount-runtimeStageId keys ('#') that the snapshot dual-keys —
        //     they would DOUBLE the checkpoint, and resume restores scope from `subflowStates`, not these.
        //   • STRIP each subflow's `treeContext.history` — resume NEVER reads `subflowResults` (it
        //     restores from `subflowStates` + `sharedState`), so the per-subflow commit log is pure
        //     checkpoint bloat. The flat agent's checkpoint carries no commit history either → symmetric.
        const leanSubflowResults = {};
        for (const [key, value] of sfResults) {
            if (key.includes('#'))
                continue; // per-iteration keys are snapshot-only
            const v = value;
            if (v?.treeContext) {
                const treeCtxRest = {};
                for (const ck of Object.keys(v.treeContext)) {
                    if (ck !== 'history')
                        treeCtxRest[ck] = v.treeContext[ck]; // strip the per-subflow commit log
                }
                leanSubflowResults[key] = { ...value, treeContext: treeCtxRest };
            }
            else {
                leanSubflowResults[key] = value;
            }
        }
        const checkpoint = {
            sharedState: snapshot.sharedState,
            executionTree: snapshot.executionTree,
            pausedStageId: signal.stageId,
            subflowPath: signal.subflowPath,
            pauseData: signal.pauseData,
            subflowStates: signal.subflowStates,
            // Counter continuity — seeded back in resume() so runtimeStageIds stay
            // unique and loopIteration stays monotonic across a CROSS-executor resume
            // (both are plain number/record, so they ride the single structuredClone
            // below untouched). See test/lib/pause/resume-execution-counter-continuity.test.ts.
            executionCount: this._executionCounter.value,
            visitCounts: Object.fromEntries(this._visitCounts),
            ...(Object.keys(leanSubflowResults).length > 0 && { subflowResults: leanSubflowResults }),
            // Invoker context — collected during traversal bubble-up (not tree-walked)
            ...(signal.invokerStageId && { invokerStageId: signal.invokerStageId }),
            ...(signal.continuationStageId && { continuationStageId: signal.continuationStageId }),
            pausedAt: Date.now(),
        };
        try {
            return structuredClone(checkpoint);
        }
        catch {
            // Non-cloneable diagnostics must not swallow the pause — sanitize the
            // executionTree's bags (markers replace the offenders) and retry.
            try {
                checkpoint.executionTree = sanitizeDiagnosticBags(checkpoint.executionTree);
                return structuredClone(checkpoint);
            }
            catch (retryError) {
                // Genuine JSON-safe contract violation in consumer-owned data.
                throw describeCheckpointCloneFailure(checkpoint, retryError);
            }
        }
    }
    /**
     * Find a StageNode in the compiled graph by ID.
     * Handles subflow paths by drilling into registered subflows.
     */
    findNodeInGraph(stageId, subflowPath) {
        const fc = this.flowChartArgs.flowChart;
        if (subflowPath.length === 0) {
            // Top-level: DFS from root
            return this.dfsFind(fc.root, stageId);
        }
        // Subflow: drill into the subflow chain, then search from the last subflow's root
        let subflowRoot;
        for (const sfId of subflowPath) {
            const subflow = fc.subflows?.[sfId];
            if (!subflow)
                return undefined;
            subflowRoot = subflow.root;
        }
        if (!subflowRoot)
            return undefined;
        return this.dfsFind(subflowRoot, stageId);
    }
    /**
     * Find the mount node (the node that mounts a subflow boundary)
     * for a given subflowId, by DFS from `start`. Used by `resume()` to
     * locate the OUTER node we have to enter through so the subflow's
     * outputMapper and parent continuation execute.
     *
     * Cycle-safe via visited set. Returns the first match (DFS order).
     */
    findMountInGraph(start, subflowId, visited = new Set()) {
        if (start.isLoopRef)
            return undefined;
        if (visited.has(start.id))
            return undefined;
        visited.add(start.id);
        if (start.subflowId === subflowId)
            return start;
        if (start.children) {
            for (const child of start.children) {
                const found = this.findMountInGraph(child, subflowId, visited);
                if (found)
                    return found;
            }
        }
        if (start.next)
            return this.findMountInGraph(start.next, subflowId, visited);
        return undefined;
    }
    /** DFS search for a node by ID in the StageNode graph. Cycle-safe via visited set. */
    dfsFind(node, targetId, visited = new Set()) {
        // Skip loop back-edge references (they share the target's ID but have no fn/resumeFn)
        if (node.isLoopRef)
            return undefined;
        if (visited.has(node.id))
            return undefined;
        visited.add(node.id);
        if (node.id === targetId)
            return node;
        if (node.children) {
            for (const child of node.children) {
                const found = this.dfsFind(child, targetId, visited);
                if (found)
                    return found;
            }
        }
        if (node.next)
            return this.dfsFind(node.next, targetId, visited);
        return undefined;
    }
    // ─── ScopeRecorder Management ───
    /**
     * Attach a scope ScopeRecorder to observe data operations (reads, writes, commits).
     * Automatically attached to every ScopeFacade created during traversal.
     * Must be called before run().
     *
     * **Idempotent by ID:** If a recorder with the same `id` is already attached,
     * it is replaced (not duplicated). This prevents double-counting when both
     * a framework and the user attach the same recorder type.
     *
     * Built-in recorders use auto-increment IDs (`metrics-1`, `debug-1`, ...) by
     * default, so multiple instances with different configs coexist. To override
     * a framework-attached recorder, pass the same well-known ID.
     *
     * @example
     * ```typescript
     * // Multiple recorders with different configs — each gets a unique ID
     * executor.attachScopeRecorder(new MetricRecorder());
     * executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'minimal' }));
     *
     * // Override a framework-attached recorder by passing its well-known ID
     * executor.attachScopeRecorder(new MetricRecorder('metrics'));
     *
     * // Attaching twice with same ID replaces (no double-counting)
     * executor.attachScopeRecorder(new MetricRecorder('my-metrics'));
     * executor.attachScopeRecorder(new MetricRecorder('my-metrics')); // replaces previous
     * ```
     *
     * **Delivery tier (RFC-001):** pass `{ delivery: 'deferred' }` to take the
     * recorder out of the engine's hot path — events are captured into a
     * bounded queue and delivered at the next microtask checkpoint ("one beat
     * behind"). Omitting `delivery` keeps the historical synchronous call,
     * byte-identical to previous releases. Re-attaching the same `id` with a
     * different tier SWAPS tiers cleanly — never double delivery. See
     * `docs/guides/observers-deferred.md`.
     */
    attachScopeRecorder(recorder, options) {
        // Tier swap, both directions: an id lives on exactly ONE tier per list.
        this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== recorder.id);
        if (options?.delivery === 'deferred') {
            this.ensureDeferredTier(options).register(recorder, { scope: true }, options);
            return;
        }
        this.deferredTier?.removeFromLists(recorder.id, { scope: true });
        this.scopeRecorders.push(recorder);
    }
    /**
     * Lazily create the executor's ONE deferred-observer tier (one merged
     * queue, total event order across all three channels). The FIRST deferred
     * attach's options configure the dispatcher; later differing options are
     * dev-warned and ignored (see `AttachRecorderOptions`).
     */
    ensureDeferredTier(options) {
        if (!this.deferredTier)
            this.deferredTier = new DeferredObserverTier(options);
        return this.deferredTier;
    }
    // ─── Detach (T4) ─────────────────────────────────────────────────────────
    //
    // Bare-executor entry point for fire-and-forget child flowchart execution.
    // Use from outside any chart (consumer code that wants to detach work
    // without first running a parent chart). For detach FROM INSIDE a stage,
    // use `scope.$detachAndJoinLater(...)` / `scope.$detachAndForget(...)` —
    // those mint refIds from the calling stage's runtimeStageId for trace
    // correlation; the bare-executor entries use a synthetic prefix
    // (`__executor__`) instead.
    /**
     * Detach a child flowchart on the given driver and return a `DetachHandle`
     * the caller can `wait()` on (Promise) or read `.status` from (sync).
     *
     * The driver is a REQUIRED first argument — there is no library-default,
     * to keep the engine free of driver imports and to make the choice of
     * scheduling algorithm explicit at the call site.
     *
     * @example
     * ```typescript
     * import { microtaskBatchDriver } from 'footprintjs/detach';
     *
     * const exec = new FlowChartExecutor(parentChart);
     * const handle = exec.detachAndJoinLater(microtaskBatchDriver, telemetryChart, { event: 'x' });
     * await handle.wait(); // optional
     * ```
     */
    detachAndJoinLater(driver, child, input) {
        return _detachAndJoinLater(driver, child, input, '__executor__');
    }
    /**
     * Detach a child flowchart on the given driver and DISCARD the handle.
     * Use for telemetry exports / fire-and-forget side effects where the
     * caller doesn't care about the result.
     *
     * Errors raised by the child still land on the (discarded) handle — they
     * go silent unless surfaced through a recorder. For observable detach,
     * prefer `detachAndJoinLater` and surface failures via `.wait().catch()`.
     */
    detachAndForget(driver, child, input) {
        _detachAndForget(driver, child, input, '__executor__');
    }
    /** Detach all scope Recorders with the given ID — both delivery tiers. */
    detachScopeRecorder(id) {
        this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== id);
        this.deferredTier?.removeFromLists(id, { scope: true });
    }
    /** Returns a defensive copy of attached scope Recorders (both tiers). */
    getScopeRecorders() {
        return [...this.scopeRecorders, ...(this.deferredTier?.scopeListRecorders() ?? [])];
    }
    // ─── FlowRecorder Management ───
    /**
     * Attach a FlowRecorder to observe control flow events.
     * Automatically enables narrative if not already enabled.
     * Must be called before run() — recorders are passed to the traverser at creation time.
     *
     * **Idempotent by ID:** replaces existing recorder with same `id`.
     *
     * **Delivery tier (RFC-001):** pass `{ delivery: 'deferred' }` for
     * next-checkpoint delivery off the hot path — see `attachScopeRecorder`.
     */
    attachFlowRecorder(recorder, options) {
        // Tier swap, both directions: an id lives on exactly ONE tier per list.
        this.flowRecorders = this.flowRecorders.filter((r) => r.id !== recorder.id);
        this.narrativeEnabled = true;
        if (options?.delivery === 'deferred') {
            this.ensureDeferredTier(options).register(recorder, { flow: true }, options);
            return;
        }
        this.deferredTier?.removeFromLists(recorder.id, { flow: true });
        this.flowRecorders.push(recorder);
    }
    /** Detach all FlowRecorders with the given ID — both delivery tiers. */
    detachFlowRecorder(id) {
        this.flowRecorders = this.flowRecorders.filter((r) => r.id !== id);
        this.deferredTier?.removeFromLists(id, { flow: true });
    }
    /** Returns a defensive copy of attached FlowRecorders (both tiers). */
    getFlowRecorders() {
        return [...this.flowRecorders, ...(this.deferredTier?.flowListRecorders() ?? [])];
    }
    // ─── Combined ScopeRecorder Management ───
    /**
     * Attach a recorder that may observe multiple event streams (scope
     * data-flow, control-flow, or both). Detects at runtime which streams the
     * recorder has methods for and routes it to the correct internal channels.
     *
     * Preferred over calling `attachScopeRecorder` and `attachFlowRecorder`
     * separately, because forgetting one of the two is a silent foot-gun —
     * half your events never fire and there is no runtime warning. With
     * `attachCombinedRecorder` the library guarantees the recorder's declared
     * methods all fire, and adds no overhead versus two explicit calls.
     *
     * ## Idempotency
     *
     * Idempotent by `id` across ALL channels — re-attaching with the same `id`
     * replaces the previous instance everywhere it was registered. Mixing
     * `attachCombinedRecorder(x)` with a prior `attachScopeRecorder(y)` or
     * `attachFlowRecorder(y)` that share `x.id === y.id` is also safe: the
     * combined attach replaces the single-channel registration on whichever
     * channel(s) `x` has methods for. No duplicate firings occur.
     *
     * ## Narrative activation
     *
     * If the recorder has any control-flow methods, `enableNarrative()` is
     * called as a side effect (the narrative subsystem is required to emit
     * control-flow events). Data-flow-only recorders do NOT activate the
     * narrative.
     *
     * ## Detection rule
     *
     * Only **own** event methods count (see `hasRecorderMethods`). Methods
     * inherited via the prototype chain are ignored — this protects against
     * accidental `Object.prototype` pollution attaching handlers you never
     * declared. A recorder that provides only `clear`/`toSnapshot` is a
     * no-op and emits a dev-mode warning to surface the likely mistake.
     *
     * @example
     * ```typescript
     * const audit: CombinedRecorder = {
     *   id: 'audit',
     *   onWrite: (e) => log('scope write', e.key),
     *   onDecision: (e) => log('routed to', e.chosen),
     * };
     * executor.attachCombinedRecorder(audit);
     * ```
     */
    attachCombinedRecorder(recorder, options) {
        const hasData = hasRecorderMethods(recorder);
        const hasFlow = hasFlowRecorderMethods(recorder);
        const hasEmit = hasEmitRecorderMethods(recorder);
        // Delivery tier (RFC-001): options bag OR the recorder's own
        // `delivery: 'deferred'` field. The field is a string — channel routing
        // above counts event-METHOD properties only, so declaring it never
        // changes which channels the recorder lands on.
        const delivery = options?.delivery ?? recorder.delivery;
        const tierOptions = delivery === undefined ? options : { ...options, delivery };
        // Emit recorders live on the SAME channel as data-flow recorders
        // (ScopeFacade iterates `_recorders` for onEmit dispatch). So
        // attachEmitRecorder internally calls attachScopeRecorder — but we want to
        // avoid double-attach when the recorder implements BOTH onEmit AND
        // other ScopeRecorder methods. Short-circuit: if hasData OR hasEmit, the
        // recorder lands on the scope-recorder list exactly once.
        if (hasData || hasEmit)
            this.attachScopeRecorder(recorder, tierOptions);
        if (hasFlow)
            this.attachFlowRecorder(recorder, tierOptions);
        if (!hasData && !hasFlow && !hasEmit && isDevMode()) {
            // Dev-mode only: silent skips are invisible and produce hard-to-debug
            // "why didn't my recorder fire" reports. Per library convention, gated
            // on the central isDevMode() flag (not process.env) so consumers can
            // control dev tooling centrally via enableDevMode()/disableDevMode().
            // eslint-disable-next-line no-console
            console.warn(`[footprintjs] attachCombinedRecorder: recorder '${recorder.id}' has ` +
                'no observer event methods — nothing to attach. Did you forget to ' +
                'add an on* handler (onWrite, onDecision, onSubflowEntry, ...)? ' +
                'Note: only OWN properties count; methods on the prototype chain ' +
                'are ignored on purpose.');
        }
    }
    /**
     * Detach a combined recorder from all channels it was attached to.
     * Safe to call if the recorder was only on one channel or never attached.
     */
    detachCombinedRecorder(id) {
        this.detachScopeRecorder(id);
        this.detachFlowRecorder(id);
    }
    // ─── Emit ScopeRecorder Management (Phase 3) ───
    /**
     * Attach an `EmitRecorder` — an observer for consumer-emitted structured
     * events fired via `scope.$emit(name, payload)`.
     *
     * Internally, emit recorders share the scope-recorder channel because
     * emit events fire from inside `ScopeFacade` during stage execution,
     * same timing as `onRead`/`onWrite`. This method is a convenience that
     * delegates to `attachScopeRecorder` — consumers can also use
     * `attachScopeRecorder` directly for a recorder that implements BOTH
     * `onWrite` and `onEmit`. Either approach places the recorder on the
     * same underlying list, so `onEmit` fires exactly once per event.
     *
     * **Idempotent by `id`:** replaces existing recorder with same `id`.
     *
     * @example
     * ```typescript
     * executor.attachEmitRecorder({
     *   id: 'token-meter',
     *   onEmit: (e) => {
     *     if (e.name === 'agentfootprint.llm.tokens') trackTokens(e.payload);
     *   },
     * });
     * ```
     */
    attachEmitRecorder(recorder, options) {
        this.attachScopeRecorder(recorder, options);
    }
    /** Detach an `EmitRecorder` by id. Safe to call if never attached. */
    detachEmitRecorder(id) {
        this.detachScopeRecorder(id);
    }
    /**
     * Returns a defensive copy of attached recorders (both delivery tiers)
     * filtered to those that implement `onEmit`. Useful for inspection during
     * testing.
     */
    getEmitRecorders() {
        return this.getScopeRecorders().filter((r) => typeof r.onEmit === 'function');
    }
    /**
     * Returns structured narrative entries — the single public narrative API.
     * Each entry has a type (stage, step, condition, fork, etc.), text, and
     * depth. Consumers render however they want; call `.map(e => e.text)`
     * if a flat `string[]` is needed locally.
     */
    getNarrativeEntries() {
        if (this.combinedRecorder) {
            return this.combinedRecorder.getEntries();
        }
        const flowSentences = this.traverser.getNarrative();
        return flowSentences.map((text) => ({ type: 'stage', text, depth: 0 }));
    }
    /**
     * Returns the combined FlowRecorders list. When narrative is enabled,
     * includes the CombinedNarrativeRecorder (which builds merged flow+data
     * entries inline). Plus any user-attached recorders.
     */
    buildFlowRecordersList() {
        const recorders = [];
        if (this.combinedRecorder) {
            recorders.push(this.combinedRecorder);
        }
        recorders.push(...this.flowRecorders);
        // Deferred-observer flow tap (RFC-001 Block 7) — captures every flow
        // event for deferred listeners. Appended like any other flow recorder,
        // so the FlowRecorderDispatcher site needs no tier logic of its own.
        const flowTap = this.deferredTier?.buildFlowTap();
        if (flowTap)
            recorders.push(flowTap);
        return recorders.length > 0 ? recorders : undefined;
    }
    /**
     * Execute the chart. Resolves when the run finishes — or pauses, if a
     * pausable stage returned data (check `isPaused()` afterward).
     *
     * @param options `{ input, env }` — `input` is the frozen business input
     *   (read in a stage via `scope.$getArgs()`); `env` is infrastructure context
     *   like `{ signal, timeoutMs, traceId }` (read via `scope.$getEnv()`).
     *
     * After it resolves, read results off the executor:
     * - `getSnapshot()` — full state, commit log, execution tree.
     * - `getNarrativeEntries()` — the plain-English trace (call `enableNarrative()`
     *   or attach a `narrative()` recorder first).
     * - `isPaused()` — true if a stage paused; then use `getCheckpoint()` / `resume()`.
     *
     * One run at a time per executor — it holds per-run state (runId, recorders,
     * checkpoint). Create one executor per concurrent run.
     */
    async run(options) {
        // Re-entrancy guard FIRST — before clearing recorders or touching any
        // per-run field, so a rejected concurrent call leaves the in-flight run
        // completely untouched.
        if (this._isExecuting) {
            throw new Error('FlowChartExecutor: run() called while another run()/resume() is in flight on this ' +
                'executor. An executor holds per-run state (runId, recorders, checkpoint) — create ' +
                'one executor per concurrent run. See docs/guides/execution-model.md.');
        }
        // Validate input against inputSchema if both are present. Validation runs
        // BEFORE the timeout timer is created so a rejected input can't leak a
        // pending timer (same "failed entry leaves no side effects" rule as the
        // re-entrancy guard above).
        let validatedInput = options?.input;
        if (validatedInput && this.flowChartArgs.flowChart.inputSchema) {
            validatedInput = validateInput(this.flowChartArgs.flowChart.inputSchema, validatedInput);
        }
        let signal = options?.signal;
        let timeoutId;
        // Create an internal AbortController for timeoutMs
        if (options?.timeoutMs && !signal) {
            const controller = new AbortController();
            signal = controller.signal;
            timeoutId = setTimeout(() => controller.abort(new Error(`Execution timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
        }
        // User-attached recorders (flowRecorders + scopeRecorders) are cleared via clear() to prevent
        // cross-run accumulation. The combinedRecorder is NOT cleared here — createTraverser() always
        // creates a fresh CombinedNarrativeRecorder instance on each run, so stale state is never an issue.
        for (const r of this.flowRecorders) {
            r.clear?.();
        }
        for (const r of this.scopeRecorders) {
            r.clear?.();
        }
        this.deferredTier?.clearRecorders();
        this.lastCheckpoint = undefined;
        this._executionCounter = { value: 0 }; // Reset counter on fresh run
        this._visitCounts = new Map(); // Reset loop-iteration counts on fresh run (twin of _executionCounter)
        this._currentRunId = generateRunId(); // Fresh runId per run() call
        this._hasRunBefore = true; // mark so a later resume() takes the
        // same-executor branch (reuse runtime, accumulate execution tree).
        this.traverser = this.createTraverser(signal, validatedInput, options?.env, options?.maxDepth, options?.maxIterations);
        // Set AFTER all sync validation throws (nothing above can leak the flag);
        // no await between the top-of-method check and here, so this is race-free.
        this._isExecuting = true;
        try {
            const result = await this.traverser.execute();
            // Terminal flush (RFC-001 Block 8) at the RESOLVE boundary: every
            // captured-but-undelivered observer event is delivered synchronously
            // before run() returns — "one beat behind" never becomes "lost at exit".
            this.deferredTier?.terminalFlush();
            return result;
        }
        catch (error) {
            // Terminal flush at the PAUSE and REJECT boundaries — this is the
            // OUTERMOST handler (a pause re-throws through subflow traversers
            // without exit events, so per-traverser hooks would miss it). Runs
            // before the checkpoint is exposed and before the error reaches the
            // caller.
            this.deferredTier?.terminalFlush();
            if (isPauseSignal(error)) {
                // Build a detached checkpoint from current execution state — see
                // buildPauseCheckpoint() for the deep-copy rationale.
                this.lastCheckpoint = this.buildPauseCheckpoint(error);
                // Return a PauseResult-shaped value so callers can check without try/catch
                return { paused: true, checkpoint: this.lastCheckpoint };
            }
            throw error;
        }
        finally {
            this._isExecuting = false;
            if (timeoutId !== undefined)
                clearTimeout(timeoutId);
        }
    }
    /**
     * Flush the deferred-observer backlog, then await async listener
     * completions under a deadline (RFC-001 Block 8 — the serverless /
     * graceful-shutdown pattern: call before the process freezes or exits so
     * "one beat behind" work is not lost). Resolves immediately with zeros
     * when no deferred observer was ever attached. `pending === 0` means a
     * full drain; a non-zero `pending` reports continuations (plus any queued
     * events) still outstanding at the deadline — honest, never silent.
     */
    drainObservers(opts) {
        if (!this.deferredTier)
            return Promise.resolve({ done: 0, failed: 0, pending: 0 });
        return this.deferredTier.drain(opts);
    }
    // ─── Introspection ───
    /**
     * Returns the runtime snapshot.
     *
     * @param options.redact  When `true`, `sharedState` comes from the parallel
     *   redacted mirror (if maintained — see `setRedactionPolicy`). This is
     *   the safe view for exporting traces externally (paste into a viewer,
     *   share with support). When no redaction policy is configured the
     *   redacted mirror is not maintained, so this flag is a no-op —
     *   `sharedState` is the raw working memory either way. Default `false`.
     *
     *   The commit log is already redacted at write-time regardless of this
     *   flag, and the execution tree carries only structural metadata.
     *
     * **Treat `sharedState` as READ-ONLY.** In production it is a live view of
     * the engine's working memory (zero copy cost) — mutating it corrupts
     * engine state. In dev mode (`enableDevMode()`) it is a deep-frozen CLONE,
     * so any consumer mutation throws loudly instead of corrupting silently.
     */
    getSnapshot(options) {
        const snapshot = this.traverser.getSnapshot(options);
        if (isDevMode()) {
            // Dev-mode mutation guard: freeze a CLONE, never the live engine
            // state — `snapshot.sharedState` aliases SharedMemory's internal
            // context until the next commit rebuilds it (post-run: forever).
            // Production stays zero-copy; clone-always is a measured decision
            // deferred until the bench says it's affordable (BACKLOG #8).
            // NOTE: deepFreeze (reused from readonlyInput) freezes plain objects/
            // arrays only — Map/Set INTERNALS stay mutable (`map.set()` on the
            // frozen clone won't throw). The CLONE still isolates the engine.
            snapshot.sharedState = deepFreeze(structuredClone(snapshot.sharedState));
        }
        const sfResults = this.traverser.getSubflowResults();
        if (sfResults.size > 0) {
            snapshot.subflowResults = Object.fromEntries(sfResults);
        }
        // Collect snapshot data from recorders that implement toSnapshot()
        const recorderSnapshots = [];
        for (const r of this.scopeRecorders) {
            if (r.toSnapshot) {
                const snap = r.toSnapshot();
                recorderSnapshots.push({
                    id: r.id,
                    name: snap.name,
                    description: snap.description,
                    preferredOperation: snap.preferredOperation,
                    data: snap.data,
                });
            }
        }
        for (const r of this.flowRecorders) {
            if (r.toSnapshot) {
                const snap = r.toSnapshot();
                recorderSnapshots.push({
                    id: r.id,
                    name: snap.name,
                    description: snap.description,
                    preferredOperation: snap.preferredOperation,
                    data: snap.data,
                });
            }
        }
        if (this.deferredTier) {
            // Deferred recorders are attached observers too — collect their
            // snapshots once per id (a combined recorder registers once in the
            // tier, unlike the two inline lists).
            const seen = new Set();
            for (const r of [...this.deferredTier.scopeListRecorders(), ...this.deferredTier.flowListRecorders()]) {
                if (seen.has(r.id))
                    continue;
                seen.add(r.id);
                if (r.toSnapshot) {
                    const snap = r.toSnapshot();
                    recorderSnapshots.push({
                        id: r.id,
                        name: snap.name,
                        description: snap.description,
                        preferredOperation: snap.preferredOperation,
                        data: snap.data,
                    });
                }
            }
        }
        if (recorderSnapshots.length > 0) {
            snapshot.recorders = recorderSnapshots;
        }
        // RFC-001 Block 9: the deferred-observer accounting surface. Present
        // ONLY when a deferred observer was attached on this executor —
        // zero-cost discipline for everyone else.
        if (this.deferredTier) {
            snapshot.observerStats = this.deferredTier.getStats();
        }
        return snapshot;
    }
    /** @internal */
    getRuntime() {
        return this.traverser.getRuntime();
    }
    /** @internal */
    setRootObject(path, key, value) {
        this.traverser.setRootObject(path, key, value);
    }
    /** @internal */
    getBranchIds() {
        return this.traverser.getBranchIds();
    }
    /** @internal */
    getRuntimeRoot() {
        return this.traverser.getRuntimeRoot();
    }
    /** @internal */
    getRuntimeStructure() {
        return this.traverser.getRuntimeStructure();
    }
    /** @internal */
    getSubflowResults() {
        return this.traverser.getSubflowResults();
    }
    /**
     * Returns the subflow manifest from an attached ManifestFlowRecorder.
     * Returns empty array if no ManifestFlowRecorder is attached.
     */
    getSubflowManifest() {
        const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder);
        return recorder?.getManifest() ?? [];
    }
    /**
     * Returns the full spec for a dynamically-registered subflow.
     * Requires an attached ManifestFlowRecorder that observed the registration.
     */
    getSubflowSpec(subflowId) {
        const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder);
        return recorder?.getSpec(subflowId);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd0NoYXJ0RXhlY3V0b3IuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3J1bm5lci9GbG93Q2hhcnRFeGVjdXRvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FpQkc7QUFHSCxPQUFPLEVBQUUsZUFBZSxJQUFJLGdCQUFnQixFQUFFLGtCQUFrQixJQUFJLG1CQUFtQixFQUFFLE1BQU0sb0JBQW9CLENBQUM7QUFFcEgsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE1BQU0sa0RBQWtELENBQUM7QUFHN0YsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sdURBQXVELENBQUM7QUFFN0YsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFDbEUsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sMkNBQTJDLENBQUM7QUFDL0UsT0FBTyxFQVVMLGFBQWEsR0FDZCxNQUFNLG9CQUFvQixDQUFDO0FBUzVCLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUVsRCxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsc0JBQXNCLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQ0FBaUMsQ0FBQztBQUVySCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sNEJBQTRCLENBQUM7QUFDdkQsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLHNDQUFzQyxDQUFDO0FBRWxFLE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUV0RCxPQUFPLEVBQUUsOEJBQThCLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUNqRyxPQUFPLEVBQXdELG9CQUFvQixFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFDdkgsT0FBTyxFQUErQyxnQkFBZ0IsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ3RHLE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxZQUFZLENB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QUFDLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDakQsQ0FBQztJQUVELGdCQUFnQjtJQUNoQixZQUFZO1FBQ1YsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksRUFBRSxDQUFDO0lBQ3ZDLENBQUM7SUFFRCxnQkFBZ0I7SUFDaEIsY0FBYztRQUNaLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxjQUFjLEVBQUUsQ0FBQztJQUN6QyxDQUFDO0lBRUQsZ0JBQWdCO0lBQ2hCLG1CQUFtQjtRQUNqQixPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsbUJBQW1CLEVBQUUsQ0FBQztJQUM5QyxDQUFDO0lBRUQsZ0JBQWdCO0lBQ2hCLGlCQUFpQjtRQUNmLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO0lBQzVDLENBQUM7SUFFRDs7O09BR0c7SUFDSCxrQkFBa0I7UUFDaEIsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsWUFBWSxvQkFBb0IsQ0FFcEUsQ0FBQztRQUNkLE9BQU8sUUFBUSxFQUFFLFdBQVcsRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUN2QyxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsY0FBYyxDQUFDLFNBQWlCO1FBQzlCLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLFlBQVksb0JBQW9CLENBRXBFLENBQUM7UUFDZCxPQUFPLFFBQVEsRUFBRSxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDdEMsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBGbG93Q2hhcnRFeGVjdXRvciDigJQgUHVibGljIEFQSSBmb3IgZXhlY3V0aW5nIGEgY29tcGlsZWQgRmxvd0NoYXJ0LlxuICpcbiAqIFdyYXBzIEZsb3djaGFydFRyYXZlcnNlci4gQnVpbGQgYSBjaGFydCB3aXRoIGZsb3dDaGFydCgpIGFuZCBwYXNzIHRoZSByZXN1bHQgaGVyZTpcbiAqXG4gKiAgIGNvbnN0IGNoYXJ0ID0gZmxvd0NoYXJ0KCdlbnRyeScsIGVudHJ5Rm4pLmFkZEZ1bmN0aW9uKCdwcm9jZXNzJywgcHJvY2Vzc0ZuKS5idWlsZCgpO1xuICpcbiAqICAgLy8gTm8tb3B0aW9ucyBmb3JtICh1c2VzIGF1dG8tZGV0ZWN0ZWQgVHlwZWRTY29wZSBmYWN0b3J5IGZyb20gdGhlIGNoYXJ0KTpcbiAqICAgY29uc3QgZXhlY3V0b3IgPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQpO1xuICpcbiAqICAgLy8gT3B0aW9ucy1vYmplY3QgZm9ybSAocHJlZmVycmVkIHdoZW4geW91IG5lZWQgdG8gY3VzdG9taXplIGJlaGF2aW9yKTpcbiAqICAgY29uc3QgZXhlY3V0b3IgPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIHsgc2NvcGVGYWN0b3J5OiBteUZhY3RvcnkgfSk7XG4gKlxuICogICAvLyAyLXBhcmFtIGZvcm0gKGFjY2VwdHMgYSBTY29wZUZhY3RvcnkgZGlyZWN0bHksIGZvciBiYWNrd2FyZCBjb21wYXRpYmlsaXR5KTpcbiAqICAgY29uc3QgZXhlY3V0b3IgPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIG15RmFjdG9yeSk7XG4gKlxuICogICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRvci5ydW4oeyBpbnB1dDogZGF0YSwgZW52OiB7IHRyYWNlSWQ6ICdyZXEtMTIzJyB9IH0pO1xuICovXG5cbmltcG9ydCB0eXBlIHsgRmxvd0NoYXJ0IH0gZnJvbSAnLi4vYnVpbGRlci90eXBlcy5qcyc7XG5pbXBvcnQgeyBkZXRhY2hBbmRGb3JnZXQgYXMgX2RldGFjaEFuZEZvcmdldCwgZGV0YWNoQW5kSm9pbkxhdGVyIGFzIF9kZXRhY2hBbmRKb2luTGF0ZXIgfSBmcm9tICcuLi9kZXRhY2gvc3Bhd24uanMnO1xuaW1wb3J0IHR5cGUgeyBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyT3B0aW9ucyB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlci5qcyc7XG5pbXBvcnQgeyBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyIH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS9Db21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgQ29tYmluZWROYXJyYXRpdmVFbnRyeSB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvbmFycmF0aXZlVHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBNYW5pZmVzdEVudHJ5IH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS9yZWNvcmRlcnMvTWFuaWZlc3RGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHsgTWFuaWZlc3RGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL3JlY29yZGVycy9NYW5pZmVzdEZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dSZWNvcmRlciB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHsgYnVpbGRSdW50aW1lU3RhZ2VJZCB9IGZyb20gJy4uL2VuZ2luZS9ydW50aW1lU3RhZ2VJZC5qcyc7XG5pbXBvcnQgeyBGbG93Y2hhcnRUcmF2ZXJzZXIgfSBmcm9tICcuLi9lbmdpbmUvdHJhdmVyc2FsL0Zsb3djaGFydFRyYXZlcnNlci5qcyc7XG5pbXBvcnQge1xuICB0eXBlIEV4ZWN1dG9yUmVzdWx0LFxuICB0eXBlIFBhdXNlZFJlc3VsdCxcbiAgdHlwZSBSdW5PcHRpb25zLFxuICB0eXBlIFNjb3BlRmFjdG9yeSxcbiAgdHlwZSBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsXG4gIHR5cGUgU3RhZ2VOb2RlLFxuICB0eXBlIFN0cmVhbUhhbmRsZXJzLFxuICB0eXBlIFN1YmZsb3dSZXN1bHQsXG4gIHR5cGUgVHJhdmVyc2FsUmVzdWx0LFxuICBkZWZhdWx0TG9nZ2VyLFxufSBmcm9tICcuLi9lbmdpbmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUge1xuICBDb21taXRWYWx1ZXNNb2RlLFxuICBSZWFkVHJhY2tpbmdNb2RlLFxuICBTdGFnZVNuYXBzaG90LFxuICBXcml0ZVByb3ZlbmFuY2VNb2RlLFxuICBXcml0ZVRyYWNraW5nTW9kZSxcbn0gZnJvbSAnLi4vbWVtb3J5L3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd2NoYXJ0Q2hlY2twb2ludCwgUGF1c2VTaWduYWwgfSBmcm9tICcuLi9wYXVzZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlU2lnbmFsIH0gZnJvbSAnLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBDb21iaW5lZFJlY29yZGVyIH0gZnJvbSAnLi4vcmVjb3JkZXIvQ29tYmluZWRSZWNvcmRlci5qcyc7XG5pbXBvcnQgeyBoYXNFbWl0UmVjb3JkZXJNZXRob2RzLCBoYXNGbG93UmVjb3JkZXJNZXRob2RzLCBoYXNSZWNvcmRlck1ldGhvZHMgfSBmcm9tICcuLi9yZWNvcmRlci9Db21iaW5lZFJlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgRW1pdFJlY29yZGVyIH0gZnJvbSAnLi4vcmVjb3JkZXIvRW1pdFJlY29yZGVyLmpzJztcbmltcG9ydCB7IGlzRGV2TW9kZSB9IGZyb20gJy4uL3Njb3BlL2RldGVjdENpcmN1bGFyLmpzJztcbmltcG9ydCB7IGRlZXBGcmVlemUgfSBmcm9tICcuLi9zY29wZS9wcm90ZWN0aW9uL3JlYWRvbmx5SW5wdXQuanMnO1xuaW1wb3J0IHR5cGUgeyBTY29wZVByb3RlY3Rpb25Nb2RlIH0gZnJvbSAnLi4vc2NvcGUvcHJvdGVjdGlvbi90eXBlcy5qcyc7XG5pbXBvcnQgeyBTY29wZUZhY2FkZSB9IGZyb20gJy4uL3Njb3BlL1Njb3BlRmFjYWRlLmpzJztcbmltcG9ydCB0eXBlIHsgUmVkYWN0aW9uUG9saWN5LCBSZWRhY3Rpb25SZXBvcnQsIFNjb3BlUmVjb3JkZXIgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBkZXNjcmliZUNoZWNrcG9pbnRDbG9uZUZhaWx1cmUsIHNhbml0aXplRGlhZ25vc3RpY0JhZ3MgfSBmcm9tICcuL2NoZWNrcG9pbnRTYW5pdGl6ZS5qcyc7XG5pbXBvcnQgeyB0eXBlIEF0dGFjaFJlY29yZGVyT3B0aW9ucywgdHlwZSBPYnNlcnZlckRyYWluUmVzdWx0LCBEZWZlcnJlZE9ic2VydmVyVGllciB9IGZyb20gJy4vRGVmZXJyZWRPYnNlcnZlclRpZXIuanMnO1xuaW1wb3J0IHsgdHlwZSBSZWNvcmRlclNuYXBzaG90LCB0eXBlIFJ1bnRpbWVTbmFwc2hvdCwgRXhlY3V0aW9uUnVudGltZSB9IGZyb20gJy4vRXhlY3V0aW9uUnVudGltZS5qcyc7XG5pbXBvcnQgeyBnZW5lcmF0ZVJ1bklkIH0gZnJvbSAnLi9ydW5JZC5qcyc7XG5pbXBvcnQgeyB2YWxpZGF0ZUlucHV0IH0gZnJvbSAnLi92YWxpZGF0ZUlucHV0LmpzJztcblxuLyoqIERlZmF1bHQgc2NvcGUgZmFjdG9yeSDigJQgY3JlYXRlcyBhIHBsYWluIFNjb3BlRmFjYWRlIGZvciBlYWNoIHN0YWdlLiAqL1xuY29uc3QgZGVmYXVsdFNjb3BlRmFjdG9yeTogU2NvcGVGYWN0b3J5ID0gKGN0eCwgc3RhZ2VOYW1lLCByZWFkT25seSwgZW52KSA9PlxuICBuZXcgU2NvcGVGYWNhZGUoY3R4LCBzdGFnZU5hbWUsIHJlYWRPbmx5LCBlbnYpO1xuXG4vKipcbiAqIE9wdGlvbnMgb2JqZWN0IGZvciBgRmxvd0NoYXJ0RXhlY3V0b3JgIOKAlCBwcmVmZXJyZWQgb3ZlciBwb3NpdGlvbmFsIHBhcmFtcy5cbiAqXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBjb25zdCBleCA9IG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCwge1xuICogICBzY29wZUZhY3Rvcnk6IG15RmFjdG9yeSxcbiAqICAgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQ6IHsgLi4uIH0sXG4gKiB9KTtcbiAqIGBgYFxuICpcbiAqICoqU3luYyBub3RlIGZvciBtYWludGFpbmVyczoqKiBFdmVyeSBmaWVsZCBhZGRlZCBoZXJlIG11c3QgYWxzbyBhcHBlYXIgaW4gdGhlXG4gKiBgZmxvd0NoYXJ0QXJnc2AgcHJpdmF0ZSBmaWVsZCB0eXBlIGFuZCBpbiB0aGUgY29uc3RydWN0b3IncyBvcHRpb25zLXJlc29sdXRpb25cbiAqIGJsb2NrICh0aGUgYGVsc2UgaWZgIGJyYW5jaCB0aGF0IHJlYWRzIGZyb20gYG9wdHNgKS4gTWlzc2luZyBhbnkgb25lIG9mIHRoZVxuICogdGhyZWUgY2F1c2VzIHNpbGVudCBvbWlzc2lvbiDigJQgdGhlIG9wdGlvbiBpcyBhY2NlcHRlZCBidXQgbmV2ZXIgYXBwbGllZC5cbiAqXG4gKiAqKlRTY29wZSBpbmZlcmVuY2Ugbm90ZToqKiBXaGVuIHVzaW5nIHRoZSBvcHRpb25zLW9iamVjdCBmb3JtIHdpdGggYSBjdXN0b20gc2NvcGUsXG4gKiBUeXBlU2NyaXB0IGNhbm5vdCBpbmZlciBgVFNjb3BlYCB0aHJvdWdoIHRoZSBvcHRpb25zIG9iamVjdC4gUGFzcyB0aGUgdHlwZVxuICogZXhwbGljaXRseTogYG5ldyBGbG93Q2hhcnRFeGVjdXRvcjxUT3V0LCBNeVNjb3BlPihjaGFydCwgeyBzY29wZUZhY3RvcnkgfSlgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEZsb3dDaGFydEV4ZWN1dG9yT3B0aW9uczxUU2NvcGUgPSBhbnk+IHtcbiAgLy8g4pSA4pSAIENvbW1vbiBvcHRpb25zIChtb3N0IGNhbGxlcnMgbmVlZCBvbmx5IHRoZXNlKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQ3VzdG9tIHNjb3BlIGZhY3RvcnkuIERlZmF1bHRzIHRvIFR5cGVkU2NvcGUgb3IgU2NvcGVGYWNhZGUgYXV0by1kZXRlY3Rpb24uICovXG4gIHNjb3BlRmFjdG9yeT86IFNjb3BlRmFjdG9yeTxUU2NvcGU+O1xuXG4gIC8vIOKUgOKUgCBDb250ZXh0IG9wdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIERlZmF1bHQgdmFsdWVzIHByZS1wb3B1bGF0ZWQgaW50byB0aGUgc2hhcmVkIGNvbnRleHQgYmVmb3JlICoqZWFjaCoqIHN0YWdlXG4gICAqIChyZS1hcHBsaWVkIGV2ZXJ5IHN0YWdlLCBhY3RpbmcgYXMgYmFzZWxpbmUgZGVmYXVsdHMpLlxuICAgKi9cbiAgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQ/OiB1bmtub3duO1xuICAvKipcbiAgICogSW5pdGlhbCBjb250ZXh0IHZhbHVlcyBtZXJnZWQgaW50byB0aGUgc2hhcmVkIGNvbnRleHQgKipvbmNlKiogYXQgc3RhcnR1cFxuICAgKiAoYXBwbGllZCBiZWZvcmUgdGhlIGZpcnN0IHN0YWdlLCBub3QgcmVwZWF0ZWQgb24gc3Vic2VxdWVudCBzdGFnZXMpLlxuICAgKiBEaXN0aW5jdCBmcm9tIGBkZWZhdWx0VmFsdWVzRm9yQ29udGV4dGAsIHdoaWNoIGlzIHJlLWFwcGxpZWQgZXZlcnkgc3RhZ2UuXG4gICAqL1xuICBpbml0aWFsQ29udGV4dD86IHVua25vd247XG4gIC8qKiBSZWFkLW9ubHkgaW5wdXQgYWNjZXNzaWJsZSB2aWEgYHNjb3BlLmdldEFyZ3MoKWAg4oCUIG5ldmVyIHRyYWNrZWQgb3Igd3JpdHRlbi4gKi9cbiAgcmVhZE9ubHlDb250ZXh0PzogdW5rbm93bjtcblxuICAvLyDilIDilIAgT2JzZXJ2YWJpbGl0eSBjb3N0IG9wdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFBvbGljeSBmb3IgYFN0YWdlU25hcHNob3Quc3RhZ2VSZWFkc2AgKCMxNCkuIERlZmF1bHQgYCdmdWxsJ2Ag4oCUIGV2ZXJ5XG4gICAqIHRyYWNrZWQgcmVhZCBgc3RydWN0dXJlZENsb25lYHMgdGhlIHZhbHVlIGludG8gdGhlIHN0YWdlJ3MgcmVhZCB2aWV3XG4gICAqICh0aGUgaGlzdG9yaWNhbCBiZWhhdmlvcjsgd2hhdCBsZW5zL2FnZW50Zm9vdHByaW50IHNuYXBzaG90cyBzaG93KS5cbiAgICogYCdzdW1tYXJ5J2AgcmVjb3JkcyBhIGNoZWFwIHR5cGUvc2l6ZS9wcmV2aWV3IG1hcmtlciBwZXIgcmVhZDsgYCdvZmYnYFxuICAgKiByZWNvcmRzIG5vdGhpbmcg4oCUIHplcm8gcGVyLXJlYWQgY2xvbmUgY29zdCAocmVhZHMgb2YgbGFyZ2UgdmFsdWVzIGJlY29tZVxuICAgKiB+ZnJlZSkuIE5hcnJhdGl2ZSBhbmQgYFNjb3BlUmVjb3JkZXIub25SZWFkYCBhcmUgaWRlbnRpY2FsIGluIGV2ZXJ5IG1vZGUuXG4gICAqIENhdmVhdDogdW5kZXIgYCdvZmYnYCBhIHN0YWdlJ3Mgc25hcHNob3QgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBvbmVcbiAgICogdGhhdCByZWFkIG5vdGhpbmcg4oCUIGF1ZGl0aW5nIGNvbnN1bWVycyB0aGF0IG5lZWQgXCJkaWQgaXQgcmVhZD9cIiB3aXRob3V0XG4gICAqIHRoZSB2YWx1ZSBjb3N0IHNob3VsZCBwcmVmZXIgYCdzdW1tYXJ5J2AuXG4gICAqIEVxdWl2YWxlbnQgdG8gY2FsbGluZyBgZXhlY3V0b3Iuc2V0UmVhZFRyYWNraW5nKG1vZGUpYCBiZWZvcmUgYHJ1bigpYC5cbiAgICovXG4gIHJlYWRUcmFja2luZz86IFJlYWRUcmFja2luZ01vZGU7XG5cbiAgLyoqXG4gICAqIFBvbGljeSBmb3IgYFN0YWdlU25hcHNob3Quc3RhZ2VXcml0ZXNgICgjMTNjLUEpIOKAlCB0aGUgc2libGluZyBvZlxuICAgKiB7QGxpbmsgcmVhZFRyYWNraW5nfTsgdGhlIHR3byBkaWFscyBhcmUgaW5kZXBlbmRlbnQuIERlZmF1bHQgYCdmdWxsJ2Ag4oCUXG4gICAqIGV2ZXJ5IHRyYWNrZWQgd3JpdGUgYHN0cnVjdHVyZWRDbG9uZWBzIHRoZSB2YWx1ZSBpbnRvIHRoZSBzdGFnZSdzIHdyaXRlXG4gICAqIHZpZXcgKHRoZSBoaXN0b3JpY2FsIGJlaGF2aW9yKS4gYCdzdW1tYXJ5J2AgcmVjb3JkcyBhIGNoZWFwXG4gICAqIGBXcml0ZVN1bW1hcnlNYXJrZXJgICh0eXBlL3NpemUvcHJldmlldykgcGVyIHdyaXRlOyBgJ29mZidgIHJlY29yZHNcbiAgICogbm90aGluZyDigJQgYHN0YWdlV3JpdGVzYCBpcyBhYnNlbnQgZnJvbSB0aGUgc25hcHNob3QuXG4gICAqXG4gICAqIE9ic2VydmFibGUgY29uc2VxdWVuY2VzIOKAlCB3aGF0IHRoZSBwb2xpY3kgRE9FUyBnb3Zlcm46XG4gICAqIC0gYFN0YWdlU25hcHNob3Quc3RhZ2VXcml0ZXNgIChtYXJrZXJzIHVuZGVyIGAnc3VtbWFyeSdgLCBhYnNlbnQgdW5kZXJcbiAgICogICBgJ29mZidgKS5cbiAgICogLSBUaGUgY29tbWl0IG9ic2VydmVyIHBheWxvYWQ6IGBTY29wZVJlY29yZGVyLm9uQ29tbWl0KG11dGF0aW9ucylgXG4gICAqICAgcmVjZWl2ZXMgdGhlIHJldGFpbmVkIGBfc3RhZ2VXcml0ZXNgIGVudHJpZXMsIHNvIGl0IGNhcnJpZXMgdGhlIHNhbWVcbiAgICogICBtYXJrZXJzIHVuZGVyIGAnc3VtbWFyeSdgIGFuZCBhbiBlbXB0eSBtdXRhdGlvbnMgYmFnIHVuZGVyIGAnb2ZmJ2Ag4oCUXG4gICAqICAgZGVmZXJyZWQvb2JzZXJ2ZXIgY29uc3VtZXJzIHNlZSBleGFjdGx5IHdoYXQgcmV0ZW50aW9uIHN0b3JlZC5cbiAgICpcbiAgICogV2hhdCBpdCBkb2VzIE5PVCBnb3Zlcm46XG4gICAqIC0gVGhlIHdyaXRlcyB0aGVtc2VsdmVzOiBzaGFyZWQgc3RhdGUsIHRoZSB0cmFuc2FjdGlvbiBidWZmZXIsIGFuZCB0aGVcbiAgICogICBDT01NSVQgTE9HIGFyZSBpZGVudGljYWwgaW4gZXZlcnkgbW9kZSAoY29tbWl0TG9nIHZhbHVlcyBrZWVwIHRoZWlyXG4gICAqICAgZnVsbCBwYXlsb2FkcyDigJQgdGhlIGxvc3NsZXNzIGxpbmVhci1jb3N0IGZpeCBmb3IgdGhvc2UgaXMgdGhlXG4gICAqICAge0BsaW5rIGNvbW1pdFZhbHVlc30gZGlhbCwgIzEzYy1CKS5cbiAgICogLSBQZXItb3AgYFNjb3BlUmVjb3JkZXIub25Xcml0ZWAgZXZlbnRzIOKAlCB0aGV5IGZpcmUgd2l0aCBsaXZlIHZhbHVlc1xuICAgKiAgIHJlZ2FyZGxlc3MgKGRlbGl2ZXJ5IHRpZXIsIFJGQy0wMDEncyBjb25jZXJuKSwgc28gbmFycmF0aXZlIG91dHB1dCBpc1xuICAgKiAgIGlkZW50aWNhbCBpbiBldmVyeSBtb2RlLlxuICAgKiAtIFJlZGFjdGlvbjogYSBwb2xpY3kvcGVyLWNhbGwtcmVkYWN0ZWQgd3JpdGUgc3RvcmVzIGAnW1JFREFDVEVEXSdgXG4gICAqICAgdW5kZXIgYCdmdWxsJ2AgQU5EIGAnc3VtbWFyeSdgIChyZWRhY3Rpb24gdGFrZXMgcHJlY2VkZW5jZSBvdmVyIHRoZVxuICAgKiAgIGRpYWw7IGEgbWFya2VyIHdvdWxkIGxlYWsgc2l6ZS9wcmV2aWV3KSwgYW5kIG5vdGhpbmcgdW5kZXIgYCdvZmYnYC5cbiAgICpcbiAgICogQ2F2ZWF0OiB1bmRlciBgJ29mZidgIGEgc3RhZ2UncyBTTkFQU0hPVCBpcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIG9uZVxuICAgKiB0aGF0IHdyb3RlIG5vdGhpbmcg4oCUIGJ1dCB1bmxpa2UgYHJlYWRUcmFja2luZzogJ29mZidgLCB0aGUgY29tbWl0IGxvZ1xuICAgKiBzdGlsbCByZWNvcmRzIGV2ZXJ5IG5ldCBjaGFuZ2UsIHNvIFwiZGlkIGl0IHdyaXRlP1wiIHN0YXlzIGFuc3dlcmFibGUuXG4gICAqIEVxdWl2YWxlbnQgdG8gY2FsbGluZyBgZXhlY3V0b3Iuc2V0V3JpdGVUcmFja2luZyhtb2RlKWAgYmVmb3JlIGBydW4oKWAuXG4gICAqL1xuICB3cml0ZVRyYWNraW5nPzogV3JpdGVUcmFja2luZ01vZGU7XG5cbiAgLyoqXG4gICAqIEVuY29kaW5nIHBvbGljeSBmb3IgQ09NTUlUIExPRyB2YWx1ZXMgKCMxM2MtQikg4oCUIHRoZSB0aGlyZCBkaWFsIG9mIHRoZVxuICAgKiBmYW1pbHksIGFuZCB1bmxpa2UgaXRzIHNpYmxpbmdzIGl0IGlzICoqbG9zc2xlc3MgaW4gYm90aCBtb2RlcyoqIChpdFxuICAgKiBjaGFuZ2VzIHRoZSBsb2cncyBlbmNvZGluZywgbmV2ZXIgaXRzIGluZm9ybWF0aW9uKS5cbiAgICpcbiAgICogLSBgJ2Z1bGwnYCAoZGVmYXVsdCkg4oCUIGV2ZXJ5IHN1cnZpdmluZyBgc2V0YCBwYXRoIHN0b3JlcyB0aGUgZnVsbCBmaW5hbFxuICAgKiAgIHZhbHVlOyBieXRlLWlkZW50aWNhbCB0byB0aGUgaGlzdG9yaWNhbCBiZWhhdmlvci5cbiAgICogLSBgJ2RlbHRhJ2Ag4oCUIGFycmF5IG5ldC1jaGFuZ2VzIHRoYXQgYXJlIFwiYmFzZSBwbHVzIGEgdGFpbFwiIGNvbW1pdCBhcyBhblxuICAgKiAgIGBhcHBlbmRgIHRyYWNlIHZlcmIgc3RvcmluZyBPTkxZIHRoZSB0YWlsICh0aGUgZ3Jvd2luZy1oaXN0b3J5IGNvbW1pdFxuICAgKiAgIGxvZyBiZWNvbWVzIGxpbmVhciBpbnN0ZWFkIG9mIE8oTsKyKSByZXRhaW5lZCk7IGBkZWxldGVWYWx1ZSgpYCBjb21taXRzXG4gICAqICAgYXMgYSByZWFsIGBkZWxldGVgIHZlcmIgKHJlcGxheSByZW1vdmVzIHRoZSBrZXkgaW5zdGVhZCBvZiBsZWF2aW5nXG4gICAqICAgYGtleTogdW5kZWZpbmVkYCk7IGJ1bmRsZXMgY2FycnkgZXhhY3RseSBPTkUgdHJhY2UgZW50cnkgcGVyIHN1cnZpdmluZ1xuICAgKiAgIHBhdGguIFJlcGxheSAoYGFwcGx5U21hcnRNZXJnZWAg4oCUIGxpdmUgc3RhdGUsIGBtYXRlcmlhbGlzZSgpYCwgdGhlXG4gICAqICAgcmVkYWN0ZWQgbWlycm9yKSByZWNvbnN0cnVjdHMgZXZlcnkgc3RlcCdzIGZ1bGwgc3RhdGUgZXhhY3RseS5cbiAgICpcbiAgICogQ29uc3VtZXJzIHRoYXQgcmVhZCBgYnVuZGxlLm92ZXJ3cml0ZVtrZXldYCBhcyBcInRoZSBmdWxsIHZhbHVlIHdyaXR0ZW5cIlxuICAgKiBtdXN0IHN3aXRjaCB0byBgY29tbWl0VmFsdWVBdChjb21taXRMb2csIGlkeCwga2V5KWAgZnJvbVxuICAgKiBgZm9vdHByaW50anMvdHJhY2VgIOKAlCB1bmRlciBgJ2RlbHRhJ2AgdGhhdCB2YWx1ZSBpcyB2ZXJiLXF1YWxpZmllZCAoYW5cbiAgICogYGFwcGVuZGAgYnVuZGxlIGhvbGRzIG9ubHkgdGhlIHRhaWwpLiBQYXRoLXRpZXIgY29uc3VtZXJzXG4gICAqIChgZmluZExhc3RXcml0ZXJgLCBgY2F1c2FsQ2hhaW5gLCBuYXJyYXRpdmUsIGxlbnMgaGlnaGxpZ2h0cykgYXJlXG4gICAqIHVuYWZmZWN0ZWQuIFRoZSBhY3RpdmUgbW9kZSBpcyBzdXJmYWNlZCBhc1xuICAgKiBgZ2V0U25hcHNob3QoKS5jb21taXRWYWx1ZXNgLlxuICAgKlxuICAgKiBIb25lc3QgY29zdCBub3RlOiBhcHBlbmQgZGV0ZWN0aW9uIGlzIG5ldyB3YWxsIHdvcmsg4oCUIGFuIE8ofGJhc2UgYXJyYXl8KVxuICAgKiBzdHJ1Y3R1cmFsIHByZWZpeCBjb21wYXJlIHBlciBhcnJheS1zZXQgcGF0aCBwZXIgY29tbWl0LiBPbiBhIGhpdCB0aGVcbiAgICogY29tbWl0IGdldHMgY2hlYXBlciBpbiBib3RoIHdhbGwgYW5kIGhlYXA7IG9uIGEgbWlzcyAocHJlZml4IGRpdmVyZ2VzKVxuICAgKiBpdCBwYXlzIGNvbXBhcmUgKyBmdWxsIGNsb25lLiBgJ2Z1bGwnYCBwYXlzIHplcm8uXG4gICAqIEVxdWl2YWxlbnQgdG8gY2FsbGluZyBgZXhlY3V0b3Iuc2V0Q29tbWl0VmFsdWVzKG1vZGUpYCBiZWZvcmUgYHJ1bigpYC5cbiAgICovXG4gIGNvbW1pdFZhbHVlcz86IENvbW1pdFZhbHVlc01vZGU7XG5cbiAgLyoqXG4gICAqIFBlci13cml0ZSByZWFkIHByb3ZlbmFuY2UgKCNQMSkg4oCUIHRoZSBmb3VydGggZGlhbCBvZiB0aGUgZmFtaWx5LiBEZWZhdWx0XG4gICAqIGAnb2ZmJ2A6IHplcm8gY29zdCwgYnl0ZS1pZGVudGljYWwgY29tbWl0IGxvZ3MuIGAncmVhZHMtcHJlZml4J2A6IGV2ZXJ5XG4gICAqIGNvbW1pdHRlZCBgVHJhY2VFbnRyeWAgY2FycmllcyBgcmVhZEtleXNgIOKAlCB0aGUga2V5cyB0cmFja2VkLXJlYWQgQkVGT1JFXG4gICAqIHRoYXQgd3JpdGUg4oCUIGVuYWJsaW5nIHBlci13cml0ZSBjYXVzYWwgYXR0cmlidXRpb24gKGBjYXVzYWxDaGFpbmAnc1xuICAgKiBgZWRnZUF0dHJpYnV0aW9uOiAncGVyLXdyaXRlJ2AgYW5kIHZhcmlhYmxlIHNsaWNlcykuIENvc3Q6IG9uZSBzbWFsbFxuICAgKiBhcnJheSBjb3B5IHBlciB3cml0ZS4gU25hcHNob3QgZGlzY3JpbWluYW50OlxuICAgKiBgZ2V0U25hcHNob3QoKS53cml0ZVByb3ZlbmFuY2VgLlxuICAgKi9cbiAgd3JpdGVQcm92ZW5hbmNlPzogV3JpdGVQcm92ZW5hbmNlTW9kZTtcblxuICAvLyDilIDilIAgQWR2YW5jZWQgLyBlc2NhcGUtaGF0Y2ggb3B0aW9ucyAobW9zdCBjYWxsZXJzIGRvIG5vdCBuZWVkIHRoZXNlKSDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQ3VzdG9tIGVycm9yIGNsYXNzaWZpZXIgZm9yIHRocm90dGxpbmcgZGV0ZWN0aW9uLiBSZXR1cm4gYHRydWVgIGlmIHRoZVxuICAgKiBlcnJvciByZXByZXNlbnRzIGEgcmF0ZS1saW1pdCBvciBiYWNrcHJlc3N1cmUgY29uZGl0aW9uICh0aGUgZXhlY3V0b3Igd2lsbFxuICAgKiB0cmVhdCBpdCBkaWZmZXJlbnRseSBmcm9tIGhhcmQgZmFpbHVyZXMpLiBEZWZhdWx0cyB0byBubyB0aHJvdHRsaW5nIGNsYXNzaWZpY2F0aW9uLlxuICAgKi9cbiAgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlcj86IChlcnJvcjogdW5rbm93bikgPT4gYm9vbGVhbjtcbiAgLyoqIEhhbmRsZXJzIGZvciBzdHJlYW1pbmcgc3RhZ2UgbGlmZWN5Y2xlIGV2ZW50cyAoc2VlIGBhZGRTdHJlYW1pbmdGdW5jdGlvbmApLiAqL1xuICBzdHJlYW1IYW5kbGVycz86IFN0cmVhbUhhbmRsZXJzO1xuICAvKiogU2NvcGUgcHJvdGVjdGlvbiBtb2RlIGZvciBUeXBlZFNjb3BlIGRpcmVjdC1hc3NpZ25tZW50IGRldGVjdGlvbi4gKi9cbiAgc2NvcGVQcm90ZWN0aW9uTW9kZT86IFNjb3BlUHJvdGVjdGlvbk1vZGU7XG59XG5cbmV4cG9ydCBjbGFzcyBGbG93Q2hhcnRFeGVjdXRvcjxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcHJpdmF0ZSB0cmF2ZXJzZXI6IEZsb3djaGFydFRyYXZlcnNlcjxUT3V0LCBUU2NvcGU+O1xuICAvKiogU2hhcmVkIGV4ZWN1dGlvbiBjb3VudGVyIOKAlCBzdXJ2aXZlcyBwYXVzZS9yZXN1bWUuIFJlc2V0IG9uIGZyZXNoIHJ1bigpLiAqL1xuICBwcml2YXRlIF9leGVjdXRpb25Db3VudGVyID0geyB2YWx1ZTogMCB9O1xuICAvKiogU2hhcmVkIHBlci1ydW4gdmlzaXQgY291bnRzIChieSBzdGFnZUlkKSBkcml2aW5nIFRyYXZlcnNhbENvbnRleHQubG9vcEl0ZXJhdGlvbi5cbiAgICogIFR3aW4gb2YgX2V4ZWN1dGlvbkNvdW50ZXI6IHN1cnZpdmVzIHBhdXNlL3Jlc3VtZSwgcmVzZXQgb24gZnJlc2ggcnVuKCkuICovXG4gIHByaXZhdGUgX3Zpc2l0Q291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLyoqIFBlci1gcnVuKClgIGlkZW50aWZpZXIg4oCUIGdlbmVyYXRlZCBmcmVzaCBwZXIgcnVuICsgcGVyIHJlc3VtZS4gVGhyZWFkZWRcbiAgICogIHRocm91Z2ggZXZlcnkgVHJhdmVyc2FsQ29udGV4dCBzbyByZWNvcmRlcnMgY2FuIHNjb3BlIHN0YXRlIHRvIGEgc2luZ2xlXG4gICAqICBydW4uIFNlZSBgcnVuSWQudHNgLiAqL1xuICBwcml2YXRlIF9jdXJyZW50UnVuSWQgPSAnJztcbiAgcHJpdmF0ZSBuYXJyYXRpdmVFbmFibGVkID0gZmFsc2U7XG4gIHByaXZhdGUgbmFycmF0aXZlT3B0aW9ucz86IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXJPcHRpb25zO1xuICBwcml2YXRlIGNvbWJpbmVkUmVjb3JkZXI6IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgZmxvd1JlY29yZGVyczogRmxvd1JlY29yZGVyW10gPSBbXTtcbiAgcHJpdmF0ZSBzY29wZVJlY29yZGVyczogU2NvcGVSZWNvcmRlcltdID0gW107XG4gIC8qKlxuICAgKiBSRkMtMDAxIGRlZmVycmVkLW9ic2VydmVyIHdpcmluZyDigJQgY3JlYXRlZCBMQVpJTFkgb24gdGhlIGZpcnN0XG4gICAqIGBkZWxpdmVyeTogJ2RlZmVycmVkJ2AgYXR0YWNoLiBgdW5kZWZpbmVkYCBmb3IgZXZlcnkgZXhlY3V0b3IgdGhhdCBuZXZlclxuICAgKiBvcHRzIGluOiB6ZXJvIGFsbG9jYXRpb24sIHplcm8gcGVyLWV2ZW50IGNvc3QsIGJ5dGUtaWRlbnRpY2FsIGJlaGF2aW9yXG4gICAqICh0aGUgZW1pdCBmYXN0LXBhdGggcHJlY2VkZW50KS5cbiAgICovXG4gIHByaXZhdGUgZGVmZXJyZWRUaWVyPzogRGVmZXJyZWRPYnNlcnZlclRpZXI7XG4gIHByaXZhdGUgcmVkYWN0aW9uUG9saWN5OiBSZWRhY3Rpb25Qb2xpY3kgfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgc2hhcmVkUmVkYWN0ZWRLZXlzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHByaXZhdGUgc2hhcmVkUmVkYWN0ZWRGaWVsZHNCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcbiAgcHJpdmF0ZSBsYXN0Q2hlY2twb2ludDogRmxvd2NoYXJ0Q2hlY2twb2ludCB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGB0cnVlYCBvbmNlIGBydW4oKWAgKG9yIGEgcHJldmlvdXMgYHJlc3VtZSgpYCkgaGFzIGV4ZWN1dGVkIG9uXG4gICAqIHRoaXMgaW5zdGFuY2UuIGByZXN1bWUoKWAgYnJhbmNoZXMgb24gaXQ6XG4gICAqXG4gICAqICAg4oCiIHRydWUgIOKGkiByZXVzZSB0aGUgY29uc3RydWN0b3ItdGltZSBydW50aW1lIChzYW1lLWV4ZWN1dG9yXG4gICAqICAgICAgICAgICAgIGNvbnRpbnVpdHk6IGV4ZWN1dGlvbiB0cmVlLCByZWNvcmRlcnMsIG5hcnJhdGl2ZVxuICAgKiAgICAgICAgICAgICBhY2N1bXVsYXRlIGFjcm9zcyBwYXVzZS9yZXN1bWUgY3ljbGVzKVxuICAgKiAgIOKAoiBmYWxzZSDihpIgc2VlZCBhIGZyZXNoIHJ1bnRpbWUgZnJvbSBgY2hlY2twb2ludC5zaGFyZWRTdGF0ZWBcbiAgICogICAgICAgICAgICAgKGNyb3NzLWV4ZWN1dG9yIC8gY3Jvc3MtcHJvY2VzcyByZXN1bWU6IG5ldyBpbnN0YW5jZVxuICAgKiAgICAgICAgICAgICByZWNvbnN0cnVjdGVkIGZyb20gYSBzZXJpYWxpemVkIGNoZWNrcG9pbnQpXG4gICAqXG4gICAqIFdpdGhvdXQgdGhpcyBmbGFnLCBmcmVzaCBleGVjdXRvcnMgc2lsZW50bHkgZGlzY2FyZGVkIHRoZVxuICAgKiBjaGVja3BvaW50J3Mgc2hhcmVkU3RhdGUgYW5kIHJlc3VtZSBoYW5kbGVycyBjb3VsZG4ndCByZWFkIHByZS1wYXVzZVxuICAgKiBzY29wZS4gU2VlIGB0ZXN0L2xpYi9wYXVzZS9jcm9zcy1leGVjdXRvci1yZXN1bWUudGVzdC50c2AuXG4gICAqL1xuICBwcml2YXRlIF9oYXNSdW5CZWZvcmUgPSBmYWxzZTtcbiAgLyoqXG4gICAqIFJlLWVudHJhbmN5IGd1YXJkLiBgcnVuKClgIGFuZCBgcmVzdW1lKClgIG11dGF0ZSBwZXItcnVuIGluc3RhbmNlIHN0YXRlXG4gICAqICh0cmF2ZXJzZXIsIHJ1bklkLCBleGVjdXRpb24gY291bnRlciwgY2hlY2twb2ludCkgYW5kIGNsZWFyIGF0dGFjaGVkXG4gICAqIHJlY29yZGVycyDigJQgYSBzZWNvbmQgY29uY3VycmVudCBlbnRyeSBvbiB0aGUgU0FNRSBleGVjdXRvciB3b3VsZFxuICAgKiBpbnRlcmxlYXZlIHJ1bklkcyBhbmQgY3Jvc3MtY29udGFtaW5hdGUgcmVjb3JkZXIvbmFycmF0aXZlIHN0YXRlLCBhbmRcbiAgICogYGdldENoZWNrcG9pbnQoKWAgd291bGQgcmV0dXJuIHdoaWNoZXZlciBydW4gcGF1c2VkIGxhc3QuIE9uZSBleGVjdXRvciA9XG4gICAqIG9uZSBpbi1mbGlnaHQgZXhlY3V0aW9uOyBjcmVhdGUgYW4gZXhlY3V0b3IgcGVyIGNvbmN1cnJlbnQgcnVuLlxuICAgKiBTZWUgZG9jcy9ndWlkZXMvZXhlY3V0aW9uLW1vZGVsLm1kLlxuICAgKi9cbiAgcHJpdmF0ZSBfaXNFeGVjdXRpbmcgPSBmYWxzZTtcblxuICAvLyBTWU5DIFJFUVVJUkVEOiBldmVyeSBvcHRpb25hbCBmaWVsZCBoZXJlIG11c3QgbWlycm9yIEZsb3dDaGFydEV4ZWN1dG9yT3B0aW9uc1xuICAvLyBBTkQgYmUgYXNzaWduZWQgaW4gdGhlIGNvbnN0cnVjdG9yJ3Mgb3B0aW9ucy1yZXNvbHV0aW9uIGJsb2NrICh0aGUgYGVsc2UgaWZgIGJyYW5jaCkuXG4gIC8vIEFkZGluZyBhIGZpZWxkIHRvIG9ubHkgb25lIG9mIHRoZSB0aHJlZSBwbGFjZXMgY2F1c2VzIHNpbGVudCBvbWlzc2lvbi5cbiAgcHJpdmF0ZSByZWFkb25seSBmbG93Q2hhcnRBcmdzOiB7XG4gICAgZmxvd0NoYXJ0OiBGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPjtcbiAgICBzY29wZUZhY3Rvcnk6IFNjb3BlRmFjdG9yeTxUU2NvcGU+O1xuICAgIGRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0PzogdW5rbm93bjtcbiAgICBpbml0aWFsQ29udGV4dD86IHVua25vd247XG4gICAgcmVhZE9ubHlDb250ZXh0PzogdW5rbm93bjtcbiAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyPzogKGVycm9yOiB1bmtub3duKSA9PiBib29sZWFuO1xuICAgIHN0cmVhbUhhbmRsZXJzPzogU3RyZWFtSGFuZGxlcnM7XG4gICAgc2NvcGVQcm90ZWN0aW9uTW9kZT86IFNjb3BlUHJvdGVjdGlvbk1vZGU7XG4gICAgcmVhZFRyYWNraW5nPzogUmVhZFRyYWNraW5nTW9kZTtcbiAgICB3cml0ZVRyYWNraW5nPzogV3JpdGVUcmFja2luZ01vZGU7XG4gICAgY29tbWl0VmFsdWVzPzogQ29tbWl0VmFsdWVzTW9kZTtcbiAgICB3cml0ZVByb3ZlbmFuY2U/OiBXcml0ZVByb3ZlbmFuY2VNb2RlO1xuICB9O1xuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBGbG93Q2hhcnRFeGVjdXRvci5cbiAgICpcbiAgICogKipPcHRpb25zIG9iamVjdCBmb3JtKiogKHByZWZlcnJlZCk6XG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogbmV3IEZsb3dDaGFydEV4ZWN1dG9yKGNoYXJ0LCB7IHNjb3BlRmFjdG9yeSwgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQgfSlcbiAgICogYGBgXG4gICAqXG4gICAqICoqMi1wYXJhbSBmb3JtKiogKGFsc28gc3VwcG9ydGVkKTpcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIHNjb3BlRmFjdG9yeSlcbiAgICogYGBgXG4gICAqXG4gICAqIEBwYXJhbSBmbG93Q2hhcnQgLSBUaGUgY29tcGlsZWQgRmxvd0NoYXJ0IHJldHVybmVkIGJ5IGBmbG93Q2hhcnQoLi4uKS5idWlsZCgpYFxuICAgKiBAcGFyYW0gZmFjdG9yeU9yT3B0aW9ucyAtIEEgYFNjb3BlRmFjdG9yeTxUU2NvcGU+YCBPUiBhIGBGbG93Q2hhcnRFeGVjdXRvck9wdGlvbnM8VFNjb3BlPmAgb3B0aW9ucyBvYmplY3QuXG4gICAqL1xuICBjb25zdHJ1Y3RvcihcbiAgICBmbG93Q2hhcnQ6IEZsb3dDaGFydDxUT3V0LCBUU2NvcGU+LFxuICAgIGZhY3RvcnlPck9wdGlvbnM/OiBTY29wZUZhY3Rvcnk8VFNjb3BlPiB8IEZsb3dDaGFydEV4ZWN1dG9yT3B0aW9uczxUU2NvcGU+LFxuICApIHtcbiAgICAvLyBEZXRlY3Qgb3B0aW9ucy1vYmplY3QgZm9ybSB2cyBmYWN0b3J5IGZvcm1cbiAgICBsZXQgc2NvcGVGYWN0b3J5OiBTY29wZUZhY3Rvcnk8VFNjb3BlPiB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQ6IHVua25vd247XG4gICAgbGV0IGluaXRpYWxDb250ZXh0OiB1bmtub3duO1xuICAgIGxldCByZWFkT25seUNvbnRleHQ6IHVua25vd247XG4gICAgbGV0IHRocm90dGxpbmdFcnJvckNoZWNrZXI6ICgoZXJyb3I6IHVua25vd24pID0+IGJvb2xlYW4pIHwgdW5kZWZpbmVkO1xuICAgIGxldCBzdHJlYW1IYW5kbGVyczogU3RyZWFtSGFuZGxlcnMgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHNjb3BlUHJvdGVjdGlvbk1vZGU6IFNjb3BlUHJvdGVjdGlvbk1vZGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHJlYWRUcmFja2luZzogUmVhZFRyYWNraW5nTW9kZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgd3JpdGVUcmFja2luZzogV3JpdGVUcmFja2luZ01vZGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGNvbW1pdFZhbHVlczogQ29tbWl0VmFsdWVzTW9kZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgd3JpdGVQcm92ZW5hbmNlOiBXcml0ZVByb3ZlbmFuY2VNb2RlIHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKHR5cGVvZiBmYWN0b3J5T3JPcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAvLyAyLXBhcmFtIGZvcm06IG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCwgc2NvcGVGYWN0b3J5KVxuICAgICAgc2NvcGVGYWN0b3J5ID0gZmFjdG9yeU9yT3B0aW9ucztcbiAgICB9IGVsc2UgaWYgKGZhY3RvcnlPck9wdGlvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gT3B0aW9ucyBvYmplY3QgZm9ybVxuICAgICAgY29uc3Qgb3B0cyA9IGZhY3RvcnlPck9wdGlvbnM7XG4gICAgICBzY29wZUZhY3RvcnkgPSBvcHRzLnNjb3BlRmFjdG9yeTtcbiAgICAgIGRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0ID0gb3B0cy5kZWZhdWx0VmFsdWVzRm9yQ29udGV4dDtcbiAgICAgIGluaXRpYWxDb250ZXh0ID0gb3B0cy5pbml0aWFsQ29udGV4dDtcbiAgICAgIHJlYWRPbmx5Q29udGV4dCA9IG9wdHMucmVhZE9ubHlDb250ZXh0O1xuICAgICAgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlciA9IG9wdHMudGhyb3R0bGluZ0Vycm9yQ2hlY2tlcjtcbiAgICAgIHN0cmVhbUhhbmRsZXJzID0gb3B0cy5zdHJlYW1IYW5kbGVycztcbiAgICAgIHNjb3BlUHJvdGVjdGlvbk1vZGUgPSBvcHRzLnNjb3BlUHJvdGVjdGlvbk1vZGU7XG4gICAgICByZWFkVHJhY2tpbmcgPSBvcHRzLnJlYWRUcmFja2luZztcbiAgICAgIHdyaXRlVHJhY2tpbmcgPSBvcHRzLndyaXRlVHJhY2tpbmc7XG4gICAgICBjb21taXRWYWx1ZXMgPSBvcHRzLmNvbW1pdFZhbHVlcztcbiAgICAgIHdyaXRlUHJvdmVuYW5jZSA9IG9wdHMud3JpdGVQcm92ZW5hbmNlO1xuICAgIH1cbiAgICB0aGlzLmZsb3dDaGFydEFyZ3MgPSB7XG4gICAgICBmbG93Q2hhcnQsXG4gICAgICBzY29wZUZhY3Rvcnk6IHNjb3BlRmFjdG9yeSA/PyBmbG93Q2hhcnQuc2NvcGVGYWN0b3J5ID8/IChkZWZhdWx0U2NvcGVGYWN0b3J5IGFzIFNjb3BlRmFjdG9yeTxUU2NvcGU+KSxcbiAgICAgIGRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0LFxuICAgICAgaW5pdGlhbENvbnRleHQsXG4gICAgICByZWFkT25seUNvbnRleHQsXG4gICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyLFxuICAgICAgc3RyZWFtSGFuZGxlcnMsXG4gICAgICBzY29wZVByb3RlY3Rpb25Nb2RlLFxuICAgICAgcmVhZFRyYWNraW5nLFxuICAgICAgd3JpdGVUcmFja2luZyxcbiAgICAgIGNvbW1pdFZhbHVlcyxcbiAgICAgIHdyaXRlUHJvdmVuYW5jZSxcbiAgICB9O1xuICAgIHRoaXMudHJhdmVyc2VyID0gdGhpcy5jcmVhdGVUcmF2ZXJzZXIoKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVHJhdmVyc2VyKFxuICAgIHNpZ25hbD86IEFib3J0U2lnbmFsLFxuICAgIHJlYWRPbmx5Q29udGV4dE92ZXJyaWRlPzogdW5rbm93bixcbiAgICBlbnY/OiBpbXBvcnQoJy4uL2VuZ2luZS90eXBlcy5qcycpLkV4ZWN1dGlvbkVudixcbiAgICBtYXhEZXB0aD86IG51bWJlcixcbiAgICBtYXhJdGVyYXRpb25zPzogbnVtYmVyLFxuICAgIG92ZXJyaWRlcz86IHtcbiAgICAgIHJvb3Q/OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgICAgIGluaXRpYWxDb250ZXh0PzogdW5rbm93bjtcbiAgICAgIHByZXNlcnZlUmVjb3JkZXJzPzogYm9vbGVhbjtcbiAgICAgIGV4aXN0aW5nUnVudGltZT86IEluc3RhbmNlVHlwZTx0eXBlb2YgRXhlY3V0aW9uUnVudGltZT47XG4gICAgICAvKiogUGVyLXN1YmZsb3cgc2NvcGUgY2FwdHVyZXMgZnJvbSBhIGNoZWNrcG9pbnQg4oCUIHBhc3NlZCB0aHJvdWdoXG4gICAgICAgKiAgdG8gSGFuZGxlckRlcHMgc28gU3ViZmxvd0V4ZWN1dG9yIGNhbiByZS1zZWVkIG5lc3RlZCBydW50aW1lc1xuICAgICAgICogIG9uIHRoZSByZXN1bWUgcGF0aC4gVW5kZWZpbmVkIG9uIG5vcm1hbCBydW4oKSBwYXRocy4gKi9cbiAgICAgIHN1YmZsb3dTdGF0ZXNGb3JSZXN1bWU/OiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gICAgICAvKiogUmVzdW1lLW9ubHkgb3ZlcnJpZGUgb2YgdGhlIHN1YmZsb3dzIGRpY3Qg4oCUIHN1YnN0aXR1dGVzIHRoZVxuICAgICAgICogIGxlYWYgc3ViZmxvdydzIHJvb3Qgd2l0aCBhIHJlc3VtZSBjaGFpbiBzbyB0aGUgc3ViZmxvdyBib2R5XG4gICAgICAgKiAgcGlja3MgdXAgYXQgdGhlIHBhdXNlIHBvaW50LiBPdGhlciBlbnRyaWVzIHBhc3MgdGhyb3VnaFxuICAgICAgICogIHVuY2hhbmdlZC4gKi9cbiAgICAgIHN1YmZsb3dzT3ZlcnJpZGU/OiBSZWNvcmQ8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+O1xuICAgIH0sXG4gICk6IEZsb3djaGFydFRyYXZlcnNlcjxUT3V0LCBUU2NvcGU+IHtcbiAgICBjb25zdCBhcmdzID0gdGhpcy5mbG93Q2hhcnRBcmdzO1xuICAgIGNvbnN0IGZjID0gYXJncy5mbG93Q2hhcnQ7XG4gICAgY29uc3QgbmFycmF0aXZlRmxhZyA9IHRoaXMubmFycmF0aXZlRW5hYmxlZCB8fCAoZmMuZW5hYmxlTmFycmF0aXZlID8/IGZhbHNlKTtcblxuICAgIC8vIOKUgOKUgCBDb21wb3NlZCBzY29wZSBmYWN0b3J5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIC8vIENvbGxlY3QgYWxsIHNjb3BlIG1vZGlmaWVycyAocmVjb3JkZXJzLCByZWRhY3Rpb24pIGludG8gYSBzaW5nbGUgbGlzdCxcbiAgICAvLyB0aGVuIGNyZWF0ZSBPTkUgZmFjdG9yeSB0aGF0IGFwcGxpZXMgdGhlbSBpbiBhIGxvb3AuIFJlcGxhY2VzIHRoZVxuICAgIC8vIHByZXZpb3VzIDQtZGVlcCBjbG9zdXJlIG5lc3Rpbmcgd2l0aCBhIGZsYXQsIGRlYnVnZ2FibGUgY29tcG9zaXRpb24uXG5cbiAgICBpZiAob3ZlcnJpZGVzPy5wcmVzZXJ2ZVJlY29yZGVycykge1xuICAgICAgLy8gUmVzdW1lIG1vZGU6IGtlZXAgZXhpc3RpbmcgY29tYmluZWRSZWNvcmRlciBzbyBuYXJyYXRpdmUgYWNjdW11bGF0ZXNcbiAgICB9IGVsc2UgaWYgKG5hcnJhdGl2ZUZsYWcpIHtcbiAgICAgIHRoaXMuY29tYmluZWRSZWNvcmRlciA9IG5ldyBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyKHRoaXMubmFycmF0aXZlT3B0aW9ucyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuY29tYmluZWRSZWNvcmRlciA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICB0aGlzLnNoYXJlZFJlZGFjdGVkS2V5cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIHRoaXMuc2hhcmVkUmVkYWN0ZWRGaWVsZHNCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcblxuICAgIC8vIEJ1aWxkIG1vZGlmaWVyIGxpc3Qg4oCUIGVhY2ggbW9kaWZpZXIgcmVjZWl2ZXMgdGhlIHNjb3BlIGFmdGVyIGNyZWF0aW9uXG4gICAgdHlwZSBTY29wZU1vZGlmaWVyID0gKHNjb3BlOiBhbnkpID0+IHZvaWQ7XG4gICAgY29uc3QgbW9kaWZpZXJzOiBTY29wZU1vZGlmaWVyW10gPSBbXTtcblxuICAgIC8vIDEuIE5hcnJhdGl2ZSByZWNvcmRlciAoaWYgZW5hYmxlZClcbiAgICBpZiAodGhpcy5jb21iaW5lZFJlY29yZGVyKSB7XG4gICAgICBjb25zdCByZWNvcmRlciA9IHRoaXMuY29tYmluZWRSZWNvcmRlcjtcbiAgICAgIG1vZGlmaWVycy5wdXNoKChzY29wZSkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHNjb3BlLmF0dGFjaFNjb3BlUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHNjb3BlLmF0dGFjaFNjb3BlUmVjb3JkZXIocmVjb3JkZXIpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gMi4gVXNlci1wcm92aWRlZCBzY29wZSByZWNvcmRlcnNcbiAgICBpZiAodGhpcy5zY29wZVJlY29yZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCByZWNvcmRlcnMgPSB0aGlzLnNjb3BlUmVjb3JkZXJzO1xuICAgICAgbW9kaWZpZXJzLnB1c2goKHNjb3BlKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2NvcGUuYXR0YWNoU2NvcGVSZWNvcmRlciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGZvciAoY29uc3QgciBvZiByZWNvcmRlcnMpIHNjb3BlLmF0dGFjaFNjb3BlUmVjb3JkZXIocik7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIDJiLiBEZWZlcnJlZC1vYnNlcnZlciBzY29wZSB0YXAgKFJGQy0wMDEgQmxvY2sgNykg4oCUIGEgc3ludGhldGljXG4gICAgLy8gcmVjb3JkZXIgd2hvc2UgaG9va3MgQ0FQVFVSRSBpbnRvIHRoZSBib3VuZGVkIHF1ZXVlIGluc3RlYWQgb2YgZG9pbmdcbiAgICAvLyBvYnNlcnZlciB3b3JrLiBJdCByaWRlcyB0aGUgc2FtZSBwZXItc3RhZ2UgcmVjb3JkZXIgbGlzdCBhcyBpbmxpbmVcbiAgICAvLyByZWNvcmRlcnMsIHNvIGl0IHJlY2VpdmVzIGV4YWN0bHkgdGhlIHBvc3QtcmVkYWN0aW9uIGV2ZW50cyB0aGV5IGRvLlxuICAgIC8vIEFic2VudCAoemVybyB3b3JrLCBpZGVudGljYWwgbGlzdCkgd2hlbiBub2JvZHkgb3B0ZWQgaW50byBkZWZlcnJhbC5cbiAgICBjb25zdCBzY29wZVRhcCA9IHRoaXMuZGVmZXJyZWRUaWVyPy5idWlsZFNjb3BlVGFwKCk7XG4gICAgaWYgKHNjb3BlVGFwKSB7XG4gICAgICBtb2RpZmllcnMucHVzaCgoc2NvcGUpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzY29wZS5hdHRhY2hTY29wZVJlY29yZGVyID09PSAnZnVuY3Rpb24nKSBzY29wZS5hdHRhY2hTY29wZVJlY29yZGVyKHNjb3BlVGFwKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIDMuIFJlZGFjdGlvbiBwb2xpY3kgKGNvbmRpdGlvbmFsIOKAlCBvbmx5IHdoZW4gcG9saWN5IGlzIHNldClcbiAgICBpZiAodGhpcy5yZWRhY3Rpb25Qb2xpY3kpIHtcbiAgICAgIGNvbnN0IHBvbGljeSA9IHRoaXMucmVkYWN0aW9uUG9saWN5O1xuICAgICAgbW9kaWZpZXJzLnB1c2goKHNjb3BlKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2NvcGUudXNlUmVkYWN0aW9uUG9saWN5ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgc2NvcGUudXNlUmVkYWN0aW9uUG9saWN5KHBvbGljeSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gUHJlLXBvcHVsYXRlIGV4ZWN1dG9yLWxldmVsIGZpZWxkIHJlZGFjdGlvbiBtYXAgZnJvbSBwb2xpY3lcbiAgICAgIC8vIHNvIGdldFJlZGFjdGlvblJlcG9ydCgpIGluY2x1ZGVzIGZpZWxkLWxldmVsIHJlZGFjdGlvbnMuXG4gICAgICBpZiAocG9saWN5LmZpZWxkcykge1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIGZpZWxkc10gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5LmZpZWxkcykpIHtcbiAgICAgICAgICB0aGlzLnNoYXJlZFJlZGFjdGVkRmllbGRzQnlLZXkuc2V0KGtleSwgbmV3IFNldChmaWVsZHMpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENvbXBvc2U6IGJhc2UgZmFjdG9yeSArIG1vZGlmaWVycyBpbiBhIHNpbmdsZSBwYXNzLlxuICAgIC8vIFNoYXJlZCByZWRhY3RlZCBrZXlzIGFyZSBBTFdBWVMgd2lyZWQgdXAgKHVuY29uZGl0aW9uYWwg4oCUIGVuc3VyZXMgY3Jvc3Mtc3RhZ2VcbiAgICAvLyBwcm9wYWdhdGlvbiBldmVuIHdpdGhvdXQgYSBwb2xpY3ksIGJlY2F1c2Ugc3RhZ2VzIGNhbiBjYWxsIHNldFZhbHVlKGtleSwgdmFsLCB0cnVlKVxuICAgIC8vIGZvciBwZXItY2FsbCByZWRhY3Rpb24pLiBPcHRpb25hbCBtb2RpZmllcnMgKHJlY29yZGVycywgcG9saWN5KSBhcmUgaW4gdGhlIGxpc3QuXG4gICAgY29uc3QgYmFzZUZhY3RvcnkgPSBhcmdzLnNjb3BlRmFjdG9yeTtcbiAgICBjb25zdCBzaGFyZWRSZWRhY3RlZEtleXMgPSB0aGlzLnNoYXJlZFJlZGFjdGVkS2V5cztcbiAgICBjb25zdCBzY29wZUZhY3RvcnkgPSAoKGN0eDogYW55LCBzdGFnZU5hbWU6IHN0cmluZywgcmVhZE9ubHk/OiB1bmtub3duLCBlbnZBcmc/OiBhbnkpID0+IHtcbiAgICAgIGNvbnN0IHNjb3BlID0gYmFzZUZhY3RvcnkoY3R4LCBzdGFnZU5hbWUsIHJlYWRPbmx5LCBlbnZBcmcpO1xuICAgICAgLy8gQWx3YXlzIHdpcmUgc2hhcmVkIHJlZGFjdGlvbiBzdGF0ZVxuICAgICAgaWYgKHR5cGVvZiAoc2NvcGUgYXMgYW55KS51c2VTaGFyZWRSZWRhY3RlZEtleXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgKHNjb3BlIGFzIGFueSkudXNlU2hhcmVkUmVkYWN0ZWRLZXlzKHNoYXJlZFJlZGFjdGVkS2V5cyk7XG4gICAgICB9XG4gICAgICAvLyBBcHBseSBvcHRpb25hbCBtb2RpZmllcnNcbiAgICAgIGZvciAoY29uc3QgbW9kIG9mIG1vZGlmaWVycykgbW9kKHNjb3BlKTtcbiAgICAgIHJldHVybiBzY29wZTtcbiAgICB9KSBhcyBTY29wZUZhY3Rvcnk8VFNjb3BlPjtcblxuICAgIGNvbnN0IGVmZmVjdGl2ZVJvb3QgPSBvdmVycmlkZXM/LnJvb3QgPz8gZmMucm9vdDtcbiAgICBjb25zdCBlZmZlY3RpdmVJbml0aWFsQ29udGV4dCA9IG92ZXJyaWRlcz8uaW5pdGlhbENvbnRleHQgPz8gYXJncy5pbml0aWFsQ29udGV4dDtcblxuICAgIGxldCBydW50aW1lOiBFeGVjdXRpb25SdW50aW1lO1xuICAgIGlmIChvdmVycmlkZXM/LmV4aXN0aW5nUnVudGltZSkge1xuICAgICAgLy8gUmVzdW1lIG1vZGU6IHJldXNlIGV4aXN0aW5nIHJ1bnRpbWUgc28gZXhlY3V0aW9uIHRyZWUgY29udGludWVzIGZyb20gcGF1c2UgcG9pbnQuXG4gICAgICAvLyBQcmVzZXJ2ZSB0aGUgb3JpZ2luYWwgcm9vdCBmb3IgZ2V0U25hcHNob3QoKSAoZnVsbCB0cmVlKSwgdGhlbiBhZHZhbmNlXG4gICAgICAvLyByb290U3RhZ2VDb250ZXh0IHRvIGEgY29udGludWF0aW9uIGZyb20gdGhlIGxlYWYgKGZvciB0cmF2ZXJzYWwpLlxuICAgICAgcnVudGltZSA9IG92ZXJyaWRlcy5leGlzdGluZ1J1bnRpbWU7XG4gICAgICBydW50aW1lLnByZXNlcnZlU25hcHNob3RSb290KCk7XG4gICAgICBsZXQgbGVhZiA9IHJ1bnRpbWUucm9vdFN0YWdlQ29udGV4dDtcbiAgICAgIHdoaWxlIChsZWFmLm5leHQpIGxlYWYgPSBsZWFmLm5leHQ7XG4gICAgICBydW50aW1lLnJvb3RTdGFnZUNvbnRleHQgPSBsZWFmLmNyZWF0ZU5leHQoJycsIGVmZmVjdGl2ZVJvb3QubmFtZSwgZWZmZWN0aXZlUm9vdC5pZCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJ1bnRpbWUgPSBuZXcgRXhlY3V0aW9uUnVudGltZShcbiAgICAgICAgZWZmZWN0aXZlUm9vdC5uYW1lLFxuICAgICAgICBlZmZlY3RpdmVSb290LmlkLFxuICAgICAgICBhcmdzLmRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0LFxuICAgICAgICBlZmZlY3RpdmVJbml0aWFsQ29udGV4dCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gV2hlbiBhIHJlZGFjdGlvbiBwb2xpY3kgaXMgY29uZmlndXJlZCwgbWFpbnRhaW4gYSBwYXJhbGxlbCByZWRhY3RlZFxuICAgIC8vIG1pcnJvciBvZiBgZ2xvYmFsU3RvcmVgIGR1cmluZyB0cmF2ZXJzYWwuIEVhY2ggY29tbWl0IGFwcGxpZXMgdGhlXG4gICAgLy8gYWxyZWFkeS1jb21wdXRlZCByZWRhY3RlZCBwYXRjaGVzIOKAlCBzYW1lIG9uZXMgZmVkIHRvIHRoZSBldmVudCBsb2cg4oCUXG4gICAgLy8gc28gYGdldFNuYXBzaG90KHsgcmVkYWN0OiB0cnVlIH0pYCByZXR1cm5zIGEgc2NydWJiZWQgc2hhcmVkU3RhdGUgYXRcbiAgICAvLyB6ZXJvIHBvc3QtcGFzcyBjb3N0LiBTa2lwcGVkIHdoZW4gbm8gcG9saWN5IGV4aXN0cyAoemVybyBhbGxvY2F0aW9uKS5cbiAgICBpZiAodGhpcy5yZWRhY3Rpb25Qb2xpY3kpIHtcbiAgICAgIHJ1bnRpbWUuZW5hYmxlUmVkYWN0ZWRNaXJyb3IoKTtcbiAgICB9XG5cbiAgICAvLyBSZWFkLXRyYWNraW5nIHBvbGljeSAoIzE0KTogc2V0IG9uIHRoZSBydW50aW1lJ3Mgcm9vdCBjb250ZXh0IHNvIGV2ZXJ5XG4gICAgLy8gZGVzY2VuZGFudCBjb250ZXh0IChjcmVhdGVOZXh0L2NyZWF0ZUNoaWxkKSBhbmQgc3ViZmxvdyByb290IGluaGVyaXRzLlxuICAgIC8vIEFwcGxpZWQgQUZURVIgdGhlIHJlc3VtZS1wYXRoIHJvb3Qgc3dhcCBhYm92ZSBzbyB0aGUgY29udGludWF0aW9uIHJvb3RcbiAgICAvLyBjYXJyaWVzIHRoZSBwb2xpY3kgdG9vLiBTa2lwcGVkIGZvciB0aGUgZGVmYXVsdCAnZnVsbCcg4oCUIHplcm8gd29yay5cbiAgICBjb25zdCByZWFkVHJhY2tpbmcgPSBhcmdzLnJlYWRUcmFja2luZztcbiAgICBpZiAocmVhZFRyYWNraW5nICE9PSB1bmRlZmluZWQgJiYgcmVhZFRyYWNraW5nICE9PSAnZnVsbCcpIHtcbiAgICAgIHJ1bnRpbWUudXNlUmVhZFRyYWNraW5nKHJlYWRUcmFja2luZyk7XG4gICAgfVxuXG4gICAgLy8gV3JpdGUtdHJhY2tpbmcgcG9saWN5ICgjMTNjLUEpOiBpZGVudGljYWwgcGx1bWJpbmcgdG8gcmVhZFRyYWNraW5nIOKAlFxuICAgIC8vIHNhbWUgcm9vdC1jb250ZXh0IGFuY2hvciwgc2FtZSBpbmhlcml0YW5jZSwgc2FtZSByZXN1bWUtcGF0aCBvcmRlcmluZy5cbiAgICBjb25zdCB3cml0ZVRyYWNraW5nID0gYXJncy53cml0ZVRyYWNraW5nO1xuICAgIGlmICh3cml0ZVRyYWNraW5nICE9PSB1bmRlZmluZWQgJiYgd3JpdGVUcmFja2luZyAhPT0gJ2Z1bGwnKSB7XG4gICAgICBydW50aW1lLnVzZVdyaXRlVHJhY2tpbmcod3JpdGVUcmFja2luZyk7XG4gICAgfVxuXG4gICAgLy8gQ29tbWl0LXZhbHVlcyBlbmNvZGluZyAoIzEzYy1CKTogaWRlbnRpY2FsIHBsdW1iaW5nIHRvIHRoZSB0d28gZGlhbHNcbiAgICAvLyBhYm92ZSDigJQgcm9vdC1jb250ZXh0IGFuY2hvciwgY3JlYXRlTmV4dC9jcmVhdGVDaGlsZCBpbmhlcml0YW5jZSxcbiAgICAvLyBTdWJmbG93RXhlY3V0b3IgZHVjay1wdXNoLCByZXN1bWUtcGF0aCByZS1hcHBsaWNhdGlvbi4gU2tpcHBlZCBmb3IgdGhlXG4gICAgLy8gZGVmYXVsdCAnZnVsbCcg4oCUIHplcm8gd29yaywgYnl0ZS1pZGVudGljYWwgY29tbWl0IGxvZy5cbiAgICBjb25zdCBjb21taXRWYWx1ZXMgPSBhcmdzLmNvbW1pdFZhbHVlcztcbiAgICBpZiAoY29tbWl0VmFsdWVzICE9PSB1bmRlZmluZWQgJiYgY29tbWl0VmFsdWVzICE9PSAnZnVsbCcpIHtcbiAgICAgIHJ1bnRpbWUudXNlQ29tbWl0VmFsdWVzKGNvbW1pdFZhbHVlcyk7XG4gICAgfVxuXG4gICAgLy8gUGVyLXdyaXRlIHJlYWQgcHJvdmVuYW5jZSAoI1AxKTogaWRlbnRpY2FsIHBsdW1iaW5nIHRvIHRoZSB0aHJlZSBkaWFsc1xuICAgIC8vIGFib3ZlIOKAlCByb290LWNvbnRleHQgYW5jaG9yLCBjcmVhdGVOZXh0L2NyZWF0ZUNoaWxkIGluaGVyaXRhbmNlLFxuICAgIC8vIFN1YmZsb3dFeGVjdXRvciBkdWNrLXB1c2gsIHJlc3VtZS1wYXRoIHJlLWFwcGxpY2F0aW9uLiBTa2lwcGVkIGZvciB0aGVcbiAgICAvLyBkZWZhdWx0ICdvZmYnIOKAlCB6ZXJvIHdvcmssIGJ5dGUtaWRlbnRpY2FsIGNvbW1pdCBsb2cuXG4gICAgY29uc3Qgd3JpdGVQcm92ZW5hbmNlID0gYXJncy53cml0ZVByb3ZlbmFuY2U7XG4gICAgaWYgKHdyaXRlUHJvdmVuYW5jZSAhPT0gdW5kZWZpbmVkICYmIHdyaXRlUHJvdmVuYW5jZSAhPT0gJ29mZicpIHtcbiAgICAgIHJ1bnRpbWUudXNlV3JpdGVQcm92ZW5hbmNlKHdyaXRlUHJvdmVuYW5jZSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBGbG93Y2hhcnRUcmF2ZXJzZXI8VE91dCwgVFNjb3BlPih7XG4gICAgICByb290OiBlZmZlY3RpdmVSb290LFxuICAgICAgc3RhZ2VNYXA6IGZjLnN0YWdlTWFwLFxuICAgICAgc2NvcGVGYWN0b3J5LFxuICAgICAgZXhlY3V0aW9uUnVudGltZTogcnVudGltZSxcbiAgICAgIHJlYWRPbmx5Q29udGV4dDogcmVhZE9ubHlDb250ZXh0T3ZlcnJpZGUgPz8gYXJncy5yZWFkT25seUNvbnRleHQsXG4gICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyOiBhcmdzLnRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgICBzdHJlYW1IYW5kbGVyczogYXJncy5zdHJlYW1IYW5kbGVycyxcbiAgICAgIHNjb3BlUHJvdGVjdGlvbk1vZGU6IGFyZ3Muc2NvcGVQcm90ZWN0aW9uTW9kZSxcbiAgICAgIHN1YmZsb3dzOiBmYy5zdWJmbG93cyxcbiAgICAgIG5hcnJhdGl2ZUVuYWJsZWQ6IG5hcnJhdGl2ZUZsYWcsXG4gICAgICBidWlsZFRpbWVTdHJ1Y3R1cmU6IGZjLmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgIGxvZ2dlcjogZmMubG9nZ2VyID8/IGRlZmF1bHRMb2dnZXIsXG4gICAgICBzaWduYWwsXG4gICAgICBleGVjdXRpb25FbnY6IGVudixcbiAgICAgIGZsb3dSZWNvcmRlcnM6IHRoaXMuYnVpbGRGbG93UmVjb3JkZXJzTGlzdCgpLFxuICAgICAgZXhlY3V0aW9uQ291bnRlcjogdGhpcy5fZXhlY3V0aW9uQ291bnRlcixcbiAgICAgIHZpc2l0Q291bnRzOiB0aGlzLl92aXNpdENvdW50cyxcbiAgICAgIHJ1bklkOiB0aGlzLl9jdXJyZW50UnVuSWQsXG4gICAgICAuLi4ob3ZlcnJpZGVzPy5zdWJmbG93c092ZXJyaWRlICYmIHsgc3ViZmxvd3M6IG92ZXJyaWRlcy5zdWJmbG93c092ZXJyaWRlIH0pLFxuICAgICAgLi4uKG92ZXJyaWRlcz8uc3ViZmxvd1N0YXRlc0ZvclJlc3VtZSAmJiB7XG4gICAgICAgIHN1YmZsb3dTdGF0ZXNGb3JSZXN1bWU6IG92ZXJyaWRlcy5zdWJmbG93U3RhdGVzRm9yUmVzdW1lLFxuICAgICAgfSksXG4gICAgICAuLi4obWF4RGVwdGggIT09IHVuZGVmaW5lZCAmJiB7IG1heERlcHRoIH0pLFxuICAgICAgLi4uKG1heEl0ZXJhdGlvbnMgIT09IHVuZGVmaW5lZCAmJiB7IG1heEl0ZXJhdGlvbnMgfSksXG4gICAgfSk7XG4gIH1cblxuICBlbmFibGVOYXJyYXRpdmUob3B0aW9ucz86IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXJPcHRpb25zKTogdm9pZCB7XG4gICAgdGhpcy5uYXJyYXRpdmVFbmFibGVkID0gdHJ1ZTtcbiAgICBpZiAob3B0aW9ucykgdGhpcy5uYXJyYXRpdmVPcHRpb25zID0gb3B0aW9ucztcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgYSBkZWNsYXJhdGl2ZSByZWRhY3Rpb24gcG9saWN5IHRoYXQgYXBwbGllcyB0byBhbGwgc3RhZ2VzLlxuICAgKiBNdXN0IGJlIGNhbGxlZCBiZWZvcmUgcnVuKCkuXG4gICAqL1xuICBzZXRSZWRhY3Rpb25Qb2xpY3kocG9saWN5OiBSZWRhY3Rpb25Qb2xpY3kpOiB2b2lkIHtcbiAgICB0aGlzLnJlZGFjdGlvblBvbGljeSA9IHBvbGljeTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgdGhlIHJlYWQtdHJhY2tpbmcgcG9saWN5IGZvciBgU3RhZ2VTbmFwc2hvdC5zdGFnZVJlYWRzYCAoIzE0KS5cbiAgICogTXVzdCBiZSBjYWxsZWQgYmVmb3JlIHJ1bigpLiBFcXVpdmFsZW50IHRvIHRoZSBgcmVhZFRyYWNraW5nYFxuICAgKiBjb25zdHJ1Y3RvciBvcHRpb24g4oCUIHNlZSB7QGxpbmsgRmxvd0NoYXJ0RXhlY3V0b3JPcHRpb25zLnJlYWRUcmFja2luZ31cbiAgICogZm9yIHRoZSBtb2RlIHNlbWFudGljcyAoJ2Z1bGwnIGRlZmF1bHQgLyAnc3VtbWFyeScgLyAnb2ZmJykuXG4gICAqL1xuICBzZXRSZWFkVHJhY2tpbmcobW9kZTogUmVhZFRyYWNraW5nTW9kZSk6IHZvaWQge1xuICAgIHRoaXMuZmxvd0NoYXJ0QXJncy5yZWFkVHJhY2tpbmcgPSBtb2RlO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCB0aGUgd3JpdGUtdHJhY2tpbmcgcG9saWN5IGZvciBgU3RhZ2VTbmFwc2hvdC5zdGFnZVdyaXRlc2AgKCMxM2MtQSkuXG4gICAqIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBydW4oKS4gRXF1aXZhbGVudCB0byB0aGUgYHdyaXRlVHJhY2tpbmdgXG4gICAqIGNvbnN0cnVjdG9yIG9wdGlvbiDigJQgc2VlIHtAbGluayBGbG93Q2hhcnRFeGVjdXRvck9wdGlvbnMud3JpdGVUcmFja2luZ31cbiAgICogZm9yIHRoZSBtb2RlIHNlbWFudGljcyAoJ2Z1bGwnIGRlZmF1bHQgLyAnc3VtbWFyeScgLyAnb2ZmJyksIHRoZVxuICAgKiBvbkNvbW1pdC1wYXlsb2FkIGNvbnNlcXVlbmNlLCBhbmQgdGhlIHJlZGFjdGlvbi1wcmVjZWRlbmNlIHJ1bGUuXG4gICAqL1xuICBzZXRXcml0ZVRyYWNraW5nKG1vZGU6IFdyaXRlVHJhY2tpbmdNb2RlKTogdm9pZCB7XG4gICAgdGhpcy5mbG93Q2hhcnRBcmdzLndyaXRlVHJhY2tpbmcgPSBtb2RlO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCB0aGUgY29tbWl0LXZhbHVlcyBlbmNvZGluZyBwb2xpY3kgZm9yIHRoZSBjb21taXQgbG9nICgjMTNjLUIpLlxuICAgKiBNdXN0IGJlIGNhbGxlZCBiZWZvcmUgcnVuKCkuIEVxdWl2YWxlbnQgdG8gdGhlIGBjb21taXRWYWx1ZXNgXG4gICAqIGNvbnN0cnVjdG9yIG9wdGlvbiDigJQgc2VlIHtAbGluayBGbG93Q2hhcnRFeGVjdXRvck9wdGlvbnMuY29tbWl0VmFsdWVzfVxuICAgKiBmb3IgdGhlIG1vZGUgc2VtYW50aWNzICgnZnVsbCcgZGVmYXVsdCAvICdkZWx0YScpLCB0aGUgdmVyYi1xdWFsaWZpZWRcbiAgICogYG92ZXJ3cml0ZWAgY29uc2VxdWVuY2UsIGFuZCB0aGUgYGNvbW1pdFZhbHVlQXRgIG1pZ3JhdGlvbiBoZWxwZXIuXG4gICAqL1xuICBzZXRDb21taXRWYWx1ZXMobW9kZTogQ29tbWl0VmFsdWVzTW9kZSk6IHZvaWQge1xuICAgIHRoaXMuZmxvd0NoYXJ0QXJncy5jb21taXRWYWx1ZXMgPSBtb2RlO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgYSBjb21wbGlhbmNlLWZyaWVuZGx5IHJlcG9ydCBvZiBhbGwgcmVkYWN0aW9uIGFjdGl2aXR5IGZyb20gdGhlXG4gICAqIG1vc3QgcmVjZW50IHJ1bi4gTmV2ZXIgaW5jbHVkZXMgYWN0dWFsIHZhbHVlcy5cbiAgICovXG4gIGdldFJlZGFjdGlvblJlcG9ydCgpOiBSZWRhY3Rpb25SZXBvcnQge1xuICAgIGNvbnN0IGZpZWxkUmVkYWN0aW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XG4gICAgZm9yIChjb25zdCBba2V5LCBmaWVsZHNdIG9mIHRoaXMuc2hhcmVkUmVkYWN0ZWRGaWVsZHNCeUtleSkge1xuICAgICAgZmllbGRSZWRhY3Rpb25zW2tleV0gPSBbLi4uZmllbGRzXTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlZGFjdGVkS2V5czogWy4uLnRoaXMuc2hhcmVkUmVkYWN0ZWRLZXlzXSxcbiAgICAgIGZpZWxkUmVkYWN0aW9ucyxcbiAgICAgIHBhdHRlcm5zOiAodGhpcy5yZWRhY3Rpb25Qb2xpY3k/LnBhdHRlcm5zID8/IFtdKS5tYXAoKHApID0+IHAuc291cmNlKSxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIFBhdXNlL1Jlc3VtZSDilIDilIDilIBcblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgY2hlY2twb2ludCBmcm9tIHRoZSBtb3N0IHJlY2VudCBwYXVzZWQgZXhlY3V0aW9uLCBvciBgdW5kZWZpbmVkYFxuICAgKiBpZiB0aGUgbGFzdCBydW4gY29tcGxldGVkIHdpdGhvdXQgcGF1c2luZy5cbiAgICpcbiAgICogVGhlIGNoZWNrcG9pbnQgaXMgSlNPTi1zZXJpYWxpemFibGUg4oCUIHN0b3JlIGl0IGluIFJlZGlzLCBQb3N0Z3JlcywgbG9jYWxTdG9yYWdlLCBldGMuXG4gICAqXG4gICAqIEl0IGlzIGZ1bGx5IERFVEFDSEVEIGZyb20gZW5naW5lIHN0YXRlOiBldmVyeSBmaWVsZCB3YXMgZGVlcC1jb3BpZWQgYXRcbiAgICogcGF1c2UgdGltZSAoc2VlIGBidWlsZFBhdXNlQ2hlY2twb2ludGApLiBIb2xkaW5nLCBtdXRhdGluZywgb3IgcGVyc2lzdGluZ1xuICAgKiBpdCBjYW5ub3QgYWZmZWN0IHRoZSBleGVjdXRvciwgYW5kIGEgbGF0ZXIgc2FtZS1leGVjdXRvciByZXN1bWUgY2Fubm90XG4gICAqIG11dGF0ZSBhIGNoZWNrcG9pbnQgeW91IGFscmVhZHkgc3RvcmVkLlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yLnJ1bih7IGlucHV0IH0pO1xuICAgKiBpZiAoZXhlY3V0b3IuaXNQYXVzZWQoKSkge1xuICAgKiAgIGNvbnN0IGNoZWNrcG9pbnQgPSBleGVjdXRvci5nZXRDaGVja3BvaW50KCkhO1xuICAgKiAgIGF3YWl0IHJlZGlzLnNldChgc2Vzc2lvbjoke2lkfWAsIEpTT04uc3RyaW5naWZ5KGNoZWNrcG9pbnQpKTtcbiAgICogfVxuICAgKiBgYGBcbiAgICovXG4gIGdldENoZWNrcG9pbnQoKTogRmxvd2NoYXJ0Q2hlY2twb2ludCB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMubGFzdENoZWNrcG9pbnQ7XG4gIH1cblxuICAvKiogUmV0dXJucyBgdHJ1ZWAgaWYgdGhlIG1vc3QgcmVjZW50IHJ1bigpIHdhcyBwYXVzZWQgKGNoZWNrcG9pbnQgYXZhaWxhYmxlKS4gKi9cbiAgaXNQYXVzZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMubGFzdENoZWNrcG9pbnQgIT09IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBOdW1iZXIgb2YgY29tbWl0cyBpbiB0aGUgcnVuJ3MgY29tbWl0IGxvZy4gTygxKSDigJQgZGlyZWN0IGxlbmd0aFxuICAgKiByZWFkLCBubyBzbmFwc2hvdCBtYXRlcmlhbGl6YXRpb24uIFVzZSB0aGlzIHRvIHN0YW1wIGNvbW1pdFxuICAgKiBpbmRpY2VzIG9uIG9ic2VydmVyIGV2ZW50cyAoZS5nLiwgYEJvdW5kYXJ5UmVjb3JkZXJgIHN0b3JpbmdcbiAgICogYGNvbW1pdElkeEJlZm9yZWAgLyBgY29tbWl0SWR4QWZ0ZXJgIHBlciBkb21haW4gZXZlbnQgZm9yXG4gICAqIGBDb21taXRSYW5nZUluZGV4YCBxdWVyaWVzIOKAlCBzZWUgYGZvb3RwcmludGpzL3RyYWNlYCkuXG4gICAqXG4gICAqIFJldHVybnMgMCBiZWZvcmUgYW55IHJ1bjsgYWZ0ZXIsIHJldHVybnMgdGhlIGN1bXVsYXRpdmUgY29tbWl0XG4gICAqIGNvdW50IGFjcm9zcyB0aGUgZXhlY3V0b3IncyBsaWZldGltZSAoaW5jbHVkaW5nIHJlc3VtZXMpLlxuICAgKlxuICAgKiBJTVBMRU1FTlRBVElPTiBOT1RFOiB0aGlzIHJldHVybnMgYHJ1bnRpbWUuZXhlY3V0aW9uSGlzdG9yeS5sZW5ndGhgLFxuICAgKiB3aGljaCBpcyB0aGUgc2FtZSB2YWx1ZSBhcyBgZ2V0U25hcHNob3QoKS5jb21taXRMb2cubGVuZ3RoYC4gVGhlXG4gICAqIG5hbWluZyBhc3ltbWV0cnkgaXMgaGlzdG9yaWNhbCDigJQgdGhlIHVuZGVybHlpbmcgYEV2ZW50TG9nYCBmaWVsZFxuICAgKiBpcyBuYW1lZCBgZXhlY3V0aW9uSGlzdG9yeWAgYnV0IHN0b3JlcyB0aGUgYENvbW1pdEJ1bmRsZVtdYCB0aGF0XG4gICAqIGBjb21taXRMb2dgIGV4cG9zZXMuIFRoZXkgYXJlIHRoZSBTQU1FIGFycmF5ICh2ZXJpZmllZCBieSB0aGVcbiAgICogXCJtYXRjaGVzIGNvbW1pdExvZy5sZW5ndGhcIiBpbnRlZ3JhdGlvbiB0ZXN0KS5cbiAgICovXG4gIGdldENvbW1pdENvdW50KCk6IG51bWJlciB7XG4gICAgY29uc3QgcnVudGltZSA9IHRoaXMudHJhdmVyc2VyLmdldFJ1bnRpbWUoKSBhcyBJbnN0YW5jZVR5cGU8dHlwZW9mIEV4ZWN1dGlvblJ1bnRpbWU+IHwgdW5kZWZpbmVkO1xuICAgIHJldHVybiBydW50aW1lPy5leGVjdXRpb25IaXN0b3J5Lmxlbmd0aCA/PyAwO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc3VtZSBhIHBhdXNlZCBmbG93Y2hhcnQgZnJvbSBhIGNoZWNrcG9pbnQuXG4gICAqXG4gICAqIFJlc3RvcmVzIHRoZSBzY29wZSBzdGF0ZSwgY2FsbHMgdGhlIHBhdXNlZCBzdGFnZSdzIGByZXN1bWVGbmAgd2l0aCB0aGVcbiAgICogcHJvdmlkZWQgaW5wdXQsIHRoZW4gY29udGludWVzIHRyYXZlcnNhbCBmcm9tIHRoZSBuZXh0IHN0YWdlLlxuICAgKlxuICAgKiBUaGUgY2hlY2twb2ludCBjYW4gY29tZSBmcm9tIGBnZXRDaGVja3BvaW50KClgIG9uIGEgcHJldmlvdXMgcnVuLCBvciBmcm9tXG4gICAqIGEgc2VyaWFsaXplZCBjaGVja3BvaW50IHN0b3JlZCBpbiBSZWRpcy9Qb3N0Z3Jlcy9sb2NhbFN0b3JhZ2UuXG4gICAqXG4gICAqICoqUmVjb3JkZXIvbmFycmF0aXZlIHN0YXRlIGRlcGVuZHMgb24gdGhlIHJlc3VtZSBtb2RlLioqIFJlc3VtaW5nIG9uIHRoZSBTQU1FXG4gICAqIGV4ZWN1dG9yIHRoYXQgcmFuIHByZXNlcnZlcyBhbmQgYWNjdW11bGF0ZXMgbmFycmF0aXZlL21ldHJpY3MvZGVidWcgYWNyb3NzIHRoZVxuICAgKiBwYXVzZS9yZXN1bWUgY3ljbGUgKHByZXNlcnZlUmVjb3JkZXJzKS4gUmVzdW1pbmcgb24gYSBGUkVTSCBleGVjdXRvclxuICAgKiAocmVjb25zdHJ1Y3RlZCBmcm9tIGEgc3RvcmVkIGNoZWNrcG9pbnQpIHN0YXJ0cyB3aXRoIGVtcHR5IHJlY29yZGVyIHN0YXRlIOKAlFxuICAgKiBjb2xsZWN0IHdoYXQgeW91IG5lZWQgYmVmb3JlIGRpc2NhcmRpbmcgdGhlIHBhdXNlZCBleGVjdXRvci4gQSBmcmVzaCBgcnVuSWRgXG4gICAqIGlzIGdlbmVyYXRlZCBlaXRoZXIgd2F5LlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIC8vIFByb2Nlc3MgQSDigJQgYWZ0ZXIgYSBwYXVzZSwgcGVyc2lzdCB0aGUgY2hlY2twb2ludDpcbiAgICogY29uc3QgY2hlY2twb2ludCA9IGV4ZWN1dG9yLmdldENoZWNrcG9pbnQoKSE7XG4gICAqIGF3YWl0IHJlZGlzLnNldChgc2Vzc2lvbjoke2lkfWAsIEpTT04uc3RyaW5naWZ5KGNoZWNrcG9pbnQpKTtcbiAgICpcbiAgICogLy8gUHJvY2VzcyBCIChwb3NzaWJseSBkaWZmZXJlbnQgc2VydmVyLCBzYW1lIGNoYXJ0KSDigJQgcmVzdG9yZSBhbmQgcmVzdW1lOlxuICAgKiBjb25zdCByZXN0b3JlZCA9IEpTT04ucGFyc2UoYXdhaXQgcmVkaXMuZ2V0KGBzZXNzaW9uOiR7aWR9YCkpO1xuICAgKiBjb25zdCBleGVjdXRvciA9IG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCk7XG4gICAqIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yLnJlc3VtZShyZXN0b3JlZCwgeyBhcHByb3ZlZDogdHJ1ZSB9KTtcbiAgICogYGBgXG4gICAqL1xuICBhc3luYyByZXN1bWUoXG4gICAgY2hlY2twb2ludDogRmxvd2NoYXJ0Q2hlY2twb2ludCxcbiAgICByZXN1bWVJbnB1dD86IHVua25vd24sXG4gICAgb3B0aW9ucz86IFBpY2s8UnVuT3B0aW9ucywgJ3NpZ25hbCcgfCAnZW52JyB8ICdtYXhEZXB0aCcgfCAnbWF4SXRlcmF0aW9ucyc+LFxuICApOiBQcm9taXNlPEV4ZWN1dG9yUmVzdWx0PiB7XG4gICAgLy8gUmUtZW50cmFuY3kgZ3VhcmQgRklSU1Qg4oCUIHJlc3VtZSgpIG11dGF0ZXMgdGhlIHNhbWUgcGVyLXJ1biBzdGF0ZSBydW4oKVxuICAgIC8vIGRvZXMgKHRyYXZlcnNlciwgcnVuSWQsIGNoZWNrcG9pbnQpLCBzbyByZXN1bWUtZHVyaW5nLXJ1biBhbmRcbiAgICAvLyBkb3VibGUtcmVzdW1lIGFyZSB0aGUgc2FtZSBjb3JydXB0aW9uIGNsYXNzIGFzIGNvbmN1cnJlbnQgcnVuKCkuXG4gICAgaWYgKHRoaXMuX2lzRXhlY3V0aW5nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICdGbG93Q2hhcnRFeGVjdXRvcjogcmVzdW1lKCkgY2FsbGVkIHdoaWxlIGFub3RoZXIgcnVuKCkvcmVzdW1lKCkgaXMgaW4gZmxpZ2h0IG9uIHRoaXMgJyArXG4gICAgICAgICAgJ2V4ZWN1dG9yLiBBbiBleGVjdXRvciBob2xkcyBwZXItcnVuIHN0YXRlIChydW5JZCwgcmVjb3JkZXJzLCBjaGVja3BvaW50KSDigJQgY3JlYXRlICcgK1xuICAgICAgICAgICdvbmUgZXhlY3V0b3IgcGVyIGNvbmN1cnJlbnQgcnVuLiBTZWUgZG9jcy9ndWlkZXMvZXhlY3V0aW9uLW1vZGVsLm1kLicsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyDilIDilIAgVmFsaWRhdGUgY2hlY2twb2ludCBzdHJ1Y3R1cmUgKG1heSBjb21lIGZyb20gdW50cnVzdGVkIGV4dGVybmFsIHN0b3JhZ2UpIOKUgOKUgFxuICAgIC8vIChsYXN0Q2hlY2twb2ludCBpcyB3aXBlZCBBRlRFUiB2YWxpZGF0aW9uIOKAlCBhIHJlamVjdGVkIGNoZWNrcG9pbnQgbXVzdFxuICAgIC8vIG5vdCBkZXN0cm95IHRoZSBleGVjdXRvcidzIGV4aXN0aW5nIGNoZWNrcG9pbnQgc3RhdGUuKVxuICAgIGlmIChcbiAgICAgICFjaGVja3BvaW50IHx8XG4gICAgICB0eXBlb2YgY2hlY2twb2ludCAhPT0gJ29iamVjdCcgfHxcbiAgICAgIHR5cGVvZiBjaGVja3BvaW50LnNoYXJlZFN0YXRlICE9PSAnb2JqZWN0JyB8fFxuICAgICAgY2hlY2twb2ludC5zaGFyZWRTdGF0ZSA9PT0gbnVsbCB8fFxuICAgICAgQXJyYXkuaXNBcnJheShjaGVja3BvaW50LnNoYXJlZFN0YXRlKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGNoZWNrcG9pbnQ6IHNoYXJlZFN0YXRlIG11c3QgYmUgYSBwbGFpbiBvYmplY3QuJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgY2hlY2twb2ludC5wYXVzZWRTdGFnZUlkICE9PSAnc3RyaW5nJyB8fCBjaGVja3BvaW50LnBhdXNlZFN0YWdlSWQgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2hlY2twb2ludDogcGF1c2VkU3RhZ2VJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZy4nKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgIUFycmF5LmlzQXJyYXkoY2hlY2twb2ludC5zdWJmbG93UGF0aCkgfHxcbiAgICAgICFjaGVja3BvaW50LnN1YmZsb3dQYXRoLmV2ZXJ5KChzOiB1bmtub3duKSA9PiB0eXBlb2YgcyA9PT0gJ3N0cmluZycpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2hlY2twb2ludDogc3ViZmxvd1BhdGggbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzLicpO1xuICAgIH1cblxuICAgIC8vIOKUgOKUgCBTZWVkIHRoZSBzaGFyZWQgZXhlY3V0aW9uIGNvdW50ZXIgKyBwZXItc3RhZ2UgdmlzaXQgY291bnRzIOKUgOKUgFxuICAgIC8vXG4gICAgLy8gTVVTVCBydW4gYmVmb3JlIHRoZSBjb3VudGVyIGlzIFJFQUQgYmVsb3cgKHRoZSByZXN1bWUtbm9kZSBydW50aW1lU3RhZ2VJZFxuICAgIC8vIHJlY29uc3RydWN0aW9uKSBBTkQgYmVmb3JlIGNyZWF0ZVRyYXZlcnNlcigpIGhhbmRzIHRoZSB0cmF2ZXJzZXIgdGhlc2VcbiAgICAvLyBvYmplY3RzIEJZIFJFRkVSRU5DRS4gU2VlZGluZyBrZWVwcyBydW50aW1lU3RhZ2VJZHMgdW5pcXVlIGFuZFxuICAgIC8vIGxvb3BJdGVyYXRpb24gbW9ub3RvbmljIGFjcm9zcyBhIENST1NTLWV4ZWN1dG9yIHJlc3VtZSAoYSBmcmVzaCBleGVjdXRvclxuICAgIC8vIHN0YXJ0cyBib3RoIGF0IDAvZW1wdHk7IHRoZSBjaGVja3BvaW50IGNhcnJpZXMgdGhlIHBhdXNlLXRpbWUgdmFsdWVzKS5cbiAgICAvL1xuICAgIC8vIE1VVEFURSwgbmV2ZXIgUkVQTEFDRTogYF9leGVjdXRpb25Db3VudGVyYCBhbmQgYF92aXNpdENvdW50c2AgYXJlIHNoYXJlZFxuICAgIC8vIGJ5IHJlZmVyZW5jZSBpbnRvIHRoZSB0cmF2ZXJzZXIgKGFuZCwgdHJhbnNpdGl2ZWx5LCBldmVyeSBzdWJmbG93XG4gICAgLy8gdHJhdmVyc2VyIOKAlCBzZWUgRmxvd2NoYXJ0VHJhdmVyc2VyJ3Mgc3ViLXRyYXZlcnNlciBmYWN0b3J5KS4gQXNzaWduaW5nIGFcbiAgICAvLyBmcmVzaCBvYmplY3QgaGVyZSB3b3VsZCBzZXZlciB0aGF0IHNoYXJlZCByZWZlcmVuY2UuIEJvdGggZmllbGRzIGFyZVxuICAgIC8vIG9wdGlvbmFsIG9uIHRoZSBjaGVja3BvaW50IChvbGRlciBwZXJzaXN0ZWQgY2hlY2twb2ludHMgb21pdCB0aGVtKSDigJQgc2tpcFxuICAgIC8vIHNlZWRpbmcgd2hlbiBhYnNlbnQsIHByZXNlcnZpbmcgdGhlIHByZXZpb3VzIGJlaGF2aW9yLiBTYW1lLWV4ZWN1dG9yXG4gICAgLy8gcmVzdW1lIGlzIGlkZW1wb3RlbnQ6IGF0IHBhdXNlIHRoZSBpbnN0YW5jZSB2YWx1ZXMgYWxyZWFkeSBlcXVhbCB0aGVcbiAgICAvLyBjaGVja3BvaW50J3MsIHNvIHJlLXNlZWRpbmcgdGhlbSBjaGFuZ2VzIG5vdGhpbmcuXG4gICAgaWYgKHR5cGVvZiBjaGVja3BvaW50LmV4ZWN1dGlvbkNvdW50ID09PSAnbnVtYmVyJykge1xuICAgICAgdGhpcy5fZXhlY3V0aW9uQ291bnRlci52YWx1ZSA9IGNoZWNrcG9pbnQuZXhlY3V0aW9uQ291bnQ7XG4gICAgfVxuICAgIGlmIChjaGVja3BvaW50LnZpc2l0Q291bnRzKSB7XG4gICAgICB0aGlzLl92aXNpdENvdW50cy5jbGVhcigpO1xuICAgICAgZm9yIChjb25zdCBbc3RhZ2VJZCwgY291bnRdIG9mIE9iamVjdC5lbnRyaWVzKGNoZWNrcG9pbnQudmlzaXRDb3VudHMpKSB7XG4gICAgICAgIHRoaXMuX3Zpc2l0Q291bnRzLnNldChzdGFnZUlkLCBjb3VudCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgcGF1c2VkIG5vZGUgaW4gdGhlIGdyYXBoXG4gICAgY29uc3QgcGF1c2VkTm9kZSA9IHRoaXMuZmluZE5vZGVJbkdyYXBoKGNoZWNrcG9pbnQucGF1c2VkU3RhZ2VJZCwgY2hlY2twb2ludC5zdWJmbG93UGF0aCk7XG4gICAgaWYgKCFwYXVzZWROb2RlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBDYW5ub3QgcmVzdW1lOiBzdGFnZSAnJHtjaGVja3BvaW50LnBhdXNlZFN0YWdlSWR9JyBub3QgZm91bmQgaW4gZmxvd2NoYXJ0LiBgICtcbiAgICAgICAgICAnVGhlIGNoYXJ0IG1heSBoYXZlIGNoYW5nZWQgc2luY2UgdGhlIGNoZWNrcG9pbnQgd2FzIGNyZWF0ZWQuJyxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmICghcGF1c2VkTm9kZS5yZXN1bWVGbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQ2Fubm90IHJlc3VtZTogc3RhZ2UgJyR7cGF1c2VkTm9kZS5uYW1lfScgKCR7cGF1c2VkTm9kZS5pZH0pIGhhcyBubyByZXN1bWVGbi4gYCArXG4gICAgICAgICAgJ09ubHkgc3RhZ2VzIGNyZWF0ZWQgd2l0aCBhZGRQYXVzYWJsZUZ1bmN0aW9uKCkgY2FuIGJlIHJlc3VtZWQuJyxcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMubGFzdENoZWNrcG9pbnQgPSB1bmRlZmluZWQ7XG5cbiAgICAvLyBCdWlsZCBhIHN5bnRoZXRpYyByZXN1bWUgbm9kZTogY2FsbHMgcmVzdW1lRm4gd2l0aCByZXN1bWVJbnB1dCwgdGhlbiBjb250aW51ZXMuXG4gICAgLy8gcmVzdW1lRm4gc2lnbmF0dXJlIGlzIChzY29wZSwgaW5wdXQpIHBlciBQYXVzYWJsZUhhbmRsZXIg4oCUIHdyYXAgdG8gbWF0Y2ggU3RhZ2VGdW5jdGlvbihzY29wZSwgYnJlYWtGbikuXG4gICAgY29uc3QgcmVzdW1lRm4gPSBwYXVzZWROb2RlLnJlc3VtZUZuO1xuICAgIGNvbnN0IHJlc3VtZVN0YWdlRm4gPSAoc2NvcGU6IFRTY29wZSkgPT4ge1xuICAgICAgcmV0dXJuIHJlc3VtZUZuKHNjb3BlLCByZXN1bWVJbnB1dCk7XG4gICAgfTtcblxuICAgIC8vIERldGVybWluZSBjb250aW51YXRpb246IGZvciBicmFuY2ggY2hpbGRyZW4gKGRlY2lkZXIvc2VsZWN0b3IpLFxuICAgIC8vIHBhdXNlZE5vZGUubmV4dCBpcyB1bmRlZmluZWQuIFRoZSBjaGVja3BvaW50J3NcbiAgICAvLyBjb250aW51YXRpb25TdGFnZUlkIChjb2xsZWN0ZWQgZHVyaW5nIHRyYXZlcnNhbCBidWJibGUtdXApXG4gICAgLy8gcG9pbnRzIHRvIHRoZSBpbnZva2VyJ3MgbmV4dCBub2RlLlxuICAgIC8vXG4gICAgLy8gRm9yIHBhdXNlcyBpbnNpZGUgYSBzdWJmbG93LCB0aGUgY29udGludWF0aW9uIGxpdmVzIElOU0lERSB0aGVcbiAgICAvLyBsZWFmIHN1YmZsb3cgKGUuZy4sIHRoZSBsb29wIHRhcmdldCBiYWNrIHRvIGBtZXNzYWdlc2ApLiBTZWFyY2hcbiAgICAvLyB0aGUgbGVhZiBzdWJmbG93IGZpcnN0OyBmYWxsIGJhY2sgdG8gdG9wLWxldmVsIGZvciByb290LWxldmVsXG4gICAgLy8gcGF1c2VzLlxuICAgIC8vIENsb25lLWluOiBgc3ViZmxvd1N0YXRlc2Agc2VlZHMgbmVzdGVkIHJ1bnRpbWVzIGluIFN1YmZsb3dFeGVjdXRvclxuICAgIC8vIChzaGFsbG93LW1lcmdlZCBpbnRvIGVhY2ggbmVzdGVkIFNoYXJlZE1lbW9yeSksIHNvIHdpdGhvdXQgYSBjb3B5IHRoZVxuICAgIC8vIGVuZ2luZSB3b3VsZCBob2xkIGxpdmUgcmVmZXJlbmNlcyBpbnRvIHRoZSBjYWxsZXIncyBjaGVja3BvaW50IG9iamVjdCDigJRcbiAgICAvLyBjYWxsZXIgbXV0YXRpb25zIHdvdWxkIGJsZWVkIGludG8gdGhlIHJlc3VtZWQgcnVuIGFuZCBlbmdpbmUgd3JpdGVzXG4gICAgLy8gd291bGQgcmVhY2ggYSBjaGVja3BvaW50IHRoZSBjYWxsZXIgbWF5IGhhdmUgYWxyZWFkeSBwZXJzaXN0ZWQuXG4gICAgY29uc3Qgc2ZTdGF0ZXMgPSBzdHJ1Y3R1cmVkQ2xvbmUoY2hlY2twb2ludC5zdWJmbG93U3RhdGVzKTtcbiAgICBjb25zdCBsZWFmU3ViZmxvd0lkID1cbiAgICAgIGNoZWNrcG9pbnQuc3ViZmxvd1BhdGgubGVuZ3RoID4gMCA/IGNoZWNrcG9pbnQuc3ViZmxvd1BhdGhbY2hlY2twb2ludC5zdWJmbG93UGF0aC5sZW5ndGggLSAxXSA6IHVuZGVmaW5lZDtcbiAgICBsZXQgY29udGludWF0aW9uTmV4dCA9IHBhdXNlZE5vZGUubmV4dDtcbiAgICAvLyBBIGJyYW5jaC1zb3VyY2VkIGxvb3AgKGB7IGxvb3BUbyB9YCAvIGBEZWNpZGVyTGlzdC5sb29wVG9gKSBzZXRzIHRoZVxuICAgIC8vIGxvb3BpbmcgYnJhbmNoJ3MgYG5leHRgIHRvIGEgbG9vcC1yZWYgU1RVQiDigJQgYHsgaWQsIGlzTG9vcFJlZjp0cnVlIH1gXG4gICAgLy8gd2l0aCBubyBmbi9jaGlsZHJlbi9zdWJmbG93SWQuIE9uIGEgTk9STUFMIHJ1biB0aGF0IHN0dWIgcmVzb2x2ZXMgZmluZTpcbiAgICAvLyB0aGUgcmVhbCB0YXJnZXQgbm9kZSBpcyByZWFjaGFibGUgZnJvbSB0aGUgY2hhcnQgcm9vdCwgc28gdGhlIHRyYXZlcnNlcidzXG4gICAgLy8gbm9kZSBtYXAgYWxyZWFkeSBob2xkcyBpdCAodGhlIHN0dWIgaXMgc2tpcHBlZCDigJQgZmlyc3Qtd3JpdGUtd2lucykuIE9uXG4gICAgLy8gUkVTVU1FIHRoZSBub2RlIG1hcCBpcyBidWlsdCBmcm9tIHRoZSB0cnVuY2F0ZWQgcmVzdW1lIHJvb3QsIHdoZXJlIHRoZVxuICAgIC8vIHJlYWwgdGFyZ2V0IGlzIHVucmVhY2hhYmxlLCBzbyB0aGUgc3R1YiB3b3VsZCB3aW4gdGhlIGlkIHNsb3QgYW5kXG4gICAgLy8gYGV4ZWN1dGVOb2RlYCB0aHJvd3MgXCJOb2RlICc8dGFyZ2V0PicgbXVzdCBkZWZpbmUgLi4uXCIuIFJlc29sdmUgdGhlIHN0dWJcbiAgICAvLyB0byB0aGUgUkVBTCB0YXJnZXQgbm9kZSBoZXJlIChkZnNGaW5kIHNraXBzIGxvb3AtcmVmcyBhbmQgcmV0dXJucyB0aGVcbiAgICAvLyByZWFsIG5vZGUgV0lUSCBpdHMgZnVsbCBkb3duc3RyZWFtIGNoYWluIOKAlCBlLmcuIGEgc3ViZmxvdyBNT1VOVCBub2RlLFxuICAgIC8vIHdob3NlIGAubmV4dGAgY2FycmllcyB0aGUgZGVjaWRlci90ZXJtaW5hbCBjb250aW51YXRpb24gdGhlIGxvb3AgbXVzdFxuICAgIC8vIHJlLWVudGVyKS4gU2VlIHRlc3QvbGliL3BhdXNlL3Jlc3VtZS1icmFuY2gtbG9vcC1zdWJmbG93LnRlc3QudHMuXG4gICAgaWYgKGNvbnRpbnVhdGlvbk5leHQ/LmlzTG9vcFJlZikge1xuICAgICAgY29uc3QgbG9vcFRhcmdldElkID0gY29udGludWF0aW9uTmV4dC5pZDtcbiAgICAgIGNvbnN0IHJlYWxUYXJnZXQgPVxuICAgICAgICAobGVhZlN1YmZsb3dJZCAhPT0gdW5kZWZpbmVkID8gdGhpcy5maW5kTm9kZUluR3JhcGgobG9vcFRhcmdldElkLCBjaGVja3BvaW50LnN1YmZsb3dQYXRoKSA6IHVuZGVmaW5lZCkgPz9cbiAgICAgICAgdGhpcy5maW5kTm9kZUluR3JhcGgobG9vcFRhcmdldElkLCBbXSk7XG4gICAgICBpZiAocmVhbFRhcmdldCkgY29udGludWF0aW9uTmV4dCA9IHJlYWxUYXJnZXQ7XG4gICAgfVxuICAgIGlmICghY29udGludWF0aW9uTmV4dCAmJiBjaGVja3BvaW50LmNvbnRpbnVhdGlvblN0YWdlSWQpIHtcbiAgICAgIC8vIFNlYXJjaCBsZWFmIHN1YmZsb3cgZmlyc3QgKGxvb3AgdGFyZ2V0cyAvIGJyYW5jaCBqb2lucyBsaXZlIHRoZXJlKSxcbiAgICAgIC8vIHRoZW4gZmFsbCBiYWNrIHRvIHRvcCBsZXZlbC5cbiAgICAgIGNvbnRpbnVhdGlvbk5leHQgPSBsZWFmU3ViZmxvd0lkXG4gICAgICAgID8gdGhpcy5maW5kTm9kZUluR3JhcGgoY2hlY2twb2ludC5jb250aW51YXRpb25TdGFnZUlkLCBjaGVja3BvaW50LnN1YmZsb3dQYXRoKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGlmICghY29udGludWF0aW9uTmV4dCkge1xuICAgICAgICBjb250aW51YXRpb25OZXh0ID0gdGhpcy5maW5kTm9kZUluR3JhcGgoY2hlY2twb2ludC5jb250aW51YXRpb25TdGFnZUlkLCBbXSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gVGhlIFwiaW5uZXJcIiByZXN1bWUgY2hhaW46IHJlc3VtZUZuIOKGkiBjb250aW51YXRpb24uIFRoaXMgaXMgd2hhdFxuICAgIC8vIHJ1bnMgSU5TSURFIHRoZSBsZWFmIHN1YmZsb3cncyBib2R5LiBGb3IgYSByb290LWxldmVsIHBhdXNlXG4gICAgLy8gKHN1YmZsb3dQYXRoIGVtcHR5KSwgdGhpcyBpcyBhbHNvIHRoZSB0b3AtbGV2ZWwgcmVzdW1lIHJvb3QuXG4gICAgY29uc3QgaW5uZXJSZXN1bWVDaGFpbjogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBwYXVzZWROb2RlLm5hbWUsXG4gICAgICBpZDogcGF1c2VkTm9kZS5pZCxcbiAgICAgIGRlc2NyaXB0aW9uOiBwYXVzZWROb2RlLmRlc2NyaXB0aW9uLFxuICAgICAgZm46IHJlc3VtZVN0YWdlRm4sXG4gICAgICBuZXh0OiBjb250aW51YXRpb25OZXh0LFxuICAgIH07XG5cbiAgICAvLyBEb24ndCBjbGVhciByZWNvcmRlcnMg4oCUIHJlc3VtZSBjb250aW51ZXMgZnJvbSBwcmV2aW91cyBzdGF0ZS5cbiAgICAvLyBOYXJyYXRpdmUsIG1ldHJpY3MsIGRlYnVnIGVudHJpZXMgYWNjdW11bGF0ZSBhY3Jvc3MgcGF1c2UvcmVzdW1lLlxuICAgIC8vXG4gICAgLy8gVHdvLW1vZGUgcmVzdW1lOlxuICAgIC8vICAg4oCiIFNhbWUtZXhlY3V0b3IgKHJ1bigpIHByZXZpb3VzbHkgY2FsbGVkIG9uIFRISVMgaW5zdGFuY2UpOlxuICAgIC8vICAgICByZXVzZSB0aGUgZXhpc3RpbmcgcnVudGltZSBzbyB0aGUgZXhlY3V0aW9uIHRyZWUgY29udGludWVzXG4gICAgLy8gICAgIGZyb20gdGhlIHBhdXNlIHBvaW50IGFuZCByZWNvcmRlcnMvbmFycmF0aXZlIGFjY3VtdWxhdGUuXG4gICAgLy8gICDigKIgQ3Jvc3MtZXhlY3V0b3IgKGZyZXNoIGV4ZWN1dG9yIHJlY29uc3RydWN0ZWQgZnJvbSBhIHN0b3JlZFxuICAgIC8vICAgICBjaGVja3BvaW50KTogc2VlZCBhIE5FVyBydW50aW1lIGZyb20gYGNoZWNrcG9pbnQuc2hhcmVkU3RhdGVgXG4gICAgLy8gICAgIHNvIHJlc3VtZSBoYW5kbGVycyBjYW4gcmVhZCBwcmUtcGF1c2Ugc2NvcGUuIFRoZSBleGVjdXRpb25cbiAgICAvLyAgICAgdHJlZSBzdGFydHMgYXQgdGhlIHJlc3VtZSBub2RlIOKAlCB3ZSBkb24ndCBoYXZlIHRoZSBwcmV2aW91c1xuICAgIC8vICAgICB0cmF2ZXJzYWwncyB0cmVlIG9uIGEgZnJlc2ggcHJvY2VzcyBhbnl3YXkuXG4gICAgY29uc3Qgc2FtZUV4ZWN1dG9yID0gdGhpcy5faGFzUnVuQmVmb3JlO1xuICAgIGNvbnN0IGV4aXN0aW5nUnVudGltZSA9IHNhbWVFeGVjdXRvclxuICAgICAgPyAodGhpcy50cmF2ZXJzZXIuZ2V0UnVudGltZSgpIGFzIEluc3RhbmNlVHlwZTx0eXBlb2YgRXhlY3V0aW9uUnVudGltZT4pXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICB0aGlzLl9oYXNSdW5CZWZvcmUgPSB0cnVlOyAvLyBhbnkgcGF0aCB0aGF0IHJlc3VtZXMgY291bnRzIGFzIGEgcnVuXG4gICAgLy8gUmVzdW1lIGdldHMgYSBORVcgcnVuSWQg4oCUIHJlc3VtZSBpcyBsb2dpY2FsbHkgYSBkaXN0aW5jdCBydW4uXG4gICAgLy8gT3JpZ2luYWwgcnVuSWQgaXMgcmVjb3ZlcmFibGUgZnJvbSBjaGVja3BvaW50IG1ldGFkYXRhIGlmIGEgY29uc3VtZXJcbiAgICAvLyBuZWVkcyBjcm9zcy1ydW4gYXVkaXQgKHdlIGRvbid0IHN0b3JlIGl0IG9uIHRoZSBjaGVja3BvaW50IHRvZGF5O1xuICAgIC8vIGZ1dHVyZSBlbmhhbmNlbWVudCkuIFNlZSBgcnVuSWQudHNgLlxuICAgIHRoaXMuX2N1cnJlbnRSdW5JZCA9IGdlbmVyYXRlUnVuSWQoKTtcblxuICAgIC8vIFBpY2sgdGhlIHJlc3VtZSByb290ICsgaW5pdGlhbCBjb250ZXh0LlxuICAgIC8vXG4gICAgLy8gICBST09ULUxFVkVMIFBBVVNFIChzdWJmbG93UGF0aCBlbXB0eSk6XG4gICAgLy8gICAgIHJlc3VtZSByb290ID0gaW5uZXJSZXN1bWVDaGFpbiAocnVuIHJlc3VtZUZuIGF0IHRvcCBsZXZlbCkuXG4gICAgLy8gICAgIGluaXRpYWxDb250ZXh0ID0gY2hlY2twb2ludC5zaGFyZWRTdGF0ZS5cbiAgICAvL1xuICAgIC8vICAgU1VCRkxPVy1ORVNURUQgUEFVU0UgKHN1YmZsb3dQYXRoIG5vbi1lbXB0eSk6XG4gICAgLy8gICAgIFRoZSBwYXVzZSB3YXMgSU5TSURFIGEgc3ViZmxvdydzIGJvZHkuIFRvIHJ1biB0aGUgc3ViZmxvdydzXG4gICAgLy8gICAgIG91dHB1dE1hcHBlciBhbmQgdGhlIHBhcmVudCdzIGNvbnRpbnVhdGlvbiwgd2UgaGF2ZSB0byBlbnRlclxuICAgIC8vICAgICB0aHJvdWdoIHRoZSBPVVRFUiBNT1VOVCAodGhlIHBhcmVudCdzIG5vZGUgdGhhdCBtb3VudHMgdGhlXG4gICAgLy8gICAgIGxlYWYgc3ViZmxvdykuIFdlIHN3YXAgdGhlIGxlYWYgc3ViZmxvdydzIHJvb3Qgd2l0aFxuICAgIC8vICAgICBpbm5lclJlc3VtZUNoYWluIHNvIFN1YmZsb3dFeGVjdXRvcjpcbiAgICAvLyAgICAgICAxLiBlbnRlcnMgdGhlIHN1YmZsb3cgYm91bmRhcnksXG4gICAgLy8gICAgICAgMi4gc2VlZHMgdGhlIG5lc3RlZCBydW50aW1lIGZyb20gc3ViZmxvd1N0YXRlc1tsZWFmXVxuICAgIC8vICAgICAgICAgIChza2lwcGluZyB0aGUgaW5wdXRNYXBwZXIg4oCUIHNlZSBTdWJmbG93RXhlY3V0b3IudHMpLFxuICAgIC8vICAgICAgIDMuIHJ1bnMgdGhlIHJlc3VtZUZuIOKGkiBjb250aW51YXRpb24gY2hhaW4sXG4gICAgLy8gICAgICAgNC4gcnVucyB0aGUgb3V0cHV0TWFwcGVyIGF0IGV4aXQsXG4gICAgLy8gICAgICAgNS4gcGFyZW50IHRyYXZlcnNhbCBjb250aW51ZXMgbm9ybWFsbHkuXG4gICAgLy9cbiAgICAvLyAgICAgQ3Jvc3MtZXhlY3V0b3I6IGluaXRpYWxDb250ZXh0ID0gY2hlY2twb2ludC5zaGFyZWRTdGF0ZSAodGhlXG4gICAgLy8gICAgICAgcGFyZW50J3MgdmlldyBhdCBwYXVzZSB0aW1lIOKAlCBvdXRwdXRNYXBwZXIgd3JpdGVzIGJhY2sgaW50byBpdCkuXG4gICAgLy8gICAgIFNhbWUtZXhlY3V0b3I6IGV4aXN0aW5nUnVudGltZSBpcyByZXVzZWQ7IGluaXRpYWxDb250ZXh0IGlzIG1vb3RcbiAgICAvLyAgICAgICBmb3IgdGhlIHN1YmZsb3cgZnJhbWUgKGFscmVhZHkgaW4gdGhlIHJ1bnRpbWUgc3RhY2spLCBidXQgd2VcbiAgICAvLyAgICAgICBzdGlsbCBwYXNzIHNoYXJlZFN0YXRlIGZvciBjb25zaXN0ZW5jeS5cbiAgICBjb25zdCBmYyA9IHRoaXMuZmxvd0NoYXJ0QXJncy5mbG93Q2hhcnQ7XG4gICAgbGV0IHJlc3VtZVJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0gaW5uZXJSZXN1bWVDaGFpbjtcbiAgICBsZXQgc3ViZmxvd3NPdmVycmlkZTogUmVjb3JkPHN0cmluZywgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9PiB8IHVuZGVmaW5lZDtcbiAgICBpZiAobGVhZlN1YmZsb3dJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBGaW5kIHRoZSBPVVRFUiBtb3VudCBub2RlIGZvciB0aGUgRklSU1QgZW50cnkgb24gdGhlIHBhdGguXG4gICAgICAvLyBGb3Igc2luZ2xlLWxldmVsIHBhdXNlcywgdGhpcyBpcyB0aGUgb25seSBtb3VudCB3ZSBuZWVkIHRvXG4gICAgICAvLyBlbnRlciB0aHJvdWdoLiBGb3IgbmVzdGVkIG1vdW50cyB0aGUgcGF0dGVybiB3b3VsZCBleHRlbmQsIGJ1dFxuICAgICAgLy8gc2luZ2xlLWxldmVsIGNvdmVycyBhbGwgY3VycmVudCB1c2UgY2FzZXMgKFNlcXVlbmNlKEFnZW50KSxcbiAgICAgIC8vIENvbmRpdGlvbmFsKEFnZW50KSwgUGFyYWxsZWwgYnJhbmNoZXMgd2l0aCBwYXVzZWQgYWdlbnRzKS5cbiAgICAgIGNvbnN0IG91dGVyU3ViZmxvd0lkID0gY2hlY2twb2ludC5zdWJmbG93UGF0aFswXTtcbiAgICAgIGNvbnN0IG91dGVyTW91bnQgPSB0aGlzLmZpbmRNb3VudEluR3JhcGgoZmMucm9vdCwgb3V0ZXJTdWJmbG93SWQpO1xuICAgICAgaWYgKG91dGVyTW91bnQpIHtcbiAgICAgICAgcmVzdW1lUm9vdCA9IG91dGVyTW91bnQ7XG4gICAgICB9XG4gICAgICAvLyBSZXBsYWNlIHRoZSBsZWFmIHN1YmZsb3cncyByb290IHdpdGggdGhlIHJlc3VtZSBjaGFpbiBzbyB0aGVcbiAgICAgIC8vIGJvZHkgcnVucyBmcm9tIHRoZSBwYXVzZSBwb2ludCBmb3J3YXJkLlxuICAgICAgc3ViZmxvd3NPdmVycmlkZSA9IHsgLi4uKGZjLnN1YmZsb3dzID8/IHt9KSB9O1xuICAgICAgc3ViZmxvd3NPdmVycmlkZVtsZWFmU3ViZmxvd0lkXSA9IHsgcm9vdDogaW5uZXJSZXN1bWVDaGFpbiB9O1xuICAgIH1cbiAgICAvLyBDbG9uZS1pbiBmb3IgdGhlIHNhbWUgcmVhc29uIGFzIGBzZlN0YXRlc2AgYWJvdmU6IGBpbml0aWFsQ29udGV4dGBcbiAgICAvLyBzZWVkcyB0aGUgZnJlc2ggU2hhcmVkTWVtb3J5IHZpYSBgbWVyZ2VDb250ZXh0V2luc2AsIHdoaWNoIGNvcGllcyBvbmx5XG4gICAgLy8gdGhlIFRPUCBsZXZlbCDigJQgbmVzdGVkIG9iamVjdHMgd291bGQgYWxpYXMgdGhlIGNhbGxlcidzIGNoZWNrcG9pbnQuXG4gICAgY29uc3QgcmVzdW1lSW5pdGlhbENvbnRleHQgPSBzdHJ1Y3R1cmVkQ2xvbmUoY2hlY2twb2ludC5zaGFyZWRTdGF0ZSk7XG5cbiAgICB0aGlzLnRyYXZlcnNlciA9IHRoaXMuY3JlYXRlVHJhdmVyc2VyKFxuICAgICAgb3B0aW9ucz8uc2lnbmFsLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgb3B0aW9ucz8uZW52LFxuICAgICAgb3B0aW9ucz8ubWF4RGVwdGgsXG4gICAgICBvcHRpb25zPy5tYXhJdGVyYXRpb25zLFxuICAgICAge1xuICAgICAgICByb290OiByZXN1bWVSb290LFxuICAgICAgICBpbml0aWFsQ29udGV4dDogcmVzdW1lSW5pdGlhbENvbnRleHQsXG4gICAgICAgIHByZXNlcnZlUmVjb3JkZXJzOiB0cnVlLFxuICAgICAgICAuLi4oZXhpc3RpbmdSdW50aW1lID8geyBleGlzdGluZ1J1bnRpbWUgfSA6IHt9KSxcbiAgICAgICAgLy8gSGFuZCB0aGUgcGVyLXN1YmZsb3cgc2NvcGUgY2FwdHVyZXMgZG93biB0byBTdWJmbG93RXhlY3V0b3IuXG4gICAgICAgIC8vIEFsd2F5cyBwcmVzZW50IG9uIGEgY2hlY2twb2ludCDigJQgZW1wdHkgYHt9YCBmb3Igcm9vdCBwYXVzZXMuXG4gICAgICAgIHN1YmZsb3dTdGF0ZXNGb3JSZXN1bWU6IHNmU3RhdGVzLFxuICAgICAgICAuLi4oc3ViZmxvd3NPdmVycmlkZSAmJiB7IHN1YmZsb3dzT3ZlcnJpZGUgfSksXG4gICAgICB9LFxuICAgICk7XG5cbiAgICAvLyBGaXJlIG9uUmVzdW1lIGV2ZW50IG9uIGFsbCByZWNvcmRlcnMgKGZsb3cgKyBzY29wZSkuIFN0YW1wIHRoZVxuICAgIC8vIHN5bnRoZXRpYyBUcmF2ZXJzYWxDb250ZXh0IGZvciB0aGUgcmVzdW1lZCBzdGFnZSB3aXRoIHRoZSBORVdcbiAgICAvLyBydW5JZCBzbyBjb25zdW1lcnMgZGV0ZWN0IFwidGhpcyBpcyBhIGZyZXNoIGxvZ2ljYWwgcnVuXCIgdmlhXG4gICAgLy8gdGhlIHNhbWUgcnVuSWQtY2hhbmdlIHBhdHRlcm4gdGhleSB1c2UgZm9yIGBvblJ1blN0YXJ0YC5cbiAgICBjb25zdCBoYXNJbnB1dCA9IHJlc3VtZUlucHV0ICE9PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgcmVzdW1lUnVudGltZVN0YWdlSWQgPSBidWlsZFJ1bnRpbWVTdGFnZUlkKHBhdXNlZE5vZGUuaWQsIHRoaXMuX2V4ZWN1dGlvbkNvdW50ZXIudmFsdWUpO1xuICAgIGNvbnN0IGZsb3dSZXN1bWVFdmVudCA9IHtcbiAgICAgIHN0YWdlTmFtZTogcGF1c2VkTm9kZS5uYW1lLFxuICAgICAgc3RhZ2VJZDogcGF1c2VkTm9kZS5pZCxcbiAgICAgIGhhc0lucHV0LFxuICAgICAgdHJhdmVyc2FsQ29udGV4dDoge1xuICAgICAgICBydW5JZDogdGhpcy5fY3VycmVudFJ1bklkLFxuICAgICAgICBzdGFnZUlkOiBwYXVzZWROb2RlLmlkLFxuICAgICAgICBydW50aW1lU3RhZ2VJZDogcmVzdW1lUnVudGltZVN0YWdlSWQsXG4gICAgICAgIHN0YWdlTmFtZTogcGF1c2VkTm9kZS5uYW1lLFxuICAgICAgICBkZXB0aDogMCxcbiAgICAgIH0sXG4gICAgICBjaGFubmVsOiAnZmxvdycgYXMgY29uc3QsXG4gICAgfTtcbiAgICBpZiAodGhpcy5jb21iaW5lZFJlY29yZGVyKSB0aGlzLmNvbWJpbmVkUmVjb3JkZXIub25SZXN1bWUoZmxvd1Jlc3VtZUV2ZW50KTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5mbG93UmVjb3JkZXJzKSByLm9uUmVzdW1lPy4oZmxvd1Jlc3VtZUV2ZW50KTtcblxuICAgIGNvbnN0IHNjb3BlUmVzdW1lRXZlbnQgPSB7XG4gICAgICBzdGFnZU5hbWU6IHBhdXNlZE5vZGUubmFtZSxcbiAgICAgIHN0YWdlSWQ6IHBhdXNlZE5vZGUuaWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogYnVpbGRSdW50aW1lU3RhZ2VJZChwYXVzZWROb2RlLmlkLCB0aGlzLl9leGVjdXRpb25Db3VudGVyLnZhbHVlKSxcbiAgICAgIGhhc0lucHV0LFxuICAgICAgcGlwZWxpbmVJZDogJycsXG4gICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICBjaGFubmVsOiAnc2NvcGUnIGFzIGNvbnN0LFxuICAgIH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuc2NvcGVSZWNvcmRlcnMpIHIub25SZXN1bWU/LihzY29wZVJlc3VtZUV2ZW50KTtcblxuICAgIC8vIERlZmVycmVkIHRpZXIgKFJGQy0wMDEpOiB0aGVzZSBleGVjdXRvci1zeW50aGVzaXplZCBvblJlc3VtZSBldmVudHNcbiAgICAvLyBieXBhc3MgdGhlIHBlci1zdGFnZSBkaXNwYXRjaCBzaXRlcywgc28gY2FwdHVyZSB0aGVtIGRpcmVjdGx5LlxuICAgIGlmICh0aGlzLmRlZmVycmVkVGllcikge1xuICAgICAgdGhpcy5kZWZlcnJlZFRpZXIuY2FwdHVyZSgnZmxvdycsICdvblJlc3VtZScsIHJlc3VtZVJ1bnRpbWVTdGFnZUlkLCB0aGlzLl9jdXJyZW50UnVuSWQsIGZsb3dSZXN1bWVFdmVudCk7XG4gICAgICB0aGlzLmRlZmVycmVkVGllci5jYXB0dXJlKFxuICAgICAgICAnc2NvcGUnLFxuICAgICAgICAnb25SZXN1bWUnLFxuICAgICAgICBzY29wZVJlc3VtZUV2ZW50LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgICBzY29wZVJlc3VtZUV2ZW50LnBpcGVsaW5lSWQsXG4gICAgICAgIHNjb3BlUmVzdW1lRXZlbnQsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIFNldCBBRlRFUiBhbGwgc3luYyB2YWxpZGF0aW9uL2xvb2t1cCB0aHJvd3MgYWJvdmUgKG5vdGhpbmcgY2FuIGxlYWsgdGhlXG4gICAgLy8gZmxhZyk7IG5vIGF3YWl0IGJldHdlZW4gdGhlIHRvcC1vZi1tZXRob2QgY2hlY2sgYW5kIGhlcmUsIHNvIHJhY2UtZnJlZS5cbiAgICB0aGlzLl9pc0V4ZWN1dGluZyA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMudHJhdmVyc2VyLmV4ZWN1dGUoKTtcbiAgICAgIC8vIFRlcm1pbmFsIGZsdXNoIChSRkMtMDAxIEJsb2NrIDgpIOKAlCBzYW1lIGJvdW5kYXJ5IGNvbnRyYWN0IGFzIHJ1bigpLlxuICAgICAgdGhpcy5kZWZlcnJlZFRpZXI/LnRlcm1pbmFsRmx1c2goKTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIHRoaXMuZGVmZXJyZWRUaWVyPy50ZXJtaW5hbEZsdXNoKCk7XG4gICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgdGhpcy5sYXN0Q2hlY2twb2ludCA9IHRoaXMuYnVpbGRQYXVzZUNoZWNrcG9pbnQoZXJyb3IpO1xuICAgICAgICByZXR1cm4geyBwYXVzZWQ6IHRydWUsIGNoZWNrcG9pbnQ6IHRoaXMubGFzdENoZWNrcG9pbnQgfSBzYXRpc2ZpZXMgUGF1c2VkUmVzdWx0O1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuX2lzRXhlY3V0aW5nID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEJ1aWxkIGEgZnVsbHkgREVUQUNIRUQgY2hlY2twb2ludCBmcm9tIGEgY2F1Z2h0IFBhdXNlU2lnbmFsLlxuICAgKlxuICAgKiBFdmVyeSBmaWVsZCBpcyBkZWVwLWNvcGllZCB2aWEgb25lIGBzdHJ1Y3R1cmVkQ2xvbmVgIG9mIHRoZSBhc3NlbWJsZWRcbiAgICogY2hlY2twb2ludCwgYmVjYXVzZSB0aGUgcmF3IHBpZWNlcyBhbGlhcyBsaXZlIGVuZ2luZSBzdGF0ZTpcbiAgICpcbiAgICogICAtIGBzaGFyZWRTdGF0ZWAgSVMgYFNoYXJlZE1lbW9yeWAncyBpbnRlcm5hbCBjb250ZXh0IG9iamVjdCDigJQgdGhlIGFsaWFzXG4gICAqICAgICBvbmx5IGRldGFjaGVzIGF0IHRoZSBuZXh0IGNvbW1pdCAoYGFwcGx5U21hcnRNZXJnZWAgcmVidWlsZHMgaXQpLCBhbmRcbiAgICogICAgIGFmdGVyIGEgcGF1c2UgdGhlcmUgaXMgbm8gbmV4dCBjb21taXQgdW50aWwgcmVzdW1lLlxuICAgKiAgIC0gYGV4ZWN1dGlvblRyZWVgIG5vZGVzIGFyZSBmcmVzaCwgYnV0IHRoZWlyIGBsb2dzYC9gZXJyb3JzYC9gbWV0cmljc2AvXG4gICAqICAgICBgZXZhbHNgL2BzdGFnZVJlYWRzYC9gZmxvd01lc3NhZ2VzYCBmaWVsZHMgcmVmZXJlbmNlIGxpdmVcbiAgICogICAgIGBEaWFnbm9zdGljQ29sbGVjdG9yYCBiYWdzIHRoYXQga2VlcCBhY2N1bXVsYXRpbmcgb24gc2FtZS1leGVjdXRvclxuICAgKiAgICAgcmVzdW1lLlxuICAgKiAgIC0gYHN1YmZsb3dTdGF0ZXNgIHZhbHVlcyBhcmUgc2hhbGxvdyBjb3BpZXMgd2hvc2UgTkVTVEVEIG9iamVjdHMgYWxpYXNcbiAgICogICAgIHN1YmZsb3cgbWVtb3J5LCBhbmQgdGhleSBnZXQgc2VlZGVkIGJhY2sgaW50byBsaXZlIHJ1bnRpbWVzIG9uIHJlc3VtZS5cbiAgICogICAtIGBzdWJmbG93UmVzdWx0c2AgdmFsdWVzIHN0YXkgcmVmZXJlbmNlZCBieSB0aGUgdHJhdmVyc2VyJ3MgcmVzdWx0cyBtYXAuXG4gICAqXG4gICAqIFRoZSBjaGVja3BvaW50IGlzIHBlcnNpc3RlZCBieSBjb250cmFjdCAoXCJzdG9yZSBpbiBSZWRpcy9Qb3N0Z3Jlc1wiKSDigJQgaXRcbiAgICogbXVzdCBuZXZlciBzaGFyZSBzdHJ1Y3R1cmUgd2l0aCB0aGUgZW5naW5lLiBQYXVzZSBpcyBub3QgYSBob3QgcGF0aDsgdGhlXG4gICAqIGNsb25lIGNvc3QgaXMgaXJyZWxldmFudC5cbiAgICpcbiAgICogVGhlIEpTT04tc2FmZSBjaGVja3BvaW50IGNvbnRyYWN0IChubyBmdW5jdGlvbnMsIG5vIGNsYXNzIGluc3RhbmNlcylcbiAgICogZ292ZXJucyBDT05TVU1FUi1vd25lZCBkYXRhIOKAlCBidXQgdGhlIGV4ZWN1dGlvblRyZWUncyBkaWFnbm9zdGljIGJhZ3NcbiAgICogYWNjZXB0IEFOWSB2YWx1ZSBhdCB3cml0ZSB0aW1lIHdpdGhvdXQgY2xvbmluZyAoJGRlYnVnLyRlcnJvci8kbWV0cmljL1xuICAgKiAkZXZhbCBzdG9yZSByYXcgcmVmZXJlbmNlcyksIHNvIGEgY29udHJhY3QtY29tcGxpYW50IHJ1biBjYW4gc3RpbGwgY2FycnlcbiAgICogYSBub24tY2xvbmVhYmxlIGRpYWdub3N0aWMuIE9ic2VydmFiaWxpdHkgc2lkZS1iYWdzIG5ldmVyIGFib3J0IHRyYXZlcnNhbFxuICAgKiBhbnl3aGVyZSBlbHNlIGluIHRoZSBsaWJyYXJ5LCBzbyB0aGV5IG11c3Qgbm90IGFib3J0IHRoZSBwYXVzZSBlaXRoZXI6XG4gICAqIG9uIGNsb25lIGZhaWx1cmUgd2Ugc2FuaXRpemUgdGhlIGRpYWdub3N0aWMgYmFncyAobm9uLWNsb25lYWJsZSB2YWx1ZXNcbiAgICogYmVjb21lICdbbm9uLXNlcmlhbGl6YWJsZTog4oCmXScgbWFya2VycyDigJQgdGhlIGxpdmUgZW5naW5lIGJhZ3MgYXJlIG5ldmVyXG4gICAqIHRvdWNoZWQpIGFuZCByZXRyeS4gSWYgdGhlIHJldHJ5IFNUSUxMIGZhaWxzLCB0aGUgdmlvbGF0aW9uIGlzIGluXG4gICAqIGNvbnN1bWVyLW93bmVkIGRhdGEgKHJlYWxpc3RpY2FsbHkgYHBhdXNlRGF0YWAg4oCUIGEgZnVuY3Rpb24gY2FuIG5ldmVyXG4gICAqIHJlYWNoIHNoYXJlZCBzdGF0ZSBpbiB0aGUgZmlyc3QgcGxhY2U6IFRyYW5zYWN0aW9uQnVmZmVyIGNsb25lcyBldmVyeVxuICAgKiB3cml0dGVuIHZhbHVlIGF0IHdyaXRlIHRpbWUsIHNvIHRoZSBvZmZlbmRpbmcgd3JpdGUgYWxyZWFkeSByZWplY3RlZClcbiAgICogYW5kIHdlIHRocm93IGEgREVTQ1JJUFRJVkUgY29udHJhY3QgZXJyb3IgbmFtaW5nIHRoZSBvZmZlbmRpbmdcbiAgICogY2hlY2twb2ludCBmaWVsZChzKS4gQSBuYWtlZCBEYXRhQ2xvbmVFcnJvciBuZXZlciBlc2NhcGVzLlxuICAgKlxuICAgKiBTdWJmbG93IHNjb3BlIGNhcHR1cmUgKGBzdWJmbG93U3RhdGVzYCkgc3Vydml2ZXMgT05MWSBvbiB0aGUgc2lnbmFsIOKAlCB0aGVcbiAgICogbmVzdGVkIHJ1bnRpbWVzIGFyZSBHQydkIGFzIHRoZSBzdGFjayB1bndpbmRzLiBQcm9tb3RpbmcgaXQgb250byB0aGVcbiAgICogY2hlY2twb2ludCBoZXJlIGxldHMgY3Jvc3MtZXhlY3V0b3IgcmVzdW1lIHJlc3RvcmUgcHJlLXBhdXNlIHN1YmZsb3dcbiAgICogc2NvcGUgKGUuZy4gYW4gQWdlbnQncyBgc2NvcGUuaGlzdG9yeWApLiBFbXB0eSBge31gIGZvciByb290LWxldmVsIHBhdXNlcy5cbiAgICovXG4gIHByaXZhdGUgYnVpbGRQYXVzZUNoZWNrcG9pbnQoc2lnbmFsOiBQYXVzZVNpZ25hbCk6IEZsb3djaGFydENoZWNrcG9pbnQge1xuICAgIGNvbnN0IHNuYXBzaG90ID0gdGhpcy50cmF2ZXJzZXIuZ2V0U25hcHNob3QoKTtcbiAgICBjb25zdCBzZlJlc3VsdHMgPSB0aGlzLnRyYXZlcnNlci5nZXRTdWJmbG93UmVzdWx0cygpO1xuICAgIC8vIExlYW4gc3ViZmxvd1Jlc3VsdHMgZm9yIHRoZSBjaGVja3BvaW50IChkZXNpZ246IGRvY3MvZGVzaWduL3N1YmZsb3ctY29tbWl0LXZpc2liaWxpdHkubWQpOlxuICAgIC8vICAg4oCiIERST1AgdGhlIHBlci1pdGVyYXRpb24gbW91bnQtcnVudGltZVN0YWdlSWQga2V5cyAoJyMnKSB0aGF0IHRoZSBzbmFwc2hvdCBkdWFsLWtleXMg4oCUXG4gICAgLy8gICAgIHRoZXkgd291bGQgRE9VQkxFIHRoZSBjaGVja3BvaW50LCBhbmQgcmVzdW1lIHJlc3RvcmVzIHNjb3BlIGZyb20gYHN1YmZsb3dTdGF0ZXNgLCBub3QgdGhlc2UuXG4gICAgLy8gICDigKIgU1RSSVAgZWFjaCBzdWJmbG93J3MgYHRyZWVDb250ZXh0Lmhpc3RvcnlgIOKAlCByZXN1bWUgTkVWRVIgcmVhZHMgYHN1YmZsb3dSZXN1bHRzYCAoaXRcbiAgICAvLyAgICAgcmVzdG9yZXMgZnJvbSBgc3ViZmxvd1N0YXRlc2AgKyBgc2hhcmVkU3RhdGVgKSwgc28gdGhlIHBlci1zdWJmbG93IGNvbW1pdCBsb2cgaXMgcHVyZVxuICAgIC8vICAgICBjaGVja3BvaW50IGJsb2F0LiBUaGUgZmxhdCBhZ2VudCdzIGNoZWNrcG9pbnQgY2FycmllcyBubyBjb21taXQgaGlzdG9yeSBlaXRoZXIg4oaSIHN5bW1ldHJpYy5cbiAgICBjb25zdCBsZWFuU3ViZmxvd1Jlc3VsdHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2Ygc2ZSZXN1bHRzKSB7XG4gICAgICBpZiAoa2V5LmluY2x1ZGVzKCcjJykpIGNvbnRpbnVlOyAvLyBwZXItaXRlcmF0aW9uIGtleXMgYXJlIHNuYXBzaG90LW9ubHlcbiAgICAgIGNvbnN0IHYgPSB2YWx1ZSBhcyB1bmtub3duIGFzIHsgdHJlZUNvbnRleHQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9O1xuICAgICAgaWYgKHY/LnRyZWVDb250ZXh0KSB7XG4gICAgICAgIGNvbnN0IHRyZWVDdHhSZXN0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IGNrIG9mIE9iamVjdC5rZXlzKHYudHJlZUNvbnRleHQpKSB7XG4gICAgICAgICAgaWYgKGNrICE9PSAnaGlzdG9yeScpIHRyZWVDdHhSZXN0W2NrXSA9IHYudHJlZUNvbnRleHRbY2tdOyAvLyBzdHJpcCB0aGUgcGVyLXN1YmZsb3cgY29tbWl0IGxvZ1xuICAgICAgICB9XG4gICAgICAgIGxlYW5TdWJmbG93UmVzdWx0c1trZXldID0geyAuLi4odmFsdWUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiksIHRyZWVDb250ZXh0OiB0cmVlQ3R4UmVzdCB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbGVhblN1YmZsb3dSZXN1bHRzW2tleV0gPSB2YWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgY2hlY2twb2ludCA9IHtcbiAgICAgIHNoYXJlZFN0YXRlOiBzbmFwc2hvdC5zaGFyZWRTdGF0ZSxcbiAgICAgIGV4ZWN1dGlvblRyZWU6IHNuYXBzaG90LmV4ZWN1dGlvblRyZWUsXG4gICAgICBwYXVzZWRTdGFnZUlkOiBzaWduYWwuc3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dQYXRoOiBzaWduYWwuc3ViZmxvd1BhdGgsXG4gICAgICBwYXVzZURhdGE6IHNpZ25hbC5wYXVzZURhdGEsXG4gICAgICBzdWJmbG93U3RhdGVzOiBzaWduYWwuc3ViZmxvd1N0YXRlcyxcbiAgICAgIC8vIENvdW50ZXIgY29udGludWl0eSDigJQgc2VlZGVkIGJhY2sgaW4gcmVzdW1lKCkgc28gcnVudGltZVN0YWdlSWRzIHN0YXlcbiAgICAgIC8vIHVuaXF1ZSBhbmQgbG9vcEl0ZXJhdGlvbiBzdGF5cyBtb25vdG9uaWMgYWNyb3NzIGEgQ1JPU1MtZXhlY3V0b3IgcmVzdW1lXG4gICAgICAvLyAoYm90aCBhcmUgcGxhaW4gbnVtYmVyL3JlY29yZCwgc28gdGhleSByaWRlIHRoZSBzaW5nbGUgc3RydWN0dXJlZENsb25lXG4gICAgICAvLyBiZWxvdyB1bnRvdWNoZWQpLiBTZWUgdGVzdC9saWIvcGF1c2UvcmVzdW1lLWV4ZWN1dGlvbi1jb3VudGVyLWNvbnRpbnVpdHkudGVzdC50cy5cbiAgICAgIGV4ZWN1dGlvbkNvdW50OiB0aGlzLl9leGVjdXRpb25Db3VudGVyLnZhbHVlLFxuICAgICAgdmlzaXRDb3VudHM6IE9iamVjdC5mcm9tRW50cmllcyh0aGlzLl92aXNpdENvdW50cyksXG4gICAgICAuLi4oT2JqZWN0LmtleXMobGVhblN1YmZsb3dSZXN1bHRzKS5sZW5ndGggPiAwICYmIHsgc3ViZmxvd1Jlc3VsdHM6IGxlYW5TdWJmbG93UmVzdWx0cyB9KSxcbiAgICAgIC8vIEludm9rZXIgY29udGV4dCDigJQgY29sbGVjdGVkIGR1cmluZyB0cmF2ZXJzYWwgYnViYmxlLXVwIChub3QgdHJlZS13YWxrZWQpXG4gICAgICAuLi4oc2lnbmFsLmludm9rZXJTdGFnZUlkICYmIHsgaW52b2tlclN0YWdlSWQ6IHNpZ25hbC5pbnZva2VyU3RhZ2VJZCB9KSxcbiAgICAgIC4uLihzaWduYWwuY29udGludWF0aW9uU3RhZ2VJZCAmJiB7IGNvbnRpbnVhdGlvblN0YWdlSWQ6IHNpZ25hbC5jb250aW51YXRpb25TdGFnZUlkIH0pLFxuICAgICAgcGF1c2VkQXQ6IERhdGUubm93KCksXG4gICAgfTtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZWRDbG9uZShjaGVja3BvaW50KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE5vbi1jbG9uZWFibGUgZGlhZ25vc3RpY3MgbXVzdCBub3Qgc3dhbGxvdyB0aGUgcGF1c2Ug4oCUIHNhbml0aXplIHRoZVxuICAgICAgLy8gZXhlY3V0aW9uVHJlZSdzIGJhZ3MgKG1hcmtlcnMgcmVwbGFjZSB0aGUgb2ZmZW5kZXJzKSBhbmQgcmV0cnkuXG4gICAgICB0cnkge1xuICAgICAgICBjaGVja3BvaW50LmV4ZWN1dGlvblRyZWUgPSBzYW5pdGl6ZURpYWdub3N0aWNCYWdzKGNoZWNrcG9pbnQuZXhlY3V0aW9uVHJlZSBhcyBTdGFnZVNuYXBzaG90KTtcbiAgICAgICAgcmV0dXJuIHN0cnVjdHVyZWRDbG9uZShjaGVja3BvaW50KTtcbiAgICAgIH0gY2F0Y2ggKHJldHJ5RXJyb3IpIHtcbiAgICAgICAgLy8gR2VudWluZSBKU09OLXNhZmUgY29udHJhY3QgdmlvbGF0aW9uIGluIGNvbnN1bWVyLW93bmVkIGRhdGEuXG4gICAgICAgIHRocm93IGRlc2NyaWJlQ2hlY2twb2ludENsb25lRmFpbHVyZShjaGVja3BvaW50LCByZXRyeUVycm9yKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRmluZCBhIFN0YWdlTm9kZSBpbiB0aGUgY29tcGlsZWQgZ3JhcGggYnkgSUQuXG4gICAqIEhhbmRsZXMgc3ViZmxvdyBwYXRocyBieSBkcmlsbGluZyBpbnRvIHJlZ2lzdGVyZWQgc3ViZmxvd3MuXG4gICAqL1xuICBwcml2YXRlIGZpbmROb2RlSW5HcmFwaChzdGFnZUlkOiBzdHJpbmcsIHN1YmZsb3dQYXRoOiByZWFkb25seSBzdHJpbmdbXSk6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBmYyA9IHRoaXMuZmxvd0NoYXJ0QXJncy5mbG93Q2hhcnQ7XG5cbiAgICBpZiAoc3ViZmxvd1BhdGgubGVuZ3RoID09PSAwKSB7XG4gICAgICAvLyBUb3AtbGV2ZWw6IERGUyBmcm9tIHJvb3RcbiAgICAgIHJldHVybiB0aGlzLmRmc0ZpbmQoZmMucm9vdCwgc3RhZ2VJZCk7XG4gICAgfVxuXG4gICAgLy8gU3ViZmxvdzogZHJpbGwgaW50byB0aGUgc3ViZmxvdyBjaGFpbiwgdGhlbiBzZWFyY2ggZnJvbSB0aGUgbGFzdCBzdWJmbG93J3Mgcm9vdFxuICAgIGxldCBzdWJmbG93Um9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfCB1bmRlZmluZWQ7XG4gICAgZm9yIChjb25zdCBzZklkIG9mIHN1YmZsb3dQYXRoKSB7XG4gICAgICBjb25zdCBzdWJmbG93ID0gZmMuc3ViZmxvd3M/LltzZklkXTtcbiAgICAgIGlmICghc3ViZmxvdykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIHN1YmZsb3dSb290ID0gc3ViZmxvdy5yb290O1xuICAgIH1cbiAgICBpZiAoIXN1YmZsb3dSb290KSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHJldHVybiB0aGlzLmRmc0ZpbmQoc3ViZmxvd1Jvb3QsIHN0YWdlSWQpO1xuICB9XG5cbiAgLyoqXG4gICAqIEZpbmQgdGhlIG1vdW50IG5vZGUgKHRoZSBub2RlIHRoYXQgbW91bnRzIGEgc3ViZmxvdyBib3VuZGFyeSlcbiAgICogZm9yIGEgZ2l2ZW4gc3ViZmxvd0lkLCBieSBERlMgZnJvbSBgc3RhcnRgLiBVc2VkIGJ5IGByZXN1bWUoKWAgdG9cbiAgICogbG9jYXRlIHRoZSBPVVRFUiBub2RlIHdlIGhhdmUgdG8gZW50ZXIgdGhyb3VnaCBzbyB0aGUgc3ViZmxvdydzXG4gICAqIG91dHB1dE1hcHBlciBhbmQgcGFyZW50IGNvbnRpbnVhdGlvbiBleGVjdXRlLlxuICAgKlxuICAgKiBDeWNsZS1zYWZlIHZpYSB2aXNpdGVkIHNldC4gUmV0dXJucyB0aGUgZmlyc3QgbWF0Y2ggKERGUyBvcmRlcikuXG4gICAqL1xuICBwcml2YXRlIGZpbmRNb3VudEluR3JhcGgoXG4gICAgc3RhcnQ6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIHN1YmZsb3dJZDogc3RyaW5nLFxuICAgIHZpc2l0ZWQgPSBuZXcgU2V0PHN0cmluZz4oKSxcbiAgKTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfCB1bmRlZmluZWQge1xuICAgIGlmIChzdGFydC5pc0xvb3BSZWYpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgaWYgKHZpc2l0ZWQuaGFzKHN0YXJ0LmlkKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB2aXNpdGVkLmFkZChzdGFydC5pZCk7XG4gICAgaWYgKHN0YXJ0LnN1YmZsb3dJZCA9PT0gc3ViZmxvd0lkKSByZXR1cm4gc3RhcnQ7XG4gICAgaWYgKHN0YXJ0LmNoaWxkcmVuKSB7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHN0YXJ0LmNoaWxkcmVuKSB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gdGhpcy5maW5kTW91bnRJbkdyYXBoKGNoaWxkLCBzdWJmbG93SWQsIHZpc2l0ZWQpO1xuICAgICAgICBpZiAoZm91bmQpIHJldHVybiBmb3VuZDtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHN0YXJ0Lm5leHQpIHJldHVybiB0aGlzLmZpbmRNb3VudEluR3JhcGgoc3RhcnQubmV4dCwgc3ViZmxvd0lkLCB2aXNpdGVkKTtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIERGUyBzZWFyY2ggZm9yIGEgbm9kZSBieSBJRCBpbiB0aGUgU3RhZ2VOb2RlIGdyYXBoLiBDeWNsZS1zYWZlIHZpYSB2aXNpdGVkIHNldC4gKi9cbiAgcHJpdmF0ZSBkZnNGaW5kKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIHRhcmdldElkOiBzdHJpbmcsXG4gICAgdmlzaXRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpLFxuICApOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZCB7XG4gICAgLy8gU2tpcCBsb29wIGJhY2stZWRnZSByZWZlcmVuY2VzICh0aGV5IHNoYXJlIHRoZSB0YXJnZXQncyBJRCBidXQgaGF2ZSBubyBmbi9yZXN1bWVGbilcbiAgICBpZiAobm9kZS5pc0xvb3BSZWYpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgaWYgKHZpc2l0ZWQuaGFzKG5vZGUuaWQpKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHZpc2l0ZWQuYWRkKG5vZGUuaWQpO1xuICAgIGlmIChub2RlLmlkID09PSB0YXJnZXRJZCkgcmV0dXJuIG5vZGU7XG4gICAgaWYgKG5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikge1xuICAgICAgICBjb25zdCBmb3VuZCA9IHRoaXMuZGZzRmluZChjaGlsZCwgdGFyZ2V0SWQsIHZpc2l0ZWQpO1xuICAgICAgICBpZiAoZm91bmQpIHJldHVybiBmb3VuZDtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG5vZGUubmV4dCkgcmV0dXJuIHRoaXMuZGZzRmluZChub2RlLm5leHQsIHRhcmdldElkLCB2aXNpdGVkKTtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIFNjb3BlUmVjb3JkZXIgTWFuYWdlbWVudCDilIDilIDilIBcblxuICAvKipcbiAgICogQXR0YWNoIGEgc2NvcGUgU2NvcGVSZWNvcmRlciB0byBvYnNlcnZlIGRhdGEgb3BlcmF0aW9ucyAocmVhZHMsIHdyaXRlcywgY29tbWl0cykuXG4gICAqIEF1dG9tYXRpY2FsbHkgYXR0YWNoZWQgdG8gZXZlcnkgU2NvcGVGYWNhZGUgY3JlYXRlZCBkdXJpbmcgdHJhdmVyc2FsLlxuICAgKiBNdXN0IGJlIGNhbGxlZCBiZWZvcmUgcnVuKCkuXG4gICAqXG4gICAqICoqSWRlbXBvdGVudCBieSBJRDoqKiBJZiBhIHJlY29yZGVyIHdpdGggdGhlIHNhbWUgYGlkYCBpcyBhbHJlYWR5IGF0dGFjaGVkLFxuICAgKiBpdCBpcyByZXBsYWNlZCAobm90IGR1cGxpY2F0ZWQpLiBUaGlzIHByZXZlbnRzIGRvdWJsZS1jb3VudGluZyB3aGVuIGJvdGhcbiAgICogYSBmcmFtZXdvcmsgYW5kIHRoZSB1c2VyIGF0dGFjaCB0aGUgc2FtZSByZWNvcmRlciB0eXBlLlxuICAgKlxuICAgKiBCdWlsdC1pbiByZWNvcmRlcnMgdXNlIGF1dG8taW5jcmVtZW50IElEcyAoYG1ldHJpY3MtMWAsIGBkZWJ1Zy0xYCwgLi4uKSBieVxuICAgKiBkZWZhdWx0LCBzbyBtdWx0aXBsZSBpbnN0YW5jZXMgd2l0aCBkaWZmZXJlbnQgY29uZmlncyBjb2V4aXN0LiBUbyBvdmVycmlkZVxuICAgKiBhIGZyYW1ld29yay1hdHRhY2hlZCByZWNvcmRlciwgcGFzcyB0aGUgc2FtZSB3ZWxsLWtub3duIElELlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIC8vIE11bHRpcGxlIHJlY29yZGVycyB3aXRoIGRpZmZlcmVudCBjb25maWdzIOKAlCBlYWNoIGdldHMgYSB1bmlxdWUgSURcbiAgICogZXhlY3V0b3IuYXR0YWNoU2NvcGVSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoKSk7XG4gICAqIGV4ZWN1dG9yLmF0dGFjaFNjb3BlUmVjb3JkZXIobmV3IERlYnVnUmVjb3JkZXIoeyB2ZXJib3NpdHk6ICdtaW5pbWFsJyB9KSk7XG4gICAqXG4gICAqIC8vIE92ZXJyaWRlIGEgZnJhbWV3b3JrLWF0dGFjaGVkIHJlY29yZGVyIGJ5IHBhc3NpbmcgaXRzIHdlbGwta25vd24gSURcbiAgICogZXhlY3V0b3IuYXR0YWNoU2NvcGVSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoJ21ldHJpY3MnKSk7XG4gICAqXG4gICAqIC8vIEF0dGFjaGluZyB0d2ljZSB3aXRoIHNhbWUgSUQgcmVwbGFjZXMgKG5vIGRvdWJsZS1jb3VudGluZylcbiAgICogZXhlY3V0b3IuYXR0YWNoU2NvcGVSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoJ215LW1ldHJpY3MnKSk7XG4gICAqIGV4ZWN1dG9yLmF0dGFjaFNjb3BlUmVjb3JkZXIobmV3IE1ldHJpY1JlY29yZGVyKCdteS1tZXRyaWNzJykpOyAvLyByZXBsYWNlcyBwcmV2aW91c1xuICAgKiBgYGBcbiAgICpcbiAgICogKipEZWxpdmVyeSB0aWVyIChSRkMtMDAxKToqKiBwYXNzIGB7IGRlbGl2ZXJ5OiAnZGVmZXJyZWQnIH1gIHRvIHRha2UgdGhlXG4gICAqIHJlY29yZGVyIG91dCBvZiB0aGUgZW5naW5lJ3MgaG90IHBhdGgg4oCUIGV2ZW50cyBhcmUgY2FwdHVyZWQgaW50byBhXG4gICAqIGJvdW5kZWQgcXVldWUgYW5kIGRlbGl2ZXJlZCBhdCB0aGUgbmV4dCBtaWNyb3Rhc2sgY2hlY2twb2ludCAoXCJvbmUgYmVhdFxuICAgKiBiZWhpbmRcIikuIE9taXR0aW5nIGBkZWxpdmVyeWAga2VlcHMgdGhlIGhpc3RvcmljYWwgc3luY2hyb25vdXMgY2FsbCxcbiAgICogYnl0ZS1pZGVudGljYWwgdG8gcHJldmlvdXMgcmVsZWFzZXMuIFJlLWF0dGFjaGluZyB0aGUgc2FtZSBgaWRgIHdpdGggYVxuICAgKiBkaWZmZXJlbnQgdGllciBTV0FQUyB0aWVycyBjbGVhbmx5IOKAlCBuZXZlciBkb3VibGUgZGVsaXZlcnkuIFNlZVxuICAgKiBgZG9jcy9ndWlkZXMvb2JzZXJ2ZXJzLWRlZmVycmVkLm1kYC5cbiAgICovXG4gIGF0dGFjaFNjb3BlUmVjb3JkZXIocmVjb3JkZXI6IFNjb3BlUmVjb3JkZXIsIG9wdGlvbnM/OiBBdHRhY2hSZWNvcmRlck9wdGlvbnMpOiB2b2lkIHtcbiAgICAvLyBUaWVyIHN3YXAsIGJvdGggZGlyZWN0aW9uczogYW4gaWQgbGl2ZXMgb24gZXhhY3RseSBPTkUgdGllciBwZXIgbGlzdC5cbiAgICB0aGlzLnNjb3BlUmVjb3JkZXJzID0gdGhpcy5zY29wZVJlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IHJlY29yZGVyLmlkKTtcbiAgICBpZiAob3B0aW9ucz8uZGVsaXZlcnkgPT09ICdkZWZlcnJlZCcpIHtcbiAgICAgIHRoaXMuZW5zdXJlRGVmZXJyZWRUaWVyKG9wdGlvbnMpLnJlZ2lzdGVyKHJlY29yZGVyLCB7IHNjb3BlOiB0cnVlIH0sIG9wdGlvbnMpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLmRlZmVycmVkVGllcj8ucmVtb3ZlRnJvbUxpc3RzKHJlY29yZGVyLmlkLCB7IHNjb3BlOiB0cnVlIH0pO1xuICAgIHRoaXMuc2NvcGVSZWNvcmRlcnMucHVzaChyZWNvcmRlcik7XG4gIH1cblxuICAvKipcbiAgICogTGF6aWx5IGNyZWF0ZSB0aGUgZXhlY3V0b3IncyBPTkUgZGVmZXJyZWQtb2JzZXJ2ZXIgdGllciAob25lIG1lcmdlZFxuICAgKiBxdWV1ZSwgdG90YWwgZXZlbnQgb3JkZXIgYWNyb3NzIGFsbCB0aHJlZSBjaGFubmVscykuIFRoZSBGSVJTVCBkZWZlcnJlZFxuICAgKiBhdHRhY2gncyBvcHRpb25zIGNvbmZpZ3VyZSB0aGUgZGlzcGF0Y2hlcjsgbGF0ZXIgZGlmZmVyaW5nIG9wdGlvbnMgYXJlXG4gICAqIGRldi13YXJuZWQgYW5kIGlnbm9yZWQgKHNlZSBgQXR0YWNoUmVjb3JkZXJPcHRpb25zYCkuXG4gICAqL1xuICBwcml2YXRlIGVuc3VyZURlZmVycmVkVGllcihvcHRpb25zPzogQXR0YWNoUmVjb3JkZXJPcHRpb25zKTogRGVmZXJyZWRPYnNlcnZlclRpZXIge1xuICAgIGlmICghdGhpcy5kZWZlcnJlZFRpZXIpIHRoaXMuZGVmZXJyZWRUaWVyID0gbmV3IERlZmVycmVkT2JzZXJ2ZXJUaWVyKG9wdGlvbnMpO1xuICAgIHJldHVybiB0aGlzLmRlZmVycmVkVGllcjtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBEZXRhY2ggKFQ0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy9cbiAgLy8gQmFyZS1leGVjdXRvciBlbnRyeSBwb2ludCBmb3IgZmlyZS1hbmQtZm9yZ2V0IGNoaWxkIGZsb3djaGFydCBleGVjdXRpb24uXG4gIC8vIFVzZSBmcm9tIG91dHNpZGUgYW55IGNoYXJ0IChjb25zdW1lciBjb2RlIHRoYXQgd2FudHMgdG8gZGV0YWNoIHdvcmtcbiAgLy8gd2l0aG91dCBmaXJzdCBydW5uaW5nIGEgcGFyZW50IGNoYXJ0KS4gRm9yIGRldGFjaCBGUk9NIElOU0lERSBhIHN0YWdlLFxuICAvLyB1c2UgYHNjb3BlLiRkZXRhY2hBbmRKb2luTGF0ZXIoLi4uKWAgLyBgc2NvcGUuJGRldGFjaEFuZEZvcmdldCguLi4pYCDigJRcbiAgLy8gdGhvc2UgbWludCByZWZJZHMgZnJvbSB0aGUgY2FsbGluZyBzdGFnZSdzIHJ1bnRpbWVTdGFnZUlkIGZvciB0cmFjZVxuICAvLyBjb3JyZWxhdGlvbjsgdGhlIGJhcmUtZXhlY3V0b3IgZW50cmllcyB1c2UgYSBzeW50aGV0aWMgcHJlZml4XG4gIC8vIChgX19leGVjdXRvcl9fYCkgaW5zdGVhZC5cblxuICAvKipcbiAgICogRGV0YWNoIGEgY2hpbGQgZmxvd2NoYXJ0IG9uIHRoZSBnaXZlbiBkcml2ZXIgYW5kIHJldHVybiBhIGBEZXRhY2hIYW5kbGVgXG4gICAqIHRoZSBjYWxsZXIgY2FuIGB3YWl0KClgIG9uIChQcm9taXNlKSBvciByZWFkIGAuc3RhdHVzYCBmcm9tIChzeW5jKS5cbiAgICpcbiAgICogVGhlIGRyaXZlciBpcyBhIFJFUVVJUkVEIGZpcnN0IGFyZ3VtZW50IOKAlCB0aGVyZSBpcyBubyBsaWJyYXJ5LWRlZmF1bHQsXG4gICAqIHRvIGtlZXAgdGhlIGVuZ2luZSBmcmVlIG9mIGRyaXZlciBpbXBvcnRzIGFuZCB0byBtYWtlIHRoZSBjaG9pY2Ugb2ZcbiAgICogc2NoZWR1bGluZyBhbGdvcml0aG0gZXhwbGljaXQgYXQgdGhlIGNhbGwgc2l0ZS5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBpbXBvcnQgeyBtaWNyb3Rhc2tCYXRjaERyaXZlciB9IGZyb20gJ2Zvb3RwcmludGpzL2RldGFjaCc7XG4gICAqXG4gICAqIGNvbnN0IGV4ZWMgPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IocGFyZW50Q2hhcnQpO1xuICAgKiBjb25zdCBoYW5kbGUgPSBleGVjLmRldGFjaEFuZEpvaW5MYXRlcihtaWNyb3Rhc2tCYXRjaERyaXZlciwgdGVsZW1ldHJ5Q2hhcnQsIHsgZXZlbnQ6ICd4JyB9KTtcbiAgICogYXdhaXQgaGFuZGxlLndhaXQoKTsgLy8gb3B0aW9uYWxcbiAgICogYGBgXG4gICAqL1xuICBkZXRhY2hBbmRKb2luTGF0ZXIoXG4gICAgZHJpdmVyOiBpbXBvcnQoJy4uL2RldGFjaC90eXBlcy5qcycpLkRldGFjaERyaXZlcixcbiAgICBjaGlsZDogaW1wb3J0KCcuLi9idWlsZGVyL3R5cGVzLmpzJykuRmxvd0NoYXJ0LFxuICAgIGlucHV0PzogdW5rbm93bixcbiAgKTogaW1wb3J0KCcuLi9kZXRhY2gvdHlwZXMuanMnKS5EZXRhY2hIYW5kbGUge1xuICAgIHJldHVybiBfZGV0YWNoQW5kSm9pbkxhdGVyKGRyaXZlciwgY2hpbGQsIGlucHV0LCAnX19leGVjdXRvcl9fJyk7XG4gIH1cblxuICAvKipcbiAgICogRGV0YWNoIGEgY2hpbGQgZmxvd2NoYXJ0IG9uIHRoZSBnaXZlbiBkcml2ZXIgYW5kIERJU0NBUkQgdGhlIGhhbmRsZS5cbiAgICogVXNlIGZvciB0ZWxlbWV0cnkgZXhwb3J0cyAvIGZpcmUtYW5kLWZvcmdldCBzaWRlIGVmZmVjdHMgd2hlcmUgdGhlXG4gICAqIGNhbGxlciBkb2Vzbid0IGNhcmUgYWJvdXQgdGhlIHJlc3VsdC5cbiAgICpcbiAgICogRXJyb3JzIHJhaXNlZCBieSB0aGUgY2hpbGQgc3RpbGwgbGFuZCBvbiB0aGUgKGRpc2NhcmRlZCkgaGFuZGxlIOKAlCB0aGV5XG4gICAqIGdvIHNpbGVudCB1bmxlc3Mgc3VyZmFjZWQgdGhyb3VnaCBhIHJlY29yZGVyLiBGb3Igb2JzZXJ2YWJsZSBkZXRhY2gsXG4gICAqIHByZWZlciBgZGV0YWNoQW5kSm9pbkxhdGVyYCBhbmQgc3VyZmFjZSBmYWlsdXJlcyB2aWEgYC53YWl0KCkuY2F0Y2goKWAuXG4gICAqL1xuICBkZXRhY2hBbmRGb3JnZXQoXG4gICAgZHJpdmVyOiBpbXBvcnQoJy4uL2RldGFjaC90eXBlcy5qcycpLkRldGFjaERyaXZlcixcbiAgICBjaGlsZDogaW1wb3J0KCcuLi9idWlsZGVyL3R5cGVzLmpzJykuRmxvd0NoYXJ0LFxuICAgIGlucHV0PzogdW5rbm93bixcbiAgKTogdm9pZCB7XG4gICAgX2RldGFjaEFuZEZvcmdldChkcml2ZXIsIGNoaWxkLCBpbnB1dCwgJ19fZXhlY3V0b3JfXycpO1xuICB9XG5cbiAgLyoqIERldGFjaCBhbGwgc2NvcGUgUmVjb3JkZXJzIHdpdGggdGhlIGdpdmVuIElEIOKAlCBib3RoIGRlbGl2ZXJ5IHRpZXJzLiAqL1xuICBkZXRhY2hTY29wZVJlY29yZGVyKGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLnNjb3BlUmVjb3JkZXJzID0gdGhpcy5zY29wZVJlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IGlkKTtcbiAgICB0aGlzLmRlZmVycmVkVGllcj8ucmVtb3ZlRnJvbUxpc3RzKGlkLCB7IHNjb3BlOiB0cnVlIH0pO1xuICB9XG5cbiAgLyoqIFJldHVybnMgYSBkZWZlbnNpdmUgY29weSBvZiBhdHRhY2hlZCBzY29wZSBSZWNvcmRlcnMgKGJvdGggdGllcnMpLiAqL1xuICBnZXRTY29wZVJlY29yZGVycygpOiBTY29wZVJlY29yZGVyW10ge1xuICAgIHJldHVybiBbLi4udGhpcy5zY29wZVJlY29yZGVycywgLi4uKHRoaXMuZGVmZXJyZWRUaWVyPy5zY29wZUxpc3RSZWNvcmRlcnMoKSA/PyBbXSldO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIEZsb3dSZWNvcmRlciBNYW5hZ2VtZW50IOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBBdHRhY2ggYSBGbG93UmVjb3JkZXIgdG8gb2JzZXJ2ZSBjb250cm9sIGZsb3cgZXZlbnRzLlxuICAgKiBBdXRvbWF0aWNhbGx5IGVuYWJsZXMgbmFycmF0aXZlIGlmIG5vdCBhbHJlYWR5IGVuYWJsZWQuXG4gICAqIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBydW4oKSDigJQgcmVjb3JkZXJzIGFyZSBwYXNzZWQgdG8gdGhlIHRyYXZlcnNlciBhdCBjcmVhdGlvbiB0aW1lLlxuICAgKlxuICAgKiAqKklkZW1wb3RlbnQgYnkgSUQ6KiogcmVwbGFjZXMgZXhpc3RpbmcgcmVjb3JkZXIgd2l0aCBzYW1lIGBpZGAuXG4gICAqXG4gICAqICoqRGVsaXZlcnkgdGllciAoUkZDLTAwMSk6KiogcGFzcyBgeyBkZWxpdmVyeTogJ2RlZmVycmVkJyB9YCBmb3JcbiAgICogbmV4dC1jaGVja3BvaW50IGRlbGl2ZXJ5IG9mZiB0aGUgaG90IHBhdGgg4oCUIHNlZSBgYXR0YWNoU2NvcGVSZWNvcmRlcmAuXG4gICAqL1xuICBhdHRhY2hGbG93UmVjb3JkZXIocmVjb3JkZXI6IEZsb3dSZWNvcmRlciwgb3B0aW9ucz86IEF0dGFjaFJlY29yZGVyT3B0aW9ucyk6IHZvaWQge1xuICAgIC8vIFRpZXIgc3dhcCwgYm90aCBkaXJlY3Rpb25zOiBhbiBpZCBsaXZlcyBvbiBleGFjdGx5IE9ORSB0aWVyIHBlciBsaXN0LlxuICAgIHRoaXMuZmxvd1JlY29yZGVycyA9IHRoaXMuZmxvd1JlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IHJlY29yZGVyLmlkKTtcbiAgICB0aGlzLm5hcnJhdGl2ZUVuYWJsZWQgPSB0cnVlO1xuICAgIGlmIChvcHRpb25zPy5kZWxpdmVyeSA9PT0gJ2RlZmVycmVkJykge1xuICAgICAgdGhpcy5lbnN1cmVEZWZlcnJlZFRpZXIob3B0aW9ucykucmVnaXN0ZXIocmVjb3JkZXIsIHsgZmxvdzogdHJ1ZSB9LCBvcHRpb25zKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5kZWZlcnJlZFRpZXI/LnJlbW92ZUZyb21MaXN0cyhyZWNvcmRlci5pZCwgeyBmbG93OiB0cnVlIH0pO1xuICAgIHRoaXMuZmxvd1JlY29yZGVycy5wdXNoKHJlY29yZGVyKTtcbiAgfVxuXG4gIC8qKiBEZXRhY2ggYWxsIEZsb3dSZWNvcmRlcnMgd2l0aCB0aGUgZ2l2ZW4gSUQg4oCUIGJvdGggZGVsaXZlcnkgdGllcnMuICovXG4gIGRldGFjaEZsb3dSZWNvcmRlcihpZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5mbG93UmVjb3JkZXJzID0gdGhpcy5mbG93UmVjb3JkZXJzLmZpbHRlcigocikgPT4gci5pZCAhPT0gaWQpO1xuICAgIHRoaXMuZGVmZXJyZWRUaWVyPy5yZW1vdmVGcm9tTGlzdHMoaWQsIHsgZmxvdzogdHJ1ZSB9KTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGEgZGVmZW5zaXZlIGNvcHkgb2YgYXR0YWNoZWQgRmxvd1JlY29yZGVycyAoYm90aCB0aWVycykuICovXG4gIGdldEZsb3dSZWNvcmRlcnMoKTogRmxvd1JlY29yZGVyW10ge1xuICAgIHJldHVybiBbLi4udGhpcy5mbG93UmVjb3JkZXJzLCAuLi4odGhpcy5kZWZlcnJlZFRpZXI/LmZsb3dMaXN0UmVjb3JkZXJzKCkgPz8gW10pXTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBDb21iaW5lZCBTY29wZVJlY29yZGVyIE1hbmFnZW1lbnQg4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEF0dGFjaCBhIHJlY29yZGVyIHRoYXQgbWF5IG9ic2VydmUgbXVsdGlwbGUgZXZlbnQgc3RyZWFtcyAoc2NvcGVcbiAgICogZGF0YS1mbG93LCBjb250cm9sLWZsb3csIG9yIGJvdGgpLiBEZXRlY3RzIGF0IHJ1bnRpbWUgd2hpY2ggc3RyZWFtcyB0aGVcbiAgICogcmVjb3JkZXIgaGFzIG1ldGhvZHMgZm9yIGFuZCByb3V0ZXMgaXQgdG8gdGhlIGNvcnJlY3QgaW50ZXJuYWwgY2hhbm5lbHMuXG4gICAqXG4gICAqIFByZWZlcnJlZCBvdmVyIGNhbGxpbmcgYGF0dGFjaFNjb3BlUmVjb3JkZXJgIGFuZCBgYXR0YWNoRmxvd1JlY29yZGVyYFxuICAgKiBzZXBhcmF0ZWx5LCBiZWNhdXNlIGZvcmdldHRpbmcgb25lIG9mIHRoZSB0d28gaXMgYSBzaWxlbnQgZm9vdC1ndW4g4oCUXG4gICAqIGhhbGYgeW91ciBldmVudHMgbmV2ZXIgZmlyZSBhbmQgdGhlcmUgaXMgbm8gcnVudGltZSB3YXJuaW5nLiBXaXRoXG4gICAqIGBhdHRhY2hDb21iaW5lZFJlY29yZGVyYCB0aGUgbGlicmFyeSBndWFyYW50ZWVzIHRoZSByZWNvcmRlcidzIGRlY2xhcmVkXG4gICAqIG1ldGhvZHMgYWxsIGZpcmUsIGFuZCBhZGRzIG5vIG92ZXJoZWFkIHZlcnN1cyB0d28gZXhwbGljaXQgY2FsbHMuXG4gICAqXG4gICAqICMjIElkZW1wb3RlbmN5XG4gICAqXG4gICAqIElkZW1wb3RlbnQgYnkgYGlkYCBhY3Jvc3MgQUxMIGNoYW5uZWxzIOKAlCByZS1hdHRhY2hpbmcgd2l0aCB0aGUgc2FtZSBgaWRgXG4gICAqIHJlcGxhY2VzIHRoZSBwcmV2aW91cyBpbnN0YW5jZSBldmVyeXdoZXJlIGl0IHdhcyByZWdpc3RlcmVkLiBNaXhpbmdcbiAgICogYGF0dGFjaENvbWJpbmVkUmVjb3JkZXIoeClgIHdpdGggYSBwcmlvciBgYXR0YWNoU2NvcGVSZWNvcmRlcih5KWAgb3JcbiAgICogYGF0dGFjaEZsb3dSZWNvcmRlcih5KWAgdGhhdCBzaGFyZSBgeC5pZCA9PT0geS5pZGAgaXMgYWxzbyBzYWZlOiB0aGVcbiAgICogY29tYmluZWQgYXR0YWNoIHJlcGxhY2VzIHRoZSBzaW5nbGUtY2hhbm5lbCByZWdpc3RyYXRpb24gb24gd2hpY2hldmVyXG4gICAqIGNoYW5uZWwocykgYHhgIGhhcyBtZXRob2RzIGZvci4gTm8gZHVwbGljYXRlIGZpcmluZ3Mgb2NjdXIuXG4gICAqXG4gICAqICMjIE5hcnJhdGl2ZSBhY3RpdmF0aW9uXG4gICAqXG4gICAqIElmIHRoZSByZWNvcmRlciBoYXMgYW55IGNvbnRyb2wtZmxvdyBtZXRob2RzLCBgZW5hYmxlTmFycmF0aXZlKClgIGlzXG4gICAqIGNhbGxlZCBhcyBhIHNpZGUgZWZmZWN0ICh0aGUgbmFycmF0aXZlIHN1YnN5c3RlbSBpcyByZXF1aXJlZCB0byBlbWl0XG4gICAqIGNvbnRyb2wtZmxvdyBldmVudHMpLiBEYXRhLWZsb3ctb25seSByZWNvcmRlcnMgZG8gTk9UIGFjdGl2YXRlIHRoZVxuICAgKiBuYXJyYXRpdmUuXG4gICAqXG4gICAqICMjIERldGVjdGlvbiBydWxlXG4gICAqXG4gICAqIE9ubHkgKipvd24qKiBldmVudCBtZXRob2RzIGNvdW50IChzZWUgYGhhc1JlY29yZGVyTWV0aG9kc2ApLiBNZXRob2RzXG4gICAqIGluaGVyaXRlZCB2aWEgdGhlIHByb3RvdHlwZSBjaGFpbiBhcmUgaWdub3JlZCDigJQgdGhpcyBwcm90ZWN0cyBhZ2FpbnN0XG4gICAqIGFjY2lkZW50YWwgYE9iamVjdC5wcm90b3R5cGVgIHBvbGx1dGlvbiBhdHRhY2hpbmcgaGFuZGxlcnMgeW91IG5ldmVyXG4gICAqIGRlY2xhcmVkLiBBIHJlY29yZGVyIHRoYXQgcHJvdmlkZXMgb25seSBgY2xlYXJgL2B0b1NuYXBzaG90YCBpcyBhXG4gICAqIG5vLW9wIGFuZCBlbWl0cyBhIGRldi1tb2RlIHdhcm5pbmcgdG8gc3VyZmFjZSB0aGUgbGlrZWx5IG1pc3Rha2UuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogY29uc3QgYXVkaXQ6IENvbWJpbmVkUmVjb3JkZXIgPSB7XG4gICAqICAgaWQ6ICdhdWRpdCcsXG4gICAqICAgb25Xcml0ZTogKGUpID0+IGxvZygnc2NvcGUgd3JpdGUnLCBlLmtleSksXG4gICAqICAgb25EZWNpc2lvbjogKGUpID0+IGxvZygncm91dGVkIHRvJywgZS5jaG9zZW4pLFxuICAgKiB9O1xuICAgKiBleGVjdXRvci5hdHRhY2hDb21iaW5lZFJlY29yZGVyKGF1ZGl0KTtcbiAgICogYGBgXG4gICAqL1xuICBhdHRhY2hDb21iaW5lZFJlY29yZGVyKHJlY29yZGVyOiBDb21iaW5lZFJlY29yZGVyLCBvcHRpb25zPzogQXR0YWNoUmVjb3JkZXJPcHRpb25zKTogdm9pZCB7XG4gICAgY29uc3QgaGFzRGF0YSA9IGhhc1JlY29yZGVyTWV0aG9kcyhyZWNvcmRlcik7XG4gICAgY29uc3QgaGFzRmxvdyA9IGhhc0Zsb3dSZWNvcmRlck1ldGhvZHMocmVjb3JkZXIpO1xuICAgIGNvbnN0IGhhc0VtaXQgPSBoYXNFbWl0UmVjb3JkZXJNZXRob2RzKHJlY29yZGVyKTtcblxuICAgIC8vIERlbGl2ZXJ5IHRpZXIgKFJGQy0wMDEpOiBvcHRpb25zIGJhZyBPUiB0aGUgcmVjb3JkZXIncyBvd25cbiAgICAvLyBgZGVsaXZlcnk6ICdkZWZlcnJlZCdgIGZpZWxkLiBUaGUgZmllbGQgaXMgYSBzdHJpbmcg4oCUIGNoYW5uZWwgcm91dGluZ1xuICAgIC8vIGFib3ZlIGNvdW50cyBldmVudC1NRVRIT0QgcHJvcGVydGllcyBvbmx5LCBzbyBkZWNsYXJpbmcgaXQgbmV2ZXJcbiAgICAvLyBjaGFuZ2VzIHdoaWNoIGNoYW5uZWxzIHRoZSByZWNvcmRlciBsYW5kcyBvbi5cbiAgICBjb25zdCBkZWxpdmVyeSA9IG9wdGlvbnM/LmRlbGl2ZXJ5ID8/IHJlY29yZGVyLmRlbGl2ZXJ5O1xuICAgIGNvbnN0IHRpZXJPcHRpb25zOiBBdHRhY2hSZWNvcmRlck9wdGlvbnMgfCB1bmRlZmluZWQgPSBkZWxpdmVyeSA9PT0gdW5kZWZpbmVkID8gb3B0aW9ucyA6IHsgLi4ub3B0aW9ucywgZGVsaXZlcnkgfTtcblxuICAgIC8vIEVtaXQgcmVjb3JkZXJzIGxpdmUgb24gdGhlIFNBTUUgY2hhbm5lbCBhcyBkYXRhLWZsb3cgcmVjb3JkZXJzXG4gICAgLy8gKFNjb3BlRmFjYWRlIGl0ZXJhdGVzIGBfcmVjb3JkZXJzYCBmb3Igb25FbWl0IGRpc3BhdGNoKS4gU29cbiAgICAvLyBhdHRhY2hFbWl0UmVjb3JkZXIgaW50ZXJuYWxseSBjYWxscyBhdHRhY2hTY29wZVJlY29yZGVyIOKAlCBidXQgd2Ugd2FudCB0b1xuICAgIC8vIGF2b2lkIGRvdWJsZS1hdHRhY2ggd2hlbiB0aGUgcmVjb3JkZXIgaW1wbGVtZW50cyBCT1RIIG9uRW1pdCBBTkRcbiAgICAvLyBvdGhlciBTY29wZVJlY29yZGVyIG1ldGhvZHMuIFNob3J0LWNpcmN1aXQ6IGlmIGhhc0RhdGEgT1IgaGFzRW1pdCwgdGhlXG4gICAgLy8gcmVjb3JkZXIgbGFuZHMgb24gdGhlIHNjb3BlLXJlY29yZGVyIGxpc3QgZXhhY3RseSBvbmNlLlxuICAgIGlmIChoYXNEYXRhIHx8IGhhc0VtaXQpIHRoaXMuYXR0YWNoU2NvcGVSZWNvcmRlcihyZWNvcmRlciBhcyBTY29wZVJlY29yZGVyLCB0aWVyT3B0aW9ucyk7XG4gICAgaWYgKGhhc0Zsb3cpIHRoaXMuYXR0YWNoRmxvd1JlY29yZGVyKHJlY29yZGVyIGFzIEZsb3dSZWNvcmRlciwgdGllck9wdGlvbnMpO1xuXG4gICAgaWYgKCFoYXNEYXRhICYmICFoYXNGbG93ICYmICFoYXNFbWl0ICYmIGlzRGV2TW9kZSgpKSB7XG4gICAgICAvLyBEZXYtbW9kZSBvbmx5OiBzaWxlbnQgc2tpcHMgYXJlIGludmlzaWJsZSBhbmQgcHJvZHVjZSBoYXJkLXRvLWRlYnVnXG4gICAgICAvLyBcIndoeSBkaWRuJ3QgbXkgcmVjb3JkZXIgZmlyZVwiIHJlcG9ydHMuIFBlciBsaWJyYXJ5IGNvbnZlbnRpb24sIGdhdGVkXG4gICAgICAvLyBvbiB0aGUgY2VudHJhbCBpc0Rldk1vZGUoKSBmbGFnIChub3QgcHJvY2Vzcy5lbnYpIHNvIGNvbnN1bWVycyBjYW5cbiAgICAgIC8vIGNvbnRyb2wgZGV2IHRvb2xpbmcgY2VudHJhbGx5IHZpYSBlbmFibGVEZXZNb2RlKCkvZGlzYWJsZURldk1vZGUoKS5cbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgIGBbZm9vdHByaW50anNdIGF0dGFjaENvbWJpbmVkUmVjb3JkZXI6IHJlY29yZGVyICcke3JlY29yZGVyLmlkfScgaGFzIGAgK1xuICAgICAgICAgICdubyBvYnNlcnZlciBldmVudCBtZXRob2RzIOKAlCBub3RoaW5nIHRvIGF0dGFjaC4gRGlkIHlvdSBmb3JnZXQgdG8gJyArXG4gICAgICAgICAgJ2FkZCBhbiBvbiogaGFuZGxlciAob25Xcml0ZSwgb25EZWNpc2lvbiwgb25TdWJmbG93RW50cnksIC4uLik/ICcgK1xuICAgICAgICAgICdOb3RlOiBvbmx5IE9XTiBwcm9wZXJ0aWVzIGNvdW50OyBtZXRob2RzIG9uIHRoZSBwcm90b3R5cGUgY2hhaW4gJyArXG4gICAgICAgICAgJ2FyZSBpZ25vcmVkIG9uIHB1cnBvc2UuJyxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIERldGFjaCBhIGNvbWJpbmVkIHJlY29yZGVyIGZyb20gYWxsIGNoYW5uZWxzIGl0IHdhcyBhdHRhY2hlZCB0by5cbiAgICogU2FmZSB0byBjYWxsIGlmIHRoZSByZWNvcmRlciB3YXMgb25seSBvbiBvbmUgY2hhbm5lbCBvciBuZXZlciBhdHRhY2hlZC5cbiAgICovXG4gIGRldGFjaENvbWJpbmVkUmVjb3JkZXIoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMuZGV0YWNoU2NvcGVSZWNvcmRlcihpZCk7XG4gICAgdGhpcy5kZXRhY2hGbG93UmVjb3JkZXIoaWQpO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIEVtaXQgU2NvcGVSZWNvcmRlciBNYW5hZ2VtZW50IChQaGFzZSAzKSDilIDilIDilIBcblxuICAvKipcbiAgICogQXR0YWNoIGFuIGBFbWl0UmVjb3JkZXJgIOKAlCBhbiBvYnNlcnZlciBmb3IgY29uc3VtZXItZW1pdHRlZCBzdHJ1Y3R1cmVkXG4gICAqIGV2ZW50cyBmaXJlZCB2aWEgYHNjb3BlLiRlbWl0KG5hbWUsIHBheWxvYWQpYC5cbiAgICpcbiAgICogSW50ZXJuYWxseSwgZW1pdCByZWNvcmRlcnMgc2hhcmUgdGhlIHNjb3BlLXJlY29yZGVyIGNoYW5uZWwgYmVjYXVzZVxuICAgKiBlbWl0IGV2ZW50cyBmaXJlIGZyb20gaW5zaWRlIGBTY29wZUZhY2FkZWAgZHVyaW5nIHN0YWdlIGV4ZWN1dGlvbixcbiAgICogc2FtZSB0aW1pbmcgYXMgYG9uUmVhZGAvYG9uV3JpdGVgLiBUaGlzIG1ldGhvZCBpcyBhIGNvbnZlbmllbmNlIHRoYXRcbiAgICogZGVsZWdhdGVzIHRvIGBhdHRhY2hTY29wZVJlY29yZGVyYCDigJQgY29uc3VtZXJzIGNhbiBhbHNvIHVzZVxuICAgKiBgYXR0YWNoU2NvcGVSZWNvcmRlcmAgZGlyZWN0bHkgZm9yIGEgcmVjb3JkZXIgdGhhdCBpbXBsZW1lbnRzIEJPVEhcbiAgICogYG9uV3JpdGVgIGFuZCBgb25FbWl0YC4gRWl0aGVyIGFwcHJvYWNoIHBsYWNlcyB0aGUgcmVjb3JkZXIgb24gdGhlXG4gICAqIHNhbWUgdW5kZXJseWluZyBsaXN0LCBzbyBgb25FbWl0YCBmaXJlcyBleGFjdGx5IG9uY2UgcGVyIGV2ZW50LlxuICAgKlxuICAgKiAqKklkZW1wb3RlbnQgYnkgYGlkYDoqKiByZXBsYWNlcyBleGlzdGluZyByZWNvcmRlciB3aXRoIHNhbWUgYGlkYC5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBleGVjdXRvci5hdHRhY2hFbWl0UmVjb3JkZXIoe1xuICAgKiAgIGlkOiAndG9rZW4tbWV0ZXInLFxuICAgKiAgIG9uRW1pdDogKGUpID0+IHtcbiAgICogICAgIGlmIChlLm5hbWUgPT09ICdhZ2VudGZvb3RwcmludC5sbG0udG9rZW5zJykgdHJhY2tUb2tlbnMoZS5wYXlsb2FkKTtcbiAgICogICB9LFxuICAgKiB9KTtcbiAgICogYGBgXG4gICAqL1xuICBhdHRhY2hFbWl0UmVjb3JkZXIocmVjb3JkZXI6IEVtaXRSZWNvcmRlciwgb3B0aW9ucz86IEF0dGFjaFJlY29yZGVyT3B0aW9ucyk6IHZvaWQge1xuICAgIHRoaXMuYXR0YWNoU2NvcGVSZWNvcmRlcihyZWNvcmRlciBhcyBTY29wZVJlY29yZGVyLCBvcHRpb25zKTtcbiAgfVxuXG4gIC8qKiBEZXRhY2ggYW4gYEVtaXRSZWNvcmRlcmAgYnkgaWQuIFNhZmUgdG8gY2FsbCBpZiBuZXZlciBhdHRhY2hlZC4gKi9cbiAgZGV0YWNoRW1pdFJlY29yZGVyKGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmRldGFjaFNjb3BlUmVjb3JkZXIoaWQpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgYSBkZWZlbnNpdmUgY29weSBvZiBhdHRhY2hlZCByZWNvcmRlcnMgKGJvdGggZGVsaXZlcnkgdGllcnMpXG4gICAqIGZpbHRlcmVkIHRvIHRob3NlIHRoYXQgaW1wbGVtZW50IGBvbkVtaXRgLiBVc2VmdWwgZm9yIGluc3BlY3Rpb24gZHVyaW5nXG4gICAqIHRlc3RpbmcuXG4gICAqL1xuICBnZXRFbWl0UmVjb3JkZXJzKCk6IEVtaXRSZWNvcmRlcltdIHtcbiAgICByZXR1cm4gdGhpcy5nZXRTY29wZVJlY29yZGVycygpLmZpbHRlcihcbiAgICAgIChyKTogciBpcyBFbWl0UmVjb3JkZXIgPT4gdHlwZW9mIChyIGFzIHsgb25FbWl0PzogdW5rbm93biB9KS5vbkVtaXQgPT09ICdmdW5jdGlvbicsXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHN0cnVjdHVyZWQgbmFycmF0aXZlIGVudHJpZXMg4oCUIHRoZSBzaW5nbGUgcHVibGljIG5hcnJhdGl2ZSBBUEkuXG4gICAqIEVhY2ggZW50cnkgaGFzIGEgdHlwZSAoc3RhZ2UsIHN0ZXAsIGNvbmRpdGlvbiwgZm9yaywgZXRjLiksIHRleHQsIGFuZFxuICAgKiBkZXB0aC4gQ29uc3VtZXJzIHJlbmRlciBob3dldmVyIHRoZXkgd2FudDsgY2FsbCBgLm1hcChlID0+IGUudGV4dClgXG4gICAqIGlmIGEgZmxhdCBgc3RyaW5nW11gIGlzIG5lZWRlZCBsb2NhbGx5LlxuICAgKi9cbiAgZ2V0TmFycmF0aXZlRW50cmllcygpOiBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5W10ge1xuICAgIGlmICh0aGlzLmNvbWJpbmVkUmVjb3JkZXIpIHtcbiAgICAgIHJldHVybiB0aGlzLmNvbWJpbmVkUmVjb3JkZXIuZ2V0RW50cmllcygpO1xuICAgIH1cbiAgICBjb25zdCBmbG93U2VudGVuY2VzID0gdGhpcy50cmF2ZXJzZXIuZ2V0TmFycmF0aXZlKCk7XG4gICAgcmV0dXJuIGZsb3dTZW50ZW5jZXMubWFwKCh0ZXh0KSA9PiAoeyB0eXBlOiAnc3RhZ2UnIGFzIGNvbnN0LCB0ZXh0LCBkZXB0aDogMCB9KSk7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgY29tYmluZWQgRmxvd1JlY29yZGVycyBsaXN0LiBXaGVuIG5hcnJhdGl2ZSBpcyBlbmFibGVkLFxuICAgKiBpbmNsdWRlcyB0aGUgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciAod2hpY2ggYnVpbGRzIG1lcmdlZCBmbG93K2RhdGFcbiAgICogZW50cmllcyBpbmxpbmUpLiBQbHVzIGFueSB1c2VyLWF0dGFjaGVkIHJlY29yZGVycy5cbiAgICovXG4gIHByaXZhdGUgYnVpbGRGbG93UmVjb3JkZXJzTGlzdCgpOiBGbG93UmVjb3JkZXJbXSB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgcmVjb3JkZXJzOiBGbG93UmVjb3JkZXJbXSA9IFtdO1xuICAgIGlmICh0aGlzLmNvbWJpbmVkUmVjb3JkZXIpIHtcbiAgICAgIHJlY29yZGVycy5wdXNoKHRoaXMuY29tYmluZWRSZWNvcmRlcik7XG4gICAgfVxuICAgIHJlY29yZGVycy5wdXNoKC4uLnRoaXMuZmxvd1JlY29yZGVycyk7XG4gICAgLy8gRGVmZXJyZWQtb2JzZXJ2ZXIgZmxvdyB0YXAgKFJGQy0wMDEgQmxvY2sgNykg4oCUIGNhcHR1cmVzIGV2ZXJ5IGZsb3dcbiAgICAvLyBldmVudCBmb3IgZGVmZXJyZWQgbGlzdGVuZXJzLiBBcHBlbmRlZCBsaWtlIGFueSBvdGhlciBmbG93IHJlY29yZGVyLFxuICAgIC8vIHNvIHRoZSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyIHNpdGUgbmVlZHMgbm8gdGllciBsb2dpYyBvZiBpdHMgb3duLlxuICAgIGNvbnN0IGZsb3dUYXAgPSB0aGlzLmRlZmVycmVkVGllcj8uYnVpbGRGbG93VGFwKCk7XG4gICAgaWYgKGZsb3dUYXApIHJlY29yZGVycy5wdXNoKGZsb3dUYXApO1xuICAgIHJldHVybiByZWNvcmRlcnMubGVuZ3RoID4gMCA/IHJlY29yZGVycyA6IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBFeGVjdXRlIHRoZSBjaGFydC4gUmVzb2x2ZXMgd2hlbiB0aGUgcnVuIGZpbmlzaGVzIOKAlCBvciBwYXVzZXMsIGlmIGFcbiAgICogcGF1c2FibGUgc3RhZ2UgcmV0dXJuZWQgZGF0YSAoY2hlY2sgYGlzUGF1c2VkKClgIGFmdGVyd2FyZCkuXG4gICAqXG4gICAqIEBwYXJhbSBvcHRpb25zIGB7IGlucHV0LCBlbnYgfWAg4oCUIGBpbnB1dGAgaXMgdGhlIGZyb3plbiBidXNpbmVzcyBpbnB1dFxuICAgKiAgIChyZWFkIGluIGEgc3RhZ2UgdmlhIGBzY29wZS4kZ2V0QXJncygpYCk7IGBlbnZgIGlzIGluZnJhc3RydWN0dXJlIGNvbnRleHRcbiAgICogICBsaWtlIGB7IHNpZ25hbCwgdGltZW91dE1zLCB0cmFjZUlkIH1gIChyZWFkIHZpYSBgc2NvcGUuJGdldEVudigpYCkuXG4gICAqXG4gICAqIEFmdGVyIGl0IHJlc29sdmVzLCByZWFkIHJlc3VsdHMgb2ZmIHRoZSBleGVjdXRvcjpcbiAgICogLSBgZ2V0U25hcHNob3QoKWAg4oCUIGZ1bGwgc3RhdGUsIGNvbW1pdCBsb2csIGV4ZWN1dGlvbiB0cmVlLlxuICAgKiAtIGBnZXROYXJyYXRpdmVFbnRyaWVzKClgIOKAlCB0aGUgcGxhaW4tRW5nbGlzaCB0cmFjZSAoY2FsbCBgZW5hYmxlTmFycmF0aXZlKClgXG4gICAqICAgb3IgYXR0YWNoIGEgYG5hcnJhdGl2ZSgpYCByZWNvcmRlciBmaXJzdCkuXG4gICAqIC0gYGlzUGF1c2VkKClgIOKAlCB0cnVlIGlmIGEgc3RhZ2UgcGF1c2VkOyB0aGVuIHVzZSBgZ2V0Q2hlY2twb2ludCgpYCAvIGByZXN1bWUoKWAuXG4gICAqXG4gICAqIE9uZSBydW4gYXQgYSB0aW1lIHBlciBleGVjdXRvciDigJQgaXQgaG9sZHMgcGVyLXJ1biBzdGF0ZSAocnVuSWQsIHJlY29yZGVycyxcbiAgICogY2hlY2twb2ludCkuIENyZWF0ZSBvbmUgZXhlY3V0b3IgcGVyIGNvbmN1cnJlbnQgcnVuLlxuICAgKi9cbiAgYXN5bmMgcnVuKG9wdGlvbnM/OiBSdW5PcHRpb25zKTogUHJvbWlzZTxFeGVjdXRvclJlc3VsdD4ge1xuICAgIC8vIFJlLWVudHJhbmN5IGd1YXJkIEZJUlNUIOKAlCBiZWZvcmUgY2xlYXJpbmcgcmVjb3JkZXJzIG9yIHRvdWNoaW5nIGFueVxuICAgIC8vIHBlci1ydW4gZmllbGQsIHNvIGEgcmVqZWN0ZWQgY29uY3VycmVudCBjYWxsIGxlYXZlcyB0aGUgaW4tZmxpZ2h0IHJ1blxuICAgIC8vIGNvbXBsZXRlbHkgdW50b3VjaGVkLlxuICAgIGlmICh0aGlzLl9pc0V4ZWN1dGluZykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAnRmxvd0NoYXJ0RXhlY3V0b3I6IHJ1bigpIGNhbGxlZCB3aGlsZSBhbm90aGVyIHJ1bigpL3Jlc3VtZSgpIGlzIGluIGZsaWdodCBvbiB0aGlzICcgK1xuICAgICAgICAgICdleGVjdXRvci4gQW4gZXhlY3V0b3IgaG9sZHMgcGVyLXJ1biBzdGF0ZSAocnVuSWQsIHJlY29yZGVycywgY2hlY2twb2ludCkg4oCUIGNyZWF0ZSAnICtcbiAgICAgICAgICAnb25lIGV4ZWN1dG9yIHBlciBjb25jdXJyZW50IHJ1bi4gU2VlIGRvY3MvZ3VpZGVzL2V4ZWN1dGlvbi1tb2RlbC5tZC4nLFxuICAgICAgKTtcbiAgICB9XG4gICAgLy8gVmFsaWRhdGUgaW5wdXQgYWdhaW5zdCBpbnB1dFNjaGVtYSBpZiBib3RoIGFyZSBwcmVzZW50LiBWYWxpZGF0aW9uIHJ1bnNcbiAgICAvLyBCRUZPUkUgdGhlIHRpbWVvdXQgdGltZXIgaXMgY3JlYXRlZCBzbyBhIHJlamVjdGVkIGlucHV0IGNhbid0IGxlYWsgYVxuICAgIC8vIHBlbmRpbmcgdGltZXIgKHNhbWUgXCJmYWlsZWQgZW50cnkgbGVhdmVzIG5vIHNpZGUgZWZmZWN0c1wiIHJ1bGUgYXMgdGhlXG4gICAgLy8gcmUtZW50cmFuY3kgZ3VhcmQgYWJvdmUpLlxuICAgIGxldCB2YWxpZGF0ZWRJbnB1dCA9IG9wdGlvbnM/LmlucHV0O1xuICAgIGlmICh2YWxpZGF0ZWRJbnB1dCAmJiB0aGlzLmZsb3dDaGFydEFyZ3MuZmxvd0NoYXJ0LmlucHV0U2NoZW1hKSB7XG4gICAgICB2YWxpZGF0ZWRJbnB1dCA9IHZhbGlkYXRlSW5wdXQodGhpcy5mbG93Q2hhcnRBcmdzLmZsb3dDaGFydC5pbnB1dFNjaGVtYSwgdmFsaWRhdGVkSW5wdXQpO1xuICAgIH1cblxuICAgIGxldCBzaWduYWwgPSBvcHRpb25zPy5zaWduYWw7XG4gICAgbGV0IHRpbWVvdXRJZDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG5cbiAgICAvLyBDcmVhdGUgYW4gaW50ZXJuYWwgQWJvcnRDb250cm9sbGVyIGZvciB0aW1lb3V0TXNcbiAgICBpZiAob3B0aW9ucz8udGltZW91dE1zICYmICFzaWduYWwpIHtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBzaWduYWwgPSBjb250cm9sbGVyLnNpZ25hbDtcbiAgICAgIHRpbWVvdXRJZCA9IHNldFRpbWVvdXQoXG4gICAgICAgICgpID0+IGNvbnRyb2xsZXIuYWJvcnQobmV3IEVycm9yKGBFeGVjdXRpb24gdGltZWQgb3V0IGFmdGVyICR7b3B0aW9ucy50aW1lb3V0TXN9bXNgKSksXG4gICAgICAgIG9wdGlvbnMudGltZW91dE1zLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBVc2VyLWF0dGFjaGVkIHJlY29yZGVycyAoZmxvd1JlY29yZGVycyArIHNjb3BlUmVjb3JkZXJzKSBhcmUgY2xlYXJlZCB2aWEgY2xlYXIoKSB0byBwcmV2ZW50XG4gICAgLy8gY3Jvc3MtcnVuIGFjY3VtdWxhdGlvbi4gVGhlIGNvbWJpbmVkUmVjb3JkZXIgaXMgTk9UIGNsZWFyZWQgaGVyZSDigJQgY3JlYXRlVHJhdmVyc2VyKCkgYWx3YXlzXG4gICAgLy8gY3JlYXRlcyBhIGZyZXNoIENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgaW5zdGFuY2Ugb24gZWFjaCBydW4sIHNvIHN0YWxlIHN0YXRlIGlzIG5ldmVyIGFuIGlzc3VlLlxuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLmZsb3dSZWNvcmRlcnMpIHtcbiAgICAgIHIuY2xlYXI/LigpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5zY29wZVJlY29yZGVycykge1xuICAgICAgci5jbGVhcj8uKCk7XG4gICAgfVxuICAgIHRoaXMuZGVmZXJyZWRUaWVyPy5jbGVhclJlY29yZGVycygpO1xuXG4gICAgdGhpcy5sYXN0Q2hlY2twb2ludCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLl9leGVjdXRpb25Db3VudGVyID0geyB2YWx1ZTogMCB9OyAvLyBSZXNldCBjb3VudGVyIG9uIGZyZXNoIHJ1blxuICAgIHRoaXMuX3Zpc2l0Q291bnRzID0gbmV3IE1hcCgpOyAvLyBSZXNldCBsb29wLWl0ZXJhdGlvbiBjb3VudHMgb24gZnJlc2ggcnVuICh0d2luIG9mIF9leGVjdXRpb25Db3VudGVyKVxuICAgIHRoaXMuX2N1cnJlbnRSdW5JZCA9IGdlbmVyYXRlUnVuSWQoKTsgLy8gRnJlc2ggcnVuSWQgcGVyIHJ1bigpIGNhbGxcbiAgICB0aGlzLl9oYXNSdW5CZWZvcmUgPSB0cnVlOyAvLyBtYXJrIHNvIGEgbGF0ZXIgcmVzdW1lKCkgdGFrZXMgdGhlXG4gICAgLy8gc2FtZS1leGVjdXRvciBicmFuY2ggKHJldXNlIHJ1bnRpbWUsIGFjY3VtdWxhdGUgZXhlY3V0aW9uIHRyZWUpLlxuICAgIHRoaXMudHJhdmVyc2VyID0gdGhpcy5jcmVhdGVUcmF2ZXJzZXIoXG4gICAgICBzaWduYWwsXG4gICAgICB2YWxpZGF0ZWRJbnB1dCxcbiAgICAgIG9wdGlvbnM/LmVudixcbiAgICAgIG9wdGlvbnM/Lm1heERlcHRoLFxuICAgICAgb3B0aW9ucz8ubWF4SXRlcmF0aW9ucyxcbiAgICApO1xuICAgIC8vIFNldCBBRlRFUiBhbGwgc3luYyB2YWxpZGF0aW9uIHRocm93cyAobm90aGluZyBhYm92ZSBjYW4gbGVhayB0aGUgZmxhZyk7XG4gICAgLy8gbm8gYXdhaXQgYmV0d2VlbiB0aGUgdG9wLW9mLW1ldGhvZCBjaGVjayBhbmQgaGVyZSwgc28gdGhpcyBpcyByYWNlLWZyZWUuXG4gICAgdGhpcy5faXNFeGVjdXRpbmcgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnRyYXZlcnNlci5leGVjdXRlKCk7XG4gICAgICAvLyBUZXJtaW5hbCBmbHVzaCAoUkZDLTAwMSBCbG9jayA4KSBhdCB0aGUgUkVTT0xWRSBib3VuZGFyeTogZXZlcnlcbiAgICAgIC8vIGNhcHR1cmVkLWJ1dC11bmRlbGl2ZXJlZCBvYnNlcnZlciBldmVudCBpcyBkZWxpdmVyZWQgc3luY2hyb25vdXNseVxuICAgICAgLy8gYmVmb3JlIHJ1bigpIHJldHVybnMg4oCUIFwib25lIGJlYXQgYmVoaW5kXCIgbmV2ZXIgYmVjb21lcyBcImxvc3QgYXQgZXhpdFwiLlxuICAgICAgdGhpcy5kZWZlcnJlZFRpZXI/LnRlcm1pbmFsRmx1c2goKTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIC8vIFRlcm1pbmFsIGZsdXNoIGF0IHRoZSBQQVVTRSBhbmQgUkVKRUNUIGJvdW5kYXJpZXMg4oCUIHRoaXMgaXMgdGhlXG4gICAgICAvLyBPVVRFUk1PU1QgaGFuZGxlciAoYSBwYXVzZSByZS10aHJvd3MgdGhyb3VnaCBzdWJmbG93IHRyYXZlcnNlcnNcbiAgICAgIC8vIHdpdGhvdXQgZXhpdCBldmVudHMsIHNvIHBlci10cmF2ZXJzZXIgaG9va3Mgd291bGQgbWlzcyBpdCkuIFJ1bnNcbiAgICAgIC8vIGJlZm9yZSB0aGUgY2hlY2twb2ludCBpcyBleHBvc2VkIGFuZCBiZWZvcmUgdGhlIGVycm9yIHJlYWNoZXMgdGhlXG4gICAgICAvLyBjYWxsZXIuXG4gICAgICB0aGlzLmRlZmVycmVkVGllcj8udGVybWluYWxGbHVzaCgpO1xuICAgICAgaWYgKGlzUGF1c2VTaWduYWwoZXJyb3IpKSB7XG4gICAgICAgIC8vIEJ1aWxkIGEgZGV0YWNoZWQgY2hlY2twb2ludCBmcm9tIGN1cnJlbnQgZXhlY3V0aW9uIHN0YXRlIOKAlCBzZWVcbiAgICAgICAgLy8gYnVpbGRQYXVzZUNoZWNrcG9pbnQoKSBmb3IgdGhlIGRlZXAtY29weSByYXRpb25hbGUuXG4gICAgICAgIHRoaXMubGFzdENoZWNrcG9pbnQgPSB0aGlzLmJ1aWxkUGF1c2VDaGVja3BvaW50KGVycm9yKTtcbiAgICAgICAgLy8gUmV0dXJuIGEgUGF1c2VSZXN1bHQtc2hhcGVkIHZhbHVlIHNvIGNhbGxlcnMgY2FuIGNoZWNrIHdpdGhvdXQgdHJ5L2NhdGNoXG4gICAgICAgIHJldHVybiB7IHBhdXNlZDogdHJ1ZSwgY2hlY2twb2ludDogdGhpcy5sYXN0Q2hlY2twb2ludCB9IHNhdGlzZmllcyBQYXVzZWRSZXN1bHQ7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5faXNFeGVjdXRpbmcgPSBmYWxzZTtcbiAgICAgIGlmICh0aW1lb3V0SWQgIT09IHVuZGVmaW5lZCkgY2xlYXJUaW1lb3V0KHRpbWVvdXRJZCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEZsdXNoIHRoZSBkZWZlcnJlZC1vYnNlcnZlciBiYWNrbG9nLCB0aGVuIGF3YWl0IGFzeW5jIGxpc3RlbmVyXG4gICAqIGNvbXBsZXRpb25zIHVuZGVyIGEgZGVhZGxpbmUgKFJGQy0wMDEgQmxvY2sgOCDigJQgdGhlIHNlcnZlcmxlc3MgL1xuICAgKiBncmFjZWZ1bC1zaHV0ZG93biBwYXR0ZXJuOiBjYWxsIGJlZm9yZSB0aGUgcHJvY2VzcyBmcmVlemVzIG9yIGV4aXRzIHNvXG4gICAqIFwib25lIGJlYXQgYmVoaW5kXCIgd29yayBpcyBub3QgbG9zdCkuIFJlc29sdmVzIGltbWVkaWF0ZWx5IHdpdGggemVyb3NcbiAgICogd2hlbiBubyBkZWZlcnJlZCBvYnNlcnZlciB3YXMgZXZlciBhdHRhY2hlZC4gYHBlbmRpbmcgPT09IDBgIG1lYW5zIGFcbiAgICogZnVsbCBkcmFpbjsgYSBub24temVybyBgcGVuZGluZ2AgcmVwb3J0cyBjb250aW51YXRpb25zIChwbHVzIGFueSBxdWV1ZWRcbiAgICogZXZlbnRzKSBzdGlsbCBvdXRzdGFuZGluZyBhdCB0aGUgZGVhZGxpbmUg4oCUIGhvbmVzdCwgbmV2ZXIgc2lsZW50LlxuICAgKi9cbiAgZHJhaW5PYnNlcnZlcnMob3B0cz86IHsgdGltZW91dE1zPzogbnVtYmVyIH0pOiBQcm9taXNlPE9ic2VydmVyRHJhaW5SZXN1bHQ+IHtcbiAgICBpZiAoIXRoaXMuZGVmZXJyZWRUaWVyKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZG9uZTogMCwgZmFpbGVkOiAwLCBwZW5kaW5nOiAwIH0pO1xuICAgIHJldHVybiB0aGlzLmRlZmVycmVkVGllci5kcmFpbihvcHRzKTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBJbnRyb3NwZWN0aW9uIOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBydW50aW1lIHNuYXBzaG90LlxuICAgKlxuICAgKiBAcGFyYW0gb3B0aW9ucy5yZWRhY3QgIFdoZW4gYHRydWVgLCBgc2hhcmVkU3RhdGVgIGNvbWVzIGZyb20gdGhlIHBhcmFsbGVsXG4gICAqICAgcmVkYWN0ZWQgbWlycm9yIChpZiBtYWludGFpbmVkIOKAlCBzZWUgYHNldFJlZGFjdGlvblBvbGljeWApLiBUaGlzIGlzXG4gICAqICAgdGhlIHNhZmUgdmlldyBmb3IgZXhwb3J0aW5nIHRyYWNlcyBleHRlcm5hbGx5IChwYXN0ZSBpbnRvIGEgdmlld2VyLFxuICAgKiAgIHNoYXJlIHdpdGggc3VwcG9ydCkuIFdoZW4gbm8gcmVkYWN0aW9uIHBvbGljeSBpcyBjb25maWd1cmVkIHRoZVxuICAgKiAgIHJlZGFjdGVkIG1pcnJvciBpcyBub3QgbWFpbnRhaW5lZCwgc28gdGhpcyBmbGFnIGlzIGEgbm8tb3Ag4oCUXG4gICAqICAgYHNoYXJlZFN0YXRlYCBpcyB0aGUgcmF3IHdvcmtpbmcgbWVtb3J5IGVpdGhlciB3YXkuIERlZmF1bHQgYGZhbHNlYC5cbiAgICpcbiAgICogICBUaGUgY29tbWl0IGxvZyBpcyBhbHJlYWR5IHJlZGFjdGVkIGF0IHdyaXRlLXRpbWUgcmVnYXJkbGVzcyBvZiB0aGlzXG4gICAqICAgZmxhZywgYW5kIHRoZSBleGVjdXRpb24gdHJlZSBjYXJyaWVzIG9ubHkgc3RydWN0dXJhbCBtZXRhZGF0YS5cbiAgICpcbiAgICogKipUcmVhdCBgc2hhcmVkU3RhdGVgIGFzIFJFQUQtT05MWS4qKiBJbiBwcm9kdWN0aW9uIGl0IGlzIGEgbGl2ZSB2aWV3IG9mXG4gICAqIHRoZSBlbmdpbmUncyB3b3JraW5nIG1lbW9yeSAoemVybyBjb3B5IGNvc3QpIOKAlCBtdXRhdGluZyBpdCBjb3JydXB0c1xuICAgKiBlbmdpbmUgc3RhdGUuIEluIGRldiBtb2RlIChgZW5hYmxlRGV2TW9kZSgpYCkgaXQgaXMgYSBkZWVwLWZyb3plbiBDTE9ORSxcbiAgICogc28gYW55IGNvbnN1bWVyIG11dGF0aW9uIHRocm93cyBsb3VkbHkgaW5zdGVhZCBvZiBjb3JydXB0aW5nIHNpbGVudGx5LlxuICAgKi9cbiAgZ2V0U25hcHNob3Qob3B0aW9ucz86IHsgcmVkYWN0PzogYm9vbGVhbiB9KTogUnVudGltZVNuYXBzaG90IHtcbiAgICBjb25zdCBzbmFwc2hvdCA9IHRoaXMudHJhdmVyc2VyLmdldFNuYXBzaG90KG9wdGlvbnMpIGFzIFJ1bnRpbWVTbmFwc2hvdDtcbiAgICBpZiAoaXNEZXZNb2RlKCkpIHtcbiAgICAgIC8vIERldi1tb2RlIG11dGF0aW9uIGd1YXJkOiBmcmVlemUgYSBDTE9ORSwgbmV2ZXIgdGhlIGxpdmUgZW5naW5lXG4gICAgICAvLyBzdGF0ZSDigJQgYHNuYXBzaG90LnNoYXJlZFN0YXRlYCBhbGlhc2VzIFNoYXJlZE1lbW9yeSdzIGludGVybmFsXG4gICAgICAvLyBjb250ZXh0IHVudGlsIHRoZSBuZXh0IGNvbW1pdCByZWJ1aWxkcyBpdCAocG9zdC1ydW46IGZvcmV2ZXIpLlxuICAgICAgLy8gUHJvZHVjdGlvbiBzdGF5cyB6ZXJvLWNvcHk7IGNsb25lLWFsd2F5cyBpcyBhIG1lYXN1cmVkIGRlY2lzaW9uXG4gICAgICAvLyBkZWZlcnJlZCB1bnRpbCB0aGUgYmVuY2ggc2F5cyBpdCdzIGFmZm9yZGFibGUgKEJBQ0tMT0cgIzgpLlxuICAgICAgLy8gTk9URTogZGVlcEZyZWV6ZSAocmV1c2VkIGZyb20gcmVhZG9ubHlJbnB1dCkgZnJlZXplcyBwbGFpbiBvYmplY3RzL1xuICAgICAgLy8gYXJyYXlzIG9ubHkg4oCUIE1hcC9TZXQgSU5URVJOQUxTIHN0YXkgbXV0YWJsZSAoYG1hcC5zZXQoKWAgb24gdGhlXG4gICAgICAvLyBmcm96ZW4gY2xvbmUgd29uJ3QgdGhyb3cpLiBUaGUgQ0xPTkUgc3RpbGwgaXNvbGF0ZXMgdGhlIGVuZ2luZS5cbiAgICAgIHNuYXBzaG90LnNoYXJlZFN0YXRlID0gZGVlcEZyZWV6ZShzdHJ1Y3R1cmVkQ2xvbmUoc25hcHNob3Quc2hhcmVkU3RhdGUpKTtcbiAgICB9XG4gICAgY29uc3Qgc2ZSZXN1bHRzID0gdGhpcy50cmF2ZXJzZXIuZ2V0U3ViZmxvd1Jlc3VsdHMoKTtcbiAgICBpZiAoc2ZSZXN1bHRzLnNpemUgPiAwKSB7XG4gICAgICBzbmFwc2hvdC5zdWJmbG93UmVzdWx0cyA9IE9iamVjdC5mcm9tRW50cmllcyhzZlJlc3VsdHMpO1xuICAgIH1cblxuICAgIC8vIENvbGxlY3Qgc25hcHNob3QgZGF0YSBmcm9tIHJlY29yZGVycyB0aGF0IGltcGxlbWVudCB0b1NuYXBzaG90KClcbiAgICBjb25zdCByZWNvcmRlclNuYXBzaG90czogUmVjb3JkZXJTbmFwc2hvdFtdID0gW107XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuc2NvcGVSZWNvcmRlcnMpIHtcbiAgICAgIGlmIChyLnRvU25hcHNob3QpIHtcbiAgICAgICAgY29uc3Qgc25hcCA9IHIudG9TbmFwc2hvdCgpO1xuICAgICAgICByZWNvcmRlclNuYXBzaG90cy5wdXNoKHtcbiAgICAgICAgICBpZDogci5pZCxcbiAgICAgICAgICBuYW1lOiBzbmFwLm5hbWUsXG4gICAgICAgICAgZGVzY3JpcHRpb246IHNuYXAuZGVzY3JpcHRpb24sXG4gICAgICAgICAgcHJlZmVycmVkT3BlcmF0aW9uOiBzbmFwLnByZWZlcnJlZE9wZXJhdGlvbixcbiAgICAgICAgICBkYXRhOiBzbmFwLmRhdGEsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5mbG93UmVjb3JkZXJzKSB7XG4gICAgICBpZiAoci50b1NuYXBzaG90KSB7XG4gICAgICAgIGNvbnN0IHNuYXAgPSByLnRvU25hcHNob3QoKTtcbiAgICAgICAgcmVjb3JkZXJTbmFwc2hvdHMucHVzaCh7XG4gICAgICAgICAgaWQ6IHIuaWQsXG4gICAgICAgICAgbmFtZTogc25hcC5uYW1lLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBzbmFwLmRlc2NyaXB0aW9uLFxuICAgICAgICAgIHByZWZlcnJlZE9wZXJhdGlvbjogc25hcC5wcmVmZXJyZWRPcGVyYXRpb24sXG4gICAgICAgICAgZGF0YTogc25hcC5kYXRhLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuZGVmZXJyZWRUaWVyKSB7XG4gICAgICAvLyBEZWZlcnJlZCByZWNvcmRlcnMgYXJlIGF0dGFjaGVkIG9ic2VydmVycyB0b28g4oCUIGNvbGxlY3QgdGhlaXJcbiAgICAgIC8vIHNuYXBzaG90cyBvbmNlIHBlciBpZCAoYSBjb21iaW5lZCByZWNvcmRlciByZWdpc3RlcnMgb25jZSBpbiB0aGVcbiAgICAgIC8vIHRpZXIsIHVubGlrZSB0aGUgdHdvIGlubGluZSBsaXN0cykuXG4gICAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICBmb3IgKGNvbnN0IHIgb2YgWy4uLnRoaXMuZGVmZXJyZWRUaWVyLnNjb3BlTGlzdFJlY29yZGVycygpLCAuLi50aGlzLmRlZmVycmVkVGllci5mbG93TGlzdFJlY29yZGVycygpXSkge1xuICAgICAgICBpZiAoc2Vlbi5oYXMoci5pZCkpIGNvbnRpbnVlO1xuICAgICAgICBzZWVuLmFkZChyLmlkKTtcbiAgICAgICAgaWYgKHIudG9TbmFwc2hvdCkge1xuICAgICAgICAgIGNvbnN0IHNuYXAgPSByLnRvU25hcHNob3QoKTtcbiAgICAgICAgICByZWNvcmRlclNuYXBzaG90cy5wdXNoKHtcbiAgICAgICAgICAgIGlkOiByLmlkLFxuICAgICAgICAgICAgbmFtZTogc25hcC5uYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IHNuYXAuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICBwcmVmZXJyZWRPcGVyYXRpb246IHNuYXAucHJlZmVycmVkT3BlcmF0aW9uLFxuICAgICAgICAgICAgZGF0YTogc25hcC5kYXRhLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZWNvcmRlclNuYXBzaG90cy5sZW5ndGggPiAwKSB7XG4gICAgICBzbmFwc2hvdC5yZWNvcmRlcnMgPSByZWNvcmRlclNuYXBzaG90cztcbiAgICB9XG5cbiAgICAvLyBSRkMtMDAxIEJsb2NrIDk6IHRoZSBkZWZlcnJlZC1vYnNlcnZlciBhY2NvdW50aW5nIHN1cmZhY2UuIFByZXNlbnRcbiAgICAvLyBPTkxZIHdoZW4gYSBkZWZlcnJlZCBvYnNlcnZlciB3YXMgYXR0YWNoZWQgb24gdGhpcyBleGVjdXRvciDigJRcbiAgICAvLyB6ZXJvLWNvc3QgZGlzY2lwbGluZSBmb3IgZXZlcnlvbmUgZWxzZS5cbiAgICBpZiAodGhpcy5kZWZlcnJlZFRpZXIpIHtcbiAgICAgIHNuYXBzaG90Lm9ic2VydmVyU3RhdHMgPSB0aGlzLmRlZmVycmVkVGllci5nZXRTdGF0cygpO1xuICAgIH1cblxuICAgIHJldHVybiBzbmFwc2hvdDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0UnVudGltZSgpIHtcbiAgICByZXR1cm4gdGhpcy50cmF2ZXJzZXIuZ2V0UnVudGltZSgpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBzZXRSb290T2JqZWN0KHBhdGg6IHN0cmluZ1tdLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLnRyYXZlcnNlci5zZXRSb290T2JqZWN0KHBhdGgsIGtleSwgdmFsdWUpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRCcmFuY2hJZHMoKSB7XG4gICAgcmV0dXJuIHRoaXMudHJhdmVyc2VyLmdldEJyYW5jaElkcygpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRSdW50aW1lUm9vdCgpOiBTdGFnZU5vZGUge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRSdW50aW1lUm9vdCgpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRSdW50aW1lU3RydWN0dXJlKCk6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMudHJhdmVyc2VyLmdldFJ1bnRpbWVTdHJ1Y3R1cmUoKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0U3ViZmxvd1Jlc3VsdHMoKTogTWFwPHN0cmluZywgU3ViZmxvd1Jlc3VsdD4ge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRTdWJmbG93UmVzdWx0cygpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIHN1YmZsb3cgbWFuaWZlc3QgZnJvbSBhbiBhdHRhY2hlZCBNYW5pZmVzdEZsb3dSZWNvcmRlci5cbiAgICogUmV0dXJucyBlbXB0eSBhcnJheSBpZiBubyBNYW5pZmVzdEZsb3dSZWNvcmRlciBpcyBhdHRhY2hlZC5cbiAgICovXG4gIGdldFN1YmZsb3dNYW5pZmVzdCgpOiBNYW5pZmVzdEVudHJ5W10ge1xuICAgIGNvbnN0IHJlY29yZGVyID0gdGhpcy5mbG93UmVjb3JkZXJzLmZpbmQoKHIpID0+IHIgaW5zdGFuY2VvZiBNYW5pZmVzdEZsb3dSZWNvcmRlcikgYXNcbiAgICAgIHwgTWFuaWZlc3RGbG93UmVjb3JkZXJcbiAgICAgIHwgdW5kZWZpbmVkO1xuICAgIHJldHVybiByZWNvcmRlcj8uZ2V0TWFuaWZlc3QoKSA/PyBbXTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBmdWxsIHNwZWMgZm9yIGEgZHluYW1pY2FsbHktcmVnaXN0ZXJlZCBzdWJmbG93LlxuICAgKiBSZXF1aXJlcyBhbiBhdHRhY2hlZCBNYW5pZmVzdEZsb3dSZWNvcmRlciB0aGF0IG9ic2VydmVkIHRoZSByZWdpc3RyYXRpb24uXG4gICAqL1xuICBnZXRTdWJmbG93U3BlYyhzdWJmbG93SWQ6IHN0cmluZyk6IHVua25vd24gfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IHJlY29yZGVyID0gdGhpcy5mbG93UmVjb3JkZXJzLmZpbmQoKHIpID0+IHIgaW5zdGFuY2VvZiBNYW5pZmVzdEZsb3dSZWNvcmRlcikgYXNcbiAgICAgIHwgTWFuaWZlc3RGbG93UmVjb3JkZXJcbiAgICAgIHwgdW5kZWZpbmVkO1xuICAgIHJldHVybiByZWNvcmRlcj8uZ2V0U3BlYyhzdWJmbG93SWQpO1xuICB9XG59XG4iXX0=