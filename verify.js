// Runs every example and byte-diffs its printed === SUMMARY === block against
// the example's expected-output.txt. Exits non-zero if any summary drifts.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dirs = readdirSync(root).filter((d) => /^\d\d-/.test(d)).sort();
let failed = 0;

for (const dir of dirs) {
  const stdout = execFileSync(process.execPath, [join(root, dir, 'run.js')], { encoding: 'utf8' });
  process.stdout.write(stdout);
  const lines = stdout.split('\n');
  const start = lines.indexOf('=== SUMMARY ===');
  const end = lines.indexOf('=== END ===', start);
  const summary = start !== -1 && end !== -1 ? lines.slice(start, end + 1).join('\n') + '\n' : '(no summary block printed)\n';
  const expected = readFileSync(join(root, dir, 'expected-output.txt'), 'utf8');
  const ok = summary === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'MATCH' : 'MISMATCH'}: ${dir} — summary vs expected-output.txt\n`);
}

if (failed > 0) {
  console.error(`${failed} example(s) did not match their expected-output.txt`);
  process.exit(1);
}
console.log(`All ${dirs.length} summaries match their expected-output.txt files.`);
