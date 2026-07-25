/**
 * decide/decide -- Core decide() and select() helper functions.
 *
 * decide() evaluates rules in order (first-match) and returns a DecisionResult.
 * select() evaluates ALL rules and returns a SelectionResult with all matches.
 *
 * Each rule's `when` can be:
 * - A function: (s) => s.creditScore > 700  (auto-captures reads via temp recorder)
 * - A filter:   { creditScore: { gt: 700 } } (captures reads + operators + thresholds)
 */
import { isDevMode } from '../scope/detectCircular.js';
import { evaluateFilter } from './evaluator.js';
import { EvidenceCollector } from './evidence.js';
import { DECISION_RESULT } from './types.js';
// -- Scope accessor helpers --------------------------------------------------
function getAttachFn(scope) {
    const s = scope;
    if (typeof s.$attachScopeRecorder === 'function')
        return s.$attachScopeRecorder.bind(s);
    if (typeof s.attachScopeRecorder === 'function')
        return s.attachScopeRecorder.bind(s);
    return undefined;
}
function getDetachFn(scope) {
    const s = scope;
    if (typeof s.$detachScopeRecorder === 'function')
        return s.$detachScopeRecorder.bind(s);
    if (typeof s.detachScopeRecorder === 'function')
        return s.detachScopeRecorder.bind(s);
    return undefined;
}
function getValueFn(scope) {
    const s = scope;
    // Check $getValue first: on TypedScope, accessing .getValue triggers a spurious
    // onRead for key "getValue" via the Proxy get trap. $getValue routes through
    // SCOPE_METHOD_NAMES and avoids the state-read path.
    if (typeof s.$getValue === 'function')
        return s.$getValue.bind(s);
    if (typeof s.getValue === 'function')
        return s.getValue.bind(s);
    return () => undefined;
}
function getRedactedFn(scope) {
    const s = scope;
    // Try $toRaw() first (TypedScope), then direct
    const raw = typeof s.$toRaw === 'function' ? s.$toRaw() : s;
    const r = raw;
    if (typeof r.getRedactedKeys === 'function') {
        const keys = r.getRedactedKeys();
        return (key) => keys.has(key);
    }
    return () => false;
}
// -- evaluate a single rule --------------------------------------------------
function evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn) {
    if (typeof rule.when === 'function') {
        // FUNCTION PATH: temp recorder captures reads (lazy — skip if no recorder support)
        const hasRecorderSupport = Boolean(attachFn);
        const collector = hasRecorderSupport ? new EvidenceCollector() : undefined;
        if (collector && attachFn)
            attachFn(collector);
        let matched;
        let matchError;
        try {
            matched = rule.when(scope);
        }
        catch (e) {
            matched = false;
            // Capture the error for debugging — surface it in evidence instead of swallowing silently
            matchError = e instanceof Error ? e.message : String(e);
            if (isDevMode()) {
                const label = rule.label ? ` ('${rule.label}')` : '';
                // eslint-disable-next-line no-console
                console.warn(`[footprint] decide() rule ${index}${label} threw during evaluation: ${matchError}`);
            }
        }
        finally {
            if (collector && detachFn)
                detachFn(collector.id);
        }
        const evidence = {
            type: 'function',
            ruleIndex: index,
            branch: rule.then,
            matched,
            label: rule.label,
            // Partial reads: if rule threw after some getValue() calls, collector holds reads up to the throw point
            inputs: collector?.getInputs() ?? [],
            ...(matchError !== undefined && { matchError }),
        };
        return evidence;
    }
    else {
        // FILTER PATH: reads values directly via callbacks (no recorder); exceptions treated as non-match
        const resolvedValueFn = valueFn ?? (() => undefined);
        const resolvedRedactedFn = redactedFn ?? (() => false);
        let filterMatched = false;
        let filterConditions = [];
        let matchError;
        try {
            const result = evaluateFilter(resolvedValueFn, resolvedRedactedFn, rule.when);
            filterMatched = result.matched;
            filterConditions = result.conditions;
        }
        catch (e) {
            filterMatched = false;
            filterConditions = [];
            // Capture the error for debugging — surface it in evidence instead of swallowing silently
            matchError = e instanceof Error ? e.message : String(e);
            if (isDevMode()) {
                const label = rule.label ? ` ('${rule.label}')` : '';
                // eslint-disable-next-line no-console
                console.warn(`[footprint] decide() filter rule ${index}${label} threw during evaluation: ${matchError}`);
            }
        }
        const evidence = {
            type: 'filter',
            ruleIndex: index,
            branch: rule.then,
            matched: filterMatched,
            label: rule.label,
            conditions: filterConditions,
            ...(matchError !== undefined && { matchError }),
        };
        return evidence;
    }
}
// -- decide() ----------------------------------------------------------------
/**
 * Evaluates rules in order (first-match). Returns a branded DecisionResult.
 *
 * @param scope - TypedScope or ScopeFacade
 * @param rules - Array of DecideRule (function or filter when clauses)
 * @param defaultBranch - Branch ID if no rule matches
 *
 * **Error behavior:** If a `when` function throws during evaluation, the rule is
 * treated as non-matching (`matched: false`) and the error message is captured in
 * `matchError` on that rule's `RuleEvidence` entry. Execution continues with
 * subsequent rules; errors do not propagate to the caller.
 *
 * **Empty-filter behavior (anti-vacuous-truth):** a filter rule whose `when` is
 * `{}` (no evaluable conditions) NEVER matches. This deliberately inverts the
 * Prisma/SQL `where: {}` intuition ("match everything") — a rule that asserts
 * nothing must not win a branch on vacuous truth. Use `defaultBranch` for the
 * catch-all instead. Unknown filter operators also never match (dev mode warns).
 */
export function decide(scope, rules, defaultBranch) {
    const attachFn = getAttachFn(scope);
    const detachFn = getDetachFn(scope);
    const valueFn = getValueFn(scope);
    const redactedFn = getRedactedFn(scope);
    const evaluatedRules = [];
    for (const [index, rule] of rules.entries()) {
        const ruleEvidence = evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn);
        evaluatedRules.push(ruleEvidence);
        if (ruleEvidence.matched) {
            const evidence = {
                rules: evaluatedRules,
                chosen: rule.then,
                default: defaultBranch,
            };
            return { branch: rule.then, [DECISION_RESULT]: true, evidence };
        }
    }
    // Default: no rule matched
    const evidence = {
        rules: evaluatedRules,
        chosen: defaultBranch,
        default: defaultBranch,
    };
    return { branch: defaultBranch, [DECISION_RESULT]: true, evidence };
}
// -- select() ----------------------------------------------------------------
/**
 * Evaluates ALL rules (not first-match). Returns a branded SelectionResult.
 *
 * @param scope - TypedScope or ScopeFacade
 * @param rules - Array of DecideRule (function or filter when clauses)
 *
 * **Error behavior:** If a `when` function throws during evaluation, the rule is
 * treated as non-matching (`matched: false`) and the error message is captured in
 * `matchError` on that rule's `RuleEvidence` entry. Evaluation continues with
 * remaining rules; errors do not propagate to the caller.
 *
 * **Empty-filter behavior (anti-vacuous-truth):** a filter rule whose `when` is
 * `{}` (no evaluable conditions) NEVER matches — same rule as `decide()`; an
 * always-selected branch must be expressed explicitly, not via an empty filter.
 * Unknown filter operators also never match (dev mode warns).
 */
export function select(scope, rules) {
    const attachFn = getAttachFn(scope);
    const detachFn = getDetachFn(scope);
    const valueFn = getValueFn(scope);
    const redactedFn = getRedactedFn(scope);
    const evaluatedRules = [];
    const selectedBranches = [];
    for (const [index, rule] of rules.entries()) {
        const ruleEvidence = evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn);
        evaluatedRules.push(ruleEvidence);
        if (ruleEvidence.matched) {
            selectedBranches.push(rule.then);
        }
    }
    const evidence = {
        rules: evaluatedRules,
        selected: selectedBranches,
    };
    return { branches: selectedBranches, [DECISION_RESULT]: true, evidence };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVjaWRlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9kZWNpZGUvZGVjaWRlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7R0FTRztBQUVILE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSw0QkFBNEIsQ0FBQztBQUV2RCxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDaEQsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sZUFBZSxDQUFDO0FBYWxELE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFN0MsK0VBQStFO0FBRS9FLFNBQVMsV0FBVyxDQUFDLEtBQWM7SUFDakMsTUFBTSxDQUFDLEdBQUcsS0FBZ0MsQ0FBQztJQUMzQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLG9CQUFvQixLQUFLLFVBQVU7UUFBRSxPQUFPLENBQUMsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDeEYsSUFBSSxPQUFPLENBQUMsQ0FBQyxtQkFBbUIsS0FBSyxVQUFVO1FBQUUsT0FBTyxDQUFDLENBQUMsbUJBQW1CLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RGLE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxLQUFjO0lBQ2pDLE1BQU0sQ0FBQyxHQUFHLEtBQWdDLENBQUM7SUFDM0MsSUFBSSxPQUFPLENBQUMsQ0FBQyxvQkFBb0IsS0FBSyxVQUFVO1FBQUUsT0FBTyxDQUFDLENBQUMsb0JBQW9CLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3hGLElBQUksT0FBTyxDQUFDLENBQUMsbUJBQW1CLEtBQUssVUFBVTtRQUFFLE9BQU8sQ0FBQyxDQUFDLG1CQUFtQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN0RixPQUFPLFNBQVMsQ0FBQztBQUNuQixDQUFDO0FBRUQsU0FBUyxVQUFVLENBQUMsS0FBYztJQUNoQyxNQUFNLENBQUMsR0FBRyxLQUFnQyxDQUFDO0lBQzNDLGdGQUFnRjtJQUNoRiw2RUFBNkU7SUFDN0UscURBQXFEO0lBQ3JELElBQUksT0FBTyxDQUFDLENBQUMsU0FBUyxLQUFLLFVBQVU7UUFBRSxPQUFPLENBQUMsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xFLElBQUksT0FBTyxDQUFDLENBQUMsUUFBUSxLQUFLLFVBQVU7UUFBRSxPQUFPLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2hFLE9BQU8sR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDO0FBQ3pCLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxLQUFjO0lBQ25DLE1BQU0sQ0FBQyxHQUFHLEtBQWdDLENBQUM7SUFDM0MsK0NBQStDO0lBQy9DLE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxDQUFDLE1BQU0sS0FBSyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVELE1BQU0sQ0FBQyxHQUFHLEdBQThCLENBQUM7SUFDekMsSUFBSSxPQUFPLENBQUMsQ0FBQyxlQUFlLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDNUMsTUFBTSxJQUFJLEdBQUcsQ0FBQyxDQUFDLGVBQWUsRUFBaUIsQ0FBQztRQUNoRCxPQUFPLENBQUMsR0FBVyxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3hDLENBQUM7SUFDRCxPQUFPLEdBQUcsRUFBRSxDQUFDLEtBQUssQ0FBQztBQUNyQixDQUFDO0FBRUQsK0VBQStFO0FBRS9FLFNBQVMsWUFBWSxDQUNuQixLQUFRLEVBQ1IsSUFBbUIsRUFDbkIsS0FBYSxFQUNiLFFBQXFDLEVBQ3JDLFFBQStCLEVBQy9CLE9BQWtDLEVBQ2xDLFVBQXFDO0lBRXJDLElBQUksT0FBTyxJQUFJLENBQUMsSUFBSSxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQ3BDLG1GQUFtRjtRQUNuRixNQUFNLGtCQUFrQixHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUM3QyxNQUFNLFNBQVMsR0FBRyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsSUFBSSxpQkFBaUIsRUFBRSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDM0UsSUFBSSxTQUFTLElBQUksUUFBUTtZQUFFLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUUvQyxJQUFJLE9BQWdCLENBQUM7UUFDckIsSUFBSSxVQUE4QixDQUFDO1FBQ25DLElBQUksQ0FBQztZQUNILE9BQU8sR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzdCLENBQUM7UUFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ1gsT0FBTyxHQUFHLEtBQUssQ0FBQztZQUNoQiwwRkFBMEY7WUFDMUYsVUFBVSxHQUFHLENBQUMsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN4RCxJQUFJLFNBQVMsRUFBRSxFQUFFLENBQUM7Z0JBQ2hCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQ3JELHNDQUFzQztnQkFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyw2QkFBNkIsS0FBSyxHQUFHLEtBQUssNkJBQTZCLFVBQVUsRUFBRSxDQUFDLENBQUM7WUFDcEcsQ0FBQztRQUNILENBQUM7Z0JBQVMsQ0FBQztZQUNULElBQUksU0FBUyxJQUFJLFFBQVE7Z0JBQUUsUUFBUSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNwRCxDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQXlCO1lBQ3JDLElBQUksRUFBRSxVQUFVO1lBQ2hCLFNBQVMsRUFBRSxLQUFLO1lBQ2hCLE1BQU0sRUFBRSxJQUFJLENBQUMsSUFBSTtZQUNqQixPQUFPO1lBQ1AsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLO1lBQ2pCLHdHQUF3RztZQUN4RyxNQUFNLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUU7WUFDcEMsR0FBRyxDQUFDLFVBQVUsS0FBSyxTQUFTLElBQUksRUFBRSxVQUFVLEVBQUUsQ0FBQztTQUNoRCxDQUFDO1FBQ0YsT0FBTyxRQUFRLENBQUM7SUFDbEIsQ0FBQztTQUFNLENBQUM7UUFDTixrR0FBa0c7UUFDbEcsTUFBTSxlQUFlLEdBQUcsT0FBTyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDckQsTUFBTSxrQkFBa0IsR0FBRyxVQUFVLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2RCxJQUFJLGFBQWEsR0FBRyxLQUFLLENBQUM7UUFDMUIsSUFBSSxnQkFBZ0IsR0FBc0IsRUFBRSxDQUFDO1FBQzdDLElBQUksVUFBOEIsQ0FBQztRQUNuQyxJQUFJLENBQUM7WUFDSCxNQUFNLE1BQU0sR0FBRyxjQUFjLENBQUMsZUFBZSxFQUFFLGtCQUFrQixFQUFFLElBQUksQ0FBQyxJQUFzQixDQUFDLENBQUM7WUFDaEcsYUFBYSxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUM7WUFDL0IsZ0JBQWdCLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQztRQUN2QyxDQUFDO1FBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNYLGFBQWEsR0FBRyxLQUFLLENBQUM7WUFDdEIsZ0JBQWdCLEdBQUcsRUFBRSxDQUFDO1lBQ3RCLDBGQUEwRjtZQUMxRixVQUFVLEdBQUcsQ0FBQyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3hELElBQUksU0FBUyxFQUFFLEVBQUUsQ0FBQztnQkFDaEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDckQsc0NBQXNDO2dCQUN0QyxPQUFPLENBQUMsSUFBSSxDQUFDLG9DQUFvQyxLQUFLLEdBQUcsS0FBSyw2QkFBNkIsVUFBVSxFQUFFLENBQUMsQ0FBQztZQUMzRyxDQUFDO1FBQ0gsQ0FBQztRQUVELE1BQU0sUUFBUSxHQUF1QjtZQUNuQyxJQUFJLEVBQUUsUUFBUTtZQUNkLFNBQVMsRUFBRSxLQUFLO1lBQ2hCLE1BQU0sRUFBRSxJQUFJLENBQUMsSUFBSTtZQUNqQixPQUFPLEVBQUUsYUFBYTtZQUN0QixLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUs7WUFDakIsVUFBVSxFQUFFLGdCQUFnQjtZQUM1QixHQUFHLENBQUMsVUFBVSxLQUFLLFNBQVMsSUFBSSxFQUFFLFVBQVUsRUFBRSxDQUFDO1NBQ2hELENBQUM7UUFDRixPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0FBQ0gsQ0FBQztBQUVELCtFQUErRTtBQUUvRTs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FpQkc7QUFDSCxNQUFNLFVBQVUsTUFBTSxDQUFtQixLQUFRLEVBQUUsS0FBc0IsRUFBRSxhQUFxQjtJQUM5RixNQUFNLFFBQVEsR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDcEMsTUFBTSxRQUFRLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3BDLE1BQU0sT0FBTyxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNsQyxNQUFNLFVBQVUsR0FBRyxhQUFhLENBQUMsS0FBSyxDQUFDLENBQUM7SUFFeEMsTUFBTSxjQUFjLEdBQW1CLEVBQUUsQ0FBQztJQUUxQyxLQUFLLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksS0FBSyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUM7UUFDNUMsTUFBTSxZQUFZLEdBQUcsWUFBWSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLFVBQVUsQ0FBQyxDQUFDO1FBQy9GLGNBQWMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFFbEMsSUFBSSxZQUFZLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDekIsTUFBTSxRQUFRLEdBQXFCO2dCQUNqQyxLQUFLLEVBQUUsY0FBYztnQkFDckIsTUFBTSxFQUFFLElBQUksQ0FBQyxJQUFJO2dCQUNqQixPQUFPLEVBQUUsYUFBYTthQUN2QixDQUFDO1lBQ0YsT0FBTyxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsZUFBZSxDQUFDLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxDQUFDO1FBQ2xFLENBQUM7SUFDSCxDQUFDO0lBRUQsMkJBQTJCO0lBQzNCLE1BQU0sUUFBUSxHQUFxQjtRQUNqQyxLQUFLLEVBQUUsY0FBYztRQUNyQixNQUFNLEVBQUUsYUFBYTtRQUNyQixPQUFPLEVBQUUsYUFBYTtLQUN2QixDQUFDO0lBQ0YsT0FBTyxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsQ0FBQyxlQUFlLENBQUMsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLENBQUM7QUFDdEUsQ0FBQztBQUVELCtFQUErRTtBQUUvRTs7Ozs7Ozs7Ozs7Ozs7O0dBZUc7QUFDSCxNQUFNLFVBQVUsTUFBTSxDQUFtQixLQUFRLEVBQUUsS0FBc0I7SUFDdkUsTUFBTSxRQUFRLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3BDLE1BQU0sUUFBUSxHQUFHLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNwQyxNQUFNLE9BQU8sR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDbEMsTUFBTSxVQUFVLEdBQUcsYUFBYSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBRXhDLE1BQU0sY0FBYyxHQUFtQixFQUFFLENBQUM7SUFDMUMsTUFBTSxnQkFBZ0IsR0FBYSxFQUFFLENBQUM7SUFFdEMsS0FBSyxNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLEtBQUssQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1FBQzVDLE1BQU0sWUFBWSxHQUFHLFlBQVksQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxVQUFVLENBQUMsQ0FBQztRQUMvRixjQUFjLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBRWxDLElBQUksWUFBWSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ3pCLGdCQUFnQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDbkMsQ0FBQztJQUNILENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBc0I7UUFDbEMsS0FBSyxFQUFFLGNBQWM7UUFDckIsUUFBUSxFQUFFLGdCQUFnQjtLQUMzQixDQUFDO0lBQ0YsT0FBTyxFQUFFLFFBQVEsRUFBRSxnQkFBZ0IsRUFBRSxDQUFDLGVBQWUsQ0FBQyxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsQ0FBQztBQUMzRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZWNpZGUvZGVjaWRlIC0tIENvcmUgZGVjaWRlKCkgYW5kIHNlbGVjdCgpIGhlbHBlciBmdW5jdGlvbnMuXG4gKlxuICogZGVjaWRlKCkgZXZhbHVhdGVzIHJ1bGVzIGluIG9yZGVyIChmaXJzdC1tYXRjaCkgYW5kIHJldHVybnMgYSBEZWNpc2lvblJlc3VsdC5cbiAqIHNlbGVjdCgpIGV2YWx1YXRlcyBBTEwgcnVsZXMgYW5kIHJldHVybnMgYSBTZWxlY3Rpb25SZXN1bHQgd2l0aCBhbGwgbWF0Y2hlcy5cbiAqXG4gKiBFYWNoIHJ1bGUncyBgd2hlbmAgY2FuIGJlOlxuICogLSBBIGZ1bmN0aW9uOiAocykgPT4gcy5jcmVkaXRTY29yZSA+IDcwMCAgKGF1dG8tY2FwdHVyZXMgcmVhZHMgdmlhIHRlbXAgcmVjb3JkZXIpXG4gKiAtIEEgZmlsdGVyOiAgIHsgY3JlZGl0U2NvcmU6IHsgZ3Q6IDcwMCB9IH0gKGNhcHR1cmVzIHJlYWRzICsgb3BlcmF0b3JzICsgdGhyZXNob2xkcylcbiAqL1xuXG5pbXBvcnQgeyBpc0Rldk1vZGUgfSBmcm9tICcuLi9zY29wZS9kZXRlY3RDaXJjdWxhci5qcyc7XG5pbXBvcnQgdHlwZSB7IFNjb3BlUmVjb3JkZXIgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBldmFsdWF0ZUZpbHRlciB9IGZyb20gJy4vZXZhbHVhdG9yLmpzJztcbmltcG9ydCB7IEV2aWRlbmNlQ29sbGVjdG9yIH0gZnJvbSAnLi9ldmlkZW5jZS5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIERlY2lkZVJ1bGUsXG4gIERlY2lzaW9uRXZpZGVuY2UsXG4gIERlY2lzaW9uUmVzdWx0LFxuICBGaWx0ZXJDb25kaXRpb24sXG4gIEZpbHRlclJ1bGVFdmlkZW5jZSxcbiAgRnVuY3Rpb25SdWxlRXZpZGVuY2UsXG4gIFJ1bGVFdmlkZW5jZSxcbiAgU2VsZWN0aW9uRXZpZGVuY2UsXG4gIFNlbGVjdGlvblJlc3VsdCxcbiAgV2hlcmVGaWx0ZXIsXG59IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHsgREVDSVNJT05fUkVTVUxUIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIC0tIFNjb3BlIGFjY2Vzc29yIGhlbHBlcnMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gZ2V0QXR0YWNoRm4oc2NvcGU6IHVua25vd24pOiAoKHI6IFNjb3BlUmVjb3JkZXIpID0+IHZvaWQpIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcyA9IHNjb3BlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBpZiAodHlwZW9mIHMuJGF0dGFjaFNjb3BlUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHJldHVybiBzLiRhdHRhY2hTY29wZVJlY29yZGVyLmJpbmQocyk7XG4gIGlmICh0eXBlb2Ygcy5hdHRhY2hTY29wZVJlY29yZGVyID09PSAnZnVuY3Rpb24nKSByZXR1cm4gcy5hdHRhY2hTY29wZVJlY29yZGVyLmJpbmQocyk7XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGdldERldGFjaEZuKHNjb3BlOiB1bmtub3duKTogKChpZDogc3RyaW5nKSA9PiB2b2lkKSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHMgPSBzY29wZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaWYgKHR5cGVvZiBzLiRkZXRhY2hTY29wZVJlY29yZGVyID09PSAnZnVuY3Rpb24nKSByZXR1cm4gcy4kZGV0YWNoU2NvcGVSZWNvcmRlci5iaW5kKHMpO1xuICBpZiAodHlwZW9mIHMuZGV0YWNoU2NvcGVSZWNvcmRlciA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHMuZGV0YWNoU2NvcGVSZWNvcmRlci5iaW5kKHMpO1xuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBnZXRWYWx1ZUZuKHNjb3BlOiB1bmtub3duKTogKGtleTogc3RyaW5nKSA9PiB1bmtub3duIHtcbiAgY29uc3QgcyA9IHNjb3BlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAvLyBDaGVjayAkZ2V0VmFsdWUgZmlyc3Q6IG9uIFR5cGVkU2NvcGUsIGFjY2Vzc2luZyAuZ2V0VmFsdWUgdHJpZ2dlcnMgYSBzcHVyaW91c1xuICAvLyBvblJlYWQgZm9yIGtleSBcImdldFZhbHVlXCIgdmlhIHRoZSBQcm94eSBnZXQgdHJhcC4gJGdldFZhbHVlIHJvdXRlcyB0aHJvdWdoXG4gIC8vIFNDT1BFX01FVEhPRF9OQU1FUyBhbmQgYXZvaWRzIHRoZSBzdGF0ZS1yZWFkIHBhdGguXG4gIGlmICh0eXBlb2Ygcy4kZ2V0VmFsdWUgPT09ICdmdW5jdGlvbicpIHJldHVybiBzLiRnZXRWYWx1ZS5iaW5kKHMpO1xuICBpZiAodHlwZW9mIHMuZ2V0VmFsdWUgPT09ICdmdW5jdGlvbicpIHJldHVybiBzLmdldFZhbHVlLmJpbmQocyk7XG4gIHJldHVybiAoKSA9PiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGdldFJlZGFjdGVkRm4oc2NvcGU6IHVua25vd24pOiAoa2V5OiBzdHJpbmcpID0+IGJvb2xlYW4ge1xuICBjb25zdCBzID0gc2NvcGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIC8vIFRyeSAkdG9SYXcoKSBmaXJzdCAoVHlwZWRTY29wZSksIHRoZW4gZGlyZWN0XG4gIGNvbnN0IHJhdyA9IHR5cGVvZiBzLiR0b1JhdyA9PT0gJ2Z1bmN0aW9uJyA/IHMuJHRvUmF3KCkgOiBzO1xuICBjb25zdCByID0gcmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBpZiAodHlwZW9mIHIuZ2V0UmVkYWN0ZWRLZXlzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY29uc3Qga2V5cyA9IHIuZ2V0UmVkYWN0ZWRLZXlzKCkgYXMgU2V0PHN0cmluZz47XG4gICAgcmV0dXJuIChrZXk6IHN0cmluZykgPT4ga2V5cy5oYXMoa2V5KTtcbiAgfVxuICByZXR1cm4gKCkgPT4gZmFsc2U7XG59XG5cbi8vIC0tIGV2YWx1YXRlIGEgc2luZ2xlIHJ1bGUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gZXZhbHVhdGVSdWxlPFMgZXh0ZW5kcyBvYmplY3Q+KFxuICBzY29wZTogUyxcbiAgcnVsZTogRGVjaWRlUnVsZTxTPixcbiAgaW5kZXg6IG51bWJlcixcbiAgYXR0YWNoRm4/OiAocjogU2NvcGVSZWNvcmRlcikgPT4gdm9pZCxcbiAgZGV0YWNoRm4/OiAoaWQ6IHN0cmluZykgPT4gdm9pZCxcbiAgdmFsdWVGbj86IChrZXk6IHN0cmluZykgPT4gdW5rbm93bixcbiAgcmVkYWN0ZWRGbj86IChrZXk6IHN0cmluZykgPT4gYm9vbGVhbixcbik6IFJ1bGVFdmlkZW5jZSB7XG4gIGlmICh0eXBlb2YgcnVsZS53aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgLy8gRlVOQ1RJT04gUEFUSDogdGVtcCByZWNvcmRlciBjYXB0dXJlcyByZWFkcyAobGF6eSDigJQgc2tpcCBpZiBubyByZWNvcmRlciBzdXBwb3J0KVxuICAgIGNvbnN0IGhhc1JlY29yZGVyU3VwcG9ydCA9IEJvb2xlYW4oYXR0YWNoRm4pO1xuICAgIGNvbnN0IGNvbGxlY3RvciA9IGhhc1JlY29yZGVyU3VwcG9ydCA/IG5ldyBFdmlkZW5jZUNvbGxlY3RvcigpIDogdW5kZWZpbmVkO1xuICAgIGlmIChjb2xsZWN0b3IgJiYgYXR0YWNoRm4pIGF0dGFjaEZuKGNvbGxlY3Rvcik7XG5cbiAgICBsZXQgbWF0Y2hlZDogYm9vbGVhbjtcbiAgICBsZXQgbWF0Y2hFcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBtYXRjaGVkID0gcnVsZS53aGVuKHNjb3BlKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBtYXRjaGVkID0gZmFsc2U7XG4gICAgICAvLyBDYXB0dXJlIHRoZSBlcnJvciBmb3IgZGVidWdnaW5nIOKAlCBzdXJmYWNlIGl0IGluIGV2aWRlbmNlIGluc3RlYWQgb2Ygc3dhbGxvd2luZyBzaWxlbnRseVxuICAgICAgbWF0Y2hFcnJvciA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAgIGlmIChpc0Rldk1vZGUoKSkge1xuICAgICAgICBjb25zdCBsYWJlbCA9IHJ1bGUubGFiZWwgPyBgICgnJHtydWxlLmxhYmVsfScpYCA6ICcnO1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIGRlY2lkZSgpIHJ1bGUgJHtpbmRleH0ke2xhYmVsfSB0aHJldyBkdXJpbmcgZXZhbHVhdGlvbjogJHttYXRjaEVycm9yfWApO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAoY29sbGVjdG9yICYmIGRldGFjaEZuKSBkZXRhY2hGbihjb2xsZWN0b3IuaWQpO1xuICAgIH1cblxuICAgIGNvbnN0IGV2aWRlbmNlOiBGdW5jdGlvblJ1bGVFdmlkZW5jZSA9IHtcbiAgICAgIHR5cGU6ICdmdW5jdGlvbicsXG4gICAgICBydWxlSW5kZXg6IGluZGV4LFxuICAgICAgYnJhbmNoOiBydWxlLnRoZW4sXG4gICAgICBtYXRjaGVkLFxuICAgICAgbGFiZWw6IHJ1bGUubGFiZWwsXG4gICAgICAvLyBQYXJ0aWFsIHJlYWRzOiBpZiBydWxlIHRocmV3IGFmdGVyIHNvbWUgZ2V0VmFsdWUoKSBjYWxscywgY29sbGVjdG9yIGhvbGRzIHJlYWRzIHVwIHRvIHRoZSB0aHJvdyBwb2ludFxuICAgICAgaW5wdXRzOiBjb2xsZWN0b3I/LmdldElucHV0cygpID8/IFtdLFxuICAgICAgLi4uKG1hdGNoRXJyb3IgIT09IHVuZGVmaW5lZCAmJiB7IG1hdGNoRXJyb3IgfSksXG4gICAgfTtcbiAgICByZXR1cm4gZXZpZGVuY2U7XG4gIH0gZWxzZSB7XG4gICAgLy8gRklMVEVSIFBBVEg6IHJlYWRzIHZhbHVlcyBkaXJlY3RseSB2aWEgY2FsbGJhY2tzIChubyByZWNvcmRlcik7IGV4Y2VwdGlvbnMgdHJlYXRlZCBhcyBub24tbWF0Y2hcbiAgICBjb25zdCByZXNvbHZlZFZhbHVlRm4gPSB2YWx1ZUZuID8/ICgoKSA9PiB1bmRlZmluZWQpO1xuICAgIGNvbnN0IHJlc29sdmVkUmVkYWN0ZWRGbiA9IHJlZGFjdGVkRm4gPz8gKCgpID0+IGZhbHNlKTtcbiAgICBsZXQgZmlsdGVyTWF0Y2hlZCA9IGZhbHNlO1xuICAgIGxldCBmaWx0ZXJDb25kaXRpb25zOiBGaWx0ZXJDb25kaXRpb25bXSA9IFtdO1xuICAgIGxldCBtYXRjaEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGV2YWx1YXRlRmlsdGVyKHJlc29sdmVkVmFsdWVGbiwgcmVzb2x2ZWRSZWRhY3RlZEZuLCBydWxlLndoZW4gYXMgV2hlcmVGaWx0ZXI8Uz4pO1xuICAgICAgZmlsdGVyTWF0Y2hlZCA9IHJlc3VsdC5tYXRjaGVkO1xuICAgICAgZmlsdGVyQ29uZGl0aW9ucyA9IHJlc3VsdC5jb25kaXRpb25zO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGZpbHRlck1hdGNoZWQgPSBmYWxzZTtcbiAgICAgIGZpbHRlckNvbmRpdGlvbnMgPSBbXTtcbiAgICAgIC8vIENhcHR1cmUgdGhlIGVycm9yIGZvciBkZWJ1Z2dpbmcg4oCUIHN1cmZhY2UgaXQgaW4gZXZpZGVuY2UgaW5zdGVhZCBvZiBzd2FsbG93aW5nIHNpbGVudGx5XG4gICAgICBtYXRjaEVycm9yID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gcnVsZS5sYWJlbCA/IGAgKCcke3J1bGUubGFiZWx9JylgIDogJyc7XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gZGVjaWRlKCkgZmlsdGVyIHJ1bGUgJHtpbmRleH0ke2xhYmVsfSB0aHJldyBkdXJpbmcgZXZhbHVhdGlvbjogJHttYXRjaEVycm9yfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGV2aWRlbmNlOiBGaWx0ZXJSdWxlRXZpZGVuY2UgPSB7XG4gICAgICB0eXBlOiAnZmlsdGVyJyxcbiAgICAgIHJ1bGVJbmRleDogaW5kZXgsXG4gICAgICBicmFuY2g6IHJ1bGUudGhlbixcbiAgICAgIG1hdGNoZWQ6IGZpbHRlck1hdGNoZWQsXG4gICAgICBsYWJlbDogcnVsZS5sYWJlbCxcbiAgICAgIGNvbmRpdGlvbnM6IGZpbHRlckNvbmRpdGlvbnMsXG4gICAgICAuLi4obWF0Y2hFcnJvciAhPT0gdW5kZWZpbmVkICYmIHsgbWF0Y2hFcnJvciB9KSxcbiAgICB9O1xuICAgIHJldHVybiBldmlkZW5jZTtcbiAgfVxufVxuXG4vLyAtLSBkZWNpZGUoKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXZhbHVhdGVzIHJ1bGVzIGluIG9yZGVyIChmaXJzdC1tYXRjaCkuIFJldHVybnMgYSBicmFuZGVkIERlY2lzaW9uUmVzdWx0LlxuICpcbiAqIEBwYXJhbSBzY29wZSAtIFR5cGVkU2NvcGUgb3IgU2NvcGVGYWNhZGVcbiAqIEBwYXJhbSBydWxlcyAtIEFycmF5IG9mIERlY2lkZVJ1bGUgKGZ1bmN0aW9uIG9yIGZpbHRlciB3aGVuIGNsYXVzZXMpXG4gKiBAcGFyYW0gZGVmYXVsdEJyYW5jaCAtIEJyYW5jaCBJRCBpZiBubyBydWxlIG1hdGNoZXNcbiAqXG4gKiAqKkVycm9yIGJlaGF2aW9yOioqIElmIGEgYHdoZW5gIGZ1bmN0aW9uIHRocm93cyBkdXJpbmcgZXZhbHVhdGlvbiwgdGhlIHJ1bGUgaXNcbiAqIHRyZWF0ZWQgYXMgbm9uLW1hdGNoaW5nIChgbWF0Y2hlZDogZmFsc2VgKSBhbmQgdGhlIGVycm9yIG1lc3NhZ2UgaXMgY2FwdHVyZWQgaW5cbiAqIGBtYXRjaEVycm9yYCBvbiB0aGF0IHJ1bGUncyBgUnVsZUV2aWRlbmNlYCBlbnRyeS4gRXhlY3V0aW9uIGNvbnRpbnVlcyB3aXRoXG4gKiBzdWJzZXF1ZW50IHJ1bGVzOyBlcnJvcnMgZG8gbm90IHByb3BhZ2F0ZSB0byB0aGUgY2FsbGVyLlxuICpcbiAqICoqRW1wdHktZmlsdGVyIGJlaGF2aW9yIChhbnRpLXZhY3VvdXMtdHJ1dGgpOioqIGEgZmlsdGVyIHJ1bGUgd2hvc2UgYHdoZW5gIGlzXG4gKiBge31gIChubyBldmFsdWFibGUgY29uZGl0aW9ucykgTkVWRVIgbWF0Y2hlcy4gVGhpcyBkZWxpYmVyYXRlbHkgaW52ZXJ0cyB0aGVcbiAqIFByaXNtYS9TUUwgYHdoZXJlOiB7fWAgaW50dWl0aW9uIChcIm1hdGNoIGV2ZXJ5dGhpbmdcIikg4oCUIGEgcnVsZSB0aGF0IGFzc2VydHNcbiAqIG5vdGhpbmcgbXVzdCBub3Qgd2luIGEgYnJhbmNoIG9uIHZhY3VvdXMgdHJ1dGguIFVzZSBgZGVmYXVsdEJyYW5jaGAgZm9yIHRoZVxuICogY2F0Y2gtYWxsIGluc3RlYWQuIFVua25vd24gZmlsdGVyIG9wZXJhdG9ycyBhbHNvIG5ldmVyIG1hdGNoIChkZXYgbW9kZSB3YXJucykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWNpZGU8UyBleHRlbmRzIG9iamVjdD4oc2NvcGU6IFMsIHJ1bGVzOiBEZWNpZGVSdWxlPFM+W10sIGRlZmF1bHRCcmFuY2g6IHN0cmluZyk6IERlY2lzaW9uUmVzdWx0IHtcbiAgY29uc3QgYXR0YWNoRm4gPSBnZXRBdHRhY2hGbihzY29wZSk7XG4gIGNvbnN0IGRldGFjaEZuID0gZ2V0RGV0YWNoRm4oc2NvcGUpO1xuICBjb25zdCB2YWx1ZUZuID0gZ2V0VmFsdWVGbihzY29wZSk7XG4gIGNvbnN0IHJlZGFjdGVkRm4gPSBnZXRSZWRhY3RlZEZuKHNjb3BlKTtcblxuICBjb25zdCBldmFsdWF0ZWRSdWxlczogUnVsZUV2aWRlbmNlW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IFtpbmRleCwgcnVsZV0gb2YgcnVsZXMuZW50cmllcygpKSB7XG4gICAgY29uc3QgcnVsZUV2aWRlbmNlID0gZXZhbHVhdGVSdWxlKHNjb3BlLCBydWxlLCBpbmRleCwgYXR0YWNoRm4sIGRldGFjaEZuLCB2YWx1ZUZuLCByZWRhY3RlZEZuKTtcbiAgICBldmFsdWF0ZWRSdWxlcy5wdXNoKHJ1bGVFdmlkZW5jZSk7XG5cbiAgICBpZiAocnVsZUV2aWRlbmNlLm1hdGNoZWQpIHtcbiAgICAgIGNvbnN0IGV2aWRlbmNlOiBEZWNpc2lvbkV2aWRlbmNlID0ge1xuICAgICAgICBydWxlczogZXZhbHVhdGVkUnVsZXMsXG4gICAgICAgIGNob3NlbjogcnVsZS50aGVuLFxuICAgICAgICBkZWZhdWx0OiBkZWZhdWx0QnJhbmNoLFxuICAgICAgfTtcbiAgICAgIHJldHVybiB7IGJyYW5jaDogcnVsZS50aGVuLCBbREVDSVNJT05fUkVTVUxUXTogdHJ1ZSwgZXZpZGVuY2UgfTtcbiAgICB9XG4gIH1cblxuICAvLyBEZWZhdWx0OiBubyBydWxlIG1hdGNoZWRcbiAgY29uc3QgZXZpZGVuY2U6IERlY2lzaW9uRXZpZGVuY2UgPSB7XG4gICAgcnVsZXM6IGV2YWx1YXRlZFJ1bGVzLFxuICAgIGNob3NlbjogZGVmYXVsdEJyYW5jaCxcbiAgICBkZWZhdWx0OiBkZWZhdWx0QnJhbmNoLFxuICB9O1xuICByZXR1cm4geyBicmFuY2g6IGRlZmF1bHRCcmFuY2gsIFtERUNJU0lPTl9SRVNVTFRdOiB0cnVlLCBldmlkZW5jZSB9O1xufVxuXG4vLyAtLSBzZWxlY3QoKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXZhbHVhdGVzIEFMTCBydWxlcyAobm90IGZpcnN0LW1hdGNoKS4gUmV0dXJucyBhIGJyYW5kZWQgU2VsZWN0aW9uUmVzdWx0LlxuICpcbiAqIEBwYXJhbSBzY29wZSAtIFR5cGVkU2NvcGUgb3IgU2NvcGVGYWNhZGVcbiAqIEBwYXJhbSBydWxlcyAtIEFycmF5IG9mIERlY2lkZVJ1bGUgKGZ1bmN0aW9uIG9yIGZpbHRlciB3aGVuIGNsYXVzZXMpXG4gKlxuICogKipFcnJvciBiZWhhdmlvcjoqKiBJZiBhIGB3aGVuYCBmdW5jdGlvbiB0aHJvd3MgZHVyaW5nIGV2YWx1YXRpb24sIHRoZSBydWxlIGlzXG4gKiB0cmVhdGVkIGFzIG5vbi1tYXRjaGluZyAoYG1hdGNoZWQ6IGZhbHNlYCkgYW5kIHRoZSBlcnJvciBtZXNzYWdlIGlzIGNhcHR1cmVkIGluXG4gKiBgbWF0Y2hFcnJvcmAgb24gdGhhdCBydWxlJ3MgYFJ1bGVFdmlkZW5jZWAgZW50cnkuIEV2YWx1YXRpb24gY29udGludWVzIHdpdGhcbiAqIHJlbWFpbmluZyBydWxlczsgZXJyb3JzIGRvIG5vdCBwcm9wYWdhdGUgdG8gdGhlIGNhbGxlci5cbiAqXG4gKiAqKkVtcHR5LWZpbHRlciBiZWhhdmlvciAoYW50aS12YWN1b3VzLXRydXRoKToqKiBhIGZpbHRlciBydWxlIHdob3NlIGB3aGVuYCBpc1xuICogYHt9YCAobm8gZXZhbHVhYmxlIGNvbmRpdGlvbnMpIE5FVkVSIG1hdGNoZXMg4oCUIHNhbWUgcnVsZSBhcyBgZGVjaWRlKClgOyBhblxuICogYWx3YXlzLXNlbGVjdGVkIGJyYW5jaCBtdXN0IGJlIGV4cHJlc3NlZCBleHBsaWNpdGx5LCBub3QgdmlhIGFuIGVtcHR5IGZpbHRlci5cbiAqIFVua25vd24gZmlsdGVyIG9wZXJhdG9ycyBhbHNvIG5ldmVyIG1hdGNoIChkZXYgbW9kZSB3YXJucykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWxlY3Q8UyBleHRlbmRzIG9iamVjdD4oc2NvcGU6IFMsIHJ1bGVzOiBEZWNpZGVSdWxlPFM+W10pOiBTZWxlY3Rpb25SZXN1bHQge1xuICBjb25zdCBhdHRhY2hGbiA9IGdldEF0dGFjaEZuKHNjb3BlKTtcbiAgY29uc3QgZGV0YWNoRm4gPSBnZXREZXRhY2hGbihzY29wZSk7XG4gIGNvbnN0IHZhbHVlRm4gPSBnZXRWYWx1ZUZuKHNjb3BlKTtcbiAgY29uc3QgcmVkYWN0ZWRGbiA9IGdldFJlZGFjdGVkRm4oc2NvcGUpO1xuXG4gIGNvbnN0IGV2YWx1YXRlZFJ1bGVzOiBSdWxlRXZpZGVuY2VbXSA9IFtdO1xuICBjb25zdCBzZWxlY3RlZEJyYW5jaGVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgW2luZGV4LCBydWxlXSBvZiBydWxlcy5lbnRyaWVzKCkpIHtcbiAgICBjb25zdCBydWxlRXZpZGVuY2UgPSBldmFsdWF0ZVJ1bGUoc2NvcGUsIHJ1bGUsIGluZGV4LCBhdHRhY2hGbiwgZGV0YWNoRm4sIHZhbHVlRm4sIHJlZGFjdGVkRm4pO1xuICAgIGV2YWx1YXRlZFJ1bGVzLnB1c2gocnVsZUV2aWRlbmNlKTtcblxuICAgIGlmIChydWxlRXZpZGVuY2UubWF0Y2hlZCkge1xuICAgICAgc2VsZWN0ZWRCcmFuY2hlcy5wdXNoKHJ1bGUudGhlbik7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZXZpZGVuY2U6IFNlbGVjdGlvbkV2aWRlbmNlID0ge1xuICAgIHJ1bGVzOiBldmFsdWF0ZWRSdWxlcyxcbiAgICBzZWxlY3RlZDogc2VsZWN0ZWRCcmFuY2hlcyxcbiAgfTtcbiAgcmV0dXJuIHsgYnJhbmNoZXM6IHNlbGVjdGVkQnJhbmNoZXMsIFtERUNJU0lPTl9SRVNVTFRdOiB0cnVlLCBldmlkZW5jZSB9O1xufVxuIl19