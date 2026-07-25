/**
 * BrowserOpenAIProvider — fetch-based OpenAI adapter for browsers.
 *
 * Pattern: Adapter (GoF). Zero peer dependencies — uses global `fetch`.
 * Role:    Outer ring. Same `LLMProvider` contract as `OpenAIProvider`
 *          but skips the `openai` SDK. For prototypes / playgrounds.
 *          Production apps should proxy through a backend.
 * Emits:   N/A.
 *
 * Also works with OpenAI-compatible endpoints (Ollama, Together, vLLM)
 * via `apiUrl`.
 *
 * ─── Limitations ────────────────────────────────────────────────────
 *
 * • Multi-modal NOT supported.
 * • CORS depends on the endpoint — OpenAI requires the user-supplied
 *   key in the Authorization header, which they'll do explicitly.
 */
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
export function browserOpenai(options) {
    if (!options.apiKey) {
        throw new Error('BrowserOpenAIProvider requires `apiKey`. Browser providers do not read environment variables.');
    }
    const apiUrl = options.apiUrl ?? OPENAI_API_URL;
    const defaultModel = options.defaultModel ?? 'gpt-4o-mini';
    const defaultMaxTokens = options.defaultMaxTokens;
    const fetchImpl = options._fetch ?? fetch;
    // OpenAI (default URL) and Azure (`api-key` auth) get the modern params; a custom
    // bearer endpoint (Ollama/vLLM/…) keeps legacy `max_tokens` and no `stream_options`.
    const legacyEndpoint = apiUrl !== OPENAI_API_URL && options.authScheme !== 'api-key';
    const reasoningOpt = options.reasoning ?? false;
    const cfg = { defaultModel, defaultMaxTokens, legacyEndpoint, reasoning: reasoningOpt };
    const headers = { 'content-type': 'application/json' };
    if (options.authScheme === 'api-key') {
        headers['api-key'] = options.apiKey; // Azure OpenAI
    }
    else {
        headers['authorization'] = `Bearer ${options.apiKey}`;
    }
    if (options.organization)
        headers['openai-organization'] = options.organization;
    const provider = {
        name: 'browser-openai',
        async complete(req) {
            const body = buildBody(req, { ...cfg, stream: false });
            let response;
            try {
                response = await fetchImpl(apiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    ...(req.signal && { signal: req.signal }),
                });
            }
            catch (err) {
                throw wrapError(err);
            }
            if (!response.ok)
                throw await wrapStatus(response);
            const json = (await response.json());
            return fromOpenAIResponse(json);
        },
        async *stream(req) {
            const body = buildBody(req, { ...cfg, stream: true });
            let response;
            try {
                response = await fetchImpl(apiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    ...(req.signal && { signal: req.signal }),
                });
            }
            catch (err) {
                throw wrapError(err);
            }
            if (!response.ok)
                throw await wrapStatus(response);
            if (!response.body)
                throw new Error('[browser-openai] response has no body');
            const textParts = [];
            const toolCallsByIndex = new Map();
            let lastFinishReason = 'stop';
            let lastUsage;
            let lastId = '';
            let tokenIndex = 0;
            for await (const data of parseSSE(response.body)) {
                if (data === '[DONE]')
                    break;
                const chunk = data;
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
            const finalResponse = {
                content: textParts.join(''),
                toolCalls,
                usage: {
                    input: lastUsage?.prompt_tokens ?? 0,
                    output: lastUsage?.completion_tokens ?? 0,
                },
                stopReason: normalizeStopReason(lastFinishReason),
                providerRef: lastId,
            };
            yield { tokenIndex, content: '', done: true, response: finalResponse };
        },
    };
    return provider;
}
export class BrowserOpenAIProvider {
    name = 'browser-openai';
    inner;
    constructor(options) {
        this.inner = browserOpenai(options);
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
const AZURE_BROWSER_SHORTHANDS = new Set([
    'azure',
    'browser-azure-openai',
    'azure-openai',
    'openai',
]);
/**
 * Fetch-based **Azure OpenAI** provider for the browser/edge — no SDK, no Node.
 *
 * The browser can't use the Node `azureOpenai()` (it needs the `openai` SDK), so
 * use this in a browser "bring your own (company) key" flow. Builds the
 * deployment-scoped Azure URL + `api-key` header + `api-version`, and reuses all
 * of `browserOpenai()`'s body/streaming/tool logic. The request `model` is the
 * deployment; `'azure'` resolves to the configured `deployment`.
 *
 * **CORS:** an `*.openai.azure.com` resource may not allow direct browser calls;
 * if blocked, point `endpoint` at a same-origin proxy (e.g. a Vite `/azure`
 * proxy) or a backend. Same trade-off as `browserOpenai`.
 *
 * @example
 *   import { browserAzureOpenai } from 'agentfootprint/llm-providers';
 *   const provider = browserAzureOpenai({
 *     endpoint: 'https://my-co.openai.azure.com',
 *     apiKey: userKey, apiVersion: '2024-12-01-preview', deployment: 'gpt-4o-128k',
 *   });
 *   // Agent.create({ provider, model: 'azure' })
 */
export function browserAzureOpenai(options) {
    if (!options.apiKey)
        throw new Error('browserAzureOpenai requires `apiKey`.');
    if (!options.endpoint) {
        throw new Error('browserAzureOpenai requires `endpoint` (https://<resource>.openai.azure.com).');
    }
    if (!options.apiVersion) {
        throw new Error('browserAzureOpenai requires `apiVersion` (e.g. 2024-12-01-preview).');
    }
    if (!options.deployment) {
        throw new Error('browserAzureOpenai requires `deployment` (the Azure deployment name).');
    }
    const base = options.endpoint.replace(/\/+$/, '');
    const apiUrl = `${base}/openai/deployments/${encodeURIComponent(options.deployment)}` +
        `/chat/completions?api-version=${encodeURIComponent(options.apiVersion)}`;
    const inner = browserOpenai({
        apiKey: options.apiKey,
        apiUrl,
        authScheme: 'api-key',
        defaultModel: options.deployment,
        ...(options.reasoning !== undefined && { reasoning: options.reasoning }),
        ...(options.defaultMaxTokens !== undefined && { defaultMaxTokens: options.defaultMaxTokens }),
        ...(options._fetch && { _fetch: options._fetch }),
    });
    const withDeployment = (req) => AZURE_BROWSER_SHORTHANDS.has(req.model) ? { ...req, model: options.deployment } : req;
    return {
        name: 'browser-azure-openai',
        complete: (req) => inner.complete(withDeployment(req)),
        ...(inner.stream && {
            stream: (req) => inner.stream(withDeployment(req)),
        }),
    };
}
export class BrowserAzureOpenAIProvider {
    name = 'browser-azure-openai';
    inner;
    constructor(options) {
        this.inner = browserAzureOpenai(options);
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
/** o-series reasoning ids (o1, o3, o4-mini, …). `gpt-4o` starts with `g` — not matched. */
function isReasoningModel(model) {
    return /^o\d/i.test(model);
}
function buildBody(req, cfg) {
    const model = req.model === 'openai' || req.model === 'browser-openai' ? cfg.defaultModel : req.model;
    const reasoning = cfg.reasoning || isReasoningModel(model);
    const body = {
        model,
        messages: toOpenAIMessages(req.messages, req.systemPrompt, reasoning),
    };
    if (cfg.stream) {
        body.stream = true;
        // Without this OpenAI/Azure send no usage while streaming → 0-token accounting.
        if (!cfg.legacyEndpoint)
            body.stream_options = { include_usage: true };
    }
    if (req.tools && req.tools.length > 0)
        body.tools = req.tools.map(toOpenAITool);
    const max = req.maxTokens ?? cfg.defaultMaxTokens;
    if (max !== undefined) {
        // `max_tokens` is deprecated and rejected by o-series; `max_completion_tokens` is
        // current. Keep `max_tokens` only for custom compatible endpoints.
        if (cfg.legacyEndpoint)
            body.max_tokens = max;
        else
            body.max_completion_tokens = max;
    }
    // Reasoning models reject an explicit temperature.
    if (req.temperature !== undefined && !reasoning)
        body.temperature = req.temperature;
    if (req.stop && req.stop.length > 0)
        body.stop = [...req.stop];
    return body;
}
function toOpenAIMessages(messages, systemPrompt, reasoning) {
    const systemRole = reasoning ? 'developer' : 'system';
    const result = [];
    if (systemPrompt)
        result.push({ role: systemRole, content: systemPrompt });
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
            const msg = { role: 'assistant', content: m.content || null };
            if (m.toolCalls && m.toolCalls.length > 0) {
                msg.tool_calls = m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
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
    if (!choice)
        throw new Error('[browser-openai] response missing choices[0]');
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
/** Parse OpenAI's SSE stream — `data: ...\n\n` lines, `[DONE]` terminator. */
async function* parseSSE(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                for (const line of raw.split('\n')) {
                    if (!line.startsWith('data:'))
                        continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') {
                        yield '[DONE]';
                        return;
                    }
                    if (data) {
                        try {
                            yield JSON.parse(data);
                        }
                        catch {
                            /* skip malformed */
                        }
                    }
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
async function wrapStatus(response) {
    let bodyText = '';
    try {
        bodyText = await response.text();
    }
    catch {
        /* ignore */
    }
    return Object.assign(new Error(`[browser-openai] ${response.status} ${response.statusText} — ${bodyText.slice(0, 200)}`), { name: 'BrowserOpenAIProviderError', status: response.status });
}
function wrapError(err) {
    if (err instanceof Error) {
        return Object.assign(new Error(`[browser-openai] ${err.message}`), {
            name: 'BrowserOpenAIProviderError',
            cause: err,
        });
    }
    return new Error(`[browser-openai] ${String(err)}`);
}
//# sourceMappingURL=BrowserOpenAIProvider.js.map