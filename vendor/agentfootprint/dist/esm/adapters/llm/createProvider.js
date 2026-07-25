/**
 * createProvider — by-name factory for any built-in LLMProvider.
 *
 * Pattern: Abstract Factory (GoF) over the concrete provider factories.
 * Role:    Convenience entry point. Useful for config-driven setups
 *          where the provider is chosen at runtime (env var, feature
 *          flag, tenant preference).
 * Emits:   N/A.
 *
 * @example
 *   const kind = (process.env.LLM_PROVIDER ?? 'anthropic') as ProviderKind;
 *   const provider = createProvider({
 *     kind,
 *     apiKey: process.env.LLM_API_KEY,
 *     defaultModel: process.env.LLM_MODEL,
 *   } as CreateProviderOptions);
 *
 * For provider-specific options (Bedrock region, Ollama host, Browser
 * apiUrl, etc.) construct the underlying factory directly — this
 * helper deliberately exposes only the common subset.
 */
import { mock } from './MockProvider.js';
import { anthropic } from './AnthropicProvider.js';
import { openai, ollama, azureOpenai } from './OpenAIProvider.js';
import { bedrock } from './BedrockProvider.js';
import { browserAnthropic, } from './BrowserAnthropicProvider.js';
import { browserOpenai } from './BrowserOpenAIProvider.js';
/**
 * Build any built-in LLMProvider from a tagged options object.
 */
export function createProvider(options) {
    switch (options.kind) {
        case 'mock':
            return mock(options);
        case 'anthropic':
            return anthropic(options);
        case 'openai':
            return openai(options);
        case 'ollama':
            return ollama(options);
        case 'bedrock':
            return bedrock(options);
        case 'browser-anthropic':
            return browserAnthropic(options);
        case 'browser-openai':
            return browserOpenai(options);
        default: {
            // Exhaustiveness check — TypeScript will surface a missing case here.
            const _exhaustive = options;
            throw new Error(`createProvider: unknown kind ${JSON.stringify(_exhaustive.kind)}`);
        }
    }
}
/**
 * Resolve an `LLMProvider` from environment variables — drop your company's
 * values in `.env` and the right provider is configured automatically, with no
 * code branching. (Node only — reads `process.env`; the vendor SDK is lazy-loaded
 * only for the detected provider.)
 *
 * Detection order (first match wins):
 *   1. **Azure OpenAI** — `AZURE_OPENAI_API_KEY` + (`AZURE_OPENAI_ENDPOINT` |
 *      `OPENAI_BASE_URL`) [+ `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`|`MODEL_NAME`]
 *   2. **Anthropic** — `ANTHROPIC_API_KEY`
 *   3. **OpenAI** — `OPENAI_API_KEY`
 * Otherwise throws (or returns the mock when `{ fallbackToMock: true }`).
 *
 * @example
 *   import { providerFromEnv } from 'agentfootprint';
 *   const { provider, model, kind } = providerFromEnv({ fallbackToMock: true });
 *   const agent = Agent.create({ provider, model }).build();
 */
export function providerFromEnv(opts = {}) {
    const env = (typeof process !== 'undefined' ? process.env : {});
    const azureEndpoint = env.AZURE_OPENAI_ENDPOINT ?? env.OPENAI_BASE_URL;
    if (env.AZURE_OPENAI_API_KEY && azureEndpoint) {
        return {
            provider: azureOpenai({
                endpoint: azureEndpoint,
                apiKey: env.AZURE_OPENAI_API_KEY,
                ...(env.AZURE_OPENAI_API_VERSION && { apiVersion: env.AZURE_OPENAI_API_VERSION }),
                ...((env.AZURE_OPENAI_DEPLOYMENT ?? env.MODEL_NAME) && {
                    deployment: env.AZURE_OPENAI_DEPLOYMENT ?? env.MODEL_NAME,
                }),
            }),
            model: 'azure',
            kind: 'azure-openai',
        };
    }
    if (env.ANTHROPIC_API_KEY) {
        return {
            provider: anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
            model: env.LLM_MODEL ?? 'anthropic',
            kind: 'anthropic',
        };
    }
    if (env.OPENAI_API_KEY) {
        return {
            provider: openai({ apiKey: env.OPENAI_API_KEY }),
            model: env.LLM_MODEL ?? 'openai',
            kind: 'openai',
        };
    }
    if (opts.fallbackToMock) {
        return {
            provider: mock({ reply: 'mock reply (no provider env set)' }),
            model: 'mock',
            kind: 'mock',
        };
    }
    throw new Error('providerFromEnv: no provider credentials in the environment. Set one of:\n' +
        '  • Azure:     AZURE_OPENAI_API_KEY + (AZURE_OPENAI_ENDPOINT | OPENAI_BASE_URL)\n' +
        '               + AZURE_OPENAI_API_VERSION + (AZURE_OPENAI_DEPLOYMENT | MODEL_NAME)\n' +
        '  • Anthropic: ANTHROPIC_API_KEY\n' +
        '  • OpenAI:    OPENAI_API_KEY\n' +
        '  …or call providerFromEnv({ fallbackToMock: true }).');
}
//# sourceMappingURL=createProvider.js.map