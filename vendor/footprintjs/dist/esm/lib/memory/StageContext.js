/**
 * StageContext — Execution context for a single stage in a flowchart run
 *
 * Like a stack frame in a compiler/runtime:
 * - Reference to SharedMemory (accessing heap memory)
 * - TransactionBuffer for staging mutations (transaction buffer)
 * - Links to parent/child/next contexts (call stack frames)
 * - DiagnosticCollector for logs, errors, metrics
 */
import { summarizeReadValue, summarizeWriteValue } from '../capture/summarize.js';
import { isDevMode } from '../scope/detectCircular.js';
import { DiagnosticCollector } from './DiagnosticCollector.js';
import { nativeGet } from './pathOps.js';
import { TransactionBuffer } from './TransactionBuffer.js';
import { redactPatch } from './utils.js';
export class StageContext {
    sharedMemory;
    /**
     * Parallel redacted mirror of `sharedMemory`. Populated in `commit()` with
     * the already-computed redacted patches (the same ones fed to `eventLog`).
     * Present **only** when the executor has been told to maintain a redacted
     * view — i.e. when a `RedactionPolicy` is configured. Otherwise undefined,
     * zero extra work per commit.
     *
     * The mirror is read via `FlowChartExecutor.getSnapshot({ redact: true })`
     * and is the foundation for the "export trace" / paste-into-viewer feature
     * — consumers share the redacted view externally without leaking raw PII
     * through `sharedState`.
     */
    redactedSharedMemory;
    buffer;
    /**
     * Committed-state view captured at this stage's FIRST touch (first read OR
     * first write) — held by REFERENCE, never cloned. See
     * {@link firstTouchState} for the algorithm and the immutability invariant
     * that makes a bare reference safe.
     */
    stateView;
    eventLog;
    stageName = '';
    /** Unique stage identifier from the builder (matches spec node id). */
    stageId;
    /** Unique per-execution-step identifier. Set by traverser before stage execution. */
    runtimeStageId = '';
    runId;
    branchId;
    isDecider;
    isFork;
    /** Human-readable description from builder (set by traverser before execution). */
    description;
    /** Subflow identifier (set by traverser when this is a subflow entry point). */
    subflowId;
    parent;
    next;
    children;
    debug = new DiagnosticCollector();
    /** Tracks user-level writes (pre-namespace) for the memory view and onCommit. */
    _stageWrites = {};
    /** Tracks user-level reads (pre-namespace) for the memory view. */
    _stageReads = {};
    /**
     * How tracked reads are recorded into `_stageReads` (#14). Default `'full'`
     * preserves the historical per-read `structuredClone`. Inherited by every
     * context created via {@link createNext} / {@link createChild} (same
     * propagation pattern as the redacted mirror), and pushed into subflow
     * root contexts by `SubflowExecutor`. Affects ONLY the snapshot's
     * `stageReads` payload — `ScopeRecorder.onRead` (and therefore narrative)
     * is dispatched at the scope tier and never cloned, so it is identical in
     * every mode.
     */
    readTracking = 'full';
    /**
     * How tracked writes are recorded into `_stageWrites` (#13c-A) — the
     * sibling of {@link readTracking}, with the same propagation pattern
     * (inherited via {@link createNext}/{@link createChild}, pushed into
     * subflow root contexts by `SubflowExecutor`). Governs the per-write
     * `structuredClone` in {@link setObject}/{@link updateObject}. Affects the
     * snapshot's `stageWrites` payload AND the commit observer's mutations
     * payload (which is a spread of `_stageWrites`) — but NOT the write
     * itself: the transaction buffer, the commit log, and shared state are
     * identical in every mode, and `ScopeRecorder.onWrite` always fires with
     * the live value.
     */
    writeTracking = 'full';
    /**
     * How commit-bundle values are encoded into the commit log (#13c-B) — the
     * third dial of the family, with the same propagation pattern as
     * {@link readTracking}/{@link writeTracking} (inherited via
     * {@link createNext}/{@link createChild}, pushed into subflow root
     * contexts by `SubflowExecutor`, re-applied on the resume path). Passed
     * into each {@link TransactionBuffer} at construction; `'full'` (default)
     * is byte-identical to history, `'delta'` enables append/delete verbs +
     * one-trace-entry-per-path dedup. Lossless in both modes.
     */
    commitValues = 'full';
    /**
     * Per-write read-provenance policy (#P1) — the fourth dial of the family,
     * same propagation pattern as {@link readTracking}/{@link writeTracking}/
     * {@link commitValues}. Under `'reads-prefix'` this context keeps a
     * lightweight ordered set of the keys tracked-read so far, and the
     * transaction buffer stamps that prefix onto every staged write
     * ({@link TraceEntry.readKeys}). INDEPENDENT of readTracking: provenance
     * needs only the key STRINGS, so it works even under readTracking 'off'
     * (and costs nothing when it is itself 'off' — the default).
     */
    writeProvenance = 'off';
    /** Lazily-allocated ordered registry of keys tracked-read in THIS stage —
     *  the source of the per-write prefix. Only allocated under the
     *  `'reads-prefix'` dial; insertion-ordered (a Set) and monotonic, which
     *  is what makes "last write's prefix == union" hold in delta mode. */
    _provenanceReads;
    /**
     * RFC-003 D2 honesty markers — untracked read paths used during THIS
     * stage's execution (`'args'` / `'env'` / `'silent'`). Marked by
     * `ScopeFacade`, surfaced on the stage's CommitBundle as
     * `untrackedSources`, then RELEASED with the staging state at commit end
     * (so the routine double-commit paths — fork children, subflow mounts —
     * record the field exactly once, on the first commit). Lazily allocated:
     * stages that never touch an untracked path pay nothing.
     */
    _untrackedSources;
    /** Observer called after commit() — used by ScopeFacade to fire ScopeRecorder.onCommit. */
    _commitObserver;
    constructor(runId, name, stageId, sharedMemory, branchId, eventLog, isDecider) {
        this.runId = runId;
        this.stageName = name;
        this.stageId = stageId;
        this.sharedMemory = sharedMemory;
        this.branchId = branchId;
        this.eventLog = eventLog;
        this.isDecider = !!isDecider;
        this.isFork = false;
    }
    /** Returns the SharedMemory instance (needed by scope layer). */
    getSharedMemory() {
        return this.sharedMemory;
    }
    /**
     * Install a parallel redacted mirror. Subsequent `commit()` calls will
     * apply the already-computed redacted patches to this mirror in addition
     * to the raw `sharedMemory` + `eventLog`. Child / next contexts inherit
     * the mirror via `createNext` / `createChild`.
     *
     * Called once at the root context by `ExecutionRuntime.enableRedactedMirror()`.
     */
    useRedactedMirror(mirror) {
        this.redactedSharedMemory = mirror;
    }
    /** Returns the redacted mirror if installed, else undefined. */
    getRedactedSharedMemory() {
        return this.redactedSharedMemory;
    }
    /**
     * Set the read-tracking policy for this context (#14). Called at the root
     * by `ExecutionRuntime.useReadTracking()` (plumbed from
     * `FlowChartExecutor`); descendants inherit via `createNext`/`createChild`,
     * and `SubflowExecutor` pushes the parent context's mode into each subflow
     * root so nested charts inherit too.
     */
    useReadTracking(mode) {
        this.readTracking = mode;
    }
    /** Returns the active read-tracking policy (used for subflow propagation). */
    getReadTracking() {
        return this.readTracking;
    }
    /**
     * Set the write-tracking policy for this context (#13c-A). Same plumbing
     * as {@link useReadTracking}: called at the root by
     * `ExecutionRuntime.useWriteTracking()` (plumbed from `FlowChartExecutor`);
     * descendants inherit via `createNext`/`createChild`, and `SubflowExecutor`
     * pushes the parent context's mode into each subflow root.
     */
    useWriteTracking(mode) {
        this.writeTracking = mode;
    }
    /** Returns the active write-tracking policy (used for subflow propagation). */
    getWriteTracking() {
        return this.writeTracking;
    }
    /**
     * Set the commit-values encoding policy for this context (#13c-B). Same
     * plumbing as {@link useReadTracking}/{@link useWriteTracking}: called at
     * the root by `ExecutionRuntime.useCommitValues()` (plumbed from
     * `FlowChartExecutor`); descendants inherit via `createNext`/`createChild`,
     * and `SubflowExecutor` pushes the parent context's mode into each subflow
     * root.
     */
    useCommitValues(mode) {
        this.commitValues = mode;
    }
    /** Returns the active commit-values policy (used for subflow propagation). */
    getCommitValues() {
        return this.commitValues;
    }
    /**
     * Set the per-write read-provenance policy (#P1). Same plumbing as the
     * other three dials: called at the root by
     * `ExecutionRuntime.useWriteProvenance()` (plumbed from
     * `FlowChartExecutor`); descendants inherit via `createNext`/`createChild`,
     * and `SubflowExecutor` pushes the parent context's mode into each subflow
     * root so nested charts inherit too.
     */
    useWriteProvenance(mode) {
        this.writeProvenance = mode;
    }
    /** Returns the active write-provenance policy (used for subflow propagation). */
    getWriteProvenance() {
        return this.writeProvenance;
    }
    /**
     * Record a tracked user-level write into `_stageWrites`, policy-gated
     * (#13c-A) — the single bookkeeping path for {@link setObject} and
     * {@link updateObject}.
     *
     * Redaction takes precedence over the dial in EVERY mode: a redacted
     * write stores the `'[REDACTED]'` placeholder under `'full'` AND
     * `'summary'` (a summary marker would leak the value's preview/size),
     * and stores nothing under `'off'` (entry skipped entirely — nothing to
     * leak). The staged write itself is unaffected — redaction of the
     * committed payload is handled by the transaction buffer's
     * `redactedPaths`.
     */
    trackWrite(userKey, value, shouldRedact, operation) {
        if (this.writeTracking === 'off')
            return;
        this._stageWrites[userKey] = {
            value: shouldRedact
                ? '[REDACTED]'
                : this.writeTracking === 'summary'
                    ? summarizeWriteValue(value)
                    : structuredClone(value),
            operation,
        };
    }
    /**
     * ── The first-touch state view (#13) ────────────────────────────────────
     *
     * WHAT: returns the committed shared state as it was at this stage's FIRST
     * touch (first read or first write), capturing the reference on first call.
     * Serves two consumers: reads before the first write ({@link readState})
     * and the transaction buffer's diff base ({@link getTransactionBuffer}).
     *
     * WHY A BARE REFERENCE IS SAFE — the invariant this rests on: committed
     * state is immutable-after-swap. `SharedMemory.applyPatch` routes through
     * `applySmartMerge`, which `structuredClone`s the current state, mutates
     * only the clone, and swaps `SharedMemory.context` to it — the object a
     * stage captured here is never edited afterwards. (`SharedMemory.setValue`/
     * `updateValue` DO mutate in place, but have no callers during traversal;
     * every runtime write reaches state through a stage commit's `applyPatch`.)
     * Holding the reference therefore gives this stage a stable snapshot at
     * zero cost — no clone, which is the entire point of #13.
     *
     * WHY FIRST TOUCH, not first write: the pre-#13 eager engine cloned the
     * state into the buffer at the stage's first ACCESS, anchoring both its
     * snapshot reads and its commit baseline (the net-change diff base) there.
     * #13's first cut anchored the lazy buffer at first WRITE — observably
     * different when something else commits in the gap between this stage's
     * first read and its first write. That gap is REACHABLE: fork siblings are
     * namespace-isolated for run-scoped keys (each child writes under
     * `runs/<childId>/`), but ROOT-level keys are shared — written via
     * `setGlobal` from consumer scope code and, critically, by
     * `SubflowInputMapper`'s output mapping (`parentContext.setGlobal`), which
     * is exactly what runs when a subflow is a fork branch. A sibling's
     * root-key commit landing in the gap would shift this stage's diff base,
     * making its CommitBundle record a phantom change (or swallow a real one)
     * relative to the eager engine. Anchoring the view at first touch restores
     * the EXACT eager semantics — sequential AND parallel — at zero clone cost.
     *
     * Read visibility is two-tier, matching eager byte-for-byte: keys present
     * in the view at first touch read repeatably from it; keys ABSENT from it
     * fall back to LIVE state (the eager engine's exact fallback — a
     * mid-flight sibling root-key write was always visible to reads, and
     * stays visible; only the DIFF BASE is pinned).
     */
    firstTouchState() {
        if (!this.stateView) {
            this.stateView = this.sharedMemory.getState();
        }
        return this.stateView;
    }
    /** Lazily creates the transaction buffer on the stage's FIRST WRITE (#13).
     *
     *  Reads NEVER construct it: read-your-writes only matters once a staged
     *  write exists, so before that {@link getValue}/{@link getValueDirect}
     *  serve from the first-touch state view and {@link commit} records an
     *  empty bundle — all with ZERO `structuredClone`s of the shared state.
     *
     *  The buffer's base is the FIRST-TOUCH view, NOT the live state at write
     *  time: under parallel forks a sibling may have committed between this
     *  stage's first read and this write, and the net-change diff base must
     *  stay anchored at first touch to match the eager engine — see
     *  {@link firstTouchState}. */
    getTransactionBuffer() {
        if (!this.buffer) {
            // Per-write provenance (#P1): hand the buffer a live view of this
            // stage's read prefix — evaluated AT EACH WRITE, so each staged op
            // captures exactly the reads that preceded it (temporal prefix).
            const readKeysProvider = this.writeProvenance === 'reads-prefix' ? () => [...(this._provenanceReads ?? [])] : undefined;
            this.buffer = new TransactionBuffer(this.firstTouchState(), this.commitValues, readKeysProvider);
        }
        return this.buffer;
    }
    /** Builds an absolute path inside the shared memory (run namespace). */
    withNamespace(path, key) {
        if (!this.runId || this.runId === '') {
            return [...path, key];
        }
        return ['runs', this.runId, ...path, key];
    }
    // ── Write operations ───────────────────────────────────────────────────
    patch(path, key, value, shouldRedact = false) {
        this.getTransactionBuffer().set(this.withNamespace(path, key), value, shouldRedact);
    }
    set(path, key, value) {
        this.patch(path, key, value);
    }
    merge(path, key, value) {
        this.getTransactionBuffer().merge(this.withNamespace(path, key), value);
    }
    setObject(path, key, value, shouldRedact, description, operationOverride) {
        if (operationOverride === 'delete') {
            // Explicit deletion (ScopeFacade.deleteValue) stages a distinct op so
            // delta-mode commits (#13c-B) can emit a real `delete` trace entry.
            // Under the default 'full' mode the buffer commits it as a
            // set-of-undefined — byte-identical to the historical flattening.
            this.getTransactionBuffer().delete(this.withNamespace(path, key), shouldRedact ?? false);
        }
        else {
            this.patch(path, key, value, shouldRedact ?? false);
        }
        // Track user-level write (pre-namespace) for memory view + onCommit —
        // policy-gated (#13c-A), see trackWrite.
        const userKey = path.length > 0 ? [...path, key].join('.') : key;
        this.trackWrite(userKey, value, shouldRedact ?? false, operationOverride ?? 'set');
        if (description) {
            const tagged = description.startsWith('[') ? description : `[WRITE] ${description}`;
            this.debug.addLog('message', tagged);
        }
    }
    updateObject(path, key, value, description, shouldRedact) {
        this.merge(path, key, value);
        // Track user-level write (pre-namespace) for memory view + onCommit —
        // policy-gated (#13c-A), see trackWrite.
        const userKey = path.length > 0 ? [...path, key].join('.') : key;
        this.trackWrite(userKey, value, shouldRedact ?? false, 'update');
        if (description) {
            this.debug.addLog('message', description);
        }
    }
    setRoot(key, value) {
        this.patch([], key, value);
    }
    setGlobal(key, value, description) {
        this.getTransactionBuffer().set([key], value);
        if (description) {
            this.debug.addLog('message', description);
        }
    }
    updateGlobalContext(key, value) {
        this.getTransactionBuffer().set([key], value);
    }
    appendToArray(path, key, items, description) {
        const existing = this.getValue(path, key);
        const merged = Array.isArray(existing) ? [...existing, ...items] : [...items];
        this.setObject(path, key, merged, false, description);
    }
    mergeObject(path, key, obj, description) {
        const existing = this.getValue(path, key);
        const merged = existing && typeof existing === 'object' && !Array.isArray(existing)
            ? { ...existing, ...obj }
            : { ...obj };
        this.setObject(path, key, merged, false, description);
    }
    // ── Read operations ────────────────────────────────────────────────────
    /** Buffer-aware read, mirroring the eager engine's read order byte-for-byte:
     *
     *    1. staged writes + first-touch snapshot — `buffer.get` over its
     *       workingCopy when the buffer exists, else `nativeGet` over the
     *       zero-clone state view (the buffer's base IS that view, so the two
     *       tiers agree on content);
     *    2. LIVE state via `sharedMemory.getValue` for keys absent from the
     *       snapshot — including its run→global namespace fallback. The eager
     *       engine had this exact live fallback for snapshot-missing keys;
     *       byte-identity over purity.
     *
     *  Reads never construct the buffer (#13): a stage that never writes
     *  performs zero clones of the shared state. */
    readState(path, key) {
        const namespaced = this.withNamespace(path, key);
        const fromSnapshot = this.buffer ? this.buffer.get(namespaced) : nativeGet(this.firstTouchState(), namespaced);
        if (typeof fromSnapshot !== 'undefined')
            return fromSnapshot;
        return this.sharedMemory.getValue(this.runId, path, key);
    }
    /**
     * Tracked read. The returned value is BORROWED — see the contract on
     * `ScopeFacade.getValue`. Read-tracking cost is policy-gated (#14):
     * `'full'` clones the value into `_stageReads` (historical default),
     * `'summary'` records a cheap marker, `'off'` records nothing.
     */
    getValue(path, key, description) {
        const value = this.readState(path, key);
        // Per-write provenance registry (#P1) — key strings only, independent of
        // the readTracking retention dial (which governs VALUE retention below).
        if (key !== undefined && this.writeProvenance === 'reads-prefix') {
            (this._provenanceReads ??= new Set()).add(path.length > 0 ? [...path, key].join('.') : key);
        }
        // Track user-level read (pre-namespace) for memory view
        if (key !== undefined && this.readTracking !== 'off') {
            const userKey = path.length > 0 ? [...path, key].join('.') : key;
            this._stageReads[userKey] =
                value === undefined
                    ? undefined
                    : this.readTracking === 'summary'
                        ? summarizeReadValue(value)
                        : structuredClone(value);
        }
        if (description) {
            this.debug.addLog('message', `[READ] ${description}`);
        }
        return value;
    }
    /** Read state without tracking in _stageReads or paying structuredClone cost.
     *  Used by ScopeFacade.getValueSilent() for array proxy internal operations. */
    getValueDirect(path, key) {
        return this.readState(path, key);
    }
    getRoot(key) {
        return this.sharedMemory.getValue(this.runId, [], key);
    }
    getGlobal(key) {
        return this.sharedMemory.getValue('', [], key);
    }
    getScope() {
        return this.sharedMemory.getState();
    }
    getRunId() {
        return this.runId;
    }
    // ── Commit ─────────────────────────────────────────────────────────────
    /**
     * RFC-003 D2: record that this stage consumed an untracked read path.
     * Called by `ScopeFacade` (`getArgs`/`getEnv`/unshadowed `getValueSilent`);
     * surfaced as `CommitBundle.untrackedSources` on this stage's commit.
     */
    markUntrackedSource(source) {
        (this._untrackedSources ??= new Set()).add(source);
    }
    /**
     * RFC-003 D2: the `untrackedSources` bundle fragment for commit() — `{}`
     * when nothing was marked, so the spread keeps the field ABSENT (not
     * empty-array-valued) and untouched charts stay byte-identical.
     */
    untrackedSourcesFragment() {
        if (!this._untrackedSources || this._untrackedSources.size === 0)
            return {};
        return { untrackedSources: [...this._untrackedSources] };
    }
    /** Register an observer that fires after commit() applies patches.
     *  Used by ScopeFacade to dispatch ScopeRecorder.onCommit events. */
    setCommitObserver(observer) {
        this._commitObserver = observer;
    }
    /**
     * Flush staged writes to shared memory and RELEASE the per-stage staging
     * state (#13b).
     *
     * Commit is the stage's lifecycle end: `buffer` (2 full-state clones) and
     * `stateView` (a reference that pins one full committed-state GENERATION —
     * `applySmartMerge` clones + swaps the whole state per commit, so every
     * stage's view is a distinct object) are only needed DURING execution, as
     * the read snapshot + net-change diff base. The execution tree retains
     * every StageContext for the lifetime of the run, so WITHOUT the release
     * a long loop retains one state generation + two clones per executed
     * stage — measured O(N²): 563.8MB at N=200 on an agent-style chart; a
     * 500-iteration agent OOMed a default Node heap (backlog #18).
     *
     * RE-USE AFTER COMMIT stays correct because both fields re-create lazily:
     * - a later READ re-anchors via {@link firstTouchState} on the CURRENT
     *   committed state (which includes this stage's own flushed writes);
     * - a later WRITE constructs a fresh buffer on that re-anchored view, so a
     *   second commit diffs against post-first-commit state. The pre-release
     *   buffer behaved the same for VALUES (its `workingCopy` was reset on
     *   commit, falling reads through to live state) but kept the ORIGINAL
     *   `baseSnapshot` as diff base — unreachable in practice: every engine
     *   re-commit path (fork double-commit, subflow outputMapper double-commit)
     *   stages nothing in between, and the two real "write after commit" sites
     *   (SubflowExecutor seed → replaces the context; resume → fresh context
     *   via `leaf.createNext`) never re-use a committed context's buffer.
     * - `_stageWrites` / `_stageReads` are NOT released — `snapshotSelf()`
     *   reads them post-run for the execution-tree snapshot.
     */
    commit() {
        if (!this.buffer) {
            // Truly-lazy fast path (#13): no write ever constructed the buffer, so
            // the stage's net change is empty BY CONSTRUCTION. Same observable
            // outcome as an empty commit — the (empty) bundle is still recorded so
            // every executed stage remains a time-travel cursor stop — but with
            // ZERO clones: no buffer construction, no applyPatch replay.
            this.eventLog?.record({
                overwrite: {},
                updates: {},
                redactedPaths: [],
                trace: [],
                stage: this.stageName,
                stageId: this.stageId,
                runtimeStageId: this.runtimeStageId,
                ...this.untrackedSourcesFragment(),
            });
            if (this._commitObserver) {
                this._commitObserver({ ...this._stageWrites });
            }
            // #13b: drop the first-touch view — a read-only stage still pinned one
            // full state generation through it. D2 markers release with it.
            this.stateView = undefined;
            this._untrackedSources = undefined;
            return;
        }
        const bundle = this.buffer.commit();
        const commitBundle = {
            ...bundle,
            stage: this.stageName,
            stageId: this.stageId,
            runtimeStageId: this.runtimeStageId,
            ...this.untrackedSourcesFragment(),
        };
        this.sharedMemory.applyPatch(commitBundle.overwrite, commitBundle.updates, commitBundle.trace);
        // Already-computed redacted patches feed three consumers:
        //   1. the parallel redacted mirror (if enabled)
        //   2. the event log (persisted trace)
        //   3. (future) anything else that wants a scrubbed view at commit time
        // Computing once keeps cost linear in the commit size; no post-pass walk.
        const redactedOverwrite = redactPatch(commitBundle.overwrite, commitBundle.redactedPaths);
        const redactedUpdates = redactPatch(commitBundle.updates, commitBundle.redactedPaths);
        this.redactedSharedMemory?.applyPatch(redactedOverwrite, redactedUpdates, commitBundle.trace);
        this.eventLog?.record({
            ...commitBundle,
            redactedPaths: Array.from(commitBundle.redactedPaths.values()),
            overwrite: redactedOverwrite,
            updates: redactedUpdates,
        });
        // Notify observer (ScopeFacade) with tracked mutations
        if (this._commitObserver) {
            this._commitObserver({ ...this._stageWrites });
        }
        // #13b: release the staging state — see the method JSDoc. Done LAST so
        // the commit observer sees the exact same world as before the release.
        // D2's untracked-source markers release with it: the routine
        // double-commit paths then record the field exactly once.
        this.buffer = undefined;
        this.stateView = undefined;
        this._untrackedSources = undefined;
    }
    // ── Tree navigation ────────────────────────────────────────────────────
    /**
     * Create (or return) this context's linked successor.
     *
     * MEMOIZED: the first call creates `this.next`; every later call returns
     * that SAME context and IGNORES its arguments. In normal traversal each
     * context advances exactly once, so the memo never bites — but a caller
     * expecting a fresh context for different `stageName`/`stageId` args gets
     * the old one silently. Dev mode (`enableDevMode()`) warns on that
     * mismatch (backlog B4).
     */
    createNext(path, stageName, stageId, isDecider = false) {
        if (!this.next) {
            this.next = new StageContext(path, stageName, stageId, this.sharedMemory, '', this.eventLog, isDecider);
            this.next.parent = this;
            // Propagate the redacted mirror down the context tree so every commit
            // in the run writes to both views.
            if (this.redactedSharedMemory)
                this.next.redactedSharedMemory = this.redactedSharedMemory;
            this.next.readTracking = this.readTracking;
            this.next.writeTracking = this.writeTracking;
            this.next.commitValues = this.commitValues;
            this.next.writeProvenance = this.writeProvenance;
        }
        else if (isDevMode() && (this.next.stageId !== stageId || this.next.stageName !== stageName)) {
            // eslint-disable-next-line no-console
            console.warn(`[footprint] StageContext.createNext: next context already exists as "${this.next.stageName}" ` +
                `(id: "${this.next.stageId}") — arguments "${stageName}" (id: "${stageId}") are ignored ` +
                'and the existing context is returned.');
        }
        return this.next;
    }
    createChild(runId, branchId, stageName, stageId, isDecider = false) {
        if (!this.children) {
            this.children = [];
        }
        const child = new StageContext(runId, stageName, stageId, this.sharedMemory, branchId, this.eventLog, isDecider);
        child.parent = this;
        if (this.redactedSharedMemory)
            child.redactedSharedMemory = this.redactedSharedMemory;
        child.readTracking = this.readTracking;
        child.writeTracking = this.writeTracking;
        child.commitValues = this.commitValues;
        child.writeProvenance = this.writeProvenance;
        this.children.push(child);
        return child;
    }
    createDecider(path, stageName, stageId) {
        return this.createNext(path, stageName, stageId, true);
    }
    setAsDecider() {
        this.isDecider = true;
        return this;
    }
    setAsFork() {
        this.isFork = true;
        return this;
    }
    // ── Diagnostics delegation ─────────────────────────────────────────────
    addLog(key, value, path) {
        this.debug.addLog(key, value, path);
    }
    setLog(key, value, path) {
        this.debug.setLog(key, value, path);
    }
    addMetric(key, value, path) {
        this.debug.addMetric(key, value, path);
    }
    setMetric(key, value, path) {
        this.debug.setMetric(key, value, path);
    }
    addEval(key, value, path) {
        this.debug.addEval(key, value, path);
    }
    setEval(key, value, path) {
        this.debug.setEval(key, value, path);
    }
    addError(key, value, path) {
        this.debug.addError(key, value, path);
    }
    addFlowDebugMessage(type, description, options) {
        const flowMessage = { type, description, timestamp: Date.now(), ...options };
        this.debug.addFlowMessage(flowMessage);
    }
    // ── Snapshot ───────────────────────────────────────────────────────────
    getStageId() {
        if (!this.runId || this.runId === '')
            return this.stageName;
        return `${this.runId}.${this.stageName}`;
    }
    getSnapshot() {
        // Iterative walk (explicit work stack), NOT recursion: the execution
        // tree deepens by one level per executed stage along `next` chains, and
        // the trampolined traverser allows chains/loops of tens of thousands of
        // stages — far deeper than a recursive serializer can walk before
        // "Maximum call stack size exceeded".
        const root = this.snapshotSelf();
        const work = [{ ctx: this, snap: root }];
        while (work.length > 0) {
            const { ctx, snap } = work.pop();
            if (ctx.next) {
                const nextSnap = ctx.next.snapshotSelf();
                snap.next = nextSnap;
                work.push({ ctx: ctx.next, snap: nextSnap });
            }
            if (ctx.children) {
                snap.children = ctx.children.map((child) => {
                    const childSnap = child.snapshotSelf();
                    work.push({ ctx: child, snap: childSnap });
                    return childSnap;
                });
            }
        }
        return root;
    }
    /** Snapshot of THIS context's own fields — `next`/`children` are filled
     *  in by the iterative walk in `getSnapshot`. */
    snapshotSelf() {
        const snapshot = {
            id: this.stageId,
            runtimeStageId: this.runtimeStageId || undefined,
            name: this.stageName,
            isDecider: this.isDecider,
            isFork: this.isFork,
            logs: this.debug.logContext,
            errors: this.debug.errorContext,
            metrics: this.debug.metricContext,
            evals: this.debug.evalContext,
        };
        if (Object.keys(this._stageWrites).length > 0) {
            // Extract values only for the snapshot (strip operation metadata)
            const writes = {};
            for (const [k, entry] of Object.entries(this._stageWrites)) {
                writes[k] = entry.value;
            }
            snapshot.stageWrites = writes;
        }
        if (Object.keys(this._stageReads).length > 0) {
            snapshot.stageReads = this._stageReads;
        }
        if (this.description) {
            snapshot.description = this.description;
        }
        if (this.subflowId) {
            snapshot.subflowId = this.subflowId;
        }
        if (this.debug.flowMessages.length > 0) {
            snapshot.flowMessages = this.debug.flowMessages;
        }
        return snapshot;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3RhZ2VDb250ZXh0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9tZW1vcnkvU3RhZ2VDb250ZXh0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OztHQVFHO0FBRUgsT0FBTyxFQUFFLGtCQUFrQixFQUFFLG1CQUFtQixFQUFFLE1BQU0seUJBQXlCLENBQUM7QUFDbEYsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBQ3ZELE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBRS9ELE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxjQUFjLENBQUM7QUFFekMsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sd0JBQXdCLENBQUM7QUFXM0QsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUV6QyxNQUFNLE9BQU8sWUFBWTtJQUNmLFlBQVksQ0FBZTtJQUNuQzs7Ozs7Ozs7Ozs7T0FXRztJQUNLLG9CQUFvQixDQUFnQjtJQUNwQyxNQUFNLENBQXFCO0lBQ25DOzs7OztPQUtHO0lBQ0ssU0FBUyxDQUEyQjtJQUNwQyxRQUFRLENBQVk7SUFFckIsU0FBUyxHQUFHLEVBQUUsQ0FBQztJQUN0Qix1RUFBdUU7SUFDaEUsT0FBTyxDQUFTO0lBQ3ZCLHFGQUFxRjtJQUM5RSxjQUFjLEdBQUcsRUFBRSxDQUFDO0lBQ3BCLEtBQUssQ0FBUztJQUNkLFFBQVEsQ0FBVTtJQUNsQixTQUFTLENBQVU7SUFDbkIsTUFBTSxDQUFVO0lBQ3ZCLG1GQUFtRjtJQUM1RSxXQUFXLENBQVU7SUFDNUIsZ0ZBQWdGO0lBQ3pFLFNBQVMsQ0FBVTtJQUVuQixNQUFNLENBQWdCO0lBQ3RCLElBQUksQ0FBZ0I7SUFDcEIsUUFBUSxDQUFrQjtJQUUxQixLQUFLLEdBQXdCLElBQUksbUJBQW1CLEVBQUUsQ0FBQztJQUU5RCxpRkFBaUY7SUFDekUsWUFBWSxHQUErRSxFQUFF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QyxFQUFFLENBQUM7WUFDOUMsa0VBQWtFO1lBQ2xFLE1BQU0sTUFBTSxHQUE0QixFQUFFLENBQUM7WUFDM0MsS0FBSyxNQUFNLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUM7Z0JBQzNELE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDO1lBQzFCLENBQUM7WUFDRCxRQUFRLENBQUMsV0FBVyxHQUFHLE1BQU0sQ0FBQztRQUNoQyxDQUFDO1FBQ0QsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDN0MsUUFBUSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDO1FBQ3pDLENBQUM7UUFDRCxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNyQixRQUFRLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUM7UUFDMUMsQ0FBQztRQUNELElBQUksSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ25CLFFBQVEsQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUN0QyxDQUFDO1FBQ0QsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDdkMsUUFBUSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQztRQUNsRCxDQUFDO1FBQ0QsT0FBTyxRQUFRLENBQUM7SUFDbEIsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTdGFnZUNvbnRleHQg4oCUIEV4ZWN1dGlvbiBjb250ZXh0IGZvciBhIHNpbmdsZSBzdGFnZSBpbiBhIGZsb3djaGFydCBydW5cbiAqXG4gKiBMaWtlIGEgc3RhY2sgZnJhbWUgaW4gYSBjb21waWxlci9ydW50aW1lOlxuICogLSBSZWZlcmVuY2UgdG8gU2hhcmVkTWVtb3J5IChhY2Nlc3NpbmcgaGVhcCBtZW1vcnkpXG4gKiAtIFRyYW5zYWN0aW9uQnVmZmVyIGZvciBzdGFnaW5nIG11dGF0aW9ucyAodHJhbnNhY3Rpb24gYnVmZmVyKVxuICogLSBMaW5rcyB0byBwYXJlbnQvY2hpbGQvbmV4dCBjb250ZXh0cyAoY2FsbCBzdGFjayBmcmFtZXMpXG4gKiAtIERpYWdub3N0aWNDb2xsZWN0b3IgZm9yIGxvZ3MsIGVycm9ycywgbWV0cmljc1xuICovXG5cbmltcG9ydCB7IHN1bW1hcml6ZVJlYWRWYWx1ZSwgc3VtbWFyaXplV3JpdGVWYWx1ZSB9IGZyb20gJy4uL2NhcHR1cmUvc3VtbWFyaXplLmpzJztcbmltcG9ydCB7IGlzRGV2TW9kZSB9IGZyb20gJy4uL3Njb3BlL2RldGVjdENpcmN1bGFyLmpzJztcbmltcG9ydCB7IERpYWdub3N0aWNDb2xsZWN0b3IgfSBmcm9tICcuL0RpYWdub3N0aWNDb2xsZWN0b3IuanMnO1xuaW1wb3J0IHsgRXZlbnRMb2cgfSBmcm9tICcuL0V2ZW50TG9nLmpzJztcbmltcG9ydCB7IG5hdGl2ZUdldCB9IGZyb20gJy4vcGF0aE9wcy5qcyc7XG5pbXBvcnQgeyBTaGFyZWRNZW1vcnkgfSBmcm9tICcuL1NoYXJlZE1lbW9yeS5qcyc7XG5pbXBvcnQgeyBUcmFuc2FjdGlvbkJ1ZmZlciB9IGZyb20gJy4vVHJhbnNhY3Rpb25CdWZmZXIuanMnO1xuaW1wb3J0IHR5cGUge1xuICBDb21taXRWYWx1ZXNNb2RlLFxuICBGbG93Q29udHJvbFR5cGUsXG4gIEZsb3dNZXNzYWdlLFxuICBSZWFkVHJhY2tpbmdNb2RlLFxuICBTdGFnZVNuYXBzaG90LFxuICBVbnRyYWNrZWRTb3VyY2UsXG4gIFdyaXRlUHJvdmVuYW5jZU1vZGUsXG4gIFdyaXRlVHJhY2tpbmdNb2RlLFxufSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IHJlZGFjdFBhdGNoIH0gZnJvbSAnLi91dGlscy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBTdGFnZUNvbnRleHQge1xuICBwcml2YXRlIHNoYXJlZE1lbW9yeTogU2hhcmVkTWVtb3J5O1xuICAvKipcbiAgICogUGFyYWxsZWwgcmVkYWN0ZWQgbWlycm9yIG9mIGBzaGFyZWRNZW1vcnlgLiBQb3B1bGF0ZWQgaW4gYGNvbW1pdCgpYCB3aXRoXG4gICAqIHRoZSBhbHJlYWR5LWNvbXB1dGVkIHJlZGFjdGVkIHBhdGNoZXMgKHRoZSBzYW1lIG9uZXMgZmVkIHRvIGBldmVudExvZ2ApLlxuICAgKiBQcmVzZW50ICoqb25seSoqIHdoZW4gdGhlIGV4ZWN1dG9yIGhhcyBiZWVuIHRvbGQgdG8gbWFpbnRhaW4gYSByZWRhY3RlZFxuICAgKiB2aWV3IOKAlCBpLmUuIHdoZW4gYSBgUmVkYWN0aW9uUG9saWN5YCBpcyBjb25maWd1cmVkLiBPdGhlcndpc2UgdW5kZWZpbmVkLFxuICAgKiB6ZXJvIGV4dHJhIHdvcmsgcGVyIGNvbW1pdC5cbiAgICpcbiAgICogVGhlIG1pcnJvciBpcyByZWFkIHZpYSBgRmxvd0NoYXJ0RXhlY3V0b3IuZ2V0U25hcHNob3QoeyByZWRhY3Q6IHRydWUgfSlgXG4gICAqIGFuZCBpcyB0aGUgZm91bmRhdGlvbiBmb3IgdGhlIFwiZXhwb3J0IHRyYWNlXCIgLyBwYXN0ZS1pbnRvLXZpZXdlciBmZWF0dXJlXG4gICAqIOKAlCBjb25zdW1lcnMgc2hhcmUgdGhlIHJlZGFjdGVkIHZpZXcgZXh0ZXJuYWxseSB3aXRob3V0IGxlYWtpbmcgcmF3IFBJSVxuICAgKiB0aHJvdWdoIGBzaGFyZWRTdGF0ZWAuXG4gICAqL1xuICBwcml2YXRlIHJlZGFjdGVkU2hhcmVkTWVtb3J5PzogU2hhcmVkTWVtb3J5O1xuICBwcml2YXRlIGJ1ZmZlcj86IFRyYW5zYWN0aW9uQnVmZmVyO1xuICAvKipcbiAgICogQ29tbWl0dGVkLXN0YXRlIHZpZXcgY2FwdHVyZWQgYXQgdGhpcyBzdGFnZSdzIEZJUlNUIHRvdWNoIChmaXJzdCByZWFkIE9SXG4gICAqIGZpcnN0IHdyaXRlKSDigJQgaGVsZCBieSBSRUZFUkVOQ0UsIG5ldmVyIGNsb25lZC4gU2VlXG4gICAqIHtAbGluayBmaXJzdFRvdWNoU3RhdGV9IGZvciB0aGUgYWxnb3JpdGhtIGFuZCB0aGUgaW1tdXRhYmlsaXR5IGludmFyaWFudFxuICAgKiB0aGF0IG1ha2VzIGEgYmFyZSByZWZlcmVuY2Ugc2FmZS5cbiAgICovXG4gIHByaXZhdGUgc3RhdGVWaWV3PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHByaXZhdGUgZXZlbnRMb2c/OiBFdmVudExvZztcblxuICBwdWJsaWMgc3RhZ2VOYW1lID0gJyc7XG4gIC8qKiBVbmlxdWUgc3RhZ2UgaWRlbnRpZmllciBmcm9tIHRoZSBidWlsZGVyIChtYXRjaGVzIHNwZWMgbm9kZSBpZCkuICovXG4gIHB1YmxpYyBzdGFnZUlkOiBzdHJpbmc7XG4gIC8qKiBVbmlxdWUgcGVyLWV4ZWN1dGlvbi1zdGVwIGlkZW50aWZpZXIuIFNldCBieSB0cmF2ZXJzZXIgYmVmb3JlIHN0YWdlIGV4ZWN1dGlvbi4gKi9cbiAgcHVibGljIHJ1bnRpbWVTdGFnZUlkID0gJyc7XG4gIHB1YmxpYyBydW5JZDogc3RyaW5nO1xuICBwdWJsaWMgYnJhbmNoSWQ/OiBzdHJpbmc7XG4gIHB1YmxpYyBpc0RlY2lkZXI6IGJvb2xlYW47XG4gIHB1YmxpYyBpc0Zvcms6IGJvb2xlYW47XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBkZXNjcmlwdGlvbiBmcm9tIGJ1aWxkZXIgKHNldCBieSB0cmF2ZXJzZXIgYmVmb3JlIGV4ZWN1dGlvbikuICovXG4gIHB1YmxpYyBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgLyoqIFN1YmZsb3cgaWRlbnRpZmllciAoc2V0IGJ5IHRyYXZlcnNlciB3aGVuIHRoaXMgaXMgYSBzdWJmbG93IGVudHJ5IHBvaW50KS4gKi9cbiAgcHVibGljIHN1YmZsb3dJZD86IHN0cmluZztcblxuICBwdWJsaWMgcGFyZW50PzogU3RhZ2VDb250ZXh0O1xuICBwdWJsaWMgbmV4dD86IFN0YWdlQ29udGV4dDtcbiAgcHVibGljIGNoaWxkcmVuPzogU3RhZ2VDb250ZXh0W107XG5cbiAgcHVibGljIGRlYnVnOiBEaWFnbm9zdGljQ29sbGVjdG9yID0gbmV3IERpYWdub3N0aWNDb2xsZWN0b3IoKTtcblxuICAvKiogVHJhY2tzIHVzZXItbGV2ZWwgd3JpdGVzIChwcmUtbmFtZXNwYWNlKSBmb3IgdGhlIG1lbW9yeSB2aWV3IGFuZCBvbkNvbW1pdC4gKi9cbiAgcHJpdmF0ZSBfc3RhZ2VXcml0ZXM6IFJlY29yZDxzdHJpbmcsIHsgdmFsdWU6IHVua25vd247IG9wZXJhdGlvbjogJ3NldCcgfCAndXBkYXRlJyB8ICdkZWxldGUnIH0+ID0ge307XG5cbiAgLyoqIFRyYWNrcyB1c2VyLWxldmVsIHJlYWRzIChwcmUtbmFtZXNwYWNlKSBmb3IgdGhlIG1lbW9yeSB2aWV3LiAqL1xuICBwcml2YXRlIF9zdGFnZVJlYWRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuXG4gIC8qKlxuICAgKiBIb3cgdHJhY2tlZCByZWFkcyBhcmUgcmVjb3JkZWQgaW50byBgX3N0YWdlUmVhZHNgICgjMTQpLiBEZWZhdWx0IGAnZnVsbCdgXG4gICAqIHByZXNlcnZlcyB0aGUgaGlzdG9yaWNhbCBwZXItcmVhZCBgc3RydWN0dXJlZENsb25lYC4gSW5oZXJpdGVkIGJ5IGV2ZXJ5XG4gICAqIGNvbnRleHQgY3JlYXRlZCB2aWEge0BsaW5rIGNyZWF0ZU5leHR9IC8ge0BsaW5rIGNyZWF0ZUNoaWxkfSAoc2FtZVxuICAgKiBwcm9wYWdhdGlvbiBwYXR0ZXJuIGFzIHRoZSByZWRhY3RlZCBtaXJyb3IpLCBhbmQgcHVzaGVkIGludG8gc3ViZmxvd1xuICAgKiByb290IGNvbnRleHRzIGJ5IGBTdWJmbG93RXhlY3V0b3JgLiBBZmZlY3RzIE9OTFkgdGhlIHNuYXBzaG90J3NcbiAgICogYHN0YWdlUmVhZHNgIHBheWxvYWQg4oCUIGBTY29wZVJlY29yZGVyLm9uUmVhZGAgKGFuZCB0aGVyZWZvcmUgbmFycmF0aXZlKVxuICAgKiBpcyBkaXNwYXRjaGVkIGF0IHRoZSBzY29wZSB0aWVyIGFuZCBuZXZlciBjbG9uZWQsIHNvIGl0IGlzIGlkZW50aWNhbCBpblxuICAgKiBldmVyeSBtb2RlLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkVHJhY2tpbmc6IFJlYWRUcmFja2luZ01vZGUgPSAnZnVsbCc7XG5cbiAgLyoqXG4gICAqIEhvdyB0cmFja2VkIHdyaXRlcyBhcmUgcmVjb3JkZWQgaW50byBgX3N0YWdlV3JpdGVzYCAoIzEzYy1BKSDigJQgdGhlXG4gICAqIHNpYmxpbmcgb2Yge0BsaW5rIHJlYWRUcmFja2luZ30sIHdpdGggdGhlIHNhbWUgcHJvcGFnYXRpb24gcGF0dGVyblxuICAgKiAoaW5oZXJpdGVkIHZpYSB7QGxpbmsgY3JlYXRlTmV4dH0ve0BsaW5rIGNyZWF0ZUNoaWxkfSwgcHVzaGVkIGludG9cbiAgICogc3ViZmxvdyByb290IGNvbnRleHRzIGJ5IGBTdWJmbG93RXhlY3V0b3JgKS4gR292ZXJucyB0aGUgcGVyLXdyaXRlXG4gICAqIGBzdHJ1Y3R1cmVkQ2xvbmVgIGluIHtAbGluayBzZXRPYmplY3R9L3tAbGluayB1cGRhdGVPYmplY3R9LiBBZmZlY3RzIHRoZVxuICAgKiBzbmFwc2hvdCdzIGBzdGFnZVdyaXRlc2AgcGF5bG9hZCBBTkQgdGhlIGNvbW1pdCBvYnNlcnZlcidzIG11dGF0aW9uc1xuICAgKiBwYXlsb2FkICh3aGljaCBpcyBhIHNwcmVhZCBvZiBgX3N0YWdlV3JpdGVzYCkg4oCUIGJ1dCBOT1QgdGhlIHdyaXRlXG4gICAqIGl0c2VsZjogdGhlIHRyYW5zYWN0aW9uIGJ1ZmZlciwgdGhlIGNvbW1pdCBsb2csIGFuZCBzaGFyZWQgc3RhdGUgYXJlXG4gICAqIGlkZW50aWNhbCBpbiBldmVyeSBtb2RlLCBhbmQgYFNjb3BlUmVjb3JkZXIub25Xcml0ZWAgYWx3YXlzIGZpcmVzIHdpdGhcbiAgICogdGhlIGxpdmUgdmFsdWUuXG4gICAqL1xuICBwcml2YXRlIHdyaXRlVHJhY2tpbmc6IFdyaXRlVHJhY2tpbmdNb2RlID0gJ2Z1bGwnO1xuXG4gIC8qKlxuICAgKiBIb3cgY29tbWl0LWJ1bmRsZSB2YWx1ZXMgYXJlIGVuY29kZWQgaW50byB0aGUgY29tbWl0IGxvZyAoIzEzYy1CKSDigJQgdGhlXG4gICAqIHRoaXJkIGRpYWwgb2YgdGhlIGZhbWlseSwgd2l0aCB0aGUgc2FtZSBwcm9wYWdhdGlvbiBwYXR0ZXJuIGFzXG4gICAqIHtAbGluayByZWFkVHJhY2tpbmd9L3tAbGluayB3cml0ZVRyYWNraW5nfSAoaW5oZXJpdGVkIHZpYVxuICAgKiB7QGxpbmsgY3JlYXRlTmV4dH0ve0BsaW5rIGNyZWF0ZUNoaWxkfSwgcHVzaGVkIGludG8gc3ViZmxvdyByb290XG4gICAqIGNvbnRleHRzIGJ5IGBTdWJmbG93RXhlY3V0b3JgLCByZS1hcHBsaWVkIG9uIHRoZSByZXN1bWUgcGF0aCkuIFBhc3NlZFxuICAgKiBpbnRvIGVhY2gge0BsaW5rIFRyYW5zYWN0aW9uQnVmZmVyfSBhdCBjb25zdHJ1Y3Rpb247IGAnZnVsbCdgIChkZWZhdWx0KVxuICAgKiBpcyBieXRlLWlkZW50aWNhbCB0byBoaXN0b3J5LCBgJ2RlbHRhJ2AgZW5hYmxlcyBhcHBlbmQvZGVsZXRlIHZlcmJzICtcbiAgICogb25lLXRyYWNlLWVudHJ5LXBlci1wYXRoIGRlZHVwLiBMb3NzbGVzcyBpbiBib3RoIG1vZGVzLlxuICAgKi9cbiAgcHJpdmF0ZSBjb21taXRWYWx1ZXM6IENvbW1pdFZhbHVlc01vZGUgPSAnZnVsbCc7XG5cbiAgLyoqXG4gICAqIFBlci13cml0ZSByZWFkLXByb3ZlbmFuY2UgcG9saWN5ICgjUDEpIOKAlCB0aGUgZm91cnRoIGRpYWwgb2YgdGhlIGZhbWlseSxcbiAgICogc2FtZSBwcm9wYWdhdGlvbiBwYXR0ZXJuIGFzIHtAbGluayByZWFkVHJhY2tpbmd9L3tAbGluayB3cml0ZVRyYWNraW5nfS9cbiAgICoge0BsaW5rIGNvbW1pdFZhbHVlc30uIFVuZGVyIGAncmVhZHMtcHJlZml4J2AgdGhpcyBjb250ZXh0IGtlZXBzIGFcbiAgICogbGlnaHR3ZWlnaHQgb3JkZXJlZCBzZXQgb2YgdGhlIGtleXMgdHJhY2tlZC1yZWFkIHNvIGZhciwgYW5kIHRoZVxuICAgKiB0cmFuc2FjdGlvbiBidWZmZXIgc3RhbXBzIHRoYXQgcHJlZml4IG9udG8gZXZlcnkgc3RhZ2VkIHdyaXRlXG4gICAqICh7QGxpbmsgVHJhY2VFbnRyeS5yZWFkS2V5c30pLiBJTkRFUEVOREVOVCBvZiByZWFkVHJhY2tpbmc6IHByb3ZlbmFuY2VcbiAgICogbmVlZHMgb25seSB0aGUga2V5IFNUUklOR1MsIHNvIGl0IHdvcmtzIGV2ZW4gdW5kZXIgcmVhZFRyYWNraW5nICdvZmYnXG4gICAqIChhbmQgY29zdHMgbm90aGluZyB3aGVuIGl0IGlzIGl0c2VsZiAnb2ZmJyDigJQgdGhlIGRlZmF1bHQpLlxuICAgKi9cbiAgcHJpdmF0ZSB3cml0ZVByb3ZlbmFuY2U6IFdyaXRlUHJvdmVuYW5jZU1vZGUgPSAnb2ZmJztcblxuICAvKiogTGF6aWx5LWFsbG9jYXRlZCBvcmRlcmVkIHJlZ2lzdHJ5IG9mIGtleXMgdHJhY2tlZC1yZWFkIGluIFRISVMgc3RhZ2Ug4oCUXG4gICAqICB0aGUgc291cmNlIG9mIHRoZSBwZXItd3JpdGUgcHJlZml4LiBPbmx5IGFsbG9jYXRlZCB1bmRlciB0aGVcbiAgICogIGAncmVhZHMtcHJlZml4J2AgZGlhbDsgaW5zZXJ0aW9uLW9yZGVyZWQgKGEgU2V0KSBhbmQgbW9ub3RvbmljLCB3aGljaFxuICAgKiAgaXMgd2hhdCBtYWtlcyBcImxhc3Qgd3JpdGUncyBwcmVmaXggPT0gdW5pb25cIiBob2xkIGluIGRlbHRhIG1vZGUuICovXG4gIHByaXZhdGUgX3Byb3ZlbmFuY2VSZWFkcz86IFNldDxzdHJpbmc+O1xuXG4gIC8qKlxuICAgKiBSRkMtMDAzIEQyIGhvbmVzdHkgbWFya2VycyDigJQgdW50cmFja2VkIHJlYWQgcGF0aHMgdXNlZCBkdXJpbmcgVEhJU1xuICAgKiBzdGFnZSdzIGV4ZWN1dGlvbiAoYCdhcmdzJ2AgLyBgJ2VudidgIC8gYCdzaWxlbnQnYCkuIE1hcmtlZCBieVxuICAgKiBgU2NvcGVGYWNhZGVgLCBzdXJmYWNlZCBvbiB0aGUgc3RhZ2UncyBDb21taXRCdW5kbGUgYXNcbiAgICogYHVudHJhY2tlZFNvdXJjZXNgLCB0aGVuIFJFTEVBU0VEIHdpdGggdGhlIHN0YWdpbmcgc3RhdGUgYXQgY29tbWl0IGVuZFxuICAgKiAoc28gdGhlIHJvdXRpbmUgZG91YmxlLWNvbW1pdCBwYXRocyDigJQgZm9yayBjaGlsZHJlbiwgc3ViZmxvdyBtb3VudHMg4oCUXG4gICAqIHJlY29yZCB0aGUgZmllbGQgZXhhY3RseSBvbmNlLCBvbiB0aGUgZmlyc3QgY29tbWl0KS4gTGF6aWx5IGFsbG9jYXRlZDpcbiAgICogc3RhZ2VzIHRoYXQgbmV2ZXIgdG91Y2ggYW4gdW50cmFja2VkIHBhdGggcGF5IG5vdGhpbmcuXG4gICAqL1xuICBwcml2YXRlIF91bnRyYWNrZWRTb3VyY2VzPzogU2V0PFVudHJhY2tlZFNvdXJjZT47XG5cbiAgLyoqIE9ic2VydmVyIGNhbGxlZCBhZnRlciBjb21taXQoKSDigJQgdXNlZCBieSBTY29wZUZhY2FkZSB0byBmaXJlIFNjb3BlUmVjb3JkZXIub25Db21taXQuICovXG4gIHByaXZhdGUgX2NvbW1pdE9ic2VydmVyPzogKFxuICAgIG11dGF0aW9uczogUmVjb3JkPHN0cmluZywgeyB2YWx1ZTogdW5rbm93bjsgb3BlcmF0aW9uOiAnc2V0JyB8ICd1cGRhdGUnIHwgJ2RlbGV0ZScgfT4sXG4gICkgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBydW5JZDogc3RyaW5nLFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBzdGFnZUlkOiBzdHJpbmcsXG4gICAgc2hhcmVkTWVtb3J5OiBTaGFyZWRNZW1vcnksXG4gICAgYnJhbmNoSWQ/OiBzdHJpbmcsXG4gICAgZXZlbnRMb2c/OiBFdmVudExvZyxcbiAgICBpc0RlY2lkZXI/OiBib29sZWFuLFxuICApIHtcbiAgICB0aGlzLnJ1bklkID0gcnVuSWQ7XG4gICAgdGhpcy5zdGFnZU5hbWUgPSBuYW1lO1xuICAgIHRoaXMuc3RhZ2VJZCA9IHN0YWdlSWQ7XG4gICAgdGhpcy5zaGFyZWRNZW1vcnkgPSBzaGFyZWRNZW1vcnk7XG4gICAgdGhpcy5icmFuY2hJZCA9IGJyYW5jaElkO1xuICAgIHRoaXMuZXZlbnRMb2cgPSBldmVudExvZztcbiAgICB0aGlzLmlzRGVjaWRlciA9ICEhaXNEZWNpZGVyO1xuICAgIHRoaXMuaXNGb3JrID0gZmFsc2U7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgU2hhcmVkTWVtb3J5IGluc3RhbmNlIChuZWVkZWQgYnkgc2NvcGUgbGF5ZXIpLiAqL1xuICBnZXRTaGFyZWRNZW1vcnkoKTogU2hhcmVkTWVtb3J5IHtcbiAgICByZXR1cm4gdGhpcy5zaGFyZWRNZW1vcnk7XG4gIH1cblxuICAvKipcbiAgICogSW5zdGFsbCBhIHBhcmFsbGVsIHJlZGFjdGVkIG1pcnJvci4gU3Vic2VxdWVudCBgY29tbWl0KClgIGNhbGxzIHdpbGxcbiAgICogYXBwbHkgdGhlIGFscmVhZHktY29tcHV0ZWQgcmVkYWN0ZWQgcGF0Y2hlcyB0byB0aGlzIG1pcnJvciBpbiBhZGRpdGlvblxuICAgKiB0byB0aGUgcmF3IGBzaGFyZWRNZW1vcnlgICsgYGV2ZW50TG9nYC4gQ2hpbGQgLyBuZXh0IGNvbnRleHRzIGluaGVyaXRcbiAgICogdGhlIG1pcnJvciB2aWEgYGNyZWF0ZU5leHRgIC8gYGNyZWF0ZUNoaWxkYC5cbiAgICpcbiAgICogQ2FsbGVkIG9uY2UgYXQgdGhlIHJvb3QgY29udGV4dCBieSBgRXhlY3V0aW9uUnVudGltZS5lbmFibGVSZWRhY3RlZE1pcnJvcigpYC5cbiAgICovXG4gIHVzZVJlZGFjdGVkTWlycm9yKG1pcnJvcjogU2hhcmVkTWVtb3J5KTogdm9pZCB7XG4gICAgdGhpcy5yZWRhY3RlZFNoYXJlZE1lbW9yeSA9IG1pcnJvcjtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSByZWRhY3RlZCBtaXJyb3IgaWYgaW5zdGFsbGVkLCBlbHNlIHVuZGVmaW5lZC4gKi9cbiAgZ2V0UmVkYWN0ZWRTaGFyZWRNZW1vcnkoKTogU2hhcmVkTWVtb3J5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5yZWRhY3RlZFNoYXJlZE1lbW9yeTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgdGhlIHJlYWQtdHJhY2tpbmcgcG9saWN5IGZvciB0aGlzIGNvbnRleHQgKCMxNCkuIENhbGxlZCBhdCB0aGUgcm9vdFxuICAgKiBieSBgRXhlY3V0aW9uUnVudGltZS51c2VSZWFkVHJhY2tpbmcoKWAgKHBsdW1iZWQgZnJvbVxuICAgKiBgRmxvd0NoYXJ0RXhlY3V0b3JgKTsgZGVzY2VuZGFudHMgaW5oZXJpdCB2aWEgYGNyZWF0ZU5leHRgL2BjcmVhdGVDaGlsZGAsXG4gICAqIGFuZCBgU3ViZmxvd0V4ZWN1dG9yYCBwdXNoZXMgdGhlIHBhcmVudCBjb250ZXh0J3MgbW9kZSBpbnRvIGVhY2ggc3ViZmxvd1xuICAgKiByb290IHNvIG5lc3RlZCBjaGFydHMgaW5oZXJpdCB0b28uXG4gICAqL1xuICB1c2VSZWFkVHJhY2tpbmcobW9kZTogUmVhZFRyYWNraW5nTW9kZSk6IHZvaWQge1xuICAgIHRoaXMucmVhZFRyYWNraW5nID0gbW9kZTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSBhY3RpdmUgcmVhZC10cmFja2luZyBwb2xpY3kgKHVzZWQgZm9yIHN1YmZsb3cgcHJvcGFnYXRpb24pLiAqL1xuICBnZXRSZWFkVHJhY2tpbmcoKTogUmVhZFRyYWNraW5nTW9kZSB7XG4gICAgcmV0dXJuIHRoaXMucmVhZFRyYWNraW5nO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCB0aGUgd3JpdGUtdHJhY2tpbmcgcG9saWN5IGZvciB0aGlzIGNvbnRleHQgKCMxM2MtQSkuIFNhbWUgcGx1bWJpbmdcbiAgICogYXMge0BsaW5rIHVzZVJlYWRUcmFja2luZ306IGNhbGxlZCBhdCB0aGUgcm9vdCBieVxuICAgKiBgRXhlY3V0aW9uUnVudGltZS51c2VXcml0ZVRyYWNraW5nKClgIChwbHVtYmVkIGZyb20gYEZsb3dDaGFydEV4ZWN1dG9yYCk7XG4gICAqIGRlc2NlbmRhbnRzIGluaGVyaXQgdmlhIGBjcmVhdGVOZXh0YC9gY3JlYXRlQ2hpbGRgLCBhbmQgYFN1YmZsb3dFeGVjdXRvcmBcbiAgICogcHVzaGVzIHRoZSBwYXJlbnQgY29udGV4dCdzIG1vZGUgaW50byBlYWNoIHN1YmZsb3cgcm9vdC5cbiAgICovXG4gIHVzZVdyaXRlVHJhY2tpbmcobW9kZTogV3JpdGVUcmFja2luZ01vZGUpOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlVHJhY2tpbmcgPSBtb2RlO1xuICB9XG5cbiAgLyoqIFJldHVybnMgdGhlIGFjdGl2ZSB3cml0ZS10cmFja2luZyBwb2xpY3kgKHVzZWQgZm9yIHN1YmZsb3cgcHJvcGFnYXRpb24pLiAqL1xuICBnZXRXcml0ZVRyYWNraW5nKCk6IFdyaXRlVHJhY2tpbmdNb2RlIHtcbiAgICByZXR1cm4gdGhpcy53cml0ZVRyYWNraW5nO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCB0aGUgY29tbWl0LXZhbHVlcyBlbmNvZGluZyBwb2xpY3kgZm9yIHRoaXMgY29udGV4dCAoIzEzYy1CKS4gU2FtZVxuICAgKiBwbHVtYmluZyBhcyB7QGxpbmsgdXNlUmVhZFRyYWNraW5nfS97QGxpbmsgdXNlV3JpdGVUcmFja2luZ306IGNhbGxlZCBhdFxuICAgKiB0aGUgcm9vdCBieSBgRXhlY3V0aW9uUnVudGltZS51c2VDb21taXRWYWx1ZXMoKWAgKHBsdW1iZWQgZnJvbVxuICAgKiBgRmxvd0NoYXJ0RXhlY3V0b3JgKTsgZGVzY2VuZGFudHMgaW5oZXJpdCB2aWEgYGNyZWF0ZU5leHRgL2BjcmVhdGVDaGlsZGAsXG4gICAqIGFuZCBgU3ViZmxvd0V4ZWN1dG9yYCBwdXNoZXMgdGhlIHBhcmVudCBjb250ZXh0J3MgbW9kZSBpbnRvIGVhY2ggc3ViZmxvd1xuICAgKiByb290LlxuICAgKi9cbiAgdXNlQ29tbWl0VmFsdWVzKG1vZGU6IENvbW1pdFZhbHVlc01vZGUpOiB2b2lkIHtcbiAgICB0aGlzLmNvbW1pdFZhbHVlcyA9IG1vZGU7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgYWN0aXZlIGNvbW1pdC12YWx1ZXMgcG9saWN5ICh1c2VkIGZvciBzdWJmbG93IHByb3BhZ2F0aW9uKS4gKi9cbiAgZ2V0Q29tbWl0VmFsdWVzKCk6IENvbW1pdFZhbHVlc01vZGUge1xuICAgIHJldHVybiB0aGlzLmNvbW1pdFZhbHVlcztcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgdGhlIHBlci13cml0ZSByZWFkLXByb3ZlbmFuY2UgcG9saWN5ICgjUDEpLiBTYW1lIHBsdW1iaW5nIGFzIHRoZVxuICAgKiBvdGhlciB0aHJlZSBkaWFsczogY2FsbGVkIGF0IHRoZSByb290IGJ5XG4gICAqIGBFeGVjdXRpb25SdW50aW1lLnVzZVdyaXRlUHJvdmVuYW5jZSgpYCAocGx1bWJlZCBmcm9tXG4gICAqIGBGbG93Q2hhcnRFeGVjdXRvcmApOyBkZXNjZW5kYW50cyBpbmhlcml0IHZpYSBgY3JlYXRlTmV4dGAvYGNyZWF0ZUNoaWxkYCxcbiAgICogYW5kIGBTdWJmbG93RXhlY3V0b3JgIHB1c2hlcyB0aGUgcGFyZW50IGNvbnRleHQncyBtb2RlIGludG8gZWFjaCBzdWJmbG93XG4gICAqIHJvb3Qgc28gbmVzdGVkIGNoYXJ0cyBpbmhlcml0IHRvby5cbiAgICovXG4gIHVzZVdyaXRlUHJvdmVuYW5jZShtb2RlOiBXcml0ZVByb3ZlbmFuY2VNb2RlKTogdm9pZCB7XG4gICAgdGhpcy53cml0ZVByb3ZlbmFuY2UgPSBtb2RlO1xuICB9XG5cbiAgLyoqIFJldHVybnMgdGhlIGFjdGl2ZSB3cml0ZS1wcm92ZW5hbmNlIHBvbGljeSAodXNlZCBmb3Igc3ViZmxvdyBwcm9wYWdhdGlvbikuICovXG4gIGdldFdyaXRlUHJvdmVuYW5jZSgpOiBXcml0ZVByb3ZlbmFuY2VNb2RlIHtcbiAgICByZXR1cm4gdGhpcy53cml0ZVByb3ZlbmFuY2U7XG4gIH1cblxuICAvKipcbiAgICogUmVjb3JkIGEgdHJhY2tlZCB1c2VyLWxldmVsIHdyaXRlIGludG8gYF9zdGFnZVdyaXRlc2AsIHBvbGljeS1nYXRlZFxuICAgKiAoIzEzYy1BKSDigJQgdGhlIHNpbmdsZSBib29ra2VlcGluZyBwYXRoIGZvciB7QGxpbmsgc2V0T2JqZWN0fSBhbmRcbiAgICoge0BsaW5rIHVwZGF0ZU9iamVjdH0uXG4gICAqXG4gICAqIFJlZGFjdGlvbiB0YWtlcyBwcmVjZWRlbmNlIG92ZXIgdGhlIGRpYWwgaW4gRVZFUlkgbW9kZTogYSByZWRhY3RlZFxuICAgKiB3cml0ZSBzdG9yZXMgdGhlIGAnW1JFREFDVEVEXSdgIHBsYWNlaG9sZGVyIHVuZGVyIGAnZnVsbCdgIEFORFxuICAgKiBgJ3N1bW1hcnknYCAoYSBzdW1tYXJ5IG1hcmtlciB3b3VsZCBsZWFrIHRoZSB2YWx1ZSdzIHByZXZpZXcvc2l6ZSksXG4gICAqIGFuZCBzdG9yZXMgbm90aGluZyB1bmRlciBgJ29mZidgIChlbnRyeSBza2lwcGVkIGVudGlyZWx5IOKAlCBub3RoaW5nIHRvXG4gICAqIGxlYWspLiBUaGUgc3RhZ2VkIHdyaXRlIGl0c2VsZiBpcyB1bmFmZmVjdGVkIOKAlCByZWRhY3Rpb24gb2YgdGhlXG4gICAqIGNvbW1pdHRlZCBwYXlsb2FkIGlzIGhhbmRsZWQgYnkgdGhlIHRyYW5zYWN0aW9uIGJ1ZmZlcidzXG4gICAqIGByZWRhY3RlZFBhdGhzYC5cbiAgICovXG4gIHByaXZhdGUgdHJhY2tXcml0ZSh1c2VyS2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBzaG91bGRSZWRhY3Q6IGJvb2xlYW4sIG9wZXJhdGlvbjogJ3NldCcgfCAndXBkYXRlJyB8ICdkZWxldGUnKSB7XG4gICAgaWYgKHRoaXMud3JpdGVUcmFja2luZyA9PT0gJ29mZicpIHJldHVybjtcbiAgICB0aGlzLl9zdGFnZVdyaXRlc1t1c2VyS2V5XSA9IHtcbiAgICAgIHZhbHVlOiBzaG91bGRSZWRhY3RcbiAgICAgICAgPyAnW1JFREFDVEVEXSdcbiAgICAgICAgOiB0aGlzLndyaXRlVHJhY2tpbmcgPT09ICdzdW1tYXJ5J1xuICAgICAgICA/IHN1bW1hcml6ZVdyaXRlVmFsdWUodmFsdWUpXG4gICAgICAgIDogc3RydWN0dXJlZENsb25lKHZhbHVlKSxcbiAgICAgIG9wZXJhdGlvbixcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIOKUgOKUgCBUaGUgZmlyc3QtdG91Y2ggc3RhdGUgdmlldyAoIzEzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICpcbiAgICogV0hBVDogcmV0dXJucyB0aGUgY29tbWl0dGVkIHNoYXJlZCBzdGF0ZSBhcyBpdCB3YXMgYXQgdGhpcyBzdGFnZSdzIEZJUlNUXG4gICAqIHRvdWNoIChmaXJzdCByZWFkIG9yIGZpcnN0IHdyaXRlKSwgY2FwdHVyaW5nIHRoZSByZWZlcmVuY2Ugb24gZmlyc3QgY2FsbC5cbiAgICogU2VydmVzIHR3byBjb25zdW1lcnM6IHJlYWRzIGJlZm9yZSB0aGUgZmlyc3Qgd3JpdGUgKHtAbGluayByZWFkU3RhdGV9KVxuICAgKiBhbmQgdGhlIHRyYW5zYWN0aW9uIGJ1ZmZlcidzIGRpZmYgYmFzZSAoe0BsaW5rIGdldFRyYW5zYWN0aW9uQnVmZmVyfSkuXG4gICAqXG4gICAqIFdIWSBBIEJBUkUgUkVGRVJFTkNFIElTIFNBRkUg4oCUIHRoZSBpbnZhcmlhbnQgdGhpcyByZXN0cyBvbjogY29tbWl0dGVkXG4gICAqIHN0YXRlIGlzIGltbXV0YWJsZS1hZnRlci1zd2FwLiBgU2hhcmVkTWVtb3J5LmFwcGx5UGF0Y2hgIHJvdXRlcyB0aHJvdWdoXG4gICAqIGBhcHBseVNtYXJ0TWVyZ2VgLCB3aGljaCBgc3RydWN0dXJlZENsb25lYHMgdGhlIGN1cnJlbnQgc3RhdGUsIG11dGF0ZXNcbiAgICogb25seSB0aGUgY2xvbmUsIGFuZCBzd2FwcyBgU2hhcmVkTWVtb3J5LmNvbnRleHRgIHRvIGl0IOKAlCB0aGUgb2JqZWN0IGFcbiAgICogc3RhZ2UgY2FwdHVyZWQgaGVyZSBpcyBuZXZlciBlZGl0ZWQgYWZ0ZXJ3YXJkcy4gKGBTaGFyZWRNZW1vcnkuc2V0VmFsdWVgL1xuICAgKiBgdXBkYXRlVmFsdWVgIERPIG11dGF0ZSBpbiBwbGFjZSwgYnV0IGhhdmUgbm8gY2FsbGVycyBkdXJpbmcgdHJhdmVyc2FsO1xuICAgKiBldmVyeSBydW50aW1lIHdyaXRlIHJlYWNoZXMgc3RhdGUgdGhyb3VnaCBhIHN0YWdlIGNvbW1pdCdzIGBhcHBseVBhdGNoYC4pXG4gICAqIEhvbGRpbmcgdGhlIHJlZmVyZW5jZSB0aGVyZWZvcmUgZ2l2ZXMgdGhpcyBzdGFnZSBhIHN0YWJsZSBzbmFwc2hvdCBhdFxuICAgKiB6ZXJvIGNvc3Qg4oCUIG5vIGNsb25lLCB3aGljaCBpcyB0aGUgZW50aXJlIHBvaW50IG9mICMxMy5cbiAgICpcbiAgICogV0hZIEZJUlNUIFRPVUNILCBub3QgZmlyc3Qgd3JpdGU6IHRoZSBwcmUtIzEzIGVhZ2VyIGVuZ2luZSBjbG9uZWQgdGhlXG4gICAqIHN0YXRlIGludG8gdGhlIGJ1ZmZlciBhdCB0aGUgc3RhZ2UncyBmaXJzdCBBQ0NFU1MsIGFuY2hvcmluZyBib3RoIGl0c1xuICAgKiBzbmFwc2hvdCByZWFkcyBhbmQgaXRzIGNvbW1pdCBiYXNlbGluZSAodGhlIG5ldC1jaGFuZ2UgZGlmZiBiYXNlKSB0aGVyZS5cbiAgICogIzEzJ3MgZmlyc3QgY3V0IGFuY2hvcmVkIHRoZSBsYXp5IGJ1ZmZlciBhdCBmaXJzdCBXUklURSDigJQgb2JzZXJ2YWJseVxuICAgKiBkaWZmZXJlbnQgd2hlbiBzb21ldGhpbmcgZWxzZSBjb21taXRzIGluIHRoZSBnYXAgYmV0d2VlbiB0aGlzIHN0YWdlJ3NcbiAgICogZmlyc3QgcmVhZCBhbmQgaXRzIGZpcnN0IHdyaXRlLiBUaGF0IGdhcCBpcyBSRUFDSEFCTEU6IGZvcmsgc2libGluZ3MgYXJlXG4gICAqIG5hbWVzcGFjZS1pc29sYXRlZCBmb3IgcnVuLXNjb3BlZCBrZXlzIChlYWNoIGNoaWxkIHdyaXRlcyB1bmRlclxuICAgKiBgcnVucy88Y2hpbGRJZD4vYCksIGJ1dCBST09ULWxldmVsIGtleXMgYXJlIHNoYXJlZCDigJQgd3JpdHRlbiB2aWFcbiAgICogYHNldEdsb2JhbGAgZnJvbSBjb25zdW1lciBzY29wZSBjb2RlIGFuZCwgY3JpdGljYWxseSwgYnlcbiAgICogYFN1YmZsb3dJbnB1dE1hcHBlcmAncyBvdXRwdXQgbWFwcGluZyAoYHBhcmVudENvbnRleHQuc2V0R2xvYmFsYCksIHdoaWNoXG4gICAqIGlzIGV4YWN0bHkgd2hhdCBydW5zIHdoZW4gYSBzdWJmbG93IGlzIGEgZm9yayBicmFuY2guIEEgc2libGluZydzXG4gICAqIHJvb3Qta2V5IGNvbW1pdCBsYW5kaW5nIGluIHRoZSBnYXAgd291bGQgc2hpZnQgdGhpcyBzdGFnZSdzIGRpZmYgYmFzZSxcbiAgICogbWFraW5nIGl0cyBDb21taXRCdW5kbGUgcmVjb3JkIGEgcGhhbnRvbSBjaGFuZ2UgKG9yIHN3YWxsb3cgYSByZWFsIG9uZSlcbiAgICogcmVsYXRpdmUgdG8gdGhlIGVhZ2VyIGVuZ2luZS4gQW5jaG9yaW5nIHRoZSB2aWV3IGF0IGZpcnN0IHRvdWNoIHJlc3RvcmVzXG4gICAqIHRoZSBFWEFDVCBlYWdlciBzZW1hbnRpY3Mg4oCUIHNlcXVlbnRpYWwgQU5EIHBhcmFsbGVsIOKAlCBhdCB6ZXJvIGNsb25lIGNvc3QuXG4gICAqXG4gICAqIFJlYWQgdmlzaWJpbGl0eSBpcyB0d28tdGllciwgbWF0Y2hpbmcgZWFnZXIgYnl0ZS1mb3ItYnl0ZToga2V5cyBwcmVzZW50XG4gICAqIGluIHRoZSB2aWV3IGF0IGZpcnN0IHRvdWNoIHJlYWQgcmVwZWF0YWJseSBmcm9tIGl0OyBrZXlzIEFCU0VOVCBmcm9tIGl0XG4gICAqIGZhbGwgYmFjayB0byBMSVZFIHN0YXRlICh0aGUgZWFnZXIgZW5naW5lJ3MgZXhhY3QgZmFsbGJhY2sg4oCUIGFcbiAgICogbWlkLWZsaWdodCBzaWJsaW5nIHJvb3Qta2V5IHdyaXRlIHdhcyBhbHdheXMgdmlzaWJsZSB0byByZWFkcywgYW5kXG4gICAqIHN0YXlzIHZpc2libGU7IG9ubHkgdGhlIERJRkYgQkFTRSBpcyBwaW5uZWQpLlxuICAgKi9cbiAgcHJpdmF0ZSBmaXJzdFRvdWNoU3RhdGUoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGlmICghdGhpcy5zdGF0ZVZpZXcpIHtcbiAgICAgIHRoaXMuc3RhdGVWaWV3ID0gdGhpcy5zaGFyZWRNZW1vcnkuZ2V0U3RhdGUoKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuc3RhdGVWaWV3O1xuICB9XG5cbiAgLyoqIExhemlseSBjcmVhdGVzIHRoZSB0cmFuc2FjdGlvbiBidWZmZXIgb24gdGhlIHN0YWdlJ3MgRklSU1QgV1JJVEUgKCMxMykuXG4gICAqXG4gICAqICBSZWFkcyBORVZFUiBjb25zdHJ1Y3QgaXQ6IHJlYWQteW91ci13cml0ZXMgb25seSBtYXR0ZXJzIG9uY2UgYSBzdGFnZWRcbiAgICogIHdyaXRlIGV4aXN0cywgc28gYmVmb3JlIHRoYXQge0BsaW5rIGdldFZhbHVlfS97QGxpbmsgZ2V0VmFsdWVEaXJlY3R9XG4gICAqICBzZXJ2ZSBmcm9tIHRoZSBmaXJzdC10b3VjaCBzdGF0ZSB2aWV3IGFuZCB7QGxpbmsgY29tbWl0fSByZWNvcmRzIGFuXG4gICAqICBlbXB0eSBidW5kbGUg4oCUIGFsbCB3aXRoIFpFUk8gYHN0cnVjdHVyZWRDbG9uZWBzIG9mIHRoZSBzaGFyZWQgc3RhdGUuXG4gICAqXG4gICAqICBUaGUgYnVmZmVyJ3MgYmFzZSBpcyB0aGUgRklSU1QtVE9VQ0ggdmlldywgTk9UIHRoZSBsaXZlIHN0YXRlIGF0IHdyaXRlXG4gICAqICB0aW1lOiB1bmRlciBwYXJhbGxlbCBmb3JrcyBhIHNpYmxpbmcgbWF5IGhhdmUgY29tbWl0dGVkIGJldHdlZW4gdGhpc1xuICAgKiAgc3RhZ2UncyBmaXJzdCByZWFkIGFuZCB0aGlzIHdyaXRlLCBhbmQgdGhlIG5ldC1jaGFuZ2UgZGlmZiBiYXNlIG11c3RcbiAgICogIHN0YXkgYW5jaG9yZWQgYXQgZmlyc3QgdG91Y2ggdG8gbWF0Y2ggdGhlIGVhZ2VyIGVuZ2luZSDigJQgc2VlXG4gICAqICB7QGxpbmsgZmlyc3RUb3VjaFN0YXRlfS4gKi9cbiAgZ2V0VHJhbnNhY3Rpb25CdWZmZXIoKTogVHJhbnNhY3Rpb25CdWZmZXIge1xuICAgIGlmICghdGhpcy5idWZmZXIpIHtcbiAgICAgIC8vIFBlci13cml0ZSBwcm92ZW5hbmNlICgjUDEpOiBoYW5kIHRoZSBidWZmZXIgYSBsaXZlIHZpZXcgb2YgdGhpc1xuICAgICAgLy8gc3RhZ2UncyByZWFkIHByZWZpeCDigJQgZXZhbHVhdGVkIEFUIEVBQ0ggV1JJVEUsIHNvIGVhY2ggc3RhZ2VkIG9wXG4gICAgICAvLyBjYXB0dXJlcyBleGFjdGx5IHRoZSByZWFkcyB0aGF0IHByZWNlZGVkIGl0ICh0ZW1wb3JhbCBwcmVmaXgpLlxuICAgICAgY29uc3QgcmVhZEtleXNQcm92aWRlciA9XG4gICAgICAgIHRoaXMud3JpdGVQcm92ZW5hbmNlID09PSAncmVhZHMtcHJlZml4JyA/ICgpID0+IFsuLi4odGhpcy5fcHJvdmVuYW5jZVJlYWRzID8/IFtdKV0gOiB1bmRlZmluZWQ7XG4gICAgICB0aGlzLmJ1ZmZlciA9IG5ldyBUcmFuc2FjdGlvbkJ1ZmZlcih0aGlzLmZpcnN0VG91Y2hTdGF0ZSgpLCB0aGlzLmNvbW1pdFZhbHVlcywgcmVhZEtleXNQcm92aWRlcik7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmJ1ZmZlcjtcbiAgfVxuXG4gIC8qKiBCdWlsZHMgYW4gYWJzb2x1dGUgcGF0aCBpbnNpZGUgdGhlIHNoYXJlZCBtZW1vcnkgKHJ1biBuYW1lc3BhY2UpLiAqL1xuICBwcml2YXRlIHdpdGhOYW1lc3BhY2UocGF0aDogc3RyaW5nW10sIGtleTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIGlmICghdGhpcy5ydW5JZCB8fCB0aGlzLnJ1bklkID09PSAnJykge1xuICAgICAgcmV0dXJuIFsuLi5wYXRoLCBrZXldO1xuICAgIH1cbiAgICByZXR1cm4gWydydW5zJywgdGhpcy5ydW5JZCwgLi4ucGF0aCwga2V5XTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBXcml0ZSBvcGVyYXRpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHBhdGNoKHBhdGg6IHN0cmluZ1tdLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIHNob3VsZFJlZGFjdCA9IGZhbHNlKSB7XG4gICAgdGhpcy5nZXRUcmFuc2FjdGlvbkJ1ZmZlcigpLnNldCh0aGlzLndpdGhOYW1lc3BhY2UocGF0aCwga2V5KSwgdmFsdWUsIHNob3VsZFJlZGFjdCk7XG4gIH1cblxuICBzZXQocGF0aDogc3RyaW5nW10sIGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuICAgIHRoaXMucGF0Y2gocGF0aCwga2V5LCB2YWx1ZSk7XG4gIH1cblxuICBtZXJnZShwYXRoOiBzdHJpbmdbXSwga2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5nZXRUcmFuc2FjdGlvbkJ1ZmZlcigpLm1lcmdlKHRoaXMud2l0aE5hbWVzcGFjZShwYXRoLCBrZXkpLCB2YWx1ZSk7XG4gIH1cblxuICBzZXRPYmplY3QoXG4gICAgcGF0aDogc3RyaW5nW10sXG4gICAga2V5OiBzdHJpbmcsXG4gICAgdmFsdWU6IHVua25vd24sXG4gICAgc2hvdWxkUmVkYWN0PzogYm9vbGVhbixcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgICBvcGVyYXRpb25PdmVycmlkZT86ICdzZXQnIHwgJ2RlbGV0ZScsXG4gICkge1xuICAgIGlmIChvcGVyYXRpb25PdmVycmlkZSA9PT0gJ2RlbGV0ZScpIHtcbiAgICAgIC8vIEV4cGxpY2l0IGRlbGV0aW9uIChTY29wZUZhY2FkZS5kZWxldGVWYWx1ZSkgc3RhZ2VzIGEgZGlzdGluY3Qgb3Agc29cbiAgICAgIC8vIGRlbHRhLW1vZGUgY29tbWl0cyAoIzEzYy1CKSBjYW4gZW1pdCBhIHJlYWwgYGRlbGV0ZWAgdHJhY2UgZW50cnkuXG4gICAgICAvLyBVbmRlciB0aGUgZGVmYXVsdCAnZnVsbCcgbW9kZSB0aGUgYnVmZmVyIGNvbW1pdHMgaXQgYXMgYVxuICAgICAgLy8gc2V0LW9mLXVuZGVmaW5lZCDigJQgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGhpc3RvcmljYWwgZmxhdHRlbmluZy5cbiAgICAgIHRoaXMuZ2V0VHJhbnNhY3Rpb25CdWZmZXIoKS5kZWxldGUodGhpcy53aXRoTmFtZXNwYWNlKHBhdGgsIGtleSksIHNob3VsZFJlZGFjdCA/PyBmYWxzZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMucGF0Y2gocGF0aCwga2V5LCB2YWx1ZSwgc2hvdWxkUmVkYWN0ID8/IGZhbHNlKTtcbiAgICB9XG4gICAgLy8gVHJhY2sgdXNlci1sZXZlbCB3cml0ZSAocHJlLW5hbWVzcGFjZSkgZm9yIG1lbW9yeSB2aWV3ICsgb25Db21taXQg4oCUXG4gICAgLy8gcG9saWN5LWdhdGVkICgjMTNjLUEpLCBzZWUgdHJhY2tXcml0ZS5cbiAgICBjb25zdCB1c2VyS2V5ID0gcGF0aC5sZW5ndGggPiAwID8gWy4uLnBhdGgsIGtleV0uam9pbignLicpIDoga2V5O1xuICAgIHRoaXMudHJhY2tXcml0ZSh1c2VyS2V5LCB2YWx1ZSwgc2hvdWxkUmVkYWN0ID8/IGZhbHNlLCBvcGVyYXRpb25PdmVycmlkZSA/PyAnc2V0Jyk7XG4gICAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgICBjb25zdCB0YWdnZWQgPSBkZXNjcmlwdGlvbi5zdGFydHNXaXRoKCdbJykgPyBkZXNjcmlwdGlvbiA6IGBbV1JJVEVdICR7ZGVzY3JpcHRpb259YDtcbiAgICAgIHRoaXMuZGVidWcuYWRkTG9nKCdtZXNzYWdlJywgdGFnZ2VkKTtcbiAgICB9XG4gIH1cblxuICB1cGRhdGVPYmplY3QocGF0aDogc3RyaW5nW10sIGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVzY3JpcHRpb24/OiBzdHJpbmcsIHNob3VsZFJlZGFjdD86IGJvb2xlYW4pIHtcbiAgICB0aGlzLm1lcmdlKHBhdGgsIGtleSwgdmFsdWUpO1xuICAgIC8vIFRyYWNrIHVzZXItbGV2ZWwgd3JpdGUgKHByZS1uYW1lc3BhY2UpIGZvciBtZW1vcnkgdmlldyArIG9uQ29tbWl0IOKAlFxuICAgIC8vIHBvbGljeS1nYXRlZCAoIzEzYy1BKSwgc2VlIHRyYWNrV3JpdGUuXG4gICAgY29uc3QgdXNlcktleSA9IHBhdGgubGVuZ3RoID4gMCA/IFsuLi5wYXRoLCBrZXldLmpvaW4oJy4nKSA6IGtleTtcbiAgICB0aGlzLnRyYWNrV3JpdGUodXNlcktleSwgdmFsdWUsIHNob3VsZFJlZGFjdCA/PyBmYWxzZSwgJ3VwZGF0ZScpO1xuICAgIGlmIChkZXNjcmlwdGlvbikge1xuICAgICAgdGhpcy5kZWJ1Zy5hZGRMb2coJ21lc3NhZ2UnLCBkZXNjcmlwdGlvbik7XG4gICAgfVxuICB9XG5cbiAgc2V0Um9vdChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICB0aGlzLnBhdGNoKFtdLCBrZXksIHZhbHVlKTtcbiAgfVxuXG4gIHNldEdsb2JhbChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGRlc2NyaXB0aW9uPzogc3RyaW5nKSB7XG4gICAgdGhpcy5nZXRUcmFuc2FjdGlvbkJ1ZmZlcigpLnNldChba2V5XSwgdmFsdWUpO1xuICAgIGlmIChkZXNjcmlwdGlvbikge1xuICAgICAgdGhpcy5kZWJ1Zy5hZGRMb2coJ21lc3NhZ2UnLCBkZXNjcmlwdGlvbik7XG4gICAgfVxuICB9XG5cbiAgdXBkYXRlR2xvYmFsQ29udGV4dChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICB0aGlzLmdldFRyYW5zYWN0aW9uQnVmZmVyKCkuc2V0KFtrZXldLCB2YWx1ZSk7XG4gIH1cblxuICBhcHBlbmRUb0FycmF5KHBhdGg6IHN0cmluZ1tdLCBrZXk6IHN0cmluZywgaXRlbXM6IHVua25vd25bXSwgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuZ2V0VmFsdWUocGF0aCwga2V5KTtcbiAgICBjb25zdCBtZXJnZWQgPSBBcnJheS5pc0FycmF5KGV4aXN0aW5nKSA/IFsuLi5leGlzdGluZywgLi4uaXRlbXNdIDogWy4uLml0ZW1zXTtcbiAgICB0aGlzLnNldE9iamVjdChwYXRoLCBrZXksIG1lcmdlZCwgZmFsc2UsIGRlc2NyaXB0aW9uKTtcbiAgfVxuXG4gIG1lcmdlT2JqZWN0KHBhdGg6IHN0cmluZ1tdLCBrZXk6IHN0cmluZywgb2JqOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuZ2V0VmFsdWUocGF0aCwga2V5KTtcbiAgICBjb25zdCBtZXJnZWQgPVxuICAgICAgZXhpc3RpbmcgJiYgdHlwZW9mIGV4aXN0aW5nID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShleGlzdGluZylcbiAgICAgICAgPyB7IC4uLihleGlzdGluZyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiksIC4uLm9iaiB9XG4gICAgICAgIDogeyAuLi5vYmogfTtcbiAgICB0aGlzLnNldE9iamVjdChwYXRoLCBrZXksIG1lcmdlZCwgZmFsc2UsIGRlc2NyaXB0aW9uKTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBSZWFkIG9wZXJhdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIEJ1ZmZlci1hd2FyZSByZWFkLCBtaXJyb3JpbmcgdGhlIGVhZ2VyIGVuZ2luZSdzIHJlYWQgb3JkZXIgYnl0ZS1mb3ItYnl0ZTpcbiAgICpcbiAgICogICAgMS4gc3RhZ2VkIHdyaXRlcyArIGZpcnN0LXRvdWNoIHNuYXBzaG90IOKAlCBgYnVmZmVyLmdldGAgb3ZlciBpdHNcbiAgICogICAgICAgd29ya2luZ0NvcHkgd2hlbiB0aGUgYnVmZmVyIGV4aXN0cywgZWxzZSBgbmF0aXZlR2V0YCBvdmVyIHRoZVxuICAgKiAgICAgICB6ZXJvLWNsb25lIHN0YXRlIHZpZXcgKHRoZSBidWZmZXIncyBiYXNlIElTIHRoYXQgdmlldywgc28gdGhlIHR3b1xuICAgKiAgICAgICB0aWVycyBhZ3JlZSBvbiBjb250ZW50KTtcbiAgICogICAgMi4gTElWRSBzdGF0ZSB2aWEgYHNoYXJlZE1lbW9yeS5nZXRWYWx1ZWAgZm9yIGtleXMgYWJzZW50IGZyb20gdGhlXG4gICAqICAgICAgIHNuYXBzaG90IOKAlCBpbmNsdWRpbmcgaXRzIHJ1buKGkmdsb2JhbCBuYW1lc3BhY2UgZmFsbGJhY2suIFRoZSBlYWdlclxuICAgKiAgICAgICBlbmdpbmUgaGFkIHRoaXMgZXhhY3QgbGl2ZSBmYWxsYmFjayBmb3Igc25hcHNob3QtbWlzc2luZyBrZXlzO1xuICAgKiAgICAgICBieXRlLWlkZW50aXR5IG92ZXIgcHVyaXR5LlxuICAgKlxuICAgKiAgUmVhZHMgbmV2ZXIgY29uc3RydWN0IHRoZSBidWZmZXIgKCMxMyk6IGEgc3RhZ2UgdGhhdCBuZXZlciB3cml0ZXNcbiAgICogIHBlcmZvcm1zIHplcm8gY2xvbmVzIG9mIHRoZSBzaGFyZWQgc3RhdGUuICovXG4gIHByaXZhdGUgcmVhZFN0YXRlKHBhdGg6IHN0cmluZ1tdLCBrZXk/OiBzdHJpbmcpOiB1bmtub3duIHtcbiAgICBjb25zdCBuYW1lc3BhY2VkID0gdGhpcy53aXRoTmFtZXNwYWNlKHBhdGgsIGtleSBhcyBzdHJpbmcpO1xuICAgIGNvbnN0IGZyb21TbmFwc2hvdCA9IHRoaXMuYnVmZmVyID8gdGhpcy5idWZmZXIuZ2V0KG5hbWVzcGFjZWQpIDogbmF0aXZlR2V0KHRoaXMuZmlyc3RUb3VjaFN0YXRlKCksIG5hbWVzcGFjZWQpO1xuICAgIGlmICh0eXBlb2YgZnJvbVNuYXBzaG90ICE9PSAndW5kZWZpbmVkJykgcmV0dXJuIGZyb21TbmFwc2hvdDtcbiAgICByZXR1cm4gdGhpcy5zaGFyZWRNZW1vcnkuZ2V0VmFsdWUodGhpcy5ydW5JZCwgcGF0aCwga2V5KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUcmFja2VkIHJlYWQuIFRoZSByZXR1cm5lZCB2YWx1ZSBpcyBCT1JST1dFRCDigJQgc2VlIHRoZSBjb250cmFjdCBvblxuICAgKiBgU2NvcGVGYWNhZGUuZ2V0VmFsdWVgLiBSZWFkLXRyYWNraW5nIGNvc3QgaXMgcG9saWN5LWdhdGVkICgjMTQpOlxuICAgKiBgJ2Z1bGwnYCBjbG9uZXMgdGhlIHZhbHVlIGludG8gYF9zdGFnZVJlYWRzYCAoaGlzdG9yaWNhbCBkZWZhdWx0KSxcbiAgICogYCdzdW1tYXJ5J2AgcmVjb3JkcyBhIGNoZWFwIG1hcmtlciwgYCdvZmYnYCByZWNvcmRzIG5vdGhpbmcuXG4gICAqL1xuICBnZXRWYWx1ZShwYXRoOiBzdHJpbmdbXSwga2V5Pzogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZykge1xuICAgIGNvbnN0IHZhbHVlID0gdGhpcy5yZWFkU3RhdGUocGF0aCwga2V5KTtcbiAgICAvLyBQZXItd3JpdGUgcHJvdmVuYW5jZSByZWdpc3RyeSAoI1AxKSDigJQga2V5IHN0cmluZ3Mgb25seSwgaW5kZXBlbmRlbnQgb2ZcbiAgICAvLyB0aGUgcmVhZFRyYWNraW5nIHJldGVudGlvbiBkaWFsICh3aGljaCBnb3Zlcm5zIFZBTFVFIHJldGVudGlvbiBiZWxvdykuXG4gICAgaWYgKGtleSAhPT0gdW5kZWZpbmVkICYmIHRoaXMud3JpdGVQcm92ZW5hbmNlID09PSAncmVhZHMtcHJlZml4Jykge1xuICAgICAgKHRoaXMuX3Byb3ZlbmFuY2VSZWFkcyA/Pz0gbmV3IFNldCgpKS5hZGQocGF0aC5sZW5ndGggPiAwID8gWy4uLnBhdGgsIGtleV0uam9pbignLicpIDoga2V5KTtcbiAgICB9XG4gICAgLy8gVHJhY2sgdXNlci1sZXZlbCByZWFkIChwcmUtbmFtZXNwYWNlKSBmb3IgbWVtb3J5IHZpZXdcbiAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgdGhpcy5yZWFkVHJhY2tpbmcgIT09ICdvZmYnKSB7XG4gICAgICBjb25zdCB1c2VyS2V5ID0gcGF0aC5sZW5ndGggPiAwID8gWy4uLnBhdGgsIGtleV0uam9pbignLicpIDoga2V5O1xuICAgICAgdGhpcy5fc3RhZ2VSZWFkc1t1c2VyS2V5XSA9XG4gICAgICAgIHZhbHVlID09PSB1bmRlZmluZWRcbiAgICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICAgIDogdGhpcy5yZWFkVHJhY2tpbmcgPT09ICdzdW1tYXJ5J1xuICAgICAgICAgID8gc3VtbWFyaXplUmVhZFZhbHVlKHZhbHVlKVxuICAgICAgICAgIDogc3RydWN0dXJlZENsb25lKHZhbHVlKTtcbiAgICB9XG4gICAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgICB0aGlzLmRlYnVnLmFkZExvZygnbWVzc2FnZScsIGBbUkVBRF0gJHtkZXNjcmlwdGlvbn1gKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG5cbiAgLyoqIFJlYWQgc3RhdGUgd2l0aG91dCB0cmFja2luZyBpbiBfc3RhZ2VSZWFkcyBvciBwYXlpbmcgc3RydWN0dXJlZENsb25lIGNvc3QuXG4gICAqICBVc2VkIGJ5IFNjb3BlRmFjYWRlLmdldFZhbHVlU2lsZW50KCkgZm9yIGFycmF5IHByb3h5IGludGVybmFsIG9wZXJhdGlvbnMuICovXG4gIGdldFZhbHVlRGlyZWN0KHBhdGg6IHN0cmluZ1tdLCBrZXk/OiBzdHJpbmcpOiB1bmtub3duIHtcbiAgICByZXR1cm4gdGhpcy5yZWFkU3RhdGUocGF0aCwga2V5KTtcbiAgfVxuXG4gIGdldFJvb3Qoa2V5OiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5zaGFyZWRNZW1vcnkuZ2V0VmFsdWUodGhpcy5ydW5JZCwgW10sIGtleSk7XG4gIH1cblxuICBnZXRHbG9iYWwoa2V5OiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5zaGFyZWRNZW1vcnkuZ2V0VmFsdWUoJycsIFtdLCBrZXkpO1xuICB9XG5cbiAgZ2V0U2NvcGUoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB0aGlzLnNoYXJlZE1lbW9yeS5nZXRTdGF0ZSgpO1xuICB9XG5cbiAgZ2V0UnVuSWQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5ydW5JZDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBDb21taXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFJGQy0wMDMgRDI6IHJlY29yZCB0aGF0IHRoaXMgc3RhZ2UgY29uc3VtZWQgYW4gdW50cmFja2VkIHJlYWQgcGF0aC5cbiAgICogQ2FsbGVkIGJ5IGBTY29wZUZhY2FkZWAgKGBnZXRBcmdzYC9gZ2V0RW52YC91bnNoYWRvd2VkIGBnZXRWYWx1ZVNpbGVudGApO1xuICAgKiBzdXJmYWNlZCBhcyBgQ29tbWl0QnVuZGxlLnVudHJhY2tlZFNvdXJjZXNgIG9uIHRoaXMgc3RhZ2UncyBjb21taXQuXG4gICAqL1xuICBtYXJrVW50cmFja2VkU291cmNlKHNvdXJjZTogVW50cmFja2VkU291cmNlKTogdm9pZCB7XG4gICAgKHRoaXMuX3VudHJhY2tlZFNvdXJjZXMgPz89IG5ldyBTZXQoKSkuYWRkKHNvdXJjZSk7XG4gIH1cblxuICAvKipcbiAgICogUkZDLTAwMyBEMjogdGhlIGB1bnRyYWNrZWRTb3VyY2VzYCBidW5kbGUgZnJhZ21lbnQgZm9yIGNvbW1pdCgpIOKAlCBge31gXG4gICAqIHdoZW4gbm90aGluZyB3YXMgbWFya2VkLCBzbyB0aGUgc3ByZWFkIGtlZXBzIHRoZSBmaWVsZCBBQlNFTlQgKG5vdFxuICAgKiBlbXB0eS1hcnJheS12YWx1ZWQpIGFuZCB1bnRvdWNoZWQgY2hhcnRzIHN0YXkgYnl0ZS1pZGVudGljYWwuXG4gICAqL1xuICBwcml2YXRlIHVudHJhY2tlZFNvdXJjZXNGcmFnbWVudCgpOiB7IHVudHJhY2tlZFNvdXJjZXM/OiBVbnRyYWNrZWRTb3VyY2VbXSB9IHtcbiAgICBpZiAoIXRoaXMuX3VudHJhY2tlZFNvdXJjZXMgfHwgdGhpcy5fdW50cmFja2VkU291cmNlcy5zaXplID09PSAwKSByZXR1cm4ge307XG4gICAgcmV0dXJuIHsgdW50cmFja2VkU291cmNlczogWy4uLnRoaXMuX3VudHJhY2tlZFNvdXJjZXNdIH07XG4gIH1cblxuICAvKiogUmVnaXN0ZXIgYW4gb2JzZXJ2ZXIgdGhhdCBmaXJlcyBhZnRlciBjb21taXQoKSBhcHBsaWVzIHBhdGNoZXMuXG4gICAqICBVc2VkIGJ5IFNjb3BlRmFjYWRlIHRvIGRpc3BhdGNoIFNjb3BlUmVjb3JkZXIub25Db21taXQgZXZlbnRzLiAqL1xuICBzZXRDb21taXRPYnNlcnZlcihcbiAgICBvYnNlcnZlcjogKG11dGF0aW9uczogUmVjb3JkPHN0cmluZywgeyB2YWx1ZTogdW5rbm93bjsgb3BlcmF0aW9uOiAnc2V0JyB8ICd1cGRhdGUnIHwgJ2RlbGV0ZScgfT4pID0+IHZvaWQsXG4gICk6IHZvaWQge1xuICAgIHRoaXMuX2NvbW1pdE9ic2VydmVyID0gb2JzZXJ2ZXI7XG4gIH1cblxuICAvKipcbiAgICogRmx1c2ggc3RhZ2VkIHdyaXRlcyB0byBzaGFyZWQgbWVtb3J5IGFuZCBSRUxFQVNFIHRoZSBwZXItc3RhZ2Ugc3RhZ2luZ1xuICAgKiBzdGF0ZSAoIzEzYikuXG4gICAqXG4gICAqIENvbW1pdCBpcyB0aGUgc3RhZ2UncyBsaWZlY3ljbGUgZW5kOiBgYnVmZmVyYCAoMiBmdWxsLXN0YXRlIGNsb25lcykgYW5kXG4gICAqIGBzdGF0ZVZpZXdgIChhIHJlZmVyZW5jZSB0aGF0IHBpbnMgb25lIGZ1bGwgY29tbWl0dGVkLXN0YXRlIEdFTkVSQVRJT04g4oCUXG4gICAqIGBhcHBseVNtYXJ0TWVyZ2VgIGNsb25lcyArIHN3YXBzIHRoZSB3aG9sZSBzdGF0ZSBwZXIgY29tbWl0LCBzbyBldmVyeVxuICAgKiBzdGFnZSdzIHZpZXcgaXMgYSBkaXN0aW5jdCBvYmplY3QpIGFyZSBvbmx5IG5lZWRlZCBEVVJJTkcgZXhlY3V0aW9uLCBhc1xuICAgKiB0aGUgcmVhZCBzbmFwc2hvdCArIG5ldC1jaGFuZ2UgZGlmZiBiYXNlLiBUaGUgZXhlY3V0aW9uIHRyZWUgcmV0YWluc1xuICAgKiBldmVyeSBTdGFnZUNvbnRleHQgZm9yIHRoZSBsaWZldGltZSBvZiB0aGUgcnVuLCBzbyBXSVRIT1VUIHRoZSByZWxlYXNlXG4gICAqIGEgbG9uZyBsb29wIHJldGFpbnMgb25lIHN0YXRlIGdlbmVyYXRpb24gKyB0d28gY2xvbmVzIHBlciBleGVjdXRlZFxuICAgKiBzdGFnZSDigJQgbWVhc3VyZWQgTyhOwrIpOiA1NjMuOE1CIGF0IE49MjAwIG9uIGFuIGFnZW50LXN0eWxlIGNoYXJ0OyBhXG4gICAqIDUwMC1pdGVyYXRpb24gYWdlbnQgT09NZWQgYSBkZWZhdWx0IE5vZGUgaGVhcCAoYmFja2xvZyAjMTgpLlxuICAgKlxuICAgKiBSRS1VU0UgQUZURVIgQ09NTUlUIHN0YXlzIGNvcnJlY3QgYmVjYXVzZSBib3RoIGZpZWxkcyByZS1jcmVhdGUgbGF6aWx5OlxuICAgKiAtIGEgbGF0ZXIgUkVBRCByZS1hbmNob3JzIHZpYSB7QGxpbmsgZmlyc3RUb3VjaFN0YXRlfSBvbiB0aGUgQ1VSUkVOVFxuICAgKiAgIGNvbW1pdHRlZCBzdGF0ZSAod2hpY2ggaW5jbHVkZXMgdGhpcyBzdGFnZSdzIG93biBmbHVzaGVkIHdyaXRlcyk7XG4gICAqIC0gYSBsYXRlciBXUklURSBjb25zdHJ1Y3RzIGEgZnJlc2ggYnVmZmVyIG9uIHRoYXQgcmUtYW5jaG9yZWQgdmlldywgc28gYVxuICAgKiAgIHNlY29uZCBjb21taXQgZGlmZnMgYWdhaW5zdCBwb3N0LWZpcnN0LWNvbW1pdCBzdGF0ZS4gVGhlIHByZS1yZWxlYXNlXG4gICAqICAgYnVmZmVyIGJlaGF2ZWQgdGhlIHNhbWUgZm9yIFZBTFVFUyAoaXRzIGB3b3JraW5nQ29weWAgd2FzIHJlc2V0IG9uXG4gICAqICAgY29tbWl0LCBmYWxsaW5nIHJlYWRzIHRocm91Z2ggdG8gbGl2ZSBzdGF0ZSkgYnV0IGtlcHQgdGhlIE9SSUdJTkFMXG4gICAqICAgYGJhc2VTbmFwc2hvdGAgYXMgZGlmZiBiYXNlIOKAlCB1bnJlYWNoYWJsZSBpbiBwcmFjdGljZTogZXZlcnkgZW5naW5lXG4gICAqICAgcmUtY29tbWl0IHBhdGggKGZvcmsgZG91YmxlLWNvbW1pdCwgc3ViZmxvdyBvdXRwdXRNYXBwZXIgZG91YmxlLWNvbW1pdClcbiAgICogICBzdGFnZXMgbm90aGluZyBpbiBiZXR3ZWVuLCBhbmQgdGhlIHR3byByZWFsIFwid3JpdGUgYWZ0ZXIgY29tbWl0XCIgc2l0ZXNcbiAgICogICAoU3ViZmxvd0V4ZWN1dG9yIHNlZWQg4oaSIHJlcGxhY2VzIHRoZSBjb250ZXh0OyByZXN1bWUg4oaSIGZyZXNoIGNvbnRleHRcbiAgICogICB2aWEgYGxlYWYuY3JlYXRlTmV4dGApIG5ldmVyIHJlLXVzZSBhIGNvbW1pdHRlZCBjb250ZXh0J3MgYnVmZmVyLlxuICAgKiAtIGBfc3RhZ2VXcml0ZXNgIC8gYF9zdGFnZVJlYWRzYCBhcmUgTk9UIHJlbGVhc2VkIOKAlCBgc25hcHNob3RTZWxmKClgXG4gICAqICAgcmVhZHMgdGhlbSBwb3N0LXJ1biBmb3IgdGhlIGV4ZWN1dGlvbi10cmVlIHNuYXBzaG90LlxuICAgKi9cbiAgY29tbWl0KCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5idWZmZXIpIHtcbiAgICAgIC8vIFRydWx5LWxhenkgZmFzdCBwYXRoICgjMTMpOiBubyB3cml0ZSBldmVyIGNvbnN0cnVjdGVkIHRoZSBidWZmZXIsIHNvXG4gICAgICAvLyB0aGUgc3RhZ2UncyBuZXQgY2hhbmdlIGlzIGVtcHR5IEJZIENPTlNUUlVDVElPTi4gU2FtZSBvYnNlcnZhYmxlXG4gICAgICAvLyBvdXRjb21lIGFzIGFuIGVtcHR5IGNvbW1pdCDigJQgdGhlIChlbXB0eSkgYnVuZGxlIGlzIHN0aWxsIHJlY29yZGVkIHNvXG4gICAgICAvLyBldmVyeSBleGVjdXRlZCBzdGFnZSByZW1haW5zIGEgdGltZS10cmF2ZWwgY3Vyc29yIHN0b3Ag4oCUIGJ1dCB3aXRoXG4gICAgICAvLyBaRVJPIGNsb25lczogbm8gYnVmZmVyIGNvbnN0cnVjdGlvbiwgbm8gYXBwbHlQYXRjaCByZXBsYXkuXG4gICAgICB0aGlzLmV2ZW50TG9nPy5yZWNvcmQoe1xuICAgICAgICBvdmVyd3JpdGU6IHt9LFxuICAgICAgICB1cGRhdGVzOiB7fSxcbiAgICAgICAgcmVkYWN0ZWRQYXRoczogW10sXG4gICAgICAgIHRyYWNlOiBbXSxcbiAgICAgICAgc3RhZ2U6IHRoaXMuc3RhZ2VOYW1lLFxuICAgICAgICBzdGFnZUlkOiB0aGlzLnN0YWdlSWQsXG4gICAgICAgIHJ1bnRpbWVTdGFnZUlkOiB0aGlzLnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgICAuLi50aGlzLnVudHJhY2tlZFNvdXJjZXNGcmFnbWVudCgpLFxuICAgICAgfSk7XG4gICAgICBpZiAodGhpcy5fY29tbWl0T2JzZXJ2ZXIpIHtcbiAgICAgICAgdGhpcy5fY29tbWl0T2JzZXJ2ZXIoeyAuLi50aGlzLl9zdGFnZVdyaXRlcyB9KTtcbiAgICAgIH1cbiAgICAgIC8vICMxM2I6IGRyb3AgdGhlIGZpcnN0LXRvdWNoIHZpZXcg4oCUIGEgcmVhZC1vbmx5IHN0YWdlIHN0aWxsIHBpbm5lZCBvbmVcbiAgICAgIC8vIGZ1bGwgc3RhdGUgZ2VuZXJhdGlvbiB0aHJvdWdoIGl0LiBEMiBtYXJrZXJzIHJlbGVhc2Ugd2l0aCBpdC5cbiAgICAgIHRoaXMuc3RhdGVWaWV3ID0gdW5kZWZpbmVkO1xuICAgICAgdGhpcy5fdW50cmFja2VkU291cmNlcyA9IHVuZGVmaW5lZDtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBidW5kbGUgPSB0aGlzLmJ1ZmZlci5jb21taXQoKTtcbiAgICBjb25zdCBjb21taXRCdW5kbGUgPSB7XG4gICAgICAuLi5idW5kbGUsXG4gICAgICBzdGFnZTogdGhpcy5zdGFnZU5hbWUsXG4gICAgICBzdGFnZUlkOiB0aGlzLnN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogdGhpcy5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIC4uLnRoaXMudW50cmFja2VkU291cmNlc0ZyYWdtZW50KCksXG4gICAgfTtcblxuICAgIHRoaXMuc2hhcmVkTWVtb3J5LmFwcGx5UGF0Y2goY29tbWl0QnVuZGxlLm92ZXJ3cml0ZSwgY29tbWl0QnVuZGxlLnVwZGF0ZXMsIGNvbW1pdEJ1bmRsZS50cmFjZSk7XG5cbiAgICAvLyBBbHJlYWR5LWNvbXB1dGVkIHJlZGFjdGVkIHBhdGNoZXMgZmVlZCB0aHJlZSBjb25zdW1lcnM6XG4gICAgLy8gICAxLiB0aGUgcGFyYWxsZWwgcmVkYWN0ZWQgbWlycm9yIChpZiBlbmFibGVkKVxuICAgIC8vICAgMi4gdGhlIGV2ZW50IGxvZyAocGVyc2lzdGVkIHRyYWNlKVxuICAgIC8vICAgMy4gKGZ1dHVyZSkgYW55dGhpbmcgZWxzZSB0aGF0IHdhbnRzIGEgc2NydWJiZWQgdmlldyBhdCBjb21taXQgdGltZVxuICAgIC8vIENvbXB1dGluZyBvbmNlIGtlZXBzIGNvc3QgbGluZWFyIGluIHRoZSBjb21taXQgc2l6ZTsgbm8gcG9zdC1wYXNzIHdhbGsuXG4gICAgY29uc3QgcmVkYWN0ZWRPdmVyd3JpdGUgPSByZWRhY3RQYXRjaChjb21taXRCdW5kbGUub3ZlcndyaXRlLCBjb21taXRCdW5kbGUucmVkYWN0ZWRQYXRocyk7XG4gICAgY29uc3QgcmVkYWN0ZWRVcGRhdGVzID0gcmVkYWN0UGF0Y2goY29tbWl0QnVuZGxlLnVwZGF0ZXMsIGNvbW1pdEJ1bmRsZS5yZWRhY3RlZFBhdGhzKTtcblxuICAgIHRoaXMucmVkYWN0ZWRTaGFyZWRNZW1vcnk/LmFwcGx5UGF0Y2gocmVkYWN0ZWRPdmVyd3JpdGUsIHJlZGFjdGVkVXBkYXRlcywgY29tbWl0QnVuZGxlLnRyYWNlKTtcblxuICAgIHRoaXMuZXZlbnRMb2c/LnJlY29yZCh7XG4gICAgICAuLi5jb21taXRCdW5kbGUsXG4gICAgICByZWRhY3RlZFBhdGhzOiBBcnJheS5mcm9tKGNvbW1pdEJ1bmRsZS5yZWRhY3RlZFBhdGhzLnZhbHVlcygpKSxcbiAgICAgIG92ZXJ3cml0ZTogcmVkYWN0ZWRPdmVyd3JpdGUsXG4gICAgICB1cGRhdGVzOiByZWRhY3RlZFVwZGF0ZXMsXG4gICAgfSk7XG5cbiAgICAvLyBOb3RpZnkgb2JzZXJ2ZXIgKFNjb3BlRmFjYWRlKSB3aXRoIHRyYWNrZWQgbXV0YXRpb25zXG4gICAgaWYgKHRoaXMuX2NvbW1pdE9ic2VydmVyKSB7XG4gICAgICB0aGlzLl9jb21taXRPYnNlcnZlcih7IC4uLnRoaXMuX3N0YWdlV3JpdGVzIH0pO1xuICAgIH1cblxuICAgIC8vICMxM2I6IHJlbGVhc2UgdGhlIHN0YWdpbmcgc3RhdGUg4oCUIHNlZSB0aGUgbWV0aG9kIEpTRG9jLiBEb25lIExBU1Qgc29cbiAgICAvLyB0aGUgY29tbWl0IG9ic2VydmVyIHNlZXMgdGhlIGV4YWN0IHNhbWUgd29ybGQgYXMgYmVmb3JlIHRoZSByZWxlYXNlLlxuICAgIC8vIEQyJ3MgdW50cmFja2VkLXNvdXJjZSBtYXJrZXJzIHJlbGVhc2Ugd2l0aCBpdDogdGhlIHJvdXRpbmVcbiAgICAvLyBkb3VibGUtY29tbWl0IHBhdGhzIHRoZW4gcmVjb3JkIHRoZSBmaWVsZCBleGFjdGx5IG9uY2UuXG4gICAgdGhpcy5idWZmZXIgPSB1bmRlZmluZWQ7XG4gICAgdGhpcy5zdGF0ZVZpZXcgPSB1bmRlZmluZWQ7XG4gICAgdGhpcy5fdW50cmFja2VkU291cmNlcyA9IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBUcmVlIG5hdmlnYXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIENyZWF0ZSAob3IgcmV0dXJuKSB0aGlzIGNvbnRleHQncyBsaW5rZWQgc3VjY2Vzc29yLlxuICAgKlxuICAgKiBNRU1PSVpFRDogdGhlIGZpcnN0IGNhbGwgY3JlYXRlcyBgdGhpcy5uZXh0YDsgZXZlcnkgbGF0ZXIgY2FsbCByZXR1cm5zXG4gICAqIHRoYXQgU0FNRSBjb250ZXh0IGFuZCBJR05PUkVTIGl0cyBhcmd1bWVudHMuIEluIG5vcm1hbCB0cmF2ZXJzYWwgZWFjaFxuICAgKiBjb250ZXh0IGFkdmFuY2VzIGV4YWN0bHkgb25jZSwgc28gdGhlIG1lbW8gbmV2ZXIgYml0ZXMg4oCUIGJ1dCBhIGNhbGxlclxuICAgKiBleHBlY3RpbmcgYSBmcmVzaCBjb250ZXh0IGZvciBkaWZmZXJlbnQgYHN0YWdlTmFtZWAvYHN0YWdlSWRgIGFyZ3MgZ2V0c1xuICAgKiB0aGUgb2xkIG9uZSBzaWxlbnRseS4gRGV2IG1vZGUgKGBlbmFibGVEZXZNb2RlKClgKSB3YXJucyBvbiB0aGF0XG4gICAqIG1pc21hdGNoIChiYWNrbG9nIEI0KS5cbiAgICovXG4gIGNyZWF0ZU5leHQocGF0aDogc3RyaW5nLCBzdGFnZU5hbWU6IHN0cmluZywgc3RhZ2VJZDogc3RyaW5nLCBpc0RlY2lkZXIgPSBmYWxzZSk6IFN0YWdlQ29udGV4dCB7XG4gICAgaWYgKCF0aGlzLm5leHQpIHtcbiAgICAgIHRoaXMubmV4dCA9IG5ldyBTdGFnZUNvbnRleHQocGF0aCwgc3RhZ2VOYW1lLCBzdGFnZUlkLCB0aGlzLnNoYXJlZE1lbW9yeSwgJycsIHRoaXMuZXZlbnRMb2csIGlzRGVjaWRlcik7XG4gICAgICB0aGlzLm5leHQucGFyZW50ID0gdGhpcztcbiAgICAgIC8vIFByb3BhZ2F0ZSB0aGUgcmVkYWN0ZWQgbWlycm9yIGRvd24gdGhlIGNvbnRleHQgdHJlZSBzbyBldmVyeSBjb21taXRcbiAgICAgIC8vIGluIHRoZSBydW4gd3JpdGVzIHRvIGJvdGggdmlld3MuXG4gICAgICBpZiAodGhpcy5yZWRhY3RlZFNoYXJlZE1lbW9yeSkgdGhpcy5uZXh0LnJlZGFjdGVkU2hhcmVkTWVtb3J5ID0gdGhpcy5yZWRhY3RlZFNoYXJlZE1lbW9yeTtcbiAgICAgIHRoaXMubmV4dC5yZWFkVHJhY2tpbmcgPSB0aGlzLnJlYWRUcmFja2luZztcbiAgICAgIHRoaXMubmV4dC53cml0ZVRyYWNraW5nID0gdGhpcy53cml0ZVRyYWNraW5nO1xuICAgICAgdGhpcy5uZXh0LmNvbW1pdFZhbHVlcyA9IHRoaXMuY29tbWl0VmFsdWVzO1xuICAgICAgdGhpcy5uZXh0LndyaXRlUHJvdmVuYW5jZSA9IHRoaXMud3JpdGVQcm92ZW5hbmNlO1xuICAgIH0gZWxzZSBpZiAoaXNEZXZNb2RlKCkgJiYgKHRoaXMubmV4dC5zdGFnZUlkICE9PSBzdGFnZUlkIHx8IHRoaXMubmV4dC5zdGFnZU5hbWUgIT09IHN0YWdlTmFtZSkpIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgIGBbZm9vdHByaW50XSBTdGFnZUNvbnRleHQuY3JlYXRlTmV4dDogbmV4dCBjb250ZXh0IGFscmVhZHkgZXhpc3RzIGFzIFwiJHt0aGlzLm5leHQuc3RhZ2VOYW1lfVwiIGAgK1xuICAgICAgICAgIGAoaWQ6IFwiJHt0aGlzLm5leHQuc3RhZ2VJZH1cIikg4oCUIGFyZ3VtZW50cyBcIiR7c3RhZ2VOYW1lfVwiIChpZDogXCIke3N0YWdlSWR9XCIpIGFyZSBpZ25vcmVkIGAgK1xuICAgICAgICAgICdhbmQgdGhlIGV4aXN0aW5nIGNvbnRleHQgaXMgcmV0dXJuZWQuJyxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLm5leHQ7XG4gIH1cblxuICBjcmVhdGVDaGlsZChydW5JZDogc3RyaW5nLCBicmFuY2hJZDogc3RyaW5nLCBzdGFnZU5hbWU6IHN0cmluZywgc3RhZ2VJZDogc3RyaW5nLCBpc0RlY2lkZXIgPSBmYWxzZSk6IFN0YWdlQ29udGV4dCB7XG4gICAgaWYgKCF0aGlzLmNoaWxkcmVuKSB7XG4gICAgICB0aGlzLmNoaWxkcmVuID0gW107XG4gICAgfVxuICAgIGNvbnN0IGNoaWxkID0gbmV3IFN0YWdlQ29udGV4dChydW5JZCwgc3RhZ2VOYW1lLCBzdGFnZUlkLCB0aGlzLnNoYXJlZE1lbW9yeSwgYnJhbmNoSWQsIHRoaXMuZXZlbnRMb2csIGlzRGVjaWRlcik7XG4gICAgY2hpbGQucGFyZW50ID0gdGhpcztcbiAgICBpZiAodGhpcy5yZWRhY3RlZFNoYXJlZE1lbW9yeSkgY2hpbGQucmVkYWN0ZWRTaGFyZWRNZW1vcnkgPSB0aGlzLnJlZGFjdGVkU2hhcmVkTWVtb3J5O1xuICAgIGNoaWxkLnJlYWRUcmFja2luZyA9IHRoaXMucmVhZFRyYWNraW5nO1xuICAgIGNoaWxkLndyaXRlVHJhY2tpbmcgPSB0aGlzLndyaXRlVHJhY2tpbmc7XG4gICAgY2hpbGQuY29tbWl0VmFsdWVzID0gdGhpcy5jb21taXRWYWx1ZXM7XG4gICAgY2hpbGQud3JpdGVQcm92ZW5hbmNlID0gdGhpcy53cml0ZVByb3ZlbmFuY2U7XG4gICAgdGhpcy5jaGlsZHJlbi5wdXNoKGNoaWxkKTtcbiAgICByZXR1cm4gY2hpbGQ7XG4gIH1cblxuICBjcmVhdGVEZWNpZGVyKHBhdGg6IHN0cmluZywgc3RhZ2VOYW1lOiBzdHJpbmcsIHN0YWdlSWQ6IHN0cmluZyk6IFN0YWdlQ29udGV4dCB7XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlTmV4dChwYXRoLCBzdGFnZU5hbWUsIHN0YWdlSWQsIHRydWUpO1xuICB9XG5cbiAgc2V0QXNEZWNpZGVyKCk6IFN0YWdlQ29udGV4dCB7XG4gICAgdGhpcy5pc0RlY2lkZXIgPSB0cnVlO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgc2V0QXNGb3JrKCk6IFN0YWdlQ29udGV4dCB7XG4gICAgdGhpcy5pc0ZvcmsgPSB0cnVlO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8g4pSA4pSAIERpYWdub3N0aWNzIGRlbGVnYXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkTG9nKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgcGF0aD86IHN0cmluZ1tdKSB7XG4gICAgdGhpcy5kZWJ1Zy5hZGRMb2coa2V5LCB2YWx1ZSwgcGF0aCk7XG4gIH1cblxuICBzZXRMb2coa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBwYXRoPzogc3RyaW5nW10pIHtcbiAgICB0aGlzLmRlYnVnLnNldExvZyhrZXksIHZhbHVlLCBwYXRoKTtcbiAgfVxuXG4gIGFkZE1ldHJpYyhrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIHBhdGg/OiBzdHJpbmdbXSkge1xuICAgIHRoaXMuZGVidWcuYWRkTWV0cmljKGtleSwgdmFsdWUsIHBhdGgpO1xuICB9XG5cbiAgc2V0TWV0cmljKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgcGF0aD86IHN0cmluZ1tdKSB7XG4gICAgdGhpcy5kZWJ1Zy5zZXRNZXRyaWMoa2V5LCB2YWx1ZSwgcGF0aCk7XG4gIH1cblxuICBhZGRFdmFsKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgcGF0aD86IHN0cmluZ1tdKSB7XG4gICAgdGhpcy5kZWJ1Zy5hZGRFdmFsKGtleSwgdmFsdWUsIHBhdGgpO1xuICB9XG5cbiAgc2V0RXZhbChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIHBhdGg/OiBzdHJpbmdbXSkge1xuICAgIHRoaXMuZGVidWcuc2V0RXZhbChrZXksIHZhbHVlLCBwYXRoKTtcbiAgfVxuXG4gIGFkZEVycm9yKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgcGF0aD86IHN0cmluZ1tdKSB7XG4gICAgdGhpcy5kZWJ1Zy5hZGRFcnJvcihrZXksIHZhbHVlLCBwYXRoKTtcbiAgfVxuXG4gIGFkZEZsb3dEZWJ1Z01lc3NhZ2UoXG4gICAgdHlwZTogRmxvd0NvbnRyb2xUeXBlLFxuICAgIGRlc2NyaXB0aW9uOiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IHsgdGFyZ2V0U3RhZ2U/OiBzdHJpbmcgfCBzdHJpbmdbXTsgcmF0aW9uYWxlPzogc3RyaW5nOyBjb3VudD86IG51bWJlcjsgaXRlcmF0aW9uPzogbnVtYmVyIH0sXG4gICkge1xuICAgIGNvbnN0IGZsb3dNZXNzYWdlOiBGbG93TWVzc2FnZSA9IHsgdHlwZSwgZGVzY3JpcHRpb24sIHRpbWVzdGFtcDogRGF0ZS5ub3coKSwgLi4ub3B0aW9ucyB9O1xuICAgIHRoaXMuZGVidWcuYWRkRmxvd01lc3NhZ2UoZmxvd01lc3NhZ2UpO1xuICB9XG5cbiAgLy8g4pSA4pSAIFNuYXBzaG90IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGdldFN0YWdlSWQoKTogc3RyaW5nIHtcbiAgICBpZiAoIXRoaXMucnVuSWQgfHwgdGhpcy5ydW5JZCA9PT0gJycpIHJldHVybiB0aGlzLnN0YWdlTmFtZTtcbiAgICByZXR1cm4gYCR7dGhpcy5ydW5JZH0uJHt0aGlzLnN0YWdlTmFtZX1gO1xuICB9XG5cbiAgZ2V0U25hcHNob3QoKTogU3RhZ2VTbmFwc2hvdCB7XG4gICAgLy8gSXRlcmF0aXZlIHdhbGsgKGV4cGxpY2l0IHdvcmsgc3RhY2spLCBOT1QgcmVjdXJzaW9uOiB0aGUgZXhlY3V0aW9uXG4gICAgLy8gdHJlZSBkZWVwZW5zIGJ5IG9uZSBsZXZlbCBwZXIgZXhlY3V0ZWQgc3RhZ2UgYWxvbmcgYG5leHRgIGNoYWlucywgYW5kXG4gICAgLy8gdGhlIHRyYW1wb2xpbmVkIHRyYXZlcnNlciBhbGxvd3MgY2hhaW5zL2xvb3BzIG9mIHRlbnMgb2YgdGhvdXNhbmRzIG9mXG4gICAgLy8gc3RhZ2VzIOKAlCBmYXIgZGVlcGVyIHRoYW4gYSByZWN1cnNpdmUgc2VyaWFsaXplciBjYW4gd2FsayBiZWZvcmVcbiAgICAvLyBcIk1heGltdW0gY2FsbCBzdGFjayBzaXplIGV4Y2VlZGVkXCIuXG4gICAgY29uc3Qgcm9vdCA9IHRoaXMuc25hcHNob3RTZWxmKCk7XG4gICAgY29uc3Qgd29yazogQXJyYXk8eyBjdHg6IFN0YWdlQ29udGV4dDsgc25hcDogU3RhZ2VTbmFwc2hvdCB9PiA9IFt7IGN0eDogdGhpcywgc25hcDogcm9vdCB9XTtcbiAgICB3aGlsZSAod29yay5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCB7IGN0eCwgc25hcCB9ID0gd29yay5wb3AoKSE7XG4gICAgICBpZiAoY3R4Lm5leHQpIHtcbiAgICAgICAgY29uc3QgbmV4dFNuYXAgPSBjdHgubmV4dC5zbmFwc2hvdFNlbGYoKTtcbiAgICAgICAgc25hcC5uZXh0ID0gbmV4dFNuYXA7XG4gICAgICAgIHdvcmsucHVzaCh7IGN0eDogY3R4Lm5leHQsIHNuYXA6IG5leHRTbmFwIH0pO1xuICAgICAgfVxuICAgICAgaWYgKGN0eC5jaGlsZHJlbikge1xuICAgICAgICBzbmFwLmNoaWxkcmVuID0gY3R4LmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHtcbiAgICAgICAgICBjb25zdCBjaGlsZFNuYXAgPSBjaGlsZC5zbmFwc2hvdFNlbGYoKTtcbiAgICAgICAgICB3b3JrLnB1c2goeyBjdHg6IGNoaWxkLCBzbmFwOiBjaGlsZFNuYXAgfSk7XG4gICAgICAgICAgcmV0dXJuIGNoaWxkU25hcDtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiByb290O1xuICB9XG5cbiAgLyoqIFNuYXBzaG90IG9mIFRISVMgY29udGV4dCdzIG93biBmaWVsZHMg4oCUIGBuZXh0YC9gY2hpbGRyZW5gIGFyZSBmaWxsZWRcbiAgICogIGluIGJ5IHRoZSBpdGVyYXRpdmUgd2FsayBpbiBgZ2V0U25hcHNob3RgLiAqL1xuICBwcml2YXRlIHNuYXBzaG90U2VsZigpOiBTdGFnZVNuYXBzaG90IHtcbiAgICBjb25zdCBzbmFwc2hvdDogU3RhZ2VTbmFwc2hvdCA9IHtcbiAgICAgIGlkOiB0aGlzLnN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogdGhpcy5ydW50aW1lU3RhZ2VJZCB8fCB1bmRlZmluZWQsXG4gICAgICBuYW1lOiB0aGlzLnN0YWdlTmFtZSxcbiAgICAgIGlzRGVjaWRlcjogdGhpcy5pc0RlY2lkZXIsXG4gICAgICBpc0Zvcms6IHRoaXMuaXNGb3JrLFxuICAgICAgbG9nczogdGhpcy5kZWJ1Zy5sb2dDb250ZXh0LFxuICAgICAgZXJyb3JzOiB0aGlzLmRlYnVnLmVycm9yQ29udGV4dCxcbiAgICAgIG1ldHJpY3M6IHRoaXMuZGVidWcubWV0cmljQ29udGV4dCxcbiAgICAgIGV2YWxzOiB0aGlzLmRlYnVnLmV2YWxDb250ZXh0LFxuICAgIH07XG4gICAgaWYgKE9iamVjdC5rZXlzKHRoaXMuX3N0YWdlV3JpdGVzKS5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBFeHRyYWN0IHZhbHVlcyBvbmx5IGZvciB0aGUgc25hcHNob3QgKHN0cmlwIG9wZXJhdGlvbiBtZXRhZGF0YSlcbiAgICAgIGNvbnN0IHdyaXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgW2ssIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyh0aGlzLl9zdGFnZVdyaXRlcykpIHtcbiAgICAgICAgd3JpdGVzW2tdID0gZW50cnkudmFsdWU7XG4gICAgICB9XG4gICAgICBzbmFwc2hvdC5zdGFnZVdyaXRlcyA9IHdyaXRlcztcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKHRoaXMuX3N0YWdlUmVhZHMpLmxlbmd0aCA+IDApIHtcbiAgICAgIHNuYXBzaG90LnN0YWdlUmVhZHMgPSB0aGlzLl9zdGFnZVJlYWRzO1xuICAgIH1cbiAgICBpZiAodGhpcy5kZXNjcmlwdGlvbikge1xuICAgICAgc25hcHNob3QuZGVzY3JpcHRpb24gPSB0aGlzLmRlc2NyaXB0aW9uO1xuICAgIH1cbiAgICBpZiAodGhpcy5zdWJmbG93SWQpIHtcbiAgICAgIHNuYXBzaG90LnN1YmZsb3dJZCA9IHRoaXMuc3ViZmxvd0lkO1xuICAgIH1cbiAgICBpZiAodGhpcy5kZWJ1Zy5mbG93TWVzc2FnZXMubGVuZ3RoID4gMCkge1xuICAgICAgc25hcHNob3QuZmxvd01lc3NhZ2VzID0gdGhpcy5kZWJ1Zy5mbG93TWVzc2FnZXM7XG4gICAgfVxuICAgIHJldHVybiBzbmFwc2hvdDtcbiAgfVxufVxuIl19