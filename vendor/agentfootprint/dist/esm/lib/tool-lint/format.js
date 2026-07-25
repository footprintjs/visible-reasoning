/**
 * formatToolCatalogReport — human-readable rendering of a lint report.
 *
 * Pattern: pure presenter. One report → one string; used verbatim by the
 *          CLI (`agentfootprint-lint-tools`) and the examples so output
 *          stays byte-identical across surfaces.
 * Role:    `src/lib/tool-lint/` leaf. No I/O.
 */
export function formatToolCatalogReport(report, options = {}) {
    const topPairs = options.topPairs ?? 10;
    const maxWatch = options.maxWatch ?? 10;
    const lines = [];
    const { similarity, structural, summary } = report;
    lines.push(`tool-catalog lint — ${report.toolCount} tools · ` +
        `${summary.confusable} confusable · ${summary.watch} watch · ` +
        `${summary.errors} errors · ${summary.warnings} warnings`);
    if (similarity.analyzed) {
        lines.push('', `confusability (threshold ${similarity.thresholds.confusabilityThreshold}, ` +
            `watch band ${similarity.thresholds.watchBand}):`);
        if (similarity.confusable.length === 0 && similarity.watch.length === 0) {
            lines.push('  no pairs at or near the threshold');
        }
        for (const pair of similarity.confusable) {
            lines.push(`  ✗ CONFUSABLE ${pair.similarity.toFixed(4)}  ${pair.a} <> ${pair.b}`);
            lines.push(`      hint: ${pair.hint}`);
        }
        for (const pair of similarity.watch.slice(0, maxWatch)) {
            lines.push(`  ~ watch      ${pair.similarity.toFixed(4)}  ${pair.a} <> ${pair.b}`);
            lines.push(`      hint: ${pair.hint}`);
        }
        if (similarity.watch.length > maxWatch) {
            lines.push(`  … and ${similarity.watch.length - maxWatch} more watch pairs (see report.similarity.watch)`);
        }
        if (topPairs > 0 && similarity.ranked.length > 0) {
            lines.push('', `  most-similar pairs (relative ordering — top ${topPairs}):`);
            for (const pair of similarity.ranked.slice(0, topPairs)) {
                lines.push(`    ${pair.similarity.toFixed(4)}  ${pair.a} <> ${pair.b}`);
            }
        }
    }
    else {
        lines.push('', 'confusability: skipped (no embedder supplied — structural rules only)');
    }
    if (structural.length > 0) {
        lines.push('', 'structural findings:');
        for (const finding of structural) {
            const where = finding.param ? `${finding.tool}.${finding.param}` : finding.tool;
            const mark = finding.severity === 'error' ? '✗' : '~';
            lines.push(`  ${mark} ${finding.severity.padEnd(5)} [${finding.rule}] ${where}`);
            lines.push(`      ${finding.message}`);
            if (finding.suggestion)
                lines.push(`      suggest: ${finding.suggestion}`);
        }
    }
    else {
        lines.push('', 'structural findings: none');
    }
    lines.push('', report.ok ? 'RESULT: ok' : 'RESULT: FAIL');
    return lines.join('\n');
}
//# sourceMappingURL=format.js.map