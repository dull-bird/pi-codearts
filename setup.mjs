// Optional local-development installer. Published users should use `pi install git:...`.
import {mkdir,readFile,symlink,realpath,lstat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {discoverModels} from './core.mjs';
import {OFFICIAL} from './environments.mjs';
import {saveCatalog} from './catalog.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const agentDir=getAgentDir(),extension=join(agentDir,'extensions/codearts');
await mkdir(dirname(extension),{recursive:true});
try {
  await lstat(extension);
  if(await realpath(extension)!==await realpath(root))throw new Error(`Another extension already exists at ${extension}; not overwriting it.`);
} catch(error) {if(error.code==='ENOENT')await symlink(root,extension,'dir');else throw error;}
console.log(`Installed development link: ${extension}`);
let auth;
try {auth=JSON.parse(await readFile(join(agentDir,'auth.json'),'utf8')).codearts;}
catch(e) {if(e.code!=='ENOENT')throw e;}
if(auth?.type==='oauth'&&!auth.localReadOnly&&auth.expires>Date.now()+60000) {
  const models=await discoverModels(auth,AbortSignal.timeout(30000));
  await saveCatalog(agentDir,OFFICIAL,models);
  console.log(`Updated ${models.length} models and advertised thinking levels using Pi's independent credential.`);
}
console.log('In Pi: /reload. First use: /login → CodeArts, then /model. No CodeArts CLI or original credential refresh is used.');
