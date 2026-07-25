/**
 * @internal — not part of the public agentfootprint API. Imported only
 * by RunStepRecorder. Subject to change without notice; do not import
 * via deep paths.
 *
 * ForkTracker — owns the bookkeeping for parallel-fork emission and
 * merge-step detection. Extracted from RunStepRecorder per Convention 1
 * (one purpose per recorder/state machine).
 *
 * Responsibilities (and ONLY these):
 *   1. Coalesce repeated `onFork` events for the same parent (race-safe
 *      via parent+runtimeStageId key).
 *   2. Track which child branches belong to which parent fork.
 *   3. Track which branches have exited; signal "merge ready" when ALL
 *      branches of a fork have exited.
 *
 * What it does NOT own:
 *   - Storage (the recorder writes RunSteps to its SequenceStore).
 *   - Run-boundary detection (the recorder's runIdGuard wipes this
 *     tracker via `clear()`).
 *   - Any other state machine.
 */
export class ForkTracker {
    /** Per-parent: the ordered list of child branch IDs registered. */
    branches = new Map();
    /** Per-parent: the set of child branch IDs that have exited so far. */
    exited = new Map();
    /** Reverse index: child branch ID → its parent fork. */
    childToParent = new Map();
    /** Set of `${parent}@${runtimeStageId}` keys already registered, to
     *  coalesce repeated onFork events. */
    emittedKeys = new Set();
    /**
     * Register a new fork. If the same fork (by parent+runtimeStageId)
     * was already registered, returns `{ fresh: false }` and the caller
     * should suppress emission. Otherwise registers all child branches
     * and returns `{ fresh: true }`.
     */
    registerFork(parent, runtimeStageId, children) {
        const key = `${parent}@${runtimeStageId}`;
        if (this.emittedKeys.has(key))
            return { fresh: false };
        this.emittedKeys.add(key);
        const branchList = [...children];
        this.branches.set(parent, branchList);
        for (const child of branchList) {
            this.childToParent.set(child, parent);
        }
        return { fresh: true };
    }
    /** True if this child belongs to a tracked fork (used to suppress
     *  sequential-emission for fork-branch entry events). */
    isForkChild(childSubflowId) {
        return this.childToParent.has(childSubflowId);
    }
    /**
     * Record a fork-branch exit. If this completes the fork (all branches
     * have exited), returns `{ branches }` so the caller can emit a merge
     * step. Returns `undefined` if not yet complete or not a fork branch.
     */
    recordChildExit(childSubflowId) {
        const parent = this.childToParent.get(childSubflowId);
        if (parent === undefined)
            return undefined;
        let exitedSet = this.exited.get(parent);
        if (!exitedSet) {
            exitedSet = new Set();
            this.exited.set(parent, exitedSet);
        }
        exitedSet.add(childSubflowId);
        const expected = this.branches.get(parent) ?? [];
        if (exitedSet.size === expected.length) {
            return { branches: expected };
        }
        return undefined;
    }
    clear() {
        this.branches.clear();
        this.exited.clear();
        this.childToParent.clear();
        this.emittedKeys.clear();
    }
}
//# sourceMappingURL=ForkTracker.js.map