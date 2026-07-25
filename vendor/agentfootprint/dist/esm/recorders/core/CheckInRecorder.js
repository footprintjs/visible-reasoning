/**
 * CheckInRecorder — the audit record for evidence-carrying human consent.
 *
 * Two exports, both for `agentfootprint.checkin.*`:
 *
 *   • `checkInEventsBridge(...)` — an {@link EmitBridge} factory (same shape as
 *     `costRecorder` / `permissionRecorder`). Forwards `checkin.request` /
 *     `checkin.decision` `$emit`s to the EventDispatcher so
 *     `agent.on('agentfootprint.checkin.*')` fires. Attached ALWAYS by the
 *     Agent (zero-cost until a `checkIn`-declaring tool trips) — this is pure
 *     wiring, not a store.
 *
 *   • `CheckInRecorder` — a compose-a-STORE recorder (no base class). Attach it
 *     with `agent.attach(new CheckInRecorder())` to CAPTURE every ask + decision
 *     as a queryable record — the "the decision is a record" pillar. It reads
 *     the same `$emit` stream (footprintjs calls `onEmit` for every emit), so it
 *     works whether or not any `agent.on(...)` listener is attached.
 *
 * Pattern: Factory over EmitBridge (wiring) + compose-a-store CombinedRecorder
 *          (capture). Telemetry rides the EMIT channel — never CommitBundle.
 */
import { EmitBridge } from './EmitBridge.js';
/**
 * The always-on dispatcher bridge for `agentfootprint.checkin.*`. Wiring only:
 * forwards the emits so typed `agent.on(...)` listeners fire.
 */
export function checkInEventsBridge(options) {
    return new EmitBridge({
        id: options.id ?? 'agentfootprint.checkin-bridge',
        prefix: 'agentfootprint.checkin.',
        dispatcher: options.dispatcher,
        getRunContext: options.getRunContext,
    });
}
/**
 * A queryable store of every check-in ask + decision. Attach once; read after
 * the run (or between runs — it accumulates across `agent.run()` calls until
 * you detach or make a fresh one).
 *
 * @example
 *   const checkins = new CheckInRecorder();
 *   agent.attach(checkins);
 *   await agent.run({ message });
 *   // ...human approves...
 *   await agent.resume(outcome.checkpoint, checkInApproved({ by: 'alice' }));
 *   checkins.getStats();     // { requested: 1, approved: 1, declined: 0, pending: 0 }
 *   checkins.getDecisions(); // [{ toolName, approved: true, by: 'alice', ... }]
 */
export class CheckInRecorder {
    id;
    requests = [];
    decisions = [];
    /**
     * @param id Stable recorder id for idempotent attach/detach. Give distinct
     *           ids if you attach more than one to the same agent.
     */
    constructor(id = 'agentfootprint.checkin-recorder') {
        this.id = id;
    }
    onEmit(event) {
        if (event.name === 'agentfootprint.checkin.request') {
            const p = event.payload;
            this.requests.push({
                toolName: p.toolName,
                toolCallId: p.toolCallId,
                iteration: p.iteration,
                request: p.request,
            });
        }
        else if (event.name === 'agentfootprint.checkin.decision') {
            const p = event.payload;
            this.decisions.push({
                toolName: p.toolName,
                toolCallId: p.toolCallId,
                iteration: p.iteration,
                approved: p.approved,
                by: p.by,
                ...(p.note !== undefined && { note: p.note }),
            });
        }
    }
    /** Every check-in ask captured, oldest first. */
    getRequests() {
        return this.requests;
    }
    /** Every human decision captured, oldest first. */
    getDecisions() {
        return this.decisions;
    }
    /** Roll-up counts. `pending` = asks still awaiting a decision. */
    getStats() {
        let approved = 0;
        let declined = 0;
        for (const d of this.decisions)
            d.approved ? approved++ : declined++;
        return {
            requested: this.requests.length,
            approved,
            declined,
            pending: this.requests.length - this.decisions.length,
        };
    }
    /** Drop all captured records (e.g. between runs when reusing the recorder). */
    reset() {
        this.requests.length = 0;
        this.decisions.length = 0;
    }
}
//# sourceMappingURL=CheckInRecorder.js.map