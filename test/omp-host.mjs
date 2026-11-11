// Executed by the real OMP extension loader, never by Node. Synthetic credentials only.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { AuthStorage, SqliteAuthCredentialStore, type } from '@oh-my-pi/pi-ai';
import { ModelRegistry, getAgentDir } from '@oh-my-pi/pi-coding-agent';
import extension, { streamCodeArts } from '../omp.mjs';
import { OFFICIAL, bindEnvironment, DEFAULT_AGENT_ID } from '../environments.mjs';
import { saveCatalog } from '../catalog.mjs';
import { sessionLeases } from '../sessions.mjs';

export default async function () {
  const passed = [];
  const test = async (name, fn) => { await fn(); passed.push(name); };
  const auth = bindEnvironment({ type: 'oauth', access: JSON.stringify({ access_key_id: 'test-ak', secret_access_key: 'test-sk', security_token: 'test-sts' }), refresh: 'test-refresh', expires: Date.now() + 3600000 }, OFFICIAL);
  const modelSpec = { id: 'omp-test', name: 'OMP test', reasoning: false, input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const thinkingSpec = { ...modelSpec, id: 'omp-thinking', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } };
  await saveCatalog(getAgentDir(), OFFICIAL, [modelSpec, thinkingSpec]);
  const store = await SqliteAuthCredentialStore.open(join(getAgentDir(), 'offline-test.db'));
  const storage = new AuthStorage(store);
  await storage.credentials.reload();
  const registry = new ModelRegistry(storage, join(getAgentDir(), 'offline-models.yml'));
  const providers = new Map(), commands = new Map(), handlers = new Map();
  const pi = { registerProvider: (id, config) => { providers.set(id, config); registry.registerProvider(id, config); },
    registerCommand: (id, config) => commands.set(id, config), on: (event, fn) => handlers.set(event, fn) };
  let originalFetch = globalThis.fetch;
  const chunk = (delta, finish) => ({ id: 'test-id', object: 'chat.completion.chunk', created: 1, model: 'omp-test', choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
  const sse = (events, split = false) => {
    const bytes = new TextEncoder().encode(events.map(event => `data:${JSON.stringify(event)}\r\n\r\n`).join('') + 'data:[DONE]\r\n\r\n');
    return new Response(new ReadableStream({ start(controller) { if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const collect = async stream => { const events = []; for await (const event of stream) events.push(structuredClone(event)); return { events, result: await stream.result() }; };
  const context = (extra = {}) => ({ systemPrompt: 'Integration test.', messages: [{ role: 'user', content: 'Test.', timestamp: Date.now() }], ...extra });
  let latestBody;
  const run = (events, options = {}, ctx = context(), modelId = 'omp-test') => collect(streamCodeArts(registry.find('codearts', modelId), ctx, {
    apiKey: JSON.stringify(auth), maxRetries: 0, maxTokens: 512,
    fetch: async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/heartbeat')) return Response.json({ status: 'ok' });
      latestBody = JSON.parse(init.body);
      assert.match(new Headers(init.headers).get('authorization'), /^SDK-HMAC-SHA256 /);
      assert.ok(!JSON.stringify([...new Headers(init.headers)]).includes(auth.refresh));
      return sse(events, true);
    }, ...options,
  }));
  try {
    await test('native registration is offline and maps exact thinking levels', async () => {
      globalThis.fetch = async () => { throw new Error('Factory must not contact a service'); };
      await extension(pi, { agentDir: getAgentDir() });
      globalThis.fetch = originalFetch;
      assert.ok(providers.has('codearts'));
      assert.ok(providers.get('codearts').fetchDynamicModels);
      assert.equal(providers.get('codearts').refreshModels, undefined);
      assert.deepEqual(registry.find('codearts', 'omp-thinking').thinking.efforts, ['high', 'max']);
      assert.equal(commands.size, 4);
    });
    await test('child teardown cannot close parent heartbeat ownership', async () => {
      let parentClosed = 0, childClosed = 0;
      const parentHandlers = new Map(), childHandlers = new Map();
      const binding = handlers => ({ registerProvider() {}, registerCommand() {}, on: (event, handler) => handlers.set(event, handler) });
      await extension(binding(parentHandlers), { agentDir: getAgentDir(), leases: { close: async () => { parentClosed++; } } });
      await extension(binding(childHandlers), { agentDir: getAgentDir(), leases: { close: async () => { childClosed++; } } });
      await childHandlers.get('session_shutdown')();
      assert.equal(childClosed, 1); assert.equal(parentClosed, 0);
      await parentHandlers.get('session_shutdown')(); assert.equal(parentClosed, 1);
    });
    await test('native Unicode streaming, one terminal and provider identity', async () => {
      const { events, result } = await run([chunk({ content: '你好🌍' }), chunk({}, 'stop')]);
      assert.equal(result.stopReason, 'stop'); assert.equal(result.content[0].text, '你好🌍');
      assert.equal(result.api, 'codearts-chat');
      assert.equal(events.filter(e => e.type === 'done').length, 1);
      assert.equal(latestBody.tool_stream, true); assert.deepEqual(latestBody.thinking, { type: 'disabled' });
      assert.equal(latestBody.max_tokens, 512);
    });
    await test('native high/max mapping and actual thinking events', async () => {
      for (const level of ['high', 'max']) {
        const { events, result } = await run([chunk({ reasoning_content: 'Compute carefully.' }), chunk({ content: '221' }), chunk({}, 'stop')], { reasoning: level }, context(), 'omp-thinking');
        assert.equal(result.stopReason, 'stop'); assert.ok(events.some(e => e.type === 'thinking_delta'));
        assert.equal(latestBody.reasoning_effort, level); assert.deepEqual(latestBody.thinking, { type: 'enabled' });
      }
    });
    await test('native tool argument fragments and result replay', async () => {
      const tool = { name: 'lookup', description: 'Look up a name', parameters: type({ name: 'string' }) };
      const call = await run([chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"name":' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '"中文"}' } }] }), chunk({}, 'tool_calls')], {}, context({ tools: [tool] }));
      assert.equal(call.result.stopReason, 'toolUse'); assert.deepEqual(call.result.content[0].arguments, { name: '中文' });
      const replay = await run([chunk({ content: 'FOUND' }), chunk({}, 'stop')], {}, context({ tools: [tool], messages: [
        ...context().messages, call.result, { role: 'toolResult', toolCallId: 'call-1', toolName: 'lookup', content: [{ type: 'text', text: 'FOUND' }], isError: false, timestamp: Date.now() },
      ] }));
      assert.equal(replay.result.stopReason, 'stop'); assert.ok(latestBody.messages.some(m => m.role === 'tool' && m.content === 'FOUND'));
    });
    await test('native direct images survive request serialization', async () => {
      const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
      const { result } = await run([chunk({ content: 'image' }), chunk({}, 'stop')], {}, context({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe.' }, image], timestamp: Date.now() }] }));
      assert.equal(result.stopReason, 'stop');
      assert.ok(latestBody.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,'))));
    });
    await test('HTTP-200 gateway errors are not false success', async () => {
      const { result } = await run([{ error_code: 'TEST_GATEWAY', error_msg: 'Invalid parameter' }]);
      assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage, /TEST_GATEWAY/);
    });
    await test('pre-cancellation makes no network request', async () => {
      const controller = new AbortController(); controller.abort();
      const { result } = await run([], { signal: controller.signal, fetch: async () => { throw new Error('Unexpected request'); } });
      assert.equal(result.stopReason, 'aborted');
    });
    await test('native login, SQLite persistence, single-flight rotating refresh and environment binding', async () => {
      let tokens = 0;
      globalThis.fetch = async (url, init = {}) => {
        const target = new URL(String(url));
        if (target.hostname === '127.0.0.1') return originalFetch(url, init);
        if (target.href === OFFICIAL.tokenUrl) {
          tokens++;
          const params = new URLSearchParams(init.body);
          assert.ok(new Headers(init.headers).get('DPoP'));
          assert.equal(params.get('grant_type'), tokens === 1 ? 'authorization_code' : 'refresh_token');
          if (tokens === 2) assert.equal(params.get('refresh_token'), 'rotating-1');
          return Response.json({ credentials: { access_key_id: `test-ak-${tokens}`, secret_access_key: 'test-sk', security_token: 'test-sts', expiration: new Date(Date.now() + 7200000).toISOString() }, refresh_token: `rotating-${tokens}` });
        }
        if (target.pathname === OFFICIAL.paths.account) return Response.json({ id: 'synthetic-test-account' });
        if (target.pathname === OFFICIAL.paths.agents) return Response.json({ agents: [{ agent_id: 'test-agent', original_id: DEFAULT_AGENT_ID }] });
        if (target.pathname === OFFICIAL.paths.detail) return Response.json({ gpts: { models: [{ model_name: 'Synthetic', model_parameters: { model_id: 'omp-test' } }] } });
        if (target.pathname === OFFICIAL.paths.variants) return Response.json({ variants: {} });
        throw new Error('Unexpected test endpoint');
      };
      const identity = await storage.oauth.login('codearts', {
        onAuth: info => {
          assert.match(info.instructions, /OMP/);
          const url = new URL(info.url);
          void originalFetch(`http://127.0.0.1:${url.searchParams.get('port')}/oauth/callback?code=synthetic-code`);
        }, onPrompt: async () => { throw new Error('Unexpected login prompt'); },
      });
      assert.equal(identity.type, 'oauth'); assert.equal(tokens, 1);
      let saved = storage.credentials.getOAuth('codearts');
      assert.equal(saved.refresh, 'rotating-1'); assert.deepEqual(saved.environment, auth.environment);
      assert.match(saved.accountId, /^codearts-[a-f0-9]+$/);
      assert.equal(saved.codeartsAccount, '{"id":"synthetic-test-account"}');
      await storage.credentials.set('codearts', { ...saved, expires: Date.now() - 1000 });
      const keys = await Promise.all(Array.from({ length: 5 }, () => storage.keys.get('codearts', 'omp-test-session')));
      assert.equal(tokens, 2); assert.ok(keys.every(key => JSON.parse(key).refresh === 'rotating-2'));
      assert.ok(keys.every(key => JSON.parse(key).accountId === '{"id":"synthetic-test-account"}'));
      saved = storage.credentials.getOAuth('codearts'); assert.equal(saved.refresh, 'rotating-2');
      assert.deepEqual(saved.environment, auth.environment);
      storage.close();
      const reopened = new AuthStorage(await SqliteAuthCredentialStore.open(join(getAgentDir(), 'offline-test.db')));
      await reopened.credentials.reload();
      assert.equal(reopened.credentials.getOAuth('codearts').refresh, 'rotating-2'); reopened.close();
      globalThis.fetch = originalFetch;
    });
  } finally {
    globalThis.fetch = originalFetch;
    await sessionLeases.close(); storage.close();
    await writeFile(process.env.CODEARTS_OMP_TEST_RESULT, JSON.stringify({ passed }), { mode: 0o600 });
  }
}
