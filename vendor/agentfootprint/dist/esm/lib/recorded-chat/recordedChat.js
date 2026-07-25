/**
 * recordedChat — the session-scoped turn recorder.
 *
 * `recordedChat({ makeAgent })` returns a `RecordedChat`: `send()` runs one
 * recorded turn through the consumer's agent factory and freezes that turn's
 * evidence immediately; `reason(k)` / `rerunTurn(k)` / `fork(k)` are the
 * per-turn transparency loop, composing with the existing context-bisect
 * surface (`localizeContextBug`, `rerunWithoutSources`) rather than
 * duplicating it. See `./types.ts` for the three traps this owns.
 *
 * Compose-don't-inherit house style: a module-private session class,
 * factory-returned; no base classes.
 */
import { llmCallIdsFromEvents, localizeContextBug, rerunWithoutSources, } from '../context-bisect/index.js';
const DEFAULT_HEADER = 'Recent conversation:';
const DEFAULT_USER_LABEL = 'User';
const DEFAULT_ASSISTANT_LABEL = 'Assistant';
/** Deterministic key for spec dedup — recursively sorts object keys. */
function canonicalKey(value) {
    return JSON.stringify(value, (_key, val) => {
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            const sorted = {};
            for (const k of Object.keys(val).sort()) {
                sorted[k] = val[k];
            }
            return sorted;
        }
        return val;
    });
}
/** Union of ablation specs, deduped by canonical JSON (order-preserving, first wins). */
function dedupeSpecs(specs) {
    const seen = new Set();
    const out = [];
    for (const spec of specs) {
        const key = canonicalKey(spec);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(spec);
    }
    return out;
}
class RecordedChatSession {
    makeAgentFn;
    formatOpt;
    header;
    userLabel;
    assistantLabel;
    /** seed + one (user, assistant) pair per recorded turn. */
    entries;
    seedMessages;
    removedSpecs;
    turnsInternal = [];
    reports = new Map();
    /** result -> turnIndex, the in-process fork-provenance guard. */
    rerunOwner = new WeakMap();
    sending = false;
    forkedFromValue = undefined;
    constructor(options) {
        this.makeAgentFn = options.makeAgent;
        this.formatOpt = options.format;
        this.header = options.format?.header ?? DEFAULT_HEADER;
        this.userLabel = options.format?.userLabel ?? DEFAULT_USER_LABEL;
        this.assistantLabel = options.format?.assistantLabel ?? DEFAULT_ASSISTANT_LABEL;
        this.seedMessages = Object.freeze((options.seed ?? []).map((m) => ({ ...m })));
        this.entries = [...this.seedMessages];
        this.removedSpecs = Object.freeze([...(options.removed ?? [])]);
    }
    get turns() {
        return this.turnsInternal;
    }
    get seed() {
        return this.seedMessages;
    }
    get removed() {
        return this.removedSpecs;
    }
    get forkedFrom() {
        return this.forkedFromValue;
    }
    renderLine(message) {
        const label = message.role === 'user' ? this.userLabel : this.assistantLabel;
        return `${label}: ${message.text}`;
    }
    composeMessage(lines, userMessage) {
        if (lines.length === 0)
            return `${this.userLabel}: ${userMessage}`;
        return `${this.header}\n${lines.join('\n')}\n\n${this.userLabel}: ${userMessage}`;
    }
    async send(userMessage, options) {
        if (this.sending) {
            throw new Error('recordedChat.send: a turn is already in flight — one turn at a time; await the previous send');
        }
        this.sending = true;
        try {
            // Compose the message ONCE, at record time, from the frozen transcript
            // (trap 2 — byte-exact history is threaded HERE and replayed verbatim).
            const transcriptBefore = Object.freeze(this.entries.map((m) => this.renderLine(m)));
            const message = this.composeMessage(transcriptBefore, userMessage);
            const agent = await this.makeAgentFn({ specs: this.removedSpecs, seed: 0 });
            const events = [];
            // Attach the tap BEFORE run() — listener-presence gating drops events
            // otherwise (agentfootprint invariant). Unsubscribe in finally.
            const off = agent.on('*', (event) => {
                events.push(event);
            });
            let out;
            try {
                const raw = await agent.run({
                    message,
                    ...(options?.identity !== undefined ? { identity: options.identity } : {}),
                });
                if (typeof raw !== 'string') {
                    throw new Error("recordedChat.send: the run paused (askHuman/checkIn) — recorded chat turns don't " +
                        'support pauses; drive pausing agents with agent.run() directly');
                }
                out = raw;
            }
            finally {
                off();
            }
            // Capture IMMEDIATELY (trap 1) — getLastSnapshot() is last-run-only, but
            // the per-turn agent is discarded here, so clobbering is impossible.
            const snapshot = agent.getLastSnapshot();
            if (snapshot === undefined) {
                throw new Error('recordedChat.send: the run produced no snapshot — cannot record the turn');
            }
            const lastLlmCallId = llmCallIdsFromEvents(events).at(-1);
            const index = this.turnsInternal.length;
            this.entries.push({ role: 'user', text: userMessage }, { role: 'assistant', text: out });
            const turn = Object.freeze({
                index,
                userMessage,
                reply: out,
                message,
                transcriptBefore,
                artifacts: Object.freeze({ snapshot, events: Object.freeze(events) }),
                lastLlmCallId,
                identity: options?.identity,
            });
            this.turnsInternal.push(turn);
            return turn;
        }
        finally {
            this.sending = false;
        }
    }
    turn(k) {
        const n = this.turnsInternal.length;
        if (!Number.isInteger(k) || k < 0 || k >= n) {
            const range = n === 0 ? '(no turns recorded yet)' : `0..${n - 1}`;
            throw new RangeError(`recordedChat.turn: no turn ${k} — valid range is ${range}`);
        }
        return this.turnsInternal[k];
    }
    async reason(k, options) {
        const turn = this.turn(k);
        const { fresh, atStep, ...rest } = options;
        const memo = this.reports.get(k);
        if (memo !== undefined && fresh !== true)
            return memo;
        const resolvedAtStep = atStep ?? turn.lastLlmCallId;
        const report = await localizeContextBug({
            ...rest,
            artifacts: turn.artifacts,
            ...(resolvedAtStep !== undefined ? { atStep: resolvedAtStep } : {}),
        });
        this.reports.set(k, report);
        return report;
    }
    async rerunTurn(k, options) {
        const turn = this.turn(k);
        const { report: reportOption, ...rerunRest } = options;
        let report = reportOption ?? this.reports.get(k);
        if (report === undefined) {
            report = await this.reason(k, { embedder: options.embedder });
        }
        // Derive the runner from the SAME factory (traps 2 + 3): the frozen
        // message bytes are replayed verbatim, and the session's persistent
        // removals ALWAYS apply on top of the probe's specs (empty specs = the
        // baseline probe, which replays the identical turn).
        const runner = async (specs, run) => {
            const agent = await this.makeAgentFn({
                specs: [...this.removedSpecs, ...specs],
                seed: run.seed,
            });
            const out = await agent.run({
                message: turn.message,
                ...(turn.identity !== undefined ? { identity: turn.identity } : {}),
            });
            if (typeof out !== 'string') {
                throw new Error('recordedChat.rerunTurn: a probe run paused (askHuman/checkIn) — recorded chat re-runs ' +
                    "don't support pauses");
            }
            return out;
        };
        const result = await rerunWithoutSources({
            ...rerunRest,
            report,
            runner,
            originalAnswer: turn.reply,
        });
        this.rerunOwner.set(result, k);
        return result;
    }
    fork(k, options) {
        const turn = this.turn(k);
        const fromRerun = options?.fromRerun;
        if (fromRerun !== undefined && this.rerunOwner.get(fromRerun) !== k) {
            throw new Error(`recordedChat.fork: that result was not produced by this session's rerunTurn for turn ${k} — ` +
                're-run this turn first, then fork');
        }
        const reply = fromRerun?.answer ?? turn.reply;
        const cut = this.seedMessages.length + 2 * k;
        const seed = [
            ...this.entries.slice(0, cut).map((m) => ({ ...m })),
            { role: 'user', text: turn.userMessage },
            { role: 'assistant', text: reply },
        ];
        const removed = dedupeSpecs([...this.removedSpecs, ...(fromRerun?.removed ?? [])]);
        const child = new RecordedChatSession({
            makeAgent: this.makeAgentFn,
            ...(this.formatOpt !== undefined ? { format: this.formatOpt } : {}),
            seed,
            removed,
        });
        child.forkedFromValue = { parent: this, turnIndex: k, viaRerun: fromRerun !== undefined };
        return child;
    }
}
/**
 * Record a chat turn-by-turn so any reply can be explained, counterfactually
 * re-run, and forked — without re-writing the correctness-critical glue every
 * chat host gets subtly wrong. See the [recordedChat guide](doc:recorded-chat).
 */
export function recordedChat(options) {
    return new RecordedChatSession(options);
}
//# sourceMappingURL=recordedChat.js.map