import { mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export function renderEnvironment(input) {
  const env = { ...input };
  for (const key of ['CLICKUP_API_TOKEN', 'CLICKUP_WORKSPACE_ID', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_ALLOWED_SUBJECT']) {
    if (!env[key]?.trim()) throw new Error(`Set ${key} in Render's environment settings.`);
    env[key] = env[key].trim();
  }
  if (!env.CLICKUP_API_TOKEN.startsWith('pk_')) throw new Error('CLICKUP_API_TOKEN must be a personal ClickUp token.');
  const profile = env.MCP_PROFILE || 'read';
  if (!['read', 'core'].includes(profile)) throw new Error('Render supports only read or approved core sandbox testing.');
  if (profile === 'core' && env.MCP_SANDBOX_WRITE_APPROVED !== '1') {
    throw new Error('Core requires explicit MCP_SANDBOX_WRITE_APPROVED=1 after sandbox approval.');
  }
  const httpsUrl = (value, key) => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${key} must be an HTTPS URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`${key} must be HTTPS without credentials, query or fragment.`);
    }
    return url;
  };
  httpsUrl(env.MCP_OAUTH_ISSUER, 'MCP_OAUTH_ISSUER');
  const publicUrl = env.MCP_PUBLIC_URL?.trim() || (env.RENDER_EXTERNAL_URL ? `${env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/mcp` : '');
  const resource = httpsUrl(publicUrl, 'MCP_PUBLIC_URL');
  if (resource.pathname !== '/mcp') throw new Error('MCP_PUBLIC_URL must end with /mcp.');
  if (env.MCP_OAUTH_AUDIENCE && env.MCP_OAUTH_AUDIENCE !== publicUrl) {
    throw new Error('Use the canonical MCP_PUBLIC_URL as the OAuth audience.');
  }
  const port = env.PORT || '10000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PORT must be 1–65535.');
  for (const key of ['MCP_AUTH_TOKEN', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'CLICKUP_API_BASE', 'MCP_OAUTH_JWKS_URL']) {
    if (env[key]) throw new Error(`Remove ${key} from this OAuth-only deployment.`);
  }
  return {
    ...env,
    MCP_PROFILE: profile,
    MCP_TRANSPORT: 'http', MCP_HTTP_HOST: '0.0.0.0', MCP_HTTP_PORT: port,
    MCP_STRICT_ENV: '1', MCP_NO_ENV_FILE: '1', MCP_ALLOW_TOKEN_IN_PATH: '0',
    MCP_PUBLIC_URL: publicUrl, MCP_OAUTH_AUDIENCE: publicUrl,
    CLICKUP_ATTACH_ROOT: '/tmp/aiworkflo-clickup-attachments',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const env = renderEnvironment(process.env);
    await mkdir(env.CLICKUP_ATTACH_ROOT, { recursive: true, mode: 0o700 });
    if (await realpath(env.CLICKUP_ATTACH_ROOT) !== env.CLICKUP_ATTACH_ROOT) {
      throw new Error('Attachment sandbox must not be a symlink.');
    }
    Object.assign(process.env, env);
    // Import in-process so Render's SIGTERM reaches upstream shutdown handling.
    await import(pathToFileURL(fileURLToPath(new URL('../build/v4/index.js', import.meta.url))).href);
  } catch (error) {
    console.error(`[render-start] ${error.message}`);
    process.exitCode = 1;
  }
}
