/**
 * ephemeralPipeline — read-only memory preset.
 *
 * Loads from store but NEVER writes. Use when:
 *   - The conversation is "incognito" and must not accumulate history
 *     (OpenAI-team reviewer ask: ChatGPT-style ephemeral mode).
 *   - You've pre-seeded the store externally and want the agent to
 *     consume it as read-only facts.
 *   - Compliance requires a hard no-write boundary on certain sessions.
 *
 * Implementation: identical to `defaultPipeline` on the read side; the
 * `write` subflow is deliberately omitted. `mountMemoryWrite` is a no-op
 * when write is absent, so wiring code doesn't need to branch.
 *
 * @example
 * ```ts
 * import { ephemeralPipeline, InMemoryStore } from 'agentfootprint/memory';
 *
 * const store = new InMemoryStore();
 * // Pre-seed facts the agent should know about (but cannot modify)
 * await store.put(identity, factEntry);
 *
 * const pipeline = ephemeralPipeline({ store });
 * // → { read: FlowChart, write: undefined }
 * ```
 */
import { flowChart } from 'footprintjs';
import { loadRecent } from '../stages/loadRecent.js';
import { pickByBudget } from '../stages/pickByBudget.js';
import { formatDefault } from '../stages/formatDefault.js';
/**
 * Build an ephemeral (read-only) pipeline. The returned object has
 * `write: undefined`; wire helpers no-op on it.
 */
export function ephemeralPipeline(config) {
    const loadConfig = {
        store: config.store,
        ...(config.loadCount !== undefined && { count: config.loadCount }),
        ...(config.tiers && { tiers: config.tiers }),
    };
    const pickConfig = {
        ...(config.reserveTokens !== undefined && { reserveTokens: config.reserveTokens }),
        ...(config.minimumTokens !== undefined && { minimumTokens: config.minimumTokens }),
        ...(config.maxEntries !== undefined && { maxEntries: config.maxEntries }),
    };
    const formatConfig = {
        ...(config.formatHeader !== undefined && { header: config.formatHeader }),
        ...(config.formatFooter !== undefined && { footer: config.formatFooter }),
    };
    let readBuilder = flowChart('LoadRecent', loadRecent(loadConfig), 'load-recent', {
        description: 'Read N most-recent entries from storage into scope.loaded (read-only)',
    });
    readBuilder = pickByBudget(pickConfig)(readBuilder);
    const read = readBuilder
        .addFunction('Format', formatDefault(formatConfig), 'format-default', 'Render selected entries as a system message')
        .build();
    // NO write subflow — `write` is deliberately omitted. Wire helpers
    // (`mountMemoryWrite`) check for absence and no-op. The `MemoryPipeline`
    // contract declares `write?` optional precisely for this case.
    return { read };
}
//# sourceMappingURL=ephemeral.js.map