import { ablationForSuspect, runAblationProbe, probeFlipped, verdictFor } from './ablation.js';
import { defaultSuspectClassifier } from './localize.js';
import { shortlistEarlyCulprits } from './loop-recall.js';
import { assembleTrajectory } from './trajectory.js';
/** Margin under which the top-2 narrowed candidates are "unseparated" (mirrors the toBacktrackTrace pattern). */
const UNSEPARATED_MARGIN = 0.05;
/**
 * Resolve every `writerId` to the index of the frame whose `bodyIds` contains it (NOT via
 * `parseRuntimeStageId` — that yields executionIndex, not loopIndex). A writer not in any frame
 * (run prelude / root-seeded) maps to `undefined`. Invariant: each id lands in exactly one frame.
 */
export function buildWriterFrameIndex(trajectory) {
    const map = new Map();
    trajectory.frames.forEach((frame, idx) => {
        for (const id of frame.bodyIds)
            if (!map.has(id))
                map.set(id, idx);
    });
    return map;
}
/** Map each suspectId present in a frame to the runtimeStageId that WROTE its slot (cross-loop provenance). */
function writtenByOf(frame) {
    const map = new Map();
    for (const src of frame.contextSources) {
        const v = src.value;
        if (Array.isArray(v)) {
            // injection slots: an array of records keyed by sourceId
            for (const rec of v) {
                const id = typeof rec.sourceId === 'string' ? rec.sourceId : undefined;
                if (id !== undefined && !map.has(id))
                    map.set(id, src.writerId);
            }
        }
        else if (v !== null &&
            typeof v === 'object' &&
            typeof v.toolName === 'string') {
            // lastToolResult: a { toolName, result } object → the tool suspect
            const tool = v.toolName;
            if (!map.has(tool))
                map.set(tool, src.writerId);
        }
    }
    // The WALK-ONLY proximate tool source (proposal 008) — the cross-loop descent edge. NOT in
    // contextSources (L3 never scored it); walkTrajectory adds it as a hop candidate.
    const tool = frame.proximateToolSource;
    if (tool && typeof tool.value?.toolName === 'string') {
        const name = tool.value.toolName;
        if (!map.has(name))
            map.set(name, tool.writerId);
    }
    return map;
}
/** A minimal Suspect for ablationForSuspect (only kind + detail identity are read). */
function suspectFor(suspectId, kind) {
    const detail = kind === 'tool' ? { toolName: suspectId } : { injectionId: suspectId };
    return {
        source: suspectId,
        stageName: suspectId,
        kind,
        detail,
        score: 0,
        structuralScore: 0,
        hasContentEvidence: false,
        edgePath: [],
    };
}
/**
 * Walk backward from the symptom to the root context source — from a recorded run.
 * Thin wrapper: `assembleTrajectory` then {@link walkTrajectory}. See module docs for the honesty model.
 */
export async function walkToRoot(artifacts, opts) {
    return walkTrajectory(assembleTrajectory(artifacts), opts);
}
/**
 * The walk itself, over an already-assembled {@link Trajectory} (composable + directly testable).
 * FLAT charts only for the cross-loop hop; grouped charts degrade (within-loop) with a flag.
 */
export async function walkTrajectory(trajectory, opts) {
    const beamK = opts.beamK ?? 2;
    const maxHops = opts.maxHops ?? 8;
    const maxAblations = opts.maxAblations ?? 24;
    const classify = opts.classifier ?? defaultSuspectClassifier;
    const honestyFlags = [...trajectory.honestyFlags];
    const grouped = trajectory.frames.some((f) => f.subflowScope !== undefined);
    if (grouped) {
        honestyFlags.push({
            flag: 'untracked-sources',
            note: 'cross-loop hop unavailable for the grouped chart — loop frames are scope-isolated; the walk degrades to within one loop.',
        });
    }
    const writerFrame = buildWriterFrameIndex(trajectory);
    // Baseline stability (the un-ablated scenario must reproduce for any ablation verdict to be trusted).
    let baselineStable = true;
    let ablationsUsed = 0;
    if (opts.rerun) {
        const baseline = await runAblationProbe({ embedder: opts.embedder, rerun: opts.rerun }, []);
        ablationsUsed++;
        baselineStable = !probeFlipped(baseline);
    }
    const hops = [];
    const visited = new Set();
    let frameIdx = trajectory.frames.length - 1; // start at the symptom (final loop)
    let byHops = false;
    let byAblations = false;
    while (frameIdx >= 0) {
        if (hops.length >= maxHops) {
            byHops = true;
            break;
        }
        const frame = trajectory.frames[frameIdx];
        // NARROW: rank THIS loop's suspects by per-loop influence (single-frame sub-trajectory).
        const sub = { frames: [frame], prelude: [], honestyFlags: [] };
        const shortlist = await shortlistEarlyCulprits(sub, {
            embedder: opts.embedder,
            ...(opts.recencyDecay !== undefined ? { recencyDecay: opts.recencyDecay } : {}),
            ...(opts.k !== undefined ? { k: opts.k } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
            classifier: classify,
        });
        const beam = shortlist.candidates.slice(0, beamK);
        if (beam.length === 0)
            break;
        const writtenBy = writtenByOf(frame);
        const unseparated = beam.length >= 2 && Math.abs(beam[0].recallScore - beam[1].recallScore) < UNSEPARATED_MARGIN;
        // ISOLATE: run-wide ablation of each NARROWED injection candidate; ablation is the only
        // discriminator (a wrong-branch narrow that doesn't flip is never the root).
        let chosen = beam[0];
        let chosenVerdict;
        let convicted = false;
        if (opts.rerun) {
            for (const cand of beam) {
                if (ablationsUsed >= maxAblations) {
                    byAblations = true;
                    break;
                }
                const spec = ablationForSuspect(suspectFor(cand.suspectId, cand.kind));
                if (spec === undefined)
                    continue;
                const stats = await runAblationProbe({ embedder: opts.embedder, rerun: opts.rerun }, [
                    spec,
                ]);
                ablationsUsed++;
                if (baselineStable && probeFlipped(stats)) {
                    chosen = cand;
                    chosenVerdict = verdictFor(`ablate ${cand.suspectId}`, stats, baselineStable);
                    convicted = true;
                    break; // ablation picked this loop's root
                }
            }
        }
        // The proximate tool source (walk-only, proposal 008) is the cross-loop DESCENT edge. When this
        // loop did NOT convict, follow it back to the loop that PRODUCED the tool output the decision was
        // conditioned on — that's where a buried root (e.g. the misdirecting instruction) scores + convicts.
        const toolName = !convicted &&
            frame.proximateToolSource &&
            typeof frame.proximateToolSource.value?.toolName === 'string'
            ? frame.proximateToolSource.value.toolName
            : undefined;
        if (toolName !== undefined)
            chosen = { suspectId: toolName, kind: 'tool' };
        const writer = writtenBy.get(chosen.suspectId);
        const nextFrameIdx = writer !== undefined ? writerFrame.get(writer) : undefined;
        const descendIdx = nextFrameIdx !== undefined && nextFrameIdx < frameIdx ? nextFrameIdx : undefined; // strictly backward
        // Per-hop honest note: untracked-origin (structural — no provenance writer to descend) is set
        // regardless of a rerun; unseparated-siblings flags a narrow that couldn't separate the top-2.
        const inlineNote = writer === undefined
            ? 'untracked-origin'
            : unseparated && !convicted
                ? 'unseparated-siblings'
                : undefined;
        hops.push({
            loopIndex: frame.loopIndex,
            suspectId: chosen.suspectId,
            kind: chosen.kind,
            narrowedBy: 'text-similarity',
            ...(chosenVerdict ? { verdict: chosenVerdict } : {}),
            ...(writer !== undefined ? { writtenBy: writer } : {}),
            ...(descendIdx !== undefined ? { cameFrom: trajectory.frames[descendIdx].loopIndex } : {}),
            ...(inlineNote ? { note: inlineNote } : {}),
        });
        if (convicted)
            break; // root found at this loop (injections are same-loop-seeded — terminal)
        const visitKey = `${chosen.suspectId}@${frame.loopIndex}`;
        if (descendIdx === undefined || visited.has(visitKey))
            break; // dead end / cycle
        visited.add(visitKey);
        frameIdx = descendIdx;
    }
    // root = the ablation-convicted hop (the walk breaks there).
    let root;
    for (const hop of hops)
        if (hop.verdict?.verdict === 'confirmed')
            root = hop;
    // Terminal honesty note: a rerun ran but the walk ended without a causal root, AND the last hop
    // had a descendable provenance writer (so it's "could-not-convict", not "untracked-origin").
    if (opts.rerun && root === undefined && hops.length > 0) {
        const last = hops[hops.length - 1];
        if (last.note === undefined && last.writtenBy !== undefined) {
            hops[hops.length - 1] = { ...last, note: 'overdetermined-or-incomplete' };
        }
    }
    return {
        hops,
        ...(root ? { root } : {}),
        honestyFlags,
        ...(byHops || byAblations ? { truncated: { byHops, byAblations } } : {}),
    };
}
//# sourceMappingURL=walk-to-root.js.map