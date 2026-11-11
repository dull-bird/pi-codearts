// OMP's native host API differs from Pi 1.5; protocol/auth/session code stays shared.
import { createHash } from 'node:crypto';
import { AssistantMessageEventStream, streamSimple } from '@oh-my-pi/pi-ai';
import { getAgentDir } from '@oh-my-pi/pi-coding-agent';
import { createStreamCodeArts } from './stream.mjs';
import { registerCodeArts, piModels } from './extension.mjs';
import { SessionLeases, sessionLeases } from './sessions.mjs';

export function ompModels(catalog) {
  return piModels(catalog).map(({ thinkingLevelMap, ...model }) => {
    if (!model.reasoning || !thinkingLevelMap) return model;
    const entries = Object.entries(thinkingLevelMap).filter(([key, value]) => key !== 'off' && value !== null);
    return { ...model, thinking: {
      mode: 'effort', efforts: entries.map(([key]) => key), effortMap: Object.fromEntries(entries),
    } };
  });
}
const makeStream = leases => createStreamCodeArts({
  leases,
  createEventStream: () => new AssistantMessageEventStream(),
  streamSimple,
  effortMap: model => model.thinkingLevelMap || (model.thinking ? {
    off: 'none', ...Object.fromEntries(model.thinking.efforts.map(level => [level, model.thinking.effortMap?.[level] || level])),
  } : undefined),
});
export const streamCodeArts = makeStream(sessionLeases);
// OMP displays accountId after login. Keep the protocol's account JSON private,
// and give the host a stable opaque account identity instead of printing that JSON.
export function toOmpCredentials(auth) {
  if (!auth.accountId) return auth;
  return { ...auth, codeartsAccount: auth.accountId,
    accountId: `codearts-${createHash('sha256').update(auth.accountId).digest('hex').slice(0, 20)}` };
}
export function fromOmpCredentials(auth) {
  if (!auth.codeartsAccount) return auth;
  const { codeartsAccount, ...rest } = auth;
  return { ...rest, accountId: codeartsAccount };
}
function adaptLogin(callbacks) {
  return { ...callbacks, applicationName: 'OMP',
    onSelect: callbacks.onSelect || (async ({ message, options }) => {
      const answer = await callbacks.onPrompt({ message: `${message}\n${options.map((item, index) => `${index + 1}. ${item.label}`).join('\n')}\n输入编号（默认 1）`, allowEmpty: true });
      const index = answer.trim() ? Number(answer.trim()) - 1 : 0;
      if (!Number.isInteger(index) || !options[index]) throw new Error('Invalid CodeArts login selection');
      return options[index].id;
    }),
  };
}
export default async function (pi, options = {}) {
  // OMP rebinds factories for subagents while sharing modules. A child's teardown
  // must never close the parent's heartbeat leases.
  const leases = options.leases || new SessionLeases();
  return registerCodeArts(pi, { ...options, agentDir: options.agentDir || getAgentDir(), leases,
    streamCodeArts: makeStream(leases), configuredModels: ompModels, adaptLogin,
    getProviderAuth: async (ctx, id) => ({ auth: { apiKey: await ctx.modelRegistry.getApiKeyForProvider(id) } }),
    registerProvider: (id, config) => {
      const { refreshModels, name: _name, ...native } = config;
      pi.registerProvider(id, { ...native,
        oauth: { ...native.oauth,
          login: async callbacks => toOmpCredentials(await native.oauth.login(callbacks)),
          refreshToken: async (auth, signal) => toOmpCredentials(await native.oauth.refreshToken(fromOmpCredentials(auth), signal)),
          getApiKey: auth => native.oauth.getApiKey(fromOmpCredentials(auth)),
        },
        fetchDynamicModels: async key => {
          if (!key) return native.models;
          let credential;
          try { credential = JSON.parse(key); } catch { throw new Error('Invalid CodeArts credential format'); }
          return refreshModels({ allowNetwork: true, credential, signal: AbortSignal.timeout(12000) });
        },
      });
    },
  });
}
