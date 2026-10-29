import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createStore} from './db/store.js';
import {propose} from './scheduler.js';
import {cycleWindow,dueCycles,dateUTC} from './cycles.js';
import {ensureNotifications,queueAssignmentNotifications,sendPendingNotifications} from './notifications.js';
const PORT=Number(process.env.PORT||3000), ROOT=process.cwd(), DB=path.join(ROOT,'data','database.json');
fs.mkdirSync(path.dirname(DB),{recursive:true});
const load=()=>fs.existsSync(DB)?JSON.parse(fs.readFileSync(DB,'utf8')):{users:[],invites:[],sessions:[],audit:[],sectors:[{id:'som',name:'Sonoplastia'},{id:'projecao',name:'Projeção'},{id:'iluminacao',name:'Iluminação'},{id:'transmissao',name:'Transmissão'},{id:'midia',name:'Mídia'}]};
const recurringTransmission=(day,time)=>day===0&&time==='10:15'?'yes':'no';
const defaultSlots=[{day:5,time:'19:00',title:'Culto de sexta-feira',enabled:true,sectors:['som','projecao','iluminacao','midia']},{day:6,time:'19:00',title:'Culto de sábado',enabled:true,sectors:['som','projecao','iluminacao','midia']},...['09:00','10:15','19:00'].map(time=>({day:0,time,title:'Culto de domingo',enabled:true,sectors:time==='10:15'?['som','projecao','iluminacao','midia','transmissao']:['som','projecao','iluminacao','midia']}))];
const normalize=db=>{db.sectors??=[{id:'som',name:'Sonoplastia'},{id:'projecao',name:'Projeção'},{id:'iluminacao',name:'Iluminação'},{id:'transmissao',name:'Transmissão'},{id:'midia',name:'Mídia'}];db.events??=[];db.assignments??=[];db.functions??=[];db.skills??=[];db.unavailability??=[];db.proposals??=[];db.cycles??=[];db.cycleConfig??=null;db.courses??=[];db.courseProgress??={};db.passwordResets??=[];ensureNotifications(db);return db};
const save=db=>{const temp=DB+'.tmp';fs.writeFileSync(temp,JSON.stringify(db,null,2),{mode:0o600});fs.renameSync(temp,DB)};
const store=await createStore({databaseUrl:process.env.DATABASE_URL,localLoad:load,localSave:save});
let requestQueue=Promise.resolve();
const id=()=>crypto.randomUUID();
const hash=(pw,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+crypto.scryptSync(pw,salt,64).toString('hex');
const valid=(pw,stored)=>{try{const [salt]=stored.split(':');return crypto.timingSafeEqual(Buffer.from(hash(pw,salt).split(':')[1],'hex'),Buffer.from(stored.split(':')[1],'hex'))}catch{return false}};
const reply=(res,status,data)=>{res.writeHead(status,{'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Cross-Origin-Resource-Policy':'same-origin'});res.end(JSON.stringify(data))};
const read=async req=>{let b='';for await(const chunk of req){b+=chunk;if(b.length>250000)throw Error('Dados muito grandes')}return b?JSON.parse(b):{}};
const token=()=>crypto.randomBytes(32).toString('hex');
const auth=(req,db)=>{const t=(req.headers.authorization||'').replace(/^Bearer /,'');const s=db.sessions.find(s=>s.tokenHash===crypto.createHash('sha256').update(t).digest('hex')&&s.expires>Date.now());return db.users.find(u=>u.id===s?.userId)};
// Limite básico por IP para rotas de autenticação (somente processo único).
const loginAttempts=new Map();
const limited=(req,route)=>{const key=(req.socket.remoteAddress||'unknown')+':'+route;const now=Date.now();const item=loginAttempts.get(key);if(!item||item.until<now){loginAttempts.set(key,{count:1,until:now+15*60_000});return false}item.count++;return item.count>15};
const SESSION_MS=12*60*60*1000;
const pruneSessions=db=>{const now=Date.now();db.sessions=db.sessions.filter(s=>s.expires>now&&db.users.some(u=>u.id===s.userId));};
// Prepara o ciclo seguinte no dia 45, sem publicar escalas.
function prepareUpcomingCycleDrafts(db){
 if(!db.cycleConfig||!db.cycles?.length)return false;
 const today=new Date().toISOString().slice(0,10),due=dueCycles(db.cycleConfig.anchor,today,db.cycles);
 let changed=false;
 for(const window of due.filter(x=>x.index>0)){
  const previous=db.cycles.find(x=>x.index===window.index-1);
  if(!previous||!db.events.some(e=>e.cycleId===previous.id))continue;
  const cycle={...window,id:id(),status:'pending_review',createdAt:new Date().toISOString(),createdBy:'system'};
  db.cycles.push(cycle);changed=true;
  const slots=(db.recurrenceSlots??defaultSlots).filter(x=>x.enabled),eventIds=[];
  for(let t=dateUTC(cycle.start);t<=dateUTC(cycle.end);t+=86400000){
   const day=new Date(t).getUTCDay(),date=new Date(t).toISOString().slice(0,10);
   for(const slot of slots.filter(x=>x.day===day)){
    const existing=db.events.find(e=>e.date===date&&e.time===slot.time);
    if(existing){eventIds.push(existing.id);continue}
    const e={id:id(),title:slot.title,date,time:slot.time,sectors:slot.sectors,transmission:slot.sectors.includes('transmissao')?'yes':'no',recurringKey:day+':'+slot.time,cycleId:cycle.id,createdBy:'system',createdAt:new Date().toISOString()};
    db.events.push(e);eventIds.push(e.id);
   }
  }
  if(eventIds.length){
   const result=propose(db,[...new Set(eventIds)]);
   db.proposals.push({id:id(),cycleId:cycle.id,createdBy:'system',createdAt:new Date().toISOString(),status:'draft',automaticCycle:true,...result});
  }
  db.audit.push({at:new Date().toISOString(),actor:'system',action:'cycle_auto_draft',target:cycle.id,start:cycle.start,end:cycle.end});
 }
 return changed;
}
async function notificationTick(){const prev=requestQueue;let release;requestQueue=new Promise(resolve=>release=resolve);await prev;try{const db=normalize(await store.load());const cycleChanged=prepareUpcomingCycleDrafts(db);const created=queueAssignmentNotifications(db);if(created||cycleChanged)await store.save(db);const changed=await sendPendingNotifications(db);if(changed)await store.save(db)}catch(e){console.error('Falha no processamento de notificações:',e.message)}finally{release()}}
setTimeout(()=>notificationTick(),4000).unref();setInterval(()=>notificationTick(),5*60*1000).unref();
const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,sectors:u.sectors,profileComplete:!!u.profileComplete});
const profileFields=['name','address','city','state','postalCode','phone','birthDate','education','course','profession','maritalStatus','hasChildren','children','favoriteFood','hobbies','interests'];
const cleanProfile=(p,base={})=>{const out={...base};for(const k of profileFields){if(!(k in p))continue;const v=p[k];if(k==='children'){if(!Array.isArray(v)||v.length>20)throw Error('Informe até 20 filhos');out.children=v.map(x=>({name:String(x.name||'').trim().slice(0,100),birthDate:String(x.birthDate||'').slice(0,10)}));if(out.children.some(x=>x.birthDate&&!/^\d{4}-\d{2}-\d{2}$/.test(x.birthDate)))throw Error('Data de nascimento inválida')}else if(k==='interests'){out.interests=Array.isArray(v)?v.slice(0,30).map(x=>String(x).slice(0,80)):[]}else if(k==='hasChildren'){out.hasChildren=v===true}else{out[k]=String(v??'').trim().slice(0,k==='address'?250:150)}}return out};
http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(req.method==='GET'&&url.pathname==='/healthz')return reply(res,200,{status:'ok',storage:store.mode});if(url.pathname.startsWith('/api/')){
if(req.method==='POST'&&['/api/login','/api/register','/api/setup','/api/forgot-password','/api/reset-password'].includes(url.pathname)&&limited(req,url.pathname))return reply(res,429,{error:'Muitas tentativas. Aguarde 15 minutos.'});
const previous=requestQueue;let release;requestQueue=new Promise(resolve=>{release=resolve});await previous;try{try{const db=normalize(await store.load()),body=req.method==='POST'?await read(req):{};pruneSessions(db);
if(url.pathname==='/api/forgot-password'&&req.method==='POST'){
 const email=String(body.email||'').trim().toLowerCase();
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))return reply(res,400,{error:'Informe um e-mail válido'});
 const generic={ok:true,message:'Se o e-mail estiver cadastrado, você receberá instruções para redefinir sua senha.'};
 const target=db.users.find(u=>u.email===email);
 if(!target)return reply(res,200,generic);
 const apiKey=process.env.RESEND_API_KEY,from=process.env.BETEL_MAIL_FROM,origin=process.env.BETEL_PUBLIC_URL;
 if(!apiKey||!from||!origin){console.error('Recuperação de senha: configure RESEND_API_KEY, BETEL_MAIL_FROM e BETEL_PUBLIC_URL');return reply(res,503,{error:'A recuperação de senha por e-mail ainda não está configurada. Contate a administração.'})}
 const raw=crypto.randomBytes(32).toString('hex'),digest=crypto.createHash('sha256').update(raw).digest('hex');
 const link=new URL('/redefinir-senha.html',origin);link.searchParams.set('token',raw);
 try{const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,to:[email],subject:'Betel Equipes — Redefinição de senha',text:'Recebemos um pedido para redefinir sua senha. Acesse este link em até 30 minutos: '+link.toString()+'\\n\\nSe não foi você, ignore esta mensagem.'})});
 if(!response.ok){console.error('Falha ao enviar e-mail de redefinição:',response.status);return reply(res,503,{error:'O serviço de recuperação de senha está temporariamente indisponível.'})}
 db.passwordResets=db.passwordResets.filter(x=>x.userId!==target.id&&x.expires>Date.now());db.passwordResets.push({userId:target.id,digest,expires:Date.now()+30*60*1000});await store.save(db);return reply(res,200,generic)
 }catch(e){console.error('Erro no envio de recuperação:',e.message);return reply(res,503,{error:'O serviço de recuperação de senha está temporariamente indisponível.'})}
}
if(url.pathname==='/api/reset-password'&&req.method==='POST'){
 const raw=String(body.token||''),password=String(body.password||'');
 if(!/^[a-f0-9]{64}$/.test(raw)||password.length<10||password.length>256)return reply(res,400,{error:'Link inválido ou senha fora do padrão (10 a 256 caracteres)'});
 const digest=crypto.createHash('sha256').update(raw).digest('hex');
 const record=db.passwordResets.find(x=>x.digest===digest&&x.expires>Date.now());
 if(!record)return reply(res,400,{error:'Link inválido ou expirado. Solicite uma nova recuperação.'});
 const target=db.users.find(u=>u.id===record.userId);
 if(!target)return reply(res,400,{error:'Link inválido ou expirado'});
 target.password=hash(password);db.sessions=db.sessions.filter(s=>s.userId!==target.id);db.passwordResets=db.passwordResets.filter(x=>x.userId!==target.id);db.audit.push({at:new Date().toISOString(),actor:target.id,action:'password_reset',target:target.id});await store.save(db);
 return reply(res,200,{ok:true,message:'Senha redefinida. Faça login com sua nova senha.'});
}
if(url.pathname==='/api/setup'&&req.method==='POST'){
if(db.users.length)return reply(res,403,{error:'Configuração inicial já concluída'});
if(!process.env.BETEL_SETUP_KEY||body.setupKey!==process.env.BETEL_SETUP_KEY)return reply(res,403,{error:'Chave de instalação inválida'});
if(!body.name||!body.email||String(body.password||'').length<10)return reply(res,400,{error:'Preencha nome, e-mail e senha com 10 caracteres ou mais'});
const u={id:id(),name:body.name,email:body.email.toLowerCase().trim(),password:hash(body.password),role:'master',sectors:[]};db.users.push(u);db.audit.push({at:new Date().toISOString(),action:'setup',actor:u.id});await store.save(db);return reply(res,201,{user:publicUser(u)})}
if(url.pathname==='/api/login'&&req.method==='POST'){const u=db.users.find(u=>u.email===String(body.email||'').toLowerCase().trim());if(!u||!valid(body.password||'',u.password))return reply(res,401,{error:'Credenciais inválidas'});const t=token();db.sessions.push({userId:u.id,tokenHash:crypto.createHash('sha256').update(t).digest('hex'),expires:Date.now()+SESSION_MS});await store.save(db);return reply(res,200,{token:t,user:publicUser(u)})}
if(url.pathname==='/api/register'&&req.method==='POST'){const invite=db.invites.find(i=>i.code===String(body.code||'').toUpperCase()&&!i.used&&i.expires>Date.now());if(!invite)return reply(res,400,{error:'Convite inválido, vencido ou utilizado'});if(!body.name||!body.email||String(body.password||'').length<10)return reply(res,400,{error:'Nome, e-mail e senha de 10 caracteres são obrigatórios'});const email=body.email.toLowerCase().trim();if(db.users.some(u=>u.email===email))return reply(res,409,{error:'E-mail já cadastrado'});const u={id:id(),name:body.name,email,password:hash(body.password),role:'volunteer',sectors:invite.sectors,profileComplete:false,profile:{}};invite.used=true;db.users.push(u);db.audit.push({at:new Date().toISOString(),action:'register',actor:u.id});await store.save(db);return reply(res,201,{user:publicUser(u)})}
const user=auth(req,db);if(!user)return reply(res,401,{error:'Faça login'});
if(url.pathname==='/api/admin/reset-test-data'&&req.method==='POST'){
 if(user.role!=='master'||user.email!=='estevamgrilo@hotmail.com')return reply(res,403,{error:'Somente o Master autorizado pode executar a limpeza'});
 if(body.confirmation!=='ZERAR BETEL EQUIPES'||body.keepEmail!=='estevamgrilo@hotmail.com')return reply(res,400,{error:'Confirmação de limpeza inválida'});
 const retained=db.users.find(u=>u.id===user.id&&u.email==='estevamgrilo@hotmail.com'&&u.role==='master');
 if(!retained)return reply(res,409,{error:'Master não encontrado; nenhuma alteração realizada'});
 const fresh=normalize({users:[retained],invites:[],sessions:[],audit:[],sectors:[{id:'som',name:'Sonoplastia'},{id:'projecao',name:'Projeção'},{id:'iluminacao',name:'Iluminação'},{id:'transmissao',name:'Transmissão'},{id:'midia',name:'Mídia'}]});
 fresh.events=[];fresh.assignments=[];fresh.functions=[];fresh.skills=[];fresh.unavailability=[];fresh.proposals=[];fresh.cycles=[];fresh.cycleConfig=null;fresh.courses=[];fresh.courseProgress={};fresh.notifications=[];fresh.notificationDeliveries=[];
 await store.save(fresh);return reply(res,200,{ok:true,message:'Dados de teste zerados. Apenas o Master foi preservado. Faça login novamente.',preservedEmail:retained.email});
}
if(url.pathname==='/api/logout'&&req.method==='POST'){
 const presented=(req.headers.authorization||'').replace(/^Bearer /,'');
 const presentedHash=crypto.createHash('sha256').update(presented).digest('hex');
 db.sessions=db.sessions.filter(s=>s.tokenHash!==presentedHash && s.expires>Date.now());
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'logout'});
 await store.save(db);
 return reply(res,200,{ok:true});
}
if(url.pathname==='/api/me')return reply(res,200,{user:publicUser(user)});
if(url.pathname==='/api/notifications'&&req.method==='GET'){
 const list=db.notifications.filter(n=>n.userId===user.id&&!n.cancelled&&db.assignments.some(a=>a.id===n.assignmentId&&a.userId===user.id)).slice(-80).reverse();
 return reply(res,200,{notifications:list,unread:list.filter(n=>!n.readAt).length});
}
if(url.pathname==='/api/notifications/read'&&req.method==='POST'){
 const n=db.notifications.find(n=>n.id===body.id&&n.userId===user.id);
 if(!n)return reply(res,404,{error:'Notificação não encontrada'});
 n.readAt??=new Date().toISOString();await store.save(db);return reply(res,200,{ok:true});
}
if(url.pathname==='/api/admin/notification-status'&&req.method==='GET'){
 if(user.role!=='master')return reply(res,403,{error:'Somente Master'});
 const counts={};for(const j of db.notificationDeliveries)counts[j.channel+':'+j.status]=(counts[j.channel+':'+j.status]||0)+1;
 return reply(res,200,{channels:{email:!!(process.env.RESEND_API_KEY&&process.env.BETEL_MAIL_FROM),whatsapp:!!(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID&&process.env.WHATSAPP_TEMPLATE_NAME)},counts});
}

if(url.pathname==='/api/profile'&&req.method==='GET')return reply(res,200,{user:publicUser(user),profile:user.profile||{}});
if(url.pathname==='/api/profile'&&req.method==='POST'){
 const p=cleanProfile(body,user.profile||{});
 if(!p.name||!p.phone||!/^\d{4}-\d{2}-\d{2}$/.test(p.birthDate||'')||!p.education||!p.maritalStatus)return reply(res,400,{error:'Preencha nome, telefone, nascimento, escolaridade e situação conjugal'});
 const old=user.profile||{};user.name=p.name;user.profile=p;user.profileComplete=true;
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'profile_update',target:user.id,changed:profileFields.filter(k=>JSON.stringify(old[k])!==JSON.stringify(p[k]))});await store.save(db);return reply(res,200,{ok:true,user:publicUser(user),profile:p});
}
if(url.pathname==='/api/admin/users'&&req.method==='GET'){
 if(user.role!=='master')return reply(res,403,{error:'Somente Master'});
 return reply(res,200,{users:db.users.map(u=>({...publicUser(u),profile:u.profile||{}}))});
}
if(url.pathname==='/api/admin/user-courses'&&req.method==='GET'){
 if(user.role!=='master')return reply(res,403,{error:'Somente Master'});
 const targetId=url.searchParams.get('userId');
 if(!db.users.some(u=>u.id===targetId))return reply(res,404,{error:'Voluntário não encontrado'});
 const courses=db.courses.map(course=>{
  const lessons=course.lessons.map((lesson,index)=>{
   const p=db.courseProgress[targetId+'|'+course.id+'|'+lesson.id];
   return {id:lesson.id,title:lesson.title,number:index+1,percent:p?.percent||0,completed:!!p?.completed,duration:p?.duration||0,resumeAt:p?.resumeAt||0,started:!!p?.segments?.length};
  });
  const started=lessons.some(l=>l.started||l.completed||l.percent>0);
  const total=lessons.length;
  return {id:course.id,title:course.title,description:course.description,lessons,totalLessons:total,completedLessons:lessons.filter(l=>l.completed).length,percent:total?Math.round(lessons.filter(l=>l.completed).length/total*100):0,started};
 }).filter(c=>c.started);
 return reply(res,200,{courses});
}
if(url.pathname==='/api/admin/user'&&req.method==='POST'){
 if(user.role!=='master')return reply(res,403,{error:'Somente Master'});
 const target=db.users.find(u=>u.id===body.userId);if(!target)return reply(res,404,{error:'Usuário não encontrado'});
 const changes={};if(body.profile&&typeof body.profile==='object'&&!Array.isArray(body.profile)){
  const old=target.profile||{};target.profile=cleanProfile(body.profile,old);target.name=target.profile.name||target.name;target.profileComplete=!!(target.profile.name&&target.profile.phone&&target.profile.birthDate&&target.profile.education&&target.profile.maritalStatus);
  changes.profileFields=profileFields.filter(k=>JSON.stringify(old[k])!==JSON.stringify(target.profile[k]));
 }
 if(typeof body.email==='string'&&body.email.trim().toLowerCase()!==target.email){const email=body.email.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||db.users.some(u=>u.id!==target.id&&u.email===email))return reply(res,400,{error:'E-mail inválido ou já utilizado'});changes.email={old:target.email,new:email};target.email=email}
 if(body.password!==undefined){if(String(body.password).length<10)return reply(res,400,{error:'Senha deve ter pelo menos 10 caracteres'});target.password=hash(body.password);db.sessions=db.sessions.filter(s=>s.userId!==target.id);changes.passwordChanged=true}
 if(Object.keys(changes).length){db.audit.push({at:new Date().toISOString(),actor:user.id,action:'admin_user_update',target:target.id,changes});await store.save(db)}
 return reply(res,200,{ok:true,user:{...publicUser(target),profile:target.profile||{}}});
}
if(url.pathname==='/api/admin/user-history'&&req.method==='GET'){
 if(user.role!=='master')return reply(res,403,{error:'Somente Master'});
 const target=url.searchParams.get('userId');return reply(res,200,{audit:db.audit.filter(a=>a.target===target||a.actor===target).slice(-100).reverse()});
}
if(url.pathname==='/api/courses/progress'&&req.method==='GET'){
 const result={};for(const course of db.courses){if(user.role!=='master'&&!course.sectors.some(s=>(user.sectors||[]).includes(s)))continue;
 const rows=course.lessons.map(l=>{const p=db.courseProgress[user.id+'|'+course.id+'|'+l.id];return {lessonId:l.id,percent:p?.percent||0,completed:!!p?.completed,duration:p?.duration||0,resumeAt:p?.resumeAt||0}});
 result[course.id]={lessons:rows,percent:rows.length?Math.round(rows.filter(r=>r.completed).length/rows.length*100):0};}
 return reply(res,200,{progress:result});
}
if(url.pathname==='/api/courses/progress'&&req.method==='POST'){
 const course=db.courses.find(c=>c.id===body.courseId);
 if(!course||user.role!=='master'&&!course.sectors.some(s=>(user.sectors||[]).includes(s)))return reply(res,403,{error:'Curso não liberado'});
 const index=course.lessons.findIndex(l=>l.id===body.lessonId);
 if(index<0)return reply(res,404,{error:'Aula não encontrada'});
 if(index>0&&!db.courseProgress[user.id+'|'+course.id+'|'+course.lessons[index-1].id]?.completed)return reply(res,403,{error:'Conclua a aula anterior primeiro'});
 const duration=Number(body.duration),start=Number(body.start),end=Number(body.end),rate=Number(body.playbackRate||1);
 if(!Number.isFinite(duration)||duration<1||duration>86400||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+1||end<=start||end-start>25||!Number.isFinite(rate)||rate<0.25||rate>4.1)return reply(res,400,{error:'Trecho de reprodução inválido'});
 const key=user.id+'|'+course.id+'|'+body.lessonId;
 const p=db.courseProgress[key]||{duration,segments:[],percent:0,completed:false,lastAt:0};
 if(p.completed)return reply(res,200,{percent:100,completed:true,resumeAt:p.resumeAt||0});
 if(p.duration&&Math.abs(p.duration-duration)>2)return reply(res,409,{error:'Duração do vídeo alterada; atualize a página'});
 const now=Date.now(),elapsed=p.lastAt?(now-p.lastAt)/1000:12;
 if(elapsed<0.8||end-start>Math.min(25,elapsed*rate+2))return reply(res,429,{error:'Aguarde a reprodução real'});
 p.lastAt=now;p.duration=duration;p.resumeAt=Math.min(end,duration);p.segments.push([start,Math.min(end,duration)]);
 p.segments.sort((a,b)=>a[0]-b[0]);const merged=[];for(const segment of p.segments){const last=merged[merged.length-1];if(last&&segment[0]<=last[1]+0.2)last[1]=Math.max(last[1],segment[1]);else merged.push(segment.slice())}
 p.segments=merged;const watched=merged.reduce((n,s)=>n+s[1]-s[0],0);
 p.percent=Math.min(100,Math.floor(watched/duration*100));p.completed=watched>=duration*0.95;
 if(p.completed)p.percent=100;db.courseProgress[key]=p;await store.save(db);
 return reply(res,200,{percent:p.percent,completed:p.completed,resumeAt:p.resumeAt});
}
if(url.pathname==='/api/courses'&&req.method==='GET'){
 const allowed=db.courses.filter(c=>user.role==='master'||Array.isArray(c.sectors)&&c.sectors.some(s=>(user.sectors||[]).includes(s)));
 return reply(res,200,{courses:allowed.map(c=>({...c,lessons:(c.lessons||[]).map(l=>({...l}))})),sectors:db.sectors});
}
if(url.pathname==='/api/courses'&&req.method==='POST'){
 if(user.role!=='master')return reply(res,403,{error:'Somente o Master pode cadastrar cursos'});
 const title=String(body.title||'').trim().slice(0,120),description=String(body.description||'').trim().slice(0,1000);
 const sectors=Array.isArray(body.sectors)?[...new Set(body.sectors)].filter(s=>db.sectors.some(x=>x.id===s)):[],raw=body.thumbnail;
 if(!title||!sectors.length)return reply(res,400,{error:'Informe o título e pelo menos uma equipe'});
 if(raw&&!(typeof raw==='string'&&/^data:image\/(?:jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(raw)&&raw.length<=180000))return reply(res,400,{error:'Imagem inválida ou muito grande'});
 const lessons=Array.isArray(body.lessons)?body.lessons:[];
 if(lessons.length>150)return reply(res,400,{error:'Limite de 150 aulas por curso'});
 const youtubeId=u=>{try{const v=new URL(u);if(v.protocol!=='https:')return null;if(['youtu.be','www.youtu.be'].includes(v.hostname))return /^[a-zA-Z0-9_-]{11}$/.test(v.pathname.slice(1))?v.pathname.slice(1):null;if(['youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com'].includes(v.hostname)){const x=v.pathname.startsWith('/shorts/')||v.pathname.startsWith('/embed/')?v.pathname.split('/')[2]:v.searchParams.get('v');return /^[a-zA-Z0-9_-]{11}$/.test(x||'')?x:null}}catch{}return null};
 const clean=[];for(let i=0;i<lessons.length;i++){const l=lessons[i],name=String(l.title||'').trim().slice(0,140),url=String(l.youtube||'').trim(),videoId=youtubeId(url);if(!name||!videoId)return reply(res,400,{error:'Aula '+(i+1)+': informe título e link válido do YouTube'});clean.push({id:typeof l.id==='string'&&l.id.length<60?l.id:id(),title:name,youtube:'https://www.youtube.com/watch?v='+videoId,videoId,order:i+1})}
 const existing=body.id?db.courses.find(x=>x.id===body.id):null;
 if(body.id&&!existing)return reply(res,404,{error:'Curso não encontrado'});
 const course={id:existing?.id||id(),title,description,sectors,thumbnail:raw||'',lessons:clean,updatedAt:new Date().toISOString(),createdAt:existing?.createdAt||new Date().toISOString()};
 if(existing){for(const key of Object.keys(db.courseProgress))if(key.includes('|'+course.id+'|')&&!clean.some(l=>key.endsWith('|'+l.id)))delete db.courseProgress[key];Object.assign(existing,course)}else db.courses.push(course);
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:existing?'course_update':'course_create',target:course.id,courseTitle:title});
 await store.save(db);return reply(res,200,{ok:true,course});
}
if(url.pathname==='/api/courses/delete'&&req.method==='POST'){
 if(user.role!=='master')return reply(res,403,{error:'Somente Master'});
 const course=db.courses.find(x=>x.id===body.id);if(!course)return reply(res,404,{error:'Curso não encontrado'});
 db.courses=db.courses.filter(x=>x.id!==course.id);for(const key of Object.keys(db.courseProgress))if(key.includes('|'+course.id+'|'))delete db.courseProgress[key];db.audit.push({at:new Date().toISOString(),actor:user.id,action:'course_delete',target:course.id,courseTitle:course.title});await store.save(db);return reply(res,200,{ok:true});
}
if(url.pathname==='/api/sectors'&&req.method==='GET')return reply(res,200,{sectors:db.sectors});
if(url.pathname==='/api/sectors'&&req.method==='POST'){
if(user.role!=='master')return reply(res,403,{error:'Somente master'});
const name=String(body.name||'').trim().slice(0,80);if(name.length<2)return reply(res,400,{error:'Nome inválido'});
const sector={id:id(),name};db.sectors.push(sector);db.audit.push({at:new Date().toISOString(),actor:user.id,action:'sector_create',target:sector.id});await store.save(db);return reply(res,201,{sector})}
if(url.pathname==='/api/role'&&req.method==='POST'){
if(user.role!=='master')return reply(res,403,{error:'Somente master'});
const target=db.users.find(u=>u.id===body.userId),role=String(body.role||'');
if(!target||!['master','general','sector','volunteer'].includes(role))return reply(res,400,{error:'Dados inválidos'});
if(target.id===user.id&&role!=='master')return reply(res,400,{error:'Não remova seu próprio acesso master'});
const sectors=Array.isArray(body.sectors)?body.sectors.filter(x=>db.sectors.some(s=>s.id===x)):[];
const old={role:target.role,sectors:target.sectors};target.role=role;target.sectors=sectors;db.sessions=db.sessions.filter(s=>s.userId!==target.id);db.audit.push({at:new Date().toISOString(),actor:user.id,action:'role_change',target:target.id,old,new:{role,sectors}});await store.save(db);return reply(res,200,{user:publicUser(target)})}
// V13: configuração e preparação idempotente de ciclos. Não publica nem altera escalas.
if(url.pathname==='/api/cycles/config'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 try{dateUTC(String(body.anchor||''))}catch{return reply(res,400,{error:'Data inicial inválida'})}
 if(db.cycleConfig&&db.cycles.length)return reply(res,409,{error:'Existem ciclos; a alteração da âncora exige migração supervisionada'});
 db.cycleConfig={anchor:body.anchor,configuredBy:user.id,configuredAt:new Date().toISOString()};
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'cycle_config',anchor:body.anchor});await store.save(db);return reply(res,200,{config:db.cycleConfig});
}
if(url.pathname==='/api/cycles'&&req.method==='GET'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 return reply(res,200,{config:db.cycleConfig,cycles:db.cycles});
}
if(url.pathname==='/api/cycles/prepare'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 if(!db.cycleConfig)return reply(res,409,{error:'Configure a data inicial do ciclo'});
 const today=new Date().toISOString().slice(0,10);
 const pending=dueCycles(db.cycleConfig.anchor,today,db.cycles);
 const added=pending.map(c=>({...c,id:id(),status:'pending_review',createdAt:new Date().toISOString(),createdBy:user.id}));
 db.cycles.push(...added);
 for(const c of added)db.audit.push({at:c.createdAt,actor:user.id,action:'cycle_prepare',target:c.id,start:c.start,end:c.end});
 if(added.length)await store.save(db);
 return reply(res,200,{created:added,existing:db.cycles.length,notice:'Ciclos preparados para revisão; nenhuma escala foi publicada ou substituída'});
}
// V15: configurações de cultos recorrentes, criados apenas por ação da liderança.
if(url.pathname==='/api/recurrence'&&req.method==='GET'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 return reply(res,200,{slots:db.recurrenceSlots??defaultSlots});
}
if(url.pathname==='/api/recurrence'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 if(!Array.isArray(body.slots)||body.slots.length>30)return reply(res,400,{error:'Configuração inválida'});
 const slots=[];
 for(const x of body.slots){const day=Number(x.day),time=String(x.time||''),title=String(x.title||'').trim().slice(0,90);
  if(![0,1,2,3,4,5,6].includes(day)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||title.length<3||typeof x.enabled!=='boolean'||!Array.isArray(x.sectors))return reply(res,400,{error:'Horário ou setor inválido'});
  const sectors=[...new Set(x.sectors)].filter(v=>db.sectors.some(z=>z.id===v)&&(user.role==='master'||user.sectors.includes(v)));
  if(!sectors.length)return reply(res,400,{error:'Escolha ao menos uma equipe autorizada'});
  slots.push({day,time,title,enabled:x.enabled,sectors});
 }
 db.recurrenceSlots=slots;db.audit.push({at:new Date().toISOString(),actor:user.id,action:'recurrence_config'});await store.save(db);return reply(res,200,{slots});
}
if(url.pathname==='/api/recurrence/cleanup'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const removable=db.events.filter(e=>e.recurringKey&&e.cycleId&&!db.assignments.some(a=>a.eventId===e.id));
 const ids=new Set(removable.map(e=>e.id));
 db.events=db.events.filter(e=>!ids.has(e.id));
 db.proposals=db.proposals.filter(p=>p.status!=='draft'||!p.proposed?.some(a=>ids.has(a.eventId)));
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'recurrence_cleanup',removed:removable.length});
 await store.save(db);
 return reply(res,200,{removed:removable.length,preserved:db.events.length});
}
if(url.pathname==='/api/recurrence/generate'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const cycle=db.cycles.find(c=>c.id===body.cycleId);if(!cycle)return reply(res,404,{error:'Ciclo não encontrado'});
 const slots=(db.recurrenceSlots??defaultSlots).filter(x=>x.enabled);
 const created=[];let skipped=0;
 for(let t=dateUTC(cycle.start);t<=dateUTC(cycle.end);t+=86400000){const day=new Date(t).getUTCDay(),date=new Date(t).toISOString().slice(0,10);
  for(const slot of slots.filter(x=>x.day===day)){
   if(db.events.some(e=>e.date===date&&e.time===slot.time&&e.recurringKey===`${day}:${slot.time}`)){skipped++;continue}
   const e={id:id(),title:slot.title,date,time:slot.time,sectors:slot.sectors,transmission:slot.sectors.includes('transmissao')?'yes':'no',recurringKey:`${day}:${slot.time}`,cycleId:cycle.id,createdBy:user.id,createdAt:new Date().toISOString()};db.events.push(e);created.push(e);
  }
 }
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'recurrence_generate',cycleId:cycle.id,created:created.length,skipped});await store.save(db);
 return reply(res,200,{created:created.length,skipped,notice:'Eventos criados sem escala nem autorização de transmissão'});
}
// V9: funções, habilitações, indisponibilidades e proposta sujeita à aprovação.
if(url.pathname==='/api/birthdays/month'&&req.method==='GET'){
 if(!['master','general','sector'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const month=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',month:'numeric'}).format(new Date()));
 const people=db.users.filter(u=>(user.role==='master'||u.sectors.some(s=>user.sectors.includes(s)))&&u.profile?.birthDate?.slice(5,7)===String(month).padStart(2,'0')).map(u=>({id:u.id,name:u.name,day:Number(u.profile.birthDate.slice(8,10))})).sort((a,b)=>a.day-b.day||a.name.localeCompare(b.name));
 return reply(res,200,{month,people});
}
if(url.pathname==='/api/skills'&&req.method==='GET'){
 if(!['master','general','sector'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 return reply(res,200,{skills:db.skills.filter(s=>{const f=db.functions.find(x=>x.id===s.functionId);return f&&(user.role==='master'||user.sectors.includes(f.sector))})});
}
if(url.pathname==='/api/functions/automatic'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const f=db.functions.find(x=>x.id===body.functionId);if(!f||user.role!=='master'&&!user.sectors.includes(f.sector))return reply(res,403,{error:'Função não autorizada'});
 f.automatic=body.automatic===true;db.audit.push({at:new Date().toISOString(),actor:user.id,action:'function_automatic',target:f.id,automatic:f.automatic});await store.save(db);return reply(res,200,{function:f});
}
if(url.pathname==='/api/functions'&&req.method==='GET')return reply(res,200,{functions:db.functions});
if(url.pathname==='/api/functions'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const sector=String(body.sector||''),name=String(body.name||'').trim().slice(0,80);
 if(!db.sectors.some(s=>s.id===sector)||name.length<2)return reply(res,400,{error:'Função inválida'});
 if(user.role!=='master'&&!user.sectors.includes(sector))return reply(res,403,{error:'Equipe não autorizada'});
 const f={id:id(),sector,name,automatic:body.automatic===true};db.functions.push(f);db.audit.push({at:new Date().toISOString(),actor:user.id,action:'function_create',target:f.id});await store.save(db);return reply(res,201,{function:f});
}
if(url.pathname==='/api/volunteer/sectors'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const u=db.users.find(x=>x.id===body.userId),sector=String(body.sector||'');
 if(!u||!db.sectors.some(s=>s.id===sector)||user.role!=='master'&&!user.sectors.includes(sector))return reply(res,403,{error:'Voluntário ou equipe não autorizados'});
 const active=body.active===true;
 if(active&&!u.sectors.includes(sector))u.sectors.push(sector);
 if(!active){u.sectors=u.sectors.filter(s=>s!==sector);db.skills=db.skills.filter(s=>s.userId!==u.id||db.functions.find(f=>f.id===s.functionId)?.sector!==sector)}
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'volunteer_sector',target:u.id,sector,active});await store.save(db);return reply(res,200,{sectors:u.sectors});
}
if(url.pathname==='/api/skills'&&req.method==='POST'){
 if(!['master','general','sector'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const f=db.functions.find(x=>x.id===body.functionId),u=db.users.find(x=>x.id===body.userId);
 if(!f||!u||!u.sectors.includes(f.sector)||user.role!=='master'&&!user.sectors.includes(f.sector))return reply(res,403,{error:'Equipe ou função não autorizada'});
 const old=db.skills.find(s=>s.userId===u.id&&s.functionId===f.id);
 const level=String(body.level||old?.level||'estagiario').toLowerCase();if(!['estagiario','iniciante','intermediario','avancado','diretor'].includes(level))return reply(res,400,{error:'Nível inválido'});if(old){old.approved=body.approved===true;old.level=level}else db.skills.push({userId:u.id,functionId:f.id,approved:body.approved===true,level});
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'skill_validation',target:u.id,functionId:f.id,approved:body.approved===true});await store.save(db);return reply(res,200,{ok:true});
}
if(url.pathname==='/api/unavailability'&&req.method==='GET'){
 const items=db.unavailability.filter(x=>x.userId===user.id).sort((a,b)=>a.from.localeCompare(b.from));
 return reply(res,200,{unavailability:items});
}
if(url.pathname==='/api/unavailability/remove'&&req.method==='POST'){
 const index=db.unavailability.findIndex(x=>x.id===body.id&&x.userId===user.id);
 if(index<0)return reply(res,404,{error:'Indisponibilidade não encontrada'});
 const existing=db.unavailability[index],day=String(body.date||'');
 if(day){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day<existing.from||day>existing.to)return reply(res,400,{error:'Data fora do período de indisponibilidade'});
  const previous=existing.from,next=existing.to;
  db.unavailability.splice(index,1);
  const shift=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
  if(previous<day)db.unavailability.push({id:id(),userId:user.id,from:previous,to:shift(day,-1)});
  if(day<next)db.unavailability.push({id:id(),userId:user.id,from:shift(day,1),to:next});
  db.audit.push({at:new Date().toISOString(),actor:user.id,action:'unavailability_remove_day',target:existing.id,date:day});
 }else{
  const removed=db.unavailability.splice(index,1)[0];
  db.audit.push({at:new Date().toISOString(),actor:user.id,action:'unavailability_remove',target:removed.id});
 }
 await store.save(db);return reply(res,200,{ok:true});
}
if(url.pathname==='/api/unavailability'&&req.method==='POST'){
 const from=String(body.from||''),to=String(body.to||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to)))return reply(res,400,{error:'Datas inválidas'});
 if(db.unavailability.some(x=>x.userId===user.id&&x.from<=to&&x.to>=from))return reply(res,409,{error:'Uma ou mais datas já estão cadastradas como indisponíveis. Escolha um período sem sobreposição.'});
 db.unavailability.push({id:id(),userId:user.id,from,to});db.audit.push({at:new Date().toISOString(),actor:user.id,action:'unavailability_create'});await store.save(db);return reply(res,201,{ok:true});
}
if(url.pathname==='/api/smart-cycle/generate'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const slots=(db.recurrenceSlots??defaultSlots).filter(s=>s.enabled);
 if(!slots.length)return reply(res,409,{error:'Configure ao menos um horário recorrente'});
 if(!db.cycleConfig){const anchor=/^\\d{4}-\\d{2}-\\d{2}$/.test(body.anchor||'')?body.anchor:new Date().toISOString().slice(0,10);db.cycleConfig={anchor,configuredBy:user.id,configuredAt:new Date().toISOString()}}
 const today=new Date().toISOString().slice(0,10),due=dueCycles(db.cycleConfig.anchor,today,db.cycles);
 for(const w of due){const cycle={...w,id:id(),status:'pending_review',createdAt:new Date().toISOString(),createdBy:user.id};db.cycles.push(cycle)}
 const cycle=db.cycles.find(x=>x.start<=today&&x.end>=today)||db.cycles.find(x=>x.end>=today)||db.cycles.at(-1);
 if(!cycle)return reply(res,409,{error:'Nenhum ciclo elegível. Confira a data inicial'});
 const eventIds=[];let created=0;
 for(let t=dateUTC(cycle.start);t<=dateUTC(cycle.end);t+=86400000){const day=new Date(t).getUTCDay(),date=new Date(t).toISOString().slice(0,10);
  for(const slot of slots.filter(s=>s.day===day)){
   let e=db.events.find(x=>x.date===date&&x.time===slot.time&&x.recurringKey===day+':'+slot.time);
   if(!e){e={id:id(),title:slot.title,date,time:slot.time,sectors:[...slot.sectors],transmission:slot.sectors.includes('transmissao')?'yes':'no',recurringKey:day+':'+slot.time,cycleId:cycle.id,createdBy:user.id,createdAt:new Date().toISOString()};db.events.push(e);created++}
   eventIds.push(e.id);
  }
 }
 const existing=db.proposals.find(p=>p.status==='draft'&&p.cycleId===cycle.id&&p.smartCycle);
 if(existing){const result=propose(db,eventIds);existing.proposed=result.proposed;existing.warnings=result.warnings;existing.updatedAt=new Date().toISOString();await store.save(db);return reply(res,200,{proposal:existing,cycle,created,existing:true,regenerated:true})}
 const result=propose(db,eventIds),proposal={id:id(),cycleId:cycle.id,smartCycle:true,createdBy:user.id,createdAt:new Date().toISOString(),status:'draft',...result};db.proposals.push(proposal);
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'smart_cycle_generate',cycleId:cycle.id,created});await store.save(db);
 return reply(res,201,{proposal,cycle,created});
}
if(url.pathname==='/api/schedule/preview'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const eventIds=Array.isArray(body.eventIds)?body.eventIds.filter(x=>db.events.some(e=>e.id===x&&(user.role==='master'||e.sectors.some(s=>user.sectors.includes(s))))).slice(0,200):[];
 if(!eventIds.length)return reply(res,400,{error:'Selecione eventos autorizados'});
 const result=propose(db,eventIds),proposal={id:id(),createdBy:user.id,createdAt:new Date().toISOString(),status:'draft',...result};db.proposals.push(proposal);await store.save(db);return reply(res,201,{proposal});
}
if(url.pathname==='/api/schedule/eligible'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const e=db.events.find(x=>x.id===body.eventId),f=db.functions.find(x=>x.id===body.functionId);
 if(!e||!f||user.role!=='master'&&!user.sectors.includes(f.sector))return reply(res,403,{error:'Não autorizado'});
 const candidates=db.users.filter(u=>u.sectors?.includes(f.sector)&&db.skills.some(s=>s.userId===u.id&&s.functionId===f.id&&s.approved));
 return reply(res,200,{users:candidates.map(u=>({id:u.id,name:u.name,unavailable:db.unavailability.some(a=>a.userId===u.id&&e.date>=a.from&&e.date<=a.to)}))});
}
if(url.pathname==='/api/schedule/resolve'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const p=db.proposals.find(x=>x.id===body.proposalId&&x.status==='draft'&&(user.role==='master'||x.createdBy===user.id||x.automaticCycle&&user.role==='general'));
 const e=db.events.find(x=>x.id===body.eventId),f=db.functions.find(x=>x.id===body.functionId),vol=db.users.find(x=>x.id===body.userId);
 if(!p||!e||!f||!vol||user.role!=='master'&&!user.sectors.includes(f.sector))return reply(res,403,{error:'Proposta, função ou voluntário não autorizado'});
 if(!e.sectors.includes(f.sector)||!vol.sectors?.includes(f.sector)||!db.skills.some(s=>s.userId===vol.id&&s.functionId===f.id&&s.approved))return reply(res,409,{error:'Voluntário não habilitado para esta função'});
 if(f.sector==='transmissao'&&e.transmission!=='yes')return reply(res,409,{error:'Transmissão não autorizada neste culto'});
 if(db.unavailability.some(a=>a.userId===vol.id&&e.date>=a.from&&e.date<=a.to))return reply(res,409,{error:'Voluntário indisponível nesta data'});
 const all=[...db.assignments,...p.proposed],time=x=>Date.parse(x.date+'T'+x.time+':00-03:00');
 if(all.some(a=>a.userId===vol.id&&(()=>{const other=db.events.find(x=>x.id===a.eventId);return other&&Math.abs(time(other)-time(e))<12*3600000})()))return reply(res,409,{error:'Voluntário já escalado ou com descanso inferior a 12 horas'});
 if(all.some(a=>a.eventId===e.id&&a.sector===f.sector&&a.functionName===f.name))return reply(res,409,{error:'Função já preenchida'});
 if(!p.warnings.some(w=>w.eventId===e.id&&w.functionId===f.id))return reply(res,409,{error:'Não existe pendência desta função'});
 p.proposed.push({id:'preview-'+e.id+'-'+f.id,eventId:e.id,sector:f.sector,functionName:f.name,userId:vol.id,proposal:true});p.warnings=p.warnings.filter(w=>!(w.eventId===e.id&&w.functionId===f.id));
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'proposal_resolve',target:p.id,eventId:e.id,functionId:f.id,userId:vol.id});await store.save(db);return reply(res,200,{proposal:p});
}
if(url.pathname==='/api/schedule/proposals'&&req.method==='GET')return reply(res,200,{proposals:db.proposals.filter(p=>user.role==='master'||p.createdBy===user.id||p.automaticCycle&&user.role==='general')});
// V11: edição auditada de uma atribuição ainda em rascunho.
if(url.pathname==='/api/schedule/edit'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const p=db.proposals.find(p=>p.id===body.proposalId&&p.status==='draft'&&(user.role==='master'||p.createdBy===user.id));
 if(!p)return reply(res,404,{error:'Proposta não encontrada'});
 const a=p.proposed.find(a=>a.id===body.assignmentId);if(!a)return reply(res,404,{error:'Vaga não encontrada'});
 const e=db.events.find(e=>e.id===a.eventId),f=db.functions.find(f=>f.sector===a.sector&&f.name===a.functionName);
 if(!e||!f||user.role!=='master'&&!user.sectors.includes(a.sector))return reply(res,403,{error:'Equipe não autorizada'});
 const next=body.userId===null?null:db.users.find(u=>u.id===body.userId);
 if(body.userId!==null&&!next)return reply(res,400,{error:'Voluntário inválido'});
 if(next){
  if(!next.sectors?.includes(a.sector)||!db.skills.some(x=>x.userId===next.id&&x.functionId===f.id&&x.approved))return reply(res,409,{error:'Voluntário sem habilitação aprovada'});
  if(a.sector==='transmissao'&&e.transmission!=='yes')return reply(res,409,{error:'Transmissão não autorizada'});
  if(db.unavailability.some(x=>x.userId===next.id&&e.date>=x.from&&e.date<=x.to))return reply(res,409,{error:'Indisponível nesta data'});
  const time=ev=>Date.parse(ev.date+'T'+ev.time+':00-03:00');
  const conflicts=[...db.assignments,...p.proposed.filter(x=>x.id!==a.id)];
  if(conflicts.some(x=>x.userId===next.id&&(()=>{const other=db.events.find(ev=>ev.id===x.eventId);return other&&Math.abs(time(e)-time(other))<12*3600000})()))return reply(res,409,{error:'Conflito de escala ou descanso inferior a 12 horas'});
 }
 const old=a.userId;
 if(next)a.userId=next.id;else p.proposed=p.proposed.filter(x=>x.id!==a.id);
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'proposal_edit',target:p.id,assignmentId:a.id,old,new:next?.id??null});await store.save(db);
 return reply(res,200,{proposal:p});
}
if(url.pathname==='/api/schedule/approve'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const p=db.proposals.find(p=>p.id===body.proposalId&&p.status==='draft'&&(user.role==='master'||p.createdBy===user.id||p.automaticCycle&&user.role==='general'));if(!p)return reply(res,404,{error:'Proposta não encontrada'});
 const applied=[],skipped=[];
 for(const a of p.proposed){const e=db.events.find(e=>e.id===a.eventId),f=db.functions.find(f=>f.sector===a.sector&&f.name===a.functionName),u=db.users.find(u=>u.id===a.userId);
  if(!e||!f||!u||a.sector==='transmissao'&&e.transmission!=='yes'||!db.skills.some(s=>s.userId===u.id&&s.functionId===f.id&&s.approved)||db.unavailability.some(x=>x.userId===u.id&&e.date>=x.from&&e.date<=x.to)||db.assignments.some(x=>x.eventId===e.id&&(x.sector===a.sector&&x.functionName===a.functionName||x.userId===u.id))){skipped.push(a);continue}
  const record={...a,id:id(),proposal:false,notificationEligible:true,createdAt:new Date().toISOString()};db.assignments.push(record);applied.push(record);
 }
 queueAssignmentNotifications(db);p.status='reviewed';p.reviewedBy=user.id;p.reviewedAt=new Date().toISOString();db.audit.push({at:p.reviewedAt,actor:user.id,action:'schedule_approval',target:p.id,applied:applied.length,skipped:skipped.length});await store.save(db);return reply(res,200,{applied,skipped});
}
// V8: agenda e escalas manuais, sem ativação automática por padrão.
if(url.pathname==='/api/events'&&req.method==='GET'){
 const visible=db.events.filter(e=>user.role==='master'||e.sectors.some(x=>user.sectors.includes(x)));
 const assignments=db.assignments.filter(a=>visible.some(e=>e.id===a.eventId));
 const names=new Map(db.users.map(u=>[u.id,u.name]));
 const detailed=assignments.map(a=>({...a,volunteerName:names.get(a.userId)||'Voluntário não escalado'}));
 return reply(res,200,{events:visible,assignments:detailed});
}
if(url.pathname==='/api/events'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão para criar eventos'});
 const title=String(body.title||'').trim().slice(0,120),date=String(body.date||''),time=String(body.time||'');
 if(title.length<3||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return reply(res,400,{error:'Título, data e horário obrigatórios'});
 const sectors=Array.isArray(body.sectors)?[...new Set(body.sectors)].filter(x=>db.sectors.some(s=>s.id===x)&&(user.role==='master'||user.sectors.includes(x))):[];
 if(!sectors.length)return reply(res,400,{error:'Selecione pelo menos uma equipe autorizada'});
 const e={id:id(),title,date,time,sectors,transmission:'undefined',createdBy:user.id,createdAt:new Date().toISOString()};
 db.events.push(e);db.audit.push({at:new Date().toISOString(),actor:user.id,action:'event_create',target:e.id});await store.save(db);return reply(res,201,{event:e});
}
if(url.pathname==='/api/events/update'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão para editar eventos'});
 const e=db.events.find(x=>x.id===body.eventId);
 if(!e||user.role!=='master'&&!e.sectors.some(x=>user.sectors.includes(x)))return reply(res,404,{error:'Evento não encontrado'});
 const title=String(body.title||'').trim().slice(0,120),date=String(body.date||''),time=String(body.time||'');
 if(title.length<3||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time))return reply(res,400,{error:'Informe nome, data e horário válidos'});
 const sectors=Array.isArray(body.sectors)?[...new Set(body.sectors)].filter(x=>db.sectors.some(s=>s.id===x)&&(user.role==='master'||user.sectors.includes(x))):[];
 if(!sectors.length)return reply(res,400,{error:'Selecione pelo menos uma equipe'});
 if(db.assignments.some(a=>a.eventId===e.id&&!sectors.includes(a.sector)))return reply(res,409,{error:'Remova as escalas das equipes desmarcadas antes de salvar'});
 const old={title:e.title,date:e.date,time:e.time,sectors:[...e.sectors]};
 Object.assign(e,{title,date,time,sectors,updatedAt:new Date().toISOString()});
 db.audit.push({at:e.updatedAt,actor:user.id,action:'event_update',target:e.id,old,new:{title,date,time,sectors}});
 await store.save(db);return reply(res,200,{event:e});
}
if(url.pathname==='/api/events/delete'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão para excluir eventos'});
 const e=db.events.find(x=>x.id===body.eventId);
 if(!e||user.role!=='master'&&!e.sectors.some(x=>user.sectors.includes(x)))return reply(res,404,{error:'Evento não encontrado'});
 const removed=db.assignments.filter(a=>a.eventId===e.id);
 db.assignments=db.assignments.filter(a=>a.eventId!==e.id);
 db.events=db.events.filter(x=>x.id!==e.id);
 for(const n of db.notifications||[])if(n.eventId===e.id)n.cancelled=true;
 for(const p of db.proposals||[])if(p.status==='draft'&&p.proposed?.some(a=>a.eventId===e.id)){p.status='invalidated';p.invalidatedAt=new Date().toISOString()}
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'event_delete',target:e.id,title:e.title,removedAssignments:removed.length});
 await store.save(db);return reply(res,200,{ok:true,removedAssignments:removed.length});
}
if(url.pathname==='/api/events/transmission'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Somente liderança geral ou master'});
 const e=db.events.find(x=>x.id===body.eventId);if(!e||user.role!=='master'&&!e.sectors.some(x=>user.sectors.includes(x)))return reply(res,404,{error:'Evento indisponível'});
 if(!['undefined','yes','no'].includes(body.value))return reply(res,400,{error:'Valor inválido'});
 const old=e.transmission;e.transmission=body.value;db.audit.push({at:new Date().toISOString(),actor:user.id,action:'transmission_change',target:e.id,old,new:body.value});await store.save(db);return reply(res,200,{event:e});
}
if(url.pathname==='/api/assignments'&&req.method==='POST'){
 if(!['master','general','sector'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const e=db.events.find(x=>x.id===body.eventId),sector=String(body.sector||'');
 if(!e||!e.sectors.includes(sector)||user.role!=='master'&&!user.sectors.includes(sector))return reply(res,403,{error:'Equipe não autorizada'});
 if(sector==='transmissao'&&e.transmission!=='yes')return reply(res,409,{error:'Transmissão deve ser autorizada pela liderança geral antes de escalar'});
 const u=db.users.find(x=>x.id===body.userId);if(!u||!u.sectors.includes(sector))return reply(res,400,{error:'Voluntário não vinculado à equipe'});
 const functionName=String(body.functionName||'').trim().slice(0,80);if(!functionName)return reply(res,400,{error:'Informe a função'});
 if(db.unavailability.some(x=>x.userId===u.id&&e.date>=x.from&&e.date<=x.to))return reply(res,409,{error:'Este voluntário está indisponível na data do evento. Escolha outro voluntário ou solicite que ele libere a data.'});
 const current=db.assignments.find(x=>x.eventId===e.id&&x.sector===sector&&x.functionName===functionName);
 const old=current?{userId:current.userId}:null;
 if(current){if(current.userId!==u.id){current.notificationEligible=true;current.id=id()}current.userId=u.id;current.updatedAt=new Date().toISOString()}else db.assignments.push({id:id(),eventId:e.id,sector,functionName,userId:u.id,notificationEligible:true,createdAt:new Date().toISOString()});
 queueAssignmentNotifications(db);
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'assignment_upsert',target:e.id,sector,functionName,old,new:{userId:u.id}});await store.save(db);return reply(res,200,{ok:true});
}
if(url.pathname==='/api/assignments/remove'&&req.method==='POST'){
 if(!['master','general','sector'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const a=db.assignments.find(x=>x.id===body.assignmentId),e=db.events.find(x=>x.id===a?.eventId);
 if(!a||!e||user.role!=='master'&&!user.sectors.includes(a.sector))return reply(res,403,{error:'Sem permissão'});
 db.assignments=db.assignments.filter(x=>x.id!==a.id);db.audit.push({at:new Date().toISOString(),actor:user.id,action:'assignment_remove',target:e.id,old:a});await store.save(db);return reply(res,200,{ok:true});
}
if(url.pathname==='/api/audit'&&req.method==='GET'){
if(user.role!=='master')return reply(res,403,{error:'Somente master'});return reply(res,200,{audit:db.audit.slice(-100).reverse()})}

if(url.pathname==='/api/invites'&&req.method==='POST'){if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});const sectors=Array.isArray(body.sectors)?body.sectors.filter(x=>db.sectors.some(s=>s.id===x)&& (user.role==='master'||user.sectors.includes(x))).slice(0,20):[];const code=crypto.randomBytes(5).toString('hex').toUpperCase();db.invites.push({code,sectors,used:false,expires:Date.now()+7*86400000,createdBy:user.id});db.audit.push({at:new Date().toISOString(),action:'invite',actor:user.id});await store.save(db);return reply(res,201,{code,expiresInDays:7})}
if(url.pathname==='/api/users'&&req.method==='GET'){if(!['master','general','sector'].includes(user.role))return reply(res,403,{error:'Sem permissão'});return reply(res,200,{users:db.users.filter(u=>user.role==='master'||u.sectors.some(s=>user.sectors.includes(s))).map(publicUser)})}
return reply(res,404,{error:'Rota não encontrada'})}catch(e){console.error('API error:',e.message);return reply(res,400,{error:'Requisição inválida'})}}finally{release()}}
const file=url.pathname==='/'?'index.html':url.pathname.slice(1);const full=path.resolve(ROOT,'public',file);if(!full.startsWith(path.resolve(ROOT,'public')+path.sep))return res.writeHead(403).end();fs.readFile(full,(err,data)=>{if(err)return res.writeHead(404).end('Não encontrado');res.writeHead(200,{'Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache','Expires':'0','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com https://i9.ytimg.com; connect-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",'Content-Type':full.endsWith('.html')?'text/html; charset=utf-8':full.endsWith('.js')?'application/javascript; charset=utf-8':full.endsWith('.css')?'text/css; charset=utf-8':full.endsWith('.png')?'image/png':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Cross-Origin-Resource-Policy':'same-origin'});res.end(data)})}).listen(PORT,()=>console.log(`Betel Equipes: http://localhost:${PORT}`));
