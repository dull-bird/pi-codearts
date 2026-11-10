import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {refreshAuth,discoverModels,credentials} from '../core.mjs';
const {AuthStorage}=await import(new URL('./core/auth-storage.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
export async function verifyRealRefresh(storage=AuthStorage.create()) {
  // Read and rotate only the Pi-owned credential, inside Pi's cross-process credential lock.
  const auth=await storage.modify('codearts',async current=>{
    assert.ok(current?.type==='oauth'&&!current.localReadOnly&&current.refresh&&credentials(current).dpop_key_pair,'Independent renewable login required');
    return refreshAuth(current,AbortSignal.timeout(30000));
  });
  assert.ok(auth.expires>Date.now());
  const models=await discoverModels(auth,AbortSignal.timeout(30000));
  console.log(`PASS real DPoP refresh under Pi credential lock + authenticated discovery (${models.length} models)`);
  const helper=new URL('./real-auth.mjs',import.meta.url).href,core=new URL('../core.mjs',import.meta.url).href;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {realAuth} from ${JSON.stringify(helper)};import {discoverModels} from ${JSON.stringify(core)};const a=await realAuth();const m=await discoverModels(a,AbortSignal.timeout(30000));if(!m.length)throw Error('empty catalog');console.log('PASS fresh Node/Pi runtime loads persisted refreshed credentials and authenticates');`],{timeout:45000});
  console.log(stdout.trim());
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await verifyRealRefresh();
