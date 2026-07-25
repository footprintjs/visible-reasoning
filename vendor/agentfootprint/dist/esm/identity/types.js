/**
 * agentfootprint/identity — the CredentialProvider port.
 *
 * OUTBOUND auth: vend a credential/token so a tool can call a downstream service
 * (GitHub, Slack, Google…) on behalf of the agent or the end user. This is
 * DISTINCT from `agentfootprint/security` (authorization — "is this tool
 * allowed"); identity answers "get me a token to call X".
 *
 * Pattern: Port (Hexagonal). Vendors plug in as adapters:
 *   - `agentCoreIdentity()` — AWS Bedrock AgentCore Identity (token vault + OAuth)
 *   - `staticTokens()`      — dev/test (canned tokens, no network)
 *
 * Two flows, mirroring OAuth (and AgentCore's `M2M` vs `USER_FEDERATION`):
 *   - `mode: 'machine'` (2-legged) — client-credentials; returns a token directly.
 *   - `mode: 'user'`    (3-legged) — user-delegated; may need consent. When it
 *     does, the provider returns `authorization-required` with a URL; the agent
 *     surfaces it to the human (e.g. via pause/resume) and retries after consent.
 *     (Most calls skip consent — providers cache refresh tokens.)
 *
 * **Security invariant:** a vended token is a SECRET. Callers MUST use it locally
 * (e.g. as an HTTP header inside a tool's `execute`) and MUST NOT write it to
 * tracked scope (`setValue`) — tracked writes flow to the commit log, recorders,
 * and observability exporters, which would leak the token into the trace. Pair
 * with `RedactionPolicy` for defence in depth.
 */
/** Narrow a {@link CredentialResult} to the issued-credential branch. */
export function isCredentialIssued(r) {
    return r.status === 'issued';
}
/**
 * A fail-closed {@link CredentialProvider} used when none is attached. Every call
 * throws loudly — so `ctx.credentials` is never `undefined` (no silent
 * optional-chaining bypass), and a tool that needs a credential without one
 * configured fails LOUD, not open. Use `ctx.hasCredentials` to branch when a tool
 * intentionally supports a no-credential (degraded) mode.
 */
export function unconfiguredCredentialProvider() {
    return {
        id: 'unconfigured',
        getCredential(req) {
            return Promise.reject(new Error(`No credential provider configured, but a credential for '${req.service}' was ` +
                `requested. Pass \`credentials\` to Agent.create({ ..., credentials }) ` +
                `(e.g. agentCoreIdentity({ region }) or staticTokens({ ... })).`));
        },
    };
}
//# sourceMappingURL=types.js.map