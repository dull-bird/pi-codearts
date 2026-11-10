import test from 'node:test';
import assert from 'node:assert/strict';
import {streamCodeArts,signedTransport} from '../index.ts';
import {BASE} from '../core.mjs';
import {auth,model,context,tool,chunk,usage,sse,collect} from './helpers.mjs';
const run=(events,options={},ctx=context(),responseOptions={})=>{
 const backend=options.fetch || (async()=>sse(events,responseOptions));
 return collect(streamCodeArts(model,ctx,{apiKey:JSON.stringify(auth),maxRetries:0,...options,
 fetch:async(url,init)=>new URL(String(url)).pathname.endsWith('/heartbeat')?Response.json({status:'ok'}):backend(url,init)}));
};

test('Unicode byte boundaries, balanced text events, usage, and one terminal event',async()=>{
 const {events,result}=await run([chunk({content:'你好🌍'}),chunk({},'stop'),usage],{},context(),{split:true});
 assert.equal(result.stopReason,'stop');assert.equal(result.content[0].text,'你好🌍');
 assert.equal(result.api,'codearts-chat');assert.equal(result.provider,'codearts');
 assert.equal(result.usage.input+result.usage.cacheRead,12);assert.equal(result.usage.output,3);assert.equal(result.usage.totalTokens,15);
 assert.deepEqual(events.filter(e=>['text_start','text_end'].includes(e.type)).map(e=>e.type),['text_start','text_end']);
 assert.equal(events.filter(e=>e.type==='start').length,1);assert.equal(events.filter(e=>['done','error'].includes(e.type)).length,1);
});
test('empty successful response is terminal and balanced',async()=>{
 const {events,result}=await run([chunk({},'stop'),usage]);assert.equal(result.stopReason,'stop');assert.deepEqual(result.content,[]);assert.equal(events.at(-1).type,'done');
});
test('tool call argument fragments are parsed and emitted in balanced events',async()=>{
 const {events,result}=await run([
 chunk({tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'lookup',arguments:'{"name":'}}]}),
 chunk({tool_calls:[{index:0,function:{arguments:'"中文"}'}}]}),chunk({},'tool_calls'),usage
 ],{},context('Look up 中文',{tools:[tool]}));
 assert.equal(result.stopReason,'toolUse');assert.deepEqual(result.content[0].arguments,{name:'中文'});
 assert.deepEqual(events.filter(e=>['toolcall_start','toolcall_end'].includes(e.type)).map(e=>e.type),['toolcall_start','toolcall_end']);
});
test('tool-result replay and foreign-provider history retain usable tool declarations',async()=>{
 const foreign={role:'assistant',api:'anthropic-messages',provider:'anthropic',model:'other',timestamp:1,content:[{type:'toolCall',id:'foreign|call:123',name:'lookup',arguments:{name:'中文'}}],stopReason:'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 let body;
 const ctx=context('test',{tools:[tool],messages:[{role:'user',content:'lookup',timestamp:0},foreign,{role:'toolResult',toolCallId:'foreign|call:123',toolName:'lookup',content:[{type:'text',text:'FOUND'}],isError:false,timestamp:2}]});
 const {result}=await run([chunk({content:'ok'}),chunk({},'stop')],{onPayload:p=>{body=p;}},ctx);
 assert.equal(result.stopReason,'stop');assert.equal(body.tools[0].function.name,'lookup');assert.ok(body.messages.some(m=>m.role==='tool'&&m.content==='FOUND'));
 const call=body.messages.find(m=>m.tool_calls)?.tool_calls[0];assert.equal(body.messages.find(m=>m.role==='tool').tool_call_id,call.id);
});
test('payload replacement, response, and provider-event instrumentation are preserved',async()=>{
 const calls=[];let actual;
 const {result}=await run([],{onPayload:(p,m)=>{calls.push('payload');return {...p,temperature:0.2};},
 onResponse:r=>{calls.push(`response:${r.status}`);},onProviderStreamEvent:()=>{calls.push('provider');},
 fetch:async(_url,init)=>{actual=JSON.parse(init.body);return sse([chunk({content:'x'}),chunk({},'stop'),usage]);}});
 assert.equal(result.stopReason,'stop');assert.equal(actual.temperature,0.2);assert.equal(actual.max_tokens,4096);assert.equal(actual.max_completion_tokens,undefined);assert.equal(actual.tool_stream,true);assert.equal(calls[0],'payload');assert.equal(calls[1],'response:200');assert.equal(calls.filter(c=>c==='provider').length,3);
});
test('signing replaces dummy bearer, keeps custom headers, enforces endpoint and redirects',async()=>{
 let seen;
 const transport=signedTransport(auth,async(url,init)=>{seen={url,init};return sse([]);});
 await transport(`${BASE}/api/v2/chat/completions`,{method:'POST',headers:{Authorization:'Bearer NEVER_SEND','x-test':'yes'},body:'{}'});
 assert.match(seen.init.headers.get('authorization'),/^SDK-HMAC-SHA256 /);assert.equal(seen.init.headers.get('x-test'),'yes');assert.equal(seen.init.redirect,'error');assert.equal(seen.init.headers.get('x-security-token'),'test-security-token');
 await assert.rejects(transport('https://example.com/api/v2/chat/completions',{method:'POST',body:'{}'}),/Refusing/);
 await assert.rejects(transport(`${BASE}/not-chat`,{method:'POST',body:'{}'}),/Refusing/);
});
test('pre-cancelled request makes no HTTP call',async()=>{
 let count=0;const controller=new AbortController();controller.abort();
 const {result,events}=await run([],{signal:controller.signal,fetch:async()=>{count++;return sse([]);}});
 assert.equal(count,0);assert.equal(result.stopReason,'aborted');assert.equal(events.at(-1).type,'error');
});
test('cancellation during setup returns aborted and stops fetch',async()=>{
 const controller=new AbortController();
 const promise=run([],{signal:controller.signal,fetch:async(_u,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});controller.abort();})});
 const {result}=await promise;assert.equal(result.stopReason,'aborted');assert.ok(result.errorMessage);
});
test('truncated SSE without finish reason is an error, not false success',async()=>{
 const {result,events}=await run([chunk({content:'partial'})],{},context(),{done:false});assert.equal(result.stopReason,'error');assert.ok(result.errorMessage);assert.equal(events.at(-1).type,'error');
});
test('malformed provider JSON terminates as error',async()=>{
 const {result}=await run([],{fetch:async()=>new Response('data: not-json\n\n',{headers:{'Content-Type':'text/event-stream'}})});assert.equal(result.stopReason,'error');
});
test('context overflow and rate limits remain distinguishable',async()=>{
 for(const [status,message] of [[400,'context_length_exceeded'],[429,'Rate limit exceeded']]){
 const {result}=await run([],{fetch:async()=>Response.json({error:{message,type:'invalid_request_error',code:status===400?'context_length_exceeded':'rate_limit_exceeded'}},{status})});
 assert.equal(result.stopReason,'error');assert.match(result.errorMessage,status===400?/context_length_exceeded/:/Rate limit/);
 }
});
test('HTTP-200 gateway error frame is surfaced with the actual error',async()=>{
 const {result}=await run([{text:'[DONE]',error_code:'InferHub.001001005.400',error_msg:'Invalid parameter'}]);
 assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/InferHub\.001001005\.400.*Invalid parameter/);
});
test('missing/expired independent credentials fail before network access',async()=>{
 const {result}=await run([],{apiKey:JSON.stringify({...auth,expires:1})});assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/过期/);
});
