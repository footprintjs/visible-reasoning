/**
 * ManifestFlowRecorder — Builds a lightweight subflow manifest during traversal.
 *
 * Collects subflow metadata (ID, name, description) as a side effect of
 * observing traversal events. Produces a tree structure suitable for LLM
 * navigation: lightweight enough to include in snapshots, with on-demand
 * access to full specs via getSpec().
 *
 * The manifest reflects only subflows that were actually entered during
 * execution — unvisited branches are not included.
 *
 * @example
 * ```typescript
 * const manifest = new ManifestFlowRecorder();
 * executor.attachFlowRecorder(manifest);
 * await executor.run({ input: data });
 *
 * // Lightweight tree of subflow IDs + descriptions
 * const tree = manifest.getManifest();
 *
 * // Full spec for a specific subflow (if available)
 * const spec = manifest.getSpec('sf-credit-check');
 * ```
 */
export class ManifestFlowRecorder {
    id;
    /** Stack tracks nesting depth — current subflow is top of stack. */
    stack = [];
    /** Root-level subflows (not nested inside another subflow). */
    roots = [];
    /** Full specs stored from dynamic registration events. */
    specs = new Map();
    constructor(id) {
        this.id = id ?? 'manifest';
    }
    onSubflowEntry(event) {
        const entry = {
            subflowId: event.subflowId ?? event.name,
            name: event.name,
            description: event.description,
            children: [],
        };
        this.stack.push(entry);
    }
    onSubflowExit(_event) {
        const completed = this.stack.pop();
        if (!completed)
            return;
        const parent = this.stack[this.stack.length - 1];
        if (parent) {
            parent.children.push(completed);
        }
        else {
            this.roots.push(completed);
        }
    }
    onSubflowRegistered(event) {
        if (event.specStructure && !this.specs.has(event.subflowId)) {
            this.specs.set(event.subflowId, event.specStructure);
        }
    }
    /** Returns the manifest tree — lightweight, suitable for snapshot inclusion. */
    getManifest() {
        return [...this.roots];
    }
    /**
     * Returns the full spec for a dynamically-registered subflow.
     * Only populated for subflows auto-registered at runtime (via StageNode
     * return with subflowDef). Statically-configured subflows are not included
     * even if they appear in getManifest(). Use FlowChart.buildTimeStructure
     * to access statically-defined subflow specs.
     */
    getSpec(subflowId) {
        return this.specs.get(subflowId);
    }
    /** Returns all stored spec IDs. */
    getSpecIds() {
        return Array.from(this.specs.keys());
    }
    toSnapshot() {
        return {
            name: 'Manifest',
            description: 'Translator (FlowRecorder) — subflow catalog built during traversal',
            preferredOperation: 'translate',
            data: this.getManifest(),
        };
    }
    /** Clears state for reuse. */
    clear() {
        this.stack = [];
        this.roots = [];
        this.specs.clear();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWFuaWZlc3RGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL01hbmlmZXN0Rmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVCRztBQWdCSCxNQUFNLE9BQU8sb0JBQW9CO0lBQ3RCLEVBQUUsQ0FBUztJQUVwQixvRUFBb0U7SUFDNUQsS0FBSyxHQUFvQixFQUFFLENBQUM7SUFDcEMsK0RBQStEO0lBQ3ZELEtBQUssR0FBb0IsRUFBRSxDQUFDO0lBQ3BDLDBEQUEwRDtJQUNsRCxLQUFLLEdBQUcsSUFBSSxHQUFHLEVBQW1CLENBQUM7SUFFM0MsWUFBWSxFQUFXO1FBQ3JCLElBQUksQ0FBQyxFQUFFLEdBQUcsRUFBRSxJQUFJLFVBQVUsQ0FBQztJQUM3QixDQUFDO0lBRUQsY0FBYyxDQUFDLEtBQXVCO1FBQ3BDLE1BQU0sS0FBSyxHQUFrQjtZQUMzQixTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMsSUFBSTtZQUN4QyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDaEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLFFBQVEsRUFBRSxFQUFFO1NBQ2IsQ0FBQztRQUNGLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFFRCxhQUFhLENBQUMsTUFBd0I7UUFDcEMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUNuQyxJQUFJLENBQUMsU0FBUztZQUFFLE9BQU87UUFFdkIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNqRCxJQUFJLE1BQU0sRUFBRSxDQUFDO1lBQ1gsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDbEMsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM3QixDQUFDO0lBQ0gsQ0FBQztJQUVELG1CQUFtQixDQUFDLEtBQWlDO1FBQ25ELElBQUksS0FBSyxDQUFDLGFBQWEsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1lBQzVELElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ3ZELENBQUM7SUFDSCxDQUFDO0lBRUQsZ0ZBQWdGO0lBQ2hGLFdBQVc7UUFDVCxPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUVEOzs7Ozs7T0FNRztJQUNILE9BQU8sQ0FBQyxTQUFpQjtRQUN2QixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ25DLENBQUM7SUFFRCxtQ0FBbUM7SUFDbkMsVUFBVTtRQUNSLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUVELFVBQVU7UUFDUixPQUFPO1lBQ0wsSUFBSSxFQUFFLFVBQVU7WUFDaEIsV0FBVyxFQUFFLG9FQUFvRTtZQUNqRixrQkFBa0IsRUFBRSxXQUFvQjtZQUN4QyxJQUFJLEVBQUUsSUFBSSxDQUFDLFdBQVcsRUFBRTtTQUN6QixDQUFDO0lBQ0osQ0FBQztJQUVELDhCQUE4QjtJQUM5QixLQUFLO1FBQ0gsSUFBSSxDQUFDLEtBQUssR0FBRyxFQUFFLENBQUM7UUFDaEIsSUFBSSxDQUFDLEtBQUssR0FBRyxFQUFFLENBQUM7UUFDaEIsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNyQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1hbmlmZXN0Rmxvd1JlY29yZGVyIOKAlCBCdWlsZHMgYSBsaWdodHdlaWdodCBzdWJmbG93IG1hbmlmZXN0IGR1cmluZyB0cmF2ZXJzYWwuXG4gKlxuICogQ29sbGVjdHMgc3ViZmxvdyBtZXRhZGF0YSAoSUQsIG5hbWUsIGRlc2NyaXB0aW9uKSBhcyBhIHNpZGUgZWZmZWN0IG9mXG4gKiBvYnNlcnZpbmcgdHJhdmVyc2FsIGV2ZW50cy4gUHJvZHVjZXMgYSB0cmVlIHN0cnVjdHVyZSBzdWl0YWJsZSBmb3IgTExNXG4gKiBuYXZpZ2F0aW9uOiBsaWdodHdlaWdodCBlbm91Z2ggdG8gaW5jbHVkZSBpbiBzbmFwc2hvdHMsIHdpdGggb24tZGVtYW5kXG4gKiBhY2Nlc3MgdG8gZnVsbCBzcGVjcyB2aWEgZ2V0U3BlYygpLlxuICpcbiAqIFRoZSBtYW5pZmVzdCByZWZsZWN0cyBvbmx5IHN1YmZsb3dzIHRoYXQgd2VyZSBhY3R1YWxseSBlbnRlcmVkIGR1cmluZ1xuICogZXhlY3V0aW9uIOKAlCB1bnZpc2l0ZWQgYnJhbmNoZXMgYXJlIG5vdCBpbmNsdWRlZC5cbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHlwZXNjcmlwdFxuICogY29uc3QgbWFuaWZlc3QgPSBuZXcgTWFuaWZlc3RGbG93UmVjb3JkZXIoKTtcbiAqIGV4ZWN1dG9yLmF0dGFjaEZsb3dSZWNvcmRlcihtYW5pZmVzdCk7XG4gKiBhd2FpdCBleGVjdXRvci5ydW4oeyBpbnB1dDogZGF0YSB9KTtcbiAqXG4gKiAvLyBMaWdodHdlaWdodCB0cmVlIG9mIHN1YmZsb3cgSURzICsgZGVzY3JpcHRpb25zXG4gKiBjb25zdCB0cmVlID0gbWFuaWZlc3QuZ2V0TWFuaWZlc3QoKTtcbiAqXG4gKiAvLyBGdWxsIHNwZWMgZm9yIGEgc3BlY2lmaWMgc3ViZmxvdyAoaWYgYXZhaWxhYmxlKVxuICogY29uc3Qgc3BlYyA9IG1hbmlmZXN0LmdldFNwZWMoJ3NmLWNyZWRpdC1jaGVjaycpO1xuICogYGBgXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBGbG93UmVjb3JkZXIsIEZsb3dTdWJmbG93RXZlbnQsIEZsb3dTdWJmbG93UmVnaXN0ZXJlZEV2ZW50IH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG4vKiogQSBzaW5nbGUgZW50cnkgaW4gdGhlIHN1YmZsb3cgbWFuaWZlc3QgdHJlZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWFuaWZlc3RFbnRyeSB7XG4gIC8qKiBTdWJmbG93IGlkZW50aWZpZXIg4oCUIHVzZSBmb3Igb24tZGVtYW5kIHNwZWMgbG9va3VwLiAqL1xuICBzdWJmbG93SWQ6IHN0cmluZztcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIG5hbWUuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEJ1aWxkLXRpbWUgZGVzY3JpcHRpb24gb2Ygd2hhdCB0aGlzIHN1YmZsb3cgZG9lcy4gKi9cbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIC8qKiBOZXN0ZWQgc3ViZmxvd3MgZW50ZXJlZCB3aXRoaW4gdGhpcyBzdWJmbG93LiAqL1xuICBjaGlsZHJlbjogTWFuaWZlc3RFbnRyeVtdO1xufVxuXG5leHBvcnQgY2xhc3MgTWFuaWZlc3RGbG93UmVjb3JkZXIgaW1wbGVtZW50cyBGbG93UmVjb3JkZXIge1xuICByZWFkb25seSBpZDogc3RyaW5nO1xuXG4gIC8qKiBTdGFjayB0cmFja3MgbmVzdGluZyBkZXB0aCDigJQgY3VycmVudCBzdWJmbG93IGlzIHRvcCBvZiBzdGFjay4gKi9cbiAgcHJpdmF0ZSBzdGFjazogTWFuaWZlc3RFbnRyeVtdID0gW107XG4gIC8qKiBSb290LWxldmVsIHN1YmZsb3dzIChub3QgbmVzdGVkIGluc2lkZSBhbm90aGVyIHN1YmZsb3cpLiAqL1xuICBwcml2YXRlIHJvb3RzOiBNYW5pZmVzdEVudHJ5W10gPSBbXTtcbiAgLyoqIEZ1bGwgc3BlY3Mgc3RvcmVkIGZyb20gZHluYW1pYyByZWdpc3RyYXRpb24gZXZlbnRzLiAqL1xuICBwcml2YXRlIHNwZWNzID0gbmV3IE1hcDxzdHJpbmcsIHVua25vd24+KCk7XG5cbiAgY29uc3RydWN0b3IoaWQ/OiBzdHJpbmcpIHtcbiAgICB0aGlzLmlkID0gaWQgPz8gJ21hbmlmZXN0JztcbiAgfVxuXG4gIG9uU3ViZmxvd0VudHJ5KGV2ZW50OiBGbG93U3ViZmxvd0V2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgZW50cnk6IE1hbmlmZXN0RW50cnkgPSB7XG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnN1YmZsb3dJZCA/PyBldmVudC5uYW1lLFxuICAgICAgbmFtZTogZXZlbnQubmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbixcbiAgICAgIGNoaWxkcmVuOiBbXSxcbiAgICB9O1xuICAgIHRoaXMuc3RhY2sucHVzaChlbnRyeSk7XG4gIH1cblxuICBvblN1YmZsb3dFeGl0KF9ldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGNvbXBsZXRlZCA9IHRoaXMuc3RhY2sucG9wKCk7XG4gICAgaWYgKCFjb21wbGV0ZWQpIHJldHVybjtcblxuICAgIGNvbnN0IHBhcmVudCA9IHRoaXMuc3RhY2tbdGhpcy5zdGFjay5sZW5ndGggLSAxXTtcbiAgICBpZiAocGFyZW50KSB7XG4gICAgICBwYXJlbnQuY2hpbGRyZW4ucHVzaChjb21wbGV0ZWQpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnJvb3RzLnB1c2goY29tcGxldGVkKTtcbiAgICB9XG4gIH1cblxuICBvblN1YmZsb3dSZWdpc3RlcmVkKGV2ZW50OiBGbG93U3ViZmxvd1JlZ2lzdGVyZWRFdmVudCk6IHZvaWQge1xuICAgIGlmIChldmVudC5zcGVjU3RydWN0dXJlICYmICF0aGlzLnNwZWNzLmhhcyhldmVudC5zdWJmbG93SWQpKSB7XG4gICAgICB0aGlzLnNwZWNzLnNldChldmVudC5zdWJmbG93SWQsIGV2ZW50LnNwZWNTdHJ1Y3R1cmUpO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSBtYW5pZmVzdCB0cmVlIOKAlCBsaWdodHdlaWdodCwgc3VpdGFibGUgZm9yIHNuYXBzaG90IGluY2x1c2lvbi4gKi9cbiAgZ2V0TWFuaWZlc3QoKTogTWFuaWZlc3RFbnRyeVtdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMucm9vdHNdO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIGZ1bGwgc3BlYyBmb3IgYSBkeW5hbWljYWxseS1yZWdpc3RlcmVkIHN1YmZsb3cuXG4gICAqIE9ubHkgcG9wdWxhdGVkIGZvciBzdWJmbG93cyBhdXRvLXJlZ2lzdGVyZWQgYXQgcnVudGltZSAodmlhIFN0YWdlTm9kZVxuICAgKiByZXR1cm4gd2l0aCBzdWJmbG93RGVmKS4gU3RhdGljYWxseS1jb25maWd1cmVkIHN1YmZsb3dzIGFyZSBub3QgaW5jbHVkZWRcbiAgICogZXZlbiBpZiB0aGV5IGFwcGVhciBpbiBnZXRNYW5pZmVzdCgpLiBVc2UgRmxvd0NoYXJ0LmJ1aWxkVGltZVN0cnVjdHVyZVxuICAgKiB0byBhY2Nlc3Mgc3RhdGljYWxseS1kZWZpbmVkIHN1YmZsb3cgc3BlY3MuXG4gICAqL1xuICBnZXRTcGVjKHN1YmZsb3dJZDogc3RyaW5nKTogdW5rbm93biB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuc3BlY3MuZ2V0KHN1YmZsb3dJZCk7XG4gIH1cblxuICAvKiogUmV0dXJucyBhbGwgc3RvcmVkIHNwZWMgSURzLiAqL1xuICBnZXRTcGVjSWRzKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gQXJyYXkuZnJvbSh0aGlzLnNwZWNzLmtleXMoKSk7XG4gIH1cblxuICB0b1NuYXBzaG90KCkge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnTWFuaWZlc3QnLFxuICAgICAgZGVzY3JpcHRpb246ICdUcmFuc2xhdG9yIChGbG93UmVjb3JkZXIpIOKAlCBzdWJmbG93IGNhdGFsb2cgYnVpbHQgZHVyaW5nIHRyYXZlcnNhbCcsXG4gICAgICBwcmVmZXJyZWRPcGVyYXRpb246ICd0cmFuc2xhdGUnIGFzIGNvbnN0LFxuICAgICAgZGF0YTogdGhpcy5nZXRNYW5pZmVzdCgpLFxuICAgIH07XG4gIH1cblxuICAvKiogQ2xlYXJzIHN0YXRlIGZvciByZXVzZS4gKi9cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgdGhpcy5zdGFjayA9IFtdO1xuICAgIHRoaXMucm9vdHMgPSBbXTtcbiAgICB0aGlzLnNwZWNzLmNsZWFyKCk7XG4gIH1cbn1cbiJdfQ==