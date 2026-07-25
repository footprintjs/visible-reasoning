/**
 * StreamRecorder — forwards `agentfootprint.stream.*` emits to the dispatcher.
 *
 * Pattern: Factory (GoF) returning an EmitBridge instance.
 * Role:    Convenience constructor for the stream-domain bridge recorder.
 *          Stage code in LLMCall/Agent calls `typedEmit(scope, 'agentfootprint.stream.llm_start', {...})`;
 *          this recorder observes via footprintjs's EmitRecorder channel
 *          and re-dispatches with typed payloads + enriched meta.
 * Emits:   agentfootprint.stream.llm_start / llm_end / token / tool_start / tool_end
 */
import { EmitBridge } from './EmitBridge.js';
export function streamRecorder(options) {
    return new EmitBridge({
        id: options.id ?? 'agentfootprint.stream-recorder',
        prefix: 'agentfootprint.stream.',
        dispatcher: options.dispatcher,
        getRunContext: options.getRunContext,
    });
}
//# sourceMappingURL=StreamRecorder.js.map