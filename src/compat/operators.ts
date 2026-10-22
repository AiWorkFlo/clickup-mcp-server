import jmespath from 'jmespath';
import {qs} from '../v4/core/http.js';
import type {Ctx} from '../v4/tools/registry.js';
import {type Args,id,nonempty,pick,confirmed,canonicalTask,getTask,fail} from './helpers.js';

export const operators=[
  {model:'task',operator:'get_many',operation_id:'getBulkTasks',parameters:[],body:{ids:'required array of task IDs'},implementation:'One public Get Task request per ID. Returns a status for every requested ID.'},
  {model:'task',operator:'create_many',operation_id:'createTasksLegacy',parameters:['list_id'],body:{tasks:'required array of task specifications'},implementation:'Public Create Task requests, sequential. Plain description strings supported. Quill delta is rejected.'},
  {model:'task',operator:'update_many',operation_id:'updateTasksBulkMonolith',parameters:[],body:{task_ids:'required non-empty array',assignee_ids:'replacement numeric IDs',status_label:'existing status',priority:'1|2|3|4|null',due_date:'Unix milliseconds',start_date:'Unix milliseconds',time_estimate:'milliseconds|null',time_estimate_string:'required with time_estimate'},implementation:'One shared patch through public Update Task requests. Per-task partial outcomes. Group assignee changes unavailable.'},
  {model:'task',operator:'archive',operation_id:'archiveTasksMonolith',parameters:[],body:{task_ids:'required non-empty array'},implementation:'Enumerate nested subtasks, then archive each task through public Update Task.'},
  {model:'task',operator:'unarchive',operation_id:'unarchiveTasksMonolith',parameters:[],body:{task_ids:'required non-empty array'},implementation:'Enumerate nested subtasks, then unarchive each task through public Update Task.'}
];

export async function executeOperator(a:Args,ctx:Ctx):Promise<Args> {
  if(a.query){try{jmespath.search({},a.query);}catch{fail('Invalid JMESPath query. No writes were sent.');}}
  const entry=operators.find(o=>o.model===a.model&&o.operator===a.operator);
  if(!entry)fail('This model/operator pair is not enabled. Call clickup_get_operators first.');
  if(a.operation_id&&a.operation_id!==entry.operation_id)fail('operation_id does not match the selected operator.');
  const b=a.body??{},p=a.parameters??{};
  if(p.workspace_id!==undefined&&String(p.workspace_id)!==ctx.workspaceId)fail('Operator workspace scope cannot be overridden through parameters.');
  if(b.workspace_id!==undefined&&String(b.workspace_id)!==ctx.workspaceId||b.workspaceId!==undefined&&String(b.workspaceId)!==ctx.workspaceId)fail('Operator body workspace does not match the selected connection.');
  if(b.group_assignees!==undefined)fail('Group assignee changes are unavailable through this public API adapter.');
  let result:Args;
  if(a.operator==='get_many'){
    const tasks=[];
    for(const task of nonempty<string>(b.ids,'ids')){
      try{const data=await getTask(task,ctx);tasks.push({object_id:task,status:'found',data});}
      catch(error){tasks.push({object_id:task,status:'error',err:error instanceof Error?error.message:String(error)});}
    }
    result={tasks};
  }else if(a.operator==='create_many'){
    const specs=nonempty<Args>(b.tasks,'tasks'),list=id(String(p.list_id??''),'list_id');
    // Validate the whole batch before the first write.
    for(const spec of specs){if(typeof spec.name!=='string'||!spec.name.trim())fail('Every tasks entry requires a name.');if(spec.description!==undefined&&typeof spec.description!=='string')fail('This public API adapter accepts plain description strings, not Quill delta JSON.');if(spec.group_assignees!==undefined)fail('Group assignees are unavailable through the public API adapter.');}
    const tasks=[],errors=[];
    for(const spec of specs){
      const body=pick(spec,['name','priority','due_date','due_date_time','start_date','start_date_time','time_estimate','custom_fields','notify_all']);
      Object.assign(body,{description:spec.description,assignees:spec.assignee_ids,parent:spec.parent_task_id,status:spec.status_label,tags:spec.tags?.map((t:Args)=>t.name)});
      try{tasks.push(await ctx.http.post(`/list/${list}/task`,body));errors.push(null);}
      catch(error){tasks.push(null);errors.push(error instanceof Error?error.message:String(error));}
    }
    result={tasks,errors,atomic:false};
  }else{
    const ids=nonempty<string>(b.task_ids,'task_ids'),planned:Array<{task:string;body:Args}>=[];
    if(a.operator==='update_many'){
      if(b.time_estimate!==undefined&&b.time_estimate_string===undefined)fail('time_estimate_string is required whenever time_estimate is supplied.');
      if(b.time_estimate===null&&b.time_estimate_string!==null)fail('Clearing the time estimate requires both fields to be null.');
      const patch=pick(b,['name','priority','due_date','due_date_time','start_date','start_date_time','time_estimate']);
      if(b.status_label!==undefined)patch.status=b.status_label;
      if(!Object.keys(patch).length&&b.assignee_ids===undefined)fail('At least one shared update field is required.');
      for(const target of ids){
        const task=await canonicalTask(target,ctx),body={...patch};
        if(b.assignee_ids!==undefined){
          if(!Array.isArray(b.assignee_ids)||b.assignee_ids.some((uid:unknown)=>!Number.isSafeInteger(uid)))fail('assignee_ids must be an array of numeric user IDs. An empty array clears assignments.');
          const existing=await getTask(task,ctx),wanted=new Set<number>(b.assignee_ids.map(Number));
          body.assignees={add:[...wanted],rem:(existing.assignees??[]).map((u:Args)=>Number(u.id)).filter((uid:number)=>!wanted.has(uid))};
        }
        if(patch.status){const taskData=await getTask(task,ctx),list=await ctx.http.get<Args>(`/list/${id(taskData.list?.id)}`);if(!(list.statuses??[]).some((s:Args)=>String(s.status).toLowerCase()===String(patch.status).toLowerCase()))fail(`Status ${patch.status} is not valid for task ${task}. No updates were sent.`);}
        planned.push({task,body});
      }
    }else{
      const seen=new Set<string>();
      async function collect(raw:string){
        const task=await canonicalTask(raw,ctx);if(seen.has(task))return;
        if(seen.size>=1000)fail('Archive scope exceeds 1000 tasks including subtasks. Narrow the batch.');
        seen.add(task);
        const data=await ctx.http.get<Args>(`/task/${id(task)}${qs({include_subtasks:true})}`);
        for(const sub of data.subtasks??[])await collect(String(sub.id));
        planned.push({task,body:{archived:a.operator==='archive'}});
      }
      for(const target of ids)await collect(target);
    }
    const affected=[],errors=[];
    for(const plan of planned){
      try{await ctx.http.put(`/task/${id(plan.task)}`,plan.body);affected.push(plan.task);}
      catch(error){errors.push({task_id:plan.task,error:error instanceof Error?error.message:String(error)});}
    }
    result=a.operator==='update_many'?{task_ids:affected,errors,atomic:false}:{ids:affected,errors,atomic:false};
  }
  return a.query?jmespath.search(result,a.query):result;
}
