/**
 * toBacktrackTrace — serialize a ContextBugReport into the BacktrackTrace
 * shape that agentThinkingUI's <BacktrackView>/<BacktrackOverlay> renders
 * (the "why?" board: suspects → influence meters → ablation stamps →
 * chain-of-custody rewind).
 *
 * Pure mapping, no UI dependency — the BacktrackTrace interfaces below
 * MIRROR agentthinkingui's `types/index.d.ts` contract; both sides are
 * framework-agnostic JSON. The report carries everything except two
 * things only the caller knows:
 *
 *   - `answer` (REQUIRED): the report localizes a decision but does not
 *     hold the decision's output text — pass what the agent said/chose.
 *   - `custody` (optional): the rewind player replays RECORDED STATE
 *     (the assembled prompt, the mutating commit). That content lives in
 *     the caller's artifacts (snapshot/events), not in the report — pass
 *     a callback to enrich confirmed suspects with evidence panes.
 *
 * Honesty is preserved, not added: ranks are TRUE report positions even
 * when the cards are a subset (`rank`), path-only scores carry
 * `upperBound` (hatched meter + starred value in the UI), honesty flags
 * map verbatim, and the claims-discipline lines ride along. The mapper
 * never invents a causal claim: `verdict` exists only where the report's
 * ablation produced one ('inconclusive' maps to NO stamp, not a verdict).
 */
/* ── mapping ──────────────────────────────────────────────────────────── */
const BORN_VIA = {
    injection: 'injection engine',
    tool: 'tool result',
    arg: 'run args/env (untracked)',
    stage: 'stage commit',
};
/** The report's claims-discipline lines — same tier language as formatContextBugReport. */
const CLAIMS_LINES = [
    'scores/weights are deterministic embedding-geometry proxies — semantic alignment, not model internals.',
    'only ablation verdicts make causal claims.',
];
function suspectName(s) {
    return s.detail?.injectionId ?? s.detail?.toolName ?? s.source;
}
function toCard(s, trueRank, custody) {
    // edgePath walks decision → suspect; the suspect-adjacent hop is last
    const adjacent = s.edgePath.length > 0 ? s.edgePath[s.edgePath.length - 1] : undefined;
    const verdict = s.verdict && s.verdict.verdict !== 'inconclusive'
        ? {
            kind: s.verdict.verdict,
            flips: s.runs?.flips,
            samples: s.runs?.samples,
            claim: s.verdict.claim,
        }
        : undefined;
    return {
        kind: s.kind,
        flavor: s.detail?.flavor,
        name: suspectName(s),
        text: s.detail?.text,
        score: s.score,
        rank: trueRank,
        upperBound: s.hasContentEvidence ? undefined : true,
        edge: adjacent
            ? { key: adjacent.key, weight: adjacent.weight, kind: adjacent.kind }
            : undefined,
        path: s.edgePath.length > 1
            ? s.edgePath.map((h) => ({
                key: h.key ?? '',
                kind: h.kind,
                via: `${h.from} ← ${h.to}`,
            }))
            : undefined,
        bornAt: { id: s.source, label: s.stageName, via: BORN_VIA[s.kind] },
        custody: custody?.(s, trueRank),
        verdict,
    };
}
/**
 * Serialize a localizer report for agentThinkingUI's BacktrackView.
 * See module doc — `answer` is required; `custody` enriches the rewind.
 */
export function toBacktrackTrace(report, opts) {
    const max = opts.maxSuspects ?? 6;
    const prefer = opts.preferContentEvidence ?? true;
    // selection — true report rank rides on every card either way
    const indexed = report.suspects.map((s, i) => ({ s, trueRank: i + 1 }));
    let selected;
    if (indexed.length <= max) {
        selected = indexed;
    }
    else if (prefer) {
        const content = indexed.filter((e) => e.s.hasContentEvidence);
        const structural = indexed.filter((e) => !e.s.hasContentEvidence);
        selected = [...content, ...structural].slice(0, max);
        selected.sort((a, b) => a.trueRank - b.trueRank); // cards stay in rank order
    }
    else {
        selected = indexed.slice(0, max);
    }
    const selectedRanks = new Set(selected.map((e) => e.trueRank));
    const dropped = indexed.filter((e) => !selectedRanks.has(e.trueRank));
    const folded = dropped.length > 0
        ? `${dropped.length} more suspect${dropped.length === 1 ? '' : 's'} folded — ` +
            dropped.map((e) => `#${e.trueRank} ${e.s.source}`).join(' · ') +
            (dropped.every((e) => !e.s.hasContentEvidence) ? ' (path-only upper bounds)' : '') +
            ' — every id drillable with the trace toolpack'
        : undefined;
    // auto tie-warning: only when the report's top two genuinely crowd each other
    let scoreNote = opts.scoreNote;
    if (scoreNote === undefined && report.suspects.length >= 2) {
        const margin = report.suspects[0].score - report.suspects[1].score;
        if (margin < 0.05) {
            scoreNote = `top-2 margin ${margin.toFixed(2)} — proxy scores alone cannot separate them${report.mode === 'causal' ? '; the ablation test can' : ''}.`;
        }
    }
    // When the decision being walked back is a deterministic rule (decidedAtKind:
    // 'rule'), having no LLM-call ids is EXPECTED, not a missing input: a rule makes
    // no model calls, so "structure-only ranking" is the correct mode. The localizer
    // can't tell that case from "an LLM chart whose llmCallIds weren't passed" — only
    // the consumer's decidedAtKind disambiguates — so we reframe that one flag here,
    // at the layer that knows. It becomes a neutral note (no ⚠), never a warning.
    const decidedAtKind = opts.decidedAtKind ?? 'llm';
    const honesty = [
        ...report.honestyFlags.map((f) => decidedAtKind === 'rule' && f.flag === 'no-llm-call-ids'
            ? 'this decision is a deterministic rule — it makes no LLM calls, so scores rank recorded operands by structure (no influence weighting applies).'
            : `⚠ ${f.flag}: ${f.note}`),
        ...CLAIMS_LINES,
    ];
    return {
        claim: opts.claim ?? `Why did ${report.stepName} (${report.step}) decide this?`,
        mode: report.mode,
        modeLabel: opts.modeLabel,
        agent: opts.agent,
        model: opts.model,
        answer: opts.answer,
        decidedAt: { id: report.step, label: report.stepName, kind: decidedAtKind },
        suspects: selected.map((e) => toCard(e.s, e.trueRank, opts.custody)),
        trail: opts.trail,
        folded,
        scoreNote,
        baseline: report.baseline
            ? `${report.baseline.flips}/${report.baseline.samples} flipped with no ablation`
            : undefined,
        honesty,
    };
}
//# sourceMappingURL=toBacktrackTrace.js.map