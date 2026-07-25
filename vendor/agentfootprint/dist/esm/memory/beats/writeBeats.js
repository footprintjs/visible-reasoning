/**
 * Build the `writeBeats` stage function.
 */
export function writeBeats(config) {
    return async (scope) => {
        const beats = (scope.newBeats ?? []);
        if (beats.length === 0)
            return;
        const identity = scope.identity;
        // `putMany` MUST be a no-op on an empty batch per the interface
        // contract, but we short-circuit above anyway to skip the adapter
        // call entirely when there's nothing to persist.
        await config.store.putMany(identity, beats);
    };
}
//# sourceMappingURL=writeBeats.js.map