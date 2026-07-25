const DEFAULT_DIMENSIONS = 32;
function charFrequency(text, dims) {
    const vec = new Array(dims).fill(0);
    for (let i = 0; i < text.length; i++) {
        vec[text.charCodeAt(i) % dims] += 1;
    }
    return vec;
}
/**
 * Build a deterministic mock embedder. Same text always yields the
 * same vector; texts sharing characters share cosine similarity.
 */
export function mockEmbedder(options = {}) {
    const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new Error(`mockEmbedder: dimensions must be a positive integer (got ${dimensions})`);
    }
    return {
        dimensions,
        async embed({ text }) {
            return charFrequency(text, dimensions);
        },
        async embedBatch({ texts }) {
            return texts.map((text) => charFrequency(text, dimensions));
        },
    };
}
//# sourceMappingURL=mockEmbedder.js.map