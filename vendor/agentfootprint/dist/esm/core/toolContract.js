/**
 * Agent ↔ tool-server contract check (proposal 009, the server-boundary extension).
 *
 * When an agent's tools call a remote tool-server (an MCP-ish sidecar, a function
 * gateway), the agent's `inputSchema` and the server's real contract can drift —
 * and the model then calls a tool that 404s, or omits an arg the server REQUIRES and
 * gets a 501/400 "doesn't work." The server usually publishes its own catalog
 * (e.g. `GET /tools` → `[{ name, inputSchema }]`), so the drift is checkable.
 *
 * `toolContractCheckup(agentTools, serverCatalog)` is a PURE diff (no I/O — the
 * consumer fetches the catalog and passes it). It mirrors the `graph.checkup()`
 * shape so both feed the same reporting.
 */
/** Accept either a real `Tool` ({schema:{name,inputSchema}}) or a bare {name, inputSchema}. */
function normalize(t) {
    const asTool = t;
    const name = asTool.schema?.name ?? t.name;
    const schema = asTool.schema?.inputSchema ?? t.inputSchema;
    return {
        name,
        required: new Set(schema?.required ?? []),
        props: new Set(schema?.properties ? Object.keys(schema.properties) : []),
    };
}
/**
 * Diff an agent's tools against a server's tool catalog. Pure + deterministic.
 *
 * @param agentTools     the agent's tools (`Tool[]` or `{name, inputSchema}[]`)
 * @param serverCatalog  the server's catalog (e.g. `await (await fetch('/tools')).json()`)
 */
export function toolContractCheckup(agentTools, serverCatalog) {
    const problems = [];
    const agent = agentTools.map(normalize);
    const server = new Map(serverCatalog.map((e) => [normalize(e).name, normalize(e)]));
    const agentNames = new Set(agent.map((a) => a.name));
    for (const a of agent) {
        const s = server.get(a.name);
        if (!s) {
            problems.push({
                kind: 'error',
                code: 'missing-on-server',
                tool: a.name,
                message: `Agent tool "${a.name}" is not in the server catalog — calling it would 404. Remove it, or expose it on the server.`,
            });
            continue;
        }
        // required-divergence (ERROR): the server requires an arg the agent does NOT mark
        // required → the model, trusting the schema, omits it → server 400/501.
        for (const req of s.required) {
            if (!a.required.has(req)) {
                problems.push({
                    kind: 'error',
                    code: 'required-divergence',
                    tool: a.name,
                    message: `Server requires arg "${req}" for "${a.name}", but the agent schema ${a.props.has(req) ? `marks it OPTIONAL` : `omits it`} — the model will call without it and the server will reject. Add "${req}" to the tool's inputSchema.required.`,
                });
            }
        }
        // optional-drift (WARNING): a server-accepted arg the agent never surfaces → the
        // model can't pass that filter ("tool ignores my narrowing").
        for (const prop of s.props) {
            if (!a.props.has(prop)) {
                problems.push({
                    kind: 'warning',
                    code: 'optional-drift',
                    tool: a.name,
                    message: `Server accepts arg "${prop}" for "${a.name}", but the agent schema omits it — the model can't use that filter. Add "${prop}" to the tool's inputSchema.properties.`,
                });
            }
        }
        // arg-divergence (WARNING): the agent declares an arg the server doesn't know →
        // the server ignores it (or rejects on strict validators); often a rename/typo.
        for (const prop of a.props) {
            if (!s.props.has(prop)) {
                problems.push({
                    kind: 'warning',
                    code: 'arg-divergence',
                    tool: a.name,
                    message: `Agent declares arg "${prop}" for "${a.name}" that the server's schema doesn't list — the server may ignore or reject it (a rename/typo?).`,
                });
            }
        }
    }
    // dead-endpoint (WARNING): a server tool no agent tool calls.
    for (const [name] of server) {
        if (!agentNames.has(name)) {
            problems.push({
                kind: 'warning',
                code: 'dead-endpoint',
                tool: name,
                message: `Server exposes "${name}", but no agent tool calls it — dead/unused (or the agent is missing a tool).`,
            });
        }
    }
    return { ok: !problems.some((p) => p.kind === 'error'), problems };
}
/** Format a contract check-up for a thrown error / console warning. */
export function formatToolContractCheckup(checkup) {
    return checkup.problems
        .map((p) => `  [${p.kind}] ${p.code} (${p.tool}): ${p.message}`)
        .join('\n');
}
//# sourceMappingURL=toolContract.js.map