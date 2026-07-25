/**
 * CompositionRecorder — forwards `agentfootprint.composition.*` emits to the dispatcher.
 *
 * Pattern: Factory (GoF) returning an EmitBridge instance.
 * Role:    Convenience constructor for the composition-domain bridge recorder.
 *          Compositions (Sequence, Parallel, Conditional, Loop) typedEmit
 *          composition.enter/exit/fork_start/branch_complete/merge_end/
 *          route_decided/iteration_start/iteration_exit from their internal
 *          stages; this recorder observes via footprintjs's EmitRecorder
 *          channel and re-dispatches with typed payloads + meta.
 * Emits:   agentfootprint.composition.*
 */
import { EmitBridge } from './EmitBridge.js';
export function compositionRecorder(options) {
    return new EmitBridge({
        id: options.id ?? 'agentfootprint.composition-recorder',
        prefix: 'agentfootprint.composition.',
        dispatcher: options.dispatcher,
        getRunContext: options.getRunContext,
    });
}
//# sourceMappingURL=CompositionRecorder.js.map