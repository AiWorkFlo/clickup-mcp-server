import {qs} from '../v4/core/http.js';
import type {Ctx} from '../v4/tools/registry.js';
import {type Args,id,limit,fail} from './helpers.js';
import {filterTasks} from './tasks.js';

export async function search(a:Args,ctx:Ctx):Promise<Args> {
  const f=a.filters??{},types=f.asset_types??['task','doc'];
  if(types.some((t:string)=>!['task','doc'].includes(t)))fail('Public API search supports tasks and Docs only. Dashboard, whiteboard, attachment-wide, and chat-wide search are not exposed by ClickUp public APIs.');
  if(f.creators?.length)fail('Creator search filtering is unavailable in this adapter. No unfiltered result was returned.');
  if(f.task_statuses?.length)fail('Search status categories are unavailable. Use clickup_filter_tasks with exact list status names.');
  if(a.sort?.length)fail('Global cross-content sorting is unavailable. Use clickup_filter_tasks order_by for task sorting.');
  let cursor:Args={phase:types.includes('task')?'tasks':'docs',page:0,offset:0};
  if(a.cursor){try{cursor=JSON.parse(Buffer.from(a.cursor,'base64url').toString());}catch{fail('Invalid search cursor.');}}
  if(!['tasks','docs'].includes(cursor.phase)||!Number.isInteger(cursor.offset)||cursor.offset<0||!Number.isInteger(cursor.page)||cursor.page<0)fail('Invalid search cursor.');
  const size=limit(a.count,50),needle=String(a.keywords??'').toLowerCase();
  let matches:Args[]=[],next:Args|null=null;
  if(cursor.phase==='tasks'){
    const response=await filterTasks({page:cursor.page,list_ids:f.location?.subcategories,space_ids:f.location?.projects,folder_ids:f.location?.categories,
      assignees:f.assignees,due_date_from:f.due_date_from,due_date_to:f.due_date_to,include_closed:true},ctx);
    matches=response.tasks.filter((t:Args)=>{
      if(needle&&!`${t.name??''} ${t.description??''} ${t.text_content??''}`.toLowerCase().includes(needle))return false;
      if(f.created_date_from&&Number(t.date_created)<new Date(f.created_date_from).getTime())return false;
      if(f.created_date_to&&Number(t.date_created)>new Date(f.created_date_to).getTime())return false;
      return true;
    }).map((task:Args)=>({asset_type:'task',...task}));
    if(cursor.offset+size<matches.length)next={...cursor,offset:cursor.offset+size};
    else if(response.has_more)next={phase:'tasks',page:response.next_page,offset:0};
    else if(types.includes('doc'))next={phase:'docs',page:0,offset:0};
  }else{
    // Task-only filters cannot be silently ignored when searching Docs.
    if(Object.keys(f).some(k=>k!=='asset_types'))fail('Use asset_types:["task"] with task-specific filters. Doc search supports names only.');
    const response=await ctx.http.get<Args>(`/workspaces/${id(ctx.workspaceId)}/docs${qs({cursor:cursor.doc_cursor,limit:100})}`,undefined,'v3');
    matches=(response.docs??[]).filter((d:Args)=>!needle||String(d.name??'').toLowerCase().includes(needle)).map((d:Args)=>({asset_type:'doc',...d}));
    if(cursor.offset+size<matches.length)next={...cursor,offset:cursor.offset+size};
    else if(response.next_cursor)next={phase:'docs',page:0,offset:0,doc_cursor:response.next_cursor};
  }
  return {results:matches.slice(cursor.offset,cursor.offset+size),next_cursor:next?Buffer.from(JSON.stringify(next)).toString('base64url'):null,
    coverage:{source:'public_api',asset_types:types,text_matching:'local substring over each scanned task page or Doc names',complete:next===null}};
}
