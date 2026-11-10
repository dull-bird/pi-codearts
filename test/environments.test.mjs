import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OFFICIAL,normalizeEnvironment,providerId,fingerprint,bindEnvironment,assertEnvironment,loadEnvironments,saveEnvironment,detectClientEnvironments} from '../environments.mjs';
import {saveCatalog,loadCatalog} from '../catalog.mjs';
import {signedFetch,refreshAuth,newKeyPair,credentials,discoverModels,thinkingCapabilities,AGENT_ID} from '../core.mjs';
import {browserLogin,login} from '../login.mjs';
import {resolveAuth,signedTransport,streamCodeArts} from '../index.ts';
import {auth,model,context,collect,chunk,sse} from './helpers.mjs';
const custom=normalizeEnvironment({...OFFICIAL,id:'enterprise',apiOrigin:'https://gateway.example',authorizeUrl:'https://sso.example/authorize',tokenUrl:'https://identity.example/token',clientId:'enterprise-client',paths:{chat:'/v1/chat/completions',variants:null}});

for(const [label,patch] of [
 ['HTTP API',{apiOrigin:'http://gateway.example'}],['URL password',{tokenUrl:'https://name:password@identity.example/token'}],
 ['URL query',{authorizeUrl:'https://sso.example/authorize?token=secret'}],['origin path',{apiOrigin:'https://gateway.example/v1'}],
 ['route escape',{paths:{chat:'//attacker.example/chat/completions'}}],['route traversal',{paths:{detail:'/a/../b'}}],
 ['route query',{paths:{chat:'/v1/chat/completions?key=secret'}}],['invalid profile id',{id:'../../auth'}],
 ['unknown discovery',{discovery:'guess'}],['nonboolean opt in',{allowTemporaryLogin:'yes'}],
]) test(`reject unsafe environment: ${label}`,()=>assert.throws(()=>normalizeEnvironment({...custom,...patch})));

test('credentials are bound to one trusted environment; endpoint changes require reauthorization',()=>{
 const bound=bindEnvironment(auth,custom);assert.equal(providerId(custom),'codearts-enterprise');assertEnvironment(bound,custom);
 assert.throws(()=>assertEnvironment(bound,OFFICIAL),/elsewhere/);
 assert.throws(()=>assertEnvironment(auth,custom),/Unbound/);
 assert.throws(()=>assertEnvironment(bound,{...custom,tokenUrl:'https://other.example/token'}),/changed/);
 assert.doesNotThrow(()=>assertEnvironment(auth,OFFICIAL)); // Migration of the already-issued official login.
 assert.equal(fingerprint(custom),fingerprint({...custom,label:'Renamed',models:[{id:'new-model'}]}));
});
test('custom signed transport cannot receive an official credential or leak it through a redirect',async()=>{
 let calls=0;
 const backend=async()=>{calls++;return Response.json({});};
 await assert.rejects(signedFetch(`${custom.apiOrigin}/v1/models`,auth,{environment:custom,fetchImpl:backend}),/Unbound/);assert.equal(calls,0);
 const bound=bindEnvironment(auth,custom);
 await signedFetch(`${custom.apiOrigin}/v1/models`,bound,{environment:custom,fetchImpl:async(_url,init)=>{assert.equal(init.redirect,'error');return Response.json({});}});
 const transport=signedTransport(bound,backend,'session',custom);
 await assert.rejects(transport(`${OFFICIAL.apiOrigin}/api/v2/chat/completions`,{method:'POST',body:'{}'}),/outside/);assert.equal(calls,0);
});
test('a custom OAuth refresh stays at its own token endpoint with its own DPoP and Client ID',async()=>{
 const pair=await newKeyPair(),bound=bindEnvironment({...auth,access:JSON.stringify({...credentials(auth),dpop_key_pair:pair})},custom);
 const next=await refreshAuth(bound,undefined,async(url,init)=>{
  assert.equal(url,custom.tokenUrl);const body=new URLSearchParams(init.body);assert.equal(body.get('client_id'),custom.clientId);
  const proof=JSON.parse(Buffer.from(init.headers.DPoP.split('.')[1],'base64url'));assert.equal(proof.htu,custom.tokenUrl);
  return Response.json({credentials:{...credentials(auth),expiration:new Date(Date.now()+3600000).toISOString()}});
 },custom);
 assert.equal(next.refresh,auth.refresh);assert.deepEqual(next.environment,bound.environment);
});
test('profile persistence, isolated model caches, stale endpoint rejection and credential-free discovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codearts-profile-'));
 try {
  const file=join(dir,'codearts.json');assert.deepEqual(await loadEnvironments(file),[OFFICIAL]);
  await saveEnvironment(file,custom);assert.equal((await loadEnvironments(file))[1].id,'enterprise');
  await assert.rejects(saveEnvironment(file,OFFICIAL),/cannot be overwritten/);
  await saveCatalog(dir,OFFICIAL,[{id:'official-only'}]);await saveCatalog(dir,custom,[{id:'enterprise-only'}]);
  assert.equal((await loadCatalog(dir,custom))[0].id,'enterprise-only');assert.equal((await loadCatalog(dir,OFFICIAL))[0].id,'official-only');
  assert.deepEqual(await loadCatalog(dir,{...custom,apiOrigin:'https://changed.example'}),[]);
  const client=join(dir,'client.json');await writeFile(client,JSON.stringify({provider:{'inferhub-provider':{options:{inferhubBaseUrl:custom.apiOrigin,authorizeUrl:custom.authorizeUrl,tokenUrl:custom.tokenUrl,clientId:custom.clientId,apiKey:'DO_NOT_COPY'}}}}));
  const candidates=await detectClientEnvironments([client]);assert.equal(candidates.length,1);assert.equal(candidates[0].environment.apiOrigin,custom.apiOrigin);assert.ok(!JSON.stringify(candidates).includes('DO_NOT_COPY'));
  const persisted=await readFile(file,'utf8');assert.ok(!persisted.includes(auth.refresh));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('incomplete or malformed client metadata is not guessed or trusted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codearts-config-'));
 try {const file=join(dir,'client.json');await writeFile(file,JSON.stringify({provider:{'inferhub-provider':{options:{inferhubBaseUrl:'https://unknown.example'}}}}));assert.deepEqual(await detectClientEnvironments([file]),[]);
 await writeFile(file,JSON.stringify({version:1,environments:[{...custom,id:'official'}]}));await assert.rejects(loadEnvironments(file),/reserved/);
 await writeFile(file,JSON.stringify({version:1,official:{apiOrigin:'https://unknown.example'},environments:[]}));await assert.rejects(loadEnvironments(file),/separate environment/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('no implicit local login: missing auth and disabled legacy sentinel fail before reading client files',async()=>{
 await assert.rejects(resolveAuth(undefined),/尚未授权/);
 await assert.rejects(resolveAuth('codearts-local'),/未启用/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(login({signal:controller.signal,onSelect:()=>{throw new Error('must not offer a temporary login');}}));
});
test('OAuth callback rejects wrong state and closes the listener',async()=>{
 let port;
 await assert.rejects(browserLogin({onAuth:({url})=>{const u=new URL(url);port=u.searchParams.get('port');void fetch(`http://127.0.0.1:${port}/oauth/callback?code=wrong&state=wrong`);}},{timeoutMs:1000,environment:{...custom,stateMode:'required'}}),/state mismatch/);
 await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth/callback`));
});
test('OAuth denial returns a safe error, not the provider error description',async()=>{
 await assert.rejects(browserLogin({onAuth:({url})=>{const p=new URL(url).searchParams.get('port');void fetch(`http://127.0.0.1:${p}/oauth/callback?error=access_denied&error_description=SECRET`);}},{timeoutMs:1000}),{message:'CodeArts authorization was denied'});
});
test('temporary ticket login is rejected by default, rather than masquerading as durable login',async()=>{
 let calls=0;
 await assert.rejects(browserLogin({onAuth:({url})=>{const p=new URL(url).searchParams.get('port');void fetch(`http://127.0.0.1:${p}/oauth/callback?secret=legacy`);}},{timeoutMs:1000,fetchImpl:async()=>{calls++;}}),/Long-lived authorization is required/);assert.equal(calls,0);
});
test('authorization without Refresh Token is rejected before account discovery',async()=>{
 let calls=0;
 await assert.rejects(browserLogin({onAuth:({url})=>{const p=new URL(url).searchParams.get('port');void fetch(`http://127.0.0.1:${p}/oauth/callback?code=test`);}},{timeoutMs:1000,fetchImpl:async()=>{calls++;return Response.json({credentials:{...credentials(auth),expiration:new Date(Date.now()+3600000).toISOString()}});}}),/did not issue a Refresh Token/);assert.equal(calls,1);
});
test('custom browser OAuth uses configured endpoints, scope, PKCE method and binds resulting credential',async()=>{
 const environment={...custom,scope:'enterprise',pkceMethod:'S256',stateMode:'required'};
 const result=await browserLogin({onAuth:({url})=>{const u=new URL(url);assert.equal(u.origin,'https://sso.example');assert.equal(u.searchParams.get('scope'),'enterprise');assert.equal(u.searchParams.get('code_challenge_method'),'S256');void fetch(`http://127.0.0.1:${u.searchParams.get('port')}/oauth/callback?code=test&state=${u.searchParams.get('state')}`);}},{environment,timeoutMs:1000,fetchImpl:async(url)=>{
  if(url===custom.tokenUrl)return Response.json({credentials:{...credentials(auth),expiration:new Date(Date.now()+3600000).toISOString()},refresh_token:'custom-refresh'});
  assert.equal(url,custom.apiOrigin+custom.paths.account);return Response.json({user_id:'custom-user'});
 }});assertEnvironment(result,environment);assert.equal(result.refresh,'custom-refresh');
});
test('alternate entitled agents are discovered when the account has no hardcoded default agent',async()=>{
 const bound=bindEnvironment(auth,custom),calls=[];
 const models=await discoverModels(bound,undefined,custom,async(url)=>{
  calls.push(url);if(url.includes('useragents'))return Response.json({agents:[{agent_id:'tenant-agent'}]});
  return Response.json({gpts:{models:[{model_parameters:{model_id:'tenant-model',supports_images:true}}]}});
 });assert.equal(models[0].id,'tenant-model');assert.deepEqual(models[0].input,['text','image']);assert.equal(calls.length,2);
});
test('agent pagination and duplicate model IDs are handled without duplicate catalog entries',async()=>{
 const bound=bindEnvironment(auth,custom);let pages=0,details=0;
 const models=await discoverModels(bound,undefined,custom,async(url)=>{
  if(url.includes('useragents')){pages++;return Response.json(pages===1?{agents:Array.from({length:100},()=>({agent_id:'same-agent'})),total:101}:{agents:[{agent_id:'other-agent'}],total:101});}
  details++;return Response.json({gpts:{models:[{model_parameters:{model_id:'same-model'}}]}});
 });assert.equal(pages,2);assert.equal(details,2);assert.equal(models.length,1);
});
test('OpenAI model-directory and static-directory strategies are configurable without replacing OAuth',async()=>{
 const openai={...custom,discovery:'openai'};
 const models=await discoverModels(bindEnvironment(auth,openai),undefined,openai,async(url)=>{assert.equal(url,custom.apiOrigin+'/v1/models');return Response.json({data:[{id:'compatible-model',context_window:65536}]});});assert.equal(models[0].contextWindow,65536);
 const fixed={...custom,discovery:'static',models:[{id:'private-model',reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:null}}]};
 assert.equal((await discoverModels(bindEnvironment(auth,fixed),undefined,fixed,()=>{throw new Error('must not call network');}))[0].id,'private-model');
});
test('thinking strengths come from the server and restrict the Pi selector to real supported levels',async()=>{
 const {getSupportedThinkingLevels}=await import('@earendil-works/pi-ai/compat');
 const models=await discoverModels(auth,undefined,OFFICIAL,async(url,init)=>{
  if(url.includes('useragents'))return Response.json({agents:[{agent_id:AGENT_ID}]});
  if(url.includes('/detail'))return Response.json({gpts:{models:[{model_parameters:{model_id:'GLM-5.2',thinking_type:null}},{model_parameters:{model_id:'plain-model'}}]}});
  assert.equal(init.headers['Agent-Type'],'PromptCenter');assert.deepEqual(JSON.parse(init.body).model_names,['GLM-5.2','plain-model']);
  return Response.json({variants:{'GLM-5.2':{strengths:['high','max']},'plain-model':{strengths:[]}}});
 });assert.deepEqual(getSupportedThinkingLevels(models[0]),['high','max']);assert.deepEqual(getSupportedThinkingLevels(models[1]),['off']);
 assert.equal(thinkingCapabilities(['unknown']),undefined);
});
test('reasoning effort selection reaches the outgoing CodeArts payload',async()=>{
 const thinking={...model,reasoning:true,thinkingLevelMap:thinkingCapabilities(['high','max'])};
 for(const reasoning of ['high','max']) {
  let body;
  const out=await collect(streamCodeArts(thinking,context(),{apiKey:JSON.stringify(auth),reasoning,fetch:async(url,init)=>{
   if(new URL(url).pathname.endsWith('/heartbeat'))return Response.json({});
   body=JSON.parse(init.body);return sse([chunk({reasoning_content:'Reasoning.'}),chunk({content:'Answer.'},'stop')]);
  }}));
  assert.equal(out.result.stopReason,'stop');assert.equal(body.reasoning_effort,reasoning);assert.deepEqual(body.thinking,{type:'enabled'});
 }
});
