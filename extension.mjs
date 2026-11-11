import { discoverModels, refreshAuth } from './core.mjs';
import { login } from './login.mjs';
import { LOCAL, resolveAuth } from './transport.mjs';
import { sessionLeases } from './sessions.mjs';
import { OFFICIAL, assertEnvironment, providerId, chatBaseUrl, loadEnvironments, configPath,
  normalizeEnvironment, saveEnvironment, detectClientEnvironments } from './environments.mjs';
import { loadCatalog, saveCatalog, isCatalogStale } from './catalog.mjs';

export const piModels = catalog => catalog.map(model => ({ ...model, compat: {
  supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
} }));
export async function registerCodeArts(pi, {
  agentDir, configFile = undefined, streamCodeArts, configuredModels = piModels,
  registerProvider = (id, config) => pi.registerProvider(id, config),
  getProviderAuth = (ctx, id) => ctx.modelRegistry.getProviderAuth(id),
  adaptLogin = callbacks => callbacks, leases = sessionLeases,
}) {
  const path = configFile || configPath(agentDir), states = new Map();
  const addEnvironment = async environment => {
    const id = providerId(environment);
    const state = { environment, models: await loadCatalog(agentDir, environment), configure: () => {} };
    state.configure = () => registerProvider(id, {
      name: environment.label, baseUrl: chatBaseUrl(environment), api: 'codearts-chat',
      models: configuredModels(state.models),
      oauth: { name: environment.label, login: async callbacks => {
        const auth = await login(adaptLogin(callbacks), environment);
        const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
        try {
          const effective = await resolveAuth(JSON.stringify(auth), signal, environment);
          const models = await discoverModels(effective, signal, environment);
          signal.throwIfAborted(); await saveCatalog(agentDir, environment, models); state.models = models;
        } catch {
          callbacks.signal?.throwIfAborted();
          callbacks.onProgress?.(`授权成功；模型目录暂未更新，请稍后 /codearts-refresh ${id}`);
        }
        return auth;
      }, refreshToken: async (auth, signal) => {
        assertEnvironment(auth, environment);
        if (auth.localReadOnly || auth.access === LOCAL) {
          const local = await resolveAuth(JSON.stringify(auth), signal, environment);
          return { ...auth, expires: local.expires - 60000 };
        }
        return refreshAuth(auth, signal, fetch, environment);
      }, getApiKey: auth => JSON.stringify(auth) },
      streamSimple: (model, context, options) => streamCodeArts(model, context, options, environment),
      refreshModels: async context => {
        if (!context.allowNetwork || context.credential?.type !== 'oauth') return configuredModels(state.models);
        const auth = await resolveAuth(JSON.stringify(context.credential), context.signal, environment);
        const models = await discoverModels(auth, context.signal, environment);
        context.signal.throwIfAborted();
        await saveCatalog(agentDir, environment, models); state.models = models;
        return configuredModels(models);
      },
    });
    states.set(id, state); state.configure();
  };
  await addEnvironment(OFFICIAL);
  try { for (const environment of await loadEnvironments(path)) if (environment !== OFFICIAL) await addEnvironment(environment); }
  catch (error) { pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : 'Invalid CodeArts environment configuration', 'error');
  }); }
  const shutdown = new AbortController();
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    for (const state of states.values()) {
      if (!await isCatalogStale(agentDir, state.environment)) continue;
      void (async () => {
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(30000)]);
        try {
          const resolved = await getProviderAuth(ctx, providerId(state.environment));
          if (!resolved?.auth.apiKey) return;
          const auth = await resolveAuth(resolved.auth.apiKey, signal, state.environment);
          const models = await discoverModels(auth, signal, state.environment);
          signal.throwIfAborted(); await saveCatalog(agentDir, state.environment, models);
          if (shutdown.signal.aborted) return;
          state.models = models; state.configure();
        } catch { /* Keep the last known catalog; the explicit command reports errors. */ }
      })();
    }
  });
  pi.on('session_shutdown', async () => { shutdown.abort(); await leases.close(); });
  const chooseState = (args, ctx) => {
    const requested = args.trim();
    const id = requested ? (states.has(requested) ? requested : `codearts-${requested}`)
      : (states.has(ctx.model?.provider) ? ctx.model.provider : 'codearts');
    const state = states.get(id);
    if (!state) throw new Error('Unknown CodeArts environment; use /codearts-environments');
    return state;
  };
  const reportError = (error, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : 'CodeArts operation failed', 'error');
    else throw error;
  };
  pi.registerCommand('codearts-refresh', {
    description: '刷新模型与思考能力，可指定环境 provider id',
    handler: async (args, ctx) => {
      try {
        const state = chooseState(args, ctx), environment = state.environment, signal = AbortSignal.timeout(30000);
        const resolved = await getProviderAuth(ctx, providerId(environment));
        const auth = await resolveAuth(resolved?.auth.apiKey, signal, environment);
        const models = await discoverModels(auth, signal, environment);
        await saveCatalog(agentDir, environment, models); state.models = models; state.configure();
        if (ctx.hasUI) ctx.ui.notify(`${environment.label}: 已刷新 ${models.length} 个模型及思考能力。用 /model 选择。`, 'info');
      } catch (error) { reportError(error, ctx); }
    },
  });
  pi.registerCommand('codearts-status', {
    description: '显示环境、授权来源、续期能力和思考等级，不输出凭据',
    handler: async (args, ctx) => {
      try {
        const { environment, models } = chooseState(args, ctx);
        const resolved = await getProviderAuth(ctx, providerId(environment));
        const auth = await resolveAuth(resolved?.auth.apiKey, AbortSignal.timeout(5000), environment);
        const thinking = models.filter(model => model.reasoning).map(model => `${model.id}: ${Object.entries(model.thinkingLevelMap || {}).filter(([, value]) => value !== null).map(([key]) => key).join('/')}`);
        if (ctx.hasUI) ctx.ui.notify(`${environment.label} (${providerId(environment)})\n网关: ${environment.apiOrigin}\n${auth.localReadOnly ? '本地只读登录（不自动刷新）' : auth.refresh ? '独立 OAuth（可自动续期）' : '临时登录（不可续期）'}；到期 ${new Date(auth.expires).toLocaleString()}\n${models.length} 个模型\n思考等级: ${thinking.join('；') || '服务端未公布可选等级'}`, 'info');
      } catch (error) { reportError(error, ctx); }
    },
  });
  pi.registerCommand('codearts-environments', {
    description: '列出已配置的 CodeArts 环境，不发认证请求',
    handler: async (_args, ctx) => { if (ctx.hasUI) ctx.ui.notify([...states.values()].map(({ environment: env }) => `${providerId(env)} — ${env.label}\n  API: ${env.apiOrigin}\n  授权: ${env.authorizeUrl}\n  Token: ${env.tokenUrl}`).join('\n'), 'info'); },
  });
  pi.registerCommand('codearts-configure', {
    description: '确认导入本机环境或配置自定义环境（不复制凭据）',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error('Interactive UI required; alternatively edit the personal codearts.json file');
      try {
        const detected = await detectClientEnvironments();
        let candidate;
        if (detected.length) {
          const choices = [...detected.map((item, index) => `${index + 1}. ${item.environment.apiOrigin} (${item.source})`), '手动配置'];
          const choice = await ctx.ui.select('检测到以下候选环境，尚未信任或发送凭据', choices);
          if (!choice) return;
          const index = choices.indexOf(choice); if (index < detected.length) candidate = detected[index].environment;
        }
        const ask = async (message, fallback = '') => {
          const value = await ctx.ui.input(message, fallback);
          if (value === undefined) throw new Error('CodeArts configuration cancelled');
          return value.trim() || fallback;
        };
        const id = args.trim() || await ask('环境 ID（小写英文、数字、短横线）', candidate?.id || 'company');
        const environment = normalizeEnvironment({ ...candidate, id,
          label: await ask('显示名称', candidate?.label || `CodeArts (${id})`),
          apiOrigin: await ask('可信推理网关 origin（HTTPS）', candidate?.apiOrigin || ''),
          authorizeUrl: await ask('官方/企业授权页面完整 URL', candidate?.authorizeUrl || ''),
          tokenUrl: await ask('可信 OAuth Token 服务完整 URL', candidate?.tokenUrl || ''),
          clientId: await ask('OAuth Client ID', candidate?.clientId || 'CodeArts_Tui'),
        });
        if (!await ctx.ui.confirm('信任此环境？仅添加后独立授权，不迁移已有凭据', `API: ${environment.apiOrigin}\n授权: ${environment.authorizeUrl}\nToken: ${environment.tokenUrl}\nClient: ${environment.clientId}`)) return;
        await saveEnvironment(path, environment); await addEnvironment(environment);
        ctx.ui.notify(`已添加 ${providerId(environment)}。请 /login 选择该环境独立授权，然后 /codearts-refresh ${providerId(environment)}。`, 'info');
      } catch (error) { reportError(error, ctx); }
    },
  });
}
