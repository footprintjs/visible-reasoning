/**
 * EmitBridge — forwards footprintjs emits whose name starts with a given
 * prefix to the EventDispatcher, enriched with EventMeta.
 *
 * Pattern: Adapter (GoF) + Pipes & Filters (Hohpe & Woolf, 2003).
 * Role:    Single reusable translation layer for every "pass-through"
 *          prefix recorder (StreamRecorder, AgentRecorder, and any
 *          future domain whose events are emitted via typedEmit()).
 * Emits:   Any event whose name matches `prefix` — type derived from the
 *          emit name and validated by the consumer's EventMap subscription.
 */
import { buildEventMeta } from '../../bridge/eventMeta.js';
export class EmitBridge {
    id;
    dispatcher;
    prefix;
    getRunContext;
    constructor(options) {
        this.dispatcher = options.dispatcher;
        this.id = options.id;
        this.prefix = options.prefix;
        this.getRunContext = options.getRunContext;
    }
    onEmit(event) {
        if (typeof event.name !== 'string')
            return;
        if (!event.name.startsWith(this.prefix))
            return;
        const type = event.name;
        if (!this.dispatcher.hasListenersFor(type))
            return;
        const payload = event.payload;
        const meta = buildEventMeta({ runtimeStageId: event.runtimeStageId, subflowPath: event.subflowPath }, this.getRunContext());
        this.dispatcher.dispatch({
            type,
            payload,
            meta,
        });
    }
}
//# sourceMappingURL=EmitBridge.js.map