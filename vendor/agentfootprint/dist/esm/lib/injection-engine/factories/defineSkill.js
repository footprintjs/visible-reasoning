/**
 * defineSkill — sugar for LLM-activated Injections that target both
 * system-prompt + tools.
 *
 * A Skill is a bundle of (1) a body of guidance and (2) optionally
 * unlocked tools. The LLM decides when a Skill is needed by calling
 * a designated activation tool — by default `read_skill(<id>)`.
 *
 * Produces an `Injection` with:
 *   - flavor: `'skill'`
 *   - trigger: `{ kind: 'llm-activated', viaToolName: 'read_skill' }`
 *   - inject: `{ systemPrompt: body, tools }`
 *
 * The Agent integration auto-attaches the `read_skill` tool when one
 * or more Skills are present. When the LLM calls
 * `read_skill('billing')`, the engine adds `'billing'` to
 * `ctx.activatedInjectionIds`; the next iteration's evaluator
 * matches this Skill's `id`, activates it, and the body + tools land
 * in the slot subflows.
 *
 * @example
 *   const billingSkill = defineSkill({
 *     id: 'billing',
 *     description: 'Use for refunds, charges, billing questions.',
 *     body: 'When handling billing: confirm identity first, then…',
 *     tools: [refundTool, chargeHistoryTool],
 *   });
 */
import { resolveCachePolicy } from '../../../cache/applyCachePolicy.js';
/**
 * Resolve `surfaceMode: 'auto'` to a concrete mode based on provider
 * + model. The defaults match the per-provider attention profile
 * documented in the Skills, explained essay:
 *
 *   - Claude >= 3.5  → 'both'      (cheap to cache, high adherence)
 *   - Claude pre-3.5 → 'tool-only' (recency-first more reliable)
 *   - OpenAI / Bedrock / Ollama / Mock / unknown → 'tool-only'
 *
 * Pure function — no side effects. Consumers can call directly to
 * inspect what `'auto'` will resolve to in their stack.
 */
export function resolveSurfaceMode(provider, model) {
    const p = provider.toLowerCase();
    if (p === 'anthropic') {
        // Match both naming styles in current use:
        //   - claude-3-5-sonnet-..., claude-3.5-...
        //   - claude-sonnet-4-..., claude-haiku-4-..., claude-opus-4-..., claude-4-...
        // Anything matching "Claude >= 3.5" gets 'both'; older Claudes get 'tool-only'.
        if (model && /(claude-3-5|claude-3\.5|claude-(?:opus-|sonnet-|haiku-)?[4-9])/i.test(model)) {
            return 'both';
        }
        return 'tool-only';
    }
    return 'tool-only';
}
export function defineSkill(opts) {
    if (!opts.id || opts.id.trim().length === 0) {
        throw new Error('defineSkill: `id` is required and must be non-empty.');
    }
    if (!opts.description || opts.description.length === 0) {
        throw new Error(`defineSkill(${opts.id}): \`description\` is required (LLM uses it to decide when to activate).`);
    }
    if (!opts.body || opts.body.length === 0) {
        throw new Error(`defineSkill(${opts.id}): \`body\` is required.`);
    }
    return Object.freeze({
        id: opts.id,
        description: opts.description,
        flavor: 'skill',
        trigger: {
            kind: 'llm-activated',
            viaToolName: opts.viaToolName ?? 'read_skill',
        },
        inject: {
            systemPrompt: opts.body,
            ...(opts.tools && opts.tools.length > 0 && { tools: opts.tools }),
        },
        // Skill-specific options live in metadata. The engine reads them
        // when present; absent metadata = current behavior. Forward-compat:
        // when v2.5 implements per-mode routing diversity, this field is
        // already where the runtime looks.
        //
        // `cache` joins the metadata bag in v2.6 — CacheDecision subflow
        // reads `metadata.cache` to know how to treat this skill's body.
        metadata: Object.freeze({
            surfaceMode: opts.surfaceMode ?? 'auto',
            ...(opts.refreshPolicy && { refreshPolicy: opts.refreshPolicy }),
            ...(opts.autoActivate && { autoActivate: opts.autoActivate }),
            cache: resolveCachePolicy('skill', opts.cache),
        }),
    });
}
//# sourceMappingURL=defineSkill.js.map