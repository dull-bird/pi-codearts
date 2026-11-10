import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import extension from '../index.ts';
import {auth} from './helpers.mjs';
import {credentials,TOKEN_URL,AGENT_ID} from '../core.mjs';
import {OFFICIAL,normalizeEnvironment,bindEnvironment} from '../environments.mjs';
import {isCatalogStale,saveCatalog} from '../catalog.mjs';
const base=import.meta.resolve('@earendil-works/pi-coding-agent');
const {ModelRuntime}=await import(new URL('./core/model-runtime.js',base).href);
const {AuthStorage}=await import(new URL('./core/auth-storage.js',base).href);

for(const durable of [true,false])test(`native Pi login ${durable?'publishes models and durable OAuth':'failure preserves the previous credential'}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codearts-login-')),originalFetch=globalThis.fetch;
 const storage=AuthStorage.inMemory({codearts:auth});
 try {
  const runtime=await ModelRuntime.create({credentials:storage,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  await extension({registerProvider:(id,c)=>runtime.registerProvider(id,c),registerCommand:()=>{},on:()=>{}},{agentDir:dir,configFile:join(dir,'codearts.json')});
  globalThis.fetch=async(url)=>{
   if(String(url).startsWith('http://127.0.0.1'))return originalFetch(url);
   if(url===TOKEN_URL)return Response.json({credentials:{...credentials(auth),expiration:new Date(Date.now()+3600000).toISOString()},...(durable?{refresh_token:'independent-refresh'}:{})});
   if(url.includes('/current/user'))return Response.json({user_id:'synthetic-user'});
   if(url.includes('useragents'))return Response.json({agents:[{agent_id:AGENT_ID}]});
   if(url.includes('/detail'))return Response.json({gpts:{models:[{model_parameters:{model_id:'native-discovered-model'}}]}});
   return Response.json({variants:{}});
  };
  const interaction={signal:AbortSignal.timeout(3000),prompt:async()=>{throw Error('No credential prompt expected');},notify:event=>{
   if(event.type==='auth_url'){const u=new URL(event.url);void originalFetch(`http://127.0.0.1:${u.searchParams.get('port')}/oauth/callback?code=native&state=${u.searchParams.get('state')}`).catch(()=>{});}
  }};
  if(durable) {
   const result=await runtime.login('codearts','oauth',interaction);
   assert.equal(result.refresh,'independent-refresh');assert.equal((await storage.read('codearts')).refresh,'independent-refresh');
   assert.equal(runtime.getModels('codearts')[0].id,'native-discovered-model');assert.ok(result.environment.fingerprint);
   assert.equal(await isCatalogStale(dir,OFFICIAL),false);
  } else {
   await assert.rejects(runtime.login('codearts','oauth',interaction),/Refresh Token/);
   assert.deepEqual(await storage.read('codearts'),auth);
  }
 }finally{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});

test('malformed custom configuration cannot remove the existing official provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codearts-bad-config-'));
 try {
  await writeFile(join(dir,'codearts.json'),'{bad json');const providers=[];
  await extension({registerProvider:id=>providers.push(id),registerCommand:()=>{},on:()=>{}},{agentDir:dir,configFile:join(dir,'codearts.json')});
  assert.deepEqual(providers,['codearts']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('separate provider IDs resolve separate stored credentials without local fallback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codearts-isolation-'));
 try {
  const env=normalizeEnvironment({...OFFICIAL,id:'company',apiOrigin:'https://company.example',authorizeUrl:'https://company.example/authorize',tokenUrl:'https://company.example/token'});
  await writeFile(join(dir,'codearts.json'),JSON.stringify({version:1,environments:[env]}));
  const other=bindEnvironment({...auth,refresh:'company-refresh'},env);
  const runtime=await ModelRuntime.create({credentials:AuthStorage.inMemory({codearts:auth,'codearts-company':other}),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  await extension({registerProvider:(id,c)=>runtime.registerProvider(id,c),registerCommand:()=>{},on:()=>{}},{agentDir:dir,configFile:join(dir,'codearts.json')});
  assert.equal(JSON.parse((await runtime.getAuth('codearts-company')).auth.apiKey).refresh,'company-refresh');
  assert.equal(JSON.parse((await runtime.getAuth('codearts')).auth.apiKey).refresh,auth.refresh);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('catalog freshness has an offline-safe bounded TTL',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codearts-ttl-'));
 try {assert.equal(await isCatalogStale(dir),true);await saveCatalog(dir,OFFICIAL,[{id:'model'}]);assert.equal(await isCatalogStale(dir),false);assert.equal(await isCatalogStale(dir,OFFICIAL,0),true);}
 finally{await rm(dir,{recursive:true,force:true});}
});
