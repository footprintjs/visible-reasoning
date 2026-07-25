import { ablationForSuspect, probeFlipped, runAblationProbe, verdictFor } from './ablation.js';
import { suspectLabel } from './localize.js';
/** Resolve the `ignore` list against the report's suspects — see the option doc. */
function resolveIgnored(report, ignore) {
    const removed = [];
    const resolvedIds = [];
    const seenIds = new Set();
    for (const entry of ignore) {
        if (typeof entry !== 'string') {
            // Explicit spec — pass through untouched (no matching, no dedup).
            removed.push(entry);
            resolvedIds.push('<custom spec>');
            continue;
        }
        const suspect = report.suspects.find((s) => s.detail?.injectionId === entry || s.detail?.toolName === entry || s.source === entry);
        if (suspect === undefined) {
            const offered = removableSources(report)
                .map((s) => s.id)
                .join(', ');
            throw new Error(`rerunWithoutSources: '${entry}' matches no suspect on the report — removable ids: [${offered}]`);
        }
        if (suspect.kind === 'stage') {
            throw new Error(`rerunWithoutSources: '${entry}' is a plain stage — plain stages have no removable input ` +
                `(re-rank or refactor).`);
        }
        if (suspect.kind === 'arg') {
            const spec = ablationForSuspect(suspect);
            const note = spec !== undefined && spec.kind === 'arg' ? spec.note : 'untracked run input';
            throw new Error(`rerunWithoutSources: '${entry}' is run input — ${note} pass an explicit ` +
                `\`{ kind: 'arg', … }\` spec in \`ignore\` if your runner overrides run input.`);
        }
        // Dedup by the RESOLVED suspect (first wins) — two aliases of one source
        // (injectionId vs runtimeStageId) must collapse to a single spec.
        const resolvedKey = suspect.detail?.injectionId ?? suspect.detail?.toolName ?? suspect.source;
        if (seenIds.has(resolvedKey))
            continue;
        seenIds.add(resolvedKey);
        const spec = suspect.ablation ?? ablationForSuspect(suspect);
        if (spec === undefined) {
            throw new Error(`rerunWithoutSources: '${entry}' carries no removable identity — its suspect has no ` +
                `ablation spec.`);
        }
        removed.push(spec);
        resolvedIds.push(entry);
    }
    if (removed.length === 0) {
        throw new Error('rerunWithoutSources: ignore is empty — nothing to remove; for a plain baseline probe use ' +
            'runAblationProbe with empty specs.');
    }
    return { removed, resolvedIds };
}
export async function rerunWithoutSources(options) {
    const { removed, resolvedIds } = resolveIgnored(options.report, options.ignore);
    const label = `sources [${resolvedIds.join(', ')}]`;
    const samples = options.samples;
    const answers = [];
    // Capture each re-run's answer with ZERO extra runs (wrap the consumer's runner).
    const capturing = async (specs, run) => {
        const raw = await options.runner(specs, run);
        answers[run.seed] = typeof raw === 'string' ? raw : raw.output;
        return raw;
    };
    const rerunConfig = {
        runner: capturing,
        originalOutput: options.originalAnswer,
        ...(samples !== undefined ? { samples } : {}),
        ...(options.answerChanged !== undefined ? { outcomeChanged: options.answerChanged } : {}),
        ...(options.flipThreshold !== undefined ? { flipThreshold: options.flipThreshold } : {}),
    };
    let baseline;
    if (options.checkBaseline === true) {
        // Baseline FIRST, un-captured (baseline answers are not surfaced).
        baseline = await runAblationProbe({ rerun: { ...rerunConfig, runner: options.runner }, embedder: options.embedder }, []);
    }
    const runs = await runAblationProbe({ rerun: rerunConfig, embedder: options.embedder }, removed);
    const flipped = probeFlipped(runs);
    const baselineChecked = options.checkBaseline === true;
    const baselineStable = baseline !== undefined ? !probeFlipped(baseline) : true;
    const mean = runs.similarity.mean;
    let summary;
    if (baselineChecked && !baselineStable) {
        summary =
            'The unchanged scenario itself gave different answers across seeded re-runs — no removal ' +
                'claim is trustworthy on an unstable scenario (see verdict).';
    }
    else if (flipped && baselineChecked) {
        summary =
            `Removing ${label} changed the answer in ${runs.flips}/${runs.samples} seeded re-runs ` +
                `(mean similarity to the original ${mean.toFixed(3)}). The unchanged scenario stayed ` +
                'stable — see verdict for the causal claim.';
    }
    else if (flipped) {
        summary =
            `Removing ${label} changed the answer in ${runs.flips}/${runs.samples} seeded re-runs ` +
                `(mean similarity ${mean.toFixed(3)}). Baseline stability was not checked — pass ` +
                'checkBaseline: true for a causal-tier verdict.';
    }
    else {
        summary =
            `Removing ${label} did not change the answer in ${runs.samples - runs.flips}/${runs.samples} ` + 'seeded re-runs — as far as these re-runs can see, those sources were not driving it.';
    }
    const whatChanged = {
        answerFlipped: flipped,
        flips: runs.flips,
        samples: runs.samples,
        similarityToOriginal: runs.similarity,
        baselineChecked,
        summary,
    };
    const verdict = baselineChecked
        ? verdictFor(label, runs, baselineStable)
        : undefined;
    return {
        answer: answers[0],
        answers,
        removed,
        whatChanged,
        runs,
        ...(baseline !== undefined ? { baseline } : {}),
        ...(verdict !== undefined ? { verdict } : {}),
    };
}
/**
 * The report's removable sources, ranked order, de-duplicated by id (first =
 * highest-ranked occurrence wins). Excludes kind `'stage'` (nothing to remove)
 * and `'arg'` (the library cannot filter run input — the runner must override
 * it; pass an explicit `kind: 'arg'` spec to `ignore` if yours does).
 */
export function removableSources(report) {
    const out = [];
    const seen = new Set();
    for (const suspect of report.suspects) {
        if (suspect.kind !== 'tool' && suspect.kind !== 'injection' && suspect.kind !== 'memory') {
            continue;
        }
        const spec = suspect.ablation ?? ablationForSuspect(suspect);
        if (spec === undefined)
            continue;
        const id = suspect.detail?.injectionId ?? suspect.detail?.toolName ?? suspect.source;
        if (seen.has(id))
            continue;
        seen.add(id);
        out.push({
            id,
            kind: suspect.kind,
            label: suspectLabel(suspect),
            source: suspect.source,
            stageName: suspect.stageName,
            score: suspect.score,
            spec,
        });
    }
    return out;
}
//# sourceMappingURL=rerun.js.map