import { commitValueAt, findLastWriter, parseRuntimeStageId, splitStageId, } from 'footprintjs/trace';
import { STAGE_IDS, SUBFLOW_IDS } from '../../conventions.js';
import { stepOutputText } from './llmEdgeWeigher.js';
import { CONTEXT_BISECT_DEFAULTS } from './types.js';
/**
 * Partition a commit log by a list of HEAD runtimeStageIds (taken as data — no agent
 * knowledge). Each frame is the half-open range `[head[k], head[k+1])`; commits before
 * the first head are the `prelude`. TOTAL: every commit lands in exactly one frame OR
 * the prelude. Heads not found in the log are ignored; ordering follows the log, not the
 * input list (an out-of-order or duplicate head list cannot reorder/duplicate commits).
 *
 * A head is anchored at the FIRST commit bearing its runtimeStageId — a single stage
 * execution can flush MORE THAN ONE commit bundle under one runtimeStageId (parallel
 * fork merges, multi-flush stages), and those repeats stay INSIDE the frame they open
 * rather than each spawning a spurious one-commit frame.
 */
export function bucketByAnchors(commitLog, headRuntimeStageIds) {
    const headSet = new Set(headRuntimeStageIds);
    const headIdx = [];
    const anchored = new Set();
    for (let i = 0; i < commitLog.length; i++) {
        const id = commitLog[i].runtimeStageId;
        if (headSet.has(id) && !anchored.has(id)) {
            headIdx.push(i);
            anchored.add(id); // later commits sharing this id belong to the frame it opened
        }
    }
    if (headIdx.length === 0) {
        return { frames: [], prelude: commitLog.map((b) => b.runtimeStageId) };
    }
    const prelude = commitLog.slice(0, headIdx[0]).map((b) => b.runtimeStageId);
    const frames = headIdx.map((head, k) => {
        const end = k + 1 < headIdx.length ? headIdx[k + 1] : commitLog.length;
        return { headArrayIdx: head, bodyIds: commitLog.slice(head, end).map((b) => b.runtimeStageId) };
    });
    return { frames, prelude };
}
// ─── findLoopHeads — flat-chart loop-head detection ──────────────────
/** True when a commit lives inside the injection-engine subflow (the loop head region). */
function inInjectionEngine(bundle) {
    const { localStageId, subflowPath } = splitStageId(bundle.stageId);
    if (localStageId === SUBFLOW_IDS.INJECTION_ENGINE)
        return true; // the mount commit, if any
    if (subflowPath === undefined)
        return false;
    // a commit nested anywhere under sf-injection-engine (handles nested subflow prefixes)
    return (subflowPath === SUBFLOW_IDS.INJECTION_ENGINE ||
        subflowPath.startsWith(SUBFLOW_IDS.INJECTION_ENGINE + '/'));
}
/**
 * The flat-chart loop heads: the FIRST commit of each injection-engine ENTRY (one per
 * ReAct iteration, since the loop is branch-sourced back to the injection engine). A head
 * is a commit that is in the injection engine while the previous commit was not — so a
 * multi-commit injection-engine body yields exactly one head per loop.
 *
 * Returns the runtimeStageIds to feed `bucketByAnchors`. Empty when the run never enters
 * the injection engine (e.g. the grouped chart, where the loop lives in sf-llm-call —
 * the caller degrades with an honesty flag).
 */
export function findLoopHeads(commitLog) {
    const heads = [];
    let wasIn = false;
    for (const bundle of commitLog) {
        const isIn = inInjectionEngine(bundle);
        if (isIn && !wasIn)
            heads.push(bundle.runtimeStageId);
        wasIn = isIn;
    }
    return heads;
}
/** Build the per-runtimeStageId read-key map from the snapshot execution tree
 *  (same walk as the localizer's `buildArtifactIndex`). */
function buildReadsOf(executionTree) {
    const readsOf = new Map();
    const visit = (node) => {
        if (!node)
            return;
        const id = node.runtimeStageId;
        if (id && !readsOf.has(id))
            readsOf.set(id, node.stageReads ? Object.keys(node.stageReads) : []);
        for (const child of node.children ?? [])
            visit(child);
        visit(node.next);
    };
    visit(executionTree);
    return readsOf;
}
function safeStringify(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
/**
 * Project ONE loop frame from a given commit log + readsOf — the shared core used by BOTH
 * the flat path (over the run commit log) and the grouped path (over a subflow's OWN inner
 * commit log). `headArrayIdx`/`bodyIds` bound the frame WITHIN `log`; `subflowScope`, when
 * set, records that all indices are relative to that subflow's inner log.
 */
function projectFrame(loopIndex, log, lastIdxOf, readsOf, headArrayIdx, bodyIds, maxTextChars, subflowScope) {
    // Locate the call-llm commit WITHIN this frame's body (the LLM-step pointer).
    let llmCallId;
    let llmCallArrayIdx;
    let llmBundle;
    for (let i = headArrayIdx; i < headArrayIdx + bodyIds.length; i++) {
        if (splitStageId(log[i].stageId).localStageId === STAGE_IDS.CALL_LLM) {
            llmCallId = log[i].runtimeStageId;
            llmCallArrayIdx = i;
            llmBundle = log[i];
            break;
        }
    }
    const intermediateText = llmCallId !== undefined ? stepOutputText(log, lastIdxOf, llmCallId, maxTextChars) : undefined;
    const keys = llmCallId !== undefined ? readsOf.get(llmCallId) ?? [] : [];
    const contextSources = keys.map((key) => {
        // EXCLUSIVE beforeIdx — finds the PRIOR writer, never call-llm's own write-back.
        const writer = llmCallArrayIdx !== undefined ? findLastWriter(log, key, llmCallArrayIdx) : undefined;
        const writerId = writer?.runtimeStageId;
        const writerArrayIdx = writerId !== undefined ? lastIdxOf.get(writerId) : undefined;
        const value = writerArrayIdx !== undefined ? commitValueAt(log, writerArrayIdx, key) : undefined;
        const text = value === undefined ? '' : safeStringify(value).slice(0, maxTextChars);
        return {
            key,
            writerId,
            writerArrayIdx,
            value,
            evidence: { id: `${llmCallId}::${key}`, text, ancestorTexts: [] },
        };
    });
    // Proximate tool source (proposal 008) — the most recent `lastToolResult` committed BEFORE this
    // loop's call-llm, surfaced WALK-ONLY (NOT in contextSources, so L3's narrow is untouched). Its
    // writer is the PRODUCING loop's tool-calls stage — the cross-loop provenance edge L4's descent
    // hops along. FLAT only: in the grouped chart `lastToolResult` lives in the run log outside the
    // per-scope inner log, so the inner findLastWriter can't reach it (deferred). Honesty: the call-llm
    // read `history` (the aggregate), NOT this key — so it's an INFERRED proximate (`proximate: true`).
    let proximateToolSource;
    if (subflowScope === undefined && llmCallArrayIdx !== undefined) {
        const w = findLastWriter(log, 'lastToolResult', llmCallArrayIdx);
        const wIdx = w !== undefined ? lastIdxOf.get(w.runtimeStageId) : undefined;
        const v = wIdx !== undefined ? commitValueAt(log, wIdx, 'lastToolResult') : undefined;
        if (w !== undefined && v !== undefined) {
            proximateToolSource = { value: v, writerId: w.runtimeStageId, proximate: true };
        }
    }
    const incompleteSources = llmBundle?.untrackedSources;
    const untrackedReadsPresent = incompleteSources !== undefined && incompleteSources.length > 0;
    return {
        loopIndex,
        llmCallId,
        llmCallArrayIdx,
        headArrayIdx,
        bodyIds,
        intermediateText,
        contextSources,
        ...(proximateToolSource ? { proximateToolSource } : {}),
        ...(subflowScope !== undefined ? { subflowScope } : {}),
        ...(untrackedReadsPresent ? { incompleteSources } : {}),
        untrackedReadsPresent,
    };
}
/** The sf-llm-call mount keys in `subflowResults`, in loop order (by execution index). */
function llmCallMountKeys(subflowResults) {
    return Object.keys(subflowResults)
        .filter((k) => k.includes('#') && splitStageId(k.split('#')[0]).localStageId === SUBFLOW_IDS.LLM_CALL)
        .sort((a, b) => parseRuntimeStageId(a).executionIndex - parseRuntimeStageId(b).executionIndex);
}
/**
 * GROUPED chart projection (`reactMode: 'dynamic-grouped'`). The LLM turn runs inside an
 * `sf-llm-call` subflow, so its `call-llm` + slot writes live in the subflow's OWN commit log
 * — retained per-iteration under `subflowResults['sf-llm-call#k']` (footprintjs
 * subflow-commit-visibility). Each loop is a frame projected PER-SCOPE over its inner log; no
 * cross-scope merge, so `findLastWriter`/`commitValueAt` run correctly over the isolated log.
 */
function assembleGroupedTrajectory(artifacts, mountKeys, maxTextChars, maxFrames) {
    const sr = (artifacts.snapshot.subflowResults ?? {});
    const runLog = (artifacts.snapshot.commitLog ?? []);
    // Run-level prelude: commits before the first sf-llm-call mount (seed / memory-read setup).
    const firstMountRunIdx = runLog.findIndex((b) => b.runtimeStageId === mountKeys[0]);
    const prelude = firstMountRunIdx > 0 ? runLog.slice(0, firstMountRunIdx).map((b) => b.runtimeStageId) : [];
    const kept = maxFrames !== undefined ? mountKeys.slice(0, maxFrames) : mountKeys;
    const truncated = maxFrames !== undefined && mountKeys.length > maxFrames;
    const frames = kept.map((key, loopIndex) => {
        const innerLog = (sr[key]?.treeContext?.history ?? []);
        const innerReadsOf = buildReadsOf(sr[key]?.treeContext?.stageContexts);
        const innerLastIdxOf = new Map();
        for (let i = 0; i < innerLog.length; i++)
            innerLastIdxOf.set(innerLog[i].runtimeStageId, i);
        const bodyIds = innerLog.map((b) => b.runtimeStageId);
        return projectFrame(loopIndex, innerLog, innerLastIdxOf, innerReadsOf, 0, bodyIds, maxTextChars, key);
    });
    return {
        frames,
        prelude,
        honestyFlags: [],
        ...(truncated ? { truncated: { byFrames: true } } : {}),
    };
}
/**
 * Slice a recorded agent run into a {@link Trajectory} — one {@link LoopFrame} per ReAct
 * iteration, each carrying its `call-llm` pointer, the call's output text, and the live
 * {@link ContextSource}s that fed it (traced via `findLastWriter` + `commitValueAt` from the
 * SAME commit log — zero new capture).
 *
 * Takes the SAME `ContextBugArtifacts` bag the localizer takes — adopter call is just
 * `assembleTrajectory(artifacts)`.
 *
 * Handles BOTH chart shapes:
 *  - FLAT (`reactMode: 'dynamic'`, default): `call-llm` is a parent-level stage; frames are
 *    bucketed over the run commit log by the `sf-injection-engine` loop heads.
 *  - GROUPED (`reactMode: 'dynamic-grouped'`): the LLM turn runs in an `sf-llm-call` subflow;
 *    each loop is projected PER-SCOPE over its own inner commit log (retained per-iteration by
 *    footprintjs subflow-commit-visibility). Such frames carry `subflowScope` and their array
 *    indices are inner-log-relative.
 *
 * Standing caveat on every result: contextSources show only sources re-committed to tracked
 * state; context the model retained internally (carried in its own reasoning, never
 * re-committed) leaves no read→write edge and is NOT represented.
 */
export function assembleTrajectory(artifacts, opts = {}) {
    const maxTextChars = opts.maxTextChars ?? CONTEXT_BISECT_DEFAULTS.maxTextChars;
    // Grouped agent ⟺ the LLM turn is wrapped in sf-llm-call (its mounts appear in subflowResults).
    const mountKeys = llmCallMountKeys((artifacts.snapshot.subflowResults ?? {}));
    if (mountKeys.length > 0) {
        return assembleGroupedTrajectory(artifacts, mountKeys, maxTextChars, opts.maxFrames);
    }
    // FLAT path: project over the run commit log, bucketed by injection-engine loop heads.
    const commitLog = (artifacts.snapshot.commitLog ?? []);
    const lastIdxOf = new Map();
    for (let i = 0; i < commitLog.length; i++)
        lastIdxOf.set(commitLog[i].runtimeStageId, i);
    const readsOf = buildReadsOf(artifacts.snapshot.executionTree);
    const heads = findLoopHeads(commitLog);
    const { frames: buckets, prelude } = bucketByAnchors(commitLog, heads);
    const kept = opts.maxFrames !== undefined ? buckets.slice(0, opts.maxFrames) : buckets;
    const truncated = opts.maxFrames !== undefined && buckets.length > opts.maxFrames;
    const frames = kept.map((bucket, loopIndex) => projectFrame(loopIndex, commitLog, lastIdxOf, readsOf, bucket.headArrayIdx, bucket.bodyIds, maxTextChars));
    return {
        frames,
        prelude,
        honestyFlags: [],
        ...(truncated ? { truncated: { byFrames: true } } : {}),
    };
}
//# sourceMappingURL=trajectory.js.map