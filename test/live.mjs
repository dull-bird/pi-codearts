import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai/compat';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { realAuth } from './real-auth.mjs';
import { redPng } from './image.mjs';
import { discoverModels,DATA_DIR } from '../core.mjs';
import { streamCodeArts } from '../index.ts';
import { collect,tool } from './helpers.mjs';
const originalHash=await readFile(join(DATA_DIR,'auth.json')).then(b=>createHash('sha256').update(b).digest('hex')).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
const auth=await realAuth();
const key=JSON.stringify(auth);
console.log('Authentication mode: Pi independent renewable OAuth');
const catalog=await discoverModels(auth,AbortSignal.timeout(30000));
console.log(`PASS direct authentication and model discovery: ${catalog.length} models`);
const chosen=catalog.find(m=>m.id===(process.env.CODEARTS_TEST_MODEL || 'glm-5.3-flash')) || catalog[0];
const model={...chosen,api:'codearts-chat',provider:'codearts',baseUrl:'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2',compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens'}};
console.log(`Testing model: ${model.id}`);
const heartbeatResponses=[];
const monitoredFetch=async(url,init)=>{
 const response=await fetch(url,init);
 if(new URL(String(url)).pathname.endsWith('/heartbeat'))heartbeatResponses.push({status:response.status,state:new URL(String(url)).searchParams.get('status')});
 return response;
};
const options={apiKey:key,sessionId:randomUUID(),fetch:monitoredFetch,maxTokens:256,maxRetries:0,signal:AbortSignal.timeout(60000)};
const first=await collect(streamCodeArts(model,normalizeContext({systemPrompt:'Be concise.',messages:[{role:'user',content:'用中文问好，并提到 Pi。只输出一句话。',timestamp:Date.now()}]}),options));
assert.equal(first.result.stopReason,'stop',first.result.errorMessage || `Unexpected stop reason: ${first.result.stopReason}`);assert.ok(first.result.content.some(c=>c.type==='text'&&c.text.length>0));assert.ok(first.result.usage.totalTokens>0);assert.ok(first.events.some(e=>e.type==='text_delta'));
console.log('PASS Unicode text + SSE + usage:',first.result.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
const messages=[{role:'user',content:'Call lookup with name="pi-codearts-test". Do not answer until you get the result.',timestamp:Date.now()}];
const call=await collect(streamCodeArts(model,normalizeContext({systemPrompt:'Use the provided lookup tool when asked.',tools:[tool],messages}),{...options,maxTokens:512,signal:AbortSignal.timeout(60000)}));
assert.equal(call.result.stopReason,'toolUse',call.result.errorMessage || `Unexpected stop reason: ${call.result.stopReason}`);const tc=call.result.content.find(c=>c.type==='toolCall');assert.ok(tc);assert.equal(tc.name,'lookup');assert.equal(tc.arguments.name,'pi-codearts-test');
console.log('PASS real streaming tool call and parsed arguments');
messages.push(call.result,{role:'toolResult',toolCallId:tc.id,toolName:tc.name,content:[{type:'text',text:'Lookup result: verification-code=7319. Tell the user the verification code.'}],isError:false,timestamp:Date.now()});
const reply=await collect(streamCodeArts(model,normalizeContext({systemPrompt:'Answer with the verification code from the lookup result.',tools:[tool],messages}),{...options,signal:AbortSignal.timeout(60000)}));
assert.equal(reply.result.stopReason,'stop',reply.result.errorMessage || `Unexpected stop reason: ${reply.result.stopReason}`);assert.match(reply.result.content.filter(c=>c.type==='text').map(c=>c.text).join(''),/7319/);
console.log('PASS tool-result follow-up');
const controller=new AbortController();let abortedOnDelta=false;
const stream=streamCodeArts(model,normalizeContext({messages:[{role:'user',content:'Count from 1 to 1000, one number per line.',timestamp:Date.now()}]}),{...options,maxTokens:1024,signal:controller.signal});
for await(const event of stream)if((event.type==='text_delta'||event.type==='thinking_delta')&&!abortedOnDelta){abortedOnDelta=true;controller.abort();}
const aborted=await stream.result();assert.ok(abortedOnDelta,`No streamed content received: ${aborted.errorMessage || aborted.stopReason}`);assert.equal(aborted.stopReason,'aborted');
console.log('PASS real in-flight cancellation');
const vision=catalog.find(m=>m.input.includes('image'));
if(vision) {
 const visionModel={...model,...vision};
 const image={type:'image',mimeType:'image/png',data:redPng()};
 const imageContext={messages:[{role:'user',content:[{type:'text',text:'What is the dominant color of this image? Answer with only the color name.'},image],timestamp:Date.now()}]};
 const direct=await collect(streamCodeArts(visionModel,normalizeContext(imageContext),{...options,maxTokens:256,signal:AbortSignal.timeout(60000)}));
 assert.equal(direct.result.stopReason,'stop',direct.result.errorMessage || `Unexpected stop reason: ${direct.result.stopReason}`);
 assert.match(direct.result.content.filter(c=>c.type==='text').map(c=>c.text).join(''),/red|红/i);
 console.log('PASS real image input (generated red PNG)');
 const prior={...direct.result,content:[{type:'toolCall',id:'image-test-call',name:'lookup',arguments:{name:'color'}}],stopReason:'toolUse'};
 const imageToolContext={tools:[tool],messages:[{role:'user',content:'Use the lookup result image to identify its dominant color. Answer only the color.',timestamp:Date.now()},prior,{role:'toolResult',toolCallId:'image-test-call',toolName:'lookup',content:[{type:'text',text:'The generated test image:'},image],isError:false,timestamp:Date.now()}]};
 const imageReply=await collect(streamCodeArts(visionModel,normalizeContext(imageToolContext),{...options,maxTokens:256,signal:AbortSignal.timeout(60000)}));
 assert.equal(imageReply.result.stopReason,'stop',imageReply.result.errorMessage || `Unexpected stop reason: ${imageReply.result.stopReason}`);
 assert.match(imageReply.result.content.filter(c=>c.type==='text').map(c=>c.text).join(''),/red|红/i);
 console.log('PASS real image tool-result replay');
}
const reasoningModel=catalog.find(m=>m.id==='GLM-5.2'&&m.reasoning) || catalog.find(m=>m.reasoning);
if(reasoningModel) {
 const supported=getSupportedThinkingLevels(reasoningModel).filter(level=>level!=='off');
 for(const level of [...new Set([supported[0],supported.at(-1)])]) {
  let outgoingEffort;
  const result=await collect(streamCodeArts({...model,...reasoningModel},normalizeContext({messages:[{role:'user',content:'Compute 13 times 17. Give only the final number.',timestamp:Date.now()}]}),{...options,reasoning:level,maxTokens:2048,signal:AbortSignal.timeout(90000),onPayload:payload=>{outgoingEffort=payload.reasoning_effort;}}));
  assert.equal(outgoingEffort,reasoningModel.thinkingLevelMap[level]);
  assert.equal(result.result.stopReason,'stop',result.result.errorMessage || `Unexpected stop reason: ${result.result.stopReason}`);
  assert.match(result.result.content.filter(c=>c.type==='text').map(c=>c.text).join(''),/221/);
  assert.ok(result.events.some(e=>e.type==='thinking_delta'),'Expected real streamed reasoning');
  console.log(`PASS real thinking strength ${reasoningModel.id}/${level} → ${outgoingEffort}`);
 }
}
assert.ok(heartbeatResponses.length>=8);assert.ok(heartbeatResponses.every(r=>r.status===200));assert.equal(heartbeatResponses.at(-1).state,'idle');
console.log('PASS signed busy/idle heartbeats (HTTP 200) and session release');
if(originalHash) {
 assert.equal(createHash('sha256').update(await readFile(join(DATA_DIR,'auth.json'))).digest('hex'),originalHash,'Original credentials changed during testing');
 console.log('PASS original CodeArts credential file unchanged');
}
