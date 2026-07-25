/**
 * Zod Validation Helpers — Cross-version compatible Zod utilities
 *
 * Detection delegated to schema/detect.ts (single source of truth).
 */
import { z } from 'zod';
import { detectSchema } from '../../../../schema/detect.js';
/** Check if the value is a Zod schema node. */
export function isZodNode(x) {
    return detectSchema(x) !== 'none';
}
/** Peel wrappers; returns the underlying base Zod node (or null).
 *
 *  Wrapper-aware: only descends through fields that are KNOWN to hold
 *  the inner schema for wrapper Zod types (Optional, Default, Nullable,
 *  Effects/Pipeline). Notably, `_def.type` is treated as the inner
 *  schema ONLY for v3 Effects/Pipeline — it is NOT the inner schema
 *  for ZodArray (where `_def.type` holds the ELEMENT schema, which is
 *  a separate concern from wrapper unwrapping).
 *
 *  Without this gate, `unwrap(z.array(z.string()))` would incorrectly
 *  follow `_def.type` and return `ZodString`, breaking array detection
 *  in `scopeFactory.analyze()`.
 */
export function unwrap(schema) {
    let s = schema ?? null;
    while (isZodNode(s)) {
        const def = (s._def ?? {});
        const tn = def.typeName;
        // Only known wrapper typeNames descend. ZodArray / ZodObject /
        // ZodRecord / ZodUnion etc. break out so the caller can branch
        // on the base instance check.
        const isWrapper = tn === 'ZodOptional' ||
            tn === 'ZodDefault' ||
            tn === 'ZodNullable' ||
            tn === 'ZodReadonly' ||
            tn === 'ZodBranded' ||
            tn === 'ZodCatch' ||
            tn === 'ZodEffects' ||
            tn === 'ZodPipeline' ||
            tn === 'ZodLazy';
        if (!isWrapper)
            break;
        if (isZodNode(def.innerType)) {
            s = def.innerType;
            continue;
        }
        if (isZodNode(def.schema)) {
            s = def.schema;
            continue;
        }
        // Pipeline (`in` / `out`) — descend into `in` (input side).
        if (isZodNode(def.in)) {
            s = def.in;
            continue;
        }
        // Lazy holds a getter under `getter`. Last-resort fallback.
        if (typeof def.getter === 'function') {
            try {
                const inner = def.getter();
                if (isZodNode(inner)) {
                    s = inner;
                    continue;
                }
            }
            catch {
                /* fall through */
            }
        }
        break;
    }
    return isZodNode(s) ? s : null;
}
/** Version-tolerant access to ZodRecord value schema. */
export function getRecordValueType(rec) {
    const r = rec;
    const def = r._def ?? {};
    return (r.valueSchema ??
        r.valueType ??
        def.valueType ??
        def.value ??
        (def.schema && (def.schema.valueType ?? def.schema.value)) ??
        (def.innerType && (def.innerType.valueType ?? def.innerType.value)) ??
        null);
}
function looksLikeBindingError(err) {
    const msg = err?.message ?? '';
    return msg.includes('_zod') || msg.includes('inst._zod') || msg.includes('Cannot read properties of undefined');
}
const WRAPPER_CACHE = new WeakMap();
export function parseWithThis(schema, value) {
    const anySchema = schema;
    if (typeof anySchema.safeParse === 'function') {
        try {
            const res = anySchema.safeParse(value);
            if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
                if (res.success)
                    return res.data;
                throw res.error;
            }
        }
        catch (err) {
            if (!looksLikeBindingError(err))
                throw err;
        }
    }
    if (typeof anySchema.safeParse === 'function') {
        try {
            const res = anySchema.safeParse.call(schema, value);
            if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
                if (res.success)
                    return res.data;
                throw res.error;
            }
        }
        catch (err) {
            if (!looksLikeBindingError(err))
                throw err;
        }
    }
    if (typeof anySchema.parse === 'function') {
        try {
            return anySchema.parse(value);
        }
        catch (err) {
            if (!looksLikeBindingError(err))
                throw err;
        }
    }
    let wrapper = WRAPPER_CACHE.get(schema);
    if (!wrapper) {
        wrapper = z.any().pipe(schema);
        WRAPPER_CACHE.set(schema, wrapper);
    }
    const res = wrapper.safeParse(value);
    if (res && res.success)
        return res.data;
    throw res?.error ?? new TypeError('Zod validation binding failed (wrapper fallback).');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmFsaWRhdGVIZWxwZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3N0YXRlL3pvZC91dGlscy92YWxpZGF0ZUhlbHBlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7OztHQUlHO0FBRUgsT0FBTyxFQUFtQyxDQUFDLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFFekQsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBRTVELCtDQUErQztBQUMvQyxNQUFNLFVBQVUsU0FBUyxDQUFDLENBQVU7SUFDbEMsT0FBTyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssTUFBTSxDQUFDO0FBQ3BDLENBQUM7QUFFRDs7Ozs7Ozs7Ozs7O0dBWUc7QUFDSCxNQUFNLFVBQVUsTUFBTSxDQUFDLE1BQXFDO0lBQzFELElBQUksQ0FBQyxHQUFZLE1BQU0sSUFBSSxJQUFJLENBQUM7SUFDaEMsT0FBTyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNwQixNQUFNLEdBQUcsR0FBRyxDQUFFLENBQVMsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUE0QixDQUFDO1FBQy9ELE1BQU0sRUFBRSxHQUFHLEdBQUcsQ0FBQyxRQUE4QixDQUFDO1FBQzlDLCtEQUErRDtRQUMvRCwrREFBK0Q7UUFDL0QsOEJBQThCO1FBQzlCLE1BQU0sU0FBUyxHQUNiLEVBQUUsS0FBSyxhQUFhO1lBQ3BCLEVBQUUsS0FBSyxZQUFZO1lBQ25CLEVBQUUsS0FBSyxhQUFhO1lBQ3BCLEVBQUUsS0FBSyxhQUFhO1lBQ3BCLEVBQUUsS0FBSyxZQUFZO1lBQ25CLEVBQUUsS0FBSyxVQUFVO1lBQ2pCLEVBQUUsS0FBSyxZQUFZO1lBQ25CLEVBQUUsS0FBSyxhQUFhO1lBQ3BCLEVBQUUsS0FBSyxTQUFTLENBQUM7UUFDbkIsSUFBSSxDQUFDLFNBQVM7WUFBRSxNQUFNO1FBQ3RCLElBQUksU0FBUyxDQUFDLEdB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QztRQUNiLE9BQU8sR0FBSSxDQUFDLENBQUMsR0FBRyxFQUFVLENBQUMsSUFBSSxDQUFDLE1BQWEsQ0FBQyxDQUFDO1FBQy9DLGFBQWEsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLE9BQVEsQ0FBQyxDQUFDO0lBQ3RDLENBQUM7SUFDRCxNQUFNLEdBQUcsR0FBSSxPQUFlLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzlDLElBQUksR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPO1FBQUUsT0FBTyxHQUFHLENBQUMsSUFBSSxDQUFDO0lBRXhDLE1BQU0sR0FBRyxFQUFFLEtBQUssSUFBSSxJQUFJLFNBQVMsQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO0FBQ3pGLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFpvZCBWYWxpZGF0aW9uIEhlbHBlcnMg4oCUIENyb3NzLXZlcnNpb24gY29tcGF0aWJsZSBab2QgdXRpbGl0aWVzXG4gKlxuICogRGV0ZWN0aW9uIGRlbGVnYXRlZCB0byBzY2hlbWEvZGV0ZWN0LnRzIChzaW5nbGUgc291cmNlIG9mIHRydXRoKS5cbiAqL1xuXG5pbXBvcnQgeyB0eXBlIFpvZFJlY29yZCwgdHlwZSBab2RUeXBlQW55LCB6IH0gZnJvbSAnem9kJztcblxuaW1wb3J0IHsgZGV0ZWN0U2NoZW1hIH0gZnJvbSAnLi4vLi4vLi4vLi4vc2NoZW1hL2RldGVjdC5qcyc7XG5cbi8qKiBDaGVjayBpZiB0aGUgdmFsdWUgaXMgYSBab2Qgc2NoZW1hIG5vZGUuICovXG5leHBvcnQgZnVuY3Rpb24gaXNab2ROb2RlKHg6IHVua25vd24pOiB4IGlzIFpvZFR5cGVBbnkge1xuICByZXR1cm4gZGV0ZWN0U2NoZW1hKHgpICE9PSAnbm9uZSc7XG59XG5cbi8qKiBQZWVsIHdyYXBwZXJzOyByZXR1cm5zIHRoZSB1bmRlcmx5aW5nIGJhc2UgWm9kIG5vZGUgKG9yIG51bGwpLlxuICpcbiAqICBXcmFwcGVyLWF3YXJlOiBvbmx5IGRlc2NlbmRzIHRocm91Z2ggZmllbGRzIHRoYXQgYXJlIEtOT1dOIHRvIGhvbGRcbiAqICB0aGUgaW5uZXIgc2NoZW1hIGZvciB3cmFwcGVyIFpvZCB0eXBlcyAoT3B0aW9uYWwsIERlZmF1bHQsIE51bGxhYmxlLFxuICogIEVmZmVjdHMvUGlwZWxpbmUpLiBOb3RhYmx5LCBgX2RlZi50eXBlYCBpcyB0cmVhdGVkIGFzIHRoZSBpbm5lclxuICogIHNjaGVtYSBPTkxZIGZvciB2MyBFZmZlY3RzL1BpcGVsaW5lIOKAlCBpdCBpcyBOT1QgdGhlIGlubmVyIHNjaGVtYVxuICogIGZvciBab2RBcnJheSAod2hlcmUgYF9kZWYudHlwZWAgaG9sZHMgdGhlIEVMRU1FTlQgc2NoZW1hLCB3aGljaCBpc1xuICogIGEgc2VwYXJhdGUgY29uY2VybiBmcm9tIHdyYXBwZXIgdW53cmFwcGluZykuXG4gKlxuICogIFdpdGhvdXQgdGhpcyBnYXRlLCBgdW53cmFwKHouYXJyYXkoei5zdHJpbmcoKSkpYCB3b3VsZCBpbmNvcnJlY3RseVxuICogIGZvbGxvdyBgX2RlZi50eXBlYCBhbmQgcmV0dXJuIGBab2RTdHJpbmdgLCBicmVha2luZyBhcnJheSBkZXRlY3Rpb25cbiAqICBpbiBgc2NvcGVGYWN0b3J5LmFuYWx5emUoKWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bndyYXAoc2NoZW1hOiBab2RUeXBlQW55IHwgbnVsbCB8IHVuZGVmaW5lZCk6IFpvZFR5cGVBbnkgfCBudWxsIHtcbiAgbGV0IHM6IHVua25vd24gPSBzY2hlbWEgPz8gbnVsbDtcbiAgd2hpbGUgKGlzWm9kTm9kZShzKSkge1xuICAgIGNvbnN0IGRlZiA9ICgocyBhcyBhbnkpLl9kZWYgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IHRuID0gZGVmLnR5cGVOYW1lIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAvLyBPbmx5IGtub3duIHdyYXBwZXIgdHlwZU5hbWVzIGRlc2NlbmQuIFpvZEFycmF5IC8gWm9kT2JqZWN0IC9cbiAgICAvLyBab2RSZWNvcmQgLyBab2RVbmlvbiBldGMuIGJyZWFrIG91dCBzbyB0aGUgY2FsbGVyIGNhbiBicmFuY2hcbiAgICAvLyBvbiB0aGUgYmFzZSBpbnN0YW5jZSBjaGVjay5cbiAgICBjb25zdCBpc1dyYXBwZXIgPVxuICAgICAgdG4gPT09ICdab2RPcHRpb25hbCcgfHxcbiAgICAgIHRuID09PSAnWm9kRGVmYXVsdCcgfHxcbiAgICAgIHRuID09PSAnWm9kTnVsbGFibGUnIHx8XG4gICAgICB0biA9PT0gJ1pvZFJlYWRvbmx5JyB8fFxuICAgICAgdG4gPT09ICdab2RCcmFuZGVkJyB8fFxuICAgICAgdG4gPT09ICdab2RDYXRjaCcgfHxcbiAgICAgIHRuID09PSAnWm9kRWZmZWN0cycgfHxcbiAgICAgIHRuID09PSAnWm9kUGlwZWxpbmUnIHx8XG4gICAgICB0biA9PT0gJ1pvZExhenknO1xuICAgIGlmICghaXNXcmFwcGVyKSBicmVhaztcbiAgICBpZiAoaXNab2ROb2RlKGRlZi5pbm5lclR5cGUpKSB7XG4gICAgICBzID0gZGVmLmlubmVyVHlwZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNab2ROb2RlKGRlZi5zY2hlbWEpKSB7XG4gICAgICBzID0gZGVmLnNjaGVtYTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBQaXBlbGluZSAoYGluYCAvIGBvdXRgKSDigJQgZGVzY2VuZCBpbnRvIGBpbmAgKGlucHV0IHNpZGUpLlxuICAgIGlmIChpc1pvZE5vZGUoZGVmLmluKSkge1xuICAgICAgcyA9IGRlZi5pbjtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBMYXp5IGhvbGRzIGEgZ2V0dGVyIHVuZGVyIGBnZXR0ZXJgLiBMYXN0LXJlc29ydCBmYWxsYmFjay5cbiAgICBpZiAodHlwZW9mIGRlZi5nZXR0ZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlubmVyID0gKGRlZi5nZXR0ZXIgYXMgKCkgPT4gdW5rbm93bikoKTtcbiAgICAgICAgaWYgKGlzWm9kTm9kZShpbm5lcikpIHtcbiAgICAgICAgICBzID0gaW5uZXI7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgICAgIH1cbiAgICB9XG4gICAgYnJlYWs7XG4gIH1cbiAgcmV0dXJuIGlzWm9kTm9kZShzKSA/IChzIGFzIFpvZFR5cGVBbnkpIDogbnVsbDtcbn1cblxuLyoqIFZlcnNpb24tdG9sZXJhbnQgYWNjZXNzIHRvIFpvZFJlY29yZCB2YWx1ZSBzY2hlbWEuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVjb3JkVmFsdWVUeXBlKHJlYzogWm9kUmVjb3JkPGFueSwgYW55Pik6IFpvZFR5cGVBbnkgfCBudWxsIHtcbiAgY29uc3QgcjogYW55ID0gcmVjIGFzIGFueTtcbiAgY29uc3QgZGVmID0gci5fZGVmID8/IHt9O1xuICByZXR1cm4gKFxuICAgIHIudmFsdWVTY2hlbWEgPz9cbiAgICByLnZhbHVlVHlwZSA/P1xuICAgIGRlZi52YWx1ZVR5cGUgPz9cbiAgICBkZWYudmFsdWUgPz9cbiAgICAoZGVmLnNjaGVtYSAmJiAoZGVmLnNjaGVtYS52YWx1ZVR5cGUgPz8gZGVmLnNjaGVtYS52YWx1ZSkpID8/XG4gICAgKGRlZi5pbm5lclR5cGUgJiYgKGRlZi5pbm5lclR5cGUudmFsdWVUeXBlID8/IGRlZi5pbm5lclR5cGUudmFsdWUpKSA/P1xuICAgIG51bGxcbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9va3NMaWtlQmluZGluZ0Vycm9yKGVycjogdW5rbm93bik6IGJvb2xlYW4ge1xuICBjb25zdCBtc2cgPSAoZXJyIGFzIGFueSk/Lm1lc3NhZ2UgPz8gJyc7XG4gIHJldHVybiBtc2cuaW5jbHVkZXMoJ196b2QnKSB8fCBtc2cuaW5jbHVkZXMoJ2luc3QuX3pvZCcpIHx8IG1zZy5pbmNsdWRlcygnQ2Fubm90IHJlYWQgcHJvcGVydGllcyBvZiB1bmRlZmluZWQnKTtcbn1cblxuY29uc3QgV1JBUFBFUl9DQUNIRSA9IG5ldyBXZWFrTWFwPFpvZFR5cGVBbnksIFpvZFR5cGVBbnk+KCk7XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVdpdGhUaGlzKHNjaGVtYTogWm9kVHlwZUFueSwgdmFsdWU6IHVua25vd24pOiB1bmtub3duIHtcbiAgY29uc3QgYW55U2NoZW1hID0gc2NoZW1hIGFzIGFueTtcblxuICBpZiAodHlwZW9mIGFueVNjaGVtYS5zYWZlUGFyc2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzID0gYW55U2NoZW1hLnNhZmVQYXJzZSh2YWx1ZSk7XG4gICAgICBpZiAocmVzICYmIHR5cGVvZiByZXMgPT09ICdvYmplY3QnICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZXMsICdzdWNjZXNzJykpIHtcbiAgICAgICAgaWYgKHJlcy5zdWNjZXNzKSByZXR1cm4gcmVzLmRhdGE7XG4gICAgICAgIHRocm93IHJlcy5lcnJvcjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmICghbG9va3NMaWtlQmluZGluZ0Vycm9yKGVycikpIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICBpZiAodHlwZW9mIGFueVNjaGVtYS5zYWZlUGFyc2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzID0gYW55U2NoZW1hLnNhZmVQYXJzZS5jYWxsKHNjaGVtYSwgdmFsdWUpO1xuICAgICAgaWYgKHJlcyAmJiB0eXBlb2YgcmVzID09PSAnb2JqZWN0JyAmJiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzLCAnc3VjY2VzcycpKSB7XG4gICAgICAgIGlmIChyZXMuc3VjY2VzcykgcmV0dXJuIHJlcy5kYXRhO1xuICAgICAgICB0aHJvdyByZXMuZXJyb3I7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWxvb2tzTGlrZUJpbmRpbmdFcnJvcihlcnIpKSB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgaWYgKHR5cGVvZiBhbnlTY2hlbWEucGFyc2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGFueVNjaGVtYS5wYXJzZSh2YWx1ZSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWxvb2tzTGlrZUJpbmRpbmdFcnJvcihlcnIpKSB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgbGV0IHdyYXBwZXIgPSBXUkFQUEVSX0NBQ0hFLmdldChzY2hlbWEpO1xuICBpZiAoIXdyYXBwZXIpIHtcbiAgICB3cmFwcGVyID0gKHouYW55KCkgYXMgYW55KS5waXBlKHNjaGVtYSBhcyBhbnkpO1xuICAgIFdSQVBQRVJfQ0FDSEUuc2V0KHNjaGVtYSwgd3JhcHBlciEpO1xuICB9XG4gIGNvbnN0IHJlcyA9ICh3cmFwcGVyIGFzIGFueSkuc2FmZVBhcnNlKHZhbHVlKTtcbiAgaWYgKHJlcyAmJiByZXMuc3VjY2VzcykgcmV0dXJuIHJlcy5kYXRhO1xuXG4gIHRocm93IHJlcz8uZXJyb3IgPz8gbmV3IFR5cGVFcnJvcignWm9kIHZhbGlkYXRpb24gYmluZGluZyBmYWlsZWQgKHdyYXBwZXIgZmFsbGJhY2spLicpO1xufVxuIl19