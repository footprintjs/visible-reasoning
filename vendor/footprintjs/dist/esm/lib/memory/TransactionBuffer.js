/**
 * TransactionBuffer — Per-stage STAGING buffer for state mutations
 *
 * What it IS: a staging buffer with read-your-writes and net-change commits.
 * - Changes are staged here during stage execution and flushed to
 *   SharedMemory in ONE batch per stage (`commit()`) — other stages and
 *   parallel siblings never observe a stage's half-finished writes.
 * - Read-after-write consistency within a stage — a stage sees its own
 *   staged writes immediately.
 * - `commit()` records the stage's NET change (see {@link commit}), plus an
 *   operation trace for deterministic replay.
 *
 * What it is NOT: a rollback mechanism. Despite the name, there is no
 * abort/rollback path — when a stage THROWS, the engine still commits
 * everything staged so far before re-throwing (commit-on-error in
 * `FlowchartTraverser`). That is deliberate: the audit trail must record
 * what the failing stage changed. Do not rely on "stage failed → its
 * writes vanished".
 */
import { nativeGet as _get, nativeSet as _set } from './pathOps.js';
import { deepEqual, deepSmartMerge, DELIM, normalisePath } from './utils.js';
export class TransactionBuffer {
    baseSnapshot;
    workingCopy;
    overwritePatch = {};
    updatePatch = {};
    opTrace = [];
    redactedPaths = new Set();
    /** Commit-value encoding policy (#13c-B). `'full'` = historical bytes. */
    commitValues;
    /** Per-write read-provenance source (#P1). When set (the
     *  `writeProvenance: 'reads-prefix'` dial), every staged op snapshots the
     *  keys tracked-read so far — the temporal-prefix attribution consumed by
     *  causal slicing. Undefined (default) = zero cost, byte-identical ops. */
    readKeysProvider;
    constructor(base, commitValues = 'full', readKeysProvider) {
        this.baseSnapshot = structuredClone(base);
        this.workingCopy = structuredClone(base);
        this.commitValues = commitValues;
        this.readKeysProvider = readKeysProvider;
    }
    /** Stamp the current read prefix onto a staged op — only when the
     *  provenance dial is on (provider present), so the default path allocates
     *  nothing and commit bundles stay byte-identical. */
    stampReadKeys(op) {
        if (this.readKeysProvider)
            op.readKeys = this.readKeysProvider();
        return op;
    }
    /** Hard overwrite at the specified path. */
    set(path, value, shouldRedact = false) {
        _set(this.workingCopy, path, value);
        _set(this.overwritePatch, path, structuredClone(value));
        if (shouldRedact) {
            this.redactedPaths.add(normalisePath(path));
        }
        this.opTrace.push(this.stampReadKeys({ path: normalisePath(path), verb: 'set' }));
    }
    /**
     * Explicit key deletion at the specified path (#13c-B; absorbs backlog B8).
     *
     * Stages EXACTLY the same buffer mutations as `set(path, undefined)` —
     * `workingCopy`/`overwritePatch` get an own `undefined` at the path (the
     * historical flattening, preserving read behavior and the dedup diff base
     * across modes) — but records the op verb as `'delete'`. At commit:
     * `'full'` mode maps it back to a `'set'` trace entry (byte-identical to
     * today); `'delta'` mode emits a real `'delete'` entry whose replay
     * REMOVES the key instead of leaving `key: undefined` behind.
     */
    delete(path, shouldRedact = false) {
        _set(this.workingCopy, path, undefined);
        _set(this.overwritePatch, path, undefined);
        if (shouldRedact) {
            this.redactedPaths.add(normalisePath(path));
        }
        this.opTrace.push(this.stampReadKeys({ path: normalisePath(path), verb: 'delete' }));
    }
    /** Deep union merge at the specified path. */
    merge(path, value, shouldRedact = false) {
        const existing = _get(this.workingCopy, path) ?? {};
        const merged = deepSmartMerge(existing, value);
        _set(this.workingCopy, path, merged);
        _set(this.updatePatch, path, deepSmartMerge(_get(this.updatePatch, path) ?? {}, value));
        if (shouldRedact) {
            this.redactedPaths.add(normalisePath(path));
        }
        this.opTrace.push(this.stampReadKeys({ path: normalisePath(path), verb: 'merge' }));
    }
    /** Read current value at path (includes uncommitted changes). */
    get(path, defaultValue) {
        return _get(this.workingCopy, path, defaultValue);
    }
    /**
     * Flush all staged mutations and return the commit bundle — recording the
     * stage's NET CHANGE, not its raw write log.
     *
     * ── WHY (the defect this fixes) ─────────────────────────────────────────
     * Previously every `set`/`merge` was recorded verbatim, so the commit bundle
     * was a log of *operations* rather than *changes*. Two operations produce no
     * net change yet were still committed as "mutations":
     *
     *   1. No-op write   — writing a key the value it already holds (e.g. an
     *                      agent context slot re-emitting identical content every
     *                      turn). base K=1, stage writes K=1.
     *   2. Write-revert  — changing then restoring a key within one stage.
     *                      base K=1, stage writes K=2 then K=1.
     *
     * Recording these as mutations (a) bloated causal slicing / backtracking with
     * spurious dependencies on intermediate values that never reach final state,
     * and (b) made downstream "what changed here?" consumers light up stages that
     * changed nothing — most visibly the lens highlight flagging every slot.
     *
     * ── HOW ─────────────────────────────────────────────────────────────────
     * At commit we hold BOTH `baseSnapshot` (state when the stage began) and
     * `workingCopy` (state after all its writes). For each path the stage touched
     * we keep it in the bundle ONLY if its final value differs from the base
     * value ({@link deepEqual}). No-op AND write-revert paths drop out, because
     * both compare equal to base. This is a single net-delta diff at commit time
     * — one deep compare per touched path, O(changed state), paid once per stage
     * (NOT per write). A naive per-write deep-equal skip would be more expensive
     * and would still miss write-revert (the intermediate write differs from the
     * value present at the moment of writing).
     *
     * ── TWO HONEST TIERS (by design — do not "unify" them) ──────────────────
     *   • commit (here)   = CHANGE-level — truthful net delta. Feeds the commit
     *                       log, causal chain, narrative, and the lens highlight.
     *   • `onWrite` event = OP-level — fires on EVERY write attempt regardless of
     *                       net change. Feeds metrics / behavioural observability
     *                       (a debugger wants to see "wrote 2, then reverted").
     * `onWrite` is unchanged by this method; only the COMMIT becomes change-only.
     *
     * ── EMPTY COMMITS ARE INTENTIONAL ───────────────────────────────────────
     * A stage that nets no change commits an EMPTY patch — NOT nothing.
     * {@link StageContext.commit} still records the bundle unconditionally, so
     * every executed stage remains a time-travel cursor stop (its `runtimeStageId`
     * marker is preserved); only its PATCH is empty. This is what keeps the
     * commit-indexed slider stable while making the highlight truthful.
     *
     * ── KNOWN LIMITATIONS / FUTURE ──────────────────────────────────────────
     *   • Explicit key DELETION under the default 'full' mode is still
     *     flattened to set-of-`undefined` (a removed key cannot be expressed
     *     in MemoryPatch alone). CLOSED under `commitValues: 'delta'` (#13c-B):
     *     {@link delete} stages a distinct op and the bundle carries a real
     *     `delete` trace verb whose replay removes the key.
     *   • Array-merge dedup in {@link deepSmartMerge} still uses reference equality
     *     (`new Set`), so deep-equal *objects* in a merged array are not deduped.
     *     Orthogonal to this change; tracked separately.
     *
     * Resets the buffer to empty state after commit.
     */
    commit() {
        const payload = this.commitValues === 'delta' ? this.toDeltaPayload() : this.toChangeOnlyPayload();
        this.overwritePatch = {};
        this.updatePatch = {};
        this.opTrace.length = 0;
        this.redactedPaths.clear();
        this.workingCopy = {};
        return payload;
    }
    /**
     * Rebuild overwrite / updates / trace keeping ONLY paths whose final value
     * differs from the base value — i.e. the stage's net change. See
     * {@link TransactionBuffer.commit} for the rationale.
     *
     * Paths are compared at the exact granularity they were written (each trace
     * entry's path), against `workingCopy` (final) vs `baseSnapshot` (start).
     * Surviving `set` paths copy their final value from `overwritePatch`;
     * surviving `merge` paths copy their accumulated delta from `updatePatch` —
     * preserving the set-vs-merge verb so replay ({@link applySmartMerge}) is
     * byte-for-byte identical to recording only the real changes.
     *
     * This is the DEFAULT (`commitValues: 'full'`) payload — byte-identical to
     * the historical behavior, including flattening staged `delete` ops into
     * `set`-of-`undefined` trace entries. The delta encoding lives in
     * {@link toDeltaPayload}.
     */
    toChangeOnlyPayload() {
        const overwrite = {};
        const updates = {};
        const trace = [];
        const survivingPaths = new Set();
        for (const op of this.opTrace) {
            const segments = op.path.split(DELIM);
            const before = _get(this.baseSnapshot, segments);
            const after = _get(this.workingCopy, segments);
            if (deepEqual(before, after))
                continue; // no-op or write-then-revert → no net change
            // Historical flattening: an explicit delete commits as set-of-undefined.
            // Per-write provenance (#P1) rides each surviving entry untouched.
            trace.push(op.verb === 'delete'
                ? { path: op.path, verb: 'set', ...(op.readKeys !== undefined && { readKeys: op.readKeys }) }
                : op);
            survivingPaths.add(op.path);
            if (op.verb === 'merge') {
                _set(updates, segments, structuredClone(_get(this.updatePatch, segments)));
            }
            else {
                _set(overwrite, segments, structuredClone(_get(this.overwritePatch, segments)));
            }
        }
        const redactedPaths = new Set([...this.redactedPaths].filter((path) => survivingPaths.has(path)));
        return { overwrite, updates, redactedPaths, trace };
    }
    /**
     * Delta-encoded payload (`commitValues: 'delta'`, #13c-B) — same net-change
     * filter as {@link toChangeOnlyPayload}, two encoding differences:
     *
     * 1. **One trace entry per surviving path** (the §2.5 dedup rule — `append`
     *    is NOT idempotent on replay, so duplicate entries would multiply
     *    tails). The verb is resolved from the path's op mix + base→final
     *    relationship; entries are ordered by each path's LAST touch,
     *    preserving last-writer-wins for nested/overlapping paths.
     * 2. **Verb resolution per path**:
     *    - last op `'delete'` AND final value gone → `delete` (the path stays
     *      enumerated in `overwrite` with `undefined` for key-set consumers);
     *    - ONLY `'merge'` ops → `merge` with the accumulated `updatePatch`
     *      delta (replaying the accumulated delta once ≡ the full mode's
     *      k sequential replays — `deepSmartMerge` is reference-idempotent
     *      within one replay pass);
     *    - otherwise (`set`/mixed): the committed value is computed by
     *      replaying the path's op sequence EXACTLY the way `applySmartMerge`
     *      replays the full-mode bundle ({@link replayPathVerbs}) — for
     *      pure-set paths that is simply the last set value; for mixed
     *      set+merge interleavings it reproduces the full mode's quirk of
     *      applying the ACCUMULATED merge delta at every merge position
     *      (which can differ from the buffer's read-your-writes view; parity
     *      with the `'full'` mode's committed state is the contract). If base
     *      and that value are arrays and base is a STRICT PREFIX → `append`
     *      storing only the tail; else `set` storing the full value.
     *
     * Losslessness never depends on detection succeeding — every fallback is
     * today's full-value `set`.
     */
    toDeltaPayload() {
        const overwrite = {};
        const updates = {};
        const trace = [];
        const survivingPaths = new Set();
        // Path → its op-verb sequence, ordered by LAST touch (delete +
        // re-insert moves a re-touched path to the end of the Map's insertion
        // order — preserving last-writer-wins for nested/overlapping paths).
        // Per-write provenance (#P1): the LAST op's readKeys is kept — read
        // prefixes only grow within a stage, so last == union across the path.
        const byPath = new Map();
        for (const op of this.opTrace) {
            const prev = byPath.get(op.path);
            if (prev) {
                prev.verbs.push(op.verb);
                if (op.readKeys !== undefined)
                    prev.readKeys = op.readKeys;
                byPath.delete(op.path);
                byPath.set(op.path, prev);
            }
            else {
                byPath.set(op.path, { verbs: [op.verb], ...(op.readKeys !== undefined && { readKeys: op.readKeys }) });
            }
        }
        for (const [path, { verbs, readKeys }] of byPath) {
            const prov = readKeys !== undefined ? { readKeys } : undefined;
            const segments = path.split(DELIM);
            const before = _get(this.baseSnapshot, segments);
            const after = _get(this.workingCopy, segments);
            if (deepEqual(before, after))
                continue; // no-op or write-then-revert → no net change (same filter as 'full')
            survivingPaths.add(path);
            const lastVerb = verbs[verbs.length - 1];
            if (lastVerb === 'delete' && after === undefined) {
                // Real deletion — replay removes the key. Keep the path enumerated
                // in `overwrite` (undefined) so Object.keys consumers see it.
                trace.push({ path, verb: 'delete', ...prov });
                _set(overwrite, segments, undefined);
            }
            else if (verbs.every((v) => v === 'merge')) {
                trace.push({ path, verb: 'merge', ...prov });
                _set(updates, segments, structuredClone(_get(this.updatePatch, segments)));
            }
            else {
                // Committed-equivalent value: replay this path's op sequence the way
                // applySmartMerge replays the FULL-mode bundle, so both modes commit
                // byte-identical state (see the method JSDoc).
                const committed = this.replayPathVerbs(before, segments, verbs);
                if (isStrictArrayPrefix(before, committed)) {
                    trace.push({ path, verb: 'append', ...prov });
                    _set(overwrite, segments, structuredClone(committed.slice(before.length)));
                }
                else {
                    trace.push({ path, verb: 'set', ...prov });
                    _set(overwrite, segments, structuredClone(committed));
                }
            }
        }
        const redactedPaths = new Set([...this.redactedPaths].filter((path) => survivingPaths.has(path)));
        return { overwrite, updates, redactedPaths, trace };
    }
    /**
     * Replay ONE path's op-verb sequence against its base value, exactly the
     * way `applySmartMerge` replays the corresponding full-mode bundle: every
     * `set`/`delete` position applies the LAST staged overwrite value (the
     * bag holds one value per path — last writer wins), every `merge`
     * position applies the ACCUMULATED `updatePatch` delta. This reproduces
     * the full mode's committed value for any interleaving — including the
     * mixed set+merge quirk where the accumulated delta re-applies pre-set
     * merge keys (full-mode replay semantics, kept for byte-parity across
     * modes; property-tested in delta-replay-equivalence).
     */
    replayPathVerbs(before, segments, verbs) {
        const setValue = _get(this.overwritePatch, segments);
        const mergeDelta = _get(this.updatePatch, segments);
        let value = before;
        for (const verb of verbs) {
            value = verb === 'merge' ? deepSmartMerge(value ?? {}, mergeDelta) : setValue;
        }
        return value;
    }
}
/**
 * Append-detection predicate (#13c-B §2.2): both values are arrays, the
 * final is strictly longer, and the base is a structural prefix of the
 * final. Element compares short-circuit on reference identity (`deepEqual`'s
 * `===` fast path) before walking structure, and bail at the first mismatch
 * — worst case one structural compare of the base array, strictly cheaper
 * than the full-value `structuredClone` the fallback pays.
 *
 * `before === undefined` (first write) fails `Array.isArray` → `set`, which
 * keeps the first write as the causal anchor for "who initialized this key".
 */
function isStrictArrayPrefix(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after))
        return false;
    if (after.length <= before.length)
        return false;
    for (let i = 0; i < before.length; i++) {
        if (!deepEqual(before[i], after[i]))
            return false;
    }
    return true;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiVHJhbnNhY3Rpb25CdWZmZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL21lbW9yeS9UcmFuc2FjdGlvbkJ1ZmZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBa0JHO0FBRUgsT0FBTyxFQUFFLFNBQVMsSUFBSSxJQUFJLEVBQUUsU0FBUyxJQUFJLElBQUksRUFBRSxNQUFNLGNBQWMsQ0FBQztBQUVwRSxPQUFPLEVBQUUsU0FBUyxFQUFFLGNBQWMsRUFBRSxLQUFLLEVBQUUsYUFBYSxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBUTdFLE1BQU0sT0FBTyxpQkFBaUI7SUFDWCxZQUFZLENBQU07SUFDM0IsV0FBVyxDQUFNO0lBRWpCLGNBQWMsR0FBZ0IsRUFBRSxDQUFDO0lBQ2pDLFdBQVcsR0FBZ0IsRUFBRSxDQUFDO0lBQzlCLE9BQU8sR0FBMEQsRUFBRSxDQUFDO0lBQ3BFLGFBQWEsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQzFDLDBFQUEwRTtJQUN6RCxZQUFZLENBQW1CO0lBRWhEOzs7K0VBRzJFO0lBQzFELGdCQUFnQixDQUFrQjtJQUVuRCxZQUFZLElBQVMsRUFBRSxlQUFpQyxNQUFNLEVBQUUsZ0JBQWlDO1FBQy9GLElBQUksQ0FBQyxZQUFZLEdBQUcsZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzFDLElBQUksQ0FBQyxXQUFXLEdBQUcsZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pDLElBQUksQ0FBQyxZQUFZLEdBQUcsWUFBWSxDQUFDO1FBQ2pDLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxnQkFBZ0IsQ0FBQztJQUMzQyxDQUFDO0lBRUQ7OzBEQUVzRDtJQUM5QyxhQUFhLENBQUMsRUFBdUQ7UUFDM0UsSUFBSSxJQUFJLENBQUMsZ0JBQWdCO1lBQUUsRUFBRSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztRQUNq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QUNyRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxRQUFRLENBQUMsQ0FBQztRQUNwRCxJQUFJLEtBQUssR0FBWSxNQUFNLENBQUM7UUFDNUIsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUN6QixLQUFLLEdBQUcsSUFBSSxLQUFLLE9BQU8sQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLEtBQUssSUFBSSxFQUFFLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUNoRixDQUFDO1FBQ0QsT0FBTyxLQUFLLENBQUM7SUFDZixDQUFDO0NBQ0Y7QUFFRDs7Ozs7Ozs7OztHQVVHO0FBQ0gsU0FBUyxtQkFBbUIsQ0FBQyxNQUFlLEVBQUUsS0FBYztJQUMxRCxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDbEUsSUFBSSxLQUFLLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQyxNQUFNO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDaEQsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztRQUN2QyxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFBRSxPQUFPLEtBQUssQ0FBQztJQUNwRCxDQUFDO0lBQ0QsT0FBTyxJQUFJLENBQUM7QUFDZCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUcmFuc2FjdGlvbkJ1ZmZlciDigJQgUGVyLXN0YWdlIFNUQUdJTkcgYnVmZmVyIGZvciBzdGF0ZSBtdXRhdGlvbnNcbiAqXG4gKiBXaGF0IGl0IElTOiBhIHN0YWdpbmcgYnVmZmVyIHdpdGggcmVhZC15b3VyLXdyaXRlcyBhbmQgbmV0LWNoYW5nZSBjb21taXRzLlxuICogLSBDaGFuZ2VzIGFyZSBzdGFnZWQgaGVyZSBkdXJpbmcgc3RhZ2UgZXhlY3V0aW9uIGFuZCBmbHVzaGVkIHRvXG4gKiAgIFNoYXJlZE1lbW9yeSBpbiBPTkUgYmF0Y2ggcGVyIHN0YWdlIChgY29tbWl0KClgKSDigJQgb3RoZXIgc3RhZ2VzIGFuZFxuICogICBwYXJhbGxlbCBzaWJsaW5ncyBuZXZlciBvYnNlcnZlIGEgc3RhZ2UncyBoYWxmLWZpbmlzaGVkIHdyaXRlcy5cbiAqIC0gUmVhZC1hZnRlci13cml0ZSBjb25zaXN0ZW5jeSB3aXRoaW4gYSBzdGFnZSDigJQgYSBzdGFnZSBzZWVzIGl0cyBvd25cbiAqICAgc3RhZ2VkIHdyaXRlcyBpbW1lZGlhdGVseS5cbiAqIC0gYGNvbW1pdCgpYCByZWNvcmRzIHRoZSBzdGFnZSdzIE5FVCBjaGFuZ2UgKHNlZSB7QGxpbmsgY29tbWl0fSksIHBsdXMgYW5cbiAqICAgb3BlcmF0aW9uIHRyYWNlIGZvciBkZXRlcm1pbmlzdGljIHJlcGxheS5cbiAqXG4gKiBXaGF0IGl0IGlzIE5PVDogYSByb2xsYmFjayBtZWNoYW5pc20uIERlc3BpdGUgdGhlIG5hbWUsIHRoZXJlIGlzIG5vXG4gKiBhYm9ydC9yb2xsYmFjayBwYXRoIOKAlCB3aGVuIGEgc3RhZ2UgVEhST1dTLCB0aGUgZW5naW5lIHN0aWxsIGNvbW1pdHNcbiAqIGV2ZXJ5dGhpbmcgc3RhZ2VkIHNvIGZhciBiZWZvcmUgcmUtdGhyb3dpbmcgKGNvbW1pdC1vbi1lcnJvciBpblxuICogYEZsb3djaGFydFRyYXZlcnNlcmApLiBUaGF0IGlzIGRlbGliZXJhdGU6IHRoZSBhdWRpdCB0cmFpbCBtdXN0IHJlY29yZFxuICogd2hhdCB0aGUgZmFpbGluZyBzdGFnZSBjaGFuZ2VkLiBEbyBub3QgcmVseSBvbiBcInN0YWdlIGZhaWxlZCDihpIgaXRzXG4gKiB3cml0ZXMgdmFuaXNoZWRcIi5cbiAqL1xuXG5pbXBvcnQgeyBuYXRpdmVHZXQgYXMgX2dldCwgbmF0aXZlU2V0IGFzIF9zZXQgfSBmcm9tICcuL3BhdGhPcHMuanMnO1xuaW1wb3J0IHR5cGUgeyBDb21taXRWYWx1ZXNNb2RlLCBNZW1vcnlQYXRjaCwgVHJhY2VFbnRyeSB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHsgZGVlcEVxdWFsLCBkZWVwU21hcnRNZXJnZSwgREVMSU0sIG5vcm1hbGlzZVBhdGggfSBmcm9tICcuL3V0aWxzLmpzJztcblxuLyoqIE9wLWxldmVsIHZlcmJzIHN0YWdlZCBpbnRvIGBvcFRyYWNlYC4gYCdkZWxldGUnYCBpcyBzdGFnZWQgZGlzdGluY3RseSBzb1xuICogIGRlbHRhLW1vZGUgY29tbWl0cyAoIzEzYy1CKSBjYW4gZW1pdCBhIHJlYWwgYGRlbGV0ZWAgdHJhY2UgZW50cnk7IHVuZGVyXG4gKiAgdGhlIGRlZmF1bHQgYCdmdWxsJ2AgbW9kZSBpdCBjb21taXRzIGFzIGAnc2V0J2AgKG9mIGB1bmRlZmluZWRgKSDigJRcbiAqICBieXRlLWlkZW50aWNhbCB0byB0aGUgaGlzdG9yaWNhbCBmbGF0dGVuaW5nLiAqL1xudHlwZSBPcFZlcmIgPSAnc2V0JyB8ICdtZXJnZScgfCAnZGVsZXRlJztcblxuZXhwb3J0IGNsYXNzIFRyYW5zYWN0aW9uQnVmZmVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBiYXNlU25hcHNob3Q6IGFueTtcbiAgcHJpdmF0ZSB3b3JraW5nQ29weTogYW55O1xuXG4gIHByaXZhdGUgb3ZlcndyaXRlUGF0Y2g6IE1lbW9yeVBhdGNoID0ge307XG4gIHByaXZhdGUgdXBkYXRlUGF0Y2g6IE1lbW9yeVBhdGNoID0ge307XG4gIHByaXZhdGUgb3BUcmFjZTogeyBwYXRoOiBzdHJpbmc7IHZlcmI6IE9wVmVyYjsgcmVhZEtleXM/OiBzdHJpbmdbXSB9W10gPSBbXTtcbiAgcHJpdmF0ZSByZWRhY3RlZFBhdGhzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIC8qKiBDb21taXQtdmFsdWUgZW5jb2RpbmcgcG9saWN5ICgjMTNjLUIpLiBgJ2Z1bGwnYCA9IGhpc3RvcmljYWwgYnl0ZXMuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgY29tbWl0VmFsdWVzOiBDb21taXRWYWx1ZXNNb2RlO1xuXG4gIC8qKiBQZXItd3JpdGUgcmVhZC1wcm92ZW5hbmNlIHNvdXJjZSAoI1AxKS4gV2hlbiBzZXQgKHRoZVxuICAgKiAgYHdyaXRlUHJvdmVuYW5jZTogJ3JlYWRzLXByZWZpeCdgIGRpYWwpLCBldmVyeSBzdGFnZWQgb3Agc25hcHNob3RzIHRoZVxuICAgKiAga2V5cyB0cmFja2VkLXJlYWQgc28gZmFyIOKAlCB0aGUgdGVtcG9yYWwtcHJlZml4IGF0dHJpYnV0aW9uIGNvbnN1bWVkIGJ5XG4gICAqICBjYXVzYWwgc2xpY2luZy4gVW5kZWZpbmVkIChkZWZhdWx0KSA9IHplcm8gY29zdCwgYnl0ZS1pZGVudGljYWwgb3BzLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHJlYWRLZXlzUHJvdmlkZXI/OiAoKSA9PiBzdHJpbmdbXTtcblxuICBjb25zdHJ1Y3RvcihiYXNlOiBhbnksIGNvbW1pdFZhbHVlczogQ29tbWl0VmFsdWVzTW9kZSA9ICdmdWxsJywgcmVhZEtleXNQcm92aWRlcj86ICgpID0+IHN0cmluZ1tdKSB7XG4gICAgdGhpcy5iYXNlU25hcHNob3QgPSBzdHJ1Y3R1cmVkQ2xvbmUoYmFzZSk7XG4gICAgdGhpcy53b3JraW5nQ29weSA9IHN0cnVjdHVyZWRDbG9uZShiYXNlKTtcbiAgICB0aGlzLmNvbW1pdFZhbHVlcyA9IGNvbW1pdFZhbHVlcztcbiAgICB0aGlzLnJlYWRLZXlzUHJvdmlkZXIgPSByZWFkS2V5c1Byb3ZpZGVyO1xuICB9XG5cbiAgLyoqIFN0YW1wIHRoZSBjdXJyZW50IHJlYWQgcHJlZml4IG9udG8gYSBzdGFnZWQgb3Ag4oCUIG9ubHkgd2hlbiB0aGVcbiAgICogIHByb3ZlbmFuY2UgZGlhbCBpcyBvbiAocHJvdmlkZXIgcHJlc2VudCksIHNvIHRoZSBkZWZhdWx0IHBhdGggYWxsb2NhdGVzXG4gICAqICBub3RoaW5nIGFuZCBjb21taXQgYnVuZGxlcyBzdGF5IGJ5dGUtaWRlbnRpY2FsLiAqL1xuICBwcml2YXRlIHN0YW1wUmVhZEtleXMob3A6IHsgcGF0aDogc3RyaW5nOyB2ZXJiOiBPcFZlcmI7IHJlYWRLZXlzPzogc3RyaW5nW10gfSk6IHR5cGVvZiBvcCB7XG4gICAgaWYgKHRoaXMucmVhZEtleXNQcm92aWRlcikgb3AucmVhZEtleXMgPSB0aGlzLnJlYWRLZXlzUHJvdmlkZXIoKTtcbiAgICByZXR1cm4gb3A7XG4gIH1cblxuICAvKiogSGFyZCBvdmVyd3JpdGUgYXQgdGhlIHNwZWNpZmllZCBwYXRoLiAqL1xuICBzZXQocGF0aDogKHN0cmluZyB8IG51bWJlcilbXSwgdmFsdWU6IGFueSwgc2hvdWxkUmVkYWN0ID0gZmFsc2UpOiB2b2lkIHtcbiAgICBfc2V0KHRoaXMud29ya2luZ0NvcHksIHBhdGgsIHZhbHVlKTtcbiAgICBfc2V0KHRoaXMub3ZlcndyaXRlUGF0Y2gsIHBhdGgsIHN0cnVjdHVyZWRDbG9uZSh2YWx1ZSkpO1xuICAgIGlmIChzaG91bGRSZWRhY3QpIHtcbiAgICAgIHRoaXMucmVkYWN0ZWRQYXRocy5hZGQobm9ybWFsaXNlUGF0aChwYXRoKSk7XG4gICAgfVxuICAgIHRoaXMub3BUcmFjZS5wdXNoKHRoaXMuc3RhbXBSZWFkS2V5cyh7IHBhdGg6IG5vcm1hbGlzZVBhdGgocGF0aCksIHZlcmI6ICdzZXQnIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCBrZXkgZGVsZXRpb24gYXQgdGhlIHNwZWNpZmllZCBwYXRoICgjMTNjLUI7IGFic29yYnMgYmFja2xvZyBCOCkuXG4gICAqXG4gICAqIFN0YWdlcyBFWEFDVExZIHRoZSBzYW1lIGJ1ZmZlciBtdXRhdGlvbnMgYXMgYHNldChwYXRoLCB1bmRlZmluZWQpYCDigJRcbiAgICogYHdvcmtpbmdDb3B5YC9gb3ZlcndyaXRlUGF0Y2hgIGdldCBhbiBvd24gYHVuZGVmaW5lZGAgYXQgdGhlIHBhdGggKHRoZVxuICAgKiBoaXN0b3JpY2FsIGZsYXR0ZW5pbmcsIHByZXNlcnZpbmcgcmVhZCBiZWhhdmlvciBhbmQgdGhlIGRlZHVwIGRpZmYgYmFzZVxuICAgKiBhY3Jvc3MgbW9kZXMpIOKAlCBidXQgcmVjb3JkcyB0aGUgb3AgdmVyYiBhcyBgJ2RlbGV0ZSdgLiBBdCBjb21taXQ6XG4gICAqIGAnZnVsbCdgIG1vZGUgbWFwcyBpdCBiYWNrIHRvIGEgYCdzZXQnYCB0cmFjZSBlbnRyeSAoYnl0ZS1pZGVudGljYWwgdG9cbiAgICogdG9kYXkpOyBgJ2RlbHRhJ2AgbW9kZSBlbWl0cyBhIHJlYWwgYCdkZWxldGUnYCBlbnRyeSB3aG9zZSByZXBsYXlcbiAgICogUkVNT1ZFUyB0aGUga2V5IGluc3RlYWQgb2YgbGVhdmluZyBga2V5OiB1bmRlZmluZWRgIGJlaGluZC5cbiAgICovXG4gIGRlbGV0ZShwYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdLCBzaG91bGRSZWRhY3QgPSBmYWxzZSk6IHZvaWQge1xuICAgIF9zZXQodGhpcy53b3JraW5nQ29weSwgcGF0aCwgdW5kZWZpbmVkKTtcbiAgICBfc2V0KHRoaXMub3ZlcndyaXRlUGF0Y2gsIHBhdGgsIHVuZGVmaW5lZCk7XG4gICAgaWYgKHNob3VsZFJlZGFjdCkge1xuICAgICAgdGhpcy5yZWRhY3RlZFBhdGhzLmFkZChub3JtYWxpc2VQYXRoKHBhdGgpKTtcbiAgICB9XG4gICAgdGhpcy5vcFRyYWNlLnB1c2godGhpcy5zdGFtcFJlYWRLZXlzKHsgcGF0aDogbm9ybWFsaXNlUGF0aChwYXRoKSwgdmVyYjogJ2RlbGV0ZScgfSkpO1xuICB9XG5cbiAgLyoqIERlZXAgdW5pb24gbWVyZ2UgYXQgdGhlIHNwZWNpZmllZCBwYXRoLiAqL1xuICBtZXJnZShwYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdLCB2YWx1ZTogYW55LCBzaG91bGRSZWRhY3QgPSBmYWxzZSk6IHZvaWQge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gX2dldCh0aGlzLndvcmtpbmdDb3B5LCBwYXRoKSA/PyB7fTtcbiAgICBjb25zdCBtZXJnZWQgPSBkZWVwU21hcnRNZXJnZShleGlzdGluZywgdmFsdWUpO1xuICAgIF9zZXQodGhpcy53b3JraW5nQ29weSwgcGF0aCwgbWVyZ2VkKTtcbiAgICBfc2V0KHRoaXMudXBkYXRlUGF0Y2gsIHBhdGgsIGRlZXBTbWFydE1lcmdlKF9nZXQodGhpcy51cGRhdGVQYXRjaCwgcGF0aCkgPz8ge30sIHZhbHVlKSk7XG4gICAgaWYgKHNob3VsZFJlZGFjdCkge1xuICAgICAgdGhpcy5yZWRhY3RlZFBhdGhzLmFkZChub3JtYWxpc2VQYXRoKHBhdGgpKTtcbiAgICB9XG4gICAgdGhpcy5vcFRyYWNlLnB1c2godGhpcy5zdGFtcFJlYWRLZXlzKHsgcGF0aDogbm9ybWFsaXNlUGF0aChwYXRoKSwgdmVyYjogJ21lcmdlJyB9KSk7XG4gIH1cblxuICAvKiogUmVhZCBjdXJyZW50IHZhbHVlIGF0IHBhdGggKGluY2x1ZGVzIHVuY29tbWl0dGVkIGNoYW5nZXMpLiAqL1xuICBnZXQocGF0aDogKHN0cmluZyB8IG51bWJlcilbXSwgZGVmYXVsdFZhbHVlPzogYW55KSB7XG4gICAgcmV0dXJuIF9nZXQodGhpcy53b3JraW5nQ29weSwgcGF0aCwgZGVmYXVsdFZhbHVlKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGbHVzaCBhbGwgc3RhZ2VkIG11dGF0aW9ucyBhbmQgcmV0dXJuIHRoZSBjb21taXQgYnVuZGxlIOKAlCByZWNvcmRpbmcgdGhlXG4gICAqIHN0YWdlJ3MgTkVUIENIQU5HRSwgbm90IGl0cyByYXcgd3JpdGUgbG9nLlxuICAgKlxuICAgKiDilIDilIAgV0hZICh0aGUgZGVmZWN0IHRoaXMgZml4ZXMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgKiBQcmV2aW91c2x5IGV2ZXJ5IGBzZXRgL2BtZXJnZWAgd2FzIHJlY29yZGVkIHZlcmJhdGltLCBzbyB0aGUgY29tbWl0IGJ1bmRsZVxuICAgKiB3YXMgYSBsb2cgb2YgKm9wZXJhdGlvbnMqIHJhdGhlciB0aGFuICpjaGFuZ2VzKi4gVHdvIG9wZXJhdGlvbnMgcHJvZHVjZSBub1xuICAgKiBuZXQgY2hhbmdlIHlldCB3ZXJlIHN0aWxsIGNvbW1pdHRlZCBhcyBcIm11dGF0aW9uc1wiOlxuICAgKlxuICAgKiAgIDEuIE5vLW9wIHdyaXRlICAg4oCUIHdyaXRpbmcgYSBrZXkgdGhlIHZhbHVlIGl0IGFscmVhZHkgaG9sZHMgKGUuZy4gYW5cbiAgICogICAgICAgICAgICAgICAgICAgICAgYWdlbnQgY29udGV4dCBzbG90IHJlLWVtaXR0aW5nIGlkZW50aWNhbCBjb250ZW50IGV2ZXJ5XG4gICAqICAgICAgICAgICAgICAgICAgICAgIHR1cm4pLiBiYXNlIEs9MSwgc3RhZ2Ugd3JpdGVzIEs9MS5cbiAgICogICAyLiBXcml0ZS1yZXZlcnQgIOKAlCBjaGFuZ2luZyB0aGVuIHJlc3RvcmluZyBhIGtleSB3aXRoaW4gb25lIHN0YWdlLlxuICAgKiAgICAgICAgICAgICAgICAgICAgICBiYXNlIEs9MSwgc3RhZ2Ugd3JpdGVzIEs9MiB0aGVuIEs9MS5cbiAgICpcbiAgICogUmVjb3JkaW5nIHRoZXNlIGFzIG11dGF0aW9ucyAoYSkgYmxvYXRlZCBjYXVzYWwgc2xpY2luZyAvIGJhY2t0cmFja2luZyB3aXRoXG4gICAqIHNwdXJpb3VzIGRlcGVuZGVuY2llcyBvbiBpbnRlcm1lZGlhdGUgdmFsdWVzIHRoYXQgbmV2ZXIgcmVhY2ggZmluYWwgc3RhdGUsXG4gICAqIGFuZCAoYikgbWFkZSBkb3duc3RyZWFtIFwid2hhdCBjaGFuZ2VkIGhlcmU/XCIgY29uc3VtZXJzIGxpZ2h0IHVwIHN0YWdlcyB0aGF0XG4gICAqIGNoYW5nZWQgbm90aGluZyDigJQgbW9zdCB2aXNpYmx5IHRoZSBsZW5zIGhpZ2hsaWdodCBmbGFnZ2luZyBldmVyeSBzbG90LlxuICAgKlxuICAgKiDilIDilIAgSE9XIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgKiBBdCBjb21taXQgd2UgaG9sZCBCT1RIIGBiYXNlU25hcHNob3RgIChzdGF0ZSB3aGVuIHRoZSBzdGFnZSBiZWdhbikgYW5kXG4gICAqIGB3b3JraW5nQ29weWAgKHN0YXRlIGFmdGVyIGFsbCBpdHMgd3JpdGVzKS4gRm9yIGVhY2ggcGF0aCB0aGUgc3RhZ2UgdG91Y2hlZFxuICAgKiB3ZSBrZWVwIGl0IGluIHRoZSBidW5kbGUgT05MWSBpZiBpdHMgZmluYWwgdmFsdWUgZGlmZmVycyBmcm9tIHRoZSBiYXNlXG4gICAqIHZhbHVlICh7QGxpbmsgZGVlcEVxdWFsfSkuIE5vLW9wIEFORCB3cml0ZS1yZXZlcnQgcGF0aHMgZHJvcCBvdXQsIGJlY2F1c2VcbiAgICogYm90aCBjb21wYXJlIGVxdWFsIHRvIGJhc2UuIFRoaXMgaXMgYSBzaW5nbGUgbmV0LWRlbHRhIGRpZmYgYXQgY29tbWl0IHRpbWVcbiAgICog4oCUIG9uZSBkZWVwIGNvbXBhcmUgcGVyIHRvdWNoZWQgcGF0aCwgTyhjaGFuZ2VkIHN0YXRlKSwgcGFpZCBvbmNlIHBlciBzdGFnZVxuICAgKiAoTk9UIHBlciB3cml0ZSkuIEEgbmFpdmUgcGVyLXdyaXRlIGRlZXAtZXF1YWwgc2tpcCB3b3VsZCBiZSBtb3JlIGV4cGVuc2l2ZVxuICAgKiBhbmQgd291bGQgc3RpbGwgbWlzcyB3cml0ZS1yZXZlcnQgKHRoZSBpbnRlcm1lZGlhdGUgd3JpdGUgZGlmZmVycyBmcm9tIHRoZVxuICAgKiB2YWx1ZSBwcmVzZW50IGF0IHRoZSBtb21lbnQgb2Ygd3JpdGluZykuXG4gICAqXG4gICAqIOKUgOKUgCBUV08gSE9ORVNUIFRJRVJTIChieSBkZXNpZ24g4oCUIGRvIG5vdCBcInVuaWZ5XCIgdGhlbSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAqICAg4oCiIGNvbW1pdCAoaGVyZSkgICA9IENIQU5HRS1sZXZlbCDigJQgdHJ1dGhmdWwgbmV0IGRlbHRhLiBGZWVkcyB0aGUgY29tbWl0XG4gICAqICAgICAgICAgICAgICAgICAgICAgICBsb2csIGNhdXNhbCBjaGFpbiwgbmFycmF0aXZlLCBhbmQgdGhlIGxlbnMgaGlnaGxpZ2h0LlxuICAgKiAgIOKAoiBgb25Xcml0ZWAgZXZlbnQgPSBPUC1sZXZlbCDigJQgZmlyZXMgb24gRVZFUlkgd3JpdGUgYXR0ZW1wdCByZWdhcmRsZXNzIG9mXG4gICAqICAgICAgICAgICAgICAgICAgICAgICBuZXQgY2hhbmdlLiBGZWVkcyBtZXRyaWNzIC8gYmVoYXZpb3VyYWwgb2JzZXJ2YWJpbGl0eVxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgKGEgZGVidWdnZXIgd2FudHMgdG8gc2VlIFwid3JvdGUgMiwgdGhlbiByZXZlcnRlZFwiKS5cbiAgICogYG9uV3JpdGVgIGlzIHVuY2hhbmdlZCBieSB0aGlzIG1ldGhvZDsgb25seSB0aGUgQ09NTUlUIGJlY29tZXMgY2hhbmdlLW9ubHkuXG4gICAqXG4gICAqIOKUgOKUgCBFTVBUWSBDT01NSVRTIEFSRSBJTlRFTlRJT05BTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICogQSBzdGFnZSB0aGF0IG5ldHMgbm8gY2hhbmdlIGNvbW1pdHMgYW4gRU1QVFkgcGF0Y2gg4oCUIE5PVCBub3RoaW5nLlxuICAgKiB7QGxpbmsgU3RhZ2VDb250ZXh0LmNvbW1pdH0gc3RpbGwgcmVjb3JkcyB0aGUgYnVuZGxlIHVuY29uZGl0aW9uYWxseSwgc29cbiAgICogZXZlcnkgZXhlY3V0ZWQgc3RhZ2UgcmVtYWlucyBhIHRpbWUtdHJhdmVsIGN1cnNvciBzdG9wIChpdHMgYHJ1bnRpbWVTdGFnZUlkYFxuICAgKiBtYXJrZXIgaXMgcHJlc2VydmVkKTsgb25seSBpdHMgUEFUQ0ggaXMgZW1wdHkuIFRoaXMgaXMgd2hhdCBrZWVwcyB0aGVcbiAgICogY29tbWl0LWluZGV4ZWQgc2xpZGVyIHN0YWJsZSB3aGlsZSBtYWtpbmcgdGhlIGhpZ2hsaWdodCB0cnV0aGZ1bC5cbiAgICpcbiAgICog4pSA4pSAIEtOT1dOIExJTUlUQVRJT05TIC8gRlVUVVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgKiAgIOKAoiBFeHBsaWNpdCBrZXkgREVMRVRJT04gdW5kZXIgdGhlIGRlZmF1bHQgJ2Z1bGwnIG1vZGUgaXMgc3RpbGxcbiAgICogICAgIGZsYXR0ZW5lZCB0byBzZXQtb2YtYHVuZGVmaW5lZGAgKGEgcmVtb3ZlZCBrZXkgY2Fubm90IGJlIGV4cHJlc3NlZFxuICAgKiAgICAgaW4gTWVtb3J5UGF0Y2ggYWxvbmUpLiBDTE9TRUQgdW5kZXIgYGNvbW1pdFZhbHVlczogJ2RlbHRhJ2AgKCMxM2MtQik6XG4gICAqICAgICB7QGxpbmsgZGVsZXRlfSBzdGFnZXMgYSBkaXN0aW5jdCBvcCBhbmQgdGhlIGJ1bmRsZSBjYXJyaWVzIGEgcmVhbFxuICAgKiAgICAgYGRlbGV0ZWAgdHJhY2UgdmVyYiB3aG9zZSByZXBsYXkgcmVtb3ZlcyB0aGUga2V5LlxuICAgKiAgIOKAoiBBcnJheS1tZXJnZSBkZWR1cCBpbiB7QGxpbmsgZGVlcFNtYXJ0TWVyZ2V9IHN0aWxsIHVzZXMgcmVmZXJlbmNlIGVxdWFsaXR5XG4gICAqICAgICAoYG5ldyBTZXRgKSwgc28gZGVlcC1lcXVhbCAqb2JqZWN0cyogaW4gYSBtZXJnZWQgYXJyYXkgYXJlIG5vdCBkZWR1cGVkLlxuICAgKiAgICAgT3J0aG9nb25hbCB0byB0aGlzIGNoYW5nZTsgdHJhY2tlZCBzZXBhcmF0ZWx5LlxuICAgKlxuICAgKiBSZXNldHMgdGhlIGJ1ZmZlciB0byBlbXB0eSBzdGF0ZSBhZnRlciBjb21taXQuXG4gICAqL1xuICBjb21taXQoKToge1xuICAgIG92ZXJ3cml0ZTogTWVtb3J5UGF0Y2g7XG4gICAgdXBkYXRlczogTWVtb3J5UGF0Y2g7XG4gICAgcmVkYWN0ZWRQYXRoczogU2V0PHN0cmluZz47XG4gICAgdHJhY2U6IFRyYWNlRW50cnlbXTtcbiAgfSB7XG4gICAgY29uc3QgcGF5bG9hZCA9IHRoaXMuY29tbWl0VmFsdWVzID09PSAnZGVsdGEnID8gdGhpcy50b0RlbHRhUGF5bG9hZCgpIDogdGhpcy50b0NoYW5nZU9ubHlQYXlsb2FkKCk7XG5cbiAgICB0aGlzLm92ZXJ3cml0ZVBhdGNoID0ge307XG4gICAgdGhpcy51cGRhdGVQYXRjaCA9IHt9O1xuICAgIHRoaXMub3BUcmFjZS5sZW5ndGggPSAwO1xuICAgIHRoaXMucmVkYWN0ZWRQYXRocy5jbGVhcigpO1xuICAgIHRoaXMud29ya2luZ0NvcHkgPSB7fTtcblxuICAgIHJldHVybiBwYXlsb2FkO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlYnVpbGQgb3ZlcndyaXRlIC8gdXBkYXRlcyAvIHRyYWNlIGtlZXBpbmcgT05MWSBwYXRocyB3aG9zZSBmaW5hbCB2YWx1ZVxuICAgKiBkaWZmZXJzIGZyb20gdGhlIGJhc2UgdmFsdWUg4oCUIGkuZS4gdGhlIHN0YWdlJ3MgbmV0IGNoYW5nZS4gU2VlXG4gICAqIHtAbGluayBUcmFuc2FjdGlvbkJ1ZmZlci5jb21taXR9IGZvciB0aGUgcmF0aW9uYWxlLlxuICAgKlxuICAgKiBQYXRocyBhcmUgY29tcGFyZWQgYXQgdGhlIGV4YWN0IGdyYW51bGFyaXR5IHRoZXkgd2VyZSB3cml0dGVuIChlYWNoIHRyYWNlXG4gICAqIGVudHJ5J3MgcGF0aCksIGFnYWluc3QgYHdvcmtpbmdDb3B5YCAoZmluYWwpIHZzIGBiYXNlU25hcHNob3RgIChzdGFydCkuXG4gICAqIFN1cnZpdmluZyBgc2V0YCBwYXRocyBjb3B5IHRoZWlyIGZpbmFsIHZhbHVlIGZyb20gYG92ZXJ3cml0ZVBhdGNoYDtcbiAgICogc3Vydml2aW5nIGBtZXJnZWAgcGF0aHMgY29weSB0aGVpciBhY2N1bXVsYXRlZCBkZWx0YSBmcm9tIGB1cGRhdGVQYXRjaGAg4oCUXG4gICAqIHByZXNlcnZpbmcgdGhlIHNldC12cy1tZXJnZSB2ZXJiIHNvIHJlcGxheSAoe0BsaW5rIGFwcGx5U21hcnRNZXJnZX0pIGlzXG4gICAqIGJ5dGUtZm9yLWJ5dGUgaWRlbnRpY2FsIHRvIHJlY29yZGluZyBvbmx5IHRoZSByZWFsIGNoYW5nZXMuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIERFRkFVTFQgKGBjb21taXRWYWx1ZXM6ICdmdWxsJ2ApIHBheWxvYWQg4oCUIGJ5dGUtaWRlbnRpY2FsIHRvXG4gICAqIHRoZSBoaXN0b3JpY2FsIGJlaGF2aW9yLCBpbmNsdWRpbmcgZmxhdHRlbmluZyBzdGFnZWQgYGRlbGV0ZWAgb3BzIGludG9cbiAgICogYHNldGAtb2YtYHVuZGVmaW5lZGAgdHJhY2UgZW50cmllcy4gVGhlIGRlbHRhIGVuY29kaW5nIGxpdmVzIGluXG4gICAqIHtAbGluayB0b0RlbHRhUGF5bG9hZH0uXG4gICAqL1xuICBwcml2YXRlIHRvQ2hhbmdlT25seVBheWxvYWQoKToge1xuICAgIG92ZXJ3cml0ZTogTWVtb3J5UGF0Y2g7XG4gICAgdXBkYXRlczogTWVtb3J5UGF0Y2g7XG4gICAgcmVkYWN0ZWRQYXRoczogU2V0PHN0cmluZz47XG4gICAgdHJhY2U6IFRyYWNlRW50cnlbXTtcbiAgfSB7XG4gICAgY29uc3Qgb3ZlcndyaXRlOiBNZW1vcnlQYXRjaCA9IHt9O1xuICAgIGNvbnN0IHVwZGF0ZXM6IE1lbW9yeVBhdGNoID0ge307XG4gICAgY29uc3QgdHJhY2U6IFRyYWNlRW50cnlbXSA9IFtdO1xuICAgIGNvbnN0IHN1cnZpdmluZ1BhdGhzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgICBmb3IgKGNvbnN0IG9wIG9mIHRoaXMub3BUcmFjZSkge1xuICAgICAgY29uc3Qgc2VnbWVudHMgPSBvcC5wYXRoLnNwbGl0KERFTElNKTtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IF9nZXQodGhpcy5iYXNlU25hcHNob3QsIHNlZ21lbnRzKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gX2dldCh0aGlzLndvcmtpbmdDb3B5LCBzZWdtZW50cyk7XG4gICAgICBpZiAoZGVlcEVxdWFsKGJlZm9yZSwgYWZ0ZXIpKSBjb250aW51ZTsgLy8gbm8tb3Agb3Igd3JpdGUtdGhlbi1yZXZlcnQg4oaSIG5vIG5ldCBjaGFuZ2VcblxuICAgICAgLy8gSGlzdG9yaWNhbCBmbGF0dGVuaW5nOiBhbiBleHBsaWNpdCBkZWxldGUgY29tbWl0cyBhcyBzZXQtb2YtdW5kZWZpbmVkLlxuICAgICAgLy8gUGVyLXdyaXRlIHByb3ZlbmFuY2UgKCNQMSkgcmlkZXMgZWFjaCBzdXJ2aXZpbmcgZW50cnkgdW50b3VjaGVkLlxuICAgICAgdHJhY2UucHVzaChcbiAgICAgICAgb3AudmVyYiA9PT0gJ2RlbGV0ZSdcbiAgICAgICAgICA/IHsgcGF0aDogb3AucGF0aCwgdmVyYjogJ3NldCcgYXMgY29uc3QsIC4uLihvcC5yZWFkS2V5cyAhPT0gdW5kZWZpbmVkICYmIHsgcmVhZEtleXM6IG9wLnJlYWRLZXlzIH0pIH1cbiAgICAgICAgICA6IG9wLFxuICAgICAgKTtcbiAgICAgIHN1cnZpdmluZ1BhdGhzLmFkZChvcC5wYXRoKTtcbiAgICAgIGlmIChvcC52ZXJiID09PSAnbWVyZ2UnKSB7XG4gICAgICAgIF9zZXQodXBkYXRlcywgc2VnbWVudHMsIHN0cnVjdHVyZWRDbG9uZShfZ2V0KHRoaXMudXBkYXRlUGF0Y2gsIHNlZ21lbnRzKSkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgX3NldChvdmVyd3JpdGUsIHNlZ21lbnRzLCBzdHJ1Y3R1cmVkQ2xvbmUoX2dldCh0aGlzLm92ZXJ3cml0ZVBhdGNoLCBzZWdtZW50cykpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCByZWRhY3RlZFBhdGhzID0gbmV3IFNldChbLi4udGhpcy5yZWRhY3RlZFBhdGhzXS5maWx0ZXIoKHBhdGgpID0+IHN1cnZpdmluZ1BhdGhzLmhhcyhwYXRoKSkpO1xuICAgIHJldHVybiB7IG92ZXJ3cml0ZSwgdXBkYXRlcywgcmVkYWN0ZWRQYXRocywgdHJhY2UgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZWx0YS1lbmNvZGVkIHBheWxvYWQgKGBjb21taXRWYWx1ZXM6ICdkZWx0YSdgLCAjMTNjLUIpIOKAlCBzYW1lIG5ldC1jaGFuZ2VcbiAgICogZmlsdGVyIGFzIHtAbGluayB0b0NoYW5nZU9ubHlQYXlsb2FkfSwgdHdvIGVuY29kaW5nIGRpZmZlcmVuY2VzOlxuICAgKlxuICAgKiAxLiAqKk9uZSB0cmFjZSBlbnRyeSBwZXIgc3Vydml2aW5nIHBhdGgqKiAodGhlIMKnMi41IGRlZHVwIHJ1bGUg4oCUIGBhcHBlbmRgXG4gICAqICAgIGlzIE5PVCBpZGVtcG90ZW50IG9uIHJlcGxheSwgc28gZHVwbGljYXRlIGVudHJpZXMgd291bGQgbXVsdGlwbHlcbiAgICogICAgdGFpbHMpLiBUaGUgdmVyYiBpcyByZXNvbHZlZCBmcm9tIHRoZSBwYXRoJ3Mgb3AgbWl4ICsgYmFzZeKGkmZpbmFsXG4gICAqICAgIHJlbGF0aW9uc2hpcDsgZW50cmllcyBhcmUgb3JkZXJlZCBieSBlYWNoIHBhdGgncyBMQVNUIHRvdWNoLFxuICAgKiAgICBwcmVzZXJ2aW5nIGxhc3Qtd3JpdGVyLXdpbnMgZm9yIG5lc3RlZC9vdmVybGFwcGluZyBwYXRocy5cbiAgICogMi4gKipWZXJiIHJlc29sdXRpb24gcGVyIHBhdGgqKjpcbiAgICogICAgLSBsYXN0IG9wIGAnZGVsZXRlJ2AgQU5EIGZpbmFsIHZhbHVlIGdvbmUg4oaSIGBkZWxldGVgICh0aGUgcGF0aCBzdGF5c1xuICAgKiAgICAgIGVudW1lcmF0ZWQgaW4gYG92ZXJ3cml0ZWAgd2l0aCBgdW5kZWZpbmVkYCBmb3Iga2V5LXNldCBjb25zdW1lcnMpO1xuICAgKiAgICAtIE9OTFkgYCdtZXJnZSdgIG9wcyDihpIgYG1lcmdlYCB3aXRoIHRoZSBhY2N1bXVsYXRlZCBgdXBkYXRlUGF0Y2hgXG4gICAqICAgICAgZGVsdGEgKHJlcGxheWluZyB0aGUgYWNjdW11bGF0ZWQgZGVsdGEgb25jZSDiiaEgdGhlIGZ1bGwgbW9kZSdzXG4gICAqICAgICAgayBzZXF1ZW50aWFsIHJlcGxheXMg4oCUIGBkZWVwU21hcnRNZXJnZWAgaXMgcmVmZXJlbmNlLWlkZW1wb3RlbnRcbiAgICogICAgICB3aXRoaW4gb25lIHJlcGxheSBwYXNzKTtcbiAgICogICAgLSBvdGhlcndpc2UgKGBzZXRgL21peGVkKTogdGhlIGNvbW1pdHRlZCB2YWx1ZSBpcyBjb21wdXRlZCBieVxuICAgKiAgICAgIHJlcGxheWluZyB0aGUgcGF0aCdzIG9wIHNlcXVlbmNlIEVYQUNUTFkgdGhlIHdheSBgYXBwbHlTbWFydE1lcmdlYFxuICAgKiAgICAgIHJlcGxheXMgdGhlIGZ1bGwtbW9kZSBidW5kbGUgKHtAbGluayByZXBsYXlQYXRoVmVyYnN9KSDigJQgZm9yXG4gICAqICAgICAgcHVyZS1zZXQgcGF0aHMgdGhhdCBpcyBzaW1wbHkgdGhlIGxhc3Qgc2V0IHZhbHVlOyBmb3IgbWl4ZWRcbiAgICogICAgICBzZXQrbWVyZ2UgaW50ZXJsZWF2aW5ncyBpdCByZXByb2R1Y2VzIHRoZSBmdWxsIG1vZGUncyBxdWlyayBvZlxuICAgKiAgICAgIGFwcGx5aW5nIHRoZSBBQ0NVTVVMQVRFRCBtZXJnZSBkZWx0YSBhdCBldmVyeSBtZXJnZSBwb3NpdGlvblxuICAgKiAgICAgICh3aGljaCBjYW4gZGlmZmVyIGZyb20gdGhlIGJ1ZmZlcidzIHJlYWQteW91ci13cml0ZXMgdmlldzsgcGFyaXR5XG4gICAqICAgICAgd2l0aCB0aGUgYCdmdWxsJ2AgbW9kZSdzIGNvbW1pdHRlZCBzdGF0ZSBpcyB0aGUgY29udHJhY3QpLiBJZiBiYXNlXG4gICAqICAgICAgYW5kIHRoYXQgdmFsdWUgYXJlIGFycmF5cyBhbmQgYmFzZSBpcyBhIFNUUklDVCBQUkVGSVgg4oaSIGBhcHBlbmRgXG4gICAqICAgICAgc3RvcmluZyBvbmx5IHRoZSB0YWlsOyBlbHNlIGBzZXRgIHN0b3JpbmcgdGhlIGZ1bGwgdmFsdWUuXG4gICAqXG4gICAqIExvc3NsZXNzbmVzcyBuZXZlciBkZXBlbmRzIG9uIGRldGVjdGlvbiBzdWNjZWVkaW5nIOKAlCBldmVyeSBmYWxsYmFjayBpc1xuICAgKiB0b2RheSdzIGZ1bGwtdmFsdWUgYHNldGAuXG4gICAqL1xuICBwcml2YXRlIHRvRGVsdGFQYXlsb2FkKCk6IHtcbiAgICBvdmVyd3JpdGU6IE1lbW9yeVBhdGNoO1xuICAgIHVwZGF0ZXM6IE1lbW9yeVBhdGNoO1xuICAgIHJlZGFjdGVkUGF0aHM6IFNldDxzdHJpbmc+O1xuICAgIHRyYWNlOiBUcmFjZUVudHJ5W107XG4gIH0ge1xuICAgIGNvbnN0IG92ZXJ3cml0ZTogTWVtb3J5UGF0Y2ggPSB7fTtcbiAgICBjb25zdCB1cGRhdGVzOiBNZW1vcnlQYXRjaCA9IHt9O1xuICAgIGNvbnN0IHRyYWNlOiBUcmFjZUVudHJ5W10gPSBbXTtcbiAgICBjb25zdCBzdXJ2aXZpbmdQYXRocyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgLy8gUGF0aCDihpIgaXRzIG9wLXZlcmIgc2VxdWVuY2UsIG9yZGVyZWQgYnkgTEFTVCB0b3VjaCAoZGVsZXRlICtcbiAgICAvLyByZS1pbnNlcnQgbW92ZXMgYSByZS10b3VjaGVkIHBhdGggdG8gdGhlIGVuZCBvZiB0aGUgTWFwJ3MgaW5zZXJ0aW9uXG4gICAgLy8gb3JkZXIg4oCUIHByZXNlcnZpbmcgbGFzdC13cml0ZXItd2lucyBmb3IgbmVzdGVkL292ZXJsYXBwaW5nIHBhdGhzKS5cbiAgICAvLyBQZXItd3JpdGUgcHJvdmVuYW5jZSAoI1AxKTogdGhlIExBU1Qgb3AncyByZWFkS2V5cyBpcyBrZXB0IOKAlCByZWFkXG4gICAgLy8gcHJlZml4ZXMgb25seSBncm93IHdpdGhpbiBhIHN0YWdlLCBzbyBsYXN0ID09IHVuaW9uIGFjcm9zcyB0aGUgcGF0aC5cbiAgICBjb25zdCBieVBhdGggPSBuZXcgTWFwPHN0cmluZywgeyB2ZXJiczogT3BWZXJiW107IHJlYWRLZXlzPzogc3RyaW5nW10gfT4oKTtcbiAgICBmb3IgKGNvbnN0IG9wIG9mIHRoaXMub3BUcmFjZSkge1xuICAgICAgY29uc3QgcHJldiA9IGJ5UGF0aC5nZXQob3AucGF0aCk7XG4gICAgICBpZiAocHJldikge1xuICAgICAgICBwcmV2LnZlcmJzLnB1c2gob3AudmVyYik7XG4gICAgICAgIGlmIChvcC5yZWFkS2V5cyAhPT0gdW5kZWZpbmVkKSBwcmV2LnJlYWRLZXlzID0gb3AucmVhZEtleXM7XG4gICAgICAgIGJ5UGF0aC5kZWxldGUob3AucGF0aCk7XG4gICAgICAgIGJ5UGF0aC5zZXQob3AucGF0aCwgcHJldik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBieVBhdGguc2V0KG9wLnBhdGgsIHsgdmVyYnM6IFtvcC52ZXJiXSwgLi4uKG9wLnJlYWRLZXlzICE9PSB1bmRlZmluZWQgJiYgeyByZWFkS2V5czogb3AucmVhZEtleXMgfSkgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBbcGF0aCwgeyB2ZXJicywgcmVhZEtleXMgfV0gb2YgYnlQYXRoKSB7XG4gICAgICBjb25zdCBwcm92ID0gcmVhZEtleXMgIT09IHVuZGVmaW5lZCA/IHsgcmVhZEtleXMgfSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHNlZ21lbnRzID0gcGF0aC5zcGxpdChERUxJTSk7XG4gICAgICBjb25zdCBiZWZvcmUgPSBfZ2V0KHRoaXMuYmFzZVNuYXBzaG90LCBzZWdtZW50cyk7XG4gICAgICBjb25zdCBhZnRlciA9IF9nZXQodGhpcy53b3JraW5nQ29weSwgc2VnbWVudHMpO1xuICAgICAgaWYgKGRlZXBFcXVhbChiZWZvcmUsIGFmdGVyKSkgY29udGludWU7IC8vIG5vLW9wIG9yIHdyaXRlLXRoZW4tcmV2ZXJ0IOKGkiBubyBuZXQgY2hhbmdlIChzYW1lIGZpbHRlciBhcyAnZnVsbCcpXG5cbiAgICAgIHN1cnZpdmluZ1BhdGhzLmFkZChwYXRoKTtcbiAgICAgIGNvbnN0IGxhc3RWZXJiID0gdmVyYnNbdmVyYnMubGVuZ3RoIC0gMV07XG4gICAgICBpZiAobGFzdFZlcmIgPT09ICdkZWxldGUnICYmIGFmdGVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgLy8gUmVhbCBkZWxldGlvbiDigJQgcmVwbGF5IHJlbW92ZXMgdGhlIGtleS4gS2VlcCB0aGUgcGF0aCBlbnVtZXJhdGVkXG4gICAgICAgIC8vIGluIGBvdmVyd3JpdGVgICh1bmRlZmluZWQpIHNvIE9iamVjdC5rZXlzIGNvbnN1bWVycyBzZWUgaXQuXG4gICAgICAgIHRyYWNlLnB1c2goeyBwYXRoLCB2ZXJiOiAnZGVsZXRlJywgLi4ucHJvdiB9KTtcbiAgICAgICAgX3NldChvdmVyd3JpdGUsIHNlZ21lbnRzLCB1bmRlZmluZWQpO1xuICAgICAgfSBlbHNlIGlmICh2ZXJicy5ldmVyeSgodikgPT4gdiA9PT0gJ21lcmdlJykpIHtcbiAgICAgICAgdHJhY2UucHVzaCh7IHBhdGgsIHZlcmI6ICdtZXJnZScsIC4uLnByb3YgfSk7XG4gICAgICAgIF9zZXQodXBkYXRlcywgc2VnbWVudHMsIHN0cnVjdHVyZWRDbG9uZShfZ2V0KHRoaXMudXBkYXRlUGF0Y2gsIHNlZ21lbnRzKSkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gQ29tbWl0dGVkLWVxdWl2YWxlbnQgdmFsdWU6IHJlcGxheSB0aGlzIHBhdGgncyBvcCBzZXF1ZW5jZSB0aGUgd2F5XG4gICAgICAgIC8vIGFwcGx5U21hcnRNZXJnZSByZXBsYXlzIHRoZSBGVUxMLW1vZGUgYnVuZGxlLCBzbyBib3RoIG1vZGVzIGNvbW1pdFxuICAgICAgICAvLyBieXRlLWlkZW50aWNhbCBzdGF0ZSAoc2VlIHRoZSBtZXRob2QgSlNEb2MpLlxuICAgICAgICBjb25zdCBjb21taXR0ZWQgPSB0aGlzLnJlcGxheVBhdGhWZXJicyhiZWZvcmUsIHNlZ21lbnRzLCB2ZXJicyk7XG4gICAgICAgIGlmIChpc1N0cmljdEFycmF5UHJlZml4KGJlZm9yZSwgY29tbWl0dGVkKSkge1xuICAgICAgICAgIHRyYWNlLnB1c2goeyBwYXRoLCB2ZXJiOiAnYXBwZW5kJywgLi4ucHJvdiB9KTtcbiAgICAgICAgICBfc2V0KG92ZXJ3cml0ZSwgc2VnbWVudHMsIHN0cnVjdHVyZWRDbG9uZSgoY29tbWl0dGVkIGFzIHVua25vd25bXSkuc2xpY2UoKGJlZm9yZSBhcyB1bmtub3duW10pLmxlbmd0aCkpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0cmFjZS5wdXNoKHsgcGF0aCwgdmVyYjogJ3NldCcsIC4uLnByb3YgfSk7XG4gICAgICAgICAgX3NldChvdmVyd3JpdGUsIHNlZ21lbnRzLCBzdHJ1Y3R1cmVkQ2xvbmUoY29tbWl0dGVkKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCByZWRhY3RlZFBhdGhzID0gbmV3IFNldChbLi4udGhpcy5yZWRhY3RlZFBhdGhzXS5maWx0ZXIoKHBhdGgpID0+IHN1cnZpdmluZ1BhdGhzLmhhcyhwYXRoKSkpO1xuICAgIHJldHVybiB7IG92ZXJ3cml0ZSwgdXBkYXRlcywgcmVkYWN0ZWRQYXRocywgdHJhY2UgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXBsYXkgT05FIHBhdGgncyBvcC12ZXJiIHNlcXVlbmNlIGFnYWluc3QgaXRzIGJhc2UgdmFsdWUsIGV4YWN0bHkgdGhlXG4gICAqIHdheSBgYXBwbHlTbWFydE1lcmdlYCByZXBsYXlzIHRoZSBjb3JyZXNwb25kaW5nIGZ1bGwtbW9kZSBidW5kbGU6IGV2ZXJ5XG4gICAqIGBzZXRgL2BkZWxldGVgIHBvc2l0aW9uIGFwcGxpZXMgdGhlIExBU1Qgc3RhZ2VkIG92ZXJ3cml0ZSB2YWx1ZSAodGhlXG4gICAqIGJhZyBob2xkcyBvbmUgdmFsdWUgcGVyIHBhdGgg4oCUIGxhc3Qgd3JpdGVyIHdpbnMpLCBldmVyeSBgbWVyZ2VgXG4gICAqIHBvc2l0aW9uIGFwcGxpZXMgdGhlIEFDQ1VNVUxBVEVEIGB1cGRhdGVQYXRjaGAgZGVsdGEuIFRoaXMgcmVwcm9kdWNlc1xuICAgKiB0aGUgZnVsbCBtb2RlJ3MgY29tbWl0dGVkIHZhbHVlIGZvciBhbnkgaW50ZXJsZWF2aW5nIOKAlCBpbmNsdWRpbmcgdGhlXG4gICAqIG1peGVkIHNldCttZXJnZSBxdWlyayB3aGVyZSB0aGUgYWNjdW11bGF0ZWQgZGVsdGEgcmUtYXBwbGllcyBwcmUtc2V0XG4gICAqIG1lcmdlIGtleXMgKGZ1bGwtbW9kZSByZXBsYXkgc2VtYW50aWNzLCBrZXB0IGZvciBieXRlLXBhcml0eSBhY3Jvc3NcbiAgICogbW9kZXM7IHByb3BlcnR5LXRlc3RlZCBpbiBkZWx0YS1yZXBsYXktZXF1aXZhbGVuY2UpLlxuICAgKi9cbiAgcHJpdmF0ZSByZXBsYXlQYXRoVmVyYnMoYmVmb3JlOiB1bmtub3duLCBzZWdtZW50czogc3RyaW5nW10sIHZlcmJzOiBPcFZlcmJbXSk6IHVua25vd24ge1xuICAgIGNvbnN0IHNldFZhbHVlID0gX2dldCh0aGlzLm92ZXJ3cml0ZVBhdGNoLCBzZWdtZW50cyk7XG4gICAgY29uc3QgbWVyZ2VEZWx0YSA9IF9nZXQodGhpcy51cGRhdGVQYXRjaCwgc2VnbWVudHMpO1xuICAgIGxldCB2YWx1ZTogdW5rbm93biA9IGJlZm9yZTtcbiAgICBmb3IgKGNvbnN0IHZlcmIgb2YgdmVyYnMpIHtcbiAgICAgIHZhbHVlID0gdmVyYiA9PT0gJ21lcmdlJyA/IGRlZXBTbWFydE1lcmdlKHZhbHVlID8/IHt9LCBtZXJnZURlbHRhKSA6IHNldFZhbHVlO1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn1cblxuLyoqXG4gKiBBcHBlbmQtZGV0ZWN0aW9uIHByZWRpY2F0ZSAoIzEzYy1CIMKnMi4yKTogYm90aCB2YWx1ZXMgYXJlIGFycmF5cywgdGhlXG4gKiBmaW5hbCBpcyBzdHJpY3RseSBsb25nZXIsIGFuZCB0aGUgYmFzZSBpcyBhIHN0cnVjdHVyYWwgcHJlZml4IG9mIHRoZVxuICogZmluYWwuIEVsZW1lbnQgY29tcGFyZXMgc2hvcnQtY2lyY3VpdCBvbiByZWZlcmVuY2UgaWRlbnRpdHkgKGBkZWVwRXF1YWxgJ3NcbiAqIGA9PT1gIGZhc3QgcGF0aCkgYmVmb3JlIHdhbGtpbmcgc3RydWN0dXJlLCBhbmQgYmFpbCBhdCB0aGUgZmlyc3QgbWlzbWF0Y2hcbiAqIOKAlCB3b3JzdCBjYXNlIG9uZSBzdHJ1Y3R1cmFsIGNvbXBhcmUgb2YgdGhlIGJhc2UgYXJyYXksIHN0cmljdGx5IGNoZWFwZXJcbiAqIHRoYW4gdGhlIGZ1bGwtdmFsdWUgYHN0cnVjdHVyZWRDbG9uZWAgdGhlIGZhbGxiYWNrIHBheXMuXG4gKlxuICogYGJlZm9yZSA9PT0gdW5kZWZpbmVkYCAoZmlyc3Qgd3JpdGUpIGZhaWxzIGBBcnJheS5pc0FycmF5YCDihpIgYHNldGAsIHdoaWNoXG4gKiBrZWVwcyB0aGUgZmlyc3Qgd3JpdGUgYXMgdGhlIGNhdXNhbCBhbmNob3IgZm9yIFwid2hvIGluaXRpYWxpemVkIHRoaXMga2V5XCIuXG4gKi9cbmZ1bmN0aW9uIGlzU3RyaWN0QXJyYXlQcmVmaXgoYmVmb3JlOiB1bmtub3duLCBhZnRlcjogdW5rbm93bik6IGJlZm9yZSBpcyB1bmtub3duW10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoYmVmb3JlKSB8fCAhQXJyYXkuaXNBcnJheShhZnRlcikpIHJldHVybiBmYWxzZTtcbiAgaWYgKGFmdGVyLmxlbmd0aCA8PSBiZWZvcmUubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYmVmb3JlLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKCFkZWVwRXF1YWwoYmVmb3JlW2ldLCBhZnRlcltpXSkpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cbiJdfQ==