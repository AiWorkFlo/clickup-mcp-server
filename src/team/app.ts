import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TeamProvider, cookie, setCookie, FLOW_COOKIE, SESSION_COOKIE } from './provider.js';
import { TeamTools } from './tools.js';
import { html, equal, TTL, safeRedirect, CLIENTS, type TeamConfig } from './security.js';
import type { TeamStore, TeamUser } from './store.js';

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)} | ClickUp Team</title>
  <style>body{font:16px system-ui,sans-serif;background:#f4f6fa;color:#18233b;margin:0;padding:32px 16px}main{max-width:850px;margin:auto;background:white;padding:32px;border-radius:12px}h1{margin-top:0}p{line-height:1.6}a{color:#304ab5}button{background:#304ab5;color:white;border:0;border-radius:6px;padding:12px 18px;cursor:pointer}button.secondary{background:#704448}input,select{padding:10px;max-width:100%}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}form{margin:12px 0}nav{margin-bottom:24px}small{color:#596175}.status{padding:12px;background:#eef2fa;border-radius:6px}</style></head>
  <body><main><nav><a href="/account">My account</a> · <a href="/admin">Team approval</a></nav><h1>${html(title)}</h1>${body}</main></body></html>`;
}
export function createTeamApp(config: TeamConfig, store: TeamStore, provider: TeamProvider, tools: TeamTools) {
  const app=express();
  app.disable('x-powered-by');
  // Coolify's proxy is the only ingress to this container.
  app.set('trust proxy',1);
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Strict-Transport-Security':'max-age=31536000'});
    next();
  });
  app.use(express.urlencoded({extended:false,limit:'16kb'}));
  app.use(express.json({limit:'1mb'}));
  const attempts=new Map<string,{count:number;until:number}>();
  app.use((req,res,next)=>{
    if(req.path==='/health') return next();
    const key=req.ip??req.socket.remoteAddress??'unknown',now=Date.now();
    if(attempts.size>10000) for(const [id,row] of attempts) if(row.until<now) attempts.delete(id);
    const old=attempts.get(key),row=old&&old.until>now?old:{count:0,until:now+60000};
    row.count++; attempts.set(key,row);
    if(row.count>300) { res.set('Retry-After','60').status(429).json({error:'rate_limited'}); return; }
    next();
  });
  const csrf=(session: string)=>crypto.createHmac('sha256',config.key).update(`csrf:${session}`).digest('base64url');
  async function requireSession(req: Request,res: Response,post=false): Promise<TeamUser|null> {
    const session=cookie(req.headers.cookie,SESSION_COOKIE),user=session?await store.sessionUser(session):null;
    if(!user) { res.status(401).send(page('Sign in','<p>Sign in through ClickUp to continue.</p><a href="/login">Connect ClickUp</a>')); return null; }
    if(post && (req.headers.origin!==config.origin || typeof req.body.csrf!=='string' || !equal(req.body.csrf,csrf(session)))) {
      res.status(403).send(page('Request rejected','<p>The form expired or came from another site. Reload the page.</p>')); return null;
    }
    return user;
  }
  const csrfField=(req: Request)=>`<input type="hidden" name="csrf" value="${html(csrf(cookie(req.headers.cookie,SESSION_COOKIE)))}">`;
  app.get('/health',async(_req,res)=>{
    try { await store.pool.query('SELECT 1'); res.json({ok:true,mode:'team',version:'4.3.1-team',profile:'core',tools_enabled:true}); }
    catch { res.status(503).json({ok:false,mode:'team'}); }
  });
  app.get('/',(_req,res)=>res.redirect('/account'));
  app.get('/login',async(_req,res)=>provider.begin({purpose:'account'},res));
  app.get('/auth/clickup/callback',async(req,res)=>{
    const state=typeof req.query.state==='string'?req.query.state:'',browser=cookie(req.headers.cookie,FLOW_COOKIE);
    if(!state||!browser) { res.status(400).send(page('Connection expired','<p>Restart the connection from your app.</p>')); return; }
    const payload=await store.takeCallback(state,browser);
    if(!payload) { res.status(400).send(page('Connection expired','<p>This connection has expired or was already used. Restart it.</p>')); return; }
    if(req.query.error||typeof req.query.code!=='string') { res.status(400).send(page('Connection cancelled','<p>No account was connected. You can retry from your app.</p>')); return; }
    try {
      const token=await provider.clickup.exchange(req.query.code), identity=await provider.clickup.identity(token);
      // A successful identity response is insufficient if no workspace was authorized.
      const workspaces=await provider.clickup.workspaces(token);
      if(!workspaces.length) throw new Error('No workspace authorized.');
      const user=await store.saveLogin(identity,token),session=await store.session(user);
      setCookie(res,SESSION_COOKIE,session,TTL.session);
      if(user.status!=='approved'||payload.purpose==='account') { res.redirect('/account'); return; }
      const consent=await store.saveConsentTransaction(payload,browser,user.id);
      res.redirect(`/consent?id=${encodeURIComponent(consent)}`);
    } catch { res.status(403).send(page('Connection unavailable','<p>ClickUp authorization failed or this account is disabled. Retry or contact Joshua.</p>')); }
  });
  app.get('/account',async(req,res)=>{
    const user=await requireSession(req,res); if(!user)return;
    let workspaces: import('./provider.js').Workspace[]=[];
    if(user.credential) workspaces=await provider.clickup.workspaces(store.token(user)).catch(()=>[]);
    res.send(page('My ClickUp connection',`<p>Signed in as <strong>${html(user.name)}</strong> (${html(user.email)}).</p>
      <p class="status">Team access: <strong>${html(user.status)}</strong></p>
      ${user.status==='pending'?'<p>Your account needs Joshua’s approval. After approval, reconnect from ChatGPT or Codex.</p>':''}
      <p>Authorized workspaces: ${workspaces.map(workspace=>html(workspace.name)).join(', ')||'Reconnect to verify workspace access.'}</p>
      <p>Only your own ClickUp permissions apply. Your ClickUp password is never collected by this service.</p>
      <form method="post" action="/account/disconnect">${csrfField(req)}<button class="secondary">Disconnect and revoke this plugin’s access</button></form>`));
  });
  app.post('/account/disconnect',async(req,res)=>{
    const user=await requireSession(req,res,true); if(!user)return;
    await store.disconnect(user.id); setCookie(res,SESSION_COOKIE,'',0);
    res.send(page('Disconnected','<p>Your saved ClickUp credential was deleted and plugin sessions were revoked.</p><a href="/login">Connect again</a>'));
  });
  app.get('/consent',async(req,res)=>{
    const user=await requireSession(req,res); if(!user)return;
    const id=typeof req.query.id==='string'?req.query.id:'',payload=await store.consentTransaction(id,cookie(req.headers.cookie,FLOW_COOKIE),user.id);
    if(!payload||user.status!=='approved') {res.status(403).send(page('Connection unavailable','<p>Your approval or connection has expired. Reconnect from your app.</p>'));return;}
    const workspaces=await provider.clickup.workspaces(store.token(user));
    res.send(page('Approve this connection',`<p>Connect <strong>${payload.clientId?.includes('/codex/')?'Codex':'ChatGPT'}</strong> as <strong>${html(user.name)}</strong> (${html(user.email)}).</p>
      <p>This connection can read and manage tasks, comments, lists, checklists, fields, goals, chat, and time entries within your ClickUp permissions. Deletions require confirmation. Membership administration and server file access are unavailable.</p>
      <p>${payload.scopes?.includes('offline_access')?'Stay connected for up to 30 days. You can revoke access at any time.':'This connection expires after 15 minutes.'}</p>
      <form method="post" action="/consent">${csrfField(req)}<input type="hidden" name="transaction" value="${html(id)}">
      <label>Default workspace <select name="workspace_id" required><option value="">Choose a workspace</option>${workspaces.map(workspace=>`<option value="${html(workspace.id)}">${html(workspace.name)}</option>`).join('')}</select></label>
      <p>You can select another authorized workspace in tool requests.</p><button>Approve connection</button></form>
      <a href="/account">Cancel</a>`));
  });
  app.post('/consent',async(req,res)=>{
    const user=await requireSession(req,res,true); if(!user)return;
    const workspaces=await provider.clickup.workspaces(store.token(user));
    if(typeof req.body.workspace_id!=='string'||!workspaces.some(workspace=>workspace.id===req.body.workspace_id)||typeof req.body.transaction!=='string') {
      res.status(400).send(page('Choose a workspace','<p>Select a workspace authorized in ClickUp.</p>'));return;
    }
    const {code,payload}=await store.issueCode(req.body.transaction,cookie(req.headers.cookie,FLOW_COOKIE),user,req.body.workspace_id);
    const redirect=new URL(payload.redirectUri!);redirect.searchParams.set('code',code);redirect.searchParams.set('iss',config.issuer);
    if(payload.state!==undefined)redirect.searchParams.set('state',payload.state);
    res.redirect(redirect.href);
  });
  app.get('/admin',async(req,res)=>{
    const user=await requireSession(req,res);if(!user)return;
    if(user.id!==config.ownerId||user.status!=='approved'){res.status(403).send(page('Owner access required','<p>Only Joshua can approve or disable teammates.</p>'));return;}
    const users=await store.users();
    res.send(page('Team approval',`<p>Approve only ClickUp accounts you recognize. Approval grants access to this plugin, not additional ClickUp permissions.</p>
      <table><thead><tr><th>ClickUp account</th><th>Status</th><th>Action</th></tr></thead><tbody>${users.map(member=>`<tr><td>${html(member.name)}<br><small>${html(member.email)} · ID ${html(member.id)}</small></td><td>${html(member.status)}</td><td>${member.id===config.ownerId?'Owner':
        `<form method="post" action="/admin/users/${encodeURIComponent(member.id)}/approve">${csrfField(req)}<button>Approve</button></form>
        <form method="post" action="/admin/users/${encodeURIComponent(member.id)}/disable">${csrfField(req)}<button class="secondary">Disable</button></form>`}</td></tr>`).join('')}</tbody></table>`));
  });
  app.post('/admin/users/:id/:action',async(req,res)=>{
    const user=await requireSession(req,res,true);if(!user)return;
    if(user.id!==config.ownerId||user.status!=='approved'||!['approve','disable'].includes(String(req.params.action))){res.status(403).send(page('Owner access required','<p>This action is unavailable.</p>'));return;}
    await store.setStatus(user.id,String(req.params.id),req.params.action==='approve'?'approved':'disabled');res.redirect('/admin');
  });
  const authOptions={provider,issuerUrl:new URL(config.issuer),resourceServerUrl:new URL(config.resource),scopesSupported:['clickup:core','offline_access']};
  const metadata={...createOAuthMetadata(authOptions),client_id_metadata_document_supported:true,authorization_response_iss_parameter_supported:true};
  app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json(metadata));
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(_req,res)=>res.json({
    resource:config.resource,authorization_servers:[config.issuer],scopes_supported:['clickup:core','offline_access'],bearer_methods_supported:['header'],resource_name:'ClickUp Team'}));
  // Include RFC 9207 issuer identification on the SDK's error redirects as well as successes.
  app.use('/authorize',async(req,res,next)=>{
    const input=req.method==='POST'?req.body:req.query;
    try {
      const client=typeof input.client_id==='string'?await provider.clientsStore.getClient(input.client_id):undefined;
      if(!client || (input.redirect_uri!==undefined && (typeof input.redirect_uri!=='string' ||
        !safeRedirect(input.redirect_uri,client.redirect_uris,client.client_id===CLIENTS[1])))) {
        res.status(400).json({error:'invalid_request'});return;
      }
    } catch {res.status(503).json({error:'temporarily_unavailable'});return;}
    const redirect=res.redirect.bind(res);
    res.redirect=((statusOrUrl: number|string,url?: string)=>{
      const target=new URL(typeof statusOrUrl==='string'?statusOrUrl:url!,config.origin);
      if(target.origin!==config.origin&&target.origin!=='https://app.clickup.com')target.searchParams.set('iss',config.issuer);
      return typeof statusOrUrl==='string'?redirect(target.href):redirect(statusOrUrl,target.href);
    }) as Response['redirect'];next();
  });
  app.use(mcpAuthRouter(authOptions));
  app.all('/mcp',async(req,res)=>{
    if(req.headers.origin && ![config.origin,'https://chatgpt.com'].includes(req.headers.origin)) {
      res.status(403).json({error:'invalid_origin'});return;
    }
    const raw=/^Bearer[ \t]+([A-Za-z0-9_-]+)$/i.exec(req.headers.authorization??'')?.[1];
    const identity=raw?await store.access(raw,config.resource):null;
    if(!identity){res.set('WWW-Authenticate',`Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp", scope="clickup:core"`)
      .status(401).json({error:'unauthorized'});return;}
    if(req.method!=='POST'){res.set('Allow','POST').status(405).end();return;}
    const server=tools.server(identity),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    await server.connect(transport);await transport.handleRequest(req,res,req.body);
  });
  app.use((_req,res)=>res.status(404).json({error:'not_found'}));
  app.use((error: unknown,_req: Request,res: Response,_next: NextFunction)=>{
    // Never log exception messages: network/parser/SQL errors can contain credentials or input.
    console.error('[team] request failed');
    if(!res.headersSent)res.status(500).send(page('Request unavailable','<p>The request could not be completed. Retry or contact Joshua.</p>'));
  });
  return app;
}
