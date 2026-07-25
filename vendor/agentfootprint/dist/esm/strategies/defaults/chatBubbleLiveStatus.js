/**
 * `chatBubbleLiveStatus()` — default LiveStatusStrategy.
 *
 * Pattern: Strategy. Adapter for a consumer-supplied callback.
 * Role:    The "every chat UI" sink. Wraps a `(line: string) => void`
 *          callback so the consumer just hands us the function their
 *          chat-bubble component needs and we drive it on every
 *          rendered status update.
 *
 * Use when:
 *   - Building a chat UI (Neo, Lens, embedded widget) where the
 *     consumer owns rendering but not state derivation
 *   - Tier-1 of compose chains (`compose([chatBubble(setLine), stdout()])`
 *     so dev console mirrors what the user sees)
 *
 * The callback runs on EVERY status transition. Consumer can debounce
 * / coalesce per their needs (we don't impose UI policy).
 */
export function chatBubbleLiveStatus(opts) {
    return {
        name: 'chat-bubble',
        capabilities: { streaming: true },
        renderStatus(update) {
            opts.onLine(update.line);
        },
        validate() {
            if (typeof opts.onLine !== 'function') {
                throw new Error('chatBubbleLiveStatus: required `onLine` callback is missing or not a function. ' +
                    'Pass the function that should receive each rendered status line.');
            }
        },
    };
}
//# sourceMappingURL=chatBubbleLiveStatus.js.map