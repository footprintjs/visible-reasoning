/**
 * walkSubflowSpec — yield the structural shape of a subflow spec as a
 * flat ordered stream of items, with `subflowPath` already composed
 * for nested subflows.
 *
 * This is the public contract for traversing the structure delivered
 * via `StructureSubflowMountedEvent.subflowSpec`. Item shapes mirror
 * the corresponding Structure event payloads so consumers can route
 * walker items through the same handlers they use for live events.
 *
 * Walker contract (LOCKED):
 *   1. AUTO-RECURSE by default into nested subflows, with composed
 *      paths (`parent/child/...`). Pass `{ recurse: false }` to walk
 *      only one level.
 *   2. ENTRY-STAGE MARKER FIRST: for each subflow (top-level and
 *      nested), yields a `{ kind: 'subflow-start', ... }` item BEFORE
 *      any stage/edge items from that subflow. Lets consumers draw the
 *      boundary edge from the mount node to the entry stage.
 *   3. COMPOSED PATHS: nested subflows get `parentPath + '/' + localId`.
 *      Top-level mount paths are local-only (`'auth'`, NOT `'__root__/auth'`).
 *   4. SHAPE MIRRORING: stage/edge/loop items have the same payload
 *      shape as Structure events, with `subflowPath` added.
 *   5. SOURCE DISCRIMINATOR: every walker item carries `source: 'walker'`
 *      (Structure events do NOT). Lets consumers distinguish event vs
 *      walker in logs/debuggers while still sharing handler code paths.
 *   6. STAGE-ID PREFIXING: stage IDs in nested subflows are already
 *      prefixed by the spec (e.g. `'auth/verify/check'`). Walker
 *      preserves this; `subflowPath` field is redundant-but-explicit.
 */
/**
 * Walk a subflow spec, yielding its structure as flat ordered items.
 *
 * @example
 * ```ts
 * import { walkSubflowSpec } from 'footprintjs/trace';
 *
 * onSubflowMounted(event) {
 *   if (!event.subflowSpec) return; // lazy mount — no spec yet
 *   for (const item of walkSubflowSpec(event.subflowSpec, event.subflowPath)) {
 *     switch (item.kind) {
 *       case 'subflow-start': break;        // entry boundary
 *       case 'stage':         break;        // inner stage
 *       case 'edge':          break;        // inner edge
 *       case 'loop':          break;        // inner loop back-edge
 *       case 'subflow':       break;        // nested mount marker
 *     }
 *   }
 * }
 * ```
 */
export function* walkSubflowSpec(spec, subflowPath, options = {}) {
    const recurse = options.recurse !== false;
    // Entry marker first — consumer draws the boundary edge from this.
    yield {
        kind: 'subflow-start',
        stageId: spec.id,
        subflowPath,
        source: 'walker',
    };
    yield* walkNode(spec, subflowPath, recurse, new Set());
}
function* walkNode(node, subflowPath, recurse, visited) {
    if (visited.has(node.id))
        return;
    visited.add(node.id);
    // Loop reference — yield as a loop edge from previous-in-context to
    // the target; the caller (caller of walkNode for the parent) is
    // responsible for emitting the loop edge with the correct `from`.
    // We never re-yield a stage for a loop reference.
    if (node.isLoopReference)
        return;
    // Nested subflow mount — yield the marker, optionally recurse.
    if (node.isSubflowRoot && node.subflowId !== undefined) {
        const nestedPath = `${subflowPath}/${node.subflowId}`;
        const nestedSpec = node.subflowStructure;
        if (nestedSpec) {
            yield {
                kind: 'subflow',
                mountStageId: node.id,
                subflowId: node.subflowId,
                subflowName: node.subflowName ?? node.subflowId,
                subflowSpec: nestedSpec,
                subflowPath: nestedPath,
                source: 'walker',
            };
            if (recurse) {
                yield* walkSubflowSpec(nestedSpec, nestedPath, { recurse });
            }
            // Fall through to next/children — the mount node still has a
            // mount-side stage representation that may have outgoing edges.
        }
    }
    // Yield the stage itself.
    yield {
        kind: 'stage',
        stageId: node.id,
        name: node.name,
        type: node.type,
        ...(node.isPausable === true && { isPausable: true }),
        spec: node,
        subflowPath,
        source: 'walker',
    };
    // A FAN-OUT (selector/fork) — every branch runs, then the node's `next`
    // runs (the join). This is engine semantics, so we always render the true
    // topology: each branch → that join, and the node's own direct → next
    // "skip" edge suppressed (flow goes fork → branches → join, never fork →
    // join directly). Deciders (ONE branch chosen, branches genuinely diverge)
    // are NOT fan-outs and are left alone. `next` must be a real stage (not a
    // loop back-edge).
    const isFanOut = node.type === 'fork' || node.hasSelector === true;
    const fanOutJoinId = isFanOut && node.next && node.next.isLoopReference !== true ? node.next.id : undefined;
    // Children (decider/selector/fork branches).
    if (node.children && node.children.length > 0) {
        const edgeKind = node.type === 'fork' ? 'fork-branch' : 'decision-branch';
        for (const child of node.children) {
            yield {
                kind: 'edge',
                from: node.id,
                to: child.id,
                edgeKind,
                ...(edgeKind === 'decision-branch' && child.id !== undefined && { label: child.id }),
                subflowPath,
                source: 'walker',
            };
            // Convergence edge: this branch merges into the fan-out's join stage.
            if (fanOutJoinId !== undefined) {
                yield {
                    kind: 'edge',
                    from: child.id,
                    to: fanOutJoinId,
                    edgeKind: 'next',
                    subflowPath,
                    source: 'walker',
                };
            }
            yield* walkNode(child, subflowPath, recurse, visited);
        }
    }
    // Linear next.
    if (node.next) {
        if (node.next.isLoopReference && node.loopTarget) {
            yield {
                kind: 'loop',
                from: node.id,
                to: node.loopTarget,
                subflowPath,
                source: 'walker',
            };
        }
        else {
            // Suppress the direct node → next edge when the branches already carry
            // the convergence to it (fanOutJoinId); still walk next so it's emitted.
            if (fanOutJoinId === undefined) {
                yield {
                    kind: 'edge',
                    from: node.id,
                    to: node.next.id,
                    edgeKind: 'next',
                    subflowPath,
                    source: 'walker',
                };
            }
            yield* walkNode(node.next, subflowPath, recurse, visited);
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Fsa1N1YmZsb3dTcGVjLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvd2Fsa1N1YmZsb3dTcGVjLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBNEJHO0FBc0RIOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW9CRztBQUNILE1BQU0sU0FBUyxDQUFDLENBQUMsZUFBZSxDQUM5QixJQUFpQyxFQUNqQyxXQUFtQixFQUNuQixVQUF5QixFQUFFO0lBRTNCLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxPQUFPLEtBQUssS0FBSyxDQUFDO0lBRTFDLG1FQUFtRTtJQUNuRSxNQUFNO1FBQ0osSUFBSSxFQUFFLGVBQWU7UUFDckIsT0FBTyxFQUFFLElBQUksQ0FBQyxFQUFFO1FBQ2hCLFdBQVc7UUFDWCxNQUFNLEVBQUUsUUFBUTtLQUNqQixDQUFDO0lBRUYsS0FBSyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLElBQUksR0FBRyxFQUFVLENBQUMsQ0FBQztBQUNqRSxDQUFDO0FBRUQsUUFBUSxDQUFDLENBQUMsUUFBUSxDQUNoQixJQUFpQyxFQUNqQyxXQUFtQixFQUNuQixPQUFnQixFQUNoQixPQUFvQjtJQUVwQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUFFLE9BQU87SUFDakMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFFckIsb0VBQW9FO0lBQ3BFLGdFQUFnRTtJQUNoRSxrRUFBa0U7SUFDbEUsa0RBQWtEO0lBQ2xELElBQUksSUFBSSxDQUFDLGVBQWU7UUFBRSxPQUFPO0lBRWpDLCtEQUErRDtJQUMvRCxJQUFJLElBQUksQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDLFNBQVMsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUN2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O1lBQ0QsS0FBSyxDQUFDLENBQUMsUUFBUSxDQUFDLEtBQUssRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBQ3hELENBQUM7SUFDSCxDQUFDO0lBRUQsZUFBZTtJQUNmLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2QsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDakQsTUFBTTtnQkFDSixJQUFJLEVBQUUsTUFBTTtnQkFDWixJQUFJLEVBQUUsSUFBSSxDQUFDLEVBQUU7Z0JBQ2IsRUFBRSxFQUFFLElBQUksQ0FBQyxVQUFVO2dCQUNuQixXQUFXO2dCQUNYLE1BQU0sRUFBRSxRQUFRO2FBQ2pCLENBQUM7UUFDSixDQUFDO2FBQU0sQ0FBQztZQUNOLHVFQUF1RTtZQUN2RSx5RUFBeUU7WUFDekUsSUFBSSxZQUFZLEtBQUssU0FBUyxFQUFFLENBQUM7Z0JBQy9CLE1BQU07b0JBQ0osSUFBSSxFQUFFLE1BQU07b0JBQ1osSUFBSSxFQUFFLElBQUksQ0FBQyxFQUFFO29CQUNiLEVBQUUsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUU7b0JBQ2hCLFFBQVEsRUFBRSxNQUFNO29CQUNoQixXQUFXO29CQUNYLE1BQU0sRUFBRSxRQUFRO2lCQUNqQixDQUFDO1lBQ0osQ0FBQztZQUNELEtBQUssQ0FBQyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDNUQsQ0FBQztJQUNILENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiB3YWxrU3ViZmxvd1NwZWMg4oCUIHlpZWxkIHRoZSBzdHJ1Y3R1cmFsIHNoYXBlIG9mIGEgc3ViZmxvdyBzcGVjIGFzIGFcbiAqIGZsYXQgb3JkZXJlZCBzdHJlYW0gb2YgaXRlbXMsIHdpdGggYHN1YmZsb3dQYXRoYCBhbHJlYWR5IGNvbXBvc2VkXG4gKiBmb3IgbmVzdGVkIHN1YmZsb3dzLlxuICpcbiAqIFRoaXMgaXMgdGhlIHB1YmxpYyBjb250cmFjdCBmb3IgdHJhdmVyc2luZyB0aGUgc3RydWN0dXJlIGRlbGl2ZXJlZFxuICogdmlhIGBTdHJ1Y3R1cmVTdWJmbG93TW91bnRlZEV2ZW50LnN1YmZsb3dTcGVjYC4gSXRlbSBzaGFwZXMgbWlycm9yXG4gKiB0aGUgY29ycmVzcG9uZGluZyBTdHJ1Y3R1cmUgZXZlbnQgcGF5bG9hZHMgc28gY29uc3VtZXJzIGNhbiByb3V0ZVxuICogd2Fsa2VyIGl0ZW1zIHRocm91Z2ggdGhlIHNhbWUgaGFuZGxlcnMgdGhleSB1c2UgZm9yIGxpdmUgZXZlbnRzLlxuICpcbiAqIFdhbGtlciBjb250cmFjdCAoTE9DS0VEKTpcbiAqICAgMS4gQVVUTy1SRUNVUlNFIGJ5IGRlZmF1bHQgaW50byBuZXN0ZWQgc3ViZmxvd3MsIHdpdGggY29tcG9zZWRcbiAqICAgICAgcGF0aHMgKGBwYXJlbnQvY2hpbGQvLi4uYCkuIFBhc3MgYHsgcmVjdXJzZTogZmFsc2UgfWAgdG8gd2Fsa1xuICogICAgICBvbmx5IG9uZSBsZXZlbC5cbiAqICAgMi4gRU5UUlktU1RBR0UgTUFSS0VSIEZJUlNUOiBmb3IgZWFjaCBzdWJmbG93ICh0b3AtbGV2ZWwgYW5kXG4gKiAgICAgIG5lc3RlZCksIHlpZWxkcyBhIGB7IGtpbmQ6ICdzdWJmbG93LXN0YXJ0JywgLi4uIH1gIGl0ZW0gQkVGT1JFXG4gKiAgICAgIGFueSBzdGFnZS9lZGdlIGl0ZW1zIGZyb20gdGhhdCBzdWJmbG93LiBMZXRzIGNvbnN1bWVycyBkcmF3IHRoZVxuICogICAgICBib3VuZGFyeSBlZGdlIGZyb20gdGhlIG1vdW50IG5vZGUgdG8gdGhlIGVudHJ5IHN0YWdlLlxuICogICAzLiBDT01QT1NFRCBQQVRIUzogbmVzdGVkIHN1YmZsb3dzIGdldCBgcGFyZW50UGF0aCArICcvJyArIGxvY2FsSWRgLlxuICogICAgICBUb3AtbGV2ZWwgbW91bnQgcGF0aHMgYXJlIGxvY2FsLW9ubHkgKGAnYXV0aCdgLCBOT1QgYCdfX3Jvb3RfXy9hdXRoJ2ApLlxuICogICA0LiBTSEFQRSBNSVJST1JJTkc6IHN0YWdlL2VkZ2UvbG9vcCBpdGVtcyBoYXZlIHRoZSBzYW1lIHBheWxvYWRcbiAqICAgICAgc2hhcGUgYXMgU3RydWN0dXJlIGV2ZW50cywgd2l0aCBgc3ViZmxvd1BhdGhgIGFkZGVkLlxuICogICA1LiBTT1VSQ0UgRElTQ1JJTUlOQVRPUjogZXZlcnkgd2Fsa2VyIGl0ZW0gY2FycmllcyBgc291cmNlOiAnd2Fsa2VyJ2BcbiAqICAgICAgKFN0cnVjdHVyZSBldmVudHMgZG8gTk9UKS4gTGV0cyBjb25zdW1lcnMgZGlzdGluZ3Vpc2ggZXZlbnQgdnNcbiAqICAgICAgd2Fsa2VyIGluIGxvZ3MvZGVidWdnZXJzIHdoaWxlIHN0aWxsIHNoYXJpbmcgaGFuZGxlciBjb2RlIHBhdGhzLlxuICogICA2LiBTVEFHRS1JRCBQUkVGSVhJTkc6IHN0YWdlIElEcyBpbiBuZXN0ZWQgc3ViZmxvd3MgYXJlIGFscmVhZHlcbiAqICAgICAgcHJlZml4ZWQgYnkgdGhlIHNwZWMgKGUuZy4gYCdhdXRoL3ZlcmlmeS9jaGVjaydgKS4gV2Fsa2VyXG4gKiAgICAgIHByZXNlcnZlcyB0aGlzOyBgc3ViZmxvd1BhdGhgIGZpZWxkIGlzIHJlZHVuZGFudC1idXQtZXhwbGljaXQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgfSBmcm9tICcuLi9idWlsZGVyL3R5cGVzLmpzJztcblxuZXhwb3J0IGludGVyZmFjZSBXYWxrZXJPcHRpb25zIHtcbiAgLyoqIEF1dG8tcmVjdXJzZSBpbnRvIG5lc3RlZCBzdWJmbG93cyAoZGVmYXVsdDogdHJ1ZSkuIFdoZW4gZmFsc2UsXG4gICAqICBuZXN0ZWQgc3ViZmxvdyBpdGVtcyBhcmUgeWllbGRlZCBidXQgdGhlaXIgaW50ZXJuYWxzIGFyZSBub3RcbiAgICogIHRyYXZlcnNlZC4gKi9cbiAgcmVjdXJzZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIFdhbGtlckl0ZW0gPVxuICB8IHtcbiAgICAgIGtpbmQ6ICdzdWJmbG93LXN0YXJ0JztcbiAgICAgIHN0YWdlSWQ6IHN0cmluZztcbiAgICAgIHN1YmZsb3dQYXRoOiBzdHJpbmc7XG4gICAgICBzb3VyY2U6ICd3YWxrZXInO1xuICAgIH1cbiAgfCB7XG4gICAgICBraW5kOiAnc3RhZ2UnO1xuICAgICAgc3RhZ2VJZDogc3RyaW5nO1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgdHlwZTogTm9uTnVsbGFibGU8U2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlWyd0eXBlJ10+O1xuICAgICAgaXNQYXVzYWJsZT86IGJvb2xlYW47XG4gICAgICBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gICAgICBzdWJmbG93UGF0aDogc3RyaW5nO1xuICAgICAgc291cmNlOiAnd2Fsa2VyJztcbiAgICB9XG4gIHwge1xuICAgICAga2luZDogJ2VkZ2UnO1xuICAgICAgZnJvbTogc3RyaW5nO1xuICAgICAgdG86IHN0cmluZztcbiAgICAgIGVkZ2VLaW5kOiAnbmV4dCcgfCAnZm9yay1icmFuY2gnIHwgJ2RlY2lzaW9uLWJyYW5jaCc7XG4gICAgICBsYWJlbD86IHN0cmluZztcbiAgICAgIHN1YmZsb3dQYXRoOiBzdHJpbmc7XG4gICAgICBzb3VyY2U6ICd3YWxrZXInO1xuICAgIH1cbiAgfCB7XG4gICAgICBraW5kOiAnbG9vcCc7XG4gICAgICBmcm9tOiBzdHJpbmc7XG4gICAgICB0bzogc3RyaW5nO1xuICAgICAgc3ViZmxvd1BhdGg6IHN0cmluZztcbiAgICAgIHNvdXJjZTogJ3dhbGtlcic7XG4gICAgfVxuICB8IHtcbiAgICAgIGtpbmQ6ICdzdWJmbG93JztcbiAgICAgIG1vdW50U3RhZ2VJZDogc3RyaW5nO1xuICAgICAgc3ViZmxvd0lkOiBzdHJpbmc7XG4gICAgICBzdWJmbG93TmFtZTogc3RyaW5nO1xuICAgICAgc3ViZmxvd1NwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgICAgIHN1YmZsb3dQYXRoOiBzdHJpbmc7XG4gICAgICBzb3VyY2U6ICd3YWxrZXInO1xuICAgIH07XG5cbi8qKlxuICogV2FsayBhIHN1YmZsb3cgc3BlYywgeWllbGRpbmcgaXRzIHN0cnVjdHVyZSBhcyBmbGF0IG9yZGVyZWQgaXRlbXMuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyB3YWxrU3ViZmxvd1NwZWMgfSBmcm9tICdmb290cHJpbnRqcy90cmFjZSc7XG4gKlxuICogb25TdWJmbG93TW91bnRlZChldmVudCkge1xuICogICBpZiAoIWV2ZW50LnN1YmZsb3dTcGVjKSByZXR1cm47IC8vIGxhenkgbW91bnQg4oCUIG5vIHNwZWMgeWV0XG4gKiAgIGZvciAoY29uc3QgaXRlbSBvZiB3YWxrU3ViZmxvd1NwZWMoZXZlbnQuc3ViZmxvd1NwZWMsIGV2ZW50LnN1YmZsb3dQYXRoKSkge1xuICogICAgIHN3aXRjaCAoaXRlbS5raW5kKSB7XG4gKiAgICAgICBjYXNlICdzdWJmbG93LXN0YXJ0JzogYnJlYWs7ICAgICAgICAvLyBlbnRyeSBib3VuZGFyeVxuICogICAgICAgY2FzZSAnc3RhZ2UnOiAgICAgICAgIGJyZWFrOyAgICAgICAgLy8gaW5uZXIgc3RhZ2VcbiAqICAgICAgIGNhc2UgJ2VkZ2UnOiAgICAgICAgICBicmVhazsgICAgICAgIC8vIGlubmVyIGVkZ2VcbiAqICAgICAgIGNhc2UgJ2xvb3AnOiAgICAgICAgICBicmVhazsgICAgICAgIC8vIGlubmVyIGxvb3AgYmFjay1lZGdlXG4gKiAgICAgICBjYXNlICdzdWJmbG93JzogICAgICAgYnJlYWs7ICAgICAgICAvLyBuZXN0ZWQgbW91bnQgbWFya2VyXG4gKiAgICAgfVxuICogICB9XG4gKiB9XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uKiB3YWxrU3ViZmxvd1NwZWMoXG4gIHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSxcbiAgc3ViZmxvd1BhdGg6IHN0cmluZyxcbiAgb3B0aW9uczogV2Fsa2VyT3B0aW9ucyA9IHt9LFxuKTogR2VuZXJhdG9yPFdhbGtlckl0ZW0sIHZvaWQsIHZvaWQ+IHtcbiAgY29uc3QgcmVjdXJzZSA9IG9wdGlvbnMucmVjdXJzZSAhPT0gZmFsc2U7XG5cbiAgLy8gRW50cnkgbWFya2VyIGZpcnN0IOKAlCBjb25zdW1lciBkcmF3cyB0aGUgYm91bmRhcnkgZWRnZSBmcm9tIHRoaXMuXG4gIHlpZWxkIHtcbiAgICBraW5kOiAnc3ViZmxvdy1zdGFydCcsXG4gICAgc3RhZ2VJZDogc3BlYy5pZCxcbiAgICBzdWJmbG93UGF0aCxcbiAgICBzb3VyY2U6ICd3YWxrZXInLFxuICB9O1xuXG4gIHlpZWxkKiB3YWxrTm9kZShzcGVjLCBzdWJmbG93UGF0aCwgcmVjdXJzZSwgbmV3IFNldDxzdHJpbmc+KCkpO1xufVxuXG5mdW5jdGlvbiogd2Fsa05vZGUoXG4gIG5vZGU6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSxcbiAgc3ViZmxvd1BhdGg6IHN0cmluZyxcbiAgcmVjdXJzZTogYm9vbGVhbixcbiAgdmlzaXRlZDogU2V0PHN0cmluZz4sXG4pOiBHZW5lcmF0b3I8V2Fsa2VySXRlbSwgdm9pZCwgdm9pZD4ge1xuICBpZiAodmlzaXRlZC5oYXMobm9kZS5pZCkpIHJldHVybjtcbiAgdmlzaXRlZC5hZGQobm9kZS5pZCk7XG5cbiAgLy8gTG9vcCByZWZlcmVuY2Ug4oCUIHlpZWxkIGFzIGEgbG9vcCBlZGdlIGZyb20gcHJldmlvdXMtaW4tY29udGV4dCB0b1xuICAvLyB0aGUgdGFyZ2V0OyB0aGUgY2FsbGVyIChjYWxsZXIgb2Ygd2Fsa05vZGUgZm9yIHRoZSBwYXJlbnQpIGlzXG4gIC8vIHJlc3BvbnNpYmxlIGZvciBlbWl0dGluZyB0aGUgbG9vcCBlZGdlIHdpdGggdGhlIGNvcnJlY3QgYGZyb21gLlxuICAvLyBXZSBuZXZlciByZS15aWVsZCBhIHN0YWdlIGZvciBhIGxvb3AgcmVmZXJlbmNlLlxuICBpZiAobm9kZS5pc0xvb3BSZWZlcmVuY2UpIHJldHVybjtcblxuICAvLyBOZXN0ZWQgc3ViZmxvdyBtb3VudCDigJQgeWllbGQgdGhlIG1hcmtlciwgb3B0aW9uYWxseSByZWN1cnNlLlxuICBpZiAobm9kZS5pc1N1YmZsb3dSb290ICYmIG5vZGUuc3ViZmxvd0lkICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBuZXN0ZWRQYXRoID0gYCR7c3ViZmxvd1BhdGh9LyR7bm9kZS5zdWJmbG93SWR9YDtcbiAgICBjb25zdCBuZXN0ZWRTcGVjID0gbm9kZS5zdWJmbG93U3RydWN0dXJlO1xuICAgIGlmIChuZXN0ZWRTcGVjKSB7XG4gICAgICB5aWVsZCB7XG4gICAgICAgIGtpbmQ6ICdzdWJmbG93JyxcbiAgICAgICAgbW91bnRTdGFnZUlkOiBub2RlLmlkLFxuICAgICAgICBzdWJmbG93SWQ6IG5vZGUuc3ViZmxvd0lkLFxuICAgICAgICBzdWJmbG93TmFtZTogbm9kZS5zdWJmbG93TmFtZSA/PyBub2RlLnN1YmZsb3dJZCxcbiAgICAgICAgc3ViZmxvd1NwZWM6IG5lc3RlZFNwZWMsXG4gICAgICAgIHN1YmZsb3dQYXRoOiBuZXN0ZWRQYXRoLFxuICAgICAgICBzb3VyY2U6ICd3YWxrZXInLFxuICAgICAgfTtcbiAgICAgIGlmIChyZWN1cnNlKSB7XG4gICAgICAgIHlpZWxkKiB3YWxrU3ViZmxvd1NwZWMobmVzdGVkU3BlYywgbmVzdGVkUGF0aCwgeyByZWN1cnNlIH0pO1xuICAgICAgfVxuICAgICAgLy8gRmFsbCB0aHJvdWdoIHRvIG5leHQvY2hpbGRyZW4g4oCUIHRoZSBtb3VudCBub2RlIHN0aWxsIGhhcyBhXG4gICAgICAvLyBtb3VudC1zaWRlIHN0YWdlIHJlcHJlc2VudGF0aW9uIHRoYXQgbWF5IGhhdmUgb3V0Z29pbmcgZWRnZXMuXG4gICAgfVxuICB9XG5cbiAgLy8gWWllbGQgdGhlIHN0YWdlIGl0c2VsZi5cbiAgeWllbGQge1xuICAgIGtpbmQ6ICdzdGFnZScsXG4gICAgc3RhZ2VJZDogbm9kZS5pZCxcbiAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgdHlwZTogbm9kZS50eXBlLFxuICAgIC4uLihub2RlLmlzUGF1c2FibGUgPT09IHRydWUgJiYgeyBpc1BhdXNhYmxlOiB0cnVlIH0pLFxuICAgIHNwZWM6IG5vZGUsXG4gICAgc3ViZmxvd1BhdGgsXG4gICAgc291cmNlOiAnd2Fsa2VyJyxcbiAgfTtcblxuICAvLyBBIEZBTi1PVVQgKHNlbGVjdG9yL2ZvcmspIOKAlCBldmVyeSBicmFuY2ggcnVucywgdGhlbiB0aGUgbm9kZSdzIGBuZXh0YFxuICAvLyBydW5zICh0aGUgam9pbikuIFRoaXMgaXMgZW5naW5lIHNlbWFudGljcywgc28gd2UgYWx3YXlzIHJlbmRlciB0aGUgdHJ1ZVxuICAvLyB0b3BvbG9neTogZWFjaCBicmFuY2gg4oaSIHRoYXQgam9pbiwgYW5kIHRoZSBub2RlJ3Mgb3duIGRpcmVjdCDihpIgbmV4dFxuICAvLyBcInNraXBcIiBlZGdlIHN1cHByZXNzZWQgKGZsb3cgZ29lcyBmb3JrIOKGkiBicmFuY2hlcyDihpIgam9pbiwgbmV2ZXIgZm9yayDihpJcbiAgLy8gam9pbiBkaXJlY3RseSkuIERlY2lkZXJzIChPTkUgYnJhbmNoIGNob3NlbiwgYnJhbmNoZXMgZ2VudWluZWx5IGRpdmVyZ2UpXG4gIC8vIGFyZSBOT1QgZmFuLW91dHMgYW5kIGFyZSBsZWZ0IGFsb25lLiBgbmV4dGAgbXVzdCBiZSBhIHJlYWwgc3RhZ2UgKG5vdCBhXG4gIC8vIGxvb3AgYmFjay1lZGdlKS5cbiAgY29uc3QgaXNGYW5PdXQgPSBub2RlLnR5cGUgPT09ICdmb3JrJyB8fCBub2RlLmhhc1NlbGVjdG9yID09PSB0cnVlO1xuICBjb25zdCBmYW5PdXRKb2luSWQgPSBpc0Zhbk91dCAmJiBub2RlLm5leHQgJiYgbm9kZS5uZXh0LmlzTG9vcFJlZmVyZW5jZSAhPT0gdHJ1ZSA/IG5vZGUubmV4dC5pZCA6IHVuZGVmaW5lZDtcblxuICAvLyBDaGlsZHJlbiAoZGVjaWRlci9zZWxlY3Rvci9mb3JrIGJyYW5jaGVzKS5cbiAgaWYgKG5vZGUuY2hpbGRyZW4gJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgZWRnZUtpbmQ6ICdmb3JrLWJyYW5jaCcgfCAnZGVjaXNpb24tYnJhbmNoJyA9IG5vZGUudHlwZSA9PT0gJ2ZvcmsnID8gJ2ZvcmstYnJhbmNoJyA6ICdkZWNpc2lvbi1icmFuY2gnO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikge1xuICAgICAgeWllbGQge1xuICAgICAgICBraW5kOiAnZWRnZScsXG4gICAgICAgIGZyb206IG5vZGUuaWQsXG4gICAgICAgIHRvOiBjaGlsZC5pZCxcbiAgICAgICAgZWRnZUtpbmQsXG4gICAgICAgIC4uLihlZGdlS2luZCA9PT0gJ2RlY2lzaW9uLWJyYW5jaCcgJiYgY2hpbGQuaWQgIT09IHVuZGVmaW5lZCAmJiB7IGxhYmVsOiBjaGlsZC5pZCB9KSxcbiAgICAgICAgc3ViZmxvd1BhdGgsXG4gICAgICAgIHNvdXJjZTogJ3dhbGtlcicsXG4gICAgICB9O1xuICAgICAgLy8gQ29udmVyZ2VuY2UgZWRnZTogdGhpcyBicmFuY2ggbWVyZ2VzIGludG8gdGhlIGZhbi1vdXQncyBqb2luIHN0YWdlLlxuICAgICAgaWYgKGZhbk91dEpvaW5JZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHlpZWxkIHtcbiAgICAgICAgICBraW5kOiAnZWRnZScsXG4gICAgICAgICAgZnJvbTogY2hpbGQuaWQsXG4gICAgICAgICAgdG86IGZhbk91dEpvaW5JZCxcbiAgICAgICAgICBlZGdlS2luZDogJ25leHQnLFxuICAgICAgICAgIHN1YmZsb3dQYXRoLFxuICAgICAgICAgIHNvdXJjZTogJ3dhbGtlcicsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICB5aWVsZCogd2Fsa05vZGUoY2hpbGQsIHN1YmZsb3dQYXRoLCByZWN1cnNlLCB2aXNpdGVkKTtcbiAgICB9XG4gIH1cblxuICAvLyBMaW5lYXIgbmV4dC5cbiAgaWYgKG5vZGUubmV4dCkge1xuICAgIGlmIChub2RlLm5leHQuaXNMb29wUmVmZXJlbmNlICYmIG5vZGUubG9vcFRhcmdldCkge1xuICAgICAgeWllbGQge1xuICAgICAgICBraW5kOiAnbG9vcCcsXG4gICAgICAgIGZyb206IG5vZGUuaWQsXG4gICAgICAgIHRvOiBub2RlLmxvb3BUYXJnZXQsXG4gICAgICAgIHN1YmZsb3dQYXRoLFxuICAgICAgICBzb3VyY2U6ICd3YWxrZXInLFxuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gU3VwcHJlc3MgdGhlIGRpcmVjdCBub2RlIOKGkiBuZXh0IGVkZ2Ugd2hlbiB0aGUgYnJhbmNoZXMgYWxyZWFkeSBjYXJyeVxuICAgICAgLy8gdGhlIGNvbnZlcmdlbmNlIHRvIGl0IChmYW5PdXRKb2luSWQpOyBzdGlsbCB3YWxrIG5leHQgc28gaXQncyBlbWl0dGVkLlxuICAgICAgaWYgKGZhbk91dEpvaW5JZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHlpZWxkIHtcbiAgICAgICAgICBraW5kOiAnZWRnZScsXG4gICAgICAgICAgZnJvbTogbm9kZS5pZCxcbiAgICAgICAgICB0bzogbm9kZS5uZXh0LmlkLFxuICAgICAgICAgIGVkZ2VLaW5kOiAnbmV4dCcsXG4gICAgICAgICAgc3ViZmxvd1BhdGgsXG4gICAgICAgICAgc291cmNlOiAnd2Fsa2VyJyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHlpZWxkKiB3YWxrTm9kZShub2RlLm5leHQsIHN1YmZsb3dQYXRoLCByZWN1cnNlLCB2aXNpdGVkKTtcbiAgICB9XG4gIH1cbn1cbiJdfQ==