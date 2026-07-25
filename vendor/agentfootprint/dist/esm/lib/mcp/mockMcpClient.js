/**
 * mockMcpClient — in-memory MCP client for development and tests.
 *
 *   const slack = mockMcpClient({
 *     tools: [
 *       {
 *         name: 'send_message',
 *         description: 'Post a message to a channel',
 *         inputSchema: { type: 'object' },
 *         handler: async ({ text }) => `Posted: ${text}`,
 *       },
 *     ],
 *   });
 *
 *   const agent = Agent.create({ provider: mock({ reply: 'ok' }) })
 *     .tools(await slack.tools())
 *     .build();
 *
 * Pattern: Adapter (GoF) — produces an `McpClient` with the same shape
 *          as `mcpClient(opts)` but driven by an in-memory tool table
 *          instead of the MCP SDK + transport. Drop-in for development:
 *          start with `mockMcpClient`, swap to `mcpClient` once the
 *          real server is ready.
 *
 * Why public: `mcpClient`'s `_client` injection is `@internal` because
 * the SDK shape isn't a stable public surface. `mockMcpClient` exposes
 * a curated tool-handler shape that's tied to OUR Tool contract instead
 * — stable, documented, and the right level of abstraction for
 * mock-first development.
 */
/**
 * Build an in-memory `McpClient`. Useful when you want to develop
 * against MCP semantics without spawning subprocesses, hitting the
 * network, or installing `@modelcontextprotocol/sdk`. Same `McpClient`
 * shape as `mcpClient(opts)` — code that consumes one accepts the other.
 */
export function mockMcpClient(options) {
    const name = options.name ?? 'mock-mcp';
    const toolMap = new Map(options.tools.map((t) => [t.name, t]));
    let cache = null;
    let closed = false;
    const ensureOpen = (op) => {
        if (closed) {
            throw new Error(`mockMcpClient[${name}].${op}() called after close(). Construct a new client to reuse.`);
        }
    };
    const buildTools = () => options.tools.map((mcp) => wrapMockTool(name, toolMap, mcp));
    return {
        name,
        async tools() {
            ensureOpen('tools');
            if (!cache)
                cache = buildTools();
            return cache;
        },
        async refresh() {
            ensureOpen('refresh');
            cache = buildTools();
            return cache;
        },
        async close() {
            if (closed)
                return;
            closed = true;
            cache = null;
        },
    };
}
function wrapMockTool(serverName, toolMap, mcp) {
    const tool = {
        schema: {
            name: mcp.name,
            description: mcp.description ?? `Mock MCP tool: ${mcp.name}`,
            inputSchema: mcp.inputSchema,
        },
        execute: async (args) => {
            const argsObj = args !== null && typeof args === 'object' && !Array.isArray(args)
                ? args
                : {};
            // Look up by name at call time so mid-test handler swaps via a
            // mutable Map could be supported later. For now `toolMap` is
            // built once at factory time.
            const handler = toolMap.get(mcp.name)?.handler;
            if (!handler)
                return '[mock result]';
            try {
                return await handler(argsObj);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Mock MCP tool '${mcp.name}' (server '${serverName}') threw: ${msg}`);
            }
        },
    };
    return tool;
}
//# sourceMappingURL=mockMcpClient.js.map