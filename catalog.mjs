import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {OFFICIAL,fingerprint,validateModels} from './environments.mjs';
export function catalogPath(agentDir,environment=OFFICIAL) {
  return join(agentDir,environment.id==='official'?'codearts-models.json':`codearts-models-${environment.id}.json`);
}
export async function loadCatalog(agentDir,environment=OFFICIAL) {
  try {
    const data=JSON.parse(await readFile(catalogPath(agentDir,environment),'utf8'));
    if(Array.isArray(data)&&environment.id==='official')return validateModels(data);
    if(data.version===1&&data.fingerprint===fingerprint(environment))return validateModels(data.models);
  } catch { /* A missing/stale cache is not an authentication failure. */ }
  return environment.models;
}
export async function isCatalogStale(agentDir,environment=OFFICIAL,maxAgeMs=6*60*60*1000) {
  try {
    const data=JSON.parse(await readFile(catalogPath(agentDir,environment),'utf8'));
    const time=Date.parse(data.fetchedAt);
    return data.fingerprint!==fingerprint(environment) || !Number.isFinite(time) || time>Date.now() || Date.now()-time>=maxAgeMs;
  } catch {return true;}
}
export async function saveCatalog(agentDir,environment,models) {
  await mkdir(agentDir,{recursive:true});
  const path=catalogPath(agentDir,environment),tmp=`${path}.${randomUUID()}.tmp`;
  await writeFile(tmp,JSON.stringify({version:1,fingerprint:fingerprint(environment),fetchedAt:new Date().toISOString(),models:validateModels(models)},null,2)+'\n',{mode:0o600});
  await rename(tmp,path);
}
