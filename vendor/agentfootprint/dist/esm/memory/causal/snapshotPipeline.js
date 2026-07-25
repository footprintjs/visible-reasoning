/**
 * snapshotPipeline — composes `loadSnapshot` + `writeSnapshot` into a
 * `MemoryPipeline` ready to be mounted by `defineMemory({ type: CAUSAL })`.
 *
 *   READ  :  LoadSnapshot — embed query → search → project → format
 *   WRITE :  WriteSnapshot — embed query → store as MemoryEntry<SnapshotEntry>
 *
 * The pipeline emits the same `agentfootprint.context.injected` event
 * (with `source: 'memory'`) as every other memory flavor, so Lens
 * shows Causal injections as memory chips alongside Episodic /
 * Semantic / Narrative without special UI.
 */
import { flowChart } from 'footprintjs';
import { loadSnapshot } from './loadSnapshot.js';
import { writeSnapshot } from './writeSnapshot.js';
export function snapshotPipeline(config) {
    const loadConfig = {
        store: config.store,
        embedder: config.embedder,
        ...(config.embedderId !== undefined && { embedderId: config.embedderId }),
        ...(config.topK !== undefined && { topK: config.topK }),
        ...(config.minScore !== undefined && { minScore: config.minScore }),
        ...(config.projection !== undefined && { projection: config.projection }),
    };
    const writeConfig = {
        store: config.store,
        embedder: config.embedder,
        ...(config.embedderId !== undefined && { embedderId: config.embedderId }),
        ...(config.ttlMs !== undefined && { ttlMs: config.ttlMs }),
        ...(config.tier && { tier: config.tier }),
    };
    const read = flowChart('LoadSnapshot', loadSnapshot(loadConfig), 'load-snapshot', {
        description: 'Embed query, retrieve top-K past snapshots, project + format as system messages',
    }).build();
    const write = flowChart('WriteSnapshot', writeSnapshot(writeConfig), 'write-snapshot', {
        description: 'Capture (query, finalContent) from the run, embed query, persist as MemoryEntry<SnapshotEntry>',
    }).build();
    return { read, write };
}
//# sourceMappingURL=snapshotPipeline.js.map