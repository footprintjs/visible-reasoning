// Where the generators get vr-dev-views from.
//
// dev-views/build.mjs is an esbuild build, and esbuild's plugin API is async —
// but `byok.js generate()` is synchronous and is called synchronously by two
// gates. So the build runs as a child process (execFileSync), memoized per
// output directory: the first generator in a process pays for it, every later
// one gets the same bytes for free.
//
// The bundle lands in out/ like every other generated file. It is never
// committed and never hand-edited: `node 08-app-gallery/dev-views/build.mjs`
// reproduces it from the pinned devDependencies.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The two files the debug modal loads, by the names the build writes. */
export const DEV_VIEWS_JS = 'vr-dev-views.iife.js';
export const DEV_VIEWS_CSS = 'vr-dev-views.iife.css';

/** Where run.js serves them from, and where the BYOK generator copies them out of. */
export const DEV_VIEWS_DIR = join(here, '..', 'out', 'vendor');

const BUILD_SCRIPT = join(here, '..', 'dev-views', 'build.mjs');

const built = new Set();

/**
 * Build the bundle if this process has not already, and return where it is.
 * Throws (loudly, with the build's own stderr) rather than shipping a page that
 * would lazily load a file that isn't there.
 */
export function ensureDevViews({ quiet = false } = {}) {
  if (!built.has(DEV_VIEWS_DIR)) {
    execFileSync(process.execPath, [BUILD_SCRIPT, '--out', DEV_VIEWS_DIR, ...(quiet ? ['--quiet'] : [])], {
      stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    });
    built.add(DEV_VIEWS_DIR);
  }
  const js = join(DEV_VIEWS_DIR, DEV_VIEWS_JS);
  const css = join(DEV_VIEWS_DIR, DEV_VIEWS_CSS);
  for (const f of [js, css]) {
    if (!existsSync(f)) throw new Error(`dev-views build produced no ${f}`);
  }
  return { dir: DEV_VIEWS_DIR, js, css, bytes: { js: statSync(js).size, css: statSync(css).size } };
}

/** Copy the built pair into a generated bundle's own vendor/ directory. */
export function copyDevViews(destDir, { quiet = false } = {}) {
  const src = ensureDevViews({ quiet });
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src.js, join(destDir, DEV_VIEWS_JS));
  copyFileSync(src.css, join(destDir, DEV_VIEWS_CSS));
  return { destDir, bytes: src.bytes };
}
