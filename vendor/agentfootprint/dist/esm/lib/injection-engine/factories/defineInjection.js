/**
 * defineInjection — the unified injection factory (one factory, a `type`
 * discriminant for the flavor).
 *
 * The named factories (`defineInstruction`, `defineSkill`, `defineSteering`,
 * `defineFact`) are self-documenting sugar — prefer them when you know the
 * flavor at author time. `defineInjection` is for the cases where the flavor is
 * chosen *programmatically* (config-driven pipelines, a UI that lets users add
 * any flavor, table-driven tests) — pass `type` and the same options the named
 * factory takes:
 *
 * @example
 *   // these two are equivalent
 *   defineInstruction({ id: 'calm', prompt: '…', activeWhen });
 *   defineInjection({ type: 'instruction', id: 'calm', prompt: '…', activeWhen });
 *
 * @example  // flavor decided at runtime
 *   const inj = defineInjection({ type: cfg.flavor, id: cfg.id, ...cfg.opts });
 *
 * All four flavors return the same `Injection` primitive — `type` simply routes
 * to the matching named factory. RAG and Memory are NOT covered here: they are
 * separate subsystems (retrieval + stores), not plain Injections.
 */
import { defineFact } from './defineFact.js';
import { defineInstruction } from './defineInstruction.js';
import { defineSkill } from './defineSkill.js';
import { defineSteering } from './defineSteering.js';
export function defineInjection(opts) {
    // Each named factory reads only the fields it knows and constructs a fresh
    // frozen Injection, so the extra `type` discriminant on `opts` is ignored.
    switch (opts.type) {
        case 'instruction':
            return defineInstruction(opts);
        case 'skill':
            return defineSkill(opts);
        case 'steering':
            return defineSteering(opts);
        case 'fact':
            return defineFact(opts);
        default: {
            const exhaustive = opts;
            throw new Error(`defineInjection: unknown injection type "${String(exhaustive.type)}".`);
        }
    }
}
//# sourceMappingURL=defineInjection.js.map