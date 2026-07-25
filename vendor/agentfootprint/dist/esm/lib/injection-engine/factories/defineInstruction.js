/**
 * defineInstruction — sugar for rule-based system-prompt Injections.
 *
 * The most flexible Instruction-style flavor: a predicate decides
 * activation each iteration. Use for "if condition X is true, give
 * the LLM this guidance". Compared to:
 *   - Steering (always-on, no predicate)
 *   - Skill (LLM-activated via `read_skill`)
 *   - on-tool-return (specific tool just ran — Dynamic ReAct)
 *
 * Produces an `Injection` with:
 *   - flavor: `'instructions'`
 *   - trigger: `{ kind: 'rule', activeWhen }` (or `'always'` if omitted)
 *   - inject: `{ systemPrompt: prompt }`
 *
 * @example
 *   const calmTone = defineInstruction({
 *     id: 'calm-tone',
 *     description: 'Use a calm, empathetic tone with frustrated users.',
 *     activeWhen: (ctx) => /upset|angry|frustrated/.test(ctx.userMessage),
 *     prompt: 'Acknowledge feelings before facts. Avoid corporate jargon.',
 *   });
 *
 *   const piiAfterRedact = defineInstruction({
 *     id: 'pii-after-redact',
 *     activeWhen: (ctx) => ctx.lastToolResult?.toolName === 'redact_pii',
 *     prompt: 'PII has been redacted. Do not include emails or phone numbers.',
 *   });
 */
import { resolveCachePolicy } from '../../../cache/applyCachePolicy.js';
export function defineInstruction(opts) {
    if (!opts.id || opts.id.trim().length === 0) {
        throw new Error('defineInstruction: `id` is required and must be non-empty.');
    }
    if (!opts.prompt || opts.prompt.length === 0) {
        throw new Error(`defineInstruction(${opts.id}): \`prompt\` is required.`);
    }
    const trigger = opts.activeWhen
        ? { kind: 'rule', activeWhen: opts.activeWhen }
        : { kind: 'always' };
    const slot = opts.slot ?? 'system-prompt';
    const inject = slot === 'messages'
        ? { messages: [{ role: opts.role ?? 'system', content: opts.prompt }] }
        : { systemPrompt: opts.prompt };
    const cache = resolveCachePolicy('instruction', opts.cache);
    return Object.freeze({
        id: opts.id,
        ...(opts.description && { description: opts.description }),
        flavor: 'instructions',
        trigger,
        inject,
        metadata: Object.freeze({ cache }),
    });
}
//# sourceMappingURL=defineInstruction.js.map