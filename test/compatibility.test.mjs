import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibilityTools} from '../build/compat/tools.js';
import {buildContext} from '../build/v4/server.js';
import {TeamTools} from '../build/team/tools.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const calls=[];
function context(responses={}) {
  calls.length=0;
  return buildContext({token:'Bearer own-user-token',workspaceId:'100',profile:'core',fetchImpl:async(url,init)=>{
    const path=new URL(url).pathname;
    calls.push({path,url:String(url),method:init.method,body:init.body?JSON.parse(init.body):undefined,headers:init.headers});
    const result=responses[path]??(path==='/api/v2/team'?{teams:[{id:'100',members:[]}]}:{});
    return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
  }});
}
async function run(name,args,ctx) {
  const tool=compatibilityTools.find(t=>t.name===`clickup_${name}`);
  assert.ok(tool,`${name} is registered`);
  return JSON.parse(await tool.handler(args,ctx));
}
test('compatibility surface has 62 unique schemas and concrete handlers',()=>{
  assert.equal(compatibilityTools.length,62);
  assert.equal(new Set(compatibilityTools.map(t=>t.name)).size,62);
  assert.ok(compatibilityTools.every(t=>t.schema&&typeof t.handler==='function'));
});
test('custom task IDs carry workspace scope and full description is preserved',async()=>{
  const ctx=context({'/api/v2/task/DEV-12':{id:'abc123',name:'Example',description:'Full text'}});
  const result=await run('get_task',{task_id:'DEV-12',include:['description']},ctx);
  assert.equal(result.id,'abc123');
  assert.match(calls[0].url,/custom_task_ids=true/);
  assert.match(calls[0].url,/team_id=100/);
  assert.equal(calls[0].headers.Authorization,'Bearer own-user-token');
});
test('task update converts dates and minutes, and keeps custom fields typed',async()=>{
  const ctx=context({'/api/v2/task/abc123':{id:'abc123',list:{id:'123456'},custom_fields:[{id:'field1',type:'number'}]}});
  await run('update_task',{task_id:'abc123',due_date:'none',time_estimate:'90',custom_fields:[{id:'field1',value:'42'}]},ctx);
  const write=calls.find(c=>c.method==='PUT');
  assert.equal(write.body.due_date,null);
  assert.equal(write.body.time_estimate,5400000);
  assert.equal(calls.find(c=>c.path.endsWith('/field/field1')).body.value,42);
});
test('irreversible delete and merge are rejected before any upstream write',async()=>{
  const ctx=context();
  await assert.rejects(run('delete_task',{task_id:'abc123'},ctx),/confirm/);
  await assert.rejects(run('merge_tasks',{task_id:'abc123',source_task_ids:['def456']},ctx),/confirm/);
  assert.equal(calls.length,0);
});
test('bulk executor validates scope and exposes partial item errors',async()=>{
  const ctx=context({'/api/v2/task/abc123':{id:'abc123',name:'One'}});
  const result=await run('execute_operator',{model:'task',operator:'get_many',body:{ids:['abc123']}},ctx);
  assert.equal(result.tasks[0].status,'found');
  await assert.rejects(run('execute_operator',{model:'task',operator:'archive',body:{}},ctx),/task_ids/);
  await assert.rejects(run('execute_operator',{model:'task',operator:'delete_many',body:{task_ids:['abc123']}},ctx),/enabled/);
});
test('Doc append passes through to server-side merge without replacing content',async()=>{
  const ctx=context();
  await run('update_document_page',{document_id:'ad-1',page_id:'ad-2',content:'\nDecision',content_edit_mode:'append'},ctx);
  assert.equal(calls[0].path,'/api/v3/workspaces/100/docs/ad-1/pages/ad-2');
  assert.equal(calls[0].body.content_edit_mode,'append');
  assert.equal(calls[0].body.content,'\nDecision');
});
test('unsupported private API features fail explicitly without imaginary endpoint calls',async()=>{
  const ctx=context();
  await assert.rejects(run('search_reminders',{},ctx),/public API|unavailable/i);
  assert.equal(calls.length,0);
});
test('team discovery exposes all compatibility contracts, preserves native tools and packages guidance',async()=>{
  const server=new TeamTools({},{}).server({user:{},workspaceId:''});
  const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(b);await client.connect(a);
    const tools=(await client.listTools()).tools,names=tools.map(t=>t.name);
    assert.equal(tools.length,78);
    assert.equal(names.filter(n=>n.startsWith('clickup_')).length,62);
    assert.ok(names.includes('workspaces')&&names.includes('create')&&names.includes('checklist'));
    assert.ok(!names.includes('people')&&!names.includes('webhooks')&&!names.includes('attach'));
    assert.match(client.getInstructions(),/public-API gaps/);
    const resource=await client.readResource({uri:'clickup-team://skill'});
    assert.match(resource.contents[0].text,/clickup_search_reminders/);
    assert.equal(tools.find(t=>t.name==='clickup_get_task').annotations.readOnlyHint,true);
    assert.equal(tools.find(t=>t.name==='clickup_update_task').annotations.readOnlyHint,false);
  }finally{await client.close();await server.close();}
});
test('task filters map public hierarchy parameters and retain pagination after local tag OR filtering',async()=>{
  const ctx=context({'/api/v2/team/100/task':{tasks:[{id:'one',tags:[{name:'A'}]},{id:'two',tags:[{name:'B'}]},{id:'three',tags:[]}],last_page:false}});
  const result=await run('filter_tasks',{space_ids:['22'],folder_ids:['33'],tags:['A','B']},ctx);
  assert.deepEqual(result.tasks.map(t=>t.id),['one','two']);
  assert.equal(result.has_more,true);assert.equal(result.next_page,1);
  const url=new URL(calls[0].url);assert.equal(url.searchParams.get('space_ids[]'),'22');assert.equal(url.searchParams.get('project_ids[]'),'33');
});
test('unknown custom field filters fail before potentially unfiltered task retrieval',async()=>{
  const ctx=context({'/api/v2/team/100/field':{fields:[]}});
  await assert.rejects(run('filter_tasks',{custom_fields:[{field_id:'missing',operator:'=',value:'x'}]},ctx),/Unknown custom field/);
  assert.ok(!calls.some(c=>c.path.endsWith('/task')));
});
test('dates use the ClickUp account timezone instead of the server timezone',async()=>{
  const ctx=context({'/api/v2/user':{user:{id:1,timezone:'Asia/Singapore'}}});
  await run('update_task',{task_id:'abc123',due_date:'2026-10-30 09:00'},ctx);
  assert.equal(calls.find(c=>c.method==='PUT').body.due_date,Date.parse('2026-10-30T01:00:00Z'));
});
test('bulk assignee replacement clears removed users and allows clearing all assignments',async()=>{
  const ctx=context({'/api/v2/task/abc123':{id:'abc123',assignees:[{id:7},{id:8}]}});
  await run('execute_operator',{model:'task',operator:'update_many',body:{task_ids:['abc123'],assignee_ids:[]}},ctx);
  assert.deepEqual(calls.find(c=>c.method==='PUT').body.assignees,{add:[],rem:[7,8]});
});
test('a task move uses the public v3 home-list route and verifies the result',async()=>{
  let reads=0;const ctx=buildContext({token:'Bearer own-user-token',workspaceId:'100',profile:'core',fetchImpl:async(url,init)=>{
    const path=new URL(url).pathname;calls.push({path,method:init.method});
    const body=path==='/api/v2/task/abc123'?{id:'abc123',list:{id:++reads===1?'old':'999'},status:{status:'open'}}:
      path==='/api/v2/list/999'?{statuses:[{status:'open'}]}:{};
    return new Response(JSON.stringify(body),{status:200});
  }});
  calls.length=0;
  const result=await run('move_task',{task_id:'abc123',list_id:'999'},ctx);
  assert.equal(result.success,true);assert.ok(calls.some(c=>c.path==='/api/v3/workspaces/100/tasks/abc123/home_list/999'&&c.method==='PUT'));
  assert.equal(reads,2);
});
test('invalid projections and unsupported broad searches fail without side effects',async()=>{
  const ctx=context();
  await assert.rejects(run('execute_operator',{model:'task',operator:'create_many',parameters:{list_id:123},body:{tasks:[{name:'Example'}]},query:'['},ctx),/Invalid JMESPath/);
  await assert.rejects(run('search',{filters:{asset_types:['whiteboard']}},ctx),/public|Public/);
  assert.equal(calls.length,0);
});
test('native uploads are single-use and recheck account approval before forwarding a file',async()=>{
  const original=process.env.MCP_PUBLIC_URL;process.env.MCP_PUBLIC_URL='https://team.example/mcp';
  const user={id:'1',name:'Owner',email:'owner@example.test',status:'approved',epoch:1,credential:'ciphertext',credential_version:'v1'};
  const store={user:async()=>user,token:()=> 'own-private-token',audit:async()=>{}};
  let forwarded=0;
  const service=new TeamTools(store,{},async(url,init)=>{
    assert.equal(init.headers.Authorization,'Bearer own-private-token');
    if(new URL(url).pathname==='/api/v2/team')return new Response(JSON.stringify({teams:[{id:'100'}]}));
    assert.ok(init.body instanceof FormData);assert.equal(await init.body.get('attachment').text(),'example');forwarded++;
    return new Response(JSON.stringify({id:'attachment-1'}));
  });
  const identity={user,workspaceId:'100',clientId:'example-client',family:'family'};
  const request=compatibilityTools.find(t=>t.name==='clickup_request_attachment_upload');
  try{
    const response=JSON.parse(await service.execute(request,{task_id:'abc123'},identity));
    assert.ok(!JSON.stringify(response).includes('own-private-token'));
    const token=new URL(response.upload_url).pathname.split('/').pop();
    const form=new FormData();form.append('attachment',new Blob(['example']),'example.txt');
    assert.equal((await service.upload(token,form)).id,'attachment-1');
    await assert.rejects(service.upload(token,form),/expired/);assert.equal(forwarded,1);
    const second=JSON.parse(await service.execute(request,{task_id:'abc123'},identity));
    user.status='disabled';
    await assert.rejects(service.upload(new URL(second.upload_url).pathname.split('/').pop(),form),/revoked/);
    assert.equal(forwarded,1);
  }finally{if(original===undefined)delete process.env.MCP_PUBLIC_URL;else process.env.MCP_PUBLIC_URL=original;}
});
test('comments preserve Markdown emphasis and convert user links to actual ClickUp mentions',async()=>{
  const ctx=context({'/api/v2/team':{teams:[{id:'100',members:[{user:{id:7,username:'Owner'}}]}]}});
  await run('create_comment',{entity_type:'task',entity_id:'abc123',comment_text:'**Review** [@Owner](#user_mention#7)'},ctx);
  const write=calls.find(c=>c.method==='POST');
  assert.equal(write.path,'/api/v2/task/abc123/comment');
  assert.ok(write.body.comment.some(part=>part.text==='Review'&&part.attributes.bold===true));
  assert.ok(write.body.comment.some(part=>part.type==='tag'&&part.user.id===7));
  assert.equal(write.body.comment_text,undefined);
});
test('Chat posts resolve the public post subtype route before posting',async()=>{
  const ctx=context({'/api/v3/workspaces/100/comments/types/post/subtypes':[{id:'subtype',name:'Update'}]});
  await run('send_chat_message',{channel_id:'channel1',content:'Brief ready',type:'post',post_title:'Launch',post_type:'Update'},ctx);
  const write=calls.find(c=>c.method==='POST');
  assert.equal(write.path,'/api/v3/workspaces/100/chat/channels/channel1/messages');
  assert.deepEqual(write.body.post_data,{title:'Launch',subtype:{id:'subtype'}});
});
test('manual time entries send stop and tid, retain account timezone and valid tag data',async()=>{
  const ctx=context({'/api/v2/user':{user:{id:1,timezone:'Asia/Singapore'}}});
  await run('add_time_entry',{task_id:'abc123',start:'2026-10-22 09:00',duration:'1h 30m',tags:['Research']},ctx);
  const write=calls.find(c=>c.method==='POST');
  assert.equal(write.body.tid,'abc123');assert.equal(write.body.stop-write.body.start,5400000);
  assert.equal(write.body.start,Date.parse('2026-10-22T01:00:00Z'));
  assert.equal(write.body.tags[0].name,'Research');assert.ok(write.body.tags[0].tag_fg&&write.body.tags[0].tag_bg);
  assert.equal(write.body.end,undefined);
});
test('date-only task filters include the whole final day in the user timezone',async()=>{
  const ctx=context({'/api/v2/user':{user:{id:1,timezone:'Asia/Singapore'}}});
  await run('filter_tasks',{due_date_from:'2026-10-30',due_date_to:'2026-10-30'},ctx);
  const url=new URL(calls.find(c=>c.path==='/api/v2/team/100/task').url);
  assert.equal(Number(url.searchParams.get('due_date_gt')),Date.parse('2026-10-29T16:00:00Z')-1);
  assert.equal(Number(url.searchParams.get('due_date_lt')),Date.parse('2026-10-30T16:00:00Z'));
});
test('task-specific search filters never fail later when the task scan reaches Docs',async()=>{
  const ctx=context({'/api/v2/team/100/task':{tasks:[],last_page:true}});
  const result=await run('search',{filters:{location:{subcategories:['123']}}},ctx);
  assert.deepEqual(result.coverage.asset_types,['task']);assert.equal(result.next_cursor,null);
  assert.ok(!calls.some(c=>c.path.endsWith('/docs')));
});
