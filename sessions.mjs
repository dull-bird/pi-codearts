import {signedFetch,credentials} from './core.mjs';
import {OFFICIAL,fingerprint} from './environments.mjs';
import {createHash} from 'node:crypto';
// These are provider-owned request leases, not persistent/background resources at extension load.
// A shared Pi session can have multiple simultaneous model requests: only the last one reports idle.
export class SessionLeases {
  constructor({intervalMs=30000,timeoutMs=3000}={}) {
    this.entries=new Map();this.intervalMs=intervalMs;this.timeoutMs=timeoutMs;
  }
  async acquire(id,auth,fetchImpl=fetch,signal,environment=OFFICIAL) {
    signal?.throwIfAborted();
    if(!environment.paths.heartbeat)return async()=>{};
    const account=createHash('sha256').update(auth.accountId || credentials(auth).access_key_id).digest('hex');
    const key=`${fingerprint(environment)}:${account}:${id}`;
    let entry=this.entries.get(key);
    if(entry?.closing) {await entry.closing;return this.acquire(id,auth,fetchImpl,signal,environment);}
    if(entry) {entry.count++;return this.releaseFor(key,entry);}
    entry={count:1,auth,fetchImpl,pending:Promise.resolve(),timer:undefined};
    this.entries.set(key,entry);
    const send=status=>{
      entry.pending=entry.pending.then(async()=>{
        try {
          const response=await signedFetch(`${environment.apiOrigin}${environment.paths.heartbeat}?status=${status}`,entry.auth,
            {method:'PUT',body:'{}',headers:{'user-session-id':id},signal:AbortSignal.timeout(this.timeoutMs),fetchImpl:entry.fetchImpl,environment});
          await response.body?.cancel();
        } catch { /* Best effort: never replace an inference result with a heartbeat failure. */ }
      });
      return entry.pending;
    };
    entry.send=send;
    await send('busy');
    if(this.entries.get(key)===entry) {
      entry.timer=setInterval(()=>{void send('busy');},this.intervalMs);
      entry.timer.unref?.();
    }
    return this.releaseFor(key,entry);
  }
  releaseFor(id,entry) {
    let released=false;
    return async()=>{
      if(released)return;released=true;
      if(--entry.count>0)return;
      clearInterval(entry.timer);
      // Keep the entry until idle has completed, so a concurrent acquire can share it.
      entry.closing=entry.send('idle');
      await entry.closing;
      if(entry.count===0&&this.entries.get(id)===entry)this.entries.delete(id);
    };
  }
  async close() {
    const entries=[...this.entries.entries()];
    await Promise.all(entries.map(async([id,e])=>{clearInterval(e.timer);await e.send('idle');if(this.entries.get(id)===e)this.entries.delete(id);}));
  }
}
export const sessionLeases=new SessionLeases();
