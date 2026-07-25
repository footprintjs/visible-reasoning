/**
 * localizeContextBug — the contextual-bug LOCALIZER, "git bisect for
 * context" (RFC-003 Part B, block D8).
 *
 * The five-stage pipeline (each stage is a shipped piece — this file only
 * ASSEMBLES):
 *
 *   1. TRIGGER     — an explicit `atStep`, a custom trigger strategy, or
 *                    the QualityRecorder's lowest-scoring step.
 *   2. SLICE       — footprintjs `causalChain` over the commit log, WITH
 *                    control-dependence edges (D3) and honesty markers
 *                    (A2/A4) when the artifacts carry them.
 *   3. WEIGH       — D7's `llmEdgeWeigher` stamps influence weights on
 *                    every LLM-call parent edge (two-pass: prime, re-slice).
 *   4. RANK        — suspects = slice nodes classified into ablatable
 *                    context sources (tool / injection / memory / arg),
 *                    scored by max-product path weight × per-item semantic
 *                    refinement. CORRELATIONAL tier — and marked so.
 *   5. ABLATE      — optional: the consumer's `AblationRunner` re-runs the
 *                    scenario without each top suspect, N seeded times.
 *                    Verdicts (the ONLY causal claims, §B2) + variance.
 *
 * Without a runner the report stops at stage 4 with
 * `mode: 'correlational'` — explicitly a ranking of proxies, no causal
 * claim anywhere.
 *
 * Every `source` / `step` id in the report is a plain runtimeStageId —
 * drill any of them with the trace-toolpack tools (`trace_node`,
 * `trace_slice`, `get_value`) over the same artifacts bag.
 */
import { causalChain, commitValueAt } from 'footprintjs/trace';
import { scoreInfluence, } from '../influence-core/index.js';
import { ablationForSuspect, runAblationProbe, verdictFor } from './ablation.js';
import { assignCostVerdicts, classifySuspect } from './cost.js';
import { llmEdgeWeigher, stepOutputText } from './llmEdgeWeigher.js';
import { findDroppedContext } from './missingContext.js';
import { runRestorationProbe } from './restoration.js';
import { CONTEXT_BISECT_DEFAULTS } from './types.js';
// ─── LLM-call id extraction ──────────────────────────────────────────
/**
 * Extract LLM-call step ids from captured typed events: the
 * `meta.runtimeStageId` of every `agentfootprint.stream.llm_start`
 * envelope, deduplicated in event order. Collect events with
 * `agent.on('*', (e) => events.push(e))`.
 */
export function llmCallIdsFromEvents(events) {
    const ids = [];
    const seen = new Set();
    for (const event of events) {
        if (event.type !== 'agentfootprint.stream.llm_start')
            continue;
        const id = event.meta.runtimeStageId;
        if (seen.has(id))
            continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}
/** Injection flavors that are engineered context (ablatable by id). */
const ENGINEERED_SOURCES = new Set([
    'rag',
    'skill',
    'memory',
    'instructions',
    'steering',
    'fact',
    'custom',
]);
const INJECTION_SLOT_KEYS = ['systemPromptInjections', 'messagesInjections', 'toolsInjections'];
/**
 * The default classifier — reads the node's COMMITTED values (already
 * redaction-scrubbed) and recognizes the agent chart's shapes:
 *
 * - `systemPromptInjections` / `messagesInjections` / `toolsInjections`
 *   records with an engineered source → one suspect per `Injection.id`
 *   (kind `'memory'` for source `'memory'`, else `'injection'`).
 * - `lastToolResult` → a `'tool'` suspect for the tool that ran.
 * - footprintjs A2 honesty marker `args` → an `'arg'` suspect (the
 *   consumer's runner must override the input — nothing to filter).
 * - anything else → the honest `'stage'` fallback (no ablation spec).
 */
export function defaultSuspectClassifier(ctx) {
    const seeds = [];
    const seenInjection = new Set();
    for (const slotKey of INJECTION_SLOT_KEYS) {
        if (!ctx.keysWritten.includes(slotKey))
            continue;
        const records = ctx.valueOf(slotKey);
        if (!Array.isArray(records))
            continue;
        for (const record of records) {
            const source = typeof record?.source === 'string' ? record.source : undefined;
            const sourceId = typeof record?.sourceId === 'string' ? record.sourceId : undefined;
            if (source === undefined || sourceId === undefined)
                continue;
            if (!ENGINEERED_SOURCES.has(source))
                continue; // baseline flow (user/base/registry/…)
            const kind = source === 'memory' ? 'memory' : 'injection';
            const dedupeKey = `${kind}:${sourceId}`;
            if (seenInjection.has(dedupeKey))
                continue;
            seenInjection.add(dedupeKey);
            const text = typeof record.rawContent === 'string'
                ? record.rawContent
                : typeof record.contentSummary === 'string'
                    ? record.contentSummary
                    : undefined;
            seeds.push({
                kind,
                detail: {
                    injectionId: sourceId,
                    flavor: source,
                    ...(text !== undefined ? { text } : {}),
                },
            });
        }
    }
    if (ctx.keysWritten.includes('lastToolResult')) {
        const value = ctx.valueOf('lastToolResult');
        if (value && typeof value.toolName === 'string') {
            seeds.push({
                kind: 'tool',
                detail: {
                    toolName: value.toolName,
                    ...(typeof value.result === 'string' ? { text: value.result } : {}),
                },
            });
        }
    }
    if (ctx.node.incompleteSources?.includes('args')) {
        seeds.push({ kind: 'arg' });
    }
    return seeds.length > 0 ? seeds : [{ kind: 'stage' }];
}
function buildArtifactIndex(artifacts) {
    const commitLog = (artifacts.snapshot.commitLog ?? []);
    const lastIdxOf = new Map();
    for (let i = 0; i < commitLog.length; i++)
        lastIdxOf.set(commitLog[i].runtimeStageId, i);
    const readsOf = new Map();
    let hasReadTracking = false;
    const visit = (node) => {
        if (!node)
            return;
        const id = node.runtimeStageId;
        if (id && !readsOf.has(id)) {
            const keys = node.stageReads ? Object.keys(node.stageReads) : [];
            readsOf.set(id, keys);
            if (keys.length > 0)
                hasReadTracking = true;
        }
        for (const child of node.children ?? [])
            visit(child);
        visit(node.next);
    };
    visit(artifacts.snapshot.executionTree);
    return { commitLog, lastIdxOf, readsOf, hasReadTracking };
}
/**
 * Best (max-product) path weight from the root to every slice node.
 * The slice DAG is topologically ordered by commit index (a writer always
 * commits before its reader; a decider before its branch), so one pass in
 * DESCENDING commit order finalizes children before their parents.
 */
function computePathScores(root, nodes, lastIdxOf) {
    const info = new Map();
    info.set(root.runtimeStageId, { score: 1 });
    const ordered = [...nodes].sort((a, b) => (lastIdxOf.get(b.runtimeStageId) ?? -1) - (lastIdxOf.get(a.runtimeStageId) ?? -1));
    for (const node of ordered) {
        const current = info.get(node.runtimeStageId);
        if (!current)
            continue; // unreachable from root (defensive)
        for (const edge of node.parentEdges) {
            const candidate = current.score * edge.weight;
            const existing = info.get(edge.parent.runtimeStageId);
            if (!existing || candidate > existing.score) {
                info.set(edge.parent.runtimeStageId, {
                    score: candidate,
                    via: { child: node, kind: edge.kind, key: edge.key, weight: edge.weight },
                });
            }
        }
    }
    return info;
}
function buildEdgePath(node, info) {
    const steps = [];
    let cur = node;
    for (;;) {
        const via = info.get(cur.runtimeStageId)?.via;
        if (!via)
            break;
        steps.push({
            from: via.child.runtimeStageId,
            fromName: via.child.stageName,
            to: cur.runtimeStageId,
            toName: cur.stageName,
            kind: via.kind,
            ...(via.key !== undefined ? { key: via.key } : {}),
            weight: via.weight,
        });
        cur = via.child;
    }
    return steps.reverse(); // trigger → … → suspect
}
/** REORDER-only narrowing: shortlisted suspects first (by recallScore desc), the rest unchanged. */
function reorderByShortlist(suspects, shortlist) {
    if (shortlist === undefined || shortlist.candidates.length === 0)
        return [...suspects];
    const recallOf = new Map(shortlist.candidates.map((c) => [c.suspectId, c.recallScore]));
    const idOf = (s) => s.detail?.injectionId ?? s.detail?.toolName;
    // Stable: Array.prototype.sort is stable, so non-shortlisted pairs keep their incoming order.
    return [...suspects].sort((a, b) => {
        const ra = recallOf.get(idOf(a) ?? '');
        const rb = recallOf.get(idOf(b) ?? '');
        const aIn = ra !== undefined;
        const bIn = rb !== undefined;
        if (aIn && bIn)
            return rb - ra; // both shortlisted → by recall
        if (aIn)
            return -1; // shortlisted before non-shortlisted
        if (bIn)
            return 1;
        return 0; // neither shortlisted → keep proxy-score order (stable)
    });
}
// ─── The localizer ───────────────────────────────────────────────────
/**
 * Localize a contextual bug: trigger → causal slice → influence-weighted
 * ranking → (optional) counterfactual ablation. See module docs for the
 * pipeline and the §B2 claim tiers.
 *
 * @beta Beta feature — the API may change before GA.
 *
 * @throws when no trigger can be resolved (no `atStep`, no custom
 *         strategy hit, no `artifacts.quality`), or when the trigger step
 *         is not in the commit log.
 */
export async function localizeContextBug(options) {
    const { artifacts, embedder } = options;
    const maxDepth = options.maxDepth ?? CONTEXT_BISECT_DEFAULTS.maxDepth;
    const maxNodes = options.maxNodes ?? CONTEXT_BISECT_DEFAULTS.maxNodes;
    const maxSuspects = options.maxSuspects ?? CONTEXT_BISECT_DEFAULTS.maxSuspects;
    const index = buildArtifactIndex(artifacts);
    // Normalize the pluggable scorer: a bare `InfluenceScorer` function, a named
    // `InfluenceStrategy` (its `.scorer` runs; its `.name` echoes on `rankedBy`),
    // or the default `scoreInfluence` (`'semantic-alignment'`).
    const scorerOption = options.scorer;
    const scorer = scorerOption === undefined
        ? scoreInfluence
        : typeof scorerOption === 'function'
            ? scorerOption
            : scorerOption.scorer;
    const rankedBy = scorerOption === undefined
        ? 'semantic-alignment'
        : typeof scorerOption === 'function'
            ? 'custom'
            : scorerOption.name;
    // ── 1. Trigger ────────────────────────────────────────────────────
    let step;
    let triggerSource;
    let triggerScore;
    if (options.atStep !== undefined) {
        step = options.atStep;
        triggerSource = 'explicit';
    }
    else if (options.trigger !== undefined) {
        step = options.trigger(artifacts);
        triggerSource = 'custom';
    }
    else {
        const lowest = artifacts.quality?.getLowest();
        step = lowest?.runtimeStageId;
        triggerScore = lowest?.entry.score;
        triggerSource = 'quality';
    }
    if (step === undefined) {
        throw new Error('localizeContextBug: no trigger step — pass atStep, supply a trigger strategy, ' +
            'or provide artifacts.quality (a QualityRecorder from the run).');
    }
    if (!index.lastIdxOf.has(step)) {
        throw new Error(`localizeContextBug: trigger step '${step}' is not in the commit log — ` +
            'pass a runtimeStageId of a step that committed (see snapshot.commitLog).');
    }
    // ── 2 + 3. Slice, then weigh (two-pass over the same evidence) ─────
    const keysReadOf = (id) => index.readsOf.get(id) ?? [];
    const sliceOptions = {
        maxDepth,
        maxNodes,
        ...(artifacts.controlDeps ? { controlDeps: artifacts.controlDeps } : {}),
    };
    const unweighted = causalChain(index.commitLog, step, keysReadOf, sliceOptions);
    if (!unweighted) {
        throw new Error(`localizeContextBug: causalChain found no node for '${step}'.`);
    }
    const llmCallIds = artifacts.llmCallIds ?? (artifacts.events ? llmCallIdsFromEvents(artifacts.events) : []);
    const weigher = llmEdgeWeigher({
        embedder,
        llmCallIds,
        commitLog: index.commitLog,
    });
    await weigher.prime(unweighted);
    const root = causalChain(index.commitLog, step, keysReadOf, { ...sliceOptions, weigh: weigher.weigh }) ??
        unweighted;
    // ── 4. Rank ─────────────────────────────────────────────────────────
    const nodes = collectNodes(root);
    const pathInfo = computePathScores(root, nodes, index.lastIdxOf);
    const classify = options.classify;
    const drafts = [];
    for (const node of nodes) {
        if (node.runtimeStageId === root.runtimeStageId)
            continue; // the trigger itself
        const info = pathInfo.get(node.runtimeStageId);
        if (!info)
            continue;
        const ctx = {
            node,
            keysWritten: node.keysWritten,
            valueOf: (key) => {
                const idx = index.lastIdxOf.get(node.runtimeStageId);
                return idx === undefined ? undefined : commitValueAt(index.commitLog, idx, key);
            },
        };
        const seeds = classify?.(ctx) ?? defaultSuspectClassifier(ctx);
        const edgePath = buildEdgePath(node, pathInfo);
        for (const seed of seeds) {
            drafts.push({ node, seed, structuralScore: info.score, edgePath });
        }
    }
    // Semantic refinement: ONE influence-core pass over every suspect that
    // has its own content text, against the trigger step's output. Ancestor
    // texts = LLM-call outputs on the suspect's path (the FDL casting).
    const triggerOutput = stepOutputText(index.commitLog, index.lastIdxOf, root.runtimeStageId, CONTEXT_BISECT_DEFAULTS.maxTextChars);
    if (triggerOutput !== undefined) {
        const llmIdSet = new Set(llmCallIds);
        const evidence = [];
        const evidenceDraft = [];
        drafts.forEach((draft, i) => {
            const text = draft.seed.detail?.text;
            if (text === undefined || text.length === 0)
                return;
            const ancestorTexts = [];
            for (const hop of draft.edgePath) {
                // Intermediate LLM steps between trigger and suspect (exclusive).
                if (hop.from !== root.runtimeStageId && llmIdSet.has(hop.from)) {
                    const ancestorText = stepOutputText(index.commitLog, index.lastIdxOf, hop.from, CONTEXT_BISECT_DEFAULTS.maxTextChars);
                    if (ancestorText !== undefined)
                        ancestorTexts.push(ancestorText);
                }
            }
            evidence.push({ id: String(i), text, ancestorTexts });
            evidenceDraft.push(draft);
        });
        if (evidence.length > 0) {
            const scores = await scorer({ evidence, finalAnswerText: triggerOutput, embedder });
            const byId = new Map(scores.map((s) => [s.id, s.score]));
            evidence.forEach((item, i) => {
                const composite = byId.get(item.id);
                if (composite !== undefined) {
                    evidenceDraft[i].semanticScore = Math.max(0, Math.min(1, composite));
                }
            });
        }
    }
    const scored = drafts
        .map((draft) => {
        const score = draft.semanticScore !== undefined
            ? draft.structuralScore * draft.semanticScore
            : draft.structuralScore;
        const suspect = {
            source: draft.node.runtimeStageId,
            stageName: draft.node.stageName,
            kind: draft.seed.kind,
            ...(draft.seed.detail !== undefined ? { detail: draft.seed.detail } : {}),
            score,
            structuralScore: draft.structuralScore,
            ...(draft.semanticScore !== undefined ? { semanticScore: draft.semanticScore } : {}),
            hasContentEvidence: draft.semanticScore !== undefined,
            edgePath: draft.edgePath,
        };
        const ablation = ablationForSuspect(suspect);
        return ablation !== undefined ? { ...suspect, ablation } : suspect;
    })
        .sort((a, b) => b.score - a.score); // stable: ties keep slice order
    // L3 narrowing (proposal 006): REORDER-ONLY by the per-loop recall shortlist (joined on the
    // suspect identity injectionId/toolName) so high-recall candidates float to the top and survive
    // the maxSuspects slice → ablation targets them first. NEVER intersect/drop (that risks losing a
    // true suspect L3 missed — the absence/crowding blind spot). Non-shortlisted suspects keep their
    // proxy-score order (stable). narrow (recall), then convict (causal).
    const reordered = reorderByShortlist(scored, options.shortlist);
    const ranked = reordered.slice(0, maxSuspects);
    // ── Slice stats + honesty flags ─────────────────────────────────────
    const sliceStats = buildSliceStats(root, nodes, maxDepth, maxNodes);
    const honestyFlags = buildHonestyFlags(artifacts, index, sliceStats, llmCallIds.length);
    // ── 5b. Missing-context tier (interface #3) ─────────────────────────
    // Independent of ablation: finds what was available but never sent, and —
    // with a restoration runner — confirms each by restoration (the causal mirror).
    const missing = options.missingContext
        ? await runMissingContextTier(options.missingContext, embedder)
        : undefined;
    const dropped = missing?.candidates;
    // A restoration verdict (even not-confirmed) is a causal-tier statement.
    const restorationRan = dropped?.some((d) => d.verdict !== undefined) ?? false;
    // Mirror ablation's honesty: an unstable un-restored baseline (the buggy
    // output itself not reproducing) invalidates every restoration verdict —
    // surface it as a machine-readable flag, not just inside each claim string.
    const restorationFlags = missing?.baseline !== undefined && !missing.baselineStable
        ? [
            {
                flag: 'baseline-unstable',
                note: `the un-restored baseline changed outcome in ${missing.baseline.flips}/${missing.baseline.samples} ` +
                    'seeded reruns — all restoration verdicts are inconclusive.',
            },
        ]
        : [];
    // ── 5. Ablate (the causal tier) ─────────────────────────────────────
    if (options.rerun === undefined) {
        return {
            step,
            stepName: root.stageName,
            triggerSource,
            ...(triggerScore !== undefined ? { triggerScore } : {}),
            mode: restorationRan ? 'causal' : 'correlational',
            rankedBy,
            suspects: ranked,
            ...(dropped ? { dropped } : {}),
            sliceStats,
            honestyFlags: [...honestyFlags, ...restorationFlags],
            ...(missing?.baseline !== undefined ? { restorationBaseline: missing.baseline } : {}),
        };
    }
    const probeConfig = { rerun: options.rerun, embedder };
    const maxAblations = options.rerun.maxSuspects ?? 5;
    // Baseline first: an unstable scenario invalidates every verdict.
    const baseline = await runAblationProbe(probeConfig, []);
    const baselineStable = baseline.flips === 0;
    const flags = baselineStable
        ? honestyFlags
        : [
            ...honestyFlags,
            {
                flag: 'baseline-unstable',
                note: `the un-ablated baseline changed outcome in ${baseline.flips}/${baseline.samples} ` +
                    'seeded reruns — all ablation verdicts are inconclusive.',
            },
        ];
    const withVerdicts = [];
    let ablated = 0;
    for (const suspect of ranked) {
        if (suspect.ablation === undefined ||
            suspect.ablation.kind === 'arg' ||
            ablated >= maxAblations) {
            withVerdicts.push(suspect);
            continue;
        }
        ablated++;
        const stats = await runAblationProbe(probeConfig, [suspect.ablation]);
        const verdict = verdictFor(suspectLabel(suspect), stats, baselineStable);
        withVerdicts.push({ ...suspect, runs: stats, verdict });
    }
    // Two-score localization (proposal 004): when the runner reported cost, read
    // the SECOND score (loops/tokens saved on removal) from the same reruns, with
    // a leave-one-out placebo control. No-op when no cost was reported.
    const withCost = assignCostVerdicts(withVerdicts, baseline);
    return {
        step,
        stepName: root.stageName,
        triggerSource,
        ...(triggerScore !== undefined ? { triggerScore } : {}),
        mode: 'causal',
        rankedBy,
        suspects: withCost,
        ...(dropped ? { dropped } : {}),
        sliceStats,
        honestyFlags: [...flags, ...restorationFlags],
        baseline,
        ...(missing?.baseline !== undefined ? { restorationBaseline: missing.baseline } : {}),
    };
}
/**
 * Interface #3 tier: find context available but not sent, and — with a
 * restoration runner — confirm each by restoration (the mirror of ablation).
 * Without a runner, returns the dropped units as candidates (no verdicts).
 * Only the first `maxCandidates` dropped units are probed (REAL LLM re-runs);
 * the rest are listed as bare candidates (`verdict`/`runs` undefined), exactly
 * like the ablation tier leaves over-budget suspects verdict-less.
 */
async function runMissingContextTier(missing, embedder) {
    const { dropped } = findDroppedContext(missing.available, missing.sent);
    const asCandidate = (u) => u.content === undefined ? { id: u.id } : { id: u.id, content: u.content };
    // Nothing dropped → no candidates and NO baseline probe (don't spend real
    // model calls confirming an empty set — the common healthy case).
    if (dropped.length === 0)
        return { candidates: [], baselineStable: true };
    if (missing.rerun === undefined)
        return { candidates: dropped.map(asCandidate), baselineStable: true };
    const config = { rerun: missing.rerun, embedder };
    const maxCandidates = missing.rerun.maxCandidates ?? 5;
    // Baseline: restoring nothing must reproduce the buggy output (stable).
    const baseline = await runRestorationProbe(config, []);
    const baselineStable = baseline.flips === 0;
    const out = [];
    let restored = 0;
    for (const unit of dropped) {
        if (restored >= maxCandidates) {
            out.push(asCandidate(unit)); // over budget — listed, not probed (no verdict)
            continue;
        }
        restored++;
        const runs = await runRestorationProbe(config, [unit]);
        const verdict = verdictFor(`dropped "${unit.id}"`, runs, baselineStable, 'restoring');
        out.push({ ...asCandidate(unit), runs, verdict });
    }
    return { candidates: out, baseline, baselineStable };
}
// ─── Internals ───────────────────────────────────────────────────────
function collectNodes(root) {
    const out = [];
    const seen = new Set();
    const queue = [root];
    while (queue.length > 0) {
        const node = queue.shift();
        if (seen.has(node.runtimeStageId))
            continue;
        seen.add(node.runtimeStageId);
        out.push(node);
        for (const parent of node.parents)
            queue.push(parent);
    }
    return out;
}
function buildSliceStats(root, nodes, maxDepth, maxNodes) {
    let dataEdges = 0;
    let controlEdges = 0;
    let weightedEdges = 0;
    let incompleteNodes = 0;
    for (const node of nodes) {
        if (node.incompleteSources && node.incompleteSources.length > 0)
            incompleteNodes++;
        for (const edge of node.parentEdges) {
            if (edge.kind === 'data')
                dataEdges++;
            else
                controlEdges++;
            if (edge.weight !== 1)
                weightedEdges++;
        }
    }
    return {
        nodes: nodes.length,
        dataEdges,
        controlEdges,
        weightedEdges,
        incompleteNodes,
        maxDepth,
        maxNodes,
        ...(root.truncated !== undefined ? { truncated: root.truncated } : {}),
    };
}
function buildHonestyFlags(artifacts, index, sliceStats, llmCallIdCount) {
    const flags = [];
    if (sliceStats.truncated !== undefined) {
        const causes = [
            sliceStats.truncated.byDepth && `maxDepth (${sliceStats.maxDepth})`,
            sliceStats.truncated.byNodes && `maxNodes (${sliceStats.maxNodes})`,
        ]
            .filter(Boolean)
            .join(' + ');
        flags.push({
            flag: 'slice-truncated',
            note: `the slice was cut by ${causes} — older causes exist beyond this horizon; the ranking cannot see them.`,
        });
    }
    if (sliceStats.incompleteNodes > 0) {
        flags.push({
            flag: 'untracked-sources',
            note: `${sliceStats.incompleteNodes} slice node(s) also consumed untracked inputs ` +
                '(args/env/silent reads) — those inputs produce no edges; the slice through them is incomplete.',
        });
    }
    if (!artifacts.controlDeps) {
        flags.push({
            flag: 'no-control-deps',
            note: 'no control-dependence lookup in the artifacts (attach controlDepRecorder() to the run) — ' +
                'decisions that routed execution are missing from the slice.',
        });
    }
    if (!index.hasReadTracking) {
        flags.push({
            flag: 'no-read-tracking',
            note: 'the snapshot carries no per-step read tracking — read→write edges cannot be followed; ' +
                'the slice may contain only the trigger step.',
        });
    }
    if (llmCallIdCount === 0) {
        flags.push({
            flag: 'no-llm-call-ids',
            note: 'no LLM-call step ids (pass llmCallIds or captured events) — no edge received an ' +
                'influence weight; the ranking is structure-only.',
        });
    }
    return flags;
}
export function suspectLabel(suspect) {
    const id = suspect.detail?.toolName ?? suspect.detail?.injectionId ?? suspect.source;
    return `${suspect.kind} '${id}'`;
}
// ─── Formatting ──────────────────────────────────────────────────────
/**
 * Human-readable report. The claim tiers are spelled out in the output
 * itself (§B2): scores are proxies; verdict lines are the only causal
 * claims; every ⚠ honesty flag prints.
 */
export function formatContextBugReport(report) {
    const lines = [];
    lines.push(`CONTEXT BUG LOCALIZATION — trigger ${report.step} "${report.stepName}" ` +
        `(${report.triggerSource}${report.triggerScore !== undefined ? `, score ${report.triggerScore.toFixed(2)}` : ''})`);
    const modeLine = report.mode === 'causal'
        ? 'mode: CAUSAL — ranked proxies + counterfactual ablation verdicts (verdicts are the only causal claims)'
        : 'mode: CORRELATIONAL — ranking only; every score is an embedding-geometry proxy, no causal claim is made';
    lines.push(report.rankedBy !== undefined ? `${modeLine} — ranked by ${report.rankedBy}` : modeLine);
    const s = report.sliceStats;
    lines.push(`slice: ${s.nodes} nodes · ${s.dataEdges} data edges · ${s.controlEdges} control edges · ` +
        `${s.weightedEdges} influence-weighted`);
    lines.push('', `SUSPECTS (${report.suspects.length}, ranked by correlational proxy score):`);
    report.suspects.forEach((suspect, i) => {
        const scoreParts = suspect.semanticScore !== undefined
            ? `${suspect.score.toFixed(3)} (path ${suspect.structuralScore.toFixed(3)} × content ${suspect.semanticScore.toFixed(3)})`
            : `${suspect.score.toFixed(3)} (path only — no content signal; an upper bound)`;
        lines.push(`${String(i + 1).padStart(2)}. [${suspectLabel(suspect)}] at ${suspect.source} ` +
            `"${suspect.stageName}" — score ${scoreParts}`);
        if (suspect.edgePath.length > 0) {
            const hops = suspect.edgePath
                .map((hop) => {
                const link = hop.kind === 'control'
                    ? `[control${hop.key ? `: ${hop.key}` : ''}]`
                    : hop.key ?? 'data';
                const weight = hop.weight !== 1 ? ` ${hop.weight.toFixed(3)}` : '';
                return `←(${link}${weight})— ${hop.to}`;
            })
                .join(' ');
            lines.push(`    path: ${suspect.edgePath[0].from} ${hops}`);
        }
        if (suspect.verdict !== undefined && suspect.runs !== undefined) {
            lines.push(`    verdict: ${suspect.verdict.claim}`);
            lines.push(`    runs: ${suspect.runs.flips}/${suspect.runs.samples} flipped · similarity to original ` +
                `${suspect.runs.similarity.mean.toFixed(3)} ± ${suspect.runs.similarity.stdev.toFixed(3)} ` +
                `[${suspect.runs.similarity.min.toFixed(3)}, ${suspect.runs.similarity.max.toFixed(3)}]`);
            if (suspect.cost !== undefined) {
                const c = suspect.cost;
                const detail = c.reducedCostOnRemoval
                    ? `REDUCED on removal — −${c.loopsSaved} loop(s), −${c.tokensSaved} tok (beats placebo, stable)`
                    : `no cost effect (loops ${c.loopsSaved >= 0 ? '−' : '+'}${Math.abs(c.loopsSaved)}${c.stable ? '' : '; no placebo band / unstable'})`;
                lines.push(`    cost: ${detail} → class: ${classifySuspect(suspect)}`);
            }
        }
        else if (report.mode === 'correlational') {
            lines.push('    verdict: (none — correlational ranking only; supply an AblationRunner to test causally)');
        }
    });
    // Missing-context tier (interface #3) — symmetric with the SUSPECTS block.
    if (report.dropped !== undefined && report.dropped.length > 0) {
        lines.push('', `MISSING CONTEXT (${report.dropped.length} dropped — available but never sent to the model):`);
        report.dropped.forEach((c, i) => {
            lines.push(`${String(i + 1).padStart(2)}. [dropped '${c.id}']`);
            if (c.verdict !== undefined && c.runs !== undefined) {
                lines.push(`    verdict: ${c.verdict.claim}`);
                lines.push(`    runs: ${c.runs.flips}/${c.runs.samples} flipped on restore · similarity to original ` +
                    `${c.runs.similarity.mean.toFixed(3)} ± ${c.runs.similarity.stdev.toFixed(3)}`);
            }
            else {
                lines.push('    verdict: (none — candidate only; supply missingContext.rerun to confirm by restoration)');
            }
        });
    }
    if (report.baseline !== undefined) {
        lines.push('', `baseline (no ablation): ${report.baseline.flips}/${report.baseline.samples} flipped · ` +
            `similarity ${report.baseline.similarity.mean.toFixed(3)} ± ${report.baseline.similarity.stdev.toFixed(3)}`);
    }
    if (report.restorationBaseline !== undefined) {
        lines.push(`baseline (no restoration): ${report.restorationBaseline.flips}/${report.restorationBaseline.samples} flipped · ` +
            `similarity ${report.restorationBaseline.similarity.mean.toFixed(3)} ± ${report.restorationBaseline.similarity.stdev.toFixed(3)}`);
    }
    if (report.honestyFlags.length > 0) {
        lines.push('', 'HONESTY:');
        for (const flag of report.honestyFlags)
            lines.push(`⚠ [${flag.flag}] ${flag.note}`);
    }
    lines.push('', 'claims: scores/weights are deterministic embedding-geometry PROXIES (semantic alignment, ' +
        'not model internals); slice completeness is bounded by tracking (see HONESTY); only ' +
        'ablation verdicts make causal claims.');
    return lines.join('\n');
}
//# sourceMappingURL=localize.js.map