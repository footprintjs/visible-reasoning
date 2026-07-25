/**
 * defineSteering — sugar for always-on system-prompt Injections.
 *
 * Steering docs are the simplest form of context engineering: a fixed
 * piece of guidance the LLM should follow on every iteration. Style
 * guides, output format rules, persona statements, safety policies.
 *
 * Produces an `Injection` with:
 *   - flavor: `'steering'`
 *   - trigger: `{ kind: 'always' }`
 *   - inject: `{ systemPrompt: prompt }`
 *
 * @example
 *   const jsonOnly = defineSteering({
 *     id: 'json-only',
 *     description: 'Always respond with valid JSON.',
 *     prompt: 'Respond with JSON only. No prose. No markdown.',
 *   });
 */
import { resolveCachePolicy } from '../../../cache/applyCachePolicy.js';
export function defineSteering(opts) {
    if (!opts.id || opts.id.trim().length === 0) {
        throw new Error('defineSteering: `id` is required and must be non-empty.');
    }
    if (!opts.prompt || opts.prompt.length === 0) {
        throw new Error(`defineSteering(${opts.id}): \`prompt\` is required.`);
    }
    const cache = resolveCachePolicy('steering', opts.cache);
    return Object.freeze({
        id: opts.id,
        ...(opts.description && { description: opts.description }),
        flavor: 'steering',
        trigger: { kind: 'always' },
        inject: { systemPrompt: opts.prompt },
        metadata: Object.freeze({ cache }),
    });
}
//# sourceMappingURL=defineSteering.js.map