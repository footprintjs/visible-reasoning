/**
 * Built-in credential kinds — small strategies implementing the {@link Credential}
 * protocol. Each is a factory returning `{ kind, ...rawFields, toHeaders() }`.
 *
 * The framework + tools only ever call `cred.toHeaders()` (generic — no `kind`
 * switching); the raw fields are there for the rare non-HTTP case. A custom kind
 * is any object implementing `Credential` — no library change needed.
 */
/** Cross-env base64 (browser `btoa` / Node `Buffer`). */
function base64(s) {
    if (typeof btoa === 'function')
        return btoa(s);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B = globalThis.Buffer;
    if (B)
        return B.from(s, 'utf8').toString('base64');
    throw new Error('basic(): no base64 encoder available in this runtime.');
}
/**
 * Redefine secret-bearing fields as NON-ENUMERABLE — defence in depth: if a
 * consumer accidentally serializes a credential (returns `ctx.credential` from
 * a tool, logs it, embeds it in a result object), `JSON.stringify` emits only
 * the non-secret fields (e.g. `{"kind":"bearer"}`), never the raw secret. The
 * fields still READ normally (`cred.token` works); `toHeaders()` is the
 * intended applicator either way. (`structuredClone` rejects the credential
 * outright — `toHeaders` is a function — so it can't enter tracked scope.)
 */
function hideSecrets(cred, fields) {
    for (const f of fields) {
        Object.defineProperty(cred, f, {
            value: cred[f],
            enumerable: false,
            writable: false,
            configurable: false,
        });
    }
    return cred;
}
/** OAuth / bearer token → `Authorization: Bearer <token>`. */
export function bearer(token) {
    return hideSecrets({ kind: 'bearer', token, toHeaders: () => ({ authorization: `Bearer ${token}` }) }, ['token']);
}
/** API key → a single header (default `x-api-key`). */
export function apiKey(key, headerName = 'x-api-key') {
    return hideSecrets({ kind: 'apiKey', key, headerName, toHeaders: () => ({ [headerName]: key }) }, ['key']);
}
/** HTTP Basic auth → `Authorization: Basic base64(user:pass)`. */
export function basic(username, password) {
    const encoded = base64(`${username}:${password}`);
    return hideSecrets({
        kind: 'basic',
        username,
        password,
        toHeaders: () => ({ authorization: `Basic ${encoded}` }),
    }, ['password']);
}
/** The universal escape: arbitrary auth headers. Any scheme reduces to this, so
 *  a provider with no matching typed kind can always return `headers(...)`. */
export function headers(map) {
    const copy = { ...map };
    // The header map IS the secret here — hide it like the other kinds' raw fields.
    return hideSecrets({ kind: 'headers', headers: copy, toHeaders: () => ({ ...copy }) }, [
        'headers',
    ]);
}
//# sourceMappingURL=kinds.js.map