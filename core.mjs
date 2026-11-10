import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, createDecipheriv, scryptSync, randomBytes, webcrypto } from 'node:crypto';

import {OFFICIAL, DEFAULT_AGENT_ID, assertEnvironment, bindEnvironment, validateModels, providerId} from './environments.mjs';
export const BASE = OFFICIAL.apiOrigin;
export const PORTAL = OFFICIAL.authorizeUrl.replace(/\/authorize$/, '');
export const TOKEN_URL = OFFICIAL.tokenUrl;
export const CLIENT_ID = OFFICIAL.clientId;
export const AGENT_ID = DEFAULT_AGENT_ID;
export const DATA_DIR = join(homedir(), '.codeartsdoer/cli-data');
const hash = s => createHash('sha256').update(s).digest('hex');
const escape = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function sign(url, method, body, credentials, extra = {}, now = new Date()) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1') throw new Error('CodeArts requires HTTPS');
  const headers = { 'Content-Type': 'application/json', ...extra, Host: u.host,
    'X-Sdk-Date': now.toISOString().replace(/[-:]|\.\d{3}/g, ''),
    'X-Security-Token': credentials.security_token };
  const entries = Object.entries(headers).filter(([,v]) => v !== undefined && v !== null)
    .map(([k,v]) => [k.toLowerCase(), String(v).trim()]).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  const names = entries.map(([k])=>k).join(';');
  let path = u.pathname.split('/').map(s=>escape(decodeURIComponent(s))).join('/');
  if (!path.endsWith('/')) path += '/';
  const query = [...u.searchParams].sort(([a,av],[b,bv])=>a===b ? av.localeCompare(bv) : a.localeCompare(b)).map(([k,v])=>`${escape(k)}=${escape(v)}`).join('&');
  const canonical = [method.toUpperCase(), path, query, entries.map(([k,v])=>`${k}:${v}\n`).join(''), names, headers['X-Sdk-Content-Sha256'] || hash(body || '')].join('\n');
  const signature = createHmac('sha256', credentials.secret_access_key).update(['SDK-HMAC-SHA256', headers['X-Sdk-Date'], hash(canonical)].join('\n')).digest('hex');
  headers.Authorization = `SDK-HMAC-SHA256 Access=${credentials.access_key_id}, SignedHeaders=${names}, Signature=${signature}`;
  return headers;
}
function decryptData(value, key) {
  const [iv,tag,ciphertext,...rest] = value.split(':');
  if (rest.length || !iv || !tag || ciphertext === undefined) throw new Error('Invalid encrypted credential');
  const cipher = createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));
  cipher.setAuthTag(Buffer.from(tag,'hex'));
  return cipher.update(ciphertext,'hex','utf8') + cipher.final('utf8');
}
export async function decryptLocal(reference, dir = DATA_DIR) {
  const get = async path => JSON.parse(Buffer.from(await readFile(join(dir,path),'utf8'),'base64').toString('utf8'))[reference];
  const [salt,a,b,work,ciphertext] = await Promise.all(['mapper/config.txt','icons/base.svg','mock-tools/get-message.js','request-utils/base.js','images/config-base.png'].map(get));
  if (![salt,a,b,work,ciphertext].every(v=>typeof v==='string')) throw new Error('CodeArts credential storage is incomplete');
  const ab=Buffer.from(a,'base64'),bb=Buffer.from(b,'base64');
  const derived=scryptSync(Buffer.from(ab.map((v,i)=>v^bb[i])),salt,32);
  return decryptData(ciphertext,Buffer.from(decryptData(work,derived),'base64'));
}
export async function readLocalAuth(dir = DATA_DIR) {
  const auth=JSON.parse(await readFile(join(dir,'auth.json'),'utf8'))['inferhub-provider'];
  if (auth?.type!=='oauth') throw new Error('No CodeArts login found; run /login codearts');
  const access=auth.access.startsWith('{')?auth.access:await decryptLocal(auth.access,dir);
  return {...auth,access,refresh:auth.access.startsWith('{')?auth.refresh:await decryptLocal(auth.refresh,dir),localReadOnly:true};
}
export function credentials(auth) {
  let c;
  try {c=JSON.parse(auth.access);} catch {throw new Error('Invalid CodeArts credentials');}
  if (!['access_key_id','secret_access_key','security_token'].every(k=>typeof c?.[k]==='string'&&c[k].length>0)) throw new Error('Invalid CodeArts credentials');
  return c;
}
export async function signedFetch(url, auth, {method='GET',body,headers={},signal,fetchImpl=fetch,environment=OFFICIAL}={}) {
  signal?.throwIfAborted();
  assertEnvironment(auth,environment);
  if (new URL(url).origin!==environment.apiOrigin) throw new Error('Refusing to send CodeArts credentials to an untrusted origin');
  return fetchImpl(url,{method,body,headers:sign(url,method,body,credentials(auth),headers),signal,redirect:'error'});
}
export async function checkedJson(response, label) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${label}: HTTP ${response.status}`); }
  try {return await response.json();} catch {throw new Error(`${label}: invalid JSON response`);}
}
export function thinkingCapabilities(strengths) {
  if (!Array.isArray(strengths)) return undefined;
  const levels=['off','minimal','low','medium','high','xhigh','max'];
  const map=Object.fromEntries(levels.map(level=>[level,null]));
  for (const raw of strengths) {
    const level=raw==='none'?'off':raw;
    if (levels.includes(level)) map[level]=raw;
  }
  return Object.values(map).some(v=>v!==null) ? map : undefined;
}
export async function discoverModels(auth,signal,environment=OFFICIAL,fetchImpl=fetch) {
  assertEnvironment(auth,environment);
  if(environment.discovery==='static') {
    if(!environment.models.length)throw new Error('Static discovery requires configured models');
    return validateModels(environment.models);
  }
  const request=(path,options={})=>signedFetch(environment.apiOrigin+path,auth,{signal,fetchImpl,environment,...options});
  let models=[],variantKeys=new Map();
  if(environment.discovery==='openai') {
    const response=await checkedJson(await request(environment.paths.models),'Model discovery');
    models=validateModels((response.data || response.models || []).map(m=>({id:m.id,name:m.name,contextWindow:m.context_window,maxTokens:m.max_tokens,reasoning:false})));
  } else {
    const headers={'Agent-Type':'AgentCenter','X-Language':'zh-cn'};
    const agents=[];
    for(let offset=0;offset<1000;offset+=100) {
      const list=await checkedJson(await request(`${environment.paths.agents}?offset=${offset}&limit=100`,{headers}),'Model discovery');
      const payload=list.data || list, page=payload.agents || [];
      if(!Array.isArray(page))throw new Error('Invalid CodeArts agent directory');
      agents.push(...page);
      if(page.length<100 || (Number.isFinite(payload.total) && agents.length>=payload.total))break;
    }
    const requested=environment.agentId;
    const preferred=agents.find(a=>a.original_id===(requested || AGENT_ID) || a.agent_id===(requested || AGENT_ID));
    if(requested&&!preferred)throw new Error('Configured CodeArts agent is not available to this account');
    // Preserve the verified default; other tenants may expose a different set of entitled agents.
    const candidates=requested?[preferred]:preferred?[preferred,...agents.filter(a=>a!==preferred)]:agents;
    const seen=new Set();
    for(const agent of candidates) {
      if(!agent.agent_id || seen.has(agent.agent_id))continue;
      seen.add(agent.agent_id);
      const response=await request(`${environment.paths.detail}?agent_id=${encodeURIComponent(agent.agent_id)}`,{headers});
      if(!requested&&[403,404].includes(response.status)){await response.body?.cancel();continue;}
      const detail=await checkedJson(response,'Model details');
      const available=(detail.data || detail).gpts?.models || [];
      if(!Array.isArray(available))throw new Error('Invalid CodeArts model directory');
      for(const m of available) {
        const p=m.model_parameters;
        if(!p?.model_id)continue;
        variantKeys.set(p.model_id,m.model_type==='third'?p.third_party_model || p.model_id:p.model_id);
        models.push(...validateModels([{id:p.model_id,name:m.model_name,input:p.supports_images?['text','image']:['text'],contextWindow:p.context_window,maxTokens:p.max_tokens,reasoning:false}]));
      }
      if(preferred&&!requested&&models.length)break;
    }
  }
  models=[...new Map(models.map(m=>[m.id,m])).values()];
  if(!models.length)throw new Error('CodeArts returned no accessible models; check account entitlement or configure an agent/discovery strategy');
  // Thinking strengths are advertised by a separate API, not by thinking_type alone.
  if(environment.paths.variants) {
    try {
      const variants={};
      const names=[...new Set(models.map(m=>variantKeys.get(m.id)||m.id))];
      for(let i=0;i<names.length;i+=50) {
        const response=await request(environment.paths.variants,{method:'POST',body:JSON.stringify({model_names:names.slice(i,i+50)}),headers:{'Agent-Type':'PromptCenter','X-Language':'zh-cn'}});
        if(!response.ok){await response.body?.cancel();break;}
        const data=await response.json();Object.assign(variants,(data.data || data).variants || {});
      }
      models=models.map(m=>{
        const map=thinkingCapabilities(variants[variantKeys.get(m.id)||m.id]?.strengths);
        return map?{...m,reasoning:true,thinkingLevelMap:map}:m;
      });
    } catch(e) { if(signal?.aborted)throw e; /* Older deployments may omit this optional capability API. */ }
  }
  // Explicit per-environment metadata overrides for deployments with incomplete directories.
  const overrides=new Map(environment.models.map(m=>[m.id,m]));
  return models.map(m=>overrides.has(m.id)?{...m,...overrides.get(m.id)}:m);
}
export async function dpop(keyPair,method,url,now=Date.now()) {
  const header=Buffer.from(JSON.stringify({alg:'ES256',typ:'dpop+jwt',jwk:keyPair.publicKeyJwk})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({htm:method,htu:url,iat:Math.floor(now/1000),jti:randomBytes(16).toString('hex')})).toString('base64url');
  const key=await webcrypto.subtle.importKey('jwk',keyPair.privateKeyJwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const sig=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(sig).toString('base64url')}`;
}
export async function newKeyPair() {
  const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  return {privateKeyJwk:await webcrypto.subtle.exportKey('jwk',keys.privateKey),publicKeyJwk:await webcrypto.subtle.exportKey('jwk',keys.publicKey)};
}
export async function tokenRequest(params,keyPair,signal,accountId,fetchImpl=fetch,environment=OFFICIAL) {
  signal?.throwIfAborted();
  const response=await fetchImpl(environment.tokenUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json',DPoP:await dpop(keyPair,'POST',environment.tokenUrl),...(accountId?{'x-agent-user-account':accountId}:{})},body:new URLSearchParams({client_id:environment.clientId,...params}).toString(),signal,redirect:'error'});
  const data=await checkedJson(response,'CodeArts authorization');
  const c=data.credentials;
  if (!c?.access_key_id || !c?.secret_access_key || !c?.security_token || !Number.isFinite(Date.parse(c.expiration))) throw new Error('Invalid CodeArts token response');
  return bindEnvironment({type:'oauth',access:JSON.stringify({...c,dpop_key_pair:keyPair}),refresh:data.refresh_token || '',expires:Date.parse(c.expiration)-60000,accountId,enterpriseUrl:environment.id==='official'?'prod':environment.id},environment);
}
export async function refreshAuth(auth,signal,fetchImpl=fetch,environment=OFFICIAL) {
  assertEnvironment(auth,environment);
  if (auth.localReadOnly) {
    if(!environment.allowLocalLogin)throw new Error('Read-only local login is disabled; use independent browser authorization');
    const latest=await readLocalAuth(environment.localAuthDir);
    if (latest.expires<=Date.now()+60000) throw new Error('Existing CodeArts login expired. Use /login codearts for an independent Pi login.');
    return bindEnvironment(latest,environment);
  }
  const pair=credentials(auth).dpop_key_pair;
  if (!auth.refresh || !pair) throw new Error(`CodeArts login cannot refresh; use /login ${providerId(environment)}`);
  const updated=await tokenRequest({grant_type:'refresh_token',refresh_token:auth.refresh},pair,signal,auth.accountId,fetchImpl,environment);
  return {...updated,refresh:updated.refresh || auth.refresh};
}
