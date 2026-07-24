// The gallery's local MCP server — the ONE process that touches the network.
//
// Started only by --live mode, as a stdio subprocess of run.js (agentfootprint's
// mcpClient spawns it). It registers every app pack's tool with the official
// @modelcontextprotocol/sdk low-level Server, so the packs' JSON Schemas travel
// to the client verbatim. run.js NEVER imports this file.
//
// Two disciplines to keep in mind while editing:
//   • stdout IS the protocol channel. Every log line here goes to stderr.
//   • A failed fetch is NOT an MCP error. Fallbacks come back as normal, clearly
//     labeled sentences (`isError` stays unused by design) so the chat keeps
//     working with no network at all. The client-side decorator's catch is the
//     last-resort net.
//
// env: GALLERY_FORCE_FALLBACK=1 → every fetcher throws before fetching (the
//      offline drill; the synthetic crowd source is unaffected because it never
//      fetches in the first place).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS } from './apps/index.js';

// ─── The fetch context handed to every pack's `live` handler ────────────────
// duplicated from 07-chat-desk/run.js (safeFetch / label* / reasonOf / clip /
// fmtUSD) — 07 is frozen as the reference implementation.
//
// SEC's fair-access policy asks for a declarative "name contact-EMAIL"
// User-Agent, and it is strict: verified 2026-07, a UA carrying a project URL
// instead of an email is 403'd, a UA carrying an email is 200. The maintainer
// keeps their email out of public code by choice, so the DEFAULT UA below is
// deliberately the URL form — which means the stock desk's two SEC tools fall
// back (labeled) out of the box. Set SEC_CONTACT=you@example.com to make them
// go live. Reddit instead wants a browser-like UA and 403s unauthenticated
// traffic anyway — which is exactly why social_sentiment carries a fallback too.
const SEC_UA = 'footprintjs-visible-reasoning ' + (process.env.SEC_CONTACT ?? 'https://github.com/footprintjs/visible-reasoning');
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 4000;
const FORCE_FALLBACK = process.env.GALLERY_FORCE_FALLBACK === '1';

async function safeFetch(url, opts = {}) {
  if (FORCE_FALLBACK) throw new Error('offline drill forced (GALLERY_FORCE_FALLBACK=1)');
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  console.error(`[mcp-server] GET ${host}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'user-agent': SEC_UA, accept: 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally { clearTimeout(timer); }
}

function clip(str, n) { const s = String(str); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function reasonOf(err) {
  const m = String((err && err.message) || err || 'fetch failed');
  return m.length > 64 ? `${m.slice(0, 61)}…` : m;
}
function fmtUSD(n) {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString('en-US')}`;
}

const ctx = {
  safeFetch,
  clip,
  reasonOf,
  fmtUSD,
  BROWSER_UA,
  labelLive: (src) => ` [source: live — ${src}]`,
  labelFallback: (reason) => ` [source: synthetic fallback — ${reason}]`,
};

// ─── Registration ───────────────────────────────────────────────────────────
const byName = new Map(ALL_TOOLS.map(({ tool }) => [tool.name, tool]));

const server = new Server(
  { name: 'gallery-tools', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.map(({ app, tool }) => ({
    name: tool.name,
    description: `${tool.description} (${app.title})`,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) throw new Error(`unknown tool: ${request.params.name}`);
  const args = request.params.arguments ?? {};
  // `live` catches its own failures and returns a labeled fallback sentence, so
  // this is a normal (non-error) result either way. The extra try is only for a
  // handler bug — and even then we answer with a labeled sentence.
  let text;
  try {
    text = await tool.live(args, ctx);
  } catch (err) {
    text = `${tool.name} is unavailable right now. [source: synthetic fallback — ${reasonOf(err)}]`;
  }
  return { content: [{ type: 'text', text }] };
});

await server.connect(new StdioServerTransport());
console.error(`[mcp-server] ready — ${ALL_TOOLS.length} tools${FORCE_FALLBACK ? ' (offline drill: GALLERY_FORCE_FALLBACK=1)' : ''}`);
