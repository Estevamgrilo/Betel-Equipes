// PostgreSQL document store for incremental migration of the V16 JSON data model.
// Serialized application requests must be enforced before multi-instance deployment.
export async function createStore({databaseUrl,localLoad,localSave}) {
  if (!databaseUrl) {
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
    return {mode:'local-json',load:async()=>localLoad(),save:async data=>localSave(data)};
  }
  let pg;
  try { pg=await import('pg'); } catch { throw new Error('Install dependencies with npm install before enabling PostgreSQL'); }
  const pool=new pg.default.Pool({connectionString:databaseUrl,ssl:process.env.PGSSL==='require'?{rejectUnauthorized:true}:undefined,max:5});
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
    id integer PRIMARY KEY CHECK (id = 1),
    payload jsonb NOT NULL,
    revision bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query('INSERT INTO app_state(id,payload) VALUES (1,$1::jsonb) ON CONFLICT (id) DO NOTHING',[JSON.stringify(localLoad())]);
  let revision=null;
  return {
    mode:'postgresql',
    async load(){const r=await pool.query('SELECT payload, revision FROM app_state WHERE id=1');revision=Number(r.rows[0].revision);return r.rows[0].payload},
    async save(data){
      const r=await pool.query('UPDATE app_state SET payload=$1::jsonb,revision=revision+1,updated_at=now() WHERE id=1 AND revision=$2 RETURNING revision',[JSON.stringify(data),revision]);
      if(r.rowCount!==1)throw new Error('Concurrent modification detected; reload and retry');
      revision=Number(r.rows[0].revision);
    },
    close:()=>pool.end()
  };
}
