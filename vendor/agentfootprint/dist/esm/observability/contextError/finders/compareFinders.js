/**
 * Run each finder on `input`; a finder that throws (e.g. missing a dep it needs)
 * becomes a row with `result: null` and `error` set, so one finder cannot abort
 * the comparison.
 */
export async function compareFinders(finders, input) {
    const rows = [];
    for (const f of finders) {
        try {
            rows.push({ finder: f.name, result: await f.find(input) });
        }
        catch (e) {
            rows.push({
                finder: f.name,
                result: null,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }
    return rows;
}
//# sourceMappingURL=compareFinders.js.map