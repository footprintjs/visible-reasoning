// Browser stub for `node:module`, wired through the page's import map.
//
// agentfootprint's lib/lazyRequire.js imports createRequire at module top — the
// single node builtin in the whole agent + footprint closure. It is only CALLED
// when a node-only adapter is constructed (anthropic(), openai(), mcpClient(),
// redis…), which the BYOK page never does: its provider is browserAnthropic and
// its tools are client-side fetchers.
//
// Throwing at CALL time (never at import time) is the honest shape: the page
// loads, and if a code path ever did reach for a node-only dependency in a tab,
// it fails loudly instead of silently degrading.
export function createRequire() {
  return (specifier) => {
    throw new Error(
      `[browser] node-only dependency requested: ${specifier} — this code path is server-only.`,
    );
  };
}

export default { createRequire };
