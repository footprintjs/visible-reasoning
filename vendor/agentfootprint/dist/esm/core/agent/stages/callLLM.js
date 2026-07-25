/**
 * callLLM — the LLM-invocation stage of the agent's chart.
 *
 * Reads the assembled prompt + messages from scope (populated by the
 * upstream slot subflows: SystemPrompt, Messages, Tools, CacheDecision,
 * CacheGate). Calls `provider.stream()` if available (token streaming
 * with per-chunk events) else falls back to `provider.complete()`.
 * Writes the response to scope (`llmLatestContent`, `llmLatestToolCalls`,
 * cumulative tokens) for the downstream Route decider to read.
 *
 * Emits `agentfootprint.stream.llm_start` + `llm_end` brackets for
 * observability adapters and per-chunk `stream.token` events during
 * streaming. Emits `cost.tick` via `emitCostTick` when a `pricingTable`
 * is configured.
 *
 * Factory signature so the chart-build-time provider/model/etc. deps
 * are explicit. The `toolSchemas` value is late-bound via a getter
 * because tool schema composition completes after the seed factory is
 * built but before the chart actually runs.
 */
import { typedEmit } from '../../../recorders/core/typedEmit.js';
import { emitCostTick } from '../../cost.js';
import { applyOutputSchema } from '../../outputSchema.js';
import { executeWithReliability, ValidationFailure, } from './reliabilityExecution.js';
/**
 * Build the callLLM stage function. Captures the LLM provider + model
 * config + cache strategy via the deps object; everything per-iteration
 * comes from scope.
 */
export function buildCallLLMStage(deps) {
    return async (scope) => {
        const systemPromptInjections = scope.systemPromptInjections ?? [];
        // `scope.messagesInjections` is read by ContextRecorder for
        // observability; the LLM-wire path now reads scope.history directly.
        const iteration = scope.iteration;
        // Per-iteration boundary marker (was a dedicated `IterationStart` stage —
        // folded here since emitting is passive observability, not work that needs
        // its own execution stage). Fires FIRST, before the LLM call, so recorders
        // still bracket each ReAct iteration. Payload unchanged (turnIndex reserved
        // for future multi-turn; iterIndex is the per-iteration counter).
        typedEmit(scope, 'agentfootprint.agent.iteration_start', {
            turnIndex: 0,
            iterIndex: iteration,
        });
        const systemPrompt = systemPromptInjections
            .map((r) => r.rawContent ?? '')
            .filter((s) => s.length > 0)
            .join('\n\n');
        // Read the LLM message stream from `scope.history` directly. The
        // `messagesInjections` projection is for observability — it
        // flattens InjectionRecords for event reporting and doesn't carry
        // the full LLM-protocol shape (assistant `toolCalls[]`, etc.). For
        // Anthropic's API contract we need the original LLMMessage with
        // `toolCalls` intact so tool_use → tool_result correlation survives.
        const messages = scope.history ?? [];
        // Dynamic schemas — registry tools + injection-supplied tools (Skills'
        // `inject.tools` when their Injection is active). Falls back to the static
        // schemas at startup before the tools slot has run. Computed BEFORE the
        // llm_start emit so the event reports what the model ACTUALLY saw this call
        // (count + the name/description catalog), not the static startup set.
        const activeToolSchemas = scope.dynamicToolSchemas ?? deps.toolSchemas;
        typedEmit(scope, 'agentfootprint.stream.llm_start', {
            iteration,
            provider: deps.provider.name,
            model: deps.model,
            systemPromptChars: systemPrompt.length,
            messagesCount: messages.length,
            toolsCount: activeToolSchemas.length,
            ...(activeToolSchemas.length > 0 && {
                tools: activeToolSchemas.map((t) => ({
                    name: t.name,
                    ...(t.description ? { description: t.description } : {}),
                })),
            }),
            ...(deps.temperature !== undefined && { temperature: deps.temperature }),
        });
        const startMs = Date.now();
        const baseRequest = {
            ...(systemPrompt.length > 0 && { systemPrompt }),
            messages,
            ...(activeToolSchemas.length > 0 && { tools: activeToolSchemas }),
            model: deps.model,
            ...(deps.temperature !== undefined && { temperature: deps.temperature }),
            ...(deps.maxTokens !== undefined && { maxTokens: deps.maxTokens }),
            ...(deps.thinkingBudget !== undefined && {
                thinking: { budget: deps.thinkingBudget },
            }),
        };
        // v2.6+ — call cache strategy to attach provider-specific cache
        // hints. CacheGate has already routed (apply-markers / no-markers)
        // and populated scope.cacheMarkers accordingly. Strategy.prepareRequest
        // is a pass-through for empty markers.
        const cacheMarkers = scope.cacheMarkers ?? [];
        const cachePrepared = await deps.cacheStrategy.prepareRequest(baseRequest, cacheMarkers, {
            iteration,
            iterationsRemaining: Math.max(0, deps.maxIterations - iteration),
            recentHitRate: scope.recentHitRate,
            cachingDisabled: scope.cachingDisabled ?? false,
        });
        const llmRequest = cachePrepared.request;
        // Streaming-first: when the provider implements `stream()` we
        // consume chunk-by-chunk so consumers see tokens as they arrive
        // instead of waiting for the full LLM call to finish. Each
        // non-terminal chunk fires `agentfootprint.stream.token`. The
        // terminal chunk SHOULD carry the authoritative `LLMResponse`;
        // when it doesn't (older providers, partial implementations) we
        // fall back to `complete()` for the authoritative payload —
        // keeping the ReAct loop deterministic.
        //
        // `singleProviderCall` is the per-attempt call function. Used
        // directly when reliability is OFF; passed into `executeWithReliability`
        // when reliability is configured (the helper invokes it once per
        // retry-loop iteration).
        const singleProviderCall = async (req, hooks) => {
            let resp;
            let firstChunkFired = false;
            if (deps.provider.stream) {
                for await (const chunk of deps.provider.stream(req)) {
                    if (chunk.done) {
                        if (chunk.response)
                            resp = chunk.response;
                        break;
                    }
                    if (chunk.content.length > 0) {
                        if (!firstChunkFired) {
                            firstChunkFired = true;
                            hooks.onFirstChunk?.();
                        }
                        typedEmit(scope, 'agentfootprint.stream.token', {
                            iteration,
                            tokenIndex: chunk.tokenIndex,
                            content: chunk.content,
                        });
                    }
                }
            }
            if (!resp) {
                // No `stream()` OR stream finished without a response payload.
                // Raw errors propagate so the reliability loop can classify them;
                // friendly translation happens at the terminal ErrorBridge.
                resp = await deps.provider.complete(req);
            }
            return resp;
        };
        // v2.13 — build the output-schema validator hook when both
        // reliability + outputSchemaParser are configured. The reliability
        // loop applies the validator only on terminal turns (toolCalls
        // empty) so tool-using turns aren't rejected for failing the final-
        // answer schema. ValidationFailure carries `stage` + `path` for the
        // typed event payload.
        let postValidate;
        if (deps.outputSchemaParser !== undefined) {
            const parser = deps.outputSchemaParser;
            postValidate = (response) => {
                try {
                    applyOutputSchema(response.content, parser);
                }
                catch (err) {
                    // applyOutputSchema throws OutputSchemaError with
                    // {stage, rawOutput, cause}. Convert to ValidationFailure for
                    // the gate's typed handling. Pull a `path` if the underlying
                    // cause exposes Zod-style issues. Use the cause's message
                    // (the actual parser error) when available, falling back to
                    // the wrapper's message for parsers without a cause.
                    const e = err;
                    let path;
                    const firstIssue = e.cause?.issues?.[0];
                    if (firstIssue?.path && firstIssue.path.length > 0) {
                        path = firstIssue.path.join('.');
                    }
                    // Use cause message when present (parsers like Zod attach the
                    // real error as cause); fall back to wrapper message.
                    const message = e.cause?.message ?? e.message;
                    throw new ValidationFailure({
                        message,
                        stage: e.stage ?? 'schema-validate',
                        ...(path !== undefined && { path }),
                        ...(e.rawOutput !== undefined && { rawOutput: e.rawOutput }),
                    });
                }
            };
        }
        let response;
        if (deps.reliability) {
            response = await executeWithReliability(scope, llmRequest, deps.reliability, deps.provider, deps.provider.name, deps.model, singleProviderCall, postValidate);
            // `executeWithReliability` returns `undefined` when it took the
            // fail-fast path. It already wrote scope state and called
            // `$break(reason)` — `Agent.run()` translates the propagated
            // break into a `ReliabilityFailFastError` at the API boundary.
            // Skip the post-call state writes; there is no response to commit.
            if (response === undefined)
                return;
        }
        else {
            response = await singleProviderCall(llmRequest, {});
        }
        const durationMs = Date.now() - startMs;
        scope.totalInputTokens = scope.totalInputTokens + response.usage.input;
        scope.totalOutputTokens = scope.totalOutputTokens + response.usage.output;
        scope.llmLatestContent = response.content;
        scope.llmLatestToolCalls = response.toolCalls;
        // v2.14 — hand provider-specific raw thinking data to the
        // NormalizeThinking sub-subflow (the next stage in sf-call-llm
        // when a ThinkingHandler is configured). Undefined when the
        // provider has no thinking content for this call (most calls).
        if (response.rawThinking !== undefined) {
            scope.rawThinking =
                response.rawThinking;
        }
        typedEmit(scope, 'agentfootprint.stream.llm_end', {
            iteration,
            content: response.content,
            toolCallCount: response.toolCalls.length,
            usage: response.usage,
            stopReason: response.stopReason,
            durationMs,
        });
        emitCostTick(scope, deps.pricingTable, deps.costBudget, deps.model, response.usage);
    };
}
//# sourceMappingURL=callLLM.js.map