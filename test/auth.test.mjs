import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createCipheriv,randomBytes,scryptSync,webcrypto} from 'node:crypto';
import {sign,readLocalAuth,credentials,signedFetch,discoverModels,newKeyPair,dpop,refreshAuth,TOKEN_URL,BASE,AGENT_ID} from '../core.mjs';
import {browserLogin,login} from '../login.mjs';
import {auth} from './helpers.mjs';
import {OFFICIAL} from '../environments.mjs';

test('HMAC signing is deterministic and changes with request body/date/query',()=>{
 const c=credentials(auth),date=new Date('2026-01-02T03:04:05Z');
 const x=sign(`${BASE}/a?b=2&a=1`,'POST','{}',c,{},date);
 assert.equal(x['X-Sdk-Date'],'20260102T030405Z');assert.match(x.Authorization,/SignedHeaders=content-type;host;x-sdk-date;x-security-token/);
 assert.equal(x.Authorization,sign(`${BASE}/a?a=1&b=2`,'POST','{}',c,{},date).Authorization);
 assert.notEqual(x.Authorization,sign(`${BASE}/a?a=1&b=2`,'POST','{"x":1}',c,{},date).Authorization);
 assert.throws(()=>sign('http://example.com/a','GET','',c),/HTTPS/);
});
test('encrypted local credential import is read-only and supports CodeArts AES/scrypt layout',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-codearts-'));
 try {
 const reference=randomBytes(16).toString('base64'),a=randomBytes(32),b=randomBytes(32),salt=randomBytes(16).toString('base64');
 const key=scryptSync(Buffer.from(a.map((x,i)=>x^b[i])),salt,32),work=randomBytes(32);
 function enc(text,key){const iv=randomBytes(16),cipher=createCipheriv('aes-256-gcm',key,iv);const ct=cipher.update(text,'utf8','hex')+cipher.final('hex');return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ct}`;}
 const mappings={'mapper/config.txt':salt,'icons/base.svg':a.toString('base64'),'mock-tools/get-message.js':b.toString('base64'),'request-utils/base.js':enc(work.toString('base64'),key),'images/config-base.png':enc(auth.access,work)};
 // Access and refresh use different encrypted references in production.
 const ref2=randomBytes(16).toString('base64');
 for(const [path,value] of Object.entries(mappings)){
  await mkdir(dirname(join(dir,path)),{recursive:true});
  const mapping={[reference]:value,[ref2]:path==='images/config-base.png'?enc(auth.refresh,work):value};
  await writeFile(join(dir,path),Buffer.from(JSON.stringify(mapping)).toString('base64'));
 }
 const file=JSON.stringify({'inferhub-provider':{...auth,access:reference,refresh:ref2}});
 await writeFile(join(dir,'auth.json'),file);
 const imported=await readLocalAuth(dir);assert.equal(imported.access,auth.access);assert.equal(imported.refresh,auth.refresh);assert.equal(imported.localReadOnly,true);
 const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(dir,'auth.json'),'utf8'),file);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('DPoP JWT has valid ES256 signature, endpoint/method binding, and unique jti',async()=>{
 const pair=await newKeyPair();const token=await dpop(pair,'POST',TOKEN_URL);const [h,p,s]=token.split('.');
 const header=JSON.parse(Buffer.from(h,'base64url')),payload=JSON.parse(Buffer.from(p,'base64url'));
 assert.equal(header.typ,'dpop+jwt');assert.equal(payload.htm,'POST');assert.equal(payload.htu,TOKEN_URL);
 const key=await webcrypto.subtle.importKey('jwk',header.jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 assert.equal(await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(s,'base64url'),Buffer.from(`${h}.${p}`)),true);
 assert.notEqual(token,await dpop(pair,'POST',TOKEN_URL));
});
test('refresh uses refresh_token + DPoP and preserves keypair/account',async()=>{
 const pair=await newKeyPair();let request;
 const original={...auth,access:JSON.stringify({...credentials(auth),dpop_key_pair:pair}),accountId:'account'};
 const next=await refreshAuth(original,AbortSignal.timeout(1000),async(url,init)=>{
 request={url,init};return Response.json({credentials:{access_key_id:'new-ak',secret_access_key:'new-sk',security_token:'new-token',expiration:new Date(Date.now()+3600000).toISOString()},refresh_token:'rotated-refresh'});
 });
 assert.equal(request.url,TOKEN_URL);const body=new URLSearchParams(request.init.body);assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),auth.refresh);assert.ok(request.init.headers.DPoP);assert.equal(next.refresh,'rotated-refresh');assert.equal(next.accountId,'account');assert.deepEqual(credentials(next).dpop_key_pair,pair);assert.equal(request.init.redirect,'error');
});
test('revoked refresh and invalid response do not log or expose credential payloads',async()=>{
 const pair=await newKeyPair();const a={...auth,access:JSON.stringify({...credentials(auth),dpop_key_pair:pair})};
 await assert.rejects(refreshAuth(a,undefined,async()=>Response.json({secret:'NEVER_LOG'},{status:401})),{message:'CodeArts authorization: HTTP 401'});
 await assert.rejects(refreshAuth(a,undefined,async()=>Response.json({credentials:{}})),/Invalid CodeArts token response/);
});
test('model discovery accepts direct payload and Axios-style wrapped payload',async()=>{
 const orig=globalThis.fetch;
 try {
 for(const wrap of [false,true]){
 let call=0;globalThis.fetch=async()=>{
 call++;const data=call===1?{agents:[{agent_id:AGENT_ID}]}:{gpts:{models:[{model_name:'Visible model',model_parameters:{model_id:'model-a',context_window:131072,max_tokens:8192}}]}};
 return Response.json(wrap?{data}:data);
 };
 const models=await discoverModels(auth,AbortSignal.timeout(1000));assert.equal(models[0].id,'model-a');assert.equal(models[0].contextWindow,131072);assert.equal(call,3);
 }
 }finally{globalThis.fetch=orig;}
});
test('signed requests reject foreign origin without invoking fetch',async()=>{
 let called=false;
 await assert.rejects(signedFetch('https://example.com/',auth,{fetchImpl:async()=>{called=true;}}),/untrusted origin/);assert.equal(called,false);
});
test('browser OAuth callback, PKCE, token exchange and current-account lookup',async()=>{
 let tokenRequest,accountRequest;
 const result=await browserLogin({onAuth:({url})=>{
 const u=new URL(url);assert.equal(u.searchParams.get('code_challenge_method'),'SHA-256');assert.equal(u.searchParams.get('client_id'),'CodeArts_Tui');
 void fetch(`http://127.0.0.1:${u.searchParams.get('port')}/oauth/callback?code=mock-code`);
 }},{timeoutMs:2000,fetchImpl:async(url,init)=>{
 if(url===TOKEN_URL){tokenRequest=init;return Response.json({credentials:{...credentials(auth),expiration:new Date(Date.now()+3600000).toISOString()},refresh_token:'independent-refresh'});}
 accountRequest={url,init};return Response.json({user_id:'test-user',domain_id:'test-domain'});
 }});
 assert.equal(result.refresh,'independent-refresh');assert.equal(result.localReadOnly,undefined);assert.ok(credentials(result).dpop_key_pair);assert.deepEqual(JSON.parse(result.accountId),{user_id:'test-user',domain_id:'test-domain'});
 const params=new URLSearchParams(tokenRequest.body);assert.equal(params.get('code'),'mock-code');assert.equal(params.get('grant_type'),'authorization_code');assert.match(params.get('redirect_uri'),/^http:\/\/127.0.0.1:\d+\/oauth\/callback$/);assert.ok(accountRequest.init.headers.Authorization);
});
test('browser login cancellation closes callback listener',async()=>{
 const controller=new AbortController();let port;
 await assert.rejects(browserLogin({signal:controller.signal,onAuth:({url})=>{port=new URL(url).searchParams.get('port');controller.abort();}},{timeoutMs:2000}));
 await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth/callback?code=anything`));
});
test('browser login timeout closes callback listener',async()=>{
 let port;
 await assert.rejects(browserLogin({onAuth:({url})=>{port=new URL(url).searchParams.get('port');}},{timeoutMs:50}));
 await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth/callback`));
});
test('cancelled login selection does not silently import local credentials',async()=>{
 await assert.rejects(login({onSelect:async()=>undefined},{...OFFICIAL,allowLocalLogin:true}),/cancelled/);
});
