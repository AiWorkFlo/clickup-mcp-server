import crypto from 'node:crypto';

export const TTL = { transaction: 600, code: 120, access: 900, refresh: 30 * 86400, session: 3600 };
export const CLIENTS = ['https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/oauth/codex/client.json'];
export function randomToken(): string { return crypto.randomBytes(32).toString('base64url'); }
export function digest(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
export function challenge(value: string): string { return crypto.createHash('sha256').update(value).digest('base64url'); }
export function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
export function encryptCredential(value: string, key: Buffer, userId: string): string {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function decryptCredential(value: string, key: Buffer, userId: string): string {
  const data = Buffer.from(value, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(userId)); decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export function safeRedirect(raw: string, registered: string[], native: boolean): boolean {
  try {
    const requested = new URL(raw);
    if (requested.hash || requested.username || requested.password) return false;
    return registered.some(value => {
      const allowed = new URL(value);
      if (requested.href === allowed.href) return true;
      return native && ['127.0.0.1', 'localhost'].includes(allowed.hostname) &&
        allowed.protocol === 'http:' && requested.protocol === allowed.protocol &&
        requested.hostname === allowed.hostname && requested.pathname === allowed.pathname && requested.search === allowed.search;
    });
  } catch { return false; }
}
export function requireConfirmation(args: Record<string, unknown>): void {
  if ((args.delete === true || ['delete', 'remove', 'remove_item'].includes(String(args.action))) && args.confirm !== true) {
    throw new Error('This deletion requires explicit user approval and confirm: true.');
  }
}
export function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function teamConfig(env: NodeJS.ProcessEnv = process.env) {
  for (const key of ['DATABASE_URL', 'CLICKUP_CLIENT_ID', 'CLICKUP_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'TEAM_OWNER_CLICKUP_USER_ID', 'MCP_PUBLIC_URL']) {
    if (!env[key]?.trim()) throw new Error(`${key} is required for team mode.`);
  }
  const resource = env.MCP_PUBLIC_URL!.trim(), url = new URL(resource);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) {
    throw new Error('MCP_PUBLIC_URL must be a canonical HTTPS /mcp URL.');
  }
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY!, 'base64');
  if (key.length !== 32 || !/^\d+$/.test(env.TEAM_OWNER_CLICKUP_USER_ID!)) throw new Error('Invalid team encryption key or owner ID.');
  const port = Number(env.PORT || '10000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return { databaseUrl: env.DATABASE_URL!, clientId: env.CLICKUP_CLIENT_ID!.trim(), clientSecret: env.CLICKUP_CLIENT_SECRET!.trim(),
    key, ownerId: env.TEAM_OWNER_CLICKUP_USER_ID!, resource, origin: url.origin, issuer: url.origin + '/', port };
}
export type TeamConfig = ReturnType<typeof teamConfig>;
