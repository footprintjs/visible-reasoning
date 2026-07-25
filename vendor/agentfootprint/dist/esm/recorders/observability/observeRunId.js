export function createRunIdObserver(onNewRun) {
    let lastRunId;
    return {
        observe(runId) {
            if (!runId)
                return;
            if (lastRunId === undefined) {
                lastRunId = runId;
                return;
            }
            if (runId !== lastRunId) {
                onNewRun();
                lastRunId = runId;
            }
        },
        reset() {
            lastRunId = undefined;
        },
    };
}
//# sourceMappingURL=observeRunId.js.map