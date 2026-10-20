import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildContext, allTools, SERVER_VERSION } from '../v4/server.js';
import { toolsFor } from '../v4/tools/profiles.js';
import { createRateBudget, type RateBudget } from '../v4/core/http.js';
import { ClickUpToolError } from '../v4/core/errors.js';
import type { ToolDef } from '../v4/tools/registry.js';
import { requireConfirmation } from './security.js';
import { ClickUpOAuth } from './provider.js';
import { TeamStore, type GrantIdentity } from './store.js';

export class TeamTools {
  private budgets=new Map<string,{budget:RateBudget;used:number}>();
  constructor(readonly store: TeamStore,readonly clickup: ClickUpOAuth,readonly fetchImpl: typeof fetch=fetch) {}
  private budget(identity: GrantIdentity): RateBudget {
    const key=`${identity.user.id}:${identity.user.credential_version}`;
    for(const [id,entry] of this.budgets) if(entry.used<Date.now()-3600000) this.budgets.delete(id);
    let entry=this.budgets.get(key);
    if(!entry) { entry={budget:createRateBudget(),used:Date.now()}; this.budgets.set(key,entry); }
    entry.used=Date.now(); return entry.budget;
  }
  private async context(identity: GrantIdentity, workspace: string) {
    // Check approval again at execution time, including for already authenticated requests.
    const user=await this.store.user(identity.user.id);
    if(!user||user.status!=='approved'||user.epoch!==identity.user.epoch||!user.credential) throw new Error('Your access was revoked. Reconnect.');
    const token=this.store.token(user);
    const ctx=buildContext({token:`Bearer ${token}`,profile:'core',workspaceId:workspace,
      baseUrl:'https://api.clickup.com/api',rateBudget:this.budget({...identity,user}),attachRoot:null,
      log:()=>{},fetchImpl:async(input,init)=>{
        const current=await this.store.user(user.id);
        if(!current||current.status!=='approved'||current.epoch!==user.epoch||!current.credential) throw new Error('Your access was revoked. Reconnect.');
        const response=await this.fetchImpl(input,init);
        if(response.status===401||response.status===403) {
          ctx.cache.invalidate();
          const body=await response.clone().json().catch(()=>({}));
          if(['OAUTH_025','OAUTH_017'].includes(body.ECODE)) {
            await this.store.disconnect(user.id);
            throw new Error('ClickUp authorization was revoked. Reconnect your account.');
          }
        }
        return response;
      }});
    return {ctx,user};
  }
  async workspaces(identity: GrantIdentity) {
    const {ctx}=await this.context(identity,identity.workspaceId);
    const result=await ctx.http.get<{teams:Array<{id:string|number;name:string}>}>('/team');
    return result.teams.map(item=>({id:String(item.id),name:String(item.name)}));
  }
  async execute(tool: ToolDef, args: Record<string,unknown>, identity: GrantIdentity): Promise<string> {
    requireConfirmation(args);
    const workspace=String(args.workspace_id??identity.workspaceId??'');
    const {ctx,user}=await this.context(identity,workspace);
    const workspaces=await ctx.http.get<{teams:Array<{id:string|number;name:string}>}>('/team');
    if(!workspace||!workspaces.teams.some(item=>String(item.id)===workspace)) throw new Error('Choose an authorized workspace with workspace_id. Use workspaces to list choices.');
    const {workspace_id:_workspace,confirm:_confirm,...argumentsForTool}=args;
    // Existing confirmation-aware tools still need their argument.
    if(args.confirm===true) argumentsForTool.confirm=true;
    let result: string;
    try {result=await tool.handler(argumentsForTool,ctx);}
    catch(error) {
      if(error instanceof ClickUpToolError) throw new ClickUpToolError({what:this.redact(error.toolMessage(),{...identity,user}),code:error.code});
      throw error;
    }
    await this.store.audit(user.id,`tool:${tool.name}`,workspace);
    return this.redact(result,{...identity,user});
  }
  private redact(value: string,identity: GrantIdentity): string {
    try {return value.split(this.store.token(identity.user)).join('[redacted]');} catch {return value;}
  }
  server(identity: GrantIdentity): McpServer {
    const server=new McpServer({name:'clickup-team',version:SERVER_VERSION},{capabilities:{tools:{}},instructions:
      'Use workspaces to list authorized ClickUp workspaces. Pass workspace_id to select a workspace. '+
      'Every action uses your own ClickUp permissions. Ask the user before destructive actions and pass confirm: true only after approval.'});
    server.registerTool('workspaces',{description:'List workspaces authorized by your own ClickUp account and the default for this connection.',inputSchema:{},
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},async()=>{
      const user=await this.store.user(identity.user.id);
      if(!user||user.status!=='approved'||user.epoch!==identity.user.epoch||!user.credential) return failure('Access is revoked. Reconnect.');
      try { const workspaces=await this.workspaces(identity);
        return {content:[{type:'text',text:JSON.stringify({default_workspace_id:identity.workspaceId,workspaces})}]};
      } catch { return failure('ClickUp authorization failed. Reconnect your account.'); }
    });
    const tools=toolsFor(allTools,'core',(tool,restriction)=>{
      const schema={...tool.schema}; for(const key of restriction.omit??[]) delete schema[key];
      if(restriction.actions?.length&&schema.action) schema.action=z.enum(restriction.actions as [string,...string[]]);
      return {...tool,schema};
    },{hasSandbox:false}).filter(tool=>tool.name!=='attach');
    for(const tool of tools) {
      const readOnly=['find','task','tree','meta','whoami','docs'].includes(tool.name);
      server.registerTool(tool.name,{description:tool.description,inputSchema:{...tool.schema,
        workspace_id:z.string().regex(/^\d+$/).optional().describe('Authorized workspace ID. Defaults to the workspace chosen when connecting.'),
        confirm:z.boolean().optional().describe('Set true only after the user explicitly approves an irreversible deletion.')},
        annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:true}},async args=>{
        try {
          const text=await this.execute(tool,args as Record<string,unknown>,identity);
          return {content:[{type:'text' as const,text:text.length>60000?text.slice(0,60000)+'\nResponse truncated. Narrow the query.':text}]};
        } catch(error) {
          // Tool messages belong to this caller. No error messages or task content go into logs.
          const text=error instanceof ClickUpToolError?error.toolMessage():
            error instanceof Error&&/workspace|confirm|approval|revoked|Reconnect/.test(error.message)?error.message:'ClickUp request failed. Check your permissions or reconnect.';
          return failure(this.redact(text,identity));
        }
      });
    }
    return server;
  }
}
function failure(text: string) { return {content:[{type:'text' as const,text}],isError:true}; }
