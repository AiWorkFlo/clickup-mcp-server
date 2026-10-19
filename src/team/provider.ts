import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, InvalidRequestError, InvalidScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { CLIENTS, challenge, equal, randomToken, TTL, type TeamConfig } from './security.js';
import { TeamStore, type TeamUser } from './store.js';

export interface Workspace { id: string; name: string }
export class ClickUpOAuth {
  constructor(readonly config: TeamConfig, readonly fetchImpl: typeof fetch = fetch) {}
  private async request(path: string, token?: string, body?: Record<string,string>) {
    const response=await this.fetchImpl(`https://api.clickup.com/api/v2${path}`, {
      method: body?'POST':'GET', redirect:'error', signal:AbortSignal.timeout(20000),
      headers: body?{'Content-Type':'application/json'}:{Authorization:`Bearer ${token}`,Accept:'application/json'},
      body:body?JSON.stringify(body):undefined,
    });
    if(!response.ok) throw new Error('ClickUp authorization failed. Reconnect your account.');
    return response.json();
  }
  async exchange(code: string): Promise<string> {
    const result=await this.request('/oauth/token',undefined,{client_id:this.config.clientId,client_secret:this.config.clientSecret,code});
    if(typeof result.access_token!=='string'||!result.access_token||/[\r\n]/.test(result.access_token)) throw new Error('ClickUp returned no usable token.');
    return result.access_token;
  }
  async identity(token: string): Promise<{id:string;name:string;email:string}> {
    const result=await this.request('/user',token), user=result.user;
    if(!user?.id || !/^\d+$/.test(String(user.id))) throw new Error('ClickUp identity could not be verified.');
    return {id:String(user.id),name:String(user.username??user.email??user.id),email:String(user.email??'')};
  }
  async workspaces(token: string): Promise<Workspace[]> {
    const result=await this.request('/team',token);
    if(!Array.isArray(result.teams)) throw new Error('ClickUp workspace access could not be verified.');
    return result.teams.map((team: {id:string|number;name:string})=>({id:String(team.id),name:String(team.name)}));
  }
}

export class OpenAIClients {
  private cache=new Map<string,{client:OAuthClientInformationFull;until:number}>();
  constructor(readonly fetchImpl: typeof fetch=fetch) {}
  async getClient(id: string): Promise<OAuthClientInformationFull|undefined> {
    if(!CLIENTS.includes(id)) return undefined;
    const cached=this.cache.get(id); if(cached && cached.until>Date.now()) return cached.client;
    const response=await this.fetchImpl(id,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
    if(!response.ok) throw new Error('Client metadata is unavailable.');
    const data=await response.json();
    if(data.client_id!==id || !Array.isArray(data.redirect_uris) || !data.redirect_uris.length ||
      !Array.isArray(data.token_endpoint_auth_methods_supported) || !data.token_endpoint_auth_methods_supported.includes('none')) {
      throw new Error('Client metadata is invalid.');
    }
    const native=id===CLIENTS[1];
    if(data.redirect_uris.some((raw: unknown)=>{
      if(typeof raw!=='string') return true;
      const u=new URL(raw);
      return u.username||u.password||u.hash||u.search|| (native
        ? !(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)&&u.pathname==='/callback'&&!u.port)
        : !(u.protocol==='https:'&&u.hostname==='chatgpt.com'&&!u.port&&u.pathname==='/connector_platform_oauth_redirect'));
    })) throw new Error('Client redirect metadata is invalid.');
    const client: OAuthClientInformationFull={client_id:id,client_name:native?'Codex':'ChatGPT',
      redirect_uris:data.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']};
    this.cache.set(id,{client,until:Date.now()+600000}); return client;
  }
}
export function cookie(value: string|undefined,name: string): string {
  return (value??'').split(';').map(part=>part.trim()).find(part=>part.startsWith(name+'='))?.slice(name.length+1)??'';
}
export const FLOW_COOKIE='__Host-clickup-flow', SESSION_COOKIE='__Host-clickup-session';
export function setCookie(res: Response,name: string,value: string,seconds: number): void {
  res.cookie(name,value,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:seconds*1000});
}

export class TeamProvider implements OAuthServerProvider {
  readonly clientsStore: OpenAIClients;
  // The provider verifies S256 itself so the SDK passes the verifier to the atomic grant flow.
  readonly skipLocalPkceValidation=true;
  constructor(readonly store: TeamStore,readonly config: TeamConfig, readonly clickup: ClickUpOAuth,clients?: OpenAIClients) {
    this.clientsStore=clients??new OpenAIClients();
  }
  async begin(payload: import('./store.js').AuthorizationTransaction,res: Response): Promise<void> {
    const browser=cookie(res.req.headers.cookie,FLOW_COOKIE)||randomToken();
    setCookie(res,FLOW_COOKIE,browser,TTL.transaction);
    const session=cookie(res.req.headers.cookie,SESSION_COOKIE), user=session?await this.store.sessionUser(session):null;
    if(payload.purpose==='mcp'&&user?.status==='approved'&&user.credential) {
      const id=await this.store.saveConsentTransaction(payload,browser,user.id);
      res.redirect(`/consent?id=${encodeURIComponent(id)}`); return;
    }
    const state=await this.store.startTransaction(payload,browser);
    const upstream=new URL('https://app.clickup.com/api');
    upstream.searchParams.set('client_id',this.config.clientId);
    upstream.searchParams.set('redirect_uri',`${this.config.origin}/auth/clickup/callback`);
    upstream.searchParams.set('state',state);
    res.redirect(upstream.href);
  }
  async authorize(client: OAuthClientInformationFull,params: AuthorizationParams,res: Response): Promise<void> {
    if(params.resource?.href!==this.config.resource) throw new InvalidRequestError('The exact MCP resource is required.');
    if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('A valid S256 challenge is required.');
    const scopes=params.scopes?.length?params.scopes:['clickup:core','offline_access'];
    if(!scopes.includes('clickup:core')||scopes.some(scope=>!['clickup:core','offline_access'].includes(scope))) throw new InvalidScopeError('clickup:core is required.');
    await this.begin({purpose:'mcp',clientId:client.client_id,redirectUri:params.redirectUri,state:params.state,
      codeChallenge:params.codeChallenge,scopes,resource:params.resource.href},res);
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull,code: string): Promise<string> {
    const value=await this.store.codeChallenge(code,client.client_id);
    if(!value) throw new InvalidGrantError('Authorization code is invalid or expired.'); return value;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull,code: string,verifier?: string,redirectUri?: string,resource?: URL) {
    const expected=await this.challengeForAuthorizationCode(client,code);
    if(!verifier||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||!equal(challenge(verifier),expected)||resource?.href!==this.config.resource||!redirectUri) throw new InvalidGrantError('Authorization binding failed.');
    const result=await this.store.exchange(code,client.client_id,redirectUri,resource.href);
    if(!result) throw new InvalidGrantError('Authorization code is invalid or expired.'); return result;
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull,refresh: string,scopes?: string[],resource?: URL) {
    if(resource?.href!==this.config.resource) throw new InvalidGrantError('The exact MCP resource is required.');
    const result=await this.store.refresh(refresh,client.client_id,resource.href,scopes);
    if(!result) throw new InvalidGrantError('Refresh token is invalid or revoked. Reconnect.'); return result;
  }
  async verifyAccessToken(token: string) {
    const identity=await this.store.access(token,this.config.resource);
    if(!identity) throw new InvalidTokenError('Access token is invalid, expired or revoked.');
    return {token,clientId:identity.clientId,scopes:['clickup:core'],resource:new URL(this.config.resource),extra:{userId:identity.user.id}};
  }
  async revokeToken(client: OAuthClientInformationFull,request: OAuthTokenRevocationRequest) {
    await this.store.revoke(request.token,client.client_id);
  }
}
