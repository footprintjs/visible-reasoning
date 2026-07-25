/**
 * loadSnapshot — read-side stage for Causal memory.
 *
 * Embeds the user's current question, searches the store for the most
 * similar past run, projects the snapshot per `SnapshotProjection`,
 * and writes the formatted result to `scope.formatted` so the
 * downstream slot subflow injects it as a system message.
 *
 * Reads from scope:   `identity`, `messages` (or `newMessages` fallback)
 * Writes to scope:    `formatted` — array of `LLMMessage` to inject
 *
 * Strict-threshold semantics:
 *   When `minScore` is set and no past snapshot meets it, returns an
 *   empty `formatted`. NO fallback — garbage past context is worse than
 *   no context.
 *
 * Empty-query handling:
 *   No user message → no embedding → no search → empty result.
 */
import { SNAPSHOT_PROJECTIONS } from '../define.types.js';
function defaultQueryFrom(scope) {
    const scopeAny = scope;
    const incoming = scopeAny.messages ?? [];
    const source = incoming.length > 0 ? incoming : scope.newMessages ?? [];
    for (let i = source.length - 1; i >= 0; i--) {
        const m = source[i];
        if (m.role === 'user' && m.content)
            return String(m.content);
    }
    return '';
}
export function loadSnapshot(config) {
    const { store, embedder } = config;
    if (!store.search) {
        throw new Error('loadSnapshot: the configured store does not implement search(). ' +
            'Causal memory requires a vector-capable adapter (InMemoryStore, pgvector, ...).');
    }
    const queryFrom = config.queryFrom ?? defaultQueryFrom;
    const topK = config.topK ?? 1;
    const projection = config.projection ?? SNAPSHOT_PROJECTIONS.DECISIONS;
    const minScore = config.minScore ?? 0.7;
    return async (scope) => {
        const identity = scope.identity;
        const text = queryFrom(scope).trim();
        if (text.length === 0) {
            scope.formatted = [];
            return;
        }
        const signal = scope.$getEnv?.()?.signal;
        const queryVec = (await embedder.embed({
            text,
            ...(signal ? { signal } : {}),
        }));
        // store.search optional on MemoryStore but required when an embedder
        // is configured (validated upstream by defineMemory).
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const results = await store.search(identity, queryVec, {
            k: topK,
            minScore,
            ...(config.embedderId !== undefined && { embedderId: config.embedderId }),
        });
        if (results.length === 0) {
            // Strict threshold: no match → no injection. Garbage > none is wrong.
            scope.formatted = [];
            return;
        }
        const messages = results.map((r) => formatProjection(r.entry, projection, r.score));
        scope.formatted = messages;
    };
}
/**
 * Render one snapshot into a `system` message per the chosen
 * projection. The shape is intentionally compact so multiple
 * snapshots fit comfortably in context.
 */
function formatProjection(entry, projection, score) {
    const snap = entry.value;
    const header = `[Past run · query: "${truncate(snap.query, 80)}" · score: ${score.toFixed(2)}]`;
    let body;
    switch (projection) {
        case SNAPSHOT_PROJECTIONS.DECISIONS: {
            // Tool evidence is part of the "why": in LLM-decided flows the
            // operator-level facts (creditScore=580, dti=0.45) arrive as tool
            // results, so the decisions projection includes them.
            // SECURITY: this replays STORED TOOL OUTPUT into a future prompt — a
            // persisted prompt-injection surface if tools ingest untrusted content.
            // Treat snapshot stores as prompt-trusted; sanitize tool output at the
            // tool boundary when it carries third-party text.
            const toolLines = snap.toolCalls.length === 0
                ? ''
                : `\nTool evidence:\n${snap.toolCalls
                    .map((t) => `- ${t.name}(${JSON.stringify(t.args)}) → ${t.resultPreview}` +
                    (t.errored ? ' [ERROR]' : ''))
                    .join('\n')}`;
            body =
                snap.decisions.length === 0 && snap.toolCalls.length === 0
                    ? `(no decision evidence captured)\nFinal answer: ${snap.finalContent}`
                    : `${snap.decisions
                        .map((d) => `- ${d.stageId} → "${d.chosen}"${d.rule ? ` (rule: ${d.rule})` : ''}` +
                        (d.evidence ? `; evidence: ${JSON.stringify(d.evidence)}` : ''))
                        .join('\n')}${toolLines}\nFinal answer: ${snap.finalContent}`;
            break;
        }
        case SNAPSHOT_PROJECTIONS.NARRATIVE:
            body = snap.narrative ?? `(no narrative captured)\nFinal answer: ${snap.finalContent}`;
            break;
        case SNAPSHOT_PROJECTIONS.COMMITS:
            // commitLog isn't yet captured in SnapshotEntry; project the
            // decisions list as a stand-in for now.
            body =
                snap.decisions.length === 0
                    ? `(no commit log captured)\nFinal answer: ${snap.finalContent}`
                    : snap.decisions.map((d) => `${d.stageId}: chose "${d.chosen}"`).join('\n');
            break;
        case SNAPSHOT_PROJECTIONS.FULL:
            body = JSON.stringify(snap, null, 2);
            break;
        default:
            body = `Final answer: ${snap.finalContent}`;
    }
    return {
        role: 'system',
        content: `${header}\n${body}`,
    };
}
function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
//# sourceMappingURL=loadSnapshot.js.map