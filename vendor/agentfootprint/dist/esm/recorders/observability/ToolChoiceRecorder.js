/**
 * toolChoiceRecorder — runtime tool-choice margins (RFC-002 tier 2,
 * blocks C4–C6).
 *
 * Per LLM call that OFFERED tools, this recorder captures the menu the
 * model saw (`stream.llm_start.tools`), what it actually invoked
 * (`stream.tool_start`), and the choice context — then, LAZILY on first
 * read, ranks the offered candidates against that context via
 * influence-core's `scoreMargin` (C4):
 *
 *   margin = score(best chosen) − score(best non-chosen)
 *
 * Small margin (`narrow`, < `marginThreshold`, default 0.05) = the
 * choice was a close call under the proxy. Top-scored candidate not
 * among the chosen (`proxyDisagreement`) is ALWAYS flagged — either a
 * proxy miss or a genuinely surprising model choice; both are exactly
 * what a debugger wants surfaced.
 *
 * ## The choice context (C4 — what is embedded, precisely)
 *
 * `buildChoiceContext` assembles the SAME two slots the model's
 * tool-selection reasoning ran on:
 *
 *   INCLUDED
 *   1. the user message of the current turn (`agent.turn_start.userPrompt`)
 *      — the task the model is choosing a tool FOR (first
 *      `maxSlotChars` chars: the head states the task);
 *   2. the latest assistant reasoning text — the most recent
 *      `stream.llm_end.content` of this turn, when present (last
 *      `maxSlotChars` chars: the tail is where "what next" lives).
 *      Iteration 1 has no assistant text; the slot is omitted.
 *
 *   EXCLUDED (deliberately)
 *   - the system prompt: constant across every call of the run — zero
 *     per-call discrimination, it only dilutes the embedding;
 *   - older history turns: recency dominates tool choice, and the full
 *     transcript grows the embedding cost linearly with run length;
 *   - raw tool results: the model reads them, but their distilled
 *     effect on the NEXT choice is the assistant's own reasoning text,
 *     which IS included; raw payloads skew the embedding toward data
 *     vocabulary (the honest-proxy discipline: mirror the
 *     decision-relevant text, not every visible byte);
 *   - tool schemas: those are the CANDIDATES being ranked, not context.
 *
 * Candidate text per offered tool = `confusabilityText` (tokenized name
 * + description) — the SAME construction the catalog lint (C1) embeds,
 * so build-time confusability and runtime margins measure one geometry.
 *
 * ## Laziness (C5)
 *
 * Event hooks only RECORD (string copies into a KeyedStore). The
 * embedder runs on the first `getCalls()` / `getFlagged()` /
 * `getSummary()` — embedding I/O NEVER rides the hot path, even when
 * the recorder is attached inline. Scores memoize per entry. Attach
 * with `{ delivery: 'deferred' }` (footprintjs RFC-001) to move the
 * bookkeeping off the hot path too — it is a normal CombinedRecorder.
 *
 * Pattern: CombinedRecorder (Convention 1 — single purpose: tool-choice
 *          margin evidence). Owns a `KeyedStore<ToolChoiceEntry>` keyed
 *          by the LLM call's `runtimeStageId`. Convention 4: resets on a
 *          new `runId` via `FlowRecorder.onRunStart`.
 * Role:    Tier-3 /observe recorder. Attach via `Agent.create(...)
 *          .recorder(handle)` or `executor.attachCombinedRecorder`.
 *
 * Honest claim (RFC-002 §2): margins are embedding geometry between the
 * context and tool descriptions — a deterministic PROXY for the model's
 * selection function, never "the model chose because". Tier 3
 * (choice-entropy sampling) validates the proxy.
 */
import { KeyedStore } from 'footprintjs/trace';
import { DEFAULT_MARGIN_THRESHOLD, scoreMargin, } from '../../lib/influence-core/index.js';
import { confusabilityText } from '../../lib/tool-lint/analyze.js';
/** C4: the precise choice-context construction (see module JSDoc for the
 *  include/exclude rationale). Exported so consumers can reproduce it. */
export function buildChoiceContext(args) {
    const max = args.maxSlotChars ?? 2000;
    const user = `user: ${args.userPrompt.slice(0, max)}`;
    const assistant = args.latestAssistantText?.trim();
    if (assistant === undefined || assistant.length === 0)
        return user;
    return `${user}\n\nassistant: ${assistant.slice(-max)}`;
}
/** Build the tool-choice margin recorder (C5). */
export function toolChoiceRecorder(options) {
    const marginThreshold = options.marginThreshold ?? DEFAULT_MARGIN_THRESHOLD;
    const maxSlotChars = options.maxSlotChars ?? 2000;
    const store = new KeyedStore();
    let lastRunId;
    let userPrompt = '';
    let lastAssistantText;
    let openKey;
    const closeOpen = () => {
        if (openKey === undefined)
            return;
        const open = store.get(openKey);
        if (open)
            open.closed = true;
        openKey = undefined;
    };
    const reset = () => {
        store.clear();
        userPrompt = '';
        lastAssistantText = undefined;
        openKey = undefined;
    };
    /** Lazy scoring pass — the ONLY place the embedder runs. */
    const ensureScored = async () => {
        for (const entry of store.getMap().values()) {
            if (!entry.closed || entry.margin !== undefined || entry.skipped !== undefined)
                continue;
            if (entry.chosen.length === 0) {
                entry.skipped = 'nothing-chosen';
                continue;
            }
            const offeredNames = new Set(entry.offered.map((tool) => tool.name));
            if (!entry.chosen.every((name) => offeredNames.has(name))) {
                entry.skipped = 'chosen-not-offered';
                continue;
            }
            entry.margin = await scoreMargin({
                candidates: entry.offered.map((tool) => ({
                    name: tool.name,
                    text: confusabilityText(tool),
                })),
                contextText: entry.contextText,
                chosen: entry.chosen,
                embedder: options.embedder,
                marginThreshold,
            });
        }
    };
    const toCall = (entry) => ({
        runtimeStageId: entry.runtimeStageId,
        iteration: entry.iteration,
        offered: entry.offered,
        chosen: [...entry.chosen],
        toolCallIds: [...entry.toolCallIds],
        contextText: entry.contextText,
        ...(entry.margin !== undefined ? { margin: entry.margin } : {}),
        ...(entry.skipped !== undefined ? { skipped: entry.skipped } : {}),
    });
    return {
        id: options.id ?? 'tool-choice',
        onEmit(event) {
            const payload = event.payload;
            if (payload === null || typeof payload !== 'object')
                return; // redacted or foreign
            const p = payload;
            switch (event.name) {
                case 'agentfootprint.agent.turn_start': {
                    // New turn on the same run: fresh context slots.
                    closeOpen();
                    userPrompt = typeof p.userPrompt === 'string' ? p.userPrompt : '';
                    lastAssistantText = undefined;
                    break;
                }
                case 'agentfootprint.stream.llm_start': {
                    closeOpen();
                    const tools = Array.isArray(p.tools) ? p.tools : [];
                    if (tools.length === 0)
                        break; // no menu — nothing to confuse
                    store.set(event.runtimeStageId, {
                        runtimeStageId: event.runtimeStageId,
                        iteration: Number(p.iteration ?? 0),
                        offered: tools.map((tool) => ({
                            name: tool.name,
                            ...(tool.description !== undefined ? { description: tool.description } : {}),
                        })),
                        contextText: buildChoiceContext({
                            userPrompt,
                            ...(lastAssistantText !== undefined
                                ? { latestAssistantText: lastAssistantText }
                                : {}),
                            maxSlotChars,
                        }),
                        chosen: [],
                        toolCallIds: [],
                        closed: false,
                    });
                    openKey = event.runtimeStageId;
                    break;
                }
                case 'agentfootprint.stream.llm_end': {
                    if (typeof p.content === 'string' && p.content.length > 0) {
                        lastAssistantText = p.content;
                    }
                    break;
                }
                case 'agentfootprint.stream.tool_start': {
                    if (openKey === undefined)
                        break;
                    const entry = store.get(openKey);
                    if (entry === undefined)
                        break;
                    const name = String(p.toolName ?? 'unknown');
                    if (!entry.chosen.includes(name))
                        entry.chosen.push(name);
                    entry.toolCallIds.push(String(p.toolCallId ?? ''));
                    break;
                }
                case 'agentfootprint.agent.turn_end': {
                    closeOpen();
                    break;
                }
                default:
                    break;
            }
        },
        /** Convention 4 — a new runId means a new logical run: reset
         *  accumulation so runtimeStageId keys (which restart per run) cannot
         *  collide. The executor also calls `clear()` before each `run()` —
         *  this hook is the detection that works regardless of attach surface.
         *
         *  Pause/resume is NOT a fresh run. `executor.resume()` regenerates the
         *  runId, fires `onResume` (which stamps that new runId below WITHOUT
         *  resetting), and only THEN runs `traverser.execute()`, which fires
         *  this `onRunStart` at the top level with the SAME regenerated runId.
         *  Because `onResume` already advanced `lastRunId`, the guard here sees
         *  `runId === lastRunId` and does NOT reset — so pre-pause entries
         *  survive across the pause. A genuine `run()` arrives with a runId that
         *  `onResume` never stamped, so it still resets exactly as before. */
        onRunStart(event) {
            const runId = event.traversalContext?.runId;
            if (runId !== undefined && runId !== lastRunId) {
                reset();
                lastRunId = runId;
            }
        },
        /** Resume adopts the regenerated runId WITHOUT resetting, so the
         *  `onRunStart` footprintjs fires immediately afterward (same runId) is
         *  a no-op and pre-pause tool-choice entries are retained. Only the
         *  control-flow (`FlowRecorder`) resume variant carries
         *  `traversalContext.runId`; the scope-channel `ResumeEvent` (this
         *  recorder also lands there via `onEmit`) has none → ignored. */
        onResume(event) {
            const runId = event.traversalContext?.runId;
            if (runId !== undefined)
                lastRunId = runId;
        },
        onRunEnd() {
            closeOpen();
        },
        onRunFailed() {
            closeOpen();
        },
        async getCalls() {
            await ensureScored();
            return [...store.getMap().values()].map(toCall);
        },
        async getFlagged() {
            await ensureScored();
            return [...store.getMap().values()]
                .filter((entry) => entry.margin !== undefined &&
                (entry.margin.flags.narrow || entry.margin.flags.proxyDisagreement))
                .map(toCall);
        },
        async getSummary() {
            await ensureScored();
            const entries = [...store.getMap().values()];
            const scored = entries.filter((entry) => entry.margin !== undefined);
            const narrow = scored.filter((entry) => entry.margin?.flags.narrow).length;
            const proxyDisagreement = scored.filter((entry) => entry.margin?.flags.proxyDisagreement).length;
            const flagged = scored.filter((entry) => entry.margin?.flags.narrow || entry.margin?.flags.proxyDisagreement).length;
            return {
                llmCallsWithTools: entries.length,
                choices: entries.filter((entry) => entry.chosen.length > 0).length,
                scored: scored.length,
                flagged,
                narrow,
                proxyDisagreement,
                skipped: entries.filter((entry) => entry.skipped !== undefined).length,
            };
        },
        clear() {
            reset();
        },
    };
}
//# sourceMappingURL=ToolChoiceRecorder.js.map