/**
 * checkin — the evidence-carrying human-consent primitive.
 *
 * "OpenWorker-class agents check in; agentfootprint checks in WITH THE
 * RECEIPTS." A tool declares `checkIn` (see `Tool.checkIn` in `core/tools.ts`); when
 * it trips, the tool-dispatch loop pauses BEFORE executing and surfaces a
 * {@link CheckInRequest} — a typed ask that carries an EVIDENCE PACK
 * ({@link CheckInEvidence}): what the tool will do, what context the run
 * consumed, which context drove the choice, and a compact run-so-far trail.
 * A human answers with {@link checkInApproved} / {@link checkInDeclined};
 * the {@link CheckInDecision} lands as a typed record.
 *
 * This is the LEAF that owns every check-in TYPE + the pure assembly logic.
 * It has zero runtime/engine imports (only type-only imports of the message
 * shape + the influence-core attribution unit), so it stays cheap to import
 * and trivial to unit-test. The pause plumbing lives in
 * `core/agent/stages/toolCalls.ts`; the events in `events/`; the store in
 * `recorders/core/CheckInRecorder.ts`.
 *
 * NOT a policy engine (the `PermissionChecker` in `adapters/types.ts` is
 * untouched, and runs BEFORE this gate) and NOT UI. This asks a person to
 * CONSENT, with the receipts attached.
 *
 * Pattern: Strategy (pluggable evidence assembler + driver scorer) + pure
 *          value types. Every value here survives `structuredClone` + JSON
 *          (checkpoint discipline) — no functions, no class instances.
 */
/**
 * Approve a pending check-in — the paused tool executes normally on resume.
 *
 * @example
 *   const decision = checkInApproved({ by: 'alice@ops', note: 'verified with customer' });
 *   const final = await agent.resume(outcome.checkpoint, decision);
 */
export function checkInApproved(input) {
    return { approved: true, by: input.by, at: Date.now(), ...(input.note && { note: input.note }) };
}
/**
 * Decline a pending check-in — the tool is NOT executed; the model receives
 * a `"declined by human: <note>"` tool result and adapts in-loop.
 *
 * @example
 *   const decision = checkInDeclined({ by: 'alice@ops', note: 'amount too high' });
 *   const final = await agent.resume(outcome.checkpoint, decision);
 */
export function checkInDeclined(input) {
    return { approved: false, by: input.by, at: Date.now(), ...(input.note && { note: input.note }) };
}
/**
 * Type guard — is this resume input a {@link CheckInDecision}? Distinguishes
 * a check-in answer from a plain `askHuman` tool-result value.
 */
export function isCheckInDecision(x) {
    return (typeof x === 'object' &&
        x !== null &&
        typeof x.approved === 'boolean' &&
        typeof x.by === 'string');
}
/**
 * Decide whether a tool's declared demand trips for this call. Returns false
 * when the tool declared no `checkIn` (backward-compatible: byte-identical
 * behavior for tools without the field).
 */
export function shouldCheckIn(demand, args, ctx) {
    if (demand === undefined)
        return false;
    if (demand === 'always')
        return true;
    try {
        return demand(args, ctx) === true;
    }
    catch {
        // A buggy predicate must not let a consequential action slip through
        // unreviewed — fail toward asking the human.
        return true;
    }
}
const WORD_RE = /[a-z0-9]+/g;
const STOP = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'of',
    'in',
    'on',
    'for',
    'with',
    'is',
    'are',
    'this',
    'that',
    'it',
    'as',
    'at',
    'by',
    'be',
    'you',
    'your',
    'i',
]);
function tokenize(text) {
    const out = new Set();
    const lower = text.toLowerCase();
    let m;
    while ((m = WORD_RE.exec(lower))) {
        if (m[0].length > 1 && !STOP.has(m[0]))
            out.add(m[0]);
    }
    WORD_RE.lastIndex = 0;
    return out;
}
/**
 * The default drivers scorer: deterministic Jaccard token overlap between
 * the tool text and each context unit. Zero LLM, zero network, structuredClone
 * -safe output. Ties keep input order (stable sort).
 */
export const lexicalDriverScorer = ({ tool, units }) => {
    const toolTokens = tokenize(tool.text);
    const scored = units.map((u) => {
        const unitTokens = tokenize(u.text);
        let shared = 0;
        for (const t of unitTokens)
            if (toolTokens.has(t))
                shared++;
        const union = toolTokens.size + unitTokens.size - shared;
        const score = union === 0 ? 0 : shared / union;
        return { id: u.id, channel: u.channel, text: u.text, score };
    });
    // Stable descending sort — Array.prototype.sort is stable in modern engines.
    return scored.sort((a, b) => b.score - a.score);
};
const MAX_SUMMARY = 160;
function truncate(s, max = MAX_SUMMARY) {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
/** Render args as a compact `k=v, k=v` string (values truncated, clone-safe). */
function renderArgs(args) {
    const parts = Object.entries(args).map(([k, v]) => {
        const val = typeof v === 'string' ? v : v === null || v === undefined ? String(v) : JSON.stringify(v);
        return `${k}=${truncate(val, 60)}`;
    });
    return parts.join(', ');
}
/** Plain-words "what will happen" claim. */
function buildWillDo(tool, args) {
    const desc = tool.description.trim() || tool.name;
    const rendered = renderArgs(args);
    return rendered ? `${desc} — with ${rendered}` : desc;
}
/**
 * Derive attribution units from the run-so-far conversation: system rules
 * (split into sentences), the user task, and prior tool results. These feed
 * BOTH `read` (as frames) and `drivers` (scored). Ids are unique + stable.
 */
export function unitsFromHistory(history) {
    const units = [];
    let sysN = 0;
    let taskN = 0;
    let resN = 0;
    for (const m of history) {
        const content = (m.content ?? '').trim();
        if (!content)
            continue;
        if (m.role === 'system') {
            // Split the system prompt into rule-sized units so a single rule can be
            // cited. Sentence-ish split; keep non-empty pieces.
            for (const piece of content.split(/(?<=[.!?])\s+|\n+/)) {
                const t = piece.trim();
                if (t)
                    units.push({ id: `system-${++sysN}`, channel: 'system', text: t });
            }
        }
        else if (m.role === 'user') {
            units.push({ id: `task-${++taskN}`, channel: 'task', text: content });
        }
        else if (m.role === 'tool') {
            units.push({
                id: `result-${++resN}`,
                channel: 'result',
                text: m.toolName ? `${m.toolName}: ${content}` : content,
            });
        }
    }
    return units;
}
function framesFromUnits(units) {
    return units.map((u) => ({ channel: u.channel, summary: truncate(u.text) }));
}
function buildTrail(history, iteration) {
    const toolCalls = [];
    for (const m of history) {
        if (m.role === 'tool' && m.toolName) {
            // A tool result whose content advertises an error is marked not-ok. The
            // synthetic strings the loop writes ("[permission denied…]", "declined by
            // human…", "credential error…") all read as failures here.
            const c = (m.content ?? '').toLowerCase();
            const ok = !(c.startsWith('[permission denied') ||
                c.startsWith('declined by human') ||
                c.startsWith('credential error') ||
                c.startsWith('authorization required'));
            toolCalls.push({ name: m.toolName, ok });
        }
    }
    const summary = toolCalls.length === 0
        ? `no tools run yet (iteration ${iteration})`
        : `${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'} run over ${iteration} iteration${iteration === 1 ? '' : 's'}`;
    return { iteration, toolCalls, summary };
}
/**
 * The `'standard'` assembler — fills all four evidence fields. The `drivers`
 * ranking runs the configured scorer over the run-so-far context units; the
 * default scorer is deterministic and makes zero LLM/network calls.
 */
export const standardEvidenceAssembler = async (input) => {
    const { tool, args, iteration, history, scorer, signal } = input;
    const units = unitsFromHistory(history);
    const willDo = buildWillDo(tool, args);
    const read = framesFromUnits(units);
    const trail = buildTrail(history, iteration);
    let drivers = [];
    if (units.length > 0) {
        const toolText = `${tool.name} ${tool.description} ${renderArgs(args)}`.trim();
        drivers = await scorer({
            tool: { name: tool.name, text: toolText },
            units,
            ...(signal && { signal }),
        });
    }
    return { willDo, read, drivers, trail };
};
/** The `'minimal'` assembler — only `willDo`. Zero cost; no scorer call. */
export const minimalEvidenceAssembler = (input) => ({
    willDo: buildWillDo(input.tool, input.args),
});
/**
 * Resolve builder options (or nothing) into a runtime config. The default —
 * `standard` evidence + `lexicalDriverScorer` — makes a tool that declares
 * `checkIn` work even when the builder never called `.checkIn()`.
 */
export function resolveCheckInConfig(opts) {
    const scorer = opts?.scorer ?? lexicalDriverScorer;
    const evidence = opts?.evidence ?? 'standard';
    const assembler = evidence === 'standard'
        ? standardEvidenceAssembler
        : evidence === 'minimal'
            ? minimalEvidenceAssembler
            : evidence;
    return { assembler, scorer };
}
//# sourceMappingURL=checkin.js.map