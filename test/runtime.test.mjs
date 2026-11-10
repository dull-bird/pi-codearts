import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../index.ts';
import {newKeyPair,credentials,TOKEN_URL} from '../core.mjs';
import {auth} from './helpers.mjs';
const base=import.meta.resolve('@earendil-works/pi-coding-agent');
const {ModelRuntime}=await import(new URL('./core/model-runtime.js',base).href);
const {AuthStorage}=await import(new URL('./core/auth-storage.js',base).href);

test('Pi runtime automatically refreshes expired OAuth once under concurrent requests and persists rotated token',async()=>{
 const pair=await newKeyPair();
 const storage=AuthStorage.inMemory({codearts:{...auth,expires:1,access:JSON.stringify({...credentials(auth),dpop_key_pair:pair})}});
 const runtime=await ModelRuntime.create({credentials:storage,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
 let config;await extension({registerProvider:(_id,c)=>{config=c;},registerCommand:()=>{},on:()=>{}});
 const original=globalThis.fetch;let refreshes=0;
 try {
 globalThis.fetch=async(url,init)=>{
  assert.equal(url,TOKEN_URL);assert.equal(new URLSearchParams(init.body).get('grant_type'),'refresh_token');refreshes++;
  return Response.json({credentials:{access_key_id:'renewed-ak',secret_access_key:'renewed-sk',security_token:'renewed-token',expiration:new Date(Date.now()+3600000).toISOString()},refresh_token:'rotated-refresh'});
 };
 runtime.registerProvider('codearts',config);
 const resolved=await Promise.all(Array.from({length:5},()=>runtime.getAuth('codearts')));
 assert.equal(refreshes,1);
 for(const result of resolved)assert.equal(JSON.parse(result.auth.apiKey).refresh,'rotated-refresh');
 const saved=await storage.read('codearts');assert.equal(saved.refresh,'rotated-refresh');assert.ok(saved.expires>Date.now());assert.equal(credentials(saved).access_key_id,'renewed-ak');
 }finally{globalThis.fetch=original;}
});

test('offline model initialization never performs network I/O',async()=>{
 let config;await extension({registerProvider:(_id,c)=>{config=c;},registerCommand:()=>{},on:()=>{}});
 const result=await config.refreshModels({allowNetwork:false,signal:AbortSignal.timeout(1000)});
 assert.ok(Array.isArray(result));
 for(const m of result)assert.equal(m.compat.maxTokensField,'max_tokens');
});
