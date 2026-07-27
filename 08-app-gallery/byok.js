// The BYOK generator — writes 08-app-gallery/out/byok/, a fully static page
// where a visitor chats on THEIR OWN Anthropic key with nothing of ours in the
// key path.
//
//   node 08-app-gallery/byok.js           → generate out/byok/
//   node 08-app-gallery/byok.js --serve   → generate, then serve it on :4176
//
// What it emits:
//   out/byok/index.html   the gallery home — cards → a desk. Static HTML, no
//                         script, no key input; every link relative.
//   out/byok/<app>.html   one desk per app (skin + React/atui shim + import map
//                         + boot), each carrying its own pack and nothing else
//   out/byok/app/         lib/ + apps/ + byok/ copied VERBATIM from this example
//   out/byok/vendor/      the installed agentfootprint / footprintjs / zod ESM
//                         dist trees, .js only — the published bytes, unmodified
//
// No bundler, no transform, no network: generation is a file copy. That is part
// of the honesty story — a visitor can diff out/byok/vendor against npm.
//
// The generator writes ZERO key material. The owner's .env key is never read
// here and can never appear in the output; the page's only key source is the
// visitor's own input field at runtime.
import { createServer } from 'node:http';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trip } from './apps/trip.js';
import { movies } from './apps/movies.js';
import { stocks } from './apps/stocks.js';
import { buildByokLanding, buildByokPage, packToPageData } from './lib/byok-page.js';
import { copyDevViews } from './lib/dev-views.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(here, '..');
const nodeModules = join(repoRoot, 'node_modules');
// Where a real build lands. `generate({ outDir })` can point elsewhere — a gate
// that only wants to READ the generated page (verify-ia) builds into a scratch
// directory so `out/` stays a pure build product and two runs can never race
// over the same bytes.
const DEFAULT_OUT_DIR = join(here, 'out', 'byok');
const PORT = 4176;

// The model every request from the page will carry — the same id the gallery's
// live mode sends, and what the page's badge names.
const MODEL = 'claude-haiku-4-5-20251001';

// The desks the bundle carries, one page each. Stocks is excluded on evidence,
// not taste: the SEC's servers refuse browser calls (CORS), so 1 of its 3
// sources could run client-side. It still gets a card on the home — disabled,
// saying why — rather than vanishing. See lib/byok-page.js's STOCK_NOTE.
const PACKS = [trip, movies];
const OFF_PACK = stocks;

// Whole ESM dist trees, .js only — .d.ts and .map are dead weight in a tab.
const VENDOR = [
  { pkg: 'agentfootprint', sub: 'dist/esm' },
  { pkg: 'footprintjs', sub: 'dist/esm' },
  { pkg: 'zod', sub: '' },
];

// ─── file helpers ───────────────────────────────────────────────────────────
function copyJsTree(from, to) {
  let files = 0;
  let bytes = 0;
  const walk = (src, dest) => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, entry.name);
      const d = join(dest, entry.name);
      if (entry.isDirectory()) walk(s, d);
      else if (entry.isFile() && extname(entry.name) === '.js') {
        cpSync(s, d);
        files += 1;
        bytes += statSync(s).size;
      }
    }
  };
  walk(from, to);
  return { files, bytes };
}

const copyFile = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); };

// ─── the import map, TRACED and verified (never hand-maintained) ────────────
// A missing entry is a load-time failure in the browser with no useful message,
// so the map is derived from the real static import graph and every entry is
// proven to point at a file that exists in the generated output. If anything
// fails to resolve, generation stops loudly.
const STATIC_FROM = /^[ \t]*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/gm;
const STATIC_BARE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;

/** Strip comments, then re-join import/export statements that wrap across lines. */
function normalizeModuleSource(code) {
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
  const lines = noComments.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    // A wrapped `export { a,\n b } from './x.js';` — keep pulling until the
    // statement carries its specifier or clearly ends.
    if (/^[ \t]*(?:import|export)\b/.test(line) && !/['"]/.test(line)) {
      while (i + 1 < lines.length && !/['"]/.test(line) && !/;\s*$/.test(line)) {
        i += 1;
        line += ` ${lines[i].trim()}`;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

function staticSpecifiers(code) {
  const src = normalizeModuleSource(code);
  const out = new Set();
  for (const m of src.matchAll(STATIC_FROM)) out.add(m[1]);
  for (const m of src.matchAll(STATIC_BARE)) out.add(m[1]);
  return [...out];
}

const isBare = (spec) => !spec.startsWith('.') && !spec.startsWith('/');

/** node: builtins the page satisfies with a stub, and the stub that does it. */
const NODE_STUBS = {
  'node:module': 'app/byok/stubs/node-module.js',
  'node:path': 'app/byok/stubs/node-path.js',
  'node:url': 'app/byok/stubs/node-url.js',
};

/**
 * Walk the static import graph from the copied app modules, collecting every
 * bare specifier that actually gets loaded. Returns { imports } for the map.
 */
function traceImportMap(appSeedFiles) {
  const imports = {};
  const seenFiles = new Set();
  const pending = [];
  const problems = [];

  const vendorUrlFor = (fileUrl) => {
    const abs = fileURLToPath(fileUrl);
    const rel = relative(nodeModules, abs);
    if (rel.startsWith('..')) {
      problems.push(`resolved outside node_modules: ${abs}`);
      return null;
    }
    return `./vendor/${rel.split(/[\\/]/).join('/')}`;
  };

  const addBare = (spec) => {
    if (imports[spec] !== undefined) return;
    if (spec.startsWith('node:')) {
      const stub = NODE_STUBS[spec];
      if (!stub) { problems.push(`no browser stub for node builtin '${spec}'`); return; }
      imports[spec] = `./${stub}`;
      return;
    }
    let resolved;
    try { resolved = import.meta.resolve(spec); } catch (err) {
      problems.push(`cannot resolve '${spec}': ${err && err.message}`);
      return;
    }
    const url = vendorUrlFor(resolved);
    if (!url) return;
    imports[spec] = url;
    pending.push(resolved);
  };

  const visit = (fileUrl) => {
    if (seenFiles.has(fileUrl)) return;
    seenFiles.add(fileUrl);
    const abs = fileURLToPath(fileUrl);
    if (!existsSync(abs)) { problems.push(`import target missing on disk: ${abs}`); return; }
    for (const spec of staticSpecifiers(readFileSync(abs, 'utf8'))) {
      if (isBare(spec)) addBare(spec);
      else pending.push(new URL(spec, fileUrl).href);
    }
  };

  // Seeds: the app modules the page imports directly (their bare specifiers are
  // the ones the browser will ask for first).
  for (const file of appSeedFiles) {
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (isBare(spec)) addBare(spec);
    }
  }
  while (pending.length) visit(pending.pop());

  if (problems.length) {
    throw new Error(`BYOK import map could not be built:\n  - ${problems.join('\n  - ')}`);
  }
  return { imports, moduleCount: seenFiles.size };
}

/** Every mapped target must exist in the generated output — checked, not hoped. */
function verifyImportMap(imports, outDir) {
  const missing = [];
  for (const [spec, target] of Object.entries(imports)) {
    const rel = target.replace(/^\.\//, '');
    if (!existsSync(join(outDir, rel))) missing.push(`${spec} → ${target}`);
  }
  if (missing.length) {
    throw new Error(`BYOK import map points at files that were not generated:\n  - ${missing.join('\n  - ')}`);
  }
}

// ─── generate ───────────────────────────────────────────────────────────────
export function generate({ quiet = false, outDir = DEFAULT_OUT_DIR } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. the app modules, copied VERBATIM (byte-shared with the server demo)
  const appFiles = [
    ['lib/chat-core.js', 'app/lib/chat-core.js'],
    ['lib/debug-view.js', 'app/lib/debug-view.js'],
    ['lib/mcp.js', 'app/lib/mcp.js'],
    ['apps/index.js', 'app/apps/index.js'],
    ['apps/stocks.js', 'app/apps/stocks.js'],
    ['apps/movies.js', 'app/apps/movies.js'],
    ['apps/trip.js', 'app/apps/trip.js'],
    ['apps/mock-turn.js', 'app/apps/mock-turn.js'],
    ['byok/browser-ctx.js', 'app/byok/browser-ctx.js'],
    ['byok/local-api.js', 'app/byok/local-api.js'],
    ['byok/tools.js', 'app/byok/tools.js'],
    ['byok/stubs/node-module.js', 'app/byok/stubs/node-module.js'],
    ['byok/stubs/node-path.js', 'app/byok/stubs/node-path.js'],
    ['byok/stubs/node-url.js', 'app/byok/stubs/node-url.js'],
  ];
  for (const [from, to] of appFiles) copyFile(join(here, from), join(outDir, to));
  log(`copied ${appFiles.length} app modules → out/byok/app/`);

  // 2. the vendored ESM dist trees — the published packages' own bytes
  let vendorFiles = 0;
  let vendorBytes = 0;
  for (const { pkg, sub } of VENDOR) {
    const src = sub ? join(nodeModules, pkg, sub) : join(nodeModules, pkg);
    if (!existsSync(src)) throw new Error(`vendor source missing: ${src} (run npm install)`);
    const dest = sub ? join(outDir, 'vendor', pkg, sub) : join(outDir, 'vendor', pkg);
    const r = copyJsTree(src, dest);
    vendorFiles += r.files;
    vendorBytes += r.bytes;
  }
  log(`copied ${vendorFiles} vendor .js files (${(vendorBytes / 1e6).toFixed(1)} MB) → out/byok/vendor/`);

  // 2b. the two developer views, as ONE built browser file (the only bundled
  // thing in this artifact — esbuild over the pinned devDependencies, from
  // dev-views/entry.js, reproducible with `node 08-app-gallery/dev-views/build.mjs`).
  // It is bundled rather than copied because both packages ship bare React
  // imports, and this page has React in a script registry, not an import map.
  // The desk pages do not load it: the debug modal asks for it, relatively,
  // the first time a visitor opens a view that needs it.
  const dev = copyDevViews(join(outDir, 'vendor'), { quiet: true });
  log(`built the dev views (${(dev.bytes.js / 1024).toFixed(0)} KB js + ${(dev.bytes.css / 1024).toFixed(0)} KB css) `
    + '→ out/byok/vendor/ — lazy-loaded, only by the debug modal');

  // 3. the traced import map, verified against what we just wrote
  const seeds = appFiles
    .filter(([from]) => from.startsWith('lib/') || from.startsWith('byok/'))
    .map(([from]) => join(here, from));
  const { imports, moduleCount } = traceImportMap(seeds);
  verifyImportMap(imports, outDir);
  const sorted = {};
  for (const spec of Object.keys(imports).sort()) sorted[spec] = imports[spec];
  const importMap = JSON.stringify({ imports: sorted }, null, 2);
  log(`import map: ${Object.keys(imports).length} specifiers over ${moduleCount} traced modules — all resolved`);

  // 4. the pages — one gallery home, one desk per pack
  //
  // A desk page's ONLY app import is `./app/apps/<id>.js`, named by the pack id
  // (buildByokPage's bootScript). That is an assumption about files we just
  // wrote, so it is checked against them here: a renamed pack file would
  // otherwise ship a page whose single import 404s in the browser, with the
  // import map — which never sees relative specifiers — still perfectly green.
  const pages = {};
  const writePage = (name, body) => {
    writeFileSync(join(outDir, name), body);
    pages[name] = body;
  };

  const html = buildByokLanding({
    apps: PACKS.map(packToPageData),
    stock: packToPageData(OFF_PACK),
    model: MODEL,
  });
  const file = join(outDir, 'index.html');
  writePage('index.html', html);

  for (const pack of PACKS) {
    const packModule = join(outDir, 'app', 'apps', `${pack.id}.js`);
    if (!existsSync(packModule)) {
      throw new Error(`the '${pack.id}' desk page imports ./app/apps/${pack.id}.js, which was not generated`);
    }
    writePage(`${pack.id}.html`, buildByokPage({
      importMap,
      app: packToPageData(pack),
      model: MODEL,
    }));
  }
  log(`generated ${Object.keys(pages).join(', ')} → ${outDir}`);
  // The page bodies ride the return so a reader (a gate) never has to go back to
  // disk. `html` stays the home, which is what `file` points at.
  return { outDir, file, imports, html, pages };
}

// ─── the deliberately empty static server ───────────────────────────────────
// GET-only, path-normalized under out/byok/, correct MIME, 404 for anything
// else. It has NO routes — its emptiness IS the story: there is nothing here
// that could receive, log or forward a key. Any other file server works the
// same, which is exactly the point.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function serve(port = PORT, outDir = DEFAULT_OUT_DIR) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found — this server has no routes');
      return;
    }
    const path = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = resolvePath(outDir, rel);
    if (!(file === outDir || file.startsWith(outDir + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  });
  server.listen(port, () => {
    console.log(`Bring your own key → http://localhost:${port}`);
    console.log('  This server only hands out files. Your key never reaches it —');
    console.log('  every Claude call goes straight from the browser to api.anthropic.com.');
  });
  return server;
}

// ─── entry ──────────────────────────────────────────────────────────────────
if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  generate();
  if (process.argv.slice(2).includes('--serve')) {
    serve();
  } else {
    console.log('The folder is fully static — serve it with anything:');
    console.log('  python3 -m http.server 4176 -d 08-app-gallery/out/byok');
    console.log('  npx serve 08-app-gallery/out/byok');
  }
}
