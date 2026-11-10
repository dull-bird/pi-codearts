import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),dir=await mkdtemp(join(tmpdir(),'pi-codearts-e2e-'));
try {
 const fixture=join(dir,'fixture.txt');await writeFile(fixture,'PI_CODEARTS_E2E_7319\n');
 const extension=fileURLToPath(new URL('../index.ts',import.meta.url));
 const args=['--no-session','--no-approve','--no-context-files','--no-skills','--no-prompt-templates','--no-themes','--no-extensions','-e',extension,
 '--model','codearts/glm-5.3-flash','--tools','read','--system-prompt',
 'This is an integration test. You must use the read tool exactly once to read the single file specified by the user. Do not read other files. Return the file content verbatim after reading it.',
 '--mode','json','--print',`Read ${fixture} using the read tool. Return its content.`];
 const running=exec('pi',args,{cwd:dir,timeout:150000,maxBuffer:2000000});
 running.child.stdin.end();
 const {stdout,stderr}=await running;
 const events=stdout.trim().split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
 assert.ok(events.some(e=>e.type==='tool_execution_end'&&e.toolName==='read'&&!e.isError),'No successful read-tool execution in Pi agent loop');
 const messages=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant');
 const final=messages.at(-1)?.message;
 assert.equal(final?.stopReason,'stop',final?.errorMessage || 'Pi did not return a normal final answer');assert.match(final.content.filter(c=>c.type==='text').map(c=>c.text).join(''),/PI_CODEARTS_E2E_7319/);
 assert.equal(final.provider,'codearts');assert.equal(final.api,'codearts-chat');
 console.log('PASS Pi CLI → provider → CodeArts → real read tool → tool result → final answer');
 if(stderr.trim())console.log('Pi emitted diagnostic stderr (not model payloads).');
}finally{await rm(dir,{recursive:true,force:true});}
