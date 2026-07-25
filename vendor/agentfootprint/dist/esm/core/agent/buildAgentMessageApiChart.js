/**
 * buildAgentMessageApiChart — the Agent (ReAct) form of the messageAPI
 * merge-tree, as ONE FLAT main chart (no inner LLM-call sub-box).
 *
 * The whole ReAct cycle lives directly in the single Agent chart:
 *
 *   Context (ROOT selector — inits + picks which context slots to engineer)
 *     ├─ system-prompt ┐
 *     ├─ messages ─────┼─→ messageAPI → Call-LLM
 *     └─ tools ────────┘
 *        → Route (decider) → [ ToolCalls (execute) → loop ] / Final (response)
 *   loopTo(Context)
 *
 * WHY flat (the user's call): the entire agent — context engineering, the LLM
 * call, routing, tool execution, the loop, and the final response — is ONE
 * visible flowchart in ONE Agent box. No nested LLM-call box: Lens wraps the
 * whole chart in the Agent main-box and renders the slots as pills. This is
 * simpler than the composed (sf-llm-call subflow) shape and avoids box-in-box
 * nesting entirely.
 *
 * The three context slots are DIRECT children of Context; all converge at
 * messageAPI (which assembles system-prompt + messages); Call-LLM then sends
 * the assembled payload plus the tool schemas. Route decides tool-calls (loop)
 * vs final (terminate). The same chart serves Static and Dynamic agents — only
 * which slots the Context selector lights per iteration differs.
 */
import { flowChartSelector, select } from 'footprintjs';
import { SUBFLOW_IDS } from '../../conventions.js';
import { typedEmit } from '../../recorders/core/typedEmit.js';
import { buildSystemPromptSlot } from '../slots/buildSystemPromptSlot.js';
import { buildMessagesSlot } from '../slots/buildMessagesSlot.js';
import { buildToolsSlot } from '../slots/buildToolsSlot.js';
/** Route branch ids. */
const ROUTE_TOOL_CALLS = 'tool-calls';
const ROUTE_FINAL = SUBFLOW_IDS.FINAL;
/**
 * Build the Agent merge-tree chart as one flat ReAct flowchart.
 */
export function buildAgentMessageApiChart(deps) {
    const { provider, model, systemPrompt, tools } = deps;
    const maxIterations = deps.maxIterations ?? 5;
    // ── Context: ROOT selector. Inits per-call state on the first turn (the
    // folded-in seed — Context is the chart's first node); on ReAct loop re-entry
    // it leaves state intact (the iteration was bumped by ToolCalls). Returns the
    // three context slots to engineer. ──
    const contextSelector = (scope) => {
        if (scope.iteration === undefined) {
            const args = scope.$getArgs();
            scope.userMessage = args.message;
            scope.history = [{ role: 'user', content: args.message }];
            scope.iteration = 1;
            scope.systemPromptInjections = [];
            scope.messagesInjections = [];
            scope.toolSchemas = [];
            scope.assembledSystem = '';
            scope.assembledMessages = [];
            scope.answer = '';
            scope.toolCalls = [];
            scope.finalContent = '';
        }
        return select(scope, [
            { when: () => true, then: SUBFLOW_IDS.SYSTEM_PROMPT, label: 'engineer system-prompt' },
            { when: () => true, then: SUBFLOW_IDS.MESSAGES, label: 'engineer messages' },
            { when: () => true, then: SUBFLOW_IDS.TOOLS, label: 'engineer tools' },
        ]);
    };
    // ── messageAPI: assemble system-prompt + messages (the join after the slots
    // converge). tools is a separate field Call-LLM reads directly. ──
    const messageApiStage = (scope) => {
        const sysInjections = (scope.systemPromptInjections ?? []);
        scope.assembledSystem = sysInjections
            .map((r) => r.rawContent ?? '')
            .filter((s) => s.length > 0)
            .join('\n\n');
        scope.assembledMessages = [...(scope.history ?? [])];
    };
    // ── Call-LLM: send the assembled payload + the tool schemas. ──
    const callLLM = async (scope) => {
        const system = scope.assembledSystem;
        const messages = (scope.assembledMessages ?? []);
        const toolSchemas = (scope.toolSchemas ?? []);
        typedEmit(scope, 'agentfootprint.stream.llm_start', {
            iteration: scope.iteration,
            provider: provider.name,
            model,
            systemPromptChars: system.length,
            messagesCount: messages.length,
            toolsCount: toolSchemas.length,
            ...(toolSchemas.length > 0 && {
                tools: toolSchemas.map((t) => ({
                    name: t.name,
                    ...(t.description ? { description: t.description } : {}),
                })),
            }),
        });
        const startMs = Date.now();
        const response = await provider.complete({
            ...(system.length > 0 && { systemPrompt: system }),
            messages,
            ...(toolSchemas.length > 0 && { tools: toolSchemas }),
            model,
        });
        scope.answer = response.content;
        scope.toolCalls = response.toolCalls;
        typedEmit(scope, 'agentfootprint.stream.llm_end', {
            iteration: scope.iteration,
            content: response.content,
            toolCallCount: response.toolCalls.length,
            usage: response.usage,
            stopReason: response.stopReason,
            durationMs: Date.now() - startMs,
        });
    };
    // ── Route: ReAct decider — tool-calls (loop) vs final (terminate). ──
    const routeDecider = (scope) => {
        const calls = (scope.toolCalls ?? []);
        if (calls.length > 0 && scope.iteration < maxIterations)
            return ROUTE_TOOL_CALLS;
        return ROUTE_FINAL;
    };
    // ── ToolCalls: execute the LLM's requested tools, append results, bump the
    // iteration, loop. ──
    const toolExec = async (scope) => {
        const calls = (scope.toolCalls ?? []);
        const newHistory = [...(scope.history ?? [])];
        for (const call of calls) {
            typedEmit(scope, 'agentfootprint.stream.tool_start', {
                toolCallId: call.id,
                toolName: call.name,
                args: call.args,
            });
            const result = `[${call.name} result]`; // demo executor — real agents wire a registry
            newHistory.push({ role: 'tool', content: result, toolCallId: call.id });
            typedEmit(scope, 'agentfootprint.stream.tool_end', {
                toolCallId: call.id,
                result,
                durationMs: 0,
            });
        }
        scope.history = newHistory;
        scope.toolCalls = [];
        scope.iteration = scope.iteration + 1;
    };
    // ── Final: the agent's response — terminate the loop, capture the answer. ──
    const finalStage = (scope) => {
        scope.finalContent = scope.answer;
        scope.$break('agent reached final answer');
    };
    // ── Build ONE flat chart: Context(root) → 3 slots → messageAPI → Call-LLM
    //    → Route → [ToolCalls → loop] / Final. ──
    return (flowChartSelector('Context', contextSelector, 'context', {
        ...(deps.structureRecorders !== undefined && {
            structureRecorders: [...deps.structureRecorders],
        }),
        // 'Agent:' taxonomy marker → Lens renders this as an Agent group.
        description: 'Agent: ReAct loop',
    })
        // Three DIRECT context slots — all converge at messageAPI.
        .addSubFlowChartBranch(SUBFLOW_IDS.SYSTEM_PROMPT, buildSystemPromptSlot({ prompt: systemPrompt, reason: 'agent messageAPI' }), 'System Prompt', {
        inputMapper: (parent) => ({
            userMessage: parent.userMessage,
            iteration: parent.iteration,
        }),
        outputMapper: (sf) => ({
            systemPromptInjections: sf.systemPromptInjections,
        }),
    })
        .addSubFlowChartBranch(SUBFLOW_IDS.MESSAGES, buildMessagesSlot(), 'Messages', {
        inputMapper: (parent) => ({
            messages: parent.history,
            iteration: parent.iteration,
        }),
        outputMapper: (sf) => ({ messagesInjections: sf.messagesInjections }),
    })
        .addSubFlowChartBranch(SUBFLOW_IDS.TOOLS, buildToolsSlot({ tools }), 'Tools', {
        inputMapper: (parent) => ({ iteration: parent.iteration }),
        outputMapper: (sf) => ({ toolSchemas: sf.toolSchemas }),
        // tools is a SEPARATE Anthropic wire field — it BYPASSES messageAPI
        // (which assembles only system+messages) and pairs with its output at
        // Call-LLM. `convergeAt` makes the structure edge `sf-tools → call-llm`
        // instead of the default `sf-tools → message-api`, so Call-LLM reads as a
        // true 2-parent merge {messageAPI, tools}. (toolSchemas already rides
        // shared scope; this only makes the diagram faithful.)
        convergeAt: 'call-llm',
    })
        .end()
        // messageAPI assembles ONLY system+messages; Call-LLM then sends that
        // payload + the tool schemas (the 2-parent merge above).
        .addFunction('messageAPI', messageApiStage, 'message-api', 'Assemble system + messages into the LLM request')
        .addFunction('CallLLM', callLLM, 'call-llm', 'Send the assembled request + tools to the LLM')
        // Route → [ToolCalls → loop back to Context] / [Final → terminate].
        .addDeciderFunction('Route', routeDecider, SUBFLOW_IDS.ROUTE, 'ReAct routing')
        .addFunctionBranch(ROUTE_TOOL_CALLS, 'ToolCalls', toolExec, 'Execute tool calls')
        // ReAct: the loop is sourced from the TOOL-CALLS branch (after executing
        // tools, re-engineer context next turn) — NOT from the Route decider. Final
        // terminates as a leaf (its $break is the terminal boundary signal).
        .loopTo('context')
        .addFunctionBranch(ROUTE_FINAL, 'Final', finalStage, 'Terminate the ReAct loop (response)')
        .setDefault(ROUTE_FINAL)
        .end()
        .build());
}
//# sourceMappingURL=buildAgentMessageApiChart.js.map