import { randomUUID } from 'node:crypto';
import { OFFICIAL, assertEnvironment, bindEnvironment, providerId } from './environments.mjs';
import { readLocalAuth, credentials, sign } from './core.mjs';

export const LOCAL = 'codearts-local';
export async function resolveAuth(key, signal, environment = OFFICIAL) {
  signal?.throwIfAborted();
  if (!key) throw new Error(`CodeArts 尚未授权，请 /login ${providerId(environment)}`);
  let auth;
  try { auth = key === LOCAL ? { access: LOCAL } : JSON.parse(key); }
  catch { throw new Error('Invalid CodeArts credential format'); }
  assertEnvironment(auth, environment);
  if (auth.localReadOnly || auth.access === LOCAL) {
    if (!environment.allowLocalLogin) throw new Error(`只读登录未启用，请 /login ${providerId(environment)} 完成独立授权`);
    const local = await readLocalAuth(environment.localAuthDir);
    if (environment.id !== 'official' && ![environment.id, environment.apiOrigin].includes(local.enterpriseUrl)) {
      throw new Error('Local credential is not bound to this environment');
    }
    if (local.expires <= Date.now() + 60000) throw new Error(`CodeArts 本地登录已过期，请 /login ${providerId(environment)}`);
    return bindEnvironment(local, environment);
  }
  if (!Number.isFinite(auth.expires) || auth.expires <= Date.now()) throw new Error(`CodeArts 登录已过期，请 /login ${providerId(environment)}`);
  credentials(auth);
  return auth;
}
export function signedTransport(auth, fetchImpl = fetch, sessionId = randomUUID(), environment = OFFICIAL) {
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assertEnvironment(auth, environment);
    if (url.origin !== environment.apiOrigin || url.pathname !== environment.paths.chat || url.search) {
      throw new Error('Refusing to send CodeArts credentials outside its chat endpoint');
    }
    const body = await request.text(), headers = new Headers(request.headers);
    for (const name of ['authorization', 'x-security-token', 'x-sdk-date', 'host']) headers.delete(name);
    const signed = sign(request.url, request.method, body, credentials(auth), {
      'app-id': 'CodeAgent3.0', 'user-session-id': sessionId, 'x-ot-session-id': sessionId,
    });
    for (const [key, value] of Object.entries(signed)) headers.set(key, String(value));
    return fetchImpl(request.url, { method: request.method, body, headers, signal: request.signal, redirect: 'error' });
  };
}

// Inspect without re-encoding or buffering the response; callbacks run only when the host reads.
// This also handles CodeArts errors carried inside HTTP-200 SSE rather than OpenAI error objects.
export function inspectSSE(response, onEvent, signal) {
  if (!response.ok || !response.body || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) return response;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  async function frames(final = false) {
    if (pending.length > 1024 * 1024) throw new Error('CodeArts SSE frame exceeds 1 MiB');
    pending = pending.replace(/\r\n/g, '\n');
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1 || (final && pending.length)) {
      if (end === -1) end = pending.length;
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      const text = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!text || text === '[DONE]') continue;
      let event;
      try { event = JSON.parse(text); } catch { throw new Error('Invalid CodeArts SSE JSON'); }
      signal?.throwIfAborted();
      await onEvent?.(event);
      if (event?.error_code) throw new Error(`CodeArts ${String(event.error_code)}: ${typeof event.error_msg === 'string' ? event.error_msg : 'gateway error'}`);
    }
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        await frames(done);
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
