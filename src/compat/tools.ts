import {z} from 'zod';
import {catalog} from './catalog.js';
import type {Ctx,ToolDef} from '../v4/tools/registry.js';
import {type Args,date,pick,unknownCapability,fail} from './helpers.js';
import {taskRead,taskCreate,taskUpdate,taskMove,taskRelations,filterTasks} from './tasks.js';
import {structure,comments,documents,chat,time} from './content.js';
import {attachment} from './attachments.js';
import {operators,executeOperator} from './operators.js';
import {search} from './search.js';
import {SERVER_VERSION} from '../v4/core/version.js';

export const compatibilityGaps:Record<string,string>={
  clickup_search_reminders:'ClickUp public v2/v3 specifications expose no reminder-list endpoint.',
  clickup_update_reminder:'ClickUp public v2/v3 specifications expose no reminder-update endpoint.',
  clickup_list_document_page_attachments:'Public attachments API supports tasks and file custom fields, not Doc pages.',
  clickup_download_document_page_attachment:'No public API for Doc page attachment lookup and signed downloads.'
};
export const compatibilityNotes:Record<string,string>={
  clickup_search:'Partial parity: public task and Doc-name search only. Unsupported asset types and filters fail explicitly. Coverage is returned with every page.',
  clickup_create_reminder:'Experimental: uses the existing repository create-only reminder integration. This endpoint is absent from the public OpenAPI specification and may be unavailable.',
  clickup_download_task_attachment:'Partial parity: returns attachment URLs from accessible task metadata. It cannot mint the official plugin private, short-lived download URLs.',
  clickup_execute_operator:'Public API implementation of five bulk workflows. Sequential per-item results, not the official private Unified API. Quill descriptions and group assignees are unavailable. query supports JMESPath.',
  clickup_get_operators:'Lists this server public-API bulk adapters. These are not upstream private Unified API routes.',
  clickup_request_attachment_upload:'Available in team HTTP mode only. Uses a one-time server upload ticket, never exposes the ClickUp OAuth credential.'
};
const descriptions:Record<string,string>={
  clickup_get_schema:'Inspect this server tool support, public-API parity gaps, source specifications, and the enabled task bulk adapters. Returns structured capability metadata.',
  clickup_get_operators:'List the five bulk task adapters enabled on this server, including required inputs and their public API implementation. Filter by models or model_operators.',
  clickup_execute_operator:'Execute one enabled task bulk adapter after inspecting clickup_get_operators. Uses sequential public API calls and returns per-item outcomes. Not atomic. Supports JMESPath response projection. Do not retry timed-out writes.',
  clickup_search:'Search task names/descriptions or Doc names using paginated public API reads and local matching. Returns explicit coverage. Dashboard, whiteboard, attachment-wide, and chat-wide searches are unavailable. Unsupported filters fail explicitly.',
  clickup_download_task_attachment:'Find an attachment on an accessible task and return its public API metadata URL. Cannot mint private signed download links or guarantee expiry. The URL may require additional authorization.',
  clickup_request_attachment_upload:'Team HTTP mode only: request a five-minute, single-use upload ticket for one local attachment, up to 25 MB. POST multipart/form-data to the returned URL. No ClickUp credential is exposed. Tickets expire on server restart.',
  clickup_create_reminder:'Experimental create-only reminder integration already present in this repository. Supply title and due_date. The endpoint is absent from ClickUp public API specifications and may be unavailable for some accounts.',
  clickup_remove_task_dependency:'Remove a directional waiting_on or blocking dependency between two tasks. Requires task_id, depends_on, and type.',
  clickup_remove_task_link:'Remove a bidirectional task association between task_id and links_to. Both tasks remain intact.'
};
export const compatibilityReadOnly=new Set(catalog.map(t=>t.name).filter(n=>
  /clickup_(get_|find_member|resolve_assignees|search|filter_tasks|list_document)/.test(n)||n==='clickup_download_task_attachment'||n==='clickup_download_document_page_attachment'));

export const COMPATIBILITY_INSTRUCTIONS=
  'This server exposes the existing name-based tools plus 62 clickup_* compatibility tool contracts. '+
  'Call clickup_get_schema for exact support and public-API gaps before assuming official-plugin parity. '+
  'Use workspaces (team mode) or clickup_get_workspace_members to verify the account scope. '+
  'Read the bundled clickup-team://skill resource for workflows. '+
  'Use clickup_get_operators before bulk execution. Never retry an ambiguous write automatically. '+
  'Ask before irreversible changes and pass confirm:true only after approval. '+
  'No reminder read/update, Doc-page attachment signing, private cross-asset search, or private Unified API access is implied.';

async function dispatch(name:string,a:Args,ctx:Ctx):Promise<unknown> {
  const short=name.replace(/^clickup_/,'');
  if(compatibilityGaps[name])return unknownCapability(short);
  if(short==='get_schema')return {server:'clickup-team',version:SERVER_VERSION,models:['task'],operators,
    gaps:compatibilityGaps,notes:compatibilityNotes,tools:catalog.map(t=>({name:t.name,description:t.description,availability:compatibilityGaps[t.name]?'unavailable':compatibilityNotes[t.name]?'limited':'implemented'})),
    sources:['https://developer.clickup.com/openapi/clickup-api-v2-reference.json','https://developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml']};
  if(short==='get_operators')return {operators:operators.filter(o=>(!a.models||a.models.includes(o.model))&&(!a.model_operators||a.model_operators.includes(`${o.model}.${o.operator}`))),execution:'sequential public API requests, non-atomic'};
  if(short==='execute_operator')return executeOperator(a,ctx);
  if(short==='search')return search(a,ctx);
  if(short==='filter_tasks')return filterTasks(a,ctx);
  if(short==='get_task')return taskRead(a,ctx);
  if(short==='create_task')return taskCreate(a,ctx);
  if(short==='update_task')return taskUpdate(a,ctx);
  if(short==='move_task')return taskMove(a,ctx);
  if(['delete_task','merge_tasks','add_tag_to_task','remove_tag_from_task','add_task_dependency','remove_task_dependency','add_task_link','remove_task_link','add_task_to_list','remove_task_from_list'].includes(short))return taskRelations(short,a,ctx);
  if(short.includes('attachment')||short==='attach_task_file')return attachment(short,a,ctx);
  if(['create_comment','create_task_comment','update_comment','delete_comment','get_task_comments','get_threaded_comments'].includes(short))return comments(short,a,ctx);
  if(short.includes('document'))return documents(short,a,ctx);
  if(short.includes('chat'))return chat(short,a,ctx);
  if(short.includes('time'))return time(short,a,ctx);
  if(short==='create_reminder')return ctx.http.post('/reminder',{...pick(a,['title','description']),due_date:date(a.due_date,ctx)});
  return structure(short,a,ctx);
}

export const compatibilityTools:ToolDef[]=catalog.map(entry=>({
  name:entry.name,
  description:compatibilityGaps[entry.name]?`UNAVAILABLE: ${compatibilityGaps[entry.name]} This compatibility contract returns an explicit error.`:
    descriptions[entry.name]??entry.description,
  schema:{...entry.schema,confirm:z.boolean().optional().describe('Set true only after explicit user approval of an irreversible delete or merge.')},
  minProfile:compatibilityReadOnly.has(entry.name)?'read':'core',
  async handler(args,ctx){
    if(args.workspace_id!==undefined&&args.workspace_id!==ctx.workspaceId)fail('workspace_id must match the current context. Select the workspace through the team connection.');
    const dateKeys=new Set(['due_date','start_date','start','end_time','since','due_date_from','due_date_to','date_closed_from','date_closed_to','created_date_from','created_date_to','value']);
    const needsTimezone=(v:unknown,key=''):boolean=>typeof v==='string'?dateKeys.has(key)&&/\d{4}-\d{2}-\d{2}/.test(v):Array.isArray(v)?v.some(item=>needsTimezone(item,key)):!!v&&typeof v==='object'?Object.entries(v).some(([k,item])=>needsTimezone(item,k)):false;
    if(needsTimezone(args)){
      const user=await ctx.cache.remember('compat-user-timezone',()=>ctx.http.get<Args>('/user'));
      ctx.timezone=user.user?.timezone??user.user?.timezeone;
      if(!ctx.timezone)fail('ClickUp did not return your account timezone. Use an explicit millisecond epoch string for dates.');
    }
    return JSON.stringify(await dispatch(entry.name,args,ctx));
  }
}));
