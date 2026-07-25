/**
 * PermissionRecorder — forwards `agentfootprint.permission.*` emits
 * to the dispatcher.
 *
 * Pattern: Factory over EmitBridge.
 * Role:    Bridges permission.check, permission.gate_opened, and
 *          permission.gate_closed emits into the typed dispatcher so
 *          consumer `.on('agentfootprint.permission.check', ...)`
 *          listeners fire.
 * Emits:   agentfootprint.permission.check / gate_opened / gate_closed
 */
import { EmitBridge } from './EmitBridge.js';
export function permissionRecorder(options) {
    return new EmitBridge({
        id: options.id ?? 'agentfootprint.permission-recorder',
        prefix: 'agentfootprint.permission.',
        dispatcher: options.dispatcher,
        getRunContext: options.getRunContext,
    });
}
//# sourceMappingURL=PermissionRecorder.js.map