/**
 * ToolsRecorder — forwards `agentfootprint.tools.*` emits to the dispatcher.
 *
 * Pattern: Factory over EmitBridge.
 * Role:    Bridges tool-domain events. Today: discovery_failed (emitted by
 *          buildToolsSlot when an external `ToolProvider.list(ctx)` throws
 *          or rejects). The other tools.* events (offered/activated/
 *          deactivated) are declared in the registry for consumer code
 *          that wants to emit them; the same prefix bridge forwards all
 *          of them.
 * Emits:   agentfootprint.tools.offered / tools.activated / tools.deactivated
 *          / tools.discovery_failed
 */
import { EmitBridge } from './EmitBridge.js';
export function toolsRecorder(options) {
    return new EmitBridge({
        id: options.id ?? 'agentfootprint.tools-recorder',
        prefix: 'agentfootprint.tools.',
        dispatcher: options.dispatcher,
        getRunContext: options.getRunContext,
    });
}
//# sourceMappingURL=ToolsRecorder.js.map