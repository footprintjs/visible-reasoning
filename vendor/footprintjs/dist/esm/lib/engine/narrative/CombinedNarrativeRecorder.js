/**
 * CombinedNarrativeRecorder — Inline narrative builder that merges flow + data during traversal.
 *
 * Composes a SequenceStore<CombinedNarrativeEntry> for dual-indexed storage (ordered sequence
 * + O(1) per-step lookup by runtimeStageId) — Convention 1, one purpose per recorder.
 * Implements `CombinedRecorder` — the library's first-class abstraction for observers that span
 * both data-flow and control-flow streams.
 *
 * Event ordering guarantees this works:
 *   1. Scope events (onRead, onWrite) fire DURING stage execution
 *   2. Flow events (onStageExecuted, onDecision) fire AFTER stage execution
 *   3. Both carry the same `stageName` — no matching ambiguity
 *
 * So we buffer scope ops per-stage, then when the flow event arrives,
 * emit the stage entry + flush the buffered ops in one pass.
 */
import { isFlowEvent } from '../../recorder/CombinedRecorder.js';
import { SequenceStore } from '../../recorder/SequenceStore.js';
import { summarizeValue } from '../../scope/recorders/summarizeValue.js';
// ── ScopeRecorder ───────────────────────────────────────────────────────────────
/**
 * Implements `CombinedRecorder` — the library's first-class abstraction for
 * observers that span both data-flow (`ScopeRecorder`) and control-flow
 * (`FlowRecorder`) streams. One `id`, routed to both channels via
 * `executor.attachCombinedRecorder(...)` (or equivalently via
 * `executor.enableNarrative(...)` which auto-creates an instance).
 *
 * For shared-method-name events (`onError`, `onPause`, `onResume`) the
 * handler accepts the union payload type; we discriminate via `isFlowEvent`.
 * Scope variants of these events are deliberately ignored here — the
 * narrative only surfaces control-flow lifecycle events.
 */
export class CombinedNarrativeRecorder {
    id;
    /** Dual-indexed ordered storage (Convention 1 — composed, not inherited). */
    store = new SequenceStore();
    /**
     * Pending scope ops keyed by runtimeStageId. Flushed in onStageExecuted/onDecision.
     *
     * Keying by runtimeStageId (not stageName) ensures correctness when parallel fork
     * branches contain stages with the same name — each execution step has a unique ID.
     */
    pendingOps = new Map();
    /** Per-subflow stage counters. Key '' = root flow. */
    stageCounters = new Map();
    /** Per-subflow first-stage flags. Key '' = root flow. */
    firstStageFlags = new Map();
    /** Visit count per stageId — detects loop iterations (count > 1 = loop). */
    stageVisitCounts = new Map();
    includeStepNumbers;
    includeValues;
    maxValueLength;
    formatValue;
    renderer;
    constructor(options) {
        this.id = options?.id ?? 'combined-narrative';
        this.includeStepNumbers = options?.includeStepNumbers ?? true;
        this.includeValues = options?.includeValues ?? true;
        this.maxValueLength = options?.maxValueLength ?? 80;
        this.formatValue = options?.formatValue ?? summarizeValue;
        this.renderer = options?.renderer;
    }
    // ── Scope channel (fires first, during stage execution) ───────────────
    onRead(event) {
        if (!event.key)
            return;
        this.bufferOp(event.runtimeStageId, {
            type: 'read',
            key: event.key,
            rawValue: event.value,
        });
    }
    onWrite(event) {
        this.bufferOp(event.runtimeStageId, {
            type: 'write',
            key: event.key,
            rawValue: event.value,
            operation: event.operation,
        });
    }
    // ── Flow channel (fires after stage execution) ────────────────────────
    onStageExecuted(event) {
        // Non-linear kinds get their narrative entries (and ops flush)
        // from `onDecision` / `onFork` / `onSelected` / `onSubflowEntry`.
        // Skip them here so each stage has exactly one narrative entry.
        if (event.stageType !== 'linear')
            return;
        const stageId = event.traversalContext?.stageId;
        const runtimeStageId = event.traversalContext?.runtimeStageId;
        const sfKey = event.traversalContext?.subflowId ?? '';
        const stageNum = this.incrementStageCounter(sfKey);
        const isFirst = this.consumeFirstStageFlag(sfKey);
        // Track visit count per stageId to detect loop iterations
        const visitKey = stageId ?? event.stageName;
        const visitCount = (this.stageVisitCounts.get(visitKey) ?? 0) + 1;
        this.stageVisitCounts.set(visitKey, visitCount);
        const ctx = {
            stageName: event.stageName,
            stageNumber: stageNum,
            isFirst,
            description: event.description,
            loopIteration: visitCount > 1 ? visitCount - 1 : undefined,
        };
        const text = this.renderer?.renderStage?.(ctx) ?? this.defaultRenderStage(ctx);
        const sfId = event.traversalContext?.subflowId;
        this.store.push({
            type: 'stage',
            text,
            depth: 0,
            stageName: event.stageName,
            stageId,
            runtimeStageId,
            subflowId: sfId,
        });
        this.flushOps(runtimeStageId, sfId, stageId, event.stageName);
    }
    onDecision(event) {
        const stageId = event.traversalContext?.stageId;
        const runtimeStageId = event.traversalContext?.runtimeStageId;
        // Emit the decider stage entry.
        // Proposal #003 also fires `onStageExecuted(stageType: 'decider')`
        // AFTER this event, but CombinedNarrativeRecorder gates that
        // handler to LINEAR-only so this stays the single emission site
        // for the decider's stage entry + ops flush. Keeps narrative
        // output byte-stable across the v6 transition.
        const sfKey = event.traversalContext?.subflowId ?? '';
        const stageNum = this.incrementStageCounter(sfKey);
        const isFirst = this.consumeFirstStageFlag(sfKey);
        const stageCtx = {
            stageName: event.decider,
            stageNumber: stageNum,
            isFirst,
            description: event.description,
        };
        const stageText = this.renderer?.renderStage?.(stageCtx) ?? this.defaultRenderStage(stageCtx);
        this.store.push({
            type: 'stage',
            text: stageText,
            depth: 0,
            stageName: event.decider,
            stageId,
            runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
        this.flushOps(runtimeStageId, event.traversalContext?.subflowId, stageId, event.decider);
        // Emit the condition entry as a nested sub-item (depth 1) of the stage above.
        const decisionCtx = {
            decider: event.decider,
            chosen: event.chosen,
            description: event.description,
            rationale: event.rationale,
            evidence: event.evidence,
        };
        const conditionText = this.renderer?.renderDecision?.(decisionCtx) ?? this.defaultRenderDecision(decisionCtx);
        this.store.push({
            type: 'condition',
            text: conditionText,
            depth: 1,
            stageName: event.decider,
            stageId,
            runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    onNext() {
        // No-op. onStageExecuted already has the description for the next stage.
    }
    onFork(event) {
        const ctx = { children: event.children };
        const text = this.renderer?.renderFork?.(ctx) ?? this.defaultRenderFork(ctx);
        this.store.push({
            type: 'fork',
            text,
            depth: 0,
            stageId: event.traversalContext?.stageId,
            runtimeStageId: event.traversalContext?.runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    onSelected(event) {
        const ctx = {
            selected: event.selected,
            total: event.total,
            evidence: event.evidence,
        };
        const text = this.renderer?.renderSelected?.(ctx) ?? this.defaultRenderSelected(ctx);
        this.store.push({
            type: 'selector',
            text,
            depth: 0,
            stageId: event.traversalContext?.stageId,
            runtimeStageId: event.traversalContext?.runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    onSubflowEntry(event) {
        const sfKey = event.subflowId ?? '';
        this.stageCounters.delete(sfKey);
        this.firstStageFlags.delete(sfKey);
        const ctx = {
            name: event.name,
            direction: 'entry',
            description: event.description,
            mappedInput: event.mappedInput,
        };
        const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
        const rid = event.traversalContext?.runtimeStageId;
        const sid = event.traversalContext?.stageId;
        const sfId = event.traversalContext?.subflowId;
        this.store.push({
            type: 'subflow',
            text,
            depth: 0,
            stageName: event.name,
            stageId: sid,
            runtimeStageId: rid,
            subflowId: sfId,
            direction: 'entry',
        });
        // Emit per-key step entries for mapped inputs.
        //
        // Route EACH key through the consumer's `renderer.renderOp` hook before
        // falling back to the hardcoded `Input: ${key} = ${valueSummary}`
        // template. Without this routing, a consumer that provided a
        // domain-aware `renderer.renderOp` (to render e.g. `parsedResponse`
        // objects semantically) would see beautiful output for scope writes
        // but get the generic key-list fallback for subflow inputs — the
        // library's "combined narrative" promise (one renderer controls the
        // whole narrative) would silently break. We honour it here.
        //
        // The OpRenderContext is built with `type: 'write'` because semantically
        // the subflow's initial scope IS being written via the parent's
        // inputMapper. `operation: 'set'` likewise — this is the subflow's
        // first sight of the key.
        //
        // Values shown when includeValues=true — consumer responsible for
        // redaction policy on the parent scope (redacted keys produce
        // '[REDACTED]' via ScopeFacade).
        if (event.mappedInput && Object.keys(event.mappedInput).length > 0) {
            let stepNumber = 0;
            for (const [key, value] of Object.entries(event.mappedInput)) {
                const valueSummary = this.formatValue(value, this.maxValueLength);
                const opCtx = {
                    type: 'write',
                    key,
                    rawValue: value,
                    valueSummary,
                    operation: 'set',
                    stepNumber: ++stepNumber,
                };
                // If the consumer supplied `renderer.renderOp`, use its return value:
                //   - string → use as the narrative line
                //   - null   → deliberately exclude this entry (same semantics as
                //              `flushOps` above at line ~540)
                //   - undefined → renderer does not handle this op → fall through
                //                 to the hardcoded template
                // If no renderer at all, use the hardcoded template.
                let text;
                if (this.renderer?.renderOp) {
                    const customText = this.renderer.renderOp(opCtx);
                    if (customText === null)
                        continue; // excluded on purpose
                    text =
                        customText !== undefined
                            ? customText
                            : this.includeValues
                                ? `Input: ${key} = ${valueSummary}`
                                : `Input: ${key}`;
                }
                else {
                    text = this.includeValues ? `Input: ${key} = ${valueSummary}` : `Input: ${key}`;
                }
                this.store.push({
                    type: 'step',
                    text,
                    depth: 1,
                    stageName: event.name,
                    stageId: sid,
                    runtimeStageId: rid,
                    subflowId: sfId,
                    key,
                    rawValue: value,
                });
            }
        }
    }
    onSubflowExit(event) {
        const rid = event.traversalContext?.runtimeStageId;
        const sid = event.traversalContext?.stageId;
        const sfId = event.traversalContext?.subflowId;
        // NOTE: output state is NOT emitted as step entries because it may contain
        // unredacted values from the subflow's internal scope. The subflow exit
        // header is sufficient — drill into the subflow for details.
        const ctx = {
            name: event.name,
            direction: 'exit',
            outputState: event.outputState,
        };
        const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
        this.store.push({
            type: 'subflow',
            text,
            depth: 0,
            stageName: event.name,
            stageId: sid,
            runtimeStageId: rid,
            subflowId: sfId,
            direction: 'exit',
        });
    }
    onLoop(event) {
        const ctx = {
            target: event.target,
            iteration: event.iteration,
            description: event.description,
        };
        const text = this.renderer?.renderLoop?.(ctx) ?? this.defaultRenderLoop(ctx);
        this.store.push({
            type: 'loop',
            text,
            depth: 0,
            stageId: event.traversalContext?.stageId,
            runtimeStageId: event.traversalContext?.runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    onBreak(event) {
        const ctx = { stageName: event.stageName };
        const text = this.renderer?.renderBreak?.(ctx) ?? this.defaultRenderBreak(ctx);
        this.store.push({
            type: 'break',
            text,
            depth: 0,
            stageName: event.stageName,
            stageId: event.traversalContext?.stageId,
            runtimeStageId: event.traversalContext?.runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    onPause(event) {
        // Both channels fire onPause with different payload shapes. Narrative only
        // surfaces the control-flow variant (which has stageName/stageId). Data
        // channel's PauseEvent is ignored to avoid duplicate entries.
        if (!isFlowEvent(event))
            return;
        if (!event.stageName || !event.stageId)
            return;
        const text = `Execution paused at ${event.stageName}.`;
        this.store.push({
            type: 'pause',
            text,
            depth: 0,
            stageName: event.stageName,
            stageId: event.traversalContext?.stageId ?? event.stageId,
            runtimeStageId: event.traversalContext?.runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    onResume(event) {
        // Same isFlowEvent discriminant as onPause — ignore scope ResumeEvent.
        if (!isFlowEvent(event))
            return;
        if (!event.stageName || !event.stageId)
            return;
        const suffix = event.hasInput ? ' with input.' : '.';
        const text = `Execution resumed at ${event.stageName}${suffix}`;
        this.store.push({
            type: 'resume',
            text,
            depth: 0,
            stageName: event.stageName,
            stageId: event.traversalContext?.stageId ?? event.stageId,
            runtimeStageId: event.traversalContext?.runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    onError(event) {
        // Narrative only surfaces the control-flow variant of errors (has
        // stageName + message). Scope-level ErrorEvent is captured elsewhere.
        if (!isFlowEvent(event))
            return;
        if (typeof event.message !== 'string')
            return;
        let validationIssues;
        if (event.structuredError?.issues?.length) {
            validationIssues = event.structuredError.issues
                .map((issue) => {
                const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
                return `${path}: ${issue.message}`;
            })
                .join('; ');
        }
        const ctx = {
            stageName: event.stageName,
            message: event.message,
            validationIssues,
        };
        const text = this.renderer?.renderError?.(ctx) ?? this.defaultRenderError(ctx);
        this.store.push({
            type: 'error',
            text,
            depth: 0,
            stageName: event.stageName,
            stageId: event.traversalContext?.stageId,
            runtimeStageId: event.traversalContext?.runtimeStageId,
            subflowId: event.traversalContext?.subflowId,
        });
    }
    // ── Emit channel (Phase 3) ────────────────────────────────────────────
    /**
     * Receive a consumer-emitted event from `scope.$emit(name, payload)`.
     *
     * Buffered alongside `onRead`/`onWrite` per-stage so that the final
     * narrative preserves ordering:
     *
     *   1. stage header (emitted by `onStageExecuted` / `onDecision`)
     *   2. buffered ops for that stage — in call order — flushed right after
     *
     * Without buffering, emit events would fire BEFORE the stage header
     * (which only lands at `onStageExecuted`), producing out-of-order
     * narrative entries. Flush happens in `flushOps` which routes `emit`-
     * typed buffered ops through `renderEmit` instead of `renderOp`.
     */
    onEmit(event) {
        this.bufferOp(event.runtimeStageId, {
            type: 'emit',
            key: event.name,
            rawValue: event.payload,
            emitEvent: event,
        });
    }
    defaultRenderEmit(ctx) {
        return `[emit] ${ctx.name}: ${ctx.payloadSummary}`;
    }
    // ── Output (narrative-specific) ───────────────────────────────────────
    /**
     * Returns entries grouped by subflowId for structured access.
     * Root-level entries have subflowId = undefined.
     */
    getEntriesBySubflow() {
        const result = { '': [] };
        this.store.forEach((entry) => {
            const key = entry.subflowId ?? '';
            if (!result[key])
                result[key] = [];
            result[key].push(entry);
        });
        return result;
    }
    // ── Sequence query API (delegates to the composed store) ───────────────
    /** All narrative entries in execution order. */
    getEntries() {
        return this.store.getAll();
    }
    /** Total number of narrative entries. */
    get entryCount() {
        return this.store.size;
    }
    /** O(1) lookup: all narrative entries for one execution step. */
    getEntriesForStep(runtimeStageId) {
        return this.store.getByKey(runtimeStageId);
    }
    /** Number of distinct execution steps that produced entries. */
    get stepCount() {
        return this.store.keyCount;
    }
    /** Pre-built per-step range index — O(1) lookups for time-travel scrubbing. */
    getEntryRanges() {
        return this.store.getEntryRanges();
    }
    /** Reduce ALL entries to a single value. */
    aggregate(fn, initial) {
        return this.store.aggregate(fn, initial);
    }
    /** Reduce entries, optionally filtered to a set of visible runtimeStageIds. */
    accumulate(fn, initial, keys) {
        return this.store.accumulate(fn, initial, keys);
    }
    /** Progressive reveal: entries whose runtimeStageId is in the visible set. */
    getEntriesUpTo(visibleIds) {
        return this.store.getEntriesUpTo(visibleIds);
    }
    /** Clears all state. Called automatically before each run. */
    clear() {
        this.store.clear();
        this.pendingOps.clear();
        this.stageCounters.clear();
        this.firstStageFlags.clear();
        this.stageVisitCounts.clear();
    }
    // ── Private helpers ───────────────────────────────────────────────────
    incrementStageCounter(subflowKey) {
        const current = this.stageCounters.get(subflowKey) ?? 0;
        const next = current + 1;
        this.stageCounters.set(subflowKey, next);
        return next;
    }
    consumeFirstStageFlag(subflowKey) {
        if (!this.firstStageFlags.has(subflowKey)) {
            this.firstStageFlags.set(subflowKey, false);
            return true;
        }
        return false;
    }
    bufferOp(runtimeStageId, op) {
        let ops = this.pendingOps.get(runtimeStageId);
        if (!ops) {
            ops = [];
            this.pendingOps.set(runtimeStageId, ops);
        }
        ops.push({ ...op, stepNumber: ops.length + 1 });
    }
    flushOps(runtimeStageId, subflowId, stageId, stageName) {
        if (runtimeStageId === undefined)
            return;
        const ops = this.pendingOps.get(runtimeStageId);
        if (!ops || ops.length === 0)
            return;
        for (const op of ops) {
            // ── Emit events take a different render path ───────────────────────
            //
            // Emit events are buffered alongside reads/writes (so they appear
            // under their owning stage's header in narrative order, not inline
            // at call time). At flush, they route through `renderEmit` instead
            // of `renderOp` — consumers wanting custom emit rendering implement
            // the dedicated hook. Unhandled / missing renderer falls back to
            // the same compact `[emit] name: payloadSummary` default used by
            // the pre-buffering onEmit path.
            if (op.type === 'emit' && op.emitEvent) {
                const e = op.emitEvent;
                const payloadSummary = this.formatValue(e.payload, this.maxValueLength);
                const emitCtx = {
                    name: e.name,
                    payload: e.payload,
                    stageName: e.stageName,
                    runtimeStageId: e.runtimeStageId,
                    subflowPath: e.subflowPath,
                    pipelineId: e.pipelineId,
                    timestamp: e.timestamp,
                    payloadSummary,
                };
                let emitText;
                if (this.renderer?.renderEmit) {
                    const custom = this.renderer.renderEmit(emitCtx);
                    if (custom === null)
                        continue; // deliberately excluded
                    emitText = custom !== undefined ? custom : this.defaultRenderEmit(emitCtx);
                }
                else {
                    emitText = this.defaultRenderEmit(emitCtx);
                }
                this.store.push({
                    type: 'emit',
                    text: emitText,
                    depth: 1,
                    stageName,
                    stageId,
                    runtimeStageId,
                    stepNumber: op.stepNumber,
                    subflowId,
                });
                continue;
            }
            // At this point op.type is narrowed to 'read' | 'write' (emit branch
            // above uses `continue`). TypeScript can't follow that narrowing
            // through the continue, so we assert at render time.
            const opType = op.type;
            const valueSummary = this.formatValue(op.rawValue, this.maxValueLength);
            const opCtx = {
                type: opType,
                key: op.key,
                rawValue: op.rawValue,
                valueSummary,
                operation: op.operation,
                stepNumber: op.stepNumber,
            };
            const text = this.renderer?.renderOp ? this.renderer.renderOp(opCtx) : this.defaultRenderOp(opCtx);
            if (text == null)
                continue;
            this.store.push({
                type: 'step',
                text,
                depth: 1,
                stageName,
                stageId,
                runtimeStageId,
                stepNumber: op.stepNumber,
                subflowId,
                key: op.key,
                rawValue: op.rawValue,
            });
        }
        this.pendingOps.delete(runtimeStageId);
    }
    // ── Default renderers ─────────────────────────────────────────────────
    defaultRenderStage(ctx) {
        let inner;
        if (ctx.isFirst) {
            inner = ctx.description ? `The process began: ${ctx.description}.` : `The process began with ${ctx.stageName}.`;
        }
        else if (ctx.loopIteration && ctx.loopIteration > 0) {
            inner = ctx.description
                ? `Looped back: ${ctx.description} (pass ${ctx.loopIteration}).`
                : `Looped back to ${ctx.stageName} (pass ${ctx.loopIteration}).`;
        }
        else {
            inner = ctx.description ? `Next step: ${ctx.description}.` : `Next, it moved on to ${ctx.stageName}.`;
        }
        return `Stage ${ctx.stageNumber}: ${inner}`;
    }
    defaultRenderOp(ctx) {
        const stepPrefix = this.includeStepNumbers ? `Step ${ctx.stepNumber}: ` : '';
        if (ctx.type === 'read') {
            return this.includeValues && ctx.valueSummary
                ? `${stepPrefix}Read ${ctx.key} = ${ctx.valueSummary}`
                : `${stepPrefix}Read ${ctx.key}`;
        }
        if (ctx.operation === 'delete') {
            return `${stepPrefix}Delete ${ctx.key}`;
        }
        if (ctx.operation === 'update') {
            return this.includeValues
                ? `${stepPrefix}Update ${ctx.key} = ${ctx.valueSummary}`
                : `${stepPrefix}Update ${ctx.key}`;
        }
        return this.includeValues ? `${stepPrefix}Write ${ctx.key} = ${ctx.valueSummary}` : `${stepPrefix}Write ${ctx.key}`;
    }
    defaultRenderDecision(ctx) {
        const branchName = ctx.chosen;
        let conditionText;
        if (ctx.evidence) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const evidence = ctx.evidence;
            const matchedRule = evidence.rules?.find((r) => r.matched);
            if (matchedRule) {
                const label = matchedRule.label ? ` "${matchedRule.label}"` : '';
                if (matchedRule.type === 'filter') {
                    const parts = matchedRule.conditions.map((c) => `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)} ${c.result ? '\u2713' : '\u2717'}`);
                    conditionText = `It evaluated Rule ${matchedRule.ruleIndex}${label}: ${parts.join(', ')}, and chose ${branchName}.`;
                }
                else {
                    const parts = matchedRule.inputs.map((i) => `${i.key}=${i.valueSummary}`);
                    conditionText = `It examined${label}: ${parts.join(', ')}, and chose ${branchName}.`;
                }
            }
            else {
                const erroredCount = evidence.rules?.filter((r) => r.matchError !== undefined).length ?? 0;
                const errorNote = erroredCount > 0 ? ` (${erroredCount} rule${erroredCount > 1 ? 's' : ''} threw errors)` : '';
                conditionText = `No rules matched${errorNote}, fell back to default: ${branchName}.`;
            }
        }
        else if (ctx.description && ctx.rationale) {
            conditionText = `It ${ctx.description}: ${ctx.rationale}, so it chose ${branchName}.`;
        }
        else if (ctx.description) {
            conditionText = `It ${ctx.description} and chose ${branchName}.`;
        }
        else if (ctx.rationale) {
            conditionText = `A decision was made: ${ctx.rationale}, so the path taken was ${branchName}.`;
        }
        else {
            conditionText = `A decision was made, and the path taken was ${branchName}.`;
        }
        return `[Condition]: ${conditionText}`;
    }
    defaultRenderFork(ctx) {
        const names = ctx.children.join(', ');
        return `[Parallel]: Forking into ${ctx.children.length} parallel paths: ${names}.`;
    }
    defaultRenderSelected(ctx) {
        if (ctx.evidence) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const evidence = ctx.evidence;
            const matched = evidence.rules?.filter((r) => r.matched) ?? [];
            const parts = matched.map((r) => {
                const label = r.label ? ` "${r.label}"` : '';
                if (r.type === 'filter') {
                    const conds = r.conditions
                        .map((c) => `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)} ${c.result ? '\u2713' : '\u2717'}`)
                        .join(', ');
                    return `${r.branch}${label} (${conds})`;
                }
                const inputs = r.inputs.map((i) => `${i.key}=${i.valueSummary}`).join(', ');
                return `${r.branch}${label} (${inputs})`;
            });
            return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected: ${parts.join('; ')}.`;
        }
        const names = ctx.selected.join(', ');
        return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected for execution: ${names}.`;
    }
    defaultRenderSubflow(ctx) {
        if (ctx.direction === 'exit') {
            return `Exiting the ${ctx.name} subflow.`;
        }
        return ctx.description ? `Entering ${ctx.name}: ${ctx.description}.` : `Entering the ${ctx.name} subflow.`;
    }
    defaultRenderLoop(ctx) {
        return ctx.description
            ? `On pass ${ctx.iteration}: ${ctx.description} again.`
            : `On pass ${ctx.iteration} through ${ctx.target}.`;
    }
    defaultRenderBreak(ctx) {
        return `Execution stopped at ${ctx.stageName}.`;
    }
    defaultRenderError(ctx) {
        let text = `An error occurred at ${ctx.stageName}: ${ctx.message}.`;
        if (ctx.validationIssues) {
            text += ` Validation issues: ${ctx.validationIssues}.`;
        }
        return `[Error]: ${text}`;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL25hcnJhdGl2ZS9Db21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7R0FlRztBQUdILE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSxvQ0FBb0MsQ0FBQztBQUVqRSxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0saUNBQWlDLENBQUM7QUFDaEUsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLHlDQUF5QyxDQUFDO0FBc0R6RSxtRkFBbUY7QUFFbkY7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxNQUFNLE9BQU8seUJBQXlCO0lBQzNCLEVBQUUsQ0FBUztJQUNwQiw2RUFBNkU7SUFDNUQsS0FBSyxHQUFHLElBQUksYUFBYSxFQUEwQixDQUFDO0lBRXJFOzs7OztPQUtHO0lBQ0ssVUFBVSxHQUFHLElBQUksR0FBRyxFQUF3QixDQUFDO0lBQ3JELHNEQUFzRDtJQUM5QyxhQUFhLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7SUFDbEQseURBQXlEO0lBQ2pELGVBQWUsR0FBRyxJQUFJLEdBQUcsRUFBbUIsQ0FBQztJQUNyRCw0RUFBNEU7SUFDcEUsZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7SUFFN0Msa0JBQWtCLENBQVU7SUFDNUIsYUFBYSxDQUFVO0lBQ3ZCLGNBQWMsQ0FBUztJQUN2QixXQUFXLENBQTZDO0lBQ3hELFFBQVEsQ0FBcUI7SUFFckMsWUFBWSxPQUE0RDtRQUN0RSxJQUFJLENBQUMsRUFBRSxHQUFHLE9BQU8sRUFBRSxFQUFFLElBQUksb0JBQW9CLENBQUM7UUFDOUMsSUFBSSxDQUFDLGtCQUFrQixHQUFHLE9BQU8sRUFBRSxrQkFBa0IsSUFBSSxJQUFJLENBQUM7UUFDOUQsSUFBSSxDQUFDLGFBQWEsR0FBRyxPQUFP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Q3BFLElBQUksR0FBRyxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFDekIsSUFBSSxJQUFJLHVCQUF1QixHQUFHLENBQUMsZ0JBQWdCLEdBQUcsQ0FBQztRQUN6RCxDQUFDO1FBQ0QsT0FBTyxZQUFZLElBQUksRUFBRSxDQUFDO0lBQzVCLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciDigJQgSW5saW5lIG5hcnJhdGl2ZSBidWlsZGVyIHRoYXQgbWVyZ2VzIGZsb3cgKyBkYXRhIGR1cmluZyB0cmF2ZXJzYWwuXG4gKlxuICogQ29tcG9zZXMgYSBTZXF1ZW5jZVN0b3JlPENvbWJpbmVkTmFycmF0aXZlRW50cnk+IGZvciBkdWFsLWluZGV4ZWQgc3RvcmFnZSAob3JkZXJlZCBzZXF1ZW5jZVxuICogKyBPKDEpIHBlci1zdGVwIGxvb2t1cCBieSBydW50aW1lU3RhZ2VJZCkg4oCUIENvbnZlbnRpb24gMSwgb25lIHB1cnBvc2UgcGVyIHJlY29yZGVyLlxuICogSW1wbGVtZW50cyBgQ29tYmluZWRSZWNvcmRlcmAg4oCUIHRoZSBsaWJyYXJ5J3MgZmlyc3QtY2xhc3MgYWJzdHJhY3Rpb24gZm9yIG9ic2VydmVycyB0aGF0IHNwYW5cbiAqIGJvdGggZGF0YS1mbG93IGFuZCBjb250cm9sLWZsb3cgc3RyZWFtcy5cbiAqXG4gKiBFdmVudCBvcmRlcmluZyBndWFyYW50ZWVzIHRoaXMgd29ya3M6XG4gKiAgIDEuIFNjb3BlIGV2ZW50cyAob25SZWFkLCBvbldyaXRlKSBmaXJlIERVUklORyBzdGFnZSBleGVjdXRpb25cbiAqICAgMi4gRmxvdyBldmVudHMgKG9uU3RhZ2VFeGVjdXRlZCwgb25EZWNpc2lvbikgZmlyZSBBRlRFUiBzdGFnZSBleGVjdXRpb25cbiAqICAgMy4gQm90aCBjYXJyeSB0aGUgc2FtZSBgc3RhZ2VOYW1lYCDigJQgbm8gbWF0Y2hpbmcgYW1iaWd1aXR5XG4gKlxuICogU28gd2UgYnVmZmVyIHNjb3BlIG9wcyBwZXItc3RhZ2UsIHRoZW4gd2hlbiB0aGUgZmxvdyBldmVudCBhcnJpdmVzLFxuICogZW1pdCB0aGUgc3RhZ2UgZW50cnkgKyBmbHVzaCB0aGUgYnVmZmVyZWQgb3BzIGluIG9uZSBwYXNzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQ29tYmluZWRSZWNvcmRlciB9IGZyb20gJy4uLy4uL3JlY29yZGVyL0NvbWJpbmVkUmVjb3JkZXIuanMnO1xuaW1wb3J0IHsgaXNGbG93RXZlbnQgfSBmcm9tICcuLi8uLi9yZWNvcmRlci9Db21iaW5lZFJlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgRW1pdEV2ZW50IH0gZnJvbSAnLi4vLi4vcmVjb3JkZXIvRW1pdFJlY29yZGVyLmpzJztcbmltcG9ydCB7IFNlcXVlbmNlU3RvcmUgfSBmcm9tICcuLi8uLi9yZWNvcmRlci9TZXF1ZW5jZVN0b3JlLmpzJztcbmltcG9ydCB7IHN1bW1hcml6ZVZhbHVlIH0gZnJvbSAnLi4vLi4vc2NvcGUvcmVjb3JkZXJzL3N1bW1hcml6ZVZhbHVlLmpzJztcbmltcG9ydCB0eXBlIHsgRXJyb3JFdmVudCwgUGF1c2VFdmVudCwgUmVhZEV2ZW50LCBSZXN1bWVFdmVudCwgV3JpdGVFdmVudCB9IGZyb20gJy4uLy4uL3Njb3BlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgQnJlYWtSZW5kZXJDb250ZXh0LFxuICBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5LFxuICBEZWNpc2lvblJlbmRlckNvbnRleHQsXG4gIEVtaXRSZW5kZXJDb250ZXh0LFxuICBFcnJvclJlbmRlckNvbnRleHQsXG4gIEZvcmtSZW5kZXJDb250ZXh0LFxuICBMb29wUmVuZGVyQ29udGV4dCxcbiAgTmFycmF0aXZlUmVuZGVyZXIsXG4gIE9wUmVuZGVyQ29udGV4dCxcbiAgU2VsZWN0ZWRSZW5kZXJDb250ZXh0LFxuICBTdGFnZVJlbmRlckNvbnRleHQsXG4gIFN1YmZsb3dSZW5kZXJDb250ZXh0LFxufSBmcm9tICcuL25hcnJhdGl2ZVR5cGVzLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgRmxvd0JyZWFrRXZlbnQsXG4gIEZsb3dEZWNpc2lvbkV2ZW50LFxuICBGbG93RXJyb3JFdmVudCxcbiAgRmxvd0ZvcmtFdmVudCxcbiAgRmxvd0xvb3BFdmVudCxcbiAgRmxvd1BhdXNlRXZlbnQsXG4gIEZsb3dSZXN1bWVFdmVudCxcbiAgRmxvd1NlbGVjdGVkRXZlbnQsXG4gIEZsb3dTdGFnZUV2ZW50LFxuICBGbG93U3ViZmxvd0V2ZW50LFxufSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8g4pSA4pSAIFR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5pbnRlcmZhY2UgQnVmZmVyZWRPcCB7XG4gIHR5cGU6ICdyZWFkJyB8ICd3cml0ZScgfCAnZW1pdCc7XG4gIC8qKiBGb3IgcmVhZC93cml0ZTogc2NvcGUga2V5LiBGb3IgZW1pdDogdGhlIGV2ZW50IG5hbWUuICovXG4gIGtleTogc3RyaW5nO1xuICByYXdWYWx1ZTogdW5rbm93bjtcbiAgb3BlcmF0aW9uPzogJ3NldCcgfCAndXBkYXRlJyB8ICdkZWxldGUnO1xuICBzdGVwTnVtYmVyOiBudW1iZXI7XG4gIC8qKiBPbmx5IHNldCBmb3IgdHlwZT0nZW1pdCcg4oCUIGNhcnJpZXMgdGhlIGZ1bGwgRW1pdEV2ZW50IGZvciByZW5kZXJpbmcuICovXG4gIGVtaXRFdmVudD86IEVtaXRFdmVudDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyT3B0aW9ucyB7XG4gIGluY2x1ZGVTdGVwTnVtYmVycz86IGJvb2xlYW47XG4gIGluY2x1ZGVWYWx1ZXM/OiBib29sZWFuO1xuICBtYXhWYWx1ZUxlbmd0aD86IG51bWJlcjtcbiAgLyoqIEN1c3RvbSB2YWx1ZSBmb3JtYXR0ZXIuIENhbGxlZCBhdCByZW5kZXIgdGltZSAoZmx1c2hPcHMpLCBub3QgY2FwdHVyZSB0aW1lLlxuICAgKiAgUmVjZWl2ZXMgdGhlIHJhdyB2YWx1ZSBhbmQgbWF4VmFsdWVMZW5ndGguIERlZmF1bHRzIHRvIHN1bW1hcml6ZVZhbHVlKCkuICovXG4gIGZvcm1hdFZhbHVlPzogKHZhbHVlOiB1bmtub3duLCBtYXhMZW46IG51bWJlcikgPT4gc3RyaW5nO1xuICAvKiogUGx1Z2dhYmxlIHJlbmRlcmVyIGZvciBjdXN0b21pemluZyBuYXJyYXRpdmUgb3V0cHV0LiBVbmltcGxlbWVudGVkIG1ldGhvZHNcbiAgICogIGZhbGwgYmFjayB0byB0aGUgZGVmYXVsdCBFbmdsaXNoIHJlbmRlcmVyLiBTZWUgTmFycmF0aXZlUmVuZGVyZXIgZG9jcy4gKi9cbiAgcmVuZGVyZXI/OiBOYXJyYXRpdmVSZW5kZXJlcjtcbn1cblxuLy8g4pSA4pSAIFNjb3BlUmVjb3JkZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICogSW1wbGVtZW50cyBgQ29tYmluZWRSZWNvcmRlcmAg4oCUIHRoZSBsaWJyYXJ5J3MgZmlyc3QtY2xhc3MgYWJzdHJhY3Rpb24gZm9yXG4gKiBvYnNlcnZlcnMgdGhhdCBzcGFuIGJvdGggZGF0YS1mbG93IChgU2NvcGVSZWNvcmRlcmApIGFuZCBjb250cm9sLWZsb3dcbiAqIChgRmxvd1JlY29yZGVyYCkgc3RyZWFtcy4gT25lIGBpZGAsIHJvdXRlZCB0byBib3RoIGNoYW5uZWxzIHZpYVxuICogYGV4ZWN1dG9yLmF0dGFjaENvbWJpbmVkUmVjb3JkZXIoLi4uKWAgKG9yIGVxdWl2YWxlbnRseSB2aWFcbiAqIGBleGVjdXRvci5lbmFibGVOYXJyYXRpdmUoLi4uKWAgd2hpY2ggYXV0by1jcmVhdGVzIGFuIGluc3RhbmNlKS5cbiAqXG4gKiBGb3Igc2hhcmVkLW1ldGhvZC1uYW1lIGV2ZW50cyAoYG9uRXJyb3JgLCBgb25QYXVzZWAsIGBvblJlc3VtZWApIHRoZVxuICogaGFuZGxlciBhY2NlcHRzIHRoZSB1bmlvbiBwYXlsb2FkIHR5cGU7IHdlIGRpc2NyaW1pbmF0ZSB2aWEgYGlzRmxvd0V2ZW50YC5cbiAqIFNjb3BlIHZhcmlhbnRzIG9mIHRoZXNlIGV2ZW50cyBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQgaGVyZSDigJQgdGhlXG4gKiBuYXJyYXRpdmUgb25seSBzdXJmYWNlcyBjb250cm9sLWZsb3cgbGlmZWN5Y2xlIGV2ZW50cy5cbiAqL1xuZXhwb3J0IGNsYXNzIENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgaW1wbGVtZW50cyBDb21iaW5lZFJlY29yZGVyIHtcbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcbiAgLyoqIER1YWwtaW5kZXhlZCBvcmRlcmVkIHN0b3JhZ2UgKENvbnZlbnRpb24gMSDigJQgY29tcG9zZWQsIG5vdCBpbmhlcml0ZWQpLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHN0b3JlID0gbmV3IFNlcXVlbmNlU3RvcmU8Q29tYmluZWROYXJyYXRpdmVFbnRyeT4oKTtcblxuICAvKipcbiAgICogUGVuZGluZyBzY29wZSBvcHMga2V5ZWQgYnkgcnVudGltZVN0YWdlSWQuIEZsdXNoZWQgaW4gb25TdGFnZUV4ZWN1dGVkL29uRGVjaXNpb24uXG4gICAqXG4gICAqIEtleWluZyBieSBydW50aW1lU3RhZ2VJZCAobm90IHN0YWdlTmFtZSkgZW5zdXJlcyBjb3JyZWN0bmVzcyB3aGVuIHBhcmFsbGVsIGZvcmtcbiAgICogYnJhbmNoZXMgY29udGFpbiBzdGFnZXMgd2l0aCB0aGUgc2FtZSBuYW1lIOKAlCBlYWNoIGV4ZWN1dGlvbiBzdGVwIGhhcyBhIHVuaXF1ZSBJRC5cbiAgICovXG4gIHByaXZhdGUgcGVuZGluZ09wcyA9IG5ldyBNYXA8c3RyaW5nLCBCdWZmZXJlZE9wW10+KCk7XG4gIC8qKiBQZXItc3ViZmxvdyBzdGFnZSBjb3VudGVycy4gS2V5ICcnID0gcm9vdCBmbG93LiAqL1xuICBwcml2YXRlIHN0YWdlQ291bnRlcnMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAvKiogUGVyLXN1YmZsb3cgZmlyc3Qtc3RhZ2UgZmxhZ3MuIEtleSAnJyA9IHJvb3QgZmxvdy4gKi9cbiAgcHJpdmF0ZSBmaXJzdFN0YWdlRmxhZ3MgPSBuZXcgTWFwPHN0cmluZywgYm9vbGVhbj4oKTtcbiAgLyoqIFZpc2l0IGNvdW50IHBlciBzdGFnZUlkIOKAlCBkZXRlY3RzIGxvb3AgaXRlcmF0aW9ucyAoY291bnQgPiAxID0gbG9vcCkuICovXG4gIHByaXZhdGUgc3RhZ2VWaXNpdENvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cbiAgcHJpdmF0ZSBpbmNsdWRlU3RlcE51bWJlcnM6IGJvb2xlYW47XG4gIHByaXZhdGUgaW5jbHVkZVZhbHVlczogYm9vbGVhbjtcbiAgcHJpdmF0ZSBtYXhWYWx1ZUxlbmd0aDogbnVtYmVyO1xuICBwcml2YXRlIGZvcm1hdFZhbHVlOiAodmFsdWU6IHVua25vd24sIG1heExlbjogbnVtYmVyKSA9PiBzdHJpbmc7XG4gIHByaXZhdGUgcmVuZGVyZXI/OiBOYXJyYXRpdmVSZW5kZXJlcjtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zPzogQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlck9wdGlvbnMgJiB7IGlkPzogc3RyaW5nIH0pIHtcbiAgICB0aGlzLmlkID0gb3B0aW9ucz8uaWQgPz8gJ2NvbWJpbmVkLW5hcnJhdGl2ZSc7XG4gICAgdGhpcy5pbmNsdWRlU3RlcE51bWJlcnMgPSBvcHRpb25zPy5pbmNsdWRlU3RlcE51bWJlcnMgPz8gdHJ1ZTtcbiAgICB0aGlzLmluY2x1ZGVWYWx1ZXMgPSBvcHRpb25zPy5pbmNsdWRlVmFsdWVzID8/IHRydWU7XG4gICAgdGhpcy5tYXhWYWx1ZUxlbmd0aCA9IG9wdGlvbnM/Lm1heFZhbHVlTGVuZ3RoID8/IDgwO1xuICAgIHRoaXMuZm9ybWF0VmFsdWUgPSBvcHRpb25zPy5mb3JtYXRWYWx1ZSA/PyBzdW1tYXJpemVWYWx1ZTtcbiAgICB0aGlzLnJlbmRlcmVyID0gb3B0aW9ucz8ucmVuZGVyZXI7XG4gIH1cblxuICAvLyDilIDilIAgU2NvcGUgY2hhbm5lbCAoZmlyZXMgZmlyc3QsIGR1cmluZyBzdGFnZSBleGVjdXRpb24pIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIG9uUmVhZChldmVudDogUmVhZEV2ZW50KTogdm9pZCB7XG4gICAgaWYgKCFldmVudC5rZXkpIHJldHVybjtcbiAgICB0aGlzLmJ1ZmZlck9wKGV2ZW50LnJ1bnRpbWVTdGFnZUlkLCB7XG4gICAgICB0eXBlOiAncmVhZCcsXG4gICAgICBrZXk6IGV2ZW50LmtleSxcbiAgICAgIHJhd1ZhbHVlOiBldmVudC52YWx1ZSxcbiAgICB9KTtcbiAgfVxuXG4gIG9uV3JpdGUoZXZlbnQ6IFdyaXRlRXZlbnQpOiB2b2lkIHtcbiAgICB0aGlzLmJ1ZmZlck9wKGV2ZW50LnJ1bnRpbWVTdGFnZUlkLCB7XG4gICAgICB0eXBlOiAnd3JpdGUnLFxuICAgICAga2V5OiBldmVudC5rZXksXG4gICAgICByYXdWYWx1ZTogZXZlbnQudmFsdWUsXG4gICAgICBvcGVyYXRpb246IGV2ZW50Lm9wZXJhdGlvbixcbiAgICB9KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBGbG93IGNoYW5uZWwgKGZpcmVzIGFmdGVyIHN0YWdlIGV4ZWN1dGlvbikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgb25TdGFnZUV4ZWN1dGVkKGV2ZW50OiBGbG93U3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIC8vIE5vbi1saW5lYXIga2luZHMgZ2V0IHRoZWlyIG5hcnJhdGl2ZSBlbnRyaWVzIChhbmQgb3BzIGZsdXNoKVxuICAgIC8vIGZyb20gYG9uRGVjaXNpb25gIC8gYG9uRm9ya2AgLyBgb25TZWxlY3RlZGAgLyBgb25TdWJmbG93RW50cnlgLlxuICAgIC8vIFNraXAgdGhlbSBoZXJlIHNvIGVhY2ggc3RhZ2UgaGFzIGV4YWN0bHkgb25lIG5hcnJhdGl2ZSBlbnRyeS5cbiAgICBpZiAoZXZlbnQuc3RhZ2VUeXBlICE9PSAnbGluZWFyJykgcmV0dXJuO1xuXG4gICAgY29uc3Qgc3RhZ2VJZCA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQ7XG4gICAgY29uc3QgcnVudGltZVN0YWdlSWQgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5ydW50aW1lU3RhZ2VJZDtcbiAgICBjb25zdCBzZktleSA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCA/PyAnJztcbiAgICBjb25zdCBzdGFnZU51bSA9IHRoaXMuaW5jcmVtZW50U3RhZ2VDb3VudGVyKHNmS2V5KTtcbiAgICBjb25zdCBpc0ZpcnN0ID0gdGhpcy5jb25zdW1lRmlyc3RTdGFnZUZsYWcoc2ZLZXkpO1xuXG4gICAgLy8gVHJhY2sgdmlzaXQgY291bnQgcGVyIHN0YWdlSWQgdG8gZGV0ZWN0IGxvb3AgaXRlcmF0aW9uc1xuICAgIGNvbnN0IHZpc2l0S2V5ID0gc3RhZ2VJZCA/PyBldmVudC5zdGFnZU5hbWU7XG4gICAgY29uc3QgdmlzaXRDb3VudCA9ICh0aGlzLnN0YWdlVmlzaXRDb3VudHMuZ2V0KHZpc2l0S2V5KSA/PyAwKSArIDE7XG4gICAgdGhpcy5zdGFnZVZpc2l0Q291bnRzLnNldCh2aXNpdEtleSwgdmlzaXRDb3VudCk7XG5cbiAgICBjb25zdCBjdHg6IFN0YWdlUmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VOdW1iZXI6IHN0YWdlTnVtLFxuICAgICAgaXNGaXJzdCxcbiAgICAgIGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbixcbiAgICAgIGxvb3BJdGVyYXRpb246IHZpc2l0Q291bnQgPiAxID8gdmlzaXRDb3VudCAtIDEgOiB1bmRlZmluZWQsXG4gICAgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyU3RhZ2U/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlclN0YWdlKGN0eCk7XG5cbiAgICBjb25zdCBzZklkID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkO1xuICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICBzdGFnZUlkLFxuICAgICAgcnVudGltZVN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IHNmSWQsXG4gICAgfSk7XG4gICAgdGhpcy5mbHVzaE9wcyhydW50aW1lU3RhZ2VJZCwgc2ZJZCwgc3RhZ2VJZCwgZXZlbnQuc3RhZ2VOYW1lKTtcbiAgfVxuXG4gIG9uRGVjaXNpb24oZXZlbnQ6IEZsb3dEZWNpc2lvbkV2ZW50KTogdm9pZCB7XG4gICAgY29uc3Qgc3RhZ2VJZCA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQ7XG4gICAgY29uc3QgcnVudGltZVN0YWdlSWQgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5ydW50aW1lU3RhZ2VJZDtcblxuICAgIC8vIEVtaXQgdGhlIGRlY2lkZXIgc3RhZ2UgZW50cnkuXG4gICAgLy8gUHJvcG9zYWwgIzAwMyBhbHNvIGZpcmVzIGBvblN0YWdlRXhlY3V0ZWQoc3RhZ2VUeXBlOiAnZGVjaWRlcicpYFxuICAgIC8vIEFGVEVSIHRoaXMgZXZlbnQsIGJ1dCBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyIGdhdGVzIHRoYXRcbiAgICAvLyBoYW5kbGVyIHRvIExJTkVBUi1vbmx5IHNvIHRoaXMgc3RheXMgdGhlIHNpbmdsZSBlbWlzc2lvbiBzaXRlXG4gICAgLy8gZm9yIHRoZSBkZWNpZGVyJ3Mgc3RhZ2UgZW50cnkgKyBvcHMgZmx1c2guIEtlZXBzIG5hcnJhdGl2ZVxuICAgIC8vIG91dHB1dCBieXRlLXN0YWJsZSBhY3Jvc3MgdGhlIHY2IHRyYW5zaXRpb24uXG4gICAgY29uc3Qgc2ZLZXkgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQgPz8gJyc7XG4gICAgY29uc3Qgc3RhZ2VOdW0gPSB0aGlzLmluY3JlbWVudFN0YWdlQ291bnRlcihzZktleSk7XG4gICAgY29uc3QgaXNGaXJzdCA9IHRoaXMuY29uc3VtZUZpcnN0U3RhZ2VGbGFnKHNmS2V5KTtcblxuICAgIGNvbnN0IHN0YWdlQ3R4OiBTdGFnZVJlbmRlckNvbnRleHQgPSB7XG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LmRlY2lkZXIsXG4gICAgICBzdGFnZU51bWJlcjogc3RhZ2VOdW0sXG4gICAgICBpc0ZpcnN0LFxuICAgICAgZGVzY3JpcHRpb246IGV2ZW50LmRlc2NyaXB0aW9uLFxuICAgIH07XG4gICAgY29uc3Qgc3RhZ2VUZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyU3RhZ2U/LihzdGFnZUN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyU3RhZ2Uoc3RhZ2VDdHgpO1xuXG4gICAgdGhpcy5zdG9yZS5wdXNoKHtcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICB0ZXh0OiBzdGFnZVRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuZGVjaWRlcixcbiAgICAgIHN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICAgIHRoaXMuZmx1c2hPcHMocnVudGltZVN0YWdlSWQsIGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCwgc3RhZ2VJZCwgZXZlbnQuZGVjaWRlcik7XG5cbiAgICAvLyBFbWl0IHRoZSBjb25kaXRpb24gZW50cnkgYXMgYSBuZXN0ZWQgc3ViLWl0ZW0gKGRlcHRoIDEpIG9mIHRoZSBzdGFnZSBhYm92ZS5cbiAgICBjb25zdCBkZWNpc2lvbkN0eDogRGVjaXNpb25SZW5kZXJDb250ZXh0ID0ge1xuICAgICAgZGVjaWRlcjogZXZlbnQuZGVjaWRlcixcbiAgICAgIGNob3NlbjogZXZlbnQuY2hvc2VuLFxuICAgICAgZGVzY3JpcHRpb246IGV2ZW50LmRlc2NyaXB0aW9uLFxuICAgICAgcmF0aW9uYWxlOiBldmVudC5yYXRpb25hbGUsXG4gICAgICBldmlkZW5jZTogZXZlbnQuZXZpZGVuY2UsXG4gICAgfTtcbiAgICBjb25zdCBjb25kaXRpb25UZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyRGVjaXNpb24/LihkZWNpc2lvbkN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyRGVjaXNpb24oZGVjaXNpb25DdHgpO1xuICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gICAgICB0eXBlOiAnY29uZGl0aW9uJyxcbiAgICAgIHRleHQ6IGNvbmRpdGlvblRleHQsXG4gICAgICBkZXB0aDogMSxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuZGVjaWRlcixcbiAgICAgIHN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25OZXh0KCk6IHZvaWQge1xuICAgIC8vIE5vLW9wLiBvblN0YWdlRXhlY3V0ZWQgYWxyZWFkeSBoYXMgdGhlIGRlc2NyaXB0aW9uIGZvciB0aGUgbmV4dCBzdGFnZS5cbiAgfVxuXG4gIG9uRm9yayhldmVudDogRmxvd0ZvcmtFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGN0eDogRm9ya1JlbmRlckNvbnRleHQgPSB7IGNoaWxkcmVuOiBldmVudC5jaGlsZHJlbiB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJGb3JrPy4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJGb3JrKGN0eCk7XG4gICAgdGhpcy5zdG9yZS5wdXNoKHtcbiAgICAgIHR5cGU6ICdmb3JrJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlSWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8ucnVudGltZVN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgfVxuXG4gIG9uU2VsZWN0ZWQoZXZlbnQ6IEZsb3dTZWxlY3RlZEV2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY3R4OiBTZWxlY3RlZFJlbmRlckNvbnRleHQgPSB7XG4gICAgICBzZWxlY3RlZDogZXZlbnQuc2VsZWN0ZWQsXG4gICAgICB0b3RhbDogZXZlbnQudG90YWwsXG4gICAgICBldmlkZW5jZTogZXZlbnQuZXZpZGVuY2UsXG4gICAgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyU2VsZWN0ZWQ/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlclNlbGVjdGVkKGN0eCk7XG4gICAgdGhpcy5zdG9yZS5wdXNoKHtcbiAgICAgIHR5cGU6ICdzZWxlY3RvcicsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICBvblN1YmZsb3dFbnRyeShldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IHNmS2V5ID0gZXZlbnQuc3ViZmxvd0lkID8/ICcnO1xuICAgIHRoaXMuc3RhZ2VDb3VudGVycy5kZWxldGUoc2ZLZXkpO1xuICAgIHRoaXMuZmlyc3RTdGFnZUZsYWdzLmRlbGV0ZShzZktleSk7XG5cbiAgICBjb25zdCBjdHg6IFN1YmZsb3dSZW5kZXJDb250ZXh0ID0ge1xuICAgICAgbmFtZTogZXZlbnQubmFtZSxcbiAgICAgIGRpcmVjdGlvbjogJ2VudHJ5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbixcbiAgICAgIG1hcHBlZElucHV0OiBldmVudC5tYXBwZWRJbnB1dCxcbiAgICB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJTdWJmbG93Py4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJTdWJmbG93KGN0eCk7XG4gICAgY29uc3QgcmlkID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8ucnVudGltZVN0YWdlSWQ7XG4gICAgY29uc3Qgc2lkID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZDtcbiAgICBjb25zdCBzZklkID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkO1xuICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gICAgICB0eXBlOiAnc3ViZmxvdycsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICBzdGFnZUlkOiBzaWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogcmlkLFxuICAgICAgc3ViZmxvd0lkOiBzZklkLFxuICAgICAgZGlyZWN0aW9uOiAnZW50cnknLFxuICAgIH0pO1xuICAgIC8vIEVtaXQgcGVyLWtleSBzdGVwIGVudHJpZXMgZm9yIG1hcHBlZCBpbnB1dHMuXG4gICAgLy9cbiAgICAvLyBSb3V0ZSBFQUNIIGtleSB0aHJvdWdoIHRoZSBjb25zdW1lcidzIGByZW5kZXJlci5yZW5kZXJPcGAgaG9vayBiZWZvcmVcbiAgICAvLyBmYWxsaW5nIGJhY2sgdG8gdGhlIGhhcmRjb2RlZCBgSW5wdXQ6ICR7a2V5fSA9ICR7dmFsdWVTdW1tYXJ5fWBcbiAgICAvLyB0ZW1wbGF0ZS4gV2l0aG91dCB0aGlzIHJvdXRpbmcsIGEgY29uc3VtZXIgdGhhdCBwcm92aWRlZCBhXG4gICAgLy8gZG9tYWluLWF3YXJlIGByZW5kZXJlci5yZW5kZXJPcGAgKHRvIHJlbmRlciBlLmcuIGBwYXJzZWRSZXNwb25zZWBcbiAgICAvLyBvYmplY3RzIHNlbWFudGljYWxseSkgd291bGQgc2VlIGJlYXV0aWZ1bCBvdXRwdXQgZm9yIHNjb3BlIHdyaXRlc1xuICAgIC8vIGJ1dCBnZXQgdGhlIGdlbmVyaWMga2V5LWxpc3QgZmFsbGJhY2sgZm9yIHN1YmZsb3cgaW5wdXRzIOKAlCB0aGVcbiAgICAvLyBsaWJyYXJ5J3MgXCJjb21iaW5lZCBuYXJyYXRpdmVcIiBwcm9taXNlIChvbmUgcmVuZGVyZXIgY29udHJvbHMgdGhlXG4gICAgLy8gd2hvbGUgbmFycmF0aXZlKSB3b3VsZCBzaWxlbnRseSBicmVhay4gV2UgaG9ub3VyIGl0IGhlcmUuXG4gICAgLy9cbiAgICAvLyBUaGUgT3BSZW5kZXJDb250ZXh0IGlzIGJ1aWx0IHdpdGggYHR5cGU6ICd3cml0ZSdgIGJlY2F1c2Ugc2VtYW50aWNhbGx5XG4gICAgLy8gdGhlIHN1YmZsb3cncyBpbml0aWFsIHNjb3BlIElTIGJlaW5nIHdyaXR0ZW4gdmlhIHRoZSBwYXJlbnQnc1xuICAgIC8vIGlucHV0TWFwcGVyLiBgb3BlcmF0aW9uOiAnc2V0J2AgbGlrZXdpc2Ug4oCUIHRoaXMgaXMgdGhlIHN1YmZsb3cnc1xuICAgIC8vIGZpcnN0IHNpZ2h0IG9mIHRoZSBrZXkuXG4gICAgLy9cbiAgICAvLyBWYWx1ZXMgc2hvd24gd2hlbiBpbmNsdWRlVmFsdWVzPXRydWUg4oCUIGNvbnN1bWVyIHJlc3BvbnNpYmxlIGZvclxuICAgIC8vIHJlZGFjdGlvbiBwb2xpY3kgb24gdGhlIHBhcmVudCBzY29wZSAocmVkYWN0ZWQga2V5cyBwcm9kdWNlXG4gICAgLy8gJ1tSRURBQ1RFRF0nIHZpYSBTY29wZUZhY2FkZSkuXG4gICAgaWYgKGV2ZW50Lm1hcHBlZElucHV0ICYmIE9iamVjdC5rZXlzKGV2ZW50Lm1hcHBlZElucHV0KS5sZW5ndGggPiAwKSB7XG4gICAgICBsZXQgc3RlcE51bWJlciA9IDA7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhldmVudC5tYXBwZWRJbnB1dCkpIHtcbiAgICAgICAgY29uc3QgdmFsdWVTdW1tYXJ5ID0gdGhpcy5mb3JtYXRWYWx1ZSh2YWx1ZSwgdGhpcy5tYXhWYWx1ZUxlbmd0aCk7XG4gICAgICAgIGNvbnN0IG9wQ3R4OiBPcFJlbmRlckNvbnRleHQgPSB7XG4gICAgICAgICAgdHlwZTogJ3dyaXRlJyxcbiAgICAgICAgICBrZXksXG4gICAgICAgICAgcmF3VmFsdWU6IHZhbHVlLFxuICAgICAgICAgIHZhbHVlU3VtbWFyeSxcbiAgICAgICAgICBvcGVyYXRpb246ICdzZXQnLFxuICAgICAgICAgIHN0ZXBOdW1iZXI6ICsrc3RlcE51bWJlcixcbiAgICAgICAgfTtcblxuICAgICAgICAvLyBJZiB0aGUgY29uc3VtZXIgc3VwcGxpZWQgYHJlbmRlcmVyLnJlbmRlck9wYCwgdXNlIGl0cyByZXR1cm4gdmFsdWU6XG4gICAgICAgIC8vICAgLSBzdHJpbmcg4oaSIHVzZSBhcyB0aGUgbmFycmF0aXZlIGxpbmVcbiAgICAgICAgLy8gICAtIG51bGwgICDihpIgZGVsaWJlcmF0ZWx5IGV4Y2x1ZGUgdGhpcyBlbnRyeSAoc2FtZSBzZW1hbnRpY3MgYXNcbiAgICAgICAgLy8gICAgICAgICAgICAgIGBmbHVzaE9wc2AgYWJvdmUgYXQgbGluZSB+NTQwKVxuICAgICAgICAvLyAgIC0gdW5kZWZpbmVkIOKGkiByZW5kZXJlciBkb2VzIG5vdCBoYW5kbGUgdGhpcyBvcCDihpIgZmFsbCB0aHJvdWdoXG4gICAgICAgIC8vICAgICAgICAgICAgICAgICB0byB0aGUgaGFyZGNvZGVkIHRlbXBsYXRlXG4gICAgICAgIC8vIElmIG5vIHJlbmRlcmVyIGF0IGFsbCwgdXNlIHRoZSBoYXJkY29kZWQgdGVtcGxhdGUuXG4gICAgICAgIGxldCB0ZXh0OiBzdHJpbmcgfCBudWxsO1xuICAgICAgICBpZiAodGhpcy5yZW5kZXJlcj8ucmVuZGVyT3ApIHtcbiAgICAgICAgICBjb25zdCBjdXN0b21UZXh0ID0gdGhpcy5yZW5kZXJlci5yZW5kZXJPcChvcEN0eCk7XG4gICAgICAgICAgaWYgKGN1c3RvbVRleHQgPT09IG51bGwpIGNvbnRpbnVlOyAvLyBleGNsdWRlZCBvbiBwdXJwb3NlXG4gICAgICAgICAgdGV4dCA9XG4gICAgICAgICAgICBjdXN0b21UZXh0ICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgPyBjdXN0b21UZXh0XG4gICAgICAgICAgICAgIDogdGhpcy5pbmNsdWRlVmFsdWVzXG4gICAgICAgICAgICAgID8gYElucHV0OiAke2tleX0gPSAke3ZhbHVlU3VtbWFyeX1gXG4gICAgICAgICAgICAgIDogYElucHV0OiAke2tleX1gO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRleHQgPSB0aGlzLmluY2x1ZGVWYWx1ZXMgPyBgSW5wdXQ6ICR7a2V5fSA9ICR7dmFsdWVTdW1tYXJ5fWAgOiBgSW5wdXQ6ICR7a2V5fWA7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnN0b3JlLnB1c2goe1xuICAgICAgICAgIHR5cGU6ICdzdGVwJyxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIGRlcHRoOiAxLFxuICAgICAgICAgIHN0YWdlTmFtZTogZXZlbnQubmFtZSxcbiAgICAgICAgICBzdGFnZUlkOiBzaWQsXG4gICAgICAgICAgcnVudGltZVN0YWdlSWQ6IHJpZCxcbiAgICAgICAgICBzdWJmbG93SWQ6IHNmSWQsXG4gICAgICAgICAga2V5LFxuICAgICAgICAgIHJhd1ZhbHVlOiB2YWx1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25TdWJmbG93RXhpdChldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IHJpZCA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnJ1bnRpbWVTdGFnZUlkO1xuICAgIGNvbnN0IHNpZCA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQ7XG4gICAgY29uc3Qgc2ZJZCA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZDtcbiAgICAvLyBOT1RFOiBvdXRwdXQgc3RhdGUgaXMgTk9UIGVtaXR0ZWQgYXMgc3RlcCBlbnRyaWVzIGJlY2F1c2UgaXQgbWF5IGNvbnRhaW5cbiAgICAvLyB1bnJlZGFjdGVkIHZhbHVlcyBmcm9tIHRoZSBzdWJmbG93J3MgaW50ZXJuYWwgc2NvcGUuIFRoZSBzdWJmbG93IGV4aXRcbiAgICAvLyBoZWFkZXIgaXMgc3VmZmljaWVudCDigJQgZHJpbGwgaW50byB0aGUgc3ViZmxvdyBmb3IgZGV0YWlscy5cbiAgICBjb25zdCBjdHg6IFN1YmZsb3dSZW5kZXJDb250ZXh0ID0ge1xuICAgICAgbmFtZTogZXZlbnQubmFtZSxcbiAgICAgIGRpcmVjdGlvbjogJ2V4aXQnLFxuICAgICAgb3V0cHV0U3RhdGU6IGV2ZW50Lm91dHB1dFN0YXRlLFxuICAgIH07XG4gICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlclN1YmZsb3c/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlclN1YmZsb3coY3R4KTtcbiAgICB0aGlzLnN0b3JlLnB1c2goe1xuICAgICAgdHlwZTogJ3N1YmZsb3cnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5uYW1lLFxuICAgICAgc3RhZ2VJZDogc2lkLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IHJpZCxcbiAgICAgIHN1YmZsb3dJZDogc2ZJZCxcbiAgICAgIGRpcmVjdGlvbjogJ2V4aXQnLFxuICAgIH0pO1xuICB9XG5cbiAgb25Mb29wKGV2ZW50OiBGbG93TG9vcEV2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY3R4OiBMb29wUmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIHRhcmdldDogZXZlbnQudGFyZ2V0LFxuICAgICAgaXRlcmF0aW9uOiBldmVudC5pdGVyYXRpb24sXG4gICAgICBkZXNjcmlwdGlvbjogZXZlbnQuZGVzY3JpcHRpb24sXG4gICAgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyTG9vcD8uKGN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyTG9vcChjdHgpO1xuICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gICAgICB0eXBlOiAnbG9vcCcsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICBvbkJyZWFrKGV2ZW50OiBGbG93QnJlYWtFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGN0eDogQnJlYWtSZW5kZXJDb250ZXh0ID0geyBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJCcmVhaz8uKGN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyQnJlYWsoY3R4KTtcbiAgICB0aGlzLnN0b3JlLnB1c2goe1xuICAgICAgdHlwZTogJ2JyZWFrJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZCxcbiAgICAgIHJ1bnRpbWVTdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5ydW50aW1lU3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25QYXVzZShldmVudDogUGF1c2VFdmVudCB8IEZsb3dQYXVzZUV2ZW50KTogdm9pZCB7XG4gICAgLy8gQm90aCBjaGFubmVscyBmaXJlIG9uUGF1c2Ugd2l0aCBkaWZmZXJlbnQgcGF5bG9hZCBzaGFwZXMuIE5hcnJhdGl2ZSBvbmx5XG4gICAgLy8gc3VyZmFjZXMgdGhlIGNvbnRyb2wtZmxvdyB2YXJpYW50ICh3aGljaCBoYXMgc3RhZ2VOYW1lL3N0YWdlSWQpLiBEYXRhXG4gICAgLy8gY2hhbm5lbCdzIFBhdXNlRXZlbnQgaXMgaWdub3JlZCB0byBhdm9pZCBkdXBsaWNhdGUgZW50cmllcy5cbiAgICBpZiAoIWlzRmxvd0V2ZW50KGV2ZW50KSkgcmV0dXJuO1xuICAgIGlmICghZXZlbnQuc3RhZ2VOYW1lIHx8ICFldmVudC5zdGFnZUlkKSByZXR1cm47XG4gICAgY29uc3QgdGV4dCA9IGBFeGVjdXRpb24gcGF1c2VkIGF0ICR7ZXZlbnQuc3RhZ2VOYW1lfS5gO1xuICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gICAgICB0eXBlOiAncGF1c2UnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkID8/IGV2ZW50LnN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8ucnVudGltZVN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgfVxuXG4gIG9uUmVzdW1lKGV2ZW50OiBSZXN1bWVFdmVudCB8IEZsb3dSZXN1bWVFdmVudCk6IHZvaWQge1xuICAgIC8vIFNhbWUgaXNGbG93RXZlbnQgZGlzY3JpbWluYW50IGFzIG9uUGF1c2Ug4oCUIGlnbm9yZSBzY29wZSBSZXN1bWVFdmVudC5cbiAgICBpZiAoIWlzRmxvd0V2ZW50KGV2ZW50KSkgcmV0dXJuO1xuICAgIGlmICghZXZlbnQuc3RhZ2VOYW1lIHx8ICFldmVudC5zdGFnZUlkKSByZXR1cm47XG4gICAgY29uc3Qgc3VmZml4ID0gZXZlbnQuaGFzSW5wdXQgPyAnIHdpdGggaW5wdXQuJyA6ICcuJztcbiAgICBjb25zdCB0ZXh0ID0gYEV4ZWN1dGlvbiByZXN1bWVkIGF0ICR7ZXZlbnQuc3RhZ2VOYW1lfSR7c3VmZml4fWA7XG4gICAgdGhpcy5zdG9yZS5wdXNoKHtcbiAgICAgIHR5cGU6ICdyZXN1bWUnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkID8/IGV2ZW50LnN0YWdlSWQsXG4gICAgICBydW50aW1lU3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8ucnVudGltZVN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgfVxuXG4gIG9uRXJyb3IoZXZlbnQ6IEVycm9yRXZlbnQgfCBGbG93RXJyb3JFdmVudCk6IHZvaWQge1xuICAgIC8vIE5hcnJhdGl2ZSBvbmx5IHN1cmZhY2VzIHRoZSBjb250cm9sLWZsb3cgdmFyaWFudCBvZiBlcnJvcnMgKGhhc1xuICAgIC8vIHN0YWdlTmFtZSArIG1lc3NhZ2UpLiBTY29wZS1sZXZlbCBFcnJvckV2ZW50IGlzIGNhcHR1cmVkIGVsc2V3aGVyZS5cbiAgICBpZiAoIWlzRmxvd0V2ZW50KGV2ZW50KSkgcmV0dXJuO1xuICAgIGlmICh0eXBlb2YgZXZlbnQubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybjtcblxuICAgIGxldCB2YWxpZGF0aW9uSXNzdWVzOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgaWYgKGV2ZW50LnN0cnVjdHVyZWRFcnJvcj8uaXNzdWVzPy5sZW5ndGgpIHtcbiAgICAgIHZhbGlkYXRpb25Jc3N1ZXMgPSBldmVudC5zdHJ1Y3R1cmVkRXJyb3IuaXNzdWVzXG4gICAgICAgIC5tYXAoKGlzc3VlKSA9PiB7XG4gICAgICAgICAgY29uc3QgcGF0aCA9IGlzc3VlLnBhdGgubGVuZ3RoID4gMCA/IGlzc3VlLnBhdGguam9pbignLicpIDogJyhyb290KSc7XG4gICAgICAgICAgcmV0dXJuIGAke3BhdGh9OiAke2lzc3VlLm1lc3NhZ2V9YDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oJzsgJyk7XG4gICAgfVxuXG4gICAgY29uc3QgY3R4OiBFcnJvclJlbmRlckNvbnRleHQgPSB7XG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSxcbiAgICAgIG1lc3NhZ2U6IGV2ZW50Lm1lc3NhZ2UsXG4gICAgICB2YWxpZGF0aW9uSXNzdWVzLFxuICAgIH07XG4gICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlckVycm9yPy4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJFcnJvcihjdHgpO1xuICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gICAgICB0eXBlOiAnZXJyb3InLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgcnVudGltZVN0YWdlSWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICAvLyDilIDilIAgRW1pdCBjaGFubmVsIChQaGFzZSAzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogUmVjZWl2ZSBhIGNvbnN1bWVyLWVtaXR0ZWQgZXZlbnQgZnJvbSBgc2NvcGUuJGVtaXQobmFtZSwgcGF5bG9hZClgLlxuICAgKlxuICAgKiBCdWZmZXJlZCBhbG9uZ3NpZGUgYG9uUmVhZGAvYG9uV3JpdGVgIHBlci1zdGFnZSBzbyB0aGF0IHRoZSBmaW5hbFxuICAgKiBuYXJyYXRpdmUgcHJlc2VydmVzIG9yZGVyaW5nOlxuICAgKlxuICAgKiAgIDEuIHN0YWdlIGhlYWRlciAoZW1pdHRlZCBieSBgb25TdGFnZUV4ZWN1dGVkYCAvIGBvbkRlY2lzaW9uYClcbiAgICogICAyLiBidWZmZXJlZCBvcHMgZm9yIHRoYXQgc3RhZ2Ug4oCUIGluIGNhbGwgb3JkZXIg4oCUIGZsdXNoZWQgcmlnaHQgYWZ0ZXJcbiAgICpcbiAgICogV2l0aG91dCBidWZmZXJpbmcsIGVtaXQgZXZlbnRzIHdvdWxkIGZpcmUgQkVGT1JFIHRoZSBzdGFnZSBoZWFkZXJcbiAgICogKHdoaWNoIG9ubHkgbGFuZHMgYXQgYG9uU3RhZ2VFeGVjdXRlZGApLCBwcm9kdWNpbmcgb3V0LW9mLW9yZGVyXG4gICAqIG5hcnJhdGl2ZSBlbnRyaWVzLiBGbHVzaCBoYXBwZW5zIGluIGBmbHVzaE9wc2Agd2hpY2ggcm91dGVzIGBlbWl0YC1cbiAgICogdHlwZWQgYnVmZmVyZWQgb3BzIHRocm91Z2ggYHJlbmRlckVtaXRgIGluc3RlYWQgb2YgYHJlbmRlck9wYC5cbiAgICovXG4gIG9uRW1pdChldmVudDogRW1pdEV2ZW50KTogdm9pZCB7XG4gICAgdGhpcy5idWZmZXJPcChldmVudC5ydW50aW1lU3RhZ2VJZCwge1xuICAgICAgdHlwZTogJ2VtaXQnLFxuICAgICAga2V5OiBldmVudC5uYW1lLFxuICAgICAgcmF3VmFsdWU6IGV2ZW50LnBheWxvYWQsXG4gICAgICBlbWl0RXZlbnQ6IGV2ZW50LFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyRW1pdChjdHg6IEVtaXRSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gYFtlbWl0XSAke2N0eC5uYW1lfTogJHtjdHgucGF5bG9hZFN1bW1hcnl9YDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBPdXRwdXQgKG5hcnJhdGl2ZS1zcGVjaWZpYykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFJldHVybnMgZW50cmllcyBncm91cGVkIGJ5IHN1YmZsb3dJZCBmb3Igc3RydWN0dXJlZCBhY2Nlc3MuXG4gICAqIFJvb3QtbGV2ZWwgZW50cmllcyBoYXZlIHN1YmZsb3dJZCA9IHVuZGVmaW5lZC5cbiAgICovXG4gIGdldEVudHJpZXNCeVN1YmZsb3coKTogUmVjb3JkPHN0cmluZywgQ29tYmluZWROYXJyYXRpdmVFbnRyeVtdPiB7XG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5W10+ID0geyAnJzogW10gfTtcbiAgICB0aGlzLnN0b3JlLmZvckVhY2goKGVudHJ5KSA9PiB7XG4gICAgICBjb25zdCBrZXkgPSBlbnRyeS5zdWJmbG93SWQgPz8gJyc7XG4gICAgICBpZiAoIXJlc3VsdFtrZXldKSByZXN1bHRba2V5XSA9IFtdO1xuICAgICAgcmVzdWx0W2tleV0ucHVzaChlbnRyeSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBTZXF1ZW5jZSBxdWVyeSBBUEkgKGRlbGVnYXRlcyB0byB0aGUgY29tcG9zZWQgc3RvcmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBBbGwgbmFycmF0aXZlIGVudHJpZXMgaW4gZXhlY3V0aW9uIG9yZGVyLiAqL1xuICBnZXRFbnRyaWVzKCk6IENvbWJpbmVkTmFycmF0aXZlRW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0QWxsKCk7XG4gIH1cblxuICAvKiogVG90YWwgbnVtYmVyIG9mIG5hcnJhdGl2ZSBlbnRyaWVzLiAqL1xuICBnZXQgZW50cnlDb3VudCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLnNpemU7XG4gIH1cblxuICAvKiogTygxKSBsb29rdXA6IGFsbCBuYXJyYXRpdmUgZW50cmllcyBmb3Igb25lIGV4ZWN1dGlvbiBzdGVwLiAqL1xuICBnZXRFbnRyaWVzRm9yU3RlcChydW50aW1lU3RhZ2VJZDogc3RyaW5nKTogQ29tYmluZWROYXJyYXRpdmVFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5zdG9yZS5nZXRCeUtleShydW50aW1lU3RhZ2VJZCk7XG4gIH1cblxuICAvKiogTnVtYmVyIG9mIGRpc3RpbmN0IGV4ZWN1dGlvbiBzdGVwcyB0aGF0IHByb2R1Y2VkIGVudHJpZXMuICovXG4gIGdldCBzdGVwQ291bnQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5zdG9yZS5rZXlDb3VudDtcbiAgfVxuXG4gIC8qKiBQcmUtYnVpbHQgcGVyLXN0ZXAgcmFuZ2UgaW5kZXgg4oCUIE8oMSkgbG9va3VwcyBmb3IgdGltZS10cmF2ZWwgc2NydWJiaW5nLiAqL1xuICBnZXRFbnRyeVJhbmdlcygpOiBSZWFkb25seU1hcDxzdHJpbmcsIHsgcmVhZG9ubHkgZmlyc3RJZHg6IG51bWJlcjsgcmVhZG9ubHkgZW5kSWR4OiBudW1iZXIgfT4ge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldEVudHJ5UmFuZ2VzKCk7XG4gIH1cblxuICAvKiogUmVkdWNlIEFMTCBlbnRyaWVzIHRvIGEgc2luZ2xlIHZhbHVlLiAqL1xuICBhZ2dyZWdhdGU8Uj4oZm46IChhY2M6IFIsIGVudHJ5OiBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5KSA9PiBSLCBpbml0aWFsOiBSKTogUiB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuYWdncmVnYXRlKGZuLCBpbml0aWFsKTtcbiAgfVxuXG4gIC8qKiBSZWR1Y2UgZW50cmllcywgb3B0aW9uYWxseSBmaWx0ZXJlZCB0byBhIHNldCBvZiB2aXNpYmxlIHJ1bnRpbWVTdGFnZUlkcy4gKi9cbiAgYWNjdW11bGF0ZTxSPihmbjogKGFjYzogUiwgZW50cnk6IENvbWJpbmVkTmFycmF0aXZlRW50cnkpID0+IFIsIGluaXRpYWw6IFIsIGtleXM/OiBSZWFkb25seVNldDxzdHJpbmc+KTogUiB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuYWNjdW11bGF0ZShmbiwgaW5pdGlhbCwga2V5cyk7XG4gIH1cblxuICAvKiogUHJvZ3Jlc3NpdmUgcmV2ZWFsOiBlbnRyaWVzIHdob3NlIHJ1bnRpbWVTdGFnZUlkIGlzIGluIHRoZSB2aXNpYmxlIHNldC4gKi9cbiAgZ2V0RW50cmllc1VwVG8odmlzaWJsZUlkczogUmVhZG9ubHlTZXQ8c3RyaW5nPik6IENvbWJpbmVkTmFycmF0aXZlRW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0RW50cmllc1VwVG8odmlzaWJsZUlkcyk7XG4gIH1cblxuICAvKiogQ2xlYXJzIGFsbCBzdGF0ZS4gQ2FsbGVkIGF1dG9tYXRpY2FsbHkgYmVmb3JlIGVhY2ggcnVuLiAqL1xuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3JlLmNsZWFyKCk7XG4gICAgdGhpcy5wZW5kaW5nT3BzLmNsZWFyKCk7XG4gICAgdGhpcy5zdGFnZUNvdW50ZXJzLmNsZWFyKCk7XG4gICAgdGhpcy5maXJzdFN0YWdlRmxhZ3MuY2xlYXIoKTtcbiAgICB0aGlzLnN0YWdlVmlzaXRDb3VudHMuY2xlYXIoKTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBQcml2YXRlIGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSBpbmNyZW1lbnRTdGFnZUNvdW50ZXIoc3ViZmxvd0tleTogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBjb25zdCBjdXJyZW50ID0gdGhpcy5zdGFnZUNvdW50ZXJzLmdldChzdWJmbG93S2V5KSA/PyAwO1xuICAgIGNvbnN0IG5leHQgPSBjdXJyZW50ICsgMTtcbiAgICB0aGlzLnN0YWdlQ291bnRlcnMuc2V0KHN1YmZsb3dLZXksIG5leHQpO1xuICAgIHJldHVybiBuZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBjb25zdW1lRmlyc3RTdGFnZUZsYWcoc3ViZmxvd0tleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKCF0aGlzLmZpcnN0U3RhZ2VGbGFncy5oYXMoc3ViZmxvd0tleSkpIHtcbiAgICAgIHRoaXMuZmlyc3RTdGFnZUZsYWdzLnNldChzdWJmbG93S2V5LCBmYWxzZSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcHJpdmF0ZSBidWZmZXJPcChydW50aW1lU3RhZ2VJZDogc3RyaW5nLCBvcDogT21pdDxCdWZmZXJlZE9wLCAnc3RlcE51bWJlcic+KTogdm9pZCB7XG4gICAgbGV0IG9wcyA9IHRoaXMucGVuZGluZ09wcy5nZXQocnVudGltZVN0YWdlSWQpO1xuICAgIGlmICghb3BzKSB7XG4gICAgICBvcHMgPSBbXTtcbiAgICAgIHRoaXMucGVuZGluZ09wcy5zZXQocnVudGltZVN0YWdlSWQsIG9wcyk7XG4gICAgfVxuICAgIG9wcy5wdXNoKHsgLi4ub3AsIHN0ZXBOdW1iZXI6IG9wcy5sZW5ndGggKyAxIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBmbHVzaE9wcyhydW50aW1lU3RhZ2VJZDogc3RyaW5nIHwgdW5kZWZpbmVkLCBzdWJmbG93SWQ/OiBzdHJpbmcsIHN0YWdlSWQ/OiBzdHJpbmcsIHN0YWdlTmFtZT86IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChydW50aW1lU3RhZ2VJZCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgY29uc3Qgb3BzID0gdGhpcy5wZW5kaW5nT3BzLmdldChydW50aW1lU3RhZ2VJZCk7XG4gICAgaWYgKCFvcHMgfHwgb3BzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgZm9yIChjb25zdCBvcCBvZiBvcHMpIHtcbiAgICAgIC8vIOKUgOKUgCBFbWl0IGV2ZW50cyB0YWtlIGEgZGlmZmVyZW50IHJlbmRlciBwYXRoIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgICAgLy9cbiAgICAgIC8vIEVtaXQgZXZlbnRzIGFyZSBidWZmZXJlZCBhbG9uZ3NpZGUgcmVhZHMvd3JpdGVzIChzbyB0aGV5IGFwcGVhclxuICAgICAgLy8gdW5kZXIgdGhlaXIgb3duaW5nIHN0YWdlJ3MgaGVhZGVyIGluIG5hcnJhdGl2ZSBvcmRlciwgbm90IGlubGluZVxuICAgICAgLy8gYXQgY2FsbCB0aW1lKS4gQXQgZmx1c2gsIHRoZXkgcm91dGUgdGhyb3VnaCBgcmVuZGVyRW1pdGAgaW5zdGVhZFxuICAgICAgLy8gb2YgYHJlbmRlck9wYCDigJQgY29uc3VtZXJzIHdhbnRpbmcgY3VzdG9tIGVtaXQgcmVuZGVyaW5nIGltcGxlbWVudFxuICAgICAgLy8gdGhlIGRlZGljYXRlZCBob29rLiBVbmhhbmRsZWQgLyBtaXNzaW5nIHJlbmRlcmVyIGZhbGxzIGJhY2sgdG9cbiAgICAgIC8vIHRoZSBzYW1lIGNvbXBhY3QgYFtlbWl0XSBuYW1lOiBwYXlsb2FkU3VtbWFyeWAgZGVmYXVsdCB1c2VkIGJ5XG4gICAgICAvLyB0aGUgcHJlLWJ1ZmZlcmluZyBvbkVtaXQgcGF0aC5cbiAgICAgIGlmIChvcC50eXBlID09PSAnZW1pdCcgJiYgb3AuZW1pdEV2ZW50KSB7XG4gICAgICAgIGNvbnN0IGUgPSBvcC5lbWl0RXZlbnQ7XG4gICAgICAgIGNvbnN0IHBheWxvYWRTdW1tYXJ5ID0gdGhpcy5mb3JtYXRWYWx1ZShlLnBheWxvYWQsIHRoaXMubWF4VmFsdWVMZW5ndGgpO1xuICAgICAgICBjb25zdCBlbWl0Q3R4OiBFbWl0UmVuZGVyQ29udGV4dCA9IHtcbiAgICAgICAgICBuYW1lOiBlLm5hbWUsXG4gICAgICAgICAgcGF5bG9hZDogZS5wYXlsb2FkLFxuICAgICAgICAgIHN0YWdlTmFtZTogZS5zdGFnZU5hbWUsXG4gICAgICAgICAgcnVudGltZVN0YWdlSWQ6IGUucnVudGltZVN0YWdlSWQsXG4gICAgICAgICAgc3ViZmxvd1BhdGg6IGUuc3ViZmxvd1BhdGgsXG4gICAgICAgICAgcGlwZWxpbmVJZDogZS5waXBlbGluZUlkLFxuICAgICAgICAgIHRpbWVzdGFtcDogZS50aW1lc3RhbXAsXG4gICAgICAgICAgcGF5bG9hZFN1bW1hcnksXG4gICAgICAgIH07XG4gICAgICAgIGxldCBlbWl0VGV4dDogc3RyaW5nO1xuICAgICAgICBpZiAodGhpcy5yZW5kZXJlcj8ucmVuZGVyRW1pdCkge1xuICAgICAgICAgIGNvbnN0IGN1c3RvbSA9IHRoaXMucmVuZGVyZXIucmVuZGVyRW1pdChlbWl0Q3R4KTtcbiAgICAgICAgICBpZiAoY3VzdG9tID09PSBudWxsKSBjb250aW51ZTsgLy8gZGVsaWJlcmF0ZWx5IGV4Y2x1ZGVkXG4gICAgICAgICAgZW1pdFRleHQgPSBjdXN0b20gIT09IHVuZGVmaW5lZCA/IGN1c3RvbSA6IHRoaXMuZGVmYXVsdFJlbmRlckVtaXQoZW1pdEN0eCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZW1pdFRleHQgPSB0aGlzLmRlZmF1bHRSZW5kZXJFbWl0KGVtaXRDdHgpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuc3RvcmUucHVzaCh7XG4gICAgICAgICAgdHlwZTogJ2VtaXQnLFxuICAgICAgICAgIHRleHQ6IGVtaXRUZXh0LFxuICAgICAgICAgIGRlcHRoOiAxLFxuICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICBzdGFnZUlkLFxuICAgICAgICAgIHJ1bnRpbWVTdGFnZUlkLFxuICAgICAgICAgIHN0ZXBOdW1iZXI6IG9wLnN0ZXBOdW1iZXIsXG4gICAgICAgICAgc3ViZmxvd0lkLFxuICAgICAgICB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIEF0IHRoaXMgcG9pbnQgb3AudHlwZSBpcyBuYXJyb3dlZCB0byAncmVhZCcgfCAnd3JpdGUnIChlbWl0IGJyYW5jaFxuICAgICAgLy8gYWJvdmUgdXNlcyBgY29udGludWVgKS4gVHlwZVNjcmlwdCBjYW4ndCBmb2xsb3cgdGhhdCBuYXJyb3dpbmdcbiAgICAgIC8vIHRocm91Z2ggdGhlIGNvbnRpbnVlLCBzbyB3ZSBhc3NlcnQgYXQgcmVuZGVyIHRpbWUuXG4gICAgICBjb25zdCBvcFR5cGUgPSBvcC50eXBlIGFzICdyZWFkJyB8ICd3cml0ZSc7XG4gICAgICBjb25zdCB2YWx1ZVN1bW1hcnkgPSB0aGlzLmZvcm1hdFZhbHVlKG9wLnJhd1ZhbHVlLCB0aGlzLm1heFZhbHVlTGVuZ3RoKTtcbiAgICAgIGNvbnN0IG9wQ3R4OiBPcFJlbmRlckNvbnRleHQgPSB7XG4gICAgICAgIHR5cGU6IG9wVHlwZSxcbiAgICAgICAga2V5OiBvcC5rZXksXG4gICAgICAgIHJhd1ZhbHVlOiBvcC5yYXdWYWx1ZSxcbiAgICAgICAgdmFsdWVTdW1tYXJ5LFxuICAgICAgICBvcGVyYXRpb246IG9wLm9wZXJhdGlvbixcbiAgICAgICAgc3RlcE51bWJlcjogb3Auc3RlcE51bWJlcixcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJPcCA/IHRoaXMucmVuZGVyZXIucmVuZGVyT3Aob3BDdHgpIDogdGhpcy5kZWZhdWx0UmVuZGVyT3Aob3BDdHgpO1xuXG4gICAgICBpZiAodGV4dCA9PSBudWxsKSBjb250aW51ZTtcblxuICAgICAgdGhpcy5zdG9yZS5wdXNoKHtcbiAgICAgICAgdHlwZTogJ3N0ZXAnLFxuICAgICAgICB0ZXh0LFxuICAgICAgICBkZXB0aDogMSxcbiAgICAgICAgc3RhZ2VOYW1lLFxuICAgICAgICBzdGFnZUlkLFxuICAgICAgICBydW50aW1lU3RhZ2VJZCxcbiAgICAgICAgc3RlcE51bWJlcjogb3Auc3RlcE51bWJlcixcbiAgICAgICAgc3ViZmxvd0lkLFxuICAgICAgICBrZXk6IG9wLmtleSxcbiAgICAgICAgcmF3VmFsdWU6IG9wLnJhd1ZhbHVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5wZW5kaW5nT3BzLmRlbGV0ZShydW50aW1lU3RhZ2VJZCk7XG4gIH1cblxuICAvLyDilIDilIAgRGVmYXVsdCByZW5kZXJlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyU3RhZ2UoY3R4OiBTdGFnZVJlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIGxldCBpbm5lcjogc3RyaW5nO1xuICAgIGlmIChjdHguaXNGaXJzdCkge1xuICAgICAgaW5uZXIgPSBjdHguZGVzY3JpcHRpb24gPyBgVGhlIHByb2Nlc3MgYmVnYW46ICR7Y3R4LmRlc2NyaXB0aW9ufS5gIDogYFRoZSBwcm9jZXNzIGJlZ2FuIHdpdGggJHtjdHguc3RhZ2VOYW1lfS5gO1xuICAgIH0gZWxzZSBpZiAoY3R4Lmxvb3BJdGVyYXRpb24gJiYgY3R4Lmxvb3BJdGVyYXRpb24gPiAwKSB7XG4gICAgICBpbm5lciA9IGN0eC5kZXNjcmlwdGlvblxuICAgICAgICA/IGBMb29wZWQgYmFjazogJHtjdHguZGVzY3JpcHRpb259IChwYXNzICR7Y3R4Lmxvb3BJdGVyYXRpb259KS5gXG4gICAgICAgIDogYExvb3BlZCBiYWNrIHRvICR7Y3R4LnN0YWdlTmFtZX0gKHBhc3MgJHtjdHgubG9vcEl0ZXJhdGlvbn0pLmA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlubmVyID0gY3R4LmRlc2NyaXB0aW9uID8gYE5leHQgc3RlcDogJHtjdHguZGVzY3JpcHRpb259LmAgOiBgTmV4dCwgaXQgbW92ZWQgb24gdG8gJHtjdHguc3RhZ2VOYW1lfS5gO1xuICAgIH1cbiAgICByZXR1cm4gYFN0YWdlICR7Y3R4LnN0YWdlTnVtYmVyfTogJHtpbm5lcn1gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyT3AoY3R4OiBPcFJlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIGNvbnN0IHN0ZXBQcmVmaXggPSB0aGlzLmluY2x1ZGVTdGVwTnVtYmVycyA/IGBTdGVwICR7Y3R4LnN0ZXBOdW1iZXJ9OiBgIDogJyc7XG4gICAgaWYgKGN0eC50eXBlID09PSAncmVhZCcpIHtcbiAgICAgIHJldHVybiB0aGlzLmluY2x1ZGVWYWx1ZXMgJiYgY3R4LnZhbHVlU3VtbWFyeVxuICAgICAgICA/IGAke3N0ZXBQcmVmaXh9UmVhZCAke2N0eC5rZXl9ID0gJHtjdHgudmFsdWVTdW1tYXJ5fWBcbiAgICAgICAgOiBgJHtzdGVwUHJlZml4fVJlYWQgJHtjdHgua2V5fWA7XG4gICAgfVxuICAgIGlmIChjdHgub3BlcmF0aW9uID09PSAnZGVsZXRlJykge1xuICAgICAgcmV0dXJuIGAke3N0ZXBQcmVmaXh9RGVsZXRlICR7Y3R4LmtleX1gO1xuICAgIH1cbiAgICBpZiAoY3R4Lm9wZXJhdGlvbiA9PT0gJ3VwZGF0ZScpIHtcbiAgICAgIHJldHVybiB0aGlzLmluY2x1ZGVWYWx1ZXNcbiAgICAgICAgPyBgJHtzdGVwUHJlZml4fVVwZGF0ZSAke2N0eC5rZXl9ID0gJHtjdHgudmFsdWVTdW1tYXJ5fWBcbiAgICAgICAgOiBgJHtzdGVwUHJlZml4fVVwZGF0ZSAke2N0eC5rZXl9YDtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuaW5jbHVkZVZhbHVlcyA/IGAke3N0ZXBQcmVmaXh9V3JpdGUgJHtjdHgua2V5fSA9ICR7Y3R4LnZhbHVlU3VtbWFyeX1gIDogYCR7c3RlcFByZWZpeH1Xcml0ZSAke2N0eC5rZXl9YDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlckRlY2lzaW9uKGN0eDogRGVjaXNpb25SZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICBjb25zdCBicmFuY2hOYW1lID0gY3R4LmNob3NlbjtcbiAgICBsZXQgY29uZGl0aW9uVGV4dDogc3RyaW5nO1xuICAgIGlmIChjdHguZXZpZGVuY2UpIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG4gICAgICBjb25zdCBldmlkZW5jZSA9IGN0eC5ldmlkZW5jZSBhcyBhbnk7XG4gICAgICBjb25zdCBtYXRjaGVkUnVsZSA9IGV2aWRlbmNlLnJ1bGVzPy5maW5kKChyOiBhbnkpID0+IHIubWF0Y2hlZCk7XG4gICAgICBpZiAobWF0Y2hlZFJ1bGUpIHtcbiAgICAgICAgY29uc3QgbGFiZWwgPSBtYXRjaGVkUnVsZS5sYWJlbCA/IGAgXCIke21hdGNoZWRSdWxlLmxhYmVsfVwiYCA6ICcnO1xuICAgICAgICBpZiAobWF0Y2hlZFJ1bGUudHlwZSA9PT0gJ2ZpbHRlcicpIHtcbiAgICAgICAgICBjb25zdCBwYXJ0cyA9IG1hdGNoZWRSdWxlLmNvbmRpdGlvbnMubWFwKFxuICAgICAgICAgICAgKGM6IGFueSkgPT5cbiAgICAgICAgICAgICAgYCR7Yy5rZXl9ICR7Yy5hY3R1YWxTdW1tYXJ5fSAke2Mub3B9ICR7SlNPTi5zdHJpbmdpZnkoYy50aHJlc2hvbGQpfSAke2MucmVzdWx0ID8gJ1xcdTI3MTMnIDogJ1xcdTI3MTcnfWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25kaXRpb25UZXh0ID0gYEl0IGV2YWx1YXRlZCBSdWxlICR7bWF0Y2hlZFJ1bGUucnVsZUluZGV4fSR7bGFiZWx9OiAke3BhcnRzLmpvaW4oXG4gICAgICAgICAgICAnLCAnLFxuICAgICAgICAgICl9LCBhbmQgY2hvc2UgJHticmFuY2hOYW1lfS5gO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IHBhcnRzID0gbWF0Y2hlZFJ1bGUuaW5wdXRzLm1hcCgoaTogYW55KSA9PiBgJHtpLmtleX09JHtpLnZhbHVlU3VtbWFyeX1gKTtcbiAgICAgICAgICBjb25kaXRpb25UZXh0ID0gYEl0IGV4YW1pbmVkJHtsYWJlbH06ICR7cGFydHMuam9pbignLCAnKX0sIGFuZCBjaG9zZSAke2JyYW5jaE5hbWV9LmA7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGVycm9yZWRDb3VudCA9IGV2aWRlbmNlLnJ1bGVzPy5maWx0ZXIoKHI6IGFueSkgPT4gci5tYXRjaEVycm9yICE9PSB1bmRlZmluZWQpLmxlbmd0aCA/PyAwO1xuICAgICAgICBjb25zdCBlcnJvck5vdGUgPSBlcnJvcmVkQ291bnQgPiAwID8gYCAoJHtlcnJvcmVkQ291bnR9IHJ1bGUke2Vycm9yZWRDb3VudCA+IDEgPyAncycgOiAnJ30gdGhyZXcgZXJyb3JzKWAgOiAnJztcbiAgICAgICAgY29uZGl0aW9uVGV4dCA9IGBObyBydWxlcyBtYXRjaGVkJHtlcnJvck5vdGV9LCBmZWxsIGJhY2sgdG8gZGVmYXVsdDogJHticmFuY2hOYW1lfS5gO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoY3R4LmRlc2NyaXB0aW9uICYmIGN0eC5yYXRpb25hbGUpIHtcbiAgICAgIGNvbmRpdGlvblRleHQgPSBgSXQgJHtjdHguZGVzY3JpcHRpb259OiAke2N0eC5yYXRpb25hbGV9LCBzbyBpdCBjaG9zZSAke2JyYW5jaE5hbWV9LmA7XG4gICAgfSBlbHNlIGlmIChjdHguZGVzY3JpcHRpb24pIHtcbiAgICAgIGNvbmRpdGlvblRleHQgPSBgSXQgJHtjdHguZGVzY3JpcHRpb259IGFuZCBjaG9zZSAke2JyYW5jaE5hbWV9LmA7XG4gICAgfSBlbHNlIGlmIChjdHgucmF0aW9uYWxlKSB7XG4gICAgICBjb25kaXRpb25UZXh0ID0gYEEgZGVjaXNpb24gd2FzIG1hZGU6ICR7Y3R4LnJhdGlvbmFsZX0sIHNvIHRoZSBwYXRoIHRha2VuIHdhcyAke2JyYW5jaE5hbWV9LmA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbmRpdGlvblRleHQgPSBgQSBkZWNpc2lvbiB3YXMgbWFkZSwgYW5kIHRoZSBwYXRoIHRha2VuIHdhcyAke2JyYW5jaE5hbWV9LmA7XG4gICAgfVxuICAgIHJldHVybiBgW0NvbmRpdGlvbl06ICR7Y29uZGl0aW9uVGV4dH1gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyRm9yayhjdHg6IEZvcmtSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICBjb25zdCBuYW1lcyA9IGN0eC5jaGlsZHJlbi5qb2luKCcsICcpO1xuICAgIHJldHVybiBgW1BhcmFsbGVsXTogRm9ya2luZyBpbnRvICR7Y3R4LmNoaWxkcmVuLmxlbmd0aH0gcGFyYWxsZWwgcGF0aHM6ICR7bmFtZXN9LmA7XG4gIH1cblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJTZWxlY3RlZChjdHg6IFNlbGVjdGVkUmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgaWYgKGN0eC5ldmlkZW5jZSkge1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgICAgIGNvbnN0IGV2aWRlbmNlID0gY3R4LmV2aWRlbmNlIGFzIGFueTtcbiAgICAgIGNvbnN0IG1hdGNoZWQgPSBldmlkZW5jZS5ydWxlcz8uZmlsdGVyKChyOiBhbnkpID0+IHIubWF0Y2hlZCkgPz8gW107XG4gICAgICBjb25zdCBwYXJ0cyA9IG1hdGNoZWQubWFwKChyOiBhbnkpID0+IHtcbiAgICAgICAgY29uc3QgbGFiZWwgPSByLmxhYmVsID8gYCBcIiR7ci5sYWJlbH1cImAgOiAnJztcbiAgICAgICAgaWYgKHIudHlwZSA9PT0gJ2ZpbHRlcicpIHtcbiAgICAgICAgICBjb25zdCBjb25kcyA9IHIuY29uZGl0aW9uc1xuICAgICAgICAgICAgLm1hcChcbiAgICAgICAgICAgICAgKGM6IGFueSkgPT5cbiAgICAgICAgICAgICAgICBgJHtjLmtleX0gJHtjLmFjdHVhbFN1bW1hcnl9ICR7Yy5vcH0gJHtKU09OLnN0cmluZ2lmeShjLnRocmVzaG9sZCl9ICR7Yy5yZXN1bHQgPyAnXFx1MjcxMycgOiAnXFx1MjcxNyd9YCxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC5qb2luKCcsICcpO1xuICAgICAgICAgIHJldHVybiBgJHtyLmJyYW5jaH0ke2xhYmVsfSAoJHtjb25kc30pYDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBpbnB1dHMgPSByLmlucHV0cy5tYXAoKGk6IGFueSkgPT4gYCR7aS5rZXl9PSR7aS52YWx1ZVN1bW1hcnl9YCkuam9pbignLCAnKTtcbiAgICAgICAgcmV0dXJuIGAke3IuYnJhbmNofSR7bGFiZWx9ICgke2lucHV0c30pYDtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGBbU2VsZWN0ZWRdOiAke2N0eC5zZWxlY3RlZC5sZW5ndGh9IG9mICR7Y3R4LnRvdGFsfSBwYXRocyBzZWxlY3RlZDogJHtwYXJ0cy5qb2luKCc7ICcpfS5gO1xuICAgIH1cbiAgICBjb25zdCBuYW1lcyA9IGN0eC5zZWxlY3RlZC5qb2luKCcsICcpO1xuICAgIHJldHVybiBgW1NlbGVjdGVkXTogJHtjdHguc2VsZWN0ZWQubGVuZ3RofSBvZiAke2N0eC50b3RhbH0gcGF0aHMgc2VsZWN0ZWQgZm9yIGV4ZWN1dGlvbjogJHtuYW1lc30uYDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlclN1YmZsb3coY3R4OiBTdWJmbG93UmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgaWYgKGN0eC5kaXJlY3Rpb24gPT09ICdleGl0Jykge1xuICAgICAgcmV0dXJuIGBFeGl0aW5nIHRoZSAke2N0eC5uYW1lfSBzdWJmbG93LmA7XG4gICAgfVxuICAgIHJldHVybiBjdHguZGVzY3JpcHRpb24gPyBgRW50ZXJpbmcgJHtjdHgubmFtZX06ICR7Y3R4LmRlc2NyaXB0aW9ufS5gIDogYEVudGVyaW5nIHRoZSAke2N0eC5uYW1lfSBzdWJmbG93LmA7XG4gIH1cblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJMb29wKGN0eDogTG9vcFJlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIHJldHVybiBjdHguZGVzY3JpcHRpb25cbiAgICAgID8gYE9uIHBhc3MgJHtjdHguaXRlcmF0aW9ufTogJHtjdHguZGVzY3JpcHRpb259IGFnYWluLmBcbiAgICAgIDogYE9uIHBhc3MgJHtjdHguaXRlcmF0aW9ufSB0aHJvdWdoICR7Y3R4LnRhcmdldH0uYDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlckJyZWFrKGN0eDogQnJlYWtSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gYEV4ZWN1dGlvbiBzdG9wcGVkIGF0ICR7Y3R4LnN0YWdlTmFtZX0uYDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlckVycm9yKGN0eDogRXJyb3JSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICBsZXQgdGV4dCA9IGBBbiBlcnJvciBvY2N1cnJlZCBhdCAke2N0eC5zdGFnZU5hbWV9OiAke2N0eC5tZXNzYWdlfS5gO1xuICAgIGlmIChjdHgudmFsaWRhdGlvbklzc3Vlcykge1xuICAgICAgdGV4dCArPSBgIFZhbGlkYXRpb24gaXNzdWVzOiAke2N0eC52YWxpZGF0aW9uSXNzdWVzfS5gO1xuICAgIH1cbiAgICByZXR1cm4gYFtFcnJvcl06ICR7dGV4dH1gO1xuICB9XG59XG4iXX0=