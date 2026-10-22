import {qs} from '../v4/core/http.js';
import type {Ctx} from '../v4/tools/registry.js';
import {type Args,id,required,pick,date,confirmed,canonicalTask,getTask,resolve,taskType,customFields,fieldsForTask,nonempty,page,fail} from './helpers.js';

const priorities:Args={urgent:1,high:2,normal:3,low:4,none:null};
export async function taskBody(a:Args,ctx:Ctx,creating:boolean):Promise<Args> {
  const body=pick(a,['name','status','parent','check_required_custom_fields','tags']);
  if(a.markdown_description!==undefined)body.markdown_description=a.markdown_description;
  if(a.priority!==undefined)body.priority=priorities[a.priority];
  for(const key of ['due_date','start_date'])if(a[key]!==undefined){body[key]=date(a[key],ctx);body[key+'_time']=String(a[key]).includes(' ');}
  if(a.time_estimate!==undefined){const n=Number(a.time_estimate);if(!Number.isFinite(n)||n<0)fail('time_estimate must be non-negative minutes.');body.time_estimate=n*60000;}
  if(a.assignees!==undefined){const assignees=(await resolve(a.assignees,ctx)).map(Number);body.assignees=creating?assignees:{add:assignees};}
  if(a.task_type!==undefined)body.custom_item_id=await taskType(a.task_type,ctx);
  return body;
}
export async function taskRead(a:Args,ctx:Ctx):Promise<Args> {
  const task=await getTask(required(a.task_id,'task_id'),ctx);
  if(a.expand_statuses){const list=await ctx.http.get<Args>(`/list/${id(task.list?.id,'list_id')}`);task.available_statuses=list.statuses??[];}
  if(a.include?.includes('subtasks')){
    const response=await ctx.http.get<Args>(`/task/${id(task.id)}${qs({include_subtasks:true})}`);
    task.subtasks=response.subtasks??[];
  }
  const include=new Set<string>(a.include??[]);
  const result=pick(task,['id','custom_id','name','status','priority','assignees','list','folder','space','url','date_created','date_updated','date_closed','date_done','due_date','start_date','time_estimate','time_spent','parent','archived','available_statuses']);
  if(task.description!==undefined)result.description=include.has('description')?task.description:String(task.description).slice(0,10000);
  if(include.has('description')&&task.markdown_description!==undefined)result.markdown_description=task.markdown_description;
  for(const section of ['attachments','checklists','custom_fields','dependencies','linked_tasks','subtasks','watchers']){
    if(include.has(section))result[section]=task[section]??[];
    else result[section+'_count']=(task[section]??[]).length;
  }
  return result;
}
export async function taskCreate(a:Args,ctx:Ctx):Promise<Args> {
  required(a.name,'name');
  const list=id(a.list_id,'list_id');
  const body=await taskBody(a,ctx,true);
  if(a.status||a.tags?.length){
    const container=await ctx.http.get<Args>(`/list/${list}`);
    if(a.status&&!(container.statuses??[]).some((s:Args)=>String(s.status).toLowerCase()===a.status.toLowerCase()))fail('Status is not configured on the destination list.');
    if(a.tags?.length){const existing=await ctx.http.get<Args>(`/space/${id(container.space?.id,'space_id')}/tag`);if(a.tags.some((tag:string)=>!(existing.tags??[]).some((t:Args)=>t.name===tag)))fail('All task tags must already exist in the destination space.');}
  }
  if(a.custom_fields){const defs=(await ctx.http.get<Args>(`/list/${list}/field`)).fields??[];body.custom_fields=await customFields(a.custom_fields,defs,ctx);}
  const task=await ctx.http.post<Args>(`/list/${list}/task`,body);
  return {success:true,task_id:task.id,task_url:task.url??`https://app.clickup.com/t/${task.id}`,task};
}
export async function taskUpdate(a:Args,ctx:Ctx):Promise<Args> {
  const tid=await canonicalTask(required(a.task_id,'task_id'),ctx);
  const body=await taskBody(a,ctx,false);
  const task=a.custom_fields?await getTask(tid,ctx):undefined;
  if(a.status){const existing=task??await getTask(tid,ctx),list=await ctx.http.get<Args>(`/list/${id(existing.list?.id,'list_id')}`);if(!(list.statuses??[]).some((s:Args)=>String(s.status).toLowerCase()===a.status.toLowerCase()))fail('Status is not configured on this task list.');}
  const values=a.custom_fields?await customFields(a.custom_fields,await fieldsForTask(task!,ctx),ctx):[];
  if(!Object.keys(body).length&&!values.length)fail('At least one update field is required.');
  const updated=Object.keys(body).length?await ctx.http.put<Args>(`/task/${id(tid)}`,body):task!;
  const applied:string[]=[];
  for(const field of values){
    try{await ctx.http.post(`/task/${id(tid)}/field/${id(field.id)}`,{value:field.value});applied.push(field.id);}
    catch(error){fail(`Task properties may have been updated. Custom fields applied: ${applied.join(',')||'none'}. Field ${field.id} failed: ${error instanceof Error?error.message:'upstream error'}. Inspect before retrying.`);}
  }
  return {success:true,task_id:tid,task_url:updated.url??`https://app.clickup.com/t/${tid}`,task:updated};
}
export async function taskMove(a:Args,ctx:Ctx):Promise<Args> {
  const tid=await canonicalTask(a.task_id,ctx),list=id(a.list_id,'list_id'),before=await getTask(tid,ctx);
  if(before.parent)fail('Subtasks cannot be moved directly. Move their parent task.');
  const dest=await ctx.http.get<Args>(`/list/${list}`);
  if(!(dest.statuses??[]).some((s:Args)=>String(s.status).toLowerCase()===String(before.status?.status).toLowerCase()))fail('The current task status does not exist in the destination list. Set a compatible status before moving.');
  await ctx.http.put(`/workspaces/${id(ctx.workspaceId)}/tasks/${id(tid)}/home_list/${list}`,{},undefined,'v3');
  const after=await getTask(tid,ctx);
  if(String(after.list?.id)!==a.list_id)fail('The upstream request returned, but read-back did not confirm the new home list. Inspect the task before retrying.');
  return {success:true,task_id:tid,list_id:a.list_id};
}
export async function taskRelations(name:string,a:Args,ctx:Ctx):Promise<Args> {
  const tid=await canonicalTask(a.task_id,ctx),p=`/task/${id(tid)}`;
  if(name==='delete_task'){confirmed(a);await ctx.http.delete(p);return {success:true,task_id:tid};}
  if(name==='merge_tasks'){
    confirmed(a);const sources=[];
    for(const source of nonempty<string>(a.source_task_ids,'source_task_ids'))sources.push(await canonicalTask(source,ctx));
    if(sources.includes(tid))fail('The target task cannot also be a merge source.');
    await ctx.http.post(`${p}/merge`,{source_task_ids:sources});return {success:true,task_id:tid,source_task_ids:sources};
  }
  if(name.includes('tag_')){
    const path=`${p}/tag/${encodeURIComponent(required(a.tag_name,'tag_name'))}`;
    if(name.startsWith('add_')){
      const task=await getTask(tid,ctx),tags=await ctx.http.get<Args>(`/space/${id(task.space?.id,'space_id')}/tag`);
      if(!(tags.tags??[]).some((t:Args)=>t.name===a.tag_name))fail('The tag must already exist in the task space.');
      await ctx.http.post(path,{});
    }else await ctx.http.delete(path);
    return {success:true,task_id:tid};
  }
  if(name.includes('dependency')){
    const other=await canonicalTask(a.depends_on,ctx),key=a.type==='blocking'?'dependency_of':'depends_on';
    if(name.startsWith('add_'))await ctx.http.post(`${p}/dependency`,{[key]:other});
    else await ctx.http.delete(`${p}/dependency${qs({[key]:other})}`);
    return {success:true,task_id:tid};
  }
  if(name.includes('task_link')){
    const other=await canonicalTask(a.links_to,ctx),path=`${p}/link/${id(other)}`;
    if(name.startsWith('add_'))await ctx.http.post(path,{});else await ctx.http.delete(path);
    return {success:true,task_id:tid};
  }
  const list=id(a.list_id,'list_id'),path=`/list/${list}/task/${id(tid)}`;
  if(name==='add_task_to_list')await ctx.http.post(path,{});
  else{
    const task=await getTask(tid,ctx);if(String(task.list?.id)===a.list_id)fail('Cannot remove a task from its home list.');
    await ctx.http.delete(path);
  }
  return {success:true,task_id:tid,list_id:a.list_id};
}
export async function filterTasks(a:Args,ctx:Ctx):Promise<Args> {
  const p=page(a.page),params:Args={page:p,include_closed:a.include_closed,subtasks:a.subtasks??true,order_by:a.order_by,reverse:a.reverse,
    list_ids:a.list_ids,space_ids:a.space_ids,project_ids:a.folder_ids,statuses:a.statuses};
  if(a.assignees)params.assignees=await resolve(a.assignees,ctx);
  for(const [source,target] of Object.entries({due_date_from:'due_date_gt',due_date_to:'due_date_lt',date_closed_from:'date_done_gt',date_closed_to:'date_done_lt'}))if(a[source])params[target]=date(a[source],ctx);
  if(a.custom_fields?.length){
    const defs=(await ctx.http.get<Args>(`/team/${id(ctx.workspaceId)}/field`)).fields??[];
    const fields=[];
    for(const f of a.custom_fields){
      const def=defs.find((d:Args)=>d.id===f.field_id);if(!def)fail(`Unknown custom field ${f.field_id}. Refusing a potentially unfiltered query.`);
      if(['formula','location','button','votes','signature','rollup','automatic_progress','manual_progress','progress','app'].includes(def.type))fail(`Field type ${def.type} cannot be filtered.`);
      let value:any=f.value;
      if(value!==undefined){
        if(['ANY','ALL','NOT ANY','NOT ALL','RANGE'].includes(f.operator)){try{value=JSON.parse(value);}catch{fail('Multi-value filters require a JSON array.');}if(!Array.isArray(value)||!value.length)fail('Filter array must not be empty.');if(f.operator==='RANGE'&&value.length!==2)fail('RANGE requires exactly two bounds.');if(def.type==='date')value=value.map((v:unknown)=>date(v,ctx));}
        else if(def.type==='date'&&!['=','!='].includes(f.operator))value=date(value,ctx);
        else if(['number','currency','rating'].includes(def.type))value=Number(value);
      }
      fields.push({field_id:f.field_id,operator:f.operator,...(value===undefined?{}:{value})});
    }
    params.custom_fields=JSON.stringify(fields);
  }
  const response=await ctx.http.get<Args>(`/team/${id(ctx.workspaceId)}/task${qs(params)}`),scanned=response.tasks??[];
  const tasks=a.tags?.length?scanned.filter((task:Args)=>a.tags.some((tag:string)=>(task.tags??[]).some((t:Args)=>t.name===tag))):scanned;
  const more=response.last_page===false||(response.last_page!==true&&scanned.length===100);
  return {tasks,total_count:tasks.length,scanned_count:scanned.length,has_more:more,next_page:more?p+1:null};
}
