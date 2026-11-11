// Real-account regression; launched explicitly via test/omp-live.mjs, never by public CI.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AuthStorage, SqliteAuthCredentialStore, type } from '@oh-my-pi/pi-ai';
import { ModelRegistry, getAgentDir } from '@oh-my-pi/pi-coding-agent';
import extension, { streamCodeArts } from '../omp.mjs';
import { sessionLeases } from '../sessions.mjs';
import { redPng } from './image.mjs';

export default async function () {
  const result = { passed: [], heartbeats: [], reasoning: [] }, report = process.env.CODEARTS_OMP_TEST_RESULT;
  const storage = new AuthStorage(await SqliteAuthCredentialStore.open(join(getAgentDir(), 'agent.db')));
  await storage.credentials.reload();
  const registry = new ModelRegistry(storage, join(process.env.CODEARTS_OMP_TEST_WORK, 'models.yml'));
  const pi = { registerProvider: (id, config) => registry.registerProvider(id, config), registerCommand() {}, on() {} };
  const collect = async stream => { const events = []; for await (const event of stream) events.push(structuredClone(event)); return { events, message: await stream.result() }; };
  const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('');
  const context = (content, extra = {}) => ({ messages: [{ role: 'user', content, timestamp: Date.now() }], ...extra });
  let key;
  const monitoredFetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith('/heartbeat')) result.heartbeats.push({ status: url.searchParams.get('status'), http: response.status });
    return response;
  };
  const options = { apiKey: undefined, sessionId: randomUUID(), maxTokens: 2048, maxRetries: 0,
    fetch: monitoredFetch, signal: AbortSignal.timeout(90000) };
  const run = async (model, ctx, extra = {}) => collect(streamCodeArts(model, ctx, { ...options, apiKey: key, ...extra }));
  try {
    await extension(pi);
    const before = storage.credentials.getOAuth('codearts');
    assert.ok(before?.refresh, 'Independent OMP OAuth login required; run omp login codearts');
    const id = storage.oauth.accounts('codearts')[0].credentialId;
    await Promise.all(Array.from({ length: 5 }, () => storage.oauth.refresh(id, AbortSignal.timeout(30000))));
    key = await storage.keys.get('codearts', options.sessionId);
    assert.ok(JSON.parse(key).refresh);
    result.passed.push('real independent OMP refresh; refreshed credential persisted and resolved');
    const model = registry.find('codearts', 'glm-5.3-flash');
    assert.ok(model, 'Refresh CodeArts model catalog first');
    const simple = await run(model, context('只回复：OMP 独立授权正常'));
    assert.equal(simple.message.stopReason, 'stop', simple.message.errorMessage);
    assert.match(text(simple.message), /OMP.*独立授权正常/);
    assert.ok(simple.events.some(event => event.type === 'text_delta'));
    result.passed.push('real Chinese text streaming and usage');
    const tool = { name: 'lookup', description: 'Return a known test value', parameters: type({ name: 'string' }) };
    const call = await run(model, context('Call lookup with name=fixture. Do not answer until you have its result.', { tools: [tool] }));
    assert.equal(call.message.stopReason, 'toolUse', call.message.errorMessage);
    const requested = call.message.content.find(block => block.type === 'toolCall'); assert.ok(requested);
    const replay = await run(model, { tools: [tool], messages: [
      ...context('Call lookup with name=fixture.').messages, call.message,
      { role: 'toolResult', toolCallId: requested.id, toolName: requested.name, content: [{ type: 'text', text: 'OMP_TOOL_RESULT_7319' }], isError: false, timestamp: Date.now() },
      { role: 'user', content: 'Return the tool result verbatim.', timestamp: Date.now() },
    ] });
    assert.equal(replay.message.stopReason, 'stop', replay.message.errorMessage); assert.match(text(replay.message), /OMP_TOOL_RESULT_7319/);
    result.passed.push('real tool arguments and tool-result replay');
    const vision = registry.find('codearts', 'deepseek-v4.1-flash-1017');
    const image = { type: 'image', mimeType: 'image/png', data: redPng().toString('base64') };
    const seen = await run(vision, context([{ type: 'text', text: 'What is the dominant color? Reply with one color word.' }, image]));
    assert.equal(seen.message.stopReason, 'stop', seen.message.errorMessage); assert.match(text(seen.message), /red|红/i);
    result.passed.push('real inline image');
    const imageTool = { role: 'assistant', api: 'codearts-chat', provider: 'codearts', model: vision.id, content: [{ type: 'toolCall', id: 'test-image', name: 'lookup', arguments: { name: 'image' } }], stopReason: 'toolUse', timestamp: Date.now(), usage: simple.message.usage };
    const imageReplay = await run(vision, { tools: [tool], messages: [
      ...context('Use lookup to get an image and report its dominant color.').messages, imageTool,
      { role: 'toolResult', toolCallId: 'test-image', toolName: 'lookup', content: [image], isError: false, timestamp: Date.now() },
    ] });
    assert.equal(imageReplay.message.stopReason, 'stop', imageReplay.message.errorMessage); assert.match(text(imageReplay.message), /red|红/i);
    result.passed.push('real image tool result');
    const reasoningModel = registry.find('codearts', 'GLM-5.2');
    for (const level of ['high', 'max']) {
      let sent, upstreamReasoning = 0;
      const thought = await run(reasoningModel, context('Compute 13 times 17. Give only the final number.'), {
        reasoning: level, onPayload: payload => { sent = payload.reasoning_effort; },
        onProviderStreamEvent: event => { for (const choice of event.choices || []) upstreamReasoning += (choice.delta?.reasoning_content || choice.delta?.reasoning || '').length; },
      });
      assert.equal(thought.message.stopReason, 'stop', thought.message.errorMessage); assert.match(text(thought.message), /221/); assert.equal(sent, level);
      const thinkingEvents = thought.events.filter(event => event.type === 'thinking_delta').length;
      result.reasoning.push({ level, upstreamReasoning, thinkingEvents });
      assert.ok(thinkingEvents > 0, `No structured OMP thinking stream for ${level}; upstream chars=${upstreamReasoning}`);
      result.passed.push(`real ${level} effort and thinking deltas`);
    }
    const controller = new AbortController(); let cancelled = false;
    const stream = streamCodeArts(model, context('Count from 1 to 1000, one number per line.'), { ...options, apiKey: key, signal: controller.signal });
    for await (const event of stream) if (event.type === 'text_delta' && !cancelled) { cancelled = true; controller.abort(); }
    assert.ok(cancelled); assert.equal((await stream.result()).stopReason, 'aborted');
    result.passed.push('real cancellation during streaming');
    assert.ok(result.heartbeats.length > 0); assert.ok(result.heartbeats.every(item => item.http === 200));
    assert.equal(result.heartbeats.at(-1).status, 'idle'); result.passed.push('all heartbeats HTTP 200 and final idle');
  } catch (error) { result.error = error.message; throw error; }
  finally { await sessionLeases.close(); storage.close(); await writeFile(report, JSON.stringify(result), { mode: 0o600 }); }
}
