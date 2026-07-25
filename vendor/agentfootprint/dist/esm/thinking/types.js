/**
 * Thinking — public types for the v2.14 extended-thinking subsystem.
 *
 * Mental model — TWO-LAYER architecture:
 *
 *   • CONSUMER-FACING:   `ThinkingHandler` — a simple function-pair
 *                        (id, providerNames, normalize, parseChunk?).
 *                        Provider authors and custom-LLM consumers
 *                        implement THIS shape.
 *
 *   • FRAMEWORK-INTERNAL: each `ThinkingHandler` is auto-wrapped in a
 *                         real footprintjs subflow at chart build time.
 *                         The subflow gets its own `runtimeStageId`,
 *                         narrative entry, and InOutRecorder boundary
 *                         — full trace observability for free without
 *                         the consumer writing flowchart code.
 *
 * Same pattern as how consumers write a `Tool` and the framework wraps
 * dispatch in a tool-call subflow, or how consumers write a
 * `ToolProvider` and the framework wraps `list()` in the Tools slot
 * subflow.
 *
 * @see SHIPPED_THINKING_HANDLERS for the registry the framework uses
 *      to auto-wire by `provider.name` (Phase 3 wiring).
 * @see MockThinkingHandler for the canonical example demonstrating
 *      both Anthropic-shape (signed blocks) and OpenAI-shape (multi-
 *      block summary) inputs.
 */
export {};
//# sourceMappingURL=types.js.map