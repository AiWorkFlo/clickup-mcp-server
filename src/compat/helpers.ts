import {ClickUpToolError} from '../v4/core/errors.js';
import {parseDate} from '../v4/core/dates.js';
import {qs} from '../v4/core/http.js';
import type {Ctx} from '../v4/tools/registry.js';

export type Args = Record<string, any>;
export function fail(what:string):never {throw new ClickUpToolError({what});}
export function required(value:unknown,name:string):string {
  if(typeof value!=='string'||!value.trim())return fail(`${name} is required.`);
  return value.trim();
}
export function id(value:unknown,name='id'):string {
  const s=required(value,name);
  if(!/^[A-Za-z0-9_-]+$/.test(s))return fail(`Invalid ${name}. Pass an object ID, not a URL or path.`);
  return encodeURIComponent(s);
}
export function limit(value:unknown,fallback=100,max=100):number {
  const n=value===undefined?fallback:Number(value);
  if(!Number.isInteger(n)||n<1||n>max)return fail(`limit must be between 1 and ${max}.`);
  return n;
}
export function page(value:unknown):number {
  const n=value===undefined?0:Number(value);
  if(!Number.isInteger(n)||n<0)return fail('page must be a non-negative integer.');
  return n;
}
export function pick(args:Args,keys:string[]):Args {return Object.fromEntries(keys.filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));}
export function nonempty<T>(value:T[]|undefined,name:string,max=100):T[] {
  if(!Array.isArray(value)||!value.length||value.length>max)return fail(`${name} must contain 1 to ${max} entries.`);
  return value;
}
export function date(value:unknown,ctx:Ctx):number|null {
  if(value==='none'||value===null)return null;
  const text=String(value),match=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text);
  if(!match||!ctx.timezone)return parseDate(text,ctx.now()).ms;
  const [year,month,day,hour,minute]=match.slice(1).map(v=>Number(v??0));
  const wall=Date.UTC(year,month-1,day,hour,minute),check=new Date(wall);
  if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day||hour>23||minute>59)fail('Invalid calendar date or time.');
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:ctx.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const local=(ms:number)=>{const p=Object.fromEntries(formatter.formatToParts(ms).map(v=>[v.type,v.value]));return Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));};
  let result=wall;
  for(let i=0;i<4;i++){const delta=wall-local(result);if(!delta)break;result+=delta;}
  if(local(result)!==wall)fail('This local time does not exist in your ClickUp timezone.');
  if(match[4]&&(local(result-3600000)===wall||local(result+3600000)===wall))fail('This local time is ambiguous during daylight saving. Pass a millisecond epoch string.');
  return result;
}
export function confirmed(args:Args):void {if(args.confirm!==true)fail('Explicit user approval and confirm: true are required for this destructive action.');}
/** ClickUp uses strict gt/lt filters. User-facing date bounds are inclusive. */
export function rangeBound(value:string,ctx:Ctx,upper:boolean):number {
  const start=date(value,ctx);if(start===null)fail('Date filter bounds cannot be none.');
  if(upper&&/^\d{4}-\d{2}-\d{2}$/.test(value)){
    const next=new Date(value+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);
    return date(next.toISOString().slice(0,10),ctx)!;
  }
  return start+(upper?1:-1);
}
export function taskQuery(task:string,ctx:Ctx):string {return /^[A-Za-z]+-\d+$/.test(task)?qs({custom_task_ids:true,team_id:ctx.workspaceId}):'';}
export async function getTask(task:string,ctx:Ctx):Promise<Args> {return ctx.http.get(`/task/${id(task,'task_id')}${taskQuery(task,ctx)}`);}
export async function canonicalTask(task:string,ctx:Ctx):Promise<string> {
  id(task,'task_id');
  return /^[A-Za-z]+-\d+$/.test(task)?String((await getTask(task,ctx)).id):task;
}
export async function members(ctx:Ctx):Promise<Args[]> {
  const response=await ctx.http.get<{teams:Args[]}>('/team');
  const team=response.teams.find(t=>String(t.id)===ctx.workspaceId);
  if(!team)fail('The selected workspace is not authorized.');
  return (team.members??[]).map((m:Args)=>m.user??m);
}
export async function resolve(names:string[],ctx:Ctx):Promise<string[]> {
  const users=await members(ctx),result:string[]=[];
  let me:Args|undefined;
  for(const raw of names){
    const key=String(raw).trim().toLowerCase();
    if(key==='me'){
      me??=(await ctx.http.get<{user:Args}>('/user')).user;
      if(!users.some(u=>String(u.id)===String(me!.id)))fail('The current user is not a member of this workspace.');
      result.push(String(me.id));continue;
    }
    const exact=users.filter(u=>[String(u.id),String(u.username??'').toLowerCase(),String(u.email??'').toLowerCase()].includes(key));
    const hits=exact.length?exact:users.filter(u=>String(u.username??'').toLowerCase().includes(key));
    if(hits.length!==1)fail(`Assignee ${raw} ${hits.length?'is ambiguous':'was not found'}. Use a numeric user ID or exact email.`);
    result.push(String(hits[0].id));
  }
  return result;
}
export async function taskType(name:string,ctx:Ctx):Promise<number> {
  if(name==='none')return 0;
  const response=await ctx.http.get<Args>(`/team/${id(ctx.workspaceId)}/custom_item`);
  const hits=(response.custom_items??[]).filter((t:Args)=>String(t.name).toLowerCase()===name.toLowerCase());
  if(hits.length!==1)fail(`Task type ${name} was not found or is ambiguous.`);
  return Number(hits[0].id);
}
export async function fieldsForTask(task:Args,ctx:Ctx):Promise<Args[]> {
  if(task.custom_fields)return task.custom_fields;
  if(!task.list?.id)fail('Task list could not be resolved.');
  return (await ctx.http.get<Args>(`/list/${id(task.list.id)}/field`)).fields??[];
}
export function fieldValue(raw:string,field:Args,ctx:Ctx):unknown {
  switch(field.type){
    case 'number':case 'currency':case 'rating':case 'money':{
      const n=Number(raw);if(!raw.trim()||!Number.isFinite(n))fail(`Invalid numeric value for ${field.id}.`);return n;
    }
    case 'date':return date(raw,ctx);
    case 'checkbox':case 'button':if(!['true','false'].includes(raw))fail('Checkbox values must be true or false.');return raw==='true';
    case 'labels':case 'users':case 'people':case 'tasks':case 'list_relationship':case 'relationship':case 'files':case 'manual_progress':case 'progress':case 'location':
      try{return JSON.parse(raw);}catch{return fail(`Invalid JSON value for ${field.id}.`);}
    default:return raw;
  }
}
export async function customFields(values:Args[]|undefined,definitions:Args[],ctx:Ctx):Promise<Args[]> {
  return (values??[]).map(v=>{
    const field=definitions.find(f=>f.id===v.id);
    if(!field)fail(`Unknown custom field ${v.id}. Discover definitions before writing.`);
    return {id:v.id,value:fieldValue(String(v.value),field,ctx)};
  });
}
export function unknownCapability(name:string):never {return fail(`${name} is unavailable through the documented ClickUp public API. No private endpoint or substitute object was used. See clickup_get_schema for capability gaps.`);}
