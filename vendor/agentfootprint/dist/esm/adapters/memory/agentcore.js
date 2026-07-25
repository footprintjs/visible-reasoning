/**
 * AgentCoreStore — AWS Bedrock **AgentCore Memory** adapter
 * (peer-dep `@aws-sdk/client-bedrock-agentcore`).
 *
 *   import { AgentCoreStore } from 'agentfootprint/memory-providers';
 *
 *   const store = new AgentCoreStore({
 *     memoryId: 'arn:aws:bedrock-agentcore:us-west-2:...:memory/my-mem',
 *     region: 'us-west-2',
 *   });
 *
 * Pattern: Adapter (GoF) — maps the `MemoryStore` interface onto AgentCore Memory's
 *          data-plane **event** model (`CreateEvent` / `GetEvent` / `ListEvents` /
 *          `DeleteEvent`, `@aws-sdk/client-bedrock-agentcore`):
 *            MemoryIdentity.{tenant,principal}  ↔  AgentCore `actorId`
 *            MemoryIdentity.conversationId      ↔  AgentCore `sessionId`
 *            MemoryEntry                        ↔  one event whose `payload` is a single
 *                                                  `blob` document holding the entry
 *
 * **AgentCore Memory is an append-only event log, not a key-value store.** The server
 * assigns each event's `eventId` on `CreateEvent` (you cannot choose it), and there is no
 * "delete the whole session" call. This shapes the adapter:
 *
 *   • `put`  → `CreateEvent` (append; `actorId` + `eventTimestamp` are required).  O(1)
 *   • `list` → `ListEvents` (paginated, `includePayloads`).  ← window / episodic memory.  O(page)
 *   • `get(id)` / `delete(id)` → list-then-find by the entry id stored in the blob, since
 *     AgentCore's ids are server-assigned.  **O(events in session)** — fine for typical
 *     window sizes; if you need O(1) keyed access at scale, use RedisStore.
 *   • `forget` → `ListEvents` + `DeleteEvent` per event (no `DeleteSession` on AgentCore).
 *   • `search` → still unwired (AgentCore's `RetrieveMemoryRecords` lands as a later helper).
 *   • `putIfVersion` / `seen` / `feedback` → in-process emulation (AgentCore has no native
 *     CAS / dedup / feedback primitive; these don't survive process restart).
 *
 * Role:    Outer ring. Lazy-requires the AWS SDK; zero runtime cost when another adapter is
 *          in use.  Emits: N/A (storage adapters don't emit).
 */
import { lazyRequire } from '../../lib/lazyRequire.js';
const ID_MAX = 99;
/** Build an AgentCore-safe id from arbitrary identity parts (`[A-Za-z0-9_-]`, bounded). */
function safeId(prefix, raw) {
    const slug = raw.replace(/[^A-Za-z0-9_-]/g, '-');
    if (slug.length <= ID_MAX - prefix.length)
        return `${prefix}${slug}`;
    // too long → keep a readable head + a stable hash tail so distinct inputs stay distinct
    const head = slug.slice(0, ID_MAX - prefix.length - 9);
    return `${prefix}${head}-${fnv1a(raw)}`;
}
/**
 * AgentCore Memory-backed `MemoryStore`. Implements every method except `search()`.
 *
 * @throws when `@aws-sdk/client-bedrock-agentcore` is not installed and no `_client`/`_sdk`
 *         is supplied.
 */
export class AgentCoreStore {
    client;
    memoryId;
    pageSize;
    closed = false;
    // In-process shadow state for things AgentCore doesn't surface natively.
    signatures = new Map();
    feedbackBag = new Map();
    constructor(options) {
        if (!options.memoryId)
            throw new Error('AgentCoreStore requires `memoryId`.');
        this.memoryId = options.memoryId;
        this.pageSize = options.pageSize ?? 100;
        if (options._client)
            this.client = options._client;
        else if (options.client)
            this.client = options.client;
        else
            this.client = createAgentCoreClient(options.region, options._sdk);
    }
    // MemoryIdentity → AgentCore (actorId, sessionId). The actor is the user/tenant; the
    // session is the conversation. Both are derived deterministically + id-safe.
    actorId(identity) {
        return safeId('afp-', `${identity.tenant || '_'}_${identity.principal || '_'}`);
    }
    sessionId(identity) {
        return safeId('afp-', identity.conversationId);
    }
    scope(identity) {
        return {
            memoryId: this.memoryId,
            actorId: this.actorId(identity),
            sessionId: this.sessionId(identity),
        };
    }
    shadowKey(identity) {
        return `${identity.tenant || '_'}/${identity.principal || '_'}/${identity.conversationId}`;
    }
    feedbackKey(identity, id) {
        return `${this.shadowKey(identity)}::${id}`;
    }
    /** Walk every event in the session (paginated). */
    async *eachEvent(identity) {
        let nextToken;
        do {
            const page = await this.client.listEvents({
                ...this.scope(identity),
                maxResults: this.pageSize,
                ...(nextToken !== undefined && { nextToken }),
            });
            for (const ev of page.events)
                yield ev;
            nextToken = page.nextToken;
        } while (nextToken);
    }
    // ── MemoryStore implementation ──────────────────────────────────
    async get(identity, id) {
        this.ensureOpen('get');
        // Append-log: an id may have several events (each update appends one). Last write wins —
        // pick the highest version (ties → last seen), independent of AgentCore's list order.
        let found = null;
        for await (const ev of this.eachEvent(identity)) {
            if (ev.entry?.id !== id)
                continue;
            const entry = ev.entry;
            if (found === null || (entry.version ?? 0) >= (found.version ?? 0))
                found = entry;
        }
        if (found && found.ttl !== undefined && found.ttl <= Date.now())
            return null;
        return found;
    }
    async put(identity, entry) {
        this.ensureOpen('put');
        if (entry.ttl !== undefined && entry.ttl <= Date.now())
            return;
        await this.client.createEvent({ ...this.scope(identity), entry: entry });
    }
    async putMany(identity, entries) {
        this.ensureOpen('putMany');
        // AgentCore has no batch-write API; per-session events are conceptually ordered, so
        // sequentialize and let the SDK retry policy handle backoff.
        for (const entry of entries)
            await this.put(identity, entry);
    }
    /**
     * Emulated optimistic concurrency. AgentCore appends unconditionally; we read-then-write
     * inside a JS critical section — adequate for single-writer-per-session deployments.
     */
    async putIfVersion(identity, entry, expectedVersion) {
        this.ensureOpen('putIfVersion');
        const current = await this.get(identity, entry.id);
        if (current === null) {
            if (expectedVersion !== 0)
                return { applied: false };
        }
        else if (current.version !== expectedVersion) {
            return { applied: false, currentVersion: current.version };
        }
        await this.put(identity, entry);
        return { applied: true };
    }
    async list(identity, options = {}) {
        this.ensureOpen('list');
        const page = await this.client.listEvents({
            ...this.scope(identity),
            maxResults: options.limit ?? this.pageSize,
            ...(options.cursor !== undefined && { nextToken: options.cursor }),
        });
        const out = [];
        for (const ev of page.events) {
            const entry = ev.entry;
            if (!entry)
                continue;
            if (entry.ttl !== undefined && entry.ttl <= Date.now())
                continue;
            if (options.tiers && (!entry.tier || !options.tiers.includes(entry.tier)))
                continue;
            out.push(entry);
        }
        return page.nextToken ? { entries: out, cursor: page.nextToken } : { entries: out };
    }
    async delete(identity, id) {
        this.ensureOpen('delete');
        for await (const ev of this.eachEvent(identity)) {
            if (ev.entry?.id === id) {
                await this.client.deleteEvent({ ...this.scope(identity), eventId: ev.eventId });
            }
        }
        this.feedbackBag.delete(this.feedbackKey(identity, id));
    }
    async seen(identity, signature) {
        this.ensureOpen('seen');
        return this.signatures.get(this.shadowKey(identity))?.has(signature) ?? false;
    }
    async recordSignature(identity, signature) {
        this.ensureOpen('recordSignature');
        const key = this.shadowKey(identity);
        const set = this.signatures.get(key) ?? new Set();
        set.add(signature);
        this.signatures.set(key, set);
    }
    async feedback(identity, id, usefulness) {
        this.ensureOpen('feedback');
        if (!Number.isFinite(usefulness))
            return;
        const clamped = Math.max(-1, Math.min(1, usefulness));
        const key = this.feedbackKey(identity, id);
        const cur = this.feedbackBag.get(key) ?? { sum: 0, count: 0 };
        this.feedbackBag.set(key, { sum: cur.sum + clamped, count: cur.count + 1 });
    }
    async getFeedback(identity, id) {
        this.ensureOpen('getFeedback');
        const cur = this.feedbackBag.get(this.feedbackKey(identity, id));
        if (!cur || cur.count === 0)
            return null;
        return { average: cur.sum / cur.count, count: cur.count };
    }
    /** GDPR "everything for this identity, gone." No DeleteSession on AgentCore → delete every event. */
    async forget(identity) {
        this.ensureOpen('forget');
        const ids = [];
        for await (const ev of this.eachEvent(identity))
            ids.push(ev.eventId);
        for (const eventId of ids)
            await this.client.deleteEvent({ ...this.scope(identity), eventId });
        const shadowKey = this.shadowKey(identity);
        this.signatures.delete(shadowKey);
        for (const key of [...this.feedbackBag.keys()]) {
            if (key.startsWith(`${shadowKey}::`))
                this.feedbackBag.delete(key);
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
    }
    ensureOpen(op) {
        if (this.closed)
            throw new Error(`AgentCoreStore.${op}() called after close().`);
    }
}
// ── Helpers ─────────────────────────────────────────────────────────
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}
/** Pull the MemoryEntry out of an AgentCore event's `payload` (a single `blob` document). */
function entryFromPayload(payload) {
    if (!Array.isArray(payload))
        return null;
    for (const p of payload) {
        const blob = p?.blob;
        if (blob && typeof blob === 'object')
            return blob;
    }
    return null;
}
/**
 * Map the entry-semantic `AgentCoreLikeClient` onto the real AgentCore SDK commands.
 * If AWS renames commands, only this function changes.
 */
function createAgentCoreClient(region, injected) {
    let mod;
    if (injected) {
        mod = injected;
    }
    else {
        try {
            mod = lazyRequire('@aws-sdk/client-bedrock-agentcore');
        }
        catch {
            throw new Error('AgentCoreStore requires the `@aws-sdk/client-bedrock-agentcore` peer dependency.\n' +
                '  Install:  npm install @aws-sdk/client-bedrock-agentcore\n' +
                '  Or pass `client` / `_client` for a pre-built or mock client.');
        }
    }
    if (!mod.BedrockAgentCoreClient) {
        throw new Error('AgentCoreStore: `@aws-sdk/client-bedrock-agentcore` is installed but ' +
            '`BedrockAgentCoreClient` was not found. Update the SDK.');
    }
    const sdk = new mod.BedrockAgentCoreClient({ ...(region && { region }) });
    const send = async (Ctor, name, input) => {
        if (!Ctor) {
            throw new Error(`AgentCoreStore: \`@aws-sdk/client-bedrock-agentcore\` is missing ${name}. Upgrade the SDK.`);
        }
        return sdk.send(new Ctor(input));
    };
    return {
        async createEvent({ memoryId, actorId, sessionId, entry }) {
            // The entry is stored as a single `blob` document (PayloadType.blob = __DocumentType).
            await send(mod.CreateEventCommand, 'CreateEventCommand', {
                memoryId,
                actorId,
                sessionId,
                eventTimestamp: new Date(),
                payload: [{ blob: entry }],
            });
        },
        async listEvents({ memoryId, actorId, sessionId, maxResults, nextToken }) {
            const r = (await send(mod.ListEventsCommand, 'ListEventsCommand', {
                memoryId,
                actorId,
                sessionId,
                includePayloads: true,
                ...(maxResults !== undefined && { maxResults }),
                ...(nextToken !== undefined && { nextToken }),
            }));
            const events = (r?.events ?? []).map((ev) => ({
                eventId: ev.eventId ?? '',
                entry: entryFromPayload(ev.payload),
            }));
            return r?.nextToken ? { events, nextToken: r.nextToken } : { events };
        },
        async deleteEvent({ memoryId, actorId, sessionId, eventId }) {
            await send(mod.DeleteEventCommand, 'DeleteEventCommand', {
                memoryId,
                actorId,
                sessionId,
                eventId,
            });
        },
    };
}
//# sourceMappingURL=agentcore.js.map