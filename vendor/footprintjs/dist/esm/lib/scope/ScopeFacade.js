/**
 * ScopeFacade — Base class that library consumers extend to create custom scope classes
 *
 * Wraps StageContext (from memory/) to provide a consumer-friendly API for
 * state access, debug logging, metrics, and recorder hooks.
 *
 * Consumers extend this class to add domain-specific properties:
 *
 * ```typescript
 * class MyScope extends ScopeFacade {
 *   get userName(): string { return this.getValue('name') as string; }
 *   set userName(value: string) { this.setValue('name', value); }
 * }
 * ```
 */
import { detachAndForget as detachAndForgetSpawn, detachAndJoinLater as detachAndJoinLaterSpawn, } from '../detach/spawn.js';
import { nativeHas as lodashHas, nativeSet as lodashSet } from '../memory/pathOps.js';
import { invokeRecorderHook } from '../recorder/invokeHook.js';
import { hasCircularReference, isDevMode } from './detectCircular.js';
import { assertNotReadonly, createFrozenArgs } from './protection/readonlyInput.js';
export class ScopeFacade {
    static BRAND = Symbol.for('ScopeFacade@v1');
    /**
     * Shared sentinel returned by `_getSubflowPath()` for root-level stages
     * (no subflow nesting). Avoids per-call allocation of a fresh
     * `Object.freeze([])` on every `emitEvent` in the common no-subflow case.
     */
    static _EMPTY_SUBFLOW_PATH = Object.freeze([]);
    _stageContext;
    _stageName;
    _readOnlyValues;
    /** Cached deeply-frozen copy of readOnlyValues for getArgs(). Created once. */
    _frozenArgs;
    /** Execution environment — read-only, inherited from parent executor. */
    _executionEnv;
    /** RFC-003 D2: true when `getArgs()` can return actual data — an empty
     *  `{}` read carries no information, so it is never flagged. */
    _hasArgs;
    /** RFC-003 D2: true when `getEnv()` can return actual data. */
    _hasEnv;
    /**
     * RFC-003 D2: keys this stage has TRACKED-read (via `getValue(key)`).
     * A silent read of a key in this set is SHADOWED — its read→write edge is
     * already captured, so it is not flagged as an untracked source. This is
     * what keeps TypedScope array-proxy internals (which always follow a
     * tracked property read) and `$batchArray` honest-but-quiet.
     */
    _trackedReadKeys = new Set();
    _recorders = [];
    _redactedKeys;
    _redactionPolicy;
    _redactedFieldsByKey = new Map();
    constructor(context, stageName, readOnlyValues, executionEnv) {
        this._stageContext = context;
        this._stageName = stageName;
        this._readOnlyValues = readOnlyValues;
        this._frozenArgs = createFrozenArgs(readOnlyValues);
        this._executionEnv = Object.freeze({ ...executionEnv });
        this._hasArgs = Object.keys(this._frozenArgs).length > 0;
        this._hasEnv = Object.keys(this._executionEnv).length > 0;
        this._redactedKeys = new Set();
        // Register as commit observer so ScopeRecorder.onCommit fires when StageContext.commit() is called
        this._stageContext.setCommitObserver((mutations) => {
            this._onCommitFired(mutations);
        });
    }
    /**
     * Share a redacted-keys set across multiple ScopeFacade instances.
     * Call this to make redaction persist across stages in the same pipeline.
     * @internal
     */
    useSharedRedactedKeys(sharedSet) {
        this._redactedKeys = sharedSet;
    }
    /**
     * Returns the current redacted-keys set (for sharing with other scopes).
     * @internal
     */
    getRedactedKeys() {
        return this._redactedKeys;
    }
    /**
     * Apply a declarative redaction policy. The policy is additive —
     * it works alongside manual `setValue(..., true)` calls.
     * @internal
     */
    useRedactionPolicy(policy) {
        this._redactionPolicy = policy;
        // Pre-populate field-level redaction map from policy
        if (policy.fields) {
            for (const [key, fields] of Object.entries(policy.fields)) {
                this._redactedFieldsByKey.set(key, new Set(fields));
            }
        }
    }
    /** @internal */
    getRedactionPolicy() {
        return this._redactionPolicy;
    }
    /**
     * Returns a compliance-friendly report of all redaction activity.
     * Never includes actual values — only key names, field names, and patterns.
     */
    getRedactionReport() {
        const fieldRedactions = {};
        for (const [key, fields] of this._redactedFieldsByKey) {
            fieldRedactions[key] = [...fields];
        }
        return {
            redactedKeys: [...this._redactedKeys],
            fieldRedactions,
            patterns: (this._redactionPolicy?.patterns ?? []).map((p) => p.source),
        };
    }
    // ── ScopeRecorder Management ──────────────────────────────────────────────────
    attachScopeRecorder(recorder) {
        // Replace existing recorder with same ID (idempotent — prevents double-counting)
        this._recorders = this._recorders.filter((r) => r.id !== recorder.id);
        this._recorders.push(recorder);
    }
    detachScopeRecorder(recorderId) {
        this._recorders = this._recorders.filter((r) => r.id !== recorderId);
    }
    getScopeRecorders() {
        return [...this._recorders];
    }
    /** @internal */
    notifyStageStart() {
        this._invokeHook('onStageStart', {
            stageName: this._stageName,
            stageId: this._stageContext.stageId,
            runtimeStageId: this._stageContext.runtimeStageId,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
        });
    }
    /** @internal */
    notifyStageEnd(duration) {
        this._invokeHook('onStageEnd', {
            stageName: this._stageName,
            stageId: this._stageContext.stageId,
            runtimeStageId: this._stageContext.runtimeStageId,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            duration,
        });
    }
    /** @internal */
    notifyPause(pauseData) {
        this._invokeHook('onPause', {
            stageName: this._stageName,
            stageId: this._stageContext.stageId,
            runtimeStageId: this._stageContext.runtimeStageId,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            pauseData,
            channel: 'scope',
        });
    }
    /** @internal */
    notifyResume(hasInput) {
        this._invokeHook('onResume', {
            stageName: this._stageName,
            stageId: this._stageContext.stageId,
            runtimeStageId: this._stageContext.runtimeStageId,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            hasInput,
            channel: 'scope',
        });
    }
    /** @internal */
    notifyCommit(mutations) {
        this._invokeHook('onCommit', {
            stageName: this._stageName,
            stageId: this._stageContext.stageId,
            runtimeStageId: this._stageContext.runtimeStageId,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            mutations,
        });
    }
    /** Called by StageContext.commit() observer. Converts tracked writes to CommitEvent format.
     *  Errors are caught to prevent recorder issues from aborting the traversal. */
    _onCommitFired(mutations) {
        if (this._recorders.length === 0)
            return;
        try {
            const commitMutations = Object.entries(mutations).map(([key, entry]) => {
                const isRedacted = this._isKeyRedacted(key) || this._isPolicyRedacted(key);
                const fieldSet = this._redactedFieldsByKey.get(key);
                let recorderValue;
                if (isRedacted) {
                    recorderValue = '[REDACTED]';
                }
                else if (fieldSet && entry.value && typeof entry.value === 'object') {
                    recorderValue = this._scrubFields(entry.value, fieldSet);
                }
                else {
                    recorderValue = entry.value;
                }
                return {
                    key,
                    value: recorderValue,
                    operation: entry.operation,
                };
            });
            this.notifyCommit(commitMutations);
        }
        catch {
            // Swallow — recorder errors must not abort the traversal.
            // Individual recorder errors are already isolated by _invokeHook.
        }
    }
    // ── Debug / Diagnostics ──────────────────────────────────────────────────
    //
    // These legacy methods still write to the `StageContext` diagnostic
    // side bags (logContext / errorContext / metricContext / evalContext) for
    // snapshot inclusion. They ALSO fire through the Emit channel so any
    // attached `EmitRecorder` sees them in real time — closing the
    // long-standing gap where `$debug`/`$metric` went to unobserved bags.
    addDebugInfo(key, value) {
        this._stageContext.addLog(key, value);
        this.emitEvent(`log.debug.${key}`, { key, value, level: 'debug' });
    }
    addDebugMessage(value) {
        this._stageContext.addLog('messages', [value]);
        this.emitEvent('log.debug.messages', { value, level: 'debug' });
    }
    addErrorInfo(key, value) {
        this._stageContext.addError(key, value);
        this.emitEvent(`log.error.${key}`, { key, value, level: 'error' });
    }
    addMetric(metricName, value) {
        this._stageContext.addMetric(metricName, value);
        this.emitEvent(`metric.${metricName}`, { name: metricName, value });
    }
    addEval(metricName, value) {
        this._stageContext.addEval(metricName, value);
        this.emitEvent(`eval.${metricName}`, { name: metricName, value });
    }
    // ── Emit — Phase 3 primary primitive ─────────────────────────────────────
    /**
     * Fire a structured event to every attached recorder implementing
     * `onEmit`. Synchronous, in-order, pass-through — no buffering.
     *
     * - **Fast-path**: zero allocation + zero cost when no recorders are
     *   attached (early return on empty list).
     * - **Enrichment**: library auto-adds `stageName`, `runtimeStageId`,
     *   `subflowPath`, `pipelineId`, `timestamp` to the event.
     * - **Redaction**: `RedactionPolicy.emitPatterns` regexes are matched
     *   against `name` — matched events have their payload replaced with
     *   `'[REDACTED]'` before dispatch.
     * - **Error isolation**: a throwing `onEmit` does not propagate — it is
     *   caught and routed to `onError` on remaining recorders, matching the
     *   pattern used by other scope events.
     *
     * Consumers call this via the `scope.$emit(name, payload)` scope method;
     * the method routes here via `createTypedScope`.
     */
    emitEvent(name, payload) {
        // Fast-path: zero work when no recorders are attached.
        if (this._recorders.length === 0)
            return;
        // Redaction: if the event name matches any emitPattern, replace payload
        // with '[REDACTED]' BEFORE constructing the event (no leak through
        // copy-on-write, no way for recorders to see the raw value).
        let finalPayload = payload;
        const patterns = this._redactionPolicy?.emitPatterns;
        if (patterns && patterns.length > 0) {
            for (const pattern of patterns) {
                if (pattern.test(name)) {
                    finalPayload = '[REDACTED]';
                    break;
                }
            }
        }
        // Build the enriched event once; pass the same reference to all
        // recorders. Since EmitEvent is `readonly`, sharing is safe.
        const event = {
            name,
            payload: finalPayload,
            stageName: this._stageName,
            runtimeStageId: this._stageContext.runtimeStageId,
            subflowPath: this._getSubflowPath(),
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
        };
        // Dispatch with error isolation — same pattern as _invokeHook uses for
        // other scope events. A throwing recorder's error is surfaced via
        // onError on the other recorders; the emit loop continues unaffected.
        for (const recorder of this._recorders) {
            if (typeof recorder.onEmit !== 'function')
                continue;
            try {
                // Shared invoke helper — the SAME primitive the deferred tier uses
                // at delivery time, so the two delivery paths cannot drift.
                invokeRecorderHook(recorder, 'onEmit', event);
            }
            catch (error) {
                this._invokeHook('onError', {
                    stageName: this._stageName,
                    stageId: this._stageContext.stageId,
                    runtimeStageId: this._stageContext.runtimeStageId,
                    pipelineId: this._stageContext.runId,
                    timestamp: Date.now(),
                    error: error,
                    operation: 'write',
                    channel: 'scope',
                });
            }
        }
    }
    // ── Detach — fire-and-forget child flowchart execution ─────────────────
    //
    // Delegates to the shared `detach/spawn` helper, which mints a refId
    // from this stage's `runtimeStageId` and calls `driver.schedule()`.
    // Routed through `createTypedScope` as `scope.$detachAndJoinLater(...)`
    // and `scope.$detachAndForget(...)`.
    /** See `ScopeMethods.$detachAndJoinLater`. */
    detachAndJoinLater(driver, child, input) {
        return detachAndJoinLaterSpawn(driver, child, input, this._stageContext.runtimeStageId);
    }
    /** See `ScopeMethods.$detachAndForget`. */
    detachAndForget(driver, child, input) {
        detachAndForgetSpawn(driver, child, input, this._stageContext.runtimeStageId);
    }
    /**
     * Build the subflowPath (outer → inner) for event enrichment.
     *
     * Parses from `runtimeStageId` which has the format
     * `[subflowPath/]stageId#executionIndex` (see `lib/engine/runtimeStageId.ts`).
     * Subflow isolation prevents walking the parent-chain across boundaries,
     * so the runtimeStageId — globally unique, includes full path — is the
     * canonical source of truth for the subflow hierarchy at emit time.
     *
     * Examples:
     *   'seed#0'                 → []                    (root)
     *   'sf-inner/inner#5'       → ['sf-inner']
     *   'sf-a/sf-b/stage#3'      → ['sf-a', 'sf-b']      (nested)
     */
    _getSubflowPath() {
        const rtid = this._stageContext.runtimeStageId;
        if (!rtid)
            return ScopeFacade._EMPTY_SUBFLOW_PATH;
        // Strip the trailing `#executionIndex` to isolate the path portion.
        const hashIdx = rtid.lastIndexOf('#');
        const pathPortion = hashIdx >= 0 ? rtid.slice(0, hashIdx) : rtid;
        // pathPortion is now `[subflowPath/]stageId`. Split on '/' and drop the
        // last segment (stageId) — what remains is the subflow path.
        const segments = pathPortion.split('/');
        if (segments.length <= 1)
            return ScopeFacade._EMPTY_SUBFLOW_PATH;
        return Object.freeze(segments.slice(0, -1));
    }
    // ── Non-Tracking State Inspection (for TypedScope proxy internals) ──────
    /** Returns all state keys without firing onRead. Used by TypedScope ownKeys/has traps. */
    getStateKeys() {
        const snapshot = this._stageContext.getValue([], undefined);
        if (!snapshot || typeof snapshot !== 'object')
            return [];
        return Object.keys(snapshot);
    }
    /** Check key existence without firing onRead. Used by TypedScope has trap.
     *  Contract: returns false for keys never set OR keys set to undefined.
     *  This matches deleteValue() semantics (sets to undefined = deleted). */
    hasKey(key) {
        return this._stageContext.getValue([], key) !== undefined;
    }
    /** Read state without firing onRead. Used by array proxy getCurrent() to avoid
     *  phantom reads on internal array operations (.length, .has, iteration, etc.).
     *  The initial property access fires one tracked onRead via getValue(); subsequent
     *  internal array operations use this method to stay silent.
     *  NOTE: Like getValue(), returns the raw value to the caller. Redaction applies
     *  only to recorder dispatch — it does not filter the returned value. This matches
     *  the existing getValue() contract where user code always receives raw data.
     *
     *  RFC-003 D2: a silent read of a key this stage never TRACKED-read marks
     *  the stage's commit with `untrackedSources: ['silent']` — a causal slice
     *  built from onRead events would miss this dependency, and consumers must
     *  be told. Silent reads shadowed by a tracked read of the same key (the
     *  array-proxy pattern above) are not flagged: their edge is captured. A
     *  whole-state silent read (no key) is always flagged. */
    getValueSilent(key) {
        if (key === undefined || !this._trackedReadKeys.has(key)) {
            this._stageContext.markUntrackedSource('silent');
        }
        return this._stageContext.getValueDirect([], key);
    }
    // ── State Access ─────────────────────────────────────────────────────────
    getInitialValueFor(key) {
        return this._stageContext.getGlobal?.(key);
    }
    /**
     * Tracked read of shared state.
     *
     * **Read values are BORROWED — do not mutate them.** Since the lazy buffer
     * (#13), reads before the stage's first write return references INTO
     * COMMITTED SHARED STATE, and reads after a write return references into
     * the stage's private transaction-buffer working copy (the eager engine
     * returned references into that working copy for ALL reads). Mutating a
     * returned value in place would corrupt state without a commit record —
     * write changes back via `setValue`/`updateValue` instead. TypedScope
     * consumers are safe automatically: the proxy routes every mutation
     * through `setValue`/`updateValue`/copy-on-write array ops.
     *
     * There is deliberately NO dev-mode freeze guard here: deep-freezing a
     * buffer-served read would freeze the stage's own working copy and make a
     * legitimate read-then-deep-write throw, and freezing a committed-state
     * read mutates an object shared with every other consumer of the live
     * state. See `src/lib/memory/README.md` ("Read values are borrowed").
     *
     * Recorder note: the `onRead` event below passes the SAME live reference
     * (no clone) unless field-level redaction scrubs a copy — recorders must
     * treat event values as read-only too.
     */
    getValue(key) {
        const value = this._stageContext.getValue([], key);
        // RFC-003 D2: remember tracked keys so later SILENT reads of the same
        // key count as shadowed (edge already captured) instead of untracked.
        if (key !== undefined)
            this._trackedReadKeys.add(key);
        if (this._recorders.length > 0) {
            const isRedacted = key !== undefined && this._isKeyRedacted(key);
            const fieldSet = key !== undefined ? this._redactedFieldsByKey.get(key) : undefined;
            let recorderValue;
            if (isRedacted) {
                recorderValue = '[REDACTED]';
            }
            else if (fieldSet && value && typeof value === 'object') {
                recorderValue = this._scrubFields(value, fieldSet);
            }
            else {
                recorderValue = value;
            }
            this._invokeHook('onRead', {
                stageName: this._stageName,
                stageId: this._stageContext.stageId,
                runtimeStageId: this._stageContext.runtimeStageId,
                pipelineId: this._stageContext.runId,
                timestamp: Date.now(),
                key,
                value: recorderValue,
                redacted: isRedacted || fieldSet !== undefined || undefined,
            });
        }
        return value;
    }
    setValue(key, value, shouldRedact, description) {
        assertNotReadonly(this._readOnlyValues, key, 'write');
        // Dev-mode: warn if the value contains circular references.
        // Check AFTER assertNotReadonly — don't warn for writes that will be blocked.
        // Circular values work (terminal proxy handles them) but can produce
        // surprising behavior in narrative, JSON serialization, and snapshots.
        if (isDevMode() && value !== null && typeof value === 'object') {
            if (hasCircularReference(value)) {
                // eslint-disable-next-line no-console
                console.warn(`[footprint] Circular reference detected in setValue('${key}'). ` +
                    'Writes past the cycle depth will use terminal proxy tracking. ' +
                    'Consider flattening the data structure.');
            }
        }
        // Auto-redact if key matches policy (exact keys or patterns), or if the key was
        // previously marked redacted (e.g. carried over from a subflow via outputMapper).
        const effectiveRedact = shouldRedact || this._isPolicyRedacted(key) || this._redactedKeys.has(key);
        const result = this._stageContext.setObject([], key, value, effectiveRedact, description);
        if (effectiveRedact) {
            this._redactedKeys.add(key);
        }
        // Check for field-level redaction from policy
        const fieldSet = this._redactedFieldsByKey.get(key);
        if (this._recorders.length > 0) {
            let recorderValue;
            if (effectiveRedact) {
                recorderValue = '[REDACTED]';
            }
            else if (fieldSet && value && typeof value === 'object') {
                recorderValue = this._scrubFields(value, fieldSet);
            }
            else {
                recorderValue = value;
            }
            this._invokeHook('onWrite', {
                stageName: this._stageName,
                stageId: this._stageContext.stageId,
                runtimeStageId: this._stageContext.runtimeStageId,
                pipelineId: this._stageContext.runId,
                timestamp: Date.now(),
                key,
                value: recorderValue,
                operation: 'set',
                redacted: effectiveRedact || fieldSet !== undefined || undefined,
            });
        }
        return result;
    }
    updateValue(key, value, description) {
        assertNotReadonly(this._readOnlyValues, key, 'write');
        // Dev-mode: same circular check as setValue (merge targets can be circular too)
        if (isDevMode() && value !== null && typeof value === 'object') {
            if (hasCircularReference(value)) {
                // eslint-disable-next-line no-console
                console.warn(`[footprint] Circular reference detected in updateValue('${key}'). ` +
                    'Consider flattening the data structure.');
            }
        }
        const isRedacted = this._isKeyRedacted(key) || this._isPolicyRedacted(key);
        const result = this._stageContext.updateObject([], key, value, description, isRedacted);
        if (this._recorders.length > 0) {
            const fieldSet = this._redactedFieldsByKey.get(key);
            let recorderValue;
            if (isRedacted) {
                recorderValue = '[REDACTED]';
            }
            else if (fieldSet && value && typeof value === 'object') {
                recorderValue = this._scrubFields(value, fieldSet);
            }
            else {
                recorderValue = value;
            }
            this._invokeHook('onWrite', {
                stageName: this._stageName,
                stageId: this._stageContext.stageId,
                runtimeStageId: this._stageContext.runtimeStageId,
                pipelineId: this._stageContext.runId,
                timestamp: Date.now(),
                key,
                value: recorderValue,
                operation: 'update',
                redacted: isRedacted || fieldSet !== undefined || undefined,
            });
        }
        return result;
    }
    deleteValue(key, description) {
        assertNotReadonly(this._readOnlyValues, key, 'delete');
        const result = this._stageContext.setObject([], key, undefined, false, description ?? `deleted ${key}`, 'delete');
        // Deleting a redacted key clears its redaction status
        this._redactedKeys.delete(key);
        if (this._recorders.length > 0) {
            this._invokeHook('onWrite', {
                stageName: this._stageName,
                stageId: this._stageContext.stageId,
                runtimeStageId: this._stageContext.runtimeStageId,
                pipelineId: this._stageContext.runId,
                timestamp: Date.now(),
                key,
                value: undefined,
                operation: 'delete',
            });
        }
        return result;
    }
    /** @internal */
    setGlobal(key, value, description) {
        return this._stageContext.setGlobal?.(key, value, description);
    }
    /** @internal */
    getGlobal(key) {
        return this._stageContext.getGlobal?.(key);
    }
    /** @internal */
    setObjectInRoot(key, value) {
        return this._stageContext.setRoot?.(key, value);
    }
    // ── Read-only + misc ─────────────────────────────────────────────────────
    /**
     * Returns the readonly input values passed to this pipeline, cast to `T`.
     * The returned object is deeply frozen — any attempt to mutate it throws.
     * Cached at construction time for zero-allocation repeated access.
     *
     * ```typescript
     * const { applicantName, income } = scope.getArgs<{ applicantName: string; income: number }>();
     * ```
     *
     * RFC-003 D2: args are untracked BY DESIGN, so calling this (with actual
     * input present) marks the stage's commit with `untrackedSources: ['args']`
     * — telling causal-slice consumers the backward slice may be incomplete
     * here. An empty-args read carries no information and is not flagged.
     */
    getArgs() {
        if (this._hasArgs)
            this._stageContext.markUntrackedSource('args');
        return this._frozenArgs;
    }
    /**
     * Returns the execution environment — read-only infrastructure values
     * that propagate through nested executors (like `process.env` for flowcharts).
     *
     * Contains: signal (abort), timeoutMs, traceId.
     * Frozen at construction time. Inherited by subflows automatically.
     *
     * ```typescript
     * const { signal, traceId } = scope.getEnv();
     * ```
     *
     * RFC-003 D2: env is untracked BY DESIGN, so calling this (with a
     * non-empty environment) marks the stage's commit with
     * `untrackedSources: ['env']` — see {@link getArgs}.
     */
    getEnv() {
        if (this._hasEnv)
            this._stageContext.markUntrackedSource('env');
        return this._executionEnv;
    }
    /** @internal */
    getPipelineId() {
        return this._stageContext.runId;
    }
    // ── Internal ─────────────────────────────────────────────────────────────
    /** Checks if a key is redacted (explicit _redactedKeys set). */
    _isKeyRedacted(key) {
        return this._redactedKeys.has(key);
    }
    /**
     * Checks if a key should be auto-redacted by the policy (exact keys + patterns).
     *
     * ReDoS guard: pattern testing is capped at MAX_PATTERN_KEY_LEN characters.
     * Scope state keys are always short identifiers; any key exceeding the cap
     * is almost certainly not a legitimate scope key, so skipping pattern matching
     * for it does not risk leaking PII. Exact-key matching (Array.includes) is
     * still applied regardless of length and is not vulnerable to ReDoS.
     */
    _isPolicyRedacted(key) {
        if (!this._redactionPolicy)
            return false;
        if (this._redactionPolicy.keys?.includes(key))
            return true;
        if (this._redactionPolicy.patterns) {
            if (key.length > ScopeFacade._MAX_PATTERN_KEY_LEN) {
                // Dev-mode warning: pattern matching was silently skipped for this key.
                // Use policy.keys for exact matching of long key names.
                if (isDevMode()) {
                    // eslint-disable-next-line no-console
                    console.warn(`[footprint] RedactionPolicy: key '${key.slice(0, 40)}...' (${key.length} chars) exceeds ` +
                        'the pattern-matching length cap and was skipped. ' +
                        'Use policy.keys for exact matching of long key names.');
                }
            }
            else {
                for (const p of this._redactionPolicy.patterns) {
                    p.lastIndex = 0; // Reset stateful global/sticky regexes
                    if (p.test(key))
                        return true;
                }
            }
        }
        return false;
    }
    /**
     * Maximum key length (characters) that will be tested against regex redaction
     * patterns. Keys longer than this are skipped for pattern matching to prevent
     * ReDoS: a pathological regex tested against an unboundedly long key string
     * can cause catastrophic backtracking.
     *
     * 256 characters comfortably exceeds any realistic scope-state key name.
     */
    static _MAX_PATTERN_KEY_LEN = 256;
    /**
     * Returns a deep-cloned copy with specified fields replaced by '[REDACTED]'.
     * Supports dot-notation paths (e.g. 'address.zip') for nested objects.
     */
    _scrubFields(obj, fields) {
        const copy = structuredClone(obj);
        for (const field of fields) {
            if (field.includes('.') && !Object.prototype.hasOwnProperty.call(copy, field)) {
                // Dot-notation path → deep scrub (only if not a literal flat key)
                if (lodashHas(copy, field)) {
                    lodashSet(copy, field, '[REDACTED]');
                }
            }
            else {
                if (Object.prototype.hasOwnProperty.call(copy, field)) {
                    copy[field] = '[REDACTED]';
                }
            }
        }
        return copy;
    }
    _invokeHook(hook, event) {
        for (const recorder of this._recorders) {
            try {
                // Shared invoke helper — the SAME primitive the deferred tier uses
                // at delivery time (RFC-001 §9 mitigation): lookup + `.call(this)`
                // semantics live in exactly one place, so the inline and deferred
                // paths cannot drift.
                invokeRecorderHook(recorder, hook, event);
            }
            catch (error) {
                if (hook !== 'onError') {
                    this._invokeHook('onError', {
                        stageName: this._stageName,
                        stageId: this._stageContext.stageId,
                        runtimeStageId: this._stageContext.runtimeStageId,
                        pipelineId: this._stageContext.runId,
                        timestamp: Date.now(),
                        error: error,
                        operation: hook === 'onRead' ? 'read' : hook === 'onCommit' ? 'commit' : 'write',
                        channel: 'scope',
                    });
                }
            }
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2NvcGVGYWNhZGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL1Njb3BlRmFjYWRlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBRUgsT0FBTyxFQUNMLGVBQWUsSUFBSSxvQkFBb0IsRUFDdkMsa0JBQWtCLElBQUksdUJBQXVCLEdBQzlDLE1BQU0sb0JBQW9CLENBQUM7QUFFNUIsT0FBTyxFQUFFLFNBQVMsSUFBSSxTQUFTLEVBQUUsU0FBUyxJQUFJLFNBQVMsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRXRGLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQy9ELE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxTQUFTLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUN0RSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSwrQkFBK0IsQ0FBQztBQUdwRixNQUFNLE9BQU8sV0FBVztJQUNmLE1BQU0sQ0FBVSxLQUFLLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBRTVEOzs7O09BSUc7SUFDSyxNQUFNLENBQVUsbUJBQW1CLEdBQXNCLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUM7SUFFekUsYUFBYSxDQUFlO0lBQzVCLFVBQVUsQ0FBUztJQUNWLGVBQWUsQ0FBVztJQUU3QywrRUFBK0U7SUFDOUQsV0FBVyxDQUEwQjtJQUV0RCx5RUFBeUU7SUFDeEQsYUFBYSxDQUF5QjtJQUV2RDtvRUFDZ0U7SUFDL0MsUUFBUSxDQUFVO0lBRW5DLCtEQUErRDtJQUM5QyxPQUFPLENBQVU7SUFFbEM7Ozs7OztPQU1HO0lBQ2MsZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUU5QyxVQUFVLEdBQW9CLEVBQUUsQ0FBQztJQUNqQyxhQUFhLENBQWM7SUFDM0IsZ0JBQWdCLENB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QUFDLElBQUksS0FBSyxVQUFVLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsT0FBTzt3QkFDaEYsT0FBTyxFQUFFLE9BQWdCO3FCQUMxQixDQUFDLENBQUM7Z0JBQ0wsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2NvcGVGYWNhZGUg4oCUIEJhc2UgY2xhc3MgdGhhdCBsaWJyYXJ5IGNvbnN1bWVycyBleHRlbmQgdG8gY3JlYXRlIGN1c3RvbSBzY29wZSBjbGFzc2VzXG4gKlxuICogV3JhcHMgU3RhZ2VDb250ZXh0IChmcm9tIG1lbW9yeS8pIHRvIHByb3ZpZGUgYSBjb25zdW1lci1mcmllbmRseSBBUEkgZm9yXG4gKiBzdGF0ZSBhY2Nlc3MsIGRlYnVnIGxvZ2dpbmcsIG1ldHJpY3MsIGFuZCByZWNvcmRlciBob29rcy5cbiAqXG4gKiBDb25zdW1lcnMgZXh0ZW5kIHRoaXMgY2xhc3MgdG8gYWRkIGRvbWFpbi1zcGVjaWZpYyBwcm9wZXJ0aWVzOlxuICpcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGNsYXNzIE15U2NvcGUgZXh0ZW5kcyBTY29wZUZhY2FkZSB7XG4gKiAgIGdldCB1c2VyTmFtZSgpOiBzdHJpbmcgeyByZXR1cm4gdGhpcy5nZXRWYWx1ZSgnbmFtZScpIGFzIHN0cmluZzsgfVxuICogICBzZXQgdXNlck5hbWUodmFsdWU6IHN0cmluZykgeyB0aGlzLnNldFZhbHVlKCduYW1lJywgdmFsdWUpOyB9XG4gKiB9XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQge1xuICBkZXRhY2hBbmRGb3JnZXQgYXMgZGV0YWNoQW5kRm9yZ2V0U3Bhd24sXG4gIGRldGFjaEFuZEpvaW5MYXRlciBhcyBkZXRhY2hBbmRKb2luTGF0ZXJTcGF3bixcbn0gZnJvbSAnLi4vZGV0YWNoL3NwYXduLmpzJztcbmltcG9ydCB0eXBlIHsgRXhlY3V0aW9uRW52IH0gZnJvbSAnLi4vZW5naW5lL3R5cGVzLmpzJztcbmltcG9ydCB7IG5hdGl2ZUhhcyBhcyBsb2Rhc2hIYXMsIG5hdGl2ZVNldCBhcyBsb2Rhc2hTZXQgfSBmcm9tICcuLi9tZW1vcnkvcGF0aE9wcy5qcyc7XG5pbXBvcnQgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB7IGludm9rZVJlY29yZGVySG9vayB9IGZyb20gJy4uL3JlY29yZGVyL2ludm9rZUhvb2suanMnO1xuaW1wb3J0IHsgaGFzQ2lyY3VsYXJSZWZlcmVuY2UsIGlzRGV2TW9kZSB9IGZyb20gJy4vZGV0ZWN0Q2lyY3VsYXIuanMnO1xuaW1wb3J0IHsgYXNzZXJ0Tm90UmVhZG9ubHksIGNyZWF0ZUZyb3plbkFyZ3MgfSBmcm9tICcuL3Byb3RlY3Rpb24vcmVhZG9ubHlJbnB1dC5qcyc7XG5pbXBvcnQgdHlwZSB7IENvbW1pdEV2ZW50LCBSZWRhY3Rpb25Qb2xpY3ksIFJlZGFjdGlvblJlcG9ydCwgU2NvcGVSZWNvcmRlciB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgU2NvcGVGYWNhZGUge1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEJSQU5EID0gU3ltYm9sLmZvcignU2NvcGVGYWNhZGVAdjEnKTtcblxuICAvKipcbiAgICogU2hhcmVkIHNlbnRpbmVsIHJldHVybmVkIGJ5IGBfZ2V0U3ViZmxvd1BhdGgoKWAgZm9yIHJvb3QtbGV2ZWwgc3RhZ2VzXG4gICAqIChubyBzdWJmbG93IG5lc3RpbmcpLiBBdm9pZHMgcGVyLWNhbGwgYWxsb2NhdGlvbiBvZiBhIGZyZXNoXG4gICAqIGBPYmplY3QuZnJlZXplKFtdKWAgb24gZXZlcnkgYGVtaXRFdmVudGAgaW4gdGhlIGNvbW1vbiBuby1zdWJmbG93IGNhc2UuXG4gICAqL1xuICBwcml2YXRlIHN0YXRpYyByZWFkb25seSBfRU1QVFlfU1VCRkxPV19QQVRIOiByZWFkb25seSBzdHJpbmdbXSA9IE9iamVjdC5mcmVlemUoW10pO1xuXG4gIHByb3RlY3RlZCBfc3RhZ2VDb250ZXh0OiBTdGFnZUNvbnRleHQ7XG4gIHByb3RlY3RlZCBfc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIHByb3RlY3RlZCByZWFkb25seSBfcmVhZE9ubHlWYWx1ZXM/OiB1bmtub3duO1xuXG4gIC8qKiBDYWNoZWQgZGVlcGx5LWZyb3plbiBjb3B5IG9mIHJlYWRPbmx5VmFsdWVzIGZvciBnZXRBcmdzKCkuIENyZWF0ZWQgb25jZS4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBfZnJvemVuQXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgLyoqIEV4ZWN1dGlvbiBlbnZpcm9ubWVudCDigJQgcmVhZC1vbmx5LCBpbmhlcml0ZWQgZnJvbSBwYXJlbnQgZXhlY3V0b3IuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgX2V4ZWN1dGlvbkVudjogUmVhZG9ubHk8RXhlY3V0aW9uRW52PjtcblxuICAvKiogUkZDLTAwMyBEMjogdHJ1ZSB3aGVuIGBnZXRBcmdzKClgIGNhbiByZXR1cm4gYWN0dWFsIGRhdGEg4oCUIGFuIGVtcHR5XG4gICAqICBge31gIHJlYWQgY2FycmllcyBubyBpbmZvcm1hdGlvbiwgc28gaXQgaXMgbmV2ZXIgZmxhZ2dlZC4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBfaGFzQXJnczogYm9vbGVhbjtcblxuICAvKiogUkZDLTAwMyBEMjogdHJ1ZSB3aGVuIGBnZXRFbnYoKWAgY2FuIHJldHVybiBhY3R1YWwgZGF0YS4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBfaGFzRW52OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSRkMtMDAzIEQyOiBrZXlzIHRoaXMgc3RhZ2UgaGFzIFRSQUNLRUQtcmVhZCAodmlhIGBnZXRWYWx1ZShrZXkpYCkuXG4gICAqIEEgc2lsZW50IHJlYWQgb2YgYSBrZXkgaW4gdGhpcyBzZXQgaXMgU0hBRE9XRUQg4oCUIGl0cyByZWFk4oaSd3JpdGUgZWRnZSBpc1xuICAgKiBhbHJlYWR5IGNhcHR1cmVkLCBzbyBpdCBpcyBub3QgZmxhZ2dlZCBhcyBhbiB1bnRyYWNrZWQgc291cmNlLiBUaGlzIGlzXG4gICAqIHdoYXQga2VlcHMgVHlwZWRTY29wZSBhcnJheS1wcm94eSBpbnRlcm5hbHMgKHdoaWNoIGFsd2F5cyBmb2xsb3cgYVxuICAgKiB0cmFja2VkIHByb3BlcnR5IHJlYWQpIGFuZCBgJGJhdGNoQXJyYXlgIGhvbmVzdC1idXQtcXVpZXQuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IF90cmFja2VkUmVhZEtleXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBwcml2YXRlIF9yZWNvcmRlcnM6IFNjb3BlUmVjb3JkZXJbXSA9IFtdO1xuICBwcml2YXRlIF9yZWRhY3RlZEtleXM6IFNldDxzdHJpbmc+O1xuICBwcml2YXRlIF9yZWRhY3Rpb25Qb2xpY3k6IFJlZGFjdGlvblBvbGljeSB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfcmVkYWN0ZWRGaWVsZHNCeUtleTogTWFwPHN0cmluZywgU2V0PHN0cmluZz4+ID0gbmV3IE1hcCgpO1xuXG4gIGNvbnN0cnVjdG9yKGNvbnRleHQ6IFN0YWdlQ29udGV4dCwgc3RhZ2VOYW1lOiBzdHJpbmcsIHJlYWRPbmx5VmFsdWVzPzogdW5rbm93biwgZXhlY3V0aW9uRW52PzogRXhlY3V0aW9uRW52KSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0ID0gY29udGV4dDtcbiAgICB0aGlzLl9zdGFnZU5hbWUgPSBzdGFnZU5hbWU7XG4gICAgdGhpcy5fcmVhZE9ubHlWYWx1ZXMgPSByZWFkT25seVZhbHVlcztcbiAgICB0aGlzLl9mcm96ZW5BcmdzID0gY3JlYXRlRnJvemVuQXJncyhyZWFkT25seVZhbHVlcyk7XG4gICAgdGhpcy5fZXhlY3V0aW9uRW52ID0gT2JqZWN0LmZyZWV6ZSh7IC4uLmV4ZWN1dGlvbkVudiB9KTtcbiAgICB0aGlzLl9oYXNBcmdzID0gT2JqZWN0LmtleXModGhpcy5fZnJvemVuQXJncykubGVuZ3RoID4gMDtcbiAgICB0aGlzLl9oYXNFbnYgPSBPYmplY3Qua2V5cyh0aGlzLl9leGVjdXRpb25FbnYpLmxlbmd0aCA+IDA7XG4gICAgdGhpcy5fcmVkYWN0ZWRLZXlzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgICAvLyBSZWdpc3RlciBhcyBjb21taXQgb2JzZXJ2ZXIgc28gU2NvcGVSZWNvcmRlci5vbkNvbW1pdCBmaXJlcyB3aGVuIFN0YWdlQ29udGV4dC5jb21taXQoKSBpcyBjYWxsZWRcbiAgICB0aGlzLl9zdGFnZUNvbnRleHQuc2V0Q29tbWl0T2JzZXJ2ZXIoKG11dGF0aW9ucykgPT4ge1xuICAgICAgdGhpcy5fb25Db21taXRGaXJlZChtdXRhdGlvbnMpO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFNoYXJlIGEgcmVkYWN0ZWQta2V5cyBzZXQgYWNyb3NzIG11bHRpcGxlIFNjb3BlRmFjYWRlIGluc3RhbmNlcy5cbiAgICogQ2FsbCB0aGlzIHRvIG1ha2UgcmVkYWN0aW9uIHBlcnNpc3QgYWNyb3NzIHN0YWdlcyBpbiB0aGUgc2FtZSBwaXBlbGluZS5cbiAgICogQGludGVybmFsXG4gICAqL1xuICB1c2VTaGFyZWRSZWRhY3RlZEtleXMoc2hhcmVkU2V0OiBTZXQ8c3RyaW5nPik6IHZvaWQge1xuICAgIHRoaXMuX3JlZGFjdGVkS2V5cyA9IHNoYXJlZFNldDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBjdXJyZW50IHJlZGFjdGVkLWtleXMgc2V0IChmb3Igc2hhcmluZyB3aXRoIG90aGVyIHNjb3BlcykuXG4gICAqIEBpbnRlcm5hbFxuICAgKi9cbiAgZ2V0UmVkYWN0ZWRLZXlzKCk6IFNldDxzdHJpbmc+IHtcbiAgICByZXR1cm4gdGhpcy5fcmVkYWN0ZWRLZXlzO1xuICB9XG5cbiAgLyoqXG4gICAqIEFwcGx5IGEgZGVjbGFyYXRpdmUgcmVkYWN0aW9uIHBvbGljeS4gVGhlIHBvbGljeSBpcyBhZGRpdGl2ZSDigJRcbiAgICogaXQgd29ya3MgYWxvbmdzaWRlIG1hbnVhbCBgc2V0VmFsdWUoLi4uLCB0cnVlKWAgY2FsbHMuXG4gICAqIEBpbnRlcm5hbFxuICAgKi9cbiAgdXNlUmVkYWN0aW9uUG9saWN5KHBvbGljeTogUmVkYWN0aW9uUG9saWN5KTogdm9pZCB7XG4gICAgdGhpcy5fcmVkYWN0aW9uUG9saWN5ID0gcG9saWN5O1xuICAgIC8vIFByZS1wb3B1bGF0ZSBmaWVsZC1sZXZlbCByZWRhY3Rpb24gbWFwIGZyb20gcG9saWN5XG4gICAgaWYgKHBvbGljeS5maWVsZHMpIHtcbiAgICAgIGZvciAoY29uc3QgW2tleSwgZmllbGRzXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3kuZmllbGRzKSkge1xuICAgICAgICB0aGlzLl9yZWRhY3RlZEZpZWxkc0J5S2V5LnNldChrZXksIG5ldyBTZXQoZmllbGRzKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRSZWRhY3Rpb25Qb2xpY3koKTogUmVkYWN0aW9uUG9saWN5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5fcmVkYWN0aW9uUG9saWN5O1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgYSBjb21wbGlhbmNlLWZyaWVuZGx5IHJlcG9ydCBvZiBhbGwgcmVkYWN0aW9uIGFjdGl2aXR5LlxuICAgKiBOZXZlciBpbmNsdWRlcyBhY3R1YWwgdmFsdWVzIOKAlCBvbmx5IGtleSBuYW1lcywgZmllbGQgbmFtZXMsIGFuZCBwYXR0ZXJucy5cbiAgICovXG4gIGdldFJlZGFjdGlvblJlcG9ydCgpOiBSZWRhY3Rpb25SZXBvcnQge1xuICAgIGNvbnN0IGZpZWxkUmVkYWN0aW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XG4gICAgZm9yIChjb25zdCBba2V5LCBmaWVsZHNdIG9mIHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkpIHtcbiAgICAgIGZpZWxkUmVkYWN0aW9uc1trZXldID0gWy4uLmZpZWxkc107XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICByZWRhY3RlZEtleXM6IFsuLi50aGlzLl9yZWRhY3RlZEtleXNdLFxuICAgICAgZmllbGRSZWRhY3Rpb25zLFxuICAgICAgcGF0dGVybnM6ICh0aGlzLl9yZWRhY3Rpb25Qb2xpY3k/LnBhdHRlcm5zID8/IFtdKS5tYXAoKHApID0+IHAuc291cmNlKSxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIFNjb3BlUmVjb3JkZXIgTWFuYWdlbWVudCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBhdHRhY2hTY29wZVJlY29yZGVyKHJlY29yZGVyOiBTY29wZVJlY29yZGVyKTogdm9pZCB7XG4gICAgLy8gUmVwbGFjZSBleGlzdGluZyByZWNvcmRlciB3aXRoIHNhbWUgSUQgKGlkZW1wb3RlbnQg4oCUIHByZXZlbnRzIGRvdWJsZS1jb3VudGluZylcbiAgICB0aGlzLl9yZWNvcmRlcnMgPSB0aGlzLl9yZWNvcmRlcnMuZmlsdGVyKChyKSA9PiByLmlkICE9PSByZWNvcmRlci5pZCk7XG4gICAgdGhpcy5fcmVjb3JkZXJzLnB1c2gocmVjb3JkZXIpO1xuICB9XG5cbiAgZGV0YWNoU2NvcGVSZWNvcmRlcihyZWNvcmRlcklkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9yZWNvcmRlcnMgPSB0aGlzLl9yZWNvcmRlcnMuZmlsdGVyKChyKSA9PiByLmlkICE9PSByZWNvcmRlcklkKTtcbiAgfVxuXG4gIGdldFNjb3BlUmVjb3JkZXJzKCk6IFNjb3BlUmVjb3JkZXJbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLl9yZWNvcmRlcnNdO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBub3RpZnlTdGFnZVN0YXJ0KCk6IHZvaWQge1xuICAgIHRoaXMuX2ludm9rZUhvb2soJ29uU3RhZ2VTdGFydCcsIHtcbiAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBub3RpZnlTdGFnZUVuZChkdXJhdGlvbj86IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuX2ludm9rZUhvb2soJ29uU3RhZ2VFbmQnLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5zdGFnZUlkLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIGR1cmF0aW9uLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBub3RpZnlQYXVzZShwYXVzZURhdGE/OiB1bmtub3duKTogdm9pZCB7XG4gICAgdGhpcy5faW52b2tlSG9vaygnb25QYXVzZScsIHtcbiAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgcGF1c2VEYXRhLFxuICAgICAgY2hhbm5lbDogJ3Njb3BlJyBhcyBjb25zdCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgbm90aWZ5UmVzdW1lKGhhc0lucHV0OiBib29sZWFuKTogdm9pZCB7XG4gICAgdGhpcy5faW52b2tlSG9vaygnb25SZXN1bWUnLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5zdGFnZUlkLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIGhhc0lucHV0LFxuICAgICAgY2hhbm5lbDogJ3Njb3BlJyBhcyBjb25zdCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgbm90aWZ5Q29tbWl0KG11dGF0aW9uczogQ29tbWl0RXZlbnRbJ211dGF0aW9ucyddKTogdm9pZCB7XG4gICAgdGhpcy5faW52b2tlSG9vaygnb25Db21taXQnLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5zdGFnZUlkLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIG11dGF0aW9ucyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDYWxsZWQgYnkgU3RhZ2VDb250ZXh0LmNvbW1pdCgpIG9ic2VydmVyLiBDb252ZXJ0cyB0cmFja2VkIHdyaXRlcyB0byBDb21taXRFdmVudCBmb3JtYXQuXG4gICAqICBFcnJvcnMgYXJlIGNhdWdodCB0byBwcmV2ZW50IHJlY29yZGVyIGlzc3VlcyBmcm9tIGFib3J0aW5nIHRoZSB0cmF2ZXJzYWwuICovXG4gIHByaXZhdGUgX29uQ29tbWl0RmlyZWQobXV0YXRpb25zOiBSZWNvcmQ8c3RyaW5nLCB7IHZhbHVlOiB1bmtub3duOyBvcGVyYXRpb246ICdzZXQnIHwgJ3VwZGF0ZScgfCAnZGVsZXRlJyB9Pik6IHZvaWQge1xuICAgIGlmICh0aGlzLl9yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY29tbWl0TXV0YXRpb25zOiBDb21taXRFdmVudFsnbXV0YXRpb25zJ10gPSBPYmplY3QuZW50cmllcyhtdXRhdGlvbnMpLm1hcCgoW2tleSwgZW50cnldKSA9PiB7XG4gICAgICAgIGNvbnN0IGlzUmVkYWN0ZWQgPSB0aGlzLl9pc0tleVJlZGFjdGVkKGtleSkgfHwgdGhpcy5faXNQb2xpY3lSZWRhY3RlZChrZXkpO1xuICAgICAgICBjb25zdCBmaWVsZFNldCA9IHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkuZ2V0KGtleSk7XG5cbiAgICAgICAgbGV0IHJlY29yZGVyVmFsdWU6IHVua25vd247XG4gICAgICAgIGlmIChpc1JlZGFjdGVkKSB7XG4gICAgICAgICAgcmVjb3JkZXJWYWx1ZSA9ICdbUkVEQUNURURdJztcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZFNldCAmJiBlbnRyeS52YWx1ZSAmJiB0eXBlb2YgZW50cnkudmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHRoaXMuX3NjcnViRmllbGRzKGVudHJ5LnZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBmaWVsZFNldCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IGVudHJ5LnZhbHVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBrZXksXG4gICAgICAgICAgdmFsdWU6IHJlY29yZGVyVmFsdWUsXG4gICAgICAgICAgb3BlcmF0aW9uOiBlbnRyeS5vcGVyYXRpb24sXG4gICAgICAgIH07XG4gICAgICB9KTtcblxuICAgICAgdGhpcy5ub3RpZnlDb21taXQoY29tbWl0TXV0YXRpb25zKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFN3YWxsb3cg4oCUIHJlY29yZGVyIGVycm9ycyBtdXN0IG5vdCBhYm9ydCB0aGUgdHJhdmVyc2FsLlxuICAgICAgLy8gSW5kaXZpZHVhbCByZWNvcmRlciBlcnJvcnMgYXJlIGFscmVhZHkgaXNvbGF0ZWQgYnkgX2ludm9rZUhvb2suXG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIERlYnVnIC8gRGlhZ25vc3RpY3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vXG4gIC8vIFRoZXNlIGxlZ2FjeSBtZXRob2RzIHN0aWxsIHdyaXRlIHRvIHRoZSBgU3RhZ2VDb250ZXh0YCBkaWFnbm9zdGljXG4gIC8vIHNpZGUgYmFncyAobG9nQ29udGV4dCAvIGVycm9yQ29udGV4dCAvIG1ldHJpY0NvbnRleHQgLyBldmFsQ29udGV4dCkgZm9yXG4gIC8vIHNuYXBzaG90IGluY2x1c2lvbi4gVGhleSBBTFNPIGZpcmUgdGhyb3VnaCB0aGUgRW1pdCBjaGFubmVsIHNvIGFueVxuICAvLyBhdHRhY2hlZCBgRW1pdFJlY29yZGVyYCBzZWVzIHRoZW0gaW4gcmVhbCB0aW1lIOKAlCBjbG9zaW5nIHRoZVxuICAvLyBsb25nLXN0YW5kaW5nIGdhcCB3aGVyZSBgJGRlYnVnYC9gJG1ldHJpY2Agd2VudCB0byB1bm9ic2VydmVkIGJhZ3MuXG5cbiAgYWRkRGVidWdJbmZvKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuICAgIHRoaXMuX3N0YWdlQ29udGV4dC5hZGRMb2coa2V5LCB2YWx1ZSk7XG4gICAgdGhpcy5lbWl0RXZlbnQoYGxvZy5kZWJ1Zy4ke2tleX1gLCB7IGtleSwgdmFsdWUsIGxldmVsOiAnZGVidWcnIH0pO1xuICB9XG5cbiAgYWRkRGVidWdNZXNzYWdlKHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0LmFkZExvZygnbWVzc2FnZXMnLCBbdmFsdWVdKTtcbiAgICB0aGlzLmVtaXRFdmVudCgnbG9nLmRlYnVnLm1lc3NhZ2VzJywgeyB2YWx1ZSwgbGV2ZWw6ICdkZWJ1ZycgfSk7XG4gIH1cblxuICBhZGRFcnJvckluZm8oa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0LmFkZEVycm9yKGtleSwgdmFsdWUpO1xuICAgIHRoaXMuZW1pdEV2ZW50KGBsb2cuZXJyb3IuJHtrZXl9YCwgeyBrZXksIHZhbHVlLCBsZXZlbDogJ2Vycm9yJyB9KTtcbiAgfVxuXG4gIGFkZE1ldHJpYyhtZXRyaWNOYW1lOiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0LmFkZE1ldHJpYyhtZXRyaWNOYW1lLCB2YWx1ZSk7XG4gICAgdGhpcy5lbWl0RXZlbnQoYG1ldHJpYy4ke21ldHJpY05hbWV9YCwgeyBuYW1lOiBtZXRyaWNOYW1lLCB2YWx1ZSB9KTtcbiAgfVxuXG4gIGFkZEV2YWwobWV0cmljTmFtZTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuICAgIHRoaXMuX3N0YWdlQ29udGV4dC5hZGRFdmFsKG1ldHJpY05hbWUsIHZhbHVlKTtcbiAgICB0aGlzLmVtaXRFdmVudChgZXZhbC4ke21ldHJpY05hbWV9YCwgeyBuYW1lOiBtZXRyaWNOYW1lLCB2YWx1ZSB9KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBFbWl0IOKAlCBQaGFzZSAzIHByaW1hcnkgcHJpbWl0aXZlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBGaXJlIGEgc3RydWN0dXJlZCBldmVudCB0byBldmVyeSBhdHRhY2hlZCByZWNvcmRlciBpbXBsZW1lbnRpbmdcbiAgICogYG9uRW1pdGAuIFN5bmNocm9ub3VzLCBpbi1vcmRlciwgcGFzcy10aHJvdWdoIOKAlCBubyBidWZmZXJpbmcuXG4gICAqXG4gICAqIC0gKipGYXN0LXBhdGgqKjogemVybyBhbGxvY2F0aW9uICsgemVybyBjb3N0IHdoZW4gbm8gcmVjb3JkZXJzIGFyZVxuICAgKiAgIGF0dGFjaGVkIChlYXJseSByZXR1cm4gb24gZW1wdHkgbGlzdCkuXG4gICAqIC0gKipFbnJpY2htZW50Kio6IGxpYnJhcnkgYXV0by1hZGRzIGBzdGFnZU5hbWVgLCBgcnVudGltZVN0YWdlSWRgLFxuICAgKiAgIGBzdWJmbG93UGF0aGAsIGBwaXBlbGluZUlkYCwgYHRpbWVzdGFtcGAgdG8gdGhlIGV2ZW50LlxuICAgKiAtICoqUmVkYWN0aW9uKio6IGBSZWRhY3Rpb25Qb2xpY3kuZW1pdFBhdHRlcm5zYCByZWdleGVzIGFyZSBtYXRjaGVkXG4gICAqICAgYWdhaW5zdCBgbmFtZWAg4oCUIG1hdGNoZWQgZXZlbnRzIGhhdmUgdGhlaXIgcGF5bG9hZCByZXBsYWNlZCB3aXRoXG4gICAqICAgYCdbUkVEQUNURURdJ2AgYmVmb3JlIGRpc3BhdGNoLlxuICAgKiAtICoqRXJyb3IgaXNvbGF0aW9uKio6IGEgdGhyb3dpbmcgYG9uRW1pdGAgZG9lcyBub3QgcHJvcGFnYXRlIOKAlCBpdCBpc1xuICAgKiAgIGNhdWdodCBhbmQgcm91dGVkIHRvIGBvbkVycm9yYCBvbiByZW1haW5pbmcgcmVjb3JkZXJzLCBtYXRjaGluZyB0aGVcbiAgICogICBwYXR0ZXJuIHVzZWQgYnkgb3RoZXIgc2NvcGUgZXZlbnRzLlxuICAgKlxuICAgKiBDb25zdW1lcnMgY2FsbCB0aGlzIHZpYSB0aGUgYHNjb3BlLiRlbWl0KG5hbWUsIHBheWxvYWQpYCBzY29wZSBtZXRob2Q7XG4gICAqIHRoZSBtZXRob2Qgcm91dGVzIGhlcmUgdmlhIGBjcmVhdGVUeXBlZFNjb3BlYC5cbiAgICovXG4gIGVtaXRFdmVudChuYW1lOiBzdHJpbmcsIHBheWxvYWQ6IHVua25vd24pOiB2b2lkIHtcbiAgICAvLyBGYXN0LXBhdGg6IHplcm8gd29yayB3aGVuIG5vIHJlY29yZGVycyBhcmUgYXR0YWNoZWQuXG4gICAgaWYgKHRoaXMuX3JlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIC8vIFJlZGFjdGlvbjogaWYgdGhlIGV2ZW50IG5hbWUgbWF0Y2hlcyBhbnkgZW1pdFBhdHRlcm4sIHJlcGxhY2UgcGF5bG9hZFxuICAgIC8vIHdpdGggJ1tSRURBQ1RFRF0nIEJFRk9SRSBjb25zdHJ1Y3RpbmcgdGhlIGV2ZW50IChubyBsZWFrIHRocm91Z2hcbiAgICAvLyBjb3B5LW9uLXdyaXRlLCBubyB3YXkgZm9yIHJlY29yZGVycyB0byBzZWUgdGhlIHJhdyB2YWx1ZSkuXG4gICAgbGV0IGZpbmFsUGF5bG9hZDogdW5rbm93biA9IHBheWxvYWQ7XG4gICAgY29uc3QgcGF0dGVybnMgPSB0aGlzLl9yZWRhY3Rpb25Qb2xpY3k/LmVtaXRQYXR0ZXJucztcbiAgICBpZiAocGF0dGVybnMgJiYgcGF0dGVybnMubGVuZ3RoID4gMCkge1xuICAgICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgICAgIGlmIChwYXR0ZXJuLnRlc3QobmFtZSkpIHtcbiAgICAgICAgICBmaW5hbFBheWxvYWQgPSAnW1JFREFDVEVEXSc7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBCdWlsZCB0aGUgZW5yaWNoZWQgZXZlbnQgb25jZTsgcGFzcyB0aGUgc2FtZSByZWZlcmVuY2UgdG8gYWxsXG4gICAgLy8gcmVjb3JkZXJzLiBTaW5jZSBFbWl0RXZlbnQgaXMgYHJlYWRvbmx5YCwgc2hhcmluZyBpcyBzYWZlLlxuICAgIGNvbnN0IGV2ZW50ID0ge1xuICAgICAgbmFtZSxcbiAgICAgIHBheWxvYWQ6IGZpbmFsUGF5bG9hZCxcbiAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dQYXRoOiB0aGlzLl9nZXRTdWJmbG93UGF0aCgpLFxuICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgIH0gYXMgY29uc3Q7XG5cbiAgICAvLyBEaXNwYXRjaCB3aXRoIGVycm9yIGlzb2xhdGlvbiDigJQgc2FtZSBwYXR0ZXJuIGFzIF9pbnZva2VIb29rIHVzZXMgZm9yXG4gICAgLy8gb3RoZXIgc2NvcGUgZXZlbnRzLiBBIHRocm93aW5nIHJlY29yZGVyJ3MgZXJyb3IgaXMgc3VyZmFjZWQgdmlhXG4gICAgLy8gb25FcnJvciBvbiB0aGUgb3RoZXIgcmVjb3JkZXJzOyB0aGUgZW1pdCBsb29wIGNvbnRpbnVlcyB1bmFmZmVjdGVkLlxuICAgIGZvciAoY29uc3QgcmVjb3JkZXIgb2YgdGhpcy5fcmVjb3JkZXJzKSB7XG4gICAgICBpZiAodHlwZW9mIHJlY29yZGVyLm9uRW1pdCAhPT0gJ2Z1bmN0aW9uJykgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBTaGFyZWQgaW52b2tlIGhlbHBlciDigJQgdGhlIFNBTUUgcHJpbWl0aXZlIHRoZSBkZWZlcnJlZCB0aWVyIHVzZXNcbiAgICAgICAgLy8gYXQgZGVsaXZlcnkgdGltZSwgc28gdGhlIHR3byBkZWxpdmVyeSBwYXRocyBjYW5ub3QgZHJpZnQuXG4gICAgICAgIGludm9rZVJlY29yZGVySG9vayhyZWNvcmRlciwgJ29uRW1pdCcsIGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRoaXMuX2ludm9rZUhvb2soJ29uRXJyb3InLCB7XG4gICAgICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICAgICAgc3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnN0YWdlSWQsXG4gICAgICAgICAgcnVudGltZVN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgIGVycm9yOiBlcnJvciBhcyBFcnJvcixcbiAgICAgICAgICBvcGVyYXRpb246ICd3cml0ZScsXG4gICAgICAgICAgY2hhbm5lbDogJ3Njb3BlJyBhcyBjb25zdCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIERldGFjaCDigJQgZmlyZS1hbmQtZm9yZ2V0IGNoaWxkIGZsb3djaGFydCBleGVjdXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vXG4gIC8vIERlbGVnYXRlcyB0byB0aGUgc2hhcmVkIGBkZXRhY2gvc3Bhd25gIGhlbHBlciwgd2hpY2ggbWludHMgYSByZWZJZFxuICAvLyBmcm9tIHRoaXMgc3RhZ2UncyBgcnVudGltZVN0YWdlSWRgIGFuZCBjYWxscyBgZHJpdmVyLnNjaGVkdWxlKClgLlxuICAvLyBSb3V0ZWQgdGhyb3VnaCBgY3JlYXRlVHlwZWRTY29wZWAgYXMgYHNjb3BlLiRkZXRhY2hBbmRKb2luTGF0ZXIoLi4uKWBcbiAgLy8gYW5kIGBzY29wZS4kZGV0YWNoQW5kRm9yZ2V0KC4uLilgLlxuXG4gIC8qKiBTZWUgYFNjb3BlTWV0aG9kcy4kZGV0YWNoQW5kSm9pbkxhdGVyYC4gKi9cbiAgZGV0YWNoQW5kSm9pbkxhdGVyKFxuICAgIGRyaXZlcjogaW1wb3J0KCcuLi9kZXRhY2gvdHlwZXMuanMnKS5EZXRhY2hEcml2ZXIsXG4gICAgY2hpbGQ6IGltcG9ydCgnLi4vYnVpbGRlci90eXBlcy5qcycpLkZsb3dDaGFydCxcbiAgICBpbnB1dD86IHVua25vd24sXG4gICk6IGltcG9ydCgnLi4vZGV0YWNoL3R5cGVzLmpzJykuRGV0YWNoSGFuZGxlIHtcbiAgICByZXR1cm4gZGV0YWNoQW5kSm9pbkxhdGVyU3Bhd24oZHJpdmVyLCBjaGlsZCwgaW5wdXQsIHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZCk7XG4gIH1cblxuICAvKiogU2VlIGBTY29wZU1ldGhvZHMuJGRldGFjaEFuZEZvcmdldGAuICovXG4gIGRldGFjaEFuZEZvcmdldChcbiAgICBkcml2ZXI6IGltcG9ydCgnLi4vZGV0YWNoL3R5cGVzLmpzJykuRGV0YWNoRHJpdmVyLFxuICAgIGNoaWxkOiBpbXBvcnQoJy4uL2J1aWxkZXIvdHlwZXMuanMnKS5GbG93Q2hhcnQsXG4gICAgaW5wdXQ/OiB1bmtub3duLFxuICApOiB2b2lkIHtcbiAgICBkZXRhY2hBbmRGb3JnZXRTcGF3bihkcml2ZXIsIGNoaWxkLCBpbnB1dCwgdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bnRpbWVTdGFnZUlkKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZCB0aGUgc3ViZmxvd1BhdGggKG91dGVyIOKGkiBpbm5lcikgZm9yIGV2ZW50IGVucmljaG1lbnQuXG4gICAqXG4gICAqIFBhcnNlcyBmcm9tIGBydW50aW1lU3RhZ2VJZGAgd2hpY2ggaGFzIHRoZSBmb3JtYXRcbiAgICogYFtzdWJmbG93UGF0aC9dc3RhZ2VJZCNleGVjdXRpb25JbmRleGAgKHNlZSBgbGliL2VuZ2luZS9ydW50aW1lU3RhZ2VJZC50c2ApLlxuICAgKiBTdWJmbG93IGlzb2xhdGlvbiBwcmV2ZW50cyB3YWxraW5nIHRoZSBwYXJlbnQtY2hhaW4gYWNyb3NzIGJvdW5kYXJpZXMsXG4gICAqIHNvIHRoZSBydW50aW1lU3RhZ2VJZCDigJQgZ2xvYmFsbHkgdW5pcXVlLCBpbmNsdWRlcyBmdWxsIHBhdGgg4oCUIGlzIHRoZVxuICAgKiBjYW5vbmljYWwgc291cmNlIG9mIHRydXRoIGZvciB0aGUgc3ViZmxvdyBoaWVyYXJjaHkgYXQgZW1pdCB0aW1lLlxuICAgKlxuICAgKiBFeGFtcGxlczpcbiAgICogICAnc2VlZCMwJyAgICAgICAgICAgICAgICAg4oaSIFtdICAgICAgICAgICAgICAgICAgICAocm9vdClcbiAgICogICAnc2YtaW5uZXIvaW5uZXIjNScgICAgICAg4oaSIFsnc2YtaW5uZXInXVxuICAgKiAgICdzZi1hL3NmLWIvc3RhZ2UjMycgICAgICDihpIgWydzZi1hJywgJ3NmLWInXSAgICAgIChuZXN0ZWQpXG4gICAqL1xuICBwcml2YXRlIF9nZXRTdWJmbG93UGF0aCgpOiByZWFkb25seSBzdHJpbmdbXSB7XG4gICAgY29uc3QgcnRpZCA9IHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZDtcbiAgICBpZiAoIXJ0aWQpIHJldHVybiBTY29wZUZhY2FkZS5fRU1QVFlfU1VCRkxPV19QQVRIO1xuICAgIC8vIFN0cmlwIHRoZSB0cmFpbGluZyBgI2V4ZWN1dGlvbkluZGV4YCB0byBpc29sYXRlIHRoZSBwYXRoIHBvcnRpb24uXG4gICAgY29uc3QgaGFzaElkeCA9IHJ0aWQubGFzdEluZGV4T2YoJyMnKTtcbiAgICBjb25zdCBwYXRoUG9ydGlvbiA9IGhhc2hJZHggPj0gMCA/IHJ0aWQuc2xpY2UoMCwgaGFzaElkeCkgOiBydGlkO1xuICAgIC8vIHBhdGhQb3J0aW9uIGlzIG5vdyBgW3N1YmZsb3dQYXRoL11zdGFnZUlkYC4gU3BsaXQgb24gJy8nIGFuZCBkcm9wIHRoZVxuICAgIC8vIGxhc3Qgc2VnbWVudCAoc3RhZ2VJZCkg4oCUIHdoYXQgcmVtYWlucyBpcyB0aGUgc3ViZmxvdyBwYXRoLlxuICAgIGNvbnN0IHNlZ21lbnRzID0gcGF0aFBvcnRpb24uc3BsaXQoJy8nKTtcbiAgICBpZiAoc2VnbWVudHMubGVuZ3RoIDw9IDEpIHJldHVybiBTY29wZUZhY2FkZS5fRU1QVFlfU1VCRkxPV19QQVRIO1xuICAgIHJldHVybiBPYmplY3QuZnJlZXplKHNlZ21lbnRzLnNsaWNlKDAsIC0xKSk7XG4gIH1cblxuICAvLyDilIDilIAgTm9uLVRyYWNraW5nIFN0YXRlIEluc3BlY3Rpb24gKGZvciBUeXBlZFNjb3BlIHByb3h5IGludGVybmFscykg4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIFJldHVybnMgYWxsIHN0YXRlIGtleXMgd2l0aG91dCBmaXJpbmcgb25SZWFkLiBVc2VkIGJ5IFR5cGVkU2NvcGUgb3duS2V5cy9oYXMgdHJhcHMuICovXG4gIGdldFN0YXRlS2V5cygpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgc25hcHNob3QgPSB0aGlzLl9zdGFnZUNvbnRleHQuZ2V0VmFsdWUoW10sIHVuZGVmaW5lZCk7XG4gICAgaWYgKCFzbmFwc2hvdCB8fCB0eXBlb2Ygc25hcHNob3QgIT09ICdvYmplY3QnKSByZXR1cm4gW107XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHNuYXBzaG90IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgfVxuXG4gIC8qKiBDaGVjayBrZXkgZXhpc3RlbmNlIHdpdGhvdXQgZmlyaW5nIG9uUmVhZC4gVXNlZCBieSBUeXBlZFNjb3BlIGhhcyB0cmFwLlxuICAgKiAgQ29udHJhY3Q6IHJldHVybnMgZmFsc2UgZm9yIGtleXMgbmV2ZXIgc2V0IE9SIGtleXMgc2V0IHRvIHVuZGVmaW5lZC5cbiAgICogIFRoaXMgbWF0Y2hlcyBkZWxldGVWYWx1ZSgpIHNlbWFudGljcyAoc2V0cyB0byB1bmRlZmluZWQgPSBkZWxldGVkKS4gKi9cbiAgaGFzS2V5KGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5nZXRWYWx1ZShbXSwga2V5KSAhPT0gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIFJlYWQgc3RhdGUgd2l0aG91dCBmaXJpbmcgb25SZWFkLiBVc2VkIGJ5IGFycmF5IHByb3h5IGdldEN1cnJlbnQoKSB0byBhdm9pZFxuICAgKiAgcGhhbnRvbSByZWFkcyBvbiBpbnRlcm5hbCBhcnJheSBvcGVyYXRpb25zICgubGVuZ3RoLCAuaGFzLCBpdGVyYXRpb24sIGV0Yy4pLlxuICAgKiAgVGhlIGluaXRpYWwgcHJvcGVydHkgYWNjZXNzIGZpcmVzIG9uZSB0cmFja2VkIG9uUmVhZCB2aWEgZ2V0VmFsdWUoKTsgc3Vic2VxdWVudFxuICAgKiAgaW50ZXJuYWwgYXJyYXkgb3BlcmF0aW9ucyB1c2UgdGhpcyBtZXRob2QgdG8gc3RheSBzaWxlbnQuXG4gICAqICBOT1RFOiBMaWtlIGdldFZhbHVlKCksIHJldHVybnMgdGhlIHJhdyB2YWx1ZSB0byB0aGUgY2FsbGVyLiBSZWRhY3Rpb24gYXBwbGllc1xuICAgKiAgb25seSB0byByZWNvcmRlciBkaXNwYXRjaCDigJQgaXQgZG9lcyBub3QgZmlsdGVyIHRoZSByZXR1cm5lZCB2YWx1ZS4gVGhpcyBtYXRjaGVzXG4gICAqICB0aGUgZXhpc3RpbmcgZ2V0VmFsdWUoKSBjb250cmFjdCB3aGVyZSB1c2VyIGNvZGUgYWx3YXlzIHJlY2VpdmVzIHJhdyBkYXRhLlxuICAgKlxuICAgKiAgUkZDLTAwMyBEMjogYSBzaWxlbnQgcmVhZCBvZiBhIGtleSB0aGlzIHN0YWdlIG5ldmVyIFRSQUNLRUQtcmVhZCBtYXJrc1xuICAgKiAgdGhlIHN0YWdlJ3MgY29tbWl0IHdpdGggYHVudHJhY2tlZFNvdXJjZXM6IFsnc2lsZW50J11gIOKAlCBhIGNhdXNhbCBzbGljZVxuICAgKiAgYnVpbHQgZnJvbSBvblJlYWQgZXZlbnRzIHdvdWxkIG1pc3MgdGhpcyBkZXBlbmRlbmN5LCBhbmQgY29uc3VtZXJzIG11c3RcbiAgICogIGJlIHRvbGQuIFNpbGVudCByZWFkcyBzaGFkb3dlZCBieSBhIHRyYWNrZWQgcmVhZCBvZiB0aGUgc2FtZSBrZXkgKHRoZVxuICAgKiAgYXJyYXktcHJveHkgcGF0dGVybiBhYm92ZSkgYXJlIG5vdCBmbGFnZ2VkOiB0aGVpciBlZGdlIGlzIGNhcHR1cmVkLiBBXG4gICAqICB3aG9sZS1zdGF0ZSBzaWxlbnQgcmVhZCAobm8ga2V5KSBpcyBhbHdheXMgZmxhZ2dlZC4gKi9cbiAgZ2V0VmFsdWVTaWxlbnQoa2V5Pzogc3RyaW5nKTogdW5rbm93biB7XG4gICAgaWYgKGtleSA9PT0gdW5kZWZpbmVkIHx8ICF0aGlzLl90cmFja2VkUmVhZEtleXMuaGFzKGtleSkpIHtcbiAgICAgIHRoaXMuX3N0YWdlQ29udGV4dC5tYXJrVW50cmFja2VkU291cmNlKCdzaWxlbnQnKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5nZXRWYWx1ZURpcmVjdChbXSwga2V5KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBTdGF0ZSBBY2Nlc3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgZ2V0SW5pdGlhbFZhbHVlRm9yKGtleTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5nZXRHbG9iYWw/LihrZXkpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRyYWNrZWQgcmVhZCBvZiBzaGFyZWQgc3RhdGUuXG4gICAqXG4gICAqICoqUmVhZCB2YWx1ZXMgYXJlIEJPUlJPV0VEIOKAlCBkbyBub3QgbXV0YXRlIHRoZW0uKiogU2luY2UgdGhlIGxhenkgYnVmZmVyXG4gICAqICgjMTMpLCByZWFkcyBiZWZvcmUgdGhlIHN0YWdlJ3MgZmlyc3Qgd3JpdGUgcmV0dXJuIHJlZmVyZW5jZXMgSU5UT1xuICAgKiBDT01NSVRURUQgU0hBUkVEIFNUQVRFLCBhbmQgcmVhZHMgYWZ0ZXIgYSB3cml0ZSByZXR1cm4gcmVmZXJlbmNlcyBpbnRvXG4gICAqIHRoZSBzdGFnZSdzIHByaXZhdGUgdHJhbnNhY3Rpb24tYnVmZmVyIHdvcmtpbmcgY29weSAodGhlIGVhZ2VyIGVuZ2luZVxuICAgKiByZXR1cm5lZCByZWZlcmVuY2VzIGludG8gdGhhdCB3b3JraW5nIGNvcHkgZm9yIEFMTCByZWFkcykuIE11dGF0aW5nIGFcbiAgICogcmV0dXJuZWQgdmFsdWUgaW4gcGxhY2Ugd291bGQgY29ycnVwdCBzdGF0ZSB3aXRob3V0IGEgY29tbWl0IHJlY29yZCDigJRcbiAgICogd3JpdGUgY2hhbmdlcyBiYWNrIHZpYSBgc2V0VmFsdWVgL2B1cGRhdGVWYWx1ZWAgaW5zdGVhZC4gVHlwZWRTY29wZVxuICAgKiBjb25zdW1lcnMgYXJlIHNhZmUgYXV0b21hdGljYWxseTogdGhlIHByb3h5IHJvdXRlcyBldmVyeSBtdXRhdGlvblxuICAgKiB0aHJvdWdoIGBzZXRWYWx1ZWAvYHVwZGF0ZVZhbHVlYC9jb3B5LW9uLXdyaXRlIGFycmF5IG9wcy5cbiAgICpcbiAgICogVGhlcmUgaXMgZGVsaWJlcmF0ZWx5IE5PIGRldi1tb2RlIGZyZWV6ZSBndWFyZCBoZXJlOiBkZWVwLWZyZWV6aW5nIGFcbiAgICogYnVmZmVyLXNlcnZlZCByZWFkIHdvdWxkIGZyZWV6ZSB0aGUgc3RhZ2UncyBvd24gd29ya2luZyBjb3B5IGFuZCBtYWtlIGFcbiAgICogbGVnaXRpbWF0ZSByZWFkLXRoZW4tZGVlcC13cml0ZSB0aHJvdywgYW5kIGZyZWV6aW5nIGEgY29tbWl0dGVkLXN0YXRlXG4gICAqIHJlYWQgbXV0YXRlcyBhbiBvYmplY3Qgc2hhcmVkIHdpdGggZXZlcnkgb3RoZXIgY29uc3VtZXIgb2YgdGhlIGxpdmVcbiAgICogc3RhdGUuIFNlZSBgc3JjL2xpYi9tZW1vcnkvUkVBRE1FLm1kYCAoXCJSZWFkIHZhbHVlcyBhcmUgYm9ycm93ZWRcIikuXG4gICAqXG4gICAqIFJlY29yZGVyIG5vdGU6IHRoZSBgb25SZWFkYCBldmVudCBiZWxvdyBwYXNzZXMgdGhlIFNBTUUgbGl2ZSByZWZlcmVuY2VcbiAgICogKG5vIGNsb25lKSB1bmxlc3MgZmllbGQtbGV2ZWwgcmVkYWN0aW9uIHNjcnVicyBhIGNvcHkg4oCUIHJlY29yZGVycyBtdXN0XG4gICAqIHRyZWF0IGV2ZW50IHZhbHVlcyBhcyByZWFkLW9ubHkgdG9vLlxuICAgKi9cbiAgZ2V0VmFsdWUoa2V5Pzogc3RyaW5nKSB7XG4gICAgY29uc3QgdmFsdWUgPSB0aGlzLl9zdGFnZUNvbnRleHQuZ2V0VmFsdWUoW10sIGtleSk7XG5cbiAgICAvLyBSRkMtMDAzIEQyOiByZW1lbWJlciB0cmFja2VkIGtleXMgc28gbGF0ZXIgU0lMRU5UIHJlYWRzIG9mIHRoZSBzYW1lXG4gICAgLy8ga2V5IGNvdW50IGFzIHNoYWRvd2VkIChlZGdlIGFscmVhZHkgY2FwdHVyZWQpIGluc3RlYWQgb2YgdW50cmFja2VkLlxuICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCkgdGhpcy5fdHJhY2tlZFJlYWRLZXlzLmFkZChrZXkpO1xuXG4gICAgaWYgKHRoaXMuX3JlY29yZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBpc1JlZGFjdGVkID0ga2V5ICE9PSB1bmRlZmluZWQgJiYgdGhpcy5faXNLZXlSZWRhY3RlZChrZXkpO1xuICAgICAgY29uc3QgZmllbGRTZXQgPSBrZXkgIT09IHVuZGVmaW5lZCA/IHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkuZ2V0KGtleSkgOiB1bmRlZmluZWQ7XG5cbiAgICAgIGxldCByZWNvcmRlclZhbHVlOiB1bmtub3duO1xuICAgICAgaWYgKGlzUmVkYWN0ZWQpIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9ICdbUkVEQUNURURdJztcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRTZXQgJiYgdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gdGhpcy5fc2NydWJGaWVsZHModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGZpZWxkU2V0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5faW52b2tlSG9vaygnb25SZWFkJywge1xuICAgICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgICAgc3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnN0YWdlSWQsXG4gICAgICAgIHJ1bnRpbWVTdGFnZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVudGltZVN0YWdlSWQsXG4gICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICBrZXksXG4gICAgICAgIHZhbHVlOiByZWNvcmRlclZhbHVlLFxuICAgICAgICByZWRhY3RlZDogaXNSZWRhY3RlZCB8fCBmaWVsZFNldCAhPT0gdW5kZWZpbmVkIHx8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuXG4gIHNldFZhbHVlKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgc2hvdWxkUmVkYWN0PzogYm9vbGVhbiwgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICBhc3NlcnROb3RSZWFkb25seSh0aGlzLl9yZWFkT25seVZhbHVlcywga2V5LCAnd3JpdGUnKTtcblxuICAgIC8vIERldi1tb2RlOiB3YXJuIGlmIHRoZSB2YWx1ZSBjb250YWlucyBjaXJjdWxhciByZWZlcmVuY2VzLlxuICAgIC8vIENoZWNrIEFGVEVSIGFzc2VydE5vdFJlYWRvbmx5IOKAlCBkb24ndCB3YXJuIGZvciB3cml0ZXMgdGhhdCB3aWxsIGJlIGJsb2NrZWQuXG4gICAgLy8gQ2lyY3VsYXIgdmFsdWVzIHdvcmsgKHRlcm1pbmFsIHByb3h5IGhhbmRsZXMgdGhlbSkgYnV0IGNhbiBwcm9kdWNlXG4gICAgLy8gc3VycHJpc2luZyBiZWhhdmlvciBpbiBuYXJyYXRpdmUsIEpTT04gc2VyaWFsaXphdGlvbiwgYW5kIHNuYXBzaG90cy5cbiAgICBpZiAoaXNEZXZNb2RlKCkgJiYgdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgaWYgKGhhc0NpcmN1bGFyUmVmZXJlbmNlKHZhbHVlKSkge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFtmb290cHJpbnRdIENpcmN1bGFyIHJlZmVyZW5jZSBkZXRlY3RlZCBpbiBzZXRWYWx1ZSgnJHtrZXl9JykuIGAgK1xuICAgICAgICAgICAgJ1dyaXRlcyBwYXN0IHRoZSBjeWNsZSBkZXB0aCB3aWxsIHVzZSB0ZXJtaW5hbCBwcm94eSB0cmFja2luZy4gJyArXG4gICAgICAgICAgICAnQ29uc2lkZXIgZmxhdHRlbmluZyB0aGUgZGF0YSBzdHJ1Y3R1cmUuJyxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBBdXRvLXJlZGFjdCBpZiBrZXkgbWF0Y2hlcyBwb2xpY3kgKGV4YWN0IGtleXMgb3IgcGF0dGVybnMpLCBvciBpZiB0aGUga2V5IHdhc1xuICAgIC8vIHByZXZpb3VzbHkgbWFya2VkIHJlZGFjdGVkIChlLmcuIGNhcnJpZWQgb3ZlciBmcm9tIGEgc3ViZmxvdyB2aWEgb3V0cHV0TWFwcGVyKS5cbiAgICBjb25zdCBlZmZlY3RpdmVSZWRhY3QgPSBzaG91bGRSZWRhY3QgfHwgdGhpcy5faXNQb2xpY3lSZWRhY3RlZChrZXkpIHx8IHRoaXMuX3JlZGFjdGVkS2V5cy5oYXMoa2V5KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX3N0YWdlQ29udGV4dC5zZXRPYmplY3QoW10sIGtleSwgdmFsdWUsIGVmZmVjdGl2ZVJlZGFjdCwgZGVzY3JpcHRpb24pO1xuXG4gICAgaWYgKGVmZmVjdGl2ZVJlZGFjdCkge1xuICAgICAgdGhpcy5fcmVkYWN0ZWRLZXlzLmFkZChrZXkpO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBmaWVsZC1sZXZlbCByZWRhY3Rpb24gZnJvbSBwb2xpY3lcbiAgICBjb25zdCBmaWVsZFNldCA9IHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkuZ2V0KGtleSk7XG5cbiAgICBpZiAodGhpcy5fcmVjb3JkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxldCByZWNvcmRlclZhbHVlOiB1bmtub3duO1xuICAgICAgaWYgKGVmZmVjdGl2ZVJlZGFjdCkge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gJ1tSRURBQ1RFRF0nO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFNldCAmJiB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSB0aGlzLl9zY3J1YkZpZWxkcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZmllbGRTZXQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHZhbHVlO1xuICAgICAgfVxuXG4gICAgICB0aGlzLl9pbnZva2VIb29rKCdvbldyaXRlJywge1xuICAgICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgICAgc3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnN0YWdlSWQsXG4gICAgICAgIHJ1bnRpbWVTdGFnZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVudGltZVN0YWdlSWQsXG4gICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICBrZXksXG4gICAgICAgIHZhbHVlOiByZWNvcmRlclZhbHVlLFxuICAgICAgICBvcGVyYXRpb246ICdzZXQnLFxuICAgICAgICByZWRhY3RlZDogZWZmZWN0aXZlUmVkYWN0IHx8IGZpZWxkU2V0ICE9PSB1bmRlZmluZWQgfHwgdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIHVwZGF0ZVZhbHVlKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICBhc3NlcnROb3RSZWFkb25seSh0aGlzLl9yZWFkT25seVZhbHVlcywga2V5LCAnd3JpdGUnKTtcblxuICAgIC8vIERldi1tb2RlOiBzYW1lIGNpcmN1bGFyIGNoZWNrIGFzIHNldFZhbHVlIChtZXJnZSB0YXJnZXRzIGNhbiBiZSBjaXJjdWxhciB0b28pXG4gICAgaWYgKGlzRGV2TW9kZSgpICYmIHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGlmIChoYXNDaXJjdWxhclJlZmVyZW5jZSh2YWx1ZSkpIHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBbZm9vdHByaW50XSBDaXJjdWxhciByZWZlcmVuY2UgZGV0ZWN0ZWQgaW4gdXBkYXRlVmFsdWUoJyR7a2V5fScpLiBgICtcbiAgICAgICAgICAgICdDb25zaWRlciBmbGF0dGVuaW5nIHRoZSBkYXRhIHN0cnVjdHVyZS4nLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGlzUmVkYWN0ZWQgPSB0aGlzLl9pc0tleVJlZGFjdGVkKGtleSkgfHwgdGhpcy5faXNQb2xpY3lSZWRhY3RlZChrZXkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX3N0YWdlQ29udGV4dC51cGRhdGVPYmplY3QoW10sIGtleSwgdmFsdWUsIGRlc2NyaXB0aW9uLCBpc1JlZGFjdGVkKTtcblxuICAgIGlmICh0aGlzLl9yZWNvcmRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgZmllbGRTZXQgPSB0aGlzLl9yZWRhY3RlZEZpZWxkc0J5S2V5LmdldChrZXkpO1xuXG4gICAgICBsZXQgcmVjb3JkZXJWYWx1ZTogdW5rbm93bjtcbiAgICAgIGlmIChpc1JlZGFjdGVkKSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSAnW1JFREFDVEVEXSc7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkU2V0ICYmIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHRoaXMuX3NjcnViRmllbGRzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBmaWVsZFNldCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gdmFsdWU7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2ludm9rZUhvb2soJ29uV3JpdGUnLCB7XG4gICAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgICBzdGFnZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQuc3RhZ2VJZCxcbiAgICAgICAgcnVudGltZVN0YWdlSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW50aW1lU3RhZ2VJZCxcbiAgICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgIGtleSxcbiAgICAgICAgdmFsdWU6IHJlY29yZGVyVmFsdWUsXG4gICAgICAgIG9wZXJhdGlvbjogJ3VwZGF0ZScsXG4gICAgICAgIHJlZGFjdGVkOiBpc1JlZGFjdGVkIHx8IGZpZWxkU2V0ICE9PSB1bmRlZmluZWQgfHwgdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIGRlbGV0ZVZhbHVlKGtleTogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZykge1xuICAgIGFzc2VydE5vdFJlYWRvbmx5KHRoaXMuX3JlYWRPbmx5VmFsdWVzLCBrZXksICdkZWxldGUnKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX3N0YWdlQ29udGV4dC5zZXRPYmplY3QoW10sIGtleSwgdW5kZWZpbmVkLCBmYWxzZSwgZGVzY3JpcHRpb24gPz8gYGRlbGV0ZWQgJHtrZXl9YCwgJ2RlbGV0ZScpO1xuXG4gICAgLy8gRGVsZXRpbmcgYSByZWRhY3RlZCBrZXkgY2xlYXJzIGl0cyByZWRhY3Rpb24gc3RhdHVzXG4gICAgdGhpcy5fcmVkYWN0ZWRLZXlzLmRlbGV0ZShrZXkpO1xuXG4gICAgaWYgKHRoaXMuX3JlY29yZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLl9pbnZva2VIb29rKCdvbldyaXRlJywge1xuICAgICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgICAgc3RhZ2VJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnN0YWdlSWQsXG4gICAgICAgIHJ1bnRpbWVTdGFnZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVudGltZVN0YWdlSWQsXG4gICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICBrZXksXG4gICAgICAgIHZhbHVlOiB1bmRlZmluZWQsXG4gICAgICAgIG9wZXJhdGlvbjogJ2RlbGV0ZScsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBzZXRHbG9iYWwoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBkZXNjcmlwdGlvbj86IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9zdGFnZUNvbnRleHQuc2V0R2xvYmFsPy4oa2V5LCB2YWx1ZSwgZGVzY3JpcHRpb24pO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRHbG9iYWwoa2V5OiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VDb250ZXh0LmdldEdsb2JhbD8uKGtleSk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIHNldE9iamVjdEluUm9vdChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VDb250ZXh0LnNldFJvb3Q/LihrZXksIHZhbHVlKTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBSZWFkLW9ubHkgKyBtaXNjIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSByZWFkb25seSBpbnB1dCB2YWx1ZXMgcGFzc2VkIHRvIHRoaXMgcGlwZWxpbmUsIGNhc3QgdG8gYFRgLlxuICAgKiBUaGUgcmV0dXJuZWQgb2JqZWN0IGlzIGRlZXBseSBmcm96ZW4g4oCUIGFueSBhdHRlbXB0IHRvIG11dGF0ZSBpdCB0aHJvd3MuXG4gICAqIENhY2hlZCBhdCBjb25zdHJ1Y3Rpb24gdGltZSBmb3IgemVyby1hbGxvY2F0aW9uIHJlcGVhdGVkIGFjY2Vzcy5cbiAgICpcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBjb25zdCB7IGFwcGxpY2FudE5hbWUsIGluY29tZSB9ID0gc2NvcGUuZ2V0QXJnczx7IGFwcGxpY2FudE5hbWU6IHN0cmluZzsgaW5jb21lOiBudW1iZXIgfT4oKTtcbiAgICogYGBgXG4gICAqXG4gICAqIFJGQy0wMDMgRDI6IGFyZ3MgYXJlIHVudHJhY2tlZCBCWSBERVNJR04sIHNvIGNhbGxpbmcgdGhpcyAod2l0aCBhY3R1YWxcbiAgICogaW5wdXQgcHJlc2VudCkgbWFya3MgdGhlIHN0YWdlJ3MgY29tbWl0IHdpdGggYHVudHJhY2tlZFNvdXJjZXM6IFsnYXJncyddYFxuICAgKiDigJQgdGVsbGluZyBjYXVzYWwtc2xpY2UgY29uc3VtZXJzIHRoZSBiYWNrd2FyZCBzbGljZSBtYXkgYmUgaW5jb21wbGV0ZVxuICAgKiBoZXJlLiBBbiBlbXB0eS1hcmdzIHJlYWQgY2FycmllcyBubyBpbmZvcm1hdGlvbiBhbmQgaXMgbm90IGZsYWdnZWQuXG4gICAqL1xuICBnZXRBcmdzPFQgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTogVCB7XG4gICAgaWYgKHRoaXMuX2hhc0FyZ3MpIHRoaXMuX3N0YWdlQ29udGV4dC5tYXJrVW50cmFja2VkU291cmNlKCdhcmdzJyk7XG4gICAgcmV0dXJuIHRoaXMuX2Zyb3plbkFyZ3MgYXMgVDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBleGVjdXRpb24gZW52aXJvbm1lbnQg4oCUIHJlYWQtb25seSBpbmZyYXN0cnVjdHVyZSB2YWx1ZXNcbiAgICogdGhhdCBwcm9wYWdhdGUgdGhyb3VnaCBuZXN0ZWQgZXhlY3V0b3JzIChsaWtlIGBwcm9jZXNzLmVudmAgZm9yIGZsb3djaGFydHMpLlxuICAgKlxuICAgKiBDb250YWluczogc2lnbmFsIChhYm9ydCksIHRpbWVvdXRNcywgdHJhY2VJZC5cbiAgICogRnJvemVuIGF0IGNvbnN0cnVjdGlvbiB0aW1lLiBJbmhlcml0ZWQgYnkgc3ViZmxvd3MgYXV0b21hdGljYWxseS5cbiAgICpcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBjb25zdCB7IHNpZ25hbCwgdHJhY2VJZCB9ID0gc2NvcGUuZ2V0RW52KCk7XG4gICAqIGBgYFxuICAgKlxuICAgKiBSRkMtMDAzIEQyOiBlbnYgaXMgdW50cmFja2VkIEJZIERFU0lHTiwgc28gY2FsbGluZyB0aGlzICh3aXRoIGFcbiAgICogbm9uLWVtcHR5IGVudmlyb25tZW50KSBtYXJrcyB0aGUgc3RhZ2UncyBjb21taXQgd2l0aFxuICAgKiBgdW50cmFja2VkU291cmNlczogWydlbnYnXWAg4oCUIHNlZSB7QGxpbmsgZ2V0QXJnc30uXG4gICAqL1xuICBnZXRFbnYoKTogUmVhZG9ubHk8RXhlY3V0aW9uRW52PiB7XG4gICAgaWYgKHRoaXMuX2hhc0VudikgdGhpcy5fc3RhZ2VDb250ZXh0Lm1hcmtVbnRyYWNrZWRTb3VyY2UoJ2VudicpO1xuICAgIHJldHVybiB0aGlzLl9leGVjdXRpb25FbnY7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIGdldFBpcGVsaW5lSWQoKSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBJbnRlcm5hbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQ2hlY2tzIGlmIGEga2V5IGlzIHJlZGFjdGVkIChleHBsaWNpdCBfcmVkYWN0ZWRLZXlzIHNldCkuICovXG4gIHByaXZhdGUgX2lzS2V5UmVkYWN0ZWQoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5fcmVkYWN0ZWRLZXlzLmhhcyhrZXkpO1xuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrcyBpZiBhIGtleSBzaG91bGQgYmUgYXV0by1yZWRhY3RlZCBieSB0aGUgcG9saWN5IChleGFjdCBrZXlzICsgcGF0dGVybnMpLlxuICAgKlxuICAgKiBSZURvUyBndWFyZDogcGF0dGVybiB0ZXN0aW5nIGlzIGNhcHBlZCBhdCBNQVhfUEFUVEVSTl9LRVlfTEVOIGNoYXJhY3RlcnMuXG4gICAqIFNjb3BlIHN0YXRlIGtleXMgYXJlIGFsd2F5cyBzaG9ydCBpZGVudGlmaWVyczsgYW55IGtleSBleGNlZWRpbmcgdGhlIGNhcFxuICAgKiBpcyBhbG1vc3QgY2VydGFpbmx5IG5vdCBhIGxlZ2l0aW1hdGUgc2NvcGUga2V5LCBzbyBza2lwcGluZyBwYXR0ZXJuIG1hdGNoaW5nXG4gICAqIGZvciBpdCBkb2VzIG5vdCByaXNrIGxlYWtpbmcgUElJLiBFeGFjdC1rZXkgbWF0Y2hpbmcgKEFycmF5LmluY2x1ZGVzKSBpc1xuICAgKiBzdGlsbCBhcHBsaWVkIHJlZ2FyZGxlc3Mgb2YgbGVuZ3RoIGFuZCBpcyBub3QgdnVsbmVyYWJsZSB0byBSZURvUy5cbiAgICovXG4gIHByaXZhdGUgX2lzUG9saWN5UmVkYWN0ZWQoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBpZiAoIXRoaXMuX3JlZGFjdGlvblBvbGljeSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh0aGlzLl9yZWRhY3Rpb25Qb2xpY3kua2V5cz8uaW5jbHVkZXMoa2V5KSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHRoaXMuX3JlZGFjdGlvblBvbGljeS5wYXR0ZXJucykge1xuICAgICAgaWYgKGtleS5sZW5ndGggPiBTY29wZUZhY2FkZS5fTUFYX1BBVFRFUk5fS0VZX0xFTikge1xuICAgICAgICAvLyBEZXYtbW9kZSB3YXJuaW5nOiBwYXR0ZXJuIG1hdGNoaW5nIHdhcyBzaWxlbnRseSBza2lwcGVkIGZvciB0aGlzIGtleS5cbiAgICAgICAgLy8gVXNlIHBvbGljeS5rZXlzIGZvciBleGFjdCBtYXRjaGluZyBvZiBsb25nIGtleSBuYW1lcy5cbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgICBgW2Zvb3RwcmludF0gUmVkYWN0aW9uUG9saWN5OiBrZXkgJyR7a2V5LnNsaWNlKDAsIDQwKX0uLi4nICgke2tleS5sZW5ndGh9IGNoYXJzKSBleGNlZWRzIGAgK1xuICAgICAgICAgICAgICAndGhlIHBhdHRlcm4tbWF0Y2hpbmcgbGVuZ3RoIGNhcCBhbmQgd2FzIHNraXBwZWQuICcgK1xuICAgICAgICAgICAgICAnVXNlIHBvbGljeS5rZXlzIGZvciBleGFjdCBtYXRjaGluZyBvZiBsb25nIGtleSBuYW1lcy4nLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZvciAoY29uc3QgcCBvZiB0aGlzLl9yZWRhY3Rpb25Qb2xpY3kucGF0dGVybnMpIHtcbiAgICAgICAgICBwLmxhc3RJbmRleCA9IDA7IC8vIFJlc2V0IHN0YXRlZnVsIGdsb2JhbC9zdGlja3kgcmVnZXhlc1xuICAgICAgICAgIGlmIChwLnRlc3Qoa2V5KSkgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLyoqXG4gICAqIE1heGltdW0ga2V5IGxlbmd0aCAoY2hhcmFjdGVycykgdGhhdCB3aWxsIGJlIHRlc3RlZCBhZ2FpbnN0IHJlZ2V4IHJlZGFjdGlvblxuICAgKiBwYXR0ZXJucy4gS2V5cyBsb25nZXIgdGhhbiB0aGlzIGFyZSBza2lwcGVkIGZvciBwYXR0ZXJuIG1hdGNoaW5nIHRvIHByZXZlbnRcbiAgICogUmVEb1M6IGEgcGF0aG9sb2dpY2FsIHJlZ2V4IHRlc3RlZCBhZ2FpbnN0IGFuIHVuYm91bmRlZGx5IGxvbmcga2V5IHN0cmluZ1xuICAgKiBjYW4gY2F1c2UgY2F0YXN0cm9waGljIGJhY2t0cmFja2luZy5cbiAgICpcbiAgICogMjU2IGNoYXJhY3RlcnMgY29tZm9ydGFibHkgZXhjZWVkcyBhbnkgcmVhbGlzdGljIHNjb3BlLXN0YXRlIGtleSBuYW1lLlxuICAgKi9cbiAgcHJpdmF0ZSBzdGF0aWMgcmVhZG9ubHkgX01BWF9QQVRURVJOX0tFWV9MRU4gPSAyNTY7XG5cbiAgLyoqXG4gICAqIFJldHVybnMgYSBkZWVwLWNsb25lZCBjb3B5IHdpdGggc3BlY2lmaWVkIGZpZWxkcyByZXBsYWNlZCBieSAnW1JFREFDVEVEXScuXG4gICAqIFN1cHBvcnRzIGRvdC1ub3RhdGlvbiBwYXRocyAoZS5nLiAnYWRkcmVzcy56aXAnKSBmb3IgbmVzdGVkIG9iamVjdHMuXG4gICAqL1xuICBwcml2YXRlIF9zY3J1YkZpZWxkcyhvYmo6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBmaWVsZHM6IFNldDxzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGNvcHkgPSBzdHJ1Y3R1cmVkQ2xvbmUob2JqKTtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGZpZWxkcykge1xuICAgICAgaWYgKGZpZWxkLmluY2x1ZGVzKCcuJykgJiYgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChjb3B5LCBmaWVsZCkpIHtcbiAgICAgICAgLy8gRG90LW5vdGF0aW9uIHBhdGgg4oaSIGRlZXAgc2NydWIgKG9ubHkgaWYgbm90IGEgbGl0ZXJhbCBmbGF0IGtleSlcbiAgICAgICAgaWYgKGxvZGFzaEhhcyhjb3B5LCBmaWVsZCkpIHtcbiAgICAgICAgICBsb2Rhc2hTZXQoY29weSwgZmllbGQsICdbUkVEQUNURURdJyk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoY29weSwgZmllbGQpKSB7XG4gICAgICAgICAgY29weVtmaWVsZF0gPSAnW1JFREFDVEVEXSc7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGNvcHk7XG4gIH1cblxuICBwcml2YXRlIF9pbnZva2VIb29rKGhvb2s6IGtleW9mIE9taXQ8U2NvcGVSZWNvcmRlciwgJ2lkJz4sIGV2ZW50OiB1bmtub3duKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCByZWNvcmRlciBvZiB0aGlzLl9yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIFNoYXJlZCBpbnZva2UgaGVscGVyIOKAlCB0aGUgU0FNRSBwcmltaXRpdmUgdGhlIGRlZmVycmVkIHRpZXIgdXNlc1xuICAgICAgICAvLyBhdCBkZWxpdmVyeSB0aW1lIChSRkMtMDAxIMKnOSBtaXRpZ2F0aW9uKTogbG9va3VwICsgYC5jYWxsKHRoaXMpYFxuICAgICAgICAvLyBzZW1hbnRpY3MgbGl2ZSBpbiBleGFjdGx5IG9uZSBwbGFjZSwgc28gdGhlIGlubGluZSBhbmQgZGVmZXJyZWRcbiAgICAgICAgLy8gcGF0aHMgY2Fubm90IGRyaWZ0LlxuICAgICAgICBpbnZva2VSZWNvcmRlckhvb2socmVjb3JkZXIsIGhvb2ssIGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChob29rICE9PSAnb25FcnJvcicpIHtcbiAgICAgICAgICB0aGlzLl9pbnZva2VIb29rKCdvbkVycm9yJywge1xuICAgICAgICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICAgICAgICBzdGFnZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQuc3RhZ2VJZCxcbiAgICAgICAgICAgIHJ1bnRpbWVTdGFnZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVudGltZVN0YWdlSWQsXG4gICAgICAgICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgICAgICBlcnJvcjogZXJyb3IgYXMgRXJyb3IsXG4gICAgICAgICAgICBvcGVyYXRpb246IGhvb2sgPT09ICdvblJlYWQnID8gJ3JlYWQnIDogaG9vayA9PT0gJ29uQ29tbWl0JyA/ICdjb21taXQnIDogJ3dyaXRlJyxcbiAgICAgICAgICAgIGNoYW5uZWw6ICdzY29wZScgYXMgY29uc3QsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiJdfQ==