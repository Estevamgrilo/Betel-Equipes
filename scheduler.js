// V12: sugestões determinísticas, sem publicação automática.
// A experiência é específica por função (skills.level) e nunca substitui habilitação aprovada.
const levels={estagiario:0,iniciante:1,intermediario:2,avancado:3,diretor:4};
const rankLevel=s=>levels[String(s?.level||'iniciante').toLowerCase()]??1;
const eventTime=e=>Date.parse(`${e.date}T${e.time}:00-03:00`);
export function propose(db,eventIds){
 const events=(db.events||[]).filter(e=>eventIds.includes(e.id)).sort((a,b)=>eventTime(a)-eventTime(b));
 const all=[...(db.assignments||[])],proposed=[],warnings=[];
 const skills=db.skills||[],functions=db.functions||[],absences=db.unavailability||[];
 for(const e of events){
  for(const f of functions.filter(f=>e.sectors?.includes(f.sector)&&f.automatic===true)){
   if(f.sector==='transmissao'&&e.transmission!=='yes')continue;
   if(all.some(a=>a.eventId===e.id&&a.sector===f.sector&&a.functionName===f.name))continue;
   const eligible=(db.users||[]).filter(u=>{
    if(!u.sectors?.includes(f.sector))return false;
    if(!skills.some(s=>s.userId===u.id&&s.functionId===f.id&&s.approved===true))return false;
    if(absences.some(a=>a.userId===u.id&&e.date>=a.from&&e.date<=a.to))return false;
    return !all.some(a=>{if(a.userId!==u.id)return false;const other=(db.events||[]).find(x=>x.id===a.eventId);return other&&Math.abs(eventTime(e)-eventTime(other))<12*3600000});
   });
   const current=all.filter(a=>a.eventId===e.id&&a.sector===f.sector);
   const teamLevels=current.map(a=>{const fn=functions.find(x=>x.sector===a.sector&&x.name===a.functionName);return rankLevel(skills.find(s=>s.userId===a.userId&&s.functionId===fn?.id))});
   const hasMentor=teamLevels.some(n=>n>=3);
   const needsMentor=teamLevels.some(n=>n<=1);
   const score=u=>{
    const history=all.filter(a=>a.userId===u.id).map(a=>(db.events||[]).find(x=>x.id===a.eventId)).filter(Boolean);
    const prior=history.filter(x=>eventTime(x)<eventTime(e));
    const recent=prior.filter(x=>eventTime(e)-eventTime(x)<14*86400000).length;
    const sameDay=history.filter(x=>x.date===e.date).length;
    const s=skills.find(x=>x.userId===u.id&&x.functionId===f.id),lvl=rankLevel(s);
    // Balance first, then pair less experienced people with an experienced mentor.
    return prior.length*10+recent*25+sameDay*30+(needsMentor&&!hasMentor&&lvl<3?60:0)+(hasMentor&&lvl>=3?5:0);
   };
   eligible.sort((a,b)=>score(a)-score(b)||a.id.localeCompare(b.id));
   if(!eligible.length){warnings.push({eventId:e.id,functionId:f.id,message:'Sem voluntário habilitado e disponível'});continue}
   const chosen=eligible[0];const a={id:`preview-${e.id}-${f.id}`,eventId:e.id,sector:f.sector,functionName:f.name,userId:chosen.id,proposal:true};proposed.push(a);all.push(a);
  }
  // Alert only: don't block valid trainees or invent a mentor for a function.
  for(const sector of e.sectors||[]){
   const assigned=all.filter(a=>a.eventId===e.id&&a.sector===sector);
   const lvls=assigned.map(a=>{const f=functions.find(x=>x.sector===a.sector&&x.name===a.functionName);return rankLevel(skills.find(s=>s.userId===a.userId&&s.functionId===f?.id))});
   if(lvls.some(n=>n<=1)&&!lvls.some(n=>n>=3))warnings.push({eventId:e.id,sector,message:'Equipe com iniciante/estagiário sem mentor avançado; revisar antes de aprovar'});
  }
 }
 return {proposed,warnings};
}
