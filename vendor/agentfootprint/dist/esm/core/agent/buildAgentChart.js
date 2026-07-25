/**
 * buildAgentChart — assemble the agent's full footprintjs FlowChart
 * from stage functions + slot subflows + memory wiring.
 *
 * This is the "chart composition" that used to live inline in
 * `Agent.buildChart()`. Extracted for v2.11.2 so:
 *
 *   1. Agent.ts focuses on Agent class lifecycle (constructor, run,
 *      attach, getSpec) instead of chart wiring details.
 *   2. The reliability gate chart (v2.11.x) wires into ONE focused
 *      file rather than surgically into Agent.ts's 250-line composition
 *      block.
 *   3. The composition is independently readable + reviewable —
 *      consumers building custom agent shapes have a reference.
 *
 * Chart shape:
 *
 *     Initialize
 *       → [memory READ subflows for each .memory()]
 *       → InjectionEngine (subflow)               ← loop target (tool-calls loops here)
 *       → Context (selector, PARALLEL fan-out, failFast)
 *             ⇉ {System Prompt ‖ Messages ‖ Tools}  (slot subflows)
 *             → converge
 *       → UpdateSkillHistory
 *       → Cache (sf-cache subflow: decideCacheMarkers → CacheGate
 *                → ApplyMarkers / SkipCaching)
 *       → CallLLM (also emits the per-iteration iteration_start marker)
 *       → [NormalizeThinking] (subflow, only when a ThinkingHandler resolved)
 *       → Route (decider)
 *             ├─ tool-calls (pausable) → loopTo(InjectionEngine)   ← branch-sourced loop
 *             └─ final (subflow) → terminal leaf
 *                          ┌────── PrepareFinal
 *                          ├──── [memory WRITE subflows]
 *                          └──── BreakFinal ($break)
 *
 * (When v2.11.x reliability is configured, the reliability gate chart
 * mounts as a subflow before CallLLM with a TranslateFailFast stage
 * after it. Lands in the next commit.)
 */
import { ArrayMergeMode } from 'footprintjs/advanced';
import { flowChart, select } from 'footprintjs';
import { STAGE_IDS, SUBFLOW_IDS } from '../../conventions.js';
import { EMPTY_ACTIVE_BY_SLOT, } from '../../lib/injection-engine/buildInjectionEngineSubflow.js';
import { memoryInjectionKey } from '../../memory/define.types.js';
import { unwrapMemoryFlowChart } from '../../memory/define.js';
import { mountMemoryRead, mountMemoryWrite } from '../../memory/wire/mountMemoryPipeline.js';
import { withMemoryRecall } from './memoryRecallInjections.js';
import { breakFinalStage } from './stages/breakFinal.js';
import { prepareFinalStage } from './stages/prepareFinal.js';
import { buildCacheSubflow } from './buildCacheSubflow.js';
/**
 * Build the agent's complete FlowChart from the supplied deps.
 */
export function buildAgentChart(deps) {
    // ReAct loop semantics. 'classic' caches the static slots (engineer
    // system-prompt + tools only on the first turn); 'dynamic' (default)
    // re-engineers all 3 slots every turn. Drives the Context selector below.
    const reactMode = deps.reactMode ?? 'dynamic';
    // Memory ids whose recall must be bridged into the slot composers (see
    // memoryRecallInjections). Empty → withMemoryRecall is a no-op.
    const memoryIds = deps.memories.map((m) => m.id);
    // ── Final-branch subflow ─────────────────────────────────────
    // Split so memory-write subflows can mount BETWEEN setting
    // finalContent and breaking the ReAct loop. PrepareFinal captures
    // the turn payload; BreakFinal terminates the loop.
    let finalBranchBuilder = flowChart('PrepareFinal', prepareFinalStage, 'prepare-final', {
        ...(deps.structureRecorders !== undefined && {
            structureRecorders: [...deps.structureRecorders],
        }),
        description: 'Capture turn payload (finalContent + newMessages)',
    });
    for (const m of deps.memories) {
        if (m.write) {
            finalBranchBuilder = mountMemoryWrite(finalBranchBuilder, {
                pipeline: {
                    read: unwrapMemoryFlowChart(m.read),
                    write: unwrapMemoryFlowChart(m.write),
                },
                identityKey: 'runIdentity',
                turnNumberKey: 'turnNumber',
                contextTokensKey: 'contextTokensRemaining',
                newMessagesKey: 'newMessages',
                writeSubflowId: `sf-memory-write-${m.id}`,
                // Evidence bridge (#5): only CAUSAL pipelines consume run evidence.
                ...(m.type === 'causal' &&
                    deps.causalEvidenceSource && { evidenceSource: deps.causalEvidenceSource }),
            });
        }
    }
    const finalBranchChart = finalBranchBuilder
        .addFunction('BreakFinal', breakFinalStage, 'break-final', 'Terminate the ReAct loop')
        .build();
    // ── Main chart ──────────────────────────────────────────────
    // Description prefix `Agent:` is a taxonomy marker — consumers
    // (Lens + FlowchartRecorder) detect Agent-primitive subflows via
    // this prefix and flag them as true agent boundaries (separate
    // from LLMCall subflows which use `LLMCall:` prefix).
    let builder = flowChart('Initialize', deps.seed, STAGE_IDS.SEED, {
        ...(deps.structureRecorders !== undefined && {
            structureRecorders: [...deps.structureRecorders],
        }),
        // Tag the mode so the Lens can label the run. Keep the `Agent:` taxonomy
        // prefix (consumers detect Agent boundaries by it). Dynamic keeps the
        // historical 'Agent: ReAct loop' string for byte-stability.
        description: reactMode === 'classic' ? 'Agent: Classic ReAct loop' : 'Agent: ReAct loop',
    });
    // Memory READ subflows — mounted between Initialize and InjectionEngine
    // for TURN_START timing (default). Each memory writes to its own
    // scope key (`memoryInjection_${id}`) so multiple `.memory()`
    // registrations layer without colliding.
    for (const m of deps.memories) {
        builder = mountMemoryRead(builder, {
            pipeline: {
                read: unwrapMemoryFlowChart(m.read),
                ...(m.write !== undefined && { write: unwrapMemoryFlowChart(m.write) }),
            },
            identityKey: 'runIdentity',
            turnNumberKey: 'turnNumber',
            contextTokensKey: 'contextTokensRemaining',
            injectionKey: memoryInjectionKey(m.id),
            readSubflowId: `sf-memory-read-${m.id}`,
        });
    }
    // Relevance entry router (`entryByRelevance`) — picks the starting skill by
    // embedding similarity ONCE per turn, here (before the InjectionEngine, which is
    // the ReAct loop target), so the async embedder is off the hot loop and the
    // chosen cursor is set before the engine reads `currentSkillId`.
    if (deps.pickEntryStage) {
        builder = builder.addFunction('PickEntry', deps.pickEntryStage, STAGE_IDS.PICK_ENTRY, 'Pick the starting skill by relevance to the message (entryByRelevance)');
    }
    builder = builder
        // Injection Engine — evaluates every Injection's trigger once
        // per iteration; writes activeInjections[] to parent scope for
        // the slot subflows to consume. Skipped if no injections were
        // registered (no observable difference, just one more no-op
        // subflow boundary).
        .addSubFlowChartNext(SUBFLOW_IDS.INJECTION_ENGINE, deps.injectionEngineSubflow, 'Injection Engine', {
        inputMapper: (parent) => ({
            iteration: parent.iteration,
            userMessage: parent.userMessage,
            history: parent.history,
            lastToolResult: parent.lastToolResult,
            activatedInjectionIds: parent.activatedInjectionIds ?? [],
            // Last turn's per-slot active set so the engine's Delta stage can
            // diff "what changed per slot". Persists across the ReAct loop in
            // the (flat) parent scope; empty on turn 1.
            priorActiveByslot: parent.activeByslot ?? EMPTY_ACTIVE_BY_SLOT,
            // Skill-graph cursor as of the previous iteration — the `from`-gate the
            // route triggers compare against. Undefined on cold start / no graph.
            currentSkillId: parent.currentSkillId,
            // Relevance entry ranking (from an entry scorer) — read by defineRelevanceHint.
            entryScores: parent.entryScores,
            entryScorer: parent.entryScorer,
        }),
        // Carry activeByslot back to parent so next turn's inputMapper can
        // feed it as priorActiveByslot (the Delta round-trip). currentSkillId is
        // the advanced cursor for the next iteration (scalar → always replaced).
        outputMapper: (sf) => ({
            activeInjections: sf.activeInjections,
            activeByslot: sf.activeByslot,
            currentSkillId: sf.nextSkillCursor,
        }),
        // CRITICAL: footprintjs's default `applyOutputMapping`
        // CONCATENATES arrays from subflow output with the parent's
        // existing array values. Without `Replace`, the parent's
        // `activeInjections` from iter N gets CONCATENATED with the
        // subflow's iter N+1 fresh evaluation — producing
        // 8 → 16 → 24 → 32 cumulative injections per turn.
        arrayMerge: ArrayMergeMode.Replace,
    })
        // ── Context assembly: the 3 slots run in PARALLEL (selector fan-out) ──
        // The slots are genuinely INDEPENDENT — each reads ONLY InjectionEngine's
        // activeInjections + seed state, and each writes a DISJOINT output key
        // (systemPromptInjections / messagesInjections / toolsInjections +
        // dynamicToolSchemas). None reads another slot's output. Running them
        // sequentially was an accident of chaining; the fork makes the execution
        // tree tell the truth (and the Lens merge-tree renders the real shape).
        // The selector picks ALL 3 every iteration (unconditional fan-out).
        // failFast: true — a REQUIRED slot that throws aborts the whole turn,
        // matching the old sequential-throw behavior. WITHOUT it the default
        // Promise.allSettled would SWALLOW a failing slot and call the LLM with a
        // half-built request (the documented request-assembly footgun).
        // ── Context selector — THE one place Classic and Dynamic differ ──────
        // The 3 slots are always selector BRANCHES (so they stay drawn in the
        // chart in both modes); WHICH ones get selected per turn is the whole
        // Classic-vs-Dynamic difference:
        //   • dynamic — pick all 3 EVERY turn (activations can change per turn:
        //     a skill fires, a rule matches, a tool-return steers the next turn).
        //   • classic — pick all 3 on the FIRST turn, then ONLY messages. The
        //     static slots aren't re-selected, so their turn-1 outputs persist in
        //     scope (that IS the cache — the flat builder has no per-turn reset),
        //     and only the message list rebuilds each iteration. The Lens shows
        //     this directly: after turn 1 only the Messages branch lights up.
        .addSelectorFunction('Context', ((scope) => {
        const firstTurn = (scope.iteration ?? 1) <= 1;
        const includeStatic = reactMode === 'dynamic' || firstTurn;
        return select(scope, [
            {
                when: () => includeStatic,
                then: SUBFLOW_IDS.SYSTEM_PROMPT,
                label: 'engineer system-prompt',
            },
            { when: () => true, then: SUBFLOW_IDS.MESSAGES, label: 'engineer messages' },
            { when: () => includeStatic, then: SUBFLOW_IDS.TOOLS, label: 'engineer tools' },
        ]);
    }), STAGE_IDS.CONTEXT, reactMode === 'classic'
        ? 'Assemble request context: messages every turn; system-prompt + tools cached after turn 1'
        : 'Assemble request context: system-prompt + messages + tools (parallel)', { failFast: true })
        // Each branch keeps its inputMapper + outputMapper + arrayMerge:Replace
        // VERBATIM from the former sequential mounts. Replace (not concat) is
        // load-bearing: the loopTo would otherwise accumulate injections/tools.
        .addSubFlowChartBranch(SUBFLOW_IDS.SYSTEM_PROMPT, deps.systemPromptSubflow, 'System Prompt', {
        inputMapper: (parent) => ({
            userMessage: parent.userMessage,
            iteration: parent.iteration,
            activeInjections: withMemoryRecall(parent.activeInjections, parent, memoryIds),
        }),
        outputMapper: (sf) => ({ systemPromptInjections: sf.systemPromptInjections }),
        arrayMerge: ArrayMergeMode.Replace,
    })
        .addSubFlowChartBranch(SUBFLOW_IDS.MESSAGES, deps.messagesSubflow, 'Messages', {
        inputMapper: (parent) => ({
            messages: parent.history,
            iteration: parent.iteration,
            activeInjections: withMemoryRecall(parent.activeInjections, parent, memoryIds),
        }),
        outputMapper: (sf) => ({ messagesInjections: sf.messagesInjections }),
        arrayMerge: ArrayMergeMode.Replace,
    })
        .addSubFlowChartBranch(SUBFLOW_IDS.TOOLS, deps.toolsSubflow, 'Tools', {
        inputMapper: (parent) => ({
            iteration: parent.iteration,
            activeInjections: parent.activeInjections,
            // The slot subflow reads these to build the per-iteration
            // ToolDispatchContext when an external `.toolProvider()` is
            // configured. Without them the provider sees activeSkillId
            // = undefined every iteration, breaking skillScopedTools etc.
            activatedInjectionIds: parent.activatedInjectionIds,
            runIdentity: parent.runIdentity,
        }),
        outputMapper: (sf) => ({
            toolsInjections: sf.toolsInjections,
            // Pass merged tool schemas (registry + injection-supplied)
            // back up so callLLM uses the right list for THIS iteration.
            dynamicToolSchemas: sf.toolSchemas,
        }),
        // Same array-concat hazard as InjectionEngine — replace, don't
        // concatenate. Without Replace the deduped tool list re-acquires
        // duplicates that providers reject.
        arrayMerge: ArrayMergeMode.Replace,
    })
        .end();
    // ── Skill-churn window (cache concern) ──────────────────────────
    // UpdateSkillHistory stays in the MAIN loop (NOT inside sf-cache): the
    // skillHistory rolling window must persist across iterations, so keeping
    // it here lets it live in parent scope without round-tripping through the
    // subflow. It feeds sf-cache's CacheGate churn check, and sits right where
    // the tool-driven skill activation flows into it.
    //
    // CONDITIONAL MOUNT: only when skills are registered. With no skills the
    // window records "no skill" every iteration and CacheGate's churn rule can
    // never fire — so the stage is omitted entirely (no dead weight, no
    // misleading box). Mirrors the read_skill auto-attach + NormalizeThinking.
    if (deps.hasSkills) {
        builder = builder.addFunction('UpdateSkillHistory', deps.updateSkillHistoryStage, STAGE_IDS.UPDATE_SKILL_HISTORY, 'Update skill-history rolling window for CacheGate churn detection');
    }
    builder = builder
        // sf-cache: decideCacheMarkers → CacheGate → apply/skip, collapsed into
        // ONE box. Pure provider-agnostic DECISION layer — reads the turn's state,
        // outputs only the gated cacheMarkers (Replace, not concat, across the
        // loop). The attached provider's CacheStrategy turns markers into wire
        // format later. See buildCacheSubflow.ts.
        .addSubFlowChartNext(SUBFLOW_IDS.CACHE, buildCacheSubflow(), 'Cache', {
        inputMapper: (parent) => ({
            // decideCacheMarkers inputs
            activeInjections: parent.activeInjections ?? [],
            iteration: parent.iteration ?? 1,
            maxIterations: parent.maxIterations ?? deps.maxIterations,
            userMessage: parent.userMessage ?? '',
            ...(parent.lastToolResult !== undefined && {
                lastToolName: parent.lastToolResult?.toolName,
            }),
            cumulativeInputTokens: parent.totalInputTokens ?? 0,
            systemPromptCachePolicy: deps.systemPromptCachePolicy,
            cachingDisabled: parent.cachingDisabled ?? false,
            // CacheGate inputs (read-only: skillHistory is updated in the main
            // loop above, so it is NOT mapped back out)
            recentHitRate: parent.recentHitRate,
            skillHistory: parent.skillHistory ?? [],
        }),
        outputMapper: (sf) => ({ cacheMarkers: sf.cacheMarkers }),
        arrayMerge: ArrayMergeMode.Replace,
    })
        // CallLLM emits the per-iteration `iteration_start` marker itself (no
        // dedicated IterationStart stage — emitting is passive observability).
        .addFunction('CallLLM', deps.callLLM, STAGE_IDS.CALL_LLM, 'LLM invocation');
    // v2.14 — conditional NormalizeThinking sub-subflow. Mounted ONLY
    // when a ThinkingHandler resolved (auto-wired by provider.name OR
    // explicitly set via .thinkingHandler()). When undefined, the stage
    // is NOT added — zero overhead for non-thinking agents
    // (build-time conditional mount; matches the panel's design rule).
    if (deps.thinkingSubflow) {
        builder = builder.addSubFlowChartNext(SUBFLOW_IDS.THINKING, deps.thinkingSubflow, 'NormalizeThinking', {
            inputMapper: (parent) => ({
                rawThinking: parent.rawThinking,
                iteration: parent.iteration,
            }),
            outputMapper: (sf) => ({
                thinkingBlocks: sf.thinkingBlocks,
            }),
            // Replace not concatenate — fresh thinking per iteration
            arrayMerge: ArrayMergeMode.Replace,
        });
    }
    builder = builder
        .addDeciderFunction('Route', deps.routeDecider, SUBFLOW_IDS.ROUTE, 'ReAct routing')
        .addPausableFunctionBranch('tool-calls', 'ToolCalls', deps.toolCallsHandler, 'Tool execution (pausable via pauseHere)', 
    // Branch-sourced loop: tool-calls loops back to the InjectionEngine so
    // EVERY iteration re-evaluates triggers against the freshest context (the
    // just-appended tool result). Sourced from the BRANCH (not the decider) so
    // the chart reads honestly — `ToolCalls → InjectionEngine` loops, `Final`
    // terminates. Survives pause/resume (human-in-the-loop tool approval): the
    // engine resolves the subflow loop target on resume — footprintjs
    // FlowChartExecutor.resume + test/lib/pause/resume-branch-loop-subflow.
    { loopTo: SUBFLOW_IDS.INJECTION_ENGINE })
        .addSubFlowChartBranch(SUBFLOW_IDS.FINAL, finalBranchChart, 'Final', {
        // Pass through the read-only state the sub-chart needs;
        // OMIT keys the sub-chart writes (finalContent, newMessages)
        // — passing those via inputMapper would freeze them as args.
        inputMapper: (parent) => {
            const { finalContent: _f, newMessages: _nm, ...rest } = parent;
            void _f;
            void _nm;
            return rest;
        },
        outputMapper: (sf) => ({
            finalContent: sf.finalContent,
        }),
        // With the branch-sourced loop, `final` is a terminal LEAF — it ends the
        // run on its own (no decider `next` to suppress). propagateBreak is kept
        // so BreakFinal's $break() still surfaces a terminal onBreak signal to the
        // parent (observability) and stays correct if a decider-level `next` is
        // ever reintroduced.
        propagateBreak: true,
    })
        .setDefault(SUBFLOW_IDS.FINAL)
        .end();
    // The ReAct loop is now sourced from the `tool-calls` branch (the
    // `{ loopTo }` above), not the decider — so `Final` is a plain terminal leaf
    // and the chart draws `ToolCalls → InjectionEngine` for the loop edge.
    return builder.build();
}
//# sourceMappingURL=buildAgentChart.js.map