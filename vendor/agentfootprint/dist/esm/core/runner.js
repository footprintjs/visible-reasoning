/**
 * Runner — consumer-facing interface for every primitive/composition/pattern.
 *
 * Pattern: Facade (GoF) over the footprintjs FlowChart + EventDispatcher.
 * Role:    The one object consumers hold. Exposes:
 *            - `.run()` (execute)
 *            - `.getSpec()` (the design-time FlowChart blueprint —
 *              same value footprintjs's `addSubFlowChart*` accepts)
 *            - `.on() / .off() / .once()` (listener subscription)
 *            - `.attach()` (attach custom CombinedRecorder)
 *            - `.emit()` (consumer-defined custom events on the same
 *              dispatcher, matches DOM CustomEvent)
 * Emits:   N/A — this file defines the INTERFACE. Concrete runners
 *          (LLMCall, Agent, Sequence, etc.) implement it.
 */
export {};
//# sourceMappingURL=runner.js.map