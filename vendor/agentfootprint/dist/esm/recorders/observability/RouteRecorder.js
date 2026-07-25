/**
 * routeRecorder — records the skill-graph route a run actually took.
 *
 * A passive observer that reconstructs, hop by hop, which skill the agent was in,
 * where it went next, and WHY — by COMPOSING already-shipped events (no engine
 * change): `agentfootprint.context.evaluated` (its `routing[]` carries via/from/
 * label per active skill-graph injection) + `agentfootprint.skill.rejected` (an
 * out-of-reach read_skill) + `stream.tool_start` (the tool that drove a hop).
 *
 * Also folds in the GREY-AREA GOVERNORS (observability tier): it detects
 * oscillation (A→B→A→B within `pingPongWindow`) and a run of consecutive rejected
 * `read_skill` jumps (`maxRejectedRetries`), reported via `getTrips()`. These LABEL
 * the trace (`onTrip:'stay'` semantics) — the hard "always stops" guarantee remains
 * the agent's iteration cap; a runtime force-stop is a deferred follow-on.
 *
 * Pattern: CombinedRecorder (Convention 1 — single purpose: route evidence). Owns a
 *          `SequenceStore<RouteHop>`. Convention 4: resets on a new `runId`.
 * Role:    Tier-3 /observe recorder — `Agent.create(...).recorder(routeRecorder())`.
 *          Powers the lens, the "Why this skill?" panel, and paper route figures.
 */
import { SequenceStore } from 'footprintjs/trace';
/** A human-readable one-line reason for a hop. Exported (pure). */
export function formatRouteHop(hop) {
    switch (hop.outcome) {
        case 'entry':
            return `entered "${hop.toSkill}"`;
        case 'route':
            return `"${hop.fromSkill}" → "${hop.toSkill}"${hop.edgeLabel ? ` (${hop.edgeLabel})` : ''}${hop.lastTool ? ` on ${hop.lastTool}` : ''}`;
        case 'stay':
            return `stayed in "${hop.toSkill}"`;
        case 'rejected':
            return `read_skill("${hop.requestedSkill}") rejected from "${hop.fromSkill ?? 'cold start'}" — reachable: ${(hop.reachable ?? []).join(', ') || '(none)'}`;
    }
}
/** The current cursor skill from a `context.evaluated` routing[] — prefer a
 *  transitioned-into route target, then an entry, then a tree leaf, then model. */
function cursorFromRouting(routing) {
    for (const via of ['route', 'entry', 'tree', 'model']) {
        const e = routing.find((r) => r.via === via && typeof r.injectionId === 'string');
        if (e) {
            return {
                id: e.injectionId,
                ...(typeof e.from === 'string' ? { from: e.from } : {}),
                ...(typeof e.label === 'string' ? { label: e.label } : {}),
            };
        }
    }
    return undefined;
}
/** Build the route recorder. */
export function routeRecorder(options = {}) {
    const pingPongWindow = options.pingPongWindow ?? 4;
    const maxRejectedRetries = options.maxRejectedRetries ?? 3;
    const store = new SequenceStore();
    const trips = [];
    const transitions = []; // toSkill of 'route'/'entry' hops, for oscillation
    let lastRunId;
    let cursor;
    let lastTool;
    let consecutiveRejected = 0;
    const reset = () => {
        store.clear();
        trips.length = 0;
        transitions.length = 0;
        cursor = undefined;
        lastTool = undefined;
        consecutiveRejected = 0;
    };
    const detectPingPong = (iteration) => {
        if (transitions.length < pingPongWindow)
            return;
        const recent = transitions.slice(-pingPongWindow);
        const distinct = new Set(recent);
        // [X,Y,X,Y,...]: exactly two skills, strictly alternating across the window.
        if (distinct.size === 2 && recent.every((s, i) => s === recent[i % 2])) {
            const skills = [...distinct];
            if (!trips.some((t) => t.kind === 'ping-pong' && t.iteration === iteration)) {
                trips.push({
                    kind: 'ping-pong',
                    iteration,
                    skills,
                    detail: `oscillating between "${skills[0]}" and "${skills[1]}" over the last ${pingPongWindow} hops`,
                });
            }
        }
    };
    return {
        id: options.id ?? 'route',
        onEmit(event) {
            const payload = event.payload;
            if (payload === null || typeof payload !== 'object')
                return;
            const p = payload;
            switch (event.name) {
                case 'agentfootprint.stream.tool_start': {
                    if (typeof p.toolName === 'string')
                        lastTool = p.toolName;
                    break;
                }
                case 'agentfootprint.context.evaluated': {
                    const routing = Array.isArray(p.routing) ? p.routing : [];
                    const cur = cursorFromRouting(routing);
                    if (cur === undefined)
                        break; // no skill-graph routing this iteration
                    const iteration = Number(p.iteration ?? 0);
                    const from = cursor;
                    const outcome = cursor === undefined ? 'entry' : cur.id !== cursor ? 'route' : 'stay';
                    const hop = {
                        runtimeStageId: event.runtimeStageId,
                        iteration,
                        ...(from !== undefined ? { fromSkill: from } : {}),
                        toSkill: cur.id,
                        outcome,
                        why: '',
                        ...(cur.label !== undefined ? { edgeLabel: cur.label } : {}),
                        ...(outcome === 'route' && lastTool !== undefined ? { lastTool } : {}),
                    };
                    const finished = { ...hop, why: formatRouteHop(hop) };
                    store.push(finished);
                    if (outcome !== 'stay') {
                        transitions.push(cur.id);
                        detectPingPong(iteration);
                    }
                    cursor = cur.id;
                    consecutiveRejected = 0; // a successful evaluation breaks a rejection run
                    break;
                }
                case 'agentfootprint.skill.rejected': {
                    const iteration = Number(p.iteration ?? 0);
                    const hop = {
                        runtimeStageId: event.runtimeStageId,
                        iteration,
                        ...(typeof p.currentSkillId === 'string' ? { fromSkill: p.currentSkillId } : {}),
                        outcome: 'rejected',
                        why: '',
                        ...(typeof p.requestedId === 'string' ? { requestedSkill: p.requestedId } : {}),
                        reachable: Array.isArray(p.allowed) ? p.allowed : [],
                    };
                    store.push({ ...hop, why: formatRouteHop(hop) });
                    consecutiveRejected += 1;
                    if (consecutiveRejected >= maxRejectedRetries &&
                        !trips.some((t) => t.kind === 'rejected-cap' && t.iteration === iteration)) {
                        trips.push({
                            kind: 'rejected-cap',
                            iteration,
                            skills: typeof p.currentSkillId === 'string' ? [p.currentSkillId] : [],
                            detail: `${consecutiveRejected} consecutive out-of-reach read_skill jumps`,
                        });
                    }
                    break;
                }
                default:
                    break;
            }
        },
        // Convention 4 — reset on a new run.
        onRunStart(event) {
            const runId = event.traversalContext?.runId;
            if (runId !== undefined && runId !== lastRunId) {
                reset();
                lastRunId = runId;
            }
        },
        getPath() {
            const path = [];
            for (const hop of store.getAll()) {
                if (hop.toSkill !== undefined && hop.toSkill !== path[path.length - 1])
                    path.push(hop.toSkill);
            }
            return path;
        },
        getHops() {
            return store.getAll();
        },
        getRejections() {
            return store.getAll().filter((h) => h.outcome === 'rejected');
        },
        getTrips() {
            return [...trips];
        },
        clear() {
            reset();
        },
    };
}
//# sourceMappingURL=RouteRecorder.js.map