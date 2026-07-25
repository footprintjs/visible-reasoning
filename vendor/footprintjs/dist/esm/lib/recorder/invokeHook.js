/**
 * recorder/invokeHook.ts — the ONE per-listener invoke helper (RFC-001 §9 mitigation).
 *
 * Pattern:  Single shared "look up the hook, bind `this`, call it" primitive
 *           used by BOTH delivery tiers:
 *             - inline:   `ScopeFacade._invokeHook` / `ScopeFacade.emitEvent`
 *               call it per recorder per event (the historical direct call);
 *             - deferred: `DeferredObserverTier`'s dispatcher listener calls
 *               it per envelope at the flush checkpoint.
 *           Because both tiers route through the SAME lookup + `.call(this)`
 *           semantics, the two paths cannot drift: a recorder that works
 *           inline is invoked identically one beat behind.
 * Role:     Invocation primitive only. NO error handling here — the two
 *           tiers isolate failures differently by design (inline routes a
 *           throw to sibling recorders' `onError` at the dispatch site;
 *           deferred routes sync throws AND async rejections through
 *           `DeferredDispatcher`'s injected error callback).
 *
 * Lookup semantics: NORMAL property lookup (prototype chain included), the
 * same as the historical `recorder[hook]` read in `ScopeFacade._invokeHook` —
 * class-based recorders declare hooks on their prototype. (The own-property
 * restriction in `hasRecorderMethods` applies only to CHANNEL ROUTING
 * detection, not to invocation.)
 */
/**
 * Invoke `recorder[method](event)` with `this` bound to the recorder, iff
 * `method` resolves to a function. Returns the hook's return value (a
 * deferred listener may return a Promise the dispatcher tracks); returns
 * `undefined` when the hook is absent. Throws whatever the hook throws —
 * callers own error isolation.
 */
export function invokeRecorderHook(recorder, method, event) {
    const hook = recorder[method];
    if (typeof hook !== 'function')
        return undefined;
    return hook.call(recorder, event);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW52b2tlSG9vay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVjb3JkZXIvaW52b2tlSG9vay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F1Qkc7QUFFSDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsUUFBZ0IsRUFBRSxNQUFjLEVBQUUsS0FBYztJQUNqRixNQUFNLElBQUksR0FBSSxRQUFvQyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzNELElBQUksT0FBTyxJQUFJLEtBQUssVUFBVTtRQUFFLE9BQU8sU0FBUyxDQUFDO0lBQ2pELE9BQVEsSUFBZ0MsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLEtBQUssQ0FBQyxDQUFDO0FBQ2pFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHJlY29yZGVyL2ludm9rZUhvb2sudHMg4oCUIHRoZSBPTkUgcGVyLWxpc3RlbmVyIGludm9rZSBoZWxwZXIgKFJGQy0wMDEgwqc5IG1pdGlnYXRpb24pLlxuICpcbiAqIFBhdHRlcm46ICBTaW5nbGUgc2hhcmVkIFwibG9vayB1cCB0aGUgaG9vaywgYmluZCBgdGhpc2AsIGNhbGwgaXRcIiBwcmltaXRpdmVcbiAqICAgICAgICAgICB1c2VkIGJ5IEJPVEggZGVsaXZlcnkgdGllcnM6XG4gKiAgICAgICAgICAgICAtIGlubGluZTogICBgU2NvcGVGYWNhZGUuX2ludm9rZUhvb2tgIC8gYFNjb3BlRmFjYWRlLmVtaXRFdmVudGBcbiAqICAgICAgICAgICAgICAgY2FsbCBpdCBwZXIgcmVjb3JkZXIgcGVyIGV2ZW50ICh0aGUgaGlzdG9yaWNhbCBkaXJlY3QgY2FsbCk7XG4gKiAgICAgICAgICAgICAtIGRlZmVycmVkOiBgRGVmZXJyZWRPYnNlcnZlclRpZXJgJ3MgZGlzcGF0Y2hlciBsaXN0ZW5lciBjYWxsc1xuICogICAgICAgICAgICAgICBpdCBwZXIgZW52ZWxvcGUgYXQgdGhlIGZsdXNoIGNoZWNrcG9pbnQuXG4gKiAgICAgICAgICAgQmVjYXVzZSBib3RoIHRpZXJzIHJvdXRlIHRocm91Z2ggdGhlIFNBTUUgbG9va3VwICsgYC5jYWxsKHRoaXMpYFxuICogICAgICAgICAgIHNlbWFudGljcywgdGhlIHR3byBwYXRocyBjYW5ub3QgZHJpZnQ6IGEgcmVjb3JkZXIgdGhhdCB3b3Jrc1xuICogICAgICAgICAgIGlubGluZSBpcyBpbnZva2VkIGlkZW50aWNhbGx5IG9uZSBiZWF0IGJlaGluZC5cbiAqIFJvbGU6ICAgICBJbnZvY2F0aW9uIHByaW1pdGl2ZSBvbmx5LiBOTyBlcnJvciBoYW5kbGluZyBoZXJlIOKAlCB0aGUgdHdvXG4gKiAgICAgICAgICAgdGllcnMgaXNvbGF0ZSBmYWlsdXJlcyBkaWZmZXJlbnRseSBieSBkZXNpZ24gKGlubGluZSByb3V0ZXMgYVxuICogICAgICAgICAgIHRocm93IHRvIHNpYmxpbmcgcmVjb3JkZXJzJyBgb25FcnJvcmAgYXQgdGhlIGRpc3BhdGNoIHNpdGU7XG4gKiAgICAgICAgICAgZGVmZXJyZWQgcm91dGVzIHN5bmMgdGhyb3dzIEFORCBhc3luYyByZWplY3Rpb25zIHRocm91Z2hcbiAqICAgICAgICAgICBgRGVmZXJyZWREaXNwYXRjaGVyYCdzIGluamVjdGVkIGVycm9yIGNhbGxiYWNrKS5cbiAqXG4gKiBMb29rdXAgc2VtYW50aWNzOiBOT1JNQUwgcHJvcGVydHkgbG9va3VwIChwcm90b3R5cGUgY2hhaW4gaW5jbHVkZWQpLCB0aGVcbiAqIHNhbWUgYXMgdGhlIGhpc3RvcmljYWwgYHJlY29yZGVyW2hvb2tdYCByZWFkIGluIGBTY29wZUZhY2FkZS5faW52b2tlSG9va2Ag4oCUXG4gKiBjbGFzcy1iYXNlZCByZWNvcmRlcnMgZGVjbGFyZSBob29rcyBvbiB0aGVpciBwcm90b3R5cGUuIChUaGUgb3duLXByb3BlcnR5XG4gKiByZXN0cmljdGlvbiBpbiBgaGFzUmVjb3JkZXJNZXRob2RzYCBhcHBsaWVzIG9ubHkgdG8gQ0hBTk5FTCBST1VUSU5HXG4gKiBkZXRlY3Rpb24sIG5vdCB0byBpbnZvY2F0aW9uLilcbiAqL1xuXG4vKipcbiAqIEludm9rZSBgcmVjb3JkZXJbbWV0aG9kXShldmVudClgIHdpdGggYHRoaXNgIGJvdW5kIHRvIHRoZSByZWNvcmRlciwgaWZmXG4gKiBgbWV0aG9kYCByZXNvbHZlcyB0byBhIGZ1bmN0aW9uLiBSZXR1cm5zIHRoZSBob29rJ3MgcmV0dXJuIHZhbHVlIChhXG4gKiBkZWZlcnJlZCBsaXN0ZW5lciBtYXkgcmV0dXJuIGEgUHJvbWlzZSB0aGUgZGlzcGF0Y2hlciB0cmFja3MpOyByZXR1cm5zXG4gKiBgdW5kZWZpbmVkYCB3aGVuIHRoZSBob29rIGlzIGFic2VudC4gVGhyb3dzIHdoYXRldmVyIHRoZSBob29rIHRocm93cyDigJRcbiAqIGNhbGxlcnMgb3duIGVycm9yIGlzb2xhdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludm9rZVJlY29yZGVySG9vayhyZWNvcmRlcjogb2JqZWN0LCBtZXRob2Q6IHN0cmluZywgZXZlbnQ6IHVua25vd24pOiB1bmtub3duIHtcbiAgY29uc3QgaG9vayA9IChyZWNvcmRlciBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilbbWV0aG9kXTtcbiAgaWYgKHR5cGVvZiBob29rICE9PSAnZnVuY3Rpb24nKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gKGhvb2sgYXMgKGU6IHVua25vd24pID0+IHVua25vd24pLmNhbGwocmVjb3JkZXIsIGV2ZW50KTtcbn1cbiJdfQ==