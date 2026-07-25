/**
 * causalEvidenceRecorder — the evidence bridge (backlog Phase-1 #5).
 *
 * Harvests, DURING the run, everything a causal snapshot needs beyond
 * (query, finalContent) — from events the engine already fires:
 *
 *   stream.tool_start/tool_end  → ToolCallRecord (name, args, resultPreview, errored)
 *   stream.llm_end              → tokenUsage accumulation + iteration high-water
 *   agent.turn_start/turn_end   → durationMs (+ authoritative totals when seen)
 *   FlowRecorder.onDecision     → DecisionRecord with footprintjs decide()/select()
 *                                 operator-level evidence (rule, conditions, chosen)
 *   context.evaluated routing   → DecisionRecord per skill the graph routed to
 *
 * Pattern: CombinedRecorder (Convention 1 — single purpose: evidence
 *          accumulation); per-turn reset anchored on `agent.turn_start`
 *          (Convention 4 — executor `clear()` resets between runs; same-
 *          executor pause/resume PRESERVES pre-pause evidence by design).
 * PII note: tool args/results and decide() evidence persist into snapshots.
 *          footprintjs `RedactionPolicy.emitPatterns` redacts the emit channel
 *          BEFORE this recorder IF the consumer configures one on the executor
 *          — the Agent does NOT configure one by default. Values are bounded
 *          (`maxPreviewChars` for results, `maxFieldChars` for args/evidence);
 *          treat the snapshot store as PII-bearing and protect it accordingly.
 *
 * The Agent attaches this automatically when a CAUSAL memory is mounted and
 * threads `collect` into the memory write mount (`evidenceSource`) — so
 * `writeSnapshot` persists real evidence instead of zeros.
 */
function preview(value, max) {
    let s;
    if (typeof value === 'string')
        s = value;
    else {
        try {
            s = JSON.stringify(value);
        }
        catch {
            s = String(value);
        }
    }
    return s.length > max ? `${s.slice(0, max)}…` : s;
}
/** Bound a record-ish value: oversized serializations become a truncated
 *  preview marker so snapshots can't grow unbounded (and PII exposure is
 *  capped). Small values pass through untouched. */
function bounded(value, max) {
    if (value === undefined)
        return undefined;
    try {
        const s = JSON.stringify(value);
        if (s.length <= max)
            return value;
        return { __truncated: `${s.slice(0, max)}…` };
    }
    catch {
        return { __truncated: String(value).slice(0, max) };
    }
}
/** Build the evidence-harvesting recorder. Attach via `.recorder(rec)` (the
 *  Agent does this automatically for CAUSAL memories). */
export function causalEvidenceRecorder(options = {}) {
    const maxPreview = options.maxPreviewChars ?? 200;
    const maxField = options.maxFieldChars ?? 2000;
    // ── per-turn accumulators (reset on agent.turn_start; executor clear()
    //    resets between runs; pause/resume keeps pre-pause evidence) ──
    let decisions = [];
    let toolCalls = [];
    let pendingTools = new Map();
    let tokens = { input: 0, output: 0 };
    let iterations = 0;
    let turnStartMs;
    let authoritative;
    const reset = () => {
        decisions = [];
        toolCalls = [];
        pendingTools = new Map();
        tokens = { input: 0, output: 0 };
        iterations = 0;
        turnStartMs = undefined;
        authoritative = undefined;
    };
    return {
        id: options.id ?? 'causal-evidence',
        onEmit(event) {
            const { name, payload } = event;
            switch (name) {
                case 'agentfootprint.agent.turn_start':
                    // A new turn on the same executor — start fresh (one snapshot per turn).
                    reset();
                    turnStartMs = Date.now();
                    break;
                case 'agentfootprint.stream.tool_start': {
                    const id = String(payload.toolCallId ?? '');
                    pendingTools.set(id, {
                        name: String(payload.toolName ?? 'unknown'),
                        args: bounded((payload.args ?? {}), maxField) ?? {},
                    });
                    break;
                }
                case 'agentfootprint.stream.tool_end': {
                    const id = String(payload.toolCallId ?? '');
                    const started = pendingTools.get(id);
                    pendingTools.delete(id);
                    toolCalls.push({
                        name: started?.name ?? 'unknown',
                        args: started?.args ?? {},
                        resultPreview: preview(payload.result, maxPreview),
                        errored: payload.error === true,
                    });
                    break;
                }
                case 'agentfootprint.stream.llm_end': {
                    const usage = payload.usage;
                    tokens = {
                        input: tokens.input + (usage?.input ?? 0),
                        output: tokens.output + (usage?.output ?? 0),
                    };
                    const iter = Number(payload.iteration ?? 0);
                    if (iter > iterations)
                        iterations = iter;
                    break;
                }
                case 'agentfootprint.context.evaluated': {
                    // Skill-graph routing provenance → one DecisionRecord per routed skill.
                    const routing = payload.routing;
                    if (Array.isArray(routing)) {
                        for (const r of routing) {
                            decisions.push({
                                stageId: 'skill-graph',
                                chosen: String(r.injectionId ?? r.id ?? 'unknown'),
                                ...(r.label !== undefined || r.via !== undefined
                                    ? { rule: r.label ?? `via ${r.via}` }
                                    : {}),
                                ...(r.path !== undefined && {
                                    evidence: { path: r.path },
                                }),
                            });
                        }
                    }
                    break;
                }
                case 'agentfootprint.agent.turn_end': {
                    // Authoritative totals when the write runs after turn_end.
                    authoritative = {
                        iterations: Number(payload.iterationCount ?? iterations),
                        input: Number(payload.totalInputTokens ?? tokens.input),
                        output: Number(payload.totalOutputTokens ?? tokens.output),
                        durationMs: Number(payload.durationMs ?? 0),
                    };
                    break;
                }
                default:
                    break;
            }
        },
        /** footprintjs FlowRecorder channel — decide() decision evidence.
         *  FlowDecisionEvent carries `decider` (display name), `chosen`, optional
         *  `evidence` from decide(), and `traversalContext.stageId` (the stable,
         *  subflow-prefixed stage id — preferred for DecisionRecord.stageId). */
        onDecision(event) {
            const stageId = event.traversalContext?.stageId ?? event.decider;
            // Internal agent plumbing (the cache-gate decider) is not domain
            // decision evidence. `includes` (not startsWith): in reactMode
            // 'dynamic-grouped' the names are double-prefixed
            // ('sf-llm-call/sf-cache/…').
            if (String(event.chosen ?? '').includes('sf-cache/') || String(stageId).includes('sf-cache'))
                return;
            const evidence = event.evidence;
            decisions.push({
                stageId: String(stageId),
                chosen: String(event.chosen ?? 'unknown'),
                ...(evidence?.label !== undefined || evidence?.rule !== undefined
                    ? { rule: String(evidence.label ?? evidence.rule) }
                    : {}),
                ...(evidence !== undefined && {
                    evidence: bounded(evidence, maxField),
                }),
            });
        },
        /** footprintjs FlowRecorder channel — select() selection evidence. */
        onSelected(event) {
            const stageId = event.traversalContext?.stageId ?? event.parent;
            if (String(stageId).includes('sf-cache'))
                return;
            // The agent's own Context slot-fork is a selector — plumbing, not domain.
            if (String(stageId).includes('context') && event.selected.every((s) => s.startsWith('sf-')))
                return;
            decisions.push({
                stageId: String(stageId),
                chosen: event.selected.join(', '),
                ...(event.evidence !== undefined && {
                    evidence: bounded(event.evidence, maxField),
                }),
            });
        },
        collect() {
            return {
                iterations: authoritative?.iterations ?? iterations,
                decisions: [...decisions],
                toolCalls: [...toolCalls],
                durationMs: authoritative?.durationMs ?? (turnStartMs !== undefined ? Date.now() - turnStartMs : 0),
                tokenUsage: {
                    input: authoritative?.input ?? tokens.input,
                    output: authoritative?.output ?? tokens.output,
                },
            };
        },
        clear() {
            reset();
        },
    };
}
//# sourceMappingURL=evidenceRecorder.js.map