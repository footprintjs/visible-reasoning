/**
 * BedrockAgentMemory — read the **auto-generated session-summary memory** of a
 * (legacy) Amazon **Bedrock Agents** agent (peer-dep `@aws-sdk/client-bedrock-agent-runtime`).
 *
 *   import { BedrockAgentMemory } from 'agentfootprint/memory-providers';
 *
 *   const mem = new BedrockAgentMemory({ agentId, agentAliasId, region: 'us-west-2' });
 *   const summaries = await mem.readSummaries(userMemoryId);   // string summaries Bedrock wrote
 *
 * **This is NOT a `MemoryStore`** — and intentionally so. Bedrock Agents *owns the writes*:
 * the agent generates `SESSION_SUMMARY` records itself (`GetAgentMemory` reads them,
 * `DeleteAgentMemory` clears them). There is no "put an arbitrary entry" operation, so wrapping
 * it as a `defineMemory({ store })` would be a "store that can't store." Instead it's a small
 * **reader** you use to *surface* Bedrock's built-in memory — e.g. inject the summaries as a
 * Fact/context block into an agentfootprint agent.
 *
 * For a real read/write agent memory store on AWS, use `AgentCoreStore` (the newer
 * Bedrock **AgentCore** platform) — that's the go-forward path; this targets the prior-gen
 * Bedrock Agents product and exists for teams migrating off it.
 *
 * Role:   Outer ring. Lazy-requires the AWS SDK; zero cost when unused.
 */
import { lazyRequire } from '../../lib/lazyRequire.js';
/**
 * Read-only reader for Bedrock Agents' auto session-summary memory.
 *
 * @throws when `@aws-sdk/client-bedrock-agent-runtime` is not installed and no
 *         `_client`/`_sdk` is supplied.
 */
export class BedrockAgentMemory {
    client;
    agentId;
    agentAliasId;
    maxItems;
    constructor(options) {
        if (!options.agentId || !options.agentAliasId) {
            throw new Error('BedrockAgentMemory requires `agentId` and `agentAliasId`.');
        }
        this.agentId = options.agentId;
        this.agentAliasId = options.agentAliasId;
        this.maxItems = options.maxItems ?? 20;
        this.client =
            options._client ?? options.client ?? createBedrockAgentClient(options.region, options._sdk);
    }
    /** All session summaries Bedrock generated for `memoryId` (paginated). */
    async readSummaries(memoryId, opts = {}) {
        const out = [];
        let nextToken;
        do {
            const page = await this.client.getSessionSummaries({
                agentId: this.agentId,
                agentAliasId: this.agentAliasId,
                memoryId,
                maxItems: opts.maxItems ?? this.maxItems,
                ...(nextToken !== undefined && { nextToken }),
            });
            out.push(...page.summaries);
            nextToken = page.nextToken;
        } while (nextToken);
        return out;
    }
    /** The concatenated summary text — handy to inject as a single context/Fact block. */
    async readText(memoryId) {
        return (await this.readSummaries(memoryId)).map((s) => s.summaryText).join('\n\n');
    }
    /** Clear Bedrock's memory for `memoryId` (optionally a single `sessionId`). */
    async forget(memoryId, sessionId) {
        await this.client.deleteMemory({
            agentId: this.agentId,
            agentAliasId: this.agentAliasId,
            memoryId,
            ...(sessionId !== undefined && { sessionId }),
        });
    }
}
function toIso(v) {
    if (v instanceof Date)
        return v.toISOString();
    return typeof v === 'string' ? v : undefined;
}
function createBedrockAgentClient(region, injected) {
    let mod;
    if (injected) {
        mod = injected;
    }
    else {
        try {
            mod = lazyRequire('@aws-sdk/client-bedrock-agent-runtime');
        }
        catch {
            throw new Error('BedrockAgentMemory requires the `@aws-sdk/client-bedrock-agent-runtime` peer dependency.\n' +
                '  Install:  npm install @aws-sdk/client-bedrock-agent-runtime\n' +
                '  Or pass `client` / `_client`.');
        }
    }
    if (!mod.BedrockAgentRuntimeClient) {
        throw new Error('BedrockAgentMemory: `@aws-sdk/client-bedrock-agent-runtime` is installed but ' +
            '`BedrockAgentRuntimeClient` was not found. Update the SDK.');
    }
    const sdk = new mod.BedrockAgentRuntimeClient({ ...(region && { region }) });
    const send = async (Ctor, name, input) => {
        if (!Ctor) {
            throw new Error(`BedrockAgentMemory: \`@aws-sdk/client-bedrock-agent-runtime\` is missing ${name}. Upgrade the SDK.`);
        }
        return sdk.send(new Ctor(input));
    };
    return {
        async getSessionSummaries({ agentId, agentAliasId, memoryId, maxItems, nextToken }) {
            const r = (await send(mod.GetAgentMemoryCommand, 'GetAgentMemoryCommand', {
                agentId,
                agentAliasId,
                memoryType: 'SESSION_SUMMARY',
                memoryId,
                ...(maxItems !== undefined && { maxItems }),
                ...(nextToken !== undefined && { nextToken }),
            }));
            const summaries = (r?.memoryContents ?? [])
                .map((m) => m.sessionSummary)
                .filter((s) => !!s)
                .map((s) => ({
                sessionId: s.sessionId ?? '',
                summaryText: s.summaryText ?? '',
                ...(toIso(s.sessionStartTime) && { sessionStartTime: toIso(s.sessionStartTime) }),
                ...(toIso(s.sessionExpiryTime) && { sessionExpiryTime: toIso(s.sessionExpiryTime) }),
            }));
            return r?.nextToken ? { summaries, nextToken: r.nextToken } : { summaries };
        },
        async deleteMemory({ agentId, agentAliasId, memoryId, sessionId }) {
            await send(mod.DeleteAgentMemoryCommand, 'DeleteAgentMemoryCommand', {
                agentId,
                agentAliasId,
                memoryId,
                ...(sessionId !== undefined && { sessionId }),
            });
        },
    };
}
//# sourceMappingURL=bedrockAgentMemory.js.map