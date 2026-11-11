import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const binary = process.env.CODEARTS_OMP_BINARY || join(homedir(), '.local/bin/omp');
let available = true;
try { await access(binary); } catch { available = false; }

test('real OMP host: registration, streaming, tools, images, cancellation, OAuth and persisted rotating refresh', { skip: !available, timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codearts-omp-offline-'));
  const agent = join(dir, 'agent'), resultPath = join(dir, 'result.json');
  const env = { ...process.env, HOME: dir, OMP_PROFILE: '', PI_PROFILE: '',
    PI_CONFIG_DIR: join(dir, '.omp'), OMP_CONFIG_DIR: join(dir, '.omp'),
    PI_CODING_AGENT_DIR: agent, OMP_CODING_AGENT_DIR: agent,
    PI_CODEARTS_CONFIG: join(agent, 'codearts.json'), CODEARTS_OMP_TEST_RESULT: resultPath };
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', dir], { cwd: root })).stdout)[0];
    const tarball = join(dir, packed.filename);
    await exec('tar', ['-xzf', tarball, '-C', dir]);
    await mkdir(join(dir, 'package/test'));
    await writeFile(join(dir, 'package/test/omp-host.mjs'), await readFile(new URL('./omp-host.mjs', import.meta.url)));
    // Exercise OMP's local package installer and release entry point offline.
    const installation = exec(binary, ['plugin', 'install', join(dir, 'package')], { env, cwd: dir, timeout: 30000, maxBuffer: 1000000 });
    installation.child.stdin.end(); await installation;
    const manifest = JSON.parse(await readFile(join(dir, 'package/package.json'), 'utf8'));
    assert.deepEqual(manifest.omp.extensions, ['./omp.mjs']);
    const running = exec(binary, ['models', 'codearts', '--json', '--no-extensions', '-e', join(dir, 'package/test/omp-host.mjs')],
      { env, cwd: dir, timeout: 100000, maxBuffer: 1000000 });
    running.child.stdin.end();
    const { stderr } = await running;
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.passed.length, 9, stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
