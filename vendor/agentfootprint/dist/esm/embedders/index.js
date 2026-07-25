export function openaiEmbedder(options = {}) {
    const apiKey = options.apiKey ??
        (typeof process !== 'undefined' ? process.env?.['OPENAI_API_KEY'] : undefined);
    if (!apiKey || !apiKey.trim()) {
        throw new Error('openaiEmbedder: no API key — set OPENAI_API_KEY or pass { apiKey }.');
    }
    const model = options.model ?? 'text-embedding-3-small';
    const dimensions = options.dimensions ?? 1536;
    const url = `${options.baseURL ?? 'https://api.openai.com/v1'}/embeddings`;
    async function call(input, signal) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, input }),
            ...(signal ? { signal } : {}),
        });
        if (!res.ok)
            throw new Error(`openaiEmbedder: ${res.status} ${await res.text()}`);
        const json = (await res.json());
        return json.data.map((d) => d.embedding);
    }
    return {
        dimensions,
        async embed({ text, signal }) {
            return (await call([text], signal))[0];
        },
        async embedBatch({ texts, signal }) {
            return call([...texts], signal);
        },
    };
}
export function localEmbedder(options = {}) {
    const model = options.model ?? 'Xenova/all-MiniLM-L6-v2';
    const dimensions = options.dimensions ?? 384;
    const dtype = options.dtype ?? 'q8';
    let pipe;
    const getPipe = () => {
        // Variable specifier so the compiler/bundler does NOT resolve the module at
        // build time — @huggingface/transformers stays an optional peer dep, loaded
        // only when localEmbedder is actually used.
        const spec = '@huggingface/transformers';
        return (pipe ??= import(spec).then((mod) => {
            const m = mod;
            if (options.cacheDir)
                m.env['cacheDir'] = options.cacheDir;
            return m.pipeline('feature-extraction', model, { dtype });
        }));
    };
    return {
        dimensions,
        async embed({ text }) {
            const p = await getPipe();
            const out = await p(text, { pooling: 'mean', normalize: true });
            return Array.from(out.data);
        },
        async embedBatch({ texts }) {
            const p = await getPipe();
            const out = await p([...texts], { pooling: 'mean', normalize: true });
            return out.tolist();
        },
    };
}
export function staticEmbedder(options = {}) {
    const dimensions = options.dimensions ?? 256;
    const spec = options.module ?? '@yarflam/potion-base-8m';
    let embedFn;
    const getEmbed = () => {
        return (embedFn ??= import(spec).then((mod) => {
            // potion-base-8m exports `embed(texts) => Promise<Float32Array[]>` (a batch
            // async fn, also on its default export). Accept a small set of shapes so
            // other Model2Vec builds slot in: a named `embed`/`encode` on the module or
            // its default, or a default export that IS the fn.
            const m = mod;
            const d = (m.default ?? {});
            const fn = m['embed'] ??
                d['embed'] ??
                m['encode'] ??
                d['encode'] ??
                (typeof m.default === 'function' ? m.default : undefined);
            if (!fn) {
                throw new Error(`staticEmbedder: no embed()/encode() export on '${spec}'. Pass { module } or wrap it in your own Embedder.`);
            }
            return fn;
        }));
    };
    // Normalize a batch result into number[][] (one row per input). Handles
    // Float32Array[] (potion), number[][], and a single flat vector for the call.
    const toRows = (out) => {
        const rows = out;
        if (rows == null || typeof rows.length !== 'number') {
            throw new Error('staticEmbedder: embed() did not return an array of vectors.');
        }
        if (rows.length > 0 && typeof rows[0] === 'number') {
            return [Array.from(rows)]; // one flat vector for the call
        }
        return Array.from(rows, (v) => Array.from(v));
    };
    return {
        dimensions,
        async embed({ text }) {
            const fn = await getEmbed();
            const rows = toRows(await fn([text]));
            return rows[0] ?? [];
        },
        async embedBatch({ texts }) {
            const fn = await getEmbed();
            return toRows(await fn([...texts]));
        },
    };
}
//# sourceMappingURL=index.js.map