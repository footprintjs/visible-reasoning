/**
 * decide/evaluator -- Prisma-style filter evaluator for decision rules.
 *
 * Pure function. Takes a WhereFilter, a value getter, and a redaction checker.
 * Evaluates each condition, records the result, returns matched/conditions.
 *
 * All keys in the filter are ANDed (all must match for the rule to match).
 * Decoupled from ScopeFacade — receives callbacks, not scope.
 */
import { isDevMode } from '../scope/detectCircular.js';
import { summarizeValue } from '../scope/recorders/summarizeValue.js';
const OPERATOR_HANDLERS = {
    eq: (a, t) => a === t,
    ne: (a, t) => a !== t,
    gt: (a, t) => a > t,
    gte: (a, t) => a >= t,
    lt: (a, t) => a < t,
    lte: (a, t) => a <= t,
    in: (a, t) => {
        if (!Array.isArray(t))
            return false;
        if (t.length > MAX_IN_ARRAY_SIZE) {
            throw new Error(`in/notIn array exceeds maximum size of ${MAX_IN_ARRAY_SIZE}`);
        }
        return t.includes(a);
    },
    notIn: (a, t) => {
        if (!Array.isArray(t))
            return true; // not in a non-array = vacuously true
        if (t.length > MAX_IN_ARRAY_SIZE) {
            throw new Error(`in/notIn array exceeds maximum size of ${MAX_IN_ARRAY_SIZE}`);
        }
        return !t.includes(a);
    },
};
// -- Security: prototype pollution denylist ----------------------------------
const DENIED_KEYS = new Set([
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
]);
// -- Constants ---------------------------------------------------------------
const MAX_IN_ARRAY_SIZE = 1000;
const MAX_VALUE_LEN = 80;
// -- Evaluator ---------------------------------------------------------------
/**
 * Evaluates a Prisma-style filter against scope values.
 *
 * ## Empty filter → NO match (anti-vacuous-truth — inverts Prisma/SQL)
 *
 * A filter with no evaluable conditions (`{}`, or only denied/non-object
 * keys) returns `matched: false`. This deliberately INVERTS the Prisma/SQL
 * intuition where `where: {}` matches everything: in a decision rule, a rule
 * that asserts nothing should never win a branch — "all zero conditions
 * passed" is vacuous truth, and silently routing on it would fabricate
 * decision evidence. Want a catch-all? Use the explicit `defaultBranch`
 * argument of `decide()` instead of an empty `when`.
 *
 * ## Unknown operators → condition fails (+ dev-mode warning)
 *
 * An operator outside the supported set (`eq, ne, gt, gte, lt, lte, in,
 * notIn`) records a failed condition — the rule can never spuriously match
 * through a typo (`gte` misspelled `gle`). With dev mode enabled
 * (`enableDevMode()`), a console warning names the unknown operator and key.
 *
 * @param getValueFn - Reads a value from scope by key (raw, for comparison)
 * @param isRedactedFn - Checks if a key is redacted (for evidence display)
 * @param filter - The WhereFilter to evaluate
 * @returns { matched, conditions } — matched = all conditions passed
 */
export function evaluateFilter(getValueFn, isRedactedFn, filter) {
    const conditions = [];
    let allMatched = true;
    for (const [key, ops] of Object.entries(filter)) {
        // Security: denied keys cause rule to fail (consistent with unknown operator behavior)
        if (DENIED_KEYS.has(key)) {
            allMatched = false;
            continue;
        }
        if (!ops || typeof ops !== 'object')
            continue;
        const actual = getValueFn(key);
        const redacted = isRedactedFn(key);
        const displayValue = redacted ? '[REDACTED]' : summarizeValue(actual, MAX_VALUE_LEN);
        // Evaluate each operator in the FilterOps for this key
        for (const [op, threshold] of Object.entries(ops)) {
            const handler = OPERATOR_HANDLERS[op];
            if (!handler) {
                // Unknown operator: treat as failed condition so rule doesn't spuriously match
                if (isDevMode()) {
                    // eslint-disable-next-line no-console
                    console.warn(`[footprint] decide()/select() filter: unknown operator "${op}" on key "${key}" — ` +
                        `condition never matches (valid operators: ${Object.keys(OPERATOR_HANDLERS).join(', ')})`);
                }
                conditions.push({ key, op, threshold, actualSummary: displayValue, result: false, redacted });
                allMatched = false;
                continue;
            }
            const result = handler(actual, threshold);
            conditions.push({
                key,
                op,
                threshold,
                actualSummary: displayValue,
                result,
                redacted,
            });
            if (!result)
                allMatched = false;
        }
    }
    // Empty filter (no evaluable conditions) should NOT match — prevents vacuous
    // truth. NOTE: this deliberately inverts Prisma/SQL `where: {}` ("match
    // everything") — see the function JSDoc. Catch-alls belong in decide()'s
    // explicit defaultBranch, not in an empty rule.
    if (conditions.length === 0)
        return { matched: false, conditions };
    return { matched: allMatched, conditions };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZhbHVhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9kZWNpZGUvZXZhbHVhdG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OztHQVFHO0FBRUgsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBQ3ZELE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxzQ0FBc0MsQ0FBQztBQU90RSxNQUFNLGlCQUFpQixHQUErQjtJQUNwRCxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQztJQUNyQixFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQztJQUNyQixFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBRSxDQUFZLEdBQUksQ0FBWTtJQUMzQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBRSxDQUFZLElBQUssQ0FBWTtJQUM3QyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBRSxDQUFZLEdBQUksQ0FBWTtJQUMzQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBRSxDQUFZLElBQUssQ0FBWTtJQUM3QyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUU7UUFDWCxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUNwQyxJQUFJLENBQUMsQ0FBQyxNQUFNLEdBQUcsaUJBQWlCLEVBQUUsQ0FBQztZQUNqQyxNQUFNLElBQUksS0FBSyxDQUFDLDBDQUEwQyxpQkFBaUIsRUFBRSxDQUFDLENBQUM7UUFDakYsQ0FBQztRQUNELE9BQU8sQ0FBQyxDQUFDLFFBQVEs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QUcsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQztZQUMxQyxVQUFVLENBQUMsSUFBSSxDQUFDO2dCQUNkLEdBQUc7Z0JBQ0gsRUFBRTtnQkFDRixTQUFTO2dCQUNULGFBQWEsRUFBRSxZQUFZO2dCQUMzQixNQUFNO2dCQUNOLFFBQVE7YUFDVCxDQUFDLENBQUM7WUFFSCxJQUFJLENBQUMsTUFBTTtnQkFBRSxVQUFVLEdBQUcsS0FBSyxDQUFDO1FBQ2xDLENBQUM7SUFDSCxDQUFDO0lBRUQsNkVBQTZFO0lBQzdFLHdFQUF3RTtJQUN4RSx5RUFBeUU7SUFDekUsZ0RBQWdEO0lBQ2hELElBQUksVUFBVSxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLENBQUM7SUFFbkUsT0FBTyxFQUFFLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLENBQUM7QUFDN0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGVjaWRlL2V2YWx1YXRvciAtLSBQcmlzbWEtc3R5bGUgZmlsdGVyIGV2YWx1YXRvciBmb3IgZGVjaXNpb24gcnVsZXMuXG4gKlxuICogUHVyZSBmdW5jdGlvbi4gVGFrZXMgYSBXaGVyZUZpbHRlciwgYSB2YWx1ZSBnZXR0ZXIsIGFuZCBhIHJlZGFjdGlvbiBjaGVja2VyLlxuICogRXZhbHVhdGVzIGVhY2ggY29uZGl0aW9uLCByZWNvcmRzIHRoZSByZXN1bHQsIHJldHVybnMgbWF0Y2hlZC9jb25kaXRpb25zLlxuICpcbiAqIEFsbCBrZXlzIGluIHRoZSBmaWx0ZXIgYXJlIEFORGVkIChhbGwgbXVzdCBtYXRjaCBmb3IgdGhlIHJ1bGUgdG8gbWF0Y2gpLlxuICogRGVjb3VwbGVkIGZyb20gU2NvcGVGYWNhZGUg4oCUIHJlY2VpdmVzIGNhbGxiYWNrcywgbm90IHNjb3BlLlxuICovXG5cbmltcG9ydCB7IGlzRGV2TW9kZSB9IGZyb20gJy4uL3Njb3BlL2RldGVjdENpcmN1bGFyLmpzJztcbmltcG9ydCB7IHN1bW1hcml6ZVZhbHVlIH0gZnJvbSAnLi4vc2NvcGUvcmVjb3JkZXJzL3N1bW1hcml6ZVZhbHVlLmpzJztcbmltcG9ydCB0eXBlIHsgRmlsdGVyQ29uZGl0aW9uLCBXaGVyZUZpbHRlciB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLSBPcGVyYXRvciBkaXNwYXRjaCB0YWJsZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnR5cGUgT3BlcmF0b3JGbiA9IChhY3R1YWw6IHVua25vd24sIHRocmVzaG9sZDogdW5rbm93bikgPT4gYm9vbGVhbjtcblxuY29uc3QgT1BFUkFUT1JfSEFORExFUlM6IFJlY29yZDxzdHJpbmcsIE9wZXJhdG9yRm4+ID0ge1xuICBlcTogKGEsIHQpID0+IGEgPT09IHQsXG4gIG5lOiAoYSwgdCkgPT4gYSAhPT0gdCxcbiAgZ3Q6IChhLCB0KSA9PiAoYSBhcyBudW1iZXIpID4gKHQgYXMgbnVtYmVyKSxcbiAgZ3RlOiAoYSwgdCkgPT4gKGEgYXMgbnVtYmVyKSA+PSAodCBhcyBudW1iZXIpLFxuICBsdDogKGEsIHQpID0+IChhIGFzIG51bWJlcikgPCAodCBhcyBudW1iZXIpLFxuICBsdGU6IChhLCB0KSA9PiAoYSBhcyBudW1iZXIpIDw9ICh0IGFzIG51bWJlciksXG4gIGluOiAoYSwgdCkgPT4ge1xuICAgIGlmICghQXJyYXkuaXNBcnJheSh0KSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh0Lmxlbmd0aCA+IE1BWF9JTl9BUlJBWV9TSVpFKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGluL25vdEluIGFycmF5IGV4Y2VlZHMgbWF4aW11bSBzaXplIG9mICR7TUFYX0lOX0FSUkFZX1NJWkV9YCk7XG4gICAgfVxuICAgIHJldHVybiB0LmluY2x1ZGVzKGEpO1xuICB9LFxuICBub3RJbjogKGEsIHQpID0+IHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkodCkpIHJldHVybiB0cnVlOyAvLyBub3QgaW4gYSBub24tYXJyYXkgPSB2YWN1b3VzbHkgdHJ1ZVxuICAgIGlmICh0Lmxlbmd0aCA+IE1BWF9JTl9BUlJBWV9TSVpFKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGluL25vdEluIGFycmF5IGV4Y2VlZHMgbWF4aW11bSBzaXplIG9mICR7TUFYX0lOX0FSUkFZX1NJWkV9YCk7XG4gICAgfVxuICAgIHJldHVybiAhdC5pbmNsdWRlcyhhKTtcbiAgfSxcbn07XG5cbi8vIC0tIFNlY3VyaXR5OiBwcm90b3R5cGUgcG9sbHV0aW9uIGRlbnlsaXN0IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgREVOSUVEX0tFWVMgPSBuZXcgU2V0KFtcbiAgJ19fcHJvdG9fXycsXG4gICdjb25zdHJ1Y3RvcicsXG4gICdwcm90b3R5cGUnLFxuICAndG9TdHJpbmcnLFxuICAndmFsdWVPZicsXG4gICdoYXNPd25Qcm9wZXJ0eScsXG4gICdpc1Byb3RvdHlwZU9mJyxcbiAgJ3Byb3BlcnR5SXNFbnVtZXJhYmxlJyxcbiAgJ19fZGVmaW5lR2V0dGVyX18nLFxuICAnX19kZWZpbmVTZXR0ZXJfXycsXG4gICdfX2xvb2t1cEdldHRlcl9fJyxcbiAgJ19fbG9va3VwU2V0dGVyX18nLFxuXSk7XG5cbi8vIC0tIENvbnN0YW50cyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgTUFYX0lOX0FSUkFZX1NJWkUgPSAxMDAwO1xuY29uc3QgTUFYX1ZBTFVFX0xFTiA9IDgwO1xuXG4vLyAtLSBFdmFsdWF0b3IgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXZhbHVhdGVzIGEgUHJpc21hLXN0eWxlIGZpbHRlciBhZ2FpbnN0IHNjb3BlIHZhbHVlcy5cbiAqXG4gKiAjIyBFbXB0eSBmaWx0ZXIg4oaSIE5PIG1hdGNoIChhbnRpLXZhY3VvdXMtdHJ1dGgg4oCUIGludmVydHMgUHJpc21hL1NRTClcbiAqXG4gKiBBIGZpbHRlciB3aXRoIG5vIGV2YWx1YWJsZSBjb25kaXRpb25zIChge31gLCBvciBvbmx5IGRlbmllZC9ub24tb2JqZWN0XG4gKiBrZXlzKSByZXR1cm5zIGBtYXRjaGVkOiBmYWxzZWAuIFRoaXMgZGVsaWJlcmF0ZWx5IElOVkVSVFMgdGhlIFByaXNtYS9TUUxcbiAqIGludHVpdGlvbiB3aGVyZSBgd2hlcmU6IHt9YCBtYXRjaGVzIGV2ZXJ5dGhpbmc6IGluIGEgZGVjaXNpb24gcnVsZSwgYSBydWxlXG4gKiB0aGF0IGFzc2VydHMgbm90aGluZyBzaG91bGQgbmV2ZXIgd2luIGEgYnJhbmNoIOKAlCBcImFsbCB6ZXJvIGNvbmRpdGlvbnNcbiAqIHBhc3NlZFwiIGlzIHZhY3VvdXMgdHJ1dGgsIGFuZCBzaWxlbnRseSByb3V0aW5nIG9uIGl0IHdvdWxkIGZhYnJpY2F0ZVxuICogZGVjaXNpb24gZXZpZGVuY2UuIFdhbnQgYSBjYXRjaC1hbGw/IFVzZSB0aGUgZXhwbGljaXQgYGRlZmF1bHRCcmFuY2hgXG4gKiBhcmd1bWVudCBvZiBgZGVjaWRlKClgIGluc3RlYWQgb2YgYW4gZW1wdHkgYHdoZW5gLlxuICpcbiAqICMjIFVua25vd24gb3BlcmF0b3JzIOKGkiBjb25kaXRpb24gZmFpbHMgKCsgZGV2LW1vZGUgd2FybmluZylcbiAqXG4gKiBBbiBvcGVyYXRvciBvdXRzaWRlIHRoZSBzdXBwb3J0ZWQgc2V0IChgZXEsIG5lLCBndCwgZ3RlLCBsdCwgbHRlLCBpbixcbiAqIG5vdEluYCkgcmVjb3JkcyBhIGZhaWxlZCBjb25kaXRpb24g4oCUIHRoZSBydWxlIGNhbiBuZXZlciBzcHVyaW91c2x5IG1hdGNoXG4gKiB0aHJvdWdoIGEgdHlwbyAoYGd0ZWAgbWlzc3BlbGxlZCBgZ2xlYCkuIFdpdGggZGV2IG1vZGUgZW5hYmxlZFxuICogKGBlbmFibGVEZXZNb2RlKClgKSwgYSBjb25zb2xlIHdhcm5pbmcgbmFtZXMgdGhlIHVua25vd24gb3BlcmF0b3IgYW5kIGtleS5cbiAqXG4gKiBAcGFyYW0gZ2V0VmFsdWVGbiAtIFJlYWRzIGEgdmFsdWUgZnJvbSBzY29wZSBieSBrZXkgKHJhdywgZm9yIGNvbXBhcmlzb24pXG4gKiBAcGFyYW0gaXNSZWRhY3RlZEZuIC0gQ2hlY2tzIGlmIGEga2V5IGlzIHJlZGFjdGVkIChmb3IgZXZpZGVuY2UgZGlzcGxheSlcbiAqIEBwYXJhbSBmaWx0ZXIgLSBUaGUgV2hlcmVGaWx0ZXIgdG8gZXZhbHVhdGVcbiAqIEByZXR1cm5zIHsgbWF0Y2hlZCwgY29uZGl0aW9ucyB9IOKAlCBtYXRjaGVkID0gYWxsIGNvbmRpdGlvbnMgcGFzc2VkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBldmFsdWF0ZUZpbHRlcjxUIGV4dGVuZHMgb2JqZWN0PihcbiAgZ2V0VmFsdWVGbjogKGtleTogc3RyaW5nKSA9PiB1bmtub3duLFxuICBpc1JlZGFjdGVkRm46IChrZXk6IHN0cmluZykgPT4gYm9vbGVhbixcbiAgZmlsdGVyOiBXaGVyZUZpbHRlcjxUPixcbik6IHsgbWF0Y2hlZDogYm9vbGVhbjsgY29uZGl0aW9uczogRmlsdGVyQ29uZGl0aW9uW10gfSB7XG4gIGNvbnN0IGNvbmRpdGlvbnM6IEZpbHRlckNvbmRpdGlvbltdID0gW107XG4gIGxldCBhbGxNYXRjaGVkID0gdHJ1ZTtcblxuICBmb3IgKGNvbnN0IFtrZXksIG9wc10gb2YgT2JqZWN0LmVudHJpZXMoZmlsdGVyKSkge1xuICAgIC8vIFNlY3VyaXR5OiBkZW5pZWQga2V5cyBjYXVzZSBydWxlIHRvIGZhaWwgKGNvbnNpc3RlbnQgd2l0aCB1bmtub3duIG9wZXJhdG9yIGJlaGF2aW9yKVxuICAgIGlmIChERU5JRURfS0VZUy5oYXMoa2V5KSkge1xuICAgICAgYWxsTWF0Y2hlZCA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghb3BzIHx8IHR5cGVvZiBvcHMgIT09ICdvYmplY3QnKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGFjdHVhbCA9IGdldFZhbHVlRm4oa2V5KTtcbiAgICBjb25zdCByZWRhY3RlZCA9IGlzUmVkYWN0ZWRGbihrZXkpO1xuICAgIGNvbnN0IGRpc3BsYXlWYWx1ZSA9IHJlZGFjdGVkID8gJ1tSRURBQ1RFRF0nIDogc3VtbWFyaXplVmFsdWUoYWN0dWFsLCBNQVhfVkFMVUVfTEVOKTtcblxuICAgIC8vIEV2YWx1YXRlIGVhY2ggb3BlcmF0b3IgaW4gdGhlIEZpbHRlck9wcyBmb3IgdGhpcyBrZXlcbiAgICBmb3IgKGNvbnN0IFtvcCwgdGhyZXNob2xkXSBvZiBPYmplY3QuZW50cmllcyhvcHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICBjb25zdCBoYW5kbGVyID0gT1BFUkFUT1JfSEFORExFUlNbb3BdO1xuICAgICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIC8vIFVua25vd24gb3BlcmF0b3I6IHRyZWF0IGFzIGZhaWxlZCBjb25kaXRpb24gc28gcnVsZSBkb2Vzbid0IHNwdXJpb3VzbHkgbWF0Y2hcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgICBgW2Zvb3RwcmludF0gZGVjaWRlKCkvc2VsZWN0KCkgZmlsdGVyOiB1bmtub3duIG9wZXJhdG9yIFwiJHtvcH1cIiBvbiBrZXkgXCIke2tleX1cIiDigJQgYCArXG4gICAgICAgICAgICAgIGBjb25kaXRpb24gbmV2ZXIgbWF0Y2hlcyAodmFsaWQgb3BlcmF0b3JzOiAke09iamVjdC5rZXlzKE9QRVJBVE9SX0hBTkRMRVJTKS5qb2luKCcsICcpfSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uZGl0aW9ucy5wdXNoKHsga2V5LCBvcCwgdGhyZXNob2xkLCBhY3R1YWxTdW1tYXJ5OiBkaXNwbGF5VmFsdWUsIHJlc3VsdDogZmFsc2UsIHJlZGFjdGVkIH0pO1xuICAgICAgICBhbGxNYXRjaGVkID0gZmFsc2U7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZXN1bHQgPSBoYW5kbGVyKGFjdHVhbCwgdGhyZXNob2xkKTtcbiAgICAgIGNvbmRpdGlvbnMucHVzaCh7XG4gICAgICAgIGtleSxcbiAgICAgICAgb3AsXG4gICAgICAgIHRocmVzaG9sZCxcbiAgICAgICAgYWN0dWFsU3VtbWFyeTogZGlzcGxheVZhbHVlLFxuICAgICAgICByZXN1bHQsXG4gICAgICAgIHJlZGFjdGVkLFxuICAgICAgfSk7XG5cbiAgICAgIGlmICghcmVzdWx0KSBhbGxNYXRjaGVkID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLy8gRW1wdHkgZmlsdGVyIChubyBldmFsdWFibGUgY29uZGl0aW9ucykgc2hvdWxkIE5PVCBtYXRjaCDigJQgcHJldmVudHMgdmFjdW91c1xuICAvLyB0cnV0aC4gTk9URTogdGhpcyBkZWxpYmVyYXRlbHkgaW52ZXJ0cyBQcmlzbWEvU1FMIGB3aGVyZToge31gIChcIm1hdGNoXG4gIC8vIGV2ZXJ5dGhpbmdcIikg4oCUIHNlZSB0aGUgZnVuY3Rpb24gSlNEb2MuIENhdGNoLWFsbHMgYmVsb25nIGluIGRlY2lkZSgpJ3NcbiAgLy8gZXhwbGljaXQgZGVmYXVsdEJyYW5jaCwgbm90IGluIGFuIGVtcHR5IHJ1bGUuXG4gIGlmIChjb25kaXRpb25zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgbWF0Y2hlZDogZmFsc2UsIGNvbmRpdGlvbnMgfTtcblxuICByZXR1cm4geyBtYXRjaGVkOiBhbGxNYXRjaGVkLCBjb25kaXRpb25zIH07XG59XG4iXX0=