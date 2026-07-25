// Pack tools → agentfootprint tools, called straight from the tab.
//
// On the server the same tools arrive over MCP (a stdio subprocess speaking the
// real protocol) and are then wrapped by lib/mcp.js's decorator. In the browser
// there is no subprocess to speak to, so the pack's own `live(args, ctx)` body
// IS the tool body — and the SAME decorator goes on top, which is what keeps the
// BYOK page's guarantees identical to the server demo's: per-turn memoization,
// frozen-world replay on a re-run (0 new fetches), labeled fallbacks, and the
// dispatch counter whose delta of ZERO is the frozen-world proof.
import { defineTool } from 'agentfootprint';
import { decorateTools } from '../lib/mcp.js';

/** One pack's tools as af Tools whose execute() is the pack's client-side fetcher. */
export function packToBrowserTools(pack, ctx) {
  return pack.tools.map((tool) => defineTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (args) => tool.live(args ?? {}, ctx),
  }));
}

/**
 * Every carried pack's tools, decorated once and sliced per app — the exact
 * shape run.js's bootTools() hands each desk, so lib/chat-core.js cannot tell
 * the difference between this page and the server.
 */
export function browserToolsFor(packs, ctx, getPending) {
  const decorated = decorateTools(packs.flatMap((p) => packToBrowserTools(p, ctx)), getPending);
  const byName = new Map(decorated.map((t) => [t.schema.name, t]));
  const perApp = new Map();
  for (const pack of packs) {
    perApp.set(pack.id, pack.tools.map((t) => {
      const hit = byName.get(t.name);
      if (!hit) throw new Error(`no browser tool built for '${t.name}'`);
      return hit;
    }));
  }
  return { perApp, served: decorated.map((t) => t.schema.name) };
}
