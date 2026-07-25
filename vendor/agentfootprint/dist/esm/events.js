/**
 * agentfootprint/events — the typed event system.
 *
 * Every agentfootprint run emits a single, strongly-typed event stream:
 * the registry (`EVENT_NAMES`, `AgentfootprintEventMap`, `AgentfootprintEvent`),
 * the dispatcher (`EventDispatcher` + listener/wildcard types), the shared
 * context/composition types, and the ~60 typed payload shapes (grouped
 * under the `Payloads` namespace).
 *
 * This is observability infrastructure, not core agent API, so in v7 it
 * lives on its own subpath — consistent with `/observe`, `/memory`, etc.
 * Recorders (`agentfootprint/observe`) and viewer libraries consume it;
 * the `Agent` builder wires it for you.
 */
// Shared event/context/composition types.
export * from './events/types.js';
// Registry — the event-name set + the typed map/union/discriminant.
export { EVENT_NAMES, ALL_EVENT_TYPES, } from './events/registry.js';
// Dispatcher — subscribe to the stream (`.on(type, listener)`), wildcard
// subscriptions, and the unsubscribe handle.
export { EventDispatcher, } from './events/dispatcher.js';
//# sourceMappingURL=events.js.map