/**
 * agentCoreIdentity — AWS Bedrock AgentCore Identity adapter (peer-dep
 * `@aws-sdk/client-bedrock-agentcore`).
 *
 *   import { agentCoreIdentity } from 'agentfootprint/identity';
 *   const credentials = agentCoreIdentity({ region: 'us-east-1' });
 *
 * Maps the {@link CredentialProvider} port onto AgentCore Identity's
 * `GetResourceOauth2Token` (the SDK's `@requires_access_token` underneath):
 *   - request.mode 'machine' → `M2M`; 'user' → `USER_FEDERATION`
 *   - request.service        → the configured OAuth2 credential-provider name
 *   - request.identity       → (per-request workload identity scoping; see below)
 *   - a returned access token → `{ status: 'issued', credential: bearer(token) }`
 *   - a returned auth URL     → `{ status: 'authorization-required' }` (3LO consent)
 *
 * The token vault + refresh-token handling live in AgentCore, so repeat calls
 * usually return a token directly (no consent round-trip).
 *
 * **Per-request identity forwarding (workload identity scoping).**
 * `GetResourceOauth2Token` carries NO user/tenant field — in AgentCore the
 * user identity is bound EARLIER, at workload-token acquisition:
 * `GetWorkloadAccessTokenForUserId(workloadName, userId)` returns a workload
 * access token scoped to that user, and AgentCore keys its token vault + 3LO
 * grants per (workload, user). So this adapter forwards `req.identity` (the
 * `runIdentity` that the agent threads through `getCredential`) by resolving a
 * per-user workload token first, then vending with it. Engages only when ALL of:
 *   - `req.mode === 'user'` (USER_FEDERATION — M2M is the workload's own identity),
 *   - a userId derives from `req.identity` (default `identity.principal`;
 *     override via `userIdFor`), and
 *   - `options.workloadName` is configured (the opt-in).
 * Otherwise the static `options.workloadIdentityToken` flows exactly as before.
 * `tenant` has no native AgentCore field and is NOT forwarded by default —
 * tenant isolation derives from the workload identity itself (per-tenant
 * workloads), or encode it via `userIdFor` (e.g. `${tenant}:${principal}`).
 *
 * Pattern: Adapter (GoF) + lazy peer-dep load — the AWS SDK is required only when
 * `getCredential` first runs (or never, if you inject `_client`). NOTE: confirm
 * the SDK command/field names against your installed
 * `@aws-sdk/client-bedrock-agentcore` version — this adapter targets the
 * `GetResourceOauth2Token` shape and is structured so the request→result mapping
 * is unit-tested via the `_client` seam independent of the SDK.
 */
import { lazyRequire } from '../../lib/lazyRequire.js';
import { bearer } from '../../identity/kinds.js';
function resolveClient(options) {
    if (options._client)
        return options._client;
    // Lazy peer-dep: only loaded when no _client is injected and getCredential runs.
    const sdk = lazyRequire('@aws-sdk/client-bedrock-agentcore');
    const Ctor = sdk.BedrockAgentCoreClient;
    if (!Ctor) {
        throw new Error('agentCoreIdentity: @aws-sdk/client-bedrock-agentcore did not expose BedrockAgentCoreClient. ' +
            'Install/upgrade the SDK, or pass `_client` for a custom integration.');
    }
    const client = new Ctor({ ...(options.region && { region: options.region }) });
    if (typeof client.getResourceOauth2Token !== 'function') {
        throw new Error('agentCoreIdentity: the SDK client has no getResourceOauth2Token. Confirm the ' +
            '@aws-sdk/client-bedrock-agentcore version, or pass `_client`.');
    }
    return {
        getResourceOauth2Token: (input) => client.getResourceOauth2Token(input),
        // Duck-typed like the primary call — only wired when the SDK exposes it
        // (used only when `workloadName` is configured).
        ...(typeof client.getWorkloadAccessTokenForUserId === 'function' && {
            getWorkloadAccessTokenForUserId: (input) => client.getWorkloadAccessTokenForUserId(input),
        }),
    };
}
const defaultUserIdFor = (identity) => identity.principal;
/** Build a {@link CredentialProvider} backed by AWS Bedrock AgentCore Identity. */
export function agentCoreIdentity(options = {}) {
    let client;
    const getClient = () => (client ??= resolveClient(options));
    const userIdFor = options.userIdFor ?? defaultUserIdFor;
    // Per-request identity forwarding (workload identity scoping) — see module
    // header. `GetResourceOauth2Token` has no user field; the user is bound at
    // workload-token acquisition, so a `mode: 'user'` request carrying an
    // identity exchanges (workloadName, userId) for a USER-SCOPED workload token
    // and vends with that. Requires `workloadName` (the opt-in); without it the
    // static `workloadIdentityToken` flows unchanged (pre-forwarding behavior).
    const resolveWorkloadToken = async (req) => {
        const userId = req.mode === 'user' && req.identity !== undefined ? userIdFor(req.identity) : undefined;
        if (userId === undefined || !options.workloadName)
            return options.workloadIdentityToken;
        const c = getClient();
        if (typeof c.getWorkloadAccessTokenForUserId !== 'function') {
            // Explicit config must not silently degrade to workload-level tokens.
            throw new Error('agentCoreIdentity: `workloadName` is configured for per-user workload scoping, ' +
                'but the client has no getWorkloadAccessTokenForUserId. Confirm the ' +
                '@aws-sdk/client-bedrock-agentcore version, or pass `_client`.');
        }
        const res = await c.getWorkloadAccessTokenForUserId({
            workloadName: options.workloadName,
            userId,
        });
        if (!res.workloadAccessToken) {
            throw new Error('agentCoreIdentity: GetWorkloadAccessTokenForUserId returned no workloadAccessToken ' +
                'for per-user scoped vending.');
        }
        return res.workloadAccessToken;
    };
    return {
        id: options.id ?? 'agentcore-identity',
        async getCredential(req) {
            const workloadIdentityToken = await resolveWorkloadToken(req);
            const res = await getClient().getResourceOauth2Token({
                resourceCredentialProviderName: req.service,
                scopes: req.scopes ?? [],
                oauth2Flow: req.mode === 'user' ? 'USER_FEDERATION' : 'M2M',
                forceAuthentication: req.forceReauth ?? false,
                ...(workloadIdentityToken && { workloadIdentityToken }),
            });
            if (res.accessToken) {
                // AgentCore Identity vends OAuth access tokens → a bearer credential.
                return {
                    status: 'issued',
                    credential: bearer(res.accessToken),
                    ...(res.expiresAt !== undefined && { expiresAt: res.expiresAt }),
                };
            }
            if (res.authorizationUrl) {
                return {
                    status: 'authorization-required',
                    authorizationUrl: res.authorizationUrl,
                    sessionId: res.sessionId ?? '',
                };
            }
            throw new Error(`agentCoreIdentity: GetResourceOauth2Token for '${req.service}' returned neither ` +
                'an access token nor an authorization URL.');
        },
    };
}
//# sourceMappingURL=agentcore.js.map