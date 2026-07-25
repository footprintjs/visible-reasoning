/**
 * LLM provider adapters — implementation behind the `agentfootprint/llm-providers`
 * subpath (which re-exports this file).
 *
 * The standalone `agentfootprint/providers` subpath alias was removed in 4.0.0.
 * Import from the canonical subpath:
 *
 *   import { mock, anthropic, openai } from 'agentfootprint/llm-providers';
 *
 * Pattern: Adapter (GoF) — concrete `LLMProvider` implementations that
 *          translate the agentfootprint port to a specific vendor SDK.
 * Role:    Outer ring (Hexagonal). Swappable at runtime; the Agent
 *          knows nothing about vendor specifics.
 *
 * What's here today:
 *   • `mock` / `MockProvider` — deterministic + realistic-mode mock
 *   • `anthropic` / `AnthropicProvider` — real provider (Claude)
 *   • `openai` / `OpenAIProvider` — real provider (GPT)
 *
 * Bring your own (BYO):
 *   For Bedrock / Ollama / Cohere / on-prem / fine-tuned models,
 *   implement the `LLMProvider` interface (see `LLMProvider` exported
 *   from the main barrel) — `complete()` is required, `stream()` is
 *   optional. The `MockProvider` source is the canonical reference.
 */
export { MockProvider, mock, } from './adapters/llm/MockProvider.js';
export { anthropic, AnthropicProvider, } from './adapters/llm/AnthropicProvider.js';
export { openai, OpenAIProvider, ollama, azureOpenai, } from './adapters/llm/OpenAIProvider.js';
export { bedrock, BedrockProvider, } from './adapters/llm/BedrockProvider.js';
export { browserAnthropic, BrowserAnthropicProvider, } from './adapters/llm/BrowserAnthropicProvider.js';
export { browserOpenai, BrowserOpenAIProvider, browserAzureOpenai, BrowserAzureOpenAIProvider, } from './adapters/llm/BrowserOpenAIProvider.js';
export { createProvider, } from './adapters/llm/createProvider.js';
//# sourceMappingURL=providers.js.map