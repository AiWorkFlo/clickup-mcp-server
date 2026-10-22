import {mkdir,writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {TeamTools} from '../build/team/tools.js';
import {compatibilityGaps,compatibilityNotes} from '../build/compat/tools.js';

// Only inspect registration metadata. No account, database, or upstream call is made.
const server=new TeamTools({},{}).server({user:{},workspaceId:''});
const client=new Client({name:'capability-export',version:'1.0'});
const [a,b]=InMemoryTransport.createLinkedPair();
await server.connect(b);await client.connect(a);
const {tools}=await client.listTools();
const catalog={server:client.getServerVersion(),instructions:client.getInstructions(),tools,
  unavailable:compatibilityGaps,limitations:compatibilityNotes};
await mkdir(new URL('../skills/clickup-team/references/',import.meta.url),{recursive:true});
await mkdir(new URL('../docs/',import.meta.url),{recursive:true});
await writeFile(new URL('../skills/clickup-team/references/tools.json',import.meta.url),JSON.stringify(catalog,null,2)+'\n');
let markdown='# ClickUp Team capability reference\n\nGenerated from the team server registration. These are input contracts, not proof of live account permissions.\n\n';
markdown+='| Tool | Availability | Schema-required inputs |\n|---|---|---|\n';
for(const tool of tools){
  const state=compatibilityGaps[tool.name]?'Unavailable':compatibilityNotes[tool.name]?'Limited, see skill':'Implemented';
  markdown+=`| \`${tool.name}\` | ${state} | ${(tool.inputSchema.required??[]).map(k=>'`'+k+'`').join(', ')||'None at schema level'} |\n`;
}
markdown+='\nConditional input requirements are in each schema description. Confirm irreversible operations explicitly.\n';
for(const tool of tools){
  markdown+=`\n## ${tool.name}\n\n${tool.description}\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema,null,2)}\n\`\`\`\n`;
}
await writeFile(new URL('../docs/capabilities.md',import.meta.url),markdown);
await client.close();await server.close();
console.log(`Exported ${tools.length} team tool contracts, including ${Object.keys(compatibilityGaps).length} unavailable compatibility contracts.`);
