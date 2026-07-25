/**
 * slice/keysReadSources.ts — the shipped {@link KeysReadSource} strategies.
 *
 * The canonical strategy list and rationale live on the KeysReadSource type
 * (types.ts) — the doc consumers hover. This file holds the implementations.
 *
 * Deliberately NOT here: a QualityRecorder adapter. Importing recorder/ would
 * drag this leaf library up the dependency DAG. The adapter is a one-liner at
 * the call site instead: `(id) => recorder.getByKey(id)?.keysRead ?? []`.
 */
/**
 * Post-hoc reads from a finished run's execution tree — ZERO setup.
 *
 * WHY this works: `StageSnapshot.stageReads` records the keys a stage
 * tracked-read whenever the `readTracking` dial ≠ 'off' ('full' is the
 * engine default; 'summary' replaces VALUES with markers but keeps the
 * KEYS — and keys are all a slice needs). Under 'off' this source returns
 * empty read-sets — detectable via `coverage.stepsWithReads === 0`, which
 * `sliceForKey` copies onto the slice so tools can say "reads were not
 * recorded" instead of the lie "no dependencies".
 *
 * SUBFLOW PAIRING (important): a subflow runs in an ISOLATED runtime — its
 * commits live in `snapshot.subflowResults[sfId].commitLog`, its reads in
 * `snapshot.subflowResults[sfId].executionTree`. Trees and logs must be
 * paired from the SAME scope: to slice a key inside a subflow, re-anchor
 * there —
 *
 * ```ts
 * const sf = snapshot.subflowResults['sf-tools'];
 * sliceForKey(sf.commitLog, key, keysReadFromExecutionTree(sf.executionTree));
 * ```
 *
 * Passing multiple trees widens READ resolution only (useful when one log
 * genuinely spans them); it does not let a root-log slice cross a subflow
 * mount — see README.md § Subflow boundaries.
 */
export function keysReadFromExecutionTree(tree) {
    const byStep = new Map();
    const roots = Array.isArray(tree) ? tree : [tree];
    let steps = 0;
    // The tree is acyclic by construction (next/children), but this walker is
    // also handed CONSUMER-provided data — a visited set makes a malformed or
    // hand-built tree a non-event instead of an infinite loop.
    const visited = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
        const node = stack.pop();
        if (visited.has(node))
            continue;
        visited.add(node);
        if (node.runtimeStageId) {
            steps++;
            if (node.stageReads) {
                const keys = Object.keys(node.stageReads);
                if (keys.length > 0)
                    byStep.set(node.runtimeStageId, keys);
            }
        }
        if (node.next)
            stack.push(node.next);
        if (node.children)
            for (const c of node.children)
                stack.push(c);
    }
    return {
        kind: 'execution-tree',
        lookup: (runtimeStageId) => byStep.get(runtimeStageId) ?? [],
        coverage: { steps, stepsWithReads: byStep.size },
    };
}
/**
 * Reads from a prebuilt map — e.g. collected live from
 * `ScopeRecorder.onRead` events, or deserialized from a stored trace.
 */
export function keysReadFromMap(map) {
    // Own-property guard on the object form: runtimeStageIds are consumer-
    // influenced strings; without it, an id like 'constructor' would read
    // through the prototype chain (the same hardening posture as the engine's
    // nativeGet/prototype-pollution guards).
    const get = map instanceof Map
        ? (id) => map.get(id)
        : (id) => Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
    return {
        kind: 'map',
        lookup: (runtimeStageId) => [...(get(runtimeStageId) ?? [])],
    };
}
/**
 * Normalize the ergonomic union: callers may pass a full strategy object or
 * a bare lookup function (wrapped as kind 'custom-fn' so the honesty
 * breadcrumb still says where reads came from).
 */
export function resolveKeysReadSource(src) {
    return typeof src === 'function' ? { kind: 'custom-fn', lookup: src } : src;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2V5c1JlYWRTb3VyY2VzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9zbGljZS9rZXlzUmVhZFNvdXJjZXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7OztHQVNHO0FBTUg7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F5Qkc7QUFDSCxNQUFNLFVBQVUseUJBQXlCLENBQUMsSUFBcUM7SUFDN0UsTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLEVBQW9CLENBQUM7SUFDM0MsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2xELElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztJQUNkLDBFQUEwRTtJQUMxRSwwRUFBMEU7SUFDMUUsMkRBQTJEO0lBQzNELE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxFQUFpQixDQUFDO0lBQ3pDLE1BQU0sS0FBSyxHQUFvQixDQUFDLEdBQUcsS0FBSyxDQUFDLENBQUM7SUFDMUMsT0FBTyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxHQUFHLEVBQUcsQ0FBQztRQUMxQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDO1lBQUUsU0FBUztRQUNoQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ2xCLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3hCLEtBQUssRUFBRSxDQUFDO1lBQ1IsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7Z0JBQ3BCLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUMxQyxJQUFJLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQztvQkFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFDN0QsQ0FBQztRQUNILENBQUM7UUFDRCxJQUFJLElBQUksQ0FBQyxJQUFJO1lBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckMsSUFBSSxJQUFJLENBQUMsUUFBUTtZQUFFLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7Z0JBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBQ0QsT0FBTztRQUNMLElBQUksRUFBRSxnQkFBZ0I7UUFDdEIsTUFBTSxFQUFFLENBQUMsY0FBc0IsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFO1FBQ3BFLFFBQVEsRUFBRSxFQUFFLEtBQUssRUFBRSxjQUFjLEVBQUUsTUFBTSxDQUFDLElBQUksRUFBRTtLQUNqRCxDQUFDO0FBQ0osQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQzdCLEdBQXlGO0lBRXpGLHVFQUF1RTtJQUN2RSxzRUFBc0U7SUFDdEUsMEVBQTBFO0lBQzFFLHlDQUF5QztJQUN6QyxNQUFNLEdBQUcsR0FDUCxHQUFHLFlBQVksR0FBRztRQUNoQixDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3JCLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQ0wsTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUUsR0FBeUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0lBQ25ILE9BQU87UUFDTCxJQUFJLEVBQUUsS0FBSztRQUNYLE1BQU0sRUFBRSxDQUFDLGNBQXNCLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztLQUNyRSxDQUFDO0FBQ0osQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxNQUFNLFVBQVUscUJBQXFCLENBQUMsR0FBb0M7SUFDeEUsT0FBTyxPQUFPLEdBQUcsS0FBSyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQztBQUM5RSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBzbGljZS9rZXlzUmVhZFNvdXJjZXMudHMg4oCUIHRoZSBzaGlwcGVkIHtAbGluayBLZXlzUmVhZFNvdXJjZX0gc3RyYXRlZ2llcy5cbiAqXG4gKiBUaGUgY2Fub25pY2FsIHN0cmF0ZWd5IGxpc3QgYW5kIHJhdGlvbmFsZSBsaXZlIG9uIHRoZSBLZXlzUmVhZFNvdXJjZSB0eXBlXG4gKiAodHlwZXMudHMpIOKAlCB0aGUgZG9jIGNvbnN1bWVycyBob3Zlci4gVGhpcyBmaWxlIGhvbGRzIHRoZSBpbXBsZW1lbnRhdGlvbnMuXG4gKlxuICogRGVsaWJlcmF0ZWx5IE5PVCBoZXJlOiBhIFF1YWxpdHlSZWNvcmRlciBhZGFwdGVyLiBJbXBvcnRpbmcgcmVjb3JkZXIvIHdvdWxkXG4gKiBkcmFnIHRoaXMgbGVhZiBsaWJyYXJ5IHVwIHRoZSBkZXBlbmRlbmN5IERBRy4gVGhlIGFkYXB0ZXIgaXMgYSBvbmUtbGluZXIgYXRcbiAqIHRoZSBjYWxsIHNpdGUgaW5zdGVhZDogYChpZCkgPT4gcmVjb3JkZXIuZ2V0QnlLZXkoaWQpPy5rZXlzUmVhZCA/PyBbXWAuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBLZXlzUmVhZExvb2t1cCB9IGZyb20gJy4uL21lbW9yeS9iYWNrdHJhY2suanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZVNuYXBzaG90IH0gZnJvbSAnLi4vbWVtb3J5L3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgS2V5c1JlYWRTb3VyY2UgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLyoqXG4gKiBQb3N0LWhvYyByZWFkcyBmcm9tIGEgZmluaXNoZWQgcnVuJ3MgZXhlY3V0aW9uIHRyZWUg4oCUIFpFUk8gc2V0dXAuXG4gKlxuICogV0hZIHRoaXMgd29ya3M6IGBTdGFnZVNuYXBzaG90LnN0YWdlUmVhZHNgIHJlY29yZHMgdGhlIGtleXMgYSBzdGFnZVxuICogdHJhY2tlZC1yZWFkIHdoZW5ldmVyIHRoZSBgcmVhZFRyYWNraW5nYCBkaWFsIOKJoCAnb2ZmJyAoJ2Z1bGwnIGlzIHRoZVxuICogZW5naW5lIGRlZmF1bHQ7ICdzdW1tYXJ5JyByZXBsYWNlcyBWQUxVRVMgd2l0aCBtYXJrZXJzIGJ1dCBrZWVwcyB0aGVcbiAqIEtFWVMg4oCUIGFuZCBrZXlzIGFyZSBhbGwgYSBzbGljZSBuZWVkcykuIFVuZGVyICdvZmYnIHRoaXMgc291cmNlIHJldHVybnNcbiAqIGVtcHR5IHJlYWQtc2V0cyDigJQgZGV0ZWN0YWJsZSB2aWEgYGNvdmVyYWdlLnN0ZXBzV2l0aFJlYWRzID09PSAwYCwgd2hpY2hcbiAqIGBzbGljZUZvcktleWAgY29waWVzIG9udG8gdGhlIHNsaWNlIHNvIHRvb2xzIGNhbiBzYXkgXCJyZWFkcyB3ZXJlIG5vdFxuICogcmVjb3JkZWRcIiBpbnN0ZWFkIG9mIHRoZSBsaWUgXCJubyBkZXBlbmRlbmNpZXNcIi5cbiAqXG4gKiBTVUJGTE9XIFBBSVJJTkcgKGltcG9ydGFudCk6IGEgc3ViZmxvdyBydW5zIGluIGFuIElTT0xBVEVEIHJ1bnRpbWUg4oCUIGl0c1xuICogY29tbWl0cyBsaXZlIGluIGBzbmFwc2hvdC5zdWJmbG93UmVzdWx0c1tzZklkXS5jb21taXRMb2dgLCBpdHMgcmVhZHMgaW5cbiAqIGBzbmFwc2hvdC5zdWJmbG93UmVzdWx0c1tzZklkXS5leGVjdXRpb25UcmVlYC4gVHJlZXMgYW5kIGxvZ3MgbXVzdCBiZVxuICogcGFpcmVkIGZyb20gdGhlIFNBTUUgc2NvcGU6IHRvIHNsaWNlIGEga2V5IGluc2lkZSBhIHN1YmZsb3csIHJlLWFuY2hvclxuICogdGhlcmUg4oCUXG4gKlxuICogYGBgdHNcbiAqIGNvbnN0IHNmID0gc25hcHNob3Quc3ViZmxvd1Jlc3VsdHNbJ3NmLXRvb2xzJ107XG4gKiBzbGljZUZvcktleShzZi5jb21taXRMb2csIGtleSwga2V5c1JlYWRGcm9tRXhlY3V0aW9uVHJlZShzZi5leGVjdXRpb25UcmVlKSk7XG4gKiBgYGBcbiAqXG4gKiBQYXNzaW5nIG11bHRpcGxlIHRyZWVzIHdpZGVucyBSRUFEIHJlc29sdXRpb24gb25seSAodXNlZnVsIHdoZW4gb25lIGxvZ1xuICogZ2VudWluZWx5IHNwYW5zIHRoZW0pOyBpdCBkb2VzIG5vdCBsZXQgYSByb290LWxvZyBzbGljZSBjcm9zcyBhIHN1YmZsb3dcbiAqIG1vdW50IOKAlCBzZWUgUkVBRE1FLm1kIMKnIFN1YmZsb3cgYm91bmRhcmllcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGtleXNSZWFkRnJvbUV4ZWN1dGlvblRyZWUodHJlZTogU3RhZ2VTbmFwc2hvdCB8IFN0YWdlU25hcHNob3RbXSk6IEtleXNSZWFkU291cmNlIHtcbiAgY29uc3QgYnlTdGVwID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBjb25zdCByb290cyA9IEFycmF5LmlzQXJyYXkodHJlZSkgPyB0cmVlIDogW3RyZWVdO1xuICBsZXQgc3RlcHMgPSAwO1xuICAvLyBUaGUgdHJlZSBpcyBhY3ljbGljIGJ5IGNvbnN0cnVjdGlvbiAobmV4dC9jaGlsZHJlbiksIGJ1dCB0aGlzIHdhbGtlciBpc1xuICAvLyBhbHNvIGhhbmRlZCBDT05TVU1FUi1wcm92aWRlZCBkYXRhIOKAlCBhIHZpc2l0ZWQgc2V0IG1ha2VzIGEgbWFsZm9ybWVkIG9yXG4gIC8vIGhhbmQtYnVpbHQgdHJlZSBhIG5vbi1ldmVudCBpbnN0ZWFkIG9mIGFuIGluZmluaXRlIGxvb3AuXG4gIGNvbnN0IHZpc2l0ZWQgPSBuZXcgU2V0PFN0YWdlU25hcHNob3Q+KCk7XG4gIGNvbnN0IHN0YWNrOiBTdGFnZVNuYXBzaG90W10gPSBbLi4ucm9vdHNdO1xuICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG5vZGUgPSBzdGFjay5wb3AoKSE7XG4gICAgaWYgKHZpc2l0ZWQuaGFzKG5vZGUpKSBjb250aW51ZTtcbiAgICB2aXNpdGVkLmFkZChub2RlKTtcbiAgICBpZiAobm9kZS5ydW50aW1lU3RhZ2VJZCkge1xuICAgICAgc3RlcHMrKztcbiAgICAgIGlmIChub2RlLnN0YWdlUmVhZHMpIHtcbiAgICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG5vZGUuc3RhZ2VSZWFkcyk7XG4gICAgICAgIGlmIChrZXlzLmxlbmd0aCA+IDApIGJ5U3RlcC5zZXQobm9kZS5ydW50aW1lU3RhZ2VJZCwga2V5cyk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChub2RlLm5leHQpIHN0YWNrLnB1c2gobm9kZS5uZXh0KTtcbiAgICBpZiAobm9kZS5jaGlsZHJlbikgZm9yIChjb25zdCBjIG9mIG5vZGUuY2hpbGRyZW4pIHN0YWNrLnB1c2goYyk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBraW5kOiAnZXhlY3V0aW9uLXRyZWUnLFxuICAgIGxvb2t1cDogKHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmcpID0+IGJ5U3RlcC5nZXQocnVudGltZVN0YWdlSWQpID8/IFtdLFxuICAgIGNvdmVyYWdlOiB7IHN0ZXBzLCBzdGVwc1dpdGhSZWFkczogYnlTdGVwLnNpemUgfSxcbiAgfTtcbn1cblxuLyoqXG4gKiBSZWFkcyBmcm9tIGEgcHJlYnVpbHQgbWFwIOKAlCBlLmcuIGNvbGxlY3RlZCBsaXZlIGZyb21cbiAqIGBTY29wZVJlY29yZGVyLm9uUmVhZGAgZXZlbnRzLCBvciBkZXNlcmlhbGl6ZWQgZnJvbSBhIHN0b3JlZCB0cmFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGtleXNSZWFkRnJvbU1hcChcbiAgbWFwOiBSZWFkb25seU1hcDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiB8IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPj4sXG4pOiBLZXlzUmVhZFNvdXJjZSB7XG4gIC8vIE93bi1wcm9wZXJ0eSBndWFyZCBvbiB0aGUgb2JqZWN0IGZvcm06IHJ1bnRpbWVTdGFnZUlkcyBhcmUgY29uc3VtZXItXG4gIC8vIGluZmx1ZW5jZWQgc3RyaW5nczsgd2l0aG91dCBpdCwgYW4gaWQgbGlrZSAnY29uc3RydWN0b3InIHdvdWxkIHJlYWRcbiAgLy8gdGhyb3VnaCB0aGUgcHJvdG90eXBlIGNoYWluICh0aGUgc2FtZSBoYXJkZW5pbmcgcG9zdHVyZSBhcyB0aGUgZW5naW5lJ3NcbiAgLy8gbmF0aXZlR2V0L3Byb3RvdHlwZS1wb2xsdXRpb24gZ3VhcmRzKS5cbiAgY29uc3QgZ2V0OiAoaWQ6IHN0cmluZykgPT4gcmVhZG9ubHkgc3RyaW5nW10gfCB1bmRlZmluZWQgPVxuICAgIG1hcCBpbnN0YW5jZW9mIE1hcFxuICAgICAgPyAoaWQpID0+IG1hcC5nZXQoaWQpXG4gICAgICA6IChpZCkgPT5cbiAgICAgICAgICBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwobWFwLCBpZCkgPyAobWFwIGFzIFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPilbaWRdIDogdW5kZWZpbmVkO1xuICByZXR1cm4ge1xuICAgIGtpbmQ6ICdtYXAnLFxuICAgIGxvb2t1cDogKHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmcpID0+IFsuLi4oZ2V0KHJ1bnRpbWVTdGFnZUlkKSA/PyBbXSldLFxuICB9O1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSB0aGUgZXJnb25vbWljIHVuaW9uOiBjYWxsZXJzIG1heSBwYXNzIGEgZnVsbCBzdHJhdGVneSBvYmplY3Qgb3JcbiAqIGEgYmFyZSBsb29rdXAgZnVuY3Rpb24gKHdyYXBwZWQgYXMga2luZCAnY3VzdG9tLWZuJyBzbyB0aGUgaG9uZXN0eVxuICogYnJlYWRjcnVtYiBzdGlsbCBzYXlzIHdoZXJlIHJlYWRzIGNhbWUgZnJvbSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlS2V5c1JlYWRTb3VyY2Uoc3JjOiBLZXlzUmVhZFNvdXJjZSB8IEtleXNSZWFkTG9va3VwKTogS2V5c1JlYWRTb3VyY2Uge1xuICByZXR1cm4gdHlwZW9mIHNyYyA9PT0gJ2Z1bmN0aW9uJyA/IHsga2luZDogJ2N1c3RvbS1mbicsIGxvb2t1cDogc3JjIH0gOiBzcmM7XG59XG4iXX0=