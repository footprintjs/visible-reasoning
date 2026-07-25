/**
 * NodeResolver — DFS node lookup + subflow reference resolution.
 *
 * Responsibilities:
 * - Find nodes by ID via recursive depth-first search (for back-edge/loop support)
 * - Resolve subflow reference nodes to actual subflow structures
 * - Evaluate deciders to determine next node in branching scenarios
 */
export class NodeResolver {
    deps;
    nodeIdMap;
    getEffectiveChildren;
    constructor(deps, nodeIdMap, 
    /**
     * Overlay-aware children accessor injected by the traverser. The DFS
     * fallback resolves loop targets against the LIVE runtime shape — a node
     * patched by a dynamic StageNode return carries its children in the
     * traverser-local overlay, not on the shared built-chart node.
     */
    getEffectiveChildren) {
        this.deps = deps;
        this.nodeIdMap = nodeIdMap ?? new Map();
        this.getEffectiveChildren = getEffectiveChildren;
    }
    /**
     * O(1) node lookup via pre-built ID map.
     * Falls back to DFS from startNode (for dynamic nodes added at runtime
     * or subflow-local lookups that use an explicit startNode).
     */
    findNodeById(nodeId, startNode) {
        // Fast path: O(1) map lookup (only valid for root-level graph, not subflow-local)
        if (!startNode) {
            const mapped = this.nodeIdMap.get(nodeId);
            if (mapped)
                return mapped;
        }
        // Fallback: DFS from startNode (subflow-local or dynamic nodes not in the map)
        return this._dfs(nodeId, startNode ?? this.deps.root);
    }
    /**
     * DFS search for a node by ID.
     * Used as fallback when the node is not in the pre-built map.
     */
    _dfs(nodeId, node) {
        if (node.id === nodeId)
            return node;
        const children = this.getEffectiveChildren ? this.getEffectiveChildren(node) : node.children;
        if (children) {
            for (const child of children) {
                const found = this._dfs(nodeId, child);
                if (found)
                    return found;
            }
        }
        if (node.next) {
            const found = this._dfs(nodeId, node.next);
            if (found)
                return found;
        }
        return undefined;
    }
    /**
     * Resolve a subflow reference node to its actual structure.
     *
     * Reference nodes are lightweight placeholders (isSubflowRoot but no fn/children).
     * The actual structure lives in the subflows dictionary.
     */
    resolveSubflowReference(node) {
        // Already has structure — not a reference
        if (node.fn || (node.children && node.children.length > 0))
            return node;
        if (!this.deps.subflows)
            return node;
        // Try multiple keys in order of preference
        const keysToTry = [node.subflowId, node.subflowName, node.name].filter(Boolean);
        let subflowDef;
        for (const key of keysToTry) {
            if (this.deps.subflows[key]) {
                subflowDef = this.deps.subflows[key];
                break;
            }
        }
        if (!subflowDef) {
            this.deps.logger.info(`Subflow not found in dictionary for node '${node.name}' (tried keys: ${keysToTry.join(', ')})`);
            return node;
        }
        // Merge reference metadata with actual structure.
        // id comes from the inner root (the actual stage identity for trace matching),
        // not the mount node (which is the subflow entry point in the parent).
        return {
            ...subflowDef.root,
            isSubflowRoot: node.isSubflowRoot,
            subflowId: node.subflowId,
            subflowName: node.subflowName,
            id: subflowDef.root.id || node.id,
            subflowMountOptions: node.subflowMountOptions || subflowDef.root.subflowMountOptions,
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVJlc29sdmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvTm9kZVJlc29sdmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7O0dBT0c7QUFNSCxNQUFNLE9BQU8sWUFBWTtJQUtiO0lBSk8sU0FBUyxDQUF1QztJQUNoRCxvQkFBb0IsQ0FBNEU7SUFFakgsWUFDVSxJQUErQixFQUN2QyxTQUFnRDtJQUNoRDs7Ozs7T0FLRztJQUNILG9CQUErRjtRQVJ2RixTQUFJLEdBQUosSUFBSSxDQUEyQjtRQVV2QyxJQUFJLENBQUMsU0FBUyxHQUFHLFNBQVMsSUFBSSxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ3hDLElBQUksQ0FBQyxvQkFBb0IsR0FBRyxvQkFBb0IsQ0FBQztJQUNuRCxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILFlBQVksQ0FBQyxNQUFjLEVBQUUsU0FBbUM7UUFDOUQsa0ZBQWtGO1FBQ2xGLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUNmLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQzFDLElBQUksTUFBTTtnQkFBRSxPQUFPLE1BQU0sQ0FBQztRQUM1QixDQUFDO1FBRUQsK0VBQStFO1FBQy9FLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsU0FBUyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDeEQsQ0FBQztJQUVEOzs7T0FHRztJQUNLLElBQUksQ0FBQyxNQUFjLEVBQUUsSUFBNkI7UUFDeEQsSUFBSSxJQUFJLENBQUMsRUFBRSxLQUFLLE1BQU07WUFBRSxPQUFPLElBQUksQ0FBQztRQUVwQyxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQztRQUM3RixJQUFJLFFBQVEsRUFBRSxDQUFDO1lBQ2IsS0FBSyxNQUFNLEtBQUssSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDN0IsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7Z0JBQ3ZDLElBQUksS0FBSztvQkFBRSxPQUFPLEtBQUssQ0FBQztZQUMxQixDQUFDO1FBQ0gsQ0FBQztRQUVELElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2QsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzNDLElBQUksS0FBSztnQkFBRSxPQUFPLEtBQUssQ0FBQztRQUMxQixDQUFDO1FBRUQsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0gsdUJBQXVCLENBQUMsSUFBNkI7UUFDbkQsMENBQTBDO1FBQzFDLElBQUksSUFBSSxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFFeEUsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBRXJDLDJDQUEyQztRQUMzQyxNQUFNLFNBQVMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBYSxDQUFDO1FBQzVGLElBQUksVUFBeUQsQ0FBQztRQUU5RCxLQUFLLE1BQU0sR0FBRyxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQzVCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDNUIsVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQyxNQUFNO1lBQ1IsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDaEIsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUNuQiw2Q0FBNkMsSUFBSSxDQUFDLElBQUksa0JBQWtCLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FDaEcsQ0FBQztZQUNGLE9BQU8sSUFBSSxDQUFDO1FBQ2QsQ0FBQztRQUVELGtEQUFrRDtRQUNsRCwrRUFBK0U7UUFDL0UsdUVBQXVFO1FBQ3ZFLE9BQU87WUFDTCxHQUFHLFVBQVUsQ0FBQyxJQUFJO1lBQ2xCLGFBQWEsRUFBRSxJQUFJLENBQUMsYUFBYTtZQUNqQyxTQUFTLEVBQUUsSUFBSSxDQUFDLFNBQVM7WUFDekIsV0FBVyxFQUFFLElBQUksQ0FBQyxXQUFXO1lBQzdCLEVBQUUsRUFBRSxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxJQUFJLENBQUMsRUFBRTtZQUNqQyxtQkFBbUIsRUFBRSxJQUFJLENBQUMsbUJBQW1CLElBQUksVUFBVSxDQUFDLElBQUksQ0FBQyxtQkFBbUI7U0FDckYsQ0FBQztJQUNKLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTm9kZVJlc29sdmVyIOKAlCBERlMgbm9kZSBsb29rdXAgKyBzdWJmbG93IHJlZmVyZW5jZSByZXNvbHV0aW9uLlxuICpcbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAtIEZpbmQgbm9kZXMgYnkgSUQgdmlhIHJlY3Vyc2l2ZSBkZXB0aC1maXJzdCBzZWFyY2ggKGZvciBiYWNrLWVkZ2UvbG9vcCBzdXBwb3J0KVxuICogLSBSZXNvbHZlIHN1YmZsb3cgcmVmZXJlbmNlIG5vZGVzIHRvIGFjdHVhbCBzdWJmbG93IHN0cnVjdHVyZXNcbiAqIC0gRXZhbHVhdGUgZGVjaWRlcnMgdG8gZGV0ZXJtaW5lIG5leHQgbm9kZSBpbiBicmFuY2hpbmcgc2NlbmFyaW9zXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi8uLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB0eXBlIHsgU3RhZ2VOb2RlIH0gZnJvbSAnLi4vZ3JhcGgvU3RhZ2VOb2RlLmpzJztcbmltcG9ydCB0eXBlIHsgSGFuZGxlckRlcHMgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBOb2RlUmVzb2x2ZXI8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgbm9kZUlkTWFwOiBNYXA8c3RyaW5nLCBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPj47XG4gIHByaXZhdGUgcmVhZG9ubHkgZ2V0RWZmZWN0aXZlQ2hpbGRyZW4/OiAobm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pID0+IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+W10gfCB1bmRlZmluZWQ7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSBkZXBzOiBIYW5kbGVyRGVwczxUT3V0LCBUU2NvcGU+LFxuICAgIG5vZGVJZE1hcD86IE1hcDxzdHJpbmcsIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+PixcbiAgICAvKipcbiAgICAgKiBPdmVybGF5LWF3YXJlIGNoaWxkcmVuIGFjY2Vzc29yIGluamVjdGVkIGJ5IHRoZSB0cmF2ZXJzZXIuIFRoZSBERlNcbiAgICAgKiBmYWxsYmFjayByZXNvbHZlcyBsb29wIHRhcmdldHMgYWdhaW5zdCB0aGUgTElWRSBydW50aW1lIHNoYXBlIOKAlCBhIG5vZGVcbiAgICAgKiBwYXRjaGVkIGJ5IGEgZHluYW1pYyBTdGFnZU5vZGUgcmV0dXJuIGNhcnJpZXMgaXRzIGNoaWxkcmVuIGluIHRoZVxuICAgICAqIHRyYXZlcnNlci1sb2NhbCBvdmVybGF5LCBub3Qgb24gdGhlIHNoYXJlZCBidWlsdC1jaGFydCBub2RlLlxuICAgICAqL1xuICAgIGdldEVmZmVjdGl2ZUNoaWxkcmVuPzogKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KSA9PiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPltdIHwgdW5kZWZpbmVkLFxuICApIHtcbiAgICB0aGlzLm5vZGVJZE1hcCA9IG5vZGVJZE1hcCA/PyBuZXcgTWFwKCk7XG4gICAgdGhpcy5nZXRFZmZlY3RpdmVDaGlsZHJlbiA9IGdldEVmZmVjdGl2ZUNoaWxkcmVuO1xuICB9XG5cbiAgLyoqXG4gICAqIE8oMSkgbm9kZSBsb29rdXAgdmlhIHByZS1idWlsdCBJRCBtYXAuXG4gICAqIEZhbGxzIGJhY2sgdG8gREZTIGZyb20gc3RhcnROb2RlIChmb3IgZHluYW1pYyBub2RlcyBhZGRlZCBhdCBydW50aW1lXG4gICAqIG9yIHN1YmZsb3ctbG9jYWwgbG9va3VwcyB0aGF0IHVzZSBhbiBleHBsaWNpdCBzdGFydE5vZGUpLlxuICAgKi9cbiAgZmluZE5vZGVCeUlkKG5vZGVJZDogc3RyaW5nLCBzdGFydE5vZGU/OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICAvLyBGYXN0IHBhdGg6IE8oMSkgbWFwIGxvb2t1cCAob25seSB2YWxpZCBmb3Igcm9vdC1sZXZlbCBncmFwaCwgbm90IHN1YmZsb3ctbG9jYWwpXG4gICAgaWYgKCFzdGFydE5vZGUpIHtcbiAgICAgIGNvbnN0IG1hcHBlZCA9IHRoaXMubm9kZUlkTWFwLmdldChub2RlSWQpO1xuICAgICAgaWYgKG1hcHBlZCkgcmV0dXJuIG1hcHBlZDtcbiAgICB9XG5cbiAgICAvLyBGYWxsYmFjazogREZTIGZyb20gc3RhcnROb2RlIChzdWJmbG93LWxvY2FsIG9yIGR5bmFtaWMgbm9kZXMgbm90IGluIHRoZSBtYXApXG4gICAgcmV0dXJuIHRoaXMuX2Rmcyhub2RlSWQsIHN0YXJ0Tm9kZSA/PyB0aGlzLmRlcHMucm9vdCk7XG4gIH1cblxuICAvKipcbiAgICogREZTIHNlYXJjaCBmb3IgYSBub2RlIGJ5IElELlxuICAgKiBVc2VkIGFzIGZhbGxiYWNrIHdoZW4gdGhlIG5vZGUgaXMgbm90IGluIHRoZSBwcmUtYnVpbHQgbWFwLlxuICAgKi9cbiAgcHJpdmF0ZSBfZGZzKG5vZGVJZDogc3RyaW5nLCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICBpZiAobm9kZS5pZCA9PT0gbm9kZUlkKSByZXR1cm4gbm9kZTtcblxuICAgIGNvbnN0IGNoaWxkcmVuID0gdGhpcy5nZXRFZmZlY3RpdmVDaGlsZHJlbiA/IHRoaXMuZ2V0RWZmZWN0aXZlQ2hpbGRyZW4obm9kZSkgOiBub2RlLmNoaWxkcmVuO1xuICAgIGlmIChjaGlsZHJlbikge1xuICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xuICAgICAgICBjb25zdCBmb3VuZCA9IHRoaXMuX2Rmcyhub2RlSWQsIGNoaWxkKTtcbiAgICAgICAgaWYgKGZvdW5kKSByZXR1cm4gZm91bmQ7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKG5vZGUubmV4dCkge1xuICAgICAgY29uc3QgZm91bmQgPSB0aGlzLl9kZnMobm9kZUlkLCBub2RlLm5leHQpO1xuICAgICAgaWYgKGZvdW5kKSByZXR1cm4gZm91bmQ7XG4gICAgfVxuXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIGEgc3ViZmxvdyByZWZlcmVuY2Ugbm9kZSB0byBpdHMgYWN0dWFsIHN0cnVjdHVyZS5cbiAgICpcbiAgICogUmVmZXJlbmNlIG5vZGVzIGFyZSBsaWdodHdlaWdodCBwbGFjZWhvbGRlcnMgKGlzU3ViZmxvd1Jvb3QgYnV0IG5vIGZuL2NoaWxkcmVuKS5cbiAgICogVGhlIGFjdHVhbCBzdHJ1Y3R1cmUgbGl2ZXMgaW4gdGhlIHN1YmZsb3dzIGRpY3Rpb25hcnkuXG4gICAqL1xuICByZXNvbHZlU3ViZmxvd1JlZmVyZW5jZShub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHtcbiAgICAvLyBBbHJlYWR5IGhhcyBzdHJ1Y3R1cmUg4oCUIG5vdCBhIHJlZmVyZW5jZVxuICAgIGlmIChub2RlLmZuIHx8IChub2RlLmNoaWxkcmVuICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCkpIHJldHVybiBub2RlO1xuXG4gICAgaWYgKCF0aGlzLmRlcHMuc3ViZmxvd3MpIHJldHVybiBub2RlO1xuXG4gICAgLy8gVHJ5IG11bHRpcGxlIGtleXMgaW4gb3JkZXIgb2YgcHJlZmVyZW5jZVxuICAgIGNvbnN0IGtleXNUb1RyeSA9IFtub2RlLnN1YmZsb3dJZCwgbm9kZS5zdWJmbG93TmFtZSwgbm9kZS5uYW1lXS5maWx0ZXIoQm9vbGVhbikgYXMgc3RyaW5nW107XG4gICAgbGV0IHN1YmZsb3dEZWY6IHsgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfSB8IHVuZGVmaW5lZDtcblxuICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXNUb1RyeSkge1xuICAgICAgaWYgKHRoaXMuZGVwcy5zdWJmbG93c1trZXldKSB7XG4gICAgICAgIHN1YmZsb3dEZWYgPSB0aGlzLmRlcHMuc3ViZmxvd3Nba2V5XTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFzdWJmbG93RGVmKSB7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmluZm8oXG4gICAgICAgIGBTdWJmbG93IG5vdCBmb3VuZCBpbiBkaWN0aW9uYXJ5IGZvciBub2RlICcke25vZGUubmFtZX0nICh0cmllZCBrZXlzOiAke2tleXNUb1RyeS5qb2luKCcsICcpfSlgLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBub2RlO1xuICAgIH1cblxuICAgIC8vIE1lcmdlIHJlZmVyZW5jZSBtZXRhZGF0YSB3aXRoIGFjdHVhbCBzdHJ1Y3R1cmUuXG4gICAgLy8gaWQgY29tZXMgZnJvbSB0aGUgaW5uZXIgcm9vdCAodGhlIGFjdHVhbCBzdGFnZSBpZGVudGl0eSBmb3IgdHJhY2UgbWF0Y2hpbmcpLFxuICAgIC8vIG5vdCB0aGUgbW91bnQgbm9kZSAod2hpY2ggaXMgdGhlIHN1YmZsb3cgZW50cnkgcG9pbnQgaW4gdGhlIHBhcmVudCkuXG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLnN1YmZsb3dEZWYucm9vdCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IG5vZGUuaXNTdWJmbG93Um9vdCxcbiAgICAgIHN1YmZsb3dJZDogbm9kZS5zdWJmbG93SWQsXG4gICAgICBzdWJmbG93TmFtZTogbm9kZS5zdWJmbG93TmFtZSxcbiAgICAgIGlkOiBzdWJmbG93RGVmLnJvb3QuaWQgfHwgbm9kZS5pZCxcbiAgICAgIHN1YmZsb3dNb3VudE9wdGlvbnM6IG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyB8fCBzdWJmbG93RGVmLnJvb3Quc3ViZmxvd01vdW50T3B0aW9ucyxcbiAgICB9O1xuICB9XG59XG4iXX0=