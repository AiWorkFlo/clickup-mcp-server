import { Pool } from 'pg';
import { teamConfig } from './security.js';
import { TeamStore } from './store.js';
import { ClickUpOAuth, TeamProvider } from './provider.js';
import { TeamTools } from './tools.js';
import { createTeamApp } from './app.js';

async function main() {
  const config=teamConfig(),pool=new Pool({connectionString:config.databaseUrl,max:10,connectionTimeoutMillis:5000,statement_timeout:15000});
  const store=new TeamStore(pool,config.key,config.ownerId);
  pool.on('error',()=>console.error('[team] database connection failed'));
  await store.migrate();
  const clickup=new ClickUpOAuth(config),provider=new TeamProvider(store,config,clickup);
  const app=createTeamApp(config,store,provider,new TeamTools(store,clickup));
  const server=app.listen(config.port,'0.0.0.0',()=>console.log('[team] ready; per-user OAuth and approval required'));
  const cleanup=setInterval(()=>void store.cleanup().catch(()=>console.error('[team] cleanup failed')),600000);cleanup.unref();
  const shutdown=()=>{
    clearInterval(cleanup);server.close(()=>void pool.end());
    setTimeout(()=>{server.closeAllConnections();void pool.end();},10000).unref();
  };
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
main().catch(()=>{console.error('[team] startup failed; verify required configuration and database access');process.exitCode=1;});
