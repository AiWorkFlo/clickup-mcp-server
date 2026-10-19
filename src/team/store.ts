import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { digest, randomToken, encryptCredential, decryptCredential, TTL } from './security.js';

export interface TeamUser {
  id: string; name: string; email: string; status: 'pending' | 'approved' | 'disabled';
  credential: string | null; credential_version: string; epoch: number;
}
export interface AuthorizationTransaction {
  purpose: 'mcp' | 'account'; clientId?: string; redirectUri?: string; state?: string;
  codeChallenge?: string; scopes?: string[]; resource?: string;
}
export interface GrantIdentity { user: TeamUser; workspaceId: string; clientId: string; family: string }

export class TeamStore {
  constructor(readonly pool: Pool, readonly key: Buffer, readonly ownerId: string) {}
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async migrate(): Promise<void> {
    await this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(428736201)');
      await db.query(`
        CREATE TABLE IF NOT EXISTS team_users (
          id text PRIMARY KEY, name text NOT NULL, email text NOT NULL,
          status text NOT NULL CHECK(status IN ('pending','approved','disabled')),
          credential text, credential_version text NOT NULL, epoch integer NOT NULL DEFAULT 1,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS team_transactions (
          id text PRIMARY KEY, browser_hash text NOT NULL, payload jsonb NOT NULL,
          user_id text REFERENCES team_users(id), expires_at timestamptz NOT NULL,
          consumed boolean NOT NULL DEFAULT false, authenticated boolean NOT NULL DEFAULT false);
        CREATE TABLE IF NOT EXISTS team_sessions (
          id text PRIMARY KEY, user_id text NOT NULL REFERENCES team_users(id), epoch integer NOT NULL,
          expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS team_codes (
          id text PRIMARY KEY, user_id text NOT NULL REFERENCES team_users(id), client_id text NOT NULL,
          redirect_uri text NOT NULL, challenge text NOT NULL, resource text NOT NULL,
          workspace_id text NOT NULL, scopes text[] NOT NULL, epoch integer NOT NULL,
          expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false);
        CREATE TABLE IF NOT EXISTS team_grants (
          id text PRIMARY KEY, refresh_hash text UNIQUE NOT NULL, family text NOT NULL,
          user_id text NOT NULL REFERENCES team_users(id), client_id text NOT NULL,
          workspace_id text NOT NULL, resource text NOT NULL, scopes text[] NOT NULL,
          epoch integer NOT NULL, expires_at timestamptz NOT NULL, family_expires_at timestamptz NOT NULL,
          refreshed boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false);
        CREATE INDEX IF NOT EXISTS team_grants_user ON team_grants(user_id);
        CREATE INDEX IF NOT EXISTS team_grants_family ON team_grants(family);
        CREATE TABLE IF NOT EXISTS team_consents (
          id bigserial PRIMARY KEY, user_id text NOT NULL REFERENCES team_users(id), client_id text NOT NULL,
          workspace_id text NOT NULL, scopes text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS team_audit (
          id bigserial PRIMARY KEY, actor_id text, action text NOT NULL, target_id text,
          created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS team_settings (id text PRIMARY KEY, value text NOT NULL);
        ALTER TABLE team_transactions ADD COLUMN IF NOT EXISTS user_epoch integer;
      `);
      const probe=(await db.query("SELECT value FROM team_settings WHERE id='encryption_probe'")).rows[0];
      if(probe) {
        if(decryptCredential(probe.value,this.key,'encryption_probe')!=='clickup-team') throw new Error('Invalid encryption configuration.');
      } else {
        await db.query("INSERT INTO team_settings(id,value) VALUES('encryption_probe',$1)",[encryptCredential('clickup-team',this.key,'encryption_probe')]);
      }
    });
  }
  async user(id: string): Promise<TeamUser | null> {
    return (await this.pool.query('SELECT * FROM team_users WHERE id=$1', [id])).rows[0] ?? null;
  }
  async saveLogin(identity: { id: string; name: string; email: string }, token: string): Promise<TeamUser> {
    return this.transaction(async db => {
      const existing = (await db.query('SELECT * FROM team_users WHERE id=$1 FOR UPDATE', [identity.id])).rows[0];
      if (existing?.status === 'disabled') throw new Error('This account is disabled.');
      const result = await db.query(`INSERT INTO team_users(id,name,email,status,credential,credential_version)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name,email=EXCLUDED.email,credential=EXCLUDED.credential,
        credential_version=EXCLUDED.credential_version,updated_at=now() RETURNING *`,
      [identity.id, identity.name, identity.email, identity.id === this.ownerId ? 'approved' : 'pending',
        encryptCredential(token, this.key, identity.id), randomUUID()]);
      await this.audit(identity.id, 'login', identity.id, db);
      return result.rows[0];
    });
  }
  token(user: TeamUser): string {
    if (!user.credential) throw new Error('Reconnect your ClickUp account.');
    return decryptCredential(user.credential, this.key, user.id);
  }
  async startTransaction(payload: AuthorizationTransaction, browser: string): Promise<string> {
    const state = randomToken();
    await this.pool.query(`INSERT INTO team_transactions(id,browser_hash,payload,expires_at)
      VALUES($1,$2,$3,now()+interval '10 minutes')`, [digest(state), digest(browser), payload]);
    return state;
  }
  async takeCallback(state: string, browser: string): Promise<AuthorizationTransaction | null> {
    const row = (await this.pool.query(`UPDATE team_transactions SET consumed=true
      WHERE id=$1 AND browser_hash=$2 AND NOT consumed AND expires_at>now() RETURNING payload`, [digest(state), digest(browser)])).rows[0];
    return row?.payload ?? null;
  }
  async saveConsentTransaction(payload: AuthorizationTransaction, browser: string, userId: string): Promise<string> {
    const id = randomToken();
    await this.pool.query(`INSERT INTO team_transactions(id,browser_hash,payload,user_id,user_epoch,authenticated,expires_at)
      VALUES($1,$2,$3,$4,(SELECT epoch FROM team_users WHERE id=$4),true,now()+interval '10 minutes')`, [digest(id), digest(browser), payload, userId]);
    return id;
  }
  async consentTransaction(id: string, browser: string, userId: string) {
    return (await this.pool.query(`SELECT payload FROM team_transactions WHERE id=$1 AND browser_hash=$2
      AND user_id=$3 AND user_epoch=(SELECT epoch FROM team_users WHERE id=$3)
      AND authenticated AND NOT consumed AND expires_at>now()`, [digest(id), digest(browser), userId])).rows[0]?.payload as AuthorizationTransaction | undefined;
  }
  async session(user: TeamUser): Promise<string> {
    const value = randomToken();
    await this.pool.query(`INSERT INTO team_sessions(id,user_id,epoch,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, [digest(value), user.id, user.epoch]);
    return value;
  }
  async sessionUser(value: string): Promise<TeamUser | null> {
    return (await this.pool.query(`SELECT u.* FROM team_sessions s JOIN team_users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.expires_at>now() AND s.epoch=u.epoch AND u.status<>'disabled'`, [digest(value)])).rows[0] ?? null;
  }
  async issueCode(transaction: string, browser: string, user: TeamUser, workspaceId: string): Promise<{ code: string; payload: AuthorizationTransaction }> {
    return this.transaction(async db => {
      const current = (await db.query('SELECT * FROM team_users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (current?.status !== 'approved' || !current.credential || current.epoch !== user.epoch) throw new Error('Account is not approved or connected.');
      const row = (await db.query(`UPDATE team_transactions SET consumed=true WHERE id=$1 AND browser_hash=$2
        AND user_id=$3 AND user_epoch=$4 AND authenticated AND NOT consumed AND expires_at>now() RETURNING payload`, [digest(transaction), digest(browser), user.id,current.epoch])).rows[0];
      if (!row || row.payload.purpose !== 'mcp') throw new Error('Authorization expired. Reconnect from your client.');
      const payload: AuthorizationTransaction = row.payload, code = randomToken();
      await db.query(`INSERT INTO team_codes(id,user_id,client_id,redirect_uri,challenge,resource,workspace_id,scopes,epoch,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '2 minutes')`,
      [digest(code),user.id,payload.clientId,payload.redirectUri,payload.codeChallenge,payload.resource,workspaceId,payload.scopes,current.epoch]);
      await db.query('INSERT INTO team_consents(user_id,client_id,workspace_id,scopes) VALUES($1,$2,$3,$4)', [user.id,payload.clientId,workspaceId,payload.scopes]);
      await this.audit(user.id,'consent',payload.clientId,db);
      return {code,payload};
    });
  }
  async codeChallenge(code: string, clientId: string): Promise<string | null> {
    return (await this.pool.query(`SELECT challenge FROM team_codes WHERE id=$1 AND client_id=$2 AND NOT consumed AND expires_at>now()`, [digest(code),clientId])).rows[0]?.challenge ?? null;
  }
  private async createGrant(db: PoolClient, row: any, family?: string, familyExpires?: Date) {
    const access = randomToken(), refresh = randomToken();
    await db.query(`INSERT INTO team_grants(id,refresh_hash,family,user_id,client_id,workspace_id,resource,scopes,epoch,expires_at,family_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '15 minutes',COALESCE($10,now()+interval '30 days'))`,
    [digest(access),digest(refresh),family??randomUUID(),row.user_id,row.client_id,row.workspace_id,row.resource,row.scopes,row.epoch,familyExpires??null]);
    return {access_token:access,refresh_token:row.scopes.includes('offline_access')?refresh:undefined,token_type:'Bearer',expires_in:TTL.access,scope:row.scopes.join(' ')};
  }
  async exchange(code: string, clientId: string, redirectUri: string, resource: string) {
    return this.transaction(async db => {
      const row = (await db.query(`SELECT c.* FROM team_codes c JOIN team_users u ON u.id=c.user_id
        WHERE c.id=$1 AND c.client_id=$2 AND c.redirect_uri=$3 AND c.resource=$4 AND NOT c.consumed
        AND c.expires_at>now() AND u.status='approved' AND u.credential IS NOT NULL AND c.epoch=u.epoch FOR UPDATE OF c,u`, [digest(code),clientId,redirectUri,resource])).rows[0];
      if (!row) return null;
      await db.query('UPDATE team_codes SET consumed=true WHERE id=$1',[digest(code)]);
      return this.createGrant(db,row);
    });
  }
  async refresh(refresh: string, clientId: string, resource: string, scopes?: string[]) {
    return this.transaction(async db => {
      const row=(await db.query(`SELECT g.*,u.status,u.credential,u.epoch AS current_epoch FROM team_grants g JOIN team_users u ON u.id=g.user_id
        WHERE g.refresh_hash=$1 AND g.client_id=$2 FOR UPDATE OF g,u`,[digest(refresh),clientId])).rows[0];
      if (!row) return null;
      // Commit family revocation before reporting a replay. Throwing here would roll it back.
      if (row.refreshed) {
        await db.query('UPDATE team_grants SET revoked=true WHERE family=$1',[row.family]);
        await this.audit(row.user_id,'refresh_replay',row.family,db); return null;
      }
      if (row.revoked || row.status!=='approved' || !row.credential || row.epoch!==row.current_epoch ||
        new Date(row.family_expires_at).getTime()<=Date.now() || row.resource!==resource ||
        !row.scopes.includes('offline_access') || (scopes && (!scopes.includes('clickup:core') || scopes.some(scope=>!row.scopes.includes(scope))))) return null;
      await db.query('UPDATE team_grants SET refreshed=true WHERE id=$1',[row.id]);
      return this.createGrant(db,{...row,scopes:scopes??row.scopes},row.family,row.family_expires_at);
    });
  }
  async access(token: string, resource: string): Promise<GrantIdentity | null> {
    const row=(await this.pool.query(`SELECT g.workspace_id,g.client_id,g.family,u.* FROM team_grants g JOIN team_users u ON u.id=g.user_id
      WHERE g.id=$1 AND g.resource=$2 AND NOT g.revoked AND g.expires_at>now() AND g.family_expires_at>now()
      AND u.status='approved' AND u.credential IS NOT NULL AND g.epoch=u.epoch`,[digest(token),resource])).rows[0];
    return row?{user:row,workspaceId:row.workspace_id,clientId:row.client_id,family:row.family}:null;
  }
  async revoke(token: string, clientId: string): Promise<void> {
    await this.pool.query(`UPDATE team_grants SET revoked=true WHERE family IN
      (SELECT family FROM team_grants WHERE client_id=$2 AND (id=$1 OR refresh_hash=$1))`,[digest(token),clientId]);
  }
  async disconnect(userId: string): Promise<void> {
    await this.transaction(async db=>{
      await db.query('UPDATE team_users SET credential=NULL,epoch=epoch+1,updated_at=now() WHERE id=$1',[userId]);
      await db.query('UPDATE team_grants SET revoked=true WHERE user_id=$1',[userId]);
      await db.query('DELETE FROM team_sessions WHERE user_id=$1',[userId]);
      await this.audit(userId,'disconnect',userId,db);
    });
  }
  async setStatus(actorId: string,targetId: string,status: 'approved'|'disabled'): Promise<void> {
    if(actorId!==this.ownerId || targetId===this.ownerId) throw new Error('Owner authorization is required.');
    await this.transaction(async db=>{
      const actor=(await db.query("SELECT * FROM team_users WHERE id=$1 AND status='approved' FOR UPDATE",[actorId])).rows[0];
      if(!actor) throw new Error('Owner authorization is required.');
      await db.query('UPDATE team_users SET status=$2,epoch=epoch+1,updated_at=now() WHERE id=$1',[targetId,status]);
      await db.query('UPDATE team_grants SET revoked=true WHERE user_id=$1',[targetId]);
      await db.query('DELETE FROM team_sessions WHERE user_id=$1',[targetId]);
      if(status==='disabled') await db.query('UPDATE team_users SET credential=NULL WHERE id=$1',[targetId]);
      await this.audit(actorId,status,targetId,db);
    });
  }
  async users(): Promise<Array<Pick<TeamUser,'id'|'name'|'email'|'status'>>> {
    return (await this.pool.query('SELECT id,name,email,status FROM team_users ORDER BY created_at')).rows;
  }
  async audit(actor: string|null, action: string, target?: string|null, db: Pool|PoolClient=this.pool): Promise<void> {
    await db.query('INSERT INTO team_audit(actor_id,action,target_id) VALUES($1,$2,$3)',[actor,action,target??null]);
  }
  async cleanup(): Promise<void> {
    await this.pool.query(`DELETE FROM team_transactions WHERE expires_at<now(); DELETE FROM team_codes WHERE expires_at<now();
      DELETE FROM team_sessions WHERE expires_at<now(); DELETE FROM team_grants WHERE family_expires_at<now();
      DELETE FROM team_audit WHERE created_at<now()-interval '90 days'`);
  }
}
