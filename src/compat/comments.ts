import MarkdownIt from 'markdown-it';
import {fail,type Args} from './helpers.js';

const markdown=new MarkdownIt({html:false,maxNesting:20});
/** Translate Markdown to ClickUp's documented rich-comment segments, including real @mentions. */
export function richComment(text:string):Args[] {
  if(!text.trim()||text.length>40000)fail('Comment text must contain 1 to 40000 characters.');
  const output:Args[]=[],lists:string[]=[],attrs:Args={};
  const emit=(value:string,attributes:Args={})=>{if(value)output.push({text:value,attributes:{...attributes}});};
  function inline(tokens:any[]){
    const current:Args={},stack:Args[]=[];
    for(let i=0;i<tokens.length;i++){
      const token=tokens[i];
      if(token.type==='link_open'){
        const href=token.attrGet('href')??'',mention=/^#user_mention#(\d+)$/.exec(href);
        if(mention){output.push({type:'tag',user:{id:Number(mention[1])}});while(i+1<tokens.length&&tokens[i+1].type!=='link_close')i++;if(i+1<tokens.length)i++;continue;}
        stack.push({...current});current.link=href;continue;
      }
      if(['strong_open','em_open','s_open'].includes(token.type)){
        stack.push({...current});current[({strong_open:'bold',em_open:'italic',s_open:'strike'} as Args)[token.type]]=true;continue;
      }
      if(['link_close','strong_close','em_close','s_close'].includes(token.type)){
        for(const key of Object.keys(current))delete current[key];Object.assign(current,stack.pop()??{});continue;
      }
      if(token.type==='code_inline'){emit(token.content,{...current,code:true});continue;}
      if(['softbreak','hardbreak'].includes(token.type)){emit('\n',current);continue;}
      if(token.type==='image'){emit(token.content||'Image',{...current,link:token.attrGet('src')});continue;}
      emit(token.content??'',current);
    }
  }
  const tokens=markdown.parse(text,{});
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(token.type==='bullet_list_open')lists.push('bullet');
    else if(token.type==='ordered_list_open')lists.push('ordered');
    else if(['bullet_list_close','ordered_list_close'].includes(token.type))lists.pop();
    else if(token.type==='heading_open')attrs.header=Number(token.tag.slice(1));
    else if(token.type==='blockquote_open')attrs.blockquote=true;
    else if(token.type==='blockquote_close')delete attrs.blockquote;
    else if(token.type==='inline')inline(token.children??[]);
    else if(['paragraph_close','heading_close'].includes(token.type)){
      emit('\n',{...attrs,...(lists.length?{list:{list:lists[lists.length-1]},indent:lists.length-1}:{})});delete attrs.header;
    }else if(['fence','code_block'].includes(token.type)){
      for(const line of token.content.replace(/\n$/,'').split('\n')){emit(line);emit('\n',{'code-block':{'code-block':token.info?.trim()||'plain'}});}
    }else if(token.type==='table_open'){
      // ClickUp documents no table segment schema. Preserve cells as fixed-width rows.
      const rows:string[]=[];let cells:string[]=[];
      while(++i<tokens.length&&tokens[i].type!=='table_close'){
        if(tokens[i].type==='tr_open')cells=[];
        if(tokens[i].type==='inline')cells.push(tokens[i].content);
        if(tokens[i].type==='tr_close')rows.push(cells.join(' | '));
      }
      for(const row of rows){emit(row);emit('\n',{'code-block':{'code-block':'plain'}});}
    }else if(token.type==='hr')emit('---\n');
  }
  return output;
}
