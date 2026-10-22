import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import type {Ctx} from '../v4/tools/registry.js';
import {type Args,id,required,canonicalTask,getTask,fail} from './helpers.js';

const MAX_BYTES=25*1024*1024;
function publicAddress(address:string):boolean {
  const p=address.split('.').map(Number);
  return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&
    ![0,10,127,169,192,224,240,255].includes(p[0])&&p[0]<224&&
    !(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===100&&p[1]>=64&&p[1]<=127)&&!(p[0]===198&&[18,19].includes(p[1]));
}
/** Pin DNS to a validated public address. Never send a ClickUp token to a source URL. */
export async function sourceFile(raw:string,authorization?:string,redirects=0):Promise<Uint8Array> {
  const url=new URL(raw);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail('Attachment URLs must use HTTP(S) without embedded credentials.');
  if(url.port&&!['80','443'].includes(url.port))fail('Attachment URLs must use standard HTTP(S) ports.');
  const addresses=await dns.lookup(url.hostname,{all:true,family:4});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))fail('Attachment sources must resolve to public Internet addresses.');
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).get(url,{
      headers:authorization?{Authorization:authorization}:{},
      lookup:(_host,options,callback:any)=>options.all?callback(null,[{address:addresses[0].address,family:4}]):callback(null,addresses[0].address,4),
      timeout:20000
    },response=>{
      if(response.statusCode&&response.statusCode>=300&&response.statusCode<400&&response.headers.location){
        response.resume();
        if(redirects>=4){reject(new Error('Too many attachment source redirects.'));return;}
        const next=new URL(response.headers.location,url);
        sourceFile(next.href,next.origin===url.origin?authorization:undefined,redirects+1).then(resolve,reject);return;
      }
      if(response.statusCode!==200){response.resume();reject(new Error('Attachment source returned a non-success response.'));return;}
      let size=0;const chunks:Buffer[]=[];
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BYTES){response.destroy();reject(new Error('Attachment exceeds 25 MB.'));}else chunks.push(chunk);});
      response.on('end',()=>resolve(new Uint8Array(Buffer.concat(chunks))));response.on('error',()=>reject(new Error('Attachment source download failed.')));
    });
    request.on('timeout',()=>request.destroy(new Error('Attachment source timed out.')));
    request.on('error',()=>reject(new Error('Attachment source could not be downloaded.')));
  });
}
export async function attachment(name:string,a:Args,ctx:Ctx):Promise<Args> {
  const task=await canonicalTask(required(a.task_id,'task_id'),ctx);
  if(name==='download_task_attachment'){
    const raw=await getTask(task,ctx),item=(raw.attachments??[]).find((f:Args)=>String(f.id)===a.attachment_id);
    if(!item)fail('Attachment was not found on the accessible task.');
    if(!item.url)fail('ClickUp did not return a downloadable attachment URL. Private signed attachment URL generation is unavailable through this API.');
    return {attachment_id:item.id,download_url:item.url,metadata:item,url_source:'public_api_metadata',expires_at:null,
      limitation:'The public API does not expose the official plugin private-download signing contract. This URL may require additional ClickUp authorization.'};
  }
  if(name==='request_attachment_upload'){
    if(!ctx.requestUpload)fail('Native upload tickets require team HTTP mode. Use clickup_attach_task_file with base64 in this client.');
    return ctx.requestUpload(task,a.file_name);
  }
  if(Number(a.file_data!==undefined)+Number(a.file_url!==undefined)!==1)fail('Provide exactly one of file_data or file_url.');
  let bytes:Uint8Array,filename:string;
  if(a.file_data!==undefined){
    filename=required(a.file_name,'file_name');
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(a.file_data))fail('file_data must contain raw base64 without a data URL prefix.');
    bytes=new Uint8Array(Buffer.from(a.file_data,'base64'));if(bytes.length>200*1024)fail('Base64 uploads are limited to 200 KB. Use a native upload ticket.');
  }else{
    bytes=await sourceFile(a.file_url,a.auth_header);
    filename=a.file_name??decodeURIComponent(new URL(a.file_url).pathname.split('/').pop()||'attachment');
  }
  const form=new FormData();form.append('attachment',new Blob([bytes]),filename);
  return ctx.http.upload(`/task/${id(task)}/attachment`,form);
}
