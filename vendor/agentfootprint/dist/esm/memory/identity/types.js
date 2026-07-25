/**
 * Encode a MemoryIdentity as a deterministic storage namespace. Used by
 * storage adapters that need a single string key (Redis, localStorage,
 * filesystem paths). Format is stable across library versions — adapters
 * can safely use it for long-lived keys.
 *
 * Empty `tenant` / `principal` collapse to `_` so the format has a constant
 * shape (easy to parse, easy to list by prefix).
 */
export function identityNamespace(identity) {
    const tenant = identity.tenant || '_';
    const principal = identity.principal || '_';
    return `${tenant}/${principal}/${identity.conversationId}`;
}
//# sourceMappingURL=types.js.map