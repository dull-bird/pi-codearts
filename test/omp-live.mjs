import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const exec = promisify(execFile), dir = await mkdtemp(join(tmpdir(), 'codearts-omp-live-'));
const binary = process.env.CODEARTS_OMP_BINARY || join(homedir(), '.local/bin/omp');
const reportPath = join(dir, 'report.json');
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const piDigest = async () => createHash('sha256').update(JSON.stringify(JSON.parse(await readFile(join(homedir(), '.pi/agent/auth.json'), 'utf8')).codearts)).digest('hex');
const originalPath = join(homedir(), '.codeartsdoer/cli-data/auth.json');
const before = await Promise.all([piDigest(), digest(originalPath)]);
try {
  const running = exec(binary, ['models', 'codearts', '--json', '--no-extensions', '-e', fileURLToPath(new URL('./omp-live-host.mjs', import.meta.url))], {
    cwd: dir, env: { ...process.env, CODEARTS_OMP_TEST_WORK: dir, CODEARTS_OMP_TEST_RESULT: reportPath }, timeout: 240000, maxBuffer: 1000000,
  });
  running.child.stdin.end();
  let failure;
  try { await running; } catch (error) { failure = error; }
  let result;
  try { result = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch { throw new Error('OMP live test did not produce a report; raw subprocess output withheld to protect credentials'); }
  for (const name of result.passed) console.log(`PASS ${name}`);
  console.log('Reasoning statistics:', JSON.stringify(result.reasoning));
  if (failure || result.error) throw new Error(result.error?.startsWith('No structured OMP') ? result.error : `OMP live regression failed after ${result.passed.length} stages; raw diagnostics withheld`);
  assert.ok(result.passed.length >= 9);
} finally {
  try { assert.deepEqual(await Promise.all([piDigest(), digest(originalPath)]), before, 'A source CodeArts credential changed');
    console.log('PASS Pi CodeArts and original CodeArts credentials untouched by OMP regression');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
