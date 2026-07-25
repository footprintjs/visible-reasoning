/**
 * slice/serialize.ts — JSON-safe and LLM-safe projections of a slice.
 *
 * WHY (the failure this prevents): `VariableSlice.root` is an in-memory DAG.
 * Nodes are SHARED — a diamond ancestor is one object reached through many
 * paths, and each node appears in both `parents` and `parentEdges[].parent`.
 * `JSON.stringify` knows nothing about sharing: it re-serializes every shared
 * subtree per path, which explodes combinatorially on diamond-heavy slices.
 * The two consumers that would naively stringify are exactly the ones this
 * library exists for — wire transfer (persist / send a slice) and LLM tools
 * (bounded context). Each gets a purpose-built projection:
 *
 * - {@link sliceToJSON}   — flat, id-referenced, LINEAR in node count.
 * - {@link formatSlice}   — one bounded human/LLM-readable string that also
 *   renders the honesty envelope (missing reason, reads coverage, truncation)
 *   a raw `formatCausalChain` doesn't know about.
 */
import { flattenCausalDAG, formatCausalChain } from '../memory/backtrack.js';
/**
 * Flat, JSON-safe projection: every DAG node exactly once (keyed by
 * runtimeStageId), edges as id references. Linear in node count — safe to
 * persist, send, or feed to structured consumers. Lossless for everything
 * except the in-memory object graph itself (rebuild adjacency from `edges`).
 */
export function sliceToJSON(slice) {
    const out = {
        key: slice.key,
        ...(slice.before !== undefined && { before: slice.before }),
        ...(slice.missing !== undefined && { missing: slice.missing }),
        keysReadKind: slice.keysReadKind,
        ...(slice.readsCoverage !== undefined && { readsCoverage: slice.readsCoverage }),
    };
    if (!slice.root)
        return out;
    out.writerId = slice.root.runtimeStageId;
    const nodes = {};
    const edges = [];
    for (const node of flattenCausalDAG(slice.root)) {
        nodes[node.runtimeStageId] = {
            stageId: node.stageId,
            stageName: node.stageName,
            keysWritten: node.keysWritten,
            depth: node.depth,
            ...(node.incompleteSources !== undefined && { incompleteSources: node.incompleteSources }),
        };
        for (const edge of node.parentEdges) {
            edges.push({
                from: node.runtimeStageId,
                to: edge.parent.runtimeStageId,
                kind: edge.kind,
                ...(edge.key !== undefined && { key: edge.key }),
                weight: edge.weight,
            });
        }
    }
    out.nodes = nodes;
    out.edges = edges;
    if (slice.root.truncated)
        out.truncated = slice.root.truncated;
    return out;
}
/**
 * One bounded string for LLM triage tools (the `traceToolpack` consumption
 * pattern: tools return plain strings, never recursive objects). Wraps
 * `formatCausalChain` (which is budget-bounded by causalChain's
 * maxDepth/maxNodes and renders shared nodes once as `↳ … (see above)`),
 * and adds the honesty envelope the raw chain doesn't carry:
 *
 * - missing slices render their reason ("value came from initial state /
 *   frozen args / a closure — the commit log cannot see those"),
 * - a reads-less provider (`readTracking: 'off'` signature) renders an
 *   explicit "⚠ reads were not recorded" instead of silently showing an
 *   anchor with no dependencies,
 * - truncation footers pass through from formatCausalChain.
 */
export function formatSlice(slice) {
    const lines = [];
    const anchor = slice.before !== undefined ? ` (before commit ${slice.before})` : '';
    lines.push(`SLICE for '${slice.key}'${anchor} — reads via: ${slice.keysReadKind}`);
    if (slice.missing === 'empty-log') {
        lines.push('no slice: the commit log is empty (nothing has executed).');
        return lines.join('\n');
    }
    if (slice.missing === 'never-written') {
        lines.push(`no slice: '${slice.key}' was never written in range — the value came from ` +
            'initial state, frozen run input (args), or a closure; the commit log cannot see those.');
        return lines.join('\n');
    }
    const cov = slice.readsCoverage;
    if (cov && cov.steps > 1 && cov.stepsWithReads === 0) {
        lines.push("⚠ reads were not recorded (readTracking may be 'off') — dependencies below are " + 'unknowable, NOT absent.');
    }
    if (slice.root)
        lines.push(formatCausalChain(slice.root));
    return lines.join('\n');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VyaWFsaXplLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9zbGljZS9zZXJpYWxpemUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7R0FnQkc7QUFFSCxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUc3RTs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSxXQUFXLENBQUMsS0FBb0I7SUFDOUMsTUFBTSxHQUFHLEdBQWM7UUFDckIsR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHO1FBQ2QsR0FBRyxDQUFDLEtBQUssQ0FBQyxNQUFNLEtBQUssU0FBUyxJQUFJLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUMzRCxHQUFHLENBQUMsS0FBSyxDQUFDLE9BQU8sS0FBSyxTQUFTLElBQUksRUFBRSxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQzlELFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtRQUNoQyxHQUFHLENBQUMsS0FBSyxDQUFDLGFBQWEsS0FBSyxTQUFTLElBQUksRUFBRSxhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDO0tBQ2pGLENBQUM7SUFDRixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUk7UUFBRSxPQUFPLEdBQUcsQ0FBQztJQUU1QixHQUFHLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDO0lBQ3pDLE1BQU0sS0FBSyxHQUFvQyxFQUFFLENBQUM7SUFDbEQsTUFBTSxLQUFLLEdBQW9DLEVBQUUsQ0FBQztJQUNsRCxLQUFLLE1BQU0sSUFBSSxJQUFJLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ2hELEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDLEdBQUc7WUFDM0IsT0FBTyxFQUFFLElBQUksQ0FBQyxPQUFPO1lBQ3JCLFNBQVMsRUFBRSxJQUFJLENBQUMsU0FBUztZQUN6QixXQUFXLEVBQUUsSUFBSSxDQUFDLFdBQVc7WUFDN0IsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLO1lBQ2pCLEdBQUcsQ0FBQyxJQUFJLENBQUMsaUJBQWlCLEtBQUssU0FBUyxJQUFJLEVBQUUsaUJBQWlCLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7U0FDM0YsQ0FBQztRQUNGLEtBQUssTUFBTSxJQUFJLElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3BDLEtBQUssQ0FBQyxJQUFJLENBQUM7Z0JBQ1QsSUFBSSxFQUFFLElBQUksQ0FBQyxjQUFjO2dCQUN6QixFQUFFLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxjQUFjO2dCQUM5QixJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7Z0JBQ2YsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLEtBQUssU0FBUyxJQUFJLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztnQkFDaEQsTUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNO2FBQ3BCLENBQUMsQ0FBQztRQUNMLENBQUM7SUFDSCxDQUFDO0lBQ0QsR0FBRyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7SUFDbEIsR0FBRyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7SUFDbEIsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVM7UUFBRSxHQUFHLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDO0lBQy9ELE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7O0dBYUc7QUFDSCxNQUFNLFVBQVUsV0FBVyxDQUFDLEtBQW9CO0lBQzlDLE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztJQUMzQixNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsTUFBTSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsbUJBQW1CLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3BGLEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxLQUFLLENBQUMsR0FBRyxJQUFJLE1BQU0saUJBQWlCLEtBQUssQ0FBQyxZQUFZLEVBQUUsQ0FBQyxDQUFDO0lBRW5GLElBQUksS0FBSyxDQUFDLE9BQU8sS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUNsQyxLQUFLLENBQUMsSUFBSSxDQUFDLDJEQUEyRCxDQUFDLENBQUM7UUFDeEUsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzFCLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxPQUFPLEtBQUssZUFBZSxFQUFFLENBQUM7UUFDdEMsS0FBSyxDQUFDLElBQUksQ0FDUixjQUFjLEtBQUssQ0FBQyxHQUFHLHFEQUFxRDtZQUMxRSx3RkFBd0YsQ0FDM0YsQ0FBQztRQUNGLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUMxQixDQUFDO0lBRUQsTUFBTSxHQUFHLEdBQUcsS0FBSyxDQUFDLGFBQWEsQ0FBQztJQUNoQyxJQUFJLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxHQUFHLENBQUMsSUFBSSxHQUFHLENBQUMsY0FBYyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3JELEtBQUssQ0FBQyxJQUFJLENBQ1IsaUZBQWlGLEdBQUcseUJBQXlCLENBQzlHLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSTtRQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDMUQsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQzFCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHNsaWNlL3NlcmlhbGl6ZS50cyDigJQgSlNPTi1zYWZlIGFuZCBMTE0tc2FmZSBwcm9qZWN0aW9ucyBvZiBhIHNsaWNlLlxuICpcbiAqIFdIWSAodGhlIGZhaWx1cmUgdGhpcyBwcmV2ZW50cyk6IGBWYXJpYWJsZVNsaWNlLnJvb3RgIGlzIGFuIGluLW1lbW9yeSBEQUcuXG4gKiBOb2RlcyBhcmUgU0hBUkVEIOKAlCBhIGRpYW1vbmQgYW5jZXN0b3IgaXMgb25lIG9iamVjdCByZWFjaGVkIHRocm91Z2ggbWFueVxuICogcGF0aHMsIGFuZCBlYWNoIG5vZGUgYXBwZWFycyBpbiBib3RoIGBwYXJlbnRzYCBhbmQgYHBhcmVudEVkZ2VzW10ucGFyZW50YC5cbiAqIGBKU09OLnN0cmluZ2lmeWAga25vd3Mgbm90aGluZyBhYm91dCBzaGFyaW5nOiBpdCByZS1zZXJpYWxpemVzIGV2ZXJ5IHNoYXJlZFxuICogc3VidHJlZSBwZXIgcGF0aCwgd2hpY2ggZXhwbG9kZXMgY29tYmluYXRvcmlhbGx5IG9uIGRpYW1vbmQtaGVhdnkgc2xpY2VzLlxuICogVGhlIHR3byBjb25zdW1lcnMgdGhhdCB3b3VsZCBuYWl2ZWx5IHN0cmluZ2lmeSBhcmUgZXhhY3RseSB0aGUgb25lcyB0aGlzXG4gKiBsaWJyYXJ5IGV4aXN0cyBmb3Ig4oCUIHdpcmUgdHJhbnNmZXIgKHBlcnNpc3QgLyBzZW5kIGEgc2xpY2UpIGFuZCBMTE0gdG9vbHNcbiAqIChib3VuZGVkIGNvbnRleHQpLiBFYWNoIGdldHMgYSBwdXJwb3NlLWJ1aWx0IHByb2plY3Rpb246XG4gKlxuICogLSB7QGxpbmsgc2xpY2VUb0pTT059ICAg4oCUIGZsYXQsIGlkLXJlZmVyZW5jZWQsIExJTkVBUiBpbiBub2RlIGNvdW50LlxuICogLSB7QGxpbmsgZm9ybWF0U2xpY2V9ICAg4oCUIG9uZSBib3VuZGVkIGh1bWFuL0xMTS1yZWFkYWJsZSBzdHJpbmcgdGhhdCBhbHNvXG4gKiAgIHJlbmRlcnMgdGhlIGhvbmVzdHkgZW52ZWxvcGUgKG1pc3NpbmcgcmVhc29uLCByZWFkcyBjb3ZlcmFnZSwgdHJ1bmNhdGlvbilcbiAqICAgYSByYXcgYGZvcm1hdENhdXNhbENoYWluYCBkb2Vzbid0IGtub3cgYWJvdXQuXG4gKi9cblxuaW1wb3J0IHsgZmxhdHRlbkNhdXNhbERBRywgZm9ybWF0Q2F1c2FsQ2hhaW4gfSBmcm9tICcuLi9tZW1vcnkvYmFja3RyYWNrLmpzJztcbmltcG9ydCB0eXBlIHsgU2xpY2VKU09OLCBWYXJpYWJsZVNsaWNlIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8qKlxuICogRmxhdCwgSlNPTi1zYWZlIHByb2plY3Rpb246IGV2ZXJ5IERBRyBub2RlIGV4YWN0bHkgb25jZSAoa2V5ZWQgYnlcbiAqIHJ1bnRpbWVTdGFnZUlkKSwgZWRnZXMgYXMgaWQgcmVmZXJlbmNlcy4gTGluZWFyIGluIG5vZGUgY291bnQg4oCUIHNhZmUgdG9cbiAqIHBlcnNpc3QsIHNlbmQsIG9yIGZlZWQgdG8gc3RydWN0dXJlZCBjb25zdW1lcnMuIExvc3NsZXNzIGZvciBldmVyeXRoaW5nXG4gKiBleGNlcHQgdGhlIGluLW1lbW9yeSBvYmplY3QgZ3JhcGggaXRzZWxmIChyZWJ1aWxkIGFkamFjZW5jeSBmcm9tIGBlZGdlc2ApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2xpY2VUb0pTT04oc2xpY2U6IFZhcmlhYmxlU2xpY2UpOiBTbGljZUpTT04ge1xuICBjb25zdCBvdXQ6IFNsaWNlSlNPTiA9IHtcbiAgICBrZXk6IHNsaWNlLmtleSxcbiAgICAuLi4oc2xpY2UuYmVmb3JlICE9PSB1bmRlZmluZWQgJiYgeyBiZWZvcmU6IHNsaWNlLmJlZm9yZSB9KSxcbiAgICAuLi4oc2xpY2UubWlzc2luZyAhPT0gdW5kZWZpbmVkICYmIHsgbWlzc2luZzogc2xpY2UubWlzc2luZyB9KSxcbiAgICBrZXlzUmVhZEtpbmQ6IHNsaWNlLmtleXNSZWFkS2luZCxcbiAgICAuLi4oc2xpY2UucmVhZHNDb3ZlcmFnZSAhPT0gdW5kZWZpbmVkICYmIHsgcmVhZHNDb3ZlcmFnZTogc2xpY2UucmVhZHNDb3ZlcmFnZSB9KSxcbiAgfTtcbiAgaWYgKCFzbGljZS5yb290KSByZXR1cm4gb3V0O1xuXG4gIG91dC53cml0ZXJJZCA9IHNsaWNlLnJvb3QucnVudGltZVN0YWdlSWQ7XG4gIGNvbnN0IG5vZGVzOiBOb25OdWxsYWJsZTxTbGljZUpTT05bJ25vZGVzJ10+ID0ge307XG4gIGNvbnN0IGVkZ2VzOiBOb25OdWxsYWJsZTxTbGljZUpTT05bJ2VkZ2VzJ10+ID0gW107XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuQ2F1c2FsREFHKHNsaWNlLnJvb3QpKSB7XG4gICAgbm9kZXNbbm9kZS5ydW50aW1lU3RhZ2VJZF0gPSB7XG4gICAgICBzdGFnZUlkOiBub2RlLnN0YWdlSWQsXG4gICAgICBzdGFnZU5hbWU6IG5vZGUuc3RhZ2VOYW1lLFxuICAgICAga2V5c1dyaXR0ZW46IG5vZGUua2V5c1dyaXR0ZW4sXG4gICAgICBkZXB0aDogbm9kZS5kZXB0aCxcbiAgICAgIC4uLihub2RlLmluY29tcGxldGVTb3VyY2VzICE9PSB1bmRlZmluZWQgJiYgeyBpbmNvbXBsZXRlU291cmNlczogbm9kZS5pbmNvbXBsZXRlU291cmNlcyB9KSxcbiAgICB9O1xuICAgIGZvciAoY29uc3QgZWRnZSBvZiBub2RlLnBhcmVudEVkZ2VzKSB7XG4gICAgICBlZGdlcy5wdXNoKHtcbiAgICAgICAgZnJvbTogbm9kZS5ydW50aW1lU3RhZ2VJZCxcbiAgICAgICAgdG86IGVkZ2UucGFyZW50LnJ1bnRpbWVTdGFnZUlkLFxuICAgICAgICBraW5kOiBlZGdlLmtpbmQsXG4gICAgICAgIC4uLihlZGdlLmtleSAhPT0gdW5kZWZpbmVkICYmIHsga2V5OiBlZGdlLmtleSB9KSxcbiAgICAgICAgd2VpZ2h0OiBlZGdlLndlaWdodCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICBvdXQubm9kZXMgPSBub2RlcztcbiAgb3V0LmVkZ2VzID0gZWRnZXM7XG4gIGlmIChzbGljZS5yb290LnRydW5jYXRlZCkgb3V0LnRydW5jYXRlZCA9IHNsaWNlLnJvb3QudHJ1bmNhdGVkO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIE9uZSBib3VuZGVkIHN0cmluZyBmb3IgTExNIHRyaWFnZSB0b29scyAodGhlIGB0cmFjZVRvb2xwYWNrYCBjb25zdW1wdGlvblxuICogcGF0dGVybjogdG9vbHMgcmV0dXJuIHBsYWluIHN0cmluZ3MsIG5ldmVyIHJlY3Vyc2l2ZSBvYmplY3RzKS4gV3JhcHNcbiAqIGBmb3JtYXRDYXVzYWxDaGFpbmAgKHdoaWNoIGlzIGJ1ZGdldC1ib3VuZGVkIGJ5IGNhdXNhbENoYWluJ3NcbiAqIG1heERlcHRoL21heE5vZGVzIGFuZCByZW5kZXJzIHNoYXJlZCBub2RlcyBvbmNlIGFzIGDihrMg4oCmIChzZWUgYWJvdmUpYCksXG4gKiBhbmQgYWRkcyB0aGUgaG9uZXN0eSBlbnZlbG9wZSB0aGUgcmF3IGNoYWluIGRvZXNuJ3QgY2Fycnk6XG4gKlxuICogLSBtaXNzaW5nIHNsaWNlcyByZW5kZXIgdGhlaXIgcmVhc29uIChcInZhbHVlIGNhbWUgZnJvbSBpbml0aWFsIHN0YXRlIC9cbiAqICAgZnJvemVuIGFyZ3MgLyBhIGNsb3N1cmUg4oCUIHRoZSBjb21taXQgbG9nIGNhbm5vdCBzZWUgdGhvc2VcIiksXG4gKiAtIGEgcmVhZHMtbGVzcyBwcm92aWRlciAoYHJlYWRUcmFja2luZzogJ29mZidgIHNpZ25hdHVyZSkgcmVuZGVycyBhblxuICogICBleHBsaWNpdCBcIuKaoCByZWFkcyB3ZXJlIG5vdCByZWNvcmRlZFwiIGluc3RlYWQgb2Ygc2lsZW50bHkgc2hvd2luZyBhblxuICogICBhbmNob3Igd2l0aCBubyBkZXBlbmRlbmNpZXMsXG4gKiAtIHRydW5jYXRpb24gZm9vdGVycyBwYXNzIHRocm91Z2ggZnJvbSBmb3JtYXRDYXVzYWxDaGFpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFNsaWNlKHNsaWNlOiBWYXJpYWJsZVNsaWNlKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGFuY2hvciA9IHNsaWNlLmJlZm9yZSAhPT0gdW5kZWZpbmVkID8gYCAoYmVmb3JlIGNvbW1pdCAke3NsaWNlLmJlZm9yZX0pYCA6ICcnO1xuICBsaW5lcy5wdXNoKGBTTElDRSBmb3IgJyR7c2xpY2Uua2V5fScke2FuY2hvcn0g4oCUIHJlYWRzIHZpYTogJHtzbGljZS5rZXlzUmVhZEtpbmR9YCk7XG5cbiAgaWYgKHNsaWNlLm1pc3NpbmcgPT09ICdlbXB0eS1sb2cnKSB7XG4gICAgbGluZXMucHVzaCgnbm8gc2xpY2U6IHRoZSBjb21taXQgbG9nIGlzIGVtcHR5IChub3RoaW5nIGhhcyBleGVjdXRlZCkuJyk7XG4gICAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpO1xuICB9XG4gIGlmIChzbGljZS5taXNzaW5nID09PSAnbmV2ZXItd3JpdHRlbicpIHtcbiAgICBsaW5lcy5wdXNoKFxuICAgICAgYG5vIHNsaWNlOiAnJHtzbGljZS5rZXl9JyB3YXMgbmV2ZXIgd3JpdHRlbiBpbiByYW5nZSDigJQgdGhlIHZhbHVlIGNhbWUgZnJvbSBgICtcbiAgICAgICAgJ2luaXRpYWwgc3RhdGUsIGZyb3plbiBydW4gaW5wdXQgKGFyZ3MpLCBvciBhIGNsb3N1cmU7IHRoZSBjb21taXQgbG9nIGNhbm5vdCBzZWUgdGhvc2UuJyxcbiAgICApO1xuICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbiAgfVxuXG4gIGNvbnN0IGNvdiA9IHNsaWNlLnJlYWRzQ292ZXJhZ2U7XG4gIGlmIChjb3YgJiYgY292LnN0ZXBzID4gMSAmJiBjb3Yuc3RlcHNXaXRoUmVhZHMgPT09IDApIHtcbiAgICBsaW5lcy5wdXNoKFxuICAgICAgXCLimqAgcmVhZHMgd2VyZSBub3QgcmVjb3JkZWQgKHJlYWRUcmFja2luZyBtYXkgYmUgJ29mZicpIOKAlCBkZXBlbmRlbmNpZXMgYmVsb3cgYXJlIFwiICsgJ3Vua25vd2FibGUsIE5PVCBhYnNlbnQuJyxcbiAgICApO1xuICB9XG4gIGlmIChzbGljZS5yb290KSBsaW5lcy5wdXNoKGZvcm1hdENhdXNhbENoYWluKHNsaWNlLnJvb3QpKTtcbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpO1xufVxuIl19