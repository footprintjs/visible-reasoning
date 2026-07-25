// Browser stub for `node:url`, wired through the page's import map.
//
// The only caller on this page is lib/mcp.js's module-top
// `dirname(fileURLToPath(import.meta.url))`. In a tab `import.meta.url` is an
// http(s) URL, not a file: URL, and the result is never used (the value only
// matters when spawning mcp-server.js, which the page never does). Stripping a
// `file://` prefix when there is one, and otherwise handing the string back
// unchanged, is exactly enough — and stays honest by not pretending to be a
// filesystem path resolver.
export function fileURLToPath(url) {
  const s = String(url);
  return s.startsWith('file://') ? decodeURIComponent(s.slice('file://'.length)) : s;
}

export function pathToFileURL(p) {
  const s = String(p);
  return new URL(s.startsWith('file://') ? s : `file://${s}`);
}

export default { fileURLToPath, pathToFileURL };
