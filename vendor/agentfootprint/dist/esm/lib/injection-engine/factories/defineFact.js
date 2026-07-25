/**
 * defineFact — sugar for context-style Injections (data, not behavior).
 *
 * Use for developer-supplied facts the LLM should see in addition to
 * user messages and tool results. Examples: user profile, env info,
 * computed conversation summary, cached config, current time. Distinct
 * from Skills (LLM-activated guidance) and Steering (always-on rules)
 * in INTENT — they share the engine.
 *
 * Produces an `Injection` with:
 *   - flavor: `'fact'`
 *   - trigger: configurable (default `'always'`)
 *   - inject: targets `systemPrompt` OR `messages` (consumer chooses)
 *
 * @example
 *   const userProfile = defineFact({
 *     id: 'user-profile',
 *     data: `Name: ${user.name}, Plan: ${user.plan}, Joined: ${user.joinedAt}`,
 *   });
 *
 *   const turnTime = defineFact({
 *     id: 'turn-time',
 *     data: `Current time: ${new Date().toISOString()}`,
 *     slot: 'messages',
 *     role: 'system',
 *   });
 */
import { resolveCachePolicy } from '../../../cache/applyCachePolicy.js';
export function defineFact(opts) {
    if (!opts.id || opts.id.trim().length === 0) {
        throw new Error('defineFact: `id` is required and must be non-empty.');
    }
    if (!opts.data || opts.data.length === 0) {
        throw new Error(`defineFact(${opts.id}): \`data\` is required.`);
    }
    const trigger = opts.activeWhen
        ? { kind: 'rule', activeWhen: opts.activeWhen }
        : { kind: 'always' };
    const slot = opts.slot ?? 'system-prompt';
    const inject = slot === 'messages'
        ? { messages: [{ role: opts.role ?? 'system', content: opts.data }] }
        : { systemPrompt: opts.data };
    const cache = resolveCachePolicy('fact', opts.cache);
    // Two-stage cast (`as unknown as Injection`) is required because
    // `flavor: 'fact'` narrows tighter than `ContextSource`. Both stages
    // are type-safe at the call site — `flavor` IS a valid `ContextSource`
    // member; TypeScript just can't narrow back through the freeze.
    return Object.freeze({
        id: opts.id,
        ...(opts.description && { description: opts.description }),
        flavor: 'fact',
        trigger,
        inject,
        metadata: Object.freeze({ cache }),
    });
}
//# sourceMappingURL=defineFact.js.map