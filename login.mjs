import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readLocalAuth,newKeyPair,tokenRequest,signedFetch,checkedJson } from './core.mjs';
import { OFFICIAL,bindEnvironment } from './environments.mjs';

export async function accountFor(auth,signal,fetchImpl=fetch,environment=OFFICIAL) {
  if(!environment.paths.account)return undefined;
  const account=await checkedJson(await signedFetch(`${environment.apiOrigin}${environment.paths.account}`,auth,{signal,fetchImpl,environment}),'CodeArts account');
  return JSON.stringify(account);
}
export async function browserLogin(callbacks, {fetchImpl=fetch,timeoutMs=300000,environment=OFFICIAL}={}) {
  const signal=callbacks.signal ? AbortSignal.any([callbacks.signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const application=callbacks.applicationName==='OMP'?'OMP':'Pi';
  signal.throwIfAborted();
  const verifier=randomBytes(64).toString('hex'),ticket=randomBytes(32).toString('hex'),state=randomBytes(32).toString('hex');
  const pair=await newKeyPair();
  let resolveCode,rejectCode,claimed=false;
  const pending=new Promise((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
  // Attach a rejection handler immediately, even if a UI callback throws before awaiting pending.
  pending.catch(()=>{});
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method!=='GET'||url.pathname!=='/oauth/callback'){res.writeHead(404).end();return;}
    if(url.searchParams.has('error')){res.writeHead(400).end('Authorization denied');rejectCode(new Error('CodeArts authorization was denied'));return;}
    if(environment.stateMode==='required'&&url.searchParams.get('state')!==state){res.writeHead(400).end('Invalid state');rejectCode(new Error('CodeArts OAuth state mismatch'));return;}
    const code=url.searchParams.get('code'),secret=url.searchParams.get('secret');
    if(!code&&!secret){res.writeHead(200).end('CodeArts Pi login is waiting.');return;}
    if(claimed){res.writeHead(409).end('Callback already received.');return;}
    claimed=true;res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end(`授权已收到，请返回 ${application}。Authorization received. Return to ${application}.`);
    resolveCode({code,secret});
  });
  const onAbort=()=>rejectCode(signal.reason || new Error('Login cancelled'));
  signal.addEventListener('abort',onAbort,{once:true});
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    server.on('error',rejectCode);
    signal.throwIfAborted();
    const port=server.address().port,redirect=`http://127.0.0.1:${port}/oauth/callback`;
    const params=new URLSearchParams({locale:'zh-cn',client_id:environment.clientId,port:String(port),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:environment.pkceMethod,ticket_id:ticket,...(environment.stateMode==='required'?{state}:{}),...(environment.scope?{scope:environment.scope}:{})});
    callbacks.onAuth({url:`${environment.authorizeUrl}?${params}`,instructions:`在浏览器完成 CodeArts 登录，授权后自动返回 ${application}（5 分钟超时）。`});
    const result=await pending;
    let auth;
    if(result.code) auth=await tokenRequest({grant_type:'authorization_code',code:result.code,code_verifier:verifier,redirect_uri:redirect},pair,signal,undefined,fetchImpl,environment);
    else {
      // Never silently downgrade durable OAuth to an expiring, non-refreshable ticket.
      if(!environment.allowTemporaryLogin)throw new Error('This deployment returned temporary ticket login without refresh support. Long-lived authorization is required; temporary mode must be explicitly enabled.');
      callbacks.onProgress?.('警告：此环境仅返回临时登录，不能自动续期。');
      for(let i=0;i<10;i++) {
        await delay(1000,undefined,{signal});
        const query=new URLSearchParams({ticket_id:ticket,secret:result.secret});
        const response=await fetchImpl(`${environment.apiOrigin}/snap-manager/v1/login/ticket?${query}`,{signal,redirect:'error',headers:{Accept:'application/json'}});
        if(!response.ok){await response.body?.cancel();continue;}
        const data=await response.json(),c=data.credential;
        if(!c?.access||!c?.secret||!c?.securitytoken||!Number.isFinite(Date.parse(c.expires_at))) throw new Error('Invalid CodeArts ticket response');
        auth={type:'oauth',access:JSON.stringify({access_key_id:c.access,secret_access_key:c.secret,security_token:c.securitytoken,expiration:c.expires_at}),refresh:'',expires:Date.parse(c.expires_at)-60000,enterpriseUrl:'prod'};break;
      }
      if(!auth)throw new Error('CodeArts ticket exchange failed');
    }
    if(!auth.refresh&&!environment.allowTemporaryLogin)throw new Error('CodeArts authorization did not issue a Refresh Token; no durable login was saved');
    auth=bindEnvironment(auth,environment);
    auth.accountId=await accountFor(auth,signal,fetchImpl,environment);
    return auth;
  } finally {
    signal.removeEventListener('abort',onAbort);
    server.closeAllConnections();
    if(server.listening) await new Promise(resolve=>server.close(resolve));
  }
}
export async function login(callbacks,environment=OFFICIAL) {
  if(!environment.allowLocalLogin)return browserLogin(callbacks,{environment});
  const choice=await callbacks.onSelect({message:'CodeArts 登录方式',options:[
    {id:'browser',label:'浏览器登录（独立凭据，推荐）'},
    {id:'local',label:'使用现有 CodeArts 登录（只读，不刷新原客户端凭据）'}]});
  callbacks.signal?.throwIfAborted();
  if(choice==='browser')return browserLogin(callbacks,{environment});
  if(choice==='local') {
    const auth=await readLocalAuth(environment.localAuthDir);
    if(environment.id!=='official'&&![environment.id,environment.apiOrigin].includes(auth.enterpriseUrl))throw new Error('Local client credential is not explicitly bound to this environment; use browser authorization');
    if(auth.expires<=Date.now()+60000)throw new Error('CodeArts 本地登录已过期，请选择浏览器登录');
    // Store only a marker in Pi, not a duplicate of the original client's rotating credentials.
    return bindEnvironment({type:'oauth',access:'codearts-local',refresh:'',expires:auth.expires-60000,localReadOnly:true},environment);
  }
  throw new Error('CodeArts login cancelled');
}
