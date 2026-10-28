// Ciclos contínuos de 60 dias, com preparação no dia 45.
const DAY=86400000;
export const dateUTC=s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('Data inválida');const n=Date.parse(s+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==s)throw Error('Data inválida');return n};
export const iso=n=>new Date(n).toISOString().slice(0,10);
export function cycleWindow(anchor,index){const start=dateUTC(anchor)+index*60*DAY;return {index,start:iso(start),end:iso(start+59*DAY),generateOn:iso(start-15*DAY)};}
export function dueCycles(anchor,today,existing=[],limit=100){const now=dateUTC(today),base=dateUTC(anchor);if(now<base-15*DAY)return [];const max=Math.min(limit,Math.floor((now-base+15*DAY)/(60*DAY))+1);const known=new Set(existing.map(c=>c.index));return Array.from({length:max},(_,i)=>cycleWindow(anchor,i)).filter(c=>!known.has(c.index)&&dateUTC(c.generateOn)<=now);}
