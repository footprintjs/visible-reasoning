import * as nodeModule from 'node:module';
let cachedRequire;
export function lazyRequire(specifier) {
    return (cachedRequire ??= nodeModule.createRequire(import.meta.url))(specifier);
}
