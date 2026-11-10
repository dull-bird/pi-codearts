// Test tooling only: use Pi's real credential lock/refresh path, never the CodeArts client's refresh token.
import extension from '../index.ts';
const base=import.meta.resolve('@earendil-works/pi-coding-agent');
const {ModelRuntime}=await import(new URL('./core/model-runtime.js',base).href);
export async function realRuntime(options={}) {
  const runtime=await ModelRuntime.create({modelsPath:null,refreshOnCreate:false,allowModelNetwork:false,...options});
  await extension({registerProvider:(id,config)=>runtime.registerProvider(id,config),registerCommand:()=>{},on:()=>{}});
  return runtime;
}
export async function realAuth(provider='codearts') {
  const runtime=await realRuntime();
  const resolved=await runtime.getAuth(provider,{signal:AbortSignal.timeout(30000)});
  if(!resolved?.auth.apiKey)throw new Error(`No Pi independent login. Use /login ${provider} first.`);
  const auth=JSON.parse(resolved.auth.apiKey);
  if(auth.localReadOnly || !auth.refresh)throw new Error('Live regression requires an independent, renewable Pi login');
  return auth;
}
