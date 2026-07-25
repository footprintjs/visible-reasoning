/**
 * MockProvider — deterministic LLMProvider for tests + examples.
 *
 * Pattern: Adapter (GoF, Design Patterns ch. 4).
 * Role:    Ports-and-Adapters outer ring (Cockburn, 2005) — implements the
 *          LLMProvider port without calling out to a real LLM service.
 * Emits:   N/A (adapters don't emit; recorders observe them).
 *
 * Two modes, same provider:
 *   • DEFAULT (no latency options)  — instant `complete()`, no streaming.
 *     Use in unit tests; behavior unchanged from earlier revisions.
 *   • REALISTIC (`thinkingMs` set)  — randomised "thinking" latency before
 *     the response, plus a `stream()` implementation that emits the
 *     content word-by-word with `chunkDelayMs` between chunks. Lets
 *     consumers SEE the run unfold (pauses, streaming tokens, tool
 *     dispatch) instead of having every step finish in microseconds.
 *
 * Realistic mode is the right default for the playground / Lens demos:
 * a real OpenAI / Anthropic call takes 3–8 s, so the UX you build for
 * that timing is what matters. Use `MockProvider.realistic()` for the
 * common 3–8 s thinking + 30–80 ms per word streaming preset.
 */
export class MockProvider {
    name;
    reply;
    replies;
    repliesCursor = 0;
    respond;
    thinkingMs;
    chunkDelayMs;
    stopReason;
    usageOverride;
    constructor(options = {}) {
        this.name = options.name ?? 'mock';
        this.reply = options.reply;
        this.replies = options.replies;
        this.respond =
            options.respond ??
                ((req) => {
                    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
                    return lastUser ? `echo: ${lastUser.content}` : '';
                });
        // `delayMs` is kept as an alias of `thinkingMs` for back-compat.
        this.thinkingMs = options.thinkingMs ?? options.delayMs ?? 0;
        this.chunkDelayMs = options.chunkDelayMs ?? 30;
        this.stopReason = options.stopReason ?? 'stop';
        this.usageOverride = options.usage;
    }
    /**
     * Reset the scripted-replies cursor. Useful when reusing one
     * `MockProvider` instance across multiple test scenarios — each
     * scenario can `provider.resetReplies()` to start from `replies[0]`
     * again. No-op when `replies` was not supplied.
     */
    resetReplies() {
        this.repliesCursor = 0;
    }
    /**
     * Convenience factory for the playground / Lens demo defaults: a
     * real-feel mock with 3–8 s of "thinking" before the response and
     * 30–80 ms per streamed word. Lets users observe pause/resume,
     * streaming, and tool dispatch happening live without hitting a
     * paid API.
     */
    static realistic(options = {}) {
        return new MockProvider({
            thinkingMs: [3000, 8000],
            chunkDelayMs: [30, 80],
            ...options,
        });
    }
    async complete(req) {
        await sleep(pickMs(this.thinkingMs), req.signal);
        return this.buildResponse(req);
    }
    /**
     * Streaming mode — emits the response content word-by-word so
     * consumers (Lens commentary, chat UIs) can render tokens as they
     * arrive. Tool calls land all at once on the final chunk because
     * that is how real providers (OpenAI, Anthropic) deliver them too.
     */
    async *stream(req) {
        await sleep(pickMs(this.thinkingMs), req.signal);
        const response = this.buildResponse(req);
        const tokens = tokenizeWords(response.content);
        let tokenIndex = 0;
        for (const tok of tokens) {
            yield { tokenIndex: tokenIndex++, content: tok, done: false };
            // Inter-chunk delay AFTER yielding so the first token shows up
            // immediately once thinking is done — matches OpenAI's pattern.
            await sleep(pickMs(this.chunkDelayMs), req.signal);
        }
        // Final chunk carries the authoritative LLMResponse (toolCalls,
        // usage, stopReason). Agent uses this to drive the ReAct loop
        // without needing a separate `complete()` round-trip. Real
        // streaming providers (Anthropic SSE, OpenAI delta) deliver
        // tool_use deltas across chunks; we collapse to the terminal-chunk
        // shape here because it's the simplest contract that lets one
        // call serve both UI streaming AND ReAct decisioning.
        yield { tokenIndex, content: '', done: true, response };
    }
    buildResponse(req) {
        const raw = this.consumeNextReply(req);
        const partial = typeof raw === 'string' ? { content: raw } : raw;
        const content = partial.content ?? '';
        const toolCalls = partial.toolCalls ?? [];
        const inputChars = messagesChars(req.messages) + (req.systemPrompt?.length ?? 0);
        const outputChars = content.length;
        return {
            content,
            toolCalls,
            usage: partial.usage ?? {
                input: this.usageOverride?.input ?? Math.ceil(inputChars / 4),
                output: this.usageOverride?.output ?? Math.ceil(outputChars / 4),
                ...(this.usageOverride?.cacheRead !== undefined && {
                    cacheRead: this.usageOverride.cacheRead,
                }),
                ...(this.usageOverride?.cacheWrite !== undefined && {
                    cacheWrite: this.usageOverride.cacheWrite,
                }),
            },
            stopReason: partial.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : this.stopReason),
        };
    }
    /**
     * Resolve the next reply source for one `complete()` / `stream()` call.
     * Priority: `replies` (scripted, throws on exhaustion) → `reply` (single
     * fixed string) → `respond` (callback default). Replies are consumed
     * in order; the cursor is per-instance, not per-request.
     */
    consumeNextReply(req) {
        if (this.replies !== undefined) {
            if (this.repliesCursor >= this.replies.length) {
                throw new Error(`MockProvider[${this.name}] exhausted: scripted ${this.replies.length} replies ` +
                    `but received request #${this.repliesCursor + 1}. Add more entries to ` +
                    `\`replies\` or bound the agent with \`maxIterations\`. ` +
                    `Call \`provider.resetReplies()\` to rewind across test scenarios.`);
            }
            // Cursor was just bounds-checked above (`>= replies.length` throws).
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const next = this.replies[this.repliesCursor];
            this.repliesCursor++;
            return next;
        }
        if (this.reply !== undefined)
            return this.reply;
        return this.respond(req);
    }
}
/**
 * Lowercase factory for `MockProvider` — matches the v1 `mock()` import
 * shape so docs and quick-starts stay copy-pasteable. Equivalent to
 * `new MockProvider(options)`.
 *
 * @example
 *   import { Agent, defineTool } from 'agentfootprint'
import { mock } from 'agentfootprint/llm-providers';
 *
 *   const agent = Agent.create({ provider: mock({ reply: 'hello' }) })
 *     .tool(defineTool({ name: 'echo', ... }))
 *     .build();
 */
export function mock(options = {}) {
    return new MockProvider(options);
}
// ── Helpers ─────────────────────────────────────────────────────────
/** Pick a delay in ms — fixed when given a number, uniformly random
 *  when given a `[min, max]` tuple. */
function pickMs(spec) {
    if (typeof spec === 'number')
        return Math.max(0, spec);
    const [min, max] = spec;
    if (max <= min)
        return Math.max(0, min);
    return Math.floor(min + Math.random() * (max - min));
}
/** AbortSignal-aware sleep. Resolves on timeout OR rejects on abort. */
function sleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('Aborted'));
            return;
        }
        const id = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(id);
            // onAbort is registered only when signal is defined (line below);
            // accessing signal.reason here is structurally guaranteed.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            reject(signal.reason ?? new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** Split content into streamable units that read like real tokens —
 *  whitespace-preserving word chunks. Empty content yields zero chunks. */
function tokenizeWords(content) {
    if (content.length === 0)
        return [];
    // Split on whitespace, preserve the delimiter so concatenating the
    // chunks reconstructs the original string exactly.
    const out = [];
    for (const m of content.matchAll(/\S+\s*/g))
        out.push(m[0]);
    // Edge case: leading whitespace before the first word.
    const firstNonSpace = content.search(/\S/);
    if (firstNonSpace > 0)
        out.unshift(content.slice(0, firstNonSpace));
    return out;
}
function messagesChars(messages) {
    let n = 0;
    for (const m of messages)
        n += m.content.length;
    return n;
}
//# sourceMappingURL=MockProvider.js.map