/**
 * Sequence — sequential composition of runners (steps chained one after another).
 *
 * Pattern: Builder (GoF) + Adapter over footprintjs's `addSubFlowChartNext`.
 * Role:    core-flow/ layer — pure control flow, no LLM deps.
 *          Each step's output becomes the next step's input; default
 *          mapping is string chaining (step N's return → step N+1's
 *          `{ message }`). Custom mapping via `.mapBetween(fn)` between
 *          any two steps.
 * Emits:   agentfootprint.composition.enter / exit (via compositionRecorder).
 */
import { FlowChartExecutor, flowChart, } from 'footprintjs';
import { RunnerBase, makeRunId } from '../core/RunnerBase.js';
import { ContextRecorder } from '../recorders/core/ContextRecorder.js';
import { streamRecorder } from '../recorders/core/StreamRecorder.js';
import { agentRecorder } from '../recorders/core/AgentRecorder.js';
import { compositionRecorder } from '../recorders/core/CompositionRecorder.js';
import { typedEmit } from '../recorders/core/typedEmit.js';
/** Default string→{message} mapper used between consecutive steps. */
const defaultMapBetween = (prev) => ({ message: prev });
export class Sequence extends RunnerBase {
    name;
    id;
    steps;
    opts;
    currentRunContext = {
        runStartMs: 0,
        runId: 'pending',
        compositionPath: [],
    };
    constructor(opts, steps) {
        super();
        this.opts = opts;
        this.name = opts.name ?? 'Sequence';
        this.id = opts.id ?? 'sequence';
        if (steps.length === 0) {
            throw new Error('Sequence: must have at least one .step()');
        }
        this.steps = steps;
        // Eager chart construction — see `RunnerBase.initChart` JSDoc.
        this.initChart(() => this.buildChart());
    }
    static create(opts = {}) {
        return new SequenceBuilder(opts);
    }
    // `getSpec()` inherited from RunnerBase — returns the cached chart.
    // ─── UI group translation (L1b) ───────────────────────────────
    getGroupTranslator() {
        return this.opts.groupTranslator;
    }
    /** Sequence is a flat ordered list of steps. One member per step,
     *  preserving definition order so the consumer can render them
     *  linearly (default Lens UX). Per-method overrides (L1c) take
     *  precedence over the step runner's own translator. */
    buildUIGroupMetadata() {
        const members = this.steps.map((s) => ({
            memberId: s.id,
            runner: s.runner,
            uiGroup: s.groupTranslator !== undefined
                ? s.runner.getUIGroupWith(s.groupTranslator)
                : s.runner.getUIGroup(),
        }));
        return {
            kind: 'Sequence',
            id: this.id,
            name: this.name,
            members,
        };
    }
    async run(input, options) {
        const executor = this.createExecutor();
        this.lastExecutor = executor;
        const result = await executor.run({
            input: { message: input.message },
            ...(options ?? {}),
        });
        return this.finalizeResult(executor, result);
    }
    async resume(checkpoint, input, options) {
        this.emitPauseResume(checkpoint, input);
        const executor = this.createExecutor();
        const result = await executor.resume(checkpoint, input, options);
        return this.finalizeResult(executor, result);
    }
    createExecutor() {
        this.currentRunContext = {
            runStartMs: Date.now(),
            runId: makeRunId(),
            compositionPath: [`Sequence:${this.id}`],
        };
        // Reuse the cached chart built at constructor time.
        const executor = new FlowChartExecutor(this.getSpec());
        const dispatcher = this.getDispatcher();
        const getRunCtx = () => this.currentRunContext;
        executor.attachCombinedRecorder(new ContextRecorder({ dispatcher, getRunContext: getRunCtx }));
        executor.attachCombinedRecorder(streamRecorder({ dispatcher, getRunContext: getRunCtx }));
        executor.attachCombinedRecorder(agentRecorder({ dispatcher, getRunContext: getRunCtx }));
        executor.attachCombinedRecorder(compositionRecorder({ dispatcher, getRunContext: getRunCtx }));
        for (const r of this.attachedRecorders)
            executor.attachCombinedRecorder(r);
        return executor;
    }
    finalizeResult(executor, result) {
        const paused = this.detectPause(executor, result);
        if (paused)
            return paused;
        if (result instanceof Error)
            throw result;
        if (typeof result === 'string')
            return result;
        throw new Error('Sequence: unexpected result shape — expected string');
    }
    buildChart() {
        const steps = this.steps;
        const compositionId = this.id;
        const compositionName = this.name;
        const seed = (scope) => {
            const args = scope.$getArgs();
            scope.current = args.message;
            typedEmit(scope, 'agentfootprint.composition.enter', {
                kind: 'Sequence',
                id: compositionId,
                name: compositionName,
                childCount: steps.length,
            });
        };
        // Root description prefix `Sequence:` is the taxonomy marker —
        // downstream consumers (Lens, FlowchartRecorder) detect composition
        // primitives via the `<Kind>:` prefix convention. See
        // FlowchartRecorder.mapTopologyToSteps for the consumer side.
        let builder = flowChart('Seed', seed, 'seed', {
            ...(this.opts.structureRecorders !== undefined && {
                structureRecorders: [...this.opts.structureRecorders],
            }),
            description: `Sequence: ${steps.length}-step pipeline`,
        });
        // Mount each step as a subflow via addSubFlowChartNext. The step's
        // input comes from parent.current (mapped via mapFromPrev); the
        // step's return becomes parent.current (via outputMapper).
        for (const step of steps) {
            builder = builder.addSubFlowChartNext(`step-${step.id}`, step.runner.getSpec(), step.id, {
                inputMapper: (parent) => step.mapFromPrev(parent.current ?? ''),
                // `sfOutput` is the subflow's TraversalResult — for Runner-backed
                // subflows whose last stage returns a string, sfOutput IS that
                // string. We pipe it into parent.current for the next step's
                // inputMapper to pick up.
                outputMapper: (sfOutput) => ({
                    current: typeof sfOutput === 'string' ? sfOutput : '',
                }),
            });
        }
        // Final stage: emit composition.exit and return the current string
        // so executor.run() yields it as the TraversalResult.
        builder = builder.addFunction('Finalize', (scope) => {
            const current = scope.current ?? '';
            typedEmit(scope, 'agentfootprint.composition.exit', {
                kind: 'Sequence',
                id: compositionId,
                name: compositionName,
                status: 'ok',
                durationMs: Date.now() - this.currentRunContext.runStartMs,
            });
            return current;
        }, 'finalize', 'Sequence finalize');
        return builder.build();
    }
}
/**
 * Fluent builder. Reads as natural English:
 *   Sequence.create().step('a', A).pipeVia(fn).step('b', B).build()
 *   →  "Sequence: step A, pipe via fn, step B."
 *
 * `step(id, runner)` adds a sequential step. `pipeVia(fn)` customises
 * the transformation of the previous step's output before it feeds the
 * next step (otherwise the default string-chain mapper is used).
 */
export class SequenceBuilder {
    opts;
    steps = [];
    /** Pending pipeVia transformer for the NEXT step (consumed on .step()). */
    pendingPipe;
    seenIds = new Set();
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * Add a step. Runner must accept `{ message: string }` and return `string`.
     * First step receives the Sequence input; subsequent steps receive the
     * previous step's output (via the default string-chain mapper, or via
     * the transformer set by a preceding `.pipeVia(fn)` call).
     *
     * Optional third arg `opts.groupTranslator` overrides the runner's
     * own constructor-level translator for THIS step only — only its
     * `member.uiGroup` flips to the override's output.
     */
    step(id, runner, opts) {
        if (this.seenIds.has(id)) {
            throw new Error(`Sequence.step(): duplicate step id '${id}'`);
        }
        this.seenIds.add(id);
        const mapFromPrev = this.pendingPipe ?? defaultMapBetween;
        this.pendingPipe = undefined;
        this.steps.push({
            id,
            runner,
            mapFromPrev,
            ...(opts?.groupTranslator !== undefined && {
                groupTranslator: opts.groupTranslator,
            }),
        });
        return this;
    }
    /**
     * Transform the previous step's string output before it reaches the
     * next step. Consumed once by the next `.step()` call. Default
     * mapping is `(prev) => ({ message: prev })`.
     *
     * Reads as English: `.step('a', A).pipeVia(fn).step('b', B)`
     * →  "step A, pipe via fn, step B"
     */
    pipeVia(fn) {
        this.pendingPipe = fn;
        return this;
    }
    build() {
        if (this.pendingPipe !== undefined) {
            throw new Error('Sequence.build(): .pipeVia() called with no following .step() to consume it');
        }
        return new Sequence(this.opts, this.steps);
    }
}
//# sourceMappingURL=Sequence.js.map