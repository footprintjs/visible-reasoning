// The MCP seam — how the gallery's context sources reach the agent.
//
// Both modes produce the SAME thing: an array of agentfootprint `Tool`s that the
// agent calls itself. They differ only in what sits behind them:
//
//   default / mock serve → mockMcpClient (in-memory MCP source; no subprocess,
//                          no network, no SDK — byte-stable for the gate)
//   --live               → mcpClient over stdio: a real @modelcontextprotocol/sdk
//                          server spawned from ../mcp-server.js, real protocol
//
// On top of either sits ONE decorator (`decorateTools`) that adds the three
// things a transparency demo needs and MCP itself does not provide:
//   1. per-turn memoization, so a counterfactual re-run replays the ORIGINAL
//      turn's tool bytes instead of re-fetching a moved world;
//   2. labeled fallbacks, so a dead network degrades into an honest sentence
//      rather than a crashed turn;
//   3. a dispatch counter — the host-boundary honesty metric whose delta of ZERO
//      during a re-run is the frozen-world proof.
// Everything else about the tool passes through untouched, so agentfootprint
// still emits tool_start / tool_end and localizeContextBug still sees a normal
// tool-kind source.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpClient, mockMcpClient } from 'agentfootprint/tool-providers';
import { APPS } from '../apps/index.js';

const here = dirname(fileURLToPath(import.meta.url));

// Counts REAL tool dispatches at the MCP client seam — NOT Anthropic LLM calls.
// A frozen-world re-run must move this by ZERO.
export const metrics = { toolDispatches: 0 };

// The model may reorder JSON keys between calls; sort them so the memo key is
// stable for identical arguments.
export function stableStringify(value) {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted = {};
      for (const k of Object.keys(val).sort()) sorted[k] = val[k];
      return sorted;
    }
    return val;
  });
}

export const memoKey = (name, args) => `${name}::${stableStringify(args ?? {})}`;

const reasonOf = (err) => {
  const m = String((err && err.message) || err || 'tool call failed');
  return m.length > 64 ? `${m.slice(0, 61)}…` : m;
};

/**
 * Wrap MCP-served tools with the memo / replay / labeled-fallback layer.
 * `getPending` returns the host's per-turn slot: { mode: 'record'|'replay', toolLog }.
 */
export function decorateTools(tools, getPending) {
  return tools.map((inner) => ({
    schema: inner.schema,
    execute: async (args) => {
      const pending = getPending();
      const key = memoKey(inner.schema.name, args);
      if (pending && pending.mode === 'replay') {
        const hit = pending.toolLog.get(key);
        if (hit !== undefined) return hit; // frozen world — NO dispatch
        // Novel arguments under ablation: still no dispatch, and we say so.
        return `No recorded result for ${inner.schema.name} with these arguments in the frozen turn.`
          + ' [source: frozen-world replay — not re-fetched]';
      }
      metrics.toolDispatches += 1;
      let result;
      try {
        result = await inner.execute(args);
      } catch (err) {
        // A fallback is a NORMAL labeled sentence, never a thrown turn: the chat
        // must keep working with no network at all.
        result = `${inner.schema.name} is unavailable right now.`
          + ` [source: synthetic fallback — ${reasonOf(err)}]`;
      }
      if (pending) pending.toolLog.set(key, result);
      return result;
    },
  }));
}

/** Default + mock-serve: every pack's tools, backed by their scripted fixtures. */
export async function buildMockTools() {
  const client = mockMcpClient({
    name: 'gallery-tools',
    tools: APPS.flatMap((app) => app.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      handler: (args) => t.scripted(args),
    }))),
  });
  return { client, tools: await client.tools() };
}

/** --live: one local MCP server over stdio, spawned by the official SDK. */
export async function buildLiveClient() {
  const client = await mcpClient({
    name: 'gallery-tools',
    transport: {
      transport: 'stdio',
      command: process.execPath,
      args: [join(here, '..', 'mcp-server.js')],
      env: { ...process.env },   // forwards GALLERY_FORCE_FALLBACK to the server
    },
  });
  return { client, tools: await client.tools() };
}

// ─── Provenance, read off the sentence tail (07's convention) ────────────────
export function provenanceOf(text) {
  const s = String(text ?? '');
  if (s.includes('[source: live')) return 'live';
  if (s.includes('[source: synthetic fallback')) return 'fallback';
  if (s.includes('[source: frozen-world replay')) return 'replay';
  if (s.includes('[source: synthetic —')) return 'synthetic';
  if (s.includes('[source: scripted demo data')) return 'scripted';
  return 'unknown';
}

/** toolName → provenance verdict for one turn. Tools never called say so. */
export function provenanceFromToolLog(toolLog, toolNames) {
  const byName = new Map();
  for (const [key, value] of toolLog) byName.set(key.split('::')[0], value);
  const out = {};
  for (const name of toolNames) {
    out[name] = byName.has(name) ? provenanceOf(byName.get(name)) : 'not consulted';
  }
  return out;
}

/**
 * toolName → the sentence's OWN `[source: …]` text, verbatim — "live — Wikipedia
 * — Mission Peak", "synthetic fallback — HTTP 404", "synthetic — modeled crowd
 * estimate, not measured".
 *
 * The verdict above is a WORD; this is the REASON behind it, and without it a
 * visitor looking at a hollow fallback dot can only learn WHY by reading code.
 * It is read off the same sentence tail with the same regex agentthinkingui uses
 * on a source snippet, so the legend and the influence panel cannot disagree
 * about what a source said about itself. Null when a tool went unconsulted (or
 * returned a sentence with no label at all — there is nothing to report, and
 * inventing something is the failure mode this file exists to prevent).
 */
export function sourceLabelsFromToolLog(toolLog, toolNames) {
  const byName = new Map();
  for (const [key, value] of toolLog) byName.set(key.split('::')[0], value);
  const out = {};
  for (const name of toolNames) {
    const m = /\[source:\s*([^\]]+)\]/i.exec(String(byName.get(name) ?? ''));
    out[name] = m ? m[1].trim() : null;
  }
  return out;
}
