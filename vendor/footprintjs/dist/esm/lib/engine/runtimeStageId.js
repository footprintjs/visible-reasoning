/**
 * runtimeStageId — unique identifier for each execution step during traversal.
 *
 * Format: [subflowPath/]stageId#executionIndex
 *
 * Components:
 *   stageId        — stable node ID from the builder ('call-llm', 'seed')
 *   executionIndex — monotonic counter incremented per stage execution (0, 1, 2...)
 *   subflowPath    — optional path for subflow stages ('sf-tools', 'sf-outer/sf-inner')
 *
 * Properties:
 *   - Unique within a run (executionIndex never repeats)
 *   - Execution-ordered (sort by executionIndex = execution order)
 *   - Human-readable ('sf-tools/execute-tool-calls#8')
 *   - Parseable (split on '#' for stageId and index, split stageId on '/' for subflow path)
 *
 * Naming-collision warning
 * ────────────────────────
 *   The parsed-output `.stageId` field below is the LOCAL form (segment
 *   after the last '/'). This is NOT the same as `spec.id` / `node.id`
 *   for subflow-nested stages, which carry the FULL prefixed form
 *   (`'sf-tools/execute-tool-calls'`). To compare safely, use
 *   `splitStageId(spec.id)` to decompose the prefixed form the same
 *   way `parseRuntimeStageId` decomposes a runtimeStageId.
 *
 * @example
 * ```
 * buildRuntimeStageId('call-llm', 5)                    // 'call-llm#5'
 * buildRuntimeStageId('execute-tool-calls', 8, 'sf-tools') // 'sf-tools/execute-tool-calls#8'
 * buildRuntimeStageId('validate', 3, 'sf-outer/sf-inner')  // 'sf-outer/sf-inner/validate#3'
 * ```
 */
/**
 * Build a runtimeStageId from its components.
 *
 * Note: The traverser does NOT use the subflowPath parameter — node.id already
 * includes the subflow prefix from the builder. This parameter exists for external
 * consumers constructing IDs from parsed components (round-trip via parseRuntimeStageId).
 */
export function buildRuntimeStageId(stageId, executionIndex, subflowPath) {
    const prefix = subflowPath ? `${subflowPath}/` : '';
    return `${prefix}${stageId}#${executionIndex}`;
}
/**
 * Parse a runtimeStageId into its components.
 *
 * IMPORTANT — naming collision: the returned `stageId` is the LOCAL
 * form (the segment between the last '/' and the '#'). This is NOT
 * the same as `spec.id` or `node.id` for subflow-nested stages,
 * which contain the FULL prefixed form.
 *
 *   parseRuntimeStageId('sf-tools/execute-tool-calls#8').stageId
 *   // → 'execute-tool-calls'   (LOCAL)
 *
 *   node.id  // (post-mount, in a spec that contains subflows)
 *   // → 'sf-tools/execute-tool-calls'   (FULL prefixed)
 *
 * To compare these two safely, use `splitStageId(node.id)` to get
 * the local form, OR reconstruct the full form via
 * `(subflowPath ? subflowPath + '/' : '') + stageId`.
 */
export function parseRuntimeStageId(runtimeStageId) {
    const hashIdx = runtimeStageId.lastIndexOf('#');
    if (hashIdx === -1) {
        return { stageId: runtimeStageId, executionIndex: 0, subflowPath: undefined };
    }
    const beforeHash = runtimeStageId.slice(0, hashIdx);
    const executionIndex = parseInt(runtimeStageId.slice(hashIdx + 1), 10);
    const lastSlash = beforeHash.lastIndexOf('/');
    if (lastSlash === -1) {
        return { stageId: beforeHash, executionIndex, subflowPath: undefined };
    }
    return {
        stageId: beforeHash.slice(lastSlash + 1),
        executionIndex,
        subflowPath: beforeHash.slice(0, lastSlash),
    };
}
/**
 * Decompose a (possibly prefixed) stage id into its components.
 *
 * Use this when you have an id WITHOUT the `#N` execution suffix and
 * need the local stage name and/or the subflow path. Common sources
 * of such ids:
 *   - `spec.id` (post-mount the id includes any subflow prefix)
 *   - `CommitBundle.stageId` (post-mount id)
 *   - `node.id` from xyflow nodes built off the spec
 *   - the segment of `runtimeStageId` BEFORE the `#` (use
 *     `parseRuntimeStageId` directly for full runtimeStageId strings)
 *
 * Mirrors the decomposition `parseRuntimeStageId` performs on the
 * stageId portion of a runtimeStageId, so the two helpers stay in
 * lockstep on naming and behavior.
 *
 * @example
 * splitStageId('sf-tools/execute-tool-calls')
 * // → { localStageId: 'execute-tool-calls', subflowPath: 'sf-tools' }
 *
 * splitStageId('execute-tool-calls')
 * // → { localStageId: 'execute-tool-calls', subflowPath: undefined }
 *
 * splitStageId('sf-outer/sf-inner/validate')
 * // → { localStageId: 'validate', subflowPath: 'sf-outer/sf-inner' }
 */
export function splitStageId(prefixedStageId) {
    const lastSlash = prefixedStageId.lastIndexOf('/');
    if (lastSlash === -1) {
        return { localStageId: prefixedStageId, subflowPath: undefined };
    }
    return {
        localStageId: prefixedStageId.slice(lastSlash + 1),
        subflowPath: prefixedStageId.slice(0, lastSlash),
    };
}
/** Create a new execution counter starting at 0. */
export function createExecutionCounter() {
    return { value: 0 };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVudGltZVN0YWdlSWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9ydW50aW1lU3RhZ2VJZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQStCRztBQUVIOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSxtQkFBbUIsQ0FBQyxPQUFlLEVBQUUsY0FBc0IsRUFBRSxXQUFvQjtJQUMvRixNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLEdBQUcsV0FBVyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUNwRCxPQUFPLEdBQUcsTUFBTSxHQUFHLE9BQU8sSUFBSSxjQUFjLEVBQUUsQ0FBQztBQUNqRCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBaUJHO0FBQ0gsTUFBTSxVQUFVLG1CQUFtQixDQUFDLGNBQXNCO0lBS3hELE1BQU0sT0FBTyxHQUFHLGNBQWMsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDaEQsSUFBSSxPQUFPLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNuQixPQUFPLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxjQUFjLEVBQUUsQ0FBQyxFQUFFLFdBQVcsRUFBRSxTQUFTLEVBQUUsQ0FBQztJQUNoRixDQUFDO0lBRUQsTUFBTSxVQUFVLEdBQUcsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDcEQsTUFBTSxjQUFjLEdBQUcsUUFBUSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxHQUFHLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBRXZFLE1BQU0sU0FBUyxHQUFHLFVBQVUsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDOUMsSUFBSSxTQUFTLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNyQixPQUFPLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxjQUFjLEVBQUUsV0FBVyxFQUFFLFNBQVMsRUFBRSxDQUFDO0lBQ3pFLENBQUM7SUFFRCxPQUFPO1FBQ0wsT0FBTyxFQUFFLFVBQVUsQ0FBQyxLQUFLLENBQUMsU0FBUyxHQUFHLENBQUMsQ0FBQztRQUN4QyxjQUFjO1FBQ2QsV0FBVyxFQUFFLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQztLQUM1QyxDQUFDO0FBQ0osQ0FBQztBQUVEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBeUJHO0FBQ0gsTUFBTSxVQUFVLFlBQVksQ0FBQyxlQUF1QjtJQUlsRCxNQUFNLFNBQVMsR0FBRyxlQUFlLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ25ELElBQUksU0FBUyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDckIsT0FBTyxFQUFFLFlBQVksRUFBRSxlQUFlLEVBQUUsV0FBVyxFQUFFLFNBQVMsRUFBRSxDQUFDO0lBQ25FLENBQUM7SUFDRCxPQUFPO1FBQ0wsWUFBWSxFQUFFLGVBQWUsQ0FBQyxLQUFLLENBQUMsU0FBUyxHQUFHLENBQUMsQ0FBQztRQUNsRCxXQUFXLEVBQUUsZUFBZSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDO0tBQ2pELENBQUM7QUFDSixDQUFDO0FBV0Qsb0RBQW9EO0FBQ3BELE1BQU0sVUFBVSxzQkFBc0I7SUFDcEMsT0FBTyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsQ0FBQztBQUN0QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBydW50aW1lU3RhZ2VJZCDigJQgdW5pcXVlIGlkZW50aWZpZXIgZm9yIGVhY2ggZXhlY3V0aW9uIHN0ZXAgZHVyaW5nIHRyYXZlcnNhbC5cbiAqXG4gKiBGb3JtYXQ6IFtzdWJmbG93UGF0aC9dc3RhZ2VJZCNleGVjdXRpb25JbmRleFxuICpcbiAqIENvbXBvbmVudHM6XG4gKiAgIHN0YWdlSWQgICAgICAgIOKAlCBzdGFibGUgbm9kZSBJRCBmcm9tIHRoZSBidWlsZGVyICgnY2FsbC1sbG0nLCAnc2VlZCcpXG4gKiAgIGV4ZWN1dGlvbkluZGV4IOKAlCBtb25vdG9uaWMgY291bnRlciBpbmNyZW1lbnRlZCBwZXIgc3RhZ2UgZXhlY3V0aW9uICgwLCAxLCAyLi4uKVxuICogICBzdWJmbG93UGF0aCAgICDigJQgb3B0aW9uYWwgcGF0aCBmb3Igc3ViZmxvdyBzdGFnZXMgKCdzZi10b29scycsICdzZi1vdXRlci9zZi1pbm5lcicpXG4gKlxuICogUHJvcGVydGllczpcbiAqICAgLSBVbmlxdWUgd2l0aGluIGEgcnVuIChleGVjdXRpb25JbmRleCBuZXZlciByZXBlYXRzKVxuICogICAtIEV4ZWN1dGlvbi1vcmRlcmVkIChzb3J0IGJ5IGV4ZWN1dGlvbkluZGV4ID0gZXhlY3V0aW9uIG9yZGVyKVxuICogICAtIEh1bWFuLXJlYWRhYmxlICgnc2YtdG9vbHMvZXhlY3V0ZS10b29sLWNhbGxzIzgnKVxuICogICAtIFBhcnNlYWJsZSAoc3BsaXQgb24gJyMnIGZvciBzdGFnZUlkIGFuZCBpbmRleCwgc3BsaXQgc3RhZ2VJZCBvbiAnLycgZm9yIHN1YmZsb3cgcGF0aClcbiAqXG4gKiBOYW1pbmctY29sbGlzaW9uIHdhcm5pbmdcbiAqIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICogICBUaGUgcGFyc2VkLW91dHB1dCBgLnN0YWdlSWRgIGZpZWxkIGJlbG93IGlzIHRoZSBMT0NBTCBmb3JtIChzZWdtZW50XG4gKiAgIGFmdGVyIHRoZSBsYXN0ICcvJykuIFRoaXMgaXMgTk9UIHRoZSBzYW1lIGFzIGBzcGVjLmlkYCAvIGBub2RlLmlkYFxuICogICBmb3Igc3ViZmxvdy1uZXN0ZWQgc3RhZ2VzLCB3aGljaCBjYXJyeSB0aGUgRlVMTCBwcmVmaXhlZCBmb3JtXG4gKiAgIChgJ3NmLXRvb2xzL2V4ZWN1dGUtdG9vbC1jYWxscydgKS4gVG8gY29tcGFyZSBzYWZlbHksIHVzZVxuICogICBgc3BsaXRTdGFnZUlkKHNwZWMuaWQpYCB0byBkZWNvbXBvc2UgdGhlIHByZWZpeGVkIGZvcm0gdGhlIHNhbWVcbiAqICAgd2F5IGBwYXJzZVJ1bnRpbWVTdGFnZUlkYCBkZWNvbXBvc2VzIGEgcnVudGltZVN0YWdlSWQuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYFxuICogYnVpbGRSdW50aW1lU3RhZ2VJZCgnY2FsbC1sbG0nLCA1KSAgICAgICAgICAgICAgICAgICAgLy8gJ2NhbGwtbGxtIzUnXG4gKiBidWlsZFJ1bnRpbWVTdGFnZUlkKCdleGVjdXRlLXRvb2wtY2FsbHMnLCA4LCAnc2YtdG9vbHMnKSAvLyAnc2YtdG9vbHMvZXhlY3V0ZS10b29sLWNhbGxzIzgnXG4gKiBidWlsZFJ1bnRpbWVTdGFnZUlkKCd2YWxpZGF0ZScsIDMsICdzZi1vdXRlci9zZi1pbm5lcicpICAvLyAnc2Ytb3V0ZXIvc2YtaW5uZXIvdmFsaWRhdGUjMydcbiAqIGBgYFxuICovXG5cbi8qKlxuICogQnVpbGQgYSBydW50aW1lU3RhZ2VJZCBmcm9tIGl0cyBjb21wb25lbnRzLlxuICpcbiAqIE5vdGU6IFRoZSB0cmF2ZXJzZXIgZG9lcyBOT1QgdXNlIHRoZSBzdWJmbG93UGF0aCBwYXJhbWV0ZXIg4oCUIG5vZGUuaWQgYWxyZWFkeVxuICogaW5jbHVkZXMgdGhlIHN1YmZsb3cgcHJlZml4IGZyb20gdGhlIGJ1aWxkZXIuIFRoaXMgcGFyYW1ldGVyIGV4aXN0cyBmb3IgZXh0ZXJuYWxcbiAqIGNvbnN1bWVycyBjb25zdHJ1Y3RpbmcgSURzIGZyb20gcGFyc2VkIGNvbXBvbmVudHMgKHJvdW5kLXRyaXAgdmlhIHBhcnNlUnVudGltZVN0YWdlSWQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRSdW50aW1lU3RhZ2VJZChzdGFnZUlkOiBzdHJpbmcsIGV4ZWN1dGlvbkluZGV4OiBudW1iZXIsIHN1YmZsb3dQYXRoPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcHJlZml4ID0gc3ViZmxvd1BhdGggPyBgJHtzdWJmbG93UGF0aH0vYCA6ICcnO1xuICByZXR1cm4gYCR7cHJlZml4fSR7c3RhZ2VJZH0jJHtleGVjdXRpb25JbmRleH1gO1xufVxuXG4vKipcbiAqIFBhcnNlIGEgcnVudGltZVN0YWdlSWQgaW50byBpdHMgY29tcG9uZW50cy5cbiAqXG4gKiBJTVBPUlRBTlQg4oCUIG5hbWluZyBjb2xsaXNpb246IHRoZSByZXR1cm5lZCBgc3RhZ2VJZGAgaXMgdGhlIExPQ0FMXG4gKiBmb3JtICh0aGUgc2VnbWVudCBiZXR3ZWVuIHRoZSBsYXN0ICcvJyBhbmQgdGhlICcjJykuIFRoaXMgaXMgTk9UXG4gKiB0aGUgc2FtZSBhcyBgc3BlYy5pZGAgb3IgYG5vZGUuaWRgIGZvciBzdWJmbG93LW5lc3RlZCBzdGFnZXMsXG4gKiB3aGljaCBjb250YWluIHRoZSBGVUxMIHByZWZpeGVkIGZvcm0uXG4gKlxuICogICBwYXJzZVJ1bnRpbWVTdGFnZUlkKCdzZi10b29scy9leGVjdXRlLXRvb2wtY2FsbHMjOCcpLnN0YWdlSWRcbiAqICAgLy8g4oaSICdleGVjdXRlLXRvb2wtY2FsbHMnICAgKExPQ0FMKVxuICpcbiAqICAgbm9kZS5pZCAgLy8gKHBvc3QtbW91bnQsIGluIGEgc3BlYyB0aGF0IGNvbnRhaW5zIHN1YmZsb3dzKVxuICogICAvLyDihpIgJ3NmLXRvb2xzL2V4ZWN1dGUtdG9vbC1jYWxscycgICAoRlVMTCBwcmVmaXhlZClcbiAqXG4gKiBUbyBjb21wYXJlIHRoZXNlIHR3byBzYWZlbHksIHVzZSBgc3BsaXRTdGFnZUlkKG5vZGUuaWQpYCB0byBnZXRcbiAqIHRoZSBsb2NhbCBmb3JtLCBPUiByZWNvbnN0cnVjdCB0aGUgZnVsbCBmb3JtIHZpYVxuICogYChzdWJmbG93UGF0aCA/IHN1YmZsb3dQYXRoICsgJy8nIDogJycpICsgc3RhZ2VJZGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJ1bnRpbWVTdGFnZUlkKHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmcpOiB7XG4gIHN0YWdlSWQ6IHN0cmluZztcbiAgZXhlY3V0aW9uSW5kZXg6IG51bWJlcjtcbiAgc3ViZmxvd1BhdGg6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn0ge1xuICBjb25zdCBoYXNoSWR4ID0gcnVudGltZVN0YWdlSWQubGFzdEluZGV4T2YoJyMnKTtcbiAgaWYgKGhhc2hJZHggPT09IC0xKSB7XG4gICAgcmV0dXJuIHsgc3RhZ2VJZDogcnVudGltZVN0YWdlSWQsIGV4ZWN1dGlvbkluZGV4OiAwLCBzdWJmbG93UGF0aDogdW5kZWZpbmVkIH07XG4gIH1cblxuICBjb25zdCBiZWZvcmVIYXNoID0gcnVudGltZVN0YWdlSWQuc2xpY2UoMCwgaGFzaElkeCk7XG4gIGNvbnN0IGV4ZWN1dGlvbkluZGV4ID0gcGFyc2VJbnQocnVudGltZVN0YWdlSWQuc2xpY2UoaGFzaElkeCArIDEpLCAxMCk7XG5cbiAgY29uc3QgbGFzdFNsYXNoID0gYmVmb3JlSGFzaC5sYXN0SW5kZXhPZignLycpO1xuICBpZiAobGFzdFNsYXNoID09PSAtMSkge1xuICAgIHJldHVybiB7IHN0YWdlSWQ6IGJlZm9yZUhhc2gsIGV4ZWN1dGlvbkluZGV4LCBzdWJmbG93UGF0aDogdW5kZWZpbmVkIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHN0YWdlSWQ6IGJlZm9yZUhhc2guc2xpY2UobGFzdFNsYXNoICsgMSksXG4gICAgZXhlY3V0aW9uSW5kZXgsXG4gICAgc3ViZmxvd1BhdGg6IGJlZm9yZUhhc2guc2xpY2UoMCwgbGFzdFNsYXNoKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBEZWNvbXBvc2UgYSAocG9zc2libHkgcHJlZml4ZWQpIHN0YWdlIGlkIGludG8gaXRzIGNvbXBvbmVudHMuXG4gKlxuICogVXNlIHRoaXMgd2hlbiB5b3UgaGF2ZSBhbiBpZCBXSVRIT1VUIHRoZSBgI05gIGV4ZWN1dGlvbiBzdWZmaXggYW5kXG4gKiBuZWVkIHRoZSBsb2NhbCBzdGFnZSBuYW1lIGFuZC9vciB0aGUgc3ViZmxvdyBwYXRoLiBDb21tb24gc291cmNlc1xuICogb2Ygc3VjaCBpZHM6XG4gKiAgIC0gYHNwZWMuaWRgIChwb3N0LW1vdW50IHRoZSBpZCBpbmNsdWRlcyBhbnkgc3ViZmxvdyBwcmVmaXgpXG4gKiAgIC0gYENvbW1pdEJ1bmRsZS5zdGFnZUlkYCAocG9zdC1tb3VudCBpZClcbiAqICAgLSBgbm9kZS5pZGAgZnJvbSB4eWZsb3cgbm9kZXMgYnVpbHQgb2ZmIHRoZSBzcGVjXG4gKiAgIC0gdGhlIHNlZ21lbnQgb2YgYHJ1bnRpbWVTdGFnZUlkYCBCRUZPUkUgdGhlIGAjYCAodXNlXG4gKiAgICAgYHBhcnNlUnVudGltZVN0YWdlSWRgIGRpcmVjdGx5IGZvciBmdWxsIHJ1bnRpbWVTdGFnZUlkIHN0cmluZ3MpXG4gKlxuICogTWlycm9ycyB0aGUgZGVjb21wb3NpdGlvbiBgcGFyc2VSdW50aW1lU3RhZ2VJZGAgcGVyZm9ybXMgb24gdGhlXG4gKiBzdGFnZUlkIHBvcnRpb24gb2YgYSBydW50aW1lU3RhZ2VJZCwgc28gdGhlIHR3byBoZWxwZXJzIHN0YXkgaW5cbiAqIGxvY2tzdGVwIG9uIG5hbWluZyBhbmQgYmVoYXZpb3IuXG4gKlxuICogQGV4YW1wbGVcbiAqIHNwbGl0U3RhZ2VJZCgnc2YtdG9vbHMvZXhlY3V0ZS10b29sLWNhbGxzJylcbiAqIC8vIOKGkiB7IGxvY2FsU3RhZ2VJZDogJ2V4ZWN1dGUtdG9vbC1jYWxscycsIHN1YmZsb3dQYXRoOiAnc2YtdG9vbHMnIH1cbiAqXG4gKiBzcGxpdFN0YWdlSWQoJ2V4ZWN1dGUtdG9vbC1jYWxscycpXG4gKiAvLyDihpIgeyBsb2NhbFN0YWdlSWQ6ICdleGVjdXRlLXRvb2wtY2FsbHMnLCBzdWJmbG93UGF0aDogdW5kZWZpbmVkIH1cbiAqXG4gKiBzcGxpdFN0YWdlSWQoJ3NmLW91dGVyL3NmLWlubmVyL3ZhbGlkYXRlJylcbiAqIC8vIOKGkiB7IGxvY2FsU3RhZ2VJZDogJ3ZhbGlkYXRlJywgc3ViZmxvd1BhdGg6ICdzZi1vdXRlci9zZi1pbm5lcicgfVxuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRTdGFnZUlkKHByZWZpeGVkU3RhZ2VJZDogc3RyaW5nKToge1xuICBsb2NhbFN0YWdlSWQ6IHN0cmluZztcbiAgc3ViZmxvd1BhdGg6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn0ge1xuICBjb25zdCBsYXN0U2xhc2ggPSBwcmVmaXhlZFN0YWdlSWQubGFzdEluZGV4T2YoJy8nKTtcbiAgaWYgKGxhc3RTbGFzaCA9PT0gLTEpIHtcbiAgICByZXR1cm4geyBsb2NhbFN0YWdlSWQ6IHByZWZpeGVkU3RhZ2VJZCwgc3ViZmxvd1BhdGg6IHVuZGVmaW5lZCB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgbG9jYWxTdGFnZUlkOiBwcmVmaXhlZFN0YWdlSWQuc2xpY2UobGFzdFNsYXNoICsgMSksXG4gICAgc3ViZmxvd1BhdGg6IHByZWZpeGVkU3RhZ2VJZC5zbGljZSgwLCBsYXN0U2xhc2gpLFxuICB9O1xufVxuXG4vKipcbiAqIFNoYXJlZCBtdXRhYmxlIGNvdW50ZXIgZm9yIGV4ZWN1dGlvbiBpbmRleC5cbiAqIFBhc3NlZCBieSByZWZlcmVuY2UgdG8gY2hpbGQgdHJhdmVyc2VycyAoc3ViZmxvd3MpIHNvIHRoZXlcbiAqIGNvbnRpbnVlIHRoZSBnbG9iYWwgbnVtYmVyaW5nIGluc3RlYWQgb2YgcmVzdGFydGluZyBhdCAwLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEV4ZWN1dGlvbkNvdW50ZXIge1xuICB2YWx1ZTogbnVtYmVyO1xufVxuXG4vKiogQ3JlYXRlIGEgbmV3IGV4ZWN1dGlvbiBjb3VudGVyIHN0YXJ0aW5nIGF0IDAuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXhlY3V0aW9uQ291bnRlcigpOiBFeGVjdXRpb25Db3VudGVyIHtcbiAgcmV0dXJuIHsgdmFsdWU6IDAgfTtcbn1cbiJdfQ==