/**
 * MCP — Model Context Protocol client integration.
 *
 * MCP (https://modelcontextprotocol.io) is an open standard for
 * connecting LLMs to external tools and data sources. agentfootprint's
 * MCP adapter is **client-only** — it consumes MCP servers and exposes
 * their tools as agentfootprint `Tool[]` so consumers can plug them
 * straight into `agent.tool(...)`.
 *
 * Pattern: Adapter (GoF) — translates MCP wire format ↔ agentfootprint
 *          `Tool` interface. The MCP SDK does the protocol work; we
 *          just bridge.
 * Role:    Layer-3 tool integration. Pairs with `defineTool` (the
 *          inline alternative for non-MCP tools).
 * Emits:   N/A directly — wrapped tools emit the standard
 *          `agentfootprint.stream.tool_start` / `tool_end` events
 *          when the agent calls them.
 *
 * Server-side support (exposing an agent or LLMCall as an MCP tool)
 * is a separate concern not yet shipped. This module covers the
 * 80% case: pulling an existing MCP server's tools INTO an agent.
 */
export {};
//# sourceMappingURL=types.js.map