import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { TeamStore } from '../build/team/store.js';
import { TeamProvider, ClickUpOAuth, OpenAIClients, SESSION_COOKIE } from '../build/team/provider.js';
import { TeamTools } from '../build/team/tools.js';
import { createTeamApp } from '../build/team/app.js';
import { challenge, randomToken, digest, CLIENTS } from '../build/team/security.js';
import { allTools } from '../build/v4/server.js';
import { ClickUpHttp } from '../build/v4/core/http.js';

const enabled=!!process.env.TEAM_TEST_DATABASE_URL;
const dbtest=(name,fn)=>test(name,{skip:!enabled},fn);
const schema='team_test_'+randomUUID().replaceAll('-','');
const key=Buffer.alloc(32,9),ownerId='61768248',resource='https://team.example/mcp';
const client={client_id:CLIENTS[0],redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],token_endpoint_auth_method:'none'};
const config={databaseUrl:process.env.TEAM_TEST_DATABASE_URL,key,ownerId,resource,origin:'https://team.example',issuer:'https://team.example/',clientId:'fake-client',clientSecret:'fake-secret',port:10000};
let root,pool,store,provider,tools,httpServer,base;
const calls=[];
const stub=async(url,init)=>{
  const token=init?.headers?.Authorization;
  calls.push({url:String(url),token,method:init?.method});
  const who=token==='Bearer token-owner'?'owner':token==='Bearer token-other'?'other':'unknown';
  const send=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if(String(url).endsWith('/oauth/token'))return send({access_token:JSON.parse(init.body).code==='owner-code'?'token-owner':'token-other'});
  if(String(url).endsWith('/user'))return send({user:{id:who==='owner'?ownerId:'2',username:who,email:who+'@example.test'}});
  if(String(url).endsWith('/team'))return send({teams:[{id:who==='owner'?'100':'200',name:who}]});
  if(String(url).includes('/private-owner')&&who!=='owner')return send({ECODE:'OAUTH_027',err:'not authorized'},401);
  return send({who,private:who+'-private-data'});
};
before(async()=>{
  if(!enabled)return;
  root=new Pool({connectionString:process.env.TEAM_TEST_DATABASE_URL});
  await root.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:process.env.TEAM_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  store=new TeamStore(pool,key,ownerId);await store.migrate();
  const clickup=new ClickUpOAuth(config,stub);
  provider=new TeamProvider(store,config,clickup,new OpenAIClients(async id=>new Response(JSON.stringify({
    client_id:id,redirect_uris:id===CLIENTS[0]?client.redirect_uris:['http://127.0.0.1/callback','http://localhost/callback'],token_endpoint_auth_methods_supported:['none']
  }))));
  tools=new TeamTools(store,clickup,stub);
  const app=createTeamApp(config,store,provider,tools);
  httpServer=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  base=`http://127.0.0.1:${httpServer.address().port}`;
});
after(async()=>{
  if(!enabled)return;
  if(httpServer)await new Promise(resolve=>httpServer.close(resolve));
  if(pool)await pool.end();
  if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});
async function login(id=ownerId,token='token-owner',name='Owner'){
  return store.saveLogin({id,name,email:name+'@example.test'},token);
}
async function codeFor(user,overrides={}){
  const verifier=randomToken()+'a',browser=randomToken();
  const payload={purpose:'mcp',clientId:client.client_id,redirectUri:client.redirect_uris[0],codeChallenge:challenge(verifier),scopes:['clickup:core','offline_access'],resource,...overrides};
  const transaction=await store.saveConsentTransaction(payload,browser,user.id);
  const {code}=await store.issueCode(transaction,browser,user,user.id===ownerId?'100':'200');
  return {code,verifier,browser,transaction};
}
async function grant(user){
  const {code,verifier}=await codeFor(user);
  return provider.exchangeAuthorizationCode(client,code,verifier,client.redirect_uris[0],new URL(resource));
}

dbtest('state is browser-bound, single use, and expires',async()=>{
  const state=await store.startTransaction({purpose:'account'},'browser');
  assert.equal(await store.takeCallback(state,'attacker'),null);
  assert.equal((await store.takeCallback(state,'browser')).purpose,'account');
  assert.equal(await store.takeCallback(state,'browser'),null);
  const expired=await store.startTransaction({purpose:'account'},'browser');
  await pool.query('UPDATE team_transactions SET expires_at=now()-interval \'1 second\' WHERE id=$1',[digest(expired)]);
  assert.equal(await store.takeCallback(expired,'browser'),null);
});
dbtest('only immutable owner ID bootstraps approval; profiles cannot grant ownership',async()=>{
  const owner=await login();assert.equal(owner.status,'approved');
  const other=await login('2','token-other','Owner');assert.equal(other.status,'pending');
  await assert.rejects(store.setStatus('2',ownerId,'approved'),/Owner/);
  await assert.rejects(store.setStatus(ownerId,ownerId,'disabled'),/Owner/);
  const pending=await store.saveConsentTransaction({purpose:'mcp'},'browser','2');
  await assert.rejects(store.issueCode(pending,'browser',other,'200'),/approved/);
  await store.setStatus(ownerId,'2','approved');
  assert.equal(await store.consentTransaction(pending,'browser','2'),undefined);
});
dbtest('authorization code binds client, PKCE, redirect, resource; atomic single use',async()=>{
  const user=await login(),c=await codeFor(user);
  await assert.rejects(provider.exchangeAuthorizationCode(client,c.code,'a'.repeat(43),client.redirect_uris[0],new URL(resource)),/binding/);
  await assert.rejects(provider.exchangeAuthorizationCode(client,c.code,c.verifier,client.redirect_uris[0],new URL('https://other.example/mcp')),/binding/);
  await assert.rejects(provider.exchangeAuthorizationCode(client,c.code,c.verifier,'https://evil.example/callback',new URL(resource)),/invalid/);
  await assert.rejects(provider.exchangeAuthorizationCode({...client,client_id:CLIENTS[1]},c.code,c.verifier,client.redirect_uris[0],new URL(resource)),/invalid/);
  const results=await Promise.allSettled([1,2].map(()=>provider.exchangeAuthorizationCode(client,c.code,c.verifier,client.redirect_uris[0],new URL(resource))));
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  await assert.rejects(store.issueCode(c.transaction,c.browser,user,'100'),/expired/);
  const expired=await codeFor(user);
  await pool.query('UPDATE team_codes SET expires_at=now()-interval \'1 second\' WHERE id=$1',[digest(expired.code)]);
  await assert.rejects(provider.exchangeAuthorizationCode(client,expired.code,expired.verifier,client.redirect_uris[0],new URL(resource)),/expired/);
});
dbtest('rotating refresh families detect reuse and revoke both old and new access',async()=>{
  const user=await login(),g=await grant(user);
  assert.ok(await store.access(g.access_token,resource));
  assert.equal(await store.access(g.access_token,'https://other.example/mcp'),null);
  await assert.rejects(provider.exchangeRefreshToken(client,g.refresh_token,undefined,new URL('https://other.example/mcp')),/resource/);
  const rotated=await provider.exchangeRefreshToken(client,g.refresh_token,undefined,new URL(resource));
  assert.notEqual(rotated.refresh_token,g.refresh_token);
  assert.ok(await store.access(rotated.access_token,resource));
  await assert.rejects(provider.exchangeRefreshToken(client,g.refresh_token,undefined,new URL(resource)),/revoked/);
  assert.equal(await store.access(g.access_token,resource),null);
  assert.equal(await store.access(rotated.access_token,resource),null);
  const replay=await pool.query("SELECT count(*) FROM team_audit WHERE action='refresh_replay'");
  assert.ok(Number(replay.rows[0].count)>0);
});
dbtest('expired access and refresh fail; revocation, disabling and disconnect act immediately',async()=>{
  const user=await login();let g=await grant(user);
  await pool.query('UPDATE team_grants SET expires_at=now()-interval \'1 second\' WHERE id=$1',[digest(g.access_token)]);
  assert.equal(await store.access(g.access_token,resource),null);
  await pool.query('UPDATE team_grants SET family_expires_at=now()-interval \'1 second\' WHERE id=$1',[digest(g.access_token)]);
  assert.equal(await store.refresh(g.refresh_token,client.client_id,resource),null);
  g=await grant(user);await store.revoke(g.access_token,client.client_id);
  assert.equal(await store.access(g.access_token,resource),null);
  let other=await login('2','token-other');other=await store.user('2');
  const session=await store.session(other),og=await grant(other);
  await store.setStatus(ownerId,'2','disabled');
  assert.equal(await store.access(og.access_token,resource),null);assert.equal(await store.sessionUser(session),null);
  await assert.rejects(login('2','token-other'),/disabled/);
  assert.equal((await store.user('2')).credential,null);
  await store.setStatus(ownerId,'2','approved');other=await login('2','token-other');
  const dg=await grant(other);await store.disconnect('2');
  assert.equal(await store.access(dg.access_token,resource),null);assert.equal((await store.user('2')).credential,null);
});
dbtest('database stores encrypted credentials and hashed grants; wrong encryption key fails closed',async()=>{
  const owner=await login(),g=await grant(owner);
  const serialized=JSON.stringify((await pool.query('SELECT * FROM team_grants')).rows);
  assert.ok(!serialized.includes(g.access_token));assert.ok(!serialized.includes(g.refresh_token));
  assert.ok(!owner.credential.includes('token-owner'));assert.equal(store.token(owner),'token-owner');
  const restarted=new TeamStore(pool,key,ownerId);await restarted.migrate();assert.ok(await restarted.access(g.access_token,resource));
  await assert.rejects(new TeamStore(pool,Buffer.alloc(32,1),ownerId).migrate());
});
dbtest('simultaneous callers use only their own credentials and request-local caches',async()=>{
  const owner=await login(),other=await login('2','token-other');
  const identities=[{user:owner,workspaceId:'100',clientId:client.client_id,family:'a'},
    {user:other,workspaceId:'200',clientId:client.client_id,family:'b'}];
  const probe={name:'probe',schema:{},description:'test',handler:async(_args,ctx)=>{
    ctx.cache.set('same-key',ctx.workspaceId);
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(ctx.cache.get('same-key'),ctx.workspaceId);
    const result=await ctx.http.get('/probe');return JSON.stringify(result);
  }};
  calls.length=0;
  const results=await Promise.all(identities.flatMap(identity=>[1,2,3].map(()=>tools.execute(probe,{},identity))));
  assert.ok(results.slice(0,3).every(text=>text.includes('owner-private-data')));
  assert.ok(results.slice(3).every(text=>text.includes('other-private-data')));
  assert.ok(calls.every(call=>['Bearer token-owner','Bearer token-other'].includes(call.token)));
  const before=calls.length;
  await assert.rejects(tools.execute(probe,{workspace_id:'100'},identities[1]),/authorized workspace/);
  assert.equal(calls.length,before+1); // Workspace verification only, no resource operation.
  await assert.rejects(tools.execute({...probe,handler:async(_a,ctx)=>JSON.stringify(await ctx.http.get('/private-owner'))},{},identities[1]),/not found|cannot see/);
  await assert.rejects(tools.execute(probe,{}, {...identities[0],workspaceId:''}),/authorized workspace/);
  const beforeDelete=calls.length;
  await assert.rejects(tools.execute(probe,{delete:true},identities[0]),/confirm/);
  assert.equal(calls.length,beforeDelete);
  const output=await tools.execute({...probe,handler:async()=> 'token-owner'}, {},identities[0]);
  assert.equal(output,'[redacted]');
  const admin=allTools.find(tool=>tool.name==='people');
  assert.ok(admin); // Registry exists for personal mode, team schema is tested via HTTP below.
});
dbtest('HTTP discovery and SDK endpoints enforce client metadata, PKCE, resource and redirect binding',async()=>{
  const metadata=await (await fetch(base+'/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.client_id_metadata_document_supported,true);
  assert.equal(metadata.authorization_response_iss_parameter_supported,true);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);
  assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported,['none']);
  assert.ok(!metadata.registration_endpoint);
  const authorize={client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',code_challenge:challenge(randomToken()),code_challenge_method:'S256',resource,scope:'clickup:core offline_access',state:'client-state'};
  const request=params=>fetch(base+'/authorize?'+new URLSearchParams(params),{redirect:'manual'});
  assert.equal((await request({...authorize,client_id:'https://evil.example/client.json'})).status,400);
  assert.equal((await request({...authorize,redirect_uri:'https://evil.example/callback'})).status,400);
  assert.equal((await request({...authorize,redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect#bad'})).status,400);
  for(const bad of [{code_challenge_method:'plain'},{resource:'https://evil.example/mcp'}]){
    const response=await request({...authorize,...bad});assert.equal(response.status,302);
    const location=new URL(response.headers.get('location'));assert.ok(location.searchParams.get('error'));assert.equal(location.searchParams.get('iss'),config.issuer);
  }
  const response=await request(authorize);assert.equal(response.status,302);
  assert.equal(new URL(response.headers.get('location')).origin,'https://app.clickup.com');
  assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/i);
  const native=await request({...authorize,client_id:CLIENTS[1],redirect_uri:'http://127.0.0.1:54321/callback'});assert.equal(native.status,302);
  assert.equal((await fetch(base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
  assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer pk_personal'}})).status,401);
  assert.equal((await fetch(base+'/mcp',{headers:{Origin:'https://evil.example'}})).status,403);
});
dbtest('owner-only admin, CSRF, restricted tool discovery, and JSON token exchange',async()=>{
  const owner=await login(),other=await login('2','token-other');
  const ownerCookie=SESSION_COOKIE+'='+await store.session(owner),otherCookie=SESSION_COOKIE+'='+await store.session(other);
  assert.equal((await fetch(base+'/admin')).status,401);
  assert.equal((await fetch(base+'/admin',{headers:{Cookie:otherCookie}})).status,403);
  const admin=await fetch(base+'/admin',{headers:{Cookie:ownerCookie}});assert.equal(admin.status,200);
  const body=await admin.text();assert.ok(!body.includes('token-owner'));assert.ok(!body.includes('fake-secret'));
  assert.equal((await fetch(base+'/admin/users/2/disable',{method:'POST',headers:{Cookie:ownerCookie,Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'csrf=bad'})).status,403);
  const c=await codeFor(owner);
  const token=await fetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:c.code,code_verifier:c.verifier,redirect_uri:client.redirect_uris[0],resource})});
  assert.equal(token.status,200);const g=await token.json();assert.ok(!JSON.stringify(g).includes('token-owner'));
  const mcp=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+g.access_token,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  assert.equal(mcp.status,200);const data=await mcp.json();const names=data.result.tools.map(tool=>tool.name);
  assert.ok(names.includes('workspaces'));assert.ok(names.includes('update'));assert.ok(names.includes('docs'));
  for(const name of ['attach','people','webhooks'])assert.ok(!names.includes(name));
  assert.equal(data.result.tools.find(tool=>tool.name==='update').annotations.destructiveHint,true);
  assert.ok(data.result.tools.find(tool=>tool.name==='update').inputSchema.properties.confirm);
  const revoke=await fetch(base+'/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,token:g.refresh_token})});
  assert.equal(revoke.status,200);assert.equal(await store.access(g.access_token,resource),null);
});

dbtest('browser OAuth callback, consent and disconnect never expose the ClickUp token',async()=>{
  const verifier=randomToken()+'v';
  const start=await fetch(base+'/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0],
    response_type:'code',code_challenge:challenge(verifier),code_challenge_method:'S256',resource,scope:'clickup:core offline_access',state:'opaque-client-state'}),{redirect:'manual'});
  const flowCookie=start.headers.get('set-cookie').split(';')[0];
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const callback=base+'/auth/clickup/callback?'+new URLSearchParams({state,code:'owner-code'});
  assert.equal((await fetch(callback,{redirect:'manual'})).status,400);
  const completed=await fetch(callback,{headers:{Cookie:flowCookie},redirect:'manual'});
  assert.equal(completed.status,302);assert.ok(completed.headers.get('location').startsWith('/consent?id='));
  assert.equal((await fetch(callback,{headers:{Cookie:flowCookie},redirect:'manual'})).status,400);
  const sessionCookie=completed.headers.get('set-cookie').split(';')[0],cookies=flowCookie+'; '+sessionCookie;
  const consent=await fetch(base+completed.headers.get('location'),{headers:{Cookie:cookies}});
  assert.equal(consent.headers.get('referrer-policy'),'strict-origin');
  assert.match(consent.headers.get('content-security-policy'),/form-action 'self' https:\/\/chatgpt\.com http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*;/);
  const html=await consent.text();assert.equal(consent.status,200);assert.ok(!html.includes('token-owner'));
  assert.match(html,/Default workspace/);assert.match(html,/ChatGPT/);
  const csrf=html.match(/name="csrf" value="([^"]+)"/)[1],transaction=new URL(base+completed.headers.get('location')).searchParams.get('id');
  const consentPost=(workspace,origin=config.origin)=>fetch(base+'/consent',{method:'POST',redirect:'manual',headers:{Cookie:cookies,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,transaction,workspace_id:workspace})});
  assert.equal((await consentPost('100','https://evil.example')).status,403);
  assert.equal((await consentPost('200')).status,400);
  const accepted=await consentPost('100');assert.equal(accepted.status,302);
  const redirect=new URL(accepted.headers.get('location'));assert.equal(redirect.searchParams.get('state'),'opaque-client-state');assert.equal(redirect.searchParams.get('iss'),config.issuer);
  assert.ok(!redirect.href.includes('token-owner'));
  const g=await provider.exchangeAuthorizationCode(client,redirect.searchParams.get('code'),verifier,client.redirect_uris[0],new URL(resource));
  const account=await (await fetch(base+'/account',{headers:{Cookie:sessionCookie}})).text();assert.ok(!account.includes('token-owner'));
  const accountCsrf=account.match(/name="csrf" value="([^"]+)"/)[1];
  const disconnected=await fetch(base+'/account/disconnect',{method:'POST',headers:{Cookie:sessionCookie,Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:accountCsrf})});
  assert.equal(disconnected.status,200);assert.equal(await store.access(g.access_token,resource),null);assert.equal((await store.user(ownerId)).credential,null);
});

dbtest('health and errors expose operational status without internal error text',async()=>{
  const broken=createTeamApp(config,{...store,pool:{query:async()=>{throw new Error('secret-token-and-task-content');}}},provider,tools);
  const server=await new Promise(resolve=>{const item=broken.listen(0,'127.0.0.1',()=>resolve(item));});
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/health`);assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{ok:false,mode:'team'});
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('write calls are never retried after an ambiguous server error',async()=>{
  let requests=0;const http=new ClickUpHttp({token:'test',fetchImpl:async()=>{requests++;return new Response('{}',{status:500});},clock:{now:()=>Date.now(),sleep:async()=>{}}});
  await assert.rejects(http.post('/task/123/comment',{comment_text:'test'}));assert.equal(requests,1);
});
