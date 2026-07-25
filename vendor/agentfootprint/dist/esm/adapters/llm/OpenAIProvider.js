/**
 * OpenAIProvider — wraps the `openai` SDK as an `LLMProvider`.
 *
 * Pattern: Adapter (GoF) + Ports-and-Adapters (Cockburn 2005).
 * Role:    Outer ring — translates `LLMRequest`/`LLMResponse` to/from
 *          OpenAI's Chat Completions API. Knows nothing about agents,
 *          recorders, or compositions.
 * Emits:   N/A.
 *
 * ─── Limitations ────────────────────────────────────────────────────
 *
 * • Multi-modal NOT supported  (`LLMMessage.content` is
 *   `string`). May extend in a future release.
 * • `responseFormat` (JSON-mode) NOT exposed  — pass schema
 *   instructions via `systemPrompt` for now.
 *
 * The `baseURL` option enables OpenAI-compatible APIs (Ollama, Together,
 * Groq, vLLM, LM Studio) without a separate adapter — see the `ollama()`
 * convenience factory below.
 */
import { lazyRequire } from '../../lib/lazyRequire.js';
/**
 * Build an `LLMProvider` backed by OpenAI's Chat Completions API.
 *
 * @example
 *   import { Agent } from 'agentfootprint';
 *   import { openai } from 'agentfootprint/llm-providers';
 *
 *   const agent = Agent.create({
 *     provider: openai({ defaultModel: 'gpt-4o' }),
 *     model: 'openai',
 *   })
 *     .tool(searchTool)
 *     .build();
 */
export function openai(options = {}) {
    const client = resolveClient(options);
    const defaultModel = options.defaultModel ?? 'gpt-4o-mini';
    const defaultMaxTokens = options.defaultMaxTokens;
    // A custom baseURL means an OpenAI-COMPATIBLE endpoint (Ollama/vLLM/Together/Groq),
    // which may only accept the legacy `max_tokens` and may not support `stream_options`.
    // Real OpenAI (no baseURL) and Azure (via injected _client, also no baseURL) get the
    // modern params. Reasoning detection is per-request (model id) OR the explicit flag.
    const legacyEndpoint = !!options.baseURL;
    const reasoning = options.reasoning ?? false;
    const cfg = { defaultModel, defaultMaxTokens, legacyEndpoint, reasoning };
    const provider = {
        name: 'openai',
        async complete(req) {
            const params = buildParams(req, { ...cfg, stream: false });
            try {
                const response = (await client.chat.completions.create(params));
                return fromOpenAIResponse(response);
            }
            catch (err) {
                throw wrapError(err);
            }
        },
        async *stream(req) {
            const params = buildParams(req, { ...cfg, stream: true });
            let stream;
            try {
                stream = client.chat.completions.create(params);
            }
            catch (err) {
                throw wrapError(err);
            }
            // Accumulate the streamed pieces so we can synthesize the
            // authoritative LLMResponse on the terminal chunk. OpenAI streams
            // tool_calls in chunks too — assemble id/name/args by index.
            const textParts = [];
            const toolCallsByIndex = new Map();
            let lastFinishReason = null;
            let lastUsage;
            let lastId = '';
            let tokenIndex = 0;
            try {
                for await (const chunk of stream) {
                    const choice = chunk.choices[0];
                    if (!choice)
                        continue;
                    if (chunk.id)
                        lastId = chunk.id;
                    if (chunk.usage)
                        lastUsage = chunk.usage;
                    if (choice.finish_reason)
                        lastFinishReason = choice.finish_reason;
                    const delta = choice.delta;
                    if (delta.content) {
                        textParts.push(delta.content);
                        yield { tokenIndex, content: delta.content, done: false };
                        tokenIndex++;
                    }
                    if (delta.tool_calls) {
                        for (const tcDelta of delta.tool_calls) {
                            const idx = tcDelta.index;
                            const existing = toolCallsByIndex.get(idx) ?? { id: '', name: '', argsJson: '' };
                            if (tcDelta.id)
                                existing.id = tcDelta.id;
                            if (tcDelta.function?.name)
                                existing.name = tcDelta.function.name;
                            if (tcDelta.function?.arguments)
                                existing.argsJson += tcDelta.function.arguments;
                            toolCallsByIndex.set(idx, existing);
                        }
                    }
                }
                const toolCalls = Array.from(toolCallsByIndex.values()).map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    args: parseArgs(tc.argsJson),
                }));
                const response = {
                    content: textParts.join(''),
                    toolCalls,
                    usage: {
                        input: lastUsage?.prompt_tokens ?? 0,
                        output: lastUsage?.completion_tokens ?? 0,
                    },
                    stopReason: normalizeStopReason(lastFinishReason ?? 'stop'),
                    providerRef: lastId,
                };
                yield { tokenIndex, content: '', done: true, response };
            }
            catch (err) {
                throw wrapError(err);
            }
        },
    };
    return provider;
}
/**
 * Class form for consumers who prefer `new OpenAIProvider(...)`.
 */
export class OpenAIProvider {
    name = 'openai';
    inner;
    constructor(options = {}) {
        this.inner = openai(options);
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
/** Shorthand model ids that resolve to the configured deployment. */
const AZURE_MODEL_SHORTHANDS = new Set(['azure', 'azure-openai', 'openai']);
/**
 * Build an `LLMProvider` for **Azure OpenAI**.
 *
 * Azure is NOT a drop-in OpenAI-compatible URL — it uses a deployment-scoped
 * path, `api-key` header auth, and an `api-version` query param. This wraps the
 * `openai` SDK's `AzureOpenAI` client (which handles all that) and reuses the
 * exact same completion/streaming/tool-call logic as `openai()`.
 *
 * The request's `model` is the Azure **deployment** name. Pass a deployment id
 * to target it; the shorthands `'azure'` / `'azure-openai'` resolve to the
 * configured default `deployment`.
 *
 * @example
 *   import { azureOpenai } from 'agentfootprint/llm-providers';
 *
 *   const agent = Agent.create({
 *     provider: azureOpenai({
 *       endpoint: process.env.OPENAI_BASE_URL,            // *.openai.azure.com
 *       apiKey: process.env.AZURE_OPENAI_API_KEY,
 *       apiVersion: process.env.AZURE_OPENAI_API_VERSION, // 2024-12-01-preview
 *       deployment: process.env.MODEL_NAME,               // gpt-4o-128k
 *     }),
 *     model: 'azure',
 *   }).build();
 */
export function azureOpenai(options = {}) {
    const client = resolveAzureClient(options);
    const deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT ?? process.env.MODEL_NAME;
    if (!deployment) {
        throw new Error('azureOpenai: a `deployment` is required (or set AZURE_OPENAI_DEPLOYMENT / MODEL_NAME).');
    }
    // Reuse ALL of openai()'s logic via the injected client; defaultModel is the
    // deployment so shorthand model ids resolve to it.
    const inner = openai({
        _client: client,
        defaultModel: deployment,
        ...(options.reasoning !== undefined && { reasoning: options.reasoning }),
        ...(options.defaultMaxTokens !== undefined && { defaultMaxTokens: options.defaultMaxTokens }),
    });
    // Azure's "model" IS the deployment — rewrite shorthand ids to it; a concrete
    // deployment id passes through (so you can target multiple deployments).
    const withDeployment = (req) => AZURE_MODEL_SHORTHANDS.has(req.model) ? { ...req, model: deployment } : req;
    return {
        name: 'azure-openai',
        complete: (req) => inner.complete(withDeployment(req)),
        ...(inner.stream && {
            stream: (req) => inner.stream(withDeployment(req)),
        }),
    };
}
function resolveAzureClient(options) {
    if (options._client)
        return options._client;
    let AzureOpenAI;
    try {
        const mod = lazyRequire('openai');
        AzureOpenAI = (mod.AzureOpenAI ?? mod.default?.AzureOpenAI);
    }
    catch {
        throw new Error('azureOpenai requires the `openai` package.\n' +
            '  Install:  npm install openai\n' +
            '  Or pass `_client` for test injection.');
    }
    if (!AzureOpenAI) {
        throw new Error('azureOpenai needs `openai` >= 4.x (no `AzureOpenAI` export found).');
    }
    const endpoint = options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? process.env.OPENAI_BASE_URL;
    const apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
    const apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION;
    const deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT ?? process.env.MODEL_NAME;
    if (!endpoint) {
        throw new Error('azureOpenai: `endpoint` is required (or set AZURE_OPENAI_ENDPOINT / OPENAI_BASE_URL), ' +
            'e.g. https://my-co.openai.azure.com');
    }
    if (!apiVersion) {
        throw new Error('azureOpenai: `apiVersion` is required (or set AZURE_OPENAI_API_VERSION), e.g. 2024-12-01-preview.');
    }
    return new AzureOpenAI({
        endpoint,
        ...(apiKey && { apiKey }),
        apiVersion,
        ...(deployment && { deployment }),
    });
}
/**
 * Convenience factory for Ollama (OpenAI-compatible endpoint).
 *
 * @example
 *   import { ollama } from 'agentfootprint/llm-providers';
 *
 *   const provider = ollama({ defaultModel: 'llama3.2' });
 *   // Talks to http://localhost:11434/v1 by default.
 */
export function ollama(options = {}) {
    const host = options.host ?? 'http://localhost:11434';
    const inner = openai({
        ...options,
        baseURL: options.baseURL ?? `${host}/v1`,
        apiKey: options.apiKey ?? 'ollama', // Ollama ignores the key; SDK requires non-empty.
        defaultModel: options.defaultModel ?? 'llama3.2',
    });
    return { ...inner, name: 'ollama' };
}
// ─── Internals ──────────────────────────────────────────────────────
function resolveClient(options) {
    if (options._client)
        return options._client;
    let OpenAI;
    try {
        const mod = lazyRequire('openai');
        OpenAI = (mod.default ?? mod.OpenAI ?? mod);
    }
    catch {
        throw new Error('OpenAIProvider requires the `openai` package.\n' +
            '  Install:  npm install openai\n' +
            '  Or pass `_client` for test injection.');
    }
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    return new OpenAI({ apiKey, ...(options.baseURL && { baseURL: options.baseURL }) });
}
/** o-series reasoning ids (o1, o1-mini, o3, o3-mini, o4-mini, o5, …). `gpt-4o`
 *  starts with `g`, so it is correctly NOT matched. */
function isReasoningModel(model) {
    return /^o\d/i.test(model);
}
function buildParams(req, cfg) {
    const model = req.model === 'openai' || req.model === 'ollama' ? cfg.defaultModel : req.model;
    const reasoning = cfg.reasoning || isReasoningModel(model);
    const params = {
        model,
        messages: toOpenAIMessages(req.messages, req.systemPrompt, reasoning),
    };
    if (cfg.stream) {
        params.stream = true;
        // OpenAI/Azure only emit usage while streaming when asked; without this the
        // synthesized response reports 0 tokens. Compatible endpoints may not support it.
        if (!cfg.legacyEndpoint)
            params.stream_options = { include_usage: true };
    }
    if (req.tools && req.tools.length > 0)
        params.tools = req.tools.map(toOpenAITool);
    const maxTokens = req.maxTokens ?? cfg.defaultMaxTokens;
    if (maxTokens !== undefined) {
        // `max_tokens` is deprecated and REJECTED by o-series; `max_completion_tokens` is
        // the current param (accepted by all OpenAI/Azure chat models). Custom compatible
        // endpoints may only accept `max_tokens`, so keep it there.
        if (cfg.legacyEndpoint)
            params.max_tokens = maxTokens;
        else
            params.max_completion_tokens = maxTokens;
    }
    // Reasoning models reject an explicit `temperature` (only the default is allowed).
    if (req.temperature !== undefined && !reasoning)
        params.temperature = req.temperature;
    if (req.stop && req.stop.length > 0)
        params.stop = [...req.stop];
    return params;
}
/**
 * messages → OpenAI messages.
 *
 * Roles map 1:1: system/user/assistant/tool. For reasoning models the system role
 * becomes `developer` (its replacement). Assistant turns with `toolCalls` get those
 * serialized into `message.tool_calls` (args JSON-stringified per OpenAI's contract).
 * Tool messages map to `role: 'tool'` with `tool_call_id`.
 */
function toOpenAIMessages(messages, systemPrompt, reasoning) {
    const systemRole = reasoning ? 'developer' : 'system';
    const result = [];
    // OpenAI accepts the system/developer role IN the messages array (unlike Anthropic's
    // separate `system` field). Prepend systemPrompt as the first such message; subsequent
    // in-message system entries pass through.
    if (systemPrompt) {
        result.push({ role: systemRole, content: systemPrompt });
    }
    for (const m of messages) {
        if (m.role === 'system') {
            result.push({ role: systemRole, content: m.content });
            continue;
        }
        if (m.role === 'user') {
            result.push({ role: 'user', content: m.content });
            continue;
        }
        if (m.role === 'assistant') {
            const msg = {
                role: 'assistant',
                content: m.content || null,
            };
            if (m.toolCalls && m.toolCalls.length > 0) {
                msg.tool_calls = m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.args),
                    },
                }));
            }
            result.push(msg);
            continue;
        }
        if (m.role === 'tool') {
            result.push({
                role: 'tool',
                content: m.content,
                tool_call_id: m.toolCallId ?? '',
            });
            continue;
        }
    }
    return result;
}
function toOpenAITool(schema) {
    return {
        type: 'function',
        function: {
            name: schema.name,
            description: schema.description,
            parameters: { ...schema.inputSchema },
        },
    };
}
function fromOpenAIResponse(response) {
    const choice = response.choices[0];
    if (!choice) {
        throw new Error('[openai] response missing choices[0]');
    }
    const message = choice.message;
    const toolCalls = (message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: parseArgs(tc.function.arguments),
    }));
    return {
        content: message.content ?? '',
        toolCalls,
        usage: {
            input: response.usage?.prompt_tokens ?? 0,
            output: response.usage?.completion_tokens ?? 0,
        },
        stopReason: normalizeStopReason(choice.finish_reason),
        providerRef: response.id,
    };
}
function parseArgs(json) {
    if (!json)
        return {};
    try {
        const parsed = JSON.parse(json);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    catch {
        // Malformed JSON in tool args is rare but observed; surface empty
        // args rather than crash. Consumers see the issue via the
        // (still-arriving) tool-call event.
        return {};
    }
}
function normalizeStopReason(raw) {
    switch (raw) {
        case 'stop':
            return 'stop';
        case 'tool_calls':
            return 'tool_use';
        case 'length':
            return 'max_tokens';
        case 'content_filter':
            return 'content_filter';
        default:
            return raw;
    }
}
function wrapError(err) {
    if (err instanceof Error) {
        return Object.assign(new Error(`[openai] ${err.message}`), {
            name: 'OpenAIProviderError',
            cause: err,
            status: err.status,
        });
    }
    return new Error(`[openai] ${String(err)}`);
}
//# sourceMappingURL=OpenAIProvider.js.map