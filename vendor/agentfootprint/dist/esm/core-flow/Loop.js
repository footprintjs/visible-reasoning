/**
 * Loop — iteration composition: runs a body runner repeatedly until exit.
 *
 * Pattern: Builder (GoF) + Adapter over footprintjs's `loopTo` + `$break`.
 * Role:    core-flow/ layer. Enables Reflection, Self-Refine, Debate,
 *          Reflexion, Constitutional AI, and any pattern needing
 *          iterative refinement of a composition output.
 * Emits:   agentfootprint.composition.enter / exit +
 *          composition.iteration_start / iteration_exit
 *          (via compositionRecorder).
 *
 * Budget guard is MANDATORY. You must set at least one of:
 *   - maxIterations (default 10 if only .body() is set)
 *   - maxWallclockMs
 * Hard ceiling of 500 iterations prevents runaway loops even if a guard
 * misfires; exceeding it throws.
 */
import { FlowChartExecutor, flowChart, } from 'footprintjs';
import { RunnerBase, makeRunId } from '../core/RunnerBase.js';
import { ContextRecorder } from '../recorders/core/ContextRecorder.js';
import { streamRecorder } from '../recorders/core/StreamRecorder.js';
import { agentRecorder } from '../recorders/core/AgentRecorder.js';
import { compositionRecorder } from '../recorders/core/CompositionRecorder.js';
import { typedEmit } from '../recorders/core/typedEmit.js';
const HARD_ITERATION_CAP = 500;
export class Loop extends RunnerBase {
    name;
    id;
    body;
    maxIterations;
    maxWallclockMs;
    until;
    opts;
    /** Per-method translator override on `.repeat()`, when set. Applies
     *  to the body member's `uiGroup`. */
    bodyTranslator;
    currentRunContext = {
        runStartMs: 0,
        runId: 'pending',
        compositionPath: [],
    };
    constructor(opts, body, config) {
        super();
        this.opts = opts;
        this.name = opts.name ?? 'Loop';
        this.id = opts.id ?? 'loop';
        this.body = body;
        this.maxIterations = clampIterations(config.maxIterations);
        this.maxWallclockMs = config.maxWallclockMs;
        this.until = config.until;
        this.bodyTranslator = config.bodyTranslator;
        // Eager chart construction — see `RunnerBase.initChart` JSDoc.
        this.initChart(() => this.buildChart());
    }
    static create(opts = {}) {
        return new LoopBuilder(opts);
    }
    // `getSpec()` inherited from RunnerBase — returns the cached chart.
    // ─── UI group translation (L1b) ───────────────────────────────
    getGroupTranslator() {
        return this.opts.groupTranslator;
    }
    /** Loop has a single body member + iteration budgets in `extra`.
     *  Per-method override (L1c) takes precedence over the body
     *  runner's own translator. */
    buildUIGroupMetadata() {
        const members = [
            {
                memberId: 'body',
                runner: this.body,
                uiGroup: this.bodyTranslator !== undefined
                    ? this.body.getUIGroupWith(this.bodyTranslator)
                    : this.body.getUIGroup(),
            },
        ];
        return {
            kind: 'Loop',
            id: this.id,
            name: this.name,
            members,
            extra: {
                maxIterations: this.maxIterations,
                ...(this.maxWallclockMs !== undefined && {
                    maxWallclockMs: this.maxWallclockMs,
                }),
                hasUntilGuard: this.until !== undefined,
            },
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
            compositionPath: [`Loop:${this.id}`],
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
        throw new Error('Loop: unexpected result shape — expected string');
    }
    buildChart() {
        const body = this.body;
        const maxIterations = this.maxIterations;
        const maxWallclockMs = this.maxWallclockMs;
        const until = this.until;
        const compositionId = this.id;
        const compositionName = this.name;
        const seed = (scope) => {
            const args = scope.$getArgs();
            scope.current = args.message;
            scope.iteration = 0;
            scope.startMs = Date.now();
            typedEmit(scope, 'agentfootprint.composition.enter', {
                kind: 'Loop',
                id: compositionId,
                name: compositionName,
                childCount: 1,
            });
        };
        const iterationStart = (scope) => {
            const next = (scope.iteration ?? 0) + 1;
            scope.iteration = next;
            typedEmit(scope, 'agentfootprint.composition.iteration_start', {
                loopId: compositionId,
                iteration: next,
            });
        };
        /**
         * Guard stage — runs AFTER the body subflow completes each iteration.
         * Checks exit conditions; when any fires, emits iteration_exit with
         * the reason + $break terminates the loop.
         */
        const guard = (scope) => {
            const iteration = scope.iteration;
            const latestOutput = scope.current ?? '';
            const startMs = scope.startMs;
            let exitReason;
            if (iteration >= maxIterations) {
                exitReason = 'budget';
            }
            else if (maxWallclockMs !== undefined && Date.now() - startMs >= maxWallclockMs) {
                exitReason = 'budget';
            }
            else if (iteration >= HARD_ITERATION_CAP) {
                exitReason = 'budget';
            }
            else if (until !== undefined && until({ iteration, latestOutput, startMs })) {
                exitReason = 'guard_false';
            }
            if (exitReason !== undefined) {
                typedEmit(scope, 'agentfootprint.composition.iteration_exit', {
                    loopId: compositionId,
                    iteration,
                    reason: exitReason,
                });
                typedEmit(scope, 'agentfootprint.composition.exit', {
                    kind: 'Loop',
                    id: compositionId,
                    name: compositionName,
                    status: exitReason === 'budget' ? 'budget_exhausted' : 'ok',
                    durationMs: Date.now() - this.currentRunContext.runStartMs,
                });
                // $break stops the flow BEFORE loopTo fires. The latest string
                // output is returned as the executor's TraversalResult.
                scope.$break();
                return latestOutput;
            }
            // Continue looping: emit "body_complete" for the completed iteration
            // before the loopTo takes us back. Next iteration's iterationStart
            // emits iteration_start again.
            typedEmit(scope, 'agentfootprint.composition.iteration_exit', {
                loopId: compositionId,
                iteration,
                reason: 'body_complete',
            });
            return latestOutput;
        };
        // Root description prefix `Loop:` is the taxonomy marker — see
        // FlowchartRecorder.mapTopologyToSteps for the consumer side.
        return flowChart('Initialize', seed, 'seed', {
            ...(this.opts.structureRecorders !== undefined && {
                structureRecorders: [...this.opts.structureRecorders],
            }),
            description: 'Loop: iterated body',
        })
            .addFunction('IterationStart', iterationStart, 'iteration-start', 'Loop iteration marker')
            .addSubFlowChartNext('body', body.getSpec(), 'body', {
            inputMapper: (parent) => ({ message: parent.current ?? '' }),
            // Body's string return becomes next iteration's input via `current`.
            outputMapper: (sfOutput) => ({
                current: typeof sfOutput === 'string' ? sfOutput : '',
            }),
        })
            .addFunction('Guard', guard, 'guard', 'Loop exit-condition guard')
            .loopTo('iteration-start')
            .build();
    }
}
export class LoopBuilder {
    opts;
    _body;
    _bodyTranslator;
    _maxIterations;
    _maxWallclockMs;
    _until;
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * The runner that executes each iteration. Required.
     * Each iteration's output string becomes the next iteration's input `{ message }`.
     *
     * Optional second arg `opts.groupTranslator` overrides the body
     * runner's own translator for THIS loop only — only its
     * `member.uiGroup` flips to the override's output.
     */
    repeat(runner, opts) {
        if (this._body !== undefined) {
            throw new Error('Loop.repeat(): already set');
        }
        this._body = runner;
        if (opts?.groupTranslator !== undefined) {
            this._bodyTranslator = opts.groupTranslator;
        }
        return this;
    }
    /**
     * Maximum iteration count. Default 10 if only `.repeat()` is called.
     * Hard ceiling 500 — larger values are clamped.
     */
    times(n) {
        this._maxIterations = n;
        return this;
    }
    /**
     * Wall-clock time budget in milliseconds. The loop exits at the next
     * guard check after this elapses.
     */
    forAtMost(ms) {
        this._maxWallclockMs = ms;
        return this;
    }
    /**
     * Exit predicate evaluated after each iteration. Return `true` to exit.
     * Receives `{ iteration, latestOutput, startMs }`.
     *
     * `latestOutput` is the body's string output. For structured exit
     * conditions, emit JSON from the body and parse it inside the guard —
     * see the `UntilGuard` JSDoc for the pattern and the design rationale.
     */
    until(guard) {
        this._until = guard;
        return this;
    }
    build() {
        if (this._body === undefined) {
            throw new Error('Loop.build(): .repeat(runner) is required');
        }
        const maxIterations = this._maxIterations ?? 10;
        return new Loop(this.opts, this._body, {
            maxIterations,
            ...(this._maxWallclockMs !== undefined && { maxWallclockMs: this._maxWallclockMs }),
            ...(this._until !== undefined && { until: this._until }),
            ...(this._bodyTranslator !== undefined && { bodyTranslator: this._bodyTranslator }),
        });
    }
}
function clampIterations(n) {
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1)
        return 1;
    if (n > HARD_ITERATION_CAP)
        return HARD_ITERATION_CAP;
    return n;
}
//# sourceMappingURL=Loop.js.map