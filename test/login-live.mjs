import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realRuntime} from './real-auth.mjs';
import {verifyRealRefresh} from './refresh-live.mjs';
const {AuthStorage}=await import(new URL('./core/auth-storage.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
try {
  const storage=AuthStorage.create(),runtime=await realRuntime({credentials:storage});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('Browser authorization timed out')),120000);
  try {
    console.log('Opening independent browser authorization via Pi ModelRuntime (/login path). No credentials are printed.');
    const auth=await runtime.login('codearts','oauth',{
      signal:controller.signal,
      prompt:async()=>{throw new Error('Unexpected credential prompt');},
      notify:event=>{
        if(event.type==='auth_url') {
          const [command,args]=process.platform==='darwin'?['open',[event.url]]:process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',event.url]]:['xdg-open',[event.url]];
          promisify(execFile)(command,args).catch(()=>controller.abort(new Error('Could not open browser')));
        }
        // Deliberately do not print authorization URLs, callback codes or arbitrary event payloads.
      },
    });
    assert.ok(auth.type==='oauth'&&auth.refresh&&!auth.localReadOnly);
    assert.ok(runtime.getModels('codearts').length>0,'Models should be available immediately after native Pi login');
    console.log('PASS Pi native OAuth login + model discovery + durable credential persistence');
  }finally{clearTimeout(timer);}
  await verifyRealRefresh(storage);
} catch(error) {
  console.log(`LOGIN NOT COMPLETED: ${error instanceof Error?error.message:'authorization failed'}`);
  process.exitCode=1;
}
