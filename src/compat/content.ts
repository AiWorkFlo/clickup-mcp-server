import {qs} from '../v4/core/http.js';
import type {Ctx} from '../v4/tools/registry.js';
import {type Args,id,required,pick,date,confirmed,canonicalTask,getTask,resolve,members,limit,nonempty,fail} from './helpers.js';
import {richComment} from './comments.js';

export async function structure(name:string,a:Args,ctx:Ctx):Promise<Args> {
  if(name==='get_workspace_members')return {members:await members(ctx)};
  if(name==='resolve_assignees')return {assignees:await resolve(a.assignees,ctx)};
  if(name==='find_member_by_name'){
    const key=required(a.name_or_email,'name_or_email').toLowerCase(),all=await members(ctx);
    const found=all.filter(u=>[String(u.username??'').toLowerCase(),String(u.email??'').toLowerCase()].includes(key));
    if(found.length>1)fail('Member name is ambiguous. Use an exact email.');
    return {member:found[0]??null};
  }
  if(name==='get_list'){
    const list=a.list_id??(await ctx.resolver.list(required(a.list_name,'list_id or list_name'))).id;
    return ctx.http.get(`/list/${id(list,'list_id')}`);
  }
  if(name==='get_folder'){
    const folder=a.folder_id??(await ctx.resolver.folder(`${required(a.space_id??a.space_name,'space_id or space_name')}/${required(a.folder_name,'folder_name')}`)).id;
    return ctx.http.get(`/folder/${id(folder,'folder_id')}`);
  }
  if(name==='get_custom_fields'){
    const results:Args={};
    for(const kind of ['list','folder','space'])if(a[kind+'_id'])results[kind]=(await ctx.http.get<Args>(`/${kind}/${id(a[kind+'_id'])}/field`)).fields??[];
    if(a.include_workspace)results.workspace=(await ctx.http.get<Args>(`/team/${id(ctx.workspaceId)}/field`)).fields??[];
    if(!Object.keys(results).length)fail('Specify list_id, folder_id, space_id, or include_workspace.');
    return results;
  }
  if(name==='get_workspace_hierarchy'){
    const start=a.cursor?Number(Buffer.from(a.cursor,'base64url').toString()):0;
    if(!Number.isInteger(start)||start<0)fail('Invalid hierarchy cursor.');
    const size=limit(a.limit,10,50),depth=Number(a.max_depth??'2');
    const response=await ctx.http.get<Args>(`/team/${id(ctx.workspaceId)}/space${qs({archived:false})}`);
    const spaces=(response.spaces??[]).filter((s:Args)=>!a.space_ids||a.space_ids.includes(String(s.id))),selected=spaces.slice(start,start+size);
    for(const space of selected)if(depth>0){
      const folders=await ctx.http.get<Args>(`/space/${id(space.id)}/folder${qs({archived:false})}`);
      space.folders=folders.folders??[];
      if(depth===1){for(const f of space.folders)delete f.lists;}
      else{
        for(const folder of space.folders)folder.lists=(await ctx.http.get<Args>(`/folder/${id(folder.id)}/list${qs({archived:false})}`)).lists??[];
        space.lists=(await ctx.http.get<Args>(`/space/${id(space.id)}/list${qs({archived:false})}`)).lists??[];
      }
    }
    return {spaces:selected,next_cursor:start+size<spaces.length?Buffer.from(String(start+size)).toString('base64url'):null};
  }
  if(name==='create_folder'||name==='create_list'){
    const space=a.space_id??(await ctx.resolver.space(required(a.space_name,'space_id or space_name'))).id;
    const body=pick(a,name==='create_folder'?['name','override_statuses']:['name','content','assignee','priority','status']);
    if(body.priority)body.priority=({urgent:1,high:2,normal:3,low:4} as Args)[body.priority];
    if(a.due_date)body.due_date=date(a.due_date,ctx);
    return ctx.http.post(`/space/${id(space)}/${name==='create_folder'?'folder':'list'}`,body);
  }
  if(name==='create_list_in_folder')return ctx.http.post(`/folder/${id(a.folder_id)}/list`,pick(a,['name','content','status']));
  const kind=name==='update_folder'?'folder':'list',target=id(a[kind+'_id']),body=pick(a,kind==='folder'?['name','override_statuses']:['name','content','status']);
  if(!Object.keys(body).length)fail('At least one update field is required.');
  return ctx.http.put(`/${kind}/${target}`,body);
}

export async function comments(name:string,a:Args,ctx:Ctx):Promise<Args> {
  const body=pick(a,['assignee','comment_text','notify_all','resolved']);
  if(a.comment_text!==undefined){
    body.comment=richComment(a.comment_text);delete body.comment_text;
    const mentioned=[...new Set<string>(body.comment.filter((part:Args)=>part.type==='tag').map((part:Args)=>String(part.user.id)))];
    if(mentioned.length)await resolve(mentioned,ctx);
  }
  if(name==='create_task_comment'){a={...a,entity_type:'task',entity_id:a.task_id};name='create_comment';}
  if(name==='get_task_comments'){
    const task=await canonicalTask(a.task_id,ctx);
    return ctx.http.get(`/task/${id(task)}/comment${qs(pick(a,['start','start_id']))}`);
  }
  if(name==='get_threaded_comments')return ctx.http.get(`/comment/${id(a.comment_id)}/reply`);
  if(name==='update_comment'){
    if(!Object.keys(body).length)fail('At least one comment update field is required.');
    return ctx.http.put(`/comment/${id(a.comment_id)}`,body);
  }
  if(name==='delete_comment'){confirmed(a);await ctx.http.delete(`/comment/${id(a.comment_id)}`);return {success:true,comment_id:a.comment_id};}
  if(a.reply_to_id)return ctx.http.post(`/comment/${id(a.reply_to_id)}/reply`,body);
  if(!['task','list','view'].includes(a.entity_type))fail('entity_type and entity_id are required unless reply_to_id is supplied.');
  const target=a.entity_type==='task'?await canonicalTask(a.entity_id,ctx):a.entity_id;
  return ctx.http.post(`/${a.entity_type}/${id(target,'entity_id')}/comment`,body);
}

export async function documents(name:string,a:Args,ctx:Ctx):Promise<Args> {
  const root=`/workspaces/${id(ctx.workspaceId)}/docs`;
  if(name==='create_document')return ctx.http.post(root,{...pick(a,['name','visibility','create_page']),parent:{...a.parent,type:Number(a.parent.type)}},undefined,'v3');
  const doc=id(a.document_id,'document_id'),path=`${root}/${doc}`;
  if(name==='list_document_pages')return ctx.http.get(`${path}/page_listing${qs(pick(a,['max_page_depth']))}`,undefined,'v3');
  if(name==='get_document_pages'){
    const pages=[];
    for(const page of nonempty<string>(a.page_ids,'page_ids'))pages.push(await ctx.http.get(`${path}/pages/${id(page)}${qs({content_format:a.content_format??'text/md'})}`,undefined,'v3'));
    return {pages};
  }
  if(name==='create_document_page')return ctx.http.post(`${path}/pages`,pick(a,['name','content','content_format','parent_page_id','sub_title']),undefined,'v3');
  if(a.content!==undefined&&!a.content.trim())fail('Page content must be non-empty.');
  const body=pick(a,['name','content','content_edit_mode','content_format','sub_title']);
  if(!Object.keys(body).length)fail('At least one page update field is required.');
  return ctx.http.put(`${path}/pages/${id(a.page_id,'page_id')}`,body,undefined,'v3');
}

export async function chat(name:string,a:Args,ctx:Ctx):Promise<Args> {
  const root=`/workspaces/${id(ctx.workspaceId)}/chat`;
  if(name==='get_chat_channels')return ctx.http.get(`${root}/channels${qs({cursor:a.cursor,limit:limit(a.limit)})}`,undefined,'v3');
  if(name==='react_to_chat_message'){
    const message=id(a.message_id),reaction=required(a.reaction,'reaction').replace(/^:|:$/g,'');
    if(['thumbsup','thumbs_up'].includes(reaction))fail('Use the primary +1 shortcode.');
    if(a.action==='add')return ctx.http.post(`${root}/messages/${message}/reactions`,{reaction},undefined,'v3');
    return ctx.http.delete(`${root}/messages/${message}/reactions/${encodeURIComponent(reaction)}`,undefined,'v3');
  }
  if(name==='send_chat_message'){
    const body:Args={...pick(a,['content','content_format','type','assignee','followers','group_assignee']),type:a.type??'message'};
    if(a.type==='post'){
      required(a.post_title,'post_title');required(a.post_type,'post_type');
      const types=await ctx.http.get<Args>(`/workspaces/${id(ctx.workspaceId)}/comments/types/post/subtypes`,undefined,'v3');
      const hits=(Array.isArray(types)?types:types.subtypes??types.data??[]).filter((t:Args)=>String(t.name).toLowerCase()===a.post_type.toLowerCase());
      if(hits.length!==1)fail('Requested chat post subtype was not found.');
      body.post_data={title:a.post_title,subtype:{id:hits[0].id}};
    }
    const path=a.parent_message_id?`${root}/messages/${id(a.parent_message_id)}/replies`:`${root}/channels/${id(a.channel_id)}/messages`;
    return ctx.http.post(path,body,undefined,'v3');
  }
  const size=limit(a.limit,a.include_reactions?25:100,a.include_reactions?25:100);
  const path=name==='get_chat_message_replies'?`${root}/messages/${id(a.message_id)}/replies`:`${root}/channels/${id(a.channel_id)}/messages`;
  const result=await ctx.http.get<Args>(`${path}${qs({cursor:a.cursor,limit:size,content_format:a.content_format})}`,undefined,'v3');
  if(a.include_reactions){
    const items=result.data??result.messages??result.replies??[];
    for(const item of items)item.reactions=await ctx.http.get(`${root}/messages/${id(item.id)}/reactions`,undefined,'v3');
  }
  return result;
}

function duration(raw:string):number {
  const matches=[...String(raw).matchAll(/(\d+(?:\.\d+)?)\s*(h|m)/g)];
  if(!matches.length||String(raw).replace(/(\d+(?:\.\d+)?)\s*(h|m)/g,'').trim())fail('duration must use hours/minutes, for example 1h 30m or 90m.');
  const ms=matches.reduce((n,m)=>n+Number(m[1])*(m[2]==='h'?3600000:60000),0);
  if(ms<=0)fail('duration must be positive.');return ms;
}
export async function time(name:string,a:Args,ctx:Ctx):Promise<Args> {
  if(name==='get_bulk_tasks_time_in_status'){
    const ids=[];for(const task of nonempty<string>(a.task_ids,'task_ids'))ids.push(await canonicalTask(task,ctx));
    return ctx.http.get(`/task/bulk_time_in_status/task_ids${qs({task_ids:ids})}`);
  }
  if(name==='get_task_time_in_status')return ctx.http.get(`/task/${id(await canonicalTask(a.task_id,ctx))}/time_in_status`);
  const root=`/team/${id(ctx.workspaceId)}/time_entries`;
  if(name==='get_current_time_entry')return ctx.http.get(`${root}/current`);
  if(name==='get_time_entries'){
    const params:Args={};
    for(const key of ['start_date','end_date'])if(a[key])params[key]=date(a[key],ctx);
    if(a.task_id)params.tid=await canonicalTask(a.task_id,ctx);
    if(a.is_billable!==undefined)params.is_billable=a.is_billable;
    if(a.assignee)params.assignee=a.assignee.includes('any')?(await members(ctx)).map(u=>u.id).join(','):(await resolve(a.assignee,ctx)).join(',');
    return ctx.http.get(`${root}${qs(params)}`);
  }
  const body=pick(a,['description','billable']);
  if(a.tags)body.tags=a.tags.map((name:string)=>({name,tag_fg:'#ffffff',tag_bg:'#7b68ee'}));
  if(name==='stop_time_tracking'){
    const stopped=await ctx.http.post<Args>(`${root}/stop`,{});
    if(Object.keys(body).length&&stopped.data?.id)await ctx.http.put(`${root}/${id(String(stopped.data.id))}`,body);
    return stopped;
  }
  body.tid=await canonicalTask(a.task_id,ctx);
  if(name==='start_time_tracking')return ctx.http.post(`${root}/start`,body);
  if(!a.duration&&!a.end_time)fail('duration or end_time is required.');
  body.start=date(required(a.start,'start'),ctx);
  const ms=a.duration?duration(a.duration):Number(date(a.end_time,ctx))-Number(body.start);
  if(ms<=0)fail('The entry must end after it starts.');
  if(a.duration&&a.end_time&&Number(date(a.end_time,ctx))-Number(body.start)!==ms)fail('duration and end_time disagree.');
  body.duration=ms;body.stop=Number(body.start)+ms;
  return ctx.http.post(root,body);
}
