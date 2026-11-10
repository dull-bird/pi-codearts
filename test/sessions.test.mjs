import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {SessionLeases} from '../sessions.mjs';
import {auth} from './helpers.mjs';

test('shared session keeps busy until last concurrent request ends',async()=>{
 const manager=new SessionLeases(),statuses=[];
 const backend=async(url,init)=>{statuses.push(new URL(url).searchParams.get('status'));assert.equal(init.body,'{}');assert.equal(init.headers['user-session-id'],'same-session');return Response.json({});};
 const release1=await manager.acquire('same-session',auth,backend);
 const release2=await manager.acquire('same-session',auth,backend);
 await release1();assert.deepEqual(statuses,['busy']);
 await release2();assert.deepEqual(statuses,['busy','idle']);assert.equal(manager.entries.size,0);
 await release2();assert.equal(statuses.length,2);
});
test('new request waits for draining idle, then re-establishes busy',async()=>{
 const manager=new SessionLeases(),statuses=[];
 const backend=async(url,init)=>{const status=new URL(url).searchParams.get('status');statuses.push(status);if(status==='idle')await delay(15);return Response.json({});};
 const release1=await manager.acquire('session',auth,backend);
 const draining=release1();
 const release2=await manager.acquire('session',auth,backend);
 await draining;assert.deepEqual(statuses,['busy','idle','busy']);
 await release2();assert.deepEqual(statuses,['busy','idle','busy','idle']);assert.equal(manager.entries.size,0);
});
test('periodic heartbeat is stopped and idle follows all pending busy requests',async()=>{
 const manager=new SessionLeases({intervalMs:5}),statuses=[];
 const backend=async(url,init)=>{statuses.push(new URL(url).searchParams.get('status'));return Response.json({});};
 const release=await manager.acquire('long-request',auth,backend);await delay(18);await release();
 assert.ok(statuses.filter(s=>s==='busy').length>1);assert.equal(statuses.at(-1),'idle');
 const length=statuses.length;await delay(15);assert.equal(statuses.length,length);assert.equal(manager.entries.size,0);
});
test('pre-aborted acquisition makes no network call and leaves no timer',async()=>{
 const manager=new SessionLeases();const signal=AbortSignal.abort();
 await assert.rejects(manager.acquire('aborted',auth,async()=>{throw new Error('must not call');},signal));assert.equal(manager.entries.size,0);
});
test('heartbeat failure is best effort and shutdown closes owned sessions only',async()=>{
 const manager=new SessionLeases();let calls=0;
 const release=await manager.acquire('owned-session',auth,async()=>{calls++;throw new Error('offline');});
 await manager.close();assert.equal(manager.entries.size,0);assert.equal(calls,2);await release();
});
