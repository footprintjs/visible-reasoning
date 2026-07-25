/**
 * tool-lint types — the tool-catalog confusability lint contract
 * (RFC-002 tier 1, blocks C1–C3).
 *
 * Pattern: Strategy seam (the plug-and-play meta-pattern) — the frame
 *          and rule engine are the library's; the embedder, thresholds,
 *          and structural rule pack are all consumer-injected, with our
 *          defaults. Exactly like NarrativeFormatter / reliability /
 *          permission / commentary strategies.
 * Role:    `src/lib/` leaf module. ZERO stack buy-in: input is a plain
 *          `{ name, description?, inputSchema? }[]` — any OpenAI /
 *          Anthropic / LangChain / MCP tool list normalizes to it
 *          (see `coerceCatalog`). The library's own `Tool[]` adapts via
 *          `catalogFromTools`.
 *
 * ## Honest claim (RFC-002 §2)
 *
 * Confusability here is embedding geometry over what the model READS
 * (tool name + description) — a deterministic heuristic for "could the
 * model mix these up", never a measurement of any model's actual
 * selection function. Tier 3 (choice-entropy sampling) validates the
 * proxy; until then treat verdicts as review prompts, not ground truth.
 */
export {};
//# sourceMappingURL=types.js.map