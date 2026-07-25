/** Default: extract plaintext from any supported content shape. */
function defaultTextFrom(message) {
    return message.content ?? '';
}
/**
 * Build the `embedMessages` stage. Prefers `embedBatch()` when the
 * embedder implements it (one round-trip for the whole turn), otherwise
 * falls back to N sequential `embed()` calls.
 */
export function embedMessages(config) {
    const { embedder } = config;
    const textFrom = config.textFrom ?? defaultTextFrom;
    return async (scope) => {
        const messages = (scope.newMessages ?? []);
        if (messages.length === 0) {
            scope.newMessageEmbeddings = [];
            return;
        }
        const texts = messages.map(textFrom);
        const signal = scope.$getEnv?.()?.signal;
        let vectors;
        if (embedder.embedBatch) {
            vectors = (await embedder.embedBatch({
                texts,
                ...(signal ? { signal } : {}),
            }));
        }
        else {
            vectors = await Promise.all(texts.map((text) => embedder.embed({ text, ...(signal ? { signal } : {}) })));
        }
        scope.newMessageEmbeddings = vectors;
        if (config.embedderId !== undefined) {
            scope.newMessageEmbeddingModel = config.embedderId;
        }
    };
}
//# sourceMappingURL=embedMessages.js.map