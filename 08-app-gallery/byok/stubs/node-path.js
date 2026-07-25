// Browser stub for `node:path`, wired through the page's import map.
//
// lib/mcp.js — copied onto the BYOK page verbatim for its decorator, its metrics
// counter and provenanceFromToolLog — computes `dirname(fileURLToPath(import.meta.url))`
// at module top so the SERVER build can spawn mcp-server.js. On the page that
// value is never used (buildLiveClient is never called), but the import must
// resolve. These are plain string operations: no filesystem, no platform.
export function dirname(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

export function join(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function basename(p) {
  const s = String(p).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

export default { dirname, join, basename, extname };
