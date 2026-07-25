/**
 * InOutRecorder — captures every chart's input/output as entry/exit pairs.
 *
 * The gap this fills:
 *   Every chart in footprintjs has two natural data boundaries:
 *     - the **input** that flowed in (top-level: `run({input})`;
 *       subflow: `inputMapper` result)
 *     - the **output** that flowed out (top-level: chart return value;
 *       subflow: shared state at exit / `outputMapper` result)
 *
 *   Together with `TopologyRecorder` (composition shape) this is the
 *   universal "step" primitive that downstream layers project — a Lens
 *   StepGraph, a Trace view, custom dashboards. All bind by `runtimeStageId`.
 *
 *   The root chart is treated identically to any subflow: an `entry`
 *   boundary on `onRunStart` and an `exit` boundary on `onRunEnd`, with
 *   `subflowId: '__root__'`. So consumers building "every step has an
 *   in/out arrow" views can close the chain at the top level — no
 *   special-case rendering required.
 *
 * Two boundary phases per chart execution:
 *   1. `phase: 'entry'` — payload = the input crossing the boundary IN
 *   2. `phase: 'exit'`  — payload = the output crossing the boundary OUT
 *
 *   Loops re-entering the same subflow get distinct `runtimeStageId`s
 *   automatically (parent stage's executionIndex increments per iteration).
 *
 * Pause semantics:
 *   When a stage pauses inside a subflow, the engine re-throws the pause
 *   signal without firing `onSubflowExit` (or `onRunEnd`). The subflow
 *   has an `entry` with no matching `exit` until the run resumes and
 *   exits cleanly. Consumers should handle entry-without-exit gracefully
 *   (it means "in progress" or "paused"). The `getBoundary()` helper
 *   returns `{ entry, exit: undefined }` in that case.
 *
 * Redaction:
 *   Payload redaction is the engine's responsibility (`RedactionPolicy`).
 *   By the time payloads reach this recorder via `FlowSubflowEvent` or
 *   `FlowRunEvent`, redactable values are already scrubbed. The recorder
 *   does not (and should not) re-redact.
 *
 * @example
 * ```typescript
 * import { inOutRecorder } from 'footprintjs/trace';
 *
 * const inOut = inOutRecorder();
 * executor.attachCombinedRecorder(inOut);
 * await executor.run({ input });
 *
 * inOut.getSteps();                    // entry boundaries — timeline projection
 * inOut.getBoundary(runtimeStageId);   // { entry, exit } pair for one execution
 * inOut.getBoundaries();               // flat list (entry+exit interleaved)
 * inOut.getRootBoundary();             // { entry, exit } for the top-level run
 * ```
 *
 * @example Filtering by subflow path
 * ```typescript
 * const agentSteps = inOut
 *   .getSteps()
 *   .filter((b) => b.subflowPath[1] === 'sf-agent');  // path[0] is the root
 * ```
 */
import { SequenceStore } from './SequenceStore.js';
/** Synthetic id for the top-level run's boundary pair. */
export const ROOT_SUBFLOW_ID = '__root__';
/** Synthetic runtimeStageId for the top-level run boundary pair. */
export const ROOT_RUNTIME_STAGE_ID = '__root__#0';
let _counter = 0;
/**
 * Factory — matches the `topologyRecorder()` / `narrative()` style.
 */
export function inOutRecorder(options = {}) {
    return new InOutRecorder(options);
}
/**
 * Stateful accumulator that watches `FlowRecorder` chart-boundary events
 * (run start/end + subflow entry/exit) and pushes `InOutEntry` records to
 * its composed `SequenceStore` (Convention 1 — one purpose per recorder).
 *
 * Attach via `executor.attachCombinedRecorder(recorder)` — footprintjs
 * detects the `FlowRecorder` method shape and routes events.
 */
export class InOutRecorder {
    id;
    /** 1:N ordered storage with per-step index (Convention 1 — composed). */
    store = new SequenceStore();
    constructor(options = {}) {
        this.id = options.id ?? `inout-${++_counter}`;
    }
    // ── FlowRecorder hooks ────────────────────────────────────────────────
    onRunStart(event) {
        this.store.push(buildRootEntry('entry', event.payload));
    }
    onRunEnd(event) {
        this.store.push(buildRootEntry('exit', event.payload));
    }
    onSubflowEntry(event) {
        const entry = buildSubflowEntry(event, 'entry');
        if (entry)
            this.store.push(entry);
    }
    onSubflowExit(event) {
        const entry = buildSubflowEntry(event, 'exit');
        if (entry)
            this.store.push(entry);
    }
    // ── Query API ─────────────────────────────────────────────────────────
    /** All entries in execution order (entry+exit interleaved). */
    getBoundaries() {
        return this.store.getAll();
    }
    /** Entry/exit pair for one chart execution.
     *  Returns `{ entry, exit }` — `exit` is `undefined` for in-progress / paused
     *  charts or if `runtimeStageId` is unknown. */
    getBoundary(runtimeStageId) {
        const entries = this.store.getByKey(runtimeStageId);
        return {
            entry: entries.find((e) => e.phase === 'entry'),
            exit: entries.find((e) => e.phase === 'exit'),
        };
    }
    /** Just the `entry`-phase boundaries — the "step list" projection in
     *  execution order. This is the natural timeline of chart executions
     *  for slider / scrubbing UIs. The top-level run's entry is the first
     *  step (depth 0). */
    getSteps() {
        const steps = [];
        for (const b of this.store.getAll()) {
            if (b.phase === 'entry')
                steps.push(b);
        }
        return steps;
    }
    /** O(1) lookup: all boundary entries (both phases) for one runtimeStageId. */
    getEntriesForStep(runtimeStageId) {
        return this.store.getByKey(runtimeStageId);
    }
    /** Pre-built per-step range index — O(1) lookups for time-travel scrubbing. */
    getEntryRanges() {
        return this.store.getEntryRanges();
    }
    /** Progressive reveal: boundaries whose runtimeStageId is in the visible set. */
    getEntriesUpTo(visibleIds) {
        return this.store.getEntriesUpTo(visibleIds);
    }
    /** Clear all stored boundaries — called by the executor before each run(). */
    clear() {
        this.store.clear();
    }
    /** The root run's entry/exit pair, if the run has started.
     *  Convenience for consumers that want to bracket the timeline by the
     *  outermost in/out. */
    getRootBoundary() {
        return this.getBoundary(ROOT_RUNTIME_STAGE_ID);
    }
    /** Snapshot bundle for inclusion in `executor.getSnapshot()`. */
    toSnapshot() {
        return {
            name: 'InOut',
            description: 'Chart in/out stream — entry/exit pairs at every chart boundary (root + subflows)',
            preferredOperation: 'translate',
            data: this.getBoundaries(),
        };
    }
}
// ── Internal helpers ──────────────────────────────────────────────────
/**
 * Build the synthetic root entry/exit. Depth is `0` and the path is
 * `[ROOT_SUBFLOW_ID]` so consumers grouping by path see the root as a
 * regular top-level container.
 */
function buildRootEntry(phase, payload) {
    return {
        runtimeStageId: ROOT_RUNTIME_STAGE_ID,
        subflowId: ROOT_SUBFLOW_ID,
        localSubflowId: ROOT_SUBFLOW_ID,
        subflowName: 'Run',
        subflowPath: [ROOT_SUBFLOW_ID],
        depth: 0,
        phase,
        payload,
        isRoot: true,
    };
}
/**
 * Build a subflow `InOutEntry` from a `FlowSubflowEvent`.
 *
 * Returns `undefined` when the event lacks a `subflowId` (anonymous /
 * malformed subflow events — same defensive policy as `TopologyRecorder`).
 *
 * Path derivation: the engine emits `subflowId` already prefixed with the
 * full path of parent subflows (e.g. `'sf-outer/sf-inner'`). We decompose
 * that into segments to populate `subflowPath` and compute `depth`.
 *
 * Subflows nest UNDER the synthetic root in `subflowPath` so the tree is
 * complete: a top-level subflow has path `['__root__', 'sf-x']` and depth 1.
 */
function buildSubflowEntry(event, phase) {
    const subflowId = event.subflowId;
    if (!subflowId)
        return undefined;
    const runtimeStageId = event.traversalContext?.runtimeStageId ?? '';
    const segments = subflowId.split('/').filter((s) => s.length > 0);
    const subflowPath = [ROOT_SUBFLOW_ID, ...segments];
    const depth = subflowPath.length - 1;
    const localSubflowId = segments[segments.length - 1] ?? subflowId;
    const payload = phase === 'entry' ? event.mappedInput : event.outputState;
    return {
        runtimeStageId,
        subflowId,
        localSubflowId,
        subflowName: event.name,
        description: event.description,
        subflowPath,
        depth,
        phase,
        payload,
        isRoot: false,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiSW5PdXRSZWNvcmRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVjb3JkZXIvSW5PdXRSZWNvcmRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTZERztBQUdILE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQU1uRCwwREFBMEQ7QUFDMUQsTUFBTSxDQUFDLE1BQU0sZUFBZSxHQUFHLFVBQVUsQ0FBQztBQUUxQyxvRUFBb0U7QUFDcEUsTUFBTSxDQUFDLE1BQU0scUJBQXFCLEdBQUcsWUFBWSxDQUFDO0FBbURsRCxJQUFJLFFBQVEsR0FBRyxDQUFDLENBQUM7QUFFakI7O0dBRUc7QUFDSCxNQUFNLFVBQVUsYUFBYSxDQUFDLFVBQWdDLEVBQUU7SUFDOUQsT0FBTyxJQUFJLGFBQWEsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNwQyxDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILE1BQU0sT0FBTyxhQUFhO0lBQ2YsRUFBRSxDQUFTO0lBQ3BCLHlFQUF5RTtJQUN4RCxLQUFLLEdBQUcsSUFBSSxhQUFhLEVBQWMsQ0FBQztJQUV6RCxZQUFZLFVBQWdDLEVBQUU7UUFDNUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxPQUFPLENBQUMsRUFBRSxJQUFJLFNBQVMsRUFBRSxRQUFRLEVBQUUsQ0FBQztJQUNoRCxDQUFDO0lBRUQseUVBQXlFO0lBRXpFLFVBQVUsQ0FBQyxLQUFtQjtRQUM1QixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQzFELENBQUM7SUFFRCxRQUFRLENBQUMsS0FBbUI7UUFDMUIsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDLE1BQU0s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KiBJbk91dFJlY29yZGVyIOKAlCBjYXB0dXJlcyBldmVyeSBjaGFydCdzIGlucHV0L291dHB1dCBhcyBlbnRyeS9leGl0IHBhaXJzLlxuICpcbiAqIFRoZSBnYXAgdGhpcyBmaWxsczpcbiAqICAgRXZlcnkgY2hhcnQgaW4gZm9vdHByaW50anMgaGFzIHR3byBuYXR1cmFsIGRhdGEgYm91bmRhcmllczpcbiAqICAgICAtIHRoZSAqKmlucHV0KiogdGhhdCBmbG93ZWQgaW4gKHRvcC1sZXZlbDogYHJ1bih7aW5wdXR9KWA7XG4gKiAgICAgICBzdWJmbG93OiBgaW5wdXRNYXBwZXJgIHJlc3VsdClcbiAqICAgICAtIHRoZSAqKm91dHB1dCoqIHRoYXQgZmxvd2VkIG91dCAodG9wLWxldmVsOiBjaGFydCByZXR1cm4gdmFsdWU7XG4gKiAgICAgICBzdWJmbG93OiBzaGFyZWQgc3RhdGUgYXQgZXhpdCAvIGBvdXRwdXRNYXBwZXJgIHJlc3VsdClcbiAqXG4gKiAgIFRvZ2V0aGVyIHdpdGggYFRvcG9sb2d5UmVjb3JkZXJgIChjb21wb3NpdGlvbiBzaGFwZSkgdGhpcyBpcyB0aGVcbiAqICAgdW5pdmVyc2FsIFwic3RlcFwiIHByaW1pdGl2ZSB0aGF0IGRvd25zdHJlYW0gbGF5ZXJzIHByb2plY3Qg4oCUIGEgTGVuc1xuICogICBTdGVwR3JhcGgsIGEgVHJhY2UgdmlldywgY3VzdG9tIGRhc2hib2FyZHMuIEFsbCBiaW5kIGJ5IGBydW50aW1lU3RhZ2VJZGAuXG4gKlxuICogICBUaGUgcm9vdCBjaGFydCBpcyB0cmVhdGVkIGlkZW50aWNhbGx5IHRvIGFueSBzdWJmbG93OiBhbiBgZW50cnlgXG4gKiAgIGJvdW5kYXJ5IG9uIGBvblJ1blN0YXJ0YCBhbmQgYW4gYGV4aXRgIGJvdW5kYXJ5IG9uIGBvblJ1bkVuZGAsIHdpdGhcbiAqICAgYHN1YmZsb3dJZDogJ19fcm9vdF9fJ2AuIFNvIGNvbnN1bWVycyBidWlsZGluZyBcImV2ZXJ5IHN0ZXAgaGFzIGFuXG4gKiAgIGluL291dCBhcnJvd1wiIHZpZXdzIGNhbiBjbG9zZSB0aGUgY2hhaW4gYXQgdGhlIHRvcCBsZXZlbCDigJQgbm9cbiAqICAgc3BlY2lhbC1jYXNlIHJlbmRlcmluZyByZXF1aXJlZC5cbiAqXG4gKiBUd28gYm91bmRhcnkgcGhhc2VzIHBlciBjaGFydCBleGVjdXRpb246XG4gKiAgIDEuIGBwaGFzZTogJ2VudHJ5J2Ag4oCUIHBheWxvYWQgPSB0aGUgaW5wdXQgY3Jvc3NpbmcgdGhlIGJvdW5kYXJ5IElOXG4gKiAgIDIuIGBwaGFzZTogJ2V4aXQnYCAg4oCUIHBheWxvYWQgPSB0aGUgb3V0cHV0IGNyb3NzaW5nIHRoZSBib3VuZGFyeSBPVVRcbiAqXG4gKiAgIExvb3BzIHJlLWVudGVyaW5nIHRoZSBzYW1lIHN1YmZsb3cgZ2V0IGRpc3RpbmN0IGBydW50aW1lU3RhZ2VJZGBzXG4gKiAgIGF1dG9tYXRpY2FsbHkgKHBhcmVudCBzdGFnZSdzIGV4ZWN1dGlvbkluZGV4IGluY3JlbWVudHMgcGVyIGl0ZXJhdGlvbikuXG4gKlxuICogUGF1c2Ugc2VtYW50aWNzOlxuICogICBXaGVuIGEgc3RhZ2UgcGF1c2VzIGluc2lkZSBhIHN1YmZsb3csIHRoZSBlbmdpbmUgcmUtdGhyb3dzIHRoZSBwYXVzZVxuICogICBzaWduYWwgd2l0aG91dCBmaXJpbmcgYG9uU3ViZmxvd0V4aXRgIChvciBgb25SdW5FbmRgKS4gVGhlIHN1YmZsb3dcbiAqICAgaGFzIGFuIGBlbnRyeWAgd2l0aCBubyBtYXRjaGluZyBgZXhpdGAgdW50aWwgdGhlIHJ1biByZXN1bWVzIGFuZFxuICogICBleGl0cyBjbGVhbmx5LiBDb25zdW1lcnMgc2hvdWxkIGhhbmRsZSBlbnRyeS13aXRob3V0LWV4aXQgZ3JhY2VmdWxseVxuICogICAoaXQgbWVhbnMgXCJpbiBwcm9ncmVzc1wiIG9yIFwicGF1c2VkXCIpLiBUaGUgYGdldEJvdW5kYXJ5KClgIGhlbHBlclxuICogICByZXR1cm5zIGB7IGVudHJ5LCBleGl0OiB1bmRlZmluZWQgfWAgaW4gdGhhdCBjYXNlLlxuICpcbiAqIFJlZGFjdGlvbjpcbiAqICAgUGF5bG9hZCByZWRhY3Rpb24gaXMgdGhlIGVuZ2luZSdzIHJlc3BvbnNpYmlsaXR5IChgUmVkYWN0aW9uUG9saWN5YCkuXG4gKiAgIEJ5IHRoZSB0aW1lIHBheWxvYWRzIHJlYWNoIHRoaXMgcmVjb3JkZXIgdmlhIGBGbG93U3ViZmxvd0V2ZW50YCBvclxuICogICBgRmxvd1J1bkV2ZW50YCwgcmVkYWN0YWJsZSB2YWx1ZXMgYXJlIGFscmVhZHkgc2NydWJiZWQuIFRoZSByZWNvcmRlclxuICogICBkb2VzIG5vdCAoYW5kIHNob3VsZCBub3QpIHJlLXJlZGFjdC5cbiAqXG4gKiBAZXhhbXBsZVxuICogYGBgdHlwZXNjcmlwdFxuICogaW1wb3J0IHsgaW5PdXRSZWNvcmRlciB9IGZyb20gJ2Zvb3RwcmludGpzL3RyYWNlJztcbiAqXG4gKiBjb25zdCBpbk91dCA9IGluT3V0UmVjb3JkZXIoKTtcbiAqIGV4ZWN1dG9yLmF0dGFjaENvbWJpbmVkUmVjb3JkZXIoaW5PdXQpO1xuICogYXdhaXQgZXhlY3V0b3IucnVuKHsgaW5wdXQgfSk7XG4gKlxuICogaW5PdXQuZ2V0U3RlcHMoKTsgICAgICAgICAgICAgICAgICAgIC8vIGVudHJ5IGJvdW5kYXJpZXMg4oCUIHRpbWVsaW5lIHByb2plY3Rpb25cbiAqIGluT3V0LmdldEJvdW5kYXJ5KHJ1bnRpbWVTdGFnZUlkKTsgICAvLyB7IGVudHJ5LCBleGl0IH0gcGFpciBmb3Igb25lIGV4ZWN1dGlvblxuICogaW5PdXQuZ2V0Qm91bmRhcmllcygpOyAgICAgICAgICAgICAgIC8vIGZsYXQgbGlzdCAoZW50cnkrZXhpdCBpbnRlcmxlYXZlZClcbiAqIGluT3V0LmdldFJvb3RCb3VuZGFyeSgpOyAgICAgICAgICAgICAvLyB7IGVudHJ5LCBleGl0IH0gZm9yIHRoZSB0b3AtbGV2ZWwgcnVuXG4gKiBgYGBcbiAqXG4gKiBAZXhhbXBsZSBGaWx0ZXJpbmcgYnkgc3ViZmxvdyBwYXRoXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBjb25zdCBhZ2VudFN0ZXBzID0gaW5PdXRcbiAqICAgLmdldFN0ZXBzKClcbiAqICAgLmZpbHRlcigoYikgPT4gYi5zdWJmbG93UGF0aFsxXSA9PT0gJ3NmLWFnZW50Jyk7ICAvLyBwYXRoWzBdIGlzIHRoZSByb290XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZsb3dSZWNvcmRlciwgRmxvd1J1bkV2ZW50LCBGbG93U3ViZmxvd0V2ZW50IH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBTZXF1ZW5jZVN0b3JlIH0gZnJvbSAnLi9TZXF1ZW5jZVN0b3JlLmpzJztcblxuLy8g4pSA4pSAIFR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgdHlwZSBJbk91dFBoYXNlID0gJ2VudHJ5JyB8ICdleGl0JztcblxuLyoqIFN5bnRoZXRpYyBpZCBmb3IgdGhlIHRvcC1sZXZlbCBydW4ncyBib3VuZGFyeSBwYWlyLiAqL1xuZXhwb3J0IGNvbnN0IFJPT1RfU1VCRkxPV19JRCA9ICdfX3Jvb3RfXyc7XG5cbi8qKiBTeW50aGV0aWMgcnVudGltZVN0YWdlSWQgZm9yIHRoZSB0b3AtbGV2ZWwgcnVuIGJvdW5kYXJ5IHBhaXIuICovXG5leHBvcnQgY29uc3QgUk9PVF9SVU5USU1FX1NUQUdFX0lEID0gJ19fcm9vdF9fIzAnO1xuXG4vKipcbiAqIE9uZSBoYWxmIG9mIGEgY2hhcnQgZXhlY3V0aW9uIGJvdW5kYXJ5LiBFbnRyeS9leGl0IHBhaXJzIHNoYXJlIGBydW50aW1lU3RhZ2VJZGAuXG4gKlxuICogTmFtaW5nIGZvbGxvd3MgdGhlIGVuZ2luZTogYHN1YmZsb3dJZGAgaXMgdGhlIHBhdGgtcHJlZml4ZWQgaWRlbnRpZmllciB0aGVcbiAqIGVuZ2luZSBlbWl0cyAoZS5nLiBgJ3NmLW91dGVyL3NmLWlubmVyJ2AgZm9yIG5lc3RlZCBzdWJmbG93cykuIEZvciB0aGVcbiAqIHRvcC1sZXZlbCBydW4sIGl0J3MgdGhlIHN5bnRoZXRpYyBgJ19fcm9vdF9fJ2AuIGBzdWJmbG93UGF0aGAgaXMgdGhlXG4gKiBkZWNvbXBvc2l0aW9uIGludG8gc2VnbWVudHMg4oCUIHByb3ZpZGVkIGFzIGEgY29udmVuaWVuY2UgYmVjYXVzZSBjb25zdW1lcnNcbiAqIG9mdGVuIHF1ZXJ5IC8gZ3JvdXAgYnkgdGhlIHBhdGggdHJlZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBJbk91dEVudHJ5IHtcbiAgLyoqIHJ1bnRpbWVTdGFnZUlkIOKAlCBzYW1lIHZhbHVlIGZvciB0aGUgZW50cnkvZXhpdCBwYWlyIG9mIG9uZSBleGVjdXRpb24uXG4gICAqICBUb3AtbGV2ZWwgcnVuIHVzZXMgdGhlIHN5bnRoZXRpYyBgUk9PVF9SVU5USU1FX1NUQUdFX0lEYC4gKi9cbiAgcmVhZG9ubHkgcnVudGltZVN0YWdlSWQ6IHN0cmluZztcbiAgLyoqIFBhdGgtcHJlZml4ZWQgc3ViZmxvdyBpZGVudGlmaWVyIChtYXRjaGVzIHRoZSBlbmdpbmUncyBgRmxvd1N1YmZsb3dFdmVudC5zdWJmbG93SWRgKS5cbiAgICogIFRvcC1sZXZlbCDihpIgYCdfX3Jvb3RfXydgLiBTdWJmbG93IOKGkiBgJ3NmLW91dGVyJ2Agb3IgYCdzZi1vdXRlci9zZi1pbm5lcidgLiAqL1xuICByZWFkb25seSBzdWJmbG93SWQ6IHN0cmluZztcbiAgLyoqIExhc3Qgc2VnbWVudCBvZiBgc3ViZmxvd0lkYCDigJQgY29udmVuaWVuY2UgZm9yIGNvbnN1bWVycyB0aGF0IGdyb3VwIGJ5IGxlYWYgbmFtZS5cbiAgICogIFRvcC1sZXZlbCDihpIgYCdfX3Jvb3RfXydgLiAqL1xuICByZWFkb25seSBsb2NhbFN1YmZsb3dJZDogc3RyaW5nO1xuICAvKiogSHVtYW4tcmVhZGFibGUgZGlzcGxheSBuYW1lIChmcm9tIHRoZSBidWlsZGVyOyBgJ1J1bidgIGZvciB0aGUgdG9wLWxldmVsIHJ1bikuICovXG4gIHJlYWRvbmx5IHN1YmZsb3dOYW1lOiBzdHJpbmc7XG4gIC8qKiBCdWlsZC10aW1lIGRlc2NyaXB0aW9uIGZyb20gdGhlIHN1YmZsb3cncyByb290IHN0YWdlLlxuICAgKiAgQ2FycmllcyB0YXhvbm9teSBtYXJrZXJzIChlLmcuIGAnQWdlbnQ6IFJlQWN0IGxvb3AnYCkuIFVuZGVmaW5lZCBmb3Igcm9vdC4gKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIC8qKiBEZWNvbXBvc2l0aW9uIG9mIGBzdWJmbG93SWRgIGludG8gc2VnbWVudHMuIFRvcC1sZXZlbCDihpIgYFsnX19yb290X18nXWAuXG4gICAqICBTdWJmbG93cyBsaXZlIFVOREVSIHRoZSByb290OiBhIHRvcC1sZXZlbCBzdWJmbG93IGhhcyBwYXRoIGBbJ19fcm9vdF9fJywgJ3NmLXgnXWAuICovXG4gIHJlYWRvbmx5IHN1YmZsb3dQYXRoOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIERlcHRoIGluIHRoZSBzdWJmbG93IHRyZWUuIFJvb3Qg4oaSIDAuIEZpcnN0LWxldmVsIHN1YmZsb3cg4oaSIDEuICovXG4gIHJlYWRvbmx5IGRlcHRoOiBudW1iZXI7XG4gIC8qKiBXaGljaCBzaWRlIG9mIHRoZSBib3VuZGFyeSB0aGlzIGVudHJ5IHJlcHJlc2VudHMuICovXG4gIHJlYWRvbmx5IHBoYXNlOiBJbk91dFBoYXNlO1xuICAvKiogRGF0YSBjcm9zc2luZyB0aGUgYm91bmRhcnkuXG4gICAqICAtIGBwaGFzZTogJ2VudHJ5J2Ag4oaSIGBpbnB1dE1hcHBlcmAgcmVzdWx0IChzdWJmbG93KSBvciBgcnVuKHtpbnB1dH0pYCAocm9vdClcbiAgICogIC0gYHBoYXNlOiAnZXhpdCdgICDihpIgc3ViZmxvdyBzaGFyZWQgc3RhdGUgYXQgZXhpdCAoc3ViZmxvdykgb3IgY2hhcnQgcmV0dXJuIHZhbHVlIChyb290KVxuICAgKlxuICAgKiAgVW5kZWZpbmVkIHdoZW4gbm8gbWFwcGVyIC8gbm8gaW5wdXQgd2FzIHByb3ZpZGVkLiAqL1xuICByZWFkb25seSBwYXlsb2FkPzogdW5rbm93bjtcbiAgLyoqIFRydWUgd2hlbiB0aGlzIGVudHJ5IGNhbWUgZnJvbSB0aGUgdG9wLWxldmVsIHJ1biAoYG9uUnVuU3RhcnRgIC8gYG9uUnVuRW5kYClcbiAgICogIHJhdGhlciB0aGFuIGZyb20gYSBzdWJmbG93IChgb25TdWJmbG93RW50cnlgIC8gYG9uU3ViZmxvd0V4aXRgKS5cbiAgICogIExlbnMgdXNlcyB0aGlzIHRvIHJlbmRlciB0aGUgcm9vdCBwYWlyIGFzIGB1c2VyIOKGkiBydW4g4oaSIHVzZXJgIGluc3RlYWQgb2ZcbiAgICogIHRoZSByZWd1bGFyIHN1YmZsb3cgc2hhcGUuICovXG4gIHJlYWRvbmx5IGlzUm9vdDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJbk91dFJlY29yZGVyT3B0aW9ucyB7XG4gIC8qKiBTY29wZVJlY29yZGVyIGlkLiBEZWZhdWx0cyB0byBgaW5vdXQtTmAgKGF1dG8taW5jcmVtZW50ZWQpLiAqL1xuICBpZD86IHN0cmluZztcbn1cblxubGV0IF9jb3VudGVyID0gMDtcblxuLyoqXG4gKiBGYWN0b3J5IOKAlCBtYXRjaGVzIHRoZSBgdG9wb2xvZ3lSZWNvcmRlcigpYCAvIGBuYXJyYXRpdmUoKWAgc3R5bGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbk91dFJlY29yZGVyKG9wdGlvbnM6IEluT3V0UmVjb3JkZXJPcHRpb25zID0ge30pOiBJbk91dFJlY29yZGVyIHtcbiAgcmV0dXJuIG5ldyBJbk91dFJlY29yZGVyKG9wdGlvbnMpO1xufVxuXG4vKipcbiAqIFN0YXRlZnVsIGFjY3VtdWxhdG9yIHRoYXQgd2F0Y2hlcyBgRmxvd1JlY29yZGVyYCBjaGFydC1ib3VuZGFyeSBldmVudHNcbiAqIChydW4gc3RhcnQvZW5kICsgc3ViZmxvdyBlbnRyeS9leGl0KSBhbmQgcHVzaGVzIGBJbk91dEVudHJ5YCByZWNvcmRzIHRvXG4gKiBpdHMgY29tcG9zZWQgYFNlcXVlbmNlU3RvcmVgIChDb252ZW50aW9uIDEg4oCUIG9uZSBwdXJwb3NlIHBlciByZWNvcmRlcikuXG4gKlxuICogQXR0YWNoIHZpYSBgZXhlY3V0b3IuYXR0YWNoQ29tYmluZWRSZWNvcmRlcihyZWNvcmRlcilgIOKAlCBmb290cHJpbnRqc1xuICogZGV0ZWN0cyB0aGUgYEZsb3dSZWNvcmRlcmAgbWV0aG9kIHNoYXBlIGFuZCByb3V0ZXMgZXZlbnRzLlxuICovXG5leHBvcnQgY2xhc3MgSW5PdXRSZWNvcmRlciBpbXBsZW1lbnRzIEZsb3dSZWNvcmRlciB7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gIC8qKiAxOk4gb3JkZXJlZCBzdG9yYWdlIHdpdGggcGVyLXN0ZXAgaW5kZXggKENvbnZlbnRpb24gMSDigJQgY29tcG9zZWQpLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHN0b3JlID0gbmV3IFNlcXVlbmNlU3RvcmU8SW5PdXRFbnRyeT4oKTtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBJbk91dFJlY29yZGVyT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5pZCA9IG9wdGlvbnMuaWQgPz8gYGlub3V0LSR7KytfY291bnRlcn1gO1xuICB9XG5cbiAgLy8g4pSA4pSAIEZsb3dSZWNvcmRlciBob29rcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBvblJ1blN0YXJ0KGV2ZW50OiBGbG93UnVuRXZlbnQpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3JlLnB1c2goYnVpbGRSb290RW50cnkoJ2VudHJ5JywgZXZlbnQucGF5bG9hZCkpO1xuICB9XG5cbiAgb25SdW5FbmQoZXZlbnQ6IEZsb3dSdW5FdmVudCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcmUucHVzaChidWlsZFJvb3RFbnRyeSgnZXhpdCcsIGV2ZW50LnBheWxvYWQpKTtcbiAgfVxuXG4gIG9uU3ViZmxvd0VudHJ5KGV2ZW50OiBGbG93U3ViZmxvd0V2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgZW50cnkgPSBidWlsZFN1YmZsb3dFbnRyeShldmVudCwgJ2VudHJ5Jyk7XG4gICAgaWYgKGVudHJ5KSB0aGlzLnN0b3JlLnB1c2goZW50cnkpO1xuICB9XG5cbiAgb25TdWJmbG93RXhpdChldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGVudHJ5ID0gYnVpbGRTdWJmbG93RW50cnkoZXZlbnQsICdleGl0Jyk7XG4gICAgaWYgKGVudHJ5KSB0aGlzLnN0b3JlLnB1c2goZW50cnkpO1xuICB9XG5cbiAgLy8g4pSA4pSAIFF1ZXJ5IEFQSSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQWxsIGVudHJpZXMgaW4gZXhlY3V0aW9uIG9yZGVyIChlbnRyeStleGl0IGludGVybGVhdmVkKS4gKi9cbiAgZ2V0Qm91bmRhcmllcygpOiBJbk91dEVudHJ5W10ge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldEFsbCgpO1xuICB9XG5cbiAgLyoqIEVudHJ5L2V4aXQgcGFpciBmb3Igb25lIGNoYXJ0IGV4ZWN1dGlvbi5cbiAgICogIFJldHVybnMgYHsgZW50cnksIGV4aXQgfWAg4oCUIGBleGl0YCBpcyBgdW5kZWZpbmVkYCBmb3IgaW4tcHJvZ3Jlc3MgLyBwYXVzZWRcbiAgICogIGNoYXJ0cyBvciBpZiBgcnVudGltZVN0YWdlSWRgIGlzIHVua25vd24uICovXG4gIGdldEJvdW5kYXJ5KHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmcpOiB7IGVudHJ5PzogSW5PdXRFbnRyeTsgZXhpdD86IEluT3V0RW50cnkgfSB7XG4gICAgY29uc3QgZW50cmllcyA9IHRoaXMuc3RvcmUuZ2V0QnlLZXkocnVudGltZVN0YWdlSWQpO1xuICAgIHJldHVybiB7XG4gICAgICBlbnRyeTogZW50cmllcy5maW5kKChlKSA9PiBlLnBoYXNlID09PSAnZW50cnknKSxcbiAgICAgIGV4aXQ6IGVudHJpZXMuZmluZCgoZSkgPT4gZS5waGFzZSA9PT0gJ2V4aXQnKSxcbiAgICB9O1xuICB9XG5cbiAgLyoqIEp1c3QgdGhlIGBlbnRyeWAtcGhhc2UgYm91bmRhcmllcyDigJQgdGhlIFwic3RlcCBsaXN0XCIgcHJvamVjdGlvbiBpblxuICAgKiAgZXhlY3V0aW9uIG9yZGVyLiBUaGlzIGlzIHRoZSBuYXR1cmFsIHRpbWVsaW5lIG9mIGNoYXJ0IGV4ZWN1dGlvbnNcbiAgICogIGZvciBzbGlkZXIgLyBzY3J1YmJpbmcgVUlzLiBUaGUgdG9wLWxldmVsIHJ1bidzIGVudHJ5IGlzIHRoZSBmaXJzdFxuICAgKiAgc3RlcCAoZGVwdGggMCkuICovXG4gIGdldFN0ZXBzKCk6IEluT3V0RW50cnlbXSB7XG4gICAgY29uc3Qgc3RlcHM6IEluT3V0RW50cnlbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgYiBvZiB0aGlzLnN0b3JlLmdldEFsbCgpKSB7XG4gICAgICBpZiAoYi5waGFzZSA9PT0gJ2VudHJ5Jykgc3RlcHMucHVzaChiKTtcbiAgICB9XG4gICAgcmV0dXJuIHN0ZXBzO1xuICB9XG5cbiAgLyoqIE8oMSkgbG9va3VwOiBhbGwgYm91bmRhcnkgZW50cmllcyAoYm90aCBwaGFzZXMpIGZvciBvbmUgcnVudGltZVN0YWdlSWQuICovXG4gIGdldEVudHJpZXNGb3JTdGVwKHJ1bnRpbWVTdGFnZUlkOiBzdHJpbmcpOiBJbk91dEVudHJ5W10ge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldEJ5S2V5KHJ1bnRpbWVTdGFnZUlkKTtcbiAgfVxuXG4gIC8qKiBQcmUtYnVpbHQgcGVyLXN0ZXAgcmFuZ2UgaW5kZXgg4oCUIE8oMSkgbG9va3VwcyBmb3IgdGltZS10cmF2ZWwgc2NydWJiaW5nLiAqL1xuICBnZXRFbnRyeVJhbmdlcygpOiBSZWFkb25seU1hcDxzdHJpbmcsIHsgcmVhZG9ubHkgZmlyc3RJZHg6IG51bWJlcjsgcmVhZG9ubHkgZW5kSWR4OiBudW1iZXIgfT4ge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldEVudHJ5UmFuZ2VzKCk7XG4gIH1cblxuICAvKiogUHJvZ3Jlc3NpdmUgcmV2ZWFsOiBib3VuZGFyaWVzIHdob3NlIHJ1bnRpbWVTdGFnZUlkIGlzIGluIHRoZSB2aXNpYmxlIHNldC4gKi9cbiAgZ2V0RW50cmllc1VwVG8odmlzaWJsZUlkczogUmVhZG9ubHlTZXQ8c3RyaW5nPik6IEluT3V0RW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0RW50cmllc1VwVG8odmlzaWJsZUlkcyk7XG4gIH1cblxuICAvKiogQ2xlYXIgYWxsIHN0b3JlZCBib3VuZGFyaWVzIOKAlCBjYWxsZWQgYnkgdGhlIGV4ZWN1dG9yIGJlZm9yZSBlYWNoIHJ1bigpLiAqL1xuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3JlLmNsZWFyKCk7XG4gIH1cblxuICAvKiogVGhlIHJvb3QgcnVuJ3MgZW50cnkvZXhpdCBwYWlyLCBpZiB0aGUgcnVuIGhhcyBzdGFydGVkLlxuICAgKiAgQ29udmVuaWVuY2UgZm9yIGNvbnN1bWVycyB0aGF0IHdhbnQgdG8gYnJhY2tldCB0aGUgdGltZWxpbmUgYnkgdGhlXG4gICAqICBvdXRlcm1vc3QgaW4vb3V0LiAqL1xuICBnZXRSb290Qm91bmRhcnkoKTogeyBlbnRyeT86IEluT3V0RW50cnk7IGV4aXQ/OiBJbk91dEVudHJ5IH0ge1xuICAgIHJldHVybiB0aGlzLmdldEJvdW5kYXJ5KFJPT1RfUlVOVElNRV9TVEFHRV9JRCk7XG4gIH1cblxuICAvKiogU25hcHNob3QgYnVuZGxlIGZvciBpbmNsdXNpb24gaW4gYGV4ZWN1dG9yLmdldFNuYXBzaG90KClgLiAqL1xuICB0b1NuYXBzaG90KCkge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnSW5PdXQnLFxuICAgICAgZGVzY3JpcHRpb246ICdDaGFydCBpbi9vdXQgc3RyZWFtIOKAlCBlbnRyeS9leGl0IHBhaXJzIGF0IGV2ZXJ5IGNoYXJ0IGJvdW5kYXJ5IChyb290ICsgc3ViZmxvd3MpJyxcbiAgICAgIHByZWZlcnJlZE9wZXJhdGlvbjogJ3RyYW5zbGF0ZScgYXMgY29uc3QsXG4gICAgICBkYXRhOiB0aGlzLmdldEJvdW5kYXJpZXMoKSxcbiAgICB9O1xuICB9XG59XG5cbi8vIOKUgOKUgCBJbnRlcm5hbCBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIEJ1aWxkIHRoZSBzeW50aGV0aWMgcm9vdCBlbnRyeS9leGl0LiBEZXB0aCBpcyBgMGAgYW5kIHRoZSBwYXRoIGlzXG4gKiBgW1JPT1RfU1VCRkxPV19JRF1gIHNvIGNvbnN1bWVycyBncm91cGluZyBieSBwYXRoIHNlZSB0aGUgcm9vdCBhcyBhXG4gKiByZWd1bGFyIHRvcC1sZXZlbCBjb250YWluZXIuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkUm9vdEVudHJ5KHBoYXNlOiBJbk91dFBoYXNlLCBwYXlsb2FkOiB1bmtub3duKTogSW5PdXRFbnRyeSB7XG4gIHJldHVybiB7XG4gICAgcnVudGltZVN0YWdlSWQ6IFJPT1RfUlVOVElNRV9TVEFHRV9JRCxcbiAgICBzdWJmbG93SWQ6IFJPT1RfU1VCRkxPV19JRCxcbiAgICBsb2NhbFN1YmZsb3dJZDogUk9PVF9TVUJGTE9XX0lELFxuICAgIHN1YmZsb3dOYW1lOiAnUnVuJyxcbiAgICBzdWJmbG93UGF0aDogW1JPT1RfU1VCRkxPV19JRF0sXG4gICAgZGVwdGg6IDAsXG4gICAgcGhhc2UsXG4gICAgcGF5bG9hZCxcbiAgICBpc1Jvb3Q6IHRydWUsXG4gIH07XG59XG5cbi8qKlxuICogQnVpbGQgYSBzdWJmbG93IGBJbk91dEVudHJ5YCBmcm9tIGEgYEZsb3dTdWJmbG93RXZlbnRgLlxuICpcbiAqIFJldHVybnMgYHVuZGVmaW5lZGAgd2hlbiB0aGUgZXZlbnQgbGFja3MgYSBgc3ViZmxvd0lkYCAoYW5vbnltb3VzIC9cbiAqIG1hbGZvcm1lZCBzdWJmbG93IGV2ZW50cyDigJQgc2FtZSBkZWZlbnNpdmUgcG9saWN5IGFzIGBUb3BvbG9neVJlY29yZGVyYCkuXG4gKlxuICogUGF0aCBkZXJpdmF0aW9uOiB0aGUgZW5naW5lIGVtaXRzIGBzdWJmbG93SWRgIGFscmVhZHkgcHJlZml4ZWQgd2l0aCB0aGVcbiAqIGZ1bGwgcGF0aCBvZiBwYXJlbnQgc3ViZmxvd3MgKGUuZy4gYCdzZi1vdXRlci9zZi1pbm5lcidgKS4gV2UgZGVjb21wb3NlXG4gKiB0aGF0IGludG8gc2VnbWVudHMgdG8gcG9wdWxhdGUgYHN1YmZsb3dQYXRoYCBhbmQgY29tcHV0ZSBgZGVwdGhgLlxuICpcbiAqIFN1YmZsb3dzIG5lc3QgVU5ERVIgdGhlIHN5bnRoZXRpYyByb290IGluIGBzdWJmbG93UGF0aGAgc28gdGhlIHRyZWUgaXNcbiAqIGNvbXBsZXRlOiBhIHRvcC1sZXZlbCBzdWJmbG93IGhhcyBwYXRoIGBbJ19fcm9vdF9fJywgJ3NmLXgnXWAgYW5kIGRlcHRoIDEuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkU3ViZmxvd0VudHJ5KGV2ZW50OiBGbG93U3ViZmxvd0V2ZW50LCBwaGFzZTogSW5PdXRQaGFzZSk6IEluT3V0RW50cnkgfCB1bmRlZmluZWQge1xuICBjb25zdCBzdWJmbG93SWQgPSBldmVudC5zdWJmbG93SWQ7XG4gIGlmICghc3ViZmxvd0lkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHJ1bnRpbWVTdGFnZUlkID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8ucnVudGltZVN0YWdlSWQgPz8gJyc7XG4gIGNvbnN0IHNlZ21lbnRzID0gc3ViZmxvd0lkLnNwbGl0KCcvJykuZmlsdGVyKChzKSA9PiBzLmxlbmd0aCA+IDApO1xuICBjb25zdCBzdWJmbG93UGF0aDogcmVhZG9ubHkgc3RyaW5nW10gPSBbUk9PVF9TVUJGTE9XX0lELCAuLi5zZWdtZW50c107XG4gIGNvbnN0IGRlcHRoID0gc3ViZmxvd1BhdGgubGVuZ3RoIC0gMTtcbiAgY29uc3QgbG9jYWxTdWJmbG93SWQgPSBzZWdtZW50c1tzZWdtZW50cy5sZW5ndGggLSAxXSA/PyBzdWJmbG93SWQ7XG4gIGNvbnN0IHBheWxvYWQgPSBwaGFzZSA9PT0gJ2VudHJ5JyA/IGV2ZW50Lm1hcHBlZElucHV0IDogZXZlbnQub3V0cHV0U3RhdGU7XG5cbiAgcmV0dXJuIHtcbiAgICBydW50aW1lU3RhZ2VJZCxcbiAgICBzdWJmbG93SWQsXG4gICAgbG9jYWxTdWJmbG93SWQsXG4gICAgc3ViZmxvd05hbWU6IGV2ZW50Lm5hbWUsXG4gICAgZGVzY3JpcHRpb246IGV2ZW50LmRlc2NyaXB0aW9uLFxuICAgIHN1YmZsb3dQYXRoLFxuICAgIGRlcHRoLFxuICAgIHBoYXNlLFxuICAgIHBheWxvYWQsXG4gICAgaXNSb290OiBmYWxzZSxcbiAgfTtcbn1cbiJdfQ==