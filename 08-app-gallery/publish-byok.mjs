// Stage the BYOK page for GitHub Pages.
//
//   npm run byok:publish
//
// Regenerates out/byok/ from scratch, then copies it into .gh-pages-staging/
// (gitignored) with the two files a Pages host needs and the generator has no
// reason to emit:
//
//   .nojekyll  Pages runs Jekyll by default, and Jekyll DROPS every path whose
//              name starts with `_`. The vendored dist trees are third-party
//              bytes we do not control, so an underscore file appearing there
//              is a matter of time — and the failure mode is one 404 inside an
//              8 MB import graph. This file turns Jekyll off entirely.
//   404.html   Pages serves it for any unknown path under the site. A deep link
//              or a stale bookmark lands on the page instead of a dead end.
//
// The staging dir is a plain folder, NOT a git worktree: this script never
// touches git. Pushing .gh-pages-staging/ to an orphan `gh-pages` branch is the
// operator's step, printed at the end.
//
// Nothing here is key-aware, because there is nothing to be aware of — the
// generated artifact contains no key material by construction (verify-byok.mjs
// asserts it), and this script only copies what the generator wrote.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate } from './byok.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const stagingDir = join(repoRoot, '.gh-pages-staging');

// The public URL this artifact is published to. Only used for the instructions
// printed below — the page itself hardcodes no origin and no base path, which
// is what lets it work at a subpath, at a root, or off a local file server.
export const PAGES_URL = 'https://footprintjs.github.io/visible-reasoning/';

// Served for any unknown path under the site. A meta refresh (not JS) so it
// works with scripting off, plus a plain link so it works with the refresh
// blocked.
//
// `./` is relative on purpose — the page must not hardcode /visible-reasoning/,
// or it would break the moment the folder is served anywhere else. The honest
// limit of that choice: from /visible-reasoning/typo it resolves to
// /visible-reasoning/ (right), but from /visible-reasoning/a/b/typo it resolves
// to /visible-reasoning/a/b/ (still 404). This is a one-page site, so the deep
// case only arises from a hand-mangled URL; a correct absolute redirect would
// have to know the base path, which is exactly the knowledge we refuse to bake
// in. The visible link keeps even that case navigable.
const NOT_FOUND_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found — bring your own key</title>
<meta http-equiv="refresh" content="0; url=./">
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  background:#FFFFFF;color:#1E1A15}
  p{max-width:34rem;padding:0 1.5rem;line-height:1.6;color:#786D5E}
  a{color:#C0531F}</style></head><body>
<p>There is nothing at this address. Taking you to <a href="./">the demo</a>.</p>
</body></html>
`;

function tally(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) { files += 1; bytes += statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Paths Jekyll would have eaten — reported, so .nojekyll is never a guess. */
function underscorePaths(dir) {
  const hits = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.name.startsWith('_')) hits.push(relative(dir, p));
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return hits;
}

export function publish({ quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };

  const { outDir } = generate({ quiet: true });
  log('regenerated 08-app-gallery/out/byok/ from source');

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  cpSync(outDir, stagingDir, { recursive: true });

  writeFileSync(join(stagingDir, '.nojekyll'), '');
  writeFileSync(join(stagingDir, '404.html'), NOT_FOUND_HTML);

  const { files, bytes } = tally(stagingDir);
  const eaten = underscorePaths(stagingDir);
  log(`staged ${files} files (${(bytes / 1e6).toFixed(1)} MB) → .gh-pages-staging/`);
  log(`  + .nojekyll  — ${eaten.length
    ? `${eaten.length} underscore path(s) Jekyll would have dropped: ${eaten.slice(0, 3).join(', ')}${eaten.length > 3 ? ' …' : ''}`
    : 'no underscore paths today; keeps the next vendor bump safe'}`);
  log('  + 404.html   — relative redirect to ./');

  log('');
  log('Next — push it (the staging dir is gitignored; nothing above touched git):');
  log('');
  log('  git worktree add -B gh-pages ../vr-gh-pages');
  log('  rm -rf ../vr-gh-pages/* ../vr-gh-pages/.nojekyll');
  log('  cp -R .gh-pages-staging/. ../vr-gh-pages/');
  log('  git -C ../vr-gh-pages add -A && git -C ../vr-gh-pages commit -m "publish BYOK page"');
  log('  git -C ../vr-gh-pages push -u origin gh-pages');
  log('');
  log('Then: Settings → Pages → Source = "Deploy from a branch", branch = gh-pages, folder = / (root).');
  log(`It goes live at ${PAGES_URL}`);
  log('');
  log('Checks worth doing once it is up: the page loads, DevTools → Network shows');
  log('every module resolving under /visible-reasoning/, and the only key-bearing');
  log('request goes to api.anthropic.com.');

  return { stagingDir, files, bytes };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) publish();
