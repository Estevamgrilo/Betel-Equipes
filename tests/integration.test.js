import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const project=resolve(import.meta.dirname,'..');
async function start(dir,port){
 const child=spawn(process.execPath,[join(dir,'server.js')],{cwd:dir,env:{...process.env,PORT:String(port),BETEL_SETUP_KEY:'test-only-setup-key',DATABASE_URL:'',NODE_ENV:'test'},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error('Servidor encerrou inesperadamente');try{const r=await fetch(base+'/');if(r.ok)return {child,base}}catch{}await delay(50)}
 child.kill();throw Error('Servidor não iniciou');
}
async function call(base,path,body,token){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()}}
const stop=async child=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r))}};
test('fluxo local: setup, login, sessão, logout, reinício e persistência',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'betel-v20-'));
 for(const name of ['server.js','scheduler.js','cycles.js'])cpSync(join(project,name),join(dir,name));
 cpSync(join(project,'db'),join(dir,'db'),{recursive:true});cpSync(join(project,'public'),join(dir,'public'),{recursive:true});
 const port=32000+Math.floor(Math.random()*20000);let srv;
 try{
  srv=await start(dir,port);
  const setup=await call(srv.base,'/api/setup',{setupKey:'test-only-setup-key',name:'Admin Teste',email:'admin@example.test',password:'senha-teste-forte'});assert.equal(setup.status,201);
  const login=await call(srv.base,'/api/login',{email:'admin@example.test',password:'senha-teste-forte'});assert.equal(login.status,200);const token=login.data.token;
  assert.equal((await call(srv.base,'/api/me',undefined,token)).status,200);
  assert.equal((await call(srv.base,'/api/logout',{},token)).status,200);
  assert.equal((await call(srv.base,'/api/me',undefined,token)).status,401);
  await stop(srv.child);srv=await start(dir,port);
  assert.equal((await call(srv.base,'/api/setup',{setupKey:'test-only-setup-key',name:'Outro',email:'outro@example.test',password:'senha-teste-forte'})).status,403);
  assert.equal((await call(srv.base,'/api/login',{email:'admin@example.test',password:'senha-teste-forte'})).status,200);
 }finally{if(srv)await stop(srv.child);rmSync(dir,{recursive:true,force:true})}
});

test('mudança de perfil revoga sessão do usuário afetado',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'betel-v21-'));
 for(const name of ['server.js','scheduler.js','cycles.js'])cpSync(join(project,name),join(dir,name));
 cpSync(join(project,'db'),join(dir,'db'),{recursive:true});cpSync(join(project,'public'),join(dir,'public'),{recursive:true});
 const port=32000+Math.floor(Math.random()*20000);let srv;
 try{
  srv=await start(dir,port);
  assert.equal((await call(srv.base,'/api/setup',{setupKey:'test-only-setup-key',name:'Admin',email:'admin@example.test',password:'senha-teste-forte'})).status,201);
  const admin=(await call(srv.base,'/api/login',{email:'admin@example.test',password:'senha-teste-forte'})).data.token;
  const invite=await call(srv.base,'/api/invites',{sectors:['som']},admin);assert.equal(invite.status,201);
  const reg=await call(srv.base,'/api/register',{code:invite.data.code,name:'Voluntário',email:'vol@example.test',password:'senha-teste-forte'});assert.equal(reg.status,201);
  const volunteer=(await call(srv.base,'/api/login',{email:'vol@example.test',password:'senha-teste-forte'})).data.token;
  assert.equal((await call(srv.base,'/api/me',undefined,volunteer)).status,200);
  assert.equal((await call(srv.base,'/api/role',{userId:reg.data.user.id,role:'sector',sectors:['som']},admin)).status,200);
  assert.equal((await call(srv.base,'/api/me',undefined,volunteer)).status,401);
  assert.equal((await call(srv.base,'/api/login',{email:'vol@example.test',password:'senha-teste-forte'})).status,200);
 }finally{if(srv)await stop(srv.child);rmSync(dir,{recursive:true,force:true})}
});
