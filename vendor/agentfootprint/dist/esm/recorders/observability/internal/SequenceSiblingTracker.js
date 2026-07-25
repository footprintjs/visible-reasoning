/**
 * @internal — not part of the public agentfootprint API. Imported only
 * by RunStepRecorder. Subject to change without notice.
 *
 * SequenceSiblingTracker — tracks the most-recent leaf exit at each
 * depth so the recorder knows when a new leaf entry at the same depth
 * should emit a "sequential handoff" step ("forwards" semantics).
 *
 * Extracted from RunStepRecorder per Convention 1.
 *
 * Use:
 *   - On leaf EXIT: `recordExit(depth, subflowId)`.
 *   - On leaf ENTRY: `peekPrevSibling(depth)` returns the previous
 *     leaf's subflowId at this depth, or undefined for the first leaf.
 */
export class SequenceSiblingTracker {
    prevExitedAtDepth = new Map();
    /** Returns the subflow id of the most-recently-exited leaf at this
     *  depth, or undefined if this is the first leaf entry at the depth. */
    peekPrevSibling(depth) {
        return this.prevExitedAtDepth.get(depth);
    }
    /** Record that a leaf at this depth just exited. */
    recordExit(depth, subflowId) {
        this.prevExitedAtDepth.set(depth, subflowId);
    }
    clear() {
        this.prevExitedAtDepth.clear();
    }
}
//# sourceMappingURL=SequenceSiblingTracker.js.map