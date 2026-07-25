/**
 * defaultPipeline — the 90%-use-case memory preset.
 *
 * Composes Layer 2-3 stages into two flowchart subflows that the wire
 * layer mounts inside the agent's main flowchart:
 *
 *   READ  :  LoadRecent → PickByBudget → FormatDefault
 *   WRITE :  WriteMessages
 *
 * Why this particular composition?
 *   - Load-then-pick-then-format matches the cognitive sequence:
 *     retrieve candidates, choose what fits, present it.
 *   - Single-stage write keeps the persistence story simple for Phase 1;
 *     Phase 1.5 adds a second stage (extractFacts) to the write side.
 *
 * This preset is intentionally opinionated. Users who need more
 * control should compose their own FlowChart and pass it to
 * `.memory()` directly — the preset is teaching code, not a
 * one-size-fits-all.
 *
 * **Build once, mount many.** Call `defaultPipeline(config)` at application
 * startup (or whenever the config changes). The returned `{read, write}`
 * are immutable compiled FlowChart objects safe to share across many
 * agent builds and many `.run()` calls. Rebuilding per-turn is wasteful —
 * the stages capture their config at build time and don't read it later.
 *
 * Most consumers should use `defineMemory({ type: MEMORY_TYPES.EPISODIC,
 * strategy: { kind: MEMORY_STRATEGIES.WINDOW, ... }, store })` instead
 * of calling `defaultPipeline()` directly — the factory dispatches
 * onto this pipeline under the hood. Use `defaultPipeline()` directly
 * only when composing memory subflows into a non-Agent flowchart via
 * `mountMemoryRead`/`mountMemoryWrite`.
 *
 * @example Direct usage (low-level — custom flowchart composition):
 * ```ts
 * import { defaultPipeline, mountMemoryRead, InMemoryStore } from 'agentfootprint/memory';
 * import { flowChart } from 'footprintjs';
 *
 * const pipeline = defaultPipeline({
 *   store: new InMemoryStore(),
 *   loadCount: 20,
 *   reserveTokens: 512,
 * });
 *
 * let builder = flowChart('Seed', seedFn, 'seed');
 * builder = mountMemoryRead(builder, { pipeline });
 * // ... continue building your custom flowchart
 * ```
 */
import { flowChart } from 'footprintjs';
import { loadRecent } from '../stages/loadRecent.js';
import { pickByBudget } from '../stages/pickByBudget.js';
import { formatDefault } from '../stages/formatDefault.js';
import { writeMessages } from '../stages/writeMessages.js';
/**
 * Build the default read + write pipelines sharing a single store.
 * Returns two FlowChart subflows ready to be mounted by the wire layer.
 */
export function defaultPipeline(config) {
    // Explicit per-stage config construction — keeps each stage's defaults
    // visible in the preset source (which doubles as teaching code).
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
    const writeConfig = {
        store: config.store,
        ...(config.writeTier && { tier: config.writeTier }),
        ...(config.writeTtlMs !== undefined && { ttlMs: config.writeTtlMs }),
    };
    // Compose: LoadRecent → [PickDecider → skip-empty | skip-no-budget | pick] → Format
    // pickByBudget is a builder-extension — it appends a decider + 3
    // branches to the pipeline so "why did / didn't we inject memory?" is
    // answerable via FlowRecorder.onDecision evidence, not just emit events.
    let readBuilder = flowChart('LoadRecent', loadRecent(loadConfig), 'load-recent', {
        description: 'Read N most-recent entries from storage into scope.loaded',
    });
    readBuilder = pickByBudget(pickConfig)(readBuilder);
    const read = readBuilder
        .addFunction('Format', formatDefault(formatConfig), 'format-default', 'Render selected entries as a system message; writes scope.formatted')
        .build();
    const write = flowChart('WriteMessages', writeMessages(writeConfig), 'write-messages', { description: 'Persist new turn messages to storage' }).build();
    return { read, write };
}
//# sourceMappingURL=default.js.map