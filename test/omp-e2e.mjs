// Real native OMP agent loop. Uses OMP's own persisted login, not Pi auth.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile), dir = await mkdtemp(join(tmpdir(), 'codearts-omp-e2e-'));
const binary = process.env.CODEARTS_OMP_BINARY || join(homedir(), '.local/bin/omp');
const extension = process.env.CODEARTS_OMP_EXTENSION || fileURLToPath(new URL('../omp.mjs', import.meta.url));
const common = ['--no-session', '--no-title', '--no-context-files', '--no-skills', '--no-rules', '--no-lsp', '--no-pty',
  '--no-extensions', '--trusted-extension', extension, '--mode', 'json', '--max-time', '90'];
async function turn(extra, prompt) {
  const running = exec(binary, [...common, ...extra, '--print', prompt], { cwd: dir, env: process.env, timeout: 110000, maxBuffer: 3000000 });
  running.child.stdin.end();
  let out;
  try { out = (await running).stdout; }
  catch { throw new Error('OMP CLI regression failed; raw output withheld to protect account diagnostics'); }
  const events = out.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const message = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
  assert.equal(message?.stopReason, 'stop', 'OMP did not return a normal final answer');
  assert.equal(message.provider, 'codearts'); assert.equal(message.api, 'codearts-chat');
  return { events, message, text: message.content.filter(block => block.type === 'text').map(block => block.text).join('') };
}
try {
  if (!process.argv.includes('--thinking-only')) {
  const fixture = join(dir, 'fixture.txt'); await writeFile(fixture, 'OMP_CODEARTS_E2E_7319\n');
  const tools = await turn(['--model', 'codearts/glm-5.3-flash', '--thinking', 'off', '--tools', 'read', '--auto-approve',
    '--system-prompt', 'Integration test. Use the read tool exactly once to read only the file the user specifies. Then return the file content verbatim.'],
    `Read ${fixture} using the read tool and return its content.`);
  assert.ok(tools.events.some(event => event.type === 'tool_execution_end' && event.toolName === 'read' && !event.isError));
  assert.match(tools.text, /OMP_CODEARTS_E2E_7319/);
  console.log('PASS real OMP CLI → installed provider → CodeArts → native read tool → result replay → final answer');
  }
  // A trivial 13×17 turn can legitimately return no reasoning. Keep the real
  // CLI system prompt intact and use a task that elicits observable reasoning.
  for (const level of ['high', 'max']) {
    const thought = await turn(['--model', 'codearts/GLM-5.2', '--thinking', level, '--no-tools', '--system-prompt', 'You are a helpful assistant.'],
      'Compute 1234 times 5678 accurately. Think carefully and verify the arithmetic before answering. Give only the final number.');
    assert.match(thought.text.replaceAll(',', ''), /7006652/);
    assert.ok(thought.events.some(event => event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta'), `OMP CLI did not expose real thinking deltas for ${level}`);
    console.log(`PASS real OMP CLI ${level} effort → thinking events → correct final answer`);
  }
} finally { await rm(dir, { recursive: true, force: true }); }
