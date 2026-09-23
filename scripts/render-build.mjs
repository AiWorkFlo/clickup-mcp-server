import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Render makes runtime secrets available during builds. Never let offline tests
// inherit live ClickUp credentials, issuer settings, or capability profiles.
export function buildEnvironment(input) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !/^(CLICKUP_|MCP_|CF_ACCESS_)/.test(key)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const env = buildEnvironment(process.env);
  for (const args of [['ci', '--include=dev'], ['test'], ['prune', '--omit=dev', '--ignore-scripts']]) {
    const result = spawnSync('npm', args, { env, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      console.error('[render-build] Build/install/test step failed. Deployment stopped.');
      process.exit(result.status || 1);
    }
  }
}
