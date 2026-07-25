export function writeFacts(config) {
    return async (scope) => {
        const facts = (scope.newFacts ?? []);
        if (facts.length === 0)
            return;
        await config.store.putMany(scope.identity, facts);
    };
}
//# sourceMappingURL=writeFacts.js.map