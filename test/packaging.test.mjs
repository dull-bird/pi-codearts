import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OFFICIAL} from '../environments.mjs';
import {saveCatalog} from '../catalog.mjs';
import {auth} from './helpers.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));

test('published tarball has no credentials/development links and installs into a clean Pi home',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codearts-package-'));
 try {
  const [pack]=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--pack-destination',dir],{cwd:root,encoding:'utf8'}));
  const files=pack.files.map(f=>f.path);
  for(const file of ['index.ts','core.mjs','environments.mjs','catalog.mjs','login.mjs','sessions.mjs','LICENSE'])assert.ok(files.includes(file));
  assert.ok(!files.some(f=>/node_modules|auth\.json|research\/|test\/|\.log$|^\.env$/.test(f)));
  execFileSync('tar',['-xzf',join(dir,pack.filename),'-C',dir]);
  const pkg=JSON.parse(await readFile(join(dir,'package/package.json'),'utf8'));
  assert.deepEqual(pkg.pi.extensions,['./index.ts']);assert.equal(pkg.private,undefined);assert.equal(pkg.peerDependencies['@earendil-works/pi-ai'],'*');assert.equal(pkg.dependencies,undefined);
  const agentDir=join(dir,'agent');await mkdir(agentDir,{recursive:true});
  const config=join(agentDir,'codearts.json');await writeFile(config,JSON.stringify({version:1,environments:[]}));
  // A deliberately unreadable-as-JSON client login proves normal startup does not depend on it.
  const client=join(dir,'.codeartsdoer/cli-data');await mkdir(client,{recursive:true});await writeFile(join(client,'auth.json'),'not valid client auth');
  await saveCatalog(agentDir,OFFICIAL,[{id:'offline-package-model'}]);
  const env={...process.env,HOME:dir,PI_CODING_AGENT_DIR:agentDir,PI_CODEARTS_CONFIG:config};
  execFileSync('pi',['install',join(dir,'package')],{env,cwd:dir,encoding:'utf8',timeout:30000});
  const withoutLogin=execFileSync('pi',['--list-models','codearts'],{env,cwd:dir,encoding:'utf8',timeout:30000});
  assert.match(withoutLogin,/No models available/);
  // Only synthetic auth, no network: list-models intentionally filters unauthenticated providers.
  await writeFile(join(agentDir,'auth.json'),JSON.stringify({codearts:auth}),{mode:0o600});
  const output=execFileSync('pi',['--list-models','codearts'],{env,cwd:dir,encoding:'utf8',timeout:30000});
  assert.match(output,/offline-package-model/);
  const settings=JSON.parse(await readFile(join(agentDir,'settings.json'),'utf8'));assert.ok(settings.packages.length>0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
