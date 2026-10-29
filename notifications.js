// Notificações de escalas: geração idempotente, lembrete D-7 e entrega multicanal.
import crypto from 'node:crypto';
export const ensureNotifications=db=>{db.notifications??=[];db.notificationDeliveries??=[];return db};
const isoDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const addDays=(day,n)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const cleanPhone=phone=>{const n=String(phone||'').replace(/\D/g,'');return n.length===11?'55'+n:n.length===13&&n.startsWith('55')?n:null};
const keyFor=(a,type)=>type+':'+a.id+':'+a.userId+':'+a.eventId;
export function queueAssignmentNotifications(db,{today=isoDate()}={}){
 ensureNotifications(db);let added=0;
 const active=new Set(db.assignments.map(a=>a.id));
 for(const n of db.notifications){if(n.assignmentId&&!active.has(n.assignmentId))n.cancelled=true}
 for(const a of db.assignments){
  const event=db.events.find(e=>e.id===a.eventId),user=db.users.find(u=>u.id===a.userId);
  if(!event||!user||event.date<today)continue;
  const types=['new'];if(event.date===addDays(today,7))types.push('reminder');
  for(const type of types){
   const key=keyFor(a,type);if(db.notifications.some(n=>n.key===key))continue;
   // Escalas antigas não geram avisos de 'nova escala' ao ativar o módulo.
   if(type==='new'&&!a.notificationEligible)continue;
   const n={id:crypto.randomUUID(),key,userId:user.id,assignmentId:a.id,eventId:event.id,type,createdAt:new Date().toISOString(),readAt:null,cancelled:false,title:type==='new'?'Nova escala confirmada':'Sua escala é daqui a 7 dias',message:`${event.title} — ${event.date.split('-').reverse().join('/')} às ${event.time} · ${a.functionName} (${a.sector})`};
   db.notifications.push(n);added++;
   for(const channel of ['email','whatsapp'])db.notificationDeliveries.push({id:crypto.randomUUID(),notificationId:n.id,channel,status:'pending',attempts:0,nextAttempt:0});
  }
 }
 return added;
}
export async function sendPendingNotifications(db){
 ensureNotifications(db);let changed=false;
 for(const job of db.notificationDeliveries.filter(j=>j.status==='pending'&&j.nextAttempt<=Date.now()).slice(0,12)){
  const n=db.notifications.find(n=>n.id===job.notificationId),u=db.users.find(u=>u.id===n?.userId),event=db.events.find(e=>e.id===n?.eventId),assignment=db.assignments.find(a=>a.id===n?.assignmentId);
  if(!n||n.cancelled||!u||!event||!assignment||assignment.userId!==u.id){job.status='cancelled';changed=true;continue}
  const link=(process.env.BETEL_PUBLIC_URL||'https://betel-equipes-staging.onrender.com').replace(/\/$/,'')+'/plataforma.html';
  let configured=false,ok=false;
  try{
   if(job.channel==='email'){
    const key=process.env.RESEND_API_KEY,from=process.env.BETEL_MAIL_FROM;configured=!!(key&&from&&u.email);
    if(configured){const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({from,to:[u.email],subject:'Betel Equipes · '+n.title,text:'Olá, '+u.name+'!\n\n'+n.title+'\n'+n.message+'\n\nAcesse sua escala: '+link}),signal:AbortSignal.timeout(12000));ok=r.ok;if(!ok)console.error('Notificação e-mail HTTP',r.status)}
   }else{
    const key=process.env.WHATSAPP_ACCESS_TOKEN,phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID,template=process.env.WHATSAPP_TEMPLATE_NAME,phone=cleanPhone(u.profile?.phone);
    configured=!!(key&&phoneId&&template&&phone);
    if(configured){const r=await fetch('https://graph.facebook.com/v22.0/'+encodeURIComponent(phoneId)+'/messages',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'template',template:{name:template,language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'pt_BR'},components:[{type:'body',parameters:[{type:'text',text:u.name.slice(0,80)},{type:'text',text:n.title},{type:'text',text:n.message.slice(0,500)}]}]}}),signal:AbortSignal.timeout(12000));ok=r.ok;if(!ok)console.error('Notificação WhatsApp HTTP',r.status)}
   }
  }catch(e){console.error('Falha em notificação',job.channel,e.message)}
  if(!configured){job.status='unconfigured';changed=true;continue}
  job.attempts++;job.status=ok?'sent':job.attempts>=5?'failed':'pending';job.nextAttempt=Date.now()+Math.min(3600000,60000*2**job.attempts);job.updatedAt=new Date().toISOString();changed=true;
 }
 return changed;
}
