/**
 * EvalRecorder — forwards `agentfootprint.eval.*` emits to the dispatcher.
 *
 * Pattern: Factory over EmitBridge.
 * Role:    Bridges consumer-emitted `eval.score` + `eval.threshold_crossed`
 *          events to typed listeners. Evaluation is a consumer concern
 *          (LLM-based grading, heuristic checks, reference-output diffs),
 *          so the library only provides transport — not any built-in
 *          evaluators.
 * Emits:   agentfootprint.eval.score / eval.threshold_crossed
 */
import { EmitBridge } from './EmitBridge.js';
export function evalRecorder(options) {
    return new EmitBridge({
        id: options.id ?? 'agentfootprint.eval-recorder',
        prefix: 'agentfootprint.eval.',
        dispatcher: options.dispatcher,
        getRunContext: options.getRunContext,
    });
}
//# sourceMappingURL=EvalRecorder.js.map