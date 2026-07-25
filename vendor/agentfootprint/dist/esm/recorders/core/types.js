/**
 * Recorder-layer types — shapes builders use to communicate with recorders.
 *
 * Pattern: Data Transfer Object (Fowler, PoEAA).
 * Role:    Shared vocabulary between builders (which WRITE injections) and
 *          recorders (which OBSERVE those writes and emit grouped events).
 */
// Convention scope keys for composition / eviction / pressure signals.
// These live alongside INJECTION_KEYS in conventions.ts; re-exported here
// for recorder convenience.
export const COMPOSITION_KEYS = {
    SLOT_COMPOSED: 'slotCompositions',
    EVICTED: 'slotEvictions',
    BUDGET_PRESSURE: 'slotBudgetPressures',
};
//# sourceMappingURL=types.js.map