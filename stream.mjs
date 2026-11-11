import { randomUUID } from 'node:crypto';
import { OFFICIAL, chatBaseUrl } from './environments.mjs';
import { resolveAuth, signedTransport, inspectSSE } from './transport.mjs';
import { sessionLeases } from './sessions.mjs';

export function failureMessage(model, error, aborted = false) {
  const reason = aborted ? 'aborted' : 'error';
  return { type: 'error', reason, error: {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: reason, errorMessage: error instanceof Error ? error.message : 'CodeArts request failed', timestamp: Date.now(),
  } };
}
export function createStreamCodeArts({ createEventStream, streamSimple, effortMap = model => model.thinkingLevelMap, leases = sessionLeases }) {
  return function streamCodeArts(model, context, options = {}, environment = OFFICIAL) {
    const stream = createEventStream();
    void (async () => {
      let release, terminal;
      try {
        const auth = await resolveAuth(options.apiKey, options.signal, environment);
        const sessionId = options.sessionId || randomUUID(), fetchImpl = options.fetch || fetch;
        release = await leases.acquire(sessionId, auth, fetchImpl, options.signal, environment);
        const transport = signedTransport(auth, fetchImpl, sessionId, environment);
        const inner = streamSimple({ ...model, baseUrl: chatBaseUrl(environment), api: 'openai-completions' }, context, {
          ...options, apiKey: 'codearts-signed',
          fetch: async (input, init) => inspectSSE(await transport(input, init), event => options.onProviderStreamEvent?.(event, model), options.signal),
          onPayload: async payload => {
            const outgoing = { ...payload, tool_stream: true };
            const level = options.reasoning || 'off', mapped = effortMap(model)?.[level];
            if (options.reasoning && !mapped) throw new Error(`CodeArts model does not advertise thinking level: ${level}`);
            if (!options.reasoning) { delete outgoing.reasoning_effort; outgoing.thinking = { type: 'disabled' }; }
            else { outgoing.thinking = { type: 'enabled' }; outgoing.reasoning_effort = mapped || level; }
            const result = await options.onPayload?.(outgoing, model);
            return result === undefined ? outgoing : result;
          },
          onResponse: options.onResponse ? response => options.onResponse(response, model) : undefined,
          // The transport inspector provides this consistently for both hosts; do not call it twice in Pi.
          onProviderStreamEvent: undefined,
        });
        for await (const event of inner) {
          if ('partial' in event) event.partial.api = model.api;
          if ('message' in event) event.message.api = model.api;
          if ('error' in event) event.error.api = model.api;
          if (event.type === 'done' || event.type === 'error') terminal = event;
          else stream.push(event);
        }
        if (!terminal) throw new Error('CodeArts stream ended without a terminal event');
      } catch (error) { terminal = failureMessage(model, error, options.signal?.aborted); }
      finally { await release?.(); }
      if (terminal) stream.push(terminal);
      stream.end();
    })();
    return stream;
  };
}
