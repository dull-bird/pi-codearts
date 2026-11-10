import { normalizeContext } from '@earendil-works/pi-ai/compat';
export const auth={type:'oauth',access:JSON.stringify({access_key_id:'test-ak',secret_access_key:'test-sk',security_token:'test-security-token'}),refresh:'test-refresh',expires:Date.now()+3600000};
export const model={id:'test-model',name:'Test',api:'codearts-chat',provider:'codearts',baseUrl:'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096,compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens'}};
export const tool={name:'lookup',description:'Look up an item',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']}};
export const context=(text='你好',extra={})=>normalizeContext({systemPrompt:'You are a helpful assistant.',messages:[{role:'user',content:text,timestamp:Date.now()}],...extra});
export const chunk=(delta,finish_reason)=>({id:'test-id',object:'chat.completion.chunk',created:1,model:model.id,choices:[{index:0,delta,...(finish_reason?{finish_reason}:{})}]});
export const usage={id:'test-id',object:'chat.completion.chunk',created:1,model:model.id,choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15,prompt_tokens_details:{cached_tokens:4}}};
export function sse(events,{done=true,split=false}={}) {
 const text=events.map(e=>`data:${JSON.stringify(e)}\n\n`).join('')+(done?'data:[DONE]\n\n':'');
 const bytes=new TextEncoder().encode(text);
 return new Response(new ReadableStream({start(c){if(split)for(const b of bytes)c.enqueue(Uint8Array.of(b));else c.enqueue(bytes);c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
}
export async function collect(stream) {const events=[];for await(const e of stream)events.push(structuredClone(e));return {events,result:await stream.result()};}
