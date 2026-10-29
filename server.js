import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createStore} from './db/store.js';
import {propose} from './scheduler.js';
import {cycleWindow,dueCycles,dateUTC} from './cycles.js';
const PORT=Number(process.env.PORT||3000), ROOT=process.cwd(), DB=path.join(ROOT,'data','database.json');
fs.mkdirSync(path.dirname(DB),{recursive:true});
const load=()=>fs.existsSync(DB)?JSON.parse(fs.readFileSync(DB,'utf8')):{users:[],invites:[],sessions:[],audit:[],sectors:[{id:'som',name:'Sonoplastia'},{id:'projecao',name:'Projeção'},{id:'iluminacao',name:'Iluminação'},{id:'transmissao',name:'Transmissão'},{id:'midia',name:'Mídia'}]};
const defaultSlots=[{day:5,time:'19:00',title:'Culto de sexta-feira',enabled:true,sectors:['som','projecao','iluminacao','midia']},{day:6,time:'19:00',title:'Culto de sábado',enabled:true,sectors:['som','projecao','iluminacao','midia']},...['09:00','10:15','19:00'].map(time=>({day:0,time,title:'Culto de domingo',enabled:true,sectors:['som','projecao','iluminacao','midia']}))];
const normalize=db=>{db.sectors??=[{id:'som',name:'Sonoplastia'},{id:'projecao',name:'Projeção'},{id:'iluminacao',name:'Iluminação'},{id:'transmissao',name:'Transmissão'},{id:'midia',name:'Mídia'}];db.events??=[];db.assignments??=[];db.functions??=[];db.skills??=[];db.unavailability??=[];db.proposals??=[];db.cycles??=[];db.cycleConfig??=null;db.courses??=[];db.courseProgress??={};db.passwordResets??=[];return db};
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
 fresh.events=[];fresh.assignments=[];fresh.functions=[];fresh.skills=[];fresh.unavailability=[];fresh.proposals=[];fresh.cycles=[];fresh.cycleConfig=null;fresh.courses=[];fresh.courseProgress={};
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
 if(!Number.isFinite(duration)||duration<1||duration>86400||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+1||end<=start||end-start>25||!Number.isFinite(rate)||rate<0.25||rate>2.1)return reply(res,400,{error:'Trecho de reprodução inválido'});
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
if(url.pathname==='/api/recurrence/generate'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const cycle=db.cycles.find(c=>c.id===body.cycleId);if(!cycle)return reply(res,404,{error:'Ciclo não encontrado'});
 const slots=(db.recurrenceSlots??defaultSlots).filter(x=>x.enabled);
 const created=[];let skipped=0;
 for(let t=dateUTC(cycle.start);t<=dateUTC(cycle.end);t+=86400000){const day=new Date(t).getUTCDay(),date=new Date(t).toISOString().slice(0,10);
  for(const slot of slots.filter(x=>x.day===day)){
   if(db.events.some(e=>e.date===date&&e.time===slot.time&&e.recurringKey===`${day}:${slot.time}`)){skipped++;continue}
   const e={id:id(),title:slot.title,date,time:slot.time,sectors:slot.sectors,transmission:'undefined',recurringKey:`${day}:${slot.time}`,cycleId:cycle.id,createdBy:user.id,createdAt:new Date().toISOString()};db.events.push(e);created.push(e);
  }
 }
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'recurrence_generate',cycleId:cycle.id,created:created.length,skipped});await store.save(db);
 return reply(res,200,{created:created.length,skipped,notice:'Eventos criados sem escala nem autorização de transmissão'});
}
// V9: funções, habilitações, indisponibilidades e proposta sujeita à aprovação.
if(url.pathname==='/api/functions'&&req.method==='GET')return reply(res,200,{functions:db.functions});
if(url.pathname==='/api/functions'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const sector=String(body.sector||''),name=String(body.name||'').trim().slice(0,80);
 if(!db.sectors.some(s=>s.id===sector)||name.length<2)return reply(res,400,{error:'Função inválida'});
 if(user.role!=='master'&&!user.sectors.includes(sector))return reply(res,403,{error:'Equipe não autorizada'});
 const f={id:id(),sector,name,automatic:body.automatic===true};db.functions.push(f);db.audit.push({at:new Date().toISOString(),actor:user.id,action:'function_create',target:f.id});await store.save(db);return reply(res,201,{function:f});
}
if(url.pathname==='/api/skills'&&req.method==='POST'){
 if(!['master','general','sector'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const f=db.functions.find(x=>x.id===body.functionId),u=db.users.find(x=>x.id===body.userId);
 if(!f||!u||!u.sectors.includes(f.sector)||user.role!=='master'&&!user.sectors.includes(f.sector))return reply(res,403,{error:'Equipe ou função não autorizada'});
 const old=db.skills.find(s=>s.userId===u.id&&s.functionId===f.id);
 if(old)old.approved=body.approved===true;else db.skills.push({userId:u.id,functionId:f.id,approved:body.approved===true});
 db.audit.push({at:new Date().toISOString(),actor:user.id,action:'skill_validation',target:u.id,functionId:f.id,approved:body.approved===true});await store.save(db);return reply(res,200,{ok:true});
}
if(url.pathname==='/api/unavailability'&&req.method==='POST'){
 const from=String(body.from||''),to=String(body.to||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to)))return reply(res,400,{error:'Datas inválidas'});
 db.unavailability.push({id:id(),userId:user.id,from,to});db.audit.push({at:new Date().toISOString(),actor:user.id,action:'unavailability_create'});await store.save(db);return reply(res,201,{ok:true});
}
if(url.pathname==='/api/schedule/preview'&&req.method==='POST'){
 if(!['master','general'].includes(user.role))return reply(res,403,{error:'Sem permissão'});
 const eventIds=Array.isArray(body.eventIds)?body.eventIds.filter(x=>db.events.some(e=>e.id===x&&(user.role==='master'||e.sectors.some(s=>user.sectors.includes(s))))).slice(0,200):[];
 if(!eventIds.length)return reply(res,400,{error:'Selecione eventos autorizados'});
 const result=propose(db,eventIds),proposal={id:id(),createdBy:user.id,createdAt:new Date().toISOString(),status:'draft',...result};db.proposals.push(proposal);await store.save(db);return reply(res,201,{proposal});
}
if(url.pathname==='/api/schedule/proposals'&&req.method==='GET')return reply(res,200,{proposals:db.proposals.filter(p=>user.role==='master'||p.createdBy===user.id)});
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
 const p=db.proposals.find(p=>p.id===body.proposalId&&p.status==='draft'&&(user.role==='master'||p.createdBy===user.id));if(!p)return reply(res,404,{error:'Proposta não encontrada'});
 const applied=[],skipped=[];
 for(const a of p.proposed){const e=db.events.find(e=>e.id===a.eventId),f=db.functions.find(f=>f.sector===a.sector&&f.name===a.functionName),u=db.users.find(u=>u.id===a.userId);
  if(!e||!f||!u||a.sector==='transmissao'&&e.transmission!=='yes'||!db.skills.some(s=>s.userId===u.id&&s.functionId===f.id&&s.approved)||db.unavailability.some(x=>x.userId===u.id&&e.date>=x.from&&e.date<=x.to)||db.assignments.some(x=>x.eventId===e.id&&(x.sector===a.sector&&x.functionName===a.functionName||x.userId===u.id))){skipped.push(a);continue}
  const record={...a,id:id(),proposal:false,createdAt:new Date().toISOString()};db.assignments.push(record);applied.push(record);
 }
 p.status='reviewed';p.reviewedBy=user.id;p.reviewedAt=new Date().toISOString();db.audit.push({at:p.reviewedAt,actor:user.id,action:'schedule_approval',target:p.id,applied:applied.length,skipped:skipped.length});await store.save(db);return reply(res,200,{applied,skipped});
}
// V8: agenda e escalas manuais, sem ativação automática por padrão.
if(url.pathname==='/api/events'&&req.method==='GET'){
 const visible=db.events.filter(e=>user.role==='master'||e.sectors.some(x=>user.sectors.includes(x)));
 const assignments=db.assignments.filter(a=>visible.some(e=>e.id===a.eventId));
 return reply(res,200,{events:visible,assignments});
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
 const current=db.assignments.find(x=>x.eventId===e.id&&x.sector===sector&&x.functionName===functionName);
 const old=current?{userId:current.userId}:null;
 if(current){current.userId=u.id;current.updatedAt=new Date().toISOString()}else db.assignments.push({id:id(),eventId:e.id,sector,functionName,userId:u.id,createdAt:new Date().toISOString()});
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
const file=url.pathname==='/'?'index.html':url.pathname.slice(1);const full=path.resolve(ROOT,'public',file);if(!full.startsWith(path.resolve(ROOT,'public')+path.sep))return res.writeHead(403).end();fs.readFile(full,(err,data)=>{if(err)return res.writeHead(404).end('Não encontrado');res.writeHead(200,{'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com https://i9.ytimg.com; connect-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",'Content-Type':full.endsWith('.html')?'text/html; charset=utf-8':full.endsWith('.js')?'application/javascript; charset=utf-8':full.endsWith('.css')?'text/css; charset=utf-8':full.endsWith('.png')?'image/png':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Cross-Origin-Resource-Policy':'same-origin'});res.end(data)})}).listen(PORT,()=>console.log(`Betel Equipes: http://localhost:${PORT}`));
