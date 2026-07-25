/**
 * BedrockProvider — wraps AWS Bedrock's Converse API as an `LLMProvider`.
 *
 * Pattern: Adapter (GoF) + Ports-and-Adapters (Cockburn 2005).
 * Role:    Outer ring — translates `LLMRequest`/`LLMResponse` to/from
 *          AWS Bedrock's model-agnostic Converse / ConverseStream APIs.
 *          Works with ANY Bedrock-hosted model (Claude, Llama, Mistral,
 *          Titan, Mixtral, ...) without format-specific code.
 * Emits:   N/A.
 *
 * Requires: `npm install @aws-sdk/client-bedrock-runtime`
 *
 * The Converse API is model-agnostic — one adapter covers every
 * Bedrock-hosted model (Claude, Llama, Mistral, Titan, Mixtral, ...).
 *
 * ─── Limitations ────────────────────────────────────────────────────
 *
 * • Multi-modal NOT supported  (text content only).
 * • Guardrail integration NOT exposed yet — pass via the SDK client
 *   directly if needed.
 */
import { lazyRequire } from '../../lib/lazyRequire.js';
export function bedrock(options = {}) {
    const { client, Commands } = resolveClient(options);
    const defaultModel = options.defaultModel ?? 'anthropic.claude-sonnet-4-5-20250929-v1:0';
    const defaultMaxTokens = options.defaultMaxTokens ?? 4096;
    const provider = {
        name: 'bedrock',
        async complete(req) {
            const input = buildInput(req, defaultModel, defaultMaxTokens);
            try {
                const cmd = new Commands.Converse(input);
                const response = (await client.send(cmd));
                return fromBedrockResponse(response);
            }
            catch (err) {
                throw wrapError(err);
            }
        },
        async *stream(req) {
            const input = buildInput(req, defaultModel, defaultMaxTokens);
            let response;
            try {
                const cmd = new Commands.ConverseStream(input);
                response = (await client.send(cmd));
            }
            catch (err) {
                throw wrapError(err);
            }
            const stream = response.stream;
            if (!stream) {
                // Some Bedrock models / regions don't support streaming —
                // fall back to a synthesized terminal chunk via complete().
                const final = await provider.complete(req);
                yield { tokenIndex: 0, content: '', done: true, response: final };
                return;
            }
            const textParts = [];
            let stopReason = 'stop';
            let usage = { input: 0, output: 0 };
            let tokenIndex = 0;
            try {
                for await (const event of stream) {
                    if (event.contentBlockDelta?.delta?.text) {
                        const text = event.contentBlockDelta.delta.text;
                        textParts.push(text);
                        yield { tokenIndex, content: text, done: false };
                        tokenIndex++;
                    }
                    if (event.messageStop?.stopReason) {
                        stopReason = normalizeStopReason(event.messageStop.stopReason);
                    }
                    if (event.metadata?.usage) {
                        usage = {
                            input: event.metadata.usage.inputTokens,
                            output: event.metadata.usage.outputTokens,
                        };
                    }
                }
                const finalResponse = {
                    content: textParts.join(''),
                    // Tool-call streaming is NOT yielded as deltas
                    // build — the consumer falls back to `complete()` to recover
                    // the authoritative tool_use payload. Most Bedrock streams
                    // currently emit tool_use only at messageEnd anyway.
                    toolCalls: [],
                    usage,
                    stopReason,
                };
                yield { tokenIndex, content: '', done: true, response: finalResponse };
            }
            catch (err) {
                throw wrapError(err);
            }
        },
    };
    return provider;
}
export class BedrockProvider {
    name = 'bedrock';
    inner;
    constructor(options = {}) {
        this.inner = bedrock(options);
    }
    complete(req) {
        return this.inner.complete(req);
    }
    stream(req) {
        if (!this.inner.stream)
            throw new Error('stream() unavailable');
        return this.inner.stream(req);
    }
}
// ─── Internals ──────────────────────────────────────────────────────
function resolveClient(options) {
    if (options._client && options._commands) {
        return { client: options._client, Commands: options._commands };
    }
    let mod;
    try {
        mod = lazyRequire('@aws-sdk/client-bedrock-runtime');
    }
    catch {
        throw new Error('BedrockProvider requires `@aws-sdk/client-bedrock-runtime`.\n' +
            '  Install:  npm install @aws-sdk/client-bedrock-runtime\n' +
            '  Or pass `_client` + `_commands` for test injection.');
    }
    return {
        client: new mod.BedrockRuntimeClient({ region: options.region }),
        Commands: { Converse: mod.ConverseCommand, ConverseStream: mod.ConverseStreamCommand },
    };
}
function buildInput(req, defaultModel, defaultMaxTokens) {
    const input = {
        modelId: req.model === 'bedrock' ? defaultModel : req.model,
        messages: toBedrockMessages(req.messages),
    };
    if (req.systemPrompt)
        input.system = [{ text: req.systemPrompt }];
    if (req.tools && req.tools.length > 0) {
        input.toolConfig = { tools: req.tools.map(toBedrockTool) };
    }
    const inference = {
        maxTokens: req.maxTokens ?? defaultMaxTokens,
    };
    if (req.temperature !== undefined)
        inference.temperature = req.temperature;
    if (req.stop && req.stop.length > 0)
        inference.stopSequences = [...req.stop];
    input.inferenceConfig = inference;
    return input;
}
function toBedrockMessages(messages) {
    const result = [];
    for (const m of messages) {
        if (m.role === 'system')
            continue; // system goes in `system` field
        if (m.role === 'user') {
            result.push({ role: 'user', content: [{ text: m.content }] });
            continue;
        }
        if (m.role === 'assistant') {
            const blocks = [];
            if (m.content)
                blocks.push({ text: m.content });
            if (m.toolCalls) {
                for (const tc of m.toolCalls) {
                    blocks.push({
                        toolUse: { toolUseId: tc.id, name: tc.name, input: { ...tc.args } },
                    });
                }
            }
            result.push({
                role: 'assistant',
                content: blocks.length > 0 ? blocks : [{ text: '' }],
            });
            continue;
        }
        if (m.role === 'tool') {
            const block = {
                toolResult: {
                    toolUseId: m.toolCallId ?? '',
                    content: [{ text: m.content }],
                },
            };
            const last = result[result.length - 1];
            if (last && last.role === 'user') {
                last.content.push(block);
            }
            else {
                result.push({ role: 'user', content: [block] });
            }
            continue;
        }
    }
    return result;
}
function toBedrockTool(schema) {
    return {
        toolSpec: {
            name: schema.name,
            description: schema.description,
            inputSchema: { json: { ...schema.inputSchema } },
        },
    };
}
function fromBedrockResponse(response) {
    const message = response.output?.message;
    const textParts = [];
    const toolCalls = [];
    if (message) {
        for (const block of message.content) {
            if ('text' in block && block.text)
                textParts.push(block.text);
            else if ('toolUse' in block && block.toolUse) {
                toolCalls.push({
                    id: block.toolUse.toolUseId,
                    name: block.toolUse.name,
                    args: block.toolUse.input,
                });
            }
        }
    }
    return {
        content: textParts.join(''),
        toolCalls,
        usage: {
            input: response.usage?.inputTokens ?? 0,
            output: response.usage?.outputTokens ?? 0,
        },
        stopReason: normalizeStopReason(response.stopReason ?? 'end_turn'),
        providerRef: response.ResponseMetadata?.RequestId,
    };
}
function normalizeStopReason(raw) {
    switch (raw) {
        case 'end_turn':
            return 'stop';
        case 'tool_use':
            return 'tool_use';
        case 'max_tokens':
            return 'max_tokens';
        case 'stop_sequence':
            return 'stop_sequence';
        case 'guardrail_intervened':
        case 'content_filtered':
            return 'content_filter';
        default:
            return raw;
    }
}
function wrapError(err) {
    if (err instanceof Error) {
        return Object.assign(new Error(`[bedrock] ${err.message}`), {
            name: 'BedrockProviderError',
            cause: err,
            status: err.$metadata?.httpStatusCode ??
                err.status,
        });
    }
    return new Error(`[bedrock] ${String(err)}`);
}
//# sourceMappingURL=BedrockProvider.js.map