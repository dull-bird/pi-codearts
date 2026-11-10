import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, openAICompletionsApi, type Api, type Model, type TranscriptContext, type SimpleStreamOptions, type AssistantMessageEvent } from '@earendil-works/pi-ai/compat';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readLocalAuth, credentials, sign, discoverModels, refreshAuth } from './core.mjs';
import { login } from './login.mjs';
import { sessionLeases } from './sessions.mjs';

import { OFFICIAL, assertEnvironment, bindEnvironment, providerId, chatBaseUrl, loadEnvironments, configPath, normalizeEnvironment, saveEnvironment, detectClientEnvironments } from './environments.mjs';
import { loadCatalog, saveCatalog, isCatalogStale } from './catalog.mjs';
const LOCAL='codearts-local';
const api=openAICompletionsApi();
const configuredModels=(catalog)=>catalog.map(m=>({...m,compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens' as const}}));
export async function resolveAuth(key,signal,environment=OFFICIAL) {
  signal?.throwIfAborted();
  if(!key)throw new Error(`CodeArts 尚未授权，请 /login ${providerId(environment)}`);
  let auth;
  try {auth=key===LOCAL?{access:LOCAL}:JSON.parse(key);} catch {throw new Error('Invalid CodeArts credential format');}
  assertEnvironment(auth,environment);
  if(auth.localReadOnly || auth.access===LOCAL) {
    if(!environment.allowLocalLogin)throw new Error(`只读登录未启用，请 /login ${providerId(environment)} 完成独立授权`);
    const local=await readLocalAuth(environment.localAuthDir);
    if(environment.id!=='official'&&![environment.id,environment.apiOrigin].includes(local.enterpriseUrl))throw new Error('Local credential is not bound to this environment');
    if(local.expires<=Date.now()+60000)throw new Error(`CodeArts 本地登录已过期，请 /login ${providerId(environment)}`);
    return bindEnvironment(local,environment);
  }
  if(!Number.isFinite(auth.expires)||auth.expires<=Date.now())throw new Error(`CodeArts 登录已过期，请 /login ${providerId(environment)}`);
  credentials(auth);
  return auth;
}
export function signedTransport(auth,fetchImpl=fetch,sessionId:string=randomUUID(),environment=OFFICIAL) {
  return async (input,init) => {
    const request=new Request(input,init);
    const url=new URL(request.url);
    assertEnvironment(auth,environment);
    if(url.origin!==environment.apiOrigin || url.pathname!==environment.paths.chat || url.search)throw new Error('Refusing to send CodeArts credentials outside its chat endpoint');
    const body=await request.text();
    const headers=new Headers(request.headers);
    for(const name of ['authorization','x-security-token','x-sdk-date','host'])headers.delete(name);
    const signed=sign(request.url,request.method,body,credentials(auth),{'app-id':'CodeAgent3.0','user-session-id':sessionId,'x-ot-session-id':sessionId});
    for(const [k,v] of Object.entries(signed))headers.set(k,String(v));
    return fetchImpl(request.url,{method:request.method,body,headers,signal:request.signal,redirect:'error'});
  };
}
export function streamCodeArts(model:Model<Api>,context:TranscriptContext,options:SimpleStreamOptions={},environment=OFFICIAL) {
  const stream=createAssistantMessageEventStream();
  (async()=>{
    let release:(()=>Promise<void>)|undefined;
    let terminal:AssistantMessageEvent|undefined;
    try {
      const auth=await resolveAuth(options.apiKey,options.signal,environment);
      const sessionId=options.sessionId || randomUUID();
      release=await sessionLeases.acquire(sessionId,auth,options.fetch || fetch,options.signal,environment);
      const inner=api.streamSimple({...model,baseUrl:chatBaseUrl(environment),api:'openai-completions'},context,
        {...options,apiKey:'codearts-signed',fetch:signedTransport(auth,options.fetch || fetch,sessionId,environment),
          onPayload:async(payload)=>{
            // CodeArts requires its tool_stream extension for streamed tool arguments.
            const outgoing:Record<string,unknown>={...(payload as Record<string,unknown>),tool_stream:true};
            const level=options.reasoning || 'off';
            const mapped=model.thinkingLevelMap?.[level];
            if(options.reasoning&&mapped===null)throw new Error(`CodeArts model does not advertise thinking level: ${level}`);
            if(!options.reasoning) {delete outgoing.reasoning_effort;outgoing.thinking={type:'disabled'};}
            else {outgoing.thinking={type:'enabled'};outgoing.reasoning_effort=mapped || level;}
            const result=await options.onPayload?.(outgoing,model);
            return result===undefined?outgoing:result;
          },
          onResponse:options.onResponse ? response=>options.onResponse(response,model) : undefined,
          onProviderStreamEvent:async event=>{
            await options.onProviderStreamEvent?.(event,model);
            // The gateway can report failures inside an HTTP-200 SSE frame, not an OpenAI error object.
            const data=event as {error_code?:unknown;error_msg?:unknown};
            if(data?.error_code)throw new Error(`CodeArts ${String(data.error_code)}: ${typeof data.error_msg==='string'?data.error_msg:'gateway error'}`);
          }});
      for await(const event of inner) {
        // Keep the custom API identity for persistence and cross-provider session handoff.
        if('partial' in event)event.partial.api=model.api;
        if('message' in event)event.message.api=model.api;
        if('error' in event)event.error.api=model.api;
        if(event.type==='done'||event.type==='error')terminal=event;
        else stream.push(event);
      }
      if(!terminal)throw new Error('CodeArts stream ended without a terminal event');
    } catch(error) {
      const reason=options.signal?.aborted?'aborted':'error';
      terminal={type:'error',reason,error:{role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        stopReason:reason,errorMessage:error instanceof Error?error.message:'CodeArts request failed',timestamp:Date.now()}};
    } finally {
      // Release before announcing completion, so the next agent turn cannot leak a busy slot.
      await release?.();
    }
    if(terminal)stream.push(terminal);
    stream.end();
  })();
  return stream;
}
export default async function(pi:ExtensionAPI,options:{agentDir?:string,configFile?:string}={}) {
  const agentDir=options.agentDir || getAgentDir(),path=options.configFile || configPath(agentDir);
  const states=new Map<string,{environment:ReturnType<typeof normalizeEnvironment>,models:any[],configure:()=>void}>();
  const addEnvironment=async(environment)=>{
    const id=providerId(environment);
    const state={environment,models:await loadCatalog(agentDir,environment),configure:()=>{}};
    state.configure=()=>pi.registerProvider(id,{
      name:environment.label,baseUrl:chatBaseUrl(environment),api:'codearts-chat',
      models:configuredModels(state.models),
      oauth:{name:environment.label,login:async callbacks=>{
        const auth=await login(callbacks,environment);
        const signal=callbacks.signal?AbortSignal.any([callbacks.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
        try {
          const effective=await resolveAuth(JSON.stringify(auth),signal,environment);
          const models=await discoverModels(effective,signal,environment);
          signal.throwIfAborted();await saveCatalog(agentDir,environment,models);state.models=models;
        } catch(e) {
          callbacks.signal?.throwIfAborted();
          callbacks.onProgress?.(`授权成功；模型目录暂未更新，请稍后 /codearts-refresh ${id}`);
        }
        return auth;
      },
        refreshToken:async(auth,signal)=>{
          assertEnvironment(auth,environment);
          if(auth.localReadOnly || auth.access===LOCAL) {
            const local=await resolveAuth(JSON.stringify(auth),signal,environment);
            return {...auth,expires:local.expires-60000};
          }
          return refreshAuth(auth,signal,fetch,environment);
        },getApiKey:auth=>JSON.stringify(auth)},
      streamSimple:(model,context,options)=>streamCodeArts(model,context,options,environment),
      refreshModels:async context=>{
        if(!context.allowNetwork || context.credential?.type!=='oauth')return configuredModels(state.models);
        const auth=await resolveAuth(JSON.stringify(context.credential),context.signal,environment);
        const models=await discoverModels(auth,context.signal,environment);
        context.signal.throwIfAborted();
        await saveCatalog(agentDir,environment,models);state.models=models;
        return configuredModels(models);
      }
    });
    states.set(id,state);state.configure();
  };
  // Keep the official account usable even if an optional custom environment file is malformed.
  await addEnvironment(OFFICIAL);
  try {for(const environment of await loadEnvironments(path))if(environment!==OFFICIAL)await addEnvironment(environment);}
  catch(e) {pi.on('session_start',async(_event,ctx)=>{if(ctx.hasUI)ctx.ui.notify(e instanceof Error?e.message:'Invalid CodeArts environment configuration','error');});}
  const shutdown=new AbortController();
  pi.on('session_start',async(_event,ctx)=>{
    if(!ctx.hasUI)return;
    // Background, credential-free cache checks; no factory-time network or timers.
    for(const state of states.values()) {
      if(!await isCatalogStale(agentDir,state.environment))continue;
      void (async()=>{
        const signal=AbortSignal.any([shutdown.signal,AbortSignal.timeout(30000)]);
        try {
          const resolved=await ctx.modelRegistry.getProviderAuth(providerId(state.environment));
          if(!resolved?.auth.apiKey)return;
          const auth=await resolveAuth(resolved.auth.apiKey,signal,state.environment);
          const models=await discoverModels(auth,signal,state.environment);
          signal.throwIfAborted();await saveCatalog(agentDir,state.environment,models);
          if(shutdown.signal.aborted)return;
          state.models=models;state.configure();
        } catch { /* Offline/expired sessions keep the last known catalog; explicit refresh reports errors. */ }
      })();
    }
  });
  pi.on('session_shutdown',async()=>{shutdown.abort();await sessionLeases.close();});
  const chooseState=(args,ctx)=>{
    const requested=args.trim();
    const id=requested?(states.has(requested)?requested:`codearts-${requested}`):(states.has(ctx.model?.provider)?ctx.model.provider:'codearts');
    const state=states.get(id);if(!state)throw new Error('Unknown CodeArts environment; use /codearts-environments');return state;
  };
  const reportError=(e,ctx)=>{if(ctx.hasUI)ctx.ui.notify(e instanceof Error?e.message:'CodeArts operation failed','error');else throw e;};
  pi.registerCommand('codearts-refresh',{
    description:'刷新模型与思考能力，可指定环境 provider id',
    handler:async(args,ctx)=>{
      try {
        const state=chooseState(args,ctx),environment=state.environment;
        const signal=AbortSignal.timeout(30000);
        const resolved=await ctx.modelRegistry.getProviderAuth(providerId(environment));
        const auth=await resolveAuth(resolved?.auth.apiKey,signal,environment);
        const models=await discoverModels(auth,signal,environment);
        await saveCatalog(agentDir,environment,models);state.models=models;state.configure();
        if(ctx.hasUI)ctx.ui.notify(`${environment.label}: 已刷新 ${models.length} 个模型及思考能力。用 /model 选择。`,'info');
      } catch(e){reportError(e,ctx);}
    }
  });
  pi.registerCommand('codearts-status',{
    description:'显示环境、授权来源、续期能力和思考等级，不输出凭据',
    handler:async(args,ctx)=>{
      try {
        const {environment,models}=chooseState(args,ctx);
        const resolved=await ctx.modelRegistry.getProviderAuth(providerId(environment));
        const auth=await resolveAuth(resolved?.auth.apiKey,AbortSignal.timeout(5000),environment);
        const thinking=models.filter(m=>m.reasoning).map(m=>`${m.id}: ${Object.entries(m.thinkingLevelMap || {}).filter(([,v])=>v!==null).map(([k])=>k).join('/')}`);
        if(ctx.hasUI)ctx.ui.notify(`${environment.label} (${providerId(environment)})\n网关: ${environment.apiOrigin}\n${auth.localReadOnly?'本地只读登录（不自动刷新）':auth.refresh?'独立 OAuth（可自动续期）':'临时登录（不可续期）'}；到期 ${new Date(auth.expires).toLocaleString()}\n${models.length} 个模型\n思考等级: ${thinking.join('；') || '服务端未公布可选等级'}`,'info');
      } catch(e){reportError(e,ctx);}
    }
  });
  pi.registerCommand('codearts-environments',{
    description:'列出已配置的 CodeArts 环境，不发认证请求',
    handler:async(_args,ctx)=>{if(ctx.hasUI)ctx.ui.notify([...states.values()].map(({environment:e})=>`${providerId(e)} — ${e.label}\n  API: ${e.apiOrigin}\n  授权: ${e.authorizeUrl}\n  Token: ${e.tokenUrl}`).join('\n'),'info');}
  });
  pi.registerCommand('codearts-configure',{
    description:'确认导入本机环境或配置自定义环境（不复制凭据）',
    handler:async(args,ctx)=>{
      if(!ctx.hasUI)throw new Error('Interactive UI required; alternatively edit the personal codearts.json file');
      try {
        const detected=await detectClientEnvironments();
        let candidate;
        if(detected.length) {
          const choices=[...detected.map((c,i)=>`${i+1}. ${c.environment.apiOrigin} (${c.source})`),'手动配置'];
          const choice=await ctx.ui.select('检测到以下候选环境，尚未信任或发送凭据',choices);
          if(!choice)return;
          const index=choices.indexOf(choice);if(index<detected.length)candidate=detected[index].environment;
        }
        const ask=async(message,fallback='')=>{
          const value=await ctx.ui.input(message,fallback);
          if(value===undefined)throw new Error('CodeArts configuration cancelled');
          return value.trim() || fallback;
        };
        const id=args.trim() || await ask('环境 ID（小写英文、数字、短横线）',candidate?.id || 'company');
        const environment=normalizeEnvironment({...candidate,id,
          label:await ask('显示名称',candidate?.label || `CodeArts (${id})`),
          apiOrigin:await ask('可信推理网关 origin（HTTPS）',candidate?.apiOrigin || ''),
          authorizeUrl:await ask('官方/企业授权页面完整 URL',candidate?.authorizeUrl || ''),
          tokenUrl:await ask('可信 OAuth Token 服务完整 URL',candidate?.tokenUrl || ''),
          clientId:await ask('OAuth Client ID',candidate?.clientId || 'CodeArts_Tui')});
        if(!await ctx.ui.confirm('信任此环境？仅添加后独立授权，不迁移已有凭据',`API: ${environment.apiOrigin}\n授权: ${environment.authorizeUrl}\nToken: ${environment.tokenUrl}\nClient: ${environment.clientId}`))return;
        await saveEnvironment(path,environment);await addEnvironment(environment);
        ctx.ui.notify(`已添加 ${providerId(environment)}。请 /login 选择该环境独立授权，然后 /codearts-refresh ${providerId(environment)}。`,'info');
      } catch(e){reportError(e,ctx);}
    }
  });
}
