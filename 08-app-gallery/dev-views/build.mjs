// Build vr-dev-views — ONE browser file carrying the ecosystem's two real
// developer views (footprint-explainable-ui's ExplainableShell, agentfootprint-
// lens's Lens), for the debug modal to load lazily.
//
//   node 08-app-gallery/dev-views/build.mjs [--out <dir>] [--quiet]
//
// Output (default 08-app-gallery/out/vendor/, a build product like every other
// out/ file):
//   vr-dev-views.iife.js    the views, minified, one global `VRDevViews`
//   vr-dev-views.iife.css   @xyflow/react's stylesheet, every rule .react-flow-
//                           scoped — the only CSS either package needs
//
// THE REACT SEAM. Both page shells already inline React 19 as CJS modules in a
// page-global registry (`__register` / `__require`, lib/page.js). A bundle that
// carried its OWN React would be a second copy of the renderer in the same
// document: invalid-hook-call on the first render, two reconcilers, two event
// systems. So the four bare specifiers that would pull one in are mapped onto
// the page's registry instead — the views run on the page's React instance,
// which is why they can be rendered as ordinary children of the desk's tree.
// `react/jsx-runtime` is deliberately NOT mapped: it bundles from npm and its
// own `require('react')` resolves back through this plugin, so the elements it
// creates carry the page React's internals.
//
// WHAT IS NOT IN HERE. No key, no network client, no telemetry: these are view
// components over data the page already holds. verify-dev-views.mjs asserts
// that from the built bytes rather than from this comment.
import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const OUT_JS = 'vr-dev-views.iife.js';
export const OUT_CSS = 'vr-dev-views.iife.css';
export const DEFAULT_OUT_DIR = join(here, '..', 'out', 'vendor');

// The page's registry holds exactly these four.
const SHIMMED = ['react', 'react-dom', 'react-dom/client', 'scheduler'];

// node: builtins reached by agentfootprint's lazy-require helper. These are the
// SAME three the BYOK import map already stubs (08-app-gallery/byok/stubs/), and
// with the same semantics: a call throws, loading never does.
const NODE_STUBS = {
  'node:module':
    'export function createRequire(){return (s)=>{throw new Error("[browser] node-only dependency requested: "+s)}}\n'
    + 'export default {createRequire};',
  'node:path':
    'export function dirname(p){const s=String(p).replace(/\\/+$/,"");const i=s.lastIndexOf("/");return i<0?".":i===0?"/":s.slice(0,i)}\n'
    + 'export function join(...a){return a.filter(Boolean).join("/").replace(/\\/{2,}/g,"/")}\n'
    + 'export function basename(p){const s=String(p).replace(/\\/+$/,"");return s.slice(s.lastIndexOf("/")+1)}\n'
    + 'export function extname(p){const b=basename(p);const i=b.lastIndexOf(".");return i>0?b.slice(i):""}\n'
    + 'export default {dirname,join,basename,extname};',
  'node:url':
    'export function fileURLToPath(u){const s=String(u);return s.startsWith("file://")?decodeURIComponent(s.slice(7)):s}\n'
    + 'export function pathToFileURL(p){const s=String(p);return new URL(s.startsWith("file://")?s:"file://"+s)}\n'
    + 'export default {fileURLToPath,pathToFileURL};',
};

const reactShim = {
  name: 'page-react',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|react-dom\/client|scheduler)$/ }, (args) => (
      SHIMMED.includes(args.path) ? { path: args.path, namespace: 'page-react' } : null
    ));
    b.onLoad({ filter: /.*/, namespace: 'page-react' }, (args) => ({
      contents:
        "if (typeof __require !== 'function') throw new Error("
        + "'vr-dev-views: this file needs the page\\'s React registry (__require) — load it after the page\\'s React scripts');\n"
        + `module.exports = __require(${JSON.stringify(args.path)});`,
      loader: 'js',
    }));
  },
};

const nodeStub = {
  name: 'node-stub',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => (
      NODE_STUBS[args.path] ? { path: args.path, namespace: 'node-stub' } : null
    ));
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({
      contents: NODE_STUBS[args.path], loader: 'js',
    }));
  },
};

export async function buildDevViewsBundle({ outDir = DEFAULT_OUT_DIR, quiet = false } = {}) {
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, OUT_JS);
  await build({
    entryPoints: [join(here, 'entry.js')],
    outfile,
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'VRDevViews',
    // Both view packages read process.env.NODE_ENV through React's convention;
    // without this the bundle would carry the development branches (and, in a
    // browser, reference a `process` that does not exist).
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [reactShim, nodeStub],
    logLevel: quiet ? 'error' : 'warning',
  });
  const js = readFileSync(outfile);
  const css = readFileSync(join(outDir, OUT_CSS));
  if (!quiet) {
    console.log(`built ${OUT_JS} (${(js.length / 1024).toFixed(0)} KB) `
      + `+ ${OUT_CSS} (${(css.length / 1024).toFixed(0)} KB) → ${outDir}`);
  }
  return { outDir, js: outfile, css: join(outDir, OUT_CSS), bytes: { js: js.length, css: css.length } };
}

// ─── entry ──────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  await buildDevViewsBundle({
    outDir: at === -1 ? DEFAULT_OUT_DIR : resolve(args[at + 1]),
    quiet: args.includes('--quiet'),
  });
}
