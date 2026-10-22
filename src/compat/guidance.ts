import {readFile} from 'node:fs/promises';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerGuidance(server:McpServer):void {
  server.registerResource('clickup-team-skill','clickup-team://skill',{
    title:'ClickUp Team operating skill',description:'Workflows, input rules, and public API parity limits.',mimeType:'text/markdown'
  },async uri=>({contents:[{uri:uri.href,mimeType:'text/markdown',text:await readFile(new URL('../../skills/clickup-team/SKILL.md',import.meta.url),'utf8')}]}));
}
