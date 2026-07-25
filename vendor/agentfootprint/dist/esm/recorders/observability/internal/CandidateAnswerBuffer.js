/**
 * @internal — not part of the public agentfootprint API. Imported only
 * by RunStepRecorder. Subject to change without notice.
 *
 * CandidateAnswerBuffer — buffers a "this leaf MIGHT be the run's
 * answer" candidate that's only confirmed on `onRunEnd`. Replaced
 * by every later leaf exit at run scope; the last one wins.
 *
 * Extracted from RunStepRecorder per Convention 1.
 *
 * Use:
 *   - On leaf EXIT at run scope: `set(frame, ts, runtimeStageId)`.
 *   - On `onRunEnd`: `flush()` returns the buffered candidate (or
 *     undefined if none), and clears the buffer.
 */
export class CandidateAnswerBuffer {
    candidate;
    /** Buffer a new candidate, replacing any prior one. */
    set(frame, tsMs, runtimeStageId) {
        this.candidate = { frame, tsMs, runtimeStageId };
    }
    /** Return + clear the buffered candidate (or undefined if empty). */
    flush() {
        const c = this.candidate;
        this.candidate = undefined;
        return c;
    }
    clear() {
        this.candidate = undefined;
    }
}
//# sourceMappingURL=CandidateAnswerBuffer.js.map