import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {browserLogin} from '../login.mjs';
import {credentials,checkedJson,TOKEN_URL} from '../core.mjs';
import {OFFICIAL,normalizeEnvironment} from '../environments.mjs';
import {auth} from './helpers.mjs';

test('official server-managed callback state does not break PKCE-bound login',async()=>{
 let challenge;
 const result=await browserLogin({onAuth:({url})=>{
  const u=new URL(url);assert.equal(u.searchParams.has('state'),false);challenge=u.searchParams.get('code_challenge');
  void fetch(`http://127.0.0.1:${u.searchParams.get('port')}/oauth/callback?code=test-code&state=server-managed-state`).catch(()=>{});
 }},{timeoutMs:1000,fetchImpl:async(url,init)=>{
  if(url===TOKEN_URL){assert.equal(createHash('sha256').update(new URLSearchParams(init.body).get('code_verifier')).digest('base64url'),challenge);return Response.json({credentials:{...credentials(auth),expiration:new Date(Date.now()+3600000).toISOString()},refresh_token:'durable-refresh'});}
  return Response.json({user_id:'test-user'});
 }});assert.equal(result.refresh,'durable-refresh');
});
test('strict state mode rejects a missing state rather than silently falling back to PKCE mode',async()=>{
 const environment=normalizeEnvironment({...OFFICIAL,id:'strict',stateMode:'required'});let called=false;
 await assert.rejects(browserLogin({onAuth:({url})=>{
  const u=new URL(url);assert.ok(u.searchParams.get('state'));void fetch(`http://127.0.0.1:${u.searchParams.get('port')}/oauth/callback?code=missing-state`).catch(()=>{});
 }},{timeoutMs:1000,environment,fetchImpl:()=>{called=true;throw Error('must not exchange');}}),/state mismatch/);assert.equal(called,false);
});
test('malformed auth JSON does not echo response/credential secrets in diagnostics',async()=>{
 await assert.rejects(checkedJson(new Response('SECRET_RESPONSE-not-json'),'CodeArts authorization'),{message:'CodeArts authorization: invalid JSON response'});
 assert.throws(()=>credentials({access:'SECRET_CREDENTIAL-not-json'}),{message:'Invalid CodeArts credentials'});
 assert.throws(()=>credentials({access:'null'}),{message:'Invalid CodeArts credentials'});
});
