import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../db/store.js';

// Rode somente com uma DATABASE_URL_TEST apontando para banco DESCARTÁVEL exclusivo.
test('PostgreSQL real: persistência após reconexão e revisão concorrente',{skip:!process.env.DATABASE_URL_TEST},async()=>{
 const url=process.env.DATABASE_URL_TEST;
 const a=await createStore({databaseUrl:url,localLoad:()=>({users:[],audit:[]}),localSave:()=>{throw Error('Não deveria salvar JSON')}});
 try{
  const before=await a.load();
  const marker='v20-'+Date.now();
  const changed={...before,__v20_probe:marker};
  await a.save(changed);
  const b=await createStore({databaseUrl:url,localLoad:()=>({}),localSave:()=>{}});
  try{
   assert.equal((await b.load()).__v20_probe,marker);
   await assert.rejects(()=>a.save({...changed,__v20_probe:'stale'}),/Concurrent modification/);
   const clean={...await b.load()};
   if(before.__v20_probe===undefined)delete clean.__v20_probe;else clean.__v20_probe=before.__v20_probe;
   await b.save(clean);
  }finally{await b.close()}
 }finally{await a.close()}
});
